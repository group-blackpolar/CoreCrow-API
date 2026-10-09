import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedBindingFilterSchema, datasetQueryFilter, datasetQuerySchema } from "../src/modules/north/data/query-contract.js";

test("IN takes a bounded non-empty list and no other operator does", () => {
  assert.ok(datasetQueryFilter.safeParse({ fieldId: "f", operator: "IN", value: ["a", "b"] }).success);
  assert.ok(!datasetQueryFilter.safeParse({ fieldId: "f", operator: "IN", value: "a" }).success);
  assert.ok(!datasetQueryFilter.safeParse({ fieldId: "f", operator: "IN", value: [] }).success);
  assert.ok(!datasetQueryFilter.safeParse({ fieldId: "f", operator: "IN", value: null }).success);
  assert.ok(!datasetQueryFilter.safeParse({ fieldId: "f", operator: "IN", value: Array.from({ length: 101 }, (_, i) => String(i)) }).success);
  assert.ok(!datasetQueryFilter.safeParse({ fieldId: "f", operator: "EQ", value: ["a"] }).success);
  assert.ok(datasetQueryFilter.safeParse({ fieldId: "f", operator: "EQ", value: null }).success);
});

test("IN is accepted inside queries and binding allowlists", () => {
  const query = { mode: "AGGREGATE", measures: [{ operation: "COUNT", alias: "n" }], filters: [{ fieldId: "f", operator: "IN", value: ["x"] }] };
  assert.ok(datasetQuerySchema.safeParse(query).success);
  assert.ok(allowedBindingFilterSchema.safeParse({ fieldId: "f", operators: ["IN", "EQ"] }).success);
});
