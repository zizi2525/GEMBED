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

function maskStreams(streams, options = {}) {
  if (!Array.isArray(streams)) return streams;
  const brandName = options.brandName || 'Server';
  let counter = 1;
  return streams.map(s => {
    if (!s || typeof s !== 'object') return s;

    // Detect if title or name has language/version info like "· English (VO) 4K"
    let suffix = '';
    const nameStr = s.name || s.title || '';
    if (nameStr.includes('·')) {
      suffix = ' · ' + nameStr.split('·').slice(1).join('·').trim();
    } else {
      const parts = [];
      if (s.language || s.lang) parts.push(s.language || s.lang);
      if (s.quality) parts.push(s.quality);
      if (parts.length > 0) suffix = ` · ${parts.join(' ')}`;
    }

    const maskedTitle = `${brandName} ${counter}${suffix}`;
    const serverId = `server-${counter}`;
    counter++;

    const { scraper, originalProvider, headers, ...safeStream } = s;
    return {
      ...safeStream,
      id: safeStream.id || serverId,
      name: maskedTitle,
      title: maskedTitle,
      server: serverId,
      serverName: maskedTitle,
      provider: brandName.toLowerCase(),
    };
  });
}

module.exports = { applyFilters, maskStreams };