// Lightweight proxy/m3u8/segment/subtitle rewriting layer.
// Supports HLS master/media playlists, segments (.ts, .m4s, disguised .jpg/.png), range requests, and caching.

const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { validateOriginMiddleware, setCorsHeaders } = require('../utils/origin');
const { config } = require('../utils/config');

const CACHE_MAX_SIZE = 250;
const CACHE_MAX_BYTES = 128 * 1024 * 1024; // 128 MB hard RAM cap
const MAX_CACHE_ENTRY_BYTES = 4 * 1024 * 1024; // 4 MB max per cached segment
const CACHE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const segmentCache = new Map();
let segmentCacheBytes = 0;

function isCacheDisabled() {
    return process.env.DISABLE_CACHE === 'true';
}

function deleteCachedEntry(url) {
    const entry = segmentCache.get(url);
    if (!entry) return;
    segmentCacheBytes = Math.max(0, segmentCacheBytes - (entry.data?.length || 0));
    segmentCache.delete(url);
}

function setCachedSegment(url, data, headers) {
    if (isCacheDisabled() || !data || data.length > MAX_CACHE_ENTRY_BYTES) return;
    if (segmentCache.has(url)) deleteCachedEntry(url);
    while (
        (segmentCache.size >= CACHE_MAX_SIZE || segmentCacheBytes + data.length > CACHE_MAX_BYTES) &&
        segmentCache.size > 0
    ) {
        const oldestKey = segmentCache.keys().next().value;
        deleteCachedEntry(oldestKey);
    }
    segmentCache.set(url, { data, headers, timestamp: Date.now() });
    segmentCacheBytes += data.length;
}

function cleanupCache() {
    const now = Date.now();
    for (const [url, entry] of segmentCache.entries()) {
        if (now - entry.timestamp > CACHE_EXPIRY_MS) segmentCache.delete(url);
    }
    if (segmentCache.size > CACHE_MAX_SIZE) {
        const entries = Array.from(segmentCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, segmentCache.size - CACHE_MAX_SIZE);
        toRemove.forEach(([u]) => segmentCache.delete(u));
    }
    return segmentCache.size;
}
setInterval(cleanupCache, 30 * 60 * 1000).unref();

function getCachedSegment(url) {
    if (isCacheDisabled()) return null;
    const e = segmentCache.get(url);
    if (!e) return null;
    if (Date.now() - e.timestamp > CACHE_EXPIRY_MS) { segmentCache.delete(url); return null; }
    return e;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sanitizeUpstreamHeaders(headers, targetUrl) {
    const upstreamHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
    try {
        const host = new URL(targetUrl).hostname.toLowerCase();
        // Upstream Vidzy and MovieBox/OneRoom reject requests containing a third-party Referer / Origin
        if (
            host.includes('vidzy.') ||
            host.includes('vidzy.org') ||
            host.includes('vidzy.cc') ||
            host.includes('hakunaymatata.') ||
            host.includes('aoneroom.')
        ) {
            delete upstreamHeaders['Referer'];
            delete upstreamHeaders['referer'];
            delete upstreamHeaders['Origin'];
            delete upstreamHeaders['origin'];
        }
        if (host.includes('hakunaymatata.') || host.includes('aoneroom.')) {
            // Hakunaymatata / MovieBox CDN blocks all web browsers (Desktop & Mobile Chrome) with '428 Forbidden'
            // Must send the native Android OneRoom Cronet User-Agent:
            upstreamHeaders['User-Agent'] = 'com.community.oneroom/50020120 (Linux; U; Android 12; en_US; 22101316G; Build/S1B.220414.015; Cronet/135.0.7012.3)';
        }
    } catch { }
    return upstreamHeaders;
}

async function prefetchSegment(url, headers) {
    if (isCacheDisabled() || segmentCache.size >= CACHE_MAX_SIZE) return;
    const existing = segmentCache.get(url);
    if (existing && Date.now() - existing.timestamp <= CACHE_EXPIRY_MS) return;
    try {
        const reqHeaders = sanitizeUpstreamHeaders(headers, url);
        const resp = await fetch(url, { headers: reqHeaders });
        if (!resp.ok && resp.status !== 206) return;
        const data = Buffer.from(await resp.arrayBuffer());
        const responseHeaders = {};
        resp.headers.forEach((v, k) => responseHeaders[k.toLowerCase()] = v);
        segmentCache.set(url, { data, headers: responseHeaders, timestamp: Date.now() });
    } catch (_e) { /* ignore */ }
}

function inferContentType(upstreamCT, targetUrl = '') {
    const bad = !upstreamCT ||
        /application\/octet-stream/i.test(upstreamCT) ||
        /image\//i.test(upstreamCT) ||
        /text\/html/i.test(upstreamCT) ||
        /text\/plain/i.test(upstreamCT) ||
        /javascript/i.test(upstreamCT) ||
        /application\/(x-)?zip/i.test(upstreamCT);
    if (!bad) return upstreamCT;

    const urlLower = targetUrl.toLowerCase();
    if (/\.m4s(\?|$)/i.test(urlLower)) return 'video/iso.segment';
    if (/\.(mp4|m4v)(\?|$)/i.test(urlLower)) return 'video/mp4';
    if (/\.m3u8(\?|$)/i.test(urlLower)) return 'application/vnd.apple.mpegurl';
    if (/\.(ts|jpg|jpeg|png|js|webp)(\?|$)/i.test(urlLower)) return 'video/mp2t';
    if (/\.aac(\?|$)/i.test(urlLower)) return 'audio/aac';
    if (/\.mp3(\?|$)/i.test(urlLower)) return 'audio/mpeg';
    if (/\.vtt(\?|$)/i.test(urlLower)) return 'text/vtt';
    if (/\.key(\?|$)/i.test(urlLower)) return 'application/octet-stream';
    return 'video/mp2t';
}

function getSecretKey() {
    const secret = process.env.APP_SECRET || 'embed-gibox-default-secret-key-32b';
    if (secret.length === 64 && /^[0-9a-fA-F]+$/.test(secret)) {
        return Buffer.from(secret, 'hex');
    }
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptTargetUrl(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    try {
        const key = getSecretKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(targetUrl, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, tag, encrypted]);
        return combined.toString('base64url');
    } catch (e) {
        return Buffer.from(targetUrl, 'utf8').toString('base64url');
    }
}

function decryptTargetUrl(token) {
    if (!token || typeof token !== 'string') return '';
    const trimmed = token.trim();
    // 1. Try AES-256-GCM decryption
    try {
        const combined = Buffer.from(trimmed, 'base64url');
        if (combined.length >= 28) {
            const key = getSecretKey();
            const iv = combined.subarray(0, 12);
            const tag = combined.subarray(12, 28);
            const encrypted = combined.subarray(28);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            const result = decrypted.toString('utf8');
            if (result.startsWith('http://') || result.startsWith('https://')) {
                return result;
            }
        }
    } catch {
        // Fall through
    }

    // 2. Base64url / Base64 fallback
    try {
        const plain = Buffer.from(trimmed, 'base64url').toString('utf8');
        if (plain.startsWith('http://') || plain.startsWith('https://')) return plain;
    } catch { }
    try {
        const plain = Buffer.from(trimmed, 'base64').toString('utf8');
        if (plain.startsWith('http://') || plain.startsWith('https://')) return plain;
    } catch { }

    // 3. Plain URL fallback
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
    }

    return '';
}

function extractOriginalUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        if (url.pathname.includes('/proxy/')) {
            const m = url.pathname.match(/\/proxy\/(.+)$/);
            if (m) {
                let decoded = decodeURIComponent(m[1]);
                while (decoded.includes('%2F')) {
                    try { decoded = decodeURIComponent(decoded); } catch { break; }
                }
                const dec = decryptTargetUrl(decoded);
                if (dec) return dec;
                if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
                return proxyUrl;
            }
        }
        if (url.searchParams.has('u')) {
            const dec = decryptTargetUrl(url.searchParams.get('u'));
            if (dec) return dec;
        }
        if (url.searchParams.has('url')) {
            const dec = decryptTargetUrl(url.searchParams.get('url'));
            if (dec) return dec;
            return decodeURIComponent(url.searchParams.get('url'));
        }
        const patterns = [
            /\/api\/[^/]+\/proxy\?url=(.+)$/,
            /\/proxy\?.*url=([^&]+)/,
            /\/stream\/proxy\/(.+)$/,
            /\/p\/(.+)$/
        ];
        for (const p of patterns) {
            const m = proxyUrl.match(p); if (m) {
                const dec = decryptTargetUrl(m[1]);
                if (dec) return dec;
                return decodeURIComponent(m[1]);
            }
        }
        return proxyUrl;
    } catch { return proxyUrl; }
}

function extractTargetAndHeaders(req) {
    let targetUrl = '';
    let headers = {};

    if (req.query.u) {
        targetUrl = decryptTargetUrl(req.query.u);
    }
    if (!targetUrl && req.query.url) {
        if (!req.query.url.startsWith('http://') && !req.query.url.startsWith('https://')) {
            targetUrl = decryptTargetUrl(req.query.url);
        }
        if (!targetUrl) {
            targetUrl = req.query.url;
        }
    }

    if (req.query.h) {
        try {
            const decoded = Buffer.from(req.query.h, 'base64url').toString('utf8');
            headers = JSON.parse(decoded);
        } catch {
            try {
                const decoded = Buffer.from(req.query.h, 'base64').toString('utf8');
                headers = JSON.parse(decoded);
            } catch { }
        }
    } else if (req.query.headers) {
        try {
            headers = typeof req.query.headers === 'string' ? JSON.parse(req.query.headers) : req.query.headers;
        } catch { }
    }

    return {
        targetUrl: typeof targetUrl === 'string' ? targetUrl.trim() : '',
        headers: headers && typeof headers === 'object' ? headers : {}
    };
}

function resolveChildUrl(line, targetUrl) {
    try {
        const trimmed = (line || '').trim();
        if (!trimmed) return '';
        const isRelative = !/^[a-zA-Z][a-zA-Z0-9+.-]*:|\/\//.test(trimmed);
        const parent = new URL(targetUrl);
        const resolved = new URL(trimmed, parent);
        // If child has no query params, but parent has query params (e.g. ?in=unknown::nt::t or ?token=...), inherit them
        if (!resolved.search && parent.search && (isRelative || resolved.host === parent.host)) {
            resolved.search = parent.search;
        }
        // Vidzy gate key: ensure gk is preserved if parent carries it and child does not (Gibox upstream pattern)
        const parentGk = parent.searchParams.get('gk');
        if (parentGk && !resolved.searchParams.has('gk')) {
            resolved.searchParams.set('gk', parentGk);
        }
        return resolved.href;
    } catch {
        return (line || '').trim();
    }
}

function rewriteM3u8(content, targetUrl, baseProxyUrl, headers) {
    const isMaster = /#EXT-X-STREAM-INF/i.test(content);
    const lines = content.split(/\r?\n/);
    const out = [];
    const segmentUrls = [];
    const headersParam = headers && Object.keys(headers).length ? `&h=${Buffer.from(JSON.stringify(headers)).toString('base64url')}` : '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
            out.push(line);
            continue;
        }

        if (trimmed.startsWith('#')) {
            // #EXT-X-MAP:URI="init.mp4"
            if (trimmed.startsWith('#EXT-X-MAP:')) {
                const rewritten = trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
                    const abs = resolveChildUrl(uri, targetUrl);
                    const proxyUrl = `${baseProxyUrl}/ts-proxy?u=${encryptTargetUrl(abs)}${headersParam}`;
                    return `URI="${proxyUrl}"`;
                });
                out.push(rewritten);
                continue;
            }

            // #EXT-X-KEY:METHOD=...,URI="..."
            if (trimmed.startsWith('#EXT-X-KEY:')) {
                const rewritten = trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
                    const abs = resolveChildUrl(uri, targetUrl);
                    const proxyUrl = `${baseProxyUrl}/ts-proxy?u=${encryptTargetUrl(abs)}${headersParam}`;
                    if (!isCacheDisabled()) prefetchSegment(abs, headers);
                    return `URI="${proxyUrl}"`;
                });
                out.push(rewritten);
                continue;
            }

            // #EXT-X-MEDIA:... URI="..." or #EXT-X-I-FRAME-STREAM-INF:... URI="..."
            if (trimmed.startsWith('#EXT-X-MEDIA:') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                const rewritten = trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
                    const abs = resolveChildUrl(uri, targetUrl);
                    const isM3u8 = /\.m3u8(\?|$)/i.test(abs) || trimmed.includes('TYPE=SUBTITLES') || trimmed.includes('TYPE=AUDIO');
                    const endpoint = isM3u8 ? 'm3u8-proxy' : 'ts-proxy';
                    const proxyUrl = `${baseProxyUrl}/${endpoint}?u=${encryptTargetUrl(abs)}${headersParam}`;
                    return `URI="${proxyUrl}"`;
                });
                out.push(rewritten);
                continue;
            }

            out.push(line);
            continue;
        }

        // Non-comment line (URI in playlist)
        try {
            const abs = resolveChildUrl(trimmed, targetUrl);
            const isSubPlaylist = isMaster || /\.m3u8(\?|$)/i.test(abs);
            if (isSubPlaylist) {
                out.push(`${baseProxyUrl}/m3u8-proxy?u=${encryptTargetUrl(abs)}${headersParam}`);
            } else {
                segmentUrls.push(abs);
                out.push(`${baseProxyUrl}/ts-proxy?u=${encryptTargetUrl(abs)}${headersParam}`);
            }
        } catch {
            out.push(line);
        }
    }

    if (segmentUrls.length && !isCacheDisabled()) {
        const toPrefetch = segmentUrls.slice(0, 3);
        Promise.all(toPrefetch.map(u => prefetchSegment(u, headers))).catch(() => undefined);
    }

    return out.join('\n');
}

function createProxyRoutes(app) {
    const originGuard = validateOriginMiddleware({
        getAllowedOrigins: () => config.allowedOrigins,
        getBlockNoOrigin: () => config.blockNoOrigin
    });

    // m3u8 playlist proxy
    app.all('/m3u8-proxy', originGuard, async (req, res) => {
        const { targetUrl, headers } = extractTargetAndHeaders(req);
        if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });

        try {
            const upstreamHeaders = sanitizeUpstreamHeaders(headers, targetUrl);
            const response = await fetch(targetUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: upstreamHeaders
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: `M3U8 fetch failed: ${response.status}` });
            }

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            if (req.method === 'HEAD') {
                return res.status(200).end();
            }

            const text = await response.text();
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            const baseProxyUrl = `${protocol}://${req.get('host')}`;
            const rewritten = rewriteM3u8(text, targetUrl, baseProxyUrl, headers);
            res.send(rewritten);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ts / media segment proxy
    app.all('/ts-proxy', originGuard, async (req, res) => {
        const { targetUrl, headers } = extractTargetAndHeaders(req);
        if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });

        const range = req.headers['range'];

        // Check in-memory segment cache
        if (!isCacheDisabled() && req.method !== 'HEAD') {
            const cached = getCachedSegment(targetUrl);
            if (cached) {
                const ct = inferContentType(cached.headers['content-type'], targetUrl);
                res.setHeader('Content-Type', ct);
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.setHeader('Accept-Ranges', 'bytes');

                const total = cached.data.length;
                if (range) {
                    const match = range.match(/bytes=(\d+)-(\d+)?/i);
                    if (match) {
                        const start = parseInt(match[1], 10);
                        const end = match[2] ? parseInt(match[2], 10) : total - 1;
                        if (start < total && end >= start) {
                            const actualEnd = Math.min(end, total - 1);
                            const chunk = cached.data.subarray(start, actualEnd + 1);
                            res.status(206);
                            res.setHeader('Content-Range', `bytes ${start}-${actualEnd}/${total}`);
                            res.setHeader('Content-Length', chunk.length);
                            return res.send(Buffer.from(chunk));
                        }
                    }
                }
                res.setHeader('Content-Length', total);
                return res.send(Buffer.from(cached.data));
            }
        }

        try {
            const upstreamHeaders = sanitizeUpstreamHeaders(headers, targetUrl);
            if (range) upstreamHeaders['Range'] = range;

            const resp = await fetch(targetUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: upstreamHeaders
            });

            if (!resp.ok && resp.status !== 206) {
                return res.status(resp.status).json({ error: `TS fetch failed: ${resp.status}` });
            }

            const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
            res.setHeader('Content-Type', upstreamCT);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'public, max-age=3600');

            const contentRange = resp.headers.get('content-range');
            if (contentRange) res.setHeader('Content-Range', contentRange);

            const cl = resp.headers.get('content-length');
            if (cl) res.setHeader('Content-Length', cl);

            if (resp.status === 206) {
                res.status(206);
            }

            if (req.method === 'HEAD') {
                return res.end();
            }

            // Only cache small HLS segments (<= 4 MB); stream MP4s/large files directly without buffering in RAM
            const isMp4 = upstreamCT.includes('video/mp4') || targetUrl.toLowerCase().includes('.mp4');
            if (!isCacheDisabled() && !isMp4 && !range && resp.status === 200 && (!cl || parseInt(cl, 10) <= MAX_CACHE_ENTRY_BYTES)) {
                try {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    const responseHeaders = {};
                    resp.headers.forEach((v, k) => responseHeaders[k.toLowerCase()] = v);
                    setCachedSegment(targetUrl, buf, responseHeaders);
                    return res.send(buf);
                } catch {
                    // fall back
                }
            }

            resp.body.pipe(res);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Subtitle proxy
    app.all('/sub-proxy', originGuard, async (req, res) => {
        const { targetUrl, headers } = extractTargetAndHeaders(req);
        if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });

        try {
            const resp = await fetch(targetUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: { 'User-Agent': DEFAULT_UA, ...headers }
            });

            if (!resp.ok) return res.status(resp.status).json({ error: `subtitle fetch failed: ${resp.status}` });

            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/vtt');

            if (req.method === 'HEAD') return res.end();
            resp.body.pipe(res);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

function isStreamProxyEnabledFor(providerName, stream) {
    if (!providerName && stream && stream.provider) {
        providerName = stream.provider;
    }
    const canonical = (providerName || '').toLowerCase().trim();
    const name = (canonical === 'mega' || canonical.startsWith('megaplay')) ? 'megaplay' : canonical;

    // Aliases to ensure common variations / spelling differences are handled
    const aliases = [name];
    if (name === 'moviebox' || name === 'movibox') {
        aliases.push('moviebox', 'movibox');
    } else if (name === 'vidy' || name === 'videasy') {
        aliases.push('vidy', 'videasy');
    } else if (name === 'vidsrc' || name === 'vidsrcto' || name === 'aura') {
        aliases.push('vidsrc', 'vidsrcto', 'aura');
    }
    const uniqueAliases = [...new Set(aliases)];

    // Check force list: STREAM_PROXY_FORCE=vidzy,vixsrc or FORCE_STREAM_PROXY
    const forceRaw = process.env.STREAM_PROXY_FORCE || process.env.FORCE_STREAM_PROXY || '';
    if (forceRaw) {
        const forceList = forceRaw.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
        if (uniqueAliases.some(a => forceList.includes(a)) || forceList.includes('all') || forceList.includes('*')) {
            return true;
        }
    }

    // Check provider-specific env variables across all aliases
    const envVars = [];
    for (const a of uniqueAliases) {
        const u = a.toUpperCase();
        envVars.push(
            process.env[`STREAM_PROXY_${u}_ENABLED`],
            process.env[`STREAM_HLS_PROXY_${u}_ENABLED`],
            process.env[`PROXY_STREAM_${u}_ENABLED`],
            process.env[`NEXT_PUBLIC_STREAM_PROXY_${u}_ENABLED`]
        );
    }

    for (const raw of envVars) {
        if (raw !== undefined) {
            const val = raw.trim().toLowerCase();
            if (['false', '0', 'off', 'no', 'disabled', 'direct'].includes(val)) {
                return false;
            }
            if (['true', '1', 'on', 'yes', 'enabled', 'proxy', 'force'].includes(val)) {
                return true;
            }
        }
    }

    // Global override if operator sets STREAM_PROXY_ALL_ENABLED
    const globalEnv = process.env.STREAM_PROXY_ALL_ENABLED;
    if (globalEnv !== undefined) {
        const val = globalEnv.trim().toLowerCase();
        if (['false', '0', 'off', 'no', 'disabled', 'direct'].includes(val)) return false;
        if (['true', '1', 'on', 'yes', 'enabled', 'proxy'].includes(val)) return true;
    }

    // Provider-specific default behavior matching gibox apps/web/lib/upstream.ts:
    switch (name) {
        case 'vidsrc':
        case 'vidsrcto':
        case 'aura':
            return true; // Enforces strict Referer checks on HLS playlist and segments
        case 'vidy':
        case 'videasy':
            return true; // Vidy CDNs enforce strict Referer/Origin headers and lack CORS
        case 'vidzy':
            return false; // Vidzy direct HLS works without proxy
        case 'vixsrc':
            return false; // Vixsrc master playlist & segments carry Access-Control-Allow-Origin: *
        case 'netmirror':
            return false; // Netmirror direct streams
        case 'moviebox':
            return true; // MovieBox CDN requires mobile/Cronet UA; proxied via ts-proxy with range support
        case 'castle':
        case 'steve':
            return false; // Castle direct HLS streams play without proxy
        case 'nxsha':
            return false;
        case 'megaplay':
            return false;
        default:
            return false;
    }
}

function processStreamsForProxy(streams, serverUrl) {
    if (!Array.isArray(streams)) return streams;
    const cfProxy = (process.env.CLOUDFLARE_STREAM_PROXY_URL || '').trim().replace(/\/$/, '');
    const publicServerUrl = (process.env.BACKEND_PUBLIC_URL || '').trim().replace(/\/$/, '') || serverUrl;

    return streams.map(s => {
        if (!s || !s.url || typeof s.url !== 'string') return s;

        const providerName = s.provider || s.scraper || '';
        const shouldProxy = isStreamProxyEnabledFor(providerName, s);

        if (!shouldProxy) {
            // Direct playback without proxy!
            return {
                ...s,
                direct: true
            };
        }

        const original = extractOriginalUrl(s.url);
        const headers = s.headers || {};
        const hParam = Object.keys(headers).length ? `&h=${Buffer.from(JSON.stringify(headers)).toString('base64url')}` : '';
        let host = '';
        try {
            host = new URL(original).hostname.toLowerCase();
        } catch { }

        // Direct file hosts routed through ts-proxy, HLS through m3u8-proxy
        const isTs = host.includes('pixeldrain.') || host === 'video-downloads.googleusercontent.com' || host.includes('hakunaymatata.') || host.includes('aoneroom.') || /\.(mp4|mkv)(\?|$)/i.test(original);
        const endpoint = isTs ? 'ts-proxy' : 'm3u8-proxy';

        // Encrypted URL parameter so raw upstream CDN domain and path are never exposed
        const encToken = encryptTargetUrl(original);
        const backendProxyUrl = `${publicServerUrl}/${endpoint}?u=${encToken}${hParam}`;

        // When Cloudflare Stream Proxy is configured, Cloudflare proxies OUR stream proxy!
        // (Browser -> Cloudflare Edge -> Our Backend /ts-proxy -> Upstream CDN)
        let finalUrl = backendProxyUrl;
        if (cfProxy) {
            finalUrl = `${cfProxy}/?url=${encodeURIComponent(backendProxyUrl)}`;
        }

        // Mask and proxy subtitles so upstream CDN domains and paths are never exposed
        let proxiedSubs = s.subtitles;
        if (Array.isArray(proxiedSubs)) {
            proxiedSubs = proxiedSubs.map((sub, sIdx) => {
                if (!sub || typeof sub !== 'object') return sub;
                const rawSubUrl = sub.url || sub.file || '';
                const maskedSubId = `sub-${(sub.lang || 'cc').toLowerCase()}-${sIdx + 1}`;
                if (typeof rawSubUrl === 'string' && (rawSubUrl.startsWith('http://') || rawSubUrl.startsWith('https://'))) {
                    const proxiedUrl = `${publicServerUrl}/sub-proxy?u=${encryptTargetUrl(rawSubUrl)}`;
                    return {
                        ...sub,
                        id: maskedSubId,
                        url: proxiedUrl,
                        ...(sub.file ? { file: proxiedUrl } : {})
                    };
                }
                return { ...sub, id: maskedSubId };
            });
        }

        return {
            ...s,
            url: finalUrl,
            direct: false,
            ...(proxiedSubs ? { subtitles: proxiedSubs } : {})
        };
    });
}

module.exports = {
    createProxyRoutes,
    processStreamsForProxy,
    isStreamProxyEnabledFor,
    encryptTargetUrl,
    decryptTargetUrl
};
