// Offline SDK request capture: the only server is this process's loopback stub.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nav from "../extensions/pi/session-navigation";

const sdk = await import(pathToFileURL(join(process.env.OMP_PACKAGE || "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent", "src/index.ts")).href);
const dir = mkdtempSync(join(tmpdir(), "nav-overhead-"));
const previousState = process.env.SESSION_NAVIGATION_STATE_PATH;
const previousDaemon = process.env.SESSION_NAVIGATION_DAEMON;
process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
process.env.SESSION_NAVIGATION_DAEMON = resolve(".venv/bin/session-navigation-daemon");
const bodies: Record<string, unknown> = {};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  bodies[new URL(request.url).pathname.split("/")[1]] = await request.json();
  const event = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "z-ai/glm-5.3-flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(event({ role: "assistant", content: "done" }, null) + event({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
} });
try {
  for (const arm of ["A", "B"]) {
    const home = join(dir, arm);
    mkdirSync(home);
    const authStorage = await sdk.AuthStorage.create(join(home, "agent.db"));
    authStorage.keys.setRuntime("evaluation", "local-only");
    const modelRegistry = new sdk.ModelRegistry(authStorage, join(home, "models.yml"));
    const model = { id: "z-ai/glm-5.3-flash", name: "GLM evaluation", provider: "evaluation", api: "openai-completions", identity: { class: "unknown" }, baseUrl: `http://127.0.0.1:${server.port}/${arm}/v1`, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" } };
    const { session } = await sdk.createAgentSession({ cwd: resolve("."), agentDir: home, model, modelRegistry, authStorage,
      getApiKey: async () => "local-only", sessionManager: sdk.SessionManager.inMemory(), extensions: arm === "B" ? [nav] : [],
      disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], noContextFiles: true, promptTemplates: [], enableMCP: false, enableLsp: false,
      toolNames: ["read", "bash", "edit", "write", ...(arm === "B" ? ["list_context_items", "manage_context", "hide_context", "summarize_context", "unhide_context"] : [])], hasUI: false, thinkingLevel: "off" });
    try { await session.prompt("Inspect the project."); } finally { await session.dispose(); }
  }
  writeFileSync(process.argv[2], JSON.stringify(bodies));
  console.log("Captured A/B locally; no external model calls.");
} finally {
  server.stop(true); rmSync(dir, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.SESSION_NAVIGATION_STATE_PATH;
  else process.env.SESSION_NAVIGATION_STATE_PATH = previousState;
  if (previousDaemon === undefined) delete process.env.SESSION_NAVIGATION_DAEMON;
  else process.env.SESSION_NAVIGATION_DAEMON = previousDaemon;
}
