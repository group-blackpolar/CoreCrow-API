import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import * as XLSX from "xlsx";

XLSX.set_fs(fs);

const MAX_NON_EMPTY_CELLS = 2_000_000;
const MAX_CELL_TEXT_BYTES = 16 * 1024;

function fail(code) {
  process.stdout.write(JSON.stringify({ ok: false, code }));
  process.exit(2);
}

function profile(cell, value) {
  if (cell.f) fail("IMPORT_SOURCE_FORMULA_REJECTED");
  if (cell.t === "b") value.boolean = true;
  else if (cell.t === "d") value.date = true;
  else if (cell.t === "n") {
    if (typeof cell.v === "number" && Number.isSafeInteger(cell.v)) value.integer = true;
    else value.decimal = true;
  } else if (cell.t === "s" || cell.t === "str") {
    if (typeof cell.v === "string" && Buffer.byteLength(cell.v, "utf8") > MAX_CELL_TEXT_BYTES) fail("IMPORT_CELL_LIMIT_EXCEEDED");
    value.text = true;
  }
}

function inferred(value) {
  const kinds = Object.values(value).filter(Boolean).length;
  if (!kinds) return "EMPTY";
  if (kinds > 1 || (value.integer && value.decimal)) return "MIXED";
  if (value.integer) return "INTEGER";
  if (value.decimal) return "DECIMAL";
  if (value.boolean) return "BOOLEAN";
  if (value.date) return "DATE";
  return "TEXT";
}

function workbook(path) {
  const book = XLSX.readFile(path, {
    dense: true, cellFormula: true, cellHTML: false, cellStyles: false, cellText: false,
    cellDates: true, bookDeps: false, bookFiles: false, bookVBA: false, nodim: true, WTF: true,
  });
  if (book.SheetNames.length < 1 || book.SheetNames.length > 32) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
  let nonEmptyCells = 0;
  let visitedCells = 0;
  const sheets = book.SheetNames.map((name, ordinal) => {
    const sheet = book.Sheets[name];
    const rows = sheet["!data"] ?? [];
    const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { e: { r: 0, c: -1 } };
    const columnCount = range.e.c + 1;
    if (columnCount > 150 || range.e.r + 1 > 250_000) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
    visitedCells += (range.e.r + 1) * columnCount;
    if (visitedCells > MAX_NON_EMPTY_CELLS) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
    const columns = Array.from({ length: columnCount }, (_, sourceOrdinal) => {
      const headerCell = rows[0]?.[sourceOrdinal];
      if (headerCell?.f) fail("IMPORT_SOURCE_FORMULA_REJECTED");
      const rawHeader = headerCell?.v;
      if (typeof rawHeader === "string" && Buffer.byteLength(rawHeader, "utf8") > MAX_CELL_TEXT_BYTES) fail("IMPORT_CELL_LIMIT_EXCEEDED");
      if (rawHeader !== undefined && rawHeader !== null && rawHeader !== "") {
        nonEmptyCells += 1;
        if (nonEmptyCells > MAX_NON_EMPTY_CELLS) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
      }
      const header = typeof rawHeader === "string" ? rawHeader.trim().slice(0, 255) || null : rawHeader == null ? null : String(rawHeader).slice(0, 255);
      const state = { text: false, integer: false, decimal: false, boolean: false, date: false };
      let nonEmptyCount = 0;
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = rows[row]?.[sourceOrdinal];
        if (cell?.f) fail("IMPORT_SOURCE_FORMULA_REJECTED");
        if (!cell || cell.v === undefined || cell.v === null || cell.v === "") continue;
        nonEmptyCells += 1;
        if (nonEmptyCells > MAX_NON_EMPTY_CELLS) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
        nonEmptyCount += 1;
        profile(cell, state);
      }
      return { ordinal: sourceOrdinal, header, inferredType: inferred(state), nonEmptyCount, nullable: nonEmptyCount < range.e.r };
    });
    return { ordinal, name: name.slice(0, 255), rowCount: range.e.r + 1, columnCount, columns };
  });
  return { sheets };
}

try {
  const path = process.argv[2];
  if (!path) fail("IMPORT_ANALYZER_INVALID_INPUT");
  process.stdout.write(JSON.stringify({ ok: true, workbook: workbook(path), parserVersion: "sheetjs-ce-0.20.3" }));
} catch {
  fail("IMPORT_WORKBOOK_INVALID");
}
