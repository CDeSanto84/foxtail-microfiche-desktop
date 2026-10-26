import asyncio
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from math import ceil, isfinite
from threading import Lock
from time import perf_counter
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import httpx

from app.adapters.registry import ADAPTERS
from app.schemas import SearchRequest, SearchResponse, SearchResult, SourceRun


SEARCH_CACHE_TTL_SECONDS = 5 * 60
SEARCH_CACHE_MAX_ENTRIES = 96
PROVIDER_ATTEMPT_BUDGET_SECONDS = 20.0
PROVIDER_RETRY_DELAY_SECONDS = 0.2
PROVIDER_MAX_RETRY_AFTER_SECONDS = 1.5
MAX_ACTIVE_SEARCH_JOBS = 3
MAX_UNIQUE_IN_FLIGHT_SEARCHES = 8
_RETRYABLE_STATUS_CODES = {429, 502, 503, 504}

CacheKey = tuple[
    str,
    str | None,
    str | None,
    str | None,
    str | None,
    tuple[str, ...],
    int,
]


@dataclass
class _CacheEntry:
    expires_at: float
    response: SearchResponse
    expiry_handle: asyncio.TimerHandle | None = None


@dataclass
class _InFlightSearch:
    task: asyncio.Task[SearchResponse]
    waiters: int = 0
    latest: SearchResponse | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class _LoopState:
    cache: OrderedDict[CacheKey, _CacheEntry] = field(default_factory=OrderedDict)
    in_flight: dict[CacheKey, _InFlightSearch] = field(default_factory=dict)
    active_slots: asyncio.Semaphore = field(
        default_factory=lambda: asyncio.Semaphore(MAX_ACTIVE_SEARCH_JOBS)
    )


class SearchCapacityError(RuntimeError):
    """The small local federation queue is full of distinct searches."""


_LOOP_STATES: dict[asyncio.AbstractEventLoop, _LoopState] = {}
_LOOP_STATES_LOCK = Lock()
_SENSITIVE_METADATA_KEY_PARTS = {
    "authorization",
    "bearer",
    "cookie",
    "credential",
    "credentials",
    "jwt",
    "password",
    "passwd",
    "secret",
    "session",
    "signature",
    "token",
}
_SENSITIVE_METADATA_KEYS = {
    "api_key",
    "apikey",
    "auth_key",
    "client_secret",
    "private_key",
    "refresh_token",
    "set_cookie",
    "x_api_key",
}
_SENSITIVE_URL_QUERY_PARTS = _SENSITIVE_METADATA_KEY_PARTS | {"key", "sig"}
_MAX_CACHE_METADATA_DEPTH = 12
_MAX_CACHE_METADATA_ITEMS = 256
_MAX_CACHE_METADATA_STRING_CHARS = 20_000


def _loop_state() -> _LoopState:
    """Keep asyncio tasks and primitives owned by exactly one event loop."""
    loop = asyncio.get_running_loop()
    with _LOOP_STATES_LOCK:
        state = _LOOP_STATES.get(loop)
        if state is None:
            state = _LoopState()
            _LOOP_STATES[loop] = state
        return state


def _normalized_text(value: str | None) -> str | None:
    if value is None:
        return None
    compact = " ".join(value.split())
    return compact.casefold() or None


def _request_cache_key(request: SearchRequest) -> CacheKey:
    """Key only fields that affect public-adapter results and their ordering."""
    sources = tuple(request.sources or ADAPTERS.keys())
    return (
        # SearchRequest has already collapsed whitespace. Preserve case because
        # normalized result headlines can include the caller's exact query.
        request.query,
        request.date_from.isoformat() if request.date_from else None,
        request.date_to.isoformat() if request.date_to else None,
        _normalized_text(request.publication),
        _normalized_text(request.location),
        sources,
        request.limit,
    )


def _normalized_metadata_key(value: object) -> tuple[str, set[str]]:
    raw = str(value).strip()
    expanded = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", raw)
    normalized = re.sub(r"[^a-z0-9]+", "_", expanded.casefold()).strip("_")
    return normalized, set(normalized.split("_")) if normalized else set()


def _key_is_sensitive(value: object, *, url_query: bool = False) -> bool:
    normalized, parts = _normalized_metadata_key(value)
    if normalized in _SENSITIVE_METADATA_KEYS:
        return True
    sensitive_parts = _SENSITIVE_URL_QUERY_PARTS if url_query else _SENSITIVE_METADATA_KEY_PARTS
    return bool(parts & sensitive_parts) or normalized.endswith((
        "_api_key",
        "_auth_key",
        "_password",
        "_secret",
        "_session",
        "_signature",
        "_token",
    ))


def _metadata_is_cache_safe(value: Any, depth: int = 0) -> bool:
    """Accept only bounded JSON-like values without credential-shaped keys."""
    if depth > _MAX_CACHE_METADATA_DEPTH:
        return False
    if isinstance(value, (bytes, bytearray, memoryview)):
        return False
    if isinstance(value, dict):
        if len(value) > _MAX_CACHE_METADATA_ITEMS:
            return False
        for key, item in value.items():
            if _key_is_sensitive(key):
                return False
            if not _metadata_is_cache_safe(item, depth + 1):
                return False
        return True
    if isinstance(value, (list, tuple, set, frozenset)):
        return len(value) <= _MAX_CACHE_METADATA_ITEMS and all(
            _metadata_is_cache_safe(item, depth + 1) for item in value
        )
    if isinstance(value, str):
        return len(value) <= _MAX_CACHE_METADATA_STRING_CHARS
    if isinstance(value, float):
        return isfinite(value)
    return value is None or isinstance(value, (bool, int))


def _url_is_cache_safe(value: object | None) -> bool:
    if value is None:
        return True
    parsed = urlsplit(str(value))
    if parsed.username is not None or parsed.password is not None:
        return False
    return not any(_key_is_sensitive(key, url_query=True) for key, _value in parse_qsl(
        parsed.query,
        keep_blank_values=True,
    ))


def _response_is_cacheable(response: SearchResponse) -> bool:
    return all(run.ok for run in response.source_runs) and all(
        _metadata_is_cache_safe(result.metadata)
        and _url_is_cache_safe(result.thumbnail_url)
        and _url_is_cache_safe(result.image_url)
        and _url_is_cache_safe(result.source_url)
        for result in response.results
    )


def _remove_cache_entry(state: _LoopState, key: CacheKey, entry: _CacheEntry) -> None:
    if state.cache.get(key) is not entry:
        return
    del state.cache[key]
    if entry.expiry_handle is not None:
        entry.expiry_handle.cancel()
        entry.expiry_handle = None


def _purge_expired_cache_entries(state: _LoopState, now: float) -> None:
    for key, entry in list(state.cache.items()):
        if entry.expires_at <= now:
            _remove_cache_entry(state, key, entry)


def _get_cached_response(state: _LoopState, key: CacheKey) -> SearchResponse | None:
    now = asyncio.get_running_loop().time()
    _purge_expired_cache_entries(state, now)
    entry = state.cache.get(key)
    if entry is None:
        return None
    state.cache.move_to_end(key)
    remaining = max(1, ceil(entry.expires_at - now))
    response = entry.response.model_copy(deep=True)
    response.cache_hit = True
    response.cache_ttl_seconds = remaining
    return response


def _store_cached_response(
    state: _LoopState,
    key: CacheKey,
    response: SearchResponse,
) -> bool:
    if not _response_is_cacheable(response):
        return False
    loop = asyncio.get_running_loop()
    now = loop.time()
    _purge_expired_cache_entries(state, now)
    ttl_seconds = max(0.001, float(SEARCH_CACHE_TTL_SECONDS))
    reported_ttl_seconds = max(1, ceil(ttl_seconds))
    stored = response.model_copy(deep=True)
    stored.cache_hit = False
    stored.cache_ttl_seconds = reported_ttl_seconds
    previous = state.cache.pop(key, None)
    if previous is not None and previous.expiry_handle is not None:
        previous.expiry_handle.cancel()
    entry = _CacheEntry(expires_at=now + ttl_seconds, response=stored)
    state.cache[key] = entry
    entry.expiry_handle = loop.call_at(
        entry.expires_at,
        _remove_cache_entry,
        state,
        key,
        entry,
    )
    while len(state.cache) > SEARCH_CACHE_MAX_ENTRIES:
        oldest_key, oldest_entry = state.cache.popitem(last=False)
        if oldest_entry.expiry_handle is not None:
            oldest_entry.expiry_handle.cancel()
            oldest_entry.expiry_handle = None
    return True


async def _clear_search_cache() -> None:
    """Cancel and drain loop-local work, then clear cache state for tests."""
    loop = asyncio.get_running_loop()
    state = _loop_state()
    for entry in state.cache.values():
        if entry.expiry_handle is not None:
            entry.expiry_handle.cancel()
            entry.expiry_handle = None
    state.cache.clear()

    current = asyncio.current_task()
    tasks = [
        entry.task
        for entry in state.in_flight.values()
        if entry.task is not current and not entry.task.done()
    ]
    state.in_flight.clear()
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    with _LOOP_STATES_LOCK:
        if _LOOP_STATES.get(loop) is state:
            del _LOOP_STATES[loop]


def _search_cache_entry_count() -> int:
    state = _loop_state()
    _purge_expired_cache_entries(state, asyncio.get_running_loop().time())
    return len(state.cache)


def _in_flight_search_count() -> int:
    return sum(not entry.task.done() for entry in _loop_state().in_flight.values())


def _retry_delay_seconds(
    exc: Exception,
    *,
    now: datetime | None = None,
) -> float | None:
    if isinstance(exc, httpx.HTTPStatusError):
        if exc.response.status_code not in _RETRYABLE_STATUS_CODES:
            return None
        retry_after = exc.response.headers.get("retry-after", "").strip()
        try:
            requested_delay = max(0.0, float(retry_after))
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                current = now or datetime.now(timezone.utc)
                if current.tzinfo is None:
                    current = current.replace(tzinfo=timezone.utc)
                requested_delay = max(
                    0.0,
                    (retry_at.astimezone(timezone.utc) - current.astimezone(timezone.utc)).total_seconds(),
                )
            except (TypeError, ValueError, OverflowError):
                requested_delay = PROVIDER_RETRY_DELAY_SECONDS
        return requested_delay
    if isinstance(exc, httpx.TransportError):
        return PROVIDER_RETRY_DELAY_SECONDS
    return None


def _retry_is_within_budget(delay: float, remaining_seconds: float) -> bool:
    return (
        isfinite(delay)
        and 0.0 <= delay <= PROVIDER_MAX_RETRY_AFTER_SECONDS
        and delay < remaining_seconds
    )


async def _search_with_one_retry(
    slug: str,
    request: SearchRequest,
    deadline: float,
) -> list[SearchResult]:
    adapter = ADAPTERS[slug]
    try:
        return await adapter.search(request)
    except Exception as exc:
        delay = _retry_delay_seconds(exc)
        remaining_seconds = deadline - asyncio.get_running_loop().time()
        if delay is None or not _retry_is_within_budget(delay, remaining_seconds):
            raise
        if delay:
            await asyncio.sleep(delay)
        return await adapter.search(request)


async def _run_adapter(slug: str, request: SearchRequest) -> tuple[list[SearchResult], SourceRun]:
    started = perf_counter()
    deadline = asyncio.get_running_loop().time() + PROVIDER_ATTEMPT_BUDGET_SECONDS
    try:
        results = await asyncio.wait_for(
            _search_with_one_retry(slug, request, deadline),
            timeout=PROVIDER_ATTEMPT_BUDGET_SECONDS,
        )
        duration_ms = round((perf_counter() - started) * 1000)
        return results, SourceRun(source=slug, ok=True, count=len(results), duration_ms=duration_ms)
    except Exception as exc:  # isolate one broken provider from the rest
        duration_ms = round((perf_counter() - started) * 1000)
        if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
            message = "Archive timed out; other archives can still return results."
        elif isinstance(exc, httpx.HTTPStatusError):
            code = exc.response.status_code
            message = (
                "Archive rejected this request; open its website to check access."
                if code in (401, 403) else
                "Archive is rate limiting requests; try again later."
                if code == 429 else f"Archive returned HTTP {code}; try again later."
            )
        elif isinstance(exc, httpx.TransportError):
            message = "Could not connect to this archive; check the network and retry."
        else:
            # Do not expose provider URLs, credentials or raw response bodies.
            message = "Archive response could not be read; other archives remain available."
        return [], SourceRun(source=slug, ok=False, error=message, duration_ms=duration_ms)


def _interleave_results(batches: list[list[SearchResult]], limit: int) -> list[SearchResult]:
    """Preserve provider relevance while giving every responding archive visibility."""
    interleaved: list[SearchResult] = []
    seen: set[str] = set()
    depth = max((len(batch) for batch in batches), default=0)
    for index in range(depth):
        for batch in batches:
            if index >= len(batch):
                continue
            item = batch[index]
            if item.id in seen:
                continue
            seen.add(item.id)
            interleaved.append(item)
            if len(interleaved) >= limit:
                return interleaved
    return interleaved


async def _federate_uncached(
    state: _LoopState,
    request: SearchRequest,
    slugs: list[str],
    key: CacheKey,
) -> SearchResponse:
    async with state.active_slots:
        tasks = [asyncio.create_task(_run_adapter(slug, request)) for slug in slugs]
        completed = {}
        try:
            for finished in asyncio.as_completed(tasks):
                batch, run = await finished
                completed[run.source] = (batch, run)
                ordered = [completed[slug] for slug in slugs if slug in completed]
                entry = state.in_flight.get(key)
                if entry is not None:
                    entry.latest = SearchResponse(
                        query=request,
                        results=_interleave_results([items for items, _ in ordered], request.limit),
                        source_runs=[run for _, run in ordered],
                    )
                    entry.changed.set()
                    entry.changed = asyncio.Event()
            batches = [completed[slug] for slug in slugs]
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    results = _interleave_results([batch for batch, _run in batches], request.limit)
    runs = [run for _batch, run in batches]
    response = SearchResponse(
        query=request,
        results=results,
        source_runs=runs,
        cache_hit=False,
        cache_ttl_seconds=0,
    )
    if _store_cached_response(state, key, response):
        response.cache_ttl_seconds = max(1, ceil(float(SEARCH_CACHE_TTL_SECONDS)))
    return response


def _remove_in_flight(
    state: _LoopState,
    key: CacheKey,
    entry: _InFlightSearch,
) -> None:
    if state.in_flight.get(key) is entry:
        del state.in_flight[key]


def _release_waiter(
    state: _LoopState,
    key: CacheKey,
    entry: _InFlightSearch,
) -> None:
    entry.waiters = max(0, entry.waiters - 1)
    if entry.waiters == 0 and not entry.task.done():
        if state.in_flight.get(key) is entry:
            del state.in_flight[key]
        entry.task.cancel()


def _join_search(request: SearchRequest):
    requested = request.sources or list(ADAPTERS)
    unknown = [slug for slug in requested if slug not in ADAPTERS]
    if unknown:
        raise ValueError(f"Unknown archive source: {unknown[0]}")
    slugs = list(requested)
    key = _request_cache_key(request)
    state = _loop_state()

    cached = _get_cached_response(state, key)
    if cached is not None:
        cached.query = request.model_copy(deep=True)
        return cached, state, key, None

    loop = asyncio.get_running_loop()
    entry = state.in_flight.get(key)
    if entry is not None and entry.task.done():
        _remove_in_flight(state, key, entry)
        entry = None
    if entry is None:
        if _in_flight_search_count() >= MAX_UNIQUE_IN_FLIGHT_SEARCHES:
            raise SearchCapacityError(
                "The local archive search queue is full; retry in a moment"
            )
        task = loop.create_task(
            _federate_uncached(
                state,
                request.model_copy(deep=True),
                slugs,
                key,
            )
        )
        entry = _InFlightSearch(task=task)
        state.in_flight[key] = entry
        task.add_done_callback(
            lambda _done, current=entry: _remove_in_flight(state, key, current)
        )

    entry.waiters += 1
    return None, state, key, entry


async def federated_search(request: SearchRequest) -> SearchResponse:
    cached, state, key, entry = _join_search(request)
    if cached is not None:
        return cached
    try:
        response = await asyncio.shield(entry.task)
        returned = response.model_copy(deep=True)
        returned.query = request.model_copy(deep=True)
        return returned
    finally:
        _release_waiter(state, key, entry)


async def federated_search_stream(request: SearchRequest):
    """Share the existing bounded jobs/cache; disconnecting releases this waiter."""
    cached, state, key, entry = _join_search(request)
    if cached is not None:
        yield "complete", cached
        return
    try:
        seen = None
        yield "progress", SearchResponse(query=request, results=[], source_runs=[])
        while not entry.task.done():
            changed = entry.changed
            latest = entry.latest
            if latest is not None and latest is not seen:
                seen = latest
                yield "progress", latest.model_copy(deep=True)
            notification = asyncio.create_task(changed.wait())
            try:
                await asyncio.wait([entry.task, notification], return_when=asyncio.FIRST_COMPLETED)
            finally:
                notification.cancel()
                await asyncio.gather(notification, return_exceptions=True)
        response = await asyncio.shield(entry.task)
        returned = response.model_copy(deep=True)
        returned.query = request.model_copy(deep=True)
        yield "complete", returned
    finally:
        _release_waiter(state, key, entry)
