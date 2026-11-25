import { parentPort } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Store, EngineError } from "../../packages/core/src/index.ts";
import { NodeDriver } from "../../packages/core/src/drivers/node.ts";
import { PaseoService } from "./service.ts";

let service: PaseoService | undefined;
let lastControlGeneration = 0;
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
      if (
        typeof request.controlGeneration === "number" &&
        request.controlGeneration > lastControlGeneration
      ) {
        lastControlGeneration = request.controlGeneration;
        service.invalidateControlCaches();
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
          ...([
            "db_error",
            "db_full",
            "unsafe_journal_mode",
            "engine_protocol_incompatible",
          ].includes(code)
            ? { choices: ["abort_request", "send_original"] }
            : {}),
        },
      });
    }
  });
});
