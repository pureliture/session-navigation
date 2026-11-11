<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:38bdf8,50:2563eb,100:312e81&amp;height=220&amp;section=header&amp;text=Session%20Navigation&amp;fontSize=52&amp;fontColor=ffffff&amp;animation=fadeIn&amp;fontAlignY=40" alt="Session Navigation" width="100%" />

<h3>Navigate long AI agent sessions,<br/>hide context you no longer need, and restore it when needed</h3>

<p>
  <img src="https://img.shields.io/badge/Paseo-0.15.3-2563eb?style=for-the-badge" alt="Tested with Paseo 0.15.3" />
  <img src="https://img.shields.io/badge/Node-22.13%2B-0e7490?style=for-the-badge&amp;logo=node.js&amp;logoColor=white" alt="Node 22.13 or later for Paseo" />
  <img src="https://img.shields.io/badge/license-MIT-312e81?style=for-the-badge" alt="MIT license" />
</p>

<p><b>English</b> · <a href="docs/README.ko.md">한국어</a></p>

<p>
  <a href="#demo">Demo</a> ·
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#data-and-safety">Data and safety</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#distribution-and-publication">Distribution</a>
</p>

</div>

<img src="https://capsule-render.vercel.app/api?type=rect&amp;color=0:38bdf8,50:2563eb,100:312e81&amp;height=3" width="100%" alt="" />

## What is Session Navigation?

Session Navigation is a host-neutral engine for hiding, summarizing, and restoring context in long AI agent sessions. It works through Paseo's Explorer panel, an OMP (oh-my-pi) extension, and a Hermes plugin. It changes **only the outgoing request copy**; original host history is not deleted.

Install from a source checkout. This does not imply that a release is available on npm, PyPI, or an official plugin catalog. For a reproducible Git installation, use a reviewed commit or release tag.

| Problem | How Session Navigation helps |
| --- | --- |
| Finding a message in a long session | Browse messages and tool results in an outline and jump to a selected item |
| Completed tool results occupy context in the next request | Hide or summarize supported results and inspect the estimated change |
| Hidden details are needed again | Preview the original and replacement, then restore the original |

## Demo

A Paseo session reviewing a small API with OMP and DeepSeek Flash. The outline stays beside the chat, and original messages and tool results are preserved.

![Session navigator outline beside the chat](docs/media/01-outline-hero.png)

**Jump through the conversation:** select an outline row to return to its message, including the first prompt. [Watch MP4](docs/media/outline-jump.mp4).

![Jump from the health-check review back to the first prompt](docs/media/outline-jump.gif)

**Hide and restore a completed tool group:** the footer estimates the reduction in the next request. Unhide restores originals without rerunning tools. `next ≈` is an estimate, not a new measured context reading. [Watch MP4](docs/media/hide-restore.mp4).

![Hide and restore a tool group with the next-request estimate](docs/media/hide-restore.gif)

<details>
<summary>More screenshots: Hide, Preview, and the empty state</summary>

**Selected group after Hide:** the footer estimates `next ≈ −3.9K` tokens.

![Selected hidden group and its next-request estimate](docs/media/02-hide-estimate.png)

**Hidden rows:** the group is collapsed and the saved-context indicator is visible.

![Hidden tool group with its saved-context indicator](docs/media/03-hide-applied.png)

**Read-only Preview:** inspect the outgoing replacement and original input and output. [Original output detail](docs/media/06-preview-output.png).

![Preview of the model-facing replacement and preserved original](docs/media/04-preview-original.png)

**No session in view:** open a session and the outline follows the visible chat.

![Unbound navigator beside a new agent tab](docs/media/05-unbound-empty.png)

</details>

## Features

- Hide, Summarize, and Unhide tool results, with state persisted in SQLite.
- Open **+ → Session navigation** in Paseo Explorer; follow the visible session or pin an agent.
- Compare original content with its model-facing replacement in a read-only Preview.
- Use context tools and the `/session-navigation` UI in OMP, or context tools and `/nav` commands in Hermes.
- Exclude and restore user and assistant messages while preserving the host originals.
- Let the agent clean up completed units of work through repeated `manage_context` calls.
- Append a short candidate/ID hint to request copies on a new user turn and at 50/75/90% context thresholds. The hint is not saved to history; the agent decides when, what, and how to clean up.
- Rule-based Hide retains key assignments and evidence. Use `manage_context(action=hide, keep_lines=[...])` to select original lines to retain. See [behavior and measurement limits](docs/evaluation/improvements.md).
- Show usage supplied by the host, or `—` when unavailable. Estimated changes to the next request are distinct from measured usage.

## Installation

Paseo and OMP use the bundled TypeScript engine; neither requires Python. The Python
engine remains available for Hermes. The former `session-navigation` CLI and
`session-navigation-daemon` entry points have been retired; upgrade host packages
instead of installing standalone CLI executables.

### Paseo plugin

The SDK and runtime were tested with **Paseo 0.15.3**. The manifest accepts `>=0.15.0`, but earlier 0.15.x versions have not been separately tested. The daemon must run **Node >=22.13**. An embedded Node worker ships the core and SQLite driver; no Python package or unpublished workspace dependency is needed.

Install only the Paseo plugin on the daemon host; do not install a Python CLI.
Display works without a host adapter. Hide/Summarize require the OMP extension
or Hermes plugin in the session host. Install from a source checkout:

```bash
paseo plugin add "$PWD/paseo-plugin"
paseo plugin ls
```

Or install the Git folder directly. For reproducibility, use a reviewed commit or release tag instead of `main`. The older `152f63c` commit fails a clean Git installation because a type dependency cannot be resolved.

```bash
paseo plugin add git:pureliture/session-navigation:paseo-plugin --ref main
```

Choose **+ → Session navigation** in Explorer to follow the visible chat session. Keep **Follow visible session** enabled or pin an agent with the selector. Empty, unmatched, or non-session screens show **No session in view**. **Cmd/Ctrl+K → Open session navigation** and **/nav** are also available. Paseo restores open panel layouts; a panel closed by the user is not forcibly reopened. If an old page remains after a plugin reload, refresh the entire page.

### OMP (oh-my-pi) extension

Tested with `@oh-my-pi/pi-coding-agent` **18.18.3**. Build the npm-style extension, then install its directory through OMP:

```bash
(cd packages/omp && bun install)
bun run packages/omp/build.ts
omp plugin install "$PWD/packages/omp"
```

Restart OMP. To load the built package once without installing:

```bash
omp --extension "$PWD/packages/omp"
```

For a packed local archive, run `bun pm pack` in `packages/omp`, then
`bun add /absolute/path/to/session-navigation-omp-0.1.0.tgz` in `~/.omp/plugins` (create
that directory first). Restart OMP and check `omp plugin list`. OMP 18.18.3
does **not** accept local tarballs via `omp plugin install`. A future registry
release can use `omp plugin install @pureliture/session-navigation-omp@<version>`; the
package is not currently published.

Before migrating, remove/disable the old manually copied
`~/.omp/agent/extensions/session-navigation.ts` in every affected profile; an
old Python-spawning copy cannot participate in the new duplicate-load guard.
The repository's `extensions/pi/session-navigation.ts` is now a thin development
shim, not a standalone file to copy. `SESSION_NAVIGATION_DAEMON` is no longer used.

See [OMP packaging and migration](packages/omp/README.md) for packed-archive installation, preserved `pi:` state import into `omp:` scopes and test commands. The shared core is bundled; no unpublished workspace dependency is needed. Compatibility with upstream **pi** has not been tested.

### Hermes plugin

Live ACP verification used Hermes source commit `cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8` (earlier plugin tests used `109fd8161a509db5a00942152ba48882e446e8b0`). The repository-root `plugin.yaml`, `__init__.py`, and `vendor/` form a standalone Python plugin. Hermes requires Python through its own managed runtime; Paseo and OMP do not. No shared CLI installation is needed.

```bash
hermes plugins install pureliture/session-navigation --ref main --no-enable
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

Install and enable it in the intended Hermes profile. For a pinned installation, replace `--ref main` with a reviewed **40-character commit SHA**. Host-level plugin activation and the plugin's `settings.enabled` are separate. The latter defaults to `false`: until enabled, tools return `disabled` and do not record or modify requests. Start a new session after configuration. If a gateway is running, follow the host's restart instructions.

`vendor/` contains the engine and adapter's Python source. With `python_runtime: external`, the repository's `pyproject.toml` is not installed into Hermes's shared environment. Installing a Python wheel alone does not register the Hermes plugin.

After updating, restart any running **Hermes gateway completely**, as well as reopening the CLI. Plugin reload does not clear Python's global `session_navigation` / `session_navigation_hermes` module cache. If the fingerprint of already loaded engine or adapter source differs from the deployed vendor copy, the plugin refuses to load and asks for a restart. Other versions installed in the shared environment are subject to the same check; the plugin does not forcibly replace those modules. Official catalog validation has not yet passed; see [distribution](#hermes-repository-root-to-the-sha-pinned-official-catalog).

### Upgrade / migration

1. Stop affected OMP/Hermes sessions and back up the existing SQLite state.
   Keep `SESSION_NAVIGATION_STATE_PATH` unchanged (or retain the default/XDG path).
   Do not delete the database or host history.
2. Remove the legacy manually copied OMP extension described above, including
   copies in named profiles. Install the npm-style OMP package, update the Paseo
   plugin, and restart OMP/Paseo. Remove obsolete daemon-path overrides.
3. Remove the retired standalone tool installation, if present:
   ```bash
   uv tool uninstall session-navigation
   ```
   This removes both the old `session-navigation` CLI and
   `session-navigation-daemon` executable from that uv tool installation.
   This is a migration command for an existing installation, not a prerequisite
   for new users. It does not replace installing/enabling the Hermes plugin.
4. Fully restart Hermes and its gateway after updating the Python plugin.
   Relist items: OMP imports legacy `pi:` state into an empty `omp:` scope once,
   preserving the old rows. Later writes are not synchronized back; item IDs are
   scope-specific. Do not run an old Python-spawning extension alongside the new one.

## Usage

In Paseo, use Hide / Summarize / Unhide on rows and inspect originals and replacements in Preview. OMP's `/session-navigation` opens an interactive list. In Hermes, use these commands in the same conversation:

```text
/nav list
/nav messages
/nav hide 1
/nav unhide 1
/nav hide-msg 1
/nav unhide-msg 1
```

Numbers are display numbers from the most recent list. See the [human supervision guide](docs/hermes-human-supervision.md) for Hermes numbering and restore rules.

After completing a unit of work, the agent can select results that are no longer needed for the next step:

```text
list_context_items({view: "candidates", limit: 30})
manage_context({tool_call_ids: ["selected-id-1", "selected-id-2"], action: "hide"})
```

- A nonempty list of IDs is required, with no count limit. This is not a tool for summarizing an entire session at once.
- The candidate list is a discovery tool that shows visible eligible results newest first. Eligible IDs outside the list can also be selected.
- `hide` is rule-based, `summarize` uses the current session model, and `auto` prefers model summarization with a rule-based fallback. OMP runs at most four model calls concurrently and first excludes hidden or ineligible results.
- OMP manages `read` / `bash` results; Hermes manages permitted `terminal` / `read_file` / `search_files` results. Destructive commands are excluded from automatic management. Without a session model, summarization fails with `summarizer_unavailable`.

## Data and safety

### Subagent support

| Provider | Paseo outline and controls |
| --- | --- |
| OMP via Paseo | Child tab following and expandable inline child outlines under the parent task; Hide/Unhide/Summarize use each child's scope and capabilities. **Open tab** focuses or opens the native child tab. |
| Hermes via ACP | Expandable inline child outlines under `delegate_task`, with child-scoped Hide/Unhide/Summarize. No native child tab. Selecting a child row highlights it without navigating. |
| Others, e.g. OpenCode Go; unregistered children | Display-only main outline and **subagent context is not managed**. Selecting a row opens the main agent and scrolls there. |

Child-tab identification/opening relies on **Paseo 0.15.3 UI internals** isolated
in `client/hostCompat.ts`. Known untested host versions, ambiguous/malformed tabs,
or missing child registrations fall back safely. When version metadata is absent,
the guarded DOM shape is required; no public SDK child-target API exists in 0.15.3.
If opening a child tab fails, the inline outline remains available. Children have
separate state; navigation tools/guidance/reminders are not exposed to them by default.
See [backend evidence](docs/subagent-backend-verification.md).

- Original host history remains intact; only the request copy changes. **Hide is not a permanent deletion or secret-erasure feature.**
- Originals, replacements, and hide state are stored by default in `~/.local/share/session-navigation/state.sqlite3`. Override the location with `XDG_DATA_HOME` or `SESSION_NAVIGATION_STATE_PATH`. Processes sharing state must use the same path on the same machine.
- The plugin reads local session history and model metadata to build lists. Paseo uses an embedded Node Worker; OMP uses a Bun Worker. Both run the shared TypeScript core off the host event loop. There is no network synchronization, self-update or runtime software download.
- Summarization may send selected original content to the **session model provider configured in the host**. Local SQLite storage does not mean all data stays local.
- DB error behavior differs by host. OMP non-interactive execution stops the request. Hermes middleware has no abort contract, so the original request may proceed on error; error logs and pending notices in lists signal the issue. Do not use this as a sensitive-data blocking tool.
- WAL is used with SQLite 3.51.3 or later or the fixed 3.44.6/3.50.7 lines; other versions use a rollback journal.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/session_navigation/` | Python engine and SQLite store used by Hermes |
| `packages/core/` | Shared TypeScript engine and Node/Bun SQLite drivers |
| `packages/omp/` | Bundled OMP extension, worker service, tools and UI |
| `extensions/pi/session-navigation.ts` | Thin legacy development shim |
| `paseo-plugin/` | Paseo client panel, capability-gated server RPC and embedded Node worker |
| `adapters/hermes/` | Hermes tools, middleware, `/nav`, and usage footer |
| `plugin.yaml`, `__init__.py`, `vendor/` | Hermes-loadable distribution root and pinned source copies |

## Development and testing

```bash
uv sync --frozen --dev
uv run pytest
bun run packages/omp/build.ts
bun test packages/omp/test
cd paseo-plugin
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
```

Check Python distributions with `uv build` from the root and Paseo package contents with `npm pack --dry-run --ignore-scripts` in `paseo-plugin/`. After changing the core or Paseo worker/service, run `npm run build` in `paseo-plugin/` and commit the generated embedded worker before release.

Update the Hermes `vendor/` copies with their sources: check Python source parity between `src/session_navigation/` and `vendor/session_navigation/`, and between `adapters/hermes/` and `vendor/session_navigation_hermes/`. The Python package builds as wheel/sdist, but PyPI publication is not automated.

## Distribution and publication

These are **publisher procedures**, not a claim that the project is already listed. Release a merged commit or tag rather than a disposable task branch. The repository currently has no GitHub Actions workflow for automated tests or releases.

### Paseo: Git folder or npm to the reviewed registry

1. The recommended initial artifact is the public GitHub repository's `paseo-plugin/` folder. It contains the manifest, TS entry points, imported sources, and icon. Verify a clean Git installation at the commit being released; direct installation of `152f63c` fails with a type dependency error.
2. The manifest currently has `media: []` and the plugin folder contains only an icon. Supply an **actual UI screenshot** inside the package or a public PNG/JPG URL in the submission or review PR. Existing screenshots are in [docs/media](docs/media/).
3. For npm, remove `private: true` from `paseo-plugin/package.json`, choose a package name/scope you can publish, set a release version and GitHub `repository`, and include the MIT LICENSE. The current dry run does not include LICENSE.
4. Run type checking, tests, and `npm pack --dry-run --ignore-scripts`; only for the npm route, run `npm publish --access public`. Verify the published version on a test daemon. Host-provided libraries remain devDependencies; new runtime dependencies must satisfy the official lock/shrinkwrap requirements.
5. Submit the GitHub folder URL and reviewed commit, or npm package and version, through the [official submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml). After review and approval, users can install with `paseo plugin add owner/slug`.

See the [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing) and [review policy](https://github.com/getpaseo/plugins/blob/main/REVIEW.md). The English listing uses [OVERVIEW.md](paseo-plugin/OVERVIEW.md).

### OMP: npm-style package

1. Build and pack `packages/omp` with `bun pm pack`. The archive bundles the core and worker, declares `omp.extensions: ["./index.ts"]`, and is tested in an isolated OMP home against a local stub provider.
2. The package is not yet published. After review, a publisher can publish the built archive; users can then use `omp plugin install @pureliture/session-navigation-omp@<version>`. Python is not an OMP runtime prerequisite.
3. An OMP marketplace is a Git catalog containing `.omp-plugin/marketplace.json` or `.claude-plugin/marketplace.json`. Add an entry pointing to the plugin folder; users add it with `omp plugin marketplace add <catalog-source>` and install with `omp plugin install <name>@<marketplace>`. This repository does not yet contain a catalog. npm sources in marketplace entries are not currently supported; use Git or relative paths.
4. npm plugin installation and Git marketplace installation are separate routes. No mandatory review process for a single central OMP marketplace was identified in the official documentation. Verify API compatibility before distributing for upstream pi.
5. A separately verified upstream pi package can declare `pi.extensions` and `keywords: ["pi-package"]` and be published on npm. The keyword makes it eligible for the official [Pi package gallery](https://pi.dev/packages); users install with `pi install npm:<package-name>@<version>`. The current OMP extension has not been established as compatible or packaged for that route.

Official references: [extension authoring and manifest](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md), [plugin installation](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md), [marketplace format](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md), and the separate upstream [pi package documentation](https://pi.dev/docs/latest/packages). The latter does not guarantee OMP compatibility.

### Hermes: repository root to the SHA-pinned official catalog

1. The public repository root is the distribution unit. This is not an npm package or Python wheel uploaded to the Hermes registry.
2. **Current catalog blocker:** `plugin.yaml` omits `provides_hooks: [post_api_request]` and `provides_middleware: [llm_request]`, although the plugin registers them, so `hermes plugins validate .` fails. The manifest has not yet been corrected; private core import warnings also require review.
3. Correct the declarations and supported-version information, then pass the official validation at the release commit: `hermes plugins validate /path/to/session-navigation --install-deps`. The prior check used basic validation without installing dependencies.
4. Open a PR adding `plugin-catalog/session-navigation.yaml` to `NousResearch/hermes-agent`. Declare the public repository URL, **40-character SHA**, description, maintainer, and actual tool/hook/middleware capabilities. If declaring `requires_hermes`, match the manifest to a verified SemVer range.
5. After catalog CI and maintainer review and merge, install with `hermes plugins install session-navigation`. Updates require a PR pinning the new SHA and `hermes plugins update session-navigation`.

Official references: [catalog policy and entry schema](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/README.md), [submission process](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/catalog-submission.md), and [plugin API and dependencies](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/index.md).

## Evaluation

Evaluation methods and summaries are public, but raw run artifacts are stored in the private `eval/results/` submodule and require access. It is not needed for ordinary installation or tests. See the [evaluation guide](eval/README.md) for access and how to store new results.

**Less context, without deleting history—not a claim of smarter answers.**

- Tool results accounted for roughly **70–81% of outgoing prompt tokens** in our captured runs. For external context, JetBrains/TUM reports approximately [84% observation tokens](https://kairos.jetbrains.com/research/articles/the-complexity-trap) in its SWE-agent sample; the populations differ. [Measurement details](docs/evaluation/context-share.md).
- **v4:** the plugin removed **53–66% of final-request tool-result tokens** without measured task-quality loss: **4/4 in every host/arm group**, on both final-only and visible-unit checks. [Results and limitations](docs/evaluation/results-v3.md).
- **Synthetic focus replay:** rule-hidden histories used approximately **97–98% fewer prompt tokens**, with no statistically significant accuracy difference: short **15/15 vs 15/15**, long **14/15 Hide vs 15/15 RAW** (five seeds). The one miss attempted recovery instead of answering. Hidden-only details were **0/30 without recovery**; they must be unhidden to become available again. [Full results, paired statistics and caveats](docs/evaluation/results-focus.md).
- **Live OMP, no native compaction:** **3/3 vs 3/3**, with **54% fewer aggregate B prompt tokens**. This small autonomous comparison is **not causal**; only two of three B sessions actually cleaned. [Live results](docs/evaluation/results-focus.md#part-b-live-omp-native-compaction-disabled).

Originals remain preserved. Rule Hide retains key lines, Unhide restores originals without re-executing tools, and user-visible controls/preview span **OMP, Hermes and Paseo**. Retention is not complete recall: inspect or recover details as needed.

We do **not** claim improved accuracy or guaranteed cost savings. Observed OMP DeepSeek cost differences ranged from **+77% in v2 to −7% in v4**. Every edit invalidates the prompt-cache prefix from its first changed position onward; batching can mitigate, not eliminate, that overhead. [v2 failures/costs](docs/evaluation/results-v2.md) · [v4 costs](docs/evaluation/results-v3.md) · [reproduction harness](eval/README.md) · [earlier v1 results](docs/evaluation/results.md).

## Contributing

Bug reports should include the host/version, reproduction steps, expected behavior, and logs with sensitive data removed. Add relevant tests to code PRs and synchronize vendor copies when changing Python adapters. Modifying or permanently deleting another host's original history is outside the project's safety boundary. Use sample data for UI screenshots and confirm that images are safe to publish. Sample screenshots appear in the [navigator usability evaluation](docs/evaluation/navigator-usability.md).

## License

[MIT](LICENSE). Host projects and dependencies retain their own licenses.
