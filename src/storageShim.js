import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { createSync, SYNCED_PREFIX } from "./syncSave.js";

// Kroft.jsx targets a sandbox host that injects a `window.storage` API
// (get/set, each returning a Promise) as its only persistence layer. This shim
// installs a drop-in implementation, but only if a real window.storage isn't
// already present — so it's a no-op inside the original sandbox and never
// shadows the host's own implementation.
//
// Backing store:
//   1. Supabase's public.kv_store table (see supabase/schema.sql), scoped to
//      the signed-in user via RLS — when Supabase is configured AND someone is
//      signed in. Real, server-side, per-account, multi-device persistence.
//   2. localStorage — when Supabase isn't configured, or no one is signed in
//      yet (the signup screens write "profile" data before any account exists).
//
// Offline (Supabase mode): every successful read and write also keeps a copy
// on this device, per account. With no connection, reads are answered from
// that copy and writes are saved to it and queued; the queue is sent the next
// time the device is online. A key that couldn't be read at all (offline and
// never cached here) is marked unreadable and refuses writes until it has been
// read for real, so an empty starting state can never be saved over the
// person's real data.
//
// Two devices at once: each key remembers the server version this device last synced with
// (its value and updated_at). A save only goes through if the server's copy is still that
// version; if another device saved in between, the two versions are merged against it
// (src/merge.js), the merged value is saved, and Kroft.jsx is told ("kroft-storage-merged") so
// the screen shows both devices' changes. Nothing either device saved is silently overwritten.

const COPY = "kroft-offline:";            // + userId + ":" + key -> JSON string
const PENDING = "kroft-offline-pending:"; // + userId -> JSON array of keys
const LAST_USER = "kroft-offline-user";   // the account this device last had open

const ls = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
};

const isNetworkError = err => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = `${err?.message || ""} ${err?.details || ""}`;
  return err instanceof TypeError || /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
};

const unreadable = new Set();

// Saving that merges with other devices' changes (src/syncSave.js).
const { saveMerging, announceMerge, setSynced, clearSynced } = createSync({ db: supabase, ls });

let flushing = null;

// The signed-in account's id, read from the locally stored session (no network round trip, which
// also makes every read and write faster). Row-level security still enforces access on the server.
async function currentUserId() {
  try {
    const { data } = await supabase.auth.getSession();
    const id = data?.session?.user?.id || null;
    if (id) ls.set(LAST_USER, id);
    return id;
  } catch {
    return null;
  }
}

// Offline with an expired access token, Supabase can't refresh the session, but the person is
// still the one who was last signed in on this device. Their device copy is the right thing to show.
export function offlineUserId() {
  return typeof navigator !== "undefined" && navigator.onLine === false ? ls.get(LAST_USER) : null;
}

const pendingKeys = uid => { try { return JSON.parse(ls.get(PENDING + uid) || "[]"); } catch { return []; } };
const setPending = (uid, keys) => (keys.length ? ls.set(PENDING + uid, JSON.stringify(keys)) : ls.del(PENDING + uid));

export function hasUnsyncedChanges() {
  const uid = ls.get(LAST_USER);
  return !!uid && pendingKeys(uid).length > 0;
}

// Sends every change made offline. Safe to call any time; concurrent calls share one run.
export function flushPending() {
  if (!isSupabaseConfigured) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    const uid = await currentUserId();
    if (!uid) return;
    for (const key of pendingKeys(uid)) {
      const copy = ls.get(COPY + uid + ":" + key);
      if (copy == null) { setPending(uid, pendingKeys(uid).filter(k => k !== key)); continue; }
      const { error, merged } = await saveMerging(uid, key, copy);
      if (error) break; // still offline, or the server refused: keep the queue for next time
      setPending(uid, pendingKeys(uid).filter(k => k !== key));
      if (merged) { ls.set(COPY + uid + ":" + key, merged); announceMerge(uid, key, merged, copy); }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// Forgets everything this device kept for offline use (on log out and account deletion).
export function clearOfflineData() {
  unreadable.clear();
  clearSynced();
  try {
    Object.keys(window.localStorage)
      .filter(k => k.startsWith(COPY) || k.startsWith(PENDING) || k.startsWith(SYNCED_PREFIX) || k === LAST_USER)
      .forEach(k => window.localStorage.removeItem(k));
  } catch { /* storage unavailable: nothing kept */ }
}

// Keys that couldn't be read this session. Kroft.jsx reloads its data when these become readable.
export const unreadableKeys = () => [...unreadable];

if (typeof window !== "undefined" && !window.storage) {
  const localGet = key => {
    const value = ls.get(key);
    return { value: value == null ? undefined : value };
  };
  const localSet = (key, value) => ({ ok: ls.set(key, value) });

  window.storage = {
    async get(key) {
      if (!isSupabaseConfigured) return localGet(key);
      const uid = (await currentUserId()) || offlineUserId();
      if (!uid) return localGet(key);
      const copyKey = COPY + uid + ":" + key;
      // A change made offline that hasn't reached the server yet is newer than the server's copy.
      if (pendingKeys(uid).includes(key)) {
        flushPending();
        unreadable.delete(key);
        return { value: ls.get(copyKey) ?? undefined };
      }
      const { data, error } = await supabase.from("kv_store")
        .select("value, updated_at").eq("user_id", uid).eq("key", key).maybeSingle();
      if (error) {
        if (!isNetworkError(error)) throw error;
        const copy = ls.get(copyKey);
        if (copy != null) return { value: copy };
        unreadable.add(key);
        throw error; // caught by every call site: "nothing loaded" — and set() is now blocked
      }
      unreadable.delete(key);
      const value = data ? JSON.stringify(data.value) : undefined;
      if (value === undefined) ls.del(copyKey); else ls.set(copyKey, value);
      setSynced(uid, key, data ? data.updated_at : null, value === undefined ? "null" : value);
      return { value };
    },

    async set(key, value) {
      if (!isSupabaseConfigured) return localSet(key, value);
      const uid = (await currentUserId()) || offlineUserId();
      // No signed-in user yet (e.g. mid-signup, before the account exists
      // server-side) — fall back to localStorage so nothing typed is lost.
      if (!uid) return localSet(key, value);
      if (unreadable.has(key)) {
        // Never write a value we couldn't first read: it would be the app's empty starting state.
        throw new Error(`"${key}" hasn't loaded yet, so it can't be saved over.`);
      }
      const copyKey = COPY + uid + ":" + key;
      ls.set(copyKey, value); // may fail for very large values (e.g. files); then only the server has it
      const { error, merged } = await saveMerging(uid, key, value);
      if (error) {
        if (!isNetworkError(error)) throw error;
        if (ls.get(copyKey) !== value) throw error; // too large to keep offline: report the failure
        setPending(uid, [...new Set([...pendingKeys(uid), key])]);
        return { ok: true, queued: true };
      }
      setPending(uid, pendingKeys(uid).filter(k => k !== key));
      if (merged) { ls.set(copyKey, merged); announceMerge(uid, key, merged, value); return { ok: true, merged: true }; }
      return { ok: true };
    },
  };

  window.addEventListener("online", () => { flushPending(); });
}
