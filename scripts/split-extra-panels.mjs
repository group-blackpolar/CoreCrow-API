#!/usr/bin/env node
// Splits subcategories that still hold several panels (ADR 031). DRY RUN by default: prints the plan and changes nothing.
//
//   node scripts/split-extra-panels.mjs --org <slug> --in-process --actor <email> --dist /app/dist            # plan only
//   node scripts/split-extra-panels.mjs --org <slug> --in-process --actor <email> --dist /app/dist --apply    # execute
//
// Take a pg_dump first. Idempotent: once every subcategory has one panel there is nothing left to do.
import { planSplits, applySplits } from "./lib/split-extra-panels-core.mjs";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const orgSlug = option("org");
if (!orgSlug || !argv.includes("--in-process") || !option("actor")) {
  console.error("usage: node scripts/split-extra-panels.mjs --org <slug> --in-process --actor <email> [--dist <dir>] [--apply]");
  process.exit(2);
}
const transport = await (await import("./provision-transport-services.mjs")).servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") });
const call = (method, path, body) => transport.call(method, path, body, {});
const organization = (await call("GET", "/organizations")).json.find((item) => item.slug === orgSlug);
if (!organization) throw new Error(`Organization "${orgSlug}" not found for this actor`);
const org = `/organizations/${organization.id}`;
const tree = (await call("GET", `${org}/north/management-tree`)).json;
const plan = planSplits(tree.categories ?? tree);
if (!plan.length) { console.log(`${orgSlug}: every subcategory already has a single page`); process.exit(0); }
for (const { category, subcategory, keep, moves } of plan)
  console.log(`${category.slug}/${subcategory.slug}: keep "${keep.slug}"${moves.map(({ panel, slug }) => `; move "${panel.slug}" -> new subcategory "${slug}"`).join("")}`);
if (!argv.includes("--apply")) { console.log("\ndry run: nothing changed (add --apply to execute)"); process.exit(0); }
await applySplits(call, org, plan);
console.log("done");
