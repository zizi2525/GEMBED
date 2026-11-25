"use client";

import { useEffect, useRef } from "react";
import {
  getTurnstileProof,
  getTurnstileProofExpiresAt,
  getTurnstileSiteKey,
  isTurnstileConfigured,
  setTurnstileProof,
} from "@/lib/turnstile";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string;
          appearance?: "always" | "execute" | "interaction-only";
          execution?: "render" | "execute";
          size?: "normal" | "compact" | "flexible";
          callback?: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
        }
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-api";

export function TurnstileGate() {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isTurnstileConfigured()) return;
    const siteKey = getTurnstileSiteKey();
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let scriptEl: HTMLScriptElement | null = null;
    let onLoadHandler: (() => void) | null = null;

    const scheduleRefresh = (expiresAtMs: number) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      const refreshIn = Math.max(60_000, expiresAtMs - Date.now() - 60_000);
      refreshTimer = setTimeout(() => {
        if (cancelled) return;
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.reset(widgetIdRef.current);
        } else {
          startChallenge();
        }
      }, refreshIn);
    };

    const verifyToken = async (token: string) => {
      try {
        const res = await fetch("/api/turnstile/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          success?: boolean;
          proof?: string;
          expiresAt?: number;
        };
        if (data?.success && data.proof) {
          const exp = data.expiresAt || Date.now() + 14 * 60_000;
          setTurnstileProof(data.proof, exp);
          scheduleRefresh(exp);
        }
      } catch {
        // Silent retry on next refresh
      }
    };

    const mountWidget = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance: "interaction-only",
        execution: "render",
        callback: (token) => {
          void verifyToken(token);
        },
        "expired-callback": () => {
          setTurnstileProof(null);
          if (widgetIdRef.current && window.turnstile) {
            window.turnstile.reset(widgetIdRef.current);
          }
        },
        "error-callback": () => {
          setTurnstileProof(null);
        },
      });
    };

    const startChallenge = () => {
      if (runningRef.current) return;
      runningRef.current = true;

      if (window.turnstile) {
        mountWidget();
        return;
      }

      scriptEl = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (!scriptEl) {
        scriptEl = document.createElement("script");
        scriptEl.id = SCRIPT_ID;
        scriptEl.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        scriptEl.async = true;
        scriptEl.defer = true;
        document.head.appendChild(scriptEl);
      }
      onLoadHandler = () => mountWidget();
      scriptEl.addEventListener("load", onLoadHandler);
    };

    // Reuse existing valid proof from sessionStorage instead of re-running
    // Cloudflare challenge on every route change, episode switch, or iframe reload.
    const existing = getTurnstileProof();
    const exp = getTurnstileProofExpiresAt();
    if (existing && exp > Date.now() + 60_000) {
      scheduleRefresh(exp);
    } else {
      startChallenge();
    }

    return () => {
      cancelled = true;
      runningRef.current = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (scriptEl && onLoadHandler) {
        scriptEl.removeEventListener("load", onLoadHandler);
      }
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  if (!isTurnstileConfigured()) return null;

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none fixed bottom-2 right-2 z-50 opacity-0"
    />
  );
}
