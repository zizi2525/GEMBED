import { notFound, redirect } from "next/navigation";

// Short form: /tv/{tmdbId}-{season}-{episode}
export default async function ShortTvRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const match = /^(.+?)-(\d+)-(\d+)$/.exec(id);
  if (!match) notFound();

  const query = new URLSearchParams();
  Object.entries(sp).forEach(([key, value]) => {
    if (typeof value === "string") query.set(key, value);
  });
  const suffix = query.toString();

  redirect(`/tv/${match[1]}/${match[2]}/${match[3]}${suffix ? `?${suffix}` : ""}`);
}
