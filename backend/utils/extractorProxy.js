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

module.exports = {
  getExtractorProxyUrl,
  isExtractorProxyEnabled,
  getAxiosConfig,
  getFetchOptions,
  fetchWithProxy,
  getAgents
};
