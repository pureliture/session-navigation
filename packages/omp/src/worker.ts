import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Store, EngineError } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { OmpService, type Reply } from "./service.ts";

declare const self: Worker;

let service: OmpService | undefined;
let queue: Promise<void> = Promise.resolve();

interface Request {
  id: number;
  method: string;
  params: unknown;
  path: string;
}

self.onmessage = (event: MessageEvent<Request>): void => {
  const request = event.data;
  queue = queue.then(async () => {
    let reply: Reply;
    try {
      if (!service) {
        if (request.path !== ":memory:") mkdirSync(dirname(request.path), { recursive: true });
        service = new OmpService(new Store(new BunDriver(request.path)));
      }
      reply = await service.handle(request.method, request.params);
    } catch (error) {
      reply = {
        ok: false,
        error: error instanceof EngineError ? error.code : "db_error",
        choices: ["abort_request", "send_original"],
      };
    }
    self.postMessage({ id: request.id, reply });
  });
};
