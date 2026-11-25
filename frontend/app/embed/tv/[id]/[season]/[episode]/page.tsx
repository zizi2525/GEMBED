import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchTmdbDetails, resolveTmdbId } from "@/lib/tmdb";
import { VidPlayer } from "@/components/player/vid-player";
import { PLAYER_NAME, PROMO_TEXT } from "@/lib/config";
import {
  parseStartTime,
  resolveAccentColor,
  resolveAnime,
  resolveAutoNext,
  resolveAutoplay,
  resolveShowEpisodes,
} from "@/lib/route-params";

type TvEmbedSearch = Record<string, string | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; season: string; episode: string }>;
}): Promise<Metadata> {
  const { id, season, episode } = await params;
  const tmdbId = await resolveTmdbId("tv", id);
  const tmdb = tmdbId ? await fetchTmdbDetails("tv", tmdbId) : null;

  return {
    title: tmdb
      ? `${tmdb.title} S${season}E${episode} — ${PLAYER_NAME} Embed`
      : `${PLAYER_NAME} Player`,
    description:
      tmdb?.overview?.slice(0, 160) ||
      `Watch high-definition streaming with ${PLAYER_NAME}`,
    robots: { index: false, follow: false },
    openGraph: {
      title: tmdb ? `${tmdb.title} S${season}E${episode}` : `${PLAYER_NAME} Player`,
      description: tmdb?.overview,
      images: tmdb?.backdrop ? [tmdb.backdrop] : [],
    },
  };
}

export default async function TvEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; season: string; episode: string }>;
  searchParams: Promise<TvEmbedSearch>;
}) {
  const { id, season, episode } = await params;
  const sp = await searchParams;

  const tmdbId = await resolveTmdbId("tv", id);
  const s = Number(season) || 1;
  const e = Number(episode) || 1;

  if (!tmdbId) notFound();

  const tmdb = await fetchTmdbDetails("tv", tmdbId);
  if (!tmdb) notFound();

  const accentColor = resolveAccentColor(sp) || "#3b82f6";
  const autoPlay = resolveAutoplay(sp);
  const startAt = parseStartTime(sp);
  const defaultLang = sp.lang || "en";
  const autoNext = resolveAutoNext(sp);
  const showEpisodes = resolveShowEpisodes(sp);
  const isAnime =
    resolveAnime(sp) ||
    (tmdb.originalLanguage === "ja" &&
      (tmdb.genres?.some((g) => g.id === 16 || g.name.toLowerCase().includes("anim")) ?? false));
  const anilistId = sp.anilistId || sp.anilist;
  const malId = sp.malId || sp.mal;

  const embedQuery = new URLSearchParams({
    accent: accentColor,
    autoplay: autoPlay ? "1" : "0",
    lang: defaultLang,
    autonext: autoNext ? "1" : "0",
    episodes: showEpisodes ? "1" : "0",
  });
  if (isAnime) embedQuery.set("anime", "1");
  if (anilistId) embedQuery.set("anilistId", anilistId);
  if (malId) embedQuery.set("malId", malId);
  const embedQueryStr = embedQuery.toString();

  const buildHref = (nextS: number, nextE: number) =>
    `/embed/tv/${tmdbId}/${nextS}/${nextE}?${embedQueryStr}`;

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

  const seasons = (tmdb.seasons || [])
    .filter((item: { season_number: number }) => item.season_number >= 1)
    .map((item: { season_number: number; name: string; episode_count: number }) => ({
      season: item.season_number,
      name: item.name,
      episodeCount: item.episode_count,
    }));

  return (
    <main className="h-[100dvh] w-full overflow-hidden bg-black">
      <VidPlayer
        type="tv"
        anime={isAnime}
        anilistId={anilistId}
        malId={malId}
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
        episodesHrefBase={`/embed/tv/${tmdbId}`}
        episodesQuery={`?${embedQueryStr}`}
      />
    </main>
  );
}
