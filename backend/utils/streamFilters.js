function parseQuality(qualityString) {
  if (!qualityString || typeof qualityString !== 'string') return 0;
  const q = qualityString.toLowerCase();
  if (q.includes('auto')) return 1080;
  if (q.includes('4k') || q.includes('2160')) return 2160;
  if (q.includes('1440')) return 1440;
  if (q.includes('1080')) return 1080;
  if (q.includes('720')) return 720;
  if (q.includes('576')) return 576;
  if (q.includes('480')) return 480;
  if (q.includes('360')) return 360;
  if (q.includes('240')) return 240;
  const kbps = q.match(/(\d+)k/); if (kbps) return parseInt(kbps[1],10)/1000;
  if (q.includes('hd')) return 720;
  if (q.includes('sd')) return 480;
  if (q.includes('cam')) return 100;
  if (q.includes('ts')) return 200;
  if (q.includes('scr')) return 300;
  if (q.includes('dvdscr')) return 350;
  if (q.includes('r5') || q.includes('r6')) return 400;
  if (q.includes('org')) return 4320;
  return 0;
}

function filterByMinQuality(streams, minQualitySetting) {
  if (!minQualitySetting || minQualitySetting.toLowerCase() === 'all') return streams;
  const minNumeric = parseQuality(minQualitySetting);
  if (minNumeric === 0 && minQualitySetting.toLowerCase() !== 'all') return streams;
  return streams.filter(s => parseQuality(s.quality) >= minNumeric);
}

function filterByCodecs(streams, exclude) {
  if (!exclude || (!exclude.excludeDV && !exclude.excludeHDR)) return streams;
  return streams.filter(s => {
    if (!Array.isArray(s.codecs)) return true;
    if (exclude.excludeDV && s.codecs.includes('DV')) return false;
    if (exclude.excludeHDR && s.codecs.some(c => ['HDR','HDR10','HDR10+'].includes(c))) return false;
    return true;
  });
}

function applyFilters(streams, providerName, minQualitiesConfig, excludeCodecsConfig) {
  let minQuality = null;
  if (minQualitiesConfig) {
    if (typeof minQualitiesConfig === 'string') minQuality = minQualitiesConfig;
    else if (minQualitiesConfig.default) minQuality = minQualitiesConfig.default;
  }
  let filtered = filterByMinQuality(streams, minQuality);
  filtered = filterByCodecs(filtered, excludeCodecsConfig);
  return filtered;
}

// Canonical codenames for upstream extractors/scrapers to prevent identity leaks
const EXTRACTOR_CODENAMES = {
  moviebox: 'Box',
  movibox: 'Box',
  box: 'Box',
  netmirror: 'Sunny',
  sunny: 'Sunny',
  vixsrc: 'Ari',
  ari: 'Ari',
  vidzy: 'Nova',
  vidzt: 'Nova',
  nova: 'Nova',
  vidy: 'Titan',
  videasy: 'Titan',
  titan: 'Titan',
  '4khdhub': 'Hub',
  hub: 'Hub',
  dahmer: 'Apex',
  apex: 'Apex',
  castle: 'Steve',
  steve: 'Steve',
  showbox: 'Cloud',
  cloud: 'Cloud',
  megaplay: 'MegaPlay',
  mega: 'MegaPlay',
  vidsrc: 'Aura',
  vidsrcto: 'Aura',
  aura: 'Aura'
};

function getCodename(name) {
  if (!name || typeof name !== 'string') return 'Server';
  const lower = name.toLowerCase().trim();
  if (EXTRACTOR_CODENAMES[lower]) return EXTRACTOR_CODENAMES[lower];
  for (const [k, v] of Object.entries(EXTRACTOR_CODENAMES)) {
    if (lower.includes(k)) return v;
  }
  return 'Server';
}

/**
 * Masks internal extractor/scraper identities across all stream fields.
 * Replaces names with clean canonical codenames (Box, Sunny, Ari, Nova, Titan).
 * Strips internal debugging/scraper keys (scraper, originalProvider, subjectId, etc.).
 */
function maskStreams(streams, options = {}) {
  if (!Array.isArray(streams)) return streams;
  return streams.map((s, idx) => {
    if (!s || typeof s !== 'object') return s;

    // Detect provider / scraper from any existing field
    const rawProvider = s.provider || s.scraper || s.originalProvider || s.server || '';
    const codename = options.codename || getCodename(rawProvider);
    const codenameLower = codename.toLowerCase();

    // Extract language & quality info for clean display
    const rawName = s.name || s.title || '';
    let suffix = '';
    if (rawName.includes('·')) {
      const parts = rawName.split('·').slice(1).map(p => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        suffix = ' · ' + parts.join(' · ');
      }
    } else {
      const parts = [];
      if (s.quality || s.qualityLabel) parts.push(s.quality || s.qualityLabel);
      if (s.langLabel || s.language || s.lang) parts.push(s.langLabel || s.language || s.lang);
      if (parts.length > 0) suffix = ' · ' + parts.join(' · ');
    }

    const maskedTitle = `${codename}${suffix}`;
    const qNum = parseInt(String(s.quality || s.qualityLabel || '').match(/\d+/)?.[0] || '1080', 10);
    const langCode = (s.lang || 'vo').toLowerCase();
    const maskedId = `srv-${codenameLower}-${langCode}-${qNum}-${idx + 1}`;

    // Strip internal extractor leak fields
    const {
      scraper,
      originalProvider,
      subjectId,
      extractorName,
      internalId,
      sourceKey,
      headers,
      ...safeStream
    } = s;

    // Mask subtitle IDs if present so extractor-specific prefixes (like mb-sub) are stripped
    let safeSubtitles = safeStream.subtitles;
    if (Array.isArray(safeSubtitles)) {
      safeSubtitles = safeSubtitles.map((sub, sIdx) => {
        if (!sub || typeof sub !== 'object') return sub;
        const subLang = (sub.lang || 'cc').toLowerCase();
        return {
          ...sub,
          id: `sub-${subLang}-${sIdx + 1}`
        };
      });
    }

    return {
      ...safeStream,
      id: maskedId,
      name: maskedTitle,
      title: maskedTitle,
      server: codename,
      serverName: maskedTitle,
      provider: codenameLower,
      ...(safeSubtitles ? { subtitles: safeSubtitles } : {})
    };
  });
}

module.exports = {
  applyFilters,
  maskStreams,
  getCodename,
  EXTRACTOR_CODENAMES
};
