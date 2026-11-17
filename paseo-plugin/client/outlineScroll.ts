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
