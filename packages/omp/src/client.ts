import { homedir } from "node:os";
import { join } from "node:path";
import type { Reply } from "./service.ts";

export interface WorkerTransport {
  postMessage(value: unknown): void;
  terminate(): unknown;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface RequestOptions {
  /**
   * When false, a timeout resolves { ok: false, error: "timeout" } without
   * terminating the worker or starting the cooldown. Use for read-only probes
   * (adapter_status): a slow status must not kill a healthy worker and push
   * the next context hook into a cooldown that leaks hidden content.
   */
  invalidateOnTimeout?: boolean;
}

export interface ServiceClient {
  request(method: string, params: object, timeout: number, signal?: AbortSignal, options?: RequestOptions): Promise<Reply>;
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

  request(method: string, params: object, timeout: number, signal?: AbortSignal, options?: RequestOptions): Promise<Reply> {
    const request = this.queue.then(() => this.exchange(method, params, timeout, signal, options));
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
    options?: RequestOptions,
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
      const abort = (): void => this.invalidate(worker, "cancelled");
      const finishSoftTimeout = (): void => {
        // Read-only probe timed out: drop the slot without killing the worker.
        // A late reply no longer matches pending and is ignored.
        if (this.pending?.id === id) this.pending = undefined;
        signal?.removeEventListener("abort", abort);
        resolve({ ok: false, error: "timeout" });
      };
      const timer = setTimeout(
        () => {
          if (options?.invalidateOnTimeout === false) finishSoftTimeout();
          else this.invalidate(worker, "timeout");
        },
        timeout,
      );
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
