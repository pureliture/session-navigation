import asyncio
import json
from types import SimpleNamespace

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.summary import summary_feedback
from session_navigation.transport import SummarizerUnavailable
from test_rca_fixes import record
from test_hermes_llm import hermes_adapter


@pytest.mark.parametrize("responses,expected,error", [
    (["Count 42."], "llm", None),
    (["Count 100.", "Count 42."], "llm", None),
    (["Count 100.", "Count 101."], "rule", "verification_failed"),
])
def test_upgrade_retry_and_idempotence(responses, expected, error, tmp_path):
    async def run():
        store = SQLiteContextStore(tmp_path / "state.db")
        engine = SessionNavigationEngine(store)
        source = "Routine annotation details.\n" * 100 + "Count 42."
        hidden = await engine.compact("scope", record(source))
        calls = []
        class Summary:
            async def summarize(self, *args, context=None, **kwargs):
                calls.append(context)
                return {"summary": responses[min(len(calls)-1, len(responses)-1)]}
        result = await engine.summarize("scope", record(source), Summary())
        assert result.error == error
        item = store.items("scope")[0]
        assert item.compaction_source == expected and item.original == source
        assert item.version == (2 if result.ok else 1)
        if result.ok:
            assert (await engine.summarize("scope", record(source), Summary())).ok
        else:
            assert item.compacted == hidden.item.compacted
        assert len(calls) == len(responses)
        if len(calls) == 2:
            assert '"100"' in calls[1]["validation_feedback"]
        assert engine.restore("scope",item.item_id,item.version).item.original == source
        store.close()
    asyncio.run(run())


def test_upgrade_cas_race_does_not_overwrite_unhide(tmp_path):
    async def run():
        store = SQLiteContextStore(tmp_path / "state.db")
        engine = SessionNavigationEngine(store)
        source = "Routine annotation details.\n" * 100 + "Count 42."
        hidden = await engine.compact("scope",record(source))
        class Summary:
            async def summarize(self,*args,**kwargs):
                assert engine.restore("scope",hidden.item.item_id,1).ok
                return {"summary":"Count 42."}
        result = await engine.summarize("scope",record(source),Summary())
        assert result.error == "version_conflict"
        item = store.items("scope")[0]
        assert item.visibility == "visible" and item.version == 2 and item.original == source
        store.close()
    asyncio.run(run())


@pytest.mark.parametrize("second,ok", [("Count 42.",True),("Count 101.",False)])
def test_hermes_retry_records_both_calls_even_when_validation_fails(second,ok,tmp_path):
    store = SQLiteContextStore(tmp_path / "state.db")
    calls=[]
    class Llm:
        def complete(self,**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text=json.dumps({"summary":"Count 100." if len(calls)==1 else second}),
                usage=SimpleNamespace(input_tokens=10,output_tokens=5,total_tokens=15,cost_usd=.01),
                audit={"response_id":str(len(calls))})
    summarizer=hermes_adapter().llm.CtxLlmSummarizer(SimpleNamespace(llm=Llm()),store=store,scope_key="scope")
    source="Routine annotation details.\n"*100+"Count 42."
    if ok:
        assert asyncio.run(summarizer.summarize(source,[])) == {"summary":second}
    else:
        with pytest.raises(SummarizerUnavailable,match="verification_failed"):
            asyncio.run(summarizer.summarize(source,[]))
    assert len(calls)==2 and '"100"' in calls[1]["messages"][-1]["content"]
    assert dict(store.connection.execute("SELECT COUNT(*) AS n,SUM(total_tokens) AS tokens,SUM(cost_usd) AS cost FROM calls").fetchone()) == dict(n=2,tokens=30,cost=.02)
    store.close()


def test_fact_feedback_identifies_other_changed_and_missing_facts():
    feedback=summary_feedback("cedar-app package; 42 checks passed. id: alpha\n/known/source.txt",{"summary":"100 checks failed. id: beta /unknown/source.txt"},())
    for fact in ("100","id: beta","/unknown/source.txt","cedar-app package","42 checks passed"):
        assert fact in feedback
