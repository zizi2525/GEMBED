/**
 * MegaPlay (megaplay.buzz) anime stream resolver — SERVER ONLY.
 *
 * Resolves direct 1080p HLS master playlists (.m3u8) with subtitles
 * and intro/outro timestamps for anime keyed by AniList ID and episode number.
 *
 * Implements AES-256-CBC source decryption and HMAC-SHA-256 CDN token signing.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDetails } = require('../utils/tmdb');
const { getFetchOptions } = require('../utils/extractorProxy');
const { config } = require('../utils/config');

const SOURCE_ENC_KEY = 'i?LMTAx0Q6,:}50U';
const SOURCE_ENC_IV = "W0;27ToaUpl_P%'c";
const CDN_TOKEN_SECRET = 'MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s';
const RESOLVE_TTL = 3 * 60 * 1000; // 3 minutes for signed CDN URLs
const TIMEOUT = 10000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAP_FILE = path.join(__dirname, '..', 'data', 'megaplay_map.json');

// Persistent cache for AniList ID mappings and stream metadata
function loadMap() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[MegaPlay] Failed to read map file:', e.message);
  }
  return {};
}

function saveMap(map) {
  try {
    const dir = path.dirname(MAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.warn('[MegaPlay] Failed to write map file:', e.message);
  }
}

// In-memory cache for resolved stream objects
const memoryCache = new Map();

function padKeyBytes(str, len) {
  const buf = Buffer.alloc(len, 0);
  const strBuf = Buffer.from(str, 'utf8');
  strBuf.copy(buf, 0, 0, Math.min(len, strBuf.length));
  return buf;
}

function b64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function b64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decryptSourcesEnc(enc) {
  const key = padKeyBytes(SOURCE_ENC_KEY, 32);
  const iv = padKeyBytes(SOURCE_ENC_IV, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(b64UrlDecode(enc)), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function createCdnToken(pathKey) {
  const exp = Math.floor(Date.now() / 1000) + 90;
  const data = `${exp}|${pathKey}`;
  const hmac = crypto
    .createHmac('sha256', Buffer.from(CDN_TOKEN_SECRET, 'utf8'))
    .update(Buffer.from(data, 'utf8'))
    .digest();
  return `${b64Url(Buffer.from(data, 'utf8'))}.${b64Url(hmac)}`;
}

function extractCdnPathKey(url) {
  const m = String(url).match(/\/([a-f0-9]{32})\/([a-f0-9]{32})\//i);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

function isExtractorEnabled() {
  return config.enableMegaplayProvider !== false;
}

/**
 * Normalizes subtitle language names to 2/3 letter language codes.
 */
function normalizeSubLang(label = '') {
  const lower = label.toLowerCase();
  if (lower.includes('english') || lower.startsWith('eng')) return 'en';
  if (lower.includes('portuguese') || lower.startsWith('por')) return 'pt';
  if (lower.includes('spanish') || lower.startsWith('spa')) return 'es';
  if (lower.includes('french') || lower.startsWith('fre') || lower.startsWith('fra')) return 'fr';
  if (lower.includes('arabic') || lower.startsWith('ara')) return 'ar';
  if (lower.includes('german') || lower.startsWith('ger') || lower.startsWith('deu')) return 'de';
  if (lower.includes('italian') || lower.startsWith('ita')) return 'it';
  if (lower.includes('russian') || lower.startsWith('rus')) return 'ru';
  return lower.slice(0, 3) || 'en';
}

/**
 * Core MegaPlay stream resolver function matching user signature.
 */
async function resolveMegaplay(input = {}) {
  if (!isExtractorEnabled()) {
    return null;
  }

  const { anilistId, malId, episode = 1, type = 'sub' } = input;
  if ((!anilistId || anilistId <= 0) && (!malId || malId <= 0)) return null;

  const cacheKey = `${anilistId ?? 'm' + malId}:${episode}:${type}`;
  const hit = memoryCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RESOLVE_TTL && Date.now() < hit.expiresAt - 30000) {
    return hit.value;
  }

  try {
    const candidateUrls = [];
    if (anilistId && anilistId > 0) {
      candidateUrls.push(`https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${type}`);
    }
    if (malId && malId > 0) {
      candidateUrls.push(`https://megaplay.buzz/stream/mal/${malId}/${episode}/${type}`);
    }

    let episodeId = null;
    let successfulEmbedUrl = candidateUrls[0];

    for (const embedUrl of candidateUrls) {
      const fetchOpts = getFetchOptions('megaplay', {
        headers: {
          'User-Agent': UA,
          Referer: 'https://megaplay.buzz/',
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      const pageRes = await fetch(embedUrl, fetchOpts).catch(() => null);
      if (!pageRes || !pageRes.ok) continue;

      const html = await pageRes.text();
      const idMatch =
        html.match(/id=["']megaplay-player["'][^>]*data-id=["'](\d+)["']/i) ||
        html.match(/data-id=["'](\d+)["'][^>]*id=["']megaplay-player["']/i);

      if (idMatch) {
        episodeId = idMatch[1];
        successfulEmbedUrl = embedUrl;
        break;
      }
    }

    if (!episodeId) return null;

    const getSourcesUrl = `https://megaplay.buzz/stream/getSources?id=${encodeURIComponent(
      episodeId
    )}&platform=OTHER&st=other`;

    const sourcesOpts = getFetchOptions('megaplay', {
      headers: {
        'User-Agent': UA,
        Referer: successfulEmbedUrl,
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const sourcesRes = await fetch(getSourcesUrl, sourcesOpts);
    if (!sourcesRes.ok) return null;

    const sourcesJson = await sourcesRes.json();
    let rawFile = '';
    if (sourcesJson.enc) {
      const dec = decryptSourcesEnc(sourcesJson.enc);
      rawFile = dec.file;
    } else if (sourcesJson.sources && sourcesJson.sources[0]) {
      rawFile = sourcesJson.sources[0].file;
    }

    if (!rawFile) return null;

    let finalUrl = rawFile;
    if (/\/master\.m3u8(?:\?|$)/i.test(finalUrl) && !/[?&]t=/.test(finalUrl)) {
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + `t=${type}`;
    }

    const pathKey = extractCdnPathKey(finalUrl);
    if (pathKey) {
      const token = createCdnToken(pathKey);
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
    }

    const result = {
      url: finalUrl,
      title: `${type === 'dub' ? 'English Dub' : 'VO (Japanese Sub)'} · 1080p`,
      type,
      tracks: sourcesJson.tracks || [],
      intro: sourcesJson.intro || null,
      outro: sourcesJson.outro || null,
    };

    memoryCache.set(cacheKey, {
      at: Date.now(),
      expiresAt: Date.now() + RESOLVE_TTL,
      value: result,
    });

    return result;
  } catch (err) {
    console.warn('[MegaPlay] Resolver error:', err.message);
    return null;
  }
}

/**
 * Queries the ani.zip cross-platform mapping service.
 * URL: https://api.ani.zip/mappings?themoviedb_id=... or anilist_id=...
 */
async function fetchAniZipMappings(param, value) {
  if (!value) return null;
  try {
    const fetchOpts = getFetchOptions('megaplay', {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const url = `https://api.ani.zip/mappings?${param}=${encodeURIComponent(value)}`;
    const res = await fetch(url, fetchOpts);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.mappings) return null;
    return {
      anilistId: data.mappings.anilist_id ? Number(data.mappings.anilist_id) : null,
      malId: data.mappings.mal_id ? Number(data.mappings.mal_id) : null,
      title: data.titles?.en || data.titles?.['x-jat'] || data.titles?.ja || null,
      mappings: data.mappings,
      episodes: data.episodes || {},
    };
  } catch (err) {
    console.warn(`[MegaPlay] ani.zip lookup error for ${param}=${value}:`, err.message);
    return null;
  }
}

/**
 * Searches AniList for anime by title and season number.
 */
async function findAniListMedia(title, season = 1, year = null) {
  if (!title) return null;

  const searchQueries = [];
  if (season > 1) {
    searchQueries.push(`${title} Season ${season}`);
    searchQueries.push(`${title} S${season}`);
    searchQueries.push(`${title} ${season}`);
  }
  searchQueries.push(title);

  const gql = `
    query ($search: String) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          format
          episodes
          seasonYear
        }
      }
    }
  `;

  for (const q of searchQueries) {
    try {
      const fetchOpts = getFetchOptions('megaplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: gql, variables: { search: q } }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      const res = await fetch('https://graphql.anilist.co', fetchOpts);
      if (!res.ok) continue;

      const data = await res.json();
      const list = data?.data?.Page?.media || [];
      if (!list.length) continue;

      if (season > 1) {
        const match = list.find((m) => {
          const t = `${m.title?.english || ''} ${m.title?.romaji || ''}`.toLowerCase();
          return (
            t.includes(`season ${season}`) ||
            t.includes(`s${season}`) ||
            (season === 2 && (t.includes('2nd season') || t.includes('season 2'))) ||
            (season === 3 && (t.includes('3rd season') || t.includes('season 3'))) ||
            (season === 4 &&
              (t.includes('the final season') || t.includes('final season') || t.includes('season 4')))
          );
        });
        if (match) return match;
      } else {
        const first = list.find((m) => {
          const t = `${m.title?.english || ''} ${m.title?.romaji || ''}`.toLowerCase();
          return (
            !t.includes('season 2') &&
            !t.includes('season 3') &&
            !t.includes('season 4') &&
            !t.includes('final season') &&
            !t.includes('part 2') &&
            (m.format === 'TV' || m.format === 'ONA' || m.format === 'MOVIE')
          );
        });
        if (first) return first;
      }

      if (list[0]) return list[0];
    } catch (e) {
      console.warn(`[MegaPlay] AniList lookup error for query "${q}":`, e.message);
    }
  }

  return null;
}

/**
 * Standard provider interface for Embed-Gibox / VidSuper.
 * Invoked by registry.js for aggregate and provider-specific calls.
 */
async function getMegaplayStreams(
  tmdbId,
  mediaType = 'tv',
  season = 1,
  episode = 1,
  requestedLang = null,
  clientGeo = null,
  ctx = {}
) {
  if (!isExtractorEnabled()) {
    return [];
  }

  const isTv = mediaType === 'tv' || mediaType === 'series';
  const seasonNum = isTv ? Number(season || 1) : 0;
  const epNum = isTv ? Number(episode || 1) : 1;
  const mapKey = isTv ? `tv:${tmdbId}:s${seasonNum}` : `movie:${tmdbId}`;

  let anilistId = ctx.anilistId ? Number(ctx.anilistId) : null;
  let malId = ctx.malId ? Number(ctx.malId) : null;

  // Enrich missing malId if anilistId was provided directly
  if (anilistId && !malId) {
    const sZip = await fetchAniZipMappings('anilist_id', anilistId);
    if (sZip?.malId) malId = sZip.malId;
  }

  // 1. Check persistent map cache for existing mapping
  const map = loadMap();
  const mapEntry = map[mapKey];

  if (!anilistId && !malId) {
    if (mapEntry?.anilistId) {
      anilistId = mapEntry.anilistId;
      malId = mapEntry.malId || null;
    } else {
      // 2. Primary Mapping: Use api.ani.zip with themoviedb_id
      try {
        const aniZip = await fetchAniZipMappings('themoviedb_id', tmdbId);
        if (aniZip && (aniZip.anilistId || aniZip.malId)) {
          if (!isTv || seasonNum <= 1) {
            anilistId = aniZip.anilistId;
            malId = aniZip.malId;
            map[mapKey] = {
              title: aniZip.title,
              anilistId,
              malId,
              season: seasonNum,
              source: 'ani.zip',
              mappedAt: Date.now(),
            };
            saveMap(map);
          } else {
            // For seasons > 1: Use canonical title from ani.zip to search AniList for exact season
            const searchTitle = aniZip.title;
            const matchedMedia = await findAniListMedia(searchTitle, seasonNum);
            if (matchedMedia) {
              anilistId = matchedMedia.id;
              malId = matchedMedia.idMal || null;

              if (anilistId && !malId) {
                const sZip = await fetchAniZipMappings('anilist_id', anilistId);
                if (sZip?.malId) malId = sZip.malId;
              }

              map[mapKey] = {
                title: matchedMedia.title?.english || matchedMedia.title?.romaji || searchTitle,
                anilistId,
                malId,
                season: seasonNum,
                source: 'ani.zip+anilist',
                mappedAt: Date.now(),
              };
              saveMap(map);
            }
          }
        }
      } catch (err) {
        console.warn(`[MegaPlay] ani.zip lookup failed for ${mapKey}:`, err.message);
      }

      // 3. Fallback: If ani.zip did not match, fetch TMDB details & query AniList directly
      if (!anilistId && !malId) {
        try {
          const tmdbDetails = await getDetails(isTv ? 'tv' : 'movie', tmdbId);
          if (tmdbDetails) {
            const isAnime =
              tmdbDetails.original_language === 'ja' ||
              (Array.isArray(tmdbDetails.origin_country) && tmdbDetails.origin_country.includes('JP')) ||
              (Array.isArray(tmdbDetails.genres) && tmdbDetails.genres.some((g) => g.id === 16));

            // If confirmed not anime, exit quickly
            if (!isAnime && !ctx.forceAnime) {
              return [];
            }

            const title = tmdbDetails.name || tmdbDetails.title || tmdbDetails.original_name;
            const matchedMedia = await findAniListMedia(title, seasonNum);
            if (matchedMedia) {
              anilistId = matchedMedia.id;
              malId = matchedMedia.idMal || null;

              if (anilistId && !malId) {
                const sZip = await fetchAniZipMappings('anilist_id', anilistId);
                if (sZip?.malId) malId = sZip.malId;
              }

              map[mapKey] = {
                title,
                anilistId,
                malId,
                season: seasonNum,
                source: 'anilist',
                mappedAt: Date.now(),
              };
              saveMap(map);
            }
          }
        } catch (err) {
          console.warn(`[MegaPlay] Fallback TMDB lookup failed for ${mapKey}:`, err.message);
        }
      }
    }
  }

  // 4. Fallback: if caller passed an AniList ID directly in tmdbId
  if (!anilistId && !malId && Number(tmdbId) > 0) {
    anilistId = Number(tmdbId);
  }

  if (!anilistId && !malId) {
    return [];
  }

  // 4. Determine types to fetch: sub (VO), dub, or both
  const subType = ctx.subType || (requestedLang === 'en' ? 'dub' : null);
  const typesToFetch = subType ? [subType] : ['sub', 'dub'];

  const results = await Promise.all(
    typesToFetch.map((t) =>
      resolveMegaplay({
        anilistId,
        malId,
        episode: epNum,
        type: t,
      })
    )
  );

  const streams = [];

  for (let idx = 0; idx < results.length; idx++) {
    const res = results[idx];
    if (!res || !res.url) continue;

    const isDub = res.type === 'dub';
    const langCode = isDub ? 'en' : 'ja';
    const langLabel = isDub ? 'English (Dub)' : 'Japanese (Sub)';

    // Separate subtitles from thumbnails
    const formattedSubtitles = [];
    let thumbnailTrack = null;

    if (Array.isArray(res.tracks)) {
      for (let sIdx = 0; sIdx < res.tracks.length; sIdx++) {
        const tr = res.tracks[sIdx];
        if (!tr || !tr.file) continue;

        if (tr.kind === 'thumbnails' || tr.file.includes('thumbnails.vtt')) {
          thumbnailTrack = tr.file;
        } else {
          const subLang = normalizeSubLang(tr.label || 'English');
          formattedSubtitles.push({
            id: `mega-sub-${subLang}-${sIdx}`,
            url: tr.file,
            lang: subLang,
            label: tr.label || 'English',
            default: !!tr.default,
          });
        }
      }
    }

    streams.push({
      id: `megaplay-${res.type}-1080-${idx}`,
      name: `MegaPlay · 1080p · ${langLabel}`,
      title: `MegaPlay · 1080p · ${langLabel}`,
      url: res.url,
      quality: '1080p',
      qualityLabel: '1080p',
      lang: langCode,
      langLabel,
      version: isDub ? 'dub' : 'sub',
      provider: 'MegaPlay',
      server: 'MegaPlay',
      serverName: 'MegaPlay',
      type: 'm3u8',
      direct: true,
      subtitles: formattedSubtitles,
      intro: res.intro || null,
      outro: res.outro || null,
      ...(thumbnailTrack ? { thumbnails: thumbnailTrack } : {}),
      headers: {
        'User-Agent': UA,
        Referer: 'https://megaplay.buzz/',
      },
    });
  }

  // If a specific language was requested, sort it first
  if (requestedLang && streams.length > 1) {
    const target = requestedLang.toLowerCase();
    streams.sort((a, b) => {
      const matchA = a.lang === target || (target === 'en' && a.version === 'dub') ? 1 : 0;
      const matchB = b.lang === target || (target === 'en' && b.version === 'dub') ? 1 : 0;
      return matchB - matchA;
    });
  }

  return streams;
}

module.exports = {
  getMegaplayStreams,
  resolveMegaplay,
  decryptSourcesEnc,
  createCdnToken,
  extractCdnPathKey,
  findAniListMedia,
  fetchAniZipMappings,
};
