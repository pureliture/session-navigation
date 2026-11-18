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

const IDENTITY_ATTRIBUTES = [
  "data-message-id",
  "data-history-row-id",
  "data-tool-call-id",
  "data-call-id",
  "data-item-id",
  "data-turn-id",
  "id",
];

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function paseoSystemMessageId(row: Row): string | null {
  if (!row.message_text) return null;
  const decoded = decodeXmlEntities(stripSystemBlocks(row.message_text));
  if (!decoded.includes("<paseo-system")) return null;
  const tagMatch = /<paseo-system\b([^>]*)>/u.exec(decoded);
  const tagScope = tagMatch ? tagMatch[1] : decoded.slice(decoded.indexOf("<paseo-system"));
  return /\bmessage-id=["']([^"']+)["']/u.exec(tagScope)?.[1] ?? null;
}

function isPaseoSystemRow(row: Row): boolean {
  if (row.message_text) {
    const decoded = decodeXmlEntities(stripSystemBlocks(row.message_text));
    if (decoded.includes("<paseo-system")) return true;
  }
  return Boolean(
    row.summary_line?.startsWith("[Subagent ") ||
    row.summary_line?.startsWith("[Agent message"),
  );
}

function isToolLikeRow(row: Row): boolean {
  return row.kind === "tool" || Boolean(paseoSystemMessageId(row));
}

function rowIdentityIds(row: Row): string[] {
  const sysMsgId = paseoSystemMessageId(row);
  return [
    row.tool_call_id,
    row.item_id,
    row.item_id?.startsWith("user-") ? row.item_id.slice(5) : undefined,
    row.item_id?.startsWith("ast-") ? row.item_id.slice(4) : undefined,
    sysMsgId ? `paseo-agent-message:${sysMsgId}` : undefined,
    sysMsgId ?? undefined,
  ].filter((v): v is string => Boolean(v));
}

export function identityMatches(value: string, id: string): boolean {
  if (!value || !id) return false;
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  // Rendered chats nest the raw id: `agent_tool_turn:<turn>/<callId>`,
  // `beautiful-chat/<mid>/<seq>`, `paseo-agent-message:<uuid>`.
  const segments = decoded.split("/").flatMap((part) => part.split(":"));
  if (segments.includes(id)) return true;
  if (value === id || value === `agent_tool_${id}` || value === `paseo-agent-message:${id}` ||
    value.endsWith(`/${encodeURIComponent(id)}`) ||
    value === `message-${id}` || value === `call-${id}` || value === `turn-${id}` ||
    value === `tool-${id}` || value === `tool_call_${id}`) return true;
  return id.length >= 6 && (value.endsWith(`_${id}`) || value.endsWith(`:${id}`) || decoded.endsWith(`:${id}`) || decoded.endsWith(`/${id}`));
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
  const decoded = decodeXmlEntities(raw);
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
  const ids = rowIdentityIds(row);
  if (ids.length === 0) return null;
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

function rowOrder(rows: Row[], idx: number): number {
  const candidate = rows[idx];
  return typeof candidate?.timeline_index === "number" ? candidate.timeline_index : idx;
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
  const isSystemNotice = isPaseoSystemRow(row);
  const rowIds = rowIdentityIds(row);
  return history.entries.some(({ item }) => {
    if (!item) return false;
    const type = String(item.type ?? "");
    if (kind === "user") {
      if (type !== "user_message" && !(isSystemNotice && ["plugin", "notification", "tool_call", "command"].includes(type))) {
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
      rowIds.some((id) => identityMatches(value, id)))) return true;
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

const DEFAULT_ACCENT_RGB = { r: 94, g: 138, b: 117 };
const HIGHLIGHT_ENTER_TRANSITION =
  "background-color 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1)";
const HIGHLIGHT_EXIT_TRANSITION =
  "background-color 420ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 420ms cubic-bezier(0.4, 0, 0.2, 1)";

type HighlightTimer = Parameters<typeof clearTimeout>[0];
type HighlightState = {
  bg: string;
  boxShadow: string;
  borderRadius: string;
  transition: string;
  fadeTimer: HighlightTimer;
  cleanupTimer?: HighlightTimer;
};
const highlightStates = new WeakMap<any, HighlightState>();
let activeHighlightedNode: any = null;

export function parseRgb(color?: string): { r: number; g: number; b: number } | null {
  if (typeof color !== "string") return null;
  const trimmed = color.trim();
  if (!trimmed) return null;
  const hexMatch = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/iu.exec(
      trimmed,
    );
  if (rgbMatch) {
    const clamp = (v: string) => Math.max(0, Math.min(255, Number.parseInt(v, 10)));
    return {
      r: clamp(rgbMatch[1]),
      g: clamp(rgbMatch[2]),
      b: clamp(rgbMatch[3]),
    };
  }
  return null;
}

function parseAccentRgb(color?: string): { r: number; g: number; b: number } {
  return parseRgb(color) ?? DEFAULT_ACCENT_RGB;
}

function isInlineBadgeNode(node: any): boolean {
  return Boolean(node?.matches?.(`${BADGE}, ${GROUP}, [data-tool-call-id]`));
}

function clearHighlightNode(node: any): void {
  const state = node ? highlightStates.get(node) : undefined;
  if (!state) return;
  clearTimeout(state.fadeTimer);
  if (state.cleanupTimer !== undefined) clearTimeout(state.cleanupTimer);
  highlightStates.delete(node);
  if (activeHighlightedNode === node) activeHighlightedNode = null;
  if (node.style) {
    node.style.backgroundColor = state.bg;
    node.style.boxShadow = state.boxShadow;
    node.style.borderRadius = state.borderRadius;
    node.style.transition = state.transition;
  }
}

export function clearChatHighlight(): void {
  if (activeHighlightedNode) clearHighlightNode(activeHighlightedNode);
}

function highlightAndScroll(
  node: any,
  opts?: {
    tail?: boolean;
    releaseFollow?: boolean;
    root?: any;
    doc?: any;
    accentColor?: string;
    isDark?: boolean;
  },
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
    if (existing) {
      clearTimeout(existing.fadeTimer);
      if (existing.cleanupTimer !== undefined) clearTimeout(existing.cleanupTimer);
    }
    const bg = existing ? existing.bg : (node.style.backgroundColor ?? "");
    const boxShadow = existing ? existing.boxShadow : (node.style.boxShadow ?? "");
    const borderRadius = existing ? existing.borderRadius : (node.style.borderRadius ?? "");
    const transition = existing ? existing.transition : (node.style.transition ?? "");

    const { r, g, b } = parseAccentRgb(opts?.accentColor);
    const isDark = Boolean(opts?.isDark);
    const isBadge = isInlineBadgeNode(node);

    let computedRadius = "";
    try {
      computedRadius = opts?.doc?.defaultView?.getComputedStyle?.(node)?.borderRadius ?? "";
    } catch {
      // Ignore mock DOMs without getComputedStyle.
    }
    const effectiveRadius = (borderRadius || computedRadius || "").trim();
    const hasRadius =
      effectiveRadius !== "" &&
      effectiveRadius !== "0" &&
      effectiveRadius !== "0px" &&
      !/^(?:0(?:px)?\s+)*0(?:px)?$/u.test(effectiveRadius);
    node.style.borderRadius = hasRadius ? borderRadius : (isBadge ? "8px" : "10px");

    node.style.transition = HIGHLIGHT_ENTER_TRANSITION;
    node.style.backgroundColor = isBadge
      ? `rgba(${r}, ${g}, ${b}, ${isDark ? "0.16" : "0.10"})`
      : `rgba(${r}, ${g}, ${b}, ${isDark ? "0.13" : "0.075"})`;
    node.style.boxShadow = isBadge
      ? `inset 0 0 0 1.5px rgba(${r}, ${g}, ${b}, 0.65), 0 0 0 3px rgba(${r}, ${g}, ${b}, 0.12)`
      : `inset 3px 0 0 0 rgba(${r}, ${g}, ${b}, 0.85), inset 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.20)`;

    activeHighlightedNode = node;
    const state: HighlightState = {
      bg,
      boxShadow,
      borderRadius,
      transition,
      fadeTimer: undefined as unknown as HighlightTimer,
    };
    state.fadeTimer = setTimeout(() => {
      if (highlightStates.get(node) !== state) return;
      if (node.style) {
        node.style.transition = HIGHLIGHT_EXIT_TRANSITION;
        node.style.backgroundColor = state.bg || `rgba(${r}, ${g}, ${b}, 0)`;
        node.style.boxShadow =
          state.boxShadow ||
          (isBadge
            ? `inset 0 0 0 1.5px rgba(${r}, ${g}, ${b}, 0), 0 0 0 3px rgba(${r}, ${g}, ${b}, 0)`
            : `inset 3px 0 0 0 rgba(${r}, ${g}, ${b}, 0), inset 0 0 0 1px rgba(${r}, ${g}, ${b}, 0)`);
      }
    }, 850);
    state.cleanupTimer = setTimeout(() => {
      if (highlightStates.get(node) !== state) return;
      clearHighlightNode(node);
    }, 1300);
    highlightStates.set(node, state);
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
  if (paseoSystemMessageId(candidate)) return null;
  const matches = findTextMatches(root, messageHints(candidate), ROW);
  return matches.length === 1 ? matches[0] : null;
}

function findRowMessageNode(
  root: any,
  rows: Row[],
  targetIdx: number,
  row: Row,
  mountedIndices?: number[],
  edges?: { atOlderEdge: boolean; atNewerEdge: boolean },
): any {
  const needles = rowNeedles(row);
  if (needles.length === 0) return null;
  const domRows = Array.from(root.querySelectorAll(ROW)) as any[];
  const allMatches = domRows.filter((node) => {
    const raw = node.textContent ?? "";
    return needles.some((needle) => matchesNeedle(raw, needle));
  });
  if (allMatches.length === 0) return null;
  if (mountedIndices && mountedIndices.length > 0 && targetIdx >= 0) {
    const targetOrder = rowOrder(rows, targetIdx);
    const mountedOrders = mountedIndices.map((idx) => rowOrder(rows, idx));
    const minOrder = Math.min(...mountedOrders);
    const maxOrder = Math.max(...mountedOrders);
    if (
      (targetOrder < minOrder - 3 && !edges?.atOlderEdge) ||
      (targetOrder > maxOrder + 3 && !edges?.atNewerEdge)
    ) {
      return null;
    }
  }
  if (targetIdx < 0 || rows.length === 0) {
    return allMatches[0];
  }

  let lowerIdx = -1;
  let lowerNode: any = null;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (isToolLikeRow(rows[i])) continue;
    const directAnchor = findIdentity(root, rows[i]);
    const rawAnchor = directAnchor ?? findUniqueRowAnchor(root, rows[i]);
    const anchor = rawAnchor && !domRows.includes(rawAnchor) ? (rawAnchor.closest?.(ROW) ?? rawAnchor) : rawAnchor;
    if (
      anchor &&
      (allMatches.length > 1 || (domRows.includes(anchor) && (Boolean(directAnchor) || !allMatches.includes(anchor))))
    ) {
      lowerIdx = i;
      lowerNode = anchor;
      break;
    }
  }

  let upperIdx = rows.length;
  let upperNode: any = null;
  for (let j = targetIdx + 1; j < rows.length; j++) {
    if (isToolLikeRow(rows[j])) continue;
    const directAnchor = findIdentity(root, rows[j]);
    const rawAnchor = directAnchor ?? findUniqueRowAnchor(root, rows[j]);
    const anchor = rawAnchor && !domRows.includes(rawAnchor) ? (rawAnchor.closest?.(ROW) ?? rawAnchor) : rawAnchor;
    if (
      anchor &&
      (allMatches.length > 1 || (domRows.includes(anchor) && (Boolean(directAnchor) || !allMatches.includes(anchor)))) &&
      (!lowerNode || rowComparisonOrder(domRows, anchor, lowerNode, "after"))
    ) {
      upperIdx = j;
      upperNode = anchor;
      break;
    }
  }

  // Rendered chats nest ROW elements (parent + child share textContent). Dedupe
  // nested matches first so a single logical row is treated as unique.
  const deduped = allMatches.filter((node) =>
    !allMatches.some((other) => other !== node && typeof other.contains === "function" && other.contains(node)),
  );
  const boundedMatches = deduped.filter(
    (node) =>
      (!lowerNode || rowComparisonOrder(domRows, node, lowerNode, "after")) &&
      (!upperNode || rowComparisonOrder(domRows, node, upperNode, "before")),
  );
  // Anchors are heuristic (text-boundary guesses). A unique text match is stronger
  // evidence than possibly-misplaced anchors: never discard the only candidate.
  if (deduped.length === 1) return deduped[0];
  if (boundedMatches.length === 0) return null;
  if (boundedMatches.length === 1) return boundedMatches[0];

  const candidates = boundedMatches.length > 0 ? boundedMatches : deduped;
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
      ? candidates[candidates.length - 1]
      : candidates[0];
  }
  const ordFromEnd = peerIndices.length - 1 - ordFromStart;
  if (candidates.length === peerIndices.length) {
    return candidates[ordFromStart];
  }
  if (lowerNode && !upperNode) {
    return candidates[Math.min(ordFromStart, candidates.length - 1)];
  }
  if (upperNode && !lowerNode) {
    return candidates[Math.max(0, candidates.length - 1 - ordFromEnd)];
  }
  if (!lowerNode && !upperNode && mountedIndices && mountedIndices.length > 0) {
    const minMounted = Math.min(...mountedIndices);
    const maxMounted = Math.max(...mountedIndices);
    if (minMounted > 0 && maxMounted >= rows.length - 3) {
      return candidates[Math.max(0, candidates.length - 1 - ordFromEnd)];
    }
    if (maxMounted < rows.length - 1 && minMounted <= 2) {
      return candidates[Math.min(ordFromStart, candidates.length - 1)];
    }
  }
  return targetIdx < rows.length / 2
    ? candidates[Math.min(ordFromStart, candidates.length - 1)]
    : candidates[Math.max(0, candidates.length - 1 - ordFromEnd)];
}

// Paseo folds finished turns behind a "turn-summary" badge rendered after the user message.
// The turn ends at the next summary or the next user message, whichever comes first.
function findTurn(root: any, rows: Row[], start: number, end: number): Turn | null {
  const summaries = Array.from(root.querySelectorAll(TURN_SUMMARY)) as any[];
  if (summaries.length === 0) return null;
  let anchor: any = null;
  for (let i = start - 1; i >= 0 && !anchor; i--) {
    if (rows[i].kind !== "user") continue;
    if (isPaseoSystemRow(rows[i])) {
      const badge = findIdentity(root, rows[i]);
      if (badge) {
        anchor = badge;
        break;
      }
      continue;
    }
    anchor = anchorOf(root, rows[i]);
    if (!anchor) return null;
  }
  if (!anchor) return null;
  let userBoundary: any = null;
  for (let j = end; j < rows.length; j++) {
    if (rows[j].kind !== "user") continue;
    if (isPaseoSystemRow(rows[j])) {
      const badge = findIdentity(root, rows[j]);
      if (badge && after(badge, anchor)) {
        userBoundary = badge;
        break;
      }
      continue;
    }
    userBoundary = anchorOf(root, rows[j], anchor);
    break;
  }
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
  noProgressTimeoutMs?: number;
  timeoutMs?: number;
  turnExpanded?: boolean;
  accentColor?: string;
  isDark?: boolean;
};

function chatScroller(root: any): any {
  return [root, ...Array.from(root.querySelectorAll("*"))].find((node: any) =>
    node.scrollHeight > node.clientHeight) ?? root;
}

function emitScroll(scrollable: any, doc: any, type: "scroll" | "wheel", deltaY = -1): void {
  const Constructor = doc?.defaultView?.[type === "wheel" ? "WheelEvent" : "Event"];
  if (Constructor) scrollable.dispatchEvent?.(new Constructor(type, { bubbles: true, deltaY }));
}

type SearchBounds = {
  low?: number;
  high?: number;
  extent?: number;
  sweepDirection?: "up" | "down";
  triedUpEdge?: boolean;
  triedDownEdge?: boolean;
};
type SeekOutcome = "moved" | "needOlder" | "atNewerEdge" | "unknown";

function mountedRowIndices(root: any, rows: Row[]): { indices: number[]; virtual: any[] } {
  const virtual = Array.from(root.querySelectorAll("[data-history-row-id][data-index]")) as any[];
  const nodes = virtual.length ? virtual : (Array.from(root.querySelectorAll(ROW)) as any[]);
  const collected = new Set<number>();

  const collectUniqueIdMatch = (value: string): boolean => {
    const idMatches: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rowIdentityIds(rows[i]).some((id) => identityMatches(value, id))) {
        idMatches.push(i);
        if (idMatches.length > 1) return false;
      }
    }
    if (idMatches.length === 1) {
      collected.add(idMatches[0]);
      return true;
    }
    return false;
  };

  for (const node of nodes) {
    const ownValues = IDENTITY_ATTRIBUTES.map((attr) => node.getAttribute(attr)).filter(Boolean) as string[];
    let matchedById = false;
    for (const value of ownValues) {
      if (collectUniqueIdMatch(value)) matchedById = true;
    }
    if (!matchedById && typeof node.querySelectorAll === "function") {
      const descAttrs = ["data-tool-call-id", "data-call-id", "data-item-id"];
      for (const desc of Array.from(node.querySelectorAll(descAttrs.map((a) => `[${a}]`).join(", "))) as any[]) {
        for (const attr of descAttrs) {
          const val = desc.getAttribute?.(attr);
          if (val && collectUniqueIdMatch(val)) matchedById = true;
        }
      }
    }
    if (matchedById) continue;
    if (node.matches?.(`${BADGE}, ${GROUP}`) || node.querySelector?.(GROUP)) continue;
    // Never treat Paseo's 40-item virtualizer `data-index` as an index into Outline `rows`.
    const raw = node.textContent ?? "";
    let longest = 0;
    let matched: number[] = [];
    rows.forEach((candidate, candidateIndex) => {
      if (candidate.kind === "tool" || paseoSystemMessageId(candidate)) return;
      const needles = textNeedles(messageHints(candidate));
      const needle = needles.filter((value) => matchesNeedle(raw, value)).sort((x, y) => y.length - x.length)[0];
      // Short (<=8 char) needles like "수정 결과" false-match unrelated chats and
      // poison seek direction (older target misread as newer). Only long needles
      // may establish the mounted window; ID matches above are unaffected.
      if (needle && needle.length > 8) {
        if (needle.length > longest) {
          longest = needle.length;
          matched = [candidateIndex];
        } else if (needle.length === longest) {
          matched.push(candidateIndex);
        }
      }
    });
    if (matched.length === 1) {
      collected.add(matched[0]);
    }
  }

  if (virtual.length === 0 && typeof root.querySelectorAll === "function") {
    for (const toolNode of Array.from(root.querySelectorAll("[data-tool-call-id]")) as any[]) {
      const val = toolNode.getAttribute?.("data-tool-call-id");
      if (val) collectUniqueIdMatch(val);
    }
  }

  return { indices: [...collected], virtual };
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
  const targetOrder = rowOrder(rows, targetIndex);
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
  if (bounds.extent !== extent) {
    bounds.low = undefined;
    bounds.high = undefined;
    bounds.extent = extent;
  }

  const mountedOrders = mounted.map((idx) => rowOrder(rows, idx));
  let older: boolean;
  if (mountedOrders.length > 0) {
    const minMountedOrder = Math.min(...mountedOrders);
    const maxMountedOrder = Math.max(...mountedOrders);
    if (targetOrder < minMountedOrder) {
      older = true;
    } else if (targetOrder > maxMountedOrder) {
      older = false;
    } else {
      older = targetOrder < (minMountedOrder + maxMountedOrder) / 2;
    }
  } else if (position >= extent - 4) {
    // At the bottom with nothing recognizable mounted, the target is older.
    // Never mark the down edge "tried" here: sweeping down from the bottom is a
    // no-op ("atNewerEdge") and must not let a later top-edge visit flip the
    // sweep downward (that strands pre-compression seeks at Not loaded).
    older = true;
    bounds.sweepDirection = "up";
  } else if (position <= 4) {
    // At the top with nothing recognizable mounted: older history may still be
    // pageable (virtualizer + relay). Keep sweeping up so seekMountedWindow
    // returns needOlder; only flip down when the paginator proves the top edge
    // is exhausted (position stays 0 AND no spinner/progress follows).
    if (!bounds.sweepDirection) bounds.sweepDirection = "up";
    if (bounds.sweepDirection === "down" && bounds.triedUpEdge) {
      older = false;
    } else {
      older = true;
      bounds.sweepDirection = "up";
    }
  } else {
    if (!bounds.sweepDirection) bounds.sweepDirection = "up";
    older = bounds.sweepDirection !== "down";
  }

  if (older && position <= 1) {
    if (virtual.length > 0 && !virtual.some((node) => node.getAttribute("data-index") === "0")) {
      return "moved";
    }
    if (mountedOrders.length === 0) {
      if (!bounds.triedUpEdge) {
        bounds.triedUpEdge = true;
      }
      return "needOlder";
    }
    return "needOlder";
  }
  if (!older && position >= extent - 1) return "atNewerEdge";
  if (!mounted.length) {
    const step = Math.max(100, (scrollable.clientHeight || 400) * 2);
    const next = older
      ? Math.max(0, position - step)
      : targetIndex >= rows.length - 2
        ? extent
        : Math.min(extent, position + step);
    const top = negative ? next - extent : inverted ? extent - next : next;
    emitScroll(scrollable, doc, "wheel", older ? -1 : 1);
    if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top, behavior: "instant" });
    else scrollable.scrollTop = top;
    emitScroll(scrollable, doc, "scroll", older ? -1 : 1);
    return "moved";
  }
  const minMountedOrder = Math.min(...mountedOrders);
  const maxMountedOrder = Math.max(...mountedOrders);
  if (older) bounds.high = position;
  else bounds.low = position;
  if (bounds.low !== undefined && bounds.high !== undefined && bounds.low >= bounds.high) {
    bounds.low = undefined;
    bounds.high = undefined;
  }
  const gap = older
    ? Math.max(1, minMountedOrder - targetOrder)
    : Math.max(1, targetOrder - maxMountedOrder);
  const span = Math.max(1, maxMountedOrder - minMountedOrder + 1);
  const step =
    Math.max(1, scrollable.clientHeight || 400) * Math.max(0.8, Math.min(8, gap / span));
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
  const restoreRef: { fn?: () => void } = {};
  try {
    options.onStart?.();
    found = await withTimeout(navigate(row, rows, version, options, restoreRef), options.timeoutMs ?? 60000);
    return found;
  } catch {
    return false;
  } finally {
    if (!found && version === navigationVersion) {
      restoreRef.fn?.();
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

async function navigate(
  row: Row,
  rows: Row[],
  version: number,
  options: NavigationOptions,
  restoreRef?: { fn?: () => void },
): Promise<boolean> {
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
  const initialScroller = chatScroller(root);
  const initialScrollTop =
    typeof initialScroller?.scrollTop === "number" ? initialScroller.scrollTop : undefined;
  const restoreInitialScroll = () => {
    if (
      version === navigationVersion &&
      initialScrollTop !== undefined &&
      (rows.length > 0 || initialScrollTop >= 0)
    ) {
      const currentScroller = chatScroller(root);
      if (
        typeof currentScroller?.scrollTop === "number" &&
        currentScroller.scrollTop !== initialScrollTop
      ) {
        if (typeof currentScroller.scrollTo === "function") {
          currentScroller.scrollTo({ top: initialScrollTop, behavior: "instant" });
        } else {
          currentScroller.scrollTop = initialScrollTop;
        }
      }
    }
  };
  if (restoreRef) restoreRef.fn = restoreInitialScroll;

  const targetIdx = rowPositionIndex(rows, row);
  const targetOrder = targetIdx >= 0 ? rowOrder(rows, targetIdx) : -1;
  if (findIdentity(root, row)) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
  } else if (paseoSystemMessageId(row)) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
  } else {
    const { indices: mounted } = mountedRowIndices(root, rows);
    const extent = Math.max(0, (initialScroller?.scrollHeight ?? 0) - (initialScroller?.clientHeight ?? 0));
    const edges = {
      atOlderEdge: (initialScroller?.scrollTop ?? 0) <= 2,
      atNewerEdge: extent <= 0 || (initialScroller?.scrollTop ?? 0) >= extent - 2,
    };
    if (findRowMessageNode(root, rows, targetIdx, row, mounted, edges)) {
      const mountedOrders = mounted.map((idx) => rowOrder(rows, idx));
      const windowCoversTarget =
        mountedOrders.length === 0 ||
        targetIdx < 0 ||
        (targetOrder >= Math.min(...mountedOrders) - 3 &&
          targetOrder <= Math.max(...mountedOrders) + 3) ||
        (edges.atOlderEdge && targetOrder < Math.min(...mountedOrders)) ||
        (edges.atNewerEdge && targetOrder > Math.max(...mountedOrders));
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
  let lastRowCount = Array.from(root.querySelectorAll(ROW)).length;
  let lastScrollHeight = 0;
  try {
    lastScrollHeight = chatScroller(root)?.scrollHeight ?? 0;
  } catch {
    lastScrollHeight = 0;
  }
  const noProgressCutoff = history?.complete
    ? 4000
    : (options.getHistory === undefined && targetIdx >= 0) || options.noProgressTimeoutMs !== undefined
      ? (options.noProgressTimeoutMs ?? 2500)
      : null;
  // Older-history pagination is slow (relay + virtualizer settle take seconds per
  // page). Only extend the cutoff while pagination is visibly in flight: spinner
  // mounted, row count growing, or scroll extent growing. A bare repeated
  // "needOlder" with a frozen DOM is a stall, not progress.
  const paginationCutoff = noProgressCutoff === null ? null : Math.max(noProgressCutoff, 15000);
  let lastOutcome: SeekOutcome | null = null;
  let pagingInFlight = false;
  while (version === navigationVersion) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
    if (version !== navigationVersion) return false;
    if (now() >= deadline) break;
    const currentSignature = signature();
    if (currentSignature !== previousSignature) { previousSignature = currentSignature; lastProgress = now(); }
    const rowCount = Array.from(root.querySelectorAll(ROW)).length;
    if (rowCount !== lastRowCount) { lastRowCount = rowCount; lastProgress = now(); pagingInFlight = true; }
    let scrollHeight = lastScrollHeight;
    try {
      scrollHeight = chatScroller(root)?.scrollHeight ?? lastScrollHeight;
    } catch {
      scrollHeight = lastScrollHeight;
    }
    if (scrollHeight !== lastScrollHeight) { lastScrollHeight = scrollHeight; lastProgress = now(); pagingInFlight = true; }
    if (root.querySelector('[data-testid="load-older-history-spinner"]')) pagingInFlight = true;
    else if (lastOutcome !== "needOlder" && lastOutcome !== "moved") pagingInFlight = false;
    const cutoff = pagingInFlight ? paginationCutoff : noProgressCutoff;
    if (
      cutoff !== null &&
      now() - lastProgress >= cutoff &&
      !root.querySelector('[data-testid="load-older-history-spinner"]')
    ) break;
    lastOutcome = null;
    if (!root.querySelector('[data-testid="load-older-history-spinner"]') && now() - lastAttempt >= 100) {
      const outcome = seekMountedWindow(root, doc, rows, row, bounds);
      lastOutcome = outcome;
      if (outcome === "moved" || outcome === "atNewerEdge") {
        lastAttempt = now();
      } else if (outcome === "needOlder" && now() - lastAttempt >= 250) {
        loadOlder(root, doc);
        lastAttempt = now();
      }
    }
    await wait();
  }
  restoreInitialScroll();
  return false;
}

async function navigateLoaded(row: Row, rows: Row[], root: any, version: number, options: NavigationOptions): Promise<boolean> {
  const doc = options.document ?? (globalThis as unknown as { document?: any }).document;
  const targetIdx = rowPositionIndex(rows, row);
  const preferLast = targetIdx >= 0 && targetIdx >= rows.length / 2;
  const isTail = rows.length > 1 && targetIdx >= rows.length - 1;
  const hlOpts = {
    tail: isTail,
    releaseFollow: rows.length > 1 && !isTail,
    root,
    doc,
    accentColor: options.accentColor,
    isDark: options.isDark,
  };
  const direct = findIdentity(root, row);
  const sysMsgId = paseoSystemMessageId(row);
  const isToolTarget = row.kind === "tool" || Boolean(sysMsgId);
  if (!isToolTarget) {
    if (direct) return highlightAndScroll(direct, hlOpts);
    const { indices: mounted } = mountedRowIndices(root, rows);
    const scrollable = chatScroller(root);
    const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
    const edges = {
      atOlderEdge: (scrollable.scrollTop ?? 0) <= 2,
      atNewerEdge: extent <= 0 || (scrollable.scrollTop ?? 0) >= extent - 2,
    };
    const targetOrder = targetIdx >= 0 ? rowOrder(rows, targetIdx) : -1;
    const mountedOrders = mounted.map((idx) => rowOrder(rows, idx));
    if (
      mountedOrders.length > 0 &&
      targetIdx >= 0 &&
      ((targetOrder < Math.min(...mountedOrders) - 3 && !edges.atOlderEdge) ||
        (targetOrder > Math.max(...mountedOrders) + 3 && !edges.atNewerEdge))
    ) {
      return false;
    }
    const matchedNode = findRowMessageNode(root, rows, targetIdx, row, mounted, edges);
    if (matchedNode) return highlightAndScroll(matchedNode, hlOpts);
    if ((row.kind === "assistant" || row.kind === "agent") && targetIdx >= 0 && !options.turnExpanded) {
      const turn = findTurn(root, rows, targetIdx, targetIdx + 1);
      if (turn) {
        const { summary } = turn;
        if (turnCollapsed(root, turn)) {
          const button = summary.querySelector?.('button, [role="button"]') ?? summary;
          try { button.click(); } catch { return highlightAndScroll(summary, hlOpts); }
          const wait = options.afterExpand ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
          for (let attempt = 0; attempt < 4; attempt++) {
            await wait();
            if (version !== navigationVersion) return false;
            if (!turnCollapsed(root, turn)) break;
          }
          return navigateLoaded(row, rows, root, version, { ...options, turnExpanded: true });
        }
      }
    }
    return false;
  }

  const directGroup = direct?.closest?.(GROUP) ?? direct?.querySelector?.(GROUP);
  const directGroupCollapsed =
    directGroup?.querySelector?.('[role="button"][aria-expanded]')?.getAttribute("aria-expanded") === "false";
  if (sysMsgId && direct && !direct.querySelector?.(GROUP) && !directGroupCollapsed) {
    return highlightAndScroll(direct, hlOpts);
  }

  const index = targetIdx;
  let start = index;
  while (start > 0 && isToolLikeRow(rows[start - 1])) start--;
  let end = index + 1;
  while (end < rows.length && isToolLikeRow(rows[end])) end++;
  const isTailGroup = rows.length > 1 && end >= rows.length;
  const groupHlOpts = {
    tail: isTail || isTailGroup,
    releaseFollow: rows.length > 1 && !(isTail || isTailGroup),
    root,
    doc,
    accentColor: options.accentColor,
    isDark: options.isDark,
  };
  const members = index < 0 ? [row] : rows.slice(start, end);
  let group = directGroup;
  if (!group && direct?.querySelector(BADGE)) return highlightAndScroll(direct.querySelector(BADGE), groupHlOpts);
  if (!group) {
    for (const member of members) {
      const host = findIdentity(root, member);
      group = host?.closest(GROUP) ?? host?.querySelector(GROUP);
      if (group) break;
    }
  }
  if (!group && start > 0) {
    let anchor: any = null;
    for (let i = start - 1; i >= 0; i--) {
      if (isToolLikeRow(rows[i])) continue;
      anchor = findIdentity(root, rows[i]) ?? findRowMessageNode(root, rows, i, rows[i]);
      if (anchor || !isPaseoSystemRow(rows[i])) break;
    }
    let nextAnchor: any = null;
    if (anchor) {
      for (let j = end; j < rows.length; j++) {
        if (isToolLikeRow(rows[j])) continue;
        const candidateAnchor = anchorOf(root, rows[j], anchor);
        if (candidateAnchor) {
          nextAnchor = candidateAnchor;
          break;
        }
        if (!isPaseoSystemRow(rows[j])) break;
      }
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
      const expandedDirect = findIdentity(root, row);
      if (expandedDirect && !expandedDirect.querySelector?.(GROUP)) {
        return highlightAndScroll(expandedDirect, groupHlOpts);
      }
      const badges = turnNodes(root, turn, BADGE);
      const matched = pickMemberBadge(badges);
      if (matched) return highlightAndScroll(matched, groupHlOpts);
      return highlightAndScroll(summary, groupHlOpts);
    }
  }
  if (!group) {
    if (sysMsgId) return highlightAndScroll(direct, groupHlOpts);
    const { indices: mounted } = mountedRowIndices(root, rows);
    const scrollable = chatScroller(root);
    const extent = Math.max(0, (scrollable.scrollHeight ?? 0) - (scrollable.clientHeight ?? 0));
    const edges = {
      atOlderEdge: (scrollable.scrollTop ?? 0) <= 2,
      atNewerEdge: extent <= 0 || (scrollable.scrollTop ?? 0) >= extent - 2,
    };
    return highlightAndScroll(
      direct ?? findRowMessageNode(root, rows, targetIdx, row, mounted, edges),
      groupHlOpts,
    );
  }

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
    if (target && !target.querySelector?.(GROUP)) {
      const targetBadge = target.matches?.(BADGE) ? target : target.querySelector?.(BADGE);
      if (targetBadge) return highlightAndScroll(targetBadge, groupHlOpts);
      if (
        (target.getAttribute?.("data-tool-call-id") || target.getAttribute?.("data-call-id")) &&
        target.closest?.(GROUP) === group
      ) {
        return highlightAndScroll(target, groupHlOpts);
      }
    }
    // Paseo 0.15.3 only puts row IDs on the group's host, not its child badges.
    const badges = Array.from(group.querySelectorAll(BADGE)) as any[];
    const matched = pickMemberBadge(badges);
    if (matched) return highlightAndScroll(matched, groupHlOpts);
  }
  return highlightAndScroll(group, groupHlOpts);
}
