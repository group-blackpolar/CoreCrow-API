// Offline contract check of the SHARK Master House definition: every binding query, every allowed filter, every component's
// props and every mapped result key is validated with the SAME schemas CORECROW enforces, with no database. A fake field
// resolver stands in for the dataset (field id = field key).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { allowedBindingFilterSchema, datasetQuerySchema } from "../src/modules/north/data/query-contract.js";
import { northComponentRegistry, northPanelDocumentInput } from "../src/modules/north/content-schema.js";
import { buildDraftReport } from "../src/modules/north/content-validation.js";

const definition = (await import(pathToFileURL(resolve("scripts/dashboards/shark-master-house.mjs")).href)).default;
const fieldId = (key: string) => key;

test("Master House defines exactly the eight panels, one per subcategory, inside the existing category", () => {
  assert.equal(definition.category.slug, "master-house");
  assert.deepEqual(definition.panels.map((entry: { subcategory: { slug: string } }) => entry.subcategory.slug), [
    "dashboard-information", "search-by", "master-consignee-list", "house-consignee-list",
    "search-by-port-of-departure", "consignees-and-cargo-table", "consignees-table", "top-freight-forwarders",
  ]);
});

for (const entry of definition.panels as Array<{ subcategory: { slug: string }; bindings: (c: unknown) => Array<{ name: string; query: unknown; allowedFilters: unknown[] }>; document: (c: unknown) => { sections: Array<{ components: Array<{ id: string; type: string; props: unknown; bindings: Record<string, { sourceId: string }>; layout: Record<string, { x: number; y: number; w: number; h: number }> }>; layout: unknown }> } }>) {
  test(`${entry.subcategory.slug}: bindings, document and mapped keys satisfy the CORECROW contract`, () => {
    const bindings = entry.bindings({ fieldId });
    const names = new Set<string>();
    for (const binding of bindings) {
      assert.ok(!names.has(binding.name), `duplicate binding ${binding.name}`);
      names.add(binding.name);
      assert.ok(datasetQuerySchema.safeParse(binding.query).success, `binding ${binding.name}: ${JSON.stringify(datasetQuerySchema.safeParse(binding.query))}`);
      for (const filter of binding.allowedFilters) assert.ok(allowedBindingFilterSchema.safeParse(filter).success, `filter of ${binding.name}`);
    }
    const document = entry.document({ fieldId, binding: (name: string) => {
      assert.ok(names.has(name), `unknown binding ${name}`);
      return { sourceType: "dataset", sourceId: name, datasetId: "dataset" };
    } });
    const parsed = northPanelDocumentInput.safeParse(document);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
    for (const component of document.sections[0]!.components) {
      const registered = northComponentRegistry[`${component.type}@1`];
      assert.ok(registered, `component type ${component.type}`);
      const result = registered.validate(component.props);
      assert.ok(result.success, `${component.id} (${component.type}): ${result.success ? "" : JSON.stringify(result.error.issues.slice(0, 2))}`);
    }
    // Same server-side draft report the publish gate runs: every mapped result key must exist in the component's bindings.
    const facts = new Map(bindings.map((binding) => [binding.name, { id: binding.name, datasetId: "dataset", query: binding.query }]));
    const report = buildDraftReport({ document, schemaError: null, bindings: facts, datasets: new Map([["dataset", { id: "dataset", available: true, accessible: true }]]) });
    const problems = report.issues.filter((issue) => issue.severity === "error" || issue.code === "LAYOUT_OVERLAP");
    assert.deepEqual(problems, []);
    // Fixed matrix: desktop rows are explicit and nothing leaves the 12 columns.
    const section = document.sections[0]!;
    assert.ok((section.layout as { rowHeight?: number }).rowHeight);
    for (const component of section.components) assert.ok(component.layout.desktop!.x + component.layout.desktop!.w <= 12, component.id);
  });
}

test("TEUs and metric tons are counted once per bill of lading", () => {
  const all = (definition.panels as Array<{ bindings: (c: unknown) => Array<{ query: { measures?: Array<{ alias: string; distinctBy?: string }> } }> }>)
    .flatMap((entry) => entry.bindings({ fieldId })).flatMap((binding) => binding.query.measures ?? []);
  const teus = all.filter((measure) => measure.alias === "master_teus" || measure.alias === "house_metric_tons");
  assert.ok(teus.length >= 3);
  for (const measure of teus) assert.ok(measure.distinctBy, `${measure.alias} must be distinct by BL`);
});
