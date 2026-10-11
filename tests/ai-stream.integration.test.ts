import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SMTPServer } from "smtp-server";

// Needs an isolated, migrated PostgreSQL database: TEST_DATABASE_URL=postgresql://.../xxx_test pnpm exec tsx --test tests/ai-stream.integration.test.ts
// Regression for "the answer only shows after reloading": the persisted-event stream hijacks the reply, which used to drop the
// CORS headers (the browser blocked reading a run that had in fact completed), and a full batch of 100 events used to end the stream.
test("AI event stream keeps CORS headers and replays every event of a completed run", { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 }, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost"].includes(testUrl.hostname) && testUrl.pathname.endsWith("_test"), "Tests require a dedicated local *_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:4000";
  process.env.BETTER_AUTH_SECRET = "isolated-tests-only-strong-secret-1234567890";
  process.env.TRUSTED_ORIGINS = "http://localhost:3000";
  process.env.SMTP_URL = "smtp://127.0.0.1:5533?ignoreTLS=true";
  process.env.MAIL_FROM = "accounts@blackpolar.test";
  process.env.AI_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-key-never-called";

  const messages: string[] = [];
  const smtp = new SMTPServer({ disabledCommands: ["AUTH", "STARTTLS"], onData(stream, _s, cb) { let v = ""; stream.on("data", (d) => { v += d; }); stream.on("end", () => { messages.push(v); cb(); }); } });
  await new Promise<void>((resolve) => smtp.listen(5533, "127.0.0.1", resolve));
  const { buildApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/database.js");
  const app = await buildApp({ logger: false });
  await app.ready();
  t.after(async () => { await app.close(); await prisma.$disconnect(); await new Promise<void>((resolve) => smtp.close(() => resolve())); });

  const origin = "http://localhost:3000";
  const email = `${randomUUID().slice(0, 8)}-ai@blackpolar.test`;
  const password = "Test-password-only-123!";
  const ok = (response: { statusCode: number; body: string }, status: number) => { assert.equal(response.statusCode, status, response.body); return JSON.parse(response.body); };
  ok(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress: "127.0.71.1", headers: { origin }, payload: { email, password, name: "Stream" } }), 200);
  const code = messages.at(-1)!.replace(/=\r?\n/g, "").match(/verification code is: (\d{6})/i)?.[1];
  ok(await app.inject({ method: "POST", url: "/v1/identity/verification/confirm", remoteAddress: "127.0.71.2", headers: { origin }, payload: { email, code } }), 200);
  const login = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", remoteAddress: "127.0.71.3", headers: { origin }, payload: { email, password } });
  ok(login, 200);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const org = ok(await app.inject({ method: "POST", url: "/v1/organizations", remoteAddress: "127.0.71.4", headers: { origin, cookie }, payload: { name: `AI ${randomUUID().slice(0, 6)}` } }), 201).id as string;

  const conversation = await prisma.aIConversation.create({ data: { organizationId: org, userId: user.id, application: "NORTH" } });
  const run = await prisma.aIRun.create({ data: { conversationId: conversation.id, organizationId: org, userId: user.id, application: "NORTH", status: "COMPLETED", provider: "gemini", model: "test", completedAt: new Date() } });
  const deltas = 250; // more than one 100-event batch
  await prisma.aIEvent.createMany({ data: [
    { runId: run.id, sequence: 1, type: "run.started", data: {} },
    ...Array.from({ length: deltas }, (_, index) => ({ runId: run.id, sequence: index + 2, type: "message.delta", data: { text: "x" } })),
    { runId: run.id, sequence: deltas + 2, type: "message.completed", data: { text: "x".repeat(deltas) } },
    { runId: run.id, sequence: deltas + 3, type: "run.completed", data: {} },
  ] });

  const stream = await app.inject({ method: "GET", url: `/v1/ai/runs/${run.id}/events?organizationId=${org}&after=0`, remoteAddress: "127.0.71.5", headers: { origin, cookie } });
  assert.equal(stream.statusCode, 200);
  assert.equal(stream.headers["access-control-allow-origin"], origin, "a hijacked stream must still carry the CORS headers the browser needs to read it");
  assert.equal(stream.headers["access-control-allow-credentials"], "true");
  assert.match(String(stream.headers["content-type"]), /text\/event-stream/);
  assert.ok(stream.body.includes("event: run.completed"), "the terminal event is delivered even when the run has more than one batch of events");
  assert.equal((stream.body.match(/event: message\.delta/g) ?? []).length, deltas);
  // Resuming from the middle replays only what is missing (no duplicated message).
  const resumed = await app.inject({ method: "GET", url: `/v1/ai/runs/${run.id}/events?organizationId=${org}&after=${deltas}`, remoteAddress: "127.0.71.6", headers: { origin, cookie } });
  assert.equal((resumed.body.match(/event: message\.delta/g) ?? []).length, 1);
  assert.ok(resumed.body.includes("event: run.completed"));
});
