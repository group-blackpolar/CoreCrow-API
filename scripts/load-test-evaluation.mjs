#!/usr/bin/env node
// Concurrent load test of a paced evaluation (e.g. Simulacro 02) through the REAL HTTP API: N virtual students, each with its own session, start an
// attempt, answer every question (selection autosave + confirmation), read the result and the feedback. It measures latency per endpoint, error rate and
// the consistency of what the server graded against what each student actually confirmed. It invents nothing about capacity: it reports what happened.
//
//   node scripts/load-test-evaluation.mjs --api http://127.0.0.1:4000 --origin http://localhost:5173 --org <organizationId> --evaluation <evaluationId> \
//        --definition scripts/evaluations/lectura-critica-naranja-lima-02.mjs --cookies students.json [--students 20] [--concurrency 10] [--ramp-ms 200] \
//        [--think-ms 300] [--accuracy 0.8] [--seed 1] [--reload-every 4] [--distinct-ips] [--out report.json]
//
// students.json = ["<cookie header of student 1>", ...] (accounts that are members of the organization and assigned to the evaluation; one attempt each
// when the evaluation allows a single attempt). NEVER point this at production without the owner's authorization: it creates real attempts.
// Server-side resource usage (CPU, memory, DB) is NOT measured here: sample it from the host (`docker stats`, pm2, pg_stat_activity) during the window the
// report prints (startedAt / finishedAt). The report only contains client-observed numbers and the consistency check.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback; };
const api = opt("api", "http://127.0.0.1:4000").replace(/\/$/, "");
const origin = opt("origin", "http://localhost:5173");
const organization = opt("org"), evaluation = opt("evaluation"), definitionPath = opt("definition"), cookiesPath = opt("cookies");
if (!organization || !evaluation || !definitionPath || !cookiesPath) { console.error("usage: see the header of this file (needs --org --evaluation --definition --cookies)"); process.exit(2); }
const cookies = JSON.parse(readFileSync(cookiesPath, "utf8"));
const students = Math.min(Number(opt("students", cookies.length)), cookies.length);
const concurrency = Math.max(1, Number(opt("concurrency", 10)));
const rampMs = Number(opt("ramp-ms", 200)), thinkMs = Number(opt("think-ms", 300)), accuracy = Number(opt("accuracy", 0.8)), reloadEvery = Number(opt("reload-every", 4));
let seed = Number(opt("seed", 1));
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; // deterministic: the same seed repeats the same answers
const definition = (await import(pathToFileURL(resolve(definitionPath)).href)).default;
const key = definition.sections.flatMap((section) => section.questions.map((question) => question.correct));
const base = `${api}/v1/organizations/${organization}`;

const samples = new Map(); // endpoint -> [ms]
const errors = new Map(); // endpoint+status -> count
let requests = 0;
async function http(label, method, path, cookie, body, student = 0) {
  const started = performance.now();
  requests += 1;
  let status = 0;
  try {
    const response = await fetch(`${base}${path}`, { method, headers: { origin, cookie, ...(argv.includes("--distinct-ips") ? { "x-forwarded-for": `10.${(student >> 8) & 255}.${student & 255}.7` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    status = response.status;
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`${status}`), { status, text });
    return text ? JSON.parse(text) : null;
  } catch (error) {
    const code = error.status ?? "network";
    errors.set(`${label} ${code}`, (errors.get(`${label} ${code}`) ?? 0) + 1);
    throw error;
  } finally {
    (samples.get(label) ?? samples.set(label, []).get(label)).push(performance.now() - started);
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

/** One student: start, answer all questions (some reloads in between), read the result. Returns what the student confirmed, for the consistency check. */
async function student(index) {
  const cookie = cookies[index];
  const confirmedCorrect = []; // booleans per question
  let view = await http("start", "POST", `/evaluations/${evaluation}/attempts`, cookie, undefined, index);
  const attemptId = view.id;
  for (let number = 0; number < key.length; number += 1) {
    if (reloadEvery > 0 && number % reloadEvery === reloadEvery - 1) view = await http("reload", "GET", `/evaluation-attempts/${attemptId}`, cookie, undefined, index);
    const question = view.content.questions[0];
    const right = random() < accuracy;
    const letter = right ? key[number] : "ABCD".split("").find((candidate) => candidate !== key[number]);
    const option = question.options.find((candidate) => candidate.label === letter);
    await sleep(thinkMs * (0.5 + random()));
    await http("autosave", "PUT", `/evaluation-attempts/${attemptId}/answers`, cookie, { answers: [{ questionId: question.id, optionId: option.id, seq: 1 }] }, index);
    const response = await http("confirm", "POST", `/evaluation-attempts/${attemptId}/confirm`, cookie, { questionId: question.id, optionId: option.id }, index);
    confirmedCorrect.push(response.accepted ? right : null);
    view = response.attempt;
    if (view.status !== "IN_PROGRESS") break;
  }
  const result = await http("result", "GET", `/evaluation-attempts/${attemptId}/result`, cookie, undefined, index);
  return { attemptId, confirmedCorrect, result };
}

const monitor = monitorEventLoopDelay({ resolution: 20 }); monitor.enable();
const startedAt = new Date();
const outcomes = [];
let next = 0;
async function worker() {
  while (next < students) {
    const index = next++;
    await sleep(rampMs * (index % concurrency));
    try { outcomes.push({ index, ok: true, ...(await student(index)) }); } catch (error) { outcomes.push({ index, ok: false, error: String(error.message) }); }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, students) }, worker));
const finishedAt = new Date();
monitor.disable();

// Consistency: for every finished student the percentage the server graded must equal 100 x (questions that student confirmed correctly) / total.
const checked = outcomes.filter((outcome) => outcome.ok).map((outcome) => {
  const expectedCorrect = outcome.confirmedCorrect.filter((value) => value === true).length;
  const expectedPercent = Math.round((expectedCorrect / key.length) * 10_000) / 100;
  const feedback = outcome.result.feedback;
  return { attemptId: outcome.attemptId, expectedPercent, gradedPercent: outcome.result.percent, consistent: expectedPercent === outcome.result.percent && feedback?.overall?.percent === outcome.result.percent && feedback.competencies.length > 0 };
});
const report = {
  startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationSeconds: Math.round((finishedAt - startedAt) / 1000),
  config: { api, students, concurrency, rampMs, thinkMs, accuracy, reloadEvery, seed: Number(opt("seed", 1)) },
  requests, errorRate: requests ? Math.round((([...errors.values()].reduce((sum, value) => sum + value, 0)) / requests) * 10_000) / 100 : 0, errors: Object.fromEntries(errors),
  studentsFinished: checked.length, studentsFailed: outcomes.filter((outcome) => !outcome.ok).length, inconsistentResults: checked.filter((row) => !row.consistent),
  latencyMs: Object.fromEntries([...samples].map(([label, values]) => { const sorted = [...values].sort((a, b) => a - b); return [label, { count: sorted.length, p50: Math.round(percentile(sorted, 50)), p95: Math.round(percentile(sorted, 95)), p99: Math.round(percentile(sorted, 99)), max: Math.round(sorted.at(-1)) }]; })),
  client: { rssMB: Math.round(process.memoryUsage().rss / 1048576), eventLoopDelayP99Ms: Math.round(monitor.percentile(99) / 1e6), note: "Server CPU/memory/DB are not measured by this script." },
};
console.log(JSON.stringify(report, null, 2));
if (opt("out")) writeFileSync(opt("out"), JSON.stringify(report, null, 2));
process.exit(report.studentsFailed > 0 || report.inconsistentResults.length > 0 ? 1 : 0);
