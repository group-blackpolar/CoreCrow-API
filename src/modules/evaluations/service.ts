import { Prisma, type EvaluationKind, type TenantRole } from "../../lib/database.js";
import { DomainError, fail } from "../../shared/errors.js";
import { transaction, type Transaction } from "../../shared/transaction.js";
import { auditRepository as audit } from "../audit/repository.js";
import { authorize, resolvePermissions } from "../authorization/service.js";
import { groupsRepository } from "../authorization/groups-repository.js";
import { identities } from "../identity/repository.js";
import { northAssets } from "../north/asset-service.js";
import { tenantRepository } from "../tenancy/repository.js";
import { contentSchema, emptyContent, toCenti, type Block, type Content } from "./content.js";
import { draftOps, type QuestionInput } from "./draft-ops.js";
import { grade, percentOf, playerContent, reviewAvailable, reviewContent } from "./grading.js";
import { planPaced, type Closure, type PacedPlan } from "./paced.js";
import { buildStats, type AnswerCount } from "./stats.js";
import { validateForPublish } from "./validation.js";

/** Technical constant: allowance for network latency between the deadline and the last autosave/submit that left in time. */
export const CLOSE_GRACE_MS = 10_000;

const notFound = (): never => fail(404, "NOT_FOUND", "Evaluation not found");
const parse = (value: unknown): Content => contentSchema.parse(value);
const json = (value: unknown) => value as Prisma.InputJsonValue;
type Snapshot = { evaluation: { title: string; description: string | null; kind: EvaluationKind }; content: Content };

async function load(tx: Transaction, organizationId: string, id: string) {
  return (await tx.evaluation.findFirst({ where: { id, organizationId } })) ?? notFound();
}

function imageAssetIds(content: Content) {
  const blocks: Block[] = [...content.questions.flatMap((q) => [...q.prompt, ...q.explanation]), ...content.passages.flatMap((p) => p.body)];
  return [...new Set(blocks.flatMap((item) => (item.type === "image" ? [item.assetId] : [])))];
}

const authorView = (ev: Awaited<ReturnType<typeof load>>) => ({
  id: ev.id, key: ev.key, kind: ev.kind, title: ev.title, description: ev.description, status: ev.status,
  draftRevision: ev.draftRevision, publishedRevision: ev.publishedRevision, currentVersionId: ev.currentVersionId,
  hasUnpublishedChanges: ev.publishedRevision === null || ev.draftRevision > ev.publishedRevision,
  content: parse(ev.draft), createdAt: ev.createdAt, updatedAt: ev.updatedAt,
});

/** One optimistic-concurrency draft write: every authoring operation goes through here. */
async function mutate<T extends { id?: string }>(userId: string, organizationId: string, evaluationId: string, op: string, expectedRevision: number | undefined, edit: (content: Content) => { content: Content } & T) {
  return transaction(async (tx) => {
    await authorize(tx, userId, organizationId, "evaluations.update");
    const ev = await load(tx, organizationId, evaluationId);
    if (ev.status === "ARCHIVED") fail(409, "EVALUATION_ARCHIVED", "Archived evaluations cannot be edited");
    if (expectedRevision !== undefined && expectedRevision !== ev.draftRevision) fail(409, "EVALUATION_REVISION_CONFLICT", "The evaluation changed since it was loaded");
    const edited = edit(parse(ev.draft));
    const checked = contentSchema.safeParse(edited.content);
    if (!checked.success) fail(422, "EVALUATION_CONTENT_INVALID", "The content does not match the evaluation schema");
    for (const assetId of imageAssetIds(checked.data!))
      if (!(await northAssets.validateReference(userId, organizationId, assetId, tx))) fail(422, "CROSS_TENANT_RESOURCE", "Image is outside the organization or unavailable");
    const updated = await tx.evaluation.update({ where: { id: ev.id }, data: { draft: json(checked.data), draftRevision: { increment: 1 } } });
    await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_DRAFT_UPDATED", targetType: "Evaluation", targetId: ev.id, metadata: { op, draftRevision: updated.draftRevision } });
    return { draftRevision: updated.draftRevision, ...(edited.id ? { id: edited.id } : {}) };
  });
}
const plain = (content: Content) => ({ content });
const withId = (result: { content: Content; id: string }) => result;

// ---------------------------------------------------------------------------------------------------------------- assignment
type Member = { id: string; role: TenantRole };
async function eligibility(tx: Transaction, organizationId: string, evaluationId: string, member: Member, now: Date) {
  const [rows, groupIds] = await Promise.all([
    tx.evaluationAssignment.findMany({ where: { organizationId, evaluationId } }),
    groupsRepository.groupIdsOf(tx, organizationId, member.id),
  ]);
  const groups = new Set(groupIds);
  const mine = rows.filter((row) => row.role === member.role || row.membershipId === member.id || (row.groupId !== null && groups.has(row.groupId)));
  const open = mine.filter((row) => (!row.opensAt || now >= row.opensAt) && (!row.closesAt || now < row.closesAt));
  const dates = (pick: "opensAt" | "closesAt") => mine.map((row) => row[pick]).filter((value): value is Date => value !== null).sort((a, b) => a.getTime() - b.getTime());
  return { assigned: mine.length > 0, open: open.length > 0, opensAt: dates("opensAt")[0] ?? null, closesAt: dates("closesAt").at(-1) ?? null };
}

// ----------------------------------------------------------------------------------------------------------------- attempts
type AttemptRow = { id: string; organizationId: string; evaluationId: string; versionId: string; userId: string; startedAt: Date; deadlineAt: Date | null; status?: string };
const isPaced = (content: Content) => content.settings.pacing.navigation === "FORWARD_ONLY";

/** What grading needs: the confirmed answers, and (paced) every question that was not confirmed or omitted in time = invalid_timeout. */
async function gradingInput(tx: Transaction, attemptId: string, content: Content) {
  const rows = await tx.evaluationAnswer.findMany({ where: { attemptId } });
  if (!isPaced(content)) return { answers: new Map<string, string | null>(rows.map((row) => [row.questionId, row.optionId])), timedOut: new Set<string>() };
  const answers = new Map<string, string | null>();
  const settled = new Set<string>();
  for (const row of rows) if (row.closure === "CONFIRMED" || row.closure === "OMITTED") { answers.set(row.questionId, row.closure === "CONFIRMED" ? row.optionId : null); settled.add(row.questionId); }
  return { answers, timedOut: new Set(content.questions.map((question) => question.id).filter((id) => !settled.has(id))) };
}

async function finalize(tx: Transaction, attempt: AttemptRow, content: Content, status: "SUBMITTED" | "EXPIRED", at: Date) {
  const { answers, timedOut } = await gradingInput(tx, attempt.id, content);
  const result = grade(content, answers, timedOut);
  const end = attempt.deadlineAt && at > attempt.deadlineAt ? attempt.deadlineAt : at;
  await tx.evaluationAttempt.update({ where: { id: attempt.id }, data: { status, submittedAt: end } });
  return tx.evaluationResult.create({
    data: {
      attemptId: attempt.id, organizationId: attempt.organizationId, evaluationId: attempt.evaluationId, versionId: attempt.versionId, userId: attempt.userId,
      correct: result.correct, incorrect: result.incorrect, unanswered: result.unanswered, timedOut: result.timedOut, scoreCenti: result.scoreCenti, maxScoreCenti: result.maxScoreCenti,
      timeUsedSeconds: Math.max(0, Math.round((end.getTime() - attempt.startedAt.getTime()) / 1000)), breakdown: json(result.breakdown),
    },
  });
}

/** Persists what the server's clock already decided for a paced attempt (timeouts, the next question opening, the end) and returns the plan. */
async function advancePaced(tx: Transaction, attempt: AttemptRow, content: Content, now: Date): Promise<PacedPlan> {
  const rows = await tx.evaluationAnswer.findMany({ where: { attemptId: attempt.id } });
  const plan = pacedPlan(attempt, content, rows, now);
  for (const timeout of plan.timeouts)
    await tx.evaluationAnswer.upsert({
      where: { attemptId_questionId: { attemptId: attempt.id, questionId: timeout.questionId } },
      create: { attemptId: attempt.id, questionId: timeout.questionId, optionId: null, seq: 0, openedAt: timeout.openedAt, closedAt: timeout.closedAt, closure: "TIMEOUT" },
      update: { openedAt: timeout.openedAt, closedAt: timeout.closedAt, closure: "TIMEOUT" },
    });
  if (plan.current) await tx.evaluationAnswer.upsert({ where: { attemptId_questionId: { attemptId: attempt.id, questionId: plan.current.questionId } }, create: { attemptId: attempt.id, questionId: plan.current.questionId, optionId: null, seq: 0, openedAt: plan.current.openedAt }, update: {} });
  if (plan.finished !== "NONE") {
    const lastClosed = Math.max(attempt.startedAt.getTime(), ...rows.map((row) => row.closedAt?.getTime() ?? 0), ...plan.timeouts.map((t) => t.closedAt.getTime()));
    await finalize(tx, attempt, content, plan.finished === "GLOBAL_DEADLINE" ? "EXPIRED" : "SUBMITTED", plan.finished === "GLOBAL_DEADLINE" ? attempt.deadlineAt! : new Date(lastClosed));
  }
  return plan;
}
function pacedPlan(attempt: AttemptRow, content: Content, rows: Array<{ questionId: string; openedAt: Date | null; closedAt: Date | null; closure: string | null }>, now: Date) {
  const seconds = content.settings.pacing.questionSeconds;
  return planPaced({
    questionIds: content.questions.map((question) => question.id),
    rows: rows.map((row) => ({ questionId: row.questionId, openedAt: row.openedAt ?? attempt.startedAt, closedAt: row.closedAt, closure: row.closure as Closure | null })),
    startedAt: attempt.startedAt, questionMs: seconds === null ? null : seconds * 1000, globalDeadline: attempt.deadlineAt, now,
  });
}

const expired = (attempt: { status: string; deadlineAt: Date | null }, now: Date) => attempt.status === "IN_PROGRESS" && attempt.deadlineAt !== null && now.getTime() > attempt.deadlineAt.getTime() + CLOSE_GRACE_MS;

async function versionContent(tx: Transaction, versionId: string) {
  const version = await tx.evaluationVersion.findUniqueOrThrow({ where: { id: versionId } });
  return { version, snapshot: version.snapshot as unknown as Snapshot };
}

/**
 * Lazy closing of an open attempt at `now`: a free one is closed (expired) once its deadline + network allowance passed; a paced one has every
 * server-decided timeout applied. Returns the up-to-date attempt row. Every entry point calls it first, so a reload or a late request recovers nothing.
 */
async function settle<T extends AttemptRow & { status: string }>(tx: Transaction, attempt: T, now: Date): Promise<T> {
  if (attempt.status !== "IN_PROGRESS") return attempt;
  const { snapshot } = await versionContent(tx, attempt.versionId);
  if (isPaced(snapshot.content)) await advancePaced(tx, attempt, snapshot.content, now);
  else if (expired(attempt as { status: string; deadlineAt: Date | null }, now)) await finalize(tx, attempt, snapshot.content, "EXPIRED", now);
  else return attempt;
  return (await tx.evaluationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })) as unknown as T;
}

async function resultView(tx: Transaction, attempt: { id: string; organizationId: string; evaluationId: string; versionId: string; status: string; submittedAt: Date | null }, snapshot: Snapshot, now: Date, includeReview: boolean) {
  const row = await tx.evaluationResult.findUniqueOrThrow({ where: { attemptId: attempt.id } });
  const breakdown = row.breakdown as unknown as ReturnType<typeof grade>["breakdown"];
  const points = (centi: number) => centi / 100;
  const group = (tally: (typeof breakdown.byCategory)[number]) => ({ key: tally.key, title: tally.title ?? null, correct: tally.correct, incorrect: tally.incorrect, unanswered: tally.unanswered, timedOut: tally.timedOut ?? 0, scorePoints: points(tally.scoreCenti), maxPoints: points(tally.maxScoreCenti), percent: percentOf(tally.scoreCenti, tally.maxScoreCenti) });
  const available = reviewAvailable(snapshot.content, true, now);
  const graded = available || includeReview ? await gradingInput(tx, attempt.id, snapshot.content) : null;
  const { mode, revealAfter } = snapshot.content.settings.review;
  return {
    attemptId: attempt.id, evaluationId: attempt.evaluationId, status: attempt.status, submittedAt: attempt.submittedAt,
    correct: row.correct, incorrect: row.incorrect, unanswered: row.unanswered, timedOut: row.timedOut,
    scorePoints: points(row.scoreCenti), maxPoints: points(row.maxScoreCenti), percent: percentOf(row.scoreCenti, row.maxScoreCenti), timeUsedSeconds: row.timeUsedSeconds,
    breakdown: { byCategory: breakdown.byCategory.map(group), bySection: breakdown.bySection.map(group) },
    // The correct answers and explanations leave the server only when the version's review policy allows it (or for result readers).
    review: { available: available || includeReview, policy: mode, availableAt: mode === "AFTER_DATE" ? revealAfter : null, items: graded ? reviewContent(snapshot.content, graded.answers, graded.timedOut) : null },
  };
}

async function attemptView(tx: Transaction, attempt: NonNullable<Awaited<ReturnType<typeof tx.evaluationAttempt.findFirst>>>, now: Date) {
  const { snapshot } = await versionContent(tx, attempt.versionId);
  const content = snapshot.content;
  const base = {
    id: attempt.id, evaluationId: attempt.evaluationId, status: attempt.status, attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt, deadlineAt: attempt.deadlineAt, serverTime: now, evaluation: snapshot.evaluation, pacing: content.settings.pacing,
  };
  if (attempt.status !== "IN_PROGRESS") return { ...base, remainingSeconds: 0, content: null, answers: [], progress: null, current: null, result: await resultView(tx, attempt, snapshot, now, false) };
  const rows = await tx.evaluationAnswer.findMany({ where: { attemptId: attempt.id } });
  const remaining = attempt.deadlineAt ? Math.max(0, Math.round((attempt.deadlineAt.getTime() - now.getTime()) / 1000)) : null;
  if (!isPaced(content)) return { ...base, remainingSeconds: remaining, content: playerContent(content), answers: rows.map(({ questionId, optionId, seq }) => ({ questionId, optionId, seq })), progress: null, current: null, result: null };

  // Paced: only the open question (and its text) is delivered; the rest is revealed one question at a time, when the server opens it.
  const plan = pacedPlan(attempt, content, rows, now);
  const full = playerContent(content);
  const index = plan.current ? content.questions.findIndex((question) => question.id === plan.current!.questionId) : -1;
  const question = index >= 0 ? full.questions[index]! : null;
  const closed = new Set(rows.filter((row) => row.closure !== null).map((row) => row.questionId));
  const sections = content.sections.map((section) => {
    const ids = content.questions.filter((q) => q.sectionId === section.id).map((q) => q.id);
    return { id: section.id, title: section.title, description: section.description ?? null, total: ids.length, closed: ids.filter((id) => closed.has(id)).length };
  });
  const draft = question ? rows.find((row) => row.questionId === question.id) : undefined;
  return {
    ...base, remainingSeconds: remaining,
    content: { ...full, questions: question ? [question] : [], passages: question?.passageId ? full.passages.filter((passage) => passage.id === question.passageId) : [] },
    answers: draft && question ? [{ questionId: question.id, optionId: draft.optionId, seq: draft.seq }] : [],
    progress: { total: content.questions.length, closed: closed.size, index, sections },
    current: plan.current ? { questionId: plan.current.questionId, openedAt: plan.current.openedAt, expiresAt: plan.current.expiresAt, remainingSeconds: plan.current.expiresAt ? Math.max(0, Math.ceil((plan.current.expiresAt.getTime() - now.getTime()) / 1000)) : null } : null,
    result: null,
  };
}

async function ownAttempt(tx: Transaction, organizationId: string, attemptId: string, userId: string) {
  return (await tx.evaluationAttempt.findFirst({ where: { id: attemptId, organizationId, userId } })) ?? fail(404, "NOT_FOUND", "Attempt not found");
}

export type AssignmentInput = { role?: TenantRole; groupId?: string; userId?: string; opensAt?: Date | null; closesAt?: Date | null };

export const evaluations = {
  // ------------------------------------------------------------------------------------------------------------ authoring
  create(userId: string, organizationId: string, input: { key?: string; kind?: EvaluationKind; title: string; description?: string | null }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.create");
      if (input.key && (await tx.evaluation.count({ where: { organizationId, key: input.key } }))) fail(409, "EVALUATION_KEY_TAKEN", "An evaluation with this key already exists");
      const ev = await tx.evaluation.create({ data: { organizationId, key: input.key ?? null, kind: input.kind ?? "EXAM", title: input.title, description: input.description ?? null, draft: json(emptyContent()), createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_CREATED", targetType: "Evaluation", targetId: ev.id, metadata: { kind: ev.kind } });
      return authorView(ev);
    });
  },
  list(userId: string, organizationId: string, status?: "DRAFT" | "PUBLISHED" | "ARCHIVED") {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.read");
      const rows = await tx.evaluation.findMany({ where: { organizationId, ...(status ? { status } : {}) }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 200 });
      const versions = await tx.evaluationVersion.findMany({ where: { organizationId, id: { in: rows.flatMap((row) => (row.currentVersionId ? [row.currentVersionId] : [])) } }, select: { id: true, version: true } });
      const number = new Map(versions.map((version) => [version.id, version.version]));
      return rows.map((ev) => ({
        id: ev.id, key: ev.key, kind: ev.kind, title: ev.title, description: ev.description, status: ev.status, draftRevision: ev.draftRevision,
        questionCount: parse(ev.draft).questions.length, currentVersion: ev.currentVersionId ? number.get(ev.currentVersionId) ?? null : null,
        hasUnpublishedChanges: ev.publishedRevision === null || ev.draftRevision > ev.publishedRevision, updatedAt: ev.updatedAt,
      }));
    });
  },
  /** The editor's view: the draft INCLUDING the answer key, so it needs update (not merely read). */
  get(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.update");
      return authorView(await load(tx, organizationId, id));
    });
  },
  updateDetails(userId: string, organizationId: string, id: string, input: { title?: string; description?: string | null; settings?: Content["settings"]; expectedRevision?: number }) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.update");
      const ev = await load(tx, organizationId, id);
      if (ev.status === "ARCHIVED") fail(409, "EVALUATION_ARCHIVED", "Archived evaluations cannot be edited");
      if (input.expectedRevision !== undefined && input.expectedRevision !== ev.draftRevision) fail(409, "EVALUATION_REVISION_CONFLICT", "The evaluation changed since it was loaded");
      const content = input.settings ? draftOps.settings(parse(ev.draft), input.settings) : parse(ev.draft);
      const checked = contentSchema.safeParse(content);
      if (!checked.success) fail(422, "EVALUATION_CONTENT_INVALID", "The settings do not match the evaluation schema");
      const updated = await tx.evaluation.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), draft: json(checked.data), draftRevision: { increment: 1 } } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_DRAFT_UPDATED", targetType: "Evaluation", targetId: id, metadata: { op: "details", draftRevision: updated.draftRevision } });
      return authorView(updated);
    });
  },
  addSection: (u: string, o: string, e: string, input: { title: string; description?: string }, rev?: number) => mutate(u, o, e, "section.add", rev, (c) => withId(draftOps.addSection(c, input))),
  updateSection: (u: string, o: string, e: string, id: string, patch: { title?: string; description?: string }, rev?: number) => mutate(u, o, e, "section.update", rev, (c) => plain(draftOps.updateSection(c, id, patch))),
  removeSection: (u: string, o: string, e: string, id: string, rev?: number) => mutate(u, o, e, "section.remove", rev, (c) => plain(draftOps.removeSection(c, id))),
  reorderSections: (u: string, o: string, e: string, ids: string[], rev?: number) => mutate(u, o, e, "section.reorder", rev, (c) => plain(draftOps.reorderSections(c, ids))),
  addPassage: (u: string, o: string, e: string, input: { title: string; body: Block[] }, rev?: number) => mutate(u, o, e, "passage.add", rev, (c) => withId(draftOps.addPassage(c, input))),
  updatePassage: (u: string, o: string, e: string, id: string, patch: { title?: string; body?: Block[] }, rev?: number) => mutate(u, o, e, "passage.update", rev, (c) => plain(draftOps.updatePassage(c, id, patch))),
  removePassage: (u: string, o: string, e: string, id: string, rev?: number) => mutate(u, o, e, "passage.remove", rev, (c) => plain(draftOps.removePassage(c, id))),
  addQuestion: (u: string, o: string, e: string, input: QuestionInput, rev?: number) => mutate(u, o, e, "question.add", rev, (c) => withId(draftOps.addQuestion(c, input))),
  updateQuestion: (u: string, o: string, e: string, id: string, patch: Partial<QuestionInput>, rev?: number) => mutate(u, o, e, "question.update", rev, (c) => plain(draftOps.updateQuestion(c, id, patch))),
  removeQuestion: (u: string, o: string, e: string, id: string, rev?: number) => mutate(u, o, e, "question.remove", rev, (c) => plain(draftOps.removeQuestion(c, id))),
  reorderQuestions: (u: string, o: string, e: string, ids: string[], rev?: number) => mutate(u, o, e, "question.reorder", rev, (c) => plain(draftOps.reorderQuestions(c, ids))),
  /** Marking the correct answer is its own audited operation (it decides every score). */
  setCorrectOption: (u: string, o: string, e: string, questionId: string, optionId: string, rev?: number) =>
    mutate(u, o, e, `question.correct-option:${questionId}`, rev, (c) => plain(draftOps.setCorrectOption(c, questionId, optionId))),

  validate(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.update");
      const ev = await load(tx, organizationId, id);
      const issues = validateForPublish(parse(ev.draft));
      return { valid: issues.length === 0, draftRevision: ev.draftRevision, issues };
    });
  },
  publish(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.publish");
      const ev = await load(tx, organizationId, id);
      if (ev.status === "ARCHIVED") fail(409, "EVALUATION_ARCHIVED", "Unarchive the evaluation before publishing");
      const summary = (version: { id: string; version: number; publishedAt: Date; questionCount: number; maxScoreCenti: number }) => ({ id: version.id, version: version.version, publishedAt: version.publishedAt, questionCount: version.questionCount, maxPoints: version.maxScoreCenti / 100 });
      // Publishing the same draft revision twice is a no-op that returns the existing version.
      if (ev.currentVersionId && ev.publishedRevision === ev.draftRevision) return summary(await tx.evaluationVersion.findUniqueOrThrow({ where: { id: ev.currentVersionId } }));
      const content = parse(ev.draft);
      const issues = validateForPublish(content);
      if (issues.length) throw new DomainError(422, "EVALUATION_INVALID", "The evaluation cannot be published", { issueCount: issues.length, firstCode: issues[0]!.code });
      const last = await tx.evaluationVersion.aggregate({ where: { evaluationId: id }, _max: { version: true } });
      const snapshot: Snapshot = { evaluation: { title: ev.title, description: ev.description, kind: ev.kind }, content };
      const version = await tx.evaluationVersion.create({
        data: { organizationId, evaluationId: id, version: (last._max.version ?? 0) + 1, snapshot: json(snapshot), questionCount: content.questions.length, maxScoreCenti: content.questions.reduce((sum, q) => sum + toCenti(q.points), 0), publishedBy: userId },
      });
      await tx.evaluation.update({ where: { id }, data: { status: "PUBLISHED", currentVersionId: version.id, publishedRevision: ev.draftRevision } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_PUBLISHED", targetType: "Evaluation", targetId: id, metadata: { version: version.version, questions: version.questionCount } });
      return summary(version);
    });
  },
  versions(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.read");
      await load(tx, organizationId, id);
      const rows = await tx.evaluationVersion.findMany({ where: { organizationId, evaluationId: id }, orderBy: { version: "desc" }, select: { id: true, version: true, publishedAt: true, publishedBy: true, questionCount: true, maxScoreCenti: true } });
      return rows.map((row) => ({ id: row.id, version: row.version, publishedAt: row.publishedAt, publishedBy: row.publishedBy, questionCount: row.questionCount, maxPoints: row.maxScoreCenti / 100 }));
    });
  },
  archive(userId: string, organizationId: string, id: string, archived: boolean) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.manage");
      const ev = await load(tx, organizationId, id);
      const status = archived ? "ARCHIVED" : ev.currentVersionId ? "PUBLISHED" : "DRAFT";
      const updated = await tx.evaluation.update({ where: { id }, data: { status } });
      await audit.append(tx, { actorId: userId, organizationId, action: archived ? "EVALUATION_ARCHIVED" : "EVALUATION_UNARCHIVED", targetType: "Evaluation", targetId: id });
      return authorView(updated);
    });
  },
  duplicate(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.create");
      await authorize(tx, userId, organizationId, "evaluations.update");
      const source = await load(tx, organizationId, id);
      const copy = await tx.evaluation.create({ data: { organizationId, kind: source.kind, title: `${source.title} (copy)`.slice(0, 200), description: source.description, draft: json(parse(source.draft)), createdBy: userId } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_DUPLICATED", targetType: "Evaluation", targetId: copy.id, metadata: { sourceId: id } });
      return authorView(copy);
    });
  },
  /** Only never-published drafts are deleted; anything with versions or attempts is history and is archived instead. */
  remove(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.delete");
      const ev = await load(tx, organizationId, id);
      if (ev.currentVersionId || (await tx.evaluationVersion.count({ where: { evaluationId: id } }))) fail(409, "EVALUATION_HAS_HISTORY", "Published evaluations are archived, not deleted");
      await tx.evaluation.delete({ where: { id } });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_DELETED", targetType: "Evaluation", targetId: id });
      return null;
    });
  },

  // ---------------------------------------------------------------------------------------------------------- assignments
  assignments(userId: string, organizationId: string, id: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.read");
      await load(tx, organizationId, id);
      const rows = await tx.evaluationAssignment.findMany({ where: { organizationId, evaluationId: id }, orderBy: { id: "asc" } });
      const members = await tenantRepository.membershipUsers(tx, organizationId, rows.flatMap((row) => (row.membershipId ? [row.membershipId] : [])));
      const user = new Map(members.map((member) => [member.id, member.userId]));
      return rows.map((row) => ({ role: row.role ?? undefined, groupId: row.groupId ?? undefined, userId: row.membershipId ? user.get(row.membershipId) : undefined, opensAt: row.opensAt, closesAt: row.closesAt }));
    });
  },
  /** Replaces the whole assignment set atomically. */
  setAssignments(userId: string, organizationId: string, id: string, input: AssignmentInput[]) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.manage");
      await load(tx, organizationId, id);
      const keys = new Set<string>();
      const data: Prisma.EvaluationAssignmentCreateManyInput[] = [];
      for (const item of input) {
        if ([item.role, item.groupId, item.userId].filter(Boolean).length !== 1) fail(422, "EVALUATION_ASSIGNMENT_INVALID", "An assignment addresses exactly one role, group or person");
        if (item.opensAt && item.closesAt && item.opensAt >= item.closesAt) fail(422, "EVALUATION_ASSIGNMENT_INVALID", "The window must close after it opens");
        const key = item.role ? `r:${item.role}` : item.groupId ? `g:${item.groupId}` : `u:${item.userId}`;
        if (keys.has(key)) fail(409, "EVALUATION_ASSIGNMENT_CONFLICT", "Only one assignment per role, group or person");
        keys.add(key);
        let membershipId: string | undefined;
        if (item.userId) membershipId = (await tenantRepository.membership(tx, organizationId, item.userId))?.id ?? fail(422, "EVALUATION_ASSIGNMENT_INVALID", "Person is not a member of this organization");
        if (item.groupId && !(await groupsRepository.countIn(tx, organizationId, [item.groupId]))) fail(422, "EVALUATION_ASSIGNMENT_INVALID", "Group not found in this organization");
        data.push({ organizationId, evaluationId: id, role: item.role ?? null, groupId: item.groupId ?? null, membershipId: membershipId ?? null, opensAt: item.opensAt ?? null, closesAt: item.closesAt ?? null });
      }
      await tx.evaluationAssignment.deleteMany({ where: { organizationId, evaluationId: id } });
      if (data.length) await tx.evaluationAssignment.createMany({ data });
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_ASSIGNMENTS_UPDATED", targetType: "Evaluation", targetId: id, metadata: { count: data.length } });
      return { count: data.length };
    });
  },

  // -------------------------------------------------------------------------------------------------------------- taking
  available(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      const member = await authorize(tx, userId, organizationId, "evaluations.take");
      const now = new Date();
      const rows = await tx.evaluation.findMany({ where: { organizationId, status: "PUBLISHED", currentVersionId: { not: null } }, orderBy: [{ title: "asc" }, { id: "asc" }], take: 200 });
      const out = [];
      for (const ev of rows) {
        const window = await eligibility(tx, organizationId, ev.id, member, now);
        if (!window.assigned) continue;
        const { snapshot } = await versionContent(tx, ev.currentVersionId!);
        const attempts = await tx.evaluationAttempt.findMany({ where: { organizationId, evaluationId: ev.id, userId }, select: { id: true, status: true, deadlineAt: true } });
        const open = attempts.find((attempt) => attempt.status === "IN_PROGRESS" && !expired(attempt, now));
        const used = attempts.filter((attempt) => attempt.status !== "IN_PROGRESS" || expired(attempt, now)).length;
        const max = snapshot.content.settings.maxAttempts;
        out.push({
          id: ev.id, kind: ev.kind, title: ev.title, description: ev.description, durationMinutes: snapshot.content.settings.durationMinutes, questionCount: snapshot.content.questions.length,
          maxAttempts: max, pacing: snapshot.content.settings.pacing, sectionCount: snapshot.content.sections.length, attemptsUsed: used, openAttemptId: open?.id ?? null, opensAt: window.opensAt, closesAt: window.closesAt,
          canStart: window.open && (open !== undefined || max === null || used < max),
        });
      }
      return out;
    });
  },
  /** Starts an attempt, or returns the one in progress (a double click or a second tab never opens two). */
  startAttempt(userId: string, organizationId: string, evaluationId: string, now: Date = new Date()) {
    return transaction(async (tx) => {
      const member = await authorize(tx, userId, organizationId, "evaluations.take");
      const ev = await tx.evaluation.findFirst({ where: { id: evaluationId, organizationId, status: "PUBLISHED", currentVersionId: { not: null } } });
      const window = ev ? await eligibility(tx, organizationId, evaluationId, member, now) : null;
      // Not published or not assigned looks the same: nothing about unassigned evaluations is revealed.
      if (!ev || !window?.assigned) return notFound();
      const open = await tx.evaluationAttempt.findFirst({ where: { organizationId, evaluationId, userId, status: "IN_PROGRESS" } });
      const existing = open ? await settle(tx, open, now) : null;
      if (existing && existing.status === "IN_PROGRESS") return attemptView(tx, existing, now);
      if (!window!.open) fail(409, "EVALUATION_WINDOW_CLOSED", "This evaluation is not open for you right now");
      const { version, snapshot } = await versionContent(tx, ev!.currentVersionId!);
      const previous = await tx.evaluationAttempt.aggregate({ where: { evaluationId, userId }, _max: { attemptNumber: true }, _count: true });
      const max = snapshot.content.settings.maxAttempts;
      if (max !== null && previous._count >= max) fail(409, "EVALUATION_ATTEMPTS_EXHAUSTED", "No attempts left");
      const minutes = snapshot.content.settings.durationMinutes;
      const attempt = await tx.evaluationAttempt.create({
        data: { organizationId, evaluationId, versionId: version.id, userId, attemptNumber: (previous._max.attemptNumber ?? 0) + 1, startedAt: now, deadlineAt: minutes ? new Date(now.getTime() + minutes * 60_000) : null },
      });
      // A paced attempt opens its first question at the moment it starts (server clock).
      if (isPaced(snapshot.content)) await advancePaced(tx, attempt, snapshot.content, now);
      await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_ATTEMPT_STARTED", targetType: "EvaluationAttempt", targetId: attempt.id, metadata: { evaluationId, version: version.version, paced: isPaced(snapshot.content) } });
      return attemptView(tx, attempt, now);
    });
  },
  getAttempt(userId: string, organizationId: string, attemptId: string, now: Date = new Date()) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      const attempt = await settle(tx, await ownAttempt(tx, organizationId, attemptId, userId), now);
      return attemptView(tx, attempt, now);
    });
  },
  /** Autosave of the selection. A write whose `seq` is not newer than the stored one is ignored, so a late retry never overwrites a later answer.
   *  In a paced attempt only the open question accepts a (draft) selection; it is NOT an answer until it is confirmed. */
  saveAnswers(userId: string, organizationId: string, attemptId: string, answers: Array<{ questionId: string; optionId: string | null; seq: number }>, now: Date = new Date()) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      const before = await ownAttempt(tx, organizationId, attemptId, userId);
      if (before.status !== "IN_PROGRESS") fail(409, "ATTEMPT_CLOSED", "The attempt is closed");
      const attempt = await settle(tx, before, now);
      if (attempt.status !== "IN_PROGRESS") return { status: attempt.status === "SUBMITTED" ? ("SUBMITTED" as const) : ("EXPIRED" as const), applied: [] as string[], ignored: answers.map((a) => a.questionId), answers: [] as Array<{ questionId: string; optionId: string | null; seq: number }> };
      const { snapshot } = await versionContent(tx, attempt.versionId);
      const paced = isPaced(snapshot.content);
      const currentId = paced ? pacedPlan(attempt, snapshot.content, await tx.evaluationAnswer.findMany({ where: { attemptId } }), now).current?.questionId : undefined;
      const questions = new Map(snapshot.content.questions.map((question) => [question.id, question]));
      const latest = new Map<string, (typeof answers)[number]>();
      for (const answer of [...answers].sort((a, b) => a.seq - b.seq)) latest.set(answer.questionId, answer);
      for (const answer of latest.values()) {
        const question = questions.get(answer.questionId);
        if (!question) fail(422, "ATTEMPT_QUESTION_UNKNOWN", "Question does not belong to this attempt");
        if (answer.optionId !== null && !question!.options.some((option) => option.id === answer.optionId)) fail(422, "ATTEMPT_OPTION_UNKNOWN", "Option does not belong to the question");
      }
      const stored = new Map((await tx.evaluationAnswer.findMany({ where: { attemptId, questionId: { in: [...latest.keys()] } } })).map((row) => [row.questionId, row]));
      const applied: string[] = [];
      const ignored: string[] = [];
      for (const answer of latest.values()) {
        const current = stored.get(answer.questionId);
        if (paced && answer.questionId !== currentId) { ignored.push(answer.questionId); continue; } // closed or not yet open: it can no longer (or not yet) change
        if (current && current.seq >= answer.seq) { ignored.push(answer.questionId); continue; }
        await tx.evaluationAnswer.upsert({
          where: { attemptId_questionId: { attemptId, questionId: answer.questionId } },
          create: { attemptId, questionId: answer.questionId, optionId: answer.optionId, seq: answer.seq },
          update: { optionId: answer.optionId, seq: answer.seq, savedAt: now },
        });
        applied.push(answer.questionId);
      }
      // The authoritative state of what was sent, so a client that lost a race can reconcile.
      const current = await tx.evaluationAnswer.findMany({ where: { attemptId, questionId: { in: [...latest.keys()] } }, select: { questionId: true, optionId: true, seq: true } });
      return { status: "IN_PROGRESS" as const, applied, ignored, answers: current };
    });
  },
  /**
   * Paced attempts: CONFIRM the answer of the open question (or close it with no answer when optionId is null). The server accepts it only if its own
   * clock says the question is still open (a request exactly at the limit is on time, one millisecond later is not). A repeated confirmation of an
   * already closed question is idempotent when it carries the same choice. Domain refusals are returned (HTTP 200, `accepted: false`) so the state the
   * server just decided (a timeout) is persisted rather than rolled back.
   */
  confirmAnswer(userId: string, organizationId: string, attemptId: string, input: { questionId: string; optionId: string | null }, now: Date = new Date()) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      const before = await ownAttempt(tx, organizationId, attemptId, userId);
      const { snapshot } = await versionContent(tx, before.versionId);
      const content = snapshot.content;
      if (!isPaced(content)) fail(409, "EVALUATION_NOT_PACED", "This evaluation does not use confirmed answers");
      const question = content.questions.find((item) => item.id === input.questionId) ?? fail(422, "ATTEMPT_QUESTION_UNKNOWN", "Question does not belong to this attempt");
      if (input.optionId !== null && !question.options.some((option) => option.id === input.optionId)) fail(422, "ATTEMPT_OPTION_UNKNOWN", "Option does not belong to the question");
      const refuse = async (reason: "TIMEOUT" | "ALREADY_CLOSED" | "NOT_CURRENT" | "ATTEMPT_CLOSED") => ({ accepted: false as const, reason, attempt: await attemptView(tx, await tx.evaluationAttempt.findUniqueOrThrow({ where: { id: attemptId } }), now) });
      const attempt = await settle(tx, before, now);
      const row = await tx.evaluationAnswer.findUnique({ where: { attemptId_questionId: { attemptId, questionId: input.questionId } } });
      if (row?.closure === "CONFIRMED" || row?.closure === "OMITTED") {
        // A duplicate request (double click, retry after a lost response) carrying the same choice is a success, not an error.
        const same = row.closure === "OMITTED" ? input.optionId === null : row.optionId === input.optionId;
        return same ? { accepted: true as const, reason: null, attempt: await attemptView(tx, attempt, now) } : refuse("ALREADY_CLOSED");
      }
      if (row?.closure === "TIMEOUT") return refuse("TIMEOUT");
      if (attempt.status !== "IN_PROGRESS") return refuse(row ? "TIMEOUT" : "ATTEMPT_CLOSED");
      const plan = pacedPlan(attempt, content, await tx.evaluationAnswer.findMany({ where: { attemptId } }), now);
      if (plan.current?.questionId !== input.questionId) return refuse("NOT_CURRENT");
      await tx.evaluationAnswer.upsert({
        where: { attemptId_questionId: { attemptId, questionId: input.questionId } },
        create: { attemptId, questionId: input.questionId, optionId: input.optionId, seq: 1, openedAt: plan.current.openedAt, closedAt: now, closure: input.optionId === null ? "OMITTED" : "CONFIRMED" },
        update: { optionId: input.optionId, seq: { increment: 1 }, savedAt: now, closedAt: now, closure: input.optionId === null ? "OMITTED" : "CONFIRMED" },
      });
      // The next question opens now; if that was the last one the attempt is graded and closed in this same transaction.
      const after = await advancePaced(tx, attempt, content, now);
      if (after.finished !== "NONE") await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_ATTEMPT_SUBMITTED", targetType: "EvaluationAttempt", targetId: attemptId, metadata: { status: after.finished === "ALL_CLOSED" ? "SUBMITTED" : "EXPIRED", paced: true } });
      return { accepted: true as const, reason: null, attempt: await attemptView(tx, await tx.evaluationAttempt.findUniqueOrThrow({ where: { id: attemptId } }), now) };
    });
  },
  /** Grades on the server from the immutable version. Repeating the request returns the same result. A paced attempt ends by itself. */
  submit(userId: string, organizationId: string, attemptId: string, now: Date = new Date()) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      let attempt = await settle(tx, await ownAttempt(tx, organizationId, attemptId, userId), now);
      const { snapshot } = await versionContent(tx, attempt.versionId);
      if (attempt.status === "IN_PROGRESS") {
        if (isPaced(snapshot.content)) fail(409, "ATTEMPT_PACED", "Confirm each question; the attempt ends by itself after the last one or at its time limit");
        await finalize(tx, attempt, snapshot.content, "SUBMITTED", now);
        attempt = await ownAttempt(tx, organizationId, attemptId, userId);
        await audit.append(tx, { actorId: userId, organizationId, action: "EVALUATION_ATTEMPT_SUBMITTED", targetType: "EvaluationAttempt", targetId: attemptId, metadata: { status: attempt.status } });
      }
      return resultView(tx, attempt, snapshot, now, false);
    });
  },
  /** Own result, or anyone's with evaluations.results.read (others get 404, never 403: no enumeration). */
  result(userId: string, organizationId: string, attemptId: string) {
    return transaction(async (tx) => {
      const resolved = await resolvePermissions(tx, userId, organizationId);
      const attempt = await tx.evaluationAttempt.findFirst({ where: { id: attemptId, organizationId } });
      const reader = (resolved.permissions as readonly string[]).includes("evaluations.results.read");
      const owner = attempt?.userId === userId && (resolved.permissions as readonly string[]).includes("evaluations.take");
      if (!attempt || (!owner && !reader)) fail(404, "NOT_FOUND", "Attempt not found");
      if (attempt!.status === "IN_PROGRESS") fail(409, "ATTEMPT_OPEN", "The attempt has not been submitted");
      const { snapshot } = await versionContent(tx, attempt!.versionId);
      return resultView(tx, attempt!, snapshot, new Date(), reader && !owner);
    });
  },
  /** What the assistant may be told about an evaluation the person is working on: only if they may edit it, and never the answer key. */
  aiBrief(userId: string, organizationId: string, evaluationId: string) {
    return transaction(async (tx) => {
      try { await authorize(tx, userId, organizationId, "evaluations.update"); } catch { return null; }
      const ev = await tx.evaluation.findFirst({ where: { id: evaluationId, organizationId }, select: { id: true, title: true, status: true, kind: true } });
      return ev ? { id: ev.id, title: ev.title, status: ev.status, kind: ev.kind } : null;
    });
  },
  /**
   * Is the assistant blocked for this person right now? Yes while they have an attempt in progress (deadline not passed) whose version does
   * not allow AI during the attempt. Decided on the server from the immutable version; the interface hiding the button is only a courtesy.
   */
  async aiBlockedByAttempt(tx: Transaction, userId: string, organizationId: string, now: Date = new Date()) {
    const open = await tx.evaluationAttempt.findMany({ where: { organizationId, userId, status: "IN_PROGRESS" }, select: { versionId: true, deadlineAt: true } });
    for (const attempt of open) {
      if (attempt.deadlineAt && attempt.deadlineAt.getTime() < now.getTime()) continue; // already over, only waiting to be closed
      const { snapshot } = await versionContent(tx, attempt.versionId);
      if (!snapshot.content.settings.ai.allowedDuringAttempt) return true;
    }
    return false;
  },
  /** The person's own closed attempts across evaluations, newest first: their history. */
  myResults(userId: string, organizationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      const attempts = await tx.evaluationAttempt.findMany({ where: { organizationId, userId, status: { not: "IN_PROGRESS" } }, orderBy: [{ submittedAt: "desc" }, { id: "asc" }], take: 100 });
      const results = new Map((await tx.evaluationResult.findMany({ where: { organizationId, attemptId: { in: attempts.map((a) => a.id) } } })).map((row) => [row.attemptId, row]));
      const titles = new Map((await tx.evaluation.findMany({ where: { organizationId, id: { in: [...new Set(attempts.map((a) => a.evaluationId))] } }, select: { id: true, title: true, kind: true } })).map((ev) => [ev.id, ev]));
      return attempts.flatMap((attempt) => {
        const result = results.get(attempt.id);
        const ev = titles.get(attempt.evaluationId);
        return result && ev ? [{ attemptId: attempt.id, evaluationId: attempt.evaluationId, title: ev.title, kind: ev.kind, attemptNumber: attempt.attemptNumber, status: attempt.status, submittedAt: attempt.submittedAt, scorePoints: result.scoreCenti / 100, maxPoints: result.maxScoreCenti / 100, percent: percentOf(result.scoreCenti, result.maxScoreCenti) }] : [];
      });
    });
  },
  /**
   * Statistics of one version (default: the latest with attempts) plus a per-version comparison. Only closed, graded attempts count;
   * everything is read inside the caller's organization and needs evaluations.results.read.
   */
  stats(userId: string, organizationId: string, evaluationId: string, versionId?: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.results.read");
      const ev = await load(tx, organizationId, evaluationId);
      const versions = await tx.evaluationVersion.findMany({ where: { organizationId, evaluationId }, orderBy: { version: "asc" }, select: { id: true, version: true, publishedAt: true, questionCount: true, maxScoreCenti: true } });
      const attempts = await tx.evaluationAttempt.groupBy({ by: ["versionId", "status"], where: { organizationId, evaluationId }, _count: { _all: true } });
      const results = await tx.evaluationResult.findMany({ where: { organizationId, evaluationId }, select: { versionId: true, scoreCenti: true, maxScoreCenti: true }, take: 50_000 });
      const comparison = versions.map((version) => {
        const mine = results.filter((row) => row.versionId === version.id);
        const count = (status: string) => attempts.find((a) => a.versionId === version.id && a.status === status)?._count._all ?? 0;
        return {
          id: version.id, version: version.version, publishedAt: version.publishedAt, questionCount: version.questionCount, maxPoints: version.maxScoreCenti / 100,
          attempts: count("IN_PROGRESS") + count("SUBMITTED") + count("EXPIRED"), graded: mine.length,
          meanPercent: mine.length ? Math.round((mine.reduce((sum, row) => sum + percentOf(row.scoreCenti, row.maxScoreCenti), 0) / mine.length) * 100) / 100 : null,
        };
      });
      if (versionId && !versions.some((version) => version.id === versionId)) fail(404, "NOT_FOUND", "Version not found");
      const selected = versionId ?? [...comparison].reverse().find((version) => version.attempts > 0)?.id ?? ev.currentVersionId ?? comparison.at(-1)?.id ?? null;
      if (!selected) return { evaluation: { id: ev.id, title: ev.title }, versions: comparison, selectedVersionId: null, stats: null };
      const { snapshot } = await versionContent(tx, selected);
      const scope = results.length ? await tx.evaluationResult.findMany({ where: { organizationId, evaluationId, versionId: selected }, select: { scoreCenti: true, maxScoreCenti: true, timeUsedSeconds: true, breakdown: true }, take: 50_000 }) : [];
      const answers = await tx.$queryRaw<Array<{ questionId: string; optionId: string | null; closure: string | null; count: number }>>(Prisma.sql`
        SELECT a."questionId", a."optionId", a."closure", count(*)::int AS "count"
        FROM "EvaluationAnswer" a JOIN "EvaluationAttempt" t ON t."id" = a."attemptId"
        WHERE t."organizationId" = ${organizationId} AND t."evaluationId" = ${evaluationId} AND t."versionId" = ${selected} AND t."status" IN ('SUBMITTED', 'EXPIRED')
        GROUP BY a."questionId", a."optionId", a."closure"`);
      const count = (status: string) => attempts.find((a) => a.versionId === selected && a.status === status)?._count._all ?? 0;
      const stats = buildStats(snapshot.content, scope as unknown as Parameters<typeof buildStats>[1], answers satisfies AnswerCount[], { inProgress: count("IN_PROGRESS"), submitted: count("SUBMITTED"), expired: count("EXPIRED") });
      return { evaluation: { id: ev.id, title: ev.title }, versions: comparison, selectedVersionId: selected, stats };
    });
  },
  myAttempts(userId: string, organizationId: string, evaluationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.take");
      const rows = await tx.evaluationAttempt.findMany({ where: { organizationId, evaluationId, userId }, orderBy: { attemptNumber: "desc" }, take: 100 });
      return rows.map((row) => ({ id: row.id, attemptNumber: row.attemptNumber, status: row.status, startedAt: row.startedAt, submittedAt: row.submittedAt }));
    });
  },
  /** Results for authors: every attempt of an evaluation. */
  attempts(userId: string, organizationId: string, evaluationId: string) {
    return transaction(async (tx) => {
      await authorize(tx, userId, organizationId, "evaluations.results.read");
      await load(tx, organizationId, evaluationId);
      const rows = await tx.evaluationAttempt.findMany({ where: { organizationId, evaluationId }, orderBy: [{ startedAt: "desc" }, { id: "asc" }], take: 500 });
      const results = new Map((await tx.evaluationResult.findMany({ where: { organizationId, evaluationId } })).map((row) => [row.attemptId, row]));
      const people = new Map((await identities.summaries(tx, [...new Set(rows.map((row) => row.userId))])).map((person) => [person.id, person]));
      return rows.map((row) => {
        const result = results.get(row.id);
        return {
          id: row.id, userId: row.userId, name: people.get(row.userId)?.name ?? null, email: people.get(row.userId)?.email ?? null, versionId: row.versionId,
          attemptNumber: row.attemptNumber, status: row.status, startedAt: row.startedAt, submittedAt: row.submittedAt,
          scorePoints: result ? result.scoreCenti / 100 : null, maxPoints: result ? result.maxScoreCenti / 100 : null, percent: result ? percentOf(result.scoreCenti, result.maxScoreCenti) : null,
        };
      });
    });
  },
};
