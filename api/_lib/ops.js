// Keeping an eye on KROFT: who counts as an admin, the health checks that raise alerts, and the
// per-device limits on the feedback and error-log endpoints. Shared by api/cron/deliver-
// notifications.js (checks, alerts, backup), api/admin.js and the endpoints. The decisions are
// pure functions so they can be tested; the database calls are thin wrappers around them.

// Admins: the emails in ADMIN_EMAILS (comma-separated), set in Vercel. Nobody otherwise.
export const adminEmails = () => (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = email => !!email && adminEmails().includes(String(email).toLowerCase());

// ── Health checks → alerts ──
// AI failing: in the last 15 minutes, at least 3 requests failed and at least half did.
export function aiAlert(recent) {
  const failed = recent.filter(r => r.status !== 200);
  if (failed.length < 3 || failed.length * 2 < recent.length) return null;
  const reasons = [...new Set(failed.map(r => r.error).filter(Boolean))].slice(0, 2).join(", ");
  return { key: "ai-failing", cooldown: 120, title: "KROFT's AI is failing", body: `${failed.length} of the last ${recent.length} AI requests failed${reasons ? ` (${reasons})` : ""}. People can't chat, talk or scan receipts.` };
}

// An error several people hit in the last hour, or any crash.
export function errorAlerts(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.kind}|${r.message}`;
    if (!groups.has(k)) groups.set(k, { kind: r.kind, message: r.message, people: new Set(), times: 0 });
    const g = groups.get(k);
    g.times += r.count || 1;
    g.people.add(r.user_id || r.ip_hash || "anon");
  }
  return [...groups.values()]
    .filter(g => g.kind === "crash" || g.people.size >= 3)
    .map(g => ({ key: `error:${g.kind}:${g.message.slice(0, 80)}`, cooldown: 360, title: g.kind === "crash" ? "KROFT crashed for someone" : "An error is hitting several people", body: `${g.message.slice(0, 140)} (${g.times} time${g.times === 1 ? "" : "s"}, ${g.people.size} ${g.people.size === 1 ? "person" : "people"})` }));
}

const KIND = { problem: "Something's wrong", idea: "Idea", praise: "Praise" };
export function feedbackAlerts(rows) {
  return rows.map(f => ({ key: `feedback:${f.id}`, cooldown: 100000, title: `New feedback: ${KIND[f.kind] || "Feedback"}`, body: `${f.screen ? `${f.screen}: ` : ""}${String(f.message).slice(0, 140)}` }));
}

// Alerts not already raised within their cooldown (recent: [{ key, created_at }]).
export function newAlerts(candidates, recent, now = Date.now()) {
  return candidates.filter(a => !recent.some(r => r.key === a.key && now - new Date(r.created_at).getTime() < a.cooldown * 60000));
}

// ── Limits ──
// A one-way hash of the sender's address, so the endpoints can count per device without
// storing the address.
export async function ipHash(req) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "").split(",")[0].trim();
  if (!ip) return null;
  const data = new TextEncoder().encode(`${ip}|${(process.env.SUPABASE_SERVICE_ROLE_KEY || "kroft").slice(-24)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

// How many rows this device (or account) added to table in the last hour; 0 if it can't tell.
export async function sentLastHour(admin, table, { hash, userId }) {
  if (!hash && !userId) return 0;
  const since = new Date(Date.now() - 3600000).toISOString();
  let q = admin.from(table).select("id", { count: "exact", head: true }).gt("created_at", since);
  q = hash && userId ? q.or(`ip_hash.eq.${hash},user_id.eq.${userId}`) : hash ? q.eq("ip_hash", hash) : q.eq("user_id", userId);
  const { count, error } = await q;
  return error ? 0 : count || 0;   // can't count (e.g. before the columns exist): don't block
}
export const LIMITS = { feedback: 10, errors: 100 };
