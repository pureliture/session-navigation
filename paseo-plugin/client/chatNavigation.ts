import type { Row } from "../shared/sessionNav";

const GROUP = '[data-testid="tool-call-group"]';
const BADGE = '[data-testid="tool-call-badge"]';
const ROW = "[data-message-id], [data-history-row-id]";
const TURN_SUMMARY = '[data-testid="turn-summary"]';
const FOLLOWING = 4;

function normalized(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function findIdentity(root: any, row: Row): any {
  const ids = [row.tool_call_id, row.item_id,
    row.item_id?.startsWith("user-") ? row.item_id.slice(5) : undefined,
    row.item_id?.startsWith("ast-") ? row.item_id.slice(4) : undefined,
  ].filter(Boolean) as string[];
  const attributes = ["data-message-id", "data-history-row-id", "data-call-id", "data-item-id", "data-turn-id", "id"];
  for (const node of Array.from(root.querySelectorAll(attributes.map((attr) => `[${attr}]`).join(", "))) as any[]) {
    if (attributes.some((attr) => {
      const value = node.getAttribute(attr);
      return value && ids.some((id) => value === id || value === `agent_tool_${id}` ||
        value.endsWith(`/${encodeURIComponent(id)}`) || value === `message-${id}` ||
        value === `call-${id}` || value === `turn-${id}`);
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

function toolHint(row: Row): string | undefined {
  try {
    const input = JSON.parse(row.tool_input ?? "null");
    return input?.command ?? input?.path ?? input?.CommandLine ?? input?.Path ?? row.tool_input;
  } catch {
    return row.tool_input;
  }
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

// Paseo folds finished turns behind a "turn-summary" badge rendered after the user message.
function findTurnSummary(root: any, rows: Row[], start: number): any {
  const summaries = Array.from(root.querySelectorAll(TURN_SUMMARY)) as any[];
  if (summaries.length === 0) return null;
  for (let i = start - 1; i >= 0; i--) {
    if (rows[i].kind !== "user") continue;
    const anchor = findIdentity(root, rows[i]) ?? findText(root, rows[i].summary_line);
    if (!anchor) return null;
    return summaries.find((candidate) => (anchor.compareDocumentPosition(candidate) & FOLLOWING) !== 0) ?? null;
  }
  return null;
}

function turnNodes(root: any, summary: any, selector: string): any[] {
  const summaries = Array.from(root.querySelectorAll(TURN_SUMMARY)) as any[];
  const next = summaries.find((candidate) => (summary.compareDocumentPosition(candidate) & FOLLOWING) !== 0);
  return (Array.from(root.querySelectorAll(selector)) as any[]).filter((node) =>
    (summary.compareDocumentPosition(node) & FOLLOWING) !== 0 &&
    (!next || (node.compareDocumentPosition(next) & FOLLOWING) !== 0));
}

function turnCollapsed(root: any, summary: any): boolean {
  const state = summary.getAttribute?.("aria-expanded");
  if (state != null) return state === "false";
  return turnNodes(root, summary, `${BADGE}, ${GROUP}`).length === 0;
}

function visible(node: any): boolean {
  if (typeof node.getClientRects !== "function") return true;
  return node.getClientRects().length > 0;
}

// Paseo keeps other agents' chats mounted (hidden); bind to the one showing this session.
function pickChatRoot(doc: any, rows: Row[]): any {
  const roots = (Array.from(doc?.querySelectorAll?.('[data-testid="agent-chat-scroll"]') ?? []) as any[]);
  if (roots.length <= 1) return roots[0] ?? null;
  const score = (root: any) => rows.filter((candidate) => candidate.kind !== "tool" &&
    (findIdentity(root, candidate) ?? findText(root, candidate.summary_line))).length;
  const ranked = roots.map((root) => ({ root, score: score(root), shown: visible(root) }))
    .sort((a, b) => (b.score - a.score) || (Number(b.shown) - Number(a.shown)));
  return ranked[0].root;
}

let navigationVersion = 0;

export async function scrollToMessageInChat(
  row: Row,
  rows: Row[],
  options: { document?: any; afterExpand?: () => Promise<void>; turnExpanded?: boolean } = {},
): Promise<boolean> {
  const version = ++navigationVersion;
  const doc = options.document ?? (globalThis as unknown as { document?: any }).document;
  const root = pickChatRoot(doc, rows.length > 0 ? rows : [row]);
  if (!root) return false;
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
    const summary = findTurnSummary(root, rows, start);
    if (summary) {
      if (turnCollapsed(root, summary)) {
        const button = summary.querySelector?.('button, [role="button"]') ?? summary;
        try { button.click(); } catch { return highlightAndScroll(summary); }
        const wait = options.afterExpand ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
        for (let attempt = 0; attempt < 4; attempt++) {
          await wait();
          if (version !== navigationVersion) return false;
          if (!turnCollapsed(root, summary)) break;
        }
      }
      const nested = turnNodes(root, summary, GROUP);
      if (nested.length > 0) {
        navigationVersion--;
        return scrollToMessageInChat(row, rows, { ...options, turnExpanded: true });
      }
      const badges = turnNodes(root, summary, BADGE);
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
