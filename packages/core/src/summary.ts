import { length, type Json } from "./model.ts";
import { exitClaim, selectableText, splitLines, verifiedFacts } from "./policy.ts";
import { pythonInteger, pythonTrim, pythonize } from "./python-regex.ts";
import { casefold } from "./casefold.ts";
import { numberPattern, normalizeNumber } from "./numbers.ts";
export const MAX_SUMMARY_INPUT_BYTES = 32768;
export function summarySource(original: string, maxBytes = MAX_SUMMARY_INPUT_BYTES): string {
  if (new TextEncoder().encode(original).length > maxBytes)
    throw Object.assign(new Error("input_too_large"), { reason: "input_too_large" });
  return original;
}
export function summaryPrompt(original: string, maxBytes = MAX_SUMMARY_INPUT_BYTES): string {
  return `Summarize this tool result in one paragraph. State only facts present in the result.\n\n${summarySource(original, maxBytes)}`;
}
const injection = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  /\b(?:reveal|print|expose)\s+(?:the\s+)?(?:system|developer|compacted)\s+(?:prompt|message)\b/i,
  /\b(?:execute|run)\s+(?:this|the)\s+command\b/i,
  /\b(?:api key|password|credential|secret)\b/i,
  /이전 지시를 무시|시스템 프롬프트|개발자 지시|비밀을 공개|명령을 실행/,
];
const generic = [
  /\bthe\s+summary\s+(?:captures|must|should|includes?|is)\b/i,
  /\b(?:preserving|preserve|include|included)\s+(?:the\s+)?(?:specified\s+)?source\s+tokens\b/i,
  /\bthe\s+output\s+requires\b/i,
  /^\s*concrete\s+findings\s+from\s+result\.source\s*[.!]?\s*$/i,
  /구체적인\s*주요\s*findings[은는]?\s*명시되지\s*않음/,
  /\b(?:execution\s+)?details?\s+(?:are|is)\s+not\s+provided\b/i,
  /\bresult\s+(?:includes?|contains?)\s+(?:only\s+)?observations\b/i,
  /\brecorded\s+output\s+(?:from\s+the\s+result\s+source\s+)?(?:was|is)\s+provided\s+as\s+detailed\b/i,
  /(?:결과|실행)(?:의)?\s*(?:구체적인\s*)?(?:내용|정보|상세)(?:이|가)?\s*제공되지\s*(?:않음|않았|않습니다)/,
];
const identifier =
  /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|(?:id|uuid|sha256)\s*[:=]\s*[\p{L}\p{N}_.-]+)/giu;
const number = numberPattern;
const pathToken =
  /(?<![A-Za-z0-9_./\\:~-])(?:(?:[A-Za-z]:|~|\.\.?)[/\\]+|[/\\]+)?[A-Za-z0-9_.-]+(?:[/\\]+[A-Za-z0-9_.-]+)*/g;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function pathClaims(text: string): Set<string> {
  const claims = new Set<string>();
  for (const match of text.matchAll(pathToken)) {
    const token = match[0].replace(/\.$/, "");
    if (
      /^(?:[/\\]|\.{1,2}[/\\]|~[/\\]|[A-Za-z]:[/\\])/.test(token) ||
      (token.match(/[/\\]/g) ?? []).length >= 2 ||
      /\.[A-Za-z][A-Za-z0-9_-]*$/.test(token)
    ) {
      claims.add(token);
    }
  }
  return claims;
}
function coversCriticalFacts(original: string, text: string): boolean {
  const subjects = new Set(
    [
      ...original.matchAll(
        pythonize(/\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s+(?:catalog|component|package)\b/g),
      ),
    ].map((match) => match[1]),
  );
  if (
    subjects.size === 1 &&
    !new RegExp(
      `(?<![\\p{L}\\p{N}_-])${escapeRegex([...subjects][0])}(?![\\p{L}\\p{N}_-])`,
      "iu",
    ).test(text)
  ) {
    return false;
  }
  const numericSource = original.replace(numberPattern, normalizeNumber);
  const numericText = text.replace(numberPattern, normalizeNumber);
  const checks = [
    ...numericSource.matchAll(pythonize(/\b(\d+)\s+(?:[A-Za-z]+\s+)?checks?\s+(passed|failed)\b/gi)),
  ];
  if (checks.length === 1) {
    const [, count, state] = checks[0];
    if (
      !pythonize(new RegExp(`\\b${count}\\b`)).test(numericText) ||
      !pythonize(new RegExp(`\\b${state}\\b`, "i")).test(text)
    ) {
      return false;
    }
    if (verifiedFacts(original).exit_code !== null && ![...text.matchAll(exitClaim)].length) {
      return false;
    }
  }
  const lines = splitLines(original);
  const warnings = lines.filter((line) => pythonize(/^\s*warning:/i).test(line));
  for (const line of warnings) {
    const match = pythonize(
      /\b([A-Za-z]+)\s+(?:are|is|were|was)\s+(omitted|missing|unavailable|absent)\b/i,
    ).exec(line);
    if (match) {
      if (
        ![match[1], match[2]].every((word) =>
          pythonize(new RegExp(`\\b${escapeRegex(word)}\\b`, "i")).test(text),
        )
      ) {
        return false;
      }
      if (
        pythonize(new RegExp(`\\boptional\\s+${escapeRegex(match[1])}\\b`, "i")).test(line) &&
        !pythonize(new RegExp(`\\boptional\\s+${escapeRegex(match[1])}\\b`, "i")).test(text)
      ) {
        return false;
      }
    }
  }
  if (
    lines.some(
      (line) =>
        !warnings.includes(line) &&
        pythonize(/\bordinary\s+(?:[A-Za-z-]+\s+){0,2}annotations?\b/i).test(line),
    ) &&
    !warnings.some((line) => pythonize(/\bannotations?\b/i).test(line)) &&
    pythonize(
      /\bwarnings?\s+(?:about|of|regarding)\b[^.;!?]*\bannotations?\b|\bannotations?\s+(?:are|(?:noted|categorized|classified)\s+as|as)\s+warnings?\b/i,
    ).test(text)
  ) {
    return false;
  }
  return true;
}
function valueText(value: Json): string {
  if (Array.isArray(value)) {
    return value.map(valueText).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(valueText).join("\n");
  }
  return value === null
    ? "None"
    : typeof value === "boolean"
      ? value
        ? "True"
        : "False"
      : String(value);
}
export function validateSummary(
  original: string,
  summary: unknown,
  required: string[],
  _invocation?: Json,
):
  | {
      summary: string;
    }
  | undefined {
  if (
    !summary ||
    Array.isArray(summary) ||
    typeof summary !== "object" ||
    Object.keys(summary).length !== 1 ||
    !("summary" in summary)
  ) {
    return;
  }
  const text = summary.summary;
  if (typeof text !== "string" || !pythonTrim(text) || length(text) > 1600) {
    return;
  }
  if (
    required.some((line) => !splitLines(selectableText(original)).includes(line)) ||
    !coversCriticalFacts(original, text)
  ) {
    return;
  }
  const factual = factualSource(original);
  if (
    !coversCriticalFacts(factual, text) ||
    injection.some((pattern) => pythonize(pattern).test(text)) ||
    (generic.some((pattern) => pythonize(pattern).test(text)) &&
      !casefold(factual).includes(casefold(text)))
  ) {
    return;
  }
  const sourcePaths = pathClaims(factual);
  if ([...pathClaims(text)].some((path) => !sourcePaths.has(path))) {
    return;
  }
  for (const rawPattern of [identifier, number]) {
    const pattern = pythonize(rawPattern);
    const normalize = rawPattern === number ? normalizeNumber : pythonTrim;
    const facts = new Set([...factual.matchAll(pattern)].map((match) => normalize(pythonTrim(match[0]))));
    if ([...text.matchAll(pattern)].some((match) => !facts.has(normalize(pythonTrim(match[0]))))) {
      return;
    }
  }
  const exitCode = verifiedFacts(original).exit_code;
  if (
    [...text.matchAll(exitClaim)].some(
      (match) => exitCode === null || pythonInteger(match[1]) !== exitCode,
    )
  ) {
    return;
  }
  return { summary: pythonTrim(text) };
}

export function summaryFeedback(original: string, summary: unknown, required: string[]): string {
  const text = summary && typeof summary === "object" && "summary" in summary && typeof summary.summary === "string"
    ? summary.summary : "";
  const source = factualSource(original);
  const numbers = new Set([...source.matchAll(pythonize(number))].map(m => normalizeNumber(m[0])));
  const unsupported = [...new Set([...text.matchAll(pythonize(number))].map(m => m[0])
    .filter(token => !numbers.has(normalizeNumber(token))))];
  const sourceIds = new Set([...source.matchAll(pythonize(identifier))].map(m => m[0]));
  const identifiers = [...new Set([...text.matchAll(pythonize(identifier))].map(m => m[0]).filter(token => !sourceIds.has(token)))];
  const paths = [...pathClaims(text)].filter(path => !pathClaims(source).has(path)).sort();
  const critical = [...source.matchAll(pythonize(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\s+(?:catalog|component|package)\b|\b\d+\s+(?:[A-Za-z]+\s+)?checks?\s+(?:passed|failed)\b/gi))].map(m => m[0]);
  return "The previous summary failed factual validation. Correct it once using only the original source. " +
    `Unsupported numeric tokens: ${JSON.stringify(unsupported)}. Unsupported identifiers: ${JSON.stringify(identifiers)}. Unsupported paths: ${JSON.stringify(paths)}. ` +
    `Required source evidence: ${JSON.stringify(required)}. Verified source facts: ${JSON.stringify(verifiedFacts(original))}. Critical source claims: ${JSON.stringify(critical)}. ` +
    "Preserve source subject, status, exit code and warnings exactly; remove instructions and generic commentary. Do not derive counts, ranges or units. Return only the corrected summary in the requested format.";
}

export async function summaryWithRetry(
  original: string, required: string[], request: (feedback?: string) => Promise<unknown>, invocation?: Json,
): Promise<unknown> {
  const first = await request();
  if (first == null) return first;
  if (validateSummary(original, first, required, invocation)) return first;
  return request(summaryFeedback(original, first, required));
}

function factualSource(original: string): string {
  try {
    const decoded = JSON.parse(original);
    if (decoded && !Array.isArray(decoded) && typeof decoded === "object") {
      return `${original}\n${valueText(decoded)}`;
    }
  } catch {
    return original;
  }
  return original;
}
