import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sdk = await import(pathToFileURL(join(process.env.OMP_PACKAGE!, "src/index.ts")).href);
const nav = (await import(pathToFileURL(join(spec.repo, "extensions/pi/session-navigation.ts")).href)).default;
let turn = 0;
const record = (value: any) => appendFileSync(join(spec.output, "events.jsonl"), JSON.stringify({ time: Date.now() / 1000, turn, ...value }) + "\n");
const aiPath = Bun.resolveSync("@oh-my-pi/pi-ai", join(spec.repo, "extensions/pi"));
const sessionAi = await import(aiPath);
if (typeof sessionAi.completeSimple !== "function") throw new Error("Session LLM dependency unavailable");
record({ kind: "host_dependency", name: "@oh-my-pi/pi-ai", path: aiPath, native_loaded: true });
const authStorage = await sdk.AuthStorage.create(join(spec.home, "agent.db"));
authStorage.keys.setRuntime("evaluation", "local-eval");
const modelRegistry = new sdk.ModelRegistry(authStorage, join(spec.home, "models.yml"));
const model = { id: spec.model, name: "V2 evaluation", provider: "evaluation", api: "openai-completions", identity: { class: "unknown" },
  baseUrl: spec.proxy + "/" + spec.id + "/v1", reasoning: false, input: ["text"], contextWindow: spec.window, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" } };
const settings = await sdk.Settings.init({ cwd: spec.workspace, agentDir: spec.home, inMemory: true,
  overrides: { "compaction.enabled": spec.native_compaction !== false, "compaction.thresholdPercent": 95, "compaction.reserveTokens": 4096,
    "compaction.keepRecentTokens": 8192, "compaction.modelThresholdsEnabled": false } });
const enabled = spec.arm !== "A";
record({ kind: "native_config", enabled: spec.native_compaction !== false, window: spec.window });
const extensions = enabled ? [(pi: any) => {
  const observed = Object.create(pi);
  observed.registerTool = (tool: any) => pi.registerTool({ ...tool, execute: async (...args: any[]) => {
    record({ kind: "nav_start", name: tool.name, id: args[0], args: args[1] });
    const result = await tool.execute(...args);
    record({ kind: "nav_end", name: tool.name, id: args[0], args: args[1], result }); return result;
  } }); nav(observed);
}] : [];
const { session } = await sdk.createAgentSession({ cwd: spec.workspace, agentDir: spec.home, model, modelRegistry, authStorage, settings,
  getApiKey: async () => "local-eval", sessionManager: sdk.SessionManager.inMemory(), extensions, disableExtensionDiscovery: true,
  skills: [], rules: [], contextFiles: [], noContextFiles: true, promptTemplates: [], enableMCP: false, enableLsp: false,
  toolNames: ["read", "bash", "edit", "write", ...(enabled ? ["list_context_items", "manage_context", "hide_context", "summarize_context", "unhide_context"] : [])],
  hasUI: false, thinkingLevel: "off" });
session.extensionRunner?.initialize({
  sendMessage: (message: any, options: any) => session.sendCustomMessage(message, options),
  sendUserMessage: (content: any, options: any) => session.sendUserMessage(content, options),
  appendEntry: (type: string, data: any) => session.sessionManager.appendCustomEntry(type, data),
  setLabel: (id: string, label: any) => session.sessionManager.appendLabelChange(id, label),
  getActiveTools: () => session.getEnabledToolNames(), getAllTools: () => session.getAllToolInfos(),
  setActiveTools: (names: string[]) => session.setActiveToolsByName(names), getCommands: () => [],
  setModel: async (next: any) => { if (next.id !== spec.model) throw new Error("Model is pinned"); await session.setModel(next); return true; },
  getThinkingLevel: () => session.thinkingLevel, setThinkingLevel: (level: any) => session.setThinkingLevel(level),
  getSessionName: () => session.sessionManager.getSessionName(), setSessionName: (name: string) => session.sessionManager.setSessionName(name, "user"),
}, {
  getModel: () => session.model, isIdle: () => !session.isStreaming, abort: () => session.abort(),
  hasPendingMessages: () => session.queuedMessageCount > 0, shutdown: () => session.abort(),
  getContextUsage: () => session.getContextUsage(), compact: (options: any) => session.compact(options),
  getSystemPrompt: () => session.systemPrompt, runEphemeralTurn: (args: any) => session.runEphemeralTurn(args),
});
const extensionContext = session.extensionRunner?.createContext();
await session.extensionRunner?.emit({ type: "session_start" });
if (enabled && (extensionContext?.model?.id !== spec.model || extensionContext.model.contextWindow !== spec.window)) {
  throw new Error("Extension session model/window is not bound");
}
record({ kind: "extension_binding", enabled, model: extensionContext?.model?.id, window: extensionContext?.model?.contextWindow });
session.subscribe((event: any) => { if (["tool_execution_start", "tool_execution_end", "turn_start", "turn_end"].includes(event.type) || event.type.includes("compaction")) record({ kind: "host_event", event }); });
const turns: any[] = [];
try {
  for (const prompt of spec.turns) {
    turn++; record({ kind: "user", prompt });
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([session.prompt(prompt), new Promise((_, reject) => { timer = setTimeout(() => {
      session.abort(); reject(new Error("turn deadline 600s")); }, 600_000); })]); }
    finally { clearTimeout(timer!); }
    const messages = structuredClone(session.messages);
    const last = [...messages].reverse().find((message: any) => message.role === "assistant");
    turns.push({ turn, prompt, answer: last?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") || "", messages });
    writeFileSync(join(spec.output, "turns.json"), JSON.stringify(turns));
    record({ kind: "context_usage", usage: session.getContextUsage() });
    console.log(spec.id, "turn", turn, "complete");
  }
} finally {
  record({ kind: "cleanup_start" });
  const cleanupTimer = setTimeout(() => { record({ kind: "cleanup_timeout", seconds: 30 }); process.exit(124); }, 30_000);
  try { await session.dispose(); record({ kind: "cleanup_end" }); }
  finally { clearTimeout(cleanupTimer); }
}
