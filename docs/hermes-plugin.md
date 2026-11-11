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
file; only outgoing request copies change. Unhide restores the original without
rerunning the host tool. The local state file must be shared with a local Paseo
panel for that panel to manage the session; there is no cross-machine sync.
Treat stored originals/backups as sensitive data. Hide is not secure erasure.
The plugin does not add telemetry, read credential files, execute shell commands,
or install software while handling a session.

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
