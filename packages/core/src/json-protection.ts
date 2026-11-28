import {
  parseJsonForProtection,
  type JsonProtectionBudget,
  type ParsedValue,
} from "./generic-json.ts";
import { defaults, type Config, type RecordInput } from "./model.ts";
import { protectedPatternRefusal, refusalReason } from "./policy.ts";

function isJsonLike(content: string): boolean {
  const stripped = content.replace(/^[\s\x1c-\x1f\x85\ufeff]+/u, "");
  return stripped.length > 0 && (stripped[0] === "{" || stripped[0] === "[" || stripped[0] === '"');
}

function walk(value: ParsedValue, budget: JsonProtectionBudget): string | undefined {
  switch (value.kind) {
    case "string": {
      const direct = protectedPatternRefusal(value.value);
      if (direct) return direct;
      // Only a string that is itself valid JSON is decoded again. A literal
      // backslash-u sequence is ordinary text and is never re-unescaped.
      if (!isJsonLike(value.value)) return undefined;
      const nested = parseJsonForProtection(value.value, budget);
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
  const parsed = parseJsonForProtection(content, budget);
  return parsed.refusal ?? (parsed.value ? walk(parsed.value, budget) : undefined);
}

/** Single decision used by every compaction path in both runtimes. */
export function refusalReasonForRecord(
  record: RecordInput,
  config: Config = defaults,
): string | undefined {
  return refusalReason(record, config) ?? jsonProtectionRefusal(record.content);
}
