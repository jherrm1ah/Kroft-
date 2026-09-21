import { createClient } from "@supabase/supabase-js";

// VITE_-prefixed env vars are inlined into the client bundle at build time by
// Vite (see https://vitejs.dev/guide/env-and-mode.html) — this is expected
// and safe here: the anon/publishable key is meant to be public, and every
// table it can reach is protected by row-level security (see
// supabase/schema.sql), not by keeping this key secret.
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  // Loud in dev, non-fatal in prod — storageShim.js falls back to
  // localStorage-only mode when this is null, so a missing config doesn't
  // crash the app, it just quietly loses cross-device sync and real auth.
  console.warn(
    "[Kroft] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — " +
      "falling back to local-only storage and no real authentication. " +
      "See .env.example."
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
