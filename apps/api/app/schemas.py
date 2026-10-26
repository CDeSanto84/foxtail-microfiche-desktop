from datetime import date as Date
from typing import Any

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    date_from: Date | None = None
    date_to: Date | None = None
    publication: str | None = None
    location: str | None = None
    sources: list[str] | None = None
    limit: int = Field(default=50, ge=1, le=250)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("query must contain visible text")
        return value

    @field_validator("sources")
    @classmethod
    def clean_sources(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        unique = list(dict.fromkeys(item.strip() for item in value if item.strip()))
        if not unique:
            raise ValueError("choose at least one source")
        if len(unique) > 20:
            raise ValueError("too many sources")
        return unique

    @model_validator(mode="after")
    def validate_date_range(self) -> "SearchRequest":
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must be on or before date_to")
        return self


class SearchResult(BaseModel):
    id: str
    archive: str
    external_id: str
    publication: str
    date: Date | None = None
    location: str | None = None
    page: int | None = None
    frame: int | None = None
    headline: str | None = None
    snippet: str | None = None
    ocr_text: str | None = None
    thumbnail_url: HttpUrl | None = None
    image_url: HttpUrl | None = None
    source_url: HttpUrl | None = None
    rights: str | None = None
    score: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SourceRun(BaseModel):
    source: str
    ok: bool
    count: int = 0
    error: str | None = None
    duration_ms: int = 0


class SearchResponse(BaseModel):
    query: SearchRequest
    results: list[SearchResult]
    source_runs: list[SourceRun]
    cache_hit: bool = False
    cache_ttl_seconds: int = Field(default=0, ge=0)
