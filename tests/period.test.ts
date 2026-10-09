import assert from "node:assert/strict";
import test from "node:test";
import { previousPeriod, selectedPeriod, withPeriod } from "../src/modules/north/data/period.js";

test("whole calendar months and years compare with the preceding calendar period", () => {
  assert.deepEqual(previousPeriod("2025-10-01", "2025-11-01"), { from: "2025-09-01", to: "2025-10-01" });
  assert.deepEqual(previousPeriod("2026-01-01", "2026-02-01"), { from: "2025-12-01", to: "2026-01-01" });
  assert.deepEqual(previousPeriod("2025-01-01", "2026-01-01"), { from: "2024-01-01", to: "2025-01-01" });
  assert.deepEqual(previousPeriod("2025-07-01", "2025-10-01"), { from: "2025-04-01", to: "2025-07-01" });
});

test("arbitrary ranges step back by their own length; invalid ranges have no previous period", () => {
  assert.deepEqual(previousPeriod("2025-10-10", "2025-10-20"), { from: "2025-09-30", to: "2025-10-10" });
  assert.deepEqual(previousPeriod("2024-03-01", "2024-03-15"), { from: "2024-02-16", to: "2024-03-01" });
  assert.equal(previousPeriod("2025-10-20", "2025-10-10"), null);
  assert.equal(previousPeriod("nope", "2025-10-10"), null);
});

test("selectedPeriod needs a closed range and normalizes inclusive operators", () => {
  const range = (...filters: Array<[string, string]>) => filters.map(([operator, value]) => ({ fieldId: "d", operator, value })) as never;
  assert.deepEqual(selectedPeriod(range(["GTE", "2025-10-01"], ["LT", "2025-11-01"]), "d"), { from: "2025-10-01", to: "2025-11-01" });
  assert.deepEqual(selectedPeriod(range(["GTE", "2025-10-01"], ["LTE", "2025-10-31"]), "d"), { from: "2025-10-01", to: "2025-11-01" });
  assert.deepEqual(selectedPeriod(range(["EQ", "2025-10-05"]), "d"), { from: "2025-10-05", to: "2025-10-06" });
  assert.equal(selectedPeriod(range(["GTE", "2025-10-01"]), "d"), null, "open-ended ranges cannot be compared");
  assert.equal(selectedPeriod([], "d"), null);
});

test("withPeriod replaces only the date range", () => {
  const filters = [{ fieldId: "c", operator: "IN", value: ["CHINA"] }, { fieldId: "d", operator: "GTE", value: "2025-10-01" }, { fieldId: "d", operator: "LT", value: "2025-11-01" }] as never;
  assert.deepEqual(withPeriod(filters, "d", { from: "2025-09-01", to: "2025-10-01" }), [
    { fieldId: "c", operator: "IN", value: ["CHINA"] },
    { fieldId: "d", operator: "GTE", value: "2025-09-01" },
    { fieldId: "d", operator: "LT", value: "2025-10-01" },
  ]);
});
