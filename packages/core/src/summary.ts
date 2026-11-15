import { bytes, length, type Json } from "./model.ts";
import { evidenceIndexes, exitClaim, selectableText, splitLines, verifiedFacts } from "./policy.ts";
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

export const SEQUENCE_CHUNK_BYTES = 32768;
export const SEQUENCE_STEP_MAX_BYTES = 24576;
const ELISION_MARKER = "[... middle content elided for summary budget ...]";

export interface SequenceStepInput {
  call_id: string;
  tool_name: string;
  invocation: Json;
  content: string;
}

export interface PreparedSequenceStep extends SequenceStepInput {
  bounded: string;
}

export type SequenceChunkValidation =
  | { ok: true; sequenceSummary: string; steps: Record<string, string> }
  | { ok: false; feedback: string };

function sliceUtf8Prefix(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(chars.slice(0, mid).join("")) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("");
}

function sliceUtf8Suffix(text: string, maxBytes: number): string {
  if (bytes(text) <= maxBytes) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (bytes(chars.slice(mid).join("")) <= maxBytes) high = mid;
    else low = mid + 1;
  }
  return chars.slice(low).join("");
}

export function boundedSummarySource(
  original: string,
  maxBytes = SEQUENCE_STEP_MAX_BYTES,
): string {
  const budget = Math.max(512, maxBytes);
  const decoded = selectableText(original);
  if (bytes(decoded) <= budget) return decoded;
  const lines = splitLines(decoded);
  const markerBytes = bytes(ELISION_MARKER) + 2;
  if (lines.length <= 2) {
    const half = Math.max(64, Math.floor((budget - markerBytes) / 2));
    return `${sliceUtf8Prefix(decoded, half)}\n${ELISION_MARKER}\n${sliceUtf8Suffix(decoded, half)}`;
  }
  const headBudget = Math.floor((budget - markerBytes * 2) * 0.4);
  const tailBudget = Math.floor((budget - markerBytes * 2) * 0.4);
  const head: string[] = [];
  let headUsed = 0;
  let headEnd = 0;
  while (headEnd < lines.length) {
    const candidate = sliceUtf8Prefix(lines[headEnd], Math.max(128, Math.floor(headBudget / 2)));
    const cost = bytes(candidate) + 1;
    if (headUsed + cost > headBudget) break;
    head.push(candidate);
    headUsed += cost;
    headEnd++;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  let tailStart = lines.length - 1;
  while (tailStart >= headEnd) {
    const candidate = sliceUtf8Suffix(lines[tailStart], Math.max(128, Math.floor(tailBudget / 2)));
    const cost = bytes(candidate) + 1;
    if (tailUsed + cost > tailBudget) break;
    tail.unshift(candidate);
    tailUsed += cost;
    tailStart--;
  }
  const middleLines = lines.slice(headEnd, tailStart + 1);
  const signalSet = new Set(evidenceIndexes(middleLines));
  const highSignalRe = pythonize(
    /^\s*(?:(?:\d+)\s*(?:[:|]\s*|#\S*:\s*))?[A-Za-z_][\p{L}\p{N}_.-]{0,63}\s*[:=]\s*\S|\b(?:error|fail(?:ed|ure)?|warn(?:ing)?)\b/iu,
  );
  const middle: string[] = [];
  let middleUsed = 0;
  const middleBudget = Math.max(0, budget - headUsed - tailUsed - markerBytes * 2);
  for (let i = 0; i < middleLines.length; i++) {
    if (!signalSet.has(i) && !highSignalRe.test(middleLines[i])) continue;
    const candidate = sliceUtf8Prefix(middleLines[i], 320);
    const cost = bytes(candidate) + 1;
    if (middleUsed + cost > middleBudget) break;
    middle.push(candidate);
    middleUsed += cost;
  }
  const sections = [
    ...(head.length ? [head.join("\n")] : []),
    ELISION_MARKER,
    ...(middle.length ? [middle.join("\n"), ELISION_MARKER] : []),
    ...(tail.length ? [tail.join("\n")] : []),
  ];
  return sliceUtf8Prefix(sections.join("\n"), budget);
}

export function chunkSequenceSteps(
  steps: readonly SequenceStepInput[],
  chunkBytes = SEQUENCE_CHUNK_BYTES,
  stepMaxBytes = SEQUENCE_STEP_MAX_BYTES,
): PreparedSequenceStep[][] {
  const effectiveChunk = Math.max(4096, chunkBytes);
  const multiStepCap = steps.length > 1 ? Math.min(stepMaxBytes, 9216) : stepMaxBytes;
  const effectiveStep = Math.min(multiStepCap, Math.max(2048, effectiveChunk - 1536));
  const chunks: PreparedSequenceStep[][] = [];
  let current: PreparedSequenceStep[] = [];
  let currentBytes = 0;
  for (const step of steps) {
    const bounded = boundedSummarySource(step.content, effectiveStep);
    const headerBytes = bytes(
      `--- call_id: ${step.call_id} | tool: ${step.tool_name} | args: ${JSON.stringify(step.invocation)} ---\n`,
    );
    const entryBytes = headerBytes + bytes(bounded) + 2;
    if (current.length > 0 && currentBytes + entryBytes > effectiveChunk) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ ...step, bounded });
    currentBytes += entryBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function sequenceSummaryPrompt(
  chunk: readonly PreparedSequenceStep[],
  priorSummary?: string,
): string {
  const prior =
    priorSummary && pythonTrim(priorSummary)
      ? `Prior steps context (already completed earlier in this sequence):\n${pythonTrim(priorSummary)}\n\n`
      : "";
  const body = chunk
    .map((step) => {
      const inv = step.invocation;
      const args =
        inv && typeof inv === "object" && !Array.isArray(inv) && "arguments" in inv
          ? JSON.stringify(inv.arguments ?? {})
          : JSON.stringify(inv);
      return `--- call_id: ${step.call_id} | tool: ${step.tool_name} | args: ${args} ---\n${step.bounded}`;
    })
    .join("\n\n");
  return (
    "Summarize this chronological tool-execution sequence as strict JSON only (no markdown code fences):\n" +
    '{"sequence_summary":"<1 concise paragraph connecting what the sequence checked, found, and concluded, preserving exact identifiers, numbers, paths, and exit codes>","steps":{"<call_id>":"<1 concise factual sentence (<=200 chars) stating what this step ran and observed>"}}\n' +
    'Include every listed call_id in "steps". Quote only literal numbers, paths, identifiers, and exit codes present in the steps (and Prior steps context if given); never count rows, derive totals/differences, or invent tokens.\n\n' +
    prior +
    body
  );
}

export function hasSummaryInjection(text: string): boolean {
  return injection.some((pattern) => pythonize(pattern).test(text));
}

function parseSequencePayload(
  rawResponse: string,
  chunk: readonly SequenceStepInput[],
): { sequenceSummary: string; steps: Record<string, string> } | null {
  const trimmed = pythonTrim(rawResponse);
  if (!trimmed) return null;
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const seq =
          typeof record.sequence_summary === "string" ? pythonTrim(record.sequence_summary) : "";
        const rawSteps = record.steps;
        if (seq && rawSteps && typeof rawSteps === "object" && !Array.isArray(rawSteps)) {
          const steps: Record<string, string> = {};
          for (const [key, val] of Object.entries(rawSteps as Record<string, unknown>)) {
            if (typeof val === "string" && pythonTrim(val)) steps[key] = pythonTrim(val);
          }
          return { sequenceSummary: seq, steps };
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (chunk.length === 1 && !unfenced.startsWith("{")) {
    return { sequenceSummary: unfenced, steps: { [chunk[0].call_id]: unfenced } };
  }
  return null;
}

export function validateSequenceChunk(
  chunk: readonly SequenceStepInput[],
  rawResponse: string,
  priorSummary?: string,
): SequenceChunkValidation {
  const parsed = parseSequencePayload(rawResponse, chunk);
  if (!parsed) {
    return {
      ok: false,
      feedback:
        'Invalid response format. Return strict JSON {"sequence_summary":"...","steps":{"<call_id>":"..."}} covering every call_id.',
    };
  }
  const missingIds = chunk
    .map((step) => step.call_id)
    .filter((id) => !parsed.steps[id] || length(parsed.steps[id]) > 200);
  if (missingIds.length > 0 || length(parsed.sequenceSummary) > 1200) {
    return {
      ok: false,
      feedback: `Provide concise entries (<=200 chars per step, <=1200 chars for sequence_summary) for every call_id. Missing or oversize call_ids: ${JSON.stringify(missingIds)}.`,
    };
  }
  const corpus = [
    priorSummary ?? "",
    ...chunk.map((step) => `${factualSource(step.content)}\n${JSON.stringify(step.invocation)}`),
  ].join("\n");
  const sourcePaths = pathClaims(corpus);
  const idRe = pythonize(identifier);
  const numRe = pythonize(number);
  const allowedIds = new Set([...corpus.matchAll(idRe)].map((m) => pythonTrim(m[0])));
  const allowedNums = new Set([...corpus.matchAll(numRe)].map((m) => normalizeNumber(pythonTrim(m[0]))));
  const allowedExits = new Set<number>();
  for (const step of chunk) {
    const code = verifiedFacts(step.content).exit_code;
    if (code !== null) allowedExits.add(code);
  }
  if (priorSummary) {
    for (const match of priorSummary.matchAll(exitClaim)) allowedExits.add(pythonInteger(match[1]));
  }
  const badNumbers = new Set<string>();
  const badIds = new Set<string>();
  const badPaths = new Set<string>();
  let badExit = false;
  const checkClaim = (text: string, stepExit: number | null | undefined) => {
    if (
      hasSummaryInjection(text) ||
      (generic.some((p) => pythonize(p).test(text)) && !casefold(corpus).includes(casefold(text)))
    ) {
      return false;
    }
    for (const p of pathClaims(text)) if (!sourcePaths.has(p)) badPaths.add(p);
    for (const m of text.matchAll(idRe)) {
      const tok = pythonTrim(m[0]);
      if (!allowedIds.has(tok)) badIds.add(tok);
    }
    for (const m of text.matchAll(numRe)) {
      const raw = pythonTrim(m[0]);
      if (!allowedNums.has(normalizeNumber(raw))) badNumbers.add(raw);
    }
    for (const m of text.matchAll(exitClaim)) {
      const claimed = pythonInteger(m[1]);
      if (stepExit !== undefined && stepExit !== null) {
        if (claimed !== stepExit) badExit = true;
      } else if (!allowedExits.has(claimed)) {
        badExit = true;
      }
    }
    return true;
  };
  if (!checkClaim(parsed.sequenceSummary, undefined)) {
    return {
      ok: false,
      feedback:
        "Summary contained disallowed instruction or generic filler text. Quote concrete facts from the steps only.",
    };
  }
  for (const step of chunk) {
    if (!checkClaim(parsed.steps[step.call_id], verifiedFacts(step.content).exit_code)) {
      return {
        ok: false,
        feedback: `Step summary for ${step.call_id} contained disallowed instruction or generic filler text. State concrete facts only.`,
      };
    }
  }
  if (badNumbers.size || badIds.size || badPaths.size || badExit) {
    return {
      ok: false,
      feedback:
        "The previous sequence summary failed factual validation. Correct it once using only tokens present in the provided steps and prior context. " +
        `Unsupported numeric tokens: ${JSON.stringify([...badNumbers])}. ` +
        `Unsupported identifiers: ${JSON.stringify([...badIds])}. ` +
        `Unsupported paths: ${JSON.stringify([...badPaths])}. ` +
        (badExit ? "Remove or fix unverified exit code claims. " : "") +
        "Return strict JSON only.",
    };
  }
  return { ok: true, sequenceSummary: parsed.sequenceSummary, steps: parsed.steps };
}

export function composeHybridSlotSummaries(
  orderedSteps: readonly SequenceStepInput[],
  stepTraces: Readonly<Record<string, string>>,
  finalSequenceSummary: string,
): Record<string, string> {
  const summarized = orderedSteps.filter((step) => !!stepTraces[step.call_id]);
  if (summarized.length === 0) return {};
  if (summarized.length === 1) {
    const only = summarized[0];
    return { [only.call_id]: pythonTrim(finalSequenceSummary) || stepTraces[only.call_id] };
  }
  const out: Record<string, string> = {};
  const lastIndex = summarized.length - 1;
  for (let i = 0; i < summarized.length; i++) {
    const step = summarized[i];
    const inv = step.invocation;
    // Json object union includes PythonFloat; narrow plain argument dictionaries into a string-keyed map.
    const argsObj: Record<string, unknown> =
      inv &&
      typeof inv === "object" &&
      !Array.isArray(inv) &&
      "arguments" in inv &&
      inv.arguments &&
      typeof inv.arguments === "object" &&
      !Array.isArray(inv.arguments)
        ? (inv.arguments as unknown as Record<string, unknown>)
        : {};
    const rawHint = String(
      argsObj.command ||
        argsObj.path ||
        argsObj.pattern ||
        argsObj.query ||
        argsObj.agentId ||
        argsObj.provider ||
        "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 48);
    const prefix = `[${step.tool_name}${rawHint ? `: ${rawHint}` : ""}]`;
    const trace = `${prefix} ${stepTraces[step.call_id]}`;
    out[step.call_id] =
      i === lastIndex && pythonTrim(finalSequenceSummary)
        ? `${trace}\n[Sequence summary] ${pythonTrim(finalSequenceSummary)}`
        : trace;
  }
  return out;
}
