import assert from "node:assert/strict";
import test from "node:test";
import { contentSchema, emptyContent, type Content } from "../src/modules/evaluations/content.js";
import { draftOps } from "../src/modules/evaluations/draft-ops.js";
import { grade, percentOf, playerContent, reviewAvailable, reviewContent } from "../src/modules/evaluations/grading.js";
import { validateForPublish } from "../src/modules/evaluations/validation.js";

const para = (text: string) => [{ type: "paragraph" as const, text }];

/** Synthetic fixture: nothing here is shipped or seeded; it only exercises the engine. */
function build(optionCounts: number[] = [4, 3, 5]) {
  let content: Content = emptyContent();
  const section = draftOps.addSection(content, { title: "S1" });
  content = section.content;
  const ids: string[] = [];
  optionCounts.forEach((count, index) => {
    const q = draftOps.addQuestion(content, { sectionId: section.id, category: index === 2 ? null : "cat-a", prompt: para(`Q${index}`), points: 1.5, options: Array.from({ length: count }, (_, i) => ({ text: `opt ${i}` })), explanation: para("because") });
    content = q.content; ids.push(q.id);
    content = draftOps.setCorrectOption(content, q.id, content.questions[index]!.options[1]!.id);
  });
  return { content, ids, section: section.id };
}
const answersFor = (content: Content, picks: Array<"right" | "wrong" | null>) =>
  new Map(content.questions.map((q, i) => [q.id, picks[i] === "right" ? q.correctOptionId : picks[i] === "wrong" ? q.options.find((o) => o.id !== q.correctOptionId)!.id : null]));

test("the document schema accepts a variable number of questions and options", () => {
  const { content } = build([2, 7, 12]);
  assert.deepEqual(content.questions.map((q) => q.options.length), [2, 7, 12]);
  assert.ok(contentSchema.safeParse(content).success);
  assert.ok(!contentSchema.safeParse({ ...content, extra: 1 }).success);
});

test("a correct option must exist among the options; replacing options never leaves a dangling key", () => {
  const { content, ids } = build();
  assert.throws(() => draftOps.setCorrectOption(content, ids[0]!, "nope"), /correct option/i);
  const replaced = draftOps.updateQuestion(content, ids[0]!, { options: [{ text: "x" }, { text: "y" }] });
  assert.equal(replaced.questions[0]!.correctOptionId, null);
  const kept = draftOps.updateQuestion(content, ids[0]!, { options: content.questions[0]!.options.map((o) => ({ id: o.id, text: `${o.text}!` })) });
  assert.equal(kept.questions[0]!.correctOptionId, content.questions[0]!.correctOptionId);
});

test("reorder must name every sibling exactly once; a section with questions cannot be removed; removing a text detaches its questions", () => {
  const { content, ids, section } = build();
  assert.deepEqual(draftOps.reorderQuestions(content, [...ids].reverse()).questions.map((q) => q.id), [...ids].reverse());
  assert.throws(() => draftOps.reorderQuestions(content, ids.slice(1)), /exactly once/);
  assert.throws(() => draftOps.reorderQuestions(content, [ids[0]!, ids[0]!, ids[1]!]), /exactly once/);
  assert.throws(() => draftOps.removeSection(content, section), /questions/);
  const passage = draftOps.addPassage(content, { title: "T", body: para("text") });
  const linked = draftOps.updateQuestion(passage.content, ids[0]!, { passageId: passage.id });
  assert.equal(draftOps.removePassage(linked, passage.id).questions[0]!.passageId, null);
});

test("publication validation: needs options, a text, a correct option and a date for AFTER_DATE; a complete exam has no issues", () => {
  const { content, ids } = build();
  assert.deepEqual(validateForPublish(content), []);
  assert.deepEqual(validateForPublish(emptyContent()).map((i) => i.code), ["EVALUATION_NO_QUESTIONS"]);
  const broken = draftOps.updateQuestion(content, ids[1]!, { options: [{ text: "only" }] });
  assert.ok(validateForPublish(broken).some((i) => i.code === "EVALUATION_OPTIONS_MIN"));
  assert.ok(validateForPublish(broken).some((i) => i.code === "EVALUATION_CORRECT_OPTION_MISSING"));
  const dated = draftOps.settings(content, { ...content.settings, review: { mode: "AFTER_DATE", revealAfter: null } });
  assert.ok(validateForPublish(dated).some((i) => i.code === "EVALUATION_REVIEW_DATE_REQUIRED"));
});

test("grading: counts, integer points, per-category and per-section breakdown", () => {
  const { content } = build();
  const result = grade(content, answersFor(content, ["right", "wrong", null]));
  assert.deepEqual([result.correct, result.incorrect, result.unanswered], [1, 1, 1]);
  assert.equal(result.scoreCenti, 150);
  assert.equal(result.maxScoreCenti, 450);
  assert.equal(percentOf(result.scoreCenti, result.maxScoreCenti), 33.33);
  const catA = result.breakdown.byCategory.find((c) => c.key === "cat-a")!;
  assert.deepEqual([catA.correct, catA.incorrect, catA.maxScoreCenti], [1, 1, 300]);
  assert.equal(result.breakdown.byCategory.find((c) => c.key === null)!.unanswered, 1);
  assert.equal(result.breakdown.bySection[0]!.scoreCenti, 150);
});

test("grading: penalties come from the version settings and the floor applies", () => {
  const { content } = build();
  const strict = draftOps.settings(content, { ...content.settings, scoring: { wrongPenaltyPercent: 50, unansweredPenaltyPercent: 0, floorAtZero: true } });
  assert.equal(grade(strict, answersFor(strict, ["right", "wrong", null])).scoreCenti, 150 - 75);
  assert.equal(grade(strict, answersFor(strict, ["wrong", "wrong", "wrong"])).scoreCenti, 0, "floored");
  const free = draftOps.settings(content, { ...content.settings, scoring: { wrongPenaltyPercent: 100, unansweredPenaltyPercent: 0, floorAtZero: false } });
  assert.equal(grade(free, answersFor(free, ["wrong", "wrong", "wrong"])).scoreCenti, -450);
});

test("the player view carries neither the answer key nor explanations, and labels options A, B, C ...", () => {
  const { content } = build([4, 3, 5]);
  const view = playerContent(content);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("correctOptionId") && !serialized.includes("because") && !serialized.includes("explanation"));
  assert.deepEqual(view.questions[2]!.options.map((o) => o.label), ["A", "B", "C", "D", "E"]);
});

test("review policy: never, after submit, after a date; only for closed attempts", () => {
  const { content } = build();
  const withReview = (review: Content["settings"]["review"]) => draftOps.settings(content, { ...content.settings, review });
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(reviewAvailable(withReview({ mode: "NEVER", revealAfter: null }), true, now), false);
  assert.equal(reviewAvailable(withReview({ mode: "AFTER_SUBMIT", revealAfter: null }), false, now), false);
  assert.equal(reviewAvailable(withReview({ mode: "AFTER_SUBMIT", revealAfter: null }), true, now), true);
  const later = withReview({ mode: "AFTER_DATE", revealAfter: "2026-07-01T00:00:00Z" });
  assert.equal(reviewAvailable(later, true, now), false);
  assert.equal(reviewAvailable(later, true, new Date("2026-07-02T00:00:00Z")), true);
  assert.equal(reviewContent(content, new Map())[0]!.correctOptionId, content.questions[0]!.correctOptionId);
});

test("the evaluation_workspace panel component is a strict, validated schema", async () => {
  const { northComponentRegistry } = await import("../src/modules/north/content-schema.js");
  const validate = northComponentRegistry["evaluation_workspace@1"]!.validate;
  assert.ok(validate({ views: ["builder", "player", "results"], kind: "EXAM" }).success);
  assert.ok(validate({ views: ["results"] }).success);
  assert.ok(!validate({ views: [] }).success);
  assert.ok(!validate({ views: ["builder"], organizationId: "x" }).success, "no organization or data in the document");
  assert.ok(!validate({ views: ["admin"] }).success);
});
