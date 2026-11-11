import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const omp = Bun.which("omp");
test("packed OMP package projects original, hidden and restored outgoing requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-nav-e2e-"));
  const fixture = join(dir, "fixture.txt");
  const provider = join(dir, "provider.ts");
  writeFileSync(
    fixture,
    Array.from({ length: 100 }, (_, i) => `Output row ${i} details`).join("\n"),
  );
  expect(omp).toBeTruthy();
  const packageDirectory = resolve(import.meta.dir, "..");
  const pluginsDirectory = join(dir, ".omp/plugins");
  mkdirSync(pluginsDirectory, { recursive: true });
  writeFileSync(join(pluginsDirectory, "package.json"), JSON.stringify({ private: true }));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("XDG_") &&
        !["PI_PROFILE", "OMP_PROFILE", "PI_CODING_AGENT_DIR"].includes(key),
    ),
  );
  Object.assign(environment, {
    HOME: dir,
    PI_CODING_AGENT_DIR: join(dir, ".omp/agent"),
    SESSION_NAVIGATION_STATE_PATH: join(dir, "state.sqlite3"),
  });
  async function command(args: string[], cwd: string) {
    const process = Bun.spawn(args, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  }
  await command([process.execPath, "pm", "pack", "--destination", dir], packageDirectory);
  const tarball = join(dir, "session-navigation-omp-0.1.0.tgz");
  expect(existsSync(tarball)).toBe(true);
  await command([process.execPath, "add", "--ignore-scripts", tarball], pluginsDirectory);
  const installed = join(pluginsDirectory, "node_modules/@session-navigation/omp");
  expect(existsSync(join(installed, "dist/worker.js"))).toBe(true);
  expect(existsSync(join(installed, "src"))).toBe(false);
  const registered = await command([omp!, "plugin", "list", "--json"], dir);
  expect(registered).toContain("@session-navigation/omp");
  const requests: any[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      requests.push(body);
      const n = requests.length - 1;
      let delta: any;
      let finish = "tool_calls";
      if (n === 0)
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "read1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: fixture }) },
            },
          ],
        };
      else if (n === 1)
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "compact1",
              type: "function",
              function: {
                name: "eval",
                arguments: JSON.stringify({
                  language: "js",
                  code: 'console.log(await tool.hide_context({tool_call_id:"read1"}))',
                  title: "compact",
                }),
              },
            },
          ],
        };
      else if (n === 2) {
        const id = JSON.stringify(body.messages).match(/item_[0-9a-f]+/)?.[0];
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "restore1",
              type: "function",
              function: {
                name: "eval",
                arguments: JSON.stringify({
                  language: "js",
                  code: `console.log(await tool.unhide_context({item_id:"${id}"}))`,
                  title: "restore",
                }),
              },
            },
          ],
        };
      } else {
        delta = { content: "done" };
        finish = "stop";
      }
      const chunk = (data: any) =>
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...data }] })}\n\n`;
      return new Response(
        chunk({ delta, finish_reason: null }) +
          chunk({ delta: {}, finish_reason: finish }) +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  writeFileSync(
    provider,
    `export default function(pi) { pi.registerProvider('snstub', {baseUrl:'http://127.0.0.1:${server.port}/v1',api:'openai-completions',apiKey:'local-test',models:[{id:'test',name:'test',reasoning:false,input:['text'],supportsTools:true,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:2048}]}); }`,
  );
  try {
    const proc = Bun.spawn(
      [
        omp!,
        "--model",
        "snstub/test",
        "--mode",
        "json",
        "--print",
        "--no-session",
        "-e",
        provider,
        "--no-title",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-lsp",
        "--approval-mode",
        "yolo",
        "--max-time",
        "30",
        "Inspect the fixture, hide its result, restore it, then answer done.",
      ],
      {
        cwd: dir,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(requests.length).toBe(4);
    const readResult = (request: any) =>
      request.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "read1")?.content;
    const original = readResult(requests[1]);
    const compacted = readResult(requests[2]);
    const restored = readResult(requests[3]);
    expect(typeof original).toBe("string");
    expect(compacted).toContain("Original excerpt");
    expect(compacted.length).toBeLessThan(original.length);
    expect(restored).toBe(original);
    const { Database } = await import("bun:sqlite");
    const database = new Database(join(dir, "state.sqlite3"), { readonly: true });
    const registration = database.query("SELECT adapter_id,enabled FROM adapter_sessions").get();
    expect(registration).toEqual({ adapter_id: "omp", enabled: 1 });
    database.close();
    expect(stdout).toContain('"ok\\":true');
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 90000);
