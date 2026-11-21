import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const tmdb = searchParams.get("tmdb") || searchParams.get("tmdb_id") || "";
    const type = searchParams.get("type") || "movie";
    const s = searchParams.get("s") || searchParams.get("season") || "";
    const e = searchParams.get("e") || searchParams.get("episode") || "";

    if (!tmdb) {
      return NextResponse.json({ intro: [], recap: [], credits: [] });
    }

    let url = `https://api.theintrodb.org/v4/media?tmdb_id=${encodeURIComponent(tmdb)}`;
    if (type === "tv" && s && e) {
      url += `&season=${encodeURIComponent(s)}&episode=${encodeURIComponent(e)}`;
    }

    const apiKey = process.env.SEGMENTS_API_KEY || process.env.INTRODB_API_KEY || "";
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    };
    if (apiKey) {
      headers["Authorization"] = apiKey;
      headers["X-API-Key"] = apiKey;
    }

    const res = await fetch(url, {
      headers,
      next: { revalidate: 86400 },
    });

    if (!res.ok) {
      return NextResponse.json({ intro: [], recap: [], credits: [] });
    }

    const raw = await res.json();
    // Return sanitized segments data without upstream IDs or metadata
    return NextResponse.json({
      type: raw?.type || type,
      season: raw?.season,
      episode: raw?.episode,
      intro: Array.isArray(raw?.intro) ? raw.intro : [],
      recap: Array.isArray(raw?.recap) ? raw.recap : [],
      credits: Array.isArray(raw?.credits) ? raw.credits : [],
    });
  } catch {
    // Never expose upstream API URLs or error messages to the client
    return NextResponse.json({ intro: [], recap: [], credits: [] });
  }
}
