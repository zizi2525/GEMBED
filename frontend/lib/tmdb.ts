// TMDB helper. The key stays on the server; it is never exposed to the browser.
const TMDB_KEY = process.env.TMDB_API_KEY || "";

const BASE = "https://api.themoviedb.org/3";

export const img = {
  poster: (
    path: string | null,
    size: "w185" | "w342" | "w500" | "w780" | "original" = "w342"
  ) => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null),
  backdrop: (path: string | null, size: "w780" | "w1280" | "original" = "w1280") =>
    path ? `https://image.tmdb.org/t/p/${size}${path}` : null,
};

export type MediaType = "movie" | "tv";

export interface TmdbItem {
  id: number;
  title: string;
  year: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number;
  runtime: number | null;
}

export interface TmdbDetails {
  id: number;
  imdbId?: string;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  overview: string;
  rating: number;
  runtime: number | null;
  seasons?: Array<{
    id: number;
    season_number: number;
    episode_count: number;
    name: string;
  }>;
}

function normalize(r: any): TmdbItem {
  const date = r.release_date || r.first_air_date || "";
  return {
    id: r.id,
    title: r.title || r.name || "Untitled",
    year: date ? date.slice(0, 4) : "",
    poster: r.poster_path ? img.poster(r.poster_path, "w500") : null,
    backdrop: r.backdrop_path ? img.backdrop(r.backdrop_path, "original") : null,
    overview: r.overview || "",
    rating: r.vote_average || 0,
    runtime: r.runtime ?? (Array.isArray(r.episode_run_time) ? r.episode_run_time[0] : null) ?? null,
  };
}

// Fetch complete TMDB metadata for the embed player
export async function fetchTmdbDetails(
  type: "movie" | "tv",
  id: number | string
): Promise<TmdbDetails | null> {
  try {
    const data = await tmdb(`/${type}/${id}`, {
      append_to_response: "external_ids",
    });
    const date = data.release_date || data.first_air_date || "";
    const parsedYear = date ? parseInt(date.slice(0, 4), 10) : undefined;
    const imdbId =
      data.imdb_id || data.external_ids?.imdb_id || undefined;

    return {
      id: data.id,
      imdbId,
      title: data.title || data.name || "Untitled",
      year: isNaN(parsedYear as number) ? undefined : parsedYear,
      poster: img.poster(data.poster_path, "w500") || undefined,
      backdrop: img.backdrop(data.backdrop_path, "original") || undefined,
      overview: data.overview || "",
      rating: data.vote_average || 0,
      runtime:
        data.runtime ??
        (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : null) ??
        null,
      seasons: Array.isArray(data.seasons)
        ? data.seasons.map((s: any) => ({
            id: s.id,
            season_number: s.season_number,
            episode_count: s.episode_count,
            name: s.name || `Season ${s.season_number}`,
          }))
        : undefined,
    };
  } catch (err) {
    console.warn(`[TMDB] fetchTmdbDetails failed for ${type}/${id}:`, err);
    return null;
  }
}

// Title logo (transparent PNG) for the player overlay. Prefers an English logo.
export async function getLogo(
  type: "movie" | "tv",
  id: string
): Promise<string | null> {
  try {
    const data = await tmdb(`/${type}/${id}/images`, {
      include_image_language: "en,null",
    });
    const logos: any[] = data.logos || [];
    const pick =
      logos.find((l) => l.iso_639_1 === "en") || logos[0] || null;
    return pick?.file_path
      ? `https://image.tmdb.org/t/p/w500${pick.file_path}`
      : null;
  } catch {
    return null;
  }
}

async function tmdb(path: string, params: Record<string, string> = {}) {
  if (!TMDB_KEY) throw new Error("TMDB_API_KEY is not configured");
  const url = new URL(BASE + path);
  url.searchParams.set("api_key", TMDB_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

export async function getPopular(type: "movie" | "tv"): Promise<TmdbItem[]> {
  const data = await tmdb(`/${type}/popular`);
  return (data.results || []).map(normalize);
}

export async function getById(
  type: "movie" | "tv",
  id: string
): Promise<TmdbItem | null> {
  try {
    const data = await tmdb(`/${type}/${id}`);
    return normalize(data);
  } catch {
    return null;
  }
}

export async function search(
  type: "movie" | "tv",
  query: string
): Promise<TmdbItem[]> {
  if (!query.trim()) return [];
  const data = await tmdb(`/search/${type}`, { query });
  return (data.results || []).map(normalize);
}

export interface TvSeasonInfo {
  season: number;
  episodeCount: number;
  name: string;
}

// Season list for a TV show (used by the next-episode + episode-selector features).
export async function getTvSeasons(id: string): Promise<TvSeasonInfo[]> {
  try {
    const data = await tmdb(`/tv/${id}`);
    return (data.seasons || [])
      .filter((s: any) => s.season_number >= 1 && s.episode_count > 0)
      .map((s: any) => ({
        season: s.season_number,
        episodeCount: s.episode_count,
        name: s.name || `Season ${s.season_number}`,
      }));
  } catch {
    return [];
  }
}

export interface TvEpisode {
  episode: number;
  name: string;
  still: string | null;
  overview: string;
  runtime: number | null;
}

export async function getSeasonEpisodes(
  id: string,
  season: number
): Promise<TvEpisode[]> {
  try {
    const data = await tmdb(`/tv/${id}/season/${season}`);
    return (data.episodes || []).map((e: any) => ({
      episode: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      still: e.still_path ? img.backdrop(e.still_path, "w780") : null,
      overview: e.overview || "",
      runtime: e.runtime ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Accepts a TMDB number or an IMDb id (`tt…`) and returns the TMDB id, so
 * `/movie/tt1375666` works the same as `/movie/27205`.
 */
export async function resolveTmdbId(
  type: "movie" | "tv",
  raw: string
): Promise<number | null> {
  const id = String(raw || "").trim();
  if (!id) return null;
  if (/^\d+$/.test(id)) return Number(id);
  if (!/^tt\d{5,}$/i.test(id)) return null;
  try {
    const data = await tmdb(`/find/${id}`, { external_source: "imdb_id" });
    const list = type === "movie" ? data.movie_results : data.tv_results;
    const hit = Array.isArray(list) ? list[0] : null;
    return typeof hit?.id === "number" ? hit.id : null;
  } catch {
    return null;
  }
}

const MOVIE_ORDER: Record<string, string> = {
  id: "popularity",
  title: "original_title",
  year: "primary_release_date",
  views: "popularity",
  views_day: "popularity",
  views_week: "popularity",
  views_month: "popularity",
  created_at: "primary_release_date",
  updated_at: "primary_release_date",
};

const TV_ORDER: Record<string, string> = {
  id: "popularity",
  title: "original_name",
  year: "first_air_date",
  views: "popularity",
  views_day: "popularity",
  views_week: "popularity",
  views_month: "popularity",
  created_at: "first_air_date",
  updated_at: "last_air_date",
  last_upload_date: "first_air_date",
};

export interface DiscoverQuery {
  page?: number;
  resultsPerPage?: number;
  ordering?: string;
  direction?: string;
  query?: string;
  year?: string;
  imdbId?: string;
  tmdbId?: string;
}

/**
 * Catalog listing used by `/api/discover/*`. View counts are not tracked by
 * this project, so view orderings fall back to TMDB popularity.
 */
export async function discover(
  type: "movie" | "tv",
  q: DiscoverQuery
): Promise<{ page: number; total_pages: number; total_results: number; results: TmdbItem[] }> {
  const page = Math.max(1, Number(q.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(q.resultsPerPage) || 20));
  const empty = { page, total_pages: 1, total_results: 0, results: [] as TmdbItem[] };

  if (q.query && q.query.trim().length >= 3) {
    const data = await tmdb(`/search/${type}`, { query: q.query.trim(), page: String(page) });
    const items = (data.results || []).map(normalize);
    return {
      page,
      total_pages: data.total_pages || 1,
      total_results: data.total_results || items.length,
      results: items.slice(0, perPage),
    };
  }

  if (q.tmdbId) {
    const item = await getById(type, q.tmdbId);
    return item ? { ...empty, total_results: 1, results: [item] } : empty;
  }

  if (q.imdbId) {
    const id = await resolveTmdbId(type, q.imdbId);
    const item = id ? await getById(type, String(id)) : null;
    return item ? { ...empty, total_results: 1, results: [item] } : empty;
  }

  const orderMap = type === "movie" ? MOVIE_ORDER : TV_ORDER;
  const field = orderMap[q.ordering || "views"] || "popularity";
  const direction = q.direction === "asc" ? "asc" : "desc";
  const params: Record<string, string> = {
    page: String(page),
    sort_by: `${field}.${direction}`,
  };
  if (q.year) {
    params[type === "movie" ? "primary_release_year" : "first_air_date_year"] = q.year;
  }

  const data = await tmdb(`/discover/${type}`, params);
  const items = (data.results || []).map(normalize);
  return {
    page,
    total_pages: data.total_pages || 1,
    total_results: data.total_results || items.length,
    results: items.slice(0, perPage),
  };
}

/** Trending list. `month`/`total` fall back to TMDB popularity. */
export async function trending(
  type: "movie" | "tv",
  window: "day" | "week" | "month" | "total"
): Promise<TmdbItem[]> {
  if (window === "month" || window === "total") {
    const data = await tmdb(`/${type}/popular`);
    return (data.results || []).map(normalize);
  }
  const data = await tmdb(`/trending/${type}/${window}`);
  return (data.results || []).map(normalize);
}
