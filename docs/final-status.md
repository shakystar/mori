# mori 최종 구현·검증 상태

> **판정 기록 · 동결됨 (커밋 `8337019` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

정리일: 2026-09-23. 구현 기준: `833701977599a9622886d2de6543b29c093efbd6`.
이 정리에서 프로덕션 코드와 기존 테스트를 변경하지 않았다. 라이선스·공개 문서는 별도로 추가했다.

## 구현과 근거

| 영역              | 기준 버전의 상태         | 코드·검증 근거                                                                                                                                                                         | 범위와 한계                                                                           |
| ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CLI·REPL·세션 API | 구현                     | `packages/mori/src/index.ts`, `session.ts`, `cli/repl.ts`와 인접 테스트                                                                                                                | 세션 API의 순차 실행·종료 대기 포함. 전체 대화의 프로세스 재시작 복구는 별도          |
| 관측 수집         | 구현                     | `packages/mori/src/kernel/index.ts`, `packages/kernel/src/services/capture-service.ts`, `tests/integration/capture-observation.test.ts`                                                | 도구·명령 필터가 있으며 모든 행동을 무조건 기록하지 않음                              |
| 대화 pull 어댑터  | 구현·기본 실행 경로 연결 | `createHarnessConversationSource`와 `prepareAgent`; `packages/mori/src/agent/harness-conversation-source.test.ts`                                                                      | 같은 Session의 entry log 사용. 메모리 DB가 생성되지 않은 순수 대화의 수집 제약이 남음 |
| 증류              | 구현                     | `packages/kernel/src/services/consolidate-service.ts`; `tests/integration/consolidate-service.test.ts`                                                                                 | 실제 LLM 호출은 설정에 의존. 구조 검증과 추출 품질은 다른 문제                        |
| 압축 이후 증류    | 구현·배선됨              | `compactIfContextFull`, `subscribePostCompactConsolidation`; `packages/mori/src/cli/compaction.test.ts`                                                                                | 백그라운드 증류. 모든 이전 결정이 항상 복구된다는 보장은 없음                         |
| 검색·주입         | 구현                     | `search-service.ts`, `memory-retrieval-service.ts`, `SqliteMemoryKernel.transformContext`; `tests/integration/kernel-context-injection.test.ts`                                        | 주입 예산·랭킹 존재. 일반적인 답변 품질 향상은 확정하지 않음                          |
| 저장·동시성       | 구현·회귀 테스트 존재    | `storage/event-store.ts`의 `appendEvents`, `services/projection-store.ts`; `compare-and-append-race.test.ts`, `consolidate-evidence-binding.test.ts`, `projection-rebuild-cas.test.ts` | 커밋 시 로그 head 검사와 로그 기반 증거 바인딩. SQLite에서 검증한 범위                |
| 평가 하네스       | 구현                     | `packages/mori/src/bench/preference-regression/`, `bench/cache/`, `bench/cost-ledger.ts`                                                                                               | ON/OFF/ORACLE, 비용, 캐시. 후속 대규모 평가는 미완료                                  |
| 공유 서버 연결    | 최종 제품 경로 미완료    | 연관 저장소 mori-nest, 이슈 #115                                                                                                                                                       | 로컬 커널과 서버의 개별 구현을 자동 동기화 완료로 합쳐 주장하지 않음                  |

표에서 파일명이 짧게 적힌 커널 서비스는 `packages/kernel/src/services/`,
커널 테스트는 `packages/kernel/tests/integration/` 아래에 있다.
코드의 주석과 과거 문서가 충돌하면 실제 실행 경로와 테스트를 우선한다.

## 이번 재현 결과

Node 22.23.1 · pnpm 10.30.3 · Linux에서 lockfile을 고정해 설치했다.
실행 자격증명을 전달하지 않고 임시 설정 디렉터리를 사용했다.
모델 API 평가와 `--record`는 실행하지 않았다.

| 검사                                            | 결과                                                  |
| ----------------------------------------------- | ----------------------------------------------------- |
| `pnpm build`                                    | 통과                                                  |
| `pnpm typecheck:test`                           | 통과                                                  |
| `pnpm lint`                                     | 통과                                                  |
| `pnpm test:ci-scripts`                          | 통과                                                  |
| 커널 테스트 단독 실행                           | 66개 파일, 560 통과·1 건너뜀                          |
| 하네스 테스트 (`pnpm test` 중 해당 패키지 결과) | 47개 파일, 469 통과·2 건너뜀·1 실패                   |
| 캐시 재생 (`node --import tsx .../pr-smoke.ts`) | 9개 시나리오×조건, hit 45·miss 0, 실제 모델 호출 없음 |

**전체 테스트가 통과했다고 표시하지 않는다.** 하네스의 실패 1건은
`src/tools/bash-jail.test.ts`의 작업 루트 내부 쓰기 검사다.
이 호스트에서 `unshare --user --map-root-user --mount -- true`가
`/proc/self/uid_map: Operation not permitted`로 실패했다.
격리 기능을 끄거나 테스트를 건너뛰는 코드 변경은 하지 않았다.
커널 검사는 병렬 실행 중 다른 패키지 실패로 중단되어 단독으로 다시 실행했다.

건너뜀 3건은 루트 사용자 환경에서 디렉터리 쓰기를 거부할 수 없어 기존 조건부 테스트가 제외한 항목이다
(`packages/kernel/tests/unit/db.test.ts`, `packages/mori/src/kernel/index.test.ts`).
캐시 재생의 원래 명령 `pnpm bench:pr-smoke`는 이 호스트의 tsx CLI용 Unix socket 생성 제한으로 시작하지 못했다.
동일 소스를 Node의 tsx import 경로로 실행해 재생 결과를 확인했다. 호스트의 보안 설정은 변경하지 않았다.

### 과거 CI와 구분

- [마지막 확인된 성공 CI](https://github.com/shakystar/mori/actions/runs/33312410067): `1a29c64`, 2026-08-30.
- 성공 커밋에서 기준 버전 `8337019`까지의 변경은 문서 두 개뿐이다. 실행 코드·테스트·lockfile은 같다.
- [기준 버전 CI](https://github.com/shakystar/mori/actions/runs/33330657606)는 실패 표시이며 steps가 비어 있다.
  로그 요청은 보존된 로그를 반환하지 않았다. 이 실행의 정확한 실패 원인은 확정하지 않았다.
- 기존 성공 기록과 이번 부분 재현을 합쳐 최신 전체 CI 통과로 표시하지 않는다.

## 평가에서 확인한 것

[2026-08-30 분석](bench/preference-regression-variance-decomposition-2026-08-30.md)과 원자료를 함께 읽는다.
이번 정리는 JSON 재집계이며 새로운 모델 실험이 아니다.

| 시나리오          | 기존 3회차의 관측                                                                | 종료 시 해석                                                         |
| ----------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| tabs-indentation  | ON−OFF 평균 차이가 0 → −0.333 → +0.100                                           | 부호가 안정적이지 않음                                               |
| concise-responses | ON−OFF 평균 차이가 −0.500 → −0.167 → −0.500                                      | 해당 설정에서 부정적인 관측. 일반적인 기억 효과로 확대 해석하지 않음 |
| pnpm-workflow     | 외부 작업 디렉터리 참조로 오염. 8월 29일 회차의 오염 표식 제외 후 OFF 3건·ON 4건 | 독립적이고 충분한 표본에 근거한 효과 판정 불가                       |

8월 29일 JSON의 비용 원장은 약 $0.2450을 기록한다. 이는 **한 회차의 기록**이며,
프로젝트 총비용이나 현재 가격이 아니다. 비용·캐시 조건이 다른 회차를 합쳐 일반 단가로 쓰지 않는다.

`LongMemEval v1`의 전량 ON/OFF/ORACLE 결과는 이 기준 버전에 없다.
예산 문서, V2 로더, 미병합 v1 PR은 완성된 v1 실험 결과와 구분한다.

## 재현 명령

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck:test
pnpm lint
pnpm test
pnpm test:ci-scripts
pnpm bench:pr-smoke
```

전체 테스트는 Linux의 `/bin/bash`, `/proc`, user/mount namespace 지원을 전제로 한다.
제한된 호스트에서는 실패 원인과 실행 범위를 기록한다. 통과를 위해 격리 보호를 완화하지 않는다.
이번 확인에서 사용한 제한 환경용 캐시 재생 명령은 다음과 같다.

```bash
node --import tsx packages/mori/src/bench/preference-regression/pr-smoke.ts
```

`bench:nightly-slice`, `bench:milestone`, `bench:pr-smoke:record`는 이 무료 재현 경로에 포함하지 않는다.

## 남겨 둔 작업

- #7: 압축·증류 배선은 구현됐으나 로드맵 전체의 효과 검증까지 완료된 것은 아니다.
- #115: replica 위치·자동 join·push/pull 통합 등 후속 설계·연동.
- #344, #507–#509: LongMemEval v1 평가 준비·배선·실행.
- #504: 선호 평가 표본 확대와 오염 없는 재수집.
- #123, #457, #458: TUI, 원료의 도메인 중립성, 증류 기준 개인화.
- 열린 PR #516, #517, #519, #521, #523은 이 구현 기준에 포함하지 않았다.

종료는 위 과제를 완성했다는 의미가 아니다. 구현·검증 범위를 이 상태로 보존한다.
