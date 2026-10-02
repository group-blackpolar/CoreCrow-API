import { Prisma } from "../../../lib/database.js";
import { fail } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { auditRepository as audit } from "../../audit/repository.js";
import { isNorthCapability } from "../../authorization/policy.js";
import { validateNorthSlug } from "../slug.js";
import {
  assertDatasetOwnerAccess,
  authorizeDataset,
  datasetAclAllows,
  hasOrganizationDataCapability,
  requireOrganizationDataCapability,
} from "./authorization.js";
import { northDataRepository as repo } from "./repository.js";
import type {
  DatasetAclCreateInput,
  DatasetCreateInput,
  DatasetFieldCreateInput,
  DatasetFieldUpdateInput,
  DatasetSchemaCreateInput,
  DatasetUpdateInput,
} from "./types.js";

function datasetSlug(value: string) {
  const result = validateNorthSlug(value, false);
  if (result.error) fail(result.error === "NORTH_SLUG_RESERVED" ? 409 : 422, result.error, "Dataset slug is unavailable");
  return result.slug;
}

function stableConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
    fail(409, "DATASET_CONFLICT", "Dataset slug, field key, schema version, or ACL rule already exists");
  throw error;
}

function aclColumns(input: DatasetAclCreateInput) {
  if (input.principalType === "MEMBERSHIP") return { membershipId: input.membershipId };
  if (input.principalType === "GROUP") return { groupId: input.groupId };
  if (input.principalType === "ROLE") return { role: input.role };
  if (input.principalType === "CAPABILITY") return { capability: input.capability };
  return {};
}

async function validateAclPrincipal(
  tx: Parameters<typeof repo.membershipPrincipal>[0],
  organizationId: string,
  input: DatasetAclCreateInput,
) {
  if (input.principalType === "MEMBERSHIP" && !(await repo.membershipPrincipal(tx, organizationId, input.membershipId)))
    fail(422, "ACL_PRINCIPAL_INVALID", "Membership principal is outside the organization");
  if (input.principalType === "GROUP" && !(await repo.groupPrincipal(tx, organizationId, input.groupId)))
    fail(422, "ACL_PRINCIPAL_INVALID", "Group principal is outside the organization");
  if (input.principalType === "CAPABILITY" && !isNorthCapability(input.capability))
    fail(422, "UNKNOWN_CAPABILITY", "Capability is not registered");
}

export const northData = {
  list(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.read");
      const mayInspectArchived = await hasOrganizationDataCapability(tx, membership, "north.data.manage");
      const datasets = await repo.datasets(tx, organizationId);
      const visible = [];
      for (const dataset of datasets) {
        if (dataset.status === "ARCHIVED" && !mayInspectArchived) continue;
        const rules = await repo.aclRules(tx, organizationId, dataset.id);
        if (await datasetAclAllows(tx, membership, rules)) visible.push(dataset);
      }
      return visible;
    });
  },

  read(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) =>
      (await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.read")).dataset,
    );
  },

  create(userId: string, organizationId: string, input: DatasetCreateInput) {
    return transaction(async (tx) => {
      const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.manage");
      const slug = datasetSlug(input.slug);
      try {
        const dataset = await repo.createDataset(tx, { ...input, slug, organizationId, createdBy: userId });
        await repo.createAclRule(tx, {
          organizationId,
          datasetId: dataset.id,
          effect: "ALLOW",
          principalType: "ROLE",
          role: "OWNER",
          createdBy: userId,
        });
        await repo.createAclRule(tx, {
          organizationId,
          datasetId: dataset.id,
          effect: "ALLOW",
          principalType: "MEMBERSHIP",
          membershipId: membership.id,
          createdBy: userId,
        });
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "NORTH_DATASET_CREATED",
          targetType: "NorthDataset",
          targetId: dataset.id,
          metadata: { slug },
        });
        return dataset;
      } catch (error) {
        stableConflict(error);
      }
    });
  },

  update(userId: string, organizationId: string, datasetId: string, input: DatasetUpdateInput) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      try {
        const dataset = await repo.updateDataset(tx, datasetId, {
          ...input,
          ...(input.slug ? { slug: datasetSlug(input.slug) } : {}),
        });
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "NORTH_DATASET_UPDATED",
          targetType: "NorthDataset",
          targetId: datasetId,
          metadata: { fields: Object.keys(input).sort() },
        });
        return dataset;
      } catch (error) {
        stableConflict(error);
      }
    });
  },

  fields(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.read");
      return repo.fields(tx, organizationId, datasetId);
    });
  },

  createField(userId: string, organizationId: string, datasetId: string, input: DatasetFieldCreateInput) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      try {
        const field = await repo.createField(tx, {
          ...input,
          organizationId,
          datasetId,
          nullable: input.nullable ?? true,
        });
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "NORTH_DATASET_FIELD_CREATED",
          targetType: "NorthDatasetField",
          targetId: field.id,
          metadata: { datasetId, key: field.key },
        });
        return field;
      } catch (error) {
        stableConflict(error);
      }
    });
  },

  updateField(userId: string, organizationId: string, datasetId: string, fieldId: string, input: DatasetFieldUpdateInput) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      if (!(await repo.field(tx, organizationId, datasetId, fieldId))) fail(404, "NOT_FOUND", "Dataset field not found");
      const field = await repo.updateField(tx, fieldId, input);
      await audit.append(tx, {
        actorId: userId,
        organizationId,
        action: "NORTH_DATASET_FIELD_UPDATED",
        targetType: "NorthDatasetField",
        targetId: fieldId,
        metadata: { datasetId, fields: Object.keys(input).sort() },
      });
      return field;
    });
  },

  schemaVersions(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.read");
      return repo.schemaVersions(tx, organizationId, datasetId);
    });
  },

  schemaVersion(userId: string, organizationId: string, datasetId: string, schemaVersionId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.read");
      const schema = await repo.schemaVersion(tx, organizationId, datasetId, schemaVersionId);
      if (!schema) fail(404, "NOT_FOUND", "Dataset schema version not found");
      return schema;
    });
  },

  createSchemaVersion(userId: string, organizationId: string, datasetId: string, input: DatasetSchemaCreateInput) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      const ids = input.fields.map((field) => field.fieldId);
      if (new Set(ids).size !== ids.length || new Set(input.fields.map((field) => field.ordinal)).size !== input.fields.length)
        fail(422, "DATASET_SCHEMA_INVALID", "Schema fields and ordinals must be unique");
      const fields = await repo.fieldsByIds(tx, organizationId, datasetId, ids);
      if (fields.length !== ids.length) fail(422, "DATASET_SCHEMA_INVALID", "Schema contains an unavailable field");
      const byId = new Map(fields.map((field) => [field.id, field]));
      const maximum = await repo.nextSchemaVersion(tx, datasetId);
      const version = (maximum._max.version ?? 0) + 1;
      try {
        const schema = await repo.createSchemaVersion(tx, {
          organizationId,
          datasetId,
          version,
          createdBy: userId,
          fields: input.fields.map(({ fieldId, ordinal }) => {
            const field = byId.get(fieldId)!;
            return {
              datasetFieldId: field.id,
              canonicalType: field.canonicalType,
              semanticType: field.semanticType,
              nullable: field.nullable,
              status: field.status,
              ordinal,
            };
          }),
        });
        await repo.pointCurrentSchema(tx, datasetId, schema.id);
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "NORTH_DATASET_SCHEMA_CREATED",
          targetType: "NorthDatasetSchemaVersion",
          targetId: schema.id,
          metadata: { datasetId, version, fieldCount: schema.fields.length },
        });
        return schema;
      } catch (error) {
        stableConflict(error);
      }
    });
  },

  acl(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.permission.manage");
      return repo.aclRules(tx, organizationId, datasetId);
    });
  },

  createAclRule(userId: string, organizationId: string, datasetId: string, input: DatasetAclCreateInput) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.permission.manage");
      await validateAclPrincipal(tx, organizationId, input);
      try {
        const rule = await repo.createAclRule(tx, {
          organizationId,
          datasetId,
          effect: input.effect,
          principalType: input.principalType,
          ...aclColumns(input),
          createdBy: userId,
        });
        await assertDatasetOwnerAccess(tx, organizationId, datasetId);
        await audit.append(tx, {
          actorId: userId,
          organizationId,
          action: "NORTH_DATASET_ACL_CREATED",
          targetType: "NorthDatasetAcl",
          targetId: rule.id,
          metadata: { datasetId, effect: rule.effect, principalType: rule.principalType },
        });
        return rule;
      } catch (error) {
        stableConflict(error);
      }
    });
  },

  deleteAclRule(userId: string, organizationId: string, datasetId: string, aclId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.permission.manage");
      const rule = await repo.aclRule(tx, organizationId, datasetId, aclId);
      if (!rule) fail(404, "NOT_FOUND", "Dataset ACL rule not found");
      await repo.deleteAclRule(tx, aclId);
      await assertDatasetOwnerAccess(tx, organizationId, datasetId);
      await audit.append(tx, {
        actorId: userId,
        organizationId,
        action: "NORTH_DATASET_ACL_DELETED",
        targetType: "NorthDatasetAcl",
        targetId: aclId,
        metadata: { datasetId, effect: rule.effect, principalType: rule.principalType },
      });
    });
  },
};
