# SoT-050: 삭제와 revert (tombstone)

상태(Status): Invariant
확정(Since): 2026-07-01
대체함(Supersedes): —
대체됨(Superseded-by): SoT-022 (계획의 `workspace.memory.retracted` 참조 부분만; tombstone/revert 불변식 본문은 여기서 유효)

## 진술 (Statement)

제거는 **tombstone(retraction 이벤트)**이지 행 삭제가 아니다. 두 경우로 나뉜다:
**(1) 아직 push 안 한 로컬 전용 이벤트**는 진짜 hard delete(로컬 로그 rewrite)가
가능하다 — 아무도 안 가졌으므로 안전하다(`git reset --hard`를 un-pushed commit에 하는
것과 동일). **(2) 이미 공유된 이벤트**는 retraction으로 논리적으로 수렴시키고, 바이트
회수는 replica별 lazy 압축/GC로 한다(`git gc`가 unreachable을 prune하는 것과 동일).
공유 로그에서의 동기적 cross-replica 행 삭제는 없다.

## 근거 (Why)

union sync에서는 **부재가 전파되지 않는다**(`030`). 행을 지워도 그걸 가진 peer가
되살리므로, 수렴하는 유일한 제거는 그 자체가 전파되는 이벤트, 즉 tombstone이다. 이는
git에 정확히 대응한다: `reset --hard`는 불변 객체 DAG에서 행을 빼는 게 아니라 가변 ref를
뒤로 옮길 뿐이고, 떨어져 나간 객체는 나중에 GC가 prune한다. 공유 history에서 그걸 하려면
`push --force`인데, 이미 pull한 사람이 되살리는 그 위험이 바로 우리가 피하는 발산이다.

## 함의 (Implications)

- 제거 API는 행을 삭제하지 말고 retraction 이벤트를 append하라. projection이 대상을
  숨긴다(계획의 `workspace.memory.retracted`).
- **consolidated 상태의 revert**는 외과적 단일 제거가 아니라 "오염 시점 이전으로 되감기
  + clean 이벤트 집합으로 forward 재파생"이다. append-only라 이 replay가 결정적이라
  안전하다. consolidated는 raw의 **재생성 가능한 view**(권위 아님, `040`)라 retract→재파생
  으로 깨끗이 복구된다.
- 물리 GC는 retraction이 전파된(또는 retention 경과) 뒤 replica별 로컬 압축으로만,
  cross-replica 동기 삭제로는 하지 마라.

## 경계 (Boundaries)

**전역 revert는 admin(owner) 역할만** 친다(`040`) — 남의 것 포함 정리(떠난 멤버의 stale·
오염)를 위해. 로컬 revert는 내 projection이라 누구나 언제나 가능하다. 모든 retraction은
provenance가 찍혀 추적·역전 가능하다. 이미 남이 pull한 바이트의 회수불가는 수용된
전제다(`040`).

## 부수 성질 (왜 tombstone이 행삭제보다 나은가)

- **audit trail 보존**: "언제·누가 retract했나"가 이벤트로 남아 추적 가능하다.
- **전부 reversible**: 잘못 retract하면 그걸 무효화하는 이벤트를 또 append하면 된다
  (retract-the-retraction). `confirmed`/`superseded` 라이프사이클이 같은 패턴이다.

## 관련 (Related)

[[030-sync-and-merge]], [[040-workspace-sharing-and-capacity]]
