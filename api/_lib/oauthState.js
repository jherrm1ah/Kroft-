// Signed OAuth state — shared by every OAuth-based integration (Google, Microsoft), since the
// problem it solves isn't provider-specific: an OAuth callback is a top-level browser redirect
// from the provider, so it has no Authorization header to identify the user by. The state
// parameter handed to the provider at the start of the flow carries the user's id instead,
// signed with HMAC-SHA256 so it can't be forged into attaching stolen tokens to someone else's
// account, and time-boxed so an old state can't be replayed later.
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return atob(padded);
}

export async function signState(payload) {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(process.env.OAUTH_STATE_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyState(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(process.env.OAUTH_STATE_SECRET);
  const expectedSigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const givenSigBytes = Uint8Array.from(fromBase64Url(sig), (c) => c.charCodeAt(0));
  if (expectedSigBytes.length !== givenSigBytes.length) return null;
  // Constant-time compare — a plain === on the decoded signature would leak timing
  // information about how many leading bytes matched, letting an attacker forge a valid
  // signature byte-by-byte over many requests.
  let diff = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) diff |= expectedSigBytes[i] ^ givenSigBytes[i];
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(fromBase64Url(body));
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
