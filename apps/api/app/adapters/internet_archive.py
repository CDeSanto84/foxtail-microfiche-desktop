from __future__ import annotations

from typing import Any

from app.adapters.base import ArchiveAdapter
from app.adapters.utils import compact_text, get_json, parse_date, result_matches, string_list
from app.schemas import SearchRequest, SearchResult


def solr_phrase(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


class InternetArchiveAdapter(ArchiveAdapter):
    slug = "internet-archive-newspapers"
    name = "Internet Archive · Newspapers"
    description = "Newspaper, periodical, and microfilm metadata from Internet Archive collections."
    region = "Global"
    access = "free"
    homepage = "https://archive.org/details/newspapers"
    endpoint = "https://archive.org/advancedsearch.php"

    @staticmethod
    def normalize(record: dict[str, Any], request: SearchRequest) -> SearchResult:
        identifier = compact_text(record.get("identifier"), 300)
        title = compact_text(record.get("title"), 500) or identifier or "Internet Archive newspaper item"
        description = compact_text(record.get("description"), 900)
        coverage = compact_text(record.get("coverage"), 300) or None
        source_url = f"https://archive.org/details/{identifier}"
        thumbnail_url = f"https://archive.org/services/img/{identifier}"
        rights = compact_text(record.get("rights") or record.get("licenseurl"), 700) or "See the item page for rights and access conditions."

        return SearchResult(
            id=f"internet-archive:{identifier}",
            archive=InternetArchiveAdapter.slug,
            external_id=identifier,
            publication=title,
            date=parse_date(record.get("date") or record.get("publicdate")),
            location=coverage,
            page=None,
            frame=None,
            headline=f'Archive item matching “{request.query}”',
            snippet=description or "Open the Internet Archive item to inspect scans, OCR, and available files.",
            ocr_text=description or None,
            thumbnail_url=thumbnail_url,
            image_url=None,
            source_url=source_url,
            rights=rights,
            score=1.25,
            metadata={
                "provider": InternetArchiveAdapter.name,
                "creator": string_list(record.get("creator"), 12),
                "collection": string_list(record.get("collection"), 20),
                "language": string_list(record.get("language"), 8),
                "live_api": True,
                "search_scope": "metadata and newspaper-oriented collections",
            },
        )

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        phrase = solr_phrase(request.query)
        newspaper_scope = "(collection:newspapers OR collection:microfilm OR subject:newspaper OR subject:newspapers OR title:newspaper)"
        clauses = ["mediatype:texts", newspaper_scope, f'"{phrase}"']
        if request.date_from or request.date_to:
            start = request.date_from.isoformat() if request.date_from else "0001-01-01"
            end = request.date_to.isoformat() if request.date_to else "9999-12-31"
            clauses.append(f"date:[{start} TO {end}]")
        fields = ["identifier", "title", "date", "description", "collection", "creator", "language", "publicdate", "coverage", "rights", "licenseurl"]
        params: list[tuple[str, object]] = [
            ("q", " AND ".join(clauses)),
            ("rows", min(max(request.limit * 2, 20), 80)),
            ("page", 1),
            ("output", "json"),
        ]
        params.extend(("fl[]", field) for field in fields)
        payload = await get_json(self.endpoint, params)
        docs = payload.get("response", {}).get("docs", [])
        normalized = [self.normalize(item, request) for item in docs if isinstance(item, dict) and item.get("identifier")]
        return [item for item in normalized if result_matches(request, item)][: request.limit]
