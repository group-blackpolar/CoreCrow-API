import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error plain .mjs script module
import { pickPage, planSplits } from "../scripts/lib/split-extra-panels-core.mjs";

const panel = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({ id, slug, name: { en: slug }, status: "PUBLISHED", resourceKind: "CONTENT", order: 0, ...extra });

test("the panel sharing the subcategory slug stays; otherwise a SYSTEM panel; otherwise the first by order", () => {
  assert.equal(pickPage({ slug: "formas" }, [panel("a", "auditoria"), panel("b", "formas")]).id, "b");
  assert.equal(pickPage({ slug: "overview" }, [panel("a", "asdasd", { order: 0 }), panel("b", "home", { resourceKind: "SYSTEM", order: 1 })]).id, "b");
  assert.equal(pickPage({ slug: "x" }, [panel("b", "p2", { order: 2 }), panel("a", "p1", { order: 1 })]).id, "a");
});

test("only subcategories with several active panels are planned; extras get free, unique slugs; nothing is deleted", () => {
  const plan = planSplits([{ id: "c", slug: "cat", subcategories: [
    { id: "s1", slug: "one", panels: [panel("p1", "one")] },
    { id: "s2", slug: "formas", panels: [panel("a", "auditoria"), panel("b", "formas"), panel("c2", "x", { status: "ARCHIVED" })] },
    { id: "s3", slug: "auditoria", panels: [panel("d", "other")] },
  ] }]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keep.id, "b");
  assert.deepEqual(plan[0].moves.map((move: { panel: { id: string }; slug: string }) => [move.panel.id, move.slug]), [["a", "auditoria-2"]], "the slug 'auditoria' is taken by a sibling subcategory");
  assert.deepEqual(planSplits([{ id: "c", slug: "cat", subcategories: [{ id: "s", slug: "s", panels: [panel("p", "s")] }] }]), []);
});
