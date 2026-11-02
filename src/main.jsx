import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./storageShim.js";
import Kroft from "./Kroft.jsx";
import { isNativeApp, installNativeShims, getClientHeader } from "./native.js";
import { installErrorLog } from "./errorLog.js";
import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { createRecorderRecognition } from "./voiceRecorder.js";
import { watchForNewVersion } from "./webUpdate.js";
import { unlockSounds } from "./sounds/player.js";

// Browsers only allow sound after a tap on the page. Unlocking on the first one means sounds that
// happen on their own later (a reminder alarm, a notification while KROFT is open) can play.
window.addEventListener("pointerdown", unlockSounds, { once: true, capture: true });

// Crashes, unexpected errors and failed saves go to KROFT's error log (src/errorLog.js), cleaned
// of anything personal, so problems are seen before anyone has to report them. Live site only.
if (import.meta.env.PROD) installErrorLog({
  getClient: getClientHeader,
  getToken: async () => (isSupabaseConfigured ? (await supabase.auth.getSession()).data?.session?.access_token || null : null),
});

const mount = () => createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Kroft />
  </StrictMode>
);

// In the Android app, native stand-ins for speech, notifications and sharing are installed first
// (see native.js) so the app's feature checks see them from its very first render. In a browser
// this is skipped and the app mounts straight away.
if (isNativeApp) installNativeShims().catch(() => {}).finally(mount);
else {
  // Browsers with no speech recognizer of their own (Firefox) still get working mic buttons: the
  // clip is recorded and transcribed by KROFT's server (see voiceRecorder.js).
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)) {
    window.SpeechRecognition = createRecorderRecognition();
  }
  mount();
}

// A copy left open for days picks up the newest deployed version when someone comes back to it.
if (import.meta.env.PROD) watchForNewVersion();

// The service worker (public/sw.js) caches the app so it opens offline. Registered after the page
// has loaded so it never competes with the first load, and only in production builds: during
// development a cached copy would hide code changes.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support is a bonus */ });
  });
}
