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

async function getVideo2(securityKey, movieId, episodeId, resolution = 2) {
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

function findMovieId(searchResult, tmdbTitle) {
  const data = extractDataBlock(searchResult);
  const rows = data.rows || [];
  if (!rows.length) throw new Error('No search results found');
  const searchLower = (tmdbTitle || '').toLowerCase();

  for (const item of rows) {
    const itemTitle = String(item.title || item.name || '').toLowerCase();
    if (itemTitle && (itemTitle.includes(searchLower) || searchLower.includes(itemTitle))) {
      const id = item.id || item.redirectId || item.redirectIdStr;
      if (id) return String(id);
    }
  }
  const first = rows[0];
  const id = first.id || first.redirectId || first.redirectIdStr;
  if (id) return String(id);
  throw new Error('Could not extract movie ID from search results');
}

function processVideoResponse(videoData, mediaTitle, resolution, languageInfo) {
  const streams = [];
  const data = extractDataBlock(videoData);
  const videoUrl = data.videoUrl;
  if (!videoUrl) return streams;

  const quality = QUALITY_MAP[resolution] || `${resolution}p`;

  if (Array.isArray(data.videos) && data.videos.length > 0) {
    for (const video of data.videos) {
      const q = String(video.resolutionDescription || video.resolution || quality).replace(/^(SD|HD|FHD)\s+/i, '');
      const name = languageInfo ? `Castle · ${q} · ${languageInfo}` : `Castle · ${q}`;
      streams.push({
        name,
        title: mediaTitle,
        url: video.url || videoUrl,
        quality: q,
        size: formatSize(video.size || data.size),
        languageInfo: languageInfo || 'Shared'
      });
    }
  } else {
    const name = languageInfo ? `Castle · ${quality} · ${languageInfo}` : `Castle · ${quality}`;
    streams.push({
      name,
      title: mediaTitle,
      url: videoUrl,
      quality,
      size: formatSize(data.size),
      languageInfo: languageInfo || 'Shared'
    });
  }
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

    const searchTerm = year ? `${title} ${year}` : title;
    console.log(`[Castle] Searching for "${searchTerm}"...`);
    const searchResult = await searchCastle(securityKey, searchTerm);
    let movieId = findMovieId(searchResult, title);
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
    const tracks = epObj?.tracks || [];

    const resolution = 2; // Default 720p base
    let rawStreams = [];

    // Check per-language tracks (V1)
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const langName = track.languageName || track.abbreviate || `Lang${i + 1}`;
      if (track.existIndividualVideo && track.languageId) {
        try {
          const videoData = await getVideoV1(securityKey, movieId, episodeId, String(track.languageId), resolution);
          const langStreams = processVideoResponse(videoData, mediaTitle, resolution, langName);
          rawStreams.push(...langStreams);
        } catch (e) {
          console.warn(`[Castle] ${langName}: v1 failed - ${e.message}`);
        }
      }
    }

    // Fallback to shared video (V2)
    if (!rawStreams.length) {
      console.log('[Castle] No language tracks found, attempting shared video2...');
      const videoData = await getVideo2(securityKey, movieId, episodeId, resolution);
      rawStreams = processVideoResponse(videoData, mediaTitle, resolution, 'Shared');
    }

    // Sort by quality descending
    rawStreams.sort((a, b) => qualityValue(b.quality) - qualityValue(a.quality));

    // De-duplicate by URL and format as standard stream items
    const seenUrls = new Set();
    const streams = [];

    for (let i = 0; i < rawStreams.length; i++) {
      const s = rawStreams[i];
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      const isHls = s.url.includes('.m3u8');
      const isDash = s.url.includes('.mpd');
      const streamType = isHls ? 'm3u8' : (isDash ? 'dash' : 'mp4');

      streams.push({
        id: `castle-${s.quality}-${i}`,
        name: s.name,
        title: s.title,
        url: s.url,
        quality: s.quality,
        qualityLabel: s.quality,
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
