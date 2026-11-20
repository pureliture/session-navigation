import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasHermesSession } from "./hermesHistory.ts";
import { findSession } from "./history.ts";

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

function isAcpValue(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "acp";
}

export function bindAgents<T extends ScopeEntry>(
  home: string,
  scopes: T[],
  paseoHome = home === homedir()
    ? (process.env.PASEO_HOME || join(home, ".paseo"))
    : join(home, ".paseo"),
  capabilitiesFn?: (scopeKey: string) => T["capabilities"],
): T[] {
  // B3: an empty PASEO_HOME must fall back to the default dir, never to the
  // process CWD (join("", "agents") would scan wherever the host runs).
  const agentsRoot = paseoHome || join(home, ".paseo");
  let providers: Record<string, any> = {};
  const config = join(paseoHome || join(home, ".paseo"), "config.json");
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
    // B3: sorted traversal for deterministic agent_id binding.
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
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
      // B3: skip archived/retired agent descriptors so stale metadata never
      // overwrites live agent_id bindings.
      if (agent.archived === true || agent.status === "archived" || agent.retired === true) continue;
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
      // B3: scope segments become scope_key parts — a ":" in either would
      // forge extra segments and hijack unrelated scopes (including a fake
      // virtual scope_key via agent_id overwrite).
      if (session.includes(":") || profile.includes(":") || /[\\\/]/.test(session)) continue;
      // B3: only an explicit ACP transport/provider/extends marks an agent
      // as ACP (case-insensitive). A "hermes-*" provider prefix alone is a
      // Hermes provider name, not ACP, and must not reroute the session.
      const acp =
        isAcpValue(transport) ||
        isAcpValue(provider) ||
        isAcpValue(configured?.extends);
      if (!omp && !acp) continue;
      const canonical = `${omp ? "omp" : "hermes"}:${profile}:${session}:${omp ? "default" : "unknown"}`;
      const existingCanonical = scopes.find((scope) => scope.scope_key === canonical);
      let selected = existingCanonical;
      if (omp && selected?.capabilities.state === "adapter_not_detected")
        selected = undefined;
      if (!selected && omp)
        selected = scopes.find(
          (scope) =>
            scope.scope_key === `pi:${profile}:${session}:default` &&
            scope.capabilities.unhide,
        );
      if (!selected && omp && existingCanonical) {
        selected = existingCanonical;
      }
      if (!selected && acp)
        selected = scopes.find(
          (scope) => scope.scope_key === `hermes:${profile}:${session}:default`,
        );
      if (!selected && capabilitiesFn) {
        const existsOnDisk = omp
          ? Boolean(findSession(home, session))
          : hasHermesSession(home, profile, session);
        if (existsOnDisk) {
          scopes.push({
            scope_key: canonical,
            items: 0,
            parent_scope: null,
            tool_call_id: null,
            subagent_id: null,
            capabilities: capabilitiesFn(canonical),
            agent_id: agent.id,
          } as unknown as T);
          continue;
        }
      }
      if (selected) selected.agent_id = agent.id;
    }
  }
  scan(join(agentsRoot, "agents"));
  return scopes;
}
