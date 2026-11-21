# Vidsuper

A self-hostable video **player + streaming API**. Give it a [TMDB](https://www.themoviedb.org/) id and it resolves a playable stream from a set of built-in sources, proxies every byte through your own server, and plays it in a clean, embeddable HTML5 player (HLS / DASH / MP4) with quality switching, subtitles, and skip-intro support.

There is **no front-end catalog** — this is purely the player and its API, meant to be embedded via `<iframe>` from your own site or app. Bring your own TMDB key, deploy it on a VPS, and point iframes at it.

---

## Table of contents
- [Features](#features)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Configuration (.env)](#configuration-env)
- [Deploying](#deploying)
- [Embedding the player](#embedding-the-player)
- [Customizing](#customizing)
- [Adding a source](#adding-a-source)
- [Subtitles](#subtitles)
- [Disclaimer](#disclaimer)

---

## Features
- **Embeddable player** at `/movie/{tmdbId}` and `/tv/{tmdbId}/{season}/{episode}`.
- **Multiple sources** with automatic failover — if one server can't produce a stream, it tries the next.
- **Everything proxied through your VPS** — the `/api/stream` proxy fetches upstream segments with the correct referer and re-serves them same-origin. Real CDN URLs never reach the client, and there are no third-party proxies or Cloudflare Workers involved.
- **Local watch resume and remembered quality** — the player stores position and resolution per title on the device, so a reload continues where it stopped without the host page passing `progress`.
- **Episode browser and auto-next** — seasons, stills, per-episode progress, a next-episode countdown, plus a `postMessage` command channel for the host page.
- **Subtitles** from OpenSubtitles + vdrk (each toggleable), with automatic timing repair for clearly offset files.
- **Skip intro / credits** (optional, via theintrodb.org).
- **Fully brandable** via env — player name, accent colour, logo, and per-source display names.
- **HLS, DASH and MP4** with quality / audio-track switching.

## How it works
1. The player page fetches metadata (title, poster, seasons/episodes) from **TMDB** using your key.
2. When the viewer hits play, the browser calls `GET /api/sources?type=…&id=…&server=…`.
3. That route runs the selected **scraper** (`lib/scraper/*`) to find a real upstream stream, then wraps its URL (and any required referer) in a short-lived HMAC-signed token pointing at `GET /api/stream`.
4. The player loads the `/api/stream` URL; your server fetches the upstream bytes and streams them back, same-origin. Subtitles work the same way via `/api/sub`.

The HMAC signature (using `APP_SECRET`) is the only "security" left in the project: it stops random people from using your `/api/stream` endpoint as a free open proxy for arbitrary URLs. There is no DRM, token gating, WASM, or obfuscation.

## Quick start
```bash
git clone https://github.com/fartboblover3/vidsuper.git
cd vidsuper
cp .env.example .env          # then edit .env (set TMDB_API_KEY + APP_SECRET)
npm install
npm run build
npm start                     # serves on http://localhost:3000
```
Open `http://localhost:3000/movie/27205` (Inception) to test.

Generate a strong `APP_SECRET`:
```bash
openssl rand -hex 32
```

## Configuration (.env)
Copy `.env.example` to `.env`. Only the first two are required.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TMDB_API_KEY` | yes | — | Your TMDB v3 API key ([get one](https://www.themoviedb.org/settings/api)). |
| `APP_SECRET` | yes | — | Random secret for signing stream-proxy URLs. `openssl rand -hex 32`. |
| `PORT` | no | `3000` | Port to listen on. |
| `PLAYER_NAME` | no | `Vidsuper` | Visible brand name (browser tab / metadata). |
| `PLAYER_TAGLINE` | no | `Video streaming player` | Tagline in the tab title. |
| `PLAYER_URL` | no | — | Brand link for the homepage header and footer, e.g. `https://example.com`. Empty renders the name as plain text. |
| `PROMO_TEXT` | no | `✨ Streamed on $PLAYER_NAME · Enjoy the Show` | Subtitle line that replaces upstream subtitle adverts. |
| `ACCENT_COLOR` | no | `ef4444` | Accent hex (no `#`). Override per-embed with `?color=`. |
| `LOGO_SRC` | no | `/logo.svg` | Logo path from `/public`, used for the favicon, tab icon and homepage header. Replace `public/logo.svg` to rebrand. |
| `SUBTITLES_ENABLED` | no | `true` | Set `false` to disable subtitles. |
| `SEGMENTS_API_KEY` | no | — | Optional skip-intro key. Skip-intro works **without** it. |
| `NEXT_PUBLIC_DEBUG_PROTECTION` | no | `true` in production | Devtools / debugger deterrence. Production builds block inspector shortcuts, right-click and pause playback while devtools are detected. `true` forces it on everywhere (including `next dev`), `false` turns it off everywhere (recommended for local development). Unset means on for production builds and off in `next dev`. The value is baked into the browser bundle at build time, so restart `next dev` or rebuild after changing it. |

All branding / config is read at **runtime** — change `.env`, restart, done. No rebuild required.

## Deploying

### Docker (recommended)
```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```
The image uses Next.js standalone output, so it's small and self-contained, and it reads `.env` at runtime.

### Nixpacks (Railway / Coolify / Dokploy)
A `nixpacks.toml` is included for platforms that build with [Nixpacks](https://nixpacks.com).

1. Create a service from this repository and set its **root directory** to `frontend/`.
2. Add the variables from `.env.example` to the service (never commit them).
3. Deploy. Nixpacks runs `npm ci`/`npm install` with dev dependencies, `npm run build`, then `npm run start`; Next.js binds to the platform-injected `PORT` on `0.0.0.0`.

`NEXT_PUBLIC_*` values (for example `NEXT_PUBLIC_DEBUG_PROTECTION`, `NEXT_PUBLIC_TMDB_API_KEY`) are compiled into the browser bundle, so they must also be present in the platform's **build** environment. Everything else is read at runtime.

### Node + PM2
On a fresh Ubuntu VPS:
```bash
# install Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

git clone https://github.com/fartboblover3/vidsuper.git
cd vidsuper
cp .env.example .env && nano .env      # set TMDB_API_KEY + APP_SECRET
npm install
npm run build

sudo npm i -g pm2
pm2 start "npm start" --name vidsuper
pm2 save && pm2 startup                 # auto-restart on reboot
```
Put Nginx (or Caddy) in front for TLS and to proxy port 3000.

### Why not Vercel / serverless
**Don't deploy this to Vercel** (or other serverless / edge platforms). This app is a long-running streaming proxy: `/api/stream` pipes large video responses through the server, and the scrapers make several sequential upstream requests. Serverless platforms impose short execution / response-time limits, cap response sizes, bill per-GB egress on exactly the kind of traffic a video proxy generates, and often can't stream a long response at all. Use a normal VPS with a full Node runtime and generous bandwidth.

### Recommended VPS hosts
Cheap VPS providers that work well for this (decent bandwidth, no serverless limits):
- **[aeza.net](https://aeza.net)**
- **[vmheaven.io](https://vmheaven.io)**
- **[snowcore.io](https://snowcore.io)**
- **[pfcloud.io](https://pfcloud.io)**

A small instance is plenty for the app itself; pick based on the bandwidth / traffic you expect, since all video flows through your server.

## Embedding the player
Point an iframe at your deployment. Movie ids can be TMDB numbers or IMDb ids (`tt1375666`); TV episodes accept the slash form or the short `/tv/{id}-{season}-{episode}` form:
```html
<!-- Movie -->
<iframe
  src="https://your-host.com/movie/27205"
  allow="autoplay *; fullscreen *; picture-in-picture *"
  allowfullscreen
></iframe>

<!-- TV episode: /tv/{tmdbId}/{season}/{episode} -->
<iframe
  src="https://your-host.com/tv/1399/1/1"
  allow="autoplay *; fullscreen *; picture-in-picture *"
  allowfullscreen
></iframe>
```

`autoplay *` (rather than a bare `autoplay`) makes the permission apply to whatever origin the frame ends up serving, so a redirect or a different embed host does not silently block playback.

Optional query parameters:

| Param | Applies to | Description |
|---|---|---|
| `color` / `theme` | both | Accent hex without `#`, e.g. `?color=3b82f6`. `theme` is an alias. |
| `progress` | both | Start time in seconds, e.g. `?progress=120`. |
| `t` / `startAt` | both | Start time, plain seconds or a compound duration such as `1h5m30s`. An explicit start wins over the viewer's saved position. |
| `autoplay` | both | Defaults to on; `?autoplay=0` (or `false`) keeps the poster until the viewer presses play. |
| `src` | both | Play an arbitrary HLS / DASH / MP4 URL directly (bypasses scrapers). |
| `overlay` | both | `true` to show the title / metadata idle overlay. |
| `skip_intro` | both | `true` to show skip-intro / credits buttons. |
| `nextEpisode` | tv | `true` to show a "Next episode" button. |
| `episodes` / `episodeSelector` | tv | Episode browser with seasons, stills and progress. Shown by default; pass `episodes=0` to hide it. |
| `autonext` / `autoplayNextEpisode` | tv | Countdown into the next episode near the end. On by default; pass `autonext=0` to disable. |

### Talking to the parent page
When the player runs inside an iframe it posts playback events to `window.parent` as JSON strings, so your page can store watch position, drive analytics or react to the end of an episode:

```js
window.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  try {
    const payload = JSON.parse(event.data);
    if (payload.type !== "PLAYER_EVENT") return;
    // payload.event: "ready" | "play" | "pause" | "seeked" | "timeupdate" | "ended"
    if (payload.event === "timeupdate") {
      // persist payload.currentTime for this title/episode
    }
  } catch {}
});
```

Every message carries `{ type: "PLAYER_EVENT", event, currentTime, duration, mediaType, tmdbId, season, episode, title }`. `timeupdate` is sent at most once per second while playing; `ready` is sent when a stream actually starts; `episodechange` fires when the viewer moves between episodes; `playerstatus` answers a `getStatus` command. Store the position and pass it back on the next visit with `?progress=…`. The player never posts anything when it is opened directly (not embedded).

The debug guard never touches `message` events, so these listeners and the command channel below keep working even while the guard is active.

The parent page can also drive the player (commands are only accepted from the actual parent window):

```js
iframe.contentWindow.postMessage(
  JSON.stringify({ type: "PLAYER_COMMAND", command: "getStatus" }),
  "*"
);
```

Commands: `play`, `pause`, `toggle`, `seek` (`value`/`time` in seconds), `seekBy`, `setVolume` (0–1), `mute`, `unmute`, `setRate` (`rate`), `nextEpisode`, `previousEpisode`, `getStatus`.

## Catalog API
JSON listings for building browse pages. All are TMDB-backed and cached for 30 minutes.

| Endpoint | Notes |
|---|---|
| `GET /api/discover/movies` | `page`, `resultsPerPage` (max 100), `ordering`, `direction`, `query`, `year`, `imdb_id`, `tmdbid`. |
| `GET /api/discover/tv` | Same parameters for series. |
| `GET /api/discover/views` | `type=movie\|tv`, `views=day\|week\|month\|total`, `page`, `resultsPerPage`. |

View counts are not tracked by this project, so `views` orderings and windows fall back to TMDB popularity.

## Customizing
- **Name / tagline / accent:** set `PLAYER_NAME`, `PLAYER_TAGLINE`, `ACCENT_COLOR` in `.env`.
- **Logo / favicon:** replace `public/logo.svg` (keep the filename), or set `LOGO_SRC` to another file you drop in `public/`.

## Subtitles
OpenSubtitles and vdrk are queried per title and served as proxied WebVTT tracks. Disable either with `SUBTITLES_OPENSUBTITLES=false` / `SUBTITLES_VDRK=false`.

## Disclaimer
This software is provided for personal and educational use. It does not host, store, or distribute any media — it aggregates links from third-party sources that are publicly available on the internet, and proxies them. You are solely responsible for how you deploy and use it and for complying with the laws and the terms of any third-party services in your jurisdiction. No warranty of any kind is provided.
