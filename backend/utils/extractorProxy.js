/**
 * Extractor Proxy Manager for Upstream Scrapers.
 *
 * Provides rotating proxy agents (HTTP, HTTPS, and Undici for Node fetch)
 * for extractors/scrapers to bypass Cloudflare gates, IP blocks, and rate limits.
 */

const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { ProxyAgent } = require('undici');

let cachedHttpsAgent = null;
let cachedHttpAgent = null;
let cachedUndiciAgent = null;
let lastProxyUrl = null;

function getExtractorProxyUrl() {
  return (process.env.EXTRACTOR_PROXY_URL || '').trim();
}

function getAgents() {
  const proxyUrl = getExtractorProxyUrl();
  if (!proxyUrl) return { httpsAgent: null, httpAgent: null, undiciAgent: null };
  if (proxyUrl !== lastProxyUrl) {
    lastProxyUrl = proxyUrl;
    cachedHttpsAgent = new HttpsProxyAgent(proxyUrl);
    cachedHttpAgent = new HttpProxyAgent(proxyUrl);
    cachedUndiciAgent = new ProxyAgent(proxyUrl);
  }
  return {
    httpsAgent: cachedHttpsAgent,
    httpAgent: cachedHttpAgent,
    undiciAgent: cachedUndiciAgent
  };
}

// Canonical alias map for provider names
const PROVIDER_ALIASES = {
  moviebox: ['moviebox', 'movibox', 'box'],
  box: ['moviebox', 'movibox', 'box'],
  netmirror: ['netmirror', 'sunny'],
  sunny: ['netmirror', 'sunny'],
  vixsrc: ['vixsrc', 'ari'],
  ari: ['vixsrc', 'ari'],
  vidzy: ['vidzy', 'vidzt', 'nova'],
  nova: ['vidzy', 'vidzt', 'nova'],
  vidy: ['vidy', 'videasy', 'titan'],
  videasy: ['vidy', 'videasy', 'titan'],
  titan: ['vidy', 'videasy', 'titan'],
  '4khdhub': ['4khdhub', 'hub'],
  hub: ['4khdhub', 'hub'],
  dahmermovies: ['dahmermovies', 'dahmer', 'apex'],
  dahmer: ['dahmermovies', 'dahmer', 'apex'],
  apex: ['dahmermovies', 'dahmer', 'apex'],
  showbox: ['showbox', 'cloud'],
  cloud: ['showbox', 'cloud']
};

/**
 * Checks whether extractor proxying is enabled for a given provider.
 *
 * Precedence:
 * 1. EXTRACTOR_PROXY_URL must be configured.
 * 2. Provider-specific override: EXTRACTOR_PROXY_<NAME>_ENABLED (true/false)
 * 3. EXTRACTOR_PROXY_PROVIDERS whitelist: comma-separated list or 'all'/'*'
 * 4. Default: true when EXTRACTOR_PROXY_URL is set and no whitelist is specified.
 */
function isExtractorProxyEnabled(providerName) {
  const proxyUrl = getExtractorProxyUrl();
  if (!proxyUrl) return false;

  const rawName = (providerName || '').toLowerCase().trim();
  const aliases = PROVIDER_ALIASES[rawName] || [rawName];

  // 1. Check provider-specific override across all aliases: EXTRACTOR_PROXY_<ALIAS>_ENABLED
  for (const alias of aliases) {
    const u = alias.toUpperCase();
    const envVal = process.env[`EXTRACTOR_PROXY_${u}_ENABLED`];
    if (envVal !== undefined) {
      const val = envVal.trim().toLowerCase();
      if (['false', '0', 'off', 'no', 'disabled', 'direct'].includes(val)) return false;
      if (['true', '1', 'on', 'yes', 'enabled', 'proxy', 'force'].includes(val)) return true;
    }
  }

  // 2. Check whitelist list: EXTRACTOR_PROXY_PROVIDERS (e.g. vidzy,netmirror,vixsrc)
  const listRaw = (process.env.EXTRACTOR_PROXY_PROVIDERS || '').trim();
  if (listRaw) {
    const list = listRaw.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (list.includes('all') || list.includes('*')) return true;
    if (aliases.some(a => list.includes(a))) return true;
    return false;
  }

  // 3. Default: enabled for all providers if proxy URL is configured
  return true;
}

/**
 * Generates options for Axios requests with proxy agents attached if enabled.
 */
function getAxiosConfig(providerName, baseConfig = {}) {
  if (!isExtractorProxyEnabled(providerName)) {
    return baseConfig;
  }
  const { httpsAgent, httpAgent } = getAgents();
  return {
    ...baseConfig,
    httpsAgent: baseConfig.httpsAgent || httpsAgent,
    httpAgent: baseConfig.httpAgent || httpAgent,
    proxy: false // Crucial: disables Axios's internal proxy handler which breaks with HttpsProxyAgent
  };
}

/**
 * Generates options for fetch (node-fetch or native global fetch) with proxy agents attached.
 */
function getFetchOptions(providerName, baseOptions = {}) {
  if (!isExtractorProxyEnabled(providerName)) {
    return baseOptions;
  }
  const { httpsAgent, undiciAgent } = getAgents();
  return {
    ...baseOptions,
    agent: baseOptions.agent || httpsAgent,
    dispatcher: baseOptions.dispatcher || undiciAgent
  };
}

/**
 * Direct fetch helper with automatic proxy support for a provider.
 */
async function fetchWithProxy(providerName, url, options = {}) {
  const fetchOpts = getFetchOptions(providerName, options);
  return fetch(url, fetchOpts);
}

const STICKY_SLOTS = [1, 3, 4, 5, 7, 8, 9];
let stickySlotIndex = 0;

function rotateStickySlot() {
  stickySlotIndex = (stickySlotIndex + 1) % STICKY_SLOTS.length;
}

function getStickyProxyUrl(providerName) {
  if (providerName) {
    const rawName = (providerName || '').toLowerCase().trim();
    const envSpecific = process.env[`EXTRACTOR_PROXY_${rawName.toUpperCase()}_URL`];
    if (envSpecific && envSpecific.trim()) return envSpecific.trim();
  }

  const base = getExtractorProxyUrl();
  if (!base) return '';

  // If using Webshare rotating proxy (-rotate), replace with sticky slot number
  // so multi-step token flows (like Vixsrc) maintain the same IP across steps.
  if (base.includes('-rotate')) {
    const slot = STICKY_SLOTS[stickySlotIndex % STICKY_SLOTS.length];
    return base.replace('-rotate', `-${slot}`);
  }

  return base;
}

const stickyAgentCache = new Map();
function getStickyAgents(providerName) {
  const proxyUrl = getStickyProxyUrl(providerName);
  if (!proxyUrl) return { httpsAgent: null, httpAgent: null, undiciAgent: null };
  if (!stickyAgentCache.has(proxyUrl)) {
    stickyAgentCache.set(proxyUrl, {
      httpsAgent: new HttpsProxyAgent(proxyUrl),
      httpAgent: new HttpProxyAgent(proxyUrl),
      undiciAgent: new ProxyAgent(proxyUrl)
    });
  }
  return stickyAgentCache.get(proxyUrl);
}

/**
 * Generates options for Axios requests with a STICKY proxy agent.
 * Use for scrapers with multi-step token validation (e.g. Vixsrc) where
 * consecutive requests MUST originate from the exact same IP address.
 */
function getStickyAxiosConfig(providerName, baseConfig = {}) {
  if (!isExtractorProxyEnabled(providerName)) {
    return baseConfig;
  }
  const { httpsAgent, httpAgent } = getStickyAgents(providerName);
  return {
    ...baseConfig,
    httpsAgent: baseConfig.httpsAgent || httpsAgent,
    httpAgent: baseConfig.httpAgent || httpAgent,
    proxy: false
  };
}

module.exports = {
  getExtractorProxyUrl,
  isExtractorProxyEnabled,
  getAxiosConfig,
  getStickyAxiosConfig,
  rotateStickySlot,
  getFetchOptions,
  fetchWithProxy,
  getAgents
};
