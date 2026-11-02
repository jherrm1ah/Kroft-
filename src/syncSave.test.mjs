// Tests saving from two devices at once against a stand-in for the kv_store table. Run with: npm test
import { createSync } from "./syncSave.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

// A tiny kv_store: rows by user+key, updated_at changes on every write (like the real trigger).
function fakeDb() {
  const rows = new Map();
  let clock = 0;
  const stamp = () => `2026-11-02T00:00:${String(++clock).padStart(2, "0")}.000000+00:00`;
  const db = {
    rows, writes: 0,
    from() {
      const q = { filters: {}, op: null, payload: null };
      const api = {
        select(cols) { if (!q.op) q.op = "select"; q.cols = cols; return api; },
        eq(col, v) { q.filters[col] = v; return api; },
        update(p) { q.op = "update"; q.payload = p; return api; },
        insert(p) { q.op = "insert"; q.payload = p; return api; },
        upsert(p) { q.op = "upsert"; q.payload = p; return api; },
        maybeSingle() { q.single = true; return api; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      const k = p => `${p.user_id}|${p.key}`;
      function run() {
        if (q.op === "select") {
          const r = rows.get(k(q.filters));
          return { data: r ? { value: structuredClone(r.value), updated_at: r.updated_at } : null, error: null };
        }
        if (q.op === "update") {
          const r = rows.get(k(q.filters));
          if (!r || r.updated_at !== q.filters.updated_at) return { data: [], error: null };
          r.value = structuredClone(q.payload.value); r.updated_at = stamp(); db.writes++;
          return { data: [{ updated_at: r.updated_at }], error: null };
        }
        if (q.op === "insert") {
          if (rows.has(k(q.payload))) return { data: null, error: { code: "23505" } };
          const r = { value: structuredClone(q.payload.value), updated_at: stamp() }; rows.set(k(q.payload), r); db.writes++;
          return { data: [{ updated_at: r.updated_at }], error: null };
        }
        if (q.op === "upsert") {
          const r = { value: structuredClone(q.payload.value), updated_at: stamp() }; rows.set(k(q.payload), r); db.writes++;
          return { data: { updated_at: r.updated_at }, error: null };
        }
      }
      return api;
    },
  };
  return db;
}
const memLs = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => (m.set(k, v), true), del: k => m.delete(k) }; };

// A device: reads like storageShim.get does (remembering the synced version), saves with saveMerging.
function device(db) {
  const s = createSync({ db, ls: memLs() });
  return {
    ...s,
    async load(uid, key) {
      const { data } = await db.from("kv_store").select("value, updated_at").eq("user_id", uid).eq("key", key).maybeSingle();
      const value = data ? JSON.stringify(data.value) : undefined;
      s.setSynced(uid, key, data ? data.updated_at : null, value ?? "null");
      return data ? data.value : null;
    },
    save: (uid, key, obj) => s.saveMerging(uid, key, JSON.stringify(obj)),
  };
}
const server = (db, key = "kroft:finance") => db.rows.get(`u1|${key}`)?.value;

const db = fakeDb();
const start = { expenses: [{ id: 1, label: "Rent", amount: 50 }], income: [] };
await db.from("kv_store").upsert({ user_id: "u1", key: "kroft:finance", value: start });

const phone = device(db), web = device(db);
const p0 = await phone.load("u1", "kroft:finance");
const w0 = await web.load("u1", "kroft:finance");

// Phone adds an expense: nothing else changed, a plain save.
let r = await phone.save("u1", "kroft:finance", { ...p0, expenses: [...p0.expenses, { id: 2, label: "Fuel", amount: 20 }] });
eq("a save with nothing changed elsewhere: plain write, no merge", [r.error, r.merged], [undefined, undefined]);

// The website, still showing the old data, adds income: merged, the phone's expense survives.
r = await web.save("u1", "kroft:finance", { ...w0, income: [{ id: 9, label: "Gift", amount: 40 }] });
eq("the website's save merges in the phone's expense", [!!r.merged, server(db).expenses.map(x => x.id), server(db).income.map(x => x.id)], [true, [1, 2], [9]]);
eq("and hands back the merged data for the screen", JSON.parse(r.merged).expenses.length, 2);

// The phone saves again without having seen the website's income: still kept.
r = await phone.save("u1", "kroft:finance", { ...p0, expenses: [{ id: 1, label: "Rent", amount: 55 }, { id: 2, label: "Fuel", amount: 20 }] });
eq("the phone's next save keeps the website's income and its own edit", [server(db).income.map(x => x.id), server(db).expenses[0].amount], [[9], 55]);

// A delete on one device, while the other device only added something.
const pNow = await phone.load("u1", "kroft:finance");
const wNow = await web.load("u1", "kroft:finance");
await web.save("u1", "kroft:finance", { ...wNow, expenses: wNow.expenses.filter(x => x.id !== 2) });
await phone.save("u1", "kroft:finance", { ...pNow, income: [...pNow.income, { id: 10, label: "Sale", amount: 5 }] });
eq("a delete on one device and an add on the other both stick", [server(db).expenses.map(x => x.id), server(db).income.map(x => x.id)], [[1], [9, 10]]);

// The screen didn't take the merged data ("stale"): the next save merges again rather than overwriting.
const lone = device(db);
const l0 = await lone.load("u1", "kroft:finance");
await phone.save("u1", "kroft:finance", { ...(await phone.load("u1", "kroft:finance")), income: [...server(db).income, { id: 11, label: "Tip", amount: 1 }] });
lone.setSynced("u1", "kroft:finance", "stale", JSON.stringify(l0));
await lone.save("u1", "kroft:finance", { ...l0, expenses: [...l0.expenses, { id: 3, label: "Ink", amount: 2 }] });
eq("after a merge the screen didn't show, nothing is lost", [server(db).income.map(x => x.id), server(db).expenses.map(x => x.id)], [[9, 10, 11], [1, 3]]);

// A brand-new key created on two devices at once.
const a = device(db), b = device(db);
await a.load("u1", "kroft:projects"); await b.load("u1", "kroft:projects");
await a.save("u1", "kroft:projects", { projects: [{ id: "p1", name: "Shop" }] });
r = await b.save("u1", "kroft:projects", { projects: [{ id: "p2", name: "Site" }] });
eq("created on two devices at once: both kept", server(db, "kroft:projects").projects.map(x => x.id).sort(), ["p1", "p2"]);

// Changes saved by an older KROFT with nothing to compare against: saved as before.
const old = device(db);
r = await old.save("u1", "kroft:notes-old", { a: 1 });
eq("no synced version: a plain save", [r.error, server(db, "kroft:notes-old")], [undefined, { a: 1 }]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
