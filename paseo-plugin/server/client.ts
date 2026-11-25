import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import workerSource from "./worker-source.ts";
import {
  recordServerPerf,
  sanitizeErrorCode,
  scopeAdapterKind,
} from "./diagnostics.ts";

export type Reply = { ok: boolean; [key: string]: any };

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_LANE_FAILURES = 2;

const WRITE_METHODS = new Set([
  "hide",
  "unhide",
  "hideBatch",
  "unhideBatch",
  "manage",
  "fork",
  "dbChoice",
  "setAdapterToggle",
  "session-nav.set-adapter-toggle",
]);

export function runtimeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

function scopeAliasKeys(key: string): string[] {
  const parts = key.split(":");
  if (
    parts.length === 4 &&
    parts[0] === "hermes" &&
    (parts[3] === "unknown" || parts[3] === "default")
  ) {
    return [
      key,
      [
        ...parts.slice(0, 3),
        parts[3] === "unknown" ? "default" : "unknown",
      ].join(":"),
    ];
  }
  return [key];
}

type LaneKind = "read" | "write";

interface QueuedCall {
  id: number;
  method: string;
  input: object;
  coalesceKey?: string;
  controlGeneration: number;
  enqueuedAt: number;
  writeSeq?: number;
  requiredWriteSeq: number;
  isDbChoice?: boolean;
  isToggleWrite?: boolean;
  resolves: Array<(reply: Reply) => void>;
}

interface ActiveCall extends QueuedCall {
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerLane {
  kind: LaneKind;
  worker?: Worker;
  active?: ActiveCall;
  draining: boolean;
  drainingCall?: ActiveCall;
  needsDecisionSync: boolean;
  queue: QueuedCall[];
  consecutiveFailures: number;
  inflightByCoalesceKey: Map<string, QueuedCall>;
}

export class ServiceClient {
  // Keep `worker` field pointing to the Read Lane worker for backwards-compatible
  // test/lifecycle inspection (`worker-lifecycle.node.ts`).
  private worker?: Worker;
  private writeWorker?: Worker;
  private nextId = 0;
  private closed = false;
  private writeSeq = 0;
  private settledWriteSeq = 0;
  private pendingWriteCount = 0;
  private pendingDbChoiceCount = 0;
  private activeDecisions: Record<string, string> = {};
  private controlGeneration = 0;

  private readonly readLane: WorkerLane = {
    kind: "read",
    draining: false,
    needsDecisionSync: false,
    queue: [],
    consecutiveFailures: 0,
    inflightByCoalesceKey: new Map(),
  };

  private readonly writeLane: WorkerLane = {
    kind: "write",
    draining: false,
    needsDecisionSync: false,
    queue: [],
    consecutiveFailures: 0,
    inflightByCoalesceKey: new Map(),
  };

  readonly home: string;
  readonly path: string;

  constructor(
    home = homedir(),
    path = process.env.SESSION_NAVIGATION_STATE_PATH ??
      join(
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        "session-navigation",
        "state.sqlite3",
      ),
  ) {
    this.home = home;
    this.path = path;
  }

  private getWorkerRef(kind: LaneKind): Worker | undefined {
    return kind === "read" ? this.worker : this.writeWorker;
  }

  private setWorkerRef(kind: LaneKind, worker: Worker | undefined): void {
    if (kind === "read") {
      this.worker = worker;
    } else {
      this.writeWorker = worker;
    }
    const lane = kind === "read" ? this.readLane : this.writeLane;
    lane.worker = worker;
  }

  private hasActiveDecisionForScope(scopeKey: unknown): boolean {
    if (typeof scopeKey !== "string") return false;
    return scopeAliasKeys(scopeKey).some((key) => key in this.activeDecisions);
  }

  private selectLane(method: string, input: Record<string, any>): WorkerLane {
    if (WRITE_METHODS.has(method)) {
      return this.writeLane;
    }
    if (
      method === "list" &&
      typeof input?.scope_key === "string" &&
      (this.pendingDbChoiceCount > 0 ||
        this.hasActiveDecisionForScope(input.scope_key))
    ) {
      return this.writeLane;
    }
    return this.readLane;
  }

  request(method: string, input: object): Promise<Reply> {
    if (!runtimeSupported()) {
      return Promise.resolve({
        ok: false,
        error: "runtime_unsupported",
        message:
          "Session Navigation requires Node >=22.13 (node:sqlite). Upgrade the Paseo daemon runtime.",
      });
    }
    if (this.closed) {
      return Promise.resolve({ ok: false, error: "engine_error" });
    }

    const inputObj = (input ?? {}) as Record<string, any>;
    const lane = this.selectLane(method, inputObj);
    const isWriteLaneCall = lane.kind === "write";
    const isDbChoice = method === "dbChoice";
    const isToggleWrite =
      method === "setAdapterToggle" ||
      method === "session-nav.set-adapter-toggle";

    let callWriteSeq: number | undefined;
    let requiredWriteSeq = 0;

    if (isWriteLaneCall) {
      callWriteSeq = ++this.writeSeq;
      this.pendingWriteCount += 1;
      if (isDbChoice) {
        this.pendingDbChoiceCount += 1;
      }
      if (isToggleWrite) {
        this.controlGeneration += 1;
      }
    } else {
      requiredWriteSeq = this.writeSeq;
    }

    // Coalesce identical Read requests only within the same settled write epoch
    // and only when no writes are pending or in flight, so post-write reads stay fresh.
    const canCoalesce =
      lane.kind === "read" &&
      this.pendingWriteCount === 0 &&
      this.settledWriteSeq === this.writeSeq;
    const coalesceKey = canCoalesce
      ? `${method}\0${stableJson(inputObj)}\0${this.writeSeq}\0${this.settledWriteSeq}\0${this.controlGeneration}`
      : undefined;

    if (coalesceKey) {
      const existing = lane.inflightByCoalesceKey.get(coalesceKey);
      if (existing) {
        return new Promise((resolve) => {
          existing.resolves.push(resolve);
        });
      }
    }

    const id = ++this.nextId;
    return new Promise((resolve) => {
      const call: QueuedCall = {
        id,
        method,
        input: inputObj,
        coalesceKey,
        controlGeneration: this.controlGeneration,
        enqueuedAt: performance.now(),
        writeSeq: callWriteSeq,
        requiredWriteSeq,
        isDbChoice,
        isToggleWrite,
        resolves: [resolve],
      };

      if (coalesceKey) {
        lane.inflightByCoalesceKey.set(coalesceKey, call);
      }
      lane.queue.push(call);
      this.dispatchLane(lane);
    });
  }

  private ensureLaneWorker(lane: WorkerLane): Worker | undefined {
    const existing = this.getWorkerRef(lane.kind);
    if (existing) return existing;
    try {
      const worker = new Worker(workerSource, { eval: true });
      worker.on("message", (message) =>
        this.handleLaneMessage(lane, worker, message),
      );
      worker.on("error", () => this.handleLaneCrash(lane, worker, "worker_error"));
      worker.on("exit", () => this.handleLaneCrash(lane, worker, "worker_exit"));
      if (lane.kind === "write") {
        lane.needsDecisionSync = true;
      }
      this.setWorkerRef(lane.kind, worker);
      return worker;
    } catch {
      return undefined;
    }
  }

  private settleCall(lane: WorkerLane, call: QueuedCall, reply: Reply): void {
    if (call.coalesceKey) {
      const current = lane.inflightByCoalesceKey.get(call.coalesceKey);
      if (current?.id === call.id) {
        lane.inflightByCoalesceKey.delete(call.coalesceKey);
      }
    }
    if (lane.kind === "write") {
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
      if (call.isDbChoice) {
        this.pendingDbChoiceCount = Math.max(0, this.pendingDbChoiceCount - 1);
      }
      if (call.isToggleWrite) {
        this.controlGeneration += 1;
      }
      if (typeof call.writeSeq === "number") {
        this.settledWriteSeq = Math.max(this.settledWriteSeq, call.writeSeq);
      }
    }
    const callbacks = call.resolves.splice(0, call.resolves.length);
    for (const cb of callbacks) {
      cb(reply);
    }
    if (lane.kind === "write" && !this.closed) {
      this.dispatchLane(this.readLane);
    }
  }

  private recordLaneTelemetry(
    lane: WorkerLane,
    call: ActiveCall,
    ok: boolean,
    errorCode?: string,
  ): void {
    const now = performance.now();
    const inputRecord = call.input as { scope_key?: unknown };
    recordServerPerf({
      op: `worker.${call.method}`,
      duration_ms: Math.max(0, now - call.startedAt),
      queue_wait_ms: Math.max(0, call.startedAt - call.enqueuedAt),
      ok,
      ...(ok ? {} : { error_code: sanitizeErrorCode(errorCode ?? "engine_error") }),
      adapter: scopeAdapterKind(inputRecord?.scope_key),
      lane: lane.kind,
      coalesced: call.resolves.length > 1,
    });
  }

  private dispatchLane(lane: WorkerLane): void {
    while (!lane.active && !lane.draining && lane.queue.length > 0) {
      if (this.closed) {
        this.failAllInLane(lane, "closed");
        return;
      }
      if (
        lane.kind === "read" &&
        lane.queue[0].requiredWriteSeq > this.settledWriteSeq
      ) {
        return;
      }
      const next = lane.queue.shift()!;
      const worker = this.ensureLaneWorker(lane);
      if (!worker) {
        lane.consecutiveFailures += 1;
        this.settleCall(lane, next, { ok: false, error: "engine_error" });
        if (lane.consecutiveFailures >= MAX_CONSECUTIVE_LANE_FAILURES) {
          this.failAllInLane(lane, "worker_spawn_failed");
          return;
        }
        continue;
      }

      const startedAt = performance.now();
      const active: ActiveCall = {
        ...next,
        startedAt,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      if (active.coalesceKey) {
        lane.inflightByCoalesceKey.set(active.coalesceKey, active);
      }
      active.timer = setTimeout(() => {
        this.handleActiveTimeout(lane, worker, active);
      }, REQUEST_TIMEOUT_MS);
      lane.active = active;

      const sendDecisions = lane.kind === "write" && lane.needsDecisionSync;
      if (sendDecisions) {
        lane.needsDecisionSync = false;
      }

      try {
        worker.postMessage({
          id: active.id,
          path: this.path,
          home: this.home,
          method: active.method,
          input: active.input,
          controlGeneration: this.controlGeneration,
          ...(lane.kind === "write" ? { syncDecisions: true } : {}),
          ...(sendDecisions ? { decisions: { ...this.activeDecisions } } : {}),
        });
      } catch {
        if (sendDecisions) {
          lane.needsDecisionSync = true;
        }
        clearTimeout(active.timer);
        if (lane.active === active) {
          lane.active = undefined;
        }
        lane.consecutiveFailures += 1;
        this.recordLaneTelemetry(lane, active, false, "post_message_failed");
        this.drainWorkerAndFailCall(lane, worker, active, "post_message_failed");
        return;
      }
    }
  }

  private terminateWorkerInstance(
    lane: WorkerLane,
    worker: Worker,
  ): Promise<number> {
    if (this.getWorkerRef(lane.kind) === worker) {
      this.setWorkerRef(lane.kind, undefined);
    }
    worker.removeAllListeners();
    return worker.terminate().catch(() => 0);
  }

  private drainWorkerAndFailCall(
    lane: WorkerLane,
    worker: Worker,
    active: ActiveCall,
    reason: string,
  ): void {
    lane.draining = true;
    lane.drainingCall = active;
    void this.terminateWorkerInstance(lane, worker).finally(() => {
      if (lane.drainingCall !== active) return;
      lane.draining = false;
      lane.drainingCall = undefined;
      if (lane.kind === "write") {
        this.controlGeneration += 1;
      }
      // Fail ONLY the interrupted/timed-out in-flight call (never report ok or retry).
      this.settleCall(lane, active, { ok: false, error: "engine_error" });
      if (this.closed || lane.consecutiveFailures >= MAX_CONSECUTIVE_LANE_FAILURES) {
        this.failAllInLane(lane, reason);
        return;
      }
      this.dispatchLane(lane);
    });
  }

  private handleLaneMessage(
    lane: WorkerLane,
    worker: Worker,
    message: { id?: number; reply?: Reply; decisions?: Record<string, string> },
  ): void {
    if (this.getWorkerRef(lane.kind) !== worker) return;
    const active = lane.active;
    if (!active || message?.id !== active.id) return;

    clearTimeout(active.timer);
    lane.active = undefined;
    lane.consecutiveFailures = 0;

    if (
      lane.kind === "write" &&
      message.decisions &&
      typeof message.decisions === "object" &&
      !Array.isArray(message.decisions)
    ) {
      this.activeDecisions = { ...message.decisions };
    }

    const validReply =
      message.reply && typeof message.reply.ok === "boolean"
        ? message.reply
        : { ok: false, error: "engine_error" };

    this.recordLaneTelemetry(
      lane,
      active,
      Boolean(validReply.ok),
      validReply.ok ? undefined : String(validReply.error ?? "error"),
    );
    this.settleCall(lane, active, validReply);
    this.dispatchLane(lane);
  }

  private handleActiveTimeout(
    lane: WorkerLane,
    worker: Worker,
    active: ActiveCall,
  ): void {
    if (lane.active !== active) return;
    lane.active = undefined;
    lane.consecutiveFailures += 1;
    this.recordLaneTelemetry(lane, active, false, "timeout");
    this.drainWorkerAndFailCall(lane, worker, active, "timeout");
  }

  private handleLaneCrash(
    lane: WorkerLane,
    worker: Worker,
    reason: string,
  ): void {
    if (this.getWorkerRef(lane.kind) !== worker) return;
    const active = lane.active;
    if (active) {
      clearTimeout(active.timer);
      lane.active = undefined;
      lane.consecutiveFailures += 1;
      this.recordLaneTelemetry(lane, active, false, reason);
      this.drainWorkerAndFailCall(lane, worker, active, reason);
      return;
    }

    void this.terminateWorkerInstance(lane, worker);
    this.dispatchLane(lane);
  }

  private failAllInLane(lane: WorkerLane, _reason: string): void {
    const worker = this.getWorkerRef(lane.kind);
    if (worker) {
      void this.terminateWorkerInstance(lane, worker);
    }
    if (lane.drainingCall) {
      const draining = lane.drainingCall;
      lane.draining = false;
      lane.drainingCall = undefined;
      this.settleCall(lane, draining, { ok: false, error: "engine_error" });
    }
    if (lane.active) {
      const active = lane.active;
      clearTimeout(active.timer);
      lane.active = undefined;
      this.settleCall(lane, active, { ok: false, error: "engine_error" });
    }
    while (lane.queue.length > 0) {
      const queued = lane.queue.shift()!;
      this.settleCall(lane, queued, { ok: false, error: "engine_error" });
    }
  }

  close(): void {
    this.closed = true;
    this.failAllInLane(this.readLane, "closed");
    this.failAllInLane(this.writeLane, "closed");
  }
}
