// Utility for origin extraction and validation for CORS & stream proxy protection

function parseAllowedOrigins(raw) {
    if (!raw) return ['*'];
    if (Array.isArray(raw)) return raw;
    return String(raw)
        .split(/[,;\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function getRequestOrigin(req) {
    if (!req || !req.headers) return null;
    const origin = req.headers['origin'];
    if (origin && typeof origin === 'string') return origin.trim();
    const referer = req.headers['referer'];
    if (referer && typeof referer === 'string') {
        try {
            return new URL(referer).origin;
        } catch {
            return null;
        }
    }
    return null;
}

function globToRegex(pattern) {
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
}

function isOriginAllowed(origin, allowedList) {
    const list = Array.isArray(allowedList) ? allowedList : parseAllowedOrigins(allowedList);
    if (!list.length || list.includes('*')) {
        return true;
    }
    if (!origin) return false;

    const normOrigin = origin.trim().toLowerCase().replace(/\/+$/, '');
    const originHost = normOrigin.replace(/^https?:\/\//, '');

    for (const rawPattern of list) {
        const pattern = rawPattern.trim().toLowerCase().replace(/\/+$/, '');
        if (!pattern) continue;
        if (pattern === '*') return true;

        // Exact match with full origin
        if (pattern === normOrigin) return true;

        // Match without protocol
        if (!pattern.includes('://')) {
            if (pattern === originHost) return true;
            if (pattern.startsWith('*.')) {
                const baseDomain = pattern.slice(2);
                if (originHost === baseDomain || originHost.endsWith('.' + baseDomain)) return true;
            }
        }

        // Wildcard glob match
        if (pattern.includes('*')) {
            try {
                const re = globToRegex(pattern);
                if (re.test(normOrigin)) return true;
                if (re.test(originHost)) return true;
            } catch {}
        }
    }
    return false;
}

function setCorsHeaders(res, origin = '*') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization, X-Requested-With, Origin, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
    res.setHeader('Vary', 'Origin');
}

function validateOriginMiddleware(options = {}) {
    return function originGuard(req, res, next) {
        const allowed = options.getAllowedOrigins
            ? options.getAllowedOrigins()
            : (process.env.ALLOWED_ORIGINS ? parseAllowedOrigins(process.env.ALLOWED_ORIGINS) : ['*']);
        const blockNoOrigin = options.getBlockNoOrigin !== undefined
            ? (typeof options.getBlockNoOrigin === 'function' ? options.getBlockNoOrigin() : options.getBlockNoOrigin)
            : (process.env.BLOCK_NO_ORIGIN === 'true');

        const reqOrigin = getRequestOrigin(req);

        // Wildcard mode: allow all
        if (!allowed.length || allowed.includes('*')) {
            setCorsHeaders(res, reqOrigin || '*');
            if (req.method === 'OPTIONS') return res.status(204).end();
            return next();
        }

        // Direct request without Origin or Referer header
        if (!reqOrigin) {
            if (blockNoOrigin) {
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Origin or Referer header required'
                });
            }
            setCorsHeaders(res, allowed[0] || '*');
            if (req.method === 'OPTIONS') return res.status(204).end();
            return next();
        }

        // Origin validation
        if (isOriginAllowed(reqOrigin, allowed)) {
            setCorsHeaders(res, reqOrigin);
            if (req.method === 'OPTIONS') return res.status(204).end();
            return next();
        }

        // Blocked origin
        return res.status(403).json({
            error: 'Forbidden',
            message: `Origin '${reqOrigin}' is not allowed to access this resource`
        });
    };
}

module.exports = {
    parseAllowedOrigins,
    getRequestOrigin,
    isOriginAllowed,
    setCorsHeaders,
    validateOriginMiddleware
};
