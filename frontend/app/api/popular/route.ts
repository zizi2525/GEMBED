import { NextResponse } from "next/server";
import { getPopular } from "@/lib/tmdb";

export const revalidate = 1800;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") === "tv" ? "tv" : "movie";

  try {
    const results = await getPopular(type);
    return NextResponse.json({ results: results.slice(0, 20) });
  } catch {
    // No key or TMDB unavailable: the page degrades to its skeleton state.
    return NextResponse.json({ results: [] });
  }
}
