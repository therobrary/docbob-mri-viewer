# Dr. Bob's MRI Viewer and Analyzer

Dr. Bob's MRI Viewer and Analyzer is a browser-based DICOM MRI viewer with an Ollama-backed analysis service. It lets you load local DICOM studies, browse multi-slice and multi-frame MRI series in the browser, run a continuous cine loop, and send either the current slice or the full rendered stack to a MedGemma-compatible vision model for an assistive summary.

## What the project does

- Loads local DICOM files and groups them into image series using DICOM metadata
- Renders MRI stacks in the browser with Cornerstone3D
- Supports multi-frame DICOM studies, including the bundled sample study in `DICOM/`
- Provides manual slice navigation plus a continuous `6 fps` cine loop
- Sends rendered viewport snapshots to an Ollama-hosted MedGemma model
- Supports both single-slice analysis and full-stack analysis
- Encourages concise output by using short-form prompting plus backend response cleanup for repetitive model loops

## Software stack

### Frontend

- `React 19`
- `TypeScript`
- `Vite`
- `Cornerstone3D` and `@cornerstonejs/dicom-image-loader`
- Custom DICOM multi-frame handling and local-file rendering helpers

### Backend

- `Python`
- `FastAPI`
- `Uvicorn`
- `httpx`
- Ollama `/api/generate` integration for multimodal inference

### Model / inference layer

- Ollama server at `http://192.168.8.150:11434`
- Model: `dcarrascosa/medgemma-1.5-4b-it:Q8_0`
- Conservative generation defaults for shorter reports:
  - `OLLAMA_NUM_PREDICT=128`
  - `OLLAMA_TEMPERATURE=0.1`
  - `OLLAMA_TOP_P=0.75`
  - `OLLAMA_REPEAT_PENALTY=1.24`

## Repository layout

- `frontend/` — React + TypeScript MRI viewer UI
- `backend/` — FastAPI analysis service and Ollama client
- `DICOM/` — sample DICOM study used for local validation

## Local development

### Frontend

```bash
cd frontend
npm install
npm run dev
```

By default, the frontend expects the backend at `http://127.0.0.1:8000`.

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
./run_backend.sh
```

Default environment:

```bash
export MEDGEMMA_MODE=ollama
export MEDGEMMA_MODEL_ID=dcarrascosa/medgemma-1.5-4b-it:Q8_0
export OLLAMA_BASE_URL=http://192.168.8.150:11434
export OLLAMA_NUM_PREDICT=128
export OLLAMA_TEMPERATURE=0.1
export OLLAMA_TOP_P=0.75
export OLLAMA_REPEAT_PENALTY=1.24
./run_backend.sh
```

## Notes and limitations

- The model receives rendered viewport snapshots, not the raw DICOM volume
- The backend now de-duplicates repeated model sentences before returning the response
- Model output is assistive only and must not be treated as a diagnosis
- The bundled sample DICOM study is useful for render and stack-analysis validation
