// Turns an invoice into a PDF, entirely on the device: no server, no PDF library.
//
// Each A4 page is drawn on a canvas with the app's own font, then the pages are wrapped in a
// minimal PDF (one image per page). Drawing it ourselves means the ₦ sign, Yoruba/Igbo/Hausa
// letters (ẹ, ọ, ṣ, ń …) and any other character print exactly as on screen; the standard PDF
// fonts can't show ₦ at all, and embedding a font would mean shipping a large library.

import { invoiceTotals, lineTotal, prettyDate, paymentLines, fromName, taxName, taxIdLine, docStatus, STATUS_LABEL, amountPaid, balanceDue, payLink } from "./model.js";
import { receiptFor, statementFor } from "./documents.js";
import { logoSize, loadLogo } from "./branding.js";

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

// pages: [{ jpeg: Uint8Array, width, height, links? }] (pixel size of each JPEG). links are the
// tappable areas on the page, [{ x, y, w, h, url }] in points from the top-left (the "Pay now"
// button): written as PDF link annotations, so tapping them in any PDF reader opens the address.
// Returns the PDF bytes.
export function buildPdf(pages, { title = "Invoice", author = "" } = {}) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = bytes => { chunks.push(bytes); length += bytes.length; };
  const obj = (n, body) => { offsets[n] = length; push(enc(`${n} 0 obj\n`)); body(); push(enc("\nendobj\n")); };

  push(enc("%PDF-1.4\n"));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary, per the PDF spec
  const pageObjs = pages.map((_, i) => 4 + i * 3);
  let nextObj = 4 + pages.length * 3;
  const annots = pages.map(p => (p.links || []).map(l => ({ ...l, n: nextObj++ })));
  obj(1, () => push(enc("<< /Type /Catalog /Pages 2 0 R >>")));
  obj(2, () => push(enc(`<< /Type /Pages /Kids [${pageObjs.map(n => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`)));
  obj(3, () => push(enc(`<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer (KROFT) /Creator (KROFT) >>`)));
  pages.forEach((p, i) => {
    const pageN = 4 + i * 3, contentN = pageN + 1, imageN = pageN + 2;
    const draw = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`;
    const annotRefs = annots[i].length ? ` /Annots [${annots[i].map(a => `${a.n} 0 R`).join(" ")}]` : "";
    obj(pageN, () => push(enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R${annotRefs} >>`)));
    obj(contentN, () => { push(enc(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`)); });
    obj(imageN, () => {
      push(enc(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`));
      push(p.jpeg);
      push(enc("\nendstream"));
    });
  });
  const r2 = n => Math.round(n * 100) / 100;
  for (const a of annots.flat()) {
    const rect = [a.x, PAGE_H - a.y - a.h, a.x + a.w, PAGE_H - a.y].map(r2).join(" ");
    obj(a.n, () => push(enc(`<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /A << /Type /Action /S /URI /URI ${pdfString(a.url)} >> >>`)));
  }
  const count = nextObj;
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
  return { canvas, ctx, text, setFont, links: [] };
}

// "Pay now": a button that opens the business's own payment link, with the address beside it for
// anyone reading a printed copy. Records the button as a tappable area. Returns the y below it.
const PAY_BTN = { w: 112, h: 30 };
function payNow(page, y, url) {
  const { ctx, text, setFont } = page;
  const x = M, top = y + 8;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, top, PAY_BTN.w, PAY_BTN.h, 8); else ctx.rect(x, top, PAY_BTN.w, PAY_BTN.h);
  ctx.fill();
  text("Pay now", x + PAY_BTN.w / 2, top + 20, { size: 12, weight: 700, color: "#ffffff", align: "center" });
  setFont(9);
  const shown = wrap(ctx, url.replace(/^https?:\/\//, "").replace(/\/$/, ""), PAGE_W - 2 * M - PAY_BTN.w - 14)[0];
  text(shown, x + PAY_BTN.w + 12, top + 19, { size: 9, color: SOFT });
  page.links.push({ x, y: top, w: PAY_BTN.w, h: PAY_BTN.h, url });
  return top + PAY_BTN.h + 4;
}
const withLinks = page => Object.assign(page.canvas, { kroftLinks: page.links });

// KROFT Pro: the business's logo in the top-left corner, above its name. Returns the baseline
// for the name: lower when there's a logo, so the two never overlap.
const LOGO_TOP = 36;
function drawLogo(page, logo) {
  if (!logo) return 72;
  const { width, height } = logoSize(logo.width, logo.height);
  if (!width) return 72;
  page.ctx.drawImage(logo, M, LOGO_TOP, width, height);
  return LOGO_TOP + height + 28;
}

// Draws the invoice on as many A4 canvases as it needs and returns them.
// brand: { logo (a loaded image or null), footer (show "Created with KROFT") }.
export function drawInvoicePages(inv, settings, user, fmt, { font = "Inter, sans-serif", today, brand = { logo: null, footer: true } } = {}) {
  const pages = [];
  const t = invoiceTotals(inv);
  const money = n => fmt(n, inv.currency);
  const isQuote = inv.kind === "quote";
  const status = docStatus(inv, today || inv.issueDate);
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
  let y = drawLogo(page, brand.logo);
  fromLines.slice(0, 2).forEach((l, i) => text(l, M, y + i * 24, { size: 20, weight: 700 }));
  y += fromLines.slice(0, 2).length * 24 - 6;
  for (const l of [settings.address, settings.email || user?.email, settings.phone || user?.phone, taxIdLine(settings)].filter(Boolean)) {
    setFont(9.5);
    for (const w of wrap(ctx, l, 300).slice(0, 3)) { y += 13; text(w, M, y, { size: 9.5, color: SOFT }); }
  }
  text(isQuote ? "QUOTE" : "INVOICE", PAGE_W - M, 72, { size: 24, weight: 700, color: ACCENT, align: "right" });
  text(inv.number, PAGE_W - M, 92, { size: 11, weight: 600, align: "right" });
  text(`Issued ${prettyDate(inv.issueDate)}`, PAGE_W - M, 110, { size: 9.5, color: SOFT, align: "right" });
  text(isQuote ? `Valid until ${prettyDate(inv.validUntil)}` : `Due ${prettyDate(inv.dueDate)}`, PAGE_W - M, 124, { size: 9.5, weight: 600, align: "right" });
  if (["paid", "cancelled", "accepted", "declined"].includes(status)) {
    const label = STATUS_LABEL[status].toUpperCase();
    const color = status === "paid" || status === "accepted" ? "#2f7d4f" : "#a23b3b";
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
  const pay = isQuote ? [] : paymentLines(settings);
  const link = isQuote || ["paid", "cancelled"].includes(status) ? "" : payLink(settings);
  setFont(9.5);
  const noteLines = inv.notes ? wrap(ctx, inv.notes, PAGE_W - 2 * M) : [];
  // Part-paid invoices show the full total, what's been paid, and the balance as the amount due.
  const paidSoFar = isQuote ? 0 : amountPaid(inv);
  const partly = paidSoFar > 0 && status !== "paid";
  const totalsRows = [["Subtotal", t.subtotal], ...(t.discount ? [["Discount", -t.discount]] : []), ...(t.vat ? [[`${taxName(inv)} (${t.vatRate}%)`, t.vat]] : []),
    ...(partly ? [["Total", t.total], ["Paid so far", -paidSoFar]] : [])];
  const needed = 20 + totalsRows.length * 18 + 44 + (pay.length || link ? 30 + pay.length * 15 : 0) + (link ? 42 : 0) + (noteLines.length ? 30 + noteLines.length * 13 : 0);
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
  text(isQuote ? "Total" : partly ? "Balance due" : "Total due", labelX, y + 15, { size: 11, weight: 600, color: "#ffffff" });
  text(money(partly ? balanceDue(inv) : t.total), COL.amount, y + 15, { size: 13, weight: 700, color: "#ffffff", align: "right" });
  y += 44;

  if (pay.length || link) {
    y += 12;
    text("PAYMENT DETAILS", M, y, { size: 8.5, weight: 600, color: MUTED });
    if (link) y = payNow(page, y, link) + 4;
    for (const l of pay) { y += 15; text(l, M, y, { size: 10 }); }
    y += 6;
  }
  if (noteLines.length) {
    y += 22;
    text("NOTES", M, y, { size: 8.5, weight: 600, color: MUTED });
    for (const l of noteLines) { y += 13; text(l, M, y, { size: 9.5, color: SOFT }); }
  }

  footer(pages, brand);
  return pages.map(withLinks);
}

const dataUrlBytes = url => {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// The finished PDF, plus a preview image of the first page.
// branding: { logo (data URL or ""), footer } from brandingFor() in branding.js.
const toBrand = async (branding = {}) => ({ logo: branding.logo ? await loadLogo(branding.logo) : null, footer: branding.footer !== false });

export async function invoicePdf(inv, settings, user, fmt, { font = "Inter, sans-serif", today, branding } = {}) {
  // A canvas draws nothing for text whose web font is still downloading, so load every weight
  // used, for every character on this document (accented names need a different font file than
  // plain English), before drawing.
  try {
    const sample = [fromName(settings, user), settings.address, settings.email, settings.phone, inv.client?.name, inv.client?.email, inv.notes,
      ...(inv.items || []).map(it => it.description), "INVOICE QUOTE 0123456789 ₦$€£,.-()%", taxIdLine(settings), ...paymentLines(settings)].filter(Boolean).join(" ");
    await Promise.all([400, 600, 700].map(w => document.fonts?.load(`${w} 16px ${font}`, sample)));
    await document.fonts?.ready;
  } catch { /* draw with whatever is loaded */ }
  const canvases = drawInvoicePages(inv, settings, user, fmt, { font, today, brand: await toBrand(branding) });
  const pages = canvases.map(c => ({ jpeg: dataUrlBytes(c.toDataURL("image/jpeg", 0.9)), width: c.width, height: c.height, links: c.kroftLinks || [] }));
  const bytes = buildPdf(pages, { title: `${inv.kind === "quote" ? "Quote" : "Invoice"} ${inv.number}`, author: fromName(settings, user) });
  return { bytes, preview: canvases[0].toDataURL("image/jpeg", 0.85), pageCount: canvases.length };
}

// Plain ASCII: some browsers and phones drop or mangle a download name with accents, so
// "Bákàrè" becomes "Bakare" in the file name (the invoice itself keeps the accents).
export const invoiceFileName = inv => `${inv.number}${inv.client?.name ? ` ${inv.client.name}` : ""}`
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "")
  .replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() + ".pdf";

// ── Receipts and statements ──────────────────────────────────────────────────────────────────
// The business's details on the left, the document's title, number and dates on the right.
// Returns the y below the header.
function docHeader(page, settings, user, { title, number, meta = [], brand = {} }) {
  const { ctx, text, setFont } = page;
  setFont(20, 700);
  const fromLines = wrap(ctx, fromName(settings, user) || title, 300).slice(0, 2);
  let y = drawLogo(page, brand.logo);
  fromLines.forEach((l, i) => text(l, M, y + i * 24, { size: 20, weight: 700 }));
  y += fromLines.length * 24 - 6;
  for (const l of [settings.address, settings.email || user?.email, settings.phone || user?.phone, taxIdLine(settings)].filter(Boolean)) {
    setFont(9.5);
    for (const w of wrap(ctx, l, 300).slice(0, 3)) { y += 13; text(w, M, y, { size: 9.5, color: SOFT }); }
  }
  text(title, PAGE_W - M, 72, { size: 24, weight: 700, color: ACCENT, align: "right" });
  if (number) text(number, PAGE_W - M, 92, { size: 11, weight: 600, align: "right" });
  meta.forEach((m, i) => text(m, PAGE_W - M, (number ? 110 : 94) + i * 14, { size: 9.5, color: SOFT, align: "right" }));
  return Math.max(y, 140) + 34;
}

function footer(pages, brand = {}) {
  pages.forEach((p, i) => {
    p.text(pages.length > 1 ? `Page ${i + 1} of ${pages.length}` : "", M, PAGE_H - 32, { size: 8, color: MUTED });
    if (brand.footer !== false) p.text("Created with KROFT", PAGE_W - M, PAGE_H - 32, { size: 8, color: MUTED, align: "right" });
  });
}

function stamp(page, label, color, top) {
  const { ctx, text, setFont } = page;
  setFont(12, 700);
  const w = ctx.measureText(label).width + 20;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.strokeRect(PAGE_W - M - w, top, w, 24);
  text(label, PAGE_W - M - w / 2, top + 16, { size: 12, weight: 700, color, align: "center" });
}

export function drawReceiptPage(inv, paymentId, settings, user, fmt, { font = "Inter, sans-serif", brand = { logo: null, footer: true } } = {}) {
  const r = receiptFor(inv, paymentId);
  const page = newPage(font);
  const { ctx, text } = page;
  const money = n => fmt(n, r.currency);
  let y = docHeader(page, settings, user, { title: "RECEIPT", number: r.number, meta: [`Received ${prettyDate(r.date)}`], brand });
  if (r.paidInFull) stamp(page, "PAID IN FULL", "#2f7d4f", 122);

  text("RECEIVED FROM", M, y, { size: 8.5, weight: 600, color: MUTED });
  y += 16;
  text(r.client.name || "", M, y, { size: 12, weight: 600 });
  for (const l of [r.client.email, r.client.phone].filter(Boolean)) { y += 14; text(l, M, y, { size: 9.5, color: SOFT }); }

  // The amount, large.
  y += 30;
  ctx.fillStyle = BAND; ctx.fillRect(M - 8, y, PAGE_W - 2 * M + 16, 64);
  text("AMOUNT RECEIVED", M + 8, y + 24, { size: 8.5, weight: 600, color: SOFT });
  text(money(r.amount), M + 8, y + 50, { size: 22, weight: 700 });
  text(`For invoice ${r.invoiceNumber}`, PAGE_W - M - 8, y + 24, { size: 9.5, color: SOFT, align: "right" });
  text(`issued ${prettyDate(r.invoiceDate)}`, PAGE_W - M - 8, y + 40, { size: 9.5, color: SOFT, align: "right" });
  y += 64 + 30;

  const rows = [["Invoice total", r.total], ...(r.paidBefore ? [["Paid before", -r.paidBefore]] : []), ["This payment", -r.amount]];
  const labelX = 372 - 70, right = PAGE_W - M;
  for (const [label, value] of rows) {
    text(label, labelX, y, { size: 10, color: SOFT });
    text(money(value), right, y, { size: 10, align: "right" });
    y += 18;
  }
  ctx.fillStyle = r.paidInFull ? "#2f7d4f" : ACCENT; ctx.fillRect(labelX - 12, y - 6, right - labelX + 20, 32);
  text(r.paidInFull ? "Paid in full" : "Still due", labelX, y + 15, { size: 11, weight: 600, color: "#ffffff" });
  text(money(r.balanceAfter), right, y + 15, { size: 13, weight: 700, color: "#ffffff", align: "right" });
  y += 70;
  const pay = r.paidInFull ? [] : paymentLines(settings);
  const link = r.paidInFull ? "" : payLink(settings);
  if (pay.length || link) {
    text("PAYMENT DETAILS", M, y, { size: 8.5, weight: 600, color: MUTED });
    if (link) y = payNow(page, y, link) + 4;
    for (const l of pay) { y += 15; text(l, M, y, { size: 10 }); }
    y += 34;
  }
  text("Thank you for your payment.", M, y, { size: 10, color: SOFT });
  footer([page], brand);
  return [withLinks(page)];
}

export function drawStatementPages(st, settings, user, fmt, { font = "Inter, sans-serif", name = "", brand = { logo: null, footer: true } } = {}) {
  const pages = [];
  let page = newPage(font);
  pages.push(page);
  let { ctx, text, setFont } = page;
  const money = n => fmt(n, st.currency);
  const BOTTOM = PAGE_H - 70;
  const meta = [`Date ${prettyDate(st.to)}`, ...(st.from ? [`Period ${prettyDate(st.from)} to ${prettyDate(st.to)}`] : [])];
  let y = docHeader(page, settings, user, { title: "STATEMENT", number: "", meta, brand });

  text("TO", M, y, { size: 8.5, weight: 600, color: MUTED });
  y += 16;
  text(name || st.client.name || "", M, y, { size: 12, weight: 600 });
  for (const l of [st.client.email, st.client.phone].filter(Boolean)) { y += 14; text(l, M, y, { size: 9.5, color: SOFT }); }

  // Summary: four boxes.
  y += 24;
  const boxes = [["Opening balance", st.opening], ["Invoiced", st.invoiced], ["Paid", st.paid], ["Balance due", st.closing]];
  const bw = (PAGE_W - 2 * M + 16) / 4;
  boxes.forEach(([label, v], i) => {
    const x = M - 8 + i * bw;
    const last = i === 3;
    ctx.fillStyle = last ? ACCENT : BAND; ctx.fillRect(x + (i ? 4 : 0), y, bw - (i ? 4 : 0), 52);
    text(label.toUpperCase(), x + (i ? 14 : 10), y + 20, { size: 7.5, weight: 600, color: last ? "#ffffff" : SOFT });
    text(money(v), x + (i ? 14 : 10), y + 40, { size: 12, weight: 700, color: last ? "#ffffff" : INK });
  });
  y += 52 + 26;

  // Activity: date, details, invoiced, paid, balance.
  const COL = { date: M, details: M + 74, charge: 372, paid: 452, balance: PAGE_W - M };
  const head = top => {
    ctx.fillStyle = BAND; ctx.fillRect(M - 8, top, PAGE_W - 2 * M + 16, 24);
    [["DATE", COL.date, "left"], ["DETAILS", COL.details, "left"], ["INVOICED", COL.charge, "right"], ["PAID", COL.paid, "right"], ["BALANCE", COL.balance, "right"]]
      .forEach(([l, x, align]) => text(l, x, top + 16, { size: 8.5, weight: 600, color: SOFT, align }));
    return top + 24;
  };
  const newSheet = () => {
    text("Continued on the next page", PAGE_W - M, BOTTOM + 20, { size: 8.5, color: MUTED, align: "right" });
    page = newPage(font); pages.push(page); ({ ctx, text, setFont } = page);
    text(`Statement for ${name || st.client.name || ""} (continued)`, M, 60, { size: 10, weight: 600, color: SOFT });
  };
  y = head(y);
  const row = (date, details, charge, paid, balance, bold) => {
    if (y + 26 > BOTTOM) { newSheet(); y = head(76); }
    text(date, COL.date, y + 17, { size: 9.5, color: SOFT });
    setFont(9.5);
    text(wrap(ctx, details, COL.charge - 70 - COL.details)[0], COL.details, y + 17, { size: 9.5, weight: bold ? 600 : 400 });
    if (charge) text(money(charge), COL.charge, y + 17, { size: 9.5, align: "right" });
    if (paid) text(money(paid), COL.paid, y + 17, { size: 9.5, color: "#2f7d4f", align: "right" });
    text(money(balance), COL.balance, y + 17, { size: 9.5, weight: 600, align: "right" });
    y += 26;
    ctx.strokeStyle = LINE; ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.moveTo(M - 8, y); ctx.lineTo(PAGE_W - M + 8, y); ctx.stroke();
  };
  if (st.from) row(prettyDate(st.from), "Opening balance", 0, 0, st.opening, true);
  for (const l of st.lines) row(prettyDate(l.date), l.details, l.charge, l.paid, l.balance);
  if (!st.lines.length) row(prettyDate(st.to), "No invoices or payments in this period", 0, 0, st.closing);

  // Unpaid invoices.
  if (st.unpaid.length) {
    if (y + 60 > BOTTOM) { newSheet(); y = 70; }
    y += 30;
    text("UNPAID INVOICES", M, y, { size: 8.5, weight: 600, color: MUTED });
    for (const u of st.unpaid) {
      if (y + 18 > BOTTOM) { newSheet(); y = 76; }
      y += 17;
      text(u.number, M, y, { size: 9.5, weight: 600 });
      text(`due ${prettyDate(u.dueDate)}`, M + 90, y, { size: 9.5, color: SOFT });
      if (u.daysOverdue > 0) text(`${u.daysOverdue} day${u.daysOverdue === 1 ? "" : "s"} overdue`, M + 220, y, { size: 9.5, weight: 600, color: "#a23b3b" });
      text(money(u.due), PAGE_W - M, y, { size: 9.5, weight: 600, align: "right" });
    }
  }

  // How to pay.
  const pay = st.closing > 0 ? paymentLines(settings) : [];
  const link = st.closing > 0 ? payLink(settings) : "";
  if (pay.length || link) {
    if (y + 40 + pay.length * 15 + (link ? 42 : 0) > BOTTOM) { newSheet(); y = 70; }
    y += 34;
    text("PAYMENT DETAILS", M, y, { size: 8.5, weight: 600, color: MUTED });
    if (link) y = payNow(page, y, link) + 4;
    for (const l of pay) { y += 15; text(l, M, y, { size: 10 }); }
  }
  footer(pages, brand);
  return pages.map(withLinks);
}

async function toPdf(canvases, title, author) {
  const pages = canvases.map(c => ({ jpeg: dataUrlBytes(c.toDataURL("image/jpeg", 0.9)), width: c.width, height: c.height, links: c.kroftLinks || [] }));
  return { bytes: buildPdf(pages, { title, author }), preview: canvases[0].toDataURL("image/jpeg", 0.85), pageCount: canvases.length };
}

async function loadFonts(font, parts) {
  try {
    const sample = [...parts, "RECEIPT STATEMENT 0123456789 ₦$€£,.-()%"].filter(Boolean).join(" ");
    await Promise.all([400, 600, 700].map(w => document.fonts?.load(`${w} 16px ${font}`, sample)));
    await document.fonts?.ready;
  } catch { /* draw with whatever is loaded */ }
}

export async function receiptPdf(inv, paymentId, settings, user, fmt, { font = "Inter, sans-serif", branding } = {}) {
  await loadFonts(font, [fromName(settings, user), settings.address, settings.email, settings.phone, taxIdLine(settings), inv.client?.name, inv.client?.email, ...paymentLines(settings)]);
  const r = receiptFor(inv, paymentId);
  return toPdf(drawReceiptPage(inv, paymentId, settings, user, fmt, { font, brand: await toBrand(branding) }), `Receipt ${r.number}`, fromName(settings, user));
}

export async function statementPdf({ invoices, key, currency, from, to, name }, settings, user, fmt, { font = "Inter, sans-serif", branding } = {}) {
  const st = statementFor({ invoices, key, currency, from, to });
  await loadFonts(font, [fromName(settings, user), settings.address, settings.email, settings.phone, taxIdLine(settings), name, st.client.email, ...paymentLines(settings)]);
  return { ...(await toPdf(drawStatementPages(st, settings, user, fmt, { font, name, brand: await toBrand(branding) }), `Statement ${name || ""}`.trim(), fromName(settings, user))), statement: st };
}
