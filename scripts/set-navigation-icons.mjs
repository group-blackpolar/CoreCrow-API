// Sets the icon of existing categories / subcategories (matched by slug) through the application services as a named actor.
// Keys are the NORTH icon catalog keys (North-BP/src/lib/iconCatalog.ts). Only `icon` changes: name and slug are sent back as they are.
//
//   node scripts/set-navigation-icons.mjs --org shark --in-process --actor <email> [--dist /app/dist] [--dry-run]
import { servicesTransport } from "./provision-transport-services.mjs";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
const dryRun = argv.includes("--dry-run");
if (!option("org") || !option("actor") || !argv.includes("--in-process")) { console.error("usage: node scripts/set-navigation-icons.mjs --org <slug> --in-process --actor <email> [--dist <dir>] [--dry-run]"); process.exit(2); }

// "category" or "category/subcategory" -> catalog key.
const SHARK = {
  home: "home", "home/overview": "layout", "home/acerca": "info",
  "import-ctr": "container", "import-ctr/report-info": "info", "import-ctr/port": "anchor", "import-ctr/year-comparison": "bars", "import-ctr/consignee-details": "id-card",
  "import-ctr/consignees-by-port": "buildings", "import-ctr/origin-port-detail": "map", "import-ctr/table-consignees-list": "list",
  "local-import": "package", "local-import/info": "info", "local-import/hs-code": "barcode", "local-import/maritime-category": "ship", "local-import/maritime-importer": "id-card",
  "local-import/maritime-imports-table": "table", "local-import/overland-category": "truck", "local-import/overland-importer": "id-card", "local-import/air-category": "plane", "local-import/air-importer": "id-card",
  "master-house": "anchor", "master-house/dashboard-information": "info", "master-house/search-by": "search", "master-house/master-consignee-list": "users",
  "master-house/house-consignee-list": "buildings", "master-house/search-by-port-of-departure": "pin", "master-house/consignees-and-cargo-table": "container",
  "master-house/consignees-table": "table", "master-house/top-freight-forwarders": "trophy",
  admin: "settings", "admin/settings": "sliders",
};

const transport = await servicesTransport({ dist: option("dist") ?? "dist", actorEmail: option("actor") });
const organization = (await transport.call("GET", "/organizations")).json.find((item) => item.slug === option("org"));
if (!organization) throw new Error(`Organization "${option("org")}" not found for this actor`);
const org = `/organizations/${organization.id}`;
const tree = (await transport.call("GET", `${org}/north/management-tree`)).json;

let changed = 0;
for (const category of tree) {
  const targets = [
    { slug: category.slug, path: `${org}/categories/${category.id}`, item: category },
    ...category.subcategories.map((sub) => ({ slug: `${category.slug}/${sub.slug}`, path: `${org}/subcategories/${sub.id}`, item: sub })),
  ];
  for (const { slug, path, item } of targets) {
    const icon = SHARK[slug];
    if (!icon || item.icon === icon) continue;
    console.log(`${dryRun ? "would set" : "set"} ${slug}: ${item.icon ?? "(none)"} -> ${icon}`);
    if (dryRun) { changed += 1; continue; }
    try { await transport.call("PATCH", path, { name: item.name, icon }); changed += 1; } catch (error) { console.log(`  skipped ${slug}: ${error.message}`); }
  }
}
console.log(`${changed} ${dryRun ? "would change" : "changed"}`);
process.exit(0);
