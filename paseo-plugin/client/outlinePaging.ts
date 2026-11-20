import type { Row } from "../shared/sessionNav";
import { mergePagedRows } from "./fallbackTimeline";

export type OlderServerPageState = {
  sessionKey: string;
  rows: Row[];
  hasOlder: boolean;
  nextBeforeIndex: number | null;
  totalRows?: number;
};

/**
 * Decide whether previously paged older server rows are stale and must be
 * dropped. Search replaces the visible list, so older pages no longer apply;
 * a tail that no longer pages older (or whose totals shrank after a live
 * compaction) means the older rows were paged from an older chunk.
 */
export function shouldInvalidateOlderServerPage(args: {
  state: OlderServerPageState | null | undefined;
  sessionKey: string;
  tailHasOlder: boolean;
  tailTotalRows?: number;
  searchActive: boolean;
}): boolean {
  const { state, sessionKey, tailHasOlder, tailTotalRows, searchActive } = args;
  if (!state || state.sessionKey !== sessionKey) return false;
  if (searchActive) return true;
  if (!tailHasOlder) return true;
  if (
    typeof tailTotalRows === "number" &&
    typeof state.totalRows === "number" &&
    tailTotalRows < state.totalRows
  ) {
    return true;
  }
  return false;
}

/**
 * Append a freshly fetched older page. Totals are taken from the fresh page
 * only: a stale pre-compaction snapshot is never carried forward, so a later
 * tail refresh cannot mix old-chunk and new-chunk cursors.
 */
export function appendOlderServerPage(args: {
  prev: OlderServerPageState | null | undefined;
  sessionKey: string;
  items: Row[];
  hasOlder: boolean;
  nextBeforeIndex: number | null;
  totalRows?: number;
}): OlderServerPageState {
  const baseRows = args.prev?.sessionKey === args.sessionKey ? args.prev.rows : [];
  return {
    sessionKey: args.sessionKey,
    rows: mergePagedRows(args.items, baseRows),
    hasOlder: args.hasOlder,
    nextBeforeIndex: args.nextBeforeIndex,
    totalRows: args.totalRows,
  };
}
