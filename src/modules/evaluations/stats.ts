import { optionLabel, type Content } from "./content.js";
import { percentOf } from "./grading.js";

/**
 * Pure statistics over graded attempts of ONE version (questions and keys differ between versions, so they are never mixed).
 * Inputs are what the database aggregates: results, per-option answer counts and attempt counts by status.
 */
export type ResultRow = { scoreCenti: number; maxScoreCenti: number; timeUsedSeconds: number; breakdown: { byCategory: Array<{ key: string | null; correct: number; incorrect: number; unanswered: number; scoreCenti: number; maxScoreCenti: number }> } };
export type AnswerCount = { questionId: string; optionId: string | null; count: number };
export type StatusCounts = { inProgress: number; submitted: number; expired: number };

export const BUCKETS = 10;
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
export function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Ten equal buckets of percent (0–10, …, 90–100); 100 % belongs to the last one. */
export function distribution(percents: readonly number[]) {
  const counts = Array.from({ length: BUCKETS }, () => 0);
  for (const percent of percents) counts[Math.min(BUCKETS - 1, Math.max(0, Math.floor(percent / (100 / BUCKETS))))]! += 1;
  return counts.map((count, index) => ({ from: index * 10, to: (index + 1) * 10, count }));
}

export function buildStats(content: Content, results: readonly ResultRow[], answers: readonly AnswerCount[], status: StatusCounts) {
  const percents = results.map((row) => percentOf(row.scoreCenti, row.maxScoreCenti));
  const graded = results.length;
  const started = status.inProgress + status.submitted + status.expired;
  const mean = graded ? round(percents.reduce((sum, value) => sum + value, 0) / graded) : null;

  const byQuestion = new Map<string, Map<string | null, number>>();
  for (const answer of answers) {
    const options = byQuestion.get(answer.questionId) ?? new Map<string | null, number>();
    options.set(answer.optionId, (options.get(answer.optionId) ?? 0) + answer.count);
    byQuestion.set(answer.questionId, options);
  }
  const questions = content.questions.map((question, index) => {
    const counts = byQuestion.get(question.id) ?? new Map<string | null, number>();
    const answered = [...counts.entries()].reduce((sum, [option, count]) => sum + (option ? count : 0), 0);
    const correct = counts.get(question.correctOptionId) ?? 0;
    const omitted = Math.max(0, graded - answered);
    return {
      questionId: question.id, number: index + 1, category: question.category, prompt: question.prompt.find((block) => block.type === "paragraph")?.text.slice(0, 140) ?? "",
      attempts: graded, correct, incorrect: answered - correct, omitted,
      correctRate: graded ? round((correct * 100) / graded) : null,
      // Distractor analysis: how often each option was picked, and whether it is the key.
      options: question.options.map((option, position) => ({ id: option.id, label: optionLabel(position), picked: counts.get(option.id) ?? 0, isCorrect: option.id === question.correctOptionId })),
    };
  });
  // Hardest first (lowest correct rate); unanswered-by-all questions without data sort last.
  const hardest = [...questions].filter((q) => q.correctRate !== null).sort((a, b) => a.correctRate! - b.correctRate! || a.number - b.number).slice(0, 10).map((q) => q.questionId);

  const categories = new Map<string | null, { correct: number; incorrect: number; unanswered: number; score: number; max: number }>();
  for (const row of results) for (const group of row.breakdown.byCategory) {
    const total = categories.get(group.key) ?? { correct: 0, incorrect: 0, unanswered: 0, score: 0, max: 0 };
    total.correct += group.correct; total.incorrect += group.incorrect; total.unanswered += group.unanswered; total.score += group.scoreCenti; total.max += group.maxScoreCenti;
    categories.set(group.key, total);
  }

  return {
    attempts: { started, inProgress: status.inProgress, submitted: status.submitted, expired: status.expired, graded, completionRate: started ? round(((status.submitted + status.expired) * 100) / started) : null, timedOutRate: started ? round((status.expired * 100) / started) : null },
    score: { meanPercent: mean, medianPercent: median(percents) === null ? null : round(median(percents)!), minPercent: graded ? Math.min(...percents) : null, maxPercent: graded ? Math.max(...percents) : null, distribution: distribution(percents) },
    averageTimeSeconds: graded ? Math.round(results.reduce((sum, row) => sum + row.timeUsedSeconds, 0) / graded) : null,
    questions, hardest,
    categories: [...categories.entries()].map(([key, total]) => ({ category: key, correct: total.correct, incorrect: total.incorrect, unanswered: total.unanswered, meanPercent: percentOf(total.score, total.max) })).sort((a, b) => a.meanPercent - b.meanPercent),
  };
}
