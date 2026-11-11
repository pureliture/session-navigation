import { createHash } from "node:crypto";
export type Json =
  | null
  | boolean
  | number
  | bigint
  | string
  | PythonFloat
  | Json[]
  | {
      [key: string]: Json;
    };
export class PythonFloat {
  // JS loses the distinction between Python's integer 1 and float 1.0 without a tag.
  readonly value: number;

  constructor(value: number) {
    if (!Number.isFinite(value)) {
      throw new TypeError("unsafe_json_number");
    }
    this.value = value;
  }
}
export interface Scope {
  adapter_id: string;
  host_profile: string;
  session_id: string;
  branch_scope?: string;
}
export type ScopeLike = Scope | string;
export interface RecordInput {
  call_id: string;
  result_position: number;
  content: string;
  content_sha256: string;
  invocation: {
    [key: string]: Json;
  };
  invocation_digest: string;
  status: string;
  host_handle?: Json;
}
export interface Item {
  item_id: string;
  tool_call_id: string;
  result_position: number;
  content_sha256: string;
  invocation_digest: string;
  original: string;
  compacted: string;
  excerpt_lines: string[];
  visibility: "hidden" | "visible";
  version: number;
  tool_name: string | null;
  compaction_source: string;
  invocation_snapshot: Json;
  context_hint: Json;
  invocation_options_omitted: boolean;
  created_at: number;
  updated_at: number;
}
export interface Plan {
  item_id: string;
  expected_content_sha256: string;
  replacement_text: string;
  visibility_version: number;
  tool_call_id: string;
  host_handle?: Json;
}
export interface Result {
  ok: boolean;
  error?: string;
  item?: Item;
  plan?: Plan;
  keep_lines_ignored?: Json[];
  keep_lines_normalized?: Json[];
}
export interface Config {
  min_chars: number;
  max_pending: number;
  head_excerpts: number;
  tail_excerpts: number;
  max_evidence_excerpts: number;
  max_excerpt_line_length: number;
  max_invocation_bytes: number;
}
export const defaults: Config = {
  min_chars: 800,
  max_pending: 4,
  head_excerpts: 3,
  tail_excerpts: 2,
  max_evidence_excerpts: 8,
  max_excerpt_line_length: 240,
  max_invocation_bytes: 2048,
};
export const length = (text: string): number => [...text].length;
export const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const scopeKey = (scope: ScopeLike): string =>
  typeof scope === "string"
    ? scope
    : `${scope.adapter_id}:${scope.host_profile}:${scope.session_id}:${scope.branch_scope ?? "default"}`;
export function scopeAliases(key: string): string[] {
  const scopeParts = key.split(":");
  return scopeParts.length === 4 &&
    scopeParts[0] === "hermes" &&
    ["unknown", "default"].includes(scopeParts[3])
    ? [
        key,
        [...scopeParts.slice(0, 3), scopeParts[3] === "unknown" ? "default" : "unknown"].join(":"),
      ]
    : [key];
}
function unicodeCompare(left: string, right: string): number {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  for (let index = 0; index < Math.min(leftCharacters.length, rightCharacters.length); index++) {
    const difference =
      leftCharacters[index].codePointAt(0)! - rightCharacters[index].codePointAt(0)!;
    if (difference) {
      return difference;
    }
  }
  return leftCharacters.length - rightCharacters.length;
}
function numberText(value: number): string {
  if (!Number.isFinite(value) || (!Number.isSafeInteger(value) && Number.isInteger(value))) {
    throw new TypeError("unsafe_json_number");
  }
  if (!Number.isInteger(value)) {
    return floatText(value);
  }
  const text = String(value);
  if (!text.includes("e")) {
    return text;
  }
  return text.replace(
    /e([+-]?)(\d+)$/,
    (_all, sign: string, digits: string) => `e${sign || "+"}${digits.padStart(2, "0")}`,
  );
}
export function canonical(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    if (/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))) {
      throw new TypeError("invalid_unicode");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return numberText(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof PythonFloat) {
    return floatText(value.value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(unicodeCompare)
    .map((key) => `${canonical(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
function floatText(value: number): string {
  if (Object.is(value, -0)) {
    return "-0.0";
  }
  const scientific = value.toExponential();
  const match = /^(.*)e([+-]?)(\d+)$/.exec(scientific)!;
  const exponent = Number(`${match[2]}${match[3]}`);
  if (value !== 0 && (exponent < -4 || exponent >= 16)) {
    return `${match[1]}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const text = String(value);
  return Number.isInteger(value) ? `${text}.0` : text;
}
export function parseCanonicalJson(source: string): Json {
  let index = 0;
  const skipWhitespace = () => {
    while (/[\t\n\r ]/.test(source[index] ?? "") && index < source.length) {
      index++;
    }
  };
  function parseString(): string {
    const start = index++;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index++] === '"') {
        return JSON.parse(source.slice(start, index)) as string;
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  }

  function parseArray(): Json[] {
    index++;
    const values: Json[] = [];
    skipWhitespace();
    if (source[index] === "]") {
      index++;
      return values;
    }
    while (true) {
      values.push(parseValue());
      skipWhitespace();
      if (source[index++] === "]") {
        return values;
      }
      if (source[index - 1] !== ",") {
        throw new SyntaxError("Invalid JSON array");
      }
    }
  }

  function parseObject(): { [key: string]: Json } {
    index++;
    const object: {
      [key: string]: Json;
    } = Object.create(null);
    skipWhitespace();
    if (source[index] === "}") {
      index++;
      return object;
    }
    while (true) {
      const key = parseValue();
      if (typeof key !== "string") {
        throw new SyntaxError("Invalid JSON key");
      }
      skipWhitespace();
      if (source[index++] !== ":") {
        throw new SyntaxError("Invalid JSON object");
      }
      object[key] = parseValue();
      skipWhitespace();
      if (source[index++] === "}") {
        return object;
      }
      if (source[index - 1] !== ",") {
        throw new SyntaxError("Invalid JSON object");
      }
    }
  }

  function parseValue(): Json {
    skipWhitespace();
    const character = source[index];
    if (character === '"') {
      return parseString();
    }
    if (character === "[") {
      return parseArray();
    }
    if (character === "{") {
      return parseObject();
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, index)) {
        index += token.length;
        return result;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (!match) {
      throw new SyntaxError("Invalid JSON value");
    }
    index += match[0].length;
    const number = Number(match[0]);
    if (/[.eE]/.test(match[0])) {
      return new PythonFloat(number);
    }
    return Number.isSafeInteger(number) ? number : BigInt(match[0]);
  }
  const result = parseValue();
  skipWhitespace();
  if (index !== source.length) {
    throw new SyntaxError("Trailing JSON text");
  }
  return result;
}
export const invocationDigest = (
  invocation: {
    [key: string]: Json;
  },
  omitted: {
    [key: string]: Json;
  } = {},
): string =>
  sha256(
    canonical(
      Object.keys(omitted).length ? { ...invocation, omitted_options: omitted } : invocation,
    ),
  );
export const itemId = (
  scope: ScopeLike,
  callId: string,
  contentSha256: string,
  digest = "",
  position = 0,
): string =>
  `item_${sha256(`${scopeKey(scope)}\0${callId}\0${contentSha256}\0${digest}\0${position}`).slice(0, 16)}`;
export const messageUnitId = (scope: ScopeLike, messageUid: string): string =>
  `msg_${sha256(`${scopeKey(scope)}\0msg\0${messageUid}`).slice(0, 16)}`;
export const pairUnitId = (scope: ScopeLike, callId: string, contentSha256: string): string =>
  `pair_${sha256(`${scopeKey(scope)}\0pair\0${callId}\0${contentSha256}`).slice(0, 16)}`;
