import type { PluginClientContext } from "@getpaseo/plugin/client";
import { installHostFocusTracker } from "./client/hostCompat";
import { SessionNavPanel } from "./client/sessionNavPanel";
import { WorkspaceNavPanel } from "./client/workspacePanel";
import { SettingsScreen } from "./client/settingsScreen";
import { registerNavigation } from "./client/registration";

export default function contribute(client: PluginClientContext): () => void {
  const disposeTracker = installHostFocusTracker();
  const disposeNavigation = registerNavigation(
    client,
    SessionNavPanel,
    WorkspaceNavPanel,
    SettingsScreen,
  );
  return () => {
    disposeNavigation();
    disposeTracker();
  };
}
