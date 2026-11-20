import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useTabState } from "@getpaseo/plugin/client";
import { Icon as UiIcon, ScrollView as UiScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView as RnScrollView, Text, View } from "react-native";
import { listScopesRpc } from "../shared/sessionNav";
import { demandedWorkspaceAgents, readHostFocus, subscribeHostFocus } from "./hostCompat";
import { resolveOutlineSettingsValues, useOutlineSettings } from "./outlineSettingsHook";
import { openSessionNavSettings } from "./registration";
import { acceptWorkspaceAgentId, boundRootSessions, hasDomDocument, nextWorkspaceTrackedAgent, resolveWorkspaceSessionState, workspaceHeaderText } from "./sessionFollowing";
import { SessionNavPanel } from "./sessionNavPanel";
import { listWorkspaceAgents } from "./workspaceAgents";
import { defaultWorkspaceState, selectWorkspaceAgent, workspaceTabSchema } from "./workspaceState";

// Host supplies client/ui implementations at runtime; tests see the empty package stub.
const ScrollView = UiScrollView ?? RnScrollView;

export function WorkspaceNavPanel(props: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const hasDocument = hasDomDocument();
  const [state, setState] = useTabState(props.tab, workspaceTabSchema, defaultWorkspaceState);
  const [choosing, setChoosing] = useState(false);
  const outlineSettingsState = useOutlineSettings();
  const { followVisibleSession } = resolveOutlineSettingsValues(outlineSettingsState);
  const agents = useQuery({
    queryKey: ["session-nav", "workspace-agents", props.host.id, props.workspaceId],
    queryFn: ({ signal }) => listWorkspaceAgents(paseo, props.workspaceId, signal),
    enabled: choosing || !state.agentId || !hasDocument,
    refetchInterval: 15_000,
  });
  const selected = agents.data?.find((agent) => agent.id === state.agentId);
  const candidateAgentIds = useMemo(() => agents.data?.map((agent) => agent.id), [agents.data]);
  const scopesRpc = useRpc(listScopesRpc);
  const scopesQuery = useQuery({
    queryKey: ["session-nav", "scopes"],
    queryFn: async () => {
      const result = await scopesRpc({});
      if (!result.ok) throw new Error(result.error ?? "scopes_failed");
      return result.scopes;
    },
    refetchInterval: 3000,
  });

  // Feature-detection for a host-provided active agent id (older hosts omit the prop entirely).
  const activeProp: unknown = "activeAgentId" in props ? props.activeAgentId : undefined;
  const explicitActiveId = typeof activeProp === "string" ? activeProp : null;
  const explicitActiveSupported = "activeAgentId" in props;

  const [hostFocus, setHostFocus] = useState(() => readHostFocus(props.host.id));
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    setHostFocus(readHostFocus(props.host.id));
    return subscribeHostFocus(props.host.id, () => {
      setHostFocus(readHostFocus(props.host.id));
      setFocusTick((tick) => tick + 1);
    });
  }, [props.host.id]);

  const rawFocusedId = explicitActiveSupported ? explicitActiveId : hostFocus.focusedAgentId;
  const rawHasSignal = explicitActiveSupported || hostFocus.hasSignal;
  const trackerSupported = explicitActiveSupported || hostFocus.supported;
  const membership = acceptWorkspaceAgentId({
    agentId: rawFocusedId,
    workspaceCandidateIds: candidateAgentIds,
    panelWorkspaceId: props.workspaceId,
  });
  const workspaceLookup = useQuery({
    queryKey: ["session-nav-agent-workspace", props.host.id, rawFocusedId],
    queryFn: async () => {
      if (!rawFocusedId) return null;
      const handle = paseo.agents.ref(rawFocusedId);
      await handle.refresh();
      return handle.current()?.workspaceId ?? null;
    },
    enabled: rawFocusedId !== null && membership === "unknown",
  });

  const lastValidRef = useRef<string | null>(null);
  const [trackedAgentId, setTrackedAgentId] = useState<string | null>(null);
  // Stale focus from the previous workspace must never carry over: reset the
  // last-valid/tracked selection when the panel moves workspaces.
  const [prevWorkspaceId, setPrevWorkspaceId] = useState(props.workspaceId);
  const workspaceChanged = prevWorkspaceId !== props.workspaceId;
  if (workspaceChanged) {
    setPrevWorkspaceId(props.workspaceId);
  }
  useEffect(() => {
    const next = nextWorkspaceTrackedAgent({
      rawFocusedId,
      rawHasSignal,
      membership,
      candidateAgentIds,
      panelWorkspaceId: props.workspaceId,
      lookupWorkspaceId: workspaceLookup.data ?? null,
      lookupLoaded: workspaceLookup.data !== undefined,
      workspaceChanged,
      lastValid: workspaceChanged ? null : lastValidRef.current,
      tracked: trackedAgentId,
    });
    lastValidRef.current = next.lastValid;
    if (next.tracked !== trackedAgentId) {
      setTrackedAgentId(next.tracked);
    }
  }, [rawFocusedId, rawHasSignal, membership, candidateAgentIds, props.workspaceId, workspaceLookup.data, workspaceChanged, trackedAgentId]);

  const boundSessions = useMemo(
    () => boundRootSessions(scopesQuery.data ?? [], candidateAgentIds),
    [scopesQuery.data, candidateAgentIds],
  );
  const demandedIds = useMemo(
    () => candidateAgentIds ? demandedWorkspaceAgents(props.host.id, candidateAgentIds) : [],
    [props.host.id, candidateAgentIds, focusTick],
  );
  const resolution = resolveWorkspaceSessionState({
    pinnedAgentId: state.agentId,
    trackedAgentId,
    hasTrackerSignal: rawHasSignal,
    trackerSupported,
    hasDocument,
    demandedAgentIds: demandedIds,
    boundSessions,
    workspaceAgentIds: candidateAgentIds,
    followVisible: followVisibleSession,
  });

  const effectiveSelected = agents.data?.find((agent) => agent.id === resolution.effectiveAgentId);
  const headerText = workspaceHeaderText({
    pinnedAgentId: state.agentId,
    pinnedTitle: selected?.title,
    mode: resolution.mode,
    hasDocument,
    effectiveAgentId: resolution.effectiveAgentId,
    effectiveTitle: effectiveSelected?.title,
  });

  const showChooser = choosing || resolution.mode === "chooser";
  const showFollowOption = followVisibleSession && (hasDocument || hostFocus.supported || explicitActiveSupported);
  const boundIds = useMemo(() => new Set(boundSessions.map((session) => session.agentId)), [boundSessions]);
  const otherAgents = useMemo(
    () => (agents.data ?? []).filter((agent) => !boundIds.has(agent.id) && (choosing ? true : !agent.archived)),
    [agents.data, boundIds, choosing],
  );

  const color = props.theme.colors.foreground;
  const muted = props.theme.colors.foregroundMuted;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          borderBottomWidth: 1,
          borderColor: props.theme.colors.border,
          paddingRight: 8,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose navigator agent"
          onPress={() => setChoosing(!choosing)}
          style={{ flex: 1, minWidth: 0, padding: 10 }}
        >
          <Text numberOfLines={1} style={{ color }}>{headerText}</Text>
        </Pressable>
        {resolution.mode === "chooser" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open session navigation settings"
            onPress={() => openSessionNavSettings()}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 4,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: props.theme.colors.border,
              backgroundColor: props.theme.colors.surface1,
            }}
          >
            {typeof UiIcon === "function" ? (
              <UiIcon name="Settings" size={13} color={muted} />
            ) : (
              <Text style={{ color: muted, fontSize: 11, fontWeight: "700" }}>⚙</Text>
            )}
          </Pressable>
        ) : null}
      </View>
      {showChooser ? (
        <ScrollView
          nestedScrollEnabled={true}
          style={resolution.mode === "chooser" ? { flex: 1, minHeight: 0 } : { maxHeight: 220 }}
          contentContainerStyle={{ padding: 10, gap: 8 }}
        >
          {resolution.unavailablePin ? (
            <Text style={{ color: muted }}>Pinned session is unavailable in this workspace. Choose another session.</Text>
          ) : null}
          {showFollowOption ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Follow visible session"
              onPress={() => { setState(selectWorkspaceAgent(null)); setChoosing(false); }} style={{ paddingVertical: 6 }}>
              <Text style={{ color }}>Follow visible session{!state.agentId ? " ✓" : ""}</Text>
            </Pressable>
          ) : null}
          <Text style={{ color: muted }}>Or pin a workspace agent. This mode is remembered.</Text>
          {scopesQuery.isPending ? <Text style={{ color }}>Loading sessions…</Text> : null}
          {scopesQuery.isError ? <Pressable accessibilityRole="button" onPress={() => void scopesQuery.refetch()}><Text style={{ color }}>Could not load sessions. Retry</Text></Pressable> : null}
          {agents.isPending ? <Text style={{ color }}>Loading agents…</Text> : null}
          {agents.isError ? <Pressable accessibilityRole="button" onPress={() => void agents.refetch()}><Text style={{ color }}>Could not load agents. Retry</Text></Pressable> : null}
          {agents.data?.length === 0 && boundSessions.length === 0 ? <Text style={{ color }}>No agents in this workspace.</Text> : null}
          {boundSessions.map((session) => {
            const title = agents.data?.find((agent) => agent.id === session.agentId)?.title ?? session.agentId.slice(0, 8);
            return (
              <Pressable key={session.agentId} accessibilityRole="button" accessibilityLabel={`Navigate ${title}`}
                onPress={() => { setState(selectWorkspaceAgent(session.agentId)); setChoosing(false); }} style={{ paddingVertical: 6 }}>
                <Text numberOfLines={2} style={{ color }}>{title}{state.agentId === session.agentId ? " ✓" : ""}</Text>
                <Text style={{ color: muted, fontSize: 11 }}>{session.adapter.toUpperCase()}{session.items > 0 ? ` · ${session.items} managed` : ""}</Text>
              </Pressable>
            );
          })}
          {otherAgents.map((agent) => (
            <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`Navigate ${agent.title}`}
              onPress={() => { setState(selectWorkspaceAgent(agent.id)); setChoosing(false); }} style={{ paddingVertical: 6 }}>
              <Text numberOfLines={2} style={{ color }}>{agent.title}{agent.archived ? " (archived)" : ""}{state.agentId === agent.id ? " ✓" : ""}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {resolution.mode === "chooser" ? null : (
        <SessionNavPanel {...props} key={state.agentId ?? (hasDocument && followVisibleSession ? "follow" : `native-${resolution.effectiveAgentId}`)}
          context="agent" agentId={state.agentId ?? resolution.effectiveAgentId ?? ""}
          params={{ agentId: state.agentId ?? resolution.effectiveAgentId ?? "" }}
          followVisible={!state.agentId && followVisibleSession} candidateAgentIds={candidateAgentIds}
          tab={{ state: state.outline, setState: (outline) => setState({ ...state, outline }), setModified: props.tab.setModified }} />
      )}
    </View>
  );
}
