# context-hide for pi/omp

## Install

1. Copy `context-hide.ts` to `~/.omp/agent/extensions/` (or project `.omp/extensions/`).
2. Place `pi_context_hide_daemon.py` somewhere on PATH or set `CONTEXT_HIDE_DAEMON` env var (default: sibling file).
3. Ensure Python deps: `pip install context-hide` (and optional `[local-llm]`).

## Usage

- Model calls `hide_context` / `summarize_context` / `unhide_context` / `list_context_items`.
- The extension's `context` event rewrites outgoing tool results to compacted form.
- Restarting pi clears compaction state (process memory); session file keeps originals.
PY
echo done