import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

export const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';

const styles = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/><numFmt numFmtId="165" formatCode="0.00&quot; kg&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;

export type Parts = Record<string, string | Readable>;

/** A minimal, hand-built OOXML workbook (one sheet "Data"); styles 1/2 are date formats, 3 is a non-date number format. */
export function baseParts(input: { rows?: string; shared?: string[]; date1904?: boolean; sheetXml?: string | Readable }): Parts {
  return {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${input.date1904 ? ' date1904="1"' : ""}/><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": input.sheetXml ?? `<?xml version="1.0"?><worksheet ${NS}><sheetData>${input.rows ?? ""}</sheetData></worksheet>`,
    ...(input.shared ? { "xl/sharedStrings.xml": `<?xml version="1.0"?><sst ${NS} count="${input.shared.length}">${input.shared.map((text) => `<si><t>${text}</t></si>`).join("")}</sst>` } : {}),
  };
}

export async function writeXlsx(directory: string, name: string, parts: Parts) {
  const zip = new ZipFile();
  for (const [entry, content] of Object.entries(parts)) {
    if (typeof content === "string") zip.addBuffer(Buffer.from(content), entry);
    else zip.addReadStream(content, entry);
  }
  zip.end();
  const path = join(directory, name);
  await pipeline(zip.outputStream, createWriteStream(path));
  return path;
}

/** Streams a worksheet of `rowCount` data rows: Day (date style), Consignee (inline text), Weight (decimal). */
export function generatedSheet(rowCount: number, consigneeLabel = "CONSIGNEE") {
  let next = 0;
  return new Readable({
    read() {
      if (next === 0) this.push(`<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Day</t></is></c><c r="B1" t="inlineStr"><is><t>Consignee</t></is></c><c r="C1" t="inlineStr"><is><t>Weight</t></is></c></row>`);
      let chunk = "";
      for (let i = 0; i < 2_000 && next < rowCount; i += 1, next += 1) {
        const r = next + 2;
        chunk += `<row r="${r}"><c r="A${r}" s="1"><v>${45292 + (next % 900)}</v></c><c r="B${r}" t="inlineStr"><is><t>${consigneeLabel} ${next % 1_000} &amp; CO</t></is></c><c r="C${r}"><v>${(next % 5_000) / 8}</v></c></row>`;
      }
      if (next >= rowCount) { this.push(chunk + "</sheetData></worksheet>"); this.push(null); } else this.push(chunk);
    },
  });
}
