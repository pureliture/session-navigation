import { bytes, defaults, length, sha256, type Config } from "./model.ts";
import {
  checkRefusalReason,
  containsSensitivePattern,
  evidenceSpans,
  requiredEvidence,
  splitLines,
} from "./policy.ts";

export interface JsonProjection {
  schema: string;
  source: string;
  lines: string[];
  required: string[];
  digest: string;
}

export interface ProjectionDecision {
  projection?: JsonProjection;
  refusal?: string;
}

const PROJECTION_VERSION = 1;
const MATCHES_SCHEMA = "search_files_matches_v1";
export const FILES_SCHEMA = "search_files_files_v2";
export const FILES_REPLACEMENT_LABEL = "Projected JSON (prefix+suffix; restore with unhide_context)";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 8192;
const MAX_LIST_ITEMS = 128;
const MAX_PROJECTION_LINES = 512;
const MAX_PROJECTION_BYTES = 32 * 1024;
const MIN_LINE_BUDGET = 96;
export const MAX_PROJECTION_LINE_LENGTH = 1024;
export const FILES_EVIDENCE_CAP = MAX_LIST_ITEMS + MAX_PROJECTION_LINES;
export const FILES_EXCERPT_BYTES = MAX_PROJECTION_BYTES;
const MAX_DEPTH = 256;
const MATCHES_KEYS = [
  "matches_format",
  "matches_text",
  "total_count",
  "total_count_is_lower_bound",
  "truncated",
  "_hint",
];
const MATCHES_REQUIRED = MATCHES_KEYS.filter((key) => key !== "_hint");
const FILES_KEYS = ["files", "total_count"];

type ParsedValue =
  | { kind: "object"; members: Map<string, ParsedValue> }
  | { kind: "array"; items: ParsedValue[] }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; integer: boolean; raw: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

// JSON.parse silently keeps the last duplicate key and accepts lone surrogates.
// A small explicit parser keeps the projection canonical and fail-closed.
class StrictJsonParser {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }
  parse(): ParsedValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new Error("trailing JSON content");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[\t\n\r ]/.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  private parseValue(depth: number): ParsedValue {
    if (depth > MAX_DEPTH) {
      throw new Error("JSON nesting too deep");
    }
    const character = this.text[this.index];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') return { kind: "string", value: this.parseString() };
    if (character === "t") return this.expectLiteral("true", { kind: "boolean", value: true });
    if (character === "f") return this.expectLiteral("false", { kind: "boolean", value: false });
    if (character === "n") return this.expectLiteral("null", { kind: "null" });
    if (character === "-" || (character !== undefined && /[0-9]/.test(character))) {
      return this.parseNumber();
    }
    throw new Error("invalid JSON value");
  }

  private expectLiteral(literal: string, value: ParsedValue): ParsedValue {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error("non-standard JSON constant");
    }
    this.index += literal.length;
    return value;
  }

  private parseObject(depth: number): ParsedValue {
    this.index += 1;
    const members = new Map<string, ParsedValue>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return { kind: "object", members };
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') {
        throw new Error("expected object key");
      }
      const key = this.parseString();
      if (members.has(key)) {
        throw new Error("duplicate JSON key");
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        throw new Error("expected colon");
      }
      this.index += 1;
      this.skipWhitespace();
      members.set(key, this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === "}") {
        this.index += 1;
        return { kind: "object", members };
      }
      if (next !== ",") {
        throw new Error("expected comma");
      }
      this.index += 1;
    }
  }

  private parseArray(depth: number): ParsedValue {
    this.index += 1;
    const items: ParsedValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return { kind: "array", items };
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.index];
      if (next === "]") {
        this.index += 1;
        return { kind: "array", items };
      }
      if (next !== ",") {
        throw new Error("expected comma");
      }
      this.index += 1;
    }
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        return result;
      }
      if (code < 0x20) {
        throw new Error("unescaped control character");
      }
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        this.index += 1;
        if (escape === '"' || escape === "\\" || escape === "/") {
          result += escape;
        } else if (escape === "b") {
          result += "\b";
        } else if (escape === "f") {
          result += "\f";
        } else if (escape === "n") {
          result += "\n";
        } else if (escape === "r") {
          result += "\r";
        } else if (escape === "t") {
          result += "\t";
        } else if (escape === "u") {
          const first = this.readHex4();
          if (first === 0x2028 || first === 0x2029) {
            throw new Error("unsafe Unicode line separator");
          }
          if (first >= 0xd800 && first <= 0xdbff) {
            if (this.text[this.index] !== "\\" || this.text[this.index + 1] !== "u") {
              throw new Error("lone surrogate");
            }
            this.index += 2;
            const second = this.readHex4();
            if (second < 0xdc00 || second > 0xdfff) {
              throw new Error("lone surrogate");
            }
            result += String.fromCodePoint(
              0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
            );
          } else if (first >= 0xdc00 && first <= 0xdfff) {
            throw new Error("lone surrogate");
          } else {
            result += String.fromCharCode(first);
          }
        } else {
          throw new Error("invalid escape");
        }
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const trailing = this.text.charCodeAt(this.index + 1);
        if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
          throw new Error("lone surrogate");
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error("lone surrogate");
      }
      const character = String.fromCodePoint(this.text.codePointAt(this.index)!);
      if (character === "\u2028" || character === "\u2029") {
        throw new Error("unsafe Unicode line separator");
      }
      result += character;
      this.index += character.length;
    }
    throw new Error("unterminated string");
  }

  private readHex4(): number {
    const hex = this.text.slice(this.index, this.index + 4);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error("invalid Unicode escape");
    }
    this.index += 4;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): ParsedValue {
    const start = this.index;
    if (this.text[this.index] === "-") {
      this.index += 1;
    }
    if (this.text[this.index] === "0") {
      this.index += 1;
    } else if (this.text[this.index] !== undefined && /[1-9]/.test(this.text[this.index])) {
      while (this.text[this.index] !== undefined && /[0-9]/.test(this.text[this.index])) {
        this.index += 1;
      }
    } else {
      throw new Error("non-standard JSON number");
    }
    let integer = true;
    if (this.text[this.index] === ".") {
      integer = false;
      this.index += 1;
      if (this.text[this.index] === undefined || !/[0-9]/.test(this.text[this.index])) {
        throw new Error("invalid fraction");
      }
      while (this.text[this.index] !== undefined && /[0-9]/.test(this.text[this.index])) {
        this.index += 1;
      }
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      integer = false;
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") {
        this.index += 1;
      }
      if (this.text[this.index] === undefined || !/[0-9]/.test(this.text[this.index])) {
        throw new Error("invalid exponent");
      }
      while (this.text[this.index] !== undefined && /[0-9]/.test(this.text[this.index])) {
        this.index += 1;
      }
    }
    const raw = this.text.slice(start, this.index);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new Error("number out of range");
    }
    return { kind: "number", value, integer, raw };
  }
}

function hasUnsafeUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x2028 || code === 0x2029) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = text.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const encoded = (value: string): string => JSON.stringify(value);

function valueRefusal(value: string): string | undefined {
  if (containsSensitivePattern(value)) {
    return "protected_error";
  }
  const reason = checkRefusalReason(value, 0);
  if (reason === "protected_error") {
    return "protected_error";
  }
  return reason === undefined ? undefined : "verification_failed";
}

function appendChunks(
  out: string[],
  schema: string,
  field: string,
  value: string,
  maxLine: number,
): boolean {
  const characters = [...value];
  const wholePrefix = `projected ${schema} ${field}+0: `;
  if (requiredEvidence(value).length > 0 && length(wholePrefix) + length(encoded(value)) > maxLine) {
    return false;
  }
  let start = 0;
  let chunk: string[] = [];
  for (const character of characters) {
    const candidate = [...chunk, character].join("");
    const prefix = `projected ${schema} ${field}+${start}: `;
    if (length(prefix) + length(encoded(candidate)) > maxLine) {
      if (chunk.length === 0) {
        return false;
      }
      out.push(prefix + encoded(chunk.join("")));
      start += chunk.length;
      chunk = [character];
      const singlePrefix = `projected ${schema} ${field}+${start}: `;
      if (length(singlePrefix) + length(encoded(character)) > maxLine) {
        return false;
      }
    } else {
      chunk = [...chunk, character];
    }
  }
  if (chunk.length) {
    out.push(`projected ${schema} ${field}+${start}: ` + encoded(chunk.join("")));
  }
  return true;
}

function metadataLine(schema: string, field: string, value: ParsedValue): string {
  let rendered: string;
  if (value.kind === "boolean") {
    rendered = value.value ? "true" : "false";
  } else if (value.kind === "number") {
    rendered = BigInt(value.raw).toString();
  } else {
    rendered = encoded(value.kind === "string" ? value.value : String(value));
  }
  return `projected ${schema} ${field} = ${rendered}`;
}

function finish(
  schema: string,
  lines: string[],
  metadataLines: string[],
  original: string,
  config: Config,
): ProjectionDecision {
  if (lines.length > MAX_PROJECTION_LINES) {
    return { refusal: "verification_failed" };
  }
  const source = lines.join("\n");
  if (
    bytes(source) > MAX_PROJECTION_BYTES ||
    lines.some((line) => length(line) > config.max_excerpt_line_length)
  ) {
    return { refusal: "verification_failed" };
  }
  const required: string[] = [];
  for (const line of metadataLines) {
    if (!required.includes(line)) {
      required.push(line);
    }
  }
  for (const line of requiredEvidence(source)) {
    if (!required.includes(line)) {
      required.push(line);
    }
  }
  if (required.length > config.max_evidence_excerpts) {
    return { refusal: "verification_failed" };
  }
  return {
    projection: { schema, source, lines, required, digest: sha256(original) },
  };
}

function isNonNegativeInteger(
  value: ParsedValue,
): value is { kind: "number"; value: number; integer: boolean; raw: string } {
  return value.kind === "number" && value.integer && Number.isInteger(value.value) && value.value >= 0;
}

function projectMatches(
  members: Map<string, ParsedValue>,
  original: string,
  config: Config,
  digest: string,
): ProjectionDecision {
  const keys = [...members.keys()];
  if (
    !MATCHES_REQUIRED.every((key) => members.has(key)) ||
    keys.some((key) => !MATCHES_KEYS.includes(key))
  ) {
    return {};
  }
  const format = members.get("matches_format")!;
  const text = members.get("matches_text")!;
  const count = members.get("total_count")!;
  const lowerBound = members.get("total_count_is_lower_bound")!;
  const truncated = members.get("truncated")!;
  const hint = members.get("_hint");
  if (format.kind !== "string" || text.kind !== "string") {
    return { refusal: "verification_failed" };
  }
  if (
    !isNonNegativeInteger(count) ||
    lowerBound.kind !== "boolean" ||
    truncated.kind !== "boolean"
  ) {
    return { refusal: "verification_failed" };
  }
  if (hint !== undefined && hint.kind !== "string") {
    return { refusal: "verification_failed" };
  }
  const strings = [format.value, text.value, ...(hint === undefined ? [] : [hint.value])];
  if (strings.some((value) => length(value) > MAX_FIELD_CHARS)) {
    return { refusal: "verification_failed" };
  }
  for (const value of strings) {
    const refusal = valueRefusal(value);
    if (refusal) {
      return { refusal };
    }
  }
  const maxLine = Math.min(config.max_excerpt_line_length, 240);
  if (maxLine < MIN_LINE_BUDGET) {
    return { refusal: "verification_failed" };
  }
  const header = `projected ${MATCHES_SCHEMA} schema-version = ${PROJECTION_VERSION} digest = ${digest}`;
  const totalLine = metadataLine(MATCHES_SCHEMA, "total_count", count);
  const lowerLine = metadataLine(MATCHES_SCHEMA, "total_count_is_lower_bound", lowerBound);
  const truncatedLine = metadataLine(MATCHES_SCHEMA, "truncated", truncated);
  const lines = [header, totalLine, lowerLine, truncatedLine];
  if (!appendChunks(lines, MATCHES_SCHEMA, "matches_format", format.value, maxLine)) {
    return { refusal: "verification_failed" };
  }
  if (hint !== undefined && !appendChunks(lines, MATCHES_SCHEMA, "_hint", hint.value, maxLine)) {
    return { refusal: "verification_failed" };
  }
  for (const [index, line] of splitLines(text.value).entries()) {
    if (line === "") {
      continue;
    }
    if (!appendChunks(lines, MATCHES_SCHEMA, `matches_text[${index}]`, line, maxLine)) {
      return { refusal: "verification_failed" };
    }
  }
  return finish(MATCHES_SCHEMA, lines, [header, totalLine, lowerLine, truncatedLine], original, config);
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }
  let prefix = [...values[0]];
  for (const value of values.slice(1)) {
    const characters = [...value];
    let index = 0;
    while (
      index < prefix.length &&
      index < characters.length &&
      prefix[index] === characters[index]
    ) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix.join("");
}

function prefixLines(prefix: string, maxLine: number): string[] | undefined {
  const lines: string[] = [];
  let start = 0;
  let chunk: string[] = [];
  for (const character of [...prefix]) {
    const candidate = [...chunk, character].join("");
    if (length(`p;prefix+${start}=${encoded(candidate)}`) > maxLine) {
      if (chunk.length === 0) {
        return undefined;
      }
      lines.push(`p;prefix+${start}=${encoded(chunk.join(""))}`);
      start += chunk.length;
      chunk = [character];
      if (length(`p;prefix+${start}=${encoded(character)}`) > maxLine) {
        return undefined;
      }
    } else {
      chunk = [...chunk, character];
    }
  }
  if (chunk.length) {
    lines.push(`p;prefix+${start}=${encoded(chunk.join(""))}`);
  }
  return lines.length ? lines : ['p;prefix+0=""'];
}

function suffixLines(suffixes: string[], maxLine: number): string[] | undefined {
  const lines: string[] = [];
  let current = "p;suffixes=[";
  const flush = (): void => {
    lines.push(`${current}]`);
    current = "p;suffixes=[";
  };
  for (const [index, suffix] of suffixes.entries()) {
    const token = encoded(suffix);
    if (length(`p;suffixes=[${token}]`) > maxLine) {
      if (current !== "p;suffixes=[") {
        flush();
      }
      const spans = evidenceSpans(suffix);
      let start = 0;
      let chunk: string[] = [];
      for (const [position, character] of [...suffix].entries()) {
        const label = `p;suffix+${index}+${start}=`;
        const candidate = [...chunk, character].join("");
        const cutsEvidence = spans.some(([begin, end]) => begin < position && position < end);
        if (length(label) + length(encoded(candidate)) > maxLine && chunk.length && !cutsEvidence) {
          const line = label + encoded(chunk.join(""));
          if (length(line) > maxLine) {
            return undefined;
          }
          lines.push(line);
          start += chunk.length;
          chunk = [character];
          continue;
        }
        if (length(`p;suffix+${index}+${start}=`) + length(encoded(character)) > maxLine) {
          return undefined;
        }
        chunk = [...chunk, character];
      }
      if (chunk.length) {
        const line = `p;suffix+${index}+${start}=${encoded(chunk.join(""))}`;
        if (length(line) > maxLine) {
          return undefined;
        }
        lines.push(line);
      } else if (suffix === "") {
        lines.push(`p;suffix+${index}+0=""`);
      }
      continue;
    }
    const addition = (current.endsWith("[") ? "" : ",") + token;
    if (length(current) + length(addition) + 1 > maxLine) {
      flush();
      current = `p;suffixes=[${token}`;
    } else {
      current += addition;
    }
  }
  if (current !== "p;suffixes=[" || lines.length === 0) {
    lines.push(`${current}]`);
  }
  return lines;
}

function projectFiles(
  members: Map<string, ParsedValue>,
  original: string,
  config: Config,
  digest: string,
): ProjectionDecision {
  if (
    [...members.keys()].length !== FILES_KEYS.length ||
    !FILES_KEYS.every((key) => members.has(key))
  ) {
    return {};
  }
  const files = members.get("files")!;
  const count = members.get("total_count")!;
  if (files.kind !== "array" || files.items.length > MAX_LIST_ITEMS) {
    return { refusal: "verification_failed" };
  }
  if (!isNonNegativeInteger(count)) {
    return { refusal: "verification_failed" };
  }
  const values = files.items.map((item) => (item.kind === "string" ? item.value : undefined));
  if (values.some((value) => value === undefined || length(value) > MAX_FIELD_CHARS)) {
    return { refusal: "verification_failed" };
  }
  const paths = values as string[];
  const rawReason = checkRefusalReason(original, 0);
  if (rawReason !== undefined) {
    return { refusal: rawReason === "protected_error" ? "protected_error" : "verification_failed" };
  }
  for (const path of paths) {
    const refusal = valueRefusal(path);
    if (refusal) {
      return { refusal };
    }
  }
  const maxLine = MAX_PROJECTION_LINE_LENGTH;
  const prefix = paths.some((path) => path === "") ? "" : commonPrefix(paths);
  const prefixLength = length(prefix);
  const suffixes = paths.map((path) => [...path].slice(prefixLength).join(""));
  const evidence = paths.map((path) => requiredEvidence(path).length > 0);
  const evidenceUnits = evidence.filter(Boolean).length;
  const header =
    `projected ${FILES_SCHEMA} v=2 digest=${digest} ` +
    `total_count=${BigInt(count.raw).toString()} items=${paths.length} ` +
    `verified=${paths.length} evidence=${evidenceUnits} ` +
    "note=prefix+suffix;restore=unhide_context";
  if (length(header) > maxLine) {
    return { refusal: "verification_failed" };
  }
  const prefixPart = prefixLines(prefix, maxLine);
  if (prefixPart === undefined) {
    return { refusal: "verification_failed" };
  }
  const suffixPart = suffixLines(suffixes, maxLine);
  if (suffixPart === undefined) {
    return { refusal: "verification_failed" };
  }
  const lines = [header, ...prefixPart, ...suffixPart];
  // Non-evidence suffix lines still encode paths the model must see.
  const required = [...lines];
  if (required.length > FILES_EVIDENCE_CAP) {
    return { refusal: "verification_failed" };
  }
  const source = lines.join("\n");
  if (
    bytes(source) > MAX_PROJECTION_BYTES ||
    lines.length > MAX_PROJECTION_LINES ||
    lines.some((line) => length(line) > MAX_PROJECTION_LINE_LENGTH)
  ) {
    return { refusal: "verification_failed" };
  }
  return {
    projection: {
      schema: FILES_SCHEMA,
      source,
      lines,
      required,
      digest,
    },
  };
}

export function projectJsonToolResult(
  content: string,
  toolName: unknown,
  config: Config = defaults,
): ProjectionDecision {
  if (toolName !== "search_files") {
    return {};
  }
  const stripped = content.trimStart();
  const jsonLike = stripped.startsWith("{") || stripped.startsWith("[");
  if (!jsonLike) {
    return {};
  }
  if (bytes(content) > MAX_JSON_BYTES || hasUnsafeUnicode(content)) {
    return { refusal: "verification_failed" };
  }
  let parsed: ParsedValue;
  try {
    parsed = new StrictJsonParser(content).parse();
  } catch {
    return { refusal: "verification_failed" };
  }
  if (parsed.kind !== "object") {
    return {};
  }
  const digest = sha256(content);
  const matches = projectMatches(parsed.members, content, config, digest);
  if (matches.projection !== undefined || matches.refusal !== undefined) {
    return matches;
  }
  return projectFiles(parsed.members, content, config, digest);
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function parseFilesProjection(source: string): { prefix: string; suffixes: string[] } | undefined {
  const lines = splitLines(source);
  if (!lines.length || !lines[0].startsWith(`projected ${FILES_SCHEMA} v=2 `)) {
    return undefined;
  }
  const parts: { offset: number; value: string }[] = [];
  const suffixes: string[] = [];
  let pending: { index: number; chunks: { offset: number; value: string }[] } | undefined;
  const finishPending = (): boolean => {
    if (!pending) {
      return true;
    }
    let offset = 0;
    let value = "";
    for (const chunk of pending.chunks) {
      if (chunk.offset !== offset) {
        return false;
      }
      value += chunk.value;
      offset += length(chunk.value);
    }
    if (pending.chunks.length === 0 || pending.index !== suffixes.length) {
      return false;
    }
    suffixes.push(value);
    pending = undefined;
    return true;
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith("p;prefix+")) {
      if (suffixes.length || pending) {
        return undefined;
      }
      const separator = line.indexOf("=");
      const offsetText = line.slice("p;prefix+".length, separator);
      if (separator < 0 || !/^\d+$/.test(offsetText)) {
        return undefined;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.slice(separator + 1));
      } catch {
        return undefined;
      }
      if (typeof value !== "string") {
        return undefined;
      }
      parts.push({ offset: Number(offsetText), value });
    } else if (line.startsWith("p;suffixes=[")) {
      if (!finishPending()) {
        return undefined;
      }
      let values: unknown;
      try {
        values = JSON.parse(line.slice(line.indexOf("=") + 1));
      } catch {
        return undefined;
      }
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        return undefined;
      }
      suffixes.push(...(values as string[]));
    } else {
      const match = /^p;suffix\+(\d+)\+(\d+)=/.exec(line);
      if (!match) {
        return undefined;
      }
      const index = Number(match[1]);
      const offset = Number(match[2]);
      if (pending && pending.index !== index && !finishPending()) {
        return undefined;
      }
      if (!pending) {
        if (index !== suffixes.length) {
          return undefined;
        }
        pending = { index, chunks: [] };
      }
      let value: unknown;
      try {
        value = JSON.parse(line.slice(line.indexOf("=") + 1));
      } catch {
        return undefined;
      }
      if (typeof value !== "string") {
        return undefined;
      }
      pending.chunks.push({ offset, value });
    }
  }
  if (!finishPending() || !parts.length) {
    return undefined;
  }
  parts.sort((left, right) => left.offset - right.offset);
  let prefix = "";
  let expectedOffset = 0;
  for (const part of parts) {
    if (part.offset !== expectedOffset) {
      return undefined;
    }
    prefix += part.value;
    expectedOffset += length(part.value);
  }
  return { prefix, suffixes };
}

function filesProjectionMatches(content: string, lines: string[]): boolean {
  if (bytes(content) > MAX_JSON_BYTES) {
    return false;
  }
  let parsed: ParsedValue;
  try {
    parsed = new StrictJsonParser(content).parse();
  } catch {
    return false;
  }
  if (parsed.kind !== "object") {
    return false;
  }
  const files = parsed.members.get("files");
  const count = parsed.members.get("total_count");
  if (files?.kind !== "array" || count === undefined || !isNonNegativeInteger(count)) {
    return false;
  }
  const items = files.items.map((item) => (item.kind === "string" ? item.value : undefined));
  if (items.some((item) => item === undefined)) {
    return false;
  }
  const paths = items as string[];
  const headerMatch =
    /^projected search_files_files_v2 v=2 digest=([0-9a-f]{64}) total_count=(\d+) items=(\d+) verified=(\d+) evidence=(\d+) note=prefix\+suffix;restore=unhide_context$/.exec(
      lines[0] ?? "",
    );
  const parsedProjection = parseFilesProjection(lines.join("\n"));
  if (!headerMatch || !parsedProjection) {
    return false;
  }
  const expectedPrefix = paths.some((path) => path === "") ? "" : commonPrefix(paths);
  const expectedEvidence = paths.filter((path) => requiredEvidence(path).length > 0).length;
  const restored = parsedProjection.suffixes.map((suffix) => parsedProjection.prefix + suffix);
  return (
    headerMatch[1] === sha256(content) &&
    headerMatch[2] === BigInt(count.raw).toString() &&
    headerMatch[3] === String(paths.length) &&
    headerMatch[4] === String(paths.length) &&
    headerMatch[5] === String(expectedEvidence) &&
    parsedProjection.prefix === expectedPrefix &&
    sameLines(restored, paths)
  );
}

function decodeFilesReplacement(rendered: string, itemId: string): string[] | undefined {
  const rows = splitLines(rendered);
  const restore = `The remaining result is preserved. Restore it with unhide_context(${itemId}).`;
  if (
    rows.length < 3 ||
    rows[0] !== `[hidden:${itemId}]` ||
    rows[rows.length - 1] !== restore
  ) {
    return undefined;
  }
  const label = `${FILES_REPLACEMENT_LABEL}: `;
  const lines: string[] = [];
  for (const row of rows.slice(1, -1)) {
    if (!row.startsWith(label)) {
      return undefined;
    }
    lines.push(row.slice(label.length));
  }
  return lines;
}

const MATCHES_REPLACEMENT_LABEL = "Projected JSON excerpt: ";
const RESTORE_MARKER = "The remaining result is preserved. Restore it with unhide_context(";

// Mirrors Python d094845: a matches excerpt may omit lines, but every shown
// row must be a verbatim projection line in source order with all required evidence.
function decodeMatchesReplacement(rendered: string, projection: JsonProjection): string[] | undefined {
  if (!rendered.startsWith("[hidden:") || !rendered.includes(RESTORE_MARKER)) {
    return undefined;
  }
  const newline = rendered.indexOf("\n");
  const body = (newline < 0 ? "" : rendered.slice(newline + 1))
    .split(RESTORE_MARKER, 1)[0]
    .replace(/\n+$/, "");
  if (body === "") {
    return undefined;
  }
  const shown: string[] = [];
  let cursor = 0;
  for (const row of body.split("\n")) {
    if (!row.startsWith(MATCHES_REPLACEMENT_LABEL)) {
      return undefined;
    }
    const line = row.slice(MATCHES_REPLACEMENT_LABEL.length);
    const position = projection.lines.indexOf(line, cursor);
    if (position < 0) {
      return undefined;
    }
    cursor = position + 1;
    shown.push(line);
  }
  if (projection.required.some((line) => !shown.includes(line))) {
    return undefined;
  }
  return shown;
}

export function verifyFilesReplacement(
  content: string,
  itemId: string,
  projection: JsonProjection,
  rendered: string,
  config: Config = defaults,
  toolName: unknown = "search_files",
): boolean {
  if (typeof rendered !== "string") {
    return false;
  }
  if (projection.schema === FILES_SCHEMA) {
    const lines = decodeFilesReplacement(rendered, itemId);
    return lines !== undefined && sameLines(lines, projection.lines) && filesProjectionMatches(content, lines);
  }
  if (projection.schema !== MATCHES_SCHEMA) {
    return false;
  }
  if (!verifyProjection(content, toolName, projection, config)) {
    return false;
  }
  return decodeMatchesReplacement(rendered, projection) !== undefined;
}
export function verifyProjection(
  content: string,
  toolName: unknown,
  projection: JsonProjection,
  config: Config = defaults,
): boolean {
  const decision = projectJsonToolResult(content, toolName, config);
  const candidate = decision.projection;
  if (
    candidate === undefined ||
    candidate.schema !== projection.schema ||
    candidate.source !== projection.source ||
    !sameLines(candidate.lines, projection.lines) ||
    !sameLines(candidate.required, projection.required) ||
    candidate.digest !== projection.digest
  ) {
    return false;
  }
  if (candidate.schema !== FILES_SCHEMA) {
    return true;
  }
  return filesProjectionMatches(content, candidate.lines);
}
