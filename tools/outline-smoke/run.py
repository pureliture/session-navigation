#!/usr/bin/env python3
"""Paseo outline CDP smoke. Install websockets, or run with uv --with websockets."""
import argparse
import asyncio
import base64
import json
import os
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
SCROLLER = "Array.from(document.querySelectorAll('*')).find(e=>{let r=e.getBoundingClientRect();return r.x>1000&&r.width>200&&e.clientHeight>150&&e.scrollHeight>e.clientHeight+100})"


def endpoint(path):
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}{path}', timeout=2) as response:
        return json.load(response)


def chrome():
    try:
        endpoint('/json/version')
        return
    except (OSError, ValueError):
        pass
    profile = '/tmp/paseo-sandbox/chrome-profile'
    os.makedirs(profile, exist_ok=True)
    subprocess.Popen([CHROME, '--headless=new', '--disable-gpu', '--no-first-run',
                      '--no-default-browser-check', f'--remote-debugging-port={PORT}',
                      f'--user-data-dir={profile}', '--window-size=1400,1000', 'about:blank'],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(100):
        try:
            endpoint('/json/version')
            return
        except (OSError, ValueError):
            time.sleep(.1)
    raise RuntimeError('Chrome CDP did not start on 127.0.0.1:19322')


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


async def prepare(cdp, url, title, workspace=None, server=None):
    await cdp.call('Page.navigate', url=url)
    await asyncio.sleep(3)
    await click(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>e.textContent.trim()==='연결')")
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
    await click(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>/사이드 패널 열기|Open (right )?sidebar|Open side panel/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')))")
    await asyncio.sleep(1)
    await click(cdp, "Array.from(document.querySelectorAll('button,[role=button]')).find(e=>{let r=e.getBoundingClientRect();return r.x>1000&&r.y<80&&/새 탭|New tab/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+e.textContent)})")
    await asyncio.sleep(.5)
    leaf = "Array.from(document.querySelectorAll('*')).filter(e=>e.children.length===0&&e.textContent.trim()==='Session navigation'&&e.getBoundingClientRect().x>1200&&e.getBoundingClientRect().y>90).at(-1)"
    if not await wait_for(cdp, f'!!({leaf})', 5):
        raise RuntimeError('Session navigation menu entry not found')
    await click(cdp, leaf)
    if not await wait_for(cdp, f"!!document.querySelector('[aria-label=\"Refresh outline\"]') && !({leaf})", 10):
        raise RuntimeError('outline header missing or new-tab menu remains open')
    if not await wait_for(cdp, f'!!({SCROLLER})', 20):
        raise RuntimeError('outline scroller not found; session/panel navigation incomplete')


async def metrics(cdp):
    return await cdp.js(f"""(()=>{{let s={SCROLLER};if(!s)return null;let g=s.querySelector('[aria-label^="Tool group:"]');return {{top:s.scrollTop,sh:s.scrollHeight,ch:s.clientHeight,firstGroup:g?.getAttribute('aria-label')||null,firstGroupText:g?.textContent?.trim()||null}}}})()""")


async def find_row(cdp, scenario):
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
            rect = await cdp.js(f"""(()=>{{let s={SCROLLER};let r=s&&({row});if(!r)return null;let b=r.getBoundingClientRect();return {{x:b.x+b.width/2,y:b.y+b.height/2}}}})()""")
            if not rect: continue
            await cdp.call('Input.dispatchMouseEvent', type='mouseMoved', x=rect['x'], y=rect['y'])
            await cdp.call('Input.dispatchMouseEvent', type='mousePressed', x=rect['x'], y=rect['y'], button='left', clickCount=1)
            await cdp.call('Input.dispatchMouseEvent', type='mouseReleased', x=rect['x'], y=rect['y'], button='left', clickCount=1)
            return True
        await asyncio.sleep(.3)
    return False


async def navigation(cdp, scenario):
    if not await find_row(cdp, scenario):
        return {'pass': False, 'error': 'target outline row not found'}
    if scenario == 'a':
        await asyncio.sleep(.5)
        await cdp.js("(()=>{let p=Array.from(document.querySelectorAll('[data-testid=\"session-nav-preview\"]')).find(e=>e.getBoundingClientRect().width>0);if(p&&p.innerText.includes('︽'))p.querySelector('button')?.click()})()")
        await asyncio.sleep(.5)
        preview = await cdp.js("Array.from(document.querySelectorAll('[data-testid=\"session-nav-preview\"]')).find(e=>e.getBoundingClientRect().width>0)?.innerText||''")
        if not preview or 'display_hermes_298396' not in preview:
            return {'pass': False, 'error': 'preview does not identify target call', 'preview': preview}
    target = CALL if scenario == 'a' else MESSAGE
    expr = f"""(()=>{{let els=Array.from(document.querySelectorAll('[data-message-id],[data-history-row-id]'));
      let matches=els.filter(e=>[e.getAttribute('data-message-id'),e.getAttribute('data-history-row-id')].some(v=>v&&decodeURIComponent(v).includes({json.dumps(target)})&&({str(scenario == 'b').lower()}||decodeURIComponent(v).includes('agent_tool_turn:2f95300a-'))));
      let visible=matches.filter(e=>{{let r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'}});
      let panel={SCROLLER};while(panel&&!panel.querySelector('[aria-label=\"Refresh outline\"]'))panel=panel.parentElement;let notice=!!panel&&Array.from(panel.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Not loaded in chat');
      return {{mounted:matches.length,visible:visible.length,notice,panelFound:!!panel,ids:matches.map(e=>e.getAttribute('data-message-id')||e.getAttribute('data-history-row-id'))}}}})()"""
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
    state['pass'] = bool(state['visible'] and state['panelFound'] and not state['notice'])
    if scenario == 'a': state['previewItemId'] = 'display_hermes_298396'
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


async def collapse(cdp):
    before = await metrics(cdp)
    await cdp.js(f"""(()=>{{let s={SCROLLER};s.scrollTop=Math.min(1446,Math.max(100,(s.scrollHeight-s.clientHeight)/2));s.dispatchEvent(new Event('scroll',{{bubbles:true}}))}})()""")
    await asyncio.sleep(1)
    before = await metrics(cdp)
    await cdp.js(f"""(()=>{{let s={SCROLLER},a=s;for(let i=0;i<6;i++){{if(!a.parentElement)throw Error('missing ancestor');a=a.parentElement}};
      window.__smoke={{calls:[],loading:false,old:a.style.display}};let original=Element.prototype.scrollTo;window.__smoke.restore=()=>Element.prototype.scrollTo=original;
      Element.prototype.scrollTo=function(...args){{window.__smoke.calls.push({{args,tag:this.tagName}});return original.apply(this,args)}};
      window.__smoke.observer=new MutationObserver(()=>{{if(Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Loading older items…'))window.__smoke.loading=true}});
      window.__smoke.observer.observe(document.body,{{subtree:true,childList:true,characterData:true}});a.style.display='none';s.dispatchEvent(new Event('scroll',{{bubbles:true}}));window.__smoke.ancestor=a;window.__smoke.scroller=s}})()""")
    after = None
    observed = {"calls": [], "loading": False}
    try:
        await asyncio.sleep(.5)
        await cdp.js("window.__smoke.ancestor.style.display=window.__smoke.old;window.__smoke.scroller.dispatchEvent(new Event('scroll',{bubbles:true}))")
        await asyncio.sleep(3)
        after = await metrics(cdp)
        observed = await cdp.js("(()=>{let x=window.__smoke;return{calls:x.calls,loading:x.loading||Array.from(document.querySelectorAll('*')).some(e=>e.children.length===0&&e.textContent.trim()==='Loading older items…')}})()")
    finally:
        # Always detach the observer and restore scrollTo, even when the
        # scenario above throws: a leaked monkeypatch would corrupt later
        # scenarios running in the same page.
        try:
            await cdp.js("(()=>{let x=window.__smoke||{};try{x.observer&&x.observer.disconnect()}catch(e){}try{x.restore&&x.restore()}catch(e){}})()")
        except Exception:
            pass
    return {'pass': bool(after and abs(after['top']-before['top']) <= 50 and not observed['loading'] and not observed['calls']), 'before': before, 'after': after, **observed}


async def run(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    scenarios = list('abcd') if args.scenario == 'all' else [args.scenario]
    results = {}
    context_id = None
    try:
        chrome()
        target_id = None
        if args.is_sandbox:
            async with websockets.connect(endpoint('/json/version')['webSocketDebuggerUrl']) as browser_ws:
                browser = CDP(browser_ws)
                context_id = (await browser.call('Target.createBrowserContext'))['browserContextId']
                target_id = (await browser.call('Target.createTarget', url='about:blank', browserContextId=context_id, width=1400, height=1000))['targetId']
        pages = [p for p in endpoint('/json/list') if p.get('type') == 'page' and p.get('webSocketDebuggerUrl')]
        if target_id:
            pages = [p for p in pages if p.get('id') == target_id]
        if not pages:
            raise RuntimeError('Chrome has no page target')
        async with websockets.connect(pages[0]['webSocketDebuggerUrl'], max_size=32*1024*1024, open_timeout=10) as ws:
            cdp = CDP(ws)
            await cdp.call('Page.enable')
            if args.is_sandbox:
                await cdp.call('Emulation.setDeviceMetricsOverride', width=1400, height=1000, deviceScaleFactor=1, mobile=False)
            for scenario in scenarios:
                started = time.monotonic()
                try:
                    agent = args.omp_agent if scenario == 'b' else args.hermes_agent
                    title = args.omp_title if scenario == 'b' else args.hermes_title
                    if not title:
                        cmd = ['paseo', 'ls', '--all', '--global', '--json']
                        if args.paseo_host: cmd += ['--host', args.paseo_host]
                        env = os.environ.copy()
                        if args.paseo_home: env['PASEO_HOME'] = args.paseo_home
                        agents = json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=15, env=env).stdout)
                        title = next((a['name'] for a in agents if a['id'] == agent), None)
                    if not title: raise RuntimeError(f'agent title unavailable for {agent}; provide --hermes-title/--omp-title or --paseo-host')
                    workspace = args.omp_workspace if scenario == 'b' else args.hermes_workspace
                    await prepare(cdp, args.url, title, workspace, args.server_id)
                    result = await (navigation(cdp, scenario) if scenario in 'ab' else prepend(cdp) if scenario == 'c' else collapse(cdp))
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
                async with websockets.connect(endpoint('/json/version')['webSocketDebuggerUrl']) as browser_ws:
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
    parser.add_argument('--scenario', choices=['a', 'b', 'c', 'd', 'all'], default='all')
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
    args.is_sandbox = sandbox
    if sandbox and not args.paseo_home: args.paseo_home = '/tmp/paseo-sandbox/home'
    if sandbox and (parsed.path in ('', '/') or relay_server):
        args.hermes_workspace = args.hermes_workspace or 'wks_6e914dd0930622d7'
        args.omp_workspace = args.omp_workspace or 'wks_b826f629b95c1058'
        server_id_file = Path(args.paseo_home) / 'server-id'
        args.server_id = args.server_id or (server_id_file.read_text().strip() if server_id_file.is_file() else 'srv_CpjeCUf0pYTl')
    args.hermes_agent = args.hermes_agent or (SANDBOX_HERMES if sandbox else HERMES)
    raise SystemExit(asyncio.run(run(args)))


if __name__ == '__main__':
    main()
