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
  addedRequired?: string[],
  addedRuleRequired?: string[],
  excerptLabel = "Original excerpt",
  evidenceSource?: string | readonly string[],
): {
  choice?: Choice;
  rendered?: string;
  error?: string;
} {
  const evidence = evidenceLines(evidenceSource);
  const required = addedRequired ?? requiredEvidence(original);
  let choice: Choice = { lines: baseline, source: "rule" };
  if (summary !== undefined) {
    const valid = validateSummary(original, summary, required, invocation, evidence);
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
    excerptLabel,
  );
  if (
    choice.source === "llm" &&
    (bytes(rendered) > bytes(original) * 0.8 || length(rendered) >= length(original))
  ) {
    if (!allowFallback) {
      return { error: "compression_insufficient" };
    }
    choice = { lines: baseline, source: "rule" };
    rendered = renderCompaction(id, baseline, undefined, verifiedFacts(original), omitted, excerptLabel);
  }
  const source = choice.source === "llm" ? original : ruleSource;
  const ruleRequired = addedRuleRequired ?? requiredEvidence(source);
  const checkingEvidence = choice.source === "llm" && !!evidence?.length;
  const checkLines = checkingEvidence ? evidence! : splitLines(selectableText(source));
  const checkRequired = choice.source === "llm" ? required : ruleRequired;
  if (
    choice.lines.some((line) => !checkLines.includes(line)) ||
    checkRequired.some((line) => !choice.lines.includes(line)) ||
    length(rendered) >= length(original)
  ) {
    return { error: "verification_failed" };
  }
  return { choice, rendered };
}

function evidenceLines(evidenceSource?: string | readonly string[]): string[] | undefined {
  if (evidenceSource === undefined) return undefined;
  return typeof evidenceSource === "string" ? splitLines(evidenceSource) : [...evidenceSource];
}
