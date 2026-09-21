// Calls Anthropic's Messages API directly with the client's Anthropic-shaped request body
// (model, max_tokens, system, messages, stream) — this is Kroft's original AI provider,
// kept as a fallback so switching back later (see api/chat.js) is just a Vercel env var
// change, not a code change.
export async function callAnthropic(rawBody, apiKey) {
  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: rawBody,
    });
  } catch {
    return new Response(JSON.stringify({ error: "Could not reach the AI service." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pass the upstream response straight through: same status, same body (streamed, not
  // buffered), same content type — so nothing downstream in Kroft.jsx (JSON parsing or the
  // SSE reader) needs to change. Anthropic's response is already exactly the shape Kroft.jsx
  // expects, unlike Gemini's (see gemini.js), since this is the API it was originally written
  // against.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
  });
}
