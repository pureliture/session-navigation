import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionNavPanel } from "./client/sessionNavPanel";
import { WorkspaceNavPanel } from "./client/workspacePanel";
import { registerNavigation } from "./client/registration";

export default function contribute(client: PluginClientContext): () => void {
  return registerNavigation(client, SessionNavPanel, WorkspaceNavPanel);
}
