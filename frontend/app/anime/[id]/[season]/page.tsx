import type { Metadata } from "next";
import AnimePlayerPage, { generateMetadata as baseMetadata } from "./[episode]/page";

type SearchParams = Record<string, string | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; season: string }>;
}): Promise<Metadata> {
  const { id, season } = await params;
  return baseMetadata({ params: Promise.resolve({ id, season: "1", episode: season }) });
}

// /anime/{anilistId}/{episode}
export default async function AnimePlayerTwoParamRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; season: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id, season } = await params;
  return (
    <AnimePlayerPage
      params={Promise.resolve({ id, season: "1", episode: season })}
      searchParams={searchParams}
    />
  );
}
