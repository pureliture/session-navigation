# Session Navigation 평가 v2

v1은 [보관 설계](design-v1.md)·[GLM 결과](results.md)·기존 raw data를 그대로 유지한다.
B-old=`b1a524e`(제품 `cc00609`), B-new=`5017b97`, A=플러그인 없음이다.
후속 문서 커밋은 제품 차이에 넣지 않고 각 제품을 격리 source snapshot에서 로드한다.

## 단계·모델·사전 gate

1. 사용성/품질은 **`stealth/crouton-alpha`만**, provider **Stealth** 고정.
   A/B-old/B-new × 2 장기 사례 × 2회 × OMP/Hermes = **24세션**.
   반복별 arm 순서를 교대한다. 2회는 사전 결정이며 실패를 숨기지 않는다.
   별도 commanded Hide/Summarize는 2호스트 × 2제품 × 2회 × 2동작 = **16세션**.
   명령형 표본은 자율 채택률 분모에서 제외한다. 심판도 Crouton만 사용한다.
2. B-new 자율 세션 절반 이상에서 서로 다른 경계의 성공한 정리가 2회 이상이고,
   선택 ID 유효율 ≥90%이면 비용 단계로 진행한다. 아니면 중단·보고한다.
   **`deepseek/deepseek-v4.1-flash-1017`만**, provider **Relace** 고정.
   A/B-new × 2사례 × 2회, OMP **8세션**을 계획한다. 먼저 같은 사례 A/B-new
   각 1세션 pilot의 출력 토큰·reported cost와 전체 예상 비용을 보고한다.
   보수적 예상(`pilot 두 세션 비용 ×4×1.5 + 부적격 사전 지출`, pilot 포함)이 **$3 이하일 때만** 나머지를
   실행하고, 초과/비용 누락이면 중단하고 묻는다.

단계별 proxy는 해당 모델 **하나만** 허용하고 upstream에
`provider.order=[고정 provider], allow_fallbacks:false`를 강제한다. 실제 provider도 저장한다.
단계 사이에 proxy를 종료한다. 429/5xx는 Retry-After·지수 backoff 및 횟수·지연을 기록한다.
Crouton이 불가능하면 다른 모델로 대체하지 않는다.

사전 Stealth pin probe: 64-token 한도는 출력 없이 length 종료,
2,048-token 한도는 `OK`, prompt 2/completion 1/cost 0/cached 0을 보고했다.
둘 다 설치 점검이며 본 통계에서 제외한다. 작은 한도도 출력 전 reasoning으로 소진될 수 있다.

## 작업과 압력

`eval/v2_fixtures.py`의 Atlas/Boreal은 각 **25 사용자 하위 작업**이다.
20개 고유한 문서는 시간·지역·트래픽·CPU·큐·지연·worker pool의 실제 형태 JSONL이며
hash로 정해진 서로 다른 관측치를 가진다. 같은 filler를 반복하지 않는다.
전체 문서 검토, 보호 오류 분석, 작은 코드의 진단/수정/원본 테스트, 두 회상 과제로 구성한다.
정답·라벨은 agent 작업공간 밖에 두고 사용자 턴은 세 arm에서 동일하다.

effective window는 **65,536**으로 줄인다(실제 API 최대 window와 구별).
OMP native compaction은 95% threshold, reserve 4,096/recent 8,192로 설정하고 이벤트를
기록한다. Hermes도 window를 pin하고 native compressor의 원래 threshold와 호출 전후를
기록한다. native 유지보수와 plugin summary 호출 비용도 모두 proxy를 통과해야 한다.
50/75/90% 도달 여부를 실제 보고 토큰·호스트 추정치로 나눠 확인한다.
압력 미도달을 near-limit 성공으로 부르지 않는다. B의 정리가 압력을 낮추면 동일 workload A와
비교한다. 자율 arm에 외부 정리 지시는 추가하지 않는다.

audit-01/08/15의 **예고된 보존 의무**와 audit-02의 **예고하지 않은 복구 질문**을 분리한다.
surprise 질문 때문에 disposable 라벨을 사후 변경하지 않는다. 보호 오류/status 및
크기·형식·정책상 부적격 결과는 precision/recall 분모에서 제외한다.
관측한 실제 tool-call ID 단위로 매칭하며 표시 제한을 대상 제한으로 쓰지 않는다.

## 지표와 안전

- 호출 수·경계 시점·ID 유효율·거절, 적격 disposable precision/recall. 필요한 자료를
  summarize로 보존한 선택은 별도다. Hide의 사실·keep_lines 보존과 LLM summary의 사실·환각·
  압축률·실제 전송·재읽기/복원은 명령형/자율 표본을 분리한다.
- 과제·canonical tests·예고 회상·surprise 복구, 턴/모델 요청, peak/총 토큰,
  native compaction 횟수·시점·비용. 실패/미완료도 분모에 남긴다.
- 1차 비용은 reported `usage.cost`, 캐시는 reported cached tokens다. 누락은 0 아닌 N/A.
  누락 시 consecutive `{messages,tools}` JSON LCP 기반 추정만 별도 표시한다.
  Relace의 작은 할인(input/cache/output **$0.006/$0.005/$0.50 per million**) 외에
  GPT-4.1 참조(**$2/$0.50/$8**)를 적용하고 prefix 변경 시 cached/uncached 변화를 분리한다.
  provider pin은 TTL·batching까지 통제한다는 뜻은 아니다.
- 심판은 arm을 가리고 원문·실제 replacement·체크리스트만 평가한다. 같은 모델 편향을
  명시하며 결정적 사실 검사보다 우선하지 않는다.
- key는 환경에서만 읽고 proxy 밖 자식에 넘기지 않는다. 실제 HOME/config/runtime은 수정하지
  않으며 byte-exact hash와 최종 key audit를 수행한다. wire와 큰 로그는 gzip으로 보관한다.
  제품 SHA·host 버전·fixture hash·provider·retry·gate를 [v2 결과](results-v2.md)에 남긴다.

## Headless OMP 사전조건·부적격 실행

SDK 생성만으로 extension host callback이 초기화되지 않는다. SDK의 공개
`extensionRunner.initialize()`에 실제 세션 model/usage/action을 연결하고, 각 세션 시작 시
확장 context의 model/window 일치와 `completeSimple`의 실제 import(native addon 포함)를
검증한다. 격리 HOME에서 Bun의 자동 다운로드가 native addon 없는 다른 복사본을 선택하지
않도록 `NODE_PATH`는 설치된 SDK의 기존 `node_modules`를 읽기 전용으로 지정한다.
제품·설치본은 고치지 않는다. 빈 세션 회귀 테스트는 네트워크 없이 이 사전조건을 검사한다.

초기 v2 실행은 callback 누락 및 native import 실패가 확인되어 **전체 batch를 최종 통계에서
제외**한다(Hermes도 paired batch에서 함께 제외). 삭제하지 않고 `non-qualifying.json`과
원문을 보존한다. 최초 DeepSeek 2세션 $0.065459492도 적격 pilot으로 쓰지 않으며 실제 지출
상한에는 더한다. 최종 사용성 gate·pilot·본 실행은 수정된 harness로 다시 측정한다.
native compaction start/end는 시도 이벤트이며 skipped/aborted 여부를 구별한다.
