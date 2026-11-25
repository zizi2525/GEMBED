/**
 * Cloudflare Turnstile verification & proof-token utility.
 *
 * Supports two verification paths on protected API routes:
 *  1. `x-turnstile-proof`: HMAC-SHA256 signed short-lived proof minted by
 *     `/api/turnstile/verify` (shared APP_SECRET between frontend & backend).
 *  2. `x-turnstile-token`: Raw Cloudflare Turnstile response token verified
 *     directly against Cloudflare's `siteverify` endpoint.
 */

const crypto = require('crypto');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const PROOF_TTL_SECONDS = 15 * 60; // 15 minutes

// Short in-memory cache of already-verified raw Turnstile tokens (single-use tokens
// verified once can be accepted briefly if retried within 30s, or use proof token).
const verifiedTokenCache = new Map();

function getAppSecret() {
  return (
    process.env.APP_SECRET ||
    'dev-only-insecure-secret-change-me-please-0123456789'
  );
}

function getTurnstileSecret() {
  return (process.env.TURNSTILE_SECRET_KEY || '').trim();
}

function isTurnstileEnabled() {
  const flag = (process.env.TURNSTILE_ENABLED || '').trim().toLowerCase();
  return flag === 'true' || flag === '1';
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signProof(ttlSeconds = PROOF_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(Buffer.from(JSON.stringify({ k: 'turnstile', exp })));
  const sig = b64url(crypto.createHmac('sha256', getAppSecret()).update(payload).digest());
  return { proof: `${payload}.${sig}`, expiresAt: exp * 1000 };
}

function verifyTurnstileProof(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;

  const expected = b64url(
    crypto.createHmac('sha256', getAppSecret()).update(payload).digest()
  );
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  try {
    const body = JSON.parse(b64urlToBuf(payload).toString('utf8'));
    if (body.k !== 'turnstile') return false;
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyTurnstileToken(token, remoteIp = null) {
  const secret = getTurnstileSecret();
  if (!secret || !token || typeof token !== 'string') {
    return { success: false, error: 'MISSING_TOKEN_OR_SECRET' };
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const cached = verifiedTokenCache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) {
    return { success: true, cached: true };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp && remoteIp !== '127.0.0.1' && remoteIp !== '::1') {
    form.set('remoteip', remoteIp);
  }

  const res = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    return { success: false, error: `SITEVERIFY_HTTP_${res.status}` };
  }

  const data = await res.json();
  if (!data || !data.success) {
    return {
      success: false,
      error: 'TURNSTILE_FAILED',
      codes: data?.['error-codes'] || [],
    };
  }

  verifiedTokenCache.set(tokenHash, { expiresAt: Date.now() + 30_000 });
  if (verifiedTokenCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of verifiedTokenCache.entries()) {
      if (v.expiresAt <= now) verifiedTokenCache.delete(k);
    }
  }

  return { success: true, hostname: data.hostname };
}

async function turnstileMiddleware(req, res, next) {
  if (!isTurnstileEnabled()) return next();

  const proof = req.headers['x-turnstile-proof'];
  if (proof && verifyTurnstileProof(String(proof))) {
    return next();
  }

  const rawToken =
    req.headers['x-turnstile-token'] ||
    (typeof req.query.turnstileToken === 'string' ? req.query.turnstileToken : null);

  if (rawToken) {
    const clientIp =
      (typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : null) ||
      req.socket?.remoteAddress ||
      null;
    try {
      const check = await verifyTurnstileToken(String(rawToken), clientIp);
      if (check.success) return next();
    } catch {}
  }

  return res.status(403).json({
    success: false,
    error: 'BOT_VERIFICATION_REQUIRED',
    message: 'Cloudflare Turnstile verification required.',
  });
}

module.exports = {
  isTurnstileEnabled,
  signProof,
  verifyTurnstileProof,
  verifyTurnstileToken,
  turnstileMiddleware,
};
