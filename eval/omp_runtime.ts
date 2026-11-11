import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function initializeOmpExtensions(session: any, packageDirectory: string): Promise<void> {
  const { initializeExtensions } = await import(pathToFileURL(join(packageDirectory, "src/modes/runtime-init.ts")).href);
  await initializeExtensions(session, {
    reportSendError: (_action: string, error: Error) => { throw error; },
    reportRuntimeError: (error: { error: string }) => { throw new Error(error.error); },
  });
}
