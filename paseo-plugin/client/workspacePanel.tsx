import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useTabState } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SessionNavPanel } from "./sessionNavPanel";
import { listWorkspaceAgents } from "./workspaceAgents";
import { defaultWorkspaceState, selectWorkspaceAgent, workspaceTabSchema } from "./workspaceState";

export function WorkspaceNavPanel(props: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const [state, setState] = useTabState(props.tab, workspaceTabSchema, defaultWorkspaceState);
  const [choosing, setChoosing] = useState(false);
  const agents = useQuery({
    queryKey: ["session-nav", "workspace-agents", props.host.id, props.workspaceId],
    queryFn: ({ signal }) => listWorkspaceAgents(paseo, props.workspaceId, signal),
    enabled: choosing || !state.agentId,
    refetchInterval: 15_000,
  });
  const selected = agents.data?.find((agent) => agent.id === state.agentId);
  const candidateAgentIds = useMemo(() => agents.data?.map((agent) => agent.id) ?? [], [agents.data]);
  const color = props.theme.colors.foreground;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Choose navigator agent" onPress={() => setChoosing(!choosing)}
        style={{ padding: 10, borderBottomWidth: 1, borderColor: props.theme.colors.border }}>
        <Text numberOfLines={1} style={{ color }}>{state.agentId ? `Pinned · ${selected?.title ?? state.agentId.slice(0, 8)}` : "Follow visible session"} ▾</Text>
      </Pressable>
      {choosing ? (
        <ScrollView style={{ maxHeight: 220 }} contentContainerStyle={{ padding: 10, gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Follow visible session"
            onPress={() => { setState(selectWorkspaceAgent(null)); setChoosing(false); }} style={{ paddingVertical: 6 }}>
            <Text style={{ color }}>Follow visible session{!state.agentId ? " ✓" : ""}</Text>
          </Pressable>
          <Text style={{ color: props.theme.colors.foregroundMuted }}>Or pin a workspace agent. This mode is remembered.</Text>
          {agents.isPending ? <Text style={{ color }}>Loading agents…</Text> : null}
          {agents.isError ? <Pressable accessibilityRole="button" onPress={() => void agents.refetch()}><Text style={{ color }}>Could not load agents. Retry</Text></Pressable> : null}
          {agents.data?.length === 0 ? <Text style={{ color }}>No agents in this workspace.</Text> : null}
          {agents.data?.map((agent) => (
            <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`Navigate ${agent.title}`}
              onPress={() => { setState(selectWorkspaceAgent(agent.id)); setChoosing(false); }} style={{ paddingVertical: 6 }}>
              <Text numberOfLines={2} style={{ color }}>{agent.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <SessionNavPanel {...props} key={state.agentId ?? "follow"} context="agent" agentId={state.agentId ?? ""} params={{ agentId: state.agentId ?? "" }}
        followVisible={!state.agentId} candidateAgentIds={candidateAgentIds}
        tab={{ state: state.outline, setState: (outline) => setState({ ...state, outline }), setModified: props.tab.setModified }} />
    </View>
  );
}
