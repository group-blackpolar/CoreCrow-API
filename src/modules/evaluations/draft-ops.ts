import { randomUUID } from "node:crypto";
import { fail } from "../../shared/errors.js";
import { MAX_OPTIONS, MAX_QUESTIONS, type Block, type Content, type Passage, type Question, type Section, type Settings } from "./content.js";

/** Pure, immutable edits of the draft document. The service persists the result with optimistic concurrency. */
const newId = () => randomUUID();
const notFound = (what: string): never => fail(404, "NOT_FOUND", `${what} not found`);

export type QuestionInput = {
  sectionId: string; passageId?: string | null; category?: string | null; prompt?: Block[]; explanation?: Block[]; points?: number;
  options?: Array<{ id?: string; text: string }>; correctOptionId?: string | null;
  topic?: string | null; skills?: string[]; difficulty?: Question["difficulty"]; reference?: string | null;
};

function withOptionIds(options: Array<{ id?: string; text: string }>) {
  const seen = new Set<string>();
  return options.map((option) => {
    const id = option.id && !seen.has(option.id) ? option.id : newId();
    seen.add(id);
    return { id, text: option.text };
  });
}

function checkRefs(content: Content, question: Pick<Question, "sectionId" | "passageId" | "options" | "correctOptionId">) {
  if (!content.sections.some((section) => section.id === question.sectionId)) fail(422, "EVALUATION_SECTION_UNKNOWN", "Section does not exist");
  if (question.passageId && !content.passages.some((passage) => passage.id === question.passageId)) fail(422, "EVALUATION_PASSAGE_UNKNOWN", "Reference text does not exist");
  if (question.options.length > MAX_OPTIONS) fail(422, "EVALUATION_OPTIONS_LIMIT", `At most ${MAX_OPTIONS} options`);
  if (question.correctOptionId && !question.options.some((option) => option.id === question.correctOptionId)) fail(422, "EVALUATION_CORRECT_OPTION_INVALID", "The correct option must be one of the options");
}

export const draftOps = {
  settings(content: Content, settings: Settings): Content { return { ...content, settings }; },

  addSection(content: Content, input: { title: string; description?: string }): { content: Content; id: string } {
    const section: Section = { id: newId(), title: input.title, ...(input.description !== undefined ? { description: input.description } : {}) };
    return { content: { ...content, sections: [...content.sections, section] }, id: section.id };
  },
  updateSection(content: Content, id: string, patch: { title?: string; description?: string }): Content {
    if (!content.sections.some((section) => section.id === id)) notFound("Section");
    return { ...content, sections: content.sections.map((section) => (section.id === id ? { ...section, ...patch } : section)) };
  },
  removeSection(content: Content, id: string): Content {
    if (!content.sections.some((section) => section.id === id)) notFound("Section");
    if (content.questions.some((question) => question.sectionId === id)) fail(409, "EVALUATION_SECTION_NOT_EMPTY", "Move or delete the section's questions first");
    return { ...content, sections: content.sections.filter((section) => section.id !== id) };
  },
  reorderSections(content: Content, ids: string[]): Content { return { ...content, sections: reorder(content.sections, ids, "sections") }; },

  addPassage(content: Content, input: { title: string; body: Block[] }): { content: Content; id: string } {
    const passage: Passage = { id: newId(), title: input.title, body: input.body };
    return { content: { ...content, passages: [...content.passages, passage] }, id: passage.id };
  },
  updatePassage(content: Content, id: string, patch: { title?: string; body?: Block[] }): Content {
    if (!content.passages.some((passage) => passage.id === id)) notFound("Reference text");
    return { ...content, passages: content.passages.map((passage) => (passage.id === id ? { ...passage, ...patch } : passage)) };
  },
  /** Questions that used the text keep existing, detached from it. */
  removePassage(content: Content, id: string): Content {
    if (!content.passages.some((passage) => passage.id === id)) notFound("Reference text");
    return { ...content, passages: content.passages.filter((passage) => passage.id !== id), questions: content.questions.map((question) => (question.passageId === id ? { ...question, passageId: null } : question)) };
  },

  addQuestion(content: Content, input: QuestionInput): { content: Content; id: string } {
    if (content.questions.length >= MAX_QUESTIONS) fail(422, "EVALUATION_QUESTIONS_LIMIT", `At most ${MAX_QUESTIONS} questions`);
    const options = withOptionIds(input.options ?? [{ text: "" }, { text: "" }]);
    const question: Question = {
      id: newId(), sectionId: input.sectionId, passageId: input.passageId ?? null, category: input.category ?? null,
      prompt: input.prompt ?? [], options, correctOptionId: input.correctOptionId ?? null, explanation: input.explanation ?? [], points: input.points ?? 1,
      topic: input.topic ?? null, skills: input.skills ?? [], difficulty: input.difficulty ?? null, reference: input.reference ?? null,
    };
    checkRefs(content, question);
    return { content: { ...content, questions: [...content.questions, question] }, id: question.id };
  },
  updateQuestion(content: Content, id: string, patch: Partial<QuestionInput>): Content {
    const current = content.questions.find((question) => question.id === id) ?? notFound("Question");
    const options = patch.options ? withOptionIds(patch.options) : current.options;
    // Replacing the options drops a correct answer that no longer exists instead of leaving a dangling key (publication then flags it).
    const correct = patch.correctOptionId !== undefined ? patch.correctOptionId : current.correctOptionId;
    const next: Question = {
      ...current,
      ...(patch.sectionId !== undefined ? { sectionId: patch.sectionId } : {}),
      ...(patch.passageId !== undefined ? { passageId: patch.passageId } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.explanation !== undefined ? { explanation: patch.explanation } : {}),
      ...(patch.points !== undefined ? { points: patch.points } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
      ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
      ...(patch.reference !== undefined ? { reference: patch.reference } : {}),
      options,
      correctOptionId: correct && options.some((option) => option.id === correct) ? correct : null,
    };
    if (patch.correctOptionId && next.correctOptionId !== patch.correctOptionId) fail(422, "EVALUATION_CORRECT_OPTION_INVALID", "The correct option must be one of the options");
    checkRefs(content, next);
    return { ...content, questions: content.questions.map((question) => (question.id === id ? next : question)) };
  },
  removeQuestion(content: Content, id: string): Content {
    if (!content.questions.some((question) => question.id === id)) notFound("Question");
    return { ...content, questions: content.questions.filter((question) => question.id !== id) };
  },
  reorderQuestions(content: Content, ids: string[]): Content { return { ...content, questions: reorder(content.questions, ids, "questions") }; },
  setCorrectOption(content: Content, questionId: string, optionId: string): Content { return draftOps.updateQuestion(content, questionId, { correctOptionId: optionId }); },
};

/** A reorder names every sibling exactly once: a stale client list can never drop or duplicate an item. */
function reorder<T extends { id: string }>(items: T[], ids: string[], what: string): T[] {
  if (ids.length !== items.length || new Set(ids).size !== ids.length || !ids.every((id) => items.some((item) => item.id === id)))
    fail(422, "EVALUATION_ORDER_INVALID", `The order must list every one of the ${what} exactly once`);
  return ids.map((id) => items.find((item) => item.id === id)!);
}
