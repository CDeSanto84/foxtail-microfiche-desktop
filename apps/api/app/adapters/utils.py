from __future__ import annotations

import json
import re
from datetime import date, datetime
from typing import Any, Mapping, Sequence

import httpx

from app.schemas import SearchRequest, SearchResult

MAX_PROVIDER_BYTES = 8 * 1024 * 1024
PROVIDER_TIMEOUT = httpx.Timeout(16.0, connect=6.0)
PROVIDER_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Foxtail-Microfiche/0.2 (local newspaper research workstation)",
}


def compact_text(value: Any, limit: int = 1200) -> str:
    if isinstance(value, list):
        value = next((item for item in value if str(item or "").strip()), "")
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def string_list(value: Any, limit: int = 40) -> list[str]:
    raw = value if isinstance(value, list) else [value]
    return [compact_text(item, 400) for item in raw if compact_text(item, 400)][:limit]


def parse_date(value: Any) -> date | None:
    raw = compact_text(value, 40)
    if not raw:
        return None
    candidates = [raw[:10], raw[:4]]
    for candidate in candidates:
        try:
            if len(candidate) == 10:
                return date.fromisoformat(candidate)
            if len(candidate) == 4 and candidate.isdigit():
                return date(int(candidate), 1, 1)
        except ValueError:
            continue
    for pattern in ("%d %B %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, pattern).date()
        except ValueError:
            continue
    return None


def https_url(value: Any) -> str | None:
    raw = compact_text(value, 4096)
    if not raw:
        return None
    if raw.startswith("http://"):
        raw = f"https://{raw[7:]}"
    return raw if raw.startswith("https://") else None


def result_matches(request: SearchRequest, result: SearchResult) -> bool:
    if request.date_from and (not result.date or result.date < request.date_from):
        return False
    if request.date_to and (not result.date or result.date > request.date_to):
        return False
    if request.publication and request.publication.casefold() not in result.publication.casefold():
        return False
    if request.location:
        location = result.location or ""
        if request.location.casefold() not in location.casefold():
            return False
    return True


async def get_json(
    url: str,
    params: Mapping[str, Any] | Sequence[tuple[str, Any]],
) -> dict[str, Any]:
    async with httpx.AsyncClient(
        timeout=PROVIDER_TIMEOUT,
        follow_redirects=True,
        headers=PROVIDER_HEADERS,
        limits=httpx.Limits(max_connections=6, max_keepalive_connections=3),
    ) as client:
        async with client.stream("GET", url, params=params) as response:
            response.raise_for_status()
            size = int(response.headers.get("content-length") or 0)
            if size > MAX_PROVIDER_BYTES:
                raise RuntimeError("Provider response exceeded the Microfiche safety limit")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_PROVIDER_BYTES:
                    raise RuntimeError("Provider response exceeded the Microfiche safety limit")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise RuntimeError("Provider returned an unexpected response shape")
        return payload
