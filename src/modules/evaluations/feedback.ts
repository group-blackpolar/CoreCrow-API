import { levelOf, toCenti, type Content } from "./content.js";
import { percentOf, type GradeResult, type Outcome } from "./grading.js";

/**
 * ADR 032. Deterministic academic feedback, reusable by every evaluation category. Pure: it only reads the immutable version
 * (questions, skills, thresholds) and what the attempt actually did (outcome and time per question). It never changes a score, never
 * names a skill nobody tagged and never sees another person's data. The wording of strengths, gaps, study topics and strategies is
 * DATA authored in the evaluation (`content.skills`); this file only assembles it, so two people with the same percentage but
 * different mistakes receive different paragraphs.
 *
 * A future AI generator would plug in as another `generator` value that receives the same evidence and falls back to this one.
 */
export const GENERATOR = "deterministic-v1";

export type Evidence = { questionId: string; outcome: Outcome; seconds: number | null };
export type CompetencyFeedback = {
  key: string; title: string; correct: number; incorrect: number; omitted: number; timedOut: number; total: number;
  scorePoints: number; maxPoints: number; percent: number; level: { key: string; label: string }; timeSeconds: number | null;
  masteredTopics: string[]; reinforceTopics: string[]; paragraph: string;
};
export type PlanItem = { skillId: string; label: string; competency: string; questions: number[]; study: string; strategy: string; priority: "gap" | "consolidate" };
export type Feedback = { generator: typeof GENERATOR; overall: { percent: number; level: { key: string; label: string } }; competencies: CompetencyFeedback[]; plan: PlanItem[] };

const unique = <T>(items: readonly T[]) => [...new Set(items)];
const join = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`);
const lower = (text: string) => text.replace(/[.\s]+$/, "");
const questionsLabel = (numbers: readonly number[]) => (numbers.length === 1 ? `la pregunta ${numbers[0]}` : `las preguntas ${join(numbers.map(String))}`);
const MAX_PLAN = 5, MIN_PLAN = 3, MAX_SKILLS_IN_PARAGRAPH = 3;

export function buildFeedback(content: Content, result: GradeResult, evidence: readonly Evidence[]): Feedback {
  const levels = content.settings.performance.levels;
  const skillById = new Map(content.skills.map((skill) => [skill.id, skill]));
  const outcomeOf = new Map(evidence.map((item) => [item.questionId, item]));
  const competencies: CompetencyFeedback[] = [];
  const failedBySkill = new Map<string, { competencyIndex: number; numbers: number[] }>();
  const passedSkills: Array<{ skillId: string; competencyIndex: number }> = [];

  const titles = unique(content.questions.flatMap((question) => (question.category ? [question.category] : [])));
  for (const title of titles) {
    const tally = result.breakdown.byCategory.find((group) => group.key === title);
    const questions = content.questions.map((question, index) => ({ question, number: index + 1 })).filter((item) => item.question.category === title);
    const rows = questions.map((item) => ({ ...item, evidence: outcomeOf.get(item.question.id) ?? { questionId: item.question.id, outcome: "omitted" as Outcome, seconds: null } }));
    const failed = rows.filter((row) => row.evidence.outcome !== "correct");
    const percent = tally ? percentOf(tally.scoreCenti, tally.maxScoreCenti) : 0;
    const level = levelOf(levels, percent);
    const index = competencies.length;

    // Skills: a skill is "dominated" when every question that exercised it was right, a "gap" when at least one was not.
    const gapSkills = new Map<string, number[]>();
    for (const row of failed) for (const skillId of row.question.skills) if (skillById.has(skillId)) gapSkills.set(skillId, [...(gapSkills.get(skillId) ?? []), row.number]);
    const dominated = unique(rows.filter((row) => row.evidence.outcome === "correct").flatMap((row) => row.question.skills)).filter((skillId) => skillById.has(skillId) && !gapSkills.has(skillId));
    for (const [skillId, numbers] of gapSkills) failedBySkill.set(skillId, { competencyIndex: index, numbers: [...(failedBySkill.get(skillId)?.numbers ?? []), ...numbers] });
    for (const skillId of dominated) passedSkills.push({ skillId, competencyIndex: index });

    const gaps = [...gapSkills.entries()].sort((a, b) => b[1].length - a[1].length || a[1][0]! - b[1][0]!).slice(0, MAX_SKILLS_IN_PARAGRAPH);
    const untagged = failed.filter((row) => !row.question.skills.some((skillId) => skillById.has(skillId))).map((row) => row.number);
    const timedOut = failed.filter((row) => row.evidence.outcome === "invalid_timeout").map((row) => row.number);
    const omitted = failed.filter((row) => row.evidence.outcome === "omitted").map((row) => row.number);

    const sentences: string[] = [];
    const correct = rows.length - failed.length;
    const levelRow = levels.find((item) => item.key === level.key);
    sentences.push(`Tu desempeño en ${title} es de nivel ${level.label} (${correct} de ${rows.length} aciertos, ${percent} %).${levelRow?.summary ? ` ${levelRow.summary}` : ""}`);
    if (dominated.length) sentences.push(`Demostraste que puedes ${join(dominated.slice(0, 2).map((id) => lower(skillById.get(id)!.strength)))}.`);
    if (gaps.length) {
      sentences.push(`Presentaste dificultades para ${join(gaps.map(([id, numbers]) => `${lower(skillById.get(id)!.gap)} (${questionsLabel(numbers)})`))}.`);
    } else if (!failed.length) sentences.push("No se evidenciaron dificultades en las preguntas evaluadas de esta competencia.");
    if (untagged.length) sentences.push(`Revisa también ${questionsLabel(untagged)}, donde el resultado no fue correcto.`);
    if (timedOut.length) sentences.push(`${timedOut.length === 1 ? "Una pregunta venció" : `${timedOut.length} preguntas vencieron`} sin respuesta confirmada a tiempo (${questionsLabel(timedOut)}): practica administrar el tiempo disponible por pregunta.`);
    if (omitted.length) sentences.push(`Dejaste sin responder ${questionsLabel(omitted)}; si dudas entre dos alternativas, descarta las que contradicen el texto y elige la más sustentada.`);
    if (gaps.length) {
      sentences.push(`Te recomendamos estudiar ${join(unique(gaps.map(([id]) => lower(skillById.get(id)!.study))))}.`);
      sentences.push(`Para mejorar: ${join(unique(gaps.map(([id]) => lower(skillById.get(id)!.strategy))))}.`);
    } else if (!failed.length) {
      const stretch = unique(content.skills.filter((skill) => skill.competency === title).map((skill) => lower(skill.strategy))).slice(0, 2);
      if (stretch.length) sentences.push(`Para consolidar tu dominio: ${join(stretch)}.`);
    }

    const times = rows.map((row) => row.evidence.seconds);
    competencies.push({
      key: title, title, correct, incorrect: tally?.incorrect ?? 0, omitted: tally?.unanswered ?? 0, timedOut: tally?.timedOut ?? 0, total: rows.length,
      scorePoints: (tally?.scoreCenti ?? 0) / 100, maxPoints: (tally?.maxScoreCenti ?? rows.reduce((sum, row) => sum + toCenti(row.question.points), 0)) / 100, percent, level: { key: level.key, label: level.label },
      timeSeconds: times.every((value) => value === null) ? null : Math.round(times.reduce<number>((sum, value) => sum + (value ?? 0), 0)),
      masteredTopics: unique(rows.filter((row) => row.evidence.outcome === "correct" && row.question.topic).map((row) => row.question.topic!)).filter((topic) => !failed.some((row) => row.question.topic === topic)),
      reinforceTopics: unique(failed.flatMap((row) => (row.question.topic ? [row.question.topic] : []))),
      paragraph: sentences.join(" "),
    });
  }

  // Improvement plan: first the skills that actually failed (most failures, then the weakest competency); if fewer than three, consolidate the
  // dominated skills of the weakest competencies. Only skills tagged in the evaluation can appear.
  const plan: PlanItem[] = [...failedBySkill.entries()]
    .sort((a, b) => b[1].numbers.length - a[1].numbers.length || competencies[a[1].competencyIndex]!.percent - competencies[b[1].competencyIndex]!.percent || a[1].numbers[0]! - b[1].numbers[0]!)
    .slice(0, MAX_PLAN)
    .map(([skillId, info]) => item(skillById.get(skillId)!, info.numbers.sort((a, b) => a - b), "gap"));
  if (plan.length < MIN_PLAN) {
    const weakestFirst = [...passedSkills].sort((a, b) => competencies[a.competencyIndex]!.percent - competencies[b.competencyIndex]!.percent);
    for (const { skillId } of weakestFirst) { if (plan.length >= MIN_PLAN) break; if (!plan.some((entry) => entry.skillId === skillId)) plan.push(item(skillById.get(skillId)!, [], "consolidate")); }
  }
  const overallPercent = percentOf(result.scoreCenti, result.maxScoreCenti);
  const overall = levelOf(levels, overallPercent);
  return { generator: GENERATOR, overall: { percent: overallPercent, level: { key: overall.key, label: overall.label } }, competencies, plan };
}

const item = (skill: Content["skills"][number], questions: number[], priority: PlanItem["priority"]): PlanItem => ({ skillId: skill.id, label: skill.label, competency: skill.competency, questions, study: skill.study, strategy: skill.strategy, priority });
