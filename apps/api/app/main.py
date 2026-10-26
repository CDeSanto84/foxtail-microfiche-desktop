import asyncio
import socket
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from app.adapters.registry import ADAPTERS
from app.config import settings
from app.db import database_ok
from app.schemas import SearchRequest, SearchResponse
from app.services.search import SearchCapacityError, federated_search, federated_search_stream

app = FastAPI(title=settings.app_name, version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "null"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/api/v1/health")
async def health() -> dict[str, object]:
    db_ok = await database_ok()
    return {
        "status": "ok" if db_ok else "degraded",
        "scope": "local service and database; archive availability is checked during searches",
        "database": "ok" if db_ok else "unavailable",
        "adapters": list(ADAPTERS),
    }


@app.get("/api/v1/sources")
async def sources() -> list[dict[str, object]]:
    return [
        {
            "slug": slug,
            "name": adapter.name,
            "description": adapter.description,
            "region": adapter.region,
            "access": adapter.access,
            "homepage": adapter.homepage,
            "mode": "federated",
            "enabled": True,
        }
        for slug, adapter in ADAPTERS.items()
    ]


@app.post("/api/v1/search", response_model=SearchResponse)
async def search(request: SearchRequest) -> SearchResponse:
    unknown = [slug for slug in (request.sources or []) if slug not in ADAPTERS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown archive source: {unknown[0]}")
    try:
        return await federated_search(request)
    except SearchCapacityError as exc:
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": "1"},
        ) from exc


@app.get("/api/v1/connectivity")
async def connectivity() -> dict[str, object]:
    """Bounded DNS diagnostic, distinct from service health and provider access."""
    async def check(slug, adapter):
        host = urlsplit(adapter.endpoint).hostname
        try:
            await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM),
                timeout=3.0,
            )
            return {"source": slug, "dns": "ok"}
        except (OSError, TimeoutError):
            return {"source": slug, "dns": "unavailable"}
    checks = await asyncio.gather(*(check(slug, adapter) for slug, adapter in ADAPTERS.items()))
    return {
        "status": "ok" if all(item["dns"] == "ok" for item in checks) else "degraded",
        "scope": "DNS only; a successful lookup does not verify archive access",
        "sources": checks,
    }


@app.post("/api/v1/search/stream")
async def search_stream(request: SearchRequest):
    unknown = [slug for slug in (request.sources or []) if slug not in ADAPTERS]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown archive source: {unknown[0]}")
    stream = federated_search_stream(request)
    try:
        first = await anext(stream)
    except SearchCapacityError as exc:
        raise HTTPException(status_code=503, detail=str(exc), headers={"Retry-After": "1"}) from exc

    async def lines():
        import json
        try:
            kind, data = first
            yield json.dumps({"type": kind, "data": data.model_dump(mode="json")}) + "\n"
            async for kind, data in stream:
                yield json.dumps({"type": kind, "data": data.model_dump(mode="json")}) + "\n"
        finally:
            await stream.aclose()
    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
