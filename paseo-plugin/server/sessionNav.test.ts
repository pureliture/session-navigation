import { expect, spyOn, test } from "bun:test";
import { ServiceClient } from "./client.ts";
import { closeService, getAdapterToggles, listScopes, setAdapterToggle } from "./sessionNav.ts";

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

test("adapter toggle facades surface worker/DB failures without fabricated healthy defaults", async () => {
  const request = spyOn(ServiceClient.prototype, "request").mockResolvedValue({
    ok: false,
    error: "db_error",
    choices: ["abort_request", "send_original"],
  });
  try {
    const failed = await getAdapterToggles({});
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("db_error");
    // The Settings screen must see an error state, never healthy defaults.
    expect(failed.omp.enabled).toBe(false);
    expect(failed.hermes.enabled).toBe(false);
    expect(failed.choices).toEqual(["abort_request", "send_original"]);

    const setFailed = await setAdapterToggle({ adapter: "hermes", enabled: true });
    expect(setFailed.ok).toBe(false);
    expect(setFailed.error).toBe("db_error");
    expect(setFailed.omp.enabled).toBe(false);
    expect(setFailed.hermes.enabled).toBe(false);

    // The success path still merges the worker reply over the safe defaults.
    request.mockResolvedValueOnce({
      ok: true,
      omp: { installed: true, enabled: false },
      hermes: { installed: true, enabled: false, profileCount: 1 },
    });
    const toggles = await getAdapterToggles({});
    expect(toggles).toMatchObject({
      ok: true,
      omp: { installed: true, enabled: false },
      hermes: { installed: true, enabled: false, profileCount: 1 },
    });
  } finally {
    closeService();
    request.mockRestore();
  }
});
