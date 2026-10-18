import { Prisma, type NorthDatasetFieldType } from "../../../lib/database.js";
import { DomainError, fail } from "../../../shared/errors.js";
import { transaction } from "../../../shared/transaction.js";
import { datasetAclAllows, requireOrganizationDataCapability } from "./authorization.js";
import { gated, executeDatasetQuery, readTransaction } from "./query-service.js";
import { northDataRepository as repo } from "./repository.js";
import type { DatasetQuery } from "./query-contract.js";

/**
 * One logical collection, many datasets. The caller names fields by their stable KEY (datasets of a group have different field ids);
 * each member dataset is queried through the same authorized engine as a single dataset and the partial aggregates are merged here.
 * Mergeable: COUNT, SUM, MIN, MAX, AVG. COUNT_DISTINCT and `distinctBy` need the rows of every period at once, so they are refused
 * (422) unless exactly one dataset takes part. ROWS needs a single dataset too: paging across datasets would hide gaps.
 */
const PER_DATASET_GROUP_CAP = 1_000;
const NUMERIC = new Set<NorthDatasetFieldType>(["INTEGER", "DECIMAL"]);
type Scalar = string | number | boolean | null;
type Member = { id: string; slug: string; activeRevisionId: string; fields: Map<string, { fieldId: string; type: NorthDatasetFieldType }> };
export type GroupQueryInput = { query: DatasetQuery; datasetIds?: string[]; periodFrom?: string | null; periodTo?: string | null };

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

async function members(tx: Parameters<Parameters<typeof transaction>[0]>[0], userId: string, organizationId: string, groupId: string, filter: { datasetIds?: string[]; periodFrom?: string | null; periodTo?: string | null } = {}) {
  const membership = await requireOrganizationDataCapability(tx, userId, organizationId, "north.data.query");
  const group = await tx.northDatasetGroup.findFirst({ where: { id: groupId, organizationId } });
  if (!group) fail(404, "NOT_FOUND", "Dataset group not found");
  const rows = await tx.northDataset.findMany({
    where: {
      organizationId, groupId, status: "ACTIVE", activeRevisionId: { not: null },
      ...(filter.datasetIds?.length ? { id: { in: filter.datasetIds } } : {}),
      // A dataset with no declared period is always considered; a declared one must intersect the requested window.
      ...(filter.periodTo ? { OR: [{ periodStart: null }, { periodStart: { lte: day(filter.periodTo) } }] } : {}),
      ...(filter.periodFrom ? { AND: [{ OR: [{ periodEnd: null }, { periodEnd: { gte: day(filter.periodFrom) } }] }] } : {}),
    },
    include: { activeRevision: { include: { schemaVersion: { include: { fields: { include: { datasetField: { select: { key: true } } } } } } } } },
    orderBy: [{ periodStart: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  const result: Member[] = [];
  for (const dataset of rows) {
    // Same visibility as the dataset list: datasets the caller's ACL hides are not reported, not even as skipped.
    if (!(await datasetAclAllows(tx, membership, await repo.aclRules(tx, organizationId, dataset.id)))) continue;
    const fields = new Map<string, { fieldId: string; type: NorthDatasetFieldType }>();
    for (const field of dataset.activeRevision!.schemaVersion.fields)
      if (field.status === "ACTIVE") fields.set(field.datasetField.key, { fieldId: field.datasetFieldId, type: field.canonicalType });
    result.push({ id: dataset.id, slug: dataset.slug, activeRevisionId: dataset.activeRevisionId!, fields });
  }
  return result;
}

function keysOf(query: DatasetQuery) {
  const search = query.search?.fieldIds ?? [];
  return query.mode === "ROWS"
    ? [...query.fields, ...(query.orderBy ?? []).map((item) => item.fieldId), ...(query.filters ?? []).map((item) => item.fieldId), ...search]
    : [...(query.groupBy ?? []), ...query.measures.flatMap((m) => [m.fieldId, m.distinctBy].filter((id): id is string => Boolean(id))), ...(query.filters ?? []).map((item) => item.fieldId), ...search];
}

/** Rewrites field keys to the dataset's own field ids. */
function translate(query: DatasetQuery, member: Member, merged: boolean): DatasetQuery {
  const id = (key: string) => member.fields.get(key)!.fieldId;
  const filters = query.filters?.map((filter) => ({ ...filter, fieldId: id(filter.fieldId) }));
  const search = query.search ? { ...query.search, fieldIds: query.search.fieldIds.map(id) } : undefined;
  if (query.mode === "ROWS") {
    return { ...query, fields: query.fields.map(id), ...(filters ? { filters } : {}), ...(search ? { search } : {}), ...(query.orderBy ? { orderBy: query.orderBy.map((item) => ({ ...item, fieldId: id(item.fieldId) })) } : {}) };
  }
  const groups = query.groupBy ?? [];
  const measures: Array<NonNullable<typeof query.measures>[number]> = [];
  for (const measure of query.measures) {
    const mapped = { ...measure, ...(measure.fieldId ? { fieldId: id(measure.fieldId) } : {}), ...(measure.distinctBy ? { distinctBy: id(measure.distinctBy) } : {}) };
    // AVG merges as SUM/COUNT of the same field; the two helper measures replace it for the partial query.
    if (merged && measure.operation === "AVG") measures.push({ ...mapped, operation: "SUM", alias: `__s_${measure.alias}` }, { ...mapped, operation: "COUNT", alias: `__c_${measure.alias}` });
    else measures.push(mapped);
  }
  if (measures.length > 8) fail(422, "GROUP_QUERY_TOO_MANY_MEASURES", "Averages across datasets use two measures each; reduce the number of measures");
  return {
    mode: "AGGREGATE", measures, ...(groups.length ? { groupBy: groups.map(id) } : {}), ...(filters ? { filters } : {}), ...(search ? { search } : {}),
    ...(query.granularity ? { granularity: Object.fromEntries(Object.entries(query.granularity).map(([key, unit]) => [id(key), unit])) } : {}),
    ...(merged
      ? { limit: PER_DATASET_GROUP_CAP }
      : { ...(query.orderBy ? { orderBy: query.orderBy.map((item) => ({ ...item, key: member.fields.has(item.key) ? id(item.key) : item.key })) } : {}), ...(query.limit ? { limit: query.limit } : {}), ...(query.offset ? { offset: query.offset } : {}), ...(query.includeTotal ? { includeTotal: true } : {}) }),
  };
}

const dec = (value: Scalar | undefined) => (value === null || value === undefined || value === "" ? null : new Prisma.Decimal(String(value)));
const plus = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) => (a && b ? a.plus(b) : a ?? b);

function compare(a: Scalar | undefined, b: Scalar | undefined, numeric: boolean) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (numeric) return new Prisma.Decimal(String(a)).comparedTo(new Prisma.Decimal(String(b)));
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export const northDatasetGroupQuery = {
  execute(userId: string, organizationId: string, groupId: string, input: GroupQueryInput) {
    return gated(() => transaction(async (tx) => {
      const selected = await members(tx, userId, organizationId, groupId, input);
      const query = input.query;
      const keys = [...new Set(keysOf(query))];
      const skipped: Array<{ id: string; slug: string; reason: string }> = [];
      const usable: Member[] = [];
      for (const member of selected) {
        const missing = keys.find((key) => !member.fields.has(key));
        if (missing) skipped.push({ id: member.id, slug: member.slug, reason: `MISSING_FIELD:${missing}` });
        else usable.push(member);
      }
      const unknown = keys.find((key) => !selected.some((member) => member.fields.has(key)));
      if (unknown) fail(422, "DATASET_QUERY_FIELD_INVALID", "Query references a field no dataset of the group has");
      if (usable.length === 0) fail(409, "GROUP_QUERY_NO_DATASETS", "No dataset of the group can answer this query");
      for (const key of keys) {
        const types = new Set(usable.map((member) => member.fields.get(key)!.type));
        if (types.size > 1) throw new DomainError(422, "GROUP_QUERY_FIELD_TYPE_CONFLICT", "The field has different types across datasets", { field: key });
      }
      const datasets = usable.map((member) => ({ id: member.id, slug: member.slug, activeRevisionId: member.activeRevisionId }));
      const base = { groupId, datasets, skipped, executedAt: new Date() };
      const remapKey = (member: Member, key: string) => [...member.fields.entries()].find(([, value]) => value.fieldId === key)?.[0] ?? key;

      if (usable.length === 1) {
        const member = usable[0]!;
        const result = await executeDatasetQuery(tx, organizationId, member.id, translate(query, member, false));
        return { ...base, mode: result.mode, columns: result.columns.map((c) => ({ key: remapKey(member, c.key), type: c.type })), rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [remapKey(member, key), value]))), rowCount: result.rowCount, ...("totalRows" in result ? { totalRows: result.totalRows } : {}) };
      }

      if (query.mode === "ROWS") fail(422, "GROUP_QUERY_ROWS_NEED_DATASET", "Row listings need a single dataset: pass datasetIds or a narrower period");
      if (query.measures.some((m) => m.operation === "COUNT_DISTINCT" || m.distinctBy)) fail(422, "GROUP_QUERY_MEASURE_UNSUPPORTED", "Distinct measures cannot be combined across datasets; select one dataset");

      const groups = query.groupBy ?? [];
      const acc = new Map<string, { group: Scalar[]; values: Map<string, Prisma.Decimal | Scalar | null>; counts: Map<string, Prisma.Decimal | null> }>();
      const typeOf = (key: string) => usable[0]!.fields.get(key)!.type;
      for (const member of usable) {
        const result = await executeDatasetQuery(tx, organizationId, member.id, translate(query, member, true));
        if (result.rowCount >= PER_DATASET_GROUP_CAP) fail(422, "GROUP_QUERY_TOO_MANY_GROUPS", "Too many groups per dataset to merge exactly; add filters or group by fewer fields");
        for (const row of result.rows) {
          const group = groups.map((key) => row[member.fields.get(key)!.fieldId] as Scalar);
          const tuple = JSON.stringify(group);
          const entry = acc.get(tuple) ?? { group, values: new Map(), counts: new Map() };
          acc.set(tuple, entry);
          for (const measure of query.measures) {
            const alias = measure.alias;
            if (measure.operation === "AVG") {
              entry.values.set(alias, plus((entry.values.get(alias) as Prisma.Decimal | null) ?? null, dec(row[`__s_${alias}`])));
              entry.counts.set(alias, plus(entry.counts.get(alias) ?? null, dec(row[`__c_${alias}`])));
            } else if (measure.operation === "COUNT" || measure.operation === "SUM") {
              entry.values.set(alias, plus((entry.values.get(alias) as Prisma.Decimal | null) ?? null, dec(row[alias])));
            } else {
              const numeric = NUMERIC.has(typeOf(measure.fieldId!));
              const current = entry.values.get(alias) as Scalar | undefined;
              const next = row[alias] as Scalar;
              const better = current === undefined || (next != null && (current == null || compare(next, current, numeric) * (measure.operation === "MIN" ? 1 : -1) < 0));
              entry.values.set(alias, better ? next ?? null : current ?? null);
            }
          }
        }
      }
      const rows = [...acc.values()].map((entry) => ({
        ...Object.fromEntries(groups.map((key, index) => [key, entry.group[index] ?? null])),
        ...Object.fromEntries(query.measures.map((measure) => {
          const value = entry.values.get(measure.alias) ?? null;
          if (measure.operation === "AVG") { const n = entry.counts.get(measure.alias); return [measure.alias, value && n && !n.isZero() ? (value as Prisma.Decimal).div(n).toString() : null]; }
          return [measure.alias, value instanceof Prisma.Decimal ? value.toString() : (value as Scalar)];
        })),
      }));
      const numericOutput = (key: string) => (groups.includes(key) ? NUMERIC.has(typeOf(key)) : (() => { const m = query.measures.find((x) => x.alias === key)!; return m.operation !== "MIN" && m.operation !== "MAX" ? true : NUMERIC.has(typeOf(m.fieldId!)); })());
      const order = [...(query.orderBy ?? []), ...groups.map((key) => ({ key, direction: "ASC" as const }))];
      rows.sort((a, b) => { for (const item of order) { const c = compare(a[item.key] as Scalar, b[item.key] as Scalar, numericOutput(item.key)); if (c) return item.direction === "DESC" ? -c : c; } return 0; });
      const offset = query.offset ?? 0;
      const page = rows.slice(offset, offset + (query.limit ?? 100));
      const columns = [
        ...groups.map((key) => ({ key, type: typeOf(key) })),
        ...query.measures.map((m) => ({ key: m.alias, type: m.operation === "COUNT" || m.operation === "COUNT_DISTINCT" ? "INTEGER" as const : m.operation === "SUM" || m.operation === "AVG" ? "DECIMAL" as const : typeOf(m.fieldId!) })),
      ];
      return { ...base, mode: "AGGREGATE" as const, columns, rows: page, rowCount: page.length, ...(query.includeTotal && groups.length ? { totalRows: rows.length } : {}) };
    }, readTransaction));
  },

  /** Union of field keys across the visible member datasets: where each exists, type conflicts and gaps (schema drift between periods). */
  fields(userId: string, organizationId: string, groupId: string) {
    return transaction(async (tx) => {
      const list = await members(tx, userId, organizationId, groupId);
      const keys = new Map<string, { types: Set<NorthDatasetFieldType>; present: string[] }>();
      for (const member of list)
        for (const [key, field] of member.fields) {
          const entry = keys.get(key) ?? { types: new Set(), present: [] };
          entry.types.add(field.type); entry.present.push(member.slug); keys.set(key, entry);
        }
      return {
        datasets: list.map((member) => member.slug),
        fields: [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => ({
          key, types: [...entry.types], presentIn: entry.present, missingIn: list.map((m) => m.slug).filter((slug) => !entry.present.includes(slug)), typeConflict: entry.types.size > 1,
        })),
      };
    });
  },
};
