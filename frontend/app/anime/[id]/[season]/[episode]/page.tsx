import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchAniListDetails } from "@/lib/anilist";
import { fetchTmdbDetails, resolveTmdbId } from "@/lib/tmdb";
import { VidPlayer } from "@/components/player/vid-player";
import { PLAYER_NAME, PROMO_TEXT } from "@/lib/config";
import {
  parseStartTime,
  resolveAccentColor,
  resolveAutoNext,
  resolveAutoplay,
  resolveShowEpisodes,
} from "@/lib/route-params";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; season: string; episode: string }>;
}): Promise<Metadata> {
  const { id, episode } = await params;
  const ani = await fetchAniListDetails(id);
  const title = ani?.title || (await fetchTmdbDetails("tv", id))?.title;

  if (!title) return { title: `${PLAYER_NAME} Anime` };
  return { title: `${title} · Ep ${episode} — ${PLAYER_NAME} Anime` };
}

// /anime/{anilistId}/{season}/{episode} OR /anime/{anilistId}/{episode}
export default async function AnimePlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; season: string; episode: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, season, episode } = await params;
  const sp = await searchParams;

  const ani = await fetchAniListDetails(id);
  const s = Number(season) || 1;
  const e = Number(episode) || 1;

  let title = "";
  let poster: string | undefined = undefined;
  let backdrop: string | undefined = undefined;
  let overview: string | undefined = undefined;
  let year: number | undefined = undefined;
  let episodeCount = 24;
  let anilistId: number | string = id;
  let malId: string | number | undefined = sp.malId || sp.mal;

  if (ani) {
    title = ani.title;
    poster = ani.poster || undefined;
    backdrop = ani.backdrop || undefined;
    overview = ani.overview;
    year = ani.year;
    episodeCount = ani.episodeCount;
    anilistId = ani.id;
    malId = malId || ani.malId;
  } else {
    // Fallback if someone passed a legacy TMDB id
    const tmdbId = await resolveTmdbId("tv", id);
    const tmdb = tmdbId ? await fetchTmdbDetails("tv", tmdbId) : null;
    if (!tmdb) notFound();
    title = tmdb.title;
    poster = tmdb.poster;
    backdrop = tmdb.backdrop;
    overview = tmdb.overview;
    year = tmdb.year;
    const currentSeason = (tmdb.seasons || []).find((item) => item.season_number === s);
    episodeCount = currentSeason?.episode_count || 24;
  }

  const accentColor = resolveAccentColor(sp) || "#3b82f6";
  const autoPlay = resolveAutoplay(sp);
  const startAt = parseStartTime(sp);
  const defaultLang = sp.lang || "ja";
  const autoNext = resolveAutoNext(sp);
  const showEpisodes = resolveShowEpisodes(sp);

  const queryParams = new URLSearchParams({
    accent: accentColor,
    autoplay: autoPlay ? "1" : "0",
    lang: defaultLang,
    autonext: autoNext ? "1" : "0",
    episodes: showEpisodes ? "1" : "0",
  });
  if (anilistId) queryParams.set("anilistId", String(anilistId));
  if (malId) queryParams.set("malId", String(malId));
  const queryStr = queryParams.toString();

  const buildHref = (nextE: number) =>
    `/anime/${anilistId}/${nextE}?${queryStr}`;

  const nextHref = e < episodeCount ? buildHref(e + 1) : null;
  const prevHref = e > 1 ? buildHref(e - 1) : null;

  const seasons = [
    {
      season: 1,
      name: "Episodes",
      episodeCount,
    },
  ];

  return (
    <main className="h-[100dvh] w-full overflow-hidden bg-black">
      <VidPlayer
        type="tv"
        anime={true}
        tmdbId={typeof anilistId === "number" ? anilistId : Number(anilistId) || 0}
        anilistId={anilistId}
        malId={malId}
        season={s}
        episode={e}
        title={title}
        backdrop={backdrop}
        poster={poster}
        overview={overview}
        year={year}
        accentColor={accentColor}
        autoPlay={autoPlay}
        startAt={startAt}
        defaultLang={defaultLang}
        promoText={PROMO_TEXT}
        prevHref={prevHref}
        nextHref={nextHref}
        autoNext={autoNext}
        showEpisodes={showEpisodes}
        seasons={seasons}
        episodesHrefBase={`/anime/${anilistId}`}
        episodesQuery={`?${queryStr}`}
      />
    </main>
  );
}
