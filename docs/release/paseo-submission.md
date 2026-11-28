# Paseo registry submission draft — Git source

**Draft only.** Nothing has been pushed, published to npm, or submitted to `getpaseo/plugins`.

Submit through the official template so the issue receives the `submission` label:
`https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml`
Reference: `https://paseo.sh/docs/plugins/publishing`.

> Submitting the form opens an automated review request (`submissions/<issue>.json`). Actual catalog listing (`paseo plugin add pureliture/session-navigation`) happens only after a `getpaseo/plugins` maintainer completes review under `REVIEW.md` and merges the PR.

## Form fields

- **Title:** `Session navigation`
- **Source:** `https://github.com/pureliture/session-navigation/tree/<FILL_AFTER_MERGE>/paseo-plugin`
  - Replace `<FILL_AFTER_MERGE>` with the final 40-character public `origin/main` SHA after the release candidate is merged and pushed.
  - Git subdirectory source needs no npm publication. The public repository must expose the pinned commit.
- **Categories (first is primary):** `Workspaces`, `Utils`. The plugin registers workspace/agent Explorer panels, a `/nav` command, command-center entry and settings screen; it does not register sidebar header/footer items.
- **Requested registry ID:** `pureliture/session-navigation` (override the directory-derived default `paseo-plugin` slug).
- **One-sentence description:** `Browse, hide, summarize and restore session context from Paseo Explorer (Node >=22.13; no Python required).`
- **Repository / directory:** `https://github.com/pureliture/session-navigation`, `paseo-plugin/`
- **Version:** `0.1.0`. **Overview:** shipped `paseo-plugin/OVERVIEW.md`. **Maintainer:** `pureliture`.

## Interface images

Replace the placeholder with the final reviewed SHA and verify public HTTP 200 / `image/png` before submitting:

- `https://raw.githubusercontent.com/pureliture/session-navigation/<FILL_AFTER_MERGE>/docs/media/01-outline-hero.png`
- `https://raw.githubusercontent.com/pureliture/session-navigation/<FILL_AFTER_MERGE>/docs/media/04-preview-original.png`

The images were refreshed from an isolated Paseo 0.18.1 sandbox using synthetic workspaces, actor IDs, and messages. The first shows the current four-button header beside the matching chat and outline; the second shows a hidden message, its original preview, and the Unhide control. `paseo-plugin.json` keeps `"media": []` intentionally; image URLs belong in the submission/review PR.

## Distribution, runtime and data access

- Runtime manifest ID remains `paseo-plugin` to preserve installed state; it is independent of the requested registry ID.
- `server/worker-source.ts` embeds the Node worker, engine and YAML parser. Runtime npm dependencies are zero; `yaml` is a development dependency only. No `build` step, sibling workspace package, runtime download or Python installation is needed.
- Verified with Paseo `0.18.1` in isolated daemons: Git subdirectory installation reached `status: "running"` without a private-submodule credential prompt (`.gitmodules` uses `update = none`); the final candidate list RPC rendered the matching synthetic session and outline. A Hide/Unhide round trip moved versions 13 → 14 → 15 and restored the original bytes and SHA-256 exactly. Current candidate tests: plugin `314 pass / 0 fail`, Node lifecycle `17 pass / 0 fail`; the worker was regenerated from the candidate source.
- Reads local session history; writes originals, replacements and hide state to the local SQLite state file (`SESSION_NAVIGATION_STATE_PATH` or XDG data home). Hide is reversible, not secret erasure; Summarize may send the selected original to the configured host model provider.
- No telemetry, credential-file read, runtime package installation or cross-machine sync. Active-tab following uses guarded Paseo UI internals and fails closed on unsupported versions.

## Reviewer comment (paste after form submission)

```markdown
### Submission notes for reviewer

- Requested registry ID: `pureliture/session-navigation` (override directory-derived slug).
- Categories: `Workspaces` (primary), `Utils`.
- Git source: `paseo-plugin/` at the final pinned `origin/main` SHA; no npm publication required.
- Node `>=22.13`, zero runtime npm dependencies, no Python; embedded worker is in `server/worker-source.ts`.
- Screenshots use synthetic sample data and are pinned to the final SHA (see URLs above).
- Local SQLite state only; reversible hide/summarize; no telemetry or credential-file access.
```

## Blockers before submission

1. Current UI images are captured and committed locally. After the release candidate is merged and pushed to `origin/main`, replace the SHA placeholder and re-check image URLs.
2. No external `getpaseo/plugins` issue or PR has been opened.
3. npm publication remains optional and unauthenticated (`npm whoami` was previously 401); no publish was attempted.

After the final SHA is known, replace `<FILL_AFTER_MERGE>` in Source, both image URLs and the reviewer comment, then verify each image URL with `curl -sSI`.
