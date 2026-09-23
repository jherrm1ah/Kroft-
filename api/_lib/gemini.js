// Translates between Kroft.jsx's Anthropic-shaped request/response contract and Google's
// Gemini API, so the frontend's six fetch("/api/chat", ...) call sites and its SSE stream
// reader don't need to change at all when the backend AI provider changes (see api/chat.js).
//
// Gemini's REST shape: https://ai.google.dev/api/generate-content
//   Request:  { contents: [{role:"user"|"model", parts:[{text}]}], systemInstruction, generationConfig }
//   Response: { candidates: [{ content: { parts: [{text}], role:"model" } }] }
//   Streaming (alt=sse): the same shape, one JSON object per `data:` line, each carrying the
//   NEW incremental text for that chunk (concatenating every chunk's text yields the full
//   reply) — the same delta-per-event semantics Kroft.jsx's SSE reader already expects from
//   Anthropic's content_block_delta events, just under different field names.

// Exact Gemini model IDs change over time (Google periodically retires older ones) — override
// via GEMINI_MODEL in Vercel if this default 404s by the time you deploy; check
// https://ai.google.dev/gemini-api/docs/models for the current list.
// gemini-2.5-flash was retired ("no longer available to new users"); Google's own 404 error
// pointed at gemini-3.6-flash as its replacement.
const DEFAULT_MODEL = "gemini-3.6-flash";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toGeminiRequest(anthropicBody) {
  const contents = (anthropicBody.messages || []).map((m) => ({
    // Anthropic's roles are "user"/"assistant"; Gemini's are "user"/"model" for the exact same
    // two turns — everything else about a message (just a role + text) carries over untouched.
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: anthropicBody.max_tokens || 1024 },
  };
  if (anthropicBody.system) body.systemInstruction = { parts: [{ text: anthropicBody.system }] };
  return body;
}

function extractText(geminiChunk) {
  return geminiChunk?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

export async function callGemini(rawBody, apiKey) {
  let anthropicBody;
  try {
    anthropicBody = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const isStreaming = !!anthropicBody.stream;
  const geminiBody = toGeminiRequest(anthropicBody);
  const method = isStreaming ? "streamGenerateContent" : "generateContent";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}${isStreaming ? "?alt=sse" : ""}`;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    return jsonResponse({ error: "Could not reach the AI service." }, 502);
  }

  if (!upstream.ok) {
    // Gemini's status codes (400 malformed request, 403 bad key, 429 rate limit, 5xx) line up
    // with what Kroft.jsx's friendlyError(status) already branches on, so the status passes
    // through unchanged; only the body differs; friendlyError never reads it.
    const detail = await upstream.text().catch(() => "");
    return jsonResponse({ error: "The AI service rejected the request.", detail }, upstream.status);
  }

  if (!isStreaming) {
    const geminiJson = await upstream.json();
    const text = extractText(geminiJson);
    // Anthropic's non-streaming shape: { content: [{ type:"text", text }] } — Kroft.jsx does
    // data.content?.map(b => b.text||"").join(""), so a single block is all this needs.
    return jsonResponse({ content: [{ type: "text", text }] });
  }

  // Streaming: re-emit Gemini's SSE as Anthropic-shaped SSE (content_block_delta / delta.text)
  // as each chunk arrives, since that's the only event type Kroft.jsx's reader looks for —
  // it silently ignores anything else, so no other Anthropic event types need emulating.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const text = extractText(JSON.parse(payload));
              if (text) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text } })}\n\n`)
                );
              }
            } catch {
              // Partial JSON split across a chunk boundary — the buffer above carries the
              // trailing incomplete line into the next read, same tolerance Kroft.jsx's own
              // SSE reader already has for this exact situation.
            }
          }
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
