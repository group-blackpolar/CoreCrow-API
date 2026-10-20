import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { securityAccess } from "../modules/security-access/service.js";

const tag = "Security and access";
const base = "/organizations/:organizationId/security";
const org = s.orgParams;
const withId = <K extends string>(name: K) => org.extend({ [name]: s.id } as Record<K, typeof s.id>).strict();
const status = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
const overflow = z.enum(["BLOCK_NEW", "REPLACE_OLDEST", "REQUIRE_USER_CHOICE"]);
const limit = z.number().int().min(1).max(1000).nullable();
const policy = z.object({
  configured: z.boolean(), enforcement: z.boolean(), maxDevices: limit, maxSessions: limit, overflowPolicy: overflow, alertsEnabled: z.boolean(),
  retentionDays: z.number().int(), retentionExemption: z.object({ until: s.date, reason: z.string(), by: z.string().nullable() }).nullable(), updatedAt: s.date.nullable(),
});
const ipRule = z.object({ id: s.id, kind: z.enum(["ALLOW", "DENY"]), cidr: z.string(), note: z.string().nullable(), createdAt: s.date });
const notifications = z.object({ alertEmailEnabled: z.boolean(), alertEmailRecipients: z.array(z.string()) });

export async function securityAccessRoutes(app: FastifyInstance) {
  contract(app, {
    method: "GET", url: `${base}/overview`, tag, summary: "Security overview of the organization (security.overview.view)", params: org,
    response: z.object({
      policy, activeDevices: z.number().int(), activeSessions: z.number().int(), openAlerts: z.number().int(), allowRules: z.number().int(), denyRules: z.number().int(),
      lastRetentionRun: z.object({ ranAt: s.date, purgedAlerts: z.number().int(), purgedDevices: z.number().int(), skipped: z.string().nullable() }).nullable(),
    }),
    run: ({ user, params }) => securityAccess.overview(user.id, params.organizationId),
  });
  contract(app, {
    method: "GET", url: `${base}/devices`, tag, summary: "Registered devices governed by the organization (security.devices.view)", params: org,
    query: z.object({ includeRevoked: z.enum(["true", "false"]).default("false").transform((value) => value === "true") }).strict(),
    response: z.array(z.object({
      id: s.id, userId: s.id, userName: z.string().nullable(), userEmail: z.string(), userAgent: z.string().nullable(), firstIp: z.string().nullable(), lastIp: z.string().nullable(),
      firstSeenAt: s.date, lastSeenAt: s.date, revokedAt: s.date.nullable(), activeSessions: z.number().int(),
    })),
    run: ({ user, params, query }) => securityAccess.devices(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "DELETE", url: `${base}/devices/:deviceId`, tag, summary: "Revoke a device and end its sessions (security.devices.revoke)", params: withId("deviceId"),
    response: z.object({ id: s.id, sessionsEnded: z.number().int() }),
    run: ({ user, params }) => securityAccess.revokeDevice(user.id, params.organizationId, params.deviceId),
  });
  contract(app, {
    method: "GET", url: `${base}/sessions`, tag, summary: "Active sessions governed by the organization (security.sessions.view)", params: org,
    response: z.array(z.object({
      id: s.id, userId: s.id, userName: z.string().nullable(), userEmail: z.string(), ipAddress: z.string().nullable(), userAgent: z.string().nullable(),
      deviceId: s.id.nullable(), createdAt: s.date, expiresAt: s.date,
    })),
    run: ({ user, params }) => securityAccess.sessions(user.id, params.organizationId),
  });
  contract(app, {
    method: "DELETE", url: `${base}/sessions/:sessionId`, tag, summary: "End one session (security.sessions.revoke)", params: withId("sessionId"),
    response: z.object({ id: s.id }),
    run: ({ user, params }) => securityAccess.revokeSession(user.id, params.organizationId, params.sessionId),
  });
  contract(app, {
    method: "GET", url: `${base}/users`, tag, summary: "Members with authentication state and session/device counts (security.sessions.view)", params: org,
    response: z.array(z.object({
      userId: s.id, name: z.string().nullable(), email: z.string(), role: z.string(), status: z.string(), mailbox: z.enum(["verified", "unverified", "organization"]),
      passwordChangeRequired: z.boolean(), activeSessions: z.number().int(), lastSessionAt: s.date.nullable(), activeDevices: z.number().int(),
    })),
    run: ({ user, params }) => securityAccess.users(user.id, params.organizationId),
  });
  contract(app, {
    method: "DELETE", url: `${base}/users/:userId/sessions`, tag, summary: "End every session of a member governed by the organization (security.sessions.revoke)", params: withId("userId"),
    response: z.object({ sessionsEnded: z.number().int() }),
    run: ({ user, params }) => securityAccess.revokeUserSessions(user.id, params.organizationId, params.userId),
  });
  contract(app, {
    method: "GET", url: `${base}/ips`, tag, summary: "Allowed and blocked address rules (security.ips.view)", params: org, response: z.array(ipRule),
    run: ({ user, params }) => securityAccess.ips(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: `${base}/ips`, tag, summary: "Add an IPv4, IPv6 or CIDR rule; deny wins over allow (security.ips.manage)", params: org,
    body: z.object({ kind: z.enum(["ALLOW", "DENY"]), cidr: z.string().trim().min(2).max(64), note: z.string().trim().max(200).optional() }).strict(),
    response: ipRule, status: 201,
    run: ({ user, params, body }) => securityAccess.addIp(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "DELETE", url: `${base}/ips/:ruleId`, tag, summary: "Remove an address rule (security.ips.manage)", params: withId("ruleId"), response: z.object({ id: s.id }),
    run: ({ user, params }) => securityAccess.removeIp(user.id, params.organizationId, params.ruleId),
  });
  contract(app, {
    method: "GET", url: `${base}/policy`, tag, summary: "Device and session policy (security.policies.view)", params: org, response: policy,
    run: ({ user, params }) => securityAccess.policy(user.id, params.organizationId),
  });
  contract(app, {
    method: "PUT", url: `${base}/policy`, tag, summary: "Set the device/session policy and retention (security.policies.manage)", params: org,
    body: z.object({
      enforcement: z.boolean(), maxDevices: limit, maxSessions: limit, overflowPolicy: overflow, alertsEnabled: z.boolean(),
      retentionDays: z.number().int().min(7).max(3650),
      retentionExemption: z.object({ until: s.date, reason: z.string().trim().min(5).max(300) }).strict().nullable(),
    }).strict(),
    response: policy,
    run: ({ user, params, body }) => securityAccess.setPolicy(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: `${base}/notifications`, tag, summary: "Alert e-mail settings (security.notifications.manage)", params: org, response: notifications,
    run: ({ user, params }) => securityAccess.notifications(user.id, params.organizationId),
  });
  contract(app, {
    method: "PUT", url: `${base}/notifications`, tag, summary: "Configure alert e-mails (security.notifications.manage)", params: org,
    body: z.object({ alertEmailEnabled: z.boolean(), alertEmailRecipients: z.array(z.string().trim().email().max(254)).max(10) }).strict(), response: notifications,
    run: ({ user, params, body }) => securityAccess.setNotifications(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: `${base}/alerts`, tag, summary: "Security alerts (security.alerts.view)", params: org, query: z.object({ status: status.optional() }).strict(),
    response: z.array(z.object({
      id: s.id, kind: z.string(), severity: z.string(), userId: s.id.nullable(), count: z.number().int(), details: z.unknown().nullable(), status, emailStatus: z.enum(["NONE", "SENT", "FAILED"]),
      emailError: z.string().nullable(), firstSeenAt: s.date, lastSeenAt: s.date,
    })),
    run: ({ user, params, query }) => securityAccess.alerts(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "PATCH", url: `${base}/alerts/:alertId`, tag, summary: "Acknowledge or resolve an alert (security.alerts.manage)", params: withId("alertId"),
    body: z.object({ status }).strict(), response: z.object({ id: s.id, status }),
    run: ({ user, params, body }) => securityAccess.setAlertStatus(user.id, params.organizationId, params.alertId, body.status),
  });
  contract(app, {
    method: "GET", url: `${base}/audit`, tag, summary: "Security and authorization audit trail (security.audit.view)", params: org,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: s.date.optional() }).strict(),
    response: z.array(z.object({ id: s.id, actorId: s.id.nullable(), action: z.string(), targetType: z.string().nullable(), targetId: z.string().nullable(), metadata: z.unknown().nullable(), createdAt: s.date })),
    run: ({ user, params, query }) => securityAccess.audit(user.id, params.organizationId, query),
  });
  contract(app, {
    method: "GET", url: "/me/sessions", tag, summary: "Your active sessions", response: z.array(z.object({ id: s.id, ipAddress: z.string().nullable(), userAgent: z.string().nullable(), createdAt: s.date, current: z.boolean() })),
    run: ({ user, request }) => securityAccess.mySessions(user.id, request.user?.sessionId),
  });
  contract(app, {
    method: "DELETE", url: "/me/sessions/:sessionId", tag, summary: "End one of your sessions", params: z.object({ sessionId: s.id }).strict(), response: z.object({ id: s.id }),
    run: ({ user, params }) => securityAccess.revokeMySession(user.id, params.sessionId),
  });
}
