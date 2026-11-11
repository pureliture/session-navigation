import { expect, test } from "bun:test";
import {
  actionAllowed,
  capabilityNotice,
  type Capabilities,
} from "./capabilities";
import type { Row } from "../shared/sessionNav";

test("UI capability gates retain display and offline Unhide, and distinguish adapter/protocol/database/runtime errors", () => {
  const row: Row = {
    item_id: "item",
    tool_call_id: "call",
    kind: "tool",
    status: "visible",
    version: 1,
    tokens_display: "—",
  };
  const ready: Capabilities = {
    state: "ready",
    display: true,
    hide: true,
    summarize: false,
    unhide: true,
  };
  expect(actionAllowed(row, undefined, "hide")).toBe(false);
  expect(actionAllowed(row, ready, "hide")).toBe(true);
  expect(actionAllowed(row, ready, "summarize")).toBe(false);
  expect(actionAllowed({ ...row, status: "hidden" }, undefined, "unhide")).toBe(
    true,
  );
  expect(actionAllowed({ ...row, manageable: false }, ready, "hide")).toBe(
    false,
  );
  expect(capabilityNotice()).toContain("Install and enable");
  expect(
    capabilityNotice(undefined, { ...ready, state: "incompatible_protocol" }),
  ).toContain("Incompatible");
  expect(capabilityNotice("db_error")).toContain("Database error");
  expect(capabilityNotice("runtime_unsupported")).toContain("Node >=22.13");
  expect(capabilityNotice("engine_error")).toContain("Engine/runtime error");
  expect(capabilityNotice(undefined, ready)).toBeNull();
});
