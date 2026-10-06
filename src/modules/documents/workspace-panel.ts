import type { NorthPanelDocument } from "../north/content-schema.js";

/** One full-width component: the workspace owns its own list/editor/detail UI and API calls. */
export function workspaceDocument(typeKey: string, title: { es: string; en: string }): NorthPanelDocument {
  const layout = { desktop: { x: 0, y: 0, w: 12, h: 2 }, tablet: { x: 0, y: 0, w: 6, h: 2 }, mobile: { x: 0, y: 0, w: 12, h: 2 } };
  return {
    schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
    sections: [{
      id: "workspace", name: title, order: 0, layout: { variant: "grid", gap: "md" },
      components: [{ id: "document-workspace", type: "document_workspace", schemaVersion: 1, props: { typeKey, title }, bindings: {}, layout, order: 0 }],
    }],
  };
}
