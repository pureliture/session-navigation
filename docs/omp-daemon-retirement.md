# Step 7: Python OMP daemon retirement audit

Compared with `origin/main` (`ddc6dcb3e02904bf565dce1ab9e140f1cb95091e`).
The daemon removal itself already existed when this step began. The shared
Python engine and both Hermes source/vendor trees remain supported.

## Inventory

| Requested item | At start of Step 7 | Final action/status |
| --- | --- | --- |
| `pyproject.toml` daemon script and wheel entry | Already removed; no project scripts, wheel packages only `src/session_navigation` | Kept; added a packaging regression assertion |
| `src/session_navigation_omp/` | Already removed | No Python OMP runtime shipped |
| `tests/test_omp_daemon.py` | Already removed | Existing TS service ports reviewed; metadata/empty-ID/skip assertions strengthened |
| `tests/test_daemon_pending_summary.py` | Already removed | Existing TS ports plus new SQLite reopen/settlement cases |
| `tests/test_omp_sqlite_e2e.py` | Already removed | Existing ports plus real SQLite write refusal and cross-connection CAS checks |
| `tests/test_cli_message_hide.py` | Entire file already removed | Current server/core message tests replace behavior; CLI routing is retired |
| `tests/test_perf.py` | Daemon import removed; engine/Hermes timeout tests retained | Kept |
| `tests/test_e2e_persistence.py` | Daemon/CLI-specific functions removed; engine persistence/thread races retained | Kept; TS cross-connection regression added |
| `eval/run.py` | Already uses current checkout's extension; no daemon override | Kept; help/import check and offline collector validation |
| `eval/v2_run.py` | Still present, executes frozen Python-era extensions | Deleted after core/OMP ports passed; extracted only reusable metadata/helpers into `eval/campaign_support.py` |
| `eval/capture_overhead.ts` | Already ported to current TS extension | Kept; real loopback A/B capture validates five tools in B only |
| `tools/benchmark_omp_prepare.ts` | Already ported to `WorkerClient`/`prepareSnapshot` | Kept; executed against current built worker |
| `eval/README.md` | Still advertised v2 controller commands | Removed those commands; retained analysis/reproduction information |
| Three installation guides | Uninstall command already present but did not explicitly say both executables | Clarified that `uv tool uninstall session-navigation` removes both CLI and daemon from that tool installation; did not run it |
| OMP test wording | Three engine tests/comments still said daemon, including Korean wording | Renamed to worker/engine/stored state |
| `docs/engine-contract.md` | Presented old JSONL protocol 3 as still current | Marked historical; current transport is Bun worker |

### Why the v2 controller was not a current-package check

`eval/v2_run.py` selected `COMMITS[arm]`, archived it via `source_snapshot`, and
passed that source directory to `eval/v2_omp.ts`, which imported its extension.
For B-new (`37348b8`), that extension's lines 167–169 select and spawn
`session-navigation-daemon`. Thus the dependency was reachable in the controller's
normal pinned-arm execution, not merely a text match. Repointing frozen arms at
the current engine would change the experiment. The obsolete controller and its
README launch commands were removed instead. `b12db47` or the original campaign
commit retains the historical runner for reproduction with the original runtime.

The metadata/helper extraction required import-only changes in `focus_run.py`,
`quality_run.py`, `v4_assemble.py`, and `eval/tests/test_v2.py`. Analysis and offline
tests do not launch an old daemon. The other pinned research campaigns are
explicitly documented as historical, not current-package acceptance commands;
their old OMP live arms require restoring the original runtime. No paid campaign
was run or claimed compatible with the new engine.

### Remaining search matches

Whole-tree searches exclude `.git`, `.venv`, `node_modules`, bytecode/build caches
and archived evaluation results; the Python/Hermes source and vendor trees are
also checked separately. Remaining OMP-daemon mentions are migration guidance,
historical audits/spec removal notes, and negative regression assertions.
There are no executable imports of `session_navigation_omp`, daemon spawn paths,
daemon socket implementations, or legacy JSON-line IPC handlers in the product.
Paseo **host daemon** wording is unrelated and retained. Python's
`threading.Thread(..., daemon=True)` in the evaluation HTTP proxy is unrelated.
Worker RPC remains intentionally; random substrings in the base64 embedded
worker are not IPC references.

## Coverage key

`S` = `packages/omp/test/service.test.ts`:

- **S1** `explicit IDs, invalid requests, chunk append tokens and invalidation`
- **S2** `64-record and 4 MiB limits apply per chunk, not combined snapshot`
- **S3** `32 snapshots use append-refreshed retention and replacement`
- **S4** `2000 records retain early/late hides and all snapshot targets`
- **S5** `candidates are newest eligible first and display limits do not limit management`
- **S6** `fences reject changed invocation and missing identities`
- **S7** `restart, fork, scope isolation and restore CAS preserve originals`
- **S8** `pending summaries settle with fallback and version fences without append replay`
- **S9** `registration occurs on valid processing; legacy state is copied once and preserved`
- **S10** `duplicate complete snapshots invalidate tokens while hidden messages survive reopen` (new)
- **S11** `SQLite pending jobs survive reopen and settle to model text or plain hide` (new)
- **S12** `SQLite write refusal during prepare returns explicit request failure choices` (new)

Other exact test locations:

- **C1**, `packages/core/test/core.test.ts`: `independent SQLite writers reject stale CAS and observe subsequent interleaved writes` (new, Node and Bun).
- **C2**, same file: `pending settlement validates text and never overwrites a concurrent unhide`.
- **C3**, same file: `in-progress reservations and create-only commits protect the first writer`.
- **C4**, same file: `messages preserve existing visibility and reject stale CAS`.
- **P1**, `paseo-plugin/server/service.test.ts`: `message hide/unhide, version fences and unsupported summary preserve original text and OMP projection` (includes mixed message/tool batch and OMP hidden-message projection).
- **W1**, `packages/omp/test/session-navigation.test.ts`: `persistence failure aborts headless and requires an interactive choice` and `interactive abort and structural worker failures cannot silently pass through`.
- **W2**, same file: `the shared model deadline prevents starting remaining pending jobs` and `queue wait consumes the model budget instead of starting another full timeout`.
- **W3**, `packages/omp/test/client.test.ts`: `SQLite lock waits in the actual worker leave the main loop responsive`.
- **X**, `tools/core_conformance.py`: differential Node/Bun fixtures and Python → TS → Python / reverse persistent cross-writer sequences.

## Per-function coverage map

Every `test_*` in the three deleted daemon files is listed below, followed by
all tests in the partially affected files (including their non-daemon portions).

### `origin/main:tests/test_omp_daemon.py`

| Original function | Current coverage |
| --- | --- |
| `test_manage_requires_explicit_ids_and_reports_unknown_ids` | S1, S5 |
| `test_cleanup_candidates_are_visible_eligible_newest_first_with_metadata` | S5; includes exact hint/byte/token metadata, default limit and already-hidden/ineligible errors |
| `test_manage_has_no_id_cap_or_discovery_requirement_and_repeats_across_snapshots` | S5, S4; OMP `session-navigation-cleanup.test.ts`: `cleanup discovers IDs, requires explicit choices, limits model concurrency and repeats across turns without an ID cap` |
| `test_snapshot_requires_matching_token_and_preserves_session_isolation` | S1, S7 |
| `test_duplicate_and_error_records_never_become_candidates` | S1, S10 |
| `test_same_content_and_call_id_with_changed_invocation_is_not_reused` | S6 |
| `test_two_thousand_records_keep_early_and_late_stored_hides` | S4 |
| `test_append_requires_matching_token_and_rejects_cross_chunk_duplicates` | S1 |
| `test_bytes_and_record_limits_apply_to_chunks_not_combined_snapshot` | S1, S2 |
| `test_append_refreshes_snapshot_eviction_and_new_prepare_replaces_it` | S3 |

### `origin/main:tests/test_daemon_pending_summary.py`

| Original function | Current coverage |
| --- | --- |
| `test_pending_summary_is_offered_then_replaced_by_session_model_text` | S8, S11; OMP `session-navigation-cleanup.test.ts`: `the actual context hook sends the LLM summary on its first pending turn (success)` |
| `test_summary_failure_falls_back_to_plain_hide` | S8, S11; repeated settlement returns `not_found` in S8 |
| `test_unrelated_or_larger_summary_falls_back_to_plain_hide` | S8, S11 (both unrelated and oversized text), C2 |
| `test_append_does_not_replay_earlier_pending_summaries` | S8 |

### `origin/main:tests/test_omp_sqlite_e2e.py`

| Original function | Current coverage |
| --- | --- |
| `test_restart_keeps_patches` | S7 |
| `test_fork_carries_state` | S7 |
| `test_readonly_error_and_duplicate_rejected` | S1, S10; valid bash records also covered by OMP `collect accepts bash invocation and preserves original SHA before projection` |
| `test_summarize_without_summary_text_unavailable` | S9 |
| `test_cas_stale_rejected` | S7, C1 |

### `origin/main:tests/test_cli_message_hide.py`

| Original function | Current coverage |
| --- | --- |
| `test_prompt_and_response_hide_and_unhide` | P1, C4; OMP `hidden prompts are dropped and hidden responses keep only their tool calls` |
| `test_messages_reject_summarize_stale_versions_and_unknown_ids` | P1 |
| `test_batch_hides_messages_and_tools_together` | P1 |
| `test_daemon_prepare_reports_hidden_messages` | P1, S10 |

CLI argument parsing/process routing itself is not applicable: the CLI is retired.
The message storage/projection assertions remain covered, rather than being
discarded as process-only behavior.

### `origin/main:tests/test_perf.py`

| Original function | Current coverage |
| --- | --- |
| `test_list_1000_under_1s` | Same Python function retained |
| `test_summarize_timeout_is_25s` | Same Python function checks Hermes timeout; W2 covers OMP budget enforcement. The deleted daemon importability assertion is not applicable (retired process/module only) |
| `test_slow_summarizer_does_not_hang_engine` | Same Python function retained; W2/W3 cover OMP budget and non-blocking worker behavior |

### `origin/main:tests/test_e2e_persistence.py`

| Original function | Current coverage |
| --- | --- |
| `test_restart_keeps_hidden_state_and_patches` | Same Python function retained; S7 |
| `test_fork_carries_state_to_child_scope` | Same Python function retained; S7 |
| `test_db_error_reports_failure_and_noninteractive_aborts` | S12 (real SQLite `query_only` write refusal), W1; core `driver never rounds large integers and normalizes rollback and busy errors` |
| `test_concurrent_writers_stale_rejected_ui_refreshes` | Same Python function retained; C1 |
| `test_concurrent_cas_race_one_winner` | Same Python threaded race retained; C1, C3 |
| `test_three_ui_threads_share_one_db_without_loss` | Same Python threaded test retained; C1, X |
| `test_three_surfaces_interleave_on_same_item` | C1, X, P1 and OMP `session-navigation-3ui.test.ts` service/tool roundtrips |
| `test_three_paths_race_same_rows_consistency` | Retained Python CAS/thread tests plus C1/C3/W3/X cover engine consistency. Exact old CLI + daemon RPC + Python transport harness is not applicable (removed processes); not claimed as a current live three-host race |
| `test_large_snapshot_survives_restart` | Same Python function retained; S4/S7 cover OMP chunk/persistence components |
| `test_cli_db_info_and_fork_scope_json` | CLI subprocess presentation is not applicable. Fork/persistence behavior remains in the retained Python fork test and S7 |

## Verification order and limits

Core Node/Bun **19 each** and OMP **54** passed before deleting the obsolete
evaluation controller. The daemon package/tests were already absent; this step
does not claim to retroactively change the historical deletion order. Final OMP
checks also include the strengthened metadata/empty-ID assertions.

All verification is offline/local: full Python, core Node/Bun, OMP, Paseo,
four conformance/cross-writer checks, evaluation tests, loopback capture, worker
benchmark, vendor parity and whitespace checks. No UI surface changed and no
visual verification was needed. Node 22.13 itself, paid-provider campaigns, and
the exact obsolete three-process transport race were not re-exercised.

Final results (logs under `/Users/devin/nav-phase0-gates/step7-retirement/`):

| Check | Result |
| --- | --- |
| Core typecheck, Node / Bun tests | exit 0; 19 pass / 0 fail on each runtime |
| OMP build, typecheck, tests | exit 0; 54 pass / 0 fail |
| Paseo build, typecheck, tests | embedded worker built; 131 pass / 0 fail plus 8 Node worker tests |
| Python | 351 passed, 11 skipped |
| Node/Bun differential and cross-writer conformance | All four PASS |
| Evaluation offline tests | Ran 40 tests; OK |
| `capture_overhead.ts` | Captured A/B locally; A has no navigation tools, B has all five |
| Worker prepare benchmark | 2,000 / 5,000 / 2,048 records, respectively 2 / 5 / 20 MiB content; all early/late-hide assertions passed |
| `eval/run.py --help` | exit 0; full provider campaign deliberately not run |
| Source/vendor parity | Both source/vendor diffs empty after removing bytecode caches |

`git diff --check` was clean. The core tests passed before deletion and were not
rerun with unchanged inputs. OMP was rerun after strengthening candidate metadata
assertions. The resulting audit map names all 36 original test functions, checked
against the original Python ASTs rather than a manual count alone.
