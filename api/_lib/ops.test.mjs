// Tests alerts, limits, the admin page's numbers and the 5-minute ops run. Run with: npm test
import { aiAlert, errorAlerts, feedbackAlerts, newAlerts, isAdminEmail, ipHash } from "./ops.js";
import { raiseAlerts, deliverAlerts, backupOncePerDay } from "./opsRun.js";
import { peopleCounts, activeCounts, aiSummary } from "../admin.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

// Admins.
process.env.ADMIN_EMAILS = " Owner@Example.com , second@example.com";
eq("admins come from ADMIN_EMAILS, any case", [isAdminEmail("owner@example.com"), isAdminEmail("SECOND@example.com"), isAdminEmail("someone@example.com"), isAdminEmail("")], [true, true, false, false]);

// AI failing.
const ok = { status: 200 }, bad = { status: 403, error: "upstream_403 PERMISSION_DENIED" };
eq("AI alert: 3 or more failed and at least half", [aiAlert([bad, bad, ok, ok]), aiAlert([bad, bad, bad, ok])?.key, aiAlert([bad, bad, bad, ok, ok, ok, ok])], [null, "ai-failing", null]);
eq("AI alert says why", aiAlert([bad, bad, bad]).body, "3 of the last 3 AI requests failed (upstream_403 PERMISSION_DENIED). People can't chat, talk or scan receipts.");

// Errors: several people, or a crash.
const e = (message, who, kind = "error", count = 1) => ({ kind, message, user_id: who, count });
const ea = errorAlerts([e("x broke", "a"), e("x broke", "b", "error", 4), e("x broke", "c"), e("y broke", "a"), e("y broke", "a"), e("boom", "z", "crash")]);
eq("error alerts: 3+ people or any crash", ea.map(a => [a.title, a.body]), [["An error is hitting several people", "x broke (6 times, 3 people)"], ["KROFT crashed for someone", "boom (1 time, 1 person)"]]);

// Feedback and repeats.
eq("feedback alert", feedbackAlerts([{ id: 7, kind: "idea", message: "Dark mode for PDFs", screen: "Invoices" }])[0], { key: "feedback:7", cooldown: 100000, title: "New feedback: Idea", body: "Invoices: Dark mode for PDFs" });
const now = Date.parse("2026-11-02T12:00:00Z");
const cands = [{ key: "ai-failing", cooldown: 120 }, { key: "feedback:7", cooldown: 100000 }, { key: "feedback:8", cooldown: 100000 }];
eq("an alert isn't repeated within its cooldown", newAlerts(cands, [{ key: "ai-failing", created_at: "2026-11-02T11:00:00Z" }, { key: "feedback:7", created_at: "2026-11-01T12:00:00Z" }], now).map(a => a.key), ["feedback:8"]);
eq("after the cooldown it's raised again", newAlerts(cands.slice(0, 1), [{ key: "ai-failing", created_at: "2026-11-02T09:00:00Z" }], now).length, 1);

// Device hash: stable, not the address.
const req = ip => ({ headers: new Map([["x-forwarded-for", ip]]) });
const h1 = await ipHash(req("1.2.3.4, 10.0.0.1")), h2 = await ipHash(req("1.2.3.4")), h3 = await ipHash(req("5.6.7.8"));
eq("device hash: same address same hash, never the address itself", [h1 === h2, h1 !== h3, h1.length, h1.includes("1.2.3.4"), await ipHash(req(""))], [true, true, 32, false, null]);

// Admin page numbers.
const t = Date.parse("2026-11-02T12:00:00Z");
eq("people", peopleCounts([{ created_at: "2026-11-02T08:00:00Z" }, { created_at: "2026-10-30T08:00:00Z" }, { created_at: "2026-09-01T08:00:00Z" }], t), { total: 3, new7: 2, new1: 1 });
eq("active", activeCounts([{ user_id: "a", updated_at: "2026-11-02T10:00:00Z" }, { user_id: "a", updated_at: "2026-11-01T01:00:00Z" }, { user_id: "b", updated_at: "2026-10-29T10:00:00Z" }], t), { today: 1, week: 2 });
eq("AI summary: last 24h and per day (all kinds of request added up)", aiSummary([ok, bad, ok], [{ day: "2026-11-01", requests: 5, failed: 1, est_cost_usd: 0.0012 }, { day: "2026-11-01", requests: 2, failed: 0, est_cost_usd: 0.0003 }, { day: "2026-11-02", requests: 1, failed: 1, est_cost_usd: null }]),
  { last24: { requests: 3, failed: 1, lastError: "upstream_403 PERMISSION_DENIED" }, days: [{ day: "2026-11-02", requests: 1, failed: 1, cost: 0 }, { day: "2026-11-01", requests: 7, failed: 1, cost: 0.0015 }] });

// The ops run against a stand-in database.
function fakeDb(tables) {
  const inserted = [], updated = [], rpcs = [];
  const db = {
    inserted, updated, rpcs,
    auth: { admin: { listUsers: async () => ({ data: { users: [{ id: "u-owner", email: "owner@example.com" }, { id: "u2", email: "x@y.z" }] } }) } },
    rpc: async name => { rpcs.push(name); return { data: 42, error: null }; },
    from(table) {
      const api = {
        _t: table, _filters: [],
        select() { return api; }, gt() { return api; }, eq(c, v) { api._filters.push([c, v]); return api; }, in() { return api; },
        order() { return api; }, limit() { return api; },
        insert(rowsIn) { inserted.push([table, rowsIn]); return Promise.resolve({ error: null }); },
        update(v) { return { eq: (c, id) => { updated.push([table, v, id]); return Promise.resolve({ error: null }); } }; },
        delete() { return { eq: () => Promise.resolve({}) }; },
        then(res) { const t = tables[table]; return Promise.resolve(t === undefined ? { data: null, error: { message: "missing" } } : { data: t, error: null }).then(res); },
      };
      return api;
    },
  };
  return db;
}
let db = fakeDb({ ai_request_log: [bad, bad, bad], client_error_log: [], user_feedback: [{ id: 3, kind: "problem", message: "PDF blank", screen: "Invoices" }], alert_events: [] });
eq("ops: the AI failure and new feedback become alerts", [await raiseAlerts(db), db.inserted[0][1].map(a => a.key)], [2, ["ai-failing", "feedback:3"]]);
db = fakeDb({ ai_request_log: [], client_error_log: [], user_feedback: [] });
eq("ops: before the alert table exists, nothing happens", await raiseAlerts(db), 0);
db = fakeDb({ alert_events: [{ id: 1, title: "t", body: "b" }], push_subscriptions: [] });
eq("ops: with no phone to send to, the alert is marked so (still on the admin page)", [await deliverAlerts(db), db.updated[0]], [1, ["alert_events", { delivered: -1 }, 1]]);
db = fakeDb({ kv_store_backups: [{ day: "2000-01-01" }] });
eq("ops: the backup runs when today's copy isn't there", [await backupOncePerDay(db), db.rpcs], [42, ["backup_kv_store"]]);
db = fakeDb({ kv_store_backups: [{ day: new Date().toISOString().slice(0, 10) }] });
eq("ops: and only once a day", [await backupOncePerDay(db), db.rpcs], [null, []]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
