// Tests for api/_lib/openai.js against a fake OpenAI (global fetch): the reply shape Kroft.jsx
// expects, streaming, images, voice notes, errors and token reporting. Run with: npm test
const { callOpenAI, toOpenAIRequest, toOpenAIContent, usageFrom, openaiReason, isReasoningModel, DEFAULT_MODEL } = await import("./openai.js");
let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const strip = u => { const { latencyMs, ...rest } = u; return { ...rest, latencyOk: latencyMs >= 0 }; };
const usage = { prompt_tokens: 5200, completion_tokens: 310, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 4096 } };

eq("usageFrom maps OpenAI's field names", usageFrom(usage), { inputTokens: 5200, outputTokens: 310, thinkingTokens: 0, cachedTokens: 4096 });
eq("usageFrom with nothing", usageFrom(undefined), {});
eq("error codes only", openaiReason(JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided: sk-abc" } })), " invalid_request_error invalid_api_key");
eq("reasoning models detected", [isReasoningModel("gpt-5-mini"), isReasoningModel("o4-mini"), isReasoningModel("gpt-4.1-mini")], [true, true, false]);

// Request translation
{
  const req = toOpenAIRequest({ system: "Be brief", max_tokens: 60, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }, "gpt-4.1-mini");
  eq("system becomes the first message, roles kept", req.messages, [{ role: "system", content: "Be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  eq("token budget passed through", req.max_completion_tokens, 60);
  eq("no streaming fields when not streaming", [req.stream, req.stream_options], [undefined, undefined]);
  const r5 = toOpenAIRequest({ max_tokens: 60, messages: [] }, "gpt-5-mini");
  eq("reasoning model gets room to think and low effort", [r5.max_completion_tokens, r5.reasoning_effort], [2108, "low"]);
  eq("reply size capped", [toOpenAIRequest({ max_tokens: 999999, messages: [] }, "gpt-4.1-mini").max_completion_tokens, toOpenAIRequest({ max_tokens: -5, messages: [] }, "gpt-4.1-mini").max_completion_tokens], [4096, 1]);
  const rs = toOpenAIRequest({ stream: true, messages: [] }, "gpt-4.1-mini");
  eq("streaming asks for usage", [rs.stream, rs.stream_options], [true, { include_usage: true }]);
}
eq("image block becomes an image part", toOpenAIContent([{ type: "text", text: "What is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]),
  [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
eq("text-only blocks become one string", toOpenAIContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");

// Non-streaming reply in the shape Kroft.jsx reads
{
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage }), { status: 200 }); };
  const seen = [];
  const res = await callOpenAI(JSON.stringify({ system: "abcdef", messages: [{ role: "user", content: "hi" }] }), "sk-test", { onUsage: u => seen.push(u) });
  eq("reply in Kroft's shape", await res.json(), { content: [{ type: "text", text: "Hello" }] });
  eq("chat completions endpoint", sent.url, "https://api.openai.com/v1/chat/completions");
  eq("key sent as a bearer token, server side", sent.init.headers.Authorization, "Bearer sk-test");
  eq("default model", JSON.parse(sent.init.body).model, DEFAULT_MODEL);
  eq("one usage report", seen.map(strip), [{ model: DEFAULT_MODEL, streamed: false, systemChars: 6, status: 200, inputTokens: 5200, outputTokens: 310, thinkingTokens: 0, cachedTokens: 4096, latencyOk: true }]);
}

// Streaming: deltas become content_block_delta events; usage from the final chunk
{
  const chunks = [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [], usage },
  ];
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const seen = [];
  const res = await callOpenAI(JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }), "k", { onUsage: u => seen.push(u) });
  const text = await res.text();
  const deltas = [...text.matchAll(/^data: (.*)$/gm)].map(m => JSON.parse(m[1]).delta.text).join("");
  eq("streamed reply", deltas, "Hello");
  eq("streamed: one report with the final totals", seen.map(strip), [{ model: DEFAULT_MODEL, streamed: true, systemChars: 0, status: 200, inputTokens: 5200, outputTokens: 310, thinkingTokens: 0, cachedTokens: 4096, latencyOk: true }]);
}

// Voice notes go to speech-to-text and come back as text
{
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ text: " Pay the rent tomorrow " }), { status: 200 }); };
  const res = await callOpenAI(JSON.stringify({ transcribe_only: true, language: "en", messages: [{ role: "user", content: [{ type: "audio", source: { type: "base64", media_type: "audio/wav", data: "UklGRg==" } }, { type: "text", text: "Transcribe this." }] }] }), "k");
  eq("transcript in Kroft's shape", await res.json(), { content: [{ type: "text", text: "Pay the rent tomorrow" }] });
  eq("transcriptions endpoint", sent.url, "https://api.openai.com/v1/audio/transcriptions");
  eq("audio sent as a file with the model and language", [sent.init.body.get("model"), sent.init.body.get("language"), sent.init.body.get("file")?.name], ["gpt-4o-mini-transcribe", "en", "clip.wav"]);
}

// Errors keep their status (Kroft.jsx's friendlyError reads it) and are reported without text
{
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your quota" } }), { status: 429 });
  const seen = [];
  const res = await callOpenAI(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), "k", { onUsage: u => seen.push(u) });
  eq("429 passed through", res.status, 429);
  eq("error reported with codes only", seen.map(s => s.error), ["upstream_429 insufficient_quota insufficient_quota"]);
}

// A 5xx is retried once
{
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
  const res = await callOpenAI(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), "k");
  eq("503 retried once then succeeds", [calls, (await res.json()).content[0].text], [2, "ok"]);
}

// A broken body is refused before calling OpenAI
{
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("{}"); };
  const res = await callOpenAI("not json", "k");
  eq("bad body is a 400, OpenAI not called", [res.status, called], [400, false]);
}

if (fail) { console.log(`\n${fail} failing`); process.exit(1); }
console.log("\nall openai tests passed");
