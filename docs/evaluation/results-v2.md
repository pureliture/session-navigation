# Session Navigation 평가 v2

제품은 **`5017b97b54f2a920d3c6e213454a4f7faf579bee`**, B-old는 `b1a524e`의 제품
`cc00609`이다. 후속 문서 변경은 제품 차이에서 제외했다.
[설계](design.md) · [v1 결과](results.md) · [재현](../../eval/README.md).

## 범위와 v1 대비

| 항목 | v1 | v2 |
|---|---|---|
| 사용성 모델 | GLM 5.3 Flash | Crouton Alpha / Stealth 고정 |
| 비용 모델 | GLM와 사용성 혼합 | 별도 DeepSeek V4.1 Flash / Relace 고정 |
| 작업 | 3–6턴, 반복 filler, peak <48K | Atlas/Boreal 각 25턴, 서로 다른 telemetry JSONL 20개·오류 분석·코드 수정·회상 |
| 비교 | A/B, 셀별 3회 | A/B-old/B-new, 사례·호스트별 2회; 명령형 Hide/Summarize 별도 |
| 압력 | 128K 선언 window의 약 37% | effective 65,536, native compaction 이벤트 수집 |
| 라벨 | 보호 결과가 일부 분모에 포함 | 정책상 적격 결과만; 예고 보존과 surprise 복구 분리 |

모델·길이·fixture가 달라 v1→v2 차이를 제품 효과로 인과 해석하지 않는다.
같은 Crouton 안의 B-old/B-new가 개선 비교다. 이름이 stealth인 모델의 실제 규모는
공개되지 않았으므로 모든 flash급 모델에 일반화하지 않는다. 호스트는 설치된 OMP SDK
18.18.3 및 실제 Hermes AIAgent이며 설치 파일을 수정하지 않았다.

## 1. Crouton 자율 사용성·과제 품질

24세션 모두 25턴을 완료했다. 각 행은 두 사례 × 2회, 4세션이다.
`calls`는 discovery/정리/복원을 합친 native navigation operation 수다.

| 호스트/arm | calls | literal ID | strict 과제 | 예고 회상 | surprise | native starts |
|---|---:|---:|---:|---:|---:|---:|
| OMP A | 0 | N/A | 4/4 | 4/4 | 4/4 | 52 |
| OMP B-old | 119 | 50/51 | 2/4 | 3/4 | 4/4 | 129 |
| OMP B-new | 105 | 98/102 | 2/4 | 4/4 | 4/4 | 210 |
| Hermes A | 0 | N/A | 4/4 | 4/4 | 4/4 | 17 |
| Hermes B-old | 10 | 4/4 | 4/4 | 4/4 | 4/4 | 18 |
| Hermes B-new | 139 | 102/105 | 4/4 | 4/4 | 4/4 | 0 |

**사전 gate 통과:** B-new 8/8세션에서 서로 다른 경계의 성공 정리 ≥2회,
literal ID 200/207 = **96.6%**(기준 ≥90%). B-old는 4/8세션이었다.
B-new의 서로 다른 성공 경계는 OMP 40, Hermes 83개이며, 선택을 강제하거나 자율 arm에
명령형 정리 지시를 추가하지 않았다. B-new의 정리·복원은 실제 outgoing replacement와
함께 확인했고 단순 discovery만으로 gate를 통과시키지 않았다.

| 호스트/arm | 명시 Hide disposable precision | disposable unique recall | keep_lines calls |
|---|---:|---:|---:|
| OMP B-old | 41/50 (82.0%) | 41/73 (56.2%) | 0 |
| OMP B-new | 77/91 (84.6%) | 61/70 (87.1%) | 33 |
| Hermes B-old | N/A (명시 Hide 없음) | 4/71 (5.6%) | 0 |
| Hermes B-new | 50/58 (86.2%) | 68/68 (100%) | 31 |

precision은 정책 적격 ID 선택 횟수, recall은 세션에서 관측한 적격 disposable ID의
고유 수 기준이다. native compaction 이후 접근 기회가 달라질 수 있어 완전 동일한 기회
분모는 아니다. 필요한 자료의 Summarize는 Hide 오선택으로 세지 않는다.
B-new에는 not_found, invalid_keep_lines_action, verification_failed 등 거절도 있었다.
OMP의 summarizer_unavailable 1건은 최종 사전조건 통과 후 발생했으며 개별 원인은 미확인이다.

| 호스트/arm | prompt 합계 | output 합계 | peak prompt |
|---|---:|---:|---:|
| OMP A | 8,830,371 | 19,925 | 72,440 |
| OMP B-old | 9,889,221 | 28,971 | 72,206 |
| OMP B-new | 7,071,682 | 24,605 | 70,776 |
| Hermes A | 7,042,546 | 79,970 | 53,046 |
| Hermes B-old | 8,623,544 | 97,278 | 52,338 |
| Hermes B-new | 6,637,753 | 17,772 | 41,732 |

Crouton reported cost/cached tokens는 모두 0(누락 아님)이며 유료 비용 절감으로 환산하지 않는다.
OMP는 세 arm 모두 50/75/90%를 넘었다. 65,536은 호스트 선언 soft window이지 API hard
limit가 아니어서 A peak는 110.5%였다. Hermes A/B-old는 약 81/80%에서 native 압축이
작동해 90%는 미도달했고 B-new는 63.7%였다. 모든 호스트·arm에서 세 tier를 달성했다고
주장하지 않는다.

OMP native end는 A의 52개 중 skipped handoff 42개, B-old 129개 중 120개,
B-new 210개 중 206개였다. `shake, skipped=false`는 각각 8/4/2개이고 나머지 handoff
2/5/2개는 applied 여부를 단정할 정보가 없다. 이를 210번의 성공 compaction이라고
해석하면 안 된다. Hermes native end는 A 17, B-old 18개가 success=true, B-new는 0개다.

strict 과제는 모든 턴의 정답과 원본 canonical tests를 요구한다. A 8/8, B-old 6/8,
B-new 6/8로 **무저하를 주장할 수 없다**. B-new의 실패는 즉시 답변의 audit seal 3개
불일치였다(B-old는 18개). 예: `v2cf-omp-atlas-B-new-1` 7턴의 정답
`atlas-82ca4eacc8` 대신 `atlas-4e3d6655d3`를 답했다. 정리 때문에 발생했다는 인과는
분리 검증하지 않았다. 모든 24세션의 canonical tests는 통과했다.
needed-later 치환 이후 파일 재읽기는 B-new 2, B-old 0건; unhide는 각각 12/22회였다.
surprise는 이전에 답했던 audit-02 seal을 예고 없이 재질문한다. 따라서 8/8은 완전히
새로운 정보의 복구나 반드시 원문 unhide를 해야 하는 테스트가 아니라는 한계가 있다.

## 2. 명령형 Hide / Summarize

자율 채택률과 섞지 않은 **16세션**이며, 다음의 16개 replacement는 모두 outgoing copy에서
실제 전송된 것을 확인했다. 사실 점검은 owner/audit seal/latency budget 세 값이다.

| 호스트 | 동작 | B-old 사실 보존 | B-new 사실 보존 | B-new 원문 대비 크기 |
|---|---|---:|---:|---:|
| OMP | rule Hide | 0/6 | **6/6** | 4.18% |
| Hermes | rule Hide | 0/6 | **6/6** | 4.33% |
| OMP | session LLM Summarize | 4/6 | 4/6 | 4.28% |
| Hermes | session LLM Summarize | 6/6 | 6/6 | 3.56% |

B-new의 Hide 합계는 **12/12**, B-old는 **0/12**다. B-new Hide 4세션 중 3세션에서
`keep_lines` 전달을 관측했다(OMP 2, Hermes 1). 나머지도 rule의 high-signal 보존으로
체크리스트를 유지했다. 작은 표본이며 사용자가 명시한 사실이므로 자율 보존 보장은 아니다.

OMP Summarize는 두 제품 모두 budget `151`을 놓쳤다. 이 경우는 원인이 확인된다.
`session-navigation.ts:summarizeText`가 `content.slice(0,12000)`만 새 요약 요청에 넣는다.
실제 요청 `a9727204a09545e280af1f8e281be056`의 12,086자 prompt에는 owner/seal은 있지만
원문 후반 `latency_budget_ms=151`이 없고, 성공해 전송된 summary에도 없다.
`v2cq-omp-command-summarize-B-new-1`에서 최초 요약은 `verification_failed`, 재시도는
성공·전송·unhide에 성공했다. 검증 통과는 체크리스트 완전 보존과 같지 않다.
제품은 이번 평가에서 고치지 않았다. Hermes에는 같은 입력 prefix 제한을 적용하지 않았다.

같은 Crouton 심판은 실제 replacement 16개를 arm 이름 없이 평가했다. 11개는 유효 점수,
5개는 JSON 파싱 실패로 N/A다. Hide는 B-old 4개 모두 1/5, B-new 유효 2개 모두 5/5
(2개 N/A). Summary는 OMP B-old 2개 및 B-new 유효 1개가 1/5(1개 N/A),
Hermes B-old 2개가 5/5, B-new 2개는 N/A였다. 불완전한 심판 평균을 비교하지 않는다.
같은 모델 편향이
있으므로 위 결정적 사실 검사가 우선이며, rule 점수를 LLM summary 점수로 부르지 않는다.

## 3. DeepSeek 비용·캐시

Crouton gate 통과 및 적격 pilot 예산 확인 후에만 본 실행한다.
적격 pilot A는 output 37,701 / reported $0.042182016, B-new는 51,412 /
$0.042343936이었다. 두 세션 합계 **89,113 output / $0.084525952**, 비용 누락 0.
전체 8세션 예상은 `0.084525952 ×4×1.5 + 0.065459492` = **$0.572615204**로
$3 이하임을 보고한 뒤 나머지 6세션을 진행했다. Pilot 분석·stage·safety는 별도로 보존했다.
Reported cost/cached tokens가 1차 지표이며 GPT-4.1 $2/$0.50/$8 per million은
가격 민감도 참고일 뿐 해당 모델을 실제 호출한 결과가 아니다.

**본 실행은 pilot을 포함해 8/8세션 정상 종료**했다. 아래 각 arm은 4세션이며 Crouton
수치는 섞지 않았다. 두 arm 모두 cost/cache 누락 0, 응답 provider 831/831개가 Relace였다.

| 지표 | A | B-new |
|---|---:|---:|
| strict 과제 | 4/4 | 3/4 |
| 예고 회상 / surprise | 4/4 / 4/4 | 4/4 / 4/4 |
| navigation calls / literal ID | 0 / N/A | 169 / 136/151 (90.1%) |
| 성공 경계 / ≥2경계 세션 | 0 / 0 | 47 / 3/4 |
| 모델 요청(모든 유지보수 포함) | 293 | 538 |
| prompt tokens | 13,301,145 | 18,347,328 |
| cached tokens | 12,037,376 | 16,219,648 |
| output tokens | 93,094 | 217,717 |
| **reported cost** | **$0.114316494** | **$0.202722820** |
| GPT-4.1 참조, reported cache 적용 | $9.290978 | $14.106920 |
| 같은 참조, cache 할인 없는 비교 | $27.347042 | $38.436392 |

**비용 이득 없음:** B-new는 reported **+77.33%**(+$0.088406326), 큰 할인 참조에서도
**+51.83%**다. reported 합계 $0.317039314, 부적격 사전 실행까지 실제 지출 합계
**$0.382498806**로 예산 이내다. 입력 비용 증가는 $0.026094826, 출력 비용 증가는
$0.062311500(전체 차이의 70.5%)로 합계와 정확히 맞는다. plugin summary 7요청의
33,043 prompt / 5,007 output / $0.002701758도 B-new 합계에 포함했다.
추가 245요청, 더 많은 재읽기(26 vs 18), 거절과 native 시도(336 vs 44)가 함께 변했으므로
fixed schema·각 도구·압축 각각의 독립적인 비용 기여로 분해하지는 못한다.
B-new 거절에는 not_found 15, invalid_keep_lines 12, protected_error 1, already_hidden 3이 있다.

| 사례(각 arm 2회) | A cost / strict | B-new cost / strict |
|---|---:|---:|
| Atlas | $0.066487588 / 2/2 | $0.101726582 / 2/2 |
| Boreal | $0.047828906 / 2/2 | $0.100996238 / 1/2 |

Boreal B-new 1회는 19턴 audit-18의 owner/seal/budget 답변이 모두 빠졌다. 데이터가
영구 손실됐다는 증거는 아니며 최종 회상·canonical tests는 통과했다. 두 회 반복의 관측
비교이고 cache TTL·모델 확률성·native 유지보수·재시도 행동을 통제한 인과 실험은 아니다.

### Cache-break 가격 민감도

`v2_cache.py`는 마지막 저장 replacement가 처음 실제 전송되는 **92개 요청쌍**을
deduplicate한다. 그중 uncached 증가 양수 부분 합계 433,059 tokens의 가격 차이는
DeepSeek의 input/cache gap $0.001/M에서 **$0.000433059**, 큰 할인 참조의 $1.50/M에서는
**$0.6495885**다. 새 콘텐츠·출력·TTL도 바뀌므로 이 금액은 인과적 cache 손실이 아니다.
또한 저장된 최종 replacement 이전 버전의 모든 전환을 포괄하지 않는다.

실제 예: `249f5d3b655241caa63194f771edfb15` → `e52a1c38ac8d4e719f1a1b55a739693f`:
prompt 40,015→40,501, cached 39,424→19,200, uncached 591→21,301,
reported $0.000345666→$0.000442806. 동시에 output도 290→438로 늘어 전체 차이를
cache에만 귀속할 수 없다. 모든 B-new uncached 토큰이 캐시였다는 극단 비교의 추가 할인도
DeepSeek에서는 $0.002127680에 불과하다. 이 가격표에서는 cache-break만으로 +$0.0884를
설명할 수 없고, 큰 할인 모델에서는 민감도가 훨씬 커진다는 구별이 중요하다.

## 4. 실패·유효성·안전

첫 batch는 headless SDK의 extension callback 초기화가 누락되어 `ctx.model`이 없고
note에 `tokens/?`가 표시됐다. 이어 callback만 연결한 batch에서도 격리 HOME의 Bun
자동 다운로드에 `pi_natives.darwin-arm64.node`가 없어 실제 LLM import가 실패했다.
동일 자식 환경에서 import 실패를 재현했고 기존 SDK의 `NODE_PATH`를 지정하면 성공했다.
최종 harness는 실제 session callback 연결, model/window 일치 및 native import를 시작 시
assert한다. 네트워크 없는 빈 세션 회귀 테스트도 추가했다.

이 두 결함은 제품 효과와 혼동하지 않는다. 초기 batch 전체(Hermes 포함)는
`non-qualifying.json`으로 명시해 paired 최종 통계에서 제외했으며 원문은 삭제하지 않았다.
초기 DeepSeek 2세션 **$0.065459492**도 적격 pilot이 아니지만 예산에는 포함한다.
이는 첫 batch의 `summarizer_unavailable`을 제품 요약 품질 실패로 해석할 수 없다는 뜻이다.

최종 데이터: `eval/results/2026-11-09-v2-crouton-final/`, `-crouton-quality/`,
`-deepseek-final/`. `spec.json`에 fixture hash·제품·모델·provider가 있고 wire에는 실제 요청,
usage, retry가 있다. 압축은 decompressed SHA-256을 대조한 lossless XZ다.
원본은 host history/store에 보존하고 outgoing copy만 치환한다. UI/실제 스트리밍 지연은
평가하지 않았다(proxy가 완성 응답을 SSE로 재구성).

최종 자율 Crouton은 1,829요청, 429 retry 53회/168초; 명령형은 187요청,
5회/32초; 심판은 16요청, 4회/30초였다. 모두 응답 provider가 Stealth였고 모델 전환은
없었다. DeepSeek은 831요청, 429/5xx retry 0회였다. 실패·거절·teardown도 숨기지 않았다.
Hermes의 역사적 Git revision은 새로 확인하지 못했으며 `host-fingerprints.json`의 실제
소스 hash를 재현 식별자로 쓴다. OMP SDK는 18.18.3이다.

`v2cf-omp-atlas-B-new-2`는 25턴·durable transcript 완료 후 `session.dispose()`에서
2시간 이상 종료되지 않아 해당 평가 Bun 및 그 자식 worker broker만 종료했다. 과제·gate
분모에서 빼지 않았고 `post-task-observation.json`과 비정상 exit status를 보존했다.
정상 종료는 23/24이며 SDK teardown 내부 원인은 미확인이다. 이후 harness에는 30초의
별도 teardown 제한을 두었다. 실제 세션 요청의 600초 제한이나 제품 동작은 바꾸지 않았다.

## 네 질문 판정

1. **도구 사용성: 통과(이 모델·표본 한정).** 8/8 경계 채택·96.6% literal ID.
   특히 Hermes B-old 10→B-new 139 calls. 모든 flash급 모델에 대한 결론은 아니다.
2. **Hide/Summary 품질:** Hide 보존 개선은 관측됨. Summary는 Hermes가 체크리스트를
   유지했지만 OMP의 입력 12K 제한 때문에 사실 누락이 남는다. 둘을 일괄 통과로 보지 않는다.
3. **전체 과제 품질: 무저하 입증 실패.** strict A 8/8 vs B-new 6/8. B-old보다 잘못된
   답변 수는 줄었지만 차이가 정리의 인과 효과인지 분리하지 못했다. 회상은 8/8이다.
4. **캐시 비용: 절감 입증 실패.** 별도 DeepSeek +77.33%, 큰 할인 참조 +51.83%.
   이번 가격에서는 추가 출력·요청이 cache 단가 차이보다 지배적이다. Crouton 무료 cost 0을
   절감으로 해석하지 않는다.

## 검증

이번 변경은 eval/docs뿐이며 제품·vendor·설치 runtime은 변경하지 않았다.
최종 harness 검사는 `Ran 16 tests in 2.491s / OK`였다. 변경하지 않은 `5017b97` 제품의
기존 Paseo tsc+Bun 100 pass, OMP 36 pass, pytest 380 passed/11 skipped 및 두 vendor diff 0
결과는 재사용했다(**이번 phase에서 해당 제품 suites를 다시 실행한 결과가 아님**).
새 회귀는 native SDK 빈 세션 binding, deferred Hermes 추출, 경계 dedup, 적격 분모,
숫자 단위 매칭, 모델/provider guard, 예산·누락 처리, lossless archive 및 cache 전환을 다룬다.
