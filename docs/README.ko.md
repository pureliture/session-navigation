<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:38bdf8,50:2563eb,100:312e81&amp;height=220&amp;section=header&amp;text=Session%20Navigation&amp;fontSize=52&amp;fontColor=ffffff&amp;animation=fadeIn&amp;fontAlignY=40" alt="Session Navigation" width="100%" />

<h3>긴 AI 에이전트 세션을 탐색하고,<br/>필요한 컨텍스트를 숨기고 다시 복원하는 도구</h3>

<p>
  <img src="https://img.shields.io/badge/Paseo-0.15.3-2563eb?style=for-the-badge" alt="검증한 Paseo 버전: 0.15.3" />
  <img src="https://img.shields.io/badge/Python-3.11%2B-0e7490?style=for-the-badge&amp;logo=python&amp;logoColor=white" alt="Python 3.11 이상" />
  <img src="https://img.shields.io/badge/license-MIT-312e81?style=for-the-badge" alt="MIT 라이선스" />
</p>

<p><a href="../README.md">English</a> · <b>한국어</b></p>

<p>
  <a href="#demo">데모</a> ·
  <a href="#주요-기능">주요 기능</a> ·
  <a href="#설치">설치</a> ·
  <a href="#사용법">사용법</a> ·
  <a href="#데이터와-안전-경계">데이터와 안전</a> ·
  <a href="#구조">구조</a> ·
  <a href="#배포--게시-계획">배포</a>
</p>

</div>

<img src="https://capsule-render.vercel.app/api?type=rect&amp;color=0:38bdf8,50:2563eb,100:312e81&amp;height=3" width="100%" alt="" />

## Session Navigation은 무엇인가요?

긴 AI 에이전트 세션의 컨텍스트를 숨기고, 요약하고, 다시 복원하는 호스트 중립 엔진입니다.
Paseo의 우측 Explorer 패널, OMP(oh-my-pi) 확장, Hermes 플러그인에서 사용합니다.
원본 대화 기록을 삭제하지 않고 **모델에 보내는 요청 사본만** 바꿉니다.

현재 소스 체크아웃으로 설치할 수 있습니다. npm·PyPI·공식 플러그인 카탈로그에
게시된 릴리스가 있다는 뜻은 아닙니다. 아래 Git 설치 예시는 이 기능이 `main`에
병합된 뒤를 기준으로 하며, 재현 가능한 설치에는 검토한 커밋이나 릴리스 태그를 사용하세요.

| 사용자가 겪는 문제 | Session Navigation의 방식 |
| --- | --- |
| 긴 세션에서 필요한 대화를 찾기 어려움 | 대화와 도구 결과를 outline으로 탐색하고 해당 위치로 이동 |
| 완료한 도구 결과가 다음 요청의 컨텍스트를 차지함 | 지원하는 결과를 숨기거나 요약하고 예상 변화를 표시 |
| 숨긴 내용을 다시 확인해야 함 | 원본과 대체문을 Preview하고 원본을 복원 |

## Demo

OMP와 DeepSeek Flash를 사용해 작은 API를 검토하는 Paseo 세션입니다.
대화 옆에 outline을 표시하며 원본 메시지와 도구 결과를 보존합니다.

![Session navigator outline beside the chat](media/01-outline-hero.png)

**대화 위치로 이동:** outline의 행을 선택하면 첫 프롬프트를 포함한 해당 메시지로 이동합니다.
[MP4 보기](media/outline-jump.mp4).

![Jump from the health-check review back to the first prompt](media/outline-jump.gif)

**완료한 도구 그룹 숨기기와 복원:** 하단에 다음 요청의 예상 감소량을 표시합니다.
Unhide는 도구를 다시 실행하지 않고 원본을 복원합니다. `next ≈`는 새로 측정한
컨텍스트 사용량이 아닌 추정치입니다. [MP4 보기](media/hide-restore.mp4).

![Hide and restore a tool group with the next-request estimate](media/hide-restore.gif)

<details>
<summary>스크린샷 더 보기: Hide, Preview, 빈 상태</summary>

**Hide 후 선택된 그룹:** 하단에 `next ≈ −3.9K` 토큰을 예상합니다.

![Selected hidden group and its next-request estimate](media/02-hide-estimate.png)

**숨긴 행:** 그룹이 접히고 절약된 컨텍스트 표시가 나타납니다.

![Hidden tool group with its saved-context indicator](media/03-hide-applied.png)

**읽기 전용 Preview:** 전송할 대체문과 원본 입력·출력을 확인합니다.
[원본 출력 상세](media/06-preview-output.png).

![Preview of the model-facing replacement and preserved original](media/04-preview-original.png)

**표시 중인 세션이 없는 경우:** 세션을 열면 outline이 보이는 대화를 따라갑니다.

![Unbound navigator beside a new agent tab](media/05-unbound-empty.png)

</details>

## 주요 기능

- 도구 결과의 Hide / Summarize / Unhide와 SQLite 영속화.
- Paseo Explorer의 **+ → Session navigation**, 보이는 세션 자동 추적과 선택적 고정.
- 원본과 모델에 전달되는 대체문을 나란히 보는 읽기 전용 Preview.
- OMP의 컨텍스트 도구와 `/nav` UI, Hermes의 컨텍스트 도구와 `/nav` 명령.
- 사용자·assistant 메시지의 컨텍스트 제외와 복원. 호스트 원본은 유지합니다.
- `manage_context`를 작업 단위마다 반복 호출하는 에이전트 주도 정리.
- 새 사용자 턴과 컨텍스트 50/75/90% 구간에서 요청 사본 끝에 짧은 후보/ID 안내.
  안내는 기록에 저장하지 않으며 정리 시점·대상·방법은 에이전트가 판단합니다.
- Hide는 규칙으로 주요 대입문·증거를 남기며 `manage_context(action=hide, keep_lines=[...])`로
  보존할 원문 부분을 지정할 수 있습니다. [동작·측정 한계](evaluation/improvements.md).
- 호스트가 제공하는 사용량 표시. 측정값이 없으면 `—`를 표시하며,
  다음 요청의 예상 증감은 실제 사용량과 구분합니다.

## 설치

### 공통 CLI / 데몬: Paseo와 OMP에 필요

Python **3.11 이상**, [uv](https://docs.astral.sh/uv/), Git이 필요합니다.
Paseo **데몬이 실행되는 머신**, OMP가 실행되는 머신에 각각 설치합니다.

```bash
git clone https://github.com/pureliture/session-navigation.git
cd session-navigation
uv tool install .
export PATH="$HOME/.local/bin:$PATH"
session-navigation --help
```

`session-navigation` CLI와 `session-navigation-daemon` 실행 파일이 설치됩니다.
업데이트할 때는 검토한 새 소스를 받은 뒤 `uv tool install --force .`를 사용합니다.
OMP 확장이 데몬을 자식 프로세스로 실행하므로 별도 데몬 서비스를 등록할 필요는 없습니다.
Paseo는 CLI를 호출합니다. 이미 실행 중인 Paseo 데몬에도 같은 PATH와 상태 경로가
전달되도록 환경을 설정하고 재시작하세요.

### Paseo 플러그인

현재 SDK와 런타임 검증 대상은 **Paseo 0.15.3**입니다. manifest의 허용 범위는
`>=0.15.0`이지만, 그보다 낮은 0.15.x 버전의 호환성은 별도 검증하지 않았습니다.
위 Python 패키지를 먼저 설치하세요. 플러그인 패키지에는 Python CLI가 포함되지 않습니다.

소스 체크아웃에서 설치:

```bash
paseo plugin add "$PWD/paseo-plugin"
paseo plugin ls
```

Git 폴더에서 직접 설치할 수 있습니다. 재현 가능한 설치에는 `main` 대신
검증한 커밋이나 릴리스 태그를 지정하세요. 기존 `152f63c` 커밋은 타입 의존성
해석 오류로 깨끗한 Git 설치에 실패합니다.

```bash
paseo plugin add git:pureliture/session-navigation:paseo-plugin --ref main
```

Explorer의 **+ → Session navigation**을 선택하면 보이는 채팅 세션을 추적합니다.
**Follow visible session**을 유지하거나 선택기로 특정 에이전트를 고정할 수 있습니다.
식별할 수 없는 빈 채팅·비세션 화면에서는 **No session in view**를 표시합니다.
**Cmd/Ctrl+K → Open session navigation**과 **/nav**도 사용할 수 있습니다.
패널을 열어 두면 Paseo가 탭 레이아웃을 복원하며, 사용자가 닫은 패널을 강제로 다시 열지는 않습니다.
플러그인 리로드 뒤 이전 페이지가 남아 있으면 페이지 전체를 새로고침하세요.

### OMP(oh-my-pi) 확장

검증 대상은 `@oh-my-pi/pi-coding-agent` **18.18.3**입니다. 위 Python CLI/데몬과
OMP 확장은 **별도로** 설치해야 합니다. 기본 프로필의 자동 로드 경로에 파일을 복사합니다.

```bash
mkdir -p "$HOME/.omp/agent/extensions"
cp extensions/pi/session-navigation.ts "$HOME/.omp/agent/extensions/session-navigation.ts"
```

새 OMP 세션을 시작하세요. 복사 없이 일회성으로 로드할 수도 있습니다.

```bash
omp --extension "$PWD/extensions/pi/session-navigation.ts"
```

이름 있는 프로필은 해당 프로필의 확장 디렉터리를 사용합니다.
기본적으로 `~/.local/bin/session-navigation-daemon`, 없으면 PATH의 실행 파일을 사용합니다.
다른 위치라면 `SESSION_NAVIGATION_DAEMON`에 **실행 파일의 절대 경로**를 지정하세요.
인자가 포함된 셸 명령을 넣는 설정은 아닙니다.

디렉터리 이름은 `extensions/pi/`이지만 확장은 `@oh-my-pi/pi-*` API를 사용합니다.
upstream **pi**와의 호환성은 검증하지 않았으며, pi 패키지로 바로 설치할 수 있다고
보장하지 않습니다. 현재 OMP용 `package.json`도 없어 npm 플러그인 설치 대신 위 파일 로드를 사용합니다.

### Hermes 플러그인

Hermes 소스 커밋 `109fd8161a509db5a00942152ba48882e446e8b0`에서 검증했습니다.
저장소 루트의 `plugin.yaml`, `__init__.py`, `vendor/`가 독립 플러그인을 구성합니다.
Hermes에만 사용할 때는 공통 CLI를 따로 설치하지 않아도 됩니다.

```bash
hermes plugins install pureliture/session-navigation --ref main --no-enable
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

설치와 활성화는 원하는 Hermes 프로필에서 수행하세요. 고정 설치는 `--ref main` 대신
검토한 **40자리 커밋 SHA**를 지정합니다. 호스트의 플러그인 활성화와 플러그인 내부
`settings.enabled`는 별개입니다. 내부 설정은 기본값이 `false`여서, 켜기 전에는
도구가 `disabled`를 반환하고 요청을 기록하거나 바꾸지 않습니다.
설정 후 새 세션을 시작하세요. 실행 중인 gateway가 있다면 해당 호스트의 재시작 안내를 따릅니다.

`vendor/`에는 엔진과 어댑터의 Python 소스가 들어 있습니다.
`python_runtime: external`이므로 Hermes의 공유 환경에 이 저장소의 `pyproject.toml`을
설치하지 않습니다. Python wheel 설치만으로 Hermes 플러그인이 등록되지는 않습니다.

플러그인을 업데이트한 뒤에는 CLI를 다시 여는 것뿐 아니라 실행 중인 **Hermes gateway도 완전히
재시작**해야 합니다. 플러그인 reload는 Python의 전역 `session_navigation` /
`session_navigation_hermes` 모듈 캐시를 비우지 않습니다. 이미 로드된 엔진·어댑터의 소스
fingerprint가 배포된 vendor 사본과 다르면 플러그인은 로드를 거부하고 재시작을 안내합니다.
공유 환경에 설치된 다른 버전도 같은 검사 대상이며, 해당 모듈을 강제로 교체하지 않습니다.
공식 카탈로그 등록 검증은 아직 통과하지 못했습니다. 아래 배포 항목을 참고하세요.

## 사용법

Paseo에서는 행의 Hide / Summarize / Unhide를 사용하고 Preview에서 원본과 대체문을 확인합니다.
OMP의 `/nav`는 대화형 목록을 엽니다. Hermes에서는 다음 명령을 같은 대화에서 사용합니다.

```text
/nav list
/nav messages
/nav hide 1
/nav unhide 1
/nav hide-msg 1
/nav unhide-msg 1
```

번호는 가장 최근 목록의 표시 번호입니다. 자세한 Hermes 번호·복원 규약은
[사용자 감독 가이드](hermes-human-supervision.md)를 참고하세요.

에이전트는 작업 단위를 끝낼 때 이후 단계에 필요 없는 결과를 골라 정리합니다.

```text
list_context_items({view: "candidates", limit: 30})
manage_context({tool_call_ids: ["선택한-id-1", "선택한-id-2"], action: "hide"})
```

- 비어 있지 않은 ID 목록이 필수이며 개수 상한은 없습니다. 세션 전체를 한 번에 요약하는 도구가 아닙니다.
- 후보 목록은 보이는 적격 결과를 최신순으로 보여주는 발견 도구입니다. 목록 밖의 적격 ID도 선택할 수 있습니다.
- `hide`는 규칙 기반, `summarize`는 현재 세션 모델, `auto`는 모델 요약 우선·규칙 대체입니다.
  OMP 모델 호출은 최대 4개 동시 실행하며, 이미 숨겼거나 부적격인 결과는 먼저 제외합니다.
- OMP는 `read` / `bash`, Hermes는 허용된 `terminal` / `read_file` / `search_files` 결과를 관리합니다.
  파괴적 명령은 자동 관리에서 제외됩니다. 세션 모델이 없으면 요약은 `summarizer_unavailable`로 실패합니다.

## 데이터와 안전 경계

- 원본 호스트 기록은 유지하고 요청 사본만 바꿉니다. **Hide는 영구 삭제나 비밀정보 삭제 기능이 아닙니다.**
- 원문·대체문·숨김 상태는 기본적으로 `~/.local/share/session-navigation/state.sqlite3`에 저장됩니다.
  `XDG_DATA_HOME` 또는 `SESSION_NAVIGATION_STATE_PATH`로 위치를 바꿀 수 있습니다.
  여러 프로세스가 같은 상태를 보려면 같은 머신에서 같은 경로를 사용해야 합니다.
- 목록을 만들기 위해 로컬 세션 기록·모델 메타데이터를 읽고, Paseo/OMP는 Python 자식 프로세스를 실행합니다.
  네트워크 동기화나 자체 업데이트·런타임 소프트웨어 다운로드는 제공하지 않습니다.
- 요약은 대상 원문을 **호스트에 설정된 세션 모델 제공자**로 보낼 수 있습니다.
  로컬 SQLite를 사용한다고 모든 데이터가 로컬에만 남는 것은 아닙니다.
- DB 오류 처리에는 호스트 차이가 있습니다. OMP 비대화형 실행은 요청을 중단합니다.
  Hermes는 호스트 미들웨어에 abort 계약이 없어 오류 시 원본 요청이 진행될 수 있으며,
  오류 로그와 목록의 pending 안내로 이를 알립니다. 민감정보 차단 도구로 사용하지 마세요.
- WAL은 SQLite 3.51.3 이상 또는 수정된 3.44.6/3.50.7 계열에서 사용하고, 그 외에는 rollback journal을 사용합니다.

## 구조

| 경로 | 역할 |
| --- | --- |
| `src/session_navigation/` | 호스트 중립 엔진, CLI, SQLite 저장소 |
| `src/session_navigation_omp/` | OMP 확장이 stdio로 호출하는 Python 데몬 |
| `extensions/pi/session-navigation.ts` | OMP 요청 사본 처리, 도구와 UI |
| `paseo-plugin/` | Paseo 클라이언트 패널과 CLI 기반 서버 RPC |
| `adapters/hermes/` | Hermes 도구, 미들웨어, `/nav`, 사용량 footer |
| `plugin.yaml`, `__init__.py`, `vendor/` | Hermes가 직접 로드하는 배포 루트와 고정 소스 사본 |

## 개발과 테스트

```bash
uv sync --frozen --dev
uv run pytest
bun test extensions/pi
cd paseo-plugin
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
```

Python 배포물은 루트에서 `uv build`, Paseo 파일 구성은 `paseo-plugin/`에서
`npm pack --dry-run --ignore-scripts`로 확인합니다. Paseo가 TypeScript를 컴파일하므로
일반 배포에 별도 JS 빌드는 필요하지 않습니다.

`vendor/`를 쓰는 Hermes 배포는 원본과 함께 갱신해야 합니다.
`src/session_navigation/` ↔ `vendor/session_navigation/`,
`adapters/hermes/` ↔ `vendor/session_navigation_hermes/`의 Python 소스 일치를 확인하세요.
Python 패키지는 wheel/sdist가 빌드되지만 PyPI 게시 자동화는 아직 없습니다.

## 배포 / 게시 계획

아래는 **게시자가 수행할 절차**이며 이 저장소가 이미 등록되었다는 뜻이 아닙니다.
릴리스에는 삭제 예정 작업 브랜치가 아닌 병합 후 커밋·태그를 사용하세요.
현재 저장소에는 자동 테스트·릴리스용 GitHub Actions 워크플로가 없습니다.

### Paseo: Git 폴더 또는 npm → 공식 검토 레지스트리

1. 권장 초기 형식은 공개 GitHub 저장소의 `paseo-plugin/` 폴더입니다.
   manifest·TS 진입점·가져오는 소스·아이콘을 포함하고, 게시할 커밋에서
   깨끗한 Git 설치를 검증하세요. `152f63c`의 직접 Git 설치는 타입 의존성 오류로 실패했습니다.
2. 현재 `media: []`이고 플러그인 폴더에는 아이콘만 있습니다. **실제 UI 스크린샷**을
   package 내부에 포함하거나 제출 이슈 또는 PR에 공개 PNG/JPG 등의 URL로 제공해야 합니다.
   기존 스크린샷은 [docs/media](media/)에 있습니다.
3. npm 경로를 택하면 `paseo-plugin/package.json`의 `private: true`를 해제하고,
   게시 권한이 있는 이름/스코프, 릴리스 버전, GitHub `repository`를 설정하세요.
   패키지 내부에 MIT LICENSE도 포함해야 합니다. 현재 dry-run에는 LICENSE가 없습니다.
4. 타입 검사·테스트·`npm pack --dry-run --ignore-scripts` 후 npm 경로에서만
   `npm publish --access public`을 실행합니다. 실제 버전을 테스트 데몬에 설치해 확인하세요.
   호스트 제공 라이브러리는 devDependencies로 유지하며, 새로운 런타임 의존성을 추가하면
   공식 가이드의 lock/shrinkwrap 요건도 적용됩니다.
5. [공식 제출 양식](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)에
   GitHub 폴더 URL+검토할 커밋 또는 npm 패키지+버전을 제출합니다.
   검토·승인 뒤 `paseo plugin add owner/slug`로 설치할 수 있습니다.

요건과 갱신 절차: [Paseo 공식 배포 가이드](https://paseo.sh/docs/plugins/publishing),
[검토 정책](https://github.com/getpaseo/plugins/blob/main/REVIEW.md).
영문 listing은 [OVERVIEW.md](../paseo-plugin/OVERVIEW.md)를 사용합니다.

### OMP: 현재는 TS 파일, 패키지화 후 npm 또는 Git 카탈로그

1. 지금은 위의 단일 `.ts` 파일 복사 또는 `--extension` 로드가 가능한 배포 형식입니다.
   Python 데몬 설치는 계속 별도 전제입니다.
2. npm 배포에는 새 패키지 디렉터리의 `package.json`에 이름·버전과
   `omp.extensions: ["./session-navigation.ts"]`를 선언하고 TS 파일·README·LICENSE를 포함해야 합니다.
   **현재 그 패키지는 없습니다.** 새 패키지에서 `npm pack --dry-run --ignore-scripts`로
   파일을 확인하고 `npm publish --access public`으로 게시하면
   `omp plugin install <package-name>`로 배포할 수 있습니다.
3. OMP의 marketplace는 `.omp-plugin/marketplace.json` 또는
   `.claude-plugin/marketplace.json`을 가진 Git 카탈로그입니다. 패키지 폴더를 가리키는
   항목을 만든 뒤 사용자는 `omp plugin marketplace add <catalog-source>`,
   `omp plugin install <name>@<marketplace>`로 설치합니다. 현재 저장소에는 카탈로그가 없습니다.
   marketplace 항목의 npm source는 아직 설치가 지원되지 않으므로 Git/상대 경로를 사용합니다.
4. npm 플러그인 설치와 Git 카탈로그 설치는 별개 경로입니다. OMP 공식 문서에서
   단일 중앙 마켓의 의무 심사 절차는 확인하지 못했습니다.
   upstream pi 배포는 API 호환성 검증을 먼저 해야 합니다.
5. upstream pi용으로 검증한 별도 패키지는 `pi.extensions`와
   `keywords: ["pi-package"]`를 선언해 npm에 게시할 수 있습니다.
   이 키워드가 공식 [Pi package gallery](https://pi.dev/packages)의 검색 대상 조건이며,
   사용자는 `pi install npm:<package-name>@<version>`으로 설치합니다.
   현재 OMP 확장에 이 호환성이나 배포 형식이 갖춰져 있다는 뜻은 아닙니다.

공식 근거: [확장 작성/manifest](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md),
[플러그인 설치](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md),
[marketplace 형식](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md).
upstream pi의 별도 [패키지 문서](https://pi.dev/docs/latest/packages)는 OMP 호환성 보장이 아닙니다.

### Hermes: 저장소 루트 → SHA 고정 공식 카탈로그

1. 공개 저장소 루트를 배포 단위로 사용합니다. 별도 npm 패키지나 Python wheel을
   Hermes 레지스트리에 올리는 방식이 아닙니다.
2. **현재 등록 차단:** `plugin.yaml`에 실제로 등록하는
   `provides_hooks: [post_api_request]`, `provides_middleware: [llm_request]` 선언이 없어
   `hermes plugins validate .`가 실패합니다. manifest 수정은 아직 하지 않았습니다.
   private core import 경고도 검토가 필요합니다.
3. 선언과 지원 버전 정보를 정리하고, 릴리스 커밋에서 공식 검증 절차인
   `hermes plugins validate /path/to/session-navigation --install-deps`를 통과시킵니다.
   이번 확인은 의존성을 설치하지 않는 기본 validate만 실행했습니다.
4. `NousResearch/hermes-agent`에 `plugin-catalog/session-navigation.yaml`을 추가하는 PR을 엽니다.
   공개 repo URL, **40자리 SHA**, 설명·유지관리자·실제 도구/훅/미들웨어 capabilities를 선언합니다.
   `requires_hermes`를 선언한다면 검증한 실제 SemVer 범위를 manifest와 일치시키세요.
5. 카탈로그 CI와 유지관리자 검토·병합 후 `hermes plugins install session-navigation`으로
   설치합니다. 업데이트도 새 SHA를 고정하는 PR과 `hermes plugins update session-navigation`을 거칩니다.

공식 근거: [카탈로그 정책·entry schema](https://github.com/NousResearch/hermes-agent/blob/main/plugin-catalog/README.md),
[제출 절차](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/catalog-submission.md),
[플러그인 API/의존성](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/index.md).

## Evaluation

평가 방법과 요약은 공개하지만, 실행 원본은 접근 권한이 필요한 프라이빗
`eval/results/` submodule에 보관합니다. 일반 설치와 테스트에는 필요하지 않습니다.
원본 접근 및 새 실행 결과 저장 방법은 [평가 실행 안내](../eval/README.md)를 참고하세요.

**Less context, without deleting history—not a claim of smarter answers.**

- Tool results accounted for roughly **70–81% of outgoing prompt tokens** in our
  captured runs. For external context, JetBrains/TUM reports approximately
  [84% observation tokens](https://kairos.jetbrains.com/research/articles/the-complexity-trap)
  in its SWE-agent sample; the populations differ. [Measurement details](evaluation/context-share.md).
- **v4:** the plugin removed **53–66% of final-request tool-result tokens** without
  measured task-quality loss: **4/4 in every host/arm group**, on both final-only
  and visible-unit checks. [Results and limitations](evaluation/results-v3.md).
- **Synthetic focus replay:** rule-hidden histories used approximately **97–98%
  fewer prompt tokens**, with no statistically significant accuracy difference:
  short **15/15 vs 15/15**, long **14/15 Hide vs 15/15 RAW** (five seeds).
  The one miss attempted recovery instead of answering. Hidden-only details were
  **0/30 without recovery**; they must be unhidden to become available again.
  [Full results, paired statistics and caveats](evaluation/results-focus.md).
- **Live OMP, no native compaction:** **3/3 vs 3/3**, with **54% fewer aggregate
  B prompt tokens**. This small autonomous comparison is **not causal**; only two
  of three B sessions actually cleaned. [Live results](evaluation/results-focus.md#part-b-live-omp-native-compaction-disabled).

Originals remain preserved. Rule Hide retains key lines, Unhide restores originals
without re-executing tools, and user-visible controls/preview span **OMP, Hermes
and Paseo**. Retention is not complete recall: inspect or recover details as needed.

We do **not** claim improved accuracy or guaranteed cost savings. Observed OMP
DeepSeek cost differences ranged from **+77% in v2 to −7% in v4**. Every edit
invalidates the prompt-cache prefix from its first changed position onward;
batching can mitigate, not eliminate, that overhead. [v2 failures/costs](evaluation/results-v2.md)
· [v4 costs](evaluation/results-v3.md) · [reproduction harness](../eval/README.md)
· [earlier v1 results](evaluation/results.md)

## 기여

버그 제보에는 호스트/버전, 재현 절차, 기대 동작, 민감정보를 지운 로그를 포함해 주세요.
코드 PR에는 관련 테스트를 추가하고 Python 어댑터 변경 시 vendor 사본도 동기화하세요.
다른 호스트의 원본 기록을 변경하거나 영구 삭제하는 기능은 프로젝트의 안전 경계 밖입니다.
UI 스크린샷 기여는 샘플 데이터만 사용하고, 공개해도 되는 이미지인지 확인해 주세요.
샘플 데이터의 UI 스크린샷은 [내비게이터 사용성 평가](evaluation/navigator-usability.md)에 포함되어 있습니다.

## 라이선스

[MIT](../LICENSE). 호스트 프로젝트와 의존성은 각 프로젝트의 라이선스를 따릅니다.
