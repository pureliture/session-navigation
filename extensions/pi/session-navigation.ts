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
type Candidate = { session: string; token: string; confirmed: boolean };
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
				if (!hello.ok || hello.protocol !== 2 || proc !== child) {
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
				!call || found.index >= i || call.name !== "read" || message.toolName !== "read" || message.isError !== false ||
				!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments) ||
				Object.keys(call.arguments).length !== 1 || typeof call.arguments.path !== "string" || !call.arguments.path.trim() ||
				!Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== "text" ||
				typeof message.content[0].text !== "string") continue;
			const content = message.content[0].text;
			bytes += Buffer.byteLength(content, "utf8");
			if (bytes > MAX_BYTES || records.length >= MAX_RECORDS) return null;
			records.push({ call_id: id, tool_name: "read", arguments: { path: call.arguments.path }, status: "ok", content });
			positions.set(id, i);
		}
		return { records, positions };
	}
	pi.on("context", async (event: { messages: any[] }, ctx: ExtensionContext) => {
		candidate = null;
		const session = sessionId(ctx); const collected = collect(event.messages);
		if (!session || !collected) return;
		const next: Candidate = { session, token: randomUUID(), confirmed: false };
		candidate = next;
		const response = await rpc("prepare", { session_id: session, snapshot_id: next.token, records: collected.records }, 2000);
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
	pi.registerTool({ name: "hide_context", label: "Hide Context", description: "Hide one confirmed, eligible read result using rule-based excerpts only (never calls a model).", parameters: z.object({ tool_call_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("compact", params, ctx, signal)); } });
	pi.registerTool({ name: "summarize_context", label: "Summarize Context", description: "Hide one confirmed, eligible read result with a configured model summary. Requires a configured summarizer.", parameters: z.object({ tool_call_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("summarize", params, ctx, signal)); } });
	pi.registerTool({ name: "unhide_context", label: "Unhide Context", description: "Unhide a hidden result; the stored summary is kept for re-hiding.", parameters: z.object({ item_id: z.string() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("restore", params, ctx, signal)); } });
	pi.registerTool({ name: "list_context_items", label: "List Context Items", description: "List hidden results in this session.", parameters: z.object({ query: z.string().optional() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("list_items", params, ctx, signal)); } });
	pi.registerTool({ name: "manage_context", label: "Manage Context", description: "Automatically hide confirmed, eligible read results. action=auto prefers a model summary with rule fallback.", parameters: z.object({ tool_call_ids: z.array(z.string()).optional(), action: z.enum(["auto", "hide", "summarize"]).optional(), max_items: z.number().int().min(1).max(64).optional() }),
		async execute(_id, params, signal, _update, ctx) { return result(await tool("manage", params, ctx, signal)); } });
	pi.on("session_shutdown", async () => { candidate = null; if (proc) invalidate(proc, "shutdown"); });
}
