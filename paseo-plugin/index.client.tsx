import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SessionNavPanel } from "./client/sessionNavPanel";

function Panel(props: PluginWorkspacePanelProps) {
  return <SessionNavPanel {...props} />;
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "session-nav",
    title: "Session navigation",
    icon: "List",
    locations: ["explorer"],
    Component: Panel,
  });
  client.addCommandCenterItem({
    id: "open-session-nav",
    title: "Open session navigation",
    icon: "List",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("session-nav");
    },
  });
  client.addSlashCommand({
    name: "nav",
    description: "Open session navigation",
    argumentHint: "",
    context: "workspace",
    async onSubmit({ openPanel }) {
      openPanel("session-nav");
    },
  });
  return () => {};
}
