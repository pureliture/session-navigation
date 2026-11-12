# Session Navigation for OMP

An npm-style extension for `@oh-my-pi/pi-coding-agent` (tested with 18.18.3).
Hide is deterministic, Summarize uses the session model, and Unhide restores
originals without re-execution. Only outgoing request copies are changed.

## Install

Requires **Bun >=1.4.4** (1.4.4 is tested; older Bun releases are unverified).
OMP가 실제로 로드한 SQLite **3.51.3 이상**이 필요합니다. 상태 DB가 DELETE
모드여도 같은 기준을 적용합니다. WAL 수정이 백포트된 SQLite 3.44.6과 3.50.7도
이 최소 버전 정책에서는 허용하지 않습니다. 버전을 확인할 수 없거나 지원하지
않으면 session-navigation은 활성화되지 않으며 모델 요청을 차단합니다. 이전에
숨긴 컨텍스트를 동의 없이 원문으로 전송하지 않기 위한 동작입니다.
macOS에서 Bun은 기본적으로 시스템 SQLite를 사용합니다. 새 SQLite를 설치하는
것만으로는 선택되지 않으며, OMP가 첫 SQLite DB를 열기 전에 지정해야 합니다.
session-navigation Worker에서는 나중에 바꿀 수 없습니다. 플랫폼별 동작은
https://bun.sh/docs/runtime/sqlite 를 참조하세요.
After npm publication:

```sh
omp plugin install @pureliture/session-navigation-omp@0.1.0
```

This release preparation does not claim npm publication has occurred.

## Build and install from source

From a checkout with Bun installed:

```sh
bun run packages/omp/build.ts
cd packages/omp
bun pm pack
```

The archive contains `index.ts`, bundled `dist/extension.js`, and bundled
`dist/worker.js`. The shared core is included in the worker; no unpublished
workspace dependency, Python executable, or native addon is required. Host
`@oh-my-pi/*` imports remain external. `prepack` rebuilds both artifacts.

For development, use `omp plugin install /absolute/path/to/packages/omp` after
building (OMP links local directories). For an archive, install it with Bun
into OMP's plugin dependency directory, then restart OMP:

```sh
mkdir -p "$HOME/.omp/plugins"
cd "$HOME/.omp/plugins"
bun add /absolute/path/to/pureliture-session-navigation-omp-0.1.0.tgz
omp plugin list
```

Use the appropriate OMP data/plugin directory for an XDG or named-profile
installation. OMP 18.18.3's installer accepts package names and linked
directories, not local tarball specifications directly.

## Migration from the Python daemon extension

1. Disable/remove the old manually copied
   `~/.omp/agent/extensions/session-navigation.ts` in every affected profile.
2. Install the package and restart OMP. The Python daemon is not launched;
   `SESSION_NAVIGATION_DAEMON` is no longer read.
3. Keep the same `SESSION_NAVIGATION_STATE_PATH` (or XDG/default state path).
   Never delete the existing database. Python remains necessary only for Hermes;
   Paseo also uses the bundled TS core. If the standalone tool was installed,
   remove it with `uv tool uninstall session-navigation` after migration.
   This removes both the old CLI and `session-navigation-daemon` executable
   from that uv tool installation; it does not uninstall the Hermes plugin.

The repository path `extensions/pi/session-navigation.ts` remains a thin
development shim. Build the package first; do not copy that relative-import
shim into an autoload directory. The updated shim and packed extension share
a process-global registration guard: the first loaded instance owns tools and
hooks, the second disables itself. An old, already-copied Python-spawning
extension cannot participate in this guard and **must be removed manually**.

Scopes are now `omp:default:<session>:default`, matching the `omp` adapter
registration. On the first valid prepare, an otherwise empty new scope copies
its legacy `pi:default:<session>:default` state, including hidden messages,
pending summaries and identity fences. Original legacy rows are preserved;
later mutations affect the `omp:` scope only. Old item IDs belong to the old
scope; relist to obtain new IDs. This is a one-time import, not bidirectional
synchronization with an old daemon. Paseo discovers the new registered `omp:`
scope; legacy `pi:` scopes remain display/Unhide-only.

## Runtime behavior

SQLite (`bun:sqlite`) runs in a dedicated Bun Worker. Requests serialize;
timeouts/cancellation terminate the worker, invalidate its snapshot generation,
and require a new prepare. Snapshots retain at most 32 sessions. Append requires
the current token, chunks contain at most 64 records / 4 MiB of original UTF-8
text, and duplicate IDs invalidate the snapshot. Client chunks also account for
encoded envelope size and skip individual oversized records.

Pending model work is bounded to four concurrent calls with a shared 25-second
deadline before first-request patches. Cancellation/session switches discard
stale model results; pending settlement uses version CAS. Automatic pending work
may fall back to deterministic Hide. Explicit Summarize is different: it upgrades
an existing rule Hide to an accepted LLM summary, reuses an accepted summary
without another call, and retries factual validation once with English feedback.
If that upgrade fails, it returns an explicit error and keeps the existing Hide
replacement. Both attempts count in usage; Unhide still restores the original.
Headless persistence failures abort; interactive requests
require an explicit abort/originals choice. Heartbeats are published only after
valid session processing; freshness is informational. DELETE remains the default
journal mode under the shared contract.

Five tools, optional boundary reminders and the `/session-navigation` overlay
are retained. No automatic target selection or forced cleanup is introduced.

Subagents are intentionally unsupported. At `session_start`, one centralized
`ctx.agent.kind === "sub"` gate prevents activation entirely, including depth-zero
clones/advisors: no tools, rewrite hooks, reminders, worker or database writes.
Tool registration is deferred until this identity is available; subagents do not
claim the duplicate-instance guard or interfere with the main session.

## Development checks

Install package development dependencies for host API types, then:

```sh
npm run typecheck
bun run build.ts
bun test test
```

The packed real-OMP test uses only a loopback stub provider. Adapter tests use
the TS service and Paseo integration. The separate cross-engine conformance
harness uses the repository's Python engine as an oracle; only that harness
and Hermes/Python tests need `.venv`, not the installed extension.
