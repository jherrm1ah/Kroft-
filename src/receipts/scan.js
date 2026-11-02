// Scan receipt (Finance › Scan receipt): a photo of a receipt goes to KROFT's AI, which reads
// who it's from, the date, the total and a category, and KROFT shows that for the person to
// check before it becomes an expense (or a bill to pay). The AI only reads; nothing is saved
// until the person says so.
//
// The prompt and the reply parsing are here so they can be tested; shrinkPhoto needs a browser.

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(new Date(`${s}T00:00:00`));

export function receiptPrompt({ categories = [], currency = "USD", today }) {
  return [
    "You read photos of receipts and bills for a bookkeeping app. Reply with ONLY one JSON object, no other text:",
    '{"receipt":true,"merchant":"string","date":"YYYY-MM-DD","total":number,"currency":"ABC","category":"string","due":"YYYY-MM-DD or empty"}',
    `- merchant: the shop or company's name as printed. - total: the final amount paid or due, a number with no currency sign or thousands separators. - currency: the ISO 4217 code printed or implied by the symbol; if unclear use ${currency}.`,
    `- date: the date on the receipt; if none is printed use ${today}. - category: the closest of: ${categories.join(", ") || "Other"}.`,
    "- due: only when it's a bill or invoice that hasn't been paid yet and shows a due date; otherwise empty.",
    'If the photo isn\'t a receipt, bill or invoice, reply {"receipt":false}. Never guess a total you can\'t read: use 0.',
  ].join("\n");
}

// The model's reply → what to show, or { ok:false, reason }.
export function parseReceiptReply(text, { categories = [], currency = "USD", today }) {
  const raw = String(text || "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  let data;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { return { ok: false, reason: "unreadable" }; }
  if (!data || data.receipt === false) return { ok: false, reason: "not-receipt" };
  const total = Math.round((parseFloat(String(data.total ?? "").replace(/,/g, "")) || 0) * 100) / 100;
  if (!(total > 0)) return { ok: false, reason: "no-total" };
  const cur = String(data.currency || "").trim().toUpperCase();
  const date = isDate(data.date) && data.date <= today ? data.date : today;
  const cat = categories.find(c => c.toLowerCase() === String(data.category || "").trim().toLowerCase()) || "";
  const due = isDate(data.due) ? data.due : "";
  return {
    ok: true,
    merchant: String(data.merchant || "").trim().slice(0, 80) || "Receipt",
    date, total,
    currency: /^[A-Z]{3}$/.test(cur) ? cur : currency,
    category: cat,
    due,
  };
}

// What to tell the person when a scan doesn't work.
export const SCAN_PROBLEM = {
  "not-receipt": "That doesn't look like a receipt. Try again with the whole receipt in the photo.",
  "no-total": "KROFT couldn't read the total. Try a clearer photo, or add it by hand.",
  unreadable: "KROFT couldn't read that receipt. Try a clearer photo, or add it by hand.",
};

// A phone photo is several MB; the AI only needs it big enough to read. Shrinks to at most
// 1600px on the long side as JPEG. Browser only.
export function shrinkPhoto(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
    img.src = url;
  });
}
