import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const omp = Bun.which("omp");
test.skipIf(!omp)("실제 OMP에서 read 결과를 압축하고 다음 요청에서 복원한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-nav-e2e-"));
  const fixture = join(dir, "fixture.txt");
  const provider = join(dir, "provider.ts");
  writeFileSync(fixture, Array.from({ length: 100 }, (_, i) => `Output row ${i} details`).join("\n"));
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: any = await req.json(); requests.push(body);
    const n = requests.length - 1;
    let delta: any; let finish = "tool_calls";
    if (n === 0) delta = { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: fixture }) } }] };
    else if (n === 1) delta = { tool_calls: [{ index: 0, id: "compact1", type: "function", function: { name: "eval", arguments: JSON.stringify({ language: "js", code: 'console.log(await tool.hide_context({tool_call_id:"read1"}))', title: "compact" }) } }] };
    else if (n === 2) {
      const id = JSON.stringify(body.messages).match(/item_[0-9a-f]+/)?.[0];
      delta = { tool_calls: [{ index: 0, id: "restore1", type: "function", function: { name: "eval", arguments: JSON.stringify({ language: "js", code: `console.log(await tool.unhide_context({item_id:"${id}"}))`, title: "restore" }) } }] };
    } else { delta = { content: "done" }; finish = "stop"; }
    const chunk = (data: any) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...data }] })}\n\n`;
    return new Response(chunk({ delta, finish_reason: null }) + chunk({ delta: {}, finish_reason: finish }) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  writeFileSync(provider, `export default function(pi) { pi.registerProvider('snstub', {baseUrl:'http://127.0.0.1:${server.port}/v1',api:'openai-completions',apiKey:'local-test',models:[{id:'test',name:'test',reasoning:false,input:['text'],supportsTools:true,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:2048}]}); }`);
  try {
    const proc = Bun.spawn([omp!, "--model", "snstub/test", "--mode", "json", "--print", "--no-session", "--no-extensions", "-e", provider, "-e", process.env.SESSION_NAVIGATION_TEST_EXTENSION || resolve("extensions/pi/session-navigation.ts"), "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--approval-mode", "yolo", "--max-time", "30", "테스트"], {
      env: {
        ...process.env,
        SESSION_NAVIGATION_DAEMON: process.env.SESSION_NAVIGATION_TEST_DAEMON || resolve(".venv/bin/session-navigation-daemon"),
        SESSION_NAVIGATION_STATE_PATH: join(dir, "state.sqlite3"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(requests.length).toBe(4);
    const readResult = (request: any) => request.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "read1")?.content;
    const original = readResult(requests[1]); const compacted = readResult(requests[2]); const restored = readResult(requests[3]);
    expect(typeof original).toBe("string");
    expect(compacted).toContain("원문 발췌");
    expect(compacted.length).toBeLessThan(original.length);
    expect(restored).toBe(original);
    expect(stdout).toContain('"ok\\":true');
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 40000);
