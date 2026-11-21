"use client";

/**
 * Small device-local store for the player: where the viewer stopped, which
 * quality they picked, and how far they got in each episode. Everything stays
 * in localStorage so resume works without the embedding page passing
 * `?progress=` and without any backend.
 */

const RESUME_PREFIX = "gibox:resume:";
const QUALITY_KEY = "gibox:quality";
const EPISODE_PREFIX = "gibox:episodes:";

export interface ResumePoint {
  time: number;
  duration: number;
  at: number;
}

export interface EpisodeProgress {
  time: number;
  duration: number;
}

function readJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled or full */
  }
}

function remove(key: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function readResume(key: string): ResumePoint | null {
  const saved = readJson<ResumePoint>(RESUME_PREFIX + key);
  if (!saved || typeof saved.time !== "number" || !isFinite(saved.time)) return null;
  if (saved.time < 10) return null;
  if (saved.duration > 0 && saved.time >= saved.duration - 10) return null;
  return saved;
}

export function writeResume(key: string, time: number, duration: number) {
  if (!isFinite(time) || time < 10) return;
  // Near the end the title counts as watched: don't resume into the credits.
  if (duration > 0 && time >= duration - 15) {
    remove(RESUME_PREFIX + key);
    return;
  }
  writeJson(RESUME_PREFIX + key, { time, duration, at: Date.now() });
}

export function clearResume(key: string) {
  remove(RESUME_PREFIX + key);
}

export function readQualityPref(): number | "auto" {
  if (typeof window === "undefined") return "auto";
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (!raw || raw === "auto") return "auto";
    const height = Number(raw);
    return isFinite(height) && height > 0 ? height : "auto";
  } catch {
    return "auto";
  }
}

export function writeQualityPref(height: number | "auto") {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(QUALITY_KEY, height === "auto" ? "auto" : String(height));
  } catch {
    /* ignore */
  }
}

function episodeStoreKey(type: string, tmdbId: number) {
  return `${EPISODE_PREFIX}${type}:${tmdbId}`;
}

/** Progress per episode, keyed `season:episode`. */
export function readEpisodeProgress(
  type: string,
  tmdbId: number
): Record<string, EpisodeProgress> {
  return readJson<Record<string, EpisodeProgress>>(episodeStoreKey(type, tmdbId)) || {};
}

export function writeEpisodeProgress(
  type: string,
  tmdbId: number,
  season: number,
  episode: number,
  time: number,
  duration: number
) {
  if (!isFinite(time) || time < 5 || !isFinite(duration) || duration <= 0) return;
  const all = readEpisodeProgress(type, tmdbId);
  all[`${season}:${episode}`] = { time, duration };
  writeJson(episodeStoreKey(type, tmdbId), all);
}
