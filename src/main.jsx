import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./storageShim.js";
import Kroft from "./Kroft.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Kroft />
  </StrictMode>
);

// The service worker (public/sw.js) caches the app so it opens offline. Registered after the page
// has loaded so it never competes with the first load, and only in production builds: during
// development a cached copy would hide code changes.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* offline support is a bonus */ });
  });
}
