import { expect, test } from "bun:test";
import { listWorkspaceAgents } from "./workspaceAgents";

test("paginates agents and scopes choices to the workspace, including archived sessions", async () => {
  const options: any[] = [];
  const paseo: any = { agents: { list: async (input: any) => {
    options.push(input);
    return input.page.cursor ? { entries: [{ agent: { id: "archived", workspaceId: "w", title: null } }], pageInfo: { hasMore: false } }
      : { entries: [{ agent: { id: "other", workspaceId: "elsewhere" } }, { agent: { id: "current", workspaceId: "w", title: "Current" } }], pageInfo: { hasMore: true, nextCursor: "next" } };
  } } };
  expect(await listWorkspaceAgents(paseo, "w")).toEqual([{ id: "current", title: "Current" }, { id: "archived", title: "archived" }]);
  expect(options.map((option) => option.page.cursor)).toEqual([undefined, "next"]);
  expect(options[0].filter.includeArchived).toBe(true);
});

test("empty workspaces stay empty and API errors propagate for the retry UI", async () => {
  expect(await listWorkspaceAgents({ agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as any, "empty")).toEqual([]);
  await expect(listWorkspaceAgents({ agents: { list: async () => { throw new Error("offline"); } } } as any, "w")).rejects.toThrow("offline");
});

test("stalled pagination fails instead of silently omitting agents", async () => {
  await expect(listWorkspaceAgents({ agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "same" } }) } } as any, "w")).rejects.toThrow("did not advance");
});

test("attaches archived flag only when archivedAt is present", async () => {
  const paseo: any = { agents: { list: async () => ({ entries: [
    { agent: { id: "active", workspaceId: "w", title: "Active", archivedAt: null } },
    { agent: { id: "old", workspaceId: "w", title: "Old", archivedAt: "2026-01-01" } },
  ], pageInfo: { hasMore: false } }) } };
  expect(await listWorkspaceAgents(paseo, "w")).toEqual([
    { id: "active", title: "Active" },
    { id: "old", title: "Old", archived: true },
  ]);
});
