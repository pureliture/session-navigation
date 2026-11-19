import { expect, test } from "bun:test";
import { outlineRefreshQueryKeys } from "./outlineRefresh";

test("manual outline refresh covers list, scopes, usage, and fallback timeline", () => {
  expect(outlineRefreshQueryKeys("agent-1")).toEqual([
    ["session-nav", "list"],
    ["session-nav", "scopes"],
    ["paseo-agent-usage", "agent-1"],
    ["paseo-agent-timeline", "agent-1"],
  ]);
});
