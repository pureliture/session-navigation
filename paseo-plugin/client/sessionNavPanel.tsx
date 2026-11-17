import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon, ScrollView as UiScrollView, TextInput as UiTextInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView as RnScrollView, Text, TextInput as RnTextInput, View } from "react-native";
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
import { cancelChatNavigation, scrollToMessageInChat, visibleChatValues } from "./chatNavigation";
import { fallbackToolPreview } from "./toolPreview";
import { PreviewDrawer } from "./PreviewDrawer";
import { readTimelineHistory } from "./timelineHistory";
import { actionAllowed, capabilityNotice, type Capabilities } from "./capabilities";
import { focusedSessionTab, openProviderSubagent, readHostFocus, readWebWorkspaceFocusedTab, subscribeHostFocus, type SessionTab } from "./hostCompat";
import { childrenForCall, mergeHermesTimelineRows, mergeLinkedParentRows, resolveChildScope, scopeForAgent, subagentMainTarget, type ChildScope } from "./subagents";
import { acceptWorkspaceAgentId, hasDomDocument, readSessionTimelineIds, resolveSessionTarget, selectMainOrFallbackAgent, sessionFollowCandidates } from "./sessionFollowing";
import {
  buildGroupedRows,
  effectiveRowBytes,
  fmtBytes,
  fmtTokenCount,
  fmtTokens,
  groupBadgeText,
  groupEyeAction,
  groupMetric,
  groupMutationItems,
  groupRestoreIconKind,
  groupSubtitleText,
  hiddenRowSnippet,
  isSummarizedRow,
  messageSummarySnippet,
  rowMetric,
  truncateString,
  utf8ByteLength,
  type OutlineRow,
} from "./outlineGrouping";
import { OutlineScrollDriver } from "./outlineScroll";

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

// Vertical compression arrows squeezing a summary bar + 4-point AI star (✦)
const SUMMARIZE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 2.5v5.2"/><path d="m5.7 5.2 2.8 2.8 2.8-2.8"/><path d="M3 12h11.5"/><path d="M8.5 21.5v-5.2"/><path d="m5.7 18.8 2.8-2.8 2.8 2.8"/><path d="M18.5 2.5 19.6 5.4 22.5 6.5 19.6 7.6 18.5 10.5 17.4 7.6 14.5 6.5 17.4 5.4Z"/></svg>';

const SUMMARIZE_SLASHED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 2.5v5.2"/><path d="m5.7 5.2 2.8 2.8 2.8-2.8"/><path d="M3 12h11.5"/><path d="M8.5 21.5v-5.2"/><path d="m5.7 18.8 2.8-2.8 2.8 2.8"/><path d="M18.5 2.5 19.6 5.4 22.5 6.5 19.6 7.6 18.5 10.5 17.4 7.6 14.5 6.5 17.4 5.4Z"/><path d="m2 2 20 20"/></svg>';

const SUMMARY_QUEUED_NOTICE = "Summary queued — runs on next prompt";

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

const ScrollView = UiScrollView ?? RnScrollView;
const TextInput = UiTextInput ?? RnTextInput;

export function SessionNavPanel({ theme, layout, params, navigation, tab, followVisible = true, candidateAgentIds, childScope, ancestry = [], ...panelProps }: PluginAgentPanelProps & {
  followVisible?: boolean;
  candidateAgentIds?: readonly string[];
  childScope?: ChildScope;
  ancestry?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  // Paseo binds agent panels to the agent they were opened for; follow whichever session the chat shows instead.
  const [followedId, setFollowedId] = useState<string | null>(null);
  const [inView, setInView] = useState(!!params.agentId);
  const [followResolved, setFollowResolved] = useState(() => !followVisible || !!params.agentId);
  const [subagentFallback, setSubagentFallback] = useState(false);
  const [focusedTab, setFocusedTab] = useState<SessionTab | null>(null);
  const lastMainAgent = useRef(params.agentId || null);
  const agentId = followVisible || subagentFallback ? followedId ?? params.agentId : params.agentId;
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

  const [storedState, setStoredState] = useTabState(tab, panelTabStateSchema, DEFAULT_TAB_STATE);
  const [inlineState, setInlineState] = useState(DEFAULT_TAB_STATE);
  const tabState = childScope ? inlineState : storedState;
  const setTabState = childScope ? setInlineState : setStoredState;
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dbErrorOpen, setDbErrorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setFollowedId(null);
    setInView(!!params.agentId);
    setFollowResolved(!followVisible || !!params.agentId);
    lastMainAgent.current = params.agentId || null;
    setFocusedTab(null);
    setSubagentFallback(false);
  }, [params.agentId, followVisible]);
  useEffect(() => {
    if (notice !== "Not loaded in chat" && notice !== SUMMARY_QUEUED_NOTICE) return;
    const timer = setTimeout(() => setNotice((current) => current === notice ? null : current),
      notice === SUMMARY_QUEUED_NOTICE ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!highlightedId || previewOpen) return;
    const timer = setTimeout(() => {
      setHighlightedId((current) => (current === highlightedId ? null : current));
    }, 1500);
    return () => clearTimeout(timer);
  }, [highlightedId, previewOpen]);
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
    refetchInterval: 3000,
  });

  const scopes = scopesQuery.data ?? [];
  const hostProp: unknown = "host" in panelProps && typeof panelProps.host === "object" && panelProps.host !== null &&
    "id" in panelProps.host ? panelProps.host.id : undefined;
  const hostId = typeof hostProp === "string" ? hostProp : "";
  const workspaceProp: unknown = "workspaceId" in panelProps ? panelProps.workspaceId : undefined;
  const panelWorkspaceId = typeof workspaceProp === "string" ? workspaceProp : undefined;
  const hasDocument = hasDomDocument();

  useEffect(() => {
    const doc = "document" in globalThis ? Reflect.get(globalThis, "document") : undefined;
    if (childScope || !paseo?.agents || (!hasDocument && !hostId && !("activeAgentId" in panelProps))) return;
    let cancelled = false;
    const parentOf = (id: string) => queryClient.fetchQuery({
      queryKey: ["session-nav-parent", id],
      staleTime: 10_000,
      queryFn: async () => {
        const handle = paseo.agents.ref(id);
        await handle.refresh();
        const snapshot = handle.current();
        if (!snapshot) throw new Error("agent_not_found");
        return snapshot.labels["paseo.parent-agent-id"] ?? null;
      },
    });
    const applySelection = async (focused: SessionTab | null, values: string[] | null) => {
      const fallback = await subagentMainTarget(focused, parentOf);
      const managed = focused?.kind === "agent" && scopes.some((scope) => scope.agent_id === focused.agentId);
      const useFallback = fallback.subagent && !managed;
      const needsTimelineScan =
        followVisible && focused?.kind !== "provider_subagent" && focused?.kind !== "agent" && !useFallback;
      const resolvedTarget = needsTimelineScan
        ? await resolveSessionTarget({
            followVisible,
            boundAgentId: params.agentId,
            visibleValues: values,
            candidates: sessionFollowCandidates(
              candidateAgentIds,
              scopes.map((s) => s.agent_id).filter((id): id is string => !!id),
            ),
            timelineIds: async (id) =>
              (
                await queryClient.fetchQuery({
                  queryKey: ["session-nav-follow", id],
                  staleTime: (q) => (q.state.data?.complete ? 10_000 : 0),
                  queryFn: () => readSessionTimelineIds(paseo.agents.ref(id).timeline),
                })
              ).ids,
          })
        : followVisible
          ? null
          : params.agentId || null;
      const selection = selectMainOrFallbackAgent({
        tab: focused,
        managed: !!managed,
        fallback,
        followVisible,
        resolvedTarget,
        lastMainAgentId: lastMainAgent.current,
      });
      if (cancelled) return;
      setFocusedTab(focused);
      setSubagentFallback(selection.subagentFallback);
      setInView(selection.inView);
      if (selection.agentId) lastMainAgent.current = selection.agentId;
      setFollowedId(selection.agentId === params.agentId ? null : selection.agentId);
      setFollowResolved(true);
    };
    const tick = async () => {
      const explicitSupported = "activeAgentId" in panelProps;
      const explicitProp: unknown = explicitSupported ? panelProps.activeAgentId : undefined;
      const explicitAgentId = typeof explicitProp === "string" && explicitProp.length > 0 ? explicitProp : null;
      if (!hasDocument) {
        const hostFocus = hostId ? readHostFocus(hostId) : { supported: false, focusedAgentId: null, hasSignal: false };
        const hasSignal = explicitSupported || (hostFocus.supported && hostFocus.hasSignal);
        const targetId = explicitSupported ? explicitAgentId : hostFocus.focusedAgentId;
        if (followVisible && hasSignal) {
          if (targetId === null) {
            if (cancelled) return;
            setFocusedTab(null);
            setSubagentFallback(false);
            setInView(false);
            setFollowedId(null);
            setFollowResolved(true);
            return;
          }
          let verdict = acceptWorkspaceAgentId({ agentId: targetId, workspaceCandidateIds: candidateAgentIds, panelWorkspaceId });
          if (verdict === "unknown") {
            try {
              const handle = paseo.agents.ref(targetId);
              await handle.refresh();
              verdict = acceptWorkspaceAgentId({ agentId: targetId, workspaceCandidateIds: candidateAgentIds, agentWorkspaceId: handle.current()?.workspaceId ?? null, panelWorkspaceId });
            } catch {
              verdict = "reject";
            }
          }
          if (verdict !== "accept" || cancelled) return;
          await applySelection({ kind: "agent", agentId: targetId }, null);
          return;
        }
        if (cancelled) return;
        if (params.agentId) {
          await applySelection({ kind: "agent", agentId: params.agentId }, null);
          return;
        }
        setSubagentFallback(false);
        setInView(false);
        setFollowedId(null);
        setFollowResolved(true);
        return;
      }
      // Web: DOM tab wins; layout-state and workspace-verified heartbeat focus back up compact/empty chats.
      const readFocusedTab = (): SessionTab | null => {
        const dom = focusedSessionTab(doc, undefined, candidateAgentIds);
        const layoutTab = hostId && panelWorkspaceId ? readWebWorkspaceFocusedTab(hostId, panelWorkspaceId) : null;
        if (dom) {
          const domAgentId = dom.kind === "agent" ? dom.agentId : dom.kind === "provider_subagent" ? dom.parentAgentId : null;
          if (
            domAgentId &&
            Array.isArray(candidateAgentIds) &&
            !candidateAgentIds.includes(domAgentId) &&
            layoutTab
          ) {
            return layoutTab;
          }
          return dom;
        }
        if (layoutTab) return layoutTab;
        const candidateId = explicitSupported
          ? explicitAgentId
          : (hostId ? readHostFocus(hostId).focusedAgentId : null);
        if (!candidateId) return null;
        const verdict = acceptWorkspaceAgentId({ agentId: candidateId, workspaceCandidateIds: candidateAgentIds, panelWorkspaceId });
        return verdict === "accept" || (verdict === "unknown" && !panelWorkspaceId)
          ? { kind: "agent", agentId: candidateId }
          : null;
      };
      const focusTab = readFocusedTab();
      if (focusTab?.kind === "agent" || focusTab?.kind === "provider_subagent") {
        if (!cancelled) await applySelection(focusTab, null);
        return;
      }
      const values = visibleChatValues(doc);
      if (focusTab && (values === null || values.length === 0)) {
        if (!cancelled && JSON.stringify(readFocusedTab()) === JSON.stringify(focusTab)) {
          await applySelection(focusTab, null);
        }
        return;
      }
      if (cancelled || JSON.stringify(readFocusedTab()) !== JSON.stringify(focusTab)) return;
      await applySelection(focusTab, values);
    };
    let rafId: number | null = null;
    const scheduleTick = () => {
      if (cancelled) return;
      if (typeof requestAnimationFrame === "function") {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!cancelled) void tick();
        });
      } else {
        void tick();
      }
    };
    const unsubscribe = hostId ? subscribeHostFocus(hostId, scheduleTick) : () => {};
    let observer: { disconnect: () => void } | null = null;
    const ObserverCtor = (globalThis as Record<string, any>).MutationObserver;
    const observeRoot = (doc as any)?.body ?? (doc as any)?.documentElement;
    if (hasDocument && typeof ObserverCtor === "function" && observeRoot) {
      try {
        const instance = new ObserverCtor(scheduleTick);
        instance.observe(observeRoot, {
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-selected", "aria-hidden", "data-testid"],
        });
        observer = instance;
      } catch {
        observer = null;
      }
    }
    const win = (doc as any)?.defaultView;
    const onUiActivity = () => scheduleTick();
    if (hasDocument && typeof (doc as any)?.addEventListener === "function") {
      (doc as any).addEventListener("click", onUiActivity, true);
      (doc as any).addEventListener("keyup", onUiActivity, true);
    }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("popstate", onUiActivity);
      win.addEventListener("focus", onUiActivity);
    }
    void tick();
    const timer = hasDocument ? setInterval(() => void tick(), 1500) : undefined;
    return () => {
      cancelled = true;
      if (rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      observer?.disconnect();
      if (hasDocument && typeof (doc as any)?.removeEventListener === "function") {
        (doc as any).removeEventListener("click", onUiActivity, true);
        (doc as any).removeEventListener("keyup", onUiActivity, true);
      }
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener("popstate", onUiActivity);
        win.removeEventListener("focus", onUiActivity);
      }
      unsubscribe();
      clearInterval(timer);
    };
  }, [paseo, params.agentId, scopes, queryClient, followVisible, candidateAgentIds, childScope, hasDocument, hostId, panelWorkspaceId]);
  const parentScopeKey = scopeForAgent(scopes, agentId);

  const activeChild = childScope ?? resolveChildScope(focusedTab, parentScopeKey, scopes);
  const displayOnly = subagentFallback && !activeChild;
  const resolvedScopeKey = activeChild?.scope_key ?? parentScopeKey;
  const childLabel = activeChild?.subagent_id;

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
    onMutate: ({ row, mode }: { row: Row; mode: "hide" | "summarize" }): {
      rowKey: string;
      prevActionMode: "hide" | "summarize" | undefined;
      changed: boolean;
    } => {
      const rowKey = row.item_id ?? row.tool_call_id;
      if (displayOnly || !actionAllowed(row, capabilities, mode)) {
        return { rowKey, prevActionMode: undefined, changed: false };
      }
      const prevActionMode = lastActionByItem[rowKey];
      setLastActionByItem((prev) => ({ ...prev, [rowKey]: mode }));
      return { rowKey, prevActionMode, changed: true };
    },
    mutationFn: ({ row, mode }: { row: Row; mode: "hide" | "summarize" }) => {
      if (displayOnly || !actionAllowed(row, capabilities, mode)) return Promise.resolve({ ok: false, error: "capability_unavailable" });
      return hideRpc({
        scope_key: scopeKey,
        item_id: row.item_id ?? "",
        expected_version: row.version,
        mode,
      });
    },
    onSuccess: (r, { row, mode }, context) => {
      if (!r?.ok && context?.changed) {
        const { rowKey, prevActionMode } = context;
        setLastActionByItem((prev) => {
          const next = { ...prev };
          if (prevActionMode === undefined) delete next[rowKey];
          else next[rowKey] = prevActionMode;
          return next;
        });
      }
      if (!onMutationError(r)) {
        setNotice(mode === "summarize" ? SUMMARY_QUEUED_NOTICE : null);
        if (row.status !== "hidden") notePending([row], -1);
        void invalidate();
      }
    },
    onError: (_err, _vars, context) => {
      if (context?.changed) {
        const { rowKey, prevActionMode } = context;
        setLastActionByItem((prev) => {
          const next = { ...prev };
          if (prevActionMode === undefined) delete next[rowKey];
          else next[rowKey] = prevActionMode;
          return next;
        });
      }
    },
  });

  const unhideMutation = useMutation({
    mutationFn: (row: Row) => displayOnly ? Promise.resolve({ ok: false, error: "capability_unavailable" }) :
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
    if (displayOnly || pendingGroupId || !resolvedScopeKey) return;
    if (action !== "unhide" && !capabilities?.[action]) { setNotice(capabilityNotice(undefined, capabilities)); return; }
    const items = groupMutationItems(group, action);
    if (items.length === 0) return;
    const prevActions: Record<string, "hide" | "summarize" | undefined> = {};
    for (const item of items) {
      prevActions[item.item_id] = lastActionByItem[item.item_id];
    }
    const rollbackItems = (ids: Iterable<string>) => {
      setLastActionByItem((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const prevVal = prevActions[id];
          if (prevVal === undefined) delete next[id];
          else next[id] = prevVal;
        }
        return next;
      });
    };
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
      if (failures.length > 0 || !result.ok) {
        const failedIds = new Set<string>();
        for (const failed of failures) {
          if (failed.item_id && failed.item_id in prevActions) {
            failedIds.add(failed.item_id);
          }
        }
        if (!result.ok && failedIds.size === 0) {
          for (const item of items) failedIds.add(item.item_id);
        }
        if (failedIds.size > 0) rollbackItems(failedIds);
      }
      const applied = new Set(result.items.filter((item) => item.ok).map((item) => item.item_id));
      notePending(rows.filter((r) => r.item_id && applied.has(r.item_id) && (action === "unhide") === (r.status === "hidden")),
        action === "unhide" ? 1 : -1);
      if (result.error) onMutationError(result);
      for (const item of failures) onMutationError(item);
      if (failures.length) {
        const reasons = [...new Set(failures.map((item) => item.error ?? "failed"))].join(", ");
        setNotice(`${result.applied} applied, ${result.failed} failed — ${reasons}. List refreshed.`);
      } else if (result.ok) {
        setNotice(action === "summarize" ? SUMMARY_QUEUED_NOTICE : null);
      }
    } catch {
      rollbackItems(items.map((item) => item.item_id));
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
      if (!resolvedScopeKey) return { items: [], context: undefined, capabilities: undefined, server_timeline: false, records_capped: false };
      const result = await listRpc({ scope_key: scopeKey, query: query || undefined });
      if (!result.ok) {
        if (result.error === "db_error") setDbErrorOpen(true);
        throw new Error(result.error ?? "list_failed");
      }
      return { items: result.items, context: result.context, capabilities: result.capabilities,
        server_timeline: Boolean(result.server_timeline),
        records_capped: Boolean((result as Record<string, unknown>).records_capped) };
    },
    enabled: !!resolvedScopeKey,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[2] === scopeKey ? previousData : undefined,
    refetchInterval: isMutating ? 400 : 4000,
  });

  // Same source as Paseo's own context meter (the `K` figure), for every provider.
  const capabilities: Capabilities | undefined = displayOnly ? undefined : listQuery.data?.capabilities ?? scopes.find(scope => scope.scope_key === resolvedScopeKey)?.capabilities;
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

  const isHermesScope = Boolean(resolvedScopeKey?.startsWith("hermes:"));
  const needsLinkedTimeline = !activeChild && !!resolvedScopeKey && scopes.some((scope) => scope.parent_scope === resolvedScopeKey &&
    scope.tool_call_id && !listQuery.data?.items.some((row) => row.tool_call_id === scope.tool_call_id));
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
              bytes_size: utf8ByteLength(text),
              summary_line: messageSummarySnippet(text),
              message_text: text,
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
              bytes_size: utf8ByteLength(text),
              summary_line: messageSummarySnippet(text),
              message_text: text,
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
            if (toolName === "tool" || toolName === "other" || toolName === "tool_call" || toolName === "unknown") {
              const hintTitle = typeof detail.title === "string" ? detail.title : typeof detail.label === "string" ? detail.label : "";
              const navMatch = /\b(manage_context|hide_context|summarize_context|unhide_context|list_context_items)\b/.exec(hintTitle);
              if (navMatch) {
                toolName = navMatch[1];
              } else if (argsObj && Array.isArray(argsObj.tool_call_ids)) {
                toolName = "manage_context";
              }
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
    enabled:
      (!resolvedScopeKey ||
        (isHermesScope && listQuery.data !== undefined && !listQuery.data.server_timeline) ||
        needsLinkedTimeline) &&
      !!agentId &&
      !activeChild,
    refetchInterval: 3000,
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
  }, [scopeKey, queryClient]);

  const hasServerTimeline = Boolean(listQuery.data?.server_timeline);
  const needsHermesFallbackMerge = isHermesScope && !hasServerTimeline;

  const rawRows = resolvedScopeKey
    ? activeChild
      ? listQuery.data?.items ?? []
      : needsHermesFallbackMerge
        ? mergeHermesTimelineRows(listQuery.data?.items ?? [], fallbackTimelineQuery.data ?? [], scopes, resolvedScopeKey)
        : mergeLinkedParentRows(listQuery.data?.items ?? [], fallbackTimelineQuery.data ?? [], scopes, resolvedScopeKey)
    : fallbackTimelineQuery.data ?? [];
  const rows = useMemo(() => {
    if (!query) return rawRows;
    const q = query.toLowerCase();
    return rawRows.filter(
      (r) =>
        (r.item_id && r.item_id.toLowerCase().includes(q)) ||
        (r.tool_name && r.tool_name.toLowerCase().includes(q)) ||
        (r.summary_line && r.summary_line.toLowerCase().includes(q)) ||
        (r.tool_input && r.tool_input.toLowerCase().includes(q)) ||
        (r.tool_call_id && r.tool_call_id.toLowerCase().includes(q)),
    );
  }, [rawRows, query]);

  const groupedRows = useMemo(
    () => buildGroupedRows(rows, expandedGroups, lastActionByItem),
    [rows, expandedGroups, lastActionByItem],
  );

  const hiddenCount = rows.filter((r) => r.status === "hidden").length;

  const savedBytes = useMemo(
    () =>
      rows
        .filter((r) => r.status === "hidden")
        .reduce((sum, r) => sum + Math.max(0, (r.bytes_size ?? 0) - effectiveRowBytes(r)), 0),
    [rows],
  );
  const hiddenRows = rows.filter((r) => r.status === "hidden");
  const savedTokens =
    hiddenRows.length > 0 && hiddenRows.every((r) => typeof r.tokens === "number")
      ? hiddenRows.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
      : null;
  const sessionContext = useMemo(() => {
    const usage = activeChild ? null : usageQuery.data;
    if (usage?.contextWindowUsedTokens) {
      return { used: usage.contextWindowUsedTokens, max: usage.contextWindowMaxTokens ?? null };
    }
    const fromLog = listQuery.data?.context;
    if (fromLog?.used_tokens) return { used: fromLog.used_tokens, max: fromLog.max_tokens ?? null };
    return null;
  }, [usageQuery.data, listQuery.data, activeChild]);
  const pendingDelta = pendingEstimate && pendingEstimate.used === sessionContext?.used ? pendingEstimate.tokens : 0;
  const activeRatio = sessionContext?.max
    ? Math.min(1, Math.max(0, sessionContext.used / sessionContext.max))
    : 0;

  const selectedRow = useMemo(() => {
    if (!selectedId) return null;
    return rows.find((r) => (r.item_id ?? r.tool_call_id) === selectedId) ?? null;
  }, [rows, selectedId]);

  const listRef = useRef<any>(null);
  const scrollDriverRef = useRef<OutlineScrollDriver | null>(null);
  if (!scrollDriverRef.current) {
    scrollDriverRef.current = new OutlineScrollDriver();
  }
  const hermesSettledKeyRef = useRef<string | null>(null);

  const sessionViewKey = `${agentId || ""}::${resolvedScopeKey || ""}::${activeChild?.scope_key || ""}`;
  const isSessionHiddenFromView = !childScope && (followVisible || subagentFallback) && !inView;
  const isOutlineListMounted = !isSessionHiddenFromView && groupedRows.length > 0;
  scrollDriverRef.current.syncSession(sessionViewKey, isOutlineListMounted);

  if (needsHermesFallbackMerge && !fallbackTimelineQuery.isFetching && fallbackTimelineQuery.data !== undefined) {
    hermesSettledKeyRef.current = sessionViewKey;
  }

  const isLoading = resolvedScopeKey
    ? (listQuery.isPending && listQuery.fetchStatus !== "idle") ||
      ((needsHermesFallbackMerge || needsLinkedTimeline) &&
        fallbackTimelineQuery.isPending &&
        fallbackTimelineQuery.fetchStatus !== "idle")
    : !!agentId && !activeChild && fallbackTimelineQuery.isPending && fallbackTimelineQuery.fetchStatus !== "idle";

  const isScrollLoading =
    isLoading ||
    Boolean(query && listQuery.isFetching) ||
    (needsHermesFallbackMerge && fallbackTimelineQuery.isFetching && hermesSettledKeyRef.current !== sessionViewKey);
  const scrollState = {
    sessionKey: sessionViewKey,
    mounted: isOutlineListMounted,
    rowCount: groupedRows.length,
    isLoading: isScrollLoading,
    hasSearchQuery: Boolean(query),
  };

  const toggleGroupExpanded = (groupId: string, currentlyExpanded: boolean) => {
    scrollDriverRef.current?.prepareGroupExpand(listRef.current, currentlyExpanded);
    setExpandedGroups((prev) => ({ ...prev, [groupId]: !currentlyExpanded }));
  };

  const openPreviewDrawer = () => {
    if (!previewOpen) {
      scrollDriverRef.current?.prepareDrawerToggle(listRef.current, true);
      setPreviewOpen(true);
    }
  };

  const togglePreviewDrawer = () => {
    if (!previewOpen) {
      openPreviewDrawer();
    } else {
      scrollDriverRef.current?.prepareDrawerToggle(listRef.current, false);
      setPreviewOpen(false);
      setHighlightedId(null);
    }
  };

  useEffect(() => {
    cancelChatNavigation();
    setSelectedId(null);
    setHighlightedId(null);
    setPreviewOpen(false);
    setExpandedGroups({});
    setPendingGroupId(null);
    scrollDriverRef.current?.resetTransient();
  }, [sessionViewKey]);

  useEffect(() => () => cancelChatNavigation(), []);

  useLayoutEffect(() => {
    scrollDriverRef.current?.maybeSync(listRef.current, scrollState);
  }, [groupedRows.length, isScrollLoading, isOutlineListMounted, sessionViewKey, query]);
  const styles = useMemo(() => {
    const pad = layout.compact ? 6 : 10;
    return {
      screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0, minWidth: 0, overflow: "hidden" as const },
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
        minHeight: 0,
      },
      listContent: {
        flexGrow: 1,
      },
      emptyContainer: {
        flex: 1,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        paddingHorizontal: 16,
      },
      rowItem: {
        paddingVertical: layout.compact ? 5 : 6,
        paddingHorizontal: pad,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: "transparent",
      },
      rowItemSelected: {
        borderLeftColor: theme.colors.accent,
        backgroundColor: theme.colors.accent + "14",
      },
      rowItemHidden: {
        opacity: 0.72,
      },
      groupRowItem: {
        backgroundColor: theme.colors.surface1,
      },
      childRowItem: {
        paddingLeft: pad + (layout.compact ? 12 : 16),
        backgroundColor: theme.colors.surface1 + "80",
        borderBottomColor: theme.colors.border + "B3",
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

  const handleRowPress = async (row: Row) => {
    const rowKey = row.item_id ?? row.tool_call_id;
    setSelectedId(rowKey);
    setHighlightedId((current) => (!previewOpen && current === rowKey ? null : rowKey));
    if (!hasDocument) {
      openPreviewDrawer();
      return;
    }
    if (activeChild) {
      if (!activeChild.scope_key.startsWith("omp:") || !activeChild.subagent_id) return;
      const opened = await openProviderSubagent((globalThis as any).document, agentId, activeChild.subagent_id, {
        openParent: () => navigation?.openAgent({ agentId }),
      });
      if (!opened) { setNotice("Could not open subagent tab. Inline outline remains available."); return; }
      void scrollToMessageInChat(row, rawRows, { visibleOnly: true, onNotFound: () => setNotice("Not loaded in chat") });
      return;
    }
    if (displayOnly && !navigation) {
      setNotice("Main session navigation is unavailable.");
      return;
    }
    void scrollToMessageInChat(row, rawRows, {
      openAgent: displayOnly && navigation ? { agentId, open: () => navigation.openAgent({ agentId }) } : undefined,
      onStart: () => setNotice((current) => current === "Not loaded in chat" ? null : current),
      onNotFound: () => setNotice("Not loaded in chat"),
      getHistory: () => queryClient.fetchQuery({ ...historyQueryOptions, staleTime: 0 }),
    });
  };

  // Prompts and responses can only be hidden (removed from the outgoing context), never summarized.
  const renderMessageHideToggle = (row: Row) => {
    if (displayOnly || !resolvedScopeKey || !row.item_id?.startsWith("msg:")) return null;
    const hidden = row.status === "hidden";
    const iconSize = layout.compact ? 13 : 14;
    return (
      <View style={styles.actionsContainer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? "Unhide message" : "Hide message"}
          disabled={!actionAllowed(row, capabilities, hidden ? "unhide" : "hide")}
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

  const renderMessageSnippet = (row: Row, empty: string) => {
    const normalized = messageSummarySnippet(row.summary_line ?? row.message_text);
    return row.status === "hidden" ? (
      <Text style={styles.summaryHiddenSnippet} numberOfLines={1}>
        {hiddenRowSnippet(row, false, normalized.split("\n")[0] || "tap icon to restore")}
      </Text>
    ) : (
      <Text style={styles.summarySnippet} numberOfLines={2}>
        {normalized || empty}
      </Text>
    );
  };

  const renderRow = (row: Row) => {
    const rowKey = row.item_id ?? row.tool_call_id;
    const isSelected = previewOpen
      ? (selectedRow?.item_id ?? selectedRow?.tool_call_id) === rowKey
      : highlightedId === rowKey;
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
              <Text style={{ fontSize: 13, lineHeight: 15, color: theme.colors.accent, flexShrink: 0 }}>◈</Text>
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
          accessibilityLabel="Agent response"
          style={[styles.rowItem, isSelected ? styles.rowItemSelected : null]}
          onPress={() => handleRowPress(row)}
        >
          <View style={styles.rowMainLine}>
            <View style={styles.rowLeftWrap}>
              <Text
                style={{
                  fontSize: 12,
                  lineHeight: 15,
                  color: /^#[c-fC-F]/.test(theme.colors.surface0) ? "#2563eb" : "#3b82f6",
                  flexShrink: 0,
                }}
              >
                ✦
              </Text>
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 }}>
                Agent
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
            {!displayOnly && resolvedScopeKey && row.manageable !== false ? (
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
                      disabled={!actionAllowed(row, capabilities, "hide")}
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
                      disabled={!actionAllowed(row, capabilities, "summarize")}
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
              {hiddenRowSnippet(row, summarized, firstSummaryLine || "tap slashed icon to restore")}
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
    const noRemainingManageableVisible = group.allHidden || group.allManageableHidden;
    const restoreIconKind = groupRestoreIconKind(group);
    const badgeText = groupBadgeText(group);
    const subtitleText = groupSubtitleText(group);
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
          toggleGroupExpanded(group.groupId, isExpanded);
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
                toggleGroupExpanded(group.groupId, isExpanded);
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

            {badgeText ? (
              <View style={styles.mixedBadge}>
                <Text style={styles.mixedBadgeText}>
                  {badgeText}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Right inline slot: [Group Hide/Summarize Action Icons] + [Total Bytes] */}
          <View style={styles.rowRightWrap}>
            {!displayOnly && resolvedScopeKey && group.children.some((row) => actionAllowed(row, capabilities, row.status === "hidden" ? "unhide" : "hide") || actionAllowed(row, capabilities, "summarize")) ? (
              <View style={[styles.actionsContainer, isPending ? { opacity: 0.5 } : null]}>
                {noRemainingManageableVisible ? (
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
                      kind={restoreIconKind}
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
                      disabled={isPending || (eyeAction !== "unhide" && !capabilities?.hide)}
                      onPress={(e) => {
                        e.stopPropagation();
                        void runGroupBatch(group, eyeAction);
                      }}
                    >
                      <ActionSvgIcon
                        kind={eyeAction === "unhide" ? restoreIconKind : "hide"}
                        slashed={eyeAction === "unhide"}
                        size={iconSize}
                        color={theme.colors.foregroundMuted}
                      />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Summarize all in ${group.groupId}`}
                      style={styles.inlineIconBtn}
                      disabled={isPending || !capabilities?.summarize}
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
              {groupMetric(group)}
            </Text>
          </View>
        </View>

        <View style={styles.treeLineContainer}>
          <Text style={noRemainingManageableVisible ? styles.summaryHiddenSnippet : styles.summarySnippet} numberOfLines={1}>
            {subtitleText}
          </Text>
        </View>
      </Pressable>
    );
  };

  const renderChildRow = (child: OutlineRow & { type: "child" }) => {
    const row = child.row;
    const rowKey = row.item_id ?? row.tool_call_id;
    const isSelected = previewOpen
      ? (selectedRow?.item_id ?? selectedRow?.tool_call_id) === rowKey
      : highlightedId === rowKey;
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
            {!displayOnly && resolvedScopeKey && row.manageable !== false ? (
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
                      disabled={!actionAllowed(row, capabilities, "hide")}
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
                      disabled={!actionAllowed(row, capabilities, "summarize")}
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
              {hiddenRowSnippet(row, summarized, firstSummaryLine || "tap icon to restore")}
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

  const renderLinkedChildren = (callIds: string[]) => {
    if (displayOnly || !resolvedScopeKey) return null;
    const linked = callIds.flatMap((id) => childrenForCall(scopes, resolvedScopeKey, id))
      .filter((child, index, all) => !ancestry.includes(child.scope_key) && all.findIndex((other) => other.scope_key === child.scope_key) === index);
    return linked.map((child) => (
      <View key={child.scope_key} style={{ paddingLeft: 12, borderLeftWidth: 2, borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 6, gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Expand subagent ${child.subagent_id}`}
            accessibilityState={{ expanded: !!expandedChildren[child.scope_key] }}
            onPress={() => setExpandedChildren((current) => ({ ...current, [child.scope_key]: !current[child.scope_key] }))} style={{ flex: 1 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{expandedChildren[child.scope_key] ? "▾" : "▸"} subagent: {child.subagent_id}</Text>
          </Pressable>
          {hasDocument && child.scope_key.startsWith("omp:") ? <Pressable accessibilityRole="button" accessibilityLabel={`Open subagent tab ${child.subagent_id}`}
            onPress={async () => {
              const opened = await openProviderSubagent((globalThis as any).document, agentId, child.subagent_id!, { openParent: () => navigation?.openAgent({ agentId }) });
              if (!opened) {
                setExpandedChildren((current) => ({ ...current, [child.scope_key]: true }));
                setNotice("Could not open subagent tab. Inline outline remains available.");
              }
            }}><Text style={{ color: theme.colors.accent, fontSize: 11 }}>Open tab ↗</Text></Pressable> : null}
        </View>
        {expandedChildren[child.scope_key] ? <View style={{ height: 320, minHeight: 0 }}>
          <SessionNavPanel {...panelProps} theme={theme} layout={layout} params={{ agentId }} navigation={navigation} tab={tab}
            followVisible={false} childScope={child} ancestry={[...ancestry, scopeKey]} />
        </View> : null}
      </View>
    ));
  };

  const isResolvingSession = !childScope && followVisible && !followResolved;
  const isCapabilitiesLoading =
    isResolvingSession || scopesQuery.isPending || (!!resolvedScopeKey && listQuery.isPending && !capabilities);
  const runtimeError =
    listQuery.error instanceof Error
      ? listQuery.error.message
      : scopesQuery.error instanceof Error
        ? scopesQuery.error.message
        : undefined;
  const capabilityMessage =
    runtimeError || (!isCapabilitiesLoading && inView && Boolean(agentId))
      ? capabilityNotice(runtimeError, capabilities)
      : null;

  const capNotice = listQuery.data?.records_capped === true && !notice && !capabilityMessage && !displayOnly
    ? "Large session: oldest tool controls omitted"
    : null;
  const noticeBar = notice || capabilityMessage || capNotice || displayOnly ? (
    <View accessibilityRole="alert" style={styles.noticeBar}>
      {displayOnly ? <Text style={styles.noticeText}>subagent context is not managed</Text> : null}
      {notice || capabilityMessage || capNotice ?
        <Text style={styles.noticeText}>{notice ?? capabilityMessage ?? capNotice}</Text> : null}
    </View>
  ) : null;

  if (!childScope && (followVisible || subagentFallback) && !inView) {
    if (isResolvingSession) {
      return (
        <View style={styles.screen}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.headerTitle}>Outline</Text>
            </View>
          </View>
          <View style={[styles.list, styles.emptyContainer]}>
            <Text style={styles.emptyText}>Loading outline…</Text>
          </View>
        </View>
      );
    }
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

  if (!isLoading && rawRows.length === 0) {
    return (
      <View style={styles.screen}>
        {noticeBar}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Outline</Text>
            <Text style={styles.headerAgent} numberOfLines={1}>
              · {childLabel ? `subagent: ${childLabel}` : agent?.title ?? agentId.slice(0, 8)}
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
            · {childLabel ? `subagent: ${childLabel}` : agent?.title ?? agentId.slice(0, 8)}
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
      {groupedRows.length === 0 ? (
        <View style={[styles.list, styles.emptyContainer]}>
          <Text style={styles.emptyText}>
            {isLoading || listQuery.isPending
              ? "Loading outline…"
              : "No activity recorded in this session yet."}
          </Text>
        </View>
      ) : (
        <View
          style={styles.list}
          {...({
            onWheel: (ev: any) => scrollDriverRef.current?.handleWheel(ev),
          } as Record<string, unknown>)}
        >
          <ScrollView
            ref={listRef}
            key={sessionViewKey || "outline-list"}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            nestedScrollEnabled={true}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => scrollDriverRef.current?.handleDragStart()}
            onScroll={(ev: any) => scrollDriverRef.current?.handleScrollEvent(ev)}
            onScrollEndDrag={(ev: any) => scrollDriverRef.current?.handleScrollEvent(ev)}
            onMomentumScrollEnd={(ev: any) => scrollDriverRef.current?.handleScrollEvent(ev)}
            onLayout={(ev: any) => scrollDriverRef.current?.handleLayout(listRef.current, ev, scrollState)}
            onContentSizeChange={(_w: number, h: number) =>
              scrollDriverRef.current?.handleContentSizeChange(listRef.current, h, scrollState)
            }
          >
            {groupedRows.map((item) => {
              if (item.type === "group") {
                return (
                  <View key={item.key}>
                    {renderGroupRow(item)}
                    {!expandedGroups[item.groupId] ? renderLinkedChildren(item.children.map((row) => row.tool_call_id)) : null}
                  </View>
                );
              }
              return (
                <View key={item.key}>
                  {item.type === "child" ? renderChildRow(item) : renderRow(item.row)}
                  {renderLinkedChildren([item.row.tool_call_id])}
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

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

      <PreviewDrawer row={selectedRow} open={previewOpen} onToggle={togglePreviewDrawer} theme={theme} />

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
