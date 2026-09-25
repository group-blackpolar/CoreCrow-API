import { randomUUID } from "node:crypto";
import type { NorthPanelDocument } from "./content-schema.js";

export function cloneNorthPanelDocument(document: NorthPanelDocument): NorthPanelDocument {
  const copy = structuredClone(document);
  for (const section of copy.sections) {
    section.id = randomUUID();
    for (const component of section.components) {
      component.id = randomUUID();
      if (component.type === "list" && Array.isArray(component.props.items))
        component.props.items = component.props.items.map((item) =>
          item && typeof item === "object" ? { ...item, id: randomUUID() } : item,
        );
    }
  }
  return copy;
}
