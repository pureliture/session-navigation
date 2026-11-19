import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo, useRpc, useTabState } from "@getpaseo/plugin/client";
import {
  Icon as UiIcon,
  ScrollView as UiScrollView,
  TextInput as UiTextInput,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { cancelChatNavigation, parseRgb, scrollToMessageInChat, visibleChatValues } from "./chatNavigation";
import { PreviewDrawer } from "./PreviewDrawer";
import { actionAllowed, capabilityNotice, type Capabilities } from "./capabilities";
import { focusedSessionTab, openProviderSubagent, readHostFocus, readWebWorkspaceFocusedTab, subscribeHostFocus, type SessionTab } from "./hostCompat";
import { childrenForCall, resolveChildScope, scopeForAgent, subagentMainTarget, type ChildScope } from "./subagents";
import { acceptWorkspaceAgentId, hasDomDocument, readSessionTimelineIds, resolveSessionTarget, selectMainOrFallbackAgent, sessionFollowCandidates } from "./sessionFollowing";
import {
  buildGroupedRows,
  effectiveRowBytes,
  fmtBytes,
  fmtTokenCount,
  fmtTokens,
  groupMutationItems,
  type OutlineRow,
} from "./outlineGrouping";
import { buildFallbackTimelineRows, mergeHermesTimelineRows, mergeLinkedParentRows, mergePagedRows } from "./fallbackTimeline";
import { EMPTY_LINKED_CHILDREN, MemoOutlineRowItem } from "./outlineRows";
import { outlineRefreshQueryKeys } from "./outlineRefresh";
import { OutlineScrollDriver } from "./outlineScroll";
import {
  resolveOutlineSettingsValues,
  shouldOpenPreviewDrawerOnRowPress,
  useOutlineSettings,
} from "./outlineSettingsHook";
import { openSessionNavSettings } from "./registration";

const panelTabStateSchema = z.object({
  query: z.string().default(""),
});

type PanelTabState = z.infer<typeof panelTabStateSchema>;

const DEFAULT_TAB_STATE: PanelTabState = {
  query: "",
};

const SUMMARY_QUEUED_NOTICE = "Summary queued — runs on next prompt";
const OUTLINE_PAGE_SIZE = 150;
const OUTLINE_PREPEND_THRESHOLD_PX = 160;
type FallbackTimelineCursor = NonNullable<
  Awaited<
    ReturnType<ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>["timeline"]["refetch"]>
  >["startCursor"]
>;

const ScrollView = UiScrollView ?? RnScrollView;
const TextInput = UiTextInput ?? RnTextInput;

export function SessionNavPanel({
  theme,
  layout,
  params,
  navigation,
  tab,
  followVisible = true,
  openPreviewOnRowClick: openPreviewOnRowClickProp,
  onOpenSettings,
  candidateAgentIds,
  childScope,
  ancestry = [],
  ...panelProps
}: PluginAgentPanelProps & {
  followVisible?: boolean;
  openPreviewOnRowClick?: boolean;
  onOpenSettings?: () => void;
  candidateAgentIds?: readonly string[];
  childScope?: ChildScope;
  ancestry?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const outlineSettingsState = useOutlineSettings();
  const outlineValues = resolveOutlineSettingsValues(outlineSettingsState);
  const effectiveFollowVisible = followVisible && outlineValues.followVisibleSession;
  const effectiveOpenPreviewOnRowClick =
    openPreviewOnRowClickProp ?? outlineValues.openPreviewOnRowClick;
  // Paseo binds agent panels to the agent they were opened for; follow whichever session the chat shows instead.
  const [followedId, setFollowedId] = useState<string | null>(null);
  const [inView, setInView] = useState(!!params.agentId);
  const [followResolved, setFollowResolved] = useState(
    () => !effectiveFollowVisible || !!params.agentId,
  );
  const [subagentFallback, setSubagentFallback] = useState(false);
  const [focusedTab, setFocusedTab] = useState<SessionTab | null>(null);
  const lastMainAgent = useRef(params.agentId || null);
  const agentId =
    effectiveFollowVisible || subagentFallback ? (followedId ?? params.agentId) : params.agentId;
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
    setFollowResolved(!effectiveFollowVisible || !!params.agentId);
    lastMainAgent.current = params.agentId || null;
    setFocusedTab(null);
    setSubagentFallback(false);
  }, [params.agentId, effectiveFollowVisible]);
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
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;
  const scopesSignature = useMemo(
    () =>
      scopes
        .map(
          (s) =>
            `${s.scope_key}|${s.agent_id ?? ""}|${s.parent_scope ?? ""}|${s.subagent_id ?? ""}|${s.tool_call_id ?? ""}`,
        )
        .join("\n"),
    [scopes],
  );
  const hostProp: unknown = "host" in panelProps && typeof panelProps.host === "object" && panelProps.host !== null &&
    "id" in panelProps.host ? panelProps.host.id : undefined;
  const hostId = typeof hostProp === "string" ? hostProp : "";
  const workspaceProp: unknown = "workspaceId" in panelProps ? panelProps.workspaceId : undefined;
  const panelWorkspaceId = typeof workspaceProp === "string" ? workspaceProp : undefined;
  const hasDocument = hasDomDocument();

  useEffect(() => {
    setFocusedTab((current) => {
      if (!current) return null;
      if (current.kind === "provider_subagent" && agentId && current.parentAgentId !== agentId) return null;
      if (current.kind === "agent" && agentId && current.agentId !== agentId) return null;
      return current;
    });
  }, [agentId]);

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
      const currentScopes = scopesRef.current;
      const fallback = await subagentMainTarget(focused, parentOf);
      const managed = focused?.kind === "agent" && currentScopes.some((scope) => scope.agent_id === focused.agentId);
      const useFallback = fallback.subagent && !managed;
      const needsTimelineScan =
        effectiveFollowVisible && focused?.kind !== "provider_subagent" && focused?.kind !== "agent" && !useFallback;
      const resolvedTarget = needsTimelineScan
        ? await resolveSessionTarget({
            followVisible: effectiveFollowVisible,
            boundAgentId: params.agentId,
            visibleValues: values,
            candidates: sessionFollowCandidates(
              candidateAgentIds,
              currentScopes.map((s) => s.agent_id).filter((id): id is string => !!id),
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
        : effectiveFollowVisible
          ? null
          : params.agentId || null;
      const selection = selectMainOrFallbackAgent({
        tab: focused,
        managed: !!managed,
        fallback,
        followVisible: effectiveFollowVisible,
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
        if (effectiveFollowVisible && hasSignal) {
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
  }, [paseo, params.agentId, scopesSignature, queryClient, effectiveFollowVisible, candidateAgentIds, childScope, hasDocument, hostId, panelWorkspaceId]);
  const effectiveFocusedTab = useMemo(() => {
    if (!focusedTab) return null;
    if (focusedTab.kind === "provider_subagent" && agentId && focusedTab.parentAgentId !== agentId) {
      return null;
    }
    if (focusedTab.kind === "agent" && agentId && focusedTab.agentId !== agentId) {
      return null;
    }
    return focusedTab;
  }, [focusedTab, agentId]);
  const parentScopeKey = scopeForAgent(scopes, agentId);

  const activeChild = childScope ?? resolveChildScope(effectiveFocusedTab, parentScopeKey, scopes);
  const displayOnly = subagentFallback && !activeChild;
  const resolvedScopeKey = activeChild?.scope_key ?? parentScopeKey;
  const childLabel = activeChild?.subagent_id;

  const scopeKey = resolvedScopeKey ?? "";
  const query = tabState.query;
  const sessionViewKey = `${agentId || ""}::${resolvedScopeKey || ""}::${activeChild?.scope_key || ""}`;
  const sessionViewKeyRef = useRef(sessionViewKey);
  sessionViewKeyRef.current = sessionViewKey;

  const [olderServerState, setOlderServerState] = useState<{
    sessionKey: string;
    rows: Row[];
    hasOlder: boolean;
    nextBeforeIndex: number | null;
  } | null>(null);
  const [olderFallbackState, setOlderFallbackState] = useState<{
    sessionKey: string;
    rows: Row[];
    hasOlder: boolean;
    startCursor: FallbackTimelineCursor | null;
  } | null>(null);
  const [isLoadingOlderServer, setIsLoadingOlderServer] = useState(false);
  const [isLoadingOlderFallback, setIsLoadingOlderFallback] = useState(false);
  const loadingOlderKeyRef = useRef<string | null>(null);
  const refreshOlderRef = useRef<(() => Promise<void>) | null>(null);

  const patchOlderServerRows = useCallback(
    (updates: Map<string, Partial<Row>>) => {
      if (updates.size === 0) return;
      const capturedKey = sessionViewKeyRef.current;
      setOlderServerState((prev) => {
        if (!prev || prev.sessionKey !== capturedKey) return prev;
        let changed = false;
        const nextRows = prev.rows.map((row) => {
          if (!row.item_id) return row;
          const patch = updates.get(row.item_id);
          if (!patch) return row;
          changed = true;
          return { ...row, ...patch };
        });
        return changed ? { ...prev, rows: nextRows } : prev;
      });
    },
    [],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "scopes"] });
    void refreshOlderRef.current?.();
  };


  const onMutationError = (result: { ok: boolean; error?: string }) => {
    if (!result.ok && result.error === "version_conflict") {
      setNotice("Stale row — list refreshed.");
      invalidate();
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
    if (!result.ok && result.error === "engine_error") {
      setNotice("Request timed out or worker restarted (engine_error) — list refreshed to sync changes.");
      invalidate();
      return true;
    }
    if (!result.ok) {
      setNotice(result.error ?? "failed");
      return true;
    }
    return false;
  };
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
        if (r.ok && row.item_id) {
          const patch: Partial<Row> = r.item ?? {
            status: r.status ?? "hidden",
            visibility: r.visibility ?? "hidden",
            ...(typeof r.version === "number" ? { version: r.version } : {}),
            ...(mode === "summarize" ? { summary_pending: true } : {}),
          };
          patchOlderServerRows(new Map([[row.item_id, patch]]));
        }
      }
    },
    onError: (err, _vars, context) => {
      if (context?.changed) {
        const { rowKey, prevActionMode } = context;
        setLastActionByItem((prev) => {
          const next = { ...prev };
          if (prevActionMode === undefined) delete next[rowKey];
          else next[rowKey] = prevActionMode;
          return next;
        });
      }
      setNotice(
        err instanceof Error && err.message
          ? `${err.message} — list refreshed.`
          : "Hide failed — list refreshed.",
      );
    },
    onSettled: () => {
      invalidate();
    },
  });

  const unhideMutation = useMutation({
    mutationFn: (row: Row) => displayOnly ? Promise.resolve({ ok: false, error: "capability_unavailable" }) :
      unhideRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version }),
    onSuccess: (r, row) => {
      if (!onMutationError(r)) {
        setNotice(null);
        notePending([row], 1);
        if (r.ok && row.item_id) {
          const patch: Partial<Row> = r.item ?? {
            status: r.status ?? "unhidden",
            visibility: r.visibility ?? "visible",
            ...(typeof r.version === "number" ? { version: r.version } : {}),
            summary_pending: false,
          };
          patchOlderServerRows(new Map([[row.item_id, patch]]));
        }
      }
    },
    onError: (err) => {
      setNotice(
        err instanceof Error && err.message
          ? `${err.message} — list refreshed.`
          : "Unhide failed — list refreshed.",
      );
    },
    onSettled: () => {
      invalidate();
    },
  });

  const hideBatchMutation = useMutation({
    mutationFn: (vars: {
      scope_key: string;
      mode: "hide" | "summarize";
      items: { item_id: string; expected_version?: number }[];
    }) => hideBatch(vars),
    onError: () => {
      invalidate();
    },
    onSettled: () => {
      invalidate();
    },
  });

  const unhideBatchMutation = useMutation({
    mutationFn: (vars: {
      scope_key: string;
      items: { item_id: string; expected_version?: number }[];
    }) => unhideBatch(vars),
    onError: () => {
      invalidate();
    },
    onSettled: () => {
      invalidate();
    },
  });

  const isMutating =
    hideMutation.isPending ||
    unhideMutation.isPending ||
    hideBatchMutation.isPending ||
    unhideBatchMutation.isPending ||
    !!pendingGroupId;

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
          ? await unhideBatchMutation.mutateAsync({ scope_key: scopeKey, items })
          : await hideBatchMutation.mutateAsync({ scope_key: scopeKey, mode: action, items });
      const resultItems = Array.isArray(result.items) ? result.items : [];
      const failures = resultItems.filter((item) => !item.ok);
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
      const applied = new Set(resultItems.filter((item) => item.ok).map((item) => item.item_id));
      const olderPatches = new Map<string, Partial<Row>>();
      for (const resItem of resultItems) {
        if (!resItem.ok || !resItem.item_id) continue;
        olderPatches.set(resItem.item_id, {
          ...(resItem.status ? { status: resItem.status } : {}),
          ...(resItem.visibility ? { visibility: resItem.visibility } : {}),
          ...(typeof resItem.version === "number" ? { version: resItem.version } : {}),
          ...(action === "unhide"
            ? { summary_pending: false }
            : action === "summarize"
              ? { summary_pending: true }
              : {}),
        });
      }
      patchOlderServerRows(olderPatches);
      notePending(
        rows.filter((r) => r.item_id && applied.has(r.item_id) && (action === "unhide") === (r.status === "hidden")),
        action === "unhide" ? 1 : -1,
      );
      if (result.error) onMutationError(result);
      for (const item of failures) onMutationError(item);
      if (failures.length) {
        const reasons = [...new Set(failures.map((item) => item.error ?? "failed"))].join(", ");
        setNotice(`${result.applied ?? applied.size} applied, ${result.failed ?? failures.length} failed — ${reasons}. List refreshed.`);
      } else if (!result.ok) {
        if (result.error !== "db_error" && result.error !== "db_full") {
          setNotice(
            result.error === "engine_error"
              ? "Batch timed out or worker restarted (engine_error) — list refreshed to sync partial changes."
              : `Batch ${result.error ?? "failed"} — list refreshed to sync partial changes.`,
          );
        }
      } else {
        setNotice(action === "summarize" ? SUMMARY_QUEUED_NOTICE : null);
      }
    } catch (err) {
      rollbackItems(items.map((item) => item.item_id));
      onMutationError({ ok: false, error: "db_error" });
      setNotice(
        err instanceof Error && err.message
          ? `Batch failed (${err.message}) — list refreshed to sync partial changes.`
          : "Batch failed — list refreshed to sync partial changes.",
      );
    } finally {
      setPendingGroupId(null);
      invalidate();
    }
  };

  const queryKey = useMemo(() => ["session-nav", "list", scopeKey, query], [scopeKey, query]);

  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      if (!resolvedScopeKey) {
        return {
          items: [] as Row[],
          context: undefined,
          capabilities: undefined,
          server_timeline: false,
          records_capped: false,
          has_older: false,
          next_before_index: null as number | null,
          totals: undefined,
        };
      }
      const result = await listRpc({
        scope_key: scopeKey,
        query: query || undefined,
        ...(query ? {} : { limit: OUTLINE_PAGE_SIZE }),
      });
      if (!result.ok) {
        if (result.error === "db_error") setDbErrorOpen(true);
        throw new Error(result.error ?? "list_failed");
      }
      return {
        items: result.items,
        context: result.context,
        capabilities: result.capabilities,
        server_timeline: Boolean(result.server_timeline),
        records_capped: Boolean((result as Record<string, unknown>).records_capped),
        has_older: Boolean(result.has_older),
        next_before_index: typeof result.next_before_index === "number" ? result.next_before_index : null,
        totals: result.totals,
      };
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

  const isHermesScope = Boolean(resolvedScopeKey?.startsWith("hermes:"));
  const needsLinkedTimeline = !activeChild && !!resolvedScopeKey && scopes.some((scope) => scope.parent_scope === resolvedScopeKey &&
    scope.tool_call_id && !listQuery.data?.items.some((row) => row.tool_call_id === scope.tool_call_id));
  const fallbackTimelineQuery = useQuery({
    queryKey: ["paseo-agent-timeline", agentId],
    queryFn: async () => {
      if (!agentId || !paseo?.agents) {
        return { rows: [] as Row[], hasOlder: false, startCursor: null as FallbackTimelineCursor | null };
      }
      try {
        const page = await paseo.agents.ref(agentId).timeline.refetch({
          direction: "tail",
          limit: OUTLINE_PAGE_SIZE,
          projection: "canonical",
        });
        if (page.error) throw new Error(page.error);
        return {
          rows: buildFallbackTimelineRows(page.entries),
          hasOlder: Boolean(page.hasOlder && page.startCursor),
          startCursor: page.startCursor ?? null,
        };
      } catch {
        return { rows: [] as Row[], hasOlder: false, startCursor: null as FallbackTimelineCursor | null };
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

  const activeOlderServer = olderServerState?.sessionKey === sessionViewKey ? olderServerState : null;
  const activeOlderFallback = olderFallbackState?.sessionKey === sessionViewKey ? olderFallbackState : null;
  const serverTailRows = listQuery.data?.items ?? [];
  const serverRows = useMemo(
    () => (!query && activeOlderServer ? mergePagedRows(activeOlderServer.rows, serverTailRows) : serverTailRows),
    [query, activeOlderServer, serverTailRows],
  );
  const fallbackTailRows = fallbackTimelineQuery.data?.rows ?? [];
  const fallbackRows = useMemo(
    () => (activeOlderFallback ? mergePagedRows(activeOlderFallback.rows, fallbackTailRows) : fallbackTailRows),
    [activeOlderFallback, fallbackTailRows],
  );

  const rawRows = useMemo(
    () =>
      resolvedScopeKey
        ? activeChild
          ? serverRows
          : needsHermesFallbackMerge
            ? mergeHermesTimelineRows(serverRows, fallbackRows, scopes, resolvedScopeKey)
            : mergeLinkedParentRows(serverRows, fallbackRows, scopes, resolvedScopeKey)
        : fallbackRows,
    [
      resolvedScopeKey,
      activeChild,
      serverRows,
      needsHermesFallbackMerge,
      fallbackRows,
      scopes,
    ],
  );
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

  const localHiddenCount = rows.filter((r) => r.status === "hidden").length;
  const localSavedBytes = useMemo(
    () =>
      rows
        .filter((r) => r.status === "hidden")
        .reduce((sum, r) => sum + Math.max(0, (r.bytes_size ?? 0) - effectiveRowBytes(r)), 0),
    [rows],
  );
  const serverTotals = !query ? listQuery.data?.totals : undefined;
  const hiddenCount = serverTotals ? serverTotals.hidden_count : localHiddenCount;
  const savedBytes = serverTotals ? serverTotals.saved_bytes : localSavedBytes;
  const entryCount =
    serverTotals && !needsHermesFallbackMerge && !needsLinkedTimeline
      ? serverTotals.total_rows
      : rows.length;
  const hiddenRows = rows.filter((r) => r.status === "hidden");
  const savedTokens =
    hiddenRows.length > 0 &&
    hiddenRows.length === hiddenCount &&
    hiddenRows.every((r) => typeof r.tokens === "number")
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

  const isSessionHiddenFromView = !childScope && (effectiveFollowVisible || subagentFallback) && !inView;
  const isOutlineListMounted = !isSessionHiddenFromView && groupedRows.length > 0;
  scrollDriverRef.current.syncSession(sessionViewKey, isOutlineListMounted);

  refreshOlderRef.current = async () => {
    const capturedKey = sessionViewKeyRef.current;
    if (!resolvedScopeKey || !olderServerState || olderServerState.sessionKey !== capturedKey || olderServerState.rows.length === 0) {
      return;
    }
    const minIdx = olderServerState.rows.reduce(
      (min, r) => (typeof r.timeline_index === "number" ? Math.min(min, r.timeline_index) : min),
      Infinity,
    );
    const maxIdx = olderServerState.rows.reduce(
      (max, r) => (typeof r.timeline_index === "number" ? Math.max(max, r.timeline_index) : max),
      -1,
    );
    if (!Number.isFinite(minIdx) || maxIdx < minIdx) return;
    const collected: Row[] = [];
    let cursor = maxIdx + 1;
    let hasOlderFlag = olderServerState.hasOlder;
    let nextBefore: number | null = olderServerState.nextBeforeIndex;
    while (cursor > minIdx) {
      const span = Math.min(2000, Math.max(OUTLINE_PAGE_SIZE, cursor - minIdx));
      const res = await listRpc({
        scope_key: resolvedScopeKey,
        limit: span,
        before_index: cursor,
      });
      if (sessionViewKeyRef.current !== capturedKey || !res.ok || res.items.length === 0) return;
      collected.unshift(...res.items);
      const firstIdx = res.items[0]?.timeline_index;
      if (typeof firstIdx !== "number" || firstIdx <= minIdx || !res.has_older || res.next_before_index == null) {
        hasOlderFlag = Boolean(res.has_older && res.next_before_index != null);
        nextBefore = typeof res.next_before_index === "number" ? res.next_before_index : null;
        break;
      }
      cursor = res.next_before_index;
    }
    if (sessionViewKeyRef.current !== capturedKey || collected.length === 0) return;
    setOlderServerState((prev) => {
      if (!prev || prev.sessionKey !== capturedKey) return prev;
      return {
        sessionKey: capturedKey,
        rows: mergePagedRows(collected, []),
        hasOlder: hasOlderFlag,
        nextBeforeIndex: nextBefore,
      };
    });
  };

  const isLoadingOlder = isLoadingOlderServer || isLoadingOlderFallback;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshOutline = useCallback(async () => {
    if (isRefreshing || isLoadingOlder) return;
    setIsRefreshing(true);
    try {
      cancelChatNavigation();
      setNotice(null);
      setSelectedId(null);
      setHighlightedId(null);
      setPreviewOpen(false);
      setExpandedGroups({});
      setPendingGroupId(null);
      setOlderServerState(null);
      setOlderFallbackState(null);
      loadingOlderKeyRef.current = null;
      scrollDriverRef.current?.resetTransient();
      await Promise.all(
        outlineRefreshQueryKeys(agentId).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [agentId, isLoadingOlder, isRefreshing, queryClient]);
  const canLoadOlderServer =
    !query &&
    !!resolvedScopeKey &&
    (activeOlderServer
      ? activeOlderServer.hasOlder && activeOlderServer.nextBeforeIndex !== null
      : Boolean(listQuery.data?.has_older && listQuery.data?.next_before_index != null));
  const canLoadOlderFallback =
    !query &&
    !activeChild &&
    !!agentId &&
    (!resolvedScopeKey || needsHermesFallbackMerge || needsLinkedTimeline) &&
    (activeOlderFallback
      ? activeOlderFallback.hasOlder && activeOlderFallback.startCursor !== null
      : Boolean(fallbackTimelineQuery.data?.hasOlder && fallbackTimelineQuery.data?.startCursor));
  const hasOlderItems = canLoadOlderServer || canLoadOlderFallback;

  const loadOlderOutlinePage = useCallback(async () => {
    if (query || isLoadingOlder) return;
    const capturedKey = sessionViewKeyRef.current;
    if (canLoadOlderServer && resolvedScopeKey) {
      const beforeIdx = activeOlderServer
        ? activeOlderServer.nextBeforeIndex
        : (listQuery.data?.next_before_index ?? null);
      if (beforeIdx === null || beforeIdx <= 0) return;
      const dedupeKey = `srv:${capturedKey}:${beforeIdx}`;
      if (loadingOlderKeyRef.current === dedupeKey) return;
      loadingOlderKeyRef.current = dedupeKey;
      setIsLoadingOlderServer(true);
      try {
        const result = await listRpc({
          scope_key: resolvedScopeKey,
          limit: OUTLINE_PAGE_SIZE,
          before_index: beforeIdx,
        });
        if (sessionViewKeyRef.current !== capturedKey) return;
        if (!result.ok) {
          setNotice(result.error ?? "Failed to load older items");
          return;
        }
        if (result.items.length > 0) {
          scrollDriverRef.current?.preparePrepend(listRef.current);
        }
        setOlderServerState((prev) => {
          const baseRows = prev?.sessionKey === capturedKey ? prev.rows : [];
          return {
            sessionKey: capturedKey,
            rows: mergePagedRows(result.items, baseRows),
            hasOlder: Boolean(result.has_older && result.next_before_index != null),
            nextBeforeIndex:
              typeof result.next_before_index === "number" ? result.next_before_index : null,
          };
        });
      } catch (err) {
        if (sessionViewKeyRef.current === capturedKey) {
          setNotice(err instanceof Error && err.message ? err.message : "Failed to load older items");
        }
      } finally {
        if (loadingOlderKeyRef.current === dedupeKey) loadingOlderKeyRef.current = null;
        setIsLoadingOlderServer(false);
      }
      return;
    }
    if (canLoadOlderFallback && agentId && paseo?.agents) {
      const cursor = activeOlderFallback
        ? activeOlderFallback.startCursor
        : (fallbackTimelineQuery.data?.startCursor ?? null);
      if (!cursor) return;
      const dedupeKey = `fb:${capturedKey}:${cursor.epoch}:${cursor.seq}`;
      if (loadingOlderKeyRef.current === dedupeKey) return;
      loadingOlderKeyRef.current = dedupeKey;
      setIsLoadingOlderFallback(true);
      try {
        const page = await paseo.agents.ref(agentId).timeline.refetch({
          direction: "before",
          cursor,
          limit: OUTLINE_PAGE_SIZE,
          projection: "canonical",
        });
        if (sessionViewKeyRef.current !== capturedKey) return;
        if (page.error) {
          setNotice(page.error);
          return;
        }
        const stalled =
          !page.entries.length ||
          (page.startCursor &&
            page.startCursor.epoch === cursor.epoch &&
            page.startCursor.seq >= cursor.seq);
        const olderRows = buildFallbackTimelineRows(page.entries);
        if (olderRows.length > 0) {
          scrollDriverRef.current?.preparePrepend(listRef.current);
        }
        setOlderFallbackState((prev) => {
          const baseRows = prev?.sessionKey === capturedKey ? prev.rows : [];
          return {
            sessionKey: capturedKey,
            rows: mergePagedRows(olderRows, baseRows),
            hasOlder: !stalled && Boolean(page.hasOlder && page.startCursor),
            startCursor: stalled ? null : (page.startCursor ?? null),
          };
        });
      } catch (err) {
        if (sessionViewKeyRef.current === capturedKey) {
          setNotice(err instanceof Error && err.message ? err.message : "Failed to load older items");
        }
      } finally {
        if (loadingOlderKeyRef.current === dedupeKey) loadingOlderKeyRef.current = null;
        setIsLoadingOlderFallback(false);
      }
    }
  }, [
    query,
    isLoadingOlder,
    canLoadOlderServer,
    canLoadOlderFallback,
    resolvedScopeKey,
    activeOlderServer,
    listQuery.data?.next_before_index,
    listRpc,
    agentId,
    paseo,
    activeOlderFallback,
    fallbackTimelineQuery.data?.startCursor,
  ]);

  const handleOutlineScroll = (ev: any) => {
    const prevTop = scrollDriverRef.current?.scroller.getLastScrollTop() ?? 0;
    scrollDriverRef.current?.handleScrollEvent(ev);
    const top = ev?.nativeEvent?.contentOffset?.y;
    const sh = ev?.nativeEvent?.contentSize?.height;
    const ch = ev?.nativeEvent?.layoutMeasurement?.height;
    const scroller = scrollDriverRef.current?.scroller;
    if (
      typeof top === "number" &&
      top <= OUTLINE_PREPEND_THRESHOLD_PX &&
      // Synthetic scroll events from a display:none-collapsed layout report top 0;
      // never treat those as user upward intent.
      typeof sh === "number" && sh > 0 &&
      typeof ch === "number" && ch > 0 &&
      hasOlderItems &&
      !isLoadingOlder &&
      !query &&
      (!scroller?.isStuckToBottom() || scroller?.isUserScrolledUp() || prevTop > OUTLINE_PREPEND_THRESHOLD_PX)
    ) {
      void loadOlderOutlinePage();
    }
  };

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
    setOlderServerState(null);
    setOlderFallbackState(null);
    setIsLoadingOlderServer(false);
    setIsLoadingOlderFallback(false);
    loadingOlderKeyRef.current = null;
    scrollDriverRef.current?.resetTransient();
  }, [sessionViewKey]);

  useEffect(() => () => {
    cancelChatNavigation();
    scrollDriverRef.current?.dispose();
  }, []);

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
        position: "relative" as const,
      },
      listContent: {
        flexGrow: 1,
      },
      loadingOlderPill: {
        position: "absolute" as const,
        top: 6,
        alignSelf: "center" as const,
        zIndex: 5,
        paddingHorizontal: 10,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      loadingOlderText: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
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

  const surfaceRgb = parseRgb(theme.colors.surface0);
  const isDark = surfaceRgb
    ? 0.299 * surfaceRgb.r + 0.587 * surfaceRgb.g + 0.114 * surfaceRgb.b < 128
    : false;

  const handleRowPress = async (row: Row) => {
    const rowKey = row.item_id ?? row.tool_call_id;
    setSelectedId(rowKey);
    const shouldOpenPreview = shouldOpenPreviewDrawerOnRowPress({
      hasDocument,
      openPreviewOnRowClick: effectiveOpenPreviewOnRowClick,
    });
    setHighlightedId((current) =>
      !previewOpen && !shouldOpenPreview && current === rowKey ? null : rowKey,
    );
    if (shouldOpenPreview) {
      openPreviewDrawer();
    }
    if (!hasDocument) {
      return;
    }
    if (activeChild) {
      if (!activeChild.scope_key.startsWith("omp:") || !activeChild.subagent_id) return;
      const opened = await openProviderSubagent((globalThis as any).document, agentId, activeChild.subagent_id, {
        openParent: () => navigation?.openAgent({ agentId }),
      });
      if (!opened) { setNotice("Could not open subagent tab. Inline outline remains available."); return; }
      void scrollToMessageInChat(row, rawRows, {
        visibleOnly: true,
        accentColor: theme.colors.accent,
        isDark,
        onNotFound: () => setNotice("Not loaded in chat"),
      });
      return;
    }
    if (displayOnly && !navigation) {
      setNotice("Main session navigation is unavailable.");
      return;
    }
    void scrollToMessageInChat(row, rawRows, {
      openAgent: displayOnly && navigation ? { agentId, open: () => navigation.openAgent({ agentId }) } : undefined,
      accentColor: theme.colors.accent,
      isDark,
      onStart: () => setNotice((current) => current === "Not loaded in chat" ? null : current),
      onNotFound: () => setNotice("Not loaded in chat"),
    });
  };

  const rowActionsRef = useRef({
    press: handleRowPress,
    hide: (row: Row, mode: "hide" | "summarize") => hideMutation.mutate({ row, mode }),
    unhide: (row: Row) => unhideMutation.mutate(row),
    toggleGroup: toggleGroupExpanded,
    groupBatch: runGroupBatch,
  });
  rowActionsRef.current = {
    press: handleRowPress,
    hide: (row: Row, mode: "hide" | "summarize") => hideMutation.mutate({ row, mode }),
    unhide: (row: Row) => unhideMutation.mutate(row),
    toggleGroup: toggleGroupExpanded,
    groupBatch: runGroupBatch,
  };
  const onPressRow = useCallback((row: Row) => {
    void rowActionsRef.current.press(row);
  }, []);
  const onHideRow = useCallback((row: Row, mode: "hide" | "summarize") => {
    rowActionsRef.current.hide(row, mode);
  }, []);
  const onUnhideRow = useCallback((row: Row) => {
    rowActionsRef.current.unhide(row);
  }, []);
  const onToggleGroup = useCallback((groupId: string, currentlyExpanded: boolean) => {
    rowActionsRef.current.toggleGroup(groupId, currentlyExpanded);
  }, []);
  const onGroupBatch = useCallback(
    (group: OutlineRow & { type: "group" }, action: "hide" | "summarize" | "unhide") => {
      void rowActionsRef.current.groupBatch(group, action);
    },
    [],
  );

  const linkedChildrenByCallId = useMemo(() => {
    const map = new Map<string, ChildScope[]>();
    if (displayOnly || !resolvedScopeKey) return map;
    for (const s of scopes) {
      if (s.tool_call_id) {
        if (map.has(s.tool_call_id)) continue;
        const found = childrenForCall(scopes, resolvedScopeKey, s.tool_call_id).filter(
          (child) => !ancestry.includes(child.scope_key),
        );
        if (found.length > 0) map.set(s.tool_call_id, found);
      }
    }
    return map;
  }, [displayOnly, resolvedScopeKey, scopes, ancestry]);

  const renderLinkedChildList = (linked: readonly ChildScope[]) =>
    linked.map((child) => (
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

  const activeRowKey = previewOpen
    ? (selectedRow?.item_id ?? selectedRow?.tool_call_id ?? null)
    : highlightedId;
  // Both individual rows and group headers follow activeRowKey (1.5s auto-clear unless Preview is open).

  const isResolvingSession = !childScope && effectiveFollowVisible && !followResolved;
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
      ? capabilityNotice(runtimeError, capabilities, {
          provider: agent?.provider ?? null,
          scopeKey: resolvedScopeKey ?? null,
          rowCount: query ? rawRows.length : groupedRows.length,
        })
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

  const settingsButton = !childScope ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open session navigation settings"
      style={styles.iconBtn}
      onPress={() => {
        if (onOpenSettings) onOpenSettings();
        else openSessionNavSettings();
      }}
    >
      {typeof UiIcon === "function" ? (
        <UiIcon name="Settings" size={13} color={theme.colors.foregroundMuted} />
      ) : (
        <Text style={styles.iconBtnText}>⚙</Text>
      )}
    </Pressable>
  ) : null;

  if (!childScope && (effectiveFollowVisible || subagentFallback) && !inView) {
    if (isResolvingSession) {
      return (
        <View style={styles.screen}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.headerTitle}>Outline</Text>
            </View>
            <View style={styles.headerRight}>{settingsButton}</View>
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
          <View style={styles.headerRight}>{settingsButton}</View>
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
          <View style={styles.headerRight}>{settingsButton}</View>
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
          {settingsButton}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh outline"
            accessibilityState={{ disabled: isRefreshing || isLoadingOlder }}
            style={[styles.iconBtn, isRefreshing ? styles.iconBtnActive : null]}
            disabled={isRefreshing || isLoadingOlder}
            onPress={() => void refreshOutline()}
          >
            <Text style={[styles.iconBtnText, isRefreshing ? styles.iconBtnTextActive : null]}>
              {isRefreshing ? "…" : "↻"}
            </Text>
          </Pressable>
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
          {isLoadingOlder ? (
            <View pointerEvents="none" style={styles.loadingOlderPill}>
              <Text style={styles.loadingOlderText}>Loading older items…</Text>
            </View>
          ) : null}
          <ScrollView
            ref={listRef}
            key={sessionViewKey || "outline-list"}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            nestedScrollEnabled={true}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => scrollDriverRef.current?.handleDragStart()}
            onScroll={handleOutlineScroll}
            onScrollEndDrag={handleOutlineScroll}
            onMomentumScrollEnd={handleOutlineScroll}
            onLayout={(ev: any) => scrollDriverRef.current?.handleLayout(listRef.current, ev, scrollState)}
            onContentSizeChange={(_w: number, h: number) =>
              scrollDriverRef.current?.handleContentSizeChange(listRef.current, h, scrollState)
            }
          >
            {groupedRows.map((item) => {
              if (item.type === "group") {
                const linked =
                  linkedChildrenByCallId.size === 0
                    ? EMPTY_LINKED_CHILDREN
                    : item.children
                        .flatMap((c) => linkedChildrenByCallId.get(c.tool_call_id) ?? EMPTY_LINKED_CHILDREN)
                        .filter((c, idx, all) => all.findIndex((o) => o.scope_key === c.scope_key) === idx);
                return (
                  <MemoOutlineRowItem
                    key={item.key}
                    item={item}
                    isSelected={Boolean(
                      activeRowKey &&
                        item.children.some((c) => (c.item_id ?? c.tool_call_id) === activeRowKey),
                    )}
                    isExpanded={!!expandedGroups[item.groupId]}
                    isPending={pendingGroupId === item.groupId}
                    displayOnly={displayOnly}
                    resolvedScopeKey={resolvedScopeKey}
                    capabilities={capabilities}
                    lastActionMode={undefined}
                    compact={layout.compact}
                    hasDocument={hasDocument}
                    theme={theme}
                    styles={styles}
                    linkedChildren={linked.length > 0 ? linked : EMPTY_LINKED_CHILDREN}
                    onPressRow={onPressRow}
                    onToggleGroup={onToggleGroup}
                    onHideRow={onHideRow}
                    onUnhideRow={onUnhideRow}
                    onGroupBatch={onGroupBatch}
                    renderLinkedChildren={linked.length > 0 ? renderLinkedChildList : undefined}
                  />
                );
              }
              const rowKey = item.row.item_id ?? item.row.tool_call_id;
              const linked =
                linkedChildrenByCallId.get(item.row.tool_call_id) ?? EMPTY_LINKED_CHILDREN;
              return (
                <MemoOutlineRowItem
                  key={item.key}
                  item={item}
                  isSelected={activeRowKey === rowKey}
                  isExpanded={false}
                  isPending={false}
                  displayOnly={displayOnly}
                  resolvedScopeKey={resolvedScopeKey}
                  capabilities={capabilities}
                  lastActionMode={lastActionByItem[rowKey]}
                  compact={layout.compact}
                  hasDocument={hasDocument}
                  theme={theme}
                  styles={styles}
                  linkedChildren={linked}
                  onPressRow={onPressRow}
                  onToggleGroup={onToggleGroup}
                  onHideRow={onHideRow}
                  onUnhideRow={onUnhideRow}
                  onGroupBatch={onGroupBatch}
                  renderLinkedChildren={linked.length > 0 ? renderLinkedChildList : undefined}
                />
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
            {hiddenCount > 0 ? `${hiddenCount} hidden · saved ${savedTokens != null ? fmtTokens(savedTokens) : fmtBytes(savedBytes)}` : `${entryCount} entries`}
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
