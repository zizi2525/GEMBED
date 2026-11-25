/**
 * Stream client.
 *
 * Talks to the backend replica cluster and turns its raw provider payload into
 * display-safe server entries:
 *  - upstream provider names, scraper ids and raw titles never reach the UI
 *  - labels are rebuilt from quality / language only ("Server 3 · 1080p · Tamil")
 *  - ids are stable across requests so favourite servers survive a reload
 *  - every replica call has a hard timeout, and duplicates are removed
 */

import { isTurnstileConfigured, waitForTurnstileProof } from "./turnstile";

export interface StreamSubtitle {
  url: string;
  label: string;
  lang?: string;
}

export interface StreamItem {
  id: string;
  /** Display name only, e.g. "Server 3". Never an upstream name. */
  name: string;
  title: string;
  label: string;
  server: string;
  serverName: string;
  /**
   * Opaque, stable id of the upstream server this stream belongs to. Several
   * streams (qualities / audio languages) share one group; never displayed.
   */
  group?: string;
  url: string;
  quality?: string;
  /** Normalised quality label, e.g. "1080p" or "4K". */
  qualityLabel?: string;
  lang?: string;
  /** Human language, e.g. "Tamil". */
  langLabel?: string;
  version?: "vo" | "vf" | "dub" | "sub" | "multi";
  type?: "hls" | "mp4" | "m3u8";
  direct?: boolean;
  subtitles?: StreamSubtitle[];
  qualities?: Array<{ quality: string; qualityLabel: string; url: string }>;
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
  thumbnails?: string | null;
}

export interface StreamResponse {
  success: boolean;
  tmdbId?: number | string;
  imdbId?: string;
  count?: number;
  streams?: StreamItem[];
  error?: string;
}

export interface StreamsResult {
  streams: StreamItem[];
  imdbId?: string;
  error?: string;
}

export type ProbeResult = "fast" | "slow" | "offline";

// The backend caps each provider at PROVIDER_TIMEOUT_MS (12s default), so
// aggregate requests finish well under 35s even if one upstream stalls.
const REQUEST_TIMEOUT_MS = 35_000;

/** How long a failing replica is skipped before it is retried. */
const REPLICA_COOLDOWN_MS = 30_000;

const nowMs = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

let cachedReplicaBases: string[] | null = null;

/**
 * Parses every configured replica URL and removes duplicates (the env is often
 * "a,a" and used to be retried twice for no reason).
 *
 * The env is baked in at build time, so the parsed list is cached per runtime.
 */
export function getApiReplicaBases(): string[] {
  if (cachedReplicaBases) return cachedReplicaBases;

  const raw =
    process.env.NEXT_PUBLIC_API_URLS || process.env.NEXT_PUBLIC_API_URL || "";
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  if (list.length > 0) {
    cachedReplicaBases = Array.from(new Set(list));
    return cachedReplicaBases;
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname || "localhost";
    cachedReplicaBases = [`http://${hostname}:8787`];
  } else {
    cachedReplicaBases = ["http://localhost:8787"];
  }
  return cachedReplicaBases;
}

interface ReplicaHealth {
  failures: number;
  /** Timestamp (Date.now()) until which this replica is skipped. */
  retryAt: number;
  /** Rough EWMA of successful response time, in ms. */
  latencyMs: number;
}

// Per-session health, not persisted: a reload starts from a clean slate.
const replicaHealth = new Map<string, ReplicaHealth>();

function noteReplicaSuccess(base: string, latencyMs: number): void {
  const prev = replicaHealth.get(base);
  replicaHealth.set(base, {
    failures: 0,
    retryAt: 0,
    latencyMs: prev
      ? Math.round(prev.latencyMs * 0.7 + latencyMs * 0.3)
      : Math.round(latencyMs),
  });
}

function noteReplicaFailure(base: string): void {
  const prev = replicaHealth.get(base) || {
    failures: 0,
    retryAt: 0,
    latencyMs: 0,
  };
  const failures = prev.failures + 1;
  // Back off progressively (30s, 60s, … capped at 5 min) so one dead replica
  // cannot keep burning a full request timeout on every call.
  const cooldown = Math.min(
    REPLICA_COOLDOWN_MS * 2 ** (failures - 1),
    5 * 60_000
  );
  replicaHealth.set(base, {
    ...prev,
    failures,
    retryAt: Date.now() + cooldown,
  });
}

/** Consecutive failures, used to judge whether a replica answered at all. */
function getReplicaRank(base: string): number {
  const health = replicaHealth.get(base);
  if (!health || health.failures === 0) return 0;
  return Date.now() >= health.retryAt ? 1 : 2;
}

let replicaIndex = 0;

/**
 * Picks the replica order for one request.
 *
 * Healthy replicas are rotated round-robin so consecutive requests are spread
 * evenly across the cluster. Replicas cooling down after a failure are tried
 * last (never removed), so the app still works when one node is down.
 */
function getOrderedReplicas(): string[] {
  const replicas = getApiReplicaBases();
  if (replicas.length <= 1) return [...replicas];

  // Rank 0 = healthy, rank 1 = cooldown elapsed and due a retry, rank 2 = cooling
  // down. Retryable replicas stay in the rotation so they can recover.
  const eligible = replicas.filter((base) => getReplicaRank(base) < 2);
  const pool = eligible.length ? eligible : replicas;

  const start = replicaIndex++ % pool.length;
  const ordered = [...pool.slice(start), ...pool.slice(0, start)];

  if (pool.length < replicas.length) {
    const rest = replicas
      .filter((base) => !pool.includes(base))
      .sort((a, b) => getReplicaRank(a) - getReplicaRank(b));
    ordered.push(...rest);
  }
  return ordered;
}

/* ------------------------------------------------------------------ *
 * Display-safe derivation helpers
 * ------------------------------------------------------------------ */

export const SERVER_CODENAMES = [
  "Sunny",
  "Ari",
  "Nova",
  "Titan",
  "Mega",
  "Aura",
  "Echo",
  "Atlas",
  "Pulse",
  "Zenith",
  "Orion",
  "Vortex",
  "Stella",
  "Sol",
  "Luna",
  "Kite",
  "Comet",
  "Apex",
  "Radiant",
  "Zephyr",
  "Beacon",
];

/** Language tokens found in provider labels. Matched whole-word, case-insensitive. */
const LANGUAGES: Array<{ re: RegExp; code: string; label: string }> = [
  { re: /\b(multi(-?audio)?|dual)\b/i, code: "mul", label: "Multi-Audio" },
  { re: /\bvostfr\b/i, code: "vostfr", label: "VOSTFR" },
  { re: /\b(original|ost|vo)\b/i, code: "vo", label: "Original" },
  { re: /\b(french|français|francais|vf)\b/i, code: "fre", label: "French" },
  { re: /\b(german|deutsch)\b/i, code: "ger", label: "German" },
  { re: /\b(spanish|español|espanol)\b/i, code: "spa", label: "Spanish" },
  { re: /\b(italian|italiano)\b/i, code: "ita", label: "Italian" },
  { re: /\bhindi\b/i, code: "hin", label: "Hindi" },
  { re: /\btamil\b/i, code: "tam", label: "Tamil" },
  { re: /\btelugu\b/i, code: "tel", label: "Telugu" },
  { re: /\bmalayalam\b/i, code: "mal", label: "Malayalam" },
  { re: /\bkannada\b/i, code: "kan", label: "Kannada" },
  { re: /\bbengali\b/i, code: "ben", label: "Bengali" },
  { re: /\bmarathi\b/i, code: "mar", label: "Marathi" },
  { re: /\bpunjabi\b/i, code: "pan", label: "Punjabi" },
  { re: /\burdu\b/i, code: "urd", label: "Urdu" },
  { re: /\barabic\b/i, code: "ara", label: "Arabic" },
  { re: /\bportuguese\b/i, code: "por", label: "Portuguese" },
  { re: /\brussian\b/i, code: "rus", label: "Russian" },
  { re: /\bjapanese\b/i, code: "jpn", label: "Japanese" },
  { re: /\bkorean\b/i, code: "kor", label: "Korean" },
  { re: /\bchinese\b/i, code: "chi", label: "Chinese" },
  { re: /\bturkish\b/i, code: "tur", label: "Turkish" },
  { re: /\bthai\b/i, code: "tha", label: "Thai" },
  { re: /\bindonesian\b/i, code: "ind", label: "Indonesian" },
  { re: /\bvietnamese\b/i, code: "vie", label: "Vietnamese" },
  { re: /\bukrainian\b/i, code: "ukr", label: "Ukrainian" },
  { re: /\bpolish\b/i, code: "pol", label: "Polish" },
  { re: /\bdutch\b/i, code: "dut", label: "Dutch" },
  { re: /\bswedish\b/i, code: "swe", label: "Swedish" },
  { re: /\bdanish\b/i, code: "dan", label: "Danish" },
  { re: /\bnorwegian\b/i, code: "nor", label: "Norwegian" },
  { re: /\bgreek\b/i, code: "gre", label: "Greek" },
  { re: /\bhebrew\b/i, code: "heb", label: "Hebrew" },
  { re: /\bromanian\b/i, code: "rum", label: "Romanian" },
  { re: /\bh(ungarian)\b/i, code: "hun", label: "Hungarian" },
  { re: /\bczech\b/i, code: "cze", label: "Czech" },
  { re: /\benglish\b/i, code: "eng", label: "English" },
];

const LANG_CODE_MAP: Record<string, { code: string; label: string }> = {
  mul: { code: "mul", label: "Multi-Audio" },
  multi: { code: "mul", label: "Multi-Audio" },
  vostfr: { code: "vostfr", label: "VOSTFR" },
  vo: { code: "vo", label: "Original" },
  original: { code: "vo", label: "Original" },
  vf: { code: "fre", label: "French" },
  en: { code: "eng", label: "English" },
  eng: { code: "eng", label: "English" },
  hi: { code: "hin", label: "Hindi" },
  hin: { code: "hin", label: "Hindi" },
  ta: { code: "tam", label: "Tamil" },
  tam: { code: "tam", label: "Tamil" },
  te: { code: "tel", label: "Telugu" },
  tel: { code: "tel", label: "Telugu" },
  fr: { code: "fre", label: "French" },
  fre: { code: "fre", label: "French" },
  fra: { code: "fre", label: "French" },
  de: { code: "ger", label: "German" },
  ger: { code: "ger", label: "German" },
  deu: { code: "ger", label: "German" },
  es: { code: "spa", label: "Spanish" },
  spa: { code: "spa", label: "Spanish" },
  it: { code: "ita", label: "Italian" },
  ita: { code: "ita", label: "Italian" },
  ar: { code: "ara", label: "Arabic" },
  ara: { code: "ara", label: "Arabic" },
  ja: { code: "jpn", label: "Japanese" },
  jpn: { code: "jpn", label: "Japanese" },
  ko: { code: "kor", label: "Korean" },
  kor: { code: "kor", label: "Korean" },
  pt: { code: "por", label: "Portuguese" },
  por: { code: "por", label: "Portuguese" },
  ru: { code: "rus", label: "Russian" },
  rus: { code: "rus", label: "Russian" },
  tr: { code: "tur", label: "Turkish" },
  tur: { code: "tur", label: "Turkish" },
  zh: { code: "chi", label: "Chinese" },
  chi: { code: "chi", label: "Chinese" },
  nl: { code: "dut", label: "Dutch" },
  dut: { code: "dut", label: "Dutch" },
  pl: { code: "pol", label: "Polish" },
  pol: { code: "pol", label: "Polish" },
  sv: { code: "swe", label: "Swedish" },
  swe: { code: "swe", label: "Swedish" },
  da: { code: "dan", label: "Danish" },
  dan: { code: "dan", label: "Danish" },
  no: { code: "nor", label: "Norwegian" },
  nor: { code: "nor", label: "Norwegian" },
  el: { code: "gre", label: "Greek" },
  gre: { code: "gre", label: "Greek" },
  he: { code: "heb", label: "Hebrew" },
  heb: { code: "heb", label: "Hebrew" },
  ro: { code: "rum", label: "Romanian" },
  rum: { code: "rum", label: "Romanian" },
  hu: { code: "hun", label: "Hungarian" },
  hun: { code: "hun", label: "Hungarian" },
  cs: { code: "cze", label: "Czech" },
  cze: { code: "cze", label: "Czech" },
};

const QUALITY_RANK: Record<string, number> = {
  "4K": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "576p": 576,
  "480p": 480,
  "360p": 360,
  "240p": 240,
  Auto: 0,
};

function detectQuality(...parts: Array<string | undefined>): string | undefined {
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return undefined;
  if (/(^|[^a-z0-9])(4k|2160|uhd)([^a-z0-9]|$)/.test(hay)) return "4K";
  const match = hay.match(/(^|[^a-z0-9])(\d{3,4})p?([^a-z0-9]|$)/);
  if (match) {
    const num = parseInt(match[2], 10);
    if (num >= 2100) return "4K";
    if (num >= 1400) return "1440p";
    if (num >= 900) return "1080p";
    if (num >= 650) return "720p";
    if (num >= 500) return "540p";
    if (num >= 400) return "480p";
    if (num >= 300) return "360p";
    return `${num}p`;
  }
  return undefined;
}

function detectLanguage(
  name: string | undefined,
  lang: string | undefined,
  version?: string | undefined,
  providerKey?: string
): { code: string; label: string } | undefined {
  const normVersion = version?.toLowerCase().trim();
  const normLang = lang?.toLowerCase().trim();
  const hay = name || "";

  // Anime Japanese Sub or English Dub (MegaPlay / Anime resolver)
  if (providerKey === "megaplay" || providerKey === "mega") {
    if (normVersion === "sub" || normLang === "ja" || normLang === "jpn" || /\b(japanese|sub)\b/i.test(hay)) {
      return { code: "jpn", label: "Japanese (Sub)" };
    }
    if (normVersion === "dub" || normLang === "en" || normLang === "eng" || /\b(english|dub)\b/i.test(hay)) {
      return { code: "eng", label: "English (Dub)" };
    }
  }

  // 1. Explicit VOSTFR (Hardsub - Original Audio with French Subtitles)
  if (
    normLang === "vostfr" ||
    /\bvostfr\b/i.test(hay) ||
    (normVersion === "sub" && (normLang === "fr" || normLang === "fre" || /\b(french|sub)\b/i.test(hay)))
  ) {
    return { code: "vostfr", label: "VOSTFR (French Sub)" };
  }

  // 2. Explicit VO / Original audio indicator. The provider's own language is
  // kept in the label so an original track reads "Korean (Original)" instead of
  // a bare "Original (VO)" (Box tags every original language as `vo`).
  if (
    normVersion === "vo" ||
    normVersion === "original" ||
    normLang === "vo" ||
    normLang === "original" ||
    /\b(original|ost|vo)\b/i.test(hay)
  ) {
    const concrete =
      normLang && normLang !== "vo" && normLang !== "original"
        ? LANG_CODE_MAP[normLang]
        : undefined;
    if (concrete) {
      return { code: concrete.code, label: `${concrete.label} (Original)` };
    }
    return { code: "vo", label: "Original" };
  }

  // 3. Explicit VF / French Dub
  if (
    normVersion === "vf" ||
    normLang === "fr" ||
    normLang === "fre" ||
    normLang === "fra" ||
    /\b(french|français|francais|vf)\b/i.test(hay)
  ) {
    return { code: "fre", label: "French (VF)" };
  }

  // 4. Multi-audio indicator
  if (
    normVersion === "multi" ||
    normLang === "mul" ||
    normLang === "multi" ||
    /\b(multi(-?audio)?|dual)\b/i.test(hay)
  ) {
    if (providerKey === "vixsrc") {
      return { code: "mul", label: "Italian · Original" };
    }
    return { code: "mul", label: "Multi-Audio" };
  }

  // 5. English on multi-language provider (e.g. Vidy Miami 4K is original audio)
  if ((providerKey === "vidy" || providerKey === "videasy") && (normLang === "en" || normLang === "eng")) {
    return { code: "vo", label: "Original" };
  }

  // 6. German Dub
  if (normLang === "de" || normLang === "ger" || normLang === "deu" || /\b(german|deutsch)\b/i.test(hay)) {
    return { code: "ger", label: "German (Dub)" };
  }

  // 7. Spanish Dub
  if (normLang === "es" || normLang === "spa" || /\b(spanish|español|espanol)\b/i.test(hay)) {
    return { code: "spa", label: "Spanish (Dub)" };
  }

  // 8. Hindi Dub
  if (normLang === "hi" || normLang === "hin" || /\bhindi\b/i.test(hay)) {
    return { code: "hin", label: "Hindi (Dub)" };
  }

  // 9. Italian
  if (normLang === "it" || normLang === "ita" || /\b(italian|italiano)\b/i.test(hay)) {
    return { code: "ita", label: "Italian" };
  }

  // 10. Lang code map lookup
  if (normLang && LANG_CODE_MAP[normLang]) {
    return LANG_CODE_MAP[normLang];
  }

  // 11. String regex matching against LANGUAGES table
  for (const l of LANGUAGES) {
    if (l.re.test(hay)) return { code: l.code, label: l.label };
  }

  return undefined;
}

function detectVersion(hay: string): StreamItem["version"] | undefined {
  if (/\bvostfr\b/i.test(hay)) return "sub";
  if (/\b(vf|dub(bed)?)\b/i.test(hay)) return "dub";
  if (/\b(multi)\b/i.test(hay)) return "multi";
  if (/\b(vo|original)\b/i.test(hay)) return "vo";
  return undefined;
}

function qualityRank(label?: string): number {
  if (!label || label === "Auto") return 0;
  return QUALITY_RANK[label] ?? 0;
}

function streamType(url: string): "hls" | "mp4" {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".webm") || path.endsWith(".mkv")) {
    return "mp4";
  }
  return "hls";
}

function shortHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export const CANONICAL_CODENAMES: Record<string, string> = {
  moviebox: "Box",
  box: "Box",
  netmirror: "Sunny",
  sunny: "Sunny",
  vixsrc: "Ari",
  ari: "Ari",
  vidzy: "Nova",
  nova: "Nova",
  vidy: "Titan",
  videasy: "Titan",
  titan: "Titan",
  "4khdhub": "Hub",
  hub: "Hub",
  dahmer: "Apex",
  apex: "Apex",
  castle: "Steve",
  steve: "Steve",
  showbox: "Cloud",
  cloud: "Cloud",
  megaplay: "Mega",
  mega: "Mega",
  vidsrc: "Aura",
  vidsrcto: "Aura",
  aura: "Aura",
};

export function getProviderCanonicalKey(provider: unknown, url: string): string {
  const p = typeof provider === "string" ? provider.toLowerCase().trim() : "";
  if (p.includes("moviebox") || p === "box") return "moviebox";
  if (p.includes("netmirror") || p === "sunny") return "netmirror";
  if (p.includes("vixsrc") || p === "ari") return "vixsrc";
  if (p.includes("vidzy") || p === "nova") return "vidzy";
  if (p.includes("vidy") || p.includes("videasy") || p === "titan") return "vidy";
  if (p.includes("castle") || p === "steve") return "castle";
  if (p.includes("4khdhub") || p === "hub") return "4khdhub";
  if (p.includes("showbox") || p === "cloud") return "showbox";
  if (p.includes("dahmer") || p === "apex") return "dahmer";
  if (p.includes("megaplay") || p === "mega") return "megaplay";
  if (p.includes("vidsrc") || p === "vidsrcto" || p === "aura") return "vidsrc";
  if (p) return p;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes("hakunaymatata") || host.includes("aoneroom")) return "moviebox";
    if (host.includes("netmirror") || host.includes("net27") || host.includes("net52") || host.includes("imgcdn")) return "netmirror";
    if (host.includes("vixsrc")) return "vixsrc";
    if (host.includes("vidzy")) return "vidzy";
    if (host.includes("vidy") || host.includes("wecollege") || host.includes("goldenkite") || host.includes("moon")) return "vidy";
    if (host.includes("hscow") || host.includes("fcxmb") || host.includes("bhcxy")) return "castle";
    if (host.includes("nexabloom") || host.includes("megaplay") || host.includes("mysubsplay") || host.includes("emeralddrift")) return "megaplay";
    if (host.includes("vidsrc") || host.includes("birchandbramble") || host.includes("pebblebeachpottery") || host.includes("stellarconductornexus")) return "vidsrc";
    return `host:${host}`;
  } catch {
    return `host:${url.split("/")[2] || "unknown"}`;
  }
}

export function getProviderDisplayLabel(providerKey: string, fallback?: string): string {
  switch (providerKey) {
    case "moviebox":
      return "Multi-Dub · Subtitles";
    case "netmirror":
      return "Multi-audio · built-in subs";
    case "vixsrc":
      return "Italian · Original";
    case "vidzy":
      return "French · Multi-Audio";
    case "vidy":
    case "videasy":
      return "Multi-Language · 4K";
    case "castle":
    case "steve":
      return "HLS · Multi-Language";
    case "megaplay":
    case "mega":
      return "Anime · Sub & Dub · HLS";
    case "vidsrc":
    case "vidsrcto":
    case "aura":
      return "Multi-Quality · HLS";
    default:
      return fallback || "Multi-quality";
  }
}

/** Stable, opaque id for the upstream server that produced a stream.
 *
 * Groups by provider (e.g. NetMirror, Vixsrc, Vidzy, Vidy).
 * All variants (qualities / audio languages) from the same provider share
 * one group so the Servers menu shows exactly one clean row per provider.
 */
export function serverGroupKey(
  provider: unknown,
  url: string,
  version?: string | undefined
): string {
  const key = getProviderCanonicalKey(provider, url);
  if (key === "megaplay" && (version === "sub" || version === "dub")) {
    return `g-${shortHash(key)}-${version}`;
  }
  return `g-${shortHash(key)}`;
}

/** Everything the UI shows is rebuilt here — raw upstream strings are discarded. */
export function normalizeStreams(raw: StreamItem[]): StreamItem[] {
  const seenUrls = new Set<string>();

  // ── 1. Build intermediate list ──────────────────────────────────────────
  type Intermediate = StreamItem & {
    _providerKey: string;
    _qualityRankVal: number;
  };
  const items: Intermediate[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const rawProvider = (item as StreamItem & { provider?: string }).provider;
    const providerKey = getProviderCanonicalKey(rawProvider, url);

    const rawName = `${item.name || ""} ${item.title || ""}`.trim();
    const qualityLabel = detectQuality(item.quality, item.qualityLabel, rawName);
    const version = item.version || detectVersion(rawName);
    const language = detectLanguage(rawName, item.lang, version, providerKey);

    items.push({
      ...(item as StreamItem),
      _providerKey: providerKey,
      _qualityRankVal: qualityRank(qualityLabel),
      qualityLabel,
      version,
      lang: language?.code,
      langLabel: language?.label,
      type: item.type === "mp4" ? "mp4" : streamType(url),
    } as Intermediate);
  }

  // ── 2. Dedup by (group-key + lang): keep highest-quality stream ─────────
  // Also collect all resolutions (e.g. 1080p, 720p, 480p, 360p MP4s) into qualities
  const bestBySlot = new Map<string, Intermediate>();
  const qualitiesBySlot = new Map<string, Array<{ quality: string; qualityLabel: string; url: string }>>();

  for (const item of items) {
    const grp = serverGroupKey(item._providerKey, item.url, item.version);
    const slot = `${grp}||${item.lang ?? "unk"}`;

    const qList = qualitiesBySlot.get(slot) || [];
    if (item.qualityLabel && !qList.some((q) => q.qualityLabel === item.qualityLabel)) {
      qList.push({
        quality: item.quality || item.qualityLabel,
        qualityLabel: item.qualityLabel,
        url: item.url,
      });
    }
    qualitiesBySlot.set(slot, qList);

    const existing = bestBySlot.get(slot);
    if (!existing || item._qualityRankVal > existing._qualityRankVal) {
      bestBySlot.set(slot, item);
    }
  }

  // ── 3. Build output ─────────────────────────────────────────────────────
  const counters = new Map<string, number>();
  const out: StreamItem[] = [];

  for (const item of bestBySlot.values()) {
    const qualityLabel = item.qualityLabel;
    const language = item.lang
      ? { code: item.lang, label: item.langLabel ?? item.lang }
      : undefined;
    const version = item.version;

    const countKey = `${qualityLabel || "auto"}|${language?.code || "unk"}`;
    const dup = (counters.get(countKey) || 0) + 1;
    counters.set(countKey, dup);

    const id = `srv-${(qualityLabel || "auto").toLowerCase()}-${language?.code || "unk"
      }-${dup}`;

    const grp = serverGroupKey(item._providerKey, item.url, item.version);
    const providerLabel = getProviderDisplayLabel(item._providerKey, language?.label);

    const slot = `${grp}||${item.lang ?? "unk"}`;
    const allQualities = qualitiesBySlot.get(slot);
    if (allQualities && allQualities.length > 1) {
      allQualities.sort((a, b) => qualityRank(b.qualityLabel) - qualityRank(a.qualityLabel));
    }

    out.push({
      id,
      name: "Server",
      title: "Server",
      label: providerLabel,
      server: id,
      serverName: "Server",
      group: grp,
      url: item.url,
      quality: item.quality,
      qualityLabel,
      lang: language?.code,
      langLabel: language?.label,
      version,
      type: item.type,
      direct: item.direct,
      intro: item.intro,
      outro: item.outro,
      thumbnails: item.thumbnails,
      qualities: allQualities && allQualities.length > 1 ? allQualities : undefined,
      subtitles: Array.isArray(item.subtitles)
        ? item.subtitles.filter((s) => s && typeof s.url === "string")
        : undefined,
    });
  }

  // ── 4. Sort: MegaPlay (for anime) → VidSrc → Box (MovieBox) → Sunny (NetMirror) → Titan (Vidy) → Steve (Castle) → Ari (Vixsrc) → Nova (Vidzy) ─
  const PROVIDER_ORDER = ["megaplay", "vidsrc", "moviebox", "netmirror", "vidy", "videasy", "castle", "vixsrc", "vidzy"];
  out.sort((a, b) => {
    // 1. Sort by provider order first
    const getOrder = (item: StreamItem) => {
      for (let i = 0; i < PROVIDER_ORDER.length; i++) {
        const p = PROVIDER_ORDER[i];
        if (item.group?.startsWith(`g-${shortHash(p)}`)) return i;
      }
      return 99;
    };
    const orderDiff = getOrder(a) - getOrder(b);
    if (orderDiff !== 0) return orderDiff;

    // 2. Within the same provider: highest quality first
    const q = qualityRank(b.qualityLabel) - qualityRank(a.qualityLabel);
    if (q !== 0) return q;

    // 3. Original / VO first, then French, then others
    const langRank = (item: StreamItem) => {
      if (item.lang === "vo" || item.langLabel?.includes("Original")) return 0;
      if (item.lang === "mul" || item.langLabel?.includes("Multi")) return 1;
      if (item.lang === "fre" || item.langLabel?.includes("French")) return 2;
      return 3;
    };
    return langRank(a) - langRank(b);
  });

  // ── 5. Assign codenames — canonical per provider ────────────────────────
  const nameByGroup = new Map<string, string>();
  return out.map((stream) => {
    const key = stream.group || stream.id;
    let name = nameByGroup.get(key);
    if (!name) {
      for (const [p, codename] of Object.entries(CANONICAL_CODENAMES)) {
        if (key.startsWith(`g-${shortHash(p)}`)) {
          name = codename;
          break;
        }
      }
      if (!name) {
        const position = nameByGroup.size;
        name =
          SERVER_CODENAMES[position % SERVER_CODENAMES.length] ||
          `Server ${position + 1}`;
      }
      nameByGroup.set(key, name);
    }
    return { ...stream, name, title: name, server: stream.id, serverName: name };
  });
}

/** Picks the best server: a favourite first, then language match, then quality. */
export function pickBestStreamIndex(
  streams: StreamItem[],
  favorites: string[],
  preferredLang?: string
): number {
  if (!streams.length) return 0;
  const favIndex = streams.findIndex(
    (s) => favorites.includes(s.group || s.id) || favorites.includes(s.id)
  );
  if (favIndex >= 0) return favIndex;

  const pref = preferredLang ? LANG_CODE_MAP[preferredLang.toLowerCase()]?.code : undefined;
  let best = 0;
  let bestScore = -Infinity;
  streams.forEach((stream, index) => {
    const langMatch = pref && stream.lang === pref ? 1 : 0;
    const multiBonus = stream.lang === "mul" || stream.langLabel === "Multi-Audio" ? 2 : 0;
    const originalBonus = stream.version === "vo" || stream.lang === "vo" || stream.langLabel === "Original" ? 1 : 0;
    const score =
      langMatch * 10_000 + multiBonus * 500 + qualityRank(stream.qualityLabel) * 10 + originalBonus;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

async function fetchJson(
  url: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", ...extraHeaders },
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

let cachedClientGeo: { ip?: string; country_code?: string; timezone?: string } | null = null;

/**
 * Fetches the user's public IP and geolocation from https://get.geojs.io/v1/ip/geo.json
 * Cached in memory to avoid repetitive lookups.
 */
export async function getClientGeo(): Promise<{ ip?: string; country_code?: string; timezone?: string } | null> {
  if (cachedClientGeo) return cachedClientGeo;
  if (typeof window === "undefined") return null;

  // A hung geo lookup must not delay the stream request: streams still work
  // without the extra IP/region hints, so give it a short deadline.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch("https://get.geojs.io/v1/ip/geo.json", {
      cache: "force-cache",
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        cachedClientGeo = {
          ip: data.ip,
          country_code: data.country_code,
          timezone: data.timezone,
        };
        return cachedClientGeo;
      }
    }
  } catch { } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * Requests client-signed headers from the backend so the browser can make direct,
 * unblocked client-side calls directly to MovieBox endpoints (https://api6.aoneroom.com).
 */
export async function fetchMovieBoxClientHeaders(
  targetUrl: string,
  method = "GET"
): Promise<{ success: boolean; headers?: Record<string, string>; error?: string }> {
  try {
    const geo = await getClientGeo();
    const params = new URLSearchParams({
      url: targetUrl,
      method,
      ...(geo?.ip ? { clientIp: geo.ip } : {}),
      ...(geo?.country_code ? { region: geo.country_code } : {}),
      ...(geo?.timezone ? { timezone: geo.timezone } : {}),
    });

    let lastError = "";
    for (const base of getOrderedReplicas()) {
      const started = nowMs();
      try {
        const res = await fetch(
          `${base}/api/moviebox/client-headers?${params.toString()}`
        );
        if (res.ok) {
          noteReplicaSuccess(base, nowMs() - started);
          return await res.json();
        }
        if (res.status >= 500 || res.status === 429) noteReplicaFailure(base);
        else noteReplicaSuccess(base, nowMs() - started);
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        noteReplicaFailure(base);
        lastError = (e as Error).message;
      }
    }
    return {
      success: false,
      error: lastError || "Failed to obtain MovieBox client headers",
    };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function fetchStreams(input: {
  type: "movie" | "tv";
  tmdbId?: number | string;
  season?: number;
  episode?: number;
  lang?: string;
  anilistId?: number | string;
  malId?: number | string;
  anime?: boolean;
  subType?: "sub" | "dub";
}): Promise<StreamsResult> {
  const { type, tmdbId, season, episode, lang, anilistId, malId, anime, subType } = input;

  // Pre-fetch client geolocation so backend MovieBox signatures match the user's actual device & IP
  const geo = await getClientGeo();

  const params = new URLSearchParams();
  if (geo?.ip) params.set("clientIp", geo.ip);
  if (geo?.country_code) params.set("region", geo.country_code);
  if (geo?.timezone) params.set("timezone", geo.timezone);
  if (lang) params.set("lang", lang);
  if (subType) params.set("subType", subType);

  let apiPath: string;

  if (anime && anilistId) {
    // Anime: use dedicated AniList-first endpoint — no TMDB ID needed in the URL
    if (episode) params.set("episode", String(episode));
    if (season) params.set("season", String(season));
    if (malId) params.set("malId", String(malId));
    apiPath = `/api/streams/anime/${encodeURIComponent(String(anilistId))}`;
  } else {
    // Movie / TV: standard TMDB-based endpoint
    const apiType = type === "movie" ? "movie" : "series";
    const targetId = tmdbId || anilistId || 0;
    if (season) params.set("season", String(season));
    if (episode) params.set("episode", String(episode));
    if (anilistId) params.set("anilistId", String(anilistId));
    if (malId) params.set("malId", String(malId));
    apiPath = `/api/streams/${apiType}/${encodeURIComponent(String(targetId))}`;
  }

  const queryStr = params.toString() ? `?${params.toString()}` : "";
  const turnstileProof = isTurnstileConfigured()
    ? await waitForTurnstileProof(5000)
    : null;
  const reqHeaders: Record<string, string> = turnstileProof
    ? { "x-turnstile-proof": turnstileProof }
    : {};

  const replicas = getOrderedReplicas();
  let lastError = "";

  for (const replicaBase of replicas) {
    const started = nowMs();
    try {
      const { status, data } = await fetchJson(
        `${replicaBase}${apiPath}${queryStr}`,
        reqHeaders
      );

      if (status >= 500 || status === 429) {
        // The replica itself is unhealthy — skip it for a while and try the next.
        noteReplicaFailure(replicaBase);
        lastError = "The stream service returned an error.";
        continue;
      }

      if (status >= 400) {
        // A valid answer about the title: this replica is fine, don't penalise it.
        noteReplicaSuccess(replicaBase, nowMs() - started);
        lastError =
          status === 404
            ? "This title isn't available right now."
            : "The stream service returned an error.";
        continue;
      }

      noteReplicaSuccess(replicaBase, nowMs() - started);

      const payload = (data || {}) as StreamResponse;
      const raw = Array.isArray(payload.streams) ? payload.streams : [];
      return {
        streams: normalizeStreams(raw),
        imdbId: payload.imdbId,
      };
    } catch (err) {
      noteReplicaFailure(replicaBase);
      lastError =
        (err as Error)?.name === "AbortError"
          ? "The stream service took too long to answer."
          : "Could not reach the stream service.";
    }
  }

  return { streams: [], error: lastError || "No stream servers responded." };
}

/**
 * Cheap reachability probe for the "Test servers" action. Uses an opaque
 * no-cors GET so it works for cross-origin proxies: a resolved request means
 * the host answered, a rejection means it did not.
 */
export async function probeStream(
  url: string,
  timeoutMs = 6000
): Promise<ProbeResult> {
  if (typeof fetch === "undefined") return "offline";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
      credentials: "omit",
    });
    const elapsed =
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
    return elapsed > 2500 ? "slow" : "fast";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timer);
  }
}
