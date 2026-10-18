import { createHash } from "node:crypto";
import { Prisma, type NorthPipelineRunKind } from "../../../lib/database.js";
import { DomainError, fail } from "../../../shared/errors.js";
import { transaction, type Transaction } from "../../../shared/transaction.js";
import { auditRepository as audit } from "../../audit/repository.js";
import type { NorthCapability } from "../../authorization/policy.js";
import { validateNorthSlug } from "../slug.js";
import { requireOrganizationDataCapability } from "./authorization.js";
import { currentPipelineRunner } from "./pipeline-runner.js";

/** The stages of the reference pipeline. A version lists them in order and may switch each one off. */
export const PIPELINE_STEP_IDS = [
  "receive", "validate_schema", "normalize_columns", "clean_values", "normalize_dates_currencies", "detect_duplicates",
  "validate_rules", "quality_report", "import", "publish", "audit",
] as const;
export type PipelineStep = { id: (typeof PIPELINE_STEP_IDS)[number]; enabled: boolean };
export type PipelineParam = { name: string; type: "string" | "number" | "boolean" | "date"; required: boolean; default?: string | number | boolean | null; description?: string };
export const MAX_SOURCE_BYTES = 256 * 1024;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

function checkParams(declared: PipelineParam[]) {
  const names = new Set<string>();
  for (const param of declared) {
    if (names.has(param.name)) fail(422, "PIPELINE_PARAM_DUPLICATE", "Parameter names must be unique");
    names.add(param.name);
    if (param.default != null && !matchesType(param, param.default)) fail(422, "PIPELINE_PARAM_INVALID", "Default does not match the parameter type");
  }
}
function matchesType(param: PipelineParam, value: unknown) {
  if (param.type === "string") return typeof value === "string" && value.length <= 1024;
  if (param.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (param.type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && dateOnly.test(value);
}
/** Only declared parameters are accepted; unknown names, wrong types and missing required values are refused. */
export function resolveParams(declared: PipelineParam[], given: Record<string, unknown>) {
  const known = new Set(declared.map((param) => param.name));
  const extra = Object.keys(given).find((name) => !known.has(name));
  if (extra) throw new DomainError(422, "PIPELINE_PARAM_UNKNOWN", "Parameter is not declared by this script version", { name: extra });
  const resolved: Record<string, unknown> = {};
  for (const param of declared) {
    const value = given[param.name] ?? param.default ?? null;
    if (value === null) { if (param.required) throw new DomainError(422, "PIPELINE_PARAM_REQUIRED", "A required parameter is missing", { name: param.name }); continue; }
    if (!matchesType(param, value)) throw new DomainError(422, "PIPELINE_PARAM_INVALID", "Parameter has the wrong type", { name: param.name });
    resolved[param.name] = value;
  }
  return resolved;
}

function checkSteps(steps: PipelineStep[]) {
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) fail(422, "PIPELINE_STEP_DUPLICATE", "Each pipeline stage may appear once");
}

async function group(tx: Transaction, organizationId: string, groupId: string) {
  const found = await tx.northDatasetGroup.findFirst({ where: { id: groupId, organizationId } });
  if (!found) fail(404, "NOT_FOUND", "Dataset group not found");
  return found;
}
async function script(tx: Transaction, organizationId: string, groupId: string, scriptId: string) {
  const found = await tx.northPipelineScript.findFirst({ where: { id: scriptId, groupId, organizationId } });
  if (!found) fail(404, "NOT_FOUND", "Script not found");
  return found;
}
const require = (tx: Transaction, userId: string, organizationId: string, capability: NorthCapability) => requireOrganizationDataCapability(tx, userId, organizationId, capability);

const versionView = (v: { id: string; scriptId: string; version: number; sourceSha256: string; params: Prisma.JsonValue; steps: Prisma.JsonValue; note: string | null; createdBy: string; createdAt: Date; source?: string }) =>
  ({ id: v.id, scriptId: v.scriptId, version: v.version, sourceSha256: v.sourceSha256, params: v.params as PipelineParam[], steps: v.steps as PipelineStep[], note: v.note, createdBy: v.createdBy, createdAt: v.createdAt.toISOString(), ...(v.source !== undefined ? { source: v.source } : {}) });
const runView = (r: { id: string; groupId: string; datasetId: string | null; importId: string | null; scriptVersionId: string; kind: string; status: string; params: Prisma.JsonValue; stats: Prisma.JsonValue | null; report: Prisma.JsonValue | null; errorCode: string | null; requestedBy: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null }) =>
  ({ ...r, params: r.params as Record<string, unknown>, stats: r.stats as Record<string, unknown> | null, report: r.report as Record<string, unknown> | null, createdAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null });

export const northPipelines = {
  /** Scripts of a group with their versions (source included only for callers who may write scripts). */
  async overview(userId: string, organizationId: string, groupId: string) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.manage");
      const owner = await group(tx, organizationId, groupId);
      const scripts = await tx.northPipelineScript.findMany({ where: { groupId, organizationId }, orderBy: { createdAt: "asc" }, include: { versions: { orderBy: { version: "desc" }, take: 50 } } });
      return {
        runnerEnabled: currentPipelineRunner().enabled,
        activeScriptVersionId: owner.activeScriptVersionId,
        scripts: scripts.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, language: s.language, status: s.status, versions: s.versions.map((v) => versionView(v)) })),
      };
    });
  },

  readVersion(userId: string, organizationId: string, groupId: string, scriptId: string, versionId: string) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.write");
      await script(tx, organizationId, groupId, scriptId);
      const version = await tx.northPipelineScriptVersion.findFirst({ where: { id: versionId, scriptId, organizationId } });
      if (!version) fail(404, "NOT_FOUND", "Script version not found");
      return versionView(version);
    });
  },

  createScript(userId: string, organizationId: string, groupId: string, input: { slug: string; name: string; description?: string | null }) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.write");
      await group(tx, organizationId, groupId);
      const slug = validateNorthSlug(input.slug, false);
      if (slug.error) fail(422, slug.error, "Script slug is unavailable");
      try {
        const created = await tx.northPipelineScript.create({ data: { organizationId, groupId, slug: slug.slug, name: input.name, description: input.description ?? null, createdBy: userId } });
        await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_PIPELINE_SCRIPT_CREATED", targetType: "NorthPipelineScript", targetId: created.id, metadata: { groupId, scriptId: created.id, slug: created.slug } });
        return { id: created.id, slug: created.slug, name: created.name, description: created.description, language: created.language, status: created.status, versions: [] };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") fail(409, "PIPELINE_SCRIPT_CONFLICT", "A script with this slug already exists in the group");
        throw error;
      }
    });
  },

  setScriptStatus(userId: string, organizationId: string, groupId: string, scriptId: string, status: "ACTIVE" | "ARCHIVED") {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.write");
      const owner = await group(tx, organizationId, groupId);
      const current = await script(tx, organizationId, groupId, scriptId);
      if (status === "ARCHIVED" && owner.activeScriptVersionId) {
        const active = await tx.northPipelineScriptVersion.findFirst({ where: { id: owner.activeScriptVersionId, scriptId } });
        if (active) fail(409, "PIPELINE_SCRIPT_ACTIVE", "Unpublish the group's pipeline before archiving its active script");
      }
      await tx.northPipelineScript.update({ where: { id: current.id }, data: { status } });
      await audit.append(tx, { actorId: userId, organizationId, action: status === "ARCHIVED" ? "NORTH_PIPELINE_SCRIPT_ARCHIVED" : "NORTH_PIPELINE_SCRIPT_RESTORED", targetType: "NorthPipelineScript", targetId: scriptId, metadata: { groupId, scriptId } });
      return null;
    });
  },

  /** Every save is a new immutable version; the previous source stays readable and can be re-published (rollback). */
  createVersion(userId: string, organizationId: string, groupId: string, scriptId: string, input: { source: string; params: PipelineParam[]; steps: PipelineStep[]; note?: string | null }) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.write");
      await group(tx, organizationId, groupId);
      const owner = await script(tx, organizationId, groupId, scriptId);
      if (owner.status !== "ACTIVE") fail(409, "PIPELINE_SCRIPT_ARCHIVED", "Restore the script before adding versions");
      if (Buffer.byteLength(input.source, "utf8") > MAX_SOURCE_BYTES) fail(422, "PIPELINE_SOURCE_TOO_LARGE", "Script source is limited to 256 KiB");
      if (input.source.includes("\u0000")) fail(422, "PIPELINE_SOURCE_INVALID", "Script source cannot contain NUL bytes");
      checkParams(input.params);
      checkSteps(input.steps);
      const next = ((await tx.northPipelineScriptVersion.aggregate({ where: { scriptId }, _max: { version: true } }))._max.version ?? 0) + 1;
      const created = await tx.northPipelineScriptVersion.create({ data: { organizationId, scriptId, version: next, source: input.source, sourceSha256: sha(input.source), params: input.params as unknown as Prisma.InputJsonValue, steps: input.steps as unknown as Prisma.InputJsonValue, note: input.note ?? null, createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_PIPELINE_VERSION_CREATED", targetType: "NorthPipelineScriptVersion", targetId: created.id, metadata: { groupId, scriptId, version: next, sourceSha256: created.sourceSha256 } });
      return versionView(created);
    });
  },

  /** Publish = make a version the group's active pipeline. Re-publishing an older version is the rollback. null unpublishes. */
  publish(userId: string, organizationId: string, groupId: string, scriptVersionId: string | null) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.publish");
      const owner = await group(tx, organizationId, groupId);
      let scriptId: string | null = null;
      if (scriptVersionId) {
        const version = await tx.northPipelineScriptVersion.findFirst({ where: { id: scriptVersionId, organizationId, script: { groupId, status: "ACTIVE" } } });
        if (!version) fail(404, "NOT_FOUND", "Script version not found in this group");
        scriptId = version.scriptId;
      }
      await tx.northDatasetGroup.update({ where: { id: groupId }, data: { activeScriptVersionId: scriptVersionId } });
      await audit.append(tx, { actorId: userId, organizationId, action: scriptVersionId ? "NORTH_PIPELINE_PUBLISHED" : "NORTH_PIPELINE_UNPUBLISHED", targetType: "NorthDatasetGroup", targetId: groupId, metadata: { groupId, scriptId, scriptVersionId, previousScriptVersionId: owner.activeScriptVersionId } });
      return { activeScriptVersionId: scriptVersionId };
    });
  },

  /**
   * Records a run of an exact script version. While no isolated runner is configured the run is stored as BLOCKED and nothing executes:
   * scripts are untrusted code and never run inside this process.
   */
  run(userId: string, organizationId: string, groupId: string, input: { scriptVersionId?: string; datasetId?: string | null; kind: NorthPipelineRunKind; params: Record<string, unknown> }) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.script.run");
      const owner = await group(tx, organizationId, groupId);
      const versionId = input.scriptVersionId ?? owner.activeScriptVersionId;
      if (!versionId) fail(409, "PIPELINE_NOT_PUBLISHED", "The group has no published pipeline");
      const version = await tx.northPipelineScriptVersion.findFirst({ where: { id: versionId, organizationId, script: { groupId } } });
      if (!version) fail(404, "NOT_FOUND", "Script version not found in this group");
      if (input.kind === "REPROCESS" && !input.datasetId) fail(422, "PIPELINE_DATASET_REQUIRED", "Reprocessing needs a dataset");
      if (input.datasetId && !(await tx.northDataset.findFirst({ where: { id: input.datasetId, organizationId, groupId } }))) fail(404, "NOT_FOUND", "Dataset not found in this group");
      const params = resolveParams(version.params as unknown as PipelineParam[], input.params);
      const runner = currentPipelineRunner();
      const created = await tx.northPipelineRun.create({ data: { organizationId, groupId, datasetId: input.datasetId ?? null, scriptVersionId: versionId, kind: input.kind, params: params as Prisma.InputJsonValue, requestedBy: userId, status: runner.enabled ? "RUNNING" : "BLOCKED", startedAt: runner.enabled ? new Date() : null, finishedAt: runner.enabled ? null : new Date(), errorCode: runner.enabled ? null : "PIPELINE_SANDBOX_UNAVAILABLE" } });
      let final = created;
      if (runner.enabled) {
        // ponytail: runs inline; the real isolated runner is a queued worker, move this call there when it exists.
        try {
          const outcome = await runner.run({ source: version.source, sourceSha256: version.sourceSha256, params, steps: version.steps as unknown as PipelineStep[], datasetId: input.datasetId ?? null, kind: input.kind });
          final = await tx.northPipelineRun.update({ where: { id: created.id }, data: { status: "SUCCEEDED", stats: outcome.stats as Prisma.InputJsonValue, report: outcome.report as Prisma.InputJsonValue, finishedAt: new Date() } });
        } catch (error) {
          final = await tx.northPipelineRun.update({ where: { id: created.id }, data: { status: "FAILED", errorCode: error instanceof DomainError ? error.code : "PIPELINE_RUN_FAILED", finishedAt: new Date() } });
        }
      }
      await audit.append(tx, { actorId: userId, organizationId, action: "NORTH_PIPELINE_RUN_RECORDED", targetType: "NorthPipelineRun", targetId: created.id, metadata: { groupId, datasetId: input.datasetId ?? null, scriptVersionId: versionId, sourceSha256: version.sourceSha256, kind: input.kind, status: final.status, errorCode: final.errorCode } });
      return runView(final);
    });
  },

  runs(userId: string, organizationId: string, groupId: string, query: { datasetId?: string; limit: number }) {
    return transaction(async (tx) => {
      await require(tx, userId, organizationId, "north.data.manage");
      await group(tx, organizationId, groupId);
      const rows = await tx.northPipelineRun.findMany({ where: { organizationId, groupId, ...(query.datasetId ? { datasetId: query.datasetId } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: query.limit });
      return rows.map(runView);
    });
  },
};
