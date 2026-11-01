// Native glue for the Android app (Capacitor). The app is the same KROFT web app, loaded from
// https://kroft-pied.vercel.app inside an Android WebView (see capacitor.config.json). A WebView
// lacks a few browser features KROFT relies on, so this file fills them in with native plugins,
// using the same interfaces the existing code already calls:
//
//   speechSynthesis / SpeechSynthesisUtterance -> @capacitor-community/text-to-speech
//   SpeechRecognition                          -> @capacitor-community/speech-recognition, or a
//                                                 recorder + server transcription on phones with
//                                                 no speech service (src/voiceRecorder.js)
//   navigator.geolocation / permissions.query  -> @capacitor/geolocation
//   Notification                               -> @capacitor/local-notifications
//   navigator.share                            -> @capacitor/share
//   Face ID / fingerprint unlock               -> @capgo/capacitor-native-biometric (verifyBiometric)
//   file downloads (<a download>)              -> @capacitor/filesystem + share sheet (saveFileFromApp)
//
// It also routes sign-in and checkout pages through the system browser (Google refuses to sign in
// inside a WebView) and brings the result back into the app through the com.orynthra.kroft://
// deep link. In a normal browser isNativeApp is false and nothing here runs.

import { Capacitor } from "@capacitor/core";
import { createRecorderRecognition } from "./voiceRecorder.js";

export const isNativeApp = Capacitor.isNativePlatform();

// Which plugins the installed app actually contains. The screens come from the live website, so
// they can be newer than the app on the phone: an APK from before a plugin was added doesn't
// have it, and every native feature checks this before using one instead of breaking.
export const hasPlugin = name => isNativeApp && Capacitor.isPluginAvailable(name);

// Identifies this copy of KROFT on every request to KROFT's own API (X-Kroft-Client), so the
// server can tell the website from the Android app, and one app version from another:
//   web;web=<build>
//   android;shell=1.1.0;build=10100;web=<build>;plugins=app,brw,fs,geo,...
// Older APKs (built before version tracking) report build=1.
export const WEB_BUILD = typeof __WEB_BUILD__ !== "undefined" ? __WEB_BUILD__ : "dev";
const PLUGIN_CODES = {
  App: "app", Browser: "brw", LocalNotifications: "ln", Share: "shr", TextToSpeech: "tts",
  SpeechRecognition: "sr", Geolocation: "geo", NativeBiometric: "bio", Filesystem: "fs",
};
let clientHeader = `web;web=${WEB_BUILD}`;
let shellInfo = null;
export const getClientHeader = () => clientHeader;
export const getShellInfo = () => shellInfo;
export const APP_SCHEME = "com.orynthra.kroft";
export const nativeRedirect = path => `${APP_SCHEME}://${path}`;

// Loaded only inside the app, so the web bundle never pays for the plugin code.
const plugins = isNativeApp
  ? Promise.all([
      import("@capacitor/app"),
      import("@capacitor/browser"),
      import("@capacitor/local-notifications"),
      import("@capacitor/share"),
      import("@capacitor-community/text-to-speech"),
      import("@capacitor-community/speech-recognition"),
      import("@capacitor/geolocation"),
      import("@capgo/capacitor-native-biometric"),
      import("@capacitor/filesystem"),
    ]).then(([app, browser, ln, share, tts, sr, geo, bio, fs]) => ({
      App: app.App, Browser: browser.Browser, LocalNotifications: ln.LocalNotifications,
      Share: share.Share, TextToSpeech: tts.TextToSpeech, SpeechRecognition: sr.SpeechRecognition,
      Geolocation: geo.Geolocation, NativeBiometric: bio.NativeBiometric, Filesystem: fs.Filesystem,
    }))
  : null;

// A stable 31-bit id from a string, for notification ids.
const idFor = key => {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 2147483647 || 1;
};

// Opens a sign-in or checkout page in the system browser (a Chrome Custom Tab). Returns false when
// not in the app, so callers fall back to normal navigation.
export async function openInSystemBrowser(url) {
  if (!hasPlugin("Browser")) return false;
  const { Browser } = await plugins;
  // If the person closes the browser without finishing, tell the app so it can stop its spinners.
  const handle = await Browser.addListener("browserFinished", () => {
    handle.remove();
    window.dispatchEvent(new Event("kroft:browser-closed"));
  });
  await Browser.open({ url, presentationStyle: "fullscreen" });
  return true;
}

// Reminders scheduled on the phone itself, so they fire even when KROFT is closed. Takes the same
// { prefix, items:[{ clientKey, firesAt, title, body }] } list the web version sends to
// /api/push/schedule, and reconciles it the same way: everything under `prefix` not in the list
// is cancelled.
export async function scheduleDeviceReminders(prefix, items) {
  if (!hasPlugin("LocalNotifications")) return;
  const { LocalNotifications } = await plugins;
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== "granted") return;
  const pending = (await LocalNotifications.getPending()).notifications || [];
  const stale = pending.filter(n => String(n.extra?.clientKey || "").startsWith(prefix));
  if (stale.length) await LocalNotifications.cancel({ notifications: stale.map(n => ({ id: n.id })) });
  const upcoming = items.filter(it => new Date(it.firesAt).getTime() > Date.now());
  if (!upcoming.length) return;
  await LocalNotifications.schedule({
    notifications: upcoming.map(it => ({
      id: idFor(it.clientKey),
      title: it.title,
      body: it.body || "",
      schedule: { at: new Date(it.firesAt), allowWhileIdle: true },
      extra: { clientKey: it.clientKey },
    })),
  });
}

// A single notification at a set time, used as a backup for a Quick Reset ending while the
// phone's screen is off (the app's own timer and sound pause then). Cancelled when the app ends
// the countdown itself. Does nothing without notification permission or on the website.
const ONE_SHOT_ID = 2100000001;
export async function scheduleReminderAt(at, title, body) {
  if (!hasPlugin("LocalNotifications")) return;
  try {
    const { LocalNotifications } = await plugins;
    if ((await LocalNotifications.checkPermissions()).display !== "granted") return;
    await LocalNotifications.schedule({ notifications: [{ id: ONE_SHOT_ID, title, body, schedule: { at: new Date(at), allowWhileIdle: true } }] });
  } catch { /* the countdown still works in the app */ }
}
export async function cancelReminderAt() {
  if (!hasPlugin("LocalNotifications")) return;
  try { const { LocalNotifications } = await plugins; await LocalNotifications.cancel({ notifications: [{ id: ONE_SHOT_ID }] }); } catch { /* nothing scheduled */ }
}

// ── Text to speech ──
function installSpeechSynthesis(TextToSpeech) {
  let voices = [];
  const listeners = new Set();
  let queue = [];
  let current = null;
  let token = 0;

  class Utterance {
    constructor(text = "") {
      Object.assign(this, { text, lang: "", rate: 1, pitch: 1, volume: 1, voice: null, onstart: null, onend: null, onerror: null, onboundary: null });
    }
  }

  const synth = {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    getVoices: () => voices,
    addEventListener: (type, fn) => { if (type === "voiceschanged") listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === "voiceschanged") listeners.delete(fn); },
    speak(u) { queue.push(u); synth.pending = queue.length > 0; drain(); },
    cancel() {
      token++;
      const was = current;
      queue = []; current = null; synth.speaking = false; synth.pending = false;
      TextToSpeech.stop().catch(() => {});
      if (was) was.onerror?.({ error: "interrupted", utterance: was });
    },
    pause() {}, resume() {},
  };

  const drain = () => {
    if (current || !queue.length) return;
    const u = current = queue.shift();
    const mine = ++token;
    synth.speaking = true; synth.pending = queue.length > 0;
    u.onstart?.({ utterance: u });
    const voiceIndex = u.voice ? voices.indexOf(u.voice) : -1;
    TextToSpeech.speak({
      text: String(u.text || ""),
      lang: u.voice?.lang || u.lang || "en-US",
      rate: Math.min(2, Math.max(0.1, Number(u.rate) || 1)),
      pitch: Math.min(2, Math.max(0.5, Number(u.pitch) || 1)),
      volume: Math.min(1, Math.max(0, u.volume ?? 1)),
      ...(voiceIndex >= 0 ? { voice: voiceIndex } : {}),
      queueStrategy: 0,
    }).then(() => {
      if (mine !== token) return;
      current = null; synth.speaking = false;
      u.onend?.({ utterance: u });
      drain();
    }).catch(err => {
      if (mine !== token) return;
      current = null; synth.speaking = false;
      u.onerror?.({ error: err?.message || "synthesis-failed", utterance: u });
      drain();
    });
  };

  TextToSpeech.getSupportedVoices().then(({ voices: list }) => {
    voices = (list || []).map(v => ({ name: v.name, lang: v.lang, voiceURI: v.voiceURI || v.name, default: !!v.default, localService: v.localService !== false }));
    const ev = { type: "voiceschanged" };
    synth.onvoiceschanged?.(ev);
    listeners.forEach(fn => { try { fn(ev); } catch { /* listener error */ } });
  }).catch(() => {});

  try { Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true }); } catch { window.speechSynthesis = synth; }
  window.SpeechSynthesisUtterance = Utterance;
}

// ── Speech recognition ──
// Matches the parts of the Web Speech API KROFT uses: lang, continuous, interimResults, start(),
// stop(), abort(), and onstart/onresult/onerror/onend with e.results[i][0].transcript and isFinal.
function installSpeechRecognition(SR) {
  let active = null;

  class NativeRecognition {
    constructor() {
      Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onstart: null, onresult: null, onerror: null, onend: null });
      this._handles = []; this._text = ""; this._done = true; this._timer = null;
    }
    _emit(isFinal) {
      const alt = { transcript: this._text, confidence: isFinal ? 0.9 : 0.5 };
      const result = Object.assign([alt], { isFinal, length: 1 });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
    _finish(error) {
      if (this._done) return;
      this._done = true;
      clearTimeout(this._timer);
      this._handles.forEach(h => h.remove?.());
      this._handles = [];
      if (active === this) active = null;
      if (error) this.onerror?.({ error });
      else if (this._text && !this._aborted) this._emit(true);
      this.onend?.({});
    }
    _arm(ms) { clearTimeout(this._timer); this._timer = setTimeout(() => this._finish(this._text ? null : "no-speech"), ms); }
    async start() {
      if (active && active !== this) active.abort();
      active = this;
      this._done = false; this._aborted = false; this._text = "";
      try {
        let perm = await SR.checkPermissions();
        if (perm.speechRecognition !== "granted") perm = await SR.requestPermissions();
        if (perm.speechRecognition !== "granted") return this._finish("not-allowed");
        this._handles.push(await SR.addListener("partialResults", ({ matches }) => {
          if (this._done || !matches?.length) return;
          this._text = matches[0];
          this._emit(false);
          this._arm(this._stopped ? 700 : 8000);
        }));
        this._handles.push(await SR.addListener("listeningState", ({ status }) => {
          if (this._done) return;
          if (status === "stopped") { this._stopped = true; this._arm(1200); }
        }));
        this._stopped = false;
        await SR.start({ language: this.lang || undefined, maxResults: 1, partialResults: true, popup: false });
        this.onstart?.({});
        this._arm(10000); // nothing heard at all: end the session like a browser would
      } catch (err) {
        this._finish(String(err?.message || "").toLowerCase().includes("permission") ? "not-allowed" : "network");
      }
    }
    stop() { if (this._done) return; SR.stop().catch(() => {}); this._arm(900); }
    abort() { if (this._done) return; this._aborted = true; SR.stop().catch(() => {}); this._finish(null); }
  }

  window.SpeechRecognition = NativeRecognition;
  window.webkitSpeechRecognition = NativeRecognition;
}

// Asks Android for the microphone (RECORD_AUDIO) if it hasn't been granted yet.
async function askMic(SR) {
  let perm = await SR.checkPermissions();
  if (perm.speechRecognition !== "granted") perm = await SR.requestPermissions();
  return perm.speechRecognition === "granted";
}

// ── Notifications ──
async function installNotifications(LocalNotifications) {
  class NativeNotification {
    constructor(title, opts = {}) {
      this.title = title; this.body = opts.body || ""; this.tag = opts.tag || ""; this.onclick = null;
      this._id = idFor(`${this.tag}|${title}|${Date.now()}`);
      // A reminder scheduled on the phone (scheduleDeviceReminders) and the app's own in-app check
      // can fire for the same thing while KROFT is open; show it once.
      LocalNotifications.getDeliveredNotifications()
        .then(({ notifications = [] }) => notifications.some(n => n.title === title && n.body === this.body))
        .catch(() => false)
        .then(dupe => dupe ? null : LocalNotifications.schedule({ notifications: [{ id: this._id, title, body: this.body, extra: { tag: this.tag } }] }))
        .catch(() => {});
    }
    close() { LocalNotifications.cancel({ notifications: [{ id: this._id }] }).catch(() => {}); }
    static async requestPermission() {
      const r = await LocalNotifications.requestPermissions();
      NativeNotification.permission = r.display === "granted" ? "granted" : r.display === "denied" ? "denied" : "default";
      return NativeNotification.permission;
    }
  }
  NativeNotification.permission = "default";
  try {
    const r = await LocalNotifications.checkPermissions();
    NativeNotification.permission = r.display === "granted" ? "granted" : r.display === "denied" ? "denied" : "default";
  } catch { /* stays "default" */ }
  window.Notification = NativeNotification;
}

// ── Location ──
// A WebView's own geolocation often never gets a fix (and on phones without Google services it
// has nothing to ask), so navigator.geolocation is answered by the native plugin instead, which
// asks Android for permission itself and falls back to the phone's GPS/network providers.
const GEO_ERR = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
const geoError = (code, message) => ({ code, message, ...GEO_ERR, fromShim: true });
const toPermState = s => (s === "granted" ? "granted" : s === "denied" ? "denied" : "prompt");

function installGeolocation(Geolocation) {
  const ensure = async () => {
    let p = await Geolocation.checkPermissions().catch(() => ({ location: "prompt" }));
    if (p.location !== "granted" && p.coarseLocation !== "granted") p = await Geolocation.requestPermissions();
    return p.location === "granted" || p.coarseLocation === "granted";
  };
  const toError = err => {
    const msg = String(err?.message || err || "");
    if (/denied|permission/i.test(msg)) return geoError(1, "Location permission denied");
    if (/timeout|timed out/i.test(msg)) return geoError(3, "Timed out");
    if (/disabled|not enabled|turned off|services/i.test(msg)) return geoError(2, "Location is turned off");
    return geoError(2, msg || "Position unavailable");
  };
  const toPosition = p => ({ coords: { ...p.coords }, timestamp: p.timestamp || Date.now() });
  const opts = o => ({ enableHighAccuracy: !!o?.enableHighAccuracy, timeout: o?.timeout ?? 15000, maximumAge: o?.maximumAge ?? 0, enableLocationFallback: true });
  const watches = new Map();
  let nextWatch = 1;

  const geo = {
    getCurrentPosition(ok, fail, o) {
      ensure()
        .then(granted => {
          if (!granted) throw geoError(1, "Location permission denied");
          return Geolocation.getCurrentPosition(opts(o));
        })
        .then(p => ok?.(toPosition(p)))
        .catch(err => fail?.(err?.fromShim ? err : toError(err)));
    },
    watchPosition(ok, fail, o) {
      const id = nextWatch++;
      ensure().then(async granted => {
        if (!granted) return fail?.(geoError(1, "Location permission denied"));
        if (!watches.has(id)) return; // cleared before permission came back
        const nativeId = await Geolocation.watchPosition(opts(o), (p, err) => (err ? fail?.(toError(err)) : p && ok?.(toPosition(p))));
        if (watches.has(id)) watches.set(id, nativeId); else Geolocation.clearWatch({ id: nativeId }).catch(() => {});
      }).catch(err => fail?.(toError(err)));
      watches.set(id, null);
      return id;
    },
    clearWatch(id) {
      const nativeId = watches.get(id);
      watches.delete(id);
      if (nativeId) Geolocation.clearWatch({ id: nativeId }).catch(() => {});
    },
  };
  try { Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true }); } catch { /* read-only: keep the WebView's */ }
  return ensure;
}

// navigator.permissions.query answers for location and the microphone from Android's own
// permission state, so "already allowed" checks in the app match what the phone says.
function installPermissionsQuery({ Geolocation, SpeechRecognition }) {
  const original = navigator.permissions?.query?.bind(navigator.permissions);
  const status = state => ({ state, onchange: null, addEventListener() {}, removeEventListener() {} });
  const query = async desc => {
    if (desc?.name === "geolocation") {
      const p = await Geolocation.checkPermissions();
      return status(p.location === "granted" || p.coarseLocation === "granted" ? "granted" : toPermState(p.location));
    }
    if (desc?.name === "microphone") return status(toPermState((await SpeechRecognition.checkPermissions()).speechRecognition));
    if (original) return original(desc);
    throw new TypeError("Unsupported permission");
  };
  if (navigator.permissions) {
    try { Object.defineProperty(navigator.permissions, "query", { value: query, configurable: true }); } catch { /* keep the WebView's */ }
  } else {
    try { Object.defineProperty(navigator, "permissions", { value: { query }, configurable: true }); } catch { /* none */ }
  }
}

// ── Permissions overview (Profile > Security) ──
// The current Android permission state for what KROFT uses, and a way to ask for one.
export async function getAppPermissions() {
  if (!isNativeApp) return null;
  const p = await plugins;
  const safe = (plugin, f) => (hasPlugin(plugin) ? f().catch(() => "prompt") : Promise.resolve("prompt"));
  const [microphone, location, notifications] = await Promise.all([
    safe("SpeechRecognition", async () => toPermState((await p.SpeechRecognition.checkPermissions()).speechRecognition)),
    safe("Geolocation", async () => { const r = await p.Geolocation.checkPermissions(); return r.location === "granted" || r.coarseLocation === "granted" ? "granted" : toPermState(r.location); }),
    safe("LocalNotifications", async () => toPermState((await p.LocalNotifications.checkPermissions()).display)),
  ]);
  return { microphone, location, notifications };
}

export async function requestAppPermission(kind) {
  if (!isNativeApp) return "prompt";
  const p = await plugins;
  const needs = { microphone: "SpeechRecognition", location: "Geolocation", notifications: "LocalNotifications" }[kind];
  if (needs && !hasPlugin(needs)) return "needs-update";
  try {
    if (kind === "microphone") return toPermState((await p.SpeechRecognition.requestPermissions()).speechRecognition);
    if (kind === "location") { const r = await p.Geolocation.requestPermissions(); return r.location === "granted" || r.coarseLocation === "granted" ? "granted" : toPermState(r.location); }
    if (kind === "notifications") {
      const state = toPermState((await p.LocalNotifications.requestPermissions()).display);
      if (window.Notification) window.Notification.permission = state === "prompt" ? "default" : state;
      return state;
    }
  } catch { /* fall through */ }
  return "denied";
}

// ── Biometric unlock ──
// Android's own fingerprint / face prompt. WebAuthn (what the website uses) doesn't exist inside
// an Android WebView. Resolves { ok:true } after a successful check, or { ok:false, reason }.
export async function biometricStatus() {
  if (!hasPlugin("NativeBiometric")) return { available: false };
  const { NativeBiometric } = await plugins;
  try {
    const r = await NativeBiometric.isAvailable({ useFallback: false });
    return { available: !!r.isAvailable, code: r.errorCode };
  } catch (err) {
    return { available: false, code: err?.code };
  }
}

export async function verifyBiometric(title = "Unlock KROFT") {
  if (!isNativeApp) return { ok: false, reason: "unsupported" };
  if (!hasPlugin("NativeBiometric")) return { ok: false, reason: "needs-update" };
  const status = await biometricStatus();
  if (!status.available) {
    // BiometricAuthError: 3 = nothing enrolled, 14 = no screen lock set
    const c = Number(status.code);
    return { ok: false, reason: c === 3 || c === 14 ? "not-enrolled" : "unsupported" };
  }
  const { NativeBiometric } = await plugins;
  try {
    await NativeBiometric.verifyIdentity({ title, subtitle: "Confirm it's you", negativeButtonText: "Cancel", maxAttempts: 5 });
    return { ok: true };
  } catch (err) {
    const c = Number(err?.code);
    return { ok: false, reason: c === 2 || c === 4 ? "locked-out" : "cancelled" };
  }
}

// ── Saving files ──
// An Android WebView ignores <a download> (nothing happens at all), so backups, CSV exports and
// documents are written to the app's cache and handed to the share sheet, where the person can
// save them to Files/Drive or send them on. Returns false if they closed the sheet.
// Binary files (a PDF) are passed as { base64 } instead of text; `text` goes with the file where
// the chosen app supports it (WhatsApp shows it as the message).
export async function saveFileFromApp(filename, content, { base64 = null, text = "" } = {}) {
  if (!isNativeApp) return false;
  if (!hasPlugin("Filesystem") || !hasPlugin("Share")) throw Object.assign(new Error("This version of the app can't save files"), { code: "needs-update" });
  const { Filesystem, Share } = await plugins;
  const name = String(filename || "kroft-file.txt").replace(/[\\/:*?"<>|]+/g, "_");
  const { uri } = base64
    ? await Filesystem.writeFile({ path: `exports/${name}`, data: base64, directory: "CACHE", recursive: true })
    : await Filesystem.writeFile({ path: `exports/${name}`, data: String(content ?? ""), directory: "CACHE", encoding: "utf8", recursive: true });
  try {
    await Share.share({ title: name, files: [uri], ...(text ? { text } : {}), dialogTitle: "Save or send" });
    return true;
  } catch (err) {
    if (/cancel/i.test(String(err?.message || ""))) return false;
    throw err;
  }
}

// ── Exact reminder times ──
// Android 12+ only fires reminders on the minute if "Alarms & reminders" is allowed for the app
// (off by default on Android 14). Without it reminders still come, just possibly a few minutes late.
export async function exactAlarmStatus() {
  if (!hasPlugin("LocalNotifications")) return "granted";
  const { LocalNotifications } = await plugins;
  try { return toPermState((await LocalNotifications.checkExactNotificationSetting()).exact_alarm); } catch { return "granted"; }
}
export async function openExactAlarmSetting() {
  if (!hasPlugin("LocalNotifications")) return "granted";
  const { LocalNotifications } = await plugins;
  try { return toPermState((await LocalNotifications.changeExactNotificationSetting()).exact_alarm); } catch { return "denied"; }
}

// Sends a deep-link result (sign-in tokens, account-linking or payment outcome) into the page the
// same way the website receives it, so the existing handlers in Kroft.jsx process it unchanged.
function handleDeepLink(url, Browser) {
  if (!url || !url.startsWith(`${APP_SCHEME}://`)) return;
  Browser.close().catch(() => {});
  const rest = url.slice(`${APP_SCHEME}://`.length);
  const at = rest.search(/[?#]/);
  const suffix = at >= 0 ? rest.slice(at) : "";
  window.location.href = `${window.location.origin}/${suffix}`;
}

// Exported for tests (src/native.test.mjs); the app only calls installNativeShims().
export const _internals = { installSpeechSynthesis, installSpeechRecognition, installNotifications, installGeolocation, installPermissionsQuery, idFor, loadShellInfo };

// The app's version and which plugins it contains, read once at start-up.
async function loadShellInfo(App) {
  let version = "unknown", build = 0;
  if (hasPlugin("App")) {
    try { const info = await App.getInfo(); version = info.version || version; build = Number(info.build) || 0; } catch { /* keep unknown */ }
  }
  const plugins = Object.keys(PLUGIN_CODES).filter(hasPlugin);
  shellInfo = { version, build, plugins };
  clientHeader = `android;shell=${version};build=${build};web=${WEB_BUILD};plugins=${plugins.map(n => PLUGIN_CODES[n]).join(",")}`;
  return shellInfo;
}

// Each stand-in is installed only when the installed app has its plugin; otherwise the WebView's
// own behaviour stays (which may simply not work, but no longer breaks what was there before).
export async function installNativeShims() {
  if (!isNativeApp) return;
  const p = await plugins;
  await loadShellInfo(p.App);
  if (hasPlugin("TextToSpeech")) installSpeechSynthesis(p.TextToSpeech);
  if (hasPlugin("SpeechRecognition")) {
    // Phones sold without Google services (Huawei and others) have no speech recognizer for the
    // plugin to use; there the mic records and KROFT's server transcribes instead.
    const { available } = await p.SpeechRecognition.available().catch(() => ({ available: false }));
    if (available) installSpeechRecognition(p.SpeechRecognition);
    else {
      const Rec = createRecorderRecognition({ ensurePermission: () => askMic(p.SpeechRecognition) });
      window.SpeechRecognition = Rec;
      window.webkitSpeechRecognition = Rec;
    }
  }
  if (hasPlugin("Geolocation")) installGeolocation(p.Geolocation);
  if (hasPlugin("Geolocation") && hasPlugin("SpeechRecognition")) installPermissionsQuery(p);
  if (hasPlugin("LocalNotifications")) await installNotifications(p.LocalNotifications);
  if (hasPlugin("Share")) navigator.share = async data => { await p.Share.share({ title: data?.title, text: data?.text, url: data?.url, dialogTitle: "Share" }); };

  if (hasPlugin("App")) {
    p.App.addListener("appUrlOpen", ({ url }) => handleDeepLink(url, p.Browser));
    // Android's back button: go back within KROFT's own pages (e.g. Privacy policy) where
    // possible, otherwise send the app to the background rather than closing it mid-task.
    p.App.addListener("backButton", ({ canGoBack }) => { if (canGoBack) window.history.back(); else p.App.minimizeApp(); });
  }
}
