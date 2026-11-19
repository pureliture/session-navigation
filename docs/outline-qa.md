# 아웃라인 QA 체크리스트 · 증상→커밋 추적표

Session navigation **아웃라인 본체**의 수동 검증을 재현 가능하게 고정한 문서.
작성 시점 2026-11-19, 브랜치 `fix/subagent-code-review-fixes` (PR #32, 머지 금지).

검증 규칙: 코드 인용은 `git log`(커밋 메시지·diff)와 현재 워킹트리 파일 내용으로만 확인했다.
저장소에서 확인할 수 없는 값은 `[UNVERIFIED]`로 표시하고, 필요 계측을 함께 적는다.

## 1. 범위와 기존 문서와의 관계

- **본 문서 = 아웃라인 본체 QA.** 세션 목록/아웃라인 행의 클릭 이동, 상단 older 페이징,
  display:none 리텐션, 헤더 ↻ 리프레시, 실시간 추적을 다룬다.
- [`docs/subagent-panel-verification.md`](subagent-panel-verification.md) = **서브에이전트 전용**
  (Step 6c). Paseo 패널의 자식 아웃라인, 부모-자식 링크, inline 확장, Hide/Unhide 같은
  자식 스코프 동작을 검증한다. 자식 세션의 바인딩/스코프/오프너 문제는 그 문서로 분류하고,
  여기서는 다루지 않는다.
- [`docs/spec.md`](spec.md) D10·Outline rows가 UI 배치/행 정책의 기준이며,
  [`docs/README.ko.md`](README.ko.md)가 사용자용 진입 경로 기준이다.

## 2. 자동화 인터페이스

자동 셀은 `tools/outline-smoke/run.py --scenario {a,b,c,d,all}`을 가리킨다.
진입점 계약(`run.py --help`, `seed.py --help`에서 확인):
`run.py --url <Paseo UI/relay> --out <dir> --scenario all
[--hermes-agent/--omp-agent/--hermes-title/--omp-title/--hermes-workspace/--omp-workspace/--server-id/--paseo-host/--paseo-home]`.
판정·수치·스크린샷은 out dir의 `results.json`·`<scenario>.png`에 저장, 전체 pass 시 exit 0.
`seed.py --root /tmp/paseo-sandbox [--reset]`이 격리 데몬+DB를 멱등 구성하고
`PASEO_WEB_UI_URL`·`PASEO_WORKSPACE_URL`·`PASEO_SERVER_ID`·`AGENTS`를 출력한다.
CDP 19322는 단일 실행(하네스+시드 검증 동시 사용 금지).

| 시나리오 | 트리거 (run.py 구현 기준) |
| --- | --- |
| `a` | Hermes long 행 클릭 이동: `call_00_sfrmago9exbschabupzaix7x` 행 클릭 → Preview `display_hermes_298396` 확인 + 목표 MID(`agent_tool_turn:2f95300a-…/call_00_sfrmago9…`) 마운트·가시 + `Not loaded in chat` 정확 일치 노드 부재 (60초 대기) |
| `b` | OMP long 행 클릭 이동: `우선 커밋하고 PR생성해줘`(`msg_1794996946726_975decyxg`) 클릭 → 목표 MID 마운트·가시 + 노티스 부재 |
| `c` | 상단 prepend 2라운드: 상향 휠 시퀀스 → scrollHeight 2회 증가 + 첫 툴그룹 2회 교체 + top 0 고착 금지 |
| `d` | display:none 사이클: 조상 숨김→복원 후 collapse 전 scrollTop 유지(±50px) + `Loading older` 미발동 + `scrollTo` 미호출 |

수동 셀은 아래 5절 절차를 그대로 따른다. 자동과 수동을 함께 적은 셀은 자동으로 1차
회귀를 돌리고, 실화면 판정(노티스 노드·하이라이트·패널 배치)은 수동으로 확인한다.

## 3. 세션 종류 × 트리거 매트릭스

세션 식별자는 실세션 라벨이다 (`paseo ls`, `paseo logs -o json`, 실DB read-only 조회,
CDP 실화면 DOM 덤프로 확인). 기대 결과의 수치·ID는 아래 4절·5절 근거와 동일 출처다.

| 세션 종류 | 트리거 | 기대 결과 | 검증 방식 |
| --- | --- | --- | --- |
| OMP 신규 | 행 클릭 이동 | 대상 메시지가 하이라이트되고 스크롤이 이동; `Not loaded in chat` 노드 없음 | 수동 5.5·5.6 (하네스 미커버) |
| OMP 신규 | 상단 prepend / display:none | 더 이상 older 항목이 없으면 no-op; 숨김/복원 후 scrollTop 유지 | 수동 5.4 (하네스 미커버) |
| OMP 신규 | 헤더 ↻ 리프레시 | `list`/`scopes`/`usage`/`timeline` 무효화, 선택·하이라이트·프리뷰 초기화, older 로딩 중 비활성 | 수동 (하네스 미커버) |
| OMP 신규 | 실시간 추적 | Follow visible session으로 새 세션을 따라가고, 식별 불가 화면은 `No session in view` | 수동 5.2·5.3 (하네스 미커버) |
| OMP long (`5c4bc793`) | 행 클릭 이동 | `msg_1794996946726_975decyxg` 클릭 → MID 마운트·가시 + 노티스 부재 | 자동(b) + 수동 |
| OMP long (`5c4bc793`) | 상단 prepend / display:none | 상향 휠 2라운드 prepend + 숨김/복원 scrollTop 유지(실데몬·샌드박스 공통) | 자동(c/d) + 수동 터치/트랙패드 제스처 |
| OMP long (`5c4bc793`) | 헤더 ↻ 리프레시 | older 로딩 중 disabled, 완료 후 재-enabled; 스피너는 `…`, 평시 `↻` | 수동 (하네스 미커버) |
| OMP long (`5c4bc793`) | 실시간 추적 | 새 꼬리 항목이 붙을 때 하단 stick(48px) 유지, 1.5s settle 후 자동 스크롤 | 수동 (하네스 미커버) |
| Hermes long (`aa0c9d63`) | 행 클릭 이동 | `call_00_sfrmago9…` 클릭 → Preview `display_hermes_298396` + 목표 MID 마운트·가시 + 노티스 부재 | 자동(a) + 수동 |
| Hermes long (`aa0c9d63`) | 상단 prepend / display:none | `timeline_index`가 낮은 서버 행이 merged tail 뒤가 아니라 앞에 prepend됨 + 숨김/복원 유지 | 자동(c/d) + 수동 |
| Hermes long (`aa0c9d63`) | 헤더 ↻ 리프레시 | `paseo-agent-timeline` 포함 4개 query key 무효화, fallback 커서 초기화 | 수동 (하네스 미커버) |
| Hermes long (`aa0c9d63`) | 실시간 추적 | adapter 일시정지 후 hidden context가 보존된 상태로 추적 재개 | 수동 (하네스 미커버) |
| 현재 활성 (`6af7f488`) | 행 클릭 이동 | 활성 세션 행 클릭 즉시 이동, 이전 실패 노티스는 onStart에서 즉시 클리어 | 수동 5.5·5.6 (하네스 미커버) |
| 현재 활성 (`6af7f488`) | 상단 prepend / display:none | 다른 탭 전환으로 패널이 display:none이 된 뒤 복원해도 점프 없이 scrollTop 복원 | 수동 5.2·5.4 + 자동(d) 패턴 참조 |
| 현재 활성 (`6af7f488`) | 헤더 ↻ 리프레시 | ↻는 `openAgent`가 아니라 명시적 refetch; 탭이 이미 열려 있어도 무반응 아님 | 수동 (하네스 미커버) |
| 현재 활성 (`6af7f488`) | 실시간 추적 | 보이는 세션 변경을 1.5s 간격 DOM/타임라인 ID 매칭으로 반영 | 수동 (하네스 미커버) |

## 4. 증상 → 커밋 추적표

모든 해시·파일·테스트명은 `git show`로 확인했다. "실화면 수치" 열은 코드/테스트 픽스처에서
확인한 값과 실측이 필요한 값을 구분한다. 실측값이 저장소에 없으면 `[UNVERIFIED]`다.

| 증상 | 원인 메커니즘 (2줄 이내) | 수정 파일 | 회귀 테스트명 | 증거 수치 |
| --- | --- | --- | --- | --- |
| 긴 세션에서 상단으로 스크롤해도 older 페이지가 정지 | 터치/트랙패드는 wheel·drag 없이 `onScroll`만 내보내 `recordScroll`이 `userScrolledUp`을 arm하지 못했고, `stuck=true, up=false, prevTop<=160` 게이트가 로드를 버림. Hermes fallback도 unmatched older 행을 tail에 append해 prepend가 안 보임. | `paseo-plugin/client/outlineScroll.ts`, `outlineScroll.test.ts`, `fallbackTimeline.ts`, `fallbackTimeline.test.ts` | `touch upward scroll without wheel events still arms upward intent (long-session top-drag must load older rows)`, `trackpad upward scroll without explicit drag start still arms upward intent`, `mergeHermesTimelineRows keeps unmatched older server rows ahead of the merged tail` | 코드 고정: 상향 임계 **24px**, prepend 임계 **160px**, bottom stick **48px**; 테스트 `scrollTop 4000→3000→1000→100`, merge `timeline_index 5 / 700 / 9000 / 9001`. 실화면 스크롤px·로드 횟수 `[UNVERIFIED]`. |
| 렌더드 챗 행 클릭이 `Not loaded in chat`로 실패 | 합성 ID(`agent_tool_turn:<turn>/<callId>` 등)에서 raw ID를 못 뽑고, 4자 니들 `수정 결과`가 마운트 윈도우를 오바인딩해 seek 방향을 꼬리로 뒤집음. 스윕 반전 + 중첩 ROW 중복이 겹쳐 타깃을 놓침. | `paseo-plugin/client/chatNavigation.ts`, `chatNavigation.test.ts` | `identityMatches extracts raw ids from rendered composite chat ids (beautiful-chat turn/call nesting)`, `short (<=8 char) text needles never establish the mounted window (seek direction poison)`, `nested rendered rows (parent + child share text) dedupe to a unique match despite faulty anchors`, `long pre-compression seek survives slow older-history pagination (rendered chat, unmounted target)` | 코드 고정: 니들 최소 **9자**(<=8자 거부), 꼬리 경계 `extent-4`, 상단 경계 `<=4`, 무진행 컷오프 최대 **15s**, 테스트 **800행 / 5페이지 × 3s / timeline_index 753**. 오케스트레이터 전달 `mounted=[669]`는 저장소에 기록 없음 `[UNVERIFIED]`. |
| 헤더 ⤢가 무반응 | `navigation.openAgent`가 세션 탭이 이미 열려 있으면 silent no-op여서 고장처럼 보임. 정직한 탈출구로 ↻ 리프레시를 넣고 list/scopes/usage/timeline을 무효화. | `paseo-plugin/client/outlineRefresh.ts` (신규), `sessionNavPanel.tsx`, `sessionNavPanelRefresh.test.ts` (신규) | `manual outline refresh covers list, scopes, usage, and fallback timeline` | 코드 고정: 무효화 **4개** query key, disabled 조건 `isRefreshing || isLoadingOlder`, 노티스 자동 소멸 **4s** (summarize는 6s). 실화면 클릭→반영 지연 `[UNVERIFIED]`. |
| 아무 조작 없이 최상단으로 점프 | Paseo가 비활성 패널을 `display:none`으로 유지하면 Chromium이 `scrollTop`을 0으로 만들고 합성 `onScroll(top=0)`이 상향 의도를 arm해 older 자동 로드가 발생. | `paseo-plugin/client/outlineScroll.ts`, `outlineScroll.test.ts`, `sessionNavPanel.tsx` | `display:none retention cycle never arms upward intent and restores scrollTop on revive`, `preparePrepend during collapsed layout does not snapshot a stale position` | 테스트 픽스처: `scrollTop 1446 / scrollHeight 4598 / clientHeight 731` → 숨김 시 0 → 복원 시 **1446**; 두 번째 케이스 **500→500**. live layout 게이트 `sh>0 && ch>0`, 복원 조건 `scrollTop<=2`. 실측 scrollTop `[UNVERIFIED]`. |

커밋 해시 검증 결과(모두 `git log`에서 일치 확인):
`aac7db4` = `aac7db4b556150b2f63cf660d8f328211c5429c9`,
`257becd` = `257becd1c752449f9d41385c052177988ac19c22`,
`76eca01` = `76eca0119e05a3f8639c472042b8b79f0808bf37`,
`f3c5ce5` = `f3c5ce5a8e89060c61913a3ff6d8d2950aaf2d2b`.

## 5. 수동 절차

### 5.1 CDP 접속
1. 호스트를 CDP 디버그 모드로 띄우고 relay offer를 받는다.
2. offer를 확인하고 **연결을 승인**한 뒤 target 목록에서 OMP 신규 / OMP long / Hermes long /
   현재 활성 탭을 식별한다.
3. relay offer UI, 디버그 포트, 승인 대기 시간은 호스트 환경 의존이며 저장소 근거가 없어
   `[UNVERIFIED]`다. 계측: offer 수신 시각, 승인 시각, target 수, 각 탭의 agentId.

### 5.2 탭 전환
- 대상 탭을 포커스하고, 전환 전/후의 아웃라인 `scrollTop`·`scrollHeight`·`clientHeight`를
  기록한다. 비활성 탭은 `display:none` 리텐션 상태가 되므로 4번째 증상의 게이트가 개입한다.
- 전환 후 패널이 이전 세션을 계속 가리키지 않는지(1.5s DOM/타임라인 ID 매칭) 확인한다.

### 5.3 Session navigation 패널 열기
- 경로: Explorer **사이드의 `+` 탭 메뉴 → Session navigation**(새 탭) → 트리에서 대상
  **리프(세션/행) 클릭**. 대체 경로는 **Cmd/Ctrl+K → Open session navigation** 또는 `/nav`.
  (`docs/spec.md` D10, `docs/README.ko.md` 기준.)
- agent 패널은 원래 `agentId`에 바인딩되고, workspace 패널은 `Follow visible session` 또는
  선택기로 고정한다. 빈 채팅/비세션 화면에서는 `No session in view`여야 한다.

### 5.4 스크롤러 탐색식
- **상향 의도**: 마우스 wheel/drag뿐 아니라 터치·트랙패드 `onScroll`도 24px 이상 상향 이동이면
  `userScrolledUp`을 arm해야 한다(aac7db4).
- **prepend 게이트**: `prevTop<=160px`, `stuck`, 상향 의도, `!isLoadingOlder`, 검색어 없음일 때
  older 로드. 하단 stick은 48px, 초기 settle 1500ms, 프로그램 스크롤 가드 150ms.
- **display:none 사이클**: 탭을 벗어나면(sh/ch 0) 스크롤 입력을 무시하고 마지막 live scrollTop을
  스냅샷, 복원 시 `scrollTop<=2`이면 스냅샷 값으로 복원하며 prepend/bottom-pin 스냅을 억제.
  `preparePrepend`는 collapsed 상태에서 no-op.

### 5.5 클릭 디스패치 순서
`sessionNavPanel.tsx` `handleRowPress` 기준:
1. `setSelectedId(rowKey)`.
2. 프리뷰 열림 결정 → `setHighlightedId`, 필요 시 `openPreviewDrawer()`.
3. `hasDocument`가 없으면 종료(패널만 갱신).
4. active child면 OMP 자식 탭 오픈 후 `visibleOnly` 스크롤(자식 문제는 subagent 문서로 분류).
5. displayOnly면 `navigation.openAgent`로 메인 탭을 연 뒤 스크롤.
6. 일반 경로는 `scrollToMessageInChat` 호출. `onStart`가 지난 `Not loaded in chat` 노티스를
   지우고, `onNotFound`가 같은 리터럴을 다시 세팅한다.
`chatNavigation.ts` 내부 순서: identity 매칭 → 마운트 윈도우/행 노드 탐색 → `getHistory` →
60s deadline 루프에서 `seekMountedWindow` 반복 → 대상 노드 스크롤 또는 실패 콜백.

### 5.6 판정 기준 (노티스 정확 일치 노드 검사)
- **문자열 포함 검색으로 판정하지 않는다.** `sessionNavPanel.tsx:143`은
  `notice !== "Not loaded in chat" && notice !== SUMMARY_QUEUED_NOTICE`로 **정확 비교**하고,
  `onStart`/`onNotFound`가 동일 리터럴을 세팅한다. therefore 실패 판정은 그 노드의 정확한
  문자열과 4초 자동 소멸(`:143-146`)로 해야 한다.
- **OMP 본문 인용 오판 사례**: OMP 메시지 본문이 `<paseo-system …> … </paseo-system>` XML을
  그대로 인용할 수 있다(`chatNavigation.test.ts:239-252`). 두 개의 서로 다른 notice가 같은
  XML 헤더를 공유해도 충돌하면 안 된다는 케이스(`:921-926`)도 있다. DOM 전체를 텍스트
  검색하면 인용된 본문을 실제 노티스로 오판하므로, **노티스 노드 자체**를 확인한다.
  실화면에서 실제로 오판이 발생한 인스턴스는 저장소에 없어 `[UNVERIFIED]`.
- 성공: 대상 노드가 스크rolled + 하이라이트, 노티스 노드 없음, 1.5s 후 하이라이트 소멸.
- 실패 재현: 정확히 `Not loaded in chat`인 노드가 보이고 4초 후 사라지며, 다음 행 클릭 시
  `onStart`에서 즉시 클리어되는지 확인.

## 6. 미검증 잔존 목록

| 항목 | 상태 | 필요 계측 |
| --- | --- | --- |
| 렌더러 플러그인 조합 전부 | `[UNVERIFIED]` | 조합별 DOM 스냅샷(`data-message-id`/`data-history-row-id`/`data-index`), `identityMatches` 입력·출력, seek 성공 여부를 조합마다 기록 |
| 초장거리(400+ 항목) seek 전체 구간 | 부분 검증: 하네스 a가 700+ 항목 거리(timeline idx 1117/1937) seek를 60초 대기+상향 페이징으로 커버. 400/800/1200+ 구간별 상·하양방향, 15s 무진행 컷오프, spinner/rowCount/scrollHeight 증가 시점 추가 계측 필요 | a 시나리오 구간 확장 + trace.json 샘플 분석 |
| 신규 세션 실시간 추적 | `[UNVERIFIED]` | 세션 생성 → Follow visible session 전환까지 1.5s 폴 로그, 바인딩 상태, 식별 불가 시 `No session in view` 전이 기록 |
| 릴레이 지연 극한 | `[UNVERIFIED]` | page당 지연 3s/10s/30s 주입, 4s·2500ms·15s 컷오프별 spinner 유지/종료, 60s deadline 도달 여부 기록 |
| 샌드박스 a/b seek | 검증 불가(환경): Hermes ACP `no dependency environment`, OMP RPC exit 1로 샌드박스 채팅 미기동. 실데몬에서만 유효 | `run.py`가 `reason: chat-runtime-down`으로 기록. 샌드박스 채팅 런타임 복구 후 재검증 |

## 7. 결정 기록: compress 이후 이전 대화 표시 정책 (2026-11-19)

결정: **(a) 전체 유지. 경계 접기·완전 숨김 미채택.** 3-에이전트 분석(Terra 성능·Hydrogen 경계·OMP Free UX) 교차검증 + 사용자 확정.

- 화면 숨김만으론 서버 비용(전체 스캔·복제·집계) 그대로. 접기는 UX 대책이지 성능 해법이 아님.
- 경계 탐지는 양쪽 다 추가 구현 필요(OMP `firstKeptEntryId` 역추적, Hermes 회전 체인+`_compressed_summary`). 오탐 시 빈 아웃라인·kept tail 손실.
- a-seek 직접 원인은 이미 수정됨(ID/니들/signature). 경계 숨김 없이 해결된 문제.
- 완전 숨김은 서버 불변식 6건 붕괴(고아 items 꼬리 부활 `service.ts:710-711`, `timeline_index`·`before_index`·병합·totals/unhide·seek 무한 페이징). 상세: 세션 대화 기록 참조.
