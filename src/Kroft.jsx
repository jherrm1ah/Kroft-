import { useState, useEffect, useRef, useCallback, useMemo, Component, Fragment, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { supabase, isSupabaseConfigured, supabaseUrl, supabaseAnonKey } from "./supabaseClient.js";
import { fmtCur, APP_FONT } from "./charts/format.js";
import { Markdown } from "./markdown/Markdown.jsx";
import { toPlainText, toSpeechText } from "./markdown/parse.js";
import { copyRich, copyPlain } from "./markdown/clipboard.js";
import { offlineUserId, flushPending, clearOfflineData, hasUnsyncedChanges, unreadableKeys } from "./storageShim.js";
import { DEFAULT_INVOICE_SETTINGS, invoiceTotals, invoiceStatus, invoiceAllowance, quoteAllowance, createInvoice, createQuote, invoiceFromQuote, invoiceProblem, FREE_INVOICES_PER_MONTH, FREE_QUOTES_PER_MONTH, whatsappLink, sendMessage, reminderMessage, quoteMessage, prettyDate, STATUS_LABEL, invoicesForAI, quotesForAI, daysBetween, docStatus, clientSummaries, clientKey } from "./invoices/model.js";
import { invoicePdf, invoiceFileName } from "./invoices/pdf.js";
import { saveFile } from "./saveFile.js";
import { isNativeApp, nativeRedirect, openInSystemBrowser, scheduleDeviceReminders, verifyBiometric, getAppPermissions, requestAppPermission, saveFileFromApp, exactAlarmStatus, openExactAlarmSetting, getClientHeader } from "./native.js";

// What a mic button says when listening fails, by the SpeechRecognition error code. Silence used
// to show "Mic error — check permissions." too, which sent people hunting through settings for a
// permission they had already given.
const MIC_PERMISSION_HINT = isNativeApp ? "Allow it in Profile → Security and login → App permissions." : "Allow it in your browser's site settings.";
// Android app: biometric unlock is a lock on the app itself, asked for when KROFT opens and
// when it comes back after a while in the background. (A sign-in button can't work for it:
// once someone logs out there's no session left on the phone for a fingerprint to unlock.)
const NATIVE_BIO_KEY = "kroft-native-biometric";
const APP_LOCK_AFTER_MS = 5 * 60 * 1000;
function readNativeBio() { try { return localStorage.getItem(NATIVE_BIO_KEY); } catch { return null; } }
function writeNativeBio(v) { try { if (v) localStorage.setItem(NATIVE_BIO_KEY, v); else localStorage.removeItem(NATIVE_BIO_KEY); } catch { /* storage unavailable */ } }

function micErrorText(code) {
  if (code === "aborted") return "";
  if (code === "no-speech") return "Didn't catch that. Tap the mic and try again.";
  if (code === "not-allowed" || code === "service-not-allowed") return `KROFT can't use the microphone. ${MIC_PERMISSION_HINT}`;
  if (code === "audio-capture") return "No working microphone found on this device.";
  if (code === "network") return "Couldn't turn your speech into text. Check your connection and try again.";
  return "The microphone stopped unexpectedly. Try again.";
}

// A lazy chunk fetched over a flaky mobile connection can fail with a plain network error —
// dynamic import() rejects, and React throws that straight into the nearest error boundary,
// crashing the whole app to the generic "Something went wrong" screen over what's really just a
// dropped request for one chart's code. Retries a couple of times with a short delay first, so a
// bad moment on the network doesn't take the session down.
const retryImport = (importFn, retriesLeft = 2, delayMs = 750) => importFn().catch(err => {
  if (retriesLeft > 0) {
    return new Promise(resolve => setTimeout(resolve, delayMs)).then(() => retryImport(importFn, retriesLeft - 1, delayMs));
  }
  // Out of retries. A message like this usually means the browser genuinely can't fetch that
  // exact file any more — most often because a new deployment replaced every chunk's filename
  // (they're content-hashed) since this tab last loaded index.html, so retrying the identical
  // stale URL can never succeed. Only a fresh page load re-reads the current index.html and picks
  // up the right filenames. Reloads at most once per tab (the sessionStorage flag), so a device
  // that's actually offline shows the normal error screen instead of reload-looping forever.
  const looksStale = /dynamically imported module|loading chunk|failed to fetch/i.test(err?.message || "");
  try {
    if (looksStale && !sessionStorage.getItem("kroftChunkReload")) {
      sessionStorage.setItem("kroftChunkReload", "1");
      window.location.reload();
      return new Promise(() => {}); // reloading now — never resolve, the reload takes over
    }
  } catch {
    // sessionStorage can throw in some restricted contexts (private/embedded webviews) — fall
    // through to the normal error boundary rather than let the safety net itself crash.
  }
  throw err;
});
// recharts is a large dependency only needed by these three charts — lazy-loading them keeps it
// out of the initial bundle so it's fetched only when a screen with a chart is actually opened.
const MonthlyTrendChart = lazy(() => retryImport(() => import("./charts/MonthlyTrendChart.jsx")));
const CategoryPieChart = lazy(() => retryImport(() => import("./charts/CategoryPieChart.jsx")));
const WellnessTrendChart = lazy(() => retryImport(() => import("./charts/WellnessTrendChart.jsx")));

// Theme-aware palette — black, white and off-white only, no grey scale.
// Dark mode: near-black surfaces, white/off-white text.
// Light mode: white/off-white surfaces, near-black text.
// Every token below meets or exceeds WCAG AA contrast against its paired surface.
const DARK = {
  bg:"#000000",
  // Cards were previously #0d0d0d — barely lighter than the #000 page behind them, so every
  // card leaned on its border alone for definition (the opposite of, e.g., ChatGPT's dark
  // settings rows, which are a genuinely solid, visible grey with no border needed at all).
  // Raised to a real grey, then dialed back down several times from the first pass (which read
  // too bright) — still clearly its own surface at a glance, just a darker one.
  card:"#181818", cardB:"#202020", surface:"#141414",
  hover:"#1c1c1c", white:"#ffffff", black:"#000000",
  offWhite:"#f4f2ee",
  text:"#ffffff",        // primary text — pure white on black, max contrast
  soft:"#dcd8d0",        // secondary text — bright off-white, clearly readable (was low-contrast grey)
  muted:"#9a968e",       // tertiary/placeholder — still readable, used sparingly
  border:"#2a2a2a",      // visible borders / dividers on dark surfaces — bumped alongside card/
                          // cardB above so a `hi` card's emphasis border/ring still reads clearly
                          // against the now-lighter card fill instead of nearly vanishing into it.
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
/* One-shot reactions for the mood orbs' faces (see MoodFace/MoodOrb) — each mood gets its own
   character instead of the same generic pop for all four: Calm eases into a slow breath, Happy
   bounces with a little joyful wobble, Stressed and Angry both shake but Angry sharper/faster,
   reading as more intense than merely uneasy. */
@keyframes moodCalmBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes moodHappyBounce{0%,100%{transform:translateY(0) rotate(0deg)}30%{transform:translateY(-4px) rotate(-8deg)}60%{transform:translateY(0) rotate(6deg)}100%{transform:translateY(0) rotate(0deg)}}
@keyframes moodStressedShake{0%,100%{transform:translateX(0) rotate(0deg)}20%{transform:translateX(-2px) rotate(-3deg)}40%{transform:translateX(2px) rotate(3deg)}60%{transform:translateX(-2px) rotate(-2deg)}80%{transform:translateX(2px) rotate(2deg)}}
@keyframes moodAngryShake{0%,100%{transform:translateX(0) rotate(0deg)}15%{transform:translateX(-3px) rotate(-5deg)}30%{transform:translateX(3px) rotate(5deg)}45%{transform:translateX(-3px) rotate(-4deg)}60%{transform:translateX(3px) rotate(4deg)}75%{transform:translateX(-2px) rotate(-2deg)}90%{transform:translateX(2px) rotate(2deg)}}
/* Slow ambient glow behind the Quick Reset countdown ring — a calmer, longer cycle than
   alarmPulse above, meant to read as "breathing" rather than an alert. */
@keyframes breathe{0%,100%{transform:scale(1);opacity:.35}50%{transform:scale(1.18);opacity:.75}}
/* Real blinks are infrequent (every few seconds) and brief — most of the cycle sits at
   scaleY(0) (eyelid hidden, eyes open), with a quick close-and-reopen near the end. */
@keyframes robotBlink{0%,90%,100%{transform:scaleY(0)}93%,95%{transform:scaleY(1)}}
`;

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
// Formats a Date's own LOCAL y/m/d as "YYYY-MM-DD". Unlike toISOString() (always UTC), this
// stays on whatever calendar day the Date's local getters say it is — the day the person is
// actually living in. Converting through UTC instead rolls the date a day early or late for part
// of every day anywhere off UTC (every evening in the Americas it already reads as tomorrow).
const ymdLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayISO = () => ymdLocal(new Date());
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
  return ymdLocal(d);
};
// Repeatedly advances an ISO date via advanceRepeatDate until it reaches or passes targetISO —
// the shared "catch this recurring item up to today" step for both rollRecurring (appointments)
// and completing an overdue recurring task. Bails out early rather than spinning forever if a
// step doesn't actually move the date forward, which advanceRepeatDate does on purpose for an
// unrecognized repeat cadence or an unparseable date (returns its input unchanged) — without this
// check, a malformed `repeat`/date from a hand-edited or corrupted backup would leave the while
// loop's condition permanently true and freeze the tab.
const advanceRepeatDateTo = (iso, repeat, targetISO) => {
  let date = iso;
  while (date < targetISO) {
    const next = advanceRepeatDate(date, repeat);
    if (next === date) break;
    date = next;
  }
  return date;
};
const monthLabel = iso => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month:"long", year:"numeric" }); };
// Appointment times are free text (the field's own placeholder is "Time e.g. 4:00 PM"), not a
// structured value, so finding "the next appointment" needs to parse that text into something
// comparable. Returns null for anything unparseable — blank, or free text that isn't a time —
// rather than guessing, so callers can decide how to place those relative to timed ones.
const parseApptTime = str => {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  const suffix = m[3]?.toLowerCase();
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  return h * 60 + min;
};
// Sorts appointments chronologically (date, then time-of-day) rather than leaving them in
// whatever order they were added or merged in from a synced calendar — appts is otherwise only
// ever appended/filtered/mapped, never sorted, so index 0 is not "the next one." An appointment
// with no parseable time sorts first within its day (treated as "could be anytime today").
const sortAppts = list => [...list].sort((a, b) => {
  if (a.date !== b.date) return (a.date||"") < (b.date||"") ? -1 : 1;
  return (parseApptTime(a.time) ?? -1) - (parseApptTime(b.time) ?? -1);
});
// Appointments have no duration field, so "conflict" can only mean "already something booked at
// this exact date+time" — not true overlap detection. Compared via parseApptTime (not string
// equality) so "4:00 PM" and one synced in as "16:00" are still recognized as the same slot.
// Time-less appointments (parseApptTime returns null) never conflict with anything, since
// there's no slot to collide with.
const findApptConflict = (list, date, time, excludeId) => {
  const mins = parseApptTime(time);
  if (mins == null) return null;
  return list.find(a => a.id !== excludeId && a.date === date && parseApptTime(a.time) === mins) || null;
};
const fmtMinsShort = mins => {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins/60), m = mins%60;
  return m ? `${h}h ${m}m` : `${h}h`;
};
// Appointments have no stored duration (see findApptConflict's own comment on the same
// limitation), so "in progress" vs "ended" can't be exact — this assumes a generic 60-minute
// length purely to decide which status phrase to show, the same default a calendar app falls
// back to for an untimed event. It's never treated as real data anywhere else — conflict
// detection above still only ever compares exact start times, nothing derived from this.
const ASSUMED_APPT_DURATION_MIN = 60;
function apptStatusLine(appt, now) {
  const startMins = parseApptTime(appt.time);
  if (startMins == null || appt.date !== todayISO()) return null;
  const diff = startMins - (now.getHours()*60 + now.getMinutes()); // >0 still to come, <=0 already started
  if (diff > 0) {
    if (diff > 180) return null; // more than 3 hours off isn't a timely nudge yet
    return { text:`Starts in ${fmtMinsShort(diff)}`, color:C.accent, dot:false };
  }
  const sinceStart = -diff;
  if (sinceStart < ASSUMED_APPT_DURATION_MIN) return { text:"In progress", color:C.negative, dot:true };
  const sinceEnd = sinceStart - ASSUMED_APPT_DURATION_MIN;
  if (sinceEnd > 720) return null; // more than 12h past its assumed end — too stale to mention
  return { text:`Ended · ${fmtMinsShort(sinceEnd)} ago`, color:C.muted, dot:false };
}
// Lower rank = more urgent = sorts first. The task list used to only ever group by done/not-done —
// priority was fully editable and stored but never actually affected ordering, so an "Urgent" task
// added after a "Low" one just sat below it.
const PRIORITY_RANK = { Urgent:0, High:1, Normal:2, Low:3 };

// Single source of truth for every mood-log consumer: the Overview quick-picker, the Wellness
// tab's mood-log tags, and moodToScore's day-aggregation. Previously each of those three kept its
// own independent {mood: color/score} map, so adding a mood meant remembering to update all three
// in lockstep — easy to miss one and end up with an entry the picker could log but the history
// list rendered with no color, or that never factored into the wellness score. KROFT deliberately
// tracks exactly these four moods — `color` is one of Tag's four supported tones, one per mood, no
// sharing needed at this count. score follows the existing happy=4..angry=1 scale — higher is
// better.
const MOOD_META = {
  calm:     { label:"Calm",     color:"positive", score:3 },
  happy:    { label:"Happy",    color:"accent",   score:4 },
  stressed: { label:"Stressed", color:"warning",  score:2 },
  angry:    { label:"Angry",    color:"negative", score:1 },
};
// A distinct glow palette for the Overview's mood orbs only (MoodOrb below) — kept separate from
// MOOD_META.color, which every other mood consumer (the Wellness mood log's tags, moodToScore)
// still uses. This card gets its own original, vivid identity without recoloring a mood's tag
// anywhere else in the app to match.
const MOOD_ORB_GLOW = {
  calm:     "112,196,165",
  happy:    "237,181,84",
  stressed: "121,148,222",
  angry:    "224,104,97",
};
// Same idea as MOOD_ORB_GLOW — a distinct, vivid identity per Wellness tab row icon (Your
// Patterns/Quick Reset/Sleep/Journal/Mood log) rather than every row reading identically in plain
// gray. Deliberately its own palette, not reused from MOOD_ORB_GLOW's mood colors, so a badge here
// never accidentally reads as "this feature = that mood."
const WELLNESS_ROW_GLOW = {
  patterns: "156,120,214",
  reset:    "222,150,68",
  sleep:    "84,132,214",
  journal:  "70,168,150",
  mood:     "226,104,150",
};

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

// Markdown is turned into spoken prose by toSpeechText (tables read row by row, copy-ready blocks
// read as their content, result figures as "label: value"). Streamed speech arrives in sentence
// fragments, so a fence can be split across two of them: whole code blocks are dropped first and
// any lone fence line is removed, so a stray closing fence is never read as a new code block.
const speechText = raw => toSpeechText(String(raw)
    .replace(/```(?!copy|result)[\w+#-]*\n[\s\S]*?```/gi, " Code block omitted. ")
    .replace(/^\s*```.*$/gm, ""))
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
// Checked against both the voice's display name and its voiceURI — Android's built-in TTS
// engine routinely exposes voices with a generic display name (e.g. "English (America)") that
// carries zero gender hint, while its underlying voiceURI encodes it instead (e.g.
// "...#male_1-local"). Name-only matching missed these entirely, which is exactly the class of
// device where the two heuristics below silently mattered most.
const voiceHints = (v, re) => re.test(v.name) || re.test(v.voiceURI || "");
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
  const female = []; take(v => voiceHints(v, FEMALE_VOICE_HINTS), 2, female);
  const male = []; take(v => voiceHints(v, MALE_VOICE_HINTS), 2, male);
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
    id:"ben", name:"Ben", gender:"male", style:"warm_calm_personal",
    traits:"Warm • Calm • Personal", isDefault:true,
    previewLine:"Hey, you've got two things coming up today. Want me to help you prioritise them?",
    speed:1.00, pauseMs:90, genderSlot:"male-1",
    // Configurable per the spec, not hardcoded inline: set VITE_TTS_VOICE_BEN to an exact
    // browser voice name (or a substring of one) to pin this persona to it. Unset (the common
    // case) falls back to the genderSlot heuristic above.
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_BEN || null,
  },
  atlas: {
    id:"atlas", name:"Atlas", gender:"male", style:"deep_analytical_professional",
    traits:"Deep • Professional • Analytical", isDefault:false,
    previewLine:"Your spending is above this month's target. I've identified three areas where you can reduce your expenses.",
    speed:0.87, pauseMs:130, genderSlot:"male-2",
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_ATLAS || null,
  },
  mira: {
    id:"mira", name:"Mira", gender:"female", style:"warm_elegant_reassuring",
    traits:"Warm • Elegant • Reassuring", isDefault:false,
    previewLine:"Good morning. You've got a busy day ahead, but I've already organised everything for you.",
    speed:0.97, pauseMs:100, genderSlot:"female-1",
    providerVoiceId: import.meta.env.VITE_TTS_VOICE_MIRA || null,
  },
  nova: {
    id:"nova", name:"Nova", gender:"female", style:"energetic_modern_expressive",
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

// Wired to KroftApp's toast() once it exists (same reasoning as the voice pref setters above —
// speak() lives outside React). speechSynthesis.speak() can fail completely silently on real
// devices with no exception and no error event: Android Chrome's own per-site "Sound" mute
// (long-press a tab → Site settings → Sound: Block) and a phone with no text-to-speech voice
// pack installed (Settings → Accessibility → Text-to-speech output) both produce exactly this —
// speak() runs, nothing throws, nothing plays. Neither condition is visible to JS, so the best
// speak() can do is notice the utterance never actually started and say so, instead of leaving
// someone staring at silence with no idea whether the tap even registered.
let notifyTtsFailure = null;
const setTtsFailureNotifier = fn => { notifyTtsFailure = fn; };

// Bumped by every function that takes over window.speechSynthesis (speak(), stopSpeaking(),
// speakSequence(), createSpeechQueue()) so an earlier, still-in-flight call can recognize it's
// been superseded. Without this, two overlapping calls fight over the single shared
// speechSynthesis queue: canceling one to start another fires the canceled utterance's onerror,
// which (before this token existed) unconditionally scheduled that OLD call's next chunk —
// so tapping a "stop" button mid-read didn't actually stop anything, it just skipped ahead and
// kept talking after a brief pause, and speak()'s own retry/failure-detection timers could fire
// for a call that had already been abandoned. Every chained callback below checks this token
// before touching speechSynthesis again; a mismatch means "a newer caller now owns speech,
// stand down silently."
let activeSpeechToken = 0;
const takeSpeechControl = () => ++activeSpeechToken;

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
  // Reaching here means the device didn't expose enough distinctly-gendered English voices to
  // fill every slot (common on Android and stripped-down browsers). This used to fall back to a
  // hardcoded female-leaning name list (Samantha/Google US English/Karen/Serena) for every
  // persona regardless of gender — so a male persona with no dedicated male voice available was
  // actively steered onto a female one instead of just leaving the choice to the platform.
  // Searching the same MALE/FEMALE hint regex the persona itself is keyed to keeps this
  // gender-consistent instead.
  const genderHints = profile.gender === "male" ? MALE_VOICE_HINTS : FEMALE_VOICE_HINTS;
  const fallback = vs.find(v => voiceHints(v, genderHints))
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
  const chunks = speechChunks(text);
  // Claims ownership of speech for this call — see takeSpeechControl's own comment. Every
  // callback below is guarded on `myToken === activeSpeechToken`; once it stops matching (a
  // newer speak()/stopSpeaking()/speakSequence()/createSpeechQueue() call took over), this call
  // goes silent instead of continuing to chunk through old text or firing a stale retry/toast.
  const myToken = takeSpeechControl();
  const isCurrent = () => myToken === activeSpeechToken;
  // Set once any utterance in this speak() call actually reports starting — checked below to
  // tell a genuine silent failure (nothing ever started, on either attempt) apart from a normal
  // short line that simply finished playing before the check fires.
  let beganSpeaking = false;
  let failureReported = false;
  // Android Chrome's speech engine has a well-known failure mode where the very next speak()
  // call after the page has sat idle for a while is silently dropped — no error, nothing plays —
  // but a second cancel()+speak() immediately after almost always un-sticks it. So a stall on the
  // first attempt gets one automatic retry from a clean slate before this ever bothers the person
  // with a toast; only a SECOND silent stall is treated as something they actually need to act on.
  const attempt = (attemptNum) => {
    if (!isCurrent()) return;
    window.speechSynthesis.cancel();
    let started = false;
    const run = () => {
      if (started || !isCurrent()) return;
      started = true;
      const { profile, voice } = pickVoiceForPersona(opts.voiceId);
      const { rate, pauseMs } = computeDelivery(profile, opts.context);
      let i = 0;
      const next = () => {
        if (!isCurrent() || i >= chunks.length) return;
        const isFirst = i === 0;
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        u.rate = rate; u.pitch = 1.0; applyVoice(u, voice);
        u.onstart = () => { beganSpeaking = true; };
        u.onend = () => setTimeout(next, pauseMs);
        u.onerror = () => setTimeout(next, pauseMs);
        window.speechSynthesis.speak(u);
        // Only the first chunk of each attempt needs watching — if that one plays, the rest are
        // presumed fine. 1.8s is generous enough that a slow-starting engine isn't flagged as
        // stalled, but short enough that a real failure surfaces (or retries) quickly.
        if (isFirst) setTimeout(() => {
          if (!isCurrent() || beganSpeaking || failureReported || window.speechSynthesis.speaking) return;
          if (attemptNum === 1) { attempt(2); return; }
          failureReported = true;
          notifyTtsFailure?.("Nothing played, even after retrying. Check this site isn't muted (Chrome: ⋮ menu → Site settings → Sound) and that a text-to-speech voice is installed on this device (Settings → Accessibility → Text-to-speech output).");
        }, 1800);
      };
      next();
    };
    if (!window.speechSynthesis.getVoices().length) {
      // Wait one tick for voices to arrive rather than speaking with none selected.
      window.speechSynthesis.addEventListener("voiceschanged", run, { once:true });
      setTimeout(run, 250);
    } else run();
  };
  attempt(1);
}
const stopSpeaking = () => { if ("speechSynthesis" in window) { takeSpeechControl(); window.speechSynthesis.cancel(); } };

// Speaks a list of lines in order, reporting which line is currently being read. Lets the UI
// follow the audio instead of guessing with a fixed timer — a timer drifts as soon as one line
// is longer than another, so the highlighted line stops matching the words being spoken.
// Speaks a reply as it is still being generated. Waiting for the whole response before saying
// anything is the single worst part of a voice assistant — several seconds of silence where the
// person can't tell if it heard them. This queues each complete sentence the moment it lands, so
// KROFT starts talking almost immediately and the rest arrives while it's still speaking.
function createSpeechQueue({ onStart, onDone, context } = {}) {
  // See takeSpeechControl's own comment — claims speech now so a concurrent plain speak() call
  // (or another createSpeechQueue/speakSequence) can't fight this one for control of the single
  // shared speechSynthesis queue.
  const myToken = takeSpeechControl();
  let spokenUpTo = 0;      // how much of the incoming text has been queued
  let queue = [];
  let speaking = false;
  let finished = false;
  let cancelled = false;
  let started = false;
  let delivery = null;

  const drain = () => {
    if (cancelled || speaking || myToken !== activeSpeechToken) return;
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
  // See takeSpeechControl's own comment — claims speech now so a concurrent plain speak() call
  // (or another speakSequence/createSpeechQueue) can't fight this one for control of the single
  // shared speechSynthesis queue.
  const myToken = takeSpeechControl();
  window.speechSynthesis.cancel();
  let cancelled = false;
  const isCurrent = () => !cancelled && myToken === activeSpeechToken;
  // See speak()'s comment — guarding solely on speechSynthesis.speaking is racy, since a short
  // first line can finish before the 250ms fallback even runs, making the fallback re-trigger
  // the whole sequence (reading every line again from the start). `started` makes this
  // idempotent regardless of which of the two triggers below fires first.
  let started = false;
  const start = () => {
    if (started || !isCurrent()) return;
    started = true;
    const { profile, voice } = pickVoiceForPersona(voiceId);
    const { rate, pauseMs } = computeDelivery(profile, context);
    let li = 0;
    const speakLine = () => {
      if (!isCurrent()) return;
      if (li >= lines.length) { onDone?.(); return; }
      const current = li;
      onLine?.(current);
      const chunks = speechChunks(speechText(lines[current]));
      let ci = 0;
      const nextChunk = () => {
        if (!isCurrent()) return;
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
  // Radii pulled in from 22/18/12 (see below) then nudged back up a couple px from that — large
  // rounding reads fine on one card, but stacking several per screen (Finance alone runs
  // eight-plus) turned every one of them into an obviously separate bubble instead of one calm
  // layout. 20/16/12 is the modest middle: every card in the app reads at the same softness as
  // the ones already tuned individually this way (Tasks/Projects/Calendar/Email), without going
  // back to the bubble-y original.
  raised: { radius:20, pad:20, shadow:() => C.shadowRaised },
  base:   { radius:16, pad:16, shadow:() => C.shadowBase },
  // inset was left at the old 12 during that pass — almost every use of it is a single, centered
  // "nothing here yet" empty-state card (never stacked, so the bubble concern above doesn't
  // apply), which is exactly the kind of card that reads worst when it's the sharpest-cornered
  // thing on the whole screen. Raised to match `raised` above.
  inset:  { radius:20, pad:12, shadow:() => "none" },
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
const Btn = ({ children, onClick, v="solid", sm, disabled, full, style, light, "aria-label":ariaLabel }) => {
  const oc = light ? LIGHT : C;
  const m = {
    solid: { bg:oc.white, bc:oc.white, col:oc.black },
    outline: { bg:"transparent", bc:oc.muted, col:oc.soft },
    ghost: { bg:"transparent", bc:"transparent", col:oc.border },
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
    <button onClick={handleClick} disabled={disabled} aria-label={ariaLabel} style={{ width:full?"100%":"auto", minWidth:sm&&isIconOnly?36:"auto", minHeight:sm?36:44, background:s.bg, border:`1px solid ${s.bc}`, borderRadius:12, padding:sm?"8px 14px":"10px 22px", cursor:disabled?"not-allowed":"pointer", color:s.col, fontWeight:700, fontSize:sm?12:13, fontFamily:APP_FONT, letterSpacing:.3, transition:"all .18s cubic-bezier(.34,1.56,.64,1)", opacity:disabled?.4:1, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6, boxSizing:"border-box", ...style }}>
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
  // onClose is passed at nearly every call site as an inline arrow (`onClose={() => setX(false)}`),
  // a fresh function identity on every render of the parent — including a render triggered by
  // typing a single character into a field inside this very dialog. That used to sit directly in
  // this effect's dependency array, so every keystroke re-ran the whole effect below: it steals
  // focus onto the dialog's first focusable element (typically its ✕ close button) every time it
  // runs, which yanked focus straight out of whatever the person was typing into and dismissed the
  // on-screen keyboard — needing a tap back into the field for every single letter. Reading the
  // latest onClose through a ref instead lets the effect depend on nothing but `active`, so it
  // only ever runs on mount/unmount, while Escape still always calls the current onClose.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current?.(); return; }
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
  }, [active]);
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
    const n = new Notification(title, { body, tag, badge:"/icons/badge-96.png", icon:"/icons/icon-192.png", requireInteraction: !!opts.requireInteraction });
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

// Minimal, original expressions for KROFT's four tracked moods — thick, rounded, single-stroke
// shapes so each reads instantly at the orb's modest on-screen size, in the same friendly,
// hand-drawn spirit as the reference the mood-orb design brief was built from, without copying
// its exact geometry.
function MoodFace({ mood, size = 28, style }) {
  const stroke = "#20222b";
  const s = { stroke, strokeWidth:7, strokeLinecap:"round", strokeLinejoin:"round", fill:"none" };
  if (mood === "calm") return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={style}>
      <path d="M26 44 Q34 38 42 44" {...s} />
      <path d="M58 44 Q66 38 74 44" {...s} />
      <path d="M34 65 Q50 75 66 65" {...s} />
    </svg>
  );
  if (mood === "happy") return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={style}>
      <path d="M24 42 Q34 28 44 40" {...s} />
      <path d="M56 40 Q66 28 76 42" {...s} />
      <path d="M27 59 Q50 88 73 59 Q50 73 27 59 Z" fill={stroke} stroke="none" />
    </svg>
  );
  if (mood === "stressed") return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={style}>
      <path d="M24 36 L44 47" {...s} />
      <path d="M76 36 L56 47" {...s} />
      <circle cx="34" cy="57" r="5" fill={stroke} />
      <circle cx="66" cy="57" r="5" fill={stroke} />
      <path d="M29 77 Q37 68 45 77 T61 77 T73 77" {...s} />
    </svg>
  );
  // angry
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={style}>
      <path d="M24 33 L46 46" {...s} />
      <path d="M76 33 L54 46" {...s} />
      <circle cx="34" cy="58" r="5" fill={stroke} />
      <circle cx="66" cy="58" r="5" fill={stroke} />
      <path d="M31 79 Q50 64 69 79" {...s} />
    </svg>
  );
}
// One-shot animation played on the face itself when its mood is (re-)selected — see the
// matching @keyframes above. Kept separate from MOOD_ORB_GLOW/MOOD_META since this is purely a
// per-tap animation name, not a persistent color or score.
const MOOD_FACE_ANIM = {
  calm:     "moodCalmBreathe .6s ease-in-out",
  happy:    "moodHappyBounce .5s ease-in-out",
  stressed: "moodStressedShake .5s ease-in-out",
  angry:    "moodAngryShake .5s ease-in-out",
};

// A soft, glowing 3D-style orb for one of KROFT's four moods — a radial gradient plus a matching
// outer glow stands in for real depth/lighting without an actual 3D asset. Keyed on its own tap
// counter (not just `mood`) so the pop-in animation replays on every tap, including tapping a
// mood that was already active a moment ago — otherwise re-selecting the same mood twice in a row
// would only animate the first time.
function MoodOrb({ mood, label, active, onClick }) {
  const [tap, setTap] = useState(0);
  const glow = MOOD_ORB_GLOW[mood];
  return (
    <button onClick={() => { setTap(t => t+1); onClick(); }} aria-label={label} aria-pressed={active}
      style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4, background:"none", border:"none", cursor:"pointer", padding:2, WebkitTapHighlightColor:"transparent" }}>
      <div key={`${mood}-${tap}`} style={{
        // A fixed pixel size, not a percentage of the button — the button itself is a
        // shrink-to-fit flex column with no declared width, so a percentage-width orb here
        // resolved against that auto width, which is itself set by the button's OTHER child
        // (the label). Since "Stressed"/"Angry" are wider text than "Calm"/"Happy", those two
        // buttons ended up wider, and the orb followed suit — same mood, visibly different
        // orb sizes. A fixed diameter makes every orb identical regardless of its label's width.
        width:44, height:44, borderRadius:"50%",
        background:`radial-gradient(circle at 32% 26%, rgba(${glow},1) 0%, rgba(${glow},.82) 55%, rgba(${glow},.6) 100%)`,
        boxShadow: active ? `0 0 0 2.5px rgba(${glow},.85), 0 6px 14px rgba(${glow},.4)` : `0 3px 9px rgba(${glow},.22)`,
        display:"flex", alignItems:"center", justifyContent:"center",
        animation: active ? "bouncePop .4s cubic-bezier(.34,1.56,.64,1)" : "none",
      }}>
        <MoodFace mood={mood} size={20} style={{ transformOrigin:"center", animation: active ? MOOD_FACE_ANIM[mood] : "none" }} />
      </div>
      <span style={{ fontSize:11, fontWeight:700, color: active ? `rgb(${glow})` : C.soft, fontFamily:APP_FONT }}>{label}</span>
    </button>
  );
}

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

const Inp = ({ id, placeholder, value, onChange, type="text", inputMode, style, onKeyDown, light, ...rest }) => {
  const oc = light ? LIGHT : C;
  return (
    <input id={id} type={type} inputMode={inputMode} placeholder={placeholder} value={value} onChange={onChange} onKeyDown={onKeyDown} {...rest}
      style={{ width:"100%", background:oc.surface, border:`1px solid ${oc.cardB}`, borderRadius:12, padding:"11px 14px", color:oc.text, fontSize:13, fontFamily:APP_FONT, outline:"none", transition:"border-color .18s", boxSizing:"border-box", ...style }}
      onFocus={e => { e.target.style.borderColor=oc.accent; e.target.style.boxShadow=`0 0 0 3px ${oc.accentBg}`; }} onBlur={e => { e.target.style.borderColor=oc.cardB; e.target.style.boxShadow="none"; }} />
  );
};

// Used everywhere for small/secondary text (labels, subtitles, hints) — kept the name Mono from
// when it used an actual monospace font, but that made easily-confused characters (1/l/I, 0/O)
// harder to tell apart at 11px, exactly where the extra clarity matters most. Same sans-serif as
// the rest of the app now, just smaller and softer-colored.
const Mono = ({ children, style, light }) => (
  <span style={{ fontFamily:APP_FONT, fontSize:11, color:(light?LIGHT:C).soft, ...style }}>{children}</span>
);

const CategorySelect = ({ value, onChange, cats, onAddCategory, style }) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  if (adding) {
    return (
      <div style={{ display:"flex", gap:5, ...style }}>
        <input autoFocus value={draft} onChange={e=>setDraft(e.target.value)} placeholder="New category" onKeyDown={e=>{ if (e.key==="Enter" && draft.trim()) { onAddCategory(draft.trim()); onChange(draft.trim()); setDraft(""); setAdding(false); } if (e.key==="Escape") { setAdding(false); setDraft(""); } }} style={{ width:100, background:C.surface, border:`1px solid ${C.soft}`, borderRadius:12, padding:"11px 10px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }} />
        <button onClick={() => { if (draft.trim()) { onAddCategory(draft.trim()); onChange(draft.trim()); } setDraft(""); setAdding(false); }} style={{ background:C.white, border:"none", borderRadius:12, padding:"0 10px", color:C.black, fontSize:12, fontWeight:700, cursor:"pointer" }}>✓</button>
      </div>
    );
  }
  return (
    <select value={value} onChange={e => e.target.value==="__add__" ? setAdding(true) : onChange(e.target.value)} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", ...style }}>
      {cats.map(c => <option key={c}>{c}</option>)}
      <option value="__add__">+ Add category…</option>
    </select>
  );
};

const Tag = ({ children, hi, tone, style, light }) => {
  const oc = light ? LIGHT : C;
  const toneColor = tone && { positive:oc.positive, negative:oc.negative, warning:oc.warning, accent:oc.accent }[tone];
  const toneBg = tone && { positive:oc.positiveBg, negative:oc.negativeBg, warning:oc.warningBg, accent:oc.accentBg }[tone];
  return (
    <span style={{
      background: toneColor ? toneBg : (hi?oc.text:oc.surface),
      color: toneColor || (hi?oc.invText:oc.soft),
      border: toneColor ? `1px solid ${toneColor}55` : (hi?"none":`1px solid ${oc.border}`),
      borderRadius:7, padding:"2px 8px", fontSize:10, fontWeight:600, letterSpacing:.4, whiteSpace:"nowrap", fontFamily:APP_FONT,
      ...style
    }}>
      {children}
    </span>
  );
};

// The launch splash: "Kroft" set in type on KROFT's cream background. Its styles (the
// .boot-splash and .kroft-wordmark classes, and the embedded wordmark font) live in index.html,
// which draws this same splash before the app's script has loaded, so the hand-over is seamless.
function SplashScreen({ fading }) {
  return (
    <div className="boot-splash" aria-hidden="true" style={{ zIndex:9999, opacity:fading?0:1, transition:"opacity .6s ease", pointerEvents:fading?"none":"all" }}>
      <span className="kroft-wordmark">Kroft</span>
    </div>
  );
}

// The KROFT mark: two stacked rounded bars.
const KroftMark = ({ size = 50, color = "#14161a" }) => (
  <svg viewBox="0 0 50 40" width={size} height={size * 0.8} aria-hidden="true" style={{ display:"block" }}>
    <rect x="0" y="0" width="50" height="18.5" rx="9.25" fill={color} />
    <rect x="0" y="21.5" width="50" height="18.5" rx="9.25" fill={color} />
  </svg>
);

const GoogleG = ({ size = 20 }) => (
  <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
  </svg>
);

// First screen for anyone not signed in: full screen, brand centered, sign-in buttons pinned to
// the bottom. Always light, matching the rest of account creation.
// Phone and Google both sign in OR create an account (the code/redirect proves who you are
// either way), so only email needs a separate "Log in" path for returning users.
// ── Chat history search ──
// A query matches a message when every word in it appears somewhere in that message, in any
// order ("rent march" finds "March rent is due"), which is how people actually half-remember a
// conversation.
const searchTerms = q => q.toLowerCase().split(/\s+/).filter(Boolean);
const escapeRegExp = t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textMatches = (text, terms) => { const t = (text || "").toLowerCase(); return terms.every(w => t.includes(w)); };
// A short window of the message around the first matched word, so the result shows why it matched.
const matchSnippet = (text, terms, before = 36, after = 90) => {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map(w => lower.indexOf(w)).filter(i => i >= 0));
  if (!isFinite(at)) return flat.slice(0, before + after);
  const start = Math.max(0, at - before);
  const cut = flat.slice(start, at + after);
  // Drop a word cut in half at the start, but only if that happens before the match.
  const firstSpace = cut.indexOf(" ");
  const body = start > 0 && firstSpace >= 0 && firstSpace < at - start ? cut.slice(firstSpace + 1) : cut;
  return (start > 0 ? "…" : "") + body + (at + after < flat.length ? "…" : "");
};
// Finds where a conversation matches: the first message containing every word (so opening the
// result can jump there), otherwise its title.
const findChatMatch = (title, messages, terms) => {
  const idx = (messages || []).findIndex(m => textMatches(m.content, terms));
  if (idx >= 0) return { msgIndex: idx, role: messages[idx].role, snippet: matchSnippet(messages[idx].role === "assistant" ? toPlainText(messages[idx].content) : messages[idx].content, terms) };
  if (textMatches(title, terms)) return { msgIndex: null, role: null, snippet: null };
  return null;
};
// Wraps every matched word in a highlight.
function Highlight({ text, terms }) {
  if (!terms.length || !text) return text || null;
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi"));
  return parts.map((part, i) => terms.includes(part.toLowerCase())
    ? <mark key={i} style={{ background:C.accentBg, color:C.text, fontWeight:600, borderRadius:3, padding:"0 1px" }}>{part}</mark>
    : <Fragment key={i}>{part}</Fragment>);
}
// Today / Yesterday / Previous 7 days / Older, for scanning the list when not searching.
const chatHistoryGroup = ts => {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const t = startOfToday.getTime();
  if (ts >= t) return "Today";
  if (ts >= t - 86400000) return "Yesterday";
  if (ts >= t - 7 * 86400000) return "Previous 7 days";
  return "Older";
};

function WelcomeScreen({ onPhone, onGoogle, onEmail, onLogIn, googleLoading }) {
  const pill = { width:"100%", height:56, borderRadius:999, display:"flex", alignItems:"center", justifyContent:"center", gap:12, fontSize:"clamp(14px, 4.4vw, 17px)", whiteSpace:"nowrap", fontWeight:600, fontFamily:APP_FONT, cursor:"pointer", letterSpacing:-.1 };
  // KROFT's own light palette (see LIGHT): warm cream background, near-black ink, warm beige
  // borders, indigo accent for the one link. Matches the splash before it and the account
  // creation screens after it, so the brand reads as one surface from launch to dashboard.
  const ink = LIGHT.text, paper = LIGHT.card;
  const outlinePill = { ...pill, background:paper, color:ink, border:`1.5px solid ${LIGHT.border}` };
  return (
    <div style={{ position:"fixed", inset:0, zIndex:900, overflowY:"auto", background:LIGHT.bg, display:"flex", flexDirection:"column" }}>
      {/* Brand centered in all the space above the buttons. */}
      <div style={{ flex:1, minHeight:220, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:22, padding:"24px", animation:"fadeUp .5s ease" }}>
        <KroftMark size={72} color={ink} />
        <h1 style={{ fontSize:42, fontWeight:700, color:ink, letterSpacing:-1.4, margin:0 }}>Kroft</h1>
      </div>
      <div style={{ width:"100%", maxWidth:480, margin:"0 auto", boxSizing:"border-box", padding:"0 clamp(16px, 6vw, 28px) calc(18px + env(safe-area-inset-bottom))", display:"flex", flexDirection:"column", gap:12 }}>
        {/* The one filled button is KROFT indigo, the brand accent, so the welcome screen carries the
            brand colour rather than a generic black. White on #4f5389 is about 7:1 contrast. */}
        <button onClick={onPhone} style={{ ...pill, background:LIGHT.accent, color:"#fff", border:"none", boxShadow:"0 10px 24px rgba(79,83,137,.28)" }}>
          <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true"><path fill="#fff" d="M6.6 3h2.7c.4 0 .8.3.9.7l1 3.6c.1.4 0 .8-.3 1L9.2 9.8a13 13 0 0 0 5 5l1.5-1.7c.3-.3.7-.4 1-.3l3.6 1c.4.1.7.5.7.9v2.7c0 1-.8 1.8-1.8 1.8C10.4 19.2 3.8 12.6 3.8 4.8 3.8 3.8 4.6 3 5.6 3z" /></svg>
          Continue with phone number
        </button>
        <button onClick={onGoogle} disabled={googleLoading} style={{ ...outlinePill, cursor:googleLoading?"wait":"pointer" }}>
          {googleLoading ? <Spinner size={20} color={ink} thickness={2} /> : <GoogleG size={22} />}
          Continue with Google
        </button>
        <button onClick={onEmail} style={outlinePill}>
          <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" fill={ink} /><path d="M3.2 6.4 12 13l8.8-6.6" stroke={paper} strokeWidth="1.7" fill="none" strokeLinejoin="round" /></svg>
          Sign up with email
        </button>
        <button onClick={onLogIn} style={{ marginTop:4, padding:"8px", background:"none", border:"none", cursor:"pointer", fontFamily:APP_FONT, fontSize:14.5, color:LIGHT.muted }}>
          Already have an account? <span style={{ color:LIGHT.accent, fontWeight:700, textDecoration:"underline" }}>Log in</span>
        </button>
        <p style={{ margin:"2px 8px 0", textAlign:"center", fontSize:12.5, lineHeight:1.5, color:LIGHT.muted }}>
          By continuing, you agree to KROFT's <a href="/terms.html" target="_blank" rel="noopener" style={{ color:LIGHT.soft, textDecoration:"underline" }}>Terms</a> and
          {" "}<a href="/privacy.html" target="_blank" rel="noopener" style={{ color:LIGHT.soft, textDecoration:"underline" }}>Privacy Policy</a>.
        </p>
      </div>
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

// The robot mascot icon (kroft-robot-badge.webp, background removed) used on auth screens and
// the Ask Kroft empty state. Two small overlay shapes sit exactly over the photo's own eye
// arcs, colored to match its screen's exact near-black tone (#1c1b1a, sampled from the asset)
// so at rest they're invisible against it — the robotBlink keyframe (see ANIM) briefly scales
// them up to cover the eyes and back down, simulating a blink without needing separate eye
// layers baked into the image itself. Positions are percentages of the image's own pixel
// dimensions (measured directly from the 512×512 asset), so they stay aligned at any size.
const RobotIcon = ({ size=48 }) => (
  <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
    <img src="/kroft-robot-badge.webp" alt="" style={{ width:"100%", height:"100%", display:"block", objectFit:"contain" }} />
    <div style={{ position:"absolute", left:"32.6%", top:"45%", width:"15%", height:"8%", background:"#1c1b1a", borderRadius:"40%", transformOrigin:"center", animation:"robotBlink 4.8s ease-in-out infinite" }} />
    <div style={{ position:"absolute", left:"52.4%", top:"45%", width:"15%", height:"8%", background:"#1c1b1a", borderRadius:"40%", transformOrigin:"center", animation:"robotBlink 4.8s ease-in-out infinite" }} />
  </div>
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
    case "image":
      return <svg viewBox="0 0 24 24" style={s}><rect x="3.5" y="4.5" width="17" height="15" rx="2" {...p} /><circle cx="8.5" cy="9.5" r="1.5" {...p} /><path d="m5 17 5-5 3.5 3.5L18 11l1.5 1.5" {...p} /></svg>;
    case "file":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6.5 3.5h8l4 4v13h-12z" {...p} /><path d="M14.5 3.5v4h4" {...p} /></svg>;
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
    // ---- Wellness feature icons ----
    case "moon": // Sleep
      return <svg viewBox="0 0 24 24" style={s}><path d="M18.5 14.5A7.5 7.5 0 0 1 9.5 5.5a7.5 7.5 0 1 0 9 9z" {...p} /></svg>;
    case "journal": // Wellness Journal
      return <svg viewBox="0 0 24 24" style={s}><path d="M6.5 4h9.5a1.5 1.5 0 0 1 1.5 1.5v14l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5v-14A1.5 1.5 0 0 1 6.5 4z" {...p} /><path d="M9 8.5h6M9 11.5h6" {...p} /></svg>;
    case "patterns": // Your Patterns
      return <svg viewBox="0 0 24 24" style={s}><circle cx="6" cy="17" r="2" {...p} /><circle cx="12" cy="7" r="2" {...p} /><circle cx="18" cy="14" r="2" {...p} /><path d="M7.7 15.7 10.4 8.8M13.6 8.3l2.9 4.2" {...p} /></svg>;
    case "timer": // Quick Reset
      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="13" r="8" {...p} /><path d="M12 13V9M9.5 3.5h5" {...p} /></svg>;
    case "camera":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" {...p} /><circle cx="12" cy="13" r="3.4" {...p} /></svg>;
    case "paperclip":
      return <svg viewBox="0 0 24 24" style={s}><path d="M15.5 7.5 9 14a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7.2 7.2a6 6 0 0 0 8.5 8.5L19 15.4" {...p} /></svg>;
    case "receipt":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6.5 3.5h11v17l-2.2-1.5-2.2 1.5-2.2-1.5-2.2 1.5-2.2-1.5z" {...p} /><path d="M9 8h6M9 11.5h6M9 15h3.5" {...p} /></svg>;
    // ---- Profile settings icons ----
    case "store":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 9.5 5.5 4.5h13L20 9.5" {...p} /><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" {...p} /><path d="M5.5 12v7.5h13V12M10 19.5v-4.5h4v4.5" {...p} /></svg>;
    case "crown":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4 8l4 3.5L12 5l4 6.5L20 8l-1.5 9.5h-13z" {...p} /><path d="M6 20.5h12" {...p} /></svg>;
    case "gauge":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 17a8 8 0 1 1 15 0" {...p} /><path d="M12 13.5l3.5-4" {...p} /><circle cx="12" cy="14" r="1.2" {...p} /></svg>;
    case "at":
      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="3.5" {...p} /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" {...p} /></svg>;
    case "link":
      return <svg viewBox="0 0 24 24" style={s}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" {...p} /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" {...p} /></svg>;
    case "contrast":
      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="8.5" {...p} /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill={color} stroke="none" /></svg>;
    case "wand":
      return <svg viewBox="0 0 24 24" style={s}><path d="M5 19 15.5 8.5M14 7l3 3" {...p} /><path d="M18 3.5v3M16.5 5h3M20 10.5v2M19 11.5h2M8.5 4v2M7.5 5h2" {...p} /></svg>;
    case "lock":
      return <svg viewBox="0 0 24 24" style={s}><rect x="5" y="10.5" width="14" height="10" rx="2.5" {...p} /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2" {...p} /></svg>;
    case "eye":
      return <svg viewBox="0 0 24 24" style={s}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...p} /><circle cx="12" cy="12" r="3" {...p} /></svg>;
    case "cloud":
      return <svg viewBox="0 0 24 24" style={s}><path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.7 3.7 0 0 1 17.5 18.5z" {...p} /><path d="M12 16v-5M9.8 13.2 12 11l2.2 2.2" {...p} /></svg>;
    case "flag":
      return <svg viewBox="0 0 24 24" style={s}><path d="M5.5 21V4" {...p} /><path d="M5.5 4.5h11l-2 4 2 4h-11" {...p} /></svg>;
    case "phone":
      return <svg viewBox="0 0 24 24" style={s}><path d="M6.6 3.5h2.6l1.3 4-1.9 1.4a12 12 0 0 0 6.5 6.5l1.4-1.9 4 1.3v2.6a2 2 0 0 1-2 2A16 16 0 0 1 4.6 5.5a2 2 0 0 1 2-2z" {...p} /></svg>;
    case "search":
      return <svg viewBox="0 0 24 24" style={s}><circle cx="10.5" cy="10.5" r="6.5" {...p} /><path d="m15.5 15.5 4.5 4.5" {...p} /></svg>;
    case "trash":
      return <svg viewBox="0 0 24 24" style={s}><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12.2M10 10.5v6M14 10.5v6" {...p} /></svg>;
    case "logout":
      return <svg viewBox="0 0 24 24" style={s}><path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" {...p} /><path d="M14.5 8 18.5 12l-4 4M18.5 12H9.5" {...p} /></svg>;
    case "smile": // Mood log
      return <svg viewBox="0 0 24 24" style={s}><circle cx="12" cy="12" r="8.5" {...p} /><path d="M9 10.5v.01M15 10.5v.01" {...p} /><path d="M8.5 14.5c1 1.3 2.4 2 3.5 2s2.5-.7 3.5-2" {...p} /></svg>;
    default:
      return null;
  }
};

// ── Sign-up and sign-in screens ──
// One full-screen layout for every step after Welcome, so the whole journey reads as one surface:
// KROFT's cream background, a round back button, a thin progress bar on the setup steps, a large
// title, and the main action pinned to the bottom where a thumb reaches it. `pal` is LIGHT for the
// sign-up journey; editing business details later from Profile passes the user's own theme (C).
const SETUP_STEPS = ["photo", "business", "prefs"];

function AuthScreen({ pal = LIGHT, onBack, backLabel = "Back", step, right, title, subtitle, children, footer }) {
  const stepIdx = SETUP_STEPS.indexOf(step);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:900, background:pal.bg, display:"flex", flexDirection:"column", fontFamily:APP_FONT }}>
      <div style={{ display:"flex", alignItems:"center", gap:14, padding:"calc(12px + env(safe-area-inset-top)) 16px 8px", flexShrink:0, minHeight:48 }}>
        {onBack ? (
          <button onClick={onBack} aria-label={backLabel}
            style={{ width:44, height:44, borderRadius:"50%", border:`1px solid ${pal.cardB}`, background:pal.card, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0 }}>
            <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke={pal.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : <div style={{ width:44, flexShrink:0 }} />}
        {stepIdx >= 0 ? (
          <div role="progressbar" aria-label="Setup progress" aria-valuemin={1} aria-valuemax={SETUP_STEPS.length} aria-valuenow={stepIdx + 1}
            aria-valuetext={`Step ${stepIdx + 1} of ${SETUP_STEPS.length}`} style={{ flex:1, display:"flex", gap:6 }}>
            {SETUP_STEPS.map((s, i) => (
              <div key={s} style={{ flex:1, height:4, borderRadius:99, background:i <= stepIdx ? pal.accent : pal.cardB, transition:"background .3s ease" }} />
            ))}
          </div>
        ) : <div style={{ flex:1 }} />}
        <div style={{ minWidth:44, display:"flex", justifyContent:"flex-end", flexShrink:0 }}>{right}</div>
      </div>
      <div style={{ flex:1, minHeight:0, overflowY:"auto", WebkitOverflowScrolling:"touch" }}>
        <div style={{ maxWidth:480, margin:"0 auto", padding:"18px clamp(18px, 6vw, 28px) 24px", animation:"stepIn .35s ease" }}>
          {stepIdx >= 0 && <div style={{ fontSize:13.5, fontWeight:600, color:pal.accent, marginBottom:10 }}>Step {stepIdx + 1} of {SETUP_STEPS.length}</div>}
          {title && <h1 style={{ fontSize:"clamp(26px, 7.4vw, 31px)", fontWeight:700, color:pal.text, letterSpacing:-.9, lineHeight:1.15, margin:0 }}>{title}</h1>}
          {subtitle && <p style={{ fontSize:16, lineHeight:1.5, color:pal.muted, margin:"10px 0 0" }}>{subtitle}</p>}
          <div style={{ marginTop:title || subtitle ? 28 : 0 }}>{children}</div>
        </div>
      </div>
      {footer && (
        <div style={{ flexShrink:0, borderTop:`1px solid ${pal.cardB}`, background:pal.bg }}>
          <div style={{ maxWidth:480, margin:"0 auto", padding:"14px clamp(18px, 6vw, 28px) calc(14px + env(safe-area-inset-bottom))", display:"flex", flexDirection:"column", gap:8 }}>
            {footer}
          </div>
        </div>
      )}
    </div>
  );
}

// Large, thumb-sized field with its label above it. `right` puts a control (Show/Hide) inside the
// right edge of the input.
function AuthInput({ pal = LIGHT, label, hint, labelAction, invalid, right, style, id, ...props }) {
  const [focused, setFocused] = useState(false);
  const autoId = useRef(`f${Math.random().toString(36).slice(2, 9)}`).current;
  const fieldId = id || autoId;
  return (
    <div>
      {(label || labelAction) && (
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:8, gap:10 }}>
          {label && <label htmlFor={fieldId} style={{ fontSize:14.5, fontWeight:600, color:pal.soft }}>{label}</label>}
          {labelAction}
        </div>
      )}
      <div style={{ position:"relative" }}>
        <input id={fieldId} {...props}
          onFocus={e => { setFocused(true); props.onFocus?.(e); }} onBlur={e => { setFocused(false); props.onBlur?.(e); }}
          aria-invalid={invalid || undefined}
          style={{ width:"100%", height:54, boxSizing:"border-box", borderRadius:14, border:`1.5px solid ${invalid ? pal.negative : focused ? pal.accent : pal.cardB}`,
            boxShadow:focused ? `0 0 0 4px ${pal.accentBg}` : "none", background:pal.card, color:pal.text, fontSize:17, fontFamily:APP_FONT,
            padding:right ? "0 64px 0 16px" : "0 16px", outline:"none", transition:"border-color .15s ease, box-shadow .15s ease", ...style }} />
        {right && <div style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", display:"flex" }}>{right}</div>}
      </div>
      {hint && <div style={{ fontSize:13.5, color:pal.muted, lineHeight:1.45, marginTop:7 }}>{hint}</div>}
    </div>
  );
}

// A native select styled to match AuthInput.
function AuthSelect({ pal = LIGHT, label, children, style, id, ...props }) {
  const autoId = useRef(`s${Math.random().toString(36).slice(2, 9)}`).current;
  const fieldId = id || autoId;
  return (
    <div>
      {label && <label htmlFor={fieldId} style={{ display:"block", fontSize:14.5, fontWeight:600, color:pal.soft, marginBottom:8 }}>{label}</label>}
      <div style={{ position:"relative" }}>
        <select id={fieldId} {...props}
          style={{ width:"100%", height:54, boxSizing:"border-box", borderRadius:14, border:`1.5px solid ${pal.cardB}`, background:pal.card, color:props.value ? pal.text : pal.muted,
            fontSize:17, fontFamily:APP_FONT, padding:"0 44px 0 16px", outline:"none", cursor:"pointer", WebkitAppearance:"none", appearance:"none", ...style }}>
          {children}
        </select>
        <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" style={{ position:"absolute", right:16, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }}>
          <path d="M6 9l6 6 6-6" fill="none" stroke={pal.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

// Pill buttons in three weights: the indigo primary (same as Welcome), an outlined secondary for
// alternatives, and a plain text button for small links.
function AuthButton({ pal = LIGHT, kind = "primary", loading, disabled, children, style, ...props }) {
  // The dark theme's indigo is lighter, so it takes dark text to stay readable.
  const onAccent = pal.bg === LIGHT.bg ? "#fff" : "#0a0a0a";
  const base = { width:"100%", minHeight:54, borderRadius:999, display:"flex", alignItems:"center", justifyContent:"center", gap:10, fontSize:16.5, fontWeight:600,
    fontFamily:APP_FONT, letterSpacing:-.1, padding:"0 20px", boxSizing:"border-box", cursor:disabled ? "not-allowed" : loading ? "wait" : "pointer" };
  const kinds = {
    primary:{ background:pal.accent, color:onAccent, border:"none", opacity:disabled && !loading ? .45 : 1, boxShadow:disabled ? "none" : "0 10px 24px rgba(79,83,137,.22)" },
    secondary:{ background:pal.card, color:pal.text, border:`1.5px solid ${pal.cardB}`, opacity:disabled && !loading ? .5 : 1 },
    text:{ background:"none", color:pal.soft, border:"none", minHeight:44, fontSize:15, fontWeight:600 },
  };
  return (
    <button disabled={disabled || loading} {...props} style={{ ...base, ...kinds[kind], ...style }}>
      {loading && <Spinner size={18} color={kind === "primary" ? onAccent : pal.text} thickness={2} />}
      {children}
    </button>
  );
}

// Small inline link-style button, e.g. "Forgot password?" or "Show".
function AuthLink({ pal = LIGHT, children, style, ...props }) {
  return (
    <button type="button" {...props} style={{ background:"none", border:"none", padding:"6px 4px", cursor:"pointer", fontFamily:APP_FONT, fontSize:14, fontWeight:600, color:pal.accent, ...style }}>
      {children}
    </button>
  );
}

// An error or notice shown under a form. tone "error" is read out by screen readers immediately.
function AuthAlert({ pal = LIGHT, tone = "error", title, children, style }) {
  const err = tone === "error";
  return (
    <div role={err ? "alert" : "status"}
      style={{ display:"flex", gap:10, alignItems:"flex-start", background:err ? pal.negativeBg : pal.accentBg, borderRadius:14, padding:"12px 14px", marginTop:16, ...style }}>
      <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" style={{ flexShrink:0, marginTop:1 }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke={err ? pal.negative : pal.accent} strokeWidth="2" />
        <path d={err ? "M12 7.5v5.5M12 16.5v.01" : "M12 11v5.5M12 7.5v.01"} stroke={err ? pal.negative : pal.accent} strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div style={{ fontSize:14.5, lineHeight:1.45, color:pal.text }}>
        {title && <div style={{ fontWeight:600, marginBottom:2 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// "or" divider between a form and its alternatives.
const AuthDivider = ({ pal = LIGHT }) => (
  <div style={{ display:"flex", alignItems:"center", gap:12, margin:"24px 0" }}>
    <div style={{ flex:1, height:1, background:pal.cardB }} /><span style={{ fontSize:13.5, color:pal.muted }}>or</span><div style={{ flex:1, height:1, background:pal.cardB }} />
  </div>
);

const PhoneGlyph = ({ color, size = 20 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path fill={color} d="M6.6 3h2.7c.4 0 .8.3.9.7l1 3.6c.1.4 0 .8-.3 1L9.2 9.8a13 13 0 0 0 5 5l1.5-1.7c.3-.3.7-.4 1-.3l3.6 1c.4.1.7.5.7.9v2.7c0 1-.8 1.8-1.8 1.8C10.4 19.2 3.8 12.6 3.8 4.8 3.8 3.8 4.6 3 5.6 3z" /></svg>
);

// Press-and-hold to reveal an item's actions. Destructive actions used to sit permanently on
// every row as a bare ✕ — one mistap and a finance entry (or note, task, contact) was gone,
// which for finance meant silently corrupting the running totals. Holding is deliberate in a
// way that tapping isn't, so delete now costs intent to reach.
// Cancels if the finger moves (that's a scroll, not a hold), and maps to right-click on desktop.
// Written as a plain factory rather than a hook so list rows can call it inside .map() — and
// since only one press can be in flight at a time, the press state lives here at module level.
const LP = { timer:null, x:0, y:0, fired:false };
const lpClear = () => { if (LP.timer) { clearTimeout(LP.timer); LP.timer = null; } };
// onLongPress also receives the press coordinates (clientX, clientY) — unused by every
// bottom-sheet call site (extra args to a zero-param arrow function are just ignored), but lets
// a caller anchor a small floating menu at the actual touch/click point instead, the way the
// chat message copy popup below does.
const longPress = (onLongPress, delay = 500) => ({
  onTouchStart: e => {
    LP.fired = false;
    const t = e.touches?.[0];
    if (t) { LP.x = t.clientX; LP.y = t.clientY; }
    lpClear();
    LP.timer = setTimeout(() => { LP.fired = true; LP.timer = null; onLongPress(LP.x, LP.y); }, delay);
  },
  onTouchMove: e => {
    const t = e.touches?.[0];
    if (!t || !LP.timer) return;
    if (Math.abs(t.clientX-LP.x) > 10 || Math.abs(t.clientY-LP.y) > 10) lpClear();
  },
  onTouchEnd: lpClear,
  onTouchCancel: lpClear,
  onMouseDown: e => { LP.fired = false; lpClear(); LP.x = e.clientX; LP.y = e.clientY; LP.timer = setTimeout(() => { LP.fired = true; LP.timer = null; onLongPress(LP.x, LP.y); }, delay); },
  onMouseUp: lpClear,
  onMouseLeave: lpClear,
  onContextMenu: e => { e.preventDefault(); if (!LP.fired) onLongPress(e.clientX, e.clientY); },
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
                style={{ width:"100%", textAlign:"left", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"13px 15px", cursor:"pointer", color:a.destructive?C.negative:C.text, fontSize:14, fontWeight:600, fontFamily:APP_FONT, minHeight:48 }}>
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
// The voice-persona picker + speaking-speed control, shared between the Profile screen's
// inline "Voice & Language" panel and the full-screen Voice Settings dialog opened from live
// Voice Mode — one definition so both places can never drift apart on what a saved choice means.
function VoiceStyleSpeedControls({ voicePref, onSetVoicePref, voiceSpeed, onSetVoiceSpeed }) {
  return (
    <>
      <Mono style={{ display:"block", color:C.white, marginBottom:2 }}>KROFT Voice</Mono>
      <Mono style={{ display:"block", color:C.muted, marginBottom:10 }}>Choose how KROFT sounds.</Mono>
      {Object.values(VOICE_PROFILES).map(v => {
        const selected = resolveVoiceId(voicePref)===v.id;
        return (
          <div key={v.id} role="button" tabIndex={0} onClick={() => onSetVoicePref(v.id)} onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); onSetVoicePref(v.id); } }}
            style={{ display:"flex", alignItems:"center", gap:11, padding:"12px 14px", borderRadius:18, marginBottom:8, cursor:"pointer", background:selected?C.white:C.surface, border:`1px solid ${selected?C.white:C.cardB}` }}>
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
          <button key={s.l} onClick={() => onSetVoiceSpeed(s.m)} style={{ flex:1, padding:"9px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:(voiceSpeed||1)===s.m?C.white:C.surface, border:`1px solid ${(voiceSpeed||1)===s.m?C.white:C.cardB}`, color:(voiceSpeed||1)===s.m?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:APP_FONT }}>
            {s.l}
          </button>
        ))}
      </div>
      <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>Tap a voice to hear it and select it, or use ▶ to preview without switching. Volume follows your device's own volume control. The exact voice available for each option depends on your device and browser.</Mono>
    </>
  );
}

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

  return <div ref={ref} style={{ width:size, height:size, borderRadius:"50%", background:"#1c1c1c", flexShrink:0 }} />;
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

function VoiceMode({ state, transcript, reply, error, onStart, onStop, onClose, onOpenSettings, subtitles, supported, levelRef, primed, subscribed, turnsLeft }) {
  // Keeps the tail of a long streaming reply in view without the person having to scroll.
  const replyEndRef = useRef(null);
  useEffect(() => { replyEndRef.current?.scrollIntoView?.({ block:"end" }); }, [reply]);
  const label = { idle:"Tap to speak", listening:"Listening", thinking:"Thinking", speaking:"Speaking" }[state] || "";
  // Sized down from the original 320px — the full-bleed orb read as an oversized, overly heavy
  // focal point on most phone screens.
  const size = Math.min(230, (typeof window !== "undefined" ? window.innerWidth : 360) - 100);
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
        <button onClick={onOpenSettings} aria-label="Voice settings" style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:40, height:40, color:C.text, fontSize:16, cursor:"pointer" }}>⚙</button>
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
          {!error && subtitles && transcript && <div style={{ fontSize:17, color:C.text, lineHeight:1.5, fontWeight:500 }}>{transcript}</div>}
          {!error && subtitles && !transcript && reply && <div ref={replyEndRef} style={{ fontSize:15, color:C.soft, lineHeight:1.7, textAlign:"left", whiteSpace:"pre-wrap" }}>{toPlainText(reply)}</div>}
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
          ? <button onClick={onStart} disabled={!supported} style={{ flex:1, minHeight:52, borderRadius:16, border:"none", background:supported?C.text:C.surface, color:supported?C.card:C.muted, fontSize:15, fontWeight:700, fontFamily:APP_FONT, cursor:supported?"pointer":"not-allowed" }}>{primed ? "Start talking" : "Allow microphone"}</button>
          : <button onClick={onStop} style={{ flex:1, minHeight:52, borderRadius:16, border:`1px solid ${C.border}`, background:"transparent", color:C.text, fontSize:15, fontWeight:700, fontFamily:APP_FONT, cursor:"pointer" }}>{state==="speaking" ? "Interrupt" : state==="thinking" ? "Cancel" : "Stop"}</button>}
      </div>
    </div>
  );
}

// Reachable mid-conversation from the gear icon in VoiceMode's header, so a change here (a
// different persona, a faster pace, subtitles off) takes effect on the very next turn instead of
// requiring the person to back out to Profile first. Every control writes straight through its
// setter — there's no separate draft/Save step to get out of sync with what's actually playing.
function VoiceSettingsScreen({ voicePref, onSetVoicePref, voiceSpeed, onSetVoiceSpeed, subtitles, onSetSubtitles, backgroundMode, onSetBackgroundMode, onClose }) {
  const ref = useModalA11y(onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Voice settings" tabIndex={-1}
      style={{ position:"fixed", inset:0, zIndex:1250, background:C.bg, display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"22px 20px 10px" }}>
        <button onClick={onClose} aria-label="Back to voice conversation" style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:40, height:40, color:C.text, fontSize:17, cursor:"pointer" }}>←</button>
        <div style={{ fontSize:16, fontWeight:700, color:C.text }}>Voice Settings</div>
        <div style={{ width:40 }} />
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"6px 20px 20px" }}>
        <Mono style={{ display:"block", color:C.muted, letterSpacing:.6, marginBottom:8 }}>CONVERSATION</Mono>
        <Card style={{ padding:"4px 16px", marginBottom:20 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 0", borderBottom:`1px solid ${C.cardB}`, gap:12 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Background voice mode</div>
              <Mono style={{ color:C.muted, display:"block", marginTop:2 }}>Keep talking to KROFT while you use the rest of the app.</Mono>
            </div>
            <ProfileSwitch value={backgroundMode} onChange={onSetBackgroundMode} />
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"14px 0", gap:12 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Subtitles</div>
              <Mono style={{ color:C.muted, display:"block", marginTop:2 }}>Show what's said as text during the conversation.</Mono>
            </div>
            <ProfileSwitch value={subtitles} onChange={onSetSubtitles} />
          </div>
        </Card>
        <Mono style={{ display:"block", color:C.muted, letterSpacing:.6, marginBottom:8 }}>VOICE STYLE &amp; SPEED</Mono>
        <Card style={{ padding:"14px 16px", marginBottom:20 }}>
          <VoiceStyleSpeedControls voicePref={voicePref} onSetVoicePref={onSetVoicePref} voiceSpeed={voiceSpeed} onSetVoiceSpeed={onSetVoiceSpeed} />
        </Card>
      </div>
      <div style={{ padding:"0 20px calc(20px + env(safe-area-inset-bottom))" }}>
        <Btn full onClick={onClose}>Save</Btn>
      </div>
    </div>
  );
}

// The floating pill shown instead of the full VoiceMode screen once Background voice mode has
// minimized an active conversation — the recognizer/speech loop keeps running untouched (it only
// ever checks voiceOpen, never this), so tapping back in resumes exactly where it left off.
function MinimizedVoiceBar({ state, levelRef, onExpand, onStop }) {
  const label = { idle:"Voice mode", listening:"Listening…", thinking:"Thinking…", speaking:"Speaking…" }[state] || "Voice mode";
  return (
    <div style={{ position:"fixed", right:16, bottom:"calc(96px + env(safe-area-inset-bottom))", zIndex:260, display:"flex", alignItems:"center", gap:10, padding:"8px 10px 8px 8px", borderRadius:99, background:C.card, border:`1px solid ${C.cardB}`, boxShadow:C.shadowRaised }}>
      <button onClick={onExpand} aria-label="Reopen voice conversation" style={{ display:"flex", alignItems:"center", gap:10, background:"none", border:"none", cursor:"pointer", padding:0 }}>
        <VoiceOrb state={state} levelRef={levelRef} size={36} />
        <Mono style={{ color:C.text }}>{label}</Mono>
      </button>
      <button onClick={onStop} aria-label="End voice conversation" style={{ width:26, height:26, borderRadius:"50%", border:`1px solid ${C.cardB}`, background:C.surface, color:C.text, fontSize:12, cursor:"pointer", flexShrink:0 }}>✕</button>
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
          <input type="date" value={value.date||todayISO()} max={todayISO()} onChange={e => onChange(v=>({...v,date:e.target.value}))} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
          <CategorySelect value={value.cat} onChange={c => onChange(v=>({...v,cat:c}))} cats={cats} onAddCategory={onAddCategory} />
          {/* Turns the entry into a template that re-posts itself on this cadence. */}
          <select value={value.repeat} onChange={e => onChange(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
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

// The guided countdown for an in-progress Quick Reset session. `session` is Kroft.jsx's own
// activeReset state ({ key, label, guide, seconds, total }); the countdown itself lives there too
// (ticked once a second by an effect in KroftApp) so this component stays a pure display of it.
function QuickResetModal({ session, onCancel }) {
  const pct = 1 - session.seconds / session.total;
  const mm = Math.floor(session.seconds / 60), ss = session.seconds % 60;
  return (
    <div role="dialog" aria-modal="true" aria-label={session.label} style={{ position:"fixed", inset:0, zIndex:1300, background:C.bg, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24 }}>
      <Mono style={{ color:C.muted, letterSpacing:.8, marginBottom:22, animation:"fadeUp .3s ease" }}>{session.label}</Mono>
      <div style={{ position:"relative", width:180, height:180, marginBottom:26, animation:"pop .35s cubic-bezier(.34,1.56,.64,1)" }}>
        {/* A slow ambient glow behind the ring, not tied to the second-by-second countdown —
            reads as "breathing" rather than a ticking timer, which is the actual point of a
            Quick Reset. Purely decorative (prefers-reduced-motion turns it off, see ANIM). */}
        <div style={{ position:"absolute", inset:-22, borderRadius:"50%", background:`radial-gradient(circle, ${C.accent}33, transparent 70%)`, animation:"breathe 4s ease-in-out infinite" }} />
        <svg viewBox="0 0 180 180" style={{ position:"relative", width:180, height:180, transform:"rotate(-90deg)" }}>
          <circle cx="90" cy="90" r="76" fill="none" stroke={C.card} strokeWidth="10" />
          <circle cx="90" cy="90" r="76" fill="none" stroke={C.accent} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={2*Math.PI*76} strokeDashoffset={2*Math.PI*76*(1-pct)}
            style={{ transition:"stroke-dashoffset 1s linear" }} />
        </svg>
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:38, fontWeight:700, color:C.white, letterSpacing:-1 }}>
          {mm}:{String(ss).padStart(2,"0")}
        </div>
      </div>
      <div style={{ fontSize:14, color:C.soft, textAlign:"center", maxWidth:280, lineHeight:1.6, marginBottom:34, animation:"fadeUp .35s ease" }}>{session.guide}</div>
      <Btn v="outline" onClick={onCancel}>End early</Btn>
    </div>
  );
}

// The detail view behind tapping a card in "Your Patterns" — every field here (insight, the two
// group averages, observation count, explanation) comes straight off the pattern object the
// Pattern Engine computed (see wellnessPatterns in KroftApp); nothing here is a separate hardcoded
// sentence, and the disclaimer is fixed and always shown, per the spec's own requirement that this
// never reads as a medical conclusion.
function PatternDetailModal({ pattern, onClose }) {
  const maxAvg = Math.max(...pattern.groups.map(g => g.avg), 0.01);
  // Bars grow in from zero on open rather than appearing at full width — a one-shot transition
  // (not a keyframe, since each bar's target width is a real computed number) that gives the
  // numbers a moment to visually land instead of just materializing.
  const [grown, setGrown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setGrown(true), 30); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:950, background:"rgba(40,40,40,.72)", display:"flex", alignItems:"center", justifyContent:"center", padding:24 }} onClick={onClose}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:34, padding:26, maxWidth:420, width:"100%", animation:"pop .3s cubic-bezier(.34,1.56,.64,1)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10, marginBottom:14 }}>
          <div style={{ fontSize:16, fontWeight:700, color:C.white, lineHeight:1.4 }}>{pattern.insight}</div>
          <button onClick={onClose} aria-label="Close" style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer", padding:2, lineHeight:1, flexShrink:0 }}>✕</button>
        </div>
        <Mono style={{ display:"block", color:C.muted, marginBottom:16 }}>Last {pattern.period} days · {pattern.observations} days observed</Mono>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:16 }}>
          {pattern.groups.map((g,i) => (
            <div key={i}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <Mono style={{ color:C.soft }}>{g.label}</Mono>
                <Mono style={{ color:C.white }}>{g.avg.toFixed(1)} · {g.n} day{g.n!==1?"s":""}</Mono>
              </div>
              <div style={{ background:C.surface, borderRadius:8, height:8, overflow:"hidden" }}>
                <div style={{ width:grown?`${Math.max(4, g.avg/maxAvg*100)}%`:"0%", height:"100%", background:i===0?C.accent:C.muted, borderRadius:8, transition:`width .7s ${i*.08}s cubic-bezier(.16,1,.3,1)` }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize:12.5, color:C.text, lineHeight:1.7, marginBottom:14 }}>{pattern.explanation}</div>
        <div style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", fontSize:11, color:C.muted, lineHeight:1.6 }}>
          This is a pattern in your personal data, not a medical conclusion.
        </div>
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
          <textarea placeholder="Write your message…" value={draft.body} onChange={e => onChange({...draft, body:e.target.value})} rows={6} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box" }} onFocus={e => { e.target.style.borderColor=C.accent; e.target.style.boxShadow=`0 0 0 3px ${C.accentBg}`; }} onBlur={e => { e.target.style.borderColor=C.cardB; e.target.style.boxShadow="none"; }} />
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
    <select value={value || ""} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", ...style }}>
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
        <button onClick={onClose} style={{ minHeight:44, padding:"11px 28px", fontSize:13, fontWeight:700, fontFamily:APP_FONT, letterSpacing:.3, borderRadius:12, cursor:"pointer", background:done?BRIEF.white:"transparent", border:`1px solid ${done?BRIEF.white:BRIEF.muted}`, color:done?BRIEF.black:BRIEF.soft }}>{done?`Let's go, ${firstNameOf(user.name)}`:"Skip"}</button>
      </div>
    </div>
  );
}

// ── PROFILE PAGE ───────────────────────────────────────────────────────────────
// Each Profile icon sits in its own tinted circle — the same badge language as the Wellness
// rows (WELLNESS_ROW_GLOW) and the Breaks/Water tiles — rather than a bare line icon, so the
// list reads as KROFT's own design. RGB triplets for rgba() tints, like the other glow maps.
const PROFILE_ICON_TINT = {
  store:"200,140,50", crown:"140,105,200", gauge:"56,150,140", at:"70,120,200", phone:"70,150,95",
  link:"70,120,200", contrast:"110,115,130", reminders:"200,140,50", mic:"210,95,120", wand:"140,105,200",
  lock:"70,150,95", eye:"56,150,140", cloud:"70,120,200", flag:"210,95,120", nova:"99,102,170",
};

// One row on the Profile hub: icon, label, and an optional current value on the right or detail
// line underneath. Without onClick it's a read-only row (e.g. the account's email address).
function SettingsRow({ icon, label, value, detail, onClick, tone, isLast }) {
  const color = tone === "accent" ? C.accent : tone === "danger" ? C.negative : C.text;
  const iconColor = tone === "danger" ? C.negative : `rgb(${PROFILE_ICON_TINT[icon] || "110,115,130"})`;
  const iconBg = tone === "danger" ? C.negativeBg : `rgba(${PROFILE_ICON_TINT[icon] || "110,115,130"},.14)`;
  const interactive = !!onClick;
  return (
    <div {...(interactive ? { role:"button", tabIndex:0, onClick, onKeyDown:e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); onClick(); } } } : {})}
      className={interactive ? "row" : undefined}
      style={{ display:"flex", alignItems:"center", gap:14, padding:"15px 18px", minHeight:56, boxSizing:"border-box", cursor:interactive?"pointer":"default", borderBottom:isLast?"none":`1px solid ${C.div}`, transition:"background .15s ease" }}>
      <div style={{ width:34, height:34, borderRadius:"50%", background:iconBg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
        <NavIcon id={icon} size={18} color={iconColor} />
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:16, fontWeight:500, color, letterSpacing:-.1 }}>{label}</div>
        {detail && <div style={{ fontSize:14, color:C.muted, marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{detail}</div>}
      </div>
      {value && <div style={{ fontSize:15, color:C.muted, flexShrink:0, maxWidth:"45%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{value}</div>}
    </div>
  );
}

// A titled group of SettingsRows in one rounded card.
function SettingsGroup({ title, children }) {
  return (
    <div style={{ marginBottom:26 }}>
      {title && <div style={{ fontSize:15, color:C.muted, margin:"0 0 9px 18px" }}>{title}</div>}
      <div style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:24, overflow:"hidden" }}>{children}</div>
    </div>
  );
}

const MicrosoftLogo = ({ size = 22 }) => (
  <svg viewBox="0 0 22 22" width={size} height={size} aria-hidden="true">
    <rect x="0" y="0" width="10" height="10" fill="#F25022" /><rect x="12" y="0" width="10" height="10" fill="#7FBA00" />
    <rect x="0" y="12" width="10" height="10" fill="#00A4EF" /><rect x="12" y="12" width="10" height="10" fill="#FFB900" />
  </svg>
);

// Profile → Connected apps: where email and calendar accounts are linked and unlinked. One card
// per provider, because a single Google (or Microsoft) sign-in grants mail and calendar together
// (see GOOGLE_SCOPES / MICROSOFT_SCOPES in api/_lib) — so Connect and Disconnect act on the whole
// account. Each card lists exactly what that grant lets KROFT do, matching the scopes requested.
function ConnectedApps({ google, microsoft }) {
  const providers = [
    { name:"Google", logo:<GoogleG size={24} />, ...google,
      services:[["Gmail", google.status.gmail], ["Google Calendar", google.status.calendar]],
      // [what it allows, whether that part was granted — null for parts of every grant]
      permissions:[["Read your Gmail inbox", google.status.gmail], ["Send emails you write or confirm in KROFT", google.status.gmail],
        ["See your Google Calendar", google.status.calendar], ["Add events you create in KROFT to that calendar", google.status.calendar]],
      disconnectNote:"Disconnecting removes KROFT's access and revokes it with Google." },
    { name:"Microsoft", logo:<MicrosoftLogo size={22} />, ...microsoft,
      services:[["Outlook Mail", microsoft.status.mail], ["Outlook Calendar", microsoft.status.calendar]],
      permissions:[["Read your Outlook inbox", microsoft.status.mail], ["Send emails you write or confirm in KROFT", microsoft.status.mail],
        ["See your Outlook calendar and add events you create in KROFT", microsoft.status.calendar], ["Your name and email address", null], ["Stay connected without signing in again", null]],
      disconnectNote:"Disconnecting deletes KROFT's access. To also remove KROFT from your Microsoft account, visit myaccount.microsoft.com/consent." },
  ];
  return (
    <div>
      <p style={{ fontSize:14.5, lineHeight:1.55, color:C.soft, margin:"0 4px 18px" }}>
        Link an account so KROFT can work with your real email and calendar. You approve access on Google's or Microsoft's own sign-in page, and you can disconnect any time.
      </p>
      {!isSupabaseConfigured && (
        <div style={{ background:C.fill, border:`1px solid ${C.border}`, borderRadius:14, padding:"11px 14px", marginBottom:14, fontSize:13.5, color:C.soft, lineHeight:1.5 }}>
          Connecting accounts needs a signed-in KROFT account. This copy is running in local-only mode.
        </div>
      )}
      {providers.map(p => {
        const on = p.services.filter(([, v]) => v).map(([n]) => n);
        const connected = on.length > 0;
        const partial = connected && on.length < p.services.length;
        return (
          <div key={p.name} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:24, padding:"18px 18px 16px", marginBottom:14 }}>
            <div style={{ display:"flex", alignItems:"center", gap:13 }}>
              <div style={{ width:44, height:44, borderRadius:"50%", background:C.surface, border:`1px solid ${C.cardB}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{p.logo}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16.5, fontWeight:600, color:C.text }}>{p.name}</div>
                <div style={{ fontSize:13.5, color:connected ? C.positive : C.muted, marginTop:1 }}>{connected ? `Connected · ${on.join(" and ")}` : "Not connected"}</div>
              </div>
              <Btn sm v={connected ? "outline" : "solid"} disabled={!isSupabaseConfigured || p.linking} onClick={connected ? p.disconnect : p.connect} style={{ flexShrink:0 }}>
                {p.linking ? <Spinner size={14} color={connected ? C.soft : C.black} thickness={2} /> : connected ? "Disconnect" : "Connect"}
              </Btn>
            </div>
            {partial && (
              <div style={{ fontSize:13, color:C.warning, lineHeight:1.5, marginTop:10 }}>
                {p.services.filter(([, v]) => !v).map(([n]) => n).join(" and ")} wasn't allowed. Disconnect and connect again, and tick it on the permissions page to add it.
              </div>
            )}
            <div style={{ borderTop:`1px solid ${C.div}`, marginTop:14, paddingTop:12 }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.muted, marginBottom:8 }}>{connected ? "KROFT can" : "Connecting lets KROFT"}</div>
              {p.permissions.map(([t, granted]) => {
                // Once connected, a part the person didn't allow is shown as not allowed rather
                // than ticked — the list says what KROFT can actually do right now.
                const missing = connected && granted === false;
                return (
                  <div key={t} style={{ display:"flex", gap:9, alignItems:"flex-start", marginBottom:6 }}>
                    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" style={{ flexShrink:0, marginTop:2 }}>
                      {missing
                        ? <path d="M7 7l10 10M17 7 7 17" stroke={C.muted} strokeWidth="2" fill="none" strokeLinecap="round" />
                        : <path d="m5 12.5 4.5 4.5L19 7.5" stroke={connected ? C.positive : C.muted} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
                    </svg>
                    <span style={{ fontSize:14, color:missing ? C.muted : C.text, lineHeight:1.45 }}>{t}{missing ? " (not allowed)" : ""}</span>
                  </div>
                );
              })}
              {connected && <div style={{ fontSize:12.5, color:C.muted, lineHeight:1.5, marginTop:8 }}>{p.disconnectNote}</div>}
            </div>
          </div>
        );
      })}
      <div style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:24, padding:"16px 18px", display:"flex", alignItems:"center", gap:13 }}>
        <div style={{ width:44, height:44, borderRadius:"50%", background:"#000", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color:"#fff", fontSize:12, fontWeight:700, letterSpacing:-.2 }}>Uber</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:16.5, fontWeight:600, color:C.text }}>Uber</div>
          <div style={{ fontSize:13.5, color:C.muted, lineHeight:1.45, marginTop:1 }}>No connection needed. KROFT opens Uber with your destination filled in, and you book there.</div>
        </div>
      </div>
    </div>
  );
}

// Inline editor for one of the person's own chat messages: change it and resend, and KROFT answers
// again from that point. Anything after the message is replaced, and the editor says so.
function MessageEditor({ initial, replacesLater, disabled, onCancel, onSend }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 260)}px`; }
  }, [text]);
  const changed = text.trim() && text.trim() !== initial.trim();
  return (
    <div style={{ width:"100%", maxWidth:560, alignSelf:"flex-end", background:C.card, border:`1.5px solid ${C.accent}`, borderRadius:18, padding:"10px 12px 10px", boxSizing:"border-box", boxShadow:`0 0 0 4px ${C.accentBg}` }}>
      <textarea ref={ref} value={text} aria-label="Edit your message" rows={1}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && changed && !disabled) { e.preventDefault(); onSend(text); }
        }}
        style={{ width:"100%", boxSizing:"border-box", border:"none", outline:"none", resize:"none", background:"transparent", color:C.text, fontSize:15, lineHeight:1.55, fontFamily:APP_FONT, padding:"2px 2px", maxHeight:260, overflowY:"auto" }} />
      {replacesLater && <div style={{ fontSize:12.5, color:C.muted, margin:"4px 2px 0", lineHeight:1.4 }}>Sending replaces KROFT's replies after this message.</div>}
      <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:10 }}>
        <button type="button" onClick={onCancel}
          style={{ height:36, padding:"0 16px", borderRadius:999, border:`1px solid ${C.cardB}`, background:"transparent", color:C.text, fontSize:14, fontWeight:600, fontFamily:APP_FONT, cursor:"pointer" }}>Cancel</button>
        <button type="button" onClick={() => onSend(text)} disabled={!changed || disabled}
          style={{ height:36, padding:"0 18px", borderRadius:999, border:"none", background:C.text, color:C.bg, fontSize:14, fontWeight:600, fontFamily:APP_FONT, cursor:!changed || disabled ? "not-allowed" : "pointer", opacity:!changed || disabled ? .4 : 1 }}>Send</button>
      </div>
    </div>
  );
}

// Confirmation before signing out. Logging out of a synced account ends the session on this
// device, so it asks first rather than acting on a single stray tap.
function LogoutDialog({ onConfirm, onCancel }) {
  const [busy, setBusy] = useState(false);
  const ref = useModalA11y(onCancel);
  return (
    <div onClick={busy ? undefined : onCancel} style={{ position:"fixed", inset:0, zIndex:1300, background:"rgba(0,0,0,.45)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, animation:"fadeIn .18s ease" }}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="logout-title" aria-describedby="logout-desc" onClick={e => e.stopPropagation()}
        style={{ width:"100%", maxWidth:400, background:C.card, borderRadius:32, padding:"30px 22px 12px", boxShadow:"0 24px 60px rgba(0,0,0,.3)", animation:"pop .22s ease" }}>
        <h2 id="logout-title" style={{ fontSize:24, fontWeight:600, color:C.text, margin:"0 8px 10px", letterSpacing:-.4 }}>Log out?</h2>
        <p id="logout-desc" style={{ fontSize:16, lineHeight:1.5, color:C.muted, margin:"0 8px 24px" }}>You'll need to sign back in to keep using KROFT.</p>
        <button disabled={busy} onClick={async () => { setBusy(true); if ((await onConfirm()) === false) setBusy(false); }}
          style={{ width:"100%", height:52, borderRadius:999, border:"none", background:C.white, color:C.black, fontSize:16, fontWeight:700, fontFamily:APP_FONT, cursor:busy?"wait":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
          {busy ? <Spinner size={18} color={C.black} thickness={2} /> : "Log out"}
        </button>
        <button disabled={busy} onClick={onCancel}
          style={{ width:"100%", height:52, marginTop:4, borderRadius:999, border:"none", background:"none", color:C.text, fontSize:16, fontWeight:700, fontFamily:APP_FONT, cursor:"pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Permanent account deletion. Deliberately harder to reach than log out: the user has to type
// DELETE, because unlike log out there is no way back.
function DeleteAccountDialog({ onConfirm, onCancel, synced, subscribed }) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const ref = useModalA11y(busy ? () => {} : onCancel);
  const ready = typed.trim().toUpperCase() === "DELETE";
  const confirm = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const ok = await onConfirm();
    if (!ok) setBusy(false);
  };
  return (
    <div onClick={busy ? undefined : onCancel} style={{ position:"fixed", inset:0, zIndex:1300, background:"rgba(0,0,0,.45)", display:"flex", alignItems:"center", justifyContent:"center", padding:20, animation:"fadeIn .18s ease" }}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-desc" onClick={e => e.stopPropagation()}
        style={{ width:"100%", maxWidth:400, background:C.card, borderRadius:32, padding:"30px 22px 12px", boxShadow:"0 24px 60px rgba(0,0,0,.3)", animation:"pop .22s ease" }}>
        <h2 id="delete-title" style={{ fontSize:24, fontWeight:600, color:C.text, margin:"0 8px 10px", letterSpacing:-.4 }}>Delete account?</h2>
        <div id="delete-desc" style={{ fontSize:15.5, lineHeight:1.5, color:C.muted, margin:"0 8px 18px" }}>
          <p style={{ margin:"0 0 10px" }}>
            {synced
              ? "This permanently deletes your KROFT account and everything in it: chats, finances, contacts, notes, wellness entries and files. Linked Google or Microsoft accounts are disconnected."
              : "This permanently erases everything KROFT has stored on this device: chats, finances, contacts, notes, wellness entries and files."}
          </p>
          {subscribed && <p style={{ margin:"0 0 10px" }}>Your KROFT Plus subscription will be cancelled.</p>}
          <p style={{ margin:0 }}>This can't be undone. Download a backup first if you want to keep a copy.</p>
        </div>
        <label htmlFor="delete-confirm" style={{ display:"block", fontSize:14, color:C.text, margin:"0 8px 8px" }}>Type <b>DELETE</b> to confirm</label>
        <input id="delete-confirm" value={typed} onChange={e => setTyped(e.target.value)} disabled={busy}
          onKeyDown={e => { if (e.key === "Enter") confirm(); }}
          autoComplete="off" autoCapitalize="characters" spellCheck={false}
          style={{ width:"100%", boxSizing:"border-box", height:48, borderRadius:14, border:`1px solid ${C.cardB}`, background:C.surface, color:C.text, fontSize:16, fontFamily:APP_FONT, padding:"0 14px", marginBottom:16, outline:"none" }} />
        <button disabled={!ready || busy} onClick={confirm}
          style={{ width:"100%", height:52, borderRadius:999, border:"none", background:C.negative, color:"#fff", fontSize:16, fontWeight:700, fontFamily:APP_FONT, cursor:busy?"wait":ready?"pointer":"not-allowed", opacity:ready||busy?1:.45, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
          {busy ? <Spinner size={18} color="#fff" thickness={2} /> : "Delete account"}
        </button>
        <button disabled={busy} onClick={onCancel}
          style={{ width:"100%", height:52, marginTop:4, borderRadius:999, border:"none", background:"none", color:C.text, fontSize:16, fontWeight:700, fontFamily:APP_FONT, cursor:"pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Header bar for a Profile drill-down screen: back button + screen title.
function ProfileScreenHeader({ title, onBack }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:20 }}>
      <button onClick={onBack} aria-label="Back" style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:44, height:44, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0, boxShadow:C.shadowBase }}>
        <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true"><path d="M19 12H5M11 5l-7 7 7 7" stroke={C.text} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <h2 style={{ fontSize:20, fontWeight:700, color:C.white, letterSpacing:-.5 }}>{title}</h2>
    </div>
  );
}

function ProfileRow({ label, sub, expanded, onToggle, children, right, icon, glow }) {
  return (
    <div style={{ borderBottom:`1px solid ${C.div}` }}>
      {/* className="row" gets the app's shared hover highlight (pointer devices only — see the
          global .row:hover rule); the negative margin/matching extra padding lets that highlight
          read as a soft rounded pill inset from the card edge, instead of a hard-edged rectangle
          flush against it. */}
      <div className="row" role="button" tabIndex={0} aria-expanded={expanded} onClick={onToggle} onKeyDown={e => { if (e.key==="Enter"||e.key===" ") { e.preventDefault(); onToggle(); } }} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 8px", margin:"0 -8px", borderRadius:12, cursor:"pointer", transition:"background .15s ease" }}>
        <div style={{ display:"flex", alignItems:"center", gap:11, minWidth:0 }}>
          {/* Optional colored icon badge — same 30px circle/tint language as the Overview's
              Breaks/Water tiles, only passed by the Wellness tab's rows so Profile's own rows
              (which don't pass icon/glow) render exactly as before. */}
          {icon && (
            <div style={{ width:30, height:30, borderRadius:"50%", background:`rgba(${glow},.16)`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              <NavIcon id={icon} size={14} color={`rgb(${glow})`} />
            </div>
          )}
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, color:C.white }}>{label}</div>
            {sub && <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{sub}</Mono>}
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
          {right}
          <Mono style={{ color:C.muted, fontSize:14, transform:expanded?"rotate(90deg)":"none", transition:"transform .16s", display:"inline-block" }}>›</Mono>
        </div>
      </div>
      {expanded && children && (
        <div style={{ padding:"0 2px 16px", animation:"fadeUp .25s ease" }}>{children}</div>
      )}
    </div>
  );
}

// ── Invoices, quotes and clients (Home › Finance › Invoices) ──
// The logic (totals, numbering, statuses, messages, client balances) is in src/invoices/model.js
// and the PDF in src/invoices/pdf.js; this is only the screens. Clients are the person's own
// contacts: an invoice or quote links to one (clientId), and a new name becomes a Business contact.
// Free plan: FREE_INVOICES_PER_MONTH invoices and FREE_QUOTES_PER_MONTH quotes a month; KROFT Plus:
// unlimited, plus payment reminders.
const DOC_TONE = { draft:null, sent:"accent", overdue:"negative", paid:"positive", cancelled:null, accepted:"positive", declined:"negative", invoiced:null, expired:"warning" };
const sumByCur = (obj, fmt) => Object.entries(obj).filter(([, v]) => v).map(([cur, v]) => fmt(v, cur)).join(" + ");

function InvoiceField({ label, children, style }) {
  return (
    <label style={{ display:"block", ...style }}>
      <Mono style={{ display:"block", color:C.muted, marginBottom:5 }}>{label}</Mono>
      {children}
    </label>
  );
}

function InvoicesScreen({ invoices, setInvoices, quotes, setQuotes, settings, setSettings, user, subscribed, contacts, setContacts, onClose, toast, onUpgrade, onRecordIncome, onRemoveIncome, openId }) {
  const today = todayISO();
  const fmt = fmtCur;
  const [tab, setTab] = useState("invoices");          // invoices | quotes | clients
  const [view, setView] = useState(openId ? "view" : "list");  // list | edit | view | settings | client
  const [currentId, setCurrentId] = useState(openId || null);
  const [currentKind, setCurrentKind] = useState("invoice");
  const [clientKeySel, setClientKeySel] = useState(null);
  const [draft, setDraft] = useState(null);
  const [settingsDraft, setSettingsDraft] = useState(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState(null);
  const [returnTo, setReturnTo] = useState("list");     // where Back goes from a document

  const listFor = kind => (kind === "quote" ? quotes : invoices);
  const setListFor = kind => (kind === "quote" ? setQuotes : setInvoices);
  const current = listFor(currentKind).find(d => d.id === currentId) || null;
  const invAllowance = invoiceAllowance({ subscribed, invoices, today });
  const qAllowance = quoteAllowance({ subscribed, quotes, today });
  const clients = clientSummaries({ invoices, quotes, contacts, today });
  const needsDetails = !settings.bankName && !settings.accountNumber;

  useEffect(() => {
    if (view !== "view" || !current) { setPreview(null); return; }
    let cancelled = false;
    invoicePdf(current, settings, user, fmt, { font: APP_FONT, today })
      .then(r => { if (!cancelled) setPreview(r.preview); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [view, current, settings, user]);

  const statusOf = doc => docStatus(doc, today);
  const update = (kind, id, patch) => setListFor(kind)(list => list.map(d => d.id === id ? { ...d, ...patch } : d));
  const openDoc = (doc, from = "list") => { setCurrentKind(doc.kind === "quote" ? "quote" : "invoice"); setCurrentId(doc.id); setReturnTo(from); setView("view"); };
  const backFromDoc = () => { setCurrentId(null); setView(returnTo === "client" && clientKeySel ? "client" : "list"); };

  // The client on a saved invoice/quote becomes (or links to) a Business contact, so their phone
  // and email are remembered and everything for them can be seen together.
  const linkClient = doc => {
    const name = doc.client.name.trim();
    const existing = (doc.clientId && contacts.find(c => String(c.id) === String(doc.clientId)))
      || contacts.find(c => (c.name || "").trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      const fill = {};
      if (!existing.phone && doc.client.phone) fill.phone = doc.client.phone;
      if (!existing.email && doc.client.email) fill.email = doc.client.email;
      if (Object.keys(fill).length) setContacts(p => p.map(c => c.id === existing.id ? { ...c, ...fill } : c));
      return existing.id;
    }
    const contact = { id:uid(), name, phone:doc.client.phone || "", email:doc.client.email || "", category:"business", note:"Client" };
    setContacts(p => [contact, ...p]);
    return contact.id;
  };

  const blockedMsg = kind => kind === "quote"
    ? `You've used this month's ${FREE_QUOTES_PER_MONTH} free quotes. KROFT Plus gives you unlimited quotes.`
    : `You've used this month's ${FREE_INVOICES_PER_MONTH} free invoices. KROFT Plus gives you unlimited invoices.`;

  const startNew = (kind, client = null) => {
    if (!(kind === "quote" ? qAllowance : invAllowance).allowed) { toast(blockedMsg(kind)); onUpgrade?.(); return; }
    const base = { settings, currency: user.currency || "NGN", today, id: String(uid()), client: client ? { name:client.name, email:client.email, phone:client.phone } : {} };
    const doc = kind === "quote" ? createQuote({ ...base, clientId: client?.clientId || null }).quote : { ...createInvoice(base).invoice, clientId: client?.clientId || null };
    setDraft({ ...doc, _new: true });
    setReturnTo(client ? "client" : "list");
    setView("edit");
  };
  const startEdit = doc => { setDraft({ ...doc, items: doc.items.map(it => ({ ...it })), client: { ...doc.client } }); setView("edit"); };
  const duplicate = doc => {
    const kind = doc.kind === "quote" ? "quote" : "invoice";
    if (!(kind === "quote" ? qAllowance : invAllowance).allowed) { toast(blockedMsg(kind)); onUpgrade?.(); return; }
    const base = { settings, client: doc.client, items: doc.items.map(({ description, qty, price }) => ({ description, qty, price })), currency: doc.currency, today, id: String(uid()), vatRate: doc.vatRate, discount: doc.discount, notes: doc.notes };
    const copy = kind === "quote" ? createQuote({ ...base, clientId: doc.clientId }).quote : { ...createInvoice(base).invoice, clientId: doc.clientId || null };
    setDraft({ ...copy, _new: true });
    setView("edit");
  };

  const saveDraft = () => {
    const { _new, ...doc } = draft;
    const kind = doc.kind === "quote" ? "quote" : "invoice";
    const clean = { ...doc, items: doc.items.filter(it => it.description || Number(it.price)) };
    if (!clean.client.name) { toast(`Add who the ${kind} is for.`); return; }
    clean.clientId = linkClient(clean);
    if (_new) {
      // The number is only used up once it's actually saved.
      setListFor(kind)(list => [clean, ...list]);
      setSettings(s => kind === "quote" ? { ...s, nextQuoteNumber:(Number(s.nextQuoteNumber) || 1) + 1 } : { ...s, nextNumber:(Number(s.nextNumber) || 1) + 1 });
    } else update(kind, clean.id, clean);
    setDraft(null);
    setCurrentKind(kind); setCurrentId(clean.id);
    setView("view");
    toast(_new ? `${clean.number} saved.` : `${kind === "quote" ? "Quote" : "Invoice"} updated.`);
  };

  const markSent = doc => { if (doc.status === "draft") update(doc.kind === "quote" ? "quote" : "invoice", doc.id, { status:"sent", sentAt:today }); };
  const messageFor = (doc, reminder) => doc.kind === "quote" ? quoteMessage(doc, settings, user, fmt)
    : reminder ? reminderMessage(doc, settings, user, fmt, today) : sendMessage(doc, settings, user, fmt);

  const sharePdf = async doc => {
    const problem = invoiceProblem(doc);
    if (problem) { toast(problem.replace("invoice", doc.kind === "quote" ? "quote" : "invoice")); return; }
    setBusy("pdf");
    try {
      const { bytes } = await invoicePdf(doc, settings, user, fmt, { font: APP_FONT, today });
      const name = invoiceFileName(doc);
      const text = messageFor(doc, false);
      const label = `${doc.kind === "quote" ? "Quote" : "Invoice"} ${doc.number}`;
      const result = await saveFile({ name, data:bytes, type:"application/pdf", text, title:label });
      if (result !== "cancelled") markSent(doc);
      if (result === "downloaded") toast("PDF downloaded. Attach it to your email or WhatsApp.");
    } catch (err) {
      toast(err?.code === "needs-update" ? "Update the KROFT app to share PDFs." : "Couldn't create the PDF. Try again.");
    } finally { setBusy(""); }
  };

  const sendWhatsApp = (doc, reminder) => {
    if (!doc.client.phone) { toast("Add the client's phone number to send on WhatsApp."); startEdit(doc); return; }
    window.open(whatsappLink(doc.client.phone, messageFor(doc, reminder)), "_blank");
    if (!reminder) markSent(doc);
  };
  const sendEmail = (doc, reminder) => {
    if (!doc.client.email) { toast("Add the client's email address to send by email."); startEdit(doc); return; }
    const what = doc.kind === "quote" ? "Quote" : "Invoice";
    const subject = reminder ? `Reminder: invoice ${doc.number}` : `${what} ${doc.number}`;
    const body = reminder ? messageFor(doc, true) : `${messageFor(doc, false)}\n\n(The ${what.toLowerCase()} PDF is attached.)`;
    window.location.href = `mailto:${encodeURIComponent(doc.client.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (!reminder) markSent(doc);
  };
  const remind = (doc, via) => {
    if (!subscribed) { toast("Payment reminders are a KROFT Plus feature."); onUpgrade?.(); return; }
    if (via === "whatsapp") sendWhatsApp(doc, true); else sendEmail(doc, true);
  };

  const markPaid = inv => {
    const incomeId = onRecordIncome(inv);
    update("invoice", inv.id, { status:"paid", paidDate:today, incomeId });
    toast(`${inv.number} marked paid and added to your income.`);
  };
  const markUnpaid = inv => {
    if (inv.incomeId) onRemoveIncome(inv.incomeId);
    update("invoice", inv.id, { status:"sent", paidDate:null, incomeId:null, sentAt: inv.sentAt || today });
    toast(`${inv.number} is unpaid again; its income entry was removed.`);
  };
  const convertQuote = q => {
    if (!invAllowance.allowed) { toast(blockedMsg("invoice")); onUpgrade?.(); return; }
    const { invoice } = invoiceFromQuote({ quote:q, settings, today, id:String(uid()) });
    setInvoices(list => [invoice, ...list]);
    setSettings(s => ({ ...s, nextNumber:(Number(s.nextNumber) || 1) + 1 }));
    update("quote", q.id, { status:"invoiced", invoiceId:invoice.id });
    setCurrentKind("invoice"); setCurrentId(invoice.id);
    toast(`${q.number} turned into ${invoice.number}. Check the due date, then send it.`);
  };
  const remove = doc => {
    const kind = doc.kind === "quote" ? "quote" : "invoice";
    const extra = doc.status === "paid" ? " The income it recorded stays in your finances." : "";
    if (!window.confirm(`Delete ${doc.number}?${extra}`)) return;
    setListFor(kind)(list => list.filter(d => d.id !== doc.id));
    backFromDoc();
    toast(`${doc.number} deleted.`);
  };

  const header = (title, onBack, right) => (
    <div style={{ display:"flex", alignItems:"center", gap:10, padding:"calc(12px + env(safe-area-inset-top)) 16px 12px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
      <button onClick={onBack} aria-label="Back" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1 }}>←</button>
      <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{title}</h2>
      {right}
    </div>
  );
  const linkBtn = (label, onClick) => <button onClick={onClick} style={{ background:"none", border:"none", color:C.accent, fontSize:14, fontWeight:600, cursor:"pointer", padding:"4px 2px" }}>{label}</button>;
  const chips = (items, value, onChange, label) => (
    <div role="tablist" aria-label={label} style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
      {items.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          style={{ background: value === k ? C.text : C.surface, color: value === k ? C.bg : C.soft, border:`1px solid ${value === k ? C.text : C.cardB}`, borderRadius:99, padding:"6px 12px", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:APP_FONT }}>{l}</button>
      ))}
    </div>
  );
  const docRow = (doc, from) => {
    const st = statusOf(doc);
    const sub = doc.kind === "quote"
      ? `${doc.number} · ${st === "invoiced" ? "turned into an invoice" : `valid until ${prettyDate(doc.validUntil)}`}`
      : `${doc.number} · ${st === "paid" ? `paid ${prettyDate(doc.paidDate)}` : `due ${prettyDate(doc.dueDate)}`}`;
    return (
      <Card key={doc.id} level="raised" style={{ cursor:"pointer", padding:"12px 14px" }} onClick={() => openDoc(doc, from)}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.client.name || "No client yet"}</div>
            <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{sub}</Mono>
          </div>
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <div style={{ fontSize:14, fontWeight:700, color:C.white }}>{fmt(invoiceTotals(doc).total, doc.currency)}</div>
            <Tag tone={DOC_TONE[st]} style={{ marginTop:3, display:"inline-block" }}>{STATUS_LABEL[st].toUpperCase()}</Tag>
          </div>
        </div>
      </Card>
    );
  };
  const contactButtons = c => (
    <div style={{ display:"flex", gap:8 }}>
      {c.phone && <Btn sm v="outline" style={{ flex:1 }} onClick={() => window.open(whatsappLink(c.phone, `Hi ${c.name.split(/\s+/)[0]},`), "_blank")}>WhatsApp</Btn>}
      {c.phone && <Btn sm v="outline" style={{ flex:1 }} onClick={() => { window.location.href = `tel:${c.phone.replace(/[^\d+]/g, "")}`; }}>Call</Btn>}
      {c.email && <Btn sm v="outline" style={{ flex:1 }} onClick={() => { window.location.href = `mailto:${encodeURIComponent(c.email)}`; }}>Email</Btn>}
    </div>
  );

  let body;
  if (view === "settings") {
    const d = settingsDraft || settings;
    const set = patch => setSettingsDraft({ ...d, ...patch });
    body = (
      <>
        {header("Invoice details", () => { setSettingsDraft(null); setView(current ? "view" : "list"); })}
        <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:12 }}>
          <Mono style={{ color:C.soft, lineHeight:1.6 }}>These appear on every invoice and quote you send.</Mono>
          <InvoiceField label="Business name"><Inp placeholder={user.businessName || user.name || "Your business"} value={d.businessName} onChange={e => set({ businessName:e.target.value })} /></InvoiceField>
          <InvoiceField label="Address (optional)"><Inp value={d.address} onChange={e => set({ address:e.target.value })} /></InvoiceField>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label="Email" style={{ flex:1 }}><Inp type="email" placeholder={user.email || ""} value={d.email} onChange={e => set({ email:e.target.value })} /></InvoiceField>
            <InvoiceField label="Phone" style={{ flex:1 }}><Inp type="tel" inputMode="tel" placeholder={user.phone || ""} value={d.phone} onChange={e => set({ phone:e.target.value })} /></InvoiceField>
          </div>
          <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:8 }}>How clients pay you</div>
          <InvoiceField label="Bank"><Inp placeholder="e.g. GTBank" value={d.bankName} onChange={e => set({ bankName:e.target.value })} /></InvoiceField>
          <InvoiceField label="Account name"><Inp value={d.accountName} onChange={e => set({ accountName:e.target.value })} /></InvoiceField>
          <InvoiceField label="Account number"><Inp inputMode="numeric" value={d.accountNumber} onChange={e => set({ accountNumber:e.target.value.replace(/[^\d ]/g, "") })} /></InvoiceField>
          <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:8 }}>Invoices</div>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label="Number prefix" style={{ flex:1 }}><Inp value={d.prefix} onChange={e => set({ prefix:e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() })} /></InvoiceField>
            <InvoiceField label="Next number" style={{ flex:1 }}><Inp inputMode="numeric" value={String(d.nextNumber)} onChange={e => set({ nextNumber: Math.max(1, parseInt(e.target.value.replace(/\D/g, "") || "1", 10)) })} /></InvoiceField>
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label="Payment due after (days)" style={{ flex:1 }}><Inp inputMode="numeric" value={String(d.dueDays)} onChange={e => set({ dueDays: Math.min(365, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)) })} /></InvoiceField>
            <InvoiceField label="VAT % (0 if none)" style={{ flex:1 }}><Inp inputMode="decimal" value={String(d.vatRate)} onChange={e => set({ vatRate: Math.min(100, parseFloat(e.target.value.replace(/[^\d.]/g, "")) || 0) })} /></InvoiceField>
          </div>
          <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:8 }}>Quotes</div>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label="Number prefix" style={{ flex:1 }}><Inp value={d.quotePrefix} onChange={e => set({ quotePrefix:e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() })} /></InvoiceField>
            <InvoiceField label="Valid for (days)" style={{ flex:1 }}><Inp inputMode="numeric" value={String(d.quoteValidDays)} onChange={e => set({ quoteValidDays: Math.min(365, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)) })} /></InvoiceField>
          </div>
          <InvoiceField label="Note at the bottom of invoices"><Inp value={d.note} onChange={e => set({ note:e.target.value })} /></InvoiceField>
          <Btn full onClick={() => { setSettings(d); setSettingsDraft(null); setView(current ? "view" : "list"); toast("Invoice details saved."); }}>Save</Btn>
        </div>
      </>
    );
  } else if (view === "edit" && draft) {
    const isQuote = draft.kind === "quote";
    const setD = patch => setDraft(v => ({ ...v, ...patch }));
    const setItem = (idx, patch) => setDraft(v => ({ ...v, items: v.items.map((it, i) => i === idx ? { ...it, ...patch } : it) }));
    const t = invoiceTotals(draft);
    const pickContact = name => {
      const c = contacts.find(x => (x.name || "").toLowerCase() === name.trim().toLowerCase());
      setD({ clientId: c ? c.id : null, client: { ...draft.client, name, ...(c ? { email: draft.client.email || c.email || "", phone: draft.client.phone || c.phone || "" } : {}) } });
    };
    const what = isQuote ? "quote" : "invoice";
    body = (
      <>
        {header(draft._new ? `New ${what} · ${draft.number}` : `Edit ${draft.number}`, () => { setDraft(null); setView(current ? "view" : returnTo === "client" && clientKeySel ? "client" : "list"); })}
        <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:12, fontWeight:600, color:C.muted }}>{isQuote ? "Quote for" : "Bill to"}</div>
          <InvoiceField label="Client name">
            <Inp list="kroft-invoice-contacts" placeholder="Who is this for?" value={draft.client.name} onChange={e => pickContact(e.target.value)} />
            <datalist id="kroft-invoice-contacts">{contacts.filter(c => c.name).map(c => <option key={c.id} value={c.name} />)}</datalist>
          </InvoiceField>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label="Email (optional)" style={{ flex:1 }}><Inp type="email" value={draft.client.email} onChange={e => setD({ client:{ ...draft.client, email:e.target.value } })} /></InvoiceField>
            <InvoiceField label="Phone (optional)" style={{ flex:1 }}><Inp type="tel" inputMode="tel" value={draft.client.phone} onChange={e => setD({ client:{ ...draft.client, phone:e.target.value } })} /></InvoiceField>
          </div>

          <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:6 }}>Items</div>
          {draft.items.map((it, idx) => (
            <Card key={it.id} level="inset" style={{ padding:12, display:"flex", flexDirection:"column", gap:8 }}>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <Inp aria-label={`Item ${idx + 1} description`} placeholder="Description, e.g. Logo design" value={it.description} onChange={e => setItem(idx, { description:e.target.value })} />
                {draft.items.length > 1 && <button aria-label={`Remove item ${idx + 1}`} onClick={() => setD({ items: draft.items.filter((_, i) => i !== idx) })} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:18, padding:"4px 6px" }}>✕</button>}
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <Inp aria-label={`Item ${idx + 1} quantity`} inputMode="decimal" placeholder="Qty" value={String(it.qty ?? "")} onChange={e => setItem(idx, { qty: e.target.value.replace(/[^\d.]/g, "") })} style={{ width:70, flex:"none" }} />
                <Mono style={{ color:C.muted }}>×</Mono>
                <Inp aria-label={`Item ${idx + 1} price`} inputMode="decimal" placeholder={`Price (${draft.currency})`} value={it.price ? String(it.price) : ""} onChange={e => setItem(idx, { price: parseFloat(e.target.value.replace(/[^\d.]/g, "")) || 0 })} />
              </div>
            </Card>
          ))}
          <Btn sm v="outline" onClick={() => setD({ items:[...draft.items, { id:`${draft.id}-${Date.now()}`, description:"", qty:1, price:0 }] })}>+ Add item</Btn>

          <div style={{ display:"flex", gap:10, marginTop:6 }}>
            <InvoiceField label={isQuote ? "Quote date" : "Invoice date"} style={{ flex:1 }}><Inp type="date" value={draft.issueDate} onChange={e => setD({ issueDate:e.target.value })} /></InvoiceField>
            {isQuote
              ? <InvoiceField label="Valid until" style={{ flex:1 }}><Inp type="date" value={draft.validUntil} onChange={e => setD({ validUntil:e.target.value })} /></InvoiceField>
              : <InvoiceField label="Due date" style={{ flex:1 }}><Inp type="date" value={draft.dueDate} onChange={e => setD({ dueDate:e.target.value })} /></InvoiceField>}
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <InvoiceField label={`Discount (${draft.currency})`} style={{ flex:1 }}><Inp inputMode="decimal" value={draft.discount ? String(draft.discount) : ""} onChange={e => setD({ discount: parseFloat(e.target.value.replace(/[^\d.]/g, "")) || 0 })} /></InvoiceField>
            <InvoiceField label="VAT %" style={{ flex:1 }}><Inp inputMode="decimal" value={draft.vatRate ? String(draft.vatRate) : ""} placeholder="0" onChange={e => setD({ vatRate: Math.min(100, parseFloat(e.target.value.replace(/[^\d.]/g, "")) || 0) })} /></InvoiceField>
          </div>
          <InvoiceField label="Notes (optional)"><Inp value={draft.notes} onChange={e => setD({ notes:e.target.value })} /></InvoiceField>

          <Card level="raised" style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {[["Subtotal", t.subtotal], ...(t.discount ? [["Discount", -t.discount]] : []), ...(t.vat ? [[`VAT (${t.vatRate}%)`, t.vat]] : [])].map(([l, v]) => (
              <div key={l} style={{ display:"flex", justifyContent:"space-between" }}><Mono style={{ color:C.soft }}>{l}</Mono><Mono style={{ color:C.text }}>{fmt(v, draft.currency)}</Mono></div>
            ))}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginTop:4 }}>
              <span style={{ fontSize:13, fontWeight:600, color:C.white }}>Total</span>
              <span style={{ fontSize:20, fontWeight:700, color:C.white, letterSpacing:-.6 }}>{fmt(t.total, draft.currency)}</span>
            </div>
          </Card>
          <Btn full onClick={saveDraft}>{isQuote ? "Save quote" : "Save invoice"}</Btn>
        </div>
      </>
    );
  } else if (view === "view" && current) {
    const isQuote = current.kind === "quote";
    const st = statusOf(current);
    const t = invoiceTotals(current);
    const late = st === "overdue" ? daysBetween(current.dueDate, today) : 0;
    const linkedInvoice = isQuote && current.invoiceId ? invoices.find(i => i.id === current.invoiceId) : null;
    const fromQuote = !isQuote && current.quoteId ? quotes.find(q => q.id === current.quoteId) : null;
    const subline = isQuote
      ? (st === "invoiced" ? `Turned into ${linkedInvoice?.number || "an invoice"}` : st === "expired" ? `Expired ${prettyDate(current.validUntil)}` : `Valid until ${prettyDate(current.validUntil)}`)
      : (st === "paid" ? `Paid ${prettyDate(current.paidDate)}` : st === "overdue" ? `${late} day${late === 1 ? "" : "s"} overdue · due ${prettyDate(current.dueDate)}` : `Due ${prettyDate(current.dueDate)}`);
    body = (
      <>
        {header(current.number, backFromDoc, st !== "invoiced" && linkBtn("Edit", () => startEdit(current)))}
        <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:15, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{current.client.name}</div>
              <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{subline}</Mono>
            </div>
            <div style={{ textAlign:"right", flexShrink:0 }}>
              <div style={{ fontSize:20, fontWeight:700, color:C.white, letterSpacing:-.6 }}>{fmt(t.total, current.currency)}</div>
              <Tag tone={DOC_TONE[st]}>{STATUS_LABEL[st].toUpperCase()}</Tag>
            </div>
          </div>

          {!isQuote && needsDetails && st !== "paid" && (
            <Card level="inset" style={{ borderStyle:"dashed", borderColor:C.warning+"66", cursor:"pointer" }} onClick={() => setView("settings")}>
              <Mono style={{ color:C.text, lineHeight:1.6 }}>Add your bank details so clients know how to pay you. <span style={{ color:C.accent, fontWeight:600 }}>Add details</span></Mono>
            </Card>
          )}
          {fromQuote && <Mono style={{ color:C.muted }}>From quote {fromQuote.number}.</Mono>}

          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {st !== "invoiced" && (
              <>
                <Btn full disabled={busy === "pdf"} onClick={() => sharePdf(current)}>{busy === "pdf" ? "Preparing PDF…" : isNativeApp ? "Share PDF" : "Share or download PDF"}</Btn>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn sm v="outline" style={{ flex:1 }} onClick={() => sendWhatsApp(current, false)}>WhatsApp</Btn>
                  <Btn sm v="outline" style={{ flex:1 }} onClick={() => sendEmail(current, false)}>Email</Btn>
                </div>
              </>
            )}
            {isQuote && ["draft","sent","expired","accepted"].includes(st) && (
              <Btn full v={st === "accepted" ? "solid" : "outline"} onClick={() => convertQuote(current)}>Turn into invoice</Btn>
            )}
            {isQuote && ["draft","sent","expired"].includes(st) && (
              <div style={{ display:"flex", gap:8 }}>
                <Btn sm v="outline" style={{ flex:1 }} onClick={() => { update("quote", current.id, { status:"accepted" }); toast(`${current.number} accepted.`); }}>Client accepted</Btn>
                <Btn sm v="outline" style={{ flex:1 }} onClick={() => { update("quote", current.id, { status:"declined" }); toast(`${current.number} marked declined.`); }}>Declined</Btn>
              </div>
            )}
            {isQuote && (st === "accepted" || st === "declined") && (
              <Btn sm v="ghost" onClick={() => update("quote", current.id, { status:"sent" })}>Undo: back to sent</Btn>
            )}
            {linkedInvoice && <Btn full v="outline" onClick={() => openDoc(linkedInvoice, returnTo)}>Open {linkedInvoice.number}</Btn>}
            {!isQuote && (st === "sent" || st === "overdue") && (
              <>
                <Btn full v="outline" onClick={() => markPaid(current)}>Mark as paid</Btn>
                <Card level="inset" style={{ padding:12 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:C.white }}>Payment reminder</span>
                    {!subscribed && <Tag tone="accent">PLUS</Tag>}
                  </div>
                  <Mono style={{ display:"block", color:C.soft, lineHeight:1.6, marginBottom:10 }}>A polite message saying how much is due and how to pay.</Mono>
                  <div style={{ display:"flex", gap:8 }}>
                    <Btn sm v="outline" style={{ flex:1 }} onClick={() => remind(current, "whatsapp")}>Remind on WhatsApp</Btn>
                    <Btn sm v="outline" style={{ flex:1 }} onClick={() => remind(current, "email")}>By email</Btn>
                  </div>
                </Card>
              </>
            )}
            {st === "draft" && <Mono style={{ color:C.muted, lineHeight:1.6 }}>{isQuote ? "Sharing it marks it as sent." : "Sharing it marks it as sent, so KROFT can tell you when it's overdue."}</Mono>}
            {!isQuote && st === "paid" && <Btn full v="outline" onClick={() => markUnpaid(current)}>Mark as unpaid</Btn>}
          </div>

          <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:6 }}>Preview</div>
          <div style={{ background:"#fff", borderRadius:12, border:`1px solid ${C.cardB}`, overflow:"hidden", minHeight:120, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
            {preview ? <img src={preview} alt={`Preview of ${current.number}`} style={{ width:"100%", display:"block" }} /> : <Spinner size={16} color={C.muted} />}
          </div>

          <div style={{ display:"flex", gap:8, marginTop:4 }}>
            <Btn sm v="outline" style={{ flex:1 }} onClick={() => duplicate(current)}>Duplicate</Btn>
            <Btn sm v="outline" style={{ flex:1 }} onClick={() => setView("settings")}>Invoice details</Btn>
            <Btn sm v="ghost" style={{ flex:1, color:C.negative }} onClick={() => remove(current)}>Delete</Btn>
          </div>
        </div>
      </>
    );
  } else if (view === "client" && clientKeySel) {
    const c = clients.find(x => x.key === clientKeySel);
    const docs = [...invoices, ...quotes].filter(d => clientKey(d) === clientKeySel).sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || ""));
    body = (
      <>
        {header(c?.name || "Client", () => { setClientKeySel(null); setView("list"); })}
        <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:12 }}>
          {c && (
            <>
              <Card level="raised">
                <div style={{ display:"flex", justifyContent:"space-between", gap:12 }}>
                  <div>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:3 }}>Owes you</Mono>
                    <div style={{ fontSize:22, fontWeight:700, color:Object.keys(c.owed).length ? C.white : C.muted, letterSpacing:-.8 }}>{sumByCur(c.owed, fmt) || fmt(0, user.currency)}</div>
                    {c.overdueCount > 0 && <Mono style={{ display:"block", color:C.negative, marginTop:3 }}>{c.overdueCount} overdue</Mono>}
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:3 }}>Paid so far</Mono>
                    <div style={{ fontSize:16, fontWeight:700, color:C.positive }}>{sumByCur(c.paid, fmt) || fmt(0, user.currency)}</div>
                    <Mono style={{ display:"block", color:C.muted, marginTop:3 }}>{c.invoiceCount} invoice{c.invoiceCount === 1 ? "" : "s"} · {c.quoteCount} quote{c.quoteCount === 1 ? "" : "s"}</Mono>
                  </div>
                </div>
              </Card>
              {(c.phone || c.email) ? contactButtons(c) : <Mono style={{ color:C.muted }}>No phone or email saved. Add them on an invoice or in Contacts.</Mono>}
              <div style={{ display:"flex", gap:8 }}>
                <Btn sm style={{ flex:1 }} onClick={() => startNew("invoice", c)}>New invoice</Btn>
                <Btn sm v="outline" style={{ flex:1 }} onClick={() => startNew("quote", c)}>New quote</Btn>
              </div>
              <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginTop:6 }}>History</div>
              <div style={{ display:"flex", flexDirection:"column", gap:9 }}>{docs.map(d => docRow(d, "client"))}</div>
            </>
          )}
        </div>
      </>
    );
  } else {
    // Lists: Invoices, Quotes, Clients
    const unpaid = invoices.filter(inv => ["sent","overdue"].includes(statusOf(inv)));
    const overdueN = unpaid.filter(inv => statusOf(inv) === "overdue").length;
    const outstanding = unpaid.reduce((acc, inv) => { acc[inv.currency] = (acc[inv.currency] || 0) + invoiceTotals(inv).total; return acc; }, {});
    const sortDocs = list => list.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || String(b.number).localeCompare(String(a.number)));
    let content;
    if (tab === "clients") {
      content = clients.length === 0 ? (
        <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
          <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No clients yet</div>
          <Mono style={{ display:"block", color:C.soft, lineHeight:1.6 }}>Everyone you send an invoice or quote to appears here, with what they owe you and have paid.</Mono>
        </Card>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
          {clients.map(c => (
            <Card key={c.key} level="raised" style={{ cursor:"pointer", padding:"12px 14px" }} onClick={() => { setClientKeySel(c.key); setView("client"); }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name}</div>
                  <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{c.invoiceCount} invoice{c.invoiceCount === 1 ? "" : "s"}{c.openQuotes ? ` · ${c.openQuotes} open quote${c.openQuotes === 1 ? "" : "s"}` : ""}{c.lastDate ? ` · last ${prettyDate(c.lastDate)}` : ""}</Mono>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  {Object.keys(c.owed).length
                    ? <><div style={{ fontSize:14, fontWeight:700, color:C.white }}>{sumByCur(c.owed, fmt)}</div><Tag tone={c.overdueCount ? "negative" : "accent"} style={{ marginTop:3, display:"inline-block" }}>{c.overdueCount ? "OVERDUE" : "OWES YOU"}</Tag></>
                    : Object.keys(c.paid).length ? <Mono style={{ color:C.positive }}>All paid</Mono> : <Mono style={{ color:C.muted }}>Nothing owed</Mono>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      );
    } else if (tab === "quotes") {
      const counts = quotes.reduce((acc, q) => { const s = statusOf(q); acc[s] = (acc[s] || 0) + 1; return acc; }, {});
      const shown = sortDocs(quotes.filter(q => filter === "all" || (filter === "open" ? ["draft","sent","accepted"].includes(statusOf(q)) : statusOf(q) === filter)));
      content = (
        <>
          <Btn full onClick={() => startNew("quote")}>New quote</Btn>
          <Mono style={{ display:"block", color:C.muted, margin:"8px 0 16px", textAlign:"center" }}>
            {subscribed ? "Unlimited quotes with KROFT Plus." : `${qAllowance.used} of ${qAllowance.limit} free quotes used this month.`}
          </Mono>
          {quotes.length > 0 && chips([["all","All"],["open",`Open${(counts.draft||0)+(counts.sent||0)+(counts.accepted||0) ? ` ${(counts.draft||0)+(counts.sent||0)+(counts.accepted||0)}` : ""}`],["accepted","Accepted"],["invoiced","Invoiced"],["declined","Declined"]], filter, setFilter, "Filter quotes")}
          {quotes.length === 0 ? (
            <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
              <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No quotes yet</div>
              <Mono style={{ display:"block", color:C.soft, lineHeight:1.6 }}>Send a price before you start the job. When the client agrees, turn it into an invoice in one tap.</Mono>
            </Card>
          ) : shown.length === 0 ? (
            <Card level="inset" style={{ textAlign:"center", padding:22, borderStyle:"dashed" }}><Mono style={{ color:C.soft }}>Nothing here.</Mono></Card>
          ) : <div style={{ display:"flex", flexDirection:"column", gap:9 }}>{shown.map(q => docRow(q, "list"))}</div>}
        </>
      );
    } else {
      const counts = invoices.reduce((acc, inv) => { const s = statusOf(inv); acc[s] = (acc[s] || 0) + 1; return acc; }, {});
      const shown = sortDocs(invoices.filter(inv => filter === "all" || (filter === "unpaid" ? ["sent","overdue"].includes(statusOf(inv)) : statusOf(inv) === filter)));
      content = (
        <>
          <Btn full onClick={() => startNew("invoice")}>New invoice</Btn>
          <Mono style={{ display:"block", color:C.muted, margin:"8px 0 16px", textAlign:"center" }}>
            {subscribed ? "Unlimited invoices with KROFT Plus." : `${invAllowance.used} of ${invAllowance.limit} free invoices used this month.`}
          </Mono>
          {unpaid.length > 0 && (
            <Card level="raised" style={{ marginBottom:14 }}>
              <Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>Waiting to be paid</Mono>
              <div style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-.8 }}>{sumByCur(outstanding, fmt)}</div>
              <Mono style={{ display:"block", color:overdueN ? C.negative : C.soft, marginTop:3 }}>{unpaid.length} unpaid{overdueN ? ` · ${overdueN} overdue` : ""}</Mono>
            </Card>
          )}
          {invoices.length > 0 && chips([["all","All"],["unpaid",`Unpaid${unpaid.length ? ` ${unpaid.length}` : ""}`],["overdue",`Overdue${overdueN ? ` ${overdueN}` : ""}`],["paid",`Paid${counts.paid ? ` ${counts.paid}` : ""}`],["draft",`Drafts${counts.draft ? ` ${counts.draft}` : ""}`]], filter, setFilter, "Filter invoices")}
          {invoices.length === 0 ? (
            <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
              <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No invoices yet</div>
              <Mono style={{ display:"block", color:C.soft, lineHeight:1.6 }}>Create one here, or just ask KROFT: "Invoice Tunde ₦50,000 for the logo design, due Friday."</Mono>
            </Card>
          ) : shown.length === 0 ? (
            <Card level="inset" style={{ textAlign:"center", padding:22, borderStyle:"dashed" }}><Mono style={{ color:C.soft }}>Nothing here.</Mono></Card>
          ) : <div style={{ display:"flex", flexDirection:"column", gap:9 }}>{shown.map(inv => docRow(inv, "list"))}</div>}
        </>
      );
    }
    body = (
      <>
        {header("Invoices", onClose, linkBtn("Details", () => setView("settings")))}
        <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16 }}>
          <div role="tablist" aria-label="Invoices, quotes and clients" style={{ display:"flex", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:3, marginBottom:16 }}>
            {[["invoices","Invoices"],["quotes","Quotes"],["clients","Clients"]].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setFilter("all"); }}
                style={{ flex:1, background: tab === k ? C.card : "transparent", color: tab === k ? C.white : C.soft, border:"none", borderRadius:9, padding:"8px 6px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:APP_FONT, boxShadow: tab === k ? C.shadowBase : "none" }}>{l}</button>
            ))}
          </div>
          {content}
        </div>
      </>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Invoices" style={{ position:"fixed", inset:0, zIndex:310, background:C.bg, display:"flex", flexDirection:"column" }}>
      {body}
    </div>
  );
}

// Android app only: what KROFT is allowed to use on this phone, with a button to ask for anything
// that's still off. Android stops showing its prompt after someone taps "Don't allow" twice; from
// then on only the phone's Settings can turn it back on, which the hint below says.
const APP_PERMISSIONS = [
  { key:"microphone", label:"Microphone", why:"Voice input, voice mode and voice memos" },
  { key:"location", label:"Location", why:"Around Me (places near you)" },
  { key:"notifications", label:"Notifications", why:"Reminders and daily briefings" },
  { key:"exact", label:"Alarms & reminders", why:"Reminders on the exact minute (otherwise they can arrive a few minutes late)" },
];
function AppPermissions({ toast }) {
  const [state, setState] = useState(null);
  const [asking, setAsking] = useState("");
  const refresh = useCallback(() => {
    Promise.all([getAppPermissions(), exactAlarmStatus()])
      .then(([perms, exact]) => setState({ ...perms, exact }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    // Picks up changes made in the phone's Settings while KROFT was in the background.
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  const ask = async key => {
    setAsking(key);
    // "Alarms & reminders" has no prompt: Android opens its settings page for KROFT instead.
    const result = key === "exact" ? await openExactAlarmSetting() : await requestAppPermission(key);
    if (key === "exact") { setAsking(""); refresh(); return; }
    setAsking("");
    refresh();
    if (result === "needs-update") toast("Update the KROFT app to turn this on from here.");
    else if (result !== "granted") toast("Android didn't allow it. Open your phone's Settings → Apps → KROFT → Permissions to turn it on.");
  };
  if (!state) return <Mono style={{ display:"block", color:C.muted }}>Checking…</Mono>;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {APP_PERMISSIONS.map(p => {
        const on = state[p.key] === "granted";
        return (
          <div key={p.key} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:C.white }}>{p.label}</div>
              <Mono style={{ display:"block", color:C.muted, marginTop:2 }}>{p.why}</Mono>
            </div>
            {on
              ? <Mono style={{ color:C.positive, fontWeight:600, flexShrink:0 }}>Allowed</Mono>
              : <Btn v="outline" sm onClick={() => ask(p.key)} disabled={!!asking} style={{ flexShrink:0 }}>{asking === p.key ? "Asking…" : "Allow"}</Btn>}
          </div>
        );
      })}
      <Mono style={{ display:"block", color:C.muted, lineHeight:1.7 }}>If Allow doesn't bring up a prompt, Android has stopped asking: turn it on in your phone's Settings → Apps → KROFT → Permissions.</Mono>
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

function ProfileSection({ nav, onNav, connections, user, onUpdateName, onEditBusinessDetails, onSignOut, theme, onToggleTheme, toast, subscribed, subscriptionStatus, autoRenews, billingLoading, onUpgrade, onManageBilling, usageStats, voiceReplies, onSetVoiceReplies, proactiveInsights, onSetProactiveInsights, wellnessAiContext, onSetWellnessAiContext, voicePref, onSetVoicePref, voiceSpeed, onSetVoiceSpeed, onSetupBiometric, onRemoveBiometric, biometricOn, onExportData, onImportData, onDeleteAccount, notifPermission, notifPrefs, onEnableNotifications, onSetNotifPref, onTestNotification, voiceTurnsCount, voiceLimit }) {
  // nav.screen is null for the main hub, otherwise a key of SCREENS below. Held in KroftApp (see
  // profileNav there) so it survives the remount a theme change triggers.
  const { screen, openRow } = nav;
  const setOpenRow = row => onNav(n => ({ ...n, openRow:row }));
  const fileInputRef = useRef(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = k => setOpenRow(openRow===k ? null : k);
  const initials = user.name ? user.name.split(" ").map(n=>n[0]).join("").toUpperCase().slice(0,2) : "?";
  const goBack = () => onNav({ screen:null, openRow:null });

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

  // Every setting, keyed so the screens below can group them. Each is the same expandable row it
  // always was; only which screen it lives on changed.
  const rows = {
    memory: (
      <ProfileRow label="AI Memory" sub="What KROFT remembers about you" expanded={openRow==="memory"} onToggle={()=>toggle("memory")}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{isSupabaseConfigured ? "KROFT remembers your recent conversation (the last 60 messages) across visits, plus your finances, appointments, and mood, to answer with real context. It's kept in your own account and never shared with other KROFT users." : "KROFT remembers your recent conversation (the last 60 messages) on this device, plus your finances, appointments, and mood, to answer with real context. Nothing leaves this device in local-only mode."}</Mono>
      </ProfileRow>
    ),
    voice: (
      <ProfileRow label="Voice & Language" sub={`English (US) · ${VOICE_PROFILES[resolveVoiceId(voicePref)].name}`} expanded={openRow==="voice"} onToggle={()=>toggle("voice")}
        right={<ProfileSwitch value={voiceReplies} onChange={onSetVoiceReplies} />}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:14 }}>{voiceReplies ? "KROFT speaks replies and reminders aloud." : "KROFT will stay silent unless you tap Read Aloud — voice is never required to use KROFT."}</Mono>
        <VoiceStyleSpeedControls voicePref={voicePref} onSetVoicePref={onSetVoicePref} voiceSpeed={voiceSpeed} onSetVoiceSpeed={onSetVoiceSpeed} />
      </ProfileRow>
    ),
    appearance: (
      <ProfileRow label="Appearance" sub={theme==="dark" ? "Dark mode" : "Light mode"} expanded={openRow==="appearance"} onToggle={()=>toggle("appearance")}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:12 }}>Switch between dark and light. Both use only black, white and off-white — no grey.</Mono>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={() => onToggleTheme("dark")} style={{ flex:1, padding:"11px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:theme==="dark"?C.white:C.surface, border:`1px solid ${theme==="dark"?C.white:C.cardB}`, color:theme==="dark"?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:APP_FONT }}>
            Dark
          </button>
          <button onClick={() => onToggleTheme("light")} style={{ flex:1, padding:"11px 6px", borderRadius:10, cursor:"pointer", textAlign:"center", background:theme==="light"?C.white:C.surface, border:`1px solid ${theme==="light"?C.white:C.cardB}`, color:theme==="light"?C.black:C.text, fontSize:12, fontWeight:700, fontFamily:APP_FONT }}>
            Light
          </button>
        </div>
      </ProfileRow>
    ),
    notifs: (
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
    ),
    auto: (
      <ProfileRow label="Smart Automations" sub="Reminders, briefings, insights" expanded={openRow==="auto"} onToggle={()=>toggle("auto")}
        right={<ProfileSwitch value={proactiveInsights} onChange={onSetProactiveInsights} />}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{proactiveInsights ? "KROFT proactively surfaces reminders and daily insights." : "KROFT will only respond when asked."}</Mono>
      </ProfileRow>
    ),
    faceid: (
      <ProfileRow label={isNativeApp ? "Fingerprint or face unlock" : "Face ID"} sub={biometricOn ? "Enabled for this device" : "Not set up"} expanded={openRow==="faceid"} onToggle={()=>toggle("faceid")}
        right={<ProfileSwitch value={!!biometricOn} onChange={v => v ? onSetupBiometric() : onRemoveBiometric()} />}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{isNativeApp
          ? "Locks KROFT with your phone's own fingerprint or face unlock. It's asked for when you open the app, and when you come back after more than 5 minutes away."
          : "Biometric sign-in uses your device's real WebAuthn platform authenticator (Face ID, Touch ID, or Windows Hello) — turning this on will prompt an actual biometric check on this device, not just a toggle."}</Mono>
      </ProfileRow>
    ),
    perms: (
      <ProfileRow label="App permissions" sub="Microphone, location, notifications" expanded={openRow==="perms"} onToggle={()=>toggle("perms")}>
        <AppPermissions toast={toast} />
      </ProfileRow>
    ),
    privacy: (
      <ProfileRow label="Privacy Controls" sub="Data sharing, visibility" expanded={openRow==="privacy"} onToggle={()=>toggle("privacy")}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>Your data stays scoped to your own account and is never shared with other KROFT users.</Mono>
      </ProfileRow>
    ),
    wellnessai: (
      <ProfileRow label="Wellness Data in KROFT Chat" sub={wellnessAiContext ? "KROFT can reference your wellness data" : "Off"} expanded={openRow==="wellnessai"} onToggle={()=>toggle("wellnessai")}
        right={<ProfileSwitch value={wellnessAiContext} onChange={onSetWellnessAiContext} />}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7 }}>{wellnessAiContext
          ? "KROFT Chat can reference your mood, sleep, journal and pattern data to answer wellness questions — always as observations from your own data, never as a diagnosis. Your Wellness tab keeps working the same either way."
          : "KROFT Chat will not see or reference any wellness data — mood, sleep, journal entries or Your Patterns stay out of its context entirely. The Wellness tab itself is unaffected."}</Mono>
      </ProfileRow>
    ),
    data: (
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
    ),
    plus: (
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
    ),
    billing: (
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
    ),
    paymethods: (
      <ProfileRow label="Payment Methods" sub={subscribed ? "On file with our payment partner" : "None on file"} expanded={openRow==="paymethods"} onToggle={()=>toggle("paymethods")}>
        <Mono style={{ display:"block", color:C.soft, lineHeight:1.7, marginBottom:subscribed?10:0 }}>
          {subscribed
            ? "Card details live with our payment partner, not KROFT. There's no self-serve way to swap the card on an active plan — cancel here, then re-subscribe with the new card."
            : "Card entry happens through our secure payment partner once you upgrade to KROFT Plus."}
        </Mono>
        {subscribed && <Btn sm v="outline" disabled={billingLoading} onClick={onManageBilling}>{billingLoading ? <Spinner size={14} color={C.soft} thickness={2} /> : "Cancel plan"}</Btn>}
      </ProfileRow>
    ),
    usage: (
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
    ),
    managesub: (
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
    ),
    report: (
      <ProfileRow label="Contact Support" sub="Something not working right" expanded={openRow==="report"} onToggle={()=>toggle("report")}>
        <textarea
          placeholder="Describe what happened…"
          rows={3}
          value={supportMsg}
          onChange={e => { setSupportMsg(e.target.value); setSupportSent(false); }}
          style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:8 }}
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
    ),
    feature: (
      <ProfileRow label="Send Feedback" sub="Tell us what to build next" expanded={openRow==="feature"} onToggle={()=>toggle("feature")}>
        <textarea
          placeholder="What would make KROFT better?"
          rows={3}
          value={feedbackMsg}
          onChange={e => { setFeedbackMsg(e.target.value); setFeedbackSent(false); }}
          style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:8 }}
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
    ),
  };

  // Plan summary shown above the plan's rows.
  const planSummary = (
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
  );

  // The screen each Profile row opens. One with a single setting opens it already expanded —
  // tapping into a screen only to tap again to reveal its one row is a wasted step.
  const SCREENS = {
    connected:       { title:"Connected apps", body:<ConnectedApps google={connections.google} microsoft={connections.microsoft} />, rows:[] },
    plan:            { title:subscribed ? "KROFT Plus" : "Upgrade plan", top:planSummary, rows:["plus", "billing", "paymethods", "managesub"] },
    usage:           { title:"Usage and limits", rows:["usage"] },
    appearance:      { title:"Appearance", rows:["appearance"] },
    notifications:   { title:"Notifications", rows:["notifs"] },
    voice:           { title:"Voice", rows:["voice"] },
    automations:     { title:"Automations", rows:["auto"] },
    security:        { title:"Security and login", rows: isNativeApp ? ["faceid", "perms"] : ["faceid"] },
    privacy:         { title:"Privacy center", rows:["privacy", "memory", "wellnessai"], bottom:(
      <div style={{ marginTop:26 }}>
        <SettingsGroup>
          <SettingsRow icon="trash" label="Delete account" tone="danger" onClick={() => setConfirmDelete(true)} isLast />
        </SettingsGroup>
        <Mono style={{ display:"block", color:C.muted, lineHeight:1.7, margin:"-14px 18px 0" }}>Permanently removes your account and all of its data.</Mono>
      </div>
    ) },
    data:            { title:"History and data", rows:["data"] },
    report:          { title:"Report a problem", rows:["report"] },
    feedback:        { title:"Send feedback", rows:["feature"] },
  };
  const goTo = key => onNav({ screen:key, openRow:SCREENS[key].rows.length === 1 ? SCREENS[key].rows[0] : null });

  if (screen && SCREENS[screen]) {
    const s = SCREENS[screen];
    return (
      <div style={{ animation:"fadeUp .25s ease" }}>
        <ProfileScreenHeader title={s.title} onBack={goBack} />
        {s.top}
        {s.body}
        {s.rows.length > 0 && (
          <Card style={{ padding:"2px 16px" }}>
            {s.rows.map(k => <Fragment key={k}>{rows[k]}</Fragment>)}
          </Card>
        )}
        {s.bottom}
        {confirmDelete && createPortal(<DeleteAccountDialog synced={isSupabaseConfigured} subscribed={subscribed}
          onCancel={() => setConfirmDelete(false)} onConfirm={onDeleteAccount} />, document.body)}
      </div>
    );
  }

  // ── MAIN HUB ──
  const g = connections.google.status, m = connections.microsoft.status;
  const connectedCount = [g.gmail || g.calendar, m.mail || m.calendar].filter(Boolean).length;
  const GROUPS = [
    { title:"Account", items:[
      { icon:"store", label:"Business", value:`${user.businessName || "Personal"} · ${user.currency}`, onClick:onEditBusinessDetails },
      subscribed
        ? { key:"plan", icon:"crown", label:"KROFT Plus", value:"Active" }
        : { key:"plan", icon:"crown", label:"Upgrade plan", tone:"accent", value:subscriptionStatus === "past_due" ? "Renewal failed" : "" },
      { key:"usage", icon:"gauge", label:"Usage and limits" },
      user.email && { icon:"at", label:"Email", detail:user.email },
      user.phone && { icon:"phone", label:"Phone", detail:user.phone },
    ].filter(Boolean) },
    { items:[
      { key:"connected", icon:"link", label:"Connected apps", value:connectedCount ? `${connectedCount} connected` : "" },
      { key:"appearance", icon:"contrast", label:"Appearance", value:theme === "dark" ? "Dark" : "Light" },
      { key:"notifications", icon:"reminders", label:"Notifications", value:{ granted:"On", denied:"Blocked", unsupported:"Unavailable" }[notifPermission] || "Off" },
      { key:"voice", icon:"mic", label:"Voice", value:voiceReplies ? VOICE_PROFILES[resolveVoiceId(voicePref)].name : "Off" },
      { key:"automations", icon:"wand", label:"Automations", value:proactiveInsights ? "On" : "Off" },
      { key:"security", icon:"lock", label:"Security and login", value:biometricOn ? (isNativeApp ? "Biometrics on" : "Face ID on") : "" },
      { key:"privacy", icon:"eye", label:"Privacy center" },
      { key:"data", icon:"cloud", label:"History and data", value:isSupabaseConfigured ? "Synced" : "This device" },
      { key:"report", icon:"flag", label:"Report a problem" },
      { key:"feedback", icon:"nova", label:"Send feedback" },
    ] },
  ];

  return (
    <div style={{ animation:"fadeUp .25s ease" }}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", marginBottom:28 }}>
        <div style={{ width:84, height:84, borderRadius:"50%", overflow:"hidden", background:user.photo?`url(${user.photo}) center/cover no-repeat`:C.surface, border:`2px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:28, fontWeight:700, color:C.white, marginBottom:14 }}>
          {!user.photo && initials}
        </div>
        {editingName ? (
          <div style={{ width:"100%", maxWidth:260 }}>
            <Inp autoFocus value={nameDraft} onChange={e=>setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key==="Enter") saveName(); if (e.key==="Escape") cancelEditName(); }}
              placeholder="What should KROFT call you?" style={{ textAlign:"center", marginBottom:8 }} />
            <div style={{ display:"flex", gap:7 }}>
              <Btn sm v="outline" onClick={cancelEditName} style={{ flex:1 }}>Cancel</Btn>
              <Btn sm disabled={!nameDraft.trim()} onClick={saveName} style={{ flex:1 }}>Save</Btn>
            </div>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-.5 }}>{user.name || "Your name"}</div>
            <button onClick={() => { setNameDraft(user.name||""); setEditingName(true); }} aria-label="Edit your name" title="Edit your name"
              style={{ background:"none", border:"none", cursor:"pointer", padding:4, display:"flex", alignItems:"center" }}>
              <NavIcon id="edit" size={16} color={C.muted} />
            </button>
          </div>
        )}
      </div>

      {GROUPS.map((g, gi) => (
        <SettingsGroup key={gi} title={g.title}>
          {g.items.map((it, i) => (
            <SettingsRow key={it.label} icon={it.icon} label={it.label} value={it.value} detail={it.detail} tone={it.tone}
              onClick={it.onClick || (it.key ? () => goTo(it.key) : undefined)} isLast={i === g.items.length - 1} />
          ))}
        </SettingsGroup>
      ))}

      <SettingsGroup>
        <SettingsRow icon="logout" label="Log out" tone="danger" onClick={() => setConfirmLogout(true)} isLast />
      </SettingsGroup>
      <Mono style={{ display:"block", textAlign:"center", color:C.muted, marginTop:-8 }}>KROFT by Orynthra</Mono>
      <div style={{ display:"flex", justifyContent:"center", gap:18, marginTop:10 }}>
        <a href="/terms.html" target="_blank" rel="noopener" style={{ fontSize:13, color:C.muted, textDecoration:"underline" }}>Terms</a>
        <a href="/privacy.html" target="_blank" rel="noopener" style={{ fontSize:13, color:C.muted, textDecoration:"underline" }}>Privacy</a>
      </div>

      {confirmLogout && createPortal(<LogoutDialog onCancel={() => setConfirmLogout(false)} onConfirm={onSignOut} />, document.body)}
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
        <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:C.bg, color:C.text, fontFamily:APP_FONT, padding:24 }}>
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
                style={{ background:C.white, color:C.black, border:"none", borderRadius:12, padding:"11px 22px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:APP_FONT }}
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{ background:"transparent", color:C.text, border:`1px solid ${C.border}`, borderRadius:12, padding:"11px 22px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:APP_FONT }}
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
// Reopening KROFT after this long without chatting starts a new chat; the old one stays in history.
const CHAT_IDLE_RESET_MS = 60 * 60 * 1000;

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

// seconds:0 marks the "close your eyes" session, whose duration the user picks freely rather than
// the app dictating one.
const QUICK_RESET_KINDS = [
  { key:"breathe1", label:"1-min breathing", seconds:60, guide:"Breathe in slowly through your nose, then out through your mouth." },
  { key:"breathe3", label:"3-min breathing", seconds:180, guide:"Breathe in slowly through your nose, then out through your mouth." },
  { key:"breathe5", label:"5-min breathing", seconds:300, guide:"Breathe in slowly through your nose, then out through your mouth." },
  { key:"stretch", label:"Short stretch", seconds:120, guide:"Stand up and stretch — arms, shoulders, neck, whatever feels tight." },
  { key:"eyes", label:"Close your eyes", seconds:90, guide:"Close your eyes and let your mind rest for a moment." },
];

// Around Me's category grid hits Overpass, whose single public instance is a well-documented
// bottleneck (see api/places.js) — re-fetching the same category at the same spot every time it's
// tapped (switching tabs and back, re-opening a category after backing out) wastes a request
// against that shared resource for data that hasn't had time to change. A short-lived, in-memory
// cache is enough: it survives switching screens within the session but not a reload, and expires
// on its own so a long-running session still eventually sees new/changed places. Module-level
// (like LP above) rather than component state, since it should outlive this component's re-renders
// but doesn't need to persist beyond the tab being open.
const PLACES_CACHE_TTL_MS = 5 * 60 * 1000;
const placesCache = new Map();

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
  // Keeps the phone's status bar / browser bar the same colour as the app in light and dark mode.
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", (theme === "dark" ? DARK : LIGHT).bg);
  }, [theme]);
  // Which Profile screen is open and which of its rows is expanded. Held here rather than inside
  // ProfileSection because a theme change remounts everything under key={themeTick} — switching
  // to dark mode from Profile → General used to throw you back to the Profile hub. Reset when
  // leaving the Profile tab, so coming back starts at the hub as before.
  const [profileNav, setProfileNav] = useState({ screen:null, openRow:null });

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
  // Measured from when the page started loading, not from this component's mount: index.html
  // already shows the same splash while the script downloads, so on a slow connection the
  // minimum has usually passed by the time the app is running.
  const splashStart = useRef(typeof performance !== "undefined" && performance.timeOrigin ? performance.timeOrigin : Date.now());
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

  // Wellness data/pattern access for KROFT Chat — gates the WELLNESS section of krofSysPrompt
  // (see there). Off means the AI never sees mood/sleep/journal/pattern data at all, even if
  // asked about it directly; the Wellness tab itself still works either way, since this only
  // controls what leaves the Wellness feature into the AI's context.
  const [wellnessAiContext, setWellnessAiContext] = useState(true);

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
  // Voice Mode-specific preferences. Subtitles gates the live transcript/reply captions shown
  // during a conversation (off = audio-only, for anyone who finds the captions distracting).
  // Background voice mode lets closing the full-screen conversation minimize it to a small
  // floating bar instead of ending the call, so the person can keep talking to KROFT while
  // using the rest of the app — see voiceMinimized below.
  const [voiceSubtitles, setVoiceSubtitles] = useState(true);
  const [voiceBackgroundMode, setVoiceBackgroundMode] = useState(false);

  // A brand-new visitor sees the Welcome screen (image) first. With Supabase configured, the
  // load effect below jumps straight to the dashboard when a real session already exists (a
  // returning, still-signed-in user), the same way any app with real sessions keeps you signed
  // in across a reload. Without Supabase configured (local-only mode), it instead switches to
  // login once a saved local account is found, matching this app's original device-local
  // behavior — so a returning user never actually sees Welcome flash past.
  const [step, setStep] = useState("welcome");
  // True only while "business" or "prefs" is showing because Profile's Edit Details /
  // Preferences opened it on an already-signed-in account — as opposed to the same two screens
  // showing as part of first-time onboarding, reached by signing up. Both cases render the same
  // step and the same form, but they need different Back/Save destinations: onboarding chains
  // photo -> business -> prefs -> done -> dashboard, while an edit from Profile should return
  // straight to the dashboard, never forward into onboarding's later screens or back through
  // "photo" into "signup" — landing back on the signup screen while editing your own account
  // details was exactly the bug this flag exists to prevent.
  const [editingFromProfile, setEditingFromProfile] = useState(false);
  // Business/Preferences are the two onboarding steps also reused for editing from Profile (see
  // the comment above). Fresh account creation always uses the LIGHT palette regardless of the
  // app's current theme (see the `pal` prop on AuthScreen and friends); editing from Profile
  // keeps respecting whatever theme the user has actually chosen, since that happens once they're
  // already using the themed app.
  const obLight = !editingFromProfile;
  const obc = obLight ? LIGHT : C;
  // True while a signup/login request to Supabase Auth is in flight, so the button can show a
  // spinner and can't be double-submitted by an impatient extra click.
  const [authLoading, setAuthLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  // Phone sign-in runs as one "phone" step in three stages: enter the number, enter the texted
  // code, then (new accounts only) say what KROFT should call you.
  const [phoneStage, setPhoneStage] = useState("number");
  const [phoneInput, setPhoneInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [phoneLoading, setPhoneLoading] = useState(false);
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
  const [tab, setTab] = useState("home");
  const prevTab = useRef(tab);
  useEffect(() => {
    if (prevTab.current === "profile" && tab !== "profile") setProfileNav({ screen:null, openRow:null });
    prevTab.current = tab;
  }, [tab]);
  const [homeSection, setHomeSection] = useState("overview");
  const [workspaceSection, setWorkspaceSection] = useState(null); // null = hub screen
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [incomeCats, setIncomeCats] = useState(["Invoice","Sales","Consulting","Freelance","Other"]);
  // Invoices live with the rest of the finance data (see src/invoices/model.js).
  const [invoices, setInvoices] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [invoiceSettings, setInvoiceSettings] = useState(DEFAULT_INVOICE_SETTINGS);
  const [showInvoices, setShowInvoices] = useState(false);
  const [expenseCats, setExpenseCats] = useState(["Operations","Tech","Marketing","Travel","Rent","Other"]);
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
  // Entry History: a single combined, reverse-chronological feed of every income and expense
  // entry — the inline Transactions section below already lists everything, but as two separate
  // per-type cards, each independently sorted, so there's nowhere that shows "what did I log on
  // this date" across both at once.
  const [showEntryHistory, setShowEntryHistory] = useState(false);
  const [entryHistoryQuery, setEntryHistoryQuery] = useState("");
  // "+N more" used to be static text with nothing to tap — these expand the rest of their list in
  // place instead of leaving the data with nowhere to go.
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [showAllUnbudgeted, setShowAllUnbudgeted] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [monthlyReport, setMonthlyReport] = useState(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [weeklyRecap, setWeeklyRecap] = useState(null);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null); // { kind:"income"|"expenses", id, label, amount, date, cat }
  const [remindersFired, setRemindersFired] = useState({ date:"", slots:[] }); // tracks which of today's 3 nudges already fired
  // Previously seeded with three fabricated emails (a fake "investor", a fake "client", a fake
  // Notion digest) shown to every user regardless of whether they'd actually connected an
  // account — contradicting the "No email connected" state right next to them. An empty inbox
  // until a real Gmail/Outlook account is connected (or a real reply arrives, see the simulated-
  // reply comment on ComposeModal's onSend below) is the honest starting state, same as every
  // other list in this app.
  const [emails, setEmails] = useState([]);
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
  // Mirrors smartReminders for code that needs the CURRENT list from inside a long-lived timeout
  // (snoozeReminderAlarm's 10-minute re-ring) — reading the state variable there would close over
  // whatever it was at snooze time, missing a done/delete that happened in between.
  const smartRemindersRef = useRef([]);
  useEffect(() => { smartRemindersRef.current = smartReminders; }, [smartReminders]);
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
  // A small floating "Copy" menu anchored at the press point, for your own chat messages
  // specifically — everywhere else long-press opens the shared bottom ActionSheet, but a chat
  // bubble's only long-press action is Copy, so a compact popup right where you pressed (like
  // ChatGPT's own message menu) reads better than a full-width sheet for a single option.
  const [copyPopup, setCopyPopup] = useState(null);
  // Index of the person's own message being edited in place, or null.
  const [editingMsg, setEditingMsg] = useState(null);
  // Which long user messages (by id) are expanded past the truncated preview — see
  // USER_MSG_TRUNCATE_LEN's own comment below for why only user bubbles ever truncate.
  const [expandedUserMsgs, setExpandedUserMsgs] = useState(() => new Set());

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
  // One entry per day the rollover effect has processed, mirroring wellnessHistory — lets the
  // Pattern Engine look at actual break/water counts over time instead of only today's live tally.
  const [selfCareHistory, setSelfCareHistory] = useState([]);
  // Wellness signals below are all manual check-ins today. HealthKit/Health Connect could one day
  // populate sleepLog automatically (there's no browser API for either — this only runs as a web
  // app), but the shape (one entry per check-in, capped array, restored/saved like moodLog) is
  // deliberately identical either way, so a future native auto-collector can just push into the
  // same array without any of this code changing.
  const [sleepLog, setSleepLog] = useState([]); // {id, date, time, hours, bedtime, wakeTime, quality}
  const [journalEntries, setJournalEntries] = useState([]); // {id, date, time, text}
  const [quickResetLog, setQuickResetLog] = useState([]); // {id, date, time, kind, seconds}
  // The in-progress guided countdown, or null when no Quick Reset session is running. Deliberately
  // separate from quickResetLog (which only ever gets a row once a session actually finishes) —
  // closing out early logs nothing, matching how the spec frames these as optional resets, not
  // tasks to complete.
  const [activeReset, setActiveReset] = useState(null); // { key, label, seconds, total, guide }
  // "Your Patterns" view state — which time range is selected and which pattern's detail view (if
  // any) is open. Neither needs persisting: it's just what the user is currently looking at, not
  // data.
  const [patternRange, setPatternRange] = useState(30);
  const [patternDetail, setPatternDetail] = useState(null);
  // Which of the Wellness tab's pull-out rows (Your Patterns/Quick Reset/Sleep/Journal) is
  // expanded — same single-row accordion as ProfileRow/openRow in ProfileSection, so
  // five feature sections collapse into a handful of compact rows instead of five full cards.
  const [openWellnessRow, setOpenWellnessRow] = useState(null);
  const [journalDraft, setJournalDraft] = useState("");
  const [sleepForm, setSleepForm] = useState({ hours:"", bedtime:"", wakeTime:"", quality:"" });
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
  // Set when a search result is opened: which message to scroll to. flashMsg briefly highlights it.
  const [chatJump, setChatJump] = useState(null);
  const [flashMsg, setFlashMsg] = useState(null);
  const [aiInput, setAiInput] = useState("");
  const [aiInputFocused, setAiInputFocused] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  // Pending attachments for the message currently being composed — cleared once it's sent.
  // { id, kind:"image"|"file", name, type, size, dataUrl }. Images are genuinely sent to the AI
  // as real inline image data (see runKroftCompletion below and api/_lib/gemini.js) — KROFT can
  // actually see them. A non-image file isn't parsed or read; only its name goes to the model,
  // same honesty as everywhere else in this app that doesn't pretend to a capability it lacks.
  const [aiAttachments, setAiAttachments] = useState([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const aiPhotoInputRef = useRef(null);
  const aiFileInputRef = useRef(null);
  const aiCameraInputRef = useRef(null);
  const aiReceiptInputRef = useRef(null);
  // Drives the floating "scroll to bottom" button — shown only once someone has actually
  // scrolled up to re-read earlier messages, not on every render.
  const [chatNearBottom, setChatNearBottom] = useState(true);
  const aiInputRef = useRef(null);
  // Lets a long reply be cut off mid-stream. Held in a ref so the Stop button can reach the
  // controller for whichever request is currently in flight without re-rendering on every token.
  const aiAbortRef = useRef(null);
  const chatEnd = useRef(null);
  const recRef = useRef(null);
  // Set right before calling recRef.current.stop() from the recording bar's Send button — the
  // final transcript only arrives asynchronously via onresult, so this tells that handler "once
  // you have the text, send it" instead of just dropping it into the input box to review.
  const sendAfterStopRef = useRef(false);
  // Real recognizers don't reliably deliver a final (isFinal) result before onend — stop()/
  // abort() can end a session with only interim results ever having arrived, especially when
  // Stop/Send is tapped right as someone finishes speaking. These back onresult's own commit
  // with a fallback in onend, so what was actually heard never just vanishes silently.
  const lastTranscriptRef = useRef("");
  const committedRef = useRef(false);
  const cancelledRef = useRef(false);
  // A separate recognizer/ref pair for the Wellness Journal's "speak an entry" button — toggleListen
  // above is hardcoded to always hand its transcript to the AI chat input and jump to that tab
  // (setAiInput/setTab("nova")), which is exactly wrong here: journal dictation needs to land in
  // journalDraft and stay on the Wellness tab. Same SpeechRecognition usage, different destination.
  const journalRecRef = useRef(null);
  const [journalListening, setJournalListening] = useState(false);

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
  // freshChat: this load follows a sign-in, so the conversation left open last time is filed into
  // Chat history and a new chat starts, the way opening ChatGPT does. The same happens when the
  // app is reopened after CHAT_IDLE_RESET_MS without any chat activity.
  const hydrateAllGroups = async ({ freshChat = false } = {}) => {
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
      if (typeof p.wellnessAiContext === "boolean") setWellnessAiContext(p.wellnessAiContext);
      // resolveVoiceId maps a pre-persona save (the old female-1/male-2/etc. slot keys) forward
      // to its nearest new persona, so a returning user's saved choice never silently resets.
      if (typeof p.voicePref === "string") setVoicePref(resolveVoiceId(p.voicePref));
      if (typeof p.voiceSpeed === "number") setVoiceSpeed(p.voiceSpeed);
      if (typeof p.voiceSubtitles === "boolean") setVoiceSubtitles(p.voiceSubtitles);
      if (typeof p.voiceBackgroundMode === "boolean") setVoiceBackgroundMode(p.voiceBackgroundMode);
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
    if (data.finance) { setIncome(data.finance.income||[]); setExpenses(data.finance.expenses||[]); setBudgets(data.finance.budgets||{}); setBudgetAlerts(data.finance.budgetAlerts||{}); setBudgetCarryover(data.finance.budgetCarryover||{}); if (data.finance.budgetRolloverMonth) setBudgetRolloverMonth(data.finance.budgetRolloverMonth); setInvoices(data.finance.invoices||[]); setQuotes(data.finance.quotes||[]); setInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS, ...(data.finance.invoiceSettings||{}) }); }
    if (data.productivity) {
      // Normalizes any task saved with a priority outside the app's real set (Urgent/High/
      // Normal/Low) back to Normal — Ask Kroft used to default to a nonexistent "Medium" here,
      // which the Add/Edit Task dropdown can't render as a selected option.
      const validPriority = new Set(["Urgent","High","Normal","Low"]);
      setTasks((data.productivity.tasks||[]).map(t => validPriority.has(t.priority) ? t : { ...t, priority:"Normal" }));
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
      if (Array.isArray(w.selfCareHistory)) setSelfCareHistory(w.selfCareHistory);
      if (Array.isArray(w.sleepLog)) setSleepLog(w.sleepLog.map(e => e.id ? e : { ...e, id:uid() }));
      if (Array.isArray(w.journalEntries)) setJournalEntries(w.journalEntries.map(e => e.id ? e : { ...e, id:uid() }));
      if (Array.isArray(w.quickResetLog)) setQuickResetLog(w.quickResetLog.map(e => e.id ? e : { ...e, id:uid() }));
    }
    // Read/unread and deletions were lost on every reload — the inbox silently reset to
    // all-unread, so marking things read never stuck.
    if (data.emailData && Array.isArray(data.emailData.emails)) setEmails(data.emailData.emails);
    if (data.chatData) {
      const messages = (data.chatData.aiMessages||[]).map(({ streaming, ...m }) => m);
      let history = Array.isArray(data.chatData.history)
        ? data.chatData.history.map(c => ({ ...c, messages:(c.messages||[]).map(({ streaming, ...m }) => m) }))
        : [];
      const lastActiveAt = data.chatData.lastActiveAt || 0;
      const idle = Date.now() - lastActiveAt > CHAT_IDLE_RESET_MS;
      if ((freshChat || idle) && messages.some(m => m.role === "user")) {
        history = [{ id:uid(), title:deriveChatTitle(messages), messages, updatedAt:lastActiveAt || Date.now() }, ...history].slice(0, 30);
        setAiMessages([]);
      } else {
        setAiMessages(messages);
      }
      setChatHistory(history);
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
      let returnedFromGoogle = false;
      let authUser = null;
      if (isSupabaseConfigured) {
        // Coming back from Google sign-in: Supabase puts the new session's tokens (or an error,
        // e.g. if they backed out) in the URL hash. detectSessionInUrl is off in
        // supabaseClient.js, so establish the session by hand — same approach as the
        // password-reset link below, which carries type=recovery and is left to that handler.
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const query = new URLSearchParams(window.location.search);
        const oauthError = hash.get("error_description") || query.get("error_description");
        if (oauthError) {
          window.history.replaceState({}, "", window.location.pathname);
          toast(/denied|cancel/i.test(oauthError) ? "Google sign-in was cancelled." : "Google sign-in didn't work. Try again.");
        } else if (hash.get("access_token") && hash.get("refresh_token") && hash.get("type") !== "recovery") {
          const { error } = await supabase.auth.setSession({ access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token") });
          window.history.replaceState({}, "", window.location.pathname + window.location.search);
          if (error) toast("That sign-in link has expired. Try again.");
          else returnedFromGoogle = true;
        }
        const { data: { session } = {} } = await supabase.auth.getSession();
        // Offline with an expired token Supabase can't refresh the session, but this is still the
        // person last signed in on this device: open their saved copy rather than the welcome screen.
        hasSession = !!session || !!offlineUserId();
        authUser = session?.user || null;
      }
      const data = await hydrateAllGroups({ freshChat:returnedFromGoogle });
      if (cancelled) return;
      if (returnedFromGoogle) {
        routeAfterExternalSignIn(data, authUser);
      } else if (hasSession) {
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
  const saveProfileNow = () => window.storage.set(STORAGE_KEYS.profile, JSON.stringify({ user, theme, voiceReplies, proactiveInsights, wellnessAiContext, voicePref, voiceSpeed, voiceSubtitles, voiceBackgroundMode, incomeCats, expenseCats, notifPrefs, dailyBriefSentDate, voiceTurnsCount, voiceTurnsDate, taxSetAsidePct }), false);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { saveProfileNow().catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, user, theme, voiceReplies, proactiveInsights, wellnessAiContext, voicePref, voiceSpeed, voiceSubtitles, voiceBackgroundMode, incomeCats, expenseCats, notifPrefs, dailyBriefSentDate, voiceTurnsCount, voiceTurnsDate, taxSetAsidePct]);

  useEffect(() => {
    if (!dataLoaded) return;
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.finance, JSON.stringify({ income, expenses, budgets, budgetAlerts, budgetCarryover, budgetRolloverMonth, invoices, quotes, invoiceSettings }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, income, expenses, budgets, budgetAlerts, budgetCarryover, budgetRolloverMonth, invoices, quotes, invoiceSettings]);

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
      lastActiveAt: Date.now(),
    }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, aiMessages, chatHistory]);

  useEffect(() => {
    if (!dataLoaded) return;
    // Mood entries are capped so the log can't grow without bound; 120 covers a couple of months
    // of normal use.
    const t = setTimeout(() => { window.storage.set(STORAGE_KEYS.wellnessData, JSON.stringify({
      wellness, wellnessDate, wellnessHistory: wellnessHistory.slice(-90), selfCare, mood, moodLog: moodLog.slice(-120),
      selfCareHistory: selfCareHistory.slice(-90),
      sleepLog: sleepLog.slice(-120),
      journalEntries: journalEntries.slice(-200), quickResetLog: quickResetLog.slice(-180),
    }), false).catch(()=>{}); }, 900);
    return () => clearTimeout(t);
  }, [dataLoaded, wellness, wellnessDate, wellnessHistory, selfCare, mood, moodLog, selfCareHistory, sleepLog, journalEntries, quickResetLog]);

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
      return { ym: ymdLocal(d).slice(0,7), label: d.toLocaleDateString("en-US", { month:"short" }) };
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

  // Every income and expense entry ever logged, combined into one reverse-chronological feed for
  // Entry History — same merge shape exportFinanceCsv already uses, just newest first instead of
  // oldest first, since a review view leads with what was just added.
  const allEntries = useMemo(() => (
    [...income.map(r => ({ ...r, kind:"income" })), ...expenses.map(r => ({ ...r, kind:"expenses" }))]
      .sort((a,b) => (b.date||"").localeCompare(a.date||""))
  ), [income, expenses]);

  // Every future occurrence (not just each template's single next one) of every recurring income
  // or expense due in the next 30 days, simulated forward from nextDate without actually posting
  // anything — the posting engine only ever tracks one occurrence ahead per template, which isn't
  // enough to forecast a weekly bill 4 times over.
  const upcomingCashFlow = useMemo(() => {
    const today = todayISO();
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 30);
    const horizonISO = ymdLocal(horizon);
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
    // Steps the "YYYY-MM-DD" label back one calendar day at a time. Parsing it as UTC midnight and
    // stepping with setUTCDate keeps the arithmetic purely on the label — local-time stepping
    // would be thrown off by DST transitions, which aren't 24 hours long.
    const cursor = new Date(today + "T00:00:00Z");
    if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (days.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return streak;
  }, [moodLog]);

  // ---- Pattern Engine -------------------------------------------------------------------------
  // Turns whichever real wellness signals the user actually has into "Your Patterns" insights.
  // Deliberately generic rather than a list of hardcoded sentences: every signal is normalized to
  // one numeric "how good was this day" value per day (see wellnessDayMaps below), then every
  // configured predictor/outcome PAIR is tested the same way — split the days into two buckets by
  // the predictor, compare the outcome's average between buckets, and only surface it if there's
  // both enough data and a real enough difference to say something. A signal nobody has logged
  // (e.g. no sleepLog entries) simply produces an empty map, so every pair that needs it drops out
  // on its own — no special-casing, and nothing is ever invented to fill a gap. Adding a future
  // signal (e.g. real HealthKit sleep or step data) means adding one entry to wellnessDayMaps and
  // WELLNESS_METRIC_META and any PATTERN_PAIRS it belongs in — this loop and the UI that reads its
  // output never need to change. See krofSysPrompt's WELLNESS section for the AI-facing consumer.
  const moodToScore = m => MOOD_META[m]?.score ?? null;

  const wellnessDayMaps = useMemo(() => {
    const maps = { mood:new Map(), sleep:new Map(), wellness:new Map(), breaks:new Map(), water:new Map(), quickReset:new Map() };
    const moodByDay = {};
    moodLog.forEach(m => { const s = moodToScore(m.mood); if (s==null || !m.date) return; (moodByDay[m.date] ||= []).push(s); });
    Object.entries(moodByDay).forEach(([d,arr]) => maps.mood.set(d, arr.reduce((a,b)=>a+b,0)/arr.length));

    sleepLog.forEach(e => { if (typeof e.hours === "number" && !Number.isNaN(e.hours) && e.date) maps.sleep.set(e.date, e.hours); });

    const today = todayISO();
    wellnessHistory.forEach(h => { if (h.date) maps.wellness.set(h.date, h.score); });
    maps.wellness.set(today, wellness);

    selfCareHistory.forEach(h => { if (!h.date) return; maps.breaks.set(h.date, h.breaks||0); maps.water.set(h.date, h.water||0); });
    maps.breaks.set(today, selfCare.breaks);
    maps.water.set(today, selfCare.water);

    const qrByDay = {};
    quickResetLog.forEach(q => { if (q.date) qrByDay[q.date] = (qrByDay[q.date]||0) + 1; });
    Object.entries(qrByDay).forEach(([d,c]) => maps.quickReset.set(d, c));

    return maps;
  }, [moodLog, sleepLog, wellnessHistory, wellness, selfCareHistory, selfCare, quickResetLog]);

  // groupDesc.true/false describe "days where [condition]" in plain language, for whichever side
  // of the split turns out to hold the higher average. effect is the smallest difference in this
  // metric's own units worth mentioning as a pattern — below it, a "difference" is more likely
  // noise than a real pattern, so nothing is surfaced.
  const WELLNESS_METRIC_META = {
    mood: { label:"mood", isGood:v=>v>=3, effect:0.5, groupDesc:{ true:"you report a more positive mood", false:"your mood is lower" } },
    sleep: { label:"sleep", isGood:v=>v>=7, effect:0.75, groupDesc:{ true:"you sleep 7 or more hours", false:"you sleep less than 7 hours" } },
    wellness: { label:"wellness score", isGood:v=>v>=70, effect:6, groupDesc:{ true:"your wellness score is higher", false:"your wellness score is lower" } },
    breaks: { label:"breaks taken", isGood:v=>v>=1, effect:0.5, groupDesc:{ true:"you log at least one break", false:"you don't log a break" } },
    water: { label:"water intake", isGood:v=>v>=3, effect:0.5, groupDesc:{ true:"you log 3 or more glasses of water", false:"you log fewer than 3 glasses of water" } },
    quickReset: { label:"Quick Reset use", isGood:v=>v>=1, effect:0.4, groupDesc:{ true:"you complete a Quick Reset session", false:"you don't do a Quick Reset" } },
  };
  // Curated predictor->outcome pairs worth asking about at all — not every combination of signals
  // implies a sensible real-world question, so this is a fixed list rather than every permutation.
  const PATTERN_PAIRS = [
    ["sleep","mood"], ["sleep","wellness"],
    ["mood","wellness"],
    ["breaks","wellness"],
    ["water","wellness"], ["water","mood"],
    ["quickReset","wellness"],
  ];
  // A pattern needs at least this many days on EACH side of the split, and this many total paired
  // observations, before it's treated as more than a coincidence. Both thresholds are intentionally
  // low (this is personal, sparse, self-reported data, not a clinical study) but non-zero — the
  // spec's own bar is "don't fabricate," not "wait for a large sample."
  const PATTERN_MIN_GROUP = 3;
  const PATTERN_MIN_TOTAL = 6;

  const wellnessPatterns = useMemo(() => {
    const today = todayISO();
    const cutoff = new Date(today + "T00:00:00Z");
    cutoff.setUTCDate(cutoff.getUTCDate() - (patternRange - 1));
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    const inRange = date => date >= cutoffISO && date <= today;

    const results = [];
    PATTERN_PAIRS.forEach(([predKey, outKey]) => {
      const predMap = wellnessDayMaps[predKey], outMap = wellnessDayMaps[outKey];
      const predMeta = WELLNESS_METRIC_META[predKey], outMeta = WELLNESS_METRIC_META[outKey];
      const groupTrue = [], groupFalse = [];
      predMap.forEach((pVal, date) => {
        if (!inRange(date) || !outMap.has(date)) return;
        (predMeta.isGood(pVal) ? groupTrue : groupFalse).push(outMap.get(date));
      });
      const total = groupTrue.length + groupFalse.length;
      if (groupTrue.length < PATTERN_MIN_GROUP || groupFalse.length < PATTERN_MIN_GROUP || total < PATTERN_MIN_TOTAL) return;
      const avgTrue = groupTrue.reduce((a,b)=>a+b,0) / groupTrue.length;
      const avgFalse = groupFalse.reduce((a,b)=>a+b,0) / groupFalse.length;
      const diff = avgTrue - avgFalse;
      if (Math.abs(diff) < outMeta.effect) return;
      const higher = diff > 0;
      results.push({
        id: `${predKey}_${outKey}`,
        insight: `Your ${outMeta.label} tends to be ${higher ? "higher" : "lower"} on days ${predMeta.groupDesc.true}.`,
        predictorLabel: predMeta.label, outcomeLabel: outMeta.label,
        period: patternRange, observations: total,
        groups: [
          { label: `Days ${predMeta.groupDesc.true}`, n: groupTrue.length, avg: avgTrue },
          { label: `Days ${predMeta.groupDesc.false}`, n: groupFalse.length, avg: avgFalse },
        ],
        explanation: `Based on ${total} days in the last ${patternRange} where both ${predMeta.label} and ${outMeta.label} were recorded, days ${predMeta.groupDesc.true} averaged ${avgTrue.toFixed(1)} for ${outMeta.label} versus ${avgFalse.toFixed(1)} on days ${predMeta.groupDesc.false}.`,
      });
    });
    // Most-observed pattern first — the one backed by the most data is the one most worth leading
    // with, not an arbitrary/config-order list.
    return results.sort((a,b) => b.observations - a.observations);
  }, [wellnessDayMaps, patternRange]);

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
      cells.push({ date: ymdLocal(d), day: d.getDate(), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ date: `${calendarMonth}-${String(d).padStart(2,"0")}`, day: d, inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const last = new Date(cells[cells.length-1].date + "T00:00:00");
      last.setDate(last.getDate() + 1);
      cells.push({ date: ymdLocal(last), day: last.getDate(), inMonth: false });
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
  // A one-off (non-repeating) appointment is never removed once its date passes — see the
  // recurring-only roll-forward effect above — so "the next appointment" has to actually mean
  // the earliest one today or later, not just index 0 of an array that's otherwise only ever
  // appended to.
  const upcomingAppts = useMemo(() => sortAppts(appts.filter(a => a.date >= todayISO())), [appts]);
  const todaysAppts = useMemo(() => sortAppts(appts.filter(a => a.date === todayISO())), [appts]);

  // Forces a re-render on the app's shared 30s heartbeat, purely so the Next appointment card's
  // live status line (Starts in.../In progress/Ended...) keeps ticking on its own — nothing else
  // about this state is ever read. Piggybacks on the existing shared timer (see heartbeat's own
  // comment) rather than adding a dedicated interval just for this one card.
  const [, forceApptTick] = useState(0);
  useEffect(() => heartbeat(() => forceApptTick(t => t+1)), []);

  const pw = signupPw;
  const pwChecks = { length:pw.length>=8, upper:/[A-Z]/.test(pw), lower:/[a-z]/.test(pw), number:/[0-9]/.test(pw), special:/[^A-Za-z0-9]/.test(pw) };
  const pwScore = Object.values(pwChecks).filter(Boolean).length;
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
  // Whether to keep following new text is decided by where the person left the scroll (updated
  // in the list's onScroll), not re-measured after the content grows: a reply can grow by a whole
  // table or card at once, which would otherwise look like "scrolled up" and stop the follow.
  // Sending a message always jumps back to the bottom.
  const chatStickToBottom = useRef(true);
  useEffect(() => {
    const box = chatScrollRef.current;
    if (!box) { chatEnd.current?.scrollIntoView({ behavior:"smooth" }); return; }
    if (aiMessages[aiMessages.length - 1]?.role === "user") chatStickToBottom.current = true;
    if (!chatStickToBottom.current) return;
    // "auto" rather than "smooth": at streaming speed, queued smooth animations stutter.
    const streaming = aiMessages.some(m => m.streaming);
    chatEnd.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" });
  }, [aiMessages]);
  // Runs after the auto-scroll above so the jump wins over "scroll to the newest message".
  useEffect(() => {
    if (!chatJump) return;
    let clear;
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-msg-idx="${chatJump.idx}"]`);
      el?.scrollIntoView({ behavior:"smooth", block:"center" });
      setFlashMsg(chatJump.idx);
      clear = setTimeout(() => setFlashMsg(null), 2200);
    }, 160);
    return () => { clearTimeout(t); clearTimeout(clear); };
  }, [chatJump]);
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
      setAiMessages(p => p.length > 0 ? p : [{ role:"assistant", content:`Hey ${firstNameOf(user.name)||"there"} — I'm KROFT, your personal AI assistant by Orynthra. Ask me anything — finances, schedule, general knowledge, advice, or just chat. I'm here for all of it.` }]);
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

  // Lets speak() (a plain module-level function — see its own comment) surface a toast when an
  // utterance silently never plays, instead of failing with no visible sign anything went wrong.
  useEffect(() => { setTtsFailureNotifier(toast); return () => setTtsFailureNotifier(null); }, [toast]);

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
          const date = advanceRepeatDateTo(a.date, a.repeat, today);
          // advanceRepeatDateTo bails out unchanged when it can't make progress (a corrupted
          // repeat cadence or an unparseable date) — only counting a REAL change here stops that
          // case from marking the whole list changed on every single heartbeat forever, which
          // would otherwise re-save to storage and re-schedule push notifications every ~30s for
          // as long as that one row exists and the tab stays open.
          if (date === a.date) return a;
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

  // Sleep is a manual entry today (see the sleepLog state comment) — one entry per night, keyed by
  // the date it's logged for rather than "today" specifically, since people often log last night's
  // sleep the next morning.
  const logSleep = ({ hours, bedtime, wakeTime, quality }) => {
    haptic(8);
    const today = todayISO();
    setSleepLog(p => [...p.filter(e => e.date !== today), { id:uid(), date:today, time:timeStr(), hours, bedtime, wakeTime, quality: quality || null }]);
    toast(`Sleep logged: ${hours}h`);
  };

  const addJournalEntry = text => {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    haptic(8);
    setJournalEntries(p => [...p, { id:uid(), date:todayISO(), time:timeStr(), text: trimmed }]);
    toast("Journal entry saved.");
  };

  const deleteJournalEntry = id => setJournalEntries(p => p.filter(e => e.id !== id));

  const logQuickReset = (kind, seconds) => {
    haptic([10,20,10]);
    setQuickResetLog(p => [...p, { id:uid(), date:todayISO(), time:timeStr(), kind, seconds }]);
    setWellness(s => Math.min(100, s + 2));
    toast("Nice reset. Wellness score up.");
  };

  const startQuickReset = kindKey => {
    const cfg = QUICK_RESET_KINDS.find(k => k.key === kindKey);
    if (!cfg) return;
    haptic(8);
    setActiveReset({ key: cfg.key, label: cfg.label, guide: cfg.guide, seconds: cfg.seconds, total: cfg.seconds });
  };
  const cancelQuickReset = () => setActiveReset(null);

  // Ticks the active Quick Reset countdown once a second, same setInterval-in-an-effect shape as
  // the login lockout timer above — a dedicated 1s timer rather than the shared 30s heartbeat,
  // since this needs to visibly count down while its screen is open, not just wake periodically.
  useEffect(() => {
    if (!activeReset || activeReset.seconds <= 0) return;
    const iv = setInterval(() => {
      setActiveReset(prev => {
        if (!prev) return prev;
        if (prev.seconds <= 1) {
          logQuickReset(prev.key, prev.total);
          return null;
        }
        return { ...prev, seconds: prev.seconds - 1 };
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [activeReset]);

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
      const data = await hydrateAllGroups({ freshChat:true });
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
    // Data was already loaded when the app opened, so start the new chat here rather than in
    // hydrateAllGroups.
    fileOpenChat();
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
    await hydrateAllGroups({ freshChat:true });
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
    if (isNativeApp) {
      if (!nativeBioOn) { toast("Set up biometric unlock in Profile first."); return; }
    } else {
      if (!user.webauthnCredentialId) { toast("Set up biometric unlock in Profile first."); return; }
      if (!window.PublicKeyCredential) { toast("Biometrics not supported on this device."); return; }
    }
    setFpLoading(true);
    try {
      if (isNativeApp) {
        // Android's own fingerprint / face prompt (WebAuthn doesn't exist in the app's WebView).
        const r = await verifyBiometric("Log in to KROFT");
        if (!r.ok) throw new Error(r.reason);
      } else {
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
      }
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
      await hydrateAllGroups({ freshChat:true });
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
  // In the Android app the setting is kept on the phone only (it unlocks this phone, and user is
  // synced to every device the account signs in on).
  // The stored value is the account id it was turned on for, so a different account signing in
  // on the same phone never inherits it.
  const [nativeBioOn, setNativeBioOn] = useState(() => isNativeApp && !!readNativeBio());
  const biometricOn = isNativeApp ? nativeBioOn : !!user.webauthnCredentialId;

  // Covers the app from the very first render when the lock is on, so nothing shows before the
  // check; lifted straight away if there's no signed-in account (or a different one) to protect.
  const [appLocked, setAppLocked] = useState(() => isNativeApp && !!readNativeBio());
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => {
    if (!isNativeApp || !readNativeBio()) return;
    (async () => {
      if (!isSupabaseConfigured) return;
      const { data: { session } = {} } = await supabase.auth.getSession();
      const owner = readNativeBio();
      if (!session) { setAppLocked(false); return; }
      if (owner !== "local" && owner !== "1" && owner !== session.user.id) { writeNativeBio(null); setNativeBioOn(false); setAppLocked(false); return; }
      if (owner === "1") writeNativeBio(session.user.id); // turned on by the first app build
    })().catch(() => {});
  }, []);
  const hiddenAtRef = useRef(0);
  useEffect(() => {
    if (!isNativeApp) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") { hiddenAtRef.current = Date.now(); return; }
      if (readNativeBio() && hiddenAtRef.current && Date.now() - hiddenAtRef.current > APP_LOCK_AFTER_MS) setAppLocked(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const unlockApp = async () => {
    if (unlocking) return;
    setUnlocking(true);
    const r = await verifyBiometric("Unlock KROFT");
    setUnlocking(false);
    if (r.ok) { setAppLocked(false); return; }
    // An older copy of the app without the fingerprint plugin can't check it; the account's
    // password still protects it, so don't keep the person out.
    if (r.reason === "needs-update") { setAppLocked(false); return; }
    // The sensor is gone or every fingerprint was removed: don't trap the person behind a lock
    // they can no longer open. Their password still protects the account.
    if (r.reason === "unsupported" || r.reason === "not-enrolled") {
      writeNativeBio(null); setNativeBioOn(false); setAppLocked(false);
      toast("Biometric unlock was turned off because this phone no longer has a fingerprint or face set up.");
    } else if (r.reason === "locked-out") toast("Too many tries. Wait a moment and try again.");
  };
  // Asks straight away when the lock appears, so opening the app is one touch of the sensor.
  useEffect(() => { if (appLocked) { const t = setTimeout(unlockApp, 350); return () => clearTimeout(t); } }, [appLocked]);
  const lockOutAndSignIn = async () => {
    try { await flushPending(); } catch { /* best effort */ }
    if (isSupabaseConfigured) await supabase.auth.signOut().catch(() => {});
    clearOfflineData(); writeNativeBio(null);
    window.location.reload();
  };
  const appLockOverlay = appLocked && (
    <div role="dialog" aria-modal="true" aria-label="KROFT is locked" style={{ position:"fixed", inset:0, zIndex:2000, background:LIGHT.bg, color:LIGHT.text, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, padding:"24px 24px calc(24px + env(safe-area-inset-bottom))", fontFamily:APP_FONT, textAlign:"center" }}>
      <div style={{ fontSize:34, fontWeight:600, letterSpacing:"-0.5px" }}>Kroft</div>
      <div style={{ fontSize:15.5, color:LIGHT.soft, maxWidth:280, lineHeight:1.5 }}>Locked. Use your fingerprint or face to continue.</div>
      <AuthButton style={{ marginTop:12, maxWidth:320, width:"100%" }} loading={unlocking} onClick={unlockApp}>{unlocking ? "Waiting…" : "Unlock"}</AuthButton>
      <AuthButton kind="text" onClick={lockOutAndSignIn}>Log out and use password</AuthButton>
    </div>
  );
  const setupBiometric = async () => {
    if (isNativeApp) {
      const r = await verifyBiometric("Turn on biometric unlock");
      if (r.ok) {
        const { data: { session } = {} } = isSupabaseConfigured ? await supabase.auth.getSession() : { data:{} };
        writeNativeBio(session?.user?.id || "local");
        setNativeBioOn(true);
        toast("Biometric unlock is on. KROFT will ask for it when you open the app.");
      } else if (r.reason === "not-enrolled") toast("Add a fingerprint or face in your phone's Settings → Security first.");
      else if (r.reason === "unsupported") toast("This phone doesn't have a fingerprint or face sensor KROFT can use.");
      else if (r.reason === "needs-update") toast("Update the KROFT app to use fingerprint or face unlock.");
      else if (r.reason === "locked-out") toast("Too many tries. Wait a moment and try again.");
      return;
    }
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
    if (isNativeApp) {
      writeNativeBio(null);
      setNativeBioOn(false);
      toast("Biometric unlock removed for this phone.");
      return;
    }
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
    // Every caller (mail sync, calendar sync, the Google/Microsoft connect and disconnect
    // buttons) routes through Kroft's own serverless functions, which in turn call out to those
    // providers' real APIs — a slow provider response with no timeout here left the calling
    // screen's loading state spinning forever with no error and no way to retry. A timed-out
    // fetch rejects with the same AbortError shape every one of those callers' existing catch
    // blocks already handles, so this needs no changes at any call site.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(path, {
        ...opts,
        signal: controller.signal,
        headers: {
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          "X-Kroft-Client": getClientHeader(),
          ...opts.headers,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  // Same idea as authedFetch, but for api/chat.js specifically: that endpoint only requires
  // sign-in when Supabase is actually configured server-side (see its own comment) and stays
  // open in local-only mode — so unlike authedFetch, this never throws. It attaches a session
  // token opportunistically when one exists, and otherwise sends the request exactly as before.
  const aiFetch = async (path, opts = {}) => {
    const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), "X-Kroft-Client": getClientHeader(), ...opts.headers };
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
  // Connecting leaves the app for Google's/Microsoft's consent page and comes back with a full
  // reload, which loses which screen you were on. A short-lived sessionStorage note (cleared as
  // soon as it's read) brings you back there — Profile → Connected apps — instead of Home. Only
  // a navigation hint, never data, so losing it (private mode, storage blocked) costs nothing.
  const OAUTH_RETURN_KEY = "kroft:oauthReturn";
  const rememberOAuthReturn = returnTo => {
    try { if (returnTo) sessionStorage.setItem(OAUTH_RETURN_KEY, returnTo); else sessionStorage.removeItem(OAUTH_RETURN_KEY); } catch { /* hint only */ }
  };
  // Android app: sign-in, account linking and checkout run in the system browser (see native.js).
  // Closing it without finishing leaves no redirect to reset the loading states, so reset them here.
  useEffect(() => {
    if (!isNativeApp) return;
    const reset = () => { setGoogleLinking(false); setMicrosoftLinking(false); setBillingLoading(false); setGoogleLoading(false); };
    window.addEventListener("kroft:browser-closed", reset);
    return () => window.removeEventListener("kroft:browser-closed", reset);
  }, []);

  const connectGoogle = async (returnTo) => {
    setGoogleLinking(true);
    try {
      // ?app=1 makes the callback return to the Android app instead of the website.
      const res = await authedFetch(`/api/google/start${isNativeApp ? "?app=1" : ""}`);
      if (!res.ok) { toast("Couldn't start Google sign-in. Try again."); setGoogleLinking(false); return; }
      const { url } = await res.json();
      rememberOAuthReturn(returnTo);
      if (!(await openInSystemBrowser(url))) window.location.href = url;
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

  const connectMicrosoft = async (returnTo) => {
    setMicrosoftLinking(true);
    try {
      // ?app=1 makes the callback return to the Android app instead of the website.
      const res = await authedFetch(`/api/microsoft/start${isNativeApp ? "?app=1" : ""}`);
      if (!res.ok) { toast("Couldn't start Microsoft sign-in. Try again."); setMicrosoftLinking(false); return; }
      const { url } = await res.json();
      rememberOAuthReturn(returnTo);
      if (!(await openInSystemBrowser(url))) window.location.href = url;
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
  // both — api/mail/messages.js merges them) and replaces the local `emails` list with it,
  // rather than appending to whatever was there before (which, before an account is connected,
  // is nothing — see the emails useState above).
  // quiet: the automatic pull right after connecting an account, which shouldn't bury the
  // "account connected" message under "Loaded 0 emails", or report a 409 for a scope the person
  // simply chose not to grant. Real failures still show.
  const syncMail = async ({ quiet = false } = {}) => {
    setSyncingMail(true);
    try {
      const res = await authedFetch("/api/mail/messages");
      if (!res.ok) { if (!(quiet && res.status === 409)) toast(res.status===409 ? "No email account is connected." : "Couldn't load your inbox right now."); return; }
      const { messages } = await res.json();
      // A 200 without the expected list (an error page from a gateway, a partial outage) goes
      // to the catch below instead of being stored — an undefined list here would crash the
      // Email screen the next time it renders.
      if (!Array.isArray(messages)) throw new Error("Unexpected inbox response");
      setEmails(messages);
      if (!quiet) toast(`Loaded ${messages.length} email${messages.length===1?"":"s"}.`);
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
  const syncCalendar = async ({ quiet = false } = {}) => {
    setSyncingCalendar(true);
    try {
      const res = await authedFetch("/api/calendar/events");
      if (!res.ok) { if (!(quiet && res.status === 409)) toast(res.status===409 ? "No calendar is connected." : "Couldn't load your calendar right now."); return; }
      const { appts: remoteAppts } = await res.json();
      // Same guard as syncMail's — the spread below runs inside a state updater, outside this
      // try/catch, so a malformed response would otherwise take the whole app down.
      if (!Array.isArray(remoteAppts)) throw new Error("Unexpected calendar response");
      setAppts(p => [...p.filter(a => a.source !== "google" && a.source !== "outlook"), ...remoteAppts]);
      if (!quiet) toast(`Loaded ${remoteAppts.length} event${remoteAppts.length===1?"":"s"}.`);
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
      const res = await authedFetch("/api/billing/checkout", { method: "POST", body: JSON.stringify({ app: isNativeApp }) });
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
      // Full navigation (Flutterwave's checkout page won't render in a fetch response). In the
      // Android app it opens in the system browser and returns through the app's deep link.
      if (await openInSystemBrowser(url)) { setBillingLoading(false); return; }
      window.location.href = url;
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
    let returnTo = null;
    try { returnTo = sessionStorage.getItem(OAUTH_RETURN_KEY); sessionStorage.removeItem(OAUTH_RETURN_KEY); } catch { /* hint only */ }
    if (returnTo === "connected") { setTab("profile"); setProfileNav({ screen:"connected", openRow:null }); }
    if (oauthResult === "success") {
      toast(`${provider} account connected.`);
      refreshGoogleStatus();
      refreshMicrosoftStatus();
      // Best-effort first pull so the newly-connected inbox/calendar aren't still showing
      // stale mock data or an empty list the moment the user lands back on the dashboard —
      // each call is a no-op (a handled 409) if that particular scope wasn't actually granted.
      syncMail({ quiet:true });
      syncCalendar({ quiet:true });
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

  // Which sign-in methods the Supabase project actually has switched on. Google and phone each
  // need setup on the Supabase side (a Google OAuth client; an SMS provider), and starting either
  // one while it's off fails badly — Google lands on a raw JSON error page from Supabase. GoTrue
  // serves this publicly, so it's checked before starting either flow, once per session.
  const authSettingsRef = useRef(null);
  const getAuthSettings = async () => {
    if (authSettingsRef.current) return authSettingsRef.current;
    try {
      const res = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers:{ apikey:supabaseAnonKey } });
      if (!res.ok) return null;
      authSettingsRef.current = await res.json();
      return authSettingsRef.current;
    } catch { return null; }
  };

  // After Google or phone sign-in: a returning account goes straight to its dashboard; a new one
  // (no saved profile yet) gets its name/email/phone filled in from the sign-in and goes through
  // onboarding like an email signup would. Phone sign-in doesn't come with a name, so it asks.
  const routeAfterExternalSignIn = (data, authUser) => {
    const savedName = data?.profile?.user?.name;
    if (savedName) { setStep("dashboard"); toast(`Welcome back, ${firstNameOf(savedName)||"there"}.`); return; }
    const meta = authUser?.user_metadata || {};
    const name = meta.full_name || meta.name || "";
    setUser(u => ({ ...u, name: u.name || name, email: u.email || authUser?.email || "", phone: u.phone || (authUser?.phone ? `+${authUser.phone}` : "") }));
    setEditingFromProfile(false);
    if (name) setStep("photo");
    else { setPhoneStage("name"); setPhoneError(""); setStep("phone"); }
  };

  const signInWithGoogle = async () => {
    if (!isSupabaseConfigured) { toast("Google sign-in isn't available in local-only mode. Use email instead."); return; }
    setGoogleLoading(true);
    const settings = await getAuthSettings();
    if (settings && !settings.external?.google) { setGoogleLoading(false); toast("Google sign-in isn't set up yet. Use your phone number or email for now."); return; }
    // Leaves the app for Google; the return trip (tokens in the URL hash) is picked up by the
    // mount-time effect, since supabaseClient.js has detectSessionInUrl turned off.
    // In the Android app Google refuses to sign in inside the app's WebView, so the Google page
    // opens in the system browser and comes back through the app's deep link (see native.js),
    // which hands the same tokens to this page as the website's own redirect would.
    if (isNativeApp) {
      const { data, error } = await supabase.auth.signInWithOAuth({ provider:"google", options:{ redirectTo: nativeRedirect("auth-callback"), skipBrowserRedirect:true } });
      if (error || !data?.url) { setGoogleLoading(false); toast("Couldn't start Google sign-in. Try again."); return; }
      await openInSystemBrowser(data.url);
      setGoogleLoading(false);
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({ provider:"google", options:{ redirectTo: window.location.origin } });
    if (error) { setGoogleLoading(false); toast("Couldn't start Google sign-in. Try again."); }
  };

  const openPhoneSignIn = () => {
    if (!isSupabaseConfigured) { toast("Phone sign-in isn't available in local-only mode. Use email instead."); return; }
    setPhoneStage("number"); setOtpInput(""); setPhoneError(""); setStep("phone");
  };

  // Keeps digits and a single leading "+", so "+234 801-234 5678" becomes "+2348012345678".
  const normalizePhone = s => { const t = s.trim(); return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, ""); };

  const sendPhoneCode = async () => {
    const phone = normalizePhone(phoneInput);
    if (!/^\+\d{8,15}$/.test(phone)) { setPhoneError("Enter your number with its country code, e.g. +234 801 234 5678."); return; }
    setPhoneLoading(true); setPhoneError("");
    const settings = await getAuthSettings();
    if (settings && !settings.external?.phone) { setPhoneLoading(false); setPhoneError("Phone sign-in isn't set up yet. Use Google or email for now."); return; }
    const { error } = await supabase.auth.signInWithOtp({ phone });
    setPhoneLoading(false);
    if (error) { setPhoneError(error.message || "Couldn't send the code. Try again."); return; }
    if (phoneStage === "code") toast("New code sent.");
    setOtpInput(""); setPhoneStage("code");
  };

  const verifyPhoneCode = async () => {
    const token = otpInput.replace(/\D/g, "");
    if (token.length !== 6) { setPhoneError("Enter the 6-digit code we texted you."); return; }
    setPhoneLoading(true); setPhoneError("");
    const { data, error } = await supabase.auth.verifyOtp({ phone: normalizePhone(phoneInput), token, type:"sms" });
    if (error) { setPhoneLoading(false); setPhoneError(error.message || "That code didn't work. Check it and try again."); return; }
    // The mount-time load ran before anyone was signed in — load this account's data for real.
    const loaded = await hydrateAllGroups({ freshChat:true });
    setPhoneLoading(false);
    routeAfterExternalSignIn(loaded, data.user);
  };

  const finishPhoneName = () => {
    if (!user.name?.trim()) { setPhoneError("Tell KROFT what to call you."); return; }
    setUser(u => ({ ...u, name: u.name.trim() }));
    setPhoneError(""); setStep("photo");
  };

  const doSignup = async () => {
    if (!user.name||!user.email||!signupPw) { setSignupError("Enter your name, email and a password to continue."); return; }
    if (pwScore < 3) { setSignupError("Choose a stronger password. The tips under the password field show what to add."); return; }
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
    closeCamera(); toast("Photo captured.");
  };

  const handleGalleryPick = e => {
    const file = e.target.files[0]; if (!file) return;
    if (!file.type.startsWith("image/")) { toast("Please select an image."); return; }
    const reader = new FileReader();
    reader.onload = ev => { setUser(u => ({...u, photo:ev.target.result})); toast("Photo selected."); };
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

  // Ask KROFT's own attach flow (the "+" in the message bar) — separate from the Files upload
  // above since these are transient (held only until the message sends), never land in the
  // Files list, and need a kind tag (image vs. file) to know how to send them to the AI: an
  // image becomes a real inline image part in the request (see runKroftCompletion); a non-image
  // file is never read, only its name is mentioned in the text sent.
  const handleAiAttach = (e, kind) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!picked.length) return;
    const ok = picked.filter(f => f.size <= MAX_UPLOAD_FILE_BYTES);
    const tooBig = picked.length - ok.length;
    if (tooBig > 0) toast(`${tooBig} file${tooBig!==1?"s":""} skipped — over the 8MB limit.`);
    if (!ok.length) return;
    Promise.all(ok.map(f => new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id:uid(), kind, name:f.name, type:f.type||"application/octet-stream", size:f.size, dataUrl:reader.result });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(f);
    }))).then(results => {
      const added = results.filter(Boolean);
      if (added.length) setAiAttachments(p => [...p, ...added]);
    });
  };
  const removeAiAttachment = id => setAiAttachments(p => p.filter(a => a.id !== id));

  // ── Voice mode ────────────────────────────────────────────────────────────────────────
  // A full turn loop: listen → transcribe → answer → speak → back to listening. The two
  // things that make or break this are echo (the mic hearing KROFT's own voice and treating
  // it as the next question) and barge-in (being able to cut a long answer off), so both are
  // handled explicitly rather than left to the browser.
  const [voiceOpen, setVoiceOpen] = useState(false);
  // True once Background voice mode has minimized an in-progress conversation to the small
  // floating bar — the conversation itself (recognizer, speech) keeps running untouched, since
  // every loop below gates on voiceOpen, never on this.
  const [voiceMinimized, setVoiceMinimized] = useState(false);
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
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
        setVoiceError(`Microphone access is off. ${MIC_PERMISSION_HINT}`);
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

  // With Background voice mode on and a turn actually in progress, the X minimizes to the
  // floating bar instead of hanging up — nothing about the conversation is stopped or reset.
  // Idle has nothing worth preserving, so it always ends the call outright either way.
  const closeVoice = () => {
    if (voiceBackgroundMode && voiceState !== "idle") { setVoiceMinimized(true); return; }
    endVoiceFully();
  };
  const endVoiceFully = () => { voiceStop(); setVoiceOpen(false); setVoiceMinimized(false); setVoiceTranscript(""); setVoiceReply(""); setVoiceError(""); };

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
    setTimeout(() => {
      // Re-checks the reminder still exists and isn't done — it may have been completed or
      // deleted during the snooze window, in which case it has nothing left to ring for.
      const current = smartRemindersRef.current.find(x => x.id === r.id);
      if (!current || current.done) return;
      setRingingReminder(prev => prev ? prev : current);
    }, 10 * 60000);
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
    lastTranscriptRef.current = ""; committedRef.current = false; cancelledRef.current = false;
    r.onstart = () => setListening(true);
    r.onresult = e => {
      const t = Array.from(e.results).map(x => x[0].transcript).join("");
      lastTranscriptRef.current = t;
      setTranscript(t);
      if (e.results[0].isFinal) {
        setTranscript("");
        committedRef.current = true;
        // Send's own tap already sets this flag right before calling stop() — the final text
        // only exists once this handler runs, so this is the earliest point it can actually be
        // sent from.
        if (sendAfterStopRef.current) { sendAfterStopRef.current = false; if (t.trim()) askKroft(t); }
        else { setAiInput(t); setTab("nova"); }
      }
    };
    r.onend = () => {
      setListening(false);
      const wantsSend = sendAfterStopRef.current;
      sendAfterStopRef.current = false;
      // The common failure mode this guards against: stop()/abort() ends the session before a
      // final isFinal result ever arrives (real recognizers do this often, especially right as
      // someone finishes speaking), so onresult's own commit above never ran — without this,
      // whatever was actually heard just vanishes, which is exactly "Send doesn't send."
      if (!committedRef.current && !cancelledRef.current) {
        const pending = lastTranscriptRef.current;
        setTranscript("");
        if (pending.trim()) { if (wantsSend) askKroft(pending); else { setAiInput(pending); setTab("nova"); } }
      }
    };
    r.onerror = e => { setListening(false); sendAfterStopRef.current = false; const msg = micErrorText(e?.error); if (msg) toast(msg); };
    recRef.current = r; r.start();
  }, [listening]);

  // Cancel: discards whatever was said instead of reviewing or sending it. cancelledRef suppresses
  // onend's own fallback above, which would otherwise still commit any interim transcript already
  // captured before abort() was called.
  const cancelListen = useCallback(() => {
    sendAfterStopRef.current = false;
    cancelledRef.current = true;
    recRef.current?.abort?.();
    setTranscript("");
    setListening(false);
  }, []);

  // Stop-and-send in one tap: sets the flag toggleListen's onresult/onend check, then stops
  // exactly like the mic button's own Stop does. Whichever of the two actually ends up firing
  // (a final result, or onend's fallback if one never arrives) is what sends it.
  const stopAndSend = useCallback(() => {
    sendAfterStopRef.current = true;
    recRef.current?.stop();
    setListening(false);
  }, []);

  // Wellness Journal's own dictation — see journalRecRef's comment above for why this can't just
  // reuse toggleListen. Appends the finished phrase to whatever's already been typed/spoken rather
  // than replacing it, so speaking is a way to keep adding to an entry, not to overwrite it.
  const toggleJournalListen = useCallback(() => {
    if (journalListening) { journalRecRef.current?.stop(); setJournalListening(false); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Speech recognition needs Chrome or Edge."); return; }
    const r = new SR(); r.continuous=false; r.interimResults=false; r.lang=speechLang();
    r.onstart = () => setJournalListening(true); r.onend = () => setJournalListening(false);
    r.onresult = e => {
      const t = Array.from(e.results).map(x => x[0].transcript).join("");
      if (t) setJournalDraft(p => (p ? p.replace(/\s+$/, "") + " " : "") + t);
    };
    r.onerror = e => { setJournalListening(false); const msg = micErrorText(e?.error); if (msg) toast(msg); };
    journalRecRef.current = r; r.start();
  }, [journalListening]);

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
      toast(`Couldn't use the microphone. ${MIC_PERMISSION_HINT}`);
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

    // WELLNESS: only ever built from signals that actually have entries — a signal nobody has
    // logged (e.g. no sleepLog) is simply left out, never padded with an invented value. Gated
    // entirely by wellnessAiContext (see its own state comment and the Privacy Controls toggle
    // it powers) — off means the model gets a single line saying so and nothing else from here.
    const wellnessSection = !wellnessAiContext
      ? "Wellness data sharing with KROFT Chat is turned off in this user's Privacy settings. Do not reference mood, sleep, journal, or wellness pattern data even if asked — say wellness data sharing is off and suggest they check Wellness > Privacy Controls."
      : (() => {
          const lines = [`Current wellness score: ${wellness}/100.`];
          if (mood) lines.push(`Current mood: ${mood}.`);
          if (sleepLog.length) lines.push(`Recent sleep logs: ${list(sleepLog.slice(-7).reverse(), 7, e => `${e.date} ${e.hours}h${e.quality?` (${e.quality} quality)`:""}`)}.`);
          if (quickResetLog.length) lines.push(`Quick Reset sessions: ${quickResetLog.length} completed total, ${quickResetLog.filter(q => q.date===today).length} today.`);
          if (selfCare.breaks || selfCare.water) lines.push(`Today's self-care: ${selfCare.breaks} break(s), ${selfCare.water} glass(es) of water logged.`);
          if (journalEntries.length) lines.push(`Wellness Journal: ${journalEntries.length} private entries saved — content is private and not included here.`);
          if (wellnessPatterns.length) lines.push(`Patterns detected in the user's own data (last ${patternRange} days, from the Pattern Engine — every figure below is real, not invented): ${wellnessPatterns.map(p => p.insight).join(" ")}`);
          return lines.join("\n");
        })();

    return `You are KROFT, a personal AI assistant by Orynthra. You can answer any question on any topic, and you also have live access to this user's own data (below). Use it whenever the question touches their money, schedule, work or people — quote real figures and real titles rather than speaking generally. If the data below doesn't cover something, say so plainly instead of guessing. Always reply in the same language the user just wrote or spoke in, not English by default — this app's voice input already recognizes speech in the device's own configured language, not only English.

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
Invoices: ${invoicesForAI(invoices, today, fmtCur)}
Quotes: ${quotesForAI(quotes, today, fmtCur)}
Clients who owe money: ${(() => { const owing = clientSummaries({ invoices, quotes, contacts, today }).filter(c => Object.keys(c.owed).length); return owing.length ? owing.slice(0, 8).map(c => `${c.name} ${Object.entries(c.owed).map(([cur, v]) => fmtCur(v, cur)).join(" + ")}${c.overdueCount ? " (overdue)" : ""}`).join("; ") : "none"; })()}

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

WELLNESS
${wellnessSection}
Wellness rules: only reference a wellness signal that actually appears above — never invent or assume sleep, energy, stress, mood, or other data that isn't listed, and if something isn't there (e.g. no sleep logged), say so plainly and suggest logging it rather than guessing. When answering a wellness question, ground it in the real numbers above and any listed pattern, phrased as an observation about their own data ("your data shows...", "you tend to...") — never as a medical diagnosis, clinical assessment, or professional health advice. If a question sounds medical (symptoms, a condition, treatment), share what their own data shows if relevant, but say plainly that a real diagnosis needs a qualified healthcare professional.

STYLE
Talk like a sharp, genuinely warm human assistant who knows this person well — never like an AI describing itself. Never say things like "As an AI," "I don't have personal experiences," or any other AI-disclaimer or meta-commentary about what you are — just answer, the way a person would. Use contractions and plain, natural sentences; vary how you open a reply instead of starting the same way every time. Address ${firstName||"them"} by their first name every so often — a greeting, good news, a heads-up — not stapled onto every single reply, which reads as scripted rather than natural. Get straight to the answer: no warm-up lines like "Great question!", "Sure! Here's…" or "Certainly", and no closing summary that repeats what you just said.

${voiceMode ? `FORMAT (voice)
This reply will be spoken aloud. Use plain spoken sentences only: no Markdown, no symbols, no tables, no lists, no code blocks. Say figures the way a person would. Keep it to a few sentences.` : `FORMAT
Your reply is rendered as Markdown in the KROFT app, so formatting shows up as real headings, bold, lists and tables, never as symbols. Choose the presentation that fits the question, and use the least formatting that does the job:
- Casual chat or a simple question: one to three natural sentences. No headings, lists or bold.
- An explanation with several parts: short paragraphs, with a few "##" headings only if it's long enough to need them.
- Step-by-step instructions: a numbered list, one action per step.
- A set of items, options or tips: a bullet list.
- A comparison of two or more things across several attributes: a table.
- A recommendation: the recommendation first in one sentence, then the reasoning.
- Research or a detailed question: a one-or-two sentence summary first, then the key points, then detail if it helps.
- Business documents (proposals, plans, reports): clear "##" sections.
- Code: a fenced block with its language, e.g. \`\`\`python. Explanation goes outside the block.
Formatting rules: use **bold** sparingly, only for a key figure or term, never whole sentences or every label. Never use "***" or "___". Don't put headings on short answers. Tables need a header row and a divider row (| --- |), at most about 5 columns, and only when the data really is tabular; never use a table for one or two values. Separate blocks with a blank line.

COPY-READY CONTENT
When ${firstName||"they"} asks you to write something they'll use elsewhere (a message, text, email, letter, caption, social post, bio, prompt, speech, script, cover letter, application, proposal, announcement, or similar), put exactly that content, and nothing else, inside a copy block, so the app can show it on its own with a Copy button:
\`\`\`copy Short label, e.g. Message or Email
The content itself, with its own line breaks and paragraphs. Markdown inside is fine (lists, bold) if the content needs it.
\`\`\`
Rules: no greeting to ${firstName||"them"}, explanation or sign-off from you inside the block, only the content. For an email, put "Subject: …" as the first line inside the block. Keep anything you say about it short and outside the block (at most one line before, and an optional one-line offer after, like offering a shorter version). If they say "only the text", "just the message" or similar, reply with only the copy block and nothing outside it. For several alternatives, use one copy block each. Code uses a normal fenced code block with its language, not a copy block. Don't use copy blocks for your own answers or explanations.

CALCULATIONS
For any calculation with money or several steps (balances, totals, percentages, splits, fees, interest, profit), work it out carefully step by step, then double-check every figure before you reply. Use ${cur} and its symbol (${money(0).replace(/[\d.,\s]/g, "") || cur}) unless they named another currency, with thousands separators and two decimals for money. Present it as:
1. The final answer first, in a result block:
\`\`\`result
What it is, e.g. Final balance
The figure, e.g. ${money(1234.5)}
\`\`\`
2. Then a table of the steps: a description column and an amount column, with deductions shown with a leading "−" and additions with "+", ending with a final row labelled like the result (e.g. "Final balance").
3. Optionally one short sentence on anything notable (e.g. which order a percentage was applied in).
Percentages apply to the running balance at that point unless the person said otherwise; if it's genuinely ambiguous, say which way you took it in one short line. Never invent an amount, date or transaction that wasn't given; if something needed is missing, ask for it. If they ask for "only the final amount" or "just the answer", reply with only the figure (or only the result block), no table and no explanation. For a single simple sum ("what's 15% of 4,000?") just give the answer in a sentence.`}

LIMITS
You are a bookkeeping and organisation assistant, not a licensed financial adviser. You can describe what is in their records, do arithmetic on it, and point out patterns. Do not recommend investments, tax positions, borrowing, insurance or financial products, and do not tell them what to do with their money. If asked for that, say plainly that it needs a qualified accountant or adviser, then offer what you can — the relevant figures from their own records.

ACTIONS
When ${user.name||"the user"} asks you to record, add, schedule, change or remove something, actually do it by appending ONE action block to the very end of your reply, after your normal sentence:
<action>{"type":"...","...":"..."}</action>
Valid types and their fields:
{"type":"add_task","title":"string","priority":"Urgent|High|Normal|Low"}
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
{"type":"add_invoice","client":"string","items":[{"description":"string","qty":number,"price":number}],"due":"YYYY-MM-DD","notes":"string"}
{"type":"add_quote","client":"string","items":[{"description":"string","qty":number,"price":number}],"valid_until":"YYYY-MM-DD","notes":"string"}
Rules: amounts are positive numbers with no currency symbol. Resolve relative dates ("tomorrow", "next Friday") against the current date above and emit an absolute YYYY-MM-DD. Expense categories to prefer: ${expenseCats.join(", ")}. Income categories to prefer: ${incomeCats.join(", ")}. add_invoice is for "invoice/bill [client] for …": it creates a draft invoice in ${user.currency} that the person reviews and sends from Finance › Invoices, so say it's ready to review, not that it was sent; price is per unit and qty defaults to 1; leave "due" out unless they gave a date. Getting paid for an invoice is marked there too, not with add_income. add_quote is the same for "quote/estimate [client] for …" (a price before the work starts); turning an accepted quote into an invoice is done in Finance › Invoices › Quotes. Emit at most one action per reply, only when clearly asked to save, change or remove something — never for a question like "how much did I spend?". complete_task, edit_appointment, and every delete_* type match an EXISTING item by its title/label/text against the lists above — use the shortest distinctive wording from that list, not a paraphrase, so the match is unambiguous. edit_appointment only needs the field(s) actually changing (e.g. just "time" to only move the time). Only set send_email's "to" to an address that actually appears in CONTACTS or EMAIL above — never guess or construct one; if you don't have a real address for who they mean, say so and ask for it instead of emitting the action.
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
        const priority = ["Urgent","High","Normal","Low"].includes(action.priority) ? action.priority : "Normal";
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
      case "add_quote":
      case "add_invoice": {
        const isQuote = action.type === "add_quote";
        const client = str(action.client); if (!client) return null;
        const items = (Array.isArray(action.items) ? action.items : [])
          .map(it => ({ description: str(it?.description), qty: Number(it?.qty) > 0 ? Number(it.qty) : 1, price: parseAmount(it?.price) ?? 0 }))
          .filter(it => it.description && it.price > 0);
        if (!items.length) return { label:`I couldn't tell what to put on the ${isQuote ? "quote" : "invoice"} for ${client}. Try "${isQuote ? "quote" : "invoice"} ${client} ₦50,000 for the logo design".` };
        const allowance = isQuote ? quoteAllowance({ subscribed, quotes, today:todayISO() }) : invoiceAllowance({ subscribed, invoices, today:todayISO() });
        if (!allowance.allowed) return { label: isQuote ? `You've used this month's ${FREE_QUOTES_PER_MONTH} free quotes. KROFT Plus gives you unlimited quotes.` : `You've used this month's ${FREE_INVOICES_PER_MONTH} free invoices. KROFT Plus gives you unlimited invoices.` };
        const c = contacts.find(x => (x.name || "").toLowerCase() === client.toLowerCase());
        if (isQuote) {
          const { quote } = createQuote({ settings:invoiceSettings, client:{ name:client, email:c?.email || "", phone:c?.phone || "" }, clientId:c?.id ?? null, items, validUntil: validDate(action.valid_until) ? action.valid_until : undefined, notes: str(action.notes) || undefined, currency:user.currency, today:todayISO(), id:String(uid()) });
          setQuotes(p => [quote, ...p]);
          setInvoiceSettings(s => ({ ...s, nextQuoteNumber:(Number(s.nextQuoteNumber) || 1) + 1 }));
          return {
            label:`Quote ${quote.number} drafted for ${client}: ${fmtCur(invoiceTotals(quote).total, quote.currency)}. Review and send it from Finance › Invoices › Quotes.`,
            undo:() => {
              setQuotes(p => p.filter(x => x.id !== quote.id));
              setInvoiceSettings(s => (Number(s.nextQuoteNumber) === Number(quote.number.split("-").pop()) + 1 ? { ...s, nextQuoteNumber: s.nextQuoteNumber - 1 } : s));
            },
          };
        }
        const { invoice: created } = createInvoice({ settings:invoiceSettings, client:{ name:client, email:c?.email || "", phone:c?.phone || "" }, items, dueDate: validDate(action.due) ? action.due : undefined, notes: str(action.notes) || undefined, currency:user.currency, today:todayISO(), id:String(uid()) });
        const invoice = { ...created, clientId:c?.id ?? null };
        setInvoices(p => [invoice, ...p]);
        setInvoiceSettings(s => ({ ...s, nextNumber:(Number(s.nextNumber) || 1) + 1 }));
        return {
          label:`Invoice ${invoice.number} drafted for ${client}: ${fmtCur(invoiceTotals(invoice).total, invoice.currency)}. Review and send it from Finance › Invoices.`,
          undo:() => {
            setInvoices(p => p.filter(x => x.id !== invoice.id));
            // Give the number back only if nothing else has used the next one since.
            setInvoiceSettings(s => (Number(s.nextNumber) === Number(invoice.number.split("-").pop()) + 1 ? { ...s, nextNumber: s.nextNumber - 1 } : s));
          },
        };
      }
      case "add_appointment": {
        const title = str(action.title); if (!title) return null;
        const item = { id:uid(), title, date:validDate(action.date)?action.date:todayISO(), time:str(action.time)||"09:00", location:str(action.location), notes:"", urgent:false, repeat:"none", contactId:null };
        const conflict = findApptConflict(appts, item.date, item.time, item.id);
        setAppts(p => [...p, item]);
        mirrorAppointmentToCalendars(item);
        const label = conflict
          ? `Appointment added: ${title} — heads up, that's the same time as "${conflict.title}."`
          : `Appointment added: ${title}`;
        return { label, undo:() => setAppts(p => p.filter(x => x.id !== item.id)) };
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

  // A message with image attachments is sent as real Anthropic-shaped content blocks (text +
  // image) — api/_lib/gemini.js translates these into genuine Gemini inline image parts, so
  // KROFT actually sees the image, not just a mention of it. A non-image file attachment is
  // never parsed or read; only its name is folded into the text, the same honesty as everywhere
  // else in this app about what it can and can't actually do.
  const buildMessageContent = m => {
    const atts = m.attachments || [];
    if (!atts.length) return m.content;
    const images = atts.filter(a => a.kind==="image");
    const files = atts.filter(a => a.kind!=="image");
    const text = files.length
      ? `${m.content}${m.content ? "\n\n" : ""}[Attached file${files.length!==1?"s":""}: ${files.map(f=>f.name).join(", ")}]`
      : m.content;
    if (!images.length) return text;
    return [
      { type:"text", text: text || "(see attached image)" },
      ...images.map(img => ({ type:"image", source:{ type:"base64", media_type:img.type, data: (img.dataUrl.split(",")[1] || "") } })),
    ];
  };

  // onDelta streams tokens as they arrive; without it the call resolves with the full text.
  // Streaming matters most here because replies are long enough that a spinner-then-dump feels
  // broken, and because the first sentence can start being read aloud while the rest arrives.
  const runKroftCompletion = async (messages, { onDelta, signal, usageType = "chat", voiceMode = false } = {}) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new KroftError("You're offline. KROFT needs an internet connection to answer, so try again once you're back online.");
    }
    const recent = messages.slice(-historyLimit());
    const body = {
      model:"gemini-3.6-flash",
      max_tokens:2048,
      system:krofSysPrompt(voiceMode),
      messages:recent.map(m => ({ role:m.role, content:buildMessageContent(m) })),
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
      // Share sheet on phones and in the app, a download on computers (see saveFile.js).
      const result = await saveFile({ name:`kroft-backup-${todayISO()}.json`, data:JSON.stringify(payload, null, 2), type:"application/json", title:"KROFT backup" });
      if (result === "downloaded") toast("Backup downloaded. Check your Downloads folder.");
    } catch (err) { toast(err?.code === "needs-update" ? "Update the KROFT app to save files." : "Couldn't create the backup. Try again."); }
  };

  // Permanently deletes the account (see api/account/delete.js), or, without Supabase, everything
  // stored on this device. Returns false when nothing was deleted so the dialog stays open.
  const deleteAccount = async () => {
    if (isSupabaseConfigured) {
      try {
        const res = await authedFetch("/api/account/delete", { method: "POST" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast(body.error === "subscription_cancel_failed"
            ? "Couldn't cancel your KROFT Plus subscription, so your account wasn't deleted. Try again."
            : "Couldn't delete your account. Try again.");
          return false;
        }
      } catch {
        toast("Couldn't delete your account. Check your connection and try again.");
        return false;
      }
      // The account is gone on the server, so only the local session needs clearing.
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    // Pending saves can still land in the pre-sign-in localStorage fallback until this app
    // unmounts, so local data is wiped once now and again at the moment of the reset.
    const wipeLocal = () => {
      try {
        Object.values(STORAGE_KEYS).forEach(k => window.localStorage.removeItem(k));
        sessionStorage.removeItem(OAUTH_RETURN_KEY);
        clearOfflineData();
        writeNativeBio(null);
      } catch { /* storage unavailable: nothing to wipe */ }
    };
    wipeLocal();
    toast("Your account has been deleted.");
    setTimeout(() => { wipeLocal(); onFullReset?.(); setTimeout(wipeLocal, 1500); }, 400);
    return true;
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
          // The field's own placeholder is "Time e.g. 4:00 PM" — a plain `split(":").map(Number)`
          // parsed "4:00 PM" as hour=4, minute=NaN (falling back to :00), silently firing an
          // appointment's reminder twelve hours off whenever it was entered in that (normal,
          // placeholder-suggested) format. parseApptTime actually understands AM/PM.
          const target = parseApptTime(a.time);
          if (target == null) return;
          const delta = target - mins;
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

      // KROFT Plus: one nudge, in the morning, the day an invoice becomes overdue, so a late
      // payment is noticed without having to check the list.
      if (subscribed && notifPrefs.reminders && mins >= 9*60) {
        invoices.filter(inv => invoiceStatus(inv, today) === "overdue" && inv.dueDate === ymdLocal(new Date(Date.now() - 86400000))).forEach(inv => {
          send(`inv-overdue:${inv.id}`, `${inv.number} is overdue`,
            `${inv.client.name} hasn't paid ${fmtCur(invoiceTotals(inv).total, inv.currency)} yet. Open Invoices to send a reminder.`);
        });
      }

      if (Object.keys(fired).length) setNotifSent(p => ({ ...p, ...fired }));
    };
    check();
    return heartbeat(check);
  }, [dataLoaded, notifPermission, notifPrefs, appts, smartReminders, notifSent, subscribed, dailyBriefSentDate, invoices]);

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
    // In the Android app reminders are scheduled on the phone itself (no account needed).
    if (!dataLoaded || (!isSupabaseConfigured && !isNativeApp)) return;
    const now = Date.now();
    const items = appts
      .map(a => {
        if (!a.date || !a.time) return null;
        // Same fix as the in-app reminder check above — a.time is free text ("4:00 PM" is the
        // field's own placeholder), not guaranteed 24-hour HH:MM.
        const target = parseApptTime(a.time);
        if (target == null) return null;
        const fires = new Date(`${a.date}T00:00:00`);
        fires.setHours(Math.floor(target / 60), target % 60, 0, 0);
        fires.setMinutes(fires.getMinutes() - 10);
        if (fires.getTime() <= now) return null; // only ever push for something still ahead
        return { clientKey:`appt:${a.id}`, firesAt:fires.toISOString(), title:`${a.title} in 10 min`, body:[a.time, a.location].filter(Boolean).join(" · ") };
      })
      .filter(Boolean);
    const t = setTimeout(() => {
      (isNativeApp ? scheduleDeviceReminders("appt:", items) : authedFetch("/api/push/schedule", { method:"POST", body:JSON.stringify({ prefix:"appt:", items }) })).catch(() => {
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
    // In the Android app reminders are scheduled on the phone itself (no account needed).
    if (!dataLoaded || (!isSupabaseConfigured && !isNativeApp)) return;
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
      (isNativeApp ? scheduleDeviceReminders("reminder:", items) : authedFetch("/api/push/schedule", { method:"POST", body:JSON.stringify({ prefix:"reminder:", items }) })).catch(() => {
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
          let anyChanged = false;
          const next = prev.map(e => {
            if (!e.repeat || e.repeat === "none" || !e.nextDate) return e;
            let cursor = e.nextDate;
            let guard = 0;
            let itemChanged = false;
            // Guarded so a corrupted cadence can't spin forever; 60 postings covers five years
            // of monthly or a year of weekly. The inner break matters separately: a corrupted
            // repeat cadence or an unparseable nextDate makes advanceRepeatDate return its input
            // unchanged, which without this check would still run all 60 iterations pushing 60
            // identical-date duplicate postings — and repeat that again every ~30s heartbeat
            // forever, since nextDate would never actually move past today.
            while (cursor <= today && guard++ < 60) {
              const nextCursor = advanceRepeatDate(cursor, e.repeat);
              if (nextCursor === cursor) break;
              generated.push({ id:uid(), label:e.label, amount:e.amount, cat:e.cat, date:cursor, cur:e.cur || user.currency, fromRecurring:e.id });
              cursor = nextCursor;
              itemChanged = true;
            }
            if (!itemChanged) return e;
            anyChanged = true;
            return { ...e, nextDate:cursor };
          });
          return anyChanged ? [...next, ...generated] : prev;
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
      // A stored day AHEAD of today isn't a new day — it's the same day labelled differently
      // (dates used to be saved in UTC, which runs ahead of local time west of Greenwich, and a
      // phone's clock can be moved back). Relabel it instead of decaying the score and wiping
      // today's break/water counts as if midnight had passed.
      if (wellnessDate > today) { setWellnessDate(today); return; }
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
      // Same "read via the updater's own prev" reasoning as wellness above — selfCare's own values
      // can only be captured here, at the moment they're about to be reset, not via wellnessDate's
      // closure.
      setSelfCare(prev => {
        setSelfCareHistory(h => [...h.filter(e => e.date !== wellnessDate), { date: wellnessDate, breaks: prev.breaks, water: prev.water }]);
        return { breaks:0, water:0 };
      });
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
    // (a.time || "") > "14:00"-style string comparison silently broke on the free-text format the
    // time field's own placeholder suggests ("4:00 PM") — "9:00 AM" lexically sorts after "14:00"
    // (the digit '9' beats '1'), so an appointment that already happened this morning could still
    // be offered up as "Next up" in the afternoon. parseApptTime + a numeric comparison, then
    // sortAppts so [0] is genuinely the soonest of what's left today, not whichever survived the
    // filter first.
    const nowMins = hour * 60 + now.getMinutes();
    const laterToday = sortAppts(todaysAppts.filter(a => { const t = parseApptTime(a.time); return t != null && t > nowMins; }));
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
    setEditingMsg(null);
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

  // Phones usually resume KROFT from the background rather than reloading it, so the idle rule in
  // hydrateAllGroups is applied here too: coming back after CHAT_IDLE_RESET_MS files the open
  // conversation into history and starts a new one.
  const chatActiveAt = useRef(Date.now());
  // Files the open conversation into history (if it has anything in it) and leaves a new, empty
  // chat. Used after a device-only log in and when returning after a long time away.
  const fileOpenChat = () => {
    const current = latestMessages.current;
    if (!current.some(m => m.role === "user") || current.some(m => m.streaming)) return;
    setChatHistory(h => [{ id:uid(), title:deriveChatTitle(current), messages:current, updatedAt:chatActiveAt.current }, ...h].slice(0, 30));
    setAiMessages([]);
  };
  const latestMessages = useRef(aiMessages);
  useEffect(() => { chatActiveAt.current = Date.now(); latestMessages.current = aiMessages; }, [aiMessages]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - chatActiveAt.current < CHAT_IDLE_RESET_MS) return;
      fileOpenChat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Online/offline. Offline, the app runs from this device's copy of the data (see storageShim.js):
  // a banner says so, AI features explain they need a connection, and changes are queued. Back
  // online, queued changes are sent, and anything that couldn't be loaded offline is loaded now.
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const goOffline = () => setOnline(false);
    const goOnline = async () => {
      setOnline(true);
      if (!isSupabaseConfigured) return;
      const hadQueued = hasUnsyncedChanges();
      await flushPending();
      if (unreadableKeys().length) await hydrateAllGroups();
      if (hadQueued && !hasUnsyncedChanges()) toast("Back online. Your changes are synced.");
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => { window.removeEventListener("offline", goOffline); window.removeEventListener("online", goOnline); };
  }, []);

  // Swaps in a saved conversation as the active one — saving whatever's currently active into
  // history first (same as startNewChat), and pulling the opened conversation out of the history
  // list since it's the live one again now, not a saved item.
  // Scrolls the chat to a message opened from search, expanding it first if it's a collapsed long
  // message, then highlights it for a moment.
  const jumpToMessage = (messages, idx) => {
    if (idx == null) return;
    const m = messages[idx];
    if (m?.role === "user") setExpandedUserMsgs(prev => new Set(prev).add(m.id ?? idx));
    setChatJump({ idx, at: Date.now() });
  };
  const openHistoryChat = (id, jumpIdx = null) => {
    const target = chatHistory.find(c => c.id === id);
    if (!target) return;
    setEditingMsg(null);
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
    jumpToMessage(target.messages, jumpIdx);
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
    const q = override || aiInput;
    // Attachments alone (no typed text) is a valid send — "here's a photo" needs no caption.
    if (!q.trim() && aiAttachments.length===0) return;

    // A detected contact action no longer short-circuits the model. It used to intercept the
    // message entirely and return a "did you mean...?" card, which made sense when KROFT was
    // blind — but now it can see your contacts and draft the actual text or email, so blocking
    // it was a downgrade. The reply comes through as normal and the shortcut rides along
    // underneath it as a button.
    const contactAction = resolveContactAction(q);

    // Real daily cap enforcement for the free plan. Resets when the calendar day changes.
    const userMsg = { role:"user", content:q, ...(aiAttachments.length>0 ? { attachments:aiAttachments } : {}) };
    setAiMessages(p => [...p, userMsg]); setAiInput(""); setAiAttachments([]);
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

  // Replaces one of the person's own messages with an edited version and answers again from there.
  // Messages after it are dropped, like Retry does for the last reply; it goes through the same
  // quota-checked path as every other reply.
  useEffect(() => { if (editingMsg != null && aiMessages[editingMsg]?.role !== "user") setEditingMsg(null); }, [aiMessages, editingMsg]);
  const editAndResend = async (i, text) => {
    const t = text.trim();
    if (aiLoading || !t || aiMessages[i]?.role !== "user") return;
    const { feedback, ...orig } = aiMessages[i];
    const convo = [...aiMessages.slice(0, i), { ...orig, content:t, id:uid() }];
    setEditingMsg(null);
    setAiMessages(convo);
    await runNormalCompletion(convo);
  };

  const setMsgFeedback = (i, val) => {
    setAiMessages(p => p.map((m,idx) => idx===i ? { ...m, feedback: m.feedback===val ? null : val } : m));
    toast(val==="up" ? "Thanks for the feedback." : "Thanks — KROFT will keep improving.");
  };

  // KROFT's replies are Markdown: copy them as clean text (and rich text for apps that accept it)
  // rather than with their ** and | symbols. A person's own message is copied exactly as typed.
  const copyMsg = async (text, { markdown = true } = {}) => {
    const ok = await (markdown ? copyRich(text) : copyPlain(text));
    toast(ok ? "Copied to clipboard." : "Couldn't copy. Try selecting the text manually.");
  };

  const shareMsg = async text => {
    const plain = toPlainText(text);
    if (navigator.share) { try { await navigator.share({ text: plain }); } catch {} }
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
    const today = todayISO();
    const ym = today.slice(0, 7); // "2026-08"
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
    const context = `Month: ${monthLabel(today)}. Income entries: ${monthInc.length} totaling ${fmtCur(incTotal,user.currency)}. Expense entries: ${monthExp.length} totaling ${fmtCur(expTotal,user.currency)}. Net: ${fmtCur(net,user.currency)}. Top expense categories: ${topCats.length>0?topCats.map(([c,v])=>`${c} (${fmtCur(v,user.currency)})`).join(", "):"none"}. Business: ${user.businessName||"not set"} (${user.businessType||""}).`;
    try {
      const res = await aiFetch("/api/chat", { method:"POST", headers:{"Content-Type":"application/json","X-Kroft-Usage-Type":"report"}, body:JSON.stringify({ model:"gemini-3.6-flash", max_tokens:400, system:"You are KROFT, a bookkeeping assistant. Given a user's monthly income/expense summary, write a short end-of-month summary: 2-3 sentences on what the numbers show, then 2-3 practical observations about their own spending patterns. Describe what happened in their data — do not recommend financial products, investments, tax positions, borrowing, or anything requiring a licensed advisor. Frame observations as prompts to consider, not instructions. No preamble, no headers, plain text only.", messages:[{ role:"user", content:context }] }) });
      const data = await res.json();
      const advice = (res.ok && data.content?.map(b=>b.text||"").join("").trim()) || "Couldn't generate advice right now — try again shortly.";
      setMonthlyReport({ month:monthLabel(today), incTotal, expTotal, net, topCats, advice, generatedAt:Date.now() });
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
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoISO = ymdLocal(weekAgo);
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

  // CSV export and document downloads. This used to revoke the file's URL the instant after
  // clicking, which cancels the download in Chrome on Android while still saying "downloaded".
  // Now: share sheet on phones and in the app, a download on computers (see saveFile.js).
  const downloadText = async (filename, content, doneMsg) => {
    try {
      const type = filename.endsWith(".csv") ? "text/csv" : "text/plain";
      const result = await saveFile({ name:filename, data:content, type });
      if (result === "downloaded" && doneMsg) toast(`${doneMsg} Check your Downloads folder.`);
    } catch (err) {
      toast(err?.code === "needs-update" ? "Update the KROFT app to save files." : "Couldn't save that file. Try again.");
    }
  };

  // A field containing a comma, quote or newline has to be quoted, with any internal quote
  // doubled — otherwise a description like `Lunch, client meeting` would silently split into two
  // spreadsheet columns on open. A leading =, +, -, or @ gets a guarding leading apostrophe too —
  // Excel/Sheets treat those as the start of a formula, so a label typed as `=1+1` would otherwise
  // execute as one instead of showing as the plain text it is (CSV formula injection).
  const csvField = v => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
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
    downloadText(`kroft-finance-${todayISO()}.csv`, csv, "CSV downloaded.");
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

  // Around-tab auto-resolve (below) and every category tap before userCoords is set
  // (searchNearby's `if (!userCoords) { requestLocation(); return; }`) can each call this — so
  // mashing a category button, or Retry, while a fix is already in flight would otherwise fire
  // several overlapping getCurrentPosition calls, each ending in its own reverseGeocode hitting
  // Nominatim's strict 1 req/s limit. One in flight is enough; a second is just a duplicate.
  // Also tracks the last position actually reverse-geocoded, so a fresh GPS fix that's practically
  // the same spot (a few meters of drift, not a real move) doesn't spend another Nominatim call on
  // a label that wouldn't change anyway.
  const lastGeocodedKey = useRef(null);
  // Guards against a slower, older search's response landing after a faster, newer one — every
  // other async flow in this file (calendar sync, mail sync, billing, ...) already uses an
  // AbortController or a token for exactly this; searchNearby had neither. Without it, tapping
  // "Restaurants" (slow Overpass query) then immediately tapping "Pharmacies" (fast query) shows
  // pharmacies first, then silently overwrites them with the stale restaurant results moments
  // later, with the screen still labeled "Pharmacies."
  const aroundSearchTokenRef = useRef(0);
  const requestLocation = () => {
    if (locationStatus === "requesting") return;
    if (!navigator.geolocation) { setLocationStatus("error"); setAroundError("Geolocation isn't supported on this device."); return; }
    setLocationStatus("requesting"); setAroundError("");
    // A precise GPS fix often can't be had indoors within the time limit; the second attempt
    // accepts a rougher network-based position, which is plenty for "places near me".
    const attempt = precise => navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        setUserCoords({ lat:latitude, lng:longitude });
        setLocationStatus("granted");
        const posKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`; // ~111m grid cell
        if (posKey !== lastGeocodedKey.current) {
          lastGeocodedKey.current = posKey;
          reverseGeocode(latitude, longitude);
        }
      },
      err => {
        if (err.code === err.PERMISSION_DENIED) {
          setLocationStatus("denied");
          setAroundError(isNativeApp
            ? "KROFT needs location access to find places near you. Allow it in Profile → Security and login → App permissions."
            : "Location access was denied. KROFT needs this to find places near you — you can enable it later in your device Settings.");
          return;
        }
        if (precise) { attempt(false); return; }
        setLocationStatus("error");
        setAroundError(/turned off|not enabled|disabled/i.test(err.message || "")
          ? "Location is turned off on your phone. Switch it on from the quick settings panel, then tap Retry."
          : "Couldn't determine your location right now. Make sure location is switched on, then tap Retry.");
      },
      precise ? { enableHighAccuracy:true, timeout:12000, maximumAge:60000 } : { enableHighAccuracy:false, timeout:20000, maximumAge:300000 }
    );
    attempt(true);
  };

  const reverseGeocode = async (lat, lng) => {
    try {
      const res = await fetch(`/api/places?mode=reverse&lat=${lat}&lon=${lng}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Places service unavailable");
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
    const myToken = ++aroundSearchTokenRef.current;
    const isCurrent = () => myToken === aroundSearchTokenRef.current;
    setAroundLoading(true); setAroundError(""); setAroundSearched(true); setAroundResults([]);

    // Category browsing (the CATEGORIES grid, and "Feeling hungry?") goes straight to Overpass via
    // the proxy, not Nominatim's free-text search — see api/places.js's comment for why a category
    // label like "Restaurants" doesn't actually find real nearby restaurants there.
    if (categoryKey) {
      // Rounded to ~11m precision — well within Overpass's multi-hundred-meter-radius search, so
      // it only ever collapses true floating-point noise between reads of the same fixed
      // userCoords, never two genuinely different locations into one cache entry.
      const cacheKey = `${categoryKey}:${userCoords.lat.toFixed(4)},${userCoords.lng.toFixed(4)}`;
      const cached = placesCache.get(cacheKey);
      if (cached && Date.now() - cached.time < PLACES_CACHE_TTL_MS) {
        setAroundResults(cached.results);
        if (cached.results.length === 0) setAroundError(`No ${categoryOrQuery.toLowerCase()} found nearby. Try a different category or search.`);
        setAroundLoading(false);
        return;
      }
      try {
        const res = await fetch(`/api/places?mode=category&category=${encodeURIComponent(categoryKey)}&lat=${userCoords.lat}&lon=${userCoords.lng}`);
        const data = await res.json();
        if (!isCurrent()) return; // a newer search superseded this one while the request was in flight
        // A backend failure (Overpass down, bad request) still comes back as valid JSON —
        // `{error:"..."}`, no `results` field — which `data.results || []` would otherwise
        // silently treat as a real empty search, misreporting a connection error as "no
        // restaurants found nearby" instead of telling the user the service itself failed.
        if (!res.ok || data.error) throw new Error(data.error || "Places service unavailable");
        const results = data.results || [];
        placesCache.set(cacheKey, { time: Date.now(), results });
        setAroundResults(results);
        if (results.length === 0) setAroundError(`No ${categoryOrQuery.toLowerCase()} found nearby. Try a different category or search.`);
      } catch (e) {
        if (!isCurrent()) return;
        // The proxy distinguishes a slow/overloaded upstream (both Overpass mirrors timed out)
        // from an outright failure — worth telling the person apart, since one suggests "try
        // again in a bit" and the other suggests "check your connection."
        setAroundError(e.message === "Places service timed out"
          ? "The places service is taking too long to respond. Try again in a moment."
          : "Couldn't reach the places service. Check your connection and try again.");
      }
      if (isCurrent()) setAroundLoading(false);
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
        if (!isCurrent()) return;
        searchTerm = data.content?.map(b=>b.text||"").join("").trim() || categoryOrQuery;
      } catch { searchTerm = categoryOrQuery; }
      if (!isCurrent()) return;
    }

    try {
      const viewbox = `${userCoords.lng-0.05},${userCoords.lat+0.05},${userCoords.lng+0.05},${userCoords.lat-0.05}`;
      const res = await fetch(`/api/places?mode=search&q=${encodeURIComponent(searchTerm)}&viewbox=${encodeURIComponent(viewbox)}`);
      const data = await res.json();
      if (!isCurrent()) return; // a newer search superseded this one while the request was in flight
      // Same reasoning as the category branch above — a backend failure comes back as
      // `{error:"..."}`, not an array, so check explicitly instead of relying on the incidental
      // TypeError .map() would throw on a plain object to fall into the catch below.
      if (!res.ok || data?.error) throw new Error(data?.error || "Places service unavailable");
      // display_name is a single comma-joined string whose field order varies by locale and place
      // type — splitting it blindly (the old approach) occasionally put a house number in "name"
      // and buried the real business name in "address". Nominatim's structured fields (requested
      // via addressdetails/namedetails above) are far more reliable when present: namedetails.name
      // is the place's actual name tag, and address[type]/address[class] holds it too for a
      // result that IS that kind of POI (Nominatim's own convention). Only falls back to the old
      // split when neither structured field is available.
      const results = (data||[]).map(p => {
        const structuredName = p.namedetails?.name || p.address?.[p.type] || p.address?.[p.class];
        const addrParts = [
          [p.address?.house_number, p.address?.road].filter(Boolean).join(" "),
          p.address?.neighbourhood || p.address?.suburb,
          p.address?.city || p.address?.town || p.address?.village,
        ].filter(Boolean);
        return {
          id:p.place_id,
          name: structuredName || p.display_name.split(",")[0],
          address: addrParts.length ? addrParts.join(", ") : p.display_name.split(",").slice(1,3).join(",").trim(),
          lat:parseFloat(p.lat), lng:parseFloat(p.lon),
          type:p.type,
        };
      });
      setAroundResults(results);
      if (results.length === 0) setAroundError(`No results found for "${searchTerm}" nearby. Try a different search.`);
    } catch (e) {
      if (!isCurrent()) return;
      setAroundError(e.message === "Places service timed out"
        ? "The places service is taking too long to respond. Try again in a moment."
        : "Couldn't reach the places service. Check your connection and try again.");
    }
    if (isCurrent()) setAroundLoading(false);
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

  // The Inter web font is linked from index.html's <head>, so it starts downloading with the page
  // instead of only after this script has run.
  const G = `${ANIM}
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{overflow-x:hidden;max-width:100vw;overscroll-behavior-x:none}
    #root,#app{overflow-x:hidden}
    html,body,input,button,select,textarea{font-family:${APP_FONT}}
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

  // Keep the splash up past its normal 6s if data hasn't finished loading yet — extending a
  // fast, expected case by a beat is far better than flashing empty/default state (a fresh
  // signup screen, zeroed finances) for a returning user whose real data just hasn't arrived.
  if (showSplash || !dataLoaded) return <SplashScreen fading={splashFading && dataLoaded} />;

  // Rendered on both the signed-in dashboard and the sign-in/onboarding screens — it used to live
  // only in the dashboard view, so every toast fired before sign-in (e.g. "Check your email to
  // confirm your account") silently never appeared.
  // Above every overlay, including voice mode (1200). Toasts carry the undo for an action KROFT
  // just took — and a misheard amount is far likelier by voice than by typing, so burying the
  // undo behind the voice overlay hid it exactly where it mattered most. aria-live so toasts are
  // announced rather than shown only; "polite" waits for a pause instead of cutting across
  // whatever is being read.
  // Placed where it never sits over a control, and it ignores taps either way: above the bottom
  // navigation in the app, at the top on the sign-in screens (nothing there to cover), and not at
  // all in the chat, which shows its own note above the message box instead.
  const offlineBanner = !online && !(step === "dashboard" && tab === "nova") && (
    <div role="status" style={{ position:"fixed", left:"50%", transform:"translateX(-50%)", zIndex:1350, pointerEvents:"none",
      ...(step === "dashboard" ? { bottom:"calc(96px + env(safe-area-inset-bottom))" } : { top:"calc(10px + env(safe-area-inset-top))" }),
      display:"flex", alignItems:"center", gap:8, maxWidth:"calc(100vw - 32px)", boxSizing:"border-box", padding:"8px 14px", borderRadius:999,
      background:C.text, color:C.bg, fontSize:13, fontWeight:600, fontFamily:APP_FONT, boxShadow:"0 8px 24px rgba(0,0,0,.18)" }}>
      <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.3-2.6M19 13a10 10 0 0 0-2.2-1.6M1.5 9.5a15 15 0 0 1 4.6-3M22.5 9.5A15 15 0 0 0 11 5.1M12 20h.01" />
      </svg>
      <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
        {step === "dashboard" ? "You're offline. Changes will sync later." : "You're offline. Connect to sign in."}
      </span>
    </div>
  );

  const toastStack = (
    <div role="status" aria-live="polite" aria-atomic="false"
      style={{ position:"fixed", top:14, right:14, zIndex:1400, display:"flex", flexDirection:"column", gap:7, maxWidth:300, pointerEvents:"none" }}>
      {/* Toasts sit over the header's buttons, so they let taps through; only one with an Undo
          button takes taps itself. */}
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents:t.onUndo ? "auto" : "none", background:C.card, border:`1px solid ${C.accent}44`, borderRadius:14, padding:"9px 14px", animation:"slideIn .3s ease", boxShadow:`0 8px 28px rgba(0,0,0,.7), 0 0 0 1px ${C.accentBg}` }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <Dot color={C.accent} />
            <div style={{ fontSize:11, color:C.white, lineHeight:1.4, fontFamily:APP_FONT, flex:1 }}>{t.msg}</div>
            {t.onUndo && (
              <button onClick={() => { t.onUndo(); setToasts(p => p.filter(x => x.id !== t.id)); }} style={{ background:"none", border:"none", color:C.accent, fontSize:11, fontWeight:700, fontFamily:APP_FONT, cursor:"pointer", padding:"4px 2px", flexShrink:0 }}>Undo</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  if (step !== "dashboard") return (
    <div key={themeTick} style={{ fontFamily:APP_FONT, overflowX:"hidden", maxWidth:"100vw", touchAction:"pan-y" }}>
      <style>{G}</style>
      {toastStack}
      {offlineBanner}
      {appLockOverlay}

      {step === "welcome" && (
        <WelcomeScreen onPhone={openPhoneSignIn} onGoogle={signInWithGoogle} onEmail={() => setStep("signup")} onLogIn={() => setStep("login")} googleLoading={googleLoading} />
      )}

      {step === "phone" && (
        <AuthScreen
          onBack={phoneStage === "number" ? () => { setPhoneError(""); setStep("welcome"); }
            : phoneStage === "code" ? () => { setPhoneStage("number"); setOtpInput(""); setPhoneError(""); } : null}
          title={phoneStage === "number" ? "What's your phone number?" : phoneStage === "code" ? "Enter the code" : "What should KROFT call you?"}
          subtitle={phoneStage === "number" ? "We'll text you a 6-digit code to sign in or create your account."
            : phoneStage === "code" ? <>We sent it to <b style={{ color:LIGHT.text, fontWeight:600 }}>{normalizePhone(phoneInput)}</b>.</>
            : "Your first name is fine. You can change it later in Profile."}
          footer={
            <AuthButton loading={phoneLoading} onClick={phoneStage === "number" ? sendPhoneCode : phoneStage === "code" ? verifyPhoneCode : finishPhoneName}>
              {phoneLoading ? (phoneStage === "number" ? "Sending code…" : "Checking…") : phoneStage === "number" ? "Send code" : phoneStage === "code" ? "Verify" : "Continue"}
            </AuthButton>
          }>
          {phoneStage === "number" && (
            <AuthInput label="Phone number" type="tel" inputMode="tel" autoComplete="tel" autoFocus placeholder="+234 801 234 5678" value={phoneInput} invalid={!!phoneError}
              hint="Include your country code, for example +234 or +1."
              onChange={e => { setPhoneInput(e.target.value); setPhoneError(""); }} onKeyDown={e => e.key === "Enter" && sendPhoneCode()} />
          )}
          {phoneStage === "code" && (
            <>
              <AuthInput label="6-digit code" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" value={otpInput} invalid={!!phoneError}
                onChange={e => { setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6)); setPhoneError(""); }} onKeyDown={e => e.key === "Enter" && verifyPhoneCode()}
                style={{ fontSize:24, letterSpacing:10, textAlign:"center", fontVariantNumeric:"tabular-nums" }} />
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:14 }}>
                <AuthLink onClick={() => { setPhoneStage("number"); setOtpInput(""); setPhoneError(""); }}>Change number</AuthLink>
                <AuthLink disabled={phoneLoading} onClick={() => !phoneLoading && sendPhoneCode()}>Resend code</AuthLink>
              </div>
            </>
          )}
          {phoneStage === "name" && (
            <AuthInput label="Your name" autoComplete="given-name" autoFocus placeholder="Your name" value={user.name || ""} invalid={!!phoneError}
              onChange={e => { setUser(u => ({ ...u, name:e.target.value })); setPhoneError(""); }} onKeyDown={e => e.key === "Enter" && finishPhoneName()} />
          )}
          {phoneError && <AuthAlert>{phoneError}</AuthAlert>}
        </AuthScreen>
      )}

      {step === "login" && (
        forgotOpen ? (
          <AuthScreen onBack={() => { setForgotOpen(false); setForgotSent(false); setForgotError(""); setForgotEmail(""); }} backLabel="Back to log in"
            title={forgotSent ? "Check your email" : "Reset your password"}
            subtitle={forgotSent ? `If an account exists for ${forgotEmail.trim()}, a reset link is on its way.` : "Enter the email you signed up with and we'll send you a link to set a new password."}
            footer={forgotSent
              ? <AuthButton onClick={() => { setForgotOpen(false); setForgotSent(false); setForgotError(""); }}>Back to log in</AuthButton>
              : <AuthButton loading={forgotLoading} onClick={doForgotPassword}>{forgotLoading ? "Sending…" : "Send reset link"}</AuthButton>}>
            {!forgotSent && (
              <AuthInput label="Email" type="email" autoComplete="email" autoFocus placeholder="you@example.com" value={forgotEmail} invalid={!!forgotError}
                onChange={e => { setForgotEmail(e.target.value); setForgotError(""); }} onKeyDown={e => e.key === "Enter" && doForgotPassword()} />
            )}
            {forgotError && <AuthAlert>{forgotError}</AuthAlert>}
          </AuthScreen>
        ) : (
          <AuthScreen onBack={() => { setLoginError(""); setStep("welcome"); }} title="Welcome back" subtitle="Log in to your KROFT account."
            footer={<>
              <AuthButton loading={authLoading} disabled={locked} onClick={doLogin}>{locked ? `Try again in ${lockTimer}s` : authLoading ? "Logging in…" : "Log in"}</AuthButton>
              <AuthButton kind="text" onClick={() => { setLoginError(""); setStep("welcome"); }}>New to KROFT? <span style={{ color:LIGHT.accent, marginLeft:4 }}>Create an account</span></AuthButton>
            </>}>
            {locked && <AuthAlert title="Too many attempts" style={{ marginTop:0, marginBottom:18 }}>For your security, log in is paused. Try again in {lockTimer} seconds.</AuthAlert>}
            <div style={{ display:"flex", flexDirection:"column", gap:18, opacity:locked ? .5 : 1, pointerEvents:locked ? "none" : "auto" }}>
              <AuthInput label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={loginEmail} invalid={!!loginError && !locked}
                onChange={e => { setLoginEmail(e.target.value); setLoginError(""); }} onKeyDown={e => e.key === "Enter" && document.getElementById("lpw")?.focus()} />
              <AuthInput id="lpw" label="Password" type={showLoginPw ? "text" : "password"} autoComplete="current-password" placeholder="Your password" value={loginPw} invalid={!!loginError && !locked}
                labelAction={<AuthLink style={{ padding:0, fontSize:14 }} onClick={() => { if (!isSupabaseConfigured) { toast("Sign in with a real account to reset your password."); return; } setForgotEmail(loginEmail); setForgotError(""); setForgotOpen(true); }}>Forgot password?</AuthLink>}
                right={<AuthLink style={{ color:LIGHT.soft }} aria-label={showLoginPw ? "Hide password" : "Show password"} onClick={() => setShowLoginPw(v => !v)}>{showLoginPw ? "Hide" : "Show"}</AuthLink>}
                onChange={e => { setLoginPw(e.target.value); setLoginError(""); }} onKeyDown={e => e.key === "Enter" && doLogin()} />
            </div>
            {loginError && !locked && <AuthAlert>{loginError}{loginAttempts > 0 && <span style={{ color:LIGHT.muted }}> {5 - loginAttempts} attempt{5 - loginAttempts !== 1 ? "s" : ""} left.</span>}</AuthAlert>}
            {biometricOn && !isNativeApp && (
              <AuthButton kind="secondary" style={{ marginTop:18 }} loading={fpLoading} disabled={fpSuccess || locked} onClick={doFingerprint}>
                {fpLoading ? "Verifying…" : fpSuccess ? "Verified" : "Log in with Face ID or fingerprint"}
              </AuthButton>
            )}
            <AuthDivider />
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <AuthButton kind="secondary" loading={googleLoading} onClick={signInWithGoogle}>{!googleLoading && <GoogleG size={22} />}Continue with Google</AuthButton>
              <AuthButton kind="secondary" onClick={openPhoneSignIn}><PhoneGlyph color={LIGHT.text} />Continue with phone number</AuthButton>
            </div>
          </AuthScreen>
        )
      )}

      {step === "reset-password" && (
        <AuthScreen title="Set a new password" subtitle="Choose a password you haven't used for KROFT before."
          footer={<AuthButton loading={resetPwLoading} onClick={doResetPassword}>{resetPwLoading ? "Updating…" : "Update password"}</AuthButton>}>
          <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
            <AuthInput label="New password" type="password" autoComplete="new-password" autoFocus placeholder="At least 8 characters" value={newPw}
              onChange={e => { setNewPw(e.target.value); setResetPwError(""); }} />
            <AuthInput label="Confirm new password" type="password" autoComplete="new-password" placeholder="Type it again" value={confirmNewPw}
              onChange={e => { setConfirmNewPw(e.target.value); setResetPwError(""); }} onKeyDown={e => e.key === "Enter" && doResetPassword()} />
          </div>
          {resetPwError && <AuthAlert>{resetPwError}</AuthAlert>}
        </AuthScreen>
      )}

      {step === "signup" && (
        <AuthScreen onBack={() => { setSignupError(""); setStep("welcome"); }} title="Create your account" subtitle="Sign up with your email. It takes less than a minute."
          footer={<>
            <AuthButton loading={authLoading} onClick={doSignup}>{authLoading ? "Creating your account…" : "Create account"}</AuthButton>
            <AuthButton kind="text" onClick={() => { setSignupError(""); setStep("login"); }}>Already have an account? <span style={{ color:LIGHT.accent, marginLeft:4 }}>Log in</span></AuthButton>
          </>}>
          <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
            <AuthInput label="Full name" autoComplete="name" autoFocus placeholder="John Carter" value={user.name || ""}
              onChange={e => { setUser(u => ({ ...u, name:e.target.value })); setSignupError(""); }} />
            <AuthInput label="Email" type="email" autoComplete="email" placeholder="john@example.com" value={user.email || ""}
              onChange={e => { setUser(u => ({ ...u, email:e.target.value })); setSignupError(""); }} />
            <div>
              {/* One password field with Show, instead of typing it twice: the confirm value is kept
                  in step with it so doSignup's checks still hold. */}
              <AuthInput label="Password" type={showSignupPw ? "text" : "password"} autoComplete="new-password" placeholder="Create a strong password" value={signupPw}
                labelAction={<AuthLink style={{ padding:0 }} onClick={() => { const p = generatePassword(); setSignupPw(p); setConfirmPw(p); setShowSignupPw(true); setSignupError(""); toast("Strong password suggested. Save it somewhere safe."); }}>Suggest one</AuthLink>}
                right={<AuthLink style={{ color:LIGHT.soft }} aria-label={showSignupPw ? "Hide password" : "Show password"} onClick={() => setShowSignupPw(v => !v)}>{showSignupPw ? "Hide" : "Show"}</AuthLink>}
                onChange={e => { setSignupPw(e.target.value); setConfirmPw(e.target.value); setSignupError(""); }} onKeyDown={e => e.key === "Enter" && doSignup()} />
              {pw.length > 0 && (() => {
                const level = pwScore >= 5 ? { label:"Strong", color:LIGHT.positive } : pwScore >= 3 ? { label:"Good", color:LIGHT.accent } : { label:"Too weak", color:LIGHT.negative };
                const missing = [!pwChecks.length && "8+ characters", !pwChecks.upper && "a capital letter", !pwChecks.lower && "a lowercase letter", !pwChecks.number && "a number", !pwChecks.special && "a symbol"].filter(Boolean);
                return (
                  <div style={{ marginTop:10 }} aria-live="polite">
                    <div style={{ display:"flex", gap:5 }}>{[1,2,3,4,5].map(i => <div key={i} style={{ flex:1, height:4, borderRadius:99, background:i <= pwScore ? level.color : LIGHT.cardB, transition:"background .25s" }} />)}</div>
                    <div style={{ fontSize:13.5, marginTop:7, color:LIGHT.muted, lineHeight:1.45 }}>
                      <span style={{ color:level.color, fontWeight:600 }}>{level.label}.</span>{missing.length > 0 && ` Add ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`}
                    </div>
                  </div>
                );
              })()}
            </div>
            <AuthInput label="Phone number (optional)" type="tel" inputMode="tel" autoComplete="tel" placeholder="+234 801 234 5678" value={user.phone || ""}
              onChange={e => setUser(u => ({ ...u, phone:e.target.value }))} />
          </div>
          {signupError && <AuthAlert>{signupError}</AuthAlert>}
        </AuthScreen>
      )}

      {step === "photo" && (
        <AuthScreen step="photo" title="Add a profile photo" subtitle="Help KROFT feel like yours. You can change it any time."
          footer={!cameraMode && <AuthButton onClick={() => setStep("business")}>{user.photo ? "Continue" : "Skip for now"}</AuthButton>}>
          <canvas ref={canvasRef} style={{ display:"none" }} />
          <input ref={galleryRef} type="file" accept="image/*" onChange={handleGalleryPick} style={{ display:"none" }} />
          {cameraMode ? (
            <div>
              {/* The viewfinder stays dark in any theme: that's how a camera preview reads. */}
              <div style={{ position:"relative", borderRadius:24, overflow:"hidden", background:"#000", aspectRatio:"1/1" }}>
                <video ref={videoRef} autoPlay playsInline muted style={{ width:"100%", height:"100%", objectFit:"cover", display:"block", transform:"scaleX(-1)" }} />
                <div style={{ position:"absolute", inset:"12%", borderRadius:"50%", boxShadow:"0 0 0 999px rgba(0,0,0,.35)", border:"2px solid rgba(255,255,255,.7)", pointerEvents:"none" }} />
                {!cameraReady && <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", gap:12, alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,.75)", color:"#dcd8d0", fontSize:15 }}><Spinner size={28} color="#ffffff" thickness={2} />Starting camera…</div>}
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:22 }}>
                <AuthLink style={{ color:LIGHT.soft, fontSize:16, minWidth:72, textAlign:"left" }} onClick={closeCamera}>Cancel</AuthLink>
                <button onClick={snapPhoto} disabled={!cameraReady} aria-label="Take photo"
                  style={{ width:76, height:76, borderRadius:"50%", background:LIGHT.card, border:`5px solid ${cameraReady ? LIGHT.accent : LIGHT.cardB}`, cursor:cameraReady ? "pointer" : "not-allowed", boxShadow:"0 6px 18px rgba(0,0,0,.12)" }} />
                <AuthLink style={{ color:LIGHT.soft, fontSize:16, minWidth:72, textAlign:"right" }} onClick={() => { closeCamera(); galleryRef.current?.click(); }}>Library</AuthLink>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display:"flex", justifyContent:"center", margin:"8px 0 30px" }}>
                <button onClick={() => galleryRef.current?.click()} aria-label={user.photo ? "Change photo" : "Choose a photo"}
                  style={{ position:"relative", width:148, height:148, borderRadius:"50%", border:user.photo ? "none" : `2px dashed ${LIGHT.border}`, cursor:"pointer", padding:0,
                    background:user.photo ? `url(${user.photo}) center/cover no-repeat` : LIGHT.card, display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:46, fontWeight:700, color:LIGHT.muted, fontFamily:APP_FONT, letterSpacing:-1 }}>
                  {!user.photo && (initials !== "?" ? initials : "")}
                  <span style={{ position:"absolute", right:4, bottom:4, width:44, height:44, borderRadius:"50%", background:LIGHT.accent, border:`4px solid ${LIGHT.bg}`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                    <NavIcon id={user.photo ? "edit" : "camera"} size={18} color="#fff" />
                  </span>
                </button>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <AuthButton kind="secondary" onClick={() => galleryRef.current?.click()}><NavIcon id="image" size={20} color={LIGHT.text} />Choose from library</AuthButton>
                <AuthButton kind="secondary" onClick={openCamera}><NavIcon id="camera" size={20} color={LIGHT.text} />Take a photo</AuthButton>
                {user.photo && <AuthButton kind="text" style={{ color:LIGHT.negative }} onClick={() => { setUser(u => ({ ...u, photo:null })); }}>Remove photo</AuthButton>}
              </div>
              {cameraError && <AuthAlert>{cameraError}</AuthAlert>}
              {!user.photo && !cameraError && <p style={{ textAlign:"center", fontSize:14, color:LIGHT.muted, lineHeight:1.5, margin:"20px 0 0" }}>No photo? KROFT will use your initials instead.</p>}
            </>
          )}
        </AuthScreen>
      )}

      {step === "business" && (
        <AuthScreen pal={obc} step={editingFromProfile ? null : "business"}
          onBack={editingFromProfile ? () => setStep("dashboard") : () => setStep("photo")} backLabel={editingFromProfile ? "Cancel" : "Back"}
          title={editingFromProfile ? "Business details" : "Tell us about your work"}
          subtitle={editingFromProfile ? "Used for your finance dashboard and reports." : "KROFT uses this to set up your money tools. Not a business? Just pick your currency."}
          footer={editingFromProfile
            ? <AuthButton pal={obc} onClick={() => { saveProfileNow().catch(() => {}); setStep("dashboard"); toast("Business details saved."); }}>Save</AuthButton>
            : <AuthButton onClick={() => setStep("prefs")}>Continue</AuthButton>}>
          <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
            <AuthInput pal={obc} label="Business name (optional)" autoComplete="organization" placeholder="e.g. Carter Consulting" value={user.businessName || ""}
              onChange={e => setUser(u => ({ ...u, businessName:e.target.value }))} />
            <AuthSelect pal={obc} label="What kind of work?" value={user.businessType || ""} onChange={e => setUser(u => ({ ...u, businessType:e.target.value }))}>
              <option value="">Choose one…</option>
              {["Personal use","Freelancer","Consultant","Agency","Retail","Restaurant","Tech Startup","Healthcare","Real Estate","E-commerce","Other"].map(t => <option key={t}>{t}</option>)}
            </AuthSelect>
            <div>
              <AuthSelect pal={obc} label="Currency" value={Object.values(CURRENCY_GROUPS).some(g => g.includes(user.currency)) ? user.currency : ""}
                onChange={e => { if (e.target.value) { setUser(u => ({ ...u, currency:e.target.value })); setCustomCurrency(""); setCustomCurrencyError(""); } }}>
                <option value="" disabled>{`Custom: ${user.currency}`}</option>
                {Object.entries(CURRENCY_GROUPS).map(([region, codes]) => (
                  <optgroup key={region} label={region}>
                    {codes.map(c => <option key={c} value={c}>{c} — {fmtCur(0, c).replace(/0\.00/, "").trim() || c}</option>)}
                  </optgroup>
                ))}
              </AuthSelect>
              <div style={{ fontSize:13.5, color:obc.muted, marginTop:7 }}>Amounts will look like <b style={{ color:obc.text, fontWeight:600 }}>{fmtCur(1000, user.currency)}</b></div>
              {/* Changing currency converts nothing: entries keep the currency they were recorded in. */}
              {(income.length > 0 || expenses.length > 0) && (
                <AuthAlert pal={obc} tone="info" style={{ marginTop:12 }}>Changing this affects new entries only. Existing amounts keep the currency they were entered in.</AuthAlert>
              )}
            </div>
            <details style={{ fontSize:14.5, color:obc.soft }}>
              <summary style={{ cursor:"pointer", fontWeight:600, color:obc.accent, padding:"4px 0" }}>Don't see your currency?</summary>
              <div style={{ display:"flex", gap:10, marginTop:12, alignItems:"flex-start" }}>
                <div style={{ flex:1 }}>
                  <AuthInput pal={obc} aria-label="Currency code" placeholder="Code, e.g. ISK" value={customCurrency} maxLength={3} invalid={!!customCurrencyError}
                    onChange={e => { setCustomCurrency(e.target.value.toUpperCase()); setCustomCurrencyError(""); }} />
                </div>
                <AuthButton pal={obc} kind="secondary" style={{ width:"auto", paddingInline:22 }} onClick={() => {
                  if (!isValidCurrencyCode(customCurrency)) { setCustomCurrencyError("That isn't a recognised currency code."); return; }
                  setUser(u => ({ ...u, currency:customCurrency.toUpperCase() })); setCustomCurrencyError("");
                }}>Use</AuthButton>
              </div>
              {customCurrencyError && <AuthAlert pal={obc} style={{ marginTop:10 }}>{customCurrencyError}</AuthAlert>}
            </details>
          </div>
        </AuthScreen>
      )}

      {step === "prefs" && (() => {
        // One row per provider: a Google grant covers Gmail and Google Calendar together, and a
        // Microsoft grant covers Outlook mail and calendar (see api/google/start.js and
        // api/microsoft/start.js), so linking per service would be misleading.
        const providers = [
          { k:"google", n:"Google", d:"Gmail and Google Calendar", logo:<GoogleG size={24} />, linked:googleStatus.gmail || googleStatus.calendar, linking:googleLinking, connect:connectGoogle, disconnect:disconnectGoogle },
          { k:"microsoft", n:"Microsoft", d:"Outlook mail and calendar", logo:<MicrosoftLogo size={22} />, linked:microsoftStatus.mail || microsoftStatus.calendar, linking:microsoftLinking, connect:connectMicrosoft, disconnect:disconnectMicrosoft },
        ];
        const anyLinked = providers.some(p => p.linked);
        return (
          <AuthScreen step="prefs" onBack={() => setStep("business")} title="Connect your email and calendar"
            subtitle="KROFT can read and draft email and keep your schedule in sync. Nothing is sent without you confirming."
            footer={<AuthButton onClick={() => setStep("done")}>{anyLinked ? "Continue" : "Skip for now"}</AuthButton>}>
            <div style={{ background:LIGHT.card, border:`1px solid ${LIGHT.cardB}`, borderRadius:20, overflow:"hidden" }}>
              {providers.map((a, i) => (
                <div key={a.k} style={{ display:"flex", alignItems:"center", gap:14, padding:"16px 16px", borderBottom:i < providers.length - 1 ? `1px solid ${LIGHT.div}` : "none" }}>
                  <div style={{ width:44, height:44, borderRadius:12, border:`1px solid ${LIGHT.cardB}`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{a.logo}</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:16, fontWeight:600, color:LIGHT.text }}>{a.n}</div>
                    <div style={{ fontSize:13.5, color:a.linked ? LIGHT.positive : LIGHT.muted, marginTop:2 }}>{a.linked ? "Connected" : a.d}</div>
                  </div>
                  <button disabled={!isSupabaseConfigured || a.linking} onClick={() => a.linked ? a.disconnect() : a.connect()}
                    style={{ height:38, padding:"0 16px", borderRadius:999, fontSize:14.5, fontWeight:600, fontFamily:APP_FONT, flexShrink:0, cursor:!isSupabaseConfigured ? "not-allowed" : "pointer",
                      border:a.linked ? `1.5px solid ${LIGHT.cardB}` : "none", background:a.linked ? "transparent" : LIGHT.text, color:a.linked ? LIGHT.soft : LIGHT.card, opacity:!isSupabaseConfigured ? .45 : 1,
                      display:"flex", alignItems:"center", gap:6 }}>
                    {a.linking ? <Spinner size={14} color={a.linked ? LIGHT.soft : LIGHT.card} thickness={2} /> : a.linked ? "Disconnect" : "Connect"}
                  </button>
                </div>
              ))}
            </div>
            <p style={{ fontSize:14, color:LIGHT.muted, lineHeight:1.5, margin:"16px 4px 0" }}>
              {isSupabaseConfigured
                ? "You can connect or disconnect these any time in Profile → Connected apps."
                : "Connecting email and calendar needs a synced account, so it isn't available in this local-only mode."}
            </p>
          </AuthScreen>
        );
      })()}

      {step === "done" && (
        <AuthScreen footer={<AuthButton onClick={() => { setStep("dashboard"); toast(`Welcome to KROFT, ${firstNameOf(user.name) || "there"}.`); }}>Start using KROFT</AuthButton>}>
          <div style={{ textAlign:"center", paddingTop:"4vh" }}>
            <div style={{ position:"relative", width:112, height:112, margin:"0 auto 26px", animation:"pop .5s ease" }}>
              <div style={{ width:"100%", height:"100%", borderRadius:"50%", overflow:"hidden", background:user.photo ? `url(${user.photo}) center/cover no-repeat` : LIGHT.card, border:`1px solid ${LIGHT.cardB}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:38, fontWeight:700, color:LIGHT.text, letterSpacing:-1 }}>
                {!user.photo && initials}
              </div>
              <span style={{ position:"absolute", right:0, bottom:2, width:38, height:38, borderRadius:"50%", background:LIGHT.positive, border:`4px solid ${LIGHT.bg}`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
            </div>
            <h1 style={{ fontSize:"clamp(27px, 7.6vw, 32px)", fontWeight:700, color:LIGHT.text, letterSpacing:-.9, lineHeight:1.15, margin:0 }}>You're all set, {firstNameOf(user.name) || "friend"}</h1>
            <p style={{ fontSize:16, lineHeight:1.5, color:LIGHT.muted, margin:"10px auto 30px", maxWidth:340 }}>Your KROFT account is ready. Ask it anything about your money, schedule or day.</p>
          </div>
          <div style={{ background:LIGHT.card, border:`1px solid ${LIGHT.cardB}`, borderRadius:20, overflow:"hidden" }}>
            {[
              { k:"Name", v:user.name },
              { k:user.email ? "Email" : "Phone", v:user.email || user.phone || "—" },
              { k:"Business", v:user.businessName || user.businessType || "Personal" },
              { k:"Currency", v:user.currency },
              { k:"Connected", v:(() => { const n = Object.values(user.connected).filter(Boolean).length; return n ? `${n} app${n === 1 ? "" : "s"}` : "None yet"; })() },
            ].map((r, i, arr) => (
              <div key={r.k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:14, padding:"14px 16px", borderBottom:i < arr.length - 1 ? `1px solid ${LIGHT.div}` : "none" }}>
                <span style={{ fontSize:15, color:LIGHT.muted, flexShrink:0 }}>{r.k}</span>
                <span style={{ fontSize:15, fontWeight:600, color:LIGHT.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.v}</span>
              </div>
            ))}
          </div>
        </AuthScreen>
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
    <div key={themeTick} style={{ fontFamily:APP_FONT, background:C.bg, minHeight:"100vh", color:C.text, overflowX:"hidden", maxWidth:"100vw", touchAction:"pan-y" }}>
      <style>{G}</style>
      {showBriefing && <Briefing user={user} income={totalIncome} expenses={totalExpenses} emails={emails} appts={todaysAppts} onClose={() => setShowBriefing(false)} />}
      {showChatHistory && (() => {
        const terms = searchTerms(chatHistorySearch);
        const searching = terms.length > 0;
        const closeHistory = () => { setShowChatHistory(false); setChatHistorySearch(""); };
        // The active conversation isn't in chatHistory (it lives in aiMessages), but people search
        // it too, so it's included as "Current chat".
        const currentHasContent = aiMessages.some(m => m.role === "user");
        const all = [
          ...(currentHasContent ? [{ id:"current", title:deriveChatTitle(aiMessages), messages:aiMessages, updatedAt:Date.now(), current:true }] : []),
          ...chatHistory,
        ];
        const results = searching
          ? all.map(c => { const hit = findChatMatch(c.title, c.messages, terms); return hit && { ...c, hit }; }).filter(Boolean)
          : chatHistory;
        const groups = [];
        if (searching) groups.push({ label: `${results.length} result${results.length === 1 ? "" : "s"}`, items: results });
        else results.forEach(c => { const g = chatHistoryGroup(c.updatedAt); const last = groups[groups.length - 1]; if (last?.label === g) last.items.push(c); else groups.push({ label:g, items:[c] }); });
        const open = c => {
          if (c.current) { closeHistory(); jumpToMessage(aiMessages, c.hit?.msgIndex ?? null); }
          else openHistoryChat(c.id, c.hit?.msgIndex ?? null);
        };
        return (
          <div role="dialog" aria-modal="true" aria-label="Chat history" style={{ position:"fixed", inset:0, zIndex:310, background:C.bg, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
              <button onClick={closeHistory} aria-label="Close chat history" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1 }}>←</button>
              <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, flex:1 }}>Chat history</h2>
              <Btn sm onClick={() => { startNewChat(); closeHistory(); }}>New chat</Btn>
            </div>
            <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:"14px 16px 24px" }}>
              {all.length > 0 && (
                <div role="search" style={{ position:"relative", marginBottom:18 }}>
                  <span style={{ position:"absolute", left:13, top:"50%", transform:"translateY(-50%)", display:"flex", pointerEvents:"none" }}><NavIcon id="search" size={18} color={C.muted} /></span>
                  <input autoFocus type="text" inputMode="search" enterKeyHint="search" aria-label="Search conversations" placeholder="Search your chats"
                    value={chatHistorySearch} onChange={e => setChatHistorySearch(e.target.value)}
                    onKeyDown={e => { if (e.key === "Escape" && chatHistorySearch) { e.stopPropagation(); setChatHistorySearch(""); } }}
                    style={{ width:"100%", height:46, boxSizing:"border-box", borderRadius:999, border:`1px solid ${C.cardB}`, background:C.card, color:C.text, fontSize:15, fontFamily:APP_FONT, padding:"0 42px 0 40px", outline:"none", WebkitAppearance:"none", appearance:"none" }} />
                  {chatHistorySearch && (
                    <button onClick={() => setChatHistorySearch("")} aria-label="Clear search"
                      style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", width:30, height:30, borderRadius:"50%", border:"none", background:C.surface, color:C.muted, fontSize:14, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                  )}
                </div>
              )}
              {all.length === 0 || (!searching && chatHistory.length === 0) ? (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No past conversations yet</div>
                  <Mono style={{ display:"block", color:C.soft }}>Starting a new chat saves the one you're leaving here.</Mono>
                </Card>
              ) : searching && results.length === 0 ? (
                <div style={{ textAlign:"center", padding:"36px 20px" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.text, marginBottom:6 }}>No chats found</div>
                  <div style={{ fontSize:14, color:C.muted, lineHeight:1.5 }}>Nothing matches "{chatHistorySearch.trim()}". Try fewer or different words.</div>
                </div>
              ) : groups.map(g => (
                <div key={g.label} style={{ marginBottom:20 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:C.muted, margin:"0 4px 8px" }}>{g.label}</div>
                  <div style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:20, overflow:"hidden" }}>
                    {g.items.map((c, i) => (
                      <div key={c.id} role="button" tabIndex={0} className="row" onClick={() => open(c)}
                        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(c); } }}
                        {...(c.current ? {} : longPress(() => setActionSheet(holdActions({
                          title: c.title,
                          subtitle: `${c.messages.length} messages · ${chatHistoryWhen(c.updatedAt)}`,
                          list: chatHistory, setList: setChatHistory, id: c.id,
                          deletedLabel: "Conversation deleted.",
                          confirmText: "This removes the conversation from your history.",
                        }))))}
                        style={{ padding:"13px 16px", cursor:"pointer", borderBottom: i === g.items.length - 1 ? "none" : `1px solid ${C.div}`, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                        <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
                          <div style={{ flex:1, minWidth:0, fontSize:15, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            <Highlight text={c.title} terms={terms} />
                          </div>
                          <span style={{ fontSize:12.5, color:C.muted, flexShrink:0 }}>{c.current ? "Current chat"
                            // Under a Today/Yesterday heading the day is already said, so show the time.
                            : !searching && ["Today", "Yesterday"].includes(chatHistoryGroup(c.updatedAt))
                              ? new Date(c.updatedAt).toLocaleTimeString([], { hour:"numeric", minute:"2-digit" })
                              : chatHistoryWhen(c.updatedAt)}</span>
                        </div>
                        {c.hit?.snippet ? (
                          <div style={{ fontSize:13.5, color:C.soft, lineHeight:1.45, marginTop:4, display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", overflow:"hidden" }}>
                            <span style={{ color:C.muted }}>{c.hit.role === "user" ? "You: " : "KROFT: "}</span>
                            <Highlight text={c.hit.snippet} terms={terms} />
                          </div>
                        ) : (
                          <div style={{ fontSize:13, color:C.muted, marginTop:3 }}>
                            {(() => { const n = c.messages.filter(m => m.role === "user").length; return `${n} message${n === 1 ? "" : "s"} you sent`; })()}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
      {showInvoices && (
        <InvoicesScreen invoices={invoices} setInvoices={setInvoices} quotes={quotes} setQuotes={setQuotes} settings={invoiceSettings} setSettings={setInvoiceSettings}
          user={user} subscribed={subscribed} contacts={contacts} setContacts={setContacts} toast={toast} onClose={() => setShowInvoices(false)}
          onRecordIncome={inv => {
            // Getting paid is income: recorded the same way as one added by hand.
            const item = { id:uid(), label:`${inv.number} · ${inv.client.name}`, amount:invoiceTotals(inv).total, cat: incomeCats.includes("Invoice") ? "Invoice" : incomeCats[0], date:todayISO(), cur:inv.currency, invoiceId:inv.id };
            setIncome(p => [...p, item]);
            return item.id;
          }}
          onRemoveIncome={id => setIncome(p => p.filter(x => x.id !== id))} />
      )}
      {showEntryHistory && (() => {
        const q = entryHistoryQuery.trim().toLowerCase();
        const filtered = q ? allEntries.filter(e => `${e.label} ${e.cat}`.toLowerCase().includes(q)) : allEntries;
        return (
          <div role="dialog" aria-modal="true" aria-label="Entry history" style={{ position:"fixed", inset:0, zIndex:310, background:C.bg, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
              <button onClick={() => { setShowEntryHistory(false); setEntryHistoryQuery(""); }} aria-label="Close entry history" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1 }}>←</button>
              <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, flex:1 }}>Entry history</h2>
            </div>
            <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16 }}>
              {allEntries.length > 0 && (
                <Inp placeholder="Search description or category…" value={entryHistoryQuery} onChange={e=>setEntryHistoryQuery(e.target.value)} style={{ marginBottom:16, width:"100%", boxSizing:"border-box" }} />
              )}
              {allEntries.length === 0 ? (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <div style={{ fontSize:15, fontWeight:600, color:C.white, marginBottom:6 }}>No entries yet</div>
                  <Mono style={{ display:"block", color:C.soft }}>Every income and expense you add shows up here, newest first.</Mono>
                </Card>
              ) : filtered.length === 0 ? (
                <Card level="inset" style={{ textAlign:"center", padding:26, borderStyle:"dashed" }}>
                  <Mono style={{ color:C.soft }}>Nothing matches "{entryHistoryQuery}".</Mono>
                </Card>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                  {filtered.map(e => {
                    // Entry History is the only place left to browse past entries (the Finance
                    // tab's own inline Income/Expenses lists were removed as redundant with this
                    // screen), so it needs the same edit/delete this list used to be the only way
                    // to reach — otherwise removing that list would have quietly taken those
                    // actions away entirely rather than just consolidating where they live.
                    const set = e.kind==="income" ? setIncome : setExpenses;
                    const cats = e.kind==="income" ? incomeCats : expenseCats;
                    const setCats = e.kind==="income" ? setIncomeCats : setExpenseCats;
                    const sign = e.kind==="income" ? "+" : "-";
                    if (editingEntry && editingEntry.kind===e.kind && editingEntry.id===e.id) {
                      return (
                        <div key={`${e.kind}-${e.id}`} style={{ background:C.surface, border:`1px solid ${C.soft}`, borderRadius:12, padding:"10px 11px" }}>
                          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                            <Inp placeholder="Description" value={editingEntry.label} onChange={ev => setEditingEntry(v=>({...v,label:ev.target.value}))} style={{ padding:"8px 10px", fontSize:12 }} />
                            <div style={{ display:"flex", gap:7 }}>
                              <Inp placeholder="Amount" type="number" inputMode="decimal" min="0" step="0.01" value={editingEntry.amount} onChange={ev => setEditingEntry(v=>({...v,amount:ev.target.value}))} style={{ padding:"8px 10px", fontSize:12, flex:1 }} />
                              <input type="date" value={editingEntry.date} max={todayISO()} onChange={ev => setEditingEntry(v=>({...v,date:ev.target.value}))} style={{ flex:1, background:C.card, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"8px 9px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                            </div>
                            <CategorySelect value={editingEntry.cat} onChange={c => setEditingEntry(v=>({...v,cat:c}))} cats={cats} onAddCategory={c => setCats(p=>p.includes(c)?p:[...p,c])} style={{ padding:"8px 9px", fontSize:11 }} />
                            <div style={{ display:"flex", gap:7 }}>
                              <Btn sm v="outline" onClick={() => setEditingEntry(null)} style={{ flex:1 }}>Cancel</Btn>
                              <Btn sm onClick={() => {
                                if (!editingEntry.label) return;
                                const amt = parseAmount(editingEntry.amount);
                                if (amt === null) { toast("Enter an amount greater than zero."); return; }
                                set(p=>p.map(x=>x.id===e.id?{...x,label:editingEntry.label,amount:amt,date:editingEntry.date||todayISO(),cat:editingEntry.cat}:x));
                                setEditingEntry(null); toast("Entry updated.");
                              }} style={{ flex:1 }}>Save</Btn>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={`${e.kind}-${e.id}`} className="row" {...longPress(() => setActionSheet(holdActions({
                          title: e.label,
                          subtitle: `${sign}${fmtCur(e.amount,user.currency)} · ${e.cat} · ${fmtDate(e.date)}`,
                          onEdit: () => setEditingEntry({ kind:e.kind, id:e.id, label:e.label, amount:String(e.amount), date:e.date||todayISO(), cat:e.cat }),
                          list: e.kind==="income" ? income : expenses, setList: set, id: e.id,
                          deletedLabel: "Entry deleted.",
                          confirmText: "Removing this entry changes your totals and monthly report.",
                        })))} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 11px", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
                          <div style={{ minWidth:0, flex:1, cursor:"pointer" }} onClick={() => setEditingEntry({ kind:e.kind, id:e.id, label:e.label, amount:String(e.amount), date:e.date||todayISO(), cat:e.cat })}>
                            <Mono style={{ color:C.soft, fontSize:9, letterSpacing:.5, display:"block", marginBottom:3 }}>{fmtDate(e.date)}</Mono>
                            <div style={{ fontSize:13, fontWeight:600, color:C.white, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.label}</div>
                            <div style={{ marginTop:4, display:"flex", gap:5, flexWrap:"wrap" }}>
                              <Tag>{e.cat}</Tag>
                              {e.repeat && e.repeat !== "none" && <Tag tone="accent">Repeats {e.repeat}</Tag>}
                              {e.fromRecurring && <Tag>Auto</Tag>}
                            </div>
                          </div>
                          <Mono style={{ color:e.kind==="income"?C.positive:C.negative, fontSize:13, fontWeight:700, flexShrink:0 }}>
                            {sign}{fmtCur(e.amount, e.cur || user.currency)}
                          </Mono>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}
      {showBudgetEditor && (
        <div role="dialog" aria-modal="true" aria-label="Monthly budgets" style={{ position:"fixed", inset:0, zIndex:310, background:C.bg, display:"flex", flexDirection:"column" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderBottom:`1px solid ${C.cardB}`, flexShrink:0 }}>
            <button onClick={() => setShowBudgetEditor(false)} aria-label="Close monthly budgets" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", fontSize:20, padding:"2px 4px", lineHeight:1 }}>←</button>
            <h2 style={{ fontSize:17, fontWeight:700, color:C.white, letterSpacing:-.5, flex:1 }}>Monthly budgets</h2>
          </div>
          <div style={{ flex:1, minHeight:0, overflowY:"auto", padding:16 }}>
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
          </div>
        </div>
      )}
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
      {voiceOpen && !voiceMinimized && (
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
          onOpenSettings={() => setShowVoiceSettings(true)}
          subtitles={voiceSubtitles}
          subscribed={subscribed}
          turnsLeft={voiceTurnsLeft()}
        />
      )}
      {voiceOpen && voiceMinimized && (
        <MinimizedVoiceBar state={voiceState} levelRef={voiceLevelRef} onExpand={() => setVoiceMinimized(false)} onStop={endVoiceFully} />
      )}
      {showVoiceSettings && (
        <VoiceSettingsScreen
          voicePref={voicePref}
          onSetVoicePref={setVoicePref}
          voiceSpeed={voiceSpeed}
          onSetVoiceSpeed={setVoiceSpeed}
          subtitles={voiceSubtitles}
          onSetSubtitles={setVoiceSubtitles}
          backgroundMode={voiceBackgroundMode}
          onSetBackgroundMode={setVoiceBackgroundMode}
          onClose={() => setShowVoiceSettings(false)}
        />
      )}
      {actionSheet && <ActionSheet {...actionSheet} onClose={() => setActionSheet(null)} />}
      {copyPopup && (
        <>
          <div onClick={() => setCopyPopup(null)} style={{ position:"fixed", inset:0, zIndex:960 }} />
          {/* Copy, and Edit for the person's own message (not while KROFT is still replying). */}
          <div role="menu" style={{
              position:"fixed", zIndex:961,
              left: Math.min(Math.max(copyPopup.x - 90, 12), window.innerWidth - 192),
              top: Math.max(copyPopup.y - 60, 12),
              display:"flex", gap:4, padding:4, background:C.card, border:`1px solid ${C.cardB}`,
              borderRadius:14, boxShadow:C.shadowRaised, animation:"pop .15s ease",
            }}>
            {[
              { id:"copy", label:"Copy", run:() => copyMsg(copyPopup.content, { markdown:false }) },
              ...(copyPopup.idx != null && !aiLoading ? [{ id:"edit", label:"Edit", run:() => setEditingMsg(copyPopup.idx) }] : []),
            ].map(a => (
              <button key={a.id} role="menuitem" onClick={() => { setCopyPopup(null); a.run(); }}
                style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", borderRadius:10, padding:"9px 14px", cursor:"pointer", color:C.text, fontSize:13.5, fontWeight:600, fontFamily:APP_FONT }}>
                <NavIcon id={a.id} size={15} color={C.text} />
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
      {activeReset && <QuickResetModal session={activeReset} onCancel={cancelQuickReset} />}
      {patternDetail && <PatternDetailModal pattern={patternDetail} onClose={() => setPatternDetail(null)} />}
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

      {toastStack}
      {offlineBanner}
      {appLockOverlay}

      {showConfetti && <Confetti onDone={() => setShowConfetti(false)} />}

      {tab!=="workspace" && (
      <header style={{ borderBottom:`1px solid ${C.cardB}`, padding:"11px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", background:C.bg, position:"sticky", top:0, zIndex:200, backdropFilter:"blur(14px)", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:9, minWidth:0, flexShrink:1 }}>
          <div style={{ width:30, height:30, borderRadius:8, background:C.white, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:900, color:C.black, flexShrink:0, boxShadow:`0 0 14px ${C.accent}40` }}>K</div>
          <div style={{ minWidth:0, overflow:"hidden" }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.white, letterSpacing:-.4, whiteSpace:"nowrap" }}>KROFT</div>
            <Mono style={{ fontSize:8, color:C.muted, letterSpacing:.8, whiteSpace:"nowrap", display:"block", overflow:"hidden", textOverflow:"ellipsis" }}>by Orynthra</Mono>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <button onClick={() => setTab("nova")} className="hbtn" style={{ background:tab==="nova"?C.accent:C.surface, border:`1px solid ${tab==="nova"?C.accent:C.border}`, borderRadius:20, padding:"7px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:6, color:tab==="nova"?"#fff":C.white, fontSize:12, fontWeight:700, whiteSpace:"nowrap", flexShrink:0, boxShadow:tab==="nova"?`0 0 16px ${C.accent}66`:`0 0 0 1px ${C.fill}` }}>
            <NavIcon id="nova" size={13} color={tab==="nova"?"#fff":C.white} />
            Ask Kroft
          </button>
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
                <NavIcon id={thisMonthNet.net>=0?"trendUp":"trendDown"} size={16} color={thisMonthNet.net>=0?C.positive:C.negative} />
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:16, fontWeight:700, color:C.card, letterSpacing:-.5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fmtCur(thisMonthNet.net,user.currency)}</div>
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
                <Suspense fallback={<div style={{ height:190, display:"flex", alignItems:"center", justifyContent:"center" }}><Spinner size={16} color={C.muted} /></div>}>
                  <MonthlyTrendChart data={monthlyTrend} c={C} currency={user.currency} />
                </Suspense>
              </Card>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:13 }}>
              <Card>
                <Mono style={{ display:"block", color:C.muted, marginBottom:10, letterSpacing:.8 }}>Mood detection</Mono>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, justifyItems:"center" }}>
                  {Object.keys(MOOD_META).map(m => (
                    <MoodOrb key={m} mood={m} label={MOOD_META[m].label} active={mood===m} onClick={() => applyMood(m)} />
                  ))}
                </div>
              </Card>
              <Card>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Next appointment</Mono>
                {upcomingAppts.length>0 ? (
                  <>
                    <div style={{ fontWeight:700, fontSize:14, color:C.white, marginBottom:4 }}>{upcomingAppts[0].title}</div>
                    <Mono style={{ display:"block", color:C.soft, marginBottom:2 }}>{upcomingAppts[0].time} · {fmtDate(upcomingAppts[0].date)||upcomingAppts[0].date}</Mono>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:13 }}>{upcomingAppts[0].location}</Mono>
                    {/* Remind and Uber's natural widths don't reliably both fit on one line at
                        default button padding on a narrow phone — flexWrap:"wrap" let Uber drop
                        to its own line. A 2-column grid always keeps them side by side, but
                        `1fr 1fr` tracks default to `minmax(auto, 1fr)` — each column's floor is
                        its content's own min-content width, so "Remind" (wider text) got a taller
                        floor than "Uber" and the split matched their content widths instead of
                        being equal. minWidth:0 on each button removes that floor so the two
                        columns are genuinely, always equal. The contact tag (if any) goes on its
                        own line below rather than competing for space in that same row. */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
                      <Btn sm onClick={() => remind(upcomingAppts[0])} style={{ width:"100%", minWidth:0 }}>Remind</Btn>
                      <Btn sm v="outline" onClick={() => setUberDest(upcomingAppts[0])} style={{ width:"100%", minWidth:0 }}>Uber</Btn>
                    </div>
                    {(() => {
                      // A live status line filling the space left under the buttons — ticks on
                      // its own via forceApptTick's heartbeat subscription above, so "Starts in
                      // 42 min" counts down to 41, 40... without needing any other state to
                      // change, then flips to "In progress" and eventually "Ended · X min ago" as
                      // real time passes. upcomingAppts only filters by date, not time-of-day, so
                      // a same-day appointment can otherwise sit here for hours after it's already
                      // happened with no indication — see apptStatusLine's own comment on why
                      // "in progress"/"ended" are a heuristic, not real duration data.
                      const status = apptStatusLine(upcomingAppts[0], new Date());
                      if (!status) return null;
                      return (
                        <Mono style={{ display:"flex", alignItems:"center", gap:5, color:status.color, marginTop:8 }}>
                          {status.dot && <span style={{ width:6, height:6, borderRadius:"50%", background:status.color, flexShrink:0 }} />}
                          {status.text}
                        </Mono>
                      );
                    })()}
                    {upcomingAppts[0].contactId && contacts.find(c=>c.id===upcomingAppts[0].contactId) && (
                      <Tag tone="accent" style={{ display:"inline-block", marginTop:8, maxWidth:"100%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{contacts.find(c=>c.id===upcomingAppts[0].contactId).name}</Tag>
                    )}
                  </>
                ) : (
                  <div style={{ textAlign:"center", padding:"12px 0" }}>
                    <Mono style={{ display:"block", color:C.muted, marginBottom:12 }}>{appts.length>0 ? "No upcoming appointments." : "No appointments yet."}</Mono>
                    <Btn sm onClick={() => { setTab("workspace"); setWorkspaceSection("calendar"); }}>Add one</Btn>
                  </div>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab==="home" && homeSection==="finance" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
              <h2 style={{ fontSize:22, fontWeight:700, color:C.white, letterSpacing:-1 }}>Finance</h2>
              <button onClick={() => setShowEntryHistory(true)} aria-label="Entry history" title="Entry history" style={{ background:"none", border:"none", color:C.white, cursor:"pointer", padding:6, lineHeight:1, display:"flex" }}>
                <NavIcon id="history" size={19} color={C.white} />
              </button>
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:18 }}>
              <Btn sm onClick={() => { setShowAddInc(v=>!v); setShowAddExp(false); }}>Add Income</Btn>
              <Btn sm v="outline" onClick={() => { setShowAddExp(v=>!v); setShowAddInc(false); }}>Add Expense</Btn>
              <Btn sm v="outline" onClick={() => setShowInvoices(true)}>Invoices{(() => { const n = invoices.filter(inv => invoiceStatus(inv, todayISO()) === "overdue").length; return n ? ` · ${n} overdue` : ""; })()}</Btn>
              <Btn sm v="outline" onClick={exportFinanceCsv}>Export</Btn>
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

            {/* Grouped into named sections (Summary / Planning / Reports) instead of one
                undifferentiated stack of cards — Net profit and category breakdown lead since
                they're the headline numbers, budgeting tools follow, then the on-demand report.
                Browsing/editing individual entries lives in Entry History (the header icon)
                rather than a ledger repeated here too. */}
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
                    <Suspense fallback={<div style={{ width:140, height:140, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Spinner size={16} color={C.muted} /></div>}>
                      <CategoryPieChart data={categoryBreakdown} pieColors={pieColors} c={C} currency={user.currency} />
                    </Suspense>
                    <div style={{ flex:1, minWidth:140, display:"flex", flexDirection:"column", gap:7 }}>
                      {(showAllCategories ? categoryBreakdown : categoryBreakdown.slice(0, 6)).map((c, i) => (
                        <div key={c.cat} style={{ display:"flex", alignItems:"center", gap:7 }}>
                          <div style={{ width:8, height:8, borderRadius:99, background:pieColors[i % pieColors.length], flexShrink:0 }} />
                          <Mono style={{ color:C.text, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.cat}</Mono>
                          <Mono style={{ color:C.muted, flexShrink:0 }}>{fmtCur(c.amt, user.currency)} · {Math.round(c.pct*100)}%</Mono>
                        </div>
                      ))}
                      {categoryBreakdown.length > 6 && (
                        <button onClick={() => setShowAllCategories(v => !v)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left" }}>
                          <Mono style={{ color:C.text, textDecoration:"underline" }}>{showAllCategories ? "Show less" : `+${categoryBreakdown.length - 6} more`}</Mono>
                        </button>
                      )}
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
                    <Btn sm v="outline" onClick={() => setShowBudgetEditor(true)}>{status.length ? "Edit" : "Set budgets"}</Btn>
                  </div>

                  {status.length === 0 && (
                    <Mono style={{ display:"block", color:C.muted, lineHeight:1.6 }}>
                      No budgets set. Add one and KROFT will warn you before a category runs over, not after.
                    </Mono>
                  )}

                  {status.map(b => {
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
                  {(() => {
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
                        {(showAllUnbudgeted ? rows : rows.slice(0, 4)).map(([cat, amt]) => (
                          <div key={cat} style={{ display:"flex", justifyContent:"space-between", gap:8, padding:"3px 0" }}>
                            <Mono style={{ color:C.soft, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{cat}</Mono>
                            <Mono style={{ color:C.soft, flexShrink:0 }}>{fmtCur(amt, user.currency)}</Mono>
                          </div>
                        ))}
                        {rows.length > 4 && (
                          <button onClick={() => setShowAllUnbudgeted(v => !v)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left", marginTop:3 }}>
                            <Mono style={{ color:C.text, textDecoration:"underline" }}>{showAllUnbudgeted ? "Show less" : `+${rows.length - 4} more`}</Mono>
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {status.length > 0 && (() => {
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
                  {(showAllUpcoming ? upcomingCashFlow.items : upcomingCashFlow.items.slice(0, 6)).map(e => (
                    <div key={e.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.label}</div>
                        <Mono style={{ color:C.muted }}>{fmtDate(e.date)} · {e.cat}</Mono>
                      </div>
                      <Mono style={{ color:e.sign==="+"?C.positive:C.negative, fontWeight:700, flexShrink:0 }}>{e.sign}{fmtCur(e.amount, user.currency)}</Mono>
                    </div>
                  ))}
                  {upcomingCashFlow.items.length > 6 && (
                    <button onClick={() => setShowAllUpcoming(v => !v)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left", marginTop:2 }}>
                      <Mono style={{ color:C.text, textDecoration:"underline" }}>{showAllUpcoming ? "Show less" : `+${upcomingCashFlow.items.length - 6} more`}</Mono>
                    </button>
                  )}
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
                {/* The inline Income/Expenses lists that used to live here were removed —
                    Entry History (the icon in the header above) now covers browsing, searching,
                    editing and deleting every entry, so keeping a second, redundant copy of that
                    same list here just meant two places that could show slightly different data
                    if only one of them were touched later. */}
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
            { k:"email", l:"Email", count:emails.filter(e=>!e.read).length, sub:"unread", tone: emails.filter(e=>!e.read).length>0 ? "accent" : undefined },
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
            // A checklist note's real content lives in its items, not `body` (empty for those) —
            // search both so "milk" finds the shopping-list note it's actually in, not just notes
            // where it happens to be in the title.
            ...notes.filter(n => hit(q, n.title, n.body, (n.checklist||[]).map(i=>i.text).join(" "))).map(n => ({ id:"note"+n.id, section:"notes", kind:"Note", label:n.title || "Untitled note", detail: n.checklist ? `${n.checklist.filter(i=>i.done).length}/${n.checklist.length} items` : (n.body||"").slice(0,60) })),
            ...tasks.filter(t => hit(q, t.title)).map(t => ({ id:"task"+t.id, section:"tasks", kind:"Task", label:t.title, detail:t.done?"Done":t.priority })),
            ...appts.filter(a => hit(q, a.title, a.location, a.notes)).map(a => ({ id:"appt"+a.id, section:"calendar", kind:"Appointment", label:a.title, detail:[a.time, fmtDate(a.date)].filter(Boolean).join(", ") })),
            ...contacts.filter(c => hit(q, c.name, c.email, c.phone)).map(c => ({ id:"contact"+c.id, section:"contacts", kind:"Contact", label:c.name, detail:c.email || c.phone })),
            ...smartReminders.filter(r => hit(q, r.text)).map(r => ({ id:"rem"+r.id, section:"reminders", kind:"Reminder", label:r.text, detail:r.when })),
            ...documents.filter(d => hit(q, d.title, d.body)).map(d => ({ id:"doc"+d.id, section:"documents", kind:"Document", label:d.title || "Untitled", detail:(d.body||"").slice(0,60) })),
            // Same reasoning as notes above — a project's milestone titles are real content too.
            ...projects.filter(p => hit(q, p.name, p.description, (p.milestones||[]).map(m=>m.title).join(" "))).map(p => ({ id:"proj"+p.id, section:"projects", kind:"Project", label:p.name, detail:p.status })),
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
                  <button onClick={() => { const [y,m] = calendarMonth.split("-").map(Number); const d = new Date(y, m-2, 1); setCalendarMonth(ymdLocal(d).slice(0,7)); }} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:16, padding:4 }}>‹</button>
                  <Mono style={{ color:C.white, fontWeight:700, fontSize:12, letterSpacing:.5 }}>{monthLabel(calendarMonth+"-01")}</Mono>
                  <button onClick={() => { const [y,m] = calendarMonth.split("-").map(Number); const d = new Date(y, m, 1); setCalendarMonth(ymdLocal(d).slice(0,7)); }} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer", fontSize:16, padding:4 }}>›</button>
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
                  <div style={{ display:"flex", gap:8 }}><input type="date" value={newAppt.date||todayISO()} onChange={e=>setNewAppt(v=>({...v,date:e.target.value}))} style={{ flex:1, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} /><Inp placeholder="Location" value={newAppt.location} onChange={e=>setNewAppt(v=>({...v,location:e.target.value}))} style={{ flex:1 }} /></div>
                  <Inp placeholder="Notes (optional)" value={newAppt.notes} onChange={e=>setNewAppt(v=>({...v,notes:e.target.value}))} />
                  {(() => {
                    const conflict = findApptConflict(appts, newAppt.date||todayISO(), newAppt.time, null);
                    return conflict && (
                      <Mono style={{ color:C.warning, display:"block" }}>
                        Heads up — you already have "{conflict.title}" at this same time.
                      </Mono>
                    );
                  })()}
                  <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                    <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}><input type="checkbox" checked={newAppt.urgent} onChange={e=>setNewAppt(v=>({...v,urgent:e.target.checked}))} style={{ accentColor:C.white, width:14, height:14 }} /><Mono style={{ color:C.soft }}>Urgent</Mono></label>
                    <select value={newAppt.repeat} onChange={e=>setNewAppt(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none" }}>{["none","daily","weekly","monthly"].map(r=><option key={r}>{r}</option>)}</select>
                    {contacts.length > 0 && <ContactSelect value={newAppt.contactId} onChange={id=>setNewAppt(v=>({...v,contactId:id}))} contacts={contacts} />}
                    <Btn sm onClick={() => {
                      if (!newAppt.title||!newAppt.date) return;
                      const conflict = findApptConflict(appts, newAppt.date, newAppt.time, null);
                      const item = {...newAppt,id:uid()};
                      setAppts(p=>[...p,item]);
                      mirrorAppointmentToCalendars(item);
                      setNewAppt({title:"",time:"",date:todayISO(),location:"",notes:"",urgent:false,repeat:"none",contactId:null});
                      setShowAddAppt(false);
                      toast(conflict ? `Appointment added: ${newAppt.title} — same time as "${conflict.title}."` : `Appointment added: ${newAppt.title}`);
                    }}>Add</Btn>
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
            {sortAppts(calendarView==="grid" && calendarSelectedDate ? appts.filter(a=>a.date===calendarSelectedDate) : appts).map(a => (
              editingAppt && editingAppt.id===a.id ? (
                <Card key={a.id} style={{ marginBottom:11, border:`1px solid ${C.soft}` }}>
                  <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:11 }}>Edit appointment</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                    <div style={{ display:"flex", gap:8 }}><Inp placeholder="Title *" value={editingAppt.title} onChange={e=>setEditingAppt(v=>({...v,title:e.target.value}))} style={{ flex:2 }} /><Inp placeholder="Time e.g. 4:00 PM" value={editingAppt.time} onChange={e=>setEditingAppt(v=>({...v,time:e.target.value}))} style={{ flex:1 }} /></div>
                    <div style={{ display:"flex", gap:8 }}><input type="date" value={editingAppt.date||todayISO()} onChange={e=>setEditingAppt(v=>({...v,date:e.target.value}))} style={{ flex:1, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} /><Inp placeholder="Location" value={editingAppt.location} onChange={e=>setEditingAppt(v=>({...v,location:e.target.value}))} style={{ flex:1 }} /></div>
                    <Inp placeholder="Notes (optional)" value={editingAppt.notes} onChange={e=>setEditingAppt(v=>({...v,notes:e.target.value}))} />
                    <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                      <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }}><input type="checkbox" checked={editingAppt.urgent} onChange={e=>setEditingAppt(v=>({...v,urgent:e.target.checked}))} style={{ accentColor:C.white, width:14, height:14 }} /><Mono style={{ color:C.soft }}>Urgent</Mono></label>
                      <select value={editingAppt.repeat} onChange={e=>setEditingAppt(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none" }}>{["none","daily","weekly","monthly"].map(r=><option key={r}>{r}</option>)}</select>
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
              <div style={{ display:"flex", alignItems:"center", gap:9, flexWrap:"wrap", justifyContent:"flex-end" }}>
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
                  {!(googleStatus.gmail || microsoftStatus.mail) && <Btn sm v="outline" onClick={() => { setTab("profile"); setProfileNav({ screen:"connected", openRow:null }); }}>Connect Email</Btn>}
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
                    <button key={o.l} onClick={() => setNewNote(v=>({...v, checklist:o.checklist?(v.checklist||[]):null}))} style={{ flex:1, padding:"7px 10px", borderRadius:9, border:`1px solid ${!!newNote.checklist===o.checklist?C.white:C.cardB}`, background:!!newNote.checklist===o.checklist?"rgba(255,255,255,.1)":"transparent", color:!!newNote.checklist===o.checklist?C.white:C.muted, cursor:"pointer", fontSize:11, fontWeight:700, fontFamily:APP_FONT }}>{o.l}</button>
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
                  <textarea placeholder="Write your note, checklist, or idea…" value={newNote.body} onChange={e=>setNewNote(v=>({...v,body:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }} />
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
                      <button key={o.l} onClick={() => setEditingNote(v=>({...v, checklist:o.checklist?(v.checklist||[]):null}))} style={{ flex:1, padding:"7px 10px", borderRadius:9, border:`1px solid ${!!editingNote.checklist===o.checklist?C.white:C.cardB}`, background:!!editingNote.checklist===o.checklist?"rgba(255,255,255,.1)":"transparent", color:!!editingNote.checklist===o.checklist?C.white:C.muted, cursor:"pointer", fontSize:11, fontWeight:700, fontFamily:APP_FONT }}>{o.l}</button>
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
                    <textarea placeholder="Write your note, checklist, or idea…" value={editingNote.body} onChange={e=>setEditingNote(v=>({...v,body:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10 }} />
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
                        {/* Lives inside this checklist's own stopPropagation wrapper (so checking
                            off an item doesn't also collapse the note), which silently swallowed
                            a tap aimed at this text specifically — a real button with its own
                            handler opens the note directly instead of relying on the click
                            reaching the card's row-level toggle. */}
                        {openNote!==n.id && n.checklist.length>3 && (
                          <button onClick={() => setOpenNote(n.id)} style={{ background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left", marginTop:2 }}>
                            <Mono style={{ color:C.muted, textDecoration:"underline" }}>+{n.checklist.length-3} more</Mono>
                          </button>
                        )}
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
                  <select value={newTask.priority} onChange={e=>setNewTask(v=>({...v,priority:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
                    {["Low","Normal","High","Urgent"].map(p => <option key={p}>{p}</option>)}
                  </select>
                  <input type="date" value={newTask.dueDate} onChange={e=>setNewTask(v=>({...v,dueDate:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                  <select value={newTask.repeat} onChange={e=>setNewTask(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
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
                    <select value={editingTask.priority} onChange={e=>setEditingTask(v=>({...v,priority:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
                      {["Low","Normal","High","Urgent"].map(p => <option key={p}>{p}</option>)}
                    </select>
                    <input type="date" value={editingTask.dueDate||""} onChange={e=>setEditingTask(v=>({...v,dueDate:e.target.value}))} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"8px 9px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                    <select value={editingTask.repeat} onChange={e=>setEditingTask(v=>({...v,repeat:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
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
                      // instant it's created. Loops forward (not just one step) so completing a
                      // task that's sat overdue for days lands on today/the future, not still in
                      // the past — same catch-up rollRecurring already does for appointments. If
                      // there's a due date but it can't actually be advanced (a corrupted repeat
                      // cadence or an unparseable dueDate), spawning a "next occurrence" anyway
                      // would recreate an identical still-overdue duplicate every single time it's
                      // completed — so respawn only when a real due date came back, or there was
                      // no due date to begin with (a normal undated recurring task).
                      if (completing && target.repeat !== "none") {
                        const nextDue = target.dueDate ? advanceRepeatDateTo(target.dueDate, target.repeat, todayISO()) : "";
                        if (!target.dueDate || nextDue !== target.dueDate) {
                          return [{ id:uid(), title:target.title, priority:target.priority, repeat:target.repeat, contactId:target.contactId, dueDate:nextDue, done:false }, ...toggled];
                        }
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
              <label style={{ background:C.white, color:C.black, borderRadius:12, padding:"10px 22px", cursor:"pointer", fontSize:13, fontWeight:700, fontFamily:APP_FONT }}>
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
                <textarea placeholder="Write your document…" value={newDocument.body} onChange={e=>setNewDocument(v=>({...v,body:e.target.value}))} rows={8} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
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
                  <textarea value={editingDocument.body} onChange={e=>setEditingDocument(v=>({...v,body:e.target.value}))} rows={8} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
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
                  <Btn sm v="outline" onClick={() => { downloadText(`${d.title.replace(/[^a-z0-9]+/gi,"_")||"document"}.txt`, `${d.title}\n\n${d.body}`, "Downloaded."); }}>{isNativeApp ? "Save" : "Download"}</Btn>
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
                    <input type="date" value={newProject.deadline} onChange={e=>setNewProject(v=>({...v,deadline:e.target.value}))} style={{ flex:1, minWidth:120, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:newProject.deadline?C.text:C.muted, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                  </div>
                  <Inp placeholder="What's this project about? (optional)" value={newProject.description} onChange={e=>setNewProject(v=>({...v,description:e.target.value}))} />
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <select value={newProject.status} onChange={e=>setNewProject(v=>({...v,status:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
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
                      <input type="date" value={editingProject.deadline||""} onChange={e=>setEditingProject(v=>({...v,deadline:e.target.value}))} style={{ flex:1, minWidth:120, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                    </div>
                    <Inp placeholder="Description" value={editingProject.description||""} onChange={e=>setEditingProject(v=>({...v,description:e.target.value}))} />
                    <select value={editingProject.status} onChange={e=>setEditingProject(v=>({...v,status:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
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
                        <button onClick={() => { setAddingMilestoneToProject(addingMilestoneToProject===pr.id?null:pr.id); setMilestoneDraft(""); }} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:APP_FONT, textDecoration:"underline" }}>+ New</button>
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
                            {sec.onNew && <button onClick={sec.onNew} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:APP_FONT, textDecoration:"underline" }}>+ New</button>}
                            <button onClick={() => setLinkPicker(linkPicker&&linkPicker.projectId===pr.id&&linkPicker.kind===sec.kind ? null : {projectId:pr.id,kind:sec.kind})} style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", fontSize:11, fontFamily:APP_FONT, textDecoration:"underline" }}>+ Link</button>
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
                  <textarea value={editingMemo.transcript} onChange={e=>setEditingMemo(v=>({...v,transcript:e.target.value}))} rows={4} style={{ width:"100%", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 14px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", resize:"vertical", boxSizing:"border-box", marginBottom:10, lineHeight:1.6 }} />
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
                  <input type="date" min={todayISO()} value={newCall.date} onChange={e=>setNewCall(v=>({...v,date:e.target.value}))} style={{ flex:1, minWidth:130, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                  <input type="time" value={newCall.time} onChange={e=>setNewCall(v=>({...v,time:e.target.value}))} style={{ flex:1, minWidth:110, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:13, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
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
                    <select value={editingContact.category} onChange={e=>setEditingContact(v=>({...v,category:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none" }}>
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
                      <select value={newContact.category} onChange={e=>setNewContact(v=>({...v,category:e.target.value}))} style={{ background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:8, padding:"7px 11px", color:C.text, fontSize:11, fontFamily:APP_FONT, outline:"none" }}>
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
                    fontFamily:APP_FONT,
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
                  style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:APP_FONT }}
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
            {/* A thin hairline between each major Wellness section, on top of the existing gap —
                the page reads as one continuous flow of sections rather than loose floating
                cards. Same C.div token every other hairline divider in the app already uses
                (see ProfileRow's own row divider). */}
            <div style={{ height:1, background:C.div, marginBottom:14 }} />
            {/* The score only ever existed as a single "today" number — nothing showed whether
                this week is actually trending up or down, only whatever day happened to be
                showing. wellnessHistory records each day's score right before it rolls over. */}
            {wellnessTrend.length > 1 && (
              <>
              <Card style={{ marginBottom:14, borderRadius:22 }}>
                <Mono style={{ display:"block", color:C.muted, marginBottom:12, letterSpacing:.8 }}>Score · last {wellnessTrend.length} days</Mono>
                {/* Bars instead of a line — today solid, every earlier day a lighter tint of the
                    same color, so "which one is now" reads at a glance instead of needing to
                    trace the line to the last point. */}
                <Suspense fallback={<div style={{ height:160, display:"flex", alignItems:"center", justifyContent:"center" }}><Spinner size={16} color={C.muted} /></div>}>
                  <WellnessTrendChart data={wellnessTrend} c={C} activeColor={wColor} />
                </Suspense>
              </Card>
              <div style={{ height:1, background:C.div, marginBottom:14 }} />
              </>
            )}
            {/* These Wellness features (Your Patterns, Quick Reset, Sleep, Journal) live as
                pull-out rows in one Card — the same collapsed-row/expand-in-place pattern as
                ProfileRow in the Profile tab (see its own comment) — rather than separate
                full-height cards. Collapsed, each row's sub-line already says the honest
                current state (a real count or "not logged yet"), so the page reads as a compact
                list until you actually want to act on one of them. */}
            <Card style={{ marginBottom:14, borderRadius:22, padding:"4px 16px" }}>
              <ProfileRow
                label="Your Patterns"
                icon="patterns" glow={WELLNESS_ROW_GLOW.patterns}
                sub={wellnessPatterns.length > 0 ? `${wellnessPatterns.length} pattern${wellnessPatterns.length!==1?"s":""} found` : "Keep logging to find patterns"}
                expanded={openWellnessRow==="patterns"}
                onToggle={() => setOpenWellnessRow(v => v==="patterns" ? null : "patterns")}>
                <div style={{ display:"flex", justifyContent:"flex-end", gap:4, marginBottom:11 }}>
                  {[7,30,90].map(r => (
                    <button key={r} onClick={() => setPatternRange(r)}
                      style={{ background:patternRange===r?C.accent:C.surface, border:`1px solid ${patternRange===r?C.accent:C.cardB}`, borderRadius:8, padding:"4px 9px", cursor:"pointer", color:patternRange===r?C.black:C.soft, fontSize:10, fontWeight:700 }}>
                      {r}d
                    </button>
                  ))}
                </div>
                {wellnessPatterns.length === 0 ? (
                  <Mono style={{ color:C.soft, display:"block", padding:"0 0 6px", lineHeight:1.6 }}>
                    We're still learning your patterns. Keep using KROFT and we'll start showing connections in your wellness data.
                  </Mono>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8, paddingBottom:4 }}>
                    {wellnessPatterns.map(p => (
                      <button key={p.id} className="row" onClick={() => setPatternDetail(p)}
                        style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, textAlign:"left", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:14, padding:"12px 13px", cursor:"pointer", transition:"background .15s ease" }}>
                        <div style={{ fontSize:12.5, color:C.text, lineHeight:1.5 }}>{p.insight}</div>
                        <NavIcon id="trendUp" size={13} color={C.muted} />
                      </button>
                    ))}
                  </div>
                )}
              </ProfileRow>
              <ProfileRow
                label="Quick Reset"
                icon="timer" glow={WELLNESS_ROW_GLOW.reset}
                sub={quickResetLog.length > 0 ? `${quickResetLog.length} session${quickResetLog.length!==1?"s":""} completed` : "5 guided sessions"}
                expanded={openWellnessRow==="reset"}
                onToggle={() => setOpenWellnessRow(v => v==="reset" ? null : "reset")}>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, paddingBottom:4 }}>
                  {QUICK_RESET_KINDS.map(k => (
                    <button key={k.key} className="row" onClick={() => startQuickReset(k.key)}
                      style={{ background:C.card, border:`1px solid ${C.accent}2a`, borderRadius:14, padding:"11px 10px", cursor:"pointer", textAlign:"left", transition:"background .15s ease" }}>
                      <div style={{ fontSize:12, fontWeight:700, color:C.white, marginBottom:2 }}>{k.label}</div>
                      <Mono style={{ color:C.muted, fontSize:10 }}>{k.seconds < 60 ? `${k.seconds}s` : `${Math.round(k.seconds/60)} min`}</Mono>
                    </button>
                  ))}
                </div>
              </ProfileRow>
              <ProfileRow
                label="Sleep"
                icon="moon" glow={WELLNESS_ROW_GLOW.sleep}
                sub={sleepLog.length > 0 ? `Last: ${sleepLog[sleepLog.length-1].hours}h on ${fmtDate(sleepLog[sleepLog.length-1].date)}` : "Not logged yet"}
                expanded={openWellnessRow==="sleep"}
                onToggle={() => setOpenWellnessRow(v => v==="sleep" ? null : "sleep")}>
                <div style={{ paddingBottom:4 }}>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:10 }}>
                    <Inp placeholder="Hours slept" type="number" min="0" max="24" step="0.25" value={sleepForm.hours} onChange={e => setSleepForm(v=>({...v,hours:e.target.value}))} style={{ flex:1, minWidth:100 }} />
                    <select value={sleepForm.quality} onChange={e => setSleepForm(v=>({...v,quality:e.target.value}))} style={{ flex:1, minWidth:100, background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"11px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none" }}>
                      <option value="">Quality (optional)</option>
                      <option value="poor">Poor</option>
                      <option value="fair">Fair</option>
                      <option value="good">Good</option>
                      <option value="great">Great</option>
                    </select>
                  </div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
                    <div style={{ flex:1, minWidth:100 }}>
                      <Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>Bedtime</Mono>
                      <input type="time" value={sleepForm.bedtime} onChange={e => setSleepForm(v=>({...v,bedtime:e.target.value}))} style={{ width:"100%", boxSizing:"border-box", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                    </div>
                    <div style={{ flex:1, minWidth:100 }}>
                      <Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>Wake time</Mono>
                      <input type="time" value={sleepForm.wakeTime} onChange={e => setSleepForm(v=>({...v,wakeTime:e.target.value}))} style={{ width:"100%", boxSizing:"border-box", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:12, padding:"10px 12px", color:C.text, fontSize:12, fontFamily:APP_FONT, outline:"none", colorScheme:theme }} />
                    </div>
                  </div>
                  {/* Manual entry today — see sleepLog's own state comment on why the shape here is
                      already what a future HealthKit/Health Connect auto-collector would populate. */}
                  <Btn sm full disabled={!sleepForm.hours} onClick={() => {
                    const hours = parseFloat(sleepForm.hours);
                    if (!(hours >= 0)) return;
                    logSleep({ hours, bedtime: sleepForm.bedtime || null, wakeTime: sleepForm.wakeTime || null, quality: sleepForm.quality || null });
                    setSleepForm({ hours:"", bedtime:"", wakeTime:"", quality:"" });
                  }}>Log sleep</Btn>
                </div>
              </ProfileRow>
              <ProfileRow
                label="Wellness Journal"
                icon="journal" glow={WELLNESS_ROW_GLOW.journal}
                sub={journalEntries.length > 0 ? `${journalEntries.length} entr${journalEntries.length!==1?"ies":"y"} saved` : "No entries yet"}
                expanded={openWellnessRow==="journal"}
                onToggle={() => setOpenWellnessRow(v => v==="journal" ? null : "journal")}>
                <div style={{ paddingBottom:4 }}>
                  <textarea value={journalDraft} onChange={e => setJournalDraft(e.target.value)} placeholder="What's on your mind?" rows={3}
                    style={{ width:"100%", boxSizing:"border-box", background:C.surface, border:`1px solid ${C.cardB}`, borderRadius:14, padding:"11px 13px", color:C.text, fontSize:12.5, fontFamily:APP_FONT, outline:"none", resize:"vertical", marginBottom:10 }} />
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={toggleJournalListen} aria-label={journalListening ? "Stop dictation" : "Speak entry"} title={journalListening ? "Stop dictation" : "Speak entry"}
                      style={{ background:journalListening?C.negativeBg:C.surface, border:`1px solid ${journalListening?C.negative:C.cardB}`, borderRadius:12, padding:"10px 13px", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <NavIcon id="mic" size={15} color={journalListening?C.negative:C.soft} />
                    </button>
                    <Btn sm disabled={!journalDraft.trim()} onClick={() => { addJournalEntry(journalDraft); setJournalDraft(""); }} style={{ flex:1 }}>Save entry</Btn>
                  </div>
                  {journalEntries.length > 0 && (
                    <div style={{ marginTop:14 }}>
                      {journalEntries.slice().reverse().slice(0, 5).map(en => (
                        <div key={en.id} {...longPress(() => setActionSheet({
                            title: fmtDate(en.date),
                            subtitle: en.time,
                            actions:[{ label:"Delete entry", destructive:true, confirmText:"This permanently removes this journal entry.", onClick:() => {
                              const prev = journalEntries;
                              deleteJournalEntry(en.id);
                              toast("Journal entry deleted.", () => setJournalEntries(prev));
                            }}],
                          }))}
                          style={{ padding:"10px 12px", marginBottom:6, borderRadius:12, background:C.surface, WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }}>
                          <Mono style={{ display:"block", color:C.muted, marginBottom:4 }}>{en.date===todayISO() ? "Today" : fmtDate(en.date)} · {en.time}</Mono>
                          <div style={{ fontSize:12.5, color:C.text, lineHeight:1.5 }}>{en.text}</div>
                        </div>
                      ))}
                      {journalEntries.length > 5 && (
                        <Mono style={{ display:"block", color:C.muted, padding:"6px 0 2px" }}>Showing your 5 most recent entries. {journalEntries.length - 5} earlier {journalEntries.length - 5 === 1 ? "entry is" : "entries are"} still saved.</Mono>
                      )}
                    </div>
                  )}
                </div>
              </ProfileRow>
              <ProfileRow
                label="Mood log"
                icon="smile" glow={WELLNESS_ROW_GLOW.mood}
                sub={moodLog.length===0 ? "No mood entries yet" : wellnessStreak > 0 ? `${wellnessStreak} day streak` : `${moodLog.length} entr${moodLog.length!==1?"ies":"y"}`}
                expanded={openWellnessRow==="mood"}
                onToggle={() => setOpenWellnessRow(v => v==="mood" ? null : "mood")}>
                <div style={{ paddingBottom:4 }}>
                  {moodLog.length===0 ? <Mono style={{ color:C.soft, display:"block", padding:"0 0 6px" }}>No mood entries yet. Set your mood from the Overview tab.</Mono> : (() => {
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
                          const mTone = MOOD_META[m.mood]?.color;
                          const mColor = (mTone && C[mTone]) || C.border;
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
                </div>
              </ProfileRow>
            </Card>
            <div style={{ height:1, background:C.div, marginBottom:14 }} />
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
                const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
                // Only an upward scroll (the person reading back) stops the follow; the app's own
                // smooth scroll down passes through "not near the bottom" on its way there.
                if (near) chatStickToBottom.current = true;
                else if (box.scrollTop < (box.dataset.lastTop ? +box.dataset.lastTop : 0) - 2) chatStickToBottom.current = false;
                box.dataset.lastTop = box.scrollTop;
                setChatNearBottom(near);
              }} style={{ position:"absolute", inset:0, overflowY:"auto", padding:"16px", display:"flex", flexDirection:"column", gap:12,
                // Top-aligned once a real conversation exists (messages stack down, scroll takes
                // over), but centered while it's just the one welcome message — top-aligning that
                // alone left a large dead gap below it before the suggestion chips underneath.
                justifyContent: aiMessages.length <= 1 ? "center" : "flex-start" }}>
                {/* Before a real conversation exists, this reads as a clean branded moment (mark
                    + one line) rather than a chat bubble talking to no one — the seed assistant
                    message still exists in aiMessages/history exactly as before (so "New chat"
                    and the message-count checks elsewhere are untouched), it's just not rendered
                    as a bubble while it's the only thing there. */}
                {aiMessages.length <= 1 ? (
                  <div style={{ textAlign:"center", animation:"fadeUp .4s ease" }}>
                    <div style={{ margin:"0 auto 16px" }}><RobotIcon size={52} /></div>
                    <div style={{ fontSize:22, fontWeight:800, color:C.text, letterSpacing:-.5 }}>What can I help with, {firstNameOf(user.name)||"there"}?</div>
                  </div>
                ) : aiMessages.map((m,i) => {
                  // Long user-typed/pasted messages collapse to a short preview with a "Show
                  // more" toggle so one huge paste doesn't dominate the thread — KROFT's own
                  // replies never truncate; they're the thing you're actually here to read.
                  const USER_MSG_TRUNCATE_LEN = 320;
                  const isLongUserMsg = m.role==="user" && m.content && (m.content.length > USER_MSG_TRUNCATE_LEN || (m.content.match(/\n/g)||[]).length > 6);
                  const msgKey = m.id ?? i;
                  const isExpanded = expandedUserMsgs.has(msgKey);
                  const displayContent = isLongUserMsg && !isExpanded ? m.content.slice(0, USER_MSG_TRUNCATE_LEN).trimEnd() + "…" : m.content;
                  return (
                  <div key={m.id || i} data-msg-idx={i} style={{ display:"flex", flexDirection:"column", alignItems:m.role==="user"?"flex-end":"flex-start", animation:"fadeUp .3s ease", borderRadius:14, transition:"background .5s ease, box-shadow .5s ease", ...(flashMsg===i ? { background:C.accentBg, boxShadow:`0 0 0 8px ${C.accentBg}` } : {}) }}>
                    {editingMsg === i && (
                      <MessageEditor initial={m.content} replacesLater={i < aiMessages.length - 1} disabled={aiLoading}
                        onCancel={() => setEditingMsg(null)} onSend={text => editAndResend(i, text)} />
                    )}
                    <div hidden={editingMsg === i} {...(m.role==="user" ? longPress((x,y) => setCopyPopup({ x, y, content:m.content, idx:i })) : {})}
                      // Only the user's own messages sit in a bubble; KROFT's replies are plain
                      // full-width text, so the answer reads like a page rather than a chat card.
                      style={m.role==="user"
                        ? { background:C.white, border:`1px solid ${C.soft}`, borderRadius:"14px 14px 3px 14px", padding:"10px 14px", maxWidth:"80%", cursor:"pointer", WebkitTouchCallout:"none", WebkitUserSelect:"none", userSelect:"none" }
                        : { padding:"2px 2px", width:"100%", boxSizing:"border-box" }}>
                      {m.role==="assistant" && <Mono style={{ display:"block", color:C.muted, fontSize:9, letterSpacing:.8, marginBottom:5 }}>KROFT</Mono>}
                      {m.attachments?.length > 0 && (
                        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:m.content?8:0 }}>
                          {m.attachments.map(a => a.kind==="image" ? (
                            <img key={a.id} src={a.dataUrl} alt={a.name} style={{ width:84, height:84, borderRadius:10, objectFit:"cover", border:`1px solid ${C.soft}` }} />
                          ) : (
                            <a key={a.id} href={a.dataUrl} download={a.name} style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", borderRadius:10, background:C.fill, border:`1px solid ${C.soft}`, textDecoration:"none", maxWidth:180 }}>
                              <NavIcon id="file" size={13} color={C.black} />
                              <span style={{ fontSize:11, fontWeight:600, color:C.black, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.name}</span>
                            </a>
                          ))}
                        </div>
                      )}
                      {m.role === "assistant" && !m.failed ? (
                        // KROFT's replies are Markdown, rendered as real headings, lists, tables,
                        // code and copy-ready blocks (see src/markdown). The blinking caret marks
                        // a reply still arriving, so a paused stream doesn't read as finished.
                        <Markdown text={displayContent} theme={C} font={APP_FONT} streaming={!!m.streaming}
                          onCopy={ok => toast(ok ? "Copied to clipboard." : "Couldn't copy. Try selecting the text manually.")}
                          onRecheck={aiLoading ? undefined : q => askKroft(q)}
                          caret={m.streaming ? <span aria-hidden="true" style={{ display:"inline-block", width:7, height:15, marginLeft:3, verticalAlign:"text-bottom", background:C.muted, animation:"pulse 1s ease-in-out infinite" }} /> : null} />
                      ) : (
                        <div style={{ fontSize:15, lineHeight:1.6, color:m.failed?C.negative:(m.role==="user"?C.black:C.text), whiteSpace:"pre-wrap", overflowWrap:"anywhere" }}>
                          {displayContent}
                        </div>
                      )}
                      {isLongUserMsg && (
                        <button onClick={() => setExpandedUserMsgs(p => { const next = new Set(p); if (isExpanded) next.delete(msgKey); else next.add(msgKey); return next; })}
                          style={{ background:"none", border:"none", padding:0, marginTop:4, cursor:"pointer", color:C.accent, fontSize:12.5, fontWeight:700, fontFamily:APP_FONT }}>
                          {isExpanded ? "Show less" : "Show more"}
                        </button>
                      )}
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
                  );
                })}
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
                    <button key={q} onClick={() => askKroft(q)} style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:APP_FONT }} onMouseEnter={e=>{e.target.style.borderColor=C.soft;e.target.style.color=C.white;}} onMouseLeave={e=>{e.target.style.borderColor=C.cardB;e.target.style.color=C.border;}}>
                      {q}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:C.muted, marginBottom:6 }}>Or tell it to do something</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:7 }}>
                  {["Log a 5,000 fuel expense","Remind me to call the bank tomorrow","Add a task to send the invoice","Schedule a meeting Friday at 10"].map(q => (
                    <button key={q} onClick={() => askKroft(q)} style={{ background:C.card, border:`1px solid ${C.accent}44`, borderRadius:7, padding:"6px 12px", cursor:"pointer", color:C.soft, fontSize:11, fontFamily:APP_FONT }}>
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
                background:C.surface, borderRadius:22, padding:"10px 10px 8px", position:"relative",
                border:`1px solid ${aiInputFocused ? C.accent : C.cardB}`,
                boxShadow:aiInputFocused ? `0 0 0 3px ${C.accentBg}` : "none",
                transition:"border-color .18s, box-shadow .18s",
              }}>
                <input ref={aiPhotoInputRef} type="file" accept="image/*" multiple style={{ display:"none" }} onChange={e => handleAiAttach(e, "image")} />
                <input ref={aiFileInputRef} type="file" multiple style={{ display:"none" }} onChange={e => handleAiAttach(e, "file")} />
                {/* capture="environment" opens the rear camera directly on phones; desktop
                    browsers ignore it and fall back to a normal file picker. */}
                <input ref={aiCameraInputRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }} onChange={e => handleAiAttach(e, "image")} />
                {/* Same camera capture, plus a ready-made prompt — the photo reaches the model as
                    a real image (see runKroftCompletion), so it can read the receipt and log it
                    through the existing add_expense action. Only prefilled when a photo was
                    actually taken, and never over something already typed. */}
                <input ref={aiReceiptInputRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }} onChange={e => {
                  const took = e.target.files?.length > 0;
                  handleAiAttach(e, "image");
                  if (took) setAiInput(v => v.trim() ? v : "Log this receipt as an expense.");
                }} />
                {!online && (
                  <div role="status" style={{ display:"flex", alignItems:"center", gap:8, margin:"0 4px 8px", fontSize:13, color:C.soft }}>
                    <span aria-hidden="true" style={{ width:8, height:8, borderRadius:"50%", background:C.warning, flexShrink:0 }} />
                    You're offline. KROFT can answer again once you're back online.
                  </div>
                )}
                {aiAttachments.length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8, padding:"0 4px" }}>
                    {aiAttachments.map(a => (
                      <div key={a.id} style={{ position:"relative" }}>
                        {a.kind==="image" ? (
                          <img src={a.dataUrl} alt={a.name} style={{ width:52, height:52, borderRadius:9, objectFit:"cover", border:`1px solid ${C.cardB}`, display:"block" }} />
                        ) : (
                          <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 10px", borderRadius:9, background:C.card, border:`1px solid ${C.cardB}`, maxWidth:120 }}>
                            <NavIcon id="file" size={13} color={C.text} />
                            <span style={{ fontSize:10, fontWeight:600, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.name}</span>
                          </div>
                        )}
                        <button onClick={() => removeAiAttachment(a.id)} aria-label={`Remove ${a.name}`} title="Remove"
                          style={{ position:"absolute", top:-6, right:-6, width:18, height:18, borderRadius:"50%", background:C.text, border:`1.5px solid ${C.bg}`, color:C.card, fontSize:10, fontWeight:900, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", padding:0, lineHeight:1 }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
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
                  placeholder={listening ? "Listening…" : "Message KROFT…"}
                  rows={1}
                  style={{ width:"100%", fontSize:13, fontFamily:APP_FONT, background:"transparent", border:"none", padding:"4px 6px", color:C.text, outline:"none", resize:"none", maxHeight:120, overflowY:"auto", lineHeight:1.4, boxSizing:"border-box" }}
                  onFocus={() => setAiInputFocused(true)}
                  onBlur={() => setAiInputFocused(false)}
                />
                {listening ? (
                  /* Recording mode: the whole control row becomes cancel/waveform/stop/send,
                     replacing the attach + mic + send cluster below — matching the pattern most
                     dictation UIs use (e.g. ChatGPT's own), instead of leaving the normal row's
                     buttons in place next to a small ripple. */
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:2 }}>
                    <button onClick={cancelListen} aria-label="Cancel recording" title="Cancel"
                      style={{ background:"none", border:"none", color:C.soft, cursor:"pointer", width:28, height:28, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, lineHeight:1, padding:0 }}>
                      ✕
                    </button>
                    <div style={{ flex:1, display:"flex", justifyContent:"center" }}>
                      <WaveBar active color={C.accent} />
                    </div>
                    <button onClick={toggleListen} aria-label="Stop recording" title="Stop"
                      style={{ background:C.text, border:"none", borderRadius:"50%", width:34, height:34, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <span style={{ width:11, height:11, borderRadius:3, background:C.card, display:"block" }} />
                    </button>
                    <button onClick={stopAndSend} aria-label="Stop and send" title="Send"
                      style={{ background:C.text, border:"none", borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                      <NavIcon id="send" size={17} color={C.card} />
                    </button>
                  </div>
                ) : (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:2 }}>
                  {/* "New chat" moved to the header (it's still right there) — the "+" now opens
                      a real attach menu instead of duplicating that action. */}
                  <div style={{ position:"relative" }}>
                    <button onClick={() => setShowAttachMenu(v => !v)} aria-label="Attach a photo or file" aria-expanded={showAttachMenu} title="Attach"
                      style={{ position:"relative", zIndex:5, background:showAttachMenu?C.white:C.card, border:`1px solid ${showAttachMenu?C.white:C.cardB}`, borderRadius:"50%", width:34, height:34, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transform:showAttachMenu?"rotate(45deg)":"none", transition:"transform .15s" }}>
                      <NavIcon id="plus" size={16} color={showAttachMenu?C.black:C.text} />
                    </button>
                    {showAttachMenu && (
                      <>
                        {/* Invisible full-screen catcher so tapping anywhere outside the menu
                            closes it, like any native popover. */}
                        <div onClick={() => setShowAttachMenu(false)} aria-hidden="true" style={{ position:"fixed", inset:0, zIndex:4 }} />
                        <div role="menu" aria-label="Attach" style={{ position:"absolute", bottom:"calc(100% + 10px)", left:-4, background:C.card, border:`1px solid ${C.cardB}`, borderRadius:24, padding:10, display:"flex", flexDirection:"column", gap:4, boxShadow:C.shadowRaised, zIndex:5, minWidth:230, animation:"fadeUp .18s ease" }}>
                          {[
                            { id:"camera", label:"Camera", ref:aiCameraInputRef },
                            { id:"image", label:"Photos", ref:aiPhotoInputRef },
                            { id:"paperclip", label:"Files", ref:aiFileInputRef },
                            { id:"receipt", label:"Scan receipt", ref:aiReceiptInputRef },
                          ].map(o => (
                            <button key={o.id} role="menuitem" className="row" onClick={() => { o.ref.current?.click(); setShowAttachMenu(false); }}
                              style={{ display:"flex", alignItems:"center", gap:14, padding:"6px 8px", borderRadius:16, background:"none", border:"none", cursor:"pointer", color:C.text, fontSize:15.5, fontWeight:500, fontFamily:APP_FONT, textAlign:"left" }}>
                              <span style={{ width:44, height:44, borderRadius:"50%", background:C.fill, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                                <NavIcon id={o.id} size={20} color={C.text} />
                              </span>
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {/* Dictate-and-review: unlike the black button's live voice mode (a spoken
                        back-and-forth conversation), this records one utterance, transcribes it
                        into the text field via the same toggleListen already used elsewhere
                        (Notes' own Voice button), and stops there — reviewing before Send stays
                        possible, rather than sending the instant speech recognition finishes.
                        Only ever rendered while idle now — the recording state gets its own full
                        row above instead of a ripple on this same small button. */}
                    {SRSupported && !aiLoading && (
                      <button onClick={toggleListen} aria-label="Dictate a message" title="Dictate a message"
                        style={{ background:C.card, border:`1px solid ${C.cardB}`, borderRadius:"50%", width:36, height:36, flexShrink:0, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <NavIcon id="mic" size={16} color={C.text} />
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
                    ) : (aiInput.trim() || aiAttachments.length>0) ? (
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
                )}
              </div>
            </div>
          </div>
        )}

        {tab==="profile" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <ProfileSection
              nav={profileNav} onNav={setProfileNav}
              connections={{
                google: { status:googleStatus, linking:googleLinking, connect:() => connectGoogle("connected"), disconnect:disconnectGoogle },
                microsoft: { status:microsoftStatus, linking:microsoftLinking, connect:() => connectMicrosoft("connected"), disconnect:disconnectMicrosoft },
              }}
              user={user}
              onUpdateName={name => setUser(u => ({ ...u, name }))}
              // Two different buttons used to share this one callback: "Manage connections"
              // (Calendar/Email rows) correctly wants the account-linking screen — that's
              // "prefs" — but "Personal Preferences" > "Edit details" wants Business
              // name/type/currency, which live on a DIFFERENT step ("business"). Sharing one
              // prop meant "Edit details" silently opened account-linking and edited none of
              // what it promised. Split into two so each button reaches the fields it actually
              // claims to edit.
              onEditBusinessDetails={() => { setEditingFromProfile(true); setStep("business"); }}
              onExportData={exportData}
              onDeleteAccount={deleteAccount}
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
                // Changes made offline live only on this device until they sync, and logging out
                // clears the device copy, so sync first and don't log out while that's impossible.
                if (isSupabaseConfigured) {
                  if (hasUnsyncedChanges() && navigator.onLine === false) {
                    toast("You have changes that haven't synced yet. Connect to the internet, then log out.");
                    return false;
                  }
                  await flushPending();
                  if (hasUnsyncedChanges()) {
                    toast("Couldn't sync your latest changes. Try logging out again in a moment.");
                    return false;
                  }
                }
                if ("speechSynthesis" in window) window.speechSynthesis.cancel();
                if (isSupabaseConfigured) await supabase.auth.signOut();
                clearOfflineData();
                writeNativeBio(null);
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
              wellnessAiContext={wellnessAiContext}
              onSetWellnessAiContext={setWellnessAiContext}
              voicePref={voicePref}
              onSetVoicePref={setVoicePref}
              voiceSpeed={voiceSpeed}
              onSetVoiceSpeed={setVoiceSpeed}
              onSetupBiometric={setupBiometric}
              biometricOn={biometricOn}
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
                <span style={{ fontSize:9, fontWeight:700, color: active ? C.card : C.muted, letterSpacing:.3, fontFamily:APP_FONT }}>{t.label}</span>
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
