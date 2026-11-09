import { expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import { scrollToMessageInChat } from "./chatNavigation";

class Element {
  children: Element[] = [];
  parent?: Element;
  style: Record<string, string> = {};
  scrolled = false;
  onClick?: () => void;
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
  scrollIntoView() { this.scrolled = true; }
}

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
  expect(await scrollToMessageInChat(row("missing"), [], { document: f.doc })).toBe(false);
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
