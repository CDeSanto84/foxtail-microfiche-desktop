from datetime import date

from app.adapters.base import ArchiveAdapter
from app.schemas import SearchRequest, SearchResult


class DemoArchiveAdapter(ArchiveAdapter):
    slug = "demo"
    name = "Foxtail Demo Archive"

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        q = request.query.strip()
        base = [
            ("atlantic-daily-record-1937-05-07-p1", "Atlantic Daily Record", "Atlantic City, New Jersey", 1, 143, "Hindenburg Due in Lakehurst", "City prepares for the airship's arrival as thousands gather near the naval air station."),
            ("newark-herald-1937-05-07-p3", "The Newark Herald", "Newark, New Jersey", 3, 52, "Crowds Greet Hindenburg in Jersey Skies", "Thousands turned out as the great dirigible crossed New Jersey."),
            ("morning-news-press-1937-05-07-p1", "Morning News-Press", "Lakehurst, New Jersey", 1, 88, "Airship to Dock at Lakehurst", "Final approach preparations continue amid hazy but favorable weather."),
            ("bayside-chronicle-1937-05-07-p6", "Bayside Chronicle", "Toms River, New Jersey", 6, 117, "Schools Excused for Airship Visit", "Local pupils may attend the historic arrival if accompanied by family."),
            ("trenton-times-1937-05-08-p2", "The Trenton Times", "Trenton, New Jersey", 2, 201, "Hindenburg Passes Over Capital", "Residents report seeing the airship heading toward Lakehurst."),
        ]
        needle = q.casefold()
        results: list[SearchResult] = []
        for external_id, publication, location, page, frame, headline, snippet in base:
            haystack = f"{publication} {headline} {snippet}".casefold()
            if needle not in haystack and needle != "hindenburg":
                continue
            results.append(
                SearchResult(
                    id=f"demo:{external_id}",
                    archive=self.slug,
                    external_id=external_id,
                    publication=publication,
                    date=date(1937, 5, 7) if "1937-05-07" in external_id else date(1937, 5, 8),
                    location=location,
                    page=page,
                    frame=frame,
                    headline=headline,
                    snippet=snippet,
                    ocr_text=(
                        f"{publication.upper()}\nFRIDAY, MAY 7, 1937\n\n{headline.upper()}\n\n"
                        f"{snippet}\n\nSearch term: {q}. This is scaffold demo OCR and will be replaced by provider OCR."
                    ),
                    rights="Demo content",
                    score=1.0,
                )
            )
        return results[: request.limit]
