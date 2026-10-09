import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { openWorkbook, XlsxReadError, excelSerialToDate } from "../src/modules/north/data/xlsx-stream-reader.mjs";
import { datasetImportLimits } from "../src/modules/north/data/import-limits.js";
import { SecureXlsxArchiveValidator } from "../src/modules/north/data/import-archive-validator.js";
import { StreamingDatasetImportMaterializer, type MaterializedRow } from "../src/modules/north/data/import-materialization-parser.js";
import { StreamingDatasetImportAnalyzer } from "../src/modules/north/data/import-analysis-parser.js";
import { DomainError } from "../src/shared/errors.js";
import { NS, baseParts, generatedSheet, writeXlsx, type Parts } from "./support/xlsx-fixtures.js";

const scratch = mkdtempSync(join(tmpdir(), "xlsx-stream-test-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const limits = datasetImportLimits();
const write = (name: string, parts: Parts) => writeXlsx(scratch, name, parts);
async function collect(path: string, overrides: Partial<typeof limits> = {}) {
  const book = await openWorkbook(path, { ...limits, ...overrides }, scratch);
  try {
    const rows = [];
    for await (const row of book.rows(0)) rows.push(row);
    return { rows, sharedStringsUseFile: book.sharedStringsUseFile, sharedStringsCount: book.sharedStringsCount };
  } finally { book.close(); }
}
const code = (expected: string) => (error: unknown) => (error instanceof XlsxReadError || error instanceof DomainError) && error.code === expected;

test("reader decodes numbers, shared strings, inlineStr, str, booleans, sparse cells and special characters", async () => {
  const rows = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
    `<row r="2"><c r="A2" t="inlineStr"><is><t>Caf&#233; &amp; Co &lt;x&gt;</t></is></c><c r="C2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c><c r="F2" t="str"><v>plain</v></c></row>`,
    `<row r="4"><c r="A4" t="inlineStr"><is><r><t>rich</t></r><r><t xml:space="preserve"> text</t></r><rPh><t>IGNORED</t></rPh></is></c><c r="B4" t="inlineStr"><is><t>line_x000D_break _x005F_x0041_</t></is></c><c r="C4"><v></v></c></row>`,
  ].join("");
  const { rows: got } = await collect(await write("types.xlsx", baseParts({ rows, shared: ["Header A", "日本語 ✓"] })));
  assert.deepEqual(got.map((row) => row.index), [0, 1, 3], "empty row 3 is skipped, indexes are 0-based");
  assert.deepEqual(got[0]!.cells, [{ t: "s", v: "Header A" }, { t: "s", v: "日本語 ✓" }]);
  assert.deepEqual(got[1]!.cells[0], { t: "s", v: "Café & Co <x>" });
  assert.equal(got[1]!.cells[1], undefined);
  assert.deepEqual(got[1]!.cells[2], { t: "n", v: 12.5 });
  assert.deepEqual(got[1]!.cells[3], { t: "b", v: true });
  assert.deepEqual(got[1]!.cells[5], { t: "s", v: "plain" });
  assert.deepEqual(got[2]!.cells[0], { t: "s", v: "rich text" });
  assert.deepEqual(got[2]!.cells[1], { t: "s", v: "line\rbreak _x0041_" });
  assert.equal(got[2]!.cells[2], undefined, "empty <v/> is an empty cell");
});

test("Excel serial dates honor date styles, the 1900 leap-year quirk and the 1904 system", async () => {
  const row = `<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="2"><v>45292.75</v></c><c r="C1" s="3"><v>45292</v></c><c r="D1"><v>45292</v></c><c r="E1" s="1"><v>59</v></c><c r="F1" s="1"><v>61</v></c></row>`;
  const { rows } = await collect(await write("dates1900.xlsx", baseParts({ rows: row })));
  const c = rows[0]!.cells;
  assert.equal((c[0] as { v: Date }).v.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal((c[1] as { v: Date }).v.toISOString(), "2024-01-01T18:00:00.000Z");
  assert.deepEqual(c[2], { t: "n", v: 45292 }, "non-date custom format stays numeric");
  assert.deepEqual(c[3], { t: "n", v: 45292 }, "default format stays numeric");
  assert.equal((c[4] as { v: Date }).v.toISOString().slice(0, 10), "1900-02-28");
  assert.equal((c[5] as { v: Date }).v.toISOString().slice(0, 10), "1900-03-01");
  const { rows: r1904 } = await collect(await write("dates1904.xlsx", baseParts({ rows: row, date1904: true })));
  assert.equal((r1904[0]!.cells[0] as { v: Date }).v.toISOString(), "2028-01-02T00:00:00.000Z");
  assert.equal(excelSerialToDate(-1, false), null);
});

test("formulas are rejected explicitly, even when a cached value exists", async () => {
  for (const cell of [`<c r="A1"><f>1+1</f><v>2</v></c>`, `<c r="A1" t="str"><f t="array" ref="A1">SUM(B1:B2)</f><v>x</v></c>`]) {
    await assert.rejects(collect(await write("formula.xlsx", baseParts({ rows: `<row r="1">${cell}</row>` }))), code("IMPORT_SOURCE_FORMULA_REJECTED"));
  }
});

test("DTD/entity declarations, external relationships, malformed XML, unordered rows and corrupt ZIPs are rejected", async () => {
  const doctype = `<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY x "boom">]><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row></sheetData></worksheet>`;
  await assert.rejects(collect(await write("doctype.xlsx", baseParts({ sheetXml: doctype }))), code("IMPORT_OOXML_ACTIVE_CONTENT"));
  await assert.rejects(collect(await write("broken.xlsx", baseParts({ sheetXml: `<worksheet ${NS}><sheetData><row r="1"><c r="A1"></row>` }))), code("IMPORT_WORKBOOK_INVALID"));
  await assert.rejects(collect(await write("order.xlsx", baseParts({ rows: `<row r="3"><c r="A3"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>` }))), code("IMPORT_WORKBOOK_INVALID"));
  const external = baseParts({});
  external["xl/_rels/workbook.xml.rels"] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="http://example.invalid/s.xml" TargetMode="External"/></Relationships>`;
  await assert.rejects(collect(await write("external.xlsx", external)), code("IMPORT_OOXML_ACTIVE_CONTENT"));
  const deep = `<worksheet ${NS}>${"<a>".repeat(200)}</worksheet>`;
  await assert.rejects(collect(await write("deep.xlsx", baseParts({ sheetXml: deep }))), code("IMPORT_WORKBOOK_LIMIT_EXCEEDED"));
  writeFileSync(join(scratch, "corrupt.xlsx"), Buffer.from("PK\u0003\u0004 definitely not a zip"));
  await assert.rejects(collect(join(scratch, "corrupt.xlsx")), code("IMPORT_WORKBOOK_INVALID"));
});

test("configurable limits are enforced for rows, columns, cells, cell text, entries and shared strings", async () => {
  const grid = (rows: number, columns: number) => Array.from({ length: rows }, (_, r) => `<row r="${r + 1}">${Array.from({ length: columns }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${r}</v></c>`).join("")}</row>`).join("");
  const path = await write("grid.xlsx", baseParts({ rows: grid(10, 4) }));
  assert.equal((await collect(path)).rows.length, 10);
  await assert.rejects(collect(path, { maximumRows: 5 }), code("IMPORT_ROW_LIMIT_EXCEEDED"));
  await assert.rejects(collect(path, { maximumColumns: 3 }), code("IMPORT_WORKBOOK_LIMIT_EXCEEDED"));
  await assert.rejects(collect(path, { maximumCells: 39 }), code("IMPORT_WORKBOOK_LIMIT_EXCEEDED"));
  await assert.rejects(collect(path, { maximumEntryBytes: 100 }), code("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
  await assert.rejects(collect(path, { maximumEntries: 3 }), code("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
  const text = await write("bigtext.xlsx", baseParts({ rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>${"x".repeat(2_000)}</t></is></c></row>` }));
  await assert.rejects(collect(text, { maximumCellTextBytes: 1_000 }), code("IMPORT_CELL_LIMIT_EXCEEDED"));
  const shared = await write("sst-count.xlsx", baseParts({ rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, shared: ["a", "b", "c"] }));
  await assert.rejects(collect(shared, { maximumSharedStrings: 2 }), code("IMPORT_WORKBOOK_LIMIT_EXCEEDED"));
  const badIndex = await write("sst-index.xlsx", baseParts({ rows: `<row r="1"><c r="A1" t="s"><v>9</v></c></row>`, shared: ["a"] }));
  await assert.rejects(collect(badIndex), code("IMPORT_WORKBOOK_INVALID"));
});

test("environment overrides are clamped to hard ceilings and never unlimited", () => {
  const huge = datasetImportLimits({ NORTH_DATA_IMPORT_MAX_ROWS: "999999999999", NORTH_DATA_IMPORT_MAX_ENTRY_BYTES: "Infinity", NORTH_DATA_IMPORT_MAX_CELLS: "0", NORTH_DATA_IMPORT_MAX_COMPRESSED_BYTES: "-5" });
  assert.equal(huge.maximumRows, 1_048_576);
  assert.equal(huge.maximumEntryBytes, 512 * 1024 * 1024);
  assert.equal(huge.maximumCells, 20_000_000);
  assert.equal(huge.maximumCompressedBytes, 50 * 1024 * 1024);
  assert.equal(datasetImportLimits({ NORTH_DATA_IMPORT_MAX_ROWS: "1000" }).maximumRows, 1000);
});

test("shared strings spill to an indexed temp file beyond the memory budget and stay correct", async () => {
  const total = 3_000;
  const strings = Array.from({ length: total }, (_, i) => `valor número ${i} ✓`);
  const cells = Array.from({ length: total }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${(i * 7) % total}</v></c></row>`).join("");
  const path = await write("spill.xlsx", baseParts({ rows: cells, shared: strings }));
  const inMemory = await collect(path);
  assert.equal(inMemory.sharedStringsUseFile, false);
  const spilled = await collect(path, { sharedStringsMemoryBytes: 4_096 });
  assert.equal(spilled.sharedStringsUseFile, true);
  assert.equal(spilled.sharedStringsCount, total);
  assert.deepEqual(spilled.rows, inMemory.rows);
  assert.equal((spilled.rows[5]!.cells[0] as { v: string }).v, strings[(5 * 7) % total]);
});

test("archive validator accepts a clean workbook and rejects expansion bombs and oversized entries", async () => {
  const validator = new SecureXlsxArchiveValidator({ ...limits, maximumEntryBytes: 1024 * 1024, maximumUncompressedBytes: 2 * 1024 * 1024 });
  const check = async (parts: Parts) => {
    const bytes = readFileSync(await write("v.xlsx", parts));
    return validator.validate({ filename: "x.xlsx", size: bytes.byteLength, checksum: "a".repeat(64), openPrivateRead: async () => Readable.from([bytes]), signal: new AbortController().signal });
  };
  assert.equal(await check(baseParts({ rows: `<row r="1"><c r="A1"><v>1</v></c></row>` })), "APPROVED");
  const bomb = baseParts({ sheetXml: `<?xml version="1.0"?><worksheet ${NS}><sheetData/>${" ".repeat(900_000)}</worksheet>` });
  await assert.rejects(check(bomb), code("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
  let seed = 7;
  const noise = Buffer.alloc(1_200_000, 0).map(() => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 251);
  await assert.rejects(check(baseParts({ sheetXml: `<?xml version="1.0"?><worksheet ${NS}><sheetData/><x>${noise.toString("base64")}</x></worksheet>` })), code("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
});

function storageFor(path: string) {
  return { async openPrivateRead() { return createReadStream(path); } } as never;
}
const mapping = [
  { sourceOrdinal: 0, action: "CREATE" as const, fieldId: "day", canonicalType: "DATE" as const, nullable: false },
  { sourceOrdinal: 1, action: "CREATE" as const, fieldId: "consignee", canonicalType: "TEXT" as const, nullable: false },
  { sourceOrdinal: 2, action: "CREATE" as const, fieldId: "weight", canonicalType: "DECIMAL" as const, nullable: false },
];
const materialize = (path: string, onRows: (rows: MaterializedRow[]) => Promise<void>, signal = new AbortController().signal, begin: (summary: { rowCount: number }) => Promise<void> = async () => {}) =>
  new StreamingDatasetImportMaterializer(storageFor(path)).materialize({ storageKey: "k", storageVersionId: "v", sheetOrdinal: 0, headerRow: 1, columns: mapping, signal }, { begin, rows: onRows });

test("end-to-end: batches are bounded, ordered and flow control holds with a slow consumer", async () => {
  const path = await write("flow.xlsx", baseParts({ sheetXml: generatedSheet(30_000) }));
  const seen: MaterializedRow[] = [];
  let largest = 0;
  const result = await materialize(path, async (rows) => {
    largest = Math.max(largest, rows.length);
    seen.push(...rows);
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
  assert.equal(result.rowCount, 30_000);
  assert.equal(seen.length, 30_000);
  assert.ok(largest <= 500, `largest batch ${largest}`);
  assert.equal(seen[0]!["consignee"], "CONSIGNEE 0 & CO");
  assert.equal(seen[29_999]!["consignee"], `CONSIGNEE ${29_999 % 1_000} & CO`);
  assert.equal(seen[1]!["day"], "2024-01-02");
  assert.equal(seen[1]!["weight"], "0.125");
});

test("the validating pass reports the exact row count before any row is delivered, and bad data fails before begin", async () => {
  const path = await write("count.xlsx", baseParts({ sheetXml: generatedSheet(1_234) }));
  const order: string[] = [];
  let announced = 0;
  await materialize(path, async (rows) => { order.push(`rows:${rows.length}`); }, undefined, async (summary) => { order.push("begin"); announced = summary.rowCount; });
  assert.equal(order[0], "begin");
  assert.equal(announced, 1_234);
  assert.equal(order.slice(1).reduce((total, entry) => total + Number(entry.split(":")[1]), 0), 1_234);
  const bad = await write("count-bad.xlsx", baseParts({ sheetXml: `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>d</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>not a date</t></is></c></row></sheetData></worksheet>` }));
  let began = false;
  await assert.rejects(materialize(bad, async () => {}, undefined, async () => { began = true; }), code("IMPORT_VALUE_TYPE_INVALID"));
  assert.equal(began, false, "nothing is written when validation fails");
});

test("a failing consumer or an abort stops the child and surfaces the original error", async () => {
  const path = await write("stop.xlsx", baseParts({ sheetXml: generatedSheet(60_000) }));
  await assert.rejects(materialize(path, async () => { throw new Error("database write failed"); }), /database write failed/);
  const controller = new AbortController();
  await assert.rejects(materialize(path, async () => { controller.abort(new Error("lease lost")); }, controller.signal), /lease lost/);
});

test("value and required-field violations fail with stable codes", async () => {
  const typed = (value: string) => write("typed.xlsx", baseParts({ sheetXml: `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>d</t></is></c></row><row r="2">${value}</row></sheetData></worksheet>` }));
  const one = [{ sourceOrdinal: 0, action: "CREATE" as const, fieldId: "n", canonicalType: "INTEGER" as const, nullable: false }];
  const run = (path: string) => new StreamingDatasetImportMaterializer(storageFor(path)).materialize({ storageKey: "k", storageVersionId: "v", sheetOrdinal: 0, headerRow: 1, columns: one, signal: new AbortController().signal }, { async begin() {}, async rows() {} });
  await assert.rejects(run(await typed(`<c r="A2"><v>1.5</v></c>`)), code("IMPORT_VALUE_TYPE_INVALID"));
  await assert.rejects(run(await typed(`<c r="A2" t="e"><v>#DIV/0!</v></c>`)), code("IMPORT_VALUE_TYPE_INVALID"));
  await assert.rejects(run(await typed(`<c r="B2"><v>1</v></c>`)), code("IMPORT_REQUIRED_VALUE_MISSING"));
  await assert.rejects(run(await typed(`<c r="A2"><f>1+1</f><v>2</v></c>`)), code("IMPORT_SOURCE_FORMULA_REJECTED"));
  assert.equal((await run(await typed(`<c r="A2"><v>7</v></c>`))).rowCount, 1);
});

test("analysis profiles columns by streaming and merges integer and decimal as DECIMAL", async () => {
  const path = await write("analysis.xlsx", baseParts({ sheetXml: generatedSheet(5_000) }));
  const result = await new StreamingDatasetImportAnalyzer(storageFor(path)).analyze({ storageKey: "k", storageVersionId: "v", signal: new AbortController().signal });
  const sheet = result.workbook.sheets[0]!;
  assert.equal(sheet.rowCount, 5_001);
  assert.deepEqual(sheet.columns.map((column) => [column.header, column.inferredType, column.nullable]), [["Day", "DATE", false], ["Consignee", "TEXT", false], ["Weight", "DECIMAL", false]]);
});

test("scale: 183k rows stream with bounded memory (generated fixture)", { timeout: 300_000 }, async () => {
  const path = await write("scale.xlsx", baseParts({ sheetXml: generatedSheet(183_040) }));
  const started = Date.now();
  let rows = 0;
  const result = await materialize(path, async (batch) => { rows += batch.length; });
  console.log(`# generated 183,040 rows: ${rows} imported in ${((Date.now() - started) / 1000).toFixed(1)}s, child peak RSS ${((result.maxRssKiB ?? 0) / 1024).toFixed(0)} MiB`);
  assert.equal(rows, 183_040);
  assert.ok((result.maxRssKiB ?? Infinity) < 512 * 1024, "child peak RSS stays under 512 MiB");
});

const real = process.env.SHARK_XLSX_FIXTURE;
test("real-world workbook (set SHARK_XLSX_FIXTURE to run)", { skip: !real || !existsSync(real), timeout: 600_000 }, async () => {
  const columns = Array.from({ length: 26 }, (_, i) => ({ sourceOrdinal: i, action: "CREATE" as const, fieldId: `f${i}`, canonicalType: (i === 0 ? "DATE" : [3, 8, 13, 16, 21, 25].includes(i) ? "DECIMAL" : "TEXT") as "DATE" | "DECIMAL" | "TEXT", nullable: true }));
  const analysis = await new StreamingDatasetImportAnalyzer(storageFor(real!)).analyze({ storageKey: "k", storageVersionId: "v", signal: new AbortController().signal });
  assert.equal(analysis.workbook.sheets[0]!.columnCount, 26);
  const started = Date.now();
  let rows = 0;
  const result = await new StreamingDatasetImportMaterializer(storageFor(real!)).materialize({ storageKey: "k", storageVersionId: "v", sheetOrdinal: 0, headerRow: 1, columns, signal: new AbortController().signal }, { async begin() {}, async rows(batch) { rows += batch.length; } });
  console.log(`# real workbook: ${rows} rows in ${((Date.now() - started) / 1000).toFixed(1)}s, child peak RSS ${((result.maxRssKiB ?? 0) / 1024).toFixed(0)} MiB`);
  assert.equal(rows, result.rowCount);
});
