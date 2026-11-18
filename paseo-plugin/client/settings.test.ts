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
});
