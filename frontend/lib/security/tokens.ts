import crypto from "crypto";

/**
 * Server-side signing for the stream/subtitle proxy. Upstream URLs are wrapped
 * in a short-lived HMAC-signed token so /api/stream only ever proxies URLs this
 * server itself minted — it can't be abused as an open proxy. The secret
 * (APP_SECRET) never leaves the server.
 */
const SECRET =
  process.env.APP_SECRET ||
  "dev-only-insecure-secret-change-me-please-0123456789";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function hmac(data: string): string {
  return b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
}

export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const p = b64url(Buffer.from(JSON.stringify(body)));
  return `${p}.${hmac(p)}`;
}

export function verify<T = Record<string, any>>(token: string | null): T | null {
  if (!token || token.indexOf(".") < 0) return null;
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const expected = hmac(p);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  let body: any;
  try {
    body = JSON.parse(b64urlToBuf(p).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return body as T;
}

export interface StreamClaim {
  k: "stream";
  url: string;
  ref?: string; // Referer to send upstream (some CDNs hotlink-lock manifests)
  exp: number;
}

/** Wrap a real upstream stream/subtitle URL so it's proxied, not exposed. */
export function mintStreamToken(url: string, ref?: string): string {
  return sign({ k: "stream", url, ...(ref ? { ref } : {}) }, 60 * 60 * 3); // 3h
}

export interface DashBaseClaim {
  k: "dbase";
  url: string; // the real DASH <BaseURL>, ending in "/"
  ref?: string;
  exp: number;
}

/** Wrap a DASH BaseURL so segment paths can be appended and proxied. */
export function mintDashBase(base: string, ref?: string): string {
  return sign({ k: "dbase", url: base, ...(ref ? { ref } : {}) }, 60 * 60 * 3);
}
