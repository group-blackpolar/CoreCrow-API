// Builds src/fixtures/master-house-june-2026.json from the local June workbook.
// Usage: node scripts/build-master-house-fixture.mjs "<path to .xlsx>"
// The workbook is never uploaded or parsed by the API; this is an offline, reviewable step.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const COLUMNS = {
  arrival_date: "Arrival Date",
  master_carrier: "Master Carrier",
  master_consignee: "Master Consignee",
  master_metric_tons: "Master Metric Tons",
  master_port_arrival: "Master Port of Arrival",
  master_port_departure: "Master Port of Departure",
  master_country_origin: "Master Country of Origin",
  master_teus: "Master Teus",
  master_bill_number: "Master Bill of Lading Nbr.",
  container_number: "Container Number",
  house_carrier: "House Carrier",
  house_consignee: "House Consignee",
  house_metric_tons: "House Metric Tons",
  house_port_arrival: "House Port of Arrival",
  house_port_departure: "House Port of Departure",
  house_country_origin: "House Country of Origin",
  house_teus: "House Teus",
  house_bill_number: "House Bill of Lading Nbr.",
};
const NUMERIC = new Set(["master_metric_tons", "master_teus", "house_metric_tons", "house_teus"]);

const workbookPath = process.argv[2];
if (!workbookPath) throw new Error("Workbook path required");
const workbook = XLSX.read(readFileSync(workbookPath), { cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const records = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null });

const scalar = (value, key) => {
  if (value === null || value === undefined || value === "") return null;
  if (key === "arrival_date") return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
  if (NUMERIC.has(key)) return Number(value).toPrecision(12).replace(/\.?0+$/, "");
  return String(value).trim();
};
const rows = records.map((record) => Object.fromEntries(Object.entries(COLUMNS).map(([key, header]) => [key, scalar(record[header], key)])));
for (const [index, row] of rows.entries())
  for (const key of Object.keys(COLUMNS).filter((name) => !NUMERIC.has(name)))
    if (row[key] === null) throw new Error(`Row ${index + 2} is missing required column ${COLUMNS[key]}`);

const payload = {
  schemaVersion: 2,
  fixtureId: "master-house-june-2026",
  source: {
    period: "2026-06",
    sourceWorkbook: basename(workbookPath),
    sanitization: "Eighteen presentation fields (master and house) selected from the locally prepared June workbook; no other columns are carried.",
  },
  rows,
};
const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
const target = fileURLToPath(new URL("../src/fixtures/master-house-june-2026.json", import.meta.url));
writeFileSync(target, bytes);
console.log(JSON.stringify({ rows: rows.length, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
