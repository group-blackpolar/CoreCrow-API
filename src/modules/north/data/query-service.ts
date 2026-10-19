import { Prisma, type NorthDatasetFieldType } from "../../../lib/database.js";
import { fail } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { authorizeDataset } from "./authorization.js";
import type { Transaction } from "../../../shared/transaction.js";
import type { DatasetQuery } from "./query-contract.js";

type Scalar = string | number | boolean | null;
type Filter = NonNullable<DatasetQuery["filters"]>[number];

type Field = { datasetFieldId: string; canonicalType: NorthDatasetFieldType };
type ResultColumn = { key: string; fieldId?: string; type: NorthDatasetFieldType };

function text(fieldId: string) { return Prisma.sql`r."values" ->> ${fieldId}`; }
function typed(field: Field) {
  const value = text(field.datasetFieldId);
  if (field.canonicalType === "INTEGER" || field.canonicalType === "DECIMAL") return Prisma.sql`NULLIF(${value}, '')::numeric`;
  if (field.canonicalType === "BOOLEAN") return Prisma.sql`NULLIF(${value}, '')::boolean`;
  if (field.canonicalType === "DATE") return Prisma.sql`NULLIF(${value}, '')::date`;
  if (field.canonicalType === "DATETIME") return Prisma.sql`NULLIF(${value}, '')::timestamptz`;
  if (field.canonicalType === "TIME") return Prisma.sql`NULLIF(${value}, '')::time`;
  return value;
}

function filterValue(field: Field, value: Exclude<Scalar, null>): Prisma.Sql {
  if (field.canonicalType === "TEXT") {
    if (typeof value !== "string") fail(422, "DATASET_QUERY_FILTER_INVALID", "Text filters require a string value");
    return Prisma.sql`${value}`;
  }
  if (field.canonicalType === "BOOLEAN") {
    if (typeof value !== "boolean") fail(422, "DATASET_QUERY_FILTER_INVALID", "Boolean filters require a boolean value");
    return Prisma.sql`${value}::boolean`;
  }
  if (field.canonicalType === "INTEGER") {
    if ((typeof value !== "number" || !Number.isSafeInteger(value)) && (typeof value !== "string" || !/^-?\d+$/.test(value))) fail(422, "DATASET_QUERY_FILTER_INVALID", "Integer filter is invalid");
    return Prisma.sql`${String(value)}::numeric`;
  }
  if (field.canonicalType === "DECIMAL") {
    if ((typeof value !== "number" || !Number.isFinite(value)) && (typeof value !== "string" || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value))) fail(422, "DATASET_QUERY_FILTER_INVALID", "Decimal filter is invalid");
    return Prisma.sql`${String(value)}::numeric`;
  }
  if (typeof value !== "string") fail(422, "DATASET_QUERY_FILTER_INVALID", "Date and time filters require an ISO string");
  const valid = field.canonicalType === "DATE" ? /^\d{4}-\d{2}-\d{2}$/.test(value) : field.canonicalType === "TIME" ? /^\d{2}:\d{2}(?::\d{2})?$/.test(value) : !Number.isNaN(Date.parse(value));
  if (!valid) fail(422, "DATASET_QUERY_FILTER_INVALID", "Date or time filter is invalid");
  if (field.canonicalType === "DATE") return Prisma.sql`${value}::date`;
  if (field.canonicalType === "TIME") return Prisma.sql`${value}::time`;
  return Prisma.sql`${value}::timestamptz`;
}

function filterSql(filter: Filter, field: Field, expression: Prisma.Sql = typed(field)) {
  if (filter.operator === "IN") {
    if (!Array.isArray(filter.value)) fail(422, "DATASET_QUERY_FILTER_INVALID", "IN requires a list value");
    return Prisma.sql`${expression} IN (${Prisma.join(filter.value.map((item) => filterValue(field, item)))})`;
  }
  if (Array.isArray(filter.value)) fail(422, "DATASET_QUERY_FILTER_INVALID", "Only IN accepts a list value");
  if (filter.operator === "CONTAINS") {
    if (field.canonicalType !== "TEXT" || typeof filter.value !== "string") fail(422, "DATASET_QUERY_FILTER_INVALID", "CONTAINS requires a text field and value");
    return Prisma.sql`${expression} ILIKE ${`%${filter.value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`} ESCAPE '\\'`;
  }
  if (filter.value === null) return filter.operator === "EQ" ? Prisma.sql`${expression} IS NULL` : filter.operator === "NE" ? Prisma.sql`${expression} IS NOT NULL` : fail(422, "DATASET_QUERY_FILTER_INVALID", "Null supports only EQ or NE");
  const operator = ({ EQ: "=", NE: "<>", GT: ">", GTE: ">=", LT: "<", LTE: "<=" } as const)[filter.operator as "EQ"];
  return Prisma.sql`${expression} ${Prisma.raw(operator)} ${filterValue(field, filter.value)}`;
}

function jsonScalar(value: unknown): Scalar {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  return String(value);
}

/** PostgreSQL cancels a query that exceeds the statement timeout (SQLSTATE 57014): report it as a retryable, stable error. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  try { return await work; } catch (error) {
    const meta = (error as { meta?: { code?: string; message?: string } }).meta;
    if (meta?.code === "57014" || /statement timeout|canceling statement/i.test(String(meta?.message ?? (error as Error).message))) fail(503, "DATASET_QUERY_TIMEOUT", "The query took too long; narrow the filters or try again");
    throw error;
  }
}

/** Statement timeout for analytical reads. The interactive transaction gets headroom so PostgreSQL's cancel (503) wins over Prisma's own 5 s default. */
const configured = Number(process.env.NORTH_DATASET_QUERY_TIMEOUT_MS);
export const DATASET_QUERY_TIMEOUT_MS = Number.isFinite(configured) && configured > 0 ? Math.min(Math.max(configured, 1_000), 120_000) : 30_000;
/** Per-query memory for sorts and hashes (SET LOCAL, so it ends with the read transaction). The projected rows are small; 64 MB keeps them in memory. */
const workMem = Number(process.env.NORTH_DATASET_QUERY_WORK_MEM_MB);
export const DATASET_QUERY_WORK_MEM_MB = Number.isFinite(workMem) && workMem > 0 ? Math.min(Math.max(Math.round(workMem), 4), 512) : 64;
export const readTransaction = { isolationLevel: "ReadCommitted" as const, timeoutMilliseconds: DATASET_QUERY_TIMEOUT_MS + 5_000 };

/** A dashboard fires a dozen heavy aggregates at once; running them all together makes every one miss the timeout. Excess waits here, outside any transaction. */
const MAX_CONCURRENT = 4;
let running = 0;
const waiting: Array<() => void> = [];
export async function gated<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try { return await work(); } finally { running -= 1; waiting.shift()?.(); }
}

export const northDatasetQuery = {
  execute(userId: string, organizationId: string, datasetId: string, query: DatasetQuery) {
    return gated(() => transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.query");
      return executeDatasetQuery(tx, organizationId, datasetId, query);
    }, readTransaction));
  },
};

/**
 * Result cache. A revision is immutable, so (org, dataset, active revision, query) fully determines the result: a new import
 * activates a new revision id and old entries are simply never hit again. Callers authorize BEFORE calling, so a hit leaks nothing.
 * Concurrent identical queries share one execution. In-process only (ponytail: per-container; Redis if several API replicas matter).
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_ROWS = 2_000;
const resultCache = new Map<string, { at: number; value: Promise<unknown> }>();

export async function executeDatasetQuery(tx: Transaction, organizationId: string, datasetId: string, query: DatasetQuery) {
  const active = await tx.northDataset.findFirst({ where: { id: datasetId, organizationId, status: "ACTIVE" }, select: { activeRevisionId: true } });
  if (!active?.activeRevisionId) return executeDatasetQueryUncached(tx, organizationId, datasetId, query);
  const key = `${organizationId}|${datasetId}|${active.activeRevisionId}|${JSON.stringify(query)}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as ReturnType<typeof executeDatasetQueryUncached>;
  const value = executeDatasetQueryUncached(tx, organizationId, datasetId, query);
  resultCache.set(key, { at: Date.now(), value });
  if (resultCache.size > CACHE_MAX_ENTRIES) resultCache.delete(resultCache.keys().next().value!);
  value.then((result) => { if ((result as { rows?: unknown[] }).rows!.length > CACHE_MAX_ROWS) resultCache.delete(key); }, () => resultCache.delete(key));
  return value;
}

async function executeDatasetQueryUncached(tx: Transaction, organizationId: string, datasetId: string, query: DatasetQuery) {
      const dataset = await tx.northDataset.findFirst({ where: { id: datasetId, organizationId, status: "ACTIVE" }, include: { activeRevision: { include: { schemaVersion: { include: { fields: true } } } } } });
      if (!dataset?.activeRevision) fail(409, "DATASET_REVISION_NOT_ACTIVE", "Dataset has no active revision");
      const revision = dataset.activeRevision;
      const fields = new Map(revision.schemaVersion.fields.filter((field) => field.status === "ACTIVE").map((field) => [field.datasetFieldId, field]));
      const searchFields = query.search?.fieldIds ?? [];
      const requested = query.mode === "ROWS" ? [...query.fields, ...(query.orderBy ?? []).map((item) => item.fieldId), ...(query.filters ?? []).map((item) => item.fieldId), ...searchFields] : [...(query.groupBy ?? []), ...query.measures.flatMap((item) => [...(item.fieldId ? [item.fieldId] : []), ...(item.distinctBy ? [item.distinctBy] : []), ...(item.when ?? []).map((condition) => condition.fieldId)]), ...(query.filters ?? []).map((item) => item.fieldId), ...searchFields];
      if (requested.some((id) => !fields.has(id))) fail(422, "DATASET_QUERY_FIELD_INVALID", "Query references a field outside the active schema");
      if (searchFields.some((id) => fields.get(id)!.canonicalType !== "TEXT")) fail(422, "DATASET_QUERY_SEARCH_INVALID", "Search is only available on text fields");
      const filters = (query.filters ?? []).map((item) => filterSql(item, fields.get(item.fieldId)!));
      if (query.search) {
        const pattern = `%${query.search.text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        filters.push(Prisma.sql`(${Prisma.join(searchFields.map((id) => Prisma.sql`${typed(fields.get(id)!)} ILIKE ${pattern} ESCAPE '\\'`), " OR ")})`);
      }
      const where = Prisma.sql`rb."revisionId" = ${revision.id} AND rb."organizationId" = ${organizationId} AND rb."datasetId" = ${datasetId}${filters.length ? Prisma.sql` AND ${Prisma.join(filters, " AND ")}` : Prisma.empty}`;
      await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = ${Prisma.raw(`'${DATASET_QUERY_TIMEOUT_MS}ms'`)}`);
      await tx.$executeRaw(Prisma.sql`SET LOCAL work_mem = ${Prisma.raw(`'${DATASET_QUERY_WORK_MEM_MB}MB'`)}`);
      if (query.mode === "ROWS") {
        const pairs = query.fields.flatMap((fieldId) => [Prisma.sql`${fieldId}`, Prisma.sql`r."values" -> ${fieldId}`]);
        const ordering = (query.orderBy ?? []).map((item) => Prisma.sql`${typed(fields.get(item.fieldId)!)} ${Prisma.raw(item.direction)}`);
        ordering.push(Prisma.sql`r."ordinal" ASC`, Prisma.sql`r."id" ASC`);
        const limit = query.limit ?? 100;
        const offset = query.offset ?? 0;
        const rows = await bounded(tx.$queryRaw<Array<{ data: Record<string, Scalar>; total?: bigint }>>(Prisma.sql`
          SELECT jsonb_build_object(${Prisma.join(pairs)}) AS data${query.includeTotal ? Prisma.sql`, COUNT(*) OVER() AS total` : Prisma.empty}
          FROM "NorthDatasetRevisionBatch" rb
          JOIN "NorthDatasetRow" r ON r."batchId" = rb."batchId" AND r."datasetId" = rb."datasetId" AND r."organizationId" = rb."organizationId"
          WHERE ${where}
          ORDER BY ${Prisma.join(ordering)} LIMIT ${limit} OFFSET ${offset}`));
        const columns: ResultColumn[] = query.fields.map((fieldId) => ({ key: fieldId, fieldId, type: fields.get(fieldId)!.canonicalType }));
        return { mode: "ROWS" as const, datasetId, activeRevisionId: revision.id, schemaVersionId: revision.schemaVersionId, columns, rows: rows.map((row) => row.data), rowCount: rows.length, ...(query.includeTotal ? { totalRows: rows.length ? Number(rows[0]!.total) : offset === 0 ? 0 : await countRows(tx, where) } : {}), executedAt: new Date() };
      }
      const groups = query.groupBy ?? [];
      const granularity = query.granularity ?? {};
      // Aggregates read a handful of the 26 JSON keys, but a plain GROUP BY over the table drags every full row (~1.5 kB) through
      // the sort. The referenced fields are projected ONCE into a MATERIALIZED CTE (a few short columns per row) and everything
      // else runs on it: the same result, ~4x faster on the 193k-row SHARK dataset (measured, see docs/master-house-performance.md).
      const used = [...new Set([...groups, ...query.measures.flatMap((measure) => [measure.fieldId, measure.distinctBy, ...(measure.when ?? []).map((condition) => condition.fieldId)]).filter((id): id is string => Boolean(id))])];
      const column = (id: string) => Prisma.raw(`"c${used.indexOf(id)}"`);
      const bucketed = (id: string, source: Prisma.Sql) => {
        const field = fields.get(id)!;
        const unit = granularity[id];
        if (!unit) return source;
        if (field.canonicalType !== "DATE" && field.canonicalType !== "DATETIME") fail(422, "DATASET_QUERY_GRANULARITY_INVALID", "Granularity requires a date or datetime field");
        if (unit === "MONTH_OF_YEAR") return Prisma.sql`date_part('month', ${source})::int`;
        const bucket = Prisma.sql`date_trunc(${({ DAY: "day", MONTH: "month", QUARTER: "quarter", YEAR: "year" } as const)[unit as "DAY"]}, ${source})`;
        return field.canonicalType === "DATE" ? Prisma.sql`${bucket}::date` : bucket;
      };
      // A conditional measure: SQL FILTER over the same projected columns, so the conditions use the field types of the schema.
      // A conditional COUNT with no matching rows is NULL, not 0: a month or year without data is a gap in a chart and a dash in a pivot, not a real zero.
      const withWhen = (aggregate: Prisma.Sql, measure: { when?: Filter[]; operation?: string }) => {
        if (!measure.when?.length) return aggregate;
        const filtered = Prisma.sql`${aggregate} FILTER (WHERE ${Prisma.join(measure.when.map((condition) => filterSql(condition, fields.get(condition.fieldId)!, column(condition.fieldId))), " AND ")})`;
        return measure.operation === "COUNT" || measure.operation === "COUNT_DISTINCT" ? Prisma.sql`NULLIF(${filtered}, 0)` : filtered;
      };
      const rawGroupExpressions = groups.map((id) => bucketed(id, typed(fields.get(id)!)));
      const groupExpressions = groups.map((id) => bucketed(id, column(id)));
      const groupPositions = groups.map((_, index) => Prisma.raw(String(index + 1)));
      // SUM ... distinctBy: the value belongs to the key (e.g. a Master BL's TEUs) and is repeated on its rows, but is often BLANK
      // on some of them (SHARK: a third of the rows). So each (group, key) contributes the MAX of its rows, counted once.
      const distinctMeasures = query.measures.flatMap((measure, index) => (measure.distinctBy && measure.fieldId ? [{ index, key: measure.distinctBy, field: measure.fieldId }] : []));
      const projection: Prisma.Sql[] = used.map((id, index) => Prisma.sql`${typed(fields.get(id)!)} AS ${Prisma.raw(`"c${index}"`)}`);
      for (const { index, key } of distinctMeasures) projection.push(Prisma.sql`COALESCE(${typed(fields.get(key)!)}::text, r."id"::text) AS ${Prisma.raw(`"k${index}"`)}`);
      if (distinctMeasures.length) projection.push(Prisma.sql`r."id" AS "rid"`);
      if (!projection.length) projection.push(Prisma.sql`1 AS "one"`);
      const ranks = distinctMeasures.flatMap(({ index, field }) => {
        const window = Prisma.sql`(PARTITION BY ${Prisma.join([...groupExpressions, Prisma.raw(`"k${index}"`)], ", ")} ORDER BY "rid" ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)`;
        return [Prisma.sql`max(${column(field)}) OVER ${window} AS ${Prisma.raw(`"__v${index}"`)}`, Prisma.sql`row_number() OVER ${window} AS ${Prisma.raw(`"__rn${index}"`)}`];
      });
      const selects: Prisma.Sql[] = groupExpressions.map((expression, index) => Prisma.sql`${expression} AS ${Prisma.raw(`"g${index}"`)}`);
      for (const [index, measure] of query.measures.entries()) {
        const alias = Prisma.raw(`"m${index}"`);
        if (measure.operation === "COUNT" && !measure.fieldId) selects.push(Prisma.sql`${withWhen(Prisma.sql`COUNT(*)`, measure)} AS ${alias}`);
        else {
          if (!measure.fieldId) fail(422, "DATASET_QUERY_MEASURE_INVALID", "Measure requires a field");
          const field = fields.get(measure.fieldId)!;
          const expression = measure.distinctBy ? Prisma.raw(`"__v${index}"`) : column(measure.fieldId);
          if (["SUM", "AVG"].includes(measure.operation) && !["INTEGER", "DECIMAL"].includes(field.canonicalType)) fail(422, "DATASET_QUERY_MEASURE_INVALID", "SUM and AVG require numeric fields");
          if (["MIN", "MAX"].includes(measure.operation) && field.canonicalType === "BOOLEAN") fail(422, "DATASET_QUERY_MEASURE_INVALID", "MIN and MAX do not support boolean fields");
          const aggregate = measure.operation === "COUNT_DISTINCT" ? Prisma.sql`COUNT(DISTINCT ${expression})` : Prisma.sql`${Prisma.raw(measure.operation)}(${expression})`;
          selects.push(Prisma.sql`${measure.distinctBy ? Prisma.sql`${aggregate} FILTER (WHERE ${Prisma.raw(`"__rn${index}"`)} = 1)` : withWhen(aggregate, measure)} AS ${alias}`);
        }
      }
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;
      const withTotal = Boolean(query.includeTotal) && groups.length > 0;
      if (withTotal) selects.push(Prisma.sql`COUNT(*) OVER() AS "__total"`);
      const outputAliases = new Map<string, string>([
        ...groups.map((key, index) => [key, `"g${index}"`] as [string, string]),
        ...query.measures.map((measure, index) => [measure.alias, `"m${index}"`] as [string, string]),
      ]);
      const ordering = (query.orderBy ?? []).map((item) => Prisma.sql`${Prisma.raw(outputAliases.get(item.key)!)} ${Prisma.raw(item.direction)}`);
      // Group columns break ties so offset pagination is stable between pages.
      if (groups.length) for (const [index] of groups.entries()) ordering.push(Prisma.sql`${Prisma.raw(`"g${index}"`)} ASC`);
      const rawRows = await bounded(tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        WITH base AS MATERIALIZED (
          SELECT ${Prisma.join(projection, ", ")}
          FROM "NorthDatasetRevisionBatch" rb
          JOIN "NorthDatasetRow" r ON r."batchId" = rb."batchId" AND r."datasetId" = rb."datasetId" AND r."organizationId" = rb."organizationId"
          WHERE ${where}
        )${ranks.length ? Prisma.sql`, ranked AS (SELECT base.*, ${Prisma.join(ranks, ", ")} FROM base)` : Prisma.empty}
        SELECT ${Prisma.join(selects)}
        FROM ${ranks.length ? Prisma.raw("ranked") : Prisma.raw("base")}
        ${groupPositions.length ? Prisma.sql`GROUP BY ${Prisma.join(groupPositions)}` : Prisma.empty}
        ${ordering.length ? Prisma.sql`ORDER BY ${Prisma.join(ordering)}` : Prisma.empty}
        LIMIT ${limit} OFFSET ${offset}`));
      const columns: ResultColumn[] = [
        ...groups.map((fieldId) => ({ key: fieldId, fieldId, type: granularity[fieldId] === "MONTH_OF_YEAR" ? "INTEGER" as const : fields.get(fieldId)!.canonicalType })),
        ...query.measures.map((measure) => ({
          key: measure.alias,
          ...(measure.fieldId ? { fieldId: measure.fieldId } : {}),
          type: measure.operation === "COUNT" || measure.operation === "COUNT_DISTINCT" ? "INTEGER" as const
            : measure.operation === "SUM" || measure.operation === "AVG" ? "DECIMAL" as const
              : fields.get(measure.fieldId!)!.canonicalType,
        })),
      ];
      const rows = rawRows.map((row) => Object.fromEntries([...groups.map((id, index) => [id, jsonScalar(row[`g${index}`])]), ...query.measures.map((measure, index) => [measure.alias, jsonScalar(row[`m${index}`])])]));
      return { mode: "AGGREGATE" as const, datasetId, activeRevisionId: revision.id, schemaVersionId: revision.schemaVersionId, columns, rows, rowCount: rows.length, ...(withTotal ? { totalRows: rawRows.length ? Number(rawRows[0]!["__total"]) : offset === 0 ? 0 : await countGroups(tx, where, rawGroupExpressions) } : {}), executedAt: new Date() };
}

const FROM_ROWS = Prisma.sql`FROM "NorthDatasetRevisionBatch" rb JOIN "NorthDatasetRow" r ON r."batchId" = rb."batchId" AND r."datasetId" = rb."datasetId" AND r."organizationId" = rb."organizationId"`;
// A page past the end carries no window total; recount so the caller can still render "page x of y".
async function countRows(tx: Transaction, where: Prisma.Sql) {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT COUNT(*) AS n ${FROM_ROWS} WHERE ${where}`);
  return Number(row?.n ?? 0);
}
async function countGroups(tx: Transaction, where: Prisma.Sql, groups: Prisma.Sql[]) {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT COUNT(*) AS n FROM (SELECT 1 ${FROM_ROWS} WHERE ${where} GROUP BY ${Prisma.join(groups)}) g`);
  return Number(row?.n ?? 0);
}
