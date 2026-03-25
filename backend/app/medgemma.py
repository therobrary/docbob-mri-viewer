from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
import re
from typing import Optional, Protocol

from .config import settings
from .schemas import AnalyzeRequest

DATA_URL_PATTERN = re.compile(r'^data:(?P<mime>[-\w.+/]+);base64,(?P<data>.+)$')
SENTENCE_SPLIT_PATTERN = re.compile(r'(?<=[.!?])\s+')
WHITESPACE_PATTERN = re.compile(r'\s+')


class MedGemmaConfigurationError(RuntimeError):
    pass


class Analyzer(Protocol):
    mode: str

    def analyze(self, request: AnalyzeRequest) -> tuple[str, list[str]]:
        ...

    def readiness(self) -> tuple[bool, Optional[str]]:
        ...


@dataclass
class MockAnalyzer:
    mode: str = 'mock'

    def analyze(self, request: AnalyzeRequest) -> tuple[str, list[str]]:
        image_count = len(get_image_data_urls(request))
        for image_data_url in get_image_data_urls(request):
            extract_image_base64(image_data_url)
        series_context = request.series_description or 'uploaded series'
        slice_context = describe_analysis_scope(request, image_count)
        analysis = (
            f'Mock MedGemma mode is enabled, so this response is a placeholder rather than a real model run. '
            f'The backend received {image_count} rendered image snapshot(s) from {series_context} and {slice_context}. '
            f'Your prompt was: {request.prompt}'
        )
        warnings = [
            'Mock mode is active. Set MEDGEMMA_MODE=ollama to route requests to the configured Ollama server.',
            'Treat model output as assistive only; this project does not provide diagnostic validation.',
        ]
        return analysis, warnings

    def readiness(self) -> tuple[bool, Optional[str]]:
        return True, 'Mock mode is active for local development. No model endpoint calls are being made.'


class OllamaAnalyzer:
    mode = 'ollama'

    def __init__(self) -> None:
        try:
            import httpx
        except ImportError as exc:
            raise MedGemmaConfigurationError(
                'The Ollama MedGemma backend requires httpx. Install backend/requirements.txt first.'
            ) from exc

        self._httpx = httpx
        self._client = httpx.Client(base_url=settings.ollama_base_url, timeout=settings.ollama_timeout_seconds)

    def analyze(self, request: AnalyzeRequest) -> tuple[str, list[str]]:
        payload = self._request_json(
            '/api/generate',
            {
                'model': settings.medgemma_model_id,
                'prompt': build_prompt(request),
                'images': [extract_image_base64(image_data_url) for image_data_url in get_image_data_urls(request)],
                'stream': False,
                'options': {
                    'num_predict': settings.ollama_num_predict,
                    'temperature': settings.ollama_temperature,
                    'top_p': settings.ollama_top_p,
                    'repeat_penalty': settings.ollama_repeat_penalty,
                },
            },
        )
        analysis = payload.get('response')
        if not isinstance(analysis, str) or not analysis.strip():
            raise MedGemmaConfigurationError('Ollama returned an empty analysis response.')

        normalized_analysis = normalize_analysis_output(analysis, request.analysis_scope)
        warnings = [
            'MedGemma output is assistive only and must not be treated as a diagnosis.',
            'This viewer sends rendered slice snapshots to the model, not the raw full-volume DICOM series.',
        ]
        if normalized_analysis != analysis.strip():
            warnings.append('The backend shortened repetitive model output to keep the response concise.')
        return normalized_analysis, warnings

    def readiness(self) -> tuple[bool, Optional[str]]:
        tags_payload = self._request_json('/api/tags')
        models = tags_payload.get('models')
        if not isinstance(models, list):
            return False, 'Connected to Ollama, but the server returned an unexpected model list response.'

        model_available = any(
            isinstance(model, dict)
            and (
                model.get('model') == settings.medgemma_model_id or model.get('name') == settings.medgemma_model_id
            )
            for model in models
        )
        if not model_available:
            return (
                False,
                f'Connected to Ollama at {settings.ollama_base_url}, but model '
                f'"{settings.medgemma_model_id}" is not available there.',
            )

        model_details = self._request_json('/api/show', {'model': settings.medgemma_model_id})
        if not self._supports_image_input(model_details):
            return (
                False,
                f'Connected to Ollama at {settings.ollama_base_url} and found model '
                f'"{settings.medgemma_model_id}", but its metadata does not indicate image-input support. '
                'Image analysis requests will fail until the server exposes a multimodal build of this model.',
            )

        return (
            True,
            f'Connected to Ollama at {settings.ollama_base_url} and found model "{settings.medgemma_model_id}".',
        )

    def _request_json(self, path: str, payload: Optional[dict] = None) -> dict:
        try:
            response = self._client.post(path, json=payload) if payload is not None else self._client.get(path)
            response.raise_for_status()
        except self._httpx.HTTPStatusError as exc:
            response_body = exc.response.text.strip()
            detail = response_body
            if response_body:
                try:
                    parsed_body = exc.response.json()
                except ValueError:
                    parsed_body = None

                if isinstance(parsed_body, dict) and isinstance(parsed_body.get('error'), str):
                    detail = parsed_body['error']

            raise MedGemmaConfigurationError(
                f'Ollama request to {path} failed with {exc.response.status_code}: {detail or str(exc)}'
            ) from exc
        except self._httpx.HTTPError as exc:
            raise MedGemmaConfigurationError(
                f'Unable to reach Ollama at {settings.ollama_base_url}: {exc}'
            ) from exc

        body = response.json()
        if not isinstance(body, dict):
            raise MedGemmaConfigurationError('Ollama returned a non-JSON response.')
        if isinstance(body.get('error'), str) and body['error']:
            raise MedGemmaConfigurationError(body['error'])
        return body

    @staticmethod
    def _supports_image_input(model_details: dict) -> bool:
        metadata_blob = json.dumps(
            {
                'details': model_details.get('details'),
                'model_info': model_details.get('model_info'),
                'modelfile': model_details.get('modelfile'),
                'template': model_details.get('template'),
            },
            sort_keys=True,
        ).lower()
        return any(keyword in metadata_blob for keyword in ('image', 'vision', 'projector', 'mmproj', 'clip'))


class AnalyzerRegistry:
    def __init__(self) -> None:
        self._cached_analyzer: Optional[Analyzer] = None

    def get(self) -> Analyzer:
        if self._cached_analyzer is not None:
            return self._cached_analyzer

        if settings.medgemma_mode == 'mock':
            self._cached_analyzer = MockAnalyzer()
            return self._cached_analyzer

        if settings.medgemma_mode == 'ollama':
            self._cached_analyzer = OllamaAnalyzer()
            return self._cached_analyzer

        raise MedGemmaConfigurationError(
            f'Unsupported MEDGEMMA_MODE: {settings.medgemma_mode}. Use "mock" or "ollama".'
        )

    def peek_mode(self) -> str:
        return settings.medgemma_mode

    def readiness(self) -> tuple[bool, Optional[str]]:
        if settings.medgemma_mode == 'mock':
            return MockAnalyzer().readiness()
        if settings.medgemma_mode == 'ollama':
            return self.get().readiness()
        raise MedGemmaConfigurationError(
            f'Unsupported MEDGEMMA_MODE: {settings.medgemma_mode}. Use "mock" or "ollama".'
        )


analyzer_registry = AnalyzerRegistry()


def build_prompt(request: AnalyzeRequest) -> str:
    context = []
    if request.series_description:
        context.append(f'Series: {request.series_description}.')
    if request.modality:
        context.append(f'Modality: {request.modality}.')
    image_count = len(get_image_data_urls(request))
    if request.analysis_scope == 'stack' and request.total_images is not None:
        context.append(
            f'Analyze the full rendered stack of {image_count} slice snapshots from first to last within a series containing {request.total_images} total images.'
        )
        context.append('Synthesize the entire ordered stack as one study-level review.')
        context.append('Return exactly two short sections labeled "Summary:" and "Impression:".')
        context.append('Use no more than four sentences total.')
        context.append('Mention only the most important overall findings across the stack.')
        context.append('If there is no obvious abnormality, say that plainly once instead of listing many normal structures.')
        context.append('Do not enumerate slices, do not repeat the same finding across images, and do not provide per-slice commentary.')
        context.append('Do not produce exhaustive normal checklists or repeated negative statements.')
    elif request.current_image_index is not None and request.total_images is not None:
        context.append(f'Current slice index: {request.current_image_index + 1} of {request.total_images}.')
        context.append('Return exactly two short sections labeled "Summary:" and "Impression:".')
        context.append('Use no more than three sentences total.')
        context.append('Do not produce exhaustive normal checklists or repeated negative statements.')

    context.append(
        'Focus on visible anatomy, intensity patterns, artifacts, and obvious abnormalities while remaining assistive and non-diagnostic.'
    )
    context.append(f'User prompt: {request.prompt}')
    return ' '.join(context)


def get_image_data_urls(request: AnalyzeRequest) -> list[str]:
    if request.image_data_urls:
        return request.image_data_urls
    if request.image_data_url:
        return [request.image_data_url]
    return []


def describe_analysis_scope(request: AnalyzeRequest, image_count: int) -> str:
    if request.analysis_scope == 'stack':
        return f'the full stack of {image_count} slice snapshots'
    if request.current_image_index is not None and request.total_images is not None:
        return f'slice {request.current_image_index + 1} of {request.total_images}'
    return 'the current slice'


def extract_image_base64(image_data_url: str) -> str:
    match = DATA_URL_PATTERN.match(image_data_url)
    if not match:
        raise MedGemmaConfigurationError('The frontend must send a PNG or JPEG data URL for analysis.')

    try:
        binary_image = base64.b64decode(match.group('data'), validate=True)
    except binascii.Error as exc:
        raise MedGemmaConfigurationError('The frontend sent invalid base64 image data.') from exc

    return base64.b64encode(binary_image).decode('ascii')


def normalize_analysis_output(text: str, analysis_scope: str) -> str:
    compact_text = WHITESPACE_PATTERN.sub(' ', text).strip()
    if not compact_text:
        return ''

    max_sentences = 4 if analysis_scope == 'stack' else 3
    max_characters = 480 if analysis_scope == 'stack' else 360
    unique_sentences: list[str] = []
    seen_sentences: set[str] = set()

    for sentence in SENTENCE_SPLIT_PATTERN.split(compact_text):
        cleaned_sentence = sentence.strip()
        if not cleaned_sentence:
            continue

        normalized_sentence = normalize_sentence(cleaned_sentence)
        if normalized_sentence in seen_sentences:
            continue

        seen_sentences.add(normalized_sentence)
        unique_sentences.append(cleaned_sentence)
        if len(unique_sentences) >= max_sentences:
            break

    if not unique_sentences:
        unique_sentences.append(compact_text)

    normalized_text = ' '.join(unique_sentences)
    if len(normalized_text) <= max_characters:
        return normalized_text

    truncated_text = normalized_text[:max_characters].rsplit(' ', 1)[0].rstrip(',;: ')
    if truncated_text and truncated_text[-1] not in '.!?':
        truncated_text += '…'
    return truncated_text


def normalize_sentence(sentence: str) -> str:
    normalized = WHITESPACE_PATTERN.sub(' ', sentence).strip().lower()
    return normalized.rstrip('.!?…')
