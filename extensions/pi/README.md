# Legacy OMP development path

The implementation and tests now live in [packages/omp](../../packages/omp/README.md).
The Python engine is retained for Hermes and as a conformance oracle; the old
CLI/daemon entry points are removed. OMP neither spawns them nor reads
`SESSION_NAVIGATION_DAEMON`.

Build with `bun run packages/omp/build.ts`, then install `packages/omp` through
OMP's plugin installer. This directory's `session-navigation.ts` remains a thin
relative-import development shim; **do not copy it** into an autoload directory.

Remove any previously copied Python-spawning extension before installing the
package, in every affected profile, and restart OMP. The updated shim and package
share a duplicate-load guard, but old copied versions cannot participate.
Existing `pi:` state is preserved and imported into `omp:` scopes on first valid
processing; see the package migration notes before mixing old and new surfaces.

Run adapter tests with `bun test packages/omp/test` after building. Main-session
tools and request-copy projection remain available. Subagents are intentionally
inert: no tools, rewriting, reminders, workers or database writes.
