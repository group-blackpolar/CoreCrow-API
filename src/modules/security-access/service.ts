import { transaction, type Transaction } from "../../shared/transaction.js";
import { fail } from "../../shared/errors.js";
import { currentNetwork } from "../../shared/request-context.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize } from "../authorization/service.js";
import type { Permission } from "../authorization/policy.js";
import { evaluateIp, parseCidr } from "./network.js";

const MAX_IP_RULES = 200;
const PAGE = 100;
const iso = (value: Date | null) => value?.toISOString() ?? null;
const need = (tx: Transaction, userId: string, organizationId: string, permission: Permission) => authorize(tx, userId, organizationId, permission);

export type PolicyInput = {
  enforcement: boolean;
  maxDevices: number | null;
  maxSessions: number | null;
  overflowPolicy: "BLOCK_NEW" | "REPLACE_OLDEST" | "REQUIRE_USER_CHOICE";
  alertsEnabled: boolean;
  retentionDays: number;
  retentionExemption: { until: string; reason: string } | null;
};

const policyView = (row: Awaited<ReturnType<Transaction["organizationSecurityPolicy"]["findUnique"]>>) => ({
  configured: Boolean(row),
  enforcement: row?.enforcement ?? false,
  maxDevices: row?.maxDevices ?? null,
  maxSessions: row?.maxSessions ?? null,
  overflowPolicy: row?.overflowPolicy ?? ("BLOCK_NEW" as const),
  alertsEnabled: row?.alertsEnabled ?? true,
  retentionDays: row?.retentionDays ?? 90,
  retentionExemption: row?.retentionExemptUntil && row.retentionExemptReason ? { until: row.retentionExemptUntil.toISOString(), reason: row.retentionExemptReason, by: row.retentionExemptBy } : null,
  updatedAt: iso(row?.updatedAt ?? null),
});

export const securityAccess = {
  overview(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.overview.view");
      const now = new Date();
      const [policy, devices, sessions, openAlerts, rules, lastRun] = await Promise.all([
        tx.organizationSecurityPolicy.findUnique({ where: { organizationId } }),
        tx.securityDevice.count({ where: { organizationId, revokedAt: null } }),
        tx.session.count({ where: { securityOrganizationId: organizationId, expiresAt: { gt: now } } }),
        tx.securityAlert.count({ where: { organizationId, status: "OPEN" } }),
        tx.securityIpRule.groupBy({ by: ["kind"], where: { organizationId }, _count: true }),
        tx.securityRetentionRun.findFirst({ where: { organizationId }, orderBy: { ranAt: "desc" } }),
      ]);
      return {
        policy: policyView(policy),
        activeDevices: devices,
        activeSessions: sessions,
        openAlerts,
        allowRules: rules.find((rule) => rule.kind === "ALLOW")?._count ?? 0,
        denyRules: rules.find((rule) => rule.kind === "DENY")?._count ?? 0,
        lastRetentionRun: lastRun ? { ranAt: lastRun.ranAt.toISOString(), purgedAlerts: lastRun.purgedAlerts, purgedDevices: lastRun.purgedDevices, skipped: lastRun.skipped } : null,
      };
    });
  },

  devices(userId: string, organizationId: string, query: { includeRevoked: boolean }) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.devices.view");
      const rows = await tx.securityDevice.findMany({
        where: { organizationId, ...(query.includeRevoked ? {} : { revokedAt: null }) },
        orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
        take: PAGE,
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      const counts = await tx.session.groupBy({ by: ["deviceId"], where: { deviceId: { in: rows.map((row) => row.id) }, expiresAt: { gt: new Date() } }, _count: true });
      return rows.map((row) => ({
        id: row.id, userId: row.user.id, userName: row.user.name, userEmail: row.user.email, userAgent: row.userAgent,
        firstIp: row.firstIp, lastIp: row.lastIp, firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
        revokedAt: iso(row.revokedAt), activeSessions: counts.find((count) => count.deviceId === row.id)?._count ?? 0,
      }));
    });
  },

  revokeDevice(userId: string, organizationId: string, deviceId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.devices.revoke");
      const device = await tx.securityDevice.findFirst({ where: { id: deviceId, organizationId } });
      if (!device) fail(404, "NOT_FOUND", "Device not found");
      const ended = await tx.session.deleteMany({ where: { deviceId } });
      if (!device.revokedAt) await tx.securityDevice.update({ where: { id: deviceId }, data: { revokedAt: new Date(), revokedBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.device.revoke", targetType: "device", targetId: deviceId, metadata: { sessionsEnded: ended.count, subjectUserId: device.userId } });
      return { id: deviceId, sessionsEnded: ended.count };
    });
  },

  sessions(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.sessions.view");
      const rows = await tx.session.findMany({
        where: { securityOrganizationId: organizationId, expiresAt: { gt: new Date() } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE,
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      return rows.map((row) => ({
        id: row.id, userId: row.user.id, userName: row.user.name, userEmail: row.user.email, ipAddress: row.ipAddress, userAgent: row.userAgent,
        deviceId: row.deviceId, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      }));
    });
  },

  revokeSession(userId: string, organizationId: string, sessionId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.sessions.revoke");
      const found = await tx.session.findFirst({ where: { id: sessionId, securityOrganizationId: organizationId }, select: { userId: true } });
      if (!found) fail(404, "NOT_FOUND", "Session not found");
      await tx.session.delete({ where: { id: sessionId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.session.revoke", targetType: "session", targetId: sessionId, metadata: { subjectUserId: found.userId } });
      return { id: sessionId };
    });
  },

  revokeUserSessions(userId: string, organizationId: string, targetUserId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.sessions.revoke");
      const ended = await tx.session.deleteMany({ where: { userId: targetUserId, securityOrganizationId: organizationId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.session.revoke_user", targetType: "user", targetId: targetUserId, metadata: { sessionsEnded: ended.count } });
      return { sessionsEnded: ended.count };
    });
  },

  users(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.sessions.view");
      const members = await tx.membership.findMany({
        where: { organizationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 500,
        select: { userId: true, role: true, user: { select: { name: true, email: true, status: true, emailVerified: true, passwordChangeRequired: true, createdByOrganizationId: true } } },
      });
      const ids = members.map((member) => member.userId);
      const [sessions, devices] = await Promise.all([
        tx.session.groupBy({ by: ["userId"], where: { userId: { in: ids }, securityOrganizationId: organizationId, expiresAt: { gt: new Date() } }, _count: true, _max: { createdAt: true } }),
        tx.securityDevice.groupBy({ by: ["userId"], where: { userId: { in: ids }, organizationId, revokedAt: null }, _count: true }),
      ]);
      return members.map((member) => ({
        userId: member.userId, name: member.user.name, email: member.user.email, role: member.role, status: member.user.status,
        // An organization-created account has no real mailbox even though its login is "verified".
        mailbox: member.user.createdByOrganizationId ? ("organization" as const) : member.user.emailVerified ? ("verified" as const) : ("unverified" as const),
        passwordChangeRequired: member.user.passwordChangeRequired,
        activeSessions: sessions.find((row) => row.userId === member.userId)?._count ?? 0,
        lastSessionAt: iso(sessions.find((row) => row.userId === member.userId)?._max.createdAt ?? null),
        activeDevices: devices.find((row) => row.userId === member.userId)?._count ?? 0,
      }));
    });
  },

  ips(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.ips.view");
      const rows = await tx.securityIpRule.findMany({ where: { organizationId }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
      return rows.map((row) => ({ id: row.id, kind: row.kind, cidr: row.cidr, note: row.note, createdAt: row.createdAt.toISOString() }));
    });
  },

  addIp(userId: string, organizationId: string, input: { kind: "ALLOW" | "DENY"; cidr: string; note?: string }) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.ips.manage");
      const parsed = parseCidr(input.cidr);
      if (!parsed) fail(422, "INVALID_CIDR", "Enter an IPv4, IPv6 or CIDR range");
      const existing = await tx.securityIpRule.findMany({ where: { organizationId }, select: { kind: true, cidr: true } });
      if (existing.length >= MAX_IP_RULES) fail(409, "IP_RULE_LIMIT", "Too many rules for this organization");
      if (existing.some((rule) => rule.kind === input.kind && rule.cidr === parsed.text)) fail(409, "IP_RULE_EXISTS", "That rule already exists");
      // Never let an administrator lock themselves out by saving a rule that would reject the address they are using.
      const ip = currentNetwork()?.ip;
      if (ip && !evaluateIp(ip, [...existing, { kind: input.kind, cidr: parsed.text }]).allowed) fail(409, "WOULD_LOCK_OUT", "This rule would block your current address");
      const row = await tx.securityIpRule.create({ data: { organizationId, kind: input.kind, cidr: parsed.text, note: input.note?.trim() || null, createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.ip.add", targetType: "ip_rule", targetId: row.id, metadata: { kind: row.kind, cidr: row.cidr } });
      return { id: row.id, kind: row.kind, cidr: row.cidr, note: row.note, createdAt: row.createdAt.toISOString() };
    });
  },

  removeIp(userId: string, organizationId: string, ruleId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.ips.manage");
      const rule = await tx.securityIpRule.findFirst({ where: { id: ruleId, organizationId } });
      if (!rule) fail(404, "NOT_FOUND", "Rule not found");
      const remaining = (await tx.securityIpRule.findMany({ where: { organizationId, id: { not: ruleId } }, select: { kind: true, cidr: true } }));
      const ip = currentNetwork()?.ip;
      if (ip && !evaluateIp(ip, remaining).allowed) fail(409, "WOULD_LOCK_OUT", "Removing this rule would block your current address");
      await tx.securityIpRule.delete({ where: { id: ruleId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.ip.remove", targetType: "ip_rule", targetId: ruleId, metadata: { kind: rule.kind, cidr: rule.cidr } });
      return { id: ruleId };
    });
  },

  policy(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.policies.view");
      return policyView(await tx.organizationSecurityPolicy.findUnique({ where: { organizationId } }));
    });
  },

  setPolicy(userId: string, organizationId: string, input: PolicyInput) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.policies.manage");
      const exemption = input.retentionExemption;
      if (exemption && new Date(exemption.until) <= new Date()) fail(422, "INVALID_EXEMPTION", "The retention exception must end in the future");
      const data = {
        enforcement: input.enforcement, maxDevices: input.maxDevices, maxSessions: input.maxSessions, overflowPolicy: input.overflowPolicy,
        alertsEnabled: input.alertsEnabled, retentionDays: input.retentionDays, updatedBy: userId,
        retentionExemptUntil: exemption ? new Date(exemption.until) : null, retentionExemptReason: exemption?.reason.trim() ?? null, retentionExemptBy: exemption ? userId : null,
      };
      const before = await tx.organizationSecurityPolicy.findUnique({ where: { organizationId } });
      const row = await tx.organizationSecurityPolicy.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.policy.update", targetType: "organization", targetId: organizationId, metadata: {
        enforcement: row.enforcement, maxDevices: row.maxDevices, maxSessions: row.maxSessions, overflowPolicy: row.overflowPolicy, retentionDays: row.retentionDays,
        retentionExemptUntil: iso(row.retentionExemptUntil), wasConfigured: Boolean(before),
      } });
      return policyView(row);
    });
  },

  notifications(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.notifications.manage");
      const row = await tx.organizationSecurityPolicy.findUnique({ where: { organizationId } });
      return { alertEmailEnabled: row?.alertEmailEnabled ?? false, alertEmailRecipients: row?.alertEmailRecipients ?? [] };
    });
  },

  setNotifications(userId: string, organizationId: string, input: { alertEmailEnabled: boolean; alertEmailRecipients: string[] }) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.notifications.manage");
      const recipients = [...new Set(input.alertEmailRecipients.map((email) => email.trim().toLowerCase()))];
      const row = await tx.organizationSecurityPolicy.upsert({
        where: { organizationId }, create: { organizationId, alertEmailEnabled: input.alertEmailEnabled, alertEmailRecipients: recipients, updatedBy: userId },
        update: { alertEmailEnabled: input.alertEmailEnabled, alertEmailRecipients: recipients, updatedBy: userId },
      });
      await audit.append(tx, { actorId: userId, organizationId, action: "security.notifications.update", targetType: "organization", targetId: organizationId, metadata: { enabled: row.alertEmailEnabled, recipients: recipients.length } });
      return { alertEmailEnabled: row.alertEmailEnabled, alertEmailRecipients: row.alertEmailRecipients };
    });
  },

  alerts(userId: string, organizationId: string, query: { status?: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" }) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.alerts.view");
      const rows = await tx.securityAlert.findMany({ where: { organizationId, ...(query.status ? { status: query.status } : {}) }, orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }], take: PAGE });
      return rows.map((row) => ({
        id: row.id, kind: row.kind, severity: row.severity, userId: row.userId, count: row.count, details: row.details, status: row.status, emailStatus: row.emailStatus, emailError: row.emailError,
        firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(),
      }));
    });
  },

  setAlertStatus(userId: string, organizationId: string, alertId: string, status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED") {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.alerts.manage");
      const done = await tx.securityAlert.updateMany({ where: { id: alertId, organizationId }, data: { status, handledBy: userId } });
      if (done.count !== 1) fail(404, "NOT_FOUND", "Alert not found");
      await audit.append(tx, { actorId: userId, organizationId, action: "security.alert.status", targetType: "alert", targetId: alertId, metadata: { status } });
      return { id: alertId, status };
    });
  },

  audit(userId: string, organizationId: string, query: { limit: number; before?: string }) {
    return transaction(async (tx) => {
      await need(tx, userId, organizationId, "security.audit.view");
      const rows = await tx.auditLog.findMany({
        where: { organizationId, OR: [{ action: { startsWith: "security." } }, { action: { startsWith: "authorization." } }], ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
      });
      return rows.map((row) => ({ id: row.id, actorId: row.actorId, action: row.action, targetType: row.targetType, targetId: row.targetId, metadata: row.metadata, createdAt: row.createdAt.toISOString() }));
    });
  },

  /** Own sessions, with no organization permission: it lets a blocked-by-limit user free a seat from another device. */
  mySessions(userId: string, currentSessionId?: string) {
    return transaction(async (tx) => {
      const rows = await tx.session.findMany({ where: { userId, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE });
      return rows.map((row) => ({ id: row.id, ipAddress: row.ipAddress, userAgent: row.userAgent, createdAt: row.createdAt.toISOString(), current: row.id === currentSessionId }));
    });
  },

  revokeMySession(userId: string, sessionId: string) {
    return transaction(async (tx) => {
      const done = await tx.session.deleteMany({ where: { id: sessionId, userId } });
      if (done.count !== 1) fail(404, "NOT_FOUND", "Session not found");
      await audit.append(tx, { actorId: userId, action: "security.session.revoke_own", targetType: "session", targetId: sessionId });
      return { id: sessionId };
    });
  },
};
