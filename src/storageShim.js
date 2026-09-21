import { supabase, isSupabaseConfigured } from "./supabaseClient.js";

// Kroft.jsx targets a sandbox host that injects a `window.storage` API
// (get/set, each returning a Promise) as its only persistence layer, and
// deliberately avoids localStorage/sessionStorage as a fallback (see the
// comment above the persistence effects in Kroft.jsx). This shim installs a
// drop-in implementation, but only if a real window.storage isn't already
// present — so it's a no-op inside the original sandbox and never shadows
// the host's own implementation.
//
// Backing store, in priority order:
//   1. Supabase's public.kv_store table (see supabase/schema.sql), scoped to
//      the signed-in user via RLS — when VITE_SUPABASE_URL/ANON_KEY are set
//      AND a user is actually signed in. This is real, server-side,
//      per-account, multi-device persistence.
//   2. localStorage — when Supabase isn't configured, or no one is signed
//      in yet (e.g. the signup/login screens read/write "profile" data
//      before any account exists; there's no auth.uid() to scope a Supabase
//      row to at that point). Every call site in Kroft.jsx already treats a
//      storage failure as "nothing saved yet" (try/catch on get, .catch on
//      set), so falling through silently here is safe and expected.
if (typeof window !== "undefined" && !window.storage) {
  const localGet = (key) => {
    try {
      const value = window.localStorage.getItem(key);
      return { value: value == null ? undefined : value };
    } catch {
      return { value: undefined };
    }
  };
  const localSet = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  window.storage = {
    async get(key) {
      if (!isSupabaseConfigured) return localGet(key);
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (!user) return localGet(key);
      const { data, error } = await supabase
        .from("kv_store")
        .select("value")
        .eq("user_id", user.id)
        .eq("key", key)
        .maybeSingle();
      if (error) throw error; // caught by every call site already
      // kv_store.value is jsonb; every caller does JSON.parse(r.value), so
      // this re-serializes to keep that contract identical regardless of
      // which backing store answered.
      return { value: data ? JSON.stringify(data.value) : undefined };
    },
    async set(key, value) {
      if (!isSupabaseConfigured) return localSet(key, value);
      const { data: { user } = {} } = await supabase.auth.getUser();
      // No signed-in user yet (e.g. mid-signup, before the account exists
      // server-side) — fall back to localStorage rather than dropping the
      // write entirely, so nothing typed before auth completes is lost.
      if (!user) return localSet(key, value);
      const { error } = await supabase
        .from("kv_store")
        .upsert({ user_id: user.id, key, value: JSON.parse(value) }, { onConflict: "user_id,key" });
      if (error) throw error;
      return { ok: true };
    },
  };
}
