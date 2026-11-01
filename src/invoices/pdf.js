// Turns an invoice into a PDF, entirely on the device: no server, no PDF library.
//
// Each A4 page is drawn on a canvas with the app's own font, then the pages are wrapped in a
// minimal PDF (one image per page). Drawing it ourselves means the ₦ sign, Yoruba/Igbo/Hausa
// letters (ẹ, ọ, ṣ, ń …) and any other character print exactly as on screen; the standard PDF
// fonts can't show ₦ at all, and embedding a font would mean shipping a large library.

import { invoiceTotals, lineTotal, prettyDate, paymentLines, fromName, invoiceStatus, STATUS_LABEL } from "./model.js";

const PAGE_W = 595.28, PAGE_H = 841.89;  // A4 in PDF points
const SCALE = 2;                          // canvas pixels per point: sharp on phones and in print
const M = 48;                             // page margin
const ACCENT = "#4f5389", INK = "#141414", SOFT = "#5c5a55", MUTED = "#8a877f", LINE = "#e4e1da", BAND = "#f4f2ee";

// ── PDF wrapper ──────────────────────────────────────────────────────────────────────────────
const enc = s => new TextEncoder().encode(s);

// A PDF text string. Non-ASCII titles are written as UTF-16BE hex, which every reader understands.
export function pdfString(s) {
  const str = String(s ?? "");
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, m => `\\${m}`)})`;
  let hex = "FEFF";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

// pages: [{ jpeg: Uint8Array, width, height }] (pixel size of each JPEG). Returns the PDF bytes.
export function buildPdf(pages, { title = "Invoice", author = "" } = {}) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = bytes => { chunks.push(bytes); length += bytes.length; };
  const obj = (n, body) => { offsets[n] = length; push(enc(`${n} 0 obj\n`)); body(); push(enc("\nendobj\n")); };

  push(enc("%PDF-1.4\n"));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary, per the PDF spec
  const pageObjs = pages.map((_, i) => 4 + i * 3);
  obj(1, () => push(enc("<< /Type /Catalog /Pages 2 0 R >>")));
  obj(2, () => push(enc(`<< /Type /Pages /Kids [${pageObjs.map(n => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`)));
  obj(3, () => push(enc(`<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer (KROFT) /Creator (KROFT) >>`)));
  pages.forEach((p, i) => {
    const pageN = 4 + i * 3, contentN = pageN + 1, imageN = pageN + 2;
    const draw = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`;
    obj(pageN, () => push(enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`)));
    obj(contentN, () => { push(enc(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)); });
    obj(imageN, () => {
      push(enc(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`));
      push(p.jpeg);
      push(enc("\nendstream"));
    });
  });
  const count = 4 + pages.length * 3;
  const xrefAt = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(enc(`${xref}trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────
function wrap(ctx, text, width) {
  const lines = [];
  for (const para of String(text || "").split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= width || !line) line = test;
      else { lines.push(line); line = word; }
      // A single word wider than the column (a long URL) is cut so it can't spill over.
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function newPage(font) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(PAGE_W * SCALE); canvas.height = Math.round(PAGE_H * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.textBaseline = "alphabetic";
  const text = (str, x, y, { size = 10, weight = 400, color = INK, align = "left" } = {}) => {
    ctx.font = `${weight} ${size}px ${font}`; ctx.fillStyle = color; ctx.textAlign = align;
    ctx.fillText(String(str ?? ""), x, y);
  };
  const setFont = (size, weight = 400) => { ctx.font = `${weight} ${size}px ${font}`; };
  return { canvas, ctx, text, setFont };
}

// Draws the invoice on as many A4 canvases as it needs and returns them.
export function drawInvoicePages(inv, settings, user, fmt, { font = "Inter, sans-serif", today } = {}) {
  const pages = [];
  const t = invoiceTotals(inv);
  const money = n => fmt(n, inv.currency);
  const status = invoiceStatus(inv, today || inv.issueDate);
  const COL = { desc: M, qty: 372, price: 462, amount: PAGE_W - M };
  const DESC_W = COL.qty - 40 - M;
  const BOTTOM = PAGE_H - 70;

  let page = newPage(font);
  pages.push(page);
  let { ctx, text, setFont } = page;

  // Header: who it's from, and the invoice details.
  const from = fromName(settings, user) || "Invoice";
  setFont(20, 700);
  const fromLines = wrap(ctx, from, 300);
  let y = 72;
  fromLines.slice(0, 2).forEach((l, i) => text(l, M, y + i * 24, { size: 20, weight: 700 }));
  y += fromLines.slice(0, 2).length * 24 - 6;
  for (const l of [settings.address, settings.email || user?.email, settings.phone || user?.phone].filter(Boolean)) {
    setFont(9.5);
    for (const w of wrap(ctx, l, 300).slice(0, 3)) { y += 13; text(w, M, y, { size: 9.5, color: SOFT }); }
  }
  text("INVOICE", PAGE_W - M, 72, { size: 24, weight: 700, color: ACCENT, align: "right" });
  text(inv.number, PAGE_W - M, 92, { size: 11, weight: 600, align: "right" });
  text(`Issued ${prettyDate(inv.issueDate)}`, PAGE_W - M, 110, { size: 9.5, color: SOFT, align: "right" });
  text(`Due ${prettyDate(inv.dueDate)}`, PAGE_W - M, 124, { size: 9.5, weight: 600, align: "right" });
  if (status === "paid" || status === "cancelled") {
    const label = STATUS_LABEL[status].toUpperCase();
    const color = status === "paid" ? "#2f7d4f" : "#a23b3b";
    setFont(12, 700);
    const w = ctx.measureText(label).width + 20;
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.strokeRect(PAGE_W - M - w, 136, w, 24);
    text(label, PAGE_W - M - w / 2, 152, { size: 12, weight: 700, color, align: "center" });
  }

  // Bill to.
  y = Math.max(y, 160) + 34;
  text("BILL TO", M, y, { size: 8.5, weight: 600, color: MUTED });
  y += 16;
  text(inv.client?.name || "", M, y, { size: 12, weight: 600 });
  for (const l of [inv.client?.email, inv.client?.phone].filter(Boolean)) { y += 14; text(l, M, y, { size: 9.5, color: SOFT }); }

  // Items table.
  const tableHeader = top => {
    ctx.fillStyle = BAND; ctx.fillRect(M - 8, top, PAGE_W - 2 * M + 16, 24);
    text("DESCRIPTION", COL.desc, top + 16, { size: 8.5, weight: 600, color: SOFT });
    text("QTY", COL.qty, top + 16, { size: 8.5, weight: 600, color: SOFT, align: "right" });
    text("PRICE", COL.price, top + 16, { size: 8.5, weight: 600, color: SOFT, align: "right" });
    text("AMOUNT", COL.amount, top + 16, { size: 8.5, weight: 600, color: SOFT, align: "right" });
    return top + 24;
  };
  y = tableHeader(y + 26);
  for (const it of inv.items || []) {
    if (!it.description && !lineTotal(it)) continue;
    setFont(10);
    const lines = wrap(ctx, it.description, DESC_W);
    const rowH = lines.length * 14 + 12;
    if (y + rowH > BOTTOM) {
      text("Continued on the next page", PAGE_W - M, BOTTOM + 20, { size: 8.5, color: MUTED, align: "right" });
      page = newPage(font); pages.push(page); ({ ctx, text, setFont } = page);
      text(`${inv.number} (continued)`, M, 60, { size: 10, weight: 600, color: SOFT });
      y = tableHeader(76);
    }
    lines.forEach((l, i) => text(l, COL.desc, y + 18 + i * 14, { size: 10 }));
    text(String(Number(it.qty) || 0), COL.qty, y + 18, { size: 10, align: "right" });
    text(money(Number(it.price) || 0), COL.price, y + 18, { size: 10, align: "right" });
    text(money(lineTotal(it)), COL.amount, y + 18, { size: 10, weight: 600, align: "right" });
    y += rowH;
    ctx.strokeStyle = LINE; ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.moveTo(M - 8, y); ctx.lineTo(PAGE_W - M + 8, y); ctx.stroke();
  }

  // Totals, payment details and notes; moved to a new page if they don't fit.
  const pay = paymentLines(settings);
  setFont(9.5);
  const noteLines = inv.notes ? wrap(ctx, inv.notes, PAGE_W - 2 * M) : [];
  const totalsRows = [["Subtotal", t.subtotal], ...(t.discount ? [["Discount", -t.discount]] : []), ...(t.vat ? [[`VAT (${t.vatRate}%)`, t.vat]] : [])];
  const needed = 20 + totalsRows.length * 18 + 44 + (pay.length ? 30 + pay.length * 15 : 0) + (noteLines.length ? 30 + noteLines.length * 13 : 0);
  if (y + needed > BOTTOM) {
    page = newPage(font); pages.push(page); ({ ctx, text, setFont } = page);
    text(`${inv.number} (continued)`, M, 60, { size: 10, weight: 600, color: SOFT });
    y = 70;
  }
  y += 22;
  const labelX = COL.price - 70;
  for (const [label, value] of totalsRows) {
    text(label, labelX, y, { size: 10, color: SOFT });
    text(money(value), COL.amount, y, { size: 10, align: "right" });
    y += 18;
  }
  ctx.fillStyle = ACCENT; ctx.fillRect(labelX - 12, y - 6, COL.amount - labelX + 20, 32);
  text("Total due", labelX, y + 15, { size: 11, weight: 600, color: "#ffffff" });
  text(money(t.total), COL.amount, y + 15, { size: 13, weight: 700, color: "#ffffff", align: "right" });
  y += 44;

  if (pay.length) {
    y += 12;
    text("PAYMENT DETAILS", M, y, { size: 8.5, weight: 600, color: MUTED });
    for (const l of pay) { y += 15; text(l, M, y, { size: 10 }); }
    y += 6;
  }
  if (noteLines.length) {
    y += 22;
    text("NOTES", M, y, { size: 8.5, weight: 600, color: MUTED });
    for (const l of noteLines) { y += 13; text(l, M, y, { size: 9.5, color: SOFT }); }
  }

  pages.forEach((p, i) => {
    p.text(pages.length > 1 ? `Page ${i + 1} of ${pages.length}` : "", M, PAGE_H - 32, { size: 8, color: MUTED });
    p.text("Created with KROFT", PAGE_W - M, PAGE_H - 32, { size: 8, color: MUTED, align: "right" });
  });
  return pages.map(p => p.canvas);
}

const dataUrlBytes = url => {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// The finished PDF, plus a preview image of the first page.
export async function invoicePdf(inv, settings, user, fmt, { font, today } = {}) {
  try { await document.fonts?.ready; } catch { /* draw with whatever is loaded */ }
  const canvases = drawInvoicePages(inv, settings, user, fmt, { font, today });
  const pages = canvases.map(c => ({ jpeg: dataUrlBytes(c.toDataURL("image/jpeg", 0.9)), width: c.width, height: c.height }));
  const bytes = buildPdf(pages, { title: `Invoice ${inv.number}`, author: fromName(settings, user) });
  return { bytes, preview: canvases[0].toDataURL("image/jpeg", 0.85), pageCount: canvases.length };
}

// Plain ASCII: some browsers and phones drop or mangle a download name with accents, so
// "Bákàrè" becomes "Bakare" in the file name (the invoice itself keeps the accents).
export const invoiceFileName = inv => `${inv.number}${inv.client?.name ? ` ${inv.client.name}` : ""}`
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "")
  .replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() + ".pdf";
