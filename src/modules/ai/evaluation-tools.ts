// Assistant tools for evaluations (Phase 7). They run as the signed-in user through the SAME evaluations service the product uses, are only offered to
// people holding evaluations.update (a person who merely takes evaluations never receives them), never read or return an answer key, and the only
// mutation is a PROPOSAL: questions are added as AI drafts after the user confirms the card, and a person must review each one before publishing.
import { z } from "zod";
import { fail } from "../../shared/errors.js";
import { evaluations } from "../evaluations/service.js";
import type { Block } from "../evaluations/content.js";
import type { RegisteredAITool } from "./tool-registry.js";

const id = z.string().min(1).max(128);
const para = (text: string): Block[] => text.trim() ? [{ type: "paragraph", text: text.trim() }] : [];
const textOf = (blocks: Block[]) => blocks.flatMap((block) => (block.type === "paragraph" ? [block.text] : [])).join(" ").replace(/\s+/g, " ");

const draftQuestion = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  options: z.array(z.string().trim().min(1).max(500)).min(2).max(6),
  correctIndex: z.number().int().min(0).max(5).describe("Zero-based position of the correct option; the author will verify it"),
  explanation: z.string().trim().max(2_000).optional(),
  category: z.string().trim().max(80).optional(),
}).strict().refine((question) => question.correctIndex < question.options.length, "correctIndex must point to one of the options");

export const evaluationAITools: RegisteredAITool[] = [
  {
    name: "evaluations.list",
    description: "List the organization's evaluations (id, title, kind, status, number of questions). Requires permission to read evaluations.",
    application: "north", risk: "read", requiredPermissions: ["evaluations.read"],
    input: z.object({}).strict(),
    handler: async (context) => (await evaluations.list(context.userId, context.organizationId)).map((row) => ({ id: row.id, title: row.title, kind: row.kind, status: row.status, questions: row.questionCount })),
  },
  {
    name: "evaluations.outline",
    description: "Read the structure of one evaluation you can edit: sections, reference texts and question statements. It never includes the answer key or explanations.",
    application: "north", risk: "read", requiredPermissions: ["evaluations.update"],
    input: z.object({ evaluationId: id }).strict(),
    handler: async (context, raw) => {
      const view = await evaluations.get(context.userId, context.organizationId, (raw as { evaluationId: string }).evaluationId);
      const c = view.content;
      return {
        id: view.id, title: view.title, kind: view.kind, status: view.status,
        sections: c.sections.map((section) => ({ id: section.id, title: section.title })),
        passages: c.passages.map((passage) => ({ id: passage.id, title: passage.title })),
        questions: c.questions.map((question, index) => ({ number: index + 1, sectionId: question.sectionId, passageId: question.passageId, category: question.category, statement: textOf(question.prompt).slice(0, 240), options: question.options.length, pendingAIReview: question.aiDraft === true })),
      };
    },
  },
  {
    name: "evaluations.draft_questions",
    description: "Propose up to 8 single-choice question drafts for an evaluation you can edit (use ids from evaluations.outline). Nothing changes until the user confirms the card; confirmed questions are added to the DRAFT marked as AI drafts and must be reviewed by a person before the evaluation can be published. Never include copyrighted text verbatim.",
    application: "north", risk: "mutation", requiredPermissions: ["evaluations.update"],
    input: z.object({ evaluationId: id, sectionId: id, passageId: id.nullable().optional(), questions: z.array(draftQuestion).min(1).max(8) }).strict(),
    summarize: (input) => { const value = input as { questions: unknown[] }; return `Add ${value.questions.length} question draft(s) written by the assistant (they need your review before publishing)`; },
    precheck: async (context, raw) => {
      const input = raw as { evaluationId: string; sectionId: string; passageId?: string | null };
      const view = await evaluations.get(context.userId, context.organizationId, input.evaluationId);
      if (view.status === "ARCHIVED") fail(409, "AI_EVALUATION_ARCHIVED", "The evaluation is archived");
      if (!view.content.sections.some((section) => section.id === input.sectionId)) fail(422, "AI_SECTION_UNKNOWN", "The section does not exist in this evaluation");
      if (input.passageId && !view.content.passages.some((passage) => passage.id === input.passageId)) fail(422, "AI_PASSAGE_UNKNOWN", "The reference text does not exist in this evaluation");
    },
    handler: async (context, raw) => {
      const input = raw as { evaluationId: string; sectionId: string; passageId?: string | null; questions: Array<z.infer<typeof draftQuestion>> };
      let added = 0;
      for (const question of input.questions) {
        const created = await evaluations.addQuestion(context.userId, context.organizationId, input.evaluationId, {
          sectionId: input.sectionId, passageId: input.passageId ?? null, category: question.category ?? null, prompt: para(question.prompt), explanation: para(question.explanation ?? ""),
          options: question.options.map((text) => ({ text })), aiDraft: true,
        });
        const draft = await evaluations.get(context.userId, context.organizationId, input.evaluationId);
        const option = draft.content.questions.find((q) => q.id === created.id)?.options[question.correctIndex];
        if (option) await evaluations.setCorrectOption(context.userId, context.organizationId, input.evaluationId, created.id!, option.id);
        added += 1;
      }
      return { added, evaluationId: input.evaluationId, reviewRequired: true };
    },
  },
];
