import type { Row } from "../shared/sessionNav";
import { messageSummarySnippet, truncateString, utf8ByteLength } from "./outlineGrouping";
import { childrenForCall, type ChildScope } from "./subagents";
import { fallbackToolPreview } from "./toolPreview";

function entryTimelineIndex(entry: any): number | undefined {
  const seq = entry?.seqStart;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
}

function resolveRawMessageId(item: Record<string, any>): string | null {
  if (typeof item.messageId === "string" && item.messageId.length > 0) return item.messageId;
  if (typeof item.clientMessageId === "string" && item.clientMessageId.length > 0) {
    return item.clientMessageId;
  }
  if (typeof item.id === "string" && item.id.length > 0) return item.id;
  return null;
}

function buildToolCallFallbackRow(entry: any, item: Record<string, any>, index: number): Row {
  const detail =
    typeof item.detail === "object" && item.detail !== null
      ? (item.detail as Record<string, unknown>)
      : {};
  const argsObj =
    typeof item.args === "object" && item.args !== null
      ? (item.args as Record<string, unknown>)
      : typeof detail.args === "object" && detail.args !== null
        ? (detail.args as Record<string, unknown>)
        : typeof detail.input === "object" && detail.input !== null
          ? (detail.input as Record<string, unknown>)
          : null;

  const itemType = typeof item.type === "string" ? item.type : "";
  const detailType = typeof detail.type === "string" ? detail.type : "";
  const cmdStr =
    typeof detail.command === "string"
      ? detail.command
      : typeof detail.cmd === "string"
        ? detail.cmd
        : typeof argsObj?.CommandLine === "string"
          ? (argsObj.CommandLine as string)
          : typeof argsObj?.command === "string"
            ? (argsObj.command as string)
            : typeof argsObj?.keys === "string"
              ? (argsObj.keys as string)
              : "";

  let toolName = "tool";
  if (typeof item.name === "string" && item.name.length > 0) {
    toolName = item.name;
  } else if (typeof detail.name === "string" && detail.name.length > 0) {
    toolName = detail.name;
  } else if (typeof detail.command_name === "string" && detail.command_name.length > 0) {
    toolName = detail.command_name;
  } else if (
    detailType === "shell" ||
    itemType === "command" ||
    itemType === "terminal" ||
    itemType === "bash" ||
    itemType === "shell" ||
    cmdStr
  ) {
    toolName = "run_command";
  } else if (detailType) {
    toolName = detailType;
  }
  if (toolName === "tool" || toolName === "other" || toolName === "tool_call" || toolName === "unknown") {
    const hintTitle =
      typeof detail.title === "string"
        ? detail.title
        : typeof detail.label === "string"
          ? detail.label
          : "";
    const navMatch =
      /\b(manage_context|hide_context|summarize_context|unhide_context|list_context_items)\b/.exec(
        hintTitle,
      );
    if (navMatch) {
      toolName = navMatch[1];
    } else if (argsObj && Array.isArray(argsObj.tool_call_ids)) {
      toolName = "manage_context";
    }
  }

  let summary = "";
  if (cmdStr) {
    summary = `$ ${cmdStr}`;
  } else if (detailType === "sub_agent") {
    const actions = Array.isArray(detail.actions) ? detail.actions : [];
    const actionSuffix = actions.length > 0 ? ` (${actions.length} actions)` : "";
    if (typeof detail.description === "string" && detail.description.length > 0) {
      summary = `${detail.description}${actionSuffix}`;
    } else if (typeof detail.subAgentType === "string") {
      summary = `subagent: ${detail.subAgentType}${actionSuffix}`;
    } else {
      summary = `Subagent invocation${actionSuffix}`;
    }
  } else if (detailType === "read" || detailType === "write" || detailType === "edit") {
    if (typeof detail.filePath === "string") {
      summary = detail.filePath;
    }
  } else if (detailType === "search") {
    if (typeof detail.query === "string") {
      summary = `query: ${detail.query}`;
    }
  } else if (detailType === "fetch") {
    if (typeof detail.url === "string") {
      summary = detail.url;
    }
  } else if (detailType === "worktree_setup") {
    if (typeof detail.branchName === "string") {
      summary = `branch: ${detail.branchName}`;
    } else if (typeof detail.worktreePath === "string") {
      summary = detail.worktreePath;
    }
  }

  if (!summary) {
    if (typeof detail.text === "string" && detail.text.length > 0) {
      summary = detail.text;
    } else if (typeof detail.label === "string" && detail.label.length > 0) {
      summary = detail.label;
    } else if (argsObj) {
      if (typeof argsObj.Path === "string") {
        summary = `${argsObj.Path}`;
      } else if (typeof argsObj.Prompt === "string") {
        summary = truncateString(argsObj.Prompt, 100);
      } else if (typeof argsObj.query === "string") {
        summary = `query: ${argsObj.query}`;
      } else {
        try {
          summary = JSON.stringify(argsObj);
        } catch {
          summary = `Tool call: ${toolName}`;
        }
      }
    } else {
      summary = `Tool call: ${toolName}`;
    }
  }

  let resultLen = 0;
  const outCandidates = [
    item.result,
    detail.result,
    detail.output,
    detail.content,
    detail.unifiedDiff,
    detail.log,
  ];
  for (const c of outCandidates) {
    if (typeof c === "string" && c.length > 0) {
      resultLen += c.length;
      break;
    } else if (c && typeof c === "object") {
      try {
        resultLen += JSON.stringify(c).length;
        break;
      } catch {
        // Ignore non-serializable fallback payloads.
      }
    }
  }

  const totalBytes = summary.length + (resultLen > 0 ? resultLen : 0);
  const callId =
    typeof item.callId === "string" && item.callId.length > 0
      ? item.callId
      : typeof detail.call_id === "string"
        ? detail.call_id
        : `tool-${entry?.seqStart ?? index}`;

  const timelineIndex = entryTimelineIndex(entry);
  return {
    item_id: callId,
    tool_call_id: callId,
    kind: "tool",
    tool_name: toolName,
    status: "visible",
    version: 1,
    tokens_display: "—",
    bytes_size: totalBytes,
    summary_line: summary,
    ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
    ...fallbackToolPreview(item, detail),
  };
}

function buildAgentEventFallbackRow(
  entry: any,
  item: Record<string, any>,
  itemType: string,
  rawMsgId: string | null,
  index: number,
): Row | null {
  const timelineIndex = entryTimelineIndex(entry);
  if (itemType === "todo") {
    const todoItems = Array.isArray(item.items) ? item.items : [];
    const itemLines = todoItems
      .map((todo: any) => {
        const label =
          typeof todo?.text === "string"
            ? todo.text
            : typeof todo?.title === "string"
              ? todo.title
              : typeof todo?.content === "string"
                ? todo.content
                : "";
        if (!label) return "";
        const done = Boolean(
          todo?.completed || todo?.done || todo?.status === "completed" || todo?.status === "done",
        );
        return `${done ? "[x]" : "[ ]"} ${label}`;
      })
      .filter(Boolean);
    const doneCount = todoItems.filter((todo: any) =>
      Boolean(todo?.completed || todo?.done || todo?.status === "completed" || todo?.status === "done"),
    ).length;
    const fullText =
      itemLines.length > 0
        ? itemLines.join("\n")
        : typeof item.text === "string" && item.text
          ? item.text
          : "Todo list updated";
    const headline =
      todoItems.length > 0
        ? `[Todo ${doneCount}/${todoItems.length}] ${itemLines[0] ?? ""}`.trim()
        : `[Todo] ${messageSummarySnippet(fullText)}`;
    return {
      item_id: rawMsgId ?? `todo-${entry?.seqStart ?? index}`,
      tool_call_id: rawMsgId ?? "",
      kind: "agent",
      tool_name: "todo",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: false,
      bytes_size: utf8ByteLength(fullText),
      summary_line: messageSummarySnippet(headline) || "[Todo]",
      message_text: fullText,
      ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
    };
  }

  if (itemType === "error") {
    const detailObj =
      typeof item.detail === "object" && item.detail !== null
        ? (item.detail as Record<string, unknown>)
        : null;
    const errText =
      typeof item.message === "string" && item.message
        ? item.message
        : typeof item.text === "string" && item.text
          ? item.text
          : typeof item.error === "string" && item.error
            ? item.error
            : typeof detailObj?.message === "string" && detailObj.message
              ? detailObj.message
              : "Unknown error";
    return {
      item_id: rawMsgId ?? `error-${entry?.seqStart ?? index}`,
      tool_call_id: rawMsgId ?? "",
      kind: "agent",
      tool_name: "error",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: false,
      bytes_size: utf8ByteLength(errText),
      summary_line: messageSummarySnippet(`[Error] ${errText}`) || "[Error]",
      message_text: errText,
      ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
    };
  }

  if (itemType === "compaction") {
    const compactText =
      typeof item.summary === "string" && item.summary
        ? item.summary
        : typeof item.text === "string" && item.text
          ? item.text
          : typeof item.message === "string" && item.message
            ? item.message
            : typeof item.reason === "string" && item.reason
              ? item.reason
              : "Context compacted";
    return {
      item_id: rawMsgId ?? `compaction-${entry?.seqStart ?? index}`,
      tool_call_id: rawMsgId ?? "",
      kind: "agent",
      tool_name: "compaction",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: false,
      bytes_size: utf8ByteLength(compactText),
      summary_line: messageSummarySnippet(`[Compaction] ${compactText}`) || "[Compaction]",
      message_text: compactText,
      ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
    };
  }

  if (itemType === "plugin") {
    const dataObj =
      typeof item.data === "object" && item.data !== null
        ? (item.data as Record<string, unknown>)
        : null;
    const pluginTitle =
      typeof item.title === "string" && item.title
        ? item.title
        : typeof dataObj?.title === "string" && dataObj.title
          ? dataObj.title
          : typeof item.pluginId === "string" && item.pluginId
            ? item.pluginId
            : "";
    const pluginBody =
      typeof item.text === "string" && item.text
        ? item.text
        : typeof item.message === "string" && item.message
          ? item.message
          : typeof dataObj?.text === "string" && dataObj.text
            ? dataObj.text
            : typeof dataObj?.message === "string" && dataObj.message
              ? dataObj.message
              : typeof dataObj?.summary === "string" && dataObj.summary
                ? dataObj.summary
                : item.data !== undefined
                  ? JSON.stringify(item.data)
                  : "";
    const fullText = [pluginTitle, pluginBody].filter(Boolean).join("\n") || "Plugin notice";
    const headline =
      pluginTitle && pluginBody
        ? `[Plugin · ${pluginTitle}] ${pluginBody}`
        : pluginTitle
          ? `[Plugin] ${pluginTitle}`
          : `[Plugin] ${pluginBody || "event"}`;
    return {
      item_id: rawMsgId ?? `plugin-${entry?.seqStart ?? index}`,
      tool_call_id: rawMsgId ?? "",
      kind: "agent",
      tool_name: "plugin",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: false,
      bytes_size: utf8ByteLength(fullText),
      summary_line: messageSummarySnippet(headline) || "[Plugin]",
      message_text: fullText,
      ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
    };
  }

  return null;
}

export function buildFallbackTimelineRows(entries: readonly any[]): Row[] {
  const result: Row[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const item = entry?.item;
    if (!item || typeof item !== "object") continue;
    const itemType = typeof item.type === "string" ? item.type : "";
    const rawMsgId = resolveRawMessageId(item);

    if (itemType === "user_message" || itemType === "assistant_message") {
      const isUser = itemType === "user_message";
      const text = typeof item.text === "string" ? item.text : "";
      const timelineIndex = entryTimelineIndex(entry);
      result.push({
        item_id: rawMsgId ?? `${isUser ? "user" : "ast"}-${entry?.seqStart ?? i}`,
        tool_call_id: rawMsgId ?? "",
        kind: isUser ? "user" : "assistant",
        tool_name: isUser ? "user" : "assistant",
        status: "visible",
        version: 1,
        tokens_display: "—",
        bytes_size: utf8ByteLength(text),
        summary_line: messageSummarySnippet(text),
        message_text: text,
        ...(timelineIndex !== undefined ? { timeline_index: timelineIndex } : {}),
      });
    } else if (
      itemType === "tool_call" ||
      itemType === "command" ||
      itemType === "terminal" ||
      itemType === "bash" ||
      itemType === "shell"
    ) {
      result.push(buildToolCallFallbackRow(entry, item, i));
    } else {
      const eventRow = buildAgentEventFallbackRow(entry, item, itemType, rawMsgId, i);
      if (eventRow) result.push(eventRow);
    }
  }
  return result;
}

export function mergeLinkedParentRows(
  rows: Row[],
  timeline: Row[],
  scopes: readonly ChildScope[],
  parentScope: string,
): Row[] {
  const missing = timeline.filter(
    (row) =>
      row.kind === "tool" &&
      !rows.some((managed) => managed.tool_call_id === row.tool_call_id) &&
      childrenForCall(scopes, parentScope, row.tool_call_id).length > 0,
  );
  return [
    ...rows,
    ...missing.map((row) => ({
      ...row,
      item_id: null,
      manageable: false,
      tool_name: parentScope.startsWith("hermes:") ? "delegate_task" : row.tool_name,
    })),
  ];
}

export function mergeHermesTimelineRows(
  rows: Row[],
  timeline: Row[],
  scopes: readonly ChildScope[],
  parentScope: string,
): Row[] {
  if (!parentScope.startsWith("hermes:") || timeline.length === 0) {
    return mergeLinkedParentRows(rows, timeline, scopes, parentScope);
  }
  const managedByCallId = new Map<string, Row>();
  for (const row of rows) {
    if (row.tool_call_id) managedByCallId.set(row.tool_call_id, row);
  }
  const consumed = new Set<string>();
  const merged: Row[] = [];
  for (const tRow of timeline) {
    if (tRow.kind === "user" || tRow.kind === "assistant" || tRow.kind === "agent") {
      merged.push({ ...tRow, item_id: null, manageable: false });
      continue;
    }
    const managed = tRow.tool_call_id ? managedByCallId.get(tRow.tool_call_id) : undefined;
    if (managed) {
      merged.push(managed);
      consumed.add(tRow.tool_call_id);
    } else {
      const hasChild =
        Boolean(tRow.tool_call_id) && childrenForCall(scopes, parentScope, tRow.tool_call_id).length > 0;
      merged.push({
        ...tRow,
        item_id: null,
        manageable: false,
        tool_name: hasChild ? "delegate_task" : tRow.tool_name,
      });
    }
  }
  const unmatched = rows.filter((row) => !row.tool_call_id || !consumed.has(row.tool_call_id));
  const matchedFloor = merged.reduce<number | null>((floor, row) => {
    if (typeof row.timeline_index !== "number") return floor;
    return floor === null ? row.timeline_index : Math.min(floor, row.timeline_index);
  }, null);
  // Unmatched server rows are older history outside the fallback window; keep them
  // ahead of the merged tail so upward paging visibly prepends instead of appending.
  const head =
    matchedFloor === null
      ? unmatched
      : unmatched.filter((row) => typeof row.timeline_index !== "number" || row.timeline_index < matchedFloor);
  const tail =
    matchedFloor === null
      ? []
      : unmatched.filter((row) => typeof row.timeline_index === "number" && row.timeline_index >= matchedFloor);
  return [...head, ...merged, ...tail];
}

function rowMergeKey(row: Row): string | null {
  if (typeof row.timeline_index === "number") return `idx:${row.timeline_index}`;
  if (row.item_id) return `item:${row.item_id}`;
  if (row.tool_call_id) return `call:${row.tool_call_id}`;
  return null;
}

export function mergePagedRows(
  olderRows: readonly Row[],
  newerRows: readonly Row[],
): Row[] {
  if (olderRows.length === 0) return [...newerRows];
  if (newerRows.length === 0) return [...olderRows];
  const newerByKey = new Map<string, Row>();
  const newerItemIds = new Set<string>();
  const newerCallIds = new Set<string>();
  let minNewerTimelineIndex = Infinity;
  for (const row of newerRows) {
    const key = rowMergeKey(row);
    if (key) newerByKey.set(key, row);
    if (row.item_id) newerItemIds.add(row.item_id);
    if (row.tool_call_id) newerCallIds.add(row.tool_call_id);
    if (typeof row.timeline_index === "number" && row.timeline_index < minNewerTimelineIndex) {
      minNewerTimelineIndex = row.timeline_index;
    }
  }
  const seenKeys = new Set<string>();
  const merged: Row[] = [];
  for (const row of olderRows) {
    if (
      typeof row.timeline_index === "number" &&
      Number.isFinite(minNewerTimelineIndex) &&
      row.timeline_index >= minNewerTimelineIndex
    ) {
      continue;
    }
    const key = rowMergeKey(row);
    if (key && newerByKey.has(key)) continue;
    if (row.item_id && newerItemIds.has(row.item_id)) continue;
    if (!row.item_id && row.tool_call_id && newerCallIds.has(row.tool_call_id)) continue;
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    merged.push(row);
  }
  for (const row of newerRows) {
    const key = rowMergeKey(row);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    merged.push(row);
  }
  if (merged.every((r) => typeof r.timeline_index === "number")) {
    merged.sort((a, b) => (a.timeline_index ?? 0) - (b.timeline_index ?? 0));
  }
  return merged;
}
