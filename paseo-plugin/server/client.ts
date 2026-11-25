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

type LaneKind = "read" | "write";

interface QueuedCall {
  id: number;
  method: string;
  input: object;
  coalesceKey?: string;
  controlGeneration: number;
  enqueuedAt: number;
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
  private writeEnqueueGen = 0;
  private writeCompleteGen = 0;
  private pendingWriteCount = 0;
  private controlGeneration = 0;
  private readonly decisionListRemaining = new Map<string, number>();

  private readonly readLane: WorkerLane = {
    kind: "read",
    queue: [],
    consecutiveFailures: 0,
    inflightByCoalesceKey: new Map(),
  };

  private readonly writeLane: WorkerLane = {
    kind: "write",
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

  private selectLane(method: string, input: Record<string, any>): WorkerLane {
    if (WRITE_METHODS.has(method)) {
      return this.writeLane;
    }
    if (
      method === "list" &&
      typeof input?.scope_key === "string" &&
      this.decisionListRemaining.has(input.scope_key)
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
    const isWriteMethod = WRITE_METHODS.has(method);
    const lane = this.selectLane(method, inputObj);
    const isToggleWrite =
      method === "setAdapterToggle" ||
      method === "session-nav.set-adapter-toggle";

    if (isWriteMethod) {
      this.writeEnqueueGen += 1;
      this.pendingWriteCount += 1;
      if (isToggleWrite) {
        this.controlGeneration += 1;
      }
      if (
        method === "dbChoice" &&
        typeof inputObj.scope_key === "string" &&
        (inputObj.choice === "send_original" || inputObj.choice === "abort_request")
      ) {
        this.decisionListRemaining.set(
          inputObj.scope_key,
          inputObj.choice === "send_original" ? 2 : 1,
        );
      }
    } else if (method === "list" && typeof inputObj.scope_key === "string") {
      const rem = this.decisionListRemaining.get(inputObj.scope_key);
      if (rem !== undefined) {
        if (rem <= 1) this.decisionListRemaining.delete(inputObj.scope_key);
        else this.decisionListRemaining.set(inputObj.scope_key, rem - 1);
      }
    }

    // Coalesce identical Read requests only within the same write barrier epoch
    // and only when no writes are pending, so post-write reads stay fresh.
    const canCoalesce = lane.kind === "read" && this.pendingWriteCount === 0;
    const coalesceKey = canCoalesce
      ? `${method}\0${stableJson(inputObj)}\0${this.writeEnqueueGen}\0${this.writeCompleteGen}\0${this.controlGeneration}`
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
      const finishWrapper = (reply: Reply) => {
        if (isWriteMethod) {
          this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
          this.writeCompleteGen += 1;
          if (isToggleWrite) {
            this.controlGeneration += 1;
          }
        }
        resolve(reply);
      };

      const call: QueuedCall = {
        id,
        method,
        input: inputObj,
        coalesceKey,
        controlGeneration: this.controlGeneration,
        enqueuedAt: performance.now(),
        resolves: [finishWrapper],
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
    const callbacks = call.resolves.splice(0, call.resolves.length);
    for (const cb of callbacks) {
      cb(reply);
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
    while (!lane.active && lane.queue.length > 0) {
      if (this.closed) {
        this.failAllInLane(lane, "closed");
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

      try {
        worker.postMessage({
          id: active.id,
          path: this.path,
          home: this.home,
          method: active.method,
          input: active.input,
          controlGeneration: this.controlGeneration,
        });
      } catch {
        clearTimeout(active.timer);
        if (lane.active === active) {
          lane.active = undefined;
        }
        this.terminateWorkerInstance(lane, worker);
        lane.consecutiveFailures += 1;
        this.recordLaneTelemetry(lane, active, false, "post_message_failed");
        this.settleCall(lane, active, { ok: false, error: "engine_error" });
        if (lane.consecutiveFailures >= MAX_CONSECUTIVE_LANE_FAILURES) {
          this.failAllInLane(lane, "post_message_failed");
          return;
        }
      }
    }
  }

  private terminateWorkerInstance(lane: WorkerLane, worker: Worker): void {
    if (this.getWorkerRef(lane.kind) === worker) {
      this.setWorkerRef(lane.kind, undefined);
    }
    worker.removeAllListeners();
    void worker.terminate();
  }

  private handleLaneMessage(
    lane: WorkerLane,
    worker: Worker,
    message: { id?: number; reply?: Reply },
  ): void {
    if (this.getWorkerRef(lane.kind) !== worker) return;
    const active = lane.active;
    if (!active || message?.id !== active.id) return;

    clearTimeout(active.timer);
    lane.active = undefined;
    lane.consecutiveFailures = 0;

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
    this.terminateWorkerInstance(lane, worker);
    lane.consecutiveFailures += 1;
    this.recordLaneTelemetry(lane, active, false, "timeout");
    // Fail ONLY the timed-out active call (never re-execute writes on timeout).
    this.settleCall(lane, active, { ok: false, error: "engine_error" });
    if (this.closed || lane.consecutiveFailures >= MAX_CONSECUTIVE_LANE_FAILURES) {
      this.failAllInLane(lane, "timeout");
      return;
    }
    this.dispatchLane(lane);
  }

  private handleLaneCrash(
    lane: WorkerLane,
    worker: Worker,
    reason: string,
  ): void {
    if (this.getWorkerRef(lane.kind) !== worker) return;
    this.terminateWorkerInstance(lane, worker);

    const active = lane.active;
    if (active) {
      clearTimeout(active.timer);
      lane.active = undefined;
      lane.consecutiveFailures += 1;
      this.recordLaneTelemetry(lane, active, false, reason);
      // Fail ONLY the interrupted in-flight request; preserve queued requests.
      this.settleCall(lane, active, { ok: false, error: "engine_error" });
    }

    if (this.closed || lane.consecutiveFailures >= MAX_CONSECUTIVE_LANE_FAILURES) {
      this.failAllInLane(lane, reason);
      return;
    }
    this.dispatchLane(lane);
  }

  private failAllInLane(lane: WorkerLane, _reason: string): void {
    const worker = this.getWorkerRef(lane.kind);
    if (worker) {
      this.terminateWorkerInstance(lane, worker);
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
