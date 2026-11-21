import { HomePage } from "@/components/home-page";
import { LOGO_SRC, PLAYER_NAME, PLAYER_TAGLINE, PLAYER_URL } from "@/lib/config";

// Branding comes from the server environment, so render per request instead of
// baking the homepage at build time.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <HomePage
      brand={{
        name: PLAYER_NAME,
        tagline: PLAYER_TAGLINE,
        url: PLAYER_URL,
        logo: LOGO_SRC,
      }}
    />
  );
}
