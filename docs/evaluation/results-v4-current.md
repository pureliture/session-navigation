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

## Root-cause analysis

This follow-up supersedes the attribution limits in the initial root-cause review
where it provides stronger evidence. It changes no outcome, selection, metric,
product implementation or original campaign evidence. **New model spend: $0.00**;
all additional experiments were deterministic, local and network-free. No old OMP
daemon was restored or run. Old Python engine/validator modules were extracted
solely for in-process counterfactuals.

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
