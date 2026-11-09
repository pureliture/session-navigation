import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { z } from "zod";
import {
  dbChoiceRpc,
  hideBatchRpc,
  hideItemRpc,
  listItemsRpc,
  listScopesRpc,
  unhideBatchRpc,
  unhideItemRpc,
  type Row,
} from "../shared/sessionNav";
import { scrollToMessageInChat, visibleChatValues } from "./chatNavigation";
import { resolveSessionTarget } from "./sessionFollowing";
import { fallbackToolPreview } from "./toolPreview";
import { readTimelineHistory } from "./timelineHistory";

import {
  buildGroupedRows,
  fmtBytes,
  fmtTokenCount,
  fmtTokens,
  groupMutationItems,
  groupEyeAction,
  isSummarizedRow,
  rowMetric,
  truncateString,
  type OutlineRow,
} from "./outlineGrouping";

const panelTabStateSchema = z.object({
  query: z.string().default(""),
});

type PanelTabState = z.infer<typeof panelTabStateSchema>;

const DEFAULT_TAB_STATE: PanelTabState = {
  query: "",
};

// AI FDE stroke icons (24x24 viewBox, 1.8px stroke, diagonal slash when active/hidden)
const EYE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';

const EYE_SLASHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

const SUMMARIZE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

const SUMMARIZE_SLASHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="m2 2 20 20"/></svg>';

function ActionSvgIcon({
  kind,
  slashed,
  size,
  color,
}: {
  kind: "hide" | "summarize";
  slashed: boolean;
  size: number;
  color: string;
}) {
  const svg =
    kind === "hide"
      ? slashed
        ? EYE_SLASHED_SVG
        : EYE_SVG
      : slashed
        ? SUMMARIZE_SLASHED_SVG
        : SUMMARIZE_SVG;

  if (typeof Icon === "function") {
    return <Icon icon={{ svg }} size={size} color={color} />;
  }

  // Fallback geometric rendering for test environments where host UI Icon is mocked/empty
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ fontSize: size - 2, color, lineHeight: size }}>
        {kind === "hide" ? "◉" : "▤"}
      </Text>
      {slashed ? (
        <View
          style={{
            position: "absolute",
            width: size + 2,
            height: 1.8,
            backgroundColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ) : null}
    </View>
  );
}

export function SessionNavPanel({ theme, layout, params, navigation, tab, followVisible = true, candidateAgentIds }: PluginAgentPanelProps & {
  followVisible?: boolean;
  candidateAgentIds?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  // Paseo binds agent panels to the agent they were opened for; follow whichever session the chat shows instead.
  const [followedId, setFollowedId] = useState<string | null>(null);
  const [inView, setInView] = useState(!!params.agentId);
  const agentId = followVisible ? followedId ?? params.agentId : params.agentId;
  const agent = useAgent(agentId, (v) => ({
    title: v.title,
    provider: v.provider,
    model: v.model,
  }));

  const listRpc = useRpc(listItemsRpc);
  const scopesRpc = useRpc(listScopesRpc);
  const hideRpc = useRpc(hideItemRpc);
  const unhideRpc = useRpc(unhideItemRpc);
  const hideBatch = useRpc(hideBatchRpc);
  const unhideBatch = useRpc(unhideBatchRpc);
  const dbChoice = useRpc(dbChoiceRpc);

  const [tabState, setTabState] = useTabState(tab, panelTabStateSchema, DEFAULT_TAB_STATE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dbErrorOpen, setDbErrorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice !== "Not loaded in chat") return;
    const timer = setTimeout(() => setNotice((current) => current === notice ? null : current), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [lastActionByItem, setLastActionByItem] = useState<Record<string, "hide" | "summarize">>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);

  const scopesQuery = useQuery({
    queryKey: ["session-nav", "scopes"],
    queryFn: async () => {
      const result = await scopesRpc({});
      if (!result.ok) throw new Error(result.error ?? "scopes_failed");
      return result.scopes;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      const bound = data?.some(
        (s) =>
          s.agent_id === agentId ||
          s.scope_key === `pi:default:${agentId}:default` ||
          s.scope_key === `paseo:default:${agentId}:default`,
      );
      return bound ? false : 3000;
    },
  });

  const scopes = scopesQuery.data ?? [];

  useEffect(() => {
    if (!followVisible) return;
    const doc = (globalThis as any).document;
    if (!doc || !paseo?.agents) return;
    let cancelled = false;
    const timelineIds = async (id: string): Promise<string[]> => {
      const page = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
      const entries = (page as { entries?: Array<{ item?: Record<string, unknown> }> })?.entries ?? [];
      return entries.flatMap((entry) => ["messageId", "callId", "id"].map((key) => entry?.item?.[key]))
        .filter((v): v is string => typeof v === "string" && v.length > 0);
    };
    const tick = async () => {
      const values = visibleChatValues(doc);
      const id = await resolveSessionTarget({
        followVisible, boundAgentId: params.agentId, visibleValues: values,
        candidates: [...candidateAgentIds ?? [], ...scopes.map((s) => s.agent_id).filter((id): id is string => !!id)],
        timelineIds: (id) => queryClient.fetchQuery({ queryKey: ["session-nav-follow", id], staleTime: 10_000, queryFn: () => timelineIds(id) }),
      });
      if (cancelled) return;
      setInView(!!id);
      setFollowedId(id === params.agentId ? null : id);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [paseo, params.agentId, scopes, queryClient, followVisible, candidateAgentIds]);
  const agentScopePi = `pi:default:${agentId}:default`;
  const agentScopePaseo = `paseo:default:${agentId}:default`;

  // 1:1 direct binding: only the active agent's session scope
  const resolvedScopeKey = useMemo(() => {
    const matchedByAgentId = scopes.find((s) => s.agent_id === agentId);
    if (matchedByAgentId) {
      return matchedByAgentId.scope_key;
    }
    if (scopes.some((s) => s.scope_key === agentScopePi)) {
      return agentScopePi;
    }
    if (scopes.some((s) => s.scope_key === agentScopePaseo)) {
      return agentScopePaseo;
    }
    return null;
  }, [scopes, agentId, agentScopePi, agentScopePaseo]);

  const scopeKey = resolvedScopeKey ?? "";
  const query = tabState.query;

  const onMutationError = (result: { ok: boolean; error?: string }) => {
    if (!result.ok && result.error === "version_conflict") {
      setNotice("Stale row — list refreshed.");
      void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
      return true;
    }
    if (!result.ok && (result.error === "db_error" || result.error === "db_full")) {
      setDbErrorOpen(true);
      return true;
    }
    if (!result.ok && result.error === "summarizer_unavailable") {
      setNotice("No session model — summarizer unavailable.");
      return true;
    }
    if (!result.ok) {
      setNotice(result.error ?? "failed");
      return true;
    }
    return false;
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
  // The host meter only moves after the next model request; until then show the expected change.
  const [pendingEstimate, setPendingEstimate] = useState<{ used: number; tokens: number } | null>(null);
  const notePending = (changed: Row[], sign: 1 | -1) => {
    const used = usageQuery.data?.contextWindowUsedTokens ?? listQuery.data?.context?.used_tokens;
    const tokens = changed.reduce((sum, r) => sum + (typeof r.tokens === "number" ? r.tokens : 0), 0) * sign;
    if (!used || !tokens) return;
    setPendingEstimate((prev) => ({ used, tokens: (prev?.used === used ? prev.tokens : 0) + tokens }));
  };

  const hideMutation = useMutation({
    mutationFn: ({ row, mode }: { row: Row; mode: "hide" | "summarize" }) => {
      const rowKey = row.item_id ?? row.tool_call_id;
      setLastActionByItem((prev) => ({ ...prev, [rowKey]: mode }));
      return hideRpc({
        scope_key: scopeKey,
        item_id: row.item_id ?? "",
        expected_version: row.version,
        mode,
      });
    },
    onSuccess: (r, { row }) => {
      if (!onMutationError(r)) {
        setNotice(null);
        if (row.status !== "hidden") notePending([row], -1);
        void invalidate();
      }
    },
  });

  const unhideMutation = useMutation({
    mutationFn: (row: Row) =>
      unhideRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version }),
    onSuccess: (r, row) => {
      if (!onMutationError(r)) {
        setNotice(null);
        notePending([row], 1);
        void invalidate();
      }
    },
  });

  const isMutating = hideMutation.isPending || unhideMutation.isPending || !!pendingGroupId;

  const runGroupBatch = async (
    group: OutlineRow & { type: "group" },
    action: "hide" | "summarize" | "unhide",
  ) => {
    if (pendingGroupId || !resolvedScopeKey) return;
    const items = groupMutationItems(group, action);
    if (items.length === 0) return;
    setPendingGroupId(group.groupId);
    setLastActionByItem((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (action === "unhide") delete next[item.item_id];
        else next[item.item_id] = action;
      }
      return next;
    });
    try {
      const result =
        action === "unhide"
          ? await unhideBatch({ scope_key: scopeKey, items })
          : await hideBatch({ scope_key: scopeKey, mode: action, items });
      const failures = result.items.filter((item) => !item.ok);
      const applied = new Set(result.items.filter((item) => item.ok).map((item) => item.item_id));
      notePending(rows.filter((r) => r.item_id && applied.has(r.item_id) && (action === "unhide") === (r.status === "hidden")),
        action === "unhide" ? 1 : -1);
      if (result.error) onMutationError(result);
      for (const item of failures) onMutationError(item);
      if (failures.length) {
        const reasons = [...new Set(failures.map((item) => item.error ?? "failed"))].join(", ");
        setNotice(`${result.applied} applied, ${result.failed} failed — ${reasons}. List refreshed.`);
      } else if (result.ok) {
        setNotice(null);
      }
    } catch {
      onMutationError({ ok: false, error: "db_error" });
    } finally {
      setPendingGroupId(null);
      void invalidate();
    }
  };

  const queryKey = useMemo(() => ["session-nav", "list", scopeKey, query], [scopeKey, query]);

  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      if (!resolvedScopeKey) return { items: [], context: undefined };
      const result = await listRpc({ scope_key: scopeKey, query: query || undefined });
      if (!result.ok) {
        if (result.error === "db_error") setDbErrorOpen(true);
        throw new Error(result.error ?? "list_failed");
      }
      return { items: result.items, context: result.context };
    },
    enabled: !!resolvedScopeKey,
    refetchInterval: isMutating ? 400 : 4000,
  });

  // Same source as Paseo's own context meter (the `K` figure), for every provider.
  const usageQuery = useQuery({
    queryKey: ["paseo-agent-usage", agentId],
    queryFn: async () => {
      if (!agentId || !paseo?.agents) return null;
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      return handle.lastUsage ?? null;
    },
    refetchInterval: 5000,
  });

  const historyQueryOptions = {
    queryKey: ["paseo-agent-timeline-history", agentId],
    queryFn: () => readTimelineHistory(paseo.agents.ref(agentId).timeline),
    staleTime: 5000,
  };

  const fallbackTimelineQuery = useQuery({
    queryKey: ["paseo-agent-timeline", agentId],
    queryFn: async () => {
      if (!agentId || !paseo?.agents) return [];
      try {
        const { entries } = await queryClient.fetchQuery(historyQueryOptions);
        const result: Row[] = [];

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const item = entry?.item;
          if (!item) continue;
          const itemType = typeof item.type === "string" ? item.type : "";
          const rawMsgId =
            typeof item.messageId === "string" && item.messageId.length > 0
              ? item.messageId
              : typeof item.clientMessageId === "string" && item.clientMessageId.length > 0
                ? item.clientMessageId
                : typeof item.id === "string" && item.id.length > 0
                  ? item.id
                  : null;

          if (itemType === "user_message") {
            const text = typeof item.text === "string" ? item.text : "";
            result.push({
              item_id: rawMsgId ?? `user-${entry?.seqStart ?? i}`,
              tool_call_id: rawMsgId ?? "",
              kind: "user",
              tool_name: "user",
              status: "visible",
              version: 1,
              tokens_display: "—",
              bytes_size: text.length,
              summary_line: text,
            });
          } else if (itemType === "assistant_message") {
            const text = typeof item.text === "string" ? item.text : "";
            result.push({
              item_id: rawMsgId ?? `ast-${entry?.seqStart ?? i}`,
              tool_call_id: rawMsgId ?? "",
              kind: "assistant",
              tool_name: "assistant",
              status: "visible",
              version: 1,
              tokens_display: "—",
              bytes_size: text.length,
              summary_line: text,
            });
          } else if (
            itemType === "tool_call" ||
            itemType === "command" ||
            itemType === "terminal" ||
            itemType === "bash" ||
            itemType === "shell"
          ) {
            // Issue 7 & 8: Comprehensive command / tool call extraction with full Paseo ToolCallDetail union
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

            // Tool name resolution
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

            // Summary resolution with rich I/O
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

            // Comprehensive output / result payload size calculation
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
                  // ignore
                }
              }
            }

            const totalBytes = summary.length + (resultLen > 0 ? resultLen : 0);
            const callId =
              typeof item.callId === "string" && item.callId.length > 0
                ? item.callId
                : typeof detail.call_id === "string"
                  ? detail.call_id
                  : `tool-${entry?.seqStart ?? i}`;

            result.push({
              item_id: callId,
              tool_call_id: callId,
              kind: "tool",
              tool_name: toolName,
              status: "visible",
              version: 1,
              tokens_display: "—",
              bytes_size: totalBytes,
              summary_line: summary,
              ...fallbackToolPreview(item, detail),
            });
          }
        }
        return result;
      } catch {
        return [];
      }
    },
    enabled: !resolvedScopeKey && !!agentId,
    refetchInterval: 3000,
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
  }, [scopeKey, queryClient]);

  const rawRows = resolvedScopeKey ? (listQuery.data?.items ?? []) : (fallbackTimelineQuery.data ?? []);
  const rows = useMemo(() => {
    if (!query) return rawRows;
    const q = query.toLowerCase();
    return rawRows.filter(
      (r) =>
        (r.tool_name && r.tool_name.toLowerCase().includes(q)) ||
        (r.summary_line && r.summary_line.toLowerCase().includes(q)) ||
        (r.tool_call_id && r.tool_call_id.toLowerCase().includes(q)),
    );
  }, [rawRows, query]);

  const groupedRows = useMemo(
    () => buildGroupedRows(rows, expandedGroups, lastActionByItem),
    [rows, expandedGroups, lastActionByItem],
  );

  const hiddenCount = rows.filter((r) => r.status === "hidden").length;

  const totalBytes = useMemo(() => rows.reduce((sum, r) => sum + (r.bytes_size ?? 0), 0), [rows]);
  const visibleBytes = useMemo(
    () => rows.filter((r) => r.status !== "hidden").reduce((sum, r) => sum + (r.bytes_size ?? 0), 0),
    [rows],
  );
  const savedBytes = Math.max(0, totalBytes - visibleBytes);
  const hiddenRows = rows.filter((r) => r.status === "hidden");
  const savedTokens =
    hiddenRows.length > 0 && hiddenRows.every((r) => typeof r.tokens === "number")
      ? hiddenRows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
      : null;
  const sessionContext = useMemo(() => {
    const usage = usageQuery.data;
    if (usage?.contextWindowUsedTokens) {
      return { used: usage.contextWindowUsedTokens, max: usage.contextWindowMaxTokens ?? null };
    }
    const fromLog = listQuery.data?.context;
    if (fromLog?.used_tokens) return { used: fromLog.used_tokens, max: fromLog.max_tokens ?? null };
    return null;
  }, [usageQuery.data, listQuery.data]);
  const pendingDelta = pendingEstimate && pendingEstimate.used === sessionContext?.used ? pendingEstimate.tokens : 0;
  const activeRatio = sessionContext?.max
    ? Math.min(1, Math.max(0, sessionContext.used / sessionContext.max))
    : 0;

  const selectedRow = useMemo(() => {
    if (!selectedId) return rows[0] ?? null;
    return rows.find((r) => (r.item_id ?? r.tool_call_id) === selectedId) ?? rows[0] ?? null;
  }, [rows, selectedId]);

  const styles = useMemo(() => {
    const pad = layout.compact ? 6 : 10;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0, minWidth: 0, overflow: "hidden" as const },
      // 1. Outline Header (Responsive, clean, no manage button)
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: pad,
        paddingVertical: layout.compact ? 6 : 8,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        minWidth: 0,
        overflow: "hidden" as const,
      },
      headerLeft: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        flex: 1,
        minWidth: 0,
        overflow: "hidden" as const,
      },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: layout.compact ? 12 : 13,
        fontWeight: "700" as const,
        flexShrink: 0,
      },
      headerAgent: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 11 : 12,
        flex: 1,
        minWidth: 0,
      },
      headerRight: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: layout.compact ? 4 : 6,
        flexShrink: 0,
      },
      iconBtn: {
        paddingHorizontal: layout.compact ? 5 : 6,
        paddingVertical: layout.compact ? 2 : 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      iconBtnActive: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent + "18",
      },
      iconBtnText: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 10 : 11,
        fontWeight: "700" as const,
      },
      iconBtnTextActive: {
        color: theme.colors.accent,
      },
      searchBar: {
        paddingHorizontal: pad,
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1 + "33",
      },
      searchInput: {
        height: layout.compact ? 24 : 26,
        borderRadius: 4,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: 8,
        color: theme.colors.foreground,
        fontSize: layout.compact ? 10 : 11,
      },

      noticeBar: {
        flexShrink: 0,
        paddingHorizontal: pad,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface1,
      },
      noticeText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 11,
        paddingHorizontal: pad,
        paddingVertical: 4,
      },

      // 2. Main Outline Timeline List (Harden flex layout against narrow widths)
      list: {
        flex: 1,
      },
      rowItem: {
        paddingVertical: layout.compact ? 5 : 6,
        paddingHorizontal: pad,
        borderBottomWidth: 1,
        borderColor: theme.colors.border + "33",
        borderLeftWidth: 3,
        borderLeftColor: "transparent",
      },
      rowItemSelected: {
        borderLeftColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1 + "66",
      },
      rowItemHidden: {
        opacity: 0.65,
      },
      groupRowItem: {
        backgroundColor: theme.colors.surface0,
      },
      childRowItem: {
        paddingLeft: pad + (layout.compact ? 12 : 16),
        backgroundColor: theme.colors.surface1 + "18",
      },
      expandToggleBtn: {
        width: 14,
        height: 14,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        marginRight: 2,
      },
      expandToggleText: {
        fontSize: layout.compact ? 10 : 11,
        color: theme.colors.foregroundMuted,
        fontWeight: "700" as const,
      },
      mixedBadge: {
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 3,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      mixedBadgeText: {
        fontSize: 9,
        color: theme.colors.foregroundMuted,
      },
      rowMainLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
        minWidth: 0,
        overflow: "hidden" as const,
      },
      rowLeftWrap: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: layout.compact ? 4 : 6,
        flex: 1,
        minWidth: 0,
        overflow: "hidden" as const,
      },
      rowRightWrap: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: layout.compact ? 4 : 6,
        flexShrink: 0,
        marginLeft: "auto" as const,
      },
      itemIcon: {
        fontSize: layout.compact ? 9 : 10,
        color: theme.colors.accent,
        flexShrink: 0,
      },
      toolNameText: {
        fontSize: layout.compact ? 11 : 12,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
        flexShrink: 1,
        minWidth: 0,
      },
      callIdText: {
        fontSize: layout.compact ? 9 : 10,
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: layout.compact ? 56 : 84,
      },
      rightMetricsText: {
        fontSize: layout.compact ? 10 : 11,
        fontVariant: ["tabular-nums" as const],
        color: theme.colors.foregroundMuted,
        textAlign: "right" as const,
        flexShrink: 0,
      },
      rightMetricsHidden: {
        textDecorationLine: "line-through" as const,
        color: theme.colors.foregroundMuted,
      },

      // Inline Action Icon Buttons (AI FDE style)
      actionsContainer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: layout.compact ? 2 : 4,
        flexShrink: 0,
      },
      inlineIconBtn: {
        width: layout.compact ? 20 : 22,
        height: layout.compact ? 20 : 22,
        borderRadius: 4,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      inlineIconBtnSlashed: {
        width: layout.compact ? 20 : 22,
        height: layout.compact ? 20 : 22,
        borderRadius: 4,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface1,
      },

      // Sub-tree row for summary
      treeLineContainer: {
        borderLeftWidth: 1.5,
        borderLeftColor: theme.colors.border,
        marginLeft: layout.compact ? 2 : 4,
        paddingLeft: layout.compact ? 6 : 8,
        marginTop: 3,
        paddingBottom: 2,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
        minWidth: 0,
        overflow: "hidden" as const,
      },
      summarySnippet: {
        fontSize: layout.compact ? 10 : 11,
        color: theme.colors.foregroundMuted,
        flex: 1,
        minWidth: 0,
      },
      summaryHiddenSnippet: {
        fontSize: layout.compact ? 9 : 10,
        fontStyle: "italic" as const,
        color: theme.colors.foregroundMuted,
        flex: 1,
        minWidth: 0,
      },

      emptyText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        paddingVertical: 24,
        textAlign: "center" as const,
      },

      // 3. Context Usage Gauge Bar
      usageFooter: {
        paddingHorizontal: pad,
        paddingVertical: layout.compact ? 5 : 6,
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        gap: 4,
      },
      gaugeTrack: {
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
      },
      gaugeFill: {
        height: "100%" as const,
        backgroundColor: theme.colors.accent,
        borderRadius: 2,
      },
      usageLabelRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 4,
        minWidth: 0,
      },
      usageLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 9 : 10,
        fontVariant: ["tabular-nums" as const],
        flexShrink: 1,
      },

      // 4. Preview Drawer (Read-only inspector; actions unified inline on rows)
      previewDrawer: {
        borderTopWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      previewHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 6,
        paddingHorizontal: pad,
        paddingVertical: layout.compact ? 4 : 6,
        backgroundColor: theme.colors.surface1 + "44",
        minWidth: 0,
      },
      previewHeaderTitle: {
        fontSize: layout.compact ? 10 : 11,
        fontWeight: "600" as const,
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        minWidth: 0,
      },
      previewHeaderSub: {
        fontSize: layout.compact ? 9 : 10,
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
      },
      previewBody: {
        paddingHorizontal: pad,
        paddingVertical: 8,
        gap: 6,
        maxHeight: 180,
      },
      previewCodeBox: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: 8,
        maxHeight: 110,
      },
      previewCodeText: {
        fontFamily: "monospace",
        fontSize: 11,
        color: theme.colors.foreground,
        lineHeight: 15,
      },
      previewMetaLine: {
        fontSize: 10,
        color: theme.colors.foregroundMuted,
      },
      actionBtnPrimary: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        backgroundColor: theme.colors.accent,
      },
      actionBtnPrimaryText: {
        color: theme.colors.accentForeground,
        fontSize: 11,
        fontWeight: "600" as const,
      },
      actionBtnSecondary: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionBtnSecondaryText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },

      // Overlays
      overlayContainer: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        zIndex: 20,
        padding: pad,
      },
      backdrop: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.72)",
        zIndex: 10,
      },
      modalCard: {
        padding: 16,
        borderRadius: 10,
        backgroundColor: theme.colors.surface0,
        gap: 10,
        width: "92%" as const,
        maxHeight: "80%" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
        zIndex: 25,
      },
    };
  }, [theme, layout.compact]);

  const handleRowPress = (row: Row) => {
    const rowKey = row.item_id ?? row.tool_call_id;
    setSelectedId(rowKey);
    void scrollToMessageInChat(row, rawRows, {
      onStart: () => setNotice((current) => current === "Not loaded in chat" ? null : current),
      onNotFound: () => setNotice("Not loaded in chat"),
      getHistory: () => queryClient.fetchQuery(historyQueryOptions),
    });
  };

  // Prompts and responses can only be hidden (removed from the outgoing context), never summarized.
  const renderMessageHideToggle = (row: Row) => {
    if (!resolvedScopeKey || !row.item_id?.startsWith("msg:")) return null;
    const hidden = row.status === "hidden";
    const iconSize = layout.compact ? 13 : 14;
    return (
      <View style={styles.actionsContainer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? "Unhide message" : "Hide message"}
          style={hidden ? styles.inlineIconBtnSlashed : styles.inlineIconBtn}
          onPress={(e) => {
            e.stopPropagation();
            if (hidden) unhideMutation.mutate(row);
            else hideMutation.mutate({ row, mode: "hide" });
          }}
        >
          <ActionSvgIcon kind="hide" slashed={hidden} size={iconSize} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    );
  };

  const renderMessageSnippet = (row: Row, empty: string) =>
    row.status === "hidden" ? (
      <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
        {`[hidden] ${(row.summary_line || "").split("\n")[0] || "tap icon to restore"}`}
      </Text>
    ) : (
      <Text style={styles.summarySnippet} numberOfLines={2}>
        {row.summary_line || empty}
      </Text>
    );

  const renderRow = (row: Row) => {
    const rowKey = row.item_id ?? row.tool_call_id;
    const isSelected = (selectedRow?.item_id ?? selectedRow?.tool_call_id) === rowKey;
    const isHidden = row.status === "hidden";
    const kind =
      row.kind ?? (row.tool_name === "user" ? "user" : row.tool_name === "assistant" ? "assistant" : "tool");

    if (kind === "user") {
      return (
        <Pressable
          key={rowKey}
          accessibilityRole="button"
          accessibilityLabel="User prompt"
          style={[styles.rowItem, isSelected ? styles.rowItemSelected : null]}
          onPress={() => handleRowPress(row)}
        >
          <View style={styles.rowMainLine}>
            <View style={styles.rowLeftWrap}>
              <Text style={{ fontSize: 11, color: theme.colors.accent, flexShrink: 0 }}>◈</Text>
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 }}>
                User
              </Text>
            </View>
            <View style={styles.rowRightWrap}>
              {renderMessageHideToggle(row)}
              <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>{rowMetric(row)}</Text>
            </View>
          </View>
          <View style={styles.treeLineContainer}>
            {renderMessageSnippet(row, "(empty prompt)")}
          </View>
        </Pressable>
      );
    }

    if (kind === "assistant") {
      return (
        <Pressable
          key={rowKey}
          accessibilityRole="button"
          accessibilityLabel="Assistant response"
          style={[styles.rowItem, isSelected ? styles.rowItemSelected : null]}
          onPress={() => handleRowPress(row)}
        >
          <View style={styles.rowMainLine}>
            <View style={styles.rowLeftWrap}>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted, flexShrink: 0 }}>✦</Text>
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 }}>
                Assistant
              </Text>
            </View>
            <View style={styles.rowRightWrap}>
              {renderMessageHideToggle(row)}
              <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>{rowMetric(row)}</Text>
            </View>
          </View>
          <View style={styles.treeLineContainer}>
            {renderMessageSnippet(row, "(empty response)")}
          </View>
        </Pressable>
      );
    }

    const shortCallId =
      row.tool_call_id.length > 12
        ? `${row.tool_call_id.slice(0, 4)}…${row.tool_call_id.slice(-4)}`
        : row.tool_call_id;

    const metricText =
      rowMetric(row);

    const firstSummaryLine = (row.summary_line || "").split("\n")[0] || "";
    const summarized = isSummarizedRow(row, lastActionByItem[rowKey]);
    const iconSize = layout.compact ? 13 : 14;

    return (
      <Pressable
        key={rowKey}
        accessibilityRole="button"
        accessibilityLabel={`Select row ${row.tool_call_id}`}
        style={[
          styles.rowItem,
          isSelected ? styles.rowItemSelected : null,
          isHidden ? styles.rowItemHidden : null,
        ]}
        onPress={() => handleRowPress(row)}
      >
        <View style={styles.rowMainLine}>
          <View style={styles.rowLeftWrap}>
            <Text style={[styles.itemIcon, isHidden ? { color: theme.colors.foregroundMuted } : null]}>
              {isHidden ? "⊘" : "◇"}
            </Text>
            <Text
              style={[
                styles.toolNameText,
                isHidden ? { textDecorationLine: "line-through", color: theme.colors.foregroundMuted } : null,
              ]}
              numberOfLines={1}
            >
              {row.tool_name ?? "tool"}
            </Text>
            {shortCallId ? (
              <Text style={styles.callIdText} numberOfLines={1}>
                {shortCallId}
              </Text>
            ) : null}
          </View>

          {/* Right inline slot: [Hide/Summarize Icons] + [Bytes/Tokens] */}
          <View style={styles.rowRightWrap}>
            {resolvedScopeKey && row.manageable !== false ? (
              <View style={styles.actionsContainer}>
                {isHidden ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unhide ${row.tool_call_id}`}
                    style={styles.inlineIconBtnSlashed}
                    onPress={(e) => {
                      e.stopPropagation();
                      unhideMutation.mutate(row);
                    }}
                  >
                    <ActionSvgIcon
                      kind={summarized ? "summarize" : "hide"}
                      slashed={true}
                      size={iconSize}
                      color={theme.colors.foregroundMuted}
                    />
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Hide ${row.tool_call_id}`}
                      style={styles.inlineIconBtn}
                      onPress={(e) => {
                        e.stopPropagation();
                        hideMutation.mutate({ row, mode: "hide" });
                      }}
                    >
                      <ActionSvgIcon
                        kind="hide"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Summarize ${row.tool_call_id}`}
                      style={styles.inlineIconBtn}
                      onPress={(e) => {
                        e.stopPropagation();
                        hideMutation.mutate({ row, mode: "summarize" });
                      }}
                    >
                      <ActionSvgIcon
                        kind="summarize"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                  </>
                )}
              </View>
            ) : null}
            <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>
              {metricText}
            </Text>
          </View>
        </View>

        <View style={styles.treeLineContainer}>
          {isHidden ? (
            <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
              {summarized
                ? `[summarized] ${firstSummaryLine || "tap slashed icon to restore"}`
                : `[hidden] ${firstSummaryLine || "tap slashed icon to restore"}`}
            </Text>
          ) : (
            <Text style={styles.summarySnippet} numberOfLines={1}>
              {firstSummaryLine || "(no summary)"}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  const renderGroupRow = (group: OutlineRow & { type: "group" }) => {
    const eyeAction = groupEyeAction(group);
    const isExpanded = !!expandedGroups[group.groupId];
    const isPending = pendingGroupId === group.groupId;
    const isSelected =
      selectedRow &&
      group.children.some(
        (c) => (c.item_id ?? c.tool_call_id) === (selectedRow.item_id ?? selectedRow.tool_call_id),
      );
    const iconSize = layout.compact ? 13 : 14;

    return (
      <Pressable
        key={group.key}
        accessibilityRole="button"
        accessibilityLabel={`Tool group: ${group.title}`}
        style={[
          styles.rowItem,
          styles.groupRowItem,
          isSelected ? styles.rowItemSelected : null,
          group.allHidden ? styles.rowItemHidden : null,
        ]}
        onPress={() => {
          setExpandedGroups((prev) => ({ ...prev, [group.groupId]: !isExpanded }));
          if (group.children.length > 0) {
            handleRowPress(group.children[0]);
          }
        }}
      >
        <View style={styles.rowMainLine}>
          <View style={styles.rowLeftWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isExpanded ? "Collapse group" : "Expand group"}
              style={styles.expandToggleBtn}
              hitSlop={8}
              onPress={(e) => {
                e.stopPropagation();
                setExpandedGroups((prev) => ({ ...prev, [group.groupId]: !isExpanded }));
              }}
            >
              <Text style={styles.expandToggleText}>{isExpanded ? "▾" : "▸"}</Text>
            </Pressable>

            <Text style={[styles.itemIcon, group.allHidden ? { color: theme.colors.foregroundMuted } : null]}>
              {group.allHidden ? "⊘" : "⚡"}
            </Text>

            <Text
              style={[
                styles.toolNameText,
                group.allHidden ? { textDecorationLine: "line-through", color: theme.colors.foregroundMuted } : null,
              ]}
              numberOfLines={1}
            >
              {group.title}
            </Text>

            {group.mixed ? (
              <View style={styles.mixedBadge}>
                <Text style={styles.mixedBadgeText}>
                  {group.hiddenCount}/{group.children.length} hidden
                </Text>
              </View>
            ) : null}
          </View>

          {/* Right inline slot: [Group Hide/Summarize Action Icons] + [Total Bytes] */}
          <View style={styles.rowRightWrap}>
            {resolvedScopeKey ? (
              <View style={[styles.actionsContainer, isPending ? { opacity: 0.5 } : null]}>
                {group.allHidden ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unhide all in ${group.groupId}`}
                    style={styles.inlineIconBtnSlashed}
                    disabled={isPending}
                    onPress={(e) => {
                      e.stopPropagation();
                      void runGroupBatch(group, "unhide");
                    }}
                  >
                    <ActionSvgIcon
                      kind={group.allSummarized ? "summarize" : "hide"}
                      slashed={true}
                      size={iconSize}
                      color={theme.colors.foregroundMuted}
                    />
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${eyeAction === "unhide" ? "Unhide hidden" : "Hide all"} in ${group.groupId}`}
                      style={eyeAction === "unhide" ? styles.inlineIconBtnSlashed : styles.inlineIconBtn}
                      disabled={isPending}
                      onPress={(e) => {
                        e.stopPropagation();
                        void runGroupBatch(group, eyeAction);
                      }}
                    >
                      <ActionSvgIcon
                        kind="hide"
                        slashed={eyeAction === "unhide"}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Summarize all in ${group.groupId}`}
                      style={styles.inlineIconBtn}
                      disabled={isPending}
                      onPress={(e) => {
                        e.stopPropagation();
                        void runGroupBatch(group, "summarize");
                      }}
                    >
                      <ActionSvgIcon
                        kind="summarize"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                  </>
                )}
              </View>
            ) : null}

            <Text style={[styles.rightMetricsText, group.allHidden ? styles.rightMetricsHidden : null]}>
              {group.totalTokens != null ? fmtTokens(group.totalTokens) : fmtBytes(group.totalBytes)}
            </Text>
          </View>
        </View>

        <View style={styles.treeLineContainer}>
          <Text style={group.allHidden ? styles.summaryHiddenSnippet : styles.summarySnippet} numberOfLines={1}>
            {group.allHidden
              ? `[all ${group.allSummarized ? "summarized" : "hidden"}] tap slashed icon to restore (${group.subTitle})`
              : group.subTitle || "tools"}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderChildRow = (child: OutlineRow & { type: "child" }) => {
    const row = child.row;
    const rowKey = row.item_id ?? row.tool_call_id;
    const isSelected = (selectedRow?.item_id ?? selectedRow?.tool_call_id) === rowKey;
    const isHidden = row.status === "hidden";
    const shortCallId =
      row.tool_call_id.length > 12
        ? `${row.tool_call_id.slice(0, 4)}…${row.tool_call_id.slice(-4)}`
        : row.tool_call_id;
    const metricText =
      rowMetric(row);
    const firstSummaryLine = (row.summary_line || "").split("\n")[0] || "";
    const summarized = isSummarizedRow(row, lastActionByItem[rowKey]);
    const iconSize = layout.compact ? 12 : 13;

    return (
      <Pressable
        key={child.key}
        accessibilityRole="button"
        accessibilityLabel={`Select tool ${row.tool_call_id}`}
        style={[
          styles.rowItem,
          styles.childRowItem,
          isSelected ? styles.rowItemSelected : null,
          isHidden ? styles.rowItemHidden : null,
        ]}
        onPress={() => handleRowPress(row)}
      >
        <View style={styles.rowMainLine}>
          <View style={styles.rowLeftWrap}>
            <Text
              style={[
                styles.itemIcon,
                isHidden ? { color: theme.colors.foregroundMuted } : null,
                { fontSize: 9 },
              ]}
            >
              {isHidden ? "⊘" : "↳"}
            </Text>
            <Text
              style={[
                styles.toolNameText,
                { fontSize: layout.compact ? 10 : 11 },
                isHidden ? { textDecorationLine: "line-through", color: theme.colors.foregroundMuted } : null,
              ]}
              numberOfLines={1}
            >
              {row.tool_name ?? "tool"}
            </Text>
            {shortCallId ? (
              <Text style={styles.callIdText} numberOfLines={1}>
                {shortCallId}
              </Text>
            ) : null}
          </View>

          <View style={styles.rowRightWrap}>
            {resolvedScopeKey && row.manageable !== false ? (
              <View style={styles.actionsContainer}>
                {isHidden ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Unhide ${row.tool_call_id}`}
                    style={styles.inlineIconBtnSlashed}
                    onPress={(e) => {
                      e.stopPropagation();
                      unhideMutation.mutate(row);
                    }}
                  >
                    <ActionSvgIcon
                      kind={summarized ? "summarize" : "hide"}
                      slashed={true}
                      size={iconSize}
                      color={theme.colors.foregroundMuted}
                    />
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Hide ${row.tool_call_id}`}
                      style={styles.inlineIconBtn}
                      onPress={(e) => {
                        e.stopPropagation();
                        hideMutation.mutate({ row, mode: "hide" });
                      }}
                    >
                      <ActionSvgIcon
                        kind="hide"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Summarize ${row.tool_call_id}`}
                      style={styles.inlineIconBtn}
                      onPress={(e) => {
                        e.stopPropagation();
                        hideMutation.mutate({ row, mode: "summarize" });
                      }}
                    >
                      <ActionSvgIcon
                        kind="summarize"
                        slashed={false}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                  </>
                )}
              </View>
            ) : null}
            <Text style={[styles.rightMetricsText, isHidden ? styles.rightMetricsHidden : null]}>
              {metricText}
            </Text>
          </View>
        </View>

        <View style={[styles.treeLineContainer, { marginLeft: layout.compact ? 8 : 12 }]}>
          {isHidden ? (
            <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
              {summarized
                ? `[summarized] ${firstSummaryLine || "tap icon to restore"}`
                : `[hidden] ${firstSummaryLine || "tap icon to restore"}`}
            </Text>
          ) : (
            <Text style={styles.summarySnippet} numberOfLines={1}>
              {firstSummaryLine || "(no summary)"}
            </Text>
          )}
        </View>
      </Pressable>
    );
  };

  const isLoading = resolvedScopeKey ? listQuery.isPending : fallbackTimelineQuery.isPending;
  const noticeBar = notice ? (
    <View accessibilityRole="alert" style={styles.noticeBar}>
      <Text style={styles.noticeText}>{notice}</Text>
    </View>
  ) : null;

  if (followVisible && !inView) {
    return (
      <View style={styles.screen}>
        {noticeBar}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Outline</Text>
          </View>
        </View>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted, fontWeight: "600" }}>
            No session in view
          </Text>
          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "center", lineHeight: 16 }}>
            Open a session to see its outline. The outline follows the session shown in the chat.
          </Text>
          {navigation && params.agentId ? (
            <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: params.agentId })}>
              <Text style={{ fontSize: 11, color: theme.colors.foreground, textDecorationLine: "underline" }}>
                Open this panel's session
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  if (!isLoading && rows.length === 0) {
    return (
      <View style={styles.screen}>
        {noticeBar}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Outline</Text>
            <Text style={styles.headerAgent} numberOfLines={1}>
              · {agent?.title ?? agentId.slice(0, 8)}
            </Text>
          </View>
        </View>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted, fontWeight: "600" }}>
            No active session
          </Text>
          <Text
            style={{ fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "center", lineHeight: 16 }}
          >
            This agent has not started a session or has no recorded activity yet.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* 1. Header: Clean title, search toggle, popout */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Outline</Text>
          <Text style={styles.headerAgent} numberOfLines={1}>
            · {agent?.title ?? agentId.slice(0, 8)}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Toggle filter search"
            style={[styles.iconBtn, searchOpen || !!tabState.query ? styles.iconBtnActive : null]}
            onPress={() => {
              if (searchOpen && tabState.query) {
                setTabState({ ...tabState, query: "" });
              }
              setSearchOpen(!searchOpen);
            }}
          >
            <Text style={[styles.iconBtnText, searchOpen || !!tabState.query ? styles.iconBtnTextActive : null]}>
              {searchOpen ? "✕" : "🔍"}
            </Text>
          </Pressable>
          {navigation ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open agent chat"
              style={styles.iconBtn}
              onPress={() => navigation?.openAgent({ agentId })}
            >
              <Text style={styles.iconBtnText}>⤢</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Search Input when searchOpen */}
      {searchOpen ? (
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="Filter outline items…"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={tabState.query}
            onChangeText={(text) => setTabState({ ...tabState, query: text })}
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}

      {noticeBar}
      {listQuery.isError ? <Text style={styles.errorText}>List failed — retrying.</Text> : null}

      {/* 2. Main Timeline Tree List */}
      <FlatList
        style={styles.list}
        data={groupedRows}
        keyExtractor={(item) => item.key}
        extraData={{ expandedGroups, lastActionByItem, pendingGroupId, selectedId }}
        ListEmptyComponent={
          listQuery.isPending ? (
            <Text style={styles.emptyText}>Loading outline…</Text>
          ) : (
            <Text style={styles.emptyText}>No activity recorded in this session yet.</Text>
          )
        }
        renderItem={({ item }) => {
          if (item.type === "group") return renderGroupRow(item);
          if (item.type === "child") return renderChildRow(item);
          return renderRow(item.row);
        }}
      />

      {/* 3. Context Window Gauge Bar */}
      <View style={styles.usageFooter}>
        <View style={styles.gaugeTrack}>
          <View style={[styles.gaugeFill, { width: `${Math.round(activeRatio * 100)}%` }]} />
        </View>
        <View style={styles.usageLabelRow}>
          <Text style={styles.usageLabel} numberOfLines={1}>
            {sessionContext
              ? `context ${fmtTokenCount(sessionContext.used)}${
                  sessionContext.max ? ` / ${fmtTokenCount(sessionContext.max)}` : ""
                } tokens${
                  sessionContext.max ? ` (${(activeRatio * 100).toFixed(layout.compact ? 0 : 1)}%)` : ""
                }${pendingDelta ? ` · next ≈ ${pendingDelta < 0 ? "−" : "+"}${fmtTokenCount(Math.abs(pendingDelta))}` : ""}`
              : "context — tokens"}
          </Text>
          <Text style={[styles.usageLabel, { textAlign: "right" }]} numberOfLines={1}>
            {hiddenCount > 0 ? `${hiddenCount} hidden · saved ${savedTokens != null ? fmtTokens(savedTokens) : fmtBytes(savedBytes)}` : `${rows.length} entries`}
          </Text>
        </View>
      </View>

      {/* 4. Bottom Preview Drawer (Read-only payload/metadata inspector) */}
      <View style={styles.previewDrawer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle preview drawer"
          style={styles.previewHeader}
          onPress={() => setPreviewOpen(!previewOpen)}
        >
          <Text style={styles.previewHeaderTitle} numberOfLines={1}>
            Preview {previewOpen ? "︾" : "︽"}
            {selectedRow
              ? ` · ${selectedRow.tool_name ?? "item"} (${selectedRow.tool_call_id ? selectedRow.tool_call_id.slice(0, 10) : selectedRow.item_id?.slice(0, 10)})`
              : ""}
          </Text>
          {selectedRow ? (
            <Text style={styles.previewHeaderSub}>
              {selectedRow.status} · {fmtBytes(selectedRow.bytes_size)}
            </Text>
          ) : null}
        </Pressable>

        {previewOpen && selectedRow ? (
          <View style={styles.previewBody}>
            <ScrollView style={styles.previewCodeBox}>
              {selectedRow.tool_input !== undefined || selectedRow.tool_output !== undefined ? (
                <>
                  <Text style={styles.previewMetaLine}>
                    {selectedRow.status === "hidden" ? "Input (original)" : "Input"}
                  </Text>
                  <Text style={styles.previewCodeText}>{selectedRow.tool_input ?? "(input unavailable)"}</Text>
                  <Text style={styles.previewMetaLine}>
                    {selectedRow.status === "hidden" ? "Output (original, hidden from model)" : "Output (original)"}
                  </Text>
                  <Text style={styles.previewCodeText}>{selectedRow.tool_output ?? "(output unavailable)"}</Text>
                </>
              ) : (
                <Text style={styles.previewCodeText}>
                  {selectedRow.summary_line || "(no details available)"}
                </Text>
              )}
            </ScrollView>
            <Text style={styles.previewMetaLine}>
              ID: {selectedRow.item_id ?? "none"} · {selectedRow.source ?? "timeline"} · v{selectedRow.version}
              {selectedRow.tokens_display && selectedRow.tokens_display !== "—"
                ? ` · ${selectedRow.tokens_display}`
                : ""}
            </Text>
          </View>
        ) : null}
      </View>

      {/* DB Error Overlay */}
      {dbErrorOpen ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss database error dialog"
            style={styles.backdrop}
            onPress={() => setDbErrorOpen(false)}
          />
          <View style={styles.overlayContainer} pointerEvents="box-none">
            <View style={styles.modalCard}>
              <Text style={styles.headerTitle}>Database error</Text>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                Choose how to proceed.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Abort request"
                style={styles.actionBtnPrimary}
                onPress={async () => {
                  await dbChoice({ scope_key: scopeKey, choice: "abort_request" });
                  setNotice("DB error: aborted.");
                  setDbErrorOpen(false);
                }}
              >
                <Text style={styles.actionBtnPrimaryText}>Abort request</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send original"
                style={styles.actionBtnSecondary}
                onPress={async () => {
                  await dbChoice({ scope_key: scopeKey, choice: "send_original" });
                  setNotice("DB error: showing originals once.");
                  setDbErrorOpen(false);
                  void invalidate();
                }}
              >
                <Text style={styles.actionBtnSecondaryText}>Send original</Text>
              </Pressable>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}
