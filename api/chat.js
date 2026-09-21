// Vercel Edge Function: proxies Kroft's AI calls to Anthropic's Messages API.
//
// Kroft.jsx was originally built to run inside a sandbox host that intercepts
// fetch("https://api.anthropic.com/v1/messages", ...) calls and injects real
// credentials transparently, the same way it injects window.storage. Outside
// that host, those calls can't work at all: the API requires an x-api-key
// header the client never sends, and even with one, browsers can't call
// api.anthropic.com directly (CORS). This endpoint is what the frontend
// calls instead — same-origin, so no CORS issue — with the real API key
// added server-side from an environment variable, never shipped to the
// browser.
//
// Runs on the Edge runtime (not the default Node serverless runtime)
// specifically so the response can be streamed straight through: Kroft's
// main chat sends { stream: true } and reads Anthropic's raw
// server-sent-events off the response body itself. Buffering that in a
// standard Node function would break streaming and delay the whole reply
// until it's fully generated. The five non-streaming call sites (briefing,
// monthly report, smart reminders, email drafts, location naming) get the
// same treatment; a single small JSON body streams through just as easily
// as a long one and needs no special-casing here.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Missing config, not a bad request — mirrors friendlyError()'s 401/403
    // branch in Kroft.jsx ("I couldn't authenticate with the AI service.")
    // rather than surfacing a generic network failure.
    return new Response(
      JSON.stringify({ error: "Server is not configured with an ANTHROPIC_API_KEY." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let body;
  try {
    body = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
  } catch {
    return new Response(JSON.stringify({ error: "Could not reach the AI service." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pass the upstream response straight through: same status, same body
  // (streamed, not buffered), same content type — so nothing downstream in
  // Kroft.jsx (JSON parsing or the SSE reader) needs to change.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
    },
  });
}
