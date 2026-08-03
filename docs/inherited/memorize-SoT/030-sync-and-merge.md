# SoT-030: sync와 merge (append-only union)

상태(Status): Invariant
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

store는 **append-only 이벤트 로그**다. sync는 **union / gossip**이다: 각 측이
자신에게 없는 이벤트를 멱등하게 삽입한다(`insertExternalEvents`, `INSERT OR IGNORE`).
머지는 **집합에 대해 conflict-free**다 — 두 머신이 서로 다른 이벤트를 append해도 절대
충돌하지 않으며, sync는 merge-conflict형 push/pull이 아니라 집합 화해다(rebase 없음,
정상 흐름에 force 없음). 모든 이벤트는 **provenance**를 지닌다: `writer`(소스 계정) +
`source project_id`(+ device, + event id). 깊은 성질: **존재는 전파되고, 부재는 전파되지
않는다.**

## 근거 (Why)

append-only + 집합 union은 근본적인 conflict-free 성질(G-Set)이다: 순서 무관, 멱등,
최종적 일관성. provenance는 이벤트당 한 필드라 projection의 그룹핑·신뢰·복구에 늘 쓸 수
있다. 워터마크(`lastPushedEventId` / `lastPulledEventId`)는 **peer별 최적화**로 재요청
범위를 한정할 뿐, 부재한 이벤트가 "삭제됐다"는 진술이 **아니다**.

## 함의 (Implications)

- 행을 지워서 데이터를 없애고 그대로 유지되길 기대할 수 없다: 그걸 아직 가진 peer가
  다음 union에서 되살린다(워터마크 탓에 로컬 삭제가 *먹힌 것처럼* 보이다가
  clone/reset/다른 writer 경유로 슬그머니 부활하기도). 제거는 **tombstone 이벤트**여야
  한다 — `050` 참고.
- projection은 로그를 source of truth로 삼는, 로그에 대한 순수·결정적 함수여야 한다(매
  pull 후 멱등 재빌드).
- 새 이벤트 타입은 복구·그룹핑 가능성을 유지하려면 provenance를 실어야 한다.

## 경계 (Boundaries)

단일 정본 *상태기계* 의미론은 여기 범위 밖이다 — union은 *집합*에 대해 conflict-free지만,
단일 가변 값(예: "그" task status)을 writer 간에 접어선 안 된다; 그 규칙은 `040`에 있다.

## 관련 (Related)

[[040-workspace-sharing-and-capacity]], [[050-deletion-and-revert]]
