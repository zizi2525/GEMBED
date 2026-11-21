"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Film,
  Tv,
  Copy,
  Check,
  ExternalLink,
  Search,
  Loader2,
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Languages,
  Captions,
  Server,
  FastForward,
  Star,
  ChevronDown,
  Gauge,
  MonitorPlay,
  CircleSlash2,
} from "lucide-react";
import { LANGS } from "@/lib/subtitles";
import type { TmdbItem } from "@/lib/tmdb";

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const PRESETS = [
  { title: "Dune: Part Two", type: "movie" as const, tmdbId: 693134, tag: "Film" },
  { title: "Interstellar", type: "movie" as const, tmdbId: 157336, tag: "Film" },
  { title: "Breaking Bad", type: "tv" as const, tmdbId: 1396, season: 1, episode: 1, tag: "Series" },
  { title: "Demon Slayer", type: "tv" as const, tmdbId: 85937, season: 1, episode: 1, tag: "Anime" },
  { title: "Inception", type: "movie" as const, tmdbId: 27205, tag: "Film" },
];

const ACCENTS = [
  { name: "Curtain", hex: "#E0453A" },
  { name: "Amber", hex: "#E7AE4F" },
  { name: "Emerald", hex: "#3FB68B" },
  { name: "Indigo", hex: "#6366F1" },
  { name: "Ice", hex: "#7DD3FC" },
];

const AUDIO_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "ar", label: "Arabic" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "pt-BR", label: "Brazilian Portuguese" },
  { code: "pt-PT", label: "Portuguese" },
  { code: "hi", label: "Hindi" },
];

const QUALITIES = ["4K", "1440p", "1080p", "720p", "480p", "360p"];

const PLAYER_EVENTS: Array<{ name: string; body: string }> = [
  { name: "ready", body: "A stream actually started after connecting or switching server." },
  { name: "play / pause", body: "Playback started or stopped." },
  { name: "seeked", body: "The viewer jumped to a new position." },
  { name: "timeupdate", body: "Position tick, sent at most once per second while playing." },
  { name: "ended", body: "The film or episode finished - advance, hide the frame, prompt." },
  { name: "playerstatus", body: "Reply to a getStatus command: paused, currentTime, percentage, volume, rate." },
  { name: "episodechange", body: "The viewer moved to another episode - update your page's URL." },
];

// Kept as plain strings so the `${…}` inside the snippet stays literal text.
const EVENT_CODE = [
  '// Store the position the frame reports, then resume with ?progress=',
  'window.addEventListener("message", (event) => {',
  '  if (typeof event.data !== "string") return;',
  '  let payload;',
  '  try {',
  '    payload = JSON.parse(event.data);',
  '  } catch {',
  '    return;',
  '  }',
  '  if (payload.type !== "PLAYER_EVENT") return;',
  "",
  '  // event: ready | play | pause | seeked | timeupdate | ended',
  '  const { event: name, currentTime, duration, mediaType, tmdbId, season, episode } = payload;',
  "",
  '  if (name === "timeupdate") {',
  '    localStorage.setItem(',
  '      `watch:${mediaType}:${tmdbId}:${season ?? 0}:${episode ?? 0}`,',
  '      String(currentTime),',
  '    );',
  '  }',
  "});",
].join("\n");

const FEATURES = [
  {
    icon: <Zap className="h-5 w-5" />,
    title: "Adaptive 4K HLS",
    body: "Quality follows the player size and connection, from 4K down to 360p without a reload.",
  },
  {
    icon: <Languages className="h-5 w-5" />,
    title: "Multi-language audio",
    body: "Original and dubbed tracks are listed in the player. Switching language can also switch server.",
  },
  {
    icon: <Captions className="h-5 w-5" />,
    title: "Subtitles that fit",
    body: `${LANGS.length}+ languages with size, colour, background, edge, position and timing controls.`,
  },
  {
    icon: <Server className="h-5 w-5" />,
    title: "Server failover",
    body: "If a server can't answer, the player moves to the next one and keeps the viewer's position.",
  },
  {
    icon: <FastForward className="h-5 w-5" />,
    title: "Skip intro & credits",
    body: "Intro, recap and credits windows are detected per title, with one-click and automatic skipping.",
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: "Clean by default",
    body: "Upstream provider names are masked, and the server address never appears in the interface.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Pick the route",
    body: "Movies take a TMDB id. Series add the season and episode.",
    code: `/embed/movie/{tmdbId}
/embed/tv/{tmdbId}/{season}/{episode}`,
  },
  {
    n: "02",
    title: "Drop the iframe",
    body: "Give it any 16:9 box. The player fills whatever space it gets.",
    code: `<iframe src="…/embed/movie/27205"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen></iframe>`,
  },
  {
    n: "03",
    title: "Tune the flags",
    body: "Accent, autoplay and preferred audio are optional query parameters.",
    code: `?accent=%23E0453A
&autoplay=1&lang=en`,
  },
];

const FAQ = [
  {
    q: "Do I need an API key on my site?",
    a: "No. Metadata and streams are resolved on the server. The browser only receives the player and the titles you ask for.",
  },
  {
    q: "Why does the first play take a few seconds?",
    a: "The resolver asks several sources at once and returns the first complete set. Once a server is selected, switching between them is instant.",
  },
  {
    q: "Can I change the player colour?",
    a: "Yes. Set the accent swatch here or pass ?accent=%23RRGGBB to the embed URL. The player uses it for the progress bar, active states and primary buttons.",
  },
  {
    q: "Does it remember my audio or subtitle choice?",
    a: "Per device, yes. Subtitle style, favourite servers and the last subtitle language are stored locally in the browser.",
  },
];

interface SearchItem {
  id: number;
  title: string;
  year?: string;
  poster?: string | null;
  rating?: number;
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

function useReveal() {
  useEffect(() => {
    const reduce =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const pending = new Set<HTMLElement>();

    const reveal = (node: HTMLElement) => {
      pending.delete(node);
      node.classList.add("is-in");
    };

    // Reveals everything currently on screen (and anything taller than the
    // viewport). Content is never left invisible: each check is a plain rect
    // test, so a missed observer callback can't strand a section at opacity 0.
    const revealVisible = () => {
      const viewport = window.innerHeight || 1;
      pending.forEach((node) => {
        if (!node.isConnected) {
          pending.delete(node);
          return;
        }
        const rect = node.getBoundingClientRect();
        if (rect.top < viewport * 0.96 && rect.bottom > 0) reveal(node);
      });
    };

    const collect = (root: ParentNode) => {
      if (root instanceof HTMLElement && root.matches("[data-reveal]")) {
        pending.add(root);
      }
      root.querySelectorAll?.<HTMLElement>("[data-reveal]:not(.is-in)").forEach(
        (node) => pending.add(node)
      );
    };

    const sync = () => {
      collect(document);
      revealVisible();
    };

    if (reduce) {
      Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).forEach(
        reveal
      );
      return;
    }

    sync();

    // Scrolling reveals, frame-throttled so it stays cheap on long pages.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        revealVisible();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    // Blocks that render later (async sections, client state changes) are
    // picked up instead of staying hidden.
    const mutations =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            records.forEach((record) => {
              record.addedNodes.forEach((node) => {
                if (node.nodeType === 1) collect(node as unknown as HTMLElement);
              });
            });
            onScroll();
          })
        : null;
    mutations?.observe(document.body, { childList: true, subtree: true });

    // Scroll restoration and late font/poster layout shifts: re-check once the
    // page has settled.
    window.addEventListener("load", sync);
    const settle = window.setTimeout(sync, 700);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("load", sync);
      window.clearTimeout(settle);
      mutations?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}

function useCountUp(target: number, run: boolean, duration = 1500) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!run) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, run, target]);

  return value;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export type Brand = {
  name: string;
  tagline: string;
  url: string;
  logo: string;
};

export function HomePage({ brand }: { brand: Brand }) {
  useReveal();

  const [origin, setOrigin] = useState("");

  /* ------------------------------ preview ------------------------------- */
  const [mediaType, setMediaType] = useState<"movie" | "tv">("movie");
  const [tmdbId, setTmdbId] = useState(693134);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  // The homepage preview starts paused: it is a demo, not something that should
  // begin playing (and make noise) the moment the page opens.
  const [autoplay, setAutoplay] = useState(false);
  const [accent, setAccent] = useState(ACCENTS[0].hex);
  const [audioLang, setAudioLang] = useState("en");

  const [currentTitle, setCurrentTitle] = useState("Dune: Part Two");
  const [currentPoster, setCurrentPoster] = useState<string | null>(null);
  const [currentYear, setCurrentYear] = useState<string | undefined>();
  const [currentRating, setCurrentRating] = useState<number | undefined>();

  useEffect(() => setOrigin(window.location.origin), []);

  const previewPath = useMemo(() => {
    const path =
      mediaType === "movie"
        ? `/embed/movie/${tmdbId}`
        : `/embed/tv/${tmdbId}/${season}/${episode}`;
    const params = new URLSearchParams();
    params.set("accent", accent);
    if (!autoplay) params.set("autoplay", "0");
    if (audioLang !== "en") params.set("lang", audioLang);
    return `${path}?${params.toString()}`;
  }, [accent, audioLang, autoplay, episode, mediaType, season, tmdbId]);

  const [livePath, setLivePath] = useState(previewPath);
  useEffect(() => {
    // An empty / incomplete id would point the preview at a dead route.
    if (!tmdbId) return;
    const timer = setTimeout(() => setLivePath(previewPath), 450);
    return () => clearTimeout(timer);
  }, [previewPath, tmdbId]);

  /* ------------------------------- search ------------------------------- */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(term)}&type=${mediaType}`,
          { signal: controller.signal }
        );
        if (response.ok) {
          const data = await response.json();
          setResults(Array.isArray(data.results) ? data.results : []);
          setSearchOpen(true);
        }
      } catch {
        /* aborted */
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [mediaType, query]);

  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!searchBoxRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen]);

  const selectItem = useCallback(
    (item: { id: number; title: string; poster?: string | null; year?: string; rating?: number }) => {
      setTmdbId(item.id);
      setCurrentTitle(item.title);
      setCurrentPoster(item.poster ?? null);
      setCurrentYear(item.year);
      setCurrentRating(item.rating);
      setQuery(item.title);
      setSearchOpen(false);
    },
    []
  );

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setMediaType(preset.type);
    setTmdbId(preset.tmdbId);
    setSeason(preset.season ?? 1);
    setEpisode(preset.episode ?? 1);
    setCurrentTitle(preset.title);
    setCurrentPoster(null);
    setCurrentYear(undefined);
    setCurrentRating(undefined);
    setQuery("");
    setSearchOpen(false);
  };

  // A TMDB id belongs to one media type, so keeping it across a switch would
  // point the preview at the wrong route (a movie id opened as a series).
  // Switch to that type's default title instead.
  const switchType = (next: "movie" | "tv") => {
    if (next === mediaType) return;
    const preset = PRESETS.find((item) => item.type === next);
    setMediaType(next);
    if (preset) {
      setTmdbId(preset.tmdbId);
      setCurrentTitle(preset.title);
      setSeason(preset.season ?? 1);
      setEpisode(preset.episode ?? 1);
    }
    setCurrentPoster(null);
    setCurrentYear(undefined);
    setCurrentRating(undefined);
    setQuery("");
    setResults([]);
    setSearchOpen(false);
  };

  /* ------------------------------- embed -------------------------------- */
  const [codeTab, setCodeTab] = useState<"html" | "react">("html");
  const [copied, setCopied] = useState(false);

  const embedCode = useMemo(() => {
    const src = `${origin}${previewPath}` || previewPath;
    if (codeTab === "react") {
      return `export function StreamEmbed() {
  return (
    <div style={{ aspectRatio: "16 / 9", width: "100%" }}>
      <iframe
        src="${src}"
        style={{ width: "100%", height: "100%", border: 0 }}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}`;
    }
    return `<div style="aspect-ratio: 16 / 9; width: 100%">
  <iframe
    src="${src}"
    style="width: 100%; height: 100%; border: 0"
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
    allowfullscreen
  ></iframe>
</div>`;
  }, [codeTab, origin, previewPath]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard denied */
    }
  };

  const [eventsCopied, setEventsCopied] = useState(false);
  const copyEvents = async () => {
    try {
      await navigator.clipboard.writeText(EVENT_CODE);
      setEventsCopied(true);
      setTimeout(() => setEventsCopied(false), 1800);
    } catch {
      /* clipboard denied */
    }
  };

  /* ---------------------------- poster data ----------------------------- */
  const [trendType, setTrendType] = useState<"movie" | "tv">("movie");
  const [trendItems, setTrendItems] = useState<TmdbItem[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const trendCache = useRef<Record<string, TmdbItem[]>>({});

  useEffect(() => {
    let alive = true;
    const cached = trendCache.current[trendType];
    if (cached) {
      setTrendItems(cached);
      setTrendLoading(false);
      return;
    }
    setTrendLoading(true);
    fetch(`/api/popular?type=${trendType}`)
      .then((r) => r.json())
      .then((data) => {
        const items: TmdbItem[] = (data.results || []).slice(0, 12);
        trendCache.current[trendType] = items;
        if (alive) setTrendItems(items);
      })
      .catch(() => { })
      .finally(() => {
        if (alive) setTrendLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [trendType]);

  const pickTrending = (item: TmdbItem) => {
    selectItem({
      id: item.id,
      title: item.title,
      poster: item.poster,
      year: item.year,
      rating: item.rating,
    });
    setMediaType(trendType);
    if (trendType === "tv") {
      setSeason(1);
      setEpisode(1);
    }
    document.getElementById("play")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* ------------------------------- stats -------------------------------- */
  const statsRef = useRef<HTMLDivElement>(null);
  const [statsRun, setStatsRun] = useState(false);

  useEffect(() => {
    const node = statsRef.current;
    if (!node) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStatsRun(true);
      return;
    }

    let done = false;
    let frame = 0;
    const stop = () => {
      done = true;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
    const check = () => {
      if (done) return;
      const rect = node.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      if (rect.top < viewport * 0.9 && rect.bottom > 0) {
        stop();
        setStatsRun(true);
      }
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        check();
      });
    };

    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const subCount = useCountUp(LANGS.length, statsRun, 1200);
  const qualityCount = useCountUp(QUALITIES.length, statsRun, 1000);
  const TMDBCount = useCountUp(12, statsRun, 1000);
  /* ------------------------------- faq ---------------------------------- */
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  /* ------------------------------- render ------------------------------- */
  return (
    <div className="relative z-10 min-h-screen text-bone">
      {/* ------------------------------- header ------------------------------ */}
      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-ink">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          <a
            href={brand.url || "/"}
            className="flex items-center gap-2.5"
            aria-label={brand.name}
          >
            <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] bg-bone text-ink">
              {brand.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logo} alt="" className="h-full w-full object-contain" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 fill-current" />
              )}
            </span>
            <span className="leading-none">
              <span className="block font-display text-[17px] font-semibold tracking-tight">
                {brand.name}
              </span>
              <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.22em] text-muted">
                Embed player
              </span>
            </span>
          </a>

          <nav className="hidden items-center gap-7 text-[13px] text-muted lg:flex">
            <a href="#play" className="transition hover:text-bone">
              Playground
            </a>
            <a href="#coverage" className="transition hover:text-bone">
              Coverage
            </a>
            <a href="#features" className="transition hover:text-bone">
              Features
            </a>
            <a href="#how" className="transition hover:text-bone">
              How it works
            </a>
            <a href="#events" className="transition hover:text-bone">
              Events
            </a>
            <a href="#faq" className="transition hover:text-bone">
              FAQ
            </a>
          </nav>

          <a
            href={livePath}
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-1.5 rounded-lg bg-bone px-3.5 py-2 text-[12.5px] font-semibold text-ink transition hover:bg-white"
          >
            Open player
            <ExternalLink className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-6 lg:px-8">
        {/* -------------------------------- hero ------------------------------- */}
        <section className="relative pb-10 pt-16 text-center sm:pt-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 mx-auto h-[380px] max-w-3xl bg-[radial-gradient(ellipse_at_top,_rgba(224,69,58,0.22),_transparent_70%)]"
          />

          <div
            data-reveal
            className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-curtain" />
            TMDB · multi-server · no keys in the browser
          </div>

          <h1 className="mx-auto mt-6 max-w-4xl font-display text-[2.7rem] font-semibold leading-[0.97] tracking-[-0.035em] sm:text-6xl lg:text-[4.6rem]">
            <span className="block">
              <span className="kinetic-word" style={{ animationDelay: "80ms" }}>
                Stream&nbsp;
              </span>
              <span className="kinetic-word" style={{ animationDelay: "150ms" }}>
                anything.
              </span>
            </span>
            <span className="block">
              <span className="kinetic-word" style={{ animationDelay: "230ms" }}>
                Embed&nbsp;
              </span>
              <span className="kinetic-word text-curtain" style={{ animationDelay: "300ms" }}>
                anywhere.
              </span>
            </span>
          </h1>

          <p
            data-reveal
            style={{ transitionDelay: "160ms" }}
            className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted"
          >
            One iframe plays any movie or episode from a TMDB id: multi-server
            failover, multi-language audio, styled subtitles and skip-intro.
          </p>

          <div
            data-reveal
            style={{ transitionDelay: "240ms" }}
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
          >
            <a
              href="#play"
              className="flex items-center gap-2 rounded-xl bg-curtain px-5 py-3 text-sm font-semibold text-white shadow-[0_16px_40px_-16px_rgba(224,69,58,0.9)] transition hover:brightness-110"
            >
              <Play className="h-4 w-4 fill-current" />
              Try the player
            </a>
            <a
              href="#how"
              className="flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-bone transition hover:bg-white/[0.08]"
            >
              How it works
            </a>
          </div>

          <div
            data-reveal
            style={{ transitionDelay: "320ms" }}
            className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted/70"
          >
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3 w-3 text-emerald-400/80" /> Private keys
            </span>
            <span className="flex items-center gap-1.5">
              <Server className="h-3 w-3 text-emerald-400/80" /> Server failover
            </span>
            <span className="flex items-center gap-1.5">
              <Captions className="h-3 w-3 text-emerald-400/80" /> {LANGS.length}+ subtitle languages
            </span>
          </div>
        </section>

        {/* ------------------------------ playground ---------------------------- */}
        <section id="play" className="scroll-mt-24">
          <div
            data-reveal
                            className="rounded-[26px] border border-white/10 bg-house p-2.5 shadow-[0_40px_120px_-60px_rgba(0,0,0,0.9)] sm:p-4"
          >
            {/* toolbar */}
            <div className="flex flex-col gap-3 px-1 pb-3 pt-1 xl:flex-row xl:items-center">
              <div className="flex items-center gap-2">
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-black/35 p-1">
                  <button
                    type="button"
                    onClick={() => switchType("movie")}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${mediaType === "movie" ? "bg-bone text-ink" : "text-muted hover:text-bone"
                      }`}
                  >
                    <Film className="h-3.5 w-3.5" /> Movie
                  </button>
                  <button
                    type="button"
                    onClick={() => switchType("tv")}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${mediaType === "tv" ? "bg-bone text-ink" : "text-muted hover:text-bone"
                      }`}
                  >
                    <Tv className="h-3.5 w-3.5" /> Series
                  </button>
                </div>

                {currentTitle && (
                  <div className="hidden min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-black/25 py-1 pl-1 pr-3 sm:flex">
                    <span className="h-8 w-6 shrink-0 overflow-hidden rounded bg-black/60">
                      {currentPoster ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={currentPoster} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Film className="h-3 w-3 text-muted/60" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block max-w-[180px] truncate text-[12px] font-semibold text-bone">
                        {currentTitle}
                      </span>
                      <span className="block font-mono text-[9px] uppercase tracking-[0.1em] text-muted">
                        {currentYear || "TMDB"} {currentRating ? `· ★ ${currentRating.toFixed(1)}` : ""}
                      </span>
                    </span>
                  </div>
                )}
              </div>

              {/* search */}
              <div ref={searchBoxRef} className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/70" />
                <input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onFocus={() => results.length > 0 && setSearchOpen(true)}
                  placeholder={`Search a ${mediaType === "movie" ? "movie" : "series"} by title…`}
                  autoComplete="off"
                  aria-label="Search TMDB"
                  className="h-11 w-full rounded-xl border border-white/10 bg-black/35 pl-9 pr-9 text-sm text-bone placeholder:text-muted/60 focus:border-curtain/70 focus:outline-none focus:ring-1 focus:ring-curtain/30"
                />
                {searching && (
                  <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-curtain" />
                )}

                {searchOpen && results.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-[#141210] p-1 shadow-2xl">
                    {results.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => selectItem(item)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/[0.07]"
                      >
                        <span className="h-14 w-10 shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
                          {item.poster ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={item.poster} alt="" className="h-full w-full object-cover" loading="lazy" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center">
                              <Film className="h-4 w-4 text-muted/50" />
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-bone">
                            {item.title}
                          </span>
                          <span className="mt-0.5 block font-mono text-[10px] text-muted">
                            {item.year || "—"}
                            {item.rating ? ` · ★ ${item.rating.toFixed(1)}` : ""}
                          </span>
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted/40" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div>
                  <label
                    htmlFor="tmdb-id"
                    className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-muted/60"
                  >
                    TMDB id
                  </label>
                  <input
                    id="tmdb-id"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="e.g. 27205"
                    value={tmdbId ? String(tmdbId) : ""}
                    onChange={(event) =>
                      setTmdbId(Number(event.target.value.replace(/\D/g, "")) || 0)
                    }
                    className="h-9 w-[104px] rounded-lg border border-white/10 bg-black/35 px-2.5 font-mono text-[12px] text-bone placeholder:text-muted/50 focus:border-curtain/70 focus:outline-none"
                  />
                </div>
                {mediaType === "tv" && (
                  <>
                    <div>
                      <label
                        htmlFor="season"
                        className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-muted/60"
                      >
                        Season
                      </label>
                      <input
                        id="season"
                        type="number"
                        min={1}
                        value={season}
                        onChange={(event) => setSeason(Math.max(1, Number(event.target.value) || 1))}
                        className="h-9 w-16 rounded-lg border border-white/10 bg-black/35 px-2.5 font-mono text-[12px] text-bone focus:border-curtain/70 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="episode"
                        className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-muted/60"
                      >
                        Episode
                      </label>
                      <input
                        id="episode"
                        type="number"
                        min={1}
                        value={episode}
                        onChange={(event) => setEpisode(Math.max(1, Number(event.target.value) || 1))}
                        className="h-9 w-16 rounded-lg border border-white/10 bg-black/35 px-2.5 font-mono text-[12px] text-bone focus:border-curtain/70 focus:outline-none"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* preview */}
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-black">
              <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3.5 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-curtain">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-curtain" />
                    Live preview
                  </span>
                  <span className="truncate font-mono text-[10px] text-muted/50">
                    {previewPath.split("?")[0]}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void copy(embedCode)}
                    className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10.5px] font-semibold text-bone/80 transition hover:bg-white/[0.08] hover:text-bone"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> Copy embed
                      </>
                    )}
                  </button>
                  <a
                    href={livePath}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[10px] font-semibold text-muted transition hover:text-bone"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>

              <div className="relative aspect-video w-full">
                <iframe
                  key={livePath}
                  src={livePath}
                  title="Player preview"
                  className="absolute inset-0 h-full w-full border-0"
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>

            {/* options */}
            <div className="flex flex-col gap-4 px-1 pb-1 pt-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted/70">
                    Accent
                  </span>
                  <div className="flex items-center gap-2">
                    {ACCENTS.map((color) => (
                      <button
                        key={color.hex}
                        type="button"
                        onClick={() => setAccent(color.hex)}
                        title={color.name}
                        aria-label={`${color.name} accent`}
                        aria-pressed={accent === color.hex}
                        className={`h-6 w-6 rounded-full transition hover:scale-110 ${accent === color.hex
                          ? "outline outline-2 outline-offset-2 outline-bone"
                          : "outline outline-1 outline-offset-0 outline-white/15"
                          }`}
                        style={{ backgroundColor: color.hex }}
                      />
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 text-[12px] text-muted">
                  Audio
                  <select
                    value={audioLang}
                    onChange={(event) => setAudioLang(event.target.value)}
                    className="h-8 rounded-lg border border-white/10 bg-black/40 px-2 text-[11.5px] text-bone focus:border-curtain/60 focus:outline-none"
                    style={{ colorScheme: "dark" }}
                  >
                    {AUDIO_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-2 text-[12px] text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoplay}
                    onClick={() => setAutoplay((value) => !value)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${autoplay ? "bg-curtain" : "bg-white/15"
                      }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${autoplay ? "translate-x-4" : "translate-x-0.5"
                        }`}
                    />
                  </button>
                  Autoplay
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {PRESETS.slice(0, 4).map((preset) => (
                  <button
                    key={preset.tmdbId}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium text-muted transition hover:border-white/20 hover:text-bone"
                  >
                    {preset.title}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* code */}
          <div data-reveal className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-house">
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3 py-2">
              <div className="flex items-center gap-1">
                {(["html", "react"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setCodeTab(tab)}
                    className={`rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition ${codeTab === tab ? "bg-bone/10 text-bone" : "text-muted hover:text-bone"
                      }`}
                  >
                    {tab === "html" ? "HTML" : "React"}
                  </button>
                ))}
              </div>
              <span className="font-mono text-[10px] text-muted/50">
                Responsive 16:9 · fills its container
              </span>
            </div>
            <pre className="max-h-56 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-bone/70">
              <code>{embedCode}</code>
            </pre>
          </div>
        </section>

        {/* ------------------------------- coverage ---------------------------- */}
        <section id="coverage" className="scroll-mt-24 pt-20 sm:pt-28">
          <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
            <div
              ref={statsRef}
              data-reveal
              className="rounded-3xl border border-white/10 bg-house p-6 sm:p-8"
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-curtain">
                Coverage
              </span>
              <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
                Any title you can name.
              </h2>
              <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
                Point the player at any movie or episode id. There is no catalog
                to import and no per-title setup.
              </p>

              <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-7">
                <Stat value={String(TMDBCount)} suffix="k+" label="Catalog uploads" hint="Any TMDB id plays" />
                <Stat
                  value={String(subCount)}
                  suffix="+"
                  label="Subtitle languages"
                  hint="Searched in-player"
                />
                <Stat
                  value={String(qualityCount)}
                  suffix=""
                  label="Quality tiers"
                  hint="360p up to 4K"
                />
                <Stat value="4K" suffix="" label="Playback ceiling" hint="HLS ladder" />
              </div>
            </div>

            <div className="grid gap-4">
              <div data-reveal className="rounded-3xl border border-white/10 bg-house p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-bone">Audio tracks</h3>
                  <Languages className="h-4 w-4 text-muted/60" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {AUDIO_LANGUAGES.map((language) => (
                    <Chip key={language.code}>{language.label}</Chip>
                  ))}
                  <Chip muted>+ {Math.max(0, LANGS.length - AUDIO_LANGUAGES.length)} languages in the player</Chip>
                </div>
              </div>

              <div data-reveal style={{ transitionDelay: "80ms" }} className="rounded-3xl border border-white/10 bg-house p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-bone">Quality</h3>
                  <Gauge className="h-4 w-4 text-muted/60" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {QUALITIES.map((quality) => (
                    <Chip key={quality}>{quality}</Chip>
                  ))}
                </div>
              </div>

              <div data-reveal style={{ transitionDelay: "160ms" }} className="overflow-hidden rounded-3xl border border-white/10 bg-house p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-bone">Subtitle coverage</h3>
                  <Captions className="h-4 w-4 text-muted/60" />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {LANGS.slice(0, 24).map(([code, , native]) => (
                    <span
                      key={code}
                      className="whitespace-nowrap rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-muted"
                    >
                      {native}
                    </span>
                  ))}
                  <span className="whitespace-nowrap px-1 py-1 font-mono text-[10px] text-muted/50">
                    + {LANGS.length - 24} more
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------- features ---------------------------- */}
        <section id="features" className="scroll-mt-24 pt-20 sm:pt-28">
          <SectionHead
            eyebrow="Features"
            title="Built for a player you don't have to babysit."
            description="Everything that normally breaks in an embed is handled inside the frame."
          />

          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <article
                key={feature.title}
                data-reveal
                style={{ transitionDelay: `${(index % 3) * 70}ms` }}
                className="group rounded-2xl border border-white/10 bg-house p-5 transition duration-300 hover:-translate-y-1 hover:border-white/20"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-curtain transition group-hover:border-curtain/40 group-hover:bg-curtain/10">
                  {feature.icon}
                </span>
                <h3 className="mt-4 text-[14px] font-semibold text-bone">{feature.title}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* -------------------------------- steps ------------------------------ */}
        <section id="how" className="scroll-mt-24 pt-20 sm:pt-28">
          <SectionHead
            eyebrow="How it works"
            title="Three steps, one iframe."
            description="No SDK, no build step, no keys on the client."
          />

          <div className="mt-8 grid gap-3 lg:grid-cols-3">
            {STEPS.map((step, index) => (
              <article
                key={step.n}
                data-reveal
                style={{ transitionDelay: `${index * 80}ms` }}
                className="overflow-hidden rounded-2xl border border-white/10 bg-house"
              >
                <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                  <span className="font-mono text-[10px] tracking-[0.18em] text-curtain">{step.n}</span>
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted/50">
                    Step
                  </span>
                </div>
                <div className="p-5">
                  <h3 className="text-[14px] font-semibold text-bone">{step.title}</h3>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{step.body}</p>
                  <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-black/45 p-3 font-mono text-[10.5px] leading-relaxed text-bone/65">
                    <code>{step.code}</code>
                  </pre>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ------------------------------- events ------------------------------ */}
        <section id="events" className="scroll-mt-24 pt-20 sm:pt-28">
          <SectionHead
            eyebrow="Player events"
            title="Listen to what the player does."
            description="The frame posts playback events to your page as JSON. No SDK, no handshake."
          />

          <div className="mt-8 grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
            <div data-reveal className="rounded-2xl border border-white/10 bg-house p-6">
              <p className="text-[12.5px] leading-relaxed text-muted">
                While embedded, the player posts to{" "}
                <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-bone/80">
                  window.parent
                </code>{" "}
                as JSON strings. Opened directly, it posts nothing.
              </p>

              <ul className="mt-5 space-y-3">
                {PLAYER_EVENTS.map((item) => (
                  <li key={item.name} className="flex gap-3">
                    <code className="mt-px shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-curtain">
                      {item.name}
                    </code>
                    <span className="text-[12px] leading-relaxed text-muted">{item.body}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-5 border-t border-white/[0.08] pt-4 text-[11.5px] leading-relaxed text-muted/70">
                Every message carries{" "}
                <span className="font-mono text-[10.5px] text-bone/70">
                  currentTime, duration, mediaType, tmdbId, season, episode, title
                </span>
                . Save the position and pass it back with{" "}
                <span className="font-mono text-[10.5px] text-bone/70">?progress=</span>{" "}
                on the next visit.
              </p>

              <div className="mt-4 border-t border-white/[0.08] pt-4">
                <p className="text-[11.5px] leading-relaxed text-muted/70">
                  You can also drive the player. Post{" "}
                  <span className="font-mono text-[10.5px] text-bone/70">
                    {`{ type: "PLAYER_COMMAND", command: "pause" }`}
                  </span>{" "}
                  from the parent page. Commands:{" "}
                  <span className="font-mono text-[10.5px] text-bone/70">
                    play, pause, toggle, seek, seekBy, setVolume, mute, unmute,
                    setRate, nextEpisode, previousEpisode, getStatus
                  </span>
                  .
                </p>
              </div>
            </div>

            <div data-reveal style={{ transitionDelay: "80ms" }} className="overflow-hidden rounded-2xl border border-white/10 bg-house">
              <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3.5 py-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-curtain">
                  Parent page
                </span>
                <button
                  type="button"
                  onClick={() => void copyEvents()}
                  className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10.5px] font-semibold text-bone/80 transition hover:bg-white/[0.08] hover:text-bone"
                >
                  {eventsCopied ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" /> Copy listener
                    </>
                  )}
                </button>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-relaxed text-bone/70">
                <code>{EVENT_CODE}</code>
              </pre>
            </div>
          </div>
        </section>

        {/* ------------------------------ trending ----------------------------- */}
        <section className="pt-20 sm:pt-28">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionHead
              eyebrow="Try something"
              title="Trending this week."
              description="Pick a poster and it loads straight into the player above."
            />
            <div className="flex rounded-xl border border-white/10 bg-black/30 p-1">
              {(["movie", "tv"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setTrendType(type)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition ${trendType === type ? "bg-bone text-ink" : "text-muted hover:text-bone"
                    }`}
                >
                  {type === "movie" ? <Film className="h-3.5 w-3.5" /> : <Tv className="h-3.5 w-3.5" />}
                  {type === "movie" ? "Movies" : "Series"}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-7 grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
            {trendLoading
              ? Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="aspect-[2/3] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.03]"
                />
              ))
              : trendItems.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pickTrending(item)}
                  className="group relative overflow-hidden rounded-xl border border-white/10 bg-black text-left transition duration-300 hover:-translate-y-1 hover:border-white/25 hover:shadow-[0_20px_40px_-20px_rgba(0,0,0,0.9)]"
                >
                  <span className="block aspect-[2/3] w-full overflow-hidden bg-black/60">
                    {item.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.poster}
                        alt={item.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center">
                        <Film className="h-5 w-5 text-muted/40" />
                      </span>
                    )}
                  </span>
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/70 to-transparent p-2.5 pt-8">
                    <span className="block truncate text-[11.5px] font-semibold text-bone">
                      {item.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-muted">
                      {item.rating ? (
                        <>
                          <Star className="h-2.5 w-2.5 fill-film text-film" />
                          {item.rating.toFixed(1)}
                        </>
                      ) : null}
                      <span className="text-muted/40">·</span>
                      {item.year || "—"}
                    </span>
                  </span>
                  <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/75 text-bone opacity-0 transition group-hover:opacity-100">
                    <Play className="ml-0.5 h-3 w-3 fill-current" />
                  </span>
                </button>
              ))}
          </div>
          {!trendLoading && trendItems.length === 0 && (
            <p className="mt-4 text-[12px] text-muted/60">
              Trending titles need a TMDB key on the server.
            </p>
          )}
        </section>

        {/* --------------------------------- faq ------------------------------- */}
        <section id="faq" className="scroll-mt-24 pt-20 sm:pt-28">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div data-reveal>
              <SectionHead
                eyebrow="FAQ"
                title="Good to know."
                description="The short answers. The embed reference is in the code panel above."
              />
            </div>

            <div className="divide-y divide-white/[0.08] border-y border-white/[0.08]">
              {FAQ.map((item, index) => {
                const open = openFaq === index;
                return (
                  <div key={item.q} data-reveal style={{ transitionDelay: `${index * 50}ms` }}>
                    <button
                      type="button"
                      onClick={() => setOpenFaq(open ? null : index)}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-4 py-4 text-left"
                    >
                      <span className="text-[13.5px] font-medium text-bone">{item.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-muted transition-transform duration-300 ${open ? "rotate-180 text-bone" : ""
                          }`}
                      />
                    </button>
                    <div
                      className="grid transition-[grid-template-rows] duration-300 ease-out"
                      style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
                    >
                      <div className="overflow-hidden">
                        <p className="pb-4 pr-8 text-[12.5px] leading-relaxed text-muted">
                          {item.a}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* -------------------------------- note -------------------------------- */}
        <section className="mt-16">
          <div
            data-reveal
            className="flex flex-col items-start gap-4 rounded-3xl border border-white/10 bg-house p-6 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-muted">
                <CircleSlash2 className="h-4 w-4" />
              </span>
              <div>
                <p className="text-[13px] font-semibold text-bone">No media is hosted here.</p>
                <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-muted">
                  {brand.name} is a player and a proxy for publicly available sources.
                  Titles and artwork come from TMDB; playback runs through the host
                  that deploys it.
                </p>
              </div>
            </div>
            <a
              href="#play"
              className="flex shrink-0 items-center gap-2 rounded-xl bg-bone px-4 py-2.5 text-[12.5px] font-semibold text-ink transition hover:bg-white"
            >
              <MonitorPlay className="h-4 w-4" />
              Back to the player
            </a>
          </div>
        </section>
      </main>

      {/* -------------------------------- footer ------------------------------- */}
      <footer className="border-t border-white/[0.07] bg-ink">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-8 text-[11.5px] text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>
            {brand.url ? (
              <a
                href={brand.url}
                className="font-display font-semibold text-bone transition hover:text-white"
              >
                {brand.name}
              </a>
            ) : (
              <span className="font-display font-semibold text-bone">{brand.name}</span>
            )}
            <span className="mx-2 text-muted/30">/</span>
            Embeddable player for TMDB titles
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted/60">
            Metadata by TMDB · streams proxied by your host
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

function SectionHead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div data-reveal className="max-w-xl">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-curtain">
        {eyebrow}
      </span>
      <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-bone sm:text-3xl">
        {title}
      </h2>
      {description && (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{description}</p>
      )}
    </div>
  );
}

function Stat({
  value,
  suffix,
  label,
  hint,
}: {
  value: string;
  suffix: string;
  label: string;
  hint: string;
}) {
  return (
    <div>
      <p className="font-display text-3xl font-semibold tabular-nums tracking-tight text-bone sm:text-4xl">
        {value}
        <span className="text-curtain">{suffix}</span>
      </p>
      <p className="mt-1.5 text-[12px] font-medium text-bone/80">{label}</p>
      <p className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted/60">
        {hint}
      </p>
    </div>
  );
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] ${muted
        ? "border-transparent bg-white/[0.02] text-muted/60"
        : "border-white/10 bg-white/[0.04] text-bone/75"
        }`}
    >
      {children}
    </span>
  );
}
