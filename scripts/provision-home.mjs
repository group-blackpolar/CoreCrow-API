#!/usr/bin/env node
// Provisions (idempotently) the editable Home of an organization: a CONTENT panel document with a centered hero and the report cards.
// After this the Home is edited in the Views studio like any other panel; re-running REPLACES the draft, so run it once to seed.
//
//   node scripts/provision-home.mjs --org shark --in-process --actor <member email> [--dist /app/dist] [--publish]
//   NORTH_API_URL=... NORTH_ORIGIN=... NORTH_SESSION_COOKIE=... node scripts/provision-home.mjs --org shark [--publish]
//
// The actor/session is whatever may edit and publish the Home; nothing here bypasses authorization (see provision-view.mjs).
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const orgSlug = option("org");
const publish = argv.includes("--publish");
const inProcess = argv.includes("--in-process");
const api = (process.env.NORTH_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const origin = process.env.NORTH_ORIGIN ?? "http://localhost:5173";
const cookie = process.env.NORTH_SESSION_COOKIE;
if (!orgSlug || (inProcess ? !option("actor") : !cookie)) { console.error("usage: provision-home.mjs --org <slug> (--in-process --actor <email> | NORTH_SESSION_COOKIE=...) [--publish]"); process.exit(2); }
const transport = inProcess ? await (await import("./provision-transport-services.mjs")).servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") }) : null;

async function call(method, path, body, headers = {}) {
  if (transport) return transport.call(method, path, body, headers);
  const response = await fetch(`${api}/v1${path}`, { method, headers: { origin, cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`);
  return { json, etag: response.headers.get("etag") };
}

const l = (es, en) => ({ es, en });
const REPORTS = [
  ["local-import", "Local Import", "Explora las importaciones locales y sus principales indicadores.", "Explore local imports and their main indicators.", "container", "cyan"],
  ["local-export", "Local Export", "Consulta la actividad exportadora local y su evolución.", "Review local export activity and how it evolves.", "truck", "green"],
  ["import-ctr", "Import CTR", "Analiza la información de importaciones CTR y sus tendencias.", "Analyze CTR import information and its trends.", "chart", "violet"],
  ["master-house", "Master House", "Accede a la información consolidada y los indicadores de Master House.", "Access the consolidated information and indicators of Master House.", "package", "blue"],
  ["free-zone-import", "Free Zone Import", "Explora las importaciones relacionadas con la zona franca.", "Explore imports related to the free zone.", "buildings", "amber"],
  ["free-zone-export", "Free Zone Export", "Consulta las exportaciones de zona franca y sus principales indicadores.", "Review free zone exports and their main indicators.", "ship", "rose"],
  ["maritime-export", "Maritime Export", "Analiza los datos de exportación marítima y sus tendencias.", "Analyze maritime export data and its trends.", "anchor", "slate"],
];
const cell = (y, h) => ({ desktop: { x: 0, y, w: 12, h }, tablet: { x: 0, y, w: 12, h }, mobile: { x: 0, y, w: 12, h } });
const document = {
  schemaVersion: 1, defaultLocale: "es", fallbackLocales: ["en"],
  sections: [{
    id: "home", order: 0, layout: { variant: "grid", gap: "lg" },
    components: [
      { id: "home-hero", type: "hero", schemaVersion: 1, order: 0, bindings: {}, layout: cell(0, 6), props: {
        title: l("Bienvenido a Shark", "Welcome to Shark"),
        body: l("Tu centro de información y análisis para explorar datos, consultar indicadores y tomar decisiones con mayor precisión.", "Your information and analysis hub to explore data, review indicators and make decisions with greater precision."),
        centered: true, showBrand: true, logoImage: "/brand/shark-logo.png", backgroundImage: "/brand/shark-port-hero.webp",
      } },
      { id: "home-reports", type: "report_cards", schemaVersion: 1, order: 1, bindings: {}, layout: cell(6, 16), props: {
        title: l("Reportes", "Reports"),
        items: REPORTS.map(([categorySlug, name, es, en, icon, tone]) => ({ id: randomUUID(), categorySlug, title: l(name, name), description: l(es, en), icon, tone, image: `/brand/cards/${categorySlug}.webp` })),
      } },
    ],
  }],
};

const organizations = (await call("GET", "/organizations")).json;
const organization = organizations.find((item) => item.slug === orgSlug);
if (!organization) throw new Error(`Organization "${orgSlug}" not found for this actor`);
const tree = (await call("GET", `/organizations/${organization.id}/north/management-tree`)).json;
const home = tree.find((category) => category.slug === "home")?.subcategories?.flatMap((subcategory) => subcategory.panels).find((panel) => panel.slug === "home");
if (!home) throw new Error("The organization has no home panel");
if (home.resourceKind !== "CONTENT") throw new Error("The home panel is still a SYSTEM panel; apply migration 20261019120000_north_shark_home_editable first");
const org = `/organizations/${organization.id}`;
const existing = await call("GET", `${org}/panels/${home.id}/draft`).catch(() => null);
const saved = await call("PATCH", `${org}/panels/${home.id}/draft`, { document }, existing?.etag ? { "if-match": existing.etag } : {});
const report = (await call("POST", `${org}/panels/${home.id}/draft/validate`)).json;
const errors = (report.issues ?? []).filter((issue) => issue.severity === "error");
if (errors.length) throw new Error(`Draft invalid: ${JSON.stringify(errors).slice(0, 400)}`);
console.log(`draft saved for ${organization.name} home (${home.id})`);
if (publish) { await call("POST", `${org}/panels/${home.id}/publish`, undefined, { "if-match": report.etag ?? saved.etag }); console.log("published"); }
if (transport) await transport.close();
