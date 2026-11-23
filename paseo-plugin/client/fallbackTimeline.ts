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
  fullTimeline = false,
): Row[] {
  if (!parentScope.startsWith("hermes:") || timeline.length === 0) {
    return mergeLinkedParentRows(rows, timeline, scopes, parentScope);
  }
  const managedByCallId = new Map<string, Row>();
  for (const row of rows) {
    if (row.tool_call_id) managedByCallId.set(row.tool_call_id, row);
  }
  const consumed = new Set<string>();
  // Count fallback message identities first; each managed server row consumes
  // at most one fallback copy of the same message. The managed copy is kept
  // (it carries item_id/version/status) and the display-only fallback copy is
  // suppressed below. Count-based consumption — not a global key set — keeps
  // distinct rows that merely share a text prefix.
  const timelineMessageCounts = new Map<string, number>();
  for (const tRow of timeline) {
    const key = messageDedupeKey(tRow);
    if (key) timelineMessageCounts.set(key, (timelineMessageCounts.get(key) ?? 0) + 1);
  }
  const suppressedTimelineCopies = new Map<string, number>();
  for (const row of rows) {
    const key = messageDedupeKey(row);
    if (!key) continue;
    const remaining =
      (timelineMessageCounts.get(key) ?? 0) - (suppressedTimelineCopies.get(key) ?? 0);
    if (remaining > 0) suppressedTimelineCopies.set(key, (suppressedTimelineCopies.get(key) ?? 0) + 1);
  }
  const consumeSuppressedCopy = (key: string | null): boolean => {
    if (!key) return false;
    const remaining = suppressedTimelineCopies.get(key) ?? 0;
    if (remaining <= 0) return false;
    suppressedTimelineCopies.set(key, remaining - 1);
    return true;
  };
  const merged: Row[] = [];
  for (const tRow of timeline) {
    if (tRow.kind === "user" || tRow.kind === "assistant" || tRow.kind === "agent") {
      // A managed server copy exists: keep it (metadata preserved) and drop
      // this display-only duplicate.
      if (consumeSuppressedCopy(messageDedupeKey(tRow))) continue;
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
  const unmatched = rows.filter((row) => {
    if (row.tool_call_id && consumed.has(row.tool_call_id)) return false;
    return true;
  });
  const matchedFloor = merged.reduce<number | null>((floor, row) => {
    if (typeof row.timeline_index !== "number") return floor;
    return floor === null ? row.timeline_index : Math.min(floor, row.timeline_index);
  }, null);
  // With a 150-row tail, unmatched managed rows were older than the window and
  // belonged ahead of it. A full fallback keeps that ordering instead of
  // pushing unmatched rows after the entire history.
  if (fullTimeline) return [...unmatched, ...merged];
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

function messageDedupeBucket(row: Row): "message" | null {
  // Compaction summaries and chat messages share one identity bucket: the
  // server may store a summary as kind "user" while the fallback window
  // renders the same text as kind "agent" (or vice versa). Kind-prefixed keys
  // miss that match (false negative) and show the summary twice.
  if (row.tool_name === "compaction") return "message";
  if (row.kind === "user" || row.kind === "assistant" || row.kind === "agent") return "message";
  return null;
}

function messageDedupeKey(row: Row): string | null {
  if (!messageDedupeBucket(row)) return null;
  // Full normalized text: a 120-char prefix collides for distinct rows that
  // share a long common prefix (false positive) and deletes legitimate rows.
  const text = String(row.message_text ?? row.summary_line ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  return `message\0${text}`;
}
