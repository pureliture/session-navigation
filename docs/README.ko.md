<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&amp;color=0:38bdf8,50:2563eb,100:312e81&amp;height=220&amp;section=header&amp;text=Session%20Navigation&amp;fontSize=52&amp;fontColor=ffffff&amp;animation=fadeIn&amp;fontAlignY=40" alt="Session Navigation" width="100%" />

<h3>긴 AI 에이전트 세션을 탐색하고,<br/>필요한 컨텍스트를 숨기고 다시 복원하는 도구</h3>

<p>
  <img src="https://img.shields.io/badge/Paseo-0.15.3-2563eb?style=for-the-badge" alt="검증한 Paseo 버전: 0.15.3" />
  <img src="https://img.shields.io/badge/Node-22.13%2B-0e7490?style=for-the-badge&amp;logo=node.js&amp;logoColor=white" alt="Paseo용 Node 22.13 이상" />
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
- OMP의 컨텍스트 도구와 `/session-navigation` UI, Hermes의 컨텍스트 도구와 `/nav` 명령.
- 사용자·assistant 메시지의 컨텍스트 제외와 복원. 호스트 원본은 유지합니다.
- `manage_context`를 작업 단위마다 반복 호출하는 에이전트 주도 정리.
- 새 사용자 턴과 컨텍스트 50/75/90% 구간에서 요청 사본 끝에 짧은 후보/ID 안내.
  안내는 기록에 저장하지 않으며 정리 시점·대상·방법은 에이전트가 판단합니다.
- Hide는 규칙으로 주요 대입문·증거를 남기며 `manage_context(action=hide, keep_lines=[...])`로
  보존할 원문 부분을 지정할 수 있습니다. [동작·측정 한계](evaluation/improvements.md).
- 호스트가 제공하는 사용량 표시. 측정값이 없으면 `—`를 표시하며,
  다음 요청의 예상 증감은 실제 사용량과 구분합니다.

## 설치

Paseo와 OMP는 번들에 포함된 **공통 TypeScript 엔진**을 사용하므로 Python이 필요하지 않습니다.
Hermes는 **Python 엔진과 어댑터를 포함한 Python 플러그인**을 사용합니다.
이전 독립 CLI/데몬 실행 파일은 폐기됐으며 새 설치에는 공통 CLI를 설치하지 않습니다.

### Paseo 플러그인만 설치

SDK와 실제 검증 대상은 **Paseo 0.15.3**이며 manifest는 `>=0.15.3`을 요구합니다.
다른 버전은 별도로 검증하지 않았습니다. 데몬의 Node는 **22.13 이상**이어야 합니다.
22.13에서는 Worker 빌드·테스트를 확인했지만 전체 데몬/UI acceptance는 검증하지 않았습니다.
내장 TypeScript Worker를 사용하므로 Python은 필요하지 않습니다.

Paseo 설정 최상위에 `pluginsEnabled: true`를 지정하고 데몬을 재시작하세요.
npm 게시와 레지스트리 승인 이후의 표준 설치는 다음과 같습니다.

```bash
paseo plugin add pureliture/session-navigation
```

레지스트리 승인 전에는 게시된 npm 버전을 직접 지정합니다.

```bash
paseo plugin add npm:@pureliture/session-navigation-paseo@0.1.0
```

이 문서는 게시·승인이 완료됐다는 뜻이 아닙니다. npm 게시 전에는 검토한 SHA로 Git 폴더를
설치하거나 소스 체크아웃을 사용하세요. UI의 기존 상태를 보존하기 위해 내부 ID는
`paseo-plugin`으로 유지합니다. Hide/Summarize에는 세션 호스트의 어댑터가 필요합니다.

```bash
paseo plugin add git:pureliture/session-navigation:paseo-plugin --ref <REVIEWED_SHA>
paseo plugin ls
```

Explorer의 **+ → Session navigation**을 선택하고 **Follow visible session**으로 현재 대화를
따라가거나 선택기로 에이전트를 고정합니다. 비어 있거나 일치하지 않는 화면, 세션이 아닌 화면에는
**No session in view**를 표시합니다. **Cmd/Ctrl+K → Open session navigation**, **/nav**도
사용할 수 있습니다. 닫은 패널은 강제로 다시 열지 않으며 열려 있던 배치는 Paseo가 복원합니다.
갱신 뒤 이전 화면이 남으면 페이지 전체를 새로고침하세요.

### OMP(oh-my-pi) npm 패키지 확장

`@oh-my-pi/pi-coding-agent` **18.18.3**, Bun **1.4.4**에서 검증했습니다.
Bun 최소 요구 버전은 검증된 최저 버전인 **1.4.4**입니다. npm 게시 후:

```bash
omp plugin install @pureliture/session-navigation-omp@0.1.0
```

게시 전 개발 설치는 `bun run packages/omp/build.ts` 후
`omp plugin install "$PWD/packages/omp"`로 합니다. OMP 18.18.3은 로컬 tarball을
직접 받지 않습니다. 패킹한 `pureliture-session-navigation-omp-0.1.0.tgz`는
해당 프로필의 `~/.omp/plugins`에서 `bun add /absolute/path/to/pureliture-session-navigation-omp-0.1.0.tgz`로
설치하고 OMP를 재시작하세요. Python과 별도 core 게시물은 필요하지 않습니다.

이전 Python-spawning 사본인 **`~/.omp/agent/extensions/session-navigation.ts`를 모든 해당
프로필에서 제거하거나 비활성화**하세요. 예전 사본은 새 중복 로딩 guard에 참여할 수 없습니다.
저장소의 `extensions/pi/session-navigation.ts`는 개발용 상대 경로 shim이므로 autoload
디렉터리에 복사하지 마세요. `SESSION_NAVIGATION_DAEMON` 환경변수는 더 이상 사용하지 않습니다.
[OMP 패키지 안내](../packages/omp/README.md)에서 설치·상태 이관·검사를 확인하세요.
upstream **pi**와의 호환성은 검증하지 않았습니다.

### Hermes Python 플러그인

최소 요구 버전은 **Hermes >=0.20.1**입니다(API 제공 시점 기준이며 해당 구버전의 live acceptance는 별도 검증하지 않았습니다).
카탈로그 승인 후에는 `hermes plugins install session-navigation`으로 설치합니다.
승인 전에는 아래 Git 설치를 사용하세요. wheel 설치만으로 호스트에 등록되지는 않습니다.

실제 ACP 검증에는 Hermes 소스 `cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`을,
이전 플러그인 검사에는 `109fd8161a509db5a00942152ba48882e446e8b0`을 사용했습니다.
루트 `plugin.yaml`, `__init__.py`, `vendor/`가 독립 플러그인입니다.
Python은 Hermes 자체 관리 런타임으로 제공하며 공통 CLI 설치는 필요하지 않습니다.

```bash
hermes plugins install pureliture/session-navigation --ref main --no-enable
hermes plugins enable session-navigation
hermes config set plugins.entries.session-navigation.settings.enabled true
```

원하는 Hermes 프로필에서 설치·활성화하세요. 고정 설치에는 `--ref main` 대신 검토한
**40자리 커밋 SHA**를 사용합니다. 호스트 활성화와 내부 `settings.enabled`는 별개입니다.
내부 설정은 기본 `false`이며 비활성 상태에서는 도구가 `disabled`를 반환하고 요청을 기록하거나
변경하지 않습니다. 설정 후 새 세션을 시작하세요.

`vendor/`는 Python 엔진과 어댑터 소스 사본입니다. `python_runtime: external`은
루트 `pyproject.toml`을 Hermes 공유 환경에 설치하지 않습니다.
Python wheel만 설치해서는 Hermes 플러그인이 등록되지 않습니다.
업데이트 후 CLI와 **Hermes gateway를 완전히 재시작**해야 합니다. 단순 plugin reload는
Python 모듈 캐시를 비우지 않습니다. 로드된 소스와 vendor의 fingerprint가 다르면 플러그인은
로드를 거부하며 재시작을 요청하고 다른 설치본을 강제로 덮어쓰지 않습니다.
공식 카탈로그 검증은 아직 완료되지 않았습니다.

### 업그레이드 / 마이그레이션

1. 관련 세션을 중지하고 기존 SQLite DB를 백업하세요. `SESSION_NAVIGATION_STATE_PATH`
   또는 기본/XDG 경로를 유지하고 DB나 호스트 원본 기록을 삭제하지 마세요.
2. 수동 복사 OMP 확장을 모든 관련 프로필에서 제거하고 npm 형식 패키지로 교체합니다.
   Paseo 플러그인을 갱신하고 OMP/Paseo를 재시작합니다. 이전 데몬 경로 override도 제거하세요.
3. 이전 독립 tool 설치가 있다면 다음 명령으로 제거합니다. 새 설치의 필수 명령은 아닙니다.
   ```bash
   uv tool uninstall session-navigation
   ```
   해당 uv tool 설치에 포함된 기존 `session-navigation` CLI와
   `session-navigation-daemon` 데몬 실행 파일이 모두 제거됩니다.
   이 명령은 Hermes 플러그인의 설치·활성화를 대신하지 않습니다.
4. Python 플러그인을 갱신한 Hermes와 gateway를 완전히 재시작합니다.
   OMP는 비어 있는 `omp:` scope에 legacy `pi:` 상태를 최초 한 번 복사하고 원본 행을 보존합니다.
   이후 쓰기는 역방향 동기화하지 않습니다. item ID는 scope별이므로 다시 목록을 조회하세요.
   이전 Python-spawning 확장과 새 패키지를 함께 실행하지 마세요.

## 사용법

Paseo에서는 행의 Hide / Summarize / Unhide를 사용하고 Preview에서 원본과 대체문을 확인합니다.
OMP의 `/session-navigation`는 대화형 목록을 엽니다. Hermes에서는 다음 명령을 같은 대화에서 사용합니다.

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
- 목록을 만들기 위해 로컬 세션 기록·모델 메타데이터를 읽습니다. Paseo는 내장 Node Worker,
  OMP는 Bun Worker에서 공통 TS 코어를 실행하며 Python 자식 프로세스를 실행하지 않습니다.
  네트워크 동기화나 자체 업데이트·런타임 소프트웨어 다운로드는 제공하지 않습니다.
- 요약은 대상 원문을 **호스트에 설정된 세션 모델 제공자**로 보낼 수 있습니다.
  로컬 SQLite를 사용한다고 모든 데이터가 로컬에만 남는 것은 아닙니다.
- DB 오류 처리에는 호스트 차이가 있습니다. OMP 비대화형 실행은 요청을 중단합니다.
  Hermes는 호스트 미들웨어에 abort 계약이 없어 오류 시 원본 요청이 진행될 수 있으며,
  오류 로그와 목록의 pending 안내로 이를 알립니다. 민감정보 차단 도구로 사용하지 마세요.
- WAL은 SQLite 3.51.3 이상 또는 수정된 3.44.6/3.50.7 계열에서 사용하고, 그 외에는 rollback journal을 사용합니다.

### Subagent 지원

| 제공자 | Paseo outline 및 조작 |
| --- | --- |
| Paseo의 OMP | 자식 탭을 따라가며 부모 task 아래에서도 자식 outline을 펼칠 수 있습니다. Hide/Unhide/Summarize는 자식별 scope와 capability를 사용합니다. **Open tab**으로 네이티브 자식 탭을 열거나 선택합니다. |
| ACP의 Hermes | `delegate_task` 아래에서 자식 outline을 펼쳐 Hide/Unhide/Summarize를 사용합니다. 네이티브 자식 탭은 없으며 자식 행 선택은 강조만 합니다. |
| OpenCode Go 등 기타 제공자, 미등록 자식 | 읽기 전용 main outline과 **subagent context is not managed** 안내를 표시합니다. 행을 선택하면 main agent를 열고 해당 위치로 이동합니다. |

자식 탭 식별·열기는 `client/hostCompat.ts`에 격리된 **Paseo 0.15.3 UI 내부 구조**에
의존합니다. 확인되지 않은 호스트 버전, 모호하거나 잘못된 탭 정보, 미등록 자식은 안전한
fallback으로 전환합니다. 버전 메타데이터가 없으면 엄격한 DOM 구조 검사를 적용합니다.
0.15.3의 공개 SDK에는 자식 탭 식별 API가 없습니다. 탭 열기가 실패해도 inline outline은
계속 사용할 수 있습니다. 자식은 별도 상태를 사용하며 기본적으로 navigation 도구·지침·
reminder를 받지 않습니다. [백엔드 검증 근거](subagent-backend-verification.md)를 참고하세요.

## 구조

| 경로 | 역할 |
| --- | --- |
| `src/session_navigation/` | Hermes용 Python 엔진과 SQLite 저장소 |
| `packages/core/` | 공통 TS 엔진과 Node/Bun SQLite 드라이버 |
| `packages/omp/` | 번들 OMP 확장·Worker·도구·UI |
| `extensions/pi/session-navigation.ts` | 개발용 legacy shim |
| `paseo-plugin/` | Paseo 패널·capability-gated RPC·내장 Node Worker |
| `adapters/hermes/` | Hermes 도구, 미들웨어, `/nav`, 사용량 footer |
| `plugin.yaml`, `__init__.py`, `vendor/` | Hermes가 직접 로드하는 배포 루트와 고정 소스 사본 |

## 개발과 테스트

```bash
uv sync --frozen --dev
uv run pytest
bun run packages/omp/build.ts
bun test packages/omp/test
cd paseo-plugin
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
```

Python 배포물은 루트에서 `uv build`, Paseo 파일 구성은 `paseo-plugin/`에서
`npm pack --dry-run --ignore-scripts`로 확인합니다. 코어/Worker/service를 변경하면
`paseo-plugin/`에서 `npm run build`를 실행하고 생성된 `server/worker-source.ts`를 커밋하세요.

`vendor/`를 쓰는 Hermes 배포는 원본과 함께 갱신해야 합니다.
`src/session_navigation/` ↔ `vendor/session_navigation/`,
`adapters/hermes/` ↔ `vendor/session_navigation_hermes/`의 Python 소스 일치를 확인하세요.
`__pycache__`를 제거한 뒤 `diff -ru`로 비교하세요.
Python 패키지는 wheel/sdist가 빌드되지만 PyPI 게시 자동화는 아직 없습니다.

## 배포 / 게시 계획

세 호스트의 준비 버전은 **0.1.0**입니다. 아래 경로는 게시·승인 완료를 주장하지 않습니다.

- **OMP:** npm `@pureliture/session-navigation-omp@0.1.0`.
- **Paseo:** npm `@pureliture/session-navigation-paseo@0.1.0` 게시 후 검토 레지스트리
  `pureliture/session-navigation`으로 제출합니다. MIT LICENSE와 내장 Worker가 tarball에 포함됩니다.
- **Hermes:** 저장소 루트를 공식 카탈로그에 **40자리 SHA**로 고정합니다.
  다섯 도구, `post_api_request`/`subagent_start` 훅,
  `llm_request`/`tool_request` 미들웨어 및 `>=0.20.1`을 선언합니다.
  의존성 준비를 포함한 validate는 통과하지만 유지한 private import 경고는 심사가 필요합니다.

명시적 Summarize는 기존 rule Hide를 LLM 요약으로 업그레이드합니다.
승인된 기존 LLM 요약은 재호출 없이 반환합니다. 사실 검증 실패에는 영어 피드백으로
한 번만 재시도하며 두 호출 모두 사용량에 포함합니다. 최종 실패는 명시적 오류를 반환하고
기존 Hide를 유지합니다. Unhide는 도구 재실행 없이 정확한 원문을 복원합니다.

실행 순서와 게시 명령은 [릴리스 체크리스트](release/checklist.md),
[Paseo 제출 초안](release/paseo-submission.md), [Hermes 항목](release/hermes-catalog.yaml),
[Hermes 심사 설명](release/hermes-pr-body.md), [Hermes 설치 안내](hermes-plugin.md)를 보세요.
Paseo 제출에는 현재 UI 이미지가 필요합니다. 기존 `docs/media` 이미지는 심사 전에 최신 동작과
대조해야 합니다. core 패키지는 비공개/번들 전용입니다. 자동 게시 워크플로는 없습니다.
upstream pi 호환성은 검증하지 않았습니다.

## 평가

평가 방법과 요약은 공개하지만 원본 자료는 접근 권한이 필요한 프라이빗 `eval/results/`
submodule에 보관합니다. 일반 설치·테스트에는 필요하지 않습니다.
[평가 실행 안내](../eval/README.md)에서 원본 접근과 저장 방법을 확인하세요.

**기록 삭제 없이 컨텍스트를 줄이는 기능이며, 더 똑똑한 답변을 보장하지 않습니다.**

- 캡처한 실행에서 도구 결과는 outgoing prompt 토큰의 약 **70–81%**였습니다.
  JetBrains/TUM의 별도 SWE-agent 표본은 약
  [84% observation 토큰](https://kairos.jetbrains.com/research/articles/the-complexity-trap)을
  보고하지만 모집단이 다릅니다. [측정 방법](evaluation/context-share.md).
- **v4:** 마지막 요청의 도구 결과 토큰을 **53–66%** 줄였고, 최종 답변/표시 작업 단위
  검사 모두 각 host/arm 그룹이 **4/4**로 측정상 품질 저하는 없었습니다.
  [결과와 한계](evaluation/results-v3.md).
- **합성 focus replay:** prompt 토큰은 약 **97–98%** 줄었으며 정확도 차이는 통계적으로
  유의하지 않았습니다. 5개 seed에서 짧은 조건 **15/15 대 15/15**, 긴 조건
  **Hide 14/15 대 RAW 15/15**였습니다. 한 실패는 답변 대신 복원을 시도했습니다.
  숨김으로만 남은 세부사항은 복원 없이 **0/30**이므로 필요하면 Unhide해야 합니다.
  [전체 결과와 통계](evaluation/results-focus.md).
- **실제 OMP, native compaction 없음:** **3/3 대 3/3**, B의 총 prompt 토큰은
  **54% 감소**했습니다. 작은 자율 실행 비교는 **인과적 근거가 아니며** B 세션 중
  2개만 실제 정리했습니다. [실제 결과](evaluation/results-focus.md#part-b-live-omp-native-compaction-disabled).

원본은 보존하며 규칙 Hide는 핵심 행을 남깁니다. Unhide는 도구 재실행 없이 원본을 복원합니다.
OMP·Hermes·Paseo에서 사용자 제어/Preview를 제공하지만 정보 보존이 완전한 회상을 뜻하지는 않습니다.

정확도 향상이나 비용 절감을 **보장하지 않습니다**. OMP DeepSeek 비용 차이는
**v2 +77%에서 v4 −7%**였으며 첫 변경 위치 이후 prompt-cache prefix는 무효화됩니다.
일괄 정리는 이 비용을 완화할 수 있지만 없애지는 않습니다.
[v2 실패/비용](evaluation/results-v2.md) · [v4 비용](evaluation/results-v3.md) ·
[재현 도구](../eval/README.md) · [이전 v1](evaluation/results.md).

## 기여

버그 제보에는 호스트/버전, 재현 절차, 기대 동작, 민감정보를 지운 로그를 포함해 주세요.
코드 PR에는 관련 테스트를 추가하고 Python 어댑터 변경 시 vendor 사본도 동기화하세요.
다른 호스트의 원본 기록을 변경하거나 영구 삭제하는 기능은 프로젝트의 안전 경계 밖입니다.
UI 스크린샷 기여는 샘플 데이터만 사용하고, 공개해도 되는 이미지인지 확인해 주세요.
샘플 데이터의 UI 스크린샷은 [내비게이터 사용성 평가](evaluation/navigator-usability.md)에 포함되어 있습니다.

## 라이선스

[MIT](../LICENSE). 호스트 프로젝트와 의존성은 각 프로젝트의 라이선스를 따릅니다.
