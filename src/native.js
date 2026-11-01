// Native glue for the Android app (Capacitor). The app is the same KROFT web app, loaded from
// https://kroft-pied.vercel.app inside an Android WebView (see capacitor.config.json). A WebView
// lacks a few browser features KROFT relies on, so this file fills them in with native plugins,
// using the same interfaces the existing code already calls:
//
//   speechSynthesis / SpeechSynthesisUtterance -> @capacitor-community/text-to-speech
//   SpeechRecognition                          -> @capacitor-community/speech-recognition
//   Notification                               -> @capacitor/local-notifications
//   navigator.share                            -> @capacitor/share
//
// It also routes sign-in and checkout pages through the system browser (Google refuses to sign in
// inside a WebView) and brings the result back into the app through the com.orynthra.kroft://
// deep link. In a normal browser isNativeApp is false and nothing here runs.

import { Capacitor } from "@capacitor/core";

export const isNativeApp = Capacitor.isNativePlatform();
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
    ]).then(([app, browser, ln, share, tts, sr]) => ({
      App: app.App, Browser: browser.Browser, LocalNotifications: ln.LocalNotifications,
      Share: share.Share, TextToSpeech: tts.TextToSpeech, SpeechRecognition: sr.SpeechRecognition,
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
  if (!isNativeApp) return false;
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
  if (!isNativeApp) return;
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
export const _internals = { installSpeechSynthesis, installSpeechRecognition, installNotifications, idFor };

export async function installNativeShims() {
  if (!isNativeApp) return;
  const p = await plugins;
  installSpeechSynthesis(p.TextToSpeech);
  installSpeechRecognition(p.SpeechRecognition);
  await installNotifications(p.LocalNotifications);
  navigator.share = async data => { await p.Share.share({ title: data?.title, text: data?.text, url: data?.url, dialogTitle: "Share" }); };

  p.App.addListener("appUrlOpen", ({ url }) => handleDeepLink(url, p.Browser));
  // Android's back button: go back within KROFT's own pages (e.g. Privacy policy) where possible,
  // otherwise send the app to the background rather than closing it mid-task.
  p.App.addListener("backButton", ({ canGoBack }) => { if (canGoBack) window.history.back(); else p.App.minimizeApp(); });
}
