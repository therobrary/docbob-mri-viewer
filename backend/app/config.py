from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    medgemma_mode: str = os.environ.get('MEDGEMMA_MODE', 'ollama')
    medgemma_model_id: str = os.environ.get('MEDGEMMA_MODEL_ID', 'dcarrascosa/medgemma-1.5-4b-it:Q8_0')
    ollama_base_url: str = os.environ.get('OLLAMA_BASE_URL', 'http://192.168.8.150:11434')
    ollama_timeout_seconds: float = float(os.environ.get('OLLAMA_TIMEOUT_SECONDS', '120'))
    ollama_num_predict: int = int(os.environ.get('OLLAMA_NUM_PREDICT', '128'))
    ollama_temperature: float = float(os.environ.get('OLLAMA_TEMPERATURE', '0.1'))
    ollama_top_p: float = float(os.environ.get('OLLAMA_TOP_P', '0.75'))
    ollama_repeat_penalty: float = float(os.environ.get('OLLAMA_REPEAT_PENALTY', '1.24'))
    cors_origin: str = os.environ.get('CORS_ORIGIN', 'http://127.0.0.1:5173')


settings = Settings()
