import { NextResponse } from "next/server";
import { search } from "@/lib/tmdb";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("q") || "";
    const type = (searchParams.get("type") as "movie" | "tv") || "movie";

    if (!query.trim()) {
      return NextResponse.json({ results: [] });
    }

    const results = await search(type, query);
    return NextResponse.json({ results: results.slice(0, 8) });
  } catch (err: any) {
    return NextResponse.json({ results: [], error: err.message }, { status: 500 });
  }
}
