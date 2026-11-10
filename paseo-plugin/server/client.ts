import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { join } from "node:path";
import workerSource from "./worker-source.ts";
import type { Reply } from "./service.ts";

export function runtimeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export class ServiceClient {
  private worker?: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private closed = false;
  constructor(
    readonly home = homedir(),
    readonly path = process.env.SESSION_NAVIGATION_STATE_PATH ??
      join(
        process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
        "session-navigation",
        "state.sqlite3",
      ),
  ) {}

  request(method: string, input: object): Promise<Reply> {
    if (!runtimeSupported())
      return Promise.resolve({
        ok: false,
        error: "runtime_unsupported",
        message:
          "Session Navigation requires Node >=22.13 (node:sqlite). Upgrade the Paseo daemon runtime.",
      });
    if (this.closed)
      return Promise.resolve({ ok: false, error: "engine_error" });
    if (!this.worker) {
      try {
        this.worker = new Worker(workerSource, { eval: true });
        this.worker.on("message", (message) => {
          const finish = this.pending.get(message?.id);
          if (!finish) return;
          finish(
            message.reply && typeof message.reply.ok === "boolean"
              ? message.reply
              : { ok: false, error: "engine_error" },
          );
        });
        this.worker.on("error", () => this.fail());
        this.worker.on("exit", () => this.fail());
      } catch {
        return Promise.resolve({ ok: false, error: "engine_error" });
      }
    }
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail(), 30000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(reply);
      });
      try {
        this.worker!.postMessage({
          id,
          path: this.path,
          home: this.home,
          method,
          input,
        });
      } catch {
        this.fail();
      }
    });
  }

  private fail(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.removeAllListeners();
    void worker?.terminate();
    for (const finish of [...this.pending.values()])
      finish({ ok: false, error: "engine_error" });
  }

  close(): void {
    this.closed = true;
    this.fail();
  }
}
