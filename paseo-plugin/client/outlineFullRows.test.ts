import { expect, test } from "bun:test";
import { outlineListInput } from "./outlineListInput";

test("outline list requests never impose a row limit", () => {
  expect(outlineListInput("scope:1", "")).toEqual({
    scope_key: "scope:1",
    query: undefined,
  });
  expect(outlineListInput("scope:1", "needle")).toEqual({
    scope_key: "scope:1",
    query: "needle",
  });
});
