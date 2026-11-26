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
        if (
          request.decisions &&
          typeof request.decisions === "object" &&
          !Array.isArray(request.decisions)
        ) {
          service.restoreDecisions(request.decisions);
        }
      }
      if (
        typeof request.controlGeneration === "number" &&
        request.controlGeneration > lastControlGeneration
      ) {
        lastControlGeneration = request.controlGeneration;
        service.invalidateControlCaches();
      }
      const reply = await service.handle(request.method, request.input);
      parentPort!.postMessage({
        id: request.id,
        reply,
        ...(request.syncDecisions === true
          ? { decisions: service.exportDecisions() }
          : {}),
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
        ...(request.syncDecisions === true && service
          ? { decisions: service.exportDecisions() }
          : {}),
      });
    }
  });
});
