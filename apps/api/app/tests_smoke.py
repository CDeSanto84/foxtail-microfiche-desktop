import asyncio
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
from pydantic import ValidationError

import app.services.search as search_service
from app.adapters.digitalnz import DigitalNzAdapter
from app.adapters.internet_archive import InternetArchiveAdapter
from app.adapters.loc import LibraryOfCongressAdapter
from app.adapters.registry import ADAPTERS
from app.schemas import SearchRequest, SearchResult
from app.services.search import (
    MAX_UNIQUE_IN_FLIGHT_SEARCHES,
    PROVIDER_MAX_RETRY_AFTER_SECONDS,
    SEARCH_CACHE_MAX_ENTRIES,
    SEARCH_CACHE_TTL_SECONDS,
    SearchCapacityError,
    _clear_search_cache,
    _in_flight_search_count,
    _interleave_results,
    _metadata_is_cache_safe,
    _retry_delay_seconds,
    _retry_is_within_budget,
    _search_cache_entry_count,
    _url_is_cache_safe,
    federated_search,
)


class _CountingAdapter:
    def __init__(
        self,
        *,
        failure: Exception | None = None,
        fail_once: bool = False,
        delay: float = 0.0,
        metadata: dict[str, object] | None = None,
    ) -> None:
        self.calls = 0
        self.failure = failure
        self.fail_once = fail_once
        self.delay = delay
        self.metadata = metadata or {"provider": "deterministic smoke adapter"}

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.failure is not None and (not self.fail_once or self.calls == 1):
            raise self.failure
        return [SearchResult(
            id=f"fake:{request.query.casefold()}",
            archive="loc-chronicling-america",
            external_id="fake-1",
            publication="Cache Test Daily",
            headline=f"Match for {request.query}",
            metadata=self.metadata,
        )]


def _status_error(status_code: int, *, retry_after: str | None = None) -> httpx.HTTPStatusError:
    headers = {"retry-after": retry_after} if retry_after is not None else None
    request = httpx.Request("GET", "https://public-provider.example/search")
    response = httpx.Response(status_code, headers=headers, request=request)
    return httpx.HTTPStatusError(
        f"provider returned {status_code}",
        request=request,
        response=response,
    )


async def _cache_smoke() -> None:
    slug = "loc-chronicling-america"
    original = ADAPTERS[slug]
    try:
        await _clear_search_cache()
        adapter = _CountingAdapter()
        ADAPTERS[slug] = adapter
        first = await federated_search(SearchRequest(
            query="Alpha Bravo",
            publication="  Cache Test   Daily ",
            sources=[slug],
        ))
        second = await federated_search(SearchRequest(
            query="Alpha Bravo",
            publication="cache test daily",
            sources=[slug],
        ))
        assert adapter.calls == 1
        assert first.cache_hit is False
        assert first.cache_ttl_seconds == SEARCH_CACHE_TTL_SECONDS
        assert second.cache_hit is True
        assert 1 <= second.cache_ttl_seconds <= SEARCH_CACHE_TTL_SECONDS
        assert second.query.query == "Alpha Bravo"

        second.results[0].metadata["caller-mutation"] = True
        third = await federated_search(SearchRequest(
            query="Alpha Bravo",
            publication="CACHE TEST DAILY",
            sources=[slug],
        ))
        assert third.cache_hit is True
        assert "caller-mutation" not in third.results[0].metadata

        case_variant = await federated_search(SearchRequest(
            query="alpha bravo",
            publication="cache test daily",
            sources=[slug],
        ))
        assert adapter.calls == 2, "case-distinct provider queries must not share cached result text"
        assert case_variant.cache_hit is False
        assert case_variant.results[0].headline == "Match for alpha bravo"

        await _clear_search_cache()
        concurrent_adapter = _CountingAdapter(delay=0.02)
        ADAPTERS[slug] = concurrent_adapter
        concurrent = await asyncio.gather(*(
            federated_search(SearchRequest(query="single flight", sources=[slug]))
            for _ in range(6)
        ))
        assert concurrent_adapter.calls == 1
        assert all(response.cache_hit is False for response in concurrent)
        assert (await federated_search(
            SearchRequest(query="single flight", sources=[slug])
        )).cache_hit is True

        await _clear_search_cache()
        shared_adapter = _CountingAdapter(delay=0.05)
        ADAPTERS[slug] = shared_adapter
        first_waiter = asyncio.create_task(federated_search(
            SearchRequest(query="shared cancellation", sources=[slug])
        ))
        await asyncio.sleep(0)
        surviving_waiter = asyncio.create_task(federated_search(
            SearchRequest(query="shared cancellation", sources=[slug])
        ))
        await asyncio.sleep(0.01)
        first_waiter.cancel()
        await asyncio.gather(first_waiter, return_exceptions=True)
        survived = await surviving_waiter
        assert survived.source_runs[0].ok is True
        assert shared_adapter.calls == 1, "canceling one waiter must not kill shared work"

        await _clear_search_cache()
        sole_adapter = _CountingAdapter(delay=1.0)
        ADAPTERS[slug] = sole_adapter
        sole_waiter = asyncio.create_task(federated_search(
            SearchRequest(query="sole cancellation", sources=[slug])
        ))
        for _ in range(50):
            if sole_adapter.calls:
                break
            await asyncio.sleep(0.01)
        sole_waiter.cancel()
        await asyncio.gather(sole_waiter, return_exceptions=True)
        await asyncio.sleep(0)
        assert _in_flight_search_count() == 0, "the last canceled waiter must stop provider work"

        await _clear_search_cache()
        capacity_adapter = _CountingAdapter(delay=1.0)
        ADAPTERS[slug] = capacity_adapter
        capacity_tasks = [asyncio.create_task(federated_search(
            SearchRequest(query=f"capacity {index}", sources=[slug])
        )) for index in range(MAX_UNIQUE_IN_FLIGHT_SEARCHES)]
        for _ in range(50):
            if _in_flight_search_count() == MAX_UNIQUE_IN_FLIGHT_SEARCHES:
                break
            await asyncio.sleep(0.01)
        try:
            await federated_search(SearchRequest(query="capacity overflow", sources=[slug]))
        except SearchCapacityError:
            pass
        else:
            raise AssertionError("distinct in-flight search work exceeded the configured bound")
        for task in capacity_tasks:
            task.cancel()
        await asyncio.gather(*capacity_tasks, return_exceptions=True)
        await _clear_search_cache()

        retryable = _CountingAdapter(
            failure=_status_error(503, retry_after="0"),
            fail_once=True,
        )
        ADAPTERS[slug] = retryable
        retried = await federated_search(
            SearchRequest(query="retry transient", sources=[slug])
        )
        assert retryable.calls == 2
        assert retried.source_runs[0].ok is True
        assert _retry_delay_seconds(
            _status_error(503, retry_after="999")
        ) == 999
        assert _retry_is_within_budget(999, 20) is False

        retry_clock = datetime(2026, 9, 2, 16, 0, tzinfo=timezone.utc)
        retry_date = format_datetime(retry_clock + timedelta(seconds=60), usegmt=True)
        parsed_retry_date = _retry_delay_seconds(
            _status_error(429, retry_after=retry_date),
            now=retry_clock,
        )
        assert parsed_retry_date == 60
        assert _retry_is_within_budget(parsed_retry_date, 20) is False

        await _clear_search_cache()
        deferred = _CountingAdapter(
            failure=_status_error(429, retry_after="60"),
            fail_once=True,
        )
        ADAPTERS[slug] = deferred
        deferred_result = await federated_search(
            SearchRequest(query="honor provider backoff", sources=[slug])
        )
        assert deferred.calls == 1
        assert deferred_result.source_runs[0].ok is False

        await _clear_search_cache()
        transient_request = httpx.Request(
            "GET", "https://public-provider.example/search"
        )
        transient_network = _CountingAdapter(
            failure=httpx.ConnectError(
                "temporary network failure",
                request=transient_request,
            ),
            fail_once=True,
        )
        ADAPTERS[slug] = transient_network
        recovered = await federated_search(
            SearchRequest(query="retry transport", sources=[slug])
        )
        assert transient_network.calls == 2
        assert recovered.source_runs[0].ok is True

        await _clear_search_cache()
        ordinary_client_error = _CountingAdapter(failure=_status_error(400))
        ADAPTERS[slug] = ordinary_client_error
        not_retried = await federated_search(
            SearchRequest(query="do not retry 400", sources=[slug])
        )
        assert ordinary_client_error.calls == 1
        assert not_retried.source_runs[0].ok is False
        assert not_retried.cache_ttl_seconds == 0

        await _clear_search_cache()
        failing_adapter = _CountingAdapter(failure=RuntimeError("deterministic failure"))
        ADAPTERS[slug] = failing_adapter
        failed_once = await federated_search(
            SearchRequest(query="retry failures", sources=[slug])
        )
        failed_twice = await federated_search(
            SearchRequest(query="retry failures", sources=[slug])
        )
        assert failing_adapter.calls == 2
        assert failed_once.cache_hit is False and failed_once.cache_ttl_seconds == 0
        assert failed_twice.cache_hit is False and failed_twice.cache_ttl_seconds == 0
        assert failed_once.source_runs[0].ok is False

        await _clear_search_cache()
        unsafe_adapter = _CountingAdapter(metadata={"cookie": "do-not-cache"})
        ADAPTERS[slug] = unsafe_adapter
        unsafe_first = await federated_search(
            SearchRequest(query="unsafe metadata", sources=[slug])
        )
        unsafe_second = await federated_search(
            SearchRequest(query="unsafe metadata", sources=[slug])
        )
        assert unsafe_adapter.calls == 2
        assert unsafe_first.cache_ttl_seconds == 0
        assert unsafe_second.cache_hit is False
        assert _metadata_is_cache_safe(b"binary page data") is False
        assert _metadata_is_cache_safe({"access_token": "do-not-cache"}) is False
        assert _url_is_cache_safe("https://example.test/page?token=secret") is False

        await _clear_search_cache()
        expiring_adapter = _CountingAdapter()
        ADAPTERS[slug] = expiring_adapter
        original_ttl = search_service.SEARCH_CACHE_TTL_SECONDS
        search_service.SEARCH_CACHE_TTL_SECONDS = 0.02
        try:
            await federated_search(SearchRequest(query="idle expiry", sources=[slug]))
            assert _search_cache_entry_count() == 1
            await asyncio.sleep(0.04)
            assert _search_cache_entry_count() == 0, "expired entries must be removed while idle"
        finally:
            search_service.SEARCH_CACHE_TTL_SECONDS = original_ttl

        await _clear_search_cache()
        bounded_adapter = _CountingAdapter()
        ADAPTERS[slug] = bounded_adapter
        for index in range(SEARCH_CACHE_MAX_ENTRIES + 1):
            await federated_search(
                SearchRequest(query=f"bounded entry {index}", sources=[slug])
            )
        assert _search_cache_entry_count() == SEARCH_CACHE_MAX_ENTRIES
        calls_before_evicted_lookup = bounded_adapter.calls
        evicted = await federated_search(
            SearchRequest(query="bounded entry 0", sources=[slug])
        )
        assert evicted.cache_hit is False
        assert bounded_adapter.calls == calls_before_evicted_lookup + 1

        try:
            await federated_search(SearchRequest(
                query="unknown source",
                sources=["not-a-live-adapter"],
            ))
        except ValueError as exc:
            assert str(exc) == "Unknown archive source: not-a-live-adapter"
        else:
            raise AssertionError("federated_search silently accepted an unknown source")
    finally:
        ADAPTERS[slug] = original
        await _clear_search_cache()


def run() -> None:
    request = SearchRequest(query="Hindenburg")
    loc_record = {
        "title": "Image 4 of Evening star, May 7, 1937",
        "date": "1937-05-07",
        "url": "https://www.loc.gov/resource/sn83045462/1937-05-07/ed-1/?sp=4",
        "description": ["OCR text around the match"],
        "location": ["washington d.c."],
        "image_url": ["https://tile.loc.gov/image-services/example/full/pct:25/0/default.jpg"],
    }
    loc = LibraryOfCongressAdapter.normalize(loc_record, request)
    assert loc.id.endswith(":page-4")
    assert loc.page == 4
    assert loc.date == date(1937, 5, 7)
    assert str(loc.source_url).startswith("https://www.loc.gov/")

    hostile_image = dict(loc_record)
    hostile_image["image_url"] = ["https://tile.loc.gov.evil.example/image-services/iiif/tracker.jpg"]
    assert LibraryOfCongressAdapter.normalize(hostile_image, request).image_url is None

    ia = InternetArchiveAdapter.normalize({
        "identifier": "sample_newspaper",
        "title": "Sample Newspaper",
        "date": "1937-05-07",
        "collection": ["newspapers"],
    }, request)
    assert ia.external_id == "sample_newspaper"
    assert str(ia.source_url) == "https://archive.org/details/sample_newspaper"

    digitalnz = DigitalNzAdapter.normalize({
        "id": 123,
        "title": "AIRSHIP ARRIVES (Evening Post, 7 May 1937)",
        "category": ["Newspapers"],
        "display_collection": "Papers Past",
        "landing_url": "https://paperspast.natlib.govt.nz/newspapers/EP19370507.2.1",
    }, request)
    assert digitalnz.external_id == "123"
    assert digitalnz.publication == "Evening Post"
    assert digitalnz.date == date(1937, 5, 7)
    assert digitalnz.image_url is None

    untrusted_partner = DigitalNzAdapter.normalize({
        "id": 456,
        "title": "A result from another partner",
        "landing_url": "https://unreviewed-partner.example/item/456",
    }, request)
    assert str(untrusted_partner.source_url) == "https://digitalnz.org/records/456"
    assert untrusted_partner.thumbnail_url is None

    def result(identity: str, archive: str) -> SearchResult:
        return SearchResult(
            id=identity,
            archive=archive,
            external_id=identity,
            publication=identity,
        )

    balanced = _interleave_results([
        [result("loc-1", "loc"), result("loc-2", "loc"), result("loc-3", "loc")],
        [result("ia-1", "ia")],
        [result("dnz-1", "dnz"), result("dnz-2", "dnz")],
    ], 5)
    assert [item.id for item in balanced] == ["loc-1", "ia-1", "dnz-1", "loc-2", "dnz-2"]

    assert set(ADAPTERS) == {
        "loc-chronicling-america",
        "internet-archive-newspapers",
        "digitalnz-papers-past",
    }
    assert SearchRequest(query="  Hindenburg   disaster  ", sources=["loc", "loc"]).query == "Hindenburg disaster"
    assert SearchRequest(query="test", sources=["loc", "loc"]).sources == ["loc"]
    for invalid in (
        {"query": "   "},
        {"query": "test", "sources": []},
        {"query": "test", "date_from": "1940-01-01", "date_to": "1930-01-01"},
    ):
        try:
            SearchRequest(**invalid)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"SearchRequest accepted invalid input: {invalid}")
    asyncio.run(_cache_smoke())
    print(
        "Backend adapter smoke passed: 3 live adapters, normalized provenance, "
        "one bounded transient retry, strict source validation, and metadata caching."
    )


if __name__ == "__main__":
    run()
