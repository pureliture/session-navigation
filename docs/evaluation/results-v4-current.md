# v4 DeepSeek: frozen A / historical B / current TypeScript OMP + Python Hermes

Date: 2026-11-10. **B-current only was executed.** Historical A/B-old were never rerun.

**Latest:** [fixed-product live revalidation](#fixed-product-live-revalidation-df47548)
adds `df47548` as a fourth column. Earlier campaign/RCA sections remain historical;
the fixed run has its own evidence, ledger and acceptance limitations.

## Decision

- **Task correctness: no observed regression.** Both hosts remain 4/4 on final-only, visible-unit, canonical tests, announced recall and surprise recovery.
- **Examined storage/request safety: no observed regression.** Current stored originals match native source records and hashes (136 managed/registered originals across long sessions and components); 8/8 commanded restores send the exact original again, with no original work-tool execution in the restore turn. This is evidence for examined records, not a proof for every possible history.
- **Not an unqualified quality/resource acceptance.** OMP summary fact retention remains 2/3 per eligible replacement. Pooled Summarize retention is 10/12 vs historical 8/9: numerically lower because current includes a second OMP replacement, while historical OMP produced only one. Per-host retention rates are unchanged, but the strict pooled no-regression criterion is **not met numerically**; do not hide this behind 8/8 final answers.
- Long-session output tokens increased **27.1%** overall, OMP output increased **36.7%**, and Hermes/Boreal cost increased **75.1%**. These exceed the predeclared review band. Decomposition below explains where the consumption occurred; it does not isolate a causal product effect from model/host variance.
- Autonomous adoption weakened: sessions with ≥2 cleanup boundaries decreased **6/8 → 4/8**; successful literal IDs improved **101/103 → 69/69**, on fewer selections. Commanded component replacements/restores improved in coverage.
- **n=4 per host, n=2 per fixture. No statistical-equivalence claim.** Ratios are observations, not confidence intervals or guarantees.

| Long-session total | A | B-old | B-current | Current/old | Current/A |
|---|---:|---:|---:|---:|---:|
| requests | 586 | 537 | 548 | 1.020 | 0.935 |
| prompt_tokens | 23211328 | 19019480 | 19659349 | 1.034 | 0.847 |
| cached_tokens | 20004352 | 15760640 | 15820544 | 1.004 | 0.791 |
| output_tokens | 287668 | 198169 | 251896 | 1.271 | 0.876 |
| reported_usd | 0.263097616 | 0.19744074 | 0.22808355 | 1.155 | 0.867 |

## Identity, frozen evidence and execution

| Column / executable | Identity |
|---|---|
| A | Historical v4 plugin off |
| B-old | Historical v4 **B-new**, product `37348b8` (not the historical arm named B-old/`5017b97`) |
| B-current product | Approved `8902a41`, unchanged throughout |
| Collector harness | `7a7ba8ad24caab31e2c498ab6beb96ef22cd5880` |
| Comparison/render harness | `62ddacbd45cc34503122dcae7b2b23fc1b779215` (includes renderer `458240c`) |

Frozen evidence was extracted read-only from `d3e77e6^:eval/results` into
`/Users/devin/nav-phase0-gates/step8-eval/historical/`: v4-deepseek, v4-quality,
v4-fill/new/retry/retry2, and setup-v4. The frozen balanced v4 directory's reuse
selection is preserved; this was not a selection of favorable historical attempts.
The shared scorer reproduces published historical request/token/cost totals exactly.
`v4_assemble.py` and its archival assertions were not changed.

Eight long sessions: OMP/Hermes × Atlas/Boreal × two repetitions, 25 turns each.
Eight components: OMP/Hermes × Hide/Summarize × two repetitions, three turns each.
All 16 host processes completed; all eight canonical code tests passed.
Eight distinct sent replacements were additionally judged with the historical judge prompt.

Model `deepseek/deepseek-v4.1-flash-1017`, Relace only, no fallback, reasoning
`{enabled:false, exclude:true}`, 65,536-token window. Existing host collectors
retain their iteration/output/compaction limits. OMP uses the current package/shim
and TS worker; Hermes uses the current Python plugin/vendor engine. No retired OMP
daemon or historical product executable was run.

## Spend and API accounting

- **Captured successful-response spend: $0.242041808**, including long sessions
  ($0.228083550), components ($0.012961454), and eight judge calls ($0.000996804).
- 660 successful model responses; **661 upstream attempts**. One Relace HTTP 502
  on OMP/Boreal repetition 2 was retried after two seconds and succeeded. The
  failed attempt is not a product failure, scored response, or extra session.
  No current session was excluded; no qualifying product outcome was rerun.
- The 502 returned no billed usage. Its **$0.002632494** worst-case reservation is
  retained, not guessed to be free. Thus known usage plus the unresolved bound is
  **$0.244674302**. Exact invoice spend for that failed attempt is unavailable;
  the captured usage total must not be presented as an independently audited invoice.
- Persistent shared ledger: `step8-eval/budget.json`. Technical limit **$5**
  (superseding the initial $0.50 cap). **$3 was never crossed**; no crossing time exists.
  Upstream attempts, including retries and judging, reserve conservative bounds
  before transmission. Missing/invalid billed usage fails closed; unresolved
  transport attempts continue to count against available budget.
- Proxy provider price ceilings are $0.006/M prompt and $0.50/M completion.
  Reference GPT-4.1 repricing below is hypothetical, **not actual spend**.

## Confounds and scope limits

1. **Product change `270353f` is included in B-current.** It changes `keep_lines`
   handling per target after `37348b8`, in addition to the runtime migration.
   Multi-target keep-lines calls actually occur in both recordings: historical
   calls often supply per-document literals; current calls often supply prefixes
   such as `owner=` and `audit_seal=`. This rules out attributing every difference
   solely to Python→TS. It does not establish that this change caused verbosity.
2. Installed OMP is **18.18.3**, matching v4. All four recorded OMP file hashes
   (package.json, SDK, agent-session, extension runner) match exactly. Current built
   worker/extension hashes are recorded in paid/provenance.json.
3. Hermes `run_agent.py` hash matches the historical recorded hash exactly.
   Current source is `cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`.
   Historical revision was explicitly unverified: matching that entry-point hash
   does **not** prove every Hermes source module or dependency matches.
4. Hermes was provisioned through its PM wrapper from the local source, isolated
   under `step8-eval/host-home` and `step8-eval/runtime`. Current interpreter:
   **Python 3.14.9+20261021, darwin-arm64**. Historical Python version was not
   recorded; its old environment is absent. Install key `a6031367d5037fff`
   matches, but environment ID changed **3be5d82… → 5c9fd8…**. Exact dependency/runtime
   identity is unverified and remains a host confound.
5. Current fixture hashes match historical B-old (`37348b8`) exactly, enforced
   before paid calls. Some historical A/Boreal cells have different fixture hashes;
   prompts, answers, result labels and canonical test specification match.
   Every original hash is retained in selection.json. The historical difference
   is not erased or falsely described as byte-identical.
6. Minimal host harness change: current Hermes plugin middleware-count assertion
   accepts its two hooks; historical specs still expect one. Deferred navigation
   tools use Hermes' native tool catalog/tool_call, as in historical recordings.
   The offline stub was corrected to use that bridge and JSON session summaries;
   this did not change paid prompts/tool definitions.
7. Provider cache warmth, stochastic model choices and unpinned provider backend
   revisions are not controlled across dates. There was no same-day A/B rerun,
   by design. The new price guard did not switch the Relace route.
8. No child/delegation fixture was added. This campaign does not validate subagent
   functionality or attribute costs to child-support paths. No UI changed or
   visual acceptance check was required/performed.
9. Rereads remain the historical heuristic. Hermes rereads are **N/A**, not zero,
   because its required work-tool start instrumentation is absent.

## Safety interpretation

Stored original content is checked against its SHA-256 and the first captured
native tool-result content, using stored items plus current registered adapter
targets. Current: OMP long **43**, Hermes long **85**, components **4+4** checked;
**zero mismatches or unmatched native source records**.

Native host histories themselves are **not globally immutable**: OMP native
pruning replaces content with `[shaken …]` and sets `prunedAt`; Hermes native
compression replaces it with short tool stubs. Current long captures have 81 OMP
and 24 Hermes native content transitions. Historical **plugin-off A also has
83 OMP and 12 Hermes transitions**. These are reported separately, not called
plugin mutations or silently counted as storage corruption. Reachable Hermes
formatters are in `agent/context_compressor.py` (terminal/read_file stub templates).

All eight component restores return the original in the final outgoing request;
none executes a read/bash/terminal original work tool in turn 3. One Hermes
nested tool_describe was initially misclassified as work by the generic historical
heuristic; the new safety-only classifier excludes deferred discovery while
leaving historical reread scoring unchanged. OMP's 17 diagnostic bash calls
discussed below occur **before** the restore instruction, not inside Unhide.
This supports no restore-triggered rerun/invented restoration on the exercised path.

## Root-cause review of >25% differences

### OMP long sessions: verbosity, native pruning and different tool choices

- Output **57,083 → 78,061 (1.367×)**; requests **251 → 272 (1.084×)**.
  Atlas has the **same 127 requests** but **31,263 → 41,130** output tokens;
  Boreal has **124 → 145** requests and **25,820 → 36,931** output tokens.
  Both fixtures exceed +25% output, whereas cost changes are +16.2%/+22.8%.
  These captures have no separate tool-result-summary requests: the excess is
  in the normal host/model path, not an extra evaluation judge or summary budget.
- Historical native pruning/compaction **event counter** falls **126 → 89**.
  This is the historical event metric, not 89 independent paid summaries.
  Visible-repeat rereads rise **3 → 23**, read-new **68 → 88**, while bash-new
  falls **36 → 15**; same-turn rereads remain zero and later/after-compaction
  rereads rise **1 → 3**. These observed tool-choice/retention differences explain
  why equal task scores do not imply equal work. They do not prove the TS engine
  caused the changed model choices.
- Literal selections **75 → 52**, keep-lines operations **28 → 15**, list calls
  **1 → 3**, and selected eligible/disposable counts drop accordingly. The
  reachable multi-target `270353f` change and model-selected prefixes are real
  product/behavior confounds. A leading hypothesis of extra session summaries
  is disproved by **zero** long-session summary requests in both OMP arms.
  Causal allocation between pruning timing, model variance and keep-lines is
  **unverified**; a controlled replay holding model operations fixed would discriminate.

### Hermes/Boreal: native maintenance dominates the resource outlier

- Boreal output **35,871 → 99,251 (2.767×)**, cost
  **$0.041773002 → $0.073164930 (1.751×)**, despite **153 → 129**
  normal tool-enabled requests. Prompt tokens are 0.980×.
- Wire decomposition: no-tools maintenance requests increase **12 → 17**;
  their output **16,107 → 82,397**, cost **$0.008814660 → $0.042207418**.
  Normal-path cost actually decreases **$0.032958342 → $0.030957512**.
  Separating product summaries from that no-tools bucket confirms the native
  source: native-only Boreal requests **4 → 12**, output **14,984 → 81,738**,
  cost **$0.007619596 → $0.041481960**; product-summary requests actually fall
  **8 → 5**, output **1,123 → 659**. The extra spend is not LLM Summarize adoption.
  Thus the measured extra cost is in reachable native maintenance, not more
  work-tool requests or paid judging. Logs show native preflight compression
  and repeated compactions through turn 25.
- This is not merely a uniform provider price increase: Hermes/Atlas output
  falls **105,215 → 74,584 (0.709×)** and cost is **0.780×**. Atlas no-tools
  maintenance output falls **85,221 → 60,168**, while Boreal rises sharply.
  Overall Hermes native event count increases **18 → 23 (1.278×)**.
  Stochastic compactor verbosity and differing context trajectories are verified
  locations of consumption; why those trajectories differ is **not isolated**.
  Hermes dependency identity and reduced cleanup remain confounds.

### OMP components: one diagnostic loop exercises a pre-existing listing quirk

- Component requests **31 → 54 (1.742×)**, prompt **1.823×**, cached **1.923×**,
  output **1.934×**, cost **1.881×**. One current Summarize trial consumes
  **33 requests vs historical 8**; the other three trials together are
  **21 vs 23**. That one trial accounts for the entire aggregate request increase.
- Transcript chain in `current-omp-command-summarize-B-new-1-try1`:
  first summarize succeeds and its replacement is sent; the model asks
  `list_context_items(query="audit-01",view="items")`; the returned row says
  `unhidden/unrecorded`; the model retries summarize and receives
  `verification_failed`; it performs **17 bash diagnostics**, four reads total,
  and further list checks in turn 2. Final restore succeeds in turn 3.
- Source reachability: `packages/core/src/engine.ts:listItems` filters stored
  items by compacted text/item ID, not filename; that summary does not contain
  `audit-01`. `packages/omp/src/service.ts:listItems` then builds its
  recorded-ID set from the **filtered** items and appends snapshot candidates
  as unrecorded. This misleading listing is **pre-existing**, not a proven
  migration regression: `37348b8:src/session_navigation_omp/daemon.py`
  lines 172–203 has the same filtered-list/recorded-set/append behavior.
  The new model trajectory exercises it; no product fix was made during this run.
  The response/validation/diagnostic sequence is recorded, but the model's
  counterfactual choice without that misleading row is unverified. Treat the
  listing quirk as a reachable contributor, not a proven sole cause of the loop.
- This is a genuine usability/resource concern despite final correctness.
  Recommendation: separately reproduce/fix filtered listing of already-recorded
  targets, then use an offline deterministic regression. Do not spend more or
  alter the approved product arm to disguise this outcome.
- OMP summary coverage improves **1 → 2 sent LLM replacements**, but each
  retains only **2/3** facts. Verified input cause: the active session-model
  path at `packages/omp/src/extension.ts` slices source to **12,000 characters**.
  Captured summary requests omit `latency_budget_ms=151`; both summaries omit it.
  Historical eligible OMP summary also retains 2/3. Hermes receives all three
  facts and retains 6/6. This is a real limitation, not a claim of perfect summary quality.

### Wire and ledger audit

All **660** successful responses report provider **Relace** and model
`deepseek/deepseek-v4.1-flash-1017`; reported reasoning tokens sum to **zero**.
All **661** upstream attempt bodies pin Relace/no fallback/reasoning disabled.
The decimal sum of response usage costs exactly matches the persistent ledger.
The unresolved reservation is the single 502 attempt, not a silently omitted charge.

### Adoption, cache transitions and ancillary ratios

Hermes navigation **28 → 18**, literal selections **28 → 17**, successful cleanup
boundaries **20 → 8**, two-boundary sessions **2 → 1**, summary operations
**8 → 5**, and spontaneous successful Unhide **2 → 0** show weaker autonomous
adoption. Commanded Hermes Unhide remains **4/4**, so zero spontaneous restores
does not prove the restore implementation failed. OMP two-boundary coverage
falls **4 → 3** but still has 17 successful boundaries. Report the reduced
coverage as a behavioral warning, not resource equivalence.

The unchanged historical `adoption_gate` still **passes** for both versions:
it requires ≥half of eligible sessions to have two cleanup boundaries and ≥90%
valid selected IDs. B-old has 6/8 and 101/103; current has 4/8 and 69/69.
Current therefore passes at the boundary-coverage threshold, not with the same margin.

Selected eligible/disposable and explicit-hide counters are downstream of those
fewer choices; no target-availability change is isolated. Valid-ID fractions
improve to 100% with less sampling. Cache-transition counts/windows also change
with the number and placement of cleanup boundaries (Hermes **20 → 9**).
Uncached-growth/cost-delta ratios can change sign and are local before/after
diagnostics, **not a causal savings estimate**. The reference/native sensitivity
ratios inherit those window changes (OMP ~1.453×; Hermes ~0.517×). Stored-item
counts include registered targets and are coverage, not memory/cost regressions.
Judge means **2.0 → 2.25** OMP and **3.0 → 3.25** Hermes are ancillary; they do
not override the directly measured lost budget fact.

## Reproduction and checks

All large data is outside the repository under
`/Users/devin/nav-phase0-gates/step8-eval/`: `paid/`, `historical/`,
`comparison/`, `budget.json`, and test logs. No raw wires or credentials
are committed. Per-cell provenance, fixture hashes, exclusions (none current),
native captures, original-content snapshots and the eight judge records are retained.

`eval/v4_current.py --help` documents isolated runtime/output/budget flags.
Use `--stub` first; then run only the approved product arm with a fresh output.
`eval/v4_compare.py --historical <extracted/eval/results> --current <paid> --output <new>`
assembles/scorers; after optional judging,
`eval/v4_compare.py --refresh --output <assembled>` recomputes tables.
`eval/v4_report.py <assembled/comparison.json> <metrics.md>` renders the tables below.

Final relevant full evaluation suite:

```text
Ran 52 tests in 40.076s
OK
```

Offline real-host stub: 16/16 sessions completed, 8/8 canonical checks; Hide,
Unhide and both session-model summary protocols exercised with no paid calls.
Product paths have no diff against approved `8902a41`; no product edits were
made to improve outcomes. `git diff --check` passed.

Additional audited output:

```text
PASS exact restored tool-call IDs and bytes: historical {'hermes': 4, 'omp': 3}
PASS exact restored tool-call IDs and bytes: current {'hermes': 4, 'omp': 4}
PASS audit: 661 upstream attempts; 660 costed responses; ledger reconciled; Relace/no fallback/reasoning off pinned
PASS committed-candidate files contain no real OpenRouter key
```

## Complete long-session metrics

Counts are observed outcomes, not statistical equivalence. Both final-only and visible-unit correctness are scored by the unchanged historical answer-surface evaluator. Resource ratios are dimensionless; N/A means unavailable or a zero denominator, not zero consumption.

### OMP

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 4 | 4 | 4 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `task_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_applicable` | 4 | 4 | 4 | 1 | 1 | Descriptive / coverage |
| `announced_recall` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 31 | 24 | 0.774194 | N/A | Descriptive / coverage |
| `sessions_using_navigation` | 0 | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `list_calls` | 0 | 1 | 3 | 3 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 73 | 52 | 0.712329 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 75 | 52 | 0.693333 | N/A | Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 19 | 17 | 0.894737 | N/A | Descriptive / coverage |
| `sessions_with_2_boundaries` | 0 | 4 | 3 | 0.75 | N/A | Descriptive / coverage |
| `native_compactions` | 40 | 126 | 89 | 0.706349 | 2.225 | RCA: >25% difference |
| `requests` | 244 | 251 | 272 | 1.083665 | 1.114754 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 11,314,570 | 10,212,293 | 11,160,702 | 1.092869 | 0.986401 | Reported ratio; no equivalence claim |
| `cached_tokens` | 10,010,624 | 8,695,552 | 9,194,240 | 1.05735 | 0.918448 | Reported ratio; no equivalence claim |
| `output_tokens` | 58,906 | 57,083 | 78,061 | 1.3675 | 1.325179 | RCA: >25% difference |
| `peak_prompt` | 78,572 | 77,381 | 78,166 | 1.010145 | 0.994833 | Reported ratio; no equivalence claim |
| `reported_usd` | 0.08733 | 0.08112 | 0.0968 | 1.193304 | 1.108447 | Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | N/A | N/A | PASS |
| `missing_cached` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `summary_requests` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `reference_cost` | 8.084452 | 7.837922 | 9.154532 | 1.167979 | 1.132363 | Reported ratio; no equivalence claim |
| `reference_no_cache` | 23.100388 | 20.88125 | 22.945892 | 1.098875 | 0.993312 | Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `eligible_disposable_observed` | 68 | 69 | 69 | 1 | 1.014706 | Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 44 | 36 | 0.818182 | N/A | Descriptive / coverage |
| `eligible_selected` | 0 | 73 | 52 | 0.712329 | N/A | Behavior differs >25%; see discussion |
| `selected_eligible_disposable` | 0 | 62 | 43 | 0.693548 | N/A | Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 71 | 49 | 0.690141 | N/A | Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 61 | 40 | 0.655738 | N/A | Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 28 | 15 | 0.535714 | N/A | Behavior differs >25%; see discussion |
| `successful_unhide` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `rereads_after_compaction` | 0 | 1 | 3 | 3 | N/A | Behavior differs >25%; see discussion |
| `rereads_repeat_visible` | 12 | 3 | 23 | 7.666667 | 1.916667 | Behavior differs >25%; see discussion |
| `rereads_same_turn` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `rereads_later_turn` | 0 | 1 | 3 | 3 | N/A | Behavior differs >25%; see discussion |
| `rereads_unhide_calls` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `rereads_read_after_compaction` | 0 | 0 | 2 | N/A | N/A | Descriptive / coverage |
| `rereads_read_repeat_visible` | 6 | 3 | 7 | 2.333333 | 1.166667 | Behavior differs >25%; see discussion |
| `rereads_read_new` | 88 | 68 | 88 | 1.294118 | 1 | Behavior differs >25%; see discussion |
| `rereads_bash_after_compaction` | 0 | 1 | 1 | 1 | N/A | Descriptive / coverage |
| `rereads_bash_repeat_visible` | 6 | 0 | 16 | N/A | 2.666667 | Descriptive / coverage |
| `rereads_bash_new` | 18 | 36 | 15 | 0.416667 | 0.833333 | Behavior differs >25%; see discussion |
| `cache_transitions` | 0 | 19 | 18 | 0.947368 | N/A | Descriptive / coverage |
| `transition_uncached_growth` | 0 | -43,681 | 12,832 | -0.293766 | N/A | Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.002162 | 0.000055 | -0.025339 | N/A | Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.000055 | 0.00008 | 1.452906 | N/A | Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.082686 | 0.120135 | 1.452906 | N/A | Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 46 | 43 | 0.934783 | N/A | Descriptive / coverage |
| `stored_items` | 0 | 46 | 43 | 0.934783 | N/A | Descriptive / coverage |
| `original_mismatches` | 0 | 0 | 0 | N/A | N/A | PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `native_originals_checked` | 122 | 112 | 133 | 1.1875 | 1.090164 | Descriptive / coverage |
| `native_tool_content_transitions` | 83 | 63 | 81 | 1.285714 | 0.975904 | Behavior differs >25%; see discussion |

### HERMES

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 4 | 4 | 4 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `task_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_applicable` | 4 | 4 | 4 | 1 | 1 | Descriptive / coverage |
| `announced_recall` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 4 | 4 | 4 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 28 | 18 | 0.642857 | N/A | Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 3 | 2 | 0.666667 | N/A | Behavior differs >25%; see discussion |
| `list_calls` | 0 | 3 | 2 | 0.666667 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 28 | 17 | 0.607143 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 28 | 17 | 0.607143 | N/A | Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 20 | 8 | 0.4 | N/A | Behavior differs >25%; see discussion |
| `sessions_with_2_boundaries` | 0 | 2 | 1 | 0.5 | N/A | Behavior differs >25%; see discussion |
| `native_compactions` | 28 | 18 | 23 | 1.277778 | 0.821429 | RCA: >25% difference |
| `requests` | 342 | 286 | 276 | 0.965035 | 0.807018 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 11,896,758 | 8,807,187 | 8,498,647 | 0.964967 | 0.714367 | Reported ratio; no equivalence claim |
| `cached_tokens` | 9,993,728 | 7,065,088 | 6,626,304 | 0.937894 | 0.663046 | Reported ratio; no equivalence claim |
| `output_tokens` | 228,762 | 141,086 | 173,835 | 1.232121 | 0.759895 | Reported ratio; no equivalence claim |
| `peak_prompt` | 54,992 | 54,549 | 54,632 | 1.001522 | 0.993454 | Reported ratio; no equivalence claim |
| `reported_usd` | 0.175768 | 0.116321 | 0.131283 | 1.128627 | 0.746912 | Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | N/A | N/A | PASS |
| `missing_cached` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `summary_requests` | 0 | 8 | 5 | 0.625 | N/A | Behavior differs >25%; see discussion |
| `reference_cost` | 10.63302 | 8.14543 | 8.448518 | 1.03721 | 0.794555 | Reported ratio; no equivalence claim |
| `reference_no_cache` | 25.623612 | 18.743062 | 18.387974 | 0.981055 | 0.717618 | Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 1 | N/A | N/A | Descriptive / coverage |
| `eligible_disposable_observed` | 69 | 68 | 70 | 1.029412 | 1.014493 | Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 24 | 16 | 0.666667 | N/A | Behavior differs >25%; see discussion |
| `eligible_selected` | 0 | 28 | 17 | 0.607143 | N/A | Behavior differs >25%; see discussion |
| `selected_eligible_disposable` | 0 | 24 | 16 | 0.666667 | N/A | Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 20 | 12 | 0.6 | N/A | Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 17 | 11 | 0.647059 | N/A | Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `successful_unhide` | 0 | 2 | 0 | 0 | N/A | Behavior differs >25%; see discussion |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_same_turn` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_later_turn` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_unhide_calls` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_read_after_compaction` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_read_repeat_visible` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_read_new` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_bash_after_compaction` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_bash_repeat_visible` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_bash_new` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `cache_transitions` | 0 | 20 | 9 | 0.45 | N/A | Behavior differs >25%; see discussion |
| `transition_uncached_growth` | 0 | -167,288 | -81,522 | 0.487315 | N/A | Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.002585 | -0.000412 | 0.159554 | N/A | Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.00001 | 0.000005 | 0.516932 | N/A | Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.014883 | 0.007694 | 0.516932 | N/A | Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 28 | 85 | 3.035714 | N/A | Behavior differs >25%; see discussion |
| `stored_items` | 0 | 28 | 102 | 3.642857 | N/A | Behavior differs >25%; see discussion |
| `original_mismatches` | 0 | 0 | 0 | N/A | N/A | PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `native_originals_checked` | 239 | 140 | 143 | 1.021429 | 0.598326 | Descriptive / coverage |
| `native_tool_content_transitions` | 12 | 29 | 24 | 0.827586 | 2 | Descriptive / coverage |

## Commanded Hide/Summarize trials

A did not have navigation tools and has no component baseline. There are two Hide and two Summarize trials per host. Fact retention is assessed only on facts actually present in a sent replacement's original. A trial with no replacement is a coverage failure, not perfect retention. Pure means every sent replacement in the trial used the expected rule/LLM source. Judge scores use the historical prompt and active DeepSeek/Relace model; they are auxiliary, not a correctness gate.

### OMP

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `trials` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `strict_success` | N/A | 4 | 4 | 1 | N/A | PASS: no observed regression |
| `successful_unhide` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `restores_without_work_rerun` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `restored_original_in_final_request` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `third_turn_work_calls` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `hide_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_pure_replacement_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_sent_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_pure_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_facts_present` | N/A | 6 | 6 | 1 | N/A | Descriptive / coverage |
| `hide_facts_retained` | N/A | 6 | 6 | 1 | N/A | PASS: retained fraction |
| `hide_wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `summarize_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `summarize_pure_replacement_trials` | N/A | 1 | 2 | 2 | N/A | Behavior differs >25%; see discussion |
| `summarize_sent_replacements` | N/A | 1 | 2 | 2 | N/A | Behavior differs >25%; see discussion |
| `summarize_pure_replacements` | N/A | 1 | 2 | 2 | N/A | Behavior differs >25%; see discussion |
| `summarize_facts_present` | N/A | 3 | 6 | 2 | N/A | Behavior differs >25%; see discussion |
| `summarize_facts_retained` | N/A | 2 | 4 | 2 | N/A | PASS: retained fraction |
| `summarize_wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `sent_replacements` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `originals_compared` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `stored_items` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `original_mismatches` | N/A | 0 | 0 | N/A | N/A | PASS: no observed mutation |
| `unmatched_native_items` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `native_originals_checked` | N/A | 8 | 24 | 3 | N/A | Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `requests` | N/A | 31 | 54 | 1.741935 | N/A | RCA: >25% difference |
| `prompt_tokens` | N/A | 305,499 | 556,936 | 1.823037 | N/A | RCA: >25% difference |
| `cached_tokens` | N/A | 238,336 | 458,240 | 1.922664 | N/A | RCA: >25% difference |
| `output_tokens` | N/A | 4,426 | 8,560 | 1.934026 | N/A | RCA: >25% difference |
| `reported_usd` | N/A | 0.003808 | 0.007163 | 1.881308 | N/A | RCA: >25% difference |
| `judge_distinct_eligible` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `judge_scored` | N/A | 3 | 4 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `judge_mean` | N/A | 2 | 2.25 | 1.125 | N/A | Descriptive / coverage |

### HERMES

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `trials` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `strict_success` | N/A | 4 | 4 | 1 | N/A | PASS: no observed regression |
| `successful_unhide` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `restores_without_work_rerun` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `restored_original_in_final_request` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `third_turn_work_calls` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `hide_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_pure_replacement_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_sent_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_pure_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `hide_facts_present` | N/A | 6 | 6 | 1 | N/A | Descriptive / coverage |
| `hide_facts_retained` | N/A | 6 | 6 | 1 | N/A | PASS: retained fraction |
| `hide_wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `summarize_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `summarize_pure_replacement_trials` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `summarize_sent_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `summarize_pure_replacements` | N/A | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `summarize_facts_present` | N/A | 6 | 6 | 1 | N/A | Descriptive / coverage |
| `summarize_facts_retained` | N/A | 6 | 6 | 1 | N/A | PASS: retained fraction |
| `summarize_wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `sent_replacements` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `wrong_source` | N/A | 0 | 0 | N/A | N/A | PASS |
| `originals_compared` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `stored_items` | N/A | 4 | 8 | 2 | N/A | Behavior differs >25%; see discussion |
| `original_mismatches` | N/A | 0 | 0 | N/A | N/A | PASS: no observed mutation |
| `unmatched_native_items` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `native_originals_checked` | N/A | 7 | 10 | 1.428571 | N/A | Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | N/A | 0 | 0 | N/A | N/A | Descriptive / coverage |
| `requests` | N/A | 56 | 50 | 0.892857 | N/A | Reported ratio; no equivalence claim |
| `prompt_tokens` | N/A | 674,177 | 607,695 | 0.901388 | N/A | Reported ratio; no equivalence claim |
| `cached_tokens` | N/A | 540,672 | 494,592 | 0.914773 | N/A | Reported ratio; no equivalence claim |
| `output_tokens` | N/A | 4,743 | 5,293 | 1.11596 | N/A | Reported ratio; no equivalence claim |
| `reported_usd` | N/A | 0.005876 | 0.005798 | 0.986757 | N/A | Reported ratio; no equivalence claim |
| `judge_distinct_eligible` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `judge_scored` | N/A | 4 | 4 | 1 | N/A | Descriptive / coverage |
| `judge_mean` | N/A | 3 | 3.25 | 1.083333 | N/A | Descriptive / coverage |

## Per-fixture breakdown

Two repetitions per host/fixture. No new A or B-old model calls were made.

### OMP/atlas

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `announced_recall` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 19 | 9 | 0.473684 | N/A | Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `list_calls` | 0 | 1 | 2 | 2 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 44 | 17 | 0.386364 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 43 | 17 | 0.395349 | N/A | Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 10 | 5 | 0.5 | N/A | Behavior differs >25%; see discussion |
| `native_compactions` | 22 | 57 | 31 | 0.54386 | 1.409091 | RCA: >25% difference |
| `rereads_repeat_visible` | 2 | 1 | 4 | 4 | 2 | Behavior differs >25%; see discussion |
| `rereads_after_compaction` | 0 | 1 | 0 | 0 | N/A | Behavior differs >25%; see discussion |
| `requests` | 122 | 127 | 127 | 1 | 1.040984 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,955,763 | 5,177,919 | 5,525,949 | 1.067214 | 0.927832 | Reported ratio; no equivalence claim |
| `cached_tokens` | 5,261,056 | 4,367,104 | 4,537,088 | 1.038924 | 0.862391 | Reported ratio; no equivalence claim |
| `output_tokens` | 32,699 | 31,263 | 41,130 | 1.315613 | 1.257837 | RCA: >25% difference |
| `reported_usd` | 0.046823 | 0.042332 | 0.049184 | 1.161857 | 1.050415 | Reported ratio; no equivalence claim |

### OMP/boreal

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `announced_recall` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 12 | 15 | 1.25 | N/A | Descriptive / coverage |
| `sessions_using_navigation` | 0 | 2 | 2 | 1 | N/A | Descriptive / coverage |
| `list_calls` | 0 | 0 | 1 | N/A | N/A | Descriptive / coverage |
| `literal_ids_selected` | 0 | 31 | 35 | 1.129032 | N/A | Descriptive / coverage |
| `literal_ids_valid` | 0 | 30 | 35 | 1.166667 | N/A | Descriptive / coverage |
| `cleanup_boundaries` | 0 | 9 | 12 | 1.333333 | N/A | Behavior differs >25%; see discussion |
| `native_compactions` | 18 | 69 | 58 | 0.84058 | 3.222222 | Reported ratio; no equivalence claim |
| `rereads_repeat_visible` | 10 | 2 | 19 | 9.5 | 1.9 | Behavior differs >25%; see discussion |
| `rereads_after_compaction` | 0 | 0 | 3 | N/A | N/A | Descriptive / coverage |
| `requests` | 122 | 124 | 145 | 1.169355 | 1.188525 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,358,807 | 5,034,374 | 5,634,753 | 1.119256 | 1.051494 | Reported ratio; no equivalence claim |
| `cached_tokens` | 4,749,568 | 4,328,448 | 4,657,152 | 1.07594 | 0.980542 | Reported ratio; no equivalence claim |
| `output_tokens` | 26,207 | 25,820 | 36,931 | 1.430325 | 1.409204 | RCA: >25% difference |
| `reported_usd` | 0.040507 | 0.038788 | 0.047617 | 1.227625 | 1.175528 | Reported ratio; no equivalence claim |

### HERMES/atlas

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `announced_recall` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 1 | 16 | 16 | N/A | Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 1 | 1 | 1 | N/A | Descriptive / coverage |
| `list_calls` | 0 | 1 | 2 | 2 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 0 | 12 | N/A | N/A | Descriptive / coverage |
| `literal_ids_valid` | 0 | 0 | 12 | N/A | N/A | Descriptive / coverage |
| `cleanup_boundaries` | 0 | 0 | 7 | N/A | N/A | Descriptive / coverage |
| `native_compactions` | 15 | 14 | 11 | 0.785714 | 0.733333 | Reported ratio; no equivalence claim |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `requests` | 169 | 121 | 130 | 1.07438 | 0.769231 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,907,516 | 4,204,382 | 3,987,334 | 0.948376 | 0.674959 | Reported ratio; no equivalence claim |
| `cached_tokens` | 4,924,160 | 3,285,760 | 3,097,856 | 0.942813 | 0.629114 | Reported ratio; no equivalence claim |
| `output_tokens` | 126,414 | 105,215 | 74,584 | 0.708872 | 0.589998 | RCA: >25% difference |
| `reported_usd` | 0.093728 | 0.074548 | 0.058118 | 0.779607 | 0.620073 | Reported ratio; no equivalence claim |

### HERMES/boreal

| Metric | A (off) | B-old `37348b8` | B-current `8902a41` | Current/old | Current/A | Verdict |
|---|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 1 | 1 | Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `announced_recall` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 1 | 1 | PASS: no observed regression |
| `navigation_calls` | 0 | 27 | 2 | 0.074074 | N/A | Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 2 | 1 | 0.5 | N/A | Behavior differs >25%; see discussion |
| `list_calls` | 0 | 2 | 0 | 0 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 28 | 5 | 0.178571 | N/A | Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 28 | 5 | 0.178571 | N/A | Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 20 | 1 | 0.05 | N/A | Behavior differs >25%; see discussion |
| `native_compactions` | 13 | 4 | 12 | 3 | 0.923077 | RCA: >25% difference |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | Unavailable; not zero |
| `requests` | 173 | 165 | 146 | 0.884848 | 0.843931 | Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,989,242 | 4,602,805 | 4,511,313 | 0.980123 | 0.753236 | Reported ratio; no equivalence claim |
| `cached_tokens` | 5,069,568 | 3,779,328 | 3,528,448 | 0.933618 | 0.696006 | Reported ratio; no equivalence claim |
| `output_tokens` | 102,348 | 35,871 | 99,251 | 2.766887 | 0.96974 | RCA: >25% difference |
| `reported_usd` | 0.08204 | 0.041773 | 0.073165 | 1.751488 | 0.891821 | RCA: >25% difference |

## Root-cause analysis

The original investigation below supersedes the initial attribution limits where
it provides stronger evidence. That investigation changed no outcome, selection,
metric, product implementation or original campaign evidence; the subsequent
implementation repairs are identified separately in the next section.
**New model spend: $0.00**; all additional experiments were deterministic, local
and network-free. No old OMP
daemon was restored or run. Old Python engine/validator modules were extracted
solely for in-process counterfactuals.

### RCA repairs — fixed in `164655f`

The verified product/prompt-control defects below are **fixed in `164655f`**
(`164655f2218523f19c737ada7cf09d34595ca819`). The historical campaign tables and
wire-derived diagnoses remain unchanged: these are deterministic repair replays,
not replacement campaign cells or newly measured stochastic retention rates.

| Finding | Repair and replay result |
| --- | --- |
| 12,000-character summary prefix | Python/Hermes and TS core/OMP/Paseo now use a whole-source contract: send every byte up to 32,768 UTF-8 bytes; refuse larger sources with `input_too_large` before any LLM call. OMP also lowers the limit for known small model windows. All five captured old/current summary-prefix cases now include the complete 21,697-byte source, including `latency_budget_ms=151` after offset 15,601. Explicit Summarize never silently falls back. |
| Grouped-number retry | The captured retry is accepted in both languages. Only valid thousands-comma spelling is normalized; paths, identifiers, units, exit claims, warnings and injection checks remain strict. Keep-lines resolves back to the exact source spelling. Originals remain unchanged. |
| Broad `minute` keep-lines | All three captured requests now return the specific `keep_lines_too_broad` error in both languages, not generic `verification_failed`. They are **not successful hides**: the requested matching rows exceed the existing safe excerpt budget. The fix preserves those caps and refuses explicitly rather than silently discarding requested rows. |
| Misleading filtered listing | OMP constructs its recorded-call set from the full stored listing before applying the display query. The captured query no longer invents an unrecorded/unhidden row. Python/Hermes did not have this snapshot-merge defect; engine and actual adapter regression tests pin their already-correct filtered behavior. |
| Tool-order parity | Registration and actual local SDK request tests pin list, manage, hide, summarize, unhide, matching captured `37348b8` exposure. This is distinct from the old source registration sequence. |
| Hermes toolchain prompt | The evaluator uses its terminal interpreter on `PATH`, warms the host probe and verifies the resulting line in the stock prompt before generation. An offline real-Hermes prompt check reproduced the exact historical Python 3.12.15/no-pip line; Hermes's isolated 3.14.9 engine was unchanged. Missing probe/prompt text now fails closed. No machine fact is hard-coded into the plugin prompt. |

The repeated model-facing audit against **both `37348b8` and `origin/main`** is in
`docs/model-facing-text-audit.md`. It explicitly corrects the previous audit's
missed exposure-order and environment-line differences. Names, labels, schema
tokens, guidance, reminder header and Hermes supervision text match, apart from
the intended `270353f` manage-description difference against `37348b8` and the
documented new summary/error semantics. Native compression and stochastic output
or adoption variation have not been changed or claimed eliminated.

Checks (builds/typechecks exited 0; complete logs are under external
`step8-eval/rca/fix-*.log`):

```text
375 passed, 11 skipped in 31.38s                         # Python
core Node: tests 23; pass 23; fail 0                    # plus typecheck
core Bun: 23 pass; 0 fail
OMP: 57 pass; 0 fail; 580 expect() calls               # plus build/typecheck
Paseo: 131 pass; 0 fail; 562 expect() calls            # plus build/typecheck
Paseo Node worker: tests 8; pass 8; fail 0              # regenerated worker-source
PASS differential Python vs TS+node: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+node -> Python and reverse
PASS differential Python vs TS+bun: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+bun -> Python and reverse
Ran 54 tests in 40.139s; OK                            # eval offline suite
Ran 3 tests in 1.404s; OK                              # final SDK-order/probe regressions
PASS Python engine and Hermes source/vendor parity
PASS candidate files contain no provisioned API-key value
PASS git diff --check
```

The first Python run exposed a test-only empty-tuple/list assertion mismatch;
the core typecheck exposed an optional assertion-message type mismatch. Both new
tests were corrected and their checks passed. The bare repository Python lacked
the optional eval `tiktoken` dependency; the documented
`uv run --no-sync --with tiktoken` environment completed the offline suite. No
shared Hermes environment or dependencies were modified.

Replays are reproducible with `tools/replay_rca_fixes.py` and
`tools/replay_rca_fixes.ts` over the external RCA directory; see `eval/README.md`.
Contract/fixtures and four-way differential/persistence conformance cover UTF-8
boundaries, empty source, late facts, grouped/invalid numbers, strict nonnumeric
claims and broad retention. **New spend: $0.00.** The optional paid summary was
not used, so actual post-fix LLM fact retention and full-campaign resource ratios
have not been remeasured. Markdown/UI was not visually rendered.

### Evidence and limits of causal identification

Historical wire/stage files were checked against **12 original git blobs at
`d3e77e6^`**, byte-for-byte. Current evidence is the paid campaign under
`/Users/devin/nav-phase0-gates/step8-eval/`, selected without quality filtering
in `comparison/{historical,current}-{long,components}`. Every request ID below
identifies a `kind=request` row and its same-ID `kind=response` in `wire.jsonl.gz`.
Turn attribution uses the run's timestamped `kind=user` events, not a count of
model-visible user messages: reminders and native handoff prompts are also user
messages. Cleanup boundary indices retain the frozen scorer's `boundary_index`
semantics (cleanup before any work in turn N can count toward boundary N−1).

Audit scripts, exact summary request bodies/responses, replay inputs, per-request
usage, full operation IDs/arguments, source hashes and unified tool/system diffs
are retained in `/Users/devin/nav-phase0-gates/step8-eval/rca/`. In particular:
`runs.json`, `summary.json`, `analysis.log`, `details.log`, `more.log`,
`*-{tool,system}.diff`, `*-request.json`, `*-response.txt`, and the replay scripts.
Large original request bodies remain outside git. Only this report is changed.

An observed choice is not proof of its counterfactual cause. The deterministic
experiments below isolate truncation, reminder logic, replacement generation,
validation and listing. They do **not** identify a unique causal effect of tool
ordering, a one-day provider/backend change, or unrecorded old runtime state on
a stochastic model's later choices. Two or three live repeats cannot recover
those missing historical controls, so no money was spent presenting such a
sample as causal identification. Residual uncertainty is named, not relabelled
as a confirmed regression or confirmed model-only variance.

### 1. Every missed Summarize fact: identical input, pre-existing truncation

**Verdict: unchanged bounded product behavior with a pre-existing fact-loss
limitation; not a TS migration regression. The pooled rate difference is an
acceptance/coverage denominator effect, not an additional kind of missing fact.**

The full native read result is **21,697 ASCII bytes** (the on-disk fixture has
one additional terminal newline), SHA-256
`6a38bb208da0aff2402e4bbdab1a6fe827e7d2103b7f88a32b12a4e31fd29867`.
The source has 100 telemetry rows, ending `2026-10-01T01:39:00Z`, and these exact
metadata lines (zero-based character offsets shown):

```text
3945:  owner=component-team-1
9550:  audit_seal=component-9e54cadbf4
15601: latency_budget_ms=151
```

All five OMP summary calls—both historical trials, both current trials and the
current first trial's retry—send **exactly the same 12,086-byte prompt**:

```text
Summarize this tool result in one paragraph. State only facts present in the result.

<the first 12,000 characters of the identical native read result>
```

The angle-bracket line above is notation, not sent text. The actual full text
is preserved in each ID's `rca/<id>-request.json`; its SHA-256 is
`3ddbb298cf90241284560feb5b0dd76f92386b031c4cc1ddbe8ad67c54c5c871`.
The byte diff across all five actual prompts is **empty: 0 changed bytes**.
The entire messages array and all other captured request fields also match:
model `deepseek/deepseek-v4.1-flash-1017`, `stream=true`,
`stream_options={"include_usage":true}`, `max_tokens=4096`; no temperature override.
Upstream Relace/no-fallback/reasoning-off settings were separately pinned.

`37348b8:extensions/pi/session-navigation.ts::summarizeText` and current
`packages/omp/src/extension.ts::summarizeText` use the same literal instruction
and `content.slice(0, 12000)`. There is no new source/evidence-selection step
between them. The cut is inside the `00:55` telemetry row, **3,601 characters
before** the latency fact. Neither model was told `latency_budget_ms=151`.
It must not invent that value from unrelated telemetry numbers. The engine's
required-evidence list on this source is only the first audit-header line;
it does not obligate retention of these three evaluation-specific metadata facts.

**v4q-omp-command-summarize-B-new-1, request `7864a66ffa40408a9ab78e64e63a30b9`** (accepted/sent, missing latency):

> The result is a component service telemetry audit of distinct minute/region measurements, listing records from 2026-10-01T00:00:00Z through 2026-10-01T00:54:00Z and a partial record at 2026-10-01T00:55:00Z for region eu-west, with each record containing fields for minute, region, service, requests, p50_ms, p99_ms, cpu_pct, queue_depth, cache_hit_pct, worker_pool, and payload_bytes. The records cover regions us-east, eu-west, and ap-south and services component-svc-0 through component-svc-6, with worker pools pool-0 through pool-4. The output also includes the line owner=component-team-1 and the line audit_seal=component-9e54cadbf4.

**v4q-omp-command-summarize-B-new-2, request `1929da8d90f347298d8dc92601635f76`** (rejected/no eligible replacement, also missing latency):

> The audit result contains 55 distinct minute/region telemetry measurements from 2026-10-01T00:00:00Z through 2026-10-01T00:54:00Z (the final line for 2026-10-01T00:55:00Z is truncated and incomplete), covering services component-svc-0 through component-svc-6 across the us-east, eu-west, and ap-south regions, with each record reporting requests, p50_ms, p99_ms, cpu_pct, queue_depth, cache_hit_pct, worker_pool, and payload_bytes. Recorded request counts range from 1,256 (component-svc-4, eu-west, 00:46) to 9,770 (component-svc-1, eu-west, 00:01); p50 values range from 12 ms to 53 ms; p99 values range from 90 ms to 229 ms; cpu_pct ranges from 15 to 84; queue_depth ranges from 0 to 31; cache_hit_pct ranges from 70 to 97; and payload_bytes ranges from 556 to 4,939. The output also includes owner=component-team-1 and audit_seal=component-9e54cadbf4.

**current-omp-command-summarize-B-new-1-try1, request `b369c0b6ec5841f39df66d53e23f8a8f`** (accepted/sent, missing latency):

> The component service telemetry audit contains distinct minute/region measurements for component-svc-0 through component-svc-6 across us-east, eu-west, and ap-south regions, with each record listing requests, p50_ms, p99_ms, cpu_pct, queue_depth, cache_hit_pct, worker_pool, and payload_bytes; the data runs from 2026-10-01T00:00:00Z through 2026-10-01T00:55:00Z (the final eu-west record is truncated). The result includes owner=component-team-1 and audit_seal=component-9e54cadbf4.

**current-omp-command-summarize-B-new-1-try1, request `8d899cbe152f4116b805ece36728bc6d`** (rejected/no eligible replacement, also missing latency):

> The audit result contains 56 distinct minute/region telemetry measurements for services component-svc-0 through component-svc-6 across the us-east, eu-west, and ap-south regions, spanning minutes from 2026-10-01T00:00:00Z through 2026-10-01T00:55:00Z (with the final entry truncated). Each record includes requests, p50_ms, p99_ms, cpu_pct, queue_depth, cache_hit_pct, worker_pool, and payload_bytes; observed values include requests ranging from 1,256 to 9,770, p50_ms from 12 to 53, p99_ms from 90 to 229, cpu_pct from 15 to 84, queue_depth from 0 to 31, cache_hit_pct from 70 to 97, worker pools pool-0 through pool-4, and payload_bytes from 556 to 4,939. The result also states owner=component-team-1 and audit_seal=component-9e54cadbf4.

**current-omp-command-summarize-B-new-2-try1, request `f378e6db825d4ca68324d2aeca430c67`** (accepted/sent, missing latency):

> The result is a component service telemetry audit covering distinct minute/region measurements from 2026-10-01T00:00:00Z through at least 2026-10-01T00:54:00Z, with each record listing minute, region (us-east, eu-west, or ap-south), service name (component-svc-0 through component-svc-6), requests, p50_ms, p99_ms, cpu_pct, queue_depth, cache_hit_pct, worker_pool (pool-0 through pool-4), and payload_bytes. The records include an owner line of component-team-1 and an audit_seal of component-9e54cadbf4. The final record for 2026-10-01T00:55:00Z in eu-west is truncated and includes no metric values.


Hypotheses and discrimination:

| Hypothesis | Evidence for / against | Conclusion |
|---|---|---|
| Current model omitted a supplied latency fact | Every accepted summary omits it, but it is absent from **every actual summarizer input**, old and current | Rejected as omission of available evidence |
| Migration changed the prompt, source, prefix length or evidence selection | Native source hash, complete prompt bytes, request controls and code slices all match | Rejected on these calls |
| Shared 12k prefix discards late metadata | Exact latency offset 15601 exceeds cutoff 12000; owner/seal remain within cutoff; every output follows that availability pattern | Verified input-loss cause |
| Pooled 8/9→10/12 is worse per-target summarization | Old trial 2 produced no accepted replacement; current trial 2 does. The additional replacement contributes 2/3, while Hermes remains 6/6 | Denominator/accepted-coverage change |

Old trial 2 (`1929da8d90f347298d8dc92601635f76`) emits comma-formatted numbers
`1,256`, `9,770`, `4,939`, absent verbatim from the source's ungrouped numbers.
It receives `verification_failed`, so it contributes no eligible replacement.
The current first-trial retry has the same formatting defect. In-process old
and current validators both accept the first current summary, reject the retry,
and accept the retry when **only numeric grouping commas are removed**.
Thus acceptance variation is model wording interacting with the same strict
validator, not changed summarizer inputs. The same logical target in **both old
trials** lacks the latency fact; only old trial 1 entered the retention denominator.

Proposal (not implemented): replace blind prefix-only sampling with a bounded,
general source-evidence selection contract that preserves late metadata/critical
facts, and test facts before/after the cutoff. Separately decide whether verified
numeric-format equivalence should be accepted. These address pre-existing
limitations, not a demonstrated current regression; do not hard-code fixture keys.

### 2. Adoption: choices, actual reminder timing and model-facing byte differences

**Verdict: changed model trajectories with verified product-surface and harness
differences; reminder-policy regression is disproved on replay. `270353f` is an
intended behavior change. The numerical coverage decline cannot uniquely be
assigned to model variance versus those changed inputs.**

| Session | B-old boundary indices; choices | Current boundary indices; choices |
|---|---|---|
| omp atlas 1 | [7, 12, 14, 22]; t7 H(07,06,05)!; t7 H(07); t8 H(08,06,05)!; t9 H(08,06,05)!; t10 H(10,09,08)!; t12 H(11,10,09); t13 A(12,08)!; t14 H(12,08,06)~; t15 H(call_93f6a1d05b8c49a5b60c3e0d)!; t18 H(15,16,17)!; t21 H(19,18)!; t23 H(20,19,18) | [6, 11, 12, 14]; t7 S(06,05,04)!; t7 H(06,05,04); t11 H(10,09); t12 H(11); t14 H(12,13); t22 H(18,19,20) |
| omp atlas 2 | [4, 7, 13, 16, 17, 18]; t4 H(04,02,03); t7 H(07,06,05); t13 H(12,11,10); t16 H(13,14,15); t17 H(16); t18 H(17) | [22]; t23 H(20,19,18) |
| omp boreal 1 | [6, 8, 10, 15, 16, 21]; t6 H(06,05,04)!; t6 H(06,05,04)~; t7 H(05,04)!; t8 H(08,07,05); t10 H(10,09,04); t15 H(12,13,14); t16 H(15); t21 H(18,19,20) | [3, 12, 13, 14, 15, 21]; t3 H(03,02,01); t12 H(10,09,08)!; t12 H(10,09,08)!; t12 H(11,09); t13 H(12,10,08); t14 H(13); t15 H(14); t21 H(18,19,20) |
| omp boreal 2 | [6, 8, 17]; t6 H(06,05,04); t8 H(08,07,03); t9 H(call_8f3a6b0f0f8c4fb5991dca78)!; t17 H(16,15,14) | [6, 9, 13, 17, 18, 23]; t7 H(06,05,04); t10 H(09,08,07); t13 H(12,11,10); t17 H(14,15,16); t18 H(17); t23 H(15,08,01) |
| hermes atlas 1 | []; no cleanup chosen | [5, 14, 15, 16, 19, 20, 22]; t5 H(unknown)!; t5 H(unknown)!; t5 H(05); t5 H(04); t14 H(13); t14 H(12); t14 H(11); t15 H(14); t16 H(15); t19 H(18); t19 H(17); t19 H(16); t20 H(19); t23 H(20) |
| hermes atlas 2 | []; no cleanup chosen | []; no cleanup chosen |
| hermes boreal 1 | [10, 13, 17, 20]; t10 A(10,09,08); t13 A(12,11); t17 H(16,15,14); t20 A(19,18,17) | []; no cleanup chosen |
| hermes boreal 2 | [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]; t1 H(unknown)!; t1 H(01); t2 H(02); t3 H(03); t4 H(04); t5 H(05); t11 H(10); t11 H(09); t12 H(11); t13 H(12); t14 H(13); t15 H(14); t16 H(15); t17 H(16); t18 H(17); t19 H(18); t20 H(19); t21 H(20) | [4]; t4 A(02,03,04); t20 A(19,18) |

Here `H` is Hide, `A` is manage/auto, `S` is explicit Summarize; a suffix `!`
means no target applied, `~` means partial success. Numbers identify audit files
(`02` = `audit-02.jsonl`); other tool targets are shown by command/path. These
are actual choices, including unsuccessful ones—not a fictional matched replay.
Full literal IDs, keep-lines arrays and responses are in `details.log`/`runs.json`.

**OMP model-facing changes actually sent:** per-name tool schemas match except
the `manage_context` description. The old description is:

```text
Clean agent-chosen tool_call_ids. action: hide=rules, summarize=session LLM, auto=summary with rule fallback. keep_lines: exact single-line substrings to retain (hide only, total 1024 bytes).
```

Current is:

```text
Clean agent-chosen tool_call_ids. action: hide=rules, summarize=session LLM, auto=summary with rule fallback. keep_lines: single-line substrings (hide only, 1024 bytes per target). Whitespace/line-number near misses are normalized. Unmatched or invalid entries are ignored per target with English reasons in keep_lines_ignored; valid entries still apply.
```

There is also a previously unreported **registration-order difference**:
old navigation suffix `[list_context_items, manage_context, hide_context,
summarize_context, unhide_context]`; current `[hide_context, summarize_context,
unhide_context, list_context_items, manage_context]`. The OMP system tool-policy
list changes in the same order. This is a migration surface difference; no
evidence establishes that its effect on quality was intentional or that it
caused this coverage decline. Proposal: restore the old main-session order in a
separate parity change, then hold it fixed in future comparisons. No fix here.

OMP's appended `CLEANUP_GUIDANCE` bytes are unchanged. The first user message's
host `<system-reminder>` has a different date/workspace path. No other first-call
request controls differ in the four OMP pairs. Later bodies cannot be byte-equal
after different tool choices, hidden results, answers and native pruning.

**Hermes:** the first-call tools array and plugin human-supervision section are
byte-identical. The full system prompt is **not**: old includes
`Python toolchain: python3=3.12.15 (no pip module), pip=missing, PEP 668=yes (use venv or uv), uv=installed.`;
current omits that line. Date and isolated home/workspace/scratch/profile paths
also differ. This is a verified host/provisioning input confound. Neither arm's
Hermes long wire actually exposes the changed manage-context description:
no `tool_describe` requests that tool; the actual discoveries are list/restore
or list/hide. A schema difference in source that was not sent cannot explain
these Hermes model choices.

**Reminders:** the old/current OMP state machine is replayed with all **287
actually emitted OMP notes** and 64 timing/tier/empty-candidate cases. For the
same inputs, both implementations produce byte-identical captured notes and
the same firing decisions. The entire Hermes reminder source file is
byte-identical to `37348b8`. Both policies permit one note per logical user state
and additional notes on 50/75/90% tier crossings; they are advisory, not forced
cleanup. OMP subtracts projected savings before rendering usage, so a successful
hide can lower the displayed tier (including a clamped zero). This is present
in old too, not a newly missing reminder.

The **actual firing points are not equal**. The following complete delivered-note
schedule gives `event turn: advertised token estimate(s)` for every session.
Repeated estimates are separate requests, including native handoff activity;
they are not duplicate evidence counted as fresh product failures. The advertised
estimate is not the provider's measured prompt usage. All windows are 65,536.

**omp / atlas**

```text
historical rep1 (37): 1:6058 2:14625 3:23387 4:32012,40108 5:40861 6:49229 7:57776,57842,65942 8:53517,61613 9:62683 10:26673,34739 11:35741 12:44367,52543 13:12409,20454,20454 14:21354 15:3005 16:12010 17:20626 18:29281,37391 19:31988,40060 20:40842 21:49219 22:58052,58090,59049 23:59496 24:18867 25:19582
current rep1 (39): 1:6072 2:14663 3:23513 4:32274,40513 5:41259,49362 6:50114 7:58652,58718,59351 8:26926,35340 9:36092 10:44841,53315 11:27981,36470 12:17821 13:13374 14:14303,22613,22613 15:4382 16:5323 17:14271 18:23464 19:32638,41336 20:35718 21:44952,53714 22:54395,54433,41388,41388 23:18549 24:19040,33483
historical rep2 (31): 1:13737 2:14760 3:23297 4:32026,40134 5:102 6:8825 7:17561,25667,25667 8:0 9:0 10:3098 11:11786 12:20527 13:29325,37417 14:0 15:6129 16:29817,37876 17:5765 18:1129 19:0,0 20:0 21:6156 22:14896 23:20038 24:20526 25:24097
current rep2 (37): 1:13057 2:13989 3:22432 4:31056,39157 5:39904 6:48282,56390 7:57074,57140,65040 8:66065 9:24798,32900 10:33677 11:42023,50142 12:50887 13:59242,59308 14:67923 15:35113 16:43750,51854 17:52604,60506,60506 18:61255 19:69622 20:36888 21:45503,53609 22:54292,54330 23:55672 24:15039 25:15899
```

**omp / boreal**

```text
historical rep1 (36): 1:6051 2:14584 3:23162 4:31758,40049 5:40586 6:48936,57228,57808,57808 7:44862,53154 8:53932,62235 9:21857 10:30491,38784 11:0 12:6998 13:15696 14:24291 15:28642,36903 16:4603 17:13 18:730,8830,8830 19:9405 20:17830 21:26470,34802 22:0 23:0 24:0 25:4872
current rep1 (36): 1:6080 2:15131 3:24253,33016 4:0 5:1790 6:11132,19627,19627 7:20459 8:29831,38270 9:39101 10:30275,38652 11:40271 12:49404,59242,59242 13:32759,41071 14:8838 15:4170 16:0 17:324 18:8891 19:17618 20:38308 21:47035,55459,38646,38646 22:15307 23:16897 24:17370 25:18202
historical rep2 (37): 1:6067 2:14656 3:23310 4:31904,40197 5:40740 6:49099,57391,40532,40532 7:17044 8:25422,33723 9:0 10:1970 11:10538 12:19162 13:27769,36064 14:26875,35147 15:35722 16:44098,52394 17:52934,61029,61029 18:20453 19:29057,37346 20:37887 21:46249,54539 22:29753 23:31485 24:31870 25:32236
current rep2 (34): 1:6080 2:14672 3:23345 4:31973,40294 5:40834 6:49221 7:57783,57849 8:25586,33908 9:34450 10:42836 11:10521 12:19166 13:27794,36115 14:0 15:4323 16:12969 17:28432,36722 18:4531 19:0 20:548,8686,8686 21:9261 22:20985 23:27524,59511,59511 24:20919 25:22575
```

**hermes / atlas**

```text
historical rep1 (35): 1:6106 2:14164 3:22194 4:30223,38053 5:38305,24935 6:25250,33086 7:33407 8:41601,17711 9:18068 10:26258,34091 11:34431 12:26227 13:26651,34485 14:34925 15:19860 16:28192,36027 17:36520,20712 18:21220 19:29578,37410 20:37950,21565 21:22120 22:30485 23:32671 24:33433 25:33584
current rep1 (30): 1:6246 2:14302 3:22358 4:30420,38255 5:38477,24738 6:19089 7:19311 8:27396,35232 9:35481 10:25898,33736 11:33939 12:42124,18824 13:19050 14:27107,34944 15:21003 16:21805 17:22602 18:22859 19:30954,38791 20:24867 21:25638 22:25856 23:28250
historical rep2 (37): 1:13398 2:13646 3:21700 4:29754,37584 5:37796,24541 6:24781 7:32830 8:40900,25956 9:26196,34027 10:34240 11:27569,35618 12:35874 13:28803,36636 14:36850,27018 15:27231,35066 16:35305 17:27885,35718 18:35959 19:28673,36505 20:36734,29217 21:29429,37263 22:37436 23:39683 24:40114 25:40946
current rep2 (37): 1:6253 2:14316 3:22358 4:30385,38220 5:38409,24572 6:24761 7:32790 8:40841,25311 9:25520,33355 10:33544 11:41535,26914 12:27166,35005 13:35194 14:26586,34423 15:34612 16:27464,35304 17:35515 18:28060,35898 19:36097,28505 20:28697,33246 21:36953,27963 22:28122 23:30361 24:30635 25:31007
```

**hermes / boreal**

```text
historical rep1 (34): 1:6796 2:14879 3:22937 4:30994,38854 5:39052,24352 6:24700 7:32755,40614 8:40952,17937 9:18343 10:26401,34260 12:28454 13:28653,36510 14:29728 15:29927,37787 16:38012,27871 17:28097,35957 18:21926 19:22112 20:30158,38017 21:23772 22:23919 23:29000 24:29227 25:29585
current rep1 (34): 1:6312 2:14411 3:22472 4:30532,38397 5:38684,16921 6:17247 7:25306,33170 8:33394 9:41483,18116 10:18546 11:26591,34479 12:34800 13:18790 14:26870,34733 15:34957 16:20004 17:28117,35981 18:36205 19:21242 20:29330,37194 21:37418,22111 22:22296 23:24545 24:24923 25:25178
historical rep2 (27): 1:13705 2:15079 3:16019 4:16954 5:17887 6:18829 7:19046 8:27269,35251 9:35493 10:20351 11:28513,36691 12:30344 13:31289 14:32234 15:33177 16:34145 17:35147 18:36091 19:37032 20:37974 21:38918 22:36047 23:37124 24:37456 25:38165
current rep2 (35): 1:13738 2:13981 3:22175 4:30368,38360 5:16285 6:24484 7:32680,32804 8:40905,25691 9:25923,33915 10:34122 11:26317,34331 12:34714 13:19629 14:27830,35822 15:36065 16:21185 17:29434,37427 18:37658,29981 19:30213,38205 20:38437,31100 21:24647 22:24837 23:26769 24:27097 25:27324
```


`270353f` genuinely changes downstream payloads: replaying historical Atlas-1's
failed three-target batch (`call_cf5bdbf04f074cfbb6d5093d`, turn 7), with the exact
same source/keep-lines, gives **3/3 invalid_keep_lines on 37348b8 → 3/3 applied
on current**, with per-target ignored diagnostics. Old OMP long has 24
`invalid_keep_lines` target errors; current has none and 29 ignored entries.
More effective hiding changes candidate counts, savings, later pressure and
therefore reminders/native triggers. This effect is intended, not a migration
bug. It does not force the model to choose cleanup more often.

Current Boreal-1 has six `verification_failed` target results in two broad-retention
batches at turn 12. The accepted substring `"minute"` selects all 100 telemetry
rows and exceeds the rule selector's excerpt-byte cap (`RuleSpanSelector.select`
/ `selectRule`). Replaying the second batch on **both** versions produces the
same three verification failures. This is not evidence of a new TS validator bug.

The gate changes are localized: OMP Atlas-2 falls from six qualifying boundaries
to one; Hermes loses two qualifying Boreal sessions and gains one Atlas session.
The others stay qualifying. Hypothesis of absent/changed cleanup instructions is
disproved; hypothesis of a changed reminder algorithm is disproved. Tool order,
the intended keep-lines semantics, actual history/pressure and Hermes toolchain
text remain reachable input differences. Calling the remaining choice change
confirmed model-only variance would be unjustified.

| Hypothesis | Evidence for | Evidence against / limit | Verdict |
|---|---|---|---|
| Reminders changed or were lost | Actual schedules differ | Fixed-input replay matches 287 notes and tier/empty behavior; Hermes module unchanged | Reminder-policy regression rejected |
| Keep-lines change reduced capability | Changed replies/history are reachable | Fixed old failed batch succeeds on current; invalid target errors disappear | Intended behavior change, not demonstrated loss of capability |
| Tool order/host prompt caused decline | Bytes differ before choices diverge | No matched control isolates their effect | Reachable product/harness confound, causal share unverified |
| Model variance alone | Different choices despite identical advisory guidance | Complete histories are not identical | Plausible, not uniquely established |

### 3. OMP output: native handoffs plus longer visible answers, not hidden reasoning

**Verdict: host-native handoff behavior and model-output/tool-choice variation,
with the product-surface confounds in §2; no demonstrated default-projection
regression.** The split below exactly reconciles the +20,978 output tokens.

Important correction to a simple "tools present = ordinary work" classifier:
OMP native handoff requests **retain all nine tools**. They are identified by
the final non-navigation user instruction beginning
`<critical>\nWrite a handoff document for another instance of yourself.`
All **23** old/current requests with that native instruction have the same full
instruction SHA-256
`8f71c67d612b17c6691a91ce0ae5154bab8e6b422c1febe8134c0a1164352555`.
The provider prompt is a handoff, not the user's request for a longer answer.

| Session | Old handoff req/output | Current handoff req/output | Old ordinary tool/answer output | Current ordinary tool/answer output | Total Δ |
|---|---:|---:|---:|---:|---:|
| atlas 1 | 3/5,039 | 4/5,705 | 5,838/5,275 | 3,609/15,432 | +8,594 |
| atlas 2 | 2/3,115 | 4/8,251 | 6,996/5,000 | 2,762/5,371 | +1,273 |
| boreal 1 | 2/3,631 | 3/5,651 | 5,317/4,985 | 10,910/7,160 | +9,788 |
| boreal 2 | 2/3,839 | 3/3,229 | 3,073/4,975 | 4,269/5,712 | +1,323 |

| Session | Old total output | Current total output | Current/old | Delta |
|---|---:|---:|---:|---:|
| Atlas 1 | 16,152 | 24,746 | 1.532× | +8,594 |
| Atlas 2 | 15,111 | 16,384 | 1.084× | +1,273 |
| Boreal 1 | 13,933 | 23,721 | 1.703× | +9,788 |
| Boreal 2 | 11,887 | 13,210 | 1.111× | +1,323 |

Old has **9** handoff-instruction requests; current **14** (some current responses
call a tool rather than finish the handoff, so these are not 14 independent
completed documents). Native handoffs add **7,212** tokens of the increase;
ordinary no-tool responses add **13,440**; ordinary tool-bearing responses add
only **326** net. Reasoning usage is zero and the large `## Goal` responses are
explained by explicit native handoff prompts, not evidence of hidden reasoning.

Output per user turn is `old/current/Δ`, including paid native handoffs.

| Turn | Atlas 1 | Atlas 2 | Boreal 1 | Boreal 2 |
|---:|---:|---:|---:|---:|
| 1 | 569/657/+88 | 367/255/-112 | 364/900/+536 | 495/493/-2 |
| 2 | 250/386/+136 | 353/249/-104 | 230/653/+423 | 228/262/+34 |
| 3 | 239/381/+142 | 351/241/-110 | 224/835/+611 | 232/259/+27 |
| 4 | 239/482/+243 | 693/246/-447 | 225/829/+604 | 234/260/+26 |
| 5 | 240/469/+229 | 362/244/-118 | 226/800/+574 | 229/261/+32 |
| 6 | 239/447/+208 | 353/243/-110 | 2424/2472/+48 | 2139/260/-1879 |
| 7 | 2279/2611/+332 | 2042/2179/+137 | 607/747/+140 | 236/2160/+1924 |
| 8 | 708/625/-83 | 354/473/+119 | 644/837/+193 | 432/259/-173 |
| 9 | 623/614/-9 | 354/246/-108 | 227/1000/+773 | 378/261/-117 |
| 10 | 608/1219/+611 | 354/246/-108 | 609/1459/+850 | 239/410/+171 |
| 11 | 315/492/+177 | 428/284/-144 | 326/684/+358 | 235/256/+21 |
| 12 | 580/818/+238 | 354/246/-108 | 230/3721/+3491 | 230/260/+30 |
| 13 | 2307/694/-1613 | 692/2190/+1498 | 230/691/+461 | 409/600/+191 |
| 14 | 571/2646/+2075 | 354/428/+74 | 399/635/+236 | 233/262/+29 |
| 15 | 549/754/+205 | 523/247/-276 | 566/661/+95 | 229/259/+30 |
| 16 | 288/826/+538 | 702/283/-419 | 716/393/-323 | 274/457/+183 |
| 17 | 249/811/+562 | 662/2025/+1363 | 272/357/+85 | 2506/709/-1797 |
| 18 | 859/837/-22 | 685/245/-440 | 2517/358/-2159 | 230/605/+375 |
| 19 | 248/1704/+1456 | 2169/426/-1743 | 271/614/+343 | 231/311/+80 |
| 20 | 249/893/+644 | 398/246/-152 | 274/361/+87 | 233/563/+330 |
| 21 | 436/989/+553 | 398/246/-152 | 656/2472/+1816 | 410/315/-95 |
| 22 | 2507/3253/+746 | 842/3575/+2733 | 738/906/+168 | 782/846/+64 |
| 23 | 622/1116/+494 | 338/625/+287 | 330/485/+155 | 333/2386/+2053 |
| 24 | 140/673/+533 | 420/455/+35 | 234/480/+246 | 270/163/-107 |
| 25 | 238/349/+111 | 563/241/-322 | 394/371/-23 | 440/333/-107 |

Work calls in captured responses (`read/Bash/edit/write`):

| Session | B-old | Current |
|---|---:|---:|
| atlas 1 | 22/4/1/0 | 23/5/1/0 |
| atlas 2 | 2/25/1/0 | 23/5/1/0 |
| boreal 1 | 24/4/1/0 | 23/18/0/1 |
| boreal 2 | 23/4/1/0 | 28/4/1/0 |

These are calls, not unique fixture reads: Bash also runs tests and diagnostics. Frozen scorer reread metrics above remain authoritative; the turn evidence identifies actual repeated reads rather than treating every Bash call as a reread.

Specific aligned-turn evidence:
- Atlas-1 turn 14: **571→2,646**. Native handoff response
  `f78c1859a3e94b9d946bd89b201976dc` is 1,763 tokens, then a 659-token final
  answer. Turn 19: **248→1,704** includes two lengthy no-tool answers (840/799).
- Atlas-2 turn 22: **842→3,575**; `68a9e016ec314ba1ab05d5cea940f4c6`
  spends 2,807 on the native handoff before the ledger diagnosis/fix. Turns
  13/17 have 1,945/1,779-token handoffs rather than ordinary extra rereads.
- Boreal-1 turn 12: **230→3,721**; two failed broad keep-lines batches, one read,
  a Bash diagnostic, a 2,256-token handoff
  (`9483694fa5394762934dcefcdc9fd743`), and a cleanup/final-answer pair.
  The native limit and rule-cap failures are real contributors on this path.
- Boreal-2 turn 23: **333→2,386**; four reads, a 1,227-token native handoff
  (`d4d32ad6aee74ac4afab8528399f0f6c`), cleanup and a 691-token memo.

Request payload alignment finds the product differences in §2, not a new summary
prompt. A deterministic replay on **20 captured audit targets** gives byte-identical
default-Hide replacement text between `37348b8` Python and current TS, normalizing
only item IDs. The same captured mixed-target keep-lines batch differs exactly
as `270353f` specifies. This rules out a default replacement-template/selector
regression on those targets; it does not prove all later generated requests equal.
Projected placeholders, model-selected keep-lines and native `[shaken …]` rows
differ later because operations and native shaking occur at different times.
Native start counters 126→89 are mostly skipped handoff checks, not paid-call
counts; their decrease does **not** contradict more paid handoff requests.

Alternative hypotheses: extra product LLM summaries are ruled out (zero OMP
long session-model summary calls in both versions); fixture/source inflation is
not found on aligned reads; pure extra tool-call volume is insufficient (only
326 net ordinary tool-bearing tokens). A unique share attributable to reordered
tools versus stochastic answer verbosity is not identifiable from these captures.

| Hypothesis | Evidence for | Evidence against / limit | Verdict |
|---|---|---|---|
| Extra product summaries | Cleanup choices differ | No standalone OMP long summary request in either arm | Rejected |
| Native handoffs | Same explicit instruction; more requests and +7,212 tokens | Does not explain remaining +13,766 | Verified host-native contribution |
| More work/rereads | Work-call counts and hot-turn diagnostics differ | Ordinary tool-bearing output rises only 326 net; answers rise 13,440 | Contributor, insufficient alone |
| Changed projection or reasoning | Migration/native shaking changed histories | 20 fixed default Hide projections match; reported reasoning is zero | No demonstrated default-projection regression/hidden-reasoning increase |
| Longer visible responses | Exact reconciled response split | Length under old tool order is not observed | Verified output location; model/product causal share unresolved |

### 4. Hermes/Boreal: compression, pressure and a growing rolling checkpoint

**Verdict: verified host-native compression consumption, driven by different
cleanup/context trajectories and compactor verbosity; not title/memory work or
a verified Python/runtime regression.**

Every native call has the context-checkpoint instruction beginning
`You are a summarization agent creating a context checkpoint.` (first paragraph
SHA-256 `8d669c63fc012f6033e078feac7db367e37d86e1a939c58b01d259bef196f5a5` in
all 16 Boreal calls). There are **zero title-generation or memory-extraction
calls** in this bucket. Main host setup has `skip_memory=True` and
`skip_background_review=True`. All old/current native compression bodies omit
`max_tokens`; the main 4,096-output cap is **not** a compression cap. Both old
and current native responses exceed 4,096 tokens, so this is pre-existing.

| Version/rep | Turn | Request ID prefix | Native input | Native output | Preceding main prompt |
|---|---:|---|---:|---:|---:|
| historical 1 | 5 | `4f8c8b49a4ec` | 2,566 | 1,699 | 49,056 |
| historical 1 | 8 | `2a2921614c68` | 5,489 | 3,969 | 50,773 |
| historical 1 | 16 | `b83e408b4196` | 9,835 | 7,009 | 46,204 |
| historical 2 | 10 | `17f10dd5df88` | 3,376 | 2,307 | 53,106 |
| current 1 | 5 | `77fccf7c2caa` | 2,597 | 1,812 | 48,563 |
| current 1 | 9 | `6c5f6b6778d5` | 6,159 | 4,290 | 51,261 |
| current 1 | 13 | `3e6b8497c9c8` | 8,013 | 5,254 | 52,639 |
| current 1 | 16 | `15f08356218b` | 8,439 | 6,852 | 52,918 |
| current 1 | 19 | `eb376ff6b74c` | 10,054 | 8,538 | 54,536 |
| current 1 | 21 | `73d66c786d85` | 11,293 | 9,481 | 46,205 |
| current 2 | 8 | `8b5680ecfbbe` | 5,065 | 3,151 | 50,572 |
| current 2 | 11 | `94d8ca63d031` | 7,255 | 5,228 | 52,050 |
| current 2 | 13 | `05c591af3432` | 8,059 | 6,423 | 52,903 |
| current 2 | 16 | `0d440d8321f3` | 9,922 | 8,585 | 54,632 |
| current 2 | 18 | `b0c6043a54f3` | 12,031 | 10,286 | 46,594 |
| current 2 | 20 | `ea0f6eb87774` | 13,273 | 11,838 | 47,826 |

The preceding-main column is the last measured main-request usage, **not** the
trigger estimate: additional messages can arrive before the trigger. The native
input is smaller because Hermes prunes old tool bodies before asking for a
checkpoint. Logs expose these exact current trigger estimates:
rep 1 **52,884 preflight**, **53,194 pre-API**, **54,787 pre-API**;
rep 2 **52,258 preflight**, **53,146 pre-API**, **54,929 preflight**.
Old rep 2 explicitly logs **53,350 >= 52,224**. The remaining post-tool trigger
estimates were not captured; substituting native-summary prompt tokens for them
would be wrong. Old/current observer configs both record window 65,536 and
threshold_percent 0.75. The effective small-window trigger is **52,224** in both:
`ContextCompressor._compute_threshold_tokens` floors/caps the trigger at
85% of `(65,536−4,096)` for this setup.

The runtime chain is reachable: `turn_context_compaction._preflight_compression`
→ `_preflight_request_tokens` → anchored provider usage (or rough fallback)
→ `should_compress` → `_compress_context`/`ContextCompressor.compress`.
`turn_api_request` runs plugin `llm_request` projection when building the main
outgoing payload; `turn_usage` captures its returned provider usage as the next
anchor. Hiding can therefore **indirectly defer native compression** by reducing
measured prompt usage, even while original native history is retained. It does
not rewrite the compression auxiliary prompt through this main middleware path.

Old Boreal-2 hides at 16 boundaries and compresses once; current has one
qualifying boundary and compresses six times. Old Boreal-1 has four boundaries
and three compressions; current has none and six. **40/40 initial Boreal read
results** (20 files × two reps) match old/current byte-for-byte after normalizing
only workspace paths. A larger/newly truncated fixture is disproved.
The plugin does not autonomously choose less compression: the model chose less
cleanup; the native pressure gate then sees the resulting history/usage.
Per-trigger pre-projection sizes and the anchor-versus-fallback branch were not
logged exhaustively. Exact token changes under alternative cleanup at each
trigger remain unverified; reachable code and observed replacements are not a
complete historical counterfactual.

Repeated compaction requests explicitly contain `PREVIOUS SUMMARY:` and ask to
update that checkpoint with new turns, preserving exact technical details.
Current rep 2 native input grows **5,065→13,273 tokens**, output
**3,151→11,838** over six calls; old rep 2 has just **3,376→2,307** in its one
call. More triggers plus a larger rolling checkpoint and uncapped model verbosity
explain where the 14,984→81,738 output increase is spent. The model-only stochastic
share of checkpoint growth versus the different accumulated conversation cannot
be recovered by assuming equal underlying source files.

Runtime discrimination: current host commit is
`cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`; old recorded `run_agent.py` bytes
match current. Current `uv.lock`/dependency hashes and Python **3.14.9** are
recorded in campaign provenance. Historical **full dependency graph/interpreter
identity was not recorded**. Old prompt's `python3=3.12.15` is the shell toolchain
probe, not proof that the Hermes process used Python 3.12. Historical environment
ID `3be5d82…` differs from current isolated `5c9fd8…`; this is an unverified
runtime-equivalence link, not evidence that Python caused six extra compactions.
Equal observed trigger/summary instructions and opposite Atlas direction argue
against a uniform host-threshold/price/runtime failure. They do not prove all
unrecorded dependencies identical. A historical interpreter experiment cannot
honestly be recreated from an unrecorded version by guessing one.

No product fix is supported by this resource outlier alone. Host-side proposals
for a separate study: explicitly bound auxiliary summary output/checkpoint growth,
log every trigger estimate and pre-/post-projection size, pin interpreter plus
dependency graph and initial toolchain-probe text. Do not change the evaluated arm.

| Hypothesis | Evidence for | Evidence against / limit | Verdict |
|---|---|---|---|
| Title/memory jobs caused growth | Bucket initially called native maintenance | All 16 prompts are checkpoint compression; memory/background review skipped | Rejected |
| More product LLM summaries | Plugin can summarize | Product calls/output fall 8/1,123→5/659; native rises 4/14,984→12/81,738 | Rejected as consumption source |
| Larger fixtures/changed trigger | More pressure events occur | 40/40 Boreal sources match; observed trigger 52,224 in both | Rejected on measured sources/settings |
| Less cleanup and rolling checkpoints | Actual boundary counts fall; checkpoint input/output grow | Exact per-trigger alternative projection sizes unavailable | Verified trajectories/consumption; indirect magnitude unverified |
| Python/dependencies | Runtime IDs differ; current Python 3.14.9 | Old graph/interpreter unrecorded; no exception/threshold change ties it to this outlier | Unverified confound, not confirmed cause |

### 5. OMP component loop: reproducible old defects, not a new restore failure

**Verdict: model verification behavior amplified by a pre-existing misleading
filtered listing, shared prefix truncation, strict numeric validation and a
mixed-text fixture. A TS regression is not demonstrated.**

The complete tool sequence below is from
`current-omp-command-summarize-B-new-1-try1`; entries are ordered natively within
each user turn. Response excerpts are abbreviated, not substituted model inputs.

| # | Turn | Tool / arguments | Response seen (excerpt) |
|---:|---:|---|---|
| 1 | 1 | `read` audit-01.jsonl | # component service telemetry audit 1: distinct minute/region measurements {"minute":"2026-10-01T00:00:00Z","region":"us-east","service":"component-svc-0","requests":5400,"p50_ms":42,"p99_ms |
| 2 | 2 | `summarize_context` {"i": "Summarizing audit-01 read result", "tool_call_id": "call_a28c421f337d45aead29403d"} | {"ok":true,"error":null,"item_id":"item_8f033e396694456d","version":1} |
| 3 | 2 | `read` /nonexistent-placeholder | Path '/nonexistent-placeholder' not found |
| 4 | 2 | `list_context_items` {"i": "Checking summarized item", "query": "audit-01", "view": "items", "limit": 10} | {"ok":true,"items":[{"item_id":null,"call_id":"call_a28c421f337d45aead29403d","tool_call_id":"call_a28c421f337d45aead29403d","content_sha256":"6a38bb208da0aff2402e4bbdab1a6fe827e7d2103b7f88a |
| 5 | 2 | `summarize_context` {"i": "Summarizing original read result via session LLM", "tool_call_id": "call_a28c421f337d45aead29403d"} | {"ok":false,"error":"verification_failed","item_id":null,"version":null} |
| 6 | 2 | `bash` ls -la; wc -l audit-01.jsonl; grep -nE 'owner&#124;audit_seal&#124;budget' audit-01.jsonl | total 24 drwxr-xr-x 3 devin staff    96 Nov 10 15:36 . drwxr-xr-x 5 devin staff   160 Nov 10 15:36 .. -rw-r--r-- 1 devin staff 21698 Nov 10 15:36 audit-01.jsonl 105 audit-01.jsonl 20:owner=c |
| 7 | 2 | `list_context_items` {"i": "Rechecking item status after summarize", "limit": 10, "query": "call_a28c421f337d45aead29403d", "view": "candidates"} | {"ok":true,"total":0,"items":[]} |
| 8 | 2 | `bash` wc -c audit-01.jsonl | 21698 audit-01.jsonl  |
| 9 | 2 | `read` audit-01.jsonl:1-12 | # component service telemetry audit 1: distinct minute/region measurements {"minute":"2026-10-01T00:00:00Z","region":"us-east","service":"component-svc-0","requests":5400,"p50_ms":42,"p99_ms |
| 10 | 2 | `bash` awk '!/^#/ && !/^\{/' audit-01.jsonl; echo '--- count'; grep -c '^{' audit-01.jsonl; echo '--- last'; tail -n 3 audit-01.jsonl | owner=component-team-1 audit_seal=component-9e54cadbf4 latency_budget_ms=151 audited_regions=us-east,eu-west,ap-south; document=component-1 --- count 100 --- last {"minute":"2026-10-01T01:38 |
| 11 | 2 | `bash` awk -F'","' '/^\{/{print}' audit-01.jsonl &#124; sed -E 's/.*"region":"([^"]+)".*"service":"([^"]+)".*"worker_pool":"([^"]+)".*/\1 \2 \3/' &#124; sort -u &#124; awk '{r[$ | R ap-south R us-east R eu-west S component-svc-0 S component-svc-1 S component-svc-2 S component-svc-3 S component-svc-4 S component-svc-5 S component-svc-6 P pool-0 P pool-1 P pool-2 P pool |
| 12 | 2 | `bash` grep -E '"minute":"[^"]*","region":"(us-east&#124;eu-west&#124;ap-south)","service"' audit-01.jsonl &#124; awk -F'"' '{print $4, $8}' &#124; awk 'NF!=2{print "BAD:", $0}' | 100  |
| 13 | 2 | `bash` jq -r 'select(type=="object") &#124; .minute' audit-01.jsonl 2>/dev/null &#124; sort -u &#124; sed -n '1p;$p'; jq -r 'select(type=="object") &#124; [.requests,.p50_ms,.p9 | 2026-10-01T00:00:00Z 2026-10-01T00:17:00Z 0  |
| 14 | 2 | `bash` jq -r 'select(type=="object") &#124; .minute' audit-01.jsonl &#124; sort &#124; uniq -c &#124; awk '$1>1' &#124; wc -l; jq -r 'select(type=="object") &#124; .minute' audi | Error: failed to parse: byte offset 3945: value expected 0 Error: failed to parse: byte offset 3945: value expected 18 95:{"m 96:{"m 97:{"m 98:{"m 99:{"m 100:{" 101:{" 102:{" 103:{" 104:{"  |
| 15 | 2 | `bash` sed -n '75,78p' audit-01.jsonl &#124; cut -c1-90 | {"minute":"2026-10-01T01:11:00Z","region":"ap-south","service":"component-svc-1","requests latency_budget_ms=151 {"minute":"2026-10-01T01:12:00Z","region":"us-east","service":"component-svc- |
| 16 | 2 | `bash` sed -n '76p' audit-01.jsonl &#124; cat -A &#124; cut -c1-200; echo '---'; sed -n '75p;77p' audit-01.jsonl &#124; od -c &#124; sed -n '1,4p' | latency_budget_ms=151$ --- 0000000   {   "   m   i   n   u   t   e   "   :   "   2   0   2   6   - 0000020   1   0   -   0   1   T   0   1   :   1   1   :   0   0   Z   " 0000040   ,   "   r |
| 17 | 2 | `bash` awk -F'"' '/^\{/{print $4, $10}' audit-01.jsonl &#124; sort &#124; uniq -c &#124; awk '$1>1' &#124; head; echo '--- distinct minutes'; awk -F'"' '/^\{/{print $4}' audit-0 | --- distinct minutes 100  |
| 18 | 2 | `bash` awk -F'"' '/^\{/{print $4}' audit-01.jsonl &#124; sort &#124; sed -n '1p;$p' | 2026-10-01T00:00:00Z 2026-10-01T01:39:00Z  |
| 19 | 2 | `bash` awk -F'"' '/^\{/{print $10}' audit-01.jsonl &#124; sort &#124; uniq -c; echo '--- regions'; awk -F'"' '/^\{/{print $8}' audit-01.jsonl &#124; sort &#124; uniq -c; echo '- |     100 service --- regions      33 ap-south      33 eu-west      34 us-east --- pools     100 cpu_pct  |
| 20 | 2 | `bash` grep -o '"service":"[^"]*"' audit-01.jsonl &#124; sort &#124; uniq -c; echo '--- pools'; grep -o '"worker_pool":"[^"]*"' audit-01.jsonl &#124; sort &#124; uniq -c |      15 "service":"component-svc-0"      15 "service":"component-svc-1"      14 "service":"component-svc-2"      14 "service":"component-svc-3"      14 "service":"component-svc-4"      14 "s |
| 21 | 2 | `bash` jq -r 'select(type=="object") &#124; "\(.minute) \(.service)"' audit-01.jsonl &#124; head -6 | 2026-10-01T00:00:00Z component-svc-0 2026-10-01T00:01:00Z component-svc-1 2026-10-01T00:02:00Z component-svc-2 2026-10-01T00:03:00Z component-svc-3 2026-10-01T00:04:00Z component-svc-4 2026- |
| 22 | 2 | `read` audit-01.jsonl:18-21 | {"minute":"2026-10-01T00:15:00Z","region":"us-east","service":"component-svc-1","requests":4857,"p50_ms":46,"p99_ms":127,"cpu_pct":52,"queue_depth":17,"cache_hit_pct":79,"worker_pool":"pool- |
| 23 | 2 | `bash` awk 'BEGIN{n=0} /^\{"/{n++; svc=$0; sub(/.*"service":"/,"",svc); sub(/".*/,"",svc); if (svc !~ /^component-svc-[0-6]$/) print "BAD line " NR": "substr($0,1,60); mn=$0; su | 100 records  |
| 24 | 2 | `bash` grep -n '01:39' audit-01.jsonl &#124; cut -c1-4; grep -c 'T00:' audit-01.jsonl; grep -c 'T01:' audit-01.jsonl | 104: 60 40  |
| 25 | 2 | `bash` awk -F'"' '/^\{/{print $4}' audit-01.jsonl &#124; sort -u &#124; awk -F'[T:]' '{print $1" "$2" "$3}' &#124; sed -n '1p;$p'; echo '--- p99/budget check'; grep -o '"p99_ms" | 2026-10-01 00 00 2026-10-01 01 39 --- p99/budget check p99>151 count: 53  |
| 26 | 2 | `list_context_items` {"i": "Final item state check", "limit": 10, "query": "audit-01.jsonl", "view": "items"} | {"ok":true,"items":[{"item_id":null,"call_id":"call_a28c421f337d45aead29403d","tool_call_id":"call_a28c421f337d45aead29403d","content_sha256":"6a38bb208da0aff2402e4bbdab1a6fe827e7d2103b7f88a |
| 27 | 3 | `unhide_context` {"i": "Restoring original read result", "item_id": "item_8f033e396694456d"} | {"ok":true,"error":null,"item_id":"item_8f033e396694456d","version":2} |
| 28 | 3 | `list_context_items` {"i": "Confirming restore state", "limit": 3, "query": "call_a28c421f337d45aead29403d", "view": "items"} | {"ok":true,"items":[{"item_id":null,"call_id":"call_a28c421f337d45aead29403d","tool_call_id":"call_a28c421f337d45aead29403d","content_sha256":"6a38bb208da0aff2402e4bbdab1a6fe827e7d2103b7f88a |

Crucial disproof of a sole-listing explanation: the model calls
`read('/nonexistent-placeholder')` **before** its first filtered listing. Its
verification behavior has already started; the listing cannot be its initial
cause. The false `unhidden/unrecorded` row then misleads verification. The second
summary response contains the comma-formatted numbers above and correctly hits
the same old/current strict validator. Subsequent `jq` probes stop at the inline
`owner=` metadata (`byte offset 3945: value expected`), initially report only
18 rows, then `awk`/`grep` establish all 100 rows ending 01:39. The fixture is
not pure JSONL despite its extension. These errors and the input-prefix claim
of an ending near 00:55 support a verification interpretation of the diagnostics, not a work-tool rerun
performed by Unhide. All Bash/read diagnostics are in user turn 2; restore and metadata-only
confirmation are in turn 3.
The model's initial motivation was not separately logged.

Deterministic replay through current `OmpService` reproduces: accepted summary;
unfiltered list correctly hidden with item ID; `query='audit-01'` incorrectly
returns that same tool call as `unhidden`, `source='unrecorded'`, `item_id=null`;
the captured retry summary returns `verification_failed`. The old engine filters
by compacted text/item ID just like current `Engine.listItems`. Old daemon source
(`src/session_navigation_omp/daemon.py`, read only, not executed) computes `recorded_calls` **after** that
filter, then appends snapshot records. Current `OmpService.listItems` does the
same. The summary has no `audit-01` filename. Identical filter/set/append logic
therefore explains the old counterfactual too, rather than attributing a merely
possible branch to the run. Actual old trial 2 also returns `verification_failed`
for the same numeric formatting and then `not_found` when the model uses a call
ID as an item ID; there was no accepted summary to restore.

Filtered-row fields and error **codes** are unchanged. Transport JSON envelopes
are not byte-identical: old errors can include RPC `id` (e.g. `id:9`); current
mutation errors include `item_id:null,version:null` instead. This is a visible
transport/migration difference, not a new meaning of `verification_failed`.
No claim is made that every stochastic Bash diagnostic reproduces: the misleading
listing and validation failure reproduce exactly under fixed captured inputs.

| Hypothesis | Evidence for | Evidence against / limit | Verdict |
|---|---|---|---|
| New TS state corruption | Filtered row says unrecorded/unhidden | Unfiltered state correct; old filter/set/append branch identical | Pre-existing listing defect, not state corruption |
| Listing alone initiated loop | False row is misleading | Placeholder read occurs first | Rejected as sole initiator; possible amplifier |
| New validator rejected valid old-style result | Current retry fails | Old trial 2 and both fixed validators reject numeric commas; normalization alone succeeds | Shared strictness plus model wording |
| Restore reran work tool | Many diagnostics occur | All occur in turn 2; turn 3 restores saved bytes with no work-tool execution | Rejected |
| Verification of truncated/mixed-format result | Summary covers prefix; source mixes JSON rows/metadata | Initial model motivation not separately observed | Recorded behavior, not a unique initiating thought |

Fix proposals only:
1. Determine the recorded-call set before applying a display query, apply query
   semantics consistently to real and snapshot rows, and never label an existing
   hidden target as unrecorded. Cover filename/no-match/empty-query cases in both
   implementations, including hidden results after summaries.
2. Return bounded, truthful verification diagnostics (e.g. unsupported numeric
   formatting or excerpt budget) and decide numeric equivalence explicitly.
3. Address source-prefix sampling as in §1. Do not rerun original tools during
   restoration or count a model's pre-restore diagnostics as Unhide execution.

### Follow-up verdicts and verification

| Item | Evidence-backed classification | Remaining causal limit |
|---|---|---|
| Missing summary facts | Shared product input truncation; pooled denominator/model-wording variation | No current-vs-old input regression on any of the five calls |
| Boundary coverage | Intended keep-lines behavior + incidental tool order/host-prompt differences + model choices | No unique allocation to ordering versus variance; reminder logic parity demonstrated |
| OMP +37% output | Host-native handoffs + longer visible responses; exact token reconciliation | Downstream stochastic choices cannot be uniquely assigned to changed product surface |
| Hermes/Boreal | Native compression pressure/count and rolling checkpoint verbosity | Full old interpreter/dependencies unavailable; no evidence establishing Python causation |
| Component loop | Pre-existing listing/validation/truncation limitations plus model diagnostics | Deterministic defects reproduced; whole stochastic trajectory not claimed reproducible |

Local verification output (no network):

```text
PASS historical input provenance: 12 wire/stage git blobs match d3e77e6^ byte-for-byte
PASS Hermes reminder module byte-identical to 37348b8
PASS OMP reminder replay: 287 actual emitted notes byte-identical old/current and to captured bytes; 64 timing/tier/empty cases identical
PASS deterministic default Hide projection: 20 captured targets produce byte-identical replacement text in 37348b8 Python and 8902a41 TS (item IDs normalized)
PASS fixed historical three-target keep_lines replay: current applies 3/3, with per-target ignored diagnostics
PASS 37348b8 fixed three-target keep_lines replay: 3/3 invalid_keep_lines; matches historical wire
PASS current broad minute-substring replay: 3/3 verification_failed reproduced
PASS 37348b8 broad minute-substring replay: same 3/3 verification_failed, not a TS regression
PASS current in-process service replay: first summary accepted; unfiltered hidden; filtered false-unrecorded reproduced; retry verification_failed
PASS current validator: accepted/empty/rejected/numeric-format-normalized cases
PASS 37348b8 Python validator replay: first accepted; comma-formatted retry rejected; comma normalization alone accepted
```

Reproduction scripts are under the evidence directory: `analyze_rca.py`,
`more.py`, `details.py`, `replay.ts`, `reminder-replay.ts`, `keep-replay.ts`,
`default-replay.ts`, `verification-replay.ts`. Old Python checks use
`PYTHONPATH=rca/old/src` and file-backed SQLite databases (the archival store
intentionally rejects `:memory:` because it requires verified WAL).
The initial in-memory archival replay failed that WAL gate; the file-backed
check above is the corrected, passing experiment, not a product failure.

No product regression was established by these checks; existing shortcomings and
the incidental tool-order parity gap are not hidden by that statement. No product,
host, fixture, harness or test file was edited, and no new model call was made.
The requested unique historical counterfactual for every model-choice difference
is not obtainable from these records; that limitation is explicit rather than
turning plausible causes into confirmed findings.

## Fixed-product live revalidation (`df47548`)

### Provenance, scope and verdict

- Product **`df475484de0123746d2357c5e3893773c68fd982`**; collection/comparison
  harness **`7504c7d538757d6367df88bff0d6c4a36c2c6858`**. No product changes were
  made during this campaign. The controller and current-only assembler now accept
  an explicit product commit, defaulting to the frozen pre-fix `8902a41`; their
  product guards remain enforced. Archival `v4_assemble.py` is unchanged.
- Exactly **8 fixed long sessions** (OMP/Hermes × Atlas/Boreal × two repetitions),
  **8 fixed commanded trials**, and **8 distinct replacement judges**. No A,
  `37348b8` or pre-fix `8902a41` cells or judges were rerun. Their original selected
  results and precomputed comparison are read-only inputs.
- The same DeepSeek V4.1 Flash 1017 model, **Relace only**, no fallback, reasoning
  off, 65,536-token window, fixtures, turns and host limits were used. All seven
  recorded host source/package fingerprints match pre-fix: OMP **18.18.3**,
  Hermes `cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`, and the same isolated
  **Python 3.14.9** interpreter/dependency directory. The approved prompt-parity
  fix intentionally restores the terminal Python/PATH probe line; it does not
  replace the Hermes engine interpreter. Full historical transitive-runtime
  identity remains subject to the earlier report's limitation.
- Evidence: `/Users/devin/nav-phase0-gates/step8-eval/fixed/paid/`; separate
  assembled comparison, judges, audits and ledger under `step8-eval/fixed/`.
  The two-host summary stub completed offline before any paid call.
- **All long-task final-only/visible-unit correctness, canonical checks, announced
  recall and surprise recovery remain 4/4 per host. Stored-original mismatches
  remain zero.** There were no incomplete cells or API exclusions.
- **Not an unqualified acceptance pass:** whole-source input and live late-fact
  inclusion are demonstrated, but commanded OMP **pure LLM replacement coverage
  regressed from 2/2 to 0/2 trials**. Both models hid early with rules; validation
  and idempotent reuse then prevented conversion to an LLM replacement. The
  apparent OMP 6/6 retained facts belong to rule replacements, not successful
  LLM Summarize. Resource totals are close to pre-fix, with significant per-fixture
  redistribution; n=4 per host does not establish statistical equivalence.

### Key long-session totals

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre |
|---|---:|---:|---:|---:|---:|---:|
| Requests | 586 | 537 | 548 | 550 | 1.0242 | 1.0036 |
| Prompt tokens | 23,211,328 | 19,019,480 | 19,659,349 | 18,862,991 | 0.9918 | 0.9595 |
| Cached tokens | 20,004,352 | 15,760,640 | 15,820,544 | 15,150,592 | 0.9613 | 0.9577 |
| Output tokens | 287,668 | 198,169 | 251,896 | 253,815 | 1.2808 | 1.0076 |
| Reported USD | 0.263097616 | 0.197440740 | 0.228083550 | 0.224934854 | 1.1393 | 0.9862 |

All detailed long, component and per-fixture metrics follow below, including
correctness, adoption, literal IDs, cleanup boundaries, rereads, Unhide,
replacements, cache transitions and safety. Component A is N/A. Counters describe
what happened, not a universal success/failure gate. In particular, retained-fact
fractions must be read together with replacement-source/pure-trial coverage.

### Live late-fact evidence and commanded Summarize limitation

Every fixed component summary request on both paths exercised the previously
truncated case, so **no additional targeted live call was needed**:

| Path | Requests/responses with late fact | Complete source bytes | Fact offset | Accepted pure LLM trials |
|---|---:|---:|---:|---:|
| OMP | 4/4 | 21,697 | 15,601 | **0/2** |
| Hermes | 2/2 | 25,247 (host-wrapped) | 18,068 | **2/2** |

All six raw model responses contain `latency_budget_ms=151`. OMP source SHA-256
`6a38bb208da0aff2402e4bbdab1a6fe827e7d2103b7f88a32b12a4e31fd29867`
matches the captured source. Hermes's source includes its normal file-result
wrapper, with the same fact beyond the old cutoff. Accepted Hermes summaries
retain **6/6** key facts, unchanged from old/pre-fix. Rule Hide retains **12/12**
facts across both hosts. OMP's commanded-summary replacements also retain 6/6,
but **both are rule-source replacements** and are counted as wrong-source outcomes.

The OMP trial mechanism is directly observed, not inferred solely from code:

1. Both trials call `manage_context(action=hide, keep_lines=...)` at **turn 1**,
   before the turn-2 Summarize instruction. Stored items therefore already have
   `compaction_source=rule`.
2. Trial 1 requests `b05ee74316f840d39b7f080095c86a0d` and
   `88d387a93f71449fb61150099e192003` are rejected for unsupported literal numeric
   claims **`100`** and **`15%`**, respectively. Counting records or interpreting a
   `_pct` field as a percent is not licensed by the existing exact-token validator.
   This is not a grouping-comma failure or missing-tail failure. The model briefly
   restores, retries, and emits diagnostic echo/write work, without rereading the
   original audit tool.
3. Trial 2's `57f0644cf86d4ed5bb08f29fd4ed2bee` passes both Python and TS summary
   validators, and `summarize_context` returns `ok=true`; the immediately following
   listing still shows **source=rule**. `Engine.apply` finds the existing item and
   takes `rehideExisting`, preserving its original rule compaction. The retry
   `2a9a208208a0495db2dbd3e10c38ff2c` is rejected for **`100`**.
4. Deterministic replay of that valid response yields **source=llm on a fresh
   item**, but **source=rule after an early Hide**, both with `ok=true`. Thus numeric
   rejection alone cannot explain the coverage loss. The existing-item branch is
   unchanged from `8902a41`; replaying all four responses through that commit's
   validator produces the same reject/reject/accept/reject results.

**Verdict:** observed commanded source-coverage regression, caused mechanically by
early model Hide plus pre-existing strict validation and existing-item reuse.
The input fix is working, but that does not make the end-to-end OMP Summarize
acceptance gate pass. The separate effects of changed order/full input versus
stochastic choices are not uniquely identified. A follow-up should decide explicit
Hide-to-Summarize conversion/error semantics and how to instruct the summarizer
about derived counts/units, without silently loosening factual checks. No such
product redesign or outcome-selected rerun was made here.

The filtered read item was not re-emitted as an unrecorded ghost. Trial 2 does
show an **actual separate bash result** (`call_33c8018f7a5641518465f201`) in the
unrecorded listing: the snapshot merge still does not apply the display query to
genuinely unrecorded rows. This is residual listing noise, distinct from the fixed
known-record set-construction bug; the read row remains separately recorded/hidden.

### Autonomous errors, adoption and restoration

- **`input_too_large`: 0; `keep_lines_too_broad`: 0** in observed autonomous
  operations. Neither refusal demonstrably hurt adoption here. These runs do not
  replace the boundary/error unit and conformance tests that actually trigger them.
- Successful two-boundary session coverage improves **4/8 → 5/8** versus pre-fix,
  still below historical B-old **6/8**. OMP improves **3/4 → 4/4**; Hermes remains
  **1/4 → 1/4**. Cleanup boundaries move OMP **17→20**, Hermes **8→13**. Hermes
  Atlas falls **7→1** boundaries while Boreal rises **1→12**: task correctness is
  unchanged, but adoption is uneven and not an unqualified improvement.
- OMP Boreal repetition 2 reaches five explicit-Summarize batches with one
  `verification_failed` item in each (unsupported `100` in the captured model
  summary); valid sibling summaries are applied. The run still achieves five
  cleanup boundaries. Boreal repetition 1 twice supplies keep-lines with auto,
  receiving the unchanged `invalid_keep_lines_action`; three stale/not-found
  targets occur across OMP long sessions. These are distinct from the new budget
  and broad-retention errors. No tool text/error policy was altered to improve
  the observed results.
- **9/9 successful restore operations** (including one early diagnostic restore)
  match stored/native original bytes under their **original tool-call IDs** in
  final outgoing requests. All **8 requested turn-3 restore turns** have **zero
  work-tool calls**. The extra turn-2 restore shares a turn with diagnostic echo
  and write calls; they are not re-executions of the original read. Stored-original
  mismatches remain **0** in both long and component runs.

### Brief RCA of new >25% deviations versus pre-fix

| Surface | Observed change and reachable mechanism | Verdict / limit |
|---|---|---|
| OMP commanded source coverage | Pure LLM trials **2→0** and replacements **2→0**; apparent retained-fact count **4→6** is rule-source retention. Raw responses and deterministic cache/validator replays above isolate both failure mechanisms. | Coverage regression; pre-existing semantics newly exercised by early Hide. Full-input success must not mask it. |
| Hermes Atlas resources | Prompt **3,987,334→5,001,893** (1.254×), cached **3,097,856→3,901,696** (1.259×), output **74,584→108,835** (1.459×), cost **$0.058118148→$0.080527162** (1.386×). Native compression **11→14** calls, output **60,168→91,821**; its +31,653 tokens explain most of the +34,251 total. Native compression cost increases $0.016045572 of the total $0.022409014 increase. | Host-native compression is the verified output/cost mechanism, not product-summary overhead (231 output tokens). Atlas adoption falls, but a unique causal attribution of that choice change to prompt parity versus model variance is unverified. |
| Hermes Boreal output | **99,251→72,310** (0.729×); compression **12→9**, output **81,738→54,845** (−26,893), explaining nearly all −26,941 total. Boundaries **1→12**, navigation **2→19**, no product summaries versus five pre-fix. | Native work and changed model cleanup choices redistribute pressure; no isolated causal claim that the fix alone produced savings. |
| OMP native trigger count | **89→151** overall, Atlas **31→87**. The metric counts start events, including skipped attempts: skipped ends **79→146**. Actual captured handoff LLM requests **14→8**, handoff output **22,836→15,666**. | Host trigger/skip accounting, **not** 62 extra native LLM calls. Overall OMP output falls **78,061→72,670**, despite **21** product-summary calls (3,528 output tokens) versus none pre-fix. |
| Adoption/selection and reread counters | OMP valid/selected IDs, unique disposable selection, Atlas keep-lines/cleanup/store counts increase with its extra boundaries; explicit Hide drops on Boreal as the model chooses Summarize. OMP list calls **3→0**, repeat-visible rereads **23→10**, later hidden rereads **3→1**, new bash calls **15→36** (Boreal **7→28**) as inspection shifts from read to bash. Hermes selection/list/explicit-hide counters move with the Atlas/Boreal boundary redistribution above. | Verified changed tool-choice mix, not a standalone efficiency/safety gate. Commands remain in raw wires. The fix/order/environment and stochastic effects on those choices remain confounded. |
| Cache transitions, sensitivity/reference pricing, and comparison counts | Transition counts follow successful cleanup (e.g. Atlas OMP **6→10**, Hermes **7→1**, Boreal Hermes **2→12**). Signed uncached-growth/cost deltas and their hypothetical reference/native sensitivity values change with those selected boundaries and different histories. Native-original comparison counts vary with rereads/history and component diagnostics; fewer comparisons do not establish corruption or missing restore proof. | Descriptive derived metrics, not extra billed spend or independent regressions. All originals actually checked agree; exact restore proofs are separate. Near-zero/signed-denominator ratios should not be interpreted as percentage savings. |

All scalar metrics and both requested ratios are retained below, including the
large positive/negative transition ratios; the explanations above cover their
underlying event/selection families rather than treating each derived price or
counter as a separate causal experiment. Fixed combined output is still **1.281×
B-old**, but only **1.008× pre-fix**. Hermes aggregate output is **1.042× pre-fix**;
the Atlas increase is largely offset by Boreal. No statistical-equivalence claim.

### Spend, guard audit and checks

| New fixed-run category | Reported USD |
|---|---:|
| Eight long sessions | 0.224934854 |
| Eight component trials | 0.011324742 |
| Eight distinct judges | 0.001109398 |
| **Total** | **0.237368994** |

The fresh ledger limit was **$5**; **$3 was not crossed**. No unresolved reserve,
missing billed usage, upstream failure or upstream retry occurred. All **649**
upstream attempts/responses reconcile to **649** settled ledger charges. Eight
optional local Hermes `/api/show` capability probes were blocked before upstream
dispatch, as in pre-fix; they are not generation failures. Three fully billed OMP
responses arrived after client-close (pre-fix had four); those costs/tokens remain
included under the unchanged protocol. No qualifying outcome was rerun.

```text
Ran 57 tests in 39.933s
OK
PASS exactly 8 long + 8 component fixed-product cells; all complete/canonical tests pass; no exclusions
PASS 649 upstream attempts/responses/ledger charges reconciled; Relace/no fallback/reasoning off pinned; no upstream retries/failures
PASS total paid spend $0.237368994; no unresolved reservation; $3 not crossed
PASS 9/9 successful restores match stored/native originals under original tool-call IDs in final outgoing requests; all 8 commanded restore turns have zero work calls
PASS autonomous observed input_too_large=0 and keep_lines_too_broad=0 (not evidence of refusal behavior when triggered)
PASS omp 4/4 live component summary responses retain the late latency fact; input <=32768 bytes
PASS hermes 2/2 live component summary responses retain the late latency fact; input <=32768 bytes
PASS 8/8 distinct replacement judges returned valid scores
PASS all new campaign/reporting artifacts contain no provisioned API-key value
```

Offline suite includes fixed-version guard and four-column normal/empty/error
reporting coverage. No product/build inputs changed since the prior implementation
checks, so those unchanged suites were not rerun. Raw validation traces, cache
counterfactuals, native event accounting and restore proofs remain outside git in
`step8-eval/fixed/`. Markdown/UI was not visually rendered.

## Fixed-product four-version metrics

Historical and pre-fix cells are reused, not rerun. Ratios are descriptive with two repetitions per fixture, not equivalence estimates. N/A denotes unavailable metrics or zero denominators. Component A is N/A because the plugin was off. Retention verdicts compare fractions, not raw retained-fact counts.

### Long sessions

#### OMP

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 4 | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 4 | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 31 | 24 | 25 | 0.806452 | 1.041667 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `sessions_using_navigation` | 0 | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `list_calls` | 0 | 1 | 3 | 0 | 0 | 0 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 73 | 52 | 63 | 0.863014 | 1.211538 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `literal_ids_selected` | 0 | 75 | 52 | 66 | 0.88 | 1.269231 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 19 | 17 | 20 | 1.052632 | 1.176471 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `sessions_with_2_boundaries` | 0 | 4 | 3 | 4 | 1 | 1.333333 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `native_compactions` | 40 | 126 | 89 | 151 | 1.198413 | 1.696629 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `requests` | 244 | 251 | 272 | 273 | 1.087649 | 1.003676 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 11,314,570 | 10,212,293 | 11,160,702 | 10,029,112 | 0.982063 | 0.898609 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | 10,010,624 | 8,695,552 | 9,194,240 | 8,308,992 | 0.955545 | 0.903717 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | 58,906 | 57,083 | 78,061 | 72,670 | 1.273059 | 0.930939 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `peak_prompt` | 78,572 | 77,381 | 78,166 | 73,778 | 0.953438 | 0.943863 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.08733 | 0.08112 | 0.0968 | 0.088201 | 1.08729 | 0.91116 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 0 | 0 | 21 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `reference_cost` | 8.084452 | 7.837922 | 9.154532 | 8.176096 | 1.043146 | 0.89312 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reference_no_cache` | 23.100388 | 20.88125 | 22.945892 | 20.639584 | 0.988427 | 0.899489 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 68 | 69 | 69 | 68 | 0.985507 | 0.985507 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 44 | 36 | 52 | 1.181818 | 1.444444 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `eligible_selected` | 0 | 73 | 52 | 63 | 0.863014 | 1.211538 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `selected_eligible_disposable` | 0 | 62 | 43 | 57 | 0.919355 | 1.325581 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 71 | 49 | 36 | 0.507042 | 0.734694 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 61 | 40 | 33 | 0.540984 | 0.825 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `keep_lines_calls` | 0 | 28 | 15 | 17 | 0.607143 | 1.133333 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `successful_unhide` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_after_compaction` | 0 | 1 | 3 | 1 | 1 | 0.333333 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_repeat_visible` | 12 | 3 | 23 | 10 | 3.333333 | 0.434783 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `rereads_same_turn` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_later_turn` | 0 | 1 | 3 | 1 | 1 | 0.333333 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_unhide_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_read_after_compaction` | 0 | 0 | 2 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_read_repeat_visible` | 6 | 3 | 7 | 3 | 1 | 0.428571 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_read_new` | 88 | 68 | 88 | 69 | 1.014706 | 0.784091 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_bash_after_compaction` | 0 | 1 | 1 | 1 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_bash_repeat_visible` | 6 | 0 | 16 | 7 | N/A | 0.4375 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_bash_new` | 18 | 36 | 15 | 36 | 1 | 2.4 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `cache_transitions` | 0 | 19 | 18 | 21 | 1.105263 | 1.166667 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `transition_uncached_growth` | 0 | -43,681 | 12,832 | -82,411 | 1.886656 | -6.422304 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.002162 | 0.000055 | -0.002945 | 1.362629 | -53.775396 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.000055 | 0.00008 | 0.000051 | 0.93003 | 0.640117 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.082686 | 0.120135 | 0.076901 | 0.93003 | 0.640117 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 46 | 43 | 52 | 1.130435 | 1.209302 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `stored_items` | 0 | 46 | 43 | 52 | 1.130435 | 1.209302 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 122 | 112 | 133 | 120 | 1.071429 | 0.902256 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_tool_content_transitions` | 83 | 63 | 81 | 49 | 0.777778 | 0.604938 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |

#### HERMES

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 4 | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 4 | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 4 | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 28 | 18 | 21 | 0.75 | 1.166667 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `sessions_using_navigation` | 0 | 3 | 2 | 3 | 1 | 1.5 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `list_calls` | 0 | 3 | 2 | 3 | 1 | 1.5 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 28 | 17 | 18 | 0.642857 | 1.058824 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `literal_ids_selected` | 0 | 28 | 17 | 18 | 0.642857 | 1.058824 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `cleanup_boundaries` | 0 | 20 | 8 | 13 | 0.65 | 1.625 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `sessions_with_2_boundaries` | 0 | 2 | 1 | 1 | 0.5 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `native_compactions` | 28 | 18 | 23 | 23 | 1.277778 | 1 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `requests` | 342 | 286 | 276 | 277 | 0.968531 | 1.003623 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 11,896,758 | 8,807,187 | 8,498,647 | 8,833,879 | 1.003031 | 1.039445 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | 9,993,728 | 7,065,088 | 6,626,304 | 6,841,600 | 0.968367 | 1.032491 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | 228,762 | 141,086 | 173,835 | 181,145 | 1.283933 | 1.042051 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `peak_prompt` | 54,992 | 54,549 | 54,632 | 54,841 | 1.005353 | 1.003826 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.175768 | 0.116321 | 0.131283 | 0.136734 | 1.17549 | 1.041522 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 8 | 5 | 2 | 0.25 | 0.4 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `reference_cost` | 10.63302 | 8.14543 | 8.448518 | 8.854518 | 1.087053 | 1.048056 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reference_no_cache` | 25.623612 | 18.743062 | 18.387974 | 19.116918 | 1.019946 | 1.039642 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 1 | 1 | N/A | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 69 | 68 | 70 | 68 | 1 | 0.971429 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 24 | 16 | 15 | 0.625 | 0.9375 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `eligible_selected` | 0 | 28 | 17 | 18 | 0.642857 | 1.058824 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `selected_eligible_disposable` | 0 | 24 | 16 | 15 | 0.625 | 0.9375 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `explicit_hide_eligible` | 0 | 20 | 12 | 16 | 0.8 | 1.333333 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 17 | 11 | 14 | 0.823529 | 1.272727 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `successful_unhide` | 0 | 2 | 0 | 0 | 0 | N/A | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_same_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_later_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_unhide_calls` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `cache_transitions` | 0 | 20 | 9 | 13 | 0.65 | 1.444444 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_uncached_growth` | 0 | -167,288 | -81,522 | -131,428 | 0.785639 | 1.612178 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.002585 | -0.000412 | -0.001201 | 0.464792 | 2.913069 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.00001 | 0.000005 | 0.000003 | 0.3461 | 0.669526 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.014883 | 0.007694 | 0.005151 | 0.3461 | 0.669526 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 28 | 85 | 83 | 2.964286 | 0.976471 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `stored_items` | 0 | 28 | 102 | 101 | 3.607143 | 0.990196 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 239 | 140 | 143 | 141 | 1.007143 | 0.986014 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_tool_content_transitions` | 12 | 29 | 24 | 23 | 0.793103 | 0.958333 | old: Descriptive / coverage; pre: Descriptive / coverage |

### Commanded components

#### OMP

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `trials` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `strict_success` | N/A | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `successful_unhide` | N/A | 3 | 4 | 5 | 1.666667 | 1.25 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `restores_without_work_rerun` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `restored_original_in_final_request` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `third_turn_work_calls` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_pure_replacement_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_sent_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_pure_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_facts_present` | N/A | 6 | 6 | 6 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_facts_retained` | N/A | 6 | 6 | 6 | 1 | 1 | old: PASS: retained fraction; pre: PASS: retained fraction |
| `hide_wrong_source` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `summarize_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_pure_replacement_trials` | N/A | 1 | 2 | 0 | 0 | 0 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `summarize_sent_replacements` | N/A | 1 | 2 | 2 | 2 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `summarize_pure_replacements` | N/A | 1 | 2 | 0 | 0 | 0 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `summarize_facts_present` | N/A | 3 | 6 | 6 | 2 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `summarize_facts_retained` | N/A | 2 | 4 | 6 | 3 | 1.5 | old: PASS: retained fraction; pre: PASS: retained fraction |
| `summarize_wrong_source` | N/A | 0 | 0 | 2 | N/A | N/A | old: REVIEW; pre: REVIEW |
| `sent_replacements` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `wrong_source` | N/A | 0 | 0 | 2 | N/A | N/A | old: REVIEW; pre: REVIEW |
| `originals_compared` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `stored_items` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `original_mismatches` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | N/A | 8 | 24 | 10 | 1.25 | 0.416667 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `requests` | N/A | 31 | 54 | 42 | 1.354839 | 0.777778 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | N/A | 305,499 | 556,936 | 490,998 | 1.6072 | 0.881606 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | N/A | 238,336 | 458,240 | 349,440 | 1.466165 | 0.76257 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `output_tokens` | N/A | 4,426 | 8,560 | 6,887 | 1.556033 | 0.804556 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `reported_usd` | N/A | 0.003808 | 0.007163 | 0.00604 | 1.58629 | 0.843185 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `judge_distinct_eligible` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `judge_scored` | N/A | 3 | 4 | 4 | 1.333333 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `judge_mean` | N/A | 2 | 2.25 | 1.75 | 0.875 | 0.777778 | old: Descriptive / coverage; pre: Descriptive / coverage |

#### HERMES

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `trials` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `strict_success` | N/A | 4 | 4 | 4 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `successful_unhide` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `restores_without_work_rerun` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `restored_original_in_final_request` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `third_turn_work_calls` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_pure_replacement_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_sent_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_pure_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_facts_present` | N/A | 6 | 6 | 6 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `hide_facts_retained` | N/A | 6 | 6 | 6 | 1 | 1 | old: PASS: retained fraction; pre: PASS: retained fraction |
| `hide_wrong_source` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `summarize_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_pure_replacement_trials` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_sent_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_pure_replacements` | N/A | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_facts_present` | N/A | 6 | 6 | 6 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summarize_facts_retained` | N/A | 6 | 6 | 6 | 1 | 1 | old: PASS: retained fraction; pre: PASS: retained fraction |
| `summarize_wrong_source` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `sent_replacements` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `wrong_source` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `originals_compared` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `stored_items` | N/A | 4 | 8 | 8 | 2 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `original_mismatches` | N/A | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | N/A | 7 | 10 | 7 | 1 | 0.7 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | N/A | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `requests` | N/A | 56 | 50 | 49 | 0.875 | 0.98 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | N/A | 674,177 | 607,695 | 565,217 | 0.838381 | 0.9301 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | N/A | 540,672 | 494,592 | 452,608 | 0.837121 | 0.915114 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | N/A | 4,743 | 5,293 | 4,692 | 0.989247 | 0.886454 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | N/A | 0.005876 | 0.005798 | 0.005285 | 0.899386 | 0.911456 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `judge_distinct_eligible` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `judge_scored` | N/A | 4 | 4 | 4 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `judge_mean` | N/A | 3 | 3.25 | 3 | 1 | 0.923077 | old: Descriptive / coverage; pre: Descriptive / coverage |

### Per-fixture metrics

#### OMP/atlas

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 19 | 9 | 11 | 0.578947 | 1.222222 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `sessions_using_navigation` | 0 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `list_calls` | 0 | 1 | 2 | 0 | 0 | 0 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 43 | 17 | 28 | 0.651163 | 1.647059 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 44 | 17 | 30 | 0.681818 | 1.764706 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 10 | 5 | 10 | 1 | 2 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `sessions_with_2_boundaries` | 0 | 2 | 1 | 2 | 1 | 2 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `native_compactions` | 22 | 57 | 31 | 87 | 1.526316 | 2.806452 | old: RCA: >25% difference; pre: RCA: >25% difference |
| `requests` | 122 | 127 | 127 | 127 | 1 | 1 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,955,763 | 5,177,919 | 5,525,949 | 4,830,268 | 0.932859 | 0.874107 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | 5,261,056 | 4,367,104 | 4,537,088 | 4,090,112 | 0.936573 | 0.901484 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | 32,699 | 31,263 | 41,130 | 37,333 | 1.194159 | 0.907683 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `peak_prompt` | 77,059 | 77,381 | 78,166 | 73,778 | 0.953438 | 0.943863 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.046823 | 0.042332 | 0.049184 | 0.043558 | 1.028964 | 0.88562 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `reference_cost` | 4.281534 | 4.055286 | 4.575306 | 3.824032 | 0.942975 | 0.835798 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reference_no_cache` | 12.173118 | 10.605942 | 11.380938 | 9.9592 | 0.939021 | 0.875077 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 34 | 34 | 34 | 34 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 25 | 14 | 25 | 1 | 1.785714 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `eligible_selected` | 0 | 43 | 17 | 28 | 0.651163 | 1.647059 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `selected_eligible_disposable` | 0 | 36 | 17 | 25 | 0.694444 | 1.470588 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 41 | 14 | 28 | 0.682927 | 2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 35 | 14 | 25 | 0.714286 | 1.785714 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 16 | 6 | 10 | 0.625 | 1.666667 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `successful_unhide` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_after_compaction` | 0 | 1 | 0 | 1 | 1 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_repeat_visible` | 2 | 1 | 4 | 6 | 6 | 1.5 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `rereads_same_turn` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_later_turn` | 0 | 1 | 0 | 1 | 1 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_unhide_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_read_after_compaction` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_read_repeat_visible` | 1 | 1 | 2 | 2 | 2 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `rereads_read_new` | 46 | 23 | 44 | 45 | 1.956522 | 1.022727 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `rereads_bash_after_compaction` | 0 | 1 | 0 | 1 | 1 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_bash_repeat_visible` | 1 | 0 | 2 | 4 | N/A | 2 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_bash_new` | 7 | 28 | 8 | 8 | 0.285714 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `cache_transitions` | 0 | 10 | 6 | 10 | 1 | 1.666667 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_uncached_growth` | 0 | -32,181 | 857 | -71,933 | 2.235263 | -83.935823 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.001543 | 0.000981 | -0.001974 | 1.279305 | -2.011652 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.000031 | 0.000016 | 0.000007 | 0.212988 | 0.421151 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.04608 | 0.023304 | 0.009815 | 0.212988 | 0.421151 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 23 | 14 | 28 | 1.217391 | 2 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `stored_items` | 0 | 23 | 14 | 28 | 1.217391 | 2 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 57 | 55 | 58 | 62 | 1.127273 | 1.068966 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_tool_content_transitions` | 39 | 30 | 35 | 28 | 0.933333 | 0.8 | old: Descriptive / coverage; pre: Descriptive / coverage |

#### OMP/boreal

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 12 | 15 | 14 | 1.166667 | 0.933333 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `sessions_using_navigation` | 0 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `list_calls` | 0 | 0 | 1 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 30 | 35 | 35 | 1.166667 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `literal_ids_selected` | 0 | 31 | 35 | 36 | 1.16129 | 1.028571 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `cleanup_boundaries` | 0 | 9 | 12 | 10 | 1.111111 | 0.833333 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `sessions_with_2_boundaries` | 0 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_compactions` | 18 | 69 | 58 | 64 | 0.927536 | 1.103448 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `requests` | 122 | 124 | 145 | 146 | 1.177419 | 1.006897 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,358,807 | 5,034,374 | 5,634,753 | 5,198,844 | 1.032669 | 0.922639 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | 4,749,568 | 4,328,448 | 4,657,152 | 4,218,880 | 0.974687 | 0.905893 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | 26,207 | 25,820 | 36,931 | 35,337 | 1.36859 | 0.956838 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `peak_prompt` | 78,572 | 73,578 | 73,928 | 70,753 | 0.961605 | 0.957053 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.040507 | 0.038788 | 0.047617 | 0.044643 | 1.150947 | 0.937539 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 0 | 0 | 21 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `reference_cost` | 3.802918 | 3.782636 | 4.579226 | 4.352064 | 1.150537 | 0.950393 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reference_no_cache` | 10.92727 | 10.275308 | 11.564954 | 10.680384 | 1.039422 | 0.923513 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 34 | 35 | 35 | 34 | 0.971429 | 0.971429 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 19 | 22 | 27 | 1.421053 | 1.227273 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `eligible_selected` | 0 | 30 | 35 | 35 | 1.166667 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `selected_eligible_disposable` | 0 | 26 | 26 | 32 | 1.230769 | 1.230769 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `explicit_hide_eligible` | 0 | 30 | 35 | 8 | 0.266667 | 0.228571 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 26 | 26 | 8 | 0.307692 | 0.307692 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 12 | 9 | 7 | 0.583333 | 0.777778 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `successful_unhide` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_after_compaction` | 0 | 0 | 3 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_repeat_visible` | 10 | 2 | 19 | 4 | 2 | 0.210526 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `rereads_same_turn` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_later_turn` | 0 | 0 | 3 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_unhide_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_read_after_compaction` | 0 | 0 | 2 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_read_repeat_visible` | 5 | 2 | 5 | 1 | 0.5 | 0.2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `rereads_read_new` | 42 | 45 | 44 | 24 | 0.533333 | 0.545455 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `rereads_bash_after_compaction` | 0 | 0 | 1 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_bash_repeat_visible` | 5 | 0 | 14 | 3 | N/A | 0.214286 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `rereads_bash_new` | 11 | 8 | 7 | 28 | 3.5 | 4 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `cache_transitions` | 0 | 9 | 12 | 11 | 1.222222 | 0.916667 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `transition_uncached_growth` | 0 | -11,500 | 11,975 | -10,478 | 0.91113 | -0.87499 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.000618 | -0.000927 | -0.000971 | 1.570527 | 1.048306 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `transition_native_growth_sensitivity_usd` | 0 | 0.000024 | 0.000065 | 0.000045 | 1.83265 | 0.692815 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.036606 | 0.096831 | 0.067086 | 1.83265 | 0.692815 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 23 | 29 | 24 | 1.043478 | 0.827586 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `stored_items` | 0 | 23 | 29 | 24 | 1.043478 | 0.827586 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 65 | 57 | 75 | 58 | 1.017544 | 0.773333 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_tool_content_transitions` | 44 | 33 | 46 | 21 | 0.636364 | 0.456522 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |

#### HERMES/atlas

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 1 | 16 | 2 | 2 | 0.125 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 1 | 1 | 2 | 2 | 2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `list_calls` | 0 | 1 | 2 | 1 | 1 | 0.5 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `literal_ids_valid` | 0 | 0 | 12 | 2 | N/A | 0.166667 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 0 | 12 | 2 | N/A | 0.166667 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 0 | 7 | 1 | N/A | 0.142857 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `sessions_with_2_boundaries` | 0 | 0 | 1 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `native_compactions` | 15 | 14 | 11 | 14 | 1 | 1.272727 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `requests` | 169 | 121 | 130 | 147 | 1.214876 | 1.130769 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,907,516 | 4,204,382 | 3,987,334 | 5,001,893 | 1.189686 | 1.254445 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `cached_tokens` | 4,924,160 | 3,285,760 | 3,097,856 | 3,901,696 | 1.187456 | 1.259483 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `output_tokens` | 126,414 | 105,215 | 74,584 | 108,835 | 1.034406 | 1.459227 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `peak_prompt` | 54,663 | 54,549 | 54,178 | 54,841 | 1.005353 | 1.012237 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.093728 | 0.074548 | 0.058118 | 0.080527 | 1.080205 | 1.385577 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 0 | 0 | 2 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `reference_cost` | 5.440104 | 4.321844 | 3.924556 | 5.021922 | 1.161986 | 1.279615 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `reference_no_cache` | 12.826344 | 9.250484 | 8.57134 | 10.874466 | 1.175556 | 1.268701 | old: Reported ratio; no equivalence claim; pre: RCA: >25% difference |
| `final_backreferences` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 34 | 34 | 36 | 34 | 1 | 0.944444 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 0 | 11 | 1 | N/A | 0.090909 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `eligible_selected` | 0 | 0 | 12 | 2 | N/A | 0.166667 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `selected_eligible_disposable` | 0 | 0 | 11 | 1 | N/A | 0.090909 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 0 | 12 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `explicit_hide_disposable` | 0 | 0 | 11 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `keep_lines_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `successful_unhide` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_same_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_later_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_unhide_calls` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `cache_transitions` | 0 | 0 | 7 | 1 | N/A | 0.142857 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_uncached_growth` | 0 | 0 | -41,231 | -24,525 | N/A | 0.594819 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | 0 | -0.000132 | -0.000169 | N/A | 1.283429 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0 | 0.000005 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `transition_reference_growth_sensitivity_usd` | 0 | 0 | 0.007694 | 0 | N/A | 0 | old: Descriptive / coverage; pre: Behavior differs >25%; see discussion |
| `originals_compared` | 0 | 0 | 44 | 41 | N/A | 0.931818 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `stored_items` | 0 | 0 | 56 | 43 | N/A | 0.767857 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 123 | 57 | 62 | 83 | 1.45614 | 1.33871 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | 6 | 16 | 11 | 10 | 0.625 | 0.909091 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |

#### HERMES/boreal

| Metric | A | B-old `37348b8` | Pre-fix `8902a41` | Fixed `df47548` | Fixed/old | Fixed/pre | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| `sessions` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `final_only_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `task_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `visible_unit_success` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_pass` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `canonical_tests_applicable` | 2 | 2 | 2 | 2 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `announced_recall` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `surprise_recovery` | 2 | 2 | 2 | 2 | 1 | 1 | old: PASS: no observed regression; pre: PASS: no observed regression |
| `navigation_calls` | 0 | 27 | 2 | 19 | 0.703704 | 9.5 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `sessions_using_navigation` | 0 | 2 | 1 | 1 | 0.5 | 1 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `list_calls` | 0 | 2 | 0 | 2 | 1 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `literal_ids_valid` | 0 | 28 | 5 | 16 | 0.571429 | 3.2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `literal_ids_selected` | 0 | 28 | 5 | 16 | 0.571429 | 3.2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `cleanup_boundaries` | 0 | 20 | 1 | 12 | 0.6 | 12 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `sessions_with_2_boundaries` | 0 | 2 | 0 | 1 | 0.5 | N/A | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `native_compactions` | 13 | 4 | 12 | 9 | 2.25 | 0.75 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `requests` | 173 | 165 | 146 | 130 | 0.787879 | 0.890411 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `prompt_tokens` | 5,989,242 | 4,602,805 | 4,511,313 | 3,831,986 | 0.832533 | 0.849417 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `cached_tokens` | 5,069,568 | 3,779,328 | 3,528,448 | 2,939,904 | 0.777891 | 0.8332 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `output_tokens` | 102,348 | 35,871 | 99,251 | 72,310 | 2.015835 | 0.728557 | old: RCA: >25% difference; pre: RCA: >25% difference |
| `peak_prompt` | 54,992 | 53,106 | 54,632 | 54,166 | 1.01996 | 0.99147 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reported_usd` | 0.08204 | 0.041773 | 0.073165 | 0.056207 | 1.345534 | 0.768223 | old: RCA: >25% difference; pre: Reported ratio; no equivalence claim |
| `missing_cost` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS; pre: PASS |
| `missing_cached` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `summary_requests` | 0 | 8 | 5 | 0 | 0 | 0 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `reference_cost` | 5.192916 | 3.823586 | 4.523962 | 3.832596 | 1.002356 | 0.847177 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `reference_no_cache` | 12.797268 | 9.492578 | 9.816634 | 8.242452 | 0.868305 | 0.839641 | old: Reported ratio; no equivalence claim; pre: Reported ratio; no equivalence claim |
| `final_backreferences` | 0 | 0 | 1 | 1 | N/A | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_observed` | 35 | 34 | 34 | 34 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |
| `eligible_disposable_unique_selected` | 0 | 24 | 5 | 14 | 0.583333 | 2.8 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `eligible_selected` | 0 | 28 | 5 | 16 | 0.571429 | 3.2 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `selected_eligible_disposable` | 0 | 24 | 5 | 14 | 0.583333 | 2.8 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `explicit_hide_eligible` | 0 | 20 | 0 | 16 | 0.8 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `explicit_hide_disposable` | 0 | 17 | 0 | 14 | 0.823529 | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `keep_lines_calls` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `successful_unhide` | 0 | 2 | 0 | 0 | 0 | N/A | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `rereads_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_same_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_later_turn` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_unhide_calls` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_read_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_after_compaction` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_repeat_visible` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `rereads_bash_new` | N/A | N/A | N/A | N/A | N/A | N/A | old: Unavailable; not zero; pre: Unavailable; not zero |
| `cache_transitions` | 0 | 20 | 2 | 12 | 0.6 | 6 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_uncached_growth` | 0 | -167,288 | -40,291 | -106,903 | 0.639036 | 2.653272 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_reported_cost_delta` | 0 | -0.002585 | -0.000281 | -0.001032 | 0.399469 | 3.676433 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `transition_native_growth_sensitivity_usd` | 0 | 0.00001 | 0 | 0.000003 | 0.3461 | N/A | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `transition_reference_growth_sensitivity_usd` | 0 | 0.014883 | 0 | 0.005151 | 0.3461 | N/A | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `originals_compared` | 0 | 28 | 41 | 42 | 1.5 | 1.02439 | old: Behavior differs >25%; see discussion; pre: Descriptive / coverage |
| `stored_items` | 0 | 28 | 46 | 58 | 2.071429 | 1.26087 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `original_mismatches` | 0 | 0 | 0 | 0 | N/A | N/A | old: PASS: no observed mutation; pre: PASS: no observed mutation |
| `unmatched_native_items` | 0 | 0 | 0 | 0 | N/A | N/A | old: Descriptive / coverage; pre: Descriptive / coverage |
| `native_originals_checked` | 116 | 83 | 81 | 58 | 0.698795 | 0.716049 | old: Behavior differs >25%; see discussion; pre: Behavior differs >25%; see discussion |
| `native_tool_content_transitions` | 6 | 13 | 13 | 13 | 1 | 1 | old: Descriptive / coverage; pre: Descriptive / coverage |

## Summary upgrade and factual-retry revalidation (`fe75673`)

### Scope and implementation

Product **`fe7567323a697d526215296ddb149d00efff6c09`** implements the two
approved changes. The invocation/harness checkout is the same commit; the
collection/controller and common scoring code are unchanged from `7504c7d`.
This section supersedes the OMP summary-source coverage caveat above, not the
frozen long-session or Hermes measurements.

- Explicit Summarize upgrades a rule/Hide replacement to an accepted LLM
  replacement. Accepted `llm` and `llm_summary` items are reused without another
  model call. Failed upgrades return an explicit error and retain the Hide.
- A factual-validation rejection gets exactly one correction request with the
  complete original and English feedback identifying unsupported numbers,
  identifiers, paths and required/critical facts. The validator is unchanged.
  Transport, budget, compression and CAS failures are not correction triggers.
- Both engines retain originals and version fences. Hermes owns retries for its
  validated model interface; generic engine summarizers own their retry. OMP
  records every returned model attempt, including rejected text. Paseo's worker
  is regenerated, and accepted cross-surface summaries are not requeued.

Only **four OMP commanded cells** ran: Hide/Summarize × two repetitions, three
turns each, followed by four distinct replacement judges. Setup remains DeepSeek
`deepseek/deepseek-v4.1-flash-1017`, Relace only, no fallback, reasoning off,
65,536-token window, OMP 18.18.3 and the same fixtures/host limits. All seven
recorded host-file fingerprints match the `df47548` campaign. The proxy technical
ceiling was **$5**. A, B-old, pre-fix, fixed long sessions and Hermes were **not
rerun**. An offline four-cell stub run preceded paid generation.

Raw evidence, analysis and the fresh budget ledger are outside git under
`/Users/devin/nav-phase0-gates/step8-eval/summary-upgrade/`; prior evidence is
read-only. `analysis.json`, `analysis.log`, `analyze_campaign.py`, `paid/` and
`components/` contain the audit, captured wires, native histories, store snapshots
and judges. The new comparison reuses `v4_compare.assemble` and
`component_metrics`; it does not weaken the full-campaign archival assertions.

### OMP component comparison

Component resources below exclude judges, consistently with the existing tables.
Ratios are new/fixed. There are only two trials per action; no equivalence or
unique counterfactual attribution is claimed.

| Metric | Pre-fix `8902a41` | Fixed `df47548` | Upgrade/retry `fe75673` | New/fixed | Verdict |
|---|---:|---:|---:|---:|---|
| Complete/strict-success trials | 4/4 | 4/4 | 4/4 | 1.000× | No observed regression |
| Accepted pure LLM Summarize trials | 2/2 | **0/2** | **2/2** | N/A | Accepted LLM coverage restored in these trials |
| Facts in sent Summarize replacements | 4/6, LLM | 6/6, **rule** | **6/6, LLM** | 1.000× | Source distinction matters |
| Facts in accepted LLM replacements | 4/6 | N/A, none accepted | **6/6** | N/A | All labelled facts retained |
| Hide trials / retained facts | 2/2; 6/6 | 2/2; 6/6 | 2/2; 6/6 | 1.000× | No observed regression |
| Wrong-source Summarize replacements | 0 | 2 | **0** | 0.000× | No rule replacement reported as a summary |
| Summary-model calls | 3 | 4 | 3 | 0.750× | Includes rejected responses |
| Automatic factual-correction requests | 0 | 0 | **1** | N/A | One first rejection corrected successfully |
| Summarize trials using that retry | 0/2 | 0/2 | **1/2** | N/A | No second retry |
| Successful Unhide operations | 4 | 5 | 4 | 0.800× | Fixed run had one extra turn-2 restore |
| Commanded restores exact / without work calls | 4/4 | 4/4 | **4/4** | 1.000× | Original IDs and exact original bytes |
| Work-tool calls in commanded restore turns | 0 | 0 | **0** | N/A | No tool re-execution |
| Stored-original mismatches | 0 | 0 | **0** | N/A | Compared to first native originals and hashes |
| Requests | 54 | 42 | **33** | 0.786× | Descriptive decrease |
| Prompt tokens | 556,936 | 490,998 | **297,955** | 0.607× | >25% decrease; decomposition below |
| Cached tokens | 458,240 | 349,440 | **226,816** | 0.649× | Fewer prompt tokens, not worse cache-hit fraction |
| Output tokens | 8,560 | 6,887 | **4,320** | 0.627× | >25% decrease; decomposition below |
| Reported USD | $0.007163376 | $0.006040048 | **$0.003720914** | 0.616× | Both summary attempts included |
| Distinct eligible judges / scored | 4/4 | 4/4 | **4/4** | 1.000× | No missing judgement |
| Mean judge score | 2.25 | 1.75 | **2.00** | 1.143× | Descriptive; not an unqualified quality pass |

### Live retry evidence and limits

Repetition 1 produced unsupported **`100`** in request
`e608d70b978645ffb1aa4cedeb9a30ca`: “contains 100 distinct minute/region
measurements”. The original contains individual rows but no literal `100`.
The automatic correction request `fb92ffdcb4ef434aadb0c1937df3aa96` included:

> The previous summary failed factual validation. Correct it once using only the
> original source. Unsupported numeric tokens: ["100"]. Unsupported identifiers:
> []. Unsupported paths: [].

It also included the required source evidence, verified facts, critical claims,
the unchanged complete source, and instructions not to derive counts/ranges/units.
The corrected text removed the unsupported count and retained
`owner=component-team-1`, `audit_seal=component-9e54cadbf4` and
`latency_budget_ms=151`. It passed unchanged validation. Repetition 2's initial
response `341cf86252c24035a8ef37491961e7dc` passed without a retry. All **3/3**
model responses contained the late latency fact, beyond character 12,000 in the
source; accepted replacements retain **6/6** labelled facts.

**Neither new live Summarize trial performed an early Hide.** Thus the live run
directly demonstrates factual retry and accepted LLM replacements, but does not
itself demonstrate an upgrade of an already-hidden item. Do not attribute all
coverage improvement to the upgrade branch. That branch is verified by the
cross-language unit/CAS tests and deterministic replay of all four captured
`df47548` OMP responses: the previously valid response upgrades after Hide in one
call; each of the three numeric rejections takes the feedback path and upgrades
in two calls when supplied the captured valid response on correction. This is a
counterfactual replay using captured responses, not three historical live retries.
Invalid-then-invalid tests preserve the Hide and return `verification_failed`;
concurrent Unhide tests return `version_conflict` and retain the visible original.

SQLite recorded **all three returned summary attempts**, with **24,738 prompt +
455 output = 25,193 total tokens**. The unchanged evaluation model descriptor in
`eval/v2_omp.ts` declares zero SDK prices, so its host-estimated SQLite summary
cost is $0. The authoritative billed amounts are the proxy/OpenRouter ledger:
**$0.000130754 rejected + $0.000112484 correction** for repetition 1, and
**$0.000116818** for repetition 2; **$0.000360056** across summary attempts.
Zero SDK pricing is not evidence of free calls, and neither rejected usage nor
cost is excluded from the resource totals.

Judges remain conservative: scores are **1, 2, 3, 2**. They penalize omitted
telemetry rows and restore-wrapper text. One judge also claims the three metadata
facts were omitted, contrary to the captured replacement and deterministic
fact-retention check. Preserve that score rather than relabel it. Labelled-fact
retention and exact restoration pass; semantic replacement quality is not thereby
proven equivalent or universally satisfactory.

### Resource differences versus `df47548`

The >25% prompt/cache/output/cost decreases are reachable, directly counted
trajectory differences, not a host-version change:

- Ordinary model requests decrease **38→30**, and summary requests **4→3**.
  Fixed trials both hid early and issued two explicit Summarize operations each;
  new trials each issue one explicit Summarize (one automatically corrected).
  The fixed run also includes a turn-2 Unhide and more listing/diagnostic steps.
- Of **193,043 fewer prompt tokens**, **184,945** are ordinary requests and
  **8,098** are summary requests. Cached-token fraction actually increases
  **71.2%→76.1%** while absolute cached tokens fall.
- Of **2,567 fewer output tokens**, **2,292** are ordinary requests and **275**
  are summary responses. Ordinary billed cost falls
  **$0.005501840→$0.003360858**, summary cost
  **$0.000538208→$0.000360056**.
- Hide per-trial requests/output are **7/907** and **6/575**, versus fixed
  **7/1,015** and **7/950**. Summarize per-trial requests/output are
  **11/1,525** and **9/1,313**, versus **13/2,365** and **15/2,557**.

These counts explain the resource concentration. The retry's extra request is
directly evidenced; how much of the changed ordinary tool/answer trajectory is
caused by product behavior rather than stochastic model choice is not isolated.
There were no upstream failures/retries, budget denials, `input_too_large` or
`keep_lines_too_broad` outcomes in these four cells. Automatic factual correction
is a successful product retry, not an API retry or excluded product outcome.

### Spend and verification

| New paid calls | Requests | Reported USD |
|---|---:|---:|
| Four OMP component cells, including rejected/corrected summaries | 33 | $0.003720914 |
| Four replacement judges | 4 | $0.000494086 |
| **Total** | **37** | **$0.004215000** |

All 37 upstream attempts, costed responses and ledger charges reconcile. No
unresolved reservation or failed-attempt estimate remains. **$3 was not crossed**.

Final implementation checks (before paid generation):

```text
382 passed, 11 skipped in 31.25s
Core Node: ℹ tests 26; ℹ pass 26; ℹ fail 0
Core Bun: 26 pass; 0 fail
OMP build/typecheck/tests: 61 pass; 0 fail; 625 expect() calls
Paseo build/typecheck/tests: 132 pass; 0 fail
Node worker: ℹ tests 8; ℹ pass 8; ℹ fail 0
PASS differential Python vs TS+node: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+node -> Python and reverse
PASS differential Python vs TS+bun: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+bun -> Python and reverse
PASS Python engine and Hermes source/vendor parity
Ran 57 tests in 39.947s
OK
```

The core-only package has no local TypeScript compiler dependency; its typecheck
used the already-installed OMP `tsc` against the core tsconfig, without changing
dependencies. Offline evaluation used the documented `uv --with tiktoken`
environment. Both captured-response replays pass 4/4, with call counts **2,2,1,2**
in each language and exact restores. `git diff --check` passes. Markdown/UI was
not visually rendered.

```text
PASS offline stub: exactly four OMP component cells, three turns each; no host/config mutation or key exposure
PASS exactly four OMP component cells, three completed turns each; no historical/long/Hermes generation
PASS seven host fingerprints unchanged from fixed df47548 campaign
PASS 37 upstream attempts/responses/ledger charges reconciled; Relace/no fallback/reasoning off; spend $0.004215000
PASS 4 successful restores exact under original IDs; zero work calls in restore turns; no key in artifacts
```
