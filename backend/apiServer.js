require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
const path = require('path');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId } = require('./utils/tmdb');
const { applyFilters, maskStreams, getCodename } = require('./utils/streamFilters');
const { fetchAniZipMappings } = require('./providers/megaplay');
const { validateOriginMiddleware } = require('./utils/origin');
const {
  isTurnstileEnabled,
  signProof,
  verifyTurnstileToken,
  turnstileMiddleware,
} = require('./utils/turnstile');

const app = express();
app.set('trust proxy', 1);

// Mount proxy routes early so downstream handlers and clients can use them
if (config.enableProxy !== false) {
  console.log('[startup] mounting proxy routes (/m3u8-proxy, /ts-proxy, /sub-proxy)');
  createProxyRoutes(app);
} else {
  console.log('[startup] enableProxy flag explicitly false: proxy routes not mounted');
}

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count: 1, first: now, last: now, lockedUntil: 0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  // Reset window if outside timeframe and not locked
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over - 1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordLoginSuccess(ip) {
  // On success clear state to avoid lingering count
  loginAttempts.delete(ip);
}

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function (code) {
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(() => console.log('[diagnostic] post-start setImmediate fired'));

// Origin & CORS security guard based on ALLOWED_ORIGINS
const apiOriginGuard = validateOriginMiddleware({
  getAllowedOrigins: () => config.allowedOrigins,
  getBlockNoOrigin: () => config.blockNoOrigin
});
app.use(apiOriginGuard);
app.use(express.json());

// --- Admin Dashboard Security & Gate ---
const ENABLE_ADMIN_DASHBOARD = config.enableAdminDashboard === true;
const ADMIN_SECRET_KEY = (config.adminSecretKey || '').trim();

function adminGate(req, res, next) {
  if (!ENABLE_ADMIN_DASHBOARD) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND' });
  }
  if (!ADMIN_SECRET_KEY) {
    return next();
  }
  const queryKey = req.query.key || req.query.admin_key;
  if (queryKey && queryKey === ADMIN_SECRET_KEY) {
    res.setHeader('Set-Cookie', `admin_gate_key=${encodeURIComponent(ADMIN_SECRET_KEY)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
    return next();
  }
  const cookies = req.headers.cookie || '';
  const expectedCookie = `admin_gate_key=${encodeURIComponent(ADMIN_SECRET_KEY)}`;
  const hasGateCookie = cookies.includes(expectedCookie) || cookies.includes(`admin_gate_key=${ADMIN_SECRET_KEY}`);
  const headerKey = req.headers['x-admin-key'];
  if (hasGateCookie || (headerKey && headerKey === ADMIN_SECRET_KEY)) {
    return next();
  }
  return res.status(404).json({ success: false, error: 'NOT_FOUND' });
}

// --- Auth Routes ---
if (ENABLE_ADMIN_DASHBOARD) {
  app.post('/auth/login', adminGate, (req, res) => {
    const { username, password } = req.body || {};
    const ip = getClientIp(req);
    const attemptState = canAttempt(ip);
    if (!attemptState.allowed) {
      res.setHeader('Retry-After', String(attemptState.retryAfter));
      return res.status(429).json({ success: false, error: 'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
    }
    if (!username || !password) return res.status(400).json({ success: false, error: 'MISSING_CREDENTIALS' });
    if (!authenticate(username, password)) {
      const entry = recordLoginFailure(ip);
      if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
        const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ success: false, error: 'LOCKED', retryAfter });
      }
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
    }
    recordLoginSuccess(ip);
    const token = issueSession(username);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 60 * 60}`);
    res.json({ success: true, username });
  });

  app.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
  });

  app.get('/auth/session', adminGate, (req, res) => {
    const sess = getSession(req);
    if (!sess) return res.json({ authenticated: false });
    res.json({ authenticated: true, username: sess.u });
  });

  app.post('/auth/change-password', adminGate, requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
    const sess = req.session;
    if (!authenticate(sess.u, oldPassword)) return res.status(401).json({ success: false, error: 'INVALID_OLD_PASSWORD' });
    if (newPassword.length < 8) return res.status(400).json({ success: false, error: 'PASSWORD_TOO_SHORT' });
    if (!updatePassword(sess.u, newPassword)) return res.status(500).json({ success: false, error: 'UPDATE_FAILED' });
    res.json({ success: true, message: 'PASSWORD_UPDATED' });
  });
} else {
  app.all('/auth/*', (req, res) => res.status(404).json({ success: false, error: 'NOT_FOUND' }));
}

// Config panel (HTML) route
app.get('/config.html', adminGate, (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.redirect(302, '/');
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// Explicit root handler: returns neutral operational JSON by default; serves login only if enabled & gated
app.get('/', (req, res) => {
  if (ENABLE_ADMIN_DASHBOARD) {
    const cookies = req.headers.cookie || '';
    const queryKey = req.query.key || req.query.admin_key;
    const isUnlocked = !ADMIN_SECRET_KEY ||
      (queryKey && queryKey === ADMIN_SECRET_KEY) ||
      cookies.includes(`admin_gate_key=${encodeURIComponent(ADMIN_SECRET_KEY)}`) ||
      cookies.includes(`admin_gate_key=${ADMIN_SECRET_KEY}`);

    if (isUnlocked) {
      if (queryKey && queryKey === ADMIN_SECRET_KEY) {
        res.setHeader('Set-Cookie', `admin_gate_key=${encodeURIComponent(ADMIN_SECRET_KEY)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      }
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  }

  res.json({ ok: true, status: 'operational', time: new Date().toISOString() });
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  console.log('[diagnostic] exit code=', code);
});
process.on('uncaughtException', (err) => {
  console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[diagnostic] unhandledRejection', reason);
});
// Periodic heartbeat to confirm event loop activity (can be removed later)
let hbCount = 0;
setInterval(() => {
  hbCount++;
  if (hbCount % 6 === 0) { // every 60s if interval is 10s
    console.log('[diagnostic] heartbeat 60s elapsed, process alive');
  }
}, 10_000).unref();


// --- Metrics (in-memory) ---
const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0
};

app.use((req, res, next) => { metrics.requestsTotal++; metrics.lastRequestAt = Date.now(); next(); });
// Serve static UI assets only if admin dashboard is enabled and unlocked
if (ENABLE_ADMIN_DASHBOARD) {
  app.use(adminGate, express.static(path.join(__dirname, 'public')));
}

// Config & Server Control APIs (strictly require admin dashboard enabled + gate + auth)
if (ENABLE_ADMIN_DASHBOARD) {
  app.get('/api/config', adminGate, requireAuth, (req, res) => {
    const fs = require('fs');
    let override = {};
    try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8')); } catch (e) {
      // ignore JSON parse or fs errors reading override; return base config
    }
    res.json({ success: true, merged: config, override, overridePath: OVERRIDE_PATH });
  });

  app.post('/api/config', adminGate, requireAuth, (req, res) => {
    const patch = req.body || {};
    if (patch.port) {
      const p = Number(patch.port); if (!Number.isFinite(p) || p <= 0 || p > 65535) return res.status(400).json({ success: false, error: 'INVALID_PORT' });
      patch.port = p;
    }
    if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success: false, error: 'DEFAULT_PROVIDERS_NOT_ARRAY' });
    const ok = saveConfigPatch(patch);
    res.json({ success: ok, merged: config });
  });

  app.post('/api/restart', adminGate, requireAuth, (req, res) => {
    const sess = getSession(req);
    if (!sess) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    res.json({ success: true, message: 'RESTARTING' });
    // Give the response a moment to flush
    setTimeout(() => {
      try {
        const fs = require('fs');
        const restartMarker = require('path').join(process.cwd(), 'restart.trigger');
        fs.writeFileSync(restartMarker, String(Date.now()));
        console.warn('[control] wrote restart.trigger to notify nodemon');
      } catch (e) {
        console.warn('[control] failed to write restart marker:', e.message);
      }
      console.warn('[control] restarting process by exit(0)');
      // Let nodemon detect the file change and restart the app
      allowControlledExit = true;
      realProcessExit(0);
    }, 300);
  });
} else {
  app.all(['/api/config', '/api/restart'], (req, res) => {
    res.status(404).json({ success: false, error: 'NOT_FOUND' });
  });
}

// --- Public Health Endpoint (always available for platform & uptime checks) ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tmdb-embed-api', time: new Date().toISOString() });
});

// --- Metrics, Status & Provider Information (locked down behind adminGate + auth) ---
if (ENABLE_ADMIN_DASHBOARD) {
  // Metrics endpoint
  app.get('/api/metrics', adminGate, requireAuth, (req, res) => {
    res.json({
      uptimeSeconds: Math.round((Date.now() - metrics.startTime) / 1000),
      requestsTotal: metrics.requestsTotal,
      streamRequests: metrics.streamRequests,
      providerCalls: metrics.providerCalls,
      streamsReturned: metrics.streamsReturned,
      tmdbToImdbLookups: metrics.tmdbToImdbLookups,
      lastRequestAt: metrics.lastRequestAt,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      loadAvg: os.loadavg ? os.loadavg() : [],
      nodeVersion: process.version,
      configDefaults: {
        region: config.defaultRegion,
        providers: config.defaultProviders,
        minQualities: config.minQualities ? Object.keys(config.minQualities).length : 0,
        excludeCodecs: config.excludeCodecs ? Object.keys(config.excludeCodecs).filter(k => config.excludeCodecs[k]).length : 0,
        febboxCookies: config.febboxCookies.length
      }
    });
  });

  // Consolidated status (metrics + providers + endpoints)
  app.get('/api/status', adminGate, requireAuth, (req, res) => {
    const endpoints = [
      'GET /api/health',
      'GET /api/metrics',
      'GET /api/status',
      'GET /api/providers',
      'GET /api/providers/:name',
      'GET /api/streams/:type/:tmdbId',
      'GET /api/streams/:provider/:type/:tmdbId',
      'POST /api/config',
      'GET /api/config'
    ];
    // Determine cookie requirement heuristically (currently Showbox / PStream)
    const cookieRequiredProviders = new Set(['showbox']);
    const providers = listProviders().map(p => {
      const cookieRequired = cookieRequiredProviders.has(p.name);
      const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
      return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk };
    });
    res.json({
      success: true, providerCheckTmdbId: config.providerCheckTmdbId, metrics: {
        uptimeSeconds: Math.round((Date.now() - metrics.startTime) / 1000),
        requestsTotal: metrics.requestsTotal,
        streamRequests: metrics.streamRequests,
        providerCalls: metrics.providerCalls,
        streamsReturned: metrics.streamsReturned,
        tmdbToImdbLookups: metrics.tmdbToImdbLookups,
        lastRequestAt: metrics.lastRequestAt,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
      }, endpoints, providers
    });
  });

  // Providers list
  app.get('/api/providers', adminGate, requireAuth, (req, res) => {
    res.json({ success: true, providers: listProviders() });
  });

  // Debug environment/config endpoint (do not expose publicly in production)
  app.get('/api/debug/env', adminGate, requireAuth, (req, res) => {
    const cookieStats = getCookieStats ? getCookieStats() : null;
    res.json({
      port: config.port,
      defaultProviders: config.defaultProviders,
      febboxCookieCount: config.febboxCookies.length,
      showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || '(os tmp)',
      nodeVersion: process.version,
      cookieStats
    });
  });

  // Single provider info
  app.get('/api/providers/:name', adminGate, requireAuth, (req, res) => {
    const p = getProvider(req.params.name);
    if (!p) return res.status(404).json({ success: false, error: 'PROVIDER_NOT_FOUND' });
    res.json({ success: true, provider: { name: p.name, enabled: p.enabled } });
  });
} else {
  app.all(['/api/metrics', '/api/status', '/api/providers', '/api/providers/*', '/api/debug/env'], (req, res) => {
    res.status(404).json({ success: false, error: 'NOT_FOUND' });
  });
}

// Helper to extract client geo from request / headers / query params
function extractClientGeo(req) {
  const ip = req.query.clientIp ||
    (typeof req.headers['x-client-ip'] === 'string' ? req.headers['x-client-ip'] : null) ||
    (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) ||
    (req.socket ? req.socket.remoteAddress : null) || '127.0.0.1';
  const country_code = req.query.region || req.headers['x-client-country'] || null;
  const timezone = req.query.timezone || req.headers['x-client-timezone'] || null;
  return { ip, country_code, timezone };
}

// MovieBox Client-Side Signing & Geo Endpoint
app.get(['/api/moviebox/client-headers', '/api/box/client-headers'], async (req, res) => {
  try {
    const moviebox = require('./providers/moviebox');
    const targetUrl = req.query.url || `${moviebox.HOST_POOL[0]}/wefeed-mobile-bff/user-api/visitor-login`;
    const method = (req.query.method || 'GET').toUpperCase();
    const body = req.query.body || null;

    const geoParam = extractClientGeo(req);
    let geo = null;
    if (geoParam.country_code && geoParam.timezone) {
      geo = geoParam;
    } else {
      geo = await moviebox.fetchGeoData(geoParam.ip).catch(() => null);
      if (!geo && geoParam.ip) geo = geoParam;
    }

    const token = await moviebox.ensureSession();
    const headers = moviebox.buildSignedHeaders(method, targetUrl, body, token, geo);

    res.json({
      success: true,
      url: targetUrl,
      method,
      headers,
      geo: geo || { ip: geoParam.ip },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cloudflare Turnstile verification endpoint (mints short-lived HMAC proof)
app.post('/api/turnstile/verify', async (req, res) => {
  if (!isTurnstileEnabled()) {
    const issued = signProof();
    return res.json({ success: true, bypass: true, ...issued });
  }
  const token = req.body?.token || req.headers['x-turnstile-token'];
  if (!token) {
    return res.status(400).json({ success: false, error: 'MISSING_TOKEN' });
  }
  try {
    const check = await verifyTurnstileToken(String(token), getClientIp(req));
    if (!check.success) {
      return res.status(403).json({ success: false, error: check.error || 'TURNSTILE_FAILED', codes: check.codes || [] });
    }
    const issued = signProof();
    return res.json({ success: true, ...issued });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Anime-first aggregate: AniList ID is the primary key ─────────────────────
// Flow:
//   1. MegaPlay is called immediately with the AniList ID (no TMDB lookup needed)
//   2. ani.zip resolves the TMDB ID in parallel
//   3. All other enabled providers are called with the resolved TMDB ID + forceAnime=true
//   4. All streams are merged, filtered, proxy-wrapped and returned
app.get('/api/streams/anime/:anilistId', turnstileMiddleware, async (req, res) => {
  const { anilistId } = req.params;
  const anilistIdNum = Number(anilistId);
  if (!anilistIdNum || isNaN(anilistIdNum)) {
    return res.status(400).json({ success: false, error: 'INVALID_ANILIST_ID' });
  }

  const episode = req.query.episode ? Number(req.query.episode) : 1;
  const season  = req.query.season  ? Number(req.query.season)  : 1;
  const malId   = req.query.malId   ? Number(req.query.malId)   : null;
  const clientGeo = extractClientGeo(req);

  try {
    metrics.streamRequests++;

    // 1. Kick off ani.zip mapping to get TMDB ID (runs in parallel with MegaPlay)
    const aniZipPromise = fetchAniZipMappings('anilist_id', anilistIdNum).catch(() => null);

    // 2. Identify all enabled providers
    const selectedProviders = config.defaultProviders.length
      ? config.defaultProviders
      : listProviders().map(p => p.name);

    const providerTimings = {};

    // 3. For anime, use MegaPlay (AniList-first) and Vidzy (mapped via ani.zip -> TMDB) only
    const ANIME_TMDB_PROVIDERS = new Set(['vidzy']);
    const megaprovider = getProvider('megaplay');
    const otherProviders = selectedProviders.filter(name => {
      if (!ANIME_TMDB_PROVIDERS.has(name)) return false;
      const p = getProvider(name);
      return p && p.enabled;
    });

    // Run MegaPlay immediately
    const megaPromise = (megaprovider && megaprovider.enabled) ? (async () => {
      metrics.providerCalls['megaplay'] = (metrics.providerCalls['megaplay'] || 0) + 1;
      const t0 = Date.now();
      try {
        console.log(`[api/anime] invoking megaplay for anilistId=${anilistIdNum} ep${episode}`);
        const r = await megaprovider.fetch({
          tmdbId: anilistIdNum, // passed as fallback; megaplay.js reads ctx.anilistId first
          type: 'series',
          season,
          episode,
          lang: req.query.lang,
          clientGeo,
          anilistId: anilistIdNum,
          malId,
          subType: req.query.subType || null,
          forceAnime: true,
          filters: {}
        });
        providerTimings['megaplay'] = Date.now() - t0;
        console.log(`[api/anime] megaplay returned ${Array.isArray(r) ? r.length : 0} streams`);
        return Array.isArray(r) ? r : [];
      } catch (e) {
        console.error('[api/anime] megaplay failed:', e.message);
        providerTimings['megaplay'] = null;
        return [];
      }
    })() : Promise.resolve([]);

    // Wait for ani.zip to get TMDB ID, then run other providers
    const othersPromise = (async () => {
      const aniZip = await aniZipPromise;
      const tmdbId = aniZip?.mappings?.themoviedb_id
        ? String(aniZip.mappings.themoviedb_id)
        : null;
      const imdbId = tmdbId ? await resolveImdbId('tv', tmdbId).catch(() => null) : null;

      if (!tmdbId || !otherProviders.length) return [];

      console.log(`[api/anime] anilistId=${anilistIdNum} → tmdbId=${tmdbId} via ani.zip`);

      const results = await Promise.all(otherProviders.map(async name => {
        const prov = getProvider(name);
        if (!prov || !prov.enabled) return [];
        metrics.providerCalls[name] = (metrics.providerCalls[name] || 0) + 1;
        const t0 = Date.now();
        try {
          console.log(`[api/anime] invoking provider ${name} for tmdbId=${tmdbId}`);
          const r = await prov.fetch({
            tmdbId,
            type: 'series',
            season,
            episode,
            imdbId,
            lang: req.query.lang,
            clientGeo,
            anilistId: anilistIdNum,
            malId,
            subType: req.query.subType || null,
            forceAnime: true,
            filters: {}
          });
          providerTimings[name] = Date.now() - t0;
          console.log(`[api/anime] provider ${name} returned ${Array.isArray(r) ? r.length : 0} streams`);
          return Array.isArray(r) ? r : [];
        } catch (e) {
          console.error(`[api/anime] provider ${name} failed:`, e.message);
          providerTimings[name] = null;
          return [];
        }
      }));
      return results.flat();
    })();

    // 4. Collect all streams
    const [megaStreams, otherStreams] = await Promise.all([megaPromise, othersPromise]);
    let streams = [...megaStreams, ...otherStreams];
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;

    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
    }
    streams = maskStreams(streams);

    const maskedTimings = {};
    for (const [k, v] of Object.entries(providerTimings)) {
      maskedTimings[getCodename(k).toLowerCase()] = v;
    }

    res.json({ success: true, anilistId: anilistIdNum, count: streams.length, providerTimings: maskedTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// Aggregate streams across all enabled providers
app.get('/api/streams/:type/:tmdbId', turnstileMiddleware, async (req, res) => {
  const { type, tmdbId } = req.params;
  if (!['movie', 'series'].includes(type)) return res.status(400).json({ success: false, error: 'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const clientGeo = extractClientGeo(req);
  try {
    metrics.streamRequests++;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const isAnimeRequest = req.query.anime === '1' || req.query.anime === 'true' || Boolean(req.query.anilistId);
    const selectedProviders = (config.defaultProviders.length ? config.defaultProviders : listProviders().map(p => p.name))
      .filter(name => isAnimeRequest || name !== 'megaplay');
    const providerTimings = {};
    const results = await Promise.all(selectedProviders.map(async name => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) return [];
      metrics.providerCalls[name] = (metrics.providerCalls[name] || 0) + 1;
      try {
        console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        const t0 = Date.now();
        const r = await prov.fetch({
          tmdbId,
          type,
          season,
          episode,
          imdbId,
          lang: req.query.lang,
          clientGeo,
          anilistId: req.query.anilistId ? Number(req.query.anilistId) : null,
          malId: req.query.malId ? Number(req.query.malId) : null,
          subType: req.query.subType || (req.query.type === 'sub' || req.query.type === 'dub' ? req.query.type : null),
          forceAnime: req.query.anime === '1' || req.query.anime === 'true',
          filters: {}
        });
        providerTimings[name] = Date.now() - t0;
        console.log(`[api] provider ${name} returned ${Array.isArray(r) ? r.length : 0} streams`);
        return r;
      } catch (e) {
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        return [];
      }
    }));
    let streams = results.flat();
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
    }
    // Mask stream identities and strip internal properties
    streams = maskStreams(streams);

    // Mask providerTimings keys so upstream extractor names are never exposed
    const maskedTimings = {};
    for (const [k, v] of Object.entries(providerTimings)) {
      const codename = getCodename(k).toLowerCase();
      maskedTimings[codename] = v;
    }
    res.json({ success: true, tmdbId, imdbId, count: streams.length, providerTimings: maskedTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// Provider-specific streams
app.get('/api/streams/:provider/:type/:tmdbId', turnstileMiddleware, async (req, res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie', 'series'].includes(type)) return res.status(400).json({ success: false, error: 'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success: false, error: 'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success: false, error: 'PROVIDER_DISABLED' });
  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name] || 0) + 1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const clientGeo = extractClientGeo(req);
    const t0 = Date.now();
    const codename = getCodename(prov.name);
    const codenameLower = codename.toLowerCase();
    let streams = await prov.fetch({
      tmdbId,
      type,
      season,
      episode,
      imdbId,
      lang: req.query.lang,
      clientGeo,
      anilistId: req.query.anilistId ? Number(req.query.anilistId) : null,
      malId: req.query.malId ? Number(req.query.malId) : null,
      subType: req.query.subType || (req.query.type === 'sub' || req.query.type === 'dub' ? req.query.type : null),
      forceAnime: req.query.anime === '1' || req.query.anime === 'true',
      filters: {}
    });
    const providerTimings = { [codenameLower]: Date.now() - t0 };
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
    }
    streams = maskStreams(streams, { codename });
    res.json({ success: true, provider: codenameLower, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// Export app instance for Vercel, serverless platforms, and integration tests
module.exports = app;

if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const PORT = config.port;
  const HOST = process.env.BIND_HOST || '0.0.0.0';
  const server = app.listen(PORT, HOST, () => {
    console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
    if (HOST !== 'localhost') {
      console.log(`Local access (if running on your machine): http://localhost:${PORT}`);
    }
    console.log('Endpoints:');
    console.log('  GET  /api/health');
    console.log('  GET  /api/metrics');
    console.log('  GET  /api/providers');
    console.log('  GET  /api/streams/:type/:id');
    console.log('  POST /api/streams/:type/:id');
    if (!config.febboxCookies || config.febboxCookies.length === 0) {
      console.warn('[startup][warning] No FEBBOX_COOKIES configured. Showbox / PStream related streams may be unavailable. Set FEBBOX_COOKIES in your environment to enable these sources.');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[startup] Port ${PORT} already in use. Running without re-binding port.`);
    } else {
      console.error('[diagnostic] server error', err);
    }
  });
}
