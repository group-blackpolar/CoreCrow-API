import assert from "node:assert/strict";
import test from "node:test";
import { contentSchema, levelOf, type Content } from "../src/modules/evaluations/content.js";
import { buildFeedback } from "../src/modules/evaluations/feedback.js";
import { grade, questionOutcome } from "../src/modules/evaluations/grading.js";
import { planPaced } from "../src/modules/evaluations/paced.js";
import { validateForPublish } from "../src/modules/evaluations/validation.js";

// @ts-expect-error plain ESM definition without type declarations
const definition = (await import("../scripts/evaluations/lectura-critica-naranja-lima-02.mjs")).default;

/** Builds the stored content the importer would produce from the definition (ids are positional here). */
function contentOf(): { content: Content; keys: string[] } {
  const sections: Content["sections"] = [], passages: Content["passages"] = [], questions: Content["questions"] = [], keys: string[] = [];
  definition.sections.forEach((section: any, s: number) => {
    sections.push({ id: `s${s}`, title: section.title });
    if (section.passage) passages.push({ id: `p${s}`, title: section.passage.title, body: section.passage.body });
    section.questions.forEach((question: any) => {
      const id = `q${questions.length + 1}`;
      const options = question.options.map((text: string, i: number) => ({ id: `${id}${"abcd"[i]}`, text }));
      questions.push({ id, sectionId: `s${s}`, passageId: section.passage ? `p${s}` : null, category: question.category, prompt: question.prompt, options, correctOptionId: options["ABCD".indexOf(question.correct)].id, explanation: question.explanation, points: question.points, topic: question.topic, skills: question.skills, difficulty: question.difficulty, reference: question.reference });
      keys.push(options["ABCD".indexOf(question.correct)].id);
    });
  });
  return { content: contentSchema.parse({ schemaVersion: 1, settings: definition.settings, sections, passages, questions, skills: definition.skills }), keys };
}
const { content, keys } = contentOf();

/** Runs the grading + feedback for a list of wrong question numbers and an optional set of timed-out ones. */
function run(wrong: number[], timedOut: number[] = []) {
  const answers = new Map<string, string | null>();
  content.questions.forEach((question, index) => {
    const number = index + 1;
    answers.set(question.id, wrong.includes(number) ? question.options.find((option) => option.id !== keys[index])!.id : keys[index]!);
  });
  const timeouts = new Set(timedOut.map((number) => `q${number}`));
  const result = grade(content, answers, timeouts);
  const evidence = content.questions.map((question) => ({ questionId: question.id, outcome: questionOutcome(question, answers.get(question.id), timeouts.has(question.id)), seconds: 30 }));
  return { result, feedback: buildFeedback(content, result, evidence) };
}

test("Simulacro 02 definition: 3 sessions of 5, 15 questions, one key each, the exact title, and it passes the publication rules", () => {
  assert.equal(definition.title, "Lectura Critica - Mi planta naranja-lima | Simulacro 02");
  assert.deepEqual(definition.sections.map((section: any) => section.questions.length), [5, 5, 5]);
  assert.equal(keys.length, 15);
  assert.deepEqual(validateForPublish(content), []);
  assert.equal(content.settings.pacing.questionSeconds, 120);
  assert.equal(content.settings.pacing.sessionMinutes, 30);
  assert.equal(content.passages.length, 1);
  assert.equal(content.questions.filter((question) => question.passageId).length, 5);
  assert.ok(content.passages[0]!.body.some((block) => block.type === "paragraph" && block.text.includes("cubrirían toda la pantalla del cine Bangú")));
  assert.equal(definition.sections.flatMap((section: any) => section.questions.map((question: any) => question.correct)).join(""), "BDACBDACBDCABDC");
});

test("a perfect run: 100 %, three Superior competencies, no gaps, a consolidation plan of three to five items", () => {
  const { result, feedback } = run([]);
  assert.equal(result.correct, 15);
  assert.equal(feedback.overall.percent, 100);
  assert.deepEqual(feedback.competencies.map((item) => [item.title, item.percent, item.level.label]), [["Comprensión literal", 100, "Superior"], ["Comprensión inferencial", 100, "Superior"], ["Lectura crítica", 100, "Superior"]]);
  assert.ok(feedback.competencies.every((item) => item.paragraph.includes("No se evidenciaron dificultades")));
  assert.ok(feedback.plan.length >= 3 && feedback.plan.length <= 5 && feedback.plan.every((item) => item.priority === "consolidate"));
});

test("thresholds are the evaluation's own: 1/5 is Bajo, 2/5 Básico, 3/5 Alto, 4/5 Superior; a different table changes the level", () => {
  const level = (wrong: number[]) => run(wrong).feedback.competencies[0]!.level.label;
  assert.deepEqual([[2, 3, 4, 5], [3, 4, 5], [4, 5], [5], []].map(level), ["Bajo", "Básico", "Alto", "Superior", "Superior"]);
  assert.equal(levelOf([{ key: "a", label: "A", minPercent: 0 }, { key: "b", label: "B", minPercent: 70 }], 69.9).label, "A");
});

test("the same percentage with different mistakes gives different, evidence-based paragraphs and plans", () => {
  const sequence = run([4]).feedback; // fails only the chronological-order question
  const characters = run([2]).feedback; // fails only the characters question: same 80 %
  assert.equal(sequence.competencies[0]!.percent, characters.competencies[0]!.percent);
  assert.notEqual(sequence.competencies[0]!.paragraph, characters.competencies[0]!.paragraph);
  assert.match(sequence.competencies[0]!.paragraph, /ordenar cronológicamente los sucesos \(la pregunta 4\)/);
  assert.match(sequence.competencies[0]!.paragraph, /línea de tiempo/);
  assert.match(characters.competencies[0]!.paragraph, /relaciones entre los personajes.*\(la pregunta 2\)/);
  assert.doesNotMatch(characters.competencies[0]!.paragraph, /línea de tiempo/);
  assert.equal(sequence.plan[0]!.skillId, "secuencia-cronologica");
  assert.equal(characters.plan[0]!.skillId, "personajes-relaciones");
  assert.deepEqual(sequence.competencies[0]!.reinforceTopics, ["Orden de los sucesos"]);
  assert.ok(sequence.competencies[0]!.masteredTopics.includes("Narrador y perspectiva"));
});

test("it never invents what was not evaluated: only tagged skills of failed questions appear, other competencies stay clean", () => {
  const { feedback } = run([7, 8]);
  const [literal, inferential] = feedback.competencies;
  assert.ok(literal!.paragraph.includes("No se evidenciaron dificultades"));
  assert.match(inferential!.paragraph, /interpretar emociones.*\(la pregunta 7\).*metáforas, hipérboles.*\(la pregunta 8\)|metáforas, hipérboles.*\(la pregunta 8\).*interpretar emociones.*\(la pregunta 7\)/s);
  assert.ok(feedback.plan.length >= 3, "with fewer than three gaps the plan is completed with consolidation items");
  assert.deepEqual(feedback.plan.slice(0, 2).map((item) => item.skillId).sort(), ["emociones-personajes", "lenguaje-figurado"]);
});

test("timeouts and omissions are reported as such, with 0 points, and are not blamed on a skill the student was not tested on", () => {
  const { result, feedback } = run([], [10, 11]);
  assert.equal(result.timedOut, 2);
  assert.match(feedback.competencies[1]!.paragraph, /Una pregunta venció sin respuesta confirmada a tiempo \(la pregunta 10\)/);
  assert.match(feedback.competencies[2]!.paragraph, /Una pregunta venció sin respuesta confirmada a tiempo \(la pregunta 11\)/);
  assert.equal(feedback.competencies[1]!.timedOut, 1);
});

test("feedback is deterministic: the same evidence gives byte-identical output", () => {
  assert.equal(JSON.stringify(run([1, 6, 12]).feedback), JSON.stringify(run([1, 6, 12]).feedback));
});

test("per-session limit: the 30 minutes of a session start when its first question opens and never extend the 120 s of a question", () => {
  const ids = ["a1", "a2", "b1"], sectionOf = ["A", "A", "B"];
  const startedAt = new Date("2026-01-01T10:00:00Z");
  const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000);
  const base = { questionIds: ids, startedAt, questionMs: 120_000, globalDeadline: null, sectionOf, sessionMs: 150_000 };
  // Q1 confirmed at 100 s; Q2 opens at 100 s and the session ends at 150 s (before its own 120 s): it times out at 150 s.
  const rows = [{ questionId: "a1", openedAt: startedAt, closedAt: at(100), closure: "CONFIRMED" as const }];
  const late = planPaced({ ...base, rows, now: at(400) });
  assert.deepEqual(late.timeouts.map((item) => [item.questionId, item.closedAt.getTime() - startedAt.getTime()]), [["a2", 150_000], ["b1", 270_000]]);
  const inside = planPaced({ ...base, rows, now: at(140) });
  assert.equal(inside.current!.questionId, "a2");
  assert.equal(inside.current!.expiresAt!.getTime() - startedAt.getTime(), 150_000);
  // Without a session limit the same question would have had its full 120 s.
  assert.equal(planPaced({ ...base, sessionMs: null, rows, now: at(140) }).current!.expiresAt!.getTime() - startedAt.getTime(), 220_000);
});
