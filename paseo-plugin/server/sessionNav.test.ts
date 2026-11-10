import { expect, spyOn, test } from "bun:test";
import { ServiceClient } from "./client.ts";
import { closeService, listScopes } from "./sessionNav.ts";

test("scope RPC facade forwards parent filters and preserves empty and error replies", async () => {
  const request = spyOn(ServiceClient.prototype, "request").mockResolvedValue({ ok: true, scopes: [] });
  try {
    expect(await listScopes({})).toEqual({ ok: true, scopes: [] });
    expect(request).toHaveBeenLastCalledWith("scopes", {});
    const parent_scope = "omp:default:parent:default";
    await listScopes({ parent_scope });
    expect(request).toHaveBeenLastCalledWith("scopes", { parent_scope });
    request.mockResolvedValueOnce({ ok: false, error: "invalid_params" });
    expect(await listScopes({ parent_scope })).toEqual({ ok: false, error: "invalid_params", scopes: [] });
  } finally {
    closeService();
    request.mockRestore();
  }
});
