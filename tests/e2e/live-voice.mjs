// End-to-end check of live voice conversations in the real app, signed in: opening voice mode
// starts a live conversation by itself (no Start button), over a real WebRTC connection to a
// stand-in for OpenAI that runs in the page; Kroft's words and what the person said show up; the
// person cuts in just by talking; Kroft can save an expense mid-conversation; ending it is one
// tap; when live voice can't start, standard voice mode takes over; and typed chat is never read
// aloud by itself (privacy), while logging a stressful mood still is.
//
// Needs a build with Supabase switched on (see package.json test:e2e: dist-e2e-live).
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, failureCount, URL } from "./harness.mjs";

const user = { id: "7d615de4-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: "ada@example.com", app_metadata: { provider: "email" }, user_metadata: { name: "Ada Obi" }, created_at: "2026-01-01T00:00:00Z" };
const session = { access_token: "x.y.z", refresh_token: "r", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user };

// A stand-in for OpenAI's realtime endpoint: answers the app's WebRTC offer with a real peer
// connection in the same page, so the app's own connection, data channel and audio track are real.
const FAKE_OPENAI = `
  const realFetch = window.fetch.bind(window);
  window.__oai = { sent: [], open: false };
  window.fetch = async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/realtime/calls") {
      window.__oai.auth = init.headers.Authorization;
      const server = new RTCPeerConnection();
      const dest = new AudioContext().createMediaStreamDestination();
      dest.stream.getTracks().forEach(t => server.addTrack(t, dest.stream));
      server.ondatachannel = e => {
        window.__oai.channel = e.channel;
        e.channel.onopen = () => { window.__oai.open = true; };
        e.channel.onmessage = m => window.__oai.sent.push(JSON.parse(m.data));
      };
      await server.setRemoteDescription({ type: "offer", sdp: init.body });
      await server.setLocalDescription(await server.createAnswer());
      await new Promise(r => { if (server.iceGatheringState === "complete") r(); else server.onicegatheringstatechange = () => server.iceGatheringState === "complete" && r(); setTimeout(r, 1500); });
      window.__oai.server = server;
      return new Response(server.localDescription.sdp, { status: 201 });
    }
    return realFetch(url, init);
  };
  window.__say = ev => window.__oai.channel.send(JSON.stringify(ev));
  // Counts anything spoken through the device's voice.
  window.__spoken = [];
  const realSpeak = SpeechSynthesis.prototype.speak;
  SpeechSynthesis.prototype.speak = function (u) { window.__spoken.push(u.text); return realSpeak.call(this, u); };
`;

const server = await startServer();
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });

async function openApp({ realtimeStatus = 200 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["microphone"] });
  await ctx.addInitScript(`localStorage.setItem("sb-fake-auth-token", ${JSON.stringify(JSON.stringify(session))});`);
  await ctx.addInitScript(FAKE_OPENAI);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const calls = { realtime: [], chat: 0, tts: 0 };
  await page.route("https://fake.supabase.co/**", r => {
    const u = r.request().url();
    if (u.includes("/auth/v1/user")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
    if (u.includes("/rest/v1/kv_store")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ key: "kroft-user", value: JSON.stringify({ name: "Ada Obi", email: "ada@example.com", currency: "NGN", onboarded: true }) }]) });
    return r.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/**", r => {
    const path = new globalThis.URL(r.request().url()).pathname;
    if (path === "/api/realtime") {
      calls.realtime.push({ auth: r.request().headers().authorization, body: r.request().postDataJSON() });
      return r.fulfill({ status: realtimeStatus, contentType: "application/json", body: JSON.stringify(realtimeStatus === 200 ? { value: "ek_test", model: "gpt-realtime", maxMinutes: 3 } : { error: "daily_limit" }) });
    }
    if (path === "/api/tts") { calls.tts++; return r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"not_configured"}' }); }
    if (path === "/api/chat") {
      calls.chat++;
      const body = r.request().postDataJSON() || {};
      if (body.stream) return r.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "Here you go." } })}\n\n` });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: [{ type: "text", text: "Here you go." }] }) });
    }
    return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(URL);
  await page.getByRole("button", { name: "Ask Kroft" }).waitFor({ timeout: 20000 });
  return { ctx, page, errors, calls };
}

try {
  console.log("\nlive conversation");
  const { ctx, page, errors, calls } = await openApp();
  await page.getByRole("button", { name: "Ask Kroft" }).click();
  await page.getByRole("button", { name: "Open voice mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Voice conversation" });
  await page.waitForFunction(() => window.__oai.open, null, { timeout: 10000 }).catch(() => {});
  check("opening voice mode starts a live conversation by itself", calls.realtime.length === 1 && await page.evaluate(() => window.__oai.open));
  check("signed in, with Kroft's instructions, and the short-lived key goes to OpenAI", calls.realtime[0]?.auth === "Bearer x.y.z" && /Kroft/.test(calls.realtime[0]?.body?.instructions || "") && await page.evaluate(() => window.__oai.auth) === "Bearer ek_test");
  check("no Start or Interrupt buttons, just End conversation", await dialog.getByRole("button", { name: "End conversation" }).isVisible() && !(await dialog.getByRole("button", { name: /Start talking|Interrupt/ }).count()));
  check("says it's a live conversation you can cut into", await dialog.getByText(/Just talk, the way you would on a call/).isVisible());

  await page.evaluate(() => {
    window.__say({ type: "input_audio_buffer.speech_started" });
    window.__say({ type: "conversation.item.input_audio_transcription.completed", transcript: "How much did I spend on fuel?" });
    window.__say({ type: "response.output_audio_transcript.delta", delta: "You spent twelve thousand naira on fuel this month, mostly" });
  });
  await page.waitForTimeout(300);
  check("Kroft's words show while it talks, with a hint you can interrupt", await dialog.getByText(/You spent twelve thousand naira/).isVisible() && await dialog.getByText("Kroft is talking · just speak to interrupt").isVisible());
  await page.evaluate(() => window.__say({ type: "input_audio_buffer.speech_started" }));
  await page.waitForTimeout(200);
  check("talking over Kroft switches straight back to listening, no tap", await dialog.getByText("Listening", { exact: true }).isVisible());

  await page.evaluate(() => {
    window.__say({ type: "conversation.item.input_audio_transcription.completed", transcript: "Log 5000 for fuel." });
    window.__say({ type: "response.function_call_arguments.done", name: "kroft_action", call_id: "c1", arguments: JSON.stringify({ action: { type: "add_expense", label: "Fuel", amount: 5000, cat: "Transport" } }) });
  });
  await page.waitForTimeout(500);
  const sent = await page.evaluate(() => window.__oai.sent);
  check("Kroft saves the expense mid-conversation and tells OpenAI it's done", /Fuel/.test(sent.find(e => e.type === "conversation.item.create")?.item?.output || "") && sent.some(e => e.type === "response.create"));
  check("the expense is saved", await page.getByText(/Fuel/).first().isVisible());

  await dialog.getByRole("button", { name: "End conversation" }).click();
  await page.waitForTimeout(300);
  check("one tap ends it", await dialog.getByRole("button", { name: /Start talking/ }).isVisible());
  check("the conversation went into the chat history", (await page.evaluate(() => document.body.innerText)).includes("How much did I spend on fuel?"));
  check("standard voice wasn't used", calls.chat === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  console.log("\nprivacy: typed chat stays silent");
  const c = await openApp();
  await c.page.getByRole("button", { name: "Ask Kroft" }).click();
  await c.page.getByPlaceholder("Message Kroft…").fill("What's my balance?");
  await c.page.keyboard.press("Enter");
  await c.page.getByText("Here you go.").first().waitFor({ timeout: 8000 });
  await c.page.waitForTimeout(800);
  check("a typed reply arrives but isn't read aloud", c.calls.chat >= 1 && c.calls.tts === 0 && (await c.page.evaluate(() => window.__spoken.length)) === 0);
  await c.page.getByRole("button", { name: "Close Ask Kroft" }).click().catch(() => {});
  await c.page.locator('nav button[title="Home"]').click();
  await c.page.getByRole("button", { name: "Stressed" }).click();
  await c.page.waitForTimeout(1200);
  check("logging a stressful mood still speaks its tip", c.calls.tts + (await c.page.evaluate(() => window.__spoken.length)) > 0);
  await c.ctx.close();

  console.log("\nlive voice can't start");
  const b = await openApp({ realtimeStatus: 429 });
  await b.page.getByRole("button", { name: "Ask Kroft" }).click();
  await b.page.getByRole("button", { name: "Open voice mode" }).click();
  await b.page.waitForTimeout(1500);
  check("today's limit reached: says so and standard voice mode takes over", b.calls.realtime.length === 1 && await b.page.getByText(/You've had today's live conversations/).first().isVisible());
  check("no page errors", b.errors.length === 0, b.errors.join(" | "));
  await b.ctx.close();
} finally {
  await browser.close();
  server.kill();
}
if (failureCount()) { console.log(`\n${failureCount()} FAILED`); process.exit(1); }
console.log("\nALL PASSED");
