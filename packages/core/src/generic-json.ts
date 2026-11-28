import { bytes, length, sha256 } from "./model.ts";
import { parsedStringProtectedLines } from "./policy.ts";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_DEPTH = 256;
const MAX_NODES = 4096;
const MAX_STRING_CHARS = 8192;
const MAX_PROTECTION_STRING_CHARS = MAX_JSON_BYTES;
export const MAX_EVIDENCE_LINES = 64;
export const MAX_EVIDENCE_LINE_CHARS = 240;
export const MAX_EVIDENCE_BYTES = 8192;
export interface JsonProtectionBudget {
  bytes: number;
  nodes: number;
  depth: number;
}

/**
 * Strict parse under a budget shared across nested JSON layers. Success
 * mutates the budget; failure leaves it untouched and fails closed.
 */
export function parseJsonForProtection(
  content: string,
  budget: JsonProtectionBudget,
): { value?: ParsedValue; refusal?: string } {
  const size = bytes(content);
  if (budget.bytes + size > MAX_JSON_BYTES) return { refusal: "input_too_large" };
  if (hasUnsafeUnicode(content)) return { refusal: "verification_failed" };
  try {
    const parsed = new StrictJsonParser(content).parse();
    const { nodes, depth } = canonical(parsed, MAX_PROTECTION_STRING_CHARS);
    if (budget.nodes + nodes > MAX_NODES || budget.depth + depth > MAX_DEPTH) {
      return { refusal: "input_too_large" };
    }
    budget.bytes += size;
    budget.nodes += nodes;
    budget.depth += depth;
    return { value: parsed };
  } catch {
    return { refusal: "verification_failed" };
  }
}

export type GenericJsonKind = "object" | "array" | "scalar";

export interface GenericJsonDecision {
  ok: boolean;
  refusal: string | null;
  kind: GenericJsonKind | null;
  nodes: number;
  depth: number;
  digest: string;
}

export type ParsedValue =
  | { kind: "object"; members: Map<string, ParsedValue> }
  | { kind: "array"; items: ParsedValue[] }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; integer: boolean; raw: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

type Frame =
  | { tag: "value"; value: ParsedValue; level: number }
  | { tag: "text"; text: string };

// The projection parser is deliberately not exported: keep an explicit strict
// parser here so schema-agnostic inspection rejects duplicate keys, non-finite
// numbers and unsafe Unicode exactly like the projection path does.
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

function refusal(code: string): GenericJsonDecision {
  return { ok: false, refusal: code, kind: null, nodes: 0, depth: 0, digest: "" };
}

function hasUnsafeUnicode(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) {
      return true;
    }
  }
  return false;
}

// Python sorts strings by Unicode code point; localeCompare does not.
function compareKeys(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return a.length - b.length;
}

function canonical(
  value: ParsedValue, maxStringChars: number = MAX_STRING_CHARS
): { form: string; nodes: number; depth: number } {
  const out: string[] = [];
  const stack: Frame[] = [{ tag: "value", value, level: 0 }];
  let nodes = 0;
  let depth = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.tag === "text") {
      out.push(frame.text);
      continue;
    }
    const current = frame.value;
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new Error("too many JSON nodes");
    }
    switch (current.kind) {
      case "object": {
        const inner = frame.level + 1;
        if (inner > MAX_DEPTH) {
          throw new Error("JSON nesting too deep");
        }
        depth = Math.max(depth, inner);
        out.push("{");
        stack.push({ tag: "text", text: "}" });
        const entries = [...current.members.entries()].sort((left, right) =>
          compareKeys(left[0], right[0]),
        );
        for (let index = entries.length - 1; index >= 0; index--) {
          const [key, item] = entries[index];
          if (length(key) > maxStringChars || hasUnsafeUnicode(key)) {
            throw new Error("unsafe JSON key");
          }
          stack.push({ tag: "value", value: item, level: inner });
          stack.push({ tag: "text", text: `${JSON.stringify(key)}:` });
          if (index > 0) {
            stack.push({ tag: "text", text: "," });
          }
        }
        break;
      }
      case "array": {
        const inner = frame.level + 1;
        if (inner > MAX_DEPTH) {
          throw new Error("JSON nesting too deep");
        }
        depth = Math.max(depth, inner);
        out.push("[");
        stack.push({ tag: "text", text: "]" });
        for (let index = current.items.length - 1; index >= 0; index--) {
          stack.push({ tag: "value", value: current.items[index], level: inner });
          if (index > 0) {
            stack.push({ tag: "text", text: "," });
          }
        }
        break;
      }
      case "string":
        if (length(current.value) > maxStringChars || hasUnsafeUnicode(current.value)) {
          throw new Error("unsafe JSON string");
        }
        out.push(JSON.stringify(current.value));
        break;
      case "number":
        out.push(current.raw);
        break;
      case "boolean":
        out.push(current.value ? "true" : "false");
        break;
      case "null":
        out.push("null");
        break;
    }
  }
  return { form: out.join(""), nodes, depth };
}

interface GenericJsonParse {
  parsed: ParsedValue;
  form: string;
  nodes: number;
  depth: number;
}

function parseGenericJson(content: string): { value?: GenericJsonParse; refusal?: string } {
  if (typeof content !== "string") {
    return { refusal: "verification_failed" };
  }
  if (bytes(content) > MAX_JSON_BYTES) {
    return { refusal: "input_too_large" };
  }
  if (hasUnsafeUnicode(content)) {
    return { refusal: "verification_failed" };
  }
  try {
    const parsed = new StrictJsonParser(content).parse();
    const result = canonical(parsed);
    return { value: { parsed, ...result } };
  } catch {
    return { refusal: "verification_failed" };
  }
}

function evidenceToken(value: ParsedValue): string | undefined {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return value.raw;
    case "boolean":
      return value.value ? "true" : "false";
    case "null":
      return "null";
    default:
      return undefined;
  }
}

function clampEvidenceLine(line: string): string {
  const characters = [...line];
  return characters.length > MAX_EVIDENCE_LINE_CHARS
    ? `${characters.slice(0, MAX_EVIDENCE_LINE_CHARS - 3).join("")}...`
    : line;
}

interface ScalarEvidence {
  path: string;
  token: string;
  decoded: string;
}

function scalarEvidence(value: ParsedValue): ScalarEvidence[] {
  const result: ScalarEvidence[] = [];
  const visit = (current: ParsedValue, path: string): void => {
    switch (current.kind) {
      case "object": {
        const entries = [...current.members.entries()].sort((left, right) =>
          compareKeys(left[0], right[0]),
        );
        for (const [key, member] of entries) {
          visit(member, path ? `${path}.${key}` : key);
        }
        break;
      }
      case "array":
        for (const [index, item] of current.items.entries()) {
          visit(item, `${path}[${index}]`);
        }
        break;
      default: {
        const token = evidenceToken(current);
        if (token !== undefined) {
          result.push({
            path: path || "value",
            token,
            decoded: current.kind === "string" ? current.value : token,
          });
        }
      }
    }
  };
  visit(value, "");
  return result;
}

/** Unprefixed required/protected lines from every strictly parsed value. */
export function parsedJsonPolicyLines(content: string): string[] {
  const parsed = parseGenericJson(content).value;
  if (!parsed) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (path: string, line: string): void => {
    const marker = `${path}\u0000${line}`;
    if (seen.has(marker)) return;
    seen.add(marker);
    lines.push(line);
  };
  const walk = (current: ParsedValue, path: string): void => {
    switch (current.kind) {
      case "object": {
        const entries = [...current.members.entries()].sort((left, right) =>
          compareKeys(left[0], right[0]),
        );
        for (const [key, member] of entries) {
          walk(member, path ? `${path}.${key}` : key);
        }
        break;
      }
      case "array":
        for (const [index, item] of current.items.entries()) {
          walk(item, `${path}[${index}]`);
        }
        break;
      case "string":
        for (const line of parsedStringProtectedLines(current.value)) {
          add(path || "value", line);
        }
        break;
      default: {
        const token = evidenceToken(current);
        if (token !== undefined && parsedStringProtectedLines(token).length > 0) {
          add(path || "value", token);
        }
        break;
      }
    }
  };
  walk(parsed.parsed, "");
  return lines;
}

interface EvidenceResult {
  lines: string[];
  exceeded: boolean;
}

function evidenceFrom(value: ParsedValue): EvidenceResult {
  const lines: string[] = [];
  const seen = new Set<string>();
  let usedBytes = 0;
  let exceeded = false;
  const add = (line: string): void => {
    if (exceeded) return;
    const bounded = clampEvidenceLine(line);
    if (seen.has(bounded)) return;
    seen.add(bounded);
    const lineBytes = bytes(bounded);
    if (lines.length >= MAX_EVIDENCE_LINES || usedBytes + lineBytes > MAX_EVIDENCE_BYTES) {
      exceeded = true;
      return;
    }
    lines.push(bounded);
    usedBytes += lineBytes;
  };

  // Policy-salient decoded lines come first so a budget failure can never be
  // hidden by ordinary structural samples at the end of a large result.
  const protectedPaths = new Set<string>();
  for (const scalar of scalarEvidence(value)) {
    for (const line of parsedStringProtectedLines(scalar.decoded)) {
      protectedPaths.add(scalar.path);
      add(`${scalar.path}: ${line}`);
    }
  }
  const addScalar = (path: string, token: string): void => {
    if (!protectedPaths.has(path)) {
      add(`${path}: ${token}`);
    }
  };
  const addSamples = (prefix: string, items: ParsedValue[]): void => {
    const indices = new Set<number>();
    for (const index of [0, 1, items.length - 2, items.length - 1]) {
      if (index < 0 || index >= items.length || indices.has(index)) continue;
      indices.add(index);
      const token = evidenceToken(items[index]);
      if (token !== undefined) {
        addScalar(`${prefix}[${index}]`, token);
      }
    }
  };
  switch (value.kind) {
    case "object": {
      const entries = [...value.members.entries()].sort((left, right) =>
        compareKeys(left[0], right[0]),
      );
      for (const [key, member] of entries) {
        const token = evidenceToken(member);
        if (token !== undefined) {
          addScalar(key, token);
          if (member.kind === "string" && length(member.value) > MAX_EVIDENCE_LINE_CHARS) {
            add(`${key}_chars: ${length(member.value)}`);
          }
        } else if (member.kind === "object") {
          add(`${key}: object`);
        } else if (member.kind === "array") {
          add(`${key}: list(${member.items.length})`);
          addSamples(key, member.items);
        }
      }
      break;
    }
    case "array":
      add(`items: ${value.items.length}`);
      addSamples("", value.items);
      break;
    default: {
      const token = evidenceToken(value);
      if (token !== undefined) addScalar("value", token);
      break;
    }
  }
  return { lines, exceeded };
}

function decisionFrom(value: GenericJsonParse): GenericJsonDecision {
  const kind: GenericJsonKind =
    value.parsed.kind === "object"
      ? "object"
      : value.parsed.kind === "array"
        ? "array"
        : "scalar";
  return {
    ok: true,
    refusal: null,
    kind,
    nodes: value.nodes,
    depth: value.depth,
    digest: sha256(value.form),
  };
}

/** Inspect arbitrary JSON structure without claiming preservation of any schema. */
export function inspectGenericJson(content: string): GenericJsonDecision {
  const parsed = parseGenericJson(content);
  return parsed.value ? decisionFrom(parsed.value) : refusal(parsed.refusal ?? "verification_failed");
}

/**
 * Inspect and derive bounded evidence from a single strict parse. Structural
 * facts and decoded policy-salient lines are retention guards only: they are
 * not evidence that an unknown JSON schema was semantically preserved.
 */
export function inspectGenericJsonWithEvidence(content: string): {
  decision: GenericJsonDecision;
  evidence: string[];
} {
  const parsed = parseGenericJson(content);
  if (!parsed.value) {
    return { decision: refusal(parsed.refusal ?? "verification_failed"), evidence: [] };
  }
  const evidence = evidenceFrom(parsed.value.parsed);
  if (evidence.exceeded) {
    return { decision: refusal("verification_failed"), evidence: [] };
  }
  return { decision: decisionFrom(parsed.value), evidence: evidence.lines };
}

/**
 * Bounded evidence from a strictly parsed arbitrary JSON value. This is a
 * structural retention aid, not a semantic-preservation claim; an original
 * result is never rewritten and an over-budget evidence set fails closed.
 */
export function parsedJsonEvidence(content: string): string[] {
  const parsed = parseGenericJson(content).value;
  if (!parsed) return [];
  const evidence = evidenceFrom(parsed.parsed);
  return evidence.exceeded ? [] : evidence.lines;
}
