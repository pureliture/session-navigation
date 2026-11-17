export const OUTLINE_SETTLE_WINDOW_MS = 1500;
export const OUTLINE_MAX_INITIAL_RENDER = 400;
export const OUTLINE_MIN_INITIAL_RENDER = 50;
export const OUTLINE_BOTTOM_STICK_THRESHOLD_PX = 48;
export const OUTLINE_PROGRAMMATIC_SCROLL_GUARD_MS = 150;

export function initialRenderCount(totalRows: number): number {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return OUTLINE_MIN_INITIAL_RENDER;
  return Math.min(Math.max(Math.trunc(totalRows), OUTLINE_MIN_INITIAL_RENDER), OUTLINE_MAX_INITIAL_RENDER);
}

export function computeDrawerOpenScrollTop(input: {
  scrollTop: number;
  scrollHeight: number;
  prevClientHeight: number;
  nextClientHeight: number;
  stickToBottom: boolean;
}): number | null {
  const shrink = input.prevClientHeight - input.nextClientHeight;
  if (!(shrink > 8) || input.nextClientHeight <= 0) return null;
  const maxTop = Math.max(0, input.scrollHeight - input.nextClientHeight);
  if (input.stickToBottom) return maxTop;
  return Math.min(maxTop, Math.max(0, input.scrollTop + shrink));
}

export function computeExpandedGroupScrollTop(input: {
  scrollTop: number;
  prevScrollHeight: number;
  nextScrollHeight: number;
  clientHeight: number;
}): number | null {
  const grown = input.nextScrollHeight - input.prevScrollHeight;
  if (!(grown > 8) || input.clientHeight <= 0) return null;
  const prevMaxTop = Math.max(0, input.prevScrollHeight - input.clientHeight);
  const distFromPrevBottom = Math.max(0, prevMaxTop - input.scrollTop);
  if (distFromPrevBottom > 96) return null;
  const step = Math.min(grown, Math.max(120, Math.floor(input.clientHeight * 0.6)));
  const nextMaxTop = Math.max(0, input.nextScrollHeight - input.clientHeight);
  return Math.min(nextMaxTop, input.scrollTop + step);
}

export class OutlineAutoScroller {
  private activeKey = "";
  private wasMounted = false;
  private userScrolledUp = false;
  private stickToBottom = true;
  private settledAt: number | null = null;
  private lastRowCount = 0;
  private lastScrollHeight = 0;
  private lastScrollTop = 0;
  private programmaticScrollUntil = 0;
  private wasSearching = false;
  private savedPreSearch: { stickToBottom: boolean; scrollTop: number } | null = null;
  private pendingRestoreScrollTop: number | null = null;

  constructor(private readonly settleWindowMs = OUTLINE_SETTLE_WINDOW_MS) {}

  syncSession(sessionKey: string, mounted = true): boolean {
    if (!mounted) {
      const changed = this.wasMounted;
      this.wasMounted = false;
      this.activeKey = sessionKey;
      return changed;
    }
    if (sessionKey === this.activeKey && this.wasMounted) return false;
    this.activeKey = sessionKey;
    this.wasMounted = true;
    this.userScrolledUp = false;
    this.stickToBottom = true;
    this.settledAt = null;
    this.lastRowCount = 0;
    this.lastScrollHeight = 0;
    this.lastScrollTop = 0;
    this.programmaticScrollUntil = 0;
    this.wasSearching = false;
    this.savedPreSearch = null;
    this.pendingRestoreScrollTop = null;
    return true;
  }

  recordWheel(deltaY: number): void {
    if (deltaY < 0) {
      this.userScrolledUp = true;
      this.stickToBottom = false;
    }
  }

  recordDragStart(): void {
    this.userScrolledUp = true;
  }

  markProgrammaticScroll(now = Date.now()): void {
    this.programmaticScrollUntil = now + OUTLINE_PROGRAMMATIC_SCROLL_GUARD_MS;
  }

  isUserScrolledUp(): boolean {
    return this.userScrolledUp;
  }

  isStuckToBottom(): boolean {
    return this.stickToBottom;
  }

  getLastScrollTop(): number {
    return this.lastScrollTop;
  }

  consumePendingRestoreScrollTop(): number | null {
    const val = this.pendingRestoreScrollTop;
    this.pendingRestoreScrollTop = null;
    return val;
  }

  private inInitialSettle(now: number): boolean {
    return !this.userScrolledUp && (this.settledAt === null || now - this.settledAt <= this.settleWindowMs);
  }

  recordScroll(metrics: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    now?: number;
  }): void {
    const now = metrics.now ?? Date.now();
    this.lastScrollTop = Math.max(0, metrics.scrollTop);
    const maxTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    const distFromBottom = Math.max(0, maxTop - this.lastScrollTop);
    if (distFromBottom <= OUTLINE_BOTTOM_STICK_THRESHOLD_PX) {
      this.stickToBottom = true;
      this.userScrolledUp = false;
      return;
    }
    if (now <= this.programmaticScrollUntil) {
      return;
    }
    if (!this.inInitialSettle(now) || this.userScrolledUp) {
      this.stickToBottom = false;
    }
  }

  shouldScrollToLatest(input: {
    sessionKey: string;
    mounted?: boolean;
    rowCount: number;
    contentHeight?: number;
    isLoading: boolean;
    hasSearchQuery?: boolean;
    now?: number;
  }): boolean {
    const mounted = input.mounted ?? true;
    this.syncSession(input.sessionKey, mounted);
    if (!mounted) return false;
    const now = input.now ?? Date.now();
    const searching = Boolean(input.hasSearchQuery);

    if (searching) {
      if (!this.wasSearching) {
        this.savedPreSearch = {
          stickToBottom: this.stickToBottom,
          scrollTop: this.lastScrollTop,
        };
        this.wasSearching = true;
      }
      return false;
    }

    if (this.wasSearching) {
      if (input.isLoading) return false;
      this.wasSearching = false;
      const prev = this.savedPreSearch;
      this.savedPreSearch = null;
      this.lastRowCount = input.rowCount;
      if (!prev || prev.stickToBottom) {
        this.userScrolledUp = false;
        this.stickToBottom = true;
        this.settledAt = now;
        this.pendingRestoreScrollTop = null;
        return input.rowCount > 0;
      }
      this.stickToBottom = false;
      this.pendingRestoreScrollTop = prev.scrollTop;
      return false;
    }

    if (input.rowCount <= 0) return false;

    if (!this.userScrolledUp) {
      if (input.isLoading) {
        this.settledAt = null;
        this.lastRowCount = input.rowCount;
        return true;
      }
      if (this.settledAt === null) {
        this.settledAt = now;
        this.lastRowCount = input.rowCount;
        if (typeof input.contentHeight === "number" && input.contentHeight > 0) {
          this.lastScrollHeight = input.contentHeight;
        }
        return true;
      }
      if (now - this.settledAt <= this.settleWindowMs) {
        if (typeof input.contentHeight === "number" && input.contentHeight > this.lastScrollHeight) {
          this.lastScrollHeight = input.contentHeight;
          this.settledAt = now;
        }
        this.lastRowCount = input.rowCount;
        return true;
      }
    }

    const grew = input.rowCount > this.lastRowCount;
    this.lastRowCount = input.rowCount;
    if (typeof input.contentHeight === "number" && input.contentHeight > 0) {
      this.lastScrollHeight = input.contentHeight;
    }
    return grew && this.stickToBottom && !input.isLoading;
  }
}

export interface OutlineScrollListHandle {
  scrollToEnd?: (params?: { animated?: boolean }) => void;
  scrollTo?: (params: { x?: number; y: number; animated?: boolean }) => void;
  scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
  getScrollableNode?: () => any;
  _listRef?: { _scrollRef?: { getScrollableNode?: () => any } };
}

export interface OutlineScrollStateSnapshot {
  sessionKey: string;
  mounted: boolean;
  rowCount: number;
  isLoading: boolean;
  hasSearchQuery: boolean;
}

export class OutlineScrollDriver {
  readonly scroller: OutlineAutoScroller;
  private metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  private pendingExpand: { prevScrollHeight: number; scrollTop: number } | null = null;
  private pendingDrawer: {
    prevClientHeight: number;
    scrollTop: number;
    stickToBottom: boolean;
  } | null = null;

  constructor(settleWindowMs = OUTLINE_SETTLE_WINDOW_MS) {
    this.scroller = new OutlineAutoScroller(settleWindowMs);
  }

  syncSession(sessionKey: string, mounted: boolean): boolean {
    const reset = this.scroller.syncSession(sessionKey, mounted);
    if (reset) {
      this.metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      this.pendingExpand = null;
      this.pendingDrawer = null;
    }
    return reset;
  }

  resetTransient(): void {
    this.metrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    this.pendingExpand = null;
    this.pendingDrawer = null;
  }

  private domScrollable(list: OutlineScrollListHandle | null | undefined): any {
    if (!list) return null;
    const node = list.getScrollableNode?.() ?? list._listRef?._scrollRef?.getScrollableNode?.() ?? null;
    return node && typeof node === "object" ? node : null;
  }

  readMetrics(list: OutlineScrollListHandle | null | undefined) {
    const dom = this.domScrollable(list);
    return {
      scrollTop: typeof dom?.scrollTop === "number" ? dom.scrollTop : this.metrics.scrollTop,
      scrollHeight: typeof dom?.scrollHeight === "number" ? dom.scrollHeight : this.metrics.scrollHeight,
      clientHeight: typeof dom?.clientHeight === "number" ? dom.clientHeight : this.metrics.clientHeight,
    };
  }

  scrollToOffset(list: OutlineScrollListHandle | null | undefined, targetTop: number, now?: number): boolean {
    if (!list) return false;
    this.scroller.markProgrammaticScroll(now);
    const m = this.readMetrics(list);
    const maxTop =
      m.scrollHeight > 0 && m.clientHeight > 0
        ? Math.max(0, m.scrollHeight - m.clientHeight)
        : Math.max(0, targetTop);
    const clamped = Math.min(Math.max(0, targetTop), maxTop);
    this.metrics.scrollTop = clamped;
    if (typeof list.scrollToOffset === "function") {
      list.scrollToOffset({ offset: clamped, animated: false });
    } else {
      list.scrollTo?.({ y: clamped, animated: false });
    }
    const dom = this.domScrollable(list);
    if (dom && typeof dom.scrollHeight === "number") {
      dom.scrollTop = clamped;
    }
    return true;
  }

  scrollToBottom(list: OutlineScrollListHandle | null | undefined, now?: number): boolean {
    if (!list) return false;
    this.scroller.markProgrammaticScroll(now);
    list.scrollToEnd?.({ animated: false });
    const dom = this.domScrollable(list);
    if (dom && typeof dom.scrollHeight === "number") {
      const bottomTop = Math.max(0, dom.scrollHeight - (dom.clientHeight ?? 0));
      dom.scrollTop = bottomTop;
      this.metrics.scrollTop = bottomTop;
      this.metrics.scrollHeight = dom.scrollHeight;
      if (typeof dom.clientHeight === "number" && dom.clientHeight > 0) {
        this.metrics.clientHeight = dom.clientHeight;
      }
      return true;
    }
    const m = this.readMetrics(list);
    if (m.scrollHeight > 0) {
      const bottomTop = Math.max(0, m.scrollHeight - m.clientHeight);
      this.metrics.scrollTop = bottomTop;
      if (typeof list.scrollTo === "function" && typeof list.scrollToEnd !== "function") {
        list.scrollTo({ y: bottomTop, animated: false });
      }
    }
    return true;
  }

  prepareGroupExpand(list: OutlineScrollListHandle | null | undefined, currentlyExpanded: boolean): void {
    if (!currentlyExpanded) {
      const m = this.readMetrics(list);
      if (m.scrollHeight > 0) {
        this.pendingExpand = { prevScrollHeight: m.scrollHeight, scrollTop: m.scrollTop };
      }
    } else {
      this.pendingExpand = null;
    }
  }

  prepareDrawerToggle(list: OutlineScrollListHandle | null | undefined, willOpen: boolean): void {
    if (willOpen) {
      const m = this.readMetrics(list);
      if (m.clientHeight > 0) {
        this.pendingDrawer = {
          prevClientHeight: m.clientHeight,
          scrollTop: m.scrollTop,
          stickToBottom: this.scroller.isStuckToBottom(),
        };
      }
    } else {
      this.pendingDrawer = null;
    }
  }

  handleWheel(ev: any): void {
    const dy = Number(ev?.nativeEvent?.deltaY ?? ev?.deltaY ?? 0);
    if (Number.isFinite(dy)) this.scroller.recordWheel(dy);
  }

  handleDragStart(): void {
    this.scroller.recordDragStart();
  }

  handleScrollEvent(ev: any, now?: number): void {
    const ne = ev?.nativeEvent;
    const top = ne?.contentOffset?.y;
    const sh = ne?.contentSize?.height;
    const ch = ne?.layoutMeasurement?.height;
    if (typeof top === "number") this.metrics.scrollTop = top;
    if (typeof sh === "number") this.metrics.scrollHeight = sh;
    if (typeof ch === "number") this.metrics.clientHeight = ch;
    if (typeof top === "number" && typeof sh === "number" && typeof ch === "number") {
      this.scroller.recordScroll({ scrollTop: top, scrollHeight: sh, clientHeight: ch, now });
    }
  }

  maybeSync(
    list: OutlineScrollListHandle | null | undefined,
    state: OutlineScrollStateSnapshot,
    opts?: { contentHeight?: number; now?: number; scheduleFrame?: (cb: () => void) => void },
  ): void {
    const shouldBottom = this.scroller.shouldScrollToLatest({
      sessionKey: state.sessionKey,
      mounted: state.mounted,
      rowCount: state.rowCount,
      contentHeight: opts?.contentHeight,
      isLoading: state.isLoading,
      hasSearchQuery: state.hasSearchQuery,
      now: opts?.now,
    });
    const schedule =
      opts?.scheduleFrame ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : undefined);
    const restoreTop = this.scroller.consumePendingRestoreScrollTop();
    if (restoreTop !== null) {
      try {
        this.scrollToOffset(list, restoreTop, opts?.now);
        schedule?.(() => {
          try {
            this.scrollToOffset(list, restoreTop);
          } catch {
            // Ignore unmount during frame callback.
          }
        });
      } catch {
        // Ignore mock environments.
      }
      return;
    }
    if (!shouldBottom) return;
    try {
      if (!this.scrollToBottom(list, opts?.now)) return;
      schedule?.(() => {
        if (!this.scroller.isUserScrolledUp()) {
          try {
            this.scrollToBottom(list);
          } catch {
            // Ignore transient unmount during frame callback.
          }
        }
      });
      if (opts?.scheduleFrame === undefined && typeof setTimeout === "function") {
        setTimeout(() => {
          if (!this.scroller.isUserScrolledUp() && this.scroller.isStuckToBottom()) {
            try {
              this.scrollToBottom(list);
            } catch {
              // Ignore unmount during settle timer.
            }
          }
        }, 60);
      }
    } catch {
      // Ignore non-scrollable mock environments.
    }
  }

  handleLayout(
    list: OutlineScrollListHandle | null | undefined,
    ev: any,
    state: OutlineScrollStateSnapshot,
    now?: number,
  ): void {
    const layoutH = ev?.nativeEvent?.layout?.height;
    if (typeof layoutH === "number" && layoutH > 0) {
      this.metrics.clientHeight = layoutH;
    }
    const drawerSnap = this.pendingDrawer;
    if (drawerSnap) {
      const m = this.readMetrics(list);
      if (m.clientHeight > 0 && m.scrollHeight > 0 && m.clientHeight < drawerSnap.prevClientHeight) {
        this.pendingDrawer = null;
        const nextTop = computeDrawerOpenScrollTop({
          scrollTop: drawerSnap.scrollTop,
          scrollHeight: m.scrollHeight,
          prevClientHeight: drawerSnap.prevClientHeight,
          nextClientHeight: m.clientHeight,
          stickToBottom: drawerSnap.stickToBottom,
        });
        if (nextTop !== null) {
          this.scrollToOffset(list, nextTop, now);
          return;
        }
      }
    }
    this.maybeSync(list, state, { now });
  }

  handleContentSizeChange(
    list: OutlineScrollListHandle | null | undefined,
    h: number,
    state: OutlineScrollStateSnapshot,
    now?: number,
  ): void {
    if (typeof h === "number" && h >= 0) {
      this.metrics.scrollHeight = h;
    }
    const expandSnap = this.pendingExpand;
    if (expandSnap && h > expandSnap.prevScrollHeight) {
      this.pendingExpand = null;
      const m = this.readMetrics(list);
      const nextTop = computeExpandedGroupScrollTop({
        scrollTop: expandSnap.scrollTop,
        prevScrollHeight: expandSnap.prevScrollHeight,
        nextScrollHeight: h,
        clientHeight: m.clientHeight,
      });
      if (nextTop !== null) {
        this.scrollToOffset(list, nextTop, now);
        return;
      }
    }
    this.maybeSync(list, state, { contentHeight: h, now });
  }
}
