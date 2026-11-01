import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./storageShim.js";
import Kroft from "./Kroft.jsx";
import { isNativeApp, installNativeShims } from "./native.js";

const mount = () => createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Kroft />
  </StrictMode>
);

// In the Android app, native stand-ins for speech, notifications and sharing are installed first
// (see native.js) so the app's feature checks see them from its very first render. In a browser
// this is skipped and the app mounts straight away.
if (isNativeApp) installNativeShims().catch(() => {}).finally(mount);
else mount();

// The service worker (public/sw.js) caches the app so it opens offline. Registered after the page
// has loaded so it never competes with the first load, and only in production builds: during
// development a cached copy would hide code changes.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support is a bonus */ });
  });
}
