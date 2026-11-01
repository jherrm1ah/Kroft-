// Lightweight syntax colouring for code blocks: comments, strings, numbers and keywords. Enough
// to make code readable at a glance without shipping a full highlighter to low-end phones.

const KEYWORDS = new Set(`
  abstract and as async await break case catch class const continue def default del delete do elif
  else enum except export extends false final finally fn for from func function go if impl import in
  instanceof interface is lambda let match mod mut new nil none not null or package pass private
  protected pub public raise return self static struct super switch this throw throws true try type
  typeof undefined use var void while with yield None True False select from where join on group by
  order insert into values update set create table drop alter limit and or not null as distinct
  echo then fi done esac local readonly
`.trim().split(/\s+/));

const HASH_COMMENT = new Set(["py", "python", "sh", "bash", "shell", "zsh", "yaml", "yml", "rb", "ruby", "r", "toml", "dockerfile", "make", "makefile", "ini", "conf", "ps1", "powershell"]);
const DASH_COMMENT = new Set(["sql", "lua", "haskell", "hs"]);

function tokenRegex(lang) {
  const comment = HASH_COMMENT.has(lang) ? String.raw`#[^\n]*`
    : DASH_COMMENT.has(lang) ? String.raw`--[^\n]*`
    : lang === "html" || lang === "xml" ? String.raw`<!--[\s\S]*?-->`
    : String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`;
  return new RegExp([
    `(${comment})`,
    String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\`\\])*\`)`,
    String.raw`(\b\d+(?:\.\d+)?\b)`,
    String.raw`([A-Za-z_$][\w$]*)`,
  ].join("|"), "g");
}

export function highlight(code, lang, theme) {
  const l = (lang || "").toLowerCase();
  // Prose-like or unknown formats are left plain rather than painted at random.
  if (!l || ["text", "txt", "plain", "markdown", "md", "csv"].includes(l)) return code;
  const re = tokenRegex(l);
  const out = [];
  let last = 0, m, k = 0;
  while ((m = re.exec(code))) {
    const [all, comment, str, num, word] = m;
    let color = null;
    if (comment) color = theme.muted;
    else if (str) color = theme.positive;
    else if (num) color = theme.warning;
    else if (word && KEYWORDS.has(word)) color = theme.accent;
    if (!color) continue;
    if (m.index > last) out.push(code.slice(last, m.index));
    out.push(<span key={k++} style={{ color, fontStyle: comment ? "italic" : undefined }}>{all}</span>);
    last = m.index + all.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
