# Source of Truth (SoT)

memorize의 sync / workspace / 기억 아키텍처에 대한, 하중을 지는 불변식과 확정된
결정들. 2026-07-01 설계 논의에서 추려냈다. 설계 질문을 다시 꺼내기 **전에** 여기를
먼저 본다 — 확정된 것은 이 문서들 중 하나에 있고, 미결인 것은 `900-open-decisions.md`에
있다.

## 상태 범례 (Status legend)

- **Invariant (불변)** — 우리가 고른 아키텍처(append-only 이벤트 로그, union sync,
  local-first)가 *강제*하는 것. 바꾸려면 설정을 토글하는 게 아니라 모델 자체를 바꿔야
  한다. 이 시스템의 물리법칙으로 취급한다.
- **Decision (결정)** — 의도적으로 *선택*한 것. 명시적으로 대체되기 전까지 유효하다.
  바뀔 수 있으나, 무엇을 대체하는지 밝히는 새/수정 SoT 문서로만. 조용히 바꾸지 않는다.
- **Open (미결)** — 아직 안 정함. `900`에 두어 확정으로 오해되지 않게 한다.

## 규율 (자기 dogfooding)

이 SoT 세트는 자신이 기술하는 이벤트 로그와 **똑같은 append-and-supersede 모델**을
따른다. 확정된 문서를 제자리에서 덮어쓰지 않는다. Invariant나 Decision을 바꾸려면
대체 문서를 추가(또는 `대체됨:` 지정)하고 옛 문서는 audit trail로 남긴다. 깔끔함보다
추적가능성이 우선이다 — 행 삭제 대신 retraction을 쓰는 것과 같은 원리(`050` 참고).

## 인덱스 (Index)

| 문서 | 주제 | 주 상태 |
| --- | --- | --- |
| 010 | 표면(surface)과 단 하나의 하드 경계 | Invariant |
| 020 | 정체성과 git/GitHub 토폴로지 | Decision (021이 부분 대체) |
| 021 | 로컬 정체성(proj_)과 통합 워크스페이스 정체성(wsp_) | Decision (022가 메커니즘 부분 대체) |
| 022 | 워크스페이스 정체성은 control-plane이다 (workspace.created 이벤트 아님) | Decision |
| 030 | sync와 merge (append-only union) | Invariant |
| 031 | canonical 원격 sync는 Hub(server-minted id); file transport deprecated | Decision |
| 040 | 워크스페이스 공유와 용량 | Decision |
| 041 | 프로젝트 간 작업 위임은 제안-수락이다 | Decision |
| 042 | 위임 전달: 송신 즉시 push + 세션-묶인 워처 | Decision |
| 043 | mid-session sync 케이던스: 워처 틱의 pull+push ("watcher sync") | Decision |
| 050 | 삭제와 revert (tombstone) | Invariant |
| 060 | 저장 위치(locality)와 검색 | Decision |
| 070 | 보안 입장 (at-rest, E2E 아님) | Decision |
| 080 | task 라이프사이클과 상태 전이 (start=in_progress, 엄격 handoff) | Decision |
| 081 | agent-talk — 공유 로그 store-and-forward 소통, 책임은 claim | Decision |
| 900 | 미결 결정 | Open |

## 출처 (Source)

2026-07-01 설계 논의. 진단 + 마일스톤 동반 문서:
`docs/plans/2026-07-01-sync-workspace-source-of-truth.md`.
