# v3 — 구현 완료, 재평가는 모델 폐기로 중단

제품 commit: `fc07058` (고정된 arm 설정: `d9c976f`). B-old=`5017b97`, B-new=`fc07058`.
줄번호가 붙은 주요 정보의 rule Hide 보존, 영어 모델 문구, 답변 후 선택적 batch cleanup 안내를 구현했다.
고정 overhead의 동일 offline 추정은 OMP **804→679**, Hermes **699→333 tokens**다.
실제 모델 청구량이 아니다. [방법](improvements.md).

## 실행 차단 — 2026-11-09

단일 allowlist 모델 `stealth/crouton-alpha`, provider `Stealth`, fallback 비활성화로 Stage 1을 시작했으나,
첫 요청 `9d2e23965ffd470c921fbfd4bca60cc1`부터 OpenRouter HTTP **404**가 반환됐다:

> Crouton Alpha is no longer available. This stealth model was retired on November 9, 2026. Browse other models at https://openrouter.ai/models.

증거: `eval/results/2026-11-09-v3-crouton/wire.jsonl.xz`. 자동화가 API 오류를 빈 완료 턴으로
기록한 OMP 세션은 **유효한 평가가 아니다**. 이를 성공률 0%나 제품 회귀로 해석하지 않는다.
차단을 확인한 후 남은 평가 프로세스만 종료했다. 모델을 바꾸지 않았으며,
Stage 1 gate를 통과할 수 없어 **DeepSeek pilot/full 및 component trial/judge를 실행하지 않았다**.
v3의 arm별 성공률·nav/list 호출·유효 요청·비용 비교는 모두 **N/A**다.
원래 설정 hash는 byte-exact이며, 실제 key는 자식 환경에 전달하지 않았다.

DeepSeek의 사전 tiny probe는 Relace에서 기본 reasoning **9 tokens**, 동일 요청에
`reasoning={enabled:false,exclude:true}`를 지정하면 **0 tokens**임을 확인했다.
양 arm에 이 설정을 강제하도록 harness를 바꿨다. `finish_reason=length`에 빈 답변인 응답은
별도 `empty_answer_length` 실패로 집계한다. probe는 task 평가/비용 비교에 섞지 않는다.

## 신규 지표: Hide 이후 파일 재접근 (v2 재분석)

`v2_rereads.py`는 시간순 `events.jsonl.gz`의 `tool_execution_start` read/bash를 사용한다.
read path 또는 bash 내 파일명/`audit-01` 같은 파일 stem을 정규화한다. bash 명령에 여러 파일이
있어도 호출당 한 번 집계한다. 성공한 metrics operation의 Hide/Summarize/auto 대상을 원래
tool call에 연결하고, unhide는 해제한다. 동일 파일이 숨겨진 뒤 다시 언급되면 (a), 앞서
등장했지만 숨겨지지 않았으면 (b), 나머지는 (c)다. 새 read가 있어도 명시적 unhide 전까지
숨김 상태를 유지한다. 이는 **접근 proxy**이지, 반드시 정보 유실 때문에 재독했다는 인과 증거는 아니다.
경로는 basename/stem 기준이므로 동일 basename 충돌, glob/변수로만 지정된 파일은 한계가 있다.

| v2 stage / OMP arm | bash a/b/c | read a/b/c | a: 같은 턴 / 이후 턴 | unhide | b 합계 |
|---|---|---|---|---:|---:|
| Crouton A | 0/2/12 | 0/2/92 | 0/0 | 0 | 4 |
| Crouton B-old (`b1a524e`) | 1/1/12 | 3/3/91 | 3/1 | 22 | 4 |
| Crouton B-new (`5017b97`) | 0/0/12 | 17/4/93 | 13/4 | 9 | 4 |
| DeepSeek A | 0/56/19 | 0/6/86 | 0/0 | 0 | 62 |
| DeepSeek B-new (`5017b97`) | 21/99/47 | 32/27/65 | 43/10 | 2 | 126 |

각 행 4세션이다. v2 원본 metrics는 수정하지 않고 `rereads.json`만 추가했다.
제공된 DeepSeek 참고값과 A/read는 동일하다. B bash는 (a) +2, (b) −2이며 이후 턴 +2다.
파일 stem 정규화와 명시적 unhide 전까지의 파일 수준 숨김 상태를 쓰는 정의 차이를 포함한다.
Hermes의 모든 arm은 기존 events에 `tool_execution_start`가 없어 **N/A**다(0으로 대체하지 않음).
v3는 유효한 모델 응답이 없어 모든 arm **N/A**다. 같은 턴 재접근은 cleanup 직후 재검증일 수도
있으므로 이후 턴 회복과 분리해서 본다.

## v2 대비 판정

v2에서 도구 adoption은 확인됐으나 품질 손실과 비용 증가가 있었다.
이번 구현이 이를 개선했는지는 **검증할 수 없다**. 네 질문(도구 사용성, Hide/요약 품질,
태스크 품질, cache/cost)은 v2 결론을 유지하며 v3 개선을 주장하지 않는다.
다음 단계는 사용자가 Stage 1의 대체 모델을 지정하는 것이다. 그 전에는 유료 Stage 2를 진행하지 않는다.
