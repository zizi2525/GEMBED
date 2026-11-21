import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  const { id, season, episode } = await params;
  const tmdbId = await resolveTmdbId("tv", id);
  const tmdb = tmdbId ? await fetchTmdbDetails("tv", tmdbId) : null;
  if (!tmdb?.title) return { title: PLAYER_NAME };
  return { title: `${tmdb.title} · S${season} E${episode} — ${PLAYER_NAME}` };
}

// /tv/{tmdbId}/{season}/{episode} — also accepts an IMDb id
export default async function TvPlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; season: string; episode: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id, season, episode } = await params;
  const sp = await searchParams;

  const tmdbId = await resolveTmdbId("tv", id);
  const s = Number(season) || 1;
  const e = Number(episode) || 1;

  if (!tmdbId) notFound();

  const tmdb = await fetchTmdbDetails("tv", tmdbId);
  if (!tmdb) notFound();

  const accentColor = resolveAccentColor(sp) || "#6366f1";
  const autoPlay = resolveAutoplay(sp);
  const startAt = parseStartTime(sp);
  const defaultLang = sp.lang || "en";
  const autoNext = resolveAutoNext(sp);
  const showEpisodes = resolveShowEpisodes(sp);

  const buildHref = (nextS: number, nextE: number) => {
    const q = new URLSearchParams({
      accent: accentColor,
      autoplay: autoPlay ? "1" : "0",
      lang: defaultLang,
      autonext: autoNext ? "1" : "0",
      episodes: showEpisodes ? "1" : "0",
    });
    return `/tv/${tmdbId}/${nextS}/${nextE}?${q.toString()}`;
  };

  const currentSeason = (tmdb.seasons || []).find(
    (item: { season_number: number; episode_count?: number }) => item.season_number === s
  );
  const episodeCount = currentSeason?.episode_count || 24;

  const nextHref =
    e < episodeCount
      ? buildHref(s, e + 1)
      : (tmdb.seasons || []).some(
          (item: { season_number: number }) => item.season_number === s + 1
        )
      ? buildHref(s + 1, 1)
      : null;

  const prevHref =
    e > 1
      ? buildHref(s, e - 1)
      : s > 1
      ? buildHref(s - 1, 1)
      : null;

  // The episode browser navigates to sibling URLs and keeps the embed options.
  const episodesQuery = `?${new URLSearchParams({
    accent: accentColor,
    autoplay: autoPlay ? "1" : "0",
    lang: defaultLang,
    autonext: autoNext ? "1" : "0",
    episodes: showEpisodes ? "1" : "0",
  }).toString()}`;

  const seasons = (tmdb.seasons || [])
    .filter((item: { season_number: number }) => item.season_number >= 1)
    .map((item: { season_number: number; name: string; episode_count: number }) => ({
      season: item.season_number,
      name: item.name,
      episodeCount: item.episode_count,
    }));

  return (
    <main className="h-screen w-screen overflow-hidden bg-black">
      <VidPlayer
        type="tv"
        tmdbId={tmdbId}
        imdbId={tmdb.imdbId}
        season={s}
        episode={e}
        title={tmdb.title}
        backdrop={tmdb.backdrop}
        poster={tmdb.poster}
        overview={tmdb.overview}
        year={tmdb.year}
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
        episodesHrefBase={`/tv/${tmdbId}`}
        episodesQuery={episodesQuery}
      />
    </main>
  );
}
