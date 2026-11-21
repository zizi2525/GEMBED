"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  Mic,
  Captions,
  X,
  Server,
  Settings,
  SkipForward,
  FastForward,
  Check,
  AlertCircle,
  RefreshCw,
  Upload,
  Loader2,
  Wifi,
  WifiOff,
  ListVideo,
} from "lucide-react";
import { HeartIcon, WarnIcon } from "./icons";

import {
  LANGS,
  normLang,
  langLabel,
  isRTL,
  searchSubtitles,
  fetchAndParseSub,
  parseLocalFile,
  replacePromotions,
  setPromoText,
  PTT,
  SUB_FONTS,
  SUB_EDGES,
  EDGE_CSS,
  SUB_STYLE_DEFAULT,
  cueColor,
  cueBackground,
  readSubPrefs,
  writeSubPrefs,
  subChoiceKey,
  readSubChoice,
  writeSubChoice,
  subOffsetKey,
  readSubOffset,
  writeSubOffset,
  fmtOffset,
  readSubLang,
  writeSubLang,
  SUB_OFFSET_STEP,
  SUB_OFFSET_MAX,
  formatAudioLang,
  pickBestAudioTrack,
  type SubtitleCue,
  type SubTrack,
  type SubStyleOptions,
  type VideoInfo,
} from "@/lib/subtitles";
import {
  fetchSegments,
  getActiveSkipSegment,
  type MediaSegments,
  type SkipSegment,
  type SegmentInterval,
} from "@/lib/segments";
import {
  fetchStreams,
  probeStream,
  pickBestStreamIndex,
  type ProbeResult,
  type StreamItem,
} from "@/lib/api";
import {
  discoverAudioRenditions,
  type AudioRendition,
} from "@/lib/hls-audio";
import {
  readResume,
  writeResume,
  clearResume,
  readQualityPref,
  writeQualityPref,
  readEpisodeProgress,
  writeEpisodeProgress,
} from "@/lib/player-store";
import type { TvEpisode } from "@/lib/tmdb";

export interface VidPlayerProps {
  type: "movie" | "tv";
  tmdbId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  title: string;
  backdrop?: string;
  poster?: string;
  overview?: string;
  year?: number;
  autoPlay?: boolean;
  /** Start position in seconds (from the `progress` query param). */
  startAt?: number;
  defaultLang?: string;
  accentColor?: string;
  /** Brand line that replaces upstream subtitle adverts (from PROMO_TEXT). */
  promoText?: string;
  prevHref?: string | null;
  nextHref?: string | null;
  onNextEpisode?: () => void;
  /** Count down into the next episode near the end (default on). */
  autoNext?: boolean;
  /** Base href for episode links, e.g. /tv/1399 (no trailing slash). */
  episodesHrefBase?: string | null;
  /** Query string (including ?) preserved when switching episodes. */
  episodesQuery?: string;
  /** Seasons shown in the episode browser. */
  seasons?: { season: number; name: string; episodeCount: number }[];
  /** Show the episode browser (TV only). */
  showEpisodes?: boolean;
}

type Menu = "servers" | "subtitles" | "audio" | "settings" | null;
type QualityMode = "auto" | number;
type ProbeMap = Record<string, ProbeResult | "checking">;

const FAV_KEY = "vc-fav-servers";
const AUTO_SKIP_KEY = "vc-auto-skip";

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function readFavorites(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(ids));
  } catch {
    /* storage disabled */
  }
}

function readAutoSkip(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(AUTO_SKIP_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAutoSkip(value: boolean) {
  try {
    localStorage.setItem(AUTO_SKIP_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function findCueAt(cues: SubtitleCue[], time: number): SubtitleCue | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (time < cue.start) hi = mid - 1;
    else if (time > cue.end) lo = mid + 1;
    else return cue;
  }
  return null;
}

function cleanCueText(raw: string): string {
  const plain = (raw || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .trim();
  return replacePromotions(plain);
}

function forEachSubtitleTrack(
  video: HTMLVideoElement | null,
  fn: (track: TextTrack) => void
) {
  if (!video) return;
  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track || (track.kind !== "subtitles" && track.kind !== "captions")) continue;
    fn(track);
  }
}

function hideNativeSubtitleTracks(video: HTMLVideoElement | null) {
  forEachSubtitleTrack(video, (track) => {
    if (track.mode === "showing") {
      try {
        track.mode = "hidden";
      } catch {
        /* ignore */
      }
    }
  });
}

function disableNativeSubtitleTracks(video: HTMLVideoElement | null) {
  forEachSubtitleTrack(video, (track) => {
    try {
      track.mode = "disabled";
    } catch {
      /* ignore */
    }
  });
}

/**
 * Reads the active cue of whatever track the media engine is rendering, so
 * embedded HLS subtitle tracks use the same styled overlay as external files.
 */
function readNativeCueAt(video: HTMLVideoElement | null, time: number): string {
  if (!video) return "";
  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track || (track.kind !== "subtitles" && track.kind !== "captions")) continue;
    if (track.mode === "showing") {
      try {
        track.mode = "hidden";
      } catch {
        /* ignore */
      }
    }
    if (track.mode !== "hidden") continue;
    const cues = track.cues;
    if (!cues || !cues.length) continue;
    for (let j = 0; j < cues.length; j++) {
      const cue = cues[j] as TextTrackCue & { text?: string };
      if (!cue) continue;
      if (time >= cue.startTime && time <= cue.endTime) {
        return cleanCueText(cue.text || "");
      }
    }
  }
  return "";
}

function updateProgressDom(
  bar: HTMLDivElement | null,
  thumb: HTMLDivElement | null,
  time: HTMLSpanElement | null,
  current: number,
  duration: number
) {
  const total = duration > 0 ? duration : 1;
  const pct = Math.max(0, Math.min(100, (current / total) * 100));
  if (bar) bar.style.width = `${pct}%`;
  if (thumb) thumb.style.left = `${pct}%`;
  if (time) time.textContent = formatTime(current);
}

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

export function VidPlayer({
  type,
  tmdbId,
  imdbId: initialImdbId,
  season,
  episode,
  title,
  poster,
  autoPlay = true,
  startAt = 0,
  defaultLang = "en",
  accentColor = "#6366f1",
  promoText,
  prevHref,
  nextHref,
  year,
  onNextEpisode,
  autoNext = true,
  episodesHrefBase,
  episodesQuery = "",
  seasons: seasonList = [],
  showEpisodes = false,
}: VidPlayerProps) {
  // Subtitle parsing happens in async callbacks, but set it on every render so
  // a changed brand line is picked up before the next cue is parsed.
  setPromoText(promoText);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const curSeason = type === "tv" ? season || 1 : undefined;
  const curEpisode = type === "tv" ? episode || 1 : undefined;
  const mediaKey = `${type}:${tmdbId}`;
  const resumeKey = `${mediaKey}:${curSeason ?? 0}:${curEpisode ?? 0}`;
  const resumeKeyRef = useRef(resumeKey);
  resumeKeyRef.current = resumeKey;
  const typeRef = useRef(type);
  typeRef.current = type;
  const tmdbIdRef = useRef(tmdbId);
  tmdbIdRef.current = tmdbId;
  const curSeasonRef = useRef(curSeason);
  curSeasonRef.current = curSeason;
  const curEpisodeRef = useRef(curEpisode);
  curEpisodeRef.current = curEpisode;
  const applySubOffsetRef = useRef<(next: number) => void>(() => { });

  /* -------------------------------- streams ------------------------------- */
  const [streams, setStreams] = useState<StreamItem[]>([]);
  const streamsRef = useRef<StreamItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const indexRef = useRef(0);
  const [loadingStreams, setLoadingStreams] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const loadTokenRef = useRef(0);

  const [resolvedImdbId, setResolvedImdbId] = useState<string | undefined>(initialImdbId);
  const currentImdbId = resolvedImdbId || initialImdbId;

  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const favRef = useRef(favorites);
  favRef.current = favorites;

  const [failedIds, setFailedIds] = useState<string[]>([]);
  const failedRef = useRef<Set<string>>(new Set());
  const failedSet = useMemo(() => new Set(failedIds), [failedIds]);

  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState(false);
  const probingRef = useRef(false);

  /* ------------------------------- playback ------------------------------- */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const volumeRef = useRef(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const rateRef = useRef(1);
  const [streamError, setStreamError] = useState<string | null>(null);

  /* ------------------------------ interface ------------------------------- */
  const [menu, setMenu] = useState<Menu>(null);
  const menuRef = useRef<Menu>(null);
  const [showControls, setShowControls] = useState(true);

  /* ------------------------------- quality -------------------------------- */
  const [levels, setLevels] = useState<{ index: number; label: string; height: number; url?: string }[]>([]);
  const [qualityMode, setQualityMode] = useState<QualityMode>("auto");
  const [autoLevel, setAutoLevel] = useState<number | null>(null);

  /* -------------------------------- audio --------------------------------- */
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string; lang: string }[]>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  const [playlistAudio, setPlaylistAudio] = useState<AudioRendition[]>([]);

  /* ----------------------------- skip segments ---------------------------- */
  const [segmentsData, setSegmentsData] = useState<MediaSegments | null>(null);
  const segmentsDataRef = useRef<MediaSegments | null>(null);
  segmentsDataRef.current = segmentsData;
  const [activeSkip, setActiveSkip] = useState<SkipSegment | null>(null);
  const [autoSkipIntro, setAutoSkipIntro] = useState<boolean>(readAutoSkip);
  const autoSkipRef = useRef(autoSkipIntro);
  autoSkipRef.current = autoSkipIntro;
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  /* ------------------------- resume / up-next / list ---------------------- */
  const [resumeToast, setResumeToast] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState(0);
  const [upNext, setUpNext] = useState<number | null>(null);
  const upNextRef = useRef<number | null>(null);
  const upNextDismissedRef = useRef(false);
  const lastResumeSaveRef = useRef(0);
  const explicitStartRef = useRef(Number.isFinite(startAt) && startAt > 0);

  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [episodeSeason, setEpisodeSeason] = useState<number>(curSeason || 1);
  const [episodeItems, setEpisodeItems] = useState<TvEpisode[]>([]);
  const [episodeLoading, setEpisodeLoading] = useState(false);
  const [episodeProgress, setEpisodeProgress] = useState<Record<string, { time: number; duration: number }>>({});

  /* ------------------------- gestures / hold-to-2x ------------------------ */
  const [tapHint, setTapHint] = useState<"back" | "forward" | null>(null);
  const tapStateRef = useRef<{ back: number; forward: number }>({ back: 0, forward: 0 });
  const tapHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const preHoldRateRef = useRef(1);

  // Ensure document referrer policy is no-referrer to protect upstream CDNs (e.g. Vidzy, Vixsrc, matching Gibox)
  useEffect(() => {
    let meta = document.querySelector('meta[name="referrer"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "referrer";
      meta.content = "no-referrer";
      document.head.appendChild(meta);
    } else {
      meta.content = "no-referrer";
    }
  }, []);

  // Intro / recap / credits windows drawn as coloured bands on the seek bar.
  const timelineSegments = useMemo(() => {
    const out: {
      key: string;
      type: SkipSegment["type"];
      label: string;
      start: number;
      end: number;
      color: string;
    }[] = [];
    if (!segmentsData || !duration) return out;

    const add = (
      type: SkipSegment["type"],
      list: SegmentInterval[] | undefined,
      color: string
    ) => {
      if (!Array.isArray(list)) return;
      list.forEach((item, index) => {
        const start = typeof item.start_ms === "number" ? item.start_ms / 1000 : 0;
        const end = typeof item.end_ms === "number" ? item.end_ms / 1000 : duration;
        if (!Number.isFinite(end) || end <= start) return;
        out.push({
          key: `${type}-${index}`,
          type,
          label: type === "intro" ? "Intro" : type === "recap" ? "Recap" : "Credits",
          start: Math.max(0, Math.min(duration, start)),
          end: Math.max(0, Math.min(duration, end)),
          color,
        });
      });
    };

    add("recap", segmentsData.recap, "#38bdf8");
    add("intro", segmentsData.intro, "#fbbf24");
    add("credits", segmentsData.credits, "#fb7185");
    return out;
  }, [accentColor, duration, segmentsData]);

  /* ------------------------------ subtitles ------------------------------- */
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false);
  const subtitlesEnabledRef = useRef(false);
  subtitlesEnabledRef.current = subtitlesEnabled;
  const [subTab, setSubTab] = useState<"tracks" | "style">("tracks");
  // Start from the shared defaults so the first client render matches the
  // server HTML; stored preferences are applied after mount.
  const [subLang, setSubLang] = useState<string>("eng");
  const [subQuery, setSubQuery] = useState("");
  const [embeddedTracks, setEmbeddedTracks] = useState<SubTrack[]>([]);
  const [searchedTracks, setSearchedTracks] = useState<SubTrack[]>([]);
  const [localTracks, setLocalTracks] = useState<SubTrack[]>([]);
  const [activeSubId, setActiveSubId] = useState<string | null>(null);
  const [subCues, setSubCues] = useState<SubtitleCue[]>([]);
  const subCuesRef = useRef<SubtitleCue[]>([]);
  subCuesRef.current = subCues;
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [subSearching, setSubSearching] = useState(false);
  const [subNotice, setSubNotice] = useState<string | null>(null);
  const [subPrefs, setSubPrefs] = useState<SubStyleOptions>({ ...SUB_STYLE_DEFAULT });
  const subOffsetStoreKey = useMemo(
    () => subOffsetKey(mediaKey, curSeason, curEpisode),
    [mediaKey, curSeason, curEpisode]
  );
  const subChoiceStoreKey = useMemo(
    () => subChoiceKey(mediaKey, curSeason, curEpisode),
    [mediaKey, curSeason, curEpisode]
  );
  const [subOffset, setSubOffset] = useState<number>(0);
  const subOffsetRef = useRef(subOffset);
  subOffsetRef.current = subOffset;

  // Hydrate device preferences only after mount (keeps SSR markup stable).
  useEffect(() => {
    setSubPrefs(readSubPrefs());
    setSubLang(readSubLang() || "eng");
    setSubOffset(readSubOffset(subOffsetStoreKey));
  }, [subOffsetStoreKey]);

  // Resume where this device stopped. An explicit `?progress`/`t`/`startAt`
  // always wins, so the embedding page stays in control when it wants to be.
  useEffect(() => {
    if (explicitStartRef.current) return;
    const saved = readResume(resumeKey);
    if (!saved) return;
    pendingSeekRef.current = saved.time;
    setResumeToast(saved.time);
  }, [resumeKey]);

  // Hide the resume notice a few seconds after it appears.
  useEffect(() => {
    if (resumeToast === null) return;
    const timer = setTimeout(() => setResumeToast(null), 9000);
    return () => clearTimeout(timer);
  }, [resumeToast]);

  // A new episode/stream starts with a clean up-next state.
  useEffect(() => {
    upNextDismissedRef.current = false;
    upNextRef.current = null;
    setUpNext(null);
    setPausedAt(0);
    // The previous stream's duration must not leak into the new episode.
    durationRef.current = 0;
  }, [resumeKey]);

  const subFileInputRef = useRef<HTMLInputElement>(null);
  const cueCacheRef = useRef<Map<string, SubtitleCue[]>>(new Map());
  const searchedKeyRef = useRef("");
  const restoredKeyRef = useRef("");

  /* -------------------------- dom / timing refs --------------------------- */
  const durationRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(
    Number.isFinite(startAt) && startAt > 0 ? startAt : null
  );
  const playWhenReadyRef = useRef(autoPlay);
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const defaultLangRef = useRef(defaultLang);
  defaultLangRef.current = defaultLang;
  const lastSkipKeyRef = useRef<string | null>(null);
  const lastSeekAtRef = useRef(0);
  const lastCueRef = useRef("");
  const lastFailoverRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* --------------------------- embedder events ---------------------------- */
  // When the player runs inside an iframe it reports playback to the embedding
  // page as JSON strings: { type: "PLAYER_EVENT", event, currentTime, ... }.
  const embeddedRef = useRef(false);
  const lastTimeUpdatePostRef = useRef(0);
  const readyStreamUrlRef = useRef<string | null>(null);

  useEffect(() => {
    embeddedRef.current = typeof window !== "undefined" && window.parent !== window;
  }, []);

  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressThumbRef = useRef<HTMLDivElement>(null);
  const bufferedBarRef = useRef<HTMLDivElement>(null);
  const timeCurrentTextRef = useRef<HTMLSpanElement>(null);
  const timeDurationTextRef = useRef<HTMLSpanElement>(null);
  const hoverTooltipRef = useRef<HTMLDivElement>(null);
  const subContainerRef = useRef<HTMLDivElement>(null);
  const subTextRef = useRef<HTMLDivElement>(null);

  const failoverRef = useRef<(reason: string) => void>(() => { });
  const markOnlineRef = useRef<(id: string) => void>(() => { });
  const selectSubtitleRef = useRef<(track: SubTrack | null) => Promise<void>>(async () => { });

  const currentStream = streams[selectedIndex] ?? null;

  // Discover the audio languages the stream itself advertises. hls.js only
  // exposes them after the manifest attaches; parsing the master playlist here
  // makes the list available immediately and keeps it for browsers that never
  // surface alternate audio on the media element.
  useEffect(() => {
    const url = currentStream?.url;
    setPlaylistAudio([]);
    // `api.ts` already normalises .mp4/.webm/.mkv streams to type "mp4".
    if (!url || currentStream.type === "mp4") return;

    const controller = new AbortController();
    discoverAudioRenditions(url, controller.signal).then((tracks) => {
      if (controller.signal.aborted || tracks.length === 0) return;
      setPlaylistAudio(tracks);
    });
    return () => controller.abort();
  }, [currentStream?.url, currentStream?.type]);
  const currentStreamRef = useRef<StreamItem | null>(currentStream);
  currentStreamRef.current = currentStream;

  // Switching server loads different media: the old countdown and duration
  // must not carry over into it.
  useEffect(() => {
    upNextDismissedRef.current = false;
    upNextRef.current = null;
    setUpNext(null);
    durationRef.current = 0;
  }, [currentStream?.url]);

  const currentQualityLabel =
    qualityMode === "auto"
      ? levels.find((l) => l.index === autoLevel)?.label
      : levels.find((l) => l.index === qualityMode)?.label;

  const hasNextEpisode = Boolean(nextHref || onNextEpisode);
  const hasNextRef = useRef(hasNextEpisode);
  hasNextRef.current = hasNextEpisode;
  const autoNextRef = useRef(autoNext);
  autoNextRef.current = autoNext;

  /* --------------------------- favorite handling -------------------------- */
  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeFavorites(next);
      return next;
    });
  }, []);

  const markOnline = useCallback((id: string) => {
    if (!failedRef.current.has(id)) return;
    const next = new Set(failedRef.current);
    next.delete(id);
    failedRef.current = next;
    setFailedIds(Array.from(next));
  }, []);
  markOnlineRef.current = markOnline;

  /* ------------------------------- switching ------------------------------ */
  const switchTo = useCallback((nextIndex: number) => {
    const list = streamsRef.current;
    if (nextIndex < 0 || nextIndex >= list.length || nextIndex === indexRef.current) return;
    const video = videoRef.current;
    if (video) {
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
        pendingSeekRef.current = video.currentTime;
      }
      playWhenReadyRef.current = !video.paused;
      try {
        video.pause();
      } catch {
        /* ignore */
      }
    }
    indexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
    setSwitching(true);
    setStreamError(null);
  }, []);

  const failover = useCallback(
    (reason: string) => {
      const now = Date.now();
      if (now - lastFailoverRef.current < 1500) return;
      lastFailoverRef.current = now;

      const list = streamsRef.current;
      const index = indexRef.current;
      const current = list[index];
      if (!current) return;

      const failed = new Set(failedRef.current);
      failed.add(current.id);
      failedRef.current = failed;
      setFailedIds(Array.from(failed));

      const candidates = list
        .map((stream, i) => ({ stream, i }))
        .filter(({ stream, i }) => i !== index && !failed.has(stream.id));

      const next =
        candidates.find(({ stream }) => favRef.current.includes(stream.id)) ||
        candidates.find(({ stream }) => stream.lang && stream.lang === current.lang) ||
        candidates[0];

      if (!next) {
        setSwitching(false);
        setIsBuffering(false);
        setStreamError(`${reason} Every server has been tried.`);
        setMenu("servers");
        return;
      }

      switchTo(next.i);
    },
    [switchTo]
  );
  failoverRef.current = failover;

  /* ----------------------------- stream loading --------------------------- */
  const loadStreams = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoadingStreams(true);
    setLoadError(null);
    setStreamError(null);
    setIsBuffering(true);
    failedRef.current = new Set();
    setFailedIds([]);
    setProbes({});

    const result = await fetchStreams({
      type,
      tmdbId,
      season: curSeason,
      episode: curEpisode,
      lang: defaultLangRef.current,
    });
    if (token !== loadTokenRef.current) return;

    setLoadingStreams(false);
    if (result.imdbId) setResolvedImdbId((prev) => prev || result.imdbId);

    if (!result.streams.length) {
      streamsRef.current = [];
      setStreams([]);
      setIsBuffering(false);
      setLoadError(result.error || "No playable servers were found for this title.");
      return;
    }

    streamsRef.current = result.streams;
    setStreams(result.streams);
    const best = pickBestStreamIndex(result.streams, favRef.current, defaultLangRef.current);
    indexRef.current = best;
    setSelectedIndex(best);
    setSwitching(false);
    playWhenReadyRef.current = autoPlayRef.current;
  }, [type, tmdbId, curSeason, curEpisode]);

  useEffect(() => {
    void loadStreams();
    return () => {
      loadTokenRef.current++;
    };
  }, [loadStreams]);

  /* ----------------------------- skip segments ---------------------------- */
  useEffect(() => {
    let active = true;
    fetchSegments({ tmdbId, season: curSeason, episode: curEpisode }).then((data) => {
      if (active) setSegmentsData(data);
    });
    return () => {
      active = false;
    };
  }, [tmdbId, curSeason, curEpisode]);

  /* ------------------------------- the engine ----------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    const stream = currentStream;
    if (!video || !stream) return;

    let disposed = false;
    let netRetries = 0;
    let mediaRetries = 0;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }

    try {
      video.pause();
    } catch {
      /* ignore */
    }
    disableNativeSubtitleTracks(video);
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      /* ignore */
    }

    setLevels([]);
    setQualityMode("auto");
    setAutoLevel(null);
    setAudioTracks([]);
    setActiveAudioTrack(-1);
    setEmbeddedTracks([]);
    setSwitching(true);
    setIsBuffering(true);
    setStreamError(null);

    const teardown = () => {
      disposed = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    const syncAudio = (hls: Hls) => {
      const raw = (hls.audioTracks || []) as unknown as { name?: string; lang?: string }[];
      if (!raw.length) return;
      setAudioTracks(
        raw.map((track, i) => ({
          id: i,
          name: track.name || track.lang || `Track ${i + 1}`,
          lang: track.lang || "",
        }))
      );
      const best = pickBestAudioTrack(raw, defaultLangRef.current);
      hls.audioTrack = best;
      setActiveAudioTrack(best);
    };

    const syncEmbeddedSubs = (hls: Hls) => {
      const raw = (hls.subtitleTracks || []) as unknown as { name?: string; lang?: string }[];
      if (!raw.length) {
        setEmbeddedTracks([]);
        return;
      }
      setEmbeddedTracks(
        raw.map((track, i) => {
          const label =
            track.name ||
            formatAudioLang(track.lang || "", "en") ||
            `Embedded track ${i + 1}`;
          return {
            id: `hls-sub-${i}`,
            label,
            lang: normLang(track.lang || track.name),
            langName: label,
            url: "",
            hlsIndex: i,
          };
        })
      );
    };

    const isHls =
      stream.type !== "mp4" && !/\.(mp4|webm|mkv)(\?|$)/i.test(stream.url);

    video.setAttribute("referrerpolicy", "no-referrer");

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 700,
        fragLoadingRetryDelay: 700,
        fetchSetup(context: { url: string }, requestInit: RequestInit) {
          return new Request(context.url, {
            ...requestInit,
            referrerPolicy: "no-referrer",
            credentials: "omit",
          });
        },
        xhrSetup(xhr: XMLHttpRequest) {
          try {
            xhr.withCredentials = false;
          } catch {
            /* ignore */
          }
        },
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        if (disposed) return;
        const seen = new Set<number>();
        const parsed = data.levels
          .map((level, index) => ({
            index,
            height: level.height || 0,
            label: level.height
              ? `${level.height}p`
              : level.bitrate
                ? `${Math.round(level.bitrate / 1000)}k`
                : `Level ${index + 1}`,
          }))
          .sort((a, b) => b.height - a.height)
          .filter((level) => {
            if (!level.height) return true;
            if (seen.has(level.height)) return false;
            seen.add(level.height);
            return true;
          });
        setLevels(parsed);
        // Restore the viewer's last resolution by height: level indices differ
        // between servers, heights do not.
        const preferredQuality = readQualityPref();
        if (typeof preferredQuality === "number") {
          const match = parsed.find((level) => level.height === preferredQuality);
          if (match) {
            hls.currentLevel = match.index;
            setQualityMode(match.index);
          }
        }
        syncAudio(hls);
        syncEmbeddedSubs(hls);
        markOnlineRef.current(stream.id);
      });

      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!disposed) syncAudio(hls);
      });
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        if (!disposed) setActiveAudioTrack(data.id);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (!disposed) setAutoLevel(data.level);
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
        if (!disposed) syncEmbeddedSubs(hls);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal || disposed) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const manifestFailed =
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
          if (manifestFailed || netRetries >= 2) {
            failoverRef.current("This server didn't answer.");
            return;
          }
          netRetries += 1;
          try {
            hls.startLoad();
          } catch {
            failoverRef.current("This server stopped responding.");
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (mediaRetries >= 2) {
            failoverRef.current("This server's video format couldn't be decoded.");
            return;
          }
          mediaRetries += 1;
          try {
            hls.recoverMediaError();
          } catch {
            failoverRef.current("This server's video format couldn't be decoded.");
          }
        } else {
          failoverRef.current("This server stopped working.");
        }
      });

      hls.attachMedia(video);
      hls.loadSource(stream.url);
      return teardown;
    }

    if (isHls && !video.canPlayType("application/vnd.apple.mpegurl")) {
      setSwitching(false);
      setIsBuffering(false);
      setStreamError("This browser can't play this stream format.");
      return teardown;
    }

    // Native HLS (Safari) and progressive MP4 both use the video element.
    video.setAttribute("referrerpolicy", "no-referrer");
    video.src = stream.url;
    return teardown;
  }, [currentStream?.url, reloadToken]);

  // Populate quality levels for progressive MP4 files carrying multiple resolutions
  useEffect(() => {
    if (!currentStream) return;
    const isHls = currentStream.type !== "mp4" && !currentStream.url.split("?")[0].endsWith(".mp4");
    if (isHls) return;

    const qList = currentStream.qualities;
    if (qList && qList.length > 1) {
      const parsedLevels = qList.map((q, idx) => ({
        index: idx,
        label: q.qualityLabel,
        height: parseInt(q.qualityLabel.replace(/[^\d]/g, ""), 10) || 1080,
        url: q.url,
      }));
      parsedLevels.sort((a, b) => b.height - a.height);
      setLevels(parsedLevels);
      const activeIdx = parsedLevels.findIndex((l) => l.url === currentStream.url);
      setAutoLevel(activeIdx >= 0 ? activeIdx : 0);
      const preferredQuality = readQualityPref();
      if (typeof preferredQuality === "number") {
        const match = parsedLevels.find((level) => level.height === preferredQuality);
        if (match) setQualityMode(match.index);
      }
    } else {
      setLevels([]);
    }
  }, [currentStream?.id, currentStream?.url, currentStream?.qualities]);

  /* ------------------------------ playback UI ----------------------------- */
  const attemptPlay = useCallback((video: HTMLVideoElement) => {
    const result = video.play();
    if (!result || typeof result.catch !== "function") return;
    result.catch(() => {
      // Browsers refuse unmuted autoplay without a user gesture. Start muted
      // so the stream still plays, then offer a one-tap unmute.
      try {
        video.muted = true;
      } catch {
        /* ignore */
      }
      setIsMuted(true);
      video
        .play()
        .then(() => {
          setAutoplayBlocked(true);
          setIsPlaying(true);
        })
        .catch(() => setIsPlaying(false));
    });
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0) {
      durationRef.current = dur;
      setDuration(dur);
      if (timeDurationTextRef.current) timeDurationTextRef.current.textContent = formatTime(dur);
    }
    video.playbackRate = rateRef.current;
    video.volume = volumeRef.current;

    const pending = pendingSeekRef.current;
    if (pending !== null) {
      pendingSeekRef.current = null;
      if (pending > 0.5 && (!Number.isFinite(dur) || pending < dur - 1)) {
        try {
          video.currentTime = pending;
        } catch {
          /* ignore */
        }
      }
    }

    if (playWhenReadyRef.current) {
      playWhenReadyRef.current = false;
      attemptPlay(video);
    }
  }, [attemptPlay]);

  // HLS manifests report their duration progressively, and native HLS can
  // briefly expose a segment-sized value. Keep the known duration in sync so
  // the progress bar and the up-next timer use the real episode length.
  const handleDurationChange = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (Math.abs(dur - durationRef.current) < 0.5) return;
    durationRef.current = dur;
    setDuration(dur);
    if (timeDurationTextRef.current)
      timeDurationTextRef.current.textContent = formatTime(dur);
  }, []);

  const handlePlaying = useCallback(() => {
    setIsPlaying(true);
    setIsBuffering(false);
    setSwitching(false);
    const stream = currentStreamRef.current;
    if (stream) {
      markOnlineRef.current(stream.id);
      if (readyStreamUrlRef.current !== stream.url) {
        readyStreamUrlRef.current = stream.url;
        postPlayerEvent("ready");
      }
    }
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (!video || video.paused || video.ended) return;
      failoverRef.current("This server is taking too long to load.");
    }, 30000);
  }, []);

  const paintSubtitle = useCallback((video: HTMLVideoElement, offset: number) => {
    let text = "";
    if (subtitlesEnabledRef.current) {
      // A positive offset delays the cue: the video clock is compared to
      // (currentTime - offset) so text appears later, not earlier.
      const adjusted = video.currentTime - offset;
      const cues = subCuesRef.current;
      if (cues.length) {
        const cue = findCueAt(cues, adjusted);
        if (cue) text = cleanCueText(cue.text);
      } else {
        text = readNativeCueAt(video, adjusted);
      }
    }

    if (text === lastCueRef.current) return;
    lastCueRef.current = text;
    if (subTextRef.current) {
      subTextRef.current.textContent = text;
      subTextRef.current.style.direction = isRTL(text) ? "rtl" : "ltr";
      subTextRef.current.style.textAlign = "center";
    }
    if (subContainerRef.current) {
      subContainerRef.current.style.display = text ? "flex" : "none";
    }
  }, []);


  /** Reports one playback event to the parent page (embeds only). */
  const postPlayerEvent = useCallback(
    (
      event:
        | "ready"
        | "play"
        | "pause"
        | "seeked"
        | "ended"
        | "timeupdate"
        | "playerstatus"
        | "episodechange",
      extra?: Record<string, unknown>
    ) => {
      if (!embeddedRef.current || typeof window === "undefined") return;
      const video = videoRef.current;
      const currentTime =
        video && Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
      const duration = durationRef.current || (video && Number.isFinite(video.duration) ? video.duration : 0) || 0;
      try {
        window.parent.postMessage(
          JSON.stringify({
            type: "PLAYER_EVENT",
            event,
            currentTime,
            duration,
            mediaType: type,
            tmdbId,
            season: curSeason,
            episode: curEpisode,
            title,
            ...(extra || {}),
          }),
          "*"
        );
      } catch {
        /* parent window unavailable */
      }
    },
    [curEpisode, curSeason, title, tmdbId, type]
  );

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const time = video.currentTime;
    // 0 / NaN duration is not "the end of the episode". Keep an explicit known
    // duration and never let the 1-second progress fallback arm the up-next
    // timer.
    const knownDuration =
      durationRef.current > 0
        ? durationRef.current
        : Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : 0;
    const dur = knownDuration || 1;
    updateProgressDom(
      progressBarRef.current,
      progressThumbRef.current,
      timeCurrentTextRef.current,
      time,
      dur
    );

    const skip = getActiveSkipSegment(segmentsDataRef.current, time);
    const skipKey = skip ? `${skip.type}:${skip.startSec}` : null;
    if (skipKey !== lastSkipKeyRef.current) {
      lastSkipKeyRef.current = skipKey;
      setActiveSkip(skip);
    }
    if (
      autoSkipRef.current &&
      skip &&
      skip.targetSec !== null &&
      (skip.type === "intro" || skip.type === "recap") &&
      !video.seeking &&
      !video.paused &&
      // Don't fight the viewer when they deliberately rewound into the opening.
      Date.now() - lastSeekAtRef.current > 12_000
    ) {
      try {
        video.currentTime = skip.targetSec;
      } catch {
        /* ignore */
      }
      return;
    }

    paintSubtitle(video, subOffsetRef.current);

    // One progress report per second is enough for watch-position tracking.
    const now = Date.now();
    if (now - lastTimeUpdatePostRef.current >= 1000) {
      lastTimeUpdatePostRef.current = now;
      postPlayerEvent("timeupdate");
    }

    // Keep the local resume point fresh without writing on every frame.
    if (now - lastResumeSaveRef.current >= 5000) {
      lastResumeSaveRef.current = now;
      writeResume(resumeKeyRef.current, time, dur);
      if (typeRef.current === "tv" && curEpisodeRef.current) {
        writeEpisodeProgress(
          "tv",
          tmdbIdRef.current,
          curSeasonRef.current || 1,
          curEpisodeRef.current,
          time,
          dur
        );
      }
    }

    // "Up next" card during the final seconds of an episode. A real episode
    // duration must be known first (HLS reports it progressively), otherwise a
    // missing/provisional duration would fire the card at the very start.
    if (
      autoNextRef.current &&
      hasNextRef.current &&
      !upNextDismissedRef.current &&
      knownDuration > 60 &&
      time > 0
    ) {
      const remaining = knownDuration - time;
      if (remaining > 0 && remaining <= 20 && upNextRef.current === null) {
        upNextRef.current = Math.ceil(remaining);
        setUpNext(upNextRef.current);
      }
    }
  }, [paintSubtitle, postPlayerEvent]);

  const handleVideoProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.buffered.length) return;
    const dur = durationRef.current || video.duration || 1;
    const buffered = video.buffered.end(video.buffered.length - 1);
    const pct = Math.max(0, Math.min(100, (buffered / dur) * 100));
    if (bufferedBarRef.current) bufferedBarRef.current.style.width = `${pct}%`;
  }, []);

  const handleVideoError = useCallback(() => {
    if (!currentStreamRef.current) return;
    const code = videoRef.current?.error?.code;
    const reason =
      code === 4
        ? "This server's video format isn't supported here."
        : "This server failed to play the video.";
    failoverRef.current(reason);
  }, []);

  /* ------------------------------- controls ------------------------------- */
  const handleActivity = useCallback(() => {
    setShowControls(true);
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    activityTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (video && !video.paused && !menuRef.current) setShowControls(false);
    }, 3200);
  }, []);

  useEffect(() => {
    menuRef.current = menu;
    if (menu) {
      setShowControls(true);
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    } else {
      handleActivity();
    }
  }, [menu, handleActivity]);

  useEffect(() => {
    return () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    };
  }, []);

  // Clicking anywhere outside an open popover dismisses it.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && !target.closest("[data-player-menu]")) setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setIsPlaying(false));
      handleActivity();
    } else {
      video.pause();
      handleActivity();
    }
  }, [handleActivity]);

  const seek = useCallback((target: number) => {
    const video = videoRef.current;
    if (!video) return;
    lastSeekAtRef.current = Date.now();
    const dur = durationRef.current || video.duration || 1;
    const clamped = Math.max(0, Math.min(target, dur));
    try {
      video.currentTime = clamped;
    } catch {
      /* ignore */
    }
    updateProgressDom(
      progressBarRef.current,
      progressThumbRef.current,
      timeCurrentTextRef.current,
      clamped,
      dur
    );
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      seek(video.currentTime + delta);
    },
    [seek]
  );

  /* --------------------------- tap / hold gestures ------------------------ */
  const flashTapHint = useCallback((side: "back" | "forward") => {
    setTapHint(side);
    if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
    tapHintTimerRef.current = setTimeout(() => setTapHint(null), 700);
  }, []);

  const tapSide = useCallback(
    (side: "back" | "forward") => {
      const now = Date.now();
      if (now - tapStateRef.current[side] < 320) {
        tapStateRef.current[side] = 0;
        seekBy(side === "back" ? -10 : 10);
        flashTapHint(side);
      } else {
        tapStateRef.current[side] = now;
      }
    },
    [flashTapHint, seekBy]
  );

  const beginHold = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdActiveRef.current = true;
      preHoldRateRef.current = rateRef.current;
      const video = videoRef.current;
      if (video) video.playbackRate = 2;
    }, 450);
  }, []);

  const endHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!holdActiveRef.current) return;
    holdActiveRef.current = false;
    const video = videoRef.current;
    if (video) video.playbackRate = preHoldRateRef.current;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    return () => {
      if (tapHintTimerRef.current) clearTimeout(tapHintTimerRef.current);
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  const changeVolume = useCallback((next: number) => {
    const video = videoRef.current;
    const clamped = Math.max(0, Math.min(1, next));
    volumeRef.current = clamped;
    setVolume(clamped);
    if (video) {
      video.volume = clamped;
      video.muted = clamped === 0;
    }
    setIsMuted(clamped === 0);
    if (clamped > 0) setAutoplayBlocked(false);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
    if (!nextMuted) setAutoplayBlocked(false);
    if (!nextMuted && video.volume === 0) {
      video.volume = 0.5;
      volumeRef.current = 0.5;
      setVolume(0.5);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
      | null;
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;

    if (!document.fullscreenElement) {
      if (container?.requestFullscreen) {
        void container.requestFullscreen().catch(() => { });
      } else if (video?.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } else {
      void document.exitFullscreen().catch(() => { });
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const applyRate = useCallback((rate: number) => {
    rateRef.current = rate;
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, []);

  const applyQuality = useCallback((mode: QualityMode) => {
    setQualityMode(mode);
    writeQualityPref(mode === "auto" ? "auto" : levels[mode]?.height ?? "auto");
    const hls = hlsRef.current;
    if (hls) {
      hls.currentLevel = mode === "auto" ? -1 : mode;
      if (mode === "auto") hls.nextLevel = -1;
      return;
    }

    // Progressive MP4 quality switching
    const video = videoRef.current;
    if (!video || mode === "auto") return;
    const target = levels[mode];
    if (target && target.url && target.url !== video.src) {
      const cur = video.currentTime;
      const wasPlaying = !video.paused;
      video.src = target.url;
      video.currentTime = cur;
      if (wasPlaying) {
        void video.play().catch(() => { });
      }
    }
  }, [levels]);

  const selectAudioTrack = useCallback((id: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.audioTrack = id;
    setActiveAudioTrack(id);
  }, []);

  const goNext = useCallback(() => {
    if (onNextEpisode) onNextEpisode();
    else if (nextHref) window.location.href = nextHref;
  }, [nextHref, onNextEpisode]);

  /* --------------------- host page command channel ---------------------- */
  // The parent page can drive the player, not just listen to it. Commands are
  // only accepted from the actual parent window.
  useEffect(() => {
    const onCommand = (event: MessageEvent) => {
      if (typeof window === "undefined" || event.source !== window.parent) return;
      let data: any = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data || data.type !== "PLAYER_COMMAND") return;

      const command = String(data.command || data.action || "");
      const video = videoRef.current;
      const value = Number(data.value ?? data.time ?? data.seconds ?? 0);

      const status = () => {
        const current =
          video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const total =
          durationRef.current ||
          (video && Number.isFinite(video.duration) ? video.duration : 0) ||
          0;
        postPlayerEvent("playerstatus", {
          paused: video ? video.paused : true,
          currentTime: current,
          duration: total,
          percentage: total > 0 ? (current / total) * 100 : 0,
          volume: video ? video.volume : volumeRef.current,
          muted: video ? video.muted : false,
          rate: video ? video.playbackRate : rateRef.current,
        });
      };

      switch (command) {
        case "getStatus":
          status();
          break;
        case "play": {
          const result = video?.play();
          if (result) void result.catch(() => { });
          break;
        }
        case "pause":
          video?.pause();
          break;
        case "toggle":
          togglePlay();
          break;
        case "seek":
          seek(value);
          break;
        case "seekBy":
          seekBy(value);
          break;
        case "setVolume":
          changeVolume(value);
          break;
        case "mute":
          if (video) {
            video.muted = true;
            setIsMuted(true);
          }
          break;
        case "unmute":
          if (video) {
            video.muted = false;
            setIsMuted(false);
          }
          break;
        case "setRate":
          applyRate(Number(data.rate ?? value) || 1);
          break;
        case "nextEpisode":
          if (hasNextRef.current) goNext();
          break;
        case "previousEpisode":
          if (prevHref) window.location.href = prevHref;
          break;
        default:
          break;
      }
    };

    window.addEventListener("message", onCommand);
    return () => window.removeEventListener("message", onCommand);
  }, [
    applyRate,
    changeVolume,
    goNext,
    postPlayerEvent,
    prevHref,
    seek,
    seekBy,
    togglePlay,
  ]);

  /* --------------------------- episode browser --------------------------- */
  const episodeHref = useCallback(
    (nextSeason: number, nextEpisode: number) => {
      if (!episodesHrefBase) return null;
      return `${episodesHrefBase}/${nextSeason}/${nextEpisode}${episodesQuery || ""}`;
    },
    [episodesHrefBase, episodesQuery]
  );

  const openEpisodes = useCallback(() => {
    setMenu(null);
    setEpisodeSeason(curSeason || 1);
    setEpisodesOpen(true);
  }, [curSeason]);

  useEffect(() => {
    if (!episodesOpen || !showEpisodes || !episodesHrefBase) return;
    let active = true;
    setEpisodeLoading(true);
    fetch(`/api/episodes?id=${encodeURIComponent(String(tmdbId))}&season=${episodeSeason}`)
      .then((response) => response.json())
      .then((data) => {
        if (active) {
          setEpisodeItems(Array.isArray(data?.episodes) ? data.episodes : []);
        }
      })
      .catch(() => {
        if (active) setEpisodeItems([]);
      })
      .finally(() => {
        if (active) setEpisodeLoading(false);
      });
    return () => {
      active = false;
    };
  }, [episodeSeason, episodesHrefBase, episodesOpen, showEpisodes, tmdbId]);

  useEffect(() => {
    if (!episodesOpen) return;
    setEpisodeProgress(readEpisodeProgress(type, tmdbId));
  }, [episodesOpen, tmdbId, type]);

  // Let the host page follow the viewer into the next episode.
  useEffect(() => {
    if (type !== "tv") return;
    postPlayerEvent("episodechange", { season: curSeason, episode: curEpisode });
  }, [curEpisode, curSeason, postPlayerEvent, type]);

  // Countdown into the next episode. It pauses while the viewer is paused.
  useEffect(() => {
    if (upNext === null || upNext > 0) return;
    upNextRef.current = null;
    setUpNext(null);
    goNext();
  }, [goNext, upNext]);

  useEffect(() => {
    if (upNext === null) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (video && video.paused) return;
      const next = Math.max(0, (upNextRef.current ?? 1) - 1);
      upNextRef.current = next;
      setUpNext(next);
    }, 1000);
    return () => window.clearInterval(timer);
    // The interval lives while a countdown exists; the ref carries the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upNext === null]);

  const executeSkip = useCallback(() => {
    if (!activeSkip) return;
    if (activeSkip.targetSec !== null) {
      seek(activeSkip.targetSec);
    } else if (activeSkip.type === "credits") {
      // Credits have no end mark: jump to the next episode, or to the end of
      // the video when this is the last one, so the button always does something.
      if (hasNextEpisode) goNext();
      else seek(durationRef.current || videoRef.current?.duration || 0);
    }
    setActiveSkip(null);
  }, [activeSkip, goNext, hasNextEpisode, seek]);

  const toggleAutoSkip = useCallback(() => {
    setAutoSkipIntro((prev) => {
      const next = !prev;
      writeAutoSkip(next);
      return next;
    });
  }, []);

  /* ------------------------------ keyboard -------------------------------- */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

      switch (event.key) {
        case "Escape":
          if (menuRef.current) {
            event.preventDefault();
            setMenu(null);
          }
          break;
        case " ":
        case "k":
        case "K":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
        case "l":
        case "L":
          event.preventDefault();
          seekBy(10);
          handleActivity();
          break;
        case "ArrowLeft":
        case "j":
        case "J":
          event.preventDefault();
          seekBy(-10);
          handleActivity();
          break;
        case "ArrowUp":
          event.preventDefault();
          changeVolume(volumeRef.current + 0.1);
          handleActivity();
          break;
        case "ArrowDown":
          event.preventDefault();
          changeVolume(volumeRef.current - 0.1);
          handleActivity();
          break;
        case "f":
        case "F":
          event.preventDefault();
          toggleFullscreen();
          break;
        case "m":
        case "M":
          event.preventDefault();
          toggleMute();
          handleActivity();
          break;
        case "c":
        case "C":
          event.preventDefault();
          setMenu((prev) => (prev === "subtitles" ? null : "subtitles"));
          break;
        case "n":
        case "N":
          if (hasNextEpisode) {
            event.preventDefault();
            goNext();
          }
          break;
        case "e":
        case "E":
          if (showEpisodes && episodesHrefBase) {
            event.preventDefault();
            openEpisodes();
          }
          break;
        case "i":
        case "I": {
          const video = videoRef.current;
          if (video && typeof video.requestPictureInPicture === "function") {
            event.preventDefault();
            if (document.pictureInPictureElement) {
              void document.exitPictureInPicture().catch(() => { });
            } else {
              void video.requestPictureInPicture().catch(() => { });
            }
          }
          break;
        }
        case "g":
        case "G":
          event.preventDefault();
          applySubOffsetRef.current(subOffsetRef.current - 0.25);
          break;
        case "h":
        case "H":
          event.preventDefault();
          applySubOffsetRef.current(subOffsetRef.current + 0.25);
          break;
        case ">":
        case ".":
          event.preventDefault();
          applyRate(Math.min(2, Math.round((rateRef.current + 0.25) * 100) / 100));
          break;
        case "<":
        case ",":
          event.preventDefault();
          applyRate(Math.max(0.5, Math.round((rateRef.current - 0.25) * 100) / 100));
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    applyRate,
    changeVolume,
    episodesHrefBase,
    goNext,
    handleActivity,
    hasNextEpisode,
    openEpisodes,
    seekBy,
    showEpisodes,
    toggleFullscreen,
    toggleMute,
    togglePlay,
  ]);

  /* ------------------------------ subtitles ------------------------------- */
  const streamSubs = useMemo<SubTrack[]>(() => {
    if (!currentStream?.subtitles?.length) return [];
    return currentStream.subtitles.map((sub, index) => {
      const code = normLang(sub.lang || sub.label);
      const info = langLabel(code);
      return {
        id: `stream-sub-${index}`,
        // Rebuilt from the language so upstream track names never reach the
        // UI. The source is shown as a badge in the menu, not in the label.
        label: info.label || sub.lang || "Subtitles",
        lang: code,
        langName: info.label,
        url: sub.url,
        link: sub.url,
        isStreamSub: true,
      };
    });
  }, [currentStream?.subtitles]);

  const allSubTracks = useMemo(
    () => [...streamSubs, ...embeddedTracks, ...searchedTracks, ...localTracks],
    [streamSubs, embeddedTracks, searchedTracks, localTracks]
  );

  // Server and embedded tracks are filtered to the language chosen for the
  // search, so the list never mixes in tracks in another language. Local files
  // stay visible whatever the selection is.
  const filteredSubTracks = useMemo(() => {
    const q = subQuery.trim().toLowerCase();
    return allSubTracks.filter((track) => {
      if (track.lang === "local") return true;
      if (subLang && track.lang && normLang(track.lang) !== normLang(subLang)) {
        return false;
      }
      if (!q) return true;
      return (
        track.label.toLowerCase().includes(q) ||
        (track.langName || "").toLowerCase().includes(q)
      );
    });
  }, [allSubTracks, subLang, subQuery]);

  const applySubOffset = useCallback(
    (next: number) => {
      const clamped =
        Math.round(Math.max(-SUB_OFFSET_MAX, Math.min(SUB_OFFSET_MAX, next)) * 100) / 100;
      subOffsetRef.current = clamped;
      setSubOffset(clamped);
      writeSubOffset(subOffsetStoreKey, clamped);
      const video = videoRef.current;
      if (video) paintSubtitle(video, clamped);
    },
    [paintSubtitle, subOffsetStoreKey]
  );
  applySubOffsetRef.current = applySubOffset;

  const autoSyncTriedRef = useRef("");

  /**
   * Best-effort sync for obviously offset files: a track whose first line
   * starts minutes in, or that ends long before the film does, is shifted so
   * its extremes line up with the video. Ordinary tracks are left alone, and a
   * saved per-title offset always wins.
   */
  const autoSyncSubtitles = useCallback(() => {
    const cues = subCuesRef.current;
    const total = durationRef.current || videoRef.current?.duration || 0;
    if (!cues.length || !total) {
      setSubNotice("Pick a subtitle track first.");
      return;
    }
    const first = cues[0].start;
    const last = cues[cues.length - 1].end;
    let shift = 0;
    if (first > 90) shift = 12 - first;
    else if (last < total - 150) shift = total - 20 - last;
    else if (last > total + 60) shift = total - 20 - last;
    if (!shift) {
      setSubNotice("Timing already looks right.");
      return;
    }
    const rounded = Math.round(shift * 10) / 10;
    applySubOffset(rounded);
    setSubNotice(
      `Adjusted subtitle timing by ${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}s`
    );
  }, [applySubOffset]);

  useEffect(() => {
    if (autoSyncTriedRef.current === subOffsetStoreKey) return;
    if (!subCues.length || !duration) return;
    autoSyncTriedRef.current = subOffsetStoreKey;
    if (readSubOffset(subOffsetStoreKey) !== 0) return;
    const first = subCues[0].start;
    const last = subCues[subCues.length - 1].end;
    let shift = 0;
    if (first > 90) shift = 12 - first;
    else if (last < duration - 150) shift = duration - 20 - last;
    else if (last > duration + 60) shift = duration - 20 - last;
    if (!shift) return;
    applySubOffset(Math.round(shift * 10) / 10);
  }, [applySubOffset, duration, subCues, subOffsetStoreKey]);

  const updateSubPrefs = useCallback((next: SubStyleOptions) => {
    setSubPrefs(next);
    writeSubPrefs(next);
  }, []);

  const clearSubtitleText = useCallback(() => {
    lastCueRef.current = "";
    if (subTextRef.current) subTextRef.current.textContent = "";
    if (subContainerRef.current) subContainerRef.current.style.display = "none";
  }, []);

  const selectSubtitle = useCallback(
    async (track: SubTrack | null) => {
      const video = videoRef.current;
      const hls = hlsRef.current;
      setSubNotice(null);
      clearSubtitleText();

      if (!track) {
        setActiveSubId(null);
        setSubtitlesEnabled(false);
        setSubCues([]);
        subCuesRef.current = [];
        if (hls) hls.subtitleTrack = -1;
        disableNativeSubtitleTracks(video);
        writeSubChoice(subChoiceStoreKey, null);
        return;
      }

      setActiveSubId(track.id);
      setSubtitlesEnabled(true);
      // Picking a track is also the language preference: remember it so the
      // next episode searches in the same language.
      if (track.lang && track.lang !== "local") {
        const code = normLang(track.lang);
        setSubLang(code);
        writeSubLang(code);
      }
      writeSubChoice(subChoiceStoreKey, {
        id: track.id,
        lang: track.lang === "local" ? undefined : track.lang,
        local: track.lang === "local",
      });

      if (typeof track.hlsIndex === "number") {
        setSubCues([]);
        subCuesRef.current = [];
        setLoadingSubs(false);
        if (hls) hls.subtitleTrack = track.hlsIndex;
        // Leave the native track loaded but hidden; we draw its cues ourselves.
        window.setTimeout(() => hideNativeSubtitleTracks(video), 150);
        return;
      }

      if (hls) hls.subtitleTrack = -1;
      disableNativeSubtitleTracks(video);

      const cached = cueCacheRef.current.get(track.id) || track.cues;
      if (cached && cached.length) {
        setSubCues(cached);
        subCuesRef.current = cached;
        return;
      }

      const source = track.link || track.url;
      if (!source) {
        setSubNotice("This track has no subtitle file.");
        return;
      }

      setLoadingSubs(true);
      try {
        const parsed = await fetchAndParseSub(source, track.encoding);
        if (!parsed || !parsed.cues.length) {
          setSubNotice("That subtitle file was empty. Try another track.");
          setSubtitlesEnabled(false);
          setActiveSubId(null);
          writeSubChoice(subChoiceStoreKey, null);
          return;
        }
        cueCacheRef.current.set(track.id, parsed.cues);
        setSubCues(parsed.cues);
        subCuesRef.current = parsed.cues;
      } catch {
        setSubNotice("That subtitle couldn't be downloaded. Try another track.");
        setSubtitlesEnabled(false);
        setActiveSubId(null);
        writeSubChoice(subChoiceStoreKey, null);
      } finally {
        setLoadingSubs(false);
      }
    },
    [clearSubtitleText, subChoiceStoreKey]
  );
  selectSubtitleRef.current = selectSubtitle;

  const searchSubs = useCallback(
    async (lang: string, autoPick = false) => {
      const lang3 = normLang(lang || "en");
      const key = `${lang3}|${type}|${tmdbId}|${curSeason ?? 0}|${curEpisode ?? 0}`;
      if (!autoPick && searchedKeyRef.current === key) return;

      setSubSearching(true);
      setSubNotice(null);
      try {
        const results = await searchSubtitles({
          imdbId: currentImdbId,
          lang: lang3,
          type,
          season: curSeason,
          episode: curEpisode,
          title,
          year,
        });

        const videoInfo: VideoInfo = {
          title: title.toLowerCase(),
          year: year ?? null,
          season: curSeason ?? null,
          episode: curEpisode ?? null,
          quality: "1080p",
          resolution: "1080p",
        };

        const scored = results
          .map((item) => ({
            item,
            score: PTT.score(videoInfo, item.fileName || item.releaseName || item.label),
            downloads: item.downloads || 0,
          }))
          .sort((a, b) =>
            b.score !== a.score ? b.score - a.score : b.downloads - a.downloads
          );

        const mapped: SubTrack[] = scored.map(({ item, score, downloads }) => ({
          id: item.id,
          label: item.label,
          lang: lang3,
          langName: langLabel(lang3).label,
          url: item.downloadUrl,
          link: item.downloadUrl,
          encoding: item.encoding || "UTF-8",
          score,
          downloads,
        }));

        setSearchedTracks(mapped);
        searchedKeyRef.current = key;

        if (!mapped.length) {
          setSubNotice("No subtitles found for this language.");
          return;
        }

        if (autoPick) {
          const best = PTT.best(videoInfo, results);
          const bestTrack =
            best && best.score >= 35
              ? mapped.find((track) => track.id === best.subtitle.id)
              : undefined;
          void selectSubtitleRef.current(bestTrack || mapped[0]);
        }
      } catch {
        setSubNotice("Subtitle search is unavailable right now.");
      } finally {
        setSubSearching(false);
      }
    },
    [currentImdbId, curEpisode, curSeason, title, tmdbId, type, year]
  );

  // First open of the subtitle menu starts a lazy search.
  useEffect(() => {
    if (menu !== "subtitles") return;
    if (searchedKeyRef.current) return;
    void searchSubs(subLang);
  }, [menu, searchSubs, subLang]);

  // Warm the search in the viewer's saved language in the background, so other
  // languages are already there when they open the menu on a new title.
  const prefetchedLangRef = useRef("");
  useEffect(() => {
    if (!currentStream || searchedKeyRef.current) return;
    const saved = readSubLang();
    if (!saved || saved === "eng") return;
    const signature = `${resumeKey}:${saved}`;
    if (prefetchedLangRef.current === signature) return;
    prefetchedLangRef.current = signature;
    void searchSubs(saved, true);
  }, [currentStream, resumeKey, searchSubs]);

  // Restore the subtitle chosen for this episode, but let the user override it.
  // Track ids are per-server (stream tracks) or per-search, so the language is
  // the durable part: match it first, then fall back to the id.
  const subRestoreSig = useMemo(
    () => `${subChoiceStoreKey}|${allSubTracks.map((t) => `${t.id}:${t.lang}`).join(",")}`,
    [subChoiceStoreKey, allSubTracks]
  );
  useEffect(() => {
    if (restoredKeyRef.current === subRestoreSig) return;
    const saved = readSubChoice(subChoiceStoreKey);
    if (!saved) {
      restoredKeyRef.current = subRestoreSig;
      return;
    }
    if (!allSubTracks.length) return;
    const savedLang = saved.local || !saved.lang ? "" : normLang(saved.lang);
    const found =
      (savedLang
        ? allSubTracks.find((t) => t.lang !== "local" && normLang(t.lang) === savedLang)
        : undefined) || allSubTracks.find((t) => t.id === saved.id);
    restoredKeyRef.current = subRestoreSig;
    if (found) void selectSubtitle(found);
    else if (savedLang) void searchSubs(savedLang, true);
  }, [allSubTracks, searchSubs, selectSubtitle, subChoiceStoreKey, subRestoreSig]);

  const handleLocalSubFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const parsed = await parseLocalFile(file);
      if (!parsed) {
        setSubNotice("That file couldn't be read. Use a .srt or .vtt file.");
        return;
      }
      const track: SubTrack = {
        id: `local:${file.name}:${file.size}`,
        label: parsed.label,
        lang: "local",
        langName: "Local file",
        url: parsed.vttUrl,
        cues: parsed.cues,
      };
      cueCacheRef.current.set(track.id, parsed.cues);
      setLocalTracks((prev) => [track, ...prev.filter((t) => t.id !== track.id)]);
      void selectSubtitle(track);
      setMenu(null);
    },
    [selectSubtitle]
  );

  // Clear the caption line the moment subtitles are switched off.
  useEffect(() => {
    if (!subtitlesEnabled) {
      lastCueRef.current = "";
      if (subTextRef.current) subTextRef.current.textContent = "";
      if (subContainerRef.current) subContainerRef.current.style.display = "none";
    }
  }, [subtitlesEnabled]);

  /* -------------------------------- probing ------------------------------- */
  const testServers = useCallback(async () => {
    const list = streamsRef.current;
    if (!list.length || probingRef.current) return;
    probingRef.current = true;
    setProbing(true);
    setProbes({});
    try {
      // One probe per server, using its best stream — not one per variant.
      const targets = new Map<string, StreamItem>();
      list.forEach((stream) => {
        const key = stream.group || stream.id;
        if (!targets.has(key)) targets.set(key, stream);
      });
      const entries = Array.from(targets.entries());
      for (let i = 0; i < entries.length; i += 3) {
        const batch = entries.slice(i, i + 3);
        const results = await Promise.all(
          batch.map(async ([key, stream]) => {
            setProbes((prev) => ({ ...prev, [key]: "checking" }));
            const result = await probeStream(stream.url);
            return [key, result] as const;
          })
        );
        setProbes((prev) => {
          const next = { ...prev };
          results.forEach(([key, result]) => {
            next[key] = result;
          });
          return next;
        });
      }
    } finally {
      probingRef.current = false;
      setProbing(false);
    }
  }, []);

  const retryCurrent = useCallback(() => {
    if (!streamsRef.current.length) {
      void loadStreams();
      return;
    }
    failedRef.current = new Set();
    setFailedIds([]);
    setStreamError(null);
    setLoadError(null);
    setIsBuffering(true);
    setSwitching(true);
    setReloadToken((token) => token + 1);
  }, [loadStreams]);

  /* ------------------------------ server groups --------------------------- */
  // A server exposes several streams (quality / audio variants); the menu shows
  // one row per server, so all variants collapse into a single group.
  type ServerGroup = { id: string; members: { item: StreamItem; index: number }[] };

  const serverGroups = useMemo<ServerGroup[]>(() => {
    const map = new Map<string, ServerGroup>();
    streams.forEach((item, index) => {
      const key = item.group || item.id;
      const existing = map.get(key);
      if (existing) existing.members.push({ item, index });
      else map.set(key, { id: key, members: [{ item, index }] });
    });
    return Array.from(map.values());
  }, [streams]);

  const favoriteServers = useMemo(
    () => serverGroups.filter((group) => favorites.includes(group.id)),
    [serverGroups, favorites]
  );
  const otherServers = useMemo(
    () => serverGroups.filter((group) => !favorites.includes(group.id)),
    [serverGroups, favorites]
  );

  /** The variant of a server that matches the audio language already selected. */
  const pickGroupMember = useCallback((group: ServerGroup, lang?: string) => {
    if (lang) {
      const match = group.members.find((member) => member.item.lang === lang);
      if (match) return match;
    }
    return group.members[0];
  }, []);

  const currentServerGroup = useMemo(() => {
    if (!currentStream) return null;
    const key = currentStream.group || currentStream.id;
    return serverGroups.find((group) => group.id === key) || null;
  }, [currentStream, serverGroups]);

  // hls.js tracks win once available; the m3u8 renditions supply names and
  // language codes both before the manifest attaches and afterwards.
  const audioOptions = useMemo(() => {
    if (audioTracks.length === 0) return playlistAudio;
    return audioTracks.map((track, index) => {
      const fromPlaylist = playlistAudio[index];
      return {
        id: track.id,
        name: track.name || fromPlaylist?.name || `Track ${index + 1}`,
        lang: track.lang || fromPlaylist?.lang || "",
        isDefault: fromPlaylist?.isDefault ?? index === 0,
      };
    });
  }, [audioTracks, playlistAudio]);

  const isAudioActive = (track: { id: number; isDefault: boolean }) =>
    activeAudioTrack >= 0 ? activeAudioTrack === track.id : track.isDefault;

  const currentLangLabel =
    audioOptions.find((track) =>
      activeAudioTrack >= 0 ? track.id === activeAudioTrack : track.isDefault
    )?.name ||
    currentStream?.langLabel;

  const blockingError = loadError || streamError;
  const spinnerVisible = (loadingStreams || isBuffering) && !switching && !blockingError;

  /* -------------------------------- render -------------------------------- */
  return (
    <div
      ref={containerRef}
      onMouseMove={handleActivity}
      onTouchStart={handleActivity}
      onMouseLeave={() => {
        if (isPlaying && !menu) setShowControls(false);
      }}
      className="group/player relative flex h-full w-full select-none items-center justify-center overflow-hidden bg-black font-sans text-white"
      style={{ "--accent": accentColor } as React.CSSProperties}
    >
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        {...({ referrerPolicy: "no-referrer" } as React.HTMLAttributes<HTMLVideoElement>)}
        playsInline
        preload="metadata"
        poster={poster}
        className="h-full w-full object-contain"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onTimeUpdate={handleTimeUpdate}
        onProgress={handleVideoProgress}
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={handleDurationChange}
        onCanPlay={() => {
          setIsBuffering(false);
          setSwitching(false);
        }}
        onWaiting={() => {
          setIsBuffering(true);
          armWatchdog();
        }}
        onStalled={armWatchdog}
        onPlaying={handlePlaying}
        onPlay={() => postPlayerEvent("play")}
        onSeeked={() => postPlayerEvent("seeked")}
        onPause={() => {
          setIsPlaying(false);
          const video = videoRef.current;
          if (video) {
            const total = durationRef.current || video.duration || 0;
            setPausedAt(video.currentTime);
            writeResume(resumeKey, video.currentTime, total);
          }
          postPlayerEvent("pause");
        }}
        onEnded={() => {
          setIsPlaying(false);
          postPlayerEvent("ended");
          clearResume(resumeKey);
          upNextRef.current = null;
          setUpNext(null);
          if (hasNextEpisode) goNext();
        }}
        onError={handleVideoError}
      />

      {/* Double-tap the sides to skip 10s; hold anywhere to play at 2× */}
      <div className="absolute inset-x-0 bottom-24 top-0 z-10 flex">
        <div
          role="presentation"
          className="h-full w-[30%]"
          onPointerDown={beginHold}
          onPointerUp={() => {
            endHold();
            tapSide("back");
          }}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
        />
        <div
          role="presentation"
          className="h-full flex-1"
          onClick={() => {
            if (suppressClickRef.current) return;
            togglePlay();
          }}
          onPointerDown={beginHold}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
        />
        <div
          role="presentation"
          className="h-full w-[30%]"
          onPointerDown={beginHold}
          onPointerUp={() => {
            endHold();
            tapSide("forward");
          }}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
        />
      </div>

      {tapHint && (
        <div
          className={`pointer-events-none absolute top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/70 px-4 py-2 text-xs font-semibold text-white shadow-lg ${tapHint === "back" ? "left-[10%]" : "right-[10%]"
            }`}
        >
          {tapHint === "back" ? "− 10s" : "+ 10s"}
        </div>
      )}

      {/* Pause screen: title, time left and the clock time it ends */}
      {!isPlaying && !isBuffering && !blockingError && pausedAt > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-[calc(50%+3.75rem)] z-20 px-6 text-center">
          <p className="truncate text-sm font-semibold text-white drop-shadow">
            {title}
            {type === "tv" ? ` · S${curSeason} E${curEpisode}` : ""}
          </p>
          <p className="mt-1 text-[11px] text-white/60">
            {formatTime(Math.max(0, duration - pausedAt))} left · Ends{" "}
            {new Date(
              Date.now() + Math.max(0, duration - pausedAt) * 1000
            ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      )}

      {/* Resume notice */}
      {resumeToast !== null && !blockingError && (
        <div className="absolute bottom-[8.25rem] left-3 z-40 flex items-center gap-2 rounded-full border border-white/15 bg-black/85 px-3 py-1.5 text-[11px] text-white shadow-2xl backdrop-blur sm:left-5">
          <span>Resumed at {formatTime(resumeToast)}</span>
          <button
            type="button"
            onClick={() => {
              seek(0);
              clearResume(resumeKey);
              setResumeToast(null);
            }}
            className="rounded bg-white/10 px-2 py-0.5 font-semibold text-white transition hover:bg-white/20"
          >
            Start over
          </button>
          <button
            type="button"
            onClick={() => setResumeToast(null)}
            aria-label="Dismiss resume notice"
            className="text-white/50 transition hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Up next countdown */}
      {upNext !== null && !blockingError && (
        <div className="absolute bottom-[8.25rem] right-3 z-40 w-60 rounded-xl border border-white/15 bg-[#15141a]/95 p-3 shadow-2xl backdrop-blur sm:right-8">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
              Up next
            </p>
            <span className="font-mono text-[10px] font-bold" style={{ color: accentColor }}>
              {upNext}s
            </span>
          </div>
          <p className="mt-1 text-[12px] font-semibold text-white">Next episode</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={goNext}
              className="flex-1 rounded-md px-2 py-1 text-[11px] font-semibold text-white transition hover:brightness-110"
              style={{ backgroundColor: accentColor }}
            >
              Play now
            </button>
            <button
              type="button"
              onClick={() => {
                upNextDismissedRef.current = true;
                upNextRef.current = null;
                setUpNext(null);
              }}
              className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Subtitle line */}
      <div
        ref={subContainerRef}
        className="pointer-events-none absolute inset-x-0 z-30 flex flex-col items-center justify-end px-4 text-center"
        style={{
          display: "none",
          bottom: `calc(${Math.max(4, 100 - subPrefs.position)}% + ${showControls ? "clamp(3rem, 11%, 7.5rem)" : "clamp(0.5rem, 2%, 1.5rem)"
            })`,
          transition: "bottom 180ms ease",
        }}
      >
        <div
          ref={subTextRef}
          className="max-w-[85%] whitespace-pre-line rounded px-3 py-1 font-medium leading-relaxed"
          style={{
            fontFamily: subPrefs.family || "inherit",
            fontSize: `${subPrefs.size || 20}px`,
            color: cueColor(subPrefs.color, subPrefs.textOpacity),
            backgroundColor: cueBackground(subPrefs.bgColor, subPrefs.bgOpacity),
            textShadow:
              subPrefs.edge && subPrefs.edge !== "none" ? EDGE_CSS[subPrefs.edge] : undefined,
          }}
        />
      </div>

      {/* Server switch curtain */}
      {switching && !blockingError && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm">
          <Loader2 className="h-10 w-10 animate-spin" style={{ color: accentColor }} />
          <div className="text-center">
            <p className="text-sm font-semibold text-white">
              Connecting to {currentStream?.name ?? "server"}
            </p>
            <p className="mt-0.5 text-[11px] text-white/50">Keeping your place</p>
          </div>
        </div>
      )}

      {/* Buffering */}
      {spinnerVisible && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/20 backdrop-blur-[2px]">
          <Loader2 className="h-9 w-9 animate-spin" style={{ color: accentColor }} />
          <p className="text-[11px] font-medium text-white/60">
            {loadingStreams ? "Finding a server…" : "Buffering…"}
          </p>
        </div>
      )}

      {/* Playback error */}
      {blockingError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-black/85 px-6 text-center backdrop-blur-md">
          <AlertCircle className="h-10 w-10 text-rose-400" />
          <h2 className="text-base font-semibold text-white">Playback problem</h2>
          <p className="max-w-md text-xs leading-relaxed text-white/60">{blockingError}</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={loadError ? () => void loadStreams() : retryCurrent}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110"
              style={{ backgroundColor: accentColor }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </button>
            {streams.length > 0 && (
              <button
                type="button"
                onClick={() => setMenu("servers")}
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10"
              >
                <Server className="h-3.5 w-3.5" />
                Choose a server
              </button>
            )}
          </div>
        </div>
      )}

      {/* Center play */}
      {!isPlaying && !isBuffering && !blockingError && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play video"
          className="absolute z-20 flex h-16 w-16 items-center justify-center rounded-full text-white shadow-2xl transition hover:scale-105 sm:h-20 sm:w-20"
          style={{ backgroundColor: accentColor }}
        >
          <Play className="ml-1 h-7 w-7 fill-current sm:h-9 sm:w-9" />
        </button>
      )}

      {/* Top bar */}
      <div
        className={`absolute inset-x-0 top-0 z-40 bg-gradient-to-b from-black/80 via-black/35 to-transparent p-4 transition-opacity duration-300 sm:p-5 ${showControls ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
      >
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-white drop-shadow sm:text-base">
            {title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium">
            {type === "tv" && curSeason && curEpisode && (
              <span
                className="rounded px-1.5 py-0.5"
                style={{ backgroundColor: `${accentColor}33`, color: accentColor }}
              >
                S{curSeason} · E{curEpisode}
              </span>
            )}
            {currentQualityLabel && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">
                {currentQualityLabel}
              </span>
            )}
            {currentLangLabel && (
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-white/70">
                {currentLangLabel}
              </span>
            )}
            {currentStream && (
              <span className="text-white/40">
                {currentStream.name}
                {failedSet.has(currentStream.id) ? " · struggling" : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Skip intro / recap / credits */}
      {activeSkip && !blockingError && (
        <button
          type="button"
          onClick={executeSkip}
          aria-label={
            activeSkip.type === "credits" && hasNextEpisode
              ? "Play next episode"
              : activeSkip.label
          }
          className="absolute bottom-[8rem] right-4 z-40 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-[11px] font-semibold text-white shadow-[0_10px_28px_-14px_rgba(0,0,0,0.9)] transition hover:brightness-110 sm:bottom-[8.5rem] sm:right-8 sm:text-xs"
          style={{ backgroundColor: accentColor }}
        >
          <FastForward className="h-3 w-3 shrink-0 fill-current" />
          <span>
            {activeSkip.type === "credits" && hasNextEpisode
              ? "Next episode"
              : activeSkip.label}
          </span>
        </button>
      )}

      {/* Autoplay was only allowed with sound off */}
      {autoplayBlocked && !blockingError && (
        <button
          type="button"
          onClick={() => {
            const video = videoRef.current;
            if (video) {
              video.muted = false;
              setIsMuted(false);
            }
            setAutoplayBlocked(false);
          }}
          className="absolute bottom-[11.5rem] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-black/80 px-4 py-2 text-[11px] font-semibold text-white shadow-2xl backdrop-blur transition hover:bg-black sm:bottom-[12rem] sm:text-[12px]"
        >
          <Volume2 className="h-4 w-4" />
          Autoplay started muted · Tap to unmute
        </button>
      )}

      {/* ---------------- Bottom controls ---------------- */}
      <div
        className={`absolute inset-x-0 bottom-0 z-40 transition-opacity duration-300 ${showControls ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
      >
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black via-black/80 to-transparent" />

        <div className="relative px-3 pb-3 pt-10 sm:px-5 sm:pb-4">
          {/* Seek bar */}
          <div
            className="group/seek relative mb-1 flex h-6 w-full cursor-pointer items-center"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
              const dur = durationRef.current || videoRef.current?.duration || 1;
              seek(pct * dur);
            }}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pos = event.clientX - rect.left;
              const dur = durationRef.current || videoRef.current?.duration || 1;
              const tooltip = hoverTooltipRef.current;
              if (tooltip) {
                const time = Math.max(0, Math.min(1, pos / rect.width)) * dur;
                const seg = timelineSegments.find((item) => time >= item.start && time < item.end);
                tooltip.style.display = "block";
                tooltip.style.left = `${pos}px`;
                tooltip.textContent = seg
                  ? `${seg.label} · ${formatTime(time)}`
                  : formatTime(time);
              }
            }}
            onMouseLeave={() => {
              if (hoverTooltipRef.current) hoverTooltipRef.current.style.display = "none";
            }}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") seekBy(-10);
              if (event.key === "ArrowRight") seekBy(10);
            }}
          >
            <div className="relative h-[5px] w-full rounded-full bg-white/20 transition-all duration-200 group-hover/seek:h-[7px]">
              <div
                ref={bufferedBarRef}
                className="absolute left-0 top-0 h-full rounded-full bg-white/25"
                style={{ width: "0%" }}
              />
              <div
                ref={progressBarRef}
                className="absolute left-0 top-0 h-full rounded-full"
                style={{ width: "0%", backgroundColor: accentColor }}
              />
              {/* Intro / recap / credits cues are drawn inside the timeline
                  itself, using the same width as the progress bar, so a cue at
                  time T always sits exactly where the playhead would be at T. */}
              {timelineSegments.map((seg) => {
                const total = duration || 1;
                const left = Math.max(0, Math.min(100, (seg.start / total) * 100));
                // Exact time span, clamped so a cue can never spill past the
                // end of the track (a px min-width used to do that).
                const width = Math.max(
                  0,
                  Math.min(100 - left, ((seg.end - seg.start) / total) * 100)
                );
                return (
                  <span
                    key={seg.key}
                    aria-hidden
                    title={seg.label}
                    className="pointer-events-none absolute inset-y-0 left-0 rounded-full"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      backgroundColor: seg.color,
                      opacity: 0.95,
                    }}
                  />
                );
              })}
              <div
                ref={progressThumbRef}
                className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_6px_rgba(0,0,0,0.6)] transition-transform group-hover/seek:scale-110"
                style={{ left: "0%", marginLeft: "-7px" }}
              />
            </div>
            <div
              ref={hoverTooltipRef}
              style={{ display: "none", transform: "translateX(-50%)" }}
              className="pointer-events-none absolute -top-7 rounded-md border border-white/10 bg-zinc-900 px-2 py-0.5 font-mono text-[10.5px] text-white shadow-lg"
            />
          </div>

          {/* Control row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-0.5 sm:gap-1">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause" : "Play"}
                className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-lg transition hover:bg-white/85"
              >
                {isPlaying ? (
                  <Pause className="h-[18px] w-[18px] fill-current" />
                ) : (
                  <Play className="ml-0.5 h-[18px] w-[18px] fill-current" />
                )}
              </button>

              <button
                type="button"
                onClick={() => seekBy(-10)}
                aria-label="Back 10 seconds"
                title="Back 10s"
                className="hidden h-9 w-9 items-center justify-center rounded-lg text-white/75 transition hover:bg-white/10 hover:text-white sm:flex"
              >
                <RotateCcw className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={() => seekBy(10)}
                aria-label="Forward 10 seconds"
                title="Forward 10s"
                className="hidden h-9 w-9 items-center justify-center rounded-lg text-white/75 transition hover:bg-white/10 hover:text-white sm:flex"
              >
                <RotateCw className="h-[18px] w-[18px]" />
              </button>

              <div className="group/vol flex items-center">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-white/75 transition hover:bg-white/10 hover:text-white"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-[18px] w-[18px]" />
                  ) : (
                    <Volume2 className="h-[18px] w-[18px]" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => changeVolume(parseFloat(event.target.value))}
                  aria-label="Volume"
                  className="vp-range w-16 cursor-pointer sm:w-20"
                  style={{ "--accent": accentColor } as React.CSSProperties}
                />
              </div>

              <div className="ml-1.5 hidden font-mono text-[11px] tabular-nums text-white/45 sm:block">
                <span ref={timeCurrentTextRef} className="text-white/90">
                  0:00
                </span>
                <span className="mx-1 text-white/25">/</span>
                <span ref={timeDurationTextRef}>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              {showEpisodes && type === "tv" && (
                <button
                  type="button"
                  onClick={openEpisodes}
                  title="Episodes (E)"
                  className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-white/75 transition hover:bg-white/10 hover:text-white"
                >
                  <ListVideo className="h-[17px] w-[17px]" />
                  <span className="hidden lg:inline">Episodes</span>
                </button>
              )}

              {hasNextEpisode && (
                <button
                  type="button"
                  onClick={goNext}
                  title="Next episode"
                  className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium text-white/75 transition hover:bg-white/10 hover:text-white"
                >
                  <SkipForward className="h-[17px] w-[17px]" />
                  <span className="hidden lg:inline">Next</span>
                </button>
              )}

              <span className="mx-1 hidden h-4 w-px bg-white/15 sm:block" />

              {/* Audio */}
              <div className="relative" data-player-menu>
                <button
                  type="button"
                  onClick={() => setMenu(menu === "audio" ? null : "audio")}
                  aria-label="Audio and language"
                  title="Audio & language"
                  className={`flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition ${menu === "audio"
                      ? "bg-white/[0.15] text-white"
                      : "text-white/75 hover:bg-white/10 hover:text-white"
                    }`}
                >
                  <Mic className="h-[17px] w-[17px]" />
                  <span className="hidden md:inline">Audio</span>
                </button>

                {menu === "audio" && (
                  <div
                    role="menu"
                    className="wv-menu absolute bottom-full right-0 z-50 mb-3 w-[19rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#15141a]/[0.98] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:mb-0 max-sm:w-auto"
                  >
                    <MenuBar
                      icon={<Mic className="h-4 w-4" />}
                      title="Audio & language"
                      subtitle={currentLangLabel ? `Playing: ${currentLangLabel}` : "Automatic"}
                      accentColor={accentColor}
                      onClose={() => setMenu(null)}
                    />
                    <div className="max-h-[52vh] overflow-y-auto p-2">
                      {/* 1. Embedded HLS audio tracks on active stream (e.g. Vidzy Français/English/Occitan, Vixsrc Italian/English) */}
                      {audioOptions.length > 0 && (
                        <>
                          <MenuLabel>Tracks on {currentStream?.name || "this server"}</MenuLabel>
                          {audioOptions.map((track) => {
                            const active = isAudioActive(track);
                            return (
                              <button
                                key={track.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={active}
                                onClick={() => {
                                  selectAudioTrack(track.id);
                                  setMenu(null);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2.5 text-left text-[12.5px] transition ${active
                                    ? "bg-white/[0.09] font-semibold text-white"
                                    : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                                  }`}
                              >
                                <span className="flex items-center gap-2 truncate">
                                  {active && (
                                    <span
                                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: accentColor }}
                                    />
                                  )}
                                  {track.name}
                                </span>
                                {active && (
                                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
                                )}
                              </button>
                            );
                          })}
                        </>
                      )}

                      {/* 2. Stream language variants / other versions (e.g. Vidy languages) */}
                      {currentServerGroup && currentServerGroup.members.length > 1 && (
                        <>
                          <MenuLabel className={audioOptions.length > 0 ? "mt-3 border-t border-white/10 pt-2" : ""}>
                            {audioOptions.length > 0 ? "Stream variants" : `Languages on ${currentStream?.name || "this server"}`}
                          </MenuLabel>
                          {currentServerGroup.members.map((member) => {
                            const active = member.index === selectedIndex;
                            return (
                              <button
                                key={member.item.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={active}
                                onClick={() => {
                                  switchTo(member.index);
                                  setMenu(null);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2.5 text-left text-[12.5px] transition ${active
                                    ? "bg-white/[0.09] font-semibold text-white"
                                    : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                                  }`}
                              >
                                <span className="flex items-center gap-2 truncate">
                                  {active && (
                                    <span
                                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                                      style={{ backgroundColor: accentColor }}
                                    />
                                  )}
                                  <span>{member.item.langLabel || member.item.label}</span>
                                  {member.item.qualityLabel && (
                                    <span className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[9px] font-semibold text-white/60">
                                      {member.item.qualityLabel}
                                    </span>
                                  )}
                                </span>
                                {active && (
                                  <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
                                )}
                              </button>
                            );
                          })}
                        </>
                      )}

                      {/* 3. Fallback when only 1 track and 1 member */}
                      {!audioOptions.length &&
                        (!currentServerGroup || currentServerGroup.members.length <= 1) && (
                        <p className="px-2.5 py-2 text-[12px] leading-relaxed text-white/50">
                          This stream carries one audio track
                          {currentLangLabel ? ` (${currentLangLabel})` : ""}.
                        </p>
                      )}

                    </div>
                  </div>
                )}
              </div>

              {/* Subtitles */}
              <div className="relative" data-player-menu>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(menu === "subtitles" ? null : "subtitles");
                    setSubTab("tracks");
                  }}
                  aria-label="Subtitles"
                  title="Subtitles"
                  className={`relative flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition ${menu === "subtitles"
                      ? "bg-white/[0.15] text-white"
                      : subtitlesEnabled
                        ? "text-white hover:bg-white/10"
                        : "text-white/75 hover:bg-white/10 hover:text-white"
                    }`}
                >
                  <Captions className="h-[17px] w-[17px]" />
                  <span className="hidden md:inline">Subtitles</span>
                  {subtitlesEnabled && (
                    <span
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full md:static md:ml-0.5"
                      style={{ backgroundColor: accentColor }}
                    />
                  )}
                </button>

                {menu === "subtitles" && (
                  <div
                    role="menu"
                    className="wv-menu absolute bottom-full right-0 z-50 mb-3 flex max-h-[72vh] w-[23.5rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15141a]/[0.98] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:mb-0 max-sm:w-auto"
                  >
                    <MenuBar
                      icon={<Captions className="h-4 w-4" />}
                      title="Subtitles"
                      subtitle={
                        subtitlesEnabled
                          ? allSubTracks.find((track) => track.id === activeSubId)?.label || "On"
                          : "Off"
                      }
                      accentColor={accentColor}
                      onClose={() => setMenu(null)}
                    />

                    <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
                      <div className="flex gap-1">
                        {(["tracks", "style"] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => setSubTab(tab)}
                            className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition ${subTab === tab
                                ? "bg-white/[0.12] text-white"
                                : "text-white/50 hover:bg-white/[0.06] hover:text-white"
                              }`}
                          >
                            {tab === "tracks" ? "Tracks" : "Style"}
                          </button>
                        ))}
                      </div>
                      {(subSearching || loadingSubs) && (
                        <span className="flex items-center gap-1.5 font-mono text-[10px] text-white/40">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {loadingSubs ? "loading file" : "searching"}
                        </span>
                      )}
                    </div>

                    {subTab === "tracks" ? (
                      <div className="flex flex-1 flex-col overflow-hidden">
                        <div className="grid gap-2 border-b border-white/10 p-2.5 sm:grid-cols-2">
                          <label className="block">
                            <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
                              Language
                            </span>
                            <select
                              value={subLang}
                              onChange={(event) => {
                                const next = event.target.value;
                                if (!next) return;
                                setSubLang(next);
                                writeSubLang(next);
                                void searchSubs(next, true);
                              }}
                              style={{ colorScheme: "dark" }}
                              className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.07] px-2 text-[11.5px] text-white outline-none focus:border-[var(--accent)] [&>option]:bg-[#1b1b1f]"
                            >
                              <option value="">Choose…</option>
                              {LANGS.map(([code, english, native]) => (
                                <option key={code} value={code}>
                                  {native && native !== english ? `${english} — ${native}` : english}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">
                              Filter
                            </span>
                            <input
                              type="text"
                              value={subQuery}
                              onChange={(event) => setSubQuery(event.target.value)}
                              placeholder="Find a track…"
                              className="h-8 w-full rounded-lg border border-white/10 bg-white/[0.05] px-2.5 text-[11.5px] text-white placeholder-white/30 outline-none focus:border-[var(--accent)]"
                            />
                          </label>
                        </div>

                        <div className="max-h-[40vh] flex-1 overflow-y-auto p-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              void selectSubtitle(null);
                              setMenu(null);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2.5 text-left text-[12.5px] transition ${!subtitlesEnabled
                                ? "bg-white/[0.09] font-semibold text-white"
                                : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                              }`}
                          >
                            <span>Off</span>
                            {!subtitlesEnabled && (
                              <Check className="h-3.5 w-3.5" style={{ color: accentColor }} />
                            )}
                          </button>

                          {filteredSubTracks.map((track) => {
                            const active = activeSubId === track.id && subtitlesEnabled;
                            return (
                              <button
                                key={track.id}
                                type="button"
                                role="menuitemradio"
                                aria-checked={active}
                                onClick={() => {
                                  void selectSubtitle(track);
                                  setMenu(null);
                                }}
                                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition ${active
                                    ? "bg-white/[0.09] font-semibold text-white"
                                    : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                                  }`}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  {active && (
                                    <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
                                  )}
                                  <span className="truncate">{track.label}</span>
                                </span>
                                <span className="flex shrink-0 items-center gap-1">
                                  {track.isStreamSub && (
                                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-white/60">
                                      Stream
                                    </span>
                                  )}
                                  {typeof track.hlsIndex === "number" && (
                                    <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-sky-300">
                                      Embedded
                                    </span>
                                  )}
                                  {track.lang === "local" && (
                                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-white/60">
                                      File
                                    </span>
                                  )}
                                </span>
                              </button>
                            );
                          })}

                          {!filteredSubTracks.length && !subSearching && !loadingSubs && (
                            <p className="px-2.5 py-5 text-center text-[11.5px] leading-relaxed text-white/45">
                              {subLang
                                ? `No subtitles in ${langLabel(subLang).english} yet. Try another language or upload a file below.`
                                : "No tracks yet. Choose a language, or upload a file below."}
                            </p>
                          )}

                          {subNotice && (
                            <p className="mx-1 mt-1 rounded-lg bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-200">
                              {subNotice}
                            </p>
                          )}

                          <div className="mt-1.5 border-t border-white/10 pt-1">
                            <button
                              type="button"
                              onClick={() => subFileInputRef.current?.click()}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[11.5px] text-white/60 transition hover:bg-white/[0.06] hover:text-white"
                            >
                              <Upload className="h-3.5 w-3.5" />
                              Upload .srt or .vtt
                            </button>
                            <input
                              ref={subFileInputRef}
                              type="file"
                              accept=".srt,.vtt,text/vtt,application/x-subrip"
                              className="hidden"
                              onChange={(event) => {
                                void handleLocalSubFile(event.target.files?.[0]);
                                event.target.value = "";
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="max-h-[54vh] space-y-4 overflow-y-auto p-3">
                        <div>
                          <MenuLabel>Timing</MenuLabel>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => applySubOffset(subOffsetRef.current - SUB_OFFSET_STEP)}
                              className="h-8 w-8 rounded-lg bg-white/10 text-base font-bold text-white transition hover:bg-white/20"
                              aria-label="Show subtitles earlier"
                            >
                              −
                            </button>
                            <span className="w-16 text-center">
                              <span className="block font-mono text-[12px] font-bold tabular-nums">
                                {fmtOffset(subOffset)}
                              </span>
                              <span className="block font-mono text-[8.5px] uppercase tracking-[0.1em] text-white/35">
                                {subOffset === 0
                                  ? "in sync"
                                  : subOffset > 0
                                    ? "delayed"
                                    : "advanced"}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => applySubOffset(subOffsetRef.current + SUB_OFFSET_STEP)}
                              className="h-8 w-8 rounded-lg bg-white/10 text-base font-bold text-white transition hover:bg-white/20"
                              aria-label="Show subtitles later"
                            >
                              +
                            </button>
                            <button
                              type="button"
                              onClick={autoSyncSubtitles}
                              title="Detect and fix an offset track"
                              className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-white/70 transition hover:bg-white/15 hover:text-white"
                            >
                              Auto
                            </button>
                            <button
                              type="button"
                              onClick={() => applySubOffset(0)}
                              disabled={!subOffset}
                              className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-white/60 transition hover:bg-white/15 hover:text-white disabled:opacity-30"
                            >
                              Reset
                            </button>
                          </div>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
                            − shows text sooner, + shows it later.
                          </p>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-black/50 p-3 text-center">
                          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">
                            Preview
                          </p>
                          <div
                            className="inline-block rounded px-2.5 py-1"
                            style={{
                              fontFamily: subPrefs.family || "inherit",
                              fontSize: `${subPrefs.size || 20}px`,
                              color: cueColor(subPrefs.color, subPrefs.textOpacity),
                              backgroundColor: cueBackground(subPrefs.bgColor, subPrefs.bgOpacity),
                              textShadow:
                                subPrefs.edge && subPrefs.edge !== "none"
                                  ? EDGE_CSS[subPrefs.edge]
                                  : undefined,
                            }}
                          >
                            Subtitles look like this.
                          </div>
                        </div>

                        <SubtitleStyleControls prefs={subPrefs} onChange={updateSubPrefs} />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Servers */}
              <div className="relative" data-player-menu>
                <button
                  type="button"
                  onClick={() => setMenu(menu === "servers" ? null : "servers")}
                  aria-label="Servers"
                  title="Servers"
                  className={`flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition ${menu === "servers"
                      ? "bg-white/[0.15] text-white"
                      : "text-white/75 hover:bg-white/10 hover:text-white"
                    }`}
                >
                  <Server className="h-[17px] w-[17px]" />
                  <span className="hidden md:inline">Servers</span>
                  {serverGroups.length > 0 && (
                    <span className="hidden rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-white/60 lg:inline">
                      {serverGroups.length}
                    </span>
                  )}
                </button>

                {menu === "servers" && (
                  <div
                    role="menu"
                    className="wv-menu absolute bottom-full right-0 z-50 mb-3 flex max-h-[70vh] w-[22.5rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15141a]/[0.98] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:mb-0 max-sm:w-auto"
                  >
                    <MenuBar
                      icon={<Server className="h-4 w-4" />}
                      title="Servers"
                      subtitle={`${serverGroups.length} available · ${favorites.length} favourite${favorites.length === 1 ? "" : "s"
                        }`}
                      accentColor={accentColor}
                      onClose={() => setMenu(null)}
                      action={
                        <button
                          type="button"
                          onClick={() => void testServers()}
                          disabled={probing}
                          className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[10px] font-semibold text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
                        >
                          {probing ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Wifi className="h-3 w-3" />
                          )}
                          {probing ? "Testing" : "Test all"}
                        </button>
                      }
                    />

                    <div className="flex-1 overflow-y-auto p-2">
                      {loadingStreams ? (
                        <p className="py-6 text-center text-[12px] text-white/50">
                          Looking for servers…
                        </p>
                      ) : streams.length === 0 ? (
                        <p className="py-6 text-center text-[12px] text-white/50">
                          No servers found.
                        </p>
                      ) : (
                        <>
                          {favoriteServers.length > 0 && (
                            <MenuLabel>Favourites</MenuLabel>
                          )}
                          {favoriteServers.map((group) => {
                            const member = pickGroupMember(group, currentStream?.lang);
                            return (
                              <ServerRow
                                key={group.id}
                                item={member.item}
                                index={member.index}
                                selected={group.members.some(
                                  (entry) => entry.index === selectedIndex
                                )}
                                favorite
                                failed={group.members.every((entry) =>
                                  failedSet.has(entry.item.id)
                                )}
                                probe={probes[group.id]}
                                accentColor={accentColor}
                                onSelect={() => {
                                  switchTo(member.index);
                                  setMenu(null);
                                }}
                                onToggleFavorite={() => toggleFavorite(group.id)}
                              />
                            );
                          })}
                          <MenuLabel>
                            {favoriteServers.length > 0 ? "All servers" : "Available servers"}
                          </MenuLabel>
                          {otherServers.map((group) => {
                            const member = pickGroupMember(group, currentStream?.lang);
                            return (
                              <ServerRow
                                key={group.id}
                                item={member.item}
                                index={member.index}
                                selected={group.members.some(
                                  (entry) => entry.index === selectedIndex
                                )}
                                favorite={false}
                                failed={group.members.every((entry) =>
                                  failedSet.has(entry.item.id)
                                )}
                                probe={probes[group.id]}
                                accentColor={accentColor}
                                onSelect={() => {
                                  switchTo(member.index);
                                  setMenu(null);
                                }}
                                onToggleFavorite={() => toggleFavorite(group.id)}
                              />
                            );
                          })}
                        </>
                      )}
                    </div>

                    <p className="border-t border-white/10 px-3.5 py-2 text-[10.5px] leading-relaxed text-white/35">
                      Favourites are tried first and remembered on this device.
                    </p>
                  </div>
                )}
              </div>

              {/* Settings */}
              <div className="relative" data-player-menu>
                <button
                  type="button"
                  onClick={() => setMenu(menu === "settings" ? null : "settings")}
                  aria-label="Playback settings"
                  title="Settings"
                  className={`flex h-9 items-center gap-1.5 rounded-lg px-2 text-[11.5px] font-medium transition ${menu === "settings"
                      ? "bg-white/[0.15] text-white"
                      : "text-white/75 hover:bg-white/10 hover:text-white"
                    }`}
                >
                  <Settings className="h-[17px] w-[17px]" />
                  <span className="hidden md:inline">Settings</span>
                </button>

                {menu === "settings" && (
                  <div
                    role="menu"
                    className="wv-menu absolute bottom-full right-0 z-50 mb-3 w-[20rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#15141a]/[0.98] shadow-[0_24px_70px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:mb-0 max-sm:w-auto"
                  >
                    <MenuBar
                      icon={<Settings className="h-4 w-4" />}
                      title="Playback"
                      subtitle={
                        currentQualityLabel
                          ? `Quality: ${currentQualityLabel}`
                          : "Quality, speed and skipping"
                      }
                      accentColor={accentColor}
                      onClose={() => setMenu(null)}
                    />

                    <div className="max-h-[54vh] overflow-y-auto p-2">
                      <MenuLabel>Quality</MenuLabel>
                      {levels.length > 0 ? (
                        <>
                          <SettingsRow
                            label={`Auto${currentQualityLabel ? ` · ${currentQualityLabel}` : ""}`}
                            hint="Follows your connection"
                            active={qualityMode === "auto"}
                            accentColor={accentColor}
                            onClick={() => applyQuality("auto")}
                          />
                          {levels.map((level) => (
                            <SettingsRow
                              key={level.index}
                              label={level.label}
                              active={qualityMode === level.index}
                              accentColor={accentColor}
                              onClick={() => applyQuality(level.index)}
                            />
                          ))}
                        </>
                      ) : (
                        <p className="px-2.5 py-2 text-[11.5px] text-white/45">
                          This source has a single quality.
                        </p>
                      )}

                      <div className="my-2 border-t border-white/10" />
                      <MenuLabel>Speed</MenuLabel>
                      <div className="flex flex-wrap gap-1 px-1 pb-1">
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => applyRate(rate)}
                            className={`rounded-md px-2.5 py-1.5 font-mono text-[11px] font-semibold transition ${playbackRate === rate
                                ? "text-white"
                                : "bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white"
                              }`}
                            style={
                              playbackRate === rate
                                ? { backgroundColor: accentColor }
                                : undefined
                            }
                          >
                            {rate}×
                          </button>
                        ))}
                      </div>

                      <div className="my-2 border-t border-white/10" />
                      <div className="flex items-center justify-between gap-3 px-1 pb-1">
                        <div>
                          <p className="text-[12.5px] font-medium text-white">Auto-skip intros</p>
                          <p className="text-[10.5px] text-white/40">
                            Openings and recaps jump automatically
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={autoSkipIntro}
                          onClick={toggleAutoSkip}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition ${autoSkipIntro ? "" : "bg-white/20"
                            }`}
                          style={autoSkipIntro ? { backgroundColor: accentColor } : undefined}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${autoSkipIntro ? "translate-x-4" : "translate-x-0.5"
                              }`}
                          />
                        </button>
                      </div>

                      <p className="mt-2 border-t border-white/10 px-1 pt-2 font-mono text-[9.5px] leading-relaxed text-white/30">
                        SPACE play · J/L ±10s · M mute · F fullscreen · C subtitles
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-white/75 transition hover:bg-white/10 hover:text-white"
              >
                {isFullscreen ? <Minimize className="h-[18px] w-[18px]" /> : <Maximize className="h-[18px] w-[18px]" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Episode browser */}
      {episodesOpen && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
          onClick={() => setEpisodesOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Episodes"
            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#15141a]/[0.98] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">{title}</p>
                <p className="text-[10.5px] text-white/45">
                  {seasonList.length || 1} season{seasonList.length === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEpisodesOpen(false)}
                aria-label="Close episodes"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {seasonList.length > 1 && (
              <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-3 py-2">
                {seasonList.map((item) => (
                  <button
                    key={item.season}
                    type="button"
                    onClick={() => setEpisodeSeason(item.season)}
                    className={`shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition ${episodeSeason === item.season
                        ? "text-white"
                        : "bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white"
                      }`}
                    style={episodeSeason === item.season ? { backgroundColor: accentColor } : undefined}
                  >
                    {item.season === 0 ? "Specials" : `Season ${item.season}`}
                  </button>
                ))}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {episodeLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-white/50">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading episodes…
                </div>
              ) : episodeItems.length === 0 ? (
                <p className="py-10 text-center text-[12px] text-white/45">No episodes found.</p>
              ) : (
                episodeItems.map((item) => {
                  const href = episodeHref(episodeSeason, item.episode);
                  const saved = episodeProgress[`${episodeSeason}:${item.episode}`];
                  const pct =
                    saved && saved.duration > 0
                      ? Math.min(100, (saved.time / saved.duration) * 100)
                      : 0;
                  const current =
                    item.episode === curEpisode && episodeSeason === curSeason;
                  return (
                    <a
                      key={item.episode}
                      href={href || undefined}
                      onClick={() => setEpisodesOpen(false)}
                      aria-current={current ? "true" : undefined}
                      className={`flex items-start gap-3 rounded-xl p-2 transition ${current ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
                        }`}
                    >
                      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-white/5 sm:w-28">
                        {item.still ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.still}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                        {pct > 0 && (
                          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
                            <span
                              className="block h-full"
                              style={{ width: `${pct}%`, backgroundColor: accentColor }}
                            />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] font-semibold text-white">
                          {item.episode}. {item.name}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-white/45">
                          {item.overview || "No description yet."}
                        </p>
                      </div>
                      {current && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold"
                          style={{ backgroundColor: `${accentColor}33`, color: accentColor }}
                        >
                          Now
                        </span>
                      )}
                    </a>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Menu chrome                                                         */
/* ------------------------------------------------------------------ */

function MenuBar({
  icon,
  title,
  subtitle,
  accentColor,
  onClose,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  accentColor: string;
  onClose: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/10 px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accentColor}22`, color: accentColor }}
        >
          {icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-white">{title}</span>
          {subtitle && (
            <span className="mt-0.5 block truncate text-[10.5px] text-white/45">{subtitle}</span>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function MenuLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`px-2.5 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/35 ${className}`}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Menu rows                                                           */
/* ------------------------------------------------------------------ */

function ServerRow({
  item,
  selected,
  favorite,
  failed,
  probe,
  accentColor,
  onSelect,
  onToggleFavorite,
}: {
  item: StreamItem;
  index: number;
  selected: boolean;
  favorite: boolean;
  failed: boolean;
  probe?: ProbeResult | "checking";
  accentColor: string;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-lg border px-1 py-1 transition ${selected ? "border-white/10 bg-white/[0.10]" : "border-transparent hover:bg-white/[0.05]"
        }`}
      style={selected ? { borderColor: `${accentColor}55` } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left"
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor:
              probe === "fast"
                ? "#34d399"
                : probe === "slow"
                  ? "#fbbf24"
                  : probe === "offline"
                    ? "#fb7185"
                    : selected
                      ? accentColor
                      : "rgba(255,255,255,0.25)",
          }}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-white">
              {item.name}
            </span>
            {selected && (
              <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-white/45">
            {item.qualityLabel && (
              <span className="rounded bg-white/[0.08] px-1 py-px font-semibold text-white/70">
                {item.qualityLabel}
              </span>
            )}
            <span>{item.label || item.langLabel}</span>
            {failed && <span className="text-amber-400">didn't respond</span>}
            {probe === "offline" && (
              <span className="flex items-center gap-0.5 text-rose-400">
                <WifiOff className="h-2.5 w-2.5" /> unreachable
              </span>
            )}
            {probe === "slow" && <span className="text-amber-400">slow</span>}
            {probe === "fast" && <span className="text-emerald-400">online</span>}
            {probe === "checking" && <span>testing…</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        aria-pressed={favorite}
        aria-label={
          favorite
            ? `Remove ${item.name} from favourites`
            : `Add ${item.name} to favourites`
        }
        className="shrink-0 rounded-md p-1.5 text-white/35 transition hover:bg-white/10 hover:text-white"
      >
        <HeartIcon
          filled={favorite}
          className="h-4 w-4"
          style={favorite ? { color: accentColor } : undefined}
        />
      </button>
    </div>
  );
}

function SettingsRow({
  label,
  hint,
  active,
  accentColor,
  onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  accentColor: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition ${active ? "bg-white/12 font-semibold text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
        }`}
    >
      <span className="min-w-0">
        <span className="block truncate text-[12px]">{label}</span>
        {hint && <span className="block text-[10px] font-normal text-white/35">{hint}</span>}
      </span>
      {active && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: accentColor }} />}
    </button>
  );
}

function SubtitleStyleControls({
  prefs,
  onChange,
}: {
  prefs: SubStyleOptions;
  onChange: (next: SubStyleOptions) => void;
}) {
  const rowClass = "flex items-center justify-between gap-3 text-[12px] text-white/70";
  const selectClass =
    "h-8 rounded-lg border border-white/10 bg-white/10 px-2 text-[12px] text-white outline-none [&>option]:bg-[#1b1b1f]";
  const colorClass =
    "h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent";

  return (
    <div className="space-y-3 border-t border-white/10 pt-3">
      <div className={rowClass}>
        <span>Font</span>
        <select
          value={prefs.family || "inherit"}
          onChange={(event) => onChange({ ...prefs, family: event.target.value })}
          className={selectClass}
          style={{ colorScheme: "dark" }}
        >
          {SUB_FONTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className={rowClass}>
        <span>Text size</span>
        <select
          value={prefs.size}
          onChange={(event) => onChange({ ...prefs, size: Number(event.target.value) })}
          className={selectClass}
          style={{ colorScheme: "dark" }}
        >
          {[14, 16, 18, 20, 24, 28, 32].map((size) => (
            <option key={size} value={size}>
              {size}px
            </option>
          ))}
        </select>
      </div>

      <div className={rowClass}>
        <span>Text colour</span>
        <input
          type="color"
          value={prefs.color}
          onChange={(event) => onChange({ ...prefs, color: event.target.value })}
          className={colorClass}
          aria-label="Subtitle text colour"
        />
      </div>

      <div className={rowClass}>
        <span>Text opacity</span>
        <select
          value={prefs.textOpacity}
          onChange={(event) =>
            onChange({ ...prefs, textOpacity: Number(event.target.value) })
          }
          className={selectClass}
          style={{ colorScheme: "dark" }}
        >
          {[100, 75, 50, 25].map((value) => (
            <option key={value} value={value}>
              {value}%
            </option>
          ))}
        </select>
      </div>

      <div className={rowClass}>
        <span>Background</span>
        <input
          type="color"
          value={prefs.bgColor}
          onChange={(event) => onChange({ ...prefs, bgColor: event.target.value })}
          className={colorClass}
          aria-label="Subtitle background colour"
        />
      </div>

      <div className={rowClass}>
        <span>Background opacity</span>
        <select
          value={prefs.bgOpacity}
          onChange={(event) => onChange({ ...prefs, bgOpacity: Number(event.target.value) })}
          className={selectClass}
          style={{ colorScheme: "dark" }}
        >
          {[100, 75, 50, 25, 0].map((value) => (
            <option key={value} value={value}>
              {value === 0 ? "Transparent" : `${value}%`}
            </option>
          ))}
        </select>
      </div>

      <div className={rowClass}>
        <span>Edge</span>
        <select
          value={prefs.edge}
          onChange={(event) =>
            onChange({ ...prefs, edge: event.target.value as SubStyleOptions["edge"] })
          }
          className={selectClass}
          style={{ colorScheme: "dark" }}
        >
          {SUB_EDGES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="text-[12px] text-white/70">
        <div className="flex justify-between">
          <span>Height from bottom</span>
          <span className="text-white/40">
            {Math.min(90, Math.max(8, 100 - prefs.position))}%
          </span>
        </div>
        <input
          type="range"
          min={8}
          max={90}
          value={Math.min(90, Math.max(8, 100 - prefs.position))}
          onChange={(event) =>
            onChange({ ...prefs, position: 100 - Number(event.target.value) })
          }
          className="mt-1 w-full accent-[var(--accent)]"
          aria-label="Subtitle height from the bottom"
        />
      </div>

      <button
        type="button"
        onClick={() => onChange({ ...SUB_STYLE_DEFAULT })}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-white/60 transition hover:bg-white/10 hover:text-white"
      >
        Reset subtitle style
      </button>
      <p className="flex items-center gap-1 text-[10px] text-white/30">
        <WarnIcon className="h-3 w-3" /> Settings apply to every video on this device.
      </p>
    </div>
  );
}
