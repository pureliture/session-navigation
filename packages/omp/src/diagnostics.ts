export interface OmpPerfDiagInput {
  op: string;
  duration_ms: number;
  ok: boolean;
  ts?: number;
  queue_wait_ms?: number;
  error_code?: string;
  row_count?: number;
  unit_count?: number;
  chunk_index?: number;
  chunk_count?: number;
  byte_count?: number;
  cache_hit?: boolean;
  timed_out?: boolean;
  invalidated?: boolean;
  slow_threshold_ms?: number;
  include_memory?: boolean;
}

export interface OmpPerfDiagEntry {
  plugin: "omp";
  op: string;
  ts: number;
  duration_ms: number;
  ok: boolean;
  queue_wait_ms?: number;
  error_code?: string;
  row_count?: number;
  unit_count?: number;
  chunk_index?: number;
  chunk_count?: number;
  byte_count?: number;
  cache_hit?: boolean;
  timed_out?: boolean;
  invalidated?: boolean;
  rss_mb?: number;
  heap_used_mb?: number;
}

export const MAX_OMP_PERF_DIAG_ENTRIES = 128;
const DEFAULT_SLOW_MS = 100;
const SAFE_OP_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const ring: OmpPerfDiagEntry[] = [];

export type OmpPerfDiagMode = "off" | "slow" | "verbose";

export function ompPerfDiagMode(): OmpPerfDiagMode {
  const raw = process.env.SESSION_NAVIGATION_PERF_DIAG?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off") return "off";
  if (raw === "slow") return "slow";
  if (raw === "1" || raw === "true" || raw === "verbose" || raw === "debug") {
    return "verbose";
  }
  return "off";
}

export function sanitizeOmpErrorCode(error: unknown): string {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (SAFE_CODE_RE.test(trimmed)) return trimmed.toLowerCase();
    return "error";
  }
  if (error && typeof error === "object") {
    const record = error as { name?: unknown; code?: unknown };
    if (typeof record.code === "string" && SAFE_CODE_RE.test(record.code.trim())) {
      return record.code.trim().toLowerCase();
    }
    if (record.name === "DBFullError") return "db_full";
    if (typeof record.name === "string" && SAFE_CODE_RE.test(record.name.trim())) {
      return record.name.trim().toLowerCase();
    }
  }
  return "error";
}

function finiteNonNeg(value: unknown, roundToTwo = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return roundToTwo ? Math.round(value * 100) / 100 : Math.trunc(value);
}

export function recordOmpPerf(input: OmpPerfDiagInput): OmpPerfDiagEntry {
  const mode = ompPerfDiagMode();
  const durationMs = finiteNonNeg(input.duration_ms, true) ?? 0;
  const queueWaitMs = finiteNonNeg(input.queue_wait_ms, true);
  const ok = Boolean(input.ok);

  const entry: OmpPerfDiagEntry = {
    plugin: "omp",
    op: typeof input.op === "string" && SAFE_OP_RE.test(input.op) ? input.op : "unknown_op",
    ts: finiteNonNeg(input.ts) ?? Date.now(),
    duration_ms: durationMs,
    ok,
  };

  if (queueWaitMs !== undefined) entry.queue_wait_ms = queueWaitMs;
  if (!ok && input.error_code !== undefined) {
    entry.error_code = sanitizeOmpErrorCode(input.error_code);
  }
  const rowCount = finiteNonNeg(input.row_count);
  if (rowCount !== undefined) entry.row_count = rowCount;
  const unitCount = finiteNonNeg(input.unit_count);
  if (unitCount !== undefined) entry.unit_count = unitCount;
  const chunkIndex = finiteNonNeg(input.chunk_index);
  if (chunkIndex !== undefined) entry.chunk_index = chunkIndex;
  const chunkCount = finiteNonNeg(input.chunk_count);
  if (chunkCount !== undefined) entry.chunk_count = chunkCount;
  const byteCount = finiteNonNeg(input.byte_count);
  if (byteCount !== undefined) entry.byte_count = byteCount;
  if (typeof input.cache_hit === "boolean") entry.cache_hit = input.cache_hit;
  if (typeof input.timed_out === "boolean") entry.timed_out = input.timed_out;
  if (typeof input.invalidated === "boolean") entry.invalidated = input.invalidated;

  const slowThreshold = finiteNonNeg(input.slow_threshold_ms) ?? DEFAULT_SLOW_MS;
  const isSlow =
    !ok ||
    Boolean(input.timed_out) ||
    durationMs >= slowThreshold ||
    (queueWaitMs !== undefined && queueWaitMs >= slowThreshold);

  if (input.include_memory || mode !== "off") {
    const mem = process.memoryUsage();
    entry.rss_mb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
    entry.heap_used_mb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  }

  ring.push(entry);
  if (ring.length > MAX_OMP_PERF_DIAG_ENTRIES) {
    ring.splice(0, ring.length - MAX_OMP_PERF_DIAG_ENTRIES);
  }

  if (mode === "verbose" || (mode === "slow" && isSlow)) {
    try {
      process.stderr.write(`[session-nav:perf] ${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostics must never propagate write failures.
    }
  }

  return entry;
}

export function recentOmpPerf(limit = MAX_OMP_PERF_DIAG_ENTRIES): OmpPerfDiagEntry[] {
  const n = Math.max(0, Math.min(MAX_OMP_PERF_DIAG_ENTRIES, Math.trunc(limit)));
  if (n === 0) return [];
  return ring.slice(-n).map((entry) => ({ ...entry }));
}

export function clearOmpPerf(): void {
  ring.length = 0;
}
