import { bytes, length, type Json } from "./model.ts";
import {
  requiredEvidence,
  renderCompaction,
  selectableText,
  splitLines,
  verifiedFacts,
} from "./policy.ts";
import { validateSummary } from "./summary.ts";
export interface Choice {
  lines: string[];
  source: string;
  summary_text?: {
    summary: string;
  };
}
export function evaluateCompaction(
  original: string,
  id: string,
  ruleSource: string,
  baseline: string[],
  summary?: unknown,
  invocation?: Json,
  omitted = false,
  allowFallback = true,
): {
  choice?: Choice;
  rendered?: string;
  error?: string;
} {
  const required = requiredEvidence(original);
  let choice: Choice = { lines: baseline, source: "rule" };
  if (summary !== undefined) {
    const valid = validateSummary(original, summary, required, invocation);
    if (!valid) {
      if (!allowFallback) {
        return { error: "verification_failed" };
      }
    } else {
      choice = { lines: required, source: "llm", summary_text: valid };
    }
  }
  let rendered = renderCompaction(
    id,
    choice.lines,
    choice.summary_text,
    verifiedFacts(original),
    omitted,
  );
  if (
    choice.source === "llm" &&
    (bytes(rendered) > bytes(original) * 0.8 || length(rendered) >= length(original))
  ) {
    if (!allowFallback) {
      return { error: "compression_insufficient" };
    }
    choice = { lines: baseline, source: "rule" };
    rendered = renderCompaction(id, baseline);
  }
  const source = choice.source === "llm" ? original : ruleSource;
  if (
    choice.lines.some((line) => !splitLines(selectableText(source)).includes(line)) ||
    requiredEvidence(source).some((line) => !choice.lines.includes(line)) ||
    length(rendered) >= length(original)
  ) {
    return { error: "verification_failed" };
  }
  return { choice, rendered };
}
