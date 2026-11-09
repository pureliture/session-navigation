import type { PluginAgentPanelProps, PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";

export function registerNavigation(client: PluginClientContext, AgentPanel: ComponentType<PluginAgentPanelProps>, WorkspacePanel: ComponentType<PluginWorkspacePanelProps>): () => void {
  const cleanups = [
    client.addAgentPanel({ id: "session-nav", title: "Session navigation", icon: "List", locations: ["explorer"], Component: AgentPanel }),
    client.addWorkspacePanel({ id: "session-nav-workspace", title: "Session navigation", icon: "List", locations: ["explorer"], Component: WorkspacePanel }),
    client.addCommandCenterItem({
      id: "open-session-nav", title: "Open session navigation", icon: "List", keywords: ["session", "nav", "navigation", "context", "compact"], context: "agent",
      onSelect({ openPanel }) { openPanel("session-nav", { location: "explorer" }); },
    }),
    client.addSlashCommand({
      name: "nav", description: "Open session navigation", argumentHint: "", context: "agent",
      async onSubmit({ openPanel }) { openPanel("session-nav", { location: "explorer" }); },
    }),
  ];
  return () => { for (const dispose of cleanups) dispose(); };
}
