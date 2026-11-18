import { toCenti, type Block, type Content } from "./content.js";

export type Issue = { code: string; path: string; message: string };

const hasText = (blocks: Block[]) => blocks.some((item) => (item.type === "paragraph" ? item.text.trim() : item.type === "list" ? item.items.some((entry) => entry.trim()) : item.type === "table" ? item.rows.length > 0 : true));

/**
 * Publication rules (the backend is the only judge; the editor merely mirrors them). A single-choice question is publishable
 * only with at least two non-empty options and exactly one correct option that exists among them.
 */
export function validateForPublish(content: Content): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const unique = (ids: string[], path: string, code: string) => { if (new Set(ids).size !== ids.length) add(code, path, "Identifiers must be unique"); };

  if (content.questions.length === 0) add("EVALUATION_NO_QUESTIONS", "questions", "An evaluation needs at least one question");
  unique(content.sections.map((item) => item.id), "sections", "EVALUATION_DUPLICATE_ID");
  unique(content.passages.map((item) => item.id), "passages", "EVALUATION_DUPLICATE_ID");
  unique(content.questions.map((item) => item.id), "questions", "EVALUATION_DUPLICATE_ID");
  content.sections.forEach((section, index) => { if (!section.title.trim()) add("EVALUATION_SECTION_TITLE_EMPTY", `sections[${index}]`, "Section needs a title"); });
  content.passages.forEach((passage, index) => { if (!hasText(passage.body)) add("EVALUATION_PASSAGE_EMPTY", `passages[${index}]`, "Reference text is empty"); });

  const sectionIds = new Set(content.sections.map((section) => section.id));
  const passageIds = new Set(content.passages.map((passage) => passage.id));
  content.questions.forEach((question, index) => {
    const path = `questions[${index}]`;
    if (!sectionIds.has(question.sectionId)) add("EVALUATION_SECTION_UNKNOWN", path, "Question belongs to a section that does not exist");
    if (question.passageId && !passageIds.has(question.passageId)) add("EVALUATION_PASSAGE_UNKNOWN", path, "Question uses a reference text that does not exist");
    if (!hasText(question.prompt)) add("EVALUATION_PROMPT_EMPTY", path, "Question needs a statement");
    if (toCenti(question.points) <= 0) add("EVALUATION_POINTS_INVALID", path, "Points must be greater than zero");
    if (question.options.length < 2) add("EVALUATION_OPTIONS_MIN", path, "At least two options are required");
    if (new Set(question.options.map((option) => option.id)).size !== question.options.length) add("EVALUATION_DUPLICATE_ID", `${path}.options`, "Option identifiers must be unique");
    question.options.forEach((option, optionIndex) => { if (!option.text.trim()) add("EVALUATION_OPTION_EMPTY", `${path}.options[${optionIndex}]`, "Option text is empty"); });
    if (question.correctOptionId === null) add("EVALUATION_CORRECT_OPTION_MISSING", path, "Mark exactly one correct option");
    else if (!question.options.some((option) => option.id === question.correctOptionId)) add("EVALUATION_CORRECT_OPTION_INVALID", path, "The correct option is not one of the options");
  });
  // Forward-only attempts run session after session: every section's questions must be contiguous, in the order they are asked.
  if (content.settings.pacing.navigation === "FORWARD_ONLY") {
    const seen = new Set<string>();
    let previous: string | null = null;
    content.questions.forEach((question, index) => {
      if (question.sectionId !== previous) { if (seen.has(question.sectionId)) add("EVALUATION_SECTION_ORDER", `questions[${index}]`, "Questions of a section must be consecutive in a forward-only evaluation"); seen.add(question.sectionId); previous = question.sectionId; }
    });
  }
  if (content.settings.review.mode === "AFTER_DATE" && !content.settings.review.revealAfter) add("EVALUATION_REVIEW_DATE_REQUIRED", "settings.review", "A reveal date is required");
  return issues;
}
