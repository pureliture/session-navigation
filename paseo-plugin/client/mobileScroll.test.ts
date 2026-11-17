import { describe, expect, mock, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import { fmtBytePair } from "./outlineGrouping";

const MockScrollView = "ScrollView";
mock.module("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: MockScrollView,
}));
import { OutlineScrollDriver, type OutlineScrollListHandle } from "./outlineScroll";
import { hasDomDocument, resolveWorkspaceSessionState } from "./sessionFollowing";

function createMobileNativeListMock() {
  const calls: Array<{ type: "end" } | { type: "offset"; offset: number }> = [];
  const handle: OutlineScrollListHandle = {
    // On iOS/Android React Native, getScrollableNode() returns a numeric native view tag, NOT a DOM HTMLElement!
    getScrollableNode: () => 42,
    scrollToEnd: () => {
      calls.push({ type: "end" });
    },
    scrollToOffset: ({ offset }) => {
      calls.push({ type: "offset", offset });
    },
  };
  return { handle, calls };
}

function collectElements(node: any, predicate: (el: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props?.children) collectElements(node.props.children, predicate, out);
  return out;
}

describe("Mobile / Native React Native verification (DOM-less iOS & Android)", () => {
  test("DOM-less mobile environment hasDomDocument()=false and native session following works without window/document", () => {
    const savedDoc = (globalThis as any).document;
    try {
      delete (globalThis as any).document;
      expect(hasDomDocument()).toBe(false);
      const res = resolveWorkspaceSessionState({
        pinnedAgentId: null,
        trackedAgentId: "mobile-agent-1",
        hasTrackerSignal: true,
        trackerSupported: true,
        hasDocument: false,
        demandedAgentIds: ["mobile-agent-1"],
        boundSessions: [{ agentId: "mobile-agent-1", adapter: "omp", items: 12 }],
        workspaceAgentIds: ["mobile-agent-1", "mobile-agent-2"],
      });
      expect(res.effectiveAgentId).toBe("mobile-agent-1");
    } finally {
      if (savedDoc !== undefined) (globalThis as any).document = savedDoc;
    }
  });

  test("mobile FlatList without DOM HTMLElement scrolls to bottom, handles touch drag + momentum re-arm, and reveals tapped row above PreviewDrawer", () => {
    const driver = new OutlineScrollDriver(1500);
    const { handle, calls } = createMobileNativeListMock();
    const state = {
      sessionKey: "mobile-agent::omp:default:s1:default::",
      mounted: true,
      rowCount: 60,
      isLoading: false,
      hasSearchQuery: false,
    };

    // 1. Native mount: onLayout provides layout.height=560, onContentSizeChange provides h=2400 (no DOM scrollHeight!)
    driver.handleLayout(handle, { nativeEvent: { layout: { height: 560 } } }, state, 1000);
    driver.handleContentSizeChange(handle, 2400, state, 1020);
    expect(calls.some((c) => c.type === "end")).toBe(true);
    expect(driver.readMetrics(handle)).toEqual({
      scrollTop: 1840,
      scrollHeight: 2400,
      clientHeight: 560,
    });

    // 2. Mobile user touch-drags upward to y=400 -> disarms stick-to-bottom
    calls.length = 0;
    driver.handleDragStart();
    driver.handleScrollEvent(
      {
        nativeEvent: {
          contentOffset: { y: 400 },
          contentSize: { height: 2400 },
          layoutMeasurement: { height: 560 },
        },
      },
      3000,
    );
    expect(driver.scroller.isStuckToBottom()).toBe(false);

    // Background 4s poll brings 2 new rows while user is reading y=400 -> must NOT jump!
    driver.maybeSync(handle, { ...state, rowCount: 62 }, { contentHeight: 2500, now: 4000, scheduleFrame: () => {} });
    expect(calls).toEqual([]);

    // 3. Mobile user flicks downward and momentum settles at y=1910 (within 48px of 2500 - 560 = 1940) via onMomentumScrollEnd!
    driver.handleScrollEvent(
      {
        nativeEvent: {
          contentOffset: { y: 1910 },
          contentSize: { height: 2500 },
          layoutMeasurement: { height: 560 },
        },
      },
      5000,
    );
    expect(driver.scroller.isStuckToBottom()).toBe(true);

    // Next live row automatically scrolls to bottom on mobile!
    driver.maybeSync(handle, { ...state, rowCount: 63 }, { contentHeight: 2560, now: 6000, scheduleFrame: () => {} });
    expect(calls).toEqual([{ type: "end" }]);

    // 4. Mobile user taps a row (!hasDocument -> openPreviewDrawer) shrinking FlatList height 560 -> 300:
    // Must call scrollToOffset(2560 - 300 = 2260) WITHOUT needing any DOM node!
    calls.length = 0;
    driver.handleContentSizeChange(handle, 2560, { ...state, rowCount: 63 }, 6010);
    calls.length = 0;
    driver.prepareDrawerToggle(handle, true);
    driver.handleLayout(handle, { nativeEvent: { layout: { height: 300 } } }, { ...state, rowCount: 63 }, 6100);
    expect(calls).toEqual([{ type: "offset", offset: 2260 }]);

    // 5. Mobile user expands bottom tool group (content grows 2560 -> 2860 while at bottom 2260):
    // Must advance via scrollToOffset without needing any DOM node!
    calls.length = 0;
    driver.prepareGroupExpand(handle, false);
    driver.handleContentSizeChange(handle, 2860, { ...state, rowCount: 68 }, 7000);
    expect(calls).toEqual([{ type: "offset", offset: 2440 }]);
  });

  test("PreviewDrawer sets nestedScrollEnabled on BOTH outer and inner vertical ScrollViews for Android touch scrolling", async () => {
    const { PreviewDrawer } = await import("./PreviewDrawer");
    const row: Row = {
      item_id: "item_m1",
      tool_call_id: "call_m1",
      kind: "tool",
      tool_name: "bash",
      status: "hidden",
      version: 2,
      tokens_display: "—",
      bytes_size: 4096,
      compacted_bytes_size: 210,
      tool_input: '{"command":"ls -la"}',
      tool_output: "total 32\ndrwxr-xr-x ...",
      replacement_text: "[hidden:item_m1]\n...",
    };
    const tree = PreviewDrawer({
      row,
      open: true,
      onToggle: () => {},
      theme: {
        colors: {
          border: "#333",
          surface0: "#111",
          surface1: "#222",
          foreground: "#eee",
          foregroundMuted: "#999",
          accent: "#4af",
          accentForeground: "#fff",
        },
      } as any,
    });
    const scrollViews = collectElements(tree, (el) => el.type === MockScrollView);
    const verticalScrollViews = scrollViews.filter((el) => !el.props.horizontal);
    expect(verticalScrollViews.length).toBeGreaterThanOrEqual(2);
    for (const sv of verticalScrollViews) {
      expect(sv.props.nestedScrollEnabled).toBe(true);
    }
  });

  test("compact 320px mobile viewport byte-pair labels stay concise (<= 15 chars) without duplicate unit clutter", () => {
    const samples = [
      fmtBytePair(32154, 100966), // 31.4/98.6 KiB
      fmtBytePair(512, 20480), // 0.5/20.0 KiB
      fmtBytePair(0, 4096), // 0/4.0 KiB
      fmtBytePair(24, 15360), // <0.1/15.0 KiB
      fmtBytePair(484, 1001), // 484/1001 B
    ];
    for (const s of samples) {
      expect(s.length).toBeLessThanOrEqual(15);
    }
  });
});
