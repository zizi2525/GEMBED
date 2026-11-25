const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDetails } = require('../utils/tmdb');
const { getAxiosConfig } = require('../utils/extractorProxy');

// --- Constants & Pool from MovieBox-Tui ---
const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];

const DEFAULT_SECRET_BYTES = Buffer.from('76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O', 'base64');
const STOCK_CERT_SHA256 = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410';
const BUILD_TAG_SALT = 'oneroom';
const SIGNATURE_BODY_MAX_BYTES = 102400;

const MAP_FILE = path.join(__dirname, '../data/moviebox_map.json');

// --- In-Memory Session & Client State (following client.rs & session.rs) ---
let currentSession = {
  token: null,
  userId: null,
  expiresAt: 0,
  createdAt: 0,
};

let currentClientIdentity = null;
const subtitlesMemoryCache = new Map();
const geoMemoryCache = new Map(); // ip/key -> { data, expiresAt }

// --- Client Geo Detection via https://get.geojs.io/v1/ip/geo.json ---
async function fetchGeoData(ip = null) {
  const cacheKey = ip || 'default';
  const cached = geoMemoryCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  try {
    const geoUrl = ip
      ? `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`
      : 'https://get.geojs.io/v1/ip/geo.json';
    const res = await axios.get(geoUrl, getAxiosConfig('moviebox', { timeout: 3500 }));
    if (res.data && res.data.ip) {
      geoMemoryCache.set(cacheKey, {
        data: res.data,
        expiresAt: Date.now() + 6 * 3600 * 1000, // 6h TTL
      });
      return res.data;
    }
  } catch (e) {
    // Graceful fallback if geojs is unreachable or rate-limited
  }
  return null;
}

// --- Crypto Functions from crypto.rs ---
function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function buildTagStamp(tsMs, randPart) {
  const s = Math.floor(tsMs / 1000);
  const ms = String(tsMs % 1000).padStart(3, '0');
  return `${s}${ms}000${randPart}`;
}

function buildTagForCert(tsMs, randPart, certSha256Hex) {
  const stamp = buildTagStamp(tsMs, randPart);
  const hash = md5(Buffer.from(`${certSha256Hex}${BUILD_TAG_SALT}${stamp}`));
  return `${stamp}.${hash}`;
}

function generateXClientBuild(tsMs) {
  const randPart = Math.floor(Math.random() * 1000);
  return buildTagForCert(tsMs, randPart, STOCK_CERT_SHA256);
}

function clientInfoWithBuildTag(clientInfoStr, tag) {
  try {
    const val = JSON.parse(clientInfoStr);
    val['X-Client-Build'] = tag;
    return JSON.stringify(val);
  } catch {
    return clientInfoStr;
  }
}

function generateXClientToken(ts) {
  const tsStr = ts.toString();
  const reversedTs = tsStr.split('').reverse().join('');
  const hashVal = md5(Buffer.from(reversedTs));
  return `${tsStr},${hashVal}`;
}

function sortedQueryString(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const params = Array.from(parsed.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (params.length === 0) return '';
    return params.map(([k, v]) => `${k}=${v}`).join('&');
  } catch {
    return '';
  }
}

function buildCanonicalString(method, accept, contentType, urlStr, body, timestampMs) {
  let canonicalUrl = urlStr;
  try {
    const parsed = new URL(urlStr);
    const pathName = parsed.pathname;
    const query = sortedQueryString(urlStr);
    canonicalUrl = query ? `${pathName}?${query}` : pathName;
  } catch {}

  const bodyBytes = body ? Buffer.from(body, 'utf8') : null;
  let bodyHash = '';
  let bodyLength = '';
  if (bodyBytes) {
    const len = bodyBytes.length;
    const truncated = len > SIGNATURE_BODY_MAX_BYTES ? bodyBytes.slice(0, SIGNATURE_BODY_MAX_BYTES) : bodyBytes;
    bodyHash = md5(truncated);
    bodyLength = len.toString();
  }

  return `${method.toUpperCase()}\n${accept || ''}\n${contentType || ''}\n${bodyLength}\n${timestampMs}\n${bodyHash}\n${canonicalUrl}`;
}

function generateXTrSignature(method, accept, contentType, urlStr, body, timestampMs) {
  const canonical = buildCanonicalString(method, accept, contentType, urlStr, body, timestampMs);
  const sigB64 = crypto.createHmac('md5', DEFAULT_SECRET_BYTES).update(canonical, 'utf8').digest('base64');
  return `${timestampMs}|2|${sigB64}`;
}

function randomSpoofedIp() {
  const prefixes = [
    '103.241', '49.36', '117.195', '106.198', '122.162',
    '157.32', '182.70', '103.58', '27.60', '59.90',
  ];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const c = Math.floor(Math.random() * 253) + 1;
  const d = Math.floor(Math.random() * 253) + 1;
  return `${prefix}.${c}.${d}`;
}

function randomHex(len) {
  let res = '';
  for (let i = 0; i < len; i++) {
    res += Math.floor(Math.random() * 16).toString(16);
  }
  return res;
}

function randomUuid() {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}

function generateClientInfoAndUa(geo = null) {
  const androidVersions = [
    ['9', 'PQ3A.190605.03081104'],
    ['10', 'QP1A.191005.007.A3'],
    ['11', 'RP1A.200720.011'],
    ['12', 'S1B.220414.015'],
    ['13', 'TQ2A.230405.003'],
  ];
  const redmiDevices = [
    ['23078RKD5C', 'Redmi'],
    ['2201117TY', 'Redmi'],
    ['2201117TG', 'Redmi'],
    ['22101316G', 'Redmi'],
    ['21121210G', 'Redmi'],
    ['M2012K11AG', 'Redmi'],
    ['M2007J20CG', 'Redmi'],
  ];
  const versionCodes = [50020117, 50020118, 50020119, 50020120, 50020121];
  const networkTypes = ['NETWORK_WIFI', 'NETWORK_MOBILE'];
  const timezones = [
    'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London',
  ];

  const android = androidVersions[Math.floor(Math.random() * androidVersions.length)];
  const device = redmiDevices[Math.floor(Math.random() * redmiDevices.length)];
  const versionCode = versionCodes[Math.floor(Math.random() * versionCodes.length)];
  const network = networkTypes[Math.floor(Math.random() * networkTypes.length)];
  const timezone = geo?.timezone || timezones[Math.floor(Math.random() * timezones.length)];
  const region = geo?.country_code || geo?.countryCode || 'US';
  const clientIp = geo?.ip || randomSpoofedIp();
  const gaid = randomUuid();
  const deviceId = randomHex(32);

  const userAgent = `com.community.oneroom/${versionCode} (Linux; U; Android ${android[0]}; en_US; ${device[0]}; Build/${android[1]}; Cronet/135.0.7012.3)`;

  const clientInfoObj = {
    package_name: 'com.community.oneroom',
    version_name: '4.0.01.0813.03',
    version_code: versionCode,
    os: 'android',
    os_version: android[0],
    install_ch: 'ps',
    device_id: deviceId,
    install_store: 'ps',
    gaid: gaid,
    brand: device[1],
    model: device[0],
    system_language: 'en',
    net: network,
    region: region,
    timezone: timezone,
    sp_code: '40401',
    'X-Play-Mode': '2',
  };

  return {
    userAgent,
    clientInfo: JSON.stringify(clientInfoObj),
    spoofedIp: clientIp,
    geo: { ip: clientIp, region, timezone },
  };
}

function getClientIdentity(geo = null) {
  if (geo) {
    return generateClientInfoAndUa(geo);
  }
  if (!currentClientIdentity) {
    currentClientIdentity = generateClientInfoAndUa();
  }
  return currentClientIdentity;
}

function buildSignedHeaders(method, urlStr, bodyStr = null, authToken = null, geo = null) {
  const identity = getClientIdentity(geo);
  const ts = Date.now();
  const accept = 'application/json';
  const contentType = 'application/json';

  const clientTokenVal = generateXClientToken(ts);
  const signature = generateXTrSignature(method, accept, contentType, urlStr, bodyStr, ts);
  const buildTag = generateXClientBuild(ts);
  const clientInfoWithTag = clientInfoWithBuildTag(identity.clientInfo, buildTag);

  const headers = {
    'User-Agent': identity.userAgent,
    'Accept': accept,
    'Content-Type': contentType,
    'Connection': 'keep-alive',
    'x-client-token': clientTokenVal,
    'x-tr-signature': signature,
    'x-client-build': buildTag,
    'x-client-info': clientInfoWithTag,
    'x-client-status': '0',
    'x-forwarded-for': identity.spoofedIp,
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  return headers;
}

// --- Session Handling from session.rs ---
function parseJwtClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { uid: null, exp: null };
    const payloadB64 = parts[1];
    const padLen = (4 - (payloadB64.length % 4)) % 4;
    const padded = payloadB64 + '='.repeat(padLen);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const val = JSON.parse(decoded);
    return {
      uid: val.userId || val.uid || val.sub || null,
      exp: val.exp || null,
    };
  } catch {
    return { uid: null, exp: null };
  }
}

function isSessionValid(session) {
  if (!session || !session.token) return false;
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt) {
    return now + 60 < session.expiresAt;
  }
  return now < session.createdAt + 7 * 24 * 3600;
}

function absorbXUserHeader(resHeaders) {
  try {
    const xUser = resHeaders['x-user'];
    if (!xUser) return;
    const parsed = typeof xUser === 'string' ? JSON.parse(xUser) : xUser;
    if (parsed.token) {
      const claims = parseJwtClaims(parsed.token);
      currentSession = {
        token: parsed.token,
        userId: parsed.uid || parsed.userId || claims.uid,
        expiresAt: claims.exp || Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        createdAt: Math.floor(Date.now() / 1000),
      };
    }
  } catch {}
}

async function fetchFreshSession(host) {
  const url = `${host}/wefeed-mobile-bff/user-api/visitor-login`;
  const bodyStr = '{}';
  const headers = buildSignedHeaders('POST', url, bodyStr, null);
  const res = await axios.post(url, bodyStr, getAxiosConfig('moviebox', { headers, timeout: 6000 }));
  absorbXUserHeader(res.headers);

  const val = res.data?.data || res.data;
  const token = val?.token || currentSession.token;
  if (!token) {
    throw new Error('MovieBox visitor login missing token');
  }

  const claims = parseJwtClaims(token);
  currentSession = {
    token,
    userId: val.uid || val.userId || claims.uid,
    expiresAt: claims.exp || Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    createdAt: Math.floor(Date.now() / 1000),
  };
  return currentSession.token;
}

async function ensureSession(host = HOST_POOL[0]) {
  if (isSessionValid(currentSession)) {
    return currentSession.token;
  }
  return await fetchFreshSession(host);
}

const RETRY_STATUS_CODES = [403, 406, 407, 429, 500, 502, 503, 504];
let activeHostIdx = 0;

// --- Request Execution with Round-Robin Host Pool & 429 Retry Backoff from client.rs ---
async function executeApi(method, pathQuery, body = null, clientGeo = null) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const startIdx = activeHostIdx;
  let lastErr = null;

  for (let i = 0; i < HOST_POOL.length; i++) {
    const idx = (startIdx + i) % HOST_POOL.length;
    const host = HOST_POOL[idx];

    try {
      const token = await ensureSession(host);
      const url = `${host}${pathQuery}`;
      const headers = buildSignedHeaders(method, url, bodyStr, token, clientGeo);

      let res;
      if (method.toUpperCase() === 'POST') {
        res = await axios.post(url, bodyStr, getAxiosConfig('moviebox', { headers, timeout: 7000 }));
      } else {
        res = await axios.get(url, getAxiosConfig('moviebox', { headers, timeout: 7000 }));
      }

      absorbXUserHeader(res.headers);
      activeHostIdx = idx; // Lock in the healthy host
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;

      if (status && RETRY_STATUS_CODES.includes(status)) {
        activeHostIdx = (idx + 1) % HOST_POOL.length; // Rotate to next host in pool

        if (status === 429) {
          // Rate-limited by host: parse Retry-After or backoff 400ms-1500ms
          const retryHeader = err.response?.headers?.['retry-after'];
          const backoffMs = retryHeader ? Math.min(parseInt(retryHeader, 10) * 1000, 2000) : 400;
          await new Promise((r) => setTimeout(r, backoffMs));
        }

        if (status === 401 || status === 403) {
          currentSession.token = null;
        }
        continue;
      }

      // On network/timeout error, advance to next host immediately
      activeHostIdx = (idx + 1) % HOST_POOL.length;
      continue;
    }
  }
  throw lastErr || new Error('All MovieBox hosts failed');
}

// --- JSON Mapper Persistence ---
function loadMap() {
  try {
    if (fs.existsSync(MAP_FILE)) {
      return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[MovieBox] Could not read moviebox_map.json:', e.message);
  }
  return {};
}

function saveMap(map) {
  try {
    fs.mkdirSync(path.dirname(MAP_FILE), { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.warn('[MovieBox] Could not write moviebox_map.json:', e.message);
  }
}

// --- Title Cleaning from title.rs ---
function cleanMovieboxTitle(rawTitle) {
  let title = (rawTitle || '').trim();
  if (!title) return '';

  while (title.startsWith('[')) {
    const closePos = title.indexOf(']');
    if (closePos !== -1) {
      const rem = title.slice(closePos + 1).trim();
      if (rem) title = rem;
      else break;
    } else break;
  }

  const brPos = title.indexOf('[');
  if (brPos > 0) title = title.slice(0, brPos).trim();

  const parenPos = title.indexOf('(');
  if (parenPos > 0) {
    const inside = title.slice(parenPos + 1).split(')')[0].trim();
    const isYear = /^\d{4}$/.test(inside) && parseInt(inside, 10) >= 1900 && parseInt(inside, 10) <= 2099;
    if (!isYear) title = title.slice(0, parenPos).trim();
  }

  const dashPos = title.lastIndexOf(' - ');
  if (dashPos !== -1) {
    const suffix = title.slice(dashPos + 3).toLowerCase();
    if (/dub|audio|multi|season|hindi|tamil|telugu|arabic|french|spanish|german|russian/i.test(suffix)) {
      title = title.slice(0, dashPos).trim();
    }
  }

  const sPos = title.lastIndexOf(' S');
  if (sPos !== -1 && /^S\d+/i.test(title.slice(sPos + 1))) {
    title = title.slice(0, sPos).trim();
  }

  title = title.replace(/\s+seasons?\s*\d+\s*[-~to]\s*\d+/i, '');
  title = title.replace(/\s+s\d+\s*[-~to]\s*s?\d+/i, '');
  title = title.replace(/\s+season\s+\d+/i, '');
  title = title.replace(/[_\s\.-]\d{3,4}p$/i, '');
  return title.replace(/[-:_.\s]+$/, '').trim();
}

function matchesSeason(title = '', targetSeason = 1) {
  // Check range e.g. S1-S3, S01-S03, S1 - S3, S1~S3, Season 1-3, Seasons 1-3
  const rangeMatch = title.match(/\bS(\d+)\s*[-~to]\s*S?(\d+)\b/i) ||
                     title.match(/\bSeasons?\s*(\d+)\s*[-~to]\s*(\d+)\b/i);
  if (rangeMatch) {
    const sStart = parseInt(rangeMatch[1], 10);
    const sEnd = parseInt(rangeMatch[2], 10);
    return targetSeason >= Math.min(sStart, sEnd) && targetSeason <= Math.max(sStart, sEnd);
  }

  // Check single season e.g. S1, S01, Season 1
  const singleMatch = title.match(/\bS(\d+)\b/i) || title.match(/\bSeason\s*(\d+)\b/i);
  if (singleMatch) {
    const tagged = parseInt(singleMatch[1], 10);
    return tagged === targetSeason;
  }

  // If no season tag exists at all in title, assume subject covers all seasons / season 1
  return true;
}

// --- Deprecation Clip Filter from adapt.rs ---
function isDeprecationNoticeUrl(url = '') {
  const lower = (url || '').toLowerCase();
  return (
    lower.includes('1c7de0bd3393702d9191801f15f88f8d') ||
    lower.includes('9a0461bc39da389663bf3dbb17091d3f') ||
    lower.includes('b164fbfb4347792950bdfbfb563d39d9') ||
    lower.includes('/notice.mp4') ||
    (lower.includes('macdn.aoneroom.com') && lower.includes('/other/'))
  );
}

const STREAM_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes TTL for CDN signed URLs

function areStreamsFresh(streams, savedAt) {
  if (!Array.isArray(streams) || streams.length === 0) return false;
  if (!savedAt || (Date.now() - savedAt) > STREAM_CACHE_TTL_MS) return false;

  for (const s of streams) {
    if (!s || !s.url) continue;
    const match = s.url.match(/[?&]t=(\d+)/);
    if (match) {
      const tExp = parseInt(match[1], 10);
      const nowSec = Math.floor(Date.now() / 1000);
      // If URL timestamp is more than 1 hour old, consider expired
      if (nowSec - tExp > 3600) {
        return false;
      }
    }
  }
  return true;
}

function shouldDirectPlay() {
  try {
    const { isStreamProxyEnabledFor } = require('../proxy/proxyServer');
    return !isStreamProxyEnabledFor('MovieBox');
  } catch (e) {
    const envVal = process.env.STREAM_PROXY_MOVIEBOX_ENABLED ?? process.env.STREAM_PROXY_MOVIBOX_ENABLED;
    return envVal === 'false';
  }
}

function mergeDubsLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const code = normalizeLangCode(d.lanCode || d.lanName);
      const key = `${code}:${d.isSub ? 'sub' : 'dub'}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          subjectId: String(d.subjectId),
          lanName: d.lanName || (code === 'en' ? 'Original Audio' : `${code} dub`),
          lanCode: code,
          original: Boolean(d.original || code === 'en'),
          isSub: Boolean(d.isSub),
        });
      }
    }
  }
  merged.sort((a, b) => (b.original ? 1 : 0) - (a.original ? 1 : 0));
  return merged;
}

// --- Exact Match Search Algorithm (With French & Multi-Language Dub Discovery) ---
async function searchExactSubject(tmdbDetails, mediaType, season = 1) {
  const title = tmdbDetails.title || tmdbDetails.name;
  const origTitle = tmdbDetails.original_title || tmdbDetails.original_name;
  const year = parseInt((tmdbDetails.release_date || tmdbDetails.first_air_date || '').slice(0, 4), 10) || null;
  const isTv = mediaType === 'tv';

  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetNorm = norm(title);
  const targetOrigNorm = norm(origTitle);

  // 1. Search primary title
  let primarySubjects = [];
  try {
    const res = await executeApi('POST', '/wefeed-mobile-bff/subject-api/search/v2', {
      keyword: title,
      page: 1,
      perPage: 15,
      subjectType: isTv ? 2 : 1,
    });
    primarySubjects = (res?.data?.results || []).flatMap((r) => r.subjects || []);
  } catch (e) {}

  // 2. Search French version title to catch MovieBox dedicated French dub subjects
  let frenchSubjects = [];
  try {
    const res = await executeApi('POST', '/wefeed-mobile-bff/subject-api/search/v2', {
      keyword: `${title} [Version française]`,
      page: 1,
      perPage: 10,
      subjectType: isTv ? 2 : 1,
    });
    frenchSubjects = (res?.data?.results || []).flatMap((r) => r.subjects || []);
  } catch (e) {}

  const allCandidates = [...frenchSubjects, ...primarySubjects];

  let bestPrimary = null;
  let bestFrench = null;

  for (const s of allCandidates) {
    const cleaned = cleanMovieboxTitle(s.title);
    const cleanedNorm = norm(cleaned);
    const sYear = s.releaseDate ? parseInt(s.releaseDate.slice(0, 4), 10) : null;
    const yearMatch = !year || !sYear || Math.abs(sYear - year) <= 1;
    const titleExact = cleanedNorm === targetNorm || (targetOrigNorm && cleanedNorm === targetOrigNorm);

    if (isTv) {
      if (titleExact) {
        if (matchesSeason(s.title, season)) {
          if (/version fran/i.test(s.title) && !bestFrench) {
            bestFrench = s;
          } else if (!bestPrimary) {
            bestPrimary = s;
          }
        }
      }
    } else {
      if (titleExact && yearMatch) {
        if (/version fran/i.test(s.title) && !bestFrench) {
          bestFrench = s;
        } else if (!bestPrimary) {
          bestPrimary = s;
        }
      }
    }
  }

  const primarySubjectId = (bestPrimary || bestFrench)?.subjectId || null;
  return {
    subjectId: primarySubjectId ? String(primarySubjectId) : null,
    frenchSubjectId: bestFrench?.subjectId ? String(bestFrench.subjectId) : null,
    standardSubjectId: bestPrimary?.subjectId ? String(bestPrimary.subjectId) : null,
  };
}

// Enrich existing mapped entry with French dubs if missing
async function enrichDubsWithFrench(title, year, isTv, season, currentDubs = []) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetNorm = norm(title);
  try {
    const res = await executeApi('POST', '/wefeed-mobile-bff/subject-api/search/v2', {
      keyword: `${title} [Version française]`,
      page: 1,
      perPage: 10,
      subjectType: isTv ? 2 : 1,
    });
    const subjects = (res?.data?.results || []).flatMap((r) => r.subjects || []);
    for (const s of subjects) {
      const cleaned = cleanMovieboxTitle(s.title);
      const cleanedNorm = norm(cleaned);
      const sYear = s.releaseDate ? parseInt(s.releaseDate.slice(0, 4), 10) : null;
      const yearMatch = !year || !sYear || Math.abs(sYear - year) <= 1;
      const titleExact = cleanedNorm === targetNorm;

      if (isTv) {
        if (titleExact && matchesSeason(s.title, season) && /version fran/i.test(s.title)) {
          const fDubs = await fetchSubjectDubs(s.subjectId);
          return mergeDubsLists(currentDubs, fDubs);
        }
      } else {
        if (titleExact && yearMatch && /version fran/i.test(s.title)) {
          const fDubs = await fetchSubjectDubs(s.subjectId);
          return mergeDubsLists(currentDubs, fDubs);
        }
      }
    }
  } catch (e) {}
  return currentDubs;
}

// --- Subject Details & Dubs Metadata ---
async function fetchSubjectDubs(subjectId) {
  const sid = typeof subjectId === 'object' && subjectId !== null
    ? String(subjectId.subjectId || subjectId.standardSubjectId || '')
    : String(subjectId || '');
  if (!sid) return [];
  try {
    const data = await executeApi('GET', `/wefeed-mobile-bff/subject-api/get?subjectId=${sid}`);
    const rawDubs = data?.data?.dubs || [];
    const hasOriginal = rawDubs.some((d) => d.original || String(d.subjectId) === sid);

    const list = rawDubs.map((d) => {
      const lanName = d.lanName || d.title || 'Original Audio';
      const isSub = d.type === 1 || lanName.toLowerCase().includes('sub');
      return {
        subjectId: String(d.subjectId || sid),
        lanName,
        lanCode: normalizeLangCode(d.lanCode || lanName),
        original: Boolean(d.original),
        isSub,
      };
    });

    if (!hasOriginal) {
      list.unshift({
        subjectId: sid,
        lanName: 'Original Audio',
        lanCode: 'en',
        original: true,
        isSub: false,
      });
    }

    return list;
  } catch (e) {
    return [{ subjectId: sid, lanName: 'Original Audio', lanCode: 'en', original: true, isSub: false }];
  }
}

// Normalize MovieBox language codes to standard ISO codes
function normalizeLangCode(rawCode = '') {
  const lower = (rawCode || '').toLowerCase().trim();
  if (lower === 'esla' || lower.includes('spanish')) return 'es';
  if (lower === 'ptbr' || lower.includes('portugu')) return 'pt';
  if (lower.includes('french') || lower.includes('franç') || lower === 'fr' || lower === 'fre') return 'fr';
  if (lower.includes('hindi') || lower === 'hi') return 'hi';
  if (lower.includes('arabic') || lower === 'ar') return 'ar';
  if (lower.includes('tamil') || lower === 'ta') return 'ta';
  if (lower.includes('telugu') || lower === 'te') return 'te';
  if (lower.includes('german') || lower === 'de') return 'de';
  if (lower.includes('italian') || lower === 'it') return 'it';
  if (lower.includes('russian') || lower === 'ru') return 'ru';
  if (lower.includes('japanese') || lower === 'ja') return 'ja';
  if (lower.includes('korean') || lower === 'ko') return 'ko';
  if (lower.includes('turkish') || lower === 'tr') return 'tr';
  if (lower.includes('polish') || lower === 'pl') return 'pl';
  if (lower.includes('dutch') || lower === 'nl') return 'nl';
  if (lower.includes('swedish') || lower === 'sv') return 'sv';
  if (lower.includes('thai') || lower === 'th') return 'th';
  if (lower.includes('vietnam') || lower === 'vi') return 'vi';
  if (lower.includes('bengali') || lower === 'bn') return 'bn';
  if (lower.includes('malayalam') || lower === 'ml') return 'ml';
  if (lower.includes('kannada') || lower === 'kn') return 'kn';
  if (lower.includes('marathi') || lower === 'mr') return 'mr';
  if (lower.includes('urdu') || lower === 'ur') return 'ur';
  if (lower.includes('punjabi') || lower === 'pa') return 'pa';
  if (lower === 'in' || lower.includes('indonesian')) return 'id';
  if (lower === 'fil' || lower.includes('filipino')) return 'fil';
  if (lower.includes('original') || lower === 'en') return 'en';
  return lower.slice(0, 3) || 'en';
}

function normalizeLangLabel(code, rawName, isSub = false) {
  if (code === 'en') return 'Original (VO)';
  const tag = isSub ? 'Sub' : 'Dub';
  switch (code) {
    case 'fr': return `French (${tag})`;
    case 'es': return `Spanish (${tag})`;
    case 'pt': return `Portuguese (${tag})`;
    case 'hi': return `Hindi (${tag})`;
    case 'de': return `German (${tag})`;
    case 'it': return `Italian (${tag})`;
    case 'ar': return `Arabic (${tag})`;
    case 'ta': return `Tamil (${tag})`;
    case 'te': return `Telugu (${tag})`;
    case 'ru': return `Russian (${tag})`;
    case 'ja': return `Japanese (${tag})`;
    case 'ko': return `Korean (${tag})`;
    case 'tr': return `Turkish (${tag})`;
    case 'pl': return `Polish (${tag})`;
    case 'nl': return `Dutch (${tag})`;
    case 'sv': return `Swedish (${tag})`;
    case 'th': return `Thai (${tag})`;
    case 'vi': return `Vietnamese (${tag})`;
    case 'bn': return `Bengali (${tag})`;
    case 'ml': return `Malayalam (${tag})`;
    case 'kn': return `Kannada (${tag})`;
    case 'mr': return `Marathi (${tag})`;
    case 'ur': return `Urdu (${tag})`;
    case 'pa': return `Punjabi (${tag})`;
    case 'id': return `Indonesian (${tag})`;
    case 'fil': return `Filipino (${tag})`;
    default: return `${rawName || 'Dub'} (${tag})`;
  }
}

// --- Subtitles Fetcher with adapt.rs filters ---
async function fetchExtCaptions(subjectId, resourceId) {
  const cacheKey = `${subjectId}:${resourceId}`;
  if (subtitlesMemoryCache.has(cacheKey)) {
    return subtitlesMemoryCache.get(cacheKey);
  }

  try {
    const data = await executeApi(
      'GET',
      `/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${subjectId}&resourceId=${resourceId}`
    );
    const extCaptions = data?.data?.extCaptions || [];
    const formatted = [];
    const seenUrls = new Set();

    for (const cap of extCaptions) {
      const url = cap.url;
      if (!url || seenUrls.has(url)) continue;
      // Filter notice or bad subtitle URLs from adapt.rs
      if (url.includes('aa348f2541d13ffe')) continue;

      const size = parseInt(cap.size || '0', 10);
      if (size > 0 && size <= 50) continue;

      const rawName = cap.lanName || cap.lan || 'Unknown';
      if (rawName.toLowerCase() === 'in' && (size === 0 || size <= 100)) continue;

      seenUrls.add(url);
      const code = normalizeLangCode(cap.lan || cap.lanName);

      formatted.push({
        id: `mb-sub-${cap.id || formatted.length}`,
        url,
        lang: code,
        label: rawName,
        default: code === 'en',
      });
    }

    subtitlesMemoryCache.set(cacheKey, formatted);
    return formatted;
  } catch (e) {
    return [];
  }
}

// --- Stream Resolver ---
async function getMovieBoxStreams(tmdbId, mediaType = 'movie', season = 1, episode = 1, requestedLang = null, clientGeo = null) {
  const isTv = mediaType === 'tv';
  const seasonNum = isTv ? Number(season || 1) : 0;
  const epNum = isTv ? Number(episode || 1) : 0;
  const mapKey = isTv ? `tv:${tmdbId}:s${seasonNum}` : `movie:${tmdbId}`;

  // Automatically resolve client geolocation if not explicitly provided
  if (!clientGeo || !clientGeo.ip) {
    try {
      const geo = await fetchGeoData(clientGeo?.ip || null);
      if (geo) {
        clientGeo = {
          ip: geo.ip,
          country_code: geo.country_code,
          timezone: geo.timezone,
        };
      }
    } catch {}
  }

  // 1. Instant Cache Hit Check from moviebox_map.json (0ms, 0 network requests if fresh)
  const map = loadMap();
  let mapEntry = map[mapKey];

  if (mapEntry && mapEntry.subjectId) {
    if (typeof mapEntry.subjectId === 'object') {
      mapEntry.subjectId = mapEntry.subjectId.standardSubjectId || mapEntry.subjectId.subjectId;
    }
    // Check if French dub is missing and can be enriched
    const hasFrench = Array.isArray(mapEntry.dubs) && mapEntry.dubs.some((d) => d.lanCode === 'fr');
    if (!hasFrench && mapEntry.title) {
      try {
        const enrichedDubs = await enrichDubsWithFrench(mapEntry.title, mapEntry.year, isTv, seasonNum, mapEntry.dubs || []);
        if (enrichedDubs.some((d) => d.lanCode === 'fr')) {
          mapEntry.dubs = enrichedDubs;
          map[mapKey] = mapEntry;
          saveMap(map);
        }
      } catch (e) {}
    }

    // Check if cached streams are fresh and unexpired
    const cachedStreams = !isTv ? mapEntry.streams : mapEntry.episodes?.[epNum]?.streams;
    const savedAt = !isTv ? mapEntry.savedAt : mapEntry.episodes?.[epNum]?.savedAt;

    if (areStreamsFresh(cachedStreams, savedAt)) {
      return cachedStreams;
    }
  }

  // 2. Fetch TMDB Details if needed for search
  const tmdbDetails = await getDetails(isTv ? 'tv' : 'movie', tmdbId);
  if (!tmdbDetails && (!mapEntry || !mapEntry.subjectId)) return [];

  // 3. Resolve exact match via API search if not mapped yet
  if (!mapEntry || !mapEntry.subjectId) {
    try {
      const searchRes = await searchExactSubject(tmdbDetails, mediaType, seasonNum);
      const subjectId = searchRes?.subjectId;
      if (subjectId) {
        // Fetch and merge dubs from both French and standard subjects to get every language
        let dubs = [];
        if (searchRes.frenchSubjectId) {
          const fDubs = await fetchSubjectDubs(searchRes.frenchSubjectId);
          dubs = mergeDubsLists(dubs, fDubs);
        }
        if (searchRes.standardSubjectId && searchRes.standardSubjectId !== searchRes.frenchSubjectId) {
          const sDubs = await fetchSubjectDubs(searchRes.standardSubjectId);
          dubs = mergeDubsLists(dubs, sDubs);
        }
        if (dubs.length === 0) {
          dubs = await fetchSubjectDubs(subjectId);
        }

        mapEntry = {
          subjectId,
          title: tmdbDetails.title || tmdbDetails.name,
          year: parseInt((tmdbDetails.release_date || tmdbDetails.first_air_date || '').slice(0, 4), 10) || null,
          type: mediaType,
          ...(isTv ? { season: seasonNum } : {}),
          dubs,
          mappedAt: Date.now(),
        };
        map[mapKey] = mapEntry;
        saveMap(map);
      }
    } catch (err) {
      console.warn(`[MovieBox] Search lookup failed for ${mapKey}:`, err.message);
    }
  }

  if (!mapEntry || !mapEntry.subjectId) {
    return [];
  }

  // Ensure dubs are present in mapEntry
  if (!Array.isArray(mapEntry.dubs) || mapEntry.dubs.length === 0) {
    mapEntry.dubs = await fetchSubjectDubs(mapEntry.subjectId);
    map[mapKey] = mapEntry;
    saveMap(map);
  }

  // 4. Collect all dubs (include all available languages without arbitrary small caps)
  const allDubs = mapEntry.dubs;
  const dubsToFetch = [...allDubs];

  // 5. Fetch fresh resources for all dubs in controlled batches with round-robin pool to avoid 429 rate limits
  const resourceIdsToTryCaptions = [];
  const dubResults = [];

  for (let i = 0; i < dubsToFetch.length; i += 2) {
    const batch = dubsToFetch.slice(i, i + 2);
    const batchResults = await Promise.all(
      batch.map(async (dub) => {
        try {
          const resPath = `/wefeed-mobile-bff/subject-api/resource?subjectId=${dub.subjectId}&se=${seasonNum}&ep=${epNum}`;
          const resData = await executeApi('GET', resPath, null, clientGeo);
          const list = resData?.data?.list || [];
          const validItems = [];
          for (const item of list) {
            const rLink = item.resourceLink || item.url;
            if (rLink && !isDeprecationNoticeUrl(rLink) && !rLink.includes('.mpd')) {
              if (item.resourceId) {
                resourceIdsToTryCaptions.push({ subjectId: dub.subjectId, resourceId: item.resourceId, isOriginal: dub.original });
              }
              validItems.push({
                url: rLink,
                resolution: item.resolution ? String(item.resolution) : '1080',
                signCookie: item.signCookie || '',
              });
            }
          }
          return { dub, items: validItems };
        } catch (e) {
          return { dub, items: [] };
        }
      })
    );
    dubResults.push(...batchResults);
    if (i + 2 < dubsToFetch.length) {
      await new Promise((r) => setTimeout(r, 80)); // 80ms gentle throttle between dub batches
    }
  }

  // 6. Fetch and merge subtitles across resource candidates (original audio first)
  const seenSubLangs = new Set();
  const mergedSubtitles = [];
  resourceIdsToTryCaptions.sort((a, b) => (b.isOriginal ? 1 : 0) - (a.isOriginal ? 1 : 0));
  for (const { subjectId, resourceId } of resourceIdsToTryCaptions) {
    const caps = await fetchExtCaptions(subjectId, resourceId);
    for (const sub of caps) {
      const code = (sub.lang || sub.label || '').toLowerCase();
      if (code && !seenSubLangs.has(code)) {
        seenSubLangs.add(code);
        mergedSubtitles.push(sub);
      }
    }
    if (mergedSubtitles.length >= 15) break;
  }
  let subtitles = mergedSubtitles;

  // 7. Build StreamItem list with fresh signed URLs
  const identity = getClientIdentity(clientGeo);
  const directPlayback = shouldDirectPlay();
  const allStreams = [];
  const seenUrls = new Set();

  for (const { dub, items } of dubResults) {
    // Sort items of this dub descending by resolution
    items.sort((a, b) => {
      const resA = parseInt(String(a.resolution).match(/\d+/)?.[0] || '0', 10);
      const resB = parseInt(String(b.resolution).match(/\d+/)?.[0] || '0', 10);
      return resB - resA;
    });

    // Deduplicate by resolution so we keep only the single best stream per quality level for this dub
    const seenResolutions = new Set();

    for (let idx = 0; idx < items.length; idx++) {
      const s = items[idx];
      const base = s.url.split('?')[0];
      if (seenUrls.has(base)) continue;

      const resNum = parseInt(String(s.resolution).match(/\d+/)?.[0] || '1080', 10);
      if (seenResolutions.has(resNum)) continue;

      seenUrls.add(base);
      seenResolutions.add(resNum);

      const q = `${resNum}p`;
      const label = normalizeLangLabel(dub.lanCode, dub.lanName, dub.isSub);

      allStreams.push({
        id: `moviebox-${dub.lanCode}-${resNum}-${idx}`,
        name: `MovieBox · ${q} · ${label}`,
        title: `MovieBox · ${q} · ${label}`,
        url: s.url,
        quality: q,
        qualityLabel: q,
        lang: dub.lanCode,
        langLabel: label,
        version: dub.original ? 'vo' : 'dub',
        provider: 'MovieBox',
        server: 'MovieBox',
        serverName: 'MovieBox',
        type: 'mp4',
        direct: directPlayback,
        subtitles,
        headers: {
          'User-Agent': identity.userAgent,
          ...(s.signCookie ? { Cookie: s.signCookie } : {}),
        },
      });
    }
  }

  // 8. Persist direct stream links and subtitles in moviebox_map.json with fresh savedAt timestamp
  if (allStreams.length > 0) {
    if (!isTv) {
      mapEntry.streams = allStreams;
      mapEntry.subtitles = subtitles;
      mapEntry.savedAt = Date.now();
    } else {
      if (!mapEntry.episodes) mapEntry.episodes = {};
      mapEntry.episodes[epNum] = {
        streams: allStreams,
        subtitles,
        savedAt: Date.now(),
      };
    }
    map[mapKey] = mapEntry;
    saveMap(map);
  }

  // 9. If a specific language was requested, prioritize it
  if (requestedLang && allStreams.length > 0) {
    const targetLang = normalizeLangCode(requestedLang);
    allStreams.sort((a, b) => {
      const matchA = a.lang === targetLang ? 1 : 0;
      const matchB = b.lang === targetLang ? 1 : 0;
      return matchB - matchA;
    });
  }

  return allStreams;
}

module.exports = {
  getMovieBoxStreams,
  buildSignedHeaders,
  generateXClientBuild,
  generateXClientToken,
  generateXTrSignature,
  randomSpoofedIp,
  cleanMovieboxTitle,
  fetchGeoData,
  ensureSession,
  executeApi,
  HOST_POOL,
};
