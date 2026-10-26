from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from app.adapters.base import ArchiveAdapter
from app.adapters.utils import compact_text, get_json, https_url, parse_date, result_matches, string_list
from app.schemas import SearchRequest, SearchResult


class LibraryOfCongressAdapter(ArchiveAdapter):
    slug = "loc-chronicling-america"
    name = "Library of Congress · Chronicling America"
    description = "Historic American newspaper pages, OCR, and IIIF images from the National Digital Newspaper Program."
    region = "United States"
    access = "free"
    homepage = "https://www.loc.gov/collections/chronicling-america/"
    endpoint = "https://www.loc.gov/collections/chronicling-america/"

    @staticmethod
    def normalize(record: dict[str, Any], request: SearchRequest) -> SearchResult:
        title = compact_text(record.get("title"), 500) or "Library of Congress newspaper page"
        match = re.match(r"^Image\s+(\d+)\s+of\s+(.+?),\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})$", title)
        page = int(match.group(1)) if match else None
        publication = match.group(2) if match else next(
            (part for part in string_list(record.get("partof")) if "chronicling america" not in part.casefold() and "division" not in part.casefold()),
            title,
        )
        issued = parse_date(record.get("date") or (match.group(3) if match else None))
        locations = string_list(record.get("location"), 8)
        location = ", ".join(word.title() for word in locations) or None
        snippet = compact_text(record.get("description"), 900)
        images = [https_url(item) for item in string_list(record.get("image_url"), 12)]
        image_candidates = []
        for item in images:
            parsed_image = urlparse(item or "")
            if parsed_image.hostname == "tile.loc.gov" and parsed_image.path.startswith("/image-services/iiif/"):
                image_candidates.append((item or "").split("#", 1)[0])
        source_url = https_url(record.get("url") or record.get("id"))
        parsed_source = urlparse(source_url or "")
        external_path = parsed_source.path.strip("/") or compact_text(record.get("id"), 300)
        # One LOC resource URL can represent a complete issue. Keep the page in
        # the stable identity so separate OCR hits never collapse into one row.
        if page is not None:
            external_path = f"{external_path}:page-{page}"
        elif parsed_source.query:
            external_path = f"{external_path}?{parsed_source.query}"
        rights = compact_text(record.get("rights") or record.get("rights_advisory"), 700) or "Library of Congress rights and access statement applies."

        return SearchResult(
            id=f"loc:{external_path}",
            archive=LibraryOfCongressAdapter.slug,
            external_id=external_path,
            publication=publication,
            date=issued,
            location=location,
            page=page,
            frame=page,
            headline=f'OCR match · “{request.query}”',
            snippet=snippet or "Open the original Library of Congress page to inspect the matched text.",
            ocr_text=snippet or None,
            thumbnail_url=image_candidates[0] if image_candidates else None,
            image_url=image_candidates[-1] if image_candidates else None,
            source_url=source_url,
            rights=rights,
            score=2.0,
            metadata={
                "provider": LibraryOfCongressAdapter.name,
                "part_of": string_list(record.get("partof"), 12),
                "language": string_list(record.get("language"), 8),
                "original_format": string_list(record.get("original_format"), 8),
                "live_api": True,
            },
        )

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        params: dict[str, object] = {
            "q": request.query,
            "fo": "json",
            "c": min(max(request.limit * 2, 20), 80),
            "sp": 1,
            "at": "results,pagination",
        }
        if request.date_from or request.date_to:
            start = request.date_from.year if request.date_from else 1690
            end = request.date_to.year if request.date_to else 1963
            params["dates"] = f"{start}/{end}"

        payload = await get_json(self.endpoint, params)
        normalized = [self.normalize(item, request) for item in payload.get("results", []) if isinstance(item, dict)]
        return [item for item in normalized if result_matches(request, item)][: request.limit]
