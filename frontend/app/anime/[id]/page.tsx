import { redirect } from "next/navigation";

// Form: /anime/{anilistId} -> redirects to /anime/{anilistId}/1
// OR: /anime/{anilistId}-{episode} -> /anime/{anilistId}/{episode}
export default async function ShortAnimeRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const query = new URLSearchParams();
  Object.entries(sp).forEach(([key, value]) => {
    if (typeof value === "string") query.set(key, value);
  });
  const suffix = query.toString();

  const matchSlug = /^(.+?)-(\d+)$/.exec(id);
  if (matchSlug) {
    return redirect(`/anime/${matchSlug[1]}/${matchSlug[2]}${suffix ? `?${suffix}` : ""}`);
  }

  const matchThree = /^(.+?)-(\d+)-(\d+)$/.exec(id);
  if (matchThree) {
    return redirect(`/anime/${matchThree[1]}/${matchThree[3]}${suffix ? `?${suffix}` : ""}`);
  }

  return redirect(`/anime/${id}/1${suffix ? `?${suffix}` : ""}`);
}
