# 0.1.0 release checklist

**For the publisher to run after review/merge.** These commands are not an
authorization for automation to publish or submit. Preparation has not published
packages, opened a release PR, or contacted either registry/catalog.

## 1. Select the reviewed release

- [ ] Merge the reviewed release-preparation changes first; use an up-to-date,
  clean checkout of that merged commit, not a disposable task branch.
- [ ] Confirm npm ownership/authentication for the `@pureliture` scope with
  `npm whoami`; do not paste tokens into logs or commit npm credentials.
- [ ] Requirements: Bun >=1.4.4; Node >=22.13; verified hosts OMP 18.18.3 and
  Paseo 0.15.3; Hermes >=0.20.1 (API floor, not old-version live acceptance).
- [ ] Back up state and follow the README's daemon-retirement migration.

```sh
git fetch origin main
RELEASE_SHA="$(git rev-parse origin/main)"
test "${#RELEASE_SHA}" -eq 40
git switch --detach "$RELEASE_SHA"
git status --short
RELEASE_DIR="$HOME/session-navigation-release-$RELEASE_SHA"
mkdir -p "$RELEASE_DIR"
```

Confirm this SHA contains all reviewed release-prep changes and no secrets.
Use that same SHA for source review and the Hermes catalog pin. Do not reuse
the pre-preparation `da8fd46` pin.

## 2. Build, test and inspect artifacts

```sh
(cd packages/omp && bun install && npm run typecheck && npm test)
(cd paseo-plugin && npm ci && npm run typecheck && npm run build && npm test)
(cd packages/core && npm test && bun run test:bun)
uv run python tools/sync_hermes_vendor.py --check
uv run pytest
PYTHONPATH=src uv run python tools/core_conformance.py
uv build --out-dir "$RELEASE_DIR/python"
(cd packages/omp && npm pack --dry-run && npm pack --pack-destination "$RELEASE_DIR")
(cd paseo-plugin && npm pack --dry-run --ignore-scripts && npm pack --ignore-scripts --pack-destination "$RELEASE_DIR")
git diff --check
git status --short
hermes plugins validate --install-deps "$PWD/hermes-plugin"
```

- [ ] Investigate any generated-source drift; do not publish stale workers.
- [ ] Inspect both npm tarballs: LICENSE, manifest/entrypoints, bundled OMP
  `dist/extension.js` + `dist/worker.js`, Paseo `server/worker-source.ts`,
  imported local runtime files; no node_modules, scratch, credentials or bytecode.
- [ ] Keep `@session-navigation/core` private/bundled; do not publish it.
- [ ] Verify source/vendor parity and fresh wheel plugin-root/engine/adapter
  imports in an isolated venv. The Python suite includes that packaging smoke.
- [ ] Validate `hermes-plugin/` from a clean clone/archive of the committed SHA,
  not a worktree with build outputs. The catalog entry must retain
  `subdir: hermes-plugin`. Confirm the local Git subdirectory installation loads
  all five tools, two hooks and both middleware callbacks in an isolated home.
- [ ] Review retained runtime private-import warnings; safe scanner output is not a
  waiver of the Hermes catalog's public-surface policy.
- [ ] Use a clean host profile to load the OMP tarball via Bun in its plugin
  dependency directory; OMP 18.18.3 does not install local tarballs directly.
- [ ] Confirm post-publication installation and a running Paseo plugin on a
  disposable daemon; full Node 22.13 daemon/UI acceptance remains unverified.

## 3. Publish npm packages — explicit publisher action

Publish the exact inspected tarballs, not a second uninspected build:

```sh
npm publish "$RELEASE_DIR/pureliture-session-navigation-omp-0.1.0.tgz" --access public
npm publish "$RELEASE_DIR/pureliture-session-navigation-paseo-0.1.0.tgz" --access public
npm view @pureliture/session-navigation-omp@0.1.0 dist.integrity
npm view @pureliture/session-navigation-paseo@0.1.0 dist.integrity
omp plugin install @pureliture/session-navigation-omp@0.1.0
```

Restart OMP and confirm `omp plugin list` and the five tools. In the disposable
Paseo daemon configuration set top-level `pluginsEnabled: true`, restart, then:

```sh
paseo plugin add npm:@pureliture/session-navigation-paseo@0.1.0
paseo plugin ls
```

Require `running` with no error, and verify Explorer, Hide/Summarize/Unhide and
original restoration. A package that merely installs is not UI acceptance.

## 4. Submit Paseo listing — manual form required

- [ ] Fill image SHA placeholders in [the submission draft](paseo-submission.md).
  Compare existing screenshots to the current interface; re-capture with sample
  data if needed. Public URLs must return HTTP 200 and image content types.
- [ ] Open the official form so the submission label triggers intake:

```sh
open 'https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml'
```

Paste the draft's title/source/categories, request slug
`pureliture/session-navigation`, and provide images in the issue/review PR.
There is no documented CLI registry-publish command to substitute for this form.
Do not change runtime ID `paseo-plugin` merely to match the listing.
After human approval:

```sh
paseo plugin add pureliture/session-navigation
paseo plugin ls
```

## 5. Submit Hermes catalog entry — explicit publisher PR

From your writable fork checkout of `NousResearch/hermes-agent`, with this
release checkout's path exported, prepare only the catalog file:

```sh
SESSION_NAVIGATION_REPO=/absolute/path/to/session-navigation
RELEASE_SHA="$(git -C "$SESSION_NAVIGATION_REPO" rev-parse HEAD)"
test "${#RELEASE_SHA}" -eq 40
git switch -c add-session-navigation-0.1.0
sed "s/<FILL_AFTER_MERGE>/$RELEASE_SHA/g" \
  "$SESSION_NAVIGATION_REPO/docs/release/hermes-catalog.yaml" \
  > plugin-catalog/session-navigation.yaml
hermes plugins validate --install-deps "$SESSION_NAVIGATION_REPO/hermes-plugin"
git diff --check
git add plugin-catalog/session-navigation.yaml
git commit -m "Add session-navigation 0.1.0 to catalog"
git push -u origin add-session-navigation-0.1.0
gh pr create --repo NousResearch/hermes-agent --title "Add session-navigation 0.1.0" \
  --body-file "$SESSION_NAVIGATION_REPO/docs/release/hermes-pr-body.md"
```

Attach exact-SHA subdirectory validation and isolated install/load evidence,
and disclose both retained private APIs in the canonical adapter and vendor
mirror. The catalog disables inline README rendering because its runtime-only
subdirectory has no README; `docs_url` links the repository's installation guide.
Wait for CI and maintainer review; never self-mark the entry verified/official.
A maintainer may require public replacements before admission.

After approval/merge, in the intended profile:

```sh
hermes plugins install session-navigation
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

Fully restart Hermes and its gateway. Future updates need another reviewed
40-character SHA-bump PR and `hermes plugins update session-navigation`.

No PyPI publication or separate core publication is required for these channels.
Keep any API keys, npm credentials and private raw evaluation artifacts out of
the source tree and release archives.
