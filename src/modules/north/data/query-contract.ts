import { z } from "zod";

const queryFieldId = z.string().min(1).max(128);
export const datasetQueryScalar = z.union([z.string().max(4096).nullable(), z.number(), z.boolean()]);
export const datasetQueryFilter = z.object({
  fieldId: queryFieldId,
  operator: z.enum(["EQ", "NE", "GT", "GTE", "LT", "LTE", "CONTAINS"]),
  value: datasetQueryScalar,
}).strict();
export const datasetQuerySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ROWS"), fields: z.array(queryFieldId).min(1).max(20),
    filters: z.array(datasetQueryFilter).max(10).optional(),
    orderBy: z.array(z.object({ fieldId: queryFieldId, direction: z.enum(["ASC", "DESC"]) }).strict()).max(3).optional(),
    limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).max(1000).optional(),
  }).strict(),
  z.object({
    mode: z.literal("AGGREGATE"), groupBy: z.array(queryFieldId).max(2).optional(),
    measures: z.array(z.object({ operation: z.enum(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]), fieldId: queryFieldId.optional(), alias: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict()).min(1).max(8),
    filters: z.array(datasetQueryFilter).max(10).optional(),
    orderBy: z.array(z.object({ key: queryFieldId, direction: z.enum(["ASC", "DESC"]) }).strict()).max(3).optional(),
    limit: z.number().int().min(1).max(100).optional(),
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
  operators: z.array(z.enum(["EQ", "NE", "GT", "GTE", "LT", "LTE", "CONTAINS"])).min(1).max(7),
}).strict().superRefine((value, context) => {
  if (new Set(value.operators).size !== value.operators.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["operators"], message: "Allowed filter operators must be unique" });
});

export type DatasetQuery = z.infer<typeof datasetQuerySchema>;
export type DatasetQueryFilter = z.infer<typeof datasetQueryFilter>;
export type AllowedBindingFilter = z.infer<typeof allowedBindingFilterSchema>;
