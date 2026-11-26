export interface ClientPerfDiagInput {
  op: string;
  duration_ms: number;
  ok: boolean;
  ts?: number;
  error_code?: string;
  row_count?: number;
  rendered_count?: number;
  window_start?: number;
  window_end?: number;
  page_count?: number;
  candidate_count?: number;
  cache_hit?: boolean;
  virtualized?: boolean;
  slow_threshold_ms?: number;
}

export interface ClientPerfDiagEntry {
  plugin: "paseo-client";
  op: string;
  ts: number;
  duration_ms: number;
  ok: boolean;
  error_code?: string;
  row_count?: number;
  rendered_count?: number;
  window_start?: number;
  window_end?: number;
  page_count?: number;
  candidate_count?: number;
  cache_hit?: boolean;
  virtualized?: boolean;
}

export const MAX_CLIENT_PERF_DIAG_ENTRIES = 128;
const DEFAULT_SLOW_MS = 50;
const SAFE_OP_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;

const ring: ClientPerfDiagEntry[] = [];

export type ClientPerfDiagMode = "off" | "slow" | "verbose";

export function clientPerfDiagMode(): ClientPerfDiagMode {
  const globalMode = (
    globalThis as { __sessionNavPerfDiagMode?: unknown }
  ).__sessionNavPerfDiagMode;
  const envMode =
    typeof process !== "undefined"
      ? process.env?.SESSION_NAVIGATION_PERF_DIAG
      : undefined;
  const raw = String(globalMode ?? envMode ?? "")
    .trim()
    .toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off") return "off";
  if (raw === "slow") return "slow";
  if (raw === "1" || raw === "true" || raw === "verbose" || raw === "debug") {
    return "verbose";
  }
  return "off";
}

export function sanitizeClientErrorCode(error: unknown): string {
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

function publishGlobalHandle(): void {
  try {
    (globalThis as Record<string, unknown>).__sessionNavPerfDiag = {
      snapshot: () => recentClientPerf(),
      clear: () => clearClientPerf(),
      size: () => ring.length,
    };
  } catch {
    // Ignore read-only globalThis environments.
  }
}

export function recordClientPerf(input: ClientPerfDiagInput): ClientPerfDiagEntry {
  const mode = clientPerfDiagMode();
  const durationMs = finiteNonNeg(input.duration_ms, true) ?? 0;
  const ok = Boolean(input.ok);

  const entry: ClientPerfDiagEntry = {
    plugin: "paseo-client",
    op: typeof input.op === "string" && SAFE_OP_RE.test(input.op) ? input.op : "unknown_op",
    ts: finiteNonNeg(input.ts) ?? Date.now(),
    duration_ms: durationMs,
    ok,
  };

  if (!ok && input.error_code !== undefined) {
    entry.error_code = sanitizeClientErrorCode(input.error_code);
  }
  const rowCount = finiteNonNeg(input.row_count);
  if (rowCount !== undefined) entry.row_count = rowCount;
  const renderedCount = finiteNonNeg(input.rendered_count);
  if (renderedCount !== undefined) entry.rendered_count = renderedCount;
  const windowStart = finiteNonNeg(input.window_start);
  if (windowStart !== undefined) entry.window_start = windowStart;
  const windowEnd = finiteNonNeg(input.window_end);
  if (windowEnd !== undefined) entry.window_end = windowEnd;
  const pageCount = finiteNonNeg(input.page_count);
  if (pageCount !== undefined) entry.page_count = pageCount;
  const candidateCount = finiteNonNeg(input.candidate_count);
  if (candidateCount !== undefined) entry.candidate_count = candidateCount;
  if (typeof input.cache_hit === "boolean") entry.cache_hit = input.cache_hit;
  if (typeof input.virtualized === "boolean") entry.virtualized = input.virtualized;

  ring.push(entry);
  if (ring.length > MAX_CLIENT_PERF_DIAG_ENTRIES) {
    ring.splice(0, ring.length - MAX_CLIENT_PERF_DIAG_ENTRIES);
  }
  publishGlobalHandle();

  const slowThreshold = finiteNonNeg(input.slow_threshold_ms) ?? DEFAULT_SLOW_MS;
  const isSlow = !ok || durationMs >= slowThreshold;
  if (mode === "verbose" || (mode === "slow" && isSlow)) {
    if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
      try {
        process.stderr.write(`[session-nav:perf] ${JSON.stringify(entry)}\n`);
      } catch {
        // Ignore diagnostic write errors.
      }
    } else if (
      typeof (globalThis as { window?: unknown }).window !== "undefined" &&
      typeof console.debug === "function"
    ) {
      console.debug("[session-nav:perf]", entry);
    }
  }

  return entry;
}

export function recentClientPerf(limit = MAX_CLIENT_PERF_DIAG_ENTRIES): ClientPerfDiagEntry[] {
  const n = Math.max(0, Math.min(MAX_CLIENT_PERF_DIAG_ENTRIES, Math.trunc(limit)));
  if (n === 0) return [];
  return ring.slice(-n).map((entry) => ({ ...entry }));
}

export function clearClientPerf(): void {
  ring.length = 0;
  publishGlobalHandle();
}
