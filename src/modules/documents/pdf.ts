import PDFDocument from "pdfkit";
import { pdfReadyImage } from "./images.js";
import { formatMoney } from "./money.js";

/**
 * Reusable document template (A4). It is rendered from data, never from a UI
 * capture, and is deliberately organization-neutral: the issuer name comes from
 * the organization and the title from the document type. Not a fiscal invoice.
 */
export type PdfDocumentInput = {
  issuer: string;
  typeName: string;
  reference: string;
  status: string;
  date: Date;
  currency: string;
  client: { name: string; email: string | null; phone: string | null };
  items: Array<{ name: string; description: string; quantity: string; unitPrice: string; total: string }>;
  subtotal: string;
  total: string;
  comments: string;
  images: Array<{ filename: string; mime: string; data: Buffer }>;
  labels: PdfLabels;
};

export type PdfLabels = {
  date: string; client: string; email: string; phone: string; item: string; quantity: string; price: string; total: string;
  subtotal: string; comments: string; attachments: string; page: string; of: string; status: string; notFiscal: string;
};

export const pdfLabels: Record<"es" | "en", PdfLabels> = {
  es: { date: "Fecha", client: "Cliente", email: "Correo", phone: "Teléfono", item: "Item", quantity: "Cant.", price: "Precio", total: "Total", subtotal: "Subtotal", comments: "Comentarios", attachments: "Imágenes adjuntas", page: "Página", of: "de", status: "Estado", notFiscal: "Documento informativo; no constituye factura fiscal." },
  en: { date: "Date", client: "Client", email: "Email", phone: "Phone", item: "Item", quantity: "Qty", price: "Price", total: "Total", subtotal: "Subtotal", comments: "Comments", attachments: "Attached images", page: "Page", of: "of", status: "Status", notFiscal: "Informational document; not a tax invoice." },
};

const INK = "#16181D";
const MUTED = "#5A6472";
const LINE = "#D0D5DD";
const ACCENT = "#0F766E";
const MARGIN = 48;

export async function renderDocumentPdf(input: PdfDocumentInput): Promise<Buffer> {
  // PDFKit embeds JPEG/PNG only: convert anything else (WebP) before drawing. A file that fails to convert is
  // kept as-is so the existing per-image fallback (filename) still applies.
  const images = await Promise.all(input.images.map(async (image) => ({ ...image, data: await pdfReadyImage(image).catch(() => image.data) })));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      bufferPages: true,
      info: { Title: input.reference, Author: input.issuer, Subject: input.typeName },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = MARGIN;
    const right = doc.page.width - MARGIN;
    const width = right - left;
    const bottom = () => doc.page.height - MARGIN - 28;
    const L = input.labels;

    // Header
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(20).text(input.issuer, left, MARGIN, { width: width * 0.6 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(input.typeName.toUpperCase(), left, doc.y + 2, { width: width * 0.6 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(input.reference, left + width * 0.55, MARGIN, { width: width * 0.45, align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(10)
      .text(`${L.date}: ${input.date.toISOString().slice(0, 10)}`, left + width * 0.55, doc.y + 2, { width: width * 0.45, align: "right" })
      .text(`${L.status}: ${input.status}`, left + width * 0.55, doc.y + 1, { width: width * 0.45, align: "right" });
    doc.moveTo(left, 112).lineTo(right, 112).strokeColor(LINE).lineWidth(1).stroke();

    // Client
    doc.y = 126;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(L.client.toUpperCase(), left, doc.y);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(input.client.name, left, doc.y + 3, { width });
    doc.fillColor(MUTED).font("Helvetica").fontSize(10);
    if (input.client.email) doc.text(`${L.email}: ${input.client.email}`, left, doc.y + 2, { width });
    if (input.client.phone) doc.text(`${L.phone}: ${input.client.phone}`, left, doc.y + 1, { width });
    doc.moveDown(1.2);

    // Items table
    const columns = { name: left, qty: left + width * 0.56, price: left + width * 0.7, total: left + width * 0.85 };
    const columnWidth = { name: width * 0.54, qty: width * 0.12, price: width * 0.14, total: width * 0.15 };
    const header = () => {
      const y = doc.y;
      doc.rect(left, y, width, 20).fill("#F2F4F7");
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
      doc.text(L.item, columns.name + 6, y + 6, { width: columnWidth.name });
      doc.text(L.quantity, columns.qty, y + 6, { width: columnWidth.qty, align: "right" });
      doc.text(L.price, columns.price, y + 6, { width: columnWidth.price, align: "right" });
      doc.text(L.total, columns.total, y + 6, { width: columnWidth.total - 6, align: "right" });
      doc.y = y + 26;
    };
    header();
    for (const item of input.items) {
      doc.font("Helvetica-Bold").fontSize(10);
      const nameHeight = doc.heightOfString(item.name, { width: columnWidth.name - 6 });
      doc.font("Helvetica").fontSize(9);
      const descriptionHeight = item.description ? doc.heightOfString(item.description, { width: columnWidth.name - 6 }) : 0;
      const rowHeight = nameHeight + descriptionHeight + 10;
      if (doc.y + rowHeight > bottom()) {
        doc.addPage();
        doc.y = MARGIN;
        header();
      }
      const y = doc.y;
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(item.name, columns.name + 6, y, { width: columnWidth.name - 6 });
      if (item.description) doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(item.description, columns.name + 6, y + nameHeight, { width: columnWidth.name - 6 });
      doc.fillColor(INK).font("Helvetica").fontSize(10);
      doc.text(item.quantity, columns.qty, y, { width: columnWidth.qty, align: "right" });
      doc.text(formatMoney(item.unitPrice, input.currency), columns.price, y, { width: columnWidth.price, align: "right" });
      doc.text(formatMoney(item.total, input.currency), columns.total, y, { width: columnWidth.total - 6, align: "right" });
      const next = y + rowHeight;
      doc.moveTo(left, next - 3).lineTo(right, next - 3).strokeColor("#EAECF0").lineWidth(0.5).stroke();
      doc.y = next;
    }

    // Totals
    if (doc.y + 70 > bottom()) { doc.addPage(); doc.y = MARGIN; }
    doc.moveDown(0.6);
    const totalsX = left + width * 0.58;
    const totalsWidth = right - totalsX;
    const row = (label: string, value: string, strong: boolean) => {
      const y = doc.y;
      doc.fillColor(strong ? INK : MUTED).font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 13 : 10);
      doc.text(label, totalsX, y, { width: totalsWidth * 0.5 });
      doc.text(value, totalsX + totalsWidth * 0.4, y, { width: totalsWidth * 0.6, align: "right" });
      doc.y = y + (strong ? 20 : 16);
    };
    row(L.subtotal, formatMoney(input.subtotal, input.currency), false);
    doc.moveTo(totalsX, doc.y - 2).lineTo(right, doc.y - 2).strokeColor(LINE).lineWidth(1).stroke();
    row(L.total, formatMoney(input.total, input.currency), true);

    // Comments
    if (input.comments.trim()) {
      doc.moveDown(1);
      if (doc.y + 40 > bottom()) { doc.addPage(); doc.y = MARGIN; }
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(L.comments.toUpperCase(), left, doc.y);
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(input.comments, left, doc.y + 3, { width });
    }

    // Images (JPEG/PNG/WebP validated at upload; WebP converted above)
    if (images.length > 0) {
      doc.addPage();
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(L.attachments.toUpperCase(), left, MARGIN);
      doc.y = MARGIN + 18;
      const cell = (width - 16) / 2;
      let column = 0;
      let rowTop = doc.y;
      for (const image of images) {
        if (rowTop + cell > bottom()) { doc.addPage(); rowTop = MARGIN; column = 0; }
        const x = left + column * (cell + 16);
        try {
          doc.image(image.data, x, rowTop, { fit: [cell, cell], align: "center", valign: "center" });
        } catch {
          doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(image.filename, x, rowTop, { width: cell });
        }
        doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(image.filename, x, rowTop + cell + 2, { width: cell });
        column += 1;
        if (column === 2) { column = 0; rowTop += cell + 26; }
      }
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      const y = doc.page.height - MARGIN - 14;
      doc.fillColor(MUTED).font("Helvetica").fontSize(8)
        .text(L.notFiscal, left, y, { width: width * 0.75, lineBreak: false })
        .text(`${L.page} ${index + 1} ${L.of} ${range.count}`, right - 90, y, { width: 90, align: "right", lineBreak: false });
    }
    doc.end();
  });
}
