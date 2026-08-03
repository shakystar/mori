# SoT-080: task 라이프사이클과 상태 전이

상태(Status): Decision
확정(Since): 2026-07-04
대체함(Supersedes): —
대체됨(Superseded-by): —

## 진술 (Statement)

task 상태기계는 `todo → in_progress → handoff_ready → done`을 정식 경로로 하고,
`cancelled`를 모든 비종결 상태의 이탈구로 둔다. `in_progress`는 `start` 동사로만
도달한다: `start`는 상태를 `in_progress`로 옮기고(이미 `in_progress`면 멱등 no-op,
종결 상태면 거부) 시작 컨텍스트를 로드한다. `resume`은 상태를 바꾸지 않는 순수
읽기다. `handoff`는 상태기계를 경유하므로 `todo → handoff_ready` 직행을 거부한다
(먼저 `start`) — 단, 재핸드오프(`handoff_ready → handoff_ready`)는 허용한다.
`done`은 `in_progress`(단독 완료) 또는 `handoff_ready`에서만 도달한다.

## 근거 (Why)

Decision: `in_progress`는 타입과 상태기계에 이미 있었으나 어떤 CLI 동사도 도달시키지
않아 "이미 작업 중인 task"와 "아무도 안 잡은 todo"가 구분되지 않았다. `start`를
상태 동사로 만들면 그 구분이 `task list`·auto-picker·다른 에이전트에게 보인다.
`resume`과 분리한 이유는, `resume`이 남의 task 핸드오프를 읽는 용도로도 쓰여 읽기가
상태를 바꾸면 안 되기 때문이다. `handoff`를 엄격화한 이유는, 시작하지 않은 일은
넘길 게 없다는 의미론과, 우회 append 해킹을 정식 상태기계 경로로 정리하기 위함이다.
기각안: handoff가 `todo`를 자동으로 `in_progress`를 거쳐 넘기기 — `in_progress`가
순간값이 되어 '누가 작업 중' 신호가 사라진다.

## 함의 (Implications)

- 상태 전이는 `assertTaskStatusTransition`을 통과해야 한다. `createHandoff`는 더 이상
  상태기계를 우회해 직접 append하지 않는다.
- `in_progress → done` 전이가 열려 있어야 단독 `start → done` 흐름이 성립한다.
- fixture/에이전트 워크플로는 handoff 전에 반드시 `start`(또는 `in_progress` 전이)를
  거쳐야 한다.

## 경계 (Boundaries)

`blocked`/`unblock` 동사는 이 문서가 다루지 않는다 — agent talk(원격 소통) 선행
의존으로 미뤘다(`900` 참고). `blocked` 전이는 상태기계에 정의만 있고 도달 동사가 없다.
`todo → done` 직행은 열지 않는다.

## 관련 (Related)

[[900-open-decisions]]
