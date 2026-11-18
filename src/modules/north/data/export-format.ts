import * as XLSX from "xlsx";
import { fail } from "../../../shared/errors.js";

export const EXPORT_MIN_ROWS = 100;
export const EXPORT_MAX_ROWS = 10_000;

export type ExportValue = string | number | boolean | null | undefined;
export type ExportColumn = { key: string; label: string };

/** The count a reader may export: [100, min(total, 10 000)]. Anything else is a stable 422, decided from the real total. */
export function validateExportCount(total: number, count: number): number {
  if (total < EXPORT_MIN_ROWS) fail(422, "EXPORT_TOO_FEW_ROWS", `Exports need at least ${EXPORT_MIN_ROWS} matching rows; this selection has ${total}`);
  const max = Math.min(total, EXPORT_MAX_ROWS);
  if (count < EXPORT_MIN_ROWS || count > max) fail(422, "EXPORT_COUNT_OUT_OF_RANGE", `Export count must be between ${EXPORT_MIN_ROWS} and ${max}`);
  return count;
}

/** Spreadsheet apps read a leading = + - @ (or tab / CR) as a formula: a quote makes the cell inert text (OWASP CSV injection). */
export function safeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cellText(value: ExportValue): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? safeText(value) : String(value);
}

const csvEscape = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

const BOM = String.fromCharCode(0xfeff);

export function toCsv(columns: ExportColumn[], rows: Array<Record<string, ExportValue>>): string {
  const lines = [columns.map((column) => csvEscape(safeText(column.label))).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(cellText(row[column.key]))).join(","));
  // BOM so Excel opens UTF-8 correctly.
  return BOM + lines.join("\r\n");
}

/** Numbers stay numeric; every string is written as a string cell (never a formula) and neutralised like the CSV. */
export function toXlsx(columns: ExportColumn[], rows: Array<Record<string, ExportValue>>, sheetName = "Export"): Buffer {
  const sheet: XLSX.WorkSheet = {};
  const put = (r: number, c: number, value: ExportValue, header = false) => {
    const address = XLSX.utils.encode_cell({ r, c });
    if (typeof value === "number" && Number.isFinite(value)) sheet[address] = { t: "n", v: value };
    else if (typeof value === "boolean") sheet[address] = { t: "b", v: value };
    else if (value === null || value === undefined) return;
    else sheet[address] = { t: "s", v: header ? safeText(String(value)) : cellText(value) };
  };
  columns.forEach((column, c) => put(0, c, column.label, true));
  rows.forEach((row, r) => columns.forEach((column, c) => put(r + 1, c, row[column.key])));
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(0, columns.length - 1) } });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Export");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
