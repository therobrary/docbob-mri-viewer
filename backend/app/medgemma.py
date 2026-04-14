from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
import re
from typing import Any, Optional, Protocol

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
            validate_image_data_url(image_data_url)
        series_context = request.series_description or 'uploaded series'
        slice_context = describe_analysis_scope(request, image_count)
        analysis = (
            'Mock MedGemma mode is enabled, so this response is a placeholder rather than a real model run. '
            f'The backend received {image_count} rendered image snapshot(s) from {series_context} and {slice_context}. '
            f'Your prompt was: {request.prompt}'
        )
        warnings = [
            'Mock mode is active. Set MEDGEMMA_MODE=gateway to route requests to the configured AI gateway.',
            'Treat model output as assistive only; this project does not provide diagnostic validation.',
        ]
        return analysis, warnings

    def readiness(self) -> tuple[bool, Optional[str]]:
        return True, 'Mock mode is active for local development. No model endpoint calls are being made.'


class GatewayAnalyzer:
    mode = 'gateway'

    def __init__(self) -> None:
        try:
            import httpx
        except ImportError as exc:
            raise MedGemmaConfigurationError(
                'The local gateway-compatible backend requires httpx. Install backend/requirements.txt first.'
            ) from exc

        self._httpx = httpx

    def analyze(self, request: AnalyzeRequest) -> tuple[str, list[str]]:
        payload = self._request_json(
            'chat/completions',
            {
                'model': settings.medgemma_model_id,
                'max_tokens': settings.ai_max_tokens,
                'temperature': settings.ai_temperature,
                'top_p': settings.ai_top_p,
                'messages': [
                    {
                        'role': 'system',
                        'content': (
                            'You are an assistive radiology imaging reviewer. '
                            'Stay concise, non-diagnostic, and follow the requested response format exactly.'
                        ),
                    },
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': build_prompt(request)},
                            *[
                                {'type': 'image_url', 'image_url': {'url': validate_image_data_url(image_data_url)}}
                                for image_data_url in get_image_data_urls(request)
                            ],
                        ],
                    },
                ],
            },
        )

        analysis = extract_completion_text(payload)
        normalized_analysis = normalize_analysis_output(analysis, request.analysis_scope)
        warnings = [
            'MedGemma output is assistive only and must not be treated as a diagnosis.',
            'This viewer sends rendered slice snapshots to the model, not the raw full-volume DICOM series.',
        ]
        if request.analysis_scope == 'stack' and request.total_images is not None and len(get_image_data_urls(request)) < request.total_images:
            warnings.append(
                f'Stack analysis used {len(get_image_data_urls(request))} representative rendered slice snapshots '
                f'from {request.total_images} total images to keep the gateway request smaller.'
            )
        if normalized_analysis != analysis.strip():
            warnings.append('The backend shortened repetitive model output to keep the response concise.')
        return normalized_analysis, warnings

    def readiness(self) -> tuple[bool, Optional[str]]:
        self._ensure_gateway_configuration()
        status_code, body, _ = self._request_json('models', method='GET', allow_status_codes=(404, 405))
        if status_code in (404, 405):
            return (
                True,
                f'Connected to the AI gateway at {settings.ai_base_url}. '
                'The endpoint does not expose /models, so model validation will happen on analyze requests.',
            )

        models = body.get('data')
        if not isinstance(models, list):
            return True, f'Connected to the AI gateway at {settings.ai_base_url}, but /models returned an unexpected response.'

        model_available = any(
            isinstance(model, dict)
            and isinstance(model.get('id'), str)
            and model.get('id') == settings.medgemma_model_id
            for model in models
        )
        if not model_available:
            return (
                False,
                f'Connected to the AI gateway at {settings.ai_base_url}, '
                f'but model "{settings.medgemma_model_id}" was not listed there.',
            )

        return True, f'Connected to the AI gateway at {settings.ai_base_url} and found model "{settings.medgemma_model_id}".'

    def _request_json(
        self,
        path: str,
        payload: Optional[dict[str, Any]] = None,
        *,
        method: str = 'POST',
        allow_status_codes: tuple[int, ...] = (),
    ) -> tuple[int, dict[str, Any], str]:
        self._ensure_gateway_configuration()

        headers = {
            'Accept': 'application/json',
            settings.ai_auth_header_name: settings.ai_auth_header_value,
        }
        if payload is not None:
            headers['Content-Type'] = 'application/json'

        url = join_ai_url(settings.ai_base_url, path)

        try:
            response = self._httpx.request(
                method,
                url,
                headers=headers,
                json=payload,
                timeout=settings.ai_timeout_seconds,
            )
        except self._httpx.TimeoutException as exc:
            raise MedGemmaConfigurationError(
                f'AI gateway request to {path} timed out after {settings.ai_timeout_seconds} seconds.'
            ) from exc
        except self._httpx.HTTPError as exc:
            raise MedGemmaConfigurationError(
                f'Unable to reach the AI gateway at {settings.ai_base_url}: {exc}'
            ) from exc

        response_text = response.text
        body = parse_response_body(response_text)

        if not response.is_success and response.status_code not in allow_status_codes:
            raise MedGemmaConfigurationError(
                f'AI gateway request to {path} failed with {response.status_code}: '
                f'{get_gateway_error_message(body, response_text, response.reason_phrase)}'
            )

        if not isinstance(body, dict):
            raise MedGemmaConfigurationError('The AI gateway returned a non-JSON response.')

        return response.status_code, body, response_text

    @staticmethod
    def _ensure_gateway_configuration() -> None:
        if not settings.ai_base_url.strip():
            raise MedGemmaConfigurationError('AI_BASE_URL must be configured for gateway mode.')
        if not settings.medgemma_model_id.strip():
            raise MedGemmaConfigurationError('MEDGEMMA_MODEL_ID must be configured for gateway mode.')
        if not settings.ai_auth_header_value.strip():
            raise MedGemmaConfigurationError(
                'AI_AUTH_HEADER_VALUE must be configured before gateway requests can run.'
            )


class AnalyzerRegistry:
    def __init__(self) -> None:
        self._cached_analyzer: Optional[Analyzer] = None

    def get(self) -> Analyzer:
        if self._cached_analyzer is not None:
            return self._cached_analyzer

        if settings.medgemma_mode == 'mock':
            self._cached_analyzer = MockAnalyzer()
            return self._cached_analyzer

        if settings.medgemma_mode == 'gateway':
            self._cached_analyzer = GatewayAnalyzer()
            return self._cached_analyzer

        raise MedGemmaConfigurationError(
            f'Unsupported MEDGEMMA_MODE: {settings.medgemma_mode}. Use "mock" or "gateway".'
        )

    def peek_mode(self) -> str:
        return settings.medgemma_mode

    def readiness(self) -> tuple[bool, Optional[str]]:
        if settings.medgemma_mode == 'mock':
            return MockAnalyzer().readiness()
        if settings.medgemma_mode == 'gateway':
            return self.get().readiness()
        raise MedGemmaConfigurationError(
            f'Unsupported MEDGEMMA_MODE: {settings.medgemma_mode}. Use "mock" or "gateway".'
        )


analyzer_registry = AnalyzerRegistry()


def build_prompt(request: AnalyzeRequest) -> str:
    context: list[str] = []
    if request.series_description:
        context.append(f'Series: {request.series_description}.')
    if request.modality:
        context.append(f'Modality: {request.modality}.')
    image_count = len(get_image_data_urls(request))
    if request.analysis_scope == 'stack' and request.total_images is not None:
        if image_count < request.total_images:
            context.append(
                f'Analyze {image_count} representative rendered slice snapshots sampled in order '
                f'from a series containing {request.total_images} total images.'
            )
        else:
            context.append(
                f'Analyze the full rendered stack of {image_count} slice snapshots from first to last '
                f'within a series containing {request.total_images} total images.'
            )
        context.append('Synthesize the ordered images as one study-level review.')
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
        if request.total_images is not None and image_count < request.total_images:
            return f'a representative stack sample of {image_count} slice snapshots from {request.total_images} total images'
        return f'the full stack of {image_count} slice snapshots'
    if request.current_image_index is not None and request.total_images is not None:
        return f'slice {request.current_image_index + 1} of {request.total_images}'
    return 'the current slice'


def validate_image_data_url(image_data_url: str) -> str:
    match = DATA_URL_PATTERN.match(image_data_url)
    if not match:
        raise MedGemmaConfigurationError('The frontend must send a PNG or JPEG data URL for analysis.')

    try:
        base64.b64decode(match.group('data'), validate=True)
    except binascii.Error as exc:
        raise MedGemmaConfigurationError('The frontend sent invalid base64 image data.') from exc

    return image_data_url


def extract_completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get('choices')
    if not isinstance(choices, list) or not choices:
        raise MedGemmaConfigurationError('The AI gateway returned an empty analysis response.')

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise MedGemmaConfigurationError('The AI gateway returned an invalid completion payload.')

    message = first_choice.get('message')
    if not isinstance(message, dict):
        raise MedGemmaConfigurationError('The AI gateway returned an invalid completion payload.')

    content = message.get('content')
    if isinstance(content, str) and content.strip():
        return content

    if isinstance(content, list):
        text_parts = [
            part.get('text', '').strip()
            for part in content
            if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str)
        ]
        text_content = ' '.join(part for part in text_parts if part)
        if text_content:
            return text_content

    raise MedGemmaConfigurationError('The AI gateway returned an empty analysis response.')


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


def parse_response_body(response_text: str) -> Any:
    if not response_text.strip():
        return {}
    try:
        return json.loads(response_text)
    except ValueError:
        return response_text


def get_gateway_error_message(body: Any, response_text: str, fallback: str) -> str:
    if isinstance(body, str) and body.strip():
        return body.strip()

    if isinstance(body, dict):
        if isinstance(body.get('message'), str) and body['message'].strip():
            return body['message'].strip()
        if isinstance(body.get('error'), str) and body['error'].strip():
            return body['error'].strip()
        if isinstance(body.get('error'), dict) and isinstance(body['error'].get('message'), str):
            return body['error']['message'].strip()

    return response_text.strip() or fallback


def join_ai_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"
