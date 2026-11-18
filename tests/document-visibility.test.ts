import assert from "node:assert/strict";
import test from "node:test";
import { filterDocumentForViewer } from "../src/modules/north/document-visibility.js";

const cell = { desktop: { x: 0, y: 0, w: 4, h: 2 }, tablet: { x: 0, y: 0, w: 4, h: 2 }, mobile: { x: 0, y: 0, w: 4, h: 2 } };
const c = (id: string, extra: object = {}, type = "heading", props: Record<string, unknown> = {}) => ({ id, type, schemaVersion: 1, props, bindings: {}, layout: cell, order: 0, ...extra });
const doc = {
  schemaVersion: 1, defaultLocale: "en", fallbackLocales: [] as string[],
  sections: [{ id: "s", order: 0, layout: { variant: "grid", gap: "md" }, components: [
    c("open"),
    c("admins", { visibility: { roles: ["ADMIN"] } }),
    c("analysts", { visibility: { groupIds: ["g1"] } }),
    c("group", {}, "panel_group", { items: [{ componentId: "admins", label: { en: "A" } }, { componentId: "analysts", label: { en: "B" } }] }),
  ] }],
};
const ids = (d: typeof doc) => d.sections[0]!.components.map((x) => x.id);

test("components without visibility are untouched and the same object is returned", () => {
  const plain = { ...doc, sections: [{ ...doc.sections[0]!, components: [c("a")] }] };
  assert.equal(filterDocumentForViewer(plain, { role: "VIEWER", groupIds: new Set() }), plain);
});

test("role OR group shows a block; anyone else does not receive it, nor its rules", () => {
  const admin = filterDocumentForViewer(doc, { role: "ADMIN", groupIds: new Set() });
  assert.deepEqual(ids(admin as typeof doc), ["open", "admins", "group"]);
  const analyst = filterDocumentForViewer(doc, { role: "VIEWER", groupIds: new Set(["g1"]) });
  assert.deepEqual(ids(analyst as typeof doc), ["open", "analysts", "group"]);
  const viewer = filterDocumentForViewer(doc, { role: "VIEWER", groupIds: new Set() });
  assert.deepEqual(ids(viewer as typeof doc), ["open"]);
  assert.ok(!JSON.stringify([admin, analyst, viewer]).includes("visibility"));
});

test("panel_group keeps only delivered members and disappears when none remain", () => {
  const admin = filterDocumentForViewer(doc, { role: "ADMIN", groupIds: new Set() }) as typeof doc;
  assert.deepEqual((admin.sections[0]!.components.at(-1)!.props.items as Array<{ componentId: string }>).map((i) => i.componentId), ["admins"]);
});

test("anonymous viewers (public showcase) never get restricted blocks", () => {
  assert.deepEqual(ids(filterDocumentForViewer(doc, null) as typeof doc), ["open"]);
});
