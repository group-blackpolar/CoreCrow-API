import assert from "node:assert/strict";
import test from "node:test";
import { showcaseVisible, type ShowcaseState } from "../src/modules/north/showcase-service.js";

const visible: ShowcaseState = {
  organization: { status: "ACTIVE", showcaseEnabled: true },
  category: { status: "ACTIVE", navigationHidden: false },
  subcategory: { status: "ACTIVE", navigationHidden: false },
  panel: { status: "PUBLISHED", visibility: "SHOWCASE", resourceKind: "CONTENT", navigationHidden: false },
};
const without = (patch: { [K in keyof ShowcaseState]?: Partial<ShowcaseState[K]> }): ShowcaseState => ({
  organization: { ...visible.organization, ...patch.organization },
  category: { ...visible.category, ...patch.category },
  subcategory: { ...visible.subcategory, ...patch.subcategory },
  panel: { ...visible.panel, ...patch.panel },
});

test("a published SHOWCASE panel in an opted-in organization is public", () => {
  assert.equal(showcaseVisible(visible), true);
});

// Each row removes exactly one condition; every one must close the door (default deny).
for (const [name, patch] of Object.entries({
  "showcase disabled for the organization": { organization: { showcaseEnabled: false } },
  "suspended organization": { organization: { status: "SUSPENDED" } },
  "archived category": { category: { status: "ARCHIVED" } },
  "hidden category": { category: { navigationHidden: true } },
  "archived subcategory": { subcategory: { status: "ARCHIVED" } },
  "hidden subcategory": { subcategory: { navigationHidden: true } },
  "draft panel": { panel: { status: "DRAFT" } },
  "archived panel": { panel: { status: "ARCHIVED" } },
  "private panel (members-only audience is not public)": { panel: { visibility: "PRIVATE" } },
  "system panel": { panel: { resourceKind: "SYSTEM" } },
  "hidden panel": { panel: { navigationHidden: true } },
}) as Array<[string, Parameters<typeof without>[0]]>) {
  test(`revoked when: ${name}`, () => assert.equal(showcaseVisible(without(patch)), false));
}
