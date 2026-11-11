import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function childLinkage(ctx: ExtensionContext): { parent_scope: string; subagent_id: string } | null {
  if (ctx.agent?.kind !== "sub" || ctx.agent.depth === 0) return null;
  const parentFile = ctx.sessionManager.getHeader?.()?.parentSession;
  const childFile = ctx.sessionManager.getSessionFile?.();
  if (!parentFile || !childFile) return null;
  let fd: number | undefined;
  try {
    fd = openSync(resolve(dirname(childFile), parentFile), "r");
    const buffer = Buffer.alloc(64 * 1024);
    const text = buffer.subarray(0, readSync(fd, buffer)).toString("utf8");
    for (const line of text.split("\n").slice(0, -1)) {
      const entry = JSON.parse(line);
      if (entry.type !== "session") continue;
      if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256 || entry.id.includes(":")) return null;
      return { parent_scope: `omp:default:${entry.id}:default`, subagent_id: ctx.agent.id };
    }
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
}
