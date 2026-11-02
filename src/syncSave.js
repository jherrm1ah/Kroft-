// Saving one area of a person's data (one kv_store row) without losing what another device
// saved in the meantime. See storageShim.js for where it's used and src/merge.js for the merge.
//
// Each key remembers the server version this device last synced with: its updated_at and value.
// A save only goes through if the server's row still has that updated_at; otherwise the server's
// version is read, merged with this device's (against the last synced version), and saved again.

import { merge3 } from "./merge.js";

export const SYNCED_PREFIX = "kroft-offline-synced:";   // + userId + ":" + key -> {"at": updated_at, "v": value string}

// db: a Supabase client (or a stand-in in tests). ls: { get, set, del } over device storage.
export function createSync({ db, ls }) {
  // The server version this device last synced with, per key. Kept in memory, and on the device
  // too when it fits, so changes queued offline can still be merged after a restart.
  const synced = new Map();
  const syncedKey = (uid, key) => SYNCED_PREFIX + uid + ":" + key;
  function getSynced(uid, key) {
    const k = syncedKey(uid, key);
    if (synced.has(k)) return synced.get(k);
    try { const v = JSON.parse(ls.get(k) || "null"); if (v) synced.set(k, v); return v; } catch { return null; }
  }
  function setSynced(uid, key, at, v) {
    const k = syncedKey(uid, key), entry = { at, v };
    synced.set(k, entry);
    if (!ls.set(k, JSON.stringify(entry))) ls.del(k); // too big to keep on the device: memory only
  }

  // Saves value (a JSON string) for key, merging with whatever another device saved since this
  // device last synced. Returns { error } or { merged } (the merged JSON string, when a merge
  // happened). Without a synced version to compare against (changes queued by an older KROFT),
  // saves as before.
  //
  // synced.at is the server's updated_at for the version this device last synced with; null means
  // there was no row; "stale" means compare by reading the server's copy first.
  async function saveMerging(uid, key, value) {
    let local = JSON.parse(value);
    let mergedAny = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const base = getSynced(uid, key);
      if (!base) {
        const { data, error } = await db.from("kv_store")
          .upsert({ user_id: uid, key, value: local }, { onConflict: "user_id,key" }).select("updated_at").maybeSingle();
        if (error) return { error };
        setSynced(uid, key, data?.updated_at || null, JSON.stringify(local));
        return {};
      }
      // Only write over the version this device last synced with.
      let row = null;
      if (base.at !== "stale") {
        const write = base.at
          ? db.from("kv_store").update({ value: local }).eq("user_id", uid).eq("key", key).eq("updated_at", base.at).select("updated_at")
          : db.from("kv_store").insert({ user_id: uid, key, value: local }).select("updated_at");
        const { data, error } = await write;
        if (error && error.code !== "23505") return { error }; // 23505: another device created it first
        row = !error && (Array.isArray(data) ? data[0] : data);
      }
      if (row) {
        setSynced(uid, key, row.updated_at, JSON.stringify(local));
        return mergedAny ? { merged: JSON.stringify(local) } : {};
      }
      // Another device saved in between: merge its version with this one, then try again against it.
      const { data: remote, error: readError } = await db.from("kv_store")
        .select("value, updated_at").eq("user_id", uid).eq("key", key).maybeSingle();
      if (readError) return { error: readError };
      if (remote) {
        let baseValue;
        try { baseValue = JSON.parse(base.v); } catch { baseValue = undefined; }
        const next = merge3(baseValue, local, remote.value);
        if (JSON.stringify(next) !== JSON.stringify(local)) mergedAny = true;
        local = next;
        setSynced(uid, key, remote.updated_at, JSON.stringify(remote.value));
      } else {
        setSynced(uid, key, null, base.v);
      }
    }
    return { error: new Error("Couldn't save: the data kept changing on another device. Try again.") };
  }

  // Tells Kroft.jsx a save merged in another device's changes. It sets detail.applied when it has
  // put the merged value on screen; if not (an area it doesn't reload), the next save merges again.
  function announceMerge(uid, key, merged, local) {
    const detail = { key, value: merged, applied: false };
    try { window.dispatchEvent(new CustomEvent("kroft-storage-merged", { detail })); } catch { /* no window */ }
    // The screen still shows this device's version: compare the next save against that.
    if (!detail.applied) setSynced(uid, key, "stale", local);
  }

  const clearSynced = () => synced.clear();
  return { saveMerging, announceMerge, setSynced, getSynced, clearSynced };
}
