import { z } from "zod";
import { localizedText, northAudienceType, northMetadataInput, role } from "../../contracts/schemas.js";
import { northCapabilities } from "../authorization/policy.js";
import { northPanelDocumentInput } from "./content-schema.js";

const templateMetadata = northMetadataInput.omit({ order: true }).extend({
  slug: z.string().trim().min(1).max(100),
});

const templateAudience = z.object({
  type: northAudienceType.refine(
    (value) => !["GROUPS", "SPECIFIC_USERS"].includes(value),
    "Tenant-bound audience selectors are not portable",
  ),
  roles: z.array(role).max(10).default([]),
  capabilities: z.array(z.enum(northCapabilities)).max(100).default([]),
}).strict().superRefine((value, context) => {
  if (value.type === "ROLES" && value.roles.length === 0)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Role audience cannot be empty" });
  if (value.type === "PERMISSIONS" && value.capabilities.length === 0)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Permission audience cannot be empty" });
});

const templatePanel = templateMetadata.extend({
  audience: templateAudience.default({ type: "ALL_MEMBERS", roles: [], capabilities: [] }),
  document: northPanelDocumentInput.optional(),
}).strict();

const templateSubcategory = templateMetadata.extend({
  panels: z.array(templatePanel).max(100),
}).strict();

export const northTemplateSnapshotInput = z.object({
  schemaVersion: z.literal(1),
  category: templateMetadata,
  subcategories: z.array(templateSubcategory).max(100),
}).strict();

export const northTemplateCreateInput = z.object({
  slug: z.string().trim().min(1).max(100),
  name: localizedText,
  description: localizedText.nullable().optional(),
  snapshot: northTemplateSnapshotInput,
}).strict();

export type NorthTemplateSnapshot = z.infer<typeof northTemplateSnapshotInput>;
