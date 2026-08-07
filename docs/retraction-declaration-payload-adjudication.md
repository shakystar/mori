# 되돌림 무효 선언 payload 스키마 산정 (#391, mori-nest §Q5-T1)

> **판정 기록 · 동결됨 (커밋 `5c32613` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

되돌림(선별 제거)의 **클라이언트 쪽 계약**을 정본으로 세운다. mori-nest
`docs/selective-removal-and-retention-adjudication.md`(#55 / PR #56)가 후속 T1으로 이 리포에
넘긴 조각이다. 서버 계약(`0002`·`0003`)은 한 줄도 건드리지 않는다 — 무효 선언은
`0002 §1.4`가 적은 대로 **payload 안의 클라이언트 개념**이고, 로그에 새로 append되는
평범한 이벤트다. 지우는 것이 아니다.

**이 문서는 산정이다.** `packages/` 아래 변경은 0건이고, 실제 배선은 §후속이 정하는 별도
조각의 몫이다. 되돌림을 만들거나 소비하는 경로가 아직 없어 실물로 검증할 수 없다는 사실은
mori-nest §Q5-T2가 이미 적었다("T1은 노출 없이도 스키마를 정할 수 있고 검증만 못 한다").

## 필수 질문 → 절 매핑

| 질문                      | 절                                              | 한 줄 답                                                                                               |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 대상 축이 실물에 있는가   | [§1](#1-대상-축--무엇을-지목하는가)             | **출처 축은 있다 (store 입도). replica 입도는 없다.** 기간 축은 `createdAt` 하나뿐 — `seq`는 이식 불가 |
| 누가 선언할 수 있는가     | [§2](#2-선언-주체--누가-내고-어떻게-판정하는가) | `memory.retracted`의 `writerRole` 선례를 그대로 쓴다. 자기 레인은 무조건, 교차 레인은 `owner`만        |
| 어느 읽기 경로에서 빼는가 | [§3](#3-소비자의-적용-규칙)                     | 주입·증류 입력·검색은 **뺀다**. 증류의 `consumed` 셋은 **빼면 안 된다 (MUST NOT)**                     |
| 파생물을 어떻게 하는가    | [§4](#4-파생물-처리)                            | **(a) 그대로 둔다가 기본.** 자동 캐스케이드는 SoT-040 레인 불변식을 깬다. (c) 재증류는 #298을 되연다   |
| 서버가 못 막는 것         | [§5](#5-advisory의-한계)                        | 소비자가 무시하면 끝이다. 강제는 «조용한 누락 금지»를 뒤집는 별도 사람 결정                            |
| 무엇이 아직 안 정해졌나   | [§6](#6-미결)                                   | 출처 축의 입도 / 자기 레인 캐스케이드의 기본값 / 기간 축의 정본 — 3건                                  |

## 0. 기준 커밋

- **기준 커밋: `5c32613`** (`git rev-parse --short origin/main`, 착수 시점).
- 이 문서의 `파일:줄` 인용은 각 인용 자리에 그 인용 하나를 대조한 short SHA를 병기한다
  (`CONTRIBUTING.md`의 "인용은 심볼 이름 우선, 줄번호에는 국소 SHA를 병기한다").
  이슈 본문이나 앞선 산정이 옮겨 적은 값은 쓰지 않았다 — 전부 이 커밋에서 직접 열었다.
- 이 조각이 딛고 서는 이미 내려진 판단(뒤집지 않는다): 서버는 강제하지 않는다(advisory,
  mori-nest #55의 ⓑ) / 되돌림의 대상 축은 출처다(mori #115 2026-08-06 사람 결정 P2) /
  replica id는 config가 아니라 state다(#115 P3).

## 1. 대상 축 — 무엇을 지목하는가

사람 결정의 원 문구는 _"«replica X가 기간 Y에 쓴 것» 선별 제거 가능하게"_ 다. 그 두 축이
`5c32613`의 실물에 있는지 직접 열어 확인한 결과는 아래와 같다.

### 1.1 출처 축 — **있다. 단 store 입도이고, replica 입도는 없다**

이벤트마다 출처가 두 필드로 기록된다:

- `DomainEvent.writer` (발신 actor 신원) / `DomainEvent.sourceProjectId` (발신 store id) —
  `packages/kernel/src/domain/events.ts:84-92` (`5c32613`).
- 로컬 append 경로에서 각각 `actor`·`projectId`로 **기본값이 채워진다** —
  `packages/kernel/src/storage/event-store.ts:213-214` (`5c32613`). 즉 명시적으로 넘기지
  않아도 모든 신규 이벤트가 출처를 달고 태어난다. 레거시(3.0.0 이전) 행만 NULL이다.
- 저장 자리는 `events` 테이블의 `writer` / `source_project_id` 컬럼 —
  `packages/kernel/src/storage/db.ts:541` (`5c32613`, v11 마이그레이션).

이 축은 **이미 소비되고 있다.** `laneOf`(`packages/kernel/src/projections/projector.ts:146`,
`5c32613`)가 `sourceProjectId`를 레인으로 접고, 프로젝션 읽기는 `laneWhere`
(`packages/kernel/src/services/projection-store.ts:95-97`, `5c32613`) 한 군데를 통해
`source_project_id IS NULL`(= self)로 좁힌다.

> **실물 어긋남(이 PR에서 고치지 않는다).** `events.ts:84-92`의 doc은 두 필드를
> "currently UNCONSUMED"라고 적고 있는데, `sourceProjectId`는 위처럼 레인으로 소비된 지
> 오래다. `writer`만이 아직 거의 미소비다(유일한 소비자는 `retractedBy`,
> `projector.ts:601`, `5c32613`). 코드 주석 정정은 이 조각의 범위가 아니다 — §후속 F4.

**그런데 이것은 replica 축이 아니다.** `laneOf`의 doc이 그 입도를 직접 적는다: 레인은
_"actor가 아니라 origin store(`source_project_id`)다. 같은 계정이 여러 기기에서 하나의
store로 sync되면 하나의 레인이고, 다른 store(팀원, 또는 다른 폴더/db)만이 별개 레인이다"_ —
`packages/kernel/src/projections/projector.ts:88-91` (`5c32613`).

즉 **같은 사람의 두 기기는 같은 `sourceProjectId`를 쓴다.** #115 P3이 겨냥한 바로 그
상황(`cp -r`·worktree 상속으로 복제된 replica)을 `sourceProjectId`로는 갈라낼 수 없다.

**replica id는 이 커밋의 리포에 존재하지 않는다.** `packages/` 전체에서 `replicaId` /
`replica_id` 식별자는 0건이다(`grep -rn 'replicaId\|replica_id' --include=*.ts packages/`,
`5c32613`). "replica"라는 낱말은 주석 안에서 *수렴 논증의 화자*로만 쓰인다(예:
`projector.ts:232`, `contradiction-service.ts:22`, `5c32613`) — 식별자로 실체화된 적이 없다.
커서 포크 감지·재발급(#115 P3)도 없다.

**판정:** 계약이 지목하는 출처 축은 **`sourceProjectId`(store 입도) + 선택적 `writer`(actor
좁히기)** 다. 사람 결정의 문자 그대로의 «replica X»는 **오늘 실물에 없으므로 계약에 적지
않는다.** 그 축이 필요해지는 지점과 선행은 §6 미결1·§후속 F1에 넘긴다.

### 1.2 기간 축 — `createdAt` 하나뿐이다

기간을 자를 후보를 셋 다 열어 봤다.

| 후보          | 실물                                                                  | 이식 가능한가                                                                                                                |
| ------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **벽시계**    | `events.created_at TEXT` (`db.ts:299`, `5c32613`), `nowIso()` 로 채움 | **가능.** 이벤트에 실려 sync를 건너간다. 대신 기기별 시계 오차를 그대로 물려받는다                                           |
| **`seq`**     | `events.seq INTEGER PRIMARY KEY` (`db.ts:296`, `5c32613`)             | **불가능.** 각 store의 SQLite가 insert 시점에 부여한다 — 같은 이벤트가 store마다 다른 `seq`를 받는다. payload에 담을 수 없다 |
| **이벤트 id** | `evt_<base36 ms>_<rand>` (`domain/common.ts:32-35`, `5c32613`)        | **가능.** 증류 워터마크가 쓰는 방식 그대로 — "커서가 지목한 이벤트 이후 전부"                                                |

이벤트 id를 커서로 쓰는 선례가 이미 있다: 증류 경계가 워터마크로 이벤트 id를 잡고 로컬
`seq` 순서에서 그 위치를 찾는다. 로그가 그 id를 못 찾으면 _"전부"_ 로 degrade한다 —
`packages/kernel/src/services/consolidate-service.ts:2351-2356` (`5c32613`).

**판정:** 기간은 **`createdAt`의 반열린 구간 `[fromCreatedAt, toCreatedAt)`** 으로 자른다.
반열린을 고른 이유는 두 선언을 잇대었을 때 경계 이벤트가 두 번 잡히거나 새는 일이 없어야
하기 때문이다. `seq`는 계약에서 배제한다(이식 불가). 이벤트 id 커서는 §6 미결3으로 남긴다 —
둘 다 표현 가능하지만 정본은 하나여야 한다.

### 1.3 대상 축 — payload 필드 목록

| 필드                     | 타입                | 필수 | 뜻                                                                          |
| ------------------------ | ------------------- | ---- | --------------------------------------------------------------------------- |
| `target.sourceProjectId` | `EntityId`          | 필수 | 무효로 볼 발신 store id. 오늘 실물에 있는 유일한 출처 축(§1.1)              |
| `target.writer`          | `string`            | 선택 | 그 store 안에서 actor로 더 좁힌다. 없으면 그 store의 모든 writer            |
| `target.fromCreatedAt`   | `ISODateString`     | 선택 | 기간 시작, **포함**. 없으면 로그의 처음부터                                 |
| `target.toCreatedAt`     | `ISODateString`     | 선택 | 기간 끝, **배타**. 없으면 선언 이벤트 자신의 `createdAt`까지                |
| `target.eventTypes`      | `DomainEventType[]` | 선택 | 없으면 `observation.captured` + `memory.consolidated` 둘 다(§3의 기본 대상) |

`target`의 다섯 필드는 **AND로 결합한다.** `sourceProjectId`만 필수인 이유는 그것이 없으면
선언이 «출처 축 기반»이기를 그치고 무차별 기간 삭제가 되기 때문이다 — 사람 결정 P2가
(a)로 좁힌 것이 정확히 그 반대 방향이다.

**빈 값은 «미설정»이 아니다 (MUST).** 선택 필드가 «없으면 넓게»로 degrade하므로, 빈
문자열·빈 배열을 미설정과 같게 읽으면 좁히려던 선언이 조용히 가장 넓은 선언이 된다. 규칙:

- `target.writer`가 **빈 문자열**이면 그 선언은 **무효다** — 미설정으로 강등하지 않는다.
  actor가 `""`인 이벤트는 존재하지 않으므로(`event-store.ts:213-214`, `5c32613`에서
  `actor`를 그대로 물려받는다) 빈 문자열은 언제나 작성자 실수다.
- `target.eventTypes`가 **빈 배열**이면 그 선언은 **무효다** — «아무 타입도 아님»과
  «타입 제한 없음»은 정반대인데, 필드 부재만이 후자를 뜻한다.
- `target.fromCreatedAt`/`toCreatedAt`가 파싱 불가이거나 `from >= to`이면 그 선언은
  **무효다** — 빈 구간을 «전체»로 읽지 않는다.

무효한 선언은 **레코드로 남되 효력이 0이다** (§4.5의 append-only와 같은 처리 — 이벤트를
거부하거나 지우지 않는다).

payload **최상위** 필드는 다섯이다. 위 표가 `target` 안을 펼친 것이고, 아래 표가 그것을
품은 바깥이다 — 둘을 합친 것이 §7 스니펫과 같은 내용이다.

| 필드          | 타입                      | 필수 | 뜻                                                                 |
| ------------- | ------------------------- | ---- | ------------------------------------------------------------------ |
| `target`      | (§1.3의 다섯 필드)        | 필수 | 무엇을 무효로 보는가. 하위 다섯 필드는 AND로 결합한다              |
| `derivatives` | `"leave" \| "invalidate"` | 필수 | 파생물 처리 의도. **기본값 없음** — 선언이 반드시 밝힌다 (§4.3)    |
| `reason`      | `string`                  | 선택 | 왜 무효로 보는가 (자유 서술)                                       |
| `writerRole`  | `"owner" \| "member"`     | 선택 | 선언자의 workspace role AT AUTHORING TIME. 교차 레인 선언에만 (§2) |
| `revokes`     | `EntityId`                | 선택 | 앞선 무효 선언의 효력을 걷는다 — 가역성 (SoT-050)                  |

## 2. 선언 주체 — 누가 내고, 어떻게 판정하는가

**선례를 새로 짓지 않는다.** 이 리포에는 이미 «무효화 이벤트의 자격을 소비자가 판정하는»
완성된 수법이 하나 있다 — `memory.retracted`다.

- 자격은 **payload에 실려 온다**: `MemoryRetractedPayload.writerRole?: 'owner' | 'member'` —
  `packages/kernel/src/domain/entities/memory.ts:190-205` (`5c32613`). 교차 레인(GLOBAL)
  retract일 때만 클라이언트가 Hub 컨트롤플레인에 자기 role을 확인한 뒤 찍는다.
- 판정은 **리듀서가 한다**: `eventLane !== targetLane && payload.writerRole !== 'owner'` 이면
  그 retract는 아무 일도 하지 않는다 — `packages/kernel/src/projections/projector.ts:593-594`
  (`5c32613`).
- role이 **이벤트에 실려야 하는 이유**도 그 자리에 적혀 있다(`memory.ts:195-202`, `5c32613`):
  (a) 리듀서가 로그의 순수 함수로 남아야 모든 replica가 role 캐시 갱신 시점과 무관하게
  수렴하고, 나중의 강등이 과거를 소급해 뒤집지 않는다. (b) roster는 accountId로 키가
  잡혀 있는데 이벤트는 `writer`/`sourceProjectId`만 나르므로 조회 자체가 불가능하다.
- **선언자의 신원은 payload가 아니라 이벤트가 나른다**: `memory.ts:183` (`5c32613`)이
  _"Provenance (`writer`/`sourceProjectId`) rides the DomainEvent, not this payload"_ 라고
  못 박았다.

**판정:** 무효 선언도 같은 규칙을 그대로 쓴다.

| 선언 종류                                                      | 자격                     | 소비자의 판정                                         |
| -------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| **자기 레인** (선언 이벤트의 레인 == `target.sourceProjectId`) | 무조건 유효              | `writerRole` 불필요. 없으면 자기 레인 선언으로 읽는다 |
| **교차 레인** (남의 출처를 지목)                               | `writerRole === 'owner'` | 아니면 **무시한다** (레코드는 남고 효력만 없다)       |

선언자 신원은 payload에 넣지 않는다 — 선언 이벤트 자신의 `writer` / `sourceProjectId`가
그것이다. 중복 필드를 만들면 둘이 갈라질 자리를 새로 짓는 것이다.

### 2.1 T2(출처 노출)가 닫혀 있는 것이 여기에 어떻게 걸리는가

**판정 자체에는 걸리지 않는다.** 리듀서는 오늘도 `laneOf`로 이벤트의 출처를 읽을 수 있다
(`projector.ts:146`, `5c32613`) — 자격 판정에 필요한 모든 입력이 이미 로그 안에 있다.

**걸리는 것은 사람 쪽이다.** T2가 없으면:

1. 사람이 «어떤 출처를 무효로 선언할지» 고를 화면이 없다. 선언을 **낼** 수는 있어도 무엇을
   겨눌지 눈으로 확인할 수 없다.
2. 선언이 적용된 뒤 «무엇이 빠졌는지» 감사할 수 없다. 무효 대상이 조용히 사라진 것과
   애초에 없었던 것을 사람이 구분하지 못한다.

그래서 **T1(이 문서)은 T2의 선행이 아니지만, 배선 조각은 T2를 선행으로 갖는다.** §후속 F2.

## 3. 소비자의 적용 규칙

읽기 경로를 전수로 열어 «뺀다/안 뺀다»를 각각 적는다. 표의 자리는 전부 `5c32613`에서 직접
확인했다.

| 읽기 경로                         | 자리                                                                        | 뺀다?                  | 근거                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| **retrieval 주입 — 기억 채널**    | `packages/kernel/src/services/memory-retrieval-service.ts:129` (`5c32613`)  | 뺀다                   | `listValidMemories`가 `invalid_at IS NULL AND source_project_id IS NULL`로 이미 좁힌다 |
| **retrieval 주입 — 관측 tail**    | 같은 파일 `:153` (`5c32613`)                                                | 뺀다                   | `listRecentObservations`도 `laneWhere` 경유(`projection-store.ts:1044`, `5c32613`)     |
| **retrieval 주입 — segment 채널** | 같은 파일 `:220` (`5c32613`)                                                | 뺀다                   | segment 읽기 두 개 모두 self 레인 기본값(`segment-store.ts:17-20`, `5c32613`)          |
| **consolidation — 관측 입력**     | `packages/kernel/src/services/consolidate-service.ts:2374-2375` (`5c32613`) | 뺀다                   | 이미 `laneOf(...) === SELF_LANE`로 남의 관측을 배제한다                                |
| **consolidation — 기존 기억**     | 같은 파일 `:2445-2446` (`5c32613`)                                          | 뺀다                   | `!invalidAt && self lane` — 창이 닫히면 자동으로 빠진다                                |
| **consolidation — `consumed` 셋** | 같은 파일 `:2391-2397` (`5c32613`)                                          | **안 뺀다 (MUST NOT)** | 아래 §3.1                                                                              |
| **검색 — 어휘(FTS)**              | `packages/kernel/src/services/search-service.ts:59-91` (`5c32613`)          | 뺀다                   | 단 인덱스 재작성 경계에서만 — 아래 §3.2                                                |
| **검색 — 시맨틱/하이브리드**      | 같은 파일 `:172` (`5c32613`)                                                | 뺀다                   | `listValidMemories`를 경유하므로 창이 닫히면 자동                                      |

**대부분은 공짜다.** 무효 선언이 대상 기억의 `invalidAt`을 닫기만 하면 위 경로 중 다섯 개가
쿼리 변경 없이 따라온다 — `projector.ts:46` (`5c32613`)이 `dedupedBy`에 대해 적은 것과 같은
성질이다. 나머지 둘(§3.1·§3.2)만이 별도의 규칙을 요구한다.

### 3.1 `consumed` 셋에서 빼면 안 된다 — 이 규칙을 어기면 #298이 되열린다

증류 경계는 «이미 증류된 관측»을 로그에서 재구성하는데, 그 집합에 **필터를 걸지 않는다.**
코드가 그 이유를 직접 적는다 — `consolidate-service.ts:2391-2396` (`5c32613`):

> `NO FILTER, deliberately — not invalidAt, not lane, matching the SELECT data FROM memories
this replaces (which saw invalidated, superseded, dedup-loser and foreign-lane rows alike).
Adding the existing filters here "for consistency" would let an INVALIDATED memory's
observations count as unconsumed again and be redistilled — the very duplicate this issue
closes, reopened from the other side.`

무효 선언은 결국 «`invalidAt`을 닫는 일»이므로, 이 경고가 그대로 적용된다. 무효 선언이
파생 memory를 무효로 만들면서 동시에 그 memory의 `sourceObservationIds`를 `consumed`에서
빼면, 다음 경계가 같은 관측을 다시 증류해 **무효 선언이 지우려던 내용을 새 memory로 부활시킨다.**

**규칙:** 무효 선언은 `consumed` 계산에 아무 영향도 주지 않는다. 무효 대상 관측은
«소비됐다»로 계속 세어진다. 이것은 append-only와도 정합한다 — 관측이 실제로 증류된 것은
역사적 사실이고, 무효 선언은 그 사실을 취소하지 않는다.

### 3.2 검색에서 빠지려면 창을 닫는 것만으로 부족하다

`searchProject`는 `search_fts`를 그대로 읽는다 — **유효성 필터가 없다**
(`search-service.ts:59-91`, `5c32613`). 인덱스에 무엇이 들어가는지는 재작성 시점에 결정되고,
그 자리의 조건은 `invalidAt`이 아니라 `dedupedBy`·`retractedAt`이다 —
`packages/kernel/src/services/projection-store.ts:687` (`5c32613`):

```
if (!memory.dedupedBy && !memory.retractedAt) { indexEntity(...) }
```

바로 위 주석이 그 구분을 적는다(`:683-686`, `5c32613`): retraction은 _"a deliberate «make it
go away», stronger than a bi-temporal supersede"_ 라서 raw 검색에서도 나오면 안 되고,
supersede는 그렇지 않다.

**규칙 두 가지가 따라 나온다:**

1. 무효 선언은 대상 memory에 `invalidAt`뿐 아니라 **retraction 계열 마커도 찍어야 한다.**
   창만 닫으면 주입·증류에서는 빠지지만 **검색에는 계속 뜬다.** 무효 선언의 의도는 후자
   쪽("보이지 않게")이므로 supersede 성질이 아니라 retract 성질이다.
2. **제거는 즉시가 아니라 재작성 경계에서 발효된다.** `search_fts`는 replace-all 싱크라
   통째로 지우고 다시 채우는 방식이고(`projection-store.ts:468-471`, `5c32613`), 그것은
   `reindexSearch: true` 리빌드에서만 일어난다. 계약은 이 지연을 «있다»고 적어야 한다 —
   숨기면 소비자가 «선언했는데 검색에 뜬다»를 결함으로 신고한다.

## 4. 파생물 처리

이 조각의 핵심 질문이다. 무효 선언 이전에 이미 증류된 memory는 무효 대상 관측을 재료로
삼았을 수 있다.

**추적은 가능하다.** `ConsolidatedMemory.sourceObservationIds`
(`packages/kernel/src/domain/entities/memory.ts:100-101`, `5c32613`)가 memory마다 그것이
어떤 관측에서 나왔는지 이름으로 들고 있고, 그 값은 `memory.consolidated` payload에 실려
로그에 남는다. 그래서 세 선택지 (a) 그대로 둔다 / (b) 함께 무효로 본다 / (c) 재증류를
예약한다 **모두 기계적으로는 구현 가능하다.** 고르는 근거는 구현 가능성이 아니라
불변식이다.

### 4.1 (c) 재증류 예약 — **각하한다**

§3.1이 그대로 사유다. 재증류는 무효 대상 관측이 `consumed`에서 빠져야 성립하는데, 그것은
`consolidate-service.ts:2391-2396` (`5c32613`)이 명시적으로 금지한 바로 그 변경이고 #298의
중복 증류를 반대편에서 되연다. 게다가 무효 선언의 의도는 «그 관측을 빼고 다시 생각해
달라»가 아니라 «그 관측을 근거로 삼지 말라»다 — 재증류는 오히려 그 관측을 한 번 더 읽는다.

### 4.2 (b) 자동 캐스케이드 — **교차 레인에서는 불변식을 깬다**

파생 memory의 출처는 **그것을 증류한 store**다(`memory.consolidated` 이벤트의
`sourceProjectId`). 그 store는 재료가 된 관측의 출처와 **다를 수 있다** — union 로그에서
A의 관측이 B에게 sync되고 B가 증류하면, 관측은 A 레인, memory는 B 레인이다.

따라서 «A의 관측을 무효로 선언»이 파생물을 자동으로 따라 무효화하면, **A의 선언이 B 레인의
memory를 죽인다.** 그것은 레인 분리가 존재하는 이유를 정면으로 어긴다 —
`projection-store.ts:75-77` (`5c32613`)가 _"Every projection read that must not fold a
foreign writer's row into local truth"_ 라고 적고, dedup 자리는 한술 더 떠
_"a foreign lane must never invalidate a self memory (SoT-040)"_ 라고 못 박는다
(`projector.ts:240-243`, `5c32613`).

`memory.retracted`가 이 문제를 푼 방식이 그대로 답이다: **교차 레인 효력은 `owner`에게만**
(`projector.ts:593-594`, `5c32613`).

### 4.3 판정

**기본값은 (a) 그대로 둔다.** 그리고 선언자가 의도를 **명시적으로** 밝히도록 payload에
필수 필드 `derivatives`를 둔다 — 기본값을 주지 않는 이유는, 파생물을 어떻게 할지가 이
조각에서 가장 되돌리기 어려운 판단이라 «적지 않으면 조용히 어느 쪽»이 되면 안 되기
때문이다.

| `derivatives` 값 | 소비자 동작                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `'leave'`        | 파생 memory는 건드리지 않는다. 무효 선언은 관측 채널에만 적용된다                                                    |
| `'invalidate'`   | `sourceObservationIds`가 무효 대상 관측과 **하나라도 겹치는** memory의 창을 함께 닫는다 — 단 §4.4의 레인 게이트 아래 |

### 4.4 캐스케이드에도 같은 레인 게이트가 걸린다

`derivatives: 'invalidate'`라도 파생 memory마다 §2의 판정이 **다시** 돈다:
그 memory의 레인이 선언 이벤트의 레인과 다르면 `writerRole === 'owner'`일 때만 닫힌다.
게이트를 선언 단위가 아니라 **대상 단위**로 거는 이유는, 하나의 선언이 여러 레인의
파생물에 걸칠 수 있어서 선언 단위 판정으로는 «일부만 owner 권한이 필요한» 경우를
표현할 수 없기 때문이다.

### 4.5 append-only·불변식과의 정합

세 갈래 모두 **아무것도 지우지 않는다.**

- 무효 선언은 로그에 **append되는 새 이벤트**다 (`0002 §1.4`: retract는 payload 안의
  클라이언트 개념이지 전송 평면의 동작이 아니다).
- 효력은 프로젝션에서 **창을 닫는 것**으로 나타난다 — `memory.superseded`·`memory.retracted`가
  쓰는 것과 같은 수법이다(`projector.ts:562-576`, `:577-604`, `5c32613`). 원 이벤트도 행도
  남는다.
- 그래서 **가역적이다.** `memory.retracted`의 doc이 적은 «retract-the-retraction»
  (`memory.ts:180-183`, `5c32613`)과 같은 방식으로, 선택 필드 `revokes`가 앞선 무효 선언
  이벤트의 id를 지목하면 그 선언의 효력이 걷힌다.
- 시점 재생(point-in-time replay)도 보존된다 — 창이 닫힌 시각은 선언 이벤트의 `createdAt`이고,
  그 이전 시점을 재생하면 무효 대상이 여전히 유효하게 보인다.

## 5. advisory의 한계

서버가 보장하는 것은 **«모든 소비자가 같은 순서·같은 근거로 무효 선언을 읽을 수 있다»**
까지다. 실제로 뷰에서 빼는 것은 소비자의 몫이다(mori-nest #55가 후보 ⓑ를 고른 결과).
구체적으로 서버는 아래를 **막지 못한다**: 무효 선언을 읽고도 무시하는 소비자 / 선언 이전에
이미 읽어 자기 컨텍스트나 다른 시스템으로 흘려 보낸 사본 / 무효 대상을 그대로 담은 채
발행된 파생물(§4의 (a)가 기본이므로 이것은 결함이 아니라 계약된 동작이다) / 선언 이벤트가
sync로 도달하기 전에 오프라인 소비자가 내리는 판단. 강제(mori-nest §Q5의 ⓐ 읽기 경로 필터 /
ⓒ 실제 삭제)는 전송 스펙의 «조용한 누락 금지»와 «이벤트 삭제 금지 MUST NOT»을 뒤집는
일이라 **별도 사람 결정**이며, 이 조각은 그 문을 열지 않는다.

**두 가지는 advisory의 «소비자가 안 지킨다»와 다른 종류의 한계라 따로 적는다.**

- **자격은 증명이 아니라 주장이다.** §2의 owner 게이트는 이벤트가 스스로 나르는
  `writerRole`을 믿는다. 게이트웨이는 payload를 파싱하지 않으므로(H010) 그 값을 검증할
  주체가 없고, `MemoryRetractedPayload.writerRole`의 doc이 같은 성질을 이미 «trusted-membership
  claim, not a cryptographic proof»로 명시하며 H030의 수용된 트레이드오프라고 적는다
  (`packages/kernel/src/domain/entities/memory.ts:199-201`, `5c32613`). 무효 선언은 그 신뢰
  모델을 **물려받을 뿐 넓히지도 좁히지도 않는다** — union에 쓸 수 있는 writer는 `owner`를
  참칭해 교차 레인 선언을 낼 수 있다. 이것이 문제가 되는 시점은 서명된 출처가 필요해지는
  시점이고, 그것은 이 조각이 아니라 전송 계층의 일이다.
- **0건 매칭이 조용하다.** `target`이 아무 이벤트도 잡지 못한 선언과 제대로 적용된 선언이
  소비자 쪽에서 구분되지 않는다 — 오타 하나(`sourceProjectId` 한 글자)면 선언은 성공한
  것처럼 보이고 아무것도 빠지지 않는다. 위 «빈 값은 미설정이 아니다» 규칙(§1.3)이 가장
  흔한 실수만 막고, 나머지는 T2(출처 노출)가 열려 사람이 결과를 눈으로 대조할 수 있어야
  닫힌다(§2.1). **배선 조각은 «몇 건이 잡혔는가»를 선언의 결과로 노출해야 한다** — §후속 F3.

**강제가 필요해지면 다시 열 조건** (mori-nest 산정 §Q5-T3 참조):

1. 무효 선언을 무시하는 소비자가 **실제로 관측**됐을 때 (오늘은 소비자가 0개라 관측 자체가
   불가능하다).
2. 무효 대상이 법적·계약적 삭제 의무(개인정보 삭제 요구 등)에 걸릴 때. 그때는 advisory가
   원리적으로 부족하다 — 「보이지 않게」와 「없다」의 차이가 의무의 내용이기 때문이다.
3. 보존/절단(`0002 §8-6`, §Q5-T3)이 열려 실제 이벤트 제거 경로가 이미 생겼을 때. 그 경로가
   존재하면 ⓒ의 비용이 «새 능력»에서 «기존 능력의 재사용»으로 바뀐다.

## 6. 미결

**owner의 사람 결정이 필요하다.** 아래 셋은 문서 안에서 임의로 고르지 않았다.

### 미결1 — 출처 축의 입도: store인가 replica인가

| 선택지                                   | 장점                                                                | 단점                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **㈎ `sourceProjectId`(store)로 확정**   | 오늘 실물에 있다. 선행 0. 배선 조각이 바로 열린다                   | 같은 사람의 두 기기를 못 가른다. #115 P3의 `cp -r` 복제 시나리오를 정확히 못 겨눈다                     |
| **㈏ replica id를 먼저 도입**            | 사람 결정의 문자 그대로를 만족한다                                  | #115 2단계(로컬 replica·부트스트랩)에 선행이 걸리고, 그것은 `0002 §8-6` 게이트 아래다. 이 조각이 막힌다 |
| **㈐ ㈎로 지금 세우고 필드를 열어 둔다** | 지금 배선이 열린다. replica id가 생기면 `target.replicaId`를 더한다 | 필드가 둘로 늘고, 둘 다 있는 선언의 해석 규칙을 나중에 정해야 한다                                      |

**추천: ㈐.** 이유는 이 조각이 «지금 정할 수 있는 것을 지금 정한다»는 자리이고(mori-nest
§Q5-T1이 T2와 독립이라고 적은 것과 같은 성질), ㈏를 고르면 `0002 §8-6` 게이트가 이 조각까지
끌어내려 이슈 본문이 명시적으로 배제한 상황이 된다. ㈐의 단점(해석 규칙)은 «둘 다 있으면
AND» 한 줄로 닫히며, 그 한 줄은 replica id가 실제로 생기는 조각에서 적으면 된다.
이 문서의 §1.3 표는 ㈐를 전제로 쓰였다 — ㈎/㈏가 선택되면 §1.3을 그에 맞게 대체하는 새
문서가 필요하다.

### 미결2 — 자기 레인 파생물 캐스케이드의 **기본값**

§4.3은 `derivatives`를 필수로 두어 «기본값 없음»을 골랐다. 대안은 자기 레인에 한해
`'invalidate'`를 기본으로 두는 것이다 — 사람의 직관("내가 쓴 것을 무효로 하면 거기서 나온
것도 무효")에 가깝다. 반대 근거는 무효 선언 하나가 몇 개의 memory를 죽일지 선언자가
예측할 수 없다는 점이다(하나의 memory가 여러 관측을 재료로 삼으므로, 겹침 하나로 무관한
내용까지 닫힌다). **추천: 지금대로 필수 유지.** 예측 불가능한 파급은 명시적으로 요구받아야
한다. 다만 이것은 UX 판단이 섞여 있어 owner 몫으로 올린다.

### 미결3 — 기간 축의 정본: `createdAt`인가 이벤트 id 커서인가

§1.2가 `createdAt` 반열린 구간을 골랐지만, 증류 워터마크는 이벤트 id를 쓴다
(`consolidate-service.ts:2351-2356`, `5c32613`). 두 방식이 리포 안에 공존하게 된다.

- `createdAt`: 사람이 읽고 쓸 수 있다("어제 오후부터"). 기기 시계 오차에 노출된다.
- 이벤트 id 커서: 오차가 없다. 사람이 지목할 수 없고, id가 사라지면 «전부»로 degrade하는
  기존 동작이 무효 선언에서는 **위험**하다(의도보다 넓게 무효화된다).

**추천: `createdAt` 유지.** degrade 방향이 안전한 쪽(좁게)이고, 무효 선언은 사람이 내는
행위라 사람이 읽을 수 있는 축이어야 한다. 시계 오차는 §5의 advisory 한계 안에 있다 —
어차피 강제가 아니다.

## 7. payload 스키마 (TypeScript)

§1.3·§2·§4.3이 정한 것을 하나의 타입으로 모은 것이다. **아직 코드가 아니다** — 배선
조각(§후속 F3)이 `packages/kernel/src/domain/entities/memory.ts`의 이웃 자리에 넣는다.
새 `DomainEventType`은 `'origin.invalidated'`를 제안한다(기존 `memory.retracted`가 memory
하나를 지목하는 것과 달리, 이것은 **출처 축**을 지목하므로 `memory.` 네임스페이스가 아니다).

```ts
/**
 * 되돌림(선별 제거)의 무효 선언 — «출처 축 + 기간»으로 지목한 이벤트 집합을 무효로 본다는
 * 클라이언트 개념(0002 §1.4). 로그에 append되는 평범한 이벤트이며, 아무것도 삭제하지 않는다.
 * 효력은 프로젝션에서 대상의 유효 창을 닫는 것으로만 나타난다(memory.retracted와 같은 수법).
 *
 * 선언자 신원은 이 payload가 아니라 DomainEvent의 `writer`/`sourceProjectId`가 나른다.
 */
export interface OriginInvalidatedPayload {
  /**
   * 무엇을 무효로 보는가. 다섯 필드는 AND로 결합한다.
   *
   * 선택 필드의 부재는 «그 축으로 좁히지 않는다»(= 가장 넓게)를 뜻하므로, 빈 문자열·빈
   * 배열·역전된 구간은 부재로 강등하지 않고 **선언 전체를 무효**로 만든다 (§1.3) —
   * 좁히려던 선언이 조용히 가장 넓은 선언이 되는 것을 막는 유일한 장치다.
   */
  target: {
    /** 무효로 볼 발신 store id (필수 — 이것이 없으면 출처 축 기반이기를 그친다). */
    sourceProjectId: EntityId;
    /** 그 store 안에서 actor로 더 좁힌다. 없으면 그 store의 모든 writer. */
    writer?: string;
    /** 기간 시작, 포함. 없으면 로그의 처음부터. */
    fromCreatedAt?: ISODateString;
    /** 기간 끝, 배타. 없으면 이 선언 이벤트 자신의 createdAt까지. */
    toCreatedAt?: ISODateString;
    /** 없으면 'observation.captured' + 'memory.consolidated' 둘 다. */
    eventTypes?: DomainEventType[];
  };
  /**
   * 파생물 처리 의도 (필수, 기본값 없음 — §4.3). 'invalidate'는 무효 대상 관측과
   * sourceObservationIds가 하나라도 겹치는 memory의 창을 함께 닫는다. 대상 memory마다
   * 레인 게이트가 다시 걸린다(§4.4).
   */
  derivatives: "leave" | "invalidate";
  /** 왜 무효로 보는가 (자유 서술) — MemoryRetractedPayload.reason과 같은 성격. */
  reason?: string;
  /**
   * 선언자의 workspace role AT AUTHORING TIME. 교차 레인 선언일 때만 클라이언트가 Hub
   * 컨트롤플레인 확인 뒤 찍는다. 자기 레인 선언에는 없다. 리듀서는 교차 레인 선언을
   * 이것이 'owner'일 때만 존중한다(MemoryRetractedPayload.writerRole과 동일 규율 —
   * role이 이벤트에 실려야 하는 이유는 그쪽 doc이 적는다).
   */
  writerRole?: "owner" | "member";
  /** 앞선 무효 선언(이벤트 id)의 효력을 걷는다 — 가역성(SoT-050의 retract-the-retraction). */
  revokes?: EntityId;
}
```

## 8. 후속

| 조각                                | 무엇                                                                                                                                                                            | 선행                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **F1** replica id 도입              | #115 P3(발급·커서 포크 감지·재발급). 이것이 서야 «replica X»가 계약에 적힐 수 있다(§1.1)                                                                                        | #115 2단계 — `0002 §8-6` 게이트 아래   |
| **F2** 출처 노출 (mori-nest §Q5-T2) | 사람이 선언 대상을 고르고, 적용 결과를 감사할 화면. **배선 조각의 선행이다** (§2.1)                                                                                             | 없음 (mori-nest 몫)                    |
| **F3** 무효 선언의 배선             | `OriginInvalidatedPayload` + `origin.invalidated` 이벤트 타입 + 리듀서 케이스 + §3 표의 읽기 경로 적용 + `search_fts` 재작성 규칙 + §1.3의 빈 값 무효 규칙 + 매칭 건수 노출(§5) | 이 문서 머지 + §6 미결 3건의 사람 결정 |
| **F4** `events.ts` 주석 정정        | `events.ts:84-92`의 "currently UNCONSUMED"가 `sourceProjectId`에 대해 틀렸다(§1.1). 1줄 정정 — 이 조각의 범위가 아니다                                                          | 없음                                   |
| **F5** 검증                         | 무효 선언을 실물로 재는 것. F2가 없으면 «빠졌는지»를 확인할 수 없다 — mori-nest §Q5-T2가 적은 «검증만 못 한다»의 해소 자리다                                                    | F2, F3                                 |

**이 문서가 열지 않는 것:** 서버 계약 변경(`0002`·`0003`) / 보존·절단(`0002 §8-6`, §Q5-T3) /
`.mori/project.json` 계약(#379가 이미 세웠다 — `packages/mori/src/kernel/index.ts:203-205`,
`5c32613`. 인용만 하고 고치지 않았다) / 강제(ⓐ·ⓒ, §5의 조건이 성립하기 전까지).
