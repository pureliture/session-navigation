import { bytes, defaults, length, sha256, type Config } from "./model.ts";
import {
  checkRefusalReason,
  containsSensitivePattern,
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
const FILES_SCHEMA = "search_files_files_v1";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 8192;
const MAX_LIST_ITEMS = 128;
const MAX_PROJECTION_LINES = 512;
const MAX_PROJECTION_BYTES = 32 * 1024;
const MIN_LINE_BUDGET = 96;
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
  if (characters.length === 0) {
    out.push(`projected ${schema} ${field}+0: ""`);
    return true;
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
  const metadataTokens = schema === MATCHES_SCHEMA
    ? ["schema-version", "total_count", "total_count_is_lower_bound", "truncated"]
    : ["schema-version", "total_count"];
  const required: string[] = [];
  for (const line of lines) {
    if (metadataTokens.some((token) => line.includes(token)) && !required.includes(line)) {
      required.push(line);
    }
  }
  for (const line of requiredEvidence(source)) {
    if (
      !required.includes(line) &&
      (lines.slice(0, config.head_excerpts).includes(line) ||
        lines.slice(-config.tail_excerpts).includes(line))
    ) {
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

function isNonNegativeInteger(value: ParsedValue): boolean {
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
  const lines = [
    `projected ${MATCHES_SCHEMA} schema-version = ${PROJECTION_VERSION} digest = ${digest}`,
    metadataLine(MATCHES_SCHEMA, "total_count", count),
    metadataLine(MATCHES_SCHEMA, "total_count_is_lower_bound", lowerBound),
    metadataLine(MATCHES_SCHEMA, "truncated", truncated),
  ];
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
  return finish(MATCHES_SCHEMA, lines, original, config);
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
  if (
    files.items.some((item) => item.kind !== "string" || length(item.value) > MAX_FIELD_CHARS)
  ) {
    return { refusal: "verification_failed" };
  }
  for (const item of files.items) {
    if (item.kind !== "string") {
      return { refusal: "verification_failed" };
    }
    const refusal = valueRefusal(item.value);
    if (refusal) {
      return { refusal };
    }
  }
  const maxLine = Math.min(config.max_excerpt_line_length, 240);
  if (maxLine < MIN_LINE_BUDGET) {
    return { refusal: "verification_failed" };
  }
  const lines = [
    `projected ${FILES_SCHEMA} schema-version = ${PROJECTION_VERSION} digest = ${digest}`,
    metadataLine(FILES_SCHEMA, "total_count", count),
  ];
  for (const [index, item] of files.items.entries()) {
    if (item.kind !== "string" || item.value === "") {
      continue;
    }
    if (!appendChunks(lines, FILES_SCHEMA, `files[${index}]`, item.value, maxLine)) {
      return { refusal: "verification_failed" };
    }
  }
  return finish(FILES_SCHEMA, lines, original, config);
}

export function projectJsonToolResult(
  content: string,
  toolName: unknown,
  config: Config = defaults,
): ProjectionDecision {
  if (toolName !== "search_files") {
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
    return { refusal: "verification_failed" };
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

export function verifyProjection(
  content: string,
  toolName: unknown,
  projection: JsonProjection,
  config: Config = defaults,
): boolean {
  const decision = projectJsonToolResult(content, toolName, config);
  const candidate = decision.projection;
  return (
    candidate !== undefined &&
    candidate.schema === projection.schema &&
    candidate.source === projection.source &&
    sameLines(candidate.lines, projection.lines) &&
    sameLines(candidate.required, projection.required) &&
    candidate.digest === projection.digest
  );
}
