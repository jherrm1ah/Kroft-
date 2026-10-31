// The app's one typeface, shared with the lazily loaded charts. Inter is the closest freely
// licensed match for ChatGPT's own (proprietary) OpenAI Sans; the system fonts after it cover the
// moment before the web font loads, or a device where it can't.
export const APP_FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

// Uses Intl's native currency formatting instead of a hand-maintained symbol map, so any
// valid ISO 4217 code (NGN, GHS, INR, JPY, ...) formats correctly out of the box — adding
// support for a new currency never requires a code change here. Falls back to "<CODE> <amount>"
// only if the code itself is invalid/unrecognized, rather than silently mislabeling it as $.
export const fmtCur = (n, cur = "USD") => {
  try {
    return new Intl.NumberFormat("en-US", { style:"currency", currency:cur, currencyDisplay:"narrowSymbol", minimumFractionDigits:2, maximumFractionDigits:2 }).format(n);
  } catch {
    const neg = n < 0;
    const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 }).format(Math.abs(n));
    return `${neg ? "-" : ""}${cur} ${formatted}`;
  }
};
