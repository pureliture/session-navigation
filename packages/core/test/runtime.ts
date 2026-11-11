import type { Driver } from "../src/driver.ts";
export const makeDriver: (path: string) => Driver =
  "Bun" in globalThis
    ? (path: string) => new BunDriver(path)
    : (path: string) => new NodeDriver(path);
const { NodeDriver } =
  "Bun" in globalThis ? { NodeDriver: undefined as never } : await import("../src/drivers/node.ts");
const { BunDriver } =
  "Bun" in globalThis ? await import("../src/drivers/bun.ts") : { BunDriver: undefined as never };
