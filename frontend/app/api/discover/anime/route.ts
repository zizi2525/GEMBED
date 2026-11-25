import { NextResponse } from "next/server";
import { discoverAnime, type DiscoverQuery } from "@/lib/tmdb";

export const revalidate = 1800;

function readQuery(url: string): DiscoverQuery {
  const { searchParams } = new URL(url);
  return {
    page: Number(searchParams.get("page")) || 1,
    resultsPerPage: Number(searchParams.get("resultsPerPage")) || 20,
    ordering: searchParams.get("ordering") || undefined,
    direction: searchParams.get("direction") || undefined,
    query: searchParams.get("query") || undefined,
    year: searchParams.get("year") || undefined,
    imdbId: searchParams.get("imdbid") || searchParams.get("imdb_id") || undefined,
    tmdbId: searchParams.get("tmdbid") || undefined,
  };
}

export async function GET(request: Request) {
  try {
    const data = await discoverAnime(readQuery(request.url));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { page: 1, total_pages: 0, total_results: 0, results: [] },
      { status: 500 }
    );
  }
}
