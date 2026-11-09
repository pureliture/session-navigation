import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { usePaseo, useTabState } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { SessionNavPanel } from "./sessionNavPanel";
import { listWorkspaceAgents } from "./workspaceAgents";

const workspaceTabSchema = z.object({ agentId: z.string().nullable(), outline: z.json() });
const defaultState = { agentId: null, outline: {} };

export function WorkspaceNavPanel(props: PluginWorkspacePanelProps) {
  const paseo = usePaseo();
  const [state, setState] = useTabState(props.tab, workspaceTabSchema, defaultState);
  const [choosing, setChoosing] = useState(false);
  const agents = useQuery({
    queryKey: ["session-nav", "workspace-agents", props.host.id, props.workspaceId],
    queryFn: ({ signal }) => listWorkspaceAgents(paseo, props.workspaceId, signal),
    enabled: choosing || !state.agentId,
    refetchInterval: 15_000,
  });
  const selected = agents.data?.find((agent) => agent.id === state.agentId);
  const color = props.theme.colors.foreground;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Choose navigator agent" onPress={() => setChoosing(!choosing)}
        style={{ padding: 10, borderBottomWidth: 1, borderColor: props.theme.colors.border }}>
        <Text numberOfLines={1} style={{ color }}>{selected?.title ?? (state.agentId ? "Change navigator agent" : "Choose an agent")} ▾</Text>
      </Pressable>
      {choosing || !state.agentId ? (
        <ScrollView style={{ maxHeight: state.agentId ? 220 : undefined }} contentContainerStyle={{ padding: 10, gap: 8 }}>
          <Text style={{ color: props.theme.colors.foregroundMuted }}>Choose a workspace agent. This selection and the Explorer tab are remembered.</Text>
          {agents.isPending ? <Text style={{ color }}>Loading agents…</Text> : null}
          {agents.isError ? <Pressable accessibilityRole="button" onPress={() => void agents.refetch()}><Text style={{ color }}>Could not load agents. Retry</Text></Pressable> : null}
          {agents.data?.length === 0 ? <Text style={{ color }}>No agents in this workspace.</Text> : null}
          {agents.data?.map((agent) => (
            <Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`Navigate ${agent.title}`}
              onPress={() => { setState({ agentId: agent.id, outline: {} }); setChoosing(false); }} style={{ paddingVertical: 6 }}>
              <Text numberOfLines={2} style={{ color }}>{agent.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {state.agentId ? <SessionNavPanel {...props} key={state.agentId} context="agent" agentId={state.agentId} params={{ agentId: state.agentId }}
        tab={{ state: state.outline, setState: (outline) => setState({ ...state, outline }), setModified: props.tab.setModified }} /> : null}
    </View>
  );
}
