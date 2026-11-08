import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

type Reply = { id?: number; ok: boolean; error?: string; protocol?: number; patches?: Patch[]; [key: string]: unknown };
type Patch = { call_id: string; sha256: string; text: string };
type RecordItem = { call_id: string; tool_name: string; arguments: Record<string, unknown>; status: string; content: string };
type Candidate = { session: string; token: string; confirmed: boolean; records: RecordItem[] };
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 64;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export default function sessionNavigationExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	let proc: ChildProcessWithoutNullStreams | null = null;
	let ready = false;
	let busy = false;
	let nextId = 1;
	let candidate: Candidate | null = null;
	let cooldownUntil = 0;
	let lastWarning = 0;
	let pending: { child: ChildProcessWithoutNullStreams; id: number; resolve: (r: Reply) => void } | null = null;

	function warn(code: string) {
		if (Date.now() - lastWarning >= 60_000) {
			lastWarning = Date.now();
			console.warn(`session-navigation: ${code}`);
		}
	}
	function invalidate(child: ChildProcessWithoutNullStreams, error: string) {
		if (proc === child) { proc = null; ready = false; candidate = null; cooldownUntil = Date.now() + 2000; }
		if (pending?.child === child) { const request = pending; pending = null; request.resolve({ ok: false, error }); }
		try { child.kill("SIGKILL"); } catch { /* 종료된 프로세스 */ }
		if (error !== "shutdown") warn(error);
	}
	function start(): ChildProcessWithoutNullStreams {
		const installed = path.join(os.homedir(), ".local", "bin", "session-navigation-daemon");
		const command = process.env.SESSION_NAVIGATION_DAEMON || (fs.existsSync(installed) ? installed : "session-navigation-daemon");
		const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
		proc = child;
		const rl = readline.createInterface({ input: child.stdout });
		child.stderr.resume();
		rl.on("line", line => {
			try {
				const message = JSON.parse(line) as Reply;
				if (pending?.child === child && message.id === pending.id) {
					const request = pending; pending = null; request.resolve(message);
				}
			} catch { invalidate(child, "invalid_response"); }
		});
		rl.on("close", () => { if (proc === child) invalidate(child, "stdout_closed"); });
		child.on("error", () => invalidate(child, "spawn_error"));
		child.on("exit", () => { rl.close(); if (proc === child) invalidate(child, "daemon_exit"); });
		child.stdout.on("error", () => invalidate(child, "stdout_error"));
		child.stdin.on("error", () => invalidate(child, "write_failed"));
		return child;
	}
	function exchange(child: ChildProcessWithoutNullStreams, method: string, params: object, timeout: number, signal?: AbortSignal): Promise<Reply> {
		return new Promise(resolve => {
			if (signal?.aborted) { invalidate(child, "cancelled"); resolve({ ok: false, error: "cancelled" }); return; }
			const id = nextId++;
			const timer = setTimeout(() => invalidate(child, "timeout"), timeout);
			const abort = () => invalidate(child, "cancelled");
			signal?.addEventListener("abort", abort, { once: true });
			pending = { child, id, resolve: reply => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(reply); } };
			try {
				child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) invalidate(child, "write_failed"); });
			} catch { invalidate(child, "write_failed"); }
		});
	}
	async function rpc(method: string, params: object, timeout: number, signal?: AbortSignal): Promise<Reply> {
		if (busy) return { ok: false, error: "busy" };
		if (!proc && Date.now() < cooldownUntil) return { ok: false, error: "cooldown" };
		busy = true;
		try {
			const child = proc ?? start();
			if (!ready) {
				const hello = await exchange(child, "ping", {}, 2000, signal);
				if (proc !== child) {
					return { ok: false, error: hello.error ?? "daemon_exit" };
				}
				if (!hello.ok) {
					if (proc === child) invalidate(child, hello.error ?? "ping_failed");
					return { ok: false, error: hello.error ?? "ping_failed" };
				}
				if (hello.protocol !== 3) {
					if (proc === child) invalidate(child, "protocol_mismatch");
					return { ok: false, error: "protocol_mismatch" };
				}
				ready = true;
			}
			return await exchange(child, method, params, timeout, signal);
		} catch { if (proc) invalidate(proc, "rpc_error"); return { ok: false, error: "rpc_error" }; }
		finally { busy = false; }
	}
	function sessionId(ctx: ExtensionContext): string | null {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes(":") ? id : null;
		} catch { return null; }
	}
	function collect(messages: any[]): { records: RecordItem[]; positions: Map<string, number> } | null {
		const calls = new Map<string, any>();
		const duplicates = new Set<string>();
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== "toolCall" || typeof block.id !== "string" || !block.id) continue;
				if (calls.has(block.id)) duplicates.add(block.id); else calls.set(block.id, { block, index });
			}
		}
		const resultCounts = new Map<string, number>();
		for (const message of messages) if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
			resultCounts.set(message.toolCallId, (resultCounts.get(message.toolCallId) ?? 0) + 1);
		}
	const records: RecordItem[] = []; const positions = new Map<string, number>(); let bytes = 0;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]; const id = message?.toolCallId; const found = calls.get(id); const call = found?.block;
		if (message?.role !== "toolResult" || typeof id !== "string" || duplicates.has(id) || resultCounts.get(id) !== 1 ||
			!call || found.index >= i || (call.name !== "read" && call.name !== "bash") || (message.toolName !== "read" && message.toolName !== "bash") ||
			call.name !== message.toolName || message.isError !== false ||
			!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) ||
			!Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== "text" ||
			typeof message.content[0].text !== "string") continue;
		let args: Record<string, unknown>;
		if (call.name === "read") {
			// Real shape: {i, path} (+ query params for internal URIs). Identity = path only.
			if (typeof call.arguments.path !== "string" || !call.arguments.path.trim()) continue;
			args = { path: call.arguments.path };
		} else {
			if (typeof call.arguments.command !== "string" || !call.arguments.command.trim()) continue;
			args = { command: call.arguments.command };
			if (typeof call.arguments.cwd === "string" && call.arguments.cwd.trim()) args.cwd = call.arguments.cwd;
		}
		const content = message.content[0].text;
		bytes += Buffer.byteLength(content, "utf8");
		if (bytes > MAX_BYTES || records.length >= MAX_RECORDS) return null;
		records.push({ call_id: id, tool_name: call.name, arguments: args, status: "ok", content });
		positions.set(id, i);
	}
		return { records, positions };
	}
	pi.on("context", async (event: { messages: any[] }, ctx: ExtensionContext) => {
		candidate = null;
		const session = sessionId(ctx); const collected = collect(event.messages);
		if (!session || !collected) return;
		const next: Candidate = { session, token: randomUUID(), confirmed: false, records: collected.records };
		candidate = next;
		const response = await rpc("prepare", { session_id: session, snapshot_id: next.token, records: collected.records }, 2000);
		// Structural daemon death (spawn/exit/protocol) means persistence is
		// unverifiable: D9 treats it like a DB failure, never a silent
		// pass-through. Transient timeout/cancel/busy/cooldown keep the
		// fail-open retry contract (invalidate + next context re-prepares).
		// Note: transport death also clears `candidate` via invalidate(), so the
		// DB-failure check must not require candidate === next.
		const transportDead = ["spawn_error", "daemon_exit", "stdout_closed", "stdout_error", "write_failed", "protocol_mismatch", "invalid_response", "rpc_error"];
		const dbFailure = !response.ok && (response.error === "db_error" || response.error === "db_full" || (typeof response.error === "string" && transportDead.includes(response.error)));
		if (dbFailure) {
			// D9: persistence failure is never silent. Headless aborts; interactive asks.
			candidate = null;
			const mode = (ctx as { mode?: string }).mode;
			if (mode !== "tui") {
				try { ctx.abort?.(); } catch { /* ignore */ }
				throw new Error(`session-navigation: ${response.error} (aborted)`);
			}
			try {
				const choices = Array.isArray(response.choices) ? response.choices as string[] : ["abort_request", "send_original"];
				const choice = await ctx.ui.select("Database error", choices.map((c) => ({ label: c })));
				if (choice === "abort_request" || !choice) {
					try { ctx.abort?.(); } catch { /* ignore */ }
					throw new Error("session-navigation: db_error (aborted by user choice)");
				}
				ctx.ui.notify?.("session-navigation: proceeding with originals (explicit choice)", "warning");
			} catch (err) {
				if (err instanceof Error && err.message.includes("session-navigation: db_error")) throw err;
				try { ctx.abort?.(); } catch { /* ignore */ }
				throw new Error("session-navigation: db_error (aborted)");
			}
			return;
		}
		if (candidate !== next || !response.ok || !Array.isArray(response.patches)) { if (candidate === next) candidate = null; return; }
		let messages: any[] | null = null;
		for (const patch of response.patches) {
			if (!patch || typeof patch.call_id !== "string" || typeof patch.sha256 !== "string" || typeof patch.text !== "string") continue;
			const index = collected.positions.get(patch.call_id); if (index === undefined) continue;
			const original = event.messages[index]; const block = original?.content?.[0];
			if (original?.toolCallId !== patch.call_id || original.isError !== false || original.content.length !== 1 || block?.type !== "text" || typeof block.text !== "string" || hash(block.text) !== patch.sha256) continue;
			messages ??= event.messages.slice();
			messages[index] = { ...original, content: [{ ...block, text: patch.text }] };
		}
		if (messages) return { messages };
	});
	pi.on("assistant_message", async (event: { message: { role?: string; stopReason?: string } }, ctx: ExtensionContext) => {
		if (event.message?.role !== "assistant") return;
		if (candidate && candidate.session === sessionId(ctx) && (event.message.stopReason === "stop" || event.message.stopReason === "toolUse")) candidate.confirmed = true;
		else candidate = null;
	});
	pi.on("session_switch", async () => { candidate = null; });
	async function tool(method: string, params: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal) {
		const session = sessionId(ctx);
		if (!session) return { ok: false, error: "invalid_session" };
		if ((method === "compact" || method === "summarize" || method === "manage") && (!candidate?.confirmed || candidate.session !== session)) return { ok: false, error: "unconfirmed_snapshot" };
		return rpc(method, { ...params, session_id: session, snapshot_id: candidate?.token }, method === "summarize" || method === "manage" ? 25_000 : 5000, signal);
	}
	function result(value: Reply) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
	// D5: session-model-only summary. Returns target text or null when no session
	// model is available. Never throws; callers map null to summarizer_unavailable.
	async function summarizeText(ctx: unknown, content: string): Promise<string | null> {
		try {
			if (!ctx || typeof ctx !== "object") return null;
			const c: Record<string, unknown> = ctx as Record<string, unknown>;
			const models: unknown = c["models"];
			const current: unknown = models && typeof models === "object" && "current" in models ? (models as Record<string, unknown>)["current"] : undefined;
			const getter: unknown = c["getModel"] ?? current ?? c["model"];
			const model: unknown = typeof getter === "function" ? (getter as () => unknown).call(ctx) : getter;
			if (!model || typeof model !== "object") return null;
			// D5: session model via modelRegistry.resolver (auth-retry policy).
			const registry: unknown = c["modelRegistry"];
			const resolverFn: unknown = registry && typeof registry === "object" && "resolver" in registry ? (registry as Record<string, unknown>)["resolver"] : undefined;
			if (typeof resolverFn !== "function") return null;
			const sessionId = sessionIdFrom(ctx);
			let apiKey: unknown;
			try {
				apiKey = (resolverFn as (m: unknown, s?: string) => unknown).call(registry, model, sessionId ?? undefined);
			} catch { return null; }
			if (!apiKey) return null;
			// Dynamic import: @oh-my-pi/pi-ai ships with the host, not this extension bundle.
			const mod: unknown = await import("@oh-my-pi/pi-ai");
			const complete: unknown = mod && typeof mod === "object" && "completeSimple" in mod ? (mod as Record<string, unknown>)["completeSimple"] : undefined;
			if (typeof complete !== "function") return null;
			const prompt = `Summarize this tool result in one paragraph. State only facts present in the result.\n\n${content.slice(0, 12000)}`;
			const params = { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
			// 25s end-to-end: the RPC timeout after this covers transport, this covers the model call.
			const msg: unknown = await withTimeout(25_000, (complete as (m: unknown, cc: unknown, o?: unknown) => Promise<unknown>)(model, params, { apiKey, disableReasoning: true }));
			if (!msg || typeof msg !== "object" || !("content" in msg)) return null;
			const blocks: unknown = (msg as { content: unknown }).content;
			if (!Array.isArray(blocks)) return null;
			const parts: string[] = [];
			for (const b of blocks) {
				if (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string") parts.push((b as { text: string }).text);
			}
			const text = parts.join("\n").trim();
			return text || null;
		} catch { return null; }
	}
	function sessionIdFrom(ctx: unknown): string | null {
		try {
			const c = ctx as { sessionManager?: { getSessionId?: () => unknown } };
			const id = c?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes(":") ? id : null;
		} catch { return null; }
	}
	function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
		const { promise, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error("session-navigation: summarize timeout")), ms);
		return Promise.race([p.finally(() => clearTimeout(timer)), promise]) as Promise<T>;
	}
	pi.registerTool({ name: "hide_context", label: "Hide Context", description: "Hide one confirmed, eligible read result using rule-based excerpts only (never calls a model).", parameters: z.object({ tool_call_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("compact", params, ctx, signal)); } });
	pi.registerTool({ name: "summarize_context", label: "Summarize Context", description: "Hide one confirmed, eligible read or bash result with a session-model summary. Returns summarizer_unavailable when no session model exists.", parameters: z.object({ tool_call_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) {
			const session = sessionId(ctx);
			if (session && candidate?.confirmed && candidate.session === session) {
				const target = candidate.records.find((r) => r.call_id === (params as { tool_call_id: string }).tool_call_id);
				if (target) {
					const summary = await summarizeText(ctx, target.content);
					if (summary) return result(await tool("summarize", { ...(params as Record<string, unknown>), summary_text: summary }, ctx, signal));
					return result({ ok: false, error: "summarizer_unavailable" });
				}
			}
			return result(await tool("summarize", params, ctx, signal));
		} });
	pi.registerTool({ name: "unhide_context", label: "Unhide Context", description: "Unhide a hidden result; the stored summary is kept for re-hiding.", parameters: z.object({ item_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("restore", params, ctx, signal)); } });
	pi.registerTool({ name: "list_context_items", label: "List Context Items", description: "List hidden results in this session.", parameters: z.object({ query: z.string().optional() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("list_items", params, ctx, signal)); } });
	pi.registerTool({ name: "manage_context", label: "Manage Context", description: "Automatically hide confirmed, eligible read and bash results. action=auto prefers a session-model summary with rule fallback.", parameters: z.object({ tool_call_ids: z.array(z.string()).optional(), action: z.enum(["auto", "hide", "summarize"]).optional(), max_items: z.number().int().min(1).max(64).optional() }),
		async execute(_id, params, signal, _update, ctx) {
			const session = sessionId(ctx);
			const action = (params as { action?: string }).action ?? "auto";
			if (session && candidate?.confirmed && candidate.session === session && (action === "auto" || action === "summarize")) {
				const want = (params as { tool_call_ids?: string[] }).tool_call_ids;
				const wanted = Array.isArray(want) ? new Set(want) : null;
				const summaries: Record<string, string> = {};
				await Promise.all(candidate.records.filter((r) => !wanted || wanted.has(r.call_id)).map(async (r) => {
					const text = await summarizeText(ctx, r.content);
					if (text) summaries[r.call_id] = text;
				}));
				if (action === "summarize" && Object.keys(summaries).length === 0) return result({ ok: false, error: "summarizer_unavailable" });
				return result(await tool("manage", { ...(params as Record<string, unknown>), summaries: Object.keys(summaries).length ? summaries : undefined }, ctx, signal));
			}
			return result(await tool("manage", params, ctx, signal));
		} });
	if (typeof pi.registerCommand === "function") {
	pi.registerCommand("session-navigation", {
  description: "Open the session navigation panel",
  handler: async (_args: string, ctx: any) => {
    if (ctx?.mode !== "tui") {
      try { ctx?.ui?.notify?.("session-navigation requires an interactive TUI", "warning"); } catch { /* ignore */ }
      try { ctx?.abort?.(); } catch { /* ignore */ }
      return;
    }
    const session = sessionId(ctx);
    await ctx.ui.custom(async (tui: any, _theme: any, keybindings: any, done: (result?: unknown) => void) => {
      let rows: any[] = [];
      let selected = 0;
      let notice = "";
      let selectList: any = null;
      const snapshotId = () => (candidate?.confirmed && candidate?.session === session) ? candidate?.token : undefined;
      const rebuildSelectList = async () => {
        const items = rows.map((r: any, idx: number) => ({ value: String(idx), label: String(r?.tool_call_id ?? r?.call_id ?? "") }));
        try {
          const mod: any = await import("@oh-my-pi/pi-tui");
          const SL = mod?.SelectList;
          if (!SL) throw new Error("no-select-list");
          const themeObj: any = { selectedPrefix: (x: string) => x, selectedText: (x: string) => x, description: (x: string) => x, scrollInfo: (x: string) => x, noMatch: (x: string) => x, symbols: {} };
          selectList = new SL(items, Math.max(1, Math.min(10, items.length || 1)), themeObj, { overflowSearch: false });
          selectList.onSelect = (item: any) => { selected = Number(item?.value ?? 0); tui?.requestRender?.(); };
          selectList.onCancel = () => done(undefined);
        } catch { selectList = null; }
      };
      const reload = async () => {
        const res: any = await rpc("list_items", { query: "", session_id: session, snapshot_id: snapshotId() }, 5000);
        if (!res?.ok) {
          if (res?.error === "db_error") {
            const choice = await ctx.ui.select("Database error", Array.isArray(res?.choices) ? res.choices : ["abort_request", "send_original"]);
            if (choice === "abort_request") { ctx.abort?.(); done(undefined); return; }
            notice = "send_original";
          } else {
            notice = String(res?.error ?? "list_failed");
          }
          rows = [];
        } else {
          rows = Array.isArray(res?.items) ? res.items : [];
          if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
        }
        await rebuildSelectList();
        tui?.requestRender?.();
      };
      const finishMutation = async (res: any) => {
        if (!res?.ok) {
          if (res?.error === "version_conflict") {
            notice = "version_conflict";
            await reload();
            return;
          }
          if (res?.error === "db_error") {
            const choice = await ctx.ui.select("Database error", Array.isArray(res?.choices) ? res.choices : ["abort_request", "send_original"]);
            if (choice === "abort_request") { ctx.abort?.(); done(undefined); return; }
            notice = "send_original";
            await reload();
            return;
          }
          if (res?.error === "summarizer_unavailable") {
            notice = "summarizer_unavailable";
            tui?.requestRender?.();
            return;
          }
          notice = String(res?.error ?? "failed");
          tui?.requestRender?.();
          return;
        }
        notice = "";
        await reload();
      };
      const hideSelected = async () => {
        const row = rows[selected];
        if (!row) return;
        const toolCallId = row?.tool_call_id ?? row?.call_id;
        await finishMutation(await rpc("compact", { tool_call_id: toolCallId, session_id: session, snapshot_id: snapshotId() }, 5000));
      };
      const summarizeSelected = async () => {
        const row = rows[selected];
        if (!row) return;
        const toolCallId = row?.tool_call_id ?? row?.call_id;
        const target = candidate?.records?.find((r: any) => r?.call_id === toolCallId);
        const summary = target ? await summarizeText(ctx, target.content) : null;
        if (!summary) { notice = "summarizer_unavailable"; tui?.requestRender?.(); return; }
        await finishMutation(await rpc("summarize", { tool_call_id: toolCallId, summary_text: summary, session_id: session, snapshot_id: snapshotId() }, 25000));
      };
      const unhideSelected = async () => {
        const row = rows[selected];
        if (!row?.item_id) return;
        await finishMutation(await rpc("restore", { item_id: row.item_id, expected_version: row.version, session_id: session, snapshot_id: snapshotId() }, 5000));
      };
      const rehideSelected = async () => { await hideSelected(); };
      const manageAll = async () => {
        const summaries: Record<string, string> = {};
        if (candidate?.confirmed && Array.isArray(candidate?.records)) {
          await Promise.all(candidate.records.map(async (r: any) => {
            const text = await summarizeText(ctx, r.content);
            if (text) summaries[r.call_id] = text;
          }));
        }
        const res = await rpc("manage", { action: "auto", max_items: 20, session_id: session, snapshot_id: snapshotId(), summaries: Object.keys(summaries).length ? summaries : undefined }, 25000);
        await finishMutation(res);
      };
      await reload();
      const component: any = {
        render: (_width: number) => {
          const lines: string[] = [];
          lines.push("Session navigation");
          if (notice) lines.push(notice);
          if (rows.length === 0) lines.push("(no rows)");
          rows.forEach((r: any, idx: number) => {
            const prefix = idx === selected ? "> " : "  ";
            lines.push(prefix + String(r?.status ?? "") + " " + String(r?.tool_call_id ?? r?.call_id ?? "") + " tokens:" + String(r?.tokens_display ?? "—") + " v" + String(r?.version ?? ""));
          });
          lines.push("[h]ide [s]ummarize [u]nhide [r]e-hide [m]anage [Esc] close");
          return lines;
        },
        handleInput: async (data: string) => {
          let matchesKeyFn: any = null;
          try { const mod: any = await import("@oh-my-pi/pi-tui"); matchesKeyFn = mod?.matchesKey; } catch { /* ignore */ }
          try {
            if (keybindings?.matches?.(data, "app.interrupt")) { done(undefined); return; }
          } catch { /* ignore */ }
          if (matchesKeyFn && matchesKeyFn(data, "escape")) { done(undefined); return; }
          if (matchesKeyFn && matchesKeyFn(data, "up")) { selected = Math.max(0, selected - 1); tui?.requestRender?.(); return; }
          if (matchesKeyFn && matchesKeyFn(data, "down")) { selected = Math.min(Math.max(0, rows.length - 1), selected + 1); tui?.requestRender?.(); return; }
          const key = String(data ?? "").toLowerCase();
          if (key === "h") { void hideSelected(); return; }
          if (key === "s") { void summarizeSelected(); return; }
          if (key === "u") { void unhideSelected(); return; }
          if (key === "r") { void rehideSelected(); return; }
          if (key === "m") { void manageAll(); return; }
          if (selectList && typeof selectList.handleInput === "function") {
            try { selectList.handleInput(data); } catch { /* ignore */ }
          }
        },
        invalidate: () => { try { selectList?.invalidate?.(); } catch { /* ignore */ } },
      };
      return component;
    }, { overlay: true });
  },
});

}
	pi.on("session_shutdown", async () => { candidate = null; if (proc) invalidate(proc, "shutdown"); });
}
