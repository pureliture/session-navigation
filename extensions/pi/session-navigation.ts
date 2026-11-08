import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

interface RpcResponse {
	id?: number;
	ok: boolean;
	error?: string;
	messages?: unknown[];
	items?: unknown[];
	[key: string]: unknown;
}

interface RpcParams {
	scope_key: string;
	[key: string]: unknown;
}

export default function sessionNavigationExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	let proc: ChildProcess | null = null;
	let rl: readline.Interface | null = null;
	let nextId = 1;
	const pending = new Map<number, (r: RpcResponse) => void>();

	function startDaemon() {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const daemonPath = path.resolve(here, "../../pi_session_navigation_daemon.py");
		proc = spawn("python3", [daemonPath], { stdio: ["pipe", "pipe", "pipe"] });
		rl = readline.createInterface({ input: proc.stdout! });
		rl.on("line", (line: string) => {
			try {
				const msg = JSON.parse(line) as RpcResponse;
				const id = msg.id;
				if (id !== undefined && pending.has(id)) {
					pending.get(id)!(msg);
					pending.delete(id);
				}
			} catch {
				// ignore non-JSON
			}
		});
		proc.on("exit", () => { proc = null; rl = null; });
	}

	function rpc(method: string, params: RpcParams): Promise<RpcResponse> {
		if (!proc || !proc.stdin) {
			startDaemon();
		}
		const { promise, resolve } = Promise.withResolvers<RpcResponse>();
		const id = nextId++;
		pending.set(id, resolve);
		proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
		const timer = setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				resolve({ id, ok: false, error: "timeout" });
			}
		}, 30000);
		promise.finally(() => clearTimeout(timer));
		return promise;
	}

	function scopeKey(ctx: ExtensionContext): string {
		const candidate = (ctx as unknown as { sessionManager?: { getSessionId?: () => string } });
		// reason: ExtensionContext shape varies by pi version; guard below.
		const sessionManager = candidate.sessionManager;
		const session = sessionManager?.getSessionId?.() ?? "default";
		return `pi:default:${session}:unknown`;
	}

	pi.on("session_start", async () => { startDaemon(); });

	pi.on("context", async (event: { messages: unknown[] }, ctx: ExtensionContext) => {
		const sk = scopeKey(ctx);
		const res = await rpc("transform_context", { scope_key: sk, messages: event.messages });
		if (res.ok && Array.isArray(res.messages)) {
			return { messages: res.messages as unknown[] };
		}
		return;
	});

	pi.registerTool({
		name: "compact_context",
		label: "Compact Context",
		description: "Compact one already-transmitted tool result: later requests carry its summary instead of the full body.",
		parameters: z.object({ tool_call_id: z.string() }),
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const sk = scopeKey(ctx);
			const res = await rpc("compact", { scope_key: sk, tool_call_id: params.tool_call_id });
			return { content: [{ type: "text", text: JSON.stringify(res) }], details: res };
		},
	});

	pi.registerTool({
		name: "summarize_session",
		label: "Summarize Session",
		description: "Compact one tool result using a configured local model summary. Fails (no silent fallback) if the model is unavailable or validation fails.",
		parameters: z.object({ tool_call_id: z.string() }),
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const sk = scopeKey(ctx);
			const res = await rpc("summarize", { scope_key: sk, tool_call_id: params.tool_call_id });
			return { content: [{ type: "text", text: JSON.stringify(res) }], details: res };
		},
	});

	pi.registerTool({
		name: "restore_context",
		label: "Restore Context",
		description: "Restore a compacted item to its original full body.",
		parameters: z.object({ item_id: z.string() }),
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const sk = scopeKey(ctx);
			const res = await rpc("restore", { scope_key: sk, item_id: params.item_id });
			return { content: [{ type: "text", text: JSON.stringify(res) }], details: res };
		},
	});

	pi.registerTool({
		name: "list_session_items",
		label: "List Session Items",
		description: "List compacted items in this session.",
		parameters: z.object({ query: z.string().optional() }),
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const sk = scopeKey(ctx);
			const res = await rpc("list_items", { scope_key: sk, query: params.query ?? "" });
			return { content: [{ type: "text", text: JSON.stringify(res) }], details: res };
		},
	});

	pi.on("session_shutdown", async () => {
		if (proc) { proc.kill(); proc = null; }
	});
}