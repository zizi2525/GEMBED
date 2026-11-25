// Server-side branding config. Read at runtime from the environment, so
// changing these in .env and restarting is enough — no rebuild required.
// (These are threaded into the player via server components / props, never
// referenced from client code, so they don't need the NEXT_PUBLIC_ prefix.)

export const PLAYER_NAME = process.env.PLAYER_NAME || "Vidsuper";

export const PLAYER_TAGLINE =
  process.env.PLAYER_TAGLINE || "Video streaming player";

/** Brand link used by the homepage header and footer. Empty means no link. */
export const PLAYER_URL = process.env.PLAYER_URL?.trim() || "";

/**
 * The line that replaces upstream subtitle adverts, e.g.
 * "✨ Streamed on Vidsuper · Enjoy the Show".
 * Override with PROMO_TEXT; defaults to the player name.
 */
export const PROMO_TEXT =
  process.env.PROMO_TEXT?.trim() ||
  `✨ Streamed on ${PLAYER_NAME} · Enjoy the Show`;

/** Default accent colour (hex, no leading #). Overridable per-request via ?color= */
export const DEFAULT_ACCENT = (process.env.ACCENT_COLOR || "3b82f6").replace(
  /^#/,
  ""
);

/** Logo path served from /public. Replace public/logo.svg to rebrand. */
export const LOGO_SRC = process.env.LOGO_SRC || "/logo.svg";
