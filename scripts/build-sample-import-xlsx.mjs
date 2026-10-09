// Builds a SYNTHETIC workbook for import-pipeline tests: no real company, port statistic or person.
//   node scripts/build-sample-import-xlsx.mjs <out-dir>
// Writes sample-import-data.xlsx plus sample-import-data.expected.json (SHA-256, row count and exact aggregates) so a run can
// be verified against the source of truth. Deterministic: the same call always yields the same bytes' content.
// The sheet is passive OOXML (no formulas, macros or links). Columns are generic text/number/date fields.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

const out = process.argv[2];
if (!out) throw new Error("Usage: node scripts/build-sample-import-xlsx.mjs <out-dir>");

// Fictional entities only.
const ports = ["Puerto Alfa", "Puerto Beta", "Puerto Gamma", "Puerto Delta"];
const carriers = ["Linea Norte", "Linea Sur", "Oceano Uno", "Oceano Dos", "Mar Central"];
const consignees = ["Comercial Aurora S.A.", "Distribuidora Boreal", "Importadora Cenit", "Logistica Delta Sur", "Grupo Estrella Test", "Suministros Faro", "Mercantil Horizonte", "Alimentos Ixora", "Textiles Jade", "Maquinaria Kappa"];
const countries = ["China", "Estados Unidos", "Colombia", "Mexico", "Corea del Sur", "Espana", "Brasil", "Japon"];

let state = 20261009; // fixed seed
const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
const pick = (list) => list[Math.floor(next() * list.length)];

const rows = [];
for (const year of [2024, 2025, 2026]) {
  const lastMonth = year === 2026 ? 6 : 12;
  for (let month = 1; month <= lastMonth; month++) {
    for (let i = 0; i < 5; i++) {
      const containers = 1 + Math.floor(next() * 40);
      rows.push({ year, month, port: pick(ports), carrier: pick(carriers), consignee: pick(consignees), country: pick(countries), containers, teus: containers + Math.floor(next() * containers) });
    }
  }
}
// Controlled edge cases: exact duplicates (must be kept: no silent dedupe) and a missing consignee (null).
rows.push({ ...rows[0] }, { ...rows[1] });
rows.push({ year: 2025, month: 3, port: ports[0], carrier: carriers[0], consignee: null, country: countries[0], containers: 7, teus: 9 });

const header = ["year", "month", "port", "carrier", "consignee", "country", "containers", "teus"];
const sheet = XLSX.utils.json_to_sheet(rows, { header });
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, "Sample");
const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "sample-import-data.xlsx"), bytes);

const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
const by = (key) => Object.fromEntries([...new Set(rows.map((row) => row[key]))].sort().map((value) => {
  const subset = rows.filter((row) => row[key] === value);
  return [String(value), { rows: subset.length, containers: sum(subset, "containers"), teus: sum(subset, "teus") }];
}));
const expected = {
  file: "sample-import-data.xlsx",
  sha256: createHash("sha256").update(readFileSync(join(out, "sample-import-data.xlsx"))).digest("hex"),
  bytes: bytes.byteLength,
  sheet: "Sample",
  columns: header,
  rowCount: rows.length,
  nullConsigneeRows: rows.filter((row) => row.consignee === null).length,
  totals: { containers: sum(rows, "containers"), teus: sum(rows, "teus") },
  byYear: by("year"),
  byPort: by("port"),
  byCarrier: by("carrier"),
};
writeFileSync(join(out, "sample-import-data.expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
console.info(`sample-import-data.xlsx: ${rows.length} rows, ${bytes.byteLength} bytes, sha256 ${expected.sha256}`);
