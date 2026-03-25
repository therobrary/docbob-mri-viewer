#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -d ".venv" ]]; then
  echo "Missing backend virtual environment. Run: python3 -m venv .venv"
  exit 1
fi

source .venv/bin/activate

MEDGEMMA_MODE="${MEDGEMMA_MODE:-ollama}"

exec uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
