const ANILIST_GRAPHQL = "https://graphql.anilist.co";

export interface AniListAnime {
  id: number;
  malId?: number;
  title: string;
  romajiTitle?: string;
  nativeTitle?: string;
  year?: number;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number;
  episodeCount: number;
  genres: string[];
  status?: string;
}

export interface AniListSearchResult {
  id: number;
  title: string;
  year?: string;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  rating: number;
  runtime: number | null;
}

function cleanDescription(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function normalizeMedia(m: any): AniListAnime {
  const title =
    m.title?.english || m.title?.romaji || m.title?.native || "Untitled";
  const year = m.seasonYear || m.startDate?.year || undefined;
  return {
    id: m.id,
    malId: m.idMal || undefined,
    title,
    romajiTitle: m.title?.romaji || undefined,
    nativeTitle: m.title?.native || undefined,
    year,
    poster: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
    backdrop: m.bannerImage || null,
    overview: cleanDescription(m.description),
    rating: m.averageScore ? Math.round((m.averageScore / 10) * 10) / 10 : 0,
    episodeCount: Number(m.episodes) || 1,
    genres: Array.isArray(m.genres) ? m.genres : [],
    status: m.status || undefined,
  };
}

export async function fetchAniListDetails(
  id: number | string
): Promise<AniListAnime | null> {
  const numericId = Number(id);
  if (!numericId || isNaN(numericId)) return null;

  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title { romaji english native }
        coverImage { extraLarge large medium }
        bannerImage
        description
        episodes
        status
        genres
        averageScore
        seasonYear
        startDate { year }
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: { id: numericId } }),
      next: { revalidate: 3600 },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.data?.Media) return null;
    return normalizeMedia(data.data.Media);
  } catch (err) {
    console.warn(`[AniList] fetchAniListDetails failed for ${id}:`, err);
    return null;
  }
}

export async function searchAniList(
  searchTerm: string,
  page = 1,
  perPage = 20
): Promise<AniListSearchResult[]> {
  const term = searchTerm.trim();
  if (!term) return [];

  const query = `
    query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium }
          bannerImage
          description
          episodes
          averageScore
          seasonYear
          startDate { year }
        }
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { search: term, page, perPage },
      }),
      next: { revalidate: 1800 },
    });

    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = data?.data?.Page?.media || [];

    return list.map((m) => {
      const title =
        m.title?.english || m.title?.romaji || m.title?.native || "Untitled";
      const year = m.seasonYear || m.startDate?.year ? String(m.seasonYear || m.startDate?.year) : "";
      return {
        id: m.id,
        title,
        year,
        poster: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
        backdrop: m.bannerImage || null,
        overview: cleanDescription(m.description),
        rating: m.averageScore ? Math.round((m.averageScore / 10) * 10) / 10 : 0,
        runtime: null,
      };
    });
  } catch (err) {
    console.warn(`[AniList] searchAniList failed for ${term}:`, err);
    return [];
  }
}

export async function getPopularAniList(
  page = 1,
  perPage = 20
): Promise<AniListSearchResult[]> {
  const query = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: TRENDING_DESC) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium }
          bannerImage
          description
          episodes
          averageScore
          seasonYear
          startDate { year }
        }
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { page, perPage },
      }),
      next: { revalidate: 1800 },
    });

    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = data?.data?.Page?.media || [];

    return list.map((m) => {
      const title =
        m.title?.english || m.title?.romaji || m.title?.native || "Untitled";
      const year = m.seasonYear || m.startDate?.year ? String(m.seasonYear || m.startDate?.year) : "";
      return {
        id: m.id,
        title,
        year,
        poster: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
        backdrop: m.bannerImage || null,
        overview: cleanDescription(m.description),
        rating: m.averageScore ? Math.round((m.averageScore / 10) * 10) / 10 : 0,
        runtime: null,
      };
    });
  } catch (err) {
    console.warn("[AniList] getPopularAniList failed:", err);
    return [];
  }
}
