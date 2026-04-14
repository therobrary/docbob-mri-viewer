from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    medgemma_mode: str = os.environ.get('MEDGEMMA_MODE', 'gateway')
    medgemma_model_id: str = os.environ.get('MEDGEMMA_MODEL_ID', 'ollama-medgemma')
    ai_base_url: str = os.environ.get('AI_BASE_URL', os.environ.get('OLLAMA_BASE_URL', 'https://aigateway.r0b.cc/v1'))
    ai_timeout_seconds: float = float(os.environ.get('AI_TIMEOUT_SECONDS', os.environ.get('OLLAMA_TIMEOUT_SECONDS', '120')))
    ai_max_tokens: int = int(os.environ.get('AI_MAX_TOKENS', os.environ.get('OLLAMA_NUM_PREDICT', '256')))
    ai_temperature: float = float(os.environ.get('AI_TEMPERATURE', os.environ.get('OLLAMA_TEMPERATURE', '0.1')))
    ai_top_p: float = float(os.environ.get('AI_TOP_P', os.environ.get('OLLAMA_TOP_P', '0.8')))
    ai_auth_header_name: str = os.environ.get('AI_AUTH_HEADER_NAME', 'Authorization')
    ai_auth_header_value: str = os.environ.get('AI_AUTH_HEADER_VALUE', '')
    cors_origin: str = os.environ.get('CORS_ORIGIN', 'http://127.0.0.1:5173')


settings = Settings()
