#!/usr/bin/env node
// Provisions (idempotently) a Views dashboard from a declarative definition, using ONLY the public CORECROW API with the
// caller's own session: taxonomy -> panel -> analytics bindings -> draft document -> validate -> optional publish.
//
//   NORTH_API_URL=https://api.blackpolar.org NORTH_ORIGIN=https://north.blackpolar.org \
//   NORTH_SESSION_COOKIE='<cookie header of your signed-in session>' \
//   node scripts/provision-view.mjs scripts/dashboards/shark-consignee-analytics.mjs --org shark [--publish] [--only <panel-slug>]
//
// The session is read from the environment only (never written anywhere). Authorization is whatever that session is
// allowed to do; nothing here bypasses it. Re-running updates the same resources (matched by slug / binding name).
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const definitionPath = argv.find((item) => !item.startsWith("--"));
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const publish = argv.includes("--publish");
const orgSlug = option("org");
const api = (process.env.NORTH_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env.NORTH_ORIGIN ?? "http://localhost:5173";
const cookie = process.env.NORTH_SESSION_COOKIE;
// --in-process: run the same operations through the application services as a named actor (server-side, no HTTP / no session cookie).
// Authorization, validation and audit are exactly those of that actor; see scripts/provision-transport-services.mjs.
const inProcess = argv.includes("--in-process");
if (!definitionPath || !orgSlug || (inProcess ? !option("actor") : !cookie)) {
  console.error("usage: NORTH_SESSION_COOKIE=... node scripts/provision-view.mjs <definition.mjs> --org <slug> [--publish]\n   or: node scripts/provision-view.mjs <definition.mjs> --org <slug> --in-process --actor <email> [--dist <dir>]");
  process.exit(2);
}
const transport = inProcess ? await (await import("./provision-transport-services.mjs")).servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") }) : null;

// The API rate-limits per client (429). A multi-panel definition makes ~60 calls, so wait and retry instead of failing half-way.
async function call(method, path, body, headers = {}, attempt = 0) {
  if (transport) return transport.call(method, path, body, headers);
  const response = await fetch(`${api}/v1${path}`, {
    method,
    headers: { origin, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 429 && attempt < 8) {
    const wait = Math.min(65, Number(response.headers.get("retry-after")) || 15);
    console.log(`  rate limited; retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return call(method, path, body, headers, attempt + 1);
  }
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${path} -> ${response.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? text.slice(0, 200)}`), { status: response.status });
  return { json, etag: response.headers.get("etag") };
}

const definition = (await import(pathToFileURL(resolve(definitionPath)).href)).default;
const organizations = (await call("GET", "/organizations")).json;
const organization = organizations.find((item) => item.slug === orgSlug);
if (!organization) throw new Error(`Organization "${orgSlug}" not found for this session`);
const org = `/organizations/${organization.id}`;
console.log(`organization ${organization.name} (${organization.id})`);

// --- dataset + fields ---
const datasets = (await call("GET", `${org}/datasets`)).json;
const dataset = datasets.find((item) => item.slug === definition.datasetSlug);
if (!dataset) throw new Error(`Dataset "${definition.datasetSlug}" not found; import it first`);
const fields = (await call("GET", `${org}/datasets/${dataset.id}/fields`)).json;
const fieldId = (key) => { const field = fields.find((item) => item.key === key); if (!field) throw new Error(`Dataset field "${key}" not found`); return field.id; };

// --- taxonomy (matched by slug, never duplicated) ---
// A definition is either one panel (subcategory/panel/bindings/document) or `panels: [...]` for several, all in `category`.
const entries = definition.panels ?? [{ subcategory: definition.subcategory, panel: definition.panel, bindings: definition.bindings, document: definition.document }];
const only = option("only");
const summary = [];
for (const entry of entries.filter((item) => !only || item.panel.slug === only)) {
  console.log(`
== ${entry.subcategory.slug} / ${entry.panel.slug}`);
  // --- taxonomy (matched by slug, never duplicated) ---
  const tree = (await call("GET", `${org}/north/management-tree`)).json;
  const categories = tree.categories ?? tree;
  let category = categories.find((item) => item.slug === definition.category.slug);
  if (!category) category = (await call("POST", `${org}/categories`, definition.category)).json;
  let subcategory = (category.subcategories ?? []).find((item) => item.slug === entry.subcategory.slug);
  if (!subcategory) subcategory = (await call("POST", `${org}/categories/${category.id}/subcategories`, entry.subcategory)).json;
  let panel = (subcategory.panels ?? []).find((item) => item.slug === entry.panel.slug);
  if (!panel) panel = (await call("POST", `${org}/subcategories/${subcategory.id}/panels`, entry.panel)).json;
  console.log(`panel ${panel.id} (${entry.panel.slug})`);

  // --- bindings (matched by name) ---
  const existing = (await call("GET", `${org}/panels/${panel.id}/analytics-bindings`)).json;
  const bindingIds = {};
  for (const spec of entry.bindings({ fieldId })) {
    const body = { name: spec.name, datasetId: dataset.id, query: spec.query, allowedFilters: spec.allowedFilters ?? [] };
    const current = existing.find((item) => item.name === spec.name);
    const saved = current ? (await call("PUT", `${org}/panels/${panel.id}/analytics-bindings/${current.id}`, body)).json : (await call("POST", `${org}/panels/${panel.id}/analytics-bindings`, body)).json;
    bindingIds[spec.name] = saved.id;
    console.log(`binding ${spec.name} ${current ? "updated" : "created"}`);
  }

  // --- draft document ---
  const document = entry.document({ fieldId, binding: (name) => { if (!bindingIds[name]) throw new Error(`Unknown binding "${name}"`); return { sourceType: "dataset", sourceId: bindingIds[name], datasetId: dataset.id }; } });
  let ifMatch;
  try { ifMatch = (await call("GET", `${org}/panels/${panel.id}/draft`)).etag; } catch (error) { if (error.status !== 404) throw error; }
  const saved = await call("PATCH", `${org}/panels/${panel.id}/draft`, { document, message: "Provisioned from definition" }, ifMatch ? { "if-match": ifMatch } : {});
  console.log(`draft saved (revision ${saved.json.revisionNumber})`);
  const report = (await call("POST", `${org}/panels/${panel.id}/draft/validate`)).json;
  for (const issue of report.issues) console.log(`  ${issue.severity}: ${issue.code} ${issue.message}`);
  if (!report.valid) { console.error("draft is not valid; not publishing"); process.exitCode = 1; continue; }
  if (publish) {
    const published = await call("POST", `${org}/panels/${panel.id}/publish`, undefined, { "if-match": report.etag });
    console.log(`published revision ${published.json.revisionNumber}`);
  } else console.log("validated (not published; pass --publish)");
  summary.push({ panelId: panel.id, slug: entry.panel.slug });
}
console.log(JSON.stringify({ organizationId: organization.id, datasetId: dataset.id, panels: summary }));
await transport?.close();
