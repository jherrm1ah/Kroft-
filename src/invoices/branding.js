// KROFT Pro branding on documents: the business's own logo at the top of every invoice, quote,
// receipt and statement, and no "Created with KROFT" line at the bottom.
//
// The logo is saved with the invoice details (settings.logo, a small JPEG data URL) so it syncs
// with the rest of the finance data. Only Pro can add one, and it only prints while the person is
// on Pro: if Pro ends it stops printing, and comes back if they pay again, with nothing to re-upload.
//
// The rules are plain functions so they can be tested; shrinkLogo needs a browser.

export const LOGO_MAX_SIDE = 480;               // pixels: sharp on an A4 page at the size it's printed
export const LOGO_MAX_CHARS = 200_000;          // about 150 KB: keeps the synced finance data small
export const LOGO_BOX = { width: 150, height: 56 };   // the most room a logo takes on the page, in points

export const isLogo = s => typeof s === "string" && /^data:image\/(jpeg|png);base64,[\w+/=]+$/.test(s) && s.length <= LOGO_MAX_CHARS;

// What a document shows for this plan: { logo, footer }. logo is the data URL or "".
export function brandingFor(plan, settings = {}) {
  const pro = plan === "pro";
  return { logo: pro && isLogo(settings.logo) ? settings.logo : "", footer: !pro };
}

// The logo's printed size: as big as fits the box, never stretched or enlarged past its pixels.
export function logoSize(width, height, box = LOGO_BOX) {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(box.width / width, box.height / height, 1);
  return { width: Math.round(width * scale * 100) / 100, height: Math.round(height * scale * 100) / 100 };
}

// What to tell the person when a picture can't be used.
export const LOGO_PROBLEM = {
  "not-image": "That file isn't a picture KROFT can use. Try a PNG or JPG.",
  "too-big": "That logo is too detailed to store. Try a simpler or smaller picture.",
};

// A chosen file → a small JPEG data URL on a white background (PDF pages are white, so
// transparent logos look the same). Browser only. Rejects with an Error whose message is a
// LOGO_PROBLEM key.
export function shrinkLogo(file, maxSide = LOGO_MAX_SIDE) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || "")) { reject(new Error("not-image")); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let out = canvas.toDataURL("image/jpeg", 0.9);
      if (!isLogo(out)) out = canvas.toDataURL("image/jpeg", 0.75);
      if (isLogo(out)) resolve(out); else reject(new Error("too-big"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not-image")); };
    img.src = url;
  });
}

// A data URL → a decoded image ready to draw on a canvas, or null if it can't be read. Browser only.
export function loadLogo(dataUrl) {
  if (!isLogo(dataUrl)) return Promise.resolve(null);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.width && img.height ? img : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
