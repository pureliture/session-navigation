import type { Row } from "../shared/sessionNav";

export function fmtBytes(n: number | undefined): string {
  if (n == null) return "0 B";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

export function fmtBytePair(postBytes: number, preBytes: number): string {
  const post = Math.max(0, postBytes);
  const pre = Math.max(0, preBytes);
  if (pre < 1024 && post < 1024) {
    return `${post}/${pre} B`;
  }
  const preKib = (pre / 1024).toFixed(1);
  if (post === 0) {
    return `0/${preKib} KiB`;
  }
  const postKib = post / 1024;
  return postKib < 0.05 ? `<0.1/${preKib} KiB` : `${postKib.toFixed(1)}/${preKib} KiB`;
}

export function fmtTokenCount(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}K`;
}

export function fmtTokens(n: number): string {
  return `${fmtTokenCount(n)} tok`;
}

export function effectiveRowBytes(row: Row): number {
  if (row.status === "hidden") {
    let post: number | undefined;
    if (typeof row.compacted_bytes_size === "number") post = row.compacted_bytes_size;
    else if (typeof row.replacement_text === "string") post = utf8ByteLength(row.replacement_text);
    else if (row.kind === "user" || row.kind === "assistant" || row.kind === "agent") post = 0;
    if (post !== undefined) {
      const clamped = Math.max(0, post);
      return typeof row.bytes_size === "number" ? Math.min(Math.max(0, row.bytes_size), clamped) : clamped;
    }
  }
  return row.bytes_size ?? 0;
}

export function rowMetric(row: Row): string {
  if (row.status === "hidden") {
    const post = effectiveRowBytes(row);
    return typeof row.bytes_size === "number" ? fmtBytePair(post, row.bytes_size) : fmtBytes(post);
  }
  return row.tokens_display && row.tokens_display !== "—" ? row.tokens_display : fmtBytes(row.bytes_size);
}

export function truncateString(str: string, maxLen = 120): string {
  if (!str) return "";
  const singleLine = str.replace(/\r?\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return text ? UTF8_ENCODER.encode(text).byteLength : 0;
}

/**
 * Stable React key for an outline row. Fallback (hermes/linked) rows have
 * `item_id: null` and often an empty `tool_call_id`, so `item_id ??
 * tool_call_id` collapses many rows to the same `""` key (duplicate-key
 * warnings, multi-row highlight). Fall back to `timeline_index`, then to the
 * row position, so every row keys uniquely.
 */
export function outlineRowKey(row: Row, index: number): string {
  if (row.item_id) return row.item_id;
  if (row.tool_call_id) return row.tool_call_id;
  if (typeof row.timeline_index === "number") return `timeline:${row.timeline_index}`;
  return `row:${index}`;
}

const LEADING_REASONING_BLOCK = /^\s*💭\s*\*\*Reasoning:\*\*\s*\r?\n```[^\n]*\r?\n([\s\S]*?)\r?\n```(?:\s*\r?\n)*/u;
const SYSTEM_BLOCK_RE =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<system-notice>[\s\S]*?<\/system-notice>/gu;

function sliceCodepoints(text: string, maxLen: number): string {
  return [...text].slice(0, maxLen).join("");
}

function formatPaseoSystemSnippet(trimmed: string): string {
  const titleMatch = /source-agent-title="([^"]+)"/u.exec(trimmed);
  const eventMatch = /event="([^"]+)"/u.exec(trimmed);
  const idMatch = /source-agent-id="([^"]+)"/u.exec(trimmed);
  const kindMatch = /kind="([^"]+)"/u.exec(trimmed);
  const label = titleMatch?.[1]?.trim() || (idMatch?.[1] ? idMatch[1].slice(0, 8) : "");
  if (eventMatch?.[1]) {
    return sliceCodepoints(`[Subagent ${eventMatch[1]}] ${label || "subagent"}`, 220);
  }
  if (kindMatch?.[1] === "agent-notification") {
    return sliceCodepoints(`[Subagent notification] ${label || "subagent"}`, 220);
  }
  const body = trimmed
    .replace(/^<paseo-system\b[^>]*(?:>|$)/u, "")
    .replace(/<\/paseo-system>/gu, "")
    .replace(/<[^>]+>/gu, " ");
  const bodyLine = body
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .find(Boolean);
  const formatted = bodyLine
    ? `[Agent message${label ? ` · ${label}` : ""}] ${bodyLine}`
    : `[Agent message] ${label || "subagent"}`;
  return sliceCodepoints(formatted, 220);
}

export function messageSummarySnippet(text: string | undefined | null): string {
  if (!text) return "";
  let source = text.replace(SYSTEM_BLOCK_RE, "");
  const match = source.match(LEADING_REASONING_BLOCK);
  if (match) {
    const remainder = source.slice(match[0].length).trim();
    if (remainder) {
      source = remainder;
    } else {
      const innerLine = (match[1] ?? "")
        .split(/\r?\n/u)
        .map((line) => line.trim().replace(/\s+/gu, " "))
        .find(Boolean);
      return innerLine ? `💭 **Reasoning:**\n${innerLine}` : "💭 **Reasoning:**";
    }
  }
  const trimmed = source.trimStart();
  if (trimmed.startsWith("<paseo-system")) {
    return formatPaseoSystemSnippet(trimmed);
  }
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(
      (line) =>
        Boolean(line) &&
        line !== "```" &&
        !line.startsWith("[hidden:") &&
        !line.startsWith("The remaining result is preserved"),
    )
    .slice(0, 2)
    .join("\n");
}

const SUMMARY_SOURCES: Record<string, true> = {
  rule_summary: true,
  llm: true,
  llm_summary: true,
  summarize: true,
  summarize_pending: true,
};

export function isSummarizedRow(row: Row, localMode?: "hide" | "summarize"): boolean {
  const src = String(row.source ?? "")
    .trim()
    .toLowerCase();
  if (Object.hasOwn(SUMMARY_SOURCES, src)) return true;
  if (src === "explicit_user_hide") return localMode === "summarize";
  return localMode === "summarize";
}

/** Snippet label for a hidden row; queued summaries are distinct from already-summarized rows. */
export function hiddenRowSnippet(row: Row, summarized: boolean, text: string): string {
  const label = row.summary_pending === true
    ? "[summary queued · next prompt]"
    : summarized ? "[summarized]" : "[hidden]";
  return `${label} ${text}`;
}

const CONTEXT_NAV_TOOL_NAMES: Record<string, true> = {
  manage_context: true,
  hide_context: true,
  summarize_context: true,
  unhide_context: true,
  list_context_items: true,
};

export type OutlineRow =
  | { key: string; type: "user"; row: Row }
  | { key: string; type: "assistant"; row: Row }
  | {
      key: string;
      type: "group";
      groupId: string;
      title: string;
      subTitle: string;
      totalBytes: number;
      originalTotalBytes: number;
      totalTokens: number | null;
      children: Row[];
      allHidden: boolean;
      allManageableHidden: boolean;
      allSummarized: boolean;
      mixed: boolean;
      hiddenCount: number;
      summarizedCount: number;
      visibleManageableCount: number;
    }
  | { key: string; type: "child"; row: Row; groupId: string };

export function groupMetric(group: {
  totalBytes: number;
  originalTotalBytes: number;
  totalTokens: number | null;
  hiddenCount: number;
}): string {
  if (group.hiddenCount > 0) {
    return fmtBytePair(group.totalBytes, group.originalTotalBytes);
  }
  return group.totalTokens != null ? fmtTokens(group.totalTokens) : fmtBytes(group.totalBytes);
}

export function buildGroupedRows(
  rows: Row[],
  expandedGroups: Record<string, boolean>,
  lastActionByItem: Record<string, "hide" | "summarize">,
): OutlineRow[] {
  const result: OutlineRow[] = [];
  let currentGroupTools: Row[] = [];
  let currentGroupFirstIndex = 0;

  const flushGroup = () => {
    if (currentGroupTools.length === 0) return;
    const first = currentGroupTools[0];
    const groupId = `group:${outlineRowKey(first, currentGroupFirstIndex)}`;
    const hiddenChildren = currentGroupTools.filter((r) => r.status === "hidden");
    const hiddenCount = hiddenChildren.length;
    const totalBytes = currentGroupTools.reduce((sum, r) => sum + effectiveRowBytes(r), 0);
    const originalTotalBytes = currentGroupTools.reduce((sum, r) => sum + (r.bytes_size ?? 0), 0);
    const totalTokens =
      hiddenCount === 0 && currentGroupTools.every((r) => typeof r.tokens === "number")
        ? currentGroupTools.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
        : null;
    const summarizedCount = hiddenChildren.filter((r) => {
      const k = r.item_id ?? r.tool_call_id;
      return isSummarizedRow(r, lastActionByItem[k]);
    }).length;
    const visibleManageableCount = currentGroupTools.filter(
      (r) => r.status !== "hidden" && r.manageable !== false,
    ).length;
    const allHidden = hiddenCount === currentGroupTools.length && currentGroupTools.length > 0;
    const allManageableHidden = hiddenCount > 0 && visibleManageableCount === 0;
    const mixed =
      (hiddenCount > 0 && !allHidden) ||
      (summarizedCount > 0 && summarizedCount < hiddenCount);
    const allSummarized =
      allManageableHidden && summarizedCount === hiddenCount;

    // Tool name counts for subtitle summary (e.g. "bash × 3, read × 2")
    const nameCounts: Record<string, number> = {};
    for (const r of currentGroupTools) {
      const name = r.tool_name || "tool";
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    }
    const entries = Object.entries(nameCounts);
    const formatEntry = ([name, count]: [string, number]) => (count > 1 ? `${name} × ${count}` : name);
    const head = entries.slice(0, 3);
    const pinnedNav = entries.slice(3).filter(([name]) => CONTEXT_NAV_TOOL_NAMES[name]);
    const shown = [...head, ...pinnedNav];
    const omittedCount = entries.length - shown.length;
    const subTitle =
      shown.map(formatEntry).join(", ") + (omittedCount > 0 ? `, +${omittedCount}` : "");

    const count = currentGroupTools.length;
    const title = count === 1 ? "1 tool call" : `${count} tool calls`;

    result.push({
      key: groupId,
      type: "group",
      groupId,
      title,
      subTitle,
      totalBytes,
      originalTotalBytes,
      totalTokens,
      children: currentGroupTools,
      allHidden,
      allManageableHidden,
      allSummarized,
      mixed,
      hiddenCount,
      summarizedCount,
      visibleManageableCount,
    });

    const isExpanded = !!expandedGroups[groupId];
    if (isExpanded) {
      for (const [childOffset, child] of currentGroupTools.entries()) {
        const childKey = outlineRowKey(child, currentGroupFirstIndex + childOffset);
        result.push({
          key: `child:${childKey}`,
          type: "child",
          row: child,
          groupId,
        });
      }
    }

    currentGroupTools = [];
  };

  for (const [index, row] of rows.entries()) {
    const kind =
      row.kind ?? (row.tool_name === "user" ? "user" : row.tool_name === "assistant" ? "assistant" : "tool");
    if (kind === "user") {
      flushGroup();
      result.push({
        key: outlineRowKey(row, index),
        type: "user",
        row,
      });
    } else if (kind === "assistant" || kind === "agent") {
      flushGroup();
      result.push({
        key: outlineRowKey(row, index),
        type: "assistant",
        row,
      });
    } else {
      if (currentGroupTools.length === 0) currentGroupFirstIndex = index;
      currentGroupTools.push(row);
    }
  }

  flushGroup();
  return result;
}

export function groupEyeAction(group: { hiddenCount: number }): "hide" | "unhide" {
  return group.hiddenCount > 0 ? "unhide" : "hide";
}

/**
 * Picks the slashed restore icon for a group: shows summarize when any hidden child is summarized.
 */
export function groupRestoreIconKind(group: {
  hiddenCount: number;
  summarizedCount: number;
}): "hide" | "summarize" {
  return group.summarizedCount > 0 ? "summarize" : "hide";
}

/**
 * Formats the group header badge reflecting plain-hidden and summarized child counts.
 */
export function groupBadgeText(group: {
  children: Row[];
  allHidden: boolean;
  hiddenCount: number;
  summarizedCount: number;
}): string | null {
  const { children, allHidden, hiddenCount, summarizedCount } = group;
  if (hiddenCount <= 0) return null;
  const plainHiddenCount = Math.max(0, hiddenCount - summarizedCount);
  if (allHidden) {
    if (summarizedCount > 0 && plainHiddenCount > 0) {
      return `${summarizedCount} summarized, ${plainHiddenCount} hidden`;
    }
    return null;
  }
  if (summarizedCount === 0) {
    return `${hiddenCount}/${children.length} hidden`;
  }
  if (plainHiddenCount === 0) {
    return `${summarizedCount}/${children.length} summarized`;
  }
  return `${summarizedCount} summarized, ${plainHiddenCount} hidden / ${children.length}`;
}

/**
 * Formats the group subtitle reflecting summarized, plain-hidden, and unmanageable states.
 */
export function groupSubtitleText(group: {
  subTitle: string;
  children: Row[];
  allHidden: boolean;
  allManageableHidden?: boolean;
  allSummarized: boolean;
  hiddenCount: number;
  summarizedCount: number;
}): string {
  const {
    subTitle,
    children,
    allHidden,
    allManageableHidden,
    allSummarized,
    hiddenCount,
    summarizedCount,
  } = group;
  const plainHiddenCount = Math.max(0, hiddenCount - summarizedCount);
  const effectiveAllManageableHidden = allManageableHidden ?? allHidden;
  if (allHidden) {
    if (allSummarized || (summarizedCount > 0 && plainHiddenCount === 0)) {
      return `[all summarized] tap slashed icon to restore (${subTitle})`;
    }
    if (summarizedCount > 0) {
      return `[${summarizedCount} summarized, ${plainHiddenCount} hidden] tap slashed icon to restore (${subTitle})`;
    }
    return `[all hidden] tap slashed icon to restore (${subTitle})`;
  }
  if (effectiveAllManageableHidden && hiddenCount > 0) {
    if (plainHiddenCount === 0) {
      return `[${summarizedCount}/${children.length} summarized] tap slashed icon to restore (${subTitle})`;
    }
    if (summarizedCount > 0) {
      return `[${summarizedCount} summarized, ${plainHiddenCount} hidden] tap slashed icon to restore (${subTitle})`;
    }
    return `[${hiddenCount}/${children.length} hidden] tap slashed icon to restore (${subTitle})`;
  }
  return subTitle || "tools";
}

export function groupMutationItems(
  group: { children: Row[] },
  action: "hide" | "summarize" | "unhide",
): { item_id: string; expected_version: number }[] {
  const members = group.children.filter((row) =>
    row.manageable !== false && (action === "unhide" ? row.status === "hidden" : row.status !== "hidden"),
  );
  return members.map((row) => ({ item_id: row.item_id ?? row.tool_call_id, expected_version: row.version }));
}
