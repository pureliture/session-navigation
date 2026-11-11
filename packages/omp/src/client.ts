import { homedir } from "node:os";
import { join } from "node:path";
import type { Reply } from "./service.ts";

export interface WorkerTransport {
  postMessage(value: unknown): void;
  terminate(): unknown;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ServiceClient {
  request(method: string, params: object, timeout: number, signal?: AbortSignal): Promise<Reply>;
  close(): void;
}

export function statePath(): string {
  const expand = (value: string): string =>
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  const configured = process.env.SESSION_NAVIGATION_STATE_PATH;
  return configured
    ? expand(configured)
    : join(
        expand(process.env.XDG_DATA_HOME || join(homedir(), ".local/share")),
        "session-navigation/state.sqlite3",
      );
}

interface PendingRequest {
  id: number;
  finish(reply: Reply): void;
}

export class WorkerClient implements ServiceClient {
  private worker: WorkerTransport | undefined;
  private pending: PendingRequest | undefined;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private cooldownUntil = 0;

  constructor(
    private readonly path = statePath(),
    private readonly invalidateSnapshot: () => void = () => {},
    private readonly createWorker: () => WorkerTransport = () =>
      new Worker(new URL("../dist/worker.js", import.meta.url).href),
  ) {}

  request(method: string, params: object, timeout: number, signal?: AbortSignal): Promise<Reply> {
    const request = this.queue.then(() => this.exchange(method, params, timeout, signal));
    this.queue = request.catch(() => undefined);
    return request;
  }

  private invalidate(worker: WorkerTransport, error: string): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.cooldownUntil = Date.now() + 2000;
    this.invalidateSnapshot();
    this.pending?.finish({ ok: false, error });
    this.pending = undefined;
    worker.terminate();
  }

  private start(): WorkerTransport {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event): void => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (!message || typeof message.id !== "number" || typeof message.reply?.ok !== "boolean") {
        this.invalidate(worker, "invalid_response");
      } else if (this.pending?.id === message.id) {
        const pending = this.pending;
        this.pending = undefined;
        pending!.finish(message.reply);
      }
    };
    worker.onerror = (): void => this.invalidate(worker, "worker_error");
    return worker;
  }

  private exchange(
    method: string,
    params: object,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (this.closed) return Promise.resolve({ ok: false, error: "shutdown" });
    if (signal?.aborted) {
      if (this.worker) this.invalidate(this.worker, "cancelled");
      else this.invalidateSnapshot();
      return Promise.resolve({ ok: false, error: "cancelled" });
    }
    if (!this.worker && Date.now() < this.cooldownUntil)
      return Promise.resolve({ ok: false, error: "cooldown" });
    let worker: WorkerTransport;
    try {
      worker = this.worker ?? this.start();
    } catch {
      this.invalidateSnapshot();
      return Promise.resolve({ ok: false, error: "worker_error" });
    }
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.invalidate(worker, "timeout"), timeout);
      const abort = (): void => this.invalidate(worker, "cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = {
        id,
        finish: (reply) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(reply);
        },
      };
      try {
        worker.postMessage({ id, method, params, path: this.path });
      } catch {
        this.invalidate(worker, "worker_error");
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.worker) this.invalidate(this.worker, "shutdown");
  }
}
