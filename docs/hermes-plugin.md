# Hermes plugin installation and compatibility

The plugin is version **0.1.0** and requires **Hermes >=0.20.1**.
That is the historical API floor, not live acceptance on every intervening
release. Recorded live checks used Hermes source
`cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`.

## Install

After official catalog approval:

```sh
hermes plugins install session-navigation
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

Until catalog approval, install the public repository at a reviewed commit:

```sh
hermes plugins install pureliture/session-navigation/hermes-plugin --ref <REVIEWED_40_CHAR_SHA> --no-enable
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

Do this in the intended Hermes profile. Host activation and the plugin's
`settings.enabled` are separate; the latter defaults to false. Start a new
session after enabling. Fully restart Hermes **and its gateway** after updating:
a reload cannot replace already imported Python modules.

The catalog distribution unit is `hermes-plugin/`, selected with
`subdir: hermes-plugin` at the pinned repository SHA. It contains only the
manifest, loader, MIT LICENSE and vendor Python packages. The adapter's runtime
equivalent is `vendor/session_navigation_hermes/`; the canonical adapter source
stays in `adapters/hermes/` outside the distribution.

For an existing repository-root installation, stop Hermes/gateway, preserve the
shared SQLite database, remove the old plugin through Hermes's plugin manager,
and install the new subdirectory source. Updating the old root URL alone does
not switch its installation unit. Re-enable the plugin/settings and restart. The Python wheel can be
imported independently but does not automatically register a Hermes plugin.
`python_runtime: external` keeps this repository out of Hermes's shared
buildable workspace; use Hermes's managed Python runtime for host operation.

## Behavior and data

Hide is deterministic. Summarize calls the active session model through public
`ctx.llm.complete`; it may send the selected **whole original** to the configured
provider, subject to the 32,768-byte cap. There is no separate summarization
account or model fallback. Explicit Summarize upgrades a rule Hide, reuses an
accepted summary without another call, and retries factual validation once.
A failed upgrade returns an error and preserves the existing Hide replacement.

Originals, replacements and mutation state are stored in the local SQLite state
file; only outgoing request copies change. When the middleware adds an eligible
`[context-navigation]` note, it also sets `tool_choice` to `manage_context` for
that one outgoing request if the tool is available and no other tool is
explicitly forced. The stored history and the next request are unchanged.
Unhide restores the original without rerunning the host tool. The local state
file must be shared with a local Paseo panel for that panel to manage the
session; there is no cross-machine sync.
Treat stored originals/backups as sensitive data. Hide is not secure erasure.
The plugin does not add telemetry, read credential files, execute shell commands,
or install software while handling a session.

### Pausing Hermes, runtime verification, and multi-profile toggles

- **DB-control-only Pause (Off)**: Pausing Hermes via Paseo Settings updates
  shared SQLite `adapter_control` and `adapter_sessions` atomically in a single
  transaction **without** disabling `settings.enabled` in `config.yaml`.
  Keeping `config.yaml` enabled ensures any legacy Hermes/gateway process
  (whose disabled middleware returns `None`) continues protecting existing
  hidden items, while updated adapters enter `protection_only` via
  `_is_effectively_enabled` + `_protection_only_rewrite` (keeping read/restore
  tools and `/nav` recovery commands active).
- **Strict invocation, position, & branch-alias identity fences**: Both
  `middleware_step` (On) and `_protection_only_rewrite` (Off) check exact
  5-tuple identity first (honoring explicit `visible` state unless ambiguous
  with a branch-alias hidden record) and allow clean `unknown`/`default` alias
  fallback only when the primary scope has no `(call_id, content_sha256)`
  record and no alias conflict exists. When no exact match applies and a hidden
  candidate shares `(call_id, content_sha256)` (e.g., shifted `result_position`,
  mismatched `invocation_digest`, missing invocation, or `unknown`/`default`
  conflict), a redaction placeholder (`[hidden:<item_id> withheld due to
  invocation or scope identity conflict]`) is emitted instead of a mismatched
  summary or raw original.
- **Unverified live-process & frozen-worker limits**: Durable `adapter_sessions`
  rows hold one entry per `scope_key` and cannot enumerate live, stale, or
  duplicate Hermes/gateway OS processes, nor prove frozen workers using
  `PluginContext.get_config` snapshots reloaded updated bundles or paused. Paseo
  always surfaces `protectionVerified: false` with unverified warnings and
  reinstall + full Hermes/gateway restart instructions (plus Outline / `/nav`
  unhide recovery).
- **D9 SQLite fail-open contract**: Because Hermes swallows `llm_request`
  middleware exceptions and provides no request-abort hook, SQLite read/write
  errors during a Hermes request fail open to the original request copy while
  logging an error and surfacing `db_error_pending` (see `adapter_control`
  lookup fail-closed guard for new mutations).
- **Multi-profile YAML writes, lock, journal & rollback**: Both Hermes On and
  Off hold Paseo's fail-closed cooperative lock
  (`~/.hermes/.session-navigation-toggle.lock`, created exclusively with
  `O_CREAT | O_EXCL` and released only by the owning inode/nonce/PID without
  time-based auto-removal; if a previous process crashed, verify no toggle is
  running and remove `~/.hermes/.session-navigation-toggle.lock` manually)
  across YAML writes, SQLite `setAdapterControl`, and journal cleanup. Enabling
  or reconciling across `~/.hermes/config.yaml` and
  `~/.hermes/profiles/*/config.yaml` persists a crash-recovery journal
  (`~/.hermes/.session-navigation-toggle.journal.json`), rejects symlinks,
  parses the full YAML document with the `yaml` Document/CST parser (preserving
  unrelated anchors/aliases, comments, flow maps, block scalars, and `...`
  document-end markers while failing closed in both inspection and toggling on
  duplicate keys, multi-document streams, merge keys, target-spine
  anchors/aliases, or invalid YAML, and verifying post-edit semantic equality for
  all unrelated keys), stages temp files across all targets, checks SHA-256 against concurrent modifications before commit, performs reverse rollback on disk or
  pre-commit SQLite errors, and preserves committed YAML+SQLite state while
  surfacing residual-journal status if post-commit journal cleanup fails. True
  OS-level cross-file atomicity against mid-rename crashes or non-cooperative
  external writers remains impossible.

Registered surfaces:

- Tools: `hide_context`, `summarize_context`, `list_context_items`,
  `unhide_context`, `manage_context`.
- Hooks: `post_api_request`, `subagent_start`.
- Middleware: `llm_request`, `tool_request`.
- Optional system-prompt supervision section and `/nav` command.
- Child scopes stay separate; missing/unsupported child registration is shown
  as **subagent context is not managed** in Paseo.

## Admission and private dependencies

Run the actual host admission check against the subdirectory in a clean
checkout of the release commit:

```sh
hermes plugins validate --install-deps /path/to/session-navigation/hermes-plugin
```

Validation of the committed subdirectory passes with `security scan — safe`.
The unchanged Python policy still produces three medium `sudo_usage` notes
(comment and quoted command-parser literals); medium notes are verdict-neutral.
The repository-wide fixture corpus and TypeScript artifacts are not part of
this Python runtime distribution. No scanner rules or detection strings changed.

The manifest matches actual registrations. Private-import warnings remain
intentionally: `_delivery_manager` counts competing middleware and
`estimate_tokens_rough` supplies host-compatible estimates. Both imports are
guarded; neither has a documented public equivalent. Their fallback is not
feature-identical: a failed manager lookup assumes zero competing middleware,
and token estimation falls back to character-count/4.

Evaluation harnesses and developer probes also import private APIs but are
outside the installed subdirectory and are not loaded or scanned as runtime
plugin files. The two warnings inside the distribution are the vendor adapter
imports; their canonical adapter sources remain identical. See the
[review disclosure](release/hermes-pr-body.md) for all review implications.
A warning-only validator result does not waive the catalog's public-surface
policy or guarantee acceptance.

Canonical engine/adapter sources remain in `src/session_navigation/` and
`adapters/hermes/`. Synchronize with `uv run python tools/sync_hermes_vendor.py`;
verify without writing with `uv run python tools/sync_hermes_vendor.py --check`.
Do not edit vendor copies independently.

For human-facing supervision examples, see
[the Hermes supervision guide](hermes-human-supervision.md).
