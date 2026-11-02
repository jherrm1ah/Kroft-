// Receives errors from the app (src/errorLog.js) and stores them in client_error_log, so problems
// show up before anyone reports them. Everything is cleaned again here (the app already cleans
// it) and cut to size; a request carries at most 10 errors. Works signed in or out; when signed
// in, the row notes who, so it's possible to see how many people an error affects.
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";
import { scrub, scrubStack } from "../src/errorLog.js";

const KINDS = new Set(["error", "promise", "crash", "save"]);

// The request body → rows to store (empty if it's not a valid report).
export function toRows(body, { userId = null, clientHeader = "" } = {}) {
  const errors = Array.isArray(body?.errors) ? body.errors.slice(0, 10) : [];
  const client = scrub(String(clientHeader || body?.client || ""), 200);
  return errors
    .filter(e => e && KINDS.has(e.kind) && (e.message || e.source))
    .map(e => ({
      user_id: userId,
      kind: e.kind,
      message: scrub(e.message, 300) || "(no message)",
      source: scrub(e.source, 200) || null,
      stack: scrubStack(e.stack) || null,
      path: String(e.path || "").split(/[?#]/)[0].slice(0, 120) || null,
      count: Math.min(1000, Math.max(1, parseInt(e.count, 10) || 1)),
      client: client || null,
    }));
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const text = await req.text().catch(() => "");
  if (!text || text.length > 32000) return jsonResponse({ error: "Too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return jsonResponse({ error: "Invalid body" }, 400); }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ ok: true, stored: 0 });
  const user = await getAuthedUser(req).catch(() => null);
  const rows = toRows(body, { userId: user?.id || null, clientHeader: req.headers.get("x-kroft-client") });
  if (!rows.length) return jsonResponse({ ok: true, stored: 0 });
  const { error } = await supabaseAdmin().from("client_error_log").insert(rows);
  return jsonResponse({ ok: !error, stored: error ? 0 : rows.length }, error ? 500 : 200);
}
