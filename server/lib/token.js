// Minimal signed session tokens (HS256 JWT) using only Node's crypto module.
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** Returns the payload, or null if the token is malformed, tampered with or expired. */
function verify(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest();
  let given;
  try { given = Buffer.from(sig, "base64url"); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString());
    if (h.alg !== "HS256") return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { sign, verify };
