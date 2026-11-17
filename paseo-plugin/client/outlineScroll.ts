export const OUTLINE_SETTLE_WINDOW_MS = 1500;
export const OUTLINE_MAX_INITIAL_RENDER = 400;
export const OUTLINE_MIN_INITIAL_RENDER = 50;

export function initialRenderCount(totalRows: number): number {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return OUTLINE_MIN_INITIAL_RENDER;
  return Math.min(Math.max(Math.trunc(totalRows), OUTLINE_MIN_INITIAL_RENDER), OUTLINE_MAX_INITIAL_RENDER);
}

export class OutlineAutoScroller {
  private activeKey = "";
  private userInteracted = false;
  private settledAt: number | null = null;

  constructor(private readonly settleWindowMs = OUTLINE_SETTLE_WINDOW_MS) {}

  syncSession(sessionKey: string): boolean {
    if (sessionKey === this.activeKey) return false;
    this.activeKey = sessionKey;
    this.userInteracted = false;
    this.settledAt = null;
    return true;
  }

  markUserInteracted(): void {
    this.userInteracted = true;
  }

  isUserInteracted(): boolean {
    return this.userInteracted;
  }

  shouldScrollToLatest(input: {
    sessionKey: string;
    rowCount: number;
    isLoading: boolean;
    hasSearchQuery?: boolean;
    now?: number;
  }): boolean {
    this.syncSession(input.sessionKey);
    if (this.userInteracted || input.hasSearchQuery || input.rowCount <= 0) {
      return false;
    }
    const now = input.now ?? Date.now();
    if (input.isLoading) {
      // Keep the settle window open while secondary timeline queries are still merging.
      this.settledAt = null;
      return true;
    }
    if (this.settledAt === null) {
      this.settledAt = now;
      return true;
    }
    return now - this.settledAt <= this.settleWindowMs;
  }
}
