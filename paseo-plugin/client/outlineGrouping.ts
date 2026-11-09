import type { Row } from "../shared/sessionNav";

export function fmtBytes(n: number | undefined): string {
  if (n == null) return "0 B";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

export function truncateString(str: string, maxLen = 120): string {
  if (!str) return "";
  const singleLine = str.replace(/\r?\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

export function isSummarizedRow(row: Row, localMode?: "hide" | "summarize"): boolean {
  if (localMode) return localMode === "summarize";
  const src = row.source ?? "";
  return src === "rule_summary" || src === "llm" || src === "llm_summary" || src === "summarize";
}

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
      children: Row[];
      allHidden: boolean;
      allSummarized: boolean;
      mixed: boolean;
      hiddenCount: number;
    }
  | { key: string; type: "child"; row: Row; groupId: string };

export function buildGroupedRows(
  rows: Row[],
  expandedGroups: Record<string, boolean>,
  lastActionByItem: Record<string, "hide" | "summarize">,
): OutlineRow[] {
  const result: OutlineRow[] = [];
  let currentGroupTools: Row[] = [];

  const flushGroup = () => {
    if (currentGroupTools.length === 0) return;
    const first = currentGroupTools[0];
    const groupId = `group:${first.item_id ?? first.tool_call_id}`;
    const totalBytes = currentGroupTools.reduce((sum, r) => sum + (r.bytes_size ?? 0), 0);
    const hiddenCount = currentGroupTools.filter((r) => r.status === "hidden").length;
    const allHidden = hiddenCount === currentGroupTools.length && currentGroupTools.length > 0;
    const mixed = hiddenCount > 0 && !allHidden;
    const allSummarized =
      allHidden &&
      currentGroupTools.every((r) => {
        const k = r.item_id ?? r.tool_call_id;
        return isSummarizedRow(r, lastActionByItem[k]);
      });

    // Tool name counts for subtitle summary (e.g. "bash × 3, read × 2")
    const nameCounts: Record<string, number> = {};
    for (const r of currentGroupTools) {
      const name = r.tool_name || "tool";
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    }
    const subTitle = Object.entries(nameCounts)
      .map(([name, count]) => (count > 1 ? `${name} × ${count}` : name))
      .slice(0, 3)
      .join(", ");

    const count = currentGroupTools.length;
    const title = count === 1 ? "1 tool call" : `${count} tool calls`;

    result.push({
      key: groupId,
      type: "group",
      groupId,
      title,
      subTitle,
      totalBytes,
      children: currentGroupTools,
      allHidden,
      allSummarized,
      mixed,
      hiddenCount,
    });

    const isExpanded = !!expandedGroups[groupId];
    if (isExpanded) {
      for (const child of currentGroupTools) {
        const childKey = child.item_id ?? child.tool_call_id;
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

  for (const row of rows) {
    const kind =
      row.kind ?? (row.tool_name === "user" ? "user" : row.tool_name === "assistant" ? "assistant" : "tool");
    if (kind === "user") {
      flushGroup();
      result.push({
        key: row.item_id ?? row.tool_call_id,
        type: "user",
        row,
      });
    } else if (kind === "assistant") {
      flushGroup();
      result.push({
        key: row.item_id ?? row.tool_call_id,
        type: "assistant",
        row,
      });
    } else {
      currentGroupTools.push(row);
    }
  }

  flushGroup();
  return result;
}
