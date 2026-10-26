from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, urlparse

from app.adapters.base import ArchiveAdapter
from app.adapters.utils import compact_text, get_json, https_url, parse_date, result_matches, string_list
from app.schemas import SearchRequest, SearchResult


class DigitalNzAdapter(ArchiveAdapter):
    slug = "digitalnz-papers-past"
    name = "DigitalNZ · Papers Past"
    description = "New Zealand and Pacific newspaper articles aggregated by DigitalNZ, principally from Papers Past."
    region = "New Zealand & Pacific"
    access = "free"
    homepage = "https://paperspast.natlib.govt.nz/newspapers"
    endpoint = "https://api.digitalnz.org/v3/records.json"

    @staticmethod
    def normalize(record: dict[str, Any], request: SearchRequest) -> SearchResult:
        record_id = compact_text(record.get("id"), 80)
        title = compact_text(record.get("title"), 600) or "Papers Past newspaper article"
        match = re.match(r"^(.*?)\s*\((.+?),\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\)$", title)
        headline = compact_text(match.group(1), 400) if match else title
        publication = compact_text(match.group(2), 400) if match else compact_text(record.get("display_collection"), 400) or "Papers Past"
        issued = parse_date(match.group(3) if match else record.get("date"))
        description = compact_text(record.get("description"), 900)
        location = compact_text(record.get("placename"), 300) or None
        # DigitalNZ asks public clients to link through its source_url record
        # rather than bypassing the aggregator with landing_url.
        candidate_url = https_url(record.get("source_url"))
        candidate_host = urlparse(candidate_url or "").hostname
        if candidate_host not in {"digitalnz.org", "www.digitalnz.org"}:
            candidate_url = None
        source_url = candidate_url or f"https://digitalnz.org/records/{quote(record_id, safe='')}"
        thumbnail_url = https_url(record.get("thumbnail_url"))
        thumbnail_host = urlparse(thumbnail_url or "").hostname
        if thumbnail_host not in {"paperspast.natlib.govt.nz", "digitalnz.org", "www.digitalnz.org"}:
            thumbnail_url = None
        rights = compact_text(record.get("rights"), 700) or "See the contributing collection for rights information."

        return SearchResult(
            id=f"digitalnz:{record_id}",
            archive=DigitalNzAdapter.slug,
            external_id=record_id,
            publication=publication,
            date=issued,
            location=location,
            page=None,
            frame=None,
            headline=headline or f'Article matching “{request.query}”',
            snippet=description or "Open the Papers Past article to inspect OCR and page context.",
            ocr_text=description or None,
            thumbnail_url=thumbnail_url,
            image_url=None,
            source_url=source_url,
            rights=rights,
            score=1.5,
            metadata={
                "provider": DigitalNzAdapter.name,
                "collection": compact_text(record.get("display_collection"), 300),
                "content_partner": string_list(record.get("content_partner"), 12),
                "language": string_list(record.get("language"), 8),
                "category": string_list(record.get("category"), 8),
                "record_id": record_id,
                "live_api": True,
            },
        )

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        params: list[tuple[str, object]] = [
            ("text", request.query),
            ("and[category][]", "Newspapers"),
            ("per_page", min(max(request.limit * 2, 20), 100)),
            ("page", 1),
        ]
        payload = await get_json(self.endpoint, params)
        docs = payload.get("search", {}).get("results", [])
        normalized = [self.normalize(item, request) for item in docs if isinstance(item, dict) and item.get("id")]
        return [item for item in normalized if result_matches(request, item)][: request.limit]
