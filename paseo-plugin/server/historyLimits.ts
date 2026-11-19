/**
 * Hard limits for host history loading.
 *
 * The loader materializes the whole session before the service can page it, so
 * peak RSS grows with the source size (measured ~6.7x for OMP JSONL). Beyond
 * these limits the loader fails with an explicit error instead of partial data.
 */
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;
export const MAX_HISTORY_ROWS = 100_000;

export class HistoryTooLargeError extends Error {
  readonly code = "history_too_large";

  constructor(detail: string) {
    super(detail);
    this.name = "HistoryTooLargeError";
  }
}
