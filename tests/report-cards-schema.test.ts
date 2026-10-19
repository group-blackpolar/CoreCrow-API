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
