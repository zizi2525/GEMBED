import { NextResponse } from "next/server";
import { getSeasonEpisodes } from "@/lib/tmdb";

export const revalidate = 3600;

/** Episode list for the in-player episode browser. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id") || "";
  const season = Number(searchParams.get("season")) || 1;

  if (!id) return NextResponse.json({ season, episodes: [] });

  const episodes = await getSeasonEpisodes(id, season);
  return NextResponse.json({ season, episodes });
}
