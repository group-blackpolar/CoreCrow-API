import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/**
 * "Lectura Crítica — El principito | Simulacro 01": the content is imported as DATA through the generic importer and the paced engine
 * (forward-only, 120 s per question, 30 min total, server-authoritative timestamps) is exercised at its limits.
 */
test("simulacro: idempotent import, paced attempts, exact-limit and timeout rules, duplicates and concurrency, no leaks", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5547?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5547, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { evaluations } = await import("../src/modules/evaluations/service.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });
  // @ts-expect-error plain ESM scripts without type declarations
  const { importEvaluation } = await import("../scripts/lib/import-evaluation-core.mjs");
  // @ts-expect-error plain ESM scripts without type declarations
  const definition = (await import("../scripts/evaluations/lectura-critica-principito-01.mjs")).default;

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.${160 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
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

  const owner = await account("owner");
  const alice = await account("alice");
  const bob = await account("bob");
  const outsider = await account("outsider");
  const slug = `simulacro-${prefix}`;
  const org = ok(await call("POST", "/v1/organizations", owner.cookie, { name: `Sim ${prefix}`, slug }), 201).id as string;
  await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` });
  await prisma.membership.create({ data: { organizationId: org, userId: alice.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { organizationId: org, userId: bob.id, role: "MEMBER" } });
  const base = `/v1/organizations/${org}`;

  let evaluationId = "";
  await t.test("the importer creates the exam as data: 3 sessions, 3 texts, 15 questions, 60 options, 15 keys, settings, published", async () => {
    const result = await importEvaluation(as(owner.cookie), slug, definition);
    assert.deepEqual([result.created, result.status, result.questions, result.version], [true, "PUBLISHED", 15, 1]);
    evaluationId = result.evaluationId;
    const view = ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200);
    const c = view.content;
    assert.deepEqual([c.sections.length, c.passages.length, c.questions.length], [3, 3, 15]);
    assert.deepEqual(c.sections.map((s: { id: string }) => c.questions.filter((q: { sectionId: string }) => q.sectionId === s.id).length), [5, 5, 5]);
    assert.equal(c.questions.reduce((sum: number, q: { options: unknown[] }) => sum + q.options.length, 0), 60);
    assert.ok(c.questions.every((q: { options: unknown[]; correctOptionId: string | null; explanation: unknown[] }) => q.options.length === 4 && q.correctOptionId && q.explanation.length === 1));
    const letters = definition.sections.flatMap((s: { questions: Array<{ correct: string }> }) => s.questions.map((q) => q.correct));
    assert.deepEqual(c.questions.map((q: { options: Array<{ id: string }>; correctOptionId: string }) => String.fromCharCode(65 + q.options.findIndex((o) => o.id === q.correctOptionId))), letters, "the stored key is the one in the definition");
    assert.deepEqual([c.settings.durationMinutes, c.settings.pacing, c.settings.scoring.wrongPenaltyPercent, c.settings.review.mode], [30, { navigation: "FORWARD_ONLY", questionSeconds: 120, sessionMinutes: null }, 0, "AFTER_SUBMIT"]);
    assert.equal(view.key, "lectura-critica-principito-01");
  });

  await t.test("the import is idempotent and never touches what exists; another organization gets its own copy", async () => {
    const again = await importEvaluation(as(owner.cookie), slug, definition);
    assert.deepEqual([again.created, again.evaluationId], [false, evaluationId]);
    assert.equal(await prisma.evaluation.count({ where: { organizationId: org, key: definition.key } }), 1);
    assert.equal(await prisma.evaluationVersion.count({ where: { evaluationId } }), 1);
    // a failed import leaves no half-finished draft behind
    await assert.rejects(importEvaluation(as(owner.cookie), slug, { ...definition, key: "broken-import", sections: [{ ...definition.sections[0], questions: [{ ...definition.sections[0].questions[0], correct: "Z" }] }] }));
    assert.equal(await prisma.evaluation.count({ where: { organizationId: org, key: "broken-import" } }), 0);
  });

  const correctLetters = definition.sections.flatMap((s: { questions: Array<{ correct: string }> }) => s.questions.map((q) => q.correct)) as string[];
  const optionByLetter = (view: { content: { questions: Array<{ options: Array<{ id: string; label: string }> }> } }, letter: string) => view.content.questions[0]!.options.find((o) => o.label === letter)!.id;
  const confirm = (cookie: string, attemptId: string, questionId: string, optionId: string | null) => call("POST", `${base}/evaluation-attempts/${attemptId}/confirm`, cookie, { questionId, optionId });
  const pace = { alice: { id: "", t0: 0, ids: [] as string[] } };

  await t.test("starting: explicit, one open question at a time, 30-minute cap, no key and no other questions delivered", async () => {
    const available = ok(await call("GET", `${base}/evaluations/available`, alice.cookie), 200);
    assert.deepEqual([available[0].sectionCount, available[0].questionCount, available[0].durationMinutes, available[0].pacing], [3, 15, 30, { navigation: "FORWARD_ONLY", questionSeconds: 120, sessionMinutes: null }]);
    const started = await call("POST", `${base}/evaluations/${evaluationId}/attempts`, alice.cookie);
    const view = ok(started, 200);
    pace.alice.id = view.id;
    const attempt = await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: view.id } });
    pace.alice.t0 = attempt.startedAt.getTime();
    assert.equal(attempt.deadlineAt!.getTime() - attempt.startedAt.getTime(), 30 * 60_000, "never more than 30 minutes of active time");
    assert.deepEqual([view.content.questions.length, view.content.passages.length, view.progress.total, view.progress.closed, view.progress.index, view.progress.sections.length], [1, 1, 15, 0, 0, 3]);
    assert.ok(view.current.remainingSeconds > 118 && view.current.remainingSeconds <= 120);
    for (const secret of ["correctOptionId", "El aterrizaje fue provocado", "campos de trigo", "Todas las relaciones adquieren", "explanation"]) assert.ok(!started.body.includes(secret), `leaked: ${secret}`);
    pace.alice.ids = ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200).content.questions.map((q: { id: string }) => q.id);
    // starting again resumes the same attempt (two tabs, a double click)
    assert.equal(ok(await call("POST", `${base}/evaluations/${evaluationId}/attempts`, alice.cookie), 200).id, view.id);
  });

  const at = (ms: number) => new Date(pace.alice.t0 + ms);
  let q1View: { content: { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> } };

  await t.test("a confirmation inside the window is registered and the next question opens at that moment (time is not carried over)", async () => {
    q1View = ok(await call("GET", `${base}/evaluation-attempts/${pace.alice.id}`, alice.cookie), 200);
    const answer = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[0]!, optionId: optionByLetter(q1View, correctLetters[0]!) }, at(10_000));
    assert.deepEqual([answer.accepted, answer.attempt.progress.closed, answer.attempt.progress.index], [true, 1, 1]);
    const next = answer.attempt.current as { openedAt: Date; expiresAt: Date };
    assert.deepEqual([next.openedAt.getTime(), next.expiresAt.getTime()], [at(10_000).getTime(), at(130_000).getTime()], "question 2 has its own full 120 s starting at the confirmation");
    // the draft selection of a closed question can no longer change
    const late = ok(await call("PUT", `${base}/evaluation-attempts/${pace.alice.id}/answers`, alice.cookie, { answers: [{ questionId: pace.alice.ids[0], optionId: null, seq: 99 }] }), 200);
    assert.deepEqual([late.applied, late.ignored], [[], [pace.alice.ids[0]]]);
  });

  await t.test("a confirmation exactly at the limit is valid; one millisecond later is invalid_timeout, decided by the server clock", async () => {
    const q2 = (await evaluations.getAttempt(alice.id, org, pace.alice.id, at(11_000))).content as { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> };
    const wrongForQ2 = q2.questions[0]!.options.find((o) => o.label !== correctLetters[1])!.id;
    const exact = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[1]!, optionId: wrongForQ2 }, at(130_000));
    assert.equal(exact.accepted, true, "on the boundary");
    // question 3 opened at 130 000 and closes at 250 000
    const late = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[2]!, optionId: null }, at(250_001));
    assert.deepEqual([late.accepted, late.reason], [false, "TIMEOUT"]);
    const rows = await prisma.evaluationAnswer.findMany({ where: { attemptId: pace.alice.id }, orderBy: { openedAt: "asc" } });
    const q3 = rows.find((r) => r.questionId === pace.alice.ids[2]);
    const q4 = rows.find((r) => r.questionId === pace.alice.ids[3]);
    assert.deepEqual([q3?.closure, q3?.closedAt?.getTime(), q4?.openedAt?.getTime()], ["TIMEOUT", at(250_000).getTime(), at(250_000).getTime()], "closed at ITS deadline; the next question opened then, not when the client asked");
  });

  await t.test("duplicates are idempotent, conflicting repeats and closed or future questions are refused, nothing closed can be modified", async () => {
    const attemptRow = ok(await call("GET", `${base}/evaluation-attempts/${pace.alice.id}`, alice.cookie), 200);
    void attemptRow;
    const stored = await prisma.evaluationAnswer.findUniqueOrThrow({ where: { attemptId_questionId: { attemptId: pace.alice.id, questionId: pace.alice.ids[1]! } } });
    const same = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[1]!, optionId: stored.optionId }, at(251_000));
    assert.equal(same.accepted, true, "a repeated request with the same choice succeeds");
    const q2Options = ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200).content.questions[1].options as Array<{ id: string }>;
    const different = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[1]!, optionId: q2Options.find((o) => o.id !== stored.optionId)!.id }, at(251_500));
    assert.deepEqual([different.accepted, different.reason], [false, "ALREADY_CLOSED"]);
    const future = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[9]!, optionId: null }, at(252_000));
    assert.deepEqual([future.accepted, future.reason], [false, "NOT_CURRENT"]);
    assert.equal(ok(await call("POST", `${base}/evaluation-attempts/${pace.alice.id}/submit`, alice.cookie), 409).error.code, "ATTEMPT_PACED");
    assert.equal(ok(await call("POST", `${base}/evaluation-attempts/${pace.alice.id}/confirm`, bob.cookie, { questionId: pace.alice.ids[3], optionId: null }), 404).error.code, "NOT_FOUND");
  });

  await t.test("reloading late recovers nothing: every question whose window passed is closed at its own deadline", async () => {
    const view = await evaluations.getAttempt(alice.id, org, pace.alice.id, at(400_000));
    // q4 opened at 250 000 -> closed at 370 000; q5 opened at 370 000 and is open until 490 000
    const current = view.current as { questionId: string; openedAt: Date; remainingSeconds: number };
    assert.deepEqual([current.questionId, current.openedAt.getTime(), current.remainingSeconds], [pace.alice.ids[4], at(370_000).getTime(), 90]);
    assert.deepEqual([view.progress!.closed, view.progress!.index], [4, 4]);
  });

  await t.test("closing a question without answering is `omitted`; parallel confirmations of the same question settle on one answer", async () => {
    const omitted = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[4]!, optionId: null }, at(401_000));
    assert.equal(omitted.accepted, true);
    const q6 = (await evaluations.getAttempt(alice.id, org, pace.alice.id, at(402_000))).content as { questions: Array<{ id: string; options: Array<{ id: string; label: string }> }> };
    const right = q6.questions[0]!.options.find((o) => o.label === correctLetters[5])!.id;
    // the same confirmation twice at once (double click): both succeed, one row
    const [a, b] = await Promise.all([1, 2].map(() => evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[5]!, optionId: right }, at(403_000))));
    assert.deepEqual([a.accepted, b.accepted], [true, true]);
    assert.equal(await prisma.evaluationAnswer.count({ where: { attemptId: pace.alice.id, questionId: pace.alice.ids[5]! } }), 1);
    // two different choices at once: exactly one wins, the other is told it was already closed
    const q7 = (await evaluations.getAttempt(alice.id, org, pace.alice.id, at(404_000))).content as { questions: Array<{ options: Array<{ id: string; label: string }> }> };
    const wrong = q7.questions[0]!.options.filter((o) => o.label !== correctLetters[6]).slice(0, 2).map((o) => o.id);
    const race = await Promise.all(wrong.map((optionId) => evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[6]!, optionId }, at(405_000))));
    assert.deepEqual(race.map((r) => r.accepted).sort(), [false, true]);
  });

  let aliceResultId = "";
  await t.test("questions left unattended time out one by one at their own deadlines and the attempt ends by itself; the score is graded by the server", async () => {
    const view = await evaluations.getAttempt(alice.id, org, pace.alice.id, at(30 * 60_000 + 1));
    assert.equal(view.status, "SUBMITTED", "all fifteen questions are closed");
    assert.equal(view.content, null);
    const result = view.result!;
    assert.deepEqual([result.correct, result.incorrect, result.unanswered, result.timedOut], [2, 2, 1, 10]);
    assert.deepEqual([result.scorePoints, result.maxPoints, result.percent, result.timeUsedSeconds], [2, 15, 13.33, 1365], "the last unattended question closed at 405 s + 8 x 120 s");
    assert.deepEqual(result.breakdown.bySection.map((s: { correct: number; timedOut: number; percent: number }) => [s.correct, s.timedOut, s.percent]), [[1, 2, 20], [1, 3, 20], [0, 5, 0]], "score per session");
    const row = await prisma.evaluationResult.findUniqueOrThrow({ where: { attemptId: pace.alice.id } });
    assert.deepEqual([row.timedOut, row.scoreCenti, row.maxScoreCenti], [10, 200, 1500]);
    aliceResultId = pace.alice.id;
    // nothing can be changed afterwards
    const refused = await evaluations.confirmAnswer(alice.id, org, pace.alice.id, { questionId: pace.alice.ids[7]!, optionId: null }, at(30 * 60_000 + 5));
    assert.equal(refused.accepted, false);
    assert.equal(ok(await call("PUT", `${base}/evaluation-attempts/${pace.alice.id}/answers`, alice.cookie, { answers: [{ questionId: pace.alice.ids[7], optionId: null, seq: 9 }] }), 409).error.code, "ATTEMPT_CLOSED");
  });

  await t.test("the global limit binds when it is shorter than the sum of the question windows: the open question and every unreached one are invalid_timeout", async () => {
    const short = await importEvaluation(as(owner.cookie), slug, { ...definition, key: "lectura-corta", title: "Corta", settings: { ...definition.settings, durationMinutes: 5 } });
    const view = ok(await call("POST", `${base}/evaluations/${short.evaluationId}/attempts`, bob.cookie), 200);
    const t0 = (await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: view.id } })).startedAt.getTime();
    const ended = await evaluations.getAttempt(bob.id, org, view.id, new Date(t0 + 300_001));
    assert.equal(ended.status, "EXPIRED");
    assert.deepEqual([ended.result!.timedOut, ended.result!.timeUsedSeconds, ended.result!.percent], [15, 300, 0]);
    const rows = await prisma.evaluationAnswer.findMany({ where: { attemptId: view.id, closure: "TIMEOUT" }, orderBy: { closedAt: "asc" } });
    assert.deepEqual(rows.map((r) => r.closedAt!.getTime() - t0), [120_000, 240_000, 300_000], "the third question is cut by the global deadline; the rest never opened");
  });

  await t.test("the review (key, explanations, statuses) is released only after the attempt is closed, per the version's policy", async () => {
    const result = ok(await call("GET", `${base}/evaluation-attempts/${aliceResultId}/result`, alice.cookie), 200);
    assert.equal(result.review.available, true);
    assert.deepEqual(result.review.items.map((i: { outcome: string }) => i.outcome), ["correct", "incorrect", "invalid_timeout", "invalid_timeout", "omitted", "correct", "incorrect", ...Array(8).fill("invalid_timeout")]);
    assert.ok(result.review.items.every((i: { explanation: unknown[]; correctOptionId: string }) => i.explanation.length === 1 && i.correctOptionId));
    assert.equal(ok(await call("GET", `${base}/evaluation-attempts/${aliceResultId}/result`, bob.cookie), 404).error.code, "NOT_FOUND");
  });

  await t.test("a complete run: fifteen confirmed answers end the attempt by themselves with the percentage = correct / 15 * 100", async () => {
    let view = ok(await call("POST", `${base}/evaluations/${evaluationId}/attempts`, bob.cookie), 200);
    const ids = pace.alice.ids;
    for (let i = 0; i < 15; i += 1) {
      assert.equal(view.progress.index, i);
      assert.equal(view.content.questions[0].id, ids[i]);
      // wrong for question 15, right for the rest
      const letter = i === 14 ? (correctLetters[i] === "A" ? "B" : "A") : correctLetters[i]!;
      const done = ok(await confirm(bob.cookie, view.id, ids[i]!, optionByLetter(view, letter)), 200);
      assert.equal(done.accepted, true);
      view = done.attempt;
    }
    assert.equal(view.status, "SUBMITTED");
    assert.deepEqual([view.result.correct, view.result.incorrect, view.result.unanswered, view.result.timedOut, view.result.percent], [14, 1, 0, 0, 93.33]);
    assert.deepEqual(view.result.breakdown.bySection.map((s: { percent: number }) => s.percent), [100, 100, 80]);
    assert.deepEqual(view.result.breakdown.byCategory.map((c: { title: string | null; key: string | null }) => c.key).sort(), ["Comprensión inferencial", "Comprensión literal", "Evaluación crítica"].sort());
    assert.equal(ok(await call("POST", `${base}/evaluations/${evaluationId}/attempts`, bob.cookie), 409).error.code, "EVALUATION_ATTEMPTS_EXHAUSTED");
  });

  await t.test("statistics tell errors, omissions and timeouts apart", async () => {
    const stats = ok(await call("GET", `${base}/evaluations/${evaluationId}/stats`, owner.cookie), 200).stats;
    const q = (n: number) => stats.questions[n - 1];
    assert.deepEqual([q(1).correct, q(2).incorrect, q(3).timedOut, q(5).omitted, q(7).incorrect, q(8).timedOut, q(15).incorrect], [2, 1, 1, 1, 1, 1, 1]);
    assert.equal(stats.attempts.graded, 2);
  });

  await t.test("the exam stays editable through the API and every change is a new version; attempts keep theirs; other tenants cannot reach it", async () => {
    const view = ok(await call("GET", `${base}/evaluations/${evaluationId}`, owner.cookie), 200);
    ok(await call("PATCH", `${base}/evaluations/${evaluationId}/questions/${view.content.questions[0].id}`, owner.cookie, { points: 2, expectedRevision: view.draftRevision }), 200);
    const v2 = ok(await call("POST", `${base}/evaluations/${evaluationId}/publish`, owner.cookie), 200);
    assert.equal(v2.version, 2);
    assert.equal((await prisma.evaluationAttempt.findUniqueOrThrow({ where: { id: aliceResultId } })).versionId, (await prisma.evaluationVersion.findFirstOrThrow({ where: { evaluationId, version: 1 } })).id);
    for (const url of [`${base}/evaluations/${evaluationId}`, `${base}/evaluations/${evaluationId}/stats`, `${base}/evaluation-attempts/${aliceResultId}`]) assert.ok([403, 404].includes((await call("GET", url, outsider.cookie)).statusCode), url);
  });
});
