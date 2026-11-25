import { NextResponse } from "next/server";
import { getPopular } from "@/lib/tmdb";
import { getPopularAniList } from "@/lib/anilist";

export const revalidate = 1800;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const typeParam = searchParams.get("type");

  try {
    let results;
    if (typeParam === "anime") {
      results = await getPopularAniList();
    } else if (typeParam === "tv") {
      results = await getPopular("tv");
    } else {
      results = await getPopular("movie");
    }
    return NextResponse.json({ results: results.slice(0, 20) });
  } catch {
    // Service unavailable: the page degrades to its skeleton state.
    return NextResponse.json({ results: [] });
  }
}
