# pi/omp용 session-navigation

## 설치

저장소에서 다음을 실행합니다. `uv tool install`은 데몬과 Python 의존성을 독립 환경에 설치하므로 설치 후 체크아웃을 옮겨도 실행할 수 있습니다.

```bash
uv tool install --force .
mkdir -p ~/.omp/agent/extensions
cp extensions/pi/session-navigation.ts ~/.omp/agent/extensions/session-navigation.ts
```

기본 실행 파일은 `~/.local/bin/session-navigation-daemon`이며, 없으면 PATH에서 찾습니다. 다른 위치에 설치했다면 OMP 시작 전에 `SESSION_NAVIGATION_DAEMON`에 실행 파일의 절대 경로를 지정합니다. 기존의 Python 파일 경로는 지원하지 않습니다. 설치 또는 변경 후 OMP 프로세스를 재시작해야 새 확장이 로드됩니다.

## 범위

`read`와 `bash` 도구의 단일 텍스트 결과를 숨김 대상으로 합니다. 오류 결과, 이미지가 포함된 결과, 중복 호출 ID와 확인되지 않은 요청은 원본을 유지합니다. 모델 응답이 확정된 요청의 결과만 숨김 대상으로 사용할 수 있습니다.

파괴적 명령(`rm`, `git reset --hard` 등)은 자동 관리에서 제외되며 수동 숨김만 가능합니다.

## 영속화

숨김 상태는 `~/.local/share/session-navigation/state.sqlite3` 단일 파일에 저장되며 프로세스 재시작과 세션 fork 이후에도 유지됩니다. 저장 범위: 스냅샷 확인은 프로세스별(재시작 후 다음 context 이벤트에서 재확인), 숨김 항목·identity fence는 영속. 세션 파일의 원본은 유지됩니다. 요청 전체의 후보 수·합계 크기에는 제한이 없습니다. 전송은 최대 64개·4 MiB JSON 메시지로 나누며, 첫 `prepare` 이후 같은 `snapshot_id`에 `append: true`로 누적합니다. 각 응답은 해당 청크의 패치와 요약 작업만 반환합니다. 단일 레코드가 메시지 한도를 넘으면 원본을 유지합니다. 데몬은 세션별 최신 스냅샷 하나와 최대 32개 세션만 메모리에 보관합니다.

## 요약기

세션 모델만 사용합니다. 확장이 `completeSimple` + `modelRegistry.resolver`로 대상 텍스트 요약을 얻어 데몬에 전달합니다(25초 타임아웃). 데몬 자체는 모델을 호출하지 않습니다. 세션 모델이 없으면 `summarize_context`는 `summarizer_unavailable`을 반환하며 `hide_context`(규칙 기반)는 사용할 수 있습니다.

Paseo/CLI에서 요청한 pending 요약은 다음 context 훅에서 기다립니다. 준비 시점에 pending인 항목만
최대 4개씩 생성하며, 큐 대기를 포함한 모델 대기 단계 전체에 25초 예산을 적용합니다. 검증·저장 후 패치를 다시
조회하므로 성공한 요약은 **그 요청부터** 전송됩니다. 시간 초과·모델 부재·검증 실패 시에는 규칙
발췌를 사용합니다. 원본 세션 기록은 바꾸지 않습니다.

## 요청 사본 안내와 보존할 줄

새 사용자 턴(후보가 처음 생길 때까지 대기)과 같은 턴의 50/75/90% 사용량 구간에서,
후보가 있으면 요청 끝에 안내를 추가합니다. 전체 후보 수와 최대 3개 ID·도구·경로/명령·크기·턴을
1,000바이트 이내로 표시하며 ID는 줄이지 않습니다. 오래된 요청 prefix와 세션 기록에는 넣지 않습니다.
표시 한도는 선택 제한이 아니며 정리 시점·대상·hide/summarize는 에이전트가 판단합니다.
사용량은 호스트 추정값(없으면 문자 기반 추정), window를 모르면 `?`로 표시합니다.

`manage_context({tool_call_ids:[...],action:"hide",keep_lines:["owner=Orchid"]})`는
선택한 각 원문의 해당 부분을 포함하는 줄을 그대로 보존합니다. 전송용 JSON envelope/줄번호를
제거한 본문 기준의 한 줄짜리 exact substring이며, 전체 1,024바이트 한도입니다.
모든 대상에 같은 목록을 적용하되, 대상에 없는 값이나 잘못된 항목만 무시합니다.
응답의 `keep_lines_ignored`에 무시한 원문과 영어 이유를 대상별로 반환하며 나머지는 정상 적용합니다.
앞뒤 공백과 `20:owner=...` / `20|owner=...` 줄번호는 원문 그대로의 일치가 없을 때 정규화하고
`keep_lines_normalized`에 알립니다. 한도 초과 항목은 입력 순서대로 건너뛰며 원문은 바꾸지 않습니다.
다른 action과 함께 쓰면 `invalid_keep_lines_action`, 기존 대체문과 충돌하면 `keep_lines_conflict`입니다.
규칙 발췌는 head/tail·필수 증거와 함께 주요 대입문·경고를 추가 바이트 예산 내에 남깁니다.

## DB 오류 처리

DB 오류 시 대화형에서는 중단/원본 전송을 선택하고, 비대화형(pipe/background, `rpc`/`json`/`print` 모드)에서는 중단합니다. 원본을 조용히 전송하지 않습니다.

## TUI

`/session-navigation` 명령으로 행 목록 오버레이를 엽니다(TUI 모드 전용). 행 단위 Hide/Unhide/Re-hide와 Manage, CAS-stale 자동 새로고침, DB 오류 선택 UI를 제공합니다.
