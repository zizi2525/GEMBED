const crypto = require('crypto');
const { getDetails } = require('../utils/tmdb');
const { getFetchOptions } = require('../utils/extractorProxy');

const CASTLE_BASE = 'https://api.hlowb.com';
const PKG = 'com.external.castle';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en-US';
const SUFFIX = 'T!BgJB';
const APK_SIGN_KEY = 'ED0955EB04E67A1D9F3305B95454FED485261475';

const WORKING_HEADERS = {
  'User-Agent': 'okhttp/4.9.3',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'Keep-Alive',
  Referer: CASTLE_BASE,
};

// Headers the stream host expects for direct playback
const CASTLE_PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  Connection: 'keep-alive',
  'Sec-Fetch-Dest': 'video',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site',
  DNT: '1',
};

const QUALITY_MAP = { 1: '480p', 2: '720p', 3: '1080p' };

// Castle ids (movieId/episodeId/id) are 16+ digit integers that overflow JS safe integers.
// Quote integer literals with 16+ digits so they survive JSON.parse.
function safeJsonParse(text) {
  const safe = text.replace(/:(\s*)(-?\d{16,})(\s*[,}\]])/g, ':$1"$2"$3');
  return JSON.parse(safe);
}

// AES-128-CBC key derivation: base64 key + fixed suffix, truncated/padded to 16 bytes
function deriveKey(apiKeyB64) {
  const apiKeyBytes = Buffer.from(apiKeyB64, 'base64');
  let keyMaterial = Buffer.concat([apiKeyBytes, Buffer.from(SUFFIX, 'ascii')]);
  if (keyMaterial.length < 16) {
    keyMaterial = Buffer.concat([keyMaterial, Buffer.alloc(16 - keyMaterial.length)]);
  } else if (keyMaterial.length > 16) {
    keyMaterial = keyMaterial.subarray(0, 16);
  }
  return keyMaterial;
}

function decryptCastle(encryptedB64, securityKeyB64) {
  const aesKey = deriveKey(securityKeyB64);
  const iv = aesKey; // key doubles as IV
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

async function requestCastle(url, init = {}) {
  const proxyOpts = getFetchOptions('castle', {
    ...init,
    headers: { ...WORKING_HEADERS, ...(init.headers || {}) }
  });
  const res = await fetch(url, proxyOpts);
  if (!res.ok) throw new Error(`Castle request failed ${res.status} for ${url}`);
  return res;
}

async function extractCipher(response) {
  const text = (await response.text()).trim();
  if (!text) throw new Error('Empty response from Castle API');
  try {
    const j = JSON.parse(text);
    if (j && typeof j.data === 'string') return j.data.trim();
  } catch {
    /* raw cipher */
  }
  return text;
}

async function decryptedJson(response, securityKey) {
  const cipher = await extractCipher(response);
  return safeJsonParse(decryptCastle(cipher, securityKey));
}

let cachedSecurityKey = null;
let securityKeyFetchedAt = 0;
const SECURITY_KEY_TTL = 30 * 60 * 1000; // 30 minutes

async function getSecurityKey() {
  if (cachedSecurityKey && Date.now() - securityKeyFetchedAt < SECURITY_KEY_TTL) {
    return cachedSecurityKey;
  }
  const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
  const r = await requestCastle(url);
  const data = await r.json();
  if (data.code !== 200 || !data.data) {
    throw new Error(`Security key API error: ${JSON.stringify(data)}`);
  }
  cachedSecurityKey = data.data;
  securityKeyFetchedAt = Date.now();
  return cachedSecurityKey;
}

async function searchCastle(securityKey, keyword, page = 1, size = 30) {
  const params = new URLSearchParams({
    channel: CHANNEL,
    clientType: CLIENT,
    keyword,
    lang: LANG,
    mode: '1',
    packageName: PKG,
    page: String(page),
    size: String(size),
  });
  const url = `${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`;
  return decryptedJson(await requestCastle(url), securityKey);
}

async function getDetailsCastle(securityKey, movieId) {
  const url = `${CASTLE_BASE}/film-api/v1.1/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
  return decryptedJson(await requestCastle(url), securityKey);
}

async function getVideoV1(securityKey, movieId, episodeId, languageId, resolution = 2) {
  const params = new URLSearchParams({
    apkSignKey: APK_SIGN_KEY,
    channel: CHANNEL,
    clientType: CLIENT,
    episodeId: String(episodeId),
    lang: LANG,
    languageId: String(languageId),
    mode: '1',
    movieId: String(movieId),
    packageName: PKG,
    resolution: String(resolution),
  });
  const url = `${CASTLE_BASE}/film-api/v1.9.1/movie/getVideo?${params.toString()}`;
  return decryptedJson(await requestCastle(url), securityKey);
}

async function getVideo2(securityKey, movieId, episodeId, resolution = 2, languageId = null) {
  const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
  const body = {
    mode: '1',
    appMarket: 'GuanWang',
    clientType: '1',
    woolUser: 'false',
    apkSignKey: APK_SIGN_KEY,
    androidVersion: '13',
    movieId: String(movieId),
    episodeId: String(episodeId),
    ...(languageId ? { languageId: String(languageId) } : {}),
    isNewUser: 'true',
    resolution: String(resolution),
    packageName: PKG,
  };
  const r = await requestCastle(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return decryptedJson(r, securityKey);
}

function extractDataBlock(obj) {
  if (obj && typeof obj.data === 'object' && obj.data) return obj.data;
  return obj && typeof obj === 'object' ? obj : {};
}

function qualityValue(quality) {
  if (!quality) return 0;
  let q = String(quality).toLowerCase();
  q = q.replace(/^(sd|hd|fhd|uhd|4k)\s*/, '').replace(/p$/, '').trim();
  if (q === '4k' || q === '2160') return 2160;
  const known = [1440, 1080, 720, 480, 360, 240];
  const n = parseInt(q, 10);
  if (known.includes(n)) return n;
  return n > 0 ? n : 0;
}

function formatSize(size) {
  if (typeof size === 'number' && size > 0) {
    return size > 1_000_000_000
      ? `${(size / 1_000_000_000).toFixed(2)} GB`
      : `${Math.round(size / 1_000_000)} MB`;
  }
  return 'Unknown';
}

function normalizeCastleTitle(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRowYear(item) {
  const raw = item?.year ?? item?.publishTime ?? item?.releaseYear;
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  if (num > 1900 && num < 2100) return Math.round(num);
  if (num > 1e11) return new Date(num).getUTCFullYear();
  if (num > 1e8) return new Date(num * 1000).getUTCFullYear();
  return null;
}

function findMovieId(searchResult, tmdbTitle, targetYear = null, isTv = false) {
  const data = extractDataBlock(searchResult);
  const rows = data.rows || [];
  if (!rows.length) return null;

  const wantNorm = normalizeCastleTitle(tmdbTitle);
  const wantType = isTv ? 1 : 2; // Castle: 1 = TV series, 2 = Movie
  let bestId = null;
  let bestScore = -1;

  for (const item of rows) {
    const rawTitle = String(item.title || item.name || '');
    const itemNorm = normalizeCastleTitle(rawTitle);
    if (!itemNorm || !wantNorm) continue;

    let score = 0;
    if (itemNorm === wantNorm) {
      score += 100;
    } else if (
      itemNorm.startsWith(wantNorm + ' ') &&
      !/\b(part|season|encore|special|remake)\b/i.test(itemNorm.slice(wantNorm.length))
    ) {
      score += 40;
    } else {
      // Do not match unrelated titles (e.g. "Dune" vs "Dune: Part Two" or "Breaking" vs "Breaking Bad")
      continue;
    }

    const rowType = Number(item.movieType ?? item.type);
    if (rowType === wantType) {
      score += 40;
    } else if (rowType === 1 || rowType === 2) {
      score -= 60;
    }

    const rowYear = extractRowYear(item);
    if (targetYear && rowYear) {
      const diff = Math.abs(rowYear - targetYear);
      if (diff === 0) score += 30;
      else if (diff === 1) score += 15;
      else score -= 35;
    }

    const id = item.id || item.redirectId || item.redirectIdStr;
    if (id && score > bestScore) {
      bestScore = score;
      bestId = String(id);
    }
  }

  return bestScore >= 60 ? bestId : null;
}

function formatCastleSubtitles(rawSubs) {
  if (!Array.isArray(rawSubs)) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rawSubs.length; i++) {
    const s = rawSubs[i];
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({
      id: `castle-sub-${s.abbreviate || 'cc'}-${i}`,
      url: s.url,
      lang: (s.abbreviate || 'en').toLowerCase(),
      label: s.title || s.abbreviate || 'Subtitles',
      default: Boolean(s.isDefault),
    });
  }
  return out;
}

function processVideoResponse(videoData, mediaTitle, resolution, trackInfo = {}) {
  const streams = [];
  const data = extractDataBlock(videoData);
  const videoUrl = data.videoUrl;
  if (!videoUrl) return streams;

  const quality = QUALITY_MAP[resolution] || `${resolution}p`;
  const langLabel = trackInfo.langLabel || 'Original';
  const langCode = trackInfo.langCode || 'en';
  const version = trackInfo.version || 'vo';
  const subtitles = formatCastleSubtitles(data.subtitles);

  const name = `Castle · ${quality} · ${langLabel}`;
  streams.push({
    name,
    title: mediaTitle,
    url: videoUrl,
    quality,
    lang: langCode,
    langLabel,
    version,
    subtitles: subtitles.length ? subtitles : undefined,
    size: formatSize(data.size),
    languageInfo: langLabel,
  });
  return streams;
}

async function getCastleStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  console.log(`[Castle] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}, Season: ${seasonNum}, Episode: ${episodeNum}`);
  try {
    const tmdbType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
    const isTv = tmdbType === 'tv' && seasonNum && episodeNum;

    // Fetch TMDB metadata
    const tmdb = await getDetails(tmdbType, tmdbId);
    if (!tmdb) {
      console.warn('[Castle] Failed to fetch TMDB details');
      return [];
    }

    const title = tmdb.name || tmdb.title;
    const releaseDate = tmdb.first_air_date || tmdb.release_date;
    const year = releaseDate ? parseInt(releaseDate.split('-')[0], 10) : null;

    let mediaTitle = title || 'Unknown';
    if (year) mediaTitle += ` (${year})`;
    if (isTv) {
      mediaTitle = `${title} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
    }

    const securityKey = await getSecurityKey();

    console.log(`[Castle] Searching for "${title}" (${year || 'n/a'}, ${isTv ? 'tv' : 'movie'})...`);
    const searchResult = await searchCastle(securityKey, title);
    let movieId = findMovieId(searchResult, title, year, isTv);
    if (!movieId && year) {
      const retryResult = await searchCastle(securityKey, `${title} ${year}`);
      movieId = findMovieId(retryResult, title, year, isTv);
    }
    if (!movieId) {
      console.warn(`[Castle] No matching ${isTv ? 'series' : 'movie'} found for "${title}" (${year || ''})`);
      return [];
    }
    console.log(`[Castle] Found movieId: ${movieId}`);

    let details = await getDetailsCastle(securityKey, movieId);

    if (isTv) {
      const data = extractDataBlock(details);
      const seasons = data.seasons || [];
      const s = seasons.find((x) => x.number === Number(seasonNum));
      if (s && s.movieId && String(s.movieId) !== movieId) {
        movieId = String(s.movieId);
        details = await getDetailsCastle(securityKey, movieId);
      }
    }

    const data = extractDataBlock(details);
    const episodes = data.episodes || [];

    let episodeId = null;
    if (isTv) {
      const ep = episodes.find((e) => e.number === Number(episodeNum));
      if (ep && ep.id) episodeId = String(ep.id);
    } else if (episodes.length) {
      episodeId = String(episodes[0].id);
    }
    if (!episodeId) {
      console.warn('[Castle] Could not find episode ID');
      return [];
    }

    const epObj = episodes.find((e) => String(e.id) === episodeId);
    const tracks = Array.isArray(epObj?.tracks) ? epObj.tracks : [];

    const resolution = 2; // 720p base (free tier without VIP restriction)
    const origLang = (tmdb.original_language || 'en').toLowerCase();
    let rawStreams = [];

    if (tracks.length > 0) {
      // Fetch all available audio language tracks in parallel via getVideo2(languageId)
      const trackResults = await Promise.all(
        tracks.map(async (track, i) => {
          const langCode = String(track.abbreviate || '').toLowerCase() || 'en';
          const langName = track.languageName || langCode.toUpperCase() || `Lang${i + 1}`;
          const isOrig = langCode === origLang || langCode === 'ost';
          try {
            const videoData = await getVideo2(
              securityKey,
              movieId,
              episodeId,
              resolution,
              track.languageId ? String(track.languageId) : null
            );
            return processVideoResponse(videoData, mediaTitle, resolution, {
              langCode: langCode === 'ost' ? origLang : langCode,
              langLabel: isOrig ? `${langName} (Original)` : `${langName} (Dub)`,
              version: isOrig ? 'vo' : 'dub',
            });
          } catch (e) {
            console.warn(`[Castle] ${langName}: getVideo2 failed - ${e.message}`);
            return [];
          }
        })
      );
      rawStreams = trackResults.flat();
    }

    // Fallback to default shared video2 if no tracks list was present
    if (!rawStreams.length) {
      const videoData = await getVideo2(securityKey, movieId, episodeId, resolution);
      rawStreams = processVideoResponse(videoData, mediaTitle, resolution, {
        langCode: origLang,
        langLabel: 'Original',
        version: 'vo',
      });
    }

    // Group by URL so shared multi-audio HLS streams (e.g. Hindi + English) are labeled Multi-Audio
    const byUrl = new Map();
    for (const s of rawStreams) {
      const existing = byUrl.get(s.url);
      if (!existing) {
        byUrl.set(s.url, { ...s, _langs: [s.langLabel] });
      } else {
        if (!existing._langs.includes(s.langLabel)) existing._langs.push(s.langLabel);
        existing.lang = 'mul';
        existing.langLabel = 'Multi-Audio';
        existing.version = 'multi';
        existing.name = `Castle · ${existing.quality} · Multi-Audio`;
      }
    }
    const deduped = Array.from(byUrl.values());
    deduped.sort((a, b) => qualityValue(b.quality) - qualityValue(a.quality));

    const streams = [];
    for (let i = 0; i < deduped.length; i++) {
      const s = deduped[i];
      const isHls = s.url.includes('.m3u8');
      const isDash = s.url.includes('.mpd');
      const streamType = isHls ? 'm3u8' : (isDash ? 'dash' : 'mp4');

      streams.push({
        id: `castle-${s.lang}-${s.quality}-${i}`,
        name: s.name,
        title: s.title,
        url: s.url,
        quality: s.quality,
        qualityLabel: s.quality,
        lang: s.lang,
        langLabel: s.langLabel,
        version: s.version,
        subtitles: s.subtitles,
        provider: 'Castle',
        server: 'Castle',
        serverName: 'Castle',
        type: streamType,
        size: s.size,
        headers: CASTLE_PLAYBACK_HEADERS
      });
    }

    console.log(`[Castle] Returning ${streams.length} streams`);
    return streams;
  } catch (err) {
    console.error(`[Castle] Error: ${err.message}`);
    return [];
  }
}

module.exports = {
  getCastleStreams,
  CASTLE_PLAYBACK_HEADERS
};
