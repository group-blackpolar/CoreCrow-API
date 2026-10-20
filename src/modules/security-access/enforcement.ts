import { transaction, type Transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { currentNetwork, type Network } from "../../shared/request-context.js";
import { auditRepository as audit } from "../audit/repository.js";
import { raiseAlert, type AlertKind } from "./alerts.js";
import { deviceHash, newDeviceToken } from "./device.js";
import { evaluateIp } from "./network.js";

type Overflow = "BLOCK_NEW" | "REPLACE_OLDEST" | "REQUIRE_USER_CHOICE";
export type Governing = { organizationId: string; enforcement: boolean; maxDevices: number | null; maxSessions: number | null; overflow: Overflow };
const STRICTNESS: Record<Overflow, number> = { BLOCK_NEW: 0, REQUIRE_USER_CHOICE: 1, REPLACE_OLDEST: 2 };

type PolicyRow = { organizationId: string; enforcement: boolean; maxDevices: number | null; maxSessions: number | null; overflowPolicy: Overflow };
const min = (values: Array<number | null>) => values.reduce<number | null>((best, value) => (value === null ? best : best === null ? value : Math.min(best, value)), null);

/**
 * Which policy governs a user's sessions. The organization that created the account wins; otherwise the user is tracked under the
 * first organization (by id) that has a policy, and limits are the strictest among the organizations whose policy enforces.
 * Pure so it can be unit-tested.
 */
export function governingPolicy(policies: readonly PolicyRow[], createdByOrganizationId: string | null): Governing | null {
  if (!policies.length) return null;
  const sorted = [...policies].sort((a, b) => a.organizationId.localeCompare(b.organizationId));
  const own = createdByOrganizationId ? sorted.find((policy) => policy.organizationId === createdByOrganizationId) : undefined;
  const home = own ?? sorted[0]!;
  const enforcing = (own ? [own] : sorted).filter((policy) => policy.enforcement);
  const overflow = enforcing.reduce<Overflow>((current, policy) => (STRICTNESS[policy.overflowPolicy] < STRICTNESS[current] ? policy.overflowPolicy : current), "REPLACE_OLDEST");
  return {
    organizationId: home.organizationId,
    enforcement: enforcing.length > 0,
    maxDevices: min(enforcing.map((policy) => policy.maxDevices)),
    maxSessions: min(enforcing.map((policy) => policy.maxSessions)),
    overflow: enforcing.length ? overflow : "BLOCK_NEW",
  };
}

async function governingFor(tx: Transaction, userId: string, createdByOrganizationId: string | null) {
  const memberships = await tx.membership.findMany({ where: { userId }, select: { organizationId: true } });
  const policies = await tx.organizationSecurityPolicy.findMany({
    where: { organizationId: { in: memberships.map((membership) => membership.organizationId) } },
    select: { organizationId: true, enforcement: true, maxDevices: true, maxSessions: true, overflowPolicy: true },
  });
  return governingPolicy(policies, createdByOrganizationId);
}

type Denial = { status: number; code: string; message: string };
type Details = Record<string, string | number | null>;
type Outcome = { denial: Denial | null; policy: Governing; events: Array<{ kind: AlertKind; details: Details }> };

/**
 * Runs right after a session row is created (Better Auth hook or desktop exchange). Serialized per user with an advisory lock, so N
 * concurrent sign-ins can never leave more than the limit: the loser's session is deleted before its cookie is delivered.
 * Devices are never removed automatically; REPLACE_OLDEST only ends older sessions.
 */
export async function admitSession(session: { id: string; userId: string }, options: { registerDevice: boolean; network?: Network }) {
  const network = options.network ?? currentNetwork();
  const result = await transaction<Outcome | null>(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"security-access:" + session.userId}))`;
    const user = await tx.user.findUnique({ where: { id: session.userId }, select: { createdByOrganizationId: true } });
    const policy = await governingFor(tx, session.userId, user?.createdByOrganizationId ?? null);
    if (!policy) return null;
    const events: Outcome["events"] = [];
    const deny = async (denial: Denial, kind: AlertKind | null, details: Details = {}): Promise<Outcome> => {
      await tx.session.deleteMany({ where: { id: session.id } });
      await audit.append(tx, { actorId: session.userId, organizationId: policy.organizationId, action: `security.access.denied.${denial.code.toLowerCase()}`, targetType: "session", targetId: session.id, metadata: { ip: network?.ip ?? null, ...details } });
      if (kind) events.push({ kind, details });
      return { denial, policy, events };
    };

    // 1. Network rules of the organization that owns the account apply at sign-in (other users meet them when they open that organization).
    if (user?.createdByOrganizationId) {
      const rules = await tx.securityIpRule.findMany({ where: { organizationId: user.createdByOrganizationId }, select: { kind: true, cidr: true } });
      if (!evaluateIp(network?.ip, rules).allowed)
        return deny({ status: 403, code: "IP_NOT_ALLOWED", message: "Sign-in is not allowed from this network" }, "IP_DENIED", { ip: network?.ip ?? null });
    }

    // 2. Device (read-only decision first; the row is written only if the sign-in is admitted).
    let deviceId: string | null = null;
    let knownDeviceId: string | null = null;
    if (options.registerDevice && network) {
      const found = network.deviceToken ? await tx.securityDevice.findUnique({ where: { tokenHash: deviceHash(network.deviceToken) } }) : null;
      if (found && found.userId === session.userId) {
        if (found.revokedAt) return deny({ status: 403, code: "DEVICE_REVOKED", message: "This device was revoked" }, "DEVICE_REVOKED_LOGIN", { deviceId: found.id });
        knownDeviceId = found.id;
        deviceId = found.id;
      } else if (policy.enforcement && policy.maxDevices !== null) {
        const active = await tx.securityDevice.count({ where: { userId: session.userId, revokedAt: null } });
        if (active >= policy.maxDevices)
          return deny({ status: policy.overflow === "REQUIRE_USER_CHOICE" ? 409 : 403, code: "DEVICE_LIMIT_REACHED", message: "The device limit for this account was reached" }, "DEVICE_LIMIT_BLOCKED", { limit: policy.maxDevices });
      }
    }

    // 3. Simultaneous sessions (the new one is already counted).
    if (policy.enforcement && policy.maxSessions !== null) {
      const live = await tx.session.findMany({ where: { userId: session.userId, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
      if (live.length > policy.maxSessions) {
        if (policy.overflow === "REPLACE_OLDEST") {
          const doomed = live.filter((row) => row.id !== session.id).slice(0, live.length - policy.maxSessions).map((row) => row.id);
          await tx.session.deleteMany({ where: { id: { in: doomed } } });
          await audit.append(tx, { actorId: session.userId, organizationId: policy.organizationId, action: "security.session.replaced", targetType: "session", metadata: { replaced: doomed.length } });
          events.push({ kind: "SESSION_REPLACED", details: { replaced: doomed.length } });
        } else {
          const choice = policy.overflow === "REQUIRE_USER_CHOICE";
          return deny({ status: choice ? 409 : 403, code: choice ? "SESSION_CHOICE_REQUIRED" : "SESSION_LIMIT_REACHED", message: "The simultaneous session limit was reached" }, "SESSION_LIMIT_BLOCKED", { limit: policy.maxSessions });
        }
      }
    }

    // 4. Admitted: register/refresh the device and tag the session.
    if (options.registerDevice && network) {
      if (knownDeviceId) await tx.securityDevice.update({ where: { id: knownDeviceId }, data: { lastSeenAt: new Date(), lastIp: network.ip } });
      else {
        const token = newDeviceToken();
        const device = await tx.securityDevice.create({ data: { userId: session.userId, organizationId: policy.organizationId, tokenHash: deviceHash(token), userAgent: network.userAgent, firstIp: network.ip, lastIp: network.ip } });
        deviceId = device.id;
        network.outcome.issueDeviceToken = token;
        await audit.append(tx, { actorId: session.userId, organizationId: policy.organizationId, action: "security.device.register", targetType: "device", targetId: device.id, metadata: { ip: network.ip } });
      }
    }
    await tx.session.update({ where: { id: session.id }, data: { deviceId, securityOrganizationId: policy.organizationId } });
    return { denial: null, policy, events };
  }, { isolationLevel: "ReadCommitted" });

  if (!result) return;
  for (const event of result.events) await raiseAlert({ organizationId: result.policy.organizationId, userId: session.userId, kind: event.kind, details: event.details });
  if (result.denial && network) network.outcome.denied = result.denial;
}

/**
 * Organization-level network gate, called wherever membership is resolved. Absent network context (internal scripts) is not
 * restricted; HTTP requests always carry one. Alerting is fire-and-forget so a denied request is not delayed or rolled back.
 */
export async function assertNetworkAllowed(tx: Transaction, organizationId: string, userId: string) {
  const network = currentNetwork();
  if (!network) return;
  const rules = await tx.securityIpRule.findMany({ where: { organizationId }, select: { kind: true, cidr: true } });
  if (evaluateIp(network.ip, rules).allowed) return;
  void raiseAlert({ organizationId, userId, kind: "IP_DENIED", details: { ip: network.ip } });
  fail(403, "IP_NOT_ALLOWED", "Access to this organization is not allowed from this network");
}
