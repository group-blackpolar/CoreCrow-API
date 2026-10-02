import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import * as XLSX from "xlsx";

XLSX.set_fs(fs);

const MAX_NON_EMPTY_CELLS = 2_000_000;
const MAX_CELL_TEXT_BYTES = 16 * 1024;
const MAX_MATERIALIZED_ROWS = 50_000;

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

function empty(value) {
  return value === undefined || value === null || value === "";
}

function coerce(cell, type, nullable) {
  if (cell?.f) fail("IMPORT_SOURCE_FORMULA_REJECTED");
  if (!cell || empty(cell.v)) {
    if (!nullable) fail("IMPORT_REQUIRED_VALUE_MISSING");
    return null;
  }
  if (type === "TEXT") {
    const value = String(cell.v);
    if (Buffer.byteLength(value, "utf8") > MAX_CELL_TEXT_BYTES) fail("IMPORT_CELL_LIMIT_EXCEEDED");
    return value;
  }
  if (type === "INTEGER") {
    if (typeof cell.v === "number") {
      if (!Number.isSafeInteger(cell.v)) fail("IMPORT_VALUE_TYPE_INVALID");
      return cell.v;
    }
    const raw = String(cell.v).trim();
    if (!/^-?\d+$/.test(raw)) fail("IMPORT_VALUE_TYPE_INVALID");
    const value = BigInt(raw);
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("IMPORT_VALUE_TYPE_INVALID");
    return Number(value);
  }
  if (type === "DECIMAL") {
    if (typeof cell.v === "number") {
      if (!Number.isFinite(cell.v)) fail("IMPORT_VALUE_TYPE_INVALID");
      return String(cell.v);
    }
    const raw = String(cell.v).trim();
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) fail("IMPORT_VALUE_TYPE_INVALID");
    return raw;
  }
  if (type === "BOOLEAN") {
    if (typeof cell.v === "boolean") return cell.v;
    const normalized = String(cell.v).trim().toLowerCase();
    if (["true", "1", "yes", "si", "sí"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
    fail("IMPORT_VALUE_TYPE_INVALID");
  }
  if (type === "TIME" && typeof cell.v === "string") {
    const raw = cell.v.trim();
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(raw)) fail("IMPORT_VALUE_TYPE_INVALID");
    return raw.length === 5 ? `${raw}:00` : raw;
  }
  if (!(cell.v instanceof Date) && (typeof cell.v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(cell.v.trim()))) fail("IMPORT_VALUE_TYPE_INVALID");
  const date = cell.v instanceof Date ? cell.v : new Date(cell.v.trim());
  if (Number.isNaN(date.getTime())) fail("IMPORT_VALUE_TYPE_INVALID");
  if (type === "DATE") return date.toISOString().slice(0, 10);
  if (type === "TIME") return date.toISOString().slice(11, 19);
  if (type === "DATETIME") return date.toISOString();
  fail("IMPORT_VALUE_TYPE_INVALID");
}

function materialize(path, mappingPath) {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  const book = XLSX.readFile(path, {
    dense: true, cellFormula: true, cellHTML: false, cellStyles: false, cellText: false,
    cellDates: true, bookDeps: false, bookFiles: false, bookVBA: false, nodim: true, WTF: true,
  });
  const name = book.SheetNames[mapping.sheetOrdinal];
  if (!name) fail("IMPORT_MAPPING_INVALID");
  const sheet = book.Sheets[name];
  const rows = sheet["!data"] ?? [];
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { e: { r: 0, c: -1 } };
  if (range.e.r > MAX_MATERIALIZED_ROWS) fail("IMPORT_ROW_LIMIT_EXCEEDED");
  const output = [];
  for (let rowIndex = mapping.headerRow; rowIndex <= range.e.r; rowIndex += 1) {
    const values = {};
    let populated = false;
    for (const column of mapping.columns) {
      if (column.action === "IGNORE") continue;
      const value = coerce(rows[rowIndex]?.[column.sourceOrdinal], column.canonicalType, column.nullable);
      if (value !== null) populated = true;
      values[column.fieldId] = value;
    }
    if (populated) output.push(values);
  }
  return { parserVersion: "sheetjs-ce-0.20.3", rows: output };
}

try {
  const path = process.argv[2];
  if (!path) fail("IMPORT_ANALYZER_INVALID_INPUT");
  if (process.argv[3] === "materialize") {
    if (!process.argv[4]) fail("IMPORT_ANALYZER_INVALID_INPUT");
    process.stdout.write(JSON.stringify({ ok: true, ...materialize(path, process.argv[4]) }));
  } else {
    process.stdout.write(JSON.stringify({ ok: true, workbook: workbook(path), parserVersion: "sheetjs-ce-0.20.3" }));
  }
} catch {
  fail("IMPORT_WORKBOOK_INVALID");
}
