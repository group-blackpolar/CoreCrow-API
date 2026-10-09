// Sandboxed XLSX child (node --permission, empty env, no network/child-process/worker access).
//   analyze     <file> analyze     -         <limits.json> <spillDir>   -> one small JSON document
//   materialize <file> materialize <mapping> <limits.json> <spillDir>   -> NDJSON batches, then a final {"ok":true,"done":true} line
//   count       <file> count       <mapping> <limits.json> <spillDir>   -> same validation and coercion, no rows, only the final line
// stdout writes honor backpressure: the parent reads the pipe incrementally and the child pauses on a full pipe.
import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { openWorkbook, XlsxReadError } from "./xlsx-stream-reader.mjs";

const PARSER_VERSION = "ooxml-stream-1";
const BATCH_ROWS = 500;
const BATCH_BYTES = 512 * 1024;

class ImportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ImportError(code); };

function write(text) {
  return new Promise((resolve, reject) => {
    if (process.stdout.write(text, (error) => error && reject(error))) resolve();
    else process.stdout.once("drain", resolve);
  });
}

function profile(cell, value, limits) {
  if (cell.t === "b") value.boolean = true;
  else if (cell.t === "d") value.date = true;
  else if (cell.t === "n") {
    if (Number.isSafeInteger(cell.v)) value.integer = true;
    else value.decimal = true;
  } else {
    if (Buffer.byteLength(cell.v, "utf8") > limits.maximumCellTextBytes) fail("IMPORT_CELL_LIMIT_EXCEEDED");
    value.text = true;
  }
}

function inferred(value) {
  const kinds = Object.values(value).filter(Boolean).length;
  if (!kinds) return "EMPTY";
  if (value.integer && value.decimal && kinds === 2) return "DECIMAL";
  if (kinds > 1) return "MIXED";
  if (value.integer) return "INTEGER";
  if (value.decimal) return "DECIMAL";
  if (value.boolean) return "BOOLEAN";
  if (value.date) return "DATE";
  return "TEXT";
}

async function analyze(book, limits) {
  const sheets = [];
  for (let ordinal = 0; ordinal < book.sheets.length; ordinal += 1) {
    const counters = { cells: 0, maximumRowIndex: -1, maximumColumnIndex: -1 };
    const headers = [];
    const states = [];
    const counts = [];
    for await (const row of book.rows(ordinal, counters)) {
      row.cells.forEach((cell, column) => {
        if (!cell) return;
        if (row.index === 0) {
          const raw = cell.t === "d" ? cell.v.toISOString() : String(cell.v);
          headers[column] = raw.trim().slice(0, 255) || null;
          return;
        }
        states[column] ??= { text: false, integer: false, decimal: false, boolean: false, date: false };
        counts[column] = (counts[column] ?? 0) + 1;
        profile(cell, states[column], limits);
      });
    }
    const columnCount = counters.maximumColumnIndex + 1;
    const rowCount = counters.maximumRowIndex + 1;
    const columns = Array.from({ length: columnCount }, (_, sourceOrdinal) => {
      const nonEmptyCount = counts[sourceOrdinal] ?? 0;
      return {
        ordinal: sourceOrdinal, header: headers[sourceOrdinal] ?? null,
        inferredType: inferred(states[sourceOrdinal] ?? {}), nonEmptyCount, nullable: nonEmptyCount < Math.max(rowCount - 1, 0),
      };
    });
    sheets.push({ ordinal, name: book.sheets[ordinal].slice(0, 255), rowCount, columnCount, columns });
  }
  return { sheets };
}

const empty = (value) => value === undefined || value === null || value === "";

function coerce(cell, type, nullable, limits) {
  if (!cell || empty(cell.v)) {
    if (!nullable) fail("IMPORT_REQUIRED_VALUE_MISSING");
    return null;
  }
  if (cell.t === "e") fail("IMPORT_VALUE_TYPE_INVALID");
  if (type === "TEXT") {
    const value = cell.v instanceof Date ? cell.v.toISOString() : String(cell.v);
    if (Buffer.byteLength(value, "utf8") > limits.maximumCellTextBytes) fail("IMPORT_CELL_LIMIT_EXCEEDED");
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
    if (typeof cell.v === "number") return String(cell.v);
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

async function materialize(book, mapping, limits, emit) {
  if (!book.sheets[mapping.sheetOrdinal]) fail("IMPORT_MAPPING_INVALID");
  const columns = mapping.columns.filter((column) => column.action !== "IGNORE");
  let batch = [];
  let batchBytes = 0;
  let outputBytes = 0;
  let rowCount = 0;
  const flush = async () => {
    if (!batch.length) return;
    if (!emit) { batch = []; batchBytes = 0; return; }
    const line = `${JSON.stringify({ rows: batch })}\n`;
    outputBytes += Buffer.byteLength(line, "utf8");
    if (outputBytes > limits.maximumOutputBytes) fail("IMPORT_MATERIALIZER_OUTPUT_LIMIT");
    batch = []; batchBytes = 0;
    await write(line);
  };
  for await (const row of book.rows(mapping.sheetOrdinal)) {
    if (row.index < mapping.headerRow) continue;
    const values = {};
    let populated = false;
    for (const column of columns) {
      const value = coerce(row.cells[column.sourceOrdinal], column.canonicalType, column.nullable, limits);
      if (value !== null) populated = true;
      values[column.fieldId] = value;
    }
    if (!populated) continue;
    batch.push(values);
    rowCount += 1;
    batchBytes += 64 + Object.keys(values).length * 24;
    if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
  }
  await flush();
  return rowCount;
}

async function main() {
  const [path, mode, mappingPath, limitsPath, spillDirectory] = process.argv.slice(2);
  if (!path || !limitsPath || !spillDirectory) fail("IMPORT_ANALYZER_INVALID_INPUT");
  const limits = JSON.parse(fs.readFileSync(limitsPath, "utf8"));
  const book = await openWorkbook(path, limits, spillDirectory);
  try {
    if (mode === "materialize" || mode === "count") {
      if (!mappingPath || mappingPath === "-") fail("IMPORT_ANALYZER_INVALID_INPUT");
      const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
      const rowCount = await materialize(book, mapping, limits, mode === "materialize");
      await write(`${JSON.stringify({ ok: true, done: true, parserVersion: PARSER_VERSION, rowCount, maxRssKiB: process.resourceUsage().maxRSS })}\n`);
    } else {
      await write(JSON.stringify({ ok: true, workbook: await analyze(book, limits), parserVersion: PARSER_VERSION, maxRssKiB: process.resourceUsage().maxRSS }));
    }
  } finally {
    book.close();
  }
}

try {
  await main();
} catch (error) {
  const code = error instanceof ImportError || error instanceof XlsxReadError ? error.code : "IMPORT_WORKBOOK_INVALID";
  await write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 2;
}
