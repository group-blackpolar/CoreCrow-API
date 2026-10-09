import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingOutputKeys, buildDraftReport, type BindingFacts, type DatasetFacts } from "../src/modules/north/content-validation.js";

const cell = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const layout = (c = cell(0, 0, 6, 2)) => ({ desktop: c, tablet: c, mobile: c });
const component = (id: string, type: string, props: Record<string, unknown> = {}, bindings: Record<string, unknown> = {}, c = cell(0, 0, 6, 2)) =>
  ({ id, type, schemaVersion: 1, props, bindings, layout: layout(c), order: 0 });
const documentOf = (...components: unknown[]) => ({ schemaVersion: 1, sections: [{ id: "s1", components }] });

const binding: BindingFacts = {
  id: "b1", datasetId: "d1",
  query: { mode: "AGGREGATE", groupBy: ["f-country"], measures: [{ operation: "SUM", fieldId: "f-amount", alias: "total" }] },
};
const bindings = new Map([[binding.id, binding]]);
const datasetOk = new Map<string, DatasetFacts>([["d1", { id: "d1", available: true, accessible: true }]]);
const ref = { data: { sourceType: "dataset", sourceId: "b1", datasetId: "d1" } };
const run = (document: unknown, extra: Partial<Parameters<typeof buildDraftReport>[0]> = {}) =>
  buildDraftReport({ document, schemaError: null, bindings, datasets: datasetOk, ...extra });
const codes = (report: ReturnType<typeof run>) => report.issues.map((issue) => issue.code).sort();

test("binding output keys are the declared group-by fields and measure aliases", () => {
  assert.deepEqual([...bindingOutputKeys(binding.query)].sort(), ["f-country", "total"]);
  assert.deepEqual([...bindingOutputKeys({ mode: "ROWS", fields: ["a", "b"] })].sort(), ["a", "b"]);
  assert.equal(bindingOutputKeys(null).size, 0);
});

test("a correctly mapped chart is valid and reports its dependencies", () => {
  const report = run(documentOf(component("c1", "bar_chart", { categoryKey: "f-country", series: [{ key: "total" }] }, ref)));
  assert.equal(report.valid, true);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.dependencies.map((d) => `${d.kind}:${d.id}:${d.status}`).sort(), ["binding:b1:ok", "dataset:d1:ok"]);
});

test("an unbound chart, stale mapped field and missing binding are errors", () => {
  assert.deepEqual(codes(run(documentOf(component("c1", "line_chart")))), ["BINDING_REQUIRED"]);
  assert.deepEqual(codes(run(documentOf(component("c1", "donut_chart", { categoryKey: "f-country", valueKey: "gone" }, ref)))), ["FIELD_NOT_IN_BINDING"]);
  const missing = run(documentOf(component("c1", "metric", { fieldKey: "total" }, { data: { sourceType: "dataset", sourceId: "nope", datasetId: "d1" } })));
  assert.deepEqual(codes(missing), ["BINDING_NOT_FOUND"]);
  assert.equal(missing.dependencies[0]!.status, "missing");
});

test("binding that points at another dataset than the document claims is rejected", () => {
  const report = run(documentOf(component("c1", "metric", { fieldKey: "total" }, { data: { sourceType: "dataset", sourceId: "b1", datasetId: "other" } })));
  assert.deepEqual(codes(report), ["BINDING_NOT_FOUND"]);
});

test("archived or inaccessible datasets block publishing without leaking field checks", () => {
  const unavailable = run(documentOf(component("c1", "metric", { fieldKey: "total" }, ref)), { datasets: new Map([["d1", { id: "d1", available: false, accessible: true }]]) });
  assert.deepEqual(codes(unavailable), ["DATASET_UNAVAILABLE"]);
  const forbidden = run(documentOf(component("c1", "metric", { fieldKey: "total" }, ref)), { datasets: new Map([["d1", { id: "d1", available: true, accessible: false }]]) });
  assert.deepEqual(codes(forbidden), ["DATASET_FORBIDDEN"]);
  assert.equal(forbidden.valid, false);
});

test("warnings do not block: empty view, overlap, metric field without binding", () => {
  const empty = run(documentOf());
  assert.deepEqual(codes(empty), ["EMPTY_VIEW"]);
  assert.equal(empty.valid, true);
  const overlap = run(documentOf(component("a", "heading"), component("b", "card")));
  assert.deepEqual(codes(overlap), ["LAYOUT_OVERLAP", "LAYOUT_OVERLAP", "LAYOUT_OVERLAP"]); // one per breakpoint
  assert.equal(overlap.valid, true);
  assert.deepEqual(codes(run(documentOf(component("m", "metric", { fieldKey: "total" })))), ["METRIC_FIELD_WITHOUT_BINDING"]);
});

test("a schema failure is surfaced as an error and never hides other findings", () => {
  const report = run(documentOf(component("c1", "bar_chart")), { schemaError: { code: "CONTENT_INVALID", message: "bad" } });
  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ["BINDING_REQUIRED", "CONTENT_INVALID"]);
});

test("malformed documents never throw", () => {
  assert.equal(run(null, { schemaError: { code: "X", message: "x" } }).valid, false);
  assert.doesNotThrow(() => run({ sections: [null, { components: "no" }, { components: [null, 3, { bindings: { a: null } }] }] }));
});
