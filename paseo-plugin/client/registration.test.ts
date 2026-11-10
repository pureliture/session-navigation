import { expect, test } from "bun:test";
import { registerNavigation } from "./registration";

test("registers a workspace Explorer panel for + while preserving agent commands and cleanup", async () => {
  const panels: any[] = [], commands: any[] = [], slashes: any[] = [], opened: any[] = [], disposed: string[] = [];
  const capture = (kind: string, list: any[]) => (value: any) => { list.push({ ...value, context: value.context ?? kind }); return () => disposed.push(value.id ?? value.name); };
  const client = { addAgentPanel: capture("agent", panels), addWorkspacePanel: capture("workspace", panels),
    addCommandCenterItem: capture("agent", commands), addSlashCommand: capture("agent", slashes) };
  const dispose = registerNavigation(client as any, () => null, () => null);
  const menu = panels.filter((panel) => panel.context === "workspace" && panel.locations.includes("explorer"));
  expect(menu.map((panel) => [panel.id, panel.title, panel.icon])).toEqual([["session-nav-workspace", "Session navigation", "List"]]);
  expect(panels.find((panel) => panel.context === "agent")?.id).toBe("session-nav");
  const context = { openPanel: (...args: any[]) => opened.push(args) };
  commands[0].onSelect(context);
  await slashes[0].onSubmit(context);
  expect(opened).toEqual([["session-nav", { location: "explorer" }], ["session-nav", { location: "explorer" }]]);
  dispose();
  expect(disposed).toEqual(["session-nav", "session-nav-workspace", "open-session-nav", "nav"]);
});
