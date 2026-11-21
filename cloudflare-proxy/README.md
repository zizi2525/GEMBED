# Cloudflare Edge Stream Proxy

Two-tier edge proxy architecture for **Embed-Gibox**:

```
[Browser Player] <---> [Cloudflare Edge Worker] <---> [Our Backend /ts-proxy] <---> [Upstream CDN]
```

## How It Works
1. **Browser** requests video chunks from **Cloudflare Worker** at the edge.
2. **Cloudflare Worker** fetches from **Our Backend `/ts-proxy`**.
3. **Our Backend** fetches from **MovieBox / Upstream CDN** using our server IP and the native Android OneRoom Cronet headers (completely avoiding `427 Forbidden` and `428 Forbidden`).
4. **Cloudflare Worker** streams the `video/mp4` chunks (`206 Partial Content`) directly to the user with full CORS headers (`Access-Control-Allow-Origin: *`).

## Configuration in `backend/.env`

```env
# 1. Your deployed Cloudflare Worker URL:
CLOUDFLARE_STREAM_PROXY_URL=https://black-fire-3fdb.zzdqqsd.workers.dev

# 2. Your public backend URL so Cloudflare Edge can fetch from your server:
# For VPS / Production:
BACKEND_PUBLIC_URL=https://api.yourdomain.com

# For Local Development (using Cloudflare Tunnel):
# npx cloudflared tunnel --url http://localhost:8787
# BACKEND_PUBLIC_URL=https://xxxx.trycloudflare.com
```

## How to Update the Worker

Copy the updated code in `worker.js` and paste it into your [Cloudflare Dashboard](https://dash.cloudflare.com/) for `black-fire-3fdb`, or run:
```bash
cd cloudflare-proxy
npx wrangler deploy
```
