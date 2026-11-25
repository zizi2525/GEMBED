import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchTmdbDetails, resolveTmdbId } from "@/lib/tmdb";
import { VidPlayer } from "@/components/player/vid-player";
import { PLAYER_NAME, PROMO_TEXT } from "@/lib/config";
import {
  parseStartTime,
  resolveAccentColor,
  resolveAnime,
  resolveAutoplay,
} from "@/lib/route-params";

type MovieEmbedSearch = Record<string, string | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tmdbId = await resolveTmdbId("movie", id);
  const tmdb = tmdbId ? await fetchTmdbDetails("movie", tmdbId) : null;

  return {
    title: tmdb ? `${tmdb.title} — ${PLAYER_NAME} Embed` : `${PLAYER_NAME} Player`,
    description:
      tmdb?.overview?.slice(0, 160) ||
      `Watch high-definition streaming with ${PLAYER_NAME}`,
    robots: { index: false, follow: false },
    openGraph: {
      title: tmdb?.title,
      description: tmdb?.overview,
      images: tmdb?.backdrop ? [tmdb.backdrop] : [],
    },
  };
}

export default async function MovieEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<MovieEmbedSearch>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const tmdbId = await resolveTmdbId("movie", id);
  if (!tmdbId) notFound();

  const tmdb = await fetchTmdbDetails("movie", tmdbId);
  if (!tmdb) notFound();

  const accentColor = resolveAccentColor(sp) || "#3b82f6";
  const autoPlay = resolveAutoplay(sp);
  const startAt = parseStartTime(sp);
  const defaultLang = sp.lang || "en";
  const isAnime =
    resolveAnime(sp) ||
    (tmdb.originalLanguage === "ja" &&
      (tmdb.genres?.some((g) => g.id === 16 || g.name.toLowerCase().includes("anim")) ?? false));
  const anilistId = sp.anilistId || sp.anilist;
  const malId = sp.malId || sp.mal;

  return (
    <main className="h-[100dvh] w-full overflow-hidden bg-black">
      <VidPlayer
        type="movie"
        anime={isAnime}
        anilistId={anilistId}
        malId={malId}
        tmdbId={tmdbId}
        imdbId={tmdb.imdbId}
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
      />
    </main>
  );
}
