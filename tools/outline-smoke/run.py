#!/usr/bin/env python3
"""Paseo outline CDP smoke. Install websockets, or run with uv --with websockets."""
import argparse
import asyncio
import base64
import json
import os
import re
import sqlite3
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit

import websockets

PORT = 19322
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
DEFAULT_URL = 'http://127.0.0.1:17680/'
HERMES = 'aa0c9d63-0830-40e7-90d2-b8faa79ac64d'
SANDBOX_HERMES = '7b2e4a11-9c3d-4e5f-8a6b-1d2f3a4b5c6d'
OMP = '5c4bc793-eb5d-40c4-9dc2-1fe5f3f4ff4f'
CALL = 'call_00_sfrmago9exbschabupzaix7x'
MESSAGE = 'msg_1794996946726_975decyxg'
# Reused from the Gemini sandbox2 CDP harness: locate the outline scroller by
# DOM ancestry instead of desktop coordinates, so mobile drawers work too.
SCROLLER = """(()=>{const row=document.querySelector('[aria-label="User prompt"], [aria-label="Agent response"], [aria-label^="Tool group:"]');if(row){let cur=row.parentElement;while(cur&&cur!==document.body){const r=cur.getBoundingClientRect();if(r.width>120&&r.height>100&&cur.scrollHeight>cur.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(cur).overflowY))return cur;cur=cur.parentElement}}const btn=document.querySelector('[aria-label="Refresh outline"]');if(!btn)return null;let root=btn;for(let i=0;i<12&&root.parentElement;i++){root=root.parentElement;const found=Array.from(root.querySelectorAll('*')).find(e=>e.clientHeight>100&&e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(getComputedStyle(e).overflowY));if(found)return found}return null})()"""
PANEL = """(()=>{const btn=document.querySelector('[aria-label="Refresh outline"]');const s=""" + SCROLLER + """;let cur=btn||s;if(!cur)return null;for(let i=0;i<8&&cur.parentElement;i++){cur=cur.parentElement;const r=cur.getBoundingClientRect();if(r.width>=200&&r.height>=200)return cur}return cur})()"""


def endpoint(path, port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=2) as response:
        return json.load(response)


def chrome(port, profile):
    try:
        endpoint('/json/version', port)
        return
    except (OSError, ValueError):
        pass
    os.makedirs(profile, exist_ok=True)
    subprocess.Popen([CHROME, '--headless=new', '--disable-gpu', '--no-first-run',
                      '--no-default-browser-check', '--use-mock-keychain', f'--remote-debugging-port={port}',
                      f'--user-data-dir={profile}', '--window-size=1400,1000', 'about:blank'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(100):
        try:
            endpoint('/json/version', port)
            return
        except (OSError, ValueError):
            time.sleep(.1)
    raise RuntimeError(f'Chrome CDP did not start on 127.0.0.1:{port}')


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.number = 0

    async def call(self, method, **params):
        self.number += 1
        number = self.number
        await self.ws.send(json.dumps({'id': number, 'method': method, 'params': params}))
        while True:
            response = json.loads(await self.ws.recv())
            if response.get('id') == number:
                if 'error' in response:
                    raise RuntimeError(str(response['error']))
                return response.get('result', {})

    async def js(self, expression):
        result = await self.call('Runtime.evaluate', expression=expression, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in result:
            raise RuntimeError(str(result['exceptionDetails']))
        return result.get('result', {}).get('value')

    async def screenshot(self, path):
        result = await self.call('Page.captureScreenshot', format='png', fromSurface=True)
        path.write_bytes(base64.b64decode(result['data']))


async def wait_for(cdp, expression, seconds=20, interval=.3):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        last = await cdp.js(expression)
        if last:
            return last
        await asyncio.sleep(interval)
    return last


CLICK = """(e)=>{if(!e)return false;e.scrollIntoView({block:'nearest'});for(const t of ['pointerdown','mousedown','mouseup','click'])e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));return true}"""


async def click(cdp, selector):
    return await cdp.js(f'({CLICK})({selector})')

async def cdp_click_point(cdp, x, y):
    """Real pointer click at viewport coordinates (works for mobile drawers)."""
    await cdp.call('Input.dispatchMouseEvent', type='mouseMoved', x=x, y=y, button='none', clickCount=0)
    await cdp.call('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y, button='left', clickCount=1)
    await cdp.call('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y, button='left', clickCount=1)

async def prepare(cdp, url, title, workspace=None, server=None):
    await cdp.call('Page.navigate', url=url)
    connect_expr = "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/연결|Connect/i.test(e.textContent.trim()))"
    await wait_for(cdp, f"!!({connect_expr})", 8)
    await click(cdp, connect_expr)
    await asyncio.sleep(2)
    if workspace:
        parsed = urlsplit(url)
        if not server and parsed.fragment.startswith('offer='):
            offer = parse_qs(parsed.fragment).get('offer', [''])[0]
            server = json.loads(base64.urlsafe_b64decode(offer + '=' * (-len(offer) % 4)))['serverId']
        if not server: raise RuntimeError('--server-id required with --workspace for a direct URL')
        await cdp.call('Page.navigate', url=f'{parsed.scheme}://{parsed.netloc}/h/{server}/workspace/{workspace}')
        await asyncio.sleep(4)
    title = title[:30]
    selector = f"Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&e.textContent.includes({json.dumps(title)})).map(e=>{{let p=e;for(let i=0;i<5&&p.parentElement;i++)p=p.parentElement;return p}})[0]"
    tab = f"Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&e.textContent.includes({json.dumps(title)})&&e.getBoundingClientRect().x>300&&e.getBoundingClientRect().y<80).at(-1)"
    if await wait_for(cdp, f'!!({selector})', 15):
        await click(cdp, selector)
        await asyncio.sleep(2)
    elif not await wait_for(cdp, f'!!({tab})', 3):
        raise RuntimeError(f'session leaf or tab not found: {title}')
    if await wait_for(cdp, f'!!({tab})', 3):
        await click(cdp, tab)
    if not await cdp.js("!!document.querySelector('[aria-label=\"Refresh outline\"]')"):
        await click_visible(cdp, '사이드 패널 열기|Open (right )?sidebar|Open side panel')
        await asyncio.sleep(.8)
        await click(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>{let r=e.getBoundingClientRect();return r.x>900&&r.y<80&&/새 탭|New tab/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent)})")
        await asyncio.sleep(.6)
        leaf = "Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&/^(Session navigation|세션 탐색)$/i.test(e.textContent.trim())&&e.getBoundingClientRect().width>0).at(-1)"
        if not await wait_for(cdp, f'!!({leaf})', 5):
            raise RuntimeError('Session navigation menu entry not found')
        await click(cdp, leaf)
        if not await wait_for(cdp, "!!document.querySelector('[aria-label=\"Refresh outline\"]')", 10):
            raise RuntimeError('outline header missing or new-tab menu remains open')
    if not await wait_for(cdp, f'!!({SCROLLER})', 20):
        raise RuntimeError('outline scroller not found; session/panel navigation incomplete')



def resolve_agent_title(args, agent):
    """Resolve an agent title from CLI args or the sandbox agent list."""
    attr = "omp_title" if agent == args.omp_agent else "hermes_title"
    title = getattr(args, attr)
    if title:
        return title
    cmd = ["paseo", "ls", "--all", "--global", "--json"]
    if args.paseo_host:
        cmd += ["--host", args.paseo_host]
    env = os.environ.copy()
    if args.paseo_home:
        env["PASEO_HOME"] = args.paseo_home
    agents = json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=15, env=env).stdout)
    title = next((a["name"] for a in agents if a["id"] == agent), None)
    if not title:
        raise RuntimeError(f"agent title unavailable for {agent}; provide --hermes-title/--omp-title or --paseo-host")
    setattr(args, attr, title)
    return title

async def metrics(cdp):
    return await cdp.js(f"""(()=>{{let s={SCROLLER};if(!s)return null;let g=s.querySelector('[aria-label^="Tool group:"]');return {{top:s.scrollTop,sh:s.scrollHeight,ch:s.clientHeight,firstGroup:g?.getAttribute('aria-label')||null,firstGroupText:g?.textContent?.trim()||null}}}})()""")
async def outline_state(cdp, scenario, needle):
    """Count mounted/visible outline rows that identify the scenario target."""
    target = json.dumps(CALL if scenario == 'a' else needle, ensure_ascii=False)
    matcher = (
        f"(e.getAttribute('aria-label')||'').includes({target})"
        if scenario == 'a'
        else f"['User prompt','Agent response'].includes(e.getAttribute('aria-label'))&&(e.textContent||'').includes({target})"
    )
    return await cdp.js(f"""(()=>{{const s={SCROLLER},p={PANEL};if(!s||!p)return {{mounted:0,visible:0,totalMounted:0,totalVisible:0,reason:'panel or scroller missing'}};
      const rows=Array.from(s.querySelectorAll('[aria-label^="Select tool"],[aria-label^="Select row"],[aria-label="User prompt"],[aria-label="Agent response"]'));
      const vis=e=>{{const r=e.getBoundingClientRect(),q=p.getBoundingClientRect(),st=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>q.top&&r.top<q.bottom&&r.bottom>0&&r.top<innerHeight&&st.visibility!=='hidden'&&st.display!=='none'}};
      const matches=rows.filter(e=>{matcher});
      return {{mounted:matches.length,visible:matches.filter(vis).length,totalMounted:rows.length,totalVisible:rows.filter(vis).length,
        samples:matches.slice(-3).map(e=>({{label:e.getAttribute('aria-label'),text:(e.textContent||'').trim().slice(0,90)}}))}}}})()""")


async def chat_needle(cdp, needle):
    """Check target text in the chat, excluding the outline panel's own text."""
    return await cdp.js(f"""(()=>{{const p={PANEL},t={json.dumps(needle, ensure_ascii=False)};
      const body=document.body.innerText||'',panel=p?p.innerText||'':'',chat=panel?body.replace(panel,''):body;
      const idx=chat.indexOf(t);
      const nodes=Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&(e.textContent||'').includes(t)&&!(p&&p.contains(e)));
      const vis=nodes.filter(e=>{{const r=e.getBoundingClientRect(),st=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&st.visibility!=='hidden'&&st.display!=='none'}});
      return {{found:idx>=0,visible:vis.length,sample:idx<0?'':chat.slice(idx,idx+{len(needle)+40})}}}})()""")


async def find_row(cdp, scenario, click_target=True):
    # Search mounted rows while explicitly scrolling the outline, loading older pages as needed.
    needle = CALL if scenario == 'a' else '우선 커밋하고 PR생성해줘'
    row = (f"s.querySelector('[aria-label=\"Select tool {CALL}\"], [aria-label=\"Select row {CALL}\"]')"
           if scenario == 'a' else f"Array.from(s.querySelectorAll('[aria-label=\"User prompt\"]')).find(e=>e.textContent.includes({json.dumps(needle, ensure_ascii=False)}))")
    for _ in range(100):
        result = await cdp.js(f"""(()=>{{let s={SCROLLER};if(!s)return 'missing';let r={row};if(r){{r.scrollIntoView({{block:'center'}});return 'found'}}
          let groups=Array.from(s.querySelectorAll('[aria-label^="Tool group:"]')).filter(e=>{{let r=e.getBoundingClientRect(),p=s.getBoundingClientRect();return r.bottom>p.top&&r.top<p.bottom&&e.textContent.includes('manage_context')&&e.querySelector('[aria-label="Expand group"]')}});
          if({str(scenario == 'a').lower()}&&groups.length){{for(const group of groups)({CLICK})(group.querySelector('[aria-label="Expand group"]'));return 'expanded'}};
          s.scrollTop=Math.max(0,s.scrollTop-Math.max(300,s.clientHeight*.8));s.dispatchEvent(new WheelEvent('wheel',{{deltaY:-250,bubbles:true}}));s.dispatchEvent(new Event('scroll',{{bubbles:true}}));return 'searching'}})()""")
        if result == 'found':
            await asyncio.sleep(.5)
            if not click_target:
                return True
            rect = await cdp.js(f"""(()=>{{let s={SCROLLER};let r=s&&({row});if(!r)return null;let b=r.getBoundingClientRect();return {{x:b.x+b.width/2,y:b.y+b.height/2}}}})()""")
            if not rect: continue
            await cdp.call('Input.dispatchMouseEvent', type='mouseMoved', x=rect['x'], y=rect['y'])
            await cdp.call('Input.dispatchMouseEvent', type='mousePressed', x=rect['x'], y=rect['y'], button='left', clickCount=1)
            await cdp.call('Input.dispatchMouseEvent', type='mouseReleased', x=rect['x'], y=rect['y'], button='left', clickCount=1)
            return True
        await asyncio.sleep(.3)
    return False


async def navigation(cdp, scenario, paseo_home=None):
    needle = '우선 커밋하고 PR생성해줘' if scenario == 'b' else ''
    if scenario == 'a' and paseo_home:
        db = Path(paseo_home).parent / 'fakehome/.hermes/state.db'
        conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
        try:
            tool_id = conn.execute('SELECT id FROM messages WHERE tool_call_id=? ORDER BY id DESC LIMIT 1', (CALL,)).fetchone()[0]
            text = conn.execute("SELECT content FROM messages WHERE role='assistant' AND id<? AND length(content)>0 ORDER BY id DESC LIMIT 1", (tool_id,)).fetchone()[0]
            needle = next((line.strip().replace('**', '').strip()[:60] for line in text.splitlines() if len(line.strip()) >= 8), '')
        finally:
            conn.close()
    if not await find_row(cdp, scenario):
        return {'pass': False, 'error': 'target outline row not found', 'outline': await outline_state(cdp, scenario, needle)}
    if scenario == 'a':
        await asyncio.sleep(.5)
        await cdp.js("(()=>{let p=Array.from(document.querySelectorAll('[data-testid=\"session-nav-preview\"]')).find(e=>e.getBoundingClientRect().width>0);if(p&&p.innerText.includes('︽'))p.querySelector('button')?.click()})()")
        await asyncio.sleep(.5)
        preview = await cdp.js("Array.from(document.querySelectorAll('[data-testid=\"session-nav-preview\"]')).find(e=>e.getBoundingClientRect().width>0)?.innerText||''")
        preview_match = re.search(r'display_hermes_\d+', preview)
        if not preview or 'manage_context' not in preview or not preview_match:
            return {'pass': False, 'error': 'preview does not identify target call', 'preview': preview}
        preview_item_id = preview_match.group(0)
    target = CALL if scenario == 'a' else MESSAGE
    expr = f"""(()=>{{let attrs=['data-message-id','data-history-row-id','data-tool-call-id','data-call-id','data-item-id','data-turn-id','id'];
      let els=Array.from(document.querySelectorAll(attrs.map(a=>'['+a+']').join(',')));
      let ids=e=>attrs.map(a=>e.getAttribute(a)).filter(Boolean);
      let matches=els.filter(e=>ids(e).some(v=>v&&decodeURIComponent(v).includes({json.dumps(target)})&&({str(scenario == 'b').lower()}||decodeURIComponent(v).includes('agent_tool_turn:'))));
      let visible=matches.filter(e=>{{let r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'}});
      let anchors=els.flatMap(ids).filter(Boolean);
      let panel={SCROLLER};while(panel&&!panel.querySelector('[aria-label=\"Refresh outline\"]'))panel=panel.parentElement;let notice=!!panel&&Array.from(panel.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Not loaded in chat');
      return {{mounted:matches.length,visible:visible.length,notice,panelFound:!!panel,ids:matches.map(e=>ids(e).join('|')),anchors:anchors.slice(-30),anchorCount:anchors.length}}}})()"""
    deadline = time.monotonic() + 60
    state = None
    while time.monotonic() < deadline:
        state = await cdp.js(expr)
        if state['visible'] and state['panelFound'] and not state['notice']:
            await asyncio.sleep(1)
            state = await cdp.js(expr)
            if state['visible'] and state['panelFound'] and not state['notice']:
                break
        await asyncio.sleep(.5)
    if not state['visible']:
        diag_expr = (
            "(()=>{let t=" + json.dumps(target) + ";"
            "let els=Array.from(document.querySelectorAll('*')).filter(e=>"
            "(e.outerHTML||'').includes(t)||(e.textContent||'').includes('manage_context'));"
            "return els.slice(-12).map(e=>({tag:e.tagName,"
            "attrs:Array.from(e.attributes).map(a=>a.name+'='+a.value).join(' '),"
            "text:e.textContent.trim().slice(0,100)}))})()"
        )
        state['diag'] = await cdp.js(diag_expr)
    state['outline'] = await outline_state(cdp, scenario, needle)
    state['outlineMounted'] = state['outline'].get('mounted', 0)
    state['outlineVisible'] = state['outline'].get('visible', 0)
    if needle:
        state['chatNeedle'] = needle
        state['chatText'] = await chat_needle(cdp, needle)
    outline_ok = state['outlineMounted'] >= 1 and state['outlineVisible'] >= 1
    chat_ok = bool(state['visible'] or (needle and state.get('chatText', {}).get('found')))
    state['pass'] = bool(outline_ok and chat_ok and state['panelFound'] and not state['notice'])
    state['previewItemId'] = preview_item_id if scenario == 'a' else MESSAGE
    return state


async def prepend(cdp):
    samples = [await metrics(cdp)]
    for _ in range(2):
        for _ in range(40):
            at_top = await cdp.js(f"""(()=>{{let s={SCROLLER};s.dispatchEvent(new WheelEvent('wheel',{{deltaY:-250,bubbles:true,cancelable:true}}));s.scrollTop=Math.max(0,s.scrollTop-250);s.dispatchEvent(new Event('scroll',{{bubbles:true}}));return s.scrollTop<=5}})()""")
            if at_top: break
            await asyncio.sleep(.08)
        await asyncio.sleep(3)
        samples.append(await metrics(cdp))
    passed = all(samples[i+1]['sh'] > samples[i]['sh'] and samples[i+1]['top'] > 0 and samples[i+1]['firstGroupText'] != samples[i]['firstGroupText'] for i in range(2))
    return {'pass': passed, 'samples': samples, 'referenceScrollHeights': [6783, 12156, 16303]}


SCROLL_PROBE_INSTALL = """((scroller, panel) => {
  const state = { writes: [], hiddenWrites: [], loading: false, mutations: 0, refreshClicks: 0 };
  const origTo = Element.prototype.scrollTo;
  const origBy = Element.prototype.scrollBy;
  const topDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const isTarget = (el) => {
    if (!(el instanceof Element)) return false;
    if (el === scroller) return true;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return false;
    if (panel && panel instanceof Element && panel.isConnected && panel.contains(el)) return true;
    return !!el.querySelector('[aria-label="User prompt"], [aria-label="Agent response"], [aria-label^="Tool group:"]');
  };
  const isHidden = (el) => {
    if (!(el instanceof Element) || !el.isConnected) return true;
    const r = el.getBoundingClientRect();
    return r.width <= 0 || r.height <= 0 || el.clientHeight <= 0;
  };
  const rec = (el, kind, before, target, after) => {
    if (!isTarget(el)) return;
    const entry = {
      kind,
      beforeTop: Math.round(before),
      targetTop: target === null || target === undefined ? null : Math.round(Number(target)),
      afterTop: Math.round(after),
      delta: Math.round(after - before),
      hidden: isHidden(el),
    };
    state.writes.push(entry);
    if (entry.hidden) state.hiddenWrites.push(entry);
  };
  Element.prototype.scrollTo = function (...args) {
    const b = topDesc && topDesc.get ? topDesc.get.call(this) : 0;
    const t = typeof args[0] === 'object' && args[0] !== null ? args[0].top : args[1];
    const r = origTo.apply(this, args);
    const a = topDesc && topDesc.get ? topDesc.get.call(this) : 0;
    rec(this, 'scrollTo', b, t, a);
    return r;
  };
  Element.prototype.scrollBy = function (...args) {
    const b = topDesc && topDesc.get ? topDesc.get.call(this) : 0;
    const dy = typeof args[0] === 'object' && args[0] !== null ? args[0].top : args[1];
    const r = origBy.apply(this, args);
    const a = topDesc && topDesc.get ? topDesc.get.call(this) : 0;
    rec(this, 'scrollBy', b, b + (Number(dy) || 0), a);
    return r;
  };
  if (topDesc && topDesc.get && topDesc.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: topDesc.enumerable,
      get: topDesc.get,
      set: function (v) {
        const b = topDesc.get.call(this);
        topDesc.set.call(this, v);
        const a = topDesc.get.call(this);
        rec(this, 'scrollTop', b, v, a);
      },
    });
  }
  state.restore = () => {
    Element.prototype.scrollTo = origTo;
    Element.prototype.scrollBy = origBy;
    if (topDesc) Object.defineProperty(Element.prototype, 'scrollTop', topDesc);
  };
  state.scrollTopHooked = !!(topDesc && topDesc.set);
  return state;
})"""


async def collapse(cdp):
    await cdp.js(f"""(()=>{{let s={SCROLLER};s.scrollTop=Math.min(1446,Math.max(100,(s.scrollHeight-s.clientHeight)/2));s.dispatchEvent(new Event('scroll',{{bubbles:true}}))}})()""")
    await asyncio.sleep(1)
    before = await metrics(cdp)
    await cdp.js(f"""(()=>{{let s={SCROLLER},a=s;for(let i=0;i<6;i++){{if(!a.parentElement)throw Error('missing ancestor');a=a.parentElement}};
      const probe=({SCROLL_PROBE_INSTALL})(s,a);
      let st=document.getElementById('smoke-hide-css');if(!st){{st=document.createElement('style');st.id='smoke-hide-css';st.textContent='[data-smoke-hide="1"] {{ display: none !important; }}';document.head.appendChild(st)}}
      window.__smoke={{probe,ancestor:a,scroller:s}};
      window.__smoke.observer=new MutationObserver(()=>{{if(Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Loading older items…'))probe.loading=true}});
      window.__smoke.observer.observe(document.body,{{subtree:true,childList:true,characterData:true}});
      a.setAttribute('data-smoke-hide','1');s.dispatchEvent(new Event('scroll',{{bubbles:true}}))}})()""")
    after = None
    observed = {"hiddenWrites": [], "writes": [], "loading": False, "scrollTopHooked": False}
    try:
        await asyncio.sleep(.5)
        await cdp.js("(()=>{const x=window.__smoke;x.ancestor.removeAttribute('data-smoke-hide');document.getElementById('smoke-hide-css')?.remove();x.scroller.dispatchEvent(new Event('scroll',{bubbles:true}))})()")
        await asyncio.sleep(3)
        after = await metrics(cdp)
        observed = await cdp.js("(()=>{let x=window.__smoke,p=x.probe;return{scrollTopHooked:!!p.scrollTopHooked,hiddenWrites:p.hiddenWrites.slice(-10),hiddenWriteCount:p.hiddenWrites.length,hiddenAbsDelta:p.hiddenWrites.reduce((acc,w)=>acc+Math.abs(w.delta||0),0),totalWrites:p.writes.length,loading:p.loading||Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Loading older items…')}})()")
    finally:
        try:
            await cdp.js("(()=>{let x=window.__smoke||{};try{x.observer&&x.observer.disconnect()}catch(e){}try{x.probe&&x.probe.restore&&x.probe.restore()}catch(e){}try{x.ancestor&&x.ancestor.removeAttribute('data-smoke-hide')}catch(e){}document.getElementById('smoke-hide-css')?.remove()})()")
        except Exception:
            pass
    passed = bool(
        before
        and after
        and before['top'] > 50
        and after['top'] > 50
        and abs(after['top'] - before['top']) <= 50
        and observed.get('scrollTopHooked')
        and observed.get('hiddenWriteCount') == 0
        and observed.get('hiddenAbsDelta') == 0
        and not observed['loading']
    )
    return {'pass': passed, 'before': before, 'after': after, **observed}
async def scroller_box(cdp):
    return await cdp.js(f"""(()=>{{const s={SCROLLER};if(!s)return null;const r=s.getBoundingClientRect();return {{x:r.left+r.width/2,y:r.top+r.height/2,w:Math.round(r.width),h:Math.round(r.height),top:s.scrollTop,sh:s.scrollHeight,ch:s.clientHeight}}}})()""")


async def click_visible(cdp, pattern):
    """Pointer-click the first visible button matching an aria/title/text regex."""
    expr = ("(()=>{const re=new RegExp(" + json.dumps(pattern) + ",'i');"
            "const b=Array.from(document.querySelectorAll('button,[role=button]')).find(x=>"
            "re.test((x.getAttribute('aria-label')||'')+' '+(x.getAttribute('title')||'')+' '+(x.textContent||''))&&"
            "x.getBoundingClientRect().width>0&&x.getBoundingClientRect().height>0);"
            "if(!b)return null;const r=b.getBoundingClientRect();"
            "return {x:r.left+r.width/2,y:r.top+r.height/2,label:b.getAttribute('aria-label')||b.textContent.trim()}})()")
    box = await cdp.js(expr)
    if box:
        await cdp_click_point(cdp, box['x'], box['y'])
    return box


async def switch_agent(cdp, args, agent, workspace, title):
    """Switch to another real agent session via in-app UI (chooser or sidebar) when available, measuring real scroll."""
    started = time.monotonic()
    short = title[:30]
    await cdp.js(f"""(()=>{{const p={PANEL},s={SCROLLER};
      if(window.__switchProbe&&window.__switchProbe.restore)window.__switchProbe.restore();
      window.__switchProbe=({SCROLL_PROBE_INSTALL})(s,p);return true}})()""")
    switched_method = None
    used_page_navigate = False
    try:
        chooser_box = await cdp.js(
            "(()=>{const el=document.querySelector('[aria-label=\"Choose navigator agent\"]');"
            "if(!el)return null;const r=el.getBoundingClientRect();"
            "return r.width>0&&r.height>0?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()"
        )
        if chooser_box:
            await cdp_click_point(cdp, chooser_box['x'], chooser_box['y'])
            await asyncio.sleep(.3)
            opt_expr = (
                "(()=>{const t=" + json.dumps(short) + ";"
                "const el=Array.from(document.querySelectorAll('[aria-label^=\"Navigate \"]')).find(e=>"
                "((e.getAttribute('aria-label')||'')+' '+(e.textContent||'')).includes(t)&&"
                "e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);"
                "if(!el)return null;const r=el.getBoundingClientRect();"
                "return {x:r.left+r.width/2,y:r.top+r.height/2,label:el.getAttribute('aria-label')||''}})()"
            )
            opt = await cdp.js(opt_expr)
            if opt:
                await cdp_click_point(cdp, opt['x'], opt['y'])
                switched_method = 'in_app_chooser'
            else:
                # Close chooser popover if target resides in a different workspace.
                await cdp.call('Input.dispatchKeyEvent', type='keyDown', key='Escape', code='Escape')
                await cdp.call('Input.dispatchKeyEvent', type='keyUp', key='Escape', code='Escape')
        if not switched_method:
            for _ in range(2):
                sidebar_expr = (
                    "(()=>{const p=" + PANEL + ",t=" + json.dumps(short) + ";"
                    "const leaf=Array.from(document.querySelectorAll('*')).find(e=>"
                    "e.children.length===0&&(e.textContent||'').includes(t)&&!(p&&p.contains(e))&&"
                    "e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);"
                    "if(!leaf)return null;let cur=leaf;for(let i=0;i<4&&cur.parentElement;i++){"
                    "if(cur.matches?.('a,button,[role=button]'))break;cur=cur.parentElement}"
                    "const r=cur.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()"
                )
                sb = await cdp.js(sidebar_expr)
                if sb:
                    await cdp_click_point(cdp, sb['x'], sb['y'])
                    switched_method = 'in_app_sidebar'
                    break
                await cdp.js("(()=>{const p=" + PANEL + ";for(const b of document.querySelectorAll('a,button,[role=button]')){if(p&&p.contains(b))continue;const r=b.getBoundingClientRect();if(r.x>=0&&r.x<280&&r.width>40&&r.height>18)b.click()}})()")
                await asyncio.sleep(.4)
        if not switched_method:
            used_page_navigate = True
            switched_method = 'full_page_navigate_fallback'
            await prepare(cdp, args.url, title, workspace, args.server_id)

        title_prefix = (title or '')[:15]
        await wait_for(
            cdp,
            f"(()=>{{const p={PANEL},s={SCROLLER};return !!s&&!!p&&((p.innerText||'').includes({json.dumps(title_prefix)}))}})()",
            10,
        )
        await asyncio.sleep(.8)
        ready = await cdp.js(f'!!({SCROLLER})')
        header = await cdp.js(f"({PANEL})?.innerText||''")
        is_omp = (agent == args.omp_agent)
        outline = (await outline_state(cdp, 'b', '우선 커밋하고 PR생성해줘')
                   if is_omp else await outline_state(cdp, 'a', ''))
        other_needle = CALL if is_omp else '우선 커밋하고 PR생성해줘'
        other_contaminated = await cdp.js(
            f"(()=>{{const s={SCROLLER};if(!s)return false;return (s.textContent||'').includes({json.dumps(other_needle)})}})()"
        )
        m = await metrics(cdp)
        probe_info = await cdp.js(
            "(()=>{const p=window.__switchProbe||{};return{scrollTopHooked:!!p.scrollTopHooked,writeCount:(p.writes||[]).length,writes:(p.writes||[]).slice(-5)}})()"
        )
    finally:
        try:
            await cdp.js("(()=>{if(window.__switchProbe&&window.__switchProbe.restore)window.__switchProbe.restore();window.__switchProbe=null})()")
        except Exception:
            pass
    dist_bottom = (m['sh'] - m['ch'] - m['top']) if m else None
    scrollable = bool(m and m['sh'] > m['ch'] + 20)
    header_matches = bool((title or '')[:15] and (title or '')[:15] in (header or ''))
    step_ok = bool(
        ready
        and not used_page_navigate
        and header_matches
        and not other_contaminated
        and outline.get('totalVisible', 0) >= 1
        and (not is_omp or outline.get('mounted', 0) >= 1)
        and dist_bottom is not None
        and 0 <= dist_bottom <= 80
        and (not scrollable or m['top'] > 0)
        and (not scrollable or probe_info.get('writeCount', 0) >= 1)
    )
    return {
        'title': title,
        'agentId': agent,
        'method': switched_method,
        'usedPageNavigate': used_page_navigate,
        'elapsedSeconds': round(time.monotonic() - started, 2),
        'scrollerReady': bool(ready),
        'headerMatches': header_matches,
        'header': (header or '')[:120],
        'outline': outline,
        'metrics': m,
        'distFromBottom': dist_bottom,
        'scrollProbe': probe_info,
        'stepPass': step_ok,
    }


async def desktop_ui(cdp, args):
    """Measure real UI scroll preservation, hidden-panel mutation and rapid switching."""
    result = {'pass': False}
    box = await scroller_box(cdp)
    if not box or box['w'] <= 0:
        raise RuntimeError('outline scroller unavailable for UI diagnostics')
    initial = await metrics(cdp)
    await cdp.call('Input.dispatchMouseEvent', type='mouseWheel', x=box['x'], y=box['y'],
                   deltaX=0, deltaY=-420)
    await asyncio.sleep(1.2)
    up = await metrics(cdp)
    await asyncio.sleep(1.0)
    stable = await metrics(cdp)
    user_ok = bool(
        initial
        and up
        and stable
        and initial['top'] > 0
        and up['top'] < initial['top'] - 50
        and (up['sh'] - up['ch'] - up['top']) > 50
        and abs(up['top'] - stable['top']) <= 30
    )
    result['userScroll'] = {'pass': user_ok, 'initial': initial, 'afterWheel': up, 'stable': stable}

    setup = await cdp.js(f"""(()=>{{const a={PANEL},s={SCROLLER};if(!a||!s)return false;
      const probe=({SCROLL_PROBE_INSTALL})(s,a);
      let st=document.getElementById('smoke-hide-css');if(!st){{st=document.createElement('style');st.id='smoke-hide-css';st.textContent='[data-smoke-hide="1"] {{ display: none !important; }}';document.head.appendChild(st)}}
      window.__uiSmoke={{panel:a,scroller:s,probe}};
      const btn=document.querySelector('[aria-label="Refresh outline"]');
      if(btn)btn.addEventListener('click',()=>probe.refreshClicks++,{{once:true}});
      window.__uiSmoke.observer=new MutationObserver(()=>{{probe.mutations++}});
      window.__uiSmoke.observer.observe(s,{{subtree:true,childList:true,characterData:true}});
      a.setAttribute('data-smoke-hide','1');s.dispatchEvent(new Event('scroll',{{bubbles:true}}));return true}})()""")
    try:
        if not setup:
            raise RuntimeError('could not hide outline panel for stale mutation check')
        await asyncio.sleep(.4)
        # Dispatch click without synthetic scrollIntoView while panel is display:none.
        await cdp.js("(()=>{const x=window.__uiSmoke;document.querySelector('[aria-label=\"Refresh outline\"]')?.click();const g=x.scroller.querySelector('[aria-label=\"Expand group\"]');if(g){for(const t of ['pointerdown','mousedown','mouseup','click'])g.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}))};return x.probe.refreshClicks})()")
        await asyncio.sleep(1.0)
        await cdp.js("(()=>{const x=window.__uiSmoke;x.panel.removeAttribute('data-smoke-hide');document.getElementById('smoke-hide-css')?.remove();const cur=(" + SCROLLER + ")||x.scroller;cur.dispatchEvent(new Event('scroll',{bubbles:true}));return true})()")
        await asyncio.sleep(1.5)
        after = await metrics(cdp)
    finally:
        observed = await cdp.js("(()=>{const x=window.__uiSmoke||{},p=x.probe||{};try{x.observer&&x.observer.disconnect()}catch(e){}try{p.restore&&p.restore()}catch(e){}try{x.panel&&x.panel.removeAttribute('data-smoke-hide')}catch(e){}document.getElementById('smoke-hide-css')?.remove();return{scrollTopHooked:!!p.scrollTopHooked,refreshClicks:p.refreshClicks||0,mutations:p.mutations||0,hiddenWriteCount:(p.hiddenWrites||[]).length,hiddenAbsDelta:(p.hiddenWrites||[]).reduce((acc,w)=>acc+Math.abs(w.delta||0),0),hiddenWrites:(p.hiddenWrites||[]).slice(-5),totalWrites:(p.writes||[]).length,loading:Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Loading older items…')}})()")
    stale_ok = bool(
        observed['scrollTopHooked']
        and observed['refreshClicks'] >= 1
        and observed['mutations'] >= 1
        and observed['hiddenWriteCount'] == 0
        and observed['hiddenAbsDelta'] == 0
        and after
        and stable
        and after['top'] > 0
        and abs(after['top'] - stable['top']) <= 80
        and not observed['loading']
    )
    result['staleMutation'] = {'pass': stale_ok, 'before': stable, 'after': after, **observed}

    switches = []
    for agent, workspace, title in (
        (args.omp_agent, args.omp_workspace, args.omp_title),
        (args.hermes_agent, args.hermes_workspace, args.hermes_title),
        (args.omp_agent, args.omp_workspace, args.omp_title),
    ):
        switches.append(await switch_agent(cdp, args, agent, workspace, title))
    final = switches[-1]
    title_match = bool(final['headerMatches'])
    final_bottom = final['distFromBottom']
    distinct_agents = [s['agentId'] for s in switches]
    rapid_ok = bool(
        all(s['stepPass'] for s in switches)
        and len(distinct_agents) == 3
        and distinct_agents[0] != distinct_agents[1]
        and distinct_agents[1] != distinct_agents[2]
        and final['outline']['visible'] >= 1
        and title_match
        and final_bottom is not None
        and 0 <= final_bottom <= 80
    )
    result['rapidSwitch'] = {
        'pass': rapid_ok,
        'methods': [s['method'] for s in switches],
        'anyPageNavigate': any(s['usedPageNavigate'] for s in switches),
        'switches': switches,
        'titleMatch': title_match,
        'distFromBottom': final_bottom,
    }
    result['pass'] = user_ok and stale_ok and rapid_ok
    return result

async def mobile_outline(cdp, args):
    """Open the real mobile drawer path: sidebar toggle -> new tab -> Session navigation."""
    parsed = urlsplit(args.url)
    base = f'{parsed.scheme}://{parsed.netloc}/'
    await cdp.call('Emulation.setDeviceMetricsOverride', width=390, height=844, deviceScaleFactor=2, mobile=True)
    await cdp.call('Page.navigate', url=base)
    await asyncio.sleep(3)
    await click(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/연결|Connect/i.test(e.textContent.trim()))")
    await asyncio.sleep(2)
    await cdp.call('Page.navigate', url=f"{base}h/{args.server_id}/workspace/{args.hermes_workspace}")
    await asyncio.sleep(5)
    closed = await cdp.js(f"""(()=>({{scroller:!!({SCROLLER}),buttons:Array.from(document.querySelectorAll('button,[role=button]')).filter(b=>b.getBoundingClientRect().width>0&&b.getBoundingClientRect().top>=0&&b.getBoundingClientRect().top<innerHeight).map(b=>b.getAttribute('aria-label')||b.textContent.trim()).slice(0,20)}}))()""")
    drawer = await click_visible(cdp, '사이드 패널 열기|Open (right )?sidebar|Open side panel')
    await asyncio.sleep(1)
    new_tab = await click_visible(cdp, '새 탭|New tab')
    await asyncio.sleep(.7)
    entry = await cdp.js(f"({CLICK})(Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&/Session navigation|세션 탐색/i.test(e.textContent||'')).at(-1))")
    ready = await wait_for(cdp, f'!!({SCROLLER})', 15)
    located = await find_row(cdp, 'a', click_target=False) if ready else False
    outline = await outline_state(cdp, 'a', '')
    box = await scroller_box(cdp)
    passed = bool(ready and located and box and box['w'] > 0 and box['h'] > 0
                  and outline['mounted'] >= 1 and outline['visible'] >= 1)
    return {'pass': passed, 'viewport': {'width': 390, 'height': 844},
            'closed': closed, 'drawerButton': drawer, 'newTabButton': new_tab,
            'pluginEntryClicked': entry, 'scroller': box, 'outline': outline,
            'targetRowLocated': located,
            'error': None if passed else 'mobile outline row not mounted/visible via drawer path'}


async def run(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scenarios = ['a', 'b', 'c', 'd', 'ui', 'm'] if args.scenario == 'all' else [args.scenario]
    results = {}
    context_id = None
    try:
        chrome(args.cdp_port, args.chrome_profile)
        target_id = None
        if args.is_sandbox:
            async with websockets.connect(endpoint('/json/version', args.cdp_port)['webSocketDebuggerUrl']) as browser_ws:
                browser = CDP(browser_ws)
                context_id = (await browser.call('Target.createBrowserContext'))['browserContextId']
                target_id = (await browser.call('Target.createTarget', url='about:blank', browserContextId=context_id, width=1400, height=1000))['targetId']
        pages = [p for p in endpoint('/json/list', args.cdp_port) if p.get('type') == 'page' and p.get('webSocketDebuggerUrl')]
        if target_id:
            pages = [p for p in pages if p.get('id') == target_id]
        if not pages:
            raise RuntimeError('Chrome has no page target')
        async with websockets.connect(pages[0]['webSocketDebuggerUrl'], max_size=32*1024*1024, open_timeout=10) as ws:
            cdp = CDP(ws)
            await cdp.call('Page.enable')
            if args.is_sandbox:
                await cdp.call('Emulation.setDeviceMetricsOverride', width=1400, height=1000, deviceScaleFactor=1, mobile=False)
            if args.hermes_agent:
                args.hermes_title = resolve_agent_title(args, args.hermes_agent)
            if args.omp_agent:
                args.omp_title = resolve_agent_title(args, args.omp_agent)
            for scenario in scenarios:
                started = time.monotonic()
                try:
                    if scenario == 'm':
                        try:
                            result = await mobile_outline(cdp, args)
                        except Exception as exc:
                            result = {'pass': False, 'error': f'{type(exc).__name__}: {exc}'}
                        result['elapsedSeconds'] = round(time.monotonic() - started, 2)
                        try:
                            await cdp.screenshot(out / 'm.png')
                            result['screenshot'] = 'm.png'
                        except Exception as exc:
                            result['pass'] = False
                            result['screenshotError'] = str(exc)
                        results[scenario] = result
                        print(json.dumps({scenario: result}, ensure_ascii=False), flush=True)
                        continue
                    agent = args.omp_agent if scenario == 'b' else args.hermes_agent
                    title = resolve_agent_title(args, agent)
                    workspace = args.omp_workspace if scenario == 'b' else args.hermes_workspace
                    await prepare(cdp, args.url, title, workspace, args.server_id)
                    result = await (navigation(cdp, scenario, args.paseo_home) if scenario in ('a', 'b') else prepend(cdp) if scenario == 'c' else desktop_ui(cdp, args) if scenario == 'ui' else collapse(cdp))
                except Exception as exc:
                    result = {'pass': False, 'error': f'{type(exc).__name__}: {exc}'}
                result['elapsedSeconds'] = round(time.monotonic()-started, 2)
                try:
                    await cdp.screenshot(out / f'{scenario}.png')
                    result['screenshot'] = f'{scenario}.png'
                except Exception as exc:
                    result['pass'] = False
                    result['screenshotError'] = str(exc)
                results[scenario] = result
                print(json.dumps({scenario: result}, ensure_ascii=False), flush=True)
    except Exception as exc:
        for scenario in scenarios:
            results.setdefault(scenario, {'pass': False, 'error': f'{type(exc).__name__}: {exc}'})
        print(f'CDP setup failed: {exc}', flush=True)
    finally:
        if context_id:
            try:
                async with websockets.connect(endpoint('/json/version', args.cdp_port)['webSocketDebuggerUrl']) as browser_ws:
                    await CDP(browser_ws).call('Target.disposeBrowserContext', browserContextId=context_id)
            except Exception as exc:
                print(f'Chrome context cleanup failed: {exc}', flush=True)
    (out / 'results.json').write_text(json.dumps({'url': args.url, 'scenarios': results}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0 if all(results[s]['pass'] for s in scenarios) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=DEFAULT_URL)
    parser.add_argument('--out', required=True)
    parser.add_argument('--hermes-agent')
    parser.add_argument('--omp-agent', default=OMP)
    parser.add_argument('--hermes-title', help='Hermes 세션 UI 표시명')
    parser.add_argument('--omp-title', help='OMP 세션 UI 표시명')
    parser.add_argument('--hermes-workspace', help='Hermes workspace ID')
    parser.add_argument('--omp-workspace', help='OMP workspace ID')
    parser.add_argument('--server-id', help='직접 URL의 Paseo server ID')
    parser.add_argument('--paseo-host', help='paseo ls 대상 daemon host')
    parser.add_argument('--paseo-home', help='paseo ls 대상 daemon home')
    parser.add_argument('--cdp-port', type=int, default=PORT, help='Isolated Chrome debugging port')
    parser.add_argument('--chrome-profile', default='/tmp/paseo-sandbox/chrome-profile', help='Isolated Chrome profile directory')
    parser.add_argument('--sandbox', action='store_true', help='Force isolated sandbox handling (custom daemon port)')
    parser.add_argument('--scenario', choices=['a', 'b', 'c', 'd', 'ui', 'm', 'all'], default='all')
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    relay_server = None
    if parsed.fragment.startswith('offer='):
        offer = parse_qs(parsed.fragment).get('offer', [''])[0]
        try: relay_server = json.loads(base64.urlsafe_b64decode(offer + '=' * (-len(offer) % 4)))['serverId']
        except (ValueError, KeyError): pass
    # Match the URL authority (host + port), not a substring: a relay/token
    # URL merely mentioning 127.0.0.1:17680 must not flip sandbox paths.
    try:
        url_host, url_port = parsed.hostname or "", parsed.port
    except ValueError:
        url_host, url_port = "", None
    sandbox = ((url_host in ("127.0.0.1", "localhost", "::1") and url_port == 17680)
               or relay_server == 'srv_CpjeCUf0pYTl')
    args.is_sandbox = sandbox or args.sandbox
    if args.is_sandbox and not args.paseo_home: args.paseo_home = '/tmp/paseo-sandbox/home'
    if args.is_sandbox and (parsed.path in ('', '/') or relay_server):
        args.hermes_workspace = args.hermes_workspace or 'wks_6e914dd0930622d7'
        args.omp_workspace = args.omp_workspace or 'wks_b826f629b95c1058'
        server_id_file = Path(args.paseo_home) / 'server-id'
        args.server_id = args.server_id or (server_id_file.read_text().strip() if server_id_file.is_file() else 'srv_CpjeCUf0pYTl')
    args.hermes_agent = args.hermes_agent or (SANDBOX_HERMES if args.is_sandbox else HERMES)
    raise SystemExit(asyncio.run(run(args)))


if __name__ == '__main__':
    main()
