import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { safeText, toCsv, toXlsx, validateExportCount } from "../src/modules/north/data/export-format.js";

const columns = [{ key: "a", label: "Name" }, { key: "n", label: "=Total" }];

test("count must sit in [100, min(total, 10000)]", () => {
  assert.equal(validateExportCount(8_000, 100), 100);
  assert.equal(validateExportCount(8_000, 8_000), 8_000);
  assert.equal(validateExportCount(50_000, 10_000), 10_000);
  assert.throws(() => validateExportCount(99, 99), /at least 100/);
  assert.throws(() => validateExportCount(8_000, 99), /between 100 and 8000/);
  assert.throws(() => validateExportCount(8_000, 8_001), /between 100 and 8000/);
  assert.throws(() => validateExportCount(50_000, 10_001), /between 100 and 10000/);
});

test("formula-looking text is neutralised in CSV and XLSX", () => {
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) assert.equal(safeText(bad), `'${bad}`);
  assert.equal(safeText("normal"), "normal");
  const rows = [{ a: "=cmd|' /C calc'!A0", n: 5 }, { a: 'say "hi", ok', n: null }];
  const csv = toCsv(columns, rows);
  assert.ok(csv.startsWith("﻿"));
  assert.ok(csv.includes("'=Total"));
  assert.ok(csv.includes("'=cmd"));
  assert.ok(csv.includes('"say ""hi"", ok"'));
  const sheet = XLSX.read(toXlsx(columns, rows), { type: "buffer" }).Sheets.Export!;
  assert.equal(sheet.A2!.t, "s");
  assert.equal(sheet.A2!.v, "'=cmd|' /C calc'!A0");
  assert.equal(sheet.B2!.t, "n");
  assert.equal(sheet.B3, undefined);
  assert.equal(sheet.A1!.v, "Name");
});
