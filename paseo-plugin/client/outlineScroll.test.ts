import { describe, expect, test } from "bun:test";
import { initialRenderCount, OutlineAutoScroller } from "./outlineScroll";

describe("OutlineAutoScroller", () => {
  test("continues scrolling across multi-batch FlatList layout updates within settle window, then stops for polling", () => {
    const scroller = new OutlineAutoScroller(1500);
    // Batch 1 (first 30 rows mounted at t=1000)
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", rowCount: 120, isLoading: false, now: 1000 }),
    ).toBe(true);
    // Batch 2 & 3 (rows 30..120 mounted at t=1080 and t=1200) MUST still auto-scroll!
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", rowCount: 120, isLoading: false, now: 1080 }),
    ).toBe(true);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", rowCount: 120, isLoading: false, now: 1200 }),
    ).toBe(true);
    // 4s periodic poll at t=5000 MUST NOT yank scroll position
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "a::scopeA::", rowCount: 121, isLoading: false, now: 5000 }),
    ).toBe(false);
  });

  test("keeps settle window open while secondary Hermes timeline query is still loading", () => {
    const scroller = new OutlineAutoScroller(1500);
    // DB rows arrive first while fallbackTimelineQuery is still loading
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "h::hermesA::", rowCount: 23, isLoading: true, now: 1000 }),
    ).toBe(true);
    // 2 seconds later, fallbackTimelineQuery finishes and merges 85 rows
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "h::hermesA::", rowCount: 85, isLoading: false, now: 3000 }),
    ).toBe(true);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "h::hermesA::", rowCount: 85, isLoading: false, now: 4000 }),
    ).toBe(true);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "h::hermesA::", rowCount: 85, isLoading: false, now: 4600 }),
    ).toBe(false);
  });

  test("user wheel/pointer interaction immediately cancels auto-scroll, and session switch resets synchronously", () => {
    const scroller = new OutlineAutoScroller(1500);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, now: 1000 }),
    ).toBe(true);
    scroller.markUserInteracted();
    expect(scroller.isUserInteracted()).toBe(true);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, now: 1050 }),
    ).toBe(false);

    // Switching to s2 and back to s1 resets synchronously before child layout callbacks fire
    expect(scroller.syncSession("s2")).toBe(true);
    expect(scroller.isUserInteracted()).toBe(false);
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s2", rowCount: 90, isLoading: false, now: 2000 }),
    ).toBe(true);
    scroller.markUserInteracted();
    expect(
      scroller.shouldScrollToLatest({ sessionKey: "s1", rowCount: 100, isLoading: false, now: 3000 }),
    ).toBe(true);
  });

  test("initialRenderCount covers full collapsed outline up to cap", () => {
    expect(initialRenderCount(0)).toBe(50);
    expect(initialRenderCount(12)).toBe(50);
    expect(initialRenderCount(120)).toBe(120);
    expect(initialRenderCount(900)).toBe(400);
  });
});
