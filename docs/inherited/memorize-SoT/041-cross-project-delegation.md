# SoT-041: 프로젝트 간 작업 위임은 제안-수락(request-accept)이다

상태(Status): Decision
확정(Since): 2026-07-03
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

워크스페이스 union으로 다른 프로젝트의 맥락이 흘러들어와도, **한 프로젝트의 에이전트는
다른 프로젝트 소관의 작업을 직접 수행하지 않는다** — 대신 그 프로젝트를 겨냥한 **위임
요청**을 등록한다. 위임은 제안-수락 모델이다: 요청자는 대상 프로젝트를 겨냥한
`task.requested` 이벤트(5W1H형 컨텍스트 + `targetProjectId`)를 자기 store에 append하고,
**대상 프로젝트의 로컬 에이전트가 수락할 때에야 로컬 writer 명의의 `task.created`가
발급**된다. 거절은 사유를 담은 명시적 이벤트로 union을 타고 요청자에게 되흐른다. 원격
writer가 다른 프로젝트의 task를 직접 생성·변이하는 것은 금지다. 수신 주소는 **writer가
아니라 프로젝트**이며, 범위는 **같은 워크스페이스의 멤버 프로젝트로 한정**한다.

## 근거 (Why)

- union이 정보를 배달하는 것은 의도된 협업 가치([[040-workspace-sharing-and-capacity]])
  지만, 행동 경계가 없으면 에이전트가 남의 레포 일을 자기 세션에서 해버린다(2026-07-03
  hub↔memorize 실사례). 정보의 흐름과 행동의 경계는 별개 층이다.
- **직접 등록(원격 writer가 `task.created`를 대상 프로젝트에 쓰기)을 기각한 이유** 세 가지:
  (1) 수신자는 특정 writer가 아니라 "그 레포의 다음 에이전트 누구든"이다 — 프로젝트
  주소 + 기존 세션 claim 메커니즘이 의도와 일치한다. (2) 제안→수락이
  `decision.proposed → accepted` 전례 및 (엔티티, writer) group-by projection
  ([[040-workspace-sharing-and-capacity]])과 정합하고, 직접 등록은 cross-writer 변이
  금지(task item append의 closed allowlist)와 충돌한다. (3) 요청자 쪽에 "위임했음"
  상태가 남아야 같은 일을 또 직접 하려는 루프를 끊을 근거가 된다.
- **주소 해석**: `proj_`는 원격 라우팅 키가 아니지만([[021-local-and-workspace-identity]],
  [[031-canonical-remote-transport]]), 여기서 `targetProjectId`는 라우팅이 아니라 **union
  내 필터 라벨**이다 — 전 멤버가 어차피 전체 union을 받으므로 배달에 라우팅이 필요 없고,
  대상만이 자기 앞으로 온 요청을 골라 표면화한다. SoT-021과 저촉되지 않는다.
- **만료 대신 에스컬레이션**: 오래됐거나 이미 처리된 요청은 대상 에이전트가 맥락으로
  거른다. 자동 만료·삭제는 append-and-supersede 규율에 반하며, 무응답의 비용은 대상을
  조르는 게 아니라 **요청자에게 되흘려** 부담시킨다.

## 함의 (Implications)

- 새 이벤트: `task.requested`(요청), 수락 시 대상 로컬 writer의 `task.created`가 요청
  id를 참조, 거절 시 사유를 담은 거절 이벤트. 정확한 스키마·이벤트명은 구현 소관이되,
  **제안-수락 2단계와 로컬 writer 발급 원칙은 여기서 확정**이다.
- 대상 에이전트의 세션 시작/`task resume`은 자기 프로젝트를 겨냥한 미처리 요청을
  **인박스로 표면화**해야 한다. 무시보다 명시적 거절(사유 포함)을 권장하는 표면으로.
- 요청자 쪽 표면: 아웃바운드 요청 조회(예: `task request list --outbound`)와, N일
  무응답 요청의 요청자 startup context 재표면화(에스컬레이션).
- 주소 지정 UX: Hub는 source store 등록(`tryEnsureSourceStoreRegistration`)으로 워크
  스페이스별 멤버 프로젝트 목록을 이미 안다 — 이를 로스터로 표면화(예:
  `workspace sources`)하고, 이름→`proj_` 해석과 충돌 시 id 접두어 구분을 제공한다.
- 프로젝트 간 위임의 ground rule(발견하면 직접 하지 말고 요청 등록)을 에이전트 가이드와
  startup context의 provenance 라벨에 반영한다 — 통로 없는 규범도, 규범 없는 통로도
  단독으론 동작하지 않는다.
- 워크스페이스 밖 임의 프로젝트로의 위임은 **비목표**다. membership = publish 신뢰
  모델([[040-workspace-sharing-and-capacity]]) 그대로, 요청도 멤버십 안에서만 흐른다.

## 경계 (Boundaries)

- 요청의 **전달 시점**(송신 즉시 push, 수신 폴링/워처)은 [[042-delegation-delivery-and-watcher]]
  소관 — 이 문서는 의미론(누가 무엇을 발급하는가)만 정한다.
- 인박스 표면의 구체 렌더링(startup context 어느 lane, budget)과 이벤트 스키마 상세는
  구현 계획 소관.
- 이 문서는 사람-간 권한을 새로 만들지 않는다 — 역할 모델(owner/member)은
  [[040-workspace-sharing-and-capacity]] 그대로다.

## 관련 (Related)

[[040-workspace-sharing-and-capacity]], [[021-local-and-workspace-identity]], [[030-sync-and-merge]], [[031-canonical-remote-transport]], [[042-delegation-delivery-and-watcher]]
