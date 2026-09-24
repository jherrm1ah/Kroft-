import { useState, useEffect, useRef, useCallback, useMemo, Component } from "react";
import { BarChart, ComposedChart, Bar, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";

// Theme-aware palette — black, white and off-white only, no grey scale.
// Dark mode: near-black surfaces, white/off-white text.
// Light mode: white/off-white surfaces, near-black text.
// Every token below meets or exceeds WCAG AA contrast against its paired surface.
const DARK = {
  bg:"#000000", card:"#0d0d0d", cardB:"#1c1c1c", surface:"#141414",
  hover:"#1a1a1a", white:"#ffffff", black:"#000000",
  offWhite:"#f4f2ee",
  text:"#ffffff",        // primary text — pure white on black, max contrast
  soft:"#dcd8d0",        // secondary text — bright off-white, clearly readable (was low-contrast grey)
  muted:"#9a968e",       // tertiary/placeholder — still readable, used sparingly
  border:"#2c2c2c",      // visible borders / dividers on dark surfaces
  div:"#1c1c1c",
  invBg:"#f4f2ee", invText:"#0a0a0a", // inverse surface for chips/pills on dark
  // Muted/desaturated versions of the original Tailwind-400 tones (#4ade80/#f87171/#fbbf24/
  // #818cf8) — those read as bright "candy" colors once reused everywhere (tags, chart fills,
  // borders), especially stacked across several cards on one screen. Still clearly distinct
  // from each other and each verified ≥4.5:1 against both bg and card.
  positive:"#7dbd8f", positiveBg:"rgba(125,189,143,.12)",  // income, completed, gains
  negative:"#d9776a", negativeBg:"rgba(217,119,106,.12)",  // expense, urgent, deficit
  warning:"#c9a350", warningBg:"rgba(201,163,80,.12)",     // on hold, pending, due soon
  accent:"#8891c4", accentBg:"rgba(136,145,196,.14)",      // AI, links, in-progress
  // Translucent fills for notices/inset panels. These were previously hardcoded as
  // rgba(255,255,255,.04–.09), which is invisible against a light surface — so every error
  // box and inset panel lost its background entirely in light mode.
  fill:"rgba(255,255,255,.05)", fillStrong:"rgba(255,255,255,.09)",
  // Elevation shadows, keyed to a card's role rather than one shadow used everywhere. Softened
  // (lower alpha) alongside the smaller CARD_LEVELS radii below — many cards stacked on one
  // screen with a heavy shadow and a large radius each reads as a pile of distinct boxes rather
  // than one calm layout.
  shadowRaised:"0 8px 22px rgba(0,0,0,.4)", shadowBase:"0 1px 5px rgba(0,0,0,.3)",
  // RGB triplet (not hex) so VoiceOrb can build an rgba() glow at a variable opacity — a light
  // glow reads as a corona against dark mode's black voice screen, but the same white glow would
  // vanish against light mode's off-white one, so this flips to a dark glow there instead.
  glowRGB:"255,255,255",
};
const LIGHT = {
  bg:"#f4f2ee", card:"#ffffff", cardB:"#e6e2da", surface:"#ffffff",
  hover:"#ece8e0", white:"#0a0a0a", black:"#ffffff",
  offWhite:"#000000",
  text:"#0a0a0a",        // primary text — near-black on off-white
  soft:"#3a3833",        // secondary text — dark and clearly readable
  muted:"#6b6860",       // tertiary/placeholder
  border:"#d6d1c5",      // visible borders / dividers on light surfaces
  div:"#e6e2da",
  invBg:"#0a0a0a", invText:"#f4f2ee",
  // See DARK's positive/negative/warning/accent comment — same desaturation, same contrast bar,
  // checked against both bg and card since text on either uses this color directly.
  positive:"#457154", positiveBg:"rgba(69,113,84,.10)",
  negative:"#a04b3f", negativeBg:"rgba(160,75,63,.10)",
  warning:"#87672a", warningBg:"rgba(135,103,42,.10)",
  accent:"#4f5389", accentBg:"rgba(79,83,137,.10)",
  fill:"rgba(10,10,10,.04)", fillStrong:"rgba(10,10,10,.07)",
  shadowRaised:"0 8px 22px rgba(40,36,28,.10)", shadowBase:"0 1px 3px rgba(40,36,28,.05)",
  glowRGB:"10,10,10",
};
// The Briefing plays over an always-dark scrim for focus, so it reads its colors from DARK
// regardless of the active theme. Without this it inherits light tokens and renders a
// near-black "solid" button on a near-black overlay.
const BRIEF = DARK;

// Mutable active-theme object. Sub-components below close over this same reference and
// read C.xxx at render time. The theme toggle in Kroft() reassigns these properties in place
// (Object.assign) rather than rebinding C itself, so every existing C.xxx reference across the
// file continues to work without needing to be rewritten individually.
// Seeded from LIGHT because that's the default theme. It was seeded from DARK, so the very
// first paint used dark colours before the theme effect corrected them a frame later — a
// visible flash on every cold load.
const C = { ...LIGHT };

// Space Mono is no longer used anywhere (see the Mono component below — small text switched to
// this same sans-serif for legibility), so it's dropped from the import rather than fetched and
// left unused.
const FONT = `@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap');`;

const ANIM = `
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes pop{0%{transform:scale(.9);opacity:0}65%{transform:scale(1.02)}100%{transform:scale(1);opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes wave{0%,100%{transform:scaleY(.2)}50%{transform:scaleY(1)}}
@keyframes slideIn{0%{transform:translateX(108%) scale(.9);opacity:0}70%{transform:translateX(-4%) scale(1.03);opacity:1}100%{transform:translateX(0) scale(1);opacity:1}}
@keyframes stepIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideUp{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:translateY(0)}}
/* ---- "Fun and haptic" pass: playful, springy feedback on the things people touch a lot ---- */
@keyframes bouncePop{0%{transform:scale(.4) rotate(-8deg);opacity:0}55%{transform:scale(1.18) rotate(4deg);opacity:1}75%{transform:scale(.92) rotate(-2deg)}100%{transform:scale(1) rotate(0);opacity:1}}
@keyframes checkPop{0%{transform:scale(1) rotate(0)}35%{transform:scale(1.4) rotate(-10deg)}65%{transform:scale(.88) rotate(6deg)}100%{transform:scale(1) rotate(0)}}
@keyframes tabPop{0%{transform:scale(.85)}50%{transform:scale(1.12)}100%{transform:scale(1)}}
@keyframes celebratePop{0%{transform:scale(.3);opacity:0}45%{transform:scale(1.2);opacity:1}70%{transform:scale(.92)}100%{transform:scale(1);opacity:1}}
@keyframes confettiFall{0%{transform:translate(0,-10px) rotate(0deg);opacity:1}100%{transform:translate(var(--drift,0px),100vh) rotate(var(--spin,540deg));opacity:0}}
@keyframes alarmPulse{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.12);opacity:1}}
`;

// Uses Intl's native currency formatting instead of a hand-maintained symbol map, so any
// valid ISO 4217 code (NGN, GHS, INR, JPY, ...) formats correctly out of the box — adding
// support for a new currency never requires a code change here. Falls back to "<CODE> <amount>"
// only if the code itself is invalid/unrecognized, rather than silently mislabeling it as $.
const fmtCur = (n, cur = "USD") => {
  try {
    return new Intl.NumberFormat("en-US", { style:"currency", currency:cur, currencyDisplay:"narrowSymbol", minimumFractionDigits:2, maximumFractionDigits:2 }).format(n);
  } catch {
    const neg = n < 0;
    const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 }).format(Math.abs(n));
    return `${neg ? "-" : ""}${cur} ${formatted}`;
  }
};
// A curated, region-grouped starting list for the currency picker — not exhaustive, since any
// valid ISO 4217 code works correctly via fmtCur's Intl formatting above. The picker also takes
// free-text entry for anything not listed here (see the CURRENCY step), so a user isn't limited
// to this set — this just surfaces the common ones without scrolling through all ~180 codes.
const CURRENCY_GROUPS = {
  "Africa": ["NGN","GHS","KES","ZAR","EGP","MAD","TZS","UGX","RWF","ETB","XOF","XAF"],
  "Americas": ["USD","CAD","BRL","MXN","ARS","CLP","COP"],
  "Europe": ["EUR","GBP","CHF","SEK","NOK","DKK","PLN","TRY"],
  "Asia-Pacific": ["INR","CNY","JPY","KRW","SGD","HKD","AUD","NZD","THB","PHP","IDR","VND","PKR","BDT"],
  "Middle East": ["AED","SAR","QAR","ILS"],
};
// Confirms a 3-letter code is an actual, currently-assigned ISO 4217 currency before it's
// accepted from the free-text entry. Intl.NumberFormat's constructor does NOT reject a
// well-formed-but-nonexistent code (e.g. "ZZZ") — it just silently falls back to printing the
// code as text — so real validation needs the actual list, not just a try/catch on Intl.
const ISO_4217_CODES = new Set(["AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP","STN","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XOF","XPF","YER","ZAR","ZMW","ZWL"]);
const isValidCurrencyCode = code => /^[A-Za-z]{3}$/.test(code) && ISO_4217_CODES.has(code.toUpperCase());
const timeStr = () => new Date().toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit" });
const dateStr = () => new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });
// People address each other by first name, not a full legal name — greeting someone "Hey Benjamin
// Jeremiah" (or having TTS attempt to pronounce a full name aloud) reads as stiff and robotic, the
// opposite of what every greeting/toast/spoken line here is going for. Used everywhere KROFT
// addresses the person directly; left alone for the handful of spots that display who they are
// (a profile header, an AI-context data field) rather than speak to them.
const firstNameOf = name => (name||"").trim().split(/\s+/)[0] || "";
const rand = arr => arr[Math.floor(Math.random() * arr.length)];
// Collision-safe ID generator. Date.now() alone can produce duplicate IDs when two items
// are created in the same millisecond (fast typing+Enter, rapid taps, batch actions) — every
// edit/delete/toggle keyed on that ID would then silently affect both items at once.
const uid = () => Date.now() + Math.random();
// The Vibration API only exists on Android Chrome/Firefox — iOS Safari and every desktop
// browser have no navigator.vibrate at all, so this is a best-effort tactile enhancement,
// never something an interaction depends on to make sense. Wrapped in try/catch since some
// browsers throw (rather than just no-op) calling vibrate() from certain contexts (e.g. an
// iframe without the right permissions-policy).
const haptic = pattern => { try { navigator.vibrate?.(pattern); } catch {} };
// Synthesizes a short two-tone beep via the Web Audio API rather than shipping an audio file —
// no asset to host, and it does the job for "something needs your attention right now." Reuses
// one AudioContext across calls (creating a new one per beep is wasteful, and some browsers cap
// how many can exist). Like any other audio in this app, browser autoplay policy means this only
// reliably plays once the page has already seen at least one user interaction this session.
let alarmAudioCtx = null;
const playAlarmBeep = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!alarmAudioCtx) alarmAudioCtx = new Ctx();
    const ctx = alarmAudioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    [0, 0.22].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0, now + offset);
      gain.gain.linearRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + offset + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    });
  } catch {}
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = iso => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }); };
// Advances an ISO date string forward by one occurrence of the given repeat cadence. Used to
// roll a recurring appointment to its next date once its current one has passed — daily/weekly
// add fixed day counts, monthly advances the calendar month (and lets JS Date normalize
// end-of-month overflow, e.g. Jan 31 + 1 month -> Mar 3, same as a real calendar app would).
const advanceRepeatDate = (iso, repeat) => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
  else return iso;
  return d.toISOString().slice(0, 10);
};
const monthLabel = iso => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month:"long", year:"numeric" }); };
// Lower rank = more urgent = sorts first. The task list used to only ever group by done/not-done —
// priority was fully editable and stored but never actually affected ordering, so an "Urgent" task
// added after a "Low" one just sat below it.
const PRIORITY_RANK = { Urgent:0, High:1, Normal:2, Low:3 };

// Turns written text into something that reads aloud cleanly. AI replies come back with
// markdown, and a speech engine reads it literally — "star star Net profit star star",
// "hash hash Summary", "dash" before every bullet — so it has to be stripped first.
// Strips numeric figures from text before it's spoken, for the one read-aloud in the app that's
// deliberately summary-only. The daily briefing already avoids announcing net profit since it
// fires automatically and could play in front of anyone nearby; this covers the monthly report,
// which is opt-in (the person taps the icon themselves) but whose generated text still embeds
// real amounts and percentages mid-sentence — "$520" isn't a separate stat here, it's inside the
// AI's own sentences, so it has to be pulled out of the text itself rather than just left unread.
const stripFiguresForSpeech = text => String(text)
  .replace(/[₦$€£]\s?\d[\d,]*(\.\d+)?/g, "a certain amount")
  .replace(/\d+(\.\d+)?\s?%/g, "a certain percentage")
  .replace(/\b\d[\d,]*(\.\d+)?\b/g, "a number")
  .replace(/\s{2,}/g, " ")
  .trim();

const speechText = raw => String(raw)
  .replace(/```[\s\S]*?```/g, " Code block omitted. ")   // don't read code out character by character
  .replace(/`([^`]+)`/g, "$1")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")             // links/images -> just their label
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")                    // heading marks
  .replace(/(\*\*|__)(.*?)\1/g, "$2")                    // bold
  .replace(/(\*|_)(.*?)\1/g, "$2")                       // italic
  .replace(/^\s*[-*+]\s+/gm, "")                         // bullet markers
  .replace(/^\s*(\d+)\.\s+/gm, "$1. ")                   // keep numbered lists as "1."
  .replace(/^\s*>\s?/gm, "")                             // block quotes
  .replace(/^\s*([-*_]\s*){3,}$/gm, "")                  // horizontal rules
  .replace(/[|]/g, " ")                                  // table pipes
  .replace(/\s*&\s*/g, " and ")
  .replace(/(\d)\s*%/g, "$1 percent")
  .replace(/\.{3,}/g, ". ")                              // ellipses become a pause, not "dot dot dot"
  .replace(/([.!?])\s*\n+/g, "$1 ")                      // paragraph breaks -> sentence pause
  .replace(/\n+/g, ". ")                                 // remaining line breaks need a beat
  .replace(/\s{2,}/g, " ")
  .trim();

// Splits into utterances short enough to speak reliably. Chrome/Edge garble or cut off a single
// utterance once it runs past roughly 15 seconds (a long-standing browser bug), so text is split
// on sentence boundaries — and any sentence still too long is split again at commas rather than
// mid-word, which is where an arbitrary character-count split would land.
const MAX_CHUNK = 180;
const speechChunks = text => {
  // Split only at a period/question/exclamation that is followed by a space and a new sentence.
  // The lookbehind for a digit keeps "$1,234.56" and list markers like "1. Cut costs" intact —
  // a naive split on [.!?] cut those apart and the engine read "one dollar two three four" then
  // paused mid-number.
  const sentences = text.split(/(?<![0-9])(?<=[.!?])\s+(?=[^\s])/);
  const parts = [];
  sentences.forEach(sentence => {
    const s = sentence.trim();
    if (!s) return;
    if (s.length <= MAX_CHUNK) { parts.push(s); return; }
    // Still too long for one utterance — break at commas rather than mid-word.
    let buf = "";
    s.split(/(?<=,)\s+/).forEach(piece => {
      if ((buf + " " + piece).trim().length > MAX_CHUNK && buf) { parts.push(buf.trim()); buf = piece; }
      else buf = (buf + " " + piece).trim();
    });
    if (buf) parts.push(buf.trim());
  });
  // Merge consecutive short sentences back together. Every utterance boundary is an audible
  // gap, so speaking "Summary." then "Your net profit is..." as two utterances sounds stilted
  // when they comfortably fit in one.
  const merged = [];
  parts.forEach(p => {
    const last = merged[merged.length - 1];
    if (last && (last + " " + p).length <= MAX_CHUNK) merged[merged.length - 1] = last + " " + p;
    else merged.push(p);
  });
  return merged;
};

// Every SpeechRecognition instance in this file used to hardcode "en-US", so anyone speaking
// another language just got garbled or empty transcripts. The browser/OS's own configured
// language is the right default — it's already what the person actually speaks, needs no
// language picker UI, and SpeechRecognition accepts any BCP-47 tag the platform supports.
const speechLang = () => (typeof navigator !== "undefined" && navigator.language) || "en-US";

// Groups whatever voices this browser/OS actually exposes into up to four picks — two
// "female"-sounding, two "male"-sounding — by matching common voice names (Apple's Samantha/
// Karen/Moira/Tessa, Chrome's "Google ... Female/Male", Edge/Windows's Zira/David/Guy/Aria,
// etc.). No browser exposes a real gender attribute on SpeechSynthesisVoice, so a name-based
// heuristic is the only option; devices with fewer than two recognizably-named voices per
// group are backfilled from whatever's left, so the Settings picker always offers up to four
// genuinely different-sounding options rather than quietly showing fewer.
const FEMALE_VOICE_HINTS = /female|woman|samantha|karen|victoria|zira|susan|fiona|moira|tessa|serena|salli|joanna|kendra|kimberly|ivy|amy|emma|allison|ava|zoe|shelley|aria|jenny/i;
const MALE_VOICE_HINTS = /male|\bman\b|daniel|alex|fred|david|\bguy\b|aaron|matthew|justin|joey|eric|ryan|brian|george|kevin|gordon|arthur|thomas/i;
function categorizeVoices(vs) {
  const pool = vs.filter(v => v.lang?.startsWith("en"));
  const used = new Set();
  const take = (pred, n, out) => {
    for (const v of pool) {
      if (out.length >= n) break;
      if (used.has(v.voiceURI) || !pred(v)) continue;
      used.add(v.voiceURI); out.push(v);
    }
  };
  const female = []; take(v => FEMALE_VOICE_HINTS.test(v.name), 2, female);
  const male = []; take(v => MALE_VOICE_HINTS.test(v.name), 2, male);
  const leftovers = pool.filter(v => !used.has(v.voiceURI));
  while (female.length < 2 && leftovers.length) { const v = leftovers.shift(); used.add(v.voiceURI); female.push(v); }
  while (male.length < 2 && leftovers.length) { const v = leftovers.shift(); used.add(v.voiceURI); male.push(v); }
  return { "female-1":female[0], "female-2":female[1], "male-1":male[0], "male-2":male[1] };
}

// ── KROFT Voice / TTS system ────────────────────────────────────────────────────────────────
// Layering: AI response text -> speak()/speakSequence()/createSpeechQueue() -> the selected
// VOICE_PROFILE -> the current TTS provider (today: the browser's own SpeechSynthesis, the only
// real, already-integrated, zero-cost, zero-server-key option this app has) -> audio playback.
// A real multi-voice cloud provider (ElevenLabs, Azure, Google Cloud TTS, ...) can be swapped in
// later by writing one module with the same speak(text, voice, rate)/cancel() contract that
// pickVoiceForPersona()/applyVoice() below already isolate everything else from — nothing above
// this comment block would need to change.
//
// Each persona is a real, distinct combination of: (1) an actual different browser voice where
// the device/OS exposes one (via genderSlot's categorizeVoices() heuristic, or an exact voice via
// providerVoiceId when configured), (2) its own base speaking rate, and (3) its own inter-
// utterance pause length — never pitch alone, which would just be the same voice sped up or
// slowed down. How distinct that actually sounds is bounded by what voices the browser/OS expose
// (see categorizeVoices' own comment) — this doesn't pretend otherwise.
const VOICE_PROFILES = {
  ben: {
    id:"ben", name:"Ben", emoji:"😊", gender:"male", style:"warm_calm_personal",
    traits:"Warm • Calm • Personal", isDefault:true,
    previewLine:"Hey, you've got two things coming up today. Want me to help you prioritise them?",
    speed:1.00, pauseMs:90, genderSlot:"male-1",
    // Configurable per the spec, not hardcoded inline: set VITE_TTS_VOICE_BEN to an exact
    // browser voice name (or a substring of one) to pin this persona to it. Unset (the common
    // case) falls back to the genderSlot heuristic above.
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_BEN || null,
  },
  atlas: {
    id:"atlas", name:"Atlas", emoji:"🧠", gender:"male", style:"deep_analytical_professional",
    traits:"Deep • Professional • Analytical", isDefault:false,
    previewLine:"Your spending is above this month's target. I've identified three areas where you can reduce your expenses.",
    speed:0.87, pauseMs:130, genderSlot:"male-2",
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_ATLAS || null,
  },
  mira: {
    id:"mira", name:"Mira", emoji:"✨", gender:"female", style:"warm_elegant_reassuring",
    traits:"Warm • Elegant • Reassuring", isDefault:false,
    previewLine:"Good morning. You've got a busy day ahead, but I've already organised everything for you.",
    speed:0.97, pauseMs:100, genderSlot:"female-1",
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_MIRA || null,
  },
  nova: {
    id:"nova", name:"Nova", emoji:"⚡", gender:"female", style:"energetic_modern_expressive",
    traits:"Energetic • Modern • Expressive", isDefault:false,
    previewLine:"Alright, you're all set! Your meeting starts in twenty minutes, and I've pulled up everything you'll need.",
    speed:1.12, pauseMs:60, genderSlot:"female-2",
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_NOVA || null,
  },
};
const DEFAULT_VOICE_ID = "ben";
// Earlier builds persisted a raw browser-voice slot (female-1/female-2/male-1/male-2) instead of
// a persona. Mapped forward once on load so a returning user's saved choice still resolves to a
// real persona instead of silently resetting — see hydrateAllGroups.
const LEGACY_VOICE_SLOT_MAP = { "male-1":"ben", "male-2":"atlas", "female-1":"mira", "female-2":"nova" };
const resolveVoiceId = raw => VOICE_PROFILES[raw] ? raw : (LEGACY_VOICE_SLOT_MAP[raw] || DEFAULT_VOICE_ID);

// Small, non-theatrical delivery shifts layered on top of a persona's own base pace — the
// "VOICE BEHAVIOUR" KROFT should show, never exaggerated acting. Applied as a multiplier on the
// persona's own speed/pause, so Atlas-reading-a-warning is still recognizably Atlas, just a touch
// more deliberate than Atlas-normal.
const SPEECH_CONTEXTS = {
  normal:      { rateMul:1.00, pauseMul:1.00 },
  warning:     { rateMul:0.92, pauseMul:1.25 },
  celebration: { rateMul:1.08, pauseMul:0.85 },
  reminder:    { rateMul:1.00, pauseMul:1.00 },
  sensitive:   { rateMul:0.90, pauseMul:1.30 },
};

// Set from KroftApp whenever the signed-in user's chosen voice (persisted per-account, see
// voicePref) or speed preference changes. Lives at module scope, outside React, because
// speak()/speakSequence()/createSpeechQueue() are plain functions called from all over this
// file, not hooks with access to component state.
let preferredVoiceId = DEFAULT_VOICE_ID;
const setPreferredVoiceId = id => { preferredVoiceId = resolveVoiceId(id); };
let preferredVoiceSpeed = 1.0;
const setPreferredVoiceSpeed = mul => { preferredVoiceSpeed = typeof mul === "number" && mul > 0 ? mul : 1.0; };

// Assigning an incompatible value to utterance.voice throws synchronously — a real browser
// behavior (reproduced directly: SpeechSynthesisUtterance.voice's setter validates its argument
// and rejects one it doesn't recognize as a genuine SpeechSynthesisVoice from this engine).
// Uncaught inside a speechSynthesis callback or a React effect, that silently kills the entire
// read-aloud attempt — no visible error, just dead air where the briefing or a wellness tip
// should have played. Every speak call site funnels through here so a voice picked by
// categorizeVoices/pickVoiceForPersona, however it was obtained, can never take down speech
// entirely — it falls back to the platform's own default voice for the language instead.
const applyVoice = (u, voice) => {
  u.lang = voice?.lang || "en-US";
  if (!voice) return;
  try { u.voice = voice; } catch { /* falls back to lang-only selection above */ }
};

// getVoices() returns an empty list on the first call in Chrome until the engine finishes
// loading them and fires voiceschanged — so picking a voice synchronously silently failed on
// the very first read-aloud of a session, falling back to the default robotic voice.
// voiceIdOverride: used by the voice-picker's own Preview button to audition a persona without
// changing the person's actual saved preference (preferredVoiceId stays untouched).
const pickVoiceForPersona = voiceIdOverride => {
  const profile = VOICE_PROFILES[resolveVoiceId(voiceIdOverride || preferredVoiceId)];
  const vs = window.speechSynthesis.getVoices();
  if (!vs.length) return { profile, voice:null };
  if (profile.providerVoiceId) {
    const hit = vs.find(v => v.voiceURI===profile.providerVoiceId || v.name===profile.providerVoiceId || v.name.toLowerCase().includes(profile.providerVoiceId.toLowerCase()));
    if (hit) return { profile, voice:hit };
  }
  const bySlot = categorizeVoices(vs)[profile.genderSlot];
  if (bySlot) return { profile, voice:bySlot };
  const fallback = vs.find(v => /Samantha|Google US English|Karen|Serena/i.test(v.name))
      || vs.find(v => v.lang === "en-US" && !/compact/i.test(v.name))
      || vs.find(v => v.lang?.startsWith("en"))
      || null;
  return { profile, voice:fallback };
};

// A persona's base rate/pause, adjusted by the delivery context (see SPEECH_CONTEXTS) and the
// person's own speed preference (Settings' Slower/Normal/Faster) — every speak call site funnels
// through this so the three levers never drift out of sync with each other.
const computeDelivery = (profile, context) => {
  const ctx = SPEECH_CONTEXTS[context] || SPEECH_CONTEXTS.normal;
  return { rate: profile.speed * ctx.rateMul * preferredVoiceSpeed, pauseMs: Math.round(profile.pauseMs * ctx.pauseMul) };
};

// opts.context: one of SPEECH_CONTEXTS' keys — see "VOICE BEHAVIOUR" above computeDelivery.
// opts.voiceId: auditions a specific persona for this call only (used by the voice picker's
// Preview button); omitted, every other call site keeps using whatever the person has selected.
function speak(raw, opts = {}) {
  if (!("speechSynthesis" in window)) return;
  const text = speechText(raw);
  if (!text) return;
  window.speechSynthesis.cancel();
  const chunks = speechChunks(text);
  // Both the voiceschanged listener and the timeout below can fire — guarding on
  // speechSynthesis.speaking (as this used to) is racy: a short utterance can finish speaking
  // before the 250ms timeout even runs, so `speaking` reads false again and the fallback
  // re-triggers the WHOLE sequence a second time, reading it twice. `started` makes run()
  // idempotent regardless of which trigger fires first, or in what order.
  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    const { profile, voice } = pickVoiceForPersona(opts.voiceId);
    const { rate, pauseMs } = computeDelivery(profile, opts.context);
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return;
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.rate = rate; u.pitch = 1.0; applyVoice(u, voice);
      u.onend = () => setTimeout(next, pauseMs);
      u.onerror = () => setTimeout(next, pauseMs);
      window.speechSynthesis.speak(u);
    };
    next();
  };
  if (!window.speechSynthesis.getVoices().length) {
    // Wait one tick for voices to arrive rather than speaking with none selected.
    window.speechSynthesis.addEventListener("voiceschanged", run, { once:true });
    setTimeout(run, 250);
  } else run();
}
const stopSpeaking = () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); };

// Speaks a list of lines in order, reporting which line is currently being read. Lets the UI
// follow the audio instead of guessing with a fixed timer — a timer drifts as soon as one line
// is longer than another, so the highlighted line stops matching the words being spoken.
// Speaks a reply as it is still being generated. Waiting for the whole response before saying
// anything is the single worst part of a voice assistant — several seconds of silence where the
// person can't tell if it heard them. This queues each complete sentence the moment it lands, so
// KROFT starts talking almost immediately and the rest arrives while it's still speaking.
function createSpeechQueue({ onStart, onDone, context } = {}) {
  let spokenUpTo = 0;      // how much of the incoming text has been queued
  let queue = [];
  let speaking = false;
  let finished = false;
  let cancelled = false;
  let started = false;
  let delivery = null;

  const drain = () => {
    if (cancelled || speaking) return;
    if (!queue.length) { if (finished) onDone?.(); return; }
    speaking = true;
    if (!started) { started = true; onStart?.(); }
    if (!delivery) { const { profile, voice } = pickVoiceForPersona(); delivery = { voice, ...computeDelivery(profile, context) }; }
    const u = new SpeechSynthesisUtterance(queue.shift());
    u.rate = delivery.rate; u.pitch = 1.0; applyVoice(u, delivery.voice);
    const next = () => { speaking = false; setTimeout(drain, delivery.pauseMs); };
    u.onend = next; u.onerror = next;
    window.speechSynthesis.speak(u);
  };

  return {
    // Called with the full text so far on each token; only the newly completed sentences are
    // queued. A trailing partial sentence is held back until it's terminated, so words aren't
    // spoken mid-clause.
    push(fullText) {
      if (cancelled) return;
      const ready = fullText.slice(spokenUpTo);
      const lastStop = Math.max(ready.lastIndexOf("."), ready.lastIndexOf("!"), ready.lastIndexOf("?"));
      if (lastStop === -1) return;
      const complete = ready.slice(0, lastStop + 1);
      spokenUpTo += complete.length;
      speechChunks(speechText(complete)).forEach(c => queue.push(c));
      drain();
    },
    // Flushes whatever is left once generation ends (a reply may not end in punctuation).
    end(fullText) {
      if (cancelled) return;
      const rest = fullText.slice(spokenUpTo).trim();
      if (rest) speechChunks(speechText(rest)).forEach(c => queue.push(c));
      finished = true;
      drain();
    },
    cancel() { cancelled = true; queue = []; window.speechSynthesis.cancel(); },
  };
}

function speakSequence(lines, { onLine, onDone, context, voiceId } = {}) {
  if (!("speechSynthesis" in window)) { lines.forEach((_, i) => onLine?.(i)); onDone?.(); return () => {}; }
  window.speechSynthesis.cancel();
  let cancelled = false;
  // See speak()'s comment — guarding solely on speechSynthesis.speaking is racy, since a short
  // first line can finish before the 250ms fallback even runs, making the fallback re-trigger
  // the whole sequence (reading every line again from the start). `started` makes this
  // idempotent regardless of which of the two triggers below fires first.
  let started = false;
  const start = () => {
    if (started || cancelled) return;
    started = true;
    const { profile, voice } = pickVoiceForPersona(voiceId);
    const { rate, pauseMs } = computeDelivery(profile, context);
    let li = 0;
    const speakLine = () => {
      if (cancelled) return;
      if (li >= lines.length) { onDone?.(); return; }
      const current = li;
      onLine?.(current);
      const chunks = speechChunks(speechText(lines[current]));
      let ci = 0;
      const nextChunk = () => {
        if (cancelled) return;
        if (ci >= chunks.length) { li++; speakLine(); return; }
        const u = new SpeechSynthesisUtterance(chunks[ci++]);
        u.rate = rate; u.pitch = 1.0; applyVoice(u, voice);
        u.onend = () => setTimeout(nextChunk, pauseMs);
        u.onerror = () => setTimeout(nextChunk, pauseMs);
        window.speechSynthesis.speak(u);
      };
      nextChunk();
    };
    speakLine();
  };
  if (!window.speechSynthesis.getVoices().length) {
    window.speechSynthesis.addEventListener("voiceschanged", start, { once:true });
    setTimeout(start, 250);
  } else start();
  return () => { cancelled = true; window.speechSynthesis.cancel(); };
}

function generatePassword() {
  const u="ABCDEFGHJKLMNPQRSTUVWXYZ", l="abcdefghjkmnpqrstuvwxyz", n="23456789", s="!@#$%&*";
  const all = u + l + n + s;
  let pw = u[Math.floor(Math.random()*u.length)] + l[Math.floor(Math.random()*l.length)] + n[Math.floor(Math.random()*n.length)] + s[Math.floor(Math.random()*s.length)];
  for (let i = 0; i < 8; i++) pw += all[Math.floor(Math.random() * all.length)];
  return pw.split("").sort(() => Math.random() - .5).join("");
}

// Three levels so a card's weight matches its role, instead of one radius + one shadow on
// every surface regardless of importance:
//   raised — top-level summaries and modals; largest radius, real elevation
//   base   — the default content card (unchanged from before, so existing usage is untouched)
//   inset  — nested rows inside another card; tighter radius, border only, no shadow
const CARD_LEVELS = {
  // Radii pulled in from 22/18/12 — large rounding reads fine on one card, but stacking several
  // per screen (Finance alone now runs eight-plus) turned every one of them into an obviously
  // separate bubble instead of one calm layout.
  raised: { radius:18, pad:20, shadow:() => C.shadowRaised },
  base:   { radius:14, pad:16, shadow:() => C.shadowBase },
  inset:  { radius:10, pad:12, shadow:() => "none" },
};
const Card = ({ children, style, onClick, hi, level="base", ...rest }) => {
  const L = CARD_LEVELS[level] || CARD_LEVELS.base;
  return (
    <div onClick={onClick} {...rest} style={{ background:C.card, border:`1px solid ${hi?C.border:C.cardB}`, borderRadius:L.radius, padding:L.pad, boxShadow:hi?`0 0 0 1px ${C.border},${C.shadowRaised}`:L.shadow(), cursor:onClick?"pointer":"default", transition:"border-color .18s", ...style }}>
      {children}
    </div>
  );
};

// Solid white = primary action. Outline = secondary. Ghost = minor/destructive.
const Btn = ({ children, onClick, v="solid", sm, disabled, full, style, "aria-label":ariaLabel }) => {
  const m = {
    solid: { bg:C.white, bc:C.white, col:C.black },
    outline: { bg:"transparent", bc:C.muted, col:C.soft },
    ghost: { bg:"transparent", bc:"transparent", col:C.border },
  };
  const s = m[v] || m.solid;
  // Icon-only buttons (e.g. a lone "✕" or "✓") get a minimum square footprint so a
  // one-character label doesn't collapse into a hard-to-tap sliver on touch devices.
  const isIconOnly = typeof children === "string" && children.trim().length <= 2;
  // Every Btn in the app gets a light haptic tap for free — this one shared component is used
  // hundreds of times across every screen, so it's the highest-leverage place to add tactile
  // feedback everywhere at once rather than touching each call site individually.
  const handleClick = e => { if (disabled) return; haptic(8); onClick?.(e); };
  return (
    <button onClick={handleClick} disabled={disabled} aria-label={ariaLabel} style={{ width:full?"100%":"auto", minWidth:sm&&isIconOnly?36:"auto", minHeight:sm?36:44, background:s.bg, border:`1px solid ${s.bc}`, borderRadius:12, padding:sm?"8px 14px":"10px 22px", cursor:disabled?"not-allowed":"pointer", color:s.col, fontWeight:700, fontSize:sm?12:13, fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.3, transition:"all .18s cubic-bezier(.34,1.56,.64,1)", opacity:disabled?.4:1, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6, boxSizing:"border-box", ...style }}>
      {children}
    </button>
  );
};

// Dependency-free celebratory confetti burst — a fixed full-screen overlay of falling pieces
// that removes itself once its animation finishes. Reserved for genuine milestones (see
// KroftApp's celebrate()), not everyday interactions, so it stays a real "moment" rather than
// noise. Pure CSS animation (see @keyframes confettiFall in ANIM), so prefers-reduced-motion
// already neutralizes it the same way it does every other decorative animation in the app.
function Confetti({ onDone }) {
  const pieces = useMemo(() => {
    const colors = [C.accent, C.positive, C.warning, C.negative, C.white];
    return Array.from({ length: 40 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.25,
      duration: 1.6 + Math.random() * 1.1,
      drift: Math.round((Math.random() - 0.5) * 220),
      spin: Math.round(360 + Math.random() * 360) * (Math.random() < 0.5 ? -1 : 1),
      color: colors[i % colors.length],
      w: 6 + Math.random() * 5,
      h: 10 + Math.random() * 6,
      round: Math.random() < 0.4,
    }));
  }, []);
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:1500, pointerEvents:"none", overflow:"hidden" }} aria-hidden="true">
      {pieces.map(p => (
        <div key={p.id} style={{
          position:"absolute", top:-16, left:`${p.left}%`,
          width:p.w, height:p.h, background:p.color, borderRadius:p.round?"50%":2,
          animation:`confettiFall ${p.duration}s ${p.delay}s cubic-bezier(.25,.46,.45,.94) forwards`,
          "--drift": `${p.drift}px`, "--spin": `${p.spin}deg`,
        }} />
      ))}
    </div>
  );
}

// Parses a money input, returning null for anything that shouldn't reach the ledger. A bare
// type="number" field still accepts a leading minus, so "-500" was storable as income — and a
// single negative (or a NaN from a partial entry like "-" or "1e") silently corrupts net
// profit, the category breakdowns and the monthly report, with nothing on screen explaining why
// the totals look wrong.
// "Good afternoon" was shown for everything from noon to midnight — at 11pm that reads as a bug.
const greeting = (d = new Date()) => { const h = d.getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

const fmtMemoLength = secs => {
  if (!secs && secs !== 0) return "";
  const m = Math.floor(secs / 60), sec = secs % 60;
  return m ? `${m}:${String(sec).padStart(2,"0")}` : `${sec}s`;
};

// Browser notifications. These reach the person when KROFT isn't the visible tab, which is the
// entire point — an in-app toast about a meeting in ten minutes only works if they happen to be
// looking at the app already.
// Honest limitation: without a service worker and a push server, these only fire while the page
// is open somewhere (including backgrounded). A fully closed browser delivers nothing, and the
// settings copy says so rather than implying otherwise.
// Makes a modal usable without a mouse. Every overlay in the app previously left focus loose in
// the page behind it, so Tab walked into content the user couldn't see and there was no way to
// dismiss from the keyboard at all.
// Handles three things: Escape closes, Tab cycles within the modal, and focus returns to
// wherever it was when the modal closes.
const useModalA11y = (onClose, active = true) => {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement;
    const node = ref.current;
    const selector = 'a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])';

    // Move focus into the dialog so the next Tab starts inside it rather than at the top of
    // the document.
    const focusables = () => Array.from(node?.querySelectorAll(selector) || []).filter(el => el.offsetParent !== null);
    const first = focusables()[0];
    (first || node)?.focus?.();

    const onKey = e => {
      if (e.key === "Escape") { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const firstEl = items[0], lastEl = items[items.length - 1];
      // Wrap at both ends so focus can never escape behind the overlay.
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Returning focus matters: without it, dismissing a dialog drops the user back at the
      // top of the document with no idea where they were.
      previouslyFocused?.focus?.();
    };
  }, [active, onClose]);
  return ref;
};

// How long an undo stays available. Shared so the toast and the blob cleanup below can never
// disagree — if the URL is revoked before the toast expires, undoing a file or memo restores an
// entry whose audio or download is already dead.
const UNDO_MS = 12000;

// One shared heartbeat for the app's periodic checks. There were five independent intervals
// (reminders, recurring transactions, wellness rollover, notification delivery, key pruning),
// each waking the device on its own schedule and all of them continuing to run while the tab was
// hidden — which on a phone means holding the CPU awake for work nobody can see.
// Subscribers run on a single timer, and the timer stops entirely when the tab is backgrounded,
// then fires once immediately on return so anything missed is caught up at once.
const heartbeat = (() => {
  const subs = new Set();
  let timer = null;
  const fire = () => subs.forEach(fn => { try { fn(); } catch { /* one bad subscriber shouldn't stop the rest */ } });
  const start = () => { if (!timer) timer = setInterval(fire, 30000); };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { fire(); start(); } else stop();
    });
  }
  return fn => {
    subs.add(fn);
    if (typeof document === "undefined" || document.visibilityState === "visible") start();
    return () => { subs.delete(fn); if (!subs.size) stop(); };
  };
})();

const notifySupported = () => typeof window !== "undefined" && "Notification" in window;

const requestNotifyPermission = async () => {
  if (!notifySupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try { return await Notification.requestPermission(); } catch { return "denied"; }
};

const sendNotification = (title, body, tag, opts = {}) => {
  if (!notifySupported() || Notification.permission !== "granted") return false;
  try {
    // The tag collapses repeats: re-firing the same reminder replaces the old notification
    // instead of stacking a second copy in the tray. requireInteraction (reminders only, so far)
    // keeps it pinned until dismissed instead of auto-vanishing after a few seconds — the
    // closest a background/closed-tab notification can get to "won't let you ignore it", since
    // sound and a full-screen takeover (see ReminderAlarmScreen) only work while the app itself
    // is open.
    const n = new Notification(title, { body, tag, badge:undefined, icon:undefined, requireInteraction: !!opts.requireInteraction });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch { return false; }
};

// Web Push's applicationServerKey wants raw bytes, not the base64url string VAPID keys are
// normally handed around as — this is the standard conversion every Web Push integration needs.
const urlBase64ToUint8Array = base64String => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

// Registers the service worker that turns a Web Push message into a real OS notification while
// no tab of the app is open (see public/sw.js) — a no-op if the browser doesn't support service
// workers at all, so this never blocks anything for a browser that simply can't do this.
const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); }
  catch { return null; }
};

// Subscribes this browser to Web Push and tells the server about it, so push delivery (currently:
// appointment reminders — see the scheduled-notifications sync effect below) can reach this
// device later, including while it's fully closed. Silently does nothing without a real account
// or a configured VAPID key, rather than surfacing an error for a gap the person can't act on.
const subscribeToPush = async authedFetch => {
  if (!isSupabaseConfigured || !("PushManager" in window)) return;
  const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!vapidKey) return;
  try {
    const registration = await registerServiceWorker();
    if (!registration) return;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
    const json = subscription.toJSON();
    await authedFetch("/api/push/subscribe", { method:"POST", body:JSON.stringify({ endpoint:json.endpoint, keys:json.keys }) });
  } catch {
    // Best-effort — push is a bonus delivery channel, not something any existing feature depends
    // on working. In-app/OS notifications while the app is open are unaffected either way.
  }
};

// Placeholder blocks shown while stored data is still loading. Without these the app renders
// its empty states first — a finance app briefly announcing "No financial data yet" to someone
// who has months of records is alarming, and indistinguishable from real data loss.
const Skeleton = ({ h = 14, w = "100%", r = 8, style }) => (
  <div aria-hidden="true" style={{ height:h, width:w, borderRadius:r, background:C.fill, animation:"pulse 1.4s ease-in-out infinite", ...style }} />
);

const SkeletonCard = ({ lines = 3 }) => (
  <div style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:18, padding:16, marginBottom:11 }}>
    <Skeleton h={11} w="38%" style={{ marginBottom:12 }} />
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} h={13} w={i === lines - 1 ? "62%" : "100%"} style={{ marginBottom:8 }} />
    ))}
  </div>
);

const parseAmount = raw => {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e12) return null;                 // beyond any plausible entry; almost certainly a typo
  return Math.round(n * 100) / 100;          // money is 2dp — avoids 0.1+0.2 style drift in totals
};

const Inp = ({ id, placeholder, value, onChange, type="text", inputMode, style, onKeyDown, ...rest }) => (
  <input id={id} type={type} inputMode={inputMode} placeholder={placeholder} value={value} onChange={onChange} onKeyDown={onKeyDown} {...rest}
    style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", transition:"border-color .18s", boxSizing:"border-box", ...style }}
    onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
);

// Used everywhere for small/secondary text (labels, subtitles, hints) — kept the name Mono from
// when it used an actual monospace font, but that made easily-confused characters (1/l/I, 0/O)
// harder to tell apart at 11px, exactly where the extra clarity matters most. Same sans-serif as
// the rest of the app now, just smaller and softer-colored.
const Mono = ({ children, style }) => (
  <span style={{ fontFamily:"'Space Grotesk',sans-serif", fontSize:11, color:C.soft, ...style }}>{children}</span>
);

const CategorySelect = ({ value, onChange, cats, onAddCategory, style }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  if (adding) {
    return (
      <div style={{ display:"flex", gap:5, ...style }}>
        <input autoFocus value={draft} onChange={e=>setDraft(e.target.value)} placeholder="New category" onKeyDown={e=>{ if (e.key==="Enter" && draft.trim()) { onAddCategory(draft.trim()); onChange(draft.trim()); setDraft(""); setAdding(false); } if (e.key==="Escape") { setAdding(false); setDraft(""); } }} style={{ width:100, background:C.surface, border:`1px solid ${C.soft}`, borderRadius:12, padding:"11px 10px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }} />
        <button onClick={() => { if (draft.trim()) { onAddCategory(draft.trim()); onChange(draft.trim()); } setDraft(""); setAdding(false); }} style={{ background:C.white, border:"none", borderRadius:12, padding:"0 10px", color:C.black, fontSize:12, fontWeight:700, cursor:"pointer" }}>✓</button>
      </div>
    );
  }
  return (
    <select value={value} onChange={e => e.target.value==="__add__" ? setAdding(true) : onChange(e.target.value)} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", ...style }}>
      {cats.map(c => <option key={c}>{c}</option>)}
      <option value="__add__">+ Add category…</option>
    </select>
  );
};

const Tag = ({ children, hi, tone, style }) => {
  const toneColor = tone && { positive:C.positive, negative:C.negative, warning:C.warning, accent:C.accent }[tone];
  const toneBg = tone && { positive:C.positiveBg, negative:C.negativeBg, warning:C.warningBg, accent:C.accentBg }[tone];
  return (
    <span style={{
      background: toneColor ? toneBg : (hi?C.text:C.surface),
      color: toneColor || (hi?C.invText:C.soft),
      border: toneColor ? `1px solid ${toneColor}55` : (hi?"none":`1px solid ${C.border}`),
      borderRadius:7, padding:"2px 8px", fontSize:10, fontWeight:600, letterSpacing:.4, whiteSpace:"nowrap", fontFamily:"'Space Grotesk',sans-serif",
      ...style
    }}>
      {children}
    </span>
  );
};

// Splash screen — matches the KROFT brand reference: white bg, scattered icon cards,
// orange accent underlines, centered wordmark. Always light/white regardless of app theme,
// since this is a fixed branding moment, not a themed screen.
const SPLASH_ORANGE = "#F97316";
const SPLASH_CARDS = [
  { top:"14%", left:"11%", rot:-6, icon:<svg viewBox="0 0 24 24" width={26} height={26}><path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5H6.5a2 2 0 0 1-2-2z" stroke="#0a0a0a" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" /><circle cx="9" cy="10.3" r=".9" fill="#0a0a0a" /><circle cx="12.3" cy="10.3" r=".9" fill="#0a0a0a" /><circle cx="15.6" cy="10.3" r=".9" fill="#0a0a0a" /></svg> },
  { top:"20%", left:"66%", rot:5, icon:<svg viewBox="0 0 24 24" width={26} height={26}><rect x="3.5" y="7" width="17" height="12" rx="2.2" stroke="#0a0a0a" strokeWidth={1.6} fill="none" /><path d="M3.5 10h17" stroke="#0a0a0a" strokeWidth={1.6} /><circle cx="16.5" cy="14.2" r="1.1" fill="#0a0a0a" /></svg> },
  { top:"39%", left:"2%", rot:-4, icon:<svg viewBox="0 0 24 24" width={26} height={26}><rect x="4" y="5.5" width="16" height="15" rx="2" stroke="#0a0a0a" strokeWidth={1.6} fill="none" /><path d="M4 9.5h16M8 3.5v3M16 3.5v3" stroke="#0a0a0a" strokeWidth={1.6} strokeLinecap="round" /></svg> },
  { top:"55%", left:"78%", rot:6, icon:<svg viewBox="0 0 24 24" width={26} height={26}><rect x="4" y="4" width="16" height="16" rx="3.2" stroke="#0a0a0a" strokeWidth={1.6} fill="none" /><path d="M8 12.3l2.6 2.6L16.5 9" stroke="#0a0a0a" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg> },
  { top:"72%", left:"4%", rot:4, icon:<svg viewBox="0 0 24 24" width={26} height={26}><path d="M6 19v-4.5M12 19V9M18 19V6" stroke="#0a0a0a" strokeWidth={2} strokeLinecap="round" /></svg> },
  { top:"78%", left:"66%", rot:-5, icon:<svg viewBox="0 0 24 24" width={26} height={26}><path d="M6 4.5h9l3 3V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" stroke="#0a0a0a" strokeWidth={1.6} fill="none" /><path d="M8.5 11h7M8.5 14.3h7M8.5 17.6h4" stroke="#0a0a0a" strokeWidth={1.4} strokeLinecap="round" /></svg> },
  { top:"91%", left:"38%", rot:0, icon:<svg viewBox="0 0 24 24" width={26} height={26}><circle cx="12" cy="8.2" r="3.4" stroke="#0a0a0a" strokeWidth={1.6} fill="none" /><path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4" stroke="#0a0a0a" strokeWidth={1.6} fill="none" strokeLinecap="round" /></svg> },
];
function SplashScreen({ fading }) {
  return (
    <div style={{ position:"fixed", inset:0, zIndex:9999, background:"#ffffff", overflow:"hidden", opacity:fading?0:1, transition:"opacity .6s ease", pointerEvents:fading?"none":"all" }}>
      <div style={{ position:"absolute", top:"30%", left:"50%", transform:"translate(-50%,-50%)", width:340, height:340, borderRadius:"50%", border:"1px solid rgba(0,0,0,.06)" }} />
      {SPLASH_CARDS.map((c,i) => (
        <div key={i} style={{ position:"absolute", top:c.top, left:c.left, width:76, height:76, borderRadius:20, background:"#fff", boxShadow:"0 10px 28px rgba(0,0,0,.08)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:7, transform:`rotate(${c.rot}deg)`, animation:`fadeUp .6s ease ${i*0.08}s both` }}>
          {c.icon}
          <div style={{ width:16, height:3, borderRadius:2, background:SPLASH_ORANGE }} />
        </div>
      ))}
      <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", textAlign:"center", width:"80%" }}>
        <div style={{ fontSize:44, fontWeight:800, letterSpacing:10, color:"#0a0a0a", fontFamily:"'Space Grotesk',sans-serif" }}>KROFT</div>
        <div style={{ width:28, height:3, borderRadius:2, background:SPLASH_ORANGE, margin:"14px auto" }} />
        <div style={{ fontSize:15, color:"#4a4a4a", lineHeight:1.5, fontFamily:"'Space Grotesk',sans-serif" }}>Your AI Assistant<br/>for Life &amp; Business.</div>
      </div>
      <div style={{ position:"absolute", bottom:"7%", left:"50%", transform:"translateX(-50%)", fontSize:13, color:"#8a8a8a", fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.3 }}>Smart. Simple. All in one.</div>
    </div>
  );
}

const WaveBar = ({ active, color=C.white }) => (
  <div style={{ display:"flex", alignItems:"center", gap:3, height:16 }}>
    {[...Array(5)].map((_, i) => (
      <div key={i} style={{ width:3, height:14, borderRadius:2, background:color, transformOrigin:"center", transform:"scaleY(.2)", animation:active?`wave .65s ease-in-out ${i*.1}s infinite`:"none", transition:"transform .3s" }} />
    ))}
  </div>
);

// Simple dot indicator used instead of emoji for status/unread markers
const Dot = ({ color=C.white, size=6 }) => (
  <div style={{ width:size, height:size, borderRadius:"50%", background:color, flexShrink:0 }} />
);

// Shared loading spinner — used everywhere the app is waiting on an async/AI action
// (fingerprint check, Around Me search, Generate Report, AI Suggest) so "working on it"
// looks and feels the same throughout the app instead of some spots getting a spinner
// and others only a text swap.
const Spinner = ({ size=14, color=C.white, thickness=2 }) => (
  <div style={{ width:size, height:size, border:`${thickness}px solid ${color}`, borderTopColor:"transparent", borderRadius:"50%", animation:"spin .7s linear infinite", flexShrink:0 }} />
);

// Minimal location pin icon, drawn with SVG to match the monochrome aesthetic — no emoji
const PinIcon = ({ size=14, color="currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink:0 }}>
    <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="12" cy="9.5" r="2.4" stroke={color} strokeWidth="1.6" />
  </svg>
);

// Bottom-nav icon set, drawn in the same thin-stroke style as PinIcon — one per core page.
const NavIcon = ({ id, size=20, color="currentColor" }) => {
  const s = { width:size, height:size, flexShrink:0 };
  const p = { stroke:color, strokeWidth:1.6, strokeLinecap:"round", strokeLinejoin:"round", fill:"none" };
  switch (id) {
    case "home":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 11.5 12 4l8 7.5" {...p} /><path d="M6 10v9.5a1 1 0 0 0 1 1h3.5v-5.5h3v5.5H17a1 1 0 0 0 1-1V10" {...p} /></svg>;
    case "wellness": // simple pulse line
      return <svg viewBox="0 0 24 24" style={s}><path d="M3.5 12h4l1.8-4.2 3 8.4 1.9-4.2H20.5" {...p} /></svg>;
    case "nova": // chat bubble for Ask Kroft
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5v-3.5H6.5a2 2 0 0 1-2-2z" {...p} /></svg>;
    case "workspace": // stacked layers / documents
      return <svg viewBox="0 0 24 24" style={s}><rect x="4.5" y="5" width="15" height="4.5" rx="1.2" {...p} /><rect x="4.5" y="10.8" width="15" height="4.5" rx="1.2" {...p} /><rect x="4.5" y="16.6" width="10" height="2.4" rx="1.2" {...p} /></svg>;
    case "profile":
      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="8.2" r="3.4" {...p} /><path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4" {...p} /></svg>;
    case "copy":
      return <svg viewBox="0 0 24 24" style={s}><rect x="8.5" y="8.5" width="11" height="11" rx="2" {...p} /><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" {...p} /></svg>;
    case "share":
      return <svg viewBox="0 0 24 24" style={s}><path d="M12 15V4" {...p} /><path d="M8 8l4-4 4 4" {...p} /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" {...p} /></svg>;
    case "play":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6.5 5.5v13l11-6.5z" {...p} /></svg>;
    case "thumbsUp":
      return <svg viewBox="0 0 24 24" style={s}><path d="M7 20V10.5l4.5-6.2c.5-.7 1.6-.3 1.5.6l-.7 4.1h5.4c1 0 1.7 1 1.4 1.9l-2 6.4a1.8 1.8 0 0 1-1.7 1.2H9.5A2.5 2.5 0 0 1 7 20z" {...p} /><path d="M7 10.5H4.5v9.5H7" {...p} /></svg>;
    case "thumbsDown":
      return <svg viewBox="0 0 24 24" style={s}><path d="M17 4v9.5l-4.5 6.2c-.5.7-1.6.3-1.5-.6l.7-4.1H6.3c-1 0-1.7-1-1.4-1.9l2-6.4A1.8 1.8 0 0 1 8.6 5.5h6.9A2.5 2.5 0 0 1 17 4z" {...p} /><path d="M17 13.5h2.5V4H17" {...p} /></svg>;
    case "retry":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 12a7.5 7.5 0 0 1 12.6-5.5M19.5 12a7.5 7.5 0 0 1-12.6 5.5" {...p} /><path d="M17.5 3.5v3.5H14" {...p} /><path d="M6.5 20.5V17H10" {...p} /></svg>;
    case "mic":
      return <svg viewBox="0 0 24 24" style={s}><rect x="9" y="3" width="6" height="11" rx="3" {...p} /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" {...p} /><path d="M12 18v3" {...p} /></svg>;
    case "plus":
      return <svg viewBox="0 0 24 24" style={s}><path d="M12 5v14M5 12h14" {...p} /></svg>;
    case "trendUp":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 16l6-6 4 4 6-8" {...p} /><path d="M15 6h5v5" {...p} /></svg>;
    case "trendDown":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 8l6 6 4-4 6 8" {...p} /><path d="M15 18h5v-5" {...p} /></svg>;
    case "waveform":
      return <svg viewBox="0 0 24 24" style={s}><path d="M3 10v4M8 7v10M12 4v16M16 7v10M21 10v4" {...p} /></svg>;
    case "droplet":
      return <svg viewBox="0 0 24 24" style={s}><path d="M12 3.5c3.5 4.2 6 7.6 6 10.8a6 6 0 0 1-12 0c0-3.2 2.5-6.6 6-10.8z" {...p} /></svg>;
    case "coffee":
      return <svg viewBox="0 0 24 24" style={s}><path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" {...p} /><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16" {...p} /><path d="M8 5.5v1.5M11 5.5v1.5M14 5.5v1.5" {...p} /></svg>;
    case "flame":
      return <svg viewBox="0 0 24 24" style={s}><path d="M12 3c1 3-3 4.5-3 8a3 3 0 0 0 6 0c1 1 1.5 2.3 1.5 3.5a4.5 4.5 0 0 1-9 0C7.5 10.5 10 8 12 3z" {...p} /></svg>;
    case "pin":
      return <svg viewBox="0 0 24 24" style={s}><path d="M12 3v6l4 3.5H8L12 9" {...p} /><path d="M12 12.5V21" {...p} /></svg>;
    case "send":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 12h14" {...p} /><path d="M12.5 5.5 19 12l-6.5 6.5" {...p} /></svg>;
    case "edit":
      return <svg viewBox="0 0 24 24" style={s}><path d="M15.5 4.5 19.5 8.5 8 20H4v-4z" {...p} /><path d="M14 6l4 4" {...p} /></svg>;
    case "history": // past conversations list
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 6h15M4.5 12h15M4.5 18h9" {...p} /></svg>;
    // ---- Workspace tool icons (the hub's ToolCard grid) ----
    case "calendar":
      return <svg viewBox="0 0 24 24" style={s}><rect x="4" y="5.5" width="16" height="14" rx="2" {...p} /><path d="M4 10h16" {...p} /><path d="M8 3.5v3M16 3.5v3" {...p} /></svg>;
    case "email":
      return <svg viewBox="0 0 24 24" style={s}><rect x="3.5" y="6" width="17" height="12" rx="2" {...p} /><path d="M4 7l8 6 8-6" {...p} /></svg>;
    case "tasks":
      return <svg viewBox="0 0 24 24" style={s}><rect x="4.5" y="4.5" width="15" height="15" rx="2.5" {...p} /><path d="M8.5 12.5l2.3 2.3 4.7-5" {...p} /></svg>;
    case "reminders":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6 17v-5a6 6 0 0 1 12 0v5" {...p} /><path d="M4.5 17h15" {...p} /><path d="M10 20a2 2 0 0 0 4 0" {...p} /></svg>;
    case "projects":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6 3.5v17" {...p} /><path d="M6 4.5h11l-2.5 3 2.5 3H6" {...p} /></svg>;
    case "notes":
      return <svg viewBox="0 0 24 24" style={s}><rect x="5.5" y="3.5" width="13" height="17" rx="1.5" {...p} /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" {...p} /></svg>;
    case "documents":
      return <svg viewBox="0 0 24 24" style={s}><path d="M7 3.5h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" {...p} /><path d="M14 3.5v4h4" {...p} /></svg>;
    case "files":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h7a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" {...p} /></svg>;
    case "memos":
      return <svg viewBox="0 0 24 24" style={s}><path d="M5 12v.01M8.5 8v8M12 5v14M15.5 8v8M19 12v.01" {...p} /></svg>;
    case "contacts":
      return <svg viewBox="0 0 24 24" style={s}><circle cx="9" cy="8.5" r="2.6" {...p} /><path d="M4 19c0-2.8 2.2-5 5-5s5 2.2 5 5" {...p} /><circle cx="17" cy="9" r="2.2" {...p} /><path d="M14.5 19c.2-2.3 1.8-4 3.5-4 1.9 0 3.5 1.8 3.7 4" {...p} /></svg>;
    default:
      return null;
  }
};

const OSTEPS = ["login","signup","photo","business","prefs","done"];
const OSTEP_LABELS = ["Photo","Business","Prefs","Ready"];

function OShell({ step, children, hideProgress }) {
  const idx = OSTEPS.indexOf(step);
  const showBar = !hideProgress && !["login","signup","reset-password"].includes(step);
  const barIdx = Math.max(0, idx - 2);
  const pct = showBar ? Math.round((barIdx / (OSTEP_LABELS.length - 1)) * 100) : 0;
  return (
    <div style={{ minHeight:"100vh", background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"24px 20px", position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, backgroundImage:`radial-gradient(circle,${C.border} 1px,transparent 1px)`, backgroundSize:"32px 32px", opacity:.15, pointerEvents:"none" }} />
      <div style={{ position:"absolute", top:0, left:"50%", transform:"translateX(-50%)", width:500, height:180, background:`radial-gradient(ellipse at 50% 0%,rgba(255,255,255,.05) 0%,transparent 70%)`, pointerEvents:"none" }} />
      {showBar && (
        <div style={{ width:"100%", maxWidth:460, marginBottom:26, zIndex:1, position:"relative" }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
            {OSTEP_LABELS.map((l, i) => {
              const si = i + 2; const active = idx === si; const done = idx > si;
              return (
                <div key={l} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, opacity:idx>=si?1:.2 }}>
                  <div style={{ width:26, height:26, borderRadius:"50%", background:done?C.white:active?C.white:C.border, border:`1px solid ${done||active?C.white:C.muted}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:800, color:C.black, boxShadow:active?"0 0 0 4px rgba(255,255,255,.12)":"none" }}>
                    {done ? "✓" : i + 1}
                  </div>
                  <Mono style={{ fontSize:8, color:active?C.white:C.muted, fontWeight:700, letterSpacing:.8 }}>{l.toUpperCase()}</Mono>
                </div>
              );
            })}
          </div>
          <div style={{ height:2, background:C.border, borderRadius:99, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${pct}%`, background:C.white, borderRadius:99, transition:"width .5s ease" }} />
          </div>
        </div>
      )}
      <div style={{ width:"100%", maxWidth:460, animation:"stepIn .4s ease", position:"relative", zIndex:1 }}>{children}</div>
    </div>
  );
}

// Press-and-hold to reveal an item's actions. Destructive actions used to sit permanently on
// every row as a bare ✕ — one mistap and a finance entry (or note, task, contact) was gone,
// which for finance meant silently corrupting the running totals. Holding is deliberate in a
// way that tapping isn't, so delete now costs intent to reach.
// Cancels if the finger moves (that's a scroll, not a hold), and maps to right-click on desktop.
// Written as a plain factory rather than a hook so list rows can call it inside .map() — and
// since only one press can be in flight at a time, the press state lives here at module level.
const LP = { timer:null, x:0, y:0, fired:false };
const lpClear = () => { if (LP.timer) { clearTimeout(LP.timer); LP.timer = null; } };
const longPress = (onLongPress, delay = 500) => ({
  onTouchStart: e => {
    LP.fired = false;
    const t = e.touches?.[0];
    if (t) { LP.x = t.clientX; LP.y = t.clientY; }
    lpClear();
    LP.timer = setTimeout(() => { LP.fired = true; LP.timer = null; onLongPress(); }, delay);
  },
  onTouchMove: e => {
    const t = e.touches?.[0];
    if (!t || !LP.timer) return;
    if (Math.abs(t.clientX-LP.x) > 10 || Math.abs(t.clientY-LP.y) > 10) lpClear();
  },
  onTouchEnd: lpClear,
  onTouchCancel: lpClear,
  onMouseDown: () => { LP.fired = false; lpClear(); LP.timer = setTimeout(() => { LP.fired = true; LP.timer = null; onLongPress(); }, delay); },
  onMouseUp: lpClear,
  onMouseLeave: lpClear,
  onContextMenu: e => { e.preventDefault(); if (!LP.fired) onLongPress(); },
  // Suppresses the tap that follows a completed hold, so opening the sheet doesn't also
  // trigger the row's own click (which would open the edit form behind it).
  onClickCapture: e => { if (LP.fired) { e.stopPropagation(); e.preventDefault(); LP.fired = false; } },
});

// Bottom sheet listing an item's actions, opened by holding the item. Delete asks a second
// time inside the sheet rather than firing straight from the first tap.
function ActionSheet({ title, subtitle, actions, onClose }) {
  const [confirming, setConfirming] = useState(null);
  const ref = useModalA11y(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ position:"fixed", inset:0, zIndex:960, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"flex-end", justifyContent:"center", animation:"fadeIn .15s ease" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.card, borderTop:`1px solid ${C.cardB}`, borderRadius:"22px 22px 0 0", padding:"18px 18px calc(18px + env(safe-area-inset-bottom))", width:"100%", maxWidth:520, boxShadow:C.shadowRaised, animation:"stepIn .2s ease" }}>
        <div style={{ width:38, height:4, borderRadius:99, background:C.border, margin:"0 auto 16px" }} />
        <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:subtitle?2:14, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{title}</div>
        {subtitle && <Mono style={{ display:"block", color:C.muted, marginBottom:14 }}>{subtitle}</Mono>}
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {actions.map(a => (
            confirming === a.label ? (
              <div key={a.label} style={{ background:C.negativeBg, border:`1px solid ${C.negative}55`, borderRadius:12, padding:12 }}>
                <Mono style={{ display:"block", color:C.soft, marginBottom:10, lineHeight:1.6 }}>{a.confirmText || "This can't be undone once the undo window passes."}</Mono>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn sm v="outline" onClick={() => setConfirming(null)} style={{ flex:1 }}>Keep</Btn>
                  <Btn sm onClick={() => { a.onClick(); onClose(); }} style={{ flex:1, background:C.negative, borderColor:C.negative, color:"#fff" }}>Delete</Btn>
                </div>
              </div>
            ) : (
              <button key={a.label} onClick={() => { if (a.destructive) setConfirming(a.label); else { a.onClick(); onClose(); } }}
                style={{ width:"100%", textAlign:"left", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"13px 15px", cursor:"pointer", color:a.destructive?C.negative:C.text, fontSize:14, fontWeight:600, fontFamily:"'Space Grotesk',sans-serif", minHeight:48 }}>
                {a.label}
              </button>
            )
          ))}
        </div>
        <Btn v="outline" full onClick={onClose} style={{ marginTop:12 }}>Cancel</Btn>
      </div>
    </div>
  );
}

// A static eclipse-style disc — solid black, with a soft glow halo behind it — replacing the
// earlier spinning particle-sphere animation, which read as "just an animation, no real use." The
// one exception: while actually listening, the glow breathes with the real mic input level
// (levelRef, already fed by the recognizer elsewhere) — motion that means something, instead of
// generic movement. Every other state (idle/thinking/speaking) stays at the calm static glow.
function VoiceOrb({ state, levelRef, size = 300 }) {
  const ref = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const base = { blur:size*0.45, spread:size*0.14, alpha:.32, blur2:size*0.18, spread2:size*0.04, alpha2:.48 };
    let raf, smooth = 0;
    const tick = () => {
      const target = stateRef.current === "listening" ? (levelRef?.current ?? 0) : 0;
      smooth += (target - smooth) * 0.15;
      el.style.boxShadow =
        `0 0 ${base.blur + smooth*size*0.25}px ${base.spread + smooth*size*0.08}px rgba(${C.glowRGB},${(base.alpha + smooth*0.35).toFixed(2)}), ` +
        `0 0 ${base.blur2 + smooth*size*0.1}px ${base.spread2 + smooth*size*0.04}px rgba(${C.glowRGB},${(base.alpha2 + smooth*0.4).toFixed(2)})`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [size, levelRef]);

  return <div ref={ref} style={{ width:size, height:size, borderRadius:"50%", background:"#050505", flexShrink:0 }} />;
}

// Full-screen one-on-one voice conversation. Entered deliberately rather than running
// ambiently, so the mic permission prompt and the pause while KROFT thinks read as part of the
// mode instead of the app behaving oddly.
// Full-screen incoming-call screen for a scheduled Plus call. Not a real phone call — there's no
// telephony behind this — but the framing (ringing orb, Answer/Decline) is deliberate: answering
// hands straight into voice mode with KROFT speaking first, which is the actual point of the
// feature, so it should feel like picking up rather than opening a chat.
function IncomingCallScreen({ call, onAnswer, onDecline }) {
  const ref = useModalA11y(onDecline);
  const size = Math.min(260, (typeof window !== "undefined" ? window.innerWidth : 360) - 100);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`Incoming call: ${call.title}`} tabIndex={-1}
      style={{ position:"fixed", inset:0, zIndex:1300, background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-between", padding:"14vh 24px calc(40px + env(safe-area-inset-bottom))" }}>
      <div style={{ textAlign:"center" }}>
        <Mono style={{ color:C.muted, display:"block", marginBottom:8 }}>Incoming call</Mono>
        <div style={{ fontSize:22, fontWeight:700, color:C.text, letterSpacing:-.4 }}>KROFT</div>
        <div style={{ fontSize:14, color:C.soft, marginTop:6 }}>{call.title}</div>
      </div>

      <VoiceOrb state="thinking" levelRef={{ current:0 }} size={size} />

      <div style={{ display:"flex", gap:28, alignItems:"center" }}>
        <button onClick={onDecline} aria-label="Decline call" style={{ width:64, height:64, borderRadius:"50%", border:"none", background:BRIEF.negative, color:"#fff", fontSize:22, cursor:"pointer" }}>✕</button>
        <button onClick={onAnswer} aria-label="Answer call" style={{ width:64, height:64, borderRadius:"50%", border:"none", background:BRIEF.positive, color:"#fff", fontSize:22, cursor:"pointer" }}>✓</button>
      </div>
    </div>
  );
}

// Full-screen alarm-style takeover for a smart reminder. Reminders used to only ever produce a
// quiet, easy-to-miss OS notification (or nothing, without permission granted) — this mirrors
// IncomingCallScreen's "can't miss it" pattern instead: a full-screen overlay with a pulsing
// icon that stays up until explicitly dismissed or snoozed, paired with the looping tone and
// vibration driven from the reminder-check effect below (kept there, not here, so the sound
// keeps going even if this component re-renders).
function ReminderAlarmScreen({ reminder, onDismiss, onSnooze }) {
  const ref = useModalA11y(onDismiss);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`Reminder: ${reminder.text}`} tabIndex={-1}
      style={{ position:"fixed", inset:0, zIndex:1300, background:"#000", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-between", padding:"14vh 24px calc(40px + env(safe-area-inset-bottom))" }}>
      <div style={{ textAlign:"center" }}>
        <Mono style={{ color:"rgba(255,255,255,.5)", display:"block", marginBottom:8 }}>Reminder</Mono>
        <div style={{ fontSize:22, fontWeight:700, color:"#fff", letterSpacing:-.4, lineHeight:1.4, maxWidth:320 }}>{reminder.text}</div>
      </div>
      <div style={{ width:140, height:140, borderRadius:"50%", background:"rgba(255,255,255,.08)", display:"flex", alignItems:"center", justifyContent:"center", animation:"alarmPulse 1.2s ease-in-out infinite" }}>
        <div style={{ width:80, height:80, borderRadius:"50%", background:"rgba(255,255,255,.15)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <NavIcon id="reminders" size={34} color="#fff" />
        </div>
      </div>
      <div style={{ display:"flex", gap:14, width:"100%", maxWidth:340 }}>
        <Btn v="outline" full onClick={onSnooze} style={{ borderColor:"rgba(255,255,255,.3)", color:"#fff" }}>Snooze 10 min</Btn>
        <Btn full onClick={onDismiss}>Dismiss</Btn>
      </div>
    </div>
  );
}

function VoiceMode({ state, transcript, reply, error, onStart, onStop, onClose, supported, levelRef, primed, subscribed, turnsLeft }) {
  // Keeps the tail of a long streaming reply in view without the person having to scroll.
  const replyEndRef = useRef(null);
  useEffect(() => { replyEndRef.current?.scrollIntoView?.({ block:"end" }); }, [reply]);
  const label = { idle:"Tap to speak", listening:"Listening", thinking:"Thinking", speaking:"Speaking" }[state] || "";
  const size = Math.min(320, (typeof window !== "undefined" ? window.innerWidth : 360) - 60);
  const ref = useModalA11y(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Voice conversation" tabIndex={-1} style={{ position:"fixed", inset:0, zIndex:1200, background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-between", padding:"22px 20px calc(28px + env(safe-area-inset-bottom))" }}>
      {/* Left-aligned so it doesn't sit under the toast stack, which now renders above this overlay. */}
      <div style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <button onClick={onClose} aria-label="Close voice mode" style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:40, height:40, color:C.text, fontSize:17, cursor:"pointer" }}>✕</button>
        {/* Quiet, and only once it's worth mentioning — matches the same low-key threshold used
            for the chat message counter, so usage isn't nagging from the first turn. */}
        {!subscribed && turnsLeft <= 3 && (
          <Mono style={{ color: turnsLeft === 0 ? C.negative : C.muted }}>
            {turnsLeft === 0 ? "resets tomorrow" : `${turnsLeft} voice turns left`}
          </Mono>
        )}
      </div>

      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:22, flex:1, justifyContent:"center", width:"100%" }}>
        <div
          role="button"
          tabIndex={0}
          aria-label={state === "idle" ? "Start listening" : "Stop"}
          onClick={() => (state === "idle" ? onStart() : onStop())}
          onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); state==="idle" ? onStart() : onStop(); } }}
          style={{ cursor:"pointer", borderRadius:"50%" }}>
          <VoiceOrb state={state} levelRef={levelRef} size={size} />
        </div>

        <div style={{ fontSize:13, fontWeight:600, color:C.muted, letterSpacing:.4, minHeight:18 }}>{label}</div>

        <div style={{ minHeight:96, maxHeight:170, overflowY:"auto", width:"100%", maxWidth:460, textAlign:"center", padding:"0 4px" }}>
          {error && <div style={{ fontSize:14, color:C.negative, lineHeight:1.6 }}>{error}</div>}
          {!error && transcript && <div style={{ fontSize:17, color:C.text, lineHeight:1.5, fontWeight:500 }}>{transcript}</div>}
          {!error && !transcript && reply && <div ref={replyEndRef} style={{ fontSize:15, color:C.soft, lineHeight:1.7, textAlign:"left" }}>{reply}</div>}
          {!error && !transcript && !reply && state === "idle" && (
            <div style={{ fontSize:14, color:C.muted, lineHeight:1.7 }}>
              {!supported
                ? "This browser can't do live speech recognition. Chrome or Edge on Android and desktop work best."
                : primed
                  ? "Ask about your finances, your day, or anything else."
                  // Said before the browser prompt appears, not after. An unexplained permission
                  // dialog is the single biggest reason people tap Deny — and once denied, the
                  // browser remembers it and the feature is dead until they dig through settings.
                  : "KROFT needs your microphone to hear you. Your browser will ask next — audio is only used for the words you speak and isn't stored."}
            </div>
          )}
        </div>
      </div>

      <div style={{ width:"100%", maxWidth:460, display:"flex", gap:10 }}>
        {state === "idle"
          ? <button onClick={onStart} disabled={!supported} style={{ flex:1, minHeight:52, borderRadius:16, border:"none", background:supported?C.text:C.surface, color:supported?C.card:C.muted, fontSize:15, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif", cursor:supported?"pointer":"not-allowed" }}>{primed ? "Start talking" : "Allow microphone"}</button>
          : <button onClick={onStop} style={{ flex:1, minHeight:52, borderRadius:16, border:`1px solid ${C.border}`, background:"transparent", color:C.text, fontSize:15, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif", cursor:"pointer" }}>{state==="speaking" ? "Interrupt" : state==="thinking" ? "Cancel" : "Stop"}</button>}
      </div>
    </div>
  );
}

// Uber's ride-booking API (real fare estimates, in-app booking) requires their business
// partner program — a business/legal agreement, not something any amount of code can obtain.
// Faking a price table and an "requested" toast instead, as this used to, means a real user
// would get a confirmation for a ride that was never actually booked — worse than not having
// the feature at all. Uber does, however, publish a public, keyless "Ride Request Deeplink"
// (https://developer.uber.com/docs/riders/ride-requests/tutorials/deep-links/introduction)
// specifically for third-party apps to hand off to Uber's own app or m.uber.com with a
// destination pre-filled — no API key, no partnership, no approval process. That's what this
// does: real pricing and real booking happen on Uber's side, honestly.
function buildUberDeepLink(address) {
  const url = new URL("https://m.uber.com/ul/");
  url.searchParams.set("action", "setPickup");
  url.searchParams.set("pickup", "my_location");
  if (address) url.searchParams.set("dropoff[formatted_address]", address);
  return url.toString();
}

// The Add Income/Add Expense buttons live in the Finance header, but the form itself used to
// render inline, deep in the page (near the ledger, well below Summary/budgets/charts) — so
// nothing visibly happened until you scrolled all the way down to find it. A modal that pulls up
// from the bottom is visible the instant it opens, wherever the page happened to be scrolled to.
function AddEntryModal({ kind, theme, value, onChange, cats, onAddCategory, onSubmit, onClose }) {
  const ref = useModalA11y(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={`New ${kind} entry`} tabIndex={-1}
      style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"flex-end", justifyContent:"center" }}
      onClick={onClose}>
      <div style={{ background:C.card, borderRadius:"20px 20px 0 0", padding:"20px 20px calc(20px + env(safe-area-inset-bottom))", width:"100%", maxWidth:480, boxSizing:"border-box", animation:"slideUp .25s ease" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <Mono style={{ color:C.white, letterSpacing:.8 }}>New {kind} entry</Mono>
          <button onClick={onClose} aria-label="Close" style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer", padding:4, lineHeight:1 }}>✕</button>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <Inp placeholder="Description" value={value.label} onChange={e => onChange(v=>({...v,label:e.target.value}))} style={{ flex:2, minWidth:120 }} />
          <Inp placeholder="Amount" value={value.amount} type="number" inputMode="decimal" min="0" step="0.01" onChange={e => onChange(v=>({...v,amount:e.target.value}))} style={{ flex:1, minWidth:80 }} />
          <input type="date" value={value.date||todayISO()} max={todayISO()} onChange={e => onChange(v=>({...v,date:e.target.value}))} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
          <CategorySelect value={value.cat} onChange={c => onChange(v=>({...v,cat:c}))} cats={cats} onAddCategory={onAddCategory} />
          {/* Turns the entry into a template that re-posts itself on this cadence. */}
          <select value={value.repeat} onChange={e => onChange(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
            <option value="none">Does not repeat</option>
            <option value="weekly">Repeats weekly</option>
            <option value="monthly">Repeats monthly</option>
          </select>
          <Btn full onClick={onSubmit}>Add</Btn>
        </div>
      </div>
    </div>
  );
}

function UberModal({ dest, onClose }) {
  const address = dest.location || dest.name || "";
  return (
    <div style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(0,0,0,.93)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:18, padding:28, maxWidth:380, width:"100%", animation:"pop .3s ease" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:6 }}>Get a ride</div>
        <div style={{ fontSize:19, fontWeight:700, color:C.white, marginBottom:3 }}>To: {address || "your destination"}</div>
        <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>{dest.time ? `${dest.time} · ${dest.date}` : dest.dist ? `${dest.dist} away` : "Nearby"}</Mono>
        <Mono style={{ display:"block", color:C.muted, marginBottom:22, lineHeight:1.6 }}>Opens Uber with your pickup location and this destination filled in. Real pricing, ETA and booking happen there — KROFT doesn't have its own ride pricing or booking.</Mono>
        <Btn full onClick={() => { window.open(buildUberDeepLink(address), "_blank", "noopener,noreferrer"); onClose(); }}>Continue to Uber</Btn>
        <Btn v="outline" full onClick={onClose} style={{ marginTop:10 }}>Cancel</Btn>
      </div>
    </div>
  );
}

function ComposeModal({ draft, onChange, onSend, onClose }) {
  const ref = useModalA11y(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="New email" tabIndex={-1} style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(0,0,0,.93)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:18, padding:26, maxWidth:480, width:"100%", animation:"pop .3s ease" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:17, fontWeight:700, color:C.text, letterSpacing:-.3, marginBottom:16 }}>New email</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:14 }}>
          <Inp placeholder="To: email address" type="email" inputMode="email" value={draft.to} onChange={e => onChange({...draft, to:e.target.value})} />
          <Inp placeholder="Subject" value={draft.subject} onChange={e => onChange({...draft, subject:e.target.value})} />
          <textarea placeholder="Write your message…" value={draft.body} onChange={e => onChange({...draft, body:e.target.value})} rows={6} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <Btn v="outline" onClick={onClose} style={{ flex:1 }}>Cancel</Btn>
          <Btn onClick={() => onSend(draft)} style={{ flex:2 }}>Send Email</Btn>
        </div>
      </div>
    </div>
  );
}

// Reusable picker used to connect saved Contacts to Email compose instead of leaving the
// recipient typed blank. `filter` narrows to contacts that actually have the field the
// destination action needs.
function PickContactModal({ contacts, filter, title, emptyHint, onPick, onClose }) {
  const list = contacts.filter(filter);
  const business = list.filter(c => c.category === "business");
  const family = list.filter(c => c.category === "family");
  const Group = ({ label, items }) => items.length === 0 ? null : (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:8 }}>{label} ({items.length})</div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {items.map(c => (
          <div key={c.id} onClick={() => onPick(c)} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px", borderRadius:12, border:`1px solid ${C.cardB}`, cursor:"pointer", transition:"border-color .14s" }} onMouseEnter={e=>e.currentTarget.style.borderColor=C.soft} onMouseLeave={e=>e.currentTarget.style.borderColor=C.cardB}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontWeight:700, fontSize:13, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name}</div>
              <Mono style={{ color:C.muted, display:"block", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.phone || c.email}</Mono>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(0,0,0,.93)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:18, padding:26, maxWidth:420, width:"100%", maxHeight:"78vh", overflowY:"auto", animation:"pop .3s ease" }} onClick={e => e.stopPropagation()}>
        <Mono style={{ display:"block", color:C.muted, letterSpacing:1.2, marginBottom:16 }}>{title}</Mono>
        {list.length === 0 ? (
          <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>{emptyHint}</Mono>
        ) : (
          <>
            <Group label="Business" items={business} />
            <Group label="Family" items={family} />
          </>
        )}
        <Btn v="outline" full onClick={onClose}>Cancel</Btn>
      </div>
    </div>
  );
}

// Shared "link to a contact" dropdown used by Tasks and Reminders forms, so either can
// be optionally tied to someone in the Contacts book.
const ContactSelect = ({ value, onChange, contacts, style }) => {
  const business = contacts.filter(c => c.category === "business");
  const family = contacts.filter(c => c.category === "family");
  return (
    <select value={value || ""} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", ...style }}>
      <option value="">No contact</option>
      {business.length > 0 && <optgroup label="Business">{business.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
      {family.length > 0 && <optgroup label="Family">{family.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>}
    </select>
  );
};

// Drill-down for a single contact — shows their KROFT call/email history plus everything
// linked to them (tasks, reminders, appointments, notes, files) in one place.
function ContactActivityModal({ contact, tasks, reminders, appts, notes, files, onToggleTask, onToggleReminder, onClose }) {
  const Section = ({ label, items, render }) => items.length === 0 ? null : (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:8 }}>{label} ({items.length})</div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>{items.map(render)}</div>
    </div>
  );
  const modalRef = useModalA11y(onClose);
  const empty = tasks.length===0 && reminders.length===0 && appts.length===0 && notes.length===0 && files.length===0 && (contact.log||[]).length===0;
  return (
    <div ref={modalRef} role="dialog" aria-modal="true" aria-label={`Activity for ${contact.name}`} tabIndex={-1} style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(0,0,0,.93)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:18, padding:26, maxWidth:460, width:"100%", maxHeight:"80vh", overflowY:"auto", animation:"pop .3s ease" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize:19, fontWeight:700, color:C.text, letterSpacing:-.3, marginBottom:2 }}>{contact.name}</div>
        <Mono style={{ display:"block", color:C.muted, marginBottom:18 }}>Everything linked to this contact</Mono>
        {empty ? (
          <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Nothing here yet. Calls and emails you place from KROFT show up here, along with any task, reminder, appointment, note or file you assign to {contact.name}. Calls dialled outside KROFT aren't visible to the app.</Mono>
        ) : (
          <>
            <Section label="Calls & emails" items={contact.log||[]} render={l => (
              <div key={l.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <div style={{ fontSize:12, color:C.text }}>{l.type==="call" ? "Called from KROFT" : "Emailed from KROFT"}</div>
                <Mono style={{ color:C.muted, flexShrink:0 }}>{new Date(l.at).toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}</Mono>
              </div>
            )} />
            <Section label="Tasks" items={tasks} render={t => (
              <div key={t.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <button onClick={() => onToggleTask(t.id)} style={{ width:18, height:18, borderRadius:5, border:`1.5px solid ${t.done?C.white:C.soft}`, background:t.done?C.white:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:C.black, fontSize:11, fontWeight:900 }}>{t.done?"✓":""}</button>
                <div style={{ fontSize:12, color:C.text, textDecoration:t.done?"line-through":"none" }}>{t.title}</div>
              </div>
            )} />
            <Section label="Reminders" items={reminders} render={r => (
              <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <button onClick={() => onToggleReminder(r.id)} style={{ width:18, height:18, borderRadius:5, border:`1.5px solid ${r.done?C.white:C.soft}`, background:r.done?C.white:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:C.black, fontSize:11, fontWeight:900 }}>{r.done?"✓":""}</button>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, color:C.text, textDecoration:r.done?"line-through":"none" }}>{r.text}</div>
                  <Mono style={{ color:C.muted }}>{r.when}</Mono>
                </div>
              </div>
            )} />
            <Section label="Appointments" items={appts} render={a => (
              <div key={a.id} style={{ padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.text }}>{a.title}</div>
                <Mono style={{ color:C.muted }}>{a.time} · {fmtDate(a.date)||a.date}</Mono>
              </div>
            )} />
            <Section label="Notes" items={notes} render={n => (
              <div key={n.id} style={{ padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.text, marginBottom:2 }}>{n.title || "Untitled note"}</div>
                <Mono style={{ color:C.muted }}>{n.date}</Mono>
              </div>
            )} />
            <Section label="Files" items={files} render={f => (
              <div key={f.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, padding:"9px 11px", borderRadius:10, border:`1px solid ${C.cardB}` }}>
                <div style={{ minWidth:0, flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</div>
                  <Mono style={{ color:C.muted }}>{(f.size/1024).toFixed(0)} KB · {f.date}</Mono>
                </div>
                <a href={f.url} download={f.name} style={{ textDecoration:"none", flexShrink:0 }}><Btn sm v="outline">Open</Btn></a>
              </div>
            )} />
          </>
        )}
        <Btn v="outline" full onClick={onClose}>Close</Btn>
      </div>
    </div>
  );
}

function Briefing({ user, income, expenses, emails, appts, onClose }) {
  const net = income - expenses;
  const unread = emails.filter(e => !e.read).length;
  const first = emails.find(e => !e.read);
  const lines = [
    `${greeting()}, ${firstNameOf(user.name)}. Today is ${dateStr()}.`,
    appts.length>0 ? `You have ${appts.length} appointment${appts.length!==1?"s":""}. First: ${appts[0].title} at ${appts[0].time}.` : `No appointments today.`,
    unread>0 ? `You have ${unread} unread email${unread!==1?"s":""}. Most recent: ${first?.subject}.` : `Your inbox is clear.`,
    // The briefing plays out loud, often with other people nearby. It says whether the figures
  // are worth a look without announcing the amount — the number is one tap away on screen.
  income>0 ? `Your finances are up to date — the figures are in Finance whenever you want them.` : `No financial data yet.`,
    `Stay hydrated and take short breaks throughout your day.`,
    `I am with you all day, ${firstNameOf(user.name)}. Let's make it count.`,
  ];
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    // The reveal follows the audio: each line lights up as it is actually read. If speech isn't
    // available (or is blocked until the user interacts), fall back to the old fixed cadence so
    // the briefing still plays through visually rather than freezing on line one.
    const canSpeak = "speechSynthesis" in window;
    if (canSpeak) {
      const stop = speakSequence(lines, {
        onLine: i => setIdx(i),
        onDone: () => { setIdx(lines.length - 1); setDone(true); },
      });
      // Guards against speech being genuinely blocked/unavailable (e.g. autoplay-policy
      // restrictions before any user gesture) — NOT a generous margin for normal
      // voice-loading delay, which this used to mistake for "broken". 1.5s was too tight: on a
      // slower device, getVoices() can legitimately still be empty at that point, so this fired
      // while speech was still about to start rather than actually stuck. Firing here marked
      // the whole briefing "done" on screen while speakSequence kept talking in the background,
      // completely out of sync with a UI that already looked finished — the audio would then
      // run for however long the real briefing takes, well after the screen said it was over.
      // Bumped to a real margin AND now actually cancels the dangling speech attempt, so the
      // on-screen state and the audio can never diverge like that again.
      const failsafe = setTimeout(() => { if (!window.speechSynthesis.speaking) { stop(); setIdx(lines.length - 1); setDone(true); } }, 4000);
      return () => { clearTimeout(failsafe); stop(); };
    }
    const t = setInterval(() => setIdx(i => { if (i >= lines.length-1) { setDone(true); clearInterval(t); return i; } return i+1; }), 3200);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(0,0,0,.97)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
      <div style={{ maxWidth:500, width:"100%", textAlign:"center" }}>
        <div style={{ fontSize:20, fontWeight:700, color:BRIEF.text, letterSpacing:-.4, marginBottom:4 }}>Your day so far</div>
        <Mono style={{ color:BRIEF.muted, display:"block", marginBottom:28 }}>{timeStr()}, {dateStr()}</Mono>
        <div style={{ textAlign:"left", padding:26, marginBottom:24, background:BRIEF.card, border:`1px solid ${BRIEF.border}`, borderRadius:22, boxShadow:BRIEF.shadowRaised }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:10, opacity:i<=idx?1:.07, transition:"opacity .5s" }}>
              <Mono style={{ color:i===idx?BRIEF.text:BRIEF.muted, marginTop:2, flexShrink:0 }}>{i===idx?"—":"·"}</Mono>
              <div style={{ fontSize:14, lineHeight:1.75, color:i===idx?BRIEF.text:BRIEF.soft, fontWeight:i===idx?500:400, transition:"color .4s" }}>{l}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", justifyContent:"center", marginBottom:22 }}><WaveBar active={!done} color={BRIEF.text} /></div>
        <button onClick={onClose} style={{ minHeight:44, padding:"11px 28px", fontSize:13, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.3, borderRadius:12, cursor:"pointer", background:done?BRIEF.white:"transparent", border:`1px solid ${done?BRIEF.white:BRIEF.muted}`, color:done?BRIEF.black:BRIEF.soft }}>{done?`Let's go, ${firstNameOf(user.name)}`:"Skip"}</button>
      </div>
    </div>
  );
}

// ── PROFILE PAGE ───────────────────────────────────────────────────────────────
// A single row in a profile section. Tapping expands an inline detail area so every
// item does something real — no dead placeholder rows.
// A compact top-level category row on the Profile hub — title, subtitle, chevron, nothing more.
// Tapping navigates to a dedicated screen rather than expanding inline.
function ProfileCategoryRow({ label, sub, onClick, isLast }) {
  return (
    <div onClick={onClick} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"15px 2px", cursor:"pointer", borderBottom:isLast?"none":`1px solid ${C.div}` }}>
      <div>
        <div style={{ fontSize:14, fontWeight:700, color:C.white }}>{label}</div>
        {sub && <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{sub}</Mono>}
      </div>
      <Mono style={{ color:C.muted, fontSize:16 }}>›</Mono>
    </div>
  );
}

// Header bar for a Profile drill-down screen: back button + screen title.
function ProfileScreenHeader({ title, onBack }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
      <button onClick={onBack} aria-label="Back" style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:10, width:34, height:34, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:C.white, fontSize:16, flexShrink:0 }}>
        ‹
      </button>
      <h2 style={{ fontSize:19, fontWeight:800, color:C.white, letterSpacing:-.6 }}>{title}</h2>
    </div>
  );
}

function ProfileRow({ label, sub, expanded, onToggle, children, right }) {
  return (
    <div style={{ borderBottom:`1px solid ${C.div}` }}>
      <div onClick={onToggle} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 2px", cursor:"pointer" }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, color:C.white }}>{label}</div>
          {sub && <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{sub}</Mono>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {right}
          <Mono style={{ color:C.muted, fontSize:14, transform:expanded?"rotate(90deg)":"none", transition:"transform .16s", display:"inline-block" }}>›</Mono>
        </div>
      </div>
      {expanded && children && (
        <div style={{ padding:"0 2px 16px", animation:"fadeIn .2s ease" }}>{children}</div>
      )}
    </div>
  );
}

function ProfileSwitch({ value, onChange }) {
  return (
    <button onClick={e => { e.stopPropagation(); onChange(!value); }} style={{ width:38, height:22, borderRadius:99, border:`1px solid ${value?C.accent:C.muted}`, background:value?C.accentBg:"transparent", position:"relative", cursor:"pointer", flexShrink:0, transition:"all .16s" }}>
      <div style={{ position:"absolute", top:2, left:value?18:2, width:16, height:16, borderRadius:"50%", background:value?C.accent:C.border, transition:"left .16s, background .16s" }} />
    </button>
  );
}

function ProfileSection({ user, onUpdateName, onEditPreferences, onEditBusinessDetails, onSignOut, theme, onToggleTheme, toast, subscribed, subscriptionStatus, autoRenews, billingLoading, onUpgrade, onManageBilling, usageStats, voiceReplies, onSetVoiceReplies, proactiveInsights, onSetProactiveInsights, voicePref, onSetVoicePref, voiceSpeed, onSetVoiceSpeed, onSetupBiometric, onRemoveBiometric, onExportData, onImportData, notifPermission, notifPrefs, onEnableNotifications, onSetNotifPref, onTestNotification, voiceTurnsCount, voiceLimit }) {
  // null = main hub. Otherwise one of: "ai" | "productivity" | "privacy" | "subscription" | "support"
  const [screen, setScreen] = useState(null);
  const [openRow, setOpenRow] = useState(null);
  const fileInputRef = useRef(null);
  const toggle = k => setOpenRow(openRow===k ? null : k);
  const initials = user.name ? user.name.split(" ").map(n=>n[0]).join("").toUpperCase().slice(0,2) : "?";
  const goTo = key => { setOpenRow(null); setScreen(key); };
  const goBack = () => { setOpenRow(null); setScreen(null); };

  // What KROFT calls this user everywhere (greetings, voice replies, the daily briefing) — set
  // once at signup with no way to change it afterward until now. Local draft + explicit
  // Save/Cancel rather than saving on every keystroke, so a half-typed name never briefly
  // becomes "what KROFT calls you" before the person finishes typing.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(user.name || "");
  const saveName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    onUpdateName(trimmed);
    setEditingName(false);
    toast(`Got it — KROFT will call you ${trimmed}.`);
  };
  const cancelEditName = () => { setNameDraft(user.name || ""); setEditingName(false); };

  // Local, in-memory-only preference toggles for this session — presentational until wired to a backend.
  // voiceReplies and proactiveInsights now live in Kroft() (lifted up) since they actually gate
  // behavior there; the rest stay local since nothing in-app depends on them yet.
  const [supportMsg, setSupportMsg] = useState("");
  const [supportSent, setSupportSent] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);

  // ── DRILL-DOWN: AI & PERSONALIZATION ──
  if (screen === "ai") return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <ProfileScreenHeader title="AI & Personalization" onBack={goBack} />
      <Card style={{ padding:"2px 16px" }}>
        <ProfileRow label="Personal Preferences" sub="Business, currency" expanded={openRow==="prefs"} onToggle={()=>toggle("prefs")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:10 }}>Business: {user.businessName || "Not set"} · Currency: {user.currency}</Mono>
          {/* Your name is edited right at the top of Profile now, not here — see the pencil
              icon next to it. This used to say "Name, business, currency" and route to the
              account-linking screen, which edits none of the three. */}
          <Btn sm onClick={onEditBusinessDetails}>Edit details</Btn>
        </ProfileRow>
        <ProfileRow label="AI Memory" sub="What KROFT remembers about you" expanded={openRow==="memory"} onToggle={()=>toggle("memory")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{isSupabaseConfigured ? "KROFT remembers your recent conversation (the last 60 messages) across visits, plus your finances, appointments, and mood, to answer with real context. It's kept in your own account and never shared with other KROFT users." : "KROFT remembers your recent conversation (the last 60 messages) on this device, plus your finances, appointments, and mood, to answer with real context. Nothing leaves this device in local-only mode."}</Mono>
        </ProfileRow>
        <ProfileRow label="Voice & Language" sub={`English (US) · ${VOICE_PROFILES[resolveVoiceId(voicePref)].name}`} expanded={openRow==="voice"} onToggle={()=>toggle("voice")}
          right={<ProfileSwitch value={voiceReplies} onChange={onSetVoiceReplies} />}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:14 }}>{voiceReplies ? "KROFT speaks replies and reminders aloud." : "KROFT will stay silent unless you tap Read Aloud — voice is never required to use KROFT."}</Mono>
          <Mono style={{ display:"block", color:C.white, marginBottom:2 }}>KROFT Voice</Mono>
          <Mono style={{ display:"block", color:C.muted, marginBottom:10 }}>Choose how KROFT sounds.</Mono>
          {Object.values(VOICE_PROFILES).map(v => {
            const selected = resolveVoiceId(voicePref)===v.id;
            return (
              <div key={v.id} role="button" tabIndex={0} onClick={() => onSetVoicePref(v.id)} onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); onSetVoicePref(v.id); } }}
                style={{ display:"flex", alignItems:"center", gap:11, padding:"11px 10px", borderRadius:12, marginBottom:8, cursor:"pointer", background:selected?C.white:C.surface, border:`1px solid ${selected?C.white:C.cardB}` }}>
                <div style={{ fontSize:21, flexShrink:0 }}>{v.emoji}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap" }}>
                    <span style={{ fontWeight:700, fontSize:13, color:selected?C.black:C.text }}>{v.name}</span>
                    {v.isDefault && <span style={{ fontSize:9, fontWeight:700, letterSpacing:.6, color:selected?C.black:C.muted, opacity:.65 }}>DEFAULT</span>}
                  </div>
                  <div style={{ fontSize:11, color:selected?C.black:C.muted, opacity:selected?.75:1 }}>{v.traits}</div>
                </div>
                <button onClick={e => { e.stopPropagation(); speak(v.previewLine, { voiceId:v.id }); }} aria-label={`Preview ${v.name}`} title="Play preview"
                  style={{ width:32, height:32, borderRadius:"50%", flexShrink:0, border:`1px solid ${selected?C.black:C.cardB}`, background:"transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:selected?C.black:C.text, fontSize:12 }}>▶</button>
              </div>
            );
          })}
          <Mono style={{ display:"block", color:C.white, marginTop:6, marginBottom:8 }}>Speaking speed</Mono>
          <div style={{ display:"flex", gap:8, marginBottom:10 }}>
            {[{ m:0.85, l:"Slower" }, { m:1.0, l:"Normal" }, { m:1.15, l:"Faster" }].map(s => (
              <button key={s.l} onClick={() => onSetVoiceSpeed(s.m)} style={{ flex:1, padding:"9px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:(voiceSpeed||1)===s.m?C.white:C.surface, border:`1px solid ${(voiceSpeed||1)===s.m?C.white:C.cardB}`, color:(voiceSpeed||1)===s.m?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>
                {s.l}
              </button>
            ))}
          </div>
          <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>Tap a voice to hear it and select it, or use ▶ to preview without switching. Volume follows your device's own volume control. The exact voice available for each option depends on your device and browser.</Mono>
        </ProfileRow>
        <ProfileRow label="Appearance" sub={theme==="dark" ? "Dark mode" : "Light mode"} expanded={openRow==="appearance"} onToggle={()=>toggle("appearance")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:12 }}>Switch between dark and light. Both use only black, white and off-white — no grey.</Mono>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => onToggleTheme("dark")} style={{ flex:1, padding:"11px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:theme==="dark"?C.white:C.surface, border:`1px solid ${theme==="dark"?C.white:C.cardB}`, color:theme==="dark"?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>
              Dark
            </button>
            <button onClick={() => onToggleTheme("light")} style={{ flex:1, padding:"11px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:theme==="light"?C.white:C.surface, border:`1px solid ${theme==="light"?C.white:C.cardB}`, color:theme==="light"?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>
              Light
            </button>
          </div>
        </ProfileRow>
        <ProfileRow label="Assistant Personality" sub="Direct, warm, concise" expanded={openRow==="personality"} onToggle={()=>toggle("personality")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>KROFT responds in a clear, grounded tone by default — no filler, no forced enthusiasm.</Mono>
        </ProfileRow>
        <ProfileRow label="Notifications"
          sub={notifPermission === "granted" ? "On for this device" : notifPermission === "denied" ? "Blocked in browser settings" : notifPermission === "unsupported" ? "Not supported here" : "Not enabled"}
          expanded={openRow==="notifs"} onToggle={()=>toggle("notifs")}>

          {notifPermission === "unsupported" && (
            <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>
              This browser doesn't support notifications.
            </Mono>
          )}

          {notifPermission === "denied" && (
            <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>
              Notifications are blocked for this site. Your browser only asks once, so you'll need to
              re-allow them in site settings — usually the icon beside the address bar.
            </Mono>
          )}

          {notifPermission === "default" && (
            <>
              {/* Explained before the prompt, for the same reason as the microphone: browsers ask
                  once, and a denial is effectively permanent. */}
              <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:12 }}>
                Get told about an appointment ten minutes before it starts, a reminder when it's due,
                and a category going over budget. Nothing else.
              </Mono>
              <Btn sm onClick={onEnableNotifications}>Turn on notifications</Btn>
            </>
          )}

          {notifPermission === "granted" && (
            <>
              {[
                { k:"appointments", label:"Appointments", sub:"10 minutes before" },
                { k:"reminders",    label:"Reminders",    sub:"When one is due" },
                { k:"budgets",      label:"Budget alerts", sub:"At 80% and over" },
              ].map(row => (
                <div key={row.k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, gap:12 }}>
                  <div style={{ minWidth:0 }}>
                    <Mono style={{ color:C.soft, display:"block" }}>{row.label}</Mono>
                    <Mono style={{ color:C.muted, display:"block" }}>{row.sub}</Mono>
                  </div>
                  <ProfileSwitch value={!!notifPrefs[row.k]} onChange={v => onSetNotifPref(row.k, v)} />
                </div>
              ))}
              {/* The one notification a free account can't get at all — shown either way so
                  free users see what upgrading buys them, rather than the feature simply not
                  existing on their screen. */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, gap:12 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <Mono style={{ color:C.soft }}>Daily brief</Mono>
                    {!subscribed && <Tag tone="accent">Plus</Tag>}
                  </div>
                  <Mono style={{ color:C.muted, display:"block" }}>{subscribed ? "One AI summary, around 8am" : "Upgrade to get an unprompted morning summary"}</Mono>
                </div>
                {subscribed
                  ? <ProfileSwitch value={!!notifPrefs.dailyBrief} onChange={v => onSetNotifPref("dailyBrief", v)} />
                  : <Btn sm v="outline" disabled={billingLoading} onClick={onUpgrade}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Upgrade"}</Btn>}
              </div>
              <Btn sm v="outline" onClick={onTestNotification} style={{ marginTop:4 }}>Send a test</Btn>
              {/* Stated plainly rather than letting people assume background delivery works. */}
              <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginTop:11 }}>
                These arrive while KROFT is open in a tab, including in the background. They won't
                arrive once the browser is fully closed.
              </Mono>
            </>
          )}
        </ProfileRow>
      </Card>
    </div>
  );

  // ── DRILL-DOWN: PRODUCTIVITY ──
  if (screen === "productivity") return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <ProfileScreenHeader title="Productivity" onBack={goBack} />
      <Card style={{ padding:"2px 16px" }}>
        <ProfileRow label="Calendar Connections" sub={[user.connected.calendar&&"Google Calendar",user.connected.outlookCalendar&&"Outlook Calendar"].filter(Boolean).join(" + ")||"Not linked"} expanded={openRow==="cal"} onToggle={()=>toggle("cal")}>
          <Btn sm v="outline" onClick={onEditPreferences}>Manage connections</Btn>
        </ProfileRow>
        <ProfileRow label="Email Accounts" sub={[user.connected.gmail&&"Gmail",user.connected.outlookMail&&"Outlook"].filter(Boolean).join(" + ")||"Not linked"} expanded={openRow==="mail"} onToggle={()=>toggle("mail")}>
          <Btn sm v="outline" onClick={onEditPreferences}>Manage connections</Btn>
        </ProfileRow>
        <ProfileRow label="Linked Apps" sub={`${Object.values(user.connected).filter(Boolean).length} connected`} expanded={openRow==="apps"} onToggle={()=>toggle("apps")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>Gmail, Google Calendar, Outlook Mail and Outlook Calendar can each be linked from Preferences. Uber works automatically — no linking needed.</Mono>
        </ProfileRow>
        <ProfileRow label="Smart Automations" sub="Reminders, briefings, insights" expanded={openRow==="auto"} onToggle={()=>toggle("auto")}
          right={<ProfileSwitch value={proactiveInsights} onChange={onSetProactiveInsights} />}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{proactiveInsights ? "KROFT proactively surfaces reminders and daily insights." : "KROFT will only respond when asked."}</Mono>
        </ProfileRow>
      </Card>
    </div>
  );

  // ── DRILL-DOWN: PRIVACY & SECURITY ──
  if (screen === "privacy") return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <ProfileScreenHeader title="Privacy & Security" onBack={goBack} />
      <Card style={{ padding:"2px 16px" }}>
        <ProfileRow label="Face ID" sub={user.webauthnCredentialId ? "Enabled for this device" : "Not set up"} expanded={openRow==="faceid"} onToggle={()=>toggle("faceid")}
          right={<ProfileSwitch value={!!user.webauthnCredentialId} onChange={v => v ? onSetupBiometric() : onRemoveBiometric()} />}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>Biometric sign-in uses your device's real WebAuthn platform authenticator (Face ID, Touch ID, or Windows Hello) — turning this on will prompt an actual biometric check on this device, not just a toggle.</Mono>
        </ProfileRow>
        <ProfileRow label="Devices" sub="1 active session" expanded={openRow==="devices"} onToggle={()=>toggle("devices")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>This device — signed in now.</Mono>
        </ProfileRow>
        <ProfileRow label="Privacy Controls" sub="Data sharing, visibility" expanded={openRow==="privacy"} onToggle={()=>toggle("privacy")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>Your data stays scoped to your own account and is never shared with other KROFT users.</Mono>
        </ProfileRow>
        <ProfileRow label="Backup & Restore" sub="Download a copy of everything" expanded={openRow==="data"} onToggle={()=>toggle("data")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:12 }}>
            {isSupabaseConfigured
              ? "Signed in with a real account, your data already syncs to your own account in the cloud — this backup is just an extra copy, useful for switching devices or keeping an offline copy. Your password is never included in the file."
              : "KROFT keeps your data on this device only — nothing is uploaded. That also means clearing your browser data erases it permanently, so download a backup you can keep somewhere safe. Your password is never included in the file."}
          </Mono>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <Btn sm onClick={onExportData}>Download backup</Btn>
            <Btn sm v="outline" onClick={() => fileInputRef.current?.click()}>Restore from file</Btn>
          </div>
          <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display:"none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) onImportData(f); e.target.value = ""; }} />
          <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginTop:11 }}>
            Restoring replaces everything currently {isSupabaseConfigured ? "in your account" : "on this device"}.
          </Mono>
        </ProfileRow>
      </Card>
    </div>
  );

  // ── DRILL-DOWN: SUBSCRIPTION ──
  if (screen === "subscription") return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <ProfileScreenHeader title="Subscription" onBack={goBack} />

      <Card style={{ marginBottom:16, border:`1px solid ${C.border}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
          <div style={{ fontSize:16, fontWeight:800, color:C.white }}>{subscribed ? "KROFT Plus" : "Free Plan"}</div>
          <Tag tone={subscribed?"positive":undefined}>{subscribed ? "Active" : "Current"}</Tag>
        </div>
        {/* Chat, AI drafts/suggestions and monthly reports are unlimited on every plan — nothing
            to meter. Voice is the one AI pool still worth a real allowance: an open-ended spoken
            conversation is a materially different resource than a one-shot text call. */}
        {!subscribed && (() => {
          const pct = Math.min(100, (voiceTurnsCount/voiceLimit)*100);
          const barColor = pct>=90?C.negative:pct>=70?C.warning:C.accent;
          return (
            <div style={{ marginBottom:11 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <Mono style={{ color:C.soft }}>Voice mode</Mono>
                <Mono style={{ color:C.muted }}>{voiceTurnsCount}/{voiceLimit} today</Mono>
              </div>
              <div style={{ background:C.surface, borderRadius:99, height:6, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${pct}%`, background:barColor, borderRadius:99, transition:"width .3s ease" }} />
              </div>
            </div>
          );
        })()}
        {subscribed && (
          <Mono style={{ display:"block", color:C.soft, marginBottom:14 }}>Unlimited chat, voice, drafts and reports.</Mono>
        )}
        {subscribed
          ? <Btn sm v="outline" disabled={billingLoading} onClick={onManageBilling}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Cancel plan"}</Btn>
          : <Btn sm disabled={billingLoading} onClick={onUpgrade}>{billingLoading ? <Spinner size={14} color={C.black} thickness={2} /> : "Upgrade to KROFT Plus"}</Btn>}
      </Card>

      <Card style={{ padding:"2px 16px" }}>
        <ProfileRow label="What's in Plus" sub={subscribed ? "Active" : "Free plan"} expanded={openRow==="plus"} onToggle={()=>toggle("plus")}>
          {/* The free tier isn't a stripped-down trial — finances, budgets, contacts, notes,
              recurring transactions, notifications, AI chat, drafts/suggestions and monthly
              reports are complete and stay free permanently. Plus is specifically about voice
              (a materially more expensive resource — open-ended spoken conversation) and a
              handful of real conveniences, not gating basic text usage. */}
          <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:12 }}>
            {[
              { t:"Unlimited voice mode", d:`Talk to KROFT as much as you want, hands-free — free plan gets ${voiceLimit} voice turns a day.` },
              { t:"Budget rollover", d:"Unused budget carries into next month instead of resetting to zero." },
              { t:"Longer conversation memory", d:"KROFT remembers more of a long conversation — 60 messages of context instead of 20." },
              { t:"Scheduled reminder calls", d:"Set a time and KROFT rings you in the app, speaks the reminder, and can talk it through if you answer." },
            ].map(b => (
              <div key={b.t} style={{ display:"flex", gap:9, alignItems:"flex-start" }}>
                <Dot color={C.positive} />
                <div>
                  <div style={{ fontSize:12.5, fontWeight:600, color:C.text }}>{b.t}</div>
                  <Mono style={{ color:C.muted, lineHeight:1.5 }}>{b.d}</Mono>
                </div>
              </div>
            ))}
          </div>
          <Mono style={{ display:"block", color:C.muted, lineHeight:1.6, marginBottom:12, paddingTop:10, borderTop:`1px solid ${C.div}` }}>
            Finances, budgets, contacts, notes, tasks, recurring transactions and notifications are complete on the free plan and always will be — Plus is only about the AI calls above.
          </Mono>
          {!subscribed && <Btn sm disabled={billingLoading} onClick={onUpgrade}>{billingLoading ? <Spinner size={14} color={C.black} thickness={2} /> : "Upgrade"}</Btn>}
        </ProfileRow>
        <ProfileRow label="Billing" sub={subscriptionStatus === "past_due" ? "Renewal failed — action needed" : subscribed ? "Active" : "No payment method on file"} expanded={openRow==="billing"} onToggle={()=>toggle("billing")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:10 }}>
            {subscriptionStatus === "past_due"
              ? "Your last renewal charge failed, so Plus access has paused. Resubscribe below to restore it."
              : subscribed
              ? "Your subscription and card are held by our secure payment partner, not KROFT. There's no self-serve billing portal — cancel here any time, or contact support for a receipt."
              : "Upgrading opens a secure checkout — KROFT never sees or stores your card details directly."}
          </Mono>
          {subscribed && !autoRenews && (
            <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginBottom:10 }}>
              Your current payment method doesn't automatically renew — you'll need to manually resubscribe before your current period ends.
            </Mono>
          )}
          {!subscribed && (
            <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginBottom:10 }}>
              KROFT Plus renews automatically only with a card. Bank transfer, USSD, and mobile money are also accepted at checkout, but those don't auto-renew — you'd need to manually resubscribe each cycle.
            </Mono>
          )}
          {subscribed && <Btn sm v="outline" disabled={billingLoading} onClick={onManageBilling}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Cancel plan"}</Btn>}
          {!subscribed && (
            <Btn sm disabled={billingLoading} onClick={onUpgrade}>{billingLoading ? <Spinner size={14} color={C.black} thickness={2} /> : subscriptionStatus === "past_due" ? "Resubscribe" : "Upgrade"}</Btn>
          )}
        </ProfileRow>
        <ProfileRow label="Payment Methods" sub={subscribed ? "On file with our payment partner" : "None on file"} expanded={openRow==="paymethods"} onToggle={()=>toggle("paymethods")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:subscribed?10:0 }}>
            {subscribed
              ? "Card details live with our payment partner, not KROFT. There's no self-serve way to swap the card on an active plan — cancel here, then re-subscribe with the new card."
              : "Card entry happens through our secure payment partner once you upgrade to KROFT Plus."}
          </Mono>
          {subscribed && <Btn sm v="outline" disabled={billingLoading} onClick={onManageBilling}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Cancel plan"}</Btn>}
        </ProfileRow>
        <ProfileRow label="Usage Statistics" sub="Real activity from this session" expanded={openRow==="usage"} onToggle={()=>toggle("usage")}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
            {[
              { l:"Voice turns today", v: voiceTurnsCount, ai:true },
              { l:"Total AI messages", v: usageStats.totalMessages, ai:true },
              { l:"Appointments", v: usageStats.appts },
              { l:"Finance entries", v: usageStats.financeEntries },
              { l:"Notes", v: usageStats.notes },
              { l:"Tasks", v: usageStats.tasks },
            ].map(s => (
              <div key={s.l} style={{ background:s.ai?C.accentBg:C.surface, borderRadius:12, padding:"10px 12px", border:s.ai?`1px solid ${C.accent}33`:"none" }}>
                <div style={{ fontSize:18, fontWeight:800, color:s.ai?C.accent:C.white }}>{s.v}</div>
                <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{s.l}</Mono>
              </div>
            ))}
          </div>
        </ProfileRow>
        <ProfileRow label="Manage Subscription" sub={subscribed ? "Change or cancel plan" : "You're on the free plan"} expanded={openRow==="managesub"} onToggle={()=>toggle("managesub")}>
          {subscribed ? (
            <>
              <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:10 }}>You're on KROFT Plus. Cancel any time, right here — there's no separate billing site to visit.</Mono>
              <Btn sm v="outline" disabled={billingLoading} onClick={onManageBilling}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Cancel plan"}</Btn>
            </>
          ) : (
            <>
              <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:10 }}>Nothing to manage yet — upgrade to KROFT Plus to remove your daily message limit.</Mono>
              <Btn sm disabled={billingLoading} onClick={onUpgrade}>{billingLoading ? <Spinner size={14} color={C.black} thickness={2} /> : "Upgrade"}</Btn>
            </>
          )}
        </ProfileRow>
      </Card>
    </div>
  );

  // ── DRILL-DOWN: SUPPORT ──
  if (screen === "support") return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <ProfileScreenHeader title="Support" onBack={goBack} />
      <Card style={{ padding:"2px 16px" }}>
        <ProfileRow label="Help Center" sub="Guides and answers" expanded={openRow==="help"} onToggle={()=>toggle("help")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>Help articles will appear here once connected to Virt Technologies' support content.</Mono>
        </ProfileRow>
        <ProfileRow label="Contact Support" sub="Something not working right" expanded={openRow==="report"} onToggle={()=>toggle("report")}>
          <textarea
            placeholder="Describe what happened…"
            rows={3}
            value={supportMsg}
            onChange={e => { setSupportMsg(e.target.value); setSupportSent(false); }}
            style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:8 }}
          />
          <Btn
            sm
            disabled={!supportMsg.trim()}
            onClick={() => {
              window.location.href = `mailto:support@virttechnologies.com?subject=${encodeURIComponent("KROFT support request")}&body=${encodeURIComponent(supportMsg)}`;
              setSupportSent(true);
            }}
          >
            Send report
          </Btn>
          {supportSent && <Mono style={{ display:"block", color:C.soft, marginTop:8 }}>Opening your email app to send this to support@virttechnologies.com.</Mono>}
        </ProfileRow>
        <ProfileRow label="Send Feedback" sub="Tell us what to build next" expanded={openRow==="feature"} onToggle={()=>toggle("feature")}>
          <textarea
            placeholder="What would make KROFT better?"
            rows={3}
            value={feedbackMsg}
            onChange={e => { setFeedbackMsg(e.target.value); setFeedbackSent(false); }}
            style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:8 }}
          />
          <Btn
            sm
            disabled={!feedbackMsg.trim()}
            onClick={() => {
              window.location.href = `mailto:feedback@virttechnologies.com?subject=${encodeURIComponent("KROFT feature idea")}&body=${encodeURIComponent(feedbackMsg)}`;
              setFeedbackSent(true);
            }}
          >
            Submit idea
          </Btn>
          {feedbackSent && <Mono style={{ display:"block", color:C.soft, marginTop:8 }}>Opening your email app to send this to feedback@virttechnologies.com.</Mono>}
        </ProfileRow>
        <ProfileRow label="About Kroft" sub="Version, legal, credits" expanded={openRow==="about"} onToggle={()=>toggle("about")}>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>KROFT by Virt Technologies. Your personal AI assistant.</Mono>
        </ProfileRow>
      </Card>
    </div>
  );

  // ── MAIN HUB ──
  const CATEGORIES = [
    { key:"ai",           label:"AI & Personalization", sub:"Preferences, memory, voice, appearance" },
    { key:"productivity",  label:"Productivity",         sub:"Calendar, email, automations" },
    { key:"privacy",       label:"Privacy & Security",   sub:"Face ID, devices, data" },
    { key:"subscription",  label:"Subscription",         sub:"KROFT Plus, billing, usage" },
    { key:"support",       label:"Support",              sub:"Help, feedback, about" },
  ];

  return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      {/* Header */}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", marginBottom:28 }}>
        <div style={{ width:84, height:84, borderRadius:"50%", overflow:"hidden", background:user.photo?`url(${user.photo}) center/cover no-repeat`:C.surface, border:`2px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, fontWeight:800, color:C.white, marginBottom:14 }}>
          {!user.photo && initials}
        </div>
        {editingName ? (
          <div style={{ width:"100%", maxWidth:260, marginBottom:10 }}>
            <Inp autoFocus value={nameDraft} onChange={e=>setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key==="Enter") saveName(); if (e.key==="Escape") cancelEditName(); }}
              placeholder="What should KROFT call you?" style={{ textAlign:"center", marginBottom:8 }} />
            <div style={{ display:"flex", gap:7 }}>
              <Btn sm v="outline" onClick={cancelEditName} style={{ flex:1 }}>Cancel</Btn>
              <Btn sm disabled={!nameDraft.trim()} onClick={saveName} style={{ flex:1 }}>Save</Btn>
            </div>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
            <div style={{ fontSize:20, fontWeight:800, color:C.white, letterSpacing:-.5 }}>{user.name || "Your name"}</div>
            <button onClick={() => { setNameDraft(user.name||""); setEditingName(true); }} aria-label="Edit your name" title="Edit your name"
              style={{ background:"none", border:"none", cursor:"pointer", padding:4, color:C.muted, display:"flex", alignItems:"center" }}>
              <NavIcon id="edit" size={14} color={C.muted} />
            </button>
          </div>
        )}
        {!editingName && <Mono style={{ color:C.muted, marginBottom:12 }}>Powered by Virt Technologies</Mono>}
        <div style={{ display:"flex", gap:7, flexWrap:"wrap", justifyContent:"center" }}>
          <Tag tone="positive">Online</Tag>
          {/* "Synced" claimed cloud sync even in local-only mode, where nothing syncs anywhere
              — this reflects which one is actually true for this deployment. */}
          {isSupabaseConfigured ? <Tag tone="accent">Synced</Tag> : <Tag>Local only</Tag>}
          {user.webauthnCredentialId && <Tag tone="positive">Face ID enabled</Tag>}
        </div>
      </div>

      {/* Compact category list — tap to drill in, nothing expands inline here */}
      <Card style={{ padding:"2px 16px", marginBottom:20 }}>
        {CATEGORIES.map((c, i) => (
          <ProfileCategoryRow key={c.key} label={c.label} sub={c.sub} onClick={() => goTo(c.key)} isLast={i===CATEGORIES.length-1} />
        ))}
      </Card>

      <Btn v="outline" full onClick={onSignOut} style={{ padding:"13px", fontSize:13 }}>Sign Out</Btn>
    </div>
  );
}

// Catches runtime errors anywhere in the app tree and shows a recoverable fallback screen
// instead of letting React unmount everything to a blank white page. Without this, a single
// bad state access in any one tab (a null contact, a malformed date, etc.) would crash the
// entire app for the user with no way back in short of a full reload.
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("KROFT crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:C.bg, color:C.text, fontFamily:"'Space Grotesk',sans-serif", padding:24 }}>
          <div style={{ maxWidth:360, textAlign:"center" }}>
            <div style={{ fontSize:34, marginBottom:14 }}>⚠️</div>
            <div style={{ fontSize:18, fontWeight:700, marginBottom:8 }}>Something went wrong</div>
            <div style={{ fontSize:13, color:C.soft, marginBottom:22, lineHeight:1.5 }}>
              KROFT hit an unexpected error. Your saved data is safe — it's stored separately and wasn't affected.
            </div>
            {/* Two ways out. "Try again" re-renders the same tree, which lands straight back on
                the error if the cause hasn't changed — so a reload is offered alongside it.
                Neither touches stored data. */}
            <div style={{ display:"flex", gap:9, justifyContent:"center" }}>
              <button
                onClick={() => this.setState({ error: null })}
                style={{ background:C.white, color:C.black, border:"none", borderRadius:12, padding:"11px 22px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Space Grotesk',sans-serif" }}
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{ background:"transparent", color:C.text, border:`1px solid ${C.border}`, borderRadius:12, padding:"11px 22px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Space Grotesk',sans-serif" }}
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Base64url <-> ArrayBuffer helpers for WebAuthn credential IDs, which need to round-trip
// through JSON (persisted storage) as plain strings rather than binary.
const bufToBase64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const base64urlToBuf = str => {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const base64 = (str + pad).replace(/-/g,"+").replace(/_/g,"/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// SHA-256 password hashing with a random per-account salt, via the Web Crypto API. This is not
// a substitute for a real backend with a slow/memory-hard KDF (bcrypt/scrypt/argon2) — there's
// no server here to rate-limit attempts or keep a pepper secret — but it's a real step up from
// storing the plain-text password, which matters now that account data is written to persistent
// storage rather than living only in memory for the session.
const generateSalt = () => bufToBase64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
const hashPassword = async (password, salt) => {
  const enc = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return bufToBase64url(digest);
};

// Storage key groups for window.storage persistence — module-level since the mapping never
// changes, so it doesn't need to be recreated on every render.
const STORAGE_KEYS = {
  profile: "kroft:profile",
  finance: "kroft:finance",
  productivity: "kroft:productivity",
  calendarData: "kroft:calendar",
  contactsData: "kroft:contacts",
  projectsData: "kroft:projects",
  chatData: "kroft:chat",
  wellnessData: "kroft:wellness",
  emailData: "kroft:emails",
  // Kept separate from `productivity` rather than folded in: voice memo audio (now a data: URL,
  // see toggleVoiceMemo) can run to hundreds of KB per recording, and productivity's save effect
  // fires on every small task/note edit — bundling memos in would mean re-writing all that audio
  // on every unrelated edit instead of only when a memo itself actually changes.
  voiceMemosData: "kroft:voicememos",
  // Same reasoning as voiceMemosData, and the same underlying bug it fixed: uploaded files (see
  // the Files upload handler) can run well into the megabytes, so they get their own save effect
  // rather than riding along on every unrelated productivity edit.
  filesData: "kroft:files",
};

function KroftApp({ onFullReset } = {}) {
  // Theme: "dark" or "light". C's properties are reassigned in place (see effect below)
  // rather than swapping which object C points to, since ~250 style props across this file
  // already read C.xxx directly. themeTick forces React to re-render after that mutation,
  // since mutating an object in place doesn't itself trigger a re-render.
  const [theme, setTheme] = useState("light");
  const [themeTick, setThemeTick] = useState(0);
  // Applied during render rather than in an effect, so the mutation lands before the browser
  // paints. Doing it in an effect meant one frame was drawn with the previous theme's colours
  // every time the theme changed, including on the initial load.
  const appliedTheme = useRef(null);
  if (appliedTheme.current !== theme) {
    Object.assign(C, theme === "dark" ? DARK : LIGHT);
    appliedTheme.current = theme;
  }
  useEffect(() => { setThemeTick(t => t + 1); }, [theme]);

  // Declared before the splash effect below, which reads it — a const referenced above its
  // declaration throws on first render.
  const [dataLoaded, setDataLoaded] = useState(false);

  // Splash screen. This used to run on a hard 6-second timer regardless of how fast the app was
  // ready — storage reads finish in milliseconds, so nearly six of those seconds were pure
  // waiting on every single launch. For an assistant built around quick capture that was longer
  // than the task itself. It now clears as soon as data is loaded, with a short floor so it
  // doesn't flash past too fast to read, and a ceiling so a slow or failed read can't strand
  // anyone behind it. Skeletons cover whatever is still loading underneath.
  const SPLASH_MIN = 900, SPLASH_MAX = 4000;
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStart = useRef(Date.now());
  useEffect(() => {
    if (!showSplash) return;
    const dismiss = () => {
      setSplashFading(true);
      setTimeout(() => setShowSplash(false), 420);
    };
    if (dataLoaded) {
      const elapsed = Date.now() - splashStart.current;
      const wait = Math.max(0, SPLASH_MIN - elapsed);
      const t = setTimeout(dismiss, wait);
      return () => clearTimeout(t);
    }
    // Safety net: never hold someone here because storage stalled.
    const t = setTimeout(dismiss, SPLASH_MAX);
    return () => clearTimeout(t);
  }, [dataLoaded, showSplash]);

  // Persistent storage — window.storage is the only persistence layer available in this
  // sandbox (localStorage/sessionStorage are unsupported here and would silently fail).
  // Data is grouped into a handful of keys rather than one per array, since storage writes
  // are rate-limited and every keystroke touching its own key would burn through that fast.
  // NOT persisted, by design: Files and Voice Memos, whose blob: URLs are only valid for the
  // current page load — restoring them after a reload would just show broken/unopenable
  // entries, which is worse than an honest "these don't survive a refresh yet." Also not
  // persisted: purely transient UI state (which modal is open, draft form fields).

  // Voice Replies preference — lives here (not in ProfileSection) because it needs to gate
  // the auto-speak calls below (chat replies, appointment reminders, mood check-ins). Explicit
  // "Read Aloud"/"Play" taps elsewhere always speak regardless of this setting.
  const [voiceReplies, setVoiceReplies] = useState(true);

  // Proactive Insights preference — same reasoning: gates the passive 3x-daily finance nudge
  // below. When off, KROFT should only respond when asked, not surface unprompted toasts.
  const [proactiveInsights, setProactiveInsights] = useState(true);

  // Which of the four KROFT voices (Ben/Atlas/Mira/Nova — see VOICE_PROFILES) KROFT speaks
  // with — persisted per-account like every other preference here. Kept in sync with the
  // module-level TTS functions below, since speak()/speakSequence() live outside React and read
  // preferredVoiceId directly rather than taking it as an argument on every call site.
  const [voicePref, setVoicePref] = useState(DEFAULT_VOICE_ID);
  useEffect(() => { setPreferredVoiceId(voicePref); }, [voicePref]);
  // Speed multiplier applied on top of the selected voice's own base pace (Settings'
  // Slower/Normal/Faster) — the accessibility "speech speed setting" the voice spec calls for.
  const [voiceSpeed, setVoiceSpeed] = useState(1.0);
  useEffect(() => { setPreferredVoiceSpeed(voiceSpeed); }, [voiceSpeed]);

  // Starts at signup. With Supabase configured, the load effect below jumps straight to the
  // dashboard when a real session already exists (a returning, still-signed-in user), the same
  // way any app with real sessions keeps you signed in across a reload. Without Supabase
  // configured (local-only mode), it instead switches to login once a saved local account is
  // found, matching this app's original device-local behavior.
  const [step, setStep] = useState("signup");
  // True only while "business" or "prefs" is showing because Profile's Edit Details /
  // Preferences opened it on an already-signed-in account — as opposed to the same two screens
  // showing as part of first-time onboarding, reached by signing up. Both cases render the same
  // step and the same form, but they need different Back/Save destinations: onboarding chains
  // photo -> business -> prefs -> done -> dashboard, while an edit from Profile should return
  // straight to the dashboard, never forward into onboarding's later screens or back through
  // "photo" into "signup" — landing back on the signup screen while editing your own account
  // details was exactly the bug this flag exists to prevent.
  const [editingFromProfile, setEditingFromProfile] = useState(false);
  // True while a signup/login request to Supabase Auth is in flight, so the button can show a
  // spinner and can't be double-submitted by an impatient extra click.
  const [authLoading, setAuthLoading] = useState(false);
  const [user, setUser] = useState({ name:"", email:"", password:"", phone:"", photo:null, businessName:"", businessType:"", currency:"USD", connected:{gmail:false,calendar:false,uber:false,outlookMail:false,outlookCalendar:false} });
  // Real Google connection state, as reported by api/google/status.js — the actual source of
  // truth for whether Gmail/Calendar are linked. user.connected.gmail/.calendar (persisted,
  // used for the read-only status text elsewhere in Profile) is kept in sync with this rather
  // than being toggled directly by the Link button, now that linking means a real OAuth grant
  // rather than a local flag flip. user.connected.uber stays a plain local toggle — see the
  // "Connect accounts" list below for why.
  const [googleStatus, setGoogleStatus] = useState({ gmail:false, calendar:false });
  const [googleLinking, setGoogleLinking] = useState(false);
  // Microsoft/Outlook, same shape and reasoning as googleStatus/googleLinking above — see
  // api/microsoft/status.js. Kept as separate state (rather than a generic {provider: {...}}
  // map) since Gmail/Calendar and Outlook Mail/Calendar are each rendered as their own rows in
  // Preferences with independent connect/disconnect actions.
  const [microsoftStatus, setMicrosoftStatus] = useState({ mail:false, calendar:false });
  const [microsoftLinking, setMicrosoftLinking] = useState(false);
  const [syncingMail, setSyncingMail] = useState(false);
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  // True while a checkout redirect or a cancellation is in flight, so the Upgrade/Cancel plan
  // buttons throughout Profile can't be double-clicked into two requests.
  const [billingLoading, setBillingLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [showLoginPw, setShowLoginPw] = useState(false);
  const [loginError, setLoginError] = useState("");
  // Forgot-password mini-flow, inline on the login screen — only meaningful with a real
  // Supabase account (it emails a reset link through Supabase Auth); local-only mode's
  // password is just a local hash with no email service behind it to reset through.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState("");
  // Set-new-password screen, reached only via the link Supabase emails from the request above
  // (see the recovery-redirect effect near the other query-param handlers below).
  const [newPw, setNewPw] = useState("");
  const [confirmNewPw, setConfirmNewPw] = useState("");
  const [resetPwLoading, setResetPwLoading] = useState(false);
  const [resetPwError, setResetPwError] = useState("");
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [locked, setLocked] = useState(false);
  const [lockTimer, setLockTimer] = useState(0);
  const [fpLoading, setFpLoading] = useState(false);
  const [fpSuccess, setFpSuccess] = useState(false);
  const [showSignupPw, setShowSignupPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  // The signup password draft lives here, separate from `user` — `user` autosaves to
  // persistent storage on every change (see the profile save effect), so keeping the raw
  // plaintext password there while someone is mid-typing would risk writing it to storage on
  // every keystroke before it ever gets hashed. Only the resulting hash+salt join `user`.
  const [signupPw, setSignupPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [signupError, setSignupError] = useState("");
  const [customCurrency, setCustomCurrency] = useState("");
  const [customCurrencyError, setCustomCurrencyError] = useState("");
  const galleryRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [cameraMode, setCameraMode] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [camStream, setCamStream] = useState(null);
  const [photoSource, setPhotoSource] = useState("");
  const [tab, setTab] = useState("home");
  const [homeSection, setHomeSection] = useState("overview");
  const [workspaceSection, setWorkspaceSection] = useState(null); // null = hub screen
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [incomeCats, setIncomeCats] = useState(["Invoice","Sales","Consulting","Freelance","Other"]);
  const [expenseCats, setExpenseCats] = useState(["Operations","Tech","Marketing","Travel","Rent","Other"]);
  // Filters for the income/expense lists — local UI state only, never persisted, since a filter
  // left on from a prior session would silently hide entries on the next visit.
  const [txnQuery, setTxnQuery] = useState("");
  const [txnFrom, setTxnFrom] = useState("");
  const [txnTo, setTxnTo] = useState("");
  // Monthly spending limits per category, as { [category]: amount }. Tracking spend without ever
  // warning about it means the app only tells you about a problem after the month is over.
  const [budgets, setBudgets] = useState({});
  // Categories already warned about this month, so an alert fires once at each threshold rather
  // than on every render or every new expense.
  const [budgetAlerts, setBudgetAlerts] = useState({});
  // Plus feature: unused budget carries into the next month instead of resetting to zero. Stored
  // as { [category]: amount } — computed once at each month's rollover from the previous month's
  // actual leftover, not accumulated further, so it rewards last month specifically rather than
  // letting an unused budget hoard indefinitely.
  const [budgetCarryover, setBudgetCarryover] = useState({});
  // The last month rollover was processed for, so it runs exactly once per month rather than
  // every time the heartbeat ticks.
  const [budgetRolloverMonth, setBudgetRolloverMonth] = useState(() => todayISO().slice(0, 7));
  // Percent of this month's net profit to flag as reserved for taxes — 0 means the feature is
  // off. Purely a display calculation; nothing is actually moved or withheld anywhere.
  const [taxSetAsidePct, setTaxSetAsidePct] = useState(0);
  // Notification settings, lifted out of ProfileSection where they were local state that nothing
  // read and nothing persisted. Each maps to a real trigger below.
  const [notifPrefs, setNotifPrefs] = useState({ appointments:true, reminders:true, budgets:true, dailyBrief:true });
  // The last date a daily brief notification was sent, so it fires exactly once per day rather
  // than every time the heartbeat ticks after the target hour.
  const [dailyBriefSentDate, setDailyBriefSentDate] = useState("");
  const [notifPermission, setNotifPermission] = useState(() => (typeof window !== "undefined" && "Notification" in window) ? Notification.permission : "unsupported");
  // Keys of notifications already delivered, so a reminder fires once rather than every minute
  // the checker runs. Persisted so a reload doesn't re-announce everything.
  const [notifSent, setNotifSent] = useState({});
  const [showBudgetEditor, setShowBudgetEditor] = useState(false);
  const [newInc, setNewInc] = useState({ label:"", amount:"", cat:"Invoice", date:todayISO(), repeat:"none" });
  const [newExp, setNewExp] = useState({ label:"", amount:"", cat:"Operations", date:todayISO(), repeat:"none" });
  const [showAddInc, setShowAddInc] = useState(false);
  const [showAddExp, setShowAddExp] = useState(false);
  const [monthlyReport, setMonthlyReport] = useState(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [weeklyRecap, setWeeklyRecap] = useState(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null); // { kind:"income"|"expenses", id, label, amount, date, cat }
  const [remindersFired, setRemindersFired] = useState({ date:"", slots:[] }); // tracks which of today's 3 nudges already fired
  const [emails, setEmails] = useState([
    { id:1, from:"Amaka Obi <amaka@brightpath.co>", subject:"Follow-up on our call", tag:"Client", time:"9:14 AM", read:false, body:"Hi, thanks for the walkthrough yesterday — could you send over the pricing sheet we discussed? Also wanted to confirm the timeline for the first milestone." },
    { id:2, from:"Sir Mubarak Isa Ibrahim <mi@ventures.ng>", subject:"Quick check-in", tag:"Investor", time:"Yesterday", read:false, body:"How's progress on the current build? Would like a short update whenever you have a moment — no rush." },
    { id:3, from:"Notion <team@notion.so>", subject:"Your weekly workspace summary", tag:"", time:"2 days ago", read:true, body:"Here's what happened in your workspace this week. 3 pages edited, 1 new comment, 0 overdue tasks." },
  ]);
  const [openEmail, setOpenEmail] = useState(null);
  const [composeDraft, setComposeDraft] = useState(null);
  const [appts, setAppts] = useState([]);
  const [newAppt, setNewAppt] = useState({ title:"", time:"", date:todayISO(), location:"", notes:"", urgent:false, repeat:"none", contactId:null });
  const [showAddAppt, setShowAddAppt] = useState(false);
  // Calendar had only ever been a flat chronological list — no grid, so there was no way to see
  // at a glance which days of a month actually have something on them. "list" keeps the original
  // view exactly as it was; "grid" is purely additive.
  const [calendarView, setCalendarView] = useState("list");
  const [calendarMonth, setCalendarMonth] = useState(() => todayISO().slice(0, 7));
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(null);
  const [openAppt, setOpenAppt] = useState(null);
  const [editingAppt, setEditingAppt] = useState(null);

  // Workspace — Notes
  const [notes, setNotes] = useState([]);
  // checklist:null = a plain text note; checklist:[{id,text,done}] (even empty) = a checklist
  // note — toggled via the Text/Checklist switch on the New/Edit forms.
  const [newNote, setNewNote] = useState({ title:"", body:"", contactId:null, checklist:null });
  const [showAddNote, setShowAddNote] = useState(false);
  const [openNote, setOpenNote] = useState(null);
  const [editingNote, setEditingNote] = useState(null);
  const [newNoteChecklistDraft, setNewNoteChecklistDraft] = useState("");
  const [editNoteChecklistDraft, setEditNoteChecklistDraft] = useState("");

  // Workspace — Tasks
  const [tasks, setTasks] = useState([]);
  const [newTask, setNewTask] = useState({ title:"", priority:"Normal", repeat:"none", contactId:null, dueDate:"" });
  const [showAddTask, setShowAddTask] = useState(false);
  const [editingTask, setEditingTask] = useState(null);

  // Workspace — Files
  const [files, setFiles] = useState([]);

  // Workspace — Projects
  const [projects, setProjects] = useState([]);
  const [newProject, setNewProject] = useState({ name:"", deadline:"", description:"", status:"Not Started" });
  const [showAddProject, setShowAddProject] = useState(false);
  const [openProject, setOpenProject] = useState(null);
  const [editingProject, setEditingProject] = useState(null);
  const [linkPicker, setLinkPicker] = useState(null); // { projectId, kind:"taskIds"|"noteIds"|"fileIds" }
  // Quick-add a task straight from inside a project, instead of forcing a trip to the Tasks
  // screen and back just to link it — addingTaskToProject holds which project's inline field
  // is open (only one at a time, same as linkPicker above).
  const [addingTaskToProject, setAddingTaskToProject] = useState(null);
  const [projectTaskDraft, setProjectTaskDraft] = useState("");
  // Milestones are the project's own big checkpoints ("Beta shipped", "Launched") — kept
  // separate from Tasks (the day-to-day grind) rather than a flag on some tasks, so a
  // project's goal progress reads at a glance instead of being buried in a task list.
  // Owned by the project itself, not linked from a shared pool, so no linkPicker entry for it.
  const [addingMilestoneToProject, setAddingMilestoneToProject] = useState(null);
  const [milestoneDraft, setMilestoneDraft] = useState("");
  // Same "+ New, auto-linked" pattern as Tasks/Milestones, extended to every other kind of
  // project content — a note, document, file, or Finance entry made from inside a project
  // never needs to be found again in the shared list, though it still lives in the one real
  // Notes/Documents/Files list, or (for income/expense) the one real Finance ledger.
  const [addingNoteToProject, setAddingNoteToProject] = useState(null);
  const [projectNoteDraft, setProjectNoteDraft] = useState("");
  const [addingDocumentToProject, setAddingDocumentToProject] = useState(null);
  const [projectDocumentDraft, setProjectDocumentDraft] = useState("");
  const projectFileUploadTarget = useRef(null);
  const projectFileInputRef = useRef(null);
  const [addEntryToProject, setAddEntryToProject] = useState(null); // { projectId, kind:"income"|"expense" }
  const [projectEntryDraft, setProjectEntryDraft] = useState({ label:"", amount:"", cat:"", date:todayISO(), repeat:"none" });

  // Workspace — Voice Memos
  const [voiceMemos, setVoiceMemos] = useState([]);
  const [editingMemo, setEditingMemo] = useState(null);

  // Workspace — Documents (longer-form, structured write-ups — distinct from quick Notes)
  const [documents, setDocuments] = useState([]);
  const [newDocument, setNewDocument] = useState({ title:"", body:"" });
  const [showAddDocument, setShowAddDocument] = useState(false);
  const [openDocument, setOpenDocument] = useState(null);
  const [editingDocument, setEditingDocument] = useState(null);
  const [recordingMemo, setRecordingMemo] = useState(false);
  const memoRecRef = useRef(null);
  const memoChunksRef = useRef([]);

  // Workspace — Reminders (smart, AI-suggested — separate from calendar appointment reminders)
  const [smartReminders, setSmartReminders] = useState([]);
  const [newReminder, setNewReminder] = useState({ text:"", when:"", contactId:null });
  const [editingReminder, setEditingReminder] = useState(null);
  const [showAddReminder, setShowAddReminder] = useState(false);
  // Plus: KROFT calls at a set time instead of just showing a reminder. { id, title, note, date,
  // time, status: "pending"|"answered"|"missed"|"declined" }. Honest limitation, same as every
  // other notification here: this only works while KROFT is open in a tab (foreground or
  // background) — there's no telephony behind it, so a fully closed browser gets nothing.
  const [scheduledCalls, setScheduledCalls] = useState([]);
  const [showScheduleCall, setShowScheduleCall] = useState(false);
  const [newCall, setNewCall] = useState({ title:"", note:"", date:todayISO(), time:"" });
  // The call currently ringing, if any — drives the full-screen incoming-call overlay.
  const [incomingCall, setIncomingCall] = useState(null);
  const callTimeoutRef = useRef(null);
  const callNotifiedRef = useRef({}); // ids already pushed as a system notification, so ringing doesn't re-notify every tick
  // The reminder currently taking over the screen (see ReminderAlarmScreen) — null when none is
  // ringing. alarmLoopRef holds the setInterval driving the repeating beep+vibrate while it's up.
  const [ringingReminder, setRingingReminder] = useState(null);
  const alarmLoopRef = useRef(null);


  // Workspace — Contacts (KROFT's own address book, separate from the phone's real contacts —
  // grouped into Business and Family so the two never blend together). Call/email buttons
  // deep-link out to the device's native dialer/mail app; KROFT doesn't place calls itself.
  const [contacts, setContacts] = useState([]);
  const [newContact, setNewContact] = useState({ name:"", phone:"", email:"", category:"business", note:"" });
  const [showAddContact, setShowAddContact] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [contactSearch, setContactSearch] = useState("");
  // Which contact group cards are open. Both start collapsed so the Contacts screen is just
  // "Business 3 / Family 0" at a glance — the people inside only appear once you open a group.
  const [openContactGroups, setOpenContactGroups] = useState([]);
  // Connects the Contacts book to the rest of the app: when set, shows a picker so
  // Email "Compose" pulls a real saved contact instead of going out blank.
  const [contactPicker, setContactPicker] = useState(null);
  const [contactActivity, setContactActivity] = useState(null); // holds a contact object when the "View Activity" drill-down is open
  // Holds the config for the press-and-hold action sheet: { title, subtitle, actions }.
  const [actionSheet, setActionSheet] = useState(null);

  const [mood, setMood] = useState("calm");
  const [moodLog, setMoodLog] = useState([]);
  // Wellness is scored for a specific day. Previously it was a single number that only ever went
  // up — "Took a break" and "Had water" were unlimited +5/+3 buttons, so it measured how often
  // you tapped rather than how you were doing, and the "today" label was wrong since it never
  // reset. Now the day is recorded alongside the score, self-care credits are capped per day,
  // and a new day starts fresh (see the rollover effect below).
  const [wellness, setWellness] = useState(75);
  const [wellnessDate, setWellnessDate] = useState(() => todayISO());
  // One entry per day the rollover effect has actually processed — the score only ever existed
  // as "today's number," so there was no way to see whether this week was actually better or
  // worse than last, only whatever single day happened to be showing. Capped like moodLog.
  const [wellnessHistory, setWellnessHistory] = useState([]);
  // Counts today's self-care taps so they can't be farmed to 100.
  const [selfCare, setSelfCare] = useState({ breaks:0, water:0 });
  const SELF_CARE_CAP = { breaks:4, water:6 };
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [toasts, setToasts] = useState([]);
  // Confetti is a rare, deliberate "moment" (see celebrate() below) — a single boolean is
  // enough since it's a fire-and-forget overlay; a second celebration while one is already
  // playing just keeps the current burst running rather than stacking bursts.
  const [showConfetti, setShowConfetti] = useState(false);
  const [hungry, setHungry] = useState(false);
  const [showBriefing, setShowBriefing] = useState(false);
  const [uberDest, setUberDest] = useState(null);
  const [aiMessages, setAiMessages] = useState([]);
  // Past conversations, most-recent first — { id, title, messages, updatedAt }. aiMessages is
  // only ever the ONE live/active conversation; starting a new chat or opening a saved one moves
  // whatever was active into this list first (see startNewChat/openHistoryChat) rather than just
  // discarding it, so nothing typed is ever permanently lost the way it used to be.
  const [chatHistory, setChatHistory] = useState([]);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [chatHistorySearch, setChatHistorySearch] = useState("");
  const [aiInput, setAiInput] = useState("");
  const [aiInputFocused, setAiInputFocused] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  // Drives the floating "scroll to bottom" button — shown only once someone has actually
  // scrolled up to re-read earlier messages, not on every render.
  const [chatNearBottom, setChatNearBottom] = useState(true);
  const aiInputRef = useRef(null);
  // Lets a long reply be cut off mid-stream. Held in a ref so the Stop button can reach the
  // controller for whichever request is currently in flight without re-rendering on every token.
  const aiAbortRef = useRef(null);
  const chatEnd = useRef(null);
  const recRef = useRef(null);

  // Subscription — real, session-local state. No payment processor is available in this
  // environment, so "upgrading" flips this flag rather than charging anything.
  // How long until a daily allowance resets. Being told you're out with no idea whether that
  // means an hour or a day is the difference between waiting and assuming the app is broken.
  const resetsIn = () => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const mins = Math.max(1, Math.round((midnight - now) / 60000));
    if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""}`;
    const hrs = Math.round(mins / 60);
    return `${hrs} hour${hrs !== 1 ? "s" : ""}`;
  };

  // Chat, AI drafts/suggestions, and monthly reports are plain text generation — genuinely
  // unlimited on every plan. api/chat.js enforces that by simply having no configured row for
  // those usage types in the plan_limits table (see supabase/schema.sql); there's nothing to
  // mirror client-side any more. Voice is the one AI pool that still has a real daily allowance
  // — a materially different resource (open-ended spoken conversation, not a one-shot text
  // call) — and its limit is fetched from the server via refreshUsageLimits() rather than
  // hardcoded here, so it can change without redeploying the app.
  const [usageLimits, setUsageLimits] = useState({}); // { voice: {limit, used, period, label}, ... } from GET /api/usage
  const FALLBACK_VOICE_LIMIT = 30; // shown only before the real server-configured value has loaded
  const voiceLimit = usageLimits.voice?.limit ?? FALLBACK_VOICE_LIMIT;
  const [voiceTurnsCount, setVoiceTurnsCount] = useState(0);
  const [voiceTurnsDate, setVoiceTurnsDate] = useState(() => new Date().toDateString());
  const voiceTurnsLeft = () => Math.max(0, voiceLimit - voiceTurnsCount);
  // Returns whether a voice turn may proceed, rolling the day over and incrementing on success.
  // This is an optimistic client-side mirror for instant UI feedback — api/chat.js's own count,
  // backed by the real ai_usage table, is what's actually enforced.
  const spendVoiceTurn = () => {
    const today = new Date().toDateString();
    let count = voiceTurnsCount;
    if (today !== voiceTurnsDate) { count = 0; setVoiceTurnsDate(today); setVoiceTurnsCount(0); }
    if (!subscribed && count >= voiceLimit) return false;
    if (!subscribed) setVoiceTurnsCount(count + 1);
    return true;
  };

  const [subscribed, setSubscribed] = useState(false);
  // Raw subscriptions.status ("inactive" | "active" | "past_due" | "canceled") — kept alongside
  // the derived `subscribed` boolean so the UI can tell "never subscribed" apart from "a renewal
  // charge failed", which needs its own notice rather than just silently losing Plus access.
  const [subscriptionStatus, setSubscriptionStatus] = useState("inactive");
  // Whether the payment method behind the current/last charge auto-renews (card) or not (bank
  // transfer, USSD, mobile money, or an unconfirmed wallet-pay) — see isRecurringCapablePayment
  // in api/_lib/flutterwave.js, which is what actually sets this on the server.
  const [autoRenews, setAutoRenews] = useState(false);

  // Loads all persisted groups from window.storage and applies them to state. window.storage.get
  // throws (not returns null) for a key that's never been written — expected for a first-ever
  // run, or for a user who's never saved this particular group — so each key is caught
  // individually rather than letting one missing key abort the whole load. Factored out of the
  // mount effect below so it can also be re-run right after a successful login: with Supabase
  // configured, storage is scoped to whichever user is currently signed in (see
  // storageShim.js), and at mount time nobody is signed in yet, so the mount-time call finds
  // nothing for a returning user logging back in — their real data only becomes reachable once
  // doLogin's supabase.auth.signInWithPassword() call succeeds.
  const hydrateAllGroups = async () => {
    const entries = await Promise.all(Object.entries(STORAGE_KEYS).map(async ([group, key]) => {
      try {
        const r = await window.storage.get(key, false);
        return [group, r?.value ? JSON.parse(r.value) : null];
      } catch { return [group, null]; }
    }));
    const data = Object.fromEntries(entries);
    if (data.profile) {
      const p = data.profile;
      if (p.user) setUser(u => ({ ...u, ...p.user }));
      if (p.theme) setTheme(p.theme);
      if (typeof p.voiceReplies === "boolean") setVoiceReplies(p.voiceReplies);
      if (typeof p.proactiveInsights === "boolean") setProactiveInsights(p.proactiveInsights);
      // resolveVoiceId maps a pre-persona save (the old female-1/male-2/etc. slot keys) forward
      // to its nearest new persona, so a returning user's saved choice never silently resets.
      if (typeof p.voicePref === "string") setVoicePref(resolveVoiceId(p.voicePref));
      if (typeof p.voiceSpeed === "number") setVoiceSpeed(p.voiceSpeed);
      if (p.notifPrefs) setNotifPrefs(v => ({ ...v, ...p.notifPrefs }));
      if (p.dailyBriefSentDate) setDailyBriefSentDate(p.dailyBriefSentDate);
      if (typeof p.voiceTurnsCount === "number") setVoiceTurnsCount(p.voiceTurnsCount);
      if (p.voiceTurnsDate) setVoiceTurnsDate(p.voiceTurnsDate);
      // Deliberately NOT restoring p.subscribed here. kv_store is writable by the account owner
      // themselves (see supabase/schema.sql's kv_store RLS policies) — trusting a self-persisted
      // "am I paying" flag would let anyone grant themselves Plus by editing their own profile
      // blob directly via the Supabase REST API. subscribed only ever becomes true through
      // refreshSubscriptionStatus's read of the server-verified subscriptions row (written only
      // by api/billing/webhook.js and api/billing/callback.js); defaulting to false here just
      // means a brief flash of "Free plan" until that fetch resolves, not a lasting gap.
      if (typeof p.taxSetAsidePct === "number") setTaxSetAsidePct(p.taxSetAsidePct);
      if (Array.isArray(p.incomeCats)) setIncomeCats(p.incomeCats);
      if (Array.isArray(p.expenseCats)) setExpenseCats(p.expenseCats);
    }
    if (data.finance) { setIncome(data.finance.income||[]); setExpenses(data.finance.expenses||[]); setBudgets(data.finance.budgets||{}); setBudgetAlerts(data.finance.budgetAlerts||{}); setBudgetCarryover(data.finance.budgetCarryover||{}); if (data.finance.budgetRolloverMonth) setBudgetRolloverMonth(data.finance.budgetRolloverMonth); }
    if (data.productivity) {
      setTasks(data.productivity.tasks||[]);
      setSmartReminders(data.productivity.smartReminders||[]);
      setNotes(data.productivity.notes||[]);
      // A pending call from days ago (the browser was closed the whole time) shouldn't
      // suddenly ring on the next launch — it's stale, not due. Anything more than a day
      // overdue is marked missed on load rather than left pending.
      const now = Date.now();
      setScheduledCalls((data.productivity.scheduledCalls||[]).map(c => {
        if (c.status !== "pending") return c;
        const due = new Date(`${c.date}T${c.time||"00:00"}:00`).getTime();
        return (now - due > 86400000) ? { ...c, status:"missed" } : c;
      }));
    }
    if (data.calendarData) { setAppts(data.calendarData.appts||[]); if (data.calendarData.remindersFired) setRemindersFired(data.calendarData.remindersFired); }
    if (data.contactsData) setContacts(data.contactsData.contacts||[]);
    if (data.projectsData) { setProjects(data.projectsData.projects||[]); setDocuments(data.projectsData.documents||[]); }
    if (data.voiceMemosData) setVoiceMemos(data.voiceMemosData.voiceMemos||[]);
    if (data.filesData) setFiles(data.filesData.files||[]);
    // Strip transient flags on restore. A reply interrupted mid-stream (tab closed, app
    // backgrounded) would otherwise come back with streaming:true and sit there showing a
    // blinking caret for a response that will never finish arriving.
    if (data.wellnessData) {
      const w = data.wellnessData;
      if (typeof w.wellness === "number") setWellness(w.wellness);
      if (w.wellnessDate) setWellnessDate(w.wellnessDate);
      if (Array.isArray(w.wellnessHistory)) setWellnessHistory(w.wellnessHistory);
      if (w.selfCare) setSelfCare(w.selfCare);
      if (w.mood) setMood(w.mood);
      // Backfill ids on entries saved before they carried one, so every row has a stable
      // handle for React keys and for deletion.
      if (Array.isArray(w.moodLog)) setMoodLog(w.moodLog.map(m => m.id ? m : { ...m, id:uid() }));
    }
    // Read/unread and deletions were lost on every reload — the inbox silently reset to
    // all-unread, so marking things read never stuck.
    if (data.emailData && Array.isArray(data.emailData.emails)) setEmails(data.emailData.emails);
    if (data.chatData) {
      setAiMessages((data.chatData.aiMessages||[]).map(({ streaming, ...m }) => m));
      if (Array.isArray(data.chatData.history)) {
        setChatHistory(data.chatData.history.map(c => ({ ...c, messages:(c.messages||[]).map(({ streaming, ...m }) => m) })));
      }
    }
    return data;
  };

  // Nothing is written back to storage until this finishes (see the `dataLoaded` guard on every
  // save effect below); saving before then could overwrite real saved data with the
  // still-default initial state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // With Supabase configured: a persisted session (refresh token already in this browser)
      // means a returning, still-signed-in user — skip straight to their dashboard once their
      // data loads, rather than making them log in again on every reload.
      let hasSession = false;
      if (isSupabaseConfigured) {
        const { data: { session } = {} } = await supabase.auth.getSession();
        hasSession = !!session;
      }
      const data = await hydrateAllGroups();
      if (cancelled) return;
      if (hasSession) {
        setStep("dashboard");
      } else if (!isSupabaseConfigured) {
        // Local-only mode (no Supabase configured): fall back to this app's original
        // device-local behavior — a previously-saved account on this device means Login
        // instead of Signup. Requires real credentials on file, not just an email, since
        // login verifies against them.
        const p = data.profile;
        if (p?.user?.email && (p.user?.passwordHash || p.user?.password)) setStep("login");
      }
      setDataLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Each group saves itself only once its own real data changes (not on unrelated re-renders —
  // the dependency array lists the actual state values directly, never a freshly-built object
  // literal, since a new object reference every render would otherwise reset the debounce timer
  // constantly and the save would never actually fire). Debounced so rapid edits (several
  // additions in a row) collapse into one write instead of one per change.
  // Factored out so a just-completed Supabase signup can write the profile immediately (see
  // doSignup) instead of waiting on this debounce to fire from some later, unrelated change.
  // Without that, a user who signs up and moves straight to the next onboarding step without
  // touching another profile field would have their name/email sitting only in the pre-auth
  // localStorage fallback, not yet under their new account — invisible on their next login.
  // subscribed is deliberately excluded — see hydrateAllGroups's comment on why it's never
  // restored from this same blob; persisting it here would just re-create the value this app
  // must never trust from client storage in the first place.
  const saveProfileNow = () => window.storage.set(STORAGE_KEYS.profile, JSON.stringify({ user, theme, voiceReplies, proactiveInsights, voicePref, voiceSpeed, incomeCats, expenseCats, notifPrefs, dailyBriefSentDate, voiceTurnsCount, voiceTurnsDate, taxSetAsidePct }), false);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { saveProfileNow().catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, user, theme, voiceReplies, proactiveInsights, voicePref, voiceSpeed, incomeCats, expenseCats, notifPrefs, dailyBriefSentDate, voiceTurnsCount, voiceTurnsDate, taxSetAsidePct]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.finance, JSON.stringify({ income, expenses, budgets, budgetAlerts, budgetCarryover, budgetRolloverMonth }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, income, expenses, budgets, budgetAlerts, budgetCarryover, budgetRolloverMonth]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.productivity, JSON.stringify({ tasks, smartReminders, notes, scheduledCalls }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, tasks, smartReminders, notes, scheduledCalls]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.calendarData, JSON.stringify({ appts, remindersFired }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, appts, remindersFired]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.contactsData, JSON.stringify({ contacts }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, contacts]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.projectsData, JSON.stringify({ projects, documents }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, projects, documents]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Capped to the most recent 20 — each memo's audio is now stored inline as a data: URL
    // (see toggleVoiceMemo), so unlike every other list here this one can genuinely be large;
    // an unbounded list would grow storage without limit the more someone actually uses the
    // feature. 20 recent memos is a generous working set without that risk.
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.voiceMemosData, JSON.stringify({ voiceMemos: voiceMemos.slice(0, 20) }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, voiceMemos]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Same capped-list reasoning as voiceMemosData above — each file is now stored inline as a
    // data: URL (see the Files upload handler), so this list is capped at the 30 most recent
    // uploads rather than growing without limit.
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.filesData, JSON.stringify({ files: files.slice(0, 30) }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, files]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Capped to the most recent 60 messages on the active conversation, and to the most recent
    // 30 saved conversations (each itself capped at 60 messages) — unbounded chat history grows
    // forever otherwise, and storage values are size-limited.
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.chatData, JSON.stringify({
      aiMessages: aiMessages.slice(-60).map(({ streaming, ...m }) => m),
      history: chatHistory.slice(0, 30).map(c => ({ ...c, messages: c.messages.slice(-60) })),
    }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, aiMessages, chatHistory]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Mood entries are capped so the log can't grow without bound; 120 covers a couple of months
    // of normal use.
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.wellnessData, JSON.stringify({ wellness, wellnessDate, wellnessHistory: wellnessHistory.slice(-90), selfCare, mood, moodLog: moodLog.slice(-120) }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, wellness, wellnessDate, wellnessHistory, selfCare, mood, moodLog]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.emailData, JSON.stringify({ emails }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, emails]);


  // Around Me feature
  const [locationStatus, setLocationStatus] = useState("idle"); // idle | requesting | granted | denied | error
  const [userCoords, setUserCoords] = useState(null);
  const [locationLabel, setLocationLabel] = useState("");
  const [aroundCategory, setAroundCategory] = useState(null);
  const [aroundQuery, setAroundQuery] = useState("");
  const [aroundResults, setAroundResults] = useState([]);
  const [aroundLoading, setAroundLoading] = useState(false);
  const [aroundError, setAroundError] = useState("");
  const [aroundSearched, setAroundSearched] = useState(false);
  const [lastCity, setLastCity] = useState("");

  const totalIncome = income.reduce((s,r) => s+r.amount, 0);
  const totalExpenses = expenses.reduce((s,r) => s+r.amount, 0);
  const netProfit = totalIncome - totalExpenses;

  // Last 6 calendar months (oldest first, ending this month), each with income/expenses/net
  // actually posted in it — the Overview chart used to just show lifetime totals as three bars,
  // which can't show a trend at all. Built from calendar months rather than a rolling 180-day
  // window so it lines up with how budgets and the monthly report already think about "a month".
  const monthlyTrend = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length:6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return { ym: d.toISOString().slice(0,7), label: d.toLocaleDateString("en-US", { month:"short" }) };
    });
    return months.map(({ ym, label }) => {
      const inc = income.filter(r => (r.date||"").slice(0,7) === ym).reduce((s,r) => s+r.amount, 0);
      const exp = expenses.filter(r => (r.date||"").slice(0,7) === ym).reduce((s,r) => s+r.amount, 0);
      return { ym, label, income:inc, expenses:exp, net: inc - exp };
    });
  }, [income, expenses]);

  // This calendar month's own totals, computed live (unlike monthlyReport, which needs an
  // explicit Generate tap and — on the free tier — a limited quota) so other widgets (tax
  // set-aside, cash flow) always have a current figure to work from.
  const thisMonthNet = useMemo(() => {
    const ym = todayISO().slice(0, 7);
    const inc = income.filter(r => (r.date||"").slice(0,7) === ym).reduce((s,r) => s+r.amount, 0);
    const exp = expenses.filter(r => (r.date||"").slice(0,7) === ym).reduce((s,r) => s+r.amount, 0);
    return { income:inc, expenses:exp, net: inc - exp };
  }, [income, expenses]);

  // This month's expenses grouped by category, for the "Spending by category" donut — largest
  // slice first so both the chart and its legend read in the same order.
  const categoryBreakdown = useMemo(() => {
    const ym = todayISO().slice(0, 7);
    const byCat = {};
    expenses.filter(e => (e.date||"").slice(0,7) === ym).forEach(e => { byCat[e.cat] = (byCat[e.cat]||0) + e.amount; });
    const total = Object.values(byCat).reduce((s,v) => s+v, 0);
    return Object.entries(byCat).sort((a,b) => b[1]-a[1]).map(([cat, amt]) => ({ cat, amt, pct: total ? amt/total : 0 }));
  }, [expenses]);

  // Every future occurrence (not just each template's single next one) of every recurring income
  // or expense due in the next 30 days, simulated forward from nextDate without actually posting
  // anything — the posting engine only ever tracks one occurrence ahead per template, which isn't
  // enough to forecast a weekly bill 4 times over.
  const upcomingCashFlow = useMemo(() => {
    const today = todayISO();
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 30);
    const horizonISO = horizon.toISOString().slice(0, 10);
    const collect = (list, sign) => {
      const out = [];
      list.forEach(e => {
        if (!e.repeat || e.repeat === "none" || !e.nextDate) return;
        let cursor = e.nextDate, guard = 0;
        while (cursor <= horizonISO && guard++ < 60) {
          if (cursor >= today) out.push({ id:`${e.id}:${cursor}`, label:e.label, cat:e.cat, date:cursor, amount:e.amount, sign });
          cursor = advanceRepeatDate(cursor, e.repeat);
        }
      });
      return out;
    };
    const items = [...collect(income, "+"), ...collect(expenses, "-")].sort((a,b) => a.date.localeCompare(b.date));
    const projected = items.reduce((s,e) => s + (e.sign === "+" ? e.amount : -e.amount), 0);
    return { items, projected };
  }, [income, expenses]);

  // Last 14 days of wellness score — history plus today's live (not-yet-rolled-over) value as the
  // most recent point, so the chart always ends on "right now" rather than stopping at yesterday.
  const wellnessTrend = useMemo(() => {
    const today = todayISO();
    return [...wellnessHistory.filter(e => e.date !== today), { date: today, score: wellness }]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14)
      .map(e => ({ ...e, label: e.date === today ? "Today" : new Date(e.date + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" }) }));
  }, [wellnessHistory, wellness]);

  // Consecutive days actually checked in — a real, honest streak of engagement (a mood logged
  // that day), not just "the app happened to be open" (the wellness score itself exists every
  // day automatically, so it can't tell active use from a day nobody touched wellness at all).
  // Today not having a mood logged yet doesn't break the streak before the day is even over —
  // it just isn't counted until it happens, same as how a habit tracker treats "still open".
  const wellnessStreak = useMemo(() => {
    const days = new Set(moodLog.map(m => m.date).filter(Boolean));
    const today = todayISO();
    let streak = 0;
    // todayISO() is UTC-based (new Date().toISOString().slice(0,10)), so every step here stays
    // in UTC too (setUTCDate, not setDate) — mixing local-time decrements with a UTC-serialized
    // comparison would silently shift the date by a day near midnight in some timezones.
    const cursor = new Date(today + "T00:00:00Z");
    if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
  }, [moodLog]);

  // Weeks of the visible month for the calendar grid, Sunday-first, padded with the trailing days
  // of the previous/next month so every week row is a full 7 cells — those padding cells are
  // rendered dimmed and not clickable, they exist purely so the grid lines up.
  const calendarWeeks = useMemo(() => {
    const [y, m] = calendarMonth.split("-").map(Number);
    const first = new Date(y, m - 1, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) {
      const d = new Date(y, m - 1, 1 - (startOffset - i));
      cells.push({ date: d.toISOString().slice(0,10), day: d.getDate(), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: `${calendarMonth}-${String(d).padStart(2,"0")}`, day: d, inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const last = new Date(cells[cells.length-1].date + "T00:00:00");
      last.setDate(last.getDate() + 1);
      cells.push({ date: last.toISOString().slice(0,10), day: last.getDate(), inMonth: false });
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i+7));
    return weeks;
  }, [calendarMonth]);

  const apptsByDate = useMemo(() => {
    const map = {};
    appts.forEach(a => { if (a.date) (map[a.date] = map[a.date] || []).push(a); });
    return map;
  }, [appts]);

  const pw = signupPw;
  const pwChecks = { length:pw.length>=8, upper:/[A-Z]/.test(pw), lower:/[a-z]/.test(pw), number:/[0-9]/.test(pw), special:/[^A-Za-z0-9]/.test(pw) };
  const pwScore = Object.values(pwChecks).filter(Boolean).length;
  const pwStrength = ["","Weak","Fair","Good","Strong","Very Strong"][pwScore] || "";
  const pwColor = [C.muted,C.border,C.soft,C.soft,C.white,C.white][pwScore] || C.muted;
  const initials = user.name ? user.name.split(" ").map(n=>n[0]).join("").toUpperCase().slice(0,2) : "?";

  // Auto-scroll only when the person is already near the bottom. This fires on every token now
  // that replies stream, so an unconditional smooth-scroll stacked ~50 animations a second and
  // yanked the view back down whenever someone scrolled up to re-read an earlier message.
  const chatScrollRef = useRef(null);
  // The chat textarea grows with its content (see the onChange handler where it's rendered),
  // but sending a message clears aiInput without touching the DOM element's own height, which a
  // browser never shrinks back down on its own — so a reply typed across three lines would leave
  // the empty box three lines tall afterward. Whenever aiInput goes back to empty (a send, or the
  // person clearing it themselves), snap the height back to one line.
  useEffect(() => {
    if (aiInput === "" && aiInputRef.current) aiInputRef.current.style.height = "auto";
  }, [aiInput]);
  useEffect(() => {
    const box = chatScrollRef.current;
    if (!box) { chatEnd.current?.scrollIntoView({ behavior:"smooth" }); return; }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (!nearBottom) return;
    // "auto" rather than "smooth": at streaming speed, queued smooth animations stutter.
    const streaming = aiMessages.some(m => m.streaming);
    chatEnd.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [aiMessages]);
  useEffect(() => {
    if (!locked) return;
    let t = 30; setLockTimer(t);
    const iv = setInterval(() => { t--; setLockTimer(t); if (t<=0) { setLocked(false); setLoginAttempts(0); clearInterval(iv); } }, 1000);
    return () => clearInterval(iv);
  }, [locked]);
  useEffect(() => {
    if (step !== "photo" && camStream) { camStream.getTracks().forEach(t => t.stop()); setCamStream(null); setCameraMode(false); setCameraReady(false); }
  }, [step]);
  useEffect(() => {
    if (step === "dashboard") {
      // Only seed the welcome message for a genuinely empty conversation — otherwise this
      // fires on every login (and every prefs round-trip) and silently discards whatever
      // history was just restored from persistent storage.
      setAiMessages(p => p.length > 0 ? p : [{ role:"assistant", content:`Hey ${firstNameOf(user.name)||"there"} — I'm KROFT, your personal AI assistant by Virt Technologies. Ask me anything — finances, schedule, general knowledge, advice, or just chat. I'm here for all of it.` }]);
      toast(`Welcome to KROFT, ${firstNameOf(user.name)||"there"}.`);
    }
  }, [step]);

  const toast = useCallback((msg, onUndo) => {
    const id = uid();
    // Capped at 2 concurrent toasts, not 4 — the fixed top-right stack has no reserved space of
    // its own, so it floats directly over whatever's underneath (the app header, in particular).
    // Four stacked toasts (each up to ~50px, some wrapping to two lines) grew tall enough to
    // fully cover the header/logo for the several seconds they're all up — not toasts
    // overlapping each other, but the stack overlapping real page content beneath it.
    setToasts(p => [{ id, msg, onUndo }, ...p.slice(0,1)]);
    haptic(10);
    // Undo gets meaningfully longer than a plain confirmation. Six seconds is fine at a desk,
    // but it's tight on a phone while walking, and a screen reader may still be queuing the
    // announcement when the only chance to reverse a deletion disappears.
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), onUndo ? UNDO_MS : 4200);
  }, []);

  // A real "moment" — confetti + a distinct, more festive haptic pattern — reserved for genuine
  // milestones (see call sites: all tasks cleared, first-ever finance entry, KROFT Plus
  // activated, wellness hitting 100), not everyday confirmations. Those keep the plain toast().
  const celebrate = useCallback(() => { setShowConfetti(true); haptic([15, 60, 15, 60, 40]); }, []);

  // Celebrates the first time wellness reaches a perfect 100 after having been lower — the ref
  // re-arms once it dips back below 100, so climbing back up to 100 later celebrates again
  // rather than only ever once per session. The initial hydration snapshot is recorded without
  // celebrating — a returning user whose wellness was already 100 from a previous session
  // shouldn't get a "you just reached it" moment on every reload.
  const wellnessCelebratedRef = useRef(false);
  const wellnessInitializedRef = useRef(false);
  useEffect(() => {
    if (!dataLoaded) return;
    if (!wellnessInitializedRef.current) {
      wellnessInitializedRef.current = true;
      wellnessCelebratedRef.current = wellness >= 100;
      return;
    }
    if (wellness >= 100 && !wellnessCelebratedRef.current) {
      wellnessCelebratedRef.current = true;
      toast("Wellness at 100 — you're taking great care of yourself.");
      celebrate();
    } else if (wellness < 100) {
      wellnessCelebratedRef.current = false;
    }
  }, [wellness, dataLoaded]);

  const remind = appt => {
    const msg = `Hey ${firstNameOf(user.name)||"there"}, reminder: "${appt.title}" at ${appt.time}${appt.date?" on "+appt.date:""}${appt.location?" at "+appt.location:""}.`;
    if (voiceReplies) speak(msg);
    toast(`Reminder sent: ${appt.title}`);
  };

  // Nudge the user 3x a day (morning/afternoon/evening) to log today's first finance entry,
  // as long as they haven't logged one yet today. In-app only — real push notifications
  // need a service worker + backend once this moves out of the artifact sandbox.
  const REMINDER_SLOTS = [9, 14, 20]; // 9am, 2pm, 8pm
  useEffect(() => {
    const checkReminders = () => {
      if (step !== "dashboard" || !proactiveInsights) return;
      const today = todayISO();
      const loggedToday = income.some(r => r.date === today) || expenses.some(r => r.date === today);
      if (loggedToday) return;
      const hour = new Date().getHours();
      // dueSlot is set as a side-effect-free local inside the updater (safe even if React
      // re-invokes the updater, e.g. under Strict Mode); the actual toast — a real side effect
      // via setToasts — fires exactly once, outside the updater, only if something came due.
      let dueSlot = null;
      setRemindersFired(prev => {
        const slots = prev.date === today ? prev.slots : [];
        const due = REMINDER_SLOTS.find(s => hour >= s && !slots.includes(s));
        if (due === undefined) return prev.date === today ? prev : { date:today, slots };
        dueSlot = due;
        return { date:today, slots:[...slots, due] };
      });
      if (dueSlot !== null) {
        toast(`${firstNameOf(user.name)||"Hey"} — you haven't logged an income or expense entry today. Add one so KROFT can track your month.`);
      }
    };
    checkReminders();
    return heartbeat(checkReminders);
  }, [step, income, expenses, user.name, proactiveInsights]);

  // Recurring appointments (repeat: daily/weekly/monthly) previously just stored that value
  // and displayed it as a tag — nothing ever actually advanced the date, so a "daily" 9am
  // stand-up would just sit on its original date forever once that day passed. This rolls any
  // repeating appointment whose date has passed forward to its next due occurrence (looping in
  // case the app was closed across more than one cycle), checked on load and once a minute
  // alongside the other periodic checks.
  useEffect(() => {
    if (!dataLoaded) return;
    const rollRecurring = () => {
      const today = todayISO();
      setAppts(prev => {
        let changed = false;
        const next = prev.map(a => {
          if (a.repeat === "none" || !a.date || a.date >= today) return a;
          let date = a.date;
          while (date < today) date = advanceRepeatDate(date, a.repeat);
          changed = true;
          return { ...a, date };
        });
        return changed ? next : prev;
      });
    };
    rollRecurring();
    return heartbeat(rollRecurring);
  }, [dataLoaded]);

  const applyMood = m => {
    haptic(m==="happy" ? [10, 30, 10] : 12);
    // Entries carry a date as well as a time. Without one, yesterday's 9am and today's 9am were
    // indistinguishable in the log — which didn't show while nothing persisted, but makes the
    // history unreadable now that it does.
    setMood(m); setMoodLog(p => [...p, { id:uid(), date:todayISO(), time:timeStr(), mood:m }]);
    if (m==="stressed"||m==="angry") {
      setWellness(s => Math.max(10, s-13));
      const tip = rand(["Take 5 slow breaths.","Step away from your screen for 10 minutes.","Drink a full glass of water.","A short walk resets your focus."]);
      if (voiceReplies) speak(`${firstNameOf(user.name)||"Hey"}, I'm sensing stress. ${tip}`, { context:"sensitive" }); toast(tip);
    } else if (m==="happy") { setWellness(s => Math.min(100, s+7)); toast("Great energy. Wellness score up."); }
    else toast(`Mood: ${m}`);
  };

  // True only once an account actually exists on this device. Local-only-mode fallback only —
  // with Supabase configured, doLogin asks the server instead of checking anything local, since
  // a real account can now be logged into from a device that's never seen it before.
  const hasAccount = !!(user.passwordHash || user.password);

  const doLogin = async () => {
    if (locked) return;
    if (!loginEmail||!loginPw) { setLoginError("Please enter your email and password."); return; }

    if (isSupabaseConfigured) {
      setAuthLoading(true);
      const { error } = await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPw });
      setAuthLoading(false);
      if (error) {
        const next = loginAttempts + 1; setLoginAttempts(next);
        const rem = 5 - next;
        // Supabase's own error message ("Invalid login credentials", etc.) is already generic
        // enough not to reveal which half was wrong, so it's shown directly rather than
        // replaced with a custom string — but the attempt-lockout UX stays, layered on top of
        // Supabase's own server-side rate limiting rather than replacing it.
        if (next >= 5) { setLocked(true); setLoginError("Too many failed attempts. Locked for 30 seconds."); }
        else setLoginError(`${error.message || "Incorrect email or password."} ${rem} attempt${rem!==1?"s":""} remaining.`);
        return;
      }
      setLoginError(""); setLoginAttempts(0); setLoginPw("");
      // The mount-time hydration effect ran before anyone was signed in and found nothing for
      // this account — load it for real now that we know who's signed in.
      const data = await hydrateAllGroups();
      setStep("dashboard");
      // Read the name from hydrateAllGroups's own return value, not the closure-captured `user`
      // state — setUser() inside it doesn't retroactively update what this already-running
      // function sees, so on a device with no prior local data for this account (first login
      // here), `user.name` was still empty and this always said "Welcome back, there."
      toast(`Welcome back, ${firstNameOf(data?.profile?.user?.name)||"there"}.`);
      return;
    }

    // Local-only mode (no Supabase configured): fall back to this app's original device-local
    // credential check.
    if (!hasAccount) { setLoginError("No account on this device yet. Create one to get started."); return; }
    let ok = false;
    if (user.passwordHash) {
      const attemptHash = await hashPassword(loginPw, user.passwordSalt || "");
      ok = attemptHash === user.passwordHash;
    } else if (user.password) {
      // Legacy plaintext account from before hashing was added — verify the old way once, then
      // transparently upgrade storage to a real hash so the plaintext doesn't linger further.
      ok = loginPw === user.password;
      if (ok) {
        const salt = generateSalt();
        const passwordHash = await hashPassword(loginPw, salt);
        setUser(u => { const { password, ...rest } = u; return { ...rest, passwordSalt:salt, passwordHash }; });
      }
    }
    // The email has to match the account too. It was previously ignored entirely, and then
    // written over user.email on success — so a typo didn't fail, it quietly changed the
    // account's address and saved that to storage. The error stays generic either way so it
    // doesn't reveal which half was wrong.
    const emailOk = (user.email||"").trim().toLowerCase() === loginEmail.trim().toLowerCase();
    if (!ok || !emailOk) {
      const next = loginAttempts + 1; setLoginAttempts(next);
      const rem = 5 - next;
      if (next >= 5) { setLocked(true); setLoginError("Too many failed attempts. Locked for 30 seconds."); }
      else setLoginError(`Incorrect email or password. ${rem} attempt${rem!==1?"s":""} remaining.`);
      return;
    }
    setLoginError(""); setLoginAttempts(0); setLoginPw("");
    setStep("dashboard");
    toast(`Welcome back, ${firstNameOf(user.name)||"there"}.`);
  };

  const doForgotPassword = async () => {
    if (!forgotEmail.trim()) { setForgotError("Enter your email address."); return; }
    setForgotLoading(true); setForgotError("");
    // redirectTo lands back on this same origin with a recovery token in the URL — the
    // recovery-redirect effect below (near the other query-param handlers) picks that up.
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), { redirectTo: window.location.origin });
    setForgotLoading(false);
    // Supabase intentionally doesn't reveal whether the address has an account (that itself
    // would leak which emails are registered) — so this shows the same success state either
    // way, matching Supabase's own privacy-preserving behavior rather than second-guessing it.
    if (error) { setForgotError(error.message || "Couldn't send the reset link. Try again."); return; }
    setForgotSent(true);
  };

  const doResetPassword = async () => {
    if (!newPw || newPw.length < 8) { setResetPwError("Password must be at least 8 characters."); return; }
    if (newPw !== confirmNewPw) { setResetPwError("Passwords do not match."); return; }
    setResetPwLoading(true); setResetPwError("");
    // setSession (from the recovery-redirect effect) already established an authenticated
    // session scoped to this reset — updateUser applies to whoever that session belongs to.
    const { error } = await supabase.auth.updateUser({ password: newPw });
    setResetPwLoading(false);
    if (error) { setResetPwError(error.message || "Couldn't update your password. Try again."); return; }
    setNewPw(""); setConfirmNewPw("");
    await hydrateAllGroups();
    setStep("dashboard");
    toast("Password updated — you're signed in.");
  };

  const doFingerprint = async () => {
    // Requires a real WebAuthn credential to have been registered first (see setupBiometric in
    // Profile) — the login button itself is hidden unless user.webauthnCredentialId exists, so
    // reaching here without one shouldn't normally happen, but this guard keeps it safe either
    // way. navigator.credentials.get() only resolves after the platform authenticator (Face ID/
    // Touch ID/Windows Hello) actually approves a fresh biometric prompt on THIS device — unlike
    // the old version of this function, nothing here can be satisfied by just clicking the
    // button. Requires a secure context (HTTPS or localhost); some sandboxed preview iframes
    // block WebAuthn outright, in which case this will fail with an error rather than silently
    // granting access.
    if (!user.webauthnCredentialId) { toast("Set up biometric unlock in Profile first."); return; }
    if (!window.PublicKeyCredential) { toast("Biometrics not supported on this device."); return; }
    setFpLoading(true);
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ id: base64urlToBuf(user.webauthnCredentialId), type:"public-key" }],
          userVerification: "required",
          timeout: 60000,
        },
      });
      if (!assertion) throw new Error("No assertion returned");
      // WebAuthn only proves this is the same device/person that registered biometrics — it
      // doesn't and can't restore a Supabase session by itself; there's no server-side piece
      // here that verifies the assertion and mints one. Skipping straight to the dashboard
      // without this check used to mean: if the real session had actually expired, someone
      // would land on whatever this browser's local fallback storage (see storageShim.js) still
      // had cached, believing they were signed in, while every later read/write silently missed
      // the server entirely instead of reaching their real account.
      if (isSupabaseConfigured) {
        const { data: { session } = {} } = await supabase.auth.getSession();
        if (!session) {
          setFpLoading(false);
          setLoginError("Your session has expired — log in with your password to continue.");
          return;
        }
      }
      setFpSuccess(true);
      // Matches every other successful sign-in path (doLogin, doResetPassword) — biometric
      // unlock had been the one that skipped straight to dashboard on whatever was already in
      // memory, rather than pulling the real, current account data.
      await hydrateAllGroups();
      setFpLoading(false);
      setTimeout(() => { setLoginError(""); setLoginAttempts(0); setStep("dashboard"); toast("Fingerprint verified."); }, 500);
    } catch {
      setFpLoading(false);
      setLoginError("Biometric verification failed or was cancelled.");
    }
  };

  // Registers a real platform-authenticator (Face ID/Touch ID/Windows Hello) credential for
  // this device, called from Profile settings. Stores only the credential's public ID (safe to
  // persist — it can't be used to impersonate without the matching private key, which never
  // leaves the authenticator hardware) in user.webauthnCredentialId.
  const setupBiometric = async () => {
    if (!window.PublicKeyCredential) { toast("Biometric unlock isn't supported on this device."); return; }
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userIdBytes = crypto.getRandomValues(new Uint8Array(16));
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "KROFT" },
          user: { id: userIdBytes, name: user.email || "kroft-user", displayName: user.name || "KROFT User" },
          pubKeyCredParams: [{ type:"public-key", alg:-7 }, { type:"public-key", alg:-257 }],
          authenticatorSelection: { authenticatorAttachment:"platform", userVerification:"required" },
          timeout: 60000,
          attestation: "none",
        },
      });
      if (!credential) throw new Error("No credential returned");
      setUser(u => ({ ...u, webauthnCredentialId: bufToBase64url(credential.rawId) }));
      toast("Biometric unlock is set up on this device.");
    } catch (err) {
      toast(`Couldn't set up biometric unlock — ${err?.message || "try again."}`);
    }
  };
  const removeBiometric = () => {
    setUser(u => { const { webauthnCredentialId, ...rest } = u; return rest; });
    toast("Biometric unlock removed for this device.");
  };

  // Attaches the current Supabase session's access token to a request to one of our own
  // api/google|gmail|calendar/* endpoints — every one of them authenticates the caller this
  // way (see api/_lib/google.js's getAuthedUser), the same token Supabase's own client already
  // manages, refreshes and persists.
  const authedFetch = async (path, opts = {}) => {
    if (!isSupabaseConfigured) throw new Error("Supabase isn't configured, so there's no account to authenticate this request with.");
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session) throw new Error("Not signed in.");
    return fetch(path, {
      ...opts,
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  };

  // Same idea as authedFetch, but for api/chat.js specifically: that endpoint only requires
  // sign-in when Supabase is actually configured server-side (see its own comment) and stays
  // open in local-only mode — so unlike authedFetch, this never throws. It attaches a session
  // token opportunistically when one exists, and otherwise sends the request exactly as before.
  const aiFetch = async (path, opts = {}) => {
    const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...opts.headers };
    if (isSupabaseConfigured) {
      try {
        const { data: { session } = {} } = await supabase.auth.getSession();
        if (session) headers.Authorization = `Bearer ${session.access_token}`;
      } catch {
        // Best-effort — if this fails for any reason, fall through and send the request
        // unauthenticated exactly as it always used to, rather than blocking AI chat on it.
      }
    }
    return fetch(path, { ...opts, headers });
  };

  // The actual source of truth for Gmail/Calendar connection state — called after a successful
  // OAuth round-trip and once on reaching the dashboard, so user.connected.gmail/.calendar
  // (used for the read-only status text in Profile) never drifts from what's really connected.
  const refreshGoogleStatus = async () => {
    if (!isSupabaseConfigured) return;
    try {
      const res = await authedFetch("/api/google/status");
      if (!res.ok) return;
      const status = await res.json();
      setGoogleStatus({ gmail: !!status.gmail, calendar: !!status.calendar });
      setUser(u => ({ ...u, connected: { ...u.connected, gmail: !!status.gmail, calendar: !!status.calendar } }));
    } catch {
      // Silent — this is a background status refresh, not a user-initiated action; a failed
      // check just leaves the last-known connected state on screen rather than surfacing an
      // error for something the user didn't ask for.
    }
  };

  // Starts the real Google OAuth flow: asks our backend for a consent URL (api/google/start.js
  // signs a state token identifying this user) and does a full top-level navigation to it —
  // Google's consent screen won't render inside a fetch response or an iframe. The browser
  // leaves the app entirely here; the flow continues on return via api/google/callback.js and
  // the oauth=success/error query-param handling in the mount effect below.
  const connectGoogle = async () => {
    setGoogleLinking(true);
    try {
      const res = await authedFetch("/api/google/start");
      if (!res.ok) { toast("Couldn't start Google sign-in. Try again."); setGoogleLinking(false); return; }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      toast("Couldn't start Google sign-in. Try again.");
      setGoogleLinking(false);
    }
  };

  const disconnectGoogle = async () => {
    setGoogleLinking(true);
    try {
      const res = await authedFetch("/api/google/disconnect", { method: "POST" });
      setGoogleLinking(false);
      if (!res.ok) { toast("Couldn't disconnect Google. Try again."); return; }
      setGoogleStatus({ gmail: false, calendar: false });
      setUser(u => ({ ...u, connected: { ...u.connected, gmail: false, calendar: false } }));
      toast("Google account disconnected.");
    } catch {
      setGoogleLinking(false);
      toast("Couldn't disconnect Google. Try again.");
    }
  };

  // Microsoft/Outlook — same shape and reasoning as the Google trio above, against
  // api/microsoft/*. See api/_lib/microsoft.js for why disconnect only deletes KROFT's own
  // stored copy rather than also revoking with Microsoft (unlike Google, there's no simple
  // server-side revoke endpoint on their side).
  const refreshMicrosoftStatus = async () => {
    if (!isSupabaseConfigured) return;
    try {
      const res = await authedFetch("/api/microsoft/status");
      if (!res.ok) return;
      const status = await res.json();
      setMicrosoftStatus({ mail: !!status.mail, calendar: !!status.calendar });
      // Mirrors into user.connected under distinct keys (not gmail/calendar, which stay
      // Google-specific) so the read-only status text elsewhere in Profile — which only knows
      // about user.connected, not googleStatus/microsoftStatus — stays accurate too.
      setUser(u => ({ ...u, connected: { ...u.connected, outlookMail: !!status.mail, outlookCalendar: !!status.calendar } }));
    } catch {
      // Silent — background status refresh, same reasoning as refreshGoogleStatus.
    }
  };

  const connectMicrosoft = async () => {
    setMicrosoftLinking(true);
    try {
      const res = await authedFetch("/api/microsoft/start");
      if (!res.ok) { toast("Couldn't start Microsoft sign-in. Try again."); setMicrosoftLinking(false); return; }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      toast("Couldn't start Microsoft sign-in. Try again.");
      setMicrosoftLinking(false);
    }
  };

  const disconnectMicrosoft = async () => {
    setMicrosoftLinking(true);
    try {
      const res = await authedFetch("/api/microsoft/disconnect", { method: "POST" });
      setMicrosoftLinking(false);
      if (!res.ok) { toast("Couldn't disconnect Microsoft. Try again."); return; }
      setMicrosoftStatus({ mail: false, calendar: false });
      setUser(u => ({ ...u, connected: { ...u.connected, outlookMail: false, outlookCalendar: false } }));
      toast("Microsoft account disconnected.");
    } catch {
      setMicrosoftLinking(false);
      toast("Couldn't disconnect Microsoft. Try again.");
    }
  };

  // Pulls the real inbox from whichever email account(s) are connected (Gmail, Outlook, or
  // both — api/mail/messages.js merges them) and replaces the local `emails` list with it —
  // including the very first pull, which is exactly what should happen to the three seed/mock
  // emails this app starts with (see the emails useState above): connecting a real inbox
  // should show that real inbox, not a real inbox appended after fake sample data.
  const syncMail = async () => {
    setSyncingMail(true);
    try {
      const res = await authedFetch("/api/mail/messages");
      if (!res.ok) { toast(res.status===409 ? "No email account is connected." : "Couldn't load your inbox right now."); return; }
      const { messages } = await res.json();
      setEmails(messages);
      toast(`Loaded ${messages.length} email${messages.length===1?"":"s"}.`);
    } catch {
      toast("Couldn't load your inbox right now.");
    } finally {
      setSyncingMail(false);
    }
  };

  // Pulls upcoming events from whichever calendar(s) are connected (Google, Outlook, or both —
  // api/calendar/events.js merges them) and merges them into the local `appts` list, replacing
  // any previously-synced remote events (tagged source:"google"|"outlook") so a re-sync
  // doesn't pile up duplicates, while leaving purely local appointments (added directly in
  // Kroft, never sent to a connected calendar) untouched.
  const syncCalendar = async () => {
    setSyncingCalendar(true);
    try {
      const res = await authedFetch("/api/calendar/events");
      if (!res.ok) { toast(res.status===409 ? "No calendar is connected." : "Couldn't load your calendar right now."); return; }
      const { appts: remoteAppts } = await res.json();
      setAppts(p => [...p.filter(a => a.source !== "google" && a.source !== "outlook"), ...remoteAppts]);
      toast(`Loaded ${remoteAppts.length} event${remoteAppts.length===1?"":"s"}.`);
    } catch {
      toast("Couldn't load your calendar right now.");
    } finally {
      setSyncingCalendar(false);
    }
  };

  // Mirrors a locally-added appointment onto every connected real calendar (api/calendar/
  // events.js's POST creates it on Google and/or Outlook, whichever are connected).
  // Deliberately fire-and-forget: the appointment already exists in Kroft's own local `appts`
  // (the app's source of truth for what it displays) the instant it's added, regardless of
  // whether this call succeeds, is slow, or no calendar is connected at all — nothing about
  // adding an appointment should block on, or fail because of, a third-party API.
  const mirrorAppointmentToCalendars = (appt) => {
    if (!googleStatus.calendar && !microsoftStatus.calendar) return;
    authedFetch("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({ title: appt.title, date: appt.date, time: appt.time, location: appt.location, notes: appt.notes }),
    }).catch(() => {}); // best-effort — see comment above
  };

  // The real source of truth for KROFT Plus — reads the subscriptions row Flutterwave's webhook
  // and post-checkout verification (api/billing/webhook.js, api/billing/callback.js) keep in
  // sync, never something set directly by a client action. "active" counts as subscribed;
  // everything else (inactive, canceled, or no row at all for a user who's never subscribed)
  // doesn't.
  const refreshSubscriptionStatus = async () => {
    if (!isSupabaseConfigured) return;
    try {
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase.from("subscriptions").select("status, auto_renews").eq("user_id", user.id).maybeSingle();
      if (error) return;
      setSubscribed(data?.status === "active");
      setSubscriptionStatus(data?.status || "inactive");
      setAutoRenews(!!data?.auto_renews);
    } catch {
      // Silent — a background status refresh, not a user-initiated action.
    }
  };

  // The configured daily/monthly allowance for the AI pools that still have one (voice today;
  // any future metered feature — vision, image generation, file analysis, web research —
  // reads from the same plan_limits table with zero client changes once it exists), plus
  // this account's current usage against it. Fetched fresh on every dashboard entry rather
  // than hardcoded, so an admin changing a limit in the database takes effect immediately —
  // no redeploy needed.
  const refreshUsageLimits = async () => {
    if (!isSupabaseConfigured) return;
    try {
      const res = await authedFetch("/api/usage");
      if (!res.ok) return;
      const data = await res.json();
      setUsageLimits(data?.limits || {});
    } catch {
      // Silent — a background refresh; the FALLBACK_VOICE_LIMIT keeps the UI sane meanwhile.
    }
  };

  // Redirects to Flutterwave's hosted Checkout for a new subscription. Nothing here can make
  // `subscribed` true directly — that only ever happens once api/billing/callback.js verifies
  // a real payment server-side (or, for later renewals, once api/billing/webhook.js confirms
  // one) and refreshSubscriptionStatus picks it up (see the billing=success handling below).
  const startCheckout = async () => {
    if (!isSupabaseConfigured) { toast("Sign in with a real account to upgrade."); return; }
    setBillingLoading(true);
    try {
      const res = await authedFetch("/api/billing/checkout", { method: "POST" });
      if (!res.ok) {
        // 409 means the server already sees an active subscription (e.g. a stale second tab) —
        // "try again" would be actively wrong advice there, since starting another checkout is
        // exactly what api/billing/checkout.js just refused to prevent a duplicate charge.
        toast(res.status === 409 ? "You're already on KROFT Plus." : "Couldn't start checkout. Try again.");
        setBillingLoading(false);
        if (res.status === 409) refreshSubscriptionStatus();
        return;
      }
      const { url } = await res.json();
      window.location.href = url; // full navigation — Flutterwave's checkout page won't render in a fetch response
    } catch {
      toast("Couldn't start checkout. Try again.");
      setBillingLoading(false);
    }
  };

  // Cancels KROFT Plus directly. Unlike Stripe, Flutterwave has no hosted self-serve portal to
  // redirect to — this calls Flutterwave's cancel-subscription API on the user's behalf (see
  // api/billing/cancel.js), confirmed here first since there's no separate confirmation screen
  // on Flutterwave's side the way a portal would provide.
  const cancelKroftPlus = async () => {
    if (!window.confirm("Cancel KROFT Plus? You'll lose unlimited access once this takes effect.")) return;
    setBillingLoading(true);
    try {
      const res = await authedFetch("/api/billing/cancel", { method: "POST" });
      setBillingLoading(false);
      if (!res.ok) {
        toast(res.status === 409 ? "No active subscription to cancel." : "Couldn't cancel. Try again.");
        return;
      }
      setSubscribed(false);
      toast("KROFT Plus cancelled.");
    } catch {
      setBillingLoading(false);
      toast("Couldn't cancel. Try again.");
    }
  };

  // Consumes the billing=success/cancelled/error query params api/billing/callback.js lands
  // back on the app with after a Flutterwave checkout attempt — same pattern as the
  // oauth=success/error handling below, kept separate since they're unrelated redirects that
  // can each arrive independently.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billingResult = params.get("billing");
    if (!billingResult) return;
    if (billingResult === "success") {
      toast("Payment received — welcome to KROFT Plus.");
      celebrate();
      refreshSubscriptionStatus();
    } else if (billingResult === "cancelled") {
      toast("Checkout cancelled — no charge was made.");
    } else if (billingResult === "error") {
      // api/billing/callback.js's own server-side verification didn't confirm the payment —
      // shown distinctly from a plain cancellation since this means something went wrong with
      // an attempted charge, not that the user simply backed out.
      toast("Couldn't confirm the payment. If you were charged, contact support.");
    }
    params.delete("billing"); params.delete("billing_error");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : "") + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
  }, []);

  // Consumes the oauth=success/error query params Google's or Microsoft's consent flow lands
  // back on the app with (see api/google/callback.js and api/microsoft/callback.js's
  // redirectTo — oauth_provider distinguishes which one) — shows the right toast once, then
  // strips them from the URL so a manual refresh doesn't re-show a stale result. Runs once on
  // mount; this is independent of the main hydration effect since it reflects what just
  // happened in the browser's address bar, not persisted account data.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthResult = params.get("oauth");
    if (!oauthResult) return;
    const provider = params.get("oauth_provider") === "microsoft" ? "Microsoft" : "Google";
    if (oauthResult === "success") {
      toast(`${provider} account connected.`);
      refreshGoogleStatus();
      refreshMicrosoftStatus();
      // Best-effort first pull so the newly-connected inbox/calendar aren't still showing
      // stale mock data or an empty list the moment the user lands back on the dashboard —
      // each call is a no-op (a handled 409) if that particular scope wasn't actually granted.
      syncMail();
      syncCalendar();
    } else if (oauthResult === "error") {
      const reason = params.get("oauth_error") || "unknown_error";
      toast(reason === "access_denied" ? `${provider} sign-in was cancelled.` : `Couldn't connect ${provider}. Try again.`);
    }
    params.delete("oauth"); params.delete("oauth_provider"); params.delete("oauth_error");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : "") + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
  }, []);

  // Catches Supabase's password-recovery redirect. resetPasswordForEmail's link lands back here
  // with the session tokens in the URL *hash* (never the query string) as
  // "#access_token=...&refresh_token=...&type=recovery" — and since supabaseClient.js sets
  // detectSessionInUrl: false, Supabase won't auto-consume it, so this does that by hand: parse
  // the hash, establish the session it describes, then send the user to the set-new-password
  // screen. Runs once on mount, same as the query-param effects above.
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    if (hashParams.get("type") !== "recovery") return;
    const access_token = hashParams.get("access_token");
    const refresh_token = hashParams.get("refresh_token");
    if (!access_token || !refresh_token) return;
    (async () => {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
      if (error) { toast("That reset link has expired. Request a new one."); return; }
      setStep("reset-password");
    })();
  }, []);

  // Keeps the connected badges and subscription status accurate whenever the dashboard is
  // (re)entered — covers a fresh login, a returning already-signed-in session, and finishing
  // onboarding via "Enter KROFT", without needing each of those call sites to remember to
  // trigger it themselves.
  useEffect(() => {
    if (step === "dashboard") {
      refreshGoogleStatus(); refreshMicrosoftStatus(); refreshSubscriptionStatus(); refreshUsageLimits();
      // Re-subscribes a returning session that already granted notification permission earlier —
      // onEnableNotifications only fires the very first time permission is granted, so without
      // this a subscription lost to (e.g.) clearing site data or a new browser would never be
      // re-established on a later visit.
      if (notifPermission === "granted") subscribeToPush(authedFetch);
    }
  }, [step]);

  const doSignup = async () => {
    if (!user.name||!user.email||!signupPw) { setSignupError("Please fill in all required fields."); return; }
    if (pwScore < 3) { setSignupError("Password too weak. Add uppercase, numbers and symbols."); return; }
    if (!confirmPw) { setSignupError("Please confirm your password."); return; }
    if (confirmPw !== signupPw) { setSignupError("Passwords do not match."); return; }

    if (isSupabaseConfigured) {
      setAuthLoading(true);
      const { data, error } = await supabase.auth.signUp({
        email: user.email.trim(),
        password: signupPw,
        options: { data: { name: user.name } },
      });
      setAuthLoading(false);
      if (error) { setSignupError(error.message || "Couldn't create your account. Try again."); return; }
      setSignupPw(""); setConfirmPw(""); setSignupError("");
      if (!data.session) {
        // This project's Auth settings require email confirmation — there's no session yet,
        // so there's nothing to load and nowhere secure to send them. Say so plainly rather
        // than silently landing on a dashboard with no data.
        setStep("login");
        toast("Check your email to confirm your account, then log in.");
        return;
      }
      // Write the profile now rather than waiting for the debounced save effect to pick up
      // some later, unrelated change — without this, a user who signs up and moves straight
      // to onboarding without touching another profile field would have their name/email
      // sitting only in the pre-auth localStorage fallback, not yet under their new account.
      saveProfileNow().catch(()=>{});
      setEditingFromProfile(false);
      setStep("photo");
      return;
    }

    // Local-only mode (no Supabase configured): fall back to this app's original device-local
    // account scheme — a locally hashed password, no real server, no cross-device login.
    if (!window.crypto?.subtle) { setSignupError("This browser can't securely hash passwords — try updating it, or use HTTPS."); return; }
    const salt = generateSalt();
    const passwordHash = await hashPassword(signupPw, salt);
    setUser(u => { const { password, ...rest } = u; return { ...rest, passwordSalt:salt, passwordHash }; });
    setSignupPw(""); setConfirmPw("");
    setSignupError(""); setEditingFromProfile(false); setStep("photo");
  };

  const openCamera = async () => {
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError("Camera not supported. Use gallery instead."); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video:{facingMode:"user"}, audio:false });
      setCamStream(s); setCameraMode(true); setCameraReady(false);
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().then(() => setCameraReady(true)).catch(() => setCameraReady(true)); } }, 400);
    } catch(err) {
      if (err.name==="NotAllowedError") setCameraError("Camera permission denied.");
      else if (err.name==="NotFoundError") setCameraError("No camera found. Use gallery instead.");
      else setCameraError("Could not start camera. Try gallery.");
    }
  };

  const closeCamera = () => { camStream?.getTracks().forEach(t => t.stop()); setCamStream(null); setCameraMode(false); setCameraReady(false); setCameraError(""); };

  const snapPhoto = () => {
    if (!videoRef.current||!canvasRef.current) return;
    const v = videoRef.current, c = canvasRef.current;
    c.width = v.videoWidth||640; c.height = v.videoHeight||480;
    c.getContext("2d").drawImage(v, 0, 0);
    setUser(u => ({...u, photo:c.toDataURL("image/jpeg",.92)}));
    setPhotoSource("camera"); closeCamera(); toast("Photo captured.");
  };

  const handleGalleryPick = e => {
    const file = e.target.files[0]; if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Please select an image."); return; }
    const reader = new FileReader();
    reader.onload = ev => { setUser(u => ({...u, photo:ev.target.result})); setPhotoSource("gallery"); toast("Photo selected."); };
    reader.readAsDataURL(file); e.target.value = "";
  };

  // Workspace Files upload. Used to store each picked File as URL.createObjectURL(f) — a blob:
  // URL, valid only in this tab's memory for as long as the page stays open. Since `files` was
  // also never written to window.storage at all, every uploaded file was silently gone the
  // moment the page reloaded or a fresh login ran, even though the list still showed it until
  // then — the exact same bug toggleVoiceMemo had, fixed the same way: a data: URL (a plain,
  // JSON-serializable string) plus real persistence (see the filesData save effect above).
  // Capped per-file rather than left unbounded, since a data: URL keeps the whole file in memory
  // and in kv_store's jsonb column, unlike a blob: URL which only ever held a lightweight handle.
  const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024;
  // Optional projectId: when the upload was triggered from inside a project (its own "+ New"
  // for Files, not the general Files screen), the new file(s) land in the one real Files list
  // — still searchable/manageable from the Files screen — but get auto-linked to that project
  // too, so the person never has to go pick them back out of the shared list afterward.
  const handleFilesUpload = (e, projectId) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!picked.length) return;
    const ok = picked.filter(f => f.size <= MAX_UPLOAD_FILE_BYTES);
    const tooBig = picked.length - ok.length;
    if (tooBig > 0) toast(`${tooBig} file${tooBig!==1?"s":""} skipped — over the 8MB limit.`);
    if (!ok.length) return;
    Promise.all(ok.map(f => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id:uid(), name:f.name, size:f.size, type:f.type||"file", date:dateStr(), url:reader.result, contactId:null });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    }))).then(results => {
      const added = results.filter(Boolean);
      if (!added.length) return;
      setFiles(p => [...added, ...p]);
      if (projectId) setProjects(p => p.map(pr => pr.id===projectId ? { ...pr, fileIds:[...(pr.fileIds||[]), ...added.map(a=>a.id)] } : pr));
      toast(`${added.length} file${added.length!==1?"s":""} added${projectId?" to project.":"."}`);
    });
  };

  // ── Voice mode ────────────────────────────────────────────────────────────────────────
  // A full turn loop: listen → transcribe → answer → speak → back to listening. The two
  // things that make or break this are echo (the mic hearing KROFT's own voice and treating
  // it as the next question) and barge-in (being able to cut a long answer off), so both are
  // handled explicitly rather than left to the browser.
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceState, setVoiceState] = useState("idle"); // idle | listening | thinking | speaking
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceReply, setVoiceReply] = useState("");
  const [voiceError, setVoiceError] = useState("");
  // Mic level is read on every animation frame, so it lives in a ref, not state. As state it
  // re-rendered the entire app ~60 times a second the whole time voice mode was listening,
  // which stutters badly on a phone. The orb reads this ref directly inside its own render loop.
  const voiceLevelRef = useRef(0);
  const lastLenRef = useRef(0);
  const silenceRef = useRef(0);   // consecutive no-speech results, for the quiet retry above
  const listeningRef = useRef(false); // true while a recognizer is live, to block a second one
  // Whether the mic has already been granted, so the priming copy only shows the first time.
  // Queried rather than assumed — a returning user shouldn't be re-told what they've allowed.
  const [micPrimed, setMicPrimed] = useState(false);
  useEffect(() => {
    if (!voiceOpen || !navigator.permissions?.query) return;
    navigator.permissions.query({ name:"microphone" })
      .then(r => setMicPrimed(r.state === "granted"))
      .catch(() => {});
  }, [voiceOpen]);
  // Decays the fallback nudge so the orb settles back between words instead of staying puffed
  // out. Harmless when real amplitude is driving it, since that overwrites the value each frame.
  useEffect(() => {
    if (voiceState !== "listening") return;
    const t = setInterval(() => { voiceLevelRef.current *= 0.82; }, 90);
    return () => clearInterval(t);
  }, [voiceState]);
  const voiceRecRef = useRef(null);
  // Set once if the device's own language (speechLang()) turns out to be one Chrome's
  // recognizer rejects outright — see the "language-not-supported" handling below. null means
  // "use the device's language", so this only ever overrides it for the one device/session where
  // that language actually doesn't work.
  const voiceLangOverrideRef = useRef(null);
  const voiceAudioRef = useRef(null);   // { ctx, analyser, stream, raf }
  const voiceStopRef = useRef(null);    // cancels in-flight speech
  const voiceAbortRef = useRef(null);   // cancels an in-flight generation
  const voiceOpenRef = useRef(false);
  voiceOpenRef.current = voiceOpen;
  const SRSupported = typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  // Mic level drives the orb's deformation. Read from an AnalyserNode rather than from the
  // recognition API, which reports no amplitude at all.
  const startMeter = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i]-128)/128; sum += v*v; }
        voiceLevelRef.current = Math.min(1, Math.sqrt(sum/buf.length) * 4.5);
        voiceAudioRef.current.raf = requestAnimationFrame(tick);
      };
      voiceAudioRef.current = { ctx, stream, raf:null };
      tick();
    } catch { /* meter is cosmetic — the loop still works without it */ }
  };
  const stopMeter = () => {
    const a = voiceAudioRef.current;
    if (!a) return;
    if (a.raf) cancelAnimationFrame(a.raf);
    a.stream?.getTracks().forEach(t => t.stop());
    a.ctx?.close?.();
    voiceAudioRef.current = null;
    voiceLevelRef.current = 0;
  };

  const voiceListen = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setVoiceError("Live speech recognition isn't available in this browser."); return; }
    // Guard against starting a second recognizer. The silence retry fires on a timer while the
    // end-of-speech handler can also restart listening — both would construct a recognizer, but
    // only the last one lands in the ref, leaving the first running invisibly: duplicated
    // transcripts and a live mic that Stop can no longer reach.
    if (listeningRef.current) return;
    listeningRef.current = true;
    voiceRecRef.current?.abort?.();
    setVoiceError(""); setVoiceTranscript(""); lastLenRef.current = 0;
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = voiceLangOverrideRef.current || speechLang();
    r.onstart = () => { setMicPrimed(true); setVoiceState("listening"); };
    r.onresult = e => {
      const text = Array.from(e.results).map(x => x[0].transcript).join("");
      setVoiceTranscript(text);
      // Fallback drive for the orb. On some Android builds the recognizer takes exclusive mic
      // access, which starves the AnalyserNode and leaves the measured level flat at zero even
      // though transcription is working. Nudging the level on each new word keeps the orb
      // visibly reacting; when real amplitude is available it's larger and wins anyway.
      if (text.length !== lastLenRef.current) {
        lastLenRef.current = text.length;
        voiceLevelRef.current = Math.max(voiceLevelRef.current, 0.55);
      }
      if (e.results[e.results.length-1].isFinal && text.trim()) {
        silenceRef.current = 0;
        r.stop();
        voiceAnswer(text.trim());
      }
    };
    r.onerror = ev => {
      listeningRef.current = false;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setVoiceState("idle");
        setVoiceError("Microphone access was blocked. Allow it in your browser settings to use voice mode.");
        return;
      }
      if (ev.error === "aborted") { setVoiceState("idle"); return; }
      if (ev.error === "no-speech") {
        // Silence isn't an error — it usually means the person is still thinking. Quietly
        // re-open the mic a couple of times before giving up, instead of dropping to idle with
        // no explanation and making them tap again.
        silenceRef.current += 1;
        if (silenceRef.current <= 2 && voiceOpenRef.current) { setTimeout(() => { if (voiceOpenRef.current) voiceListen(); }, 250); return; }
        silenceRef.current = 0;
        setVoiceState("idle");
        setVoiceError("I didn't catch anything. Tap the orb when you're ready.");
        return;
      }
      // Chrome's speech recognition sends audio to Google's servers to transcribe it, so a poor
      // connection surfaces here as "network" — distinct from every other case above, all of
      // which are local (permissions, silence, the mic itself), and worth telling apart from the
      // generic fallback below since the fix is completely different (check your connection vs.
      // just retry).
      if (ev.error === "network") {
        setVoiceState("idle");
        setVoiceError("Voice recognition needs a network connection — check yours and try again.");
        return;
      }
      if (ev.error === "audio-capture") {
        setVoiceState("idle");
        setVoiceError("No working microphone found on this device.");
        return;
      }
      // r.lang was set from the device's own language (see speechLang()) rather than always
      // "en-US" — most devices report a language Chrome's recognizer actually supports, but a
      // regional tag it doesn't (e.g. a less common locale) fails every single attempt with no
      // way for the person to fix it themselves. voiceListen() builds a brand-new recognizer on
      // every call and would just pick the same unsupported language again, so the override has
      // to live outside this one instance — falling back to "en-US" via the ref and retrying
      // once keeps voice mode usable instead of permanently broken for anyone in that situation.
      if (ev.error === "language-not-supported" && r.lang !== "en-US") {
        voiceLangOverrideRef.current = "en-US";
        setTimeout(() => { if (voiceOpenRef.current) voiceListen(); }, 250);
        return;
      }
      setVoiceState("idle");
      setVoiceError(`Couldn't hear that (${ev.error}). Tap to try again.`);
    };
    r.onend = () => { listeningRef.current = false; setVoiceState(s => (s === "listening" ? "idle" : s)); };
    voiceRecRef.current = r;
    try {
      r.start(); startMeter();
    } catch {
      // r.start() throwing (e.g. a recognizer instance the browser considers still active from
      // a moment ago) used to fail completely silently here — listeningRef reset, but voiceState
      // never left "idle" and no error ever appeared. From the outside that looks exactly like
      // tapping the orb did nothing at all, with no way to tell "it's broken" from "it's about
      // to start." Surfacing it lets the person retry instead of staring at a frozen orb.
      listeningRef.current = false;
      setVoiceState("idle");
      setVoiceError("Couldn't start listening. Tap the orb to try again.");
    }
  };

  const voiceAnswer = async question => {
    // The recognizer is stopped before KROFT speaks. Left running, it transcribes KROFT's own
    // voice out of the speaker and feeds it straight back as the next question, and the
    // conversation runs away with itself.
    voiceRecRef.current?.abort?.();
    listeningRef.current = false;
    stopMeter();
    setVoiceState("thinking");
    setVoiceTranscript(question);

    // Voice mode has its own daily allowance, separate from typed chat, so a busy voice
    // conversation and a busy typing session never compete for the same quota.
    if (!spendVoiceTurn()) {
      const msg = `That's today's ${voiceLimit} free voice turns. They reset in about ${resetsIn()}, or KROFT Plus removes the limit — typed chat still works.`;
      setVoiceTranscript(""); setVoiceReply(msg); setVoiceState("speaking");
      voiceStopRef.current = speakSequence([msg], { onDone: () => { voiceStopRef.current = null; setVoiceState("idle"); } });
      return;
    }

    const convo = [...aiMessages, { role:"user", content:question }];
    setAiMessages(convo);

    // "Call Samson" is more useful spoken than typed — hands are busy, which is the whole point
    // of voice mode. Acts on it directly rather than asking to confirm, since a confirmation
    // step read aloud costs more than it saves.
    const action = resolveContactAction(question);
    if (action) {
      const verb = { email:"Opening an email to", call:"Calling", text:"Texting" }[action.type];
      const line = `${verb} ${action.contact.name}.`;
      setAiMessages(p => [...p, { role:"assistant", content:line }]);
      setVoiceTranscript(""); setVoiceReply(line); setVoiceState("speaking");
      voiceStopRef.current = speakSequence([line], {
        onDone: () => {
          voiceStopRef.current = null;
          setVoiceOpen(false);
          runContactAction(action);
        },
      });
      return;
    }

    // Speech is queued sentence-by-sentence as the reply generates, rather than after it
    // completes. That cuts the dead air before KROFT starts talking from several seconds to
    // roughly one.
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    const queue = createSpeechQueue({
      onStart: () => { setVoiceTranscript(""); setVoiceState("speaking"); },
      onDone: () => {
        voiceStopRef.current = null;
        // Hand the turn straight back so it stays a conversation instead of making the
        // person tap between every exchange — but not instantly: reopening the mic the moment
        // KROFT's own voice ends risks it picking up the tail of its own audio (room echo,
        // speaker bleed on a phone with no headset) as if it were the next thing said, which
        // reads as KROFT answering itself before the person gets a word in. A short pause here
        // lets that decay first, so listening only resumes once KROFT has actually finished
        // replying to what was first said.
        if (voiceOpenRef.current) setTimeout(() => { if (voiceOpenRef.current) voiceListen(); }, 600);
      },
    });
    voiceStopRef.current = () => queue.cancel();

    let raw = "", failed = null, aborted = false;
    // Tracks the newest partial so an interrupted reply can still be saved. Cutting KROFT off
    // used to discard the answer entirely — the words were spoken, then vanished from history,
    // leaving no record of what was said.
    let latest = "";
    try {
      raw = await runKroftCompletion(convo, {
        signal: controller.signal,
        usageType: "voice",
        voiceMode: true,
        onDelta: partial => {
          if (!voiceOpenRef.current) return;
          latest = partial;
          setVoiceReply(partial);
          queue.push(partial);
        },
      });
    } catch (err) {
      if (err.name === "AbortError") aborted = true;
      else failed = err instanceof KroftError ? err.message : "Something went wrong just then. Try me again.";
    }
    voiceAbortRef.current = null;

    // Keep whatever had been generated when the person interrupted, marked so the history shows
    // it was cut short rather than silently looking like a complete answer.
    if (aborted) {
      queue.cancel();
      const partial = extractAction(latest).clean.trim();
      if (partial) setAiMessages(p => [...p, { role:"assistant", content:partial, stopped:true }]);
      setVoiceState("idle");
      return;
    }
    if (!voiceOpenRef.current) { queue.cancel(); return; }

    if (failed) {
      queue.cancel();
      setVoiceTranscript(""); setVoiceReply(failed); setVoiceState("speaking");
      voiceStopRef.current = speakSequence([failed], { onDone: () => { voiceStopRef.current = null; setVoiceState("idle"); } });
      return;
    }
    if (!raw) { setVoiceState("idle"); return; }

    const { clean, action: aiAction } = extractAction(raw);
    const actionResult = aiAction ? applyAutoAction(aiAction) : null;
    setAiMessages(p => [...p, { role:"assistant", content:clean }]);
    if (actionResult) toast(actionResult.label, actionResult.undo);
    setVoiceReply(clean);
    queue.end(clean);
  };

  // Holds a screen wake lock while voice mode is open. Without it the phone dims and sleeps
  // during a hands-free conversation — which suspends the recognizer and kills the turn
  // mid-sentence, exactly when the person is least able to reach over and tap the screen.
  useEffect(() => {
    if (!voiceOpen || !("wakeLock" in navigator)) return;
    let lock = null, released = false;
    const acquire = async () => {
      try { lock = await navigator.wakeLock.request("screen"); } catch { /* denied or unsupported */ }
    };
    acquire();
    // Wake locks are dropped when the tab is backgrounded, so re-acquire on return.
    const onVisible = () => { if (document.visibilityState === "visible" && !released) acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release?.().catch(() => {});
    };
  }, [voiceOpen]);

  const voiceStop = () => {
    // Barge-in: cuts speech, listening, or an in-flight reply immediately and returns to idle.
    voiceAbortRef.current?.abort(); voiceAbortRef.current = null;
    voiceStopRef.current?.(); voiceStopRef.current = null;
    stopSpeaking();
    listeningRef.current = false;
    voiceRecRef.current?.abort?.();
    stopMeter();
    setVoiceState("idle");
  };

  const closeVoice = () => { voiceStop(); setVoiceOpen(false); setVoiceTranscript(""); setVoiceReply(""); setVoiceError(""); };

  // A call that rings without being answered eventually stops, the way a real one does, rather
  // than sitting on screen forever.
  useEffect(() => {
    if (!incomingCall) { if (callTimeoutRef.current) { clearTimeout(callTimeoutRef.current); callTimeoutRef.current = null; } return; }
    callTimeoutRef.current = setTimeout(() => {
      setScheduledCalls(p => p.map(x => x.id===incomingCall.id ? { ...x, status:"missed" } : x));
      setIncomingCall(null);
    }, 25000);
    // A gentle buzz on supported devices — the closest this can get to an actual ring, since a
    // background browser tab can't play audio without having already been granted that.
    navigator.vibrate?.([300, 150, 300]);
    return () => { if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current); };
  }, [incomingCall]);

  // Drives the reminder alarm's repeating beep + vibration while ReminderAlarmScreen is up —
  // this is what actually makes it read as "an alarm" rather than a one-off ping. Capped at 2
  // minutes of sound (the screen itself stays up regardless, until dismissed or snoozed) so a
  // reminder nobody's near doesn't buzz a background tab forever.
  useEffect(() => {
    if (alarmLoopRef.current) { clearInterval(alarmLoopRef.current); alarmLoopRef.current = null; }
    if (!ringingReminder) return;
    const ring = () => { playAlarmBeep(); haptic([250, 120, 250]); };
    ring();
    let elapsed = 0;
    alarmLoopRef.current = setInterval(() => {
      elapsed += 1500;
      if (elapsed >= 120000) { clearInterval(alarmLoopRef.current); alarmLoopRef.current = null; return; }
      ring();
    }, 1500);
    return () => { if (alarmLoopRef.current) { clearInterval(alarmLoopRef.current); alarmLoopRef.current = null; } };
  }, [ringingReminder]);

  const dismissReminderAlarm = () => setRingingReminder(null);
  // Re-rings the same reminder in 10 minutes rather than touching its stored `when` — a snooze
  // is about right now, not a change to when this was actually supposed to happen.
  const snoozeReminderAlarm = () => {
    const r = ringingReminder;
    if (!r) return;
    setRingingReminder(null);
    toast(`Snoozed — "${r.text}" again in 10 minutes.`);
    setTimeout(() => setRingingReminder(prev => prev ? prev : r), 10 * 60000);
  };

  const answerCall = () => {
    const call = incomingCall;
    if (!call) return;
    setScheduledCalls(p => p.map(x => x.id===call.id ? { ...x, status:"answered" } : x));
    setIncomingCall(null);
    // Opens voice mode with KROFT speaking first rather than waiting to be asked — that's the
    // difference between "a reminder you can talk to" and an ordinary voice-mode session.
    setVoiceOpen(true);
    setVoiceState("speaking");
    setVoiceReply("");
    const msg = `Hey ${firstNameOf(user.name)||"there"}, this is your reminder call — ${call.title}.${call.note ? ` ${call.note}` : ""}`;
    voiceStopRef.current = speakSequence([msg], {
      context:"reminder",
      onDone: () => { voiceStopRef.current = null; if (voiceOpenRef.current) voiceListen(); },
    });
  };

  const declineCall = () => {
    if (!incomingCall) return;
    setScheduledCalls(p => p.map(x => x.id===incomingCall.id ? { ...x, status:"declined" } : x));
    setIncomingCall(null);
  };

  // Never leave the mic hot or speech playing if voice mode unmounts.
  useEffect(() => () => { voiceAbortRef.current?.abort(); voiceStopRef.current?.(); stopSpeaking(); voiceRecRef.current?.abort?.(); stopMeter(); }, []);

  const toggleListen = useCallback(() => {
    if (listening) { recRef.current?.stop(); setListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Speech recognition needs Chrome or Edge."); return; }
    const r = new SR(); r.continuous=false; r.interimResults=true; r.lang=speechLang();
    r.onstart = () => setListening(true); r.onend = () => setListening(false);
    r.onresult = e => { const t = Array.from(e.results).map(x => x[0].transcript).join(""); setTranscript(t); if (e.results[0].isFinal) { setAiInput(t); setTab("nova"); setTranscript(""); } };
    r.onerror = () => { setListening(false); toast("Mic error — check permissions."); };
    recRef.current = r; r.start();
  }, [listening]);

  // Voice Memos — real MediaRecorder audio capture, with live transcript via SpeechRecognition
  const toggleVoiceMemo = useCallback(async () => {
    if (recordingMemo) {
      memoRecRef.current?.stop();
      setRecordingMemo(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) { toast("Microphone not supported on this device."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      memoChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      let liveTranscript = "";

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      let sr = null;
      if (SR) {
        sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = speechLang();
        sr.onresult = e => { liveTranscript = Array.from(e.results).map(x => x[0].transcript).join(" "); };
        sr.onerror = () => {};
        sr.start();
      }

      mr.ondataavailable = e => { if (e.data.size > 0) memoChunksRef.current.push(e.data); };
      // Timed from the recorder itself. The duration field was stored as null and never
      // computed, so every memo card showed its length as blank.
      const startedAt = Date.now();
      mr.onstop = () => {
        const blob = new Blob(memoChunksRef.current, { type:"audio/webm" });
        const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        stream.getTracks().forEach(t => t.stop());
        sr?.stop();
        // A data: URL (not URL.createObjectURL's blob: URL) — that's the whole fix for memos
        // vanishing on reload/logout. blob: URLs only ever live in this tab's memory and are
        // never valid again after any reload, so even though voiceMemos itself is now
        // persisted (see the save effect below), the audio each entry pointed to was gone the
        // moment the page reloaded regardless. A data: URL is just a string, so it round-trips
        // through JSON/kv_store like every other field and plays back identically as an
        // <audio src>.
        const reader = new FileReader();
        reader.onload = () => {
          const url = reader.result;
          setVoiceMemos(p => [{ id:uid(), title:"", url, transcript: liveTranscript || "No speech detected.", date: dateStr(), time: timeStr(), duration }, ...p]);
          toast("Voice memo saved.");
        };
        reader.onerror = () => toast("Couldn't save that recording.");
        reader.readAsDataURL(blob);
      };
      memoRecRef.current = mr;
      mr.start();
      setRecordingMemo(true);
    } catch {
      toast("Couldn't access microphone — check permissions.");
    }
  }, [recordingMemo]);

  // KROFT's view of the user's world. Previously this passed only totals, mood and a flat list
  // of appointment titles — so the assistant couldn't answer "what's on today?", "what's due
  // this week?" or "where is my money going?", which is most of what a personal assistant is
  // for. Everything is capped and summarised rather than dumped, so context stays affordable.
  const krofSysPrompt = (voiceMode = false) => {
    const now = new Date();
    const today = todayISO();
    const cur = user.currency;
    const money = n => fmtCur(n, cur);

    const list = (arr, n, fn) => arr.slice(0, n).map(fn).join("; ") || "none";
    const thisMonth = iso => (iso || "").slice(0, 7) === today.slice(0, 7);

    // Finance: totals plus where the money actually goes, and how this month compares.
    const byCat = {};
    expenses.forEach(e => { byCat[e.cat] = (byCat[e.cat] || 0) + e.amount; });
    const topCats = Object.entries(byCat).sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([c,v]) => `${c} ${money(v)}`).join(", ") || "none";
    const monthIncome = income.filter(r => thisMonth(r.date)).reduce((s,r) => s+r.amount, 0);
    const monthExpenses = expenses.filter(r => thisMonth(r.date)).reduce((s,r) => s+r.amount, 0);

    // Schedule: split so "today" and "coming up" are distinguishable, and past ones don't
    // pollute the answer.
    const dated = appts.filter(a => a.date);
    const todays = dated.filter(a => a.date === today);
    const upcoming = dated.filter(a => a.date > today).sort((a,b) => a.date.localeCompare(b.date));

    const openTasks = tasks.filter(t => !t.done);
    const openReminders = smartReminders.filter(r => !r.done);
    const unread = emails.filter(e => !e.read);
    const firstName = firstNameOf(user.name);

    return `You are KROFT, a personal AI assistant by Virt Technologies. You can answer any question on any topic, and you also have live access to this user's own data (below). Use it whenever the question touches their money, schedule, work or people — quote real figures and real titles rather than speaking generally. If the data below doesn't cover something, say so plainly instead of guessing. Always reply in the same language the user just wrote or spoke in, not English by default — this app's voice input already recognizes speech in the device's own configured language, not only English.

CURRENT MOMENT
Date: ${now.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})} (${today})
Time: ${now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}

USER
Name: ${user.name||"not set"}
Business: ${user.businessName||"not set"}${user.businessType?` (${user.businessType})`:""}
Currency: ${cur}
Current mood: ${mood||"not set"}

FINANCE
All-time income: ${money(totalIncome)} | expenses: ${money(totalExpenses)} | net: ${money(netProfit)}
This month: income ${money(monthIncome)}, expenses ${money(monthExpenses)}, net ${money(monthIncome-monthExpenses)}
Top expense categories: ${topCats}
Budgets this month: ${budgetStatus().length
  ? budgetStatus().map(b => `${b.cat} ${money(b.spent)} of ${money(b.limit)}${b.pct>=1?" (OVER)":b.pct>=0.8?" (close)":""}`).join(", ")
  : "none set"}
Recent income: ${list(income.slice().reverse(), 5, r => `${r.label} ${money(r.amount)} (${r.date})`)}
Recent expenses: ${list(expenses.slice().reverse(), 5, r => `${r.label} ${money(r.amount)} ${r.cat} (${r.date})`)}

SCHEDULE
Today (${todays.length}): ${list(todays, 10, a => `${a.title} at ${a.time}${a.location?` — ${a.location}`:""}`)}
Upcoming (${upcoming.length}): ${list(upcoming, 8, a => `${a.title} on ${a.date} at ${a.time}`)}

TASKS (${openTasks.length} open)
${list(openTasks, 12, t => `${t.title} [${t.priority}]`)}

REMINDERS (${openReminders.length} open)
${list(openReminders, 8, r => `${r.text}${r.when?` (${r.when})`:""}`)}

PROJECTS (${projects.length})
${list(projects, 8, p => `${p.name} — ${p.status}${p.deadline?`, due ${p.deadline}`:""}`)}

NOTES (${notes.length}): ${list(notes, 8, n => n.title || "untitled")}
DOCUMENTS (${documents.length}): ${list(documents, 8, d => d.title || "untitled")}
CONTACTS (${contacts.length}): ${list(contacts, 12, c => `${c.name}${c.email?` <${c.email}>`:""} (${c.category})`)}
EMAIL: ${unread.length} unread${unread.length?` — recent: ${list(unread, 5, m => `"${m.subject}" from ${m.from}`)}`:""}

STYLE
Talk like a sharp, genuinely warm human assistant who knows this person well — never like an AI describing itself. Never say things like "As an AI," "I don't have personal experiences," or any other AI-disclaimer or meta-commentary about what you are — just answer, the way a person would. Use contractions and plain, natural sentences; vary how you open a reply instead of starting the same way every time. Address ${firstName||"them"} by their first name every so often — a greeting, good news, a heads-up — not stapled onto every single reply, which reads as scripted rather than natural. Keep answers tight — a couple of short paragraphs unless asked for depth. Prefer plain sentences over headings and bullet lists; replies are often read aloud.

LIMITS
You are a bookkeeping and organisation assistant, not a licensed financial adviser. You can describe what is in their records, do arithmetic on it, and point out patterns. Do not recommend investments, tax positions, borrowing, insurance or financial products, and do not tell them what to do with their money. If asked for that, say plainly that it needs a qualified accountant or adviser, then offer what you can — the relevant figures from their own records.

ACTIONS
When ${user.name||"the user"} asks you to record, add, schedule, change or remove something, actually do it by appending ONE action block to the very end of your reply, after your normal sentence:
<action>{"type":"...","...":"..."}</action>
Valid types and their fields:
{"type":"add_task","title":"string","priority":"High|Medium|Low"}
{"type":"add_expense","label":"string","amount":number,"cat":"string"}
{"type":"add_income","label":"string","amount":number,"cat":"string"}
{"type":"add_appointment","title":"string","date":"YYYY-MM-DD","time":"HH:MM","location":"string"}
{"type":"add_note","title":"string","body":"string"}
{"type":"add_reminder","text":"string","when":"string"}
{"type":"complete_task","title":"string"}
{"type":"edit_appointment","title":"string","date":"YYYY-MM-DD","time":"HH:MM"}
{"type":"delete_task","title":"string"}
{"type":"delete_expense","label":"string"}
{"type":"delete_income","label":"string"}
{"type":"delete_appointment","title":"string"}
{"type":"delete_reminder","text":"string"}
{"type":"delete_note","title":"string"}
{"type":"send_email","to":"string","subject":"string","body":"string"}
Rules: amounts are positive numbers with no currency symbol. Resolve relative dates ("tomorrow", "next Friday") against the current date above and emit an absolute YYYY-MM-DD. Expense categories to prefer: ${expenseCats.join(", ")}. Income categories to prefer: ${incomeCats.join(", ")}. Emit at most one action per reply, only when clearly asked to save, change or remove something — never for a question like "how much did I spend?". complete_task, edit_appointment, and every delete_* type match an EXISTING item by its title/label/text against the lists above — use the shortest distinctive wording from that list, not a paraphrase, so the match is unambiguous. edit_appointment only needs the field(s) actually changing (e.g. just "time" to only move the time). Only set send_email's "to" to an address that actually appears in CONTACTS or EMAIL above — never guess or construct one; if you don't have a real address for who they mean, say so and ask for it instead of emitting the action.
${voiceMode
  ? `You're in a spoken voice conversation right now. Never emit a delete_* or send_email action block here — that confirmation step needs a screen this voice UI doesn't have. If asked to delete or send something, say you'll get it ready but they'll need to confirm it in the app, and leave out the action block entirely.`
  : `delete_* and send_email are NOT executed immediately — the app shows a confirm/cancel step first, so word your sentence as an offer ("I'll have that ready to send — just confirm it") rather than a completed fact. Every other action type above already happened by the time your reply is read, so word those as done.`}`;
  };

  // Pulls the action block out of a reply. The block is stripped before the text is shown or
  // spoken, so the user never sees raw JSON and it never gets read aloud.
  const ACTION_RE = /<action>\s*([\s\S]*?)\s*<\/action>/i;
  const extractAction = text => {
    const m = text.match(ACTION_RE);
    if (!m) return { clean:text, action:null };
    let action = null;
    try { action = JSON.parse(m[1]); } catch { action = null; }
    return { clean:text.replace(ACTION_RE, "").trim(), action };
  };

  // Finds the existing item complete_task/edit_appointment refers to. Only ever reached via a
  // title the model was told to copy verbatim from the same TASKS/SCHEDULE list it was just
  // shown, so a case-insensitive substring match is enough — this is matching the model's own
  // quoted-back wording, not fuzzy-searching free text a person typed.
  const findByTitle = (list, title) => list.find(x => x.title.toLowerCase().includes(title.toLowerCase()));

  // Executes an action the model asked for. add_* stays additive-only, so a misread instruction
  // there can at worst create one stray item, covered by the undo toast. complete_task and
  // edit_appointment modify an existing item instead — same undo-toast safety net (the previous
  // state is captured and restored), but unlike add_*, a failed match returns a toast explaining
  // why rather than silently doing nothing: the model's reply already told the user it was done,
  // so staying quiet on a miss would leave them wrongly believing it happened. Nothing here can
  // delete an item or send anything on the user's behalf — those still require the person's own
  // hand, deliberately, until a real confirm-before-execute flow exists for actions that aren't
  // trivially reversible by an undo tap.
  const applyAiAction = action => {
    if (!action || typeof action !== "object") return null;
    const str = v => (typeof v === "string" ? v.trim() : "");
    const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d+"T00:00:00"));
    switch (action.type) {
      case "complete_task": {
        const title = str(action.title); if (!title) return null;
        const match = findByTitle(tasks.filter(t => !t.done), title);
        if (!match) return { label:`Couldn't find an open task matching "${title}" to complete.` };
        setTasks(p => p.map(x => x.id === match.id ? { ...x, done:true } : x));
        return { label:`Marked done: ${match.title}`, undo:() => setTasks(p => p.map(x => x.id === match.id ? { ...x, done:false } : x)) };
      }
      case "edit_appointment": {
        const title = str(action.title); if (!title) return null;
        const match = findByTitle(appts, title);
        if (!match) return { label:`Couldn't find an appointment matching "${title}" to reschedule.` };
        const newDate = validDate(action.date) ? action.date : match.date;
        const newTime = str(action.time) || match.time;
        const prev = { date:match.date, time:match.time };
        setAppts(p => p.map(x => x.id === match.id ? { ...x, date:newDate, time:newTime } : x));
        return { label:`Rescheduled "${match.title}" to ${newDate} at ${newTime}`, undo:() => setAppts(p => p.map(x => x.id === match.id ? { ...x, ...prev } : x)) };
      }
      case "add_task": {
        const title = str(action.title); if (!title) return null;
        const priority = ["High","Medium","Low"].includes(action.priority) ? action.priority : "Medium";
        const item = { id:uid(), title, priority, repeat:"none", contactId:null, done:false };
        setTasks(p => [item, ...p]);
        return { label:`Task added: ${title}`, undo:() => setTasks(p => p.filter(x => x.id !== item.id)) };
      }
      case "add_expense":
      case "add_income": {
        const label = str(action.label); const amt = parseAmount(action.amount);
        if (!label || amt === null) return null;
        const isInc = action.type === "add_income";
        const cats = isInc ? incomeCats : expenseCats;
        const cat = cats.includes(str(action.cat)) ? str(action.cat) : cats[0];
        const item = { id:uid(), label, amount:amt, cat, date:validDate(action.date)?action.date:todayISO(), cur:user.currency };
        (isInc ? setIncome : setExpenses)(p => [...p, item]);
        return {
          label:`${isInc?"Income":"Expense"} added: ${label} ${fmtCur(amt,user.currency)}`,
          undo:() => (isInc ? setIncome : setExpenses)(p => p.filter(x => x.id !== item.id)),
        };
      }
      case "add_appointment": {
        const title = str(action.title); if (!title) return null;
        const item = { id:uid(), title, date:validDate(action.date)?action.date:todayISO(), time:str(action.time)||"09:00", location:str(action.location), notes:"", urgent:false, repeat:"none", contactId:null };
        setAppts(p => [...p, item]);
        mirrorAppointmentToCalendars(item);
        return { label:`Appointment added: ${title}`, undo:() => setAppts(p => p.filter(x => x.id !== item.id)) };
      }
      case "add_note": {
        const body = str(action.body); const title = str(action.title);
        if (!body && !title) return null;
        const item = { id:uid(), title, body, date:dateStr(), contactId:null };
        setNotes(p => [item, ...p]);
        return { label:`Note saved${title?`: ${title}`:""}`, undo:() => setNotes(p => p.filter(x => x.id !== item.id)) };
      }
      case "add_reminder": {
        const text = str(action.text); if (!text) return null;
        const item = { id:uid(), text, when:str(action.when), done:false, aiSuggested:true, contactId:null };
        setSmartReminders(p => [item, ...p]);
        return { label:`Reminder set: ${text}`, undo:() => setSmartReminders(p => p.filter(x => x.id !== item.id)) };
      }
      default: return null;
    }
  };

  // Action types that never execute immediately — a delete can't be reversed by an undo tap the
  // way an add can (the item might have been referenced elsewhere by the time someone taps undo),
  // and a sent email genuinely can't be unsent. Both get a real confirm/cancel step instead.
  const CONFIRM_ACTION_TYPES = new Set(["delete_task","delete_expense","delete_income","delete_appointment","delete_reminder","delete_note","send_email"]);

  // Safety net for voice mode: krofSysPrompt(true) already tells the model never to emit a
  // confirm-gated action while speaking, since there's no screen there to confirm on — but a
  // model can still not follow an instruction perfectly. This makes that failure mode inert: a
  // confirm-gated action reaching here is ignored rather than silently executed with no one able
  // to confirm it. Only voiceAnswer uses this; the text chat's own confirm/cancel card is the
  // real gate for everyone else.
  const applyAutoAction = action => (action && CONFIRM_ACTION_TYPES.has(action.type)) ? null : applyAiAction(action);

  const findBy = (list, field, value) => list.find(x => (x[field]||"").toLowerCase().includes(value.toLowerCase()));

  // Validates a confirm-gated action WITHOUT touching any data, so the confirm/cancel card can
  // show exactly what's about to happen. Mirrors applyAiAction's own miss-handling: a target
  // that can't be found returns a reason instead of quietly proceeding, since the model's reply
  // already framed this as something about to happen.
  const describePendingAction = action => {
    if (!action || typeof action !== "object") return { ok:false };
    const str = v => (typeof v === "string" ? v.trim() : "");
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    switch (action.type) {
      case "delete_task": {
        const title = str(action.title); if (!title) return { ok:false };
        const match = findByTitle(tasks, title);
        if (!match) return { ok:false, reason:`Couldn't find a task matching "${title}" to delete.` };
        return { ok:true, summary:`Delete task "${match.title}"?` };
      }
      case "delete_expense":
      case "delete_income": {
        const isInc = action.type === "delete_income";
        const label = str(action.label); if (!label) return { ok:false };
        const match = findBy(isInc ? income : expenses, "label", label);
        if (!match) return { ok:false, reason:`Couldn't find ${isInc?"income":"an expense"} matching "${label}" to delete.` };
        return { ok:true, summary:`Delete ${isInc?"income":"expense"} "${match.label}" (${fmtCur(match.amount,user.currency)})?` };
      }
      case "delete_appointment": {
        const title = str(action.title); if (!title) return { ok:false };
        const match = findByTitle(appts, title);
        if (!match) return { ok:false, reason:`Couldn't find an appointment matching "${title}" to delete.` };
        return { ok:true, summary:`Delete appointment "${match.title}" on ${match.date}?` };
      }
      case "delete_reminder": {
        const text = str(action.text); if (!text) return { ok:false };
        const match = findBy(smartReminders, "text", text);
        if (!match) return { ok:false, reason:`Couldn't find a reminder matching "${text}" to delete.` };
        return { ok:true, summary:`Delete reminder "${match.text}"?` };
      }
      case "delete_note": {
        const title = str(action.title); if (!title) return { ok:false };
        const match = findByTitle(notes, title);
        if (!match) return { ok:false, reason:`Couldn't find a note matching "${title}" to delete.` };
        return { ok:true, summary:`Delete note "${match.title}"?` };
      }
      case "send_email": {
        const to = str(action.to), subject = str(action.subject), body = str(action.body);
        // The model was told to only use an address that actually appeared in CONTACTS/EMAIL —
        // this doesn't re-verify that (nothing here has that list to check against a name), but
        // it does refuse anything that isn't even a plausible address, so a hallucinated or
        // malformed "to" fails closed instead of reaching the send card at all.
        if (!EMAIL_RE.test(to)) return { ok:false, reason:`I don't have a real email address for that — try naming a saved contact or a recent email sender.` };
        if (!subject && !body) return { ok:false };
        return { ok:true, summary:`Send to ${to}`, to, subject, body };
      }
      default: return { ok:false };
    }
  };

  // Runs a confirm-gated action — only ever called from the confirm/cancel card's Confirm
  // button, never automatically. Deletes still get an undo toast afterward (the removed item is
  // captured before it's spliced out): confirmed-then-undoable is a safer combination than
  // either alone. send_email has no undo once it's sent — that's exactly why it needs the
  // confirm step in the first place, unlike everything else in this file.
  const executeConfirmedAction = async action => {
    switch (action.type) {
      case "delete_task": {
        const match = findByTitle(tasks, action.title);
        if (!match) return { label:"That task is already gone." };
        setTasks(p => p.filter(x => x.id !== match.id));
        return { label:`Deleted task: ${match.title}`, undo:() => setTasks(p => [match, ...p]) };
      }
      case "delete_expense":
      case "delete_income": {
        const isInc = action.type === "delete_income";
        const setList = isInc ? setIncome : setExpenses;
        const match = findBy(isInc ? income : expenses, "label", action.label);
        if (!match) return { label:"That entry is already gone." };
        setList(p => p.filter(x => x.id !== match.id));
        return { label:`Deleted ${isInc?"income":"expense"}: ${match.label}`, undo:() => setList(p => [...p, match]) };
      }
      case "delete_appointment": {
        const match = findByTitle(appts, action.title);
        if (!match) return { label:"That appointment is already gone." };
        setAppts(p => p.filter(x => x.id !== match.id));
        return { label:`Deleted appointment: ${match.title}`, undo:() => setAppts(p => [...p, match]) };
      }
      case "delete_reminder": {
        const match = findBy(smartReminders, "text", action.text);
        if (!match) return { label:"That reminder is already gone." };
        setSmartReminders(p => p.filter(x => x.id !== match.id));
        return { label:`Deleted reminder: ${match.text}`, undo:() => setSmartReminders(p => [match, ...p]) };
      }
      case "delete_note": {
        const match = findByTitle(notes, action.title);
        if (!match) return { label:"That note is already gone." };
        setNotes(p => p.filter(x => x.id !== match.id));
        return { label:`Deleted note: ${match.title}`, undo:() => setNotes(p => [match, ...p]) };
      }
      case "send_email": {
        try {
          const res = await authedFetch("/api/mail/send", { method:"POST", body:JSON.stringify({ to:action.to, subject:action.subject, body:action.body }) });
          if (!res.ok) return { label:"Couldn't send that email — try again from the Emails tab." };
          return { label:`Sent to ${action.to}` };
        } catch {
          return { label:"Couldn't send that email — check your connection and try again." };
        }
      }
      default: return null;
    }
  };

  // Only the most recent slice of the conversation is sent. The full history stays on screen,
  // but shipping all of it on every turn means replies get slower and more expensive the longer
  // a session runs, and eventually the request exceeds the model's context window and fails
  // outright. Trimming from the front keeps the recent, relevant turns.
  // Plus sends more of it — a real, honest difference: a long-running conversation about an
  // ongoing situation ("we've been going over my Q3 numbers") stays coherent for longer instead
  // of the model quietly losing the earlier turns. It costs more in tokens per message, which is
  // exactly the kind of thing worth being a paid difference rather than a cosmetic one.
  const historyLimit = () => (subscribed ? 60 : 20);

  // Distinguishes failure modes. Everything used to collapse into one "couldn't process that",
  // which gave no clue whether to check your connection, wait, or just retry.
  class KroftError extends Error {}
  const friendlyError = status =>
    status === 429 ? "I'm being rate limited right now. Give it a moment and try again."
    : status === 401 || status === 403 ? "I couldn't authenticate with the AI service."
    : status >= 500 ? "The AI service is having trouble. Try again in a moment."
    : status === 400 ? "That request didn't go through. Try rephrasing it."
    : "Something went wrong reaching the AI service.";

  // onDelta streams tokens as they arrive; without it the call resolves with the full text.
  // Streaming matters most here because replies are long enough that a spinner-then-dump feels
  // broken, and because the first sentence can start being read aloud while the rest arrives.
  const runKroftCompletion = async (messages, { onDelta, signal, usageType = "chat", voiceMode = false } = {}) => {
    const recent = messages.slice(-historyLimit());
    const body = {
      model:"gemini-3.6-flash",
      max_tokens:2048,
      system:krofSysPrompt(voiceMode),
      messages:recent.map(m => ({ role:m.role, content:m.content })),
      ...(onDelta ? { stream:true } : {}),
    };

    // Neither the initial request nor an in-progress stream is guaranteed to ever resolve on its
    // own — a stalled auth/quota check server-side, or Gemini's own stream stopping mid-reply
    // without properly closing the connection, otherwise leaves every await below pending
    // forever. That's exactly what voice mode's "Thinking" state looked like happening live: no
    // error, no timeout, just stuck. An idle timer (reset on every real chunk of progress, not a
    // flat ceiling — a long real reply shouldn't get killed for taking a while) guarantees SOME
    // outcome no matter where the pipeline actually stalls: success, the caller's own abort
    // (voice mode's barge-in), or a clear timeout error — never a silent hang.
    const IDLE_MS = 25000;
    const combined = new AbortController();
    let timedOut = false, idleTimer;
    const armIdleTimer = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; combined.abort(); }, IDLE_MS); };
    const onExternalAbort = () => { clearTimeout(idleTimer); combined.abort(); };
    signal?.addEventListener("abort", onExternalAbort);
    const cleanup = () => { clearTimeout(idleTimer); signal?.removeEventListener("abort", onExternalAbort); };
    armIdleTimer();

    let res;
    try {
      res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":usageType}, body:JSON.stringify(body), signal: combined.signal });
    } catch (e) {
      cleanup();
      if (timedOut) throw new KroftError("That took too long to respond. Try again.");
      if (e.name === "AbortError") throw e;
      throw new KroftError("I can't reach the network right now. Check your connection and try again.");
    }
    armIdleTimer();
    if (!res.ok) {
      cleanup();
      // api/chat.js's own server-side quota check (the real, unspoofable enforcement — see its
      // comments) returns a distinct quota_exceeded body on 429, separate from an upstream AI
      // provider rate limit — surfaced with its own message rather than friendlyError's generic
      // "give it a moment and try again", which would be actively wrong advice for a daily/
      // monthly limit.
      if (res.status === 429) {
        const data = await res.json().catch(() => null);
        if (data?.error === "quota_exceeded") throw new KroftError(data.message);
      }
      // api/chat.js's two 401 causes ("Not authenticated" — no/expired Supabase session sent
      // with the request — vs. a server with no GEMINI_API_KEY/ANTHROPIC_API_KEY set at all)
      // both used to collapse into the same generic "couldn't authenticate" message, which gave
      // no way to tell a missing sign-in from a missing deploy config. Surfacing which one
      // actually happened turns this from a dead end into something fixable.
      if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => null);
        if (data?.error === "Not authenticated") throw new KroftError("You're not signed in — log in and try again.");
        if (data?.error?.includes?.("not configured with a")) throw new KroftError("The AI service isn't set up on the server yet (missing API key). Contact the app owner.");
      }
      throw new KroftError(friendlyError(res.status));
    }

    if (!onDelta) {
      const data = await res.json();
      cleanup();
      const text = data.content?.map(b => b.text||"").join("");
      if (!text) throw new KroftError("I got an empty response. Try asking again.");
      return text;
    }

    // Server-sent events: each line is `data: {...}`. Only text deltas matter here; the rest of
    // the event types (message_start, ping, message_stop) are ignored.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      let done, value;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        cleanup();
        if (timedOut) throw new KroftError("That took too long to respond. Try again.");
        if (e.name === "AbortError") throw e;
        throw new KroftError("Lost connection while KROFT was replying. Try again.");
      }
      if (done) break;
      // Real progress — a chunk actually arrived — so the idle clock resets. A genuinely long
      // reply keeps resetting this every chunk and never times out; only a true stall (nothing
      // for a full IDLE_MS straight) trips it.
      armIdleTimer();
      buffer += decoder.decode(value, { stream:true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.text) {
            full += evt.delta.text;
            // The action block is stripped before display, but it arrives token by token — so
            // hide anything from "<action" onward while streaming rather than flashing raw JSON.
            // Hide the action block as it arrives. Matching only the complete "<action" string
            // let a partial like "<act" through, which could be spoken aloud as stray
            // characters — so any trailing fragment that could still become the tag is cut too.
            let visible = full;
            const cut = full.indexOf("<action");
            if (cut !== -1) visible = full.slice(0, cut);
            else {
              const partialTag = full.match(/<a?c?t?i?o?n?$/);
              if (partialTag) visible = full.slice(0, full.length - partialTag[0].length);
            }
            onDelta(visible.trimEnd());
          }
        } catch { /* partial JSON across chunk boundary — the buffer picks it up next round */ }
      }
    }
    cleanup();
    if (!full) throw new KroftError("I got an empty response. Try asking again.");
    return full;
  };

  // Lightweight, local (no API call) detection for chat messages like "email Sarah about the
  // invoice" or "call John" — matches an action verb plus a saved contact's first name. Returns
  // a SUGGESTION, not an executed action: a fuzzy name match ("call the plumber Sarah
  // recommended") could otherwise target the wrong person, so nothing actually dials, texts, or
  // opens Compose until the person taps the confirm button on the suggestion.
  const CONTACT_ACTION_VERBS = { email:["email","e-mail"], call:["call","phone","dial"], text:["text","message","sms","whatsapp"] };
  // Personal pronouns that can precede a modal auxiliary ("I will...", "we would...") — used
  // below to avoid mistaking a contact literally named Will/Hope/Grace/etc. for the modal verb
  // in an ordinary sentence like "I will message the team".
  const MODAL_PRONOUNS = ["i","you","we","they","he","she","it","who"];
  const resolveContactAction = query => {
    const words = query.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z']/g, ""));
    let type = null, verbIdx = -1;
    for (const [t, verbs] of Object.entries(CONTACT_ACTION_VERBS)) {
      const idx = words.findIndex(w => verbs.includes(w));
      if (idx !== -1) { type = t; verbIdx = idx; break; }
    }
    if (!type) return null;
    const contact = contacts.find(c => {
      const first = c.name.trim().split(/\s+/)[0].toLowerCase();
      if (first.length <= 1) return false;
      const nameIdx = words.findIndex(w => w === first);
      if (nameIdx === -1) return false;
      // Skip the classic false-positive shape: the "name" match is actually a modal auxiliary
      // sitting directly in front of the action verb, itself preceded by a personal pronoun
      // (e.g. "I will message the team" — not a request to message a contact named Will).
      const isModalFalsePositive = nameIdx === verbIdx - 1 && MODAL_PRONOUNS.includes(words[nameIdx - 1]);
      return !isModalFalsePositive;
    });
    if (!contact) return null;
    if (type === "email" && !contact.email) return null;
    if ((type === "call" || type === "text") && !contact.phone) return null;
    return { type, contact };
  };
  // Executes a confirmed contact action from a chat suggestion — never called automatically.
  // Everything lives on this device. Clearing browser data wipes every transaction, contact and
  // note with no way back — for something tracking a person's finances that's an unacceptable
  // single point of failure. Export writes the whole store to a JSON file the user keeps, which
  // is the closest thing to a backup available without a server.
  const exportData = async () => {
    try {
      const groups = {};
      await Promise.all(Object.entries(STORAGE_KEYS).map(async ([group, key]) => {
        try { const r = await window.storage.get(key, false); groups[group] = r?.value ? JSON.parse(r.value) : null; }
        catch { groups[group] = null; }
      }));
      // Credential material is stripped. An export is a file that gets emailed, synced and left
      // in Downloads — the password hash and salt have no business travelling in it, and nothing
      // needs them to restore the data.
      if (groups.profile?.user) {
        const { passwordHash, passwordSalt, password, webauthnCredentialId, ...safeUser } = groups.profile.user;
        groups.profile = { ...groups.profile, user: safeUser };
      }
      const payload = { app:"KROFT", formatVersion:1, exportedAt:new Date().toISOString(), data:groups };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `kroft-backup-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      // Revoked on a delay — revoking immediately cancels the download on some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast("Backup downloaded.");
    } catch { toast("Couldn't create the backup. Try again."); }
  };

  // Restores from a file produced above. Replaces rather than merges: merging two ledgers
  // silently duplicates transactions, and a quietly wrong balance is worse than an obvious one.
  const importData = async file => {
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.app !== "KROFT" || !parsed.data) { toast("That doesn't look like a KROFT backup."); return; }
      await Promise.all(Object.entries(parsed.data).map(async ([group, value]) => {
        const key = STORAGE_KEYS[group];
        // Unknown groups are skipped rather than written, so a tampered file can't put
        // arbitrary keys into storage.
        if (!key || value == null) return;
        try { await window.storage.set(key, JSON.stringify(value), false); } catch { /* skip */ }
      }));
      toast("Backup restored. Reloading…");
      setTimeout(() => window.location.reload(), 1200);
    } catch { toast("Couldn't read that file."); }
  };

  const runContactAction = ({ type, contact }) => {
    if (type === "email") setComposeDraft({ to:contact.email, subject:"", body:"" });
    else if (type === "call") window.location.href = `tel:${contact.phone}`;
    else if (type === "text") window.location.href = `sms:${contact.phone}`;
  };

  // Runs the actual AI completion against a given conversation state. Split out from askKroft
  // so the "Just answer normally" path (declining a contact-action suggestion) can reuse it
  // without re-appending the user's message a second time — that message was already added
  // when the suggestion first appeared.
  const runNormalCompletion = async (conversationSoFar, contactAction = null) => {
    setAiLoading(true);
    await streamReply(conversationSoFar, contactAction);
  };

  // Single implementation shared by a new message and by Retry. Previously Retry had its own
  // copy of this logic, which quietly fell behind — it never streamed, never stripped or applied
  // the action block, and still showed the old generic error text.
  const streamReply = async (conversationSoFar, contactAction = null) => {
    const controller = new AbortController();
    aiAbortRef.current = controller;
    const streamId = uid();
    setAiMessages(p => [...p, { id:streamId, role:"assistant", content:"", streaming:true }]);
    try {
      const raw = await runKroftCompletion(conversationSoFar, {
        signal: controller.signal,
        onDelta: partial => setAiMessages(p => p.map(m => m.id === streamId ? { ...m, content:partial } : m)),
      });
      const { clean, action } = extractAction(raw);
      // Confirm-gated actions (delete_*, send_email) never execute here — describePendingAction
      // only validates and previews. A valid one is attached to this message as a card the
      // person has to actually tap Confirm on (see confirmPendingAction below); an invalid one
      // (nothing matched) surfaces the same way a failed complete_task/edit_appointment does —
      // a toast explaining why, since the reply text already framed it as about to happen.
      let pending = null, result = null;
      if (action && CONFIRM_ACTION_TYPES.has(action.type)) {
        const preview = describePendingAction(action);
        if (preview.ok) pending = { action, summary: preview.summary };
        else if (preview.reason) result = { label: preview.reason };
      } else if (action) {
        result = applyAiAction(action);
      }
      setAiMessages(p => p.map(m => m.id === streamId ? { ...m, content:clean, streaming:false, contactAction, pendingAction:pending } : m));
      if (result) toast(result.label, result.undo);
      if (voiceReplies && !voiceOpenRef.current) speak(clean);
    } catch (err) {
      if (err.name === "AbortError") {
        // Keep whatever had already streamed in — a stopped reply is partial, not failed, and
        // throwing it away would lose text the person may have been reading.
        setAiMessages(p => p.map(m => m.id === streamId
          ? { ...m, streaming:false, content:(m.content || "").trim() || "Stopped.", stopped:true }
          : m));
      } else {
        const msg = err instanceof KroftError ? err.message : "Something went wrong. Please try again.";
        setAiMessages(p => p.map(m => m.id === streamId ? { ...m, content:msg, streaming:false, failed:true } : m));
      }
    }
    aiAbortRef.current = null;
    setAiLoading(false);
  };

  const stopReply = () => { aiAbortRef.current?.abort(); aiAbortRef.current = null; };

  // Handlers for the confirm/cancel card streamReply attaches to a message's pendingAction.
  // Confirm actually runs the action and turns the card into a plain outcome line; Cancel just
  // discards it — either way the card stops being tappable, so it can't fire twice.
  const confirmPendingAction = async messageId => {
    const msg = aiMessages.find(m => m.id === messageId);
    if (!msg?.pendingAction || msg.pendingAction.done) return;
    const { action } = msg.pendingAction;
    setAiMessages(p => p.map(m => m.id === messageId ? { ...m, pendingAction:{ ...m.pendingAction, confirming:true } } : m));
    const result = await executeConfirmedAction(action);
    setAiMessages(p => p.map(m => m.id === messageId ? { ...m, pendingAction:{ ...m.pendingAction, confirming:false, done:true, outcome:result?.label || "Done." } } : m));
    if (result?.undo) toast(result.label, result.undo);
  };
  const cancelPendingAction = messageId => {
    setAiMessages(p => p.map(m => m.id === messageId && !m.pendingAction?.done
      ? { ...m, pendingAction:{ ...m.pendingAction, done:true, outcome:"Cancelled." } } : m));
  };

  // Plus: an unprompted daily notification — the one thing a free account structurally can't
  // get, since it requires KROFT to initiate rather than respond. Built from the same real data
  // as the chat context, kept to one short sentence since it has to work as a lock-screen
  // notification, not a message someone opens and reads.
  const generateDailyBrief = async () => {
    const today = todayISO();
    const todays = appts.filter(a => a.date === today);
    const openTasks = tasks.filter(t => !t.done);
    const overBudget = budgetStatus().filter(b => b.pct >= 1);
    const nearBudget = budgetStatus().filter(b => b.pct >= 0.8 && b.pct < 1);
    const context = `Today: ${today}. Appointments today: ${todays.length ? todays.map(a=>`${a.title} at ${a.time}`).join("; ") : "none"}. Open tasks: ${openTasks.length}. Budgets over limit: ${overBudget.length ? overBudget.map(b=>b.cat).join(", ") : "none"}. Budgets close to limit: ${nearBudget.length ? nearBudget.map(b=>b.cat).join(", ") : "none"}. Name: ${user.name||"there"}.`;
    try {
      // Tagged "background_ai", not the default "chat": this runs on a timer, unprompted, and
      // should never eat into the user's real chat quota (api/chat.js falls back to "chat" for
      // any call with no usage-type header, which this used to hit silently).
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"background_ai"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:80, system:"Write exactly one short sentence greeting the user by name and flagging the single most useful thing about their day from the context — a tight schedule, a budget issue, or an open task count if nothing else stands out. Never state a specific dollar amount, even if one seems implied — this reads out loud on a lock screen others may see. Plain text, no preamble, no quotes, under 22 words.", messages:[{ role:"user", content:context }] }) });
      const data = await res.json();
      const text = data.content?.map(b=>b.text||"").join("").trim();
      return (res.ok && text) || `Good morning, ${firstNameOf(user.name)||"there"} — ${openTasks.length} tasks open today.`;
    } catch {
      return null;
    }
  };

  // Delivers notifications for things that are actually due. Runs every 30s so a 10-minute
  // warning lands close to on time without polling aggressively.
  useEffect(() => {
    if (!dataLoaded || notifPermission !== "granted") return;
    const check = () => {
      const now = new Date();
      const today = todayISO();
      const mins = now.getHours() * 60 + now.getMinutes();
      const fired = {};

      const send = (key, title, body, opts) => {
        if (notifSent[key]) return;
        if (sendNotification(title, body, key, opts)) fired[key] = true;
      };

      // Fires once, in a fixed morning window, so it reads as "today's brief" rather than
      // landing at an arbitrary moment depending on when the tab happened to be open.
      if (subscribed && notifPrefs.dailyBrief && dailyBriefSentDate !== today && mins >= 8*60 && mins < 8*60+30) {
        setDailyBriefSentDate(today);
        generateDailyBrief().then(text => {
          if (text) sendNotification("Your day", text, `brief:${today}`);
        });
      }

      if (notifPrefs.appointments) {
        appts.filter(a => a.date === today && a.time).forEach(a => {
          const [h, m] = a.time.split(":").map(Number);
          if (isNaN(h)) return;
          const delta = (h * 60 + (m || 0)) - mins;
          // Fires in the ten minutes before, not after — a notification for something that
          // already started is noise.
          if (delta <= 10 && delta >= 0) {
            send(`appt:${today}:${a.id}`, delta <= 1 ? `${a.title} is starting` : `${a.title} in ${delta} min`,
              [a.time, a.location].filter(Boolean).join(" · "));
          }
        });
      }

      if (notifPrefs.reminders) {
        smartReminders.filter(r => !r.done && r.when).forEach(r => {
          // `when` is free text, so only an explicit HH:MM is treated as a scheduled time.
          // Anything vaguer is left alone rather than guessed at and fired at the wrong moment.
          const m = String(r.when).match(/(\d{1,2}):(\d{2})/);
          if (!m) return;
          const target = Number(m[1]) * 60 + Number(m[2]);
          if (mins >= target && mins - target < 30) {
            send(`rem:${today}:${r.id}`, "Reminder", r.text, { requireInteraction: true });
          }
        });
      }

      if (Object.keys(fired).length) setNotifSent(p => ({ ...p, ...fired }));
    };
    check();
    return heartbeat(check);
  }, [dataLoaded, notifPermission, notifPrefs, appts, smartReminders, notifSent, subscribed, dailyBriefSentDate]);

  // Keeps the server's scheduled_notifications index in sync with real, upcoming appointments so
  // a push can still reach this person 10 minutes before one starts even with the app fully
  // closed — the in-app version just above only ever fires while a tab is open. Appointments have
  // a simple, static, already-known title/time/location, so this is a straightforward full
  // reconcile, not an incremental add/remove per appointment — sending the complete current set on
  // every change means a missed edge case can never leave a stale entry behind; the server just
  // deletes anything under the "appt:" prefix that isn't in this list any more (see
  // api/push/schedule.js). See the reminders version of this same idea just below, which needs one
  // extra wrinkle for the same push-only-when-closed behavior.
  useEffect(() => {
    if (!dataLoaded || !isSupabaseConfigured) return;
    const now = Date.now();
    const items = appts
      .map(a => {
        if (!a.date || !a.time) return null;
        const [h, m] = a.time.split(":").map(Number);
        if (isNaN(h)) return null;
        const fires = new Date(`${a.date}T00:00:00`);
        fires.setHours(h, m || 0, 0, 0);
        fires.setMinutes(fires.getMinutes() - 10);
        if (fires.getTime() <= now) return null; // only ever push for something still ahead
        return { clientKey:`appt:${a.id}`, firesAt:fires.toISOString(), title:`${a.title} in 10 min`, body:[a.time, a.location].filter(Boolean).join(" · ") };
      })
      .filter(Boolean);
    const t = setTimeout(() => {
      authedFetch("/api/push/schedule", { method:"POST", body:JSON.stringify({ prefix:"appt:", items }) }).catch(() => {
        // Best-effort — the in-app/OS notification path above (while the app is open) is
        // unaffected either way, and the next appts change retries this automatically.
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [dataLoaded, appts]);

  // Same idea, for reminders. The one real difference from appointments: an open reminder here
  // re-arms daily at the same time until marked done (see the in-app version above — same HH:MM-
  // in-`when` parsing, matched exactly), and re-deriving "is it still open" needs kv_store data the
  // cron job deliberately never reads (that's what keeps it a thin index instead of a second copy
  // of the whole reminder). So this schedules a push for whichever occurrence is next — today's, if
  // its time hasn't passed yet, otherwise tomorrow's — and relies on this same effect re-running
  // (any time smartReminders changes, which includes marking one done) to roll the schedule forward
  // a day at a time. A reminder dismissed while the app is closed cancels correctly the next time
  // the app opens, before its next push would otherwise fire; if the app stays closed for more than
  // one full day past a reminder's time, only that first occurrence is guaranteed to have pushed —
  // the same real limitation any reminder app has without a server that also owns the reminder's
  // own done-state, which this one deliberately doesn't take on.
  useEffect(() => {
    if (!dataLoaded || !isSupabaseConfigured) return;
    const now = new Date();
    const items = smartReminders
      .map(r => {
        if (r.done) return null;
        const m = String(r.when || "").match(/(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const fires = new Date();
        fires.setHours(Number(m[1]), Number(m[2]), 0, 0);
        if (fires.getTime() <= now.getTime()) fires.setDate(fires.getDate() + 1);
        return { clientKey:`reminder:${r.id}`, firesAt:fires.toISOString(), title:"Reminder", body:r.text };
      })
      .filter(Boolean);
    const t = setTimeout(() => {
      authedFetch("/api/push/schedule", { method:"POST", body:JSON.stringify({ prefix:"reminder:", items }) }).catch(() => {
        // Best-effort — the in-app/OS notification path above (while the app is open) is
        // unaffected either way, and the next smartReminders change retries this automatically.
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [dataLoaded, smartReminders]);

  // Plus: scheduled calls. Kept independent of notifPermission — the in-app ringing overlay
  // doesn't need OS notification permission at all, only the accompanying system notification
  // does (sendNotification no-ops quietly if that permission isn't granted). Folding this into
  // the permission-gated effect above would have meant a call never rang in-app for anyone who
  // hadn't separately granted notifications, which has nothing to do with whether this feature
  // should work.
  useEffect(() => {
    if (!dataLoaded || !subscribed) return;
    const check = () => {
      const nowTs = Date.now();
      scheduledCalls.forEach(c => {
        if (c.status !== "pending") return;
        const due = new Date(`${c.date}T${c.time||"00:00"}:00`).getTime();
        const lateMins = (nowTs - due) / 60000;
        if (lateMins < 0) return;
        // A call rings within a 10-minute window of its time, matching the appointment
        // reminder window elsewhere — later than that and it's marked missed rather than
        // ringing stale, minutes late.
        if (lateMins > 10) {
          setScheduledCalls(p => p.map(x => x.id===c.id ? { ...x, status:"missed" } : x));
          sendNotification("Missed call — KROFT", `${c.title}${c.note ? `: ${c.note}` : ""}`, `call:${c.id}`);
          return;
        }
        if (!callNotifiedRef.current[c.id]) {
          callNotifiedRef.current[c.id] = true;
          sendNotification("Incoming call — KROFT", c.title, `call:${c.id}`);
        }
        setIncomingCall(prev => prev ? prev : c);
      });
    };
    check();
    return heartbeat(check);
  }, [dataLoaded, subscribed, scheduledCalls]);

  // Reminder alarm takeover (ReminderAlarmScreen) — kept independent of notifPermission for the
  // same reason as scheduledCalls just above: the in-app screen, sound and vibration don't need
  // OS notification permission at all, only the separate system notification (sent by the
  // permission-gated effect above, via the same `rem:${today}:${id}` key) does. Sharing that key
  // in notifSent means whichever of the two effects runs first marks it, so neither re-fires the
  // same occurrence on a later heartbeat tick regardless of which order they happen to run in.
  useEffect(() => {
    if (!dataLoaded) return;
    const check = () => {
      if (!notifPrefs.reminders) return;
      const now = new Date();
      const today = todayISO();
      const mins = now.getHours() * 60 + now.getMinutes();
      smartReminders.filter(r => !r.done && r.when).forEach(r => {
        const m = String(r.when).match(/(\d{1,2}):(\d{2})/);
        if (!m) return;
        const target = Number(m[1]) * 60 + Number(m[2]);
        if (mins < target || mins - target >= 30) return;
        const key = `rem:${today}:${r.id}`;
        if (notifSent[key]) return;
        setNotifSent(p => (p[key] ? p : { ...p, [key]: true }));
        setRingingReminder(prev => prev ? prev : r);
      });
    };
    check();
    return heartbeat(check);
  }, [dataLoaded, notifPrefs, smartReminders, notifSent]);

  // Notification keys accumulate forever otherwise. Anything not from today is dropped once a
  // day — the keys are date-scoped, so old ones can never match again.
  useEffect(() => {
    if (!dataLoaded) return;
    const prune = () => {
      const today = todayISO();
      setNotifSent(p => {
        const kept = Object.fromEntries(Object.entries(p).filter(([k]) => k.includes(today)));
        return Object.keys(kept).length === Object.keys(p).length ? p : kept;
      });
    };
    prune();
    const t = setInterval(prune, 3600000);
    return () => clearInterval(t);
  }, [dataLoaded]);

  // Spend per category for the current month, alongside its limit. Derived rather than stored so
  // it can never drift out of sync with the underlying entries.
  // Memoised: this was recomputed on every render and called from six places per pass, walking
  // the whole expense list each time. It only changes when the expenses, budgets or the day do.
  const budgetStatus = useMemo(() => () => {
    const today = todayISO();
    const month = today.slice(0, 7);
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // How far through the month we are. A budget spent evenly would sit at roughly this figure,
    // so it's the yardstick for whether someone is ahead of pace rather than merely partway
    // through a normal month.
    const monthProgress = dayOfMonth / daysInMonth;

    return Object.entries(budgets)
      .filter(([, limit]) => limit > 0)
      .map(([cat, limit]) => {
        const spent = expenses.filter(e => e.cat === cat && (e.date || "").slice(0, 7) === month)
                              .reduce((sum, e) => sum + e.amount, 0);

        // Recurring expenses still to post this month are counted toward the projection.
        // Without this a budget looks comfortable all month and then blows out the day rent
        // posts — which is precisely the surprise a budget exists to prevent.
        const committed = expenses
          .filter(e => e.cat === cat && e.repeat && e.repeat !== "none" && e.nextDate
                       && e.nextDate.slice(0, 7) === month && e.nextDate > today)
          .reduce((sum, e) => sum + e.amount, 0);

        // Plus: last month's underspend raises this month's effective limit. `limit` stays the
        // number the person actually typed, so the editor and "budgeted total" keep meaning what
        // they say — only the pace/warning math and the "left" figure see the carryover.
        // Not gated on `subscribed` here: the rollover effect below already only ever writes a
        // new carryover while subscribed (and clears it once a downgraded month rolls over), so
        // re-gating the read on current subscription status just claws back a benefit already
        // earned the moment someone downgrades mid-month — the opposite of what that effect's own
        // comment promises ("without clawing back what already rolled over").
        const carryover = budgetCarryover[cat] || 0;
        const effectiveLimit = limit + carryover;

        const pct = effectiveLimit ? spent / effectiveLimit : 0;
        // Straight-line projection from spend so far, plus anything already committed.
        const projected = monthProgress > 0 ? (spent / monthProgress) + committed : spent + committed;

        return {
          cat, limit, effectiveLimit, carryover, spent, committed, pct,
          left: effectiveLimit - spent,
          projected,
          // "Ahead of pace" needs a floor: in the first days of a month a single ordinary
          // purchase produces a wild projection, so it only flags once a meaningful share of
          // the month has passed and the overshoot is more than noise.
          aheadOfPace: monthProgress > 0.15 && pct > monthProgress * 1.25 && pct < 1,
          willExceed: projected > effectiveLimit && pct < 1,
          monthProgress,
        };
      })
      .sort((a, b) => b.pct - a.pct);
  }, [expenses, budgets, budgetCarryover, subscribed, todayISO()]);

  // Warns as a category approaches and then passes its limit. Each threshold fires once per
  // category per month — keyed by month so a new month starts clean, and so reopening the app
  // doesn't re-announce something already seen.
  useEffect(() => {
    if (!dataLoaded) return;
    const month = todayISO().slice(0, 7);
    budgetStatus().forEach(({ cat, limit, spent, pct, projected, willExceed }) => {
      // Three levels now. "pace" is the useful one: it can fire at 40% spent on the 8th, which
      // is early enough to actually change the outcome — 80% often isn't.
      const level = pct >= 1 ? "over" : pct >= 0.8 ? "near" : willExceed ? "pace" : null;
      if (!level) return;
      const key = `${month}:${cat}:${level}`;
      if (budgetAlerts[key]) return;
      setBudgetAlerts(p => ({ ...p, [key]: true }));
      const msg = level === "over"
        ? `Over budget on ${cat} — ${fmtCur(spent, user.currency)} of ${fmtCur(limit, user.currency)}.`
        : level === "near"
          ? `${cat} is at ${Math.round(pct * 100)}% of budget.`
          : `At this rate ${cat} will reach ${fmtCur(projected, user.currency)} against a ${fmtCur(limit, user.currency)} budget.`;
      toast(msg);
      // Also pushed to the system tray when enabled, so it lands even if KROFT isn't the tab
      // in front of them.
      if (notifPrefs.budgets && notifPermission === "granted") {
        sendNotification(level === "over" ? "Over budget" : level === "near" ? "Approaching budget" : "Spending ahead of pace", msg, key);
      }
    });
  }, [dataLoaded, expenses, budgets]);

  // Posts recurring income and expenses when they come due. A recurring entry acts as a
  // template: it keeps its own `repeat` cadence and a `nextDate`, and each time that date passes
  // a concrete, normal entry is written for it. The template itself is never counted twice, and
  // catching up runs in a loop so a month away from the app still produces every missed posting
  // rather than a single one.
  useEffect(() => {
    if (!dataLoaded) return;
    const post = () => {
      const today = todayISO();
      const run = (list, setList) => {
        setList(prev => {
          const generated = [];
          let changed = false;
          const next = prev.map(e => {
            if (!e.repeat || e.repeat === "none" || !e.nextDate) return e;
            let cursor = e.nextDate;
            let guard = 0;
            // Guarded so a corrupted cadence can't spin forever; 60 postings covers five years
            // of monthly or a year of weekly.
            while (cursor <= today && guard++ < 60) {
              generated.push({ id:uid(), label:e.label, amount:e.amount, cat:e.cat, date:cursor, cur:e.cur || user.currency, fromRecurring:e.id });
              cursor = advanceRepeatDate(cursor, e.repeat);
              changed = true;
            }
            return changed ? { ...e, nextDate:cursor } : e;
          });
          return changed ? [...next, ...generated] : prev;
        });
      };
      run(income, setIncome);
      run(expenses, setExpenses);
    };
    post();
    return heartbeat(post);
  }, [dataLoaded, income, expenses]);

  // Rolls the wellness score over at midnight. A stale score is worse than no score — someone
  // who had a rough Monday and next opens the app on Friday shouldn't be shown Monday's number
  // labelled "today". Rather than resetting flat to 75, the new day starts pulled most of the
  // way back toward neutral, so a genuinely bad stretch still shows through on consecutive days
  // without a single bad day following you around all week.
  useEffect(() => {
    if (!dataLoaded) return;
    const rollover = () => {
      const today = todayISO();
      if (wellnessDate === today) return;
      // Reads the outgoing day's score from the updater's own `prev`, not the closure-captured
      // `wellness` variable — self-care taps ("Took a break"/"Had water") change wellness without
      // changing wellnessDate, so this closure can otherwise be holding a stale value by the time
      // a day actually rolls over. Recorded before it decays toward neutral, so history reflects
      // what the day actually was, not what tomorrow's starting point becomes.
      setWellness(prev => {
        setWellnessHistory(h => [...h.filter(e => e.date !== wellnessDate), { date: wellnessDate, score: prev }]);
        return Math.round(75 + (prev - 75) * 0.35);
      });
      setWellnessDate(today);
      setSelfCare({ breaks:0, water:0 });
    };
    rollover();
    return heartbeat(rollover);
  }, [dataLoaded, wellnessDate]);

  // Plus: carries each category's unused budget into the next month, computed once when the
  // calendar month actually changes. Only accrues while subscribed — the benefit belongs to
  // being on Plus when a month closes, not to having ever been on Plus, so downgrading stops
  // future accrual once the month it happened in rolls over (budgetStatus's read side doesn't
  // separately re-gate on `subscribed`, so a downgrade mid-month doesn't also claw back the
  // carryover already earned for the month in progress).
  useEffect(() => {
    if (!dataLoaded) return;
    const rollover = () => {
      const currentMonth = todayISO().slice(0, 7);
      if (currentMonth === budgetRolloverMonth) return;
      if (subscribed) {
        const prevMonth = budgetRolloverMonth;
        setBudgetCarryover(() => {
          const next = {};
          Object.entries(budgets).forEach(([cat, limit]) => {
            if (!(limit > 0)) return;
            const spent = expenses
              .filter(e => e.cat === cat && (e.date || "").slice(0, 7) === prevMonth)
              .reduce((sum, e) => sum + e.amount, 0);
            // Deliberately measured against the bare typed-in limit, not last month's own
            // effective (carryover-boosted) limit — see the state declaration's comment: this is
            // a one-month grace recomputed fresh each rollover, not a compounding balance that
            // hoards indefinitely.
            const leftover = limit - spent;
            // Only a genuine underspend carries forward — an overspent category obviously
            // shouldn't reduce next month's limit, so it simply carries nothing.
            if (leftover > 0) next[cat] = leftover;
          });
          return next;
        });
      } else {
        setBudgetCarryover({});
      }
      setBudgetRolloverMonth(currentMonth);
    };
    rollover();
    return heartbeat(rollover);
  }, [dataLoaded, budgetRolloverMonth, subscribed, budgets, expenses]);

  // Wellness suggestions derived from what's actually going on, rather than four fixed lines
  // shown to everyone forever. The old set also asserted an invented statistic ("improves focus
  // by roughly 40%"), which is worse than unhelpful — so these stick to plain, checkable
  // statements and tie each one to the reason it's being shown.
  const wellnessTips = () => {
    const now = new Date();
    const hour = now.getHours();
    const today = todayISO();
    const out = [];

    const todaysAppts = appts.filter(a => a.date === today);
    const laterToday = todaysAppts.filter(a => (a.time || "") > `${String(hour).padStart(2,"0")}:00`);
    const openTasks = tasks.filter(t => !t.done);
    const highPriority = openTasks.filter(t => t.priority === "High");
    // Only today's check-ins count. Now that the log persists across days, slicing the tail
    // blindly would let last week's bad afternoon drive today's advice.
    const recentMoods = moodLog.filter(m => (m.date || today) === today).slice(-3).map(m => m.mood);
    const stressed = recentMoods.filter(m => m === "stressed" || m === "angry").length >= 2;

    // Money worry is a real driver of how a day feels, so it belongs here alongside mood and
    // workload rather than only in the finance tab.
    const overBudget = budgetStatus().filter(b => b.pct >= 1);
    if (overBudget.length) out.push({ text:`${overBudget[0].cat} is over budget this month. Worth a look before it grows.`, why:"from your budgets" });

    if (stressed) out.push({ text:`Your last few mood check-ins were tense. Try a few slow breaths before your next task.`, why:"based on your mood log" });
    if (wellness <= 60) out.push({ text:`Your score is ${wellness}. Take a real break — step away from the screen for ten minutes.`, why:"your score is low today" });

    if (todaysAppts.length >= 4) out.push({ text:`${todaysAppts.length} appointments today. Protect a gap between them so you're not running straight through.`, why:"from today's schedule" });
    else if (laterToday.length > 0) out.push({ text:`Next up: ${laterToday[0].title} at ${laterToday[0].time}. A short walk beforehand helps you arrive settled.`, why:"from today's schedule" });

    if (highPriority.length >= 3) out.push({ text:`${highPriority.length} high-priority tasks are open. Pick one to finish rather than starting several.`, why:"from your task list" });
    else if (openTasks.length === 0 && todaysAppts.length === 0) out.push({ text:`Nothing scheduled and no open tasks. A good day to rest properly rather than filling it.`, why:"your day is clear" });

    if (hour < 10) out.push({ text:`Drink a glass of water before your first coffee — you've gone all night without any.`, why:"it's morning" });
    else if (hour >= 12 && hour < 15) out.push({ text:`Midday dip is normal. Ten minutes outside beats another coffee for getting through the afternoon.`, why:"it's the middle of the day" });
    else if (hour >= 21) out.push({ text:`It's getting late. Putting your phone down an hour before bed makes falling asleep easier.`, why:"it's late evening" });

    if (mood === "happy") out.push({ text:`You're in good form — this is the right time to start the thing you've been putting off.`, why:"based on your current mood" });

    // Always leave something useful on screen, even on a blank day with no signals.
    if (out.length === 0) out.push({ text:`Nothing's flagging today. Drink water, move every hour, and finish at a reasonable time.`, why:"a steady day" });
    return out.slice(0, 4);
  };

  // Starts a fresh conversation without losing the old one outright — matches the undo pattern
  // used for every other destructive action in this app (delete a task, remove a memo, etc.)
  // rather than a bare confirm() dialog.
  // A conversation's title is just its first user message, truncated — cheap and immediate,
  // rather than spending a separate AI call to summarize it the way some chat apps do (this
  // app already treats AI calls as a metered resource everywhere else, via the free-tier quotas
  // above).
  const deriveChatTitle = messages => {
    const first = messages.find(m => m.role === "user");
    if (!first) return "New conversation";
    const text = (first.content || "").trim().replace(/\s+/g, " ");
    return text.length > 42 ? text.slice(0, 42) + "…" : text || "New conversation";
  };

  // Starting a new chat used to just discard whatever was active (recoverable only via a toast's
  // undo button, and only until that toast faded) — now it's saved into history first, so nothing
  // typed is ever actually lost, and it can be reopened any time from the history panel.
  const startNewChat = () => {
    const prev = aiMessages;
    const hadContent = prev.some(m => m.role === "user");
    let savedEntry = null;
    if (hadContent) {
      savedEntry = { id:uid(), title:deriveChatTitle(prev), messages:prev, updatedAt:Date.now() };
      setChatHistory(h => [savedEntry, ...h].slice(0, 30));
    }
    setAiMessages([{ role:"assistant", content:`Hey ${firstNameOf(user.name)||"there"} — new conversation. What can I help with?` }]);
    toast(hadContent ? "Conversation saved to history." : "Started a new conversation.", () => {
      if (savedEntry) setChatHistory(h => h.filter(c => c.id !== savedEntry.id));
      setAiMessages(prev);
    });
  };

  // Swaps in a saved conversation as the active one — saving whatever's currently active into
  // history first (same as startNewChat), and pulling the opened conversation out of the history
  // list since it's the live one again now, not a saved item.
  const openHistoryChat = id => {
    const target = chatHistory.find(c => c.id === id);
    if (!target) return;
    const current = aiMessages;
    const currentHadContent = current.some(m => m.role === "user");
    setChatHistory(h => {
      const rest = h.filter(c => c.id !== id);
      return currentHadContent
        ? [{ id:uid(), title:deriveChatTitle(current), messages:current, updatedAt:Date.now() }, ...rest].slice(0, 30)
        : rest;
    });
    setAiMessages(target.messages);
    setShowChatHistory(false);
    setChatHistorySearch("");
  };

  // Short, glanceable "when" for a history entry — "Today"/"Yesterday" reads faster than a full
  // date for the recent conversations someone is actually scanning for, falling back to a date
  // once it's further back than that.
  const chatHistoryWhen = ts => {
    const d = new Date(ts);
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0 && d.toDateString() === new Date().toDateString()) return "Today";
    if (days === 1) return "Yesterday";
    return d.toLocaleDateString("en-US", { month:"short", day:"numeric" });
  };

  const scrollChatToBottom = () => chatEnd.current?.scrollIntoView({ behavior:"smooth" });

  const askKroft = async override => {
    const q = override || aiInput; if (!q.trim()) return;

    // A detected contact action no longer short-circuits the model. It used to intercept the
    // message entirely and return a "did you mean...?" card, which made sense when KROFT was
    // blind — but now it can see your contacts and draft the actual text or email, so blocking
    // it was a downgrade. The reply comes through as normal and the shortcut rides along
    // underneath it as a button.
    const contactAction = resolveContactAction(q);

    // Real daily cap enforcement for the free plan. Resets when the calendar day changes.
    const userMsg = { role:"user", content:q };
    setAiMessages(p => [...p, userMsg]); setAiInput("");
    await runNormalCompletion([...aiMessages, userMsg], contactAction);
  };

  // Regenerate a specific assistant reply (Retry action) — reuses the conversation up to and
  // including the preceding user message, without re-adding a duplicate user turn.
  const regenerateReply = async i => {
    if (aiLoading) return;
    const upToUser = aiMessages.slice(0, i);
    setAiMessages(upToUser);
    // Routes through the same quota check/increment as every other reply (runNormalCompletion)
    // instead of calling streamReply directly — Retry used to skip the free-tier daily limit
    // entirely, letting someone who'd already hit it keep regenerating the last reply forever
    // with the on-screen counter never reflecting it.
    await runNormalCompletion(upToUser);
  };

  const setMsgFeedback = (i, val) => {
    setAiMessages(p => p.map((m,idx) => idx===i ? { ...m, feedback: m.feedback===val ? null : val } : m));
    toast(val==="up" ? "Thanks for the feedback." : "Thanks — KROFT will keep improving.");
  };

  const copyMsg = async text => {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard."); }
    catch { toast("Couldn't copy — try selecting the text manually."); }
  };

  const shareMsg = async text => {
    if (navigator.share) { try { await navigator.share({ text }); } catch {} }
    else copyMsg(text);
  };

  const aiDraftReply = async email => {
    toast("KROFT is drafting a reply…");
    try {
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"extra"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:400, messages:[{ role:"user", content:`Draft a concise professional reply (under 5 sentences). From: ${email.from}, Subject: ${email.subject}, Body: "${email.body}"` }] }) });
      const data = await res.json();
      const body = data.content?.map(b=>b.text||"").join("").trim();
      if (!res.ok || !body) { toast("Draft failed — try again."); return; }
      // Carries the original email's provider through so the reply sends from the same
      // account it arrived on (see api/mail/send.js's provider field), rather than defaulting
      // to whichever account the send endpoint picks first.
      setComposeDraft({ to:email.from, subject:"Re: "+email.subject, body, provider:email.source });
    } catch { toast("Draft failed."); }
  };

  // Smart Reminders — genuinely asks the AI for a useful reminder based on real context
  const [suggestingReminder, setSuggestingReminder] = useState(false);
  const suggestSmartReminder = async () => {
    setSuggestingReminder(true);
    const context = `Appointments: ${appts.length>0 ? appts.map(a=>`${a.title} at ${a.time} on ${a.date}`).join("; ") : "none"}. Tasks: ${tasks.length>0 ? tasks.filter(t=>!t.done).map(t=>t.title).join("; ") : "none"}. Mood: ${mood}.`;
    try {
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"extra"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:120, system:"Suggest exactly ONE short, genuinely useful reminder for this user based on their context. Reply with ONLY the reminder text itself — no preamble, no quotes, under 15 words.", messages:[{ role:"user", content:context }] }) });
      const data = await res.json();
      const suggestion = data.content?.map(b=>b.text||"").join("").trim();
      if (!res.ok || !suggestion) { toast("Couldn't get a suggestion — try again."); }
      else setSmartReminders(p => [{ id:uid(), text:suggestion, when:"Suggested by KROFT", aiSuggested:true, done:false }, ...p]);
    } catch { toast("Couldn't get a suggestion — try again."); }
    setSuggestingReminder(false);
  };

  // Monthly finance report — aggregates this month's entries and asks the AI for real advice
  const generateMonthlyReport = async () => {
    const now = new Date();
    const ym = now.toISOString().slice(0, 7); // "2026-08"
    const monthInc = income.filter(r => (r.date||"").slice(0,7) === ym);
    const monthExp = expenses.filter(r => (r.date||"").slice(0,7) === ym);
    const incTotal = monthInc.reduce((s,r)=>s+r.amount,0);
    const expTotal = monthExp.reduce((s,r)=>s+r.amount,0);
    const net = incTotal - expTotal;
    if (monthInc.length===0 && monthExp.length===0) { toast("No entries logged this month yet."); return; }
    const byCat = {};
    monthExp.forEach(r => { byCat[r.cat] = (byCat[r.cat]||0) + r.amount; });
    const topCats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,3);
    setGeneratingReport(true);
    const context = `Month: ${monthLabel(now.toISOString().slice(0,10))}. Income entries: ${monthInc.length} totaling ${fmtCur(incTotal,user.currency)}. Expense entries: ${monthExp.length} totaling ${fmtCur(expTotal,user.currency)}. Net: ${fmtCur(net,user.currency)}. Top expense categories: ${topCats.length>0?topCats.map(([c,v])=>`${c} (${fmtCur(v,user.currency)})`).join(", "):"none"}. Business: ${user.businessName||"not set"} (${user.businessType||""}).`;
    try {
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"report"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:400, system:"You are KROFT, a bookkeeping assistant. Given a user's monthly income/expense summary, write a short end-of-month summary: 2-3 sentences on what the numbers show, then 2-3 practical observations about their own spending patterns. Describe what happened in their data — do not recommend financial products, investments, tax positions, borrowing, or anything requiring a licensed advisor. Frame observations as prompts to consider, not instructions. No preamble, no headers, plain text only.", messages:[{ role:"user", content:context }] }) });
      const data = await res.json();
      const advice = (res.ok && data.content?.map(b=>b.text||"").join("").trim()) || "Couldn't generate advice right now — try again shortly.";
      setMonthlyReport({ month:monthLabel(now.toISOString().slice(0,10)), incTotal, expTotal, net, topCats, advice, generatedAt:Date.now() });
    } catch { toast("Couldn't generate the report — check your connection and try again."); }
    setGeneratingReport(false);
  };

  // A genuine, cross-domain "what actually happened this week" — finance, appointments and mood
  // together, since none of those alone tells the real story of a week the way they do combined.
  // Deliberately only uses numbers that are honestly computable from real dated records: task
  // objects don't carry a completion timestamp (only a done flag), so "tasks done this week" isn't
  // a real number Kroft has — open-task count is reported as a plain snapshot instead of dressed
  // up as a weekly stat. This is meant purely as a real recap, never a nudge back into the app —
  // no streaks, no guilt, no urgency, matching the same non-manipulative bar as everything else
  // that reaches back out to the user.
  const generateWeeklyRecap = async () => {
    const weekAgoISO = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
    const today = todayISO();
    const inWindow = iso => iso && iso >= weekAgoISO && iso <= today;
    const weekInc = income.filter(r => inWindow(r.date));
    const weekExp = expenses.filter(r => inWindow(r.date));
    const incTotal = weekInc.reduce((s,r)=>s+r.amount,0);
    const expTotal = weekExp.reduce((s,r)=>s+r.amount,0);
    const weekAppts = appts.filter(a => inWindow(a.date));
    const weekMoods = moodLog.filter(m => inWindow(m.date));
    const openTasks = tasks.filter(t => !t.done).length;
    if (!weekInc.length && !weekExp.length && !weekAppts.length && !weekMoods.length) {
      toast("Not enough logged this week yet for a recap.");
      return;
    }
    setGeneratingRecap(true);
    const context = `This week (${weekAgoISO} to ${today}): ${weekInc.length} income entries totaling ${fmtCur(incTotal,user.currency)}, ${weekExp.length} expense entries totaling ${fmtCur(expTotal,user.currency)}, net ${fmtCur(incTotal-expTotal,user.currency)}. ${weekAppts.length} appointments this week. Mood entries this week: ${weekMoods.length ? weekMoods.map(m=>m.mood).join(", ") : "none logged"}. Currently ${openTasks} open task${openTasks!==1?"s":""} (a snapshot, not scoped to this week).`;
    try {
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"report"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:180, system:"You are KROFT, a personal assistant writing someone a recap of their own week. Given real numbers across their finances, appointments and mood, write 2-3 warm, specific sentences on what genuinely happened — real progress if the data shows it, a plain observation if it doesn't. Never invent a number you weren't given, and never imply a number for something not mentioned (like tasks) unless it was explicitly given as this week's. No guilt, no urgency, no sales language, no headers or bullets — plain sentences someone would actually want to read.", messages:[{ role:"user", content:context }] }) });
      const data = await res.json();
      const summary = (res.ok && data.content?.map(b=>b.text||"").join("").trim()) || "Couldn't put your recap together right now — try again shortly.";
      setWeeklyRecap({ weekStart:weekAgoISO, weekEnd:today, incTotal, expTotal, apptsCount:weekAppts.length, moodCount:weekMoods.length, openTasks, summary, generatedAt:Date.now() });
    } catch { toast("Couldn't generate your recap — check your connection and try again."); }
    setGeneratingRecap(false);
  };

  // ── AROUND ME ────────────────────────────────────────────────────────────────

  const toggleProjectLink = (projectId, kind, itemId) => {
    setProjects(p => p.map(pr => {
      if (pr.id !== projectId) return pr;
      const ids = pr[kind] || [];
      return { ...pr, [kind]: ids.includes(itemId) ? ids.filter(i=>i!==itemId) : [...ids, itemId] };
    }));
  };

  // Milestones live on the project itself (not a shared pool like tasks/notes/files), so they
  // get their own toggle/add/remove instead of reusing toggleProjectLink.
  const toggleMilestone = (projectId, milestoneId) => {
    setProjects(p => p.map(pr => pr.id!==projectId ? pr : { ...pr, milestones:(pr.milestones||[]).map(m => m.id===milestoneId ? {...m,done:!m.done} : m) }));
  };
  const removeMilestone = (projectId, milestoneId) => {
    setProjects(p => p.map(pr => pr.id!==projectId ? pr : { ...pr, milestones:(pr.milestones||[]).filter(m => m.id!==milestoneId) }));
  };

  const toggleNotePinned = noteId => setNotes(p => p.map(n => n.id===noteId ? { ...n, pinned:!n.pinned } : n));
  const toggleNoteChecklistItem = (noteId, itemId) => setNotes(p => p.map(n => n.id!==noteId ? n : { ...n, checklist:(n.checklist||[]).map(it => it.id===itemId ? {...it,done:!it.done} : it) }));

  // Share anything — files, notes, documents — via the native share sheet where available,
  // falling back to copying to clipboard (e.g. desktop browsers without navigator.share).
  const shareContent = async ({ title, text, url }) => {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); }
      catch (err) { if (err.name !== "AbortError") toast("Couldn't share — try again."); }
    } else if (navigator.clipboard) {
      try { await navigator.clipboard.writeText(url || text || title); toast("Copied to clipboard — paste to share."); }
      catch { toast("Couldn't copy — try again."); }
    } else {
      toast("Sharing isn't supported in this browser.");
    }
  };

  const downloadText = (filename, content) => {
    const blob = new Blob([content], { type:"text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Shared by the income and expenses lists — a description/category text match plus an
  // inclusive date range, all optional. Applied client-side since these lists are already fully
  // loaded in memory; nothing here needs a round trip.
  const matchesTxnFilter = e => {
    if (txnQuery.trim() && !`${e.label} ${e.cat}`.toLowerCase().includes(txnQuery.trim().toLowerCase())) return false;
    if (txnFrom && (e.date || "") < txnFrom) return false;
    if (txnTo && (e.date || "") > txnTo) return false;
    return true;
  };
  const txnFilterActive = !!(txnQuery.trim() || txnFrom || txnTo);

  // A field containing a comma, quote or newline has to be quoted, with any internal quote
  // doubled — otherwise a description like `Lunch, client meeting` would silently split into two
  // spreadsheet columns on open.
  const csvField = v => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const exportFinanceCsv = () => {
    if (income.length === 0 && expenses.length === 0) { toast("Nothing to export yet."); return; }
    const rows = [
      ["Date","Type","Description","Category","Amount","Currency","Repeats"],
      ...[...income.map(r => ({ ...r, type:"Income" })), ...expenses.map(r => ({ ...r, type:"Expense" }))]
        .sort((a,b) => (a.date||"").localeCompare(b.date||""))
        .map(r => [r.date||"", r.type, r.label, r.cat, r.amount, r.cur||user.currency, (r.repeat&&r.repeat!=="none")?r.repeat:""]),
    ];
    const csv = rows.map(row => row.map(csvField).join(",")).join("\r\n");
    downloadText(`kroft-finance-${todayISO()}.csv`, csv);
    toast("CSV downloaded.");
  };
  // Frees a blob: URL's browser memory after a deleted item's Undo window has fully closed —
  // NOT immediately on delete, since the "Undo" toast can restore the item, and an object URL
  // revoked too early would leave the restored file/memo's Open/playback link permanently
  // broken. Peeks at state via the setter's functional form (returning the same reference, so
  // React bails out of a re-render) to check the item wasn't restored before freeing it.
  // Records a call or email that was actually placed from inside KROFT, so a contact's history
  // reflects real actions only. KROFT can't see your phone's native call log, so anything dialled
  // outside the app won't appear here — the history is deliberately limited to what KROFT itself
  // did rather than inventing entries.
  const logContactAction = (contactId, type) => {
    const entry = { id:uid(), type, at:new Date().toISOString() };
    setContacts(p => p.map(c => c.id===contactId ? { ...c, log:[entry, ...(c.log||[])].slice(0,50) } : c));
  };

  // Builds the standard "hold an item" sheet: optional Edit, then Delete behind a confirm.
  // Deletion still snapshots the list first so the toast can offer a real undo afterwards.
  const holdActions = ({ title, subtitle, onEdit, list, setList, id, deletedLabel, confirmText, after }) => ({
    title, subtitle,
    actions: [
      ...(onEdit ? [{ label:"Edit", onClick:onEdit }] : []),
      { label:"Delete", destructive:true, confirmText, onClick:() => {
        const prev = list;
        setList(prev.filter(x => x.id !== id));
        toast(deletedLabel, () => setList(prev));
        if (after) after();
      }},
    ],
  });

  const scheduleBlobRevoke = (id, url, setter) => {
    if (!url || !url.startsWith("blob:")) return;
    setTimeout(() => {
      setter(curr => { if (!curr.some(x => x.id === id)) URL.revokeObjectURL(url); return curr; });
    }, UNDO_MS + 1000);
  };
  const CATEGORIES = [
    { key:"restaurant", label:"Restaurants" },
    { key:"hotel",      label:"Hotels" },
    { key:"cafe",       label:"Cafés" },
    { key:"hospital",   label:"Hospitals" },
    { key:"pharmacy",   label:"Pharmacies" },
    { key:"atm",        label:"ATMs" },
    { key:"shopping",   label:"Shopping" },
    { key:"fuel",       label:"Fuel Stations" },
    { key:"entertainment", label:"Entertainment" },
    { key:"transport",  label:"Transport" },
  ];

  const requestLocation = () => {
    if (!navigator.geolocation) { setLocationStatus("error"); setAroundError("Geolocation isn't supported on this device."); return; }
    setLocationStatus("requesting"); setAroundError("");
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        setUserCoords({ lat:latitude, lng:longitude });
        setLocationStatus("granted");
        reverseGeocode(latitude, longitude);
      },
      err => {
        setLocationStatus("denied");
        if (err.code === err.PERMISSION_DENIED) setAroundError("Location access was denied. KROFT needs this to find places near you — you can enable it later in your device Settings.");
        else setAroundError("Couldn't determine your location right now. Try again in a moment.");
      },
      { enableHighAccuracy:true, timeout:10000, maximumAge:60000 }
    );
  };

  const reverseGeocode = async (lat, lng) => {
    try {
      const res = await fetch(`/api/places?mode=reverse&lat=${lat}&lon=${lng}`);
      const data = await res.json();
      const city = data.address?.city || data.address?.town || data.address?.village || data.address?.county || "";
      const label = [city, data.address?.state, data.address?.country].filter(Boolean).join(", ");
      setLocationLabel(label || "Current location");
      if (city && city !== lastCity) {
        setLastCity(city);
        toast(`Welcome to ${city}. Here are useful places around you.`);
      }
    } catch {
      setLocationLabel("Current location");
    }
  };

  const searchNearby = async (categoryOrQuery, { isNaturalLanguage=false, categoryKey=null } = {}) => {
    if (!userCoords) { requestLocation(); return; }
    setAroundLoading(true); setAroundError(""); setAroundSearched(true); setAroundResults([]);

    // Category browsing (the CATEGORIES grid, and "Feeling hungry?") goes straight to Overpass via
    // the proxy, not Nominatim's free-text search — see api/places.js's comment for why a category
    // label like "Restaurants" doesn't actually find real nearby restaurants there.
    if (categoryKey) {
      try {
        const res = await fetch(`/api/places?mode=category&category=${encodeURIComponent(categoryKey)}&lat=${userCoords.lat}&lon=${userCoords.lng}`);
        const data = await res.json();
        const results = data.results || [];
        setAroundResults(results);
        if (results.length === 0) setAroundError(`No ${categoryOrQuery.toLowerCase()} found nearby. Try a different category or search.`);
      } catch {
        setAroundError("Couldn't reach the places service. Check your connection and try again.");
      }
      setAroundLoading(false);
      return;
    }

    let searchTerm = categoryOrQuery;
    if (isNaturalLanguage) {
      // Let Gemini interpret the natural-language request into a place-type query. Tagged as its
      // own "location_search" pool (separate from the now-unlimited plain-text AI calls) since
      // repeated AI-powered nearby searches carry a real external-API cost the app wants to
      // meter — if the free allowance is exhausted, the server's 429 has no `content` field, so
      // searchTerm below falls straight back to the raw query and a plain-text search still runs
      // (matching the network-failure fallback), rather than blocking the search outright.
      try {
        const res = await aiFetch("/api/chat", {
          method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"location_search"},
          body:JSON.stringify({
            model:"gemini-3.6-flash", max_tokens:60,
            system:"Convert the user's request into a single short search term (2-4 words max) suitable for a places search API, such as 'coffee shop', 'pharmacy open now', 'budget hotel', or 'ATM'. Reply with ONLY the search term, nothing else.",
            messages:[{ role:"user", content:categoryOrQuery }],
          }),
        });
        const data = await res.json();
        searchTerm = data.content?.map(b=>b.text||"").join("").trim() || categoryOrQuery;
      } catch { searchTerm = categoryOrQuery; }
    }

    try {
      const viewbox = `${userCoords.lng-0.05},${userCoords.lat+0.05},${userCoords.lng+0.05},${userCoords.lat-0.05}`;
      const res = await fetch(`/api/places?mode=search&q=${encodeURIComponent(searchTerm)}&viewbox=${encodeURIComponent(viewbox)}`);
      const data = await res.json();
      const results = (data||[]).map(p => ({
        id:p.place_id,
        name:p.display_name.split(",")[0],
        address:p.display_name.split(",").slice(1,3).join(",").trim(),
        lat:parseFloat(p.lat), lng:parseFloat(p.lon),
        type:p.type,
      }));
      setAroundResults(results);
      if (results.length === 0) setAroundError(`No results found for "${searchTerm}" nearby. Try a different search.`);
    } catch {
      setAroundError("Couldn't reach the places service. Check your connection and try again.");
    }
    setAroundLoading(false);
  };

  const distanceFrom = (lat, lng) => {
    if (!userCoords) return "";
    const R = 6371;
    const dLat = (lat-userCoords.lat) * Math.PI/180;
    const dLng = (lng-userCoords.lng) * Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(userCoords.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.sin(dLng/2)**2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return d < 1 ? `${Math.round(d*1000)} m` : `${d.toFixed(1)} km`;
  };

  // Location is requested only when the person taps Enable, never on opening the tab.
  // Auto-requesting fired the browser prompt before the "Turn on location" explanation below
  // could be read — so the priming existed but nobody ever saw it, and browsers only ask once.
  // If permission was already granted in a previous session, resolve it silently instead.
  useEffect(() => {
    if (tab !== "home" || homeSection !== "around" || locationStatus !== "idle") return;
    if (!navigator.permissions?.query) return;
    navigator.permissions.query({ name:"geolocation" })
      .then(r => { if (r.state === "granted") requestLocation(); })
      .catch(() => {});
  }, [tab, homeSection, locationStatus]);

  const G = `${FONT}${ANIM}
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{overflow-x:hidden;max-width:100vw;overscroll-behavior-x:none}
    #root,#app{overflow-x:hidden}
    input,button,select,textarea{font-family:'Space Grotesk',sans-serif}
    ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px}
    .hbtn:hover{opacity:.75} .tabBtn:hover{background:${C.surface}!important;color:${C.white}!important}
    .row:hover{background:${C.hover}!important}
    input::placeholder,textarea::placeholder{color:${C.muted}}
    select option{background:${C.surface}}
    /* Punchier, springier press feedback than a flat scale — applies to every button in the
       app (including raw <button>s that don't set their own inline transition; Btn's own
       inline transition takes precedence where it's set, same springy curve either way). */
    button{transition:transform .18s cubic-bezier(.34,1.56,.64,1)}
    button:active{transform:scale(.92)}
    /* Any input/select/textarea under 16px triggers iOS Safari's auto-zoom-on-focus —
       most fields in this app were set well below that. Force 16px at the type level,
       independent of each component's own (still-smaller) visual font-size. */
    @media (max-width:900px){ input,select,textarea{font-size:16px!important} }
    /* Visible focus ring for keyboard/switch-control navigation — several interactive
       elements only get focus styling via onFocus/onBlur JS handlers, which misses
       keyboard-only users tabbing through, and buttons/links had no focus style at all. */
    button:focus-visible,a:focus-visible,[role="button"]:focus-visible{outline:2px solid ${C.accent};outline-offset:2px}
    input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid ${C.accent};outline-offset:1px}
    /* Hover styling only where a real pointer exists — on touch, :hover latches after a tap
       and leaves rows stuck in their highlighted state until something else is tapped. */
    @media (hover:none){ .hbtn:hover{opacity:1} .row:hover{background:transparent!important} }
    /* Entrance animations are decorative; anyone who has asked their OS for less motion gets
       the same layout without the movement. Transitions that confirm an action still run,
       just fast enough not to read as motion. */
    @media (prefers-reduced-motion:reduce){
      *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
    }
  `;

  const AvatarEl = () => (
    <div onClick={() => setTab("profile")} style={{ width:32, height:32, borderRadius:"50%", overflow:"hidden", background:user.photo?`url(${user.photo}) center/cover no-repeat`:C.surface, border:`1.5px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:C.white, cursor:"pointer", flexShrink:0, transition:"border-color .18s, box-shadow .18s" }} onMouseEnter={e => { e.currentTarget.style.borderColor=C.accent; e.currentTarget.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onMouseLeave={e => { e.currentTarget.style.borderColor=C.border; e.currentTarget.style.boxShadow="none"; }}>
      {!user.photo && initials}
    </div>
  );

  // Keep the splash up past its normal 6s if data hasn't finished loading yet — extending a
  // fast, expected case by a beat is far better than flashing empty/default state (a fresh
  // signup screen, zeroed finances) for a returning user whose real data just hasn't arrived.
  if (showSplash || !dataLoaded) return <SplashScreen fading={splashFading && dataLoaded} />;

  if (step !== "dashboard") return (
    <div key={themeTick} style={{ fontFamily:"'Space Grotesk',sans-serif", overflowX:"hidden", maxWidth:"100vw", touchAction:"pan-y" }}>
      <style>{G}</style>

      {step === "login" && (
        <OShell step="login">
          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ margin:"0 auto 18px", width:64, height:64, borderRadius:18, background:C.white, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 0 8px ${C.fillStrong}` }}>
              <span style={{ fontSize:28, fontWeight:900, color:C.black }}>K</span>
            </div>
            <h1 style={{ fontSize:30, fontWeight:800, color:C.white, letterSpacing:-1.5, marginBottom:4 }}>Welcome back</h1>
            <Mono style={{ color:C.muted }}>Sign in to KROFT by Virt Technologies</Mono>
          </div>
          {forgotOpen ? (
            <div style={{ marginBottom:16 }}>
              {forgotSent ? (
                <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px", marginBottom:14, textAlign:"center" }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:3 }}>Check your email</div>
                  <Mono style={{ color:C.soft, lineHeight:1.5 }}>If an account exists for {forgotEmail.trim()}, a reset link is on its way.</Mono>
                </div>
              ) : (
                <>
                  <Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>Email</Mono>
                  <Inp placeholder="your@email.com" value={forgotEmail} type="email" onChange={e => { setForgotEmail(e.target.value); setForgotError(""); }} onKeyDown={e => e.key==="Enter"&&doForgotPassword()} />
                  {forgotError && (
                    <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 13px", marginTop:10 }}>
                      <Mono style={{ color:C.soft, lineHeight:1.5 }}>{forgotError}</Mono>
                    </div>
                  )}
                  <Btn full onClick={doForgotPassword} disabled={forgotLoading} style={{ padding:"13px", fontSize:14, marginTop:12 }}>{forgotLoading?(<><Spinner size={16} color={C.black} thickness={2} />Sending…</>):"Send reset link"}</Btn>
                </>
              )}
              <div style={{ textAlign:"center", marginTop:14 }}>
                <Mono style={{ color:C.muted, cursor:"pointer", textDecoration:"underline" }} onClick={() => { setForgotOpen(false); setForgotSent(false); setForgotError(""); setForgotEmail(""); }}>Back to log in</Mono>
              </div>
            </div>
          ) : (
          <>
          {loginAttempts>0&&!locked && (
            <div style={{ background:C.fill, border:`1px solid ${C.muted}`, borderRadius:8, padding:"8px 13px", marginBottom:13, display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ display:"flex", gap:4 }}>{[...Array(5)].map((_,i) => <div key={i} style={{ width:8, height:8, borderRadius:2, background:i<loginAttempts?C.white:C.border }} />)}</div>
              <Mono style={{ color:C.soft, fontSize:10 }}>{5-loginAttempts} attempt{5-loginAttempts!==1?"s":""} left</Mono>
            </div>
          )}
          {locked && (
            <div style={{ background:C.fillStrong, border:`1px solid ${C.soft}`, borderRadius:10, padding:"14px", marginBottom:14, textAlign:"center" }}>
              <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:3 }}>Account temporarily locked</div>
              <Mono style={{ color:C.soft }}>Try again in <span style={{ color:C.white, fontWeight:700 }}>{lockTimer}s</span></Mono>
            </div>
          )}
          <div style={{ display:"flex", flexDirection:"column", gap:13, marginBottom:10, opacity:locked?.4:1, pointerEvents:locked?"none":"all" }}>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>Email</Mono>
              <Inp placeholder="your@email.com" value={loginEmail} type="email" onChange={e => { setLoginEmail(e.target.value); setLoginError(""); }} onKeyDown={e => e.key==="Enter"&&document.getElementById("lpw")?.focus()} />
            </div>
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <Mono style={{ color:C.soft, letterSpacing:1 }}>Password</Mono>
                <Mono style={{ color:C.muted, cursor:"pointer", textDecoration:"underline", fontSize:11 }} onClick={() => { if (!isSupabaseConfigured) { toast("Sign in with a real account to reset your password."); return; } setForgotEmail(loginEmail); setForgotError(""); setForgotOpen(true); }}>Forgot password?</Mono>
              </div>
              <div style={{ position:"relative" }}>
                <input id="lpw" type={showLoginPw?"text":"password"} placeholder="••••••••" value={loginPw} onChange={e => { setLoginPw(e.target.value); setLoginError(""); }} onKeyDown={e => e.key==="Enter"&&doLogin()} style={{ width:"100%", background:C.surface, border:`1px solid ${loginError&&!locked?C.soft:C.cardB}`, borderRadius:12, padding:"11px 44px 11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
                <button onClick={() => setShowLoginPw(v => !v)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:C.soft, fontSize:10, fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.5 }}>{showLoginPw?"HIDE":"SHOW"}</button>
              </div>
            </div>
          </div>
          {loginError && (
            <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 13px", marginBottom:12 }}>
              <Mono style={{ color:C.soft, lineHeight:1.5 }}>{loginError}</Mono>
            </div>
          )}
          <Btn full onClick={doLogin} disabled={locked||authLoading} style={{ padding:"13px", fontSize:14, marginBottom:10 }}>{locked?`Locked (${lockTimer}s)`:authLoading?(<><Spinner size={16} color={C.black} thickness={2} />Logging in…</>):"Log In"}</Btn>
          {user.webauthnCredentialId && (
            <button onClick={doFingerprint} disabled={fpLoading||fpSuccess||locked} style={{ width:"100%", background:fpSuccess?"rgba(255,255,255,.1)":C.surface, border:`1px solid ${fpSuccess?C.white:C.muted}`, borderRadius:12, padding:"11px", cursor:locked||fpLoading||fpSuccess?"not-allowed":"pointer", color:fpSuccess?C.white:C.soft, fontSize:13, fontWeight:600, marginBottom:14, display:"flex", alignItems:"center", justifyContent:"center", gap:10, fontFamily:"'Space Grotesk',sans-serif", transition:"all .3s", opacity:locked?.4:1 }}>
              {fpLoading ? (<><Spinner size={16} color={C.white} thickness={2} />Verifying…</>) : fpSuccess ? "Fingerprint verified" : "Sign in with Fingerprint / Face ID"}
            </button>
          )}
          <div style={{ textAlign:"center", marginBottom:16 }}>
            <Mono style={{ color:C.muted }}>Don't have an account?{" "}<span onClick={() => { setLoginError(""); setStep("signup"); }} style={{ color:C.white, cursor:"pointer", textDecoration:"underline", fontWeight:600 }}>Sign up</span></Mono>
          </div>
          </>
          )}
          {!forgotOpen && (
          <>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:12 }}>
            <div style={{ flex:1, height:1, background:C.border }} /><Mono style={{ color:C.muted }}>or</Mono><div style={{ flex:1, height:1, background:C.border }} />
          </div>
          <div style={{ display:"flex", gap:9 }}>
            {[{l:"Google",e:"user@gmail.com"},{l:"Apple",e:"user@icloud.com"}].map(s => (
              <button key={s.l} onClick={() => { setUser(u => ({...u, email:s.e})); setStep("signup"); }} style={{ flex:1, background:C.surface, border:`1px solid ${C.muted}`, borderRadius:12, padding:"10px", cursor:"pointer", color:C.white, fontSize:12, fontWeight:600, fontFamily:"'Space Grotesk',sans-serif" }} onMouseEnter={e => e.currentTarget.style.borderColor=C.white} onMouseLeave={e => e.currentTarget.style.borderColor=C.muted}>
                {s.l}
              </button>
            ))}
          </div>
          </>
          )}
        </OShell>
      )}

      {step === "reset-password" && (
        <OShell step="reset-password">
          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ margin:"0 auto 18px", width:64, height:64, borderRadius:18, background:C.white, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 0 8px ${C.fillStrong}` }}>
              <span style={{ fontSize:28, fontWeight:900, color:C.black }}>K</span>
            </div>
            <h1 style={{ fontSize:30, fontWeight:800, color:C.white, letterSpacing:-1.5, marginBottom:4 }}>Set a new password</h1>
            <Mono style={{ color:C.muted }}>Choose a new password for your account</Mono>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:13, marginBottom:12 }}>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>New password</Mono>
              <input type="password" placeholder="At least 8 characters" value={newPw} onChange={e => { setNewPw(e.target.value); setResetPwError(""); }} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
            </div>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>Confirm password</Mono>
              <input type="password" placeholder="Re-enter your new password" value={confirmNewPw} onChange={e => { setConfirmNewPw(e.target.value); setResetPwError(""); }} onKeyDown={e => e.key==="Enter"&&doResetPassword()} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
            </div>
          </div>
          {resetPwError && (
            <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 13px", marginBottom:12 }}>
              <Mono style={{ color:C.soft, lineHeight:1.5 }}>{resetPwError}</Mono>
            </div>
          )}
          <Btn full onClick={doResetPassword} disabled={resetPwLoading} style={{ padding:"13px", fontSize:14 }}>{resetPwLoading?(<><Spinner size={16} color={C.black} thickness={2} />Updating…</>):"Update password"}</Btn>
        </OShell>
      )}

      {step === "signup" && (
        <OShell step="signup">
          <div style={{ textAlign:"center", marginBottom:22 }}>
            <div style={{ margin:"0 auto 16px", width:60, height:60, borderRadius:16, background:C.white, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ fontSize:24, fontWeight:900, color:C.black }}>K</span>
            </div>
            <h1 style={{ fontSize:28, fontWeight:800, color:C.white, letterSpacing:-1, marginBottom:4 }}>Create account</h1>
            <Mono style={{ color:C.muted }}>Set up your KROFT profile</Mono>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:6 }}>
            <div><Mono style={{ display:"block", color:C.soft, marginBottom:5 }}>Full name *</Mono><Inp placeholder="John Carter" value={user.name||""} onChange={e => { setUser(u => ({...u,name:e.target.value})); setSignupError(""); }} /></div>
            <div><Mono style={{ display:"block", color:C.soft, marginBottom:5 }}>Email address *</Mono><Inp placeholder="john@example.com" value={user.email||""} type="email" onChange={e => { setUser(u => ({...u,email:e.target.value})); setSignupError(""); }} /></div>
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                <Mono style={{ color:C.soft }}>Password *</Mono>
                <button onClick={() => { const p = generatePassword(); setSignupPw(p); setConfirmPw(p); setShowSignupPw(true); setSignupError(""); toast("Strong password generated."); }} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"'Space Grotesk',sans-serif", fontSize:10, color:C.white, textDecoration:"underline", padding:0 }}>Suggest password</button>
              </div>
              <div style={{ position:"relative" }}>
                <input type={showSignupPw?"text":"password"} placeholder="Create a strong password" value={signupPw} onChange={e => { setSignupPw(e.target.value); setSignupError(""); }} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 54px 11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
                <button onClick={() => setShowSignupPw(v => !v)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:C.soft, fontSize:10, fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.5 }}>{showSignupPw?"HIDE":"SHOW"}</button>
              </div>
              {pw.length>0 && (
                <div style={{ marginTop:7 }}>
                  <div style={{ display:"flex", gap:3, marginBottom:4 }}>{[1,2,3,4,5].map(i => <div key={i} style={{ flex:1, height:3, borderRadius:99, background:i<=pwScore?pwColor:C.border, transition:"background .25s" }} />)}</div>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <Mono style={{ fontSize:10, color:pwColor, fontWeight:700 }}>{pwStrength}</Mono>
                    <div style={{ display:"flex", gap:7 }}>{Object.entries({"8+":pwChecks.length,"A-Z":pwChecks.upper,"a-z":pwChecks.lower,"0-9":pwChecks.number,"!@#":pwChecks.special}).map(([k,v]) => <Mono key={k} style={{ fontSize:9, color:v?C.white:C.border, textDecoration:v?"none":"line-through" }}>{k}</Mono>)}</div>
                  </div>
                </div>
              )}
            </div>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:5 }}>Confirm password *</Mono>
              <div style={{ position:"relative" }}>
                <input type={showConfirmPw?"text":"password"} placeholder="Repeat your password" value={confirmPw} onChange={e => { setConfirmPw(e.target.value); setSignupError(""); }} style={{ width:"100%", background:C.surface, border:`1px solid ${confirmPw.length>0?(confirmPw===signupPw?C.white:C.border):C.cardB}`, borderRadius:12, padding:"11px 54px 11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor = confirmPw.length>0 ? (confirmPw===signupPw?C.white:C.border) : C.cardB; e.target.style.boxShadow="none"; }} />
                <button onClick={() => setShowConfirmPw(v => !v)} style={{ position:"absolute", right:12, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", color:C.soft, fontSize:10, fontFamily:"'Space Grotesk',sans-serif", letterSpacing:.5 }}>{showConfirmPw?"HIDE":"SHOW"}</button>
              </div>
              {confirmPw.length>0&&confirmPw!==signupPw && <Mono style={{ color:C.soft, display:"block", marginTop:4, fontSize:10 }}>Passwords do not match</Mono>}
              {confirmPw.length>0&&confirmPw===signupPw && <Mono style={{ color:C.white, display:"block", marginTop:4, fontSize:10 }}>Passwords match</Mono>}
            </div>
            <div><Mono style={{ display:"block", color:C.soft, marginBottom:5 }}>Phone number</Mono><Inp placeholder="+1 (555) 000-0000" value={user.phone||""} type="tel" onChange={e => setUser(u => ({...u,phone:e.target.value}))} /></div>
          </div>
          {signupError && <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 13px", marginBottom:10, marginTop:8 }}><Mono style={{ color:C.soft, lineHeight:1.5 }}>{signupError}</Mono></div>}
          <div style={{ display:"flex", gap:10, marginTop:12 }}>
            <Btn v="outline" onClick={() => setStep("login")} style={{ flex:1 }}>Back</Btn>
            <Btn onClick={doSignup} disabled={authLoading||!user.name||!user.email||!signupPw||pwScore<3||!confirmPw||confirmPw!==signupPw} style={{ flex:2 }}>{authLoading?(<><Spinner size={16} color={C.black} thickness={2} />Creating account…</>):"Sign Up"}</Btn>
          </div>
        </OShell>
      )}

      {step === "photo" && (
        <OShell step="photo">
          <canvas ref={canvasRef} style={{ display:"none" }} />
          <input ref={galleryRef} type="file" accept="image/*" onChange={handleGalleryPick} style={{ display:"none" }} />
          <h2 style={{ fontSize:26, fontWeight:800, color:C.white, letterSpacing:-1, marginBottom:4 }}>Profile photo</h2>
          <Mono style={{ display:"block", color:C.muted, marginBottom:22 }}>Choose from gallery or use your camera.</Mono>
          {cameraMode && (
            <div style={{ marginBottom:18 }}>
              <div style={{ position:"relative", borderRadius:14, overflow:"hidden", border:`1px solid ${C.border}`, background:C.black, aspectRatio:"4/3", minHeight:200 }}>
                <video ref={videoRef} autoPlay playsInline muted style={{ width:"100%", height:"100%", objectFit:"cover", display:"block", transform:"scaleX(-1)" }} />
                <div style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
                  {[{top:10,left:10,borderTop:`2px solid ${C.white}`,borderLeft:`2px solid ${C.white}`,borderRadius:"4px 0 0 0"},{top:10,right:10,borderTop:`2px solid ${C.white}`,borderRight:`2px solid ${C.white}`,borderRadius:"0 4px 0 0"},{bottom:10,left:10,borderBottom:`2px solid ${C.white}`,borderLeft:`2px solid ${C.white}`,borderRadius:"0 0 0 4px"},{bottom:10,right:10,borderBottom:`2px solid ${C.white}`,borderRight:`2px solid ${C.white}`,borderRadius:"0 0 4px 0"}].map((pos,i) => <div key={i} style={{ position:"absolute", width:22, height:22, ...pos }} />)}
                </div>
                {!cameraReady && <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,.75)" }}><div style={{ textAlign:"center" }}><div style={{ margin:"0 auto 10px", display:"flex", justifyContent:"center" }}><Spinner size={28} color="#ffffff" thickness={2} /></div><Mono style={{ color:"#dcd8d0" }}>Starting camera…</Mono></div></div>}
              </div>
              <div style={{ display:"flex", gap:10, marginTop:12, alignItems:"center", justifyContent:"center" }}>
                <Btn v="outline" sm onClick={closeCamera}>Cancel</Btn>
                <button onClick={snapPhoto} disabled={!cameraReady} style={{ width:62, height:62, borderRadius:"50%", background:cameraReady?C.white:C.border, border:"3px solid rgba(255,255,255,.15)", cursor:cameraReady?"pointer":"not-allowed", boxShadow:cameraReady?"0 0 0 6px rgba(255,255,255,.1)":"none" }} />
                <Btn v="outline" sm onClick={() => { closeCamera(); galleryRef.current?.click(); }}>Gallery</Btn>
              </div>
              <Mono style={{ display:"block", textAlign:"center", color:C.muted, marginTop:10 }}>Tap the circle to capture</Mono>
            </div>
          )}
          {!cameraMode && (
            <>
              <div style={{ display:"flex", justifyContent:"center", marginBottom:18 }}>
                <div style={{ width:110, height:110, borderRadius:"50%", overflow:"hidden", background:user.photo?`url(${user.photo}) center/cover no-repeat`:C.surface, border:`2px solid ${user.photo?C.white:C.muted}`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:user.photo?`0 0 0 5px ${C.fillStrong}`:"none" }}>
                  {!user.photo && <Mono style={{ fontSize:9, color:C.muted }}>No photo</Mono>}
                </div>
              </div>
              {user.photo && <div style={{ textAlign:"center", marginBottom:14 }}><Tag hi>{photoSource==="camera"?"From camera":"From gallery"}</Tag></div>}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:12 }}>
                {[{label:"Gallery",sub:"Pick from your photos",fn:()=>galleryRef.current?.click()},{label:"Camera",sub:"Take a photo now",fn:openCamera}].map(b => (
                  <button key={b.label} onClick={b.fn} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:14, padding:"22px 12px", cursor:"pointer", textAlign:"center", fontFamily:"'Space Grotesk',sans-serif" }} onMouseEnter={e => { e.currentTarget.style.borderColor=C.soft; e.currentTarget.style.background=C.hover; }} onMouseLeave={e => { e.currentTarget.style.borderColor=C.cardB; e.currentTarget.style.background=C.card; }}>
                    <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:3 }}>{b.label}</div>
                    <Mono style={{ color:C.muted, fontSize:10 }}>{b.sub}</Mono>
                  </button>
                ))}
              </div>
              {cameraError && <div style={{ background:C.fill, border:`1px solid ${C.muted}`, borderRadius:12, padding:"10px 13px", marginBottom:11 }}><Mono style={{ color:C.soft, lineHeight:1.6 }}>{cameraError}</Mono></div>}
              {user.photo && <button onClick={() => { setUser(u => ({...u,photo:null})); setPhotoSource(""); }} style={{ width:"100%", background:"none", border:`1px dashed ${C.border}`, borderRadius:12, padding:"9px", cursor:"pointer", color:C.muted, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", marginBottom:11 }}>Remove photo</button>}
              {!user.photo && <div style={{ background:C.surface, borderRadius:12, padding:"10px 14px", marginBottom:11, textAlign:"center" }}><Mono style={{ color:C.soft, lineHeight:1.6 }}>No photo? KROFT will show your initials{user.name?" — "+user.name.split(" ").map(n=>n[0]).join("").toUpperCase():""} as your avatar.</Mono></div>}
            </>
          )}
          {!cameraMode && <div style={{ display:"flex", gap:10 }}><Btn v="outline" onClick={() => setStep("signup")} style={{ flex:1 }}>Back</Btn><Btn onClick={() => setStep("business")} style={{ flex:2 }}>{user.photo?"Continue":"Skip for now"}</Btn></div>}
        </OShell>
      )}

      {step === "business" && (
        <OShell step="business" hideProgress={editingFromProfile}>
          <h2 style={{ fontSize:26, fontWeight:800, color:C.white, letterSpacing:-1, marginBottom:4 }}>Your Business</h2>
          <Mono style={{ display:"block", color:C.muted, marginBottom:22 }}>So KROFT can tailor your finance dashboard.</Mono>
          <div style={{ display:"flex", flexDirection:"column", gap:13, marginBottom:22 }}>
            <div><Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>Business name</Mono><Inp placeholder="e.g. Carter Consulting LLC" value={user.businessName} onChange={e => setUser(u => ({...u,businessName:e.target.value}))} /></div>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:6, letterSpacing:1 }}>Business type</Mono>
              <select value={user.businessType} onChange={e => setUser(u => ({...u,businessType:e.target.value}))} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:user.businessType?C.text:C.muted, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", cursor:"pointer" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }}>
                <option value="">Select type…</option>
                {["Freelancer","Consultant","Agency","Retail","Restaurant","Tech Startup","Healthcare","Real Estate","E-commerce","Other"].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <Mono style={{ display:"block", color:C.soft, marginBottom:8, letterSpacing:1 }}>Currency</Mono>
              <select value={Object.values(CURRENCY_GROUPS).some(g=>g.includes(user.currency)) ? user.currency : ""} onChange={e => { if (e.target.value) { setUser(u => ({...u,currency:e.target.value})); setCustomCurrency(""); setCustomCurrencyError(""); } }}
                style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", cursor:"pointer", marginBottom:8 }}>
                <option value="" disabled>{Object.values(CURRENCY_GROUPS).some(g=>g.includes(user.currency)) ? "Select…" : `Custom: ${user.currency}`}</option>
                {Object.entries(CURRENCY_GROUPS).map(([region, codes]) => (
                  <optgroup key={region} label={region}>
                    {codes.map(c => <option key={c} value={c}>{c} — {fmtCur(0,c).replace(/0\.00/,"").trim() || c}</option>)}
                  </optgroup>
                ))}
              </select>
              <div style={{ display:"flex", gap:7 }}>
                <Inp placeholder="Don't see yours? Type a code, e.g. ISK" value={customCurrency} onChange={e => { setCustomCurrency(e.target.value.toUpperCase()); setCustomCurrencyError(""); }} style={{ flex:1 }} />
                <Btn sm v="outline" onClick={() => {
                  if (!isValidCurrencyCode(customCurrency)) { setCustomCurrencyError("Not a recognized currency code."); return; }
                  setUser(u => ({...u, currency: customCurrency.toUpperCase()})); setCustomCurrencyError("");
                }}>Use</Btn>
              </div>
              {customCurrencyError && <Mono style={{ display:"block", color:C.negative, marginTop:6 }}>{customCurrencyError}</Mono>}
              <Mono style={{ display:"block", color:C.soft, marginTop:8 }}>Currently: {user.currency} · {fmtCur(1000, user.currency)}</Mono>
              {/* Changing currency doesn't convert anything — there are no exchange rates here.
                  Entries keep the currency they were recorded in, so old figures stay truthful;
                  this says so rather than letting totals quietly become nonsense. */}
              {(income.length > 0 || expenses.length > 0) && (
                <Mono style={{ display:"block", color:C.warning, marginTop:6, lineHeight:1.6 }}>
                  Changing this affects new entries only. Existing amounts keep the currency they were entered in — nothing is converted.
                </Mono>
              )}
            </div>
          </div>
          {editingFromProfile ? (
            <div style={{ display:"flex", gap:10 }}><Btn v="outline" onClick={() => setStep("dashboard")} style={{ flex:1 }}>Cancel</Btn><Btn onClick={() => { saveProfileNow().catch(()=>{}); setStep("dashboard"); toast("Business details saved."); }} style={{ flex:2 }}>Save</Btn></div>
          ) : (
            <div style={{ display:"flex", gap:10 }}><Btn v="outline" onClick={() => setStep("photo")} style={{ flex:1 }}>Back</Btn><Btn onClick={() => setStep("prefs")} style={{ flex:2 }}>Next</Btn></div>
          )}
        </OShell>
      )}

      {step === "prefs" && (
        <OShell step="prefs" hideProgress={editingFromProfile}>
          <h2 style={{ fontSize:26, fontWeight:800, color:C.white, letterSpacing:-1, marginBottom:4 }}>Preferences</h2>
          <Mono style={{ display:"block", color:C.muted, marginBottom:22 }}>Connect the accounts KROFT should work with.</Mono>
          <div style={{ marginBottom:22 }}>
            <Mono style={{ display:"block", color:C.soft, marginBottom:11 }}>Connect accounts</Mono>
            {!isSupabaseConfigured && (
              <Mono style={{ display:"block", color:C.muted, fontSize:10, marginBottom:9 }}>Sign in with a real account (Supabase isn't configured) to connect an email or calendar provider.</Mono>
            )}
            <div style={{ display:"flex", flexDirection:"column" }}>
              {/* Gmail+Calendar share one Google OAuth grant, and Outlook Mail+Calendar share
                  one Microsoft grant (both scopes requested together in api/google/start.js
                  and api/microsoft/start.js respectively) — so linking or unlinking either row
                  within a provider acts on that whole connection, not just one feature. Both
                  providers can be connected at once: api/mail/messages.js and
                  api/calendar/events.js merge data from whichever are connected into one
                  inbox/calendar rather than needing separate views per provider. Uber isn't
                  listed here at all: its ride-request deep link (see UberModal/
                  buildUberDeepLink above) needs no account connection or API key — it works
                  the same for every user the moment they tap "Uber" anywhere in the app.
                  Plain divided rows rather than a bordered box per account — four boxes back to
                  back on an already-boxy signup flow just reads as clutter; the "Link"/"Unlink"
                  button and a positive-tinted "Linked" label carry the state instead. */}
              {[
                { k:"gmail", n:"Gmail", d:"Read & send real emails", linked:googleStatus.gmail, linking:googleLinking, connect:connectGoogle, disconnect:disconnectGoogle },
                { k:"googleCalendar", n:"Google Calendar", d:"Sync appointments", linked:googleStatus.calendar, linking:googleLinking, connect:connectGoogle, disconnect:disconnectGoogle },
                { k:"outlookMail", n:"Outlook Mail", d:"Read & send real emails", linked:microsoftStatus.mail, linking:microsoftLinking, connect:connectMicrosoft, disconnect:disconnectMicrosoft },
                { k:"outlookCalendar", n:"Outlook Calendar", d:"Sync appointments", linked:microsoftStatus.calendar, linking:microsoftLinking, connect:connectMicrosoft, disconnect:disconnectMicrosoft },
              ].map((a, i, arr) => (
                <div key={a.k} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 2px", borderBottom:i<arr.length-1?`1px solid ${C.cardB}`:"none" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <div style={{ fontWeight:700, fontSize:13, color:C.white }}>{a.n}</div>
                      {a.linked && <Mono style={{ color:C.positive, fontSize:9, fontWeight:700, letterSpacing:.5 }}>LINKED</Mono>}
                    </div>
                    <Mono style={{ color:C.muted, fontSize:10 }}>{a.d}</Mono>
                  </div>
                  <Btn sm v={a.linked?"outline":"solid"} disabled={!isSupabaseConfigured||a.linking}
                    onClick={() => a.linked ? a.disconnect() : a.connect()}>
                    {a.linking ? <Spinner size={14} color={a.linked?C.soft:C.black} thickness={2} /> : a.linked ? "Unlink" : "Link"}
                  </Btn>
                </div>
              ))}
            </div>
          </div>
          {editingFromProfile ? (
            <div style={{ display:"flex", gap:10 }}><Btn v="outline" onClick={() => setStep("dashboard")} style={{ flex:1 }}>Cancel</Btn><Btn onClick={() => { saveProfileNow().catch(()=>{}); setStep("dashboard"); toast("Preferences saved."); }} style={{ flex:2 }}>Save</Btn></div>
          ) : (
            <div style={{ display:"flex", gap:10 }}><Btn v="outline" onClick={() => setStep("business")} style={{ flex:1 }}>Back</Btn><Btn onClick={() => setStep("done")} style={{ flex:2 }}>Almost done</Btn></div>
          )}
        </OShell>
      )}

      {step === "done" && (
        <OShell step="done">
          <div style={{ textAlign:"center" }}>
            <div style={{ width:80, height:80, borderRadius:"50%", overflow:"hidden", background:user.photo?`url(${user.photo}) center/cover no-repeat`:C.surface, border:`3px solid ${C.white}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, fontWeight:800, color:C.white, margin:"0 auto 20px", animation:"pop .5s ease" }}>
              {!user.photo && initials}
            </div>
            <div style={{ marginBottom:10 }}><Tag hi>Account Ready</Tag></div>
            <h2 style={{ fontSize:28, fontWeight:800, color:C.white, letterSpacing:-1, marginBottom:7, marginTop:12 }}>Ready, {user.name}.</h2>
            <Mono style={{ display:"block", color:C.muted, marginBottom:26, lineHeight:1.8 }}>Your KROFT account is set up.<br />Your personal AI assistant is ready.</Mono>
            {/* A plain divided list, not five boxes — the account summary is read once and never
                touched again, so it doesn't need the visual weight of its own card per field. */}
            <div style={{ marginBottom:26, textAlign:"left" }}>
              {[{k:"Name",v:user.name},{k:"Email",v:user.email||"—"},{k:"Business",v:user.businessName||"Not set"},{k:"Currency",v:user.currency},{k:"Apps",v:Object.values(user.connected).filter(Boolean).length+" linked"}].map((r, i, arr) => (
                <div key={r.k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, padding:"9px 2px", borderBottom:i<arr.length-1?`1px solid ${C.cardB}`:"none" }}>
                  <Mono style={{ color:C.muted, letterSpacing:.8 }}>{r.k.toUpperCase()}</Mono>
                  <div style={{ fontSize:12, fontWeight:700, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.v}</div>
                </div>
              ))}
            </div>
            <Btn full onClick={() => setStep("dashboard")} style={{ padding:"14px", fontSize:15 }}>Enter KROFT</Btn>
          </div>
        </OShell>
      )}
    </div>
  );

  // Four core pages for the bottom navigation. Ask Kroft is no longer a bottom tab —
  // it's a persistent button in the top-right of every main screen instead.
  // Finance and Around Me (which now includes Food) live as switchable sections inside Home.
  const NAV_TABS = [
    {id:"home",      label:"Home"},
    {id:"wellness",  label:"Wellness"},
    {id:"workspace", label:"Workspace"},
    {id:"profile",   label:"Profile"},
  ];

  return (
    <div key={themeTick} style={{ fontFamily:"'Space Grotesk',sans-serif", background:C.bg, minHeight:"100vh", color:C.text, overflowX:"hidden", maxWidth:"100vw", touchAction:"pan-y" }}>
      <style>{G}</style>
      {showBriefing && <Briefing user={user} income={totalIncome} expenses={totalExpenses} emails={emails} appts={appts} onClose={() => setShowBriefing(false)} />}
      {showChatHistory && (() => {
        const q = chatHistorySearch.trim().toLowerCase();
        const filtered = q ? chatHistory.filter(c => c.title.toLowerCase().includes(q)) : chatHistory;
        return (
          <div role="dialog" aria-modal="true" aria-label="Chat history" style={{ position:"fixed", inset:0, zIndex:310, background:C.bg, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
              <button onClick={() => { setShowChatHistory(false); setChatHistorySearch(""); }} aria-label="Close chat history" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1 }}>←</button>
              <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, flex:1 }}>Chat history</h2>
              <Btn sm onClick={() => { startNewChat(); setShowChatHistory(false); setChatHistorySearch(""); }}>New chat</Btn>
            </div>
            <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16 }}>
              {chatHistory.length > 0 && (
                <Inp placeholder="Search conversations…" value={chatHistorySearch} onChange={e=>setChatHistorySearch(e.target.value)} style={{ marginBottom:16, width:"100%", boxSizing:"border-box" }} />
              )}
              {chatHistory.length === 0 ? (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No past conversations yet</div>
                  <Mono style={{ display:"block", color:C.soft }}>Starting a new chat saves the one you're leaving here.</Mono>
                </Card>
              ) : filtered.length === 0 ? (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <Mono style={{ color:C.soft }}>Nothing matches "{chatHistorySearch}".</Mono>
                </Card>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                  {filtered.map(c => (
                    <Card key={c.id} onClick={() => openHistoryChat(c.id)}
                      {...longPress(() => setActionSheet(holdActions({
                        title: c.title,
                        subtitle: `${c.messages.length} messages · ${chatHistoryWhen(c.updatedAt)}`,
                        list: chatHistory, setList: setChatHistory, id: c.id,
                        deletedLabel: "Conversation deleted.",
                        confirmText: "This removes the conversation from your history.",
                      })))}
                      style={{ cursor:"pointer", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                        <div style={{ minWidth:0, flex:1 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.title}</div>
                          <Mono style={{ color:C.muted, display:"block", marginTop:3 }}>{c.messages.filter(m=>m.role==="user").length} message{c.messages.filter(m=>m.role==="user").length===1?"":"s"} you sent</Mono>
                        </div>
                        <Mono style={{ color:C.soft, flexShrink:0 }}>{chatHistoryWhen(c.updatedAt)}</Mono>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {uberDest && <UberModal dest={uberDest} onClose={() => setUberDest(null)} />}
      {composeDraft && <ComposeModal draft={composeDraft} onChange={setComposeDraft} onSend={async d => {
        // Real send when a real email account is connected — otherwise fall back to the
        // original simulated send (a toast plus a scripted fake reply a few seconds later), so
        // the compose flow still demos sensibly for anyone who hasn't linked a real account.
        // d.provider (set on Reply/AI Draft from the original message's source) sends the
        // reply from the same account it arrived on; a fresh compose omits it and
        // api/mail/send.js picks whichever connected account comes first.
        if (googleStatus.gmail || microsoftStatus.mail) {
          try {
            const res = await authedFetch("/api/mail/send", { method:"POST", body:JSON.stringify({ to:d.to, subject:d.subject, body:d.body, provider:d.provider }) });
            if (!res.ok) { toast("Couldn't send — the email provider rejected the message."); return; }
            toast(`Email sent to ${d.to}`);
            setComposeDraft(null);
          } catch {
            toast("Couldn't send — check your connection and try again.");
          }
          return;
        }
        toast(`Email sent to ${d.to}`);
        setComposeDraft(null);
        const replySubject = d.subject.startsWith("Re:") ? d.subject : `Re: ${d.subject}`;
        setTimeout(() => {
          setEmails(p => [{ id:uid(), from:d.to||"contact@example.com", subject:replySubject, tag:"Reply", time:timeStr(), read:false, body:rand([
            "Thanks for this — got it, will take a look and get back to you shortly.",
            "Appreciate the update. That timeline works on my end.",
            "Perfect, this is exactly what I needed. Thanks!",
            "Noted, thank you. Let's touch base again next week.",
          ]) }, ...p]);
          toast(`New email from ${d.to}`);
        }, 6000);
      }} onClose={() => setComposeDraft(null)} />}
      {contactPicker && (
        <PickContactModal
          contacts={contacts}
          filter={c => !!c.email}
          title="Send to which contact?"
          emptyHint="No saved contacts have an email yet. Add one in Workspace → Contacts."
          onPick={c => {
            setComposeDraft({ to:c.email, subject:"", body:"" });
            setContactPicker(null);
          }}
          onClose={() => setContactPicker(null)}
        />
      )}
      {incomingCall && <IncomingCallScreen call={incomingCall} onAnswer={answerCall} onDecline={declineCall} />}
      {ringingReminder && <ReminderAlarmScreen reminder={ringingReminder} onDismiss={dismissReminderAlarm} onSnooze={snoozeReminderAlarm} />}
      {voiceOpen && (
        <VoiceMode
          state={voiceState}
          transcript={voiceTranscript}
          reply={voiceReply}
          error={voiceError}
          levelRef={voiceLevelRef}
          primed={micPrimed}
          supported={SRSupported}
          onStart={voiceListen}
          onStop={voiceStop}
          onClose={closeVoice}
          subscribed={subscribed}
          turnsLeft={voiceTurnsLeft()}
        />
      )}
      {actionSheet && <ActionSheet {...actionSheet} onClose={() => setActionSheet(null)} />}
      {contactActivity && (
        <ContactActivityModal
          contact={contacts.find(c => c.id === contactActivity.id) || contactActivity}
          tasks={tasks.filter(t => t.contactId === contactActivity.id)}
          reminders={smartReminders.filter(r => r.contactId === contactActivity.id)}
          appts={appts.filter(a => a.contactId === contactActivity.id)}
          notes={notes.filter(n => n.contactId === contactActivity.id)}
          files={files.filter(f => f.contactId === contactActivity.id)}
          onToggleTask={id => setTasks(p => p.map(x => x.id===id ? {...x, done:!x.done} : x))}
          onToggleReminder={id => setSmartReminders(p => p.map(x => x.id===id ? {...x, done:!x.done} : x))}
          onClose={() => setContactActivity(null)}
        />
      )}

      {/* Above every overlay, including voice mode (1200). Toasts carry the undo for an action
          KROFT just took — and a misheard amount is far likelier by voice than by typing, so
          burying the undo behind the voice overlay hid it exactly where it mattered most. */}
      {/* aria-live so toasts are announced rather than shown only. These carry undo prompts and
          budget warnings — a screen reader user previously got no signal that a destructive
          action had happened, let alone that it could be reversed. "polite" waits for a pause
          instead of cutting across whatever is being read. */}
      <div role="status" aria-live="polite" aria-atomic="false"
        style={{ position:"fixed", top:14, right:14, zIndex:1400, display:"flex", flexDirection:"column", gap:7, maxWidth:300 }}>
        {toasts.map(t => (
          <div key={t.id} style={{ background:C.card, border:`1px solid ${C.accent}44`, borderRadius:14, padding:"9px 14px", animation:"slideIn .3s ease", boxShadow:`0 8px 28px rgba(0,0,0,.7), 0 0 0 1px ${C.accentBg}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <Dot color={C.accent} />
              <div style={{ fontSize:11, color:C.white, lineHeight:1.4, fontFamily:"'Space Grotesk',sans-serif", flex:1 }}>{t.msg}</div>
              {t.onUndo && (
                <button onClick={() => { t.onUndo(); setToasts(p => p.filter(x => x.id !== t.id)); }} style={{ background:"none", border:"none", color:C.accent, fontSize:11, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif", cursor:"pointer", padding:"4px 2px", flexShrink:0 }}>Undo</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showConfetti && <Confetti onDone={() => setShowConfetti(false)} />}

      {tab!=="workspace" && (
      <header style={{ borderBottom:`1px solid ${C.cardB}`, padding:"11px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", background:C.bg, position:"sticky", top:0, zIndex:200, backdropFilter:"blur(14px)", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:9, minWidth:0, flexShrink:1 }}>
          <div style={{ width:30, height:30, borderRadius:8, background:C.white, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:C.black, flexShrink:0, boxShadow:`0 0 14px ${C.accent}40` }}>K</div>
          <div style={{ minWidth:0, overflow:"hidden" }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.white, letterSpacing:-.4, whiteSpace:"nowrap" }}>KROFT</div>
            <Mono style={{ fontSize:8, color:C.muted, letterSpacing:.8, whiteSpace:"nowrap", display:"block", overflow:"hidden", textOverflow:"ellipsis" }}>by Virt Technologies</Mono>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <button onClick={() => setTab("nova")} className="hbtn" style={{ background:tab==="nova"?C.accent:C.surface, border:`1px solid ${tab==="nova"?C.accent:C.border}`, borderRadius:20, padding:"7px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:6, color:tab==="nova"?"#fff":C.white, fontSize:12, fontWeight:700, whiteSpace:"nowrap", flexShrink:0, boxShadow:tab==="nova"?`0 0 16px ${C.accent}66`:`0 0 0 1px ${C.fill}` }}>
            <NavIcon id="nova" size={13} color={tab==="nova"?"#fff":C.white} />
            Ask Kroft
          </button>
          <AvatarEl />
        </div>
      </header>
      )}

      {tab==="workspace" && (
        <header style={{ borderBottom:`1px solid ${C.cardB}`, padding:"11px 16px", display:"flex", alignItems:"center", gap:12, background:C.bg, position:"sticky", top:0, zIndex:200, backdropFilter:"blur(14px)" }}>
          <button onClick={() => workspaceSection ? setWorkspaceSection(null) : setTab("home")} style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1, flexShrink:0 }} aria-label="Back">←</button>
          <div style={{ minWidth:0, overflow:"hidden" }}>
            <div style={{ fontSize:15, fontWeight:700, color:C.white, letterSpacing:-.4, whiteSpace:"nowrap" }}>{{calendar:"Calendar",notes:"Notes",email:"Email",tasks:"Tasks",files:"Files",documents:"Documents",projects:"Projects",memos:"Voice Memos",reminders:"Reminders",contacts:"Contacts"}[workspaceSection] || "Workspace"}</div>
            
          </div>
        </header>
      )}

      {transcript && <div style={{ background:C.accentBg, borderBottom:`1px solid ${C.accent}33`, padding:"7px 22px", display:"flex", alignItems:"center", gap:8 }}><WaveBar active color={C.accent} /><Mono style={{ color:C.white, fontStyle:"italic" }}>"{transcript}"</Mono></div>}

      <main style={{ padding: tab==="workspace" ? "16px 22px 150px" : "20px 22px 150px", maxWidth:880, margin:"0 auto" }}>

        {tab==="home" && (
          <div style={{ marginBottom:18, display:"flex", gap:7, flexWrap:"wrap" }}>
            {[{k:"overview",l:"Overview"},{k:"finance",l:"Finance"},{k:"around",l:"Around Me"}].map(s => (
              <button key={s.k} onClick={() => setHomeSection(s.k)} style={{ background:homeSection===s.k?"rgba(255,255,255,.1)":"transparent", border:`1px solid ${homeSection===s.k?C.border:C.cardB}`, borderRadius:20, padding:"6px 14px", cursor:"pointer", color:homeSection===s.k?C.white:C.muted, fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>
                {s.l}
              </button>
            ))}
          </div>
        )}

        {tab==="home" && homeSection==="overview" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ marginBottom:16 }}>
              <h1 style={{ fontSize:21, fontWeight:700, color:C.white, letterSpacing:-.8, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>Hi, {firstNameOf(user.name)||"there"} 👋</h1>
            </div>
            <Mono style={{ display:"block", color:C.muted, marginBottom:16 }}>{dateStr()}</Mono>
            {/* Net profit as one glanceable "how am I doing" pill, the way a smart-home dashboard
                leads with total energy used rather than burying it in a device grid — the
                Income/Expenses breakdown below stays as the detail view underneath it. */}
            <button onClick={() => setHomeSection("finance")} style={{ width:"100%", display:"flex", alignItems:"center", gap:12, background:C.text, border:"none", borderRadius:999, padding:"10px 14px", cursor:"pointer", marginBottom:16, textAlign:"left", boxSizing:"border-box" }}>
              <div style={{ width:36, height:36, borderRadius:"50%", background:C.card, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <NavIcon id={netProfit>=0?"trendUp":"trendDown"} size={16} color={netProfit>=0?C.positive:C.negative} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, color:C.card, letterSpacing:-.5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fmtCur(netProfit,user.currency)}</div>
                <Mono style={{ color:C.card, opacity:.65 }}>Net profit this month</Mono>
              </div>
              <Mono style={{ color:C.card, opacity:.65, flexShrink:0 }}>›</Mono>
            </button>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:16 }}>
              {[{l:"Income",v:fmtCur(totalIncome,user.currency),sub:income.length>0?`${income.length} entries`:"Add income",icon:"trendUp",tone:"positive"},{l:"Expenses",v:fmtCur(totalExpenses,user.currency),sub:expenses.length>0?`${expenses.length} entries`:"Add expense",icon:"trendDown",tone:"negative"}].map(k => (
                <Card key={k.l} level="raised" onClick={() => setHomeSection("finance")} style={{ minWidth:0 }}>
                  <div style={{ width:32, height:32, borderRadius:"50%", background:C.surface, border:`1px solid ${C.cardB}`, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:10 }}>
                    <NavIcon id={k.icon} size={15} color={k.tone==="positive"?C.positive:C.negative} />
                  </div>
                  <Mono style={{ display:"block", color:C.muted, marginBottom:6, fontSize:11 }}>{k.l}</Mono>
                  <div style={{ fontSize:18, fontWeight:700, color:C.white, letterSpacing:-.6, marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{k.v}</div>
                  <Mono style={{ color:C.muted, fontSize:10 }}>{k.sub}</Mono>
                </Card>
              ))}
            </div>
            {/* Budget trouble surfaces on the screen people actually land on. A warning buried
                one tab deeper in Finance is one most users would never see in time to act. */}
            {(() => {
              const trouble = budgetStatus().filter(b => b.pct >= 0.8);
              if (!trouble.length) return null;
              const over = trouble.filter(b => b.pct >= 1);
              return (
                <Card level="raised" onClick={() => setHomeSection("finance")}
                  style={{ marginBottom:14, borderColor:(over.length?C.negative:C.warning)+"55" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Dot color={over.length ? C.negative : C.warning} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:2 }}>
                        {over.length
                          ? `Over budget on ${over.map(b=>b.cat).join(", ")}`
                          : `Close to your ${trouble.map(b=>b.cat).join(", ")} budget`}
                      </div>
                      <Mono style={{ color:C.muted }}>
                        {over.length
                          ? `${fmtCur(over.reduce((s,b)=>s+(b.spent-b.limit),0), user.currency)} over this month`
                          : `${Math.round(trouble[0].pct*100)}% used with ${fmtCur(trouble[0].left, user.currency)} left`}
                      </Mono>
                    </div>
                    <Mono style={{ color:C.muted, flexShrink:0 }}>›</Mono>
                  </div>
                </Card>
              );
            })()}
            {/* A real recap of the week — finance, appointments and mood together, generated on
                demand rather than pushed. This is the kind of retention loop worth building: it
                reflects something that actually happened, not a manufactured reason to come back. */}
            {dataLoaded && (
              <Card style={{ marginBottom:16 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:weeklyRecap?10:0 }}>
                  <div>
                    <Mono style={{ display:"block", color:C.white, letterSpacing:.8, marginBottom:2 }}>This week</Mono>
                    <Mono style={{ color:C.muted, fontSize:10 }}>
                      {weeklyRecap ? `${weeklyRecap.weekStart} – ${weeklyRecap.weekEnd}` : "See what actually happened this week"}
                    </Mono>
                  </div>
                  <Btn sm v="outline" onClick={generateWeeklyRecap} disabled={generatingRecap}>
                    {generatingRecap ? <><Spinner size={11} color={C.soft} thickness={2} />Generating…</> : weeklyRecap ? "Refresh" : "Generate"}
                  </Btn>
                </div>
                {weeklyRecap && (
                  <>
                    <div style={{ fontSize:13, lineHeight:1.7, color:C.text, marginBottom:10 }}>{weeklyRecap.summary}</div>
                    <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
                      <Mono style={{ color:C.muted }}>Net {fmtCur(weeklyRecap.incTotal-weeklyRecap.expTotal, user.currency)}</Mono>
                      <Mono style={{ color:C.muted }}>{weeklyRecap.apptsCount} appointment{weeklyRecap.apptsCount!==1?"s":""}</Mono>
                      <Mono style={{ color:C.muted }}>{weeklyRecap.openTasks} open task{weeklyRecap.openTasks!==1?"s":""}</Mono>
                    </div>
                  </>
                )}
              </Card>
            )}
            {!dataLoaded ? (
              <><SkeletonCard lines={2} /><SkeletonCard lines={3} /></>
            ) : income.length===0&&expenses.length===0 ? (
              <Card style={{ marginBottom:16, textAlign:"center", padding:24 }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.white, marginBottom:6 }}>No financial data yet</div>
                <Mono style={{ display:"block", color:C.muted, marginBottom:16 }}>Go to Finance to add your first entry.</Mono>
                <Btn sm onClick={() => setHomeSection("finance")}>Go to Finance</Btn>
              </Card>
            ) : (
              <Card style={{ marginBottom:16 }}>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Income vs expenses · last 6 months</Mono>
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart data={monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.cardB} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill:C.muted, fontSize:10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill:C.muted, fontSize:10 }} axisLine={false} tickLine={false} tickFormatter={v=>fmtCur(0,user.currency).replace(/0\.00/,"").trim()+v} />
                    <Tooltip formatter={v=>fmtCur(v,user.currency)} contentStyle={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:12, fontSize:11, color:C.white }} />
                    <Legend wrapperStyle={{ fontSize:10, color:C.muted }} formatter={v=>({income:"Income",expenses:"Expenses",net:"Net"}[v]||v)} />
                    <Bar dataKey="income" fill={C.positive} radius={[4,4,0,0]} opacity={.9} />
                    <Bar dataKey="expenses" fill={C.negative} radius={[4,4,0,0]} opacity={.9} />
                    <Line type="monotone" dataKey="net" stroke={C.accent} strokeWidth={2} dot={{ r:3, fill:C.accent }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:13 }}>
              <Card>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Mood detection</Mono>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
                  {["calm","happy","stressed","angry"].map(m => {
                    const mColor = {calm:C.positive,happy:C.accent,stressed:C.warning,angry:C.negative}[m];
                    const active = mood===m;
                    return (
                    // Keying on the active transition (not just `m`) forces a fresh DOM node the
                    // moment a mood is picked, so its pop-in animation replays every tap — even
                    // tapping the same mood again a moment later, not just the first time.
                    <button key={active ? `${m}-on` : m} onClick={() => applyMood(m)} style={{ background:active?mColor+"22":C.surface, border:`1.5px solid ${active?mColor:C.cardB}`, borderRadius:10, padding:"9px 6px", cursor:"pointer", color:active?mColor:C.soft, fontSize:11, fontWeight:700, textAlign:"center", boxShadow:active?`0 0 12px ${mColor}40`:"none", transition:"all .15s", animation:active?"bouncePop .4s cubic-bezier(.34,1.56,.64,1)":"none" }}>
                      {m.charAt(0).toUpperCase()+m.slice(1)}
                    </button>
                    );
                  })}
                </div>
              </Card>
              <Card>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Next appointment</Mono>
                {appts.length>0 ? (
                  <>
                    <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:4 }}>{appts[0].title}</div>
                    <Mono style={{ display:"block", color:C.soft, marginBottom:2 }}>{appts[0].time} · {fmtDate(appts[0].date)||appts[0].date}</Mono>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:13 }}>{appts[0].location}</Mono>
                    <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
                      <Btn sm onClick={() => remind(appts[0])}>Remind</Btn>
                      <Btn sm v="outline" onClick={() => setUberDest(appts[0])}>Uber</Btn>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign:"center", padding:"12px 0" }}>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:12 }}>No appointments yet.</Mono>
                    <Btn sm onClick={() => { setTab("workspace"); setWorkspaceSection("calendar"); }}>Add one</Btn>
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab==="home" && homeSection==="finance" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Finance</h2>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap", justifyContent:"flex-end" }}>
                <Btn sm onClick={() => { setShowAddInc(v=>!v); setShowAddExp(false); }}>Add Income</Btn>
                <Btn sm v="outline" onClick={() => { setShowAddExp(v=>!v); setShowAddInc(false); }}>Add Expense</Btn>
                <Btn sm v="outline" onClick={exportFinanceCsv}>Export</Btn>
              </div>
            </div>
            {!dataLoaded && <><SkeletonCard lines={2} /><SkeletonCard lines={4} /></>}
            {dataLoaded && (income.length>0||expenses.length>0) && <Mono style={{ display:"block", color:C.muted, marginBottom:14 }}>Tap an entry to edit it. Press and hold for more options.</Mono>}

            {/* Totals add raw amounts, so mixing currencies makes them meaningless. Rather than
                showing a confidently wrong number, say plainly that the figures span currencies. */}
            {(() => {
              const used = new Set([...income, ...expenses].map(e => e.cur || user.currency));
              if (used.size <= 1) return null;
              return (
                <Card level="inset" style={{ marginBottom:14, borderStyle:"dashed", borderColor:C.warning+"66" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:10 }}>
                    <Dot color={C.warning} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12.5, fontWeight:600, color:C.text, marginBottom:2 }}>Mixed currencies</div>
                      <Mono style={{ color:C.muted, lineHeight:1.6 }}>
                        Entries span {[...used].join(", ")}. Totals below add the raw numbers and don't convert between them.
                      </Mono>
                    </div>
                  </div>
                </Card>
              );
            })()}

            {/* Grouped into named sections (Summary / Planning / Transactions / Reports) instead
                of one undifferentiated stack of cards — Net profit and category breakdown lead
                since they're the headline numbers, budgeting tools follow, then the raw ledger,
                then the on-demand report. */}
            {(income.length>0||expenses.length>0) && (
              <>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11 }}>Summary</div>
                {/* Same black-pill hero treatment as the Overview screen's net-profit banner —
                    landing here from that pill should feel like the same number, not a
                    differently-styled one. */}
                <div style={{ display:"flex", alignItems:"center", gap:14, background:C.text, borderRadius:24, padding:"16px 18px", marginBottom:14, boxSizing:"border-box" }}>
                  <div style={{ width:44, height:44, borderRadius:"50%", background:C.card, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                    <NavIcon id={netProfit>=0?"trendUp":"trendDown"} size={19} color={netProfit>=0?C.positive:C.negative} />
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <Mono style={{ display:"block", color:C.card, opacity:.65, marginBottom:2 }}>Net profit</Mono>
                    <div style={{ fontSize:26, fontWeight:700, color:C.card, letterSpacing:-1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fmtCur(netProfit,user.currency)}</div>
                    {totalIncome>0 && <Mono style={{ display:"block", color:C.card, opacity:.55, marginTop:3 }}>Margin: {((netProfit/totalIncome)*100).toFixed(1)}% · {user.currency}</Mono>}
                  </div>
                  <Tag tone={netProfit>=0?"positive":"negative"}>{netProfit>=0?"PROFIT":"DEFICIT"}</Tag>
                </div>
              </>
            )}
            {/* Spending by category. The monthly report already surfaces a top-3 list, but only
                once someone taps Generate and only within the AI text — this is always visible
                and covers every category, not just the three biggest. */}
            {categoryBreakdown.length > 0 && (() => {
              const pieColors = [C.accent, C.positive, C.warning, C.negative, C.soft, C.muted];
              return (
                <Card level="raised" style={{ marginBottom:14 }}>
                  <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Spending by category · this month</Mono>
                  <div style={{ display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
                    <ResponsiveContainer width={140} height={140} style={{ flexShrink:0 }}>
                      <PieChart>
                        <Pie data={categoryBreakdown} dataKey="amt" nameKey="cat" innerRadius={38} outerRadius={62} paddingAngle={2} stroke="none">
                          {categoryBreakdown.map((c, i) => <Cell key={c.cat} fill={pieColors[i % pieColors.length]} />)}
                        </Pie>
                        <Tooltip formatter={(v, n) => [fmtCur(v, user.currency), n]} contentStyle={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:12, fontSize:11, color:C.white }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ flex:1, minWidth:140, display:"flex", flexDirection:"column", gap:7 }}>
                      {categoryBreakdown.slice(0, 6).map((c, i) => (
                        <div key={c.cat} style={{ display:"flex", alignItems:"center", gap:7 }}>
                          <div style={{ width:8, height:8, borderRadius:99, background:pieColors[i % pieColors.length], flexShrink:0 }} />
                          <Mono style={{ color:C.text, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.cat}</Mono>
                          <Mono style={{ color:C.muted, flexShrink:0 }}>{fmtCur(c.amt, user.currency)} · {Math.round(c.pct*100)}%</Mono>
                        </div>
                      ))}
                      {categoryBreakdown.length > 6 && <Mono style={{ color:C.muted }}>+{categoryBreakdown.length - 6} more</Mono>}
                    </div>
                  </div>
                </Card>
              );
            })()}
            {(expenses.length>0 || categoryBreakdown.length>0) && (
              <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11, marginTop:8 }}>Planning</div>
            )}
            {/* Budgets. Shown only once there are expenses to budget against — an empty budget
                card on a fresh account is noise, not guidance. */}
            {expenses.length > 0 && (() => {
              const status = budgetStatus();
              return (
                <Card level="raised" style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:status.length?12:8 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text }}>Monthly budgets</div>
                    <Btn sm v="outline" onClick={() => setShowBudgetEditor(v => !v)}>{showBudgetEditor ? "Done" : status.length ? "Edit" : "Set budgets"}</Btn>
                  </div>

                  {!showBudgetEditor && status.length === 0 && (
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>
                      No budgets set. Add one and KROFT will warn you before a category runs over, not after.
                    </Mono>
                  )}

                  {!showBudgetEditor && status.map(b => {
                    const over = b.pct >= 1, near = b.pct >= 0.8;
                    const barColor = over ? C.negative : near ? C.warning : C.positive;
                    return (
                      <div key={b.cat} style={{ marginBottom:12 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, marginBottom:5 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6, minWidth:0 }}>
                            <div style={{ fontSize:12.5, fontWeight:600, color:C.text }}>{b.cat}</div>
                            {/* Plus: shows the underspend that rolled in from last month, so the
                                higher effective limit doesn't look like an unexplained change. */}
                            {b.carryover > 0 && <Tag tone="positive">+{fmtCur(b.carryover, user.currency)} rolled over</Tag>}
                          </div>
                          <Mono style={{ color:over?C.negative:C.muted, flexShrink:0 }}>
                            {fmtCur(b.spent,user.currency)} / {fmtCur(b.effectiveLimit,user.currency)}
                          </Mono>
                        </div>
                        <div style={{ height:6, borderRadius:99, background:C.fill, overflow:"hidden" }}>
                          {/* Capped at 100% width so a large overspend doesn't render off the card;
                              the figure above still shows the true amount. */}
                          <div style={{ width:`${Math.min(100, b.pct*100)}%`, height:"100%", background:barColor, borderRadius:99, transition:"width .3s" }} />
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between", gap:8, marginTop:4 }}>
                          <Mono style={{ color:C.muted }}>
                            {over ? `${fmtCur(b.spent-b.effectiveLimit,user.currency)} over` : `${fmtCur(b.left,user.currency)} left this month`}
                          </Mono>
                          {/* Pace, not just position. Being at 60% is fine on the 20th and a
                              problem on the 5th — the bar alone can't tell you which. */}
                          {!over && b.willExceed && (
                            <Mono style={{ color:C.warning, flexShrink:0 }}>
                              on track for {fmtCur(b.projected, user.currency)}
                            </Mono>
                          )}
                          {!over && !b.willExceed && b.aheadOfPace && (
                            <Mono style={{ color:C.warning, flexShrink:0 }}>ahead of pace</Mono>
                          )}
                        </div>
                        {/* Nudges a free user toward the feature exactly where it would have
                            helped — right on a category they underspent, not in a settings menu
                            they may never open. */}
                        {!subscribed && !over && b.left > 0 && (
                          <Mono style={{ display:"block", color:C.muted, marginTop:4 }}>
                            KROFT Plus carries this {fmtCur(b.left, user.currency)} into next month instead of resetting it.
                          </Mono>
                        )}
                        {b.committed > 0 && !over && (
                          <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>
                            includes {fmtCur(b.committed, user.currency)} still due this month
                          </Mono>
                        )}
                      </div>
                    );
                  })}

                  {/* Spending in categories with no limit set. Without this the card can read
                      "within budget" while most of the month's money went somewhere untracked —
                      a false all-clear, which is worse than showing nothing at all. */}
                  {!showBudgetEditor && (() => {
                    const month = todayISO().slice(0, 7);
                    const budgeted = new Set(Object.keys(budgets).filter(c => budgets[c] > 0));
                    const untracked = {};
                    expenses.filter(e => (e.date || "").slice(0, 7) === month && !budgeted.has(e.cat))
                            .forEach(e => { untracked[e.cat] = (untracked[e.cat] || 0) + e.amount; });
                    const rows = Object.entries(untracked).sort((a, b) => b[1] - a[1]);
                    if (!rows.length) return null;
                    const total = rows.reduce((s, [, v]) => s + v, 0);
                    return (
                      <div style={{ marginTop:status.length?14:0, paddingTop:status.length?12:0, borderTop:status.length?`1px solid ${C.div}`:"none" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, marginBottom:7 }}>
                          <div style={{ fontSize:12.5, fontWeight:600, color:C.muted }}>Not budgeted</div>
                          <Mono style={{ color:C.muted, flexShrink:0 }}>{fmtCur(total, user.currency)} this month</Mono>
                        </div>
                        {rows.slice(0, 4).map(([cat, amt]) => (
                          <div key={cat} style={{ display:"flex", justifyContent:"space-between", gap:8, padding:"3px 0" }}>
                            <Mono style={{ color:C.soft, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cat}</Mono>
                            <Mono style={{ color:C.soft, flexShrink:0 }}>{fmtCur(amt, user.currency)}</Mono>
                          </div>
                        ))}
                        {rows.length > 4 && <Mono style={{ display:"block", color:C.muted, marginTop:3 }}>+{rows.length - 4} more</Mono>}
                      </div>
                    );
                  })()}

                  {!showBudgetEditor && status.length > 0 && (() => {
                    // A per-category view hides the obvious question: across everything with a
                    // limit, am I within it?
                    const totalLimit = status.reduce((s,b) => s + b.limit, 0);
                    const totalSpent = status.reduce((s,b) => s + b.spent, 0);
                    const totalOver = totalSpent > totalLimit;
                    return (
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, paddingTop:11, borderTop:`1px solid ${C.div}` }}>
                        <div style={{ fontSize:12.5, fontWeight:700, color:C.text }}>Budgeted total</div>
                        <Mono style={{ color:totalOver?C.negative:C.muted, flexShrink:0 }}>
                          {fmtCur(totalSpent,user.currency)} / {fmtCur(totalLimit,user.currency)}
                        </Mono>
                      </div>
                    );
                  })()}

                  {showBudgetEditor && (
                    <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                      {expenseCats.map(cat => (
                        <div key={cat} style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <div style={{ flex:1, fontSize:12.5, color:C.text, minWidth:0 }}>{cat}</div>
                          <Inp type="number" inputMode="decimal" min="0" placeholder="No limit"
                            value={budgets[cat] ?? ""}
                            onChange={e => {
                              const raw = e.target.value;
                              // Empty clears the budget entirely rather than storing 0, which
                              // would read as "limit of zero" and flag the category permanently.
                              setBudgets(p => {
                                if (raw === "") { const { [cat]:_, ...rest } = p; return rest; }
                                const n = parseAmount(raw);
                                return n === null ? p : { ...p, [cat]:n };
                              });
                            }}
                            style={{ width:120, flexShrink:0 }} />
                        </div>
                      ))}
                      {/* Says what an empty field means. A blank limit silently excludes the
                          category from every warning, which isn't obvious from an empty box. */}
                      <Mono style={{ display:"block", color:C.muted, lineHeight:1.6, marginTop:4 }}>
                        Leave blank for no limit — those categories are tracked under "Not budgeted" but never trigger a warning.
                      </Mono>
                    </div>
                  )}
                </Card>
              );
            })()}
            {/* Cash flow forecast. Recurring entries already exist, but nothing surfaced what's
                actually coming due — someone only found out rent posted by seeing it in the list
                after the fact. This looks ahead instead, simulating every future occurrence in
                the window rather than just each template's single next date. */}
            {(income.length>0||expenses.length>0) && (
            <Card level="raised" style={{ marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:upcomingCashFlow.items.length?12:6 }}>
                <Mono style={{ color:C.muted, letterSpacing:.8 }}>Upcoming · next 30 days</Mono>
                {upcomingCashFlow.items.length > 0 && (
                  <Mono style={{ color:upcomingCashFlow.projected>=0?C.positive:C.negative, flexShrink:0 }}>
                    {upcomingCashFlow.projected>=0?"+":""}{fmtCur(upcomingCashFlow.projected, user.currency)} projected
                  </Mono>
                )}
              </div>
              {upcomingCashFlow.items.length === 0 ? (
                <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>
                  Nothing recurring is due in the next 30 days. Set an income or expense entry to repeat and it'll show up here ahead of time.
                </Mono>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                  {upcomingCashFlow.items.slice(0, 6).map(e => (
                    <div key={e.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.label}</div>
                        <Mono style={{ color:C.muted }}>{fmtDate(e.date)} · {e.cat}</Mono>
                      </div>
                      <Mono style={{ color:e.sign==="+"?C.positive:C.negative, fontWeight:700, flexShrink:0 }}>{e.sign}{fmtCur(e.amount, user.currency)}</Mono>
                    </div>
                  ))}
                  {upcomingCashFlow.items.length > 6 && <Mono style={{ color:C.muted, marginTop:2 }}>+{upcomingCashFlow.items.length - 6} more</Mono>}
                </div>
              )}
            </Card>
            )}
            {/* Tax set-aside. Purely a display split of this month's live net profit — nothing is
                actually withheld or moved anywhere; it exists so "profit" doesn't quietly read as
                fully spendable when a chunk of it isn't really the user's to spend. */}
            {(income.length>0||expenses.length>0) && (
              <Card level="raised" style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <Mono style={{ color:C.muted, letterSpacing:.8 }}>Tax set-aside</Mono>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <Inp type="number" inputMode="decimal" min="0" max="100" step="1" value={taxSetAsidePct||""} placeholder="0"
                      onChange={e => {
                        const n = parseFloat(e.target.value);
                        setTaxSetAsidePct(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
                      }}
                      style={{ width:64, padding:"7px 9px", fontSize:12, textAlign:"right" }} />
                    <Mono style={{ color:C.muted }}>% of profit</Mono>
                  </div>
                </div>
                {taxSetAsidePct > 0 ? (
                  thisMonthNet.net > 0 ? (
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                      <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>This month's net</Mono><Mono style={{ color:C.white, fontWeight:700, fontSize:13 }}>{fmtCur(thisMonthNet.net,user.currency)}</Mono></div>
                      <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>Reserved</Mono><Mono style={{ color:C.warning, fontWeight:700, fontSize:13 }}>{fmtCur(thisMonthNet.net*taxSetAsidePct/100,user.currency)}</Mono></div>
                      <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>Spendable</Mono><Mono style={{ color:C.positive, fontWeight:700, fontSize:13 }}>{fmtCur(thisMonthNet.net*(1-taxSetAsidePct/100),user.currency)}</Mono></div>
                    </div>
                  ) : (
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>No profit yet this month to reserve against.</Mono>
                  )
                ) : (
                  <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>
                    Set a percentage and this month's profit splits into what's reserved for taxes and what's actually spendable. Not tax advice — just a running estimate from your own numbers.
                  </Mono>
                )}
              </Card>
            )}
            {(income.length>0||expenses.length>0||showAddInc||showAddExp) && (
              <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11, marginTop:8 }}>Transactions</div>
            )}
            {showAddInc && (
              <AddEntryModal
                kind="income"
                theme={theme}
                value={newInc}
                onChange={setNewInc}
                cats={incomeCats}
                onAddCategory={c => setIncomeCats(p=>p.includes(c)?p:[...p,c])}
                onClose={() => setShowAddInc(false)}
                onSubmit={() => {
                  if (!newInc.label) return;
                  const amt = parseAmount(newInc.amount);
                  if (amt === null) { toast("Enter an amount greater than zero."); return; }
                  const isFirstEverEntry = income.length === 0 && expenses.length === 0;
                  const base = { id:uid(), ...newInc, amount:amt, date:newInc.date||todayISO(), cur:user.currency };
                  // A repeating entry counts as its own first posting, so nextDate starts one
                  // cadence ahead — otherwise the engine would immediately duplicate it.
                  if (base.repeat && base.repeat !== "none") base.nextDate = advanceRepeatDate(base.date, base.repeat);
                  setIncome(p => [...p, base]);
                  setNewInc({label:"",amount:"",cat:"Invoice",date:todayISO(),repeat:"none"}); setShowAddInc(false);
                  if (isFirstEverEntry) { toast("First entry logged — you're on your way."); celebrate(); }
                  else toast(`Income added: ${fmtCur(amt,user.currency)}`);
                }}
              />
            )}
            {showAddExp && (
              <AddEntryModal
                kind="expense"
                theme={theme}
                value={newExp}
                onChange={setNewExp}
                cats={expenseCats}
                onAddCategory={c => setExpenseCats(p=>p.includes(c)?p:[...p,c])}
                onClose={() => setShowAddExp(false)}
                onSubmit={() => {
                  if (!newExp.label) return;
                  const amt = parseAmount(newExp.amount);
                  if (amt === null) { toast("Enter an amount greater than zero."); return; }
                  const isFirstEverEntry = income.length === 0 && expenses.length === 0;
                  const base = { id:uid(), ...newExp, amount:amt, date:newExp.date||todayISO(), cur:user.currency };
                  // A repeating entry counts as its own first posting, so nextDate starts one
                  // cadence ahead — otherwise the engine would immediately duplicate it.
                  if (base.repeat && base.repeat !== "none") base.nextDate = advanceRepeatDate(base.date, base.repeat);
                  setExpenses(p => [...p, base]);
                  setNewExp({label:"",amount:"",cat:"Operations",date:todayISO(),repeat:"none"}); setShowAddExp(false);
                  if (isFirstEverEntry) { toast("First entry logged — you're on your way."); celebrate(); }
                  else toast(`Expense added: ${fmtCur(amt,user.currency)}`);
                }}
              />
            )}
            {income.length===0&&expenses.length===0&&!showAddInc&&!showAddExp && (
              <Card style={{ textAlign:"center", padding:26, marginBottom:14 }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No entries yet</div>
                <Mono style={{ display:"block", color:C.muted, marginBottom:18 }}>Your finance starts at $0.00.</Mono>
                <Btn sm onClick={() => setShowAddInc(true)}>Add First Entry</Btn>
              </Card>
            )}
            {(income.length>0||expenses.length>0) && (
              <>
                {/* Filters both lists below by description/category text and/or an inclusive date
                    range. Purely a view filter — deleting or undoing an entry still operates on
                    the full underlying list (see holdActions), never on this filtered subset. */}
                <Card level="inset" style={{ marginBottom:12 }}>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                    <Inp placeholder="Search description or category…" value={txnQuery} onChange={e=>setTxnQuery(e.target.value)} style={{ flex:2, minWidth:160 }} />
                    <input type="date" value={txnFrom} max={txnTo||undefined} onChange={e=>setTxnFrom(e.target.value)} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                    <input type="date" value={txnTo} min={txnFrom||undefined} max={todayISO()} onChange={e=>setTxnTo(e.target.value)} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                    {txnFilterActive && <Btn sm v="outline" onClick={() => { setTxnQuery(""); setTxnFrom(""); setTxnTo(""); }}>Clear</Btn>}
                  </div>
                </Card>
                <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:12 }}>
                  {[{title:"INCOME",kind:"income",data:income,sign:"+",set:setIncome,cats:incomeCats,setCats:setIncomeCats},{title:"EXPENSES",kind:"expenses",data:expenses,sign:"-",set:setExpenses,cats:expenseCats,setCats:setExpenseCats}].map(({title,kind,data,sign,set,cats,setCats}) => {
                    const filtered = txnFilterActive ? data.filter(matchesTxnFilter) : data;
                    return (
                    <Card key={title} style={{ minWidth:0 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:11 }}>
                        <Mono style={{ color:C.muted, letterSpacing:.8 }}>{title}</Mono>
                        {txnFilterActive && <Mono style={{ color:C.muted }}>{filtered.length} of {data.length}</Mono>}
                      </div>
                      {filtered.length===0 ? <Mono style={{ color:C.soft, display:"block", padding:"8px 0" }}>{txnFilterActive?"No matches.":"None yet."}</Mono> : [...filtered].sort((a,b)=>(b.date||"").localeCompare(a.date||"")).map(r => (
                        editingEntry && editingEntry.kind===kind && editingEntry.id===r.id ? (
                          <div key={r.id} style={{ background:C.surface, border:`1px solid ${C.soft}`, borderRadius:12, padding:"10px 11px", marginBottom:7 }}>
                            <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                              <Inp placeholder="Description" value={editingEntry.label} onChange={e => setEditingEntry(v=>({...v,label:e.target.value}))} style={{ padding:"8px 10px", fontSize:12 }} />
                              <div style={{ display:"flex", gap:7 }}>
                                <Inp placeholder="Amount" type="number" inputMode="decimal" min="0" step="0.01" value={editingEntry.amount} onChange={e => setEditingEntry(v=>({...v,amount:e.target.value}))} style={{ padding:"8px 10px", fontSize:12, flex:1 }} />
                                <input type="date" value={editingEntry.date} max={todayISO()} onChange={e => setEditingEntry(v=>({...v,date:e.target.value}))} style={{ flex:1, background:C.card, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"8px 9px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                              </div>
                              <CategorySelect value={editingEntry.cat} onChange={c => setEditingEntry(v=>({...v,cat:c}))} cats={cats} onAddCategory={c => setCats(p=>p.includes(c)?p:[...p,c])} style={{ padding:"8px 9px", fontSize:11 }} />
                              <div style={{ display:"flex", gap:7 }}>
                                <Btn sm v="outline" onClick={() => setEditingEntry(null)} style={{ flex:1 }}>Cancel</Btn>
                                <Btn sm onClick={() => {
                                  if (!editingEntry.label) return;
                                  const amt = parseAmount(editingEntry.amount);
                                  if (amt === null) { toast("Enter an amount greater than zero."); return; }
                                  set(p=>p.map(x=>x.id===r.id?{...x,label:editingEntry.label,amount:amt,date:editingEntry.date||todayISO(),cat:editingEntry.cat}:x));
                                  setEditingEntry(null); toast("Entry updated.");
                                }} style={{ flex:1 }}>Save</Btn>
                              </div>
                            </div>
                          </div>
                        ) : (
                        <div key={r.id} className="row" {...longPress(() => setActionSheet(holdActions({
                            title: r.label,
                            subtitle: `${sign}${fmtCur(r.amount,user.currency)} · ${r.cat} · ${fmtDate(r.date)}`,
                            onEdit: () => setEditingEntry({ kind, id:r.id, label:r.label, amount:String(r.amount), date:r.date||todayISO(), cat:r.cat }),
                            list: data, setList: set, id: r.id,
                            deletedLabel: "Entry deleted.",
                            confirmText: "Removing this entry changes your totals and monthly report.",
                          })))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 11px", marginBottom:7, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                            <div style={{ minWidth:0, cursor:"pointer" }} onClick={() => setEditingEntry({ kind, id:r.id, label:r.label, amount:String(r.amount), date:r.date||todayISO(), cat:r.cat })}>
                              <Mono style={{ color:C.soft, fontSize:9, letterSpacing:.5, display:"block", marginBottom:3 }}>{fmtDate(r.date)}</Mono>
                              <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.label}</div>
                              <div style={{ marginTop:4, display:"flex", gap:5, flexWrap:"wrap" }}>
                                <Tag>{r.cat}</Tag>
                                {/* The template that generates postings, and the postings it made,
                                    are visually distinct — otherwise a repeating entry looks like
                                    a duplicate the user didn't create. */}
                                {r.repeat && r.repeat !== "none" && <Tag tone="accent">Repeats {r.repeat}</Tag>}
                                {r.fromRecurring && <Tag>Auto</Tag>}
                              </div>
                            </div>
                            <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6, flexShrink:0 }}>
                              <Mono style={{ color:sign==="+"?C.positive:C.negative, fontSize:13, fontWeight:700 }}>{sign}{fmtCur(r.amount, r.cur || user.currency)}</Mono>
                            </div>
                          </div>
                        </div>
                        )
                      ))}
                      <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                        <Mono style={{ color:C.muted }}>{txnFilterActive?"Filtered total":"Total"}</Mono>
                        <Mono style={{ color:C.white, fontWeight:700 }}>{fmtCur(filtered.reduce((s,r)=>s+r.amount,0),user.currency)}</Mono>
                      </div>

                    </Card>
                    );
                  })}
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11, marginTop:8 }}>Reports</div>
                <Card style={{ border:`1px solid ${C.cardB}` }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:monthlyReport?14:0 }}>
                    <div>
                      <Mono style={{ display:"block", color:C.white, letterSpacing:.8, marginBottom:2 }}>Monthly report</Mono>
                      <Mono style={{ color:C.muted, fontSize:10 }}>
                        {monthlyReport ? monthlyReport.month : "See how this month went, with advice"}
                      </Mono>
                    </div>
                    <Btn sm v="outline" onClick={generateMonthlyReport} disabled={generatingReport}>{generatingReport?<><Spinner size={11} color={C.soft} thickness={2} />Generating…</>:monthlyReport?"Refresh":"Generate"}</Btn>
                  </div>
                  {monthlyReport && (
                    <div style={{ animation:"fadeUp .35s ease" }}>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
                        <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>Income</Mono><Mono style={{ color:C.white, fontWeight:700, fontSize:13 }}>{fmtCur(monthlyReport.incTotal,user.currency)}</Mono></div>
                        <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>Expenses</Mono><Mono style={{ color:C.white, fontWeight:700, fontSize:13 }}>{fmtCur(monthlyReport.expTotal,user.currency)}</Mono></div>
                        <div><Mono style={{ color:C.muted, fontSize:9, display:"block" }}>Net</Mono><Mono style={{ color:C.white, fontWeight:700, fontSize:13 }}>{fmtCur(monthlyReport.net,user.currency)}</Mono></div>
                      </div>
                      {monthlyReport.topCats.length>0 && (
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
                          {monthlyReport.topCats.map(([c,v]) => <Tag key={c}>{c} · {fmtCur(v,user.currency)}</Tag>)}
                        </div>
                      )}
                      <div style={{ borderTop:`1px solid ${C.div}`, paddingTop:12 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:8 }}>What the numbers show</div>
                        <div style={{ fontSize:12.5, lineHeight:1.7, color:C.text, whiteSpace:"pre-wrap" }}>{monthlyReport.advice}</div>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", gap:10, marginTop:12, paddingTop:10, borderTop:`1px solid ${C.div}` }}>
                          {/* Generated from the user's own figures by a language model, which can be
                              wrong and isn't qualified to advise. Saying so beside the output is the
                              minimum — labelling it "KROFT'S ADVICE" implied an authority it doesn't
                              have, on exactly the kind of decision where that matters. */}
                          <Mono style={{ color:C.muted, lineHeight:1.6 }}>
                            An automated summary of your own entries, not financial advice. Check anything important with a qualified accountant or advisor.
                          </Mono>
                          {/* Summary only, no figures — unlike the rest of the app, where reading
                              a reply aloud is a deliberate tap and includes whatever's in it. This
                              one strips amounts and percentages specifically, since the advice
                              text embeds real numbers mid-sentence rather than as a separate stat
                              a person could just skip past. */}
                          <button onClick={() => { if (window.speechSynthesis?.speaking) { stopSpeaking(); } else { speak(stripFiguresForSpeech(monthlyReport.advice)); } }} aria-label="Read summary aloud" title="Read aloud (no figures) — tap again to stop"
                            style={{ background:"none", border:"none", padding:4, cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center" }}>
                            <NavIcon id="play" size={15} color={C.muted} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
        )}

        {tab==="workspace" && !workspaceSection && (() => {
          const TOOLS = [
            { k:"calendar", l:"Calendar", count:appts.length, sub:"appointments" },
            { k:"notes", l:"Notes", count:notes.length, sub:"notes" },
            { k:"email", l:"Email", count:emails.filter(e=>!e.read).length, sub:"unread", tone:"accent" },
            { k:"tasks", l:"Tasks", count:tasks.filter(t=>!t.done).length, sub:"active", tone: tasks.filter(t=>!t.done).length>0 ? "warning" : undefined },
            { k:"files", l:"Files", count:files.length, sub:"files" },
            { k:"documents", l:"Documents", count:documents.length, sub:"documents" },
            { k:"projects", l:"Projects", count:projects.filter(p=>p.status==="In Progress").length, sub:"in progress", tone: projects.filter(p=>p.status==="In Progress").length>0 ? "accent" : undefined },
            { k:"memos", l:"Voice Memos", count:voiceMemos.length, sub:"memos" },
            { k:"reminders", l:"Reminders", count:smartReminders.length, sub:"reminders", tone: smartReminders.some(r=>r.aiSuggested) ? "accent" : undefined },
            { k:"contacts", l:"Contacts", count:contacts.length, sub:"saved" },
          ];
          const q = workspaceSearch.trim().toLowerCase();
          const searching = q.length > 0;
          const matches = searching ? TOOLS.filter(t => t.l.toLowerCase().includes(q)) : [];
          // Tools carrying a tone (unread mail, active tasks, in-progress projects, an
          // AI-suggested reminder) surface first as "Needs attention" — real signals worth
          // acting on, not just an arbitrary "quick access" shortlist. Everything else follows
          // in one full grid; nothing is hidden behind a "show more" click anymore.
          const attention = !searching ? TOOLS.filter(t => t.tone) : [];
          const rest = !searching ? TOOLS.filter(t => !t.tone) : [];
          const toneColors = { positive:C.positive, negative:C.negative, warning:C.warning, accent:C.accent };
          const toneBgs = { positive:C.positiveBg, negative:C.negativeBg, warning:C.warningBg, accent:C.accentBg };

          // Search looks inside the workspace's actual content, not just the tool names —
          // typing "invoice" should surface the note, task or contact called that, rather than
          // returning nothing because no tool happens to be named "Invoice". Each hit carries
          // the section it lives in so tapping it opens the right screen.
          const hit = (s, ...fields) => fields.some(f => (f||"").toLowerCase().includes(s));
          const contentHits = !searching ? [] : [
            ...notes.filter(n => hit(q, n.title, n.body)).map(n => ({ id:"note"+n.id, section:"notes", kind:"Note", label:n.title || "Untitled note", detail:(n.body||"").slice(0,60) })),
            ...tasks.filter(t => hit(q, t.title)).map(t => ({ id:"task"+t.id, section:"tasks", kind:"Task", label:t.title, detail:t.done?"Done":t.priority })),
            ...appts.filter(a => hit(q, a.title, a.location, a.notes)).map(a => ({ id:"appt"+a.id, section:"calendar", kind:"Appointment", label:a.title, detail:[a.time, fmtDate(a.date)].filter(Boolean).join(", ") })),
            ...contacts.filter(c => hit(q, c.name, c.email, c.phone)).map(c => ({ id:"contact"+c.id, section:"contacts", kind:"Contact", label:c.name, detail:c.email || c.phone })),
            ...smartReminders.filter(r => hit(q, r.text)).map(r => ({ id:"rem"+r.id, section:"reminders", kind:"Reminder", label:r.text, detail:r.when })),
            ...documents.filter(d => hit(q, d.title, d.body)).map(d => ({ id:"doc"+d.id, section:"documents", kind:"Document", label:d.title || "Untitled", detail:(d.body||"").slice(0,60) })),
            ...projects.filter(p => hit(q, p.name, p.description)).map(p => ({ id:"proj"+p.id, section:"projects", kind:"Project", label:p.name, detail:p.status })),
            ...files.filter(f => hit(q, f.name)).map(f => ({ id:"file"+f.id, section:"files", kind:"File", label:f.name, detail:f.date })),
            ...emails.filter(e => hit(q, e.subject, e.from, e.body)).map(e => ({ id:"mail"+e.id, section:"email", kind:"Email", label:e.subject, detail:e.from })),
            ...voiceMemos.filter(m => hit(q, m.title, m.transcript)).map(m => ({ id:"memo"+m.id, section:"memos", kind:"Voice memo", label:m.title || "Untitled memo", detail:(m.transcript||"").slice(0,60) })),
          ].slice(0, 20);

          const ToolCard = ({ t }) => (
            <Card key={t.k} onClick={() => { setWorkspaceSection(t.k); setWorkspaceSearch(""); }} style={{ cursor:"pointer", minWidth:0 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                {/* Circular, matching the icon badges on Overview/Finance now — this grid was
                    the one place still using a rounded-square badge. */}
                <div style={{ width:36, height:36, borderRadius:"50%", background:t.tone?toneBgs[t.tone]:C.surface, border:`1px solid ${t.tone?toneColors[t.tone]+"55":C.cardB}`, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:10, flexShrink:0 }}>
                  <NavIcon id={t.k} size={17} color={t.tone?toneColors[t.tone]:C.white} />
                </div>
                {t.count>0 && <Tag tone={t.tone} style={{ whiteSpace:"normal", textAlign:"right", maxWidth:"70%", boxSizing:"border-box", lineHeight:1.4 }}>{t.count} {t.sub}</Tag>}
              </div>
              <div style={{ fontSize:14, fontWeight:700, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.l}</div>
              {t.count===0 && <Mono style={{ color:C.soft, display:"block", marginTop:2 }}>Nothing yet</Mono>}
            </Card>
          );

          return (
            <div style={{ animation:"fadeUp .35s ease" }}>
              <Inp placeholder="Search your workspace…" value={workspaceSearch} onChange={e=>setWorkspaceSearch(e.target.value)} style={{ marginBottom:18, width:"100%", boxSizing:"border-box" }} />
              {searching && matches.length===0 && contentHits.length===0 && (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>Nothing matches "{workspaceSearch}"</div>
                  <Mono style={{ display:"block", color:C.soft }}>Try a different word, or open a tool below to add something.</Mono>
                </Card>
              )}
              {searching && matches.length > 0 && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:contentHits.length?18:0 }}>
                  {matches.map(t => <ToolCard key={t.k} t={t} />)}
                </div>
              )}
              {contentHits.length > 0 && (
                <>
                  <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11 }}>
                    {contentHits.length} {contentHits.length===1?"result":"results"} in your workspace
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {contentHits.map(r => (
                      <Card key={r.id} level="inset" onClick={() => { setWorkspaceSection(r.section); setWorkspaceSearch(""); }} style={{ display:"flex", alignItems:"center", gap:11 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.label}</div>
                          {r.detail && <Mono style={{ color:C.muted, display:"block", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.detail}</Mono>}
                        </div>
                        <Tag style={{ flexShrink:0 }}>{r.kind}</Tag>
                      </Card>
                    ))}
                  </div>
                </>
              )}
              {!searching && attention.length > 0 && (
                <>
                  <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11 }}>Needs attention</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:22 }}>
                    {attention.map(t => <ToolCard key={t.k} t={t} />)}
                  </div>
                </>
              )}
              {!searching && (
                <>
                  <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:11 }}>
                    {attention.length > 0 ? "All tools" : "Your tools"}
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11 }}>
                    {rest.map(t => <ToolCard key={t.k} t={t} />)}
                  </div>
                </>
              )}
            </div>
          );
        })()}

        {tab==="workspace" && workspaceSection==="calendar" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Calendar</h2>
              <div style={{ display:"flex", alignItems:"center", gap:9, flexWrap:"wrap", justifyContent:"flex-end" }}>
                {(googleStatus.calendar || microsoftStatus.calendar) && <Btn sm v="outline" disabled={syncingCalendar} onClick={syncCalendar}>{syncingCalendar ? <Spinner size={14} color={C.soft} thickness={2} /> : "Refresh"}</Btn>}
                <Btn sm onClick={() => setShowAddAppt(v=>!v)}>Add Appointment</Btn>
              </div>
            </div>
            <div style={{ display:"flex", gap:7, marginBottom:16 }}>
              {[{k:"list",l:"List"},{k:"grid",l:"Month"}].map(v => (
                <button key={v.k} onClick={() => setCalendarView(v.k)} style={{ background:calendarView===v.k?"rgba(255,255,255,.1)":"transparent", border:`1px solid ${calendarView===v.k?C.border:C.cardB}`, borderRadius:20, padding:"6px 14px", cursor:"pointer", color:calendarView===v.k?C.white:C.muted, fontSize:11, fontWeight:700 }}>
                  {v.l}
                </button>
              ))}
            </div>
            {calendarView==="grid" && (
              <Card style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <button onClick={() => { const [y,m] = calendarMonth.split("-").map(Number); const d = new Date(y, m-2, 1); setCalendarMonth(d.toISOString().slice(0,7)); }} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:16, padding:4 }}>‹</button>
                  <Mono style={{ color:C.white, fontWeight:700, fontSize:12, letterSpacing:.5 }}>{monthLabel(calendarMonth+"-01")}</Mono>
                  <button onClick={() => { const [y,m] = calendarMonth.split("-").map(Number); const d = new Date(y, m, 1); setCalendarMonth(d.toISOString().slice(0,7)); }} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:16, padding:4 }}>›</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:6 }}>
                  {["S","M","T","W","T","F","S"].map((d,i) => <Mono key={i} style={{ textAlign:"center", color:C.muted, fontSize:9 }}>{d}</Mono>)}
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {calendarWeeks.map((week, wi) => (
                    <div key={wi} style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4 }}>
                      {week.map(cell => {
                        const count = (apptsByDate[cell.date]||[]).length;
                        const isToday = cell.date === todayISO();
                        const isSelected = cell.date === calendarSelectedDate;
                        return (
                          <button key={cell.date} disabled={!cell.inMonth}
                            onClick={() => setCalendarSelectedDate(prev => prev===cell.date ? null : cell.date)}
                            style={{ aspectRatio:"1", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, borderRadius:9, border:isSelected?`1.5px solid ${C.white}`:isToday?`1px solid ${C.soft}`:"1px solid transparent", background:isSelected?"rgba(255,255,255,.12)":"transparent", cursor:cell.inMonth?"pointer":"default", opacity:cell.inMonth?1:.28 }}>
                            <Mono style={{ color:isToday?C.white:C.text, fontWeight:isToday?700:400, fontSize:11 }}>{cell.day}</Mono>
                            {count>0 && <div style={{ width:4, height:4, borderRadius:99, background:C.accent }} />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {calendarSelectedDate && (
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:12, paddingTop:10, borderTop:`1px solid ${C.div}` }}>
                    <Mono style={{ color:C.muted }}>{fmtDate(calendarSelectedDate)} · {(apptsByDate[calendarSelectedDate]||[]).length} appointment{(apptsByDate[calendarSelectedDate]||[]).length!==1?"s":""}</Mono>
                    <Mono style={{ color:C.muted, cursor:"pointer", textDecoration:"underline" }} onClick={() => setCalendarSelectedDate(null)}>Show all</Mono>
                  </div>
                )}
              </Card>
            )}
            {showAddAppt && (
              <Card style={{ marginBottom:14, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:12 }}>New appointment</div>
                <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                  <div style={{ display:"flex", gap:8 }}><Inp placeholder="Title *" value={newAppt.title} onChange={e=>setNewAppt(v=>({...v,title:e.target.value}))} style={{ flex:2 }} /><Inp placeholder="Time e.g. 4:00 PM" value={newAppt.time} onChange={e=>setNewAppt(v=>({...v,time:e.target.value}))} style={{ flex:1 }} /></div>
                  <div style={{ display:"flex", gap:8 }}><input type="date" value={newAppt.date||todayISO()} onChange={e=>setNewAppt(v=>({...v,date:e.target.value}))} style={{ flex:1, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} /><Inp placeholder="Location" value={newAppt.location} onChange={e=>setNewAppt(v=>({...v,location:e.target.value}))} style={{ flex:1 }} /></div>
                  <Inp placeholder="Notes (optional)" value={newAppt.notes} onChange={e=>setNewAppt(v=>({...v,notes:e.target.value}))} />
                  <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                    <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}><input type="checkbox" checked={newAppt.urgent} onChange={e=>setNewAppt(v=>({...v,urgent:e.target.checked}))} style={{ accentColor:C.white, width:14, height:14 }} /><Mono style={{ color:C.soft }}>Urgent</Mono></label>
                    <select value={newAppt.repeat} onChange={e=>setNewAppt(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>{["none","daily","weekly","monthly"].map(r=><option key={r}>{r}</option>)}</select>
                    {contacts.length > 0 && <ContactSelect value={newAppt.contactId} onChange={id=>setNewAppt(v=>({...v,contactId:id}))} contacts={contacts} />}
                    <Btn sm onClick={() => { if (!newAppt.title||!newAppt.date) return; const item = {...newAppt,id:uid()}; setAppts(p=>[...p,item]); mirrorAppointmentToCalendars(item); setNewAppt({title:"",time:"",date:todayISO(),location:"",notes:"",urgent:false,repeat:"none",contactId:null}); setShowAddAppt(false); toast(`Appointment added: ${newAppt.title}`); }}>Add</Btn>
                  </div>
                </div>
              </Card>
            )}
            {appts.length===0&&!showAddAppt && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No appointments yet</div>
                <Mono style={{ display:"block", color:C.muted, marginBottom:18 }}>Add your meetings, calls, and events.</Mono>
                <Btn sm onClick={() => setShowAddAppt(true)}>Add First Appointment</Btn>
              </Card>
            )}
            {appts.length>0 && calendarView==="grid" && calendarSelectedDate && (apptsByDate[calendarSelectedDate]||[]).length===0 && (
              <Card level="inset" style={{ textAlign:"center", padding:20, borderStyle:"dashed", marginBottom:11 }}>
                <Mono style={{ color:C.soft }}>Nothing on {fmtDate(calendarSelectedDate)}.</Mono>
              </Card>
            )}
            {/* In grid view, picking a date narrows this same list down to just that day instead
                of duplicating the row markup in a separate place. */}
            {(calendarView==="grid" && calendarSelectedDate ? appts.filter(a=>a.date===calendarSelectedDate) : appts)
              .slice().sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.time||"").localeCompare(b.time||"")).map(a => (
              editingAppt && editingAppt.id===a.id ? (
                <Card key={a.id} style={{ marginBottom:11, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit appointment</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                    <div style={{ display:"flex", gap:8 }}><Inp placeholder="Title *" value={editingAppt.title} onChange={e=>setEditingAppt(v=>({...v,title:e.target.value}))} style={{ flex:2 }} /><Inp placeholder="Time e.g. 4:00 PM" value={editingAppt.time} onChange={e=>setEditingAppt(v=>({...v,time:e.target.value}))} style={{ flex:1 }} /></div>
                    <div style={{ display:"flex", gap:8 }}><input type="date" value={editingAppt.date||todayISO()} onChange={e=>setEditingAppt(v=>({...v,date:e.target.value}))} style={{ flex:1, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} /><Inp placeholder="Location" value={editingAppt.location} onChange={e=>setEditingAppt(v=>({...v,location:e.target.value}))} style={{ flex:1 }} /></div>
                    <Inp placeholder="Notes (optional)" value={editingAppt.notes} onChange={e=>setEditingAppt(v=>({...v,notes:e.target.value}))} />
                    <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                      <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}><input type="checkbox" checked={editingAppt.urgent} onChange={e=>setEditingAppt(v=>({...v,urgent:e.target.checked}))} style={{ accentColor:C.white, width:14, height:14 }} /><Mono style={{ color:C.soft }}>Urgent</Mono></label>
                      <select value={editingAppt.repeat} onChange={e=>setEditingAppt(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>{["none","daily","weekly","monthly"].map(r=><option key={r}>{r}</option>)}</select>
                      {contacts.length > 0 && <ContactSelect value={editingAppt.contactId} onChange={id=>setEditingAppt(v=>({...v,contactId:id}))} contacts={contacts} />}
                    </div>
                    <div style={{ display:"flex", gap:8 }}>
                      <Btn sm v="outline" onClick={() => setEditingAppt(null)} style={{ flex:1 }}>Cancel</Btn>
                      <Btn sm onClick={() => { if (!editingAppt.title||!editingAppt.date) return; setAppts(p=>p.map(x=>x.id===a.id?editingAppt:x)); setEditingAppt(null); toast("Appointment updated."); }} style={{ flex:1 }}>Save</Btn>
                    </div>
                  </div>
                </Card>
              ) : (
              <Card key={a.id} {...longPress(() => setActionSheet(holdActions({ title:a.title, subtitle:[a.time, fmtDate(a.date)].filter(Boolean).join(", "), onEdit:() => setEditingAppt({...a}), list:appts, setList:setAppts, id:a.id, deletedLabel:"Appointment deleted." })))} style={{ marginBottom:11, borderRadius:16, background:a.urgent?C.negative+"0d":C.card, border:`1px solid ${a.urgent?C.negative+"33":C.cardB}`, cursor:"pointer", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }} onClick={() => setOpenAppt(openAppt===a.id?null:a.id)}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap" }}>
                      <span style={{ fontWeight:700, fontSize:14, color:C.white }}>{a.title}</span>
                      {a.urgent && <Tag tone="negative">URGENT</Tag>}
                      {a.repeat!=="none" && <Tag>{a.repeat}</Tag>}
                      {a.contactId && contacts.find(c=>c.id===a.contactId) && <Tag tone="accent">{contacts.find(c=>c.id===a.contactId).name}</Tag>}
                    </div>
                    <Mono style={{ display:"block", color:C.soft, marginBottom:2 }}>{a.time} · {fmtDate(a.date)||a.date}</Mono>
                    {a.location && <Mono style={{ display:"block", color:C.muted }}>{a.location}</Mono>}
                    {openAppt===a.id&&a.notes && <div style={{ marginTop:10, padding:"10px 12px", background:C.surface, borderRadius:8 }}><Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>Notes</Mono><div style={{ fontSize:12, color:C.soft, lineHeight:1.65 }}>{a.notes}</div></div>}
                  </div>
                  <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
                    {a.contactId && contacts.find(c=>c.id===a.contactId)?.phone && <Btn sm v="outline" onClick={e=>{e.stopPropagation();window.location.href=`tel:${contacts.find(c=>c.id===a.contactId).phone}`;}}>Call</Btn>}
                    {a.contactId && contacts.find(c=>c.id===a.contactId)?.email && <Btn sm v="outline" onClick={e=>{e.stopPropagation();setComposeDraft({to:contacts.find(c=>c.id===a.contactId).email,subject:a.title,body:""});}}>Email</Btn>}
                    <Btn sm onClick={e=>{e.stopPropagation();remind(a);}}>Remind</Btn>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();setUberDest(a);}}>Uber</Btn>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();setTab("nova");setAiInput(`Prepare me for: "${a.title}"`)}}>Prep</Btn>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();setEditingAppt({...a});}}>Edit</Btn>
                  </div>
                </div>
              </Card>
              )
            ))}
          </div>
        )}

        {tab==="workspace" && workspaceSection==="email" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Email</h2>
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                {(() => {
                  const mailConnected = googleStatus.gmail || microsoftStatus.mail;
                  const label = googleStatus.gmail && microsoftStatus.mail ? "Gmail + Outlook connected" : googleStatus.gmail ? "Gmail connected" : microsoftStatus.mail ? "Outlook connected" : "No email connected";
                  return <Tag tone={mailConnected?"positive":undefined}>{label}</Tag>;
                })()}
                {(googleStatus.gmail || microsoftStatus.mail) && <Btn sm v="outline" disabled={syncingMail} onClick={syncMail}>{syncingMail ? <Spinner size={14} color={C.soft} thickness={2} /> : "Refresh"}</Btn>}
                {contacts.some(c => c.email) && <Btn sm v="outline" onClick={() => setContactPicker({ mode:"email" })}>From Contacts</Btn>}
                <Btn sm onClick={() => setComposeDraft({to:"",subject:"",body:""})}>Compose</Btn>
              </div>
            </div>
            {emails.length===0 && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>{(googleStatus.gmail || microsoftStatus.mail) ? "Inbox is empty" : "No email connected"}</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>{(googleStatus.gmail || microsoftStatus.mail) ? "Nothing here right now — compose a new email to get started." : "Connect Gmail or Outlook to let KROFT organize your inbox."}</Mono>
                <div style={{ display:"flex", gap:9, justifyContent:"center" }}>
                  <Btn sm onClick={() => setComposeDraft({to:"",subject:"",body:""})}>Compose Email</Btn>
                  {!(googleStatus.gmail || microsoftStatus.mail) && <Btn sm v="outline" onClick={() => { setEditingFromProfile(true); setStep("prefs"); }}>Connect Email</Btn>}
                </div>
              </Card>
            )}
            {[...emails].sort((a,b)=>(a.read===b.read)?(b.id-a.id):a.read?1:-1).map(e => (
              <Card key={e.id} className="row" {...longPress(() => setActionSheet(holdActions({ title:e.subject, subtitle:e.from, list:emails, setList:setEmails, id:e.id, deletedLabel:"Email deleted." })))} style={{ marginBottom:10, borderRadius:16, background:!e.read?C.accentBg:C.card, border:`1px solid ${!e.read?C.accent+"33":C.cardB}`, cursor:"pointer", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }} onClick={() => { setOpenEmail(openEmail===e.id?null:e.id); if (openEmail!==e.id) setEmails(p=>p.map(x=>x.id===e.id?{...x,read:true}:x)); }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:11 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4, flexWrap:"wrap" }}>
                      {!e.read && <Dot color={C.accent} />}
                      <span style={{ fontWeight:700, fontSize:13, color:C.white }}>{e.subject}</span>
                      {e.tag && <Tag>{e.tag}</Tag>}
                      <Mono style={{ color:C.soft, marginLeft:"auto" }}>{e.time}</Mono>
                    </div>
                    <Mono style={{ display:"block", color:C.soft, marginBottom:4 }}>From: {e.from}</Mono>
                    {openEmail===e.id ? <div style={{ fontSize:12, color:C.soft, lineHeight:1.7, marginTop:8, padding:"10px 12px", background:C.surface, borderRadius:8 }}>{e.body}</div> : <div style={{ fontSize:11, color:C.soft, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:360 }}>{e.body}</div>}
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:6, flexShrink:0 }}>
                    <Btn sm onClick={ev=>{ev.stopPropagation();speak(e.body);toast("Reading aloud…")}}>Read</Btn>
                    <Btn sm v="outline" onClick={ev=>{ev.stopPropagation();setComposeDraft({to:e.from,subject:"Re: "+e.subject,body:"",provider:e.source})}}>Reply</Btn>
                    <Btn sm v="outline" onClick={ev=>{ev.stopPropagation();aiDraftReply(e)}}>AI Draft</Btn>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* ── WORKSPACE: NOTES ── */}
        {tab==="workspace" && workspaceSection==="notes" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Notes</h2>
              <Btn sm onClick={() => setShowAddNote(v=>!v)}>+ New Note</Btn>
            </div>
            {showAddNote && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New note</div>
                <Inp placeholder="Title" value={newNote.title} onChange={e=>setNewNote(v=>({...v,title:e.target.value}))} style={{ marginBottom:9 }} />
                <div style={{ display:"flex", gap:7, marginBottom:9 }}>
                  {[{checklist:false,l:"Text"},{checklist:true,l:"Checklist"}].map(o => (
                    <button key={o.l} onClick={() => setNewNote(v=>({...v, checklist:o.checklist?(v.checklist||[]):null}))} style={{ flex:1, padding:"7px 10px", borderRadius:9, border:`1px solid ${!!newNote.checklist===o.checklist?C.white:C.cardB}`, background:!!newNote.checklist===o.checklist?"rgba(255,255,255,.1)":"transparent", color:!!newNote.checklist===o.checklist?C.white:C.muted, cursor:"pointer", fontSize:11, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>{o.l}</button>
                  ))}
                </div>
                {Array.isArray(newNote.checklist) ? (
                  <div style={{ marginBottom:10 }}>
                    {newNote.checklist.map((item,i) => (
                      <div key={item.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0" }}>
                        <div style={{ width:14, height:14, borderRadius:4, border:`1.5px solid ${C.soft}`, flexShrink:0 }} />
                        <Inp value={item.text} onChange={e=>setNewNote(v=>({...v,checklist:v.checklist.map((it,ix)=>ix===i?{...it,text:e.target.value}:it)}))} placeholder="List item" style={{ flex:1, padding:"7px 10px" }} />
                        <button onClick={()=>setNewNote(v=>({...v,checklist:v.checklist.filter((_,ix)=>ix!==i)}))} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:13, padding:"0 2px" }}>✕</button>
                      </div>
                    ))}
                    <div style={{ display:"flex", gap:7, marginTop:6 }}>
                      <Inp placeholder="Add item" value={newNoteChecklistDraft} onChange={e=>setNewNoteChecklistDraft(e.target.value)} onKeyDown={e=>{ if (e.key==="Enter") { e.preventDefault(); if (!newNoteChecklistDraft.trim()) return; setNewNote(v=>({...v,checklist:[...v.checklist,{id:uid(),text:newNoteChecklistDraft.trim(),done:false}]})); setNewNoteChecklistDraft(""); } }} style={{ flex:1 }} />
                      <Btn sm v="outline" onClick={() => { if (!newNoteChecklistDraft.trim()) return; setNewNote(v=>({...v,checklist:[...v.checklist,{id:uid(),text:newNoteChecklistDraft.trim(),done:false}]})); setNewNoteChecklistDraft(""); }}>Add item</Btn>
                    </div>
                  </div>
                ) : (
                  <textarea placeholder="Write your note, checklist, or idea…" value={newNote.body} onChange={e=>setNewNote(v=>({...v,body:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }} />
                )}
                <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                  <Btn sm v="outline" onClick={toggleListen}>{listening ? "Stop" : "Voice"}</Btn>
                  {contacts.length > 0 && <ContactSelect value={newNote.contactId} onChange={id=>setNewNote(v=>({...v,contactId:id}))} contacts={contacts} />}
                  <Btn sm onClick={() => {
                    const hasChecklist = Array.isArray(newNote.checklist) && newNote.checklist.length>0;
                    if (!newNote.title.trim() && !newNote.body.trim() && !hasChecklist) return;
                    setNotes(p=>[{id:uid(),...newNote,date:dateStr()},...p]);
                    setNewNote({title:"",body:"",contactId:null,checklist:null}); setNewNoteChecklistDraft("");
                    setShowAddNote(false); toast("Note saved.");
                  }}>Save Note</Btn>
                </div>
              </Card>
            )}
            {dataLoaded && notes.length===0 && !showAddNote && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No notes yet</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Capture ideas instantly with text or voice.</Mono>
                <Btn sm onClick={() => setShowAddNote(true)}>+ New Note</Btn>
              </Card>
            )}
            {/* Pinned notes float to the top (stable sort keeps everything else in its existing
                order), same "surface what matters" idea as Tasks/Projects sorting by what's
                actually pressing rather than just insertion order. */}
            {[...notes].sort((a,b) => (b.pinned?1:0)-(a.pinned?1:0)).map(n => (
              editingNote && editingNote.id===n.id ? (
                <Card key={n.id} style={{ marginBottom:10, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit note</div>
                  <Inp placeholder="Title" value={editingNote.title} onChange={e=>setEditingNote(v=>({...v,title:e.target.value}))} style={{ marginBottom:9 }} />
                  <div style={{ display:"flex", gap:7, marginBottom:9 }}>
                    {[{checklist:false,l:"Text"},{checklist:true,l:"Checklist"}].map(o => (
                      <button key={o.l} onClick={() => setEditingNote(v=>({...v, checklist:o.checklist?(v.checklist||[]):null}))} style={{ flex:1, padding:"7px 10px", borderRadius:9, border:`1px solid ${!!editingNote.checklist===o.checklist?C.white:C.cardB}`, background:!!editingNote.checklist===o.checklist?"rgba(255,255,255,.1)":"transparent", color:!!editingNote.checklist===o.checklist?C.white:C.muted, cursor:"pointer", fontSize:11, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>{o.l}</button>
                    ))}
                  </div>
                  {Array.isArray(editingNote.checklist) ? (
                    <div style={{ marginBottom:10 }}>
                      {editingNote.checklist.map((item,i) => (
                        <div key={item.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0" }}>
                          <button onClick={()=>setEditingNote(v=>({...v,checklist:v.checklist.map((it,ix)=>ix===i?{...it,done:!it.done}:it)}))} style={{ width:14, height:14, borderRadius:4, border:`1.5px solid ${item.done?C.white:C.soft}`, background:item.done?C.white:"transparent", cursor:"pointer", flexShrink:0, padding:0 }} />
                          <Inp value={item.text} onChange={e=>setEditingNote(v=>({...v,checklist:v.checklist.map((it,ix)=>ix===i?{...it,text:e.target.value}:it)}))} placeholder="List item" style={{ flex:1, padding:"7px 10px" }} />
                          <button onClick={()=>setEditingNote(v=>({...v,checklist:v.checklist.filter((_,ix)=>ix!==i)}))} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:13, padding:"0 2px" }}>✕</button>
                        </div>
                      ))}
                      <div style={{ display:"flex", gap:7, marginTop:6 }}>
                        <Inp placeholder="Add item" value={editNoteChecklistDraft} onChange={e=>setEditNoteChecklistDraft(e.target.value)} onKeyDown={e=>{ if (e.key==="Enter") { e.preventDefault(); if (!editNoteChecklistDraft.trim()) return; setEditingNote(v=>({...v,checklist:[...v.checklist,{id:uid(),text:editNoteChecklistDraft.trim(),done:false}]})); setEditNoteChecklistDraft(""); } }} style={{ flex:1 }} />
                        <Btn sm v="outline" onClick={() => { if (!editNoteChecklistDraft.trim()) return; setEditingNote(v=>({...v,checklist:[...v.checklist,{id:uid(),text:editNoteChecklistDraft.trim(),done:false}]})); setEditNoteChecklistDraft(""); }}>Add item</Btn>
                      </div>
                    </div>
                  ) : (
                    <textarea placeholder="Write your note, checklist, or idea…" value={editingNote.body} onChange={e=>setEditingNote(v=>({...v,body:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }} />
                  )}
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                    <Btn sm v="outline" onClick={() => { setEditingNote(null); setEditNoteChecklistDraft(""); }} style={{ flex:1 }}>Cancel</Btn>
                    {contacts.length > 0 && <ContactSelect value={editingNote.contactId} onChange={id=>setEditingNote(v=>({...v,contactId:id}))} contacts={contacts} />}
                    <Btn sm onClick={() => {
                      const hasChecklist = Array.isArray(editingNote.checklist) && editingNote.checklist.length>0;
                      if (!editingNote.title.trim() && !editingNote.body.trim() && !hasChecklist) return;
                      setNotes(p=>p.map(x=>x.id===n.id?editingNote:x)); setEditingNote(null); setEditNoteChecklistDraft(""); toast("Note updated.");
                    }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </Card>
              ) : (
              <Card key={n.id} {...longPress(() => setActionSheet(holdActions({ title:n.title || "Untitled note", subtitle:n.date, onEdit:() => setEditingNote({...n}), list:notes, setList:setNotes, id:n.id, deletedLabel:"Note deleted." })))} style={{ marginBottom:10, cursor:"pointer", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }} onClick={() => setOpenNote(openNote===n.id?null:n.id)}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:11 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                      {n.pinned && <NavIcon id="pin" size={11} color={C.accent} />}
                      <div style={{ fontWeight:700, fontSize:13, color:C.white }}>{n.title || "Untitled note"}</div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap" }}>
                      <Mono style={{ color:C.soft }}>{n.date}</Mono>
                      {Array.isArray(n.checklist) && n.checklist.length>0 && <Mono style={{ color:C.soft }}>· {n.checklist.filter(i=>i.done).length}/{n.checklist.length}</Mono>}
                      {n.contactId && contacts.find(c=>c.id===n.contactId) && <Tag tone="accent">{contacts.find(c=>c.id===n.contactId).name}</Tag>}
                    </div>
                    {Array.isArray(n.checklist) ? (
                      <div onClick={e=>e.stopPropagation()}>
                        {(openNote===n.id ? n.checklist : n.checklist.slice(0,3)).map(item => (
                          <div key={item.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 0" }}>
                            <button onClick={()=>toggleNoteChecklistItem(n.id,item.id)} style={{ width:14, height:14, borderRadius:4, border:`1.5px solid ${item.done?C.accent:C.soft}`, background:item.done?C.accent:"transparent", cursor:"pointer", flexShrink:0, padding:0 }} />
                            <div style={{ fontSize:12, color:C.soft, textDecoration:item.done?"line-through":"none", opacity:item.done?.6:1 }}>{item.text}</div>
                          </div>
                        ))}
                        {openNote!==n.id && n.checklist.length>3 && <Mono style={{ color:C.muted, display:"block", marginTop:2 }}>+{n.checklist.length-3} more</Mono>}
                      </div>
                    ) : (
                      <div style={{ fontSize:12, color:C.soft, lineHeight:1.6, whiteSpace:openNote===n.id?"pre-wrap":"nowrap", overflow:openNote===n.id?"visible":"hidden", textOverflow:"ellipsis" }}>{n.body}</div>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();toggleNotePinned(n.id);}}>{n.pinned?"Unpin":"Pin"}</Btn>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();shareContent({title:n.title||"Note",text:Array.isArray(n.checklist)?`${n.title||"Note"}\n\n${n.checklist.map(i=>`${i.done?"✓":"○"} ${i.text}`).join("\n")}`:`${n.title||"Note"}\n\n${n.body}`});}}>Share</Btn>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();setEditingNote({...n});}}>Edit</Btn>
                  </div>
                </div>
              </Card>
              )
            ))}
          </div>
        )}

        {/* ── WORKSPACE: TASKS ── */}
        {tab==="workspace" && workspaceSection==="tasks" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Tasks</h2>
              <Btn sm onClick={() => setShowAddTask(v=>!v)}>+ Add Task</Btn>
            </div>
            {showAddTask && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New task</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <Inp placeholder="What needs to get done?" value={newTask.title} onChange={e=>setNewTask(v=>({...v,title:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                  <select value={newTask.priority} onChange={e=>setNewTask(v=>({...v,priority:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                    {["Low","Normal","High","Urgent"].map(p => <option key={p}>{p}</option>)}
                  </select>
                  <input type="date" value={newTask.dueDate} onChange={e=>setNewTask(v=>({...v,dueDate:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                  <select value={newTask.repeat} onChange={e=>setNewTask(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                    {["none","daily","weekly","monthly"].map(r => <option key={r}>{r}</option>)}
                  </select>
                  {contacts.length > 0 && <ContactSelect value={newTask.contactId} onChange={id=>setNewTask(v=>({...v,contactId:id}))} contacts={contacts} />}
                  <Btn onClick={() => { if (!newTask.title.trim()) return; setTasks(p=>[{id:uid(),...newTask,done:false},...p]); setNewTask({title:"",priority:"Normal",repeat:"none",contactId:null,dueDate:""}); setShowAddTask(false); toast("Task added."); }}>Add</Btn>
                </div>
              </Card>
            )}
            {dataLoaded && tasks.length===0 && !showAddTask && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>Nothing to do</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Create your first task and let KROFT remind you.</Mono>
                <Btn sm onClick={() => setShowAddTask(true)}>+ Add Task</Btn>
              </Card>
            )}
            {/* Done tasks sink to the bottom regardless of anything else. Among undone tasks: an
                overdue due date outranks priority (a "Low" task that's late is more urgent right
                now than an "Urgent" one that isn't due yet), then priority, then soonest due date
                first — undated tasks sort last within their priority tier. */}
            {[...tasks].sort((a,b) => {
              if (a.done !== b.done) return a.done ? 1 : -1;
              const today = todayISO();
              const aOverdue = a.dueDate && a.dueDate < today && !a.done;
              const bOverdue = b.dueDate && b.dueDate < today && !b.done;
              if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
              const pd = (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2);
              if (pd !== 0) return pd;
              if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
              return a.dueDate ? -1 : b.dueDate ? 1 : 0;
            }).map(t => (
              editingTask && editingTask.id===t.id ? (
                <Card key={t.id} style={{ marginBottom:9, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit task</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    <Inp placeholder="What needs to get done?" value={editingTask.title} onChange={e=>setEditingTask(v=>({...v,title:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                    <select value={editingTask.priority} onChange={e=>setEditingTask(v=>({...v,priority:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                      {["Low","Normal","High","Urgent"].map(p => <option key={p}>{p}</option>)}
                    </select>
                    <input type="date" value={editingTask.dueDate||""} onChange={e=>setEditingTask(v=>({...v,dueDate:e.target.value}))} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"8px 9px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                    <select value={editingTask.repeat} onChange={e=>setEditingTask(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                      {["none","daily","weekly","monthly"].map(r => <option key={r}>{r}</option>)}
                    </select>
                    {contacts.length > 0 && <ContactSelect value={editingTask.contactId} onChange={id=>setEditingTask(v=>({...v,contactId:id}))} contacts={contacts} />}
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:9 }}>
                    <Btn sm v="outline" onClick={() => setEditingTask(null)} style={{ flex:1 }}>Cancel</Btn>
                    <Btn sm onClick={() => { if (!editingTask.title.trim()) return; setTasks(p=>p.map(x=>x.id===t.id?editingTask:x)); setEditingTask(null); toast("Task updated."); }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </Card>
              ) : (
              // Urgent/High tasks get a soft tint of their own priority color — the same
              // "color that means something" treatment as Wellness's mood chips — so the eye
              // lands on what's actually pressing in a long list, not just its Tag text color.
              (() => { const tColor = t.priority==="Urgent"?C.negative:t.priority==="High"?C.warning:null; const tinted = tColor && !t.done; return (
              <Card key={t.id} {...longPress(() => setActionSheet(holdActions({ title:t.title, subtitle:t.done ? "Completed" : t.priority, onEdit:() => setEditingTask({...t}), list:tasks, setList:setTasks, id:t.id, deletedLabel:"Task deleted." })))} style={{ marginBottom:9, opacity:t.done?.55:1, borderRadius:16, background:tinted?tColor+"0d":C.card, border:`1px solid ${tinted?tColor+"33":C.cardB}`, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <button key={`${t.id}-cb-${t.done}`} onClick={() => {
                    const completingThis = !t.done;
                    haptic(completingThis ? [12, 40, 12] : 10);
                    setTasks(p => {
                      const target = p.find(x => x.id === t.id);
                      const completing = target && !target.done;
                      const toggled = p.map(x => x.id===t.id ? {...x,done:!x.done} : x);
                      // A repeating task's "next occurrence" is a fresh unchecked copy spawned the
                      // moment the current one is completed — the completed one stays as a record.
                      // Its due date (if any) advances by the same cadence, same as a recurring
                      // appointment — otherwise the new copy would already show as overdue the
                      // instant it's created.
                      if (completing && target.repeat !== "none") {
                        return [{ id:uid(), title:target.title, priority:target.priority, repeat:target.repeat, contactId:target.contactId, dueDate:target.dueDate?advanceRepeatDate(target.dueDate,target.repeat):"", done:false }, ...toggled];
                      }
                      return toggled;
                    });
                    // A genuine "clear the list" moment — every other task was already done and
                    // this was the last one standing, not just any single completion.
                    if (completingThis && tasks.every(x => x.id===t.id || x.done)) {
                      toast("All tasks done — nice work.");
                      celebrate();
                    }
                  }} style={{ width:20, height:20, borderRadius:6, border:`1.5px solid ${t.done?C.white:C.soft}`, background:t.done?C.white:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:C.black, fontSize:12, fontWeight:900, animation:t.done?"checkPop .4s cubic-bezier(.34,1.56,.64,1)":"none" }}>
                    {t.done ? "✓" : ""}
                  </button>
                  <div style={{ flex:1, minWidth:0, cursor:"pointer" }} onClick={() => setEditingTask({...t})}>
                    <div style={{ fontSize:13, fontWeight:600, color:C.white, textDecoration:t.done?"line-through":"none" }}>{t.title}</div>
                    <div style={{ display:"flex", gap:7, marginTop:3, flexWrap:"wrap" }}>
                      <Tag tone={t.priority==="Urgent"?"negative":t.priority==="High"?"warning":undefined}>{t.priority}</Tag>
                      {t.dueDate && !t.done && t.dueDate < todayISO() && <Tag tone="negative">Overdue · {fmtDate(t.dueDate)}</Tag>}
                      {t.dueDate && (t.done || t.dueDate >= todayISO()) && <Tag>Due {fmtDate(t.dueDate)}</Tag>}
                      {t.repeat!=="none" && <Tag>{t.repeat}</Tag>}
                      {t.contactId && contacts.find(c=>c.id===t.contactId) && <Tag tone="accent">{contacts.find(c=>c.id===t.contactId).name}</Tag>}
                    </div>
                  </div>
                  <Btn sm v="outline" onClick={() => setEditingTask({...t})}>Edit</Btn>
                </div>
              </Card>
              ); })()
            )))}
          </div>
        )}

        {/* ── WORKSPACE: FILES ── */}
        {tab==="workspace" && workspaceSection==="files" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Files</h2>
              <label style={{ background:C.white, color:C.black, borderRadius:12, padding:"10px 22px", cursor:"pointer", fontSize:13, fontWeight:700, fontFamily:"'Space Grotesk',sans-serif" }}>
                + Upload
                <input type="file" multiple style={{ display:"none" }} onChange={handleFilesUpload} />
              </label>
            </div>
            {files.length===0 && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No files yet</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Documents, PDFs, images and AI-generated files will appear here.</Mono>
              </Card>
            )}
            {files.map(f => (
              <Card key={f.id} {...longPress(() => setActionSheet(holdActions({ title:f.name, subtitle:`${(f.size/1024).toFixed(0)} KB · ${f.date}`, list:files, setList:setFiles, id:f.id, deletedLabel:"File removed.", after:() => scheduleBlobRevoke(f.id, f.url, setFiles) })))} style={{ marginBottom:9, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:11, marginBottom:contacts.length>0?10:0 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:3, flexWrap:"wrap" }}>
                      <Mono style={{ color:C.soft }}>{(f.size/1024).toFixed(0)} KB · {f.date}</Mono>
                      {f.contactId && contacts.find(c=>c.id===f.contactId) && <Tag tone="accent">{contacts.find(c=>c.id===f.contactId).name}</Tag>}
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:7, flexShrink:0 }}>
                    {/* No download attribute here — that's what used to force a save-as dialog
                        just to look at a file. Opening the data: URL directly in a new tab lets
                        the browser render it in place instead (images, PDFs, text all display
                        inline); a type with no built-in browser viewer, like a .docx, still
                        downloads, but that's the browser's own behavior, not this forcing it. */}
                    <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration:"none" }}><Btn sm v="outline">View</Btn></a>
                    <a href={f.url} download={f.name} style={{ textDecoration:"none" }}><Btn sm v="outline">Download</Btn></a>
                    <Btn sm v="outline" onClick={() => shareContent({ title:f.name, text:`Sharing a file: ${f.name}`, url:f.url })}>Share</Btn>
                  </div>
                </div>
                {contacts.length > 0 && (
                  <ContactSelect value={f.contactId} onChange={id => setFiles(p=>p.map(x=>x.id===f.id?{...x,contactId:id}:x))} contacts={contacts} style={{ width:"100%" }} />
                )}
              </Card>
            ))}
          </div>
        )}

        {/* ── WORKSPACE: DOCUMENTS ── */}
        {tab==="workspace" && workspaceSection==="documents" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Documents</h2>
              <Btn sm onClick={() => setShowAddDocument(v=>!v)}>+ New Document</Btn>
            </div>
            {showAddDocument && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New document</div>
                <Inp placeholder="Document title" value={newDocument.title} onChange={e=>setNewDocument(v=>({...v,title:e.target.value}))} style={{ marginBottom:9 }} />
                <textarea placeholder="Write your document…" value={newDocument.body} onChange={e=>setNewDocument(v=>({...v,body:e.target.value}))} rows={8} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
                <div style={{ display:"flex", gap:8 }}>
                  <Btn sm v="outline" onClick={() => { setShowAddDocument(false); setNewDocument({title:"",body:""}); }} style={{ flex:1 }}>Cancel</Btn>
                  <Btn sm onClick={() => { if (!newDocument.title.trim()) return; setDocuments(p=>[{id:uid(),...newDocument,createdAt:dateStr(),editedAt:null},...p]); setNewDocument({title:"",body:""}); setShowAddDocument(false); toast("Document created."); }} style={{ flex:1 }}>Create</Btn>
                </div>
              </Card>
            )}
            {documents.length===0 && !showAddDocument && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No documents yet</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>For longer write-ups — briefs, plans, drafts — that outgrow a quick note.</Mono>
                <Btn sm onClick={() => setShowAddDocument(true)}>+ New Document</Btn>
              </Card>
            )}
            {documents.map(d => (
              editingDocument && editingDocument.id===d.id ? (
                <Card key={d.id} style={{ marginBottom:11, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit document</div>
                  <Inp placeholder="Document title" value={editingDocument.title} onChange={e=>setEditingDocument(v=>({...v,title:e.target.value}))} style={{ marginBottom:9 }} />
                  <textarea value={editingDocument.body} onChange={e=>setEditingDocument(v=>({...v,body:e.target.value}))} rows={8} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
                  <div style={{ display:"flex", gap:8 }}>
                    <Btn sm v="outline" onClick={() => setEditingDocument(null)} style={{ flex:1 }}>Cancel</Btn>
                    <Btn sm onClick={() => { if (!editingDocument.title.trim()) return; setDocuments(p=>p.map(x=>x.id===d.id?{...editingDocument,editedAt:dateStr()}:x)); setEditingDocument(null); toast("Document updated."); }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </Card>
              ) : (
              <Card key={d.id} {...longPress(() => setActionSheet(holdActions({ title:d.title || "Untitled", subtitle:d.editedAt || d.createdAt, onEdit:() => setEditingDocument({...d}), list:documents, setList:setDocuments, id:d.id, deletedLabel:"Document deleted." })))} style={{ marginBottom:11, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                <div style={{ cursor:"pointer" }} onClick={() => setOpenDocument(openDocument===d.id?null:d.id)}>
                  <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:4 }}>{d.title}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:openDocument===d.id?10:0, flexWrap:"wrap" }}>
                    {d.editedAt && <Tag tone="accent">EDITED</Tag>}
                    <Mono style={{ color:C.soft }}>{d.editedAt?`Edited ${d.editedAt}`:`Created ${d.createdAt}`} · {d.body.split(/\s+/).filter(Boolean).length} words</Mono>
                  </div>
                  {openDocument===d.id ? (
                    <div style={{ fontSize:13, color:C.text, lineHeight:1.75, whiteSpace:"pre-wrap", padding:"12px 0 4px", borderTop:`1px solid ${C.div}`, marginTop:2 }}>{d.body || <span style={{ color:C.soft }}>Empty document.</span>}</div>
                  ) : (
                    <div style={{ fontSize:12, color:C.soft, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.body || "Empty document."}</div>
                  )}
                </div>
                <div style={{ display:"flex", gap:7, marginTop:12, flexWrap:"wrap" }}>
                  <Btn sm v="outline" onClick={() => setEditingDocument({...d})}>Edit</Btn>
                  <Btn sm v="outline" onClick={() => shareContent({ title:d.title, text:`${d.title}\n\n${d.body}` })}>Share</Btn>
                  <Btn sm v="outline" onClick={() => { downloadText(`${d.title.replace(/[^a-z0-9]+/gi,"_")||"document"}.txt`, `${d.title}\n\n${d.body}`); toast("Downloaded."); }}>Download</Btn>
                </div>
              </Card>
              )
            ))}
          </div>
        )}

        {/* ── WORKSPACE: PROJECTS ── */}
        {tab==="workspace" && workspaceSection==="projects" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Projects</h2>
              <Btn sm onClick={() => setShowAddProject(v=>!v)}>Create Project</Btn>
            </div>
            {/* One shared file input and one shared AddEntryModal for every project's "+ New" on
                Files/Income/Expenses, rather than mounting one per project card. */}
            <input ref={projectFileInputRef} type="file" multiple style={{ display:"none" }} onChange={e => handleFilesUpload(e, projectFileUploadTarget.current)} />
            {addEntryToProject && (
              <AddEntryModal
                kind={addEntryToProject.kind}
                theme={theme}
                value={projectEntryDraft}
                onChange={setProjectEntryDraft}
                cats={addEntryToProject.kind==="income"?incomeCats:expenseCats}
                onAddCategory={c => addEntryToProject.kind==="income" ? setIncomeCats(p=>p.includes(c)?p:[...p,c]) : setExpenseCats(p=>p.includes(c)?p:[...p,c])}
                onClose={() => setAddEntryToProject(null)}
                onSubmit={() => {
                  if (!projectEntryDraft.label) return;
                  const amt = parseAmount(projectEntryDraft.amount);
                  if (amt === null) { toast("Enter an amount greater than zero."); return; }
                  const { projectId, kind } = addEntryToProject;
                  const base = { id:uid(), ...projectEntryDraft, amount:amt, date:projectEntryDraft.date||todayISO(), cur:user.currency };
                  if (base.repeat && base.repeat !== "none") base.nextDate = advanceRepeatDate(base.date, base.repeat);
                  if (kind==="income") setIncome(p=>[...p,base]); else setExpenses(p=>[...p,base]);
                  const idsKey = kind==="income"?"incomeIds":"expenseIds";
                  setProjects(p=>p.map(pr=>pr.id===projectId?{...pr,[idsKey]:[...(pr[idsKey]||[]),base.id]}:pr));
                  setAddEntryToProject(null);
                  toast(`${kind==="income"?"Income":"Expense"} added to project.`);
                }}
              />
            )}
            {showAddProject && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New project</div>
                <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    <Inp placeholder="Project name" value={newProject.name} onChange={e=>setNewProject(v=>({...v,name:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                    <input type="date" value={newProject.deadline} onChange={e=>setNewProject(v=>({...v,deadline:e.target.value}))} style={{ flex:1, minWidth:120, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:newProject.deadline?C.text:C.muted, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                  </div>
                  <Inp placeholder="What's this project about? (optional)" value={newProject.description} onChange={e=>setNewProject(v=>({...v,description:e.target.value}))} />
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <select value={newProject.status} onChange={e=>setNewProject(v=>({...v,status:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                      {["Not Started","In Progress","On Hold","Completed"].map(s => <option key={s}>{s}</option>)}
                    </select>
                    <Btn onClick={() => { if (!newProject.name.trim()) return; setProjects(p=>[{id:uid(),...newProject,taskIds:[],noteIds:[],fileIds:[],documentIds:[],expenseIds:[],incomeIds:[],contactIds:[],milestones:[]},...p]); setNewProject({name:"",deadline:"",description:"",status:"Not Started"}); setShowAddProject(false); toast("Project created."); }}>Create</Btn>
                  </div>
                </div>
              </Card>
            )}
            {projects.length===0 && !showAddProject && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No active projects</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Group tasks, notes and files together.</Mono>
                <Btn sm onClick={() => setShowAddProject(true)}>Create Project</Btn>
              </Card>
            )}
            {/* Completed projects sink to the bottom, same as done tasks. Among the rest, one
                past its own deadline outranks anything else — that's the one actually slipping —
                then soonest deadline first; undated projects sort last within their tier. */}
            {[...projects].sort((a,b) => {
              const aDone = a.status==="Completed", bDone = b.status==="Completed";
              if (aDone !== bDone) return aDone ? 1 : -1;
              const today = todayISO();
              const aOverdue = a.deadline && a.deadline < today && !aDone;
              const bOverdue = b.deadline && b.deadline < today && !bDone;
              if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
              if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
              return a.deadline ? -1 : b.deadline ? 1 : 0;
            }).map(pr => {
              const linkedTasks = tasks.filter(t => (pr.taskIds||[]).includes(t.id));
              const doneCount = linkedTasks.filter(t=>t.done).length;
              const progress = linkedTasks.length>0 ? Math.round((doneCount/linkedTasks.length)*100) : 0;
              const milestones = pr.milestones||[];
              const milestoneDoneCount = milestones.filter(m=>m.done).length;
              const milestoneProgress = milestones.length>0 ? Math.round((milestoneDoneCount/milestones.length)*100) : 0;
              const linkedNotes = notes.filter(n => (pr.noteIds||[]).includes(n.id));
              const linkedFiles = files.filter(f => (pr.fileIds||[]).includes(f.id));
              const linkedDocuments = documents.filter(d => (pr.documentIds||[]).includes(d.id));
              const linkedExpenses = expenses.filter(x => (pr.expenseIds||[]).includes(x.id));
              const linkedIncome = income.filter(x => (pr.incomeIds||[]).includes(x.id));
              const linkedContacts = contacts.filter(c => (pr.contactIds||[]).includes(c.id));
              const totalSpent = linkedExpenses.reduce((s,x)=>s+x.amount,0);
              const totalEarned = linkedIncome.reduce((s,x)=>s+x.amount,0);
              const isEditing = editingProject && editingProject.id===pr.id;
              const isOverdue = pr.deadline && pr.status!=="Completed" && pr.deadline < todayISO();
              // Same "color that means something" treatment as Tasks/Wellness — a project's
              // status already drives its Tag color below, so the card background echoes it
              // rather than introducing a second, unrelated color language. A blown deadline
              // outranks status here, same as an overdue task outranking its own priority color.
              const pColor = isOverdue?C.negative:pr.status==="In Progress"?C.accent:pr.status==="Completed"?C.positive:pr.status==="On Hold"?C.warning:null;
              return (
              <Card key={pr.id} {...longPress(() => setActionSheet(holdActions({ title:pr.name, subtitle:pr.status, onEdit:() => setEditingProject({...pr}), list:projects, setList:setProjects, id:pr.id, deletedLabel:"Project deleted." })))} style={{ marginBottom:10, borderRadius:16, background:pColor?pColor+"0d":C.card, border:`1px solid ${pColor?pColor+"33":C.cardB}`, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                {isEditing ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                    <Mono style={{ display:"block", color:C.white, letterSpacing:.8 }}>Edit project</Mono>
                    <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                      <Inp placeholder="Project name" value={editingProject.name} onChange={e=>setEditingProject(v=>({...v,name:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                      <input type="date" value={editingProject.deadline||""} onChange={e=>setEditingProject(v=>({...v,deadline:e.target.value}))} style={{ flex:1, minWidth:120, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                    </div>
                    <Inp placeholder="Description" value={editingProject.description||""} onChange={e=>setEditingProject(v=>({...v,description:e.target.value}))} />
                    <select value={editingProject.status} onChange={e=>setEditingProject(v=>({...v,status:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                      {["Not Started","In Progress","On Hold","Completed"].map(s => <option key={s}>{s}</option>)}
                    </select>
                    <div style={{ display:"flex", gap:8 }}>
                      <Btn sm v="outline" onClick={() => setEditingProject(null)} style={{ flex:1 }}>Cancel</Btn>
                      <Btn sm onClick={() => { if (!editingProject.name.trim()) return; setProjects(p=>p.map(x=>x.id===pr.id?editingProject:x)); setEditingProject(null); toast("Project updated."); }} style={{ flex:1 }}>Save</Btn>
                    </div>
                  </div>
                ) : (
                <>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", cursor:"pointer" }} onClick={() => setOpenProject(openProject===pr.id?null:pr.id)}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:4 }}>
                      <span style={{ fontWeight:700, fontSize:14, color:C.white }}>{pr.name}</span>
                      <Tag tone={pr.status==="In Progress"?"accent":pr.status==="Completed"?"positive":pr.status==="On Hold"?"warning":undefined}>{pr.status||"Not Started"}</Tag>
                      {isOverdue && <Tag tone="negative">Overdue</Tag>}
                    </div>
                    {pr.description && <div style={{ fontSize:12, color:C.soft, marginBottom:6, lineHeight:1.5 }}>{pr.description}</div>}
                    {pr.deadline && <Mono style={{ color:isOverdue?C.negative:C.soft }}>Due {fmtDate(pr.deadline)}</Mono>}
                  </div>
                  <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                    <Btn sm v="outline" onClick={e=>{e.stopPropagation();setEditingProject({...pr});}}>Edit</Btn>
                  </div>
                </div>
                {/* Milestone progress is the goal-level view (accent-colored, shown first);
                    task progress right below it is the day-to-day view. Same data, two
                    granularities, so a project reads at a glance without opening it. */}
                {milestones.length>0 && (
                  <div style={{ marginTop:10 }}>
                    <div style={{ height:6, borderRadius:3, background:C.surface, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${milestoneProgress}%`, background:C.accent, borderRadius:3, transition:"width .3s ease" }} />
                    </div>
                    <Mono style={{ display:"block", color:C.soft, marginTop:5 }}>{milestoneDoneCount}/{milestones.length} milestones complete · {milestoneProgress}%</Mono>
                  </div>
                )}
                {linkedTasks.length>0 && (
                  <div style={{ marginTop:10 }}>
                    <div style={{ height:6, borderRadius:3, background:C.surface, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${progress}%`, background:C.white, borderRadius:3, transition:"width .3s ease" }} />
                    </div>
                    <Mono style={{ display:"block", color:C.soft, marginTop:5 }}>{doneCount}/{linkedTasks.length} tasks complete · {progress}%</Mono>
                  </div>
                )}
                {openProject===pr.id && (
                  <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.div}`, display:"flex", flexDirection:"column", gap:14 }}>
                    {/* Real numbers only — pulled from Finance entries actually linked below, never
                        estimated. Hidden entirely until something's linked, same as every other
                        section here, so an untouched project doesn't show a false $0 budget. */}
                    {(linkedExpenses.length>0 || linkedIncome.length>0) && (
                      <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                        {linkedIncome.length>0 && <div><Mono style={{ display:"block", color:C.muted, marginBottom:2 }}>EARNED</Mono><div style={{ fontSize:15, fontWeight:700, color:C.positive }}>{fmtCur(totalEarned,user.currency)}</div></div>}
                        {linkedExpenses.length>0 && <div><Mono style={{ display:"block", color:C.muted, marginBottom:2 }}>SPENT</Mono><div style={{ fontSize:15, fontWeight:700, color:C.negative }}>{fmtCur(totalSpent,user.currency)}</div></div>}
                        {linkedIncome.length>0 && linkedExpenses.length>0 && <div><Mono style={{ display:"block", color:C.muted, marginBottom:2 }}>NET</Mono><div style={{ fontSize:15, fontWeight:700, color:(totalEarned-totalSpent)>=0?C.positive:C.negative }}>{fmtCur(totalEarned-totalSpent,user.currency)}</div></div>}
                      </div>
                    )}
                    {/* Milestones: the project's own goal checkpoints, not a link to a shared
                        pool — so this gets bespoke rendering (a checkbox + a real delete)
                        instead of the generic link/unlink pattern the sections below use. */}
                    <div>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
                        <Mono style={{ color:C.white, letterSpacing:.8 }}>MILESTONES ({milestones.length})</Mono>
                        <button onClick={() => { setAddingMilestoneToProject(addingMilestoneToProject===pr.id?null:pr.id); setMilestoneDraft(""); }} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:"'Space Grotesk',sans-serif", textDecoration:"underline" }}>+ New</button>
                      </div>
                      {addingMilestoneToProject===pr.id && (
                        <div style={{ display:"flex", gap:7, marginBottom:8 }}>
                          <Inp placeholder="e.g. Beta shipped" value={milestoneDraft} onChange={e=>setMilestoneDraft(e.target.value)} style={{ flex:1 }} />
                          <Btn sm onClick={() => {
                            if (!milestoneDraft.trim()) return;
                            setProjects(p=>p.map(x=>x.id===pr.id?{...x,milestones:[...(x.milestones||[]),{id:uid(),title:milestoneDraft.trim(),done:false}]}:x));
                            setMilestoneDraft(""); setAddingMilestoneToProject(null);
                          }}>Add</Btn>
                        </div>
                      )}
                      {milestones.length===0 ? (
                        <Mono style={{ color:C.soft, display:"block" }}>No milestones yet — add the big checkpoints on the way to done.</Mono>
                      ) : milestones.map(m => (
                        <div key={m.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"6px 0" }}>
                          <button onClick={() => toggleMilestone(pr.id, m.id)} style={{ width:18, height:18, borderRadius:5, border:`1.5px solid ${m.done?C.accent:C.soft}`, background:m.done?C.accent:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:C.black, fontSize:11, fontWeight:900 }}>{m.done?"✓":""}</button>
                          <div style={{ flex:1, fontSize:12, color:C.text, textDecoration:m.done?"line-through":"none", opacity:m.done?.6:1 }}>{m.title}</div>
                          <button onClick={()=>removeMilestone(pr.id, m.id)} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11 }}>Remove</button>
                        </div>
                      ))}
                    </div>
                    {[{kind:"taskIds",label:"Tasks",items:linkedTasks,pool:tasks,render:t=>t.title,
                        onNew:() => { setAddingTaskToProject(addingTaskToProject===pr.id?null:pr.id); setProjectTaskDraft(""); }},
                      {kind:"noteIds",label:"Notes",items:linkedNotes,pool:notes,render:n=>n.title||"Untitled note",
                        onNew:() => { setAddingNoteToProject(addingNoteToProject===pr.id?null:pr.id); setProjectNoteDraft(""); }},
                      {kind:"fileIds",label:"Files",items:linkedFiles,pool:files,render:f=>f.name,
                        onNew:() => { projectFileUploadTarget.current = pr.id; projectFileInputRef.current?.click(); }},
                      {kind:"documentIds",label:"Documents",items:linkedDocuments,pool:documents,render:d=>d.title,
                        onNew:() => { setAddingDocumentToProject(addingDocumentToProject===pr.id?null:pr.id); setProjectDocumentDraft(""); }},
                      {kind:"contactIds",label:"Team",items:linkedContacts,pool:contacts,render:c=>c.name},
                      {kind:"expenseIds",label:"Expenses",items:linkedExpenses,pool:expenses,render:x=>`${x.label} — ${fmtCur(x.amount,x.cur||user.currency)}`,
                        onNew:() => { setAddEntryToProject({projectId:pr.id,kind:"expense"}); setProjectEntryDraft({label:"",amount:"",cat:expenseCats[0]||"Operations",date:todayISO(),repeat:"none"}); }},
                      {kind:"incomeIds",label:"Income",items:linkedIncome,pool:income,render:x=>`${x.label} — ${fmtCur(x.amount,x.cur||user.currency)}`,
                        onNew:() => { setAddEntryToProject({projectId:pr.id,kind:"income"}); setProjectEntryDraft({label:"",amount:"",cat:incomeCats[0]||"Invoice",date:todayISO(),repeat:"none"}); }}].map(sec => (
                      <div key={sec.kind}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:7 }}>
                          <Mono style={{ color:C.white, letterSpacing:.8 }}>{sec.label.toUpperCase()} ({sec.items.length})</Mono>
                          <div style={{ display:"flex", gap:10 }}>
                            {sec.onNew && <button onClick={sec.onNew} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:"'Space Grotesk',sans-serif", textDecoration:"underline" }}>+ New</button>}
                            <button onClick={() => setLinkPicker(linkPicker&&linkPicker.projectId===pr.id&&linkPicker.kind===sec.kind ? null : {projectId:pr.id,kind:sec.kind})} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:"'Space Grotesk',sans-serif", textDecoration:"underline" }}>+ Link</button>
                          </div>
                        </div>
                        {sec.kind==="taskIds" && addingTaskToProject===pr.id && (
                          <div style={{ display:"flex", gap:7, marginBottom:8 }}>
                            <Inp placeholder="New task title" value={projectTaskDraft} onChange={e=>setProjectTaskDraft(e.target.value)} style={{ flex:1 }} />
                            <Btn sm onClick={() => {
                              if (!projectTaskDraft.trim()) return;
                              const item = { id:uid(), title:projectTaskDraft.trim(), priority:"Normal", repeat:"none", contactId:null, dueDate:"", done:false };
                              setTasks(p=>[item,...p]);
                              toggleProjectLink(pr.id, "taskIds", item.id);
                              setProjectTaskDraft(""); setAddingTaskToProject(null);
                              toast("Task added to project.");
                            }}>Add</Btn>
                          </div>
                        )}
                        {sec.kind==="noteIds" && addingNoteToProject===pr.id && (
                          <div style={{ display:"flex", gap:7, marginBottom:8 }}>
                            <Inp placeholder="Quick note" value={projectNoteDraft} onChange={e=>setProjectNoteDraft(e.target.value)} style={{ flex:1 }} />
                            <Btn sm onClick={() => {
                              if (!projectNoteDraft.trim()) return;
                              const item = { id:uid(), title:"", body:projectNoteDraft.trim(), date:dateStr(), contactId:null };
                              setNotes(p=>[item,...p]);
                              toggleProjectLink(pr.id, "noteIds", item.id);
                              setProjectNoteDraft(""); setAddingNoteToProject(null);
                              toast("Note added to project.");
                            }}>Add</Btn>
                          </div>
                        )}
                        {sec.kind==="documentIds" && addingDocumentToProject===pr.id && (
                          <div style={{ display:"flex", gap:7, marginBottom:8 }}>
                            <Inp placeholder="Document title" value={projectDocumentDraft} onChange={e=>setProjectDocumentDraft(e.target.value)} style={{ flex:1 }} />
                            <Btn sm onClick={() => {
                              if (!projectDocumentDraft.trim()) return;
                              const item = { id:uid(), title:projectDocumentDraft.trim(), body:"", createdAt:dateStr(), editedAt:null };
                              setDocuments(p=>[item,...p]);
                              toggleProjectLink(pr.id, "documentIds", item.id);
                              setProjectDocumentDraft(""); setAddingDocumentToProject(null);
                              toast("Document added to project.");
                            }}>Add</Btn>
                          </div>
                        )}
                        {sec.items.length===0 ? (
                          <Mono style={{ color:C.soft, display:"block" }}>Nothing linked yet.</Mono>
                        ) : sec.items.map(it => (
                          <div key={it.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0" }}>
                            <div style={{ fontSize:12, color:C.text, textDecoration:sec.kind==="taskIds"&&it.done?"line-through":"none", opacity:sec.kind==="taskIds"&&it.done?.55:1 }}>{sec.render(it)}</div>
                            <button onClick={()=>toggleProjectLink(pr.id,sec.kind,it.id)} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11 }}>Unlink</button>
                          </div>
                        ))}
                        {linkPicker && linkPicker.projectId===pr.id && linkPicker.kind===sec.kind && (
                          <div style={{ marginTop:8, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:9, maxHeight:160, overflowY:"auto" }}>
                            {sec.pool.length===0 ? <Mono style={{ color:C.soft }}>None available — create one in {sec.label} first.</Mono> : sec.pool.map(it => (
                              <label key={it.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 2px", cursor:"pointer" }}>
                                <input type="checkbox" checked={(pr[sec.kind]||[]).includes(it.id)} onChange={()=>toggleProjectLink(pr.id,sec.kind,it.id)} style={{ accentColor:C.white, width:13, height:13 }} />
                                <span style={{ fontSize:12, color:C.text }}>{sec.render(it)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                </>
                )}
              </Card>
              );
            })}
          </div>
        )}

        {/* ── WORKSPACE: VOICE MEMOS ── */}
        {tab==="workspace" && workspaceSection==="memos" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Voice Memos</h2>
              <Btn sm onClick={toggleVoiceMemo}>{recordingMemo ? "Stop Recording" : "+ Record"}</Btn>
            </div>
            {recordingMemo && (
              <Card style={{ marginBottom:14, border:`1px solid ${C.negative}55`, textAlign:"center", padding:24 }}>
                <WaveBar active color={C.negative} />
                <Mono style={{ display:"block", color:C.negative, marginTop:10 }}>Recording…</Mono>
              </Card>
            )}
            {voiceMemos.length===0 && !recordingMemo && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No voice memos yet</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Record a memo and KROFT will transcribe it automatically.</Mono>
                <Btn sm onClick={toggleVoiceMemo}>+ Record</Btn>
              </Card>
            )}
            {voiceMemos.map((m,i) => (
              editingMemo && editingMemo.id===m.id ? (
                <Card key={m.id} style={{ marginBottom:10, border:`1px solid ${C.soft}` }}>
                  <Mono style={{ display:"block", color:C.white, marginBottom:11, letterSpacing:.8 }}>Edit memo</Mono>
                  <Inp placeholder={`Voice Memo ${voiceMemos.length-i}`} value={editingMemo.title} onChange={e=>setEditingMemo(v=>({...v,title:e.target.value}))} style={{ marginBottom:9 }} />
                  <Mono style={{ display:"block", color:C.soft, marginBottom:6, fontSize:9, letterSpacing:.8 }}>TRANSCRIPTION (edit if KROFT misheard something)</Mono>
                  <textarea value={editingMemo.transcript} onChange={e=>setEditingMemo(v=>({...v,transcript:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:12, fontFamily:"'Space Grotesk',sans-serif", outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
                  <div style={{ display:"flex", gap:8 }}>
                    <Btn sm v="outline" onClick={() => setEditingMemo(null)} style={{ flex:1 }}>Cancel</Btn>
                    <Btn sm onClick={() => { setVoiceMemos(p=>p.map(x=>x.id===m.id?editingMemo:x)); setEditingMemo(null); toast("Memo updated."); }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </Card>
              ) : (
              <Card key={m.id} {...longPress(() => setActionSheet(holdActions({ title:m.title || "Voice memo", subtitle:`${m.date} · ${m.time}${m.duration ? ` · ${fmtMemoLength(m.duration)}` : ""}`, onEdit:() => setEditingMemo({...m}), list:voiceMemos, setList:setVoiceMemos, id:m.id, deletedLabel:"Memo deleted.", after:() => scheduleBlobRevoke(m.id, m.url, setVoiceMemos) })))} style={{ marginBottom:10, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:11, marginBottom:10 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{m.title || `Voice Memo ${voiceMemos.length-i}`}</div>
                    <Mono style={{ color:C.soft }}>{m.date} · {m.time}{m.duration ? ` · ${fmtMemoLength(m.duration)}` : ""}</Mono>
                  </div>
                  <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                    <Btn sm v="outline" onClick={() => setEditingMemo({...m})}>Edit</Btn>
                    <Btn sm v="outline" onClick={() => shareContent({ title:m.title||"Voice Memo", text:`${m.title||"Voice Memo"}\n\n${m.transcript}` })}>Share</Btn>
                  </div>
                </div>
                <audio controls src={m.url} style={{ width:"100%", marginBottom:10 }} />
                <Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>Transcription</Mono>
                <div style={{ fontSize:12, color:C.soft, lineHeight:1.65 }}>{m.transcript}</div>
              </Card>
              )
            ))}
          </div>
        )}

        {/* ── WORKSPACE: REMINDERS ── */}
        {tab==="workspace" && workspaceSection==="reminders" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Reminders</h2>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                <Btn sm v="outline" onClick={suggestSmartReminder} disabled={suggestingReminder}>{suggestingReminder ? <><Spinner size={11} color={C.soft} thickness={2} />Thinking…</> : "AI Suggest"}</Btn>
                <Btn sm v="outline" onClick={() => { if (!subscribed) { toast("Scheduled calls are a KROFT Plus feature."); return; } setShowScheduleCall(v=>!v); }}>
                  {subscribed ? "Schedule a call" : "Schedule a call · Plus"}
                </Btn>
                <Btn sm onClick={() => setShowAddReminder(v=>!v)}>+ Add</Btn>
              </div>
            </div>
            {showAddReminder && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New reminder</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <Inp placeholder="Remind me to…" value={newReminder.text} onChange={e=>setNewReminder(v=>({...v,text:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                  <Inp placeholder="When e.g. Tomorrow 9am" value={newReminder.when} onChange={e=>setNewReminder(v=>({...v,when:e.target.value}))} style={{ flex:1, minWidth:140 }} />
                  {contacts.length > 0 && <ContactSelect value={newReminder.contactId} onChange={id=>setNewReminder(v=>({...v,contactId:id}))} contacts={contacts} />}
                  <Btn onClick={() => { if (!newReminder.text.trim()) return; setSmartReminders(p=>[{id:uid(),text:newReminder.text,when:newReminder.when||"No time set",aiSuggested:false,done:false,contactId:newReminder.contactId||null},...p]); setNewReminder({text:"",when:"",contactId:null}); setShowAddReminder(false); toast("Reminder added."); }}>Add</Btn>
                </div>
              </Card>
            )}
            {showScheduleCall && subscribed && (
              <Card style={{ marginBottom:13, border:`1px solid ${C.accent}55` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Schedule a call</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
                  <Inp placeholder="What's it about?" value={newCall.title} onChange={e=>setNewCall(v=>({...v,title:e.target.value}))} style={{ flex:2, minWidth:160 }} />
                  {/* Raw inputs, not Inp — Inp doesn't set colorScheme, and every other native
                      date/time picker in the app sets it explicitly. Without it the picker
                      renders with dark-on-dark text in dark mode, unreadable. */}
                  <input type="date" min={todayISO()} value={newCall.date} onChange={e=>setNewCall(v=>({...v,date:e.target.value}))} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                  <input type="time" value={newCall.time} onChange={e=>setNewCall(v=>({...v,time:e.target.value}))} style={{ flex:1, minWidth:110, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:"'Space Grotesk',sans-serif", outline:"none", colorScheme:theme }} />
                </div>
                <Inp placeholder="Anything KROFT should say (optional)" value={newCall.note} onChange={e=>setNewCall(v=>({...v,note:e.target.value}))} style={{ width:"100%", boxSizing:"border-box", marginBottom:10 }} />
                {/* Same honesty as every other notification here — this isn't a real phone call,
                    and it can't reach a fully closed browser. Said plainly before scheduling
                    rather than discovered when a call never comes. */}
                <Mono style={{ display:"block", color:C.muted, lineHeight:1.6, marginBottom:10 }}>
                  KROFT rings inside the app, not your phone's dialler — this only works while KROFT is open in a tab, including in the background.
                </Mono>
                <Btn sm onClick={() => {
                  if (!newCall.title.trim() || !newCall.date || !newCall.time) { toast("Add what it's about, plus a date and time."); return; }
                  setScheduledCalls(p => [{ id:uid(), title:newCall.title.trim(), note:newCall.note.trim(), date:newCall.date, time:newCall.time, status:"pending" }, ...p]);
                  setNewCall({ title:"", note:"", date:todayISO(), time:"" });
                  setShowScheduleCall(false);
                  toast("Call scheduled.");
                }}>Schedule</Btn>
              </Card>
            )}
            {scheduledCalls.filter(c => c.status==="pending").length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:8 }}>Scheduled calls</div>
                {scheduledCalls.filter(c => c.status==="pending").sort((a,b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).map(c => (
                  <div key={c.id} {...longPress(() => setActionSheet(holdActions({
                      title: c.title,
                      subtitle: `${fmtDate(c.date)} at ${c.time}`,
                      list: scheduledCalls, setList: setScheduledCalls, id: c.id,
                      deletedLabel: "Call cancelled.",
                    })))} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:`1px solid ${C.div}`, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontSize:12.5, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.title}</div>
                      <Mono style={{ color:C.muted }}>{fmtDate(c.date)} at {c.time}</Mono>
                    </div>
                    <NavIcon id="mic" size={15} color={C.accent} />
                  </div>
                ))}
              </div>
            )}

            {smartReminders.length===0 && !showAddReminder && (
              <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No reminders yet</div>
                <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Add one yourself, or let KROFT suggest something useful.</Mono>
                <div style={{ display:"flex", gap:9, justifyContent:"center" }}>
                  <Btn sm onClick={() => setShowAddReminder(true)}>+ Add</Btn>
                  <Btn sm v="outline" onClick={suggestSmartReminder} disabled={suggestingReminder}>{suggestingReminder ? <><Spinner size={11} color={C.soft} thickness={2} />Thinking…</> : "AI Suggest"}</Btn>
                </div>
              </Card>
            )}
            {[...smartReminders].sort((a,b)=>(a.done===b.done)?0:a.done?1:-1).map(r => (
              editingReminder && editingReminder.id===r.id ? (
                <Card key={r.id} style={{ marginBottom:9, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit reminder</div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                    <Inp placeholder="Remind me to…" value={editingReminder.text} onChange={e=>setEditingReminder(v=>({...v,text:e.target.value}))} style={{ flex:2, minWidth:140 }} />
                    <Inp placeholder="When" value={editingReminder.when} onChange={e=>setEditingReminder(v=>({...v,when:e.target.value}))} style={{ flex:1, minWidth:140 }} />
                    {contacts.length > 0 && <ContactSelect value={editingReminder.contactId} onChange={id=>setEditingReminder(v=>({...v,contactId:id}))} contacts={contacts} />}
                  </div>
                  <div style={{ display:"flex", gap:8, marginTop:9 }}>
                    <Btn sm v="outline" onClick={() => setEditingReminder(null)} style={{ flex:1 }}>Cancel</Btn>
                    <Btn sm onClick={() => { if (!editingReminder.text.trim()) return; setSmartReminders(p=>p.map(x=>x.id===r.id?editingReminder:x)); setEditingReminder(null); toast("Reminder updated."); }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </Card>
              ) : (
              <Card key={r.id} {...longPress(() => setActionSheet(holdActions({ title:r.text, subtitle:r.when, onEdit:() => setEditingReminder({...r}), list:smartReminders, setList:setSmartReminders, id:r.id, deletedLabel:"Reminder removed." })))} style={{ marginBottom:9, opacity:r.done?.55:1, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none", }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <button onClick={() => setSmartReminders(p=>p.map(x=>x.id===r.id?{...x,done:!x.done}:x))} style={{ width:20, height:20, borderRadius:6, border:`1.5px solid ${r.done?C.white:C.soft}`, background:r.done?C.white:"transparent", cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", color:C.black, fontSize:12, fontWeight:900 }}>
                    {r.done ? "✓" : ""}
                  </button>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:3, flexWrap:"wrap" }}>
                      <div style={{ fontSize:13, fontWeight:600, color:C.white, textDecoration:r.done?"line-through":"none" }}>{r.text}</div>
                      {r.aiSuggested && <Tag tone="accent">AI</Tag>}
                      {r.contactId && contacts.find(c=>c.id===r.contactId) && <Tag>{contacts.find(c=>c.id===r.contactId).name}</Tag>}
                    </div>
                    <Mono style={{ color:C.soft }}>{r.when}</Mono>
                  </div>
                  <Btn sm v="outline" onClick={() => setEditingReminder({...r})}>Edit</Btn>
                </div>
              </Card>
              )
            ))}
          </div>
        )}

        {tab==="workspace" && workspaceSection==="contacts" && (() => {
          const q = contactSearch.trim().toLowerCase();
          const searching = q.length > 0;
          const filtered = q ? contacts.filter(c => c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.email.toLowerCase().includes(q)) : contacts;
          const business = filtered.filter(c => c.category==="business");
          const family = filtered.filter(c => c.category==="family");

          // Rendered as a plain function call (renderContact(c)), not <ContactRow c={c}/>, so it
          // doesn't get a fresh component identity every render — using it as a JSX component
          // would make React remount this subtree on every keystroke, dropping input focus
          // while editing a contact's name/phone/email. Same convention as Tasks/Reminders/
          // Appointments/Notes below, which render their edit forms inline for the same reason.
          const renderContact = c => (
            editingContact && editingContact.id===c.id ? (
              <div key={c.id} style={{ padding:"12px 0", borderTop:`1px solid ${C.div}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit contact</div>
                <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                  <Inp placeholder="Name *" value={editingContact.name} onChange={e=>setEditingContact(v=>({...v,name:e.target.value}))} />
                  <div style={{ display:"flex", gap:8 }}>
                    <Inp placeholder="Phone" type="tel" inputMode="tel" value={editingContact.phone} onChange={e=>setEditingContact(v=>({...v,phone:e.target.value}))} style={{ flex:1 }} />
                    <Inp placeholder="Email" type="email" inputMode="email" value={editingContact.email} onChange={e=>setEditingContact(v=>({...v,email:e.target.value}))} style={{ flex:1 }} />
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                    <select value={editingContact.category} onChange={e=>setEditingContact(v=>({...v,category:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                      <option value="business">Business</option>
                      <option value="family">Family</option>
                    </select>
                    <Inp placeholder="Note (optional)" value={editingContact.note} onChange={e=>setEditingContact(v=>({...v,note:e.target.value}))} style={{ flex:1, minWidth:100 }} />
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <Btn sm v="outline" onClick={() => setEditingContact(null)} style={{ flex:1 }}>Cancel</Btn>
                    <Btn sm onClick={() => { if (!editingContact.name.trim()) return; setContacts(p=>p.map(x=>x.id===c.id?editingContact:x)); setEditingContact(null); toast("Contact updated."); }} style={{ flex:1 }}>Save</Btn>
                  </div>
                </div>
              </div>
            ) : (
              // Each contact renders as a plain row, not its own Card — the whole group sits in
              // a single Business (or Family) card, with hairline dividers between people rather
              // than a stack of nested cards inside a card.
              <div key={c.id} {...longPress(() => setActionSheet({
                  title: c.name,
                  subtitle: [c.phone, c.email].filter(Boolean).join(" · ") || "No contact info",
                  actions: [
                    { label:"View activity", onClick:() => setContactActivity(c) },
                    { label:"Edit", onClick:() => setEditingContact({...c}) },
                    { label:"Delete", destructive:true, confirmText:"This removes their number, email and interaction history. Anything linked to them stays, but loses the link.", onClick:() => {
                      const prev = contacts;
                      setContacts(prev.filter(x=>x.id!==c.id));
                      toast(`${c.name} deleted.`, () => setContacts(prev));
                    }},
                  ],
                }))} style={{ padding:"12px 0", borderTop:`1px solid ${C.div}`, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:11 }}>
                  <div role="button" tabIndex={0} onClick={() => setContactActivity(c)} onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); setContactActivity(c); } }} style={{ flex:1, minWidth:0, cursor:"pointer" }}>
                    <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name}</div>
                    <Mono style={{ color:C.soft, display:"block", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{[c.phone,c.email].filter(Boolean).join(" · ") || "No contact info"}</Mono>
                    {c.note && <Mono style={{ color:C.muted, display:"block", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.note}</Mono>}
                    {(() => {
                      const openTasks = tasks.filter(t => t.contactId===c.id && !t.done).length;
                      const openReminders = smartReminders.filter(r => r.contactId===c.id && !r.done).length;
                      const upcomingAppts = appts.filter(a => a.contactId===c.id).length;
                      const linkedNotes = notes.filter(n => n.contactId===c.id).length;
                      const linkedFiles = files.filter(f => f.contactId===c.id).length;
                      const calls = (c.log||[]).length;
                      if (!openTasks && !openReminders && !upcomingAppts && !linkedNotes && !linkedFiles && !calls) return null;
                      return (
                        <div style={{ display:"flex", gap:6, marginTop:6, flexWrap:"wrap" }}>
                          {calls > 0 && <Tag tone="accent">{calls} interaction{calls!==1?"s":""}</Tag>}
                          {openTasks > 0 && <Tag>{openTasks} open task{openTasks!==1?"s":""}</Tag>}
                          {openReminders > 0 && <Tag>{openReminders} reminder{openReminders!==1?"s":""}</Tag>}
                          {upcomingAppts > 0 && <Tag>{upcomingAppts} appointment{upcomingAppts!==1?"s":""}</Tag>}
                          {linkedNotes > 0 && <Tag>{linkedNotes} note{linkedNotes!==1?"s":""}</Tag>}
                          {linkedFiles > 0 && <Tag>{linkedFiles} file{linkedFiles!==1?"s":""}</Tag>}
                        </div>
                      );
                    })()}
                  </div>
                  <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                    {c.phone && <Btn sm onClick={() => { logContactAction(c.id, "call"); window.location.href = `tel:${c.phone}`; }}>Call</Btn>}
                    {c.email && <Btn sm v="outline" onClick={() => { logContactAction(c.id, "email"); setComposeDraft({ to:c.email, subject:"", body:"" }); }}>Email</Btn>}
                  </div>
                </div>
              </div>
            )
          );

          return (
            <div style={{ animation:"fadeUp .4s ease", paddingBottom:40 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
                <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Contacts</h2>
                <Btn sm onClick={() => setShowAddContact(v=>!v)}>+ Add</Btn>
              </div>
              <Mono style={{ color:C.muted, display:"block", marginBottom:14 }}>Your own list, kept separate from your phone's contacts.</Mono>

              {contacts.length > 3 && <Inp placeholder="Search contacts…" value={contactSearch} onChange={e=>setContactSearch(e.target.value)} style={{ marginBottom:14, width:"100%", boxSizing:"border-box" }} />}

              {showAddContact && (
                <Card style={{ marginBottom:14, border:`1px solid ${C.border}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>New contact</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                    <Inp placeholder="Name *" value={newContact.name} onChange={e=>setNewContact(v=>({...v,name:e.target.value}))} />
                    <div style={{ display:"flex", gap:8 }}>
                      <Inp placeholder="Phone" type="tel" inputMode="tel" value={newContact.phone} onChange={e=>setNewContact(v=>({...v,phone:e.target.value}))} style={{ flex:1 }} />
                      <Inp placeholder="Email" type="email" inputMode="email" value={newContact.email} onChange={e=>setNewContact(v=>({...v,email:e.target.value}))} style={{ flex:1 }} />
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                      <select value={newContact.category} onChange={e=>setNewContact(v=>({...v,category:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:"'Space Grotesk',sans-serif", outline:"none" }}>
                        <option value="business">Business</option>
                        <option value="family">Family</option>
                      </select>
                      <Inp placeholder="Note (optional)" value={newContact.note} onChange={e=>setNewContact(v=>({...v,note:e.target.value}))} style={{ flex:1, minWidth:100 }} />
                      <Btn sm onClick={() => {
                        if (!newContact.name.trim()) return;
                        setContacts(p=>[{ id:uid(), ...newContact }, ...p]);
                        setNewContact({ name:"", phone:"", email:"", category:"business", note:"" });
                        setShowAddContact(false);
                        toast(`${newContact.name} added to Contacts.`);
                      }}>Add</Btn>
                    </div>
                  </div>
                </Card>
              )}

              {dataLoaded && contacts.length===0 && !showAddContact && (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No contacts yet</div>
                  <Mono style={{ display:"block", color:C.soft, marginBottom:18 }}>Save the people you deal with — clients, suppliers, family — and call them straight from here.</Mono>
                  <Btn sm onClick={() => setShowAddContact(true)}>+ Add First Contact</Btn>
                </Card>
              )}

              {contacts.length > 0 && (
                <>
                  {[{ key:"business", label:"Business", items:business }, { key:"family", label:"Family", items:family }].map(g => {
                    // A search auto-opens any group that has a match, so results aren't hidden
                    // behind a collapsed card the person would have to guess to open.
                    const open = openContactGroups.includes(g.key) || (searching && g.items.length > 0);
                    return (
                    <Card key={g.key} level="raised" style={{ marginTop:14, padding:"14px 16px" }}>
                      <div role="button" tabIndex={0}
                        onClick={() => setOpenContactGroups(p => p.includes(g.key) ? p.filter(x=>x!==g.key) : [...p, g.key])}
                        onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); setOpenContactGroups(p => p.includes(g.key) ? p.filter(x=>x!==g.key) : [...p, g.key]); } }}
                        aria-expanded={open}
                        style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, cursor:"pointer", paddingBottom:open?4:0 }}>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{g.label}</div>
                          <Mono style={{ color:C.muted, display:"block", marginTop:2 }}>
                            {g.items.length === 0 ? "No contacts saved" : `${g.items.length} contact${g.items.length!==1?"s":""}`}
                          </Mono>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:9, flexShrink:0 }}>
                          <Tag>{g.items.length}</Tag>
                          <span aria-hidden="true" style={{ color:C.muted, fontSize:12, display:"inline-block", transform:open?"rotate(90deg)":"none", transition:"transform .18s" }}>›</span>
                        </div>
                      </div>
                      {open && (g.items.length===0
                        ? <Mono style={{ color:C.muted, display:"block", padding:"12px 0 2px", borderTop:`1px solid ${C.div}`, marginTop:8 }}>
                            {q ? `No ${g.label.toLowerCase()} contacts match "${contactSearch}".` : `Nothing here yet — add someone with + Add above.`}
                          </Mono>
                        : g.items.map(c => renderContact(c)))}
                    </Card>
                    );
                  })}
                </>
              )}
            </div>
          );
        })()}

        {tab==="home" && homeSection==="around" && (
          <div style={{ animation:"fadeUp .4s ease" }}>

            {/* Header: location + greeting */}
            <div style={{ marginBottom:18 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:6 }}>
                <PinIcon size={14} color={C.border} />
                <Mono style={{ color:C.soft, letterSpacing:.6 }}>
                  {locationStatus==="granted" ? (locationLabel || "Locating…") : locationStatus==="requesting" ? "Finding your location…" : "Location not set"}
                </Mono>
              </div>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1, marginBottom:4 }}>Around Me</h2>
              <Mono style={{ color:C.muted }}>Discover what's around you.</Mono>
            </div>

            {/* Food & Restaurants — folded in here since it's the same "what's nearby" purpose as Around Me */}
            <Mono style={{ display:"block", color:C.soft, marginBottom:9, letterSpacing:.8 }}>FOOD & RESTAURANTS</Mono>
            {!hungry ? (
              <Card style={{ marginBottom:16, border:`1px solid ${C.soft}` }} hi>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
                  <div><div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:3 }}>Feeling hungry?</div><Mono style={{ color:C.soft }}>Find a real restaurant near you right now.</Mono></div>
                  <Btn onClick={() => { setHungry(true); setAroundCategory("restaurant"); setAroundQuery(""); searchNearby("Restaurants", { categoryKey:"restaurant" }); }}>Yes, I'm hungry</Btn>
                </div>
              </Card>
            ) : (
              <Card style={{ marginBottom:14, border:`1px solid ${C.soft}` }} hi>
                <Mono style={{ display:"block", color:C.white, marginBottom:5, letterSpacing:.8 }}>NEARBY PICK</Mono>
                {/* Grounded in the same real Nominatim search "Nearby places" uses below — no
                    fabricated name, rating, cuisine, or "suggested dish", since none of that is
                    data KROFT actually has. */}
                {aroundLoading ? (
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Spinner size={16} color={C.white} thickness={2} />
                    <Mono style={{ color:C.soft }}>Finding something nearby…</Mono>
                  </div>
                ) : aroundResults.length > 0 ? (
                  <>
                    <div style={{ fontSize:16, fontWeight:700, color:C.white, marginBottom:4 }}>{aroundResults[0].name}</div>
                    <div style={{ fontSize:13, color:C.soft, lineHeight:1.6, marginBottom:12 }}>{aroundResults[0].address} · {distanceFrom(aroundResults[0].lat, aroundResults[0].lng)} away</div>
                    <div style={{ display:"flex", gap:8 }}>
                      <Btn sm onClick={() => setUberDest({ name:aroundResults[0].name, location:aroundResults[0].address })}>Uber there</Btn>
                      <Btn sm v="outline" onClick={() => setHungry(false)}>Reset</Btn>
                    </div>
                  </>
                ) : (
                  <>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:12 }}>
                      {locationStatus!=="granted" ? "Turn on location below to find something nearby." : "Nothing found nearby right now."}
                    </Mono>
                    <Btn sm v="outline" onClick={() => setHungry(false)}>Reset</Btn>
                  </>
                )}
              </Card>
            )}

            <Mono style={{ display:"block", color:C.soft, margin:"22px 0 9px", letterSpacing:.8 }}>Nearby places</Mono>

            {/* Permission prompt — first use or denied */}
            {locationStatus!=="granted" && (
              <Card style={{ marginBottom:16, border:`1px solid ${locationStatus==="denied"?C.border:C.cardB}` }}>
                {locationStatus==="idle" && (
                  <>
                    <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:6 }}>Turn on location</div>
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginBottom:14 }}>
                      KROFT uses your device's GPS to find restaurants, pharmacies, ATMs and other useful places nearby. Your location is only used to power this search.
                    </Mono>
                    <Btn onClick={requestLocation}>Enable location</Btn>
                  </>
                )}
                {locationStatus==="requesting" && (
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <Spinner size={16} color={C.white} thickness={2} />
                    <Mono style={{ color:C.soft }}>Waiting for permission…</Mono>
                  </div>
                )}
                {locationStatus==="denied" && (
                  <>
                    <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:6 }}>Location access denied</div>
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginBottom:14 }}>
                      {aroundError || "KROFT can't find nearby places without location access."} You can enable it any time from your device's Settings for this browser or app, then try again here.
                    </Mono>
                    <Btn v="outline" onClick={requestLocation}>Try again</Btn>
                  </>
                )}
                {locationStatus==="error" && (
                  <>
                    <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:6 }}>Couldn't get your location</div>
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, marginBottom:14 }}>{aroundError}</Mono>
                    <Btn v="outline" onClick={requestLocation}>Retry</Btn>
                  </>
                )}
              </Card>
            )}

            {/* Search bar + AI natural language search */}
            <div style={{ display:"flex", gap:8, marginBottom:16 }}>
              <Inp
                placeholder="Search nearby places…"
                value={aroundQuery}
                onChange={e => setAroundQuery(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter" && aroundQuery.trim()) searchNearby(aroundQuery, { isNaturalLanguage:true }); }}
                style={{ flex:1 }}
              />
              <Btn onClick={() => aroundQuery.trim() && searchNearby(aroundQuery, { isNaturalLanguage:true })} disabled={!aroundQuery.trim() || aroundLoading}>Search</Btn>
            </div>

            {/* Category grid */}
            <Mono style={{ display:"block", color:C.soft, marginBottom:9, letterSpacing:.8 }}>Browse by category</Mono>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))", gap:9, marginBottom:20 }}>
              {CATEGORIES.map(c => (
                <button
                  key={c.key}
                  onClick={() => { setAroundCategory(c.key); setAroundQuery(""); searchNearby(c.label, { categoryKey:c.key }); }}
                  style={{
                    background: aroundCategory===c.key ? C.white : C.card,
                    border:`1px solid ${aroundCategory===c.key ? C.white : C.cardB}`,
                    borderRadius:12, padding:"16px 14px", cursor:"pointer", textAlign:"left",
                    display:"flex", flexDirection:"column", gap:10, transition:"all .16s",
                    fontFamily:"'Space Grotesk',sans-serif",
                  }}
                  onMouseEnter={e => { if (aroundCategory!==c.key) { e.currentTarget.style.borderColor=C.soft; e.currentTarget.style.background=C.hover; } }}
                  onMouseLeave={e => { if (aroundCategory!==c.key) { e.currentTarget.style.borderColor=C.cardB; e.currentTarget.style.background=C.card; } }}
                >
                  <PinIcon size={16} color={aroundCategory===c.key ? C.black : "#22C55E"} />
                  <span style={{ fontSize:12, fontWeight:700, color:aroundCategory===c.key ? C.black : C.white }}>{c.label}</span>
                </button>
              ))}
            </div>

            {/* AI natural-language examples */}
            <Mono style={{ display:"block", color:C.soft, marginBottom:8, letterSpacing:.8 }}>Or ask naturally</Mono>
            <div style={{ display:"flex", flexWrap:"wrap", gap:7, marginBottom:22 }}>
              {["Find restaurants near me","Nearest pharmacy open now","Best café for remote work","Closest ATM","Nearby supermarkets","Hotels near me"].map(q => (
                <button key={q} onClick={() => { setAroundQuery(q); searchNearby(q, { isNaturalLanguage:true }); }}
                  style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:"'Space Grotesk',sans-serif" }}
                  onMouseEnter={e=>{e.target.style.borderColor=C.soft;e.target.style.color=C.white;}}
                  onMouseLeave={e=>{e.target.style.borderColor=C.cardB;e.target.style.color=C.border;}}>
                  {q}
                </button>
              ))}
            </div>

            {/* Loading state */}
            {aroundLoading && (
              <Card style={{ textAlign:"center", padding:24, marginBottom:16 }}>
                <div style={{ margin:"0 auto 14px", display:"flex", justifyContent:"center" }}><Spinner size={24} color={C.white} thickness={2} /></div>
                <Mono style={{ color:C.soft }}>Searching nearby…</Mono>
              </Card>
            )}

            {/* Error state */}
            {!aroundLoading && aroundError && aroundSearched && (
              <Card style={{ textAlign:"center", padding:24, marginBottom:16, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.white, marginBottom:6 }}>Nothing found</div>
                <Mono style={{ display:"block", color:C.muted }}>{aroundError}</Mono>
              </Card>
            )}

            {/* Empty state — no search performed yet */}
            {!aroundLoading && !aroundSearched && locationStatus==="granted" && (
              <Card style={{ textAlign:"center", padding:24, marginBottom:16 }}>
                <div style={{ fontSize:14, fontWeight:600, color:C.white, marginBottom:6 }}>Pick a category or ask KROFT</div>
                <Mono style={{ display:"block", color:C.muted }}>Results will appear here once you search.</Mono>
              </Card>
            )}

            {/* Results list */}
            {!aroundLoading && aroundResults.length>0 && (
              <>
                <Mono style={{ display:"block", color:C.muted, marginBottom:11, letterSpacing:.8 }}>{aroundResults.length} PLACE{aroundResults.length!==1?"S":""} NEARBY</Mono>
                {aroundResults.map(p => (
                  <Card key={p.id} style={{ marginBottom:10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:4 }}>{p.name}</div>
                        <Mono style={{ display:"block", color:C.muted, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.address}</Mono>
                        <Mono style={{ color:C.soft }}>{distanceFrom(p.lat, p.lng)} away</Mono>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:6, flexShrink:0 }}>
                        <Btn sm onClick={() => setUberDest({ name:p.name, location:p.address })}>Uber</Btn>
                        <Btn sm v="outline" onClick={() => { setTab("nova"); setAiInput(`Tell me more about ${p.name} near me`); }}>Ask</Btn>
                      </div>
                    </div>
                  </Card>
                ))}
              </>
            )}
          </div>
        )}

        {tab==="wellness" && (() => {
          const wTone = wellness>80?"positive":wellness>60?"accent":"warning";
          const wColor = {positive:C.positive,accent:C.accent,warning:C.warning}[wTone];
          return (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1, marginBottom:18 }}>Wellness</h2>
            {/* A flat white card with a thin colored border read as "boxy" — a soft full wash of
                the score's own tone (the same positiveBg/accentBg/warningBg tokens already used
                for tags elsewhere, just applied as a real background here) and a rounder radius
                make the color something felt across the whole card, not a hairline accent. */}
            <Card style={{ marginBottom:14, background:{positive:C.positiveBg,accent:C.accentBg,warning:C.warningBg}[wTone], border:`1px solid ${wColor}33`, borderRadius:26 }}>
              <div style={{ display:"flex", justifyContent:"center", alignItems:"center", gap:10, marginBottom:14 }}>
                <Mono style={{ color:wColor, letterSpacing:.8 }}>Wellness score today</Mono>
                {/* Real streak — days with an actual mood check-in, not just the app being open
                    (see wellnessStreak's own comment). Hidden at 0 rather than showing "0 days",
                    which reads as a scoreboard shaming you on day one. */}
                {wellnessStreak > 0 && (
                  <div style={{ display:"flex", alignItems:"center", gap:4, background:C.warningBg, border:`1px solid ${C.warning}55`, borderRadius:20, padding:"3px 9px" }}>
                    <NavIcon id="flame" size={11} color={C.warning} />
                    <Mono style={{ color:C.warning, fontSize:10 }}>{wellnessStreak} day{wellnessStreak!==1?"s":""}</Mono>
                  </div>
                )}
              </div>
              {/* A ring gauge reads as an actual wellness/fitness metric — the flat number-over-a-
                  bar it replaces looked like any other stat tile in the app, nothing that said
                  "this one is about you" the way a progress ring does. */}
              <div style={{ position:"relative", width:132, height:132, margin:"0 auto 16px" }}>
                <svg viewBox="0 0 132 132" style={{ width:132, height:132, transform:"rotate(-90deg)" }}>
                  <circle cx="66" cy="66" r="56" fill="none" stroke={C.card} strokeWidth="11" />
                  <circle cx="66" cy="66" r="56" fill="none" stroke={wColor} strokeWidth="11" strokeLinecap="round"
                    strokeDasharray={2*Math.PI*56} strokeDashoffset={2*Math.PI*56*(1-wellness/100)}
                    style={{ transition:"stroke-dashoffset .8s ease" }} />
                </svg>
                <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
                  <NavIcon id="wellness" size={16} color={wColor} />
                  <div style={{ fontSize:34, fontWeight:700, color:wColor, letterSpacing:-1.5, lineHeight:1.2 }}>{wellness}</div>
                  <Mono style={{ color:C.muted, fontSize:10 }}>/ 100</Mono>
                </div>
              </div>
              <div style={{ fontSize:13, color:C.soft, marginBottom:16, textAlign:"center" }}>{wellness>80?"You are thriving today.":wellness>60?"Doing well — watch your stress.":"Take a break — your body needs it."}</div>
              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                <Btn sm onClick={() => { const tip = rand(wellnessTips()).text; if (voiceReplies) speak(tip); toast(tip); }} style={{ flex:1 }}>Get tip</Btn>
                <Btn sm v="outline" onClick={() => { speak(`Wellness score: ${wellness} out of 100.`); toast("Reading score…"); }} style={{ flex:1 }}>Read score</Btn>
              </div>
              {/* Icon tiles instead of plain outlined pills — matching the quick-access language
                  used elsewhere (Overview/Finance/Workspace). Colored from the start rather than
                  staying neutral gray until maxed — "wellness colors you actually feel" meant
                  color shouldn't be something you only earn, just something that deepens. */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                {[
                  { id:"coffee", key:"breaks", label:"Took a break", done:"Breaks logged", bonus:5 },
                  { id:"droplet", key:"water", label:"Had water", done:"Water logged", bonus:3 },
                ].map(a => {
                  const count = selfCare[a.key], cap = SELF_CARE_CAP[a.key], maxed = count >= cap;
                  return (
                    <button key={a.key} disabled={maxed} onClick={() => { setWellness(s=>Math.min(100,s+a.bonus)); setSelfCare(c=>({...c, [a.key]:c[a.key]+1})); toast(`${a.label==="Took a break"?"Break":"Water"} logged. Wellness +${a.bonus}`); }}
                      style={{ background:C.card, border:`1px solid ${maxed?wColor+"77":wColor+"2a"}`, borderRadius:16, padding:"12px 10px", cursor:maxed?"not-allowed":"pointer", textAlign:"left" }}>
                      <div style={{ width:30, height:30, borderRadius:"50%", background:maxed?wColor+"30":wColor+"16", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:8 }}>
                        <NavIcon id={a.id} size={14} color={wColor} />
                      </div>
                      <div style={{ fontSize:12, fontWeight:700, color:C.white, marginBottom:2 }}>{maxed?a.done:a.label}</div>
                      <Mono style={{ color:C.muted, fontSize:10 }}>{count}/{cap}{maxed?" ✓":""}</Mono>
                    </button>
                  );
                })}
              </div>
            </Card>
            {/* The score only ever existed as a single "today" number — nothing showed whether
                this week is actually trending up or down, only whatever day happened to be
                showing. wellnessHistory records each day's score right before it rolls over. */}
            {wellnessTrend.length > 1 && (
              <Card style={{ marginBottom:14, borderRadius:22 }}>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Score · last {wellnessTrend.length} days</Mono>
                {/* Bars instead of a line — today solid, every earlier day a lighter tint of the
                    same color, so "which one is now" reads at a glance instead of needing to
                    trace the line to the last point. */}
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={wellnessTrend} margin={{ top:18, right:4, left:4, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.cardB} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill:C.muted, fontSize:10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0,100]} hide />
                    <Tooltip formatter={v=>`${v}/100`} contentStyle={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:12, fontSize:11, color:C.white }} cursor={{ fill:C.surface }} />
                    <Bar dataKey="score" radius={[6,6,0,0]} maxBarSize={28} label={{ position:"top", fill:C.muted, fontSize:10, fontFamily:"'Space Grotesk',sans-serif" }}>
                      {wellnessTrend.map((e,i) => <Cell key={i} fill={e.label==="Today" ? wColor : wColor+"33"} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}
            <Card style={{ marginBottom:14, borderRadius:22 }}>
              <Mono style={{ display:"block", color:C.muted, letterSpacing:.8, marginBottom:13 }}>Mood log</Mono>
              {moodLog.length===0 ? <Mono style={{ color:C.soft, display:"block", padding:"8px 0" }}>No mood entries yet. Set your mood from the Overview tab.</Mono> : (() => {
                // Grouped by day, newest first. A flat list of times alone was ambiguous once
                // the log started persisting across days.
                const byDay = {};
                moodLog.forEach(m => { const d = m.date || "undated"; (byDay[d] = byDay[d] || []).push(m); });
                const allDays = Object.keys(byDay).sort().reverse();
                const days = allDays.slice(0, 7);
                const today = todayISO();
                return [
                  ...days.map(d => (
                  <div key={d} style={{ marginBottom:10 }}>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:5 }}>{d === today ? "Today" : d === "undated" ? "Earlier" : fmtDate(d)}</Mono>
                    {byDay[d].slice().reverse().map(m => {
                      const mTone = {calm:"positive",happy:"accent",stressed:"warning",angry:"negative"}[m.mood];
                      const mColor = {positive:C.positive,accent:C.accent,warning:C.warning,negative:C.negative}[mTone]||C.border;
                      return (
                        // Press-and-hold to remove, matching every other list in the app. Mood
                        // entries were the one thing with no way to correct a mistaken tap.
                        <div key={m.id} {...longPress(() => setActionSheet({
                            title:`${m.mood} at ${m.time}`,
                            subtitle: d === today ? "Logged today" : fmtDate(d),
                            actions:[{ label:"Delete entry", destructive:true, confirmText:"This removes the entry from your mood history. Your wellness score isn't affected.", onClick:() => {
                              const prev = moodLog;
                              setMoodLog(prev.filter(x => x.id !== m.id));
                              toast("Mood entry deleted.", () => setMoodLog(prev));
                            }}],
                          }))}
                          style={{ display:"flex", alignItems:"center", gap:12, padding:"8px 10px", marginBottom:6, borderRadius:12, background:mColor+"12", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                          <Dot color={mColor} />
                          <Mono style={{ color:C.muted, minWidth:60 }}>{m.time}</Mono>
                          <Tag tone={mTone}>{m.mood}</Tag>
                        </div>
                      );
                    })}
                  </div>
                  )),
                  // The list is capped at a week so it stays scannable; say so rather than
                  // letting older entries appear to have vanished.
                  allDays.length > 7 && (
                    <Mono key="more" style={{ display:"block", color:C.muted, padding:"6px 0 2px" }}>
                      Showing the last 7 days. {allDays.length - 7} earlier {allDays.length - 7 === 1 ? "day is" : "days are"} still saved.
                    </Mono>
                  ),
                ];
              })()}
            </Card>
            <Card style={{ borderRadius:22 }}>
              <Mono style={{ display:"block", color:C.muted, letterSpacing:.8, marginBottom:13 }}>Daily recommendations</Mono>
              {wellnessTips().map((r,i) => (
                <div key={i} className="row" style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"11px 10px", marginBottom:6, borderRadius:12, background:C.surface }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12.5, color:C.text, lineHeight:1.6 }}>{r.text}</div>
                    {/* Says why this appeared, so it reads as a response to their day rather
                        than a generic tip pulled from a list. */}
                    <Mono style={{ display:"block", color:C.muted, marginTop:3 }}>{r.why}</Mono>
                  </div>
                  <button onClick={() => speak(r.text)} aria-label="Read aloud" title="Read aloud"
                    style={{ background:"none", border:"none", padding:4, cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center" }}>
                    <NavIcon id="play" size={14} color={C.muted} />
                  </button>
                </div>
              ))}
            </Card>
          </div>
          );
        })()}

        {tab==="nova" && (
          <div style={{ position:"fixed", inset:0, zIndex:300, background:C.bg, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, minWidth:0 }}>
                <button onClick={() => setTab("home")} aria-label="Close Ask Kroft" title="Close" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1, flexShrink:0 }}>←</button>
                <button onClick={() => setShowChatHistory(true)} aria-label="Chat history" title="Chat history" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", padding:6, lineHeight:1, flexShrink:0, display:"flex" }}>
                  <NavIcon id="history" size={18} color={C.white} />
                </button>
                <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, whiteSpace:"nowrap" }}>Ask Kroft</h2>
              </div>
              <div style={{ display:"flex", gap:7, flexShrink:0 }}>
                {/* Only worth showing once there's actually a conversation to start over from —
                    a lone welcome message has nothing to clear. */}
                {aiMessages.length > 1 && (
                  <button onClick={startNewChat} className="hbtn" aria-label="Start a new conversation" title="New chat" style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontWeight:700 }}>New chat</button>
                )}
                {/* No separate header "Voice" button anymore — the input bar's own black
                    circular button already opens voice mode when the field is empty, so this
                    was a second way to do the exact same thing. */}
                <button onClick={() => setShowBriefing(true)} className="hbtn" style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontWeight:700 }}>Brief</button>
              </div>
            </div>
            <div style={{ flex:1, minHeight:0, position:"relative" }}>
              <div ref={chatScrollRef} onScroll={e => {
                const box = e.currentTarget;
                setChatNearBottom(box.scrollHeight - box.scrollTop - box.clientHeight < 120);
              }} style={{ position:"absolute", inset:0, overflowY:"auto", padding:"16px", display:"flex", flexDirection:"column", gap:12,
                // Top-aligned once a real conversation exists (messages stack down, scroll takes
                // over), but centered while it's just the one welcome message — top-aligning that
                // alone left a large dead gap below it before the suggestion chips underneath.
                justifyContent: aiMessages.length <= 1 ? "center" : "flex-start" }}>
                {aiMessages.map((m,i) => (
                  <div key={m.id || i} style={{ display:"flex", flexDirection:"column", alignItems:m.role==="user"?"flex-end":"flex-start", animation:"fadeUp .3s ease" }}>
                    <div style={{ background:m.role==="user"?C.white:C.surface, border:`1px solid ${m.role==="user"?C.soft:C.cardB}`, borderRadius:m.role==="user"?"14px 14px 3px 14px":"14px 14px 14px 3px", padding:"10px 14px", maxWidth:"80%" }}>
                      {m.role==="assistant" && <Mono style={{ display:"block", color:C.muted, fontSize:9, letterSpacing:.8, marginBottom:5 }}>KROFT</Mono>}
                      <div style={{ fontSize:13, lineHeight:1.75, color:m.failed?C.negative:(m.role==="user"?C.black:C.text), whiteSpace:"pre-wrap" }}>
                        {m.content}
                        {/* Blinking caret while tokens are still arriving, so a paused stream
                            reads as "still writing" rather than as a finished short answer. */}
                        {m.streaming && <span style={{ display:"inline-block", width:7, height:14, marginLeft:2, verticalAlign:"text-bottom", background:C.muted, animation:"pulse 1s ease-in-out infinite" }} />}
                      </div>
                      {m.contactAction && !m.contactActionResolved && !m.streaming && (
                        <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
                          <Btn sm onClick={() => {
                            runContactAction(m.contactAction);
                            setAiMessages(p => p.map(x => x.id===m.id ? {...x, contactActionResolved:true} : x));
                          }}>{{ email:`Email ${m.contactAction.contact.name}`, call:`Call ${m.contactAction.contact.name}`, text:`Text ${m.contactAction.contact.name}` }[m.contactAction.type]}</Btn>
                        </div>
                      )}
                      {/* The confirm/cancel card for a confirm-gated action streamReply
                          proposed (a delete, or send_email). Nothing behind this executes until
                          Confirm is actually tapped — for send_email that means showing the real
                          subject/body about to go out, not just a name, so review here means
                          something. */}
                      {m.pendingAction && !m.streaming && (
                        <div style={{ marginTop:10, padding:"10px 12px", background:C.accentBg, border:`1px solid ${C.accent}44`, borderRadius:10 }}>
                          {m.pendingAction.done ? (
                            <Mono style={{ color:C.soft }}>{m.pendingAction.outcome}</Mono>
                          ) : (
                            <>
                              <div style={{ fontSize:12.5, fontWeight:600, color:C.text, marginBottom:m.pendingAction.action.type==="send_email"?6:10 }}>{m.pendingAction.summary}</div>
                              {m.pendingAction.action.type === "send_email" && (
                                <Mono style={{ display:"block", color:C.muted, lineHeight:1.6, marginBottom:10, whiteSpace:"pre-wrap" }}>
                                  Subject: {m.pendingAction.action.subject}{"\n"}{m.pendingAction.action.body}
                                </Mono>
                              )}
                              <div style={{ display:"flex", gap:8 }}>
                                <Btn sm disabled={m.pendingAction.confirming} onClick={() => confirmPendingAction(m.id)}>
                                  {m.pendingAction.confirming ? <Spinner size={12} color={C.black} thickness={2} /> : "Confirm"}
                                </Btn>
                                <Btn sm v="outline" disabled={m.pendingAction.confirming} onClick={() => cancelPendingAction(m.id)}>Cancel</Btn>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    {m.role==="assistant" && !m.streaming && (
                      <div style={{ display:"flex", gap:8, marginTop:5, alignItems:"center" }}>
                        {[
                          { id:"copy", label:"Copy", onClick:() => copyMsg(m.content) },
                          { id:"share", label:"Share", onClick:() => shareMsg(m.content) },
                          { id:"play", label:"Read aloud", onClick:() => { if (window.speechSynthesis?.speaking) { stopSpeaking(); } else { speak(m.content); } } },
                          { id:"thumbsUp", label:"Good response", onClick:() => setMsgFeedback(i,"up"), active:m.feedback==="up" },
                          { id:"thumbsDown", label:"Bad response", onClick:() => setMsgFeedback(i,"down"), active:m.feedback==="down" },
                          // Retry truncates aiMessages to this index and regenerates from there,
                          // discarding everything after it — only safe on the most recent reply,
                          // so it's hidden on earlier ones to avoid silently deleting later
                          // conversation history.
                          ...(i === aiMessages.length - 1 ? [{ id:"retry", label:"Retry", onClick:() => regenerateReply(i), disabled:aiLoading }] : []),
                        ].map(a => (
                          <button key={a.id} onClick={a.onClick} disabled={a.disabled} title={a.label} aria-label={a.label}
                            style={{ background:"none", border:"none", padding:8, borderRadius:8, cursor:a.disabled?"not-allowed":"pointer", opacity:a.disabled?.4:1, display:"flex", alignItems:"center", justifyContent:"center" }}>
                            <NavIcon id={a.id} size={14} color={a.active?C.accent:C.muted} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {aiLoading && !aiMessages.some(m => m.streaming && m.content) && (
                  <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                    <Mono style={{ color:C.muted }}>KROFT</Mono>
                    <div style={{ display:"flex", gap:4 }}>{[0,1,2].map(i => <div key={i} style={{ width:6, height:6, borderRadius:"50%", background:C.white, animation:`pulse 1.2s ease-in-out ${i*.2}s infinite` }} />)}</div>
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
              {/* Only appears once someone has actually scrolled up to re-read earlier messages
                  — otherwise it'd sit there uselessly on every normal, already-at-bottom chat. */}
              {!chatNearBottom && aiMessages.length > 1 && (
                <button onClick={scrollChatToBottom} aria-label="Scroll to latest message" title="Scroll to latest"
                  style={{ position:"absolute", right:16, bottom:16, width:34, height:34, borderRadius:"50%", background:C.text, border:"none", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:C.shadowRaised, zIndex:1 }}>
                  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={C.card} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              )}
            </div>
            {/* Suggestions only make sense before a real conversation exists — once one is
                underway, this space is worth more to the actual messages than to prompts nobody
                needs anymore. */}
            {aiMessages.length <= 1 && (
              <div style={{ padding:"0 16px 12px", flexShrink:0, maxHeight:"32vh", overflowY:"auto" }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:6 }}>Ask about your data</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:7, marginBottom:12 }}>
                  {["What's on my schedule today?","Where is my money going?","What should I focus on?","How did this month compare?","Summarise my open tasks","How's my wellness today?"].map(q => (
                    <button key={q} onClick={() => askKroft(q)} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:"'Space Grotesk',sans-serif" }} onMouseEnter={e=>{e.target.style.borderColor=C.soft;e.target.style.color=C.white;}} onMouseLeave={e=>{e.target.style.borderColor=C.cardB;e.target.style.color=C.border;}}>
                      {q}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:6 }}>Or tell it to do something</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
                  {["Log a 5,000 fuel expense","Remind me to call the bank tomorrow","Add a task to send the invoice","Schedule a meeting Friday at 10"].map(q => (
                    <button key={q} onClick={() => askKroft(q)} style={{ background:C.card, border:`1px solid ${C.accent}44`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:"'Space Grotesk',sans-serif" }}>
                      {q}
                    </button>
                  ))}
                </div>
                <Mono style={{ display:"block", color:C.muted, marginTop:10, lineHeight:1.6 }}>
                  KROFT can see your finances, schedule, tasks and contacts, and can add things for you. It can't delete or edit — that stays with you.
                </Mono>
              </div>
            )}
            <div style={{ borderTop:`1px solid ${C.cardB}`, padding:"12px 16px calc(12px + env(safe-area-inset-bottom))", flexShrink:0, background:C.bg }}>
              {/* One rounded card holding both the textarea and its controls, instead of a
                  bare input row — the focus ring moves to this outer card (the textarea itself
                  has no border of its own now) so typing and the button row read as one control,
                  not two stacked ones. */}
              <div style={{
                background:C.surface, borderRadius:22, padding:"10px 10px 8px",
                border:`1px solid ${aiInputFocused ? C.accent : C.cardB}`,
                boxShadow:aiInputFocused ? `0 0 0 3px ${C.accentBg}` : "none",
                transition:"border-color .18s, box-shadow .18s",
              }}>
                {/* A plain single-line <Inp> couldn't hold more than one line at all — pasting
                    or composing anything longer just scrolled the text sideways out of view.
                    This grows with the content (capped at ~5 lines, then scrolls internally)
                    and keeps Enter-to-send / Shift+Enter-for-newline, the behavior every chat
                    app trains people to expect. */}
                <textarea
                  ref={aiInputRef}
                  value={aiInput}
                  onChange={e => {
                    setAiInput(e.target.value);
                    const el = e.target;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 120) + "px";
                  }}
                  onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); askKroft(); } }}
                  placeholder="Message KROFT…"
                  rows={1}
                  style={{ width:"100%", fontSize:13, fontFamily:"'Space Grotesk',sans-serif", background:"transparent", border:"none", padding:"4px 6px", color:C.text, outline:"none", resize:"none", maxHeight:120, overflowY:"auto", lineHeight:1.4, boxSizing:"border-box" }}
                  onFocus={() => setAiInputFocused(true)}
                  onBlur={() => setAiInputFocused(false)}
                />
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:2 }}>
                  {/* Reuses the existing "start over" action — there's no separate attach/upload
                      feature to put here, and a dead "+" would be worse than none at all. */}
                  <button onClick={startNewChat} aria-label="Start a new conversation" title="New chat"
                    style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:34, height:34, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <NavIcon id="plus" size={16} color={C.text} />
                  </button>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {/* Dictate-and-review: unlike the black button's live voice mode (a spoken
                        back-and-forth conversation), this records one utterance, transcribes it
                        into the text field via the same toggleListen already used elsewhere
                        (Notes' own Voice button), and stops there — reviewing before Send stays
                        possible, rather than sending the instant speech recognition finishes. */}
                    {SRSupported && !aiLoading && (
                      <button onClick={toggleListen} aria-label={listening ? "Stop recording" : "Dictate a message"} title={listening ? "Stop recording" : "Dictate a message"}
                        style={{ background:listening?C.accentBg:C.card, border:`1px solid ${listening?C.accent:C.cardB}`, borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <NavIcon id="mic" size={16} color={listening?C.accent:C.text} />
                      </button>
                    )}
                    {/* One button in one place: the mic sits there until you start typing, then it
                        becomes Send. Showing both at once meant a permanently greyed-out Send
                        taking up space next to a mic you'd use far more often. */}
                    {aiLoading ? (
                      <button onClick={stopReply} aria-label="Stop generating" title="Stop"
                        style={{ background:C.text, border:"none", borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <span style={{ width:11, height:11, borderRadius:3, background:C.card, display:"block" }} />
                      </button>
                    ) : aiInput.trim() ? (
                      <button onClick={() => askKroft()} aria-label="Send message" title="Send"
                        style={{ background:C.text, border:"none", borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", animation:"pop .18s ease" }}>
                        <NavIcon id="send" size={17} color={C.card} />
                      </button>
                    ) : (
                      <button onClick={() => { setVoiceOpen(true); setVoiceState("idle"); setVoiceError(""); }} aria-label="Open voice mode" title="Voice mode"
                        style={{ background:C.text, border:"none", borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <NavIcon id="waveform" size={17} color={C.card} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab==="profile" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <ProfileSection
              user={user}
              onUpdateName={name => setUser(u => ({ ...u, name }))}
              // Two different buttons used to share this one callback: "Manage connections"
              // (Calendar/Email rows) correctly wants the account-linking screen — that's
              // "prefs" — but "Personal Preferences" > "Edit details" wants Business
              // name/type/currency, which live on a DIFFERENT step ("business"). Sharing one
              // prop meant "Edit details" silently opened account-linking and edited none of
              // what it promised. Split into two so each button reaches the fields it actually
              // claims to edit.
              onEditPreferences={() => { setEditingFromProfile(true); setStep("prefs"); }}
              onEditBusinessDetails={() => { setEditingFromProfile(true); setStep("business"); }}
              onExportData={exportData}
              onImportData={importData}
              notifPermission={notifPermission}
              notifPrefs={notifPrefs}
              onEnableNotifications={async () => {
                const result = await requestNotifyPermission();
                setNotifPermission(result);
                if (result === "granted") {
                  sendNotification("Notifications on", "KROFT will let you know when something's due.", "kroft:welcome");
                  toast("Notifications enabled.");
                  subscribeToPush(authedFetch);
                }
                else if (result === "denied") toast("Notifications were blocked.");
              }}
              onSetNotifPref={(k, v) => setNotifPrefs(p => ({ ...p, [k]: v }))}
              onTestNotification={() => {
                const ok = sendNotification("Test from KROFT", "If you can see this, notifications are working.", "kroft:test");
                toast(ok ? "Test sent." : "Couldn't send — check your browser settings.");
              }}
              voiceTurnsCount={voiceTurnsCount}
              voiceLimit={voiceLimit}
              onSignOut={async () => {
                // Signing out previously only flipped `step` back to the login screen — every
                // bit of data stayed live in memory, so returning to the dashboard showed the
                // previous session's chat, finances and contacts untouched. End the real
                // Supabase session (so the refresh token this browser holds stops working) and
                // stop any speech still playing, then fully reset via onFullReset (see Kroft())
                // rather than clearing state field by field — with real accounts, a different
                // person can genuinely sign into this same browser next.
                if ("speechSynthesis" in window) window.speechSynthesis.cancel();
                if (isSupabaseConfigured) await supabase.auth.signOut();
                toast("Signed out.");
                // Short delay so the toast above is actually visible before onFullReset swaps
                // this whole component out for a clean instance.
                setTimeout(() => onFullReset?.(), 400);
              }}
              theme={theme}
              onToggleTheme={setTheme}
              toast={toast}
              subscribed={subscribed}
              subscriptionStatus={subscriptionStatus}
              autoRenews={autoRenews}
              billingLoading={billingLoading}
              onUpgrade={startCheckout}
              onManageBilling={cancelKroftPlus}
              voiceReplies={voiceReplies}
              onSetVoiceReplies={setVoiceReplies}
              proactiveInsights={proactiveInsights}
              onSetProactiveInsights={setProactiveInsights}
              voicePref={voicePref}
              onSetVoicePref={setVoicePref}
              voiceSpeed={voiceSpeed}
              onSetVoiceSpeed={setVoiceSpeed}
              onSetupBiometric={setupBiometric}
              onRemoveBiometric={removeBiometric}
              usageStats={{
                totalMessages: aiMessages.filter(m => m.role === "user").length,
                appts: appts.length,
                financeEntries: income.length + expenses.length,
                notes: notes.length,
                tasks: tasks.length,
              }}
            />
          </div>
        )}
      </main>

      {/* Bottom navigation — dark minimal pill, rounded icons, subtle glow on the active tab */}
      <nav style={{ position:"fixed", left:0, right:0, bottom:0, zIndex:250, display:"flex", justifyContent:"center", padding:"0 16px 18px", pointerEvents:"none" }}>
        <div style={{ display:"flex", alignItems:"center", gap:4, padding:"8px", borderRadius:28, background:theme==="dark"?"rgba(19,19,19,.82)":"rgba(255,255,255,.88)", backdropFilter:"blur(20px)", border:`1px solid ${C.cardB}`, boxShadow:C.shadowRaised, pointerEvents:"all" }}>
          {NAV_TABS.map(t => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => { haptic(12); setTab(t.id); if (t.id==="workspace") setWorkspaceSection(null); }} title={t.label} aria-current={active?"page":undefined}
                style={{
                  width:64, height:52, borderRadius:18, border:"none", cursor:"pointer",
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4,
                  // The active tab was previously marked only by a faint white wash and glow,
                  // which is nearly invisible on a light nav. A filled inverse pill reads at a
                  // glance in both themes.
                  background: active ? C.text : "transparent",
                  transition:"background .18s",
                }}>
                {/* Keyed on the active transition so the icon pops in fresh every time this
                    becomes the selected tab, not just background-fades like before. */}
                <span key={active ? `${t.id}-on` : t.id} style={{ display:"inline-flex", animation: active ? "tabPop .3s cubic-bezier(.34,1.56,.64,1)" : "none" }}>
                  <NavIcon id={t.id} size={20} color={active ? C.card : C.muted} />
                </span>
                <span style={{ fontSize:9, fontWeight:700, color: active ? C.card : C.muted, letterSpacing:.3, fontFamily:"'Space Grotesk',sans-serif" }}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

    </div>
  );
}

export default function Kroft() {
  // Bumped on sign-out to force KroftApp to fully unmount and remount, resetting every piece
  // of its state to its initial default in one guaranteed sweep. With real Supabase accounts,
  // a different person can genuinely sign into the same browser next — a `key` remount is the
  // reliable way to ensure nothing from the previous account (finance figures, contacts, chat
  // history, an in-progress edit) lingers in memory for the next one to see, rather than
  // auditing and manually resetting several dozen individual state variables by hand.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  return (
    <ErrorBoundary>
      <KroftApp key={sessionEpoch} onFullReset={() => setSessionEpoch(e => e + 1)} />
    </ErrorBoundary>
  );
}
