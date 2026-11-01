import { toPlainText, toHtml } from "./parse.js";

// Last resort for browsers without the async Clipboard API, or where it's blocked (some Android
// WebViews, non-secure origins): a hidden textarea and the old copy command.
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Copies exact text (code, figures). Resolves to true when it worked.
export async function copyPlain(text) {
  const value = String(text ?? "");
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
  } catch { /* fall through */ }
  return legacyCopy(value);
}

// Copies written content from Markdown: plain text with its paragraphs and list markers kept,
// plus an HTML version so pasting into Gmail, Docs or Word keeps bold, lists and tables.
export async function copyRich(markdown) {
  const plain = toPlainText(markdown);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([toHtml(markdown)], { type: "text/html" }),
      })]);
      return true;
    }
  } catch { /* fall through to plain text */ }
  return copyPlain(plain);
}
