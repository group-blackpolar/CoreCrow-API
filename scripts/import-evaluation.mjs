#!/usr/bin/env node
// Imports (idempotently) an evaluation definition into an organization through the evaluations API.
//
//   NORTH_API_URL=https://api.blackpolar.org NORTH_ORIGIN=https://north.blackpolar.org NORTH_SESSION_COOKIE='<cookie header>' \
//   node scripts/import-evaluation.mjs scripts/evaluations/lectura-critica-principito-01.mjs --org stress-test
//   or, server side as a named actor:
//   node scripts/import-evaluation.mjs <definition.mjs> --org <slug> --in-process --actor <email> [--dist /app/dist]
//
// A definition file with `categories` instead (scripts/evaluations/categories.mjs) creates missing categories and assigns listed evaluations that have none.
// The acting account needs evaluations.create/update/publish/manage in the organization. Existing evaluations with the same key are never modified.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { ensureCategories, importEvaluation } from "./lib/import-evaluation-core.mjs";

const argv = process.argv.slice(2);
const definitionPath = argv[0]?.startsWith("--") ? undefined : argv[0];
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const inProcess = argv.includes("--in-process");
const organization = option("org");
const api = (process.env.NORTH_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env.NORTH_ORIGIN ?? "http://localhost:5173";
const cookie = process.env.NORTH_SESSION_COOKIE;
if (!definitionPath || !organization || (inProcess ? !option("actor") : !cookie)) {
  console.error("usage: NORTH_SESSION_COOKIE=... node scripts/import-evaluation.mjs <definition.mjs> --org <slug>\n   or: node scripts/import-evaluation.mjs <definition.mjs> --org <slug> --in-process --actor <email> [--dist /app/dist]");
  process.exit(2);
}
const transport = inProcess ? await (await import("./provision-transport-services.mjs")).servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") }) : null;

async function call(method, path, body, headers = {}, attempt = 0) {
  if (transport) return transport.call(method, path, body, headers);
  const response = await fetch(`${api}/v1${path}`, { method, headers: { origin, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 429 && attempt < 8) { await new Promise((done) => setTimeout(done, Math.min(65, Number(response.headers.get("retry-after")) || 15) * 1000)); return call(method, path, body, headers, attempt + 1); }
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? text.slice(0, 200)}`), { status: response.status });
  return { json, etag: response.headers.get("etag") };
}

try {
  const definition = (await import(pathToFileURL(resolve(definitionPath)).href)).default;
  // A definition with `categories` initializes categories (idempotent); otherwise it is one evaluation.
  console.log(JSON.stringify(await (definition.categories ? ensureCategories : importEvaluation)(call, organization, definition, (line) => console.log(line))));
} finally {
  await transport?.close();
}
