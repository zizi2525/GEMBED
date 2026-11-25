/**
 * Subtitles & Audio System for VidSuper / Embed-Gibox.
 *
 * Implements the architecture from gibox/apps/web:
 * - Multi-language subtitle search + PTT (Parse Torrent Title) scoring
 * - Multi-language audio detection and formatting
 * - WebVTT, SRT, ASS/SSA parsers
 * - Customizable subtitle styling (font family, text size, color, opacity, edge, background)
 * - Timing delay stepper (±0.25s)
 * - Local file parser (.srt, .vtt, .ass)
 * - Per-video subtitle & timing persistence
 * - Strict masking of upstream provider names
 */

export const LANGS: [string, string, string][] = [
  ["eng", "English", "English"],
  ["ara", "Arabic", "العربية"],
  ["baq", "Basque", "Euskara"],
  ["ben", "Bengali", "বাংলা"],
  ["bos", "Bosnian", "Bosanski"],
  ["bre", "Breton", "Brezhoneg"],
  ["bul", "Bulgarian", "Български"],
  ["cat", "Catalan", "Català"],
  ["chi", "Chinese", "中文"],
  ["hrv", "Croatian", "Hrvatski"],
  ["cze", "Czech", "Čeština"],
  ["dan", "Danish", "Dansk"],
  ["dut", "Dutch", "Nederlands"],
  ["est", "Estonian", "Eesti"],
  ["fin", "Finnish", "Suomi"],
  ["fre", "French", "Français"],
  ["glg", "Galician", "Galego"],
  ["geo", "Georgian", "ქართული"],
  ["ger", "German", "Deutsch"],
  ["ell", "Greek", "Ελληνικά"],
  ["heb", "Hebrew", "עברית"],
  ["hin", "Hindi", "हिन्दी"],
  ["hun", "Hungarian", "Magyar"],
  ["ice", "Icelandic", "Íslenska"],
  ["ind", "Indonesian", "Bahasa Indonesia"],
  ["ita", "Italian", "Italiano"],
  ["jpn", "Japanese", "日本語"],
  ["kan", "Kannada", "ಕನ್ನಡ"],
  ["kor", "Korean", "한국어"],
  ["lav", "Latvian", "Latviešu"],
  ["lit", "Lithuanian", "Lietuvių"],
  ["mac", "Macedonian", "Македонски"],
  ["may", "Malay", "Bahasa Melayu"],
  ["mal", "Malayalam", "മലയാളം"],
  ["mar", "Marathi", "मराठी"],
  ["nor", "Norwegian", "Norsk"],
  ["oci", "Occitan", "Occitan"],
  ["per", "Persian", "فارسی"],
  ["pol", "Polish", "Polski"],
  ["por", "Portuguese", "Português"],
  ["pob", "Portuguese (BR)", "Português (BR)"],
  ["rum", "Romanian", "Română"],
  ["rus", "Russian", "Русский"],
  ["scc", "Serbian", "Српски"],
  ["sin", "Sinhala", "සිංහල"],
  ["slo", "Slovak", "Slovenčina"],
  ["slv", "Slovenian", "Slovenščina"],
  ["spa", "Spanish", "Español"],
  ["swe", "Swedish", "Svenska"],
  ["tam", "Tamil", "தமிழ்"],
  ["tel", "Telugu", "తెలుగు"],
  ["tha", "Thai", "ภาษาไทย"],
  ["tur", "Turkish", "Türkçe"],
  ["ukr", "Ukrainian", "Українська"],
  ["urd", "Urdu", "اردو"],
  ["vie", "Vietnamese", "Tiếng Việt"],
];

/** Map ISO 639-1 (2-letter) codes to ISO 639-2B (3-letter) codes */
export const ISO1TO3: Record<string, string> = {
  en: "eng", ar: "ara", eu: "baq", bn: "ben", bs: "bos",
  bg: "bul", ca: "cat", zh: "chi", hr: "hrv", cs: "cze",
  da: "dan", nl: "dut", et: "est", fi: "fin", fr: "fre",
  gl: "glg", ka: "geo", de: "ger", el: "ell", he: "heb",
  hi: "hin", hu: "hun", is: "ice", id: "ind", it: "ita",
  ja: "jpn", kn: "kan", ko: "kor", lv: "lav", lt: "lit",
  mk: "mac", ms: "may", ml: "mal", mr: "mar", no: "nor",
  oc: "oci", fa: "per", pl: "pol", pt: "por", ro: "rum", ru: "rus",
  sr: "scc", si: "sin", sk: "slo", sl: "slv", es: "spa",
  sv: "swe", ta: "tam", te: "tel", th: "tha", tr: "tur",
  uk: "ukr", ur: "urd", vi: "vie",
};

export const ISO3TO1: Record<string, string> = Object.entries(ISO1TO3).reduce(
  (acc, [k, v]) => {
    acc[v] = k;
    return acc;
  },
  {} as Record<string, string>,
);

/** Normalize any language code or name to canonical 3-letter code */
export function normLang(code: string | undefined | null): string {
  if (!code) return "eng";
  const c = String(code).toLowerCase().trim();
  if (ISO1TO3[c]) return ISO1TO3[c];
  if (c === "fra") return "fre";
  if (c === "deu") return "ger";
  if (c === "zho") return "chi";
  if (c === "fas") return "per";
  if (c === "ron") return "rum";
  if (c === "slk") return "slo";
  if (c === "ces") return "cze";
  if (c === "ell") return "ell";

  for (let i = 0; i < LANGS.length; i++) {
    if (
      LANGS[i][0] === c ||
      LANGS[i][1].toLowerCase() === c ||
      LANGS[i][2].toLowerCase() === c
    ) {
      return LANGS[i][0];
    }
  }
  return c.length === 3 ? c : "eng";
}

export function langLabel(code: string): { code3: string; english: string; native: string; label: string } {
  const c3 = normLang(code);
  const found = LANGS.find((l) => l[0] === c3);
  if (found) {
    const hasDiff = found[2] && found[2] !== found[1];
    return {
      code3: found[0],
      english: found[1],
      native: found[2],
      label: hasDiff ? `${found[1]} — ${found[2]}` : found[1],
    };
  }
  return { code3: c3, english: c3, native: c3, label: c3 };
}

/** Check if text is Right-To-Left (Arabic, Hebrew, Persian, Urdu) */
export function isRTL(textOrCode: string): boolean {
  if (!textOrCode) return false;
  const c3 = normLang(textOrCode);
  if (["ara", "per", "heb", "urd"].includes(c3)) return true;
  return /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(textOrCode);
}

/* ---------- Audio Track Formatting & Selection ---------- */

export function formatAudioLang(code: string, uiLocale = "en", originalLang?: string): string {
  const c = (code || "").toLowerCase().trim();
  const [base, variant] = c.split("-");
  const isSub = variant === "sub" || c.includes("sub") || c === "vostfr";
  const isDub = variant === "dub" || c.includes("dub") || c === "vf";
  const isOriginal =
    base === "orig" ||
    base === "original" ||
    base === "vo" ||
    Boolean(originalLang && base === originalLang.toLowerCase());

  // Arabic
  if (base === "ar" || base === "ara") {
    if (isSub) return "Arabic (Sub)";
    if (isDub) return "Arabic (Dub)";
    return "Arabic";
  }

  // French
  if (base === "fr" || base === "fre" || base === "fra" || base === "vf") {
    if (isSub || c === "vostfr") return "French (Sub)";
    return "French (VF)";
  }

  // German
  if (base === "de" || base === "ger" || base === "deu") {
    if (isSub) return "German (Sub)";
    if (isDub) return "German (Dub)";
    return "German";
  }

  // Hindi
  if (base === "hi" || base === "hin") {
    if (isSub) return "Hindi (Sub)";
    if (isDub) return "Hindi (Dub)";
    return "Hindi";
  }

  // Russian
  if (base === "ru" || base === "rus") {
    if (isSub) return "Russian (Sub)";
    if (isDub) return "Russian (Dub)";
    return "Russian";
  }

  // Spanish
  if (base === "es" || base === "spa") {
    if (isSub) return "Spanish (Sub)";
    if (isDub) return "Spanish (Dub)";
    return "Spanish";
  }

  // English
  if (base === "en" || base === "eng") {
    if (isOriginal) return "English (Original)";
    if (isSub) return "English (Sub)";
    return "English";
  }

  if (isOriginal) return "Original Audio";

  const info = langLabel(base);
  const nativeName = info?.english || base.toUpperCase();
  if (isSub) return `${nativeName} (Sub)`;
  if (isDub) return `${nativeName} (Dub)`;
  return nativeName;
}

export function pickBestAudioTrack(
  tracks: { name?: string; lang?: string }[],
  userPref: string | undefined,
  uiLocale = "en",
  originalLang?: string,
): number {
  if (!tracks || tracks.length <= 1) return 0;

  const normalize = (t: { name?: string; lang?: string }) =>
    `${t.lang || ""} ${t.name || ""}`.toLowerCase();

  const isMatch = (t: { name?: string; lang?: string }, target: string) => {
    const l = normalize(t);
    const code = (t.lang || "").toLowerCase();
    const cleanTarget = target.toLowerCase();
    if (cleanTarget === "vf" || cleanTarget === "fr") {
      return l.includes("fr") || l.includes("french") || code === "fr" || code === "fra" || code === "fre";
    }
    if (cleanTarget === "en") {
      return l.includes("en") || l.includes("english") || code === "en" || code === "eng";
    }
    if (cleanTarget === "es") {
      return l.includes("es") || l.includes("spanish") || code === "es" || code === "spa";
    }
    if (cleanTarget === "de") {
      return l.includes("de") || l.includes("german") || code === "de" || code === "ger";
    }
    if (cleanTarget === "ar") {
      return l.includes("ar") || l.includes("arabic") || code === "ar" || code === "ara";
    }
    return l.includes(cleanTarget) || code === cleanTarget;
  };

  if (userPref && userPref !== "auto") {
    if (userPref === "original" && originalLang) {
      const origIdx = tracks.findIndex((t) => isMatch(t, originalLang) || normalize(t).includes("orig"));
      if (origIdx >= 0) return origIdx;
    } else {
      const prefIdx = tracks.findIndex((t) => isMatch(t, userPref));
      if (prefIdx >= 0) return prefIdx;
    }
  }

  const enIdx = tracks.findIndex((t) => isMatch(t, "en"));
  if (enIdx >= 0) return enIdx;

  if (originalLang) {
    const origIdx = tracks.findIndex((t) => isMatch(t, originalLang));
    if (origIdx >= 0) return origIdx;
  }

  return 0;
}

/* ---------- PTT (Parse Torrent Title) Scoring System ---------- */

export interface VideoInfo {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  quality?: string | null;
  resolution?: string | null;
  releaseGroup?: string | null;
  codec?: string | null;
}

export const PTT = {
  qualities: {
    "2160p": /2160p|4k|uhd/i,
    "1080p": /1080p|1080i/i,
    "720p": /720p/i,
    "480p": /480p/i,
    HDRip: /hdrip/i,
    BDRip: /bdrip|brrip/i,
    DVDRip: /dvdrip/i,
    WEBRip: /webrip/i,
    "WEB-DL": /web-?dl/i,
    HDTV: /hdtv/i,
    BluRay: /blu-?ray|bdremux/i,
    CAM: /cam|camrip|hdcam/i,
    TS: /\bts\b|telesync|hdts/i,
    SCR: /scr|screener|dvdscr/i,
  } as Record<string, RegExp>,
  releaseGroups: /[-_\[]([A-Za-z0-9]+)(?:\])?$/,
  yearPattern: /(?:19|20)\d{2}/,
  seasonEpisode: /S(\d{1,2})E(\d{1,2})/i,
  codecs: {
    x264: /x264|h\.?264/i,
    x265: /x265|h\.?265|hevc/i,
    XviD: /xvid/i,
    DivX: /divx/i,
    AV1: /\bav1\b/i,
  } as Record<string, RegExp>,
  tiers: {
    hd: ["BluRay", "BDRip", "WEB-DL", "WEBRip", "HDRip", "HDTV"],
    raw: ["CAM", "TS", "SCR"],
  },
  parse(fn: string): VideoInfo | null {
    if (!fn) return null;
    const r: VideoInfo = {
      title: "",
      year: null,
      quality: null,
      resolution: null,
      codec: null,
      releaseGroup: null,
      season: null,
      episode: null,
    };
    const clean = fn.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|srt|sub|ass|vtt)$/i, "");
    const ym = clean.match(this.yearPattern);
    if (ym) r.year = parseInt(ym[0], 10);
    const se = clean.match(this.seasonEpisode);
    if (se) {
      r.season = +se[1];
      r.episode = +se[2];
    }
    for (const q in this.qualities) {
      if (this.qualities[q].test(clean)) {
        if (["2160p", "1080p", "720p", "480p"].indexOf(q) !== -1) r.resolution = q;
        else r.quality = q;
        break;
      }
    }
    for (const c in this.codecs) {
      if (this.codecs[c].test(clean)) {
        r.codec = c;
        break;
      }
    }
    const g = clean.match(this.releaseGroups);
    if (g) r.releaseGroup = g[1];
    let end = clean.length;
    if (ym && ym.index !== undefined) end = Math.min(end, ym.index);
    for (const k in this.qualities) {
      const m = clean.match(this.qualities[k]);
      if (m && m.index !== undefined) end = Math.min(end, m.index);
    }
    r.title = clean
      .substring(0, end)
      .replace(/[._-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return r;
  },
  score(v: VideoInfo | null, fn: string): number {
    if (!v || !fn) return 0;
    const s = this.parse(fn);
    if (!s) return 0;
    let sc = 0;
    const hd = this.tiers.hd;
    const raw = this.tiers.raw;
    const vq = v.quality;
    const sq = s.quality;
    if (vq && sq) {
      if (vq === sq) sc += 25;
      else if (hd.indexOf(vq) > -1 && hd.indexOf(sq) > -1) sc += 8;
      else if (hd.indexOf(vq) > -1 && raw.indexOf(sq) > -1) sc -= 50;
      else if (raw.indexOf(vq) > -1 && hd.indexOf(sq) > -1) sc -= 20;
    } else if (vq && hd.indexOf(vq) > -1 && !sq) {
      sc += 3;
    }
    if (v.resolution && s.resolution) sc += v.resolution === s.resolution ? 10 : 0;
    if (v.title && s.title) {
      const vw = v.title.split(/\s+/).filter((w) => w.length > 2);
      const sw: Record<string, number> = {};
      s.title.split(/\s+/).forEach((w) => {
        if (w.length > 2) sw[w] = 1;
      });
      if (vw.length) {
        sc += (vw.filter((w) => sw[w]).length / vw.length) * 35;
      }
    }
    if (v.year && s.year) sc += v.year === s.year ? 15 : -12;
    if (v.season !== null && v.episode !== null) {
      if (s.season === v.season && s.episode === v.episode) sc += 25;
      else if (s.season !== null || s.episode !== null) sc -= 35;
    }
    if (v.releaseGroup && s.releaseGroup) {
      sc += v.releaseGroup.toLowerCase() === s.releaseGroup.toLowerCase() ? 20 : 0;
    }
    if (v.codec && s.codec && v.codec === s.codec) sc += 5;
    return Math.max(0, Math.min(100, Math.round(sc)));
  },
  best<T extends { SubFileName?: string; MovieReleaseName?: string; SubDownloadsCnt?: string | number }>(
    v: VideoInfo | null,
    subs: T[],
  ): { subtitle: T; score: number; index: number } | null {
    if (!v || !subs || !subs.length) return null;
    const ep = v.season !== null && v.episode !== null;
    let b: { subtitle: T; score: number; index: number } | null = null;
    let bs = -Infinity;
    subs.forEach((sub, i) => {
      let sc = this.score(v, sub.SubFileName || sub.MovieReleaseName || "");
      const dl = parseInt(String(sub.SubDownloadsCnt || 0), 10) || 0;
      sc += dl > 10000 ? 3 : dl > 1000 ? 2 : dl > 100 ? 1 : 0;
      if (sc > bs) {
        bs = sc;
        b = { subtitle: sub, score: sc, index: i };
      }
    });
    return bs >= (ep ? 20 : 35) ? b : null;
  },
};

/* ---------- Subtitle Search & Track Interfaces ---------- */

export interface SubtitleResultItem {
  id: string;
  label: string;
  fileName?: string;
  releaseName?: string;
  language: string;
  languageCode: string;
  isSdh?: boolean;
  downloadUrl: string;
  encoding?: string;
  downloads?: number;
  rating?: string;
  score?: number;
  // Backward compatibility:
  IDSubtitleFile?: string;
  SubFileName?: string;
  MovieReleaseName?: string;
  SubDownloadLink?: string;
  SubEncoding?: string;
}

export type OsResultItem = SubtitleResultItem;

export interface SubTrack {
  id: string;
  label: string;
  lang: string;
  langName?: string;
  url: string;
  cues?: SubtitleCue[];
  score?: number;
  downloads?: number;
  hlsIndex?: number;
  link?: string;
  encoding?: string;
  raw?: string;
  isStreamSub?: boolean;
}

/**
 * Direct client-side OpenSubtitles search.
 * Fetches directly from https://rest.opensubtitles.org (which has Access-Control-Allow-Origin: *).
 * Eliminates server-side subtitle proxies and shared IP rate-limiting.
 */
export async function searchSubtitles(input: {
  imdbId?: string;
  lang: string;
  type?: "movie" | "tv";
  season?: number;
  episode?: number;
  title?: string;
  year?: number;
}): Promise<SubtitleResultItem[]> {
  const { imdbId, lang, type = "movie", season, episode, title, year } = input;
  const lang3 = normLang(lang);
  const cleanImdb = imdbId ? String(imdbId).replace(/\D/g, "") : "";

  let url = "https://rest.opensubtitles.org/search";
  if (cleanImdb) {
    if (type === "tv" && season && episode) {
      url += `/episode-${episode}/imdbid-${cleanImdb}/season-${season}`;
    } else {
      url += `/imdbid-${cleanImdb}`;
    }
    url += `/sublanguageid-${lang3}`;
  } else if (title) {
    const q = [title, year].filter(Boolean).join(" ");
    url += `/query-${encodeURIComponent(q.toLowerCase())}/sublanguageid-${lang3}`;
  } else {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: {
        "X-User-Agent": "trailers.to-UA",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.slice(0, 30).map((item: any, idx: number) => {
      const isSdh = item.SubHearingImpaired === "1";
      const rawFileName = item.SubFileName || item.MovieReleaseName || "";
      const rawReleaseName = item.MovieReleaseName || rawFileName;

      // Clean watermarks and names client-side
      const cleanFileName = rawFileName
        .replace(/(?:opensubtitles|osdb|subdl|theintrodb|theintrodatabase)[\._\-]*/gi, "")
        .trim();

      const cleanReleaseName = rawReleaseName
        .replace(/(?:opensubtitles|osdb|subdl|theintrodb|theintrodatabase)[\._\-]*/gi, "")
        .trim();

      const label =
        cleanFileName ||
        `${item.LanguageName || "English"} Track ${idx + 1}${isSdh ? " (CC)" : ""}`;

      const directDl = item.SubDownloadLink || "";

      return {
        id: item.IDSubtitleFile || `sub-${idx}`,
        label,
        fileName: cleanFileName || label,
        releaseName: cleanReleaseName || cleanFileName || label,
        language: item.LanguageName || "English",
        languageCode: item.SubLanguageID || lang3,
        isSdh,
        downloads: parseInt(String(item.SubDownloadsCnt || 0), 10) || 0,
        rating: item.SubRating || "0",
        downloadUrl: directDl,
        encoding: item.SubEncoding || "utf-8",
        // Backward compatibility
        IDSubtitleFile: item.IDSubtitleFile,
        SubFileName: cleanFileName || label,
        MovieReleaseName: cleanReleaseName || cleanFileName || label,
        SubDownloadLink: directDl,
        SubEncoding: item.SubEncoding || "utf-8",
      };
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn("[Subtitles] Direct client-side search failed:", err);
    return [];
  }
}


/* ---------- Promotional Watermark Interceptor & Replacer ---------- */

export const PROMO_KEYWORDS = [
  "opensubtitles",
  "osdb",
  "subdl",
  "subscene",
  "theintrodb",
  "theintrodatabase",
  "yify",
  "yts",
  "addic7ed",
  "podnapisi",
  "titlovi",
  "bsplayer",
  "1xbet",
  "melbet",
  "bet365",
  "stake.com",
  "parimatch",
  "mostbet",
  "linebet",
  "casino",
  "watch online",
  "downloaded from",
  "subtitles by",
  "synced by",
  "encoded by",
  "translated by",
  "ripped by",
  "vip member",
  "advertise your product",
  "support us on patreon",
  "t.me/",
  "telegram",
  "rate this subtitle",
];

export function isPromoText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of PROMO_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  if (/https?:\/\/|www\.[a-z0-9\-_]+\.[a-z]{2,}|osdb\.link/i.test(lower)) {
    return true;
  }
  if (/(?:subtitles?\s+(?:by|from)|synced\s+by|corrected\s+by|resync\s+by|encoded\s+by)/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Promo line shown in place of upstream subtitle adverts. It comes from the
 * server (PROMO_TEXT / PLAYER_NAME) and is pushed into this module by the
 * player, because the browser can't read non-NEXT_PUBLIC env vars.
 */
let brandPromoText = "";

export function setPromoText(text: string | undefined | null): void {
  const value = (text || "").trim();
  if (value) brandPromoText = value;
}

export function getOurPromoText(): string {
  return brandPromoText || "✨ Enjoy the Show";
}

export function replacePromotions(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const newLines = lines.map((line) => {
    if (isPromoText(line)) {
      return getOurPromoText();
    }
    return line;
  });
  // Deduplicate consecutive identical promo lines
  const deduped: string[] = [];
  const promo = getOurPromoText();
  for (const line of newLines) {
    if (line === promo && deduped[deduped.length - 1] === promo) {
      continue;
    }
    deduped.push(line);
  }
  return deduped.join("\n").trim();
}

/* ---------- Subtitle Cue Parsing & Types ---------- */

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function timecodeToSeconds(tc: string): number {
  if (!tc) return 0;
  const parts = tc.trim().replace(",", ".").split(":");
  if (parts.length === 3) {
    return (
      parseFloat(parts[0]) * 3600 +
      parseFloat(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(tc) || 0;
}

export function parseVTT(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (lines[i].includes("-->")) {
      const ab = lines[i].split("-->");
      const st = timecodeToSeconds(ab[0]);
      const endPart = ab[1].trim().split(/\s+/)[0];
      const en = timecodeToSeconds(endPart);
      i++;
      let txt = "";
      while (i < lines.length && lines[i].trim() !== "") {
        txt += lines[i] + "\n";
        i++;
      }
      let cleaned = txt
        .trim()
        .replace(/<[^>]+>/g, "")
        .replace(/&lrm;|&rlm;/gi, "");

      // Catch and replace promotions with our site promo
      if (isPromoText(cleaned)) {
        cleaned = getOurPromoText();
      }

      if (cleaned && Number.isFinite(st) && Number.isFinite(en) && en > st) {
        cues.push({ start: st, end: en, text: cleaned });
      }
    }
    i++;
  }
  return cues;
}

function assTimeToSeconds(tc: string): number {
  const parts = tc.trim().split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(tc) || 0;
}

function cleanAssText(raw: string): string {
  // Skip ASS vector drawing commands (e.g. {\p1}m 0 0 l 100 0...)
  if (/\{\\[^}]*p[1-9]\d*[^}]*\}/i.test(raw)) return "";
  return raw
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N|\\n/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export function parseASS(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  let fields = ["Layer", "Start", "End", "Style", "Actor", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
  let inEvents = true;

  for (const line of lines) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[(.+)\]$/);
    if (section) {
      inEvents = /^events$/i.test(section[1].trim());
      continue;
    }
    if (!inEvents) continue;

    const format = trimmed.match(/^Format\s*:\s*(.*)$/i);
    if (format) {
      fields = format[1].split(",").map((f) => f.trim());
      continue;
    }

    const dialogue = trimmed.match(/^Dialogue\s*:\s*(.*)$/i);
    if (!dialogue) continue;

    const parts: string[] = [];
    let rest = dialogue[1];
    for (let i = 0; i < fields.length - 1; i++) {
      const comma = rest.indexOf(",");
      if (comma < 0) break;
      parts.push(rest.slice(0, comma));
      rest = rest.slice(comma + 1);
    }
    parts.push(rest);

    const field = (name: string) => {
      const index = fields.findIndex((f) => f.toLowerCase() === name);
      return index < 0 ? "" : parts[index] ?? "";
    };
    const start = assTimeToSeconds(field("start"));
    const end = assTimeToSeconds(field("end"));
    let body = cleanAssText(field("text"));

    // Catch and replace promotions with our site promo
    if (isPromoText(body)) {
      body = getOurPromoText();
    }

    if (body && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      cues.push({ start, end, text: body });
    }
  }

  // Sort chronologically (ASS files often group signs/songs out of order)
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  // Merge simultaneous/overlapping cues at the same timestamp so signs + dialogue both show
  const merged: SubtitleCue[] = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.start - cue.start) < 0.05 && Math.abs(prev.end - cue.end) < 0.05) {
      if (!prev.text.includes(cue.text)) {
        prev.text = `${prev.text}\n${cue.text}`;
      }
    } else {
      merged.push(cue);
    }
  }
  return merged;
}

export function parseSubtitles(text: string): SubtitleCue[] {
  const body = text.replace(/^\uFEFF/, "");
  if (/\[Script Info\]/i.test(body) || /^\s*Dialogue\s*:/im.test(body)) {
    return parseASS(body);
  }
  return parseVTT(body);
}

export const parseSrtOrVtt = parseSubtitles;

export function cuesToVtt(cues: SubtitleCue[]): string {
  function fmtT(s: number): string {
    if (isNaN(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s % 1) * 1000);
    return `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}:${sec < 10 ? "0" : ""}${sec}.${ms < 10 ? "00" : ms < 100 ? "0" : ""}${ms}`;
  }
  let out = "WEBVTT\n\n";
  for (let i = 0; i < cues.length; i++) {
    out += `${i + 1}\n${fmtT(cues[i].start)} --> ${fmtT(cues[i].end)}\n${cues[i].text}\n\n`;
  }
  return out;
}

export function cuesToWebVttBlobUrl(cues: SubtitleCue[]): string {
  const vttStr = cuesToVtt(cues);
  return URL.createObjectURL(new Blob([vttStr], { type: "text/vtt" }));
}

/**
 * Fetches and parses a subtitle file directly client-side.
 * Handles both plain text (.vtt, .srt, .ass) and OpenSubtitles gzip (.gz) streams
 * using native browser DecompressionStream with zero server-side overhead.
 */
export async function fetchAndParseSub(
  downloadUrl: string,
  encoding = "utf-8"
): Promise<{ cues: SubtitleCue[]; vttUrl: string; blobUrl: string } | null> {
  if (!downloadUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(downloadUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const arrayBuffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    let text = "";
    // Check if gzipped (magic bytes 0x1f 0x8b)
    if (uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b) {
      if (typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("gzip");
        const blob = new Blob([uint8]);
        const decompressedStream = blob.stream().pipeThrough(ds);
        text = await new Response(decompressedStream).text();
      } else {
        const decoder = new TextDecoder(encoding || "utf-8");
        text = decoder.decode(uint8);
      }
    } else {
      const decoder = new TextDecoder(encoding || "utf-8");
      text = decoder.decode(uint8);
    }

    const isAss = /\[Script Info\]/i.test(text) || /^\s*Dialogue\s*:/im.test(text);
    // Replace promotions on VTT/SRT text; ASS handles promos per-Dialogue text inside parseASS
    if (!isAss) {
      text = replacePromotions(text);
    }

    const cues = parseSubtitles(text);
    if (!cues.length) return null;

    const vttUrl = cuesToWebVttBlobUrl(cues);
    return { cues, vttUrl, blobUrl: vttUrl };
  } catch (err) {
    clearTimeout(timer);
    console.warn("[Subtitles] Failed to fetch and parse client-side:", err);
    return null;
  }
}

export async function parseLocalFile(
  file: File,
): Promise<{ cues: SubtitleCue[]; vttUrl: string; label: string } | null> {
  try {
    const raw = await file.text();
    const cues = parseSubtitles(raw);
    if (!cues.length) return null;
    const vttUrl = cuesToWebVttBlobUrl(cues);
    return {
      cues,
      vttUrl,
      label: file.name.replace(/\.[a-z]+$/i, "").replace(/[._]/g, " ").slice(0, 48),
    };
  } catch {
    return null;
  }
}

/* ---------- Caption Styling Constants & Presets ---------- */

export const SUB_FONTS = [
  ["inherit", "Default"],
  ["Arial, Helvetica, sans-serif", "Sans-serif"],
  ['Georgia, "Times New Roman", serif', "Serif"],
  ['"Courier New", monospace', "Monospace"],
  ['"Trebuchet MS", system-ui, sans-serif', "Rounded"],
  ['"Comic Sans MS", "Comic Sans", cursive', "Casual"],
] as const;

export const SUB_EDGES = [
  ["none", "None"],
  ["shadow", "Drop shadow"],
  ["outline", "Outline"],
  ["raised", "Raised"],
  ["depressed", "Depressed"],
] as const;

export const EDGE_CSS: Record<string, string> = {
  none: "none",
  shadow: "0 2px 4px rgba(0,0,0,0.9)",
  outline: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000",
  raised: "1px 1px 0 rgba(0,0,0,0.9), 2px 2px 3px rgba(0,0,0,0.55)",
  depressed: "-1px -1px 0 rgba(0,0,0,0.9), 0 -1px 2px rgba(0,0,0,0.55)",
};

export interface SubStyleOptions {
  family: string;
  size: number; // 14 to 32 (px)
  color: string; // hex #ffffff
  textOpacity: number; // 0 to 100
  bgColor: string; // hex #000000
  bgOpacity: number; // 0 to 100
  edge: "none" | "shadow" | "outline" | "raised" | "depressed";
  position: number; // 10 to 92 (%)
}

export const SUB_STYLE_DEFAULT: SubStyleOptions = {
  family: "inherit",
  size: 20,
  color: "#ffffff",
  textOpacity: 100,
  bgColor: "#000000",
  bgOpacity: 75,
  edge: "none",
  position: 88,
};

const HEX = /^#[0-9a-f]{6}$/i;
export function hexToRgb(h: string): string {
  const clean = String(h || "").replace("#", "");
  const full =
    clean.length === 3
      ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
      : clean;
  const n = parseInt(full, 16);
  if (isNaN(n)) return "255,255,255";
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Cue background: a zero opacity means no box at all, not a see-through one. */
export function cueBackground(color: string, opacity: number): string {
  if (!(opacity > 0)) return "transparent";
  return cueColor(color, opacity);
}

export function cueColor(color: string, opacity: number): string {
  const c = typeof color === "string" && HEX.test(color) ? color.slice(1) : "ffffff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(100, Math.max(0, opacity)) / 100})`;
}

/* ---------- Local Persistence Helpers ---------- */

export const SUB_PREFS_KEY = "gibox:subtitlePrefs";
export const SUB_LANG_KEY = "gibox:sub-lang";

export function readSubPrefs(): SubStyleOptions {
  if (typeof window === "undefined") return SUB_STYLE_DEFAULT;
  try {
    const raw = localStorage.getItem(SUB_PREFS_KEY);
    if (!raw) return SUB_STYLE_DEFAULT;
    const parsed = JSON.parse(raw);
    return {
      family: parsed.family || SUB_STYLE_DEFAULT.family,
      size: typeof parsed.size === "number" ? parsed.size : SUB_STYLE_DEFAULT.size,
      color: typeof parsed.color === "string" && HEX.test(parsed.color) ? parsed.color : SUB_STYLE_DEFAULT.color,
      textOpacity: typeof parsed.textOpacity === "number" ? parsed.textOpacity : SUB_STYLE_DEFAULT.textOpacity,
      bgColor: typeof parsed.bgColor === "string" && HEX.test(parsed.bgColor) ? parsed.bgColor : SUB_STYLE_DEFAULT.bgColor,
      bgOpacity: typeof parsed.bgOpacity === "number" ? parsed.bgOpacity : SUB_STYLE_DEFAULT.bgOpacity,
      edge: parsed.edge || SUB_STYLE_DEFAULT.edge,
      position: typeof parsed.position === "number" ? parsed.position : SUB_STYLE_DEFAULT.position,
    };
  } catch {
    return SUB_STYLE_DEFAULT;
  }
}

export function writeSubPrefs(prefs: SubStyleOptions): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SUB_PREFS_KEY, JSON.stringify(prefs));
  } catch { }
}

export function subChoiceKey(mediaKey: string, season?: number, episode?: number) {
  return `gibox:sub:${mediaKey}:s${season ?? 0}e${episode ?? 0}`;
}

export function readSubChoice(key: string): { id: string; local?: boolean; lang?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id ? { id: parsed.id, local: parsed.local, lang: parsed.lang } : null;
  } catch {
    return null;
  }
}

export function writeSubChoice(key: string, track: { id: string; local?: boolean; lang?: string } | null) {
  if (typeof window === "undefined") return;
  try {
    if (track) localStorage.setItem(key, JSON.stringify(track));
    else localStorage.removeItem(key);
  } catch { }
}

export const SUB_OFFSET_STEP = 0.25;
export const SUB_OFFSET_MAX = 10;

export function subOffsetKey(mediaKey: string, season?: number, episode?: number) {
  return `gibox:suboff:${mediaKey}:s${season ?? 0}e${episode ?? 0}`;
}

export function readSubOffset(key: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const value = Number(localStorage.getItem(key));
    if (!Number.isFinite(value)) return 0;
    return Math.max(-SUB_OFFSET_MAX, Math.min(SUB_OFFSET_MAX, Math.round(value * 100) / 100));
  } catch {
    return 0;
  }
}

export function writeSubOffset(key: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(key, String(value));
    else localStorage.removeItem(key);
  } catch { }
}

export function fmtOffset(value: number): string {
  const rounded = Math.round((value || 0) * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded}s`;
}

export function readSubLang(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(SUB_LANG_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeSubLang(value: string) {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(SUB_LANG_KEY, value);
    else localStorage.removeItem(SUB_LANG_KEY);
  } catch { }
}
