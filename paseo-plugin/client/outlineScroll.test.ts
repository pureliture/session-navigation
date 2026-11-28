import { describe, expect, test } from "bun:test";
import {
  computeDrawerOpenScrollTop,
  computeExpandedGroupScrollTop,
  initialRenderCount,
  OutlineAutoScroller,
  OutlineScrollDriver,
} from "./outlineScroll";

describe("OutlineAutoScroller", () => {
  test("pins across multi-batch FlatList growth (including >1.5s mega-sessions), then sticks to bottom only on new rows", () => {
    const scroller = new OutlineAutoScroller(1500);
    expect(
      scroller.shouldScrollToLatest({
        sessionKey: "a::scopeA::",
        rowCount: 500,
        contentHeight: 2000,
        isLoading: false,
        now: 1000,
      }),
    ).toBe(true);
    // Batch 2 at t=2200 grows contentHeight -> extends settle window
    expect(
      scroller.shouldScrollToLatest({
        sessionKey: "a::scopeA::",
        rowCount: 500,
        contentHeight: 4200,
        isLoading: false,
        now: 2200,
      }),
    ).toBe(true);
    // Batch 3 at t=3400 grows contentHeight -> still pins
    expect(
      scroller.shouldScrollToLatest({
        sessionKey: "a::scopeA::",
        rowCount: 500,
        contentHeight: 6400,
        isLoading: false,
        now: 3400,
      }),
    ).toBe(true);
    // After settle window with SAME rowCount (4s poll, no new rows) -> false
    expect(
      scroller.shouldScrollToLatest({
        sessionKey: "a::scopeA::",
        rowCount: 500,
        contentHeight: 6400,
        isLoading: false,
        now: 6000,
      }),
    ).toBe(false);
    // Live new turn arrives while user is still at bottom (stickToBottom=true) -> follows bottom!
    expect(
      scroller.shouldScrollToLatest({
        sessionKey: "a::scopeA::",
        rowCount: 502,
        contentHeight: 6520,
        isLoading: false,
        now: 10000,
      }),
    ).toBe(true);
  });

  test("scrolling up disarms live stick-to-bottom; scrolling back within 48px of bottom re-arms it", () => {
    const scroller = new OutlineAutoScroller(1500);
    scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 50, isLoading: false, now: 1000 });
    // User scrolls up away from bottom after settle
    scroller.recordScroll({ scrollTop: 300, scrollHeight: 2000, clientHeight: 500, now: 3000 });
    expect(scroller.isStuckToBottom()).toBe(false);
    // New rows arrive while user is reading history -> must NOT jump!
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 53, isLoading: false, now: 4000 }),
    ).toBe(false);
    // User scrolls back down to bottom (maxTop = 1500, scrollTop = 1470 -> dist 30 <= 48)
    scroller.recordScroll({ scrollTop: 1470, scrollHeight: 2000, clientHeight: 500, now: 5000 });
    expect(scroller.isStuckToBottom()).toBe(true);
    // Next new row follows bottom again!
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 54, isLoading: false, now: 6000 }),
    ).toBe(true);
  });

  test("Bug 1: non-session tab roundtrip (mounted true -> false -> true with same sessionKey) resets and scrolls to bottom", () => {
    const scroller = new OutlineAutoScroller(1500);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", mounted: true, rowCount: 80, isLoading: false, now: 1000 }),
    ).toBe(true);
    scroller.recordWheel(-40); // user scrolled up
    expect(scroller.isStuckToBottom()).toBe(false);

    // Switch to Terminal/Files tab (inView=false -> FlatList unmounts, same sessionKey)
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", mounted: false, rowCount: 80, isLoading: false, now: 5000 }),
    ).toBe(false);

    // Return to Session A tab (inView=true -> FlatList remounts with same sessionKey)
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", mounted: true, rowCount: 80, isLoading: false, now: 6000 }),
    ).toBe(true);
    expect(scroller.isStuckToBottom()).toBe(true);
  });

  test("downward trackpad momentum (deltaY >= 0) never cancels initial bottom scroll; upward wheel (deltaY < 0) cancels immediately", () => {
    const scroller = new OutlineAutoScroller(1500);
    scroller.syncSession("s2", true);
    scroller.recordWheel(35); // residual downward momentum
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s2", rowCount: 100, isLoading: false, now: 1000 }),
    ).toBe(true);

    scroller.recordWheel(-20); // intentional upward wheel
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s2", rowCount: 100, isLoading: false, now: 1050 }),
    ).toBe(false);
  });

  test("Bug 3: clearing search restores bottom if previously at bottom, or exact scrollTop if previously reading history", () => {
    const scroller = new OutlineAutoScroller(1500);
    scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, now: 1000 });
    // Case A: user was at bottom -> types search -> clears search
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 5, isLoading: false, hasSearchQuery: true, now: 4000 }),
    ).toBe(false);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, hasSearchQuery: false, now: 5000 }),
    ).toBe(true);

    // Case B: user scrolled up to 420px -> types search -> clears search
    scroller.recordScroll({ scrollTop: 420, scrollHeight: 3000, clientHeight: 600, now: 8000 });
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 4, isLoading: false, hasSearchQuery: true, now: 9000 }),
    ).toBe(false);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, hasSearchQuery: false, now: 10000 }),
    ).toBe(false);
    expect(scroller.consumePendingRestoreScrollTop()).toBe(420);
  });

  test("Choice B helpers: drawer open and bottom group expand adjust scrollTop cleanly", () => {
    expect(
      computeDrawerOpenScrollTop({
        scrollTop: 1400,
        scrollHeight: 2000,
        prevClientHeight: 600,
        nextClientHeight: 350,
        stickToBottom: true,
      }),
    ).toBe(1650);
    expect(
      computeDrawerOpenScrollTop({
        scrollTop: 800,
        scrollHeight: 2000,
        prevClientHeight: 600,
        nextClientHeight: 350,
        stickToBottom: false,
      }),
    ).toBe(1050);

    expect(
      computeExpandedGroupScrollTop({
        scrollTop: 1380,
        prevScrollHeight: 2000,
        nextScrollHeight: 2300,
        clientHeight: 600,
      }),
    ).toBe(1680);
    // Expanding a group far above bottom leaves scrollTop untouched
    expect(
      computeExpandedGroupScrollTop({
        scrollTop: 200,
        prevScrollHeight: 2000,
        nextScrollHeight: 2300,
        clientHeight: 600,
      }),
    ).toBeNull();
    expect(initialRenderCount(120)).toBe(120);
  });

  test("touch upward scroll without wheel events still arms upward intent (long-session top-drag must load older rows)", () => {
    const scroller = new OutlineAutoScroller(1500);
    scroller.syncSession("long-session", true);
    const t0 = 1000000;
    scroller.recordScroll({ scrollTop: 4000, scrollHeight: 5000, clientHeight: 1000, now: t0 });
    for (const top of [3000, 1000, 100]) {
      scroller.recordScroll({ scrollTop: top, scrollHeight: 5000, clientHeight: 1000, now: t0 + 5000 });
    }
    expect(scroller.isUserScrolledUp()).toBe(true);
    expect(scroller.isStuckToBottom()).toBe(false);
  });

  test("trackpad upward scroll without explicit drag start still arms upward intent", () => {
    const driver = new OutlineScrollDriver(1500);
    driver.syncSession("trackpad-session", true);
    const t0 = 2000000;
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 4000 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 1000 } } },
      t0,
    );
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 5000 }, layoutMeasurement: { height: 1000 } } },
      t0 + 5000,
    );
    expect(driver.scroller.isUserScrolledUp()).toBe(true);
    expect(driver.scroller.isStuckToBottom()).toBe(false);
    driver.dispose();
  });

  test("cancels pending 60ms settle timer on session switch/dispose, prevents expand overwrite, and tracks streaming height growth", async () => {

    const driver = new OutlineScrollDriver(1500);
    let endCalls = 0;
    const offsets: number[] = [];
    const listA = {
      scrollToEnd: () => {
        endCalls++;
      },
      scrollToOffset: ({ offset }: { offset: number }) => {
        offsets.push(offset);
      },
    };
    const stateA = { sessionKey: "sessA", mounted: true, rowCount: 20, isLoading: false, hasSearchQuery: false };
    driver.maybeSync(listA, stateA, { now: 1000 });
    expect(endCalls).toBe(1);
    // Switch session immediately before 60ms settle timer fires -> timer must be cancelled
    driver.syncSession("sessB", true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(endCalls).toBe(1);

    // Expand group near bottom: handleContentSizeChange adjusts scrollToOffset and suppresses same-commit maybeSync bottom pin
    endCalls = 0;
    offsets.length = 0;
    driver.handleLayout(listA, { nativeEvent: { layout: { height: 500 } } }, { ...stateA, sessionKey: "sessB" }, 2000);
    driver.handleContentSizeChange(listA, 1500, { ...stateA, sessionKey: "sessB" }, 2010);
    driver.handleScrollEvent({ nativeEvent: { contentOffset: { y: 1000 }, contentSize: { height: 1500 }, layoutMeasurement: { height: 500 } } }, 2020);
    endCalls = 0;
    driver.prepareGroupExpand(listA, false);
    driver.handleContentSizeChange(listA, 1750, { ...stateA, sessionKey: "sessB", rowCount: 24 }, 2100);
    driver.maybeSync(listA, { ...stateA, sessionKey: "sessB", rowCount: 24 }, { now: 2110, scheduleFrame: () => {} });
    expect(offsets.length).toBe(1);
    expect(endCalls).toBe(0);
    driver.dispose();

    // Streaming height growth with constant rowCount keeps bottom pinned when stuck to bottom
    const scroller = new OutlineAutoScroller(1500);
    expect(scroller.shouldScrollToLatest({ sessionKey: "s", rowCount: 10, contentHeight: 800, isLoading: false, now: 1000 })).toBe(true);
    expect(scroller.shouldScrollToLatest({ sessionKey: "s", rowCount: 10, contentHeight: 800, isLoading: false, now: 4000 })).toBe(false);
    expect(scroller.shouldScrollToLatest({ sessionKey: "s", rowCount: 10, contentHeight: 920, isLoading: false, now: 4500 })).toBe(true);
  });

  test("preparePrepend preserves exact scrollTop by delta = nextScrollHeight - prevScrollHeight via both handleContentSizeChange and synchronous maybeSync", () => {
    // 1. Async / React Native onContentSizeChange path
    const driver = new OutlineScrollDriver(1500);
    let endCalls = 0;
    const offsets: number[] = [];
    const list = {
      scrollToEnd: () => {
        endCalls++;
      },
      scrollToOffset: ({ offset }: { offset: number }) => {
        offsets.push(offset);
      },
    };
    const state = {
      sessionKey: "sess-prepend",
      mounted: true,
      rowCount: 150,
      isLoading: false,
      hasSearchQuery: false,
    };
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, state, 1000);
    driver.handleContentSizeChange(list, 3000, state, 1010);
    // User scrolls near top to scrollTop = 120
    driver.handleWheel({ deltaY: -40 });
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 120 }, contentSize: { height: 3000 }, layoutMeasurement: { height: 600 } } },
      2000,
    );
    endCalls = 0;
    offsets.length = 0;

    // Prepend 150 older rows -> scrollHeight grows 3000 -> 5850 (delta = 2850)
    driver.preparePrepend(list);
    driver.maybeSync(list, { ...state, rowCount: 300 }, { now: 2050, scheduleFrame: () => {} });
    expect(endCalls).toBe(0);
    expect(offsets).toEqual([]);
    driver.handleContentSizeChange(list, 5850, { ...state, rowCount: 300 }, 2060);
    expect(offsets).toEqual([120 + 2850]);
    expect(endCalls).toBe(0);
    driver.dispose();

    // 2. Synchronous Web DOM useLayoutEffect path (scrollHeight updated before maybeSync)
    const domDriver = new OutlineScrollDriver(1500);
    const domNode = { scrollTop: 120, scrollHeight: 3000, clientHeight: 600 };
    const domList = {
      getScrollableNode: () => domNode,
      scrollToEnd: () => {
        endCalls++;
      },
      scrollToOffset: ({ offset }: { offset: number }) => {
        domNode.scrollTop = offset;
      },
    };
    domDriver.syncSession("sess-web", true);
    domDriver.maybeSync(domList, { ...state, sessionKey: "sess-web" }, { now: 1000, scheduleFrame: () => {} });
    domNode.scrollTop = 90;
    domDriver.preparePrepend(domList);
    domNode.scrollHeight = 4500; // Grew synchronously by 1500px
    endCalls = 0;
    domDriver.maybeSync(domList, { ...state, sessionKey: "sess-web", rowCount: 250 }, { now: 2000, scheduleFrame: () => {} });
  });

  test("display:none retention cycle never arms upward intent and restores scrollTop on revive", () => {
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 1446, scrollHeight: 4598, clientHeight: 731 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => { dom.scrollTop = offset; },
      scrollToEnd: () => {},
    };
    const state = { sessionKey: "sess-live", mounted: true, rowCount: 150, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-live", true);
    driver.handleScrollEvent({ nativeEvent: { contentOffset: { y: 1446 }, contentSize: { height: 4598 }, layoutMeasurement: { height: 731 } } });
    // Host hides panel: layout collapses, Chromium reports scrollTop 0.
    dom.scrollTop = 0;
    dom.scrollHeight = 0;
    dom.clientHeight = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 0 } } }, state, 2000);
    driver.handleScrollEvent({ nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 0 }, layoutMeasurement: { height: 0 } } });
    expect(driver.scroller.isUserScrolledUp()).toBe(false);
    expect(driver.scroller.isStuckToBottom()).toBe(true);
    expect(driver.hasLiveLayout(list)).toBe(false);
    // Host revives panel: DOM scrollTop is still 0, must restore 1446.
    dom.scrollHeight = 4598;
    dom.clientHeight = 731;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 731 } } }, state, 3000);
    expect(dom.scrollTop).toBe(1446);
    expect(driver.hasLiveLayout(list)).toBe(true);
  });

  test("preparePrepend during collapsed layout does not snapshot a stale position", () => {
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 500, scrollHeight: 4598, clientHeight: 731 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => { dom.scrollTop = offset; },
      scrollToEnd: () => {},
    };
    const state = { sessionKey: "sess-live", mounted: true, rowCount: 150, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-live", true);
    driver.handleLayout(list, { nativeEvent: { layout: { height: 731 } } }, state, 1000);
    driver.handleContentSizeChange(list, 4598, state, 1010);
    driver.handleScrollEvent({ nativeEvent: { contentOffset: { y: 500 }, contentSize: { height: 4598 }, layoutMeasurement: { height: 731 } } });
    // Collapse, then a stray prepend snapshot attempt during hidden layout.
    dom.scrollTop = 0;
    dom.scrollHeight = 0;
    dom.clientHeight = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 0 } } }, state, 2000);
    driver.preparePrepend(list);
    // Revive: restore 500, then a content-size event must not stale-jump.
    dom.scrollHeight = 4598;
    dom.clientHeight = 731;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 731 } } }, state, 3000);
    expect(dom.scrollTop).toBe(500);
    driver.handleContentSizeChange(list, 4598, state, 4000);
    expect(dom.scrollTop).toBe(500);
  });

  test("switching sessions while hidden (0-layout) clears prior upward intent and pins new session to bottom on revive", () => {
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 1200, scrollHeight: 4500, clientHeight: 600 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => {
        dom.scrollTop = offset;
      },
      scrollToEnd: () => {
        dom.scrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
      },
    };
    const stateA = { sessionKey: "sess-a", mounted: true, rowCount: 120, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-a", true);
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, stateA, 1000);
    driver.handleWheel({ deltaY: -100 });
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 1200 }, contentSize: { height: 4500 }, layoutMeasurement: { height: 600 } } },
      1200,
    );
    expect(driver.scroller.isUserScrolledUp()).toBe(true);

    // Panel collapses via display:none while reading sess-a at 1200.
    dom.scrollTop = 0;
    dom.scrollHeight = 0;
    dom.clientHeight = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 0 } } }, stateA, 2000);
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 0 }, layoutMeasurement: { height: 0 } } },
      2005,
    );

    // Same-session revive restores user scrollTop 1200.
    dom.scrollHeight = 4500;
    dom.clientHeight = 600;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, stateA, 2500);
    expect(dom.scrollTop).toBe(1200);

    // Collapse again, then switch to sess-b while hidden for >2s (beyond 1500ms settle window).
    dom.scrollTop = 0;
    dom.scrollHeight = 0;
    dom.clientHeight = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 0 } } }, stateA, 3000);
    const stateB = { sessionKey: "sess-b", mounted: true, rowCount: 220, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-b", true);
    driver.maybeSync(list, stateB, { now: 3100, scheduleFrame: () => {} });
    driver.handleContentSizeChange(list, 12000, stateB, 3200);

    // Revive on sess-b after >2s: must pin to bottom (11400), never remain at top (0) or inherit sess-a's 1200!
    dom.scrollHeight = 12000;
    dom.clientHeight = 600;
    dom.scrollTop = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, stateB, 5500);
    expect(dom.scrollTop).toBe(11400);
    expect(driver.scroller.isUserScrolledUp()).toBe(false);
    expect(driver.scroller.isStuckToBottom()).toBe(true);
    driver.dispose();
  });

  test("same-session intentional scroll-to-top (scrollTop=0) stays at top across collapse/revive, while fresh mount pins bottom", () => {
    // 1. User intentionally scrolled all the way up to 0 on sess-a -> collapse -> revive must keep 0.
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 0, scrollHeight: 4500, clientHeight: 600 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => {
        dom.scrollTop = offset;
      },
      scrollToEnd: () => {
        dom.scrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight);
      },
    };
    const stateA = { sessionKey: "sess-a", mounted: true, rowCount: 100, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-a", true);
    driver.maybeSync(list, stateA, { now: 1000, scheduleFrame: () => {} });
    expect(dom.scrollTop).toBe(3900);
    driver.handleWheel({ deltaY: -200 });
    dom.scrollTop = 0;
    driver.handleScrollEvent(
      { nativeEvent: { contentOffset: { y: 0 }, contentSize: { height: 4500 }, layoutMeasurement: { height: 600 } } },
      3000,
    );
    expect(driver.scroller.isUserScrolledUp()).toBe(true);

    dom.scrollHeight = 0;
    dom.clientHeight = 0;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 0 } } }, stateA, 4000);
    dom.scrollHeight = 4500;
    dom.clientHeight = 600;
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, stateA, 4500);
    expect(dom.scrollTop).toBe(0);
    driver.dispose();

    // 2. Freshly mounted session where handleLayout(height: 600) precedes handleContentSizeChange(9600)
    // must keep pending bottom pin and land at 9000 once content height arrives.
    const fresh = new OutlineScrollDriver(1500);
    const domB = { scrollTop: 0, scrollHeight: 0, clientHeight: 600 };
    const listB = {
      getScrollableNode: () => domB,
      scrollToOffset: ({ offset }: { offset: number }) => {
        domB.scrollTop = offset;
      },
      scrollToEnd: () => {
        domB.scrollTop = Math.max(0, domB.scrollHeight - domB.clientHeight);
      },
    };
    const stateB = { sessionKey: "sess-fresh", mounted: true, rowCount: 160, isLoading: false, hasSearchQuery: false };
    fresh.syncSession("sess-fresh", true);
    fresh.handleLayout(listB, { nativeEvent: { layout: { height: 600 } } }, stateB, 1000);
    expect(domB.scrollTop).toBe(0);
    domB.scrollHeight = 9600;
    fresh.handleContentSizeChange(listB, 9600, stateB, 1100);
    expect(domB.scrollTop).toBe(9000);
    fresh.dispose();
  });

  test("jumpToLatest resumes following after upward scroll and pins later rows", () => {
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 1200, scrollHeight: 4500, clientHeight: 600 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => { dom.scrollTop = offset; },
      scrollToEnd: () => { dom.scrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight); },
    };
    const state = { sessionKey: "sess-jump", mounted: true, rowCount: 120, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-jump", true);
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, state, 1000);
    driver.handleWheel({ nativeEvent: { deltaY: -10 } });
    driver.handleScrollEvent({ nativeEvent: { contentOffset: { y: 1200 }, contentSize: { height: 4500 }, layoutMeasurement: { height: 600 } } }, 1200);
    expect(driver.scroller.isUserScrolledUp()).toBe(true);
    expect(driver.jumpToLatest(list, state, 2000)).toBe(true);
    expect(dom.scrollTop).toBe(3900);
    expect(driver.scroller.isUserScrolledUp()).toBe(false);
    expect(driver.scroller.isStuckToBottom()).toBe(true);
    dom.scrollHeight = 5100;
    driver.handleContentSizeChange(list, 5100, state, 3000);
    expect(dom.scrollTop).toBe(4500);
  });

  test("jumpToLatest works at row 0 without upward intent and is safe while hidden or searching", () => {
    const driver = new OutlineScrollDriver(1500);
    const dom = { scrollTop: 0, scrollHeight: 0, clientHeight: 600 };
    const list = {
      getScrollableNode: () => dom,
      scrollToOffset: ({ offset }: { offset: number }) => { dom.scrollTop = offset; },
      scrollToEnd: () => { dom.scrollTop = Math.max(0, dom.scrollHeight - dom.clientHeight); },
    };
    const state = { sessionKey: "sess-zero", mounted: true, rowCount: 120, isLoading: false, hasSearchQuery: false };
    driver.syncSession("sess-zero", true);
    driver.handleLayout(list, { nativeEvent: { layout: { height: 600 } } }, state, 1000);
    expect(driver.scroller.isUserScrolledUp()).toBe(false);
    dom.scrollHeight = 4500;
    expect(driver.jumpToLatest(list, state, 2000)).toBe(true);
    expect(dom.scrollTop).toBe(3900);
    expect(driver.jumpToLatest(list, { ...state, mounted: false }, 2100)).toBe(false);
    expect(driver.jumpToLatest(list, { ...state, hasSearchQuery: true }, 2200)).toBe(true);
    expect(dom.scrollTop).toBe(3900);
    const other = { ...state, sessionKey: "sess-other" };
    dom.scrollHeight = 5100;
    driver.maybeSync(list, other, { contentHeight: 5100, now: 2300 });
    expect(dom.scrollTop).toBe(4500);
  });
});
