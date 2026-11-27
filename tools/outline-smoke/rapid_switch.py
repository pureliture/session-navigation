#!/usr/bin/env python3
"""A→B→A→B 빠른 세션 전환 실측 (완전 격리 synthetic sandbox + 실제 Paseo Web UI).

- 전용 Paseo daemon 127.0.0.1:17689 / Chrome CDP 19329 / HOME·PASEO_HOME·profile /tmp/sn-rapid-switch
- synthetic Hermes 세션 A/B만 사용. 운영 daemon(17680), 운영 Chrome, 운영 HOME은 건드리지 않는다.
- Page.navigate 없이 실제 UI의 "Choose navigator agent" → "Navigate <title>" 클릭만으로 전환.
- 스크롤 복원 규칙(사용자 위쪽 스크롤 유지 / 세션 전환 시 하단 복귀), stale mutation 중
  scrollTo 호출 0회·loading 없음, 최종 outline/session 일치, mounted/visible ≥ 1을 측정.
- 결과와 스크린샷은 /tmp/sn-rapid-results 에 남기고 sandbox는 종료·삭제한다.

실행: uv run --with websockets python tools/outline-smoke/rapid_switch.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time
import urllib.request

import websockets

ROOT = Path("/tmp/sn-rapid-switch")
RESULTS = Path("/tmp/sn-rapid-results")
PASEO_HOME = ROOT / "home"
FAKEHOME = ROOT / "fakehome"
CHROME_PROFILE = ROOT / "chrome-profile"
PLUGIN = Path(__file__).resolve().parents[2] / "paseo-plugin"

LISTEN_ADDR = "127.0.0.1:17689"
BASE_URL = "http://127.0.0.1:17689/"
CDP_PORT = 19329
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

WORKSPACE_ID = "wks_6e914dd0930622d7"
PROJECT_ID = "prj_64b1a7ce436dfcc7"
AGENT_A_ID = "11111111-1111-4111-8111-111111111101"
AGENT_B_ID = "11111111-1111-4111-8111-111111111102"
SESS_A_ID = "sess-rapid-a"
SESS_B_ID = "sess-rapid-b"
TITLE_A = "RA Session A"
TITLE_B = "RB Session B"
MARK_A = "Alpha"
MARK_B = "Bravo"


def sandbox_cwd() -> str:
    return str(FAKEHOME / "workspace")


def project_dir_key() -> str:
    return "-".join(Path(sandbox_cwd()).parts[1:])


def seed_hermes_db() -> None:
    db = FAKEHOME / ".hermes" / "state.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    try:
        conn.executescript(
            """
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY, source TEXT, created_source TEXT, model_config TEXT,
              parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT,
              model TEXT, title TEXT);
            CREATE TABLE messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
              content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
              codex_message_items TEXT, api_content TEXT, active INTEGER NOT NULL DEFAULT 1,
              compacted INTEGER NOT NULL DEFAULT 0, _compressed_summary INTEGER NOT NULL DEFAULT 0,
              timestamp REAL);
            """
        )
        now = 1764000000.0
        for sid, title, ts, mark in (
            (SESS_A_ID, TITLE_A, now - 200, MARK_A),
            (SESS_B_ID, TITLE_B, now - 100, MARK_B),
        ):
            conn.execute(
                "INSERT INTO sessions (id, source, created_source, model_config, parent_session_id, started_at, ended_at, end_reason, model, title) "
                "VALUES (?, 'local', 'acp', '{}', NULL, ?, NULL, NULL, 'gpt-4o-mini', ?)",
                (sid, ts, title),
            )
            for i in range(65):
                conn.execute(
                    "INSERT INTO messages (session_id, role, content, _compressed_summary, timestamp) VALUES (?, 'user', ?, 0, ?)",
                    (sid, f"{mark} prompt row {i:03d}: synthetic question text for tall layout measurement.", ts + i * 2),
                )
                conn.execute(
                    "INSERT INTO messages (session_id, role, content, _compressed_summary, timestamp) VALUES (?, 'assistant', ?, 0, ?)",
                    (sid, f"{mark} reply row {i:03d}: synthetic detailed explanation spanning lines.", ts + i * 2 + 1),
                )
        conn.commit()
    finally:
        conn.close()


def seed_paseo_home() -> None:
    Path(sandbox_cwd()).mkdir(parents=True, exist_ok=True)
    PASEO_HOME.mkdir(parents=True, exist_ok=True)
    (FAKEHOME / ".hermes").mkdir(parents=True, exist_ok=True)
    (FAKEHOME / ".hermes" / ".env").write_text("OPENAI_API_KEY=sandbox-dummy-nonsecret\n", encoding="utf-8")
    (FAKEHOME / ".hermes" / "config.yaml").write_text(
        json.dumps({"model": {"provider": "openai", "default": "gpt-4o-mini"}}, indent=2), encoding="utf-8"
    )
    wrapper = FAKEHOME / ".hermes" / "dummy_acp.sh"
    wrapper.write_text("#!/bin/sh\nsleep 1\n", encoding="utf-8")
    os.chmod(wrapper, 0o700)
    config = {
        "version": 1,
        "daemon": {
            "listen": LISTEN_ADDR,
            "cors": {"allowedOrigins": ["https://app.paseo.sh"]},
            "relay": {"enabled": False},
        },
        "app": {"baseUrl": "https://app.paseo.sh"},
        "pluginsEnabled": True,
        "plugins": {"paseo-plugin": {"source": "directory", "path": str(PLUGIN), "enabled": True}},
        "agents": {
            "providers": {
                "hermes-default": {
                    "extends": "acp",
                    "label": "Hermes (default)",
                    "description": "Sandbox Hermes ACP provider",
                    "command": [str(wrapper)],
                    "env": {
                        "HERMES_HOME": str(FAKEHOME / ".hermes"),
                        "HERMES_PROFILE": "default",
                        "OPENAI_API_KEY": "sandbox-dummy-nonsecret",
                    },
                }
            }
        },
    }
    (PASEO_HOME / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    projects = PASEO_HOME / "projects"
    projects.mkdir(parents=True, exist_ok=True)
    iso = "2026-11-27T08:00:00.000Z"
    (projects / "projects.json").write_text(
        json.dumps(
            [{
                "projectId": PROJECT_ID, "rootPath": sandbox_cwd(), "kind": "non_git",
                "displayName": "SandboxRapid", "projectKey": f"local:{sandbox_cwd()}",
                "customName": None, "customIconRevision": None,
                "createdAt": iso, "updatedAt": iso, "archivedAt": None,
            }], indent=2,
        ) + "\n", encoding="utf-8"
    )
    (projects / "workspaces.json").write_text(
        json.dumps(
            [{
                "workspaceId": WORKSPACE_ID, "projectId": PROJECT_ID, "cwd": sandbox_cwd(),
                "kind": "directory", "displayName": "SandboxWorkspace", "title": "Sandbox Rapid Outline",
                "branch": None, "worktreeRoot": None, "baseBranch": None,
                "isPaseoOwnedWorktree": False, "mainRepoRoot": None,
                "createdAt": iso, "updatedAt": iso, "archivedAt": None,
                "autoArchivedChangeRequestUrl": None, "pinnedAt": None, "metadata": {}, "background": False,
            }], indent=2,
        ) + "\n", encoding="utf-8"
    )
    agents_dir = PASEO_HOME / "agents" / project_dir_key()
    agents_dir.mkdir(parents=True, exist_ok=True)
    for agent_id, sess_id, title, ts in (
        (AGENT_B_ID, SESS_B_ID, TITLE_B, "2026-11-27T07:59:00.000Z"),
        (AGENT_A_ID, SESS_A_ID, TITLE_A, "2026-11-27T08:00:00.000Z"),
    ):
        rec = {
            "id": agent_id, "provider": "hermes-default", "cwd": sandbox_cwd(), "workspaceId": WORKSPACE_ID,
            "createdAt": ts, "updatedAt": ts, "lastActivityAt": ts, "lastUserMessageAt": ts,
            "title": title, "labels": {}, "metadata": {}, "lastStatus": "idle",
            "resumeOnStartup": False, "lastModeId": "accept_edits",
            "config": {"modeId": "accept_edits", "model": "gpt-4o-mini"},
            "runtimeInfo": {"provider": "hermes-default", "sessionId": sess_id, "model": "gpt-4o-mini", "modeId": "accept_edits"},
            "persistence": {
                "provider": "hermes-default", "sessionId": sess_id, "nativeHandle": sess_id,
                "metadata": {"provider": "acp", "profile": "default", "cwd": sandbox_cwd(), "title": title},
            },
            "requiresAttention": False, "internal": False,
        }
        (agents_dir / f"{agent_id}.json").write_text(json.dumps(rec, indent=2) + "\n", encoding="utf-8")


def health_ok() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}api/health", timeout=1.5) as resp:
            return resp.status == 200 and json.load(resp).get("status") == "ok"
    except Exception:
        return False


def start_daemon():
    nav_state = PASEO_HOME / "nav-state"
    nav_state.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["HOME"] = str(FAKEHOME)
    env["PASEO_HOME"] = str(PASEO_HOME)
    env["PASEO_WEB_UI_ENABLED"] = "true"
    env["SESSION_NAVIGATION_STATE_PATH"] = str(nav_state / "state.sqlite3")
    log_fp = open(PASEO_HOME / "daemon-stdout.log", "ab")
    proc = subprocess.Popen(
        ["paseo", "daemon", "run", "--home", str(PASEO_HOME)], env=env,
        stdout=log_fp, stderr=subprocess.STDOUT, start_new_session=True,
    )
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"daemon exited ({proc.returncode}): {(PASEO_HOME / 'daemon-stdout.log').read_text(errors='replace')[-2000:]}")
        text = ""
        for name in ("daemon.log", "daemon-stdout.log"):
            fp = PASEO_HOME / name
            if fp.is_file():
                text += fp.read_text(errors="replace")
        if "Agent registry loaded" in text and "Server listening" in text and health_ok():
            return proc, log_fp, env
        time.sleep(0.25)
    raise RuntimeError("sandbox daemon did not become healthy")


def start_chrome():
    CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
         f"--remote-debugging-port={CDP_PORT}", f"--user-data-dir={CHROME_PROFILE}",
         "--window-size=1400,1000", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1) as resp:
                return proc, json.load(resp)
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Chrome CDP did not start")


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.num = 0
        self.nav_count = 0

    async def call(self, method, **params):
        self.num += 1
        if method == "Page.navigate":
            self.nav_count += 1
        cid = self.num
        await self.ws.send(json.dumps({"id": cid, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == cid:
                if "error" in msg:
                    raise RuntimeError(str(msg["error"]))
                return msg.get("result", {})

    async def js(self, expr):
        res = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in res:
            raise RuntimeError(str(res["exceptionDetails"]))
        return res.get("result", {}).get("value")

    async def shot(self, path: Path):
        res = await self.call("Page.captureScreenshot", format="png", fromSurface=True)
        path.write_bytes(base64.b64decode(res["data"]))


async def wait_for(cdp, expr, timeout=10.0, interval=0.2):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await cdp.js(expr)
        if last:
            return last
        await asyncio.sleep(interval)
    return last


FIND_SCROLLER = """(() => {
  const row = document.querySelector('[aria-label="User prompt"], [aria-label="Agent response"], [aria-label^="Tool group:"]');
  if (row) {
    let cur = row.parentElement;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      if (r.width > 120 && r.height > 100 && cur.scrollHeight > cur.clientHeight + 20
          && /(auto|scroll)/.test(getComputedStyle(cur).overflowY)) return cur;
      cur = cur.parentElement;
    }
  }
  const btn = document.querySelector('[aria-label="Refresh outline"]');
  if (!btn) return null;
  let root = btn;
  for (let i = 0; i < 12 && root.parentElement; i++) {
    root = root.parentElement;
    const found = Array.from(root.querySelectorAll('*')).find(el =>
      el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 20
      && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    if (found) return found;
  }
  return null;
})()"""

PANEL = """(() => {
  const btn = document.querySelector('[aria-label="Refresh outline"]');
  const s = """ + FIND_SCROLLER + """;
  let cur = btn || s;
  if (!cur) return null;
  for (let i = 0; i < 8 && cur.parentElement; i++) {
    cur = cur.parentElement;
    const r = cur.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 200) return cur;
  }
  return cur;
})()"""

CLICK_JS = """(e)=>{if(!e)return false;e.scrollIntoView({block:'nearest'});for(const t of ['pointerdown','mousedown','mouseup','click'])e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));return true}"""


async def cdp_click_point(cdp: CDP, x: float, y: float):
    await cdp.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y, button="none", clickCount=0)
    await cdp.call("Input.dispatchMouseEvent", type="mousePressed", x=x, y=y, button="left", clickCount=1)
    await cdp.call("Input.dispatchMouseEvent", type="mouseReleased", x=x, y=y, button="left", clickCount=1)


async def click_box(cdp: CDP, expr: str):
    """실제 포인터로 보이는 요소 클릭. 좌표와 클릭 시각을 반환."""
    box = await cdp.js(f"(() => {{const e = ({expr}); if (!e) return null; const r = e.getBoundingClientRect(); "
                       f"if (r.width <= 0 || r.height <= 0) return null; "
                       f"return {{x: r.left + r.width/2, y: r.top + r.height/2, w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute('aria-label') || e.textContent.trim().slice(0,60)}}; }})()")
    if not box:
        return None
    started = time.perf_counter()
    await cdp_click_point(cdp, box["x"], box["y"])
    box["clickMs"] = round((time.perf_counter() - started) * 1000, 2)
    return box


async def select_session(cdp: CDP, title: str, prefer_last=True):
    sel = f"""(() => {{
      const nodes = Array.from(document.querySelectorAll('*')).filter(e =>
        e.children.length === 0 && e.textContent.trim() === {json.dumps(title)} &&
        !e.closest('[aria-label="User prompt"], [aria-label="Agent response"], [aria-label^="Tool group:"]'));
      const hits = [];
      for (const n of nodes) {{
        const target = n.closest('a, button, [role="button"], [role="tab"], [role="menuitem"], [tabindex="0"]') || n;
        const r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) hits.push({{target, x: r.left + Math.min(r.width/2, 40), y: r.top + r.height/2, tag: target.tagName}});
      }}
      return hits;
    }})()"""
    hits = await wait_for(cdp, f"(() => {{ const h = ({sel}); return h.length ? h.map(({{target, ...r}}) => r) : null; }})()", 6)
    if not hits:
        return {"found": False}
    idx = len(hits) - 1 if prefer_last else 0
    chosen = hits[idx]
    await cdp_click_point(cdp, chosen["x"], chosen["y"])
    return {"found": True, "chosen": chosen, "hits": len(hits)}


async def ensure_workspace_expanded(cdp: CDP):
    for _ in range(4):
        if await cdp.js(f"document.body.innerText.includes({json.dumps(TITLE_B)})"):
            break
        await select_session(cdp, "Sandbox Rapid Outline", prefer_last=False)
        await asyncio.sleep(0.5)
    if not await cdp.js(f"document.body.innerText.includes({json.dumps(TITLE_B)})"):
        await cdp.js(
            """(() => { const row = Array.from(document.querySelectorAll('*')).find(e => e.children.length === 0 && e.textContent.trim() === 'Sandbox Rapid Outline');
              const card = row?.closest('a,button,[role=button]')?.parentElement;
              if (card) for (const b of card.querySelectorAll('button,[role=button]')) b.click(); })()"""
        )
        await asyncio.sleep(0.8)
    return await cdp.js(f"(() => ({{hasA: document.body.innerText.includes({json.dumps(TITLE_A)}), hasB: document.body.innerText.includes({json.dumps(TITLE_B)})}}))()")


async def state(cdp: CDP):
    return await cdp.js(f"""(() => {{
      const s = {FIND_SCROLLER}, p = {PANEL};
      if (!s) return {{scroller: false, panel: !!p}};
      const rows = Array.from(s.querySelectorAll('[aria-label="User prompt"], [aria-label="Agent response"], [aria-label^="Select "]'));
      const rect = s.getBoundingClientRect(), pr = p ? p.getBoundingClientRect() : null;
      const visible = e => {{ const r = e.getBoundingClientRect(); return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && (!pr || (r.bottom>pr.top && r.top<pr.bottom)); }};
      const hits = rows.filter(e => /Alpha|Bravo/.test(e.textContent||''));
      return {{
        scroller: true, panel: !!p,
        panelVisible: !!pr && pr.width > 0 && pr.height > 0,
        top: Math.round(s.scrollTop), sh: Math.round(s.scrollHeight), ch: Math.round(s.clientHeight),
        distFromBottom: Math.round(s.scrollHeight - s.clientHeight - s.scrollTop),
        rect: {{w: Math.round(rect.width), h: Math.round(rect.height)}},
        totalMounted: rows.length, totalVisible: rows.filter(visible).length,
        matchMounted: hits.length, matchVisible: hits.filter(visible).length,
        marker: (s.textContent||'').includes('Bravo') ? 'Bravo' : (s.textContent||'').includes('Alpha') ? 'Alpha' : null,
        sample: hits.slice(-2).map(e => (e.textContent||'').trim().slice(0,70)),
      }};
    }})()""")


PROBE_JS = """(() => {
  const x = { scrollCalls: [], mutations: 0, outlineMutations: 0, loading: false, clicks: [], snapshots: [] };
  window.__rapid = x;
  const orig = Element.prototype.scrollTo;
  x.restoreScrollTo = () => { Element.prototype.scrollTo = orig; };
  Element.prototype.scrollTo = function (...args) {
    x.scrollCalls.push({ t: Math.round(performance.now()), args: JSON.stringify(args).slice(0, 160) });
    return orig.apply(this, args);
  };
  x.observer = new MutationObserver(records => {
    for (const rec of records) {
      x.mutations++;
      const nodes = [...(rec.addedNodes || []), ...(rec.removedNodes || [])];
      const target = rec.target instanceof Element ? rec.target : null;
      if (target && (/^[A-Z]*SELECT$/.test(target.tagName) || target.getAttribute('aria-label') === 'User prompt'
          || target.getAttribute('aria-label') === 'Agent response'
          || nodes.some(n => n instanceof Element && /aria-label="(User prompt|Agent response|Select )/.test(n.outerHTML || '')))) {
        x.outlineMutations++;
      }
    }
    if (Array.from(document.querySelectorAll('*')).some(e => e.children.length === 0 && /Loading older items|Loading sessions/.test(e.textContent || ''))) x.loading = true;
  });
  // 패널 노드 자체가 교체될 수 있으므로 document.body 전체를 관찰한다.
  x.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  x.listener = e => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    x.clicks.push({ t: Math.round(performance.now()),
      label: t.getAttribute('aria-label') || (t.textContent || '').trim().slice(0, 60) });
  };
  document.addEventListener('click', x.listener, true);
  return { installed: true, clickBase: x.clicks.length, panelFound: !!(%s) };
})()""" % PANEL


async def probe(cdp: CDP):
    return await cdp.js("""(() => { const x = window.__rapid || {};
      return { scrollCalls: x.scrollCalls || [], mutations: x.mutations || 0,
               outlineMutations: x.outlineMutations || 0,
               loading: !!x.loading || Array.from(document.querySelectorAll('*')).some(e => e.children.length === 0 && /Loading older items|Loading sessions/.test(e.textContent || '')),
               clicks: x.clicks || [] }; })()""")


async def detach_probe(cdp: CDP):
    return await cdp.js("""(() => { const x = window.__rapid || {};
      try { x.observer && x.observer.disconnect(); } catch (e) {}
      try { x.restoreScrollTo && x.restoreScrollTo(); } catch (e) {}
      try { document.removeEventListener('click', x.listener, true); } catch (e) {}
      return true; })()""")


async def setup(cdp: CDP, server_id: str, report: dict):
    await cdp.call("Page.navigate", url=BASE_URL)
    await wait_for(cdp, "(document.body && (document.body.innerText.includes('Sandbox Rapid Outline') || Array.from(document.querySelectorAll('button,[role=button]')).some(e=>/연결|Connect/i.test(e.textContent.trim()))))", 15)
    connected = await cdp.js(f"({CLICK_JS})(Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/연결|Connect/i.test(e.textContent.trim())))")
    if connected:
        await asyncio.sleep(1.2)
    ws_url = f"{BASE_URL}h/{server_id}/workspace/{WORKSPACE_ID}"
    await cdp.call("Page.navigate", url=ws_url)
    await wait_for(cdp, "document.body && document.body.innerText.length > 100", 15)
    report["setup"]["workspace"] = await ensure_workspace_expanded(cdp)
    sel_a = await select_session(cdp, TITLE_A)
    report["setup"]["selected_a"] = sel_a
    await asyncio.sleep(1.0)
    if not await cdp.js("!!document.querySelector('[aria-label=\"Refresh outline\"]')"):
        await click_box(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/사이드 패널 열기|Open (right )?sidebar|Open side panel/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')))")
        await asyncio.sleep(0.8)
        await click_box(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>{let r=e.getBoundingClientRect();return r.x>900&&r.y<80&&/새 탭|New tab/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent)})")
        await asyncio.sleep(0.6)
        await click_box(cdp, "Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&e.textContent.trim()==='Session navigation').at(-1)")
        await asyncio.sleep(1.2)
    ready = await wait_for(cdp, f"!!({FIND_SCROLLER}) && !!({PANEL})", 15)
    report["setup"]["outline_ready"] = bool(ready)
    report["setup"]["url"] = await cdp.js("location.href")
    return bool(ready)


CHOOSER = "document.querySelector('[aria-label=\"Choose navigator agent\"]')"
NAV_B = "Array.from(document.querySelectorAll('[aria-label=\"Navigate %s\"]')).find(e => e.getBoundingClientRect().width > 0)" % TITLE_B
NAV_A = "Array.from(document.querySelectorAll('[aria-label=\"Navigate %s\"]')).find(e => e.getBoundingClientRect().width > 0)" % TITLE_A


async def rapid_sequence(cdp: CDP, marks: list):
    """A→B→A→B: chooser 열기 → B → A → B. 응답 대기 없이 포인터 클릭만 연속 전송."""
    opened = await click_box(cdp, CHOOSER)
    if not opened:
        return {"error": "chooser button not found", "clicks": marks}
    marks.append({"step": "open_chooser", **opened})
    t0 = time.perf_counter()
    for i, (label, expr) in enumerate((("B", NAV_B), ("A", NAV_A), ("B", NAV_B))):
        box = await click_box(cdp, expr)
        if not box:
            return {"error": f"navigate {label} option not visible", "clicks": marks}
        marks.append({"step": f"switch_{i+1}_to_{label}", **box})
        if i < 2:
            chooser = await click_box(cdp, CHOOSER)
            if not chooser:
                return {"error": "chooser did not reopen", "clicks": marks}
            marks.append({"step": f"open_chooser_{i+2}", **chooser})
    total_ms = round((time.perf_counter() - t0) * 1000, 2)
    return {"totalMs": total_ms, "clicks": marks}


async def full_navigation_baseline(cdp: CDP, server_id: str):
    """기존 14초 full-navigation 방식(Page.navigate + 고정 슬립)을 같은 sandbox에서 실측."""
    t0 = time.perf_counter()
    nav0 = cdp.nav_count
    await cdp.call("Page.navigate", url=BASE_URL)
    await asyncio.sleep(3)
    await cdp.js(f"({CLICK_JS})(Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/연결|Connect/i.test(e.textContent.trim())))")
    await asyncio.sleep(2)
    await cdp.call("Page.navigate", url=f"{BASE_URL}h/{server_id}/workspace/{WORKSPACE_ID}")
    await asyncio.sleep(4)
    selected = await select_session(cdp, TITLE_A)
    await asyncio.sleep(2)
    if not await cdp.js("!!document.querySelector('[aria-label=\"Refresh outline\"]')"):
        await click_box(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/사이드 패널 열기|Open (right )?sidebar|Open side panel/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')))")
        await asyncio.sleep(1)
        await click_box(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>{let r=e.getBoundingClientRect();return r.x>900&&r.y<80&&/새 탭|New tab/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent)})")
        await asyncio.sleep(0.5)
        await click_box(cdp, "Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&e.textContent.trim()==='Session navigation').at(-1)")
    ready = await wait_for(cdp, f"!!({FIND_SCROLLER})", 10)
    return {
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 2),
        "pageNavigateDelta": cdp.nav_count - nav0,
        "selectedA": selected.get("found", False),
        "scrollerReady": bool(ready),
        "path": "Page.navigate(home) → Connect → Page.navigate(workspace) → session leaf click → sidebar/new-tab/Session navigation",
    }
async def run_suite(cdp: CDP, server_id: str, report: dict):
    with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=2) as r:
        ws_url = json.load(r)["webSocketDebuggerUrl"]
    async with websockets.connect(ws_url) as bws:
        browser = CDP(bws)
        ctx = (await browser.call("Target.createBrowserContext"))["browserContextId"]
        tid = (await browser.call("Target.createTarget", url="about:blank", browserContextId=ctx,
                                  width=1400, height=1000))["targetId"]
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=2) as r:
                page = next(p for p in json.load(r) if p.get("id") == tid)
            async with websockets.connect(page["webSocketDebuggerUrl"], max_size=32 * 1024 * 1024) as pws:
                cdp = CDP(pws)
                await cdp.call("Page.enable")
                await cdp.call("Emulation.setDeviceMetricsOverride", width=1400, height=1000, deviceScaleFactor=1, mobile=False)
                report["setup"] = {}
                if not await setup(cdp, server_id, report):
                    report["setup"]["error"] = "outline panel not ready"
                    await cdp.shot(RESULTS / "setup-failure.png")
                    report["setup"]["diagnostic"] = await cdp.js("document.body.innerText.slice(0, 900)")
                    return
                await cdp.js("window.__rapidStartUrl = location.href")
                initial = await state(cdp)
                report["initial"] = initial
                await cdp.shot(RESULTS / "01-initial-a.png")

                # 1) 사용자 위쪽 스크롤 유지
                sbox = await cdp.js(f"(() => {{ const s = {FIND_SCROLLER}; if (!s) return null; const r = s.getBoundingClientRect(); return {{x:r.left+r.width/2, y:r.top+r.height/2}}; }})()")
                if sbox:
                    await cdp.call("Input.dispatchMouseEvent", type="mouseWheel", x=sbox["x"], y=sbox["y"], deltaX=0, deltaY=-650)
                    await asyncio.sleep(1.2)
                up = await state(cdp)
                await asyncio.sleep(0.8)
                stable = await state(cdp)
                report["scroll"] = {
                    "initial": initial, "afterUp": up, "stable": stable,
                    "upMoved": bool(up and initial and up["top"] < initial["top"] - 50),
                    "preserved": bool(up and stable and abs(up["top"] - stable["top"]) <= 40),
                }

                # 2) 프로브 설치 + 사용자 스크롤 후 하단 복귀 규칙 확인
                installed = await cdp.js(PROBE_JS)
                report["probeInstall"] = installed
                await click_box(cdp, CHOOSER)
                await click_box(cdp, NAV_B)
                await wait_for(cdp, f"((({FIND_SCROLLER})?.textContent)||'').includes('Bravo')", 6)
                await asyncio.sleep(0.5)
                switched_b = await state(cdp)
                await click_box(cdp, CHOOSER)
                await click_box(cdp, NAV_A)
                await wait_for(cdp, f"((({FIND_SCROLLER})?.textContent)||'').includes('Alpha')", 6)
                await asyncio.sleep(0.5)
                switched_a = await state(cdp)
                report["switchAfterUserScroll"] = {
                    "before": stable, "toB": switched_b, "backToA": switched_a,
                    "bLandedBottom": bool(switched_b and switched_b["marker"] == "Bravo" and switched_b["distFromBottom"] <= 60),
                    "aLandedBottom": bool(switched_a and switched_a["marker"] == "Alpha" and switched_a["distFromBottom"] <= 60),
                }

                # 3) A→B→A→B: chooser 클릭만 연속 전송, 중간 응답 대기/슬립 없음
                rapid_base = await cdp.js("window.__rapid.clicks.length")
                nav_before = cdp.nav_count
                rapid = await rapid_sequence(cdp, [])
                nav_after = cdp.nav_count
                report["rapid"] = {**rapid, "pageNavigateDelta": nav_after - nav_before}
                settle_start = time.perf_counter()
                final = await wait_for(cdp, f"((({FIND_SCROLLER})?.textContent)||'').includes('Bravo')", 8)
                settle_ms = round((time.perf_counter() - settle_start) * 1000, 2)
                await asyncio.sleep(0.8)
                final_state = await state(cdp)
                after_probe = await probe(cdp)
                header = await cdp.js("document.querySelector('[aria-label=\"Choose navigator agent\"]')?.textContent?.trim() || ''")
                report["final"] = {
                    "settleMs": settle_ms, "markerSeen": bool(final), "state": final_state,
                    "pinnedHeader": header, "probe": after_probe,
                    "urlChanged": await cdp.js("location.href !== window.__rapidStartUrl"),
                    "url": await cdp.js("location.href"),
                }
                await cdp.shot(RESULTS / "02-rapid-final-b.png")
                rapid_clicks = after_probe["clicks"][rapid_base:]
                report["final"]["rapidClicks"] = rapid_clicks
                report["final"]["clickTargetIntervalsMs"] = [
                    rapid_clicks[i + 1]["t"] - rapid_clicks[i]["t"]
                    for i in range(len(rapid_clicks) - 1)
                ]
                targets = [c for c in rapid_clicks if c["label"] in (TITLE_A, TITLE_B)]
                tms = [c["t"] for c in targets]
                report["final"]["clickSpanMs"] = (tms[-1] - tms[0]) if len(tms) >= 2 else None

                # 4) stale mutation: 패널 숨김 상태에서 세션 전환/refresh/그룹 확장 → scrollTo 0, loading 없음
                scroll_base = len(after_probe["scrollCalls"])
                await cdp.js(f"""(() => {{ const p = {PANEL}, s = {FIND_SCROLLER};
                  if (!p || !s) throw new Error('panel/scroller missing for stale test');
                  window.__stale = {{panel: p, scroller: s, old: p.style.display}};
                  p.style.display = 'none'; s.dispatchEvent(new Event('scroll', {{bubbles:true}})); return true; }})()""")
                stale_click = await click_box(cdp, CHOOSER)
                stale_nav = await click_box(cdp, NAV_A) if stale_click else None
                await cdp.js("(() => { const b = document.querySelector('[aria-label=\"Refresh outline\"]'); b && b.click(); const g = window.__stale.scroller.querySelector('[aria-label=\"Expand group\"]'); g && g.click(); })()")
                await asyncio.sleep(1.0)
                stale_probe = await probe(cdp)
                await cdp.js("(() => { const x = window.__stale; x.panel.style.display = x.old || ''; x.scroller.dispatchEvent(new Event('scroll', {bubbles:true})); })()")
                await wait_for(cdp, f"((({FIND_SCROLLER})?.textContent)||'').includes('Alpha')", 6)
                await asyncio.sleep(0.8)
                restored = await state(cdp)
                await detach_probe(cdp)
                report["stale"] = {
                    "clicks": [stale_click, stale_nav], "probe": stale_probe, "restored": restored,
                    "scrollCalls": len(stale_probe["scrollCalls"]) - scroll_base,
                    "loading": stale_probe["loading"],
                    "mutations": stale_probe["mutations"],
                    "outlineMutations": stale_probe["outlineMutations"],
                    "landedBottom": bool(restored and restored["distFromBottom"] <= 60 and restored["top"] > 0),
                    "markerAlpha": bool(restored and restored["marker"] == "Alpha"),
                }
                await cdp.shot(RESULTS / "03-stale-restored-a.png")

                # 5) 14초 full-navigation과의 차이: 같은 URL, Page.navigate 없이 전환 완료
                report["comparison"] = {
                    "method": "실제 UI chooser → Navigate <title> 포인터 클릭 (Page.navigate 없음)",
                    "rapidSwitchMs": rapid.get("totalMs"),
                    "pageNavigateDelta": report["rapid"].get("pageNavigateDelta"),
                    "urlUnchanged": not report["final"]["urlChanged"],
                }
                baseline = await full_navigation_baseline(cdp, server_id)
                report["baselineFullNavigation"] = baseline
                report["comparison"]["legacyFullNavigationMsMeasured"] = baseline["elapsedMs"]
                report["comparison"]["speedupFactor"] = round(baseline["elapsedMs"] / max(rapid.get("totalMs") or 1, 1), 1)
                await cdp.shot(RESULTS / "04-baseline-a.png")
        finally:
            await browser.call("Target.disposeBrowserContext", browserContextId=ctx)


def kill_proc(proc):
    if proc is None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except OSError:
        try:
            proc.terminate()
        except OSError:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass


def verdict(report: dict) -> dict:
    f = report.get("final", {})
    s = report.get("stale", {})
    st = report.get("scroll", {})
    setup = report.get("setup", {})
    state_ = f.get("state", {})
    nav_delta = report.get("comparison", {}).get("pageNavigateDelta")
    span = report["final"].get("clickSpanMs")
    checks = {
        "outlineReady": bool(setup.get("outline_ready")),
        "finalMarkerBravo": state_.get("marker") == "Bravo",
        "finalPinnedBravo": TITLE_B in f.get("pinnedHeader", "") and TITLE_A not in f.get("pinnedHeader", ""),
        "mountedAtLeastOne": state_.get("matchMounted", 0) >= 1,
        "visibleAtLeastOne": state_.get("matchVisible", 0) >= 1 and state_.get("panelVisible", False),
        "finalBottom": bool(state_.get("distFromBottom", 10 ** 6) <= 60 and state_.get("top", 0) > 0),
        "urlUnchanged": bool(report.get("comparison", {}).get("urlUnchanged")),
        "noNavigateInRapid": nav_delta == 0 and "error" not in report.get("rapid", {}),
        "baselineUsesNavigation": report.get("baselineFullNavigation", {}).get("pageNavigateDelta", 0) >= 1,
        "baselineSlowerThanRapid": report.get("baselineFullNavigation", {}).get("elapsedMs", 0)
                                   > (report.get("rapid", {}).get("totalMs") or 10 ** 6),
        "rapidClickSpanUnder1s": span is not None and 0 < span < 1000,
        "userScrollPreserved": bool(st.get("upMoved") and st.get("preserved")),
        "switchAfterUserScrollBottom": bool(report.get("switchAfterUserScroll", {}).get("bLandedBottom")
                                            and report.get("switchAfterUserScroll", {}).get("aLandedBottom")),
        "staleScrollToZero": s.get("scrollCalls") == 0,
        "staleNoLoading": not s.get("loading", True),
        "staleMutationOccurred": s.get("outlineMutations", 0) >= 1 or s.get("mutations", 0) >= 1,
        "staleRestoreMarkerAlpha": bool(s.get("markerAlpha")),
        "staleRestoreBottom": bool(s.get("landedBottom")),
    }
    return {"checks": checks, "pass": all(checks.values())}


def main():
    if ROOT.exists():
        shutil.rmtree(ROOT)
    RESULTS.mkdir(parents=True, exist_ok=True)
    for fp in RESULTS.glob("*"):
        if fp.is_file():
            fp.unlink()
    daemon_proc = chrome_proc = None
    log_fp = None
    report = {"harness": str(Path(__file__).resolve()), "plugin": str(PLUGIN)}
    try:
        seed_hermes_db()
        seed_paseo_home()
        daemon_proc, log_fp, daemon_env = start_daemon()
        server_id = (PASEO_HOME / "server-id").read_text(encoding="utf-8").strip()
        agents = subprocess.run(["paseo", "agent", "ls", "-a", "--home", str(PASEO_HOME), "--json"],
                                env=daemon_env, capture_output=True, text=True, timeout=15)
        report["agents"] = agents.stdout[:600]
        chrome_proc, _ = start_chrome()
        asyncio.run(run_suite(CDP(None), server_id, report))
    except Exception as exc:
        report["fatal"] = f"{type(exc).__name__}: {exc}"
    finally:
        kill_proc(chrome_proc)
        kill_proc(daemon_proc)
        if log_fp:
            log_fp.close()
        try:
            report["verdict"] = verdict(report)
        except Exception as exc:
            report["verdict"] = {"error": str(exc)}
        (RESULTS / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"verdict": report.get("verdict"), "results": str(RESULTS / "results.json")}, ensure_ascii=False, indent=2))
        shutil.rmtree(ROOT, ignore_errors=True)
    return 0 if report.get("verdict", {}).get("pass") else 1


if __name__ == "__main__":
    raise SystemExit(main())
