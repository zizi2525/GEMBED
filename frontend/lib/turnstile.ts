/**
 * Client-side Cloudflare Turnstile proof state.
 *
 * The invisible TurnstileGate component populates a short-lived HMAC-signed
 * proof token (issued by /api/turnstile/verify) and caches it in sessionStorage
 * so page navigations, episode changes, and embedded iframes reuse the verified
 * proof instead of re-running the Cloudflare challenge on every load.
 */

const SITE_KEY = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "").trim();
const STORAGE_KEY = "gembed:ts_proof";

let currentProof: string | null = null;
let proofExpiresAt = 0;
let waiters: Array<(proof: string | null) => void> = [];

function readStoredProof(): { proof: string; expiresAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { proof?: string; expiresAt?: number };
    if (
      typeof parsed?.proof === "string" &&
      typeof parsed?.expiresAt === "number" &&
      Date.now() < parsed.expiresAt - 15_000
    ) {
      return { proof: parsed.proof, expiresAt: parsed.expiresAt };
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors (e.g. sandboxed iframe)
  }
  return null;
}

export function getTurnstileSiteKey(): string {
  return SITE_KEY;
}

export function isTurnstileConfigured(): boolean {
  return SITE_KEY.length > 0;
}

export function setTurnstileProof(proof: string | null, expiresAtMs?: number): void {
  currentProof = proof;
  proofExpiresAt = expiresAtMs || (proof ? Date.now() + 14 * 60_000 : 0);

  if (typeof window !== "undefined") {
    try {
      if (proof) {
        window.sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ proof, expiresAt: proofExpiresAt })
        );
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }

  if (proof && waiters.length > 0) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(proof);
  }
}

export function getTurnstileProof(): string | null {
  if (currentProof && (!proofExpiresAt || Date.now() <= proofExpiresAt - 15_000)) {
    return currentProof;
  }
  const stored = readStoredProof();
  if (stored) {
    currentProof = stored.proof;
    proofExpiresAt = stored.expiresAt;
    return currentProof;
  }
  return null;
}

export function getTurnstileProofExpiresAt(): number {
  getTurnstileProof();
  return proofExpiresAt;
}

/**
 * Waits briefly for the invisible Turnstile challenge to complete if it is
 * still running on initial page load. Returns null if Turnstile is not
 * configured or if the timeout elapses.
 */
export async function waitForTurnstileProof(timeoutMs = 5000): Promise<string | null> {
  if (!isTurnstileConfigured() || typeof window === "undefined") return null;
  const existing = getTurnstileProof();
  if (existing) return existing;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve(getTurnstileProof());
    }, timeoutMs);

    const done = (proof: string | null) => {
      clearTimeout(timer);
      resolve(proof);
    };
    waiters.push(done);
  });
}
