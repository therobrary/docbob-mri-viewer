# DocBob Imaging Workbench

DocBob Imaging Workbench is a Cloudflare-first medical-imaging app. It currently ships an MRI review workspace that loads local DICOM studies in the browser, supports cine playback, and sends rendered slice snapshots to a MedGemma-compatible multimodal gateway for concise assistive interpretation.

The deployment structure is designed to grow into a shared landing page plus separate workspaces for:

- MRI
- X-ray
- Skin-lesion analysis

Only the MRI workspace is live in the UI today, but the Worker/API and frontend shell are being arranged so the next interfaces can be added without reworking the deployment model.

## Current architecture

### Production

- `frontend/` builds the SPA and Cloudflare Worker
- the Worker serves static assets and exposes:
  - `GET /api/health`
  - `POST /api/analyze`
- the deployed app is intended to be published at `https://docbob.robrary.com`

### Optional local fallback

- `backend/` contains a FastAPI service that mirrors the Worker API for local development
- the frontend talks to `http://127.0.0.1:8000/api` during local Vite development unless `VITE_API_BASE_URL` overrides it

## Inference defaults

- Base URL: `https://aigateway.r0b.cc/v1`
- Model ID: `ollama-medgemma`
- Mode: `gateway`
- Default generation controls:
  - `AI_MAX_TOKENS=256`
  - `AI_TEMPERATURE=0.1`
  - `AI_TOP_P=0.8`

Requests are now sent to an OpenAI-compatible multimodal endpoint rather than Ollama's `/api/generate` API.

## Repository layout

- `frontend/` - React SPA, MRI workspace, Cloudflare Worker, Wrangler config
- `backend/` - optional FastAPI local-development fallback

## Local development

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Optional local backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python3 -m ensurepip --upgrade
pip install -r requirements.txt
cp .env.example .env
./run_backend.sh
```

## Cloudflare deployment

### 1. Install frontend dependencies

```bash
cd frontend
npm install
```

### 2. Set the Worker secret

```bash
npx wrangler secret put AI_AUTH_HEADER_VALUE
```

Use the full header value expected by the upstream gateway, for example `Bearer ...`.

### 3. Deploy

```bash
npm run deploy:cloudflare
```

### 4. Attach the custom domain

Deploy the Worker, then attach `docbob.robrary.com` as a Workers custom domain in Cloudflare.

## Notes

- The model receives rendered viewport snapshots, not the raw DICOM volume.
- Large stack analyses are sampled down to representative ordered slices before upload to reduce request size.
- Model output is assistive only and must not be treated as a diagnosis.
