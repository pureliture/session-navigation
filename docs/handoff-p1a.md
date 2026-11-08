# P1a Handoff — 신규 세션 착수용 (2026-11-08)

## 전체 Goal (locked)

> session-navigation 전체 목표: tool-result의 hide·unhide·rehide·manage가 SQLite
> 영속화로 프로세스 재시작과 세션 fork 이후에도 유지되고, Hermes terminal·OMP
> read·bash 포함 자동관리와 Paseo Explorer·OMP TUI·Hermes TUI 3개 UI에서의 동일
> 조작을 제공하며, E2E(재시작·fork·DB오류·비대화형·3UI 동시조작·대용량)와 전체 회귀
> green(기저 결함 수정 포함)을 통과한다. 범위 밖: 메시지 row 수동숨김,
> remove(영구삭제), 설치본 배포, 운영 런북. 성능: 목록 1000건 <1s, 요약 timeout 25s,
> DB 용량 상한 없음.

산출물: spec + handoff + Hermes 규약 갱신 + 사용법 3종(Paseo/OMP/Hermes).

## 배경 (3줄)

session-navigation 도구 개명 완료·검증済 (`hide/summarize/unhide/list/manage_context`).
D1–D10 스펙 잠금 (`docs/spec.md`). 남은 작업: SQLite 영속화 → 세션모델 요약 →
Paseo/OMP/Hermes UI. P1a(Argon SQLite + Free denylist/list)부터 착수.

## 확정 스펙 위치

- `docs/spec.md`: D1–D10 전부. 구현 계약 포함.
- `docs/hermes-human-supervision.md`: Hermes 채팅 규약 (개명 반영済).
- 검증 근거: Hermes 단위비교·OMP 3단위·Palantir row(message 단위) — 이전 세션 결론만 인용,
  필요시 재조사.

## 에이전트 편성 (3개, Flash·DeepSeek 미사용)

| 에이전트 | 프로필 | 담당 |
|---|---|---|
| Gemini Argon | `antigravity/gemini-4-argon-high`, mode `full-access` | P1a SQLite store |
| OMP Free | `omp/opencode-go/crouton-alpha-free`, mode `full`, thinking `xhigh` | P1a denylist+list → 매 페이즈 스모크 → P2 Paseo → P3 TUI |
| OMP Muse | `omp/opencode-go/muse-spark-1.3-contributor`, mode `full`, thinking `max` | P1b OMP+Hermes 세션요약 (순차) |

## P1a-1: Argon 프롬프트 (그대로 사용)

```text
session-navigation SQLite 영속 저장 구현. 저장소 /Users/ddalkak/Projects/session-navigation,
스펙 docs/spec.md D7·D9·식별계약이 binding.

구현:
1. src/session_navigation/store_sqlite.py 신규: SqliteContextStore
   (MemoryContextStore 동일 공개 인터페이스).
2. 경로 ~/.local/share/session-navigation/state.sqlite3, dir 0700, db 0600,
   WAL은 SQLite ≥3.51.3(또는 3.44.6/3.50.7 backport)일 때만, else rollback journal.
3. 키: (scope_key, tool_call_id, content_sha256, invocation_digest) — content-hash 단독 금지.
4. 상태 전이 트랜잭션 + 버전 CAS (stale writer 거부). unhide는 요약 보관, rehide는 재사용.
5. fork: 분기지점까지 복제 후 독립 (새 scope_key, 식별 검증 후 적용).
6. TTL 만료·용량 상한 없음. 디스크부족은 명시 오류, live 항목 silent evict 금지.
7. DB 오류: interactive는 호출자에게 선택 위임할 수 있게 structured error,
   non-interactive는 abort. hide 성공으로 보고 금지.
8. engine.py 연결: SqliteContextStore 주입, MemoryContextStore는 테스트/fallback용 유지.
9. 마이그레이션 없음 (fresh start).

제약: daemon.py·factories.py 직접 수정 금지 (P1b 소유). vendor/ 수정 금지
(오케스트레이터가 동기화). pytest 통과 필수. 사용자 데이터·설정·자격증명 접근 금지.
임시 DB는 /tmp + 테스트 후 삭제.
```

## P1a-2: Free 프롬프트 (그대로 사용)

```text
session-navigation 기계적 확장 2건. 스펙 docs/spec.md D6·D8.

1. policy.py: 파괴적 명령 denylist — rm, git reset --hard 등가물.
   invocation 기준 판정 (내용 패턴과 별개). 자동(manage_context) 제외, 수동 hide 허용.
   거부 코드: destructive_command.
2. list 경로: list_context_items가 hidden+unhidden 둘 다 반환, 상태 컬럼 구분.
   handlers.py list_records + Hermes presentat
...[truncated 2222 chars]