# v3 — DeepSeek fallback 부분 완료 (2026-11-09)

## 현재 결과 요약

제품 B-old=`5017b97`, B-new=`fc07058`. Nemotron은 아래 확인을 통과했으나 일일 무료 할당량
소진으로 중단했다. 사용자 승인 fallback에 따라 **Stage 1·2 모두 DeepSeek**
`deepseek/deepseek-v4.1-flash-1017`, provider **Relace**, `allow_fallbacks:false`,
`reasoning={enabled:false,exclude:true}`로 실행했다. 모든 성공 응답의 reasoning tokens는 0이다.
v2 Stage 1은 Crouton이었으므로 모델 간 전후 수치를 제품 개선의 인과 효과로 읽으면 안 된다.
v3에서는 A/B-old/B-new를 같은 DeepSeek 설정으로 새로 비교했다.

**21/24 장기 세션 완료**, OMP는 12/12 완료. Hermes 마지막 2세션은 Relace 공유 pool의
지속적 HTTP 429로 중단, 마지막 A 1세션은 미시작이다. incomplete를 0점으로 채우거나
성공 세션으로 바꾸지 않았다. 따라서 전체 균형 잡힌 Hermes 평가는 **미완료**다.
별도 component 16세션과 judge 15건은 완료했다. Nemotron 자료는 전부 non-qualifying이다.

### 모델 확인·fallback·예산

- `/models`: `nvidia/nemotron-3.5-lightning:free`, 1,000,000 context, tools/tool_choice 지원,
  provider **Nvidia** 한 곳, 출력 최대 65,536. tiny probe에서 `ping(value=1)` tool call,
  288 input/41 output, 비용 $0를 확인했다. probe는 통계에서 제외했다.
- 초반 분당 429는 backoff로 회복했으나, 나중에 `free-models-per-day-high-balance`,
  `X-RateLimit-Remaining:0`가 발생해 여섯 번 backoff 후에도 실패했다. 사용자 규칙대로 중단했다.
  Nemotron 자율·component·judge를 DeepSeek 결과에 혼합하지 않았다.
- DeepSeek 3-arm pilot: 46,110 output tokens, **$0.062554454**.
  24세션 예상(1.5배 안전계수) $0.750653448;
  component 16개를 긴 세션 16개 비용으로 보수적으로 잡고 judge $0.50를 더한 전체 예상
  **$1.75108908 < $5**. A/B-new 2-arm cost pilot만 보면 34,940 output,
  $0.04724113, 8세션 예상 **$0.28344678 < $3**였다.
- 실제 전체 DeepSeek 비용(미완료 요청 포함): 자율 $0.548491020 + component $0.019669008
  + judge $0.002094666 = **$0.570254694**. Stage 2는 아래 OMP 4vs4 자료를 재사용해 중복 지출하지 않았다.
- DeepSeek도 후반 Relace 공유 pool 429가 지속돼 중단했다. 자율 proxy 기록은 retries 198,
  exhausted/transport failures 18이다. OMP에는 회복한 429 retry 5건, exhausted failure는 없었다.

### 사용성·과제 품질 (완료 세션만)

새 안내는 **답변을 먼저 쓰고 정리 도구를 호출**하게 한다. 기존 scorer는 마지막 assistant
메시지만 채점하므로 `Reported above; ... compressed`처럼 뒤의 정리 확인문을 답변으로 읽는다.
이 때문에 기존 strict 지표상 B-new OMP 1/4, Hermes 0/3이나, 해당 턴의 앞선 assistant
텍스트에는 요구 사실이 모두 있다. 원래 strict 결과는 그대로 남기고, 현재 사용자 턴 이후의
assistant **텍스트만** 합친 별도 `answer-surface.json`을 추가했다(도구 결과·reasoning·이전 턴 제외).
동일 방법으로 v2도 재채점: Crouton B-new 6/8, DeepSeek B-new 3/4로 기존 결과가 바뀌지 않았다.

| host/arm | 완료 | 과제 성공: 마지막 메시지 / 보이는 단위 답변 | nav / list | 요청 | 비용 |
|---|---:|---:|---:|---:|---:|
| OMP A | 4 | 4/4 / 4/4 | 0 / 0 | 244 | $0.087329796 |
| OMP B-old | 4 | 4/4 / 4/4 | 67 / 4 | 249 | $0.062571350 |
| OMP B-new | 4 | 1/4 / 4/4 | 53 / 7 | 285 | $0.084206760 |
| Hermes A | 3 | 3/3 / 3/3 | 0 / 0 | 232 | $0.131091698 |
| Hermes B-old | 3 | 3/3 / 3/3 | 30 / 0 | 249 | $0.086662350 |
| Hermes B-new | 3 | 0/3 / 3/3 | 42 / 0 | 214 | $0.065667180 |

요청은 completed-session metrics의 outgoing request 수(내부 요약/maintenance 포함), 비용은 보고된
usage.cost다. incomplete 요청은 이 표에는 없지만 전체 지출에는 포함된다.
완료한 B-new **7/7**가 2회 이상 성공 경계 정리, valid ID **117/123 (95.1%)**로 gate 통과.
OMP nav 53개는 manage 30, hide 16, list 7; Hermes는 hide 41, unhide 1이다.
모든 완료 세션의 canonical test는 통과했다. 사용자에게 보인 사실 기준 확인된 누락은 없으나,
이것이 미완료 셀이나 다른 모델의 안전성을 증명하지는 않는다.

**기존 strict 실패 원인/증거:**

- OMP atlas B-new 2: turns 4/7/9/13/16/17/19/20/23. 예: turn 4 앞선 assistant에는
  `atlas-team-4 / atlas-028d412a05 / 154 ms`, 마지막에는 `Reported above; ... compressed`.
- OMP boreal B-new 1: turns 8/13/16도 앞서 사실을 답하고 뒤에서 정리 확인만 했다.
- OMP boreal B-new 2 turn 11: 마지막 `no retry`를 exact matcher가 `do not retry`로 인정하지
  않지만 앞선 표에는 `DO NOT RETRY`가 있다. 의미상 오류도, Hide 손실도 아니다.
- Hermes atlas B-new 1 turn 17, atlas B-new 2 turns 16/17/20, boreal B-new 1 turns 7/10/13/16:
  앞선 tool-calling assistant의 텍스트에 사실을 보고하고, 마지막에는 정리 확인/이전 메모만 남았다.

### Stage 2 비용: 완료 OMP A/B-new 4vs4 재사용

| 지표 | A | B-new |
|---|---:|---:|
| prompt tokens | 11,314,570 | 10,361,602 |
| cached tokens | 10,010,624 | 8,580,352 |
| output tokens | 58,906 | 61,235 |
| reported cost | $0.087329796 | $0.084206760 (**−3.58%**) |
| 큰 cache 할인 reference | $8.084452 | $8.342556 (**+3.19%**) |

reference는 v2와 같은 input $2/cache $0.5/output $8 per M이다. 실제 DeepSeek의 input/cache
$0.006/$0.005 per M 차이가 작아 reported cost와 reference 결론이 다르다.
B-new의 첫 replacement 전송 54 transitions에서 uncached 증가분 가격 민감도는 native
$0.000103543/reference $0.1553145다. 이는 인과적 cache 손실액이 아니다(native 압축·출력·TTL 미통제).

### Hide / Summarize component 품질

각 host/arm/action에 2회씩. **실제로 전송된 최종 저장 replacement**의 checklist 기준:

| host/arm | Hide 지시 trial 사실 보존 | Summarize 지시 trial 사실 보존 |
|---|---:|---:|
| OMP B-old | 6/6 (rule 2개) | 4/6 (LLM 2개) |
| OMP B-new | 5/6 (rule 1 + LLM 1) | 5/6 (LLM 1 + rule 1) |
| Hermes B-old | 6/6 (rule 2개) | 6/6 (LLM 2개) |
| Hermes B-new | 6/6 (rule 2개) | 3/3 (LLM 1개; 다른 trial은 전송 replacement 없음) |

**순수 rule Hide 품질과 모델의 지시 준수를 혼동하지 않는다.** OMP B-new Hide trial 2는
금지된 Summarize를 먼저 호출했고, Summarize trial 2는 Hide를 먼저 호출했다.
`verification_failed`/잘못된 ID도 발생했다. 따라서 표의 혼합 행을 rule/LLM 성능으로 단정하지 않는다.
OMP summary의 일부 budget 누락은 여전히 남는다. 독립 judge(같은 DeepSeek, arm-blinded)는
15개 distinct replacement 평균 **2.27/5**, N/A 0개다. exact 3-fact checklist보다 넓은 의미 품질을
평가하며 세부 telemetry/제약 손실도 감점했다. Summarize 개선 주장은 하지 않는다.

### Hide 이후 재접근

(a)=숨김/요약 이후 unhide 전 접근, (b)=이미 봤으나 숨겨지지 않은 파일 접근, (c)=신규.
파일별 인과적 recovery가 아니라 호출별 proxy다. v2 방법/한계는 아래 보존했다.

| v3 OMP arm | bash a/b/c | read a/b/c | a 같은 턴 / 이후 턴 | unhide 성공 | b 합계 |
|---|---|---|---:|---:|---:|
| A | 0/6/18 | 0/6/88 | 0/0 | 0 | 12 |
| B-old | 0/1/16 | 2/3/88 | 0/2 | 2 | 4 |
| B-new | 2/0/28 | 1/16/76 | 0/3 | 0 | 16 |

unhide **호출**은 OMP B-old 3(성공 2), 나머지 0; Hermes B-new 1, A/B-old 0이다.
Hermes work-call events 미수집으로 a/b/c는 N/A다. v2 DeepSeek B-new는 53회(같은 턴43/이후10),
v3는 3회(0/3). v2 nav/list/requests **169/48/538** → v3 **53/7/285**;
output 217,717 → 61,235. reasoning 0 설정과 guidance 변화가 함께 있어 각각의 기여를 분리할 수 없다.
v2 비용 +77.3% → v3 −3.58%이나, reference에서는 여전히 +3.19%로 보편적 비용 절감을 주장하지 않는다.

### 네 질문에 대한 현재 판정 / 한계

1. 사용성: 완료 B-new 7/7 gate 통과, 중복 list/같은 턴 재접근이 줄었다. 지시 준수와 ID 오류는 남는다.
2. 품질: 번호 metadata 보존 회귀는 고쳤으나 summary budget 손실과 component action 혼동은 남는다.
3. 태스크: 보이는 단위 답변 21/21 성공. 기존 마지막-message 지표의 false negative를 함께 공개했다.
   미완료 Hermes 셀과 모델 변경 때문에 일반화하지 않는다.
4. 비용: OMP native −3.58%, 큰 cache 할인 reference +3.19%. 개선 신호이지 일관된 절감 증거는 아니다.

남은 일은 Relace 공유 pool 회복 후 **boreal Hermes rep2의 A/B-old/B-new**를 새 label로 실행하는 것.
중단된 workspace는 덮어쓰지 않는다. 설치본·원본 대화는 건드리지 않았고 key는 proxy 환경에만 있었다.
최종 hash는 pilot 시작 hash와 byte-exact. 전체 key audit는 **165,877 files, actual key 0,
credential prefix 0** (`2026-11-09-v3-deepseek/final-audit.json`). harness 회귀 테스트는
**22 tests / OK**다. 제품 코드·설치 runtime은 바뀌지 않아 제품 suite는 이번 단계에서 재실행하지 않았다.
단위 답변의 사실 존재 여부는 의미 모순까지 판정하는 judge가 아니므로 원래 strict 지표와 함께 읽는다.

---

## 이전 기록: Crouton 폐기 차단 및 v2 재접근 기준

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
