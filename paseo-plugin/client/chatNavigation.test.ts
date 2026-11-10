import { expect, test } from "bun:test";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import type { Row } from "../shared/sessionNav";
import { historyContainsRow, identityMatches, scrollToMessageInChat, visibleChatValues } from "./chatNavigation";
import { readTimelineHistory } from "./timelineHistory";

class Element {
  children: Element[] = [];
  parent?: Element;
  style: Record<string, string> = {};
  scrolled = false;
  onClick?: () => void;
  onEvent?: (event: { type: string; deltaY?: number }) => void;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  constructor(public attrs: Record<string, string> = {}, public textContent = "") {}
  add(...nodes: Element[]) {
    for (const node of nodes) { node.parent = this; this.children.push(node); }
    return this;
  }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  matches(selector: string): boolean {
    return selector.split(",").some((part) =>
      [...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
        value === undefined ? this.attrs[name] !== undefined : this.attrs[name] === value));
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Element | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  compareDocumentPosition(other: Element) {
    let root: Element = this;
    while (root.parent) root = root.parent;
    const nodes = [root, ...root.querySelectorAll("[data-history-row-id], [data-testid]")];
    return nodes.indexOf(other) > nodes.indexOf(this) ? 4 : 2;
  }
  click() { this.onClick?.(); }
  dispatchEvent(event: { type: string; deltaY?: number }) { this.onEvent?.(event); return true; }
  scrollTo({ top }: { top: number }) { this.scrollTop = top; }
  scrollIntoView() { this.scrolled = true; }
}

test("subagent fallback opens the main agent before waiting for its chat and scrolling the row", async () => {
  const target = row("main-message", "user");
  const node = new Element({ "data-message-id": "main-message" });
  const root = new Element({ "data-testid": "agent-chat-scroll" }).add(node);
  let mounted = false, opened = false, waits = 0;
  const doc = { querySelectorAll: (selector: string) => selector.includes("aria-selected")
    ? [new Element({ "data-testid": mounted ? "workspace-tab-agent_main" : "workspace-tab-provider_subagent_4_main_5_child" })]
    : mounted ? [root] : [] };
  expect(await scrollToMessageInChat(target, [target], {
    document: doc,
    openAgent: { agentId: "main", open: () => { opened = true; expect(node.scrolled).toBe(false); } },
    afterLoad: async () => { expect(opened).toBe(true); waits++; mounted = true; },
  })).toBe(true);
  expect(waits).toBe(1);
  expect(node.scrolled).toBe(true);
});

test("failed or unavailable main navigation reports failure without scrolling the child", async () => {
  const f = fixture();
  let missing = 0;
  const options = { document: f.doc, onNotFound: () => { missing++; } };
  expect(await scrollToMessageInChat(f.rows[0], f.rows, {
    ...options, openAgent: { agentId: "main", open: () => { throw new Error("offline"); } },
  })).toBe(false);
  expect(await scrollToMessageInChat(f.rows[0], f.rows, {
    ...options, openAgent: { agentId: "main", open: () => {} }, timeoutMs: 5,
  })).toBe(false);
  expect(missing).toBe(2);
  expect(f.root.scrolled).toBe(false);
});

test("loads older history over multiple rounds in the chosen chat root", async () => {
  const f = fixture();
  const target = row("old-message", "user");
  let rounds = 0;
  const olderSlot = new Element({ "data-testid": "older-history-slot" });
  f.root.add(olderSlot);
  let notice = false;
  const targetNode = new Element({ "data-message-id": "old-message" });
  expect(await scrollToMessageInChat(target, [target, ...f.rows], {
    document: f.doc,
    afterLoad: async () => {
      rounds++;
      f.root.add(rounds === 3 ? targetNode : new Element({ "data-message-id": `older-${rounds}` }));
    },
    onNotFound: () => { notice = true; },
  })).toBe(true);
  expect(rounds).toBe(3);
  expect(olderSlot.scrolled).toBe(true);
  expect(targetNode.scrolled).toBe(true);
  expect(notice).toBe(false);
});

for (const entries of [[], [{ item: { type: "user_message", messageId: "unrelated", text: "Different prompt" } }]]) {
  test(`complete ${entries.length ? "unrelated" : "empty"} history rejects absent target without scrolling`, async () => {
    const f = fixture();
    let notice = false, waits = 0;
    expect(await scrollToMessageInChat(row("archived", "user"), f.rows, {
      document: f.doc, getHistory: async () => ({ entries, complete: true }),
      afterLoad: async () => { waits++; },
      onNotFound: () => { notice = true; },
    })).toBe(false);
    expect(notice).toBe(true);
    expect(waits).toBe(0);
    expect(f.anchor.scrolled).toBe(false);
    expect(f.root.scrollTop).toBe(0);
  });
}

test("A's actual empty projected timeline rejects its imported OMP outline immediately", async () => {
  const page = {
    agentId: "35a10cb4-b1d9-429e-8cfc-6066416dedf4", direction: "tail", projection: "projected",
    epoch: "594a7c66-e737-412a-95c3-cd9c3114c003", reset: false, staleCursor: false, gap: false,
    window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null,
    hasOlder: false, hasNewer: false, entries: [], error: null,
  };
  const client = new QueryClient();
  const root = new Element({ "data-testid": "agent-chat-scroll" }, "Start chatting with this agent...");
  const doc = new Element().add(root);
  let notices = 0, waits = 0, requests = 0;
  const rows = Array.from({ length: 1011 }, (_, i) => row(`usr_${i}`, "user"));
  try {
    const getHistory = () => client.fetchQuery({ queryKey: ["paseo-agent-timeline-history", page.agentId],
      staleTime: 5000, queryFn: () => readTimelineHistory({ refetch: async (): Promise<any> => {
        requests++;
        return page;
      } }) });
    await getHistory();
    expect(await scrollToMessageInChat(rows[0], rows, {
      document: doc, getHistory, afterLoad: async () => { waits++; },
      onNotFound: () => { notices++; },
    })).toBe(false);
    expect([notices, waits, requests]).toEqual([1, 0, 1]);
    expect(root.scrolled).toBe(false);
  } finally { client.clear(); }
});

test("missing chat root reports failure without waiting on history", async () => {
  let notices = 0, requests = 0;
  expect(await scrollToMessageInChat(row("absent", "user"), [], {
    document: new Element(), getHistory: () => { requests++; return new Promise(() => {}); },
    onNotFound: () => { notices++; },
  })).toBe(false);
  expect([notices, requests]).toEqual([1, 0]);
});

test("an offline-paused history cache is bounded and reports failure", async () => {
  const client = new QueryClient();
  const f = fixture();
  let notices = 0;
  onlineManager.setOnline(false);
  try {
    const getHistory = () => client.fetchQuery({ queryKey: ["offline-history"],
      queryFn: async () => ({ entries: [], complete: true }) });
    const pending = getHistory();
    expect(client.getQueryState(["offline-history"])?.fetchStatus).toBe("paused");
    expect(await scrollToMessageInChat(row("absent", "user"), f.rows, {
      document: f.doc, getHistory: () => pending, historyTimeoutMs: 5,
      onNotFound: () => { notices++; },
    })).toBe(false);
    expect(notices).toBe(1);
    onlineManager.setOnline(true);
    client.clear();
    await pending.catch(() => {});
  } finally {
    onlineManager.setOnline(true);
    client.clear();
  }
});

test("history errors and unexpected DOM errors report failure once", async () => {
  const f = fixture();
  for (const options of [
    { document: f.doc, getHistory: async (): Promise<never> => { throw new Error("offline"); } },
    { document: { querySelectorAll: () => { throw new Error("detached document"); } } },
  ]) {
    let notices = 0;
    expect(await scrollToMessageInChat(row("absent", "user"), f.rows, {
      ...options, onNotFound: () => { notices++; },
    })).toBe(false);
    expect(notices).toBe(1);
  }
});

test("overall timeout covers a stalled load callback", async () => {
  const f = fixture();
  let notices = 0;
  expect(await scrollToMessageInChat(row("absent", "user"), f.rows, {
    document: f.doc, timeoutMs: 5, afterLoad: () => new Promise(() => {}),
    onNotFound: () => { notices++; },
  })).toBe(false);
  expect(notices).toBe(1);
});

test("a superseded history request cannot overwrite a later successful navigation", async () => {
  const f = fixture();
  let notices = 0;
  const pending = scrollToMessageInChat(row("absent", "user"), f.rows, {
    document: f.doc, getHistory: () => new Promise(() => {}), historyTimeoutMs: 5,
    onNotFound: () => { notices++; },
  });
  expect(await scrollToMessageInChat(f.previous, f.rows, { document: f.doc })).toBe(true);
  expect(await pending).toBe(false);
  expect(notices).toBe(0);
});

test("OMP message text and tool call identity/input/original output match native timeline rows", () => {
  const history = { complete: true, entries: [
    { item: { type: "user_message", messageId: "native-user", text: "Original user\n prompt here" } },
    { item: { type: "assistant_message", messageId: "native-assistant", text: "Assistant response here" } },
    { item: { type: "tool_call", callId: "native-call", detail: {
      type: "read", filePath: "/work/file.txt", content: "Full original output of read",
    } } },
    { item: { type: "tool_call", callId: "bash-native", args: { command: "echo one\necho two" } } },
  ] };
  expect(historyContainsRow(history, { ...row("usr_0", "user"), summary_line: "Original user prompt here" })).toBe(true);
  expect(historyContainsRow(history, { ...row("ast_1", "assistant"), summary_line: "Assistant response here" })).toBe(true);
  expect(historyContainsRow(history, { ...row("item-hash"), tool_call_id: "native-call" })).toBe(true);
  expect(historyContainsRow(history, { ...row("different-call"), tool_input: '{"path":"/work/file.txt"}' })).toBe(true);
  expect(historyContainsRow(history, { ...row("bash-cli"), tool_input: JSON.stringify({ command: "echo one\necho two" }) })).toBe(true);
  expect(historyContainsRow(history, { ...row("hidden-call"), summary_line: "Hidden summary",
    tool_output: "Full original output of read" })).toBe(true);
  expect(historyContainsRow(history, { ...row("missing"), tool_input: '{"path":"/work/missing.txt"}' })).toBe(false);
  expect(historyContainsRow(history, { ...row("usr_0", "user"), summary_line: "Assistant response here" })).toBe(false);
});

test("present target still navigates; incomplete or failed fetch cannot establish absence", async () => {
  const f = fixture();
  for (const getHistory of [
    async () => ({ entries: [{ item: { type: "assistant_message", messageId: "previous" } }], complete: true }),
    async () => ({ entries: [], complete: false }),
    async (): Promise<never> => { throw new Error("timeline offline"); },
  ]) {
    let notice = false;
    expect(await scrollToMessageInChat(f.previous, f.rows, {
      document: f.doc, getHistory, onNotFound: () => { notice = true; },
    })).toBe(true);
    expect(notice).toBe(false);
  }
});

test("complete history bounds stalled DOM paging to a few seconds", async () => {
  const f = fixture();
  let clock = 0, notice = false;
  const target = row("known-but-unmounted", "user");
  expect(await scrollToMessageInChat(target, [target, ...f.rows], {
    document: f.doc, now: () => clock,
    getHistory: async () => ({ entries: [{ item: { type: "user_message", messageId: target.item_id } }], complete: true }),
    afterLoad: async () => { clock += 100; },
    onNotFound: () => { notice = true; },
  })).toBe(false);
  expect(clock).toBe(4000);
  expect(notice).toBe(true);
});

for (const [start, targetIndex, inverted] of [[590, 300, false], [0, 300, false], [300, 500, false],
  [590, 300, true], [300, 500, true]] as const) {
  test(`virtualized window seeks ${start} -> ${targetIndex}, inverted=${inverted}, without paging`, async () => {
    const root = new Element({ "data-testid": "agent-chat-scroll" });
    const doc = new Element().add(root);
    (doc as any).defaultView = { getComputedStyle: () => ({ flexDirection: inverted ? "column-reverse" : "column" }) };
    const rows = Array.from({ length: 601 }, (_, i) => ({ ...row(`C_user_${i}`, "user"), summary_line: `Prompt ${i}` }));
    root.scrollHeight = 60100;
    root.clientHeight = 300;
    const extent = root.scrollHeight - root.clientHeight;
    root.scrollTop = inverted ? start * 100 - extent : start * 100;
    const slot = new Element({ "data-testid": "older-history-slot" });
    let paging = 0, steps = 0, clock = 0;
    slot.scrollIntoView = () => { paging++; };
    const render = () => {
      const logical = inverted ? root.scrollTop + extent : root.scrollTop;
      const first = Math.floor(logical / 100);
      root.children = [];
      root.add(slot);
      for (let i = first; i <= Math.min(600, first + 4); i++) {
        root.add(new Element({ "data-history-row-id": rows[i].item_id!, "data-index": String(i) }));
      }
      // The live head remains mounted regardless of the virtual window.
      root.add(new Element({ "data-message-id": "C_user_600" }));
    };
    render();
    expect(await scrollToMessageInChat(rows[targetIndex], rows, {
      document: doc, now: () => clock,
      getHistory: async () => ({ complete: true,
        entries: rows.map((row) => ({ item: { type: "user_message", messageId: row.item_id } })) }),
      afterLoad: async () => { clock += 100; steps++; render(); },
    })).toBe(true);
    expect(root.querySelector(`[data-history-row-id="C_user_${targetIndex}"]`)?.scrolled).toBe(true);
    expect(paging).toBe(0);
    expect(steps).toBeLessThan(50);
  });
}

test("virtual window text anchors seek when native and outline identities differ", async () => {
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  const doc = new Element().add(root);
  root.scrollHeight = 20000;
  root.clientHeight = 500;
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...row(`outline-${i}`, "user"), summary_line: `unique prompt ${i}` }));
  let clock = 0;
  const render = () => {
    const first = Math.floor(root.scrollTop / 200);
    root.children = [];
    for (let i = first; i <= Math.min(99, first + 5); i++) {
      root.add(new Element({ "data-history-row-id": `native-${i}`, "data-index": String(i) }, rows[i].summary_line));
    }
  };
  render();
  expect(await scrollToMessageInChat(rows[50], rows, {
    document: doc, now: () => clock, afterLoad: async () => { clock += 100; render(); },
  })).toBe(true);
});

test("no history progress waits for the generous timeout, not an idle two-second window", async () => {
  const f = fixture();
  let waits = 0;
  let notice = "";
  expect(await scrollToMessageInChat(row("not-loaded", "user"), f.rows, {
    document: f.doc,
    now: () => waits * 250,
    afterLoad: async () => { waits++; },
    onNotFound: () => { notice = "Not loaded in chat"; },
  })).toBe(false);
  expect(waits).toBe(240);
  expect(notice).toBe("Not loaded in chat");
});

test("scroll fallback handles a reversed scrollable descendant", async () => {
  const f = fixture();
  const scroller: any = new Element();
  scroller.scrollHeight = 1000;
  scroller.clientHeight = 100;
  scroller.scrollTop = -200;
  f.root.add(scroller);
  let clock = 0;
  await scrollToMessageInChat(row("missing", "user"), [], {
    document: f.doc, now: () => clock, afterLoad: async () => { clock += 1000; },
  });
  expect(scroller.scrollTop).toBe(-900);
});

test("pages rearm only after leaving the start and returning with scroll and wheel events", async () => {
  const f = fixture();
  class FakeEvent {
    deltaY?: number;
    constructor(public type: string, init?: { deltaY?: number }) { this.deltaY = init?.deltaY; }
  }
  (f.doc as any).defaultView = { Event: FakeEvent, WheelEvent: FakeEvent };
  f.root.scrollHeight = 4000;
  f.root.clientHeight = 500;
  let ready = false, intent = false, loading = false;
  let requests = 0, clock = 0, settleTicks = 0;
  const spinner = new Element({ "data-testid": "load-older-history-spinner" });
  const slot = new Element({ "data-testid": "older-history-slot" });
  slot.scrollIntoView = () => { f.root.scrollTop = 0; };
  f.root.add(slot);
  const target = row("old-prompt", "user");
  const targetNode = new Element({ "data-message-id": "old-prompt" });
  f.root.onEvent = (event) => {
    if (event.type === "wheel" && (event.deltaY ?? 0) < 0) intent = true;
    if (f.root.scrollTop > 96) ready = true;
    if (!ready || !intent || loading || f.root.scrollTop > 1) return;
    loading = true;
    ready = false;
    intent = false;
    settleTicks = 0;
    requests++;
    slot.add(spinner);
  };
  expect(await scrollToMessageInChat(target, [target, ...f.rows], {
    document: f.doc, now: () => clock,
    afterLoad: async () => {
      clock += 250;
      if (!loading || ++settleTicks < 12) return; // Slow page: the previous idle cutoff was two seconds.
      slot.children = [];
      f.root.add(requests === 4 ? targetNode : new Element({ "data-message-id": `page-${requests}` }));
      loading = false;
      f.root.scrollTop = 500; // Paseo restores the reading anchor after each prepend.
    },
  })).toBe(true);
  expect(requests).toBe(4);
  expect(targetNode.scrolled).toBe(true);
  expect(clock).toBeGreaterThanOrEqual(12000);
});

test("next navigation clears the old failure notice even when the recent target is already loaded", async () => {
  const f = fixture();
  let notice: string | null = null;
  let clock = 0;
  const options = {
    document: f.doc, now: () => clock,
    afterLoad: async () => { clock += 1000; },
    onStart: () => { if (notice === "Not loaded in chat") notice = null; },
    onNotFound: () => { notice = "Not loaded in chat"; },
  };
  await scrollToMessageInChat(row("missing", "user"), f.rows, options);
  expect(notice).toBe("Not loaded in chat");
  expect(await scrollToMessageInChat(f.previous, f.rows, options)).toBe(true);
  expect(notice).toBeNull();
  expect(f.anchor.scrolled).toBe(true);
});

function row(id: string, kind: Row["kind"] = "tool"): Row {
  return { item_id: id, tool_call_id: kind === "tool" ? id : "", kind,
    status: "visible", version: 1, tokens_display: "—" };
}
function fixture(hostId = "agent_tool_first") {
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  const doc = new Element().add(root);
  const previous = row("previous", "assistant");
  const first = row("first"), second = row("second");
  const anchor = new Element({ "data-history-row-id": "previous" });
  const host = new Element({ "data-history-row-id": hostId });
  const group = new Element({ "data-testid": "tool-call-group" }, "Ran 2 commands");
  const toggle = new Element({ role: "button", "aria-expanded": "false" });
  group.add(toggle);
  host.add(group);
  root.add(anchor, host);
  const badges = [new Element({ "data-testid": "tool-call-badge" }, "first command"),
    new Element({ "data-testid": "tool-call-badge" }, "second command")];
  let clicked = 0;
  toggle.onClick = () => { clicked++; toggle.attrs["aria-expanded"] = "true"; };
  const options = { document: doc, afterExpand: async () => { group.add(...badges); } };
  return { root, doc, previous, first, second, anchor, host, group, toggle, badges, options,
    rows: [previous, first, second], clicks: () => clicked };
}

test("expands group located by a member's native agent_tool identity, then scrolls child badge", async () => {
  const f = fixture();
  expect(await scrollToMessageInChat(f.second, f.rows, f.options)).toBe(true);
  expect(f.clicks()).toBe(1);
  expect(f.badges[1].scrolled).toBe(true);
  expect(f.badges[1].style.backgroundColor).toContain("rgba");
  expect(f.group.scrolled).toBe(false);
});

test("group header's first member expands and scrolls to same native block", async () => {
  const f = fixture();
  await scrollToMessageInChat(f.first, f.rows, f.options);
  expect(f.clicks()).toBe(1);
  expect(f.badges[0].scrolled).toBe(true);
});

test("nearest group following preceding message, including snippet anchor and unrelated earlier group", async () => {
  const f = fixture("unrelated-native-host");
  f.previous.summary_line = "preceding assistant message";
  f.anchor.attrs["data-history-row-id"] = "native-assistant-id";
  f.anchor.textContent = "preceding assistant\n message";
  const earlier = new Element({ "data-testid": "tool-call-group" });
  f.root.children.unshift(earlier);
  earlier.parent = f.root;
  await scrollToMessageInChat(f.second, f.rows, f.options);
  expect(f.clicks()).toBe(1);
  expect(f.badges[1].scrolled).toBe(true);
  expect(earlier.scrolled).toBe(false);
});

test("after expansion prefers exact tool identity over ordinal badge fallback", async () => {
  const f = fixture();
  const exact = new Element({ "data-call-id": "second" }).add(f.badges[1]);
  await scrollToMessageInChat(f.second, f.rows, {
    document: f.doc, afterExpand: async () => { f.group.add(exact); },
  });
  expect(f.badges[1].scrolled).toBe(true);
});

test("already expanded group is not toggled closed", async () => {
  const f = fixture();
  f.toggle.attrs["aria-expanded"] = "true";
  f.group.add(...f.badges);
  await scrollToMessageInChat(f.second, f.rows, f.options);
  expect(f.clicks()).toBe(0);
  expect(f.badges[1].scrolled).toBe(true);
});

test("missing tool after expansion highlights group, not an empty identity wrapper", async () => {
  const f = fixture();
  const empty = new Element({ "data-message-id": "agent_tool_second" });
  f.root.add(empty);
  await scrollToMessageInChat(f.second, f.rows, { document: f.doc, afterExpand: async () => {} });
  expect(f.group.scrolled).toBe(true);
  expect(empty.scrolled).toBe(false);
});

test("failed expansion still scrolls and highlights the native group", async () => {
  const f = fixture();
  f.toggle.onClick = () => { throw new Error("detached toggle"); };
  expect(await scrollToMessageInChat(f.second, f.rows, f.options)).toBe(true);
  expect(f.group.scrolled).toBe(true);
});

test("missing document/chat/target is safe, non-tool direct and snippet navigation still work", async () => {
  const f = fixture();
  expect(await scrollToMessageInChat(f.second, [], { document: new Element() })).toBe(false);
  let clock = 0;
  expect(await scrollToMessageInChat(row("missing"), [], {
    document: f.doc, now: () => clock, afterLoad: async () => { clock += 1000; },
  })).toBe(false);
  await scrollToMessageInChat(f.previous, f.rows, f.options);
  expect(f.anchor.scrolled).toBe(true);
  const unmatched = row("different-id", "user");
  unmatched.summary_line = "user prompt";
  f.anchor.textContent = "user prompt";
  expect(await scrollToMessageInChat(unmatched, [], f.options)).toBe(true);
});

test("expands Paseo's folded turn-summary after the user message, then highlights the tool badge", async () => {
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  const doc = new Element().add(root);
  const user = row("u1", "user");
  user.summary_line = "Use tools only for this check";
  const read = row("read-call");
  read.tool_input = JSON.stringify({ path: "README.md" });
  const userNode = new Element({ "data-history-row-id": "native-user" }, "Use tools only for this check please");
  const summary = new Element({ "data-testid": "turn-summary" }, "Ran 2 commands and read 1 file");
  const later = new Element({ "data-testid": "turn-summary" }, "Ran 1 command");
  root.add(userNode, summary, later);
  const badges = [new Element({ "data-testid": "tool-call-badge" }, "Shell pwd"),
    new Element({ "data-testid": "tool-call-badge" }, "Read README.md")];
  let clicks = 0;
  summary.onClick = () => {
    clicks++;
    root.children.splice(2, 0, ...badges);
    for (const badge of badges) badge.parent = root;
  };
  expect(await scrollToMessageInChat(read, [user, row("pwd"), read], { document: doc, afterExpand: async () => {} }))
    .toBe(true);
  expect(clicks).toBe(1);
  expect(badges[1].scrolled).toBe(true);
  expect(summary.scrolled).toBe(false);

  await scrollToMessageInChat(read, [user, row("pwd"), read], { document: doc, afterExpand: async () => {} });
  expect(clicks).toBe(1);
});

test("uses the chat root that contains this session and clicks the turn-summary's inner button", async () => {
  const doc = new Element();
  const other = new Element({ "data-testid": "agent-chat-scroll" }, "");
  other.add(new Element({ "data-history-row-id": "x" }, "unrelated claude prompt"));
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  doc.add(other, root);
  const user = row("u1", "user");
  user.summary_line = "Use tools only for this check";
  const read = row("read-call");
  read.tool_input = JSON.stringify({ path: "README.md" });
  const summary = new Element({ "data-testid": "turn-summary" }, "Ran 1 file");
  const button = new Element({ role: "button" });
  summary.add(button);
  root.add(new Element({ "data-history-row-id": "n" }, "Use tools only for this check"), summary);
  const badge = new Element({ "data-testid": "tool-call-badge" }, "Read README.md");
  summary.onClick = () => { throw new Error("outer div is not pressable"); };
  button.onClick = () => { root.add(badge); };
  expect(await scrollToMessageInChat(read, [user, read], { document: doc, afterExpand: async () => {} })).toBe(true);
  expect(badge.scrolled).toBe(true);
});

test("folded turn ends at the next user message, so a later live badge doesn't count as expanded", async () => {
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  const doc = new Element().add(root);
  const u1 = row("u1", "user"), u2 = row("u2", "user");
  u1.summary_line = "First prompt here";
  u2.summary_line = "Second prompt here";
  const read1 = row("read-1"), read2 = row("read-2");
  for (const r of [read1, read2]) r.tool_input = JSON.stringify({ path: "README.md" });
  const summary = new Element({ "data-testid": "turn-summary" }, "Read 1 file");
  const liveBadge = new Element({ "data-testid": "tool-call-badge" }, "Read README.md");
  root.add(new Element({ "data-history-row-id": "n1" }, "First prompt here"), summary,
    new Element({ "data-history-row-id": "n2" }, "Second prompt here"), liveBadge);
  const folded = new Element({ "data-testid": "tool-call-badge" }, "Read README.md");
  let clicks = 0;
  summary.onClick = () => {
    clicks++;
    root.children.splice(2, 0, folded);
    folded.parent = root;
  };
  await scrollToMessageInChat(read1, [u1, read1, u2, read2], { document: doc, afterExpand: async () => {} });
  expect(clicks).toBe(1);
  expect(folded.scrolled).toBe(true);
  expect(liveBadge.scrolled).toBe(false);
});

test("visible chat with the exact row identity beats a hidden chat with more snippet matches", async () => {
  const doc = new Element();
  const hidden = new Element({ "data-testid": "agent-chat-scroll" });
  hidden.add(new Element({ "data-history-row-id": "h1" }, "shared prompt one"),
    new Element({ "data-history-row-id": "h2" }, "shared prompt two"));
  (hidden as any).getClientRects = () => [];
  const active = new Element({ "data-testid": "agent-chat-scroll" });
  const target = new Element({ "data-history-row-id": "u1" }, "something else");
  active.add(target);
  (active as any).getClientRects = () => [{}];
  doc.add(hidden, active);
  const u1 = row("u1", "user"), a = row("a1", "assistant"), b = row("a2", "assistant");
  a.summary_line = "shared prompt one";
  b.summary_line = "shared prompt two";
  expect(await scrollToMessageInChat(u1, [u1, a, b], { document: doc })).toBe(true);
  expect(target.scrolled).toBe(true);
});

test("a later prompt with the same text doesn't end the folded turn at the current prompt", async () => {
  const root = new Element({ "data-testid": "agent-chat-scroll" });
  const doc = new Element().add(root);
  const u1 = row("u1", "user"), u2 = row("u2", "user");
  u1.summary_line = u2.summary_line = "Repeat the same check";
  const read1 = row("read-1");
  read1.tool_input = JSON.stringify({ path: "README.md" });
  const summary = new Element({ "data-testid": "turn-summary" }, "Read 1 file");
  root.add(new Element({ "data-history-row-id": "n1" }, "Repeat the same check"), summary,
    new Element({ "data-history-row-id": "n2" }, "Repeat the same check"));
  const folded = new Element({ "data-testid": "tool-call-badge" }, "Read README.md");
  let clicks = 0;
  summary.onClick = () => { clicks++; root.children.splice(2, 0, folded); folded.parent = root; };
  await scrollToMessageInChat(read1, [u1, read1, u2], { document: doc, afterExpand: async () => {} });
  expect(clicks).toBe(1);
  expect(folded.scrolled).toBe(true);
});


test("visibleChatValues reports no session when no chat is on screen", () => {
  expect(visibleChatValues(new Element())).toBeNull();
  const doc = new Element().add(new Element({ "data-testid": "agent-chat-scroll" }).add(
    new Element({ "data-message-id": "m1" }), new Element({ "data-call-id": "agent_tool_c1" })));
  const values = visibleChatValues(doc)!;
  expect(values).toEqual(["m1", "agent_tool_c1"]);
  expect(values.some((v) => identityMatches(v, "c1"))).toBe(true);
});

test("child navigation never selects a hidden parent chat or guesses between visible panes", async () => {
  const doc = new Element();
  const hidden = new Element({ "data-testid": "agent-chat-scroll" });
  const target = new Element({ "data-message-id": "child-message" });
  hidden.add(target);
  (hidden as any).getClientRects = () => [];
  doc.add(hidden);
  const r = row("child-message", "user");
  expect(await scrollToMessageInChat(r, [r], { document: doc, visibleOnly: true })).toBe(false);
  expect(target.scrolled).toBe(false);
  const active = new Element({ "data-testid": "agent-chat-scroll" });
  const child = new Element({ "data-message-id": "child-message" });
  active.add(child); doc.add(active);
  expect(await scrollToMessageInChat(r, [r], { document: doc, visibleOnly: true })).toBe(true);
  doc.add(new Element({ "data-testid": "agent-chat-scroll" }));
  child.scrolled = false;
  expect(await scrollToMessageInChat(r, [r], { document: doc, visibleOnly: true })).toBe(false);
  expect(child.scrolled).toBe(false);
});
