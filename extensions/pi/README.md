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

## DB 오류 처리

DB 오류 시 대화형에서는 중단/원본 전송을 선택하고, 비대화형(pipe/background, `rpc`/`json`/`print` 모드)에서는 중단합니다. 원본을 조용히 전송하지 않습니다.

## TUI

`/session-navigation` 명령으로 행 목록 오버레이를 엽니다(TUI 모드 전용). 행 단위 Hide/Unhide/Re-hide와 Manage, CAS-stale 자동 새로고침, DB 오류 선택 UI를 제공합니다.
