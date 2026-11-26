export type PerfAdapterKind = "omp" | "hermes" | "unknown";
export type PerfLaneKind = "read" | "write" | "worker" | "direct";

export interface PerfDiagInput {
  op: string;
  duration_ms: number;
  ok: boolean;
  ts?: number;
  queue_wait_ms?: number;
  error_code?: string;
  adapter?: PerfAdapterKind;
  lane?: PerfLaneKind;
  row_count?: number;
  hydrated_count?: number;
  page_size?: number;
  candidate_count?: number;
  scope_count?: number;
  byte_count?: number;
  cache_hit?: boolean;
  coalesced?: boolean;
  chunk_index?: number;
  slow_threshold_ms?: number;
  include_memory?: boolean;
}

export interface PerfDiagEntry {
  plugin: "paseo-server";
  op: string;
  ts: number;
  duration_ms: number;
  ok: boolean;
  queue_wait_ms?: number;
  error_code?: string;
  adapter?: PerfAdapterKind;
  lane?: PerfLaneKind;
  row_count?: number;
  hydrated_count?: number;
  page_size?: number;
  candidate_count?: number;
  scope_count?: number;
  byte_count?: number;
  cache_hit?: boolean;
  coalesced?: boolean;
  chunk_index?: number;
  rss_mb?: number;
  heap_used_mb?: number;
}

export const MAX_PERF_DIAG_ENTRIES = 128;
const DEFAULT_SLOW_MS = 100;
const SAFE_OP_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const ring: PerfDiagEntry[] = [];

export type PerfDiagMode = "off" | "slow" | "verbose";

export function perfDiagMode(): PerfDiagMode {
  const raw = process.env.SESSION_NAVIGATION_PERF_DIAG?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off") return "off";
  if (raw === "slow") return "slow";
  if (raw === "1" || raw === "true" || raw === "verbose" || raw === "debug") {
    return "verbose";
  }
  return "off";
}

export function scopeAdapterKind(scope?: unknown): PerfAdapterKind {
  if (typeof scope !== "string") return "unknown";
  if (scope.startsWith("omp:")) return "omp";
  if (scope.startsWith("hermes:")) return "hermes";
  return "unknown";
}

export function sanitizeErrorCode(error: unknown): string {
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
    if (record.name === "HistoryTooLargeError") return "history_too_large";
    if (record.name === "DBFullError") return "db_full";
    if (typeof record.name === "string" && SAFE_CODE_RE.test(record.name.trim())) {
      return record.name.trim().toLowerCase();
    }
  }
  return "error";
}

function finiteNonNeg(value: unknown, roundToTwoDecimals = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return roundToTwoDecimals ? Math.round(value * 100) / 100 : Math.trunc(value);
}

function sanitizeOp(op: unknown): string {
  if (typeof op === "string" && SAFE_OP_RE.test(op)) return op;
  return "unknown_op";
}

function sanitizeAdapter(adapter: unknown): PerfAdapterKind | undefined {
  if (adapter === "omp" || adapter === "hermes" || adapter === "unknown") return adapter;
  return undefined;
}

function sanitizeLane(lane: unknown): PerfLaneKind | undefined {
  if (lane === "read" || lane === "write" || lane === "worker" || lane === "direct") return lane;
  return undefined;
}

export function recordServerPerf(input: PerfDiagInput): PerfDiagEntry {
  const mode = perfDiagMode();
  const durationMs = finiteNonNeg(input.duration_ms, true) ?? 0;
  const queueWaitMs = finiteNonNeg(input.queue_wait_ms, true);
  const ok = Boolean(input.ok);

  const entry: PerfDiagEntry = {
    plugin: "paseo-server",
    op: sanitizeOp(input.op),
    ts: finiteNonNeg(input.ts) ?? Date.now(),
    duration_ms: durationMs,
    ok,
  };

  if (queueWaitMs !== undefined) entry.queue_wait_ms = queueWaitMs;
  if (!ok && input.error_code !== undefined) {
    entry.error_code = sanitizeErrorCode(input.error_code);
  }
  const adapter = sanitizeAdapter(input.adapter);
  if (adapter) entry.adapter = adapter;
  const lane = sanitizeLane(input.lane);
  if (lane) entry.lane = lane;

  const rowCount = finiteNonNeg(input.row_count);
  if (rowCount !== undefined) entry.row_count = rowCount;
  const hydratedCount = finiteNonNeg(input.hydrated_count);
  if (hydratedCount !== undefined) entry.hydrated_count = hydratedCount;
  const pageSize = finiteNonNeg(input.page_size);
  if (pageSize !== undefined) entry.page_size = pageSize;
  const candidateCount = finiteNonNeg(input.candidate_count);
  if (candidateCount !== undefined) entry.candidate_count = candidateCount;
  const scopeCount = finiteNonNeg(input.scope_count);
  if (scopeCount !== undefined) entry.scope_count = scopeCount;
  const byteCount = finiteNonNeg(input.byte_count);
  if (byteCount !== undefined) entry.byte_count = byteCount;
  if (typeof input.cache_hit === "boolean") entry.cache_hit = input.cache_hit;
  if (typeof input.coalesced === "boolean") entry.coalesced = input.coalesced;
  const chunkIndex = finiteNonNeg(input.chunk_index);
  if (chunkIndex !== undefined) entry.chunk_index = chunkIndex;

  const slowThreshold = finiteNonNeg(input.slow_threshold_ms) ?? DEFAULT_SLOW_MS;
  const isSlow =
    !ok ||
    durationMs >= slowThreshold ||
    (queueWaitMs !== undefined && queueWaitMs >= slowThreshold);

  if (input.include_memory || mode !== "off") {
    const mem = process.memoryUsage();
    entry.rss_mb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
    entry.heap_used_mb = Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  }

  ring.push(entry);
  if (ring.length > MAX_PERF_DIAG_ENTRIES) {
    ring.splice(0, ring.length - MAX_PERF_DIAG_ENTRIES);
  }

  if (mode === "verbose" || (mode === "slow" && isSlow)) {
    try {
      process.stderr.write(`[session-nav:perf] ${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostic logging must never fail the caller.
    }
  }

  return entry;
}

export function recentServerPerf(limit = MAX_PERF_DIAG_ENTRIES): PerfDiagEntry[] {
  const n = Math.max(0, Math.min(MAX_PERF_DIAG_ENTRIES, Math.trunc(limit)));
  if (n === 0) return [];
  return ring.slice(-n).map((entry) => ({ ...entry }));
}

export function clearServerPerf(): void {
  ring.length = 0;
}

export function measurePerfSync<T>(
  meta: Omit<PerfDiagInput, "duration_ms" | "ok" | "error_code">,
  fn: () => T,
): T {
  const started = performance.now();
  try {
    const result = fn();
    recordServerPerf({
      ...meta,
      duration_ms: performance.now() - started,
      ok: true,
    });
    return result;
  } catch (error) {
    recordServerPerf({
      ...meta,
      duration_ms: performance.now() - started,
      ok: false,
      error_code: sanitizeErrorCode(error),
    });
    throw error;
  }
}

export async function measurePerfAsync<T>(
  meta: Omit<PerfDiagInput, "duration_ms" | "ok" | "error_code">,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    recordServerPerf({
      ...meta,
      duration_ms: performance.now() - started,
      ok: true,
    });
    return result;
  } catch (error) {
    recordServerPerf({
      ...meta,
      duration_ms: performance.now() - started,
      ok: false,
      error_code: sanitizeErrorCode(error),
    });
    throw error;
  }
}
