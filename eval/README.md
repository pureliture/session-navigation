# A/B 실행기

## Focus effect: no native compaction

[Results and limitations](../docs/evaluation/results-focus.md). `focus_fixtures.py`
builds five matched seeds at 35%/70% of a 131,072-token declared window. Fixed
OMP-style wire histories compare RAW with actual product rule Hide (commit
`37348b8`), three repetitions each: 60 calls. Eleven reachable facts/derivations
are primary; a buried hidden-only marker has a separate loss score. The joint
question can induce recovery behavior, so a miss is not automatically a focus effect.

Six fresh live OMP sessions separately check autonomous adoption with native
compaction explicitly disabled. The runner never commands B cleanup. All model
calls use DeepSeek V4.1 Flash 1017, Relace only, reasoning disabled, the existing
guarded proxy and an env-only key. The included pilot is one long replay pair
and one live pair; continuing requires projected total <= $1.50.

```bash
uv run --no-sync --with tiktoken python eval/focus_run.py --output eval/results/DATE-focus --phase pilot --label pilot
# Only after reviewing budget.json with continue=true:
uv run --no-sync --with tiktoken python eval/focus_run.py --output eval/results/DATE-focus --phase rest --label main
# API-only recovery, never retry a qualifying outcome; use a fresh label/index:
uv run --no-sync --with tiktoken python eval/focus_run.py --output eval/results/DATE-focus --phase retry --label retry1 --job 0
uv run --no-sync --with tiktoken python eval/focus_score.py eval/results/DATE-focus
uv run --no-sync --with tiktoken python eval/focus_audit.py eval/results/DATE-focus
uv run --no-sync python eval/v2_audit.py eval/results/DATE-focus
```

`stage.json` freezes schedules/settings/source hashes. Fixtures retain full
originals, exact engine replacements and reachability checks; outgoing histories
are independently compared with fixtures. API failures/missing usage are excluded,
not converted to product failures. McNemar is on paired trial vectors; seed-cluster
bootstrap uncertainty recognizes repeated seeds/facts. Five seeds are a small sample.

## v4 (DeepSeek, 정리 후 마지막 답변 완결성)

모델은 `deepseek/deepseek-v4.1-flash-1017` 하나, Relace만 허용하며 reasoning은
`{"enabled":false,"exclude":true}`로 고정한다. A=`fc07058`(plugin off),
B-old=`5017b97`, B-new=`37348b8`. OMP/Hermes 각각 atlas/boreal × 2회다.
`setup-v4/budget-before.json`과 `observed-budget.json`에 $5 gate를 보관한다.

```bash
uv run --no-sync python eval/v2_run.py --stage deepseek-quality --arms B-new --label v4n- --output eval/results/2026-11-09-v4-new
uv run --no-sync python eval/v2_run.py --stage deepseek-quality --hosts hermes --arms A,B-old --cases boreal --repetitions 1 --repetition-start 2 --label v4f- --output eval/results/2026-11-09-v4-fill
uv run --no-sync python eval/v2_run.py --stage deepseek-quality --components --arms B-old,B-new --label v4q- --output eval/results/2026-11-09-v4-quality
uv run --no-sync python eval/v2_run.py --stage deepseek-quality --hosts hermes --arms A --cases atlas --repetitions 1 --repetition-start 2 --label v4r- --output eval/results/2026-11-09-v4-retry
uv run --no-sync python eval/v2_run.py --stage deepseek-quality --hosts hermes --arms A --cases atlas --repetitions 1 --repetition-start 2 --label v4r2- --output eval/results/2026-11-09-v4-retry2
uv run --no-sync python eval/v4_assemble.py --reuse eval/results/2026-11-09-v3-deepseek --source eval/results/2026-11-09-v4-new --source eval/results/2026-11-09-v4-fill --source eval/results/2026-11-09-v4-retry --source eval/results/2026-11-09-v4-retry2 --output eval/results/2026-11-09-v4-deepseek
uv run --no-sync python eval/v2_analyze.py eval/results/2026-11-09-v4-deepseek
uv run --no-sync python eval/v2_answer_surface.py eval/results/2026-11-09-v4-deepseek
```

assembler는 기존 v3 A/B-old 완료 13세션만 재사용한다. v3 Hermes A atlas rep-2는 완료했어도
exhausted 429 두 건/usage 누락 두 건이 있어 새 label로 다시 실행한다. 추가 예산 gate는
`setup-v4/replacement-budget.json`이다.
첫 새 실행도 native checkpoint 요청 한 건이 429 backoff를 소진했으므로 non-qualifying으로
보존하고 `v4r2-`로 재개했다(`resume-budget.json`, 예상 $2.3353). 해당 API 오류를 과제 실패로
세지 않는다. assembler는 제외 사유를 manifest에 함께 남긴다. stage 설정과 실제 upstream
model/provider/reasoning을 검사하고 host/fixture/proxy가 v3 이래 바뀌지 않았는지 검사한다.
API/transport 실패 세션은 원본 디렉터리에 남기고 제품 실패로 세지 않는다. 24셀의 중복·누락을
거부하며 v3 파일은 수정하지 않는다. `reuse.json`에 출처를 기록한다. 재시도 시 새 label을 쓴다.
visible-unit 지표는 그대로 유지하며 `answer-surface.json`에 마지막 메시지의 back-reference
정규식 검출 수/턴을 추가했다. 검출은 보조 지표이며 완전성은 별도 fact check로 본다.
judge는 v3와 동일하게 component에서 실제 전송된 replacement를 평가하며 DeepSeek/Relace와
같은 reasoning-off 설정을 명시해야 한다. 완료된 writer의 wire만 archive/audit한다.

## v2 (Crouton 품질 → 조건부 DeepSeek 비용)

[설계](../docs/evaluation/design.md). 제품은 `git archive`로 B-old=`b1a524e`,
B-new=`5017b97`를 격리한다. 설치본은 바꾸지 않는다. `v2_run.py`는 모델과 provider를
한 쌍으로 고정하고 65,536 effective window에서 실제 OMP SDK/Hermes를 실행한다.
명령형 trial은 자율 실행과 다른 디렉터리에 둔다.

OMP headless host는 `extensionRunner.initialize`로 실제 세션 callback을 연결한다.
격리 HOME의 Bun fallback 다운로드 대신 기존 SDK `node_modules`를 `NODE_PATH`로 읽는다.
시작 시 model/window/native import를 assert하며, 빈 세션 offline 회귀 테스트가 이를 검사한다.
`non-qualifying.json`이 있는 첫 시도 디렉터리는 gate/pilot으로 사용할 수 없다.
최종 적격 데이터는 `2026-11-09-v2-crouton-final`, `-crouton-quality`, `-deepseek-final`이다.
pilot 분석/stage/safety는 본 실행 전에 `pilot-*`로 복사해 보존한다. 사전 부적격 유료 지출이
있으면 `v2_cost.py DIR PRIOR_COST`로 예산 예상에 더한다. [최종 결과](../docs/evaluation/results-v2.md).

```bash
uv run --no-sync python eval/v2_run.py --stage crouton --output eval/results/DATE-crouton
uv run --no-sync python eval/v2_run.py --stage crouton --components --arms B-old,B-new --output eval/results/DATE-components
uv run --no-sync python eval/v2_analyze.py eval/results/DATE-crouton
uv run --no-sync python eval/v2_run.py --stage deepseek --hosts omp --arms A,B-new --cases atlas --repetitions 1 --pilot --adoption-report eval/results/DATE-crouton/summary-v2.json --output eval/results/DATE-deepseek
uv run --no-sync python eval/v2_analyze.py eval/results/DATE-deepseek
uv run --no-sync python eval/v2_cost.py eval/results/DATE-deepseek
uv run --no-sync python eval/v2_cache.py eval/results/DATE-deepseek
# pilot-budget.json의 출력 토큰과 예상 비용을 보고한 뒤 continue=true일 때만:
uv run --no-sync python eval/v2_run.py --stage deepseek --hosts omp --arms A,B-new --adoption-report eval/results/DATE-crouton/summary-v2.json --pilot-report eval/results/DATE-deepseek/pilot-budget.json --output eval/results/DATE-deepseek
```

판정·심판은 stage 모델/provider를 명시한다. Crouton judge는
`judge(directory, model="stealth/crouton-alpha", provider="Stealth")`다.
모든 writer가 종료한 **뒤에만** `v2_archive.py DIR`로 wire를 lossless XZ로 바꿀 수 있다.
decompressed SHA-256을 대조하며 원본/요청을 버리지 않는다. 이어서 `v2_audit.py DIR`로
key를 검사한다. archiving 이후 같은 디렉터리에서 실행을 재개하지 않는다.
계속 실행/재시도는 새 label을 쓰고 최초 실패도 결과에 남긴다.
경계 양쪽(전 턴 종료/다음 턴 시작)의 정리는 같은 boundary index로 센다.
중간에 업무 호출이 양쪽으로 끼는 정리는 경계로 세지 않는다.
Hermes deferred `tool_call(calls=[...])`도 계수한다. native 이벤트가 있다고 이를 건너뛰지 않는다.
보호/짧은/정책 거절 출력은 denominator에서 제외한다. 명시 Hide precision과 전체
disposable 선택 비중을 구분하며, 필요한 정보를 Summarize한 것을 오선택으로 단정하지 않는다.
`v2_cache.py`는 실제 전송된 마지막 저장 replacement의 최초 outgoing transition만 짝짓는다.
uncached 증가분 × input/cache 가격 차이는 가격 민감도이며, 출력·native 압축·TTL 등을
통제한 인과적 cache-break 비용이 아니다. 캐시/비용 누락은 N/A로 남긴다.

## v1 (보관된 GLM 실행)

모델 호출 없는 개선 단계의 고정 overhead 비교는 [개선 문서](../docs/evaluation/improvements.md)와
`capture_overhead.ts` / `measure_overhead.py`를 사용한다. 기존 결과와 새 offline 추정값을 섞지 않는다.

본 평가 모델: `z-ai/glm-5.3-flash` 하나. `results/setup-glm/` 및 `results/smoke/`는 설치 점검으로 본 통계에 포함하지 않는다.

```bash
uv run --no-sync python eval/fixtures/build.py
uv run --no-sync python -m unittest discover -s eval/tests -v
# OPENROUTER_API_KEY는 이미 환경에 있어야 한다. 명령행·파일에 key를 넣지 않는다.
uv run --no-sync python eval/probe.py
uv run --no-sync python eval/run.py --output eval/results/YYYY-MM-DD
uv run --no-sync python eval/analyze.py eval/results/YYYY-MM-DD
uv run --no-sync python eval/summarize.py eval/results/YYYY-MM-DD
uv run --no-sync python eval/judge.py eval/results/YYYY-MM-DD
uv run --no-sync python eval/check_capture.py eval/results/YYYY-MM-DD
uv run --no-sync python eval/audit.py eval/results/YYYY-MM-DD
```

`--hosts omp,hermes`, `--cases 03-logs,05-protected`, `--arms A,B`, `--repetitions 3`, `--label retry-`로 범위를 지정한다.
완료 status가 있는 세션은 재실행하지 않는다. 중단된 작업공간은 덮어쓰지 않으며 새 label로 별도 실행한다.
기존 결과의 실패를 삭제하고 성공으로 교체하지 않는다.
작업공간은 `~/.session-navigation-eval/`에 남고, 정답은 에이전트에 전달하지 않는다.

필수: Python 3.11+, Bun, 저장소 `.venv/bin/session-navigation-daemon`, 설치된 OMP SDK 및 Hermes Python 환경.
분석은 반드시 프로젝트 `uv` 환경을 사용한다. 이 VM의 시스템 Python(SQLite 3.51.0)은 Hermes가 만든
WAL DB의 read-only 조회에 `unable to open database file`을 냈고, 프로젝트 SQLite 3.53.4에서는 정상 조회됐다.
`OMP_PACKAGE`, `HERMES_SOURCE`, `HERMES_PYTHON`으로 호스트 위치를 바꿀 수 있다.
기본 OMP는 이 VM의 18.18.3이며 SDK 예제의 옛 `ModelRegistry.create` 대신 실제 생성자를 사용한다.
Hermes는 소스 `109fd81`의 `AIAgent.run_conversation`와 실제 plugin discovery를 사용한다.
B는 `plugins.enabled`와 내부 `settings.enabled`를 모두 켜며 5개 도구/1개 middleware 로드를 assert한다.
Hermes의 progressive tool discovery는 호스트 기본값이며 B에만 직접 도구 노출을 강제하지 않는다.
GLM endpoint는 reasoning이 필수이므로 Hermes에서 reasoning을 끄지 않는다.

실제 설정을 바꾸지 않고 격리 HOME을 사용한다. 원래 설정은 hash를 전후 대조한다.
자식 프로세스에는 OS 실행에 필요한 환경만 전달하고 실제 API key를 전달하지 않는다.
loopback proxy만 key를 환경에서 읽으며 다른 model selector는 upstream으로 보내지 않는다.
클라이언트 요청과 실제 upstream 요청(`usage.include=true`, `stream=false`), 응답/usage, 재시도를 압축 JSONL로 캡처한다.
스트리밍 호스트에는 완성 응답을 SSE로 변환하므로 스트리밍 지연 자체를 평가하지 않는다.
proxy가 429/5xx를 2·4·8·16·32·64초(또는 Retry-After, 최대 120초) 간격으로 재시도하며 실패도 기록한다.
요약은 제품의 25초 예산을 그대로 사용하므로 긴 backoff에서는 fallback/실패가 가능하다.
분석 시 저장하는 `store.json.gz`는 items/units의 read-only snapshot이므로 작업 HOME이 없어도 재분석할 수 있다.
정밀도/재현율 분모는 라벨 파일/명령과 매칭된 1,000자 이상의 실제 tool result다. 짧은 검색 결과는 별도 재읽기만 센다.
`check_capture.py`는 이 설계의 48세션·16셀·3회 반복과 B 활성화/usage를 확인하는 완료 검사다.
수집 당시 OMP transcript 배열은 마지막 history를 공유했다. 사용자 prompt 경계로 턴을 복원하며
이를 회귀 테스트한다. 현재 수집기는 턴별 deep copy를 저장한다. 원본 wire와 답변은 수정하지 않았다.
judge는 실제 전송된 rule replacement도 채점하지만 LLM summary 점수와 구분해야 한다.
JSON 실패는 동일 입력에 한 번만 4,096-token 한도로 재시도하고 모든 시도의 비용을 wire에 남긴다.

v1 설계/평가 한계는 [design-v1](../docs/evaluation/design-v1.md), 수치는 [results](../docs/evaluation/results.md)를 참고한다.

## v3 (중단) 과 Hide 이후 재접근 지표

후속 사용자 승인 fallback으로 `--stage nemotron`(Nvidia)을 시도했으나 무료 일일 quota 소진으로
해당 디렉터리는 non-qualifying이다. `--stage deepseek-quality`는 같은 pinned Relace/reasoning-off
설정으로 A/B-old/B-new와 components를 허용한다. 3-arm pilot 후 전체 $5 예상 gate를 별도 기록했고,
완료된 OMP A/B-new 4vs4를 비용 비교에 재사용했다. 후반 Hermes 3셀은 Relace 429로 미완료다.

`v2_answer_surface.py DIR`은 기존 마지막-message 지표를 바꾸지 않고, 현재 사용자 턴 이후의
assistant 텍스트를 합쳐 별도 `answer-surface.json`을 낸다. 답변 후 정리 확인문이 마지막에
붙는 경우를 평가하며 도구 결과·이전 턴·reasoning은 제외한다. v2에도 같은 방법을 적용한다.

`v2_rereads.py DIR`은 events의 read/bash와 성공한 정리 operation을 시간순으로 맞춰
(a) 숨김 대상 파일 재접근, (b) 보이는 상태의 재접근, (c) 신규를 나눈다.
(a)는 같은 턴과 이후 턴으로 쪼개고 unhide 수를 함께 낸다. `v2_analyze.py`가 자동으로 호출하며
`rereads.json`을 남긴다. 접근 proxy이며 정보 유실로 인한 재독의 인과 증거가 아니다.
`tool_execution_start`가 없는 호스트(현재 Hermes)는 0이 아니라 `unavailable`로 남긴다.
v3 Crouton 실행은 모델 폐기(HTTP 404)로 중단됐다. `2026-11-09-v3-crouton`에는
`non-qualifying.json`이 있으므로 gate/pilot으로 쓸 수 없고 통계에 섞지 않는다.

## Distractor-pressure quality experiment

`quality_fixtures.py` generates four matched incident-review cases with signed-live
configuration, superseded archive exports, build/test records, announced retention
and late surprise derivations. Both arms retain source files, ordinary tools, notes
and host-native recovery. Work units request complete report inspection equally;
the runner never selects B cleanup targets or requires a cleanup action.

`quality_run.py` runs an isolated Hermes pair first, then gates the remaining three
pairs on captured cost and actual transmitted native compaction in A. Hermes needs
at least 64,000 tokens for auxiliary compression, so the declared window is 65,536
(the same 64-Ki-token window as v4). The rejected 32,768-token setup is preserved
separately and included in campaign spending, not task outcomes.

```bash
uv run --no-sync --with tiktoken python eval/quality_run.py \
  --phase pilot --label pilot --output eval/results/NEW-QUALITY-CAMPAIGN
uv run --no-sync --with tiktoken python eval/quality_run.py \
  --phase rest --label rest --output eval/results/NEW-QUALITY-CAMPAIGN
uv run --no-sync --with tiktoken python eval/quality_score.py eval/results/NEW-QUALITY-CAMPAIGN
uv run --no-sync --with tiktoken python -m unittest discover -s eval/tests -v
```

Retry transport-failed cells only with `--phase retry --seed N --arm A|B-new`
and a fresh label. Qualifying product outcomes cannot be retried. Scoring checks
requested JSON fields on final-only and current visible-unit surfaces, separately
counts stale/unsupported values, and canonically validates `decision.json` outside
the agent workspace. It does not semantically judge arbitrary prose. Native
before/after snapshots and matching outgoing summary content distinguish actual
compaction from no-op attempts. Tool shares use normalized messages+tools JSON and
offline `o200k_base` tokens, not provider billing attribution.

The initial campaign's [partial results](../docs/evaluation/results-quality-benefit.md)
include three qualifying pairs and a fourth pair blocked by native-summary Relace 429s.
No B cleanup action was invoked, so no Hide/Summarize efficacy claim is supported.
