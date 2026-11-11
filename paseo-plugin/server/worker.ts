import { parentPort } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Store, EngineError } from "../../packages/core/src/index.ts";
import { NodeDriver } from "../../packages/core/src/drivers/node.ts";
import { PaseoService } from "./service.ts";

let service: PaseoService | undefined;
let queue = Promise.resolve();
parentPort!.on("message", (request) => {
  queue = queue.then(async () => {
    try {
      if (!service) {
        mkdirSync(dirname(request.path), { recursive: true });
        service = new PaseoService(
          new Store(new NodeDriver(request.path)),
          request.home,
        );
      }
      parentPort!.postMessage({
        id: request.id,
        reply: await service.handle(request.method, request.input),
      });
    } catch (error) {
      const code = error instanceof EngineError ? error.code : "engine_error";
      parentPort!.postMessage({
        id: request.id,
        reply: {
          ok: false,
          error: code,
          ...(["db_error", "db_full", "unsafe_journal_mode"].includes(code)
            ? { choices: ["abort_request", "send_original"] }
            : {}),
        },
      });
    }
  });
});
