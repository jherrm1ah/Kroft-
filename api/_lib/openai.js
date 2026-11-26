// Kroft's AI provider: OpenAI. Translates between Kroft.jsx's request/response contract (the
// Anthropic Messages shape: model/max_tokens/system/messages/stream in; content[] or
// content_block_delta SSE events out) and OpenAI's Chat Completions API, so the app's call sites
// and its stream reader don't change (see api/chat.js).
//
// OpenAI's REST shape: https://platform.openai.com/docs/api-reference/chat
//   Request:  { model, messages: [{role:"system"|"user"|"assistant", content}], max_completion_tokens, stream }
//   Response: { choices: [{ message: { content } }], usage }
//   Streaming: `data: {choices:[{delta:{content}}]}` lines, then `data: [DONE]`; with
//   stream_options.include_usage the last chunk carries the token totals.
//
// Voice: the mic fallback (src/voiceRecorder.js) sends a WAV clip with transcribe_only: true.
// That goes to OpenAI's speech-to-text endpoint and the words come back in the same reply shape.

// Model names change over time: override with OPENAI_MODEL / OPENAI_TRANSCRIBE_MODEL in Vercel
// if a default stops working (https://platform.openai.com/docs/models).
export const DEFAULT_MODEL = "gpt-4.1-mini";
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const API = "https://api.openai.com/v1";

// Reasoning models (gpt-5…, o1/o3/o4…) spend part of the token budget thinking before they
// write, so a small budget (Kroft asks for as little as 60) could come back empty. They get
// room to think on top of what Kroft asked for, and low effort by default.
export function isReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(model || "");
}

// OpenAI's own reason for refusing a request (e.g. " invalid_api_key", " insufficient_quota"),
// so the request log says why without anyone reproducing it. Codes only, never message text.
export function openaiReason(body) {
  try {
    const e = JSON.parse(body)?.error || {};
    return [e.type, e.code].filter(x => /^[a-z_]{2,60}$/.test(x || "")).map(x => ` ${x}`).join("");
  } catch { return ""; }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A message's content is a plain string, or (when the chat has an attachment, see
// buildMessageContent in Kroft.jsx) Anthropic-shaped blocks: {type:"text",text} and
// {type:"image",source:{type:"base64",media_type,data}}. Images become OpenAI image parts the
// model actually sees. Unknown blocks are skipped rather than failing the request.
export function toOpenAIContent(content) {
  if (typeof content === "string" || content == null) return String(content ?? "");
  if (!Array.isArray(content)) return String(content);
  const parts = content
    .map((block) => {
      if (block.type === "image" && block.source?.data) {
        const mime = block.source.media_type || "image/jpeg";
        return { type: "image_url", image_url: { url: `data:${mime};base64,${block.source.data}` } };
      }
      if (block.type === "text" || typeof block.text === "string") return { type: "text", text: block.text || "" };
      return null;
    })
    .filter(Boolean);
  // A message of text parts only is sent as one string (works on every model).
  return parts.every(p => p.type === "text") ? parts.map(p => p.text).join("\n") : parts;
}

export function toOpenAIRequest(body, model) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: String(body.system) });
  for (const m of body.messages || []) {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: toOpenAIContent(m.content) });
  }
  const asked = Number(body.max_tokens) || 1024;
  const req = { model, messages };
  if (isReasoningModel(model)) {
    req.max_completion_tokens = asked + 2048;
    req.reasoning_effort = process.env.OPENAI_REASONING_EFFORT || "low";
  } else {
    req.max_completion_tokens = asked;
  }
  if (body.stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return req;
}

// Token counts from an OpenAI response's usage block.
export function usageFrom(usage) {
  if (!usage) return {};
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
  };
}

// fetch with one quick retry for a dropped connection or a 5xx, inside a 20s budget: a Vercel
// Edge Function must start answering within 25s or the platform kills it with an opaque 504, so
// giving up at 20s turns that into a clear message the app can show. A 429 (rate limit) or a 4xx
// is never retried: an instant retry can't fix it.
async function fetchWithRetry(url, init) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  const startedAt = Date.now();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(url, { ...init, signal: abort.signal });
      } catch (e) {
        if (abort.signal.aborted) return { timeout: true };
        if (attempt === 0) { await new Promise(r => setTimeout(r, 500)); continue; }
        return { unreachable: true };
      }
      if (res.status >= 500 && attempt === 0 && Date.now() - startedAt < 15000) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return { res };
    }
    return { unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// The audio block of a transcription request (src/voiceRecorder.js).
function findAudio(body) {
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    const a = m.content.find(b => b?.type === "audio" && b.source?.data);
    if (a) return a.source;
  }
  return null;
}

async function transcribe(body, apiKey, report) {
  const audio = findAudio(body);
  if (!audio) return jsonResponse({ error: "No audio to transcribe" }, 400);
  const model = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const form = new FormData();
  const mime = audio.media_type || "audio/wav";
  const ext = (mime.split("/")[1] || "wav").split(";")[0];
  form.append("file", new Blob([base64ToBytes(audio.data)], { type: mime }), `clip.${ext}`);
  form.append("model", model);
  if (typeof body.language === "string" && /^[a-z]{2}$/.test(body.language)) form.append("language", body.language);
  form.append("response_format", "json");

  const { res, timeout, unreachable } = await fetchWithRetry(`${API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (timeout) { report({ model, status: 504, error: "timeout" }); return jsonResponse({ error: "The AI service is taking too long to respond. Try again in a moment." }, 504); }
  if (unreachable) { report({ model, status: 502, error: "unreachable" }); return jsonResponse({ error: "Could not reach the AI service." }, 502); }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    report({ model, status: res.status, error: `upstream_${res.status}${openaiReason(detail)}` });
    return jsonResponse({ error: "The AI service rejected the request." }, res.status);
  }
  const j = await res.json().catch(() => ({}));
  report({ model, status: 200, inputTokens: j.usage?.input_tokens ?? null, outputTokens: j.usage?.output_tokens ?? null });
  return jsonResponse({ content: [{ type: "text", text: String(j.text || "").trim() }] });
}

// onUsage, if given, is called once per request when it finishes (successfully or not) with
// { model, streamed, status, error, latencyMs, systemChars, inputTokens, outputTokens,
// thinkingTokens, cachedTokens }, for cost measurement (api/chat.js). It never throws into the
// reply.
export async function callOpenAI(rawBody, apiKey, { onUsage } = {}) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const startedAt = Date.now();
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const report = info => {
    if (!onUsage) return;
    try { onUsage({ model, streamed: !!body.stream, systemChars: (body.system || "").length, latencyMs: Date.now() - startedAt, ...info }); }
    catch { /* measurement never breaks a reply */ }
  };

  if (body.transcribe_only) return transcribe(body, apiKey, report);

  const { res: upstream, timeout, unreachable } = await fetchWithRetry(`${API}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(toOpenAIRequest(body, model)),
  });
  if (timeout) {
    report({ status: 504, error: "timeout" });
    return jsonResponse({ error: "The AI service is taking too long to respond. Try again in a moment." }, 504);
  }
  if (unreachable) {
    report({ status: 502, error: "unreachable" });
    return jsonResponse({ error: "Could not reach the AI service." }, 502);
  }

  if (!upstream.ok) {
    // OpenAI's status codes (400 bad request, 401 bad key, 429 rate limit/quota, 5xx) line up
    // with Kroft.jsx's friendlyError(status), so the status passes through unchanged.
    const detail = await upstream.text().catch(() => "");
    report({ status: upstream.status, error: `upstream_${upstream.status}${openaiReason(detail)}` });
    return jsonResponse({ error: "The AI service rejected the request." }, upstream.status);
  }

  if (!body.stream) {
    const j = await upstream.json();
    const text = j?.choices?.[0]?.message?.content || "";
    report({ status: 200, ...usageFrom(j.usage) });
    return jsonResponse({ content: [{ type: "text", text }] });
  }

  // Streaming: re-emit OpenAI's deltas as content_block_delta events, the only event Kroft.jsx's
  // reader looks for.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let usage = null;
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
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              if (chunk.usage) usage = chunk.usage;
              const text = chunk.choices?.[0]?.delta?.content;
              if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text } })}\n\n`));
            } catch {
              // A line split across reads: the buffer carries it into the next one.
            }
          }
        }
      } catch (e) {
        report({ status: 200, error: "stream_broken", ...usageFrom(usage) });
        controller.error(e);
        return;
      }
      report({ status: 200, ...usageFrom(usage) });
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
