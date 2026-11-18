import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** ADR 029 end to end: authoring, publication, assignment, attempts, server-side grading, key protection, versions, tenants. */
test("evaluations: author, publish, assign, take, autosave, grade; no key leaks; versions immutable; tenants isolated", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5546?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5546, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.${150 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
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

  const owner = await account("owner");
  const student = await account("student");
  const other = await account("other");
  const outsider = await account("outsider");
  const org = ok(await call("POST", "/v1/organizations", owner.cookie, { name: `Eval ${prefix}` }), 201).id as string;
  const foreignOrg = ok(await call("POST", "/v1/organizations", outsider.cookie, { name: `Foreign ${prefix}` }), 201).id as string;
  await prisma.membership.create({ data: { organizationId: org, userId: student.id, role: "MEMBER" } });
  await prisma.membership.create({ data: { organizationId: org, userId: other.id, role: "VIEWER" } });
  const base = `/v1/organizations/${org}`;
  const ev = `${base}/evaluations`;
  const text = (value: string) => [{ type: "paragraph", text: value }];

  // Synthetic fixture: three questions with 4, 3 and 5 options. Nothing is shipped; the engine is generic.
  const created = ok(await call("POST", ev, owner.cookie, { title: "Synthetic exam" }), 201);
  const id = created.id as string;
  const section = ok(await call("POST", `${ev}/${id}/sections`, owner.cookie, { title: "Part 1" }), 201).id as string;
  const passage = ok(await call("POST", `${ev}/${id}/passages`, owner.cookie, { title: "Text", body: text("A shared reference text.") }), 201).id as string;
  const questionIds: string[] = [];
  for (const [index, count] of [4, 3, 5].entries()) {
    const added = ok(await call("POST", `${ev}/${id}/questions`, owner.cookie, {
      sectionId: section, passageId: index < 2 ? passage : null, category: index === 2 ? "beta" : "alpha", prompt: text(`Question ${index + 1}`), points: 2,
      explanation: text(`because-${index + 1}`), options: Array.from({ length: count }, (_, i) => ({ text: `option ${i + 1}` })),
    }), 201);
    questionIds.push(added.id as string);
  }
  const draft = async () => ok(await call("GET", `${ev}/${id}`, owner.cookie), 200);
  const optionOf = async (q: number, position: number) => (await draft()).content.questions[q].options[position].id as string;

  await t.test("validation: unfinished questions cannot be published; the backend lists every issue", async () => {
    const report = ok(await call("POST", `${ev}/${id}/validate`, owner.cookie), 200);
    assert.equal(report.valid, false);
    assert.equal(report.issues.filter((i: { code: string }) => i.code === "EVALUATION_CORRECT_OPTION_MISSING").length, 3);
    assert.equal(ok(await call("POST", `${ev}/${id}/publish`, owner.cookie), 422).error.code, "EVALUATION_INVALID");
    // The correct option must be one of the question's options.
    assert.equal(ok(await call("PUT", `${ev}/${id}/questions/${questionIds[0]}/correct-option`, owner.cookie, { optionId: "not-an-option" }), 422).error.code, "EVALUATION_CORRECT_OPTION_INVALID");
  });

  await t.test("editors mark the correct option; stale revisions are refused; reorder must list everything", async () => {
    for (const [q, position] of [[0, 1], [1, 2], [2, 0]] as const) ok(await call("PUT", `${ev}/${id}/questions/${questionIds[q]}/correct-option`, owner.cookie, { optionId: await optionOf(q, position) }), 200);
    const view = await draft();
    assert.deepEqual(view.content.questions.map((q: { options: unknown[] }) => q.options.length), [4, 3, 5]);
    assert.equal(ok(await call("PATCH", `${ev}/${id}`, owner.cookie, { title: "Synthetic exam", expectedRevision: 1 }), 409).error.code, "EVALUATION_REVISION_CONFLICT");
    assert.equal(ok(await call("PUT", `${ev}/${id}/questions/order`, owner.cookie, { ids: questionIds.slice(1) }), 422).error.code, "EVALUATION_ORDER_INVALID");
    ok(await call("PATCH", `${ev}/${id}`, owner.cookie, { settings: { ...view.content.settings, maxAttempts: 2, review: { mode: "AFTER_SUBMIT", revealAfter: null } } }), 200);
    assert.equal(ok(await call("POST", `${ev}/${id}/validate`, owner.cookie), 200).valid, true);
  });

  let version1 = "";
  await t.test("publish creates an immutable version; publishing the same revision again is a no-op; versions are append-only in the database", async () => {
    const v1 = ok(await call("POST", `${ev}/${id}/publish`, owner.cookie), 200);
    version1 = v1.id;
    assert.deepEqual([v1.version, v1.questionCount, v1.maxPoints], [1, 3, 6]);
    assert.equal(ok(await call("POST", `${ev}/${id}/publish`, owner.cookie), 200).id, version1);
    await assert.rejects(prisma.evaluationVersion.update({ where: { id: version1 }, data: { questionCount: 99 } }), /append-only/);
    await assert.rejects(prisma.evaluationVersion.delete({ where: { id: version1 } }), /append-only/);
  });

  await t.test("authorization: a person who only takes evaluations never reaches authoring, keys or versions; nothing is visible before assignment", async () => {
    assert.deepEqual(ok(await call("GET", `${ev}/available`, student.cookie), 200), []);
    assert.equal(ok(await call("POST", `${ev}/${id}/attempts`, student.cookie), 404).error.code, "NOT_FOUND");
    for (const [method, url] of [["GET", ev], ["GET", `${ev}/${id}`], ["GET", `${ev}/${id}/versions`], ["GET", `${ev}/${id}/attempts`], ["POST", `${ev}/${id}/publish`], ["GET", `${ev}/${id}/assignments`]] as const)
      assert.equal((await call(method, url, student.cookie)).statusCode, 403, `${method} ${url}`);
    assert.equal(ok(await call("PUT", `${ev}/${id}/assignments`, student.cookie, { assignments: [{ role: "MEMBER" }] }), 403).error.code, "FORBIDDEN");
  });

  await t.test("assignments: validated, replace atomically, windows are enforced", async () => {
    assert.equal(ok(await call("PUT", `${ev}/${id}/assignments`, owner.cookie, { assignments: [{ role: "MEMBER", userId: student.id }] }), 422).error.code, "EVALUATION_ASSIGNMENT_INVALID");
    assert.equal(ok(await call("PUT", `${ev}/${id}/assignments`, owner.cookie, { assignments: [{ userId: outsider.id }] }), 422).error.code, "EVALUATION_ASSIGNMENT_INVALID");
    assert.equal(ok(await call("PUT", `${ev}/${id}/assignments`, owner.cookie, { assignments: [{ role: "MEMBER" }, { role: "MEMBER" }] }), 409).error.code, "EVALUATION_ASSIGNMENT_CONFLICT");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    ok(await call("PUT", `${ev}/${id}/assignments`, owner.cookie, { assignments: [{ role: "MEMBER", opensAt: future }] }), 200);
    const listed = ok(await call("GET", `${ev}/available`, student.cookie), 200);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].canStart, false);
    assert.equal(ok(await call("POST", `${ev}/${id}/attempts`, student.cookie), 409).error.code, "EVALUATION_WINDOW_CLOSED");
    ok(await call("PUT", `${ev}/${id}/assignments`, owner.cookie, { assignments: [{ userId: student.id }] }), 200);
    assert.equal(ok(await call("GET", `${ev}/available`, student.cookie), 200)[0].canStart, true);
    assert.deepEqual(ok(await call("GET", `${ev}/available`, other.cookie), 200), [], "the other viewer is not assigned");
  });

  let attemptId = "";
  await t.test("starting is idempotent even under concurrency; the content has no answer key and no explanation", async () => {
    const starts = await Promise.all([1, 2, 3].map(() => call("POST", `${ev}/${id}/attempts`, student.cookie)));
    assert.deepEqual(starts.map((r) => r.statusCode), [200, 200, 200]);
    const bodies = starts.filter((r) => r.statusCode === 200).map((r) => r.json());
    assert.ok(bodies.length >= 1);
    assert.equal(new Set(bodies.map((b) => b.id)).size, 1, "one attempt");
    assert.equal(await prisma.evaluationAttempt.count({ where: { evaluationId: id, userId: student.id } }), 1);
    attemptId = bodies[0].id;
    const raw = starts.find((r) => r.statusCode === 200)!.body;
    assert.ok(!raw.includes("correctOptionId") && !raw.includes("because-") && !raw.includes("explanation"));
    const content = bodies[0].content;
    assert.deepEqual(content.questions.map((q: { options: unknown[] }) => q.options.length), [4, 3, 5]);
    assert.deepEqual(content.questions[2].options.map((o: { label: string }) => o.label), ["A", "B", "C", "D", "E"]);
    assert.equal(content.questions[0].passageId, content.passages[0].id);
  });

  await t.test("autosave: authoritative on the server, newer wins, old retries are ignored, foreign ids are refused", async () => {
    const q = (await draft()).content.questions;
    const put = (answers: unknown[], cookie = student.cookie) => call("PUT", `${base}/evaluation-attempts/${attemptId}/answers`, cookie, { answers });
    const first = ok(await put([{ questionId: q[0].id, optionId: q[0].options[0].id, seq: 1 }]), 200);
    assert.deepEqual(first.applied, [q[0].id]);
    const newer = ok(await put([{ questionId: q[0].id, optionId: q[0].options[1].id, seq: 3 }]), 200);
    assert.deepEqual(newer.applied, [q[0].id]);
    const stale = ok(await put([{ questionId: q[0].id, optionId: q[0].options[2].id, seq: 2 }]), 200);
    assert.deepEqual([stale.applied, stale.ignored], [[], [q[0].id]]);
    assert.equal(stale.answers[0].optionId, q[0].options[1].id, "the server keeps the later answer");
    ok(await put([{ questionId: q[1].id, optionId: q[1].options[0].id, seq: 1 }]), 200);
    assert.equal(ok(await put([{ questionId: q[2].id, optionId: q[0].options[0].id, seq: 1 }]), 422).error.code, "ATTEMPT_OPTION_UNKNOWN");
    assert.equal(ok(await put([{ questionId: "nope", optionId: null, seq: 1 }]), 422).error.code, "ATTEMPT_QUESTION_UNKNOWN");
    // Reload (new tab, other device): the same state comes back from the server.
    const reloaded = ok(await call("GET", `${base}/evaluation-attempts/${attemptId}`, student.cookie), 200);
    assert.deepEqual(reloaded.answers.map((a: { questionId: string; optionId: string }) => [a.questionId, a.optionId]).sort(), [[q[0].id, q[0].options[1].id], [q[1].id, q[1].options[0].id]].sort());
    // Another person, even a member, cannot see or write it.
    assert.equal((await put([{ questionId: q[0].id, optionId: null, seq: 9 }], other.cookie)).statusCode, 404);
    assert.equal((await call("GET", `${base}/evaluation-attempts/${attemptId}`, other.cookie)).statusCode, 404);
    assert.equal((await call("GET", `${base}/evaluation-attempts/${attemptId}`, outsider.cookie)).statusCode, 404);
  });

  await t.test("the key changes after publication: the open attempt is still graded by its own version, on the server", async () => {
    const view = await draft();
    // Q1's key moves from option 2 to option 1 in the draft and a new version is published.
    ok(await call("PUT", `${ev}/${id}/questions/${questionIds[0]}/correct-option`, owner.cookie, { optionId: await optionOf(0, 0) }), 200);
    ok(await call("PATCH", `${ev}/${id}`, owner.cookie, { settings: { ...view.content.settings, review: { mode: "NEVER", revealAfter: null } } }), 200);
    const v2 = ok(await call("POST", `${ev}/${id}/publish`, owner.cookie), 200);
    assert.equal(v2.version, 2);
    assert.equal(ok(await call("GET", `${ev}/${id}/versions`, owner.cookie), 200).length, 2);

    const result = ok(await call("POST", `${base}/evaluation-attempts/${attemptId}/submit`, student.cookie), 200);
    // Version 1 key: Q1 = option 2 (answered option 2: right), Q2 = option 3 (answered option 1: wrong), Q3 unanswered. 2 of 6 points.
    assert.deepEqual([result.correct, result.incorrect, result.unanswered, result.scorePoints, result.maxPoints, result.percent], [1, 1, 1, 2, 6, 33.33]);
    assert.deepEqual(result.breakdown.byCategory.map((c: { key: string; correct: number }) => [c.key, c.correct]).sort(), [["alpha", 1], ["beta", 0]]);
    assert.equal(result.review.available, true, "v1 review policy was AFTER_SUBMIT");
    assert.equal(result.review.items[0].correctOptionId, (await prisma.evaluationVersion.findUniqueOrThrow({ where: { id: version1 } })).snapshot && (view.content.questions[0].options[1].id));
    assert.deepEqual([result.review.items[0].number, result.review.items[0].options.length, result.review.items[0].options[0].label], [1, 4, "A"], "the review carries the statement and options");
    // Repeating the submit returns the same result and grades once.
    assert.deepEqual(ok(await call("POST", `${base}/evaluation-attempts/${attemptId}/submit`, student.cookie), 200), result);
    assert.equal(await prisma.evaluationResult.count({ where: { attemptId } }), 1);
    assert.equal(ok(await call("PUT", `${base}/evaluation-attempts/${attemptId}/answers`, student.cookie, { answers: [{ questionId: view.content.questions[0].id, optionId: null, seq: 99 }] }), 409).error.code, "ATTEMPT_CLOSED");
  });

  await t.test("a second attempt uses the newest version; review NEVER withholds answers; attempts run out", async () => {
    const second = ok(await call("POST", `${ev}/${id}/attempts`, student.cookie), 200);
    assert.equal(second.attemptNumber, 2);
    const submitted = ok(await call("POST", `${base}/evaluation-attempts/${second.id}/submit`, student.cookie), 200);
    assert.deepEqual([submitted.unanswered, submitted.scorePoints], [3, 0]);
    assert.deepEqual([submitted.review.available, submitted.review.items], [false, null]);
    assert.ok(!JSON.stringify(submitted).includes("correctOptionId"));
    assert.equal(ok(await call("POST", `${ev}/${id}/attempts`, student.cookie), 409).error.code, "EVALUATION_ATTEMPTS_EXHAUSTED");
    assert.equal(ok(await call("GET", `${ev}/available`, student.cookie), 200)[0].canStart, false);
  });

  await t.test("results: authors read every attempt and every review; a student reads only their own", async () => {
    const rows = ok(await call("GET", `${ev}/${id}/attempts`, owner.cookie), 200);
    assert.deepEqual(rows.map((r: { attemptNumber: number; scorePoints: number }) => [r.attemptNumber, r.scorePoints]).sort(), [[1, 2], [2, 0]]);
    const asAuthor = ok(await call("GET", `${base}/evaluation-attempts/${rows.find((r: { attemptNumber: number }) => r.attemptNumber === 2).id}/result`, owner.cookie), 200);
    assert.equal(asAuthor.review.available, true, "result readers always see the review");
    assert.equal(ok(await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, student.cookie), 200).scorePoints, 2);
    assert.equal((await call("GET", `${base}/evaluation-attempts/${attemptId}/result`, other.cookie)).statusCode, 404);
  });

  await t.test("statistics: per version, hardest questions with distractors, comparison between versions; only result readers; own history for students", async () => {
    assert.equal((await call("GET", `${ev}/${id}/stats`, student.cookie)).statusCode, 403);
    assert.equal((await call("GET", `${ev}/${id}/stats`, outsider.cookie)).statusCode >= 403, true);
    const latest = ok(await call("GET", `${ev}/${id}/stats`, owner.cookie), 200);
    assert.equal(latest.selectedVersionId, latest.versions.find((v: { version: number }) => v.version === 2).id, "defaults to the latest version with attempts");
    assert.deepEqual(latest.versions.map((v: { version: number; attempts: number; graded: number; meanPercent: number }) => [v.version, v.attempts, v.graded, v.meanPercent]), [[1, 1, 1, 33.33], [2, 1, 1, 0]]);
    const v1 = ok(await call("GET", `${ev}/${id}/stats?versionId=${version1}`, owner.cookie), 200).stats;
    assert.deepEqual([v1.attempts.completionRate, v1.attempts.graded, v1.score.meanPercent, v1.averageTimeSeconds >= 0], [100, 1, 33.33, true]);
    assert.deepEqual(v1.questions.map((q: { correctRate: number }) => q.correctRate), [100, 0, 0]);
    assert.deepEqual(v1.hardest.slice(0, 2), [v1.questions[1].questionId, v1.questions[2].questionId], "hardest first");
    assert.deepEqual([v1.questions[2].omitted, v1.questions[1].incorrect], [1, 1]);
    assert.equal(v1.questions[1].options.filter((o: { picked: number }) => o.picked > 0).length, 1, "distractor counts");
    assert.equal(v1.score.distribution.reduce((sum: number, b: { count: number }) => sum + b.count, 0), 1);
    assert.equal((await call("GET", `${ev}/${id}/stats?versionId=cmforeign000000000000000000`, owner.cookie)).statusCode, 404);
    const mine = ok(await call("GET", `${base}/evaluation-results/mine`, student.cookie), 200);
    assert.deepEqual(mine.map((r: { attemptNumber: number; percent: number; title: string }) => [r.attemptNumber, r.percent, r.title]).sort(), [[1, 33.33, "Synthetic exam"], [2, 0, "Synthetic exam"]].sort());
    assert.deepEqual(ok(await call("GET", `${base}/evaluation-results/mine`, other.cookie), 200), [], "nobody sees another person's history");
  });

  await t.test("time limit: an attempt past its deadline is closed and graded by the server from what was saved", async () => {
    const timed = ok(await call("POST", ev, owner.cookie, { title: "Timed" }), 201).id as string;
    const sec = ok(await call("POST", `${ev}/${timed}/sections`, owner.cookie, { title: "S" }), 201).id as string;
    const qid = ok(await call("POST", `${ev}/${timed}/questions`, owner.cookie, { sectionId: sec, prompt: text("Q"), points: 1, options: [{ text: "x" }, { text: "y" }] }), 201).id as string;
    const view = ok(await call("GET", `${ev}/${timed}`, owner.cookie), 200);
    ok(await call("PUT", `${ev}/${timed}/questions/${qid}/correct-option`, owner.cookie, { optionId: view.content.questions[0].options[0].id }), 200);
    ok(await call("PATCH", `${ev}/${timed}`, owner.cookie, { settings: { ...view.content.settings, durationMinutes: 5, maxAttempts: null } }), 200);
    ok(await call("POST", `${ev}/${timed}/publish`, owner.cookie), 200);
    ok(await call("PUT", `${ev}/${timed}/assignments`, owner.cookie, { assignments: [{ role: "MEMBER" }] }), 200);
    const attempt = ok(await call("POST", `${ev}/${timed}/attempts`, student.cookie), 200);
    assert.ok(attempt.remainingSeconds > 290 && attempt.remainingSeconds <= 300);
    ok(await call("PUT", `${base}/evaluation-attempts/${attempt.id}/answers`, student.cookie, { answers: [{ questionId: qid, optionId: view.content.questions[0].options[0].id, seq: 1 }] }), 200);
    await prisma.evaluationAttempt.update({ where: { id: attempt.id }, data: { deadlineAt: new Date(Date.now() - 60_000) } });
    const closed = ok(await call("GET", `${base}/evaluation-attempts/${attempt.id}`, student.cookie), 200);
    assert.deepEqual([closed.status, closed.content, closed.result.correct], ["EXPIRED", null, 1]);
  });

  await t.test("tenants: another organization's owner reaches nothing; ids never cross organizations", async () => {
    for (const [method, url] of [["GET", `${ev}/${id}`], ["POST", `${ev}/${id}/attempts`], ["GET", `${ev}/${id}/attempts`], ["POST", `${ev}/${id}/publish`], ["GET", `${base}/evaluation-attempts/${attemptId}`]] as const)
      assert.ok([403, 404].includes((await call(method, url, outsider.cookie)).statusCode), `${method} ${url}`);
    // An evaluation id of this organization addressed through the foreign organization is simply not found.
    assert.equal((await call("GET", `/v1/organizations/${foreignOrg}/evaluations/${id}`, outsider.cookie)).statusCode, 404);
    assert.equal((await call("PATCH", `/v1/organizations/${foreignOrg}/evaluations/${id}`, outsider.cookie, { title: "hijack" })).statusCode, 404);
    assert.equal((await call("GET", `/v1/organizations/${foreignOrg}/evaluation-attempts/${attemptId}`, outsider.cookie)).statusCode, 404);
    assert.equal((await prisma.evaluation.findUniqueOrThrow({ where: { id } })).title, "Synthetic exam");
  });

  await t.test("lifecycle: published evaluations are archived, never deleted; drafts can be duplicated and deleted; archived ones stop starting", async () => {
    assert.equal(ok(await call("DELETE", `${ev}/${id}`, owner.cookie), 409).error.code, "EVALUATION_HAS_HISTORY");
    const copy = ok(await call("POST", `${ev}/${id}/duplicate`, owner.cookie), 201);
    assert.equal(copy.status, "DRAFT");
    assert.equal(copy.content.questions.length, 3);
    ok(await call("DELETE", `${ev}/${copy.id}`, owner.cookie), 204);
    ok(await call("POST", `${ev}/${id}/archive`, owner.cookie), 200);
    assert.equal(ok(await call("POST", `${ev}/${id}/attempts`, student.cookie), 404).error.code, "NOT_FOUND");
    assert.equal(ok(await call("POST", `${ev}/${id}/sections`, owner.cookie, { title: "x" }), 409).error.code, "EVALUATION_ARCHIVED");
    assert.equal(ok(await call("POST", `${ev}/${id}/unarchive`, owner.cookie), 200).status, "PUBLISHED");
  });

  await t.test("every administrative change is audited", async () => {
    const actions = (await prisma.auditLog.findMany({ where: { organizationId: org, action: { startsWith: "EVALUATION_" } }, select: { action: true } })).map((row) => row.action);
    for (const action of ["EVALUATION_CREATED", "EVALUATION_DRAFT_UPDATED", "EVALUATION_PUBLISHED", "EVALUATION_ASSIGNMENTS_UPDATED", "EVALUATION_ATTEMPT_STARTED", "EVALUATION_ATTEMPT_SUBMITTED", "EVALUATION_ARCHIVED"])
      assert.ok(actions.includes(action), action);
  });
});
