import type { usePaseo } from "@getpaseo/plugin/client";
import { identityMatches } from "./chatNavigation";
import { recordClientPerf } from "./diagnostics";
import type { SessionTab } from "./hostCompat";
import { readTimelineHistory, type TimelineHistory } from "./timelineHistory";

type PaseoAgentTimelineHandle = ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>["timeline"];

function extractIdsFromEntries(entries: TimelineHistory["entries"]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const item = entry.item;
    if (!item) continue;
    for (const key of ["messageId", "callId", "id"] as const) {
      const value = item[key];
      if (typeof value === "string" && value.length > 0) ids.push(value);
    }
  }
  return ids;
}

export function compileVisibleMatcher(
  visibleValues: readonly string[],
): (identity: string) => boolean {
  const exact = new Set(visibleValues);
  return (identity: string) => {
    if (exact.has(identity)) return true;
    return visibleValues.some((value) => identityMatches(value, identity));
  };
}

export type SessionTimelineCursor = { epoch: string; seq: number };

export interface SessionTimelinePage {
  ids: string[];
  complete: boolean;
  startCursor?: SessionTimelineCursor;
}

export interface ProgressiveSessionTargetResult {
  targetId: string | null;
  confirmed: boolean;
  incompleteIds: string[];
  failedIds: string[];
}

export async function readSessionTimelineIds(timeline: Pick<PaseoAgentTimelineHandle, "refetch">) {
  const { entries, complete } = await readTimelineHistory(timeline, { allowPartial: true });
  return { ids: extractIdsFromEntries(entries), complete };
}

export async function readSessionTailIds(
  timeline: Pick<PaseoAgentTimelineHandle, "refetch">,
  limit = 200,
): Promise<{ ids: string[]; complete: boolean }> {
  const page = await readSessionTimelinePage(timeline, undefined, limit);
  return { ids: page.ids, complete: page.complete };
}

export async function readSessionTimelinePage(
  timeline: Pick<PaseoAgentTimelineHandle, "refetch">,
  cursor?: SessionTimelineCursor,
  limit?: number,
): Promise<SessionTimelinePage> {
  const page = cursor
    ? await timeline.refetch({
        direction: "before",
        cursor,
        limit: limit ?? 1000,
        projection: "canonical",
      })
    : await timeline.refetch({
        direction: "tail",
        limit: limit ?? 200,
        projection: "canonical",
      });
  if (page.error) throw new Error(page.error);
  if (
    cursor &&
    (!page.entries.length ||
      (page.startCursor &&
        page.startCursor.epoch === cursor.epoch &&
        page.startCursor.seq >= cursor.seq))
  ) {
    return {
      ids: [],
      complete: page.hasOlder === false,
      startCursor: undefined,
    };
  }
  const complete = page.hasOlder === false;
  return {
    ids: extractIdsFromEntries(page.entries as TimelineHistory["entries"]),
    complete,
    startCursor: complete ? undefined : (page.startCursor ?? undefined),
  };
}

export function sessionFollowCandidates(workspaceAgentIds: readonly string[] | undefined, scopeAgentIds: readonly string[]): readonly string[] {
  return workspaceAgentIds ?? scopeAgentIds;
}

export async function resolveSessionTargetProgressive({
  followVisible,
  boundAgentId,
  visibleValues,
  candidates,
  getCachedTimelineIds,
  getCachedTailPage,
  loadPage,
  onTailLoaded,
  onCompleteTimelineIds,
  maxPagesPerCandidate,
  isStale,
}: {
  followVisible: boolean;
  boundAgentId: string;
  visibleValues: string[] | null;
  candidates: readonly string[];
  getCachedTimelineIds?: (id: string) => { ids: string[]; complete: boolean } | undefined;
  getCachedTailPage?: (id: string) => SessionTimelinePage | undefined;
  loadPage: (id: string, cursor?: SessionTimelineCursor) => Promise<SessionTimelinePage>;
  onTailLoaded?: (id: string, page: SessionTimelinePage) => void;
  onCompleteTimelineIds?: (id: string, ids: string[]) => void;
  maxPagesPerCandidate?: number;
  isStale?: () => boolean;
}): Promise<ProgressiveSessionTargetResult> {
  if (!followVisible) {
    return { targetId: boundAgentId || null, confirmed: true, incompleteIds: [], failedIds: [] };
  }
  if (visibleValues === null || visibleValues.length === 0) {
    return { targetId: null, confirmed: true, incompleteIds: [], failedIds: [] };
  }

  const started = performance.now();
  const ordered = [...new Set([boundAgentId, ...candidates].filter(Boolean))];
  if (ordered.length === 0) {
    return { targetId: null, confirmed: true, incompleteIds: [], failedIds: [] };
  }

  const matcher = compileVisibleMatcher(visibleValues);
  const scoreIds = (ids: readonly string[]): number => {
    let score = 0;
    for (const id of ids) {
      if (matcher(id)) score += 1;
    }
    return score;
  };

  interface CandidateState {
    id: string;
    index: number;
    pages: string[][];
    score: number;
    complete: boolean;
    failed: boolean;
    truncated: boolean;
    fromCompleteCache: boolean;
    usedCachedTail: boolean;
    pagesLoaded: number;
    cursor?: SessionTimelineCursor;
  }

  const states: CandidateState[] = ordered.map((id, index) => {
    const cached = getCachedTimelineIds?.(id);
    if (cached && cached.complete) {
      return {
        id,
        index,
        pages: [cached.ids],
        score: scoreIds(cached.ids),
        complete: true,
        failed: false,
        truncated: false,
        fromCompleteCache: true,
        usedCachedTail: false,
        pagesLoaded: 0,
        cursor: undefined,
      };
    }
    return {
      id,
      index,
      pages: [],
      score: 0,
      complete: false,
      failed: false,
      truncated: false,
      fromCompleteCache: false,
      usedCachedTail: false,
      pagesLoaded: 0,
      cursor: undefined,
    };
  });

  const flattenChronological = (pages: readonly string[][]): string[] => {
    const combined: string[] = [];
    for (let i = pages.length - 1; i >= 0; i--) {
      combined.push(...pages[i]);
    }
    return combined;
  };

  const incompleteIds = (): string[] =>
    states.filter((s) => !s.complete).map((s) => s.id);

  const failedIds = (): string[] =>
    states.filter((s) => s.failed).map((s) => s.id);

  // A candidate w with positive score is provably identical to the full-history
  // winner iff every OTHER competitor j != w is strictly complete (never failed or
  // truncated — unread history has no upper bound) and cannot tie-beat or outscore
  // w's current score (lower index wins exact ties).
  const evaluateProof = (): ProgressiveSessionTargetResult | null => {
    for (let w = 0; w < states.length; w++) {
      const winner = states[w];
      if (winner.score <= 0) continue;
      let proven = true;
      for (let j = 0; j < states.length; j++) {
        if (j === w) continue;
        const other = states[j];
        if (!other.complete) {
          proven = false;
          break;
        }
        const beats = w < j ? winner.score >= other.score : winner.score > other.score;
        if (!beats) {
          proven = false;
          break;
        }
      }
      if (proven) {
        return {
          targetId: winner.id,
          confirmed: true,
          incompleteIds: incompleteIds(),
          failedIds: failedIds(),
        };
      }
    }

    if (states.every((s) => s.complete)) {
      let best: CandidateState | null = null;
      for (const s of states) {
        if (s.score > 0 && (!best || s.score > best.score)) {
          best = s;
        }
      }
      return {
        targetId: best ? best.id : null,
        confirmed: true,
        incompleteIds: [],
        failedIds: [],
      };
    }

    return null;
  };

  // Early-exit guard when failure or truncation makes proving ANY winner in this pass
  // mathematically impossible, avoiding wasted RPCs on remaining pages.
  const canStillProveAnyWinner = (): boolean => {
    const blocked = states.filter((s) => !s.complete && (s.failed || s.truncated));
    if (blocked.length === 0) return true;
    if (blocked.length >= 2) return false;
    const onlyBlocked = blocked[0];
    if (onlyBlocked.score <= 0) return false;
    for (let j = 0; j < states.length; j++) {
      if (j === onlyBlocked.index) continue;
      const other = states[j];
      const beats =
        onlyBlocked.index < j
          ? onlyBlocked.score >= other.score
          : onlyBlocked.score > other.score;
      if (!beats) return false;
    }
    return true;
  };

  let rpcPagesLoaded = 0;
  const finish = (result: ProgressiveSessionTargetResult): ProgressiveSessionTargetResult => {
    recordClientPerf({
      op: "sessionFollow.resolve",
      duration_ms: performance.now() - started,
      ok: result.confirmed,
      candidate_count: ordered.length,
      page_count: rpcPagesLoaded,
    });
    return result;
  };

  const abortedResult = (): ProgressiveSessionTargetResult => ({
    targetId: null,
    confirmed: false,
    incompleteIds: incompleteIds(),
    failedIds: failedIds(),
  });

  if (isStale?.()) {
    return finish(abortedResult());
  }

  const cachedProof = evaluateProof();
  if (cachedProof) {
    return finish(cachedProof);
  }

  // Check cached tail snapshots speculatively first (0 RPCs if sufficient).
  const uncachedStates = states.filter((s) => !s.fromCompleteCache);
  if (getCachedTailPage && uncachedStates.length > 0) {
    let anyCachedTail = false;
    for (const s of uncachedStates) {
      const tail = getCachedTailPage(s.id);
      if (!tail) continue;
      anyCachedTail = true;
      s.pages = [tail.ids];
      s.score = scoreIds(tail.ids);
      s.complete = tail.complete;
      s.cursor = tail.complete ? undefined : tail.startCursor;
      s.usedCachedTail = true;
      s.pagesLoaded = 1;
      if (!s.complete && !s.cursor) {
        s.failed = true;
      }
    }
    if (anyCachedTail) {
      const cachedTailProof = evaluateProof();
      if (cachedTailProof) {
        return finish(cachedTailProof);
      }
    }
  }

  if (isStale?.()) {
    return finish(abortedResult());
  }

  // Fetch fresh tail pages for all candidates not backed by complete full-history cache.
  if (uncachedStates.length > 0) {
    await Promise.all(
      uncachedStates.map(async (s) => {
        if (isStale?.()) return;
        s.usedCachedTail = false;
        s.failed = false;
        s.truncated = false;
        try {
          rpcPagesLoaded += 1;
          const page = await loadPage(s.id, undefined);
          if (isStale?.()) return;
          s.pages = [page.ids];
          s.score = scoreIds(page.ids);
          s.pagesLoaded = 1;
          s.complete = page.complete;
          s.cursor = page.complete ? undefined : page.startCursor;
          onTailLoaded?.(s.id, page);
          if (s.complete) {
            onCompleteTimelineIds?.(s.id, page.ids);
          } else if (!s.cursor) {
            s.failed = true;
          }
        } catch {
          if (isStale?.()) return;
          s.pages = [];
          s.score = 0;
          s.pagesLoaded = 0;
          s.complete = false;
          s.cursor = undefined;
          s.failed = true;
        }
      }),
    );

    if (isStale?.()) {
      return finish(abortedResult());
    }

    const tailProof = evaluateProof();
    if (tailProof) {
      return finish(tailProof);
    }
  }

  // Incremental expansion: prioritize paging incomplete non-leaders first so
  // small/medium competitors finish cleanly and can prove a large leader
  // without scanning older pages of the leader unless strictly necessary.
  while (true) {
    if (isStale?.()) {
      return finish(abortedResult());
    }

    if (typeof maxPagesPerCandidate === "number" && maxPagesPerCandidate > 0) {
      for (const s of states) {
        if (!s.complete && !s.failed && !s.truncated && s.pagesLoaded >= maxPagesPerCandidate) {
          s.truncated = true;
        }
      }
    }

    const stepProof = evaluateProof();
    if (stepProof) {
      return finish(stepProof);
    }

    if (!canStillProveAnyWinner()) {
      break;
    }

    const expandable = states.filter(
      (s) => !s.complete && !s.failed && !s.truncated && Boolean(s.cursor),
    );
    if (expandable.length === 0) {
      break;
    }

    let leader: CandidateState | null = null;
    for (const s of states) {
      if (s.score > 0 && (!leader || s.score > leader.score)) {
        leader = s;
      }
    }
    const nonLeaders = leader ? expandable.filter((s) => s !== leader) : expandable;
    const batch = nonLeaders.length > 0 ? nonLeaders : expandable;

    await Promise.all(
      batch.map(async (s) => {
        if (isStale?.()) return;
        try {
          rpcPagesLoaded += 1;
          const page = await loadPage(s.id, s.cursor);
          if (isStale?.()) return;
          s.pages.push(page.ids);
          s.score += scoreIds(page.ids);
          s.pagesLoaded += 1;
          s.complete = page.complete;
          s.cursor = page.complete ? undefined : page.startCursor;
          if (s.complete) {
            onCompleteTimelineIds?.(s.id, flattenChronological(s.pages));
          } else if (!s.cursor) {
            s.failed = true;
          }
        } catch {
          if (!isStale?.()) s.failed = true;
        }
      }),
    );

    if (isStale?.()) {
      return finish(abortedResult());
    }

    const afterProof = evaluateProof();
    if (afterProof) {
      return finish(afterProof);
    }
  }

  return finish(abortedResult());
}

export async function resolveSessionTarget({
  followVisible, boundAgentId, visibleValues, candidates, timelineIds,
}: {
  followVisible: boolean;
  boundAgentId: string;
  visibleValues: string[] | null;
  candidates: readonly string[];
  timelineIds: (id: string) => Promise<string[]>;
}): Promise<string | null> {
  if (!followVisible) return boundAgentId || null;
  if (visibleValues === null) return null;
  if (visibleValues.length === 0) return null;
  const matcher = compileVisibleMatcher(visibleValues);
  let best = { id: "", score: 0 };
  for (const id of new Set([boundAgentId, ...candidates].filter(Boolean))) {
    const ids = await timelineIds(id).catch(() => []);
    const score = ids.filter((identity) => matcher(identity)).length;
    if (score > best.score) best = { id, score };
  }
  return best.id || null;
}

export function hasDomDocument(doc: any = (globalThis as any).document): boolean {
  return typeof doc?.querySelectorAll === "function";
}

export type BoundSession = { agentId: string; scopeKey: string; items: number; adapter: string };

function adapterRank(scopeKey: string): number {
  if (scopeKey.startsWith("omp:") || scopeKey.startsWith("hermes:")) return 0;
  if (scopeKey.startsWith("pi:")) return 2;
  return 1;
}

export function boundRootSessions(
  scopes: readonly { scope_key: string; parent_scope?: string | null; agent_id?: string; items?: number }[],
  workspaceAgentIds?: readonly string[],
): BoundSession[] {
  const best = new Map<string, BoundSession>();
  for (const scope of scopes) {
    if (scope.parent_scope || typeof scope.agent_id !== "string" || scope.agent_id.length === 0) continue;
    if (workspaceAgentIds !== undefined && !workspaceAgentIds.includes(scope.agent_id)) continue;
    const candidate: BoundSession = {
      agentId: scope.agent_id,
      scopeKey: scope.scope_key,
      items: scope.items ?? 0,
      adapter: scope.scope_key.split(":")[0] ?? "",
    };
    const existing = best.get(candidate.agentId);
    if (!existing) {
      best.set(candidate.agentId, candidate);
      continue;
    }
    const rankDelta = adapterRank(candidate.scopeKey) - adapterRank(existing.scopeKey);
    if (rankDelta < 0 || (rankDelta === 0 && (candidate.items > existing.items ||
      (candidate.items === existing.items && candidate.scopeKey < existing.scopeKey)))) {
      best.set(candidate.agentId, candidate);
    }
  }
  const result = [...best.values()];
  if (workspaceAgentIds !== undefined) {
    result.sort((a, b) => workspaceAgentIds.indexOf(a.agentId) - workspaceAgentIds.indexOf(b.agentId));
  } else {
    result.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0));
  }
  return result;
}

export function resolveWorkspaceSessionState({ pinnedAgentId, trackedAgentId, hasTrackerSignal, trackerSupported, hasDocument, demandedAgentIds, boundSessions, workspaceAgentIds, followVisible = true }: {
  pinnedAgentId: string | null;
  trackedAgentId: string | null;
  hasTrackerSignal: boolean;
  trackerSupported: boolean;
  hasDocument: boolean;
  demandedAgentIds: readonly string[];
  boundSessions: readonly BoundSession[];
  workspaceAgentIds?: readonly string[];
  followVisible?: boolean;
}): { mode: "pinned" | "follow" | "single-auto" | "chooser"; effectiveAgentId: string | null; unavailablePin: boolean } {
  if (pinnedAgentId) {
    if (workspaceAgentIds !== undefined && !workspaceAgentIds.includes(pinnedAgentId) &&
      !boundSessions.some((session) => session.agentId === pinnedAgentId)) {
      return { mode: "chooser", effectiveAgentId: null, unavailablePin: true };
    }
    return { mode: "pinned", effectiveAgentId: pinnedAgentId, unavailablePin: false };
  }
  if (!followVisible) {
    if (boundSessions.length === 1 && (workspaceAgentIds !== undefined || !trackerSupported)) {
      return { mode: "single-auto", effectiveAgentId: boundSessions[0].agentId, unavailablePin: false };
    }
    return { mode: "chooser", effectiveAgentId: null, unavailablePin: false };
  }
  if (hasDocument) {
    return { mode: "follow", effectiveAgentId: trackedAgentId, unavailablePin: false };
  }
  if (hasTrackerSignal) {
    if (trackedAgentId !== null) return { mode: "follow", effectiveAgentId: trackedAgentId, unavailablePin: false };
    return { mode: "chooser", effectiveAgentId: null, unavailablePin: false };
  }
  if (demandedAgentIds.length === 1) return { mode: "follow", effectiveAgentId: demandedAgentIds[0], unavailablePin: false };
  if (!trackerSupported && boundSessions.length === 1) return { mode: "single-auto", effectiveAgentId: boundSessions[0].agentId, unavailablePin: false };
  if (boundSessions.length === 1 && workspaceAgentIds !== undefined) return { mode: "single-auto", effectiveAgentId: boundSessions[0].agentId, unavailablePin: false };
  return { mode: "chooser", effectiveAgentId: null, unavailablePin: false };
}

export function shortAgentLabel(title: string | undefined | null, agentId: string): string {
  return title ?? agentId.slice(0, 8);
}

/**
 * Workspace dropdown header text. `single-auto` with followVisible=false is
 * an explicit pinned-by-default session — never "Follow visible session".
 */
export function workspaceHeaderText({
  pinnedAgentId,
  pinnedTitle,
  mode,
  hasDocument,
  effectiveAgentId,
  effectiveTitle,
}: {
  pinnedAgentId: string | null;
  pinnedTitle?: string | null;
  mode: "pinned" | "follow" | "single-auto" | "chooser";
  hasDocument: boolean;
  effectiveAgentId: string | null;
  effectiveTitle?: string | null;
}): string {
  if (pinnedAgentId) {
    return `Pinned · ${shortAgentLabel(pinnedTitle, pinnedAgentId)} ▾`;
  }
  if (mode === "chooser") {
    return "Choose a session ▾";
  }
  if (mode === "single-auto" && effectiveAgentId) {
    return `Session · ${shortAgentLabel(effectiveTitle, effectiveAgentId)} ▾`;
  }
  if (!hasDocument && effectiveAgentId) {
    return `${mode === "single-auto" ? "Session" : "Following"} · ${shortAgentLabel(effectiveTitle, effectiveAgentId)} ▾`;
  }
  return "Follow visible session ▾";
}

export type WorkspaceTrackInput = {
  rawFocusedId: string | null;
  rawHasSignal: boolean;
  membership: "accept" | "reject" | "unknown";
  candidateAgentIds?: readonly string[];
  panelWorkspaceId?: string;
  /** workspaceLookup.data; undefined while the lookup is still loading. */
  lookupWorkspaceId?: string | null;
  lookupLoaded: boolean;
  /** Stale selections from the previous workspace must never carry over. */
  workspaceChanged: boolean;
  lastValid: string | null;
  tracked: string | null;
};

export type WorkspaceTrackOutput = {
  lastValid: string | null;
  tracked: string | null;
};

/**
 * Pure tracking decision behind the workspace focus effect: accept/reject/
 * unknown membership, a null focus signal, and workspace switches (which
 * reset both the last-valid ref and the tracked session).
 */
export function nextWorkspaceTrackedAgent(input: WorkspaceTrackInput): WorkspaceTrackOutput {
  const { rawFocusedId, rawHasSignal, membership, candidateAgentIds, panelWorkspaceId, lookupWorkspaceId, lookupLoaded, workspaceChanged } = input;
  if (workspaceChanged) {
    return { lastValid: null, tracked: null };
  }
  if (rawFocusedId === null) {
    if (rawHasSignal) {
      return { lastValid: null, tracked: null };
    }
    return { lastValid: input.lastValid, tracked: input.tracked };
  }
  if (membership === "accept") {
    return { lastValid: rawFocusedId, tracked: rawFocusedId };
  }
  if (membership === "reject") {
    return { lastValid: input.lastValid, tracked: input.lastValid };
  }
  if (!lookupLoaded) {
    return { lastValid: input.lastValid, tracked: input.lastValid };
  }
  const resolved = acceptWorkspaceAgentId({
    agentId: rawFocusedId,
    workspaceCandidateIds: candidateAgentIds,
    agentWorkspaceId: lookupWorkspaceId,
    panelWorkspaceId,
  });
  if (resolved === "accept") {
    return { lastValid: rawFocusedId, tracked: rawFocusedId };
  }
  return { lastValid: input.lastValid, tracked: input.lastValid };
}

export function acceptWorkspaceAgentId({ agentId, workspaceCandidateIds, agentWorkspaceId, panelWorkspaceId }: {
  agentId: string | null;
  workspaceCandidateIds?: readonly string[];
  agentWorkspaceId?: string | null;
  panelWorkspaceId?: string;
}): "accept" | "reject" | "unknown" {
  if (!agentId) return "reject";
  if (panelWorkspaceId && agentWorkspaceId) return agentWorkspaceId === panelWorkspaceId ? "accept" : "reject";
  if (workspaceCandidateIds !== undefined) return workspaceCandidateIds.includes(agentId) ? "accept" : "reject";
  if (!panelWorkspaceId) return "accept";
  return "unknown";
}

export function selectMainOrFallbackAgent({ tab, followVisible, resolvedTarget }: {
  tab: SessionTab | null;
  followVisible: boolean;
  resolvedTarget: string | null;
}): { agentId: string | null; inView: boolean } {
  const agentId = tab?.kind === "agent" && followVisible ? tab.agentId : resolvedTarget;
  return { agentId, inView: !!agentId };
}

export interface FollowUiSelection {
  agentId: string | null;
  inView: boolean;
  followResolved: boolean;
  followUncertain: boolean;
  retryable: boolean;
}

export function reconcileFollowSelection({
  tab,
  followVisible,
  followResult,
  boundAgentId,
}: {
  tab: SessionTab | null;
  followVisible: boolean;
  followResult: ProgressiveSessionTargetResult | null;
  boundAgentId: string;
}): FollowUiSelection {
  if (!followVisible) {
    const agentId = boundAgentId || null;
    return {
      agentId,
      inView: !!agentId,
      followResolved: true,
      followUncertain: false,
      retryable: false,
    };
  }
  if (tab?.kind === "agent") {
    return {
      agentId: tab.agentId,
      inView: true,
      followResolved: true,
      followUncertain: false,
      retryable: false,
    };
  }
  if (followResult && !followResult.confirmed) {
    return {
      agentId: null,
      inView: false,
      followResolved: true,
      followUncertain: true,
      retryable: true,
    };
  }
  const selection = selectMainOrFallbackAgent({
    tab,
    followVisible,
    resolvedTarget: followResult ? followResult.targetId : null,
  });
  return {
    agentId: selection.agentId,
    inView: selection.inView,
    followResolved: true,
    followUncertain: false,
    retryable: false,
  };
}

export interface FollowObservation {
  tab: SessionTab | null;
  visibleValues: readonly string[] | null;
}

export interface ConfirmedFollowContext {
  agentId: string | null;
  inView: boolean;
  tab: SessionTab | null;
  snapshotKey: string;
}

export interface FollowCoordinatorUiState {
  agentId: string | null;
  inView: boolean;
  followResolved: boolean;
  followUncertain: boolean;
  followSwitching: boolean;
  actionBlocked: boolean;
  retryable: boolean;
  failedIds: string[];
}

export type FollowAttemptStart =
  | { kind: "dedup"; state: FollowCoordinatorUiState }
  | {
      kind: "run";
      generation: number;
      snapshotKey: string;
      enteredSwitching: boolean;
      state: FollowCoordinatorUiState;
    };

export type FollowCommitOutcome =
  | {
      committed: true;
      state: FollowCoordinatorUiState;
    }
  | {
      committed: false;
      staleReason: "superseded" | "snapshot_changed";
      needsFollowUp: boolean;
      enteredSwitching: boolean;
      state: FollowCoordinatorUiState;
    };

export function followTabKey(tab: SessionTab | null): string {
  return tab?.kind === "agent" ? `agent:${tab.agentId}` : "chat";
}

export function visibleValuesKey(values: readonly string[] | null): string {
  if (values === null) return "null";
  if (values.length === 0) return "empty";
  return JSON.stringify(values);
}

export function followSnapshotKey(observation: FollowObservation): string {
  return `${followTabKey(observation.tab)}\n${visibleValuesKey(observation.visibleValues)}`;
}

/**
 * Determine whether a live focus/DOM observation belongs to the already
 * confirmed session without relying on raw DOM string reuse across chats
 * (shared element chrome `id`s must never mask an A -> B session switch).
 */
export function isSameConfirmedFollowSession({
  confirmed,
  observation,
  getKnownAgentTimelineIds,
}: {
  confirmed: ConfirmedFollowContext | null;
  observation: FollowObservation;
  getKnownAgentTimelineIds?: (agentId: string) => readonly string[] | undefined;
}): boolean {
  if (!confirmed) return false;
  if (followSnapshotKey(observation) === confirmed.snapshotKey) {
    return true;
  }
  if (!confirmed.inView || !confirmed.agentId) {
    return (
      !confirmed.inView &&
      observation.tab?.kind !== "agent" &&
      (!observation.visibleValues || observation.visibleValues.length === 0)
    );
  }
  if (observation.tab?.kind === "agent") {
    return observation.tab.agentId === confirmed.agentId;
  }
  if (!observation.visibleValues || observation.visibleValues.length === 0) {
    return false;
  }
  const knownIds = getKnownAgentTimelineIds?.(confirmed.agentId);
  if (!knownIds || knownIds.length === 0) {
    return false;
  }
  const matcher = compileVisibleMatcher(observation.visibleValues);
  return knownIds.some((id) => matcher(id));
}

function initialCoordinatorState(
  initialPending: boolean,
  boundAgentId: string,
): FollowCoordinatorUiState {
  if (initialPending) {
    return {
      agentId: null,
      inView: false,
      followResolved: false,
      followUncertain: false,
      followSwitching: false,
      actionBlocked: true,
      retryable: false,
      failedIds: [],
    };
  }
  return {
    agentId: boundAgentId || null,
    inView: Boolean(boundAgentId),
    followResolved: true,
    followUncertain: false,
    followSwitching: false,
    actionBlocked: false,
    retryable: false,
    failedIds: [],
  };
}

/**
 * Coordinates async follow resolution with monotonic generation tokens,
 * immediate switch-time action blocking, same-session flicker avoidance,
 * and pre-commit live snapshot re-verification.
 */
export class FollowSelectionCoordinator {
  private generation = 0;
  private confirmed: ConfirmedFollowContext | null = null;
  private inFlight: { generation: number; snapshotKey: string } | null = null;
  private state: FollowCoordinatorUiState;

  constructor(initialPending: boolean, boundAgentId = "") {
    this.state = initialCoordinatorState(initialPending, boundAgentId);
  }

  reset(initialPending: boolean, boundAgentId = ""): FollowCoordinatorUiState {
    this.generation += 1;
    this.confirmed = null;
    this.inFlight = null;
    this.state = initialCoordinatorState(initialPending, boundAgentId);
    return this.state;
  }

  getState(): FollowCoordinatorUiState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  getConfirmed(): ConfirmedFollowContext | null {
    return this.confirmed;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * Supersede any in-flight scan (for example during effect cleanup) without
   * clearing the confirmed session state or inducing unnecessary UI flicker.
   */
  invalidateInFlight(): void {
    if (this.inFlight !== null) {
      this.generation += 1;
      this.inFlight = null;
    }
  }

  abortAttempt(generation: number): void {
    if (this.inFlight?.generation === generation) {
      this.inFlight = null;
    }
  }

  observeLiveChange(
    observation: FollowObservation,
    followVisible: boolean,
    getKnownAgentTimelineIds?: (agentId: string) => readonly string[] | undefined,
  ): {
    invalidatedInFlight: boolean;
    enteredSwitching: boolean;
    state: FollowCoordinatorUiState;
  } {
    if (!followVisible) {
      return {
        invalidatedInFlight: false,
        enteredSwitching: false,
        state: this.state,
      };
    }

    const liveKey = followSnapshotKey(observation);
    let invalidatedInFlight = false;
    if (this.inFlight !== null && this.inFlight.snapshotKey !== liveKey) {
      this.generation += 1;
      this.inFlight = null;
      invalidatedInFlight = true;
    }

    const sameConfirmed = isSameConfirmedFollowSession({
      confirmed: this.confirmed,
      observation,
      getKnownAgentTimelineIds,
    });
    let enteredSwitching = false;
    if (!sameConfirmed && this.confirmed?.inView && !this.state.followSwitching) {
      this.state = {
        ...this.state,
        agentId: null,
        followSwitching: true,
        actionBlocked: true,
      };
      enteredSwitching = true;
    }

    return {
      invalidatedInFlight,
      enteredSwitching,
      state: this.state,
    };
  }

  beginAttempt(
    observation: FollowObservation,
    followVisible: boolean,
    getKnownAgentTimelineIds?: (agentId: string) => readonly string[] | undefined,
  ): FollowAttemptStart {
    const snapshotKey = followSnapshotKey(observation);
    if (this.inFlight !== null && this.inFlight.snapshotKey === snapshotKey) {
      return {
        kind: "dedup",
        state: this.state,
      };
    }

    const liveCheck = this.observeLiveChange(
      observation,
      followVisible,
      getKnownAgentTimelineIds,
    );
    this.generation += 1;
    const generation = this.generation;
    this.inFlight = { generation, snapshotKey };

    return {
      kind: "run",
      generation,
      snapshotKey,
      enteredSwitching: liveCheck.enteredSwitching,
      state: this.state,
    };
  }

  commitAttempt({
    generation,
    startObservation,
    startSnapshotKey,
    liveObservation,
    followVisible,
    followResult,
    boundAgentId,
    getKnownAgentTimelineIds,
  }: {
    generation: number;
    startObservation: FollowObservation;
    startSnapshotKey: string;
    liveObservation: FollowObservation;
    followVisible: boolean;
    followResult: ProgressiveSessionTargetResult | null;
    boundAgentId: string;
    getKnownAgentTimelineIds?: (agentId: string) => readonly string[] | undefined;
  }): FollowCommitOutcome {
    if (this.inFlight?.generation === generation) {
      this.inFlight = null;
    }

    if (generation !== this.generation) {
      return {
        committed: false,
        staleReason: "superseded",
        needsFollowUp: false,
        enteredSwitching: false,
        state: this.state,
      };
    }

    if (followVisible && followSnapshotKey(liveObservation) !== startSnapshotKey) {
      const liveCheck = this.observeLiveChange(
        liveObservation,
        followVisible,
        getKnownAgentTimelineIds,
      );
      this.generation += 1;
      return {
        committed: false,
        staleReason: "snapshot_changed",
        needsFollowUp: true,
        enteredSwitching: liveCheck.enteredSwitching,
        state: this.state,
      };
    }

    const nextUi = reconcileFollowSelection({
      tab: startObservation.tab,
      followVisible,
      followResult,
      boundAgentId,
    });
    const actionBlocked = followVisible && (!nextUi.inView || nextUi.followUncertain);
    this.confirmed = nextUi.followUncertain
      ? null
      : {
          agentId: nextUi.agentId,
          inView: nextUi.inView,
          tab: startObservation.tab,
          snapshotKey: startSnapshotKey,
        };
    this.state = {
      agentId: nextUi.agentId,
      inView: nextUi.inView,
      followResolved: nextUi.followResolved,
      followUncertain: nextUi.followUncertain,
      followSwitching: false,
      actionBlocked,
      retryable: nextUi.retryable,
      failedIds: followResult && !followResult.confirmed ? followResult.failedIds : [],
    };
    return {
      committed: true,
      state: this.state,
    };
  }
}
