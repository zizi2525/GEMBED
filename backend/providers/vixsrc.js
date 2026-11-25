const axios = require('axios');
const { getStickyAxiosConfig, getCurrentStickySlot, rotateStickySlot } = require('../utils/extractorProxy');

const BASE_URL = 'https://vixsrc.to';
const VIXSRC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL
};

// Step 1: GET /api/movie/{id} or /api/tv/{id}/{s}/{e} → { src: "/embed/..." }
async function fetchApi(url, axiosConfig) {
    try {
        const response = await axios.get(url, axiosConfig);
        if (response.status !== 200 || !response.data) return null;
        return response.data;
    } catch (e) {
        console.log('[Vixsrc] Step 1 API error:', e.response ? `${e.response.status} ${e.response.statusText}` : e.message);
        return null;
    }
}

// Step 2: GET BASE_URL + sublink.src → HTML embed page
async function fetchEmbedPage(suburl, axiosConfig) {
    try {
        const response = await axios.get(BASE_URL + suburl, {
            ...axiosConfig,
            headers: { ...VIXSRC_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' },
            responseType: 'text'
        });
        if (response.status !== 200) return null;
        return response.data;
    } catch (e) {
        console.log('[Vixsrc] Step 2 embed error:', e.response ? `${e.response.status} ${e.response.statusText}` : e.message);
        return null;
    }
}

// Step 3: Extract token, expires, asn, and playlist URL (preferring window.streams with ?ub=1) from embed HTML
function extractTokenData(html) {
    const token = html.match(/['"]?token['"]?\s*:\s*["']([^"']+)/)?.[1];
    const expires = html.match(/['"]?expires['"]?\s*:\s*["']([^"']+)/)?.[1];
    const asn = html.match(/['"]?asn['"]?\s*:\s*["']([^"']*)/)?.[1];
    const masterUrl = html.match(/url\s*:\s*["']([^"']+)/)?.[1];
    const streamsMatch = html.match(/window\.streams\s*=\s*(\[[^\]]+\]);/);

    if (!token || !expires) return null;

    // Reject expired tokens (with 60s grace period)
    if (parseInt(expires, 10) * 1000 - 60_000 < Date.now()) {
        console.log('[Vixsrc] Token is expired');
        return null;
    }

    let playlistUrl = null;
    if (streamsMatch) {
        try {
            const streams = JSON.parse(streamsMatch[1]);
            const active = streams.find((s) => s.active) || streams[0];
            if (active?.url) {
                playlistUrl = new URL(active.url, BASE_URL);
            }
        } catch {}
    }
    if (!playlistUrl && masterUrl) {
        playlistUrl = new URL(masterUrl, BASE_URL);
        playlistUrl.searchParams.set('ub', '1');
    }
    if (!playlistUrl) return null;

    return { token, expires, asn, playlistUrl };
}

// Step 4: Append token, expires, asn, and lang params to master URL (do NOT set h=1; it causes 403)
function buildMasterUrl(tokenData, lang = 'en') {
    const { token, expires, asn, playlistUrl } = tokenData;
    const u = new URL(playlistUrl.toString());
    u.searchParams.set('token', token);
    u.searchParams.set('expires', expires);
    if (asn) u.searchParams.set('asn', asn);
    u.searchParams.set('lang', lang || 'en');
    return u.toString();
}

async function getVixsrcStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vixsrc] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    // Build API URL
    let apiUrl;
    if (mediaType === 'movie') {
        apiUrl = `${BASE_URL}/api/movie/${tmdbId}`;
    } else {
        apiUrl = `${BASE_URL}/api/tv/${tmdbId}/${seasonNum}/${episodeNum}`;
    }

    // Step 1 and Step 2 MUST use the exact same IP address (Vixsrc binds tokens to caller IP).
    // Using sticky proxy agent ensures consistent IP across both steps.
    let axiosConfig = getStickyAxiosConfig('vixsrc', { headers: VIXSRC_HEADERS, timeout: 10000 });

    console.log(`[Vixsrc] Step 1 - Calling API: ${apiUrl}`);
    let apiData = await fetchApi(apiUrl, axiosConfig);

    // Failover: if initial slot failed (e.g. Cloudflare blocked or slot timeout), rotate and retry once
    if (!apiData || !apiData.src) {
        console.log('[Vixsrc] Step 1 failed or blocked, retrying with next sticky proxy slot...');
        rotateStickySlot();
        axiosConfig = getStickyAxiosConfig('vixsrc', { headers: VIXSRC_HEADERS, timeout: 10000 });
        apiData = await fetchApi(apiUrl, axiosConfig);
    }

    if (!apiData || !apiData.src) {
        console.log('[Vixsrc] No src returned from API');
        return [];
    }
    console.log(`[Vixsrc] Step 2 - Fetching embed page: ${BASE_URL}${apiData.src}`);

    let html = await fetchEmbedPage(apiData.src, axiosConfig);
    if (!html) {
        console.log('[Vixsrc] Failed to fetch embed page');
        return [];
    }

    const tokenData = extractTokenData(html);
    if (!tokenData) {
        console.log('[Vixsrc] Could not extract token/expires/playlist from embed HTML');
        return [];
    }

    const masterUrl = buildMasterUrl(tokenData);
    const embedUrl = `${BASE_URL}${apiData.src}`;
    const usedSlot = getCurrentStickySlot();
    console.log(`[Vixsrc] Step 3 - Master URL: ${masterUrl}`);

    // Rotate slot for subsequent requests so traffic is distributed
    rotateStickySlot();

    return [
        {
            id: 'vixsrc-auto',
            name: 'Vixsrc · Auto',
            title: 'Vixsrc · Auto',
            url: masterUrl,
            quality: 'Auto',
            provider: 'Vixsrc',
            server: 'Vixsrc',
            serverName: 'Vixsrc',
            type: 'm3u8',
            headers: {
                Referer: embedUrl,
                Origin: BASE_URL,
                'User-Agent': VIXSRC_HEADERS['User-Agent'],
                'X-Proxy-Slot': String(usedSlot)
            }
        }
    ];
}

module.exports = { getVixsrcStreams };
