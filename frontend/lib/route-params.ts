/** Shared parsing for the player's embed query parameters. */

export type QueryMap = Record<string, string | undefined>;

/**
 * Start position in seconds. Accepts `progress` (seconds), `t` or `startAt`
 * with either plain seconds or a compound duration such as `1h5m30s`.
 */
export function parseStartTime(sp: QueryMap): number {
  const raw = sp.startAt ?? sp.t ?? sp.progress;
  if (!raw) return 0;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return isFinite(seconds) && seconds > 0 ? seconds : 0;
  }
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match) return 0;
  const seconds =
    (Number(match[1]) || 0) * 3600 +
    (Number(match[2]) || 0) * 60 +
    (Number(match[3]) || 0);
  return seconds > 0 ? seconds : 0;
}

/** Accent colour from `color`, `theme` or `accent` (with or without `#`). */
export function resolveAccentColor(sp: QueryMap): string | undefined {
  const raw = sp.color || sp.theme || sp.accent;
  if (!raw) return undefined;
  const hex = String(raw).replace("#", "").trim();
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function isFalsy(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "no";
}

/** `autoplay` defaults to on, as before. */
export function resolveAutoplay(sp: QueryMap): boolean {
  return !isFalsy(sp.autoplay);
}

/** `episodes` / `episodeSelector`: the in-player episode browser. */
export function resolveShowEpisodes(sp: QueryMap): boolean {
  if (isFalsy(sp.episodes) || isFalsy(sp.episodeSelector)) return false;
  return true;
}

/** `autonext` / `autoplayNextEpisode`: countdown into the next episode. */
export function resolveAutoNext(sp: QueryMap): boolean {
  if (isFalsy(sp.autonext) || isFalsy(sp.autoplayNextEpisode)) return false;
  return true;
}

/** `anime`: enable anime mode (AniList / Megaplay resolver). */
export function resolveAnime(sp: QueryMap): boolean {
  return isTruthy(sp.anime);
}

