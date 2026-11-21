/**
 * Developer-tools / debugger deterrence.
 *
 * This is a deterrent, not a security boundary: anyone who controls the
 * browser can bypass client-side JavaScript. It stops casual inspection
 * (view-source shortcuts, the inspector, breakpoints) and pauses playback
 * while devtools are open.
 *
 * It is deliberately framework-agnostic and never touches `message` events,
 * so the player's parent-page event listener and command channel keep working
 * exactly as documented.
 */

const SHIELD_ID = "gibox-debug-shield";
const PROBE_INTERVAL = 1200;

type Trap = () => void;

let cachedTrap: Trap | null | undefined;

/**
 * Built at runtime so production minification cannot drop the `debugger`
 * statement. When devtools are closed this is a no-op; when they are open the
 * statement pauses execution and the elapsed time exposes it.
 */
function debugTrap(): Trap | null {
  if (cachedTrap !== undefined) return cachedTrap;
  try {
    // eslint-disable-next-line no-new-func
    cachedTrap = new Function("debugger") as Trap;
  } catch {
    cachedTrap = null;
  }
  return cachedTrap;
}

export function debugProtectionEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_DEBUG_PROTECTION || "").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0" || flag === "no") return false;
  if (flag === "on" || flag === "true" || flag === "1" || flag === "yes") return true;
  // Default: on for real deployments, off for `next dev` so local work stays
  // debuggable.
  return process.env.NODE_ENV === "production";
}

function buildShield(): HTMLDivElement {
  const shield = document.createElement("div");
  shield.id = SHIELD_ID;
  shield.setAttribute("role", "alertdialog");
  shield.setAttribute("aria-label", "Developer tools detected");
  shield.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "flex-direction:column",
    "gap:14px",
    "padding:24px",
    "text-align:center",
    "background:rgba(5,5,7,0.97)",
    "color:#fff",
    "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
    "cursor:default",
    "user-select:none",
  ].join(";");

  const badge = document.createElement("div");
  badge.textContent = "!";
  badge.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "width:46px",
    "height:46px",
    "border-radius:999px",
    "border:1px solid rgba(255,255,255,0.18)",
    "background:rgba(255,255,255,0.06)",
    "font-size:22px",
    "font-weight:700",
  ].join(";");

  const title = document.createElement("p");
  title.textContent = "Close developer tools to continue";
  title.style.cssText = "margin:0;font-size:16px;font-weight:700;letter-spacing:-0.01em";

  const copy = document.createElement("p");
  copy.textContent =
    "Playback is paused while the inspector or debugger is open. This page is protected.";
  copy.style.cssText =
    "margin:0;max-width:420px;font-size:12.5px;line-height:1.65;color:rgba(255,255,255,0.55)";

  shield.appendChild(badge);
  shield.appendChild(title);
  shield.appendChild(copy);
  return shield;
}

export function installDebugGuard(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => { };
  if (!debugProtectionEnabled()) return () => { };
  if (document.documentElement.dataset.giboxDebugGuard === "1") return () => { };
  document.documentElement.dataset.giboxDebugGuard = "1";

  let blocked = false;
  let disposed = false;
  let interval: number | null = null;
  let clearTimer: number | null = null;

  const shield = () => document.getElementById(SHIELD_ID);
  const videos = () => Array.from(document.querySelectorAll("video"));

  const pauseEverything = () => {
    videos().forEach((video) => {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
    });
  };

  const block = () => {
    if (blocked || disposed) return;
    blocked = true;
    document.documentElement.dataset.giboxDebugBlocked = "1";
    if (!shield()) document.documentElement.appendChild(buildShield());
    pauseEverything();
    // Listeners on the page (including the player's postMessage listener) are
    // untouched: only video playback is suspended.
    window.dispatchEvent(new CustomEvent("gibox:debug-blocked"));
  };

  const unblock = () => {
    if (!blocked) return;
    blocked = false;
    delete document.documentElement.dataset.giboxDebugBlocked;
    shield()?.remove();
    window.dispatchEvent(new CustomEvent("gibox:debug-cleared"));
  };

  /* ------------------------- devtools detection ------------------------- */
  const probe = () => {
    if (disposed || document.visibilityState === "hidden") return;
    let open = false;

    // Docked devtools shrink the viewport against the outer window. Only trust
    // this on a desktop-sized, fine-pointer window: mobile toolbars and zoom
    // also change the gap.
    if (
      window.top === window &&
      window.matchMedia?.("(pointer: fine)").matches &&
      window.innerWidth > 500
    ) {
      const widthGap = window.outerWidth - window.innerWidth;
      const heightGap = window.outerHeight - window.innerHeight;
      if (widthGap > 220 || heightGap > 260) open = true;
    }

    if (!open) {
      const trap = debugTrap();
      if (trap) {
        const started = performance.now();
        trap();
        // A breakpoint pause shows up as a huge elapsed time.
        if (performance.now() - started > 120) open = true;
      }
    }

    if (open) {
      block();
    } else if (blocked) {
      // Un-docking devtools can hide the size gap; keep the shield for a moment
      // so a docked/undocked inspector doesn't flicker.
      if (clearTimer) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        if (!disposed) unblock();
      }, 1500);
    }
  };

  /* --------------------------- shortcut lock ---------------------------- */
  const isBlockedShortcut = (event: KeyboardEvent) => {
    const key = (event.key || "").toLowerCase();
    if (key === "f12") return true;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return false;
    if (event.shiftKey && ["i", "j", "c", "k"].includes(key)) return true;
    if (!event.shiftKey && (key === "u" || key === "s")) return true;
    return false;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isBlockedShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    // Leave text fields usable for copy/paste.
    if (target && target.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  };

  const onPlay = (event: Event) => {
    if (!blocked) return;
    const video = event.target as HTMLVideoElement | null;
    if (!video || typeof video.pause !== "function") return;
    try {
      video.pause();
    } catch {
      /* ignore */
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") probe();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("play", onPlay, true);
  document.addEventListener("visibilitychange", onVisibility);
  interval = window.setInterval(probe, PROBE_INTERVAL);
  // First check after the first paint so the shield is not part of hydration.
  window.setTimeout(probe, 900);

  return () => {
    disposed = true;
    if (interval !== null) window.clearInterval(interval);
    if (clearTimer !== null) window.clearTimeout(clearTimer);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("play", onPlay, true);
    document.removeEventListener("visibilitychange", onVisibility);
    shield()?.remove();
    delete document.documentElement.dataset.giboxDebugGuard;
    delete document.documentElement.dataset.giboxDebugBlocked;
  };
}
