// Receives in-app feedback (src/feedback.js) and stores it in user_feedback with the screen it
// was sent from and the app version, so it can be read in one place. Works signed in or out.
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";
import { makeFeedback } from "../src/feedback.js";
import { ipHash, sentLastHour, LIMITS } from "./_lib/ops.js";

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const text = await req.text().catch(() => "");
  if (!text || text.length > 16000) return jsonResponse({ error: "Too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return jsonResponse({ error: "Invalid body" }, 400); }
  const f = makeFeedback({ ...body, client: req.headers.get("x-kroft-client") || body?.client });
  if (f.error) return jsonResponse({ error: f.error }, 400);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ error: "Not configured" }, 501);
  const user = await getAuthedUser(req).catch(() => null);
  const admin = supabaseAdmin();
  const hash = await ipHash(req);
  // At most LIMITS.feedback messages an hour from one device or account.
  if (await sentLastHour(admin, "user_feedback", { hash, userId: user?.id }) >= LIMITS.feedback) return jsonResponse({ error: "That's a lot of feedback in an hour. Try again later." }, 429);
  let { error } = await admin.from("user_feedback").insert({ ...f, user_id: user?.id || null, email: user?.email || null, ip_hash: hash });
  // Before the ip_hash column exists, save without it.
  if (error && /ip_hash/.test(error.message || "")) ({ error } = await admin.from("user_feedback").insert({ ...f, user_id: user?.id || null, email: user?.email || null }));
  return error ? jsonResponse({ error: "Couldn't save" }, 500) : jsonResponse({ ok: true });
}
