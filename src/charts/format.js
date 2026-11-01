// The app's one typeface, shared with the lazily loaded charts. Inter is the closest freely
// licensed match for ChatGPT's own (proprietary) OpenAI Sans; the system fonts after it cover the
// moment before the web font loads, or a device where it can't.
export const APP_FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// Uses Intl's native currency formatting instead of a hand-maintained symbol map, so any
// valid ISO 4217 code (NGN, GHS, INR, JPY, ...) formats correctly out of the box — adding
// support for a new currency never requires a code change here. Falls back to "<CODE> <amount>"
// only if the code itself is invalid/unrecognized, rather than silently mislabeling it as $.
// Written the way the person's own region writes money (1,000.00 or 1.000,00), and with the
// currency's own decimals (¥1,000, not ¥1,000.00).
const locale = () => (typeof navigator !== "undefined" && navigator.language) || "en-US";
export const fmtCur = (n, cur = "USD") => {
  try {
    return new Intl.NumberFormat(locale(), { style:"currency", currency:cur, currencyDisplay:"narrowSymbol" }).format(n);
  } catch {
    const neg = n < 0;
    const formatted = new Intl.NumberFormat(locale(), { minimumFractionDigits:2, maximumFractionDigits:2 }).format(Math.abs(n));
    return `${neg ? "-" : ""}${cur} ${formatted}`;
  }
};
