// Streaming, read-only XLSX (OOXML SpreadsheetML) reader: ZIP (yauzl) -> SAX (saxes) -> sparse rows.
// Runs inside the permission-restricted child process, so it only uses `node:` built-ins, yauzl and saxes.
// Nothing here materializes a whole worksheet: rows are produced per decompressed chunk.
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import yauzl from "yauzl";
import saxes from "saxes";

const { SaxesParser } = saxes;

export class XlsxReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new XlsxReadError(code); };

const MAX_CONTROL_PART_BYTES = 8 * 1024 * 1024; // workbook, rels, styles
const MAX_XML_DEPTH = 64;
const MAX_STYLE_XFS = 65_536;

// ---------- ZIP ----------

function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true, decodeStrings: true }, (error, zip) => error ? reject(new XlsxReadError("IMPORT_WORKBOOK_INVALID")) : resolve(zip));
  });
}

async function indexEntries(zip, limits) {
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      if (entries.size >= limits.maximumEntries) return reject(new XlsxReadError("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
      if (entry.uncompressedSize > limits.maximumEntryBytes) return reject(new XlsxReadError("IMPORT_ARCHIVE_LIMIT_EXCEEDED"));
      const key = entry.fileName.toLowerCase();
      if (entries.has(key)) return reject(new XlsxReadError("IMPORT_ARCHIVE_INVALID"));
      entries.set(key, entry);
      zip.readEntry();
    });
    zip.readEntry();
  });
  return entries;
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error || !stream ? reject(new XlsxReadError("IMPORT_WORKBOOK_INVALID")) : resolve(stream));
  });
}

/** Feeds the decompressed XML of one entry through saxes, calling `onBatch()` after each chunk so callers can drain bounded output. */
async function* saxChunks(zip, entry, limits, setup) {
  const stream = await openEntryStream(zip, entry);
  const parser = new SaxesParser({ xmlns: false, position: false });
  let depth = 0;
  let failure;
  parser.on("error", () => { failure ??= new XlsxReadError("IMPORT_WORKBOOK_INVALID"); });
  parser.on("doctype", () => { failure ??= new XlsxReadError("IMPORT_OOXML_ACTIVE_CONTENT"); });
  parser.on("processinginstruction", () => {});
  setup(parser);
  // saxes keeps ONE handler per event, so depth tracking wraps whatever handlers `setup` installed.
  const opened = parser.openTagHandler;
  const closed = parser.closeTagHandler;
  parser.on("opentag", (tag) => { if (++depth > MAX_XML_DEPTH) failure ??= new XlsxReadError("IMPORT_WORKBOOK_LIMIT_EXCEEDED"); if (!failure) opened?.(tag); });
  parser.on("closetag", (tag) => { depth -= 1; if (!failure) closed?.(tag); });
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let first = true;
  try {
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > entry.uncompressedSize || bytes > limits.maximumEntryBytes) fail("IMPORT_ARCHIVE_LIMIT_EXCEEDED");
      let text = decoder.write(chunk);
      if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      // A DTD can only precede the root element, so the head of the entry is enough to refuse it outright.
      if (first && /<!(?:DOCTYPE|ENTITY)/i.test(text.slice(0, 8192))) fail("IMPORT_OOXML_ACTIVE_CONTENT");
      first = false;
      parser.write(text);
      if (failure) throw failure;
      yield;
    }
    parser.write(decoder.end());
    parser.close();
    if (failure) throw failure;
  } finally {
    stream.destroy();
  }
}

async function drain(generator) { for await (const _ of generator) void _; }

async function readControlXml(zip, entries, name, limits, setup) {
  const entry = entries.get(name);
  if (!entry) return false;
  if (entry.uncompressedSize > MAX_CONTROL_PART_BYTES) fail("IMPORT_ARCHIVE_LIMIT_EXCEEDED");
  await drain(saxChunks(zip, entry, limits, setup));
  return true;
}

const local = (name) => { const index = name.indexOf(":"); return index < 0 ? name : name.slice(index + 1); };

// _xHHHH_ escapes carry control characters that XML 1.0 cannot represent.
function unescapeOoxml(text) {
  return text.includes("_x") ? text.replace(/_x([0-9A-Fa-f]{4})_/g, (match, hex) => hex.toUpperCase() === "005F" ? "_" : String.fromCharCode(parseInt(hex, 16))) : text;
}

// ---------- workbook / relationships / styles ----------

async function readWorkbook(zip, entries, limits) {
  const sheets = [];
  let date1904 = false;
  const present = await readControlXml(zip, entries, "xl/workbook.xml", limits, (parser) => {
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      if (name === "workbookPr") date1904 = /^(1|true)$/i.test(tag.attributes["date1904"] ?? "");
      else if (name === "sheet") sheets.push({ name: tag.attributes["name"] ?? "", relationshipId: tag.attributes["r:id"] ?? tag.attributes["id"] ?? "" });
    });
  });
  if (!present || sheets.length < 1 || sheets.length > limits.maximumSheets) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
  const targets = new Map();
  await readControlXml(zip, entries, "xl/_rels/workbook.xml.rels", limits, (parser) => {
    parser.on("opentag", (tag) => {
      if (local(tag.name) !== "Relationship") return;
      if ((tag.attributes["TargetMode"] ?? "").toLowerCase() === "external") fail("IMPORT_OOXML_ACTIVE_CONTENT");
      targets.set(tag.attributes["Id"], tag.attributes["Target"] ?? "");
    });
  });
  return {
    date1904,
    sheets: sheets.map((sheet) => {
      const target = targets.get(sheet.relationshipId);
      if (!target) fail("IMPORT_WORKBOOK_INVALID");
      const path = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).toLowerCase();
      return { name: sheet.name, path };
    }),
  };
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code) {
  // Drop quoted literals, escaped characters, bracketed conditions/colors, then look for date/time tokens.
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?!h|m|s)[^\]]*\]/gi, "");
  return /[ymdhs]/i.test(stripped.replace(/\[(h+|m+|s+)\]/gi, "h"));
}

async function readDateStyles(zip, entries, limits) {
  const formats = new Map();
  const cellXfs = [];
  let inCellXfs = false;
  await readControlXml(zip, entries, "xl/styles.xml", limits, (parser) => {
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      if (name === "numFmt") formats.set(Number(tag.attributes["numFmtId"]), tag.attributes["formatCode"] ?? "");
      else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) {
        if (cellXfs.length >= MAX_STYLE_XFS) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
        cellXfs.push(Number(tag.attributes["numFmtId"] ?? 0));
      }
    });
    parser.on("closetag", (tag) => { if (local(tag.name) === "cellXfs") inCellXfs = false; });
  });
  return cellXfs.map((id) => BUILTIN_DATE_FORMATS.has(id) || (formats.has(id) && isDateFormatCode(formats.get(id))));
}

// ---------- shared strings: heap up to a byte budget, then indexed temp file ----------

class SharedStrings {
  constructor() { this.memory = []; this.bytes = 0; this.count = 0; this.file = null; this.offsets = null; this.lengths = null; this.cache = new Map(); this.position = 0; }
  get usesFile() { return this.file !== null; }
  spill(spillDirectory, limits) {
    const path = `${spillDirectory}/shared-strings.bin`;
    this.file = fs.openSync(path, "w+", 0o600);
    this.path = path;
    this.offsets = new Float64Array(Math.min(limits.maximumSharedStrings, 1 << 16));
    this.lengths = new Uint32Array(this.offsets.length);
    for (const text of this.memory) this.#append(text, limits);
    this.memory = [];
  }
  #append(text, limits) {
    if (this.count >= limits.maximumSharedStrings) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
    if (this.count >= this.offsets.length) {
      const grown = Math.min(limits.maximumSharedStrings, this.offsets.length * 2);
      const offsets = new Float64Array(grown); offsets.set(this.offsets); this.offsets = offsets;
      const lengths = new Uint32Array(grown); lengths.set(this.lengths); this.lengths = lengths;
    }
    const buffer = Buffer.from(text, "utf8");
    fs.writeSync(this.file, buffer, 0, buffer.byteLength, this.position);
    this.offsets[this.count] = this.position;
    this.lengths[this.count] = buffer.byteLength;
    this.position += buffer.byteLength;
    this.count += 1;
  }
  add(text, limits, spillDirectory) {
    const size = Buffer.byteLength(text, "utf8");
    if (!this.file) {
      if (this.count >= limits.maximumSharedStrings) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
      this.memory.push(text); this.bytes += size + 48; this.count += 1;
      if (this.bytes > limits.sharedStringsMemoryBytes) { this.count = 0; this.spill(spillDirectory, limits); }
    } else this.#append(text, limits);
  }
  get(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) fail("IMPORT_WORKBOOK_INVALID");
    if (!this.file) return this.memory[index];
    const cached = this.cache.get(index);
    if (cached !== undefined) { this.cache.delete(index); this.cache.set(index, cached); return cached; }
    const buffer = Buffer.allocUnsafe(this.lengths[index]);
    fs.readSync(this.file, buffer, 0, buffer.byteLength, this.offsets[index]);
    const text = buffer.toString("utf8");
    this.cache.set(index, text);
    if (this.cache.size > 4_096) this.cache.delete(this.cache.keys().next().value);
    return text;
  }
  close() { if (this.file !== null) { fs.closeSync(this.file); this.file = null; try { fs.unlinkSync(this.path); } catch { /* temp dir is removed by the parent */ } } }
}

async function readSharedStrings(zip, entries, limits, spillDirectory) {
  const strings = new SharedStrings();
  const entry = entries.get("xl/sharedstrings.xml");
  if (!entry) return strings;
  let current = null;
  let phonetic = 0;
  let inText = false;
  let textBytes = 0;
  await drain(saxChunks(zip, entry, limits, (parser) => {
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      if (name === "si") { current = []; phonetic = 0; textBytes = 0; }
      else if (name === "rPh") phonetic += 1;
      else if (name === "t" && current && !phonetic) inText = true;
    });
    parser.on("text", (text) => {
      if (!inText) return;
      textBytes += Buffer.byteLength(text, "utf8");
      if (textBytes > limits.maximumCellTextBytes) fail("IMPORT_CELL_LIMIT_EXCEEDED");
      current.push(text);
    });
    parser.on("closetag", (tag) => {
      const name = local(tag.name);
      if (name === "t") inText = false;
      else if (name === "rPh") phonetic -= 1;
      else if (name === "si" && current) { strings.add(unescapeOoxml(current.join("")), limits, spillDirectory); current = null; }
    });
  }));
  return strings;
}

// ---------- cells ----------

export function columnIndex(reference) {
  let column = 0;
  let index = 0;
  for (; index < reference.length; index += 1) {
    const code = reference.charCodeAt(index);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
    if (column > 16_384) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
  }
  if (index === 0) fail("IMPORT_WORKBOOK_INVALID");
  return column - 1;
}

export function excelSerialToDate(serial, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * 86_400_000));
}

function finishCell(cell, context) {
  const { type, style, text, inline } = cell;
  const raw = type === "inlineStr" ? inline : text;
  if (type === "s") {
    if (!/^\d+$/.test(raw)) fail("IMPORT_WORKBOOK_INVALID");
    return { t: "s", v: context.strings.get(Number(raw)) };
  }
  if (raw === "" || raw === undefined) return null;
  if (type === "inlineStr") return { t: "s", v: unescapeOoxml(raw) };
  if (type === "str") return { t: "s", v: unescapeOoxml(raw) };
  if (type === "b") return { t: "b", v: raw === "1" || raw.toLowerCase() === "true" };
  if (type === "e") return { t: "e", v: raw };
  if (type === "d") {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? fail("IMPORT_VALUE_TYPE_INVALID") : { t: "d", v: date };
  }
  const number = Number(raw);
  if (!Number.isFinite(number)) fail("IMPORT_VALUE_TYPE_INVALID");
  if (context.dateStyles[style]) {
    const date = excelSerialToDate(number, context.date1904);
    if (date) return { t: "d", v: date };
  }
  return { t: "n", v: number };
}

/**
 * Streams the rows of one worksheet as `{ index, cells }` (0-based row index, sparse cell array).
 * Rows without any value are not yielded. Any formula element is rejected, regardless of cached value.
 */
async function* streamSheetRows(zip, entry, context, limits, counters) {
  const pending = [];
  let rowIndex = -1;
  let nextRow = 0;
  let cells = null;
  let cell = null;
  let nextColumn = 0;
  let collecting = null; // "v" | "t"
  let inlineDepth = 0;
  let phonetic = 0;
  let textBytes = 0;
  const generator = saxChunks(zip, entry, limits, (parser) => {
    parser.on("opentag", (tag) => {
      const name = local(tag.name);
      if (name === "row") {
        const reference = tag.attributes["r"];
        rowIndex = reference !== undefined ? Number(reference) - 1 : nextRow;
        if (!Number.isInteger(rowIndex) || rowIndex < nextRow) fail("IMPORT_WORKBOOK_INVALID"); // rows must be unique and ascending
        if (rowIndex >= limits.maximumRows) fail("IMPORT_ROW_LIMIT_EXCEEDED");
        nextRow = rowIndex + 1;
        cells = [];
        nextColumn = 0;
      } else if (name === "c" && cells) {
        const reference = tag.attributes["r"];
        const column = reference !== undefined ? columnIndex(reference) : nextColumn;
        if (column >= limits.maximumColumns) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
        cell = { column, type: tag.attributes["t"] ?? "n", style: Number(tag.attributes["s"] ?? 0), text: "", inline: "" };
        nextColumn = column + 1;
        textBytes = 0;
      } else if (name === "f" && cell) fail("IMPORT_SOURCE_FORMULA_REJECTED");
      else if (name === "v" && cell) collecting = "v";
      else if (name === "is" && cell) inlineDepth = 1;
      else if (name === "rPh" && inlineDepth) phonetic += 1;
      else if (name === "t" && inlineDepth && !phonetic) collecting = "t";
    });
    parser.on("text", (text) => {
      if (!collecting || !cell) return;
      textBytes += Buffer.byteLength(text, "utf8");
      if (textBytes > limits.maximumCellTextBytes) fail("IMPORT_CELL_LIMIT_EXCEEDED");
      if (collecting === "v") cell.text += text; else cell.inline += text;
    });
    parser.on("closetag", (tag) => {
      const name = local(tag.name);
      if (name === "v" || name === "t") collecting = null;
      else if (name === "rPh") phonetic -= 1;
      else if (name === "is") inlineDepth = 0;
      else if (name === "c" && cell) {
        const value = finishCell(cell, context);
        if (value) {
          counters.cells += 1;
          if (counters.cells > limits.maximumCells) fail("IMPORT_WORKBOOK_LIMIT_EXCEEDED");
          cells[cell.column] = value;
        }
        cell = null;
      } else if (name === "row" && cells) {
        if (cells.length) pending.push({ index: rowIndex, cells });
        cells = null;
        counters.maximumRowIndex = Math.max(counters.maximumRowIndex, rowIndex);
      }
    });
  });
  for await (const _ of generator) {
    void _;
    // Bounded: only the rows completed within one decompressed chunk are buffered.
    while (pending.length) { const row = pending.shift(); counters.maximumColumnIndex = Math.max(counters.maximumColumnIndex, row.cells.length - 1); yield row; }
  }
  while (pending.length) { const row = pending.shift(); counters.maximumColumnIndex = Math.max(counters.maximumColumnIndex, row.cells.length - 1); yield row; }
}

/**
 * Opens a workbook for streaming. `spillDirectory` must be writable by the caller's sandbox and is used only when the
 * shared strings exceed the in-memory budget. Call `close()` when done.
 */
export async function openWorkbook(path, limits, spillDirectory) {
  const zip = await openZip(path);
  let strings = null;
  try {
    const entries = await indexEntries(zip, limits);
    const workbook = await readWorkbook(zip, entries, limits);
    const dateStyles = await readDateStyles(zip, entries, limits);
    strings = await readSharedStrings(zip, entries, limits, spillDirectory);
    return {
      sheets: workbook.sheets.map((sheet) => sheet.name),
      sharedStringsUseFile: strings.usesFile,
      sharedStringsCount: strings.count,
      async *rows(sheetOrdinal, counters = { cells: 0, maximumRowIndex: -1, maximumColumnIndex: -1 }) {
        const sheet = workbook.sheets[sheetOrdinal];
        const entry = sheet && entries.get(sheet.path);
        if (!entry) fail("IMPORT_MAPPING_INVALID");
        yield* streamSheetRows(zip, entry, { strings, dateStyles, date1904: workbook.date1904 }, limits, counters);
      },
      close() { strings?.close(); zip.close(); },
    };
  } catch (error) {
    strings?.close();
    zip.close();
    throw error;
  }
}
