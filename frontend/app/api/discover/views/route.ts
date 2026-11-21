import { NextResponse } from "next/server";
import { trending } from "@/lib/tmdb";

export const revalidate = 1800;

function readWindow(value: string | null): "day" | "week" | "month" | "total" {
  if (value === "day" || value === "week" || value === "month") return value;
  return "total";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") === "tv" ? "tv" : "movie";
  const window = readWindow(searchParams.get("views"));
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const perPage = Math.min(100, Math.max(1, Number(searchParams.get("resultsPerPage")) || 20));

  try {
    const results = await trending(type, window);
    const start = (page - 1) * perPage;
    return NextResponse.json({
      page,
      resultsPerPage: perPage,
      window,
      results: results.slice(start, start + perPage),
    });
  } catch {
    return NextResponse.json({ page, resultsPerPage: perPage, window, results: [] }, { status: 500 });
  }
}
