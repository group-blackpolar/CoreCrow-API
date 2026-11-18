#!/usr/bin/env node
// Provisions (idempotently) an organization from a declarative definition through the normal API surface.
//
//   NORTH_API_URL=https://api.blackpolar.org NORTH_ORIGIN=https://north.blackpolar.org \
//   NORTH_SESSION_COOKIE='<cookie header of your signed-in session>' \
//   node scripts/provision-organization.mjs scripts/organizations/stress-test.mjs
//   or, server side as a named actor (see scripts/provision-transport-services.mjs):
//   node scripts/provision-organization.mjs <definition.mjs> --in-process --actor <email> [--dist /app/dist]
//
// The acting account becomes OWNER of a newly created organization and nobody else is added: access stays restricted until
// the owner invites people. Re-running changes nothing that already matches (see lib/provision-organization-core.mjs).
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { reconcileOrganization } from "./lib/provision-organization-core.mjs";

const argv = process.argv.slice(2);
const definitionPath = argv[0]?.startsWith("--") ? undefined : argv[0];
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const inProcess = argv.includes("--in-process");
const api = (process.env.NORTH_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env.NORTH_ORIGIN ?? "http://localhost:5173";
const cookie = process.env.NORTH_SESSION_COOKIE;
if (!definitionPath || (inProcess ? !option("actor") : !cookie)) {
  console.error("usage: NORTH_SESSION_COOKIE=... node scripts/provision-organization.mjs <definition.mjs>\n   or: node scripts/provision-organization.mjs <definition.mjs> --in-process --actor <email> [--dist /app/dist]");
  process.exit(2);
}
const transport = inProcess ? await (await import("./provision-transport-services.mjs")).servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") }) : null;

async function call(method, path, body, headers = {}, attempt = 0) {
  if (transport) return transport.call(method, path, body, headers);
  const response = await fetch(`${api}/v1${path}`, {
    method,
    headers: { origin, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 429 && attempt < 8) {
    const wait = Math.min(65, Number(response.headers.get("retry-after")) || 15);
    await new Promise((done) => setTimeout(done, wait * 1000));
    return call(method, path, body, headers, attempt + 1);
  }
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? text.slice(0, 200)}`), { status: response.status });
  return { json, etag: response.headers.get("etag") };
}

try {
  const definition = (await import(pathToFileURL(resolve(definitionPath)).href)).default;
  console.log(JSON.stringify(await reconcileOrganization(call, definition, (line) => console.log(line))));
} finally {
  await transport?.close();
}
