import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  parseAllDocuments,
  Scalar,
  visit,
  YAMLMap,
  type Node,
  type Pair,
} from "yaml";

export interface HermesProfileToggleState {
  profile: string;
  configPath: string;
  enabled: boolean;
}

export interface HermesRuntimeSessionInfo {
  scope_key: string;
  adapter_protocol: number;
  capabilities: Record<string, any>;
  enabled: boolean;
  last_seen: number;
}

export interface HermesRuntimeInspectionContext {
  control?: { enabled: boolean; revision: number; updated_at: number } | null;
  hiddenScopes?: readonly string[];
  registeredSessions?: readonly HermesRuntimeSessionInfo[];
  boundScopes?: readonly string[];
  now?: number;
}

export interface HermesToggleStatus {
  installed: boolean;
  enabled: boolean;
  profileCount: number;
  enabledProfileCount?: number;
  mixed?: boolean;
  stateUnknown?: boolean;
  canDisable?: boolean;
  protectionVerified?: boolean;
  pluginInstalled?: boolean;
  protectionSupportedOnDisk?: boolean;
  unverifiedScopes?: string[];
  profiles?: HermesProfileToggleState[];
  rolledBack?: boolean;
  partialUpdate?: boolean;
  updatedFiles?: string[];
  rolledBackFiles?: string[];
  rollbackFailedFiles?: string[];
  statusText?: string;
  warning?: string;
  remediation?: string;
  error?: string;
}

export interface HermesPluginInstallCheck {
  pluginInstalled: boolean;
  protectionSupportedOnDisk: boolean;
  bundleFingerprint?: string;
  pluginDirs: string[];
  reason?: string;
  error?: string;
}

export interface HermesWriteOptions {
  writeFileImpl?: (path: string, data: string, options: { encoding: "utf8"; mode: number }) => void;
  renameImpl?: (oldPath: string, newPath: string) => void;
  unlinkImpl?: (path: string) => void;
  onBeforeCommitFile?: (filePath: string, index: number) => void;
  onBeforeRollbackFile?: (filePath: string, index: number) => void;
  onBeforeClearJournal?: (journalPath: string) => void;
  deferJournalClear?: boolean;
  lockAlreadyHeld?: boolean;
}

export interface HermesSetToggleResult {
  ok: boolean;
  error?: string;
  updatedFiles: string[];
  rolledBack: boolean;
  partialUpdate: boolean;
  rolledBackFiles: string[];
  rollbackFailedFiles: string[];
  profiles: HermesProfileToggleState[];
  clearJournal?: () => void;
  rollbackSnapshot?: () => {
    ok: boolean;
    rolledBackFiles: string[];
    rollbackFailedFiles: string[];
    profiles: HermesProfileToggleState[];
  };
}

const ENTRY_KEY_NAMES = new Set(["session-navigation", "session_navigation"]);
const TOGGLE_LOCK_NAME = ".session-navigation-toggle.lock";
const TOGGLE_JOURNAL_NAME = ".session-navigation-toggle.journal.json";

function getMapPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find(
    (item): item is Pair => isPair(item) && isScalar(item.key) && item.key.value === key,
  );
}

function getMapValueNode(map: YAMLMap, key: string): unknown {
  return getMapPair(map, key)?.value;
}

function hasAnchor(node: unknown): boolean {
  return Boolean(
    node !== null &&
      typeof node === "object" &&
      "anchor" in node &&
      (node as { anchor?: unknown }).anchor,
  );
}

function assertSafeTargetNode(node: unknown): void {
  if (isAlias(node) || hasAnchor(node)) {
    throw new Error("hermes_invalid_config_yaml");
  }
}

function parseBoolScalarNode(node: unknown): boolean {
  assertSafeTargetNode(node);
  if (!isScalar(node) || typeof node.value !== "boolean") {
    throw new Error("hermes_invalid_config_yaml");
  }
  return node.value;
}

function resolveNavEntryKey(entriesMap: YAMLMap): "session-navigation" | "session_navigation" {
  const hyphenPair = getMapPair(entriesMap, "session-navigation");
  const underscorePair = getMapPair(entriesMap, "session_navigation");
  if (hyphenPair !== undefined && underscorePair !== undefined) {
    throw new Error("hermes_invalid_config_yaml");
  }
  return underscorePair !== undefined ? "session_navigation" : "session-navigation";
}

function parseValidatedHermesDocument(yamlText: string): {
  doc: Document<Node, boolean>;
  eol: "\r\n" | "\n";
  navKey: "session-navigation" | "session_navigation";
} {
  const eol: "\r\n" | "\n" = yamlText.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\r\n" ? yamlText.replace(/\r\n/g, "\n") : yamlText;
  const docs = parseAllDocuments(normalized, {
    strict: true,
    uniqueKeys: true,
    merge: false,
  });
  if (docs.length > 1) {
    throw new Error("hermes_invalid_config_yaml");
  }

  let doc: Document<Node, boolean>;
  if (docs.length === 0) {
    if ("empty" in docs && (docs.errors.length > 0 || docs.warnings.length > 0)) {
      throw new Error("hermes_invalid_config_yaml");
    }
    doc = new Document<Node, boolean>(
      {},
      { strict: true, uniqueKeys: true, merge: false },
    );
    if ("empty" in docs) {
      if (docs.comment) {
        doc.commentBefore = docs.comment;
      }
      if (docs.directives?.docStart && doc.directives) {
        doc.directives.docStart = docs.directives.docStart;
      }
    }
  } else {
    doc = docs[0] as unknown as Document<Node, boolean>;
  }

  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    throw new Error("hermes_invalid_config_yaml");
  }
  assertSafeTargetNode(doc.contents);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("hermes_invalid_config_yaml");
  }

  visit(doc, (_key, node) => {
    if (isMap(node)) {
      const seenKeys = new Set<string>();
      for (const pair of node.items) {
        if (
          !isPair(pair) ||
          !isScalar(pair.key) ||
          typeof pair.key.value !== "string" ||
          pair.key.value === "<<"
        ) {
          throw new Error("hermes_invalid_config_yaml");
        }
        if (seenKeys.has(pair.key.value)) {
          throw new Error("hermes_invalid_config_yaml");
        }
        seenKeys.add(pair.key.value);
      }
    }
  });

  try {
    doc.toJS({ mapAsMap: true, maxAliasCount: 100 });
  } catch {
    throw new Error("hermes_invalid_config_yaml");
  }

  let navKey: "session-navigation" | "session_navigation" = "session-navigation";
  if (doc.contents && isMap(doc.contents)) {
    const pluginsPair = getMapPair(doc.contents, "plugins");
    if (pluginsPair !== undefined) {
      assertSafeTargetNode(pluginsPair.key);
      assertSafeTargetNode(pluginsPair.value);
      if (!isMap(pluginsPair.value)) {
        throw new Error("hermes_invalid_config_yaml");
      }
      const entriesPair = getMapPair(pluginsPair.value, "entries");
      if (entriesPair !== undefined) {
        assertSafeTargetNode(entriesPair.key);
        assertSafeTargetNode(entriesPair.value);
        if (!isMap(entriesPair.value)) {
          throw new Error("hermes_invalid_config_yaml");
        }
        navKey = resolveNavEntryKey(entriesPair.value);
        const navPair = getMapPair(entriesPair.value, navKey);
        if (navPair !== undefined) {
          assertSafeTargetNode(navPair.key);
          assertSafeTargetNode(navPair.value);
          if (!isMap(navPair.value)) {
            throw new Error("hermes_invalid_config_yaml");
          }
          const settingsPair = getMapPair(navPair.value, "settings");
          if (settingsPair !== undefined) {
            assertSafeTargetNode(settingsPair.key);
            assertSafeTargetNode(settingsPair.value);
            if (!isMap(settingsPair.value)) {
              throw new Error("hermes_invalid_config_yaml");
            }
            const enabledPair = getMapPair(settingsPair.value, "enabled");
            if (enabledPair !== undefined) {
              assertSafeTargetNode(enabledPair.key);
              parseBoolScalarNode(enabledPair.value);
            }
          }
        }
      }
    }
  }

  return { doc, eol, navKey };
}

export function readHermesPluginEnabled(yamlText: string): boolean {
  const { doc } = parseValidatedHermesDocument(yamlText);
  if (!doc.contents || !isMap(doc.contents)) return false;
  const pluginsNode = getMapValueNode(doc.contents, "plugins");
  if (!isMap(pluginsNode)) return false;
  const entriesNode = getMapValueNode(pluginsNode, "entries");
  if (!isMap(entriesNode)) return false;
  let navNode: unknown;
  for (const key of ENTRY_KEY_NAMES) {
    navNode = getMapValueNode(entriesNode, key);
    if (navNode !== undefined) break;
  }
  if (!isMap(navNode)) return false;
  const settingsNode = getMapValueNode(navNode, "settings");
  if (!isMap(settingsNode)) return false;
  const enabledNode = getMapValueNode(settingsNode, "enabled");
  if (enabledNode === undefined) return false;
  return parseBoolScalarNode(enabledNode);
}

export function patchHermesConfigYaml(yamlText: string, enabled: boolean): string {
  const { doc, eol, navKey } = parseValidatedHermesDocument(yamlText);
  const beforeRaw = doc.toJS({ maxAliasCount: 100, mapAsMap: true }) as unknown;
  if (beforeRaw !== null && !(beforeRaw instanceof Map)) {
    throw new Error("hermes_invalid_config_yaml");
  }

  if (doc.contents === null) {
    if (doc.comment && !doc.commentBefore) {
      doc.commentBefore = doc.comment;
      doc.comment = null;
    }
    doc.contents = new YAMLMap(doc.schema);
  }
  if (!isMap(doc.contents)) {
    throw new Error("hermes_invalid_config_yaml");
  }
  const rootMap = doc.contents;
  if (rootMap.flow && rootMap.items.length === 0) {
    rootMap.flow = false;
  }

  const getOrCreateBlockChildMap = (parent: YAMLMap, key: string): YAMLMap => {
    const existing = getMapPair(parent, key);
    if (!existing) {
      if (parent.flow && parent.items.length === 0) {
        parent.flow = false;
      }
      const created = new YAMLMap(doc.schema);
      parent.add(doc.createPair(key, created));
      return created;
    }
    if (!isMap(existing.value)) {
      throw new Error("hermes_invalid_config_yaml");
    }
    if (existing.value.flow && existing.value.items.length === 0) {
      existing.value.flow = false;
    }
    return existing.value;
  };

  const pluginsMap = getOrCreateBlockChildMap(rootMap, "plugins");
  const entriesMap = getOrCreateBlockChildMap(pluginsMap, "entries");
  const navMap = getOrCreateBlockChildMap(entriesMap, navKey);

  let settingsMap: YAMLMap;
  const existingSettings = getMapPair(navMap, "settings");
  if (!existingSettings) {
    settingsMap = new YAMLMap(doc.schema);
    navMap.add(doc.createPair("settings", settingsMap));
  } else {
    if (!isMap(existingSettings.value)) {
      throw new Error("hermes_invalid_config_yaml");
    }
    settingsMap = existingSettings.value;
    if (settingsMap.flow && settingsMap.items.length === 0) {
      settingsMap.flow = false;
    }
  }

  const enabledPair = getMapPair(settingsMap, "enabled");
  if (enabledPair) {
    const enabledNode = enabledPair.value;
    if (!isScalar(enabledNode) || typeof enabledNode.value !== "boolean") {
      throw new Error("hermes_invalid_config_yaml");
    }
    enabledNode.value = enabled;
    enabledNode.type = Scalar.PLAIN;
    delete (enabledNode as { source?: unknown }).source;
    delete (enabledNode as { format?: unknown }).format;
    delete (enabledNode as { tag?: unknown }).tag;
  } else {
    settingsMap.set("enabled", enabled);
  }

  let serialized = doc.toString({ lineWidth: 0 });
  if (eol === "\r\n") {
    serialized = serialized.replace(/\r?\n/g, "\r\n");
  }

  const expectedAfter: Map<unknown, unknown> =
    beforeRaw instanceof Map ? structuredClone(beforeRaw) : new Map<unknown, unknown>();
  const ensureJsMap = (parent: Map<unknown, unknown>, key: string): Map<unknown, unknown> => {
    const existing = parent.get(key);
    if (existing instanceof Map) return existing;
    const created = new Map<unknown, unknown>();
    parent.set(key, created);
    return created;
  };
  const expPlugins = ensureJsMap(expectedAfter, "plugins");
  const expEntries = ensureJsMap(expPlugins, "entries");
  const expNav = ensureJsMap(expEntries, navKey);
  const expSettings = ensureJsMap(expNav, "settings");
  expSettings.set("enabled", enabled);

  const reparsed = parseValidatedHermesDocument(serialized);
  const afterRaw = reparsed.doc.toJS({ maxAliasCount: 100, mapAsMap: true }) as unknown;
  if (
    !(afterRaw instanceof Map) ||
    readHermesPluginEnabled(serialized) !== enabled ||
    !isDeepStrictEqual(afterRaw, expectedAfter)
  ) {
    throw new Error("hermes_invalid_config_yaml");
  }
  return serialized;
}

interface HermesConfigTarget {
  profile: string;
  configPath: string;
}

interface DiscoveryResult {
  installed: boolean;
  realRoot?: string;
  configs: HermesConfigTarget[];
  error?: string;
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function unicodeCompare(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  for (let index = 0; index < Math.min(leftChars.length, rightChars.length); index++) {
    const difference = leftChars[index].codePointAt(0)! - rightChars[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return leftChars.length - rightChars.length;
}

function compareRelPathParts(left: string, right: string): number {
  const lp = left.split("/");
  const rp = right.split("/");
  for (let i = 0; i < Math.min(lp.length, rp.length); i++) {
    const cmp = unicodeCompare(lp[i], rp[i]);
    if (cmp !== 0) return cmp;
  }
  return lp.length - rp.length;
}

function assertSafeDirWithinRoot(dirPath: string, realRoot: string, errCode = "unsafe_hermes_path"): string {
  const st = lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(errCode);
  }
  const real = realpathSync(dirPath);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error(errCode);
  }
  return real;
}

function assertSafeFileWithinRoot(filePath: string, realRoot: string, errCode = "unsafe_hermes_config_path"): void {
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(errCode);
  }
  const real = realpathSync(filePath);
  if (real !== join(realRoot, "config.yaml") && !real.startsWith(realRoot + sep)) {
    throw new Error(errCode);
  }
}

function computePythonPackageFingerprint(packageDir: string, realRoot: string): string {
  assertSafeDirWithinRoot(packageDir, realRoot, "unsafe_hermes_plugin_path");
  const files: { relPosix: string; absPath: string }[] = [];

  const walk = (currentDir: string, relPrefix: string): void => {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "__pycache__") continue;
      const fullPath = join(currentDir, entry.name);
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        throw new Error("unsafe_hermes_plugin_path");
      }
      const realEntry = realpathSync(fullPath);
      if (!realEntry.startsWith(realRoot + sep)) {
        throw new Error("unsafe_hermes_plugin_path");
      }
      const relPosix = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (st.isDirectory()) {
        walk(fullPath, relPosix);
      } else if (st.isFile() && entry.name.endsWith(".py")) {
        files.push({ relPosix, absPath: fullPath });
      }
    }
  };

  walk(packageDir, "");
  if (files.length === 0) {
    throw new Error("hermes_plugin_outdated");
  }
  files.sort((a, b) => compareRelPathParts(a.relPosix, b.relPosix));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relPosix, "utf8");
    hash.update("\0");
    hash.update(readFileSync(file.absPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function inspectHermesPluginInstall(home: string): HermesPluginInstallCheck {
  const hermesDir = join(home, ".hermes");
  if (!existsSync(hermesDir)) {
    return { pluginInstalled: false, protectionSupportedOnDisk: false, pluginDirs: [], reason: "hermes_not_installed" };
  }
  const rootStat = lstatSync(hermesDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { pluginInstalled: false, protectionSupportedOnDisk: false, pluginDirs: [], error: "unsafe_hermes_path" };
  }
  const realRoot = realpathSync(hermesDir);
  const pluginDirs: string[] = [];

  const collectPluginDir = (baseDir: string): void => {
    const pluginsParent = join(baseDir, "plugins");
    if (!existsSync(pluginsParent)) return;
    assertSafeDirWithinRoot(pluginsParent, realRoot, "unsafe_hermes_plugin_path");
    const candidate = join(pluginsParent, "session-navigation");
    if (!existsSync(candidate)) return;
    assertSafeDirWithinRoot(candidate, realRoot, "unsafe_hermes_plugin_path");
    pluginDirs.push(candidate);
  };

  try {
    collectPluginDir(hermesDir);
    const profilesDir = join(hermesDir, "profiles");
    if (existsSync(profilesDir)) {
      assertSafeDirWithinRoot(profilesDir, realRoot, "unsafe_hermes_profiles_path");
      const entries = readdirSync(profilesDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.includes("/") || entry.name.includes("\\")) continue;
        const profDir = join(profilesDir, entry.name);
        const profStat = lstatSync(profDir);
        if (profStat.isSymbolicLink()) {
          throw new Error("unsafe_hermes_profiles_path");
        }
        if (!profStat.isDirectory()) continue;
        assertSafeDirWithinRoot(profDir, realRoot, "unsafe_hermes_profiles_path");
        collectPluginDir(profDir);
      }
    }
  } catch (err) {
    return {
      pluginInstalled: pluginDirs.length > 0,
      protectionSupportedOnDisk: false,
      pluginDirs,
      error: err instanceof Error ? err.message : "unsafe_hermes_plugin_path",
    };
  }

  if (pluginDirs.length === 0) {
    return {
      pluginInstalled: false,
      protectionSupportedOnDisk: false,
      pluginDirs: [],
      reason: "hermes_plugin_not_installed",
    };
  }

  let sharedFingerprint: string | undefined;
  try {
    for (const pluginDir of pluginDirs) {
      const vendorDir = join(pluginDir, "vendor");
      const coreDir = join(vendorDir, "session_navigation");
      const adapterDir = join(vendorDir, "session_navigation_hermes");
      if (!existsSync(vendorDir) || !existsSync(coreDir) || !existsSync(adapterDir)) {
        return {
          pluginInstalled: true,
          protectionSupportedOnDisk: false,
          pluginDirs,
          reason: "hermes_plugin_outdated",
        };
      }
      assertSafeDirWithinRoot(vendorDir, realRoot, "unsafe_hermes_plugin_path");
      assertSafeDirWithinRoot(coreDir, realRoot, "unsafe_hermes_plugin_path");
      assertSafeDirWithinRoot(adapterDir, realRoot, "unsafe_hermes_plugin_path");

      const factoriesPath = join(adapterDir, "factories.py");
      const registryPath = join(coreDir, "adapter_registry.py");
      if (!existsSync(factoriesPath) || !existsSync(registryPath)) {
        return {
          pluginInstalled: true,
          protectionSupportedOnDisk: false,
          pluginDirs,
          reason: "hermes_plugin_outdated",
        };
      }
      assertSafeFileWithinRoot(factoriesPath, realRoot, "unsafe_hermes_plugin_path");
      assertSafeFileWithinRoot(registryPath, realRoot, "unsafe_hermes_plugin_path");

      const factoriesText = readFileSync(factoriesPath, "utf8");
      const registryText = readFileSync(registryPath, "utf8");
      const hasMarkers =
        factoriesText.includes("_protection_only_rewrite") &&
        factoriesText.includes("_is_effectively_enabled") &&
        factoriesText.includes('"protection_only"') &&
        factoriesText.includes("RUNTIME_BUNDLE_FINGERPRINT") &&
        registryText.includes('"protection_only"') &&
        registryText.includes("get_adapter_control");
      if (!hasMarkers) {
        return {
          pluginInstalled: true,
          protectionSupportedOnDisk: false,
          pluginDirs,
          reason: "hermes_plugin_outdated",
        };
      }

      const coreFp = computePythonPackageFingerprint(coreDir, realRoot);
      const adapterFp = computePythonPackageFingerprint(adapterDir, realRoot);
      const fp = sha256Hex(`${coreFp}:${adapterFp}`);
      if (sharedFingerprint === undefined) {
        sharedFingerprint = fp;
      } else if (sharedFingerprint !== fp) {
        return {
          pluginInstalled: true,
          protectionSupportedOnDisk: false,
          pluginDirs,
          reason: "hermes_plugin_version_mismatch",
        };
      }
    }
  } catch (err) {
    const code = err instanceof Error ? err.message : "hermes_plugin_outdated";
    if (code === "hermes_plugin_outdated") {
      return {
        pluginInstalled: true,
        protectionSupportedOnDisk: false,
        pluginDirs,
        reason: "hermes_plugin_outdated",
      };
    }
    return {
      pluginInstalled: true,
      protectionSupportedOnDisk: false,
      pluginDirs,
      error: code,
    };
  }

  return {
    pluginInstalled: true,
    protectionSupportedOnDisk: true,
    bundleFingerprint: sharedFingerprint,
    pluginDirs,
  };
}

function discoverHermesConfigs(home: string): DiscoveryResult {
  const hermesDir = join(home, ".hermes");
  if (!existsSync(hermesDir)) {
    return { installed: false, configs: [] };
  }
  const rootStat = lstatSync(hermesDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { installed: false, configs: [], error: "unsafe_hermes_path" };
  }
  const realRoot = realpathSync(hermesDir);
  const configs: HermesConfigTarget[] = [];

  const checkFile = (candidate: string): string | null => {
    if (!existsSync(candidate)) return null;
    assertSafeFileWithinRoot(candidate, realRoot, "unsafe_hermes_config_path");
    return candidate;
  };

  try {
    const defaultCfg = checkFile(join(hermesDir, "config.yaml"));
    if (defaultCfg) configs.push({ profile: "default", configPath: defaultCfg });

    const profilesDir = join(hermesDir, "profiles");
    if (existsSync(profilesDir)) {
      const pStat = lstatSync(profilesDir);
      if (pStat.isSymbolicLink() || !pStat.isDirectory()) {
        return { installed: true, realRoot, configs, error: "unsafe_hermes_profiles_path" };
      }
      const entries = readdirSync(profilesDir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.includes("/") || entry.name.includes("\\")) continue;
        const profDir = join(profilesDir, entry.name);
        const profStat = lstatSync(profDir);
        if (profStat.isSymbolicLink()) {
          throw new Error("unsafe_hermes_profiles_path");
        }
        if (!profStat.isDirectory()) continue;
        const realProf = realpathSync(profDir);
        if (!realProf.startsWith(realRoot + sep)) {
          throw new Error("unsafe_hermes_profiles_path");
        }
        const profCfg = checkFile(join(profDir, "config.yaml"));
        if (profCfg) configs.push({ profile: entry.name, configPath: profCfg });
      }
    }
    return { installed: true, realRoot, configs };
  } catch (err) {
    return {
      installed: true,
      realRoot,
      configs,
      error: err instanceof Error ? err.message : "hermes_discovery_error",
    };
  }
}

function readProfileStates(targets: readonly HermesConfigTarget[]): HermesProfileToggleState[] {
  return targets.map((target) => {
    let enabled = false;
    try {
      if (existsSync(target.configPath)) {
        enabled = readHermesPluginEnabled(readFileSync(target.configPath, "utf8"));
      }
    } catch {
      enabled = false;
    }
    return {
      profile: target.profile,
      configPath: target.configPath,
      enabled,
    };
  });
}

function hermesScopeAliases(scopeKey: string): string[] {
  const parts = scopeKey.split(":");
  if (parts.length === 4 && parts[0] === "hermes" && (parts[3] === "unknown" || parts[3] === "default")) {
    const alt = parts[3] === "unknown" ? "default" : "unknown";
    return [scopeKey, `${parts[0]}:${parts[1]}:${parts[2]}:${alt}`];
  }
  return [scopeKey];
}

interface ToggleJournalEntry {
  profile: string;
  configPath: string;
  existed: boolean;
  previousSha: string | null;
  nextSha: string;
  committed: boolean;
  rollbackFailed?: boolean;
}

interface ToggleJournal {
  id: string;
  targetEnabled: boolean;
  startedAt: number;
  status: "in_progress" | "rollback_failed";
  error?: string;
  entries: ToggleJournalEntry[];
}

function assertNonSymlinkIfExists(filePath: string, realRoot: string): void {
  if (!existsSync(filePath)) return;
  const st = lstatSync(filePath);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error("unsafe_hermes_path");
  }
  const real = realpathSync(filePath);
  if (dirname(real) !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error("unsafe_hermes_path");
  }
}

// A toggle lock older than this with a verifiably dead owner is treated as
// stale (previous process crashed) and recovered instead of deadlocking
// every future toggle (P1-9).
const TOGGLE_LOCK_STALE_MS = 120_000;

interface ToggleLockPayload {
  pid?: unknown;
  startedAt?: unknown;
  nonce?: unknown;
}

function isToggleLockPayload(value: unknown): value is ToggleLockPayload {
  return !!value && typeof value === "object";
}

function isLockOwnerAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ESRCH") return false;
    // EPERM and friends mean a process exists but cannot be signaled.
    return true;
  }
}

function readToggleLockPayload(lockPath: string): ToggleLockPayload | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    return isToggleLockPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isToggleLockStale(lockPath: string, now: number): boolean {
  const payload = readToggleLockPayload(lockPath);
  const startedAt = payload && typeof payload.startedAt === "number" ? payload.startedAt : null;
  let ageMs: number | null =
    startedAt !== null && Number.isFinite(startedAt) ? now - startedAt : null;
  if (ageMs === null) {
    try {
      ageMs = now - statSync(lockPath).mtimeMs;
    } catch {
      return false;
    }
  }
  if (ageMs < TOGGLE_LOCK_STALE_MS) return false;
  // Only steal the lock when its owner is verifiably gone; a live owner
  // keeps the lock even when old.
  return !isLockOwnerAlive(payload?.pid);
}

function acquireToggleLock(realRoot: string): () => void {
  const lockPath = join(realRoot, TOGGLE_LOCK_NAME);
  const nonce = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce });

  try {
    const st = lstatSync(lockPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("unsafe_hermes_path");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw err;
    }
    try {
      const st = lstatSync(lockPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error("unsafe_hermes_path");
      }
    } catch (statErr) {
      if (statErr instanceof Error && statErr.message === "unsafe_hermes_path") {
        throw statErr;
      }
    }
    // P1-9: recover a stale lock left by a crashed toggle instead of
    // deadlocking; a live owner keeps the lock and still fails here.
    if (!isToggleLockStale(lockPath, Date.now())) {
      throw new Error("hermes_toggle_locked");
    }
    try {
      unlinkSync(lockPath);
    } catch {
      throw new Error("hermes_toggle_locked");
    }
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch {
      throw new Error("hermes_toggle_locked");
    }
  }

  let ownedStat: ReturnType<typeof fstatSync>;
  try {
    try {
      writeSync(fd, payload, 0, "utf8");
      ownedStat = fstatSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* best-effort cleanup on failed initialization */
    }
    throw err;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const st = lstatSync(lockPath);
      if (st.isSymbolicLink() || !st.isFile()) return;
      if (st.dev !== ownedStat.dev || st.ino !== ownedStat.ino) return;
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as {
        nonce?: unknown;
        pid?: unknown;
      };
      if (current?.nonce === nonce && current?.pid === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort unlock */
    }
  };
}

function readToggleJournal(realRoot: string): ToggleJournal | null {
  const journalPath = join(realRoot, TOGGLE_JOURNAL_NAME);
  if (!existsSync(journalPath)) return null;
  assertNonSymlinkIfExists(journalPath, realRoot);
  const raw = readFileSync(journalPath, "utf8");
  const parsed = JSON.parse(raw) as ToggleJournal;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error("hermes_corrupt_toggle_journal");
  }
  return parsed;
}

function writeToggleJournal(realRoot: string, journal: ToggleJournal): void {
  const journalPath = join(realRoot, TOGGLE_JOURNAL_NAME);
  assertNonSymlinkIfExists(journalPath, realRoot);
  const tmpPath = join(
    realRoot,
    `.session-navigation-toggle.journal.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`,
  );
  // P1-9: a failed journal write (disk full, permissions, racing journal
  // path) must not leak the temp file.
  try {
    writeFileSync(tmpPath, JSON.stringify(journal, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, journalPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

function removeToggleJournal(realRoot: string): void {
  const journalPath = join(realRoot, TOGGLE_JOURNAL_NAME);
  if (!existsSync(journalPath)) return;
  assertNonSymlinkIfExists(journalPath, realRoot);
  unlinkSync(journalPath);
}

export function acquireHermesToggleLock(
  home: string,
): { ok: true; realRoot: string; release: () => void } | { ok: false; error: string } {
  const hermesDir = join(home, ".hermes");
  if (!existsSync(hermesDir)) {
    return { ok: false, error: "hermes_not_installed" };
  }
  try {
    const st = lstatSync(hermesDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, error: "unsafe_hermes_path" };
    }
    const realRoot = realpathSync(hermesDir);
    const release = acquireToggleLock(realRoot);
    return { ok: true, realRoot, release };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "hermes_toggle_locked",
    };
  }
}

export function inspectHermesToggle(
  home: string,
  fallbackEnabled?: boolean,
  runtime?: HermesRuntimeInspectionContext,
): HermesToggleStatus {
  const discovery = discoverHermesConfigs(home);
  if (!discovery.installed) {
    return {
      installed: false,
      enabled: false,
      profileCount: 0,
      pluginInstalled: false,
      protectionSupportedOnDisk: false,
      protectionVerified: false,
      canDisable: false,
      statusText: discovery.error ? undefined : "Not installed",
      ...(discovery.error ? { error: discovery.error } : {}),
    };
  }
  if (discovery.error) {
    return {
      installed: true,
      enabled: false,
      stateUnknown: true,
      profileCount: discovery.configs.length,
      pluginInstalled: false,
      protectionSupportedOnDisk: false,
      protectionVerified: false,
      canDisable: false,
      statusText: `State unknown (${discovery.error}).`,
      error: discovery.error,
    };
  }

  const install = inspectHermesPluginInstall(home);
  if (install.error) {
    return {
      installed: true,
      enabled: false,
      stateUnknown: true,
      profileCount: discovery.configs.length,
      pluginInstalled: install.pluginInstalled,
      protectionSupportedOnDisk: false,
      protectionVerified: false,
      canDisable: false,
      statusText: `State unknown (${install.error}).`,
      error: install.error,
    };
  }

  let pendingJournal: ToggleJournal | null = null;
  if (discovery.realRoot) {
    try {
      assertNonSymlinkIfExists(join(discovery.realRoot, TOGGLE_LOCK_NAME), discovery.realRoot);
      pendingJournal = readToggleJournal(discovery.realRoot);
    } catch (err) {
      return {
        installed: true,
        enabled: false,
        stateUnknown: true,
        profileCount: discovery.configs.length,
        pluginInstalled: install.pluginInstalled,
        protectionSupportedOnDisk: install.protectionSupportedOnDisk,
        protectionVerified: false,
        canDisable: false,
        partialUpdate: true,
        mixed: true,
        statusText: "Journal error (state unknown).",
        error: err instanceof Error ? err.message : "hermes_corrupt_toggle_journal",
      };
    }
  }

  const profiles: HermesProfileToggleState[] = [];
  let enabledCount = 0;
  try {
    for (const cfg of discovery.configs) {
      const content = readFileSync(cfg.configPath, "utf8");
      const profEnabled = readHermesPluginEnabled(content);
      if (profEnabled) enabledCount++;
      profiles.push({
        profile: cfg.profile,
        configPath: cfg.configPath,
        enabled: profEnabled,
      });
    }
  } catch (err) {
    return {
      installed: true,
      enabled: false,
      stateUnknown: true,
      profileCount: discovery.configs.length,
      pluginInstalled: install.pluginInstalled,
      protectionSupportedOnDisk: install.protectionSupportedOnDisk,
      protectionVerified: false,
      canDisable: false,
      rolledBack: false,
      partialUpdate: false,
      statusText: "Config YAML error (state unknown).",
      warning:
        "One or more Hermes config.yaml files contain invalid or unsupported YAML; state cannot be determined.",
      error: err instanceof Error ? err.message : "hermes_read_failed",
    };
  }

  const profileCount = profiles.length;
  const controlEnabled = runtime?.control !== undefined ? runtime.control?.enabled : undefined;
  const enabled =
    controlEnabled === false
      ? false
      : controlEnabled === true
        ? profileCount > 0
          ? enabledCount > 0
          : true
        : (fallbackEnabled ?? (profileCount > 0 ? enabledCount > 0 : false));

  const hasPendingJournal = pendingJournal !== null;
  const diskProfilesMixed = enabledCount > 0 && enabledCount < profileCount;
  const enabledControlMismatch =
    controlEnabled === true && profileCount > 0 && enabledCount < profileCount;
  const mixed = diskProfilesMixed || enabledControlMismatch || hasPendingJournal;

  const baseSummary =
    controlEnabled === false
      ? profileCount === 0
        ? "Paused via DB control (no profile config.yaml)."
        : `Paused via DB control (${profileCount} ${profileCount === 1 ? "profile" : "profiles"}).`
      : profileCount === 0
        ? "No profile config.yaml found."
        : mixed
          ? `${enabledCount}/${profileCount} profiles enabled (mixed).`
          : `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} (${enabled ? "enabled" : "config disabled"}).`;

  // Durable SQLite adapter_sessions holds one row per scope_key and cannot enumerate
  // live/stale/duplicate OS processes or frozen PluginContext.get_config workers.
  const protectionVerified = false;
  // Pausing via Paseo Settings only updates shared SQLite adapter_control while keeping
  // config.yaml intact, so older Hermes processes continue protecting hidden items.
  const canDisable = true;

  let unverifiedScopes: string[] = [];
  if (runtime) {
    const now = runtime.now ?? Date.now() / 1000;
    const isRegVerified = (reg: HermesRuntimeSessionInfo): boolean =>
      Boolean(
        install.protectionSupportedOnDisk &&
          install.bundleFingerprint &&
          reg.adapter_protocol === 1 &&
          reg.capabilities?.protection_only === true &&
          reg.capabilities?.bundle_fingerprint === install.bundleFingerprint,
      );

    const regByScope = new Map<string, HermesRuntimeSessionInfo>();
    const verifiedByProfile = new Map<string, HermesRuntimeSessionInfo[]>();
    let verifiedSessionCount = 0;

    for (const reg of runtime.registeredSessions ?? []) {
      regByScope.set(reg.scope_key, reg);
      if (isRegVerified(reg)) {
        verifiedSessionCount++;
        const profile = reg.scope_key.split(":")[1] || "default";
        const list = verifiedByProfile.get(profile) ?? [];
        list.push(reg);
        verifiedByProfile.set(profile, list);
      }
    }

    const isScopeVerified = (scopeKey: string): boolean =>
      hermesScopeAliases(scopeKey).some((alias) => {
        const reg = regByScope.get(alias);
        return reg ? isRegVerified(reg) : false;
      });

    const unverified = new Set<string>();
    for (const hiddenScope of runtime.hiddenScopes ?? []) {
      if (!isScopeVerified(hiddenScope)) {
        unverified.add(hiddenScope);
      }
    }
    for (const boundScope of runtime.boundScopes ?? []) {
      if (!isScopeVerified(boundScope)) {
        unverified.add(boundScope);
      }
    }
    for (const reg of runtime.registeredSessions ?? []) {
      if (isRegVerified(reg)) continue;
      const profile = reg.scope_key.split(":")[1] || "default";
      const profileVerified = verifiedByProfile.get(profile) ?? [];
      const recentlyActive = now - reg.last_seen < 300;
      const superseded = profileVerified.some((v) => v.last_seen >= reg.last_seen);
      if (recentlyActive || !superseded) {
        unverified.add(reg.scope_key);
      }
    }
    for (const prof of profiles) {
      if (prof.enabled && (verifiedByProfile.get(prof.profile)?.length ?? 0) === 0) {
        unverified.add(`profile:${prof.profile}`);
      }
    }
    if (verifiedSessionCount === 0) {
      unverified.add("hermes:runtime:unverified");
    }

    unverifiedScopes = [...unverified];
  }

  const journalUpdatedFiles = pendingJournal
    ? pendingJournal.entries.filter((e) => e.committed && !e.rollbackFailed).map((e) => e.configPath)
    : undefined;
  const journalRollbackFailedFiles = pendingJournal
    ? pendingJournal.entries.filter((e) => e.rollbackFailed).map((e) => e.configPath)
    : undefined;

  let warning: string | undefined;
  let remediation: string | undefined;

  if (pendingJournal) {
    warning = `Unresolved toggle journal (${pendingJournal.status}); use 'Enable all profiles' to reconcile (if blocked by a stale lock after a crash, remove ~/.hermes/.session-navigation-toggle.lock first).`;
    remediation = "Use 'Enable all profiles' to align all Hermes profile configs and SQLite state.";
  } else if (!install.pluginInstalled) {
    warning =
      "Hermes plugin is not installed; install it and restart Hermes and its gateway. DB failures may send original content.";
  } else if (!install.protectionSupportedOnDisk) {
    warning =
      install.reason === "hermes_plugin_version_mismatch"
        ? "Installed Hermes plugin copies differ across directories; update and restart Hermes and its gateway. DB failures may send original content."
        : "Installed plugin is outdated (keeps config.yaml enabled); update and restart Hermes and its gateway. DB failures may send original content.";
  } else if (controlEnabled === false) {
    warning =
      "Pause requested (keeps config.yaml enabled). Older Hermes sessions may keep running; restart Hermes and its gateway after updating. DB failures may send original content.";
  } else if (mixed) {
    warning =
      "Hermes profile configs and SQLite state are out of sync. Older Hermes sessions may keep running; restart Hermes and its gateway after updating.";
    remediation = "Use 'Enable all profiles' to align all Hermes profile configs and SQLite state.";
  } else {
    warning =
      "Older Hermes sessions may keep running; restart Hermes and its gateway after updating. DB failures may send original content.";
  }

  const statusText = baseSummary;

  return {
    installed: true,
    enabled,
    profileCount,
    enabledProfileCount: enabledCount,
    ...(mixed ? { mixed: true } : {}),
    canDisable,
    protectionVerified,
    pluginInstalled: install.pluginInstalled,
    protectionSupportedOnDisk: install.protectionSupportedOnDisk,
    ...(unverifiedScopes.length > 0 ? { unverifiedScopes } : {}),
    profiles,
    ...(hasPendingJournal ? { partialUpdate: true } : {}),
    ...(journalUpdatedFiles && journalUpdatedFiles.length > 0 ? { updatedFiles: journalUpdatedFiles } : {}),
    ...(journalRollbackFailedFiles && journalRollbackFailedFiles.length > 0
      ? { rollbackFailedFiles: journalRollbackFailedFiles }
      : {}),
    statusText,
    ...(warning ? { warning } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

interface PreparedTarget extends HermesConfigTarget {
  existed: boolean;
  mode: number;
  previousContent: string;
  previousSha: string | null;
  nextContent: string;
  nextSha: string;
}

interface StagedTarget extends PreparedTarget {
  tmpPath: string;
}

export function setHermesToggleAcrossProfiles(
  home: string,
  enabled: boolean,
  options?: HermesWriteOptions,
): HermesSetToggleResult {
  const discovery = discoverHermesConfigs(home);
  if (!discovery.installed || !discovery.realRoot) {
    return {
      ok: false,
      error: discovery.error ?? "hermes_not_installed",
      updatedFiles: [],
      rolledBack: false,
      partialUpdate: false,
      rolledBackFiles: [],
      rollbackFailedFiles: [],
      profiles: [],
    };
  }
  if (discovery.error) {
    return {
      ok: false,
      error: discovery.error,
      updatedFiles: [],
      rolledBack: false,
      partialUpdate: false,
      rolledBackFiles: [],
      rollbackFailedFiles: [],
      profiles: readProfileStates(discovery.configs),
    };
  }

  const realRoot = discovery.realRoot;
  let releaseLock: (() => void) | undefined;
  if (!options?.lockAlreadyHeld) {
    try {
      releaseLock = acquireToggleLock(realRoot);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "hermes_toggle_locked",
        updatedFiles: [],
        rolledBack: false,
        partialUpdate: false,
        rolledBackFiles: [],
        rollbackFailedFiles: [],
        profiles: readProfileStates(discovery.configs),
      };
    }
  }

  try {
    const targets: HermesConfigTarget[] =
      discovery.configs.length > 0
        ? discovery.configs
        : [{ profile: "default", configPath: join(home, ".hermes", "config.yaml") }];

    const writeFileImpl =
      options?.writeFileImpl ??
      ((p: string, data: string, opts: { encoding: "utf8"; mode: number }) => writeFileSync(p, data, opts));
    const renameImpl = options?.renameImpl ?? ((o: string, n: string) => renameSync(o, n));
    const unlinkImpl = options?.unlinkImpl ?? ((p: string) => unlinkSync(p));

    // Phase 1: Pre-validate every target path and YAML mutation before writing anything.
    const prepared: PreparedTarget[] = [];
    try {
      for (const target of targets) {
        assertSafeDirWithinRoot(dirname(target.configPath), realRoot, "unsafe_hermes_path");
        const existed = existsSync(target.configPath);
        let mode = 0o644;
        let previousContent = "";
        let previousSha: string | null = null;
        if (existed) {
          assertSafeFileWithinRoot(target.configPath, realRoot, "unsafe_hermes_config_path");
          mode = lstatSync(target.configPath).mode & 0o777;
          previousContent = readFileSync(target.configPath, "utf8");
          previousSha = sha256Hex(previousContent);
        }
        const nextContent = patchHermesConfigYaml(previousContent, enabled);
        prepared.push({
          ...target,
          existed,
          mode,
          previousContent,
          previousSha,
          nextContent,
          nextSha: sha256Hex(nextContent),
        });
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "hermes_prevalidation_failed",
        updatedFiles: [],
        rolledBack: false,
        partialUpdate: false,
        rolledBackFiles: [],
        rollbackFailedFiles: [],
        profiles: readProfileStates(targets),
      };
    }

    // Phase 2: Stage temp files for all targets prior to committing any live config.
    const staged: StagedTarget[] = [];
    const cleanupTempFiles = (items: readonly StagedTarget[]) => {
      for (const item of items) {
        try {
          if (existsSync(item.tmpPath)) unlinkImpl(item.tmpPath);
        } catch {
          /* best effort cleanup */
        }
      }
    };

    try {
      for (const item of prepared) {
        assertSafeDirWithinRoot(dirname(item.configPath), realRoot, "unsafe_hermes_path");
        const tmpPath = join(
          dirname(item.configPath),
          `.${basename(item.configPath)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`,
        );
        writeFileImpl(tmpPath, item.nextContent, { encoding: "utf8", mode: item.mode });
        staged.push({ ...item, tmpPath });
      }
    } catch (err) {
      cleanupTempFiles(staged);
      return {
        ok: false,
        error: err instanceof Error ? err.message : "hermes_stage_failed",
        updatedFiles: [],
        rolledBack: false,
        partialUpdate: false,
        rolledBackFiles: [],
        rollbackFailedFiles: [],
        profiles: readProfileStates(targets),
      };
    }

    const journal: ToggleJournal = {
      id: randomUUID(),
      targetEnabled: enabled,
      startedAt: Date.now(),
      status: "in_progress",
      entries: staged.map((item) => ({
        profile: item.profile,
        configPath: item.configPath,
        existed: item.existed,
        previousSha: item.previousSha,
        nextSha: item.nextSha,
        committed: false,
      })),
    };
    // P1-9: a journal write failure must surface as an error and clean up
    // staged temp files instead of throwing with temps leaked.
    try {
      writeToggleJournal(realRoot, journal);
    } catch (err) {
      cleanupTempFiles(staged);
      return {
        ok: false,
        error: err instanceof Error ? err.message : "hermes_journal_write_failed",
        updatedFiles: [],
        rolledBack: false,
        partialUpdate: false,
        rolledBackFiles: [],
        rollbackFailedFiles: [],
        profiles: readProfileStates(targets),
      };
    }

    const rollbackCommitted = (committedItems: readonly StagedTarget[], failureError?: string) => {
      const rolledBackFiles: string[] = [];
      const rollbackFailedFiles: string[] = [];
      const failedSet = new Set<string>();
      for (let i = committedItems.length - 1; i >= 0; i--) {
        const item = committedItems[i];
        let rbTmp: string | undefined;
        try {
          options?.onBeforeRollbackFile?.(item.configPath, i);
          assertSafeDirWithinRoot(dirname(item.configPath), realRoot, "unsafe_hermes_path");
          if (existsSync(item.configPath)) {
            assertSafeFileWithinRoot(item.configPath, realRoot, "unsafe_hermes_config_path");
            const currentSha = sha256Hex(readFileSync(item.configPath, "utf8"));
            if (currentSha !== item.nextSha) {
              throw new Error("hermes_concurrent_modification_during_rollback");
            }
          }
          if (item.existed) {
            rbTmp = join(
              dirname(item.configPath),
              `.${basename(item.configPath)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.rb.tmp`,
            );
            writeFileImpl(rbTmp, item.previousContent, { encoding: "utf8", mode: item.mode });
            renameImpl(rbTmp, item.configPath);
          } else if (existsSync(item.configPath)) {
            unlinkImpl(item.configPath);
          }
          rolledBackFiles.push(item.configPath);
        } catch {
          if (rbTmp) {
            try {
              if (existsSync(rbTmp)) unlinkImpl(rbTmp);
            } catch {
              /* best effort cleanup */
            }
          }
          rollbackFailedFiles.push(item.configPath);
          failedSet.add(item.configPath);
        }
      }
      if (rollbackFailedFiles.length === 0) {
        try {
          removeToggleJournal(realRoot);
        } catch {
          /* best effort */
        }
      } else {
        try {
          writeToggleJournal(realRoot, {
            ...journal,
            status: "rollback_failed",
            ...(failureError ? { error: failureError } : {}),
            entries: journal.entries.map((entry) => ({
              ...entry,
              rollbackFailed: failedSet.has(entry.configPath),
            })),
          });
        } catch {
          /* preserve prior journal if rewrite fails */
        }
      }
      return {
        ok: rollbackFailedFiles.length === 0,
        rolledBackFiles,
        rollbackFailedFiles,
        profiles: readProfileStates(targets),
      };
    };

    // Phase 3: Re-verify no concurrent external writer changed any target, then commit sequentially
    // and roll back committed targets in reverse order if any commit fails.
    const committed: StagedTarget[] = [];
    const clearJournal = () => {
      const journalPath = join(realRoot, TOGGLE_JOURNAL_NAME);
      options?.onBeforeClearJournal?.(journalPath);
      removeToggleJournal(realRoot);
    };
    let committedAll = false;
    try {
      for (let idx = 0; idx < staged.length; idx++) {
        const item = staged[idx];
        assertSafeDirWithinRoot(dirname(item.configPath), realRoot, "unsafe_hermes_path");
        if (item.existed) {
          if (!existsSync(item.configPath)) {
            throw new Error("hermes_concurrent_modification");
          }
          assertSafeFileWithinRoot(item.configPath, realRoot, "unsafe_hermes_config_path");
          const currentSha = sha256Hex(readFileSync(item.configPath, "utf8"));
          if (currentSha !== item.previousSha) {
            throw new Error("hermes_concurrent_modification");
          }
        } else if (existsSync(item.configPath)) {
          throw new Error("hermes_concurrent_modification");
        }
        options?.onBeforeCommitFile?.(item.configPath, idx);
        renameImpl(item.tmpPath, item.configPath);
        committed.push(item);
        journal.entries[idx].committed = true;
        writeToggleJournal(realRoot, journal);
      }
      committedAll = true;
    } catch (err) {
      cleanupTempFiles(staged.slice(committed.length));
      const errCode = err instanceof Error ? err.message : "hermes_write_failed";
      const rb = rollbackCommitted(committed, errCode);
      const rolledBack = committed.length > 0 && rb.rollbackFailedFiles.length === 0;
      const partialUpdate = rb.rollbackFailedFiles.length > 0;
      return {
        ok: false,
        error: errCode,
        updatedFiles: [...rb.rollbackFailedFiles],
        rolledBack,
        partialUpdate,
        rolledBackFiles: rb.rolledBackFiles,
        rollbackFailedFiles: rb.rollbackFailedFiles,
        profiles: rb.profiles,
      };
    }

    if (committedAll && !options?.deferJournalClear) {
      try {
        clearJournal();
      } catch (cleanupErr) {
        const cleanupReason = cleanupErr instanceof Error ? cleanupErr.message : "journal_cleanup_failed";
        return {
          ok: false,
          error: `hermes_journal_cleanup_failed:${cleanupReason}`,
          updatedFiles: committed.map((item) => item.configPath),
          rolledBack: false,
          partialUpdate: true,
          rolledBackFiles: [],
          rollbackFailedFiles: [],
          profiles: readProfileStates(targets),
        };
      }
    }
    return {
      ok: true,
      updatedFiles: committed.map((item) => item.configPath),
      rolledBack: false,
      partialUpdate: false,
      rolledBackFiles: [],
      rollbackFailedFiles: [],
      profiles: readProfileStates(targets),
      clearJournal,
      rollbackSnapshot: () => rollbackCommitted(committed, "sqlite_update_failed"),
    };
  } finally {
    releaseLock?.();
  }
}
