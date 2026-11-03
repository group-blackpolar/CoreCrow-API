import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../../contracts/route.js";
import * as s from "../../contracts/schemas.js";
import { fail } from "../../shared/errors.js";
import { northData } from "../../modules/north/data/service.js";
import { northDatasetGroups } from "../../modules/north/data/group-service.js";
import { northDatasetGroupQuery } from "../../modules/north/data/group-query-service.js";
import { northPipelines, PIPELINE_STEP_IDS } from "../../modules/north/data/pipeline-service.js";
import { northDatasetImports } from "../../modules/north/data/import-service.js";
import { northDatasetImportAnalysis } from "../../modules/north/data/import-analysis-service.js";
import { northDatasetImportActivation } from "../../modules/north/data/import-activation-service.js";
import { northDatasetQuery } from "../../modules/north/data/query-service.js";
import { datasetQuerySchema } from "../../modules/north/data/query-contract.js";

export async function northDataRoutes(app: FastifyInstance) {
  const datasetParams = s.orgParams.extend({ datasetId: s.id });
  const datasetGroupParams = s.orgParams.extend({ groupId: s.id });
  const groupMetadata = z.object({
    slug: z.string().trim().min(1).max(64),
    name: s.localizedText,
    description: s.localizedText.nullable().optional(),
    category: z.string().trim().min(1).max(64).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    metadata: z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= 8192, "metadata too large").optional(),
  }).strict();
  const groupUpdate = groupMetadata.partial().extend({ status: s.northDatasetGroupStatus.optional() }).strict()
    .refine((value) => Object.keys(value).length > 0);
  const datasetFieldParams = datasetParams.extend({ fieldId: s.id });
  const datasetSchemaParams = datasetParams.extend({ schemaVersionId: s.id });
  const datasetAclParams = datasetParams.extend({ aclId: s.id });
  const datasetImportParams = datasetParams.extend({ importId: s.id });
  const datasetImportMappingParams = datasetImportParams.extend({ mappingId: s.id });
  const semanticType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable();
  const datasetMetadata = z.object({
    name: s.localizedText,
    description: s.localizedText.nullable().optional(),
    slug: z.string().trim().min(1).max(64),
  }).strict();
  const datasetUpdate = datasetMetadata.partial().extend({ status: s.northDatasetStatus.optional() })
    .refine((value) => Object.keys(value).length > 0);
  const fieldUpdate = z.object({
    displayName: s.localizedText.optional(),
    description: s.localizedText.nullable().optional(),
    semanticType: semanticType.optional(),
    nullable: z.boolean().optional(),
    status: s.northDatasetFieldStatus.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0);
  const aclInput = z.discriminatedUnion("principalType", [
    z.object({ effect: s.northDatasetAclEffect, principalType: z.literal("ALL_MEMBERS") }).strict(),
    z.object({ effect: s.northDatasetAclEffect, principalType: z.literal("MEMBERSHIP"), membershipId: s.id }).strict(),
    z.object({ effect: s.northDatasetAclEffect, principalType: z.literal("GROUP"), groupId: s.id }).strict(),
    z.object({ effect: s.northDatasetAclEffect, principalType: z.literal("ROLE"), role: s.role }).strict(),
    z.object({ effect: s.northDatasetAclEffect, principalType: z.literal("CAPABILITY"), capability: z.string().min(1).max(128) }).strict(),
  ]);
  const importMappingInput = z.object({
    sheetOrdinal: z.number().int().nonnegative().max(31),
    headerRow: z.literal(1),
    columns: z.array(s.northDatasetImportMappingColumn).min(1).max(150),
    // SKIP_EXACT drops source rows whose mapped values are identical to an earlier row; the count is audited.
    duplicates: z.enum(["KEEP", "SKIP_EXACT"]).default("KEEP"),
  }).strict();
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups", tag: "NORTH dataset groups",
    summary: "List dataset groups with a summary computed only from the datasets the caller may see", params: s.orgParams,
    response: z.array(s.northDatasetGroup),
    run: ({ user, params }) => northDatasetGroups.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/dataset-groups", tag: "NORTH dataset groups",
    summary: "Create a dataset group", params: s.orgParams, body: groupMetadata, response: s.northDatasetGroup, status: 201,
    run: ({ user, params, body }) => northDatasetGroups.create(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId", tag: "NORTH dataset groups",
    summary: "Read a dataset group with its visible member datasets", params: datasetGroupParams, response: s.northDatasetGroupDetail,
    run: ({ user, params }) => northDatasetGroups.read(user.id, params.organizationId, params.groupId),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/dataset-groups/:groupId", tag: "NORTH dataset groups",
    summary: "Edit group metadata, archive or restore it", params: datasetGroupParams, body: groupUpdate, response: s.northDatasetGroup,
    run: ({ user, params, body }) => northDatasetGroups.update(user.id, params.organizationId, params.groupId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/dependencies", tag: "NORTH dataset groups",
    summary: "Exact scope of deleting a group: member datasets, analytics bindings, panels and running imports", params: datasetGroupParams,
    response: z.object({ datasets: z.number().int(), scripts: z.number().int(), bindings: z.number().int(), panels: z.number().int(), runningImports: z.number().int() }),
    run: ({ user, params }) => northDatasetGroups.dependencies(user.id, params.organizationId, params.groupId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/dataset-groups/:groupId", tag: "NORTH dataset groups",
    summary: "Delete an archived group; member datasets are detached, never erased", params: datasetGroupParams,
    query: z.object({ detachDatasets: z.enum(["true", "false"]).default("false") }).strict(), response: z.null(),
    run: ({ user, params, query }) => northDatasetGroups.delete(user.id, params.organizationId, params.groupId, { detachDatasets: query.detachDatasets === "true" }),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/audit", tag: "NORTH dataset groups",
    summary: "Audit history of a group and of its datasets", params: datasetGroupParams,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: s.date.optional() }).strict(),
    response: z.array(z.object({ id: s.id, action: z.string(), actorId: s.id.nullable(), targetType: z.string().nullable(), targetId: z.string().nullable(), requestId: z.string().nullable(), metadata: z.record(z.unknown()), createdAt: s.date })),
    run: ({ user, params, query }) => northDatasetGroups.audit(user.id, params.organizationId, params.groupId, { limit: query.limit, ...(query.before ? { before: new Date(query.before) } : {}) }),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/datasets/:datasetId/group", tag: "NORTH dataset groups",
    summary: "Assign a dataset to a group (or null to detach) and set its covered period; overlapping periods need allowOverlap", params: datasetParams,
    body: z.object({
      groupId: s.id.nullable(), periodStart: s.dateOnly.nullable().optional(), periodEnd: s.dateOnly.nullable().optional(),
      periodLabel: z.string().trim().min(1).max(60).nullable().optional(), allowOverlap: z.boolean().optional(),
    }).strict(),
    response: z.object({ id: s.id, groupId: s.id.nullable(), periodStart: s.dateOnly.nullable(), periodEnd: s.dateOnly.nullable(), periodLabel: z.string().nullable() }),
    run: ({ user, params, body }) => northDatasetGroups.assign(user.id, params.organizationId, params.datasetId, body),
  });
  const pipelineParam = z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), type: z.enum(["string", "number", "boolean", "date"]), required: z.boolean(),
    default: z.union([z.string().max(1024), z.number(), z.boolean()]).optional(), description: z.string().max(200).optional(),
  }).strict();
  const pipelineStep = z.object({ id: z.enum(PIPELINE_STEP_IDS), enabled: z.boolean() }).strict();
  const scriptParams = datasetGroupParams.extend({ scriptId: s.id });
  const pipelineVersion = z.object({ id: s.id, scriptId: s.id, version: z.number().int(), sourceSha256: z.string(), params: z.array(pipelineParam), steps: z.array(pipelineStep), note: z.string().nullable(), createdBy: s.id, createdAt: s.date, source: z.string().optional() });
  const pipelineScript = z.object({ id: s.id, slug: z.string(), name: z.string(), description: z.string().nullable(), language: z.string(), status: s.northDatasetGroupStatus, versions: z.array(pipelineVersion) });
  const pipelineRun = z.object({
    id: s.id, groupId: s.id, datasetId: s.id.nullable(), importId: s.id.nullable(), scriptVersionId: s.id, kind: z.enum(["TEST", "REPROCESS", "IMPORT"]),
    status: z.enum(["QUEUED", "BLOCKED", "RUNNING", "SUCCEEDED", "FAILED"]), params: z.record(z.unknown()), stats: z.record(z.unknown()).nullable(), report: z.record(z.unknown()).nullable(),
    errorCode: z.string().nullable(), requestedBy: s.id, createdAt: s.date, startedAt: s.date.nullable(), finishedAt: s.date.nullable(),
  });
  const groupQueryInput = z.object({ query: datasetQuerySchema, datasetIds: z.array(s.id).max(50).optional(), periodFrom: s.dateOnly.nullable().optional(), periodTo: s.dateOnly.nullable().optional() }).strict();
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/dataset-groups/:groupId/query", tag: "NORTH dataset groups",
    summary: "Query a dataset group as one collection: fields are named by key, results merge the member datasets (aggregates only across several datasets)", params: datasetGroupParams,
    body: groupQueryInput, rateLimit: 30,
    response: z.object({
      mode: z.enum(["ROWS", "AGGREGATE"]), groupId: s.id,
      datasets: z.array(z.object({ id: s.id, slug: z.string(), activeRevisionId: s.id })), skipped: z.array(z.object({ id: s.id, slug: z.string(), reason: z.string() })),
      columns: z.array(z.object({ key: z.string(), type: z.string() })).max(40), rows: z.array(z.record(s.northDatasetQueryScalar)).max(1_000),
      rowCount: z.number().int().nonnegative(), totalRows: z.number().int().nonnegative().optional(), executedAt: s.date,
    }),
    run: ({ user, params, body }) => northDatasetGroupQuery.execute(user.id, params.organizationId, params.groupId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/fields", tag: "NORTH dataset groups",
    summary: "Field keys across the group's datasets: where each exists, type conflicts and gaps between periods", params: datasetGroupParams,
    response: z.object({ datasets: z.array(z.string()), fields: z.array(z.object({ key: z.string(), types: z.array(z.string()), presentIn: z.array(z.string()), missingIn: z.array(z.string()), typeConflict: z.boolean() })) }),
    run: ({ user, params }) => northDatasetGroupQuery.fields(user.id, params.organizationId, params.groupId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/pipeline", tag: "NORTH pipelines",
    summary: "Scripts, versions and the published pipeline of a group; execution stays disabled until an isolated runner is configured", params: datasetGroupParams,
    response: z.object({ runnerEnabled: z.boolean(), activeScriptVersionId: s.id.nullable(), scripts: z.array(pipelineScript) }),
    run: ({ user, params }) => northPipelines.overview(user.id, params.organizationId, params.groupId),
  });
  contract(app, {
    method: "PUT", url: "/organizations/:organizationId/dataset-groups/:groupId/pipeline", tag: "NORTH pipelines",
    summary: "Publish a script version as the group's pipeline (re-publishing an older version is the rollback); null unpublishes", params: datasetGroupParams,
    body: z.object({ scriptVersionId: s.id.nullable() }).strict(), response: z.object({ activeScriptVersionId: s.id.nullable() }),
    run: ({ user, params, body }) => northPipelines.publish(user.id, params.organizationId, params.groupId, body.scriptVersionId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/dataset-groups/:groupId/scripts", tag: "NORTH pipelines",
    summary: "Register a pipeline script (source is added as immutable versions)", params: datasetGroupParams,
    body: z.object({ slug: z.string().trim().min(2).max(64), name: z.string().trim().min(2).max(100), description: z.string().max(500).nullable().optional() }).strict(),
    response: pipelineScript, status: 201,
    run: ({ user, params, body }) => northPipelines.createScript(user.id, params.organizationId, params.groupId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/dataset-groups/:groupId/scripts/:scriptId", tag: "NORTH pipelines",
    summary: "Archive or restore a script", params: scriptParams, body: z.object({ status: s.northDatasetGroupStatus }).strict(), response: z.null(),
    run: ({ user, params, body }) => northPipelines.setScriptStatus(user.id, params.organizationId, params.groupId, params.scriptId, body.status),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/dataset-groups/:groupId/scripts/:scriptId/versions", tag: "NORTH pipelines",
    summary: "Save a new immutable version of a script with its declared parameters and stage switches", params: scriptParams,
    body: z.object({ source: z.string().min(1).max(262_144), params: z.array(pipelineParam).max(20), steps: z.array(pipelineStep).max(PIPELINE_STEP_IDS.length), note: z.string().max(300).nullable().optional() }).strict(),
    response: pipelineVersion, status: 201,
    run: ({ user, params, body }) => northPipelines.createVersion(user.id, params.organizationId, params.groupId, params.scriptId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/scripts/:scriptId/versions/:versionId", tag: "NORTH pipelines",
    summary: "Read one version including its source", params: scriptParams.extend({ versionId: s.id }), response: pipelineVersion,
    run: ({ user, params }) => northPipelines.readVersion(user.id, params.organizationId, params.groupId, params.scriptId, params.versionId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/dataset-groups/:groupId/pipeline/runs", tag: "NORTH pipelines",
    summary: "Record a TEST or REPROCESS run of a script version; BLOCKED (nothing executes) while no isolated runner is configured", params: datasetGroupParams,
    body: z.object({ scriptVersionId: s.id.optional(), datasetId: s.id.nullable().optional(), kind: z.enum(["TEST", "REPROCESS"]), params: z.record(z.unknown()).default({}) }).strict(),
    response: pipelineRun, status: 201, rateLimit: 20,
    run: ({ user, params, body }) => northPipelines.run(user.id, params.organizationId, params.groupId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/dataset-groups/:groupId/pipeline/runs", tag: "NORTH pipelines",
    summary: "Run history: which script version, parameters and outcome processed each dataset", params: datasetGroupParams,
    query: z.object({ datasetId: s.id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict(), response: z.array(pipelineRun),
    run: ({ user, params, query }) => northPipelines.runs(user.id, params.organizationId, params.groupId, query),
  });
  const partParams = datasetImportParams.extend({ partNumber: z.coerce.number().int().min(1).max(10_000) });
  const multipartState = z.object({ partSize: z.number().int(), partCount: z.number().int(), uploadedParts: z.array(z.number().int()) });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/multipart", tag: "NORTH data imports",
    summary: "Start (or resume) a resumable multipart upload; returns the part layout and the parts already stored", params: datasetImportParams,
    response: multipartState, status: 201,
    run: ({ user, params }) => northDatasetImports.multipartStart(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/multipart", tag: "NORTH data imports",
    summary: "Parts already stored for a resumable upload", params: datasetImportParams, response: multipartState,
    run: ({ user, params }) => northDatasetImports.multipartState(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/multipart/parts/:partNumber", tag: "NORTH data imports",
    summary: "Short-lived signed URL for one part", params: partParams, response: s.northSignedObjectRequest, rateLimit: 600,
    run: ({ user, params }) => northDatasetImports.multipartSignPart(user.id, params.organizationId, params.datasetId, params.importId, params.partNumber),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/multipart/complete", tag: "NORTH data imports",
    summary: "Assemble the object once every part is stored with its expected size; then call confirm", params: datasetImportParams, response: s.northDatasetImport,
    run: ({ user, params }) => northDatasetImports.multipartComplete(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets", tag: "NORTH data",
    summary: "List up to 100 datasets authorized for the active membership", params: s.orgParams,
    response: z.array(s.northDataset),
    run: ({ user, params }) => northData.list(user.id, params.organizationId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets", tag: "NORTH data",
    summary: "Create a tenant dataset with a safe initial owner ACL", params: s.orgParams,
    body: datasetMetadata, response: s.northDataset, status: 201,
    run: ({ user, params, body }) => northData.create(user.id, params.organizationId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId", tag: "NORTH data",
    summary: "Read one authorized tenant dataset", params: datasetParams, response: s.northDataset,
    run: ({ user, params }) => northData.read(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/datasets/:datasetId", tag: "NORTH data",
    summary: "Update authorized dataset metadata or lifecycle status", params: datasetParams,
    body: datasetUpdate, response: s.northDataset,
    run: ({ user, params, body }) => northData.update(user.id, params.organizationId, params.datasetId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/dependencies", tag: "NORTH data",
    summary: "Count the panel bindings and running imports that depend on a dataset", params: datasetParams,
    response: z.object({ bindings: z.number().int().nonnegative(), panels: z.number().int().nonnegative(), runningImports: z.number().int().nonnegative() }),
    run: ({ user, params }) => northData.dependencies(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/datasets/:datasetId", tag: "NORTH data",
    summary: "Permanently erase an archived dataset that no analytics binding uses", params: datasetParams, response: z.null(),
    run: ({ user, params }) => northData.erase(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/fields", tag: "NORTH data",
    summary: "List stable logical fields for an authorized dataset", params: datasetParams,
    response: z.array(s.northDatasetField),
    run: ({ user, params }) => northData.fields(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/fields", tag: "NORTH data",
    summary: "Create a stable logical dataset field", params: datasetParams,
    body: z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      displayName: s.localizedText,
      description: s.localizedText.nullable().optional(),
      canonicalType: s.northDatasetFieldType,
      semanticType: semanticType.optional(),
      nullable: z.boolean().optional(),
    }).strict(),
    response: s.northDatasetField, status: 201,
    run: ({ user, params, body }) => northData.createField(user.id, params.organizationId, params.datasetId, body),
  });
  contract(app, {
    method: "PATCH", url: "/organizations/:organizationId/datasets/:datasetId/fields/:fieldId", tag: "NORTH data",
    summary: "Update logical field metadata without rewriting schema snapshots", params: datasetFieldParams,
    body: fieldUpdate, response: s.northDatasetField,
    run: ({ user, params, body }) => northData.updateField(user.id, params.organizationId, params.datasetId, params.fieldId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/schema-versions", tag: "NORTH data",
    summary: "List immutable schema snapshots for an authorized dataset", params: datasetParams,
    response: z.array(s.northDatasetSchemaVersion),
    run: ({ user, params }) => northData.schemaVersions(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/schema-versions", tag: "NORTH data",
    summary: "Create and activate an immutable schema snapshot", params: datasetParams,
    body: z.object({
      fields: z.array(z.object({ fieldId: s.id, ordinal: z.number().int().nonnegative() }).strict()).min(1).max(150),
    }).strict(),
    response: s.northDatasetSchemaVersion, status: 201,
    run: ({ user, params, body }) => northData.createSchemaVersion(user.id, params.organizationId, params.datasetId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/schema-versions/:schemaVersionId", tag: "NORTH data",
    summary: "Read one immutable dataset schema snapshot", params: datasetSchemaParams,
    response: s.northDatasetSchemaVersion,
    run: ({ user, params }) => northData.schemaVersion(user.id, params.organizationId, params.datasetId, params.schemaVersionId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/acl", tag: "NORTH data authorization",
    summary: "List dataset ACL rules with explicit deny semantics", params: datasetParams,
    response: z.array(s.northDatasetAcl),
    run: ({ user, params }) => northData.acl(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/acl", tag: "NORTH data authorization",
    summary: "Create a tenant-validated dataset ACL rule", params: datasetParams,
    body: aclInput, response: s.northDatasetAcl, status: 201,
    run: ({ user, params, body }) => northData.createAclRule(user.id, params.organizationId, params.datasetId, body),
  });
  contract(app, {
    method: "DELETE", url: "/organizations/:organizationId/datasets/:datasetId/acl/:aclId", tag: "NORTH data authorization",
    summary: "Delete a dataset ACL rule without locking out every owner", params: datasetAclParams,
    response: z.null(),
    run: async ({ user, params }) => {
      await northData.deleteAclRule(user.id, params.organizationId, params.datasetId, params.aclId);
      return null;
    },
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports", tag: "NORTH data imports",
    summary: "Create or replay an idempotent private XLSX upload session; no parsing occurs in the request",
    params: datasetParams, idempotency: true, rateLimit: 20,
    body: z.object({
      filename: z.string().trim().min(1).max(255),
      mime: z.string().trim().min(1).max(127),
      size: z.number().int().min(1),
      checksum: z.string().regex(/^[0-9a-fA-F]{64}$/),
    }).strict(),
    response: z.object({ import: s.northDatasetImport, upload: s.northSignedObjectRequest }), status: 201,
    run: ({ user, params, body, request }) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(key))
        fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a 16–128 character Idempotency-Key");
      return northDatasetImports.prepare(user.id, params.organizationId, params.datasetId, body, key);
    },
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports", tag: "NORTH data imports",
    summary: "List up to 100 authorized durable import jobs without internal object identifiers",
    params: datasetParams, response: z.array(s.northDatasetImport),
    run: ({ user, params }) => northDatasetImports.list(user.id, params.organizationId, params.datasetId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/purge", tag: "NORTH data imports",
    summary: "Preview (dryRun) or purge failed, cancelled, rejected or abandoned import records that never produced data", params: datasetParams,
    body: z.object({ olderThanDays: z.number().int().min(0).max(3650), dryRun: z.boolean().default(true) }).strict(),
    response: z.object({ matched: z.number().int().nonnegative(), purged: z.number().int().nonnegative(), dryRun: z.boolean() }),
    run: ({ user, params, body }) => northData.purgeImports(user.id, params.organizationId, params.datasetId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId", tag: "NORTH data imports",
    summary: "Read sanitized progress and security-gate state for one authorized import job",
    params: datasetImportParams, response: s.northDatasetImport,
    run: ({ user, params }) => northDatasetImports.read(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/confirm", tag: "NORTH data imports",
    summary: "Verify uploaded XLSX declaration and queue fail-closed security checks; never parse synchronously",
    params: datasetImportParams, response: s.northDatasetImport, status: 202,
    run: ({ user, params }) => northDatasetImports.confirm(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/cancel", tag: "NORTH data imports",
    summary: "Idempotently cancel a waiting import or request cancellation from a claimed worker",
    params: datasetImportParams, response: s.northDatasetImport,
    run: ({ user, params }) => northDatasetImports.cancel(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/analysis", tag: "NORTH data imports",
    summary: "Read bounded workbook analysis after the immutable source has passed security validation", params: datasetImportParams,
    response: s.northDatasetImportAnalysis,
    run: ({ user, params }) => northDatasetImportAnalysis.read(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/mappings", tag: "NORTH data imports",
    summary: "List immutable mapping versions for an authorized analyzed import", params: datasetImportParams,
    response: z.array(s.northDatasetImportMapping),
    run: ({ user, params }) => northDatasetImportAnalysis.listMappings(user.id, params.organizationId, params.datasetId, params.importId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/mappings", tag: "NORTH data imports",
    summary: "Create an immutable explicit mapping version; this does not activate data", params: datasetImportParams,
    body: importMappingInput, response: s.northDatasetImportMapping, status: 201,
    run: ({ user, params, body }) => northDatasetImportAnalysis.createMapping(user.id, params.organizationId, params.datasetId, params.importId, body),
  });
  contract(app, {
    method: "GET", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/mappings/:mappingId", tag: "NORTH data imports",
    summary: "Read one immutable authorized mapping version", params: datasetImportMappingParams,
    response: s.northDatasetImportMapping,
    run: ({ user, params }) => northDatasetImportAnalysis.readMapping(user.id, params.organizationId, params.datasetId, params.importId, params.mappingId),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/imports/:importId/activate", tag: "NORTH data imports",
    summary: "Queue asynchronous materialization and atomic activation: REPLACE_DATASET swaps the data, APPEND adds a period (needs periodStart/periodEnd; refuses duplicate files and overlapping periods)", params: datasetImportParams,
    body: z.object({ mappingId: s.id, mode: z.enum(["REPLACE_DATASET", "APPEND"]), periodStart: s.dateOnly.nullable().optional(), periodEnd: s.dateOnly.nullable().optional() }).strict()
      .refine((value) => value.mode === "REPLACE_DATASET" || Boolean(value.periodStart && value.periodEnd), { message: "APPEND needs periodStart and periodEnd" }),
    response: s.northDatasetImport, status: 202,
    run: ({ user, params, body }) => northDatasetImportActivation.activate(user.id, params.organizationId, params.datasetId, params.importId, body),
  });
  contract(app, {
    method: "POST", url: "/organizations/:organizationId/datasets/:datasetId/query", tag: "NORTH data queries",
    summary: "Execute a bounded tenant-authorized query against the active immutable revision", params: datasetParams,
    body: datasetQuerySchema, response: s.northDatasetQueryResult, rateLimit: 30,
    run: ({ user, params, body }) => northDatasetQuery.execute(user.id, params.organizationId, params.datasetId, body),
  });
}
