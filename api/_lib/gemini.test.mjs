// Tests that api/_lib/gemini.js reports token usage for cost measurement without changing the
// reply, using a fake Gemini (global fetch). Run with: npm test
const { callGemini, usageFrom, googleReason } = await import("./gemini.js");
let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const meta = { promptTokenCount: 5200, candidatesTokenCount: 310, thoughtsTokenCount: 640, cachedContentTokenCount: 4096 };
const strip = u => { const { latencyMs, ...rest } = u; return { ...rest, latencyOk: latencyMs >= 0 }; };

eq("usageFrom maps Gemini's field names", usageFrom(meta), { inputTokens: 5200, outputTokens: 310, thinkingTokens: 640, cachedTokens: 4096 });
eq("usageFrom with nothing", usageFrom(undefined), {});

// Non-streaming
{
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello" }] } }], usageMetadata: meta }), { status: 200 });
  const seen = [];
  const res = await callGemini(JSON.stringify({ system: "abcdef", messages: [{ role: "user", content: "hi" }] }), "k", { onUsage: u => seen.push(u) });
  eq("reply unchanged", await res.json(), { content: [{ type: "text", text: "Hello" }] });
  eq("one usage report with tokens and prompt size", seen.map(strip), [{ model: "gemini-3.6-flash", streamed: false, systemChars: 6, status: 200, inputTokens: 5200, outputTokens: 310, thinkingTokens: 640, cachedTokens: 4096, latencyOk: true }]);
}

// Streaming: usage arrives with the chunks; the last running total is reported once, at the end
{
  const chunks = [
    { candidates: [{ content: { parts: [{ text: "Hel" }] } }], usageMetadata: { promptTokenCount: 5200, candidatesTokenCount: 1 } },
    { candidates: [{ content: { parts: [{ text: "lo" }] } }], usageMetadata: meta },
  ];
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const seen = [];
  const res = await callGemini(JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }), "k", { onUsage: u => seen.push(u) });
  const text = await res.text();
  const deltas = [...text.matchAll(/^data: (.*)$/gm)].map(m => JSON.parse(m[1]).delta.text).join("");
  eq("streamed reply unchanged", deltas, "Hello");
  eq("streamed: one report with the final totals", seen.map(strip), [{ model: "gemini-3.6-flash", streamed: true, systemChars: 0, status: 200, inputTokens: 5200, outputTokens: 310, thinkingTokens: 640, cachedTokens: 4096, latencyOk: true }]);
}

// Errors are reported too, without tokens
{
  globalThis.fetch = async () => new Response("quota", { status: 429 });
  const seen = [];
  const res = await callGemini(JSON.stringify({ messages: [] }), "k", { onUsage: u => seen.push(u) });
  eq("Gemini's error status passes through", res.status, 429);
  eq("error reported", seen.map(u => [u.status, u.error]), [[429, "upstream_429"]]);
}

// A broken logger never breaks the reply
{
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  const res = await callGemini(JSON.stringify({ messages: [] }), "k", { onUsage: () => { throw new Error("db down"); } });
  eq("reply still sent when logging throws", (await res.json()).content[0].text, "ok");
}

// Without onUsage nothing changes
{
  const res = await callGemini(JSON.stringify({ messages: [] }), "k");
  eq("works without a logger", res.status, 200);
}

// Google's reason for a refusal, as codes only.
const refused = JSON.stringify({ error: { code: 403, message: "Method doesn't allow unregistered callers", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } });
eq("Google's refusal reason is kept, as codes", [googleReason(refused), googleReason(JSON.stringify({ error: { status: "PERMISSION_DENIED" } })), googleReason("not json"), googleReason(JSON.stringify({ error: { status: "a message with spaces" } }))],
  [" PERMISSION_DENIED API_KEY_INVALID", " PERMISSION_DENIED", "", ""]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
