// Re-checks the arithmetic in a calculation KROFT shows, so a wrong figure from the model doesn't
// pass silently. It only checks what it can be sure of; anything ambiguous is left alone.
//
// It understands the two shapes the system prompt asks for:
//   1. A step table whose amount column starts with an unsigned opening figure, has a "+" or "−"
//      on every step after it, and ends with a total row ("Final balance", "Total", …). The steps
//      must add up to the total row.
//   2. A running-balance column next to the amounts: each row's balance must equal the previous
//      balance plus that row's signed amount.
//   3. A plain breakdown ending in a "Total" row: the items must add up to it.
// In both cases a ```result card above the table must match the table's total.

const TOTAL_ROW = /^\s*(?:total|grand total|subtotal|final|net|balance|closing balance|amount due|you (?:pay|get|receive)|remaining|left)\b/i;
const clean = c => String(c ?? "").replace(/[*_`~]/g, "").trim();

// "−₦60,300.00" → { value: -60300, signed: true }. Returns null for anything that isn't a plain
// money figure (percentages, "1.5k", words), which makes the check skip that table.
export function parseAmount(cell) {
  let s = clean(cell);
  if (!s || /%|\d\s*[kmb]n?\b/i.test(s)) return null;
  let neg = false, signed = false;
  if (/^\(.*\)$/.test(s)) { neg = true; signed = true; s = s.slice(1, -1).trim(); }
  const sign = s.match(/^([−\-–+])\s*/);
  if (sign) { signed = true; neg = sign[1] !== "+"; s = s.slice(sign[0].length); }
  s = s.replace(/^[A-Z]{3}\s*/i, "").replace(/^[₦$€£¥₹¢]\s*/, "");
  const inner = s.match(/^([−\-–+])\s*/); // "₦-500" style
  if (inner) { signed = true; neg = inner[1] !== "+"; s = s.slice(inner[0].length); }
  if (!/^\d[\d,]*(\.\d+)?$/.test(s)) return null;
  const value = parseFloat(s.replace(/,/g, ""));
  if (!isFinite(value)) return null;
  return { value: neg ? -value : value, signed };
}

const close = (a, b, steps = 1) => Math.abs(a - b) <= Math.max(0.011 * steps, Math.abs(b) * 1e-9);

export function formatAmountLike(sample, value) {
  const s = clean(sample);
  const sym = (s.match(/[₦$€£¥₹¢]/) || [""])[0];
  const code = (s.replace(/^[(−\-–+\s]+/, "").match(/^[A-Z]{3}(?=\s?\d)/) || [""])[0];
  const decimals = /\.\d{2}\b/.test(s) ? 2 : /\.\d\b/.test(s) ? 1 : 0;
  const body = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 2) });
  return `${value < 0 ? "−" : ""}${code ? code + " " : ""}${sym}${body}`;
}

// Checks one table. Returns null when the table is fine or isn't a shape we can check, otherwise
// { expected, stated, label } describing the first mismatch.
export function checkTable(table, resultValue = null) {
  const rows = table.rows;
  if (!rows || rows.length < 3) return null;
  const last = rows[rows.length - 1];
  if (!TOTAL_ROW.test(clean(last[0]))) return null;

  const cols = table.header.map((_, c) => rows.map(r => parseAmount(r[c])));
  const full = cols.map((col, c) => ({ c, col })).filter(({ col }) => col.every(v => v !== null));
  const middle = r => r > 0 && r < rows.length - 1;

  // Shape 2: an amount column (signed on every step; the opening and final rows may be blank)
  // followed somewhere to its right by a fully filled running-balance column.
  for (let a = 0; a < cols.length; a++) {
    const amt = cols[a];
    if (!amt.every((v, r) => (middle(r) ? v && v.signed : true))) continue;
    const balEntry = full.find(f => f.c > a);
    if (!balEntry) continue;
    const bal = balEntry.col;
    let running = bal[0].value;
    for (let r = 1; r < rows.length - 1; r++) {
      running += amt[r].value;
      if (!close(running, bal[r].value, r)) {
        return { expected: running, stated: bal[r].value, label: clean(rows[r][0]), sample: rows[r][balEntry.c], where: "row" };
      }
    }
    const total = bal[rows.length - 1];
    if (!close(running, total.value, rows.length)) return { expected: running, stated: total.value, label: clean(last[0]), sample: last[balEntry.c], where: "total" };
    if (resultValue !== null && !close(resultValue, total.value)) return { expected: total.value, stated: resultValue, label: "the headline figure", sample: last[balEntry.c], where: "result" };
    return null;
  }

  // Shape 1: opening figure, signed steps, total row.
  for (const { c, col } of full.slice().reverse()) {
    const [first, ...rest] = col;
    const steps = rest.slice(0, -1);
    const total = rest[rest.length - 1];
    if (first.signed || total.signed || !steps.every(v => v.signed)) continue;
    const sum = steps.reduce((s, v) => s + v.value, first.value);
    if (!close(sum, total.value, steps.length + 1)) return { expected: sum, stated: total.value, label: clean(last[0]), sample: last[c], where: "total" };
    if (resultValue !== null && !close(resultValue, total.value)) return { expected: total.value, stated: resultValue, label: "the headline figure", sample: last[c], where: "result" };
    return null;
  }

  // Shape 3: a plain breakdown (no signs) ending in a row labelled exactly "Total", e.g. an
  // expense list. Only "total"-style labels count here: "Balance" or "Net" often means a
  // subtraction, and checking those as a sum would raise false alarms.
  if (/^\s*(?:sub\s?total|total|grand total)\s*:?\s*$/i.test(clean(last[0]))) {
    for (const { c, col } of full.slice().reverse()) {
      if (col.some(v => v.signed || v.value < 0)) continue;
      const parts = col.slice(0, -1), total = col[col.length - 1];
      const sum = parts.reduce((t, v) => t + v.value, 0);
      if (!close(sum, total.value, parts.length)) return { expected: sum, stated: total.value, label: clean(last[0]), sample: last[c], where: "total" };
      if (resultValue !== null && !close(resultValue, total.value)) return { expected: total.value, stated: resultValue, label: "the headline figure", sample: last[c], where: "result" };
      return null;
    }
  }
  return null;
}

// Checks every table in a parsed reply. A ```result card is matched to the first table after it.
// Returns a Map of block index → mismatch.
export function verifyBlocks(blocks) {
  const issues = new Map();
  let pendingResult = null;
  blocks.forEach((b, i) => {
    if (b.type === "result") { const v = parseAmount(b.value); pendingResult = v ? v.value : null; return; }
    if (b.type !== "table") return;
    const issue = checkTable(b, pendingResult);
    pendingResult = null;
    if (issue) issues.set(i, issue);
  });
  return issues;
}
