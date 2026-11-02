// KROFT's error log: crashes, unexpected errors and failed saves are sent to the server
// (api/log-error.js → the client_error_log table) so problems show up before anyone has to report
// them. Nothing personal is sent: emails, phone numbers, long numbers and amounts, links' query
// strings and file contents are replaced before anything leaves the device, and only the error's
// own text, where it happened and which version of KROFT is sent, never the person's data.
//
// The same error is sent once with a count, errors are sent in small batches, and a session sends
// at most MAX_DISTINCT different errors, so a loop can't flood the log or the person's data plan.

export const MAX_DISTINCT = 20;
const FLUSH_MS = 10000;

// Known noise that says nothing about KROFT: browser quirks, extensions, other sites' scripts.
const IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /chrome-extension:|moz-extension:|safari-extension:/i, /Non-Error promise rejection captured/i, /AbortError|The user aborted a request/i];

export function scrub(text, max = 300) {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(\?|#)[^\s)'"]*/g, "")                       // query strings and fragments in links
    .replace(/data:[\w/+.-]+;base64,[\w+/=]+/g, "[data]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")         // phone numbers, account numbers, amounts
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[token]")      // JWTs
    .slice(0, max);
}

// A stack trace as "function (file:line:col)" lines only, without the site's address.
export function scrubStack(stack, max = 1500) {
  return String(stack || "").split("\n").slice(0, 12)
    .map(l => scrub(l.replace(/https?:\/\/[^/\s)]+/g, ""), 200).trim())
    .filter(Boolean).join("\n").slice(0, max);
}

// A script's address as a path without the site or its query string ("/assets/index-ab12.js").
const fileOf = f => String(f || "").replace(/https?:\/\/[^/]+/, "").split(/[?#]/)[0];

// One error → the row that's sent, or null if it's noise.
export function toEntry(kind, err, extra = {}) {
  const message = scrub(err?.message ?? err?.reason?.message ?? err?.reason ?? err ?? "");
  const source = scrub(extra.source || (err?.filename ? `${fileOf(err.filename)}:${err.lineno || 0}:${err.colno || 0}` : ""), 200);
  if (!message && !source) return null;
  if (IGNORE.some(r => r.test(message) || r.test(source))) return null;
  return { kind, message, source, stack: scrubStack(extra.stack || err?.stack || err?.error?.stack || err?.reason?.stack), path: (extra.path || "").split(/[?#]/)[0].slice(0, 120) };
}

// Collects entries, counts repeats, and hands batches to send().
export function createLog({ send, now = () => Date.now(), maxDistinct = MAX_DISTINCT }) {
  const seen = new Map();   // key → entry with count
  let queue = [];
  const keyOf = e => `${e.kind}|${e.message}|${e.source}`;
  return {
    add(entry) {
      if (!entry) return false;
      const k = keyOf(entry);
      if (seen.has(k)) { seen.get(k).count++; if (!queue.includes(seen.get(k))) queue.push(seen.get(k)); return true; }
      if (seen.size >= maxDistinct) return false;
      const e = { ...entry, count: 1, at: now() };
      seen.set(k, e); queue.push(e);
      return true;
    },
    flush(beacon = false) {
      if (!queue.length) return null;
      const batch = queue.slice(0, 10).map(({ at, ...e }) => ({ ...e }));
      queue.slice(0, 10).forEach(e => { e.count = 0; });
      queue = queue.slice(10);
      send(batch, beacon);
      return batch;
    },
    pending: () => queue.length,
  };
}

let log = null;
let clientHeader = () => "";

// Records one error (from anywhere in KROFT). Safe to call before installErrorLog: then it's ignored.
export function reportError(kind, err, extra = {}) {
  try { log?.add(toEntry(kind, err, { path: location.pathname, ...extra })); } catch { /* never let logging break anything */ }
}

// Starts listening for errors. getClient: the X-Kroft-Client value (app version and device).
export function installErrorLog({ endpoint = "/api/log-error", getClient = () => "", getToken = async () => null } = {}) {
  if (typeof window === "undefined" || log) return;
  clientHeader = getClient;
  log = createLog({
    send: async (errors, beacon) => {
      const body = JSON.stringify({ client: clientHeader(), errors });
      try {
        if (beacon && navigator.sendBeacon) { navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" })); return; }
        const token = await getToken().catch(() => null);
        await fetch(endpoint, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
      } catch { /* offline: these are dropped, the next one will be caught */ }
    },
  });
  window.addEventListener("error", e => reportError("error", e.error || e, { source: e.filename ? `${fileOf(e.filename)}:${e.lineno}:${e.colno}` : "" }));
  window.addEventListener("unhandledrejection", e => reportError("promise", e.reason instanceof Error ? e.reason : { message: String(e.reason) }));
  setInterval(() => log.flush(), FLUSH_MS);
  window.addEventListener("pagehide", () => log.flush(true));
}

// For tests.
export const _internals = { get log() { return log; }, reset() { log = null; } };
