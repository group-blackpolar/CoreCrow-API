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

function filterSql(filter: Filter, field: Field) {
  const expression = typed(field);
  if (filter.operator === "CONTAINS") {
    if (field.canonicalType !== "TEXT" || typeof filter.value !== "string") fail(422, "DATASET_QUERY_FILTER_INVALID", "CONTAINS requires a text field and value");
    return Prisma.sql`${expression} ILIKE ${`%${filter.value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`} ESCAPE '\\'`;
  }
  if (filter.value === null) return filter.operator === "EQ" ? Prisma.sql`${expression} IS NULL` : filter.operator === "NE" ? Prisma.sql`${expression} IS NOT NULL` : fail(422, "DATASET_QUERY_FILTER_INVALID", "Null supports only EQ or NE");
  const operator = ({ EQ: "=", NE: "<>", GT: ">", GTE: ">=", LT: "<", LTE: "<=" } as const)[filter.operator];
  return Prisma.sql`${expression} ${Prisma.raw(operator)} ${filterValue(field, filter.value)}`;
}

function jsonScalar(value: unknown): Scalar {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  return String(value);
}

export const northDatasetQuery = {
  execute(userId: string, organizationId: string, datasetId: string, query: DatasetQuery) {
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.query");
      return executeDatasetQuery(tx, organizationId, datasetId, query);
    });
  },
};

export async function executeDatasetQuery(tx: Transaction, organizationId: string, datasetId: string, query: DatasetQuery) {
      const dataset = await tx.northDataset.findFirst({ where: { id: datasetId, organizationId, status: "ACTIVE" }, include: { activeRevision: { include: { schemaVersion: { include: { fields: true } } } } } });
      if (!dataset?.activeRevision) fail(409, "DATASET_REVISION_NOT_ACTIVE", "Dataset has no active revision");
      const revision = dataset.activeRevision;
      const fields = new Map(revision.schemaVersion.fields.filter((field) => field.status === "ACTIVE").map((field) => [field.datasetFieldId, field]));
      const requested = query.mode === "ROWS" ? [...query.fields, ...(query.orderBy ?? []).map((item) => item.fieldId), ...(query.filters ?? []).map((item) => item.fieldId)] : [...(query.groupBy ?? []), ...query.measures.flatMap((item) => item.fieldId ? [item.fieldId] : []), ...(query.filters ?? []).map((item) => item.fieldId)];
      if (requested.some((id) => !fields.has(id))) fail(422, "DATASET_QUERY_FIELD_INVALID", "Query references a field outside the active schema");
      const filters = (query.filters ?? []).map((item) => filterSql(item, fields.get(item.fieldId)!));
      const where = Prisma.sql`rb."revisionId" = ${revision.id} AND rb."organizationId" = ${organizationId} AND rb."datasetId" = ${datasetId}${filters.length ? Prisma.sql` AND ${Prisma.join(filters, " AND ")}` : Prisma.empty}`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5000ms'`;
      if (query.mode === "ROWS") {
        const pairs = query.fields.flatMap((fieldId) => [Prisma.sql`${fieldId}`, Prisma.sql`r."values" -> ${fieldId}`]);
        const ordering = (query.orderBy ?? []).map((item) => Prisma.sql`${typed(fields.get(item.fieldId)!)} ${Prisma.raw(item.direction)}`);
        ordering.push(Prisma.sql`r."ordinal" ASC`, Prisma.sql`r."id" ASC`);
        const limit = query.limit ?? 100;
        const offset = query.offset ?? 0;
        const rows = await tx.$queryRaw<Array<{ data: Record<string, Scalar> }>>(Prisma.sql`
          SELECT jsonb_build_object(${Prisma.join(pairs)}) AS data
          FROM "NorthDatasetRevisionBatch" rb
          JOIN "NorthDatasetRow" r ON r."batchId" = rb."batchId" AND r."datasetId" = rb."datasetId" AND r."organizationId" = rb."organizationId"
          WHERE ${where}
          ORDER BY ${Prisma.join(ordering)} LIMIT ${limit} OFFSET ${offset}`);
        const columns: ResultColumn[] = query.fields.map((fieldId) => ({ key: fieldId, fieldId, type: fields.get(fieldId)!.canonicalType }));
        return { mode: "ROWS" as const, datasetId, activeRevisionId: revision.id, schemaVersionId: revision.schemaVersionId, columns, rows: rows.map((row) => row.data), rowCount: rows.length, executedAt: new Date() };
      }
      const groups = query.groupBy ?? [];
      const groupExpressions = groups.map((id) => typed(fields.get(id)!));
      const selects: Prisma.Sql[] = groupExpressions.map((expression, index) => Prisma.sql`${expression} AS ${Prisma.raw(`"g${index}"`)}`);
      for (const [index, measure] of query.measures.entries()) {
        const alias = Prisma.raw(`"m${index}"`);
        if (measure.operation === "COUNT" && !measure.fieldId) selects.push(Prisma.sql`COUNT(*) AS ${alias}`);
        else {
          if (!measure.fieldId) fail(422, "DATASET_QUERY_MEASURE_INVALID", "Measure requires a field");
          const field = fields.get(measure.fieldId)!;
          const expression = typed(field);
          if (["SUM", "AVG"].includes(measure.operation) && !["INTEGER", "DECIMAL"].includes(field.canonicalType)) fail(422, "DATASET_QUERY_MEASURE_INVALID", "SUM and AVG require numeric fields");
          if (["MIN", "MAX"].includes(measure.operation) && field.canonicalType === "BOOLEAN") fail(422, "DATASET_QUERY_MEASURE_INVALID", "MIN and MAX do not support boolean fields");
          const operation = measure.operation === "COUNT_DISTINCT" ? Prisma.sql`COUNT(DISTINCT ${expression})` : Prisma.sql`${Prisma.raw(measure.operation)}(${expression})`;
          selects.push(Prisma.sql`${operation} AS ${alias}`);
        }
      }
      const limit = query.limit ?? 100;
      const rawRows = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${Prisma.join(selects)}
        FROM "NorthDatasetRevisionBatch" rb
        JOIN "NorthDatasetRow" r ON r."batchId" = rb."batchId" AND r."datasetId" = rb."datasetId" AND r."organizationId" = rb."organizationId"
        WHERE ${where}
        ${groupExpressions.length ? Prisma.sql`GROUP BY ${Prisma.join(groupExpressions)}` : Prisma.empty}
        LIMIT ${limit}`);
      const columns: ResultColumn[] = [
        ...groups.map((fieldId) => ({ key: fieldId, fieldId, type: fields.get(fieldId)!.canonicalType })),
        ...query.measures.map((measure) => ({
          key: measure.alias,
          ...(measure.fieldId ? { fieldId: measure.fieldId } : {}),
          type: measure.operation === "COUNT" || measure.operation === "COUNT_DISTINCT" ? "INTEGER" as const
            : measure.operation === "SUM" || measure.operation === "AVG" ? "DECIMAL" as const
              : fields.get(measure.fieldId!)!.canonicalType,
        })),
      ];
      const rows = rawRows.map((row) => Object.fromEntries([...groups.map((id, index) => [id, jsonScalar(row[`g${index}`])]), ...query.measures.map((measure, index) => [measure.alias, jsonScalar(row[`m${index}`])])]));
      return { mode: "AGGREGATE" as const, datasetId, activeRevisionId: revision.id, schemaVersionId: revision.schemaVersionId, columns, rows, rowCount: rows.length, executedAt: new Date() };
}
