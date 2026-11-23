import { optionLabel, toCenti, type Content, type Question } from "./content.js";

/**
 * Pure, deterministic grading from an immutable version. Integer arithmetic in hundredths of a point; the client never sends
 * (and the server never trusts) a score. Rules come from the version's own `settings.scoring`.
 */
/** `unanswered` counts OMITTED questions (closed voluntarily without an answer); `timedOut` counts invalid_timeout (not confirmed before the deadline). */
export type Tally = { correct: number; incorrect: number; unanswered: number; timedOut: number; scoreCenti: number; maxScoreCenti: number };
export type Outcome = "correct" | "incorrect" | "omitted" | "invalid_timeout";
const FIELD = { correct: "correct", incorrect: "incorrect", omitted: "unanswered", invalid_timeout: "timedOut" } as const;
export type GroupTally = Tally & { key: string | null; title?: string };
export type GradeResult = Tally & { breakdown: { byCategory: GroupTally[]; bySection: GroupTally[] } };

const empty = (): Tally => ({ correct: 0, incorrect: 0, unanswered: 0, timedOut: 0, scoreCenti: 0, maxScoreCenti: 0 });
const penalty = (pointsCenti: number, percent: number) => Math.round((pointsCenti * percent) / 100);

export function questionOutcome(question: Question, optionId: string | null | undefined, timedOut = false): Outcome {
  if (timedOut) return "invalid_timeout";
  if (optionId == null) return "omitted";
  return optionId === question.correctOptionId ? "correct" : "incorrect";
}

export function grade(content: Content, answers: ReadonlyMap<string, string | null>, timedOut: ReadonlySet<string> = new Set()): GradeResult {
  const { scoring } = content.settings;
  const total = empty();
  const categories = new Map<string | null, GroupTally>();
  const sections = new Map<string | null, GroupTally>(content.sections.map((section) => [section.id, { ...empty(), key: section.id, title: section.title }]));
  const bucket = (map: Map<string | null, GroupTally>, key: string | null) => { let found = map.get(key); if (!found) { found = { ...empty(), key }; map.set(key, found); } return found; };

  for (const question of content.questions) {
    const pointsCenti = toCenti(question.points);
    const outcome = questionOutcome(question, answers.get(question.id), timedOut.has(question.id));
    const delta = outcome === "correct" ? pointsCenti : -penalty(pointsCenti, outcome === "incorrect" ? scoring.wrongPenaltyPercent : scoring.unansweredPenaltyPercent);
    for (const tally of [total, bucket(categories, question.category), bucket(sections, question.sectionId)]) {
      tally[FIELD[outcome]] += 1;
      tally.scoreCenti += delta;
      tally.maxScoreCenti += pointsCenti;
    }
  }
  const floor = <T extends Tally>(tally: T): T => { if (scoring.floorAtZero) tally.scoreCenti = Math.max(0, tally.scoreCenti); return tally; };
  floor(total);
  return { ...total, breakdown: { byCategory: [...categories.values()].map(floor), bySection: [...sections.values()].map(floor) } };
}

export const percentOf = (scoreCenti: number, maxScoreCenti: number) => (maxScoreCenti > 0 ? Math.round((scoreCenti * 10_000) / maxScoreCenti) / 100 : 0);

/** What a person taking the evaluation receives: statement, texts and options, never the key or the explanation. */
export function playerContent(content: Content) {
  return {
    settings: { durationMinutes: content.settings.durationMinutes, aiAllowedDuringAttempt: content.settings.ai.allowedDuringAttempt },
    sections: content.sections,
    passages: content.passages,
    questions: content.questions.map((question) => ({
      id: question.id, sectionId: question.sectionId, passageId: question.passageId, category: question.category,
      prompt: question.prompt, points: question.points,
      options: question.options.map((option, index) => ({ id: option.id, label: optionLabel(index), text: option.text })),
    })),
  };
}

export function reviewAvailable(content: Content, attemptClosed: boolean, now: Date) {
  const { mode, revealAfter } = content.settings.review;
  if (!attemptClosed || mode === "NEVER") return false;
  return mode === "AFTER_SUBMIT" || Boolean(revealAfter && now.getTime() >= Date.parse(revealAfter));
}

/** The review of a closed attempt: statement, options, the person's choice, the correct option and the explanation, only when the policy allows it. */
export function reviewContent(content: Content, answers: ReadonlyMap<string, string | null>, timedOut: ReadonlySet<string> = new Set(), seconds: ReadonlyMap<string, number> = new Map()) {
  return content.questions.map((question, index) => ({
    questionId: question.id,
    number: index + 1,
    prompt: question.prompt,
    options: question.options.map((option, position) => ({ id: option.id, label: optionLabel(position), text: option.text })),
    selectedOptionId: answers.get(question.id) ?? null,
    correctOptionId: question.correctOptionId,
    outcome: questionOutcome(question, answers.get(question.id), timedOut.has(question.id)),
    explanation: question.explanation,
    competency: question.category, topic: question.topic, difficulty: question.difficulty, reference: question.reference, seconds: seconds.get(question.id) ?? null,
  }));
}
