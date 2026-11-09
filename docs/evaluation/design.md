# Session Navigation A/B 평가 설계

## 목적과 비교군

평가 대상은 `cc00609`의 자동 정리 동작이다. 코드 변경 없이 별도 작업공간에서 실제 호스트를 사용한다.
사용자 변경 요청에 따라 모든 본 평가의 생성·요약·심판 호출은 **OpenRouter `z-ai/glm-5.3-flash`만** 허용한다.
이전 Crouton smoke는 설치 점검일 뿐 본 평가에서 전부 제외한다. proxy allowlist도 GLM 하나뿐이다.
이름만으로 실제 모델 크기나 다른 Flash급 모델에 대한 일반화를 입증할 수 없다.

### GLM usage 사전 확인

`eval/probe.py`의 단일 소형 요청(`eval/results/setup-glm/probe.json`)에서 prompt 16, completion 32,
`usage.cost=0.0000172` USD, `prompt_tokens_details.cached_tokens=0` 및 cache-write 0을 확인했다.
**cost와 cached-token 필드는 보고되지만 실제 cache hit는 아직 검증하지 않았다.**
`usage: {include: true}`를 upstream에 요청한다. 작은 출력 한도 때문에 probe는 reasoning 중 length로 종료되었으며 과제 성공 데이터가 아니다.

| 군 | OMP (주 평가) | Hermes (보조 평가) |
|---|---|---|
| A | 확장 없음, 정리 도구·guidance 없음 | 플러그인 없음 |
| B | 저장소 확장의 도구와 기본 guidance만 | 저장소 플러그인의 도구와 기본 guidance만 |

사용자 턴은 양 군 동일하며 정리 지시·추가 nudge를 넣지 않는다. 동일 호스트 내에서만 A/B를 비교한다.
OMP는 6개 사례 × 2군 × **3회 = 36세션**, Hermes는 사례 3·5 × 2군 × 3회 = **12세션**이다.
반복별 A/B 순서를 교대한다. 세션별 파일·DB·HOME을 격리하고 이전 대화를 재사용하지 않는다.
공유 풀 429는 지수 backoff와 Retry-After로 재시도하고 시각·횟수·지연·최종 실패를 기록한다.
3회가 rate limit 때문에 현실적으로 불가능할 때만 모든 해당 사례/군을 균형 있게 2회로 줄이고 이유를 결과에 남긴다.
사전 smoke는 별도로 표시하며 본 평가에 섞지 않는다. 네트워크 실패도 분모에서 숨기지 않는다.

## 결정적 사례

`eval/fixtures/build.py`가 seed 없이 고정 파일과 `cases.json`을 만든다. 정답·라벨은 에이전트 작업공간 밖에 둔다.
`turns`는 순차 사용자 턴, `answers`는 각 턴의 필수 정답 문자열, `results`는 파일/명령별 라벨과 사실 체크리스트다.
파일 출력은 수백 줄이므로 호스트의 출력 절단도 관찰한다. ground truth를 읽지 않고 답할 수 있도록 사실을 실제 파일에 넣는다.

| 사례 | 작업/턴 | 최종 판정 |
|---|---|---|
| 1 explore | 큰 모듈 3개 탐색 + 초기 모듈 상세 회상 (4턴) | 모듈별 값 및 초기 jitter 값 |
| 2 bugfix | verbose 테스트·진단 → 수정 → 검증 (3턴) | 원본 canonical unittest를 수정 코드에 적용해 통과 |
| 3 logs | bootstrap/traffic/rollout bash 출력 + 초기 marker 회상 (4턴) | marker·원인 일치 |
| 4 distractors | 핵심 파일 + 불필요한 inventory 다수 + 회상 (4턴) | retention 값, 실제 무관한 파일 판별 |
| 5 protected | 오류/status/exit 정보 + 일반 출력 + 회상 (3턴) | 오류·blocked·exit 23 보존, 완료로 오인하지 않음 |
| 6 long | 5개 순차 하위 작업 + 초기 owner/seal 회상 (6턴) | 각 단계 코드와 초기 사실 일치 |

라벨 `needed-later`는 뒤 턴에서 필요한 출력, `disposable`은 해당 하위 작업을 마친 뒤 없어도 되는 출력이다.
오류/status가 있는 출력에는 별도 `protected`를 붙인다. 같은 결과에 둘 이상 파일이 섞이면 필요한/보호된 쪽을 우선한다.
이미 관찰된 결과만 분모에 포함한다. 파일 일부 재읽기·검색과 미관찰 출력은 구분한다.

## 지표와 판정 규칙

- **도구 사용성:** 실제 manage/hide/summarize 호출 수·선택 ID 수·거부 사유. 호출의 사용자 턴,
  하위 작업 경계 여부(사용자 턴 마지막 작업 도구 뒤, 최종 답변 전), discovery 호출을 따로 센다.
  선택 precision = disposable 선택 / 라벨이 있는 선택, recall = 선택된 disposable ID / 관찰한 disposable ID.
  summarize로 필요한 출력을 보존하는 선택과 hide로 버리는 선택은 별도 표시하므로 precision만으로 전체 품질을 판단하지 않는다.
- **정리 품질:** 숨긴 뒤 후속 턴에 필요해진 항목/재읽기 수, 실제 전송 replacement의 필수 사실 포함률,
  replacement UTF-8 byte / 원문 byte, 보호된 출력의 오처리·정리 거부. 요약이 없으면 retention·judge는 N/A다.
- **LLM 심판:** 동일 GLM에 원문·replacement·체크리스트만 주고 arm을 가린다.
  1–5점(1=핵심 손실/환각, 3=부분 보존, 5=핵심과 오류/status 보존)과 이유를 JSON으로 받는다.
  같은 모델의 자기평가 편향이 있으므로 결정적 사실 검사보다 우선하지 않는다. 심판 토큰은 실험 비용과 분리한다.
- **과제 효과:** 턴별 정답 체크, canonical 테스트 통과, 마지막 회상 정답률,
  사용자 턴·실제 모델 요청 수, 요청별/총 prompt tokens와 peak. 단순 문자열 정답 검사는 동의어·우연한 정답을 놓칠 수 있다.
- **비용/캐시:** proxy에서 요청별 OpenRouter usage 전체를 저장한다.
  `prompt_tokens_details.cached_tokens`가 있으면 그대로 사용하며 없으면 0과 혼동하지 않는다.
  미보고 요청은 직전 동일 세션 요청의 `{messages, tools}` canonical JSON UTF-8 최장 공통 prefix 비율 × prompt tokens를
  **캐시 재사용 추정치**로 별도 기록한다. 이는 토크나이저/최소 block/TTL/다중 prefix를 모르는 대용치이지 실제 적중량이 아니다.
  main/summary/judge 요청을 구분하고 요약 overhead도 포함한 전체 비용과 main만의 비용을 함께 비교한다.

**주 비용 지표는 OpenRouter가 실제 보고한 `usage.cost` 합계**이며 prompt/cached tokens를 요청별로 함께 보고한다.
cost 누락을 0으로 간주하지 않는다. 아래 유료 가격표를 적용한 값은 보조 **가정 시뮬레이션**이며 다른 모델에서의 성능 예측이 아니다.
보조 참조: [GPT-4.1 공식 가격표](https://platform.openai.com/docs/models/gpt-4.1),
입력 $2 / 캐시 입력 $0.50 / 출력 $8 (각 100만 토큰).
비용 = `(P-C)*2/1e6 + C*0.5/1e6 + O*8/1e6`.
캐시 미보고이면 LCP 추정 비용과 캐시 0 상한을 둘 다 제시한다. cache-write 비용·도구 과금·추론 성능 차이는 모델링하지 않는다.

## 실행·안전·재현성

실행기는 실제 OMP SDK의 multi-turn 세션, Hermes의 실제 agent/plugin 경로를 사용한다. SDK/호스트 버전·실행 옵션·실제 예외는 결과에 기록한다.
호스트 통합을 제대로 실행할 수 없다면 synthetic 결과로 대체하지 않고 명시적으로 미완료 처리한다.
본문·응답은 loopback proxy에서 캡처하고 압축 JSONL로 `eval/results/<date>/`에 보관한다.
provider key는 환경변수에서만 읽고 proxy 밖의 자식 프로세스에는 넘기지 않는다. 요청 모델과 본문 내 key 유출을 guard한다.
실서비스 HOME/설정은 수정하지 않는다. 관련 설정의 전후 hash로 byte-exact 보존을 확인한다.
종료 후 모든 평가 산출물에서 실제 key 바이트와 일반 secret 패턴을 검사하고 값이 없는 audit 결과만 저장한다.

결과에는 표본 수·실패·호스트 기본 compaction/출력 절단·시간 순서에 따른 공유 풀 변화·합성 fixture 한계를 포함한다.
3회는 통계적 일반화를 위한 표본이 아니다. 네 가지 질문(도구 사용성, 정리 품질, 과제 품질 손실, cache-miss 비용)에 각각 제한된 결론을 낸다.
