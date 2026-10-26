import asyncio
from unittest.mock import patch
import httpx
from app.schemas import SearchRequest, SearchResult
from app.services import search as s
from app import main

class Adapter:
    def __init__(self, slug, gate=None, fail=None):
        self.slug, self.gate, self.fail = slug, gate, fail
        self.calls = 0
        self.finished = asyncio.Event()
    async def search(self, request):
        self.calls += 1
        try:
            if self.gate: await self.gate.wait()
            if self.fail: raise self.fail
            return [SearchResult(id=self.slug, archive=self.slug, external_id=self.slug, publication='Test Daily')]
        finally: self.finished.set()

async def run():
    original = dict(s.ADAPTERS)
    try:
        await s._clear_search_cache()
        gate=asyncio.Event(); fast=Adapter('fast'); slow=Adapter('slow',gate)
        s.ADAPTERS.clear(); s.ADAPTERS.update(fast=fast,slow=slow)
        req=SearchRequest(query='stream test')
        stream=s.federated_search_stream(req)
        kind,empty=await anext(stream); assert kind=='progress' and not empty.results
        kind,partial=await asyncio.wait_for(anext(stream),1)
        assert kind=='progress' and [x.id for x in partial.results]==['fast']
        assert not slow.finished.is_set(), 'fast results must arrive while slow provider is blocked'
        regular=asyncio.create_task(s.federated_search(req)); await asyncio.sleep(0)
        gate.set()
        events=[event async for event in stream]
        assert events[-1][0]=='complete'
        final=events[-1][1]; assert [r.id for r in final.results]==['fast','slow']
        assert (await regular).results==final.results and fast.calls==slow.calls==1
        cached=[event async for event in s.federated_search_stream(req)]
        assert len(cached)==1 and cached[0][0]=='complete' and cached[0][1].cache_hit
        await s._clear_search_cache()
        blocked=Adapter('blocked',asyncio.Event());s.ADAPTERS.clear();s.ADAPTERS['blocked']=blocked
        stream=s.federated_search_stream(SearchRequest(query='cancel'))
        await anext(stream);await asyncio.sleep(.01)
        await stream.aclose();await asyncio.wait_for(blocked.finished.wait(),1)
        assert s._in_flight_search_count()==0, 'disconnect must release job'
        await s._clear_search_cache()
        forbidden=httpx.HTTPStatusError('secret=never-display',request=httpx.Request('GET','https://example.org/?secret=never-display'),response=httpx.Response(403))
        s.ADAPTERS['blocked']=Adapter('blocked',fail=forbidden)
        response=await s.federated_search(SearchRequest(query='forbidden'))
        assert 'rejected' in response.source_runs[0].error and 'secret' not in response.source_runs[0].error
        assert s.ADAPTERS['blocked'].calls==1
        async def db_false(): return False
        with patch.object(main,'database_ok',db_false):
            assert (await main.health())['status']=='degraded'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='http://test') as client:
            assert (await client.post('/api/v1/search/stream',json={'query':'test','sources':['invalid']})).status_code==422
            result=await client.post('/api/v1/search/stream',json={'query':'http stream'})
            assert result.status_code==200 and '"type": "complete"' in result.text
        print('PASS: incremental results, shared jobs, final/cache, disconnect cleanup, sanitized errors, degraded health, HTTP stream and validation')
    finally:
        await s._clear_search_cache();s.ADAPTERS.clear();s.ADAPTERS.update(original)

if __name__ == "__main__":
    asyncio.run(run())
