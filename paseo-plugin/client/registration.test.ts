import { expect, test } from "bun:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";

import { openSessionNavSettings, registerNavigation } from "./registration";
test("registers panels, settings screen, command center entries, slash command, and cleanup", async () => {
  const panels: any[] = [], screens: any[] = [], commands: any[] = [], slashes: any[] = [], opened: any[] = [], settingsOpened: string[] = [], disposed: string[] = [];
  const capture = (kind: string, list: any[]) => (value: any) => { list.push({ ...value, context: value.context ?? kind }); return () => disposed.push(value.id ?? value.name); };
  const client = {
    addAgentPanel: capture("agent", panels),
    addWorkspacePanel: capture("workspace", panels),
    addSettingsScreen: capture("settings", screens),
    addCommandCenterItem: capture("command", commands),
    addSlashCommand: capture("agent", slashes),
    openSettings: (screenId: string) => { settingsOpened.push(screenId); },
  };
  const FakeSettings = () => null;
  const dispose = registerNavigation(client as any, () => null, () => null, FakeSettings);
  const menu = panels.filter((panel) => panel.context === "workspace" && panel.locations.includes("explorer"));
  expect(menu.map((panel) => [panel.id, panel.title, panel.icon])).toEqual([["session-nav-workspace", "Session navigation", "List"]]);
  expect(panels.find((panel) => panel.context === "agent")?.id).toBe("session-nav");
  expect(screens.map((screen) => [screen.id, screen.title, screen.icon, screen.Component])).toEqual([
    ["settings", "Session navigation", "List", FakeSettings],
  ]);
  const context = {
    openPanel: (...args: any[]) => opened.push(args),
    openSettings: (screenId: string) => settingsOpened.push(screenId),
  };
  const openNavCmd = commands.find((cmd) => cmd.id === "open-session-nav");
  const openSettingsCmd = commands.find((cmd) => cmd.id === "open-session-nav-settings");
  expect(openNavCmd).toBeDefined();
  expect(openSettingsCmd).toMatchObject({
    id: "open-session-nav-settings",
    title: "Open session navigation settings",
    icon: "Settings",
    context: "global",
  });
  openNavCmd.onSelect(context);
  await slashes[0].onSubmit(context);
  openSettingsCmd.onSelect(context);
  expect(openSessionNavSettings()).toBe(true);
  expect(opened).toEqual([["session-nav", { location: "explorer" }], ["session-nav", { location: "explorer" }]]);
  expect(settingsOpened).toEqual(["settings", "settings"]);
  dispose();
  expect(openSessionNavSettings()).toBe(false);
  expect(disposed).toEqual([
    "session-nav",
    "session-nav-workspace",
    "settings",
    "open-session-nav",
    "open-session-nav-settings",
    "nav",
  ]);
});

test("command and slash handlers no-op on hosts without openSettings/openPanel", async () => {
  const commands: Array<{ id: string; onSelect: (context?: unknown) => void }> = [];
  const slashes: Array<{ onSubmit: (context?: unknown) => Promise<void> }> = [];
  const client = {
    addAgentPanel: () => () => {},
    addWorkspacePanel: () => () => {},
    addCommandCenterItem: (value: { id: string; onSelect: (context?: unknown) => void }) => {
      commands.push(value);
      return () => {};
    },
    addSlashCommand: (value: { onSubmit: (context?: unknown) => Promise<void> }) => {
      slashes.push(value);
      return () => {};
    },
  };
  // Unchecked cast at the host boundary: the test double implements only the
  // registration surface the client slice touches.
  const hostClient = client as unknown as PluginClientContext;
  registerNavigation(hostClient, () => null, () => null);
  // openSettings/openPanel unsupported by the host: must not throw.
  const settingsCmd = commands.find((cmd) => cmd.id === "open-session-nav-settings");
  expect(() => settingsCmd?.onSelect({})).not.toThrow();
  expect(() => settingsCmd?.onSelect(undefined)).not.toThrow();
  const navCmd = commands.find((cmd) => cmd.id === "open-session-nav");
  expect(() => navCmd?.onSelect({})).not.toThrow();
  await slashes[0]?.onSubmit({});
  // Supported hosts still open the panel/settings screen.
  const opened: unknown[][] = [], settingsOpened: string[] = [];
  navCmd?.onSelect({ openPanel: (...args: unknown[]) => opened.push(args) });
  settingsCmd?.onSelect({ openSettings: (id: string) => settingsOpened.push(id) });
  expect(opened).toEqual([["session-nav", { location: "explorer" }]]);
  expect(settingsOpened).toEqual(["settings"]);
});
