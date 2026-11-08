# pi/omp용 session-navigation

## 설치

저장소에서 다음을 실행합니다. `uv tool install`은 데몬과 Python 의존성을 독립 환경에 설치하므로 설치 후 체크아웃을 옮겨도 실행할 수 있습니다.

```bash
uv tool install --force .
mkdir -p ~/.omp/agent/extensions
cp extensions/pi/session-navigation.ts ~/.omp/agent/extensions/session-navigation.ts
```

기본 실행 파일은 `~/.local/bin/session-navigation-daemon`이며, 없으면 PATH에서 찾습니다. 다른 위치에 설치했다면 OMP 시작 전에 `SESSION_NAVIGATION_DAEMON`에 실행 파일의 절대 경로를 지정합니다. 기존의 Python 파일 경로는 지원하지 않습니다. 설치 또는 변경 후 OMP 프로세스를 재시작해야 새 확장이 로드됩니다.

현재 `read` 도구의 단일 텍스트 결과만 압축합니다. 오류 결과, 이미지가 포함된 결과, 중복 호출 ID와 확인되지 않은 요청은 원본을 유지합니다. 모델 응답이 확정된 요청의 결과만 압축 대상으로 사용할 수 있습니다.

데몬이 시작되지 않거나 종료되면 원본 context를 그대로 사용합니다. 데몬이 바쁜 동안 새 context는 기다리지 않고 원본을 사용합니다. 타임아웃이나 취소 시 데몬을 종료하므로 압축 상태도 사라집니다. 압축 상태는 메모리에만 있고 세션 파일의 원본은 유지됩니다. 세션별 후보는 최대 64개, 합계 4 MiB이며, 범위를 넘으면 해당 요청 전체를 원본으로 유지합니다.

## 요약기 설정

OMP 시작 전에 다음 환경 변수를 설정합니다.

```bash
export SESSION_NAVIGATION_BASE_URL=http://127.0.0.1:12347
export SESSION_NAVIGATION_MODEL=mlx-community/LFM3-1.7B-OptiQ-4bit
export SESSION_NAVIGATION_TIMEOUT=20          # optional, 최대 20초
export SESSION_NAVIGATION_MAX_INPUT_BYTES=12288  # optional
export SESSION_NAVIGATION_MAX_OUTPUT_TOKENS=384  # optional
```

설정하지 않으면 `summarize_session`은 `summarizer_unavailable`을 반환하며 `compact_context`는 사용할 수 있습니다.
