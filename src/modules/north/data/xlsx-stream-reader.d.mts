export class XlsxReadError extends Error { code: string; constructor(code: string); }
export type XlsxCell = { t: "s"; v: string } | { t: "n"; v: number } | { t: "b"; v: boolean } | { t: "d"; v: Date } | { t: "e"; v: string };
export type XlsxRow = { index: number; cells: Array<XlsxCell | undefined> };
export type XlsxLimits = {
  maximumEntries: number; maximumEntryBytes: number; maximumRows: number; maximumColumns: number; maximumCells: number;
  maximumSheets: number; maximumCellTextBytes: number; sharedStringsMemoryBytes: number; maximumSharedStrings: number;
};
export type XlsxCounters = { cells: number; maximumRowIndex: number; maximumColumnIndex: number };
export type StreamingWorkbook = {
  sheets: string[];
  sharedStringsUseFile: boolean;
  sharedStringsCount: number;
  rows(sheetOrdinal: number, counters?: XlsxCounters): AsyncGenerator<XlsxRow>;
  close(): void;
};
export function columnIndex(reference: string): number;
export function excelSerialToDate(serial: number, date1904: boolean): Date | null;
export function openWorkbook(path: string, limits: XlsxLimits, spillDirectory: string): Promise<StreamingWorkbook>;
