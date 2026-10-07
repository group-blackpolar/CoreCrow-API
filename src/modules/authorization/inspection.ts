import type { FastifyRequest } from "fastify";
import { fail } from "../../shared/errors.js";
import type { Inspection } from "../../shared/request-context.js";
import { transaction } from "../../shared/transaction.js";
import { auditRepository } from "../audit/repository.js";
import { permissions, type Permission } from "./policy.js";

export const INSPECTION_HEADER = "x-platform-inspect";
export const INSPECTION_SESSION_HEADER = "x-platform-inspection-session";

/** Read-only subset. `invitations.read` lists invitations without exposing any credential; no `*.manage`. */
export const inspectionPermissions: Permission[] = permissions.filter((permission) =>
  ["organization.read", "members.read", "groups.read", "audit.read", "commerce.read", "billing.read", "documents.read", "invitations.read"].includes(permission),
);

const READ_ONLY_NORTH = /\.(read|preview|query)$/;
export const inspectionAllowsNorth = (capability: string) => READ_ONLY_NORTH.test(capability);

/** Sensitive reads worth an audit event; ordinary content (home, views, categories, assets) is deliberately not logged. */
export function sensitiveInspectionEvent(routePattern: string): string | null {
  // `/permissions` alone is the viewer's own capability discovery (fired on every screen load): not logged.
  if (/permission-grants|\/groups|north\/permission/.test(routePattern)) return "platform.inspection.permissions.viewed";
  if (/\/members/.test(routePattern)) return "platform.inspection.users.viewed";
  if (/\/audit/.test(routePattern)) return "platform.inspection.audit.viewed";
  if (/\/invitations/.test(routePattern)) return "platform.inspection.invitations.viewed";
  if (/\/billing|\/subscriptions|\/entitlements/.test(routePattern)) return "platform.inspection.billing.viewed";
  return null;
}

function sessionId(request: FastifyRequest) {
  const raw = request.headers[INSPECTION_SESSION_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : undefined;
}

const record = (actorId: string, organizationId: string, action: string, metadata: Record<string, string | undefined>) =>
  transaction((tx) =>
    auditRepository.append(tx, {
      actorId,
      organizationId,
      action,
      targetType: "Organization",
      targetId: organizationId,
      metadata: JSON.parse(JSON.stringify(metadata)),
    }),
  );

/**
 * Platform inspection: an ADMIN/SUPERADMIN reads an organization they are not a member of.
 * Checked per request; only GET is allowed (blocked mutations are audited, without bodies) and no membership is created.
 */
export async function inspectionFor(
  request: FastifyRequest,
  user: { id: string; role: string },
): Promise<Inspection | undefined> {
  const raw = request.headers[INSPECTION_HEADER];
  if (raw === undefined) return undefined;
  const organizationId = Array.isArray(raw) ? raw[0] : raw;
  if (!organizationId || !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId))
    fail(400, "INSPECTION_INVALID", "Invalid inspection target");
  if (!["ADMIN", "SUPERADMIN"].includes(user.role))
    fail(403, "FORBIDDEN", "Platform operator permission required");
  const inspectionSessionId = sessionId(request);
  const pattern = request.routeOptions.url ?? "unknown";
  if (request.method !== "GET") {
    await record(user.id, organizationId, "platform.inspection.mutation_blocked", {
      method: request.method, resource: pattern, inspectionSessionId, ip: request.ip,
    });
    fail(403, "INSPECTION_READ_ONLY", "Platform inspection is read-only");
  }
  const event = sensitiveInspectionEvent(pattern);
  if (event) await record(user.id, organizationId, event, { resource: pattern, inspectionSessionId, ip: request.ip });
  return { userId: user.id, organizationId };
}
