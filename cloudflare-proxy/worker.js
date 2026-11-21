/**
 * Cloudflare Worker Edge Stream Proxy for Embed-Gibox
 *
 * Architecture:
 * [Browser Player] <---> [Cloudflare Edge Worker] <---> [Our Backend /ts-proxy] <---> [Upstream CDN]
 *
 * Benefits:
 * - Offloads video delivery to Cloudflare Edge (300+ global locations).
 * - Our backend server fetches from Upstream CDN using our server IP and native OneRoom headers (bypassing 427/428 blocks).
 * - Full HTTP 206 Partial Content byte-range seeking and CORS headers.
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, User-Agent, X-Requested-With',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    // Health check
    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'Embed-Gibox Cloudflare Edge Stream Proxy',
          description: 'Edge accelerator proxying our backend stream proxy (/ts-proxy) to users with global edge caching and 206 Range seeking.',
          usage: `${url.origin}/?url=<OUR_BACKEND_PROXY_URL>`,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    try {
      const reqHeaders = new Headers();

      // Forward Range header for byte-range playback & instant seeking
      const range = request.headers.get('range');
      if (range) {
        reqHeaders.set('Range', range);
      }

      // Forward request to our backend proxy endpoint
      const upstreamRes = await fetch(targetUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: reqHeaders,
        redirect: 'follow',
      });

      // Prepare response headers with full CORS and seeking headers
      const resHeaders = new Headers();

      // Copy essential streaming headers
      const passHeaders = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'content-disposition',
        'cache-control',
        'etag',
        'last-modified',
      ];

      for (const h of passHeaders) {
        const val = upstreamRes.headers.get(h);
        if (val) resHeaders.set(h, val);
      }

      // Ensure proper media content-type
      if (!resHeaders.has('content-type') || resHeaders.get('content-type') === 'application/octet-stream') {
        if (targetUrl.includes('.mp4') || targetUrl.includes('/ts-proxy')) {
          resHeaders.set('Content-Type', 'video/mp4');
        } else if (targetUrl.includes('.m3u8') || targetUrl.includes('/m3u8-proxy')) {
          resHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
        }
      }

      // Full CORS
      resHeaders.set('Access-Control-Allow-Origin', '*');
      resHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
      resHeaders.set('Accept-Ranges', 'bytes');

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'EDGE_STREAM_PROXY_ERROR',
          message: err.message,
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },
};
