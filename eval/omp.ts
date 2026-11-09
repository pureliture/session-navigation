import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sdk = await import(pathToFileURL(join(process.env.OMP_PACKAGE!, "src/index.ts")).href);
const nav = (await import(pathToFileURL(join(spec.repo, "extensions/pi/session-navigation.ts")).href)).default;
const record = (value: any) => appendFileSync(join(spec.output, "events.jsonl"), JSON.stringify({ time: Date.now() / 1000, turn, ...value }) + "\n");
let turn = 0;
const authStorage = await sdk.AuthStorage.create(join(spec.home, "agent.db"));
authStorage.keys.setRuntime("evaluation", "local-eval");
const modelRegistry = new sdk.ModelRegistry(authStorage, join(spec.home, "models.yml"));
const model = { id: "z-ai/glm-5.3-flash", name: "GLM evaluation", provider: "evaluation", api: "openai-completions", identity: { class: "unknown" },
  baseUrl: spec.proxy + "/" + spec.id + "/v1", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" } };
const extensions = spec.arm === "B" ? [(pi: any) => {
  const observed = Object.create(pi);
  observed.registerTool = (tool: any) => pi.registerTool({ ...tool, execute: async (...args: any[]) => {
    record({ kind: "nav_start", name: tool.name, id: args[0], args: args[1] });
    const result = await tool.execute(...args);
    record({ kind: "nav_end", name: tool.name, id: args[0], args: args[1], result });
    return result;
  } });
  nav(observed);
}] : [];
const { session } = await sdk.createAgentSession({ cwd: spec.workspace, agentDir: spec.home, model, modelRegistry, authStorage,
  getApiKey: async () => "local-eval", sessionManager: sdk.SessionManager.inMemory(), extensions,
  disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], noContextFiles: true, promptTemplates: [], enableMCP: false, enableLsp: false,
  toolNames: ["read", "bash", "edit", "write", ...(spec.arm === "B" ? ["list_context_items", "manage_context", "hide_context", "summarize_context", "unhide_context"] : [])], hasUI: false, thinkingLevel: "off" });
session.subscribe((event: any) => {
  if (["tool_execution_start", "tool_execution_end", "turn_start", "turn_end"].includes(event.type)) record({ kind: "host_event", event });
});
const turns: any[] = [];
try {
  for (const prompt of spec.turns) {
    turn++;
    record({ kind: "user", prompt });
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([session.prompt(prompt), new Promise((_, reject) => { timer = setTimeout(() => {
        session.abort(); reject(new Error("turn deadline 300s"));
      }, 300_000); })]);
    } finally { clearTimeout(timer!); }
    const messages = JSON.parse(JSON.stringify(session.messages));
    const last = [...messages].reverse().find((message: any) => message.role === "assistant");
    turns.push({ turn, prompt, answer: last?.content?.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n") || "", messages });
    writeFileSync(join(spec.output, "turns.json"), JSON.stringify(turns));
    console.log(spec.id, "turn", turn, "complete");
  }
} finally { await session.dispose(); }
