import type { OrganizationLandingMode, TenantRole } from "../../lib/database.js";
import { fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorizeNorth, hasNorthCapability } from "../authorization/north-capabilities.js";
import { tenantAccess } from "../authorization/tenant-access.js";
import { northPanelAudienceAllows } from "./audience.js";

/** ADR 027. The landing is a stored policy: STANDARD (system home), PANEL (any published panel) or NONE, plus ordered
 *  role/group rules. An organization without a row keeps the legacy meaning of `homePanelId`. */
export type LandingRuleInput = { role?: TenantRole; groupId?: string; panelId: string };
export type LandingInput = { mode: OrganizationLandingMode; defaultPanelId?: string | null; rules: LandingRuleInput[]; expectedUpdatedAt?: Date | null };
export const MAX_LANDING_RULES = 50;

const panelInclude = {
  subcategory: { include: { category: true } },
  audienceRoles: true, audienceGroups: true, audiencePermissions: true, audienceMemberships: true,
} as const;

async function loadPanel(tx: Transaction, organizationId: string, panelId: string) {
  return tx.northPanel.findFirst({ where: { id: panelId, organizationId }, include: panelInclude });
}
type LoadedPanel = NonNullable<Awaited<ReturnType<typeof loadPanel>>>;

const navigable = (panel: LoadedPanel) =>
  panel.status === "PUBLISHED" && panel.subcategory.status === "ACTIVE" && panel.subcategory.category.status === "ACTIVE";
const targetOf = (panel: LoadedPanel) => ({ categorySlug: panel.subcategory.category.slug, subcategorySlug: panel.subcategory.slug, panelSlug: panel.slug });

/** The stored configuration, or the legacy one derived from `homePanelId` when the organization has no row. */
async function configuration(tx: Transaction, organizationId: string) {
  const [row, rules, organization] = await Promise.all([
    tx.organizationLanding.findUnique({ where: { organizationId } }),
    tx.organizationLandingRule.findMany({ where: { organizationId }, orderBy: { order: "asc" } }),
    tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { homePanelId: true } }),
  ]);
  if (row) return { mode: row.mode, defaultPanelId: row.defaultPanelId, rules, updatedAt: row.updatedAt };
  return { mode: (organization.homePanelId ? "PANEL" : "STANDARD") as OrganizationLandingMode, defaultPanelId: organization.homePanelId, rules, updatedAt: null as Date | null };
}

const view = (c: Awaited<ReturnType<typeof configuration>>) => ({
  mode: c.mode, defaultPanelId: c.defaultPanelId, updatedAt: c.updatedAt,
  rules: c.rules.map((rule) => ({ order: rule.order, role: rule.role ?? undefined, groupId: rule.groupId ?? undefined, panelId: rule.panelId })),
});

/** A rule is usable only if the target panel is visible to the audience the rule addresses. */
function visibleTo(panel: LoadedPanel, rule: LandingRuleInput) {
  if (panel.audienceType === "ALL_MEMBERS") return true;
  if (rule.role) return panel.audienceType === "ROLES" && panel.audienceRoles.some((item) => item.role === rule.role);
  return panel.audienceType === "GROUPS" && panel.audienceGroups.some((item) => item.groupId === rule.groupId);
}

export const northLanding = {
  read(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorizeNorth(tx, userId, "north.category.update", { organizationId, scope: "ORGANIZATION" });
      return view(await configuration(tx, organizationId));
    });
  },

  /** Deterministic, server-authoritative destination for this actor. `target: null` means "no landing page". */
  resolve(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      const member = await tenantAccess.member(tx, organizationId, userId);
      if (!member) fail(404, "NOT_FOUND", "Organization not found");
      const config = await configuration(tx, organizationId);
      const allowed = async (panelId: string) => {
        const panel = await loadPanel(tx, organizationId, panelId);
        if (!panel || !navigable(panel)) return null;
        const scope = { organizationId, scope: "PANEL" as const, categoryId: panel.subcategory.categoryId, subcategoryId: panel.subcategoryId, panelId: panel.id };
        if (!(await hasNorthCapability(tx, userId, "north.panel.read", scope))) return null;
        return (await northPanelAudienceAllows(tx, userId, panel, panel.subcategory.categoryId)) ? panel : null;
      };
      if (config.mode === "NONE") return { mode: config.mode, source: "none" as const, target: null };
      const groupIds = new Set((await tx.organizationGroupMember.findMany({ where: { organizationId, membershipId: member.id }, select: { groupId: true } })).map((item) => item.groupId));
      for (const rule of config.rules) {
        if (rule.role ? rule.role !== member.role : !groupIds.has(rule.groupId!)) continue;
        const panel = await allowed(rule.panelId);
        if (panel) return { mode: config.mode, source: "rule" as const, target: targetOf(panel) };
      }
      let panel: LoadedPanel | null = null;
      if (config.mode === "PANEL") panel = config.defaultPanelId ? await allowed(config.defaultPanelId) : null;
      else {
        const home = await tx.northPanel.findFirst({ where: { organizationId, slug: "home", resourceKind: "SYSTEM", subcategory: { category: { slug: "home", resourceKind: "SYSTEM" } } }, select: { id: true } });
        panel = home ? await allowed(home.id) : null;
      }
      return { mode: config.mode, source: panel ? ("default" as const) : ("none" as const), target: panel ? targetOf(panel) : null };
    });
  },

  update(userId: string, organizationId: string, input: LandingInput) {
    return transaction(async (tx) => {
      await authorizeNorth(tx, userId, "north.category.update", { organizationId, scope: "ORGANIZATION" });
      const bad = (message: string) => fail(422, "LANDING_PANEL_INVALID", message);
      if (input.rules.length > MAX_LANDING_RULES) fail(422, "LANDING_RULE_LIMIT", `At most ${MAX_LANDING_RULES} rules`);
      if (input.mode === "PANEL" && !input.defaultPanelId) fail(422, "LANDING_PANEL_REQUIRED", "Mode PANEL needs a default panel");
      if (input.mode !== "PANEL" && input.defaultPanelId) fail(422, "LANDING_PANEL_NOT_ALLOWED", "Only mode PANEL takes a default panel");
      if (input.mode === "NONE" && input.rules.length) fail(422, "LANDING_RULES_NOT_ALLOWED", "Mode NONE takes no rules");
      const seen = new Set<string>();
      for (const rule of input.rules) {
        if (Boolean(rule.role) === Boolean(rule.groupId)) fail(422, "LANDING_RULE_INVALID", "A rule addresses exactly one role or group");
        const key = rule.role ? `r:${rule.role}` : `g:${rule.groupId}`;
        if (seen.has(key)) fail(409, "LANDING_RULE_CONFLICT", "Only one rule per role or group");
        seen.add(key);
      }
      const groupIds = input.rules.flatMap((rule) => (rule.groupId ? [rule.groupId] : []));
      if (groupIds.length && (await tx.organizationGroup.count({ where: { organizationId, id: { in: groupIds } } })) !== groupIds.length) bad("Group not found in this organization");

      const before = await configuration(tx, organizationId);
      if (input.expectedUpdatedAt !== undefined && (before.updatedAt?.getTime() ?? null) !== (input.expectedUpdatedAt?.getTime() ?? null))
        fail(409, "LANDING_CONFLICT", "The landing changed since it was loaded");

      if (input.defaultPanelId) {
        const panel = await loadPanel(tx, organizationId, input.defaultPanelId);
        if (!panel || !navigable(panel)) bad("Default panel must be published in this organization");
        else if (!(await northPanelAudienceAllows(tx, userId, panel, panel.subcategory.categoryId))) bad("Default panel is not authorized for the actor");
      }
      for (const rule of input.rules) {
        const panel = await loadPanel(tx, organizationId, rule.panelId);
        if (!panel || !navigable(panel)) bad("Rule panel must be published in this organization");
        else if (!visibleTo(panel, rule)) bad("Rule panel is not visible to the audience of the rule");
      }

      await tx.organizationLanding.upsert({
        where: { organizationId },
        create: { organizationId, mode: input.mode, defaultPanelId: input.defaultPanelId ?? null, updatedBy: userId },
        update: { mode: input.mode, defaultPanelId: input.defaultPanelId ?? null, updatedBy: userId },
      });
      await tx.organizationLandingRule.deleteMany({ where: { organizationId } });
      if (input.rules.length)
        await tx.organizationLandingRule.createMany({ data: input.rules.map((rule, order) => ({ organizationId, order, role: rule.role ?? null, groupId: rule.groupId ?? null, panelId: rule.panelId })) });
      // D5: homePanelId mirrors the default for one release so older readers keep working.
      await tx.organization.update({ where: { id: organizationId }, data: { homePanelId: input.defaultPanelId ?? null } });
      await audit.append(tx, {
        actorId: userId, organizationId, action: "NORTH_LANDING_UPDATED", targetType: "Organization", targetId: organizationId,
        metadata: { before: { mode: before.mode, defaultPanelId: before.defaultPanelId, rules: before.rules.length }, after: { mode: input.mode, defaultPanelId: input.defaultPanelId ?? null, rules: input.rules.length } },
      });
      return view(await configuration(tx, organizationId));
    });
  },
};
