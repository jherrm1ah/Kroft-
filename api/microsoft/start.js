import { getAuthedUser, jsonResponse } from "../_lib/supabaseAdmin.js";
import { signState } from "../_lib/oauthState.js";
import { buildMicrosoftAuthUrl } from "../_lib/microsoft.js";

// Mirrors api/google/start.js exactly, against Microsoft's OAuth endpoints instead — see that
// file's comments for the reasoning behind the signed-state approach.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  // ?app=1: started from the Android app, so the callback returns there (com.orynthra.kroft://)
  // instead of to the website. Carried inside the signed state so it can't be tampered with.
  const app = new URL(req.url).searchParams.get("app") === "1";
  const state = await signState({ uid: user.id, exp: Date.now() + 10 * 60 * 1000, ...(app ? { app: true } : {}) });
  const redirectUri = `${new URL(req.url).origin}/api/microsoft/callback`;
  return jsonResponse({ url: buildMicrosoftAuthUrl(redirectUri, state) });
}
