import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";

// Unlike Google, Microsoft Graph has no simple "revoke this token" REST endpoint an app can
// call server-side — the closest equivalent is the user removing this app's access themselves
// at https://myaccount.microsoft.com/consent, which this endpoint can't do on their behalf.
// Deleting the stored copy is still the meaningful part: it's what actually stops KROFT itself
// from being able to use it, which is what "disconnect" means from the app's own side.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  await supabaseAdmin().from("oauth_tokens").delete().eq("user_id", user.id).eq("provider", "microsoft");

  return jsonResponse({ ok: true });
}
