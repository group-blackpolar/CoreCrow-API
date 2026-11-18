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

test("statistics: distribution, median, completion, difficulty per question with distractors, categories", async () => {
  const { buildStats, distribution, median } = await import("../src/modules/evaluations/stats.js");
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), null);
  const buckets = distribution([0, 9.99, 10, 55, 100, 100]);
  assert.deepEqual([buckets[0]!.count, buckets[1]!.count, buckets[5]!.count, buckets[9]!.count], [2, 1, 1, 2], "100 % falls in the last bucket");

  const { content, ids } = build([4, 3, 5]);
  const right = content.questions.map((q) => q.correctOptionId!);
  const wrong = content.questions.map((q) => q.options.find((o) => o.id !== q.correctOptionId)!.id);
  const result = (picks: Array<"right" | "wrong" | null>) => grade(content, answersFor(content, picks));
  const rows = [result(["right", "right", "right"]), result(["right", "wrong", null]), result(["wrong", "wrong", null])].map((g) => ({ ...g, timeUsedSeconds: 60 }));
  const answers = [
    { questionId: ids[0]!, optionId: right[0]!, count: 2 }, { questionId: ids[0]!, optionId: wrong[0]!, count: 1 },
    { questionId: ids[1]!, optionId: right[1]!, count: 1 }, { questionId: ids[1]!, optionId: wrong[1]!, count: 2 },
    { questionId: ids[2]!, optionId: right[2]!, count: 1 },
  ];
  const stats = buildStats(content, rows, answers, { inProgress: 1, submitted: 2, expired: 1 });
  assert.deepEqual([stats.attempts.started, stats.attempts.graded, stats.attempts.completionRate, stats.attempts.timedOutRate], [4, 3, 75, 25]);
  assert.deepEqual([stats.score.meanPercent, stats.score.medianPercent, stats.score.minPercent, stats.score.maxPercent], [44.44, 33.33, 0, 100]);
  assert.equal(stats.averageTimeSeconds, 60);
  const [q1, q2, q3] = stats.questions;
  assert.deepEqual([q1!.correctRate, q2!.correctRate, q3!.correctRate], [66.67, 33.33, 33.33]);
  assert.deepEqual([q3!.omitted, q3!.correct, q3!.incorrect], [2, 1, 0]);
  assert.deepEqual(q1!.options.filter((o) => o.picked > 0).map((o) => [o.label, o.picked, o.isCorrect]).sort(), [["A", 1, false], ["B", 2, true]].sort());
  assert.deepEqual(stats.hardest.slice(0, 2), [ids[1], ids[2]], "hardest first, ties by position");
  assert.equal(stats.categories.find((c) => c.category === null)!.unanswered, 2);
  const none = buildStats(content, [], [], { inProgress: 0, submitted: 0, expired: 0 });
  assert.deepEqual([none.attempts.completionRate, none.score.meanPercent, none.averageTimeSeconds, none.hardest], [null, null, null, []]);
});
