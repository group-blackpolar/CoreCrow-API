import { Prisma, type NorthDatasetImportStatus } from "../../../lib/database.js";
import { DomainError, fail } from "../../../shared/errors.js";
import { datasetImportStorageFromEnvironment } from "./import-storage.js";
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

const purgeableImportStatuses = ["AWAITING_UPLOAD", "SECURITY_BLOCKED", "ANALYSIS_BLOCKED", "CANCELLED", "REJECTED", "FAILED"] satisfies NorthDatasetImportStatus[] as NorthDatasetImportStatus[];

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

async function datasetDependencies(tx: Parameters<typeof repo.membershipPrincipal>[0], organizationId: string, datasetId: string) {
  const bindings = await tx.northAnalyticsBinding.findMany({ where: { organizationId, datasetId }, select: { panelId: true } });
  const runningImports = await tx.northDatasetImportJob.count({ where: { organizationId, datasetId, status: { in: ["ANALYZING", "ACTIVATING", "SECURITY_PENDING", "CANCEL_REQUESTED"] } } });
  return { bindings: bindings.length, panels: new Set(bindings.map((binding) => binding.panelId)).size, runningImports };
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


  /**
   * Sync history housekeeping. Operational records only: imports that never produced data (failed, cancelled, rejected,
   * blocked or abandoned uploads). A job that materialized a batch is lineage of live data and is never purged here.
   * Security/compliance audit rows are a separate store and are untouched; this action itself is audited.
   */
  async purgeImports(userId: string, organizationId: string, datasetId: string, input: { olderThanDays: number; dryRun: boolean }) {
    const keys = await transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      const cutoff = new Date(Date.now() - input.olderThanDays * 86_400_000);
      const jobs = await tx.northDatasetImportJob.findMany({
        where: { organizationId, datasetId, status: { in: purgeableImportStatuses }, updatedAt: { lte: cutoff }, batch: { is: null } },
        select: { id: true, storageKey: true },
        take: 1000,
      });
      if (input.dryRun || jobs.length === 0) return { jobs, storageKeys: [] as string[], purged: 0 };
      const ids = jobs.map((job) => job.id);
      await tx.$executeRaw`SELECT set_config('corecrow.allow_dataset_erase', 'on', true)`;
      await tx.northDatasetImportJob.updateMany({ where: { id: { in: ids } }, data: { activationMappingId: null } });
      await tx.northDatasetImportAnalysis.deleteMany({ where: { organizationId, datasetId, importId: { in: ids } } });
      await tx.northDatasetImportMappingVersion.deleteMany({ where: { organizationId, datasetId, importId: { in: ids } } });
      await tx.northDatasetImportJob.deleteMany({ where: { id: { in: ids } } });
      await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_DATASET_IMPORTS_PURGED", targetType: "NorthDataset", targetId: datasetId, metadata: { purged: ids.length, olderThanDays: input.olderThanDays } });
      return { jobs, storageKeys: jobs.map((job) => job.storageKey), purged: ids.length };
    });
    const storage = datasetImportStorageFromEnvironment();
    await Promise.allSettled(keys.storageKeys.map(async (key) => storage.delete(key)));
    return { matched: keys.jobs.length, purged: keys.purged, dryRun: input.dryRun };
  },

  /** What a dataset still feeds: shown before archiving/erasing and used to refuse an unsafe erase. */
  async dependencies(userId: string, organizationId: string, datasetId: string) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      return datasetDependencies(tx, organizationId, datasetId);
    });
  },

  /**
   * Permanent erase. Two steps by design: archive first (reversible), then erase. Refused while any panel binding
   * reads the dataset or an import is running. Immutable snapshot tables are deleted under a transaction-local opt-in
   * (migration 20261014130000); blobs are removed best effort after commit.
   */
  async erase(userId: string, organizationId: string, datasetId: string) {
    const storageKeys = await transaction(async (tx) => {
      const { dataset } = await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      if (dataset.status !== "ARCHIVED") fail(409, "DATASET_NOT_ARCHIVED", "Archive the dataset before erasing it");
      const dependencies = await datasetDependencies(tx, organizationId, datasetId);
      if (dependencies.bindings > 0)
        throw new DomainError(409, "DATASET_IN_USE", "Dataset still feeds analytics bindings", { bindings: dependencies.bindings, panels: dependencies.panels });
      if (dependencies.runningImports > 0) fail(409, "DATASET_IMPORT_RUNNING", "Wait for running imports to finish or cancel them");
      await tx.$executeRaw`SELECT set_config('corecrow.allow_dataset_erase', 'on', true)`;
      const where = { organizationId, datasetId };
      const jobs = await tx.northDatasetImportJob.findMany({ where, select: { storageKey: true } });
      await tx.northDataset.update({ where: { id: datasetId }, data: { currentSchemaVersionId: null, activeRevisionId: null } });
      await tx.northDatasetImportJob.updateMany({ where, data: { activationMappingId: null } });
      await tx.northDatasetRow.deleteMany({ where });
      await tx.northDatasetRevisionBatch.deleteMany({ where });
      await tx.northDatasetRevision.deleteMany({ where });
      await tx.northDatasetImportBatch.deleteMany({ where });
      await tx.northDatasetImportAnalysis.deleteMany({ where });
      await tx.northDatasetImportMappingVersion.deleteMany({ where });
      await tx.northDatasetImportJob.deleteMany({ where });
      await tx.northDatasetSchemaVersionField.deleteMany({ where: { schemaVersion: { datasetId, organizationId } } });
      await tx.northDatasetSchemaVersion.deleteMany({ where });
      await tx.northDatasetField.deleteMany({ where });
      await tx.northDatasetAcl.deleteMany({ where });
      await tx.northDataset.delete({ where: { id: datasetId } });
      await audit.append(tx, {
        actorId: userId, organizationId, action: "NORTH_DATASET_ERASED", targetType: "NorthDataset", targetId: datasetId,
        metadata: { slug: dataset.slug, imports: jobs.length },
      });
      return jobs.map((job) => job.storageKey);
    }, { timeoutMilliseconds: 120_000 });
    const storage = datasetImportStorageFromEnvironment();
    await Promise.allSettled(storageKeys.map(async (key) => storage.delete(key)));
    return null;
  },
};
