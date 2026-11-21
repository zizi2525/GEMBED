/**
 * Frontend-side HLS audio discovery.
 *
 * hls.js only exposes `audioTracks` after the master playlist has been parsed
 * by the player, which leaves the UI with nothing to show while the stream is
 * connecting and with no language list at all for clients that never surface
 * alternate audio. Parsing the master playlist ourselves gives the available
 * audio languages (and their manifest order, which matches hls.js track ids)
 * immediately, straight from `#EXT-X-MEDIA:TYPE=AUDIO` tags.
 */

export interface AudioRendition {
  /** Position in the manifest; matches hls.js `audioTracks` index. */
  id: number;
  name: string;
  lang: string;
  isDefault: boolean;
}

const ATTR_RE = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(line))) {
    const raw = match[2];
    attrs[match[1].toUpperCase()] = raw.startsWith('"')
      ? raw.slice(1, -1)
      : raw.trim();
  }
  return attrs;
}

/** Removes playlist numbering such as `1. English` or `2 - Hindi`. */
function cleanRenditionName(name: string, lang = ""): string {
  const cleaned = (name || "")
    .replace(/^\s*\d+\s*[.)\-:]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return cleaned;
  return lang ? lang.toUpperCase() : "Audio";
}

/** Language code from a rendition, normalized to a 2/3 letter code. */
function renditionLang(attrs: Record<string, string>): string {
  return (attrs.LANGUAGE || attrs["ASSOC-LANGUAGE"] || "").trim().toLowerCase();
}

/**
 * Extracts audio renditions from an HLS master playlist.
 * Returns [] for media playlists (no `#EXT-X-MEDIA` audio entries).
 */
export function parseAudioRenditions(manifest: string): AudioRendition[] {
  if (!/#EXTM3U/i.test(manifest || "")) return [];

  const lines = manifest.split(/\r?\n/);

  // Only groups that a variant actually references are playable.
  const usedGroups = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const group = parseAttributes(line).AUDIO;
    if (group) usedGroups.add(group);
  }

  const out: AudioRendition[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!/^#EXT-X-MEDIA:/i.test(line)) continue;
    const attrs = parseAttributes(line);
    if ((attrs.TYPE || "").toUpperCase() !== "AUDIO") continue;
    const group = attrs["GROUP-ID"] || "";
    if (usedGroups.size > 0 && group && !usedGroups.has(group)) continue;

    const lang = renditionLang(attrs);
    out.push({
      id: out.length,
      name: cleanRenditionName(attrs.NAME || "", lang),
      lang,
      isDefault: (attrs.DEFAULT || "").toUpperCase() === "YES",
    });
  }

  return out;
}

/**
 * Fetches a stream URL and returns the audio renditions it advertises.
 * Never throws: a CORS/network failure simply yields no extra information and
 * the player falls back to whatever hls.js reports.
 */
export async function discoverAudioRenditions(
  url: string,
  signal?: AbortSignal
): Promise<AudioRendition[]> {
  if (!url) return [];
  try {
    const res = await fetch(url, {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*" },
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseAudioRenditions(text);
  } catch {
    return [];
  }
}
