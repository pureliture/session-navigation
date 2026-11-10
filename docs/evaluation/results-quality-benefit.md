# Hermes distractor-pressure quality experiment

## Status and conclusion

**Partial: three qualifying matched pairs (6/8 cells). Quality benefit not shown.**
All qualifying A and B-new sessions passed both final-only and visible-unit checks,
including announced retention, late surprise questions, multi-fact derivations and
the canonical handover artifact. Every qualifying A session underwent three actual,
size-reducing native compactions whose summaries were transmitted to the model.

**B never invoked Hide, Summarize or any other navigation tool.** Consequently this
is not an efficacy test of an exercised cleanup mechanism. It shows no autonomous
plugin quality advantage in these completed cells, not that Hide/Summarize cannot
help. Neither the small sample nor the missing fourth pair supports a general claim.
The root README is unchanged because there is no clear intervention result to add.

The two seed-149 cells and one fresh-label B retry exhausted Relace HTTP 429 backoff
during native summarization. All three nevertheless completed with correct answers,
but their missing native-request usage/cost makes them non-qualifying. They are not
product failures. Further model calls stopped after these three contaminated attempts;
the seed-149 A/B pair remains to be completed after provider recovery.

## Design and provenance

- Model: `deepseek/deepseek-v4.1-flash-1017`; OpenRouter, Relace only,
  `allow_fallbacks:false`, reasoning `{enabled:false,exclude:true}`.
- Hermes, A/native-only versus B-new product
  `37348b89faf82ced7510fe09e2a97a893fbcc8a3`. No product/runtime edits or baseline reuse.
- Declared window: **65,536 tokens** (64 Ki tokens), matching v4. An initial 32,768-token
  setup failed Hermes' minimum 64,000-token auxiliary-compression check at work unit 3;
  it is preserved separately and excluded as a configuration failure, not a task loss.
- Same v4 host limits: 20 iterations/work unit, 4,096 output tokens, 600-second work-unit
  budget; isolated HOME/workspace and env-only proxy credential. Children receive no real key.
- Randomization seed `20261110`: paired order **103 A/B, 71 A/B, 211 A/B, 149 B/A**.
  The first pair was the included pilot; the remainder started only after its cost/pressure gate.
- Four generated synthetic incident cases, fourteen reports each. Reports combine build/test
  rows, signed-live generation-42 configuration and plausible superseded generation-41
  exports with newer export timestamps. Announced owner/release/rollback/drain obligations
  are distinct from late unannounced receipt/canary recall and capacity derivations.
- Both arms inspect complete reports symmetrically, retain source files, and may use notes,
  ordinary tools and native recovery. Source re-reads are legitimate. B's cleanup timing,
  targets and actions are never prescribed. Plugin registration and outgoing supervision
  were present; raw response function calls independently verify zero cleanup invocations.

Primary criterion: matched late announced/surprise/canonical success on each answer surface.
Secondary criterion: all seventeen work-unit answers plus the canonical artifact.
Requested JSON fields are compared exactly. Stale values and other incorrect values are
counted separately; conflicting JSON objects fail. Arbitrary prose and extra fields are
**not** semantically adjudicated. Thus zero unsupported values means zero among scored
fields, not a guarantee about every narrative sentence. `decision.json` is independently
compared with canonical release/rollback/receipt and computed drain-seconds/safe-parallel values.

## Qualifying A versus B-new

| Arm | Sessions final-only / visible-unit | Late checks: final / visible | Canonical artifacts | Stale / unsupported values, both surfaces | Native compactions | Nav calls | Requests | Prompt tokens | Output tokens | Reported USD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 3/3 / 3/3 | 9/9 / 9/9 | 3/3 | 0 / 0 | 9 | 0 | 144 | 4,269,216 | 63,370 | 0.053676872 |
| B-new | 3/3 / 3/3 | 9/9 / 9/9 | 3/3 | 0 / 0 | 8 | 0 | 123 | 3,570,752 | 55,835 | 0.046381884 |

Both arms passed **51/51** total turn checks on both surfaces. Aggregate per-request
tool-result token share median/p90: A **66.83% / 84.36%**; B **68.59% / 84.81%**.
Maximum reported prompt usage was **52,667** for A and **52,085** for B against the
65,536-token declared window; native management occurred before the nominal limit.
Native counts require changed/shrunk before/after histories and exact new-summary content
in a subsequent outgoing request, not merely a start/end notification.

There is no causal cleanup-related cost-saving claim: no cleanup was executed, and native
summaries, ordinary tool choices and model output differ between arms.

### Per-session measurements

Tool share is median/p90 of normalized outgoing `messages`+`tools` compact JSON,
using offline `o200k_base` token attribution to complete tool-result messages.
It includes auxiliary requests in the request population and is not provider billing
attribution. Prompt tokens/cost are provider-reported totals, including native summaries.

| Seed / arm / label | Qualifying | Final / visible | Prompt tokens | Tool share median / p90 | Native start / changed / sent | Nav | Requests | Reported USD |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 103 A pilot64 | yes | pass / pass | 1,647,786 | 67.27% / 83.17% | 3 / 3 / 3 | 0 | 54 | 0.019911760 |
| 103 B-new pilot64 | yes | pass / pass | 1,138,863 | 66.99% / 84.38% | 3 / 3 / 3 | 0 | 42 | 0.017327562 |
| 71 A rest64 | yes | pass / pass | 1,407,139 | 61.30% / 82.09% | 3 / 3 / 3 | 0 | 47 | 0.018554446 |
| 71 B-new rest64 | yes | pass / pass | 1,205,579 | 65.23% / 84.21% | 3 / 3 / 3 | 0 | 43 | 0.016653726 |
| 211 A rest64 | yes | pass / pass | 1,214,291 | 70.40% / 87.17% | 3 / 3 / 3 | 0 | 43 | 0.015210666 |
| 211 B-new rest64 | yes | pass / pass | 1,226,310 | 76.68% / 85.61% | 2 / 2 / 2 | 0 | 38 | 0.012400596 |
| 149 B-new rest64 | **no: API** | pass / pass* | 1,294,855* | 80.36% / 84.91% | 2 / 2 / 2 | 0 | 40 | 0.010031682* |
| 149 A rest64 | **no: API** | pass / pass* | 2,058,542* | 87.09% / 90.71% | 1 / 1 / 1 | 0 | 40 | 0.012664680* |
| 149 B-new retry64b | **no: API** | pass / pass* | 1,773,807* | 81.39% / 89.16% | 2 / 2 / 2 | 0 | 41 | 0.013469450* |

\* Excluded traces have one exhausted native-summary request each without response usage;
the printed prompt/cost totals are captured subtotals, not complete billing estimates.
Their correct answers are documented but never added to product denominators. Native
counts in these rows are the observed successful/transmitted changes, not credits for
failed summary attempts or fallback markers.

## Failure-cause inspection

There were **no scored product failures** in the six qualifying cells, so no missing-fact,
stale-selection, reasoning or output-budget failure attribution and no diagnostic replay
was necessary. A successfully used ordinary source recovery; this does not prove that every
native summary retained every fact.

For each excluded seed-149 trace, the raw guarded wire records seven HTTP 429 attempts
for the failed request (2/4/8/16/32/64-second proxy backoff), and the host log reports
`Compression summary failed` followed by an inserted fallback context marker. OpenRouter's
error identifies Relace's upstream shared-pool rate limit. The missing usage request IDs are:

- B rest64: `b57ec4a7834b46769b6b11647db705da`
- A rest64: `29f9f37fe62445368d10bdb564c6b2fe`
- B retry64b: `aad082b693c64a2eb7f3bef24dd2e7a5`

These are verified transport/auxiliary failures, not evidence that native compaction lost
needed facts. The initial 32K setup has a separate exact host feasibility error in its
preserved `host.log` and `non-qualifying.json`.

## Budget, audit and evidence

- Pilot model cost: **$0.037239322**; including excluded 32K setup: **$0.038455840**.
- Pilot projected total including 1.5x remaining-session safety factor: **$0.206032789**,
  below the **$1.50** gate before continuation. Pilot scorecard/budget are preserved under
  `attempts/pilot64/`, rather than overwritten by subsequent campaign scoring.
- Qualifying cost: **$0.100058756**.
- Three excluded API attempts: **$0.036165812** captured.
- Excluded 32K setup: **$0.001216518**.
- **Total captured experiment spending: $0.137441086**. Failed requests have no reported
  usage; no cost is invented for them. The final conservative projection for the missing
  two qualifying cells is **$0.193300069**; the blocker is API availability, not budget.
- All **385** captured successful 64K responses reported **Relace** and **0 reasoning tokens**.
  All 434 recorded upstream attempts (388 unique requests, including retries) had the
  pinned model/provider/reasoning settings. The four executed harness source hashes match
  the preregistered stage record. B's raw calls were read/search/terminal/write only.

Evidence roots:

- `eval/results/2026-11-10-quality-benefit-64k/`: stage/schedule, generated fixtures,
  session specs/answers/plugin state, native before/after snapshots, wire, scorecard,
  summary, request audit, causal inspection and safety/config/key audits.
- `eval/results/2026-11-10-quality-benefit/`: preserved rejected 32K setup.

Implementation: `eval/quality_fixtures.py`, `quality_hermes.py`, `quality_run.py`,
`quality_score.py`, and `eval/tests/test_quality.py`. No product or installed-runtime changes.

Checks:

```text
uv run --no-sync --with tiktoken python -m unittest discover -s eval/tests -v
Ran 32 tests in 2.700s
OK

uv run --no-sync --with tiktoken python eval/results/2026-11-10-quality-benefit-64k/audit_commands.py
final configurations byte-exact: True

uv run --no-sync python eval/v2_audit.py eval/results/2026-11-10-quality-benefit-64k
{"files_checked": 189238, "actual_key_matches": 0, "credential_prefix_matches": 0}
```

The key audit is recorded in `final-audit.json`. Resume only the two non-qualifying
seed-149 cells after Relace recovers, with fresh labels; never rerun the six qualifying
product outcomes. The existing runner rejects qualifying-cell retries and settings drift.
