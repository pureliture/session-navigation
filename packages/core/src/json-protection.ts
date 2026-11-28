import {
  parseJsonForProtection,
  type JsonProtectionBudget,
  type ParsedValue,
} from "./generic-json.ts";
import { defaults, type Config, type RecordInput } from "./model.ts";
import { protectedPatternRefusal, refusalReason } from "./policy.ts";

const LEADING_JSON_WS = /^[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2060\ufeff]+/u;
const READ_ENVELOPE_HEADER =
  /^\[(?:[^\[\]"{}\x00-\x1f\x7f-\x9f]{1,512}#[0-9A-Fa-f]{4}|Skill file: [^\[\]"{}\x00-\x1f\x7f-\x9f]{1,512})\]\r?\n/u;

function stripReadEnvelopeBody(content: string): string {
  const match = READ_ENVELOPE_HEADER.exec(content);
  return match ? content.slice(match[0].length) : content;
}

export function isJsonLike(content: string): boolean {
  const stripped = stripReadEnvelopeBody(content).replace(LEADING_JSON_WS, "");
  if (!stripped) return false;
  return stripped[0] === "{" || stripped[0] === "[" || stripped[0] === '"';
}

function walk(value: ParsedValue, budget: JsonProtectionBudget): string | undefined {
  switch (value.kind) {
    case "string": {
      const direct = protectedPatternRefusal(value.value);
      if (direct) return direct;
      // Only a string that is itself valid JSON (or an envelope header over a
      // JSON body) is decoded again. Ordinary literal backslash-u text is kept as-is.
      if (!isJsonLike(value.value)) return undefined;
      const nested = parseJsonForProtection(stripReadEnvelopeBody(value.value), budget);
      return nested.refusal ?? (nested.value ? walk(nested.value, budget) : undefined);
    }
    case "object": {
      for (const child of value.members.values()) {
        const refused = walk(child, budget);
        if (refused) return refused;
      }
      return undefined;
    }
    case "array": {
      for (const child of value.items) {
        const refused = walk(child, budget);
        if (refused) return refused;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Refusal for protected expressions in the original text or in bounded
 * decodings of valid JSON. Invalid, ambiguous or over-budget JSON keeps the
 * original by returning a refusal instead of failing open.
 */
export function jsonProtectionRefusal(content: string): string | undefined {
  if (!isJsonLike(content)) return undefined;
  const budget: JsonProtectionBudget = { bytes: 0, nodes: 0, depth: 0 };
  const parsed = parseJsonForProtection(stripReadEnvelopeBody(content), budget);
  return parsed.refusal ?? (parsed.value ? walk(parsed.value, budget) : undefined);
}

/** Single decision used by every compaction path in both runtimes. */
export function refusalReasonForRecord(
  record: RecordInput,
  config: Config = defaults,
): string | undefined {
  return refusalReason(record, config) ?? jsonProtectionRefusal(record.content);
}
