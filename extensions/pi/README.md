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
## Summarizer config (env vars)

Set these before launching omp (or in your shell profile):

```bash
export CONTEXT_HIDE_BASE_URL=http://127.0.0.1:12347
export CONTEXT_HIDE_MODEL=mlx-community/LFM3-1.7B-OptiQ-4bit
export CONTEXT_HIDE_TIMEOUT=60          # optional
export CONTEXT_HIDE_MAX_INPUT_BYTES=12288  # optional
export CONTEXT_HIDE_MAX_OUTPUT_TOKENS=384  # optional
```

Without these, `summarize_context` returns `summarizer_unavailable`; `hide_context` (deterministic) still works.
