import { memo, useMemo, useState, useRef, useEffect, Fragment } from "react";
import { parseBlocks, parseInline } from "./parse.js";
import { copyRich, copyPlain } from "./clipboard.js";
import { highlight } from "./highlight.jsx";

// Renders an AI reply's Markdown as React elements. Nothing here uses dangerouslySetInnerHTML:
// every piece of model text ends up as a text node, so it can't inject markup.
//
// Props:
//   text       the Markdown
//   theme      the app's colour tokens (C in Kroft.jsx)
//   streaming  true while tokens are still arriving: half-written tables are held back and copy
//              buttons wait until their block is complete
//   caret      an element appended where the text currently ends (the "still writing" cursor)
//   onCopy     called with true/false after any copy button is used, e.g. to show a toast
//   font       font-family for prose

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// "₦297,862.50", "−₦60,300.00", "+40,000", "18%", "USD 1,200", "1.5k" — the cells worth right-aligning.
const NUMERIC_CELL = /^[([]?\s*[−\-+]?\s*(?:[A-Z]{3}\s?)?[₦$€£¥₹¢]?\s*[−\-+]?\d[\d,]*(?:\.\d+)?\s*(?:%|k|m|bn)?\s*[)\]]?$/i;
const TOTAL_ROW = /^\s*(?:\*\*)?\s*(?:total|grand total|subtotal|final|net|balance|closing balance|amount due|you (?:pay|get|receive))\b/i;
const plainCell = c => c.replace(/[*_`~]/g, "").trim();

function Inline({ nodes, theme }) {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text": return <Fragment key={i}>{n.text}</Fragment>;
      case "br": return <br key={i} />;
      case "strong": return <strong key={i} style={{ fontWeight: 650 }}><Inline nodes={n.children} theme={theme} /></strong>;
      case "em": return <em key={i}><Inline nodes={n.children} theme={theme} /></em>;
      case "strongem": return <strong key={i} style={{ fontWeight: 650 }}><em><Inline nodes={n.children} theme={theme} /></em></strong>;
      case "del": return <s key={i} style={{ opacity: .7 }}><Inline nodes={n.children} theme={theme} /></s>;
      case "code": return <code key={i} style={{ fontFamily: MONO, fontSize: ".88em", background: theme.hover, border: `1px solid ${theme.cardB}`, borderRadius: 6, padding: "1px 5px", wordBreak: "break-word" }}>{n.text}</code>;
      case "link": return (
        <a key={i} href={n.href} target={n.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer nofollow"
          style={{ color: theme.accent, textDecoration: "underline", textUnderlineOffset: 2, wordBreak: "break-word" }}>
          <Inline nodes={n.children} theme={theme} />
        </a>
      );
      default: return null;
    }
  });
}

const InlineText = ({ text, theme }) => <Inline nodes={parseInline(text)} theme={theme} />;

// A pill button that copies and briefly confirms. Hidden from layout shifts: its width is stable.
function CopyButton({ getText, rich, theme, onCopy, label = "Copy", ariaLabel, disabled }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async () => {
    const ok = await (rich ? copyRich(getText()) : copyPlain(getText()));
    onCopy?.(ok);
    if (ok) { setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800); }
  };
  return (
    <button type="button" onClick={run} disabled={disabled} aria-label={copied ? "Copied" : ariaLabel || label}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 999, border: `1px solid ${theme.cardB}`,
        background: theme.card, color: copied ? theme.positive : theme.text, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? .45 : 1, flexShrink: 0, minWidth: 84, justifyContent: "center" }}>
      <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {copied ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <><rect x="8.5" y="8.5" width="11" height="11" rx="2.2" /><path d="M15.5 8.5V6.7a2.2 2.2 0 0 0-2.2-2.2H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" /></>}
      </svg>
      {copied ? "Copied" : label}
    </button>
  );
}

function Table({ block, theme }) {
  const { header, rows, align } = block;
  // Columns that are mostly figures are right-aligned with tabular digits, unless the model set
  // the alignment itself.
  const numeric = header.map((_, c) => {
    const cells = rows.map(r => plainCell(r[c])).filter(Boolean);
    return cells.length > 0 && cells.filter(v => NUMERIC_CELL.test(v)).length / cells.length >= .6;
  });
  const colAlign = c => align[c] || (numeric[c] ? "right" : "left");
  const lastIsTotal = rows.length > 1 && TOTAL_ROW.test(rows[rows.length - 1][0] || "");
  const cellPad = "10px 12px";
  return (
    <div role="region" aria-label="Table" tabIndex={0}
      style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", border: `1px solid ${theme.cardB}`, borderRadius: 14, background: theme.card, maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, lineHeight: 1.45, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr>
            {header.map((h, c) => (
              <th key={c} scope="col" style={{ textAlign: colAlign(c), padding: cellPad, fontWeight: 600, fontSize: 13, color: theme.muted, background: theme.hover, whiteSpace: "nowrap", borderBottom: `1px solid ${theme.cardB}` }}>
                <InlineText text={h} theme={theme} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => {
            const total = lastIsTotal && ri === rows.length - 1;
            return (
              <tr key={ri}>
                {r.map((cell, c) => {
                  const v = plainCell(cell);
                  const signed = numeric[c] && /^[−-]/.test(v) ? theme.negative : numeric[c] && /^\+/.test(v) ? theme.positive : null;
                  return (
                    <td key={c} style={{ textAlign: colAlign(c), padding: cellPad, color: signed || theme.text, fontWeight: total ? 650 : 400,
                      borderTop: ri === 0 ? "none" : `${total ? 1.5 : 1}px solid ${total ? theme.border : theme.div}`,
                      whiteSpace: numeric[c] ? "nowrap" : "normal", minWidth: numeric[c] ? undefined : 96 }}>
                      <InlineText text={cell} theme={theme} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock({ block, theme, onCopy }) {
  const body = useMemo(() => highlight(block.text, block.lang, theme), [block.text, block.lang, theme]);
  return (
    <div style={{ border: `1px solid ${theme.cardB}`, borderRadius: 14, overflow: "hidden", background: theme.hover, maxWidth: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 6px 6px 14px", borderBottom: `1px solid ${theme.cardB}` }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: theme.muted, fontFamily: MONO }}>{block.lang || "code"}</span>
        <CopyButton getText={() => block.text} theme={theme} onCopy={onCopy} label="Copy code" disabled={!block.closed} />
      </div>
      <pre style={{ margin: 0, padding: "12px 14px", overflowX: "auto", WebkitOverflowScrolling: "touch", fontFamily: MONO, fontSize: 13, lineHeight: 1.6, color: theme.text, tabSize: 2, whiteSpace: "pre" }}>
        <code>{body}</code>
      </pre>
    </div>
  );
}

// Content the person asked for and will paste elsewhere (a message, email, caption, prompt…),
// set apart from KROFT's own words, with a Copy button that copies only this.
function CopyBlock({ block, theme, onCopy, font }) {
  return (
    <div style={{ border: `1px solid ${theme.cardB}`, borderRadius: 18, background: theme.card, overflow: "hidden", maxWidth: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 8px 8px 16px", borderBottom: `1px solid ${theme.div}` }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: theme.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{block.label || "Ready to copy"}</span>
        <CopyButton getText={() => block.text} rich theme={theme} onCopy={onCopy} disabled={!block.closed} ariaLabel={`Copy ${block.label || "text"}`} />
      </div>
      <div style={{ padding: "14px 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Blocks blocks={parseBlocks(block.text)} theme={theme} onCopy={onCopy} font={font} nested />
      </div>
    </div>
  );
}

// The headline figure of a calculation, shown above its breakdown.
function ResultBlock({ block, theme }) {
  return (
    <div style={{ background: theme.accentBg, borderRadius: 16, padding: "14px 16px" }}>
      {block.label && <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.soft }}><InlineText text={block.label} theme={theme} /></div>}
      <div style={{ fontSize: "clamp(24px, 7vw, 30px)", fontWeight: 700, letterSpacing: -.6, color: theme.text, fontVariantNumeric: "tabular-nums", lineHeight: 1.2, marginTop: block.label ? 4 : 0, wordBreak: "break-word" }}>
        <InlineText text={block.value} theme={theme} />
      </div>
      {block.note && <div style={{ fontSize: 13.5, color: theme.muted, marginTop: 6, lineHeight: 1.45 }}><InlineText text={block.note} theme={theme} /></div>}
    </div>
  );
}

const HEADING_SIZE = { 1: 20, 2: 18, 3: 16.5, 4: 15.5, 5: 15, 6: 15 };

function Blocks({ blocks, theme, onCopy, font, caret, nested }) {
  return blocks.map((b, i) => {
    const isLast = i === blocks.length - 1;
    const tail = isLast && caret ? caret : null;
    switch (b.type) {
      case "heading": {
        const Tag = `h${Math.min(b.level + 2, 6)}`; // replies sit inside the page, so start below the page title
        return <Tag key={i} style={{ fontSize: HEADING_SIZE[b.level], fontWeight: 650, letterSpacing: -.2, lineHeight: 1.35, color: theme.text, margin: i === 0 ? 0 : "6px 0 0" }}><InlineText text={b.text} theme={theme} />{tail}</Tag>;
      }
      case "paragraph":
        return <p key={i} style={{ margin: 0 }}><InlineText text={b.text} theme={theme} />{tail}</p>;
      case "list": {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag key={i} start={b.ordered && b.start !== 1 ? b.start : undefined} style={{ margin: 0, paddingLeft: b.ordered ? 24 : 22, display: "flex", flexDirection: "column", gap: 6 }}>
            {b.items.map((it, k) => (
              <li key={k} style={{ paddingLeft: 2 }}>
                <InlineText text={it.text} theme={theme} />
                {it.children.length > 0 && <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}><Blocks blocks={it.children} theme={theme} onCopy={onCopy} font={font} nested /></div>}
                {isLast && k === b.items.length - 1 && !it.children.length ? tail : null}
              </li>
            ))}
          </Tag>
        );
      }
      case "quote":
        return <blockquote key={i} style={{ margin: 0, padding: "2px 0 2px 14px", borderLeft: `3px solid ${theme.border}`, color: theme.soft, display: "flex", flexDirection: "column", gap: 10 }}><Blocks blocks={b.children} theme={theme} onCopy={onCopy} font={font} nested /></blockquote>;
      case "hr":
        return <hr key={i} style={{ border: "none", height: 1, background: theme.cardB, margin: "4px 0", width: "100%" }} />;
      case "table":
        return <Table key={i} block={b} theme={theme} />;
      case "code":
        return <CodeBlock key={i} block={b} theme={theme} onCopy={onCopy} />;
      case "copy":
        return nested ? <Blocks key={i} blocks={parseBlocks(b.text)} theme={theme} onCopy={onCopy} font={font} nested /> : <CopyBlock key={i} block={b} theme={theme} onCopy={onCopy} font={font} />;
      case "result":
        return <ResultBlock key={i} block={b} theme={theme} />;
      default:
        return null; // "pending": a table still arriving
    }
  });
}

export const Markdown = memo(function Markdown({ text, theme, streaming = false, caret = null, onCopy, font, style }) {
  const blocks = useMemo(() => parseBlocks(text, { streaming }), [text, streaming]);
  // A caret only makes sense at the end of prose; after a table or code block it sits on its own.
  const last = blocks[blocks.length - 1];
  const inlineCaret = caret && last && ["paragraph", "heading", "list"].includes(last.type);
  return (
    // Capped at a comfortable reading width so tables and paragraphs don't stretch across a
    // desktop monitor; on phones the cap never applies.
    <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 15, lineHeight: 1.65, color: theme.text, fontFamily: font, overflowWrap: "anywhere", minWidth: 0, maxWidth: 760, ...style }}>
      <Blocks blocks={blocks} theme={theme} onCopy={onCopy} font={font} caret={inlineCaret ? caret : null} />
      {caret && !inlineCaret && <div>{caret}</div>}
    </div>
  );
});
