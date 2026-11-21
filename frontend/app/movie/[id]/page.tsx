import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchTmdbDetails, resolveTmdbId } from "@/lib/tmdb";
import { VidPlayer } from "@/components/player/vid-player";
import { PLAYER_NAME, PROMO_TEXT } from "@/lib/config";
import {
  parseStartTime,
  resolveAccentColor,
  resolveAutoplay,
} from "@/lib/route-params";

export const revalidate = 3600;
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const tmdbId = await resolveTmdbId("movie", id);
  const tmdb = tmdbId ? await fetchTmdbDetails("movie", tmdbId) : null;
  return {
    title: tmdb?.title ? `${tmdb.title} — ${PLAYER_NAME}` : PLAYER_NAME,
    description: tmdb?.overview?.slice(0, 160) || "Watch high-definition streaming",
  };
}

// /movie/{tmdbId} — also accepts an IMDb id (`/movie/tt1375666`)
export default async function MoviePlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const tmdbId = await resolveTmdbId("movie", id);
  if (!tmdbId) notFound();

  const tmdb = await fetchTmdbDetails("movie", tmdbId);
  if (!tmdb) notFound();

  const accentColor = resolveAccentColor(sp) || "#6366f1";
  const autoPlay = resolveAutoplay(sp);
  const startAt = parseStartTime(sp);
  const defaultLang = sp.lang || "en";

  return (
    <main className="h-screen w-screen overflow-hidden bg-black">
      <VidPlayer
        type="movie"
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
