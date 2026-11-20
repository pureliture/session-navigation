import { describe, expect, mock, test } from "bun:test";

mock.module("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
}));

mock.module("@getpaseo/plugin/client/ui", () => ({
  // Superset of the settings.test.ts UI mock: bun shares mock registrations
  // across test files in one run, so every mock for this specifier must
  // satisfy every consumer (Icon here, Settings* in settingsScreen).
  Icon: undefined,
  Loading: undefined,
  ScrollView: undefined,
  SettingsAction: undefined,
  SettingsCard: undefined,
  SettingsSection: undefined,
  SettingsSwitch: undefined,
}));

const { OutlineEmptyState } = await import("./outlineRows");

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

const THEME: any = { colors: { foregroundMuted: "#999" } };
const STYLES: any = {
  screen: "screen",
  header: "header",
  headerLeft: "headerLeft",
  headerTitle: "headerTitle",
  headerAgent: "headerAgent",
  headerRight: "headerRight",
  iconBtn: "iconBtn",
  iconBtnText: "iconBtnText",
  list: "list",
  emptyContainer: "emptyContainer",
  emptyText: "emptyText",
  errorText: "errorText",
};

function render(props: Record<string, any>): any {
  return expandTree(
    OutlineEmptyState({
      theme: THEME,
      styles: STYLES,
      agentLabel: "agent-1",
      error: null,
      isRefreshing: false,
      onRefresh: () => {},
      settingsButton: null,
      ...props,
    }),
  );
}

describe("OutlineEmptyState", () => {
  test("empty header always offers Refresh alongside the settings action", () => {
    let refreshes = 0;
    const tree = render({ onRefresh: () => void refreshes++, settingsButton: "gear" });
    const refresh = findAll(
      tree,
      (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Refresh outline",
    );
    expect(refresh).toHaveLength(1);
    expect(refresh[0].props.disabled).toBe(false);
    refresh[0].props.onPress();
    expect(refreshes).toBe(1);
    expect(collectText(tree).join("\n")).toContain("gear");
  });

  test("failed list fetch surfaces the error with a disabled-while-refreshing button", () => {
    const tree = render({ error: "scopes_failed", isRefreshing: true });
    expect(collectText(tree).join("\n")).toContain("scopes_failed");
    const refresh = findAll(
      tree,
      (el) => el.type === "Pressable" && el.props?.accessibilityLabel === "Refresh outline",
    );
    expect(refresh).toHaveLength(1);
    expect(refresh[0].props.disabled).toBe(true);
    expect(collectText(refresh[0]).join("")).toContain("…");
  });
});
