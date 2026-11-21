const { config } = require('../utils/config');
const fs = require('fs');
const path = require('path');

// Lazy load cache for providers
const providerCache = new Map();

// Function name mappings for existing providers
const providerFunctionMap = {
  'vixsrc.js': 'getVixsrcStreams',
  'vidzy.js': 'getVidzyStreams',
  'moviebox.js': 'getMovieBoxStreams',
  'castle.js': 'getCastleStreams'
};

// Stats for debug endpoint
let lastCookieStats = { selected: null, index: null, total: 0, remainingMB: null, timestamp: null };

async function getEffectiveCookies() {
  return Array.isArray(config.febboxCookies) ? config.febboxCookies : [];
}

// Get all provider files
function getProviderFiles() {
  const providersDir = path.join(__dirname);
  return fs.readdirSync(providersDir)
    .filter(file => file.endsWith('.js') && file !== 'registry.js')
    .map(file => ({
      name: path.parse(file).name.toLowerCase(),
      file: file,
      functionName: providerFunctionMap[file]
    }));
}

// Load a provider module
function loadProvider(providerFile) {
  if (!providerCache.has(providerFile)) {
    try {
      providerCache.set(providerFile, require(path.join(__dirname, providerFile)));
    } catch (e) {
      console.error(`Failed to load provider ${providerFile}:`, e.message);
      return null;
    }
  }
  return providerCache.get(providerFile);
}

// Create fetch function for a provider
function createFetchFunction(providerInfo) {
  return async function (ctx) {
    const module = loadProvider(providerInfo.file);
    if (!module) return [];

    const funcName = providerInfo.functionName;
    if (!module[funcName]) {
      console.error(`Provider ${providerInfo.name} does not export ${funcName}`);
      return [];
    }

    try {
      const mediaType = ctx.type === 'movie' ? 'movie' : 'tv';
      const t0 = Date.now();

      let result;
      if (providerInfo.name === 'showbox') {
        // Special case for Showbox with TMDB key and cookies
        const { getTmdbApiKey } = require('../utils/tmdbKey');
        const tmdbApiKey = getTmdbApiKey();
        if (!tmdbApiKey) {
          console.warn('[registry] showbox skipped: TMDB API key missing');
          return [];
        }
        const cookies = await getEffectiveCookies();
        const previousConfig = global.currentRequestConfig;
        global.currentRequestConfig = { ...(previousConfig || {}) };
        let selected = null;
        if (cookies.length > 0) {
          const index = Math.floor(Math.random() * cookies.length);
          selected = cookies[index];
          global.currentRequestConfig.cookie = selected.startsWith('ui=') ? selected : `ui=${selected}`;
          global.currentRequestConfig.cookies = cookies.map(c => c.startsWith('ui=') ? c : `ui=${c}`);
          lastCookieStats = { selected: selected.slice(0, 16) + '...', index, total: cookies.length, remainingMB: null, timestamp: Date.now() };
          console.log(`[registry] Cookie random pick index=${index} total=${cookies.length}`);
        }
        result = await module[funcName](mediaType, ctx.tmdbId, ctx.season || null, ctx.episode || null, null, selected);
        if (global.currentRequestUserCookieRemainingMB != null) {
          lastCookieStats.remainingMB = global.currentRequestUserCookieRemainingMB;
        }
        global.currentRequestConfig = previousConfig || {};
      } else {
        // Standard provider call (passes lang and clientGeo if supported)
        result = await module[funcName](ctx.tmdbId, mediaType, ctx.season || null, ctx.episode || null, ctx.lang || null, ctx.clientGeo || null);
      }

      const durationMs = Date.now() - t0;
      console.log(`[registry] ${providerInfo.name} fetch duration ${durationMs}ms`);

      if (!Array.isArray(result)) return [];

      // Add provider name if not present
      return result.map(s => ({ ...s, provider: s.provider || providerInfo.name }));

    } catch (e) {
      console.error(`[registry] ${providerInfo.name} fetch error:`, e.message);
      return [];
    }
  };
}

// Initialize providers - always load all; enabled state is checked dynamically from live config
const providerFiles = getProviderFiles();
const providers = [];

for (const providerInfo of providerFiles) {
  providers.push({
    name: providerInfo.name,
    fetch: createFetchFunction(providerInfo)
  });
  console.log(`[registry] ${providerInfo.name} provider loaded`);
}

function isProviderEnabled(name) {
  const lower = name.toLowerCase();
  if (lower === 'videasy' || lower === 'vidy') {
    if (config.enableVidyProvider === false || config.enableVideasyProvider === false) return false;
    return true;
  }
  if (lower === 'vidzy' || lower === 'vidzt') {
    if (config.enableVidzyProvider === false || config.enableVidztProvider === false) return false;
    return true;
  }
  const flag = `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`;
  return config[flag] !== false;
}

function listProviders() { return providers.map(p => ({ name: p.name, enabled: isProviderEnabled(p.name) })); }
function getProvider(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase().trim();
  let normalized = lower;
  if (lower === 'box') normalized = 'moviebox';
  else if (lower === 'sunny') normalized = 'netmirror';
  else if (lower === 'ari') normalized = 'vixsrc';
  else if (lower === 'nova') normalized = 'vidzy';
  else if (lower === 'titan') normalized = 'videasy';
  else if (lower === 'hub') normalized = '4khdhub';
  else if (lower === 'cloud') normalized = 'showbox';
  else if (lower === 'apex') normalized = 'dahmer';
  else if (lower === 'vidy' && !providers.some(p => p.name === 'vidy')) normalized = 'videasy';
  else if (lower === 'vidzt' && !providers.some(p => p.name === 'vidzt')) normalized = 'vidzy';
  const p = providers.find(p => p.name === normalized);
  if (!p) return null;
  return { ...p, enabled: isProviderEnabled(p.name) };
}

function getCookieStats() { return lastCookieStats; }

module.exports = { listProviders, getProvider, getCookieStats };
