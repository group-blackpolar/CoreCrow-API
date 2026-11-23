import { z } from "zod";

/**
 * ADR 029. The evaluation content document. This schema is *structural* and draft-safe (an author may save an unfinished
 * question); completeness rules (exactly one correct option, at least two options, ...) are enforced at publication by
 * validation.ts. Text is plain text: nothing here is ever interpreted as markup. Points are held in hundredths ("centi")
 * wherever they are stored or summed, so scoring is integer arithmetic.
 */
export const MAX_OPTIONS = 12;
export const MAX_QUESTIONS = 500;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const text = (max: number) => z.string().max(max);

export const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: text(20_000) }).strict(),
  z.object({ type: z.literal("list"), ordered: z.boolean().optional(), items: z.array(text(2_000)).max(50) }).strict(),
  // A North asset of the same organization (validated by the caller that stores the document).
  z.object({ type: z.literal("image"), assetId: z.string().min(1).max(128), alt: text(500), caption: text(500).optional() }).strict(),
  z.object({ type: z.literal("table"), header: z.array(text(200)).max(20), rows: z.array(z.array(text(500)).max(20)).max(200) }).strict(),
]);
export const blocks = z.array(block).max(100);

export const optionSchema = z.object({ id, text: text(2_000) }).strict();
const category = text(80).nullable();
/** Points in whole hundredths of a point, strictly positive at publication. */
const points = z.number().min(0).max(1_000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "At most two decimals");

export const questionSchema = z.object({
  id,
  sectionId: id,
  passageId: id.nullable(),
  /** Competency / category used for the per-category result breakdown. */
  category,
  prompt: blocks,
  options: z.array(optionSchema).max(MAX_OPTIONS),
  /** Exactly one correct option at publication; null while drafting. Never delivered to a person taking the evaluation. */
  correctOptionId: id.nullable(),
  explanation: blocks,
  points,
  /** ADR 032 pedagogical tags (all optional, used by the feedback service and the review): evaluated topic, skill ids (see `skills`), difficulty, pointer to the study material. */
  topic: text(120).nullable().default(null),
  skills: z.array(id).max(10).default([]),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]).nullable().default(null),
  reference: text(300).nullable().default(null),
}).strict();

/** A skill a question exercises. The wording is DATA (authored per evaluation): the feedback service only assembles it with the person's real results. */
export const skillSchema = z.object({
  id,
  /** Competency (question.category) the skill belongs to. */
  competency: text(80),
  label: text(120),
  /** Completes "Demostraste que puedes ..." */
  strength: text(240),
  /** Completes "Presentaste dificultades para ..." */
  gap: text(240),
  /** What to study. */
  study: text(300),
  /** A concrete strategy to improve. */
  strategy: text(300),
}).strict();

export const sectionSchema = z.object({ id, title: text(200), description: text(2_000).optional() }).strict();
export const passageSchema = z.object({ id, title: text(200), body: blocks }).strict();

/** FREE: the person moves between questions and answers any time before submitting (autosaved). FORWARD_ONLY: questions open one at a
 *  time in order, each answer must be CONFIRMED to the server before it closes, closed questions can never be reopened, and each question
 *  has its own server-timed limit. */
export const pacingSchema = z.object({
  navigation: z.enum(["FREE", "FORWARD_ONLY"]),
  questionSeconds: z.number().int().min(5).max(3_600).nullable(),
  /** ADR 032: limit of each section (session), counted from the instant its first question opens. null = no per-session limit. */
  sessionMinutes: z.number().int().min(1).max(1_440).nullable().default(null),
}).strict();

/** Internal performance levels (NOT an official scale): ordered by minPercent; the level of a percentage is the highest one whose minPercent it reaches. */
export const levelSchema = z.object({ key: id, label: text(40), minPercent: z.number().min(0).max(100), summary: text(400).optional() }).strict();
export const defaultLevels = (): Array<z.infer<typeof levelSchema>> => [
  { key: "low", label: "Bajo", minPercent: 0 }, { key: "basic", label: "Básico", minPercent: 40 },
  { key: "high", label: "Alto", minPercent: 60 }, { key: "superior", label: "Superior", minPercent: 80 },
];

export const settingsSchema = z.object({
  durationMinutes: z.number().int().min(1).max(1_440).nullable(),
  /** null = unlimited. */
  maxAttempts: z.number().int().min(1).max(100).nullable(),
  scoring: z.object({
    wrongPenaltyPercent: z.number().min(0).max(100),
    unansweredPenaltyPercent: z.number().min(0).max(100),
    floorAtZero: z.boolean(),
  }).strict(),
  /** When a person may see the correct answers and explanations: never, right after submitting, or after a date. */
  review: z.object({ mode: z.enum(["NEVER", "AFTER_SUBMIT", "AFTER_DATE"]), revealAfter: z.string().datetime({ offset: true }).nullable() }).strict(),
  ai: z.object({ allowedDuringAttempt: z.boolean() }).strict(),
  /** Optional in stored documents (older versions are FREE). */
  pacing: pacingSchema.default({ navigation: "FREE", questionSeconds: null, sessionMinutes: null }),
  performance: z.object({ levels: z.array(levelSchema).min(1).max(8) }).strict().default({ levels: defaultLevels() }),
}).strict();

export const contentSchema = z.object({
  schemaVersion: z.literal(1),
  settings: settingsSchema,
  sections: z.array(sectionSchema).max(100),
  passages: z.array(passageSchema).max(500),
  questions: z.array(questionSchema).max(MAX_QUESTIONS),
  skills: z.array(skillSchema).max(200).default([]),
}).strict();

export type Block = z.infer<typeof block>;
export type Option = z.infer<typeof optionSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Section = z.infer<typeof sectionSchema>;
export type Passage = z.infer<typeof passageSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Content = z.infer<typeof contentSchema>;

export const defaultSettings = (): Settings => ({
  durationMinutes: null,
  maxAttempts: 1,
  scoring: { wrongPenaltyPercent: 0, unansweredPenaltyPercent: 0, floorAtZero: true },
  review: { mode: "AFTER_SUBMIT", revealAfter: null },
  ai: { allowedDuringAttempt: false },
  pacing: { navigation: "FREE", questionSeconds: null, sessionMinutes: null },
  performance: { levels: defaultLevels() },
});

export const emptyContent = (): Content => ({ schemaVersion: 1, settings: defaultSettings(), sections: [], passages: [], questions: [], skills: [] });

/** Options are identified to people by letters, by position: A, B, C ... (not stored, so reordering never leaves stale labels). */
export const optionLabel = (index: number) => String.fromCharCode(65 + index);

export const toCenti = (value: number) => Math.round(value * 100);

/** Level of a percentage under the evaluation's own thresholds (levels sorted ascending by minPercent). */
export function levelOf(levels: Settings["performance"]["levels"], percent: number) {
  const sorted = [...levels].sort((a, b) => a.minPercent - b.minPercent);
  return [...sorted].reverse().find((level) => percent >= level.minPercent) ?? sorted[0]!;
}
