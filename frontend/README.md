# Frontend and Worker deployment

This directory contains the Cloudflare-first deployable application:

- `src/` - the React SPA shell and MRI workspace
- `worker/` - the Cloudflare Worker that serves static assets and exposes `/api/health` + `/api/analyze`
- `wrangler.jsonc` - Worker configuration for Cloudflare deployment

## Local development

```bash
cd frontend
npm install
npm run dev
```

By default, the Vite app expects the optional local FastAPI fallback at `http://127.0.0.1:8000/api`.

## Cloudflare deployment

```bash
cd frontend
npm install
cp .dev.vars.example .dev.vars
# Set AI_AUTH_HEADER_VALUE before local worker testing.
npm run deploy:cloudflare
```

Set the Worker secret before production deployment:

```bash
npx wrangler secret put AI_AUTH_HEADER_VALUE
```
