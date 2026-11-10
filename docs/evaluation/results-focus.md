# Focus effect: stale tool output without native compaction

> 원자료 링크는 프라이빗 평가 저장소의 고정된 커밋을 가리키며 읽기 권한이 필요합니다.

## Conclusion

**No answer-quality benefit shown.** All 30 RAW replay trials answered the eleven
reachable primary fields correctly; PLUGIN-HIDE did so in 29/30. The one failure
emitted a textual recovery call rather than an answer, not a stale value or a
verified loss of a primary fact. Live OMP finished 3/3 in both arms. Autonomous
Hide was actually exercised in two B sessions, unlike the earlier Hermes pressure
experiment, but did not improve their already-perfect measured accuracy.

Hide greatly reduced transmitted context. That is a resource result, not proof
of a focus/quality improvement. The deliberately buried, hidden-only recall field
was lost in the controlled Hide histories and is reported separately, not silently
excluded from disclosure. These are synthetic structured fixtures, not normal-work
production measurements or a general equivalence result.

Evidence: [`eval/results/2026-11-10-focus`](https://github.com/pureliture/session-navigation-evidence/tree/8214151597ae6d7791bc0650d53c14075be0a0f3/2026-11-10-focus).
All 66 planned sessions qualified; no API-error exclusions or inference retries
were needed. There were 210 successful responses, all Relace, all reporting zero
reasoning tokens. Native compaction starts: **zero**.

## Design and implementation

- Model `deepseek/deepseek-v4.1-flash-1017`; Relace only, fallback disabled;
  `reasoning={"enabled":false,"exclude":true}`. The existing guarded loopback
  proxy alone injects the env-only real credential into upstream requests.
- Product pinned to `37348b89faf82ced7510fe09e2a97a893fbcc8a3`.
  Replay calls the actual `SessionNavigationEngine.compact_sync` with its normal
  SQLite store, policy checks and default rule selector. Product source bytes are
  checked against the pinned snapshot. No keep_lines or auxiliary LLM summaries.
- Five seeds: 317, 419, 523, 631, 743; two lengths; three repetitions per arm:
  **60 replay calls / 30 matched pairs**. Randomization seed 20261111; paired arms
  are shuffled. A randomly selected long pair is the replay pilot. Live uses the
  first three seeds with independently shuffled seed/arm order, six fresh sessions.
- Eight completed-subtask read results contain generation-41 obsolete configurations,
  earlier assertion mismatches, archived incident figures and high-volume telemetry.
  Generation-42 signed-live values are authoritative despite later archive dates.
  Replay assistant acknowledgments do not repeat the answers.
- Declared window: **131,072 tokens**. RAW histories are approximately 35% and 70%
  using compact-JSON `o200k_base`; reported RAW input is about 36% and 72%.
  Replay is a fixed OpenAI tool-call wire history, not an executing OMP session.
  There is no native compressor. Live explicitly sets `compaction.enabled=false`
  through an opt-in runner field; historical experiments retain their old default.
- The fixed replay selection rule hides all eight finished-subtask tool results.
  No history other than tool-result content changes. All replacements and original
  SHA-256 values are retained in the fixtures, alongside full originals.
- Eleven primary fields: eight current facts plus spare capacity, safe parallelism
  and drain seconds. All source operands remain in actual Hide excerpts; no
  correctness is credited to inaccessible primary information. Current records
  intentionally occupy ordinary head excerpts, so this is a favorable retention
  layout, not a general test that Hide discovers arbitrary important facts.
- A twelfth `audit_marker` occurs only in the middle of an old tool output.
  It survives RAW and is absent after Hide. Its separate loss score tests that
  consequence honestly. Replay permits no tool execution/recovery; live permits
  notes, source rereads and ordinary tools. Live cleanup timing/targets/actions are
  entirely agent-selected; its user prompts never command cleanup.
- Scoring checks requested JSON values, including conflicting values and bool/int
  distinctions. Stale values are known obsolete alternatives; other wrong values
  are unsupported. Missing answers are missing, not fabricated claims. Arbitrary
  prose and unrequested extra fields are not semantically adjudicated.

`stage.json` records the schedule/settings/source hashes before calls. The pilot
includes one long replay pair and one live pair; its captured cost was
**$0.019398338**, projected campaign **$0.105835784**, including a 1.5x remaining
session safety factor, below the authorized **$1.50** gate.

## Part A: controlled replay

Each row has 15 trials and 165 reachable primary field checks.

| Length / arm | Exact trials | Primary fields | Stale / unsupported | Hidden-only marker | Prompt tokens | Output tokens | USD |
|---|---:|---:|---:|---:|---:|---:|---:|
| Short RAW | 15/15 | 165/165 | 0 / 0 | 15/15 | 703,422 | 1,688 | .004594004 |
| Short PLUGIN-HIDE | 15/15 | 165/165 | 0 / 0 | 0/15 | 24,000 | 1,667 | .000964700 |
| Long RAW | 15/15 | 165/165 | 0 / 0 | 15/15 | 1,412,217 | 1,664 | .008360150 |
| Long PLUGIN-HIDE | 14/15 | 154/165 | 0 / 0 | 0/15 | 23,988 | 1,651 | .000956628 |

RAW total: 30/30 exact, 330/330 fields. Hide: 29/30 exact, 319/330 fields.
The unanswerable marker never receives primary-field credit: **RAW 30/30, Hide
0/30** on that separate loss category. There is no evidence of a quality gain
at either length. Prompt reduction is approximately **96.6% short / 98.3% long**.

### Paired uncertainty

| Stratum | Pairs | RAW-only exact / Hide-only exact | Exact McNemar p | Hide minus RAW field accuracy | Seed-cluster bootstrap 95% |
|---|---:|---:|---:|---:|---:|
| Short | 15 | 0 / 0 | 1.0 | 0 pp | [0, 0] pp |
| Long | 15 | 1 / 0 | 1.0 | -6.67 pp | [-20, 0] pp |
| Combined | 30 | 1 / 0 | 1.0 | -3.33 pp | [-10, 0] pp |

The exact paired test is on whole eleven-field trial vectors, not 330 supposedly
independent facts. Repetitions and fields within a seed are dependent. Primary
uncertainty resamples the **five seed clusters**, 5,000 bootstrap replicates,
fixed RNG 20261111. A degenerate interval at a ceiling is not proof of equivalence;
five synthetic seeds cannot establish broad safety or absence of a focus effect.

### The one strict replay failure

`focus-replay-317-long-2-PLUGIN-HIDE-main`, response
`gen-1794300339-8r6lwCiEliZclkd7YgzJ`, returned textual DeepSeek DSML containing
`invoke name="unhide_context"` for `item_7d3094aa1bcb68d0`, not JSON.
It finished `stop` after 45 output tokens, with normal usage and cost; this was
not HTTP failure, native compaction or output-budget exhaustion. All eleven
primary operands remain in the actual sent excerpts. The referenced item is
the compiler result whose buried marker was removed. The output is consistent
with an attempted recovery, but the model's motivation is not directly observed.
It is **not evidence of forgetting a reachable current value**. We count the
strict failure, do not retry it, and do not relabel it as an API exclusion.

Important limitation: primary and loss-only fields are requested in the same
completion. A recovery attempt for the loss-only field can prevent the entire
primary answer. Thus this isolated miss cannot identify a harmful focus effect
either. A follow-up should put the loss-only question in a separate completion;
we did not change the preregistered questions or rerun a failed outcome post hoc.

## Part B: live OMP, native compaction disabled

Both final-only and current visible-unit surfaces passed all eleven primary
fields and the marker in every session. Stale/unsupported values: **zero**.

| Seed / arm | Primary | Nav calls | Successfully hidden items | Requests | Prompt tokens | Output tokens | USD |
|---|---:|---:|---:|---:|---:|---:|---:|
| 317 A | 11/11 | 0 | 0 | 18 | 1,051,455 | 3,851 | .007296246 |
| 317 B-new | 11/11 | 8 | 8 | 27 | 367,139 | 7,396 | .005664802 |
| 419 A | 11/11 | 0 | 0 | 23 | 1,413,695 | 8,909 | .011648990 |
| 419 B-new | 11/11 | 1 | 0 | 30 | 670,140 | 5,615 | .006197556 |
| 523 A | 11/11 | 0 | 0 | 28 | 1,682,852 | 6,142 | .011595248 |
| 523 B-new | 11/11 | 6 | 8 | 24 | 859,669 | 5,369 | .007105746 |
| **A total** | **33/33** | **0** | **0** | **69** | **4,148,002** | **18,902** | **.030540484** |
| **B-new total** | **33/33** | **15** | **16** | **81** | **1,896,948** | **18,380** | **.018968104** |

Adoption: **2/3 B sessions actually cleaned**. Seed 419 only listed candidates;
its one navigation call is not cleanup. Seed 523 first made two rejected Hide
batches (`invalid_keep_lines`, 3 and 6 items), then succeeded without keep_lines.
Seed 317 used eight successful one-item Hide calls. No Summarize/unhide calls.
Live source rereads/answers can preserve the marker; it is not guaranteed
hidden-only in these autonomous histories as it is in controlled replay.

Lower aggregate B prompt tokens and cost do not establish a quality effect.
Even seed 419, which never hid anything, had different ordinary tool usage;
these six autonomous trajectories are a sanity check, not a controlled estimate
of causal token savings. Native events stayed at zero in every session.

## Cost, evidence and checks

**Total reported campaign cost: $0.064384070** (about 6.44 cents): replay
**$0.014875482**, live **$0.049508588**. Captured usage is complete. This is
campaign spending, not the key's cumulative balance. No judge or summary calls.

- `scorecard.json`: per-session answers, field checks, groups, paired inference.
- `fixtures/*.json.gz`: originals, exact Hide mutations, survival and both histories.
- `attempts/pilot/budget.json`: included pilot decision, preserved separately.
- `attempts/*/wire.jsonl.xz`: losslessly archived raw model-sent wires, SHA-256 manifests.
- `request-audit.json`: 210 pinned requests, 60 exact replay histories, 150 live requests,
  all primary operands retained, zero native starts, byte-exact final configurations.
- `final-audit.json`: real-key-byte and credential-prefix audit.

```text
uv run --no-sync --with tiktoken python -m unittest discover -s eval/tests -v
Ran 38 tests in 3.412s
OK

uv run --no-sync --with tiktoken python eval/focus_audit.py eval/results/2026-11-10-focus
final configurations byte-exact: True

uv run --no-sync python eval/v2_audit.py eval/results/2026-11-10-focus
{"files_checked": 197831, "actual_key_matches": 0, "credential_prefix_matches": 0}
```

The first offline test attempt found the store's WAL requirement does not support
an in-memory SQLite database; the fixture now uses an isolated short-lived database
under HOME and preserves originals/replacements in campaign evidence. No product
or installed-runtime files changed. Root README is unchanged because no clear
positive focus/quality result was demonstrated. No visual check is applicable.
