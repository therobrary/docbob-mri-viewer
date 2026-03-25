from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .medgemma import MedGemmaConfigurationError, analyzer_registry
from .schemas import AnalyzeRequest, AnalyzeResponse, HealthResponse

app = FastAPI(title='MRI Viewer MedGemma Backend', version='0.1.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin, 'http://localhost:5173'],
    allow_credentials=False,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.get('/health', response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        ready, message = analyzer_registry.readiness()
    except MedGemmaConfigurationError as exc:
        ready = False
        message = str(exc)

    return HealthResponse(
        status='ok',
        mode=analyzer_registry.peek_mode(),
        ready=ready,
        model_id=settings.medgemma_model_id,
        message=message,
    )


@app.post('/analyze', response_model=AnalyzeResponse)
def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    try:
        analyzer = analyzer_registry.get()
        analysis, warnings = analyzer.analyze(request)
    except MedGemmaConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return AnalyzeResponse(analysis=analysis, mode=analyzer.mode, warnings=warnings)
