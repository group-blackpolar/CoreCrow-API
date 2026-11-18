import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contract } from "../contracts/route.js";
import * as s from "../contracts/schemas.js";
import { blocks, settingsSchema } from "../modules/evaluations/content.js";
import { evaluations } from "../modules/evaluations/service.js";

/**
 * Evaluations (ADR 029), under /organizations/:organizationId/evaluations. Authoring needs evaluations.update (it exposes the
 * answer key), publishing evaluations.publish, assignments evaluations.manage, taking evaluations.take plus an assignment,
 * results evaluations.results.read. Nothing here trusts a client-supplied organization, score or key.
 */
const evaluationParams = s.orgParams.extend({ evaluationId: s.id });
const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const attemptParams = s.orgParams.extend({ attemptId: s.id });
const expectedRevision = z.number().int().min(1).optional();
const revisionQuery = z.object({ expectedRevision: z.coerce.number().int().min(1).optional() }).strict();
const kind = z.enum(["EXAM", "FORM"]);
const status = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);

const questionFields = {
  sectionId: itemId, passageId: itemId.nullable().optional(), category: z.string().max(80).nullable().optional(),
  prompt: blocks.optional(), explanation: blocks.optional(), points: z.number().min(0).max(1_000).optional(),
  /** Any number of options (2 to 12 to publish), identified to people by letters A, B, C ... by position. */
  options: z.array(z.object({ id: itemId.optional(), text: z.string().max(2_000) }).strict()).max(12).optional(),
  correctOptionId: itemId.nullable().optional(),
};
const createQuestion = z.object({ ...questionFields, expectedRevision }).strict();
const updateQuestion = z.object({ ...questionFields, sectionId: itemId.optional(), expectedRevision }).strict();
const order = z.object({ ids: z.array(itemId).max(500), expectedRevision }).strict();
const draftResult = z.object({ draftRevision: z.number().int(), id: z.string().optional() });

const authorView = z.object({
  id: s.id, key: z.string().nullable(), kind, title: z.string(), description: z.string().nullable(), status, draftRevision: z.number().int(), publishedRevision: z.number().int().nullable(),
  currentVersionId: z.string().nullable(), hasUnpublishedChanges: z.boolean(), content: z.unknown(), createdAt: s.date, updatedAt: s.date,
});
const versionSummary = z.object({ id: s.id, version: z.number().int(), publishedAt: s.date, questionCount: z.number().int(), maxPoints: z.number() });
const attemptView = z.object({
  id: s.id, evaluationId: s.id, status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]), attemptNumber: z.number().int(), startedAt: s.date, deadlineAt: s.date.nullable(), serverTime: s.date,
  evaluation: z.unknown(), remainingSeconds: z.number().nullable(), pacing: z.object({ navigation: z.enum(["FREE", "FORWARD_ONLY"]), questionSeconds: z.number().int().nullable() }),
  /** Paced attempts only: how many questions are closed, which one is open and until when (server clock). */
  progress: z.unknown(), current: z.unknown(),
  /** The evaluation as a person taking it sees it: no correct option, no explanations. Null once the attempt is closed. */
  content: z.unknown(), answers: z.array(z.object({ questionId: z.string(), optionId: z.string().nullable(), seq: z.number().int() })), result: z.unknown(),
});
const group = z.object({ key: z.string().nullable(), title: z.string().nullable(), correct: z.number().int(), incorrect: z.number().int(), unanswered: z.number().int(), timedOut: z.number().int(), scorePoints: z.number(), maxPoints: z.number(), percent: z.number() });
const resultView = z.object({
  attemptId: s.id, evaluationId: s.id, status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]), submittedAt: s.date.nullable(),
  correct: z.number().int(), incorrect: z.number().int(), unanswered: z.number().int(), timedOut: z.number().int(), scorePoints: z.number(), maxPoints: z.number(), percent: z.number(), timeUsedSeconds: z.number().int(),
  breakdown: z.object({ byCategory: z.array(group), bySection: z.array(group) }),
  review: z.object({ available: z.boolean(), policy: z.enum(["NEVER", "AFTER_SUBMIT", "AFTER_DATE"]), availableAt: z.string().nullable(), items: z.unknown() }),
});

export async function evaluationRoutes(app: FastifyInstance) {
  const base = "/organizations/:organizationId/evaluations";
  const tag = "Evaluations";

  // ----------------------------------------------------------------------------------------------------------- taking
  contract(app, { method: "GET", url: `${base}/available`, tag, summary: "Evaluations assigned to the caller (needs evaluations.take)", params: s.orgParams,
    response: z.array(z.object({ id: s.id, kind, title: z.string(), description: z.string().nullable(), durationMinutes: z.number().nullable(), questionCount: z.number().int(), maxAttempts: z.number().nullable(), pacing: z.object({ navigation: z.enum(["FREE", "FORWARD_ONLY"]), questionSeconds: z.number().int().nullable() }), sectionCount: z.number().int(), attemptsUsed: z.number().int(), openAttemptId: z.string().nullable(), opensAt: s.date.nullable(), closesAt: s.date.nullable(), canStart: z.boolean() })),
    run: ({ user, params }) => evaluations.available(user.id, params.organizationId) });
  contract(app, { method: "POST", url: `${base}/:evaluationId/attempts`, tag, summary: "Start an attempt, or resume the one in progress; the content carries no answer key", params: evaluationParams, response: attemptView,
    rateLimit: 30, run: ({ user, params }) => evaluations.startAttempt(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "GET", url: `${base}/:evaluationId/my-attempts`, tag, summary: "The caller's attempts of one evaluation", params: evaluationParams,
    response: z.array(z.object({ id: s.id, attemptNumber: z.number().int(), status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]), startedAt: s.date, submittedAt: s.date.nullable() })),
    run: ({ user, params }) => evaluations.myAttempts(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "GET", url: "/organizations/:organizationId/evaluation-attempts/:attemptId", tag, summary: "Own attempt: progress, saved answers, remaining time (closes it if the deadline passed)", params: attemptParams, response: attemptView,
    run: ({ user, params }) => evaluations.getAttempt(user.id, params.organizationId, params.attemptId) });
  contract(app, { method: "PUT", url: "/organizations/:organizationId/evaluation-attempts/:attemptId/answers", tag,
    summary: "Autosave answers. A write whose seq is not newer than the stored one is ignored (reported in `ignored`); the response returns the authoritative state",
    params: attemptParams, rateLimit: 240,
    body: z.object({ answers: z.array(z.object({ questionId: itemId, optionId: itemId.nullable(), seq: z.number().int().min(0).max(2_000_000_000) }).strict()).min(1).max(200) }).strict(),
    response: z.object({ status: z.enum(["IN_PROGRESS", "EXPIRED", "SUBMITTED"]), applied: z.array(z.string()), ignored: z.array(z.string()), answers: z.array(z.object({ questionId: z.string(), optionId: z.string().nullable(), seq: z.number().int() })) }),
    run: ({ user, params, body }) => evaluations.saveAnswers(user.id, params.organizationId, params.attemptId, body.answers) });
  contract(app, { method: "POST", url: "/organizations/:organizationId/evaluation-attempts/:attemptId/confirm", tag,
    summary: "Paced attempts: confirm the answer of the open question (optionId null = close it without answering). Accepted only if the SERVER clock says the question is still open; the response says whether it was accepted and carries the state the server decided",
    params: attemptParams, rateLimit: 240, body: z.object({ questionId: itemId, optionId: itemId.nullable() }).strict(),
    response: z.object({ accepted: z.boolean(), reason: z.enum(["TIMEOUT", "ALREADY_CLOSED", "NOT_CURRENT", "ATTEMPT_CLOSED"]).nullable(), attempt: attemptView }),
    run: ({ user, params, body }) => evaluations.confirmAnswer(user.id, params.organizationId, params.attemptId, body) });
  contract(app, { method: "POST", url: "/organizations/:organizationId/evaluation-attempts/:attemptId/submit", tag, summary: "Finish and grade on the server from the immutable version; repeating it returns the same result", params: attemptParams, response: resultView,
    rateLimit: 30, run: ({ user, params }) => evaluations.submit(user.id, params.organizationId, params.attemptId) });
  contract(app, { method: "GET", url: "/organizations/:organizationId/evaluation-attempts/:attemptId/result", tag, summary: "Result of a closed attempt: the caller's own, or any with evaluations.results.read", params: attemptParams, response: resultView,
    run: ({ user, params }) => evaluations.result(user.id, params.organizationId, params.attemptId) });

  // --------------------------------------------------------------------------------------------------------- authoring
  contract(app, { method: "GET", url: base, tag, summary: "List evaluations (needs evaluations.read; no content, no answer key)", params: s.orgParams, query: z.object({ status: status.optional() }).strict(),
    response: z.array(z.object({ id: s.id, key: z.string().nullable(), kind, title: z.string(), description: z.string().nullable(), status, draftRevision: z.number().int(), questionCount: z.number().int(), currentVersion: z.number().int().nullable(), hasUnpublishedChanges: z.boolean(), updatedAt: s.date })),
    run: ({ user, params, query }) => evaluations.list(user.id, params.organizationId, query.status) });
  contract(app, { method: "POST", url: base, tag, summary: "Create an empty draft", params: s.orgParams, status: 201,
    body: z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,78}$/).optional(), kind: kind.optional(), title: z.string().trim().min(1).max(200), description: z.string().max(2_000).nullable().optional() }).strict(), response: authorView,
    run: ({ user, params, body }) => evaluations.create(user.id, params.organizationId, body) });
  contract(app, { method: "GET", url: `${base}/:evaluationId`, tag, summary: "The editor's view of the draft, including the answer key (needs evaluations.update)", params: evaluationParams, response: authorView,
    run: ({ user, params }) => evaluations.get(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "PATCH", url: `${base}/:evaluationId`, tag, summary: "Edit title, description and settings (duration, attempts, scoring rules, review policy, AI policy)", params: evaluationParams,
    body: z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2_000).nullable().optional(), settings: settingsSchema.optional(), expectedRevision }).strict(), response: authorView,
    run: ({ user, params, body }) => evaluations.updateDetails(user.id, params.organizationId, params.evaluationId, body) });
  contract(app, { method: "DELETE", url: `${base}/:evaluationId`, tag, summary: "Delete a never-published draft (published evaluations are archived instead)", params: evaluationParams, status: 204, response: z.null(),
    run: async ({ user, params, reply }) => { await evaluations.remove(user.id, params.organizationId, params.evaluationId); reply.code(204); return null; } });
  contract(app, { method: "POST", url: `${base}/:evaluationId/duplicate`, tag, summary: "Copy the draft into a new evaluation", params: evaluationParams, status: 201, response: authorView,
    run: ({ user, params }) => evaluations.duplicate(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "POST", url: `${base}/:evaluationId/archive`, tag, summary: "Archive: no new attempts, history kept", params: evaluationParams, response: authorView,
    run: ({ user, params }) => evaluations.archive(user.id, params.organizationId, params.evaluationId, true) });
  contract(app, { method: "POST", url: `${base}/:evaluationId/unarchive`, tag, summary: "Restore an archived evaluation", params: evaluationParams, response: authorView,
    run: ({ user, params }) => evaluations.archive(user.id, params.organizationId, params.evaluationId, false) });

  const sectionParams = evaluationParams.extend({ sectionId: itemId });
  const passageParams = evaluationParams.extend({ passageId: itemId });
  const questionParams = evaluationParams.extend({ questionId: itemId });
  const section = z.object({ title: z.string().max(200), description: z.string().max(2_000).optional(), expectedRevision }).strict();
  const passage = z.object({ title: z.string().max(200), body: blocks, expectedRevision }).strict();

  contract(app, { method: "POST", url: `${base}/:evaluationId/sections`, tag, summary: "Add a section", params: evaluationParams, body: section, response: draftResult, status: 201,
    run: ({ user, params, body }) => evaluations.addSection(user.id, params.organizationId, params.evaluationId, body, body.expectedRevision) });
  contract(app, { method: "PATCH", url: `${base}/:evaluationId/sections/:sectionId`, tag, summary: "Edit a section", params: sectionParams, body: section.partial({ title: true }), response: draftResult,
    run: ({ user, params, body }) => evaluations.updateSection(user.id, params.organizationId, params.evaluationId, params.sectionId, body, body.expectedRevision) });
  contract(app, { method: "DELETE", url: `${base}/:evaluationId/sections/:sectionId`, tag, summary: "Delete an empty section", params: sectionParams, query: revisionQuery, response: draftResult,
    run: ({ user, params, query }) => evaluations.removeSection(user.id, params.organizationId, params.evaluationId, params.sectionId, query.expectedRevision) });
  contract(app, { method: "PUT", url: `${base}/:evaluationId/sections/order`, tag, summary: "Reorder sections: list every section exactly once", params: evaluationParams, body: order, response: draftResult,
    run: ({ user, params, body }) => evaluations.reorderSections(user.id, params.organizationId, params.evaluationId, body.ids, body.expectedRevision) });

  contract(app, { method: "POST", url: `${base}/:evaluationId/passages`, tag, summary: "Add a reference text that several questions can share", params: evaluationParams, body: passage, response: draftResult, status: 201,
    run: ({ user, params, body }) => evaluations.addPassage(user.id, params.organizationId, params.evaluationId, body, body.expectedRevision) });
  contract(app, { method: "PATCH", url: `${base}/:evaluationId/passages/:passageId`, tag, summary: "Edit a reference text", params: passageParams, body: passage.partial({ title: true, body: true }), response: draftResult,
    run: ({ user, params, body }) => evaluations.updatePassage(user.id, params.organizationId, params.evaluationId, params.passageId, body, body.expectedRevision) });
  contract(app, { method: "DELETE", url: `${base}/:evaluationId/passages/:passageId`, tag, summary: "Delete a reference text (its questions are kept, detached from it)", params: passageParams, query: revisionQuery, response: draftResult,
    run: ({ user, params, query }) => evaluations.removePassage(user.id, params.organizationId, params.evaluationId, params.passageId, query.expectedRevision) });

  contract(app, { method: "POST", url: `${base}/:evaluationId/questions`, tag, summary: "Add a single-choice question with any number of options", params: evaluationParams, body: createQuestion, response: draftResult, status: 201,
    run: ({ user, params, body }) => evaluations.addQuestion(user.id, params.organizationId, params.evaluationId, body, body.expectedRevision) });
  contract(app, { method: "PATCH", url: `${base}/:evaluationId/questions/:questionId`, tag, summary: "Edit a question (statement, texts, options, points, category, explanation)", params: questionParams, body: updateQuestion, response: draftResult,
    run: ({ user, params, body }) => evaluations.updateQuestion(user.id, params.organizationId, params.evaluationId, params.questionId, body, body.expectedRevision) });
  contract(app, { method: "DELETE", url: `${base}/:evaluationId/questions/:questionId`, tag, summary: "Delete a question", params: questionParams, query: revisionQuery, response: draftResult,
    run: ({ user, params, query }) => evaluations.removeQuestion(user.id, params.organizationId, params.evaluationId, params.questionId, query.expectedRevision) });
  contract(app, { method: "PUT", url: `${base}/:evaluationId/questions/order`, tag, summary: "Reorder questions: list every question exactly once", params: evaluationParams, body: order, response: draftResult,
    run: ({ user, params, body }) => evaluations.reorderQuestions(user.id, params.organizationId, params.evaluationId, body.ids, body.expectedRevision) });
  contract(app, { method: "PUT", url: `${base}/:evaluationId/questions/:questionId/correct-option`, tag, summary: "Mark the one correct option (audited); never delivered to people taking the evaluation", params: questionParams,
    body: z.object({ optionId: itemId, expectedRevision }).strict(), response: draftResult,
    run: ({ user, params, body }) => evaluations.setCorrectOption(user.id, params.organizationId, params.evaluationId, params.questionId, body.optionId, body.expectedRevision) });

  contract(app, { method: "POST", url: `${base}/:evaluationId/validate`, tag, summary: "Check the draft against the publication rules and list every issue", params: evaluationParams,
    response: z.object({ valid: z.boolean(), draftRevision: z.number().int(), issues: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })) }),
    run: ({ user, params }) => evaluations.validate(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "POST", url: `${base}/:evaluationId/publish`, tag, summary: "Publish the draft as a new immutable version (answer key included); 422 EVALUATION_INVALID if it breaks a rule", params: evaluationParams, response: versionSummary,
    run: ({ user, params }) => evaluations.publish(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "GET", url: `${base}/:evaluationId/versions`, tag, summary: "Published versions (metadata only)", params: evaluationParams, response: z.array(versionSummary.extend({ publishedBy: s.id })),
    run: ({ user, params }) => evaluations.versions(user.id, params.organizationId, params.evaluationId) });

  const assignment = z.object({ role: s.role.optional(), groupId: s.id.optional(), userId: s.id.optional(), opensAt: z.coerce.date().nullable().optional(), closesAt: z.coerce.date().nullable().optional() }).strict();
  contract(app, { method: "GET", url: `${base}/:evaluationId/assignments`, tag, summary: "Who may take it", params: evaluationParams,
    response: z.array(z.object({ role: s.role.optional(), groupId: s.id.optional(), userId: s.id.optional(), opensAt: s.date.nullable(), closesAt: s.date.nullable() })),
    run: ({ user, params }) => evaluations.assignments(user.id, params.organizationId, params.evaluationId) });
  contract(app, { method: "PUT", url: `${base}/:evaluationId/assignments`, tag, summary: "Replace the assignments: each addresses one role, group or person, with an optional window", params: evaluationParams,
    body: z.object({ assignments: z.array(assignment).max(200) }).strict(), response: z.object({ count: z.number().int() }),
    run: ({ user, params, body }) => evaluations.setAssignments(user.id, params.organizationId, params.evaluationId, body.assignments) });
  contract(app, { method: "GET", url: `${base}/:evaluationId/stats`, tag, summary: "Statistics of one version (default: the latest with attempts): completion, score distribution, difficulty per question with distractors, categories, and a per-version comparison (needs evaluations.results.read)", params: evaluationParams,
    query: z.object({ versionId: s.id.optional() }).strict(),
    response: z.object({
      evaluation: z.object({ id: s.id, title: z.string() }),
      versions: z.array(z.object({ id: s.id, version: z.number().int(), publishedAt: s.date, questionCount: z.number().int(), maxPoints: z.number(), attempts: z.number().int(), graded: z.number().int(), meanPercent: z.number().nullable() })),
      selectedVersionId: s.id.nullable(), stats: z.unknown(),
    }),
    run: ({ user, params, query }) => evaluations.stats(user.id, params.organizationId, params.evaluationId, query.versionId) });
  contract(app, { method: "GET", url: "/organizations/:organizationId/evaluation-results/mine", tag, summary: "The caller's own closed attempts with scores across evaluations (their history)", params: s.orgParams,
    response: z.array(z.object({ attemptId: s.id, evaluationId: s.id, title: z.string(), kind, attemptNumber: z.number().int(), status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]), submittedAt: s.date.nullable(), scorePoints: z.number(), maxPoints: z.number(), percent: z.number() })),
    run: ({ user, params }) => evaluations.myResults(user.id, params.organizationId) });
  contract(app, { method: "GET", url: `${base}/:evaluationId/attempts`, tag, summary: "Every attempt with its score (needs evaluations.results.read)", params: evaluationParams,
    response: z.array(z.object({ id: s.id, userId: s.id, name: z.string().nullable(), email: z.string().nullable(), versionId: s.id, attemptNumber: z.number().int(), status: z.enum(["IN_PROGRESS", "SUBMITTED", "EXPIRED"]), startedAt: s.date, submittedAt: s.date.nullable(), scorePoints: z.number().nullable(), maxPoints: z.number().nullable(), percent: z.number().nullable() })),
    run: ({ user, params }) => evaluations.attempts(user.id, params.organizationId, params.evaluationId) });
}
