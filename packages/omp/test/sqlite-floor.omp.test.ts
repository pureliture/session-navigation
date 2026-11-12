import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { supportedSqliteVersion } from "../src/sqlite-runtime.ts";

// A developer may have a SQLite-selecting launcher; exercise the raw OMP
// entrypoint when checking an unsupported host runtime.
const omp = process.env.SESSION_NAVIGATION_OMP_UNWRAPPED ?? Bun.which("omp");
const env = { ...process.env };
delete env.BUN_OPTIONS;
const probe = Bun.spawnSync({
  cmd: [process.execPath, "-e", 'import {Database} from "bun:sqlite"; const db=new Database(":memory:"); console.log(db.query("select sqlite_version() v").get().v); db.close();'],
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const defaultVersion = probe.stdout.toString().trim();

test.skipIf(!omp || probe.exitCode !== 0 || supportedSqliteVersion(defaultVersion))(
  "OMP blocks an unsupported SQLite before a provider sees context",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-sqlite-floor-"));
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() { requests++; return new Response("unexpected", { status: 500 }); },
    });
    const provider = join(dir, "provider.ts");
    writeFileSync(provider, `export default function(pi) { pi.registerProvider('snstub', {baseUrl:'http://127.0.0.1:${server.port}/v1',api:'openai-completions',apiKey:'local-test',models:[{id:'test',name:'test',reasoning:false,input:['text'],supportsTools:true,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:2048}]}); }`);
    try {
      const child = Bun.spawn({
        cmd: [omp!, "--model", "snstub/test", "--mode", "json", "--print", "--no-session",
          "--no-extensions", "-e", provider, "-e", resolve(import.meta.dir, "../index.ts"),
          "--no-title", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp",
          "--max-time", "10", "local-only probe"],
        cwd: dir,
        env: { ...env, HOME: dir, PI_CODING_AGENT_DIR: join(dir, ".omp/agent"),
          SESSION_NAVIGATION_STATE_PATH: join(dir, "state.sqlite3") },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stdout + stderr).toContain(`SQLite ${defaultVersion}은 지원되지 않습니다`);
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000,
);
