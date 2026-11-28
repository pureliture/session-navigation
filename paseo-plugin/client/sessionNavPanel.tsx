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
import { actionAllowed, capabilityNotice, selectPausedNotice, type Capabilities } from "./capabilities";
import { focusedSessionTab, readHostFocus, readWebWorkspaceFocusedTab, subscribeHostFocus, type SessionTab } from "./hostCompat";
import { linkedTimelineFetchNeeded, scopeForAgent } from "./subagents";
import {
  FollowSelectionCoordinator,
  acceptWorkspaceAgentId,
  hasDomDocument,
  readSessionTimelinePage,
  resolveSessionTargetProgressive,
  sessionFollowCandidates,
  type FollowCoordinatorUiState,
  type FollowObservation,
  type SessionTimelinePage,
} from "./sessionFollowing";
import {
  stabilizeGroupedRows,
  stabilizeRows,
  visiblePollInterval,
} from "./outlineWindow";
import {
  buildGroupedRows,
  effectiveRowBytes,
  fmtBytes,
  fmtTokenCount,
  fmtTokens,
  groupMutationItems,
  outlineRowKey,
  scopedCountLabel,
  type OutlineRow,
} from "./outlineGrouping";
import { buildFallbackTimelineRows, mergeHermesTimelineRows, mergeLinkedParentRows } from "./fallbackTimeline";
import { readTimelineHistory } from "./timelineHistory";
import { MemoOutlineRowItem, OutlineEmptyState } from "./outlineRows";
import { outlineListInput } from "./outlineListInput";
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
  ...panelProps
}: PluginAgentPanelProps & {
  followVisible?: boolean;
  openPreviewOnRowClick?: boolean;
  onOpenSettings?: () => void;
  candidateAgentIds?: readonly string[];
}) {
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const outlineSettingsState = useOutlineSettings();
  const outlineValues = resolveOutlineSettingsValues(outlineSettingsState);
  const effectiveFollowVisible = followVisible && outlineValues.followVisibleSession;
  const effectiveOpenPreviewOnRowClick =
    openPreviewOnRowClickProp ?? outlineValues.openPreviewOnRowClick;
  const hostProp: unknown =
    "host" in panelProps &&
    typeof panelProps.host === "object" &&
    panelProps.host !== null &&
    "id" in panelProps.host
      ? panelProps.host.id
      : undefined;
  const hostId = typeof hostProp === "string" ? hostProp : "";
  const workspaceProp: unknown = "workspaceId" in panelProps ? panelProps.workspaceId : undefined;
  const panelWorkspaceId = typeof workspaceProp === "string" ? workspaceProp : undefined;
  const hasDocument = hasDomDocument();
  const explicitActiveSupported = "activeAgentId" in panelProps;
  const explicitActiveRaw: unknown = explicitActiveSupported ? panelProps.activeAgentId : undefined;
  const explicitActiveId =
    typeof explicitActiveRaw === "string" && explicitActiveRaw.length > 0 ? explicitActiveRaw : null;
  const latestExplicitActiveRef = useRef({
    supported: explicitActiveSupported,
    agentId: explicitActiveId,
  });
  latestExplicitActiveRef.current = {
    supported: explicitActiveSupported,
    agentId: explicitActiveId,
  };
  const canFollowLive =
    Boolean(paseo?.agents) && (hasDocument || Boolean(hostId) || explicitActiveSupported);
  const startPendingFollow = effectiveFollowVisible && canFollowLive;
  // Paseo binds agent panels to the agent they were opened for; follow whichever session the chat shows instead.
  const followCoordinatorRef = useRef<FollowSelectionCoordinator | null>(null);
  if (!followCoordinatorRef.current) {
    followCoordinatorRef.current = new FollowSelectionCoordinator(
      startPendingFollow,
      params.agentId,
    );
  }
  const followActionBlockedRef = useRef<boolean>(startPendingFollow);
  const probeLiveFollowChangeRef = useRef<(() => boolean) | null>(null);
  const [followedId, setFollowedId] = useState<string | null>(null);
  const [inView, setInView] = useState(() => (startPendingFollow ? false : !!params.agentId));
  const [followUncertain, setFollowUncertain] = useState(false);
  const [followSwitching, setFollowSwitching] = useState(false);
  const [followResolved, setFollowResolved] = useState(() => !startPendingFollow);
  const lastMainAgent = useRef(params.agentId || null);
  const retryFollowRef = useRef<(() => void) | null>(null);
  const agentId = effectiveFollowVisible
    ? inView && !followUncertain && !followSwitching
      ? (followedId ?? params.agentId)
      : ""
    : params.agentId;
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
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dbErrorOpen, setDbErrorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const prevFollowInitKeyRef = useRef(`${params.agentId}\0${effectiveFollowVisible}\0${canFollowLive}`);
  useEffect(() => {
    const nextInitKey = `${params.agentId}\0${effectiveFollowVisible}\0${canFollowLive}`;
    if (prevFollowInitKeyRef.current === nextInitKey) return;
    prevFollowInitKeyRef.current = nextInitKey;
    const resetState = followCoordinatorRef.current!.reset(startPendingFollow, params.agentId);
    followActionBlockedRef.current = resetState.actionBlocked;
    setFollowedId(resetState.agentId === params.agentId ? null : resetState.agentId);
    setInView(resetState.inView);
    setFollowUncertain(resetState.followUncertain);
    setFollowSwitching(resetState.followSwitching);
    setFollowResolved(resetState.followResolved);
    lastMainAgent.current = params.agentId || null;
  }, [params.agentId, effectiveFollowVisible, canFollowLive, startPendingFollow]);
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
    staleTime: 2500,
    refetchInterval: () => visiblePollInterval(10_000),
  });

  const scopes = scopesQuery.data ?? [];
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;
  const scopesSignature = useMemo(
    () =>
      scopes
        .map((s) => `${s.scope_key}|${s.agent_id ?? ""}`)
        .join("\n"),
    [scopes],
  );
  useEffect(() => {
    const doc = "document" in globalThis ? Reflect.get(globalThis, "document") : undefined;
    if (!canFollowLive || !paseo?.agents) return;
    const coordinator = followCoordinatorRef.current!;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const clearTransientOverlays = () => {
      setSelectedId(null);
      setHighlightedId(null);
      setPreviewOpen(false);
      setDbErrorOpen(false);
    };
    const getKnownAgentTimelineIds = (id: string): readonly string[] | undefined => {
      const completeEntry = queryClient.getQueryData<{ ids: string[]; complete: boolean }>([
        "session-nav-follow",
        id,
      ]);
      if (completeEntry?.ids?.length) return completeEntry.ids;
      const tailEntry = queryClient.getQueryData<SessionTimelinePage>([
        "session-nav-follow-tail",
        id,
      ]);
      return tailEntry?.ids;
    };
    const applyCoordinatorUiState = (next: FollowCoordinatorUiState) => {
      followActionBlockedRef.current = next.actionBlocked;
      setFollowSwitching(next.followSwitching);
      setInView(next.inView);
      setFollowUncertain(next.followUncertain);
      if (next.agentId) lastMainAgent.current = next.agentId;
      setFollowedId(next.agentId === params.agentId ? null : next.agentId);
      setFollowResolved(next.followResolved);
    };
    // Web: DOM tab wins; layout-state and workspace-verified heartbeat focus back up compact/empty chats.
    const readFocusedTab = (): SessionTab | null => {
      const dom = focusedSessionTab(doc, undefined, candidateAgentIds);
      const layoutTab =
        hostId && panelWorkspaceId ? readWebWorkspaceFocusedTab(hostId, panelWorkspaceId) : null;
      if (dom) {
        const domAgentId = dom.agentId;
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
      const liveExplicit = latestExplicitActiveRef.current;
      const candidateId = liveExplicit.supported
        ? liveExplicit.agentId
        : hostId
          ? readHostFocus(hostId).focusedAgentId
          : null;
      if (!candidateId) return null;
      const verdict = acceptWorkspaceAgentId({
        agentId: candidateId,
        workspaceCandidateIds: candidateAgentIds,
        panelWorkspaceId,
      });
      return verdict === "accept" || (verdict === "unknown" && !panelWorkspaceId)
        ? { kind: "agent", agentId: candidateId }
        : null;
    };
    const readWebObservation = (): FollowObservation => {
      const focusTab = readFocusedTab();
      if (focusTab?.kind === "agent") {
        return { tab: focusTab, visibleValues: null };
      }
      const values = visibleChatValues(doc);
      const recheckedTab = readFocusedTab();
      if (recheckedTab?.kind === "agent") {
        return { tab: recheckedTab, visibleValues: null };
      }
      return { tab: recheckedTab, visibleValues: values };
    };
    const readNativeFocusSignal = () => {
      const liveExplicit = latestExplicitActiveRef.current;
      const hostFocus = hostId
        ? readHostFocus(hostId)
        : { supported: false, focusedAgentId: null, hasSignal: false };
      const hasSignal = liveExplicit.supported || (hostFocus.supported && hostFocus.hasSignal);
      const targetId = liveExplicit.supported ? liveExplicit.agentId : hostFocus.focusedAgentId;
      return { hasSignal, targetId };
    };
    const readLiveNativeObservation = (): FollowObservation => {
      const { hasSignal, targetId } = readNativeFocusSignal();
      if (!effectiveFollowVisible || !hasSignal) {
        return params.agentId
          ? { tab: { kind: "agent", agentId: params.agentId }, visibleValues: null }
          : { tab: null, visibleValues: null };
      }
      return {
        tab: targetId ? { kind: "agent", agentId: targetId } : null,
        visibleValues: null,
      };
    };
    const applyLiveSuspension = (showSwitchingUi: boolean, blocked: boolean) => {
      clearRetryTimer();
      followActionBlockedRef.current = blocked;
      if (showSwitchingUi) {
        clearTransientOverlays();
        setFollowSwitching(true);
      }
    };

    let rafId: number | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTick = () => {
      if (cancelled) return;
      if (debounceTimer !== null) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (cancelled) return;
        if (typeof requestAnimationFrame === "function") {
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (!cancelled) void runTick();
          });
        } else {
          void runTick();
        }
      }, 60);
    };

    const handleLiveChange = (scheduleIfChanged: boolean): boolean => {
      if (cancelled || !effectiveFollowVisible) return coordinator.getState().actionBlocked;
      if (hasDocument) {
        const res = coordinator.observeLiveChange(
          readWebObservation(),
          effectiveFollowVisible,
          getKnownAgentTimelineIds,
        );
        if (res.invalidatedInFlight || res.enteredSwitching) {
          applyLiveSuspension(res.enteredSwitching, res.state.actionBlocked);
          if (scheduleIfChanged) scheduleTick();
        }
        return res.state.actionBlocked;
      }
      const { hasSignal, targetId } = readNativeFocusSignal();
      if (!hasSignal) return coordinator.getState().actionBlocked;
      if (targetId !== null) {
        const verdict = acceptWorkspaceAgentId({
          agentId: targetId,
          workspaceCandidateIds: candidateAgentIds,
          panelWorkspaceId,
        });
        if (verdict !== "accept") {
          return coordinator.getState().actionBlocked;
        }
      }
      const res = coordinator.observeLiveChange(
        {
          tab: targetId ? { kind: "agent", agentId: targetId } : null,
          visibleValues: null,
        },
        effectiveFollowVisible,
      );
      if (res.invalidatedInFlight || res.enteredSwitching) {
        applyLiveSuspension(res.enteredSwitching, res.state.actionBlocked);
        if (scheduleIfChanged) scheduleTick();
      }
      return res.state.actionBlocked;
    };
    probeLiveFollowChangeRef.current = () => handleLiveChange(true);

    const applySelection = async (
      startObs: FollowObservation,
      readLiveObs: () => FollowObservation,
      followUpDepth = 0,
    ) => {
      const attempt = coordinator.beginAttempt(
        startObs,
        effectiveFollowVisible,
        getKnownAgentTimelineIds,
      );
      if (attempt.kind === "dedup") return;

      const needsTimelineScan =
        effectiveFollowVisible &&
        startObs.tab?.kind !== "agent" &&
        Boolean(startObs.visibleValues && startObs.visibleValues.length > 0);
      if (attempt.enteredSwitching) {
        applyLiveSuspension(needsTimelineScan, attempt.state.actionBlocked);
      }

      const currentScopes = scopesRef.current;
      let followResult: Awaited<ReturnType<typeof resolveSessionTargetProgressive>> | null = null;
      try {
        if (needsTimelineScan) {
          followResult = await resolveSessionTargetProgressive({
            followVisible: effectiveFollowVisible,
            boundAgentId: params.agentId,
            visibleValues: [...(startObs.visibleValues ?? [])],
            candidates: sessionFollowCandidates(
              candidateAgentIds,
              currentScopes.map((s) => s.agent_id).filter((id): id is string => !!id),
            ),
            getCachedTimelineIds: (id) => {
              const entry = queryClient.getQueryData<{ ids: string[]; complete: boolean }>([
                "session-nav-follow",
                id,
              ]);
              const state = queryClient.getQueryState(["session-nav-follow", id]);
              if (!entry?.complete || !state?.dataUpdatedAt) return undefined;
              if (Date.now() - state.dataUpdatedAt > 10_000) return undefined;
              return entry;
            },
            getCachedTailPage: (id) => {
              const entry = queryClient.getQueryData<SessionTimelinePage>([
                "session-nav-follow-tail",
                id,
              ]);
              const state = queryClient.getQueryState(["session-nav-follow-tail", id]);
              if (!entry || !state?.dataUpdatedAt) return undefined;
              if (Date.now() - state.dataUpdatedAt > 4_000) return undefined;
              return entry;
            },
            loadPage: (id, cursor) => readSessionTimelinePage(paseo.agents.ref(id).timeline, cursor),
            onTailLoaded: (id, page) => {
              queryClient.setQueryData(["session-nav-follow-tail", id], page);
            },
            onCompleteTimelineIds: (id, ids) => {
              queryClient.setQueryData(["session-nav-follow", id], { ids, complete: true });
            },
            isStale: () => cancelled || !coordinator.isCurrent(attempt.generation),
          });
        } else if (!effectiveFollowVisible) {
          followResult = {
            targetId: params.agentId || null,
            confirmed: true,
            incompleteIds: [],
            failedIds: [],
          };
        } else if (startObs.tab?.kind !== "agent") {
          followResult = {
            targetId: null,
            confirmed: true,
            incompleteIds: [],
            failedIds: [],
          };
        }
      } catch {
        coordinator.abortAttempt(attempt.generation);
        return;
      }

      if (cancelled) {
        coordinator.abortAttempt(attempt.generation);
        return;
      }

      const outcome = coordinator.commitAttempt({
        generation: attempt.generation,
        startObservation: startObs,
        startSnapshotKey: attempt.snapshotKey,
        liveObservation: readLiveObs(),
        followVisible: effectiveFollowVisible,
        followResult,
        boundAgentId: params.agentId,
        getKnownAgentTimelineIds,
      });

      if (!outcome.committed) {
        if (outcome.enteredSwitching) {
          applyLiveSuspension(true, outcome.state.actionBlocked);
        }
        if (outcome.needsFollowUp && !cancelled) {
          if (followUpDepth < 2) {
            void runTick(followUpDepth + 1);
          } else {
            scheduleTick();
          }
        }
        return;
      }

      if (!outcome.state.retryable) {
        clearRetryTimer();
      } else {
        for (const failedId of outcome.state.failedIds) {
          queryClient.removeQueries({
            queryKey: ["session-nav-follow-tail", failedId],
            exact: true,
          });
        }
        clearTransientOverlays();
        if (retryTimer === null) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!cancelled) void runTick();
          }, 1500);
        }
      }
      applyCoordinatorUiState(outcome.state);
    };

    const tick = async (followUpDepth = 0) => {
      if (cancelled) return;
      if (!hasDocument) {
        const { hasSignal, targetId } = readNativeFocusSignal();
        if (effectiveFollowVisible && hasSignal) {
          if (targetId === null) {
            await applySelection(
              { tab: null, visibleValues: null },
              readLiveNativeObservation,
              followUpDepth,
            );
            return;
          }
          let verdict = acceptWorkspaceAgentId({
            agentId: targetId,
            workspaceCandidateIds: candidateAgentIds,
            panelWorkspaceId,
          });
          if (verdict === "unknown") {
            const preRefreshGen = coordinator.getGeneration();
            try {
              const handle = paseo.agents.ref(targetId);
              await handle.refresh();
              if (cancelled || !coordinator.isCurrent(preRefreshGen)) return;
              const liveNow = readLiveNativeObservation();
              if (liveNow.tab?.agentId !== targetId) {
                scheduleTick();
                return;
              }
              verdict = acceptWorkspaceAgentId({
                agentId: targetId,
                workspaceCandidateIds: candidateAgentIds,
                agentWorkspaceId: handle.current()?.workspaceId ?? null,
                panelWorkspaceId,
              });
            } catch {
              verdict = "reject";
            }
          }
          if (cancelled) return;
          if (verdict !== "accept") {
            if (!coordinator.getState().followResolved) {
              const fallbackObs: FollowObservation = params.agentId
                ? { tab: { kind: "agent", agentId: params.agentId }, visibleValues: null }
                : { tab: null, visibleValues: null };
              await applySelection(fallbackObs, () => fallbackObs, followUpDepth);
            }
            return;
          }
          await applySelection(
            { tab: { kind: "agent", agentId: targetId }, visibleValues: null },
            readLiveNativeObservation,
            followUpDepth,
          );
          return;
        }
        const pinnedObs: FollowObservation = params.agentId
          ? { tab: { kind: "agent", agentId: params.agentId }, visibleValues: null }
          : { tab: null, visibleValues: null };
        await applySelection(pinnedObs, readLiveNativeObservation, followUpDepth);
        return;
      }

      const startObs = readWebObservation();
      await applySelection(startObs, readWebObservation, followUpDepth);
    };

    const runTick = async (followUpDepth = 0) => {
      if (cancelled) return;
      await tick(followUpDepth);
    };

    retryFollowRef.current = () => {
      if (!cancelled) {
        clearRetryTimer();
        void runTick();
      }
    };

    const onLiveEvent = () => {
      if (cancelled) return;
      handleLiveChange(false);
      scheduleTick();
    };
    const unsubscribe = hostId ? subscribeHostFocus(hostId, onLiveEvent) : () => {};
    let observer: { disconnect: () => void } | null = null;
    const ObserverCtor = (globalThis as Record<string, any>).MutationObserver;
    const observeRoot = (doc as any)?.body ?? (doc as any)?.documentElement;
    if (hasDocument && typeof ObserverCtor === "function" && observeRoot) {
      try {
        const instance = new ObserverCtor(onLiveEvent);
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
    const onUiActivity = () => onLiveEvent();
    const onKeyUp = (ev: any) => {
      const target = ev?.target;
      const tag = typeof target?.tagName === "string" ? target.tagName.toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      onLiveEvent();
    };
    if (hasDocument && typeof (doc as any)?.addEventListener === "function") {
      (doc as any).addEventListener("click", onUiActivity, true);
      (doc as any).addEventListener("keyup", onKeyUp, true);
    }
    if (win && typeof win.addEventListener === "function") {
      win.addEventListener("popstate", onUiActivity);
      win.addEventListener("focus", onUiActivity);
    }
    void runTick();
    const timer = hasDocument
      ? setInterval(() => {
          if ((doc as any)?.visibilityState === "hidden" || (doc as any)?.hidden === true) {
            return;
          }
          void runTick();
        }, 3000)
      : undefined;
    return () => {
      cancelled = true;
      retryFollowRef.current = null;
      probeLiveFollowChangeRef.current = null;
      coordinator.invalidateInFlight();
      clearRetryTimer();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (rafId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      observer?.disconnect();
      if (hasDocument && typeof (doc as any)?.removeEventListener === "function") {
        (doc as any).removeEventListener("click", onUiActivity, true);
        (doc as any).removeEventListener("keyup", onKeyUp, true);
      }
      if (win && typeof win.removeEventListener === "function") {
        win.removeEventListener("popstate", onUiActivity);
        win.removeEventListener("focus", onUiActivity);
      }
      unsubscribe();
      clearInterval(timer);
    };
  }, [
    paseo,
    params.agentId,
    scopesSignature,
    queryClient,
    effectiveFollowVisible,
    candidateAgentIds,
    hasDocument,
    hostId,
    panelWorkspaceId,
    canFollowLive,
    explicitActiveSupported,
    explicitActiveId,
  ]);
  const parentScopeKey = scopeForAgent(scopes, agentId);

  const resolvedScopeKey = parentScopeKey;
  const canMutateSession =
    Boolean(resolvedScopeKey) &&
    (!effectiveFollowVisible || (inView && !followUncertain && !followSwitching));
  const isMutationAllowedNow = () => {
    if (!canMutateSession || followActionBlockedRef.current) return false;
    if (effectiveFollowVisible && probeLiveFollowChangeRef.current?.()) {
      return false;
    }
    return true;
  };

  const scopeKey = resolvedScopeKey ?? "";
  const query = tabState.query;
  const sessionViewKey = `${agentId || ""}::${resolvedScopeKey || ""}`;
  const sessionViewKeyRef = useRef(sessionViewKey);
  sessionViewKeyRef.current = sessionViewKey;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "scopes"] });
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
    if (!result.ok && result.error === "session_unconfirmed") {
      setNotice("Session changed — action paused until confirmed.");
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
      if (!isMutationAllowedNow() || !actionAllowed(row, capabilities, mode)) {
        return { rowKey, prevActionMode: undefined, changed: false };
      }
      const prevActionMode = lastActionByItem[rowKey];
      setLastActionByItem((prev) => ({ ...prev, [rowKey]: mode }));
      return { rowKey, prevActionMode, changed: true };
    },
    mutationFn: ({ row, mode }: { row: Row; mode: "hide" | "summarize" }) => {
      if (!isMutationAllowedNow()) {
        return Promise.resolve({ ok: false, error: "session_unconfirmed" });
      }
      if (!actionAllowed(row, capabilities, mode)) {
        return Promise.resolve({ ok: false, error: "capability_unavailable" });
      }
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
    mutationFn: (row: Row) => {
      if (!isMutationAllowedNow()) {
        return Promise.resolve({ ok: false, error: "session_unconfirmed" });
      }
      return unhideRpc({ scope_key: scopeKey, item_id: row.item_id ?? "", expected_version: row.version });
    },
    onSuccess: (r, row) => {
      if (!onMutationError(r)) {
        setNotice(null);
        notePending([row], 1);
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
    }) => {
      if (!isMutationAllowedNow()) {
        return Promise.resolve({
          ok: false,
          applied: 0,
          failed: 0,
          items: [],
          error: "session_unconfirmed",
        });
      }
      return hideBatch(vars);
    },
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
    }) => {
      if (!isMutationAllowedNow()) {
        return Promise.resolve({
          ok: false,
          applied: 0,
          failed: 0,
          items: [],
          error: "session_unconfirmed",
        });
      }
      return unhideBatch(vars);
    },
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
    if (pendingGroupId || !isMutationAllowedNow() || !resolvedScopeKey) return;
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
      if (!scopeKey) {
        return {
          items: [] as Row[],
          context: undefined,
          capabilities: undefined,
          server_timeline: false,
          records_capped: false,
          totals: undefined,
        };
      }
      const result = await listRpc(outlineListInput(scopeKey, query));
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
        paused: result.paused === true,
        paused_warning: typeof result.paused_warning === "string" ? result.paused_warning : undefined,
        totals: result.totals,
      };
    },
    enabled: !!resolvedScopeKey,
    staleTime: 500,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[2] === scopeKey ? previousData : undefined,
    refetchInterval: () => visiblePollInterval(isMutating ? 400 : 4000),
  });

  // Same source as Paseo's own context meter (the `K` figure), for every provider.
  const capabilities: Capabilities | undefined = useMemo(
    () =>
      listQuery.data?.capabilities ??
      scopes.find((scope) => scope.scope_key === resolvedScopeKey)?.capabilities,
    [listQuery.data?.capabilities, scopes, resolvedScopeKey],
  );
  const usageQuery = useQuery({
    queryKey: ["paseo-agent-usage", agentId],
    queryFn: async () => {
      if (!agentId || !paseo?.agents) return null;
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      return handle.lastUsage ?? null;
    },
    refetchInterval: () => visiblePollInterval(5000),
  });

  const isHermesScope = Boolean(resolvedScopeKey?.startsWith("hermes:"));
  const hasServerTimeline = Boolean(listQuery.data?.server_timeline);
  const needsHermesFallbackMerge = isHermesScope && !hasServerTimeline;
  const needsLinkedTimeline = linkedTimelineFetchNeeded(
    listQuery.data !== undefined,
    resolvedScopeKey,
    listQuery.data?.items ?? [],
    scopes,
  );
  const fallbackTimelineQuery = useQuery({
    queryKey: ["paseo-agent-timeline", agentId],
    queryFn: async () => {
      if (!agentId || !paseo?.agents) return { rows: [] as Row[], complete: true };
      try {
        const history = await queryClient.fetchQuery({
          queryKey: ["paseo-agent-timeline-history", agentId],
          staleTime: (entry) => (entry.state.data?.complete ? 10_000 : 0),
          queryFn: () => readTimelineHistory(paseo.agents.ref(agentId).timeline, { allowPartial: true }),
        });
        return { rows: buildFallbackTimelineRows(history.entries), complete: history.complete };
      } catch {
        return { rows: [] as Row[], complete: false };
      }
    },
    enabled:
      (!resolvedScopeKey ||
        (isHermesScope && listQuery.data !== undefined && !listQuery.data.server_timeline) ||
        needsLinkedTimeline) &&
      !!agentId,
    refetchInterval: () => visiblePollInterval(5000),
  });

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["session-nav", "list"] });
  }, [scopeKey, queryClient]);

  const serverRows = listQuery.data?.items ?? [];
  const fallbackComplete = fallbackTimelineQuery.data?.complete === true;
  const fallbackRows = fallbackTimelineQuery.data?.rows ?? [];

  // Linked in-flight parent rows (task/delegate_task without a toolResult
  // yet) merge on top of the server list even when the server owns a
  // timeline: mergeLinkedParentRows only appends rows whose tool_call_id is
  // missing from the server list and owns linked children, so authoritative
  // rows are untouched. No child rows or tabs are rendered.
  const rawRows = useMemo(
    () =>
      resolvedScopeKey
        ? needsHermesFallbackMerge
          ? mergeHermesTimelineRows(serverRows, fallbackRows, scopes, resolvedScopeKey, fallbackComplete)
          : mergeLinkedParentRows(serverRows, fallbackRows, scopes, resolvedScopeKey)
        : fallbackRows,
    [
      resolvedScopeKey,
      serverRows,
      needsHermesFallbackMerge,
      fallbackRows,
      fallbackComplete,
      scopes,
    ],
  );
  const prevRowsRef = useRef<Row[]>([]);
  const rows = useMemo(() => {
    const filtered = !query
      ? rawRows
      : rawRows.filter((r) => {
          const q = query.toLowerCase();
          return (
            (r.item_id && r.item_id.toLowerCase().includes(q)) ||
            (r.tool_name && r.tool_name.toLowerCase().includes(q)) ||
            (r.summary_line && r.summary_line.toLowerCase().includes(q)) ||
            (r.tool_input && r.tool_input.toLowerCase().includes(q)) ||
            (r.tool_call_id && r.tool_call_id.toLowerCase().includes(q))
          );
        });
    const stabilized = stabilizeRows(prevRowsRef.current, filtered);
    prevRowsRef.current = stabilized;
    return stabilized;
  }, [rawRows, query]);

  const rowIndexByRow = useMemo(() => {
    const map = new WeakMap<Row, number>();
    for (let i = 0; i < rows.length; i++) map.set(rows[i], i);
    return map;
  }, [rows]);

  const rowByKey = useMemo(() => {
    const map = new Map<string, Row>();
    for (let i = 0; i < rows.length; i++) {
      const k = outlineRowKey(rows[i], i);
      if (!map.has(k)) map.set(k, rows[i]);
    }
    return map;
  }, [rows]);

  const prevGroupedRef = useRef<OutlineRow[]>([]);
  const groupedRows = useMemo(() => {
    const next = buildGroupedRows(rows, expandedGroups, lastActionByItem);
    const stabilized = stabilizeGroupedRows(prevGroupedRef.current, next);
    prevGroupedRef.current = stabilized;
    return stabilized;
  }, [rows, expandedGroups, lastActionByItem]);

  const groupIdByChildKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of groupedRows) {
      if (item.type !== "group") continue;
      for (const child of item.children) {
        const idx = rowIndexByRow.get(child) ?? rows.indexOf(child);
        map.set(outlineRowKey(child, idx), item.groupId);
      }
    }
    return map;
  }, [groupedRows, rowIndexByRow, rows]);

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
  // B8: unscoped totals for the footer count label. The loaded list totals
  // are authoritative when present; otherwise the unfiltered rows are.
  const unscopedTotals = listQuery.data?.totals;
  const totalEntries = unscopedTotals?.total_rows ?? rawRows.length;
  const totalHidden = useMemo(
    () => unscopedTotals?.hidden_count ?? rawRows.filter((r) => r.status === "hidden").length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unscopedTotals, rawRows],
  );
  const entryCount =
    serverTotals && !needsHermesFallbackMerge
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
    if (!selectedId) return null;
    return rowByKey.get(selectedId) ?? null;
  }, [rowByKey, selectedId]);

  const listRef = useRef<any>(null);
  const scrollDriverRef = useRef<OutlineScrollDriver | null>(null);
  if (!scrollDriverRef.current) {
    scrollDriverRef.current = new OutlineScrollDriver();
  }
  const hermesSettledKeyRef = useRef<string | null>(null);

  const isSessionHiddenFromView =
    effectiveFollowVisible && (!inView || followUncertain || followSwitching);
  const isOutlineListMounted = !isSessionHiddenFromView && groupedRows.length > 0;
  scrollDriverRef.current.syncSession(sessionViewKey, isOutlineListMounted);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshOutline = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      cancelChatNavigation();
      setNotice(null);
      setSelectedId(null);
      setHighlightedId(null);
      setPreviewOpen(false);
      setExpandedGroups({});
      setPendingGroupId(null);
      scrollDriverRef.current?.resetTransient();
      await Promise.all(
        outlineRefreshQueryKeys(agentId).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [agentId, isRefreshing, queryClient]);

  const handleOutlineScroll = (ev: any) => {
    scrollDriverRef.current?.handleScrollEvent(ev);
  };


  if (needsHermesFallbackMerge && !fallbackTimelineQuery.isFetching && fallbackTimelineQuery.data !== undefined) {
    hermesSettledKeyRef.current = sessionViewKey;
  }

  const isLoading = resolvedScopeKey
    ? (listQuery.isPending && listQuery.fetchStatus !== "idle") ||
      ((needsHermesFallbackMerge || needsLinkedTimeline) &&
        fallbackTimelineQuery.isPending &&
        fallbackTimelineQuery.fetchStatus !== "idle")
    : !!agentId && fallbackTimelineQuery.isPending && fallbackTimelineQuery.fetchStatus !== "idle";

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

  const jumpToLatest = () => {
    scrollDriverRef.current?.jumpToLatest(listRef.current, scrollState, Date.now());
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
        width: layout.compact ? 30 : 32,
        height: layout.compact ? 30 : 32,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
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
    // Outline keys (not raw item ids): fallback rows share item_id null and
    // often an empty tool_call_id, so raw ids collide across rows.
    const rowIdx = rowIndexByRow.get(row) ?? rows.indexOf(row);
    const rowKey = outlineRowKey(row, rowIdx);
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
    void scrollToMessageInChat(row, rawRows, {
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

  const activeRowKey = previewOpen ? selectedId : highlightedId;
  // Both individual rows and group headers follow activeRowKey (1.5s auto-clear unless Preview is open).
  const selectedGroupId = activeRowKey ? (groupIdByChildKey.get(activeRowKey) ?? null) : null;

  const isResolvingSession = effectiveFollowVisible && (!followResolved || followSwitching);
  const isCapabilitiesLoading =
    isResolvingSession || scopesQuery.isPending || (!!resolvedScopeKey && listQuery.isPending && !capabilities);
  const runtimeError =
    listQuery.error instanceof Error
      ? listQuery.error.message
      : scopesQuery.error instanceof Error
        ? scopesQuery.error.message
        : undefined;
  const capabilityMessage =
    runtimeError || (!isCapabilitiesLoading && inView && !followSwitching && !followUncertain && Boolean(agentId))
      ? capabilityNotice(runtimeError, capabilities, {
          provider: agent?.provider ?? null,
          scopeKey: resolvedScopeKey ?? null,
          rowCount: query ? rawRows.length : groupedRows.length,
        })
      : null;

  const capNotice = listQuery.data?.records_capped === true && !notice && !capabilityMessage
    ? "Large session: oldest tool controls omitted"
    : null;
  // B10: paused-adapter warning (P1-7 parity) renders as its own banner line
  // above the generic capability notice; existing notices are unchanged.
  const pausedNotice = selectPausedNotice(listQuery.data);
  const noticeBar = notice || capabilityMessage || capNotice || pausedNotice ? (
    <View accessibilityRole="alert" style={styles.noticeBar}>
      {pausedNotice ? <Text style={styles.noticeText}>{pausedNotice}</Text> : null}
      {notice || capabilityMessage || capNotice ?
        <Text style={styles.noticeText}>{notice ?? capabilityMessage ?? capNotice}</Text> : null}
    </View>
  ) : null;

  const settingsButton = (
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
  );

  if (effectiveFollowVisible && (!inView || followUncertain || followSwitching)) {
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
            <Text style={styles.emptyText}>
              {followSwitching ? "Switching session…" : "Loading outline…"}
            </Text>
          </View>
        </View>
      );
    }
    if (followUncertain) {
      return (
        <View style={styles.screen}>
          {noticeBar}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.headerTitle}>Outline</Text>
            </View>
            <View style={styles.headerRight}>{settingsButton}</View>
          </View>
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 10 }}>
            <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted, fontWeight: "600" }}>
              Unable to confirm visible session
            </Text>
            <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "center", lineHeight: 16 }}>
              History fetch failed while matching the visible chat. Context actions are paused to prevent editing another session.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry session match"
              style={styles.actionBtnPrimary}
              onPress={() => retryFollowRef.current?.()}
            >
              <Text style={styles.actionBtnPrimaryText}>Retry</Text>
            </Pressable>
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
        <OutlineEmptyState
          theme={theme}
          styles={styles}
          agentLabel={agent?.title ?? agentId.slice(0, 8)}
          error={runtimeError ?? null}
          isRefreshing={isRefreshing}
          onRefresh={() => void refreshOutline()}
          settingsButton={settingsButton}
        />
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
          {settingsButton}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest row"
            accessibilityHint="Moves to the newest row and resumes automatic following"
            style={styles.iconBtn}
            onPress={jumpToLatest}
          >
            <Text style={styles.iconBtnText}>↓</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh outline"
            accessibilityState={{ disabled: isRefreshing }}
            style={[styles.iconBtn, isRefreshing ? styles.iconBtnActive : null]}
            disabled={isRefreshing}
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
            onLayout={(ev: any) =>
              scrollDriverRef.current?.handleLayout(listRef.current, ev, scrollState)
            }
            onContentSizeChange={(_w: number, h: number) =>
              scrollDriverRef.current?.handleContentSizeChange(listRef.current, h, scrollState)
            }
          >
            {groupedRows.map((item) => {
              if (item.type === "group") {
                return (
                  <MemoOutlineRowItem
                    key={item.key}
                    item={item}
                    isSelected={selectedGroupId === item.groupId}
                    isExpanded={!!expandedGroups[item.groupId]}
                    isPending={pendingGroupId === item.groupId}
                    resolvedScopeKey={resolvedScopeKey}
                    capabilities={capabilities}
                    lastActionMode={undefined}
                    compact={layout.compact}
                    hasDocument={hasDocument}
                    theme={theme}
                    styles={styles}
                    onPressRow={onPressRow}
                    onToggleGroup={onToggleGroup}
                    onHideRow={onHideRow}
                    onUnhideRow={onUnhideRow}
                    onGroupBatch={onGroupBatch}
                  />
                );
              }
              const rowKey = item.key;
              return (
                <MemoOutlineRowItem
                  key={item.key}
                  item={item}
                  isSelected={activeRowKey === rowKey}
                  isExpanded={false}
                  isPending={false}
                  resolvedScopeKey={resolvedScopeKey}
                  capabilities={capabilities}
                  lastActionMode={lastActionByItem[rowKey]}
                  compact={layout.compact}
                  hasDocument={hasDocument}
                  theme={theme}
                  styles={styles}
                  onPressRow={onPressRow}
                  onToggleGroup={onToggleGroup}
                  onHideRow={onHideRow}
                  onUnhideRow={onUnhideRow}
                  onGroupBatch={onGroupBatch}
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
            {hiddenCount > 0 ? `${scopedCountLabel(hiddenCount, totalHidden, "hidden")} · saved ${savedTokens != null ? fmtTokens(savedTokens) : fmtBytes(savedBytes)}` : scopedCountLabel(entryCount, totalEntries, "entries")}
          </Text>
        </View>
      </View>

      <PreviewDrawer row={selectedRow} open={previewOpen} onToggle={togglePreviewDrawer} theme={theme} />

      {/* DB Error Overlay */}
      {dbErrorOpen && canMutateSession ? (
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
                  if (!isMutationAllowedNow() || !scopeKey) return;
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
                  if (!isMutationAllowedNow() || !scopeKey) return;
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
