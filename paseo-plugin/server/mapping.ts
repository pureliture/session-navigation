import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ScopeEntry {
  scope_key: string;
  items: number;
  capabilities: { state: string; unhide: boolean };
  agent_id?: string;
}

export function bindAgents<T extends ScopeEntry>(
  home: string,
  scopes: T[],
): T[] {
  const paseoHome = process.env.PASEO_HOME ?? join(home, ".paseo");
  let providers: Record<string, any> = {};
  const config = join(paseoHome, "config.json");
  if (existsSync(config)) {
    try {
      providers = JSON.parse(readFileSync(config, "utf8")).providers ?? {};
    } catch {
      providers = {};
    }
  }
  function scan(directory: string): void {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(filename);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let agent: Record<string, any>;
      try {
        agent = JSON.parse(readFileSync(filename, "utf8"));
      } catch {
        continue;
      }
      if (!agent || typeof agent.id !== "string") continue;
      const session =
        agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId;
      const provider =
        agent.provider ??
        agent.persistence?.provider ??
        agent.runtimeInfo?.provider;
      const transport =
        agent.persistence?.metadata?.provider ?? agent.runtimeInfo?.provider;
      const profile = agent.persistence?.metadata?.profile ?? "default";
      if (typeof session !== "string" || typeof profile !== "string") continue;
      const configured = providers[provider];
      const acp =
        transport === "acp" ||
        provider === "acp" ||
        configured?.extends === "acp";
      const omp = provider === "omp" || transport === "omp";
      if (!omp && !acp) continue;
      const canonical = `${omp ? "omp" : "hermes"}:${profile}:${session}:${omp ? "default" : "unknown"}`;
      let selected = scopes.find((scope) => scope.scope_key === canonical);
      if (omp && selected?.capabilities.state === "adapter_not_detected")
        selected = undefined;
      if (!selected && omp)
        selected = scopes.find(
          (scope) =>
            scope.scope_key === `pi:${profile}:${session}:default` &&
            scope.capabilities.unhide,
        );
      if (!selected && acp)
        selected = scopes.find(
          (scope) => scope.scope_key === `hermes:${profile}:${session}:default`,
        );
      if (selected) selected.agent_id = agent.id;
    }
  }
  scan(join(paseoHome, "agents"));
  return scopes;
}
