/**
 * Vidzy direct-stream resolver — SERVER ONLY.
 *
 * Resolves direct HLS streams from Vidzy (vidzy.org / vidzy.cc).
 * Returns the single master HLS stream with gate key (gk) and cookies,
 * exactly matching Gibox upstream architecture.
 */

const axios = require('axios');
const { getAxiosConfig, getFetchOptions } = require('../utils/extractorProxy');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const TIMEOUT = 9000;
const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

const BROWSER_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'fr,en-US;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site',
};

const resolvedCache = new Map();
const RESOLVE_TTL = 10 * 60_000;

/**
 * Fetch HTML / text content with timeout and fallback.
 */
async function getText(url, headers = {}) {
  const reqHeaders = {
    'User-Agent': UA,
    ...headers,
  };

  try {
    const res = await fetch(url, getFetchOptions('vidzy', {
      headers: reqHeaders,
      signal: AbortSignal.timeout(TIMEOUT),
      cache: 'no-store',
    }));
    if (!res.ok) throw new Error(`vidzy HTTP ${res.status} on ${url}`);
    return await res.text();
  } catch (err) {
    // Fallback to axios
    try {
      const res = await axios.get(url, getAxiosConfig('vidzy', {
        headers: reqHeaders,
        timeout: TIMEOUT,
        responseType: 'text',
        validateStatus: () => true,
      }));
      if (res.status >= 200 && res.status < 400 && res.data) {
        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      }
    } catch {
      // ignore
    }
    throw new Error(`vidzy fetch failed: ${err.message}`);
  }
}

/**
 * Fingerprint call returning the gate key to stamp on playlist URLs.
 */
async function gateKey() {
  const params = new URLSearchParams({
    v: 'p1',
    cw: '159.56',
    cw2: '170.34',
    wg: '1',
    ca: 'c1200a61d3dcccd7',
    cl: '23946',
    cn: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    ca2: '0e6074b4_5018',
    cx: '1',
    dpr: '1',
    sw: '1920',
    hw: '8',
    ft: 'https://vidzy.cc',
    rf: 'vidzy.org',
  });
  const gateUrl = `https://v6.vidzy.cc/gate.php?${params.toString()}`;

  try {
    const res = await fetch(gateUrl, getFetchOptions('vidzy', {
      headers: { 'User-Agent': UA, Referer: 'https://vidzy.cc/' },
      signal: AbortSignal.timeout(TIMEOUT),
    }));
    if (res && res.ok) {
      const json = await res.json();
      return json && json.gk ? json.gk : null;
    }
  } catch {
    // fallback
  }

  try {
    const res = await axios.get(gateUrl, getAxiosConfig('vidzy', {
      headers: { 'User-Agent': UA, Referer: 'https://vidzy.cc/' },
      timeout: TIMEOUT,
      validateStatus: () => true,
    }));
    return res.data && res.data.gk ? res.data.gk : null;
  } catch {
    return null;
  }
}

function pageUrl(input) {
  const type = input.type === 'tv' || input.mediaType === 'tv' ? 'tv' : 'movie';
  const season = input.season ?? input.seasonNum ?? 1;
  const episode = input.episode ?? input.episodeNum ?? 1;
  return type === 'tv'
    ? `https://vidzy.org/serie/${input.tmdbId}/${season}/${episode}`
    : `https://vidzy.org/movie/${input.tmdbId}`;
}

async function resolveUncached(input) {
  const page = pageUrl(input);
  const html = await getText(page);
  const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
  let iframe = iframeMatch ? iframeMatch[1] : null;
  if (!iframe) return null;
  if (iframe.startsWith('//')) iframe = 'https:' + iframe;

  const embed = await getText(iframe, { Referer: page });
  const manifestMatch =
    embed.match(/sources:\s*\[?\s*\{?\s*src:\s*"([^"]+)"/i) ||
    embed.match(/src:\s*"([^"]+\.m3u8[^"]*)"/i);
  let manifest = manifestMatch ? manifestMatch[1] : null;
  if (!manifest) return null;
  if (manifest.startsWith('//')) manifest = 'https:' + manifest;

  const gk = await gateKey();

  // The manifest request hands out the cookie that unlocks the playlists.
  // No referrer and no origin are sent, matching Gibox upstream.
  const reqHeaders = {
    'User-Agent': UA,
    ...BROWSER_HEADERS,
    'Accept-Encoding': ACCEPT_ENCODING,
  };

  let cookie = '';
  let body = '';

  try {
    const res = await fetch(manifest, getFetchOptions('vidzy', {
      headers: reqHeaders,
      signal: AbortSignal.timeout(TIMEOUT),
    }));
    if (res && res.ok) {
      const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (rawCookies.length > 0) {
        cookie = rawCookies.map((raw) => raw.split(';')[0]).join('; ');
      } else {
        const sc = res.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
      }
      body = await res.text();
    }
  } catch {
    try {
      const res = await axios.get(manifest, getAxiosConfig('vidzy', {
        headers: reqHeaders,
        timeout: TIMEOUT,
        responseType: 'text',
        validateStatus: () => true,
      }));
      if (res.status === 200 && res.data) {
        body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const sc = res.headers['set-cookie'];
        if (Array.isArray(sc)) {
          cookie = sc.map((r) => r.split(';')[0]).join('; ');
        } else if (typeof sc === 'string') {
          cookie = sc.split(';')[0];
        }
      }
    } catch {
      // ignore
    }
  }

  if (!body.includes('EXTM3U')) return null;

  // Stamp gate key on manifest URL if provided
  let finalUrl = manifest;
  if (gk) {
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl = `${finalUrl}${sep}gk=${encodeURIComponent(gk)}`;
  }

  return {
    iframe,
    url: finalUrl,
    session: {
      ...(cookie ? { cookie } : {}),
      ...(gk ? { gk } : {}),
      encoding: ACCEPT_ENCODING,
    },
    cookie,
    gk,
  };
}

/**
 * Resolve direct HLS source or null.
 */
async function resolveVidzy(input) {
  const tmdbId = Number(input.tmdbId);
  const type = input.type === 'tv' || input.mediaType === 'tv' ? 'tv' : 'movie';
  const season = Number(input.season ?? input.seasonNum ?? 1);
  const episode = Number(input.episode ?? input.episodeNum ?? 1);
  const key = `${type}:${tmdbId}:${season}:${episode}`;

  const cached = resolvedCache.get(key);
  if (cached && Date.now() - cached.at < RESOLVE_TTL) return cached.value;

  const value = await resolveUncached({
    type,
    tmdbId,
    season,
    episode,
  }).catch(() => null);

  resolvedCache.set(key, { at: Date.now(), value });
  if (resolvedCache.size > 200) {
    const oldest = [...resolvedCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) resolvedCache.delete(oldest[0]);
  }
  return value;
}

/**
 * Standard TMDB-Embed-API provider stream fetcher.
 * Returns the single master HLS stream with gateKey and cookies.
 */
async function getVidzyStreams(tmdbIdOrInput, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  let tmdbId, type, season, episode;

  if (typeof tmdbIdOrInput === 'object' && tmdbIdOrInput !== null) {
    tmdbId = Number(tmdbIdOrInput.tmdbId);
    type = tmdbIdOrInput.type === 'tv' || tmdbIdOrInput.mediaType === 'tv' ? 'tv' : 'movie';
    season = Number(tmdbIdOrInput.season ?? tmdbIdOrInput.seasonNum ?? 1);
    episode = Number(tmdbIdOrInput.episode ?? tmdbIdOrInput.episodeNum ?? 1);
  } else {
    tmdbId = Number(tmdbIdOrInput);
    type = mediaType === 'tv' ? 'tv' : 'movie';
    season = Number(seasonNum || 1);
    episode = Number(episodeNum || 1);
  }

  console.log(
    `[Vidzy] Fetching stream for TMDB ID: ${tmdbId}, Type: ${type}${
      type === 'tv' ? ` S${season}E${episode}` : ''
    }`
  );

  try {
    const resolved = await resolveVidzy({ type, tmdbId, season, episode });
    if (!resolved || !resolved.url) return [];

    return [
      {
        id: 'vidzy-auto',
        name: 'Vidzy · Auto',
        title: 'Vidzy · Auto',
        url: resolved.url,
        quality: 'Auto',
        provider: 'Vidzy',
        server: 'Vidzy',
        serverName: 'Vidzy',
        headers: {
          'User-Agent': UA,
          ...(resolved.cookie ? { Cookie: resolved.cookie } : {}),
        },
        session: resolved.session,
        type: 'm3u8',
      },
    ];
  } catch (err) {
    console.error(`[Vidzy] Fetch failed for TMDB ID ${tmdbId}: ${err.message}`);
    return [];
  }
}

module.exports = {
  getVidzyStreams,
  resolveVidzy,
  gateKey,
};
