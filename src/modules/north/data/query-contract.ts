import { z } from "zod";

const queryFieldId = z.string().min(1).max(128);
export const datasetQueryScalar = z.union([z.string().max(4096).nullable(), z.number(), z.boolean()]);
// IN carries a bounded list of non-null scalars (multi-select facets); every other operator takes a single scalar.
export const datasetQueryListValue = z.array(z.union([z.string().max(4096), z.number(), z.boolean()])).min(1).max(100);
export const datasetQueryOperator = z.enum(["EQ", "NE", "GT", "GTE", "LT", "LTE", "CONTAINS", "IN"]);
export const datasetQueryFilter = z.object({
  fieldId: queryFieldId,
  operator: datasetQueryOperator,
  value: z.union([datasetQueryScalar, datasetQueryListValue]),
}).strict().superRefine((filter, context) => {
  if ((filter.operator === "IN") !== Array.isArray(filter.value))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "IN requires a list value and every other operator a single value" });
});
export const datasetDateGranularity = z.enum(["DAY", "MONTH", "QUARTER", "YEAR"]);
// Case-insensitive text search across a fixed, bounded set of TEXT fields (OR). Declared by the binding author, never by the reader.
export const datasetQuerySearch = z.object({ fieldIds: z.array(queryFieldId).min(1).max(5), text: z.string().trim().min(1).max(200) }).strict();
export const datasetQuerySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ROWS"), fields: z.array(queryFieldId).min(1).max(20),
    filters: z.array(datasetQueryFilter).max(10).optional(),
    orderBy: z.array(z.object({ fieldId: queryFieldId, direction: z.enum(["ASC", "DESC"]) }).strict()).max(3).optional(),
    limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).max(100_000).optional(),
    search: datasetQuerySearch.optional(), searchFieldIds: z.array(queryFieldId).min(1).max(5).optional(), includeTotal: z.boolean().optional(), compareBy: queryFieldId.optional(),
  }).strict(),
  z.object({
    mode: z.literal("AGGREGATE"), groupBy: z.array(queryFieldId).max(3).optional(),
    // DATE/DATETIME group fields may be truncated to a calendar bucket (the group value is the first day of the bucket).
    granularity: z.record(queryFieldId, datasetDateGranularity).optional(),
    measures: z.array(z.object({ operation: z.enum(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]), fieldId: queryFieldId.optional(), alias: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict()).min(1).max(8),
    filters: z.array(datasetQueryFilter).max(10).optional(),
    orderBy: z.array(z.object({ key: queryFieldId, direction: z.enum(["ASC", "DESC"]) }).strict()).max(3).optional(),
    limit: z.number().int().min(1).max(1_000).optional(), offset: z.number().int().min(0).max(100_000).optional(),
    search: datasetQuerySearch.optional(), searchFieldIds: z.array(queryFieldId).min(1).max(5).optional(), includeTotal: z.boolean().optional(), compareBy: queryFieldId.optional(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.mode === "ROWS") {
    if (new Set(value.fields).size !== value.fields.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fields"], message: "Selected fields must be unique" });
    const orderFields = (value.orderBy ?? []).map((item) => item.fieldId);
    if (new Set(orderFields).size !== orderFields.length)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["orderBy"], message: "Ordered fields must be unique" });
    return;
  }
  const groups = value.groupBy ?? [];
  if (new Set(groups).size !== groups.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["groupBy"], message: "Grouped fields must be unique" });
  if (Object.keys(value.granularity ?? {}).some((key) => !groups.includes(key)))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["granularity"], message: "Granularity may only target grouped fields" });
  const aliases = value.measures.map((item) => item.alias);
  if (new Set(aliases).size !== aliases.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["measures"], message: "Measure aliases must be unique" });
  const outputKeys = new Set([...groups, ...aliases]);
  const orderKeys = (value.orderBy ?? []).map((item) => item.key);
  if (new Set(orderKeys).size !== orderKeys.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["orderBy"], message: "Ordered output keys must be unique" });
  if (orderKeys.some((key) => !outputKeys.has(key)))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["orderBy"], message: "Aggregate ordering must reference a group or measure output" });
});
export const allowedBindingFilterSchema = z.object({
  fieldId: queryFieldId,
  operators: z.array(datasetQueryOperator).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (new Set(value.operators).size !== value.operators.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operators"], message: "Allowed filter operators must be unique" });
});

/** Runtime paging/sorting chosen by the reader of a published binding; every key is re-validated against the binding's own query. */
export const bindingRuntimeOptions = z.object({
  sort: z.object({ key: queryFieldId, direction: z.enum(["ASC", "DESC"]) }).strict().optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  compare: z.boolean().optional(),
}).strict();

export type DatasetQuery = z.infer<typeof datasetQuerySchema>;
export type BindingRuntimeOptions = z.infer<typeof bindingRuntimeOptions>;
export type DatasetQueryFilter = z.infer<typeof datasetQueryFilter>;
export type AllowedBindingFilter = z.infer<typeof allowedBindingFilterSchema>;
