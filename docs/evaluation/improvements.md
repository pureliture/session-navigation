# 평가 후 개선 — 구현 단계

## v4: 정리 후 마지막 답변 완결성

작업 단위를 끝내고 먼저 답한 뒤, 필요하면 선택적으로 batch cleanup하는 순서는 유지한다.
추가 안내는 정리 후 마지막 메시지에도 모든 요청 사실/값을 포함한 완전한 답을 다시 쓰고,
`reported above` / `see above`로 대체하지 말라고 명시한다. 시점·대상·행동 선택은 여전히 agent가 한다.
OMP 시스템 안내와 request-copy reminder, Hermes supervision과 공통 reminder에 적용했다.

동일 offline `o200k_base`/JSON 방식: OMP 고정 overhead **679→709 (+30)**,
Hermes **333→364 (+31)** tokens. 대표 후보 3행 reminder는 **185→215 (+30)** tokens,
793 bytes다. 실제 OpenRouter 청구량과 구별한다. 로컬 capture는 `eval/results/setup-v4/`에 보관한다.

실제 모델 재평가는 아직 하지 않았다. 기존 GLM 결과는 변경하지 않는다.

## 동작

- OMP/Hermes는 새 사용자 턴과 같은 턴의 컨텍스트 50/75/90% 구간에서 후보 안내를
  **요청 사본 끝에만** 추가한다. 후보가 없으면 생략하고, 처음 생길 때까지 안내를 미룬다.
  사용량은 `~` 추정값, window를 모르면 `?`다. Hermes window는 메인 응답 hook에서
  관측한 값을 재사용하며, 조회 때문에 모델/메타데이터 API를 호출하지 않는다.
- 전체 적격 후보 수와 최대 3개 ID·도구·경로/명령·바이트·사용자 턴(1부터)을 표시한다.
  전체 안내는 1,000바이트 이내다. ID는 자르지 않고 너무 큰 행은 표시에서만 생략한다.
  표시 범위 밖 ID도 기존 `manage_context` 경로로 선택할 수 있다.
- 안내는 정리를 제안할 뿐 시점·대상·방법을 선택하지 않는다. Hide는 규칙,
  Summarize는 세션 LLM, auto는 모델 우선/규칙 대체다. 원본·세션 history는 그대로다.
  다른 Hermes middleware와 공존해 record-only로 동작할 때는 안내도 추가하지 않는다.
- 안내 자체는 기존 prefix를 바꾸지 않는다. 실제 hide/summary 적용에 따른 prefix 변경까지
  없앤다는 뜻은 아니다. 같은 턴/구간에서 반복 안내하지 않으며 상태는 세션별 메모리에만 둔다.
- Hermes 안내는 작업 단위 자율 정리를 먼저, 사용자 복원을 뒤에 설명한다.
  조사한 Hermes의 `PluginContext.register_tool`에는 per-tool eager 옵션이 없고,
  `tools.tool_search.is_deferrable_tool_name`은 plugin toolset을 deferred로 분류한다.
  core registry나 사용자 설정을 우회하지 않고 **정확한 이름 → tool_describe → tool_call**을
  명시했다. `list_context_items` 첫 문장도 visible 후보 발견을 설명한다.
- 규칙 Hide는 기존 head/tail·필수 증거에 더해 독립적인 `key=value` / `Key: value`와
  경고/실패 표식을 남긴다. 추가 주요 줄 예산은 768바이트, 전체 발췌 예산은 3,072바이트다.
  기존 error/status 보호를 완화하지 않는다.
- (v3) 호스트가 줄번호를 붙여 보여주는 줄(OMP `20:owner=...`, Hermes `47|audit_seal=...`)도
  주요 줄로 인식한다. 선택된 줄은 원문 그대로 유지하며 번호를 떼어내지 않는다.
  Hermes처럼 전체 줄이 연속 번호인 경우는 기존 `strip_consecutive_numbering` 경로가 처리한다.
  v2에서 Crouton B-new 2건의 오답 원인이었던 `audit_seal` 손실에 대한 회귀 테스트를 추가했다.
- (v3) 안내·도구 설명·시스템 가이드는 "작업 단위를 끝내고 먼저 답한 뒤, 유용하면 한 번의 호출로
  묶어서 정리"를 권한다. 이미 보여준 literal ID를 먼저 쓰고 바뀌지 않은 파일을 다시 확인하지
  말라고 안내한다. 시점·대상·행동 선택은 여전히 agent가 한다.
- (v3) **모델이 보는 모든 문자열은 영어**다. 대체문 wrapper(`Original excerpt:`,
  `The remaining result is preserved. ...`), 요약 wrapper, Hermes 도구 설명·supervision section,
  `list_context_items` 메시지, 경계 안내가 포함된다. 사용자용 문서/UI 문구는 그대로 둔다.
- `manage_context(action=hide, keep_lines=[...])`는 agent가 고른 exact 한 줄 부분문자열을
  포함하는 원문 줄을 그대로 남긴다. envelope/연속 줄번호를 제거한 본문 기준이며 합계
  1,024바이트 이내다. 같은 목록을 각 대상에 적용한다. 없는 값·잘못된 형식은
  `invalid_keep_lines`, 다른 action은 `invalid_keep_lines_action`, 이미 저장된 대체문이
  새 보존 요구를 충족하지 못하면 `keep_lines_conflict`로 거절한다. 조용히 무시하지 않는다.

## 고정 overhead와 안내 크기

모델 실행 금지 조건 때문에 **새 OpenRouter native prompt usage는 측정하지 않았다**.
이전 실제 GLM 차이는 OMP 약 853, Hermes 869–871 tokens/request였다.
아래는 전/후 모두 같은 `o200k_base`와 JSON 직렬화로 계산한 **offline 비교값**이다.
GLM tokenizer나 청구량으로 오인하면 안 된다.

| 고정 overhead: A 대비 B | 기존 | 개선 후 |
|---|---:|---:|
| OMP | 804 | 651 (v3: 679) |
| Hermes | 699 | 309 (v3: 333) |

v3의 영어·배치 정리 안내가 약간 길어져 offline overhead가 OMP +28, Hermes +24 tokens 늘었다.
v3 대표 안내(후보 20개 중 3행)는 **651바이트 / 185 offline tokens**다.

대표적인 3행 안내는 **494바이트 / 153 offline tokens**였다(전체 후보 20개, ID 전체 표시).
OMP는 실제 SDK를 loopback stub에 연결해 A/B 요청을 수집했다. Hermes는 저장된 요청의
plugin section과 80자/첫 문장 catalog를 현재 정의로 치환했다. 런타임 설치본은 바꾸지 않았다.

재현(외부 모델 호출 없음; tiktoken은 별도 임시 도구 환경에만 설치):

```bash
bun eval/capture_overhead.ts /path/to/omp-requests.json
uv run --no-sync --with tiktoken python eval/measure_overhead.py /path/to/omp-requests.json
```

재평가에서 native token/cost/cache 값을 다시 측정해야 한다. 안내는 매 요청의 고정 비용이
아니며, 채택률·요약 품질·순 비용 개선은 이 구현 단계의 테스트만으로 주장하지 않는다.
