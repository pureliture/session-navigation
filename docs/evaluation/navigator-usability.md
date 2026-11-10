# 내비게이터(아웃라인) 단일 사용성 평가

> 평가에 사용한 원본 세션 링크는 프라이빗 평가 저장소의 읽기 권한이 필요합니다.

> **판정: 사용자의 불편을 부분적으로 해소한다.** 아웃라인에서는 클릭 전에
> “어떤 프롬프트와 응답이 있었는지”를 지속적으로 훑어볼 수 있었다.
> 기본 틱도 hover하면 프롬프트를 보여주므로 정보가 전혀 없는 것은 아니다.
> 다만 파일명으로 도구를 찾는 과업에서는 아웃라인 검색이 read 행을 놓쳤고,
> 정확한 도구 입력 경로는 Preview를 열어야 확인할 수 있었다.
> 아웃라인이 모든 과업에서 더 빠르거나 상세 열기를 없애 주지는 않았다.

이 문서는 [모델 A/B 평가](results.md)와 별개의 **단일 평가자 사용성
워크스루**다. 사람을 모집한 실험이나 속도 우위의 통계 검정이 아니다.

## 1. 대상과 데이터

| 항목 | 내용 |
|---|---|
| 평가 UI | [PR #8](https://github.com/pureliture/session-navigation/pull/8), **b1a524e의 navigator UI 코드** |
| 환경 | 로컬 Paseo 웹, Chrome, 밝은 테마 |
| 실제 대화 | [`omp-06-long-B-3`](https://github.com/pureliture/session-navigation-evidence/tree/8214151597ae6d7791bc0650d53c14075be0a0f3/2026-11-09-glm/omp-06-long-B-3), GLM 5.3 Flash로 이미 실행된 OMP 평가 세션 |
| 규모 | 원본 SDK 메시지 **40개**, JSON 직렬화 약 **274 KB**, 사용자 요청 **6개** |
| 아웃라인 | User **6행**, Assistant **7행**, Tool **14행** = **27행**; 연속 도구는 그룹으로 접힘 |
| 숨김 상태 | 원본 snapshot의 **3개 hidden 결과**를 그대로 보존 |
| 실행 방식 | 원본 메시지를 SDK SessionManager로 별도 뷰어에 복사하고 읽기 전용 절차로 평가 |
| 이번 모델 호출 | **0회**. 새 프롬프트 전송, Hide, Summarize, Unhide를 하지 않음 |
| 녹화 | 연속 녹화 1개, [편집본 120.8초](https://lg-uplus-poc.devinenterprise.com/attachments/eb16b2ef-fbea-4400-99bc-3b654fc25f03/navigator-usability-b1a524e-edited.mp4) |

**긴 출력 세션이지, 긴 턴 수 세션은 아니다.** 이 데이터로 수백~수천 턴의
가상화·과거 기록 로딩 성능을 입증하지 않는다. 순수 도구 호출용 assistant
구조는 별도 텍스트 행이 아니라 도구 행으로 표현되므로 SDK 메시지 수와
아웃라인 행 수는 다르다.

복사본의 화면 하단에 보이는 Qwen 로컬 모델 이름은 뷰어 메타데이터다.
원본 대화는 GLM 기록이며 이번 평가에서 어느 모델에도 요청하지 않았다.
토큰 표시는 원본 저장값을 재사용한다. 복사 시 wrapper 시각이 재생성되어
“몇 시에 작업했는지”를 찾는 과업은 평가하지 않았다.

평가 중 병행된 engine/policy/daemon/Hermes 작업은 이미 로드된 Paseo UI를
바꾸지 않았다. 여기의 판단 대상은 **b1a524e UI**이며 그 병행 변경의 검증은 아니다.

## 2. 방법과 계수

- 각 시도를 채팅의 최신 위치에서 시작했다. 아웃라인 조건은 목록 위쪽,
  빈 검색, Preview 닫힘으로 준비했다. 이전에 연 네이티브 도구 상세도 닫았다.
- 기본 조건에서는 **왼쪽 틱 hover/click, 채팅 스크롤, 네이티브 그룹/도구 펼침만**
  사용했다. 아웃라인 조건에서는 행 발췌, 필터, 그룹 펼침, 행 선택, Preview를 썼다.
- 조건 순서를 과업마다 번갈았다. T1만 필터 창 열기를 포함하고 이후에는
  검색 입력란을 열린 상태로 유지했다. 준비·초기화 조작은 측정에서 제외했다.
- 브라우저 Find, 소스 검색, API 조회로 정답을 찾지 않았다.
  접근성 트리의 틱 라벨만 읽은 것은 “화면에 보임”으로 세지 않았다.
  실제 hover tooltip, 채팅 본문, 아웃라인 픽셀 캡처를 확인했다.
- **C / I / W / H** = 클릭 / 입력 변경 / wheel 이벤트 / 틱 진입 이벤트.
  H에는 클릭 전 우연한 포인터 진입도 포함된다. W는 물리적 손동작 수가 아니다.
  입력 문자열의 글자 수를 키 입력 수로 부풀리지 않았다.
- T2·T4·T5 아웃라인에서 행 선택이 네이티브 그룹을 자동으로 펼친
  합성 클릭 1개씩은 C에서 제외했다. 실제 평가자 클릭과 구분한 것이다.
- 시간은 첫 계수 이벤트부터 목표 확인 또는 시도 종료까지의 wall-clock이다.
  자동화 판단·도구 왕복·스크린샷 대기를 포함하므로 **사람의 수행 시간이나
  제품 자체의 순수 응답 시간으로 해석하면 안 된다.**
- 탐색 목표 예산은 시도당 45초였다. T2 아웃라인과 T5 기본 조건은
  중간에 중단하지 못하고 초과까지 진행했으며, 예산 내 완료로 세지 않는다.
  녹화 편집본은 대기를 줄인 것이므로 재생 길이로 표의 시간을 재계산할 수 없다.
- 아래의 “상세 없이”는 도구 본문/Preview를 열기 전을 뜻한다.
  그룹 펼침이나 hover가 필요했다면 별도로 표시했다.

## 3. 여섯 찾기 과업과 결과

과업의 목표:

1. **T1:** `phase-3.txt`를 전부 읽고 owner/completion을 보고하라는 정확한 요청 찾기.
2. **T2:** `phase-4.txt`의 첫 read를 식별하고 입력 경로를 확인한 뒤 해당 도구로 이동.
3. **T3:** 세션의 첫 `Subtask 1` 프롬프트까지 이동.
4. **T4:** phase-5의 큰 read 결과를 찾고 화면에 표시된 크기 보고.
5. **T5:** 숨겨진 phase-2 첫 read와 대체 내용, 원본 입력/출력 확인.
6. **T6:** 최신 위치에서 phase-1 → phase-5 요청으로 차례로 이동.

| 과업 | 조건 | 결과 | C / I / W / H | 시간 | 상세 없이 확인할 수 있던 정보 |
|---|---|---|---:|---:|---|
| T1 | 기본 틱 | 완료 | 1 / 0 / 0 / 1 | 15.2초 | **hover 동안만** 정확한 프롬프트 tooltip |
| T1 | 아웃라인 | 완료 | 2 / 1 / 0 / 0 | 13.1초 | 검색 결과 User 행에 프롬프트가 지속 표시됨 |
| T2 | 기본 틱 | 완료 | 3 / 0 / 0 / 2 | 36.1초 | hover에 파일명; `Read 2 files`를 펼치면 read 파일명/범위 라벨 |
| T2 | 아웃라인 | 완료, **예산 초과** | 3 / 2 / 3 / 0 | **64.6초** | 검색에는 User/Assistant만 남음. 도구 경로는 Preview 필요 |
| T3 | 기본 틱 | 완료 | 1 / 0 / 0 / 1 | 6.5초 | 첫 틱이라는 위치는 알 수 있지만 프롬프트는 클릭 후 확인 |
| T3 | 아웃라인 | 완료 | 1 / 0 / 0 / 0 | 6.5초 | 맨 위 User 행에서 첫 프롬프트 식별 |
| T4 | 기본 틱 | **부분** | 3 / 0 / 0 / 1 | 41.3초 | 해당 read/원문은 찾음. 살펴본 네이티브 UI에 바이트 크기 지표 없음 |
| T4 | 아웃라인 | 완료 | 2 / 0 / 10 / 0 | 28.7초 | 그룹을 펼친 뒤 **16.0 KiB / 6.5 KiB**를 구분; Preview 불필요 |
| T5 | 기본 틱 | **부분, 예산 초과** | 3 / 0 / 0 / 2 | **47.5초** | 과거 `Manage context`와 ID는 찾음. 현재 대체 본문을 확인할 화면은 찾지 못함 |
| T5 | 아웃라인 | 완료 | 3 / 0 / 4 / 0 | 40.3초 | hidden 그룹/자식 표시. 대체 내용과 원본 I/O는 Preview에서 확인 |
| T6 | 기본 틱 | 완료 | 2 / 0 / 0 / 4 | 21.3초 | 알고 있는 첫째/다섯째 틱으로 이동; 목록 스크롤 없음 |
| T6 | 아웃라인 | 완료 | 2 / 0 / 6 / 0 | 23.2초 | 프롬프트 발췌로 목적지 식별; 중간에 목록 스크롤 필요 |

완료는 해당 목표를 확인했다는 뜻이다. **예산 준수와는 별개**다.
부분 결과를 완료 시간으로 바꾸거나 전체 시간을 평균내어 속도 우위를 주장하지 않았다.

### T1: 라벨 없는 틱의 불편은 “정보가 없음”보다 “계속 보이지 않음”

기본 틱은 hover하면 전체 요청을 보여줬다. 그러나 포인터를 옮기면 사라진다.
아웃라인은 User/Assistant 발췌를 나란히 유지하므로 여러 하위 작업을 훑기 좋았다.
이 과업에서는 클릭 전에도 phase-3 요청을 식별할 수 있었다.

| 기본 — hover 중에만 보이는 후보 | 아웃라인 — 지속되는 프롬프트 검색 결과 |
|---|---|
| [![기본 틱의 phase-3 tooltip](https://lg-uplus-poc.devinenterprise.com/attachments/212858a7-5c40-46cb-9081-d9993ed8a1e8/navigator-native-tooltip.png#w=1600&h=1001)](img/navigator-native-tooltip.png) | [![아웃라인의 phase-3 프롬프트](https://lg-uplus-poc.devinenterprise.com/attachments/e7a419ac-a8e1-4179-892b-c4f14afea286/navigator-outline-prompt.png#w=1600&h=1001)](img/navigator-outline-prompt.png) |

### T2·T4: 도구 정보는 좋아진 부분과 더 약한 부분이 함께 있음

`phase-4.txt` 필터는 User/Assistant 행을 찾았지만 **read 도구 행은 찾지 못했다**.
검색을 지우고 phase-4 그룹을 펼친 뒤 첫 read를 선택하고 Preview의
`Input.path`로 확인했다. 기본 UI는 그룹을 펼치면 `Read phase-4.txt`처럼
파일명이 보였다. 아웃라인의 `read`·호출 ID·출력 발췌만으로는 같은 수준의
경로 구분이 어려웠다.

반면 큰 결과 찾기에서는 아웃라인의 크기 지표가 유용했다.
기본 UI로 결과를 찾을 수는 있었지만 바이트 크기를 답할 수 없었다.
그룹화 자체는 기본 UI에도 있다. 아웃라인의 추가 가치는 도구 종류 요약과
크기/토큰, hidden 집계가 같은 탐색 목록에 붙어 있다는 점이다.

| 경로 검색 — 도구가 아닌 대화 행만 남음 | 큰 결과 — 두 read의 크기가 구분됨 |
|---|---|
| [![phase-4 파일명 필터의 한계](https://lg-uplus-poc.devinenterprise.com/attachments/9c72711c-1a8f-4f65-9b80-6f2ee0157b49/navigator-path-filter.png#w=1600&h=1001)](img/navigator-path-filter.png) | [![16.0 KiB와 6.5 KiB 도구 행](https://lg-uplus-poc.devinenterprise.com/attachments/497cbdea-9f62-44d7-8e4d-67a33c083c36/navigator-outline-large.png#w=1600&h=1001)](img/navigator-outline-large.png) |

### T5: 숨김 상태와 실제 대체 내용은 별도의 확인이 필요

기본 UI의 과거 관리 결과는 현재 무엇이 모델 문맥에 남는지 보여주는 화면과
같지 않다. 아웃라인에서는 hidden 표시와 Preview의 `Sent to model`,
`Original input`, `Original output`을 확인했다. 대체 본문 내부를 스크롤하여
`unhide_context(...)` 안내까지 확인했다.

대체 내용은 **393자**이며 원본 snapshot의 compacted 값 및 과거 global
`wire.jsonl.gz`의 마지막 일치 요청 본문과 정확히 같았다.
요청 ID는 `80df6d7c6b7845e2b969bab56c4dec66`,
도구 ID는 `chatcmpl-tool-a0ab296078ac7e02`다.
**이는 보관된 실제 요청과의 오프라인 대조이지, 이번 복사본에서 새 요청을 보냈다는 뜻은 아니다.**

| 기본 — 과거 Manage context 기록 | 아웃라인 — 279px의 hidden 상태와 Preview |
|---|---|
| [![기본 UI의 과거 관리 작업](https://lg-uplus-poc.devinenterprise.com/attachments/34f8b7fa-f005-4265-a9b4-fe38b644a946/navigator-native-hidden.png#w=1600&h=1001)](img/navigator-native-hidden.png) | [![좁은 아웃라인의 Sent to model과 원본 입력](https://lg-uplus-poc.devinenterprise.com/attachments/3e2de50f-826a-4dfb-8d99-1dc58f7c6604/navigator-narrow-preview.png#w=1600&h=1001)](img/navigator-narrow-preview.png) |

이미지는 브라우저 본문 캡처이며 클릭하면 저장소 내 PNG를 열 수 있다.
6개 합계 약 **1.0 MB**, 개별 약 124~229 KB다.

## 4. 휴리스틱 관찰

| 항목 | 관찰과 판정 |
|---|---|
| 세션 전체 범위 | 첫 요청부터 최종 recall까지 확인. T3에서 두 조건 모두 정확한 첫 프롬프트에 도착했고 missing-history notice는 없었다. **이 27행 범위에서만 확인** |
| 행의 정보 단서 | User/Assistant 발췌는 “무슨 요청/작업이었는가” 식별에 도움. read 행은 파일명보다 ID와 출력 발췌가 앞서 정확한 파일 찾기에는 약함 |
| 그룹화 | 연속 도구 수, 종류 요약, 크기/토큰, hidden 집계로 밀도를 줄임. 큰 결과나 모두 숨김인 묶음을 찾는 데 유용 |
| 점프 정확도 | 확인한 요청·read가 의도한 채팅 위치/도구와 일치. 접힌 네이티브 도구도 아웃라인 선택으로 펼쳐짐 |
| 멀리 이동 | T6에서 양쪽 목적지 모두 맞음. 알려진 순번으로 이동할 때는 기본 틱이 간단했고, 아웃라인은 스크롤이 필요 |
| 스크롤 | 평가 목록의 위/아래와 첫/마지막 부분을 왕복했고 관찰 중 멈춤은 없었음. 대규모 가상화/FPS 벤치마크는 아님 |
| 좁은 폭 | 실제 separator 드래그 후 **279 CSS px**에서 프롬프트·그룹·Preview 사용 가능. 긴 그룹 제목은 `2 tool …`처럼 잘리고 hidden 행은 희미함. 원문 출력은 아래쪽/내부 스크롤 필요 |

폭 조절 첫 시도는 핸들 바깥을 눌러 바뀌지 않았다. 실제 separator 위치를
확인한 뒤 다시 드래그해 279px을 측정했다. 종료 시 뷰어 패널은 약 320px로
복구했다. 이 관찰은 드래그 성능이나 접근성 적합성 판정은 아니다.

## 5. 개선 우선순위

1. **P1 — 도구 경로를 행과 검색에 포함.** `read phase-4.txt:1–300`,
   `bash <명령 앞부분>`처럼 목적을 우선 보여주고 호출 ID는 보조 정보로 둔다.
   파일명 필터가 도구 입력의 path/command도 찾으면 T2의 우회 탐색을 줄일 수 있다.
2. **P2 — 좁은 폭에서 의미 있는 집계를 보존.** tool 수와 hidden 수는
   제목 ellipsis와 분리하고, hidden 행의 가독성을 높인다.
   이번에는 명도 대비를 계측하지 않았으므로 WCAG 위반으로 단정하지 않는다.
3. **P2 — 처음/최근 위치로 빠른 이동 보완.** 지속적인 정보 단서는 유지하되
   순번을 이미 아는 사용자의 짧은 틱 이동을 대체할 단축 동선도 고려한다.
4. **P3 — 수백~수천 턴의 실제 기록으로 추가 평가.** 첫 기록 로딩, 빠른
   왕복, 긴 프롬프트, 검색 결과의 문맥 유지, 도구 경로 찾기를 다시 확인한다.

## 6. 해석의 한계

- 평가자 1명, 조건별 1회다. 성공률·시간을 사용자 집단으로 일반화할 수 없다.
- `Subtask N`과 파일 번호가 순서대로 대응한다. 기본 틱에서 알려진 순번을
  바로 활용했으므로 낯선 세션에서 후보를 발견하는 난이도를 재현하지 못한다.
- 조건 순서를 번갈았지만 학습·기억 효과를 없애지 못했다.
- 실제 모델이 수행한 평가 대화지만 내용은 반복적인 fixture 파일 조사다.
  일반 개발 세션의 모호한 질문, 여러 파일 편집, 복잡한 bash 명령은 이번 대상이 아니다.
- 장문 **출력**은 있지만 User 요청은 짧다. 모든 길이의 프롬프트가 행에
  전부 보인다고 주장하지 않는다. 발췌/두 줄 표시의 한계는 남는다.
- 약 27행이라 수백~수천 행의 virtualized history, 1,000개 제한,
  매우 오래된 기록의 로딩 지연을 검증하지 못했다.
- 밝은 테마·마우스 중심 워크스루다. 이번 사용성 평가에서 모바일, 키보드,
  스크린리더, 다중 평가자 검증을 하지 않았다.

## 7. 구현 근거와 보존 확인

과업 설계 시 확인한 UI 경로/동작:

- `paseo-plugin/client/sessionNavPanel.tsx:575–587`: 필터는
  `tool_name`, `summary_line`, `tool_call_id`를 검사한다. raw tool input/output
  전체를 검색하지 않는다. 따라서 **이번 read 행의 파일명**이 검색에 걸리지 않았다.
- 같은 파일 `1030–1080`: User/Assistant 발췌,
  `1220–1340`: 그룹,
  `1360–1470`: 도구/지표,
  `1560–1610`: 필터 토글과 입력.
- `paseo-plugin/client/outlineGrouping.ts:53–110`: 그룹 집계.
- `paseo-plugin/client/previewContent.ts:6–29`: `Sent to model`과 원본 I/O.
- `paseo-plugin/server/sessionNav.ts:219–280`: scope 탐색과 항목 로딩.

종료 후 확인:

- 원본 6개 파일의 SHA-256이 모두 동일하고 복사본의 SDK 메시지 **40개가 원본과 동일**.
- `models.yml`이 시작 전과 byte-identical. 모델 키를 설정하거나 새 proxy를 켜지 않음.
- 공유 DB의 복사 scope 밖 **items 90행 / units 131행이 모두 동일**.
- 복사 scope의 원문·대체문·visibility·version을 변경하지 않음. 원래의 hidden 3개 유지.
- 수동 계측기를 제거하고 뷰어를 archive하여 상태 **closed**를 확인.
  원래 작업 workspace로 돌아감. 재현용 native 복사 파일과 scope는 보관.
- 평가 작업에서는 제품 코드 변경이나 commit을 하지 않음.

추가 원시 증거는 실행 머신의 `/Users/devin/nav-usability-evidence/`에 있다:
`verification.json`, `T1..T6-native/outline.json`, `T5-preview-dom.json`.
보조 JSON을 측정 파일로 잘못 읽은 수집기 glob은 수정한 뒤 최종 보존/대조
검증을 완료했다. 이 보조 도구 오류는 UI 과업 결과를 바꾸지 않았다.

[Devin 실행 세션](https://lg-uplus-poc.devinenterprise.com/sessions/6753f0e8ee654abd8c38bd540cd0653a)
