export type { OutlineRow } from "./outlineGrouping";
import type { Row } from "../shared/sessionNav";
import { outlineRowKey, type OutlineRow } from "./outlineGrouping";

export function visiblePollInterval(intervalMs: number): number | false {
  const doc = "document" in globalThis ? (globalThis as { document?: { visibilityState?: unknown; hidden?: unknown } }).document : undefined;
  if (doc && (doc.visibilityState === "hidden" || doc.hidden === true)) {
    return false;
  }
  return intervalMs;
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
      a.cost_usd === b.cost_usd &&
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
    const k = outlineRowKey(r, i);
    if (!prevByKey.has(k)) prevByKey.set(k, r);
  }

  let allSame = prev.length === next.length;
  const stabilized = new Array<Row>(next.length);
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    const k = outlineRowKey(r, i);
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
