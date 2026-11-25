/**
 * Aura (vidsrc.to / vidsrc.sh) Stream Resolver.
 *
 * Resolves multi-quality HLS master playlists (.m3u8) for movies and TV series
 * using the WASM ChaCha20 decryptor pipeline and host token generator.
 */

const { getStickyFetchOptions, rotateStickySlot } = require('../utils/extractorProxy');
const { config } = require('../utils/config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache for resolved streams

// Cache for compiled WebAssembly modules keyed by 5-minute window ID (vs.w)
const wasmModuleCache = new Map();

// In-memory cache for resolved stream objects
const streamCache = new Map();

function isCacheDisabled() {
  return Boolean(config.disableCache || process.env.DISABLE_CACHE === 'true');
}

function shouldDirectPlay() {
  try {
    const { isStreamProxyEnabledFor } = require('../proxy/proxyServer');
    return !isStreamProxyEnabledFor('vidsrc');
  } catch {
    const envVal = process.env.STREAM_PROXY_VIDSRC_ENABLED ?? process.env.STREAM_PROXY_AURA_ENABLED;
    return envVal === 'false';
  }
}

/**
 * Decrypts encrypted stream_urls using the per-window ChaCha20 WebAssembly decryptor.
 */
async function decryptStreamUrls(streamData, fetchSignal) {
  if (!streamData || !streamData.data) return [];
  const rawUrls = streamData.data.stream_urls;

  // Plain fallback if stream_urls is already an array of URLs
  if (Array.isArray(rawUrls)) {
    return rawUrls.filter(Boolean);
  }

  if (typeof rawUrls !== 'string' || !streamData.vs) {
    return [];
  }

  const vs = streamData.vs;
  const windowKey = vs.w != null ? String(vs.w) : 'default';

  let mod = !isCacheDisabled() ? wasmModuleCache.get(windowKey) : null;
  if (!mod) {
    let wasmBuffer = null;
    if (vs.wasm_url) {
      const wasmOpts = getStickyFetchOptions('vidsrc', {
        headers: { 'User-Agent': UA },
        signal: fetchSignal || AbortSignal.timeout(TIMEOUT_MS)
      });
      const wasmRes = await fetch(vs.wasm_url, wasmOpts);
      if (!wasmRes.ok) {
        throw new Error(`Failed to fetch WASM from ${vs.wasm_url} (${wasmRes.status})`);
      }
      wasmBuffer = await wasmRes.arrayBuffer();
    } else if (vs.wasm) {
      wasmBuffer = Buffer.from(vs.wasm, 'base64');
    }

    if (!wasmBuffer) {
      throw new Error('No WASM payload found in API response');
    }

    mod = await WebAssembly.compile(wasmBuffer);

    if (!isCacheDisabled()) {
      // Keep cache bounded to at most 10 active modules
      if (wasmModuleCache.size >= 10) {
        const firstKey = wasmModuleCache.keys().next().value;
        wasmModuleCache.delete(firstKey);
      }
      wasmModuleCache.set(windowKey, mod);
    }
  }

  // Instantiate fresh linear memory per decryption call
  const inst = await WebAssembly.instantiate(mod, {});
  const ex = inst.exports;
  const encBytes = Buffer.from(rawUrls, 'base64');

  const ptr = ex.alloc(encBytes.length);
  new Uint8Array(ex.memory.buffer, ptr, encBytes.length).set(encBytes);
  const outLen = ex.decrypt(ptr, encBytes.length);
  const decryptedText = new TextDecoder().decode(
    new Uint8Array(ex.memory.buffer, ptr + 12, outLen)
  );

  return decryptedText
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Resolves Aura (VidSrc) streams for Movies and TV Series.
 */
async function getVidsrcStreams(tmdbId, mediaType = 'movie', season = null, episode = null, requestedLang = null, clientGeo = null, ctx = null) {
  if (config.enableVidsrcProvider === false || process.env.ENABLE_VIDSRC_PROVIDER === 'false') {
    return [];
  }

  if (!tmdbId) return [];

  const isTv = mediaType === 'tv' || Boolean(season);
  const sNum = isTv ? parseInt(season || 1, 10) : null;
  const eNum = isTv ? parseInt(episode || 1, 10) : null;
  const cacheKey = `${isTv ? 'tv' : 'movie'}:${tmdbId}:${sNum || 0}:${eNum || 0}`;

  if (!isCacheDisabled()) {
    const cached = streamCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.streams;
    }
  }

  try {
    const abortSignal = AbortSignal.timeout(TIMEOUT_MS);
    const stickyFetch = (url, headers = {}) =>
      fetch(
        url,
        getStickyFetchOptions('vidsrc', {
          headers: { 'User-Agent': UA, ...headers },
          signal: abortSignal
        })
      );

    // Step 1: Call vs_src.php on vidsrc.sh
    const vsSrcUrl = isTv
      ? `https://vidsrc.sh/vs_src.php?type=tv&id=${encodeURIComponent(tmdbId)}&season=${sNum}&episode=${eNum}`
      : `https://vidsrc.sh/vs_src.php?type=movie&id=${encodeURIComponent(tmdbId)}`;

    const vsSrcRes = await stickyFetch(vsSrcUrl, { Referer: 'https://vidsrc.sh/' });
    if (!vsSrcRes.ok) {
      console.warn(`[aura] vs_src.php returned ${vsSrcRes.status} for ${cacheKey}`);
      rotateStickySlot();
      return [];
    }

    const vsSrcData = await vsSrcRes.json();
    if (!vsSrcData || !vsSrcData.src) {
      console.warn(`[aura] No inner embed URL returned for ${cacheKey}`);
      return [];
    }

    const innerEmbedUrl = vsSrcData.src;
    const innerOrigin = new URL(innerEmbedUrl).origin;

    // Step 2: Fetch the inner embed page to retrieve CFG (playerUrl & metaApi)
    const innerPageRes = await stickyFetch(innerEmbedUrl, { Referer: 'https://vidsrc.sh/' });
    if (!innerPageRes.ok) {
      console.warn(`[aura] Inner embed page returned ${innerPageRes.status}`);
      rotateStickySlot();
      return [];
    }

    const innerHtml = await innerPageRes.text();
    const cfgMatch = innerHtml.match(/CFG\s*=\s*(\{[\s\S]*?\});/);
    if (!cfgMatch) {
      console.warn('[aura] CFG object not found in inner embed page');
      return [];
    }
    const cfg = JSON.parse(cfgMatch[1]);
    if (!cfg.playerUrl) {
      console.warn('[aura] playerUrl missing in CFG');
      return [];
    }

    // Step 3: Fetch player page on inner host to retrieve CONFIG (apiToken, stream endpoint)
    const playerFullUrl = new URL(cfg.playerUrl, innerOrigin).href;
    const playerRes = await stickyFetch(playerFullUrl, { Referer: innerEmbedUrl });
    if (!playerRes.ok) {
      console.warn(`[aura] Player page returned ${playerRes.status}`);
      rotateStickySlot();
      return [];
    }

    const playerHtml = await playerRes.text();
    const configMatch = playerHtml.match(/CONFIG\s*=\s*(\{[\s\S]*?\});/);
    if (!configMatch) {
      console.warn('[aura] CONFIG object not found in player page');
      return [];
    }
    const playerConfig = JSON.parse(configMatch[1]);
    if (!playerConfig.apiToken) {
      console.warn('[aura] apiToken missing in player CONFIG');
      return [];
    }

    // Step 4: Fetch metadata (thumbnails, stream host, subtitles)
    let metaData = {};
    if (cfg.metaApi) {
      try {
        const metaRes = await stickyFetch(cfg.metaApi, { Referer: innerEmbedUrl });
        if (metaRes.ok) {
          metaData = await metaRes.json();
        }
      } catch (e) {
        console.warn('[aura] Metadata fetch error:', e.message);
      }
    }

    // Step 5: Construct stream_urls API endpoint and request encrypted stream list
    let streamApiBase = playerConfig.api;
    if (!streamApiBase && playerConfig.streamBase) {
      streamApiBase = `${playerConfig.streamBase}&season=${sNum}&episode=${eNum}&stream_urls`;
    }
    if (!streamApiBase) {
      console.warn('[aura] Could not resolve stream API base URL');
      return [];
    }

    const streamApiUrl = new URL(streamApiBase);
    if (metaData.data?.stream_urls_api_host) {
      streamApiUrl.host = metaData.data.stream_urls_api_host;
    }
    streamApiUrl.searchParams.set('api_token', playerConfig.apiToken);

    const streamRes = await stickyFetch(streamApiUrl.href, { Referer: playerFullUrl });
    if (!streamRes.ok) {
      console.warn(`[aura] Stream API returned ${streamRes.status}`);
      rotateStickySlot();
      return [];
    }

    const streamData = await streamRes.json();

    // Step 6: Decrypt stream URLs via WebAssembly ChaCha20 decryptor
    const decryptedUrls = await decryptStreamUrls(streamData, abortSignal);
    if (!decryptedUrls.length) {
      console.warn(`[aura] No stream URLs decrypted for ${cacheKey}`);
      return [];
    }

    // Step 7: Request single-use host playback token via /generate.php
    const streamOrigin = new URL(decryptedUrls[0]).origin;
    let playbackToken = '';
    try {
      const genUrl = `${streamOrigin}/generate.php?api_token=${encodeURIComponent(playerConfig.apiToken)}`;
      const genRes = await stickyFetch(genUrl, { Referer: `${innerOrigin}/` });
      if (genRes.ok) {
        playbackToken = (await genRes.text()).trim();
      }
    } catch (e) {
      console.warn('[aura] generate.php token request error:', e.message);
    }

    // Step 8: Assemble subtitles & thumbnails
    const thumbnailsUrl =
      metaData.thumbnails_url ||
      metaData.data?.thumbnails_url ||
      playerConfig.thumbnails ||
      null;

    const subtitles = [];
    if (Array.isArray(metaData.default_subs)) {
      metaData.default_subs.forEach((sub, sIdx) => {
        if (!sub || (!sub.url && !sub.file)) return;
        const subLang = (sub.lang || sub.language || 'en').toLowerCase();
        subtitles.push({
          id: `sub-${subLang}-${sIdx + 1}`,
          url: sub.url || sub.file,
          label: sub.label || sub.name || subLang.toUpperCase(),
          lang: subLang
        });
      });
    }

    // Step 9: Build standardized stream items using masked codename "Aura"
    const streams = [];
    const imdbId = metaData.data?.imdb_id || playerConfig.imdb || null;
    const directPlay = shouldDirectPlay();

    for (let i = 0; i < decryptedUrls.length; i++) {
      const rawUrl = decryptedUrls[i];
      const finalUrl = playbackToken
        ? `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(playbackToken)}`
        : rawUrl;

      const serverTitle = i === 0 ? 'Aura · Multi-Quality' : `Aura · Backup ${i + 1}`;

      streams.push({
        id: `aura-1080p-${i + 1}`,
        name: serverTitle,
        title: serverTitle,
        url: finalUrl,
        quality: '1080p',
        qualityLabel: '1080p',
        lang: 'vo',
        langLabel: 'Original',
        provider: 'vidsrc',
        server: 'Aura',
        serverName: 'Aura',
        type: 'm3u8',
        direct: directPlay,
        headers: {
          'User-Agent': UA,
          Referer: `${innerOrigin}/`
        },
        thumbnails: thumbnailsUrl,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        imdbId: imdbId
      });
    }

    console.log(`[aura] Resolved ${streams.length} stream(s) for ${cacheKey}`);

    if (!isCacheDisabled()) {
      streamCache.set(cacheKey, {
        timestamp: Date.now(),
        streams
      });
    }

    return streams;
  } catch (err) {
    console.error(`[aura] Error resolving ${cacheKey}:`, err.message);
    rotateStickySlot();
    return [];
  }
}

module.exports = {
  getVidsrcStreams,
  decryptStreamUrls
};
