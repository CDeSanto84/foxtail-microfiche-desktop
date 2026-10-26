"""Manual, read-only probe of the public newspaper providers used by v0.2."""

import asyncio
import json

from app.adapters.registry import ADAPTERS
from app.schemas import SearchRequest
from app.services.search import federated_search


async def run() -> None:
    response = await federated_search(SearchRequest(
        query="Hindenburg",
        sources=list(ADAPTERS),
        limit=9,
    ))
    summary = {
        "query": response.query.query,
        "sources": [run.model_dump() for run in response.source_runs],
        "results": [
            {
                "archive": item.archive,
                "publication": item.publication,
                "date": item.date.isoformat() if item.date else None,
                "source_host": str(item.source_url.host) if item.source_url else None,
            }
            for item in response.results
        ],
    }
    print(json.dumps(summary, indent=2))
    if sum(1 for item in response.source_runs if item.ok) < 2:
        raise SystemExit("Fewer than two public archives responded during the live probe")


if __name__ == "__main__":
    asyncio.run(run())
