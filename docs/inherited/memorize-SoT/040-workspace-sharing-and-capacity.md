# SoT-040: 워크스페이스 공유와 용량

상태(Status): Decision
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

워크스페이스에서 각 멤버는 **자신의 프로젝트 DB를 통째로** 업로드하고, 각 멤버의 로컬
store는 모든 멤버 프로젝트 기억의 **union**이 되어 그 프로젝트의 통합 기억으로 쓰인다.
"내 프로젝트 기억"과 "통합 공유 기억" 사이에 **물리적 격리가 없다** — 하나의 DB이며
provenance로 구분한다. projection은 **`(엔티티, writer)`로 group-by 하고 다중 writer
상태를 단일 정본 값으로 절대 접지 않는다**. 작업 상태(task/handoff/session) 공유는
의도된 협업 가치이지 누수가 아니다. 회수불가는 수용한다.

공유 union은 **raw 권위층 + consolidated 파생 view** 두 층으로 보관한다: raw는
provenance를 진 권위·복구 기반이고, consolidated는 그 위의 dedup·cluster·모순플래그된
**재생성 가능한 view**(서버 생성)다. raw segment와 더 세밀한 실시간 시그널까지 **기본
포함**해 공유하며("캡처되면 기본 공유"), 팀은 워크스페이스별로 **opt-out**할 수 있다.

## 근거 (Why)

서로의 작업 상태를 보는 것이 팀이 공유하는 *이유*다; provenance + group-by projection은
"Bob의 현재 task"를 "내 현재 task" 옆에 덮어쓰지 않고 나란히 둔다. 멱등 event-id
dedup(`030`)이 내 이벤트를 재다운로드하지 않게 하므로 "내 것 제외 union"에 특별 처리가
필요 없다. 용량은 **제약이 아니다**: 실측된 가장 큰 store(이 repo 자신의 프로젝트, 수개월
멀티에이전트 작업)가 **전체 9.9 MB** — 정제 지식 **~0.6 MB**, raw 이벤트 ~1.8 MB,
segment는 하드캡(`SEGMENT_RETENTION_MAX=2000`, 30일, 천장 ~2.5 MB), 임베딩 ~4.4 MB지만
**파생물이라 재계산 가능, 전송 안 함**. 공유 대상 층의 replicate는 sub-1 MB다.

## 함의 (Implications)

- 워크스페이스(cross-account) push에서 빠지는 유일한 것은 개인 store(`010`)다 — 프로젝트
  push에 이벤트별 scope 필터가 필요 없다. (개인 store 자체는 같은 계정의 기기 간으로는
  sync되며, 막히는 것은 cross-account 방향뿐이다 — `010`.)
- writer 간 단일 전역 "현재 X"를 절대 projection하지 마라; projection 키에 writer
  정체성을 항상 남겨라.
- 인바운드 오염은 `writer` / `source project_id` 필터로 복구한다 — raw union에선 깔끔,
  consolidation 단서는 `050` 참고.
- 용량은 확정이다: replicate-vs-쿼리를 store 크기로 설계하지 마라. 축은 바이트가 아니라
  ACL 입도 / 회수가능성(`060`)이다.
- **멤버십 = publish**: 별도 per-item publish 권한이 없다(통째 sync). 역할은 최소 2개 —
  **owner/admin**(워크스페이스 생성·멤버십 관리·남의 것 포함 전역 retract)과 **member**
  (sync = publish, 자기 것 retract). 모든 동작은 provenance로 추적·역전된다(`050`).
- 읽기는 budget 제한된 주입에 **consolidated view**를 쓰고, 각 assertion은 raw
  provenance로 drill-down한다(`060`). consolidated 갱신·복구는 raw에서 재파생한다(`050`).

## 경계 (Boundaries)

공유 union의 raw-vs-consolidate는 **둘 다(층상)로 확정**됐다(위 진술) — 더는 미결이 아니다.
기억 텍스트의 실수 비밀은 content-sanitization 관심사로 여기서 다루지 않으며, opt-out한
팀의 raw 비공유 동작도 캡처-층/정책 트랙이다.

## 관련 (Related)

[[010-surfaces-and-boundaries]], [[030-sync-and-merge]], [[050-deletion-and-revert]], [[900-open-decisions]]
