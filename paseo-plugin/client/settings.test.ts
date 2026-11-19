import { afterEach, describe, expect, mock, test } from "bun:test";
import * as actualPaseoClient from "@getpaseo/plugin/client";
import * as actualReactQuery from "@tanstack/react-query";
import {
  DEFAULT_OUTLINE_SETTINGS,
  outlineSettings,
  outlineSettingsSchema,
} from "../shared/outlineSettings";
import {
  getAdapterTogglesRpc,
  setAdapterToggleRpc,
  type AdapterTogglesResult,
} from "../shared/sessionNav";
import {
  resolveOutlineSettingsValues,
  setUseOutlineSettingsOverride,
  shouldOpenPreviewDrawerOnRowPress,
  type OutlineSettingsState,
} from "./outlineSettingsHook";
import { resolveWorkspaceSessionState } from "./sessionFollowing";

const rpcCalls: Array<{ name: string; input: any }> = [];
let currentToggleData: AdapterTogglesResult = {
  ok: true,
  omp: { installed: true, enabled: true, statusText: "Active" },
  hermes: {
    installed: true,
    enabled: false,
    profileCount: 2,
    statusText: "2 profiles (paused)",
  },
};
const invalidatedKeys: any[] = [];
const setQueryDataCalls: Array<{ key: any; data: any }> = [];
let nextToggleResultOverride: AdapterTogglesResult | null = null;

mock.module("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
}));

mock.module("@getpaseo/plugin/client/ui", () => ({
  Loading: undefined,
  ScrollView: undefined,
  SettingsAction: undefined,
  SettingsCard: undefined,
  SettingsSection: undefined,
  SettingsSwitch: undefined,
}));

mock.module("@getpaseo/plugin/client", () => ({
  ...actualPaseoClient,
  useRpc: (def: { name: string }) => async (input: any) => {
    rpcCalls.push({ name: def.name, input });
    if (def.name === getAdapterTogglesRpc.name) {
      return currentToggleData;
    }
    if (def.name === setAdapterToggleRpc.name) {
      if (nextToggleResultOverride) {
        const override = nextToggleResultOverride;
        nextToggleResultOverride = null;
        return override;
      }
      const next: AdapterTogglesResult = {
        ...currentToggleData,
        ok: true,
        [input.adapter]: {
          ...currentToggleData[input.adapter as "omp" | "hermes"],
          enabled: input.enabled,
          ...(input.adapter === "hermes" ? { mixed: false } : {}),
        },
      };
      currentToggleData = next;
      return next;
    }
    return { ok: false, error: "unexpected_rpc" };
  },
}));

mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQueryClient: () => ({
    setQueryData: (key: any, data: any) => {
      setQueryDataCalls.push({ key, data });
    },
    invalidateQueries: async (filter: any) => {
      invalidatedKeys.push(filter?.queryKey);
    },
  }),
  useQuery: (opts: { queryKey: any; queryFn: () => Promise<any> }) => {
    void opts;
    return {
      data: currentToggleData,
      isPending: false,
      error: null,
    };
  },
  useMutation: (opts: {
    mutationFn: (vars: any) => Promise<any>;
    onSuccess?: (data: any, vars: any) => void;
  }) => ({
    isPending: false,
    error: null,
    data: undefined,
    variables: undefined,
    mutate: (vars: any) => {
      void opts.mutationFn(vars).then((data) => {
        opts.onSuccess?.(data, vars);
      });
    },
  }),
}));

function expandTree(node: any): any {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node.type === "function") {
    return expandTree(node.type(node.props));
  }
  if (node.props && "children" in node.props) {
    return {
      ...node,
      props: {
        ...node.props,
        children: expandTree(node.props.children),
      },
    };
  }
  return node;
}

function findAll(node: any, predicate: (el: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props?.children) findAll(node.props.children, predicate, out);
  return out;
}

function collectText(node: any): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return collectText(node.props?.children);
}

const TEST_THEME: any = {
  colors: {
    surface0: "#111",
    surface1: "#222",
    border: "#333",
    foreground: "#eee",
    foregroundMuted: "#999",
    accent: "#4af",
    accentForeground: "#fff",
  },
};

afterEach(() => {
  setUseOutlineSettingsOverride(null);
  rpcCalls.length = 0;
  invalidatedKeys.length = 0;
  setQueryDataCalls.length = 0;
  nextToggleResultOverride = null;
  currentToggleData = {
    ok: true,
    omp: { installed: true, enabled: true, statusText: "Active" },
    hermes: {
      installed: true,
      enabled: false,
      profileCount: 2,
      statusText: "2 profiles (paused)",
    },
  };
});

describe("Outline settings & Session Navigation SettingsScreen", () => {
  test("outlineSettings schema defaults match specification", () => {
    expect(outlineSettings.id).toBe("outline");
    expect(outlineSettings.scope).toBe("host");
    expect(outlineSettings.version).toBe(1);
    expect(DEFAULT_OUTLINE_SETTINGS).toEqual({
      followVisibleSession: true,
      openPreviewOnRowClick: false,
    });
    expect(outlineSettingsSchema.parse({})).toEqual({
      followVisibleSession: true,
      openPreviewOnRowClick: false,
    });
    expect(resolveOutlineSettingsValues({ status: "loading" } as any)).toEqual(
      DEFAULT_OUTLINE_SETTINGS,
    );
    expect(
      resolveOutlineSettingsValues({
        status: "ready",
        values: { followVisibleSession: false, openPreviewOnRowClick: true },
      }),
    ).toEqual({
      followVisibleSession: false,
      openPreviewOnRowClick: true,
    });
  });

  test("shouldOpenPreviewDrawerOnRowPress respects desktop vs mobile and openPreviewOnRowClick", () => {
    expect(shouldOpenPreviewDrawerOnRowPress({ hasDocument: true, openPreviewOnRowClick: false })).toBe(
      false,
    );
    expect(shouldOpenPreviewDrawerOnRowPress({ hasDocument: true, openPreviewOnRowClick: true })).toBe(
      true,
    );
    expect(shouldOpenPreviewDrawerOnRowPress({ hasDocument: false, openPreviewOnRowClick: false })).toBe(
      true,
    );
  });

  test("resolveWorkspaceSessionState with followVisible=false ignores tracked session switching when unpinned", () => {
    const multiple = resolveWorkspaceSessionState({
      pinnedAgentId: null,
      trackedAgentId: "agent-2",
      hasTrackerSignal: true,
      trackerSupported: true,
      hasDocument: true,
      demandedAgentIds: ["agent-2"],
      boundSessions: [
        { agentId: "agent-1", adapter: "omp", items: 5 },
        { agentId: "agent-2", adapter: "hermes", items: 8 },
      ],
      workspaceAgentIds: ["agent-1", "agent-2"],
      followVisible: false,
    });
    expect(multiple).toEqual({ mode: "chooser", effectiveAgentId: null, unavailablePin: false });

    const single = resolveWorkspaceSessionState({
      pinnedAgentId: null,
      trackedAgentId: "agent-2",
      hasTrackerSignal: true,
      trackerSupported: true,
      hasDocument: true,
      demandedAgentIds: ["agent-2"],
      boundSessions: [{ agentId: "agent-1", adapter: "omp", items: 5 }],
      workspaceAgentIds: ["agent-1", "agent-2"],
      followVisible: false,
    });
    expect(single).toEqual({ mode: "single-auto", effectiveAgentId: "agent-1", unavailablePin: false });
  });

  test("SettingsScreen renders Agent Integration & Outline sections and dispatches toggles, saves, and reset", async () => {
    const { SettingsScreen } = await import("./settingsScreen");
    const saved: Array<{ values: any; revision: string }> = [];
    let resetCalls = 0;

    let outlineState: OutlineSettingsState = {
      status: "ready",
      revision: "rev-1",
      values: { followVisibleSession: true, openPreviewOnRowClick: false },
      saving: false,
      saveError: null,
      save: async (values, revision) => {
        saved.push({ values, revision });
        return true;
      },
      reset: async () => {
        resetCalls++;
        return true;
      },
      reload: async () => {},
    };
    setUseOutlineSettingsOverride(() => outlineState);

    const defaultTree = expandTree(SettingsScreen({ theme: TEST_THEME }));
    const defaultTexts = collectText(defaultTree);
    expect(defaultTexts).toContain("Agent Integration");
    expect(defaultTexts).toContain("OMP");
    expect(defaultTexts).toContain("Hermes");
    expect(defaultTexts).toContain("Outline");
    expect(defaultTexts).toContain("Follow visible session");
    expect(defaultTexts).toContain("Open preview on row click");
    // Reset button hidden when values match defaults
    expect(defaultTexts).not.toContain("Reset to defaults");

    const switches = findAll(defaultTree, (el) => el.type === "Switch");
    expect(switches.map((sw) => sw.props.accessibilityLabel)).toEqual([
      "OMP",
      "Hermes",
      "Follow visible session",
      "Open preview on row click",
    ]);

    const ompSwitch = switches[0];
    const hermesSwitch = switches[1];
    const followSwitch = switches[2];
    const previewSwitch = switches[3];

    expect(ompSwitch.props.value).toBe(true);
    expect(hermesSwitch.props.value).toBe(false);
    expect(followSwitch.props.value).toBe(true);
    expect(previewSwitch.props.value).toBe(false);

    // Trigger OMP & Hermes toggles
    ompSwitch.props.onValueChange(false);
    hermesSwitch.props.onValueChange(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rpcCalls).toEqual([
      { name: "session-nav.set-adapter-toggle", input: { adapter: "omp", enabled: false } },
      { name: "session-nav.set-adapter-toggle", input: { adapter: "hermes", enabled: true } },
    ]);
    expect(setQueryDataCalls).toHaveLength(2);
    expect(invalidatedKeys).toContainEqual(["session-nav", "scopes"]);
    expect(invalidatedKeys).toContainEqual(["session-nav", "list"]);

    // Trigger Outline switch changes
    followSwitch.props.onValueChange(false);
    previewSwitch.props.onValueChange(true);
    expect(saved).toEqual([
      { values: { followVisibleSession: false, openPreviewOnRowClick: false }, revision: "rev-1" },
      { values: { followVisibleSession: true, openPreviewOnRowClick: true }, revision: "rev-1" },
    ]);

    // When modified from defaults, Reset to defaults button renders and triggers settings.reset()
    outlineState = {
      ...outlineState,
      values: { followVisibleSession: false, openPreviewOnRowClick: true },
    };
    const modifiedTree = expandTree(SettingsScreen({ theme: TEST_THEME }));
    const resetButtons = findAll(
      modifiedTree,
      (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Reset to defaults",
    );
    expect(resetButtons).toHaveLength(1);
    resetButtons[0].props.onPress();
    expect(resetCalls).toBe(1);
  });

  test("SettingsScreen displays unverified warning/remediation, preserves fail-closed or partial-update responses via setQueryData, and offers profile reconciliation", async () => {
    const { SettingsScreen } = await import("./settingsScreen");
    setUseOutlineSettingsOverride(() => ({
      status: "ready",
      revision: "rev-1",
      values: { followVisibleSession: true, openPreviewOnRowClick: false },
      saving: false,
      saveError: null,
      save: async () => true,
      reset: async () => true,
      reload: async () => {},
    }));

    currentToggleData = {
      ok: true,
      omp: { installed: true, enabled: true, statusText: "Active" },
      hermes: {
        installed: true,
        enabled: true,
        profileCount: 2,
        mixed: true,
        protectionVerified: false,
        canDisable: false,
        profiles: [
          { profile: "default", configPath: "/tmp/.hermes/config.yaml", enabled: true },
          { profile: "atlas", configPath: "/tmp/.hermes/profiles/atlas/config.yaml", enabled: false },
        ],
        partialUpdate: true,
        rollbackFailedFiles: ["/tmp/.hermes/profiles/atlas/config.yaml"],
        statusText: "1/2 profiles enabled (mixed) — protection unverified (D9: DB errors fail open)",
        warning: "Protection-only mode cannot be confirmed for active/running or hidden scopes.",
        remediation: "Restart Hermes and its gateway completely and run a turn in each enabled/active profile.",
        error: "Partial config update (disk_io_fail): rollback failed for /tmp/.hermes/profiles/atlas/config.yaml.",
      },
    };

    const tree = expandTree(SettingsScreen({ theme: TEST_THEME }));
    const joined = collectText(tree).join("\n");
    expect(joined).toContain("Manage tool results and cleanup hints across Hermes profiles.");
    expect(joined).toContain("Protection-only mode cannot be confirmed");
    expect(joined).toContain("Restart Hermes and its gateway completely");
    expect(joined).toContain("Profiles: default=on, atlas=off.");
    expect(joined).toContain("Partial update: rollback failed for /tmp/.hermes/profiles/atlas/config.yaml.");
    expect(joined).toContain("Partial config update (disk_io_fail)");

    // Failed fail-closed / partial-update RPC reply is retained via setQueryData instead of being invalidated away
    const hermesSwitch = findAll(
      tree,
      (el) => el.type === "Switch" && el.props?.accessibilityLabel === "Hermes",
    )[0];
    nextToggleResultOverride = {
      ok: false,
      error: "hermes_protection_unverified",
      omp: currentToggleData.omp,
      hermes: {
        ...currentToggleData.hermes,
        error: "Restart Hermes and its gateway before pausing.",
      },
    };
    hermesSwitch.props.onValueChange(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setQueryDataCalls).toHaveLength(1);
    expect(setQueryDataCalls[0].key).toEqual(["session-nav", "adapter-toggles"]);
    expect(setQueryDataCalls[0].data.ok).toBe(false);
    expect(setQueryDataCalls[0].data.hermes.error).toBe("Restart Hermes and its gateway before pausing.");
    expect(invalidatedKeys).not.toContainEqual(["session-nav", "adapter-toggles"]);

    // Reconcile action renders for mixed/partial states and enables all profiles
    const reconcileButtons = findAll(
      tree,
      (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Enable all profiles",
    );
    expect(reconcileButtons).toHaveLength(1);
    reconcileButtons[0].props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpcCalls.at(-1)).toEqual({
      name: "session-nav.set-adapter-toggle",
      input: { adapter: "hermes", enabled: true },
    });
  });

  test("SettingsScreen disables Hermes switch with false value when state is unknown, while keeping recoverable actions enabled", async () => {
    const { SettingsScreen } = await import("./settingsScreen");
    setUseOutlineSettingsOverride(() => ({
      status: "ready",
      revision: "rev-1",
      values: { followVisibleSession: true, openPreviewOnRowClick: false },
      saving: false,
      saveError: null,
      save: async () => true,
      reset: async () => true,
      reload: async () => {},
    }));

    // Even if enabled were erroneously true on the wire, stateUnknown MUST force value=false and disabled=true
    currentToggleData = {
      ok: true,
      omp: { installed: true, enabled: true, statusText: "Active" },
      hermes: {
        installed: true,
        enabled: true,
        stateUnknown: true,
        canDisable: false,
        profileCount: 2,
        statusText: "Config YAML error (state unknown).",
        warning: "One or more Hermes config.yaml files contain invalid or unsupported YAML; state cannot be determined.",
        error: "hermes_invalid_config_yaml",
      },
    };

    const yamlErrTree = expandTree(SettingsScreen({ theme: TEST_THEME }));
    const yamlSwitch = findAll(
      yamlErrTree,
      (el) => el.type === "Switch" && el.props?.accessibilityLabel === "Hermes",
    )[0];
    expect(yamlSwitch.props.value).toBe(false);
    expect(yamlSwitch.props.disabled).toBe(true);
    expect(collectText(yamlErrTree).join("\n")).toContain("state unknown");
    expect(
      findAll(yamlErrTree, (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Enable all profiles"),
    ).toHaveLength(0);

    // Recoverable journal error keeps the switch disabled+false while leaving Reconcile action clickable
    currentToggleData = {
      ok: true,
      omp: { installed: true, enabled: true, statusText: "Active" },
      hermes: {
        installed: true,
        enabled: false,
        stateUnknown: true,
        canDisable: false,
        partialUpdate: true,
        mixed: true,
        profileCount: 2,
        statusText: "Journal error (state unknown).",
        error: "hermes_corrupt_toggle_journal",
      },
    };
    const journalErrTree = expandTree(SettingsScreen({ theme: TEST_THEME }));
    const journalSwitch = findAll(
      journalErrTree,
      (el) => el.type === "Switch" && el.props?.accessibilityLabel === "Hermes",
    )[0];
    expect(journalSwitch.props.value).toBe(false);
    expect(journalSwitch.props.disabled).toBe(true);
    expect(collectText(journalErrTree).join("\n")).toContain("state unknown");
    const recoverButtons = findAll(
      journalErrTree,
      (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Enable all profiles",
    );
    expect(recoverButtons).toHaveLength(1);
    expect(recoverButtons[0].props.disabled).toBe(false);
  });
});
