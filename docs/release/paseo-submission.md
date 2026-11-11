# Paseo registry submission draft

**Draft only. Nothing has been submitted or published.**

Use the [official submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)
so the issue receives the `submission` label. The form supplies Source and
Categories; include the remaining notes in the issue or review PR. Reference:
[publishing guide](https://paseo.sh/docs/plugins/publishing).

## Form fields

- **Title:** Session navigation
- **Source:** `npm:@pureliture/session-navigation-paseo@0.1.0`
  (publish this exact public package first).
- **Categories:** Sidebar (primary), Utils.
- **Requested registry ID:** `pureliture/session-navigation`.
  Please use slug `session-navigation`, not the npm suffix or internal plugin ID.
- **One-sentence description:** Browse, hide, summarize and restore session
  context from Paseo Explorer.
- **Repository:** https://github.com/pureliture/session-navigation
- **Repository directory:** `paseo-plugin/`
- **Version:** 0.1.0
- **Overview:** shipped `OVERVIEW.md`.
- **Maintainer:** pureliture.

## Identity and runtime

The runtime manifest ID remains `paseo-plugin` to preserve existing installed
state. It is independent of the requested registry ID and npm package name.
The package includes MIT LICENSE, its icon, runtime TypeScript sources and
the generated embedded Node worker. It has no installed runtime dependencies;
Paseo-provided libraries are development dependencies. No preparation command,
runtime package download, Python, or unpublished workspace package is needed.

Requirements: Paseo >=0.15.3 (verified 0.15.3), Node >=22.13 on the daemon,
and top-level `pluginsEnabled: true` in daemon configuration followed by restart.
OMP sessions need the matching OMP package with Bun >=1.4.4; Hermes sessions
need the Hermes plugin with Hermes >=0.20.1. Other providers may be display-only.

## Interface images

Existing repository images for the reviewer to compare with the release UI:

- `https://raw.githubusercontent.com/pureliture/session-navigation/<FILL_AFTER_MERGE>/docs/media/01-outline-hero.png`
- `https://raw.githubusercontent.com/pureliture/session-navigation/<FILL_AFTER_MERGE>/docs/media/04-preview-original.png`

Replace the placeholder with the reviewed 40-character SHA and verify public
HTTP 200/image content types. Re-capture with sample data if the images no
longer match the release. The icon alone is insufficient. The manifest's
`media: []` is intentional: the publishing guide also accepts public image
URLs in the submission/review PR, so no mutable URL is baked into the package.

## Data access and limitations

The plugin reads local session history and writes originals, replacements
and hide state to the local SQLite state file documented in the overview.
It changes only outgoing request copies through compatible host adapters;
it neither deletes host history nor securely erases secrets. The selected
original may be sent to the active host model/provider for Summarize.
Local storage does not imply all content remains local.

No telemetry, credential-file access, automatic package installation or
cross-machine state sync is added. Child tab following uses guarded Paseo
0.15.3 UI internals because that version lacks a public child-target SDK API;
unsupported/ambiguous identities fail closed to inline/display-only behavior.
Unmanaged children say **subagent context is not managed**.

After approval, verify `paseo plugin add pureliture/session-navigation` and
a `running` status. Until then, the direct public npm source is the supported
release channel. Registry approval and npm publication have not been performed
as part of this preparation.
