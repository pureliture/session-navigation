import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { SessionNavPanel } from "./client/sessionNavPanel";

function Panel(props: PluginAgentPanelProps) {
  return <SessionNavPanel {...props} />;
}

export default function contribute(client: PluginClientContext): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    client.addAgentPanel({
      id: "session-nav",
      title: "Session navigation",
      icon: "List",
      locations: ["explorer"],
      Component: Panel,
    }),
  );

  cleanups.push(
    client.addCommandCenterItem({
      id: "open-session-nav",
      title: "Open session navigation",
      icon: "List",
      keywords: ["session", "nav", "navigation", "context", "compact"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("session-nav", { location: "explorer" });
      },
    }),
  );

  cleanups.push(
    client.addSlashCommand({
      name: "nav",
      description: "Open session navigation",
      argumentHint: "",
      context: "agent",
      async onSubmit({ openPanel }) {
        openPanel("session-nav", { location: "explorer" });
      },
    }),
  );

  return () => {
    for (const dispose of cleanups) dispose();
  };
}
