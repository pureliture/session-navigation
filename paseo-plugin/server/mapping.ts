import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hasHermesSessionsBatch } from "./hermesHistory.ts";
import { findSessionsBatch } from "./history.ts";

interface ScopeEntry {
  scope_key: string;
  items: number;
  capabilities: { state: string; unhide: boolean };
  agent_id?: string;
}

const MAX_CONFIG_CACHE = 16;
const MAX_AGENT_JSON_CACHE = 512;

const configProvidersCache = new Map<
  string,
  { statKey: string; providers: Record<string, any> }
>();
const agentJsonCache = new Map<
  string,
  { statKey: string; agent: Record<string, any> | null }
>();

function statKeyFor(st: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

function readProvidersConfig(configPath: string): Record<string, any> {
  let st;
  try {
    st = statSync(configPath);
  } catch {
    return {};
  }
  const absPath = resolve(configPath);
  const key = statKeyFor(st);
  const cached = configProvidersCache.get(absPath);
  if (cached && cached.statKey === key) {
    configProvidersCache.delete(absPath);
    configProvidersCache.set(absPath, cached);
    return cached.providers;
  }
  let providers: Record<string, any> = {};
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8"));
    providers = parsed.agents?.providers ?? parsed.providers ?? {};
  } catch {
    providers = {};
  }
  configProvidersCache.delete(absPath);
  configProvidersCache.set(absPath, { statKey: key, providers });
  while (configProvidersCache.size > MAX_CONFIG_CACHE) {
    const oldest = configProvidersCache.keys().next().value;
    if (!oldest) break;
    configProvidersCache.delete(oldest);
  }
  return providers;
}

function readAgentJson(filename: string): Record<string, any> | null {
  let st;
  try {
    st = statSync(filename);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const absPath = resolve(filename);
  const key = statKeyFor(st);
  const cached = agentJsonCache.get(absPath);
  if (cached && cached.statKey === key) {
    agentJsonCache.delete(absPath);
    agentJsonCache.set(absPath, cached);
    return cached.agent;
  }
  let agent: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8"));
    agent = parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
  } catch {
    agent = null;
  }
  agentJsonCache.delete(absPath);
  agentJsonCache.set(absPath, { statKey: key, agent });
  while (agentJsonCache.size > MAX_AGENT_JSON_CACHE) {
    const oldest = agentJsonCache.keys().next().value;
    if (!oldest) break;
    agentJsonCache.delete(oldest);
  }
  return agent;
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
  const config = join(agentsRoot, "config.json");
  const providers = readProvidersConfig(config);

  const scopesByKey = new Map<string, T>();
  for (const scope of scopes) {
    if (!scopesByKey.has(scope.scope_key)) {
      scopesByKey.set(scope.scope_key, scope);
    }
  }

  const agentFiles: string[] = [];
  function collectAgentFiles(directory: string): void {
    if (!existsSync(directory)) return;
    // B3: sorted traversal for deterministic agent_id binding.
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) {
        collectAgentFiles(filename);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        agentFiles.push(filename);
      }
    }
  }
  collectAgentFiles(join(agentsRoot, "agents"));

  type PendingUnbound = {
    agentId: string;
    canonical: string;
    omp: boolean;
    profile: string;
    session: string;
  };
  const pendingUnbound: PendingUnbound[] = [];
  const ompPendingSessions: string[] = [];
  const hermesPendingChecks: Array<{ profile: string; sessionId: string }> = [];

  for (const filename of agentFiles) {
    const agent = readAgentJson(filename);
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
    const existingCanonical = scopesByKey.get(canonical);
    let selected = existingCanonical;
    if (omp && selected?.capabilities.state === "adapter_not_detected") {
      selected = undefined;
    }
    if (!selected && omp) {
      const piCandidate = scopesByKey.get(`pi:${profile}:${session}:default`);
      if (piCandidate?.capabilities.unhide) {
        selected = piCandidate;
      }
    }
    if (!selected && omp && existingCanonical) {
      selected = existingCanonical;
    }
    if (!selected && acp) {
      selected = scopesByKey.get(`hermes:${profile}:${session}:default`);
    }
    if (!selected && capabilitiesFn) {
      pendingUnbound.push({
        agentId: agent.id,
        canonical,
        omp,
        profile,
        session,
      });
      if (omp) ompPendingSessions.push(session);
      else hermesPendingChecks.push({ profile, sessionId: session });
      continue;
    }
    if (selected) selected.agent_id = agent.id;
  }

  if (capabilitiesFn && pendingUnbound.length > 0) {
    const ompFound = ompPendingSessions.length
      ? findSessionsBatch(home, ompPendingSessions)
      : new Set<string>();
    const hermesFound = hermesPendingChecks.length
      ? hasHermesSessionsBatch(home, hermesPendingChecks)
      : new Set<string>();

    for (const candidate of pendingUnbound) {
      // Preserve sequential semantics if an earlier unbound candidate created
      // a matching canonical entry during this same pass.
      const createdAlready = scopesByKey.get(candidate.canonical);
      if (createdAlready) {
        if (
          !candidate.omp ||
          createdAlready.capabilities.state !== "adapter_not_detected"
        ) {
          createdAlready.agent_id = candidate.agentId;
          continue;
        }
      }
      const existsOnDisk = candidate.omp
        ? ompFound.has(candidate.session)
        : hermesFound.has(`${candidate.profile}\0${candidate.session}`);
      if (existsOnDisk) {
        const entry = {
          scope_key: candidate.canonical,
          items: 0,
          parent_scope: null,
          tool_call_id: null,
          subagent_id: null,
          capabilities: capabilitiesFn(candidate.canonical),
          agent_id: candidate.agentId,
        } as unknown as T;
        scopes.push(entry);
        if (!scopesByKey.has(candidate.canonical)) {
          scopesByKey.set(candidate.canonical, entry);
        }
      }
    }
  }

  return scopes;
}
