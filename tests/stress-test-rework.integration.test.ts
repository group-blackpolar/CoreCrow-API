import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/**
 * ADR 032 end to end on PostgreSQL: idempotent categories, the Simulacro 02 imported as data, a full paced attempt with a timeout, server-side grading,
 * per-competency results and feedback (persisted, versioned), review gating, immutability after the exam is edited, concurrency and tenant isolation.
 */
test("stress test rework: categories, Simulacro 02, competencies, feedback, history and isolation", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5548?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5548, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { evaluations } = await import("../src/modules/evaluations/service.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });
  // @ts-expect-error plain ESM scripts without type declarations
  const { importEvaluation, ensureCategories } = await import("../scripts/lib/import-evaluation-core.mjs");
  // @ts-expect-error plain ESM scripts without type declarations
  const definition = (await import("../scripts/evaluations/lectura-critica-naranja-lima-02.mjs")).default;
  // @ts-expect-error plain ESM scripts without type declarations
  const categories = (await import("../scripts/evaluations/categories.mjs")).default;

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.${180 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  type Res = Awaited<ReturnType<typeof call>>;
  const ok = (response: Res, expected: number) => { assert.equal(response.statusCode, expected, `${response.statusCode}: ${response.body}`); return response.body ? response.json() : null; };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    ok(await call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    ok(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    ok(login, 200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id: user.id, cookie: login.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ") };
  }
  const as = (cookie: string) => async (method: Method, path: string, body?: unknown) => {
    const response = await call(method, `/v1${path}`, cookie, body);
    if (response.statusCode >= 400) throw Object.assign(new Error(`${method} ${path} -> ${response.statusCode} ${response.body}`), { status: response.statusCode });
    return { json: response.body ? response.json() : null, etag: null };
  };

  const owner = await account("owner"), alice = await account("alice"), bob = await account("bob"), other = await account("other"), carol = await account("carol");
  const slug = `stress-${prefix}`, slugB = `stress-b-${prefix}`;
  const org = ok(await call("POST", "/v1/organizations", owner.cookie, { name: `Stress ${prefix}`, slug }), 201).id as string;
  const orgB = ok(await call("POST", "/v1/organizations", other.cookie, { name: `Stress B ${prefix}`, slug: slugB }), 201).id as string;
  for (const user of [alice, bob]) await prisma.membership.create({ data: { organizationId: org, userId: user.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { organizationId: orgB, userId: carol.id, role: "MEMBER" } });
  const base = `/v1/organizations/${org}`;
  const correct: string[] = definition.sections.flatMap((section: any) => section.questions.map((question: any) => question.correct));
  const wrongLetter = (index: number) => "ABCD".split("").find((letter) => letter !== correct[index])!;

  await t.test("categories are persisted and initialized idempotently: running the initializer twice creates no duplicates and changes nothing", async () => {
    const first = await ensureCategories(as(owner.cookie), slug, categories);
    assert.deepEqual(first.map((row: any) => [row.key, row.created]), [["lectura-critica", true], ["ingles", true]]);
    const [{ id: lectura }] = await prisma.evaluationCategory.findMany({ where: { organizationId: org, key: "lectura-critica" } });
    ok(await call("PATCH", `${base}/evaluation-categories/${lectura}`, owner.cookie, { color: "#3730a3" }), 200); // an administrator edits it...
    const second = await ensureCategories(as(owner.cookie), slug, categories);
    assert.deepEqual(second.map((row: any) => row.created), [false, false]);
    const rows = await prisma.evaluationCategory.findMany({ where: { organizationId: org }, orderBy: { position: "asc" } });
    assert.deepEqual(rows.map((row) => [row.key, row.position, row.color]), [["lectura-critica", 0, "#3730a3"], ["ingles", 1, "#0f766e"]], "...and the initializer does not overwrite it");
    // writing needs evaluations.manage; creating the same key again is a conflict
    assert.equal(ok(await call("PUT", `${base}/evaluation-categories/by-key/otra`, alice.cookie, { name: "Otra" }), 403).error.code, "FORBIDDEN");
    assert.equal(ok(await call("POST", `${base}/evaluation-categories`, owner.cookie, { key: "ingles", name: "Dup" }), 409).error.code, "EVALUATION_CATEGORY_KEY_TAKEN");
    assert.equal(ok(await call("POST", `${base}/evaluation-categories`, owner.cookie, { key: "x", name: "X", color: "red" }), 400).error.code.length > 0, true);
  });

  let evaluationId = "";
  await t.test("Simulacro 02 is imported as data into its category; a second import changes nothing", async () => {
    const result = await importEvaluation(as(owner.cookie), slug, definition);
    assert.deepEqual([result.created, result.status, result.questions, result.version], [true, "PUBLISHED", 15, 1]);
    evaluationId = result.evaluationId;
    const row = await prisma.evaluation.findUniqueOrThrow({ where: { id: evaluationId } });
    const lectura = await prisma.evaluationCategory.findFirstOrThrow({ where: { organizationId: org, key: "lectura-critica" } });
    assert.equal(row.categoryId, lectura.id);
    const listed = ok(await call("GET", `${base}/evaluations`, owner.cookie), 200).find((item: { id: string }) => item.id === evaluationId);
    assert.equal(listed.categoryId, lectura.id, "the authors' list carries the category (the builder groups by it)");
    assert.equal(row.title, "Lectura Critica - Mi planta naranja-lima | Simulacro 02");
    assert.equal((await importEvaluation(as(owner.cookie), slug, definition)).created, false);
    assert.equal(row.draftRevision, row.publishedRevision, "assigning the category did not leave unpublished changes");
  });

  await t.test("the student sees categories with real numbers (to do / in progress / done) computed from assignments", async () => {
    const view = ok(await call("GET", `${base}/evaluation-categories`, alice.cookie), 200);
    assert.deepEqual(view.categories.map((c: any) => [c.key, c.counts]), [["lectura-critica", { total: 1, completed: 0, inProgress: 0 }], ["ingles", { total: 0, completed: 0, inProgress: 0 }]]);
    const exam = ok(await call("GET", `${base}/evaluations/available`, alice.cookie), 200)[0];
    assert.deepEqual([exam.state, exam.sectionCount, exam.questionCount, exam.pacing, exam.lastPercent, exam.categoryId === view.categories[0].id], ["TODO", 3, 15, { navigation: "FORWARD_ONLY", questionSeconds: 120, sessionMinutes: 30 }, null, true]);
  });

  const T0 = Date.now();
  const at = (ms: number) => new Date(T0 + ms);
  let attemptId = "";
  let ids: string[] = [];
  const optionOf = (view: any, letter: string) => view.content.questions[0].options.find((option: any) => option.label === letter).id as string;
  await t.test("starting: one open question at a time, the exam key and explanations never reach the client, the second session keeps its fragment", async () => {
    const started = await evaluations.startAttempt(alice.id, org, evaluationId, at(0));
    attemptId = started.id;
    ids = (ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200).content.questions as Array<{ id: string }>).map((q) => q.id);
    const text = JSON.stringify(started);
    for (const secret of ["correctOptionId", "explanation", "Intensifica la tristeza", "topic", "skills"]) assert.ok(!text.includes(secret), `leaked: ${secret}`);
    assert.deepEqual([started.progress!.total, started.progress!.sections.length, (started.content as any).questions.length], [15, 3, 1]);
    // case 8: asking for the result of an open attempt, or reading the author's endpoints, reveals nothing
    assert.equal(ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, alice.cookie), 409).error.code, "ATTEMPT_OPEN");
    assert.equal(ok(await call("GET", `${base}/evaluations/${evaluationId}`, alice.cookie), 403).error.code, "FORBIDDEN");
    assert.equal(ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, bob.cookie), 404).error.code, "NOT_FOUND");
    const mid = ok(await call("GET", `${base}/evaluations/available`, alice.cookie), 200)[0];
    assert.deepEqual([mid.state, mid.openAttemptId], ["IN_PROGRESS", attemptId]);
  });

  await t.test("answering: reload and a second device do not restart the timer; wrong answers on questions 4 and 7; question 10 times out after 121 s", async () => {
    let clock = 0;
    for (let number = 1; number <= 9; number += 1) {
      clock = number * 10_000;
      const view = await evaluations.getAttempt(alice.id, org, attemptId, at(clock - 4_000));
      const current = view.current as { questionId: string; openedAt: Date; remainingSeconds: number };
      assert.equal(current.questionId, ids[number - 1]);
      assert.equal(current.openedAt.getTime(), at(clock - 10_000).getTime(), "reloading or another device sees the same opening instant");
      assert.equal(current.remainingSeconds, 114);
      const letter = number === 4 || number === 7 ? wrongLetter(number - 1) : correct[number - 1]!;
      const response = await evaluations.confirmAnswer(alice.id, org, attemptId, { questionId: ids[number - 1]!, optionId: optionOf(view, letter) }, at(clock));
      assert.equal(response.accepted, true);
    }
    // question 10 opened at 90 s: a confirmation at 211 s (one second late) is refused and no points are given
    const late = await evaluations.confirmAnswer(alice.id, org, attemptId, { questionId: ids[9]!, optionId: null }, at(211_000));
    assert.deepEqual([late.accepted, late.reason], [false, "TIMEOUT"]);
    const q10 = await prisma.evaluationAnswer.findUniqueOrThrow({ where: { attemptId_questionId: { attemptId, questionId: ids[9]! } } });
    assert.deepEqual([q10.closure, q10.closedAt!.getTime() - q10.openedAt!.getTime()], ["TIMEOUT", 120_000]);
    clock = 210_000;
    const q11 = await evaluations.getAttempt(alice.id, org, attemptId, at(clock + 1_000));
    assert.equal((await evaluations.confirmAnswer(alice.id, org, attemptId, { questionId: ids[10]!, optionId: optionOf(q11, correct[10]!) }, at(clock + 2_000))).accepted, true);
  });

  await t.test("finishing the three sessions: grading happens on the server from the pinned version, results are stored once", async () => {
    let clock = 210_000 + 2_000;
    for (let number = 12; number <= 15; number += 1) {
      clock += 10_000;
      const view = await evaluations.getAttempt(alice.id, org, attemptId, at(clock - 5_000));
      assert.equal((view.current as { questionId: string }).questionId, ids[number - 1]);
      await evaluations.confirmAnswer(alice.id, org, attemptId, { questionId: ids[number - 1]!, optionId: optionOf(view, correct[number - 1]!) }, at(clock));
    }
    const done = ok(await call("GET", `${base}/evaluation-attempts/${attemptId}`, alice.cookie), 200);
    assert.equal(done.status, "SUBMITTED");
    assert.equal(await prisma.evaluationResult.count({ where: { attemptId } }), 1);
    const attempt = await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    assert.ok(attempt.submittedAt);
  });

  let result: any;
  await t.test("the result: 100 x correct/15, per-competency percentage, level, time and a feedback paragraph grounded in the real errors", async () => {
    result = ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, alice.cookie), 200);
    assert.deepEqual([result.correct, result.incorrect, result.unanswered, result.timedOut, result.percent], [12, 2, 0, 1, 80]); // 15 - Q4 - Q7 - Q10 (timeout)
    const [literal, inferential, critical] = result.feedback.competencies;
    assert.deepEqual([literal.title, literal.percent, literal.level.label, literal.correct, literal.total], ["Comprensión literal", 80, "Superior", 4, 5]);
    assert.deepEqual([inferential.title, inferential.percent, inferential.level.label, inferential.timedOut], ["Comprensión inferencial", 60, "Alto", 1]);
    assert.equal(critical.title, "Lectura crítica");
    assert.match(literal.paragraph, /ordenar cronológicamente los sucesos \(la pregunta 4\)/);
    assert.match(literal.paragraph, /línea de tiempo/);
    assert.match(inferential.paragraph, /interpretar emociones.*\(la pregunta 7\)/);
    assert.match(inferential.paragraph, /Una pregunta venció sin respuesta confirmada a tiempo \(la pregunta 10\)/);
    assert.ok(literal.timeSeconds > 0 && literal.reinforceTopics.includes("Orden de los sucesos"));
    assert.ok(result.feedback.plan.length >= 3 && result.feedback.plan.length <= 5);
    assert.equal(result.feedback.plan[0].priority, "gap");
    assert.deepEqual(result.levels.map((level: any) => [level.label, level.minPercent]), [["Bajo", 0], ["Básico", 40], ["Alto", 60], ["Superior", 80]]);
    assert.equal(result.feedback.versions, undefined, "the version history is for result readers only");
  });

  await t.test("the review shows prompt, selection, key, explanation, competency, topic and time spent; Q10 is invalid_timeout", async () => {
    const items = result.review.items;
    assert.equal(items.length, 15);
    assert.deepEqual([items[3].outcome, items[6].outcome, items[9].outcome, items[0].outcome], ["incorrect", "incorrect", "invalid_timeout", "correct"]);
    assert.deepEqual([items[3].competency, items[3].topic, items[3].seconds], ["Comprensión literal", "Orden de los sucesos", 10]);
    assert.equal(items[9].seconds, 120);
    assert.ok(items[3].explanation.length && items[3].correctOptionId && items[3].selectedOptionId !== items[3].correctOptionId);
  });

  await t.test("history: the exam is now completed, with its last grade; categories show it as completed", async () => {
    const exam = ok(await call("GET", `${base}/evaluations/available`, alice.cookie), 200)[0];
    assert.deepEqual([exam.state, exam.lastAttemptId, exam.lastPercent, exam.canStart], ["COMPLETED", attemptId, result.percent, false]);
    const view = ok(await call("GET", `${base}/evaluation-categories`, alice.cookie), 200);
    assert.deepEqual(view.categories[0].counts, { total: 1, completed: 1, inProgress: 0 });
    assert.equal(ok(await call("GET", `${base}/evaluation-results/mine`, alice.cookie), 200)[0].attemptId, attemptId);
    // a finished attempt cannot be changed
    const again = await evaluations.confirmAnswer(alice.id, org, attemptId, { questionId: ids[0]!, optionId: null }, at(300_000));
    assert.equal(again.accepted, false);
  });

  await t.test("feedback is persisted per attempt and versioned: regeneration needs manage, appends a version only when the output changed and keeps the history", async () => {
    assert.equal(await prisma.evaluationFeedback.count({ where: { attemptId } }), 1);
    assert.equal(ok(await call("POST", `${base}/evaluation-attempts/${attemptId}/feedback/regenerate`, alice.cookie), 403).error.code, "FORBIDDEN");
    assert.deepEqual(ok(await call("POST", `${base}/evaluation-attempts/${attemptId}/feedback/regenerate`, owner.cookie), 200), { version: 1, changed: false });
    // simulate an older generator: the stored text differs, so a regeneration appends version 2 and keeps version 1
    await prisma.evaluationFeedback.update({ where: { attemptId_version: { attemptId, version: 1 } }, data: { content: { generator: "old", overall: {}, competencies: [], plan: [] } } });
    assert.deepEqual(ok(await call("POST", `${base}/evaluation-attempts/${attemptId}/feedback/regenerate`, owner.cookie), 200), { version: 2, changed: true });
    const asOwner = ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, owner.cookie), 200);
    assert.deepEqual([asOwner.feedback.version, asOwner.feedback.versions.map((row: any) => [row.version, row.reason])], [2, [[2, "REGENERATED"], [1, "AUTO"]]]);
    assert.equal(asOwner.feedback.competencies[0].paragraph, result.feedback.competencies[0].paragraph);
    assert.equal(asOwner.percent, result.percent, "regenerating feedback never touches the grade");
    assert.equal(await prisma.auditLog.count({ where: { organizationId: org, action: "EVALUATION_FEEDBACK_REGENERATED" } }), 1);
  });

  await t.test("editing a question after attempts exist creates a new version; the finished result and its review keep the original wording and key", async () => {
    const draft = ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200);
    const first = draft.content.questions[0];
    ok(await call("PATCH", `${base}/evaluations/${evaluationId}/questions/${first.id}`, owner.cookie, { prompt: [{ type: "paragraph", text: "Pregunta 1 editada después del intento." }], expectedRevision: draft.draftRevision }), 200);
    assert.equal(ok(await call("POST", `${base}/evaluations/${evaluationId}/publish`, owner.cookie), 200).version, 2);
    const after = ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, alice.cookie), 200);
    assert.equal(after.percent, result.percent);
    assert.match(JSON.stringify(after.review.items[0].prompt), /Quién narra/);
    assert.doesNotMatch(JSON.stringify(after.review.items[0].prompt), /editada/);
    assert.deepEqual(after.feedback.competencies.map((c: any) => c.percent), result.feedback.competencies.map((c: any) => c.percent));
    // bob starts on version 2 and still sees one question at a time
    const started = await evaluations.startAttempt(bob.id, org, evaluationId);
    // two simultaneous confirmations of the same question with different choices (two devices): the server settles on exactly one
    const q1 = started.content as any;
    const [x, y] = await Promise.all(["A", "B"].map((letter) => evaluations.confirmAnswer(bob.id, org, started.id, { questionId: q1.questions[0].id, optionId: optionOf(started, letter) }).then((r) => r.accepted, () => false)));
    assert.equal([x, y].filter(Boolean).length, 1);
    assert.equal(await prisma.evaluationAnswer.count({ where: { attemptId: started.id, closure: "CONFIRMED" } }), 1);
    assert.match(JSON.stringify(started.content), /editada/);
    assert.equal((await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: started.id } })).versionId !== (await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).versionId, true);
  });

  await t.test("tenant isolation: another organization runs the same exam with its own categories, attempts and feedback, and nothing crosses", async () => {
    await ensureCategories(as(other.cookie), slugB, categories);
    const resultB = await importEvaluation(as(other.cookie), slugB, definition);
    assert.equal(resultB.created, true);
    const baseB = `/v1/organizations/${orgB}`;
    const started = await evaluations.startAttempt(carol.id, orgB, resultB.evaluationId, at(0));
    assert.ok(started.id !== attemptId);
    assert.equal(await prisma.evaluationCategory.count({ where: { key: "lectura-critica", organizationId: { in: [org, orgB] } } }), 2);
    assert.ok([403, 404].includes((await call("GET", `${baseB}/evaluation-categories`, alice.cookie)).statusCode));
    assert.ok([403, 404].includes((await call("GET", `${baseB}/evaluation-attempts/${started.id}`, alice.cookie)).statusCode));
    assert.equal((await call("GET", `${base}/evaluation-attempts/${started.id}`, carol.cookie)).statusCode >= 400, true);
    // carol cannot attach the other organization's category to an evaluation of hers
    const lecturaA = await prisma.evaluationCategory.findFirstOrThrow({ where: { organizationId: org, key: "lectura-critica" } });
    assert.equal((await call("PUT", `${baseB}/evaluations/${resultB.evaluationId}/category`, other.cookie, { categoryId: lecturaA.id })).statusCode, 422);
    // other's listing only has its own exam and category
    const own = ok(await call("GET", `${baseB}/evaluation-categories`, other.cookie), 200);
    assert.equal(own.categories.length, 2);
  });

  await t.test("versions published before ADR 032 (no skills, levels, session limit or tags in the snapshot) keep working over HTTP: list, attempt, submit, result, review", async () => {
    // A legacy version is inserted directly (the table is immutable, so it is created, not rewritten): the shape the production Simulacro 01 has.
    const source = await prisma.evaluationVersion.findFirstOrThrow({ where: { id: (await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: attemptId } })).versionId } });
    const legacy = JSON.parse(JSON.stringify(source.snapshot));
    delete legacy.content.skills; delete legacy.content.settings.performance; delete legacy.content.settings.pacing.sessionMinutes;
    legacy.content.settings.pacing = { navigation: "FREE", questionSeconds: null }; legacy.content.settings.durationMinutes = null;
    for (const question of legacy.content.questions) { delete question.topic; delete question.skills; delete question.difficulty; delete question.reference; }
    const old = await prisma.evaluation.create({ data: { organizationId: org, key: `legacy-${prefix}`, title: "Legacy exam", status: "PUBLISHED", draft: source.snapshot as never, createdBy: owner.id } });
    const version = await prisma.evaluationVersion.create({ data: { organizationId: org, evaluationId: old.id, version: 1, snapshot: legacy, questionCount: 15, maxScoreCenti: 1500, publishedBy: owner.id } });
    await prisma.evaluation.update({ where: { id: old.id }, data: { currentVersionId: version.id } });
    await prisma.evaluationAssignment.create({ data: { organizationId: org, evaluationId: old.id, role: "MEMBER" } });

    const listed = ok(await call("GET", `${base}/evaluations/available`, bob.cookie), 200).find((row: { id: string }) => row.id === old.id);
    assert.deepEqual([listed.pacing, listed.state], [{ navigation: "FREE", questionSeconds: null, sessionMinutes: null }, "TODO"]);
    const categoriesView = ok(await call("GET", `${base}/evaluation-categories`, bob.cookie), 200);
    assert.ok(categoriesView.uncategorized.total >= 1);
    const started = ok(await call("POST", `${base}/evaluations/${old.id}/attempts`, bob.cookie), 200);
    assert.equal(started.content.questions.length, 15);
    const finished = ok(await call("POST", `${base}/evaluation-attempts/${started.id}/submit`, bob.cookie), 200);
    assert.deepEqual(finished.levels.map((level: any) => level.label), ["Bajo", "Básico", "Alto", "Superior"], "default levels for a legacy version");
    assert.equal(finished.feedback.competencies.length, 3);
    const again = ok(await call("GET", `${base}/evaluation-attempts/${started.id}/result`, owner.cookie), 200);
    assert.equal(again.review.items.length, 15);
  });

  await t.test("archiving a category hides it from students and keeps the exams; administrators can still list it", async () => {
    const ingles = await prisma.evaluationCategory.findFirstOrThrow({ where: { organizationId: org, key: "ingles" } });
    ok(await call("PATCH", `${base}/evaluation-categories/${ingles.id}`, owner.cookie, { status: "ARCHIVED" }), 200);
    assert.deepEqual(ok(await call("GET", `${base}/evaluation-categories`, alice.cookie), 200).categories.map((c: any) => c.key), ["lectura-critica"]);
    assert.deepEqual(ok(await call("GET", `${base}/evaluation-categories?includeArchived=true`, owner.cookie), 200).categories.map((c: any) => c.key), ["lectura-critica", "ingles"]);
  });
});
