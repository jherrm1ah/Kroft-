// Gmail's API returns message bodies as base64url-encoded MIME parts, not plain text — a
// multipart message (the common case: HTML + plain-text alternative, sometimes nested further
// for inline attachments) needs walking its part tree to find something displayable. This is a
// deliberately modest, best-effort parser: it looks for a text/plain part first, falls back to
// stripping tags from text/html, and gives up to the caller's own fallback (the snippet Gmail
// already provides) rather than trying to handle every real-world MIME edge case (encrypted
// parts, unusual charsets, deeply nested multipart/related images) that a full mail client
// would need to.
function decodeBase64Url(data) {
  if (!data) return "";
  const padded = data.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (data.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

// Exported since Outlook's Graph API also returns HTML-typed bodies (body.contentType==="html")
// needing the same plain-text fallback, without any of Gmail's base64/MIME-part complexity.
export function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Walks payload.parts recursively (multipart/alternative and multipart/mixed both nest this
// way) looking for the best available body. Returns "" if nothing usable was found, letting
// the caller fall back to Gmail's own snippet.
export function extractPlainTextBody(payload) {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).trim();
  }

  if (!payload.mimeType?.startsWith("multipart/") && payload.body?.data) {
    // A non-multipart message with an unlabeled or text/html top-level body.
    const text = decodeBase64Url(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(text) : text.trim();
  }

  const parts = payload.parts || [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data).trim();

  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  if (htmlPart?.body?.data) return stripHtml(decodeBase64Url(htmlPart.body.data));

  // Nested multipart (e.g. multipart/mixed containing a multipart/alternative) — recurse into
  // the first part that itself has sub-parts.
  for (const part of parts) {
    if (part.parts) {
      const nested = extractPlainTextBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

export function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
