from __future__ import annotations

from pydantic import BaseModel, Field
from pydantic import model_validator
from typing import Literal, Optional


class AnalyzeRequest(BaseModel):
    image_data_url: Optional[str] = Field(default=None, description='Rendered image data URL captured from the viewport.')
    image_data_urls: list[str] = Field(default_factory=list, description='Rendered image data URLs captured from the selected slice stack.')
    analysis_scope: Literal['slice', 'stack'] = Field(default='slice')
    prompt: str = Field(..., min_length=1, max_length=4000)
    series_description: Optional[str] = Field(default=None, max_length=512)
    modality: Optional[str] = Field(default=None, max_length=64)
    current_image_index: Optional[int] = Field(default=None, ge=0)
    total_images: Optional[int] = Field(default=None, ge=1)

    @model_validator(mode='after')
    def validate_image_payload(self) -> 'AnalyzeRequest':
        if self.image_data_url is None and not self.image_data_urls:
            raise ValueError('At least one rendered image data URL is required for analysis.')
        return self


class AnalyzeResponse(BaseModel):
    analysis: str
    mode: str
    warnings: list[str]


class HealthResponse(BaseModel):
    status: str
    mode: str
    ready: bool
    model_id: str
    message: Optional[str] = None
