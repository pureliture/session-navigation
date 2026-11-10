# Session Navigation for OMP

An npm-style extension for `@oh-my-pi/pi-coding-agent` (tested with 18.18.3).
Hide is deterministic, Summarize uses the session model, and Unhide restores
originals without re-execution. Only outgoing request copies are changed.

## Build and install

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
bun add /absolute/path/to/session-navigation-omp-0.1.0.tgz
omp plugin list
```

Use the appropriate OMP data/plugin directory for an XDG or named-profile
installation. A future published release can use
`omp plugin install @session-navigation/omp@<version>`; this package has not
been published. OMP 18.18.3's installer accepts package names and linked
directories, not local tarball specifications directly.

## Migration from the Python daemon extension

1. Disable/remove the old manually copied
   `~/.omp/agent/extensions/session-navigation.ts` in every affected profile.
2. Install the package and restart OMP. The Python daemon is not launched;
   `SESSION_NAVIGATION_DAEMON` is no longer read.
3. Keep the same `SESSION_NAVIGATION_STATE_PATH` (or XDG/default state path).
   Never delete the existing database. Python remains necessary for Hermes
   and for Paseo until its separate TS integration is completed.

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
synchronization with an old daemon. Paseo's follow-up integration must discover
the new registered scope rather than continue mutating the old `pi:` scope.

## Runtime behavior

SQLite (`bun:sqlite`) runs in a dedicated Bun Worker. Requests serialize;
timeouts/cancellation terminate the worker, invalidate its snapshot generation,
and require a new prepare. Snapshots retain at most 32 sessions. Append requires
the current token, chunks contain at most 64 records / 4 MiB of original UTF-8
text, and duplicate IDs invalidate the snapshot. Client chunks also account for
encoded envelope size and skip individual oversized records.

Pending model work is bounded to four concurrent calls with a shared 25-second
deadline before first-request patches. Cancellation/session switches discard
stale model results; pending settlement uses version CAS. Model failure retains
rule-hide fallback. Headless persistence failures abort; interactive requests
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

The packed real-OMP test uses only a loopback stub provider. Other adapter tests
retain Python CLI/Paseo interoperability as an oracle, so those tests still need
the repository's `.venv`; the installed extension itself does not need Python.
