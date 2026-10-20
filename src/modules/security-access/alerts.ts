import { Prisma } from "../../lib/database.js";
import { prisma } from "../../lib/database.js";
import { mailConfigured, sendSecurityAlertMail } from "../security/mail.js";

export type AlertKind =
  | "IP_DENIED"
  | "DEVICE_LIMIT_BLOCKED"
  | "SESSION_LIMIT_BLOCKED"
  | "SESSION_REPLACED"
  | "DEVICE_REVOKED_LOGIN"
  | "POLICY_CHANGED";
const SEVERITY: Record<AlertKind, "info" | "warning" | "critical"> = {
  IP_DENIED: "warning",
  DEVICE_LIMIT_BLOCKED: "warning",
  SESSION_LIMIT_BLOCKED: "warning",
  SESSION_REPLACED: "info",
  DEVICE_REVOKED_LOGIN: "critical",
  POLICY_CHANGED: "info",
};
const HOUR = 3_600_000;

type Raise = { organizationId: string; kind: AlertKind; userId?: string | null; details?: Record<string, string | number | boolean | null> };

/**
 * Records an alert for the organization panel and, when configured, e-mails it. The same kind/user within one hour collapses into
 * one alert (count grows) and is mailed once. Never throws: alerting must not break the request that triggered it.
 */
export async function raiseAlert(input: Raise) {
  try {
    const policy = await prisma.organizationSecurityPolicy.findUnique({ where: { organizationId: input.organizationId } });
    if (!policy || !policy.alertsEnabled) return null;
    const dedupKey = `${input.kind}:${input.userId ?? "-"}:${Math.floor(Date.now() / HOUR)}`;
    let created = false;
    let alert;
    try {
      alert = await prisma.securityAlert.create({
        data: { organizationId: input.organizationId, kind: input.kind, severity: SEVERITY[input.kind], userId: input.userId ?? null, dedupKey, details: (input.details ?? {}) as Prisma.InputJsonObject },
      });
      created = true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      alert = await prisma.securityAlert.update({
        where: { organizationId_dedupKey: { organizationId: input.organizationId, dedupKey } },
        data: { count: { increment: 1 }, lastSeenAt: new Date() },
      });
    }
    if (created && policy.alertEmailEnabled) await deliver(alert.id, input, policy.alertEmailRecipients);
    return alert;
  } catch {
    return null;
  }
}

async function recipients(organizationId: string, explicit: string[]) {
  if (explicit.length) return explicit;
  // Owners that have a real mailbox: organization-created (name@<slug>.bp) accounts cannot receive mail.
  const owners = await prisma.membership.findMany({
    where: { organizationId, role: "OWNER", user: { status: "ACTIVE", emailVerified: true, createdByOrganizationId: null } },
    select: { user: { select: { email: true } } },
  });
  return owners.map((owner) => owner.user.email);
}

async function deliver(alertId: string, input: Raise, explicit: string[]) {
  let status: "SENT" | "FAILED" = "SENT";
  let error: string | null = null;
  try {
    if (!mailConfigured()) throw new Error("Email delivery is not configured");
    const to = await recipients(input.organizationId, explicit);
    if (!to.length) throw new Error("No recipients with a real mailbox");
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } });
    const lines = [`Organization: ${org?.name ?? input.organizationId}`, `Alert: ${input.kind}`, ...Object.entries(input.details ?? {}).map(([key, value]) => `${key}: ${String(value)}`), "", "Review it in Administration > Security & access > Alerts."];
    for (const address of to) await sendSecurityAlertMail(address, `[Black Polar] Security alert: ${input.kind}`, lines);
  } catch (failure) {
    status = "FAILED";
    error = (failure instanceof Error ? failure.message : "Delivery failed").slice(0, 200);
  }
  await prisma.securityAlert.update({ where: { id: alertId }, data: { emailStatus: status, emailError: error } }).catch(() => undefined);
}
