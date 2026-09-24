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

// A message's content is normally a plain string, but Kroft.jsx's chat attach feature (see
// buildMessageContent there) sends Anthropic-shaped content BLOCKS instead when the message
// carries an image: [{type:"text",text}, {type:"image",source:{type:"base64",media_type,data}}].
// Text blocks become Gemini's {text} part; image blocks become {inlineData}, Gemini's own
// inline-image-in-a-turn shape — a real image part the model actually sees, not a text mention
// of one. An unrecognized block type is skipped rather than crashing the request.
function toGeminiParts(content) {
  if (typeof content === "string" || content == null) return [{ text: String(content ?? "") }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  return content
    .map((block) => {
      if (block.type === "image" && block.source?.data) {
        return { inlineData: { mimeType: block.source.media_type || "application/octet-stream", data: block.source.data } };
      }
      if (block.type === "text" || typeof block.text === "string") return { text: block.text || "" };
      return null;
    })
    .filter(Boolean);
}

function toGeminiRequest(anthropicBody) {
  const contents = (anthropicBody.messages || []).map((m) => ({
    // Anthropic's roles are "user"/"assistant"; Gemini's are "user"/"model" for the exact same
    // two turns — everything else about a message (just a role + text/image parts) carries over
    // untouched.
    role: m.role === "assistant" ? "model" : "user",
    parts: toGeminiParts(m.content),
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

  // Gemini's shared free/low-tier capacity throws a transient 503 ("model overloaded") often
  // enough in practice that surfacing it straight to the user reads as "the AI is broken" for
  // something that a single immediate retry usually clears on its own. One retry only, and only
  // for 503/a dropped connection — a 429 is a real rate limit an instant retry won't fix, and
  // every other status (400 malformed, 403 bad key, 404 unknown model) is not transient at all.
  //
  // Separately: a Vercel Edge Function must send an initial response within 25s, or the platform
  // kills it outright with an opaque, non-JSON 504 — no friendly message, nothing Kroft.jsx's own
  // error handling ever sees, exactly what a live request hit when Gemini was just slow to start
  // responding (not erroring, just slow — no status code to retry on). Aborting our own fetch at
  // 20s, before the platform's hard cutoff, turns that into the same clear "AI service having
  // trouble" JSON response every other failure already gets.
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), 20000);
  const startedAt = Date.now();

  let upstream;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        upstream = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(geminiBody),
          signal: abortController.signal,
        });
      } catch (e) {
        if (abortController.signal.aborted) throw e; // handled by the outer catch below
        if (attempt === 0) { await new Promise(r => setTimeout(r, 500)); continue; }
        return jsonResponse({ error: "Could not reach the AI service." }, 502);
      }
      // Only worth retrying a 503 if there's still real time left in the 20s budget — no point
      // retrying into a timeout we're about to hit anyway.
      if (upstream.status === 503 && attempt === 0 && Date.now() - startedAt < 15000) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }
  } catch {
    return jsonResponse({ error: "The AI service is taking too long to respond. Try again in a moment." }, 504);
  } finally {
    clearTimeout(abortTimer);
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
