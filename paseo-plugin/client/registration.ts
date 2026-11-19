import type {
  PluginAgentPanelProps,
  PluginClientContext,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";

let openSettingsCallback: (() => void) | null = null;

export function openSessionNavSettings(): boolean {
  if (!openSettingsCallback) return false;
  openSettingsCallback();
  return true;
}

export function registerNavigation(
  client: PluginClientContext,
  AgentPanel: ComponentType<PluginAgentPanelProps>,
  WorkspacePanel: ComponentType<PluginWorkspacePanelProps>,
  SettingsComponent: ComponentType<PluginSurfaceProps> = () => null,
): () => void {
  openSettingsCallback =
    typeof client.openSettings === "function" ? () => client.openSettings("settings") : null;
  const cleanups = [
    client.addAgentPanel({ id: "session-nav", title: "Session navigation", icon: "List", locations: ["explorer"], Component: AgentPanel }),
    client.addWorkspacePanel({ id: "session-nav-workspace", title: "Session navigation", icon: "List", locations: ["explorer"], Component: WorkspacePanel }),
    ...(typeof client.addSettingsScreen === "function"
      ? [client.addSettingsScreen({ id: "settings", title: "Session navigation", icon: "List", Component: SettingsComponent })]
      : []),
    client.addCommandCenterItem({
      id: "open-session-nav", title: "Open session navigation", icon: "List", keywords: ["session", "nav", "navigation", "context", "compact"], context: "agent",
      onSelect({ openPanel }) { openPanel("session-nav", { location: "explorer" }); },
    }),
    client.addCommandCenterItem({
      id: "open-session-nav-settings",
      title: "Open session navigation settings",
      icon: "Settings",
      keywords: ["session", "nav", "navigation", "settings", "preferences", "outline"],
      context: "global",
      onSelect({ openSettings }) { openSettings("settings"); },
    }),
    client.addSlashCommand({
      name: "nav", description: "Open session navigation", argumentHint: "", context: "agent",
      async onSubmit({ openPanel }) { openPanel("session-nav", { location: "explorer" }); },
    }),
  ];
  return () => {
    openSettingsCallback = null;
    for (const dispose of cleanups) dispose();
  };
}
