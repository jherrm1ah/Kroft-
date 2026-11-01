// A small Markdown parser for KROFT's AI replies.
//
// Why not a library: replies are rendered as React elements built from this tree (see
// Markdown.jsx), never as an HTML string, so nothing the model writes can inject markup. It also
// has to cope with text that is still streaming in (an unclosed code fence, a table whose divider
// row hasn't arrived yet, a dangling "**"), which general-purpose parsers render as broken
// fragments mid-stream.
//
// Supported: # headings, paragraphs (single line breaks kept), **bold**, *italic*, ***both***,
// ~~strike~~, `code`, [links](https://…) and bare URLs, - / * / + / • bullets, 1. numbered lists
// (nested by indentation), > quotes, --- dividers, GFM tables, ``` fenced code, plus two KROFT
// fences: ```copy (a copy-ready block) and ```result (a headline figure).

// ── Block level ──

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = line => !line.trim();
const indentOf = line => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const isTableRow = line => line.includes("|") && line.trim() !== "|";

const splitRow = line => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  // Split on pipes that aren't escaped or inside `code`.
  const cells = []; let cur = ""; let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
};

const startsBlock = (line, next) =>
  FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) ||
  LIST_RE.test(line) || (isTableRow(line) && next !== undefined && TABLE_DIVIDER_RE.test(next));

export function parseBlocks(src, { streaming = false } = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    // Fenced code (and KROFT's copy/result fences). An unclosed fence runs to the end, which is
    // what a reply mid-stream looks like.
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1];
      const info = fence[2].trim();
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) { closed = true; i++; break; }
        body.push(lines[i]); i++;
      }
      const [kind, ...rest] = info.split(/\s+/);
      const lang = (kind || "").toLowerCase();
      const text = body.join("\n").replace(/\n+$/, "");
      if (lang === "copy") blocks.push({ type: "copy", label: rest.join(" "), text, closed });
      else if (lang === "result") blocks.push({ type: "result", ...parseResult(text), closed });
      else blocks.push({ type: "code", lang, text, closed });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++; continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++; continue;
    }

    // Tables: a header row followed by a divider row.
    if (isTableRow(line) && lines[i + 1] !== undefined && TABLE_DIVIDER_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const width = header.length;
      blocks.push({ type: "table", header, align: Array.from({ length: width }, (_, k) => align[k] ?? null), rows: rows.map(r => Array.from({ length: width }, (_, k) => r[k] ?? "")) });
      continue;
    }

    // While streaming, a run of "| a | b |" lines with no divider yet is almost certainly a table
    // whose divider hasn't arrived — hold it back rather than flash raw pipes.
    if (streaming && isTableRow(line) && line.trim().startsWith("|")) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j]) && !isBlank(lines[j])) j++;
      if (j === lines.length) { blocks.push({ type: "pending" }); break; }
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE_RE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        const m = lines[i].match(QUOTE_RE);
        body.push(m ? m[1] : lines[i]);
        i++;
      }
      blocks.push({ type: "quote", children: parseBlocks(body.join("\n"), { streaming }) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i, streaming);
      blocks.push(list);
      i = next;
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block starts.
    const para = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
    blocks.push({ type: "paragraph", text: para.map(l => l.trim()).join("\n") });
  }
  return blocks;
}

// A list and everything nested under it. Items deeper than the list's own indent belong to the
// previous item; a blank line ends the list unless the next line continues it.
function parseList(lines, start, streaming) {
  const first = lines[start].match(LIST_RE);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  let cur = null;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      // Continue past a blank line only if the list (or an item's nested content) carries on.
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      const nxt = lines[j];
      const m = nxt && nxt.match(LIST_RE);
      if (nxt && ((m && indentOf(m[1]) >= baseIndent && /\d/.test(m[2]) === ordered) || indentOf(nxt) > baseIndent)) {
        if (cur) cur.lines.push("");
        i = j; continue;
      }
      break;
    }
    const m = line.match(LIST_RE);
    const ind = indentOf(line);
    if (m && indentOf(m[1]) === baseIndent && /\d/.test(m[2]) === ordered) {
      cur = { num: ordered ? parseInt(m[2], 10) : null, lines: [m[3]] };
      items.push(cur); i++; continue;
    }
    if (m && indentOf(m[1]) < baseIndent) break;
    if (m && indentOf(m[1]) === baseIndent) break; // a different list type at the same level
    if (!cur) break;
    if (ind > baseIndent || !startsBlock(line, lines[i + 1])) {
      cur.lines.push(ind > baseIndent ? line.slice(Math.min(ind, baseIndent + 2)) : line.trim());
      i++; continue;
    }
    break;
  }

  const parsed = items.map(it => {
    const [head, ...rest] = it.lines;
    const restText = dedent(rest).join("\n");
    const children = restText.trim() ? parseBlocks(restText, { streaming }) : [];
    return { num: it.num, text: head, children };
  });
  return [{ type: "list", ordered, start: ordered ? (items[0]?.num ?? 1) : null, items: parsed }, i];
}

function dedent(lines) {
  const ind = Math.min(...lines.filter(l => l.trim()).map(indentOf));
  return isFinite(ind) ? lines.map(l => l.slice(Math.min(ind, indentOf(l)))) : lines;
}

// ```result blocks: first line is the label, second the figure, anything after is a note.
function parseResult(text) {
  const rows = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (rows.length === 1) return { label: "", value: rows[0], note: "" };
  return { label: rows[0] || "", value: rows[1] || "", note: rows.slice(2).join(" ") };
}

// ── Inline level ──

const SAFE_URL_RE = /^(https?:\/\/|mailto:|tel:)/i;
export const safeUrl = url => (SAFE_URL_RE.test(url.trim()) ? url.trim() : null);

const INLINE_RULES = [
  { type: "code", re: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y, inner: m => m[2].trim(), leaf: true },
  { type: "link", re: /\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/y, inner: m => m[1], href: m => m[2] },
  { type: "strongem", re: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/y, inner: m => m[1] },
  { type: "strong", re: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/y, inner: m => m[1] },
  { type: "strong", re: /__(?=\S)([\s\S]*?\S)__(?!\w)/y, inner: m => m[1], wordStart: true },
  { type: "em", re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/y, inner: m => m[1] },
  { type: "em", re: /_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/y, inner: m => m[1], wordStart: true },
  { type: "del", re: /~~(?=\S)([\s\S]*?\S)~~/y, inner: m => m[1] },
  { type: "autolink", re: /https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/y, inner: m => m[0], href: m => m[0], leaf: true },
];
const TRIGGERS = new Set(["`", "[", "*", "_", "~", "h"]);

export function parseInline(src) {
  const text = String(src ?? "");
  const out = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }
    if (ch === "\n") { flush(); out.push({ type: "br" }); i++; continue; }
    if (TRIGGERS.has(ch)) {
      let matched = false;
      for (const rule of INLINE_RULES) {
        if (rule.wordStart && i > 0 && /\w/.test(text[i - 1])) continue;
        if (rule.type === "autolink" && i > 0 && /[\w/]/.test(text[i - 1])) continue;
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (!m) continue;
        if (rule.type === "link") {
          const href = safeUrl(m[2]);
          flush();
          if (href) out.push({ type: "link", href, children: parseInline(m[1]) });
          else out.push(...parseInline(m[1])); // unsafe scheme: keep the words, drop the link
        } else if (rule.type === "autolink") {
          flush(); out.push({ type: "link", href: m[0], children: [{ type: "text", text: m[0] }] });
        } else if (rule.leaf) {
          flush(); out.push({ type: rule.type, text: rule.inner(m) });
        } else {
          flush(); out.push({ type: rule.type, children: parseInline(rule.inner(m)) });
        }
        i += m[0].length;
        matched = true;
        break;
      }
      if (matched) continue;
    }
    buf += ch; i++;
  }
  flush();
  // Emphasis markers left over with no partner (a model slip like "**Final amount:" or a
  // half-streamed "**Tot") are formatting, not content: drop them rather than show raw stars.
  // (No regex lookbehind here: older iOS Safari can't parse it.)
  return out.map(n => (n.type === "text" ? { ...n, text: n.text.replace(/\*{2,3}/g, "").replace(/(^|\s)__(?=\S)/g, "$1").replace(/(\S)__(?=\s|$)/g, "$1") } : n))
    .filter(n => n.type !== "text" || n.text);
}

// ── Converters ──

const inlineToPlain = nodes => nodes.map(n => {
  if (n.type === "text") return n.text;
  if (n.type === "br") return "\n";
  if (n.type === "code") return n.text;
  if (n.type === "link") { const t = inlineToPlain(n.children); return t === n.href || n.href.startsWith("mailto:") || n.href.startsWith("tel:") ? t : `${t} (${n.href})`; }
  return inlineToPlain(n.children || []);
}).join("");

// Plain text that keeps the shape a person expects when pasting: paragraph breaks, "- " and "1. "
// list markers, and table rows as "a | b".
export function toPlainText(src) {
  const render = (blocks, depth = 0) => blocks.map(b => {
    const pad = "  ".repeat(depth);
    switch (b.type) {
      case "heading": case "paragraph": return pad + inlineToPlain(parseInline(b.text)).replace(/\n/g, "\n" + pad);
      case "list": return b.items.map((it, k) => {
        const marker = b.ordered ? `${(b.start ?? 1) + k}. ` : "- ";
        const head = pad + marker + inlineToPlain(parseInline(it.text));
        const kids = it.children.length ? "\n" + render(it.children, depth + 1).replace(/\n\n/g, "\n") : "";
        return head + kids;
      }).join("\n");
      case "quote": return render(b.children, depth).split("\n").map(l => (l ? "> " + l : l)).join("\n");
      case "table": return [b.header, ...b.rows].map(r => r.map(c => inlineToPlain(parseInline(c))).join(" | ")).join("\n");
      case "code": case "copy": return b.type === "copy" ? toPlainText(b.text) : b.text;
      case "result": return [b.label, b.value, b.note].filter(Boolean).join("\n");
      case "hr": return "";
      default: return "";
    }
  }).filter(s => s !== "").join("\n\n");
  return render(parseBlocks(src)).trim();
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inlineToHtml = nodes => nodes.map(n => {
  switch (n.type) {
    case "text": return esc(n.text);
    case "br": return "<br>";
    case "code": return `<code>${esc(n.text)}</code>`;
    case "strong": return `<strong>${inlineToHtml(n.children)}</strong>`;
    case "em": return `<em>${inlineToHtml(n.children)}</em>`;
    case "strongem": return `<strong><em>${inlineToHtml(n.children)}</em></strong>`;
    case "del": return `<s>${inlineToHtml(n.children)}</s>`;
    case "link": return `<a href="${esc(n.href)}">${inlineToHtml(n.children)}</a>`;
    default: return "";
  }
}).join("");

// Escaped HTML for the clipboard's text/html slot, so pasting into Gmail, Docs or Word keeps bold,
// lists and tables. Every piece of text is escaped; only these fixed tags are ever produced.
export function toHtml(src) {
  const render = blocks => blocks.map(b => {
    switch (b.type) {
      case "heading": return `<h${Math.min(b.level + 1, 6)}>${inlineToHtml(parseInline(b.text))}</h${Math.min(b.level + 1, 6)}>`;
      case "paragraph": return `<p>${inlineToHtml(parseInline(b.text))}</p>`;
      case "list": { const tag = b.ordered ? "ol" : "ul"; return `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ""}>${b.items.map(it => `<li>${inlineToHtml(parseInline(it.text))}${render(it.children)}</li>`).join("")}</${tag}>`; }
      case "quote": return `<blockquote>${render(b.children)}</blockquote>`;
      case "table": return `<table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr>${b.header.map(c => `<th>${inlineToHtml(parseInline(c))}</th>`).join("")}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map(c => `<td>${inlineToHtml(parseInline(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "code": return `<pre><code>${esc(b.text)}</code></pre>`;
      case "copy": return toHtml(b.text);
      case "result": return `<p>${esc(b.label)}<br><strong>${esc(b.value)}</strong>${b.note ? `<br>${esc(b.note)}` : ""}</p>`;
      case "hr": return "<hr>";
      default: return "";
    }
  }).join("");
  return render(parseBlocks(src));
}

// Text for the speech engine: what a person would read out, with no symbols. Copy blocks are read
// as their content, results as "label: value", code is skipped.
export function toSpeechText(src) {
  const blocks = parseBlocks(src).map(b => (b.type === "code" ? { type: "paragraph", text: "Code block omitted." } : b));
  const render = bs => bs.map(b => {
    switch (b.type) {
      case "heading": case "paragraph": return inlineToPlain(parseInline(b.text)).replace(/\n+/g, ". ");
      case "list": return b.items.map(it => inlineToPlain(parseInline(it.text)) + (it.children.length ? ". " + render(it.children) : "")).join(". ");
      case "quote": return render(b.children);
      case "table": return [b.header, ...b.rows].map(r => r.map(c => inlineToPlain(parseInline(c))).filter(Boolean).join(", ")).join(". ");
      case "copy": return render(parseBlocks(b.text));
      case "result": return [b.label, b.value].filter(Boolean).join(": ") + (b.note ? `. ${b.note}` : "");
      default: return "";
    }
  }).filter(Boolean).join(". ");
  return render(blocks).replace(/([.!?:])\s*\.\s/g, "$1 ").replace(/\.\s*\./g, ".");
}
