import assert from "node:assert/strict";
import test from "node:test";
import { allowedBindingFilterSchema, datasetQuerySchema } from "../src/modules/north/data/query-contract.js";
import { masterHousePages } from "../src/seed-master-house-pages.js";

const FIELDS = [
  "arrival_date", "master_carrier", "master_consignee", "master_metric_tons", "master_port_arrival", "master_port_departure",
  "master_country_origin", "master_teus", "master_bill_number", "container_number", "house_carrier", "house_consignee",
  "house_metric_tons", "house_port_arrival", "house_port_departure", "house_country_origin", "house_teus", "house_bill_number",
];
const id = (key: string) => {
  assert.ok(FIELDS.includes(key), `unknown field ${key}`);
  return `id:${key}`;
};

for (const page of masterHousePages) {
  test(`Master House page ${page.subcategory.slug} is consistent`, () => {
    const outputs = new Map<string, Set<string>>();
    for (const binding of page.bindings) {
      const query = datasetQuerySchema.parse(binding.query(id));
      assert.equal(query.mode, "AGGREGATE");
      if (query.mode === "AGGREGATE") outputs.set(binding.key, new Set([...(query.groupBy ?? []), ...query.measures.map((measure) => measure.alias)]));
    }
    for (const filter of page.filters) allowedBindingFilterSchema.parse({ fieldId: id(filter.field), operators: filter.operators });

    const document = page.document({ datasetId: "dataset", id, binding: (key) => `binding-${key}` });
    for (const component of document.sections.flatMap((section) => section.components)) {
      const reference = component.bindings.result;
      if (!reference) continue;
      const key = reference.sourceId.replace(/^binding-/, "");
      const available = outputs.get(key);
      assert.ok(available, `component ${component.id} references unknown binding ${key}`);
      const props = component.props as Record<string, unknown>;
      const needed = [props.fieldKey, props.categoryKey, props.valueKey, ...((props.series as Array<{ key: string }> | undefined) ?? []).map((item) => item.key)].filter((item): item is string => typeof item === "string");
      for (const output of needed) assert.ok(available.has(output), `component ${component.id} reads ${output}, which binding ${key} does not return`);
    }
  });
}
