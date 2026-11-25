import type { Metadata } from "next";
import AnimeEmbedPage, { generateMetadata as baseMetadata } from "./[episode]/page";

type SearchParams = Record<string, string | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; season: string }>;
}): Promise<Metadata> {
  const { id, season } = await params;
  return baseMetadata({ params: Promise.resolve({ id, season: "1", episode: season }) });
}

// /embed/anime/{anilistId}/{episode}
export default async function AnimeEmbedTwoParamRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; season: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id, season } = await params;
  return (
    <AnimeEmbedPage
      params={Promise.resolve({ id, season: "1", episode: season })}
      searchParams={searchParams}
    />
  );
}
