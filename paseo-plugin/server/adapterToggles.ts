import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export interface HermesToggleStatus {
  installed: boolean;
  enabled: boolean;
  profileCount: number;
  mixed?: boolean;
  statusText?: string;
  error?: string;
}

const ENTRY_KEY_NAMES = new Set(["session-navigation", "session_navigation"]);

function splitLineEndings(text: string): { lines: string[]; eol: string; hadTrailingEol: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingEol = text.endsWith("\n") || text.endsWith("\r");
  const raw = text.length === 0 ? [] : text.split(/\r?\n/);
  if (hadTrailingEol && raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return { lines: raw, eol, hadTrailingEol };
}

function stripInlineComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function unquoteKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface ParsedMappingLine {
  indent: number;
  key: string;
  rawValue: string;
}

function parseMappingLine(line: string): ParsedMappingLine | null {
  const stripped = stripInlineComment(line);
  if (!stripped.trim()) return null;
  const indentMatch = /^(\s*)/.exec(stripped);
  const indent = indentMatch ? indentMatch[1].length : 0;
  const body = stripped.slice(indent);
  if (body.startsWith("-")) return null;
  const colonIdx = findKeyColon(body);
  if (colonIdx <= 0) return null;
  const key = unquoteKey(body.slice(0, colonIdx));
  const rawValue = body.slice(colonIdx + 1).trim();
  return { indent, key, rawValue };
}

function findKeyColon(body: string): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") {
      const next = body[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function lineIndent(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].length : 0;
}

function findBlockEnd(lines: string[], startIndex: number, parentIndent: number): number {
  let end = startIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (isBlankOrComment(line)) {
      end++;
      continue;
    }
    const ind = lineIndent(line);
    const trimmed = line.trimStart();
    if (ind < parentIndent || (ind === parentIndent && !trimmed.startsWith("-"))) {
      break;
    }
    end++;
  }
  while (end > startIndex + 1 && isBlankOrComment(lines[end - 1])) {
    end--;
  }
  return end;
}

function findChildKey(
  lines: string[],
  startIndex: number,
  endIndex: number,
  parentIndent: number,
  match: (key: string) => boolean,
): { lineIndex: number; indent: number; rawValue: string } | null {
  let expectedIndent: number | null = null;
  let idx = startIndex;
  while (idx < endIndex) {
    const line = lines[idx];
    if (isBlankOrComment(line)) {
      idx++;
      continue;
    }
    const ind = lineIndent(line);
    if (ind <= parentIndent) break;
    if (expectedIndent === null) expectedIndent = ind;
    if (ind === expectedIndent) {
      const parsed = parseMappingLine(line);
      if (parsed && match(parsed.key)) {
        return { lineIndex: idx, indent: parsed.indent, rawValue: parsed.rawValue };
      }
      idx = findBlockEnd(lines, idx, parsed ? parsed.indent : ind);
      continue;
    }
    idx++;
  }
  return null;
}

function parseBoolScalar(raw: string): boolean | null {
  const v = stripInlineComment(raw).trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off") return false;
  return null;
}

function parseFlowSettingsEnabled(rawValue: string): boolean | null {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1);
  const match = /(?:^|,)\s*['"]?enabled['"]?\s*:\s*([^,}]+)/i.exec(inner);
  if (!match) return null;
  return parseBoolScalar(match[1]);
}

function detectChildIndent(lines: string[], startIndex: number, endIndex: number, parentIndent: number): number {
  for (let i = startIndex + 1; i < endIndex; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const ind = lineIndent(line);
    if (ind > parentIndent) return ind;
    break;
  }
  return parentIndent + 2;
}

export function readHermesPluginEnabled(yamlText: string): boolean {
  const { lines } = splitLineEndings(yamlText);
  const plugins = findChildKey(lines, 0, lines.length, -1, (k) => k === "plugins");
  if (!plugins) return false;
  const pluginsEnd = findBlockEnd(lines, plugins.lineIndex, plugins.indent);
  const entries = findChildKey(lines, plugins.lineIndex + 1, pluginsEnd, plugins.indent, (k) => k === "entries");
  if (!entries) return false;
  const entriesEnd = findBlockEnd(lines, entries.lineIndex, entries.indent);
  const navEntry = findChildKey(lines, entries.lineIndex + 1, entriesEnd, entries.indent, (k) =>
    ENTRY_KEY_NAMES.has(k),
  );
  if (!navEntry) return false;
  const navEnd = findBlockEnd(lines, navEntry.lineIndex, navEntry.indent);
  const settings = findChildKey(lines, navEntry.lineIndex + 1, navEnd, navEntry.indent, (k) => k === "settings");
  if (!settings) return false;
  const flowBool = parseFlowSettingsEnabled(settings.rawValue);
  if (flowBool !== null) return flowBool;
  const settingsEnd = findBlockEnd(lines, settings.lineIndex, settings.indent);
  const enabledKey = findChildKey(lines, settings.lineIndex + 1, settingsEnd, settings.indent, (k) => k === "enabled");
  if (!enabledKey) return false;
  return parseBoolScalar(enabledKey.rawValue) === true;
}

function replaceInlineMappingCommentPreserve(line: string, suffixLines: string[]): string {
  const stripped = stripInlineComment(line);
  const commentPart = line.slice(stripped.length);
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return line;
  const beforeValue = line.slice(0, colonIdx + 1);
  return `${beforeValue}${commentPart}`;
}

export function patchHermesConfigYaml(yamlText: string, enabled: boolean): string {
  const boolText = enabled ? "true" : "false";
  const { lines, eol } = splitLineEndings(yamlText);

  const buildBlock = (baseIndent: number, keys: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const pad = " ".repeat(baseIndent + i * 2);
      if (i === keys.length - 1) {
        out.push(`${pad}${keys[i]}: ${boolText}`);
      } else {
        out.push(`${pad}${keys[i]}:`);
      }
    }
    return out;
  };

  const plugins = findChildKey(lines, 0, lines.length, -1, (k) => k === "plugins");
  if (!plugins) {
    const addition = buildBlock(0, ["plugins", "entries", "session-navigation", "settings", "enabled"]);
    const next = [...lines, ...addition];
    return `${next.join(eol)}${eol}`;
  }

  if (plugins.rawValue === "{}") {
    lines[plugins.lineIndex] = replaceInlineMappingCommentPreserve(lines[plugins.lineIndex], []);
  }
  const pluginsEnd = findBlockEnd(lines, plugins.lineIndex, plugins.indent);
  const entriesIndent = detectChildIndent(lines, plugins.lineIndex, pluginsEnd, plugins.indent);
  const entries = findChildKey(lines, plugins.lineIndex + 1, pluginsEnd, plugins.indent, (k) => k === "entries");
  if (!entries) {
    const addition = buildBlock(entriesIndent, ["entries", "session-navigation", "settings", "enabled"]);
    lines.splice(pluginsEnd, 0, ...addition);
    return `${lines.join(eol)}${eol}`;
  }

  if (entries.rawValue === "{}") {
    lines[entries.lineIndex] = replaceInlineMappingCommentPreserve(lines[entries.lineIndex], []);
  }
  const entriesEnd = findBlockEnd(lines, entries.lineIndex, entries.indent);
  const navIndent = detectChildIndent(lines, entries.lineIndex, entriesEnd, entries.indent);
  const navEntry = findChildKey(lines, entries.lineIndex + 1, entriesEnd, entries.indent, (k) =>
    ENTRY_KEY_NAMES.has(k),
  );
  if (!navEntry) {
    const addition = buildBlock(navIndent, ["session-navigation", "settings", "enabled"]);
    lines.splice(entriesEnd, 0, ...addition);
    return `${lines.join(eol)}${eol}`;
  }

  if (navEntry.rawValue === "{}") {
    lines[navEntry.lineIndex] = replaceInlineMappingCommentPreserve(lines[navEntry.lineIndex], []);
  }
  const navEnd = findBlockEnd(lines, navEntry.lineIndex, navEntry.indent);
  const settingsIndent = detectChildIndent(lines, navEntry.lineIndex, navEnd, navEntry.indent);
  const settings = findChildKey(lines, navEntry.lineIndex + 1, navEnd, navEntry.indent, (k) => k === "settings");
  if (!settings) {
    const addition = buildBlock(settingsIndent, ["settings", "enabled"]);
    lines.splice(navEnd, 0, ...addition);
    return `${lines.join(eol)}${eol}`;
  }

  if (settings.rawValue.startsWith("{") && settings.rawValue.endsWith("}")) {
    const rawLine = lines[settings.lineIndex];
    const stripped = stripInlineComment(rawLine);
    const comment = rawLine.slice(stripped.length);
    const openIdx = stripped.indexOf("{");
    const closeIdx = stripped.lastIndexOf("}");
    const inner = stripped.slice(openIdx + 1, closeIdx).trim();
    if (!inner) {
      lines[settings.lineIndex] = `${stripped.slice(0, openIdx).trimEnd()}${comment}`;
      const enabledIndent = settings.indent + 2;
      lines.splice(settings.lineIndex + 1, 0, `${" ".repeat(enabledIndent)}enabled: ${boolText}`);
      return `${lines.join(eol)}${eol}`;
    }
    if (/(?:^|,)\s*['"]?enabled['"]?\s*:/.test(inner)) {
      const patchedInner = inner.replace(
        /((?:^|,)\s*['"]?enabled['"]?\s*:\s*)([^\s,}]+)/,
        `$1${boolText}`,
      );
      lines[settings.lineIndex] = `${stripped.slice(0, openIdx + 1)} ${patchedInner} }${comment}`;
      return `${lines.join(eol)}${eol}`;
    }
    lines[settings.lineIndex] = `${stripped.slice(0, openIdx + 1)} ${inner}, enabled: ${boolText} }${comment}`;
    return `${lines.join(eol)}${eol}`;
  }

  const settingsEnd = findBlockEnd(lines, settings.lineIndex, settings.indent);
  const enabledIndent = detectChildIndent(lines, settings.lineIndex, settingsEnd, settings.indent);
  const enabledKey = findChildKey(lines, settings.lineIndex + 1, settingsEnd, settings.indent, (k) => k === "enabled");
  if (!enabledKey) {
    lines.splice(settingsEnd, 0, `${" ".repeat(enabledIndent)}enabled: ${boolText}`);
    return `${lines.join(eol)}${eol}`;
  }

  const existingLine = lines[enabledKey.lineIndex];
  const updatedLine = existingLine.replace(
    /^(\s*['"]?enabled['"]?\s*:\s*)([^\s#]+)(.*)$/,
    `$1${boolText}$3`,
  );
  lines[enabledKey.lineIndex] = updatedLine === existingLine
    ? `${" ".repeat(enabledKey.indent)}enabled: ${boolText}`
    : updatedLine;
  return `${lines.join(eol)}${eol}`;
}

interface DiscoveryResult {
  installed: boolean;
  realRoot?: string;
  configs: string[];
  error?: string;
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
  const configs: string[] = [];

  const checkFile = (candidate: string): string | null => {
    if (!existsSync(candidate)) return null;
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("unsafe_hermes_config_path");
    }
    const real = realpathSync(candidate);
    if (real !== join(realRoot, "config.yaml") && !real.startsWith(realRoot + sep)) {
      throw new Error("unsafe_hermes_config_path");
    }
    return candidate;
  };

  try {
    const defaultCfg = checkFile(join(hermesDir, "config.yaml"));
    if (defaultCfg) configs.push(defaultCfg);

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
        if (profStat.isSymbolicLink() || !profStat.isDirectory()) continue;
        const realProf = realpathSync(profDir);
        if (!realProf.startsWith(realRoot + sep)) continue;
        const profCfg = checkFile(join(profDir, "config.yaml"));
        if (profCfg) configs.push(profCfg);
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

function writeConfigAtomically(filePath: string, content: string, realHermesRoot: string): void {
  const dir = dirname(filePath);
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error("unsafe_hermes_path");
  }
  const realDir = realpathSync(dir);
  if (realDir !== realHermesRoot && !realDir.startsWith(realHermesRoot + sep)) {
    throw new Error("unsafe_hermes_path");
  }
  let mode = 0o644;
  if (existsSync(filePath)) {
    const fileStat = lstatSync(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error("unsafe_hermes_config_path");
    }
    mode = fileStat.mode & 0o777;
  }
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

export function inspectHermesToggle(home: string, fallbackEnabled?: boolean): HermesToggleStatus {
  const discovery = discoverHermesConfigs(home);
  if (!discovery.installed) {
    return {
      installed: false,
      enabled: false,
      profileCount: 0,
      statusText: discovery.error ? undefined : "Not installed",
      ...(discovery.error ? { error: discovery.error } : {}),
    };
  }
  if (discovery.error) {
    return {
      installed: true,
      enabled: false,
      profileCount: discovery.configs.length,
      error: discovery.error,
    };
  }
  if (discovery.configs.length === 0) {
    const enabled = fallbackEnabled ?? false;
    return {
      installed: true,
      enabled,
      profileCount: 0,
      statusText: "No profile config.yaml found",
    };
  }
  let enabledCount = 0;
  try {
    for (const cfg of discovery.configs) {
      const content = readFileSync(cfg, "utf8");
      if (readHermesPluginEnabled(content)) enabledCount++;
    }
  } catch (err) {
    return {
      installed: true,
      enabled: false,
      profileCount: discovery.configs.length,
      error: err instanceof Error ? err.message : "hermes_read_failed",
    };
  }
  const profileCount = discovery.configs.length;
  const enabled = enabledCount > 0;
  const mixed = enabledCount > 0 && enabledCount < profileCount;
  const statusText = mixed
    ? `${enabledCount}/${profileCount} profiles enabled (mixed)`
    : `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} (${enabled ? "enabled" : "paused"})`;
  return {
    installed: true,
    enabled,
    profileCount,
    ...(mixed ? { mixed: true } : {}),
    statusText,
  };
}

export function setHermesToggleAcrossProfiles(
  home: string,
  enabled: boolean,
): { ok: boolean; error?: string; updatedFiles: string[] } {
  const discovery = discoverHermesConfigs(home);
  if (!discovery.installed || !discovery.realRoot) {
    return { ok: false, error: discovery.error ?? "hermes_not_installed", updatedFiles: [] };
  }
  if (discovery.error) {
    return { ok: false, error: discovery.error, updatedFiles: [] };
  }
  const targets =
    discovery.configs.length > 0 ? discovery.configs : [join(home, ".hermes", "config.yaml")];
  const updatedFiles: string[] = [];
  try {
    for (const filePath of targets) {
      const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      const next = patchHermesConfigYaml(previous, enabled);
      writeConfigAtomically(filePath, next, discovery.realRoot);
      updatedFiles.push(filePath);
    }
    return { ok: true, updatedFiles };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "hermes_write_failed",
      updatedFiles,
    };
  }
}
