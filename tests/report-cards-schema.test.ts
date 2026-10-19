import assert from "node:assert/strict";
import test from "node:test";
import { validateNorthPanelDocument } from "../src/modules/north/content-schema.js";

const cell = { x: 0, y: 0, w: 12, h: 4 };
const layout = { desktop: cell, tablet: cell, mobile: cell };
const documentOf = (components: unknown[]) => ({ schemaVersion: 1, defaultLocale: "es", fallbackLocales: [], sections: [{ id: "s", order: 0, layout: { variant: "grid", gap: "md" }, components }] });
const card = (extra: object = {}) => ({ id: "c1", categorySlug: "local-import", title: { es: "Local Import" }, icon: "container", tone: "cyan", image: "/brand/cards/local-import.webp", ...extra });
const report = (props: object) => ({ id: "r", type: "report_cards", schemaVersion: 1, order: 0, bindings: {}, layout, props });
const check = (components: unknown[]) => validateNorthPanelDocument(documentOf(components) as never, { organizationId: "o", actorId: "u", panelId: "p", validateBindingReference: async () => false });

test("report_cards and the centered hero validate; unsafe cards are refused", async () => {
  await check([report({ title: { es: "Reportes" }, items: [card()] }), { id: "h", type: "hero", schemaVersion: 1, order: 1, bindings: {}, layout, props: { title: { es: "Hola" }, centered: true, logoImage: "/brand/shark-logo.png" } }]);
  for (const bad of [
    { items: [] },
    { items: [card({ categorySlug: "Not A Slug" })] },
    { items: [card({ image: "https://example.com/x.png" })] },
    { items: [card({ image: "/brand/../secret.png" })] },
    { items: [card({ href: "https://example.com" })] },
    { items: Array.from({ length: 13 }, (_, i) => card({ id: `c${i}` })) },
  ]) await assert.rejects(check([report(bad)]), undefined, JSON.stringify(bad).slice(0, 60));
});

test("title_bar, grid totals/zeroDash and monthOfYear charts validate; unknown props are refused", async () => {
  const bar = { id: "t", type: "title_bar", schemaVersion: 1, order: 0, bindings: {}, layout, props: { text: { es: "Imports by Port" }, align: "left" } };
  const grid = { id: "g", type: "data_grid", schemaVersion: 1, order: 1, bindings: {}, layout, props: { columns: [{ key: "a", label: { es: "A" }, kind: "text" }, { key: "y2024", label: { es: "2024" }, kind: "number", zeroDash: true }], totals: { binding: "totals", label: { es: "Total general" } } } };
  const line = { id: "l", type: "line_chart", schemaVersion: 1, order: 2, bindings: {}, layout, props: { categoryKey: "m", categoryFormat: "monthOfYear", series: [{ key: "y2024", label: { es: "2024" }, color: "#84CC16" }] } };
  await check([bar, grid, line]);
  await assert.rejects(check([{ ...bar, props: { text: { es: "x" }, extra: 1 } }]));
  await assert.rejects(check([{ ...grid, props: { ...grid.props, totals: { binding: "bad binding" } } }]));
  await assert.rejects(check([{ ...line, props: { ...line.props, categoryFormat: "weekOfYear" } }]));
});
