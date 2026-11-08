import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SessionNavPanel } from "./client/sessionNavPanel";


function Screen(props: PluginScreenProps) {
  const workspaceId = (props.params as { workspaceId?: string } | undefined)?.workspaceId ?? "";
  return <SessionNavPanel {...(props as unknown as PluginWorkspacePanelProps)} workspaceId={workspaceId} />;
}

function NavItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="List"
      active={currentScreen?.screenId === "session-nav"}
      onPress={() => openScreen({ screenId: "session-nav" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "session-nav", title: "Session navigation", Component: Screen });
  client.addSidebarHeaderItem({ id: "session-nav", title: "Session navigation", Component: NavItem });
  client.addCommandCenterItem({
    id: "open-session-nav",
    title: "Open session navigation",
    icon: "List",
    context: "workspace",
    onSelect({ openScreen }) {
      openScreen({ screenId: "session-nav" });
    },
  });
  client.addSlashCommand({
    name: "nav",
    description: "Open session navigation",
    argumentHint: "",
    context: "workspace",
    async onSubmit({ openScreen }) {
      openScreen({ screenId: "session-nav" });
    },
  });
  return () => {};
}
