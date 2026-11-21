/**
 * Smart Skip Intro & Recap Segments Service.
 * Fetches timestamps server-side through internal proxy /api/segments.
 * Strictly masks all upstream provider names.
 */

export interface SegmentInterval {
  start_ms: number | null;
  end_ms: number | null;
  confidence?: number;
}

export interface MediaSegments {
  type?: "tv" | "movie";
  season?: number;
  episode?: number;
  intro?: SegmentInterval[];
  recap?: SegmentInterval[];
  credits?: SegmentInterval[];
}

export interface SkipSegment {
  type: "intro" | "recap" | "credits";
  label: string;
  startSec: number;
  endSec: number;
  targetSec: number | null;
}

export async function fetchSegments(input: {
  tmdbId: number;
  season?: number;
  episode?: number;
}): Promise<MediaSegments | null> {
  const { tmdbId, season, episode } = input;
  if (!tmdbId) return null;

  const params = new URLSearchParams();
  params.set("tmdb", String(tmdbId));
  if (season !== undefined && episode !== undefined) {
    params.set("type", "tv");
    params.set("s", String(season));
    params.set("e", String(episode));
  } else {
    params.set("type", "movie");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`/api/segments?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data: MediaSegments = await res.json();
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if playback time falls within an intro, recap, or credits window.
 */
export function getActiveSkipSegment(
  data: MediaSegments | null,
  currentTimeSec: number
): SkipSegment | null {
  if (!data) return null;

  // 1. Check Intro
  if (data.intro && Array.isArray(data.intro)) {
    for (const item of data.intro) {
      // The source often reports an opening with only an end mark; that means
      // the window starts at 0, so treat a missing start as 0 instead of
      // dropping the segment entirely.
      const startSec = typeof item.start_ms === "number" ? item.start_ms / 1000 : 0;
      const endSec = typeof item.end_ms === "number" ? item.end_ms / 1000 : null;
      if (endSec !== null && endSec > startSec && currentTimeSec >= startSec && currentTimeSec < endSec) {
        return {
          type: "intro",
          label: "Skip Intro",
          startSec,
          endSec,
          targetSec: endSec,
        };
      }
    }
  }

  // 2. Check Recap
  if (data.recap && Array.isArray(data.recap)) {
    for (const item of data.recap) {
      const startSec = typeof item.start_ms === "number" ? item.start_ms / 1000 : 0;
      const endSec = typeof item.end_ms === "number" ? item.end_ms / 1000 : null;
      if (endSec !== null && endSec > startSec && currentTimeSec >= startSec && currentTimeSec < endSec) {
        return {
          type: "recap",
          label: "Skip Recap",
          startSec,
          endSec,
          targetSec: endSec,
        };
      }
    }
  }

  // 3. Check Credits
  if (data.credits && Array.isArray(data.credits)) {
    for (const item of data.credits) {
      if (typeof item.start_ms === "number") {
        const startSec = item.start_ms / 1000;
        const endSec = typeof item.end_ms === "number" ? item.end_ms / 1000 : Infinity;
        if (currentTimeSec >= startSec && currentTimeSec < endSec) {
          return {
            type: "credits",
            label: "Skip Credits",
            startSec,
            endSec,
            targetSec: null,
          };
        }
      }
    }
  }

  return null;
}
