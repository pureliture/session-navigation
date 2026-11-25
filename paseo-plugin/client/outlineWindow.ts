export type { OutlineRow } from "./outlineGrouping";
import type { Row } from "../shared/sessionNav";
import type { OutlineRow } from "./outlineGrouping";

export const OUTLINE_VIRTUALIZE_THRESHOLD = 160;
export const OUTLINE_WINDOW_OVERSCAN = 24;
export const OUTLINE_INITIAL_TAIL_WINDOW = 80;

export function visiblePollInterval(intervalMs: number): number | false {
  const doc = "document" in globalThis ? (globalThis as { document?: { visibilityState?: unknown; hidden?: unknown } }).document : undefined;
  if (doc && (doc.visibilityState === "hidden" || doc.hidden === true)) {
    return false;
  }
  return intervalMs;
}

export function estimateOutlineItemHeight(
  item: OutlineRow,
  compact: boolean,
  _isExpanded: boolean,
): number {
  if (item.type === "group") return compact ? 44 : 48;
  if (item.type === "child") return compact ? 46 : 52;
  return compact ? 54 : 60;
}

export interface OutlineWindowSlice {
  virtualized: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  visibleItems: OutlineRow[];
}

function lowerBoundPrefix(offsets: readonly number[], targetY: number, itemCount: number): number {
  let lo = 0;
  let hi = itemCount - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] >= targetY) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function upperBoundPrefix(offsets: readonly number[], maxBottomY: number, itemCount: number): number {
  let lo = 0;
  let hi = itemCount - 1;
  let ans = itemCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] <= maxBottomY) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function computeOutlineWindow(
  items: readonly OutlineRow[],
  metrics: {
    scrollTop: number;
    clientHeight: number;
    compact: boolean;
    expandedGroups: Record<string, boolean>;
    pinToTail?: boolean;
    isSearching?: boolean;
  },
): OutlineWindowSlice {
  const n = items.length;
  if (n === 0) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
      visibleItems: [],
    };
  }

  let totalHeight = 0;
  const offsets = new Array<number>(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i];
    const h = estimateOutlineItemHeight(
      item,
      metrics.compact,
      item.type === "group" && Boolean(metrics.expandedGroups[item.groupId]),
    );
    totalHeight += h;
    offsets[i + 1] = totalHeight;
  }

  if (n < OUTLINE_VIRTUALIZE_THRESHOLD) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: n,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight,
      visibleItems: items as OutlineRow[],
    };
  }

  let rawStart: number;
  let rawEnd: number;
  const scrollTop = Math.max(0, Number.isFinite(metrics.scrollTop) ? metrics.scrollTop : 0);
  const clientHeight = Math.max(0, Number.isFinite(metrics.clientHeight) ? metrics.clientHeight : 0);

  if (clientHeight <= 0 || (metrics.pinToTail && scrollTop <= 0 && !metrics.isSearching)) {
    if (metrics.isSearching) {
      rawStart = 0;
      rawEnd = Math.min(n - 1, OUTLINE_INITIAL_TAIL_WINDOW - 1);
    } else {
      rawStart = Math.max(0, n - OUTLINE_INITIAL_TAIL_WINDOW);
      rawEnd = n - 1;
    }
  } else {
    rawStart = lowerBoundPrefix(offsets, scrollTop, n);
    rawEnd = upperBoundPrefix(offsets, scrollTop + clientHeight, n);
  }

  const startIndex = Math.max(0, rawStart - OUTLINE_WINDOW_OVERSCAN);
  const endIndex = Math.min(n, rawEnd + 1 + OUTLINE_WINDOW_OVERSCAN);
  const topSpacerHeight = offsets[startIndex];
  const bottomSpacerHeight = Math.max(0, totalHeight - offsets[endIndex]);

  return {
    virtualized: true,
    startIndex,
    endIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    visibleItems: items.slice(startIndex, endIndex),
  };
}

function sameRowFields(a: Row, b: Row): boolean {
  return (
    a === b ||
    (a.item_id === b.item_id &&
      a.tool_call_id === b.tool_call_id &&
      a.tool_name === b.tool_name &&
      a.kind === b.kind &&
      a.visibility === b.visibility &&
      a.status === b.status &&
      a.version === b.version &&
      a.summary_line === b.summary_line &&
      a.bytes_size === b.bytes_size &&
      a.compacted_bytes_size === b.compacted_bytes_size &&
      a.tokens === b.tokens &&
      a.tokens_display === b.tokens_display &&
      a.manageable === b.manageable &&
      a.source === b.source &&
      a.timeline_index === b.timeline_index &&
      a.replacement_text === b.replacement_text &&
      a.summary_pending === b.summary_pending &&
      a.tool_input === b.tool_input &&
      a.tool_output === b.tool_output &&
      a.message_text === b.message_text)
  );
}

export function stabilizeRows(prev: readonly Row[], next: readonly Row[]): Row[] {
  if (prev === next) return prev as Row[];
  if (prev.length === 0) return next as Row[];

  const prevByKey = new Map<string, Row>();
  for (let i = 0; i < prev.length; i++) {
    const r = prev[i];
    const k = r.item_id ?? r.tool_call_id ?? (typeof r.timeline_index === "number" ? `t:${r.timeline_index}` : `i:${i}`);
    if (!prevByKey.has(k)) prevByKey.set(k, r);
  }

  let allSame = prev.length === next.length;
  const stabilized = new Array<Row>(next.length);
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    const k = r.item_id ?? r.tool_call_id ?? (typeof r.timeline_index === "number" ? `t:${r.timeline_index}` : `i:${i}`);
    const prevMatch = prevByKey.get(k);
    if (prevMatch && sameRowFields(prevMatch, r)) {
      stabilized[i] = prevMatch;
      if (allSame && prev[i] !== prevMatch) allSame = false;
    } else {
      stabilized[i] = r;
      allSame = false;
    }
  }
  return allSame ? (prev as Row[]) : stabilized;
}

function sameOutlineItem(a: OutlineRow, b: OutlineRow): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === "child" && b.type === "child") {
    return a.groupId === b.groupId && sameRowFields(a.row, b.row);
  }
  if ((a.type === "user" && b.type === "user") || (a.type === "assistant" && b.type === "assistant")) {
    return sameRowFields(a.row, b.row);
  }
  if (a.type === "group" && b.type === "group") {
    if (
      a.groupId !== b.groupId ||
      a.title !== b.title ||
      a.subTitle !== b.subTitle ||
      a.totalBytes !== b.totalBytes ||
      a.originalTotalBytes !== b.originalTotalBytes ||
      a.totalTokens !== b.totalTokens ||
      a.allHidden !== b.allHidden ||
      a.allManageableHidden !== b.allManageableHidden ||
      a.allSummarized !== b.allSummarized ||
      a.mixed !== b.mixed ||
      a.hiddenCount !== b.hiddenCount ||
      a.summarizedCount !== b.summarizedCount ||
      a.visibleManageableCount !== b.visibleManageableCount ||
      a.children.length !== b.children.length
    ) {
      return false;
    }
    for (let i = 0; i < a.children.length; i++) {
      if (!sameRowFields(a.children[i], b.children[i])) return false;
    }
    return true;
  }
  return false;
}

export function stabilizeGroupedRows(
  prev: readonly OutlineRow[],
  next: readonly OutlineRow[],
): OutlineRow[] {
  if (prev === next) return prev as OutlineRow[];
  if (prev.length === 0) return next as OutlineRow[];

  const prevByKey = new Map<string, OutlineRow>();
  for (const item of prev) {
    if (!prevByKey.has(item.key)) prevByKey.set(item.key, item);
  }

  let allSame = prev.length === next.length;
  const stabilized = new Array<OutlineRow>(next.length);
  for (let i = 0; i < next.length; i++) {
    const item = next[i];
    const prevMatch = prevByKey.get(item.key);
    if (prevMatch && sameOutlineItem(prevMatch, item)) {
      stabilized[i] = prevMatch;
      if (allSame && prev[i] !== prevMatch) allSame = false;
    } else {
      stabilized[i] = item;
      allSame = false;
    }
  }
  return allSame ? (prev as OutlineRow[]) : stabilized;
}
