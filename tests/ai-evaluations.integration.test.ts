import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

/** Phase 7: assistant x evaluations. Authors only, no answer key, drafts need human review, blocked during attempts unless allowed, context is re-authorized. */
test("assistant and evaluations: tools for authors only, drafts need review, attempts block it, context is authorized", { skip: !process.env.TEST_DATABASE_URL, timeout: 300_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5548?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-never-called";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5548, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const { aiTools } = await import("../src/modules/ai/tool-registry.js");
  const { ai } = await import("../src/modules/ai/service.js");
  const { evaluations } = await import("../src/modules/evaluations/service.js");
  const { describeRunContext } = await import("../src/modules/ai/run-context.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const prefix = randomUUID().slice(0, 8);
  const password = "Test-password-only-123!";
  let n = 0;
  type Method = "GET" | "POST" | "PATCH" | "PUT";
  const call = (method: Method, url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, remoteAddress: `127.0.${180 + Math.floor(n / 250)}.${(n++ % 250) + 1}`, headers: { origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const ok = async (response: Awaited<ReturnType<typeof call>>, status: number) => { assert.equal(response.statusCode, status, response.body); return response.body ? response.json() : null; };
  async function account(label: string) {
    const email = `${prefix}-${label}@blackpolar.test`;
    await ok(await call("POST", "/v1/auth/sign-up/email", undefined, { email, password, name: label }), 200);
    const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
    await ok(await call("POST", "/v1/identity/verification/confirm", undefined, { email, code }), 200);
    const login = await call("POST", "/v1/auth/sign-in/email", undefined, { email, password });
    await ok(login, 200);
    return { id: (await prisma.user.findUniqueOrThrow({ where: { email } })).id, cookie: login.cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ") };
  }
  const owner = await account("owner");
  const student = await account("student");
  const outsider = await account("outsider");
  const org = (await ok(await call("POST", "/v1/organizations", owner.cookie, { name: `AIEval ${prefix}` }), 201)).id as string;
  const otherOrg = (await ok(await call("POST", "/v1/organizations", outsider.cookie, { name: `Other ${prefix}` }), 201)).id as string;
  await prisma.membership.create({ data: { organizationId: org, userId: student.id, role: "MEMBER" } });
  const base = `/v1/organizations/${org}/evaluations`;
  const text = (value: string) => [{ type: "paragraph", text: value }];
  const asOwner = { userId: owner.id, organizationId: org, application: "north" as const };
  const asStudent = { userId: student.id, organizationId: org, application: "north" as const };

  async function exam(body: { title: string; allowAi: boolean }) {
    const created = await ok(await call("POST", base, owner.cookie, { title: body.title }), 201);
    const section = (await ok(await call("POST", `${base}/${created.id}/sections`, owner.cookie, { title: "S" }), 201)).id;
    const q = await ok(await call("POST", `${base}/${created.id}/questions`, owner.cookie, { sectionId: section, prompt: text("Original statement"), points: 1, explanation: text("SECRET-EXPLANATION"), options: [{ text: "a" }, { text: "b" }, { text: "c" }] }), 201);
    const view = await ok(await call("GET", `${base}/${created.id}`, owner.cookie), 200);
    await ok(await call("PUT", `${base}/${created.id}/questions/${q.id}/correct-option`, owner.cookie, { optionId: view.content.questions[0].options[1].id }), 200);
    await ok(await call("PATCH", `${base}/${created.id}`, owner.cookie, { settings: { ...view.content.settings, ai: { allowedDuringAttempt: body.allowAi } } }), 200);
    await ok(await call("POST", `${base}/${created.id}/publish`, owner.cookie), 200);
    await ok(await call("PUT", `${base}/${created.id}/assignments`, owner.cookie, { assignments: [{ role: "MEMBER" }] }), 200);
    return { id: created.id as string, section: section as string };
  }
  const closed = await exam({ title: "Closed book", allowAi: false });

  await t.test("evaluation tools exist only for people who can edit; a person who only takes evaluations has none", async () => {
    const names = async (context: typeof asOwner) => (await aiTools.available(context)).map((tool) => tool.name).filter((name) => name.startsWith("evaluations."));
    assert.deepEqual((await names(asOwner)).sort(), ["evaluations.draft_questions", "evaluations.list", "evaluations.outline"]);
    assert.deepEqual(await names(asStudent), []);
    await assert.rejects(aiTools.propose(asStudent, "evaluations.draft_questions", { evaluationId: closed.id, sectionId: closed.section, questions: [{ prompt: "x", options: ["a", "b"], correctIndex: 0 }] }), (error: { code?: string }) => error.code === "AI_TOOL_UNAVAILABLE");
  });

  await t.test("the outline never carries the answer key or the explanations", async () => {
    const { result } = await aiTools.execute(asOwner, "evaluations.outline", { evaluationId: closed.id });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("SECRET-EXPLANATION") && !serialized.includes("correctOptionId") && !serialized.includes("explanation"));
    assert.deepEqual((result as { questions: Array<{ options: number; statement: string }> }).questions.map((q) => [q.options, q.statement]), [[3, "Original statement"]]);
    await assert.rejects(aiTools.execute(asOwner, "evaluations.outline", { evaluationId: "cmforeign000000000000000000" }), (error: { statusCode?: number }) => error.statusCode === 404);
  });

  await t.test("drafting is a proposal; only a confirmation adds AI drafts, and publication is blocked until a person reviews them", async () => {
    const input = { evaluationId: closed.id, sectionId: closed.section, questions: [
      { prompt: "AI question one?", options: ["x", "y", "z", "w"], correctIndex: 2, explanation: "because", category: "Inference" },
      { prompt: "AI question two?", options: ["p", "q"], correctIndex: 0 },
    ] };
    const proposal = await aiTools.propose(asOwner, "evaluations.draft_questions", input);
    assert.match(proposal.summary, /2 question draft/);
    const count = async () => (await ok(await call("GET", `${base}/${closed.id}`, owner.cookie), 200)).content.questions.length as number;
    assert.equal(await count(), 1, "proposing changes nothing");
    await assert.rejects(aiTools.propose(asOwner, "evaluations.draft_questions", { ...input, sectionId: "nope" }), (error: { code?: string }) => error.code === "AI_SECTION_UNKNOWN");
    await assert.rejects(aiTools.propose(asOwner, "evaluations.draft_questions", { ...input, questions: [{ prompt: "x", options: ["a", "b"], correctIndex: 5 }] }));

    const conversation = await prisma.aIConversation.create({ data: { organizationId: org, userId: owner.id, application: "NORTH" } });
    const run = await prisma.aIRun.create({ data: { conversationId: conversation.id, organizationId: org, userId: owner.id, application: "NORTH", status: "COMPLETED", provider: "gemini", model: "test", completedAt: new Date() } });
    const action = await prisma.aIAction.create({ data: { runId: run.id, organizationId: org, userId: owner.id, toolName: "evaluations.draft_questions", arguments: { input: proposal.input, summary: proposal.summary } as never, expiresAt: new Date(Date.now() + 600_000) } });
    await assert.rejects(ai.confirmAction(student.id, action.id), (error: { statusCode?: number }) => error.statusCode === 404);
    assert.equal(await count(), 1);
    assert.equal((await ai.confirmAction(owner.id, action.id)).status, "CONFIRMED");
    const view = await ok(await call("GET", `${base}/${closed.id}`, owner.cookie), 200);
    const added = view.content.questions.slice(1);
    assert.deepEqual([added.length, added.map((q: { aiDraft?: boolean }) => q.aiDraft), added[0].category, added[0].options.length], [2, [true, true], "Inference", 4]);
    assert.equal(added[0].correctOptionId, added[0].options[2].id, "the proposed key is set (the author verifies it)");

    // Review gate.
    const report = await ok(await call("POST", `${base}/${closed.id}/validate`, owner.cookie), 200);
    assert.equal(report.issues.filter((i: { code: string }) => i.code === "EVALUATION_AI_REVIEW_PENDING").length, 2);
    assert.equal((await ok(await call("POST", `${base}/${closed.id}/publish`, owner.cookie), 422)).error.code, "EVALUATION_INVALID");
    // The flag can be neither set nor forged through the public API...
    assert.equal((await call("POST", `${base}/${closed.id}/questions`, owner.cookie, { sectionId: closed.section, aiDraft: true })).statusCode, 400);
    assert.equal((await call("PATCH", `${base}/${closed.id}/questions/${added[0].id}`, owner.cookie, { aiDraft: true })).statusCode, 400);
    // ...only a person clearing it after review lets the evaluation publish.
    for (const question of added) await ok(await call("PATCH", `${base}/${closed.id}/questions/${question.id}`, owner.cookie, { aiDraft: false }), 200);
    assert.equal((await ok(await call("POST", `${base}/${closed.id}/validate`, owner.cookie), 200)).valid, true);
    assert.equal((await ok(await call("POST", `${base}/${closed.id}/publish`, owner.cookie), 200)).version, 2);
    assert.ok((await prisma.auditLog.count({ where: { organizationId: org, action: "EVALUATION_DRAFT_UPDATED" } })) > 5);
  });

  await t.test("while an evaluation that does not allow AI is in progress the assistant is refused; it is free again afterwards", async () => {
    const attempt = await ok(await call("POST", `${base}/${closed.id}/attempts`, student.cookie), 200);
    assert.equal(await prisma.$transaction((tx) => evaluations.aiBlockedByAttempt(tx, student.id, org)), true);
    const conversation = await prisma.aIConversation.create({ data: { organizationId: org, userId: student.id, application: "NORTH" } });
    await assert.rejects(ai.createRun(student.id, { organizationId: org, conversationId: conversation.id, application: "north", message: "give me the answers" }), (error: { code?: string; statusCode?: number }) => error.code === "AI_BLOCKED_DURING_EVALUATION" && error.statusCode === 403);
    assert.equal(await prisma.aIRun.count({ where: { userId: student.id } }), 0, "no run was created");
    assert.equal(await prisma.$transaction((tx) => evaluations.aiBlockedByAttempt(tx, owner.id, org)), false, "other people are unaffected");
    await ok(await call("POST", `/v1/organizations/${org}/evaluation-attempts/${attempt.id}/submit`, student.cookie), 200);
    assert.equal(await prisma.$transaction((tx) => evaluations.aiBlockedByAttempt(tx, student.id, org)), false);
  });

  await t.test("an evaluation that allows AI does not block, but its key still never reaches a person who only takes it", async () => {
    const open = await exam({ title: "Open book", allowAi: true });
    await ok(await call("POST", `${base}/${open.id}/attempts`, student.cookie), 200);
    assert.equal(await prisma.$transaction((tx) => evaluations.aiBlockedByAttempt(tx, student.id, org)), false);
    assert.deepEqual((await aiTools.available(asStudent)).map((tool) => tool.name).filter((name) => name.startsWith("evaluations.")), [], "no evaluation tool, so no key, even while it is allowed");
  });

  await t.test("page context is advisory, re-authorized for this person, sanitized and never carries the key", async () => {
    const shared = { module: "evaluations", label: "Exam\nbuilder <script>", resource: { type: "evaluation" as const, id: closed.id } };
    const forOwner = (await describeRunContext(asOwner, shared))!;
    assert.match(forOwner, /Closed book/);
    assert.ok(!forOwner.includes("\n") && !forOwner.includes("<") && !forOwner.includes("SECRET"));
    const forStudent = (await describeRunContext(asStudent, shared))!;
    assert.ok(!forStudent.includes("Closed book"), "a person who cannot edit it learns nothing about it");
    const foreign = (await describeRunContext({ ...asOwner, organizationId: otherOrg, userId: outsider.id }, { module: "evaluations", resource: { type: "evaluation", id: closed.id } }))!;
    assert.ok(!foreign.includes("Closed book"), "another tenant cannot read it through a shared id");
    assert.equal(await describeRunContext(asOwner, null), undefined);
  });
});
