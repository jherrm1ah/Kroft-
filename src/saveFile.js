// Saving a file the person asked for (finance CSV, backup, document, invoice PDF), the same way
// everywhere:
//   - Android app: written to the phone and handed to the share sheet (the app's WebView can't
//     download at all; see saveFileFromApp in native.js).
//   - Phone browsers: the share sheet (Save to Files/Drive, WhatsApp, email). Phone browsers and
//     installed web apps often drop or hide a script-started download, so a "downloaded" message
//     could appear with no file anywhere.
//   - Computers: a normal download.
// Returns "shared", "downloaded" or "cancelled". Throws { code:"needs-update" } on an Android app
// too old to save files.

import { isNativeApp, saveFileFromApp } from "./native.js";

const toBytes = data => (typeof data === "string" ? new TextEncoder().encode(data) : data);

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A phone or tablet (touch is the main input), where the share sheet is the dependable way to
// get a file somewhere useful.
export const isPhoneLike = () => {
  try { return !!(navigator.userAgentData?.mobile || window.matchMedia?.("(pointer: coarse)").matches); } catch { return false; }
};

// The download itself. The object URL must outlive the click: revoking it straight away cancels
// the download in Chrome on Android while the page still reports success.
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}

export async function saveFile({ name, data, type = "application/octet-stream", text = "", title = name }) {
  const bytes = toBytes(data);
  if (isNativeApp) {
    const binary = typeof data !== "string";
    const shared = await saveFileFromApp(name, binary ? null : data, { base64: binary ? bytesToBase64(bytes) : null, text });
    return shared ? "shared" : "cancelled";
  }
  const file = new File([bytes], name, { type });
  if (isPhoneLike() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, ...(text ? { text } : {}) });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Share sheet unavailable after all (some in-app browsers): fall back to downloading.
    }
  }
  downloadBlob(file, name);
  return "downloaded";
}
