# Session Navigation A/B 평가 결과

## 요약

2026-11-09 UTC, 제품 코드 `cc00609`를 **OpenRouter `z-ai/glm-5.3-flash`만** 사용해 평가했다.
OMP 6사례 × A/B × 3회 = 36세션, Hermes 사례 3·5 × A/B × 3회 = 12세션으로 **총 48세션**을 완료했다.
2회로 축소하지 않았다. 과제/최종 회상은 모두 맞았지만 자발적 정리는 드물었다.
OMP B의 한 세션에서만 hide가 적용됐고 **LLM summarize는 양 호스트 모두 0회**였다.
따라서 요약 품질이나 일반적인 context-window 고갈 방지 효과를 입증한 평가가 아니다.

- [설계](design.md), [재실행 방법](../../eval/README.md)
- [원자료](../../eval/results/2026-11-09-glm/), [세션별 지표](../../eval/results/2026-11-09-glm/metrics.json),
  [호스트/사례별 집계](../../eval/results/2026-11-09-glm/summary.json)
- [호스트 활성화·모델 검사](../../eval/results/2026-11-09-glm/capture-audit.json),
  [설정 전후 검사](../../eval/results/2026-11-09-glm/safety.json),
  [최종 key 검사](../../eval/results/2026-11-09-glm/final-audit.json)

## 실행 및 데이터 무결성

OMP는 설치된 18.18.3 SDK/Bun 1.4.4를 사용했다. A에는 기본 도구 4개만, B에는 navigation 도구 5개와
제품의 기본 guidance를 더했다. 최초 실제 요청의 도구/시스템 prompt와 B의 SQLite units를 검사했다.
Hermes는 VM의 실제 `AIAgent`와 플러그인 discovery를 사용했고 B에서 도구 5개·hook 1개·middleware 1개 활성화를 확인했다.
Hermes 설치본은 Git checkout이 아닌 배포 snapshot이다. 이전 조사에서 기록한 revision은 `109fd81`이고,
이번에 직접 확인한 `run_agent.py` SHA-256은 capture audit에 보존했다. 이 revision을 새 Git 조회로 재확인한 것은 아니다.
Hermes의 기본 progressive discovery를 유지했으므로 navigation 도구는 처음부터 API schema에 직접 나열되지 않을 수 있다.

각 세션은 별도 HOME/작업 파일/DB에서 시작했다. 사용자 prompt는 동일하고 추가 정리 nudge는 없다.
짝수 반복은 B→A, 홀수는 A→B 순서다. 실제 요청 **476개/응답 476개**, 별도 judge 요청 **5개** 모두 GLM이었다.
Crouton smoke와 GLM setup은 결과 통계에서 제외했다. 소형 probe만 필드 확인 근거로 따로 보관했다.
본 실행의 proxy 관찰 429/5xx 재시도와 transport 실패는 0회였다. backoff는 단위 테스트에서 검증했다.
Hermes의 로컬 `/api/show` 탐색 12회는 400으로 거부됐으며 upstream 호출/과제 요청 수에 포함하지 않는다.

모든 과제 요청에서 cost/cached-token 필드가 보고돼 누락은 0이다. LCP 값은 원자료에 있지만 주 결과에는 사용하지 않았다.
실제 설정의 전후 SHA-256이 같아 복원할 변경 자체가 없었다. 실제 key는 proxy 환경에만 유지했고 자식에게 전달하지 않았다.
최종 audit는 tracked 파일, 평가 산출물(압축 해제 후), 격리 작업 HOME을 검사한다. 설치본/라이브 runtime은 수정하지 않았다.

## 1. 도구 사용성

| 지표 | OMP A (18세션) | OMP B (18세션) | Hermes A / B (각 6세션) |
|---|---:|---:|---:|
| discovery `list_context_items` | 0 | 4 | 0 / 0 |
| `manage_context` | 0 | 2 | 0 / 0 |
| manage action=hide / summarize / auto | 0 / 0 / 0 | 2 / 0 / 0 | 전부 0 |
| 전용 hide / summarize / unhide 도구 | 0 / 0 / 0 | 0 / 0 / 1 | 전부 0 |
| 경계에서 호출 (discovery 포함) | N/A | 7/7 | N/A |
| 선택한 ID / 정상 적용 / 거부 | 0 / 0 / 0 | 8 / 4 / 4 | 전부 0 |
| unknown ID | 0 | 4 (`not_found`) | 0 / 0 |
| disposable 선택 precision | N/A | 2/4 = **50%** | N/A |
| disposable 선택 recall | N/A | 2/76 = **2.63%** | N/A / 0/12 |

Precision은 라벨을 확인할 수 있는 선택만의 값이다. unknown 4개까지 분모에 넣으면 2/8=25%다.
분모는 파일/명령에 매칭된 실제 1,000자 이상 출력이며 원래 라벨의 파일 단위를 유지했다.
호스트가 파일을 분할하면 같은 파일의 여러 출력이 각각 ID가 된다. 일부 tail 출력은 사실을 포함하지 않으므로
50%를 세밀한 문장 수준의 정답률로 해석하면 안 된다.

`omp-02-bugfix-B-2`에서 discovery 3회는 모두 빈 후보 목록이었다.
`omp-06-long-B-3`에서는 2턴 후 실제 ID 4개를 hide했고, 5턴 후 존재하지 않는 ID 4개를 보내 거부됐다.
6턴의 회상 질문에서 필요한 원문 한 개를 `unhide_context`로 복원해 정답을 냈다.
즉 API를 한 번은 정상 사용했지만, 기본 guidance만으로 매 하위 작업마다 반복 정리한 것은 아니다.
Hermes B는 플러그인 활성화에도 자발적 navigation 호출이 없었다.

## 2. hide/summary 품질

| 지표 | A | OMP B | Hermes B |
|---|---:|---:|---:|
| 실제 전송 rule replacement | 0 | 4 | 0 |
| 실제 LLM summary / 요약 모델 요청 | 0 / 0 | 0 / 0 | 0 / 0 |
| 원문 → replacement (중복 없는 항목별 UTF-8 bytes) | N/A | 46,179 → 1,844 | N/A |
| replacement/original 비율 | N/A | **3.99%** (96.01% 감소) | N/A |
| 파일 라벨상 needed-later를 hide한 ID | 0 | 2 | 0 |
| 이후 unhide / 종료 시 hidden | 0 / 0 | 1 / 3 | 0 / 0 |
| hide 이후 필요한 파일의 재읽기 | 0 | 0 (unhide로 복원) | 0 |
| rule의 원문 내 체크리스트 사실 보존 | N/A | **0/6** | N/A |
| LLM summary 사실 보존 / judge | N/A | **N/A / N/A** | N/A / N/A |

4개는 모두 6번 사례의 phase 1·2 head/tail 출력이다. head 원문 2개에만 체크리스트 사실 3개씩이 있었다.
tail에 원래 없던 사실은 보존율 분모에서 제외했다. rule excerpt는 owner/code/seal을 남기지 못했다.
phase 1의 중요한 원문은 마지막 회상 시 복원됐다. 최종 성공을 즉각적인 사실 보존 성공과 혼동하면 안 된다.
오류/status 보호 사례는 정답을 유지했지만 정리 자체가 없어 **보호 출력의 hide 거부 성능은 이번 A/B로 검증되지 않았다**.

동일 GLM에 arm을 가리고 실제 전송된 **rule excerpt** 4개를 보조 채점시켰다. 점수는 3, 3, 2, 1로 평균 **2.25/5**다.
LLM summary 점수가 아니다. judge가 disposable filler 소실도 벌점 처리했으므로 hide의 적절성 판정보다는
inline 정보 손실의 보조 신호로만 사용한다. 동일 모델 편향과 작은 표본 때문에 결정적 사실 검사보다 우선하지 않는다.
한 요청이 reasoning 중 `length` 종료되어 JSON 파싱에 실패했고, 같은 입력을 4,096-token 한도로 한 번 재시도해 완료했다.
실패 시도를 포함해 judge 5요청, prompt 18,527 / completion 4,918, **$0.00384170**이며 과제 비용과 분리했다.

## 3. 과제 품질과 token/비용

아래 비용은 모델 가격 추정이 아니라 각 응답의 **OpenRouter `usage.cost` 합계(USD)**다.
완료 토큰은 보고된 reasoning 토큰도 포함한다. 생성·요약을 모두 포함하되 요약 호출이 0이라 전부 main 비용이다.

| 지표 | OMP A | OMP B | Hermes A | Hermes B |
|---|---:|---:|---:|---:|
| 과제 성공 | 18/18 | 18/18 | 6/6 | 6/6 |
| 최종 회상 전체 정답 | 18/18 | 18/18 | 6/6 | 6/6 |
| 사용자 턴 | 72 | 72 | 21 | 21 |
| 모델 요청 | 174 | 189 | 57 | 56 |
| 총 prompt tokens | 3,098,921 | 3,233,921 | 990,018 | 1,006,435 |
| peak prompt / 요청 | 46,592 | 47,549 | 31,083 | 31,620 |
| 총 cached tokens | 2,302,627 | 2,410,968 | 747,584 | 756,992 |
| cached / prompt | 74.30% | 74.55% | 75.51% | 75.22% |
| uncached prompt | 796,294 | 822,953 | 242,434 | 249,443 |
| 총 completion tokens | 43,356 | 70,143 | 6,936 | 7,847 |
| 요약 overhead prompt / 요청 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| 보고 비용 합계 | $0.16022676 | $0.17770009 | $0.05947408 | $0.06276440 |
| 세션당 평균 비용 | $0.00890149 | $0.00987223 | $0.00991235 | $0.01046073 |
| 후속 턴 동일 fixture 접근 (재읽기 heuristic) | 10 | 10 | 6 | 6 |

OMP B는 prompt +4.36%, 비용 +10.91%; Hermes B는 prompt +1.66%, 비용 +5.53%였다.
정리 호출, 추가 도구 schema/guidance, 다른 탐색 경로와 출력 길이, provider/cache 상태가 함께 달라졌다.
이 차이를 플러그인의 독립적인 인과 비용으로 단정하지 않는다. 재읽기는 짧은 grep 등을 포함한 파일명 기반 접근 수이며
정리 때문에 발생했다고 단정할 수 없다. 정답 검사는 문자열 기반이라 전체 설명의 완전한 의미 채점은 아니다.
버그 수정 사례는 별도로 원본 canonical unittest 80개를 모든 A/B 반복의 수정 코드에 적용해 통과했다.

### 사례별 결과 (각 셀 n=3)

| 호스트·사례 | 성공 A/B | prompt 합계 A / B | 비용 A / B | 관찰 |
|---|---|---:|---:|---|
| OMP 1 explore | 3/3 · 3/3 | 516,564 / 531,308 | $0.025235 / $0.028266 | jitter 137 회상; 정리 없음 |
| OMP 2 bugfix | 3/3 · 3/3 | 270,674 / 355,041 | $0.017928 / $0.019379 | canonical 통과; B discovery 3회 |
| OMP 3 logs | 3/3 · 3/3 | 329,475 / 400,248 | $0.019411 / $0.036607 | violet-27 회상; B cache 변동 큼 |
| OMP 4 distractors | 3/3 · 3/3 | 669,315 / 542,622 | $0.042169 / $0.030871 | hide 없음; 낮은 비용을 압축 효과로 볼 수 없음 |
| OMP 5 protected | 3/3 · 3/3 | 311,416 / 353,470 | $0.016101 / $0.018659 | blocked/23/DO NOT RETRY 보존; 미해결 판정 |
| OMP 6 long | 3/3 · 3/3 | 1,001,477 / 1,051,232 | $0.039383 / $0.043918 | B 3회차만 hide·거부·unhide |
| Hermes 3 logs | 3/3 · 3/3 | 608,875 / 577,463 | $0.037387 / $0.036977 | marker 회상; navigation 없음 |
| Hermes 5 protected | 3/3 · 3/3 | 381,143 / 428,972 | $0.022087 / $0.025788 | 보호 사실 회상; navigation 없음 |

## 4. cache-miss trade-off

유일한 hide 성공 직전/직후의 실제 요청을 비교하면 다음과 같다 (`omp-06-long-B-3`).

| 요청 | prompt | cached | uncached | 보고 비용 |
|---|---:|---:|---:|---:|
| `77dc8c37a5f24e84b3d9df44c2338f4e` (치환 전) | 18,156 | 17,660 | 496 | $0.00066006 |
| `eeb1f852e3274583b3ebeaa0eaee4f7d` (치환 후 첫 요청) | 6,729 | 5,156 | 1,573 | $0.00026106 |

입력은 줄고 uncached 부분은 늘었다. 이 한 요청의 보고 비용은 줄었지만 출력 길이/다음 행동도 달라
cache 변경만의 효과를 분리한 실험은 아니다. 전체 A/B 비용은 오히려 B가 높았다. “정리하면 항상 싸다”는 결론은 없다.
[OpenRouter caching 문서](https://openrouter.ai/docs/guides/best-practices/prompt-caching)는 Z.AI 자동 캐시와
`cached_tokens` 보고를 설명한다. 실제 적용 단가·routing은 usage를 우선했다.

보조 가정: GLM에서 관측한 토큰 수에 [GPT-4.1 가격](https://platform.openai.com/docs/models/gpt-4.1)
($2 입력 / $0.50 cached / $8 출력, 100만 토큰당)을 적용하면 OMP A/B **$3.09075 / $3.41253**,
Hermes A/B **$0.91415 / $0.94016**이다. 이것은 다른 모델의 실제 성능·청구액이 아니다.

## 한계·실패·재현성

- 합성 filler 위주의 작은 6사례와 반복 3회다. 실제 대형 저장소나 context-window 고갈 시나리오를 대표하지 않는다.
  peak가 48K 미만이므로 강한 context 압박에서의 동작은 평가하지 못했다. 호스트 출력 절단/검색 최적화도 개입한다.
- 파일 단위 라벨은 split read와 다중 파일 명령에 거칠다. 사실 보존은 원문에 실제 존재한 체크리스트만 센다.
- 수집 당시 OMP transcript가 동일 history 배열을 공유했다. 원자료는 보존하고 spec 사용자 prompt 경계로
  실제 턴을 복원했다. 회귀 테스트를 추가했고 이후 수집기는 deep copy한다. 답변/usage/wire는 이 문제의 영향을 받지 않는다.
- 시스템 Python(SQLite 3.51.0)의 Hermes DB read-only 조회가 실패해 분석을 프로젝트 `uv` 환경
  (Python 3.12.15 / SQLite 3.53.4)으로 실행했다. DB schema/원문은 변경하지 않았다.
- OMP custom model metadata는 `identity.class=unknown`, reasoning=false/disableReasoning 설정을 사용했고
  Hermes는 GLM의 필수 reasoning 거부를 피하려 enabled=true를 사용했다. 호스트 간 절대값 비교는 하지 않는다.
- proxy는 non-stream 응답을 SSE로 변환하고 reasoning delta를 재생하지 않는다. 스트리밍 지연이나 실제 UI는 평가하지 않았다.
- summary LLM timeout/validation 품질은 본 run에서 전혀 실행되지 않았다. rule judge는 1회 length 실패 후 재시도했다.
- `store.json.gz`에 items/units를 보존해 격리 HOME 없이도 재분석할 수 있다. 원시 요청·응답은 `wire.jsonl.gz`,
  턴별 답변은 각 세션 `turns.json.gz`, 도구 timing은 OMP `events.jsonl.gz`에 있다. 원자료는 약 17 MiB다.

## 네 질문에 대한 판정

1. **Flash급 모델 도구 사용성: 제한적.** GLM은 실제 ID로 hide/unhide 한 번에 성공했지만 자발적 적용은
   OMP B 18세션 중 1세션, Hermes B 6세션 중 0세션이었다. stale/invented ID 4개도 거부됐다.
2. **hide/summary 품질: hide 정보 손실과 복원은 관찰, LLM summary는 미평가.** rule은 체크리스트 사실을 잃었고
   필요한 원문 한 개를 다시 복원했다. summary 호출이 없어 요약 품질이 좋다/나쁘다 판정할 수 없다.
3. **전체 과제 품질 저하: 이번 사례에서는 관찰되지 않음.** 양 군 24/24 성공·회상 정답이다.
   거의 정리하지 않은 결과이므로 압축의 무해성을 일반화하지 않는다.
4. **cache-miss 비용: 국소 trade-off 확인, 순이익은 입증 안 됨.** 유일한 hide 후 cached 절대량/비율이 줄었지만
   그 요청의 총 비용도 줄었다. 전체 B 비용은 OMP +10.91%, Hermes +5.53%였으며 인과 분리는 불가능하다.

## 회귀 검사

- Paseo `bunx tsc --noEmit && bun test`: **100 pass / 0 fail**, 351 expect.
- OMP `bun test extensions/pi`: **34 pass / 0 fail**, 273 expect.
- `uv run --no-sync pytest`: **363 passed / 11 skipped**.
- harness unittest: **5 tests, OK**. core/Hermes vendor diff 모두 exit 0.
- [검사 로그](../../eval/results/2026-11-09-glm/)의 `checks-*.log` 및 audit JSON을 참고한다.
