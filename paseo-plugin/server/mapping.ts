import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ScopeEntry {
  scope_key: string;
  items: number;
  capabilities: { state: string; unhide: boolean };
  agent_id?: string;
}

function resolveHermesProfile(
  agent: Record<string, any>,
  provider: unknown,
  configured: Record<string, any> | undefined,
): string | null {
  const explicit = agent.persistence?.metadata?.profile;
  if (typeof explicit === "string") return explicit.trim() ? explicit : null;
  if (explicit !== undefined && explicit !== null) return null;
  const argv = [
    ...(Array.isArray(configured?.command) ? configured.command : []),
    ...(Array.isArray(configured?.args) ? configured.args : []),
  ].map((part) => String(part));
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-p" || argv[i] === "--profile") && argv[i + 1]) {
      return argv[i + 1];
    }
    if (argv[i].startsWith("--profile=") && argv[i].slice("--profile=".length)) {
      return argv[i].slice("--profile=".length);
    }
  }
  if (typeof provider === "string") {
    const providerMatch = provider.match(/^hermes[-_:](.+)$/iu);
    if (providerMatch?.[1] && providerMatch[1] !== "acp") {
      return providerMatch[1];
    }
  }
  const cwd =
    typeof agent.cwd === "string"
      ? agent.cwd
      : typeof agent.persistence?.metadata?.cwd === "string"
        ? agent.persistence.metadata.cwd
        : "";
  const cwdMatch = cwd.match(/[\\/]\.hermes[\\/]profiles[\\/]([^\\/]+)/u);
  if (cwdMatch?.[1]) return cwdMatch[1];
  return "default";
}

export function bindAgents<T extends ScopeEntry>(
  home: string,
  scopes: T[],
  paseoHome = home === homedir()
    ? process.env.PASEO_HOME ?? join(home, ".paseo")
    : join(home, ".paseo"),
): T[] {
  let providers: Record<string, any> = {};
  const config = join(paseoHome, "config.json");
  if (existsSync(config)) {
    try {
      const parsed = JSON.parse(readFileSync(config, "utf8"));
      providers = parsed.agents?.providers ?? parsed.providers ?? {};
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
      const configured = typeof provider === "string" ? providers[provider] : undefined;
      const omp = provider === "omp" || transport === "omp";
      const profile = omp
        ? agent.persistence?.metadata?.profile ?? "default"
        : resolveHermesProfile(agent, provider, configured);
      if (typeof session !== "string" || typeof profile !== "string" || !profile) continue;
      const acp =
        transport === "acp" ||
        provider === "acp" ||
        (typeof provider === "string" && provider.startsWith("hermes")) ||
        configured?.extends === "acp";
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
