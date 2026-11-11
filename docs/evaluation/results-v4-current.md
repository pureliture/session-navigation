# v4 DeepSeek: frozen A / historical B / current TypeScript OMP + Python Hermes

Date: 2026-11-10. **B-current only was executed.** Historical A/B-old were never rerun.

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
