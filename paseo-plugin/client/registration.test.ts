import { expect, test } from "bun:test";

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
