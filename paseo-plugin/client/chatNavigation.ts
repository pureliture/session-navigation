import type { Row } from "../shared/sessionNav";
import type { TimelineHistory } from "./timelineHistory";
import { fallbackToolPreview } from "./toolPreview";
import { focusedSessionTab } from "./hostCompat";

const GROUP = '[data-testid="tool-call-group"]';
const BADGE = '[data-testid="tool-call-badge"]';
const ROW = "[data-message-id], [data-history-row-id]";
const TURN_SUMMARY = '[data-testid="turn-summary"]';
const FOLLOWING = 4;

const SYSTEM_BLOCK_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<system-notice>[\s\S]*?<\/system-notice>/gu;

function stripSystemBlocks(text: string): string {
  return text.replace(SYSTEM_BLOCK_RE, "");
}

function normalized(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`+/gu, "")
    .replace(/\*\*|__|~~/gu, "")
    .replace(/(?:^|\s)[#>*-]+\s+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function normalizedClean(text: string): string {
  return normalized(stripSystemBlocks(text));
}

function matchesNeedle(rawText: string, needle: string): boolean {
  if (!needle) return false;
  if (needle.length >= 4) {
    return normalizedClean(rawText).includes(needle) || normalized(rawText).includes(needle);
  }
  const cleaned = stripSystemBlocks(rawText);
  if (normalized(cleaned) === needle) return true;
  return cleaned.split(/\r?\n/u).some((line) => normalized(line) === needle);
}

const IDENTITY_ATTRIBUTES = ["data-message-id", "data-history-row-id", "data-call-id", "data-item-id", "data-turn-id", "id"];

export function identityMatches(value: string, id: string): boolean {
  if (value === id || value === `agent_tool_${id}` || value.endsWith(`/${encodeURIComponent(id)}`) ||
    value === `message-${id}` || value === `call-${id}` || value === `turn-${id}` ||
    value === `tool-${id}` || value === `tool_call_${id}`) return true;
  return id.length >= 6 && (value.endsWith(`_${id}`) || value.endsWith(`:${id}`));
}

function textNeedles(hints: (string | undefined)[]): string[] {
  const all = hints
    .map((hint) => normalizedClean(hint ?? "").slice(0, 36))
    .filter((needle) => needle.length > 0);
  const long = all.filter((needle) => needle.length >= 4);
  if (long.length > 0) return [...new Set(long)];
  return [...new Set(all)];
}

/** Candidate needles for a user/assistant row across native, summarized, and rendered chat text. */
function messageHints(row: Row): string[] {
  const longHints: string[] = [];
  const shortHints: string[] = [];
  const push = (value?: string) => {
    if (!value) return;
    const norm = normalizedClean(value);
    if (!norm) return;
    if (norm.length >= 4) {
      if (!longHints.includes(value)) longHints.push(value);
    } else if (!shortHints.includes(value)) {
      shortHints.push(value);
    }
  };
  if (
    row.summary_line &&
    !row.summary_line.startsWith("[Subagent ") &&
    !row.summary_line.startsWith("[Agent message")
  ) {
    for (const line of row.summary_line.split(/\r?\n/u)) {
      push(line);
    }
  }
  if (!row.message_text) return longHints.length > 0 ? longHints : shortHints;
  const raw = stripSystemBlocks(row.message_text).trim();
  const decoded = raw.replace(/&quot;/gu, '"').replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
  if (!decoded.startsWith("<paseo-system")) {
    for (const line of decoded.split(/\r?\n/u)) {
      const clean = line.replace(/<[^>]+>/gu, " ").trim();
      if (clean) {
        push(clean);
        if (longHints.length >= 4) break;
      }
    }
    push(decoded.replace(/<[^>]+>/gu, " ").trim());
    return longHints.length > 0 ? longHints : shortHints;
  }
  push(/source-agent-title="([^"]+)"/u.exec(decoded)?.[1]);
  push(/source-agent-id="([^"]+)"/u.exec(decoded)?.[1]);
  const responseMarker = "<agent-response>";
  const response = /<agent-response>([\s\S]*?)<\/agent-response>/u.exec(decoded)?.[1] ??
    (decoded.includes(responseMarker) ? decoded.slice(decoded.indexOf(responseMarker) + responseMarker.length) : undefined);
  const innerBody = response ?? decoded.replace(/^<paseo-system\b[^>]*(?:>|$)/u, "").replace(/<\/paseo-system>/gu, "");
  push(innerBody.replace(/<[^>]+>/gu, " ").split(/\r?\n/u).map((line) => line.trim()).find(Boolean));
  return longHints.length > 0 ? longHints : shortHints;
}

/** Identity attributes rendered in the chat currently on screen; null when no session chat is visible. */
export function visibleChatValues(doc: any): string[] | null {
  const roots = (Array.from(doc?.querySelectorAll?.('[data-testid="agent-chat-scroll"]') ?? []) as any[]).filter(visible);
  if (roots.length === 0) return null;
  const selector = IDENTITY_ATTRIBUTES.map((attr) => `[${attr}]`).join(", ");
  return roots.flatMap((root) => (Array.from(root.querySelectorAll(selector)) as any[]).flatMap((node) =>
    IDENTITY_ATTRIBUTES.map((attr) => node.getAttribute(attr)).filter((v): v is string => !!v)));
}

function findIdentity(root: any, row: Row): any {
  const ids = [row.tool_call_id, row.item_id,
    row.item_id?.startsWith("user-") ? row.item_id.slice(5) : undefined,
    row.item_id?.startsWith("ast-") ? row.item_id.slice(4) : undefined,
  ].filter(Boolean) as string[];
  for (const node of Array.from(root.querySelectorAll(IDENTITY_ATTRIBUTES.map((attr) => `[${attr}]`).join(", "))) as any[]) {
    if (IDENTITY_ATTRIBUTES.some((attr) => {
      const value = node.getAttribute(attr);
      return value && ids.some((id) => identityMatches(value, id));
    })) return node;
  }
  return null;
}

function findTextMatches(root: any, snippet?: string | string[], selector = ROW): any[] {
  const needles = textNeedles(Array.isArray(snippet) ? snippet : [snippet]);
  if (needles.length === 0) return [];
  return (Array.from(root.querySelectorAll(selector)) as any[]).filter((node) => {
    const raw = node.textContent ?? "";
    return needles.some((needle) => matchesNeedle(raw, needle));
  });
}

function findText(root: any, snippet?: string | string[], selector = ROW, preferLast = false): any {
  const matches = findTextMatches(root, snippet, selector);
  if (matches.length === 0) return null;
  return preferLast ? matches[matches.length - 1] : matches[0];
}

function rowPositionIndex(rows: Row[], target: Row): number {
  return rows.findIndex(
    (candidate) =>
      candidate === target ||
      (!!target.item_id && candidate.item_id === target.item_id) ||
      (!!target.tool_call_id && candidate.tool_call_id === target.tool_call_id),
  );
}

function toolHint(row: Pick<Row, "tool_input">): string | undefined {
  try {
    const input = JSON.parse(row.tool_input ?? "null");
    return input?.command ?? input?.path ?? input?.CommandLine ?? input?.Path ??
      input?.pattern ?? input?.query ?? input?.url ?? input?.code ?? input?.image_path ??
      input?.name ?? input?.agentId ?? input?.terminalId ??
      (Array.isArray(input?.urls) ? input.urls[0] : undefined) ?? row.tool_input;
  } catch {
    return row.tool_input;
  }
}

export function historyContainsRow(history: TimelineHistory, row: Row): boolean {
  const kind = row.kind ?? "tool";
  const isSystemNotice = Boolean(
    row.message_text?.trimStart().startsWith("<paseo-system") ||
    row.summary_line?.startsWith("[Subagent "),
  );
  return history.entries.some(({ item }) => {
    if (!item) return false;
    const type = String(item.type ?? "");
    if (kind === "user") {
      if (type !== "user_message" && !(isSystemNotice && ["plugin", "notification", "tool_call"].includes(type))) {
        return false;
      }
    } else if (kind === "assistant" || kind === "agent") {
      if (type !== "assistant_message" && type !== "error" && type !== "notification" &&
        type !== "plugin" && type !== "todo" && type !== "compaction") return false;
    } else if (!["tool_call", "command", "terminal", "bash", "shell", "todo"].includes(type)) {
      return false;
    }
    const detail = typeof item.detail === "object" && item.detail !== null
      ? item.detail as Record<string, unknown> : {};
    const ids = [item.messageId, item.clientMessageId, item.id, item.callId, detail.call_id];
    if (ids.some((value) => typeof value === "string" &&
      [row.item_id, row.tool_call_id].some((id) => id && identityMatches(value, id)))) return true;
    const preview = fallbackToolPreview(item, detail);
    const todoText = Array.isArray(item.items)
      ? item.items.map((entry: any) => (typeof entry?.text === "string" ? entry.text : "")).join(" ")
      : undefined;
    const pluginText = item.data !== undefined ? JSON.stringify(item.data) : undefined;
    const texts = kind === "tool"
      ? [preview.tool_input, toolHint(preview), preview.tool_output, detail.text, detail.label, todoText]
      : [item.text, item.message, pluginText, todoText];
    const hints = kind === "tool" ? [row.summary_line, row.tool_output, toolHint(row)] : messageHints(row);
    return textNeedles(hints).some((needle) =>
      texts.some((text) => typeof text === "string" && matchesNeedle(text, needle)),
    );
  });
}

const HIGHLIGHT_BG = "rgba(59, 130, 246, 0.22)";
type HighlightTimer = Parameters<typeof clearTimeout>[0];
const highlightStates = new WeakMap<
  any,
  { bg: string; transition: string; timer: HighlightTimer }
>();
let activeHighlightedNode: any = null;

function clearHighlightNode(node: any): void {
  const state = node ? highlightStates.get(node) : undefined;
  if (!state) return;
  clearTimeout(state.timer);
  highlightStates.delete(node);
  if (activeHighlightedNode === node) activeHighlightedNode = null;
  if (node.style && node.style.backgroundColor === HIGHLIGHT_BG) {
    node.style.backgroundColor = state.bg;
    node.style.transition = state.transition;
  }
}

export function clearChatHighlight(): void {
  if (activeHighlightedNode) clearHighlightNode(activeHighlightedNode);
}

function highlightAndScroll(
  node: any,
  opts?: { tail?: boolean; releaseFollow?: boolean; root?: any; doc?: any },
): boolean {
  if (!node) return false;
  if (activeHighlightedNode && activeHighlightedNode !== node) {
    clearHighlightNode(activeHighlightedNode);
  }
  const isTail = Boolean(opts?.tail);
  if (!isTail && opts?.releaseFollow && opts?.root && opts?.doc) {
    const scrollable = chatScroller(opts.root);
    emitScroll(scrollable, opts.doc, "wheel", -24);
    if (typeof scrollable?.scrollTop === "number" && scrollable.scrollTop > 0) {
      const nudged = Math.max(0, scrollable.scrollTop - 16);
      if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top: nudged, behavior: "instant" });
      else scrollable.scrollTop = nudged;
    }
    emitScroll(scrollable, opts.doc, "scroll", -24);
  }
  node.scrollIntoView?.({ behavior: isTail ? "instant" : "smooth", block: isTail ? "end" : "center" });
  if (isTail && opts?.root) {
    const scrollable = chatScroller(opts.root);
    const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
    if (extent > 0) {
      const style = opts.doc?.defaultView?.getComputedStyle?.(scrollable);
      const negative = style?.flexDirection === "column-reverse" || scrollable.scrollTop < 0;
      const inverted =
        !negative &&
        (style?.transform === "scaleY(-1)" ||
          /^matrix\([^,]+,[^,]+,[^,]+,\s*-1,/.test(style?.transform ?? ""));
      const bottomTop = negative ? 0 : inverted ? 0 : extent;
      if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top: bottomTop, behavior: "instant" });
      else scrollable.scrollTop = bottomTop;
      if (opts.doc) {
        emitScroll(scrollable, opts.doc, "wheel", 1);
        emitScroll(scrollable, opts.doc, "scroll", 1);
      }
    }
  }
  if (node.style) {
    const existing = highlightStates.get(node);
    if (existing) clearTimeout(existing.timer);
    const bg = existing ? existing.bg : (node.style.backgroundColor === HIGHLIGHT_BG ? "" : (node.style.backgroundColor ?? ""));
    const transition = existing ? existing.transition : (node.style.transition ?? "");
    node.style.transition = "background-color 0.3s ease";
    node.style.backgroundColor = HIGHLIGHT_BG;
    activeHighlightedNode = node;
    const timer = setTimeout(() => {
      clearHighlightNode(node);
    }, 1200);
    highlightStates.set(node, { bg, transition, timer });
  }
  return true;
}

type Turn = { summary: any; boundary: any };

const before = (node: any, other: any) => !other || (node.compareDocumentPosition(other) & FOLLOWING) !== 0;
const after = (node: any, other: any) => (other.compareDocumentPosition(node) & FOLLOWING) !== 0;

function anchorOf(root: any, row: Row, from?: any): any {
  const direct = findIdentity(root, row);
  if (direct && (!from || after(direct, from))) return direct;
  const needles = textNeedles(messageHints(row));
  if (needles.length === 0) return null;
  return (Array.from(root.querySelectorAll(ROW)) as any[]).find((node) => {
    const raw = node.textContent ?? "";
    return (!from || after(node, from)) && needles.some((needle) => matchesNeedle(raw, needle));
  }) ?? null;
}

function rowComparisonOrder(nodes: any[], node: any, anchor: any, direction: "after" | "before"): boolean {
  const nodeIdx = nodes.indexOf(node);
  const anchorIdx = nodes.indexOf(anchor);
  if (nodeIdx >= 0 && anchorIdx >= 0) {
    return direction === "after" ? nodeIdx > anchorIdx : nodeIdx < anchorIdx;
  }
  return direction === "after" ? after(node, anchor) : before(node, anchor);
}

function rowNeedles(candidate: Row): string[] {
  return textNeedles(
    candidate.kind === "tool" ? [toolHint(candidate), candidate.summary_line] : messageHints(candidate),
  );
}

function findUniqueRowAnchor(root: any, candidate: Row): any {
  const direct = findIdentity(root, candidate);
  if (direct) return direct;
  const matches = findTextMatches(root, messageHints(candidate), ROW);
  return matches.length === 1 ? matches[0] : null;
}

function findRowMessageNode(
  root: any,
  rows: Row[],
  targetIdx: number,
  row: Row,
  mountedIndices?: number[],
): any {
  const needles = rowNeedles(row);
  if (needles.length === 0) return null;
  const domRows = Array.from(root.querySelectorAll(ROW)) as any[];
  const allMatches = domRows.filter((node) => {
    const raw = node.textContent ?? "";
    return needles.some((needle) => matchesNeedle(raw, needle));
  });
  if (allMatches.length === 0) return null;
  if (allMatches.length === 1 || targetIdx < 0 || rows.length === 0) {
    return allMatches[0];
  }

  let lowerIdx = -1;
  let lowerNode: any = null;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (rows[i].kind === "tool") continue;
    const anchor = findUniqueRowAnchor(root, rows[i]);
    if (anchor) {
      lowerIdx = i;
      lowerNode = anchor;
      break;
    }
  }

  let upperIdx = rows.length;
  let upperNode: any = null;
  for (let j = targetIdx + 1; j < rows.length; j++) {
    if (rows[j].kind === "tool") continue;
    const anchor = findUniqueRowAnchor(root, rows[j]);
    if (anchor && (!lowerNode || rowComparisonOrder(domRows, anchor, lowerNode, "after"))) {
      upperIdx = j;
      upperNode = anchor;
      break;
    }
  }

  const boundedMatches = allMatches.filter(
    (node) =>
      (!lowerNode || rowComparisonOrder(domRows, node, lowerNode, "after")) &&
      (!upperNode || rowComparisonOrder(domRows, node, upperNode, "before")),
  );
  if (boundedMatches.length === 0) return null;
  if (boundedMatches.length === 1) return boundedMatches[0];

  const primaryNeedle = needles[0];
  const peerIndices: number[] = [];
  for (let k = lowerIdx + 1; k < upperIdx; k++) {
    const candidate = rows[k];
    if ((row.kind === "tool") !== (candidate.kind === "tool")) continue;
    const cNeedles = rowNeedles(candidate);
    if (cNeedles.includes(primaryNeedle) || needles.some((n) => cNeedles.includes(n))) {
      peerIndices.push(k);
    }
  }
  const ordFromStart = peerIndices.indexOf(targetIdx);
  if (ordFromStart < 0) {
    return targetIdx >= rows.length / 2
      ? boundedMatches[boundedMatches.length - 1]
      : boundedMatches[0];
  }
  const ordFromEnd = peerIndices.length - 1 - ordFromStart;
  if (boundedMatches.length === peerIndices.length) {
    return boundedMatches[ordFromStart];
  }
  if (lowerNode && !upperNode) {
    return boundedMatches[Math.min(ordFromStart, boundedMatches.length - 1)];
  }
  if (upperNode && !lowerNode) {
    return boundedMatches[Math.max(0, boundedMatches.length - 1 - ordFromEnd)];
  }
  if (!lowerNode && !upperNode && mountedIndices && mountedIndices.length > 0) {
    const minMounted = Math.min(...mountedIndices);
    const maxMounted = Math.max(...mountedIndices);
    if (minMounted > 0 && maxMounted >= rows.length - 3) {
      return boundedMatches[Math.max(0, boundedMatches.length - 1 - ordFromEnd)];
    }
    if (maxMounted < rows.length - 1 && minMounted <= 2) {
      return boundedMatches[Math.min(ordFromStart, boundedMatches.length - 1)];
    }
  }
  return targetIdx < rows.length / 2
    ? boundedMatches[Math.min(ordFromStart, boundedMatches.length - 1)]
    : boundedMatches[Math.max(0, boundedMatches.length - 1 - ordFromEnd)];
}

// Paseo folds finished turns behind a "turn-summary" badge rendered after the user message.
// The turn ends at the next summary or the next user message, whichever comes first.
function findTurn(root: any, rows: Row[], start: number, end: number): Turn | null {
  const summaries = Array.from(root.querySelectorAll(TURN_SUMMARY)) as any[];
  if (summaries.length === 0) return null;
  let anchor: any = null;
  for (let i = start - 1; i >= 0 && !anchor; i--) {
    if (rows[i].kind !== "user") continue;
    anchor = anchorOf(root, rows[i]);
    if (!anchor) return null;
  }
  if (!anchor) return null;
  const nextUser = rows.slice(end).find((candidate) => candidate.kind === "user");
  const userBoundary = nextUser ? anchorOf(root, nextUser, anchor) : null;
  const summary = summaries.find((candidate) => after(candidate, anchor));
  if (!summary || !before(summary, userBoundary)) return null;
  const nextSummary = summaries.find((candidate) => after(candidate, summary));
  const boundary = [nextSummary, userBoundary].filter(Boolean)
    .sort((x, y) => (before(x, y) ? -1 : 1))[0] ?? null;
  return { summary, boundary };
}

function turnNodes(root: any, turn: Turn, selector: string): any[] {
  return (Array.from(root.querySelectorAll(selector)) as any[]).filter((node) =>
    after(node, turn.summary) && before(node, turn.boundary));
}

function turnCollapsed(root: any, turn: Turn): boolean {
  const state = turn.summary.getAttribute?.("aria-expanded");
  if (state != null) return state === "false";
  return turnNodes(root, turn, `${BADGE}, ${GROUP}`).length === 0;
}

function visible(node: any): boolean {
  if (!node) return false;
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
  if (typeof node.closest === "function" && node.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  try {
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  } catch {
    // Ignore mock DOMs without getComputedStyle.
  }
  return true;
}

// Paseo keeps other agents' chats mounted (hidden); bind to the one showing this session.
// Exact identities outrank visibility, which outranks loose snippet matches.
function pickChatRoot(doc: any, rows: Row[], target: Row, visibleOnly = false): any {
  const roots = (Array.from(doc?.querySelectorAll?.('[data-testid="agent-chat-scroll"]') ?? []) as any[]).filter((root) => !visibleOnly || visible(root));
  if (visibleOnly && roots.length !== 1) return null;
  if (roots.length <= 1) return roots[0] ?? null;
  const messages = rows.filter((candidate) => candidate.kind !== "tool");
  const ranked = roots.map((root) => [
    root,
    findIdentity(root, target) ? 1 : 0,
    messages.filter((candidate) => findIdentity(root, candidate)).length,
    visible(root) ? 1 : 0,
    messages.filter((candidate) => findText(root, messageHints(candidate))).length,
  ] as const).sort((x, y) => (y[1] - x[1]) || (y[2] - x[2]) || (y[3] - x[3]) || (y[4] - x[4]));
  return ranked[0][0];
}

let navigationVersion = 0;

export function cancelChatNavigation(): void {
  navigationVersion++;
  clearChatHighlight();
}

type NavigationOptions = {
  visibleOnly?: boolean;
  openAgent?: { agentId: string; open: () => void };
  document?: any;
  afterExpand?: () => Promise<void>;
  afterLoad?: () => Promise<void>;
  now?: () => number;
  onStart?: () => void;
  onNotFound?: () => void;
  getHistory?: () => Promise<TimelineHistory>;
  historyTimeoutMs?: number;
  timeoutMs?: number;
  turnExpanded?: boolean;
};

function chatScroller(root: any): any {
  return [root, ...Array.from(root.querySelectorAll("*"))].find((node: any) =>
    node.scrollHeight > node.clientHeight) ?? root;
}

function emitScroll(scrollable: any, doc: any, type: "scroll" | "wheel", deltaY = -1): void {
  const Constructor = doc?.defaultView?.[type === "wheel" ? "WheelEvent" : "Event"];
  if (Constructor) scrollable.dispatchEvent?.(new Constructor(type, { bubbles: true, deltaY }));
}

type SearchBounds = { low?: number; high?: number; extent?: number };
type SeekOutcome = "moved" | "needOlder" | "atNewerEdge" | "unknown";

function mountedRowIndices(root: any, rows: Row[]): { indices: number[]; virtual: any[] } {
  const virtual = Array.from(root.querySelectorAll("[data-history-row-id][data-index]")) as any[];
  let nodes = virtual.length ? virtual : (Array.from(root.querySelectorAll(ROW)) as any[]);
  const viewport = root.getBoundingClientRect?.();
  if (viewport) {
    const nearby = nodes.filter((node) => {
      const rect = node.getBoundingClientRect?.();
      return rect && rect.bottom >= viewport.top && rect.top <= viewport.bottom;
    });
    if (nearby.length) nodes = nearby;
  }
  const indices = nodes.flatMap((node) => {
    const values = IDENTITY_ATTRIBUTES.map((attr) => node.getAttribute(attr)).filter(Boolean) as string[];
    const idIndex = rows.findIndex((candidate) =>
      values.some((value) =>
        [candidate.item_id, candidate.tool_call_id].some((id) => id && identityMatches(value, id)),
      ),
    );
    if (idIndex >= 0) return [idIndex];
    // Never treat Paseo's 40-item virtualizer `data-index` as an index into Outline `rows`.
    const raw = node.textContent ?? "";
    let longest = 0;
    let matched: number[] = [];
    rows.forEach((candidate, candidateIndex) => {
      const needles = textNeedles(
        candidate.kind === "tool" ? [toolHint(candidate), candidate.summary_line] : messageHints(candidate),
      );
      const needle = needles.filter((value) => matchesNeedle(raw, value)).sort((x, y) => y.length - x.length)[0];
      if (needle) {
        if (needle.length > longest) {
          longest = needle.length;
          matched = [candidateIndex];
        } else if (needle.length === longest) {
          matched.push(candidateIndex);
        }
      }
    });
    return matched;
  });
  return { indices, virtual };
}

function seekMountedWindow(
  root: any,
  doc: any,
  rows: Row[],
  target: Row,
  bounds: SearchBounds,
): SeekOutcome {
  const targetIndex = rowPositionIndex(rows, target);
  if (targetIndex < 0) return "needOlder";
  const { indices: mounted, virtual } = mountedRowIndices(root, rows);
  const scrollable = chatScroller(root);
  const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
  if (!(extent > 0)) return targetIndex < rows.length / 2 ? "needOlder" : "unknown";
  const style = doc?.defaultView?.getComputedStyle?.(scrollable);
  const negative = style?.flexDirection === "column-reverse" || scrollable.scrollTop < 0;
  const inverted =
    !negative &&
    (style?.transform === "scaleY(-1)" ||
      /^matrix\([^,]+,[^,]+,[^,]+,\s*-1,/.test(style?.transform ?? ""));
  const position = negative
    ? scrollable.scrollTop + extent
    : inverted
      ? extent - scrollable.scrollTop
      : scrollable.scrollTop;
  const older =
    mounted.length > 0
      ? targetIndex < (Math.min(...mounted) + Math.max(...mounted)) / 2
      : position >= extent - 2
        ? true
        : (targetIndex / Math.max(1, rows.length - 1)) <= (position / extent);
  if (bounds.extent !== extent) {
    bounds.low = undefined;
    bounds.high = undefined;
    bounds.extent = extent;
  }
  if (older && position <= 1) {
    if (virtual.length > 0 && !virtual.some((node) => node.getAttribute("data-index") === "0")) {
      return "moved";
    }
    return "needOlder";
  }
  if (!older && position >= extent - 1) return "atNewerEdge";
  if (!mounted.length) {
    const next = older ? Math.max(0, position - scrollable.clientHeight * 2) : extent;
    const top = negative ? next - extent : inverted ? extent - next : next;
    emitScroll(scrollable, doc, "wheel", older ? -1 : 1);
    if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top, behavior: "instant" });
    else scrollable.scrollTop = top;
    emitScroll(scrollable, doc, "scroll", older ? -1 : 1);
    return "moved";
  }
  const first = Math.min(...mounted);
  const last = Math.max(...mounted);
  if (older) bounds.high = position;
  else bounds.low = position;
  const gap = older ? first - targetIndex : targetIndex - last;
  const step =
    scrollable.clientHeight * Math.max(0.8, Math.min(8, gap / Math.max(1, last - first + 1)));
  const next =
    !older && targetIndex >= rows.length - 2
      ? extent
      : bounds.low !== undefined && bounds.high !== undefined
        ? (bounds.low + bounds.high) / 2
        : Math.max(0, Math.min(extent, position + (older ? -step : step)));
  const top = negative ? next - extent : inverted ? extent - next : next;
  if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top, behavior: "instant" });
  else scrollable.scrollTop = top;
  emitScroll(scrollable, doc, "scroll", older ? -1 : 1);
  return "moved";
}

function loadOlder(root: any, doc: any): void {
  const scrollable = chatScroller(root);
  const emit = (type: "scroll" | "wheel") => {
    emitScroll(scrollable, doc, type);
  };
  const reversed = doc.defaultView?.getComputedStyle?.(scrollable)?.flexDirection === "column-reverse" ||
    scrollable.scrollTop < 0;
  const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
  const top = reversed ? -extent : 0;
  const scroll = (position: number) => {
    if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top: position, behavior: "instant" });
    else scrollable.scrollTop = position;
    emit("scroll");
  };
  // Paseo latches pagination at the edge. Leave its 96px threshold before re-entering.
  scroll(top + Math.min(extent, 192));
  emit("wheel");
  const edge = root.querySelector('[data-testid="older-history-slot"]') ?? root.querySelector(ROW);
  edge?.scrollIntoView?.({ behavior: "instant", block: "start" });
  if (!root.querySelector('[data-testid="older-history-slot"]')) {
    scroll(top);
  } else {
    emit("scroll");
  }
  // Upward wheel intent also rearms a latched/dormant paginator already at scrollTop=0.
  emit("wheel");
}

export async function scrollToMessageInChat(
  row: Row,
  rows: Row[],
  options: NavigationOptions = {},
): Promise<boolean> {
  const version = ++navigationVersion;
  let found = false;
  try {
    options.onStart?.();
    found = await withTimeout(navigate(row, rows, version, options), options.timeoutMs ?? 60000);
    return found;
  } catch {
    return false;
  } finally {
    if (!found && version === navigationVersion) {
      navigationVersion++;
      options.onNotFound?.();
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Chat navigation timed out")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function navigate(row: Row, rows: Row[], version: number, options: NavigationOptions): Promise<boolean> {
  const doc = options.document ?? (globalThis as unknown as { document?: any }).document;
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  if (options.openAgent) {
    options.openAgent.open();
    for (;;) {
      if (version !== navigationVersion) return false;
      const tab = focusedSessionTab(doc);
      if (tab?.kind === "agent" && tab.agentId === options.openAgent.agentId &&
        (Array.from(doc?.querySelectorAll?.('[data-testid="agent-chat-scroll"]') ?? []) as any[]).some(visible)) break;
      await (options.afterLoad ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100))))();
    }
  }
  const root = pickChatRoot(doc, rows.length > 0 ? rows : [row], row, options.visibleOnly);
  if (!root) return false;
  const targetIdx = rowPositionIndex(rows, row);
  if (findIdentity(root, row)) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
  } else {
    const { indices: mounted } = mountedRowIndices(root, rows);
    if (findRowMessageNode(root, rows, targetIdx, row, mounted)) {
      const windowCoversTarget =
        mounted.length === 0 ||
        targetIdx < 0 ||
        (targetIdx >= Math.min(...mounted) - 2 && targetIdx <= Math.max(...mounted) + 2);
      if (windowCoversTarget && (await navigateLoaded(row, rows, root, version, options))) return true;
    }
  }
  const history = options.getHistory
    ? await withTimeout(options.getHistory(), options.historyTimeoutMs ?? 3000) : undefined;
  if (version !== navigationVersion) return false;
  if (history?.complete && !historyContainsRow(history, row)) return false;
  const now = options.now ?? Date.now;
  const deadline = now() + 60000;
  const wait = options.afterLoad ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  let lastAttempt = -Infinity;
  const bounds: SearchBounds = {};
  const signature = () => JSON.stringify((Array.from(root.querySelectorAll(ROW)) as any[]).map((node) =>
    [node.getAttribute("data-history-row-id"), node.getAttribute("data-message-id"), node.getAttribute("data-index")]));
  let previousSignature = signature(), lastProgress = now();
  while (version === navigationVersion) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
    if (version !== navigationVersion) return false;
    if (now() >= deadline) break;
    const currentSignature = signature();
    if (currentSignature !== previousSignature) { previousSignature = currentSignature; lastProgress = now(); }
    if (history?.complete && now() - lastProgress >= 4000 &&
      !root.querySelector('[data-testid="load-older-history-spinner"]')) break;
    if (!root.querySelector('[data-testid="load-older-history-spinner"]') && now() - lastAttempt >= 100) {
      const outcome = seekMountedWindow(root, doc, rows, row, bounds);
      if (outcome === "moved" || outcome === "atNewerEdge") {
        lastAttempt = now();
      } else if (outcome === "needOlder" && now() - lastAttempt >= 250) {
        loadOlder(root, doc);
        lastAttempt = now();
      }
    }
    await wait();
  }
  return false;
}

async function navigateLoaded(row: Row, rows: Row[], root: any, version: number, options: NavigationOptions): Promise<boolean> {
  const doc = options.document ?? (globalThis as unknown as { document?: any }).document;
  const targetIdx = rowPositionIndex(rows, row);
  const preferLast = targetIdx >= 0 && targetIdx >= rows.length / 2;
  const isTail = rows.length > 1 && targetIdx >= rows.length - 1;
  const hlOpts = { tail: isTail, releaseFollow: rows.length > 1 && !isTail, root, doc };
  const direct = findIdentity(root, row);
  if (row.kind !== "tool") {
    if (direct) return highlightAndScroll(direct, hlOpts);
    const { indices: mounted } = mountedRowIndices(root, rows);
    const scrollable = chatScroller(root);
    const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
    const atNewerEdge = extent <= 0 || scrollable.scrollTop >= extent - 2;
    const atOlderEdge = scrollable.scrollTop <= 2;
    if (
      mounted.length > 0 &&
      targetIdx >= 0 &&
      ((targetIdx < Math.min(...mounted) - 3 && !atOlderEdge) ||
        (targetIdx > Math.max(...mounted) + 3 && !atNewerEdge))
    ) {
      return false;
    }
    return highlightAndScroll(findRowMessageNode(root, rows, targetIdx, row, mounted), hlOpts);
  }

  const index = targetIdx;
  let start = index;
  while (start > 0 && rows[start - 1].kind === "tool") start--;
  let end = index + 1;
  while (end < rows.length && rows[end].kind === "tool") end++;
  const isTailGroup = rows.length > 1 && end >= rows.length;
  const groupHlOpts = { tail: isTail || isTailGroup, releaseFollow: rows.length > 1 && !(isTail || isTailGroup), root, doc };
  const members = index < 0 ? [row] : rows.slice(start, end);
  let group = direct?.closest(GROUP) ?? direct?.querySelector(GROUP);
  if (!group && direct?.querySelector(BADGE)) return highlightAndScroll(direct.querySelector(BADGE), groupHlOpts);
  if (!group) {
    for (const member of members) {
      const host = findIdentity(root, member);
      group = host?.closest(GROUP) ?? host?.querySelector(GROUP);
      if (group) break;
    }
  }
  if (!group && start > 0) {
    const previous = rows[start - 1];
    const anchor = findIdentity(root, previous) ?? findRowMessageNode(root, rows, start - 1, previous);
    const nextMsg = end < rows.length ? rows[end] : undefined;
    const nextAnchor = nextMsg && anchor ? anchorOf(root, nextMsg, anchor) : null;
    if (anchor) {
      group = (Array.from(root.querySelectorAll(GROUP)) as any[]).find(
        (candidate) => after(candidate, anchor) && before(candidate, nextAnchor),
      );
    }
  }
  const pickMemberBadge = (badges: any[]) => {
    const toolNeedles = textNeedles([toolHint(row), row.summary_line, ...messageHints(row)]);
    if (toolNeedles.length > 0) {
      const matchingBadges = badges.filter((node) => {
        const raw = node.textContent ?? "";
        return toolNeedles.some((needle) => matchesNeedle(raw, needle));
      });
      if (matchingBadges.length === 1) return matchingBadges[0];
      if (matchingBadges.length > 1) {
        const memberIndex = members.indexOf(row);
        if (memberIndex >= 0) {
          const matchingMembers = members.filter((m) => {
            const mNeedles = textNeedles([toolHint(m), m.summary_line]);
            return toolNeedles.some((n) => mNeedles.includes(n));
          });
          const ord = matchingMembers.indexOf(row);
          if (ord >= 0 && matchingBadges.length === matchingMembers.length) {
            return matchingBadges[ord];
          }
          if (badges.length === members.length && memberIndex < badges.length) {
            return matchingBadges.includes(badges[memberIndex]) ? badges[memberIndex] : matchingBadges[0];
          }
          if (ord >= 0) {
            return matchingBadges[Math.min(ord, matchingBadges.length - 1)];
          }
        }
        return preferLast ? matchingBadges[matchingBadges.length - 1] : matchingBadges[0];
      }
    }
    if (badges.length === members.length) return badges[members.indexOf(row)] ?? null;
    return null;
  };
  if (!group && !direct && !options.turnExpanded) {
    const turn = findTurn(root, rows, start, end);
    if (turn) {
      const { summary } = turn;
      if (turnCollapsed(root, turn)) {
        const button = summary.querySelector?.('button, [role="button"]') ?? summary;
        try { button.click(); } catch { return highlightAndScroll(summary, groupHlOpts); }
        const wait = options.afterExpand ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
        for (let attempt = 0; attempt < 4; attempt++) {
          await wait();
          if (version !== navigationVersion) return false;
          if (!turnCollapsed(root, turn)) break;
        }
      }
      const nested = turnNodes(root, turn, GROUP);
      if (nested.length > 0) {
        return navigateLoaded(row, rows, root, version, { ...options, turnExpanded: true });
      }
      const badges = turnNodes(root, turn, BADGE);
      const matched = pickMemberBadge(badges);
      if (matched) return highlightAndScroll(matched, groupHlOpts);
      return highlightAndScroll(summary, groupHlOpts);
    }
  }
  if (!group) return highlightAndScroll(direct ?? findRowMessageNode(root, rows, targetIdx, row), groupHlOpts);

  const toggle = group.querySelector('[role="button"][aria-expanded]');
  const collapsed = toggle?.getAttribute("aria-expanded") === "false";
  const viewportWidth = doc?.defaultView?.innerWidth;
  if (collapsed && typeof viewportWidth === "number" && viewportWidth < 600) {
    return highlightAndScroll(group, groupHlOpts);
  }
  if (collapsed) {
    try { toggle.click(); } catch { return highlightAndScroll(group, groupHlOpts); }
  }
  const afterExpand = options.afterExpand ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  for (let attempt = 0; attempt < (collapsed ? 4 : 1); attempt++) {
    if (collapsed) await afterExpand();
    if (version !== navigationVersion) return false;
    const target = findIdentity(root, row);
    const targetBadge = target?.matches?.(BADGE) ? target : target?.querySelector(BADGE);
    if (targetBadge && !target.querySelector(GROUP)) return highlightAndScroll(targetBadge, groupHlOpts);
    // Paseo 0.15.3 only puts row IDs on the group's host, not its child badges.
    const badges = Array.from(group.querySelectorAll(BADGE)) as any[];
    const matched = pickMemberBadge(badges);
    if (matched) return highlightAndScroll(matched, groupHlOpts);
  }
  return highlightAndScroll(group, groupHlOpts);
}
