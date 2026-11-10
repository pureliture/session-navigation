import type { Row } from "../shared/sessionNav";
import type { TimelineHistory } from "./timelineHistory";
import { fallbackToolPreview } from "./toolPreview";
import { focusedSessionTab } from "./subagents";

const GROUP = '[data-testid="tool-call-group"]';
const BADGE = '[data-testid="tool-call-badge"]';
const ROW = "[data-message-id], [data-history-row-id]";
const TURN_SUMMARY = '[data-testid="turn-summary"]';
const FOLLOWING = 4;

function normalized(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

const IDENTITY_ATTRIBUTES = ["data-message-id", "data-history-row-id", "data-call-id", "data-item-id", "data-turn-id", "id"];

export function identityMatches(value: string, id: string): boolean {
  return value === id || value === `agent_tool_${id}` || value.endsWith(`/${encodeURIComponent(id)}`) ||
    value === `message-${id}` || value === `call-${id}` || value === `turn-${id}`;
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

function findText(root: any, snippet?: string, selector = ROW): any {
  const needle = normalized(snippet ?? "").slice(0, 36);
  if (needle.length < 4) return null;
  return (Array.from(root.querySelectorAll(selector)) as any[]).find((node) =>
    normalized(node.textContent ?? "").includes(needle)) ?? null;
}

function toolHint(row: Pick<Row, "tool_input">): string | undefined {
  try {
    const input = JSON.parse(row.tool_input ?? "null");
    return input?.command ?? input?.path ?? input?.CommandLine ?? input?.Path ?? row.tool_input;
  } catch {
    return row.tool_input;
  }
}

export function historyContainsRow(history: TimelineHistory, row: Row): boolean {
  const kind = row.kind ?? "tool";
  return history.entries.some(({ item }) => {
    if (!item) return false;
    const type = item.type;
    if (kind === "user" ? type !== "user_message" : kind === "assistant" ? type !== "assistant_message" :
      !["tool_call", "command", "terminal", "bash", "shell"].includes(String(type))) return false;
    const detail = typeof item.detail === "object" && item.detail !== null
      ? item.detail as Record<string, unknown> : {};
    const ids = [item.messageId, item.clientMessageId, item.id, item.callId, detail.call_id];
    if (ids.some((value) => typeof value === "string" &&
      [row.item_id, row.tool_call_id].some((id) => id && identityMatches(value, id)))) return true;
    const preview = fallbackToolPreview(item, detail);
    const texts = kind === "tool" ? [preview.tool_input, toolHint(preview), preview.tool_output, detail.text, detail.label] : [item.text];
    const hints = kind === "tool" ? [row.summary_line, row.tool_output, toolHint(row)] : [row.summary_line];
    return hints.some((hint) => {
      if (typeof hint !== "string") return false;
      const needle = normalized(hint).slice(0, 36);
      return needle.length >= 4 && texts.some((text) => typeof text === "string" && normalized(text).includes(needle));
    });
  });
}

function highlightAndScroll(node: any): boolean {
  if (!node) return false;
  node.scrollIntoView?.({ behavior: "smooth", block: "center" });
  if (node.style) {
    const original = node.style.backgroundColor;
    node.style.transition = "background-color 0.3s ease";
    node.style.backgroundColor = "rgba(59, 130, 246, 0.22)";
    setTimeout(() => { node.style.backgroundColor = original || ""; }, 1200);
  }
  return true;
}

type Turn = { summary: any; boundary: any };

const before = (node: any, other: any) => !other || (node.compareDocumentPosition(other) & FOLLOWING) !== 0;
const after = (node: any, other: any) => (other.compareDocumentPosition(node) & FOLLOWING) !== 0;

function anchorOf(root: any, row: Row, from?: any): any {
  const direct = findIdentity(root, row);
  if (direct && (!from || after(direct, from))) return direct;
  const needle = normalized(row.summary_line ?? "").slice(0, 36);
  if (needle.length < 4) return null;
  return (Array.from(root.querySelectorAll(ROW)) as any[]).find((node) =>
    (!from || after(node, from)) && normalized(node.textContent ?? "").includes(needle)) ?? null;
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
  if (typeof node.getClientRects !== "function") return true;
  return node.getClientRects().length > 0;
}

// Paseo keeps other agents' chats mounted (hidden); bind to the one showing this session.
// Exact identities outrank visibility, which outranks loose snippet matches.
function pickChatRoot(doc: any, rows: Row[], target: Row): any {
  const roots = (Array.from(doc?.querySelectorAll?.('[data-testid="agent-chat-scroll"]') ?? []) as any[]);
  if (roots.length <= 1) return roots[0] ?? null;
  const messages = rows.filter((candidate) => candidate.kind !== "tool");
  const ranked = roots.map((root) => [
    root,
    findIdentity(root, target) ? 1 : 0,
    messages.filter((candidate) => findIdentity(root, candidate)).length,
    visible(root) ? 1 : 0,
    messages.filter((candidate) => findText(root, candidate.summary_line)).length,
  ] as const).sort((x, y) => (y[1] - x[1]) || (y[2] - x[2]) || (y[3] - x[3]) || (y[4] - x[4]));
  return ranked[0][0];
}

let navigationVersion = 0;

type NavigationOptions = {
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

function emitScroll(scrollable: any, doc: any, type: "scroll" | "wheel"): void {
  const Constructor = doc.defaultView?.[type === "wheel" ? "WheelEvent" : "Event"];
  if (Constructor) scrollable.dispatchEvent?.(new Constructor(type, { bubbles: true, deltaY: -1 }));
}

type SearchBounds = { low?: number; high?: number; extent?: number };

function seekMountedWindow(root: any, doc: any, rows: Row[], target: Row, bounds: SearchBounds): boolean {
  const targetIndex = rows.findIndex((candidate) => candidate === target ||
    (!!target.item_id && candidate.item_id === target.item_id) ||
    (!!target.tool_call_id && candidate.tool_call_id === target.tool_call_id));
  if (targetIndex < 0) return false;
  const virtual = Array.from(root.querySelectorAll("[data-history-row-id][data-index]")) as any[];
  let nodes = virtual.length ? virtual : Array.from(root.querySelectorAll(ROW)) as any[];
  const viewport = root.getBoundingClientRect?.();
  if (viewport) {
    const nearby = nodes.filter((node) => {
      const rect = node.getBoundingClientRect?.();
      return rect && rect.bottom >= viewport.top && rect.top <= viewport.bottom;
    });
    if (nearby.length) nodes = nearby;
  }
  const mounted = nodes.flatMap((node) => {
    const values = IDENTITY_ATTRIBUTES.map((attr) => node.getAttribute(attr)).filter(Boolean) as string[];
    let index = rows.findIndex((candidate) => values.some((value) =>
      [candidate.item_id, candidate.tool_call_id].some((id) => id && identityMatches(value, id))));
    if (index < 0) {
      const text = normalized(node.textContent ?? "");
      let longest = 0;
      rows.forEach((candidate, candidateIndex) => {
        const needle = normalized(candidate.summary_line ?? "").slice(0, 36);
        if (needle.length >= 4 && needle.length > longest && text.includes(needle)) {
          index = candidateIndex;
          longest = needle.length;
        }
      });
    }
    return index < 0 ? [] : [index];
  });
  if (!mounted.length) return false;
  const first = Math.min(...mounted), last = Math.max(...mounted);
  const older = targetIndex < (first + last) / 2;
  const scrollable = chatScroller(root);
  const extent = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
  if (!(extent > 0)) return false;
  const style = doc.defaultView?.getComputedStyle?.(scrollable);
  const negative = style?.flexDirection === "column-reverse" || scrollable.scrollTop < 0;
  const inverted = !negative && (style?.transform === "scaleY(-1)" ||
    /^matrix\([^,]+,[^,]+,[^,]+,\s*-1,/.test(style?.transform ?? ""));
  const position = negative ? scrollable.scrollTop + extent :
    inverted ? extent - scrollable.scrollTop : scrollable.scrollTop;
  if (bounds.extent !== extent) { bounds.low = undefined; bounds.high = undefined; bounds.extent = extent; }
  if (older && position <= 1) {
    // A virtual index above zero means the old edge hasn't mounted yet, not that another page is needed.
    return virtual.length > 0 && !virtual.some((node) => node.getAttribute("data-index") === "0");
  }
  if (!older && position >= extent - 1) return true;
  if (older) bounds.high = position;
  else bounds.low = position;
  const gap = older ? first - targetIndex : targetIndex - last;
  const step = scrollable.clientHeight * Math.max(0.8, Math.min(8, gap / Math.max(1, last - first + 1)));
  const next = bounds.low !== undefined && bounds.high !== undefined
    ? (bounds.low + bounds.high) / 2
    : Math.max(0, Math.min(extent, position + (older ? -step : step)));
  const top = negative ? next - extent : inverted ? extent - next : next;
  // Reading intent prevents Paseo's follow-output anchor from snapping back to the live head.
  emitScroll(scrollable, doc, "wheel");
  if (typeof scrollable.scrollTo === "function") scrollable.scrollTo({ top, behavior: "instant" });
  else scrollable.scrollTop = top;
  emitScroll(scrollable, doc, "scroll");
  return true;
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
  const root = pickChatRoot(doc, rows.length > 0 ? rows : [row], row);
  if (!root) return false;
  if (findIdentity(root, row) || findText(root, row.summary_line)) {
    if (await navigateLoaded(row, rows, root, version, options)) return true;
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
      if (seekMountedWindow(root, doc, rows, row, bounds)) {
        lastAttempt = now();
      } else if (now() - lastAttempt >= 250) {
        loadOlder(root, doc);
        lastAttempt = now();
      }
    }
    await wait();
  }
  return false;
}

async function navigateLoaded(row: Row, rows: Row[], root: any, version: number, options: NavigationOptions): Promise<boolean> {
  const direct = findIdentity(root, row);
  if (row.kind !== "tool") return highlightAndScroll(direct ?? findText(root, row.summary_line));

  const index = rows.findIndex((candidate) => candidate === row ||
    (!!row.tool_call_id && candidate.tool_call_id === row.tool_call_id));
  let start = index;
  while (start > 0 && rows[start - 1].kind === "tool") start--;
  let end = index + 1;
  while (end < rows.length && rows[end].kind === "tool") end++;
  const members = index < 0 ? [row] : rows.slice(start, end);
  let group = direct?.closest(GROUP) ?? direct?.querySelector(GROUP);
  if (!group && direct?.querySelector(BADGE)) return highlightAndScroll(direct.querySelector(BADGE));
  if (!group) {
    for (const member of members) {
      const host = findIdentity(root, member);
      group = host?.closest(GROUP) ?? host?.querySelector(GROUP);
      if (group) break;
    }
  }
  if (!group && start > 0) {
    const previous = rows[start - 1];
    const anchor = findIdentity(root, previous) ?? findText(root, previous.summary_line);
    if (anchor) group = (Array.from(root.querySelectorAll(GROUP)) as any[]).find((candidate) =>
      (anchor.compareDocumentPosition(candidate) & FOLLOWING) !== 0);
  }
  if (!group && !direct && !options.turnExpanded) {
    const turn = findTurn(root, rows, start, end);
    if (turn) {
      const { summary } = turn;
      if (turnCollapsed(root, turn)) {
        const button = summary.querySelector?.('button, [role="button"]') ?? summary;
        try { button.click(); } catch { return highlightAndScroll(summary); }
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
      const needle = (text?: string) => normalized(text ?? "").slice(0, 36);
      const hint = [toolHint(row), row.summary_line].map(needle).find((text) => text.length >= 4);
      const match = hint ? badges.find((node) => normalized(node.textContent ?? "").includes(hint)) : undefined;
      if (match) return highlightAndScroll(match);
      if (badges.length === members.length) return highlightAndScroll(badges[members.indexOf(row)]);
      return highlightAndScroll(summary);
    }
  }
  if (!group) return highlightAndScroll(direct ?? findText(root, row.summary_line));

  const toggle = group.querySelector('[role="button"][aria-expanded]');
  const collapsed = toggle?.getAttribute("aria-expanded") === "false";
  if (collapsed) {
    try { toggle.click(); } catch { return highlightAndScroll(group); }
  }
  const afterExpand = options.afterExpand ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  for (let attempt = 0; attempt < (collapsed ? 4 : 1); attempt++) {
    if (collapsed) await afterExpand();
    if (version !== navigationVersion) return false;
    const target = findIdentity(root, row);
    const targetBadge = target?.matches?.(BADGE) ? target : target?.querySelector(BADGE);
    if (targetBadge && !target.querySelector(GROUP)) return highlightAndScroll(targetBadge);
    // Paseo 0.15.3 only puts row IDs on the group's host, not its child badges.
    const badges = Array.from(group.querySelectorAll(BADGE)) as any[];
    const hint = findText(group, toolHint(row), BADGE) ?? findText(group, row.summary_line, BADGE);
    if (hint) return highlightAndScroll(hint);
    if (badges.length === members.length) return highlightAndScroll(badges[members.indexOf(row)]);
  }
  return highlightAndScroll(group);
}
