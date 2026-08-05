# detectContradictions 중복 재판정 산정 (#289, #189 잔여 ㉰ + 후보②)

[#289](https://github.com/shakystar/mori/issues/289)의 산정 문서다. **구현하지 않는다** —
후보를 코드와 리포가 이미 내린 판정에 대조해서 권고 1개를 확정하고, 나머지는 각하 사유를
남긴다. 실제 코드 변경은 권고가 확정된 뒤 별도 이슈에서 잘린다 (#277 → #282 → #284가
지킨 순서다).

`docs/storage-boundary-secrets.md`·`docs/compaction-consolidation-boundary.md`와 같은
규율을 따른다: **코드가 정본이고 이 문서는 그 지도다.** 아래 모든 인용은 §0의 기준 커밋
실물이며, 코드와 어긋나면 코드를 따르고 이 문서를 고친다.

## 필수 질문 → 절 매핑

| Q   | 질문                                            | 절                                                        |
| --- | ----------------------------------------------- | --------------------------------------------------------- |
| Q1  | #284 마커가 ㉰를 얼마나 덮는가 / 재판정 창의 폭 | [§1](#1-q1--284의-마커가-㉰를-덮는-범위와-재판정-창의-폭) |
| Q2  | 중복이 실제로 남기는 손해                       | [§2](#2-q2--중복이-실제로-남기는-손해)                    |
| Q3  | 후보 (가) 결정적 conflict id                    | [§3](#3-q3--후보-가-결정적-conflict-id)                   |
| Q4  | (가)의 반대 위험 — 정당한 재판정을 막는가       | [§4](#4-q4--정당한-재판정이-존재하는가)                   |
| Q5  | 후보② 로그 replay 근거 + 실측                   | [§5](#5-q5--후보-로그-replay-근거와-실측)                 |
| Q6  | 리포가 이미 내린 판정과의 대조                  | [§6](#6-q6--리포가-이미-내린-판정과의-대조)               |
| Q7  | 권고 1개와 후속 이슈의 개수·순서                | [§7](#7-q7--권고와-후속-이슈)                             |

그 밖에: [§0 기준선과 결함의 모양](#0-기준선과-결함의-모양),
[§8 산정 중 발견한 주석↔실물 어긋남](#8-산정-중-발견한-주석실물-어긋남-고치지-않음).

## 0. 기준선과 결함의 모양

- 기준 커밋: `dbfc7ab` (PR #288 머지 직후, `main`). 인용한 줄 번호는 이 시점의 것이다.
- 선행 게이트: #284가 [PR #286](https://github.com/shakystar/mori/pull/286) `d7eb12a`로
  닫혀서 이 산정의 조건이 충족됐다 (#189의 07:51 코멘트).

㉰는 **누락이 아니라 중복**이다. 사슬은 세 사실로 이루어진다.

1. `detectContradictions`의 판정 basis는 **프로젝션 테이블**이다 —
   `listValidMemories(projectId)` (`contradiction-service.ts:173`), 즉
   `memories.invalid_at IS NULL` 행들 (`projection-store.ts:1024`).
2. 그 함수가 자기 판정 결과를 프로젝션에 반영하는 자리는 조건부이고, 반영에
   실패해도 아무도 모른다 — `if (results.length > 0) { await rebuildProjectProjection(projectId); }`
   (`contradiction-service.ts:303-304`), 반환값 `{ committed }`는 버려진다.
3. append는 멱등이 아니다. `createConflict`는 `baseEntity()`를 거쳐 **호출마다 새 id**를
   민팅하고 (`domain/entities/base.ts:7-15`, `entities/conflict.ts:30-51`),
   `contradiction-service.ts:240-241`의 주석이 그 성질을 이미 적어 놨다 —
   _"`createConflict` mints a fresh random id, so the winner's and the loser's both survive"_.

따라서 리빌드가 커밋되지 않으면 패배자가 계속 valid로 보이고, 다음 판정 패스가 **같은 쌍을
다시 판정**해 중복 `conflict.detected` + 중복 `memory.superseded`로 굳는다.
#253의 `expectedHead`는 이것을 막지 않는다: 두 패스가 시간상 분리돼 있으면 두 번째 패스가
읽는 head(`contradiction-service.ts:171`)는 이미 첫 append를 반영하고 있어 CAS가 통과한다.

트리거는 `project-lock.ts`의 락 dispossession 레이스 하나다. 같은 파일이 이 함수를 이미
UNSAFE로 분류하면서 비멱등성까지 적어 놨다 (`project-lock.ts:181-186`).

## 1. Q1 — #284의 마커가 ㉰를 덮는 범위와 재판정 창의 폭

### 1.1 마커는 ㉰를 직접 0% 덮는다 — 그리고 덮을 필요가 없다

#284의 write-ahead 마커(`SEARCH_REINDEX_PENDING_META_KEY`,
`projection-store.ts:273-287`)가 하는 일은 하나뿐이다: `reindexSearch: false` 요청을
`true`로 **승격**시킨다 (`projection-store.ts:344`). 승격의 대상은 `search_fts`뿐이고,
㉰가 사는 자리는 `search_fts`가 아니라 **프로젝션 테이블의 valid 집합**이다.

그런데 테이블 쪽에는 애초에 마커가 필요 없다. 리빌드 트랜잭션 안에서 테이블 replace-all은
**무조건**이고 (`projection-store.ts:447-449`의 `DELETE` 루프, `SINGLETON_TABLES` +
`ENTITY_TABLES` 전체), 조건부인 것은 `search_fts` 와이프뿐이다
(`projection-store.ts:467-469`). 그리고 `memories` 행은 `invalid_at`을 그대로 실어
다시 쓰인다 (`projection-store.ts:656-673`). 즉 `reindexSearch: false`인 리빌드도
superseded를 테이블에 반영한다.

`consolidate-service.ts:2603-2606`의 _"any later rebuild replays the full log
unconditionally, `reindexSearch: false` ones included"_ 는 **실물에서 참이다.** 다만 한
단어가 빠져 있고, ㉰에서는 그 단어가 전부다: 무조건인 것은 replay와 테이블 replace이지만,
그 트랜잭션 전체가 CAS 뒤에 있다 — `if ((headEventId(db) ?? null) !== snapshotHead) return;`
(`projection-store.ts:441`). CAS를 잃은 리빌드는 **한 행도 쓰지 않고**, 재시도를 다 쓰면
`{ committed: false }`로 돌아간다 (`projection-store.ts:355-359`). 그러므로 정확한 표현은
"다음 리빌드"가 아니라 **"다음에 커밋하는 리빌드"** 다.

### 1.2 창의 폭 (한 문장)

> **㉰의 재판정 창은 `detectContradictions` 자신의 리빌드(`contradiction-service.ts:303-304`)가
> 커밋에 실패한 순간 열리고, 이 프로젝트에서 CAS를 이기는 다음 리빌드 단 하나로 닫힌다 —
> 그 리빌드가 `reindexSearch: false`인 capture의 것이어도 닫힌다(`capture-service.ts:314`).
> 상한은 "커밋하는 리빌드 1회"이고, 시간 상한은 없다** (커밋하는 리빌드가 언제 오는지는
> 그 프로젝트에 캡처·경계가 언제 도는지에 달렸다).

### 1.3 창 안에서 중복이 실제로 굳으려면 — 도달 조건 넷

창이 열려 있다는 것과 중복이 굳는다는 것은 다르다. 재판정이 실제로 일어나려면 넷이 모두
성립해야 한다.

1. `detectContradictions`의 리빌드가 CAS를 3전패한다 (`REBUILD_STALE_HEAD_RETRIES = 2`,
   즉 최초 1회 + 재시도 2회 — `projection-store.ts:269`).
2. **다음 경계의 리빌드도 3전패한다.** `consolidateBoundary`에서 리빌드(`:2630-2631`)는
   `detectContradictions`(`:2647`) **보다 먼저** 돌고, `detectContradictions`가 도는
   조건(`inputs.length > 0`)은 그 리빌드 게이트(`inputs.length > 0 || segmentsWritten > 0`)를
   반드시 만족시킨다. 그래서 다음 경계의 리빌드가 커밋하면 그 자리에서 창이 닫힌다.
3. 두 경계 사이에 커밋한 capture 리빌드가 **하나도 없어야** 한다 (`capture-service.ts:314`).
   관찰이 하나라도 캡처되고 그 리빌드가 커밋하면 창이 닫힌다.
4. judge가 같은 쌍을 **다시** `contradicts: true`로 판정해야 한다. judge는 LLM이고
   (`makeLlmJudge`, `contradiction-service.ts:90-103`) 결정적이지 않으므로, 재판정이
   같은 답을 낸다는 보장은 없다.

세 번째까지가 #189의 07:51 코멘트가 심각도를 낮게 본 근거이고, 실물 대조 결과 그 판단은
맞다. **㉰는 희귀하다.** 이 답이 나머지 Q의 무게를 정한다 — 아래 후보들은 "㉰를 얼마나
잘 막는가"만으로는 어느 것도 값을 못 낸다. 값이 갈리는 자리는 **후보가 ㉰ 말고 무엇을
더 닫는가**이며, §5와 §7이 그 축으로 판정한다.

## 2. Q2 — 중복이 실제로 남기는 손해

### 2.1 중복 `memory.superseded` — projector가 접지만, 완전히 멱등은 아니다

`projector.ts:562-576`은 `state.memories[payload.supersedes]`에 `invalidAt`과
`supersededBy`를 덮어쓴다. 두 이벤트의 `supersedes`/`supersededBy`가 같으므로 **행은
하나로 접힌다.** 다만 `invalidAt = event.createdAt`이라 **두 번째(나중) 이벤트의 시각이
이긴다** — 유효 창이 첫 supersede가 아니라 재판정 시점에 닫힌 것으로 기록된다. 관측 가능한
차이는 시점 재생(`getProjectStateAtRevision`, `projection-store.ts:779`)에서 두 append
사이 구간의 답이 "아직 valid"로 바뀌는 것 하나다. `reason`은 프로젝션에 실리지 않으므로
(위 case가 읽지 않는다) 로그에만 남는다 — judge의 자유 서술이 매번 달라도 프로젝션은
동일하다.

### 2.2 중복 `conflict.detected` — 두 행이 남는다

`projector.ts:467-469`는 `conflict.detected`/`conflict.resolved`를 `event.scopeId`로
키잉한다. `detectContradictions`는 `scopeId`에 **conflict 자신의 id**를 싣고
(`contradiction-service.ts:256-262`, 그렇게 하는 이유는 `conflict-service.ts:71-76`),
그 id는 호출마다 새로 민팅되므로 **키가 다르다** → `conflicts` 테이블에 **두 행**이 남는다.
이슈 본문의 예상과 일치한다.

### 2.3 표면까지 — 오늘 에이전트에게 2건으로 보이는 자리는 없다

두 행이 어디까지 가는지 끝까지 따라간 결과다.

| 단계                         | 실물                                                                 | 중복이 보이나       |
| ---------------------------- | -------------------------------------------------------------------- | ------------------- |
| `conflicts` 테이블           | `projection-store.ts:447-449`가 replace-all로 다시 씀                | 2행                 |
| `listOpenConflicts`          | `projection-store.ts:945-951`, 종결 상태만 제외                      | 2건                 |
| `buildMemoryIndex`           | `projector.ts:702-709`, 같은 "종결 아님" 규칙                        | 2엔트리             |
| `memory_index` 싱글턴 JSON   | `projection-store.ts:487-490`                                        | 2엔트리             |
| `search_fts`                 | `SearchKind`에 `conflict`가 없다 (`projection-store.ts:44-45`)       | **안 감**           |
| `StartupContextPayload`      | `openConflicts` 필드는 선언만 (`entities/startup-context.ts:34`)     | **채우는 코드 0건** |
| 커널 컨텍스트 조립           | `buildMemoryContext`는 세 필드만 뽑는다 (`context-service.ts:22-25`) | **안 감**           |
| `packages/mori` (호스트 CLI) | 리포 전체에서 `conflict` 문자열 0건                                  | **안 감**           |

`openConflicts`는 리포 전체에 세 곳뿐이다 — 생산 1곳(`projector.ts:704`)과 타입 선언
2곳(`entities/memory-index.ts:14`, `entities/startup-context.ts:34`). 즉 **오늘 중복이
에이전트 눈에 2건으로 보이는 경로는 존재하지 않는다.**

### 2.4 손해의 총계

- (a) `conflicts` 2행 + `memory_index.openConflicts` 2엔트리 — **오늘 소비자 0건**, 첫
  소비자가 배선되는 날 표면화된다.
- (b) 시점 재생에서 `invalidAt`이 재판정 시점으로 밀림 (§2.1).
- (c) **낭비된 judge LLM 왕복 1회** — 이것만은 오늘 즉시 발생하고, 유일하게 값이 붙는
  손해다.
- (d) append-only 로그에 영구히 남는 중복 이벤트 2건 (지울 수 없다 — 이 리포의
  invalidate-not-delete 규율).

## 3. Q3 — 후보 (가) 결정적 conflict id

### 3.1 결론부터 — 결정적 conflict id는 두 번째 append를 거부시키지 못한다

**conflict의 id와 이벤트의 id는 다른 것이다.** `appendEvents`는 입력마다 이벤트 id를
자기가 민팅한다 — `id: createId("evt")` (`event-store.ts:286`; 단건 경로도 `:202`로
같다). 그리고 `AppendEventInput`에는 **id 필드가 아예 없다** (`event-store.ts:13-28`).
따라서 `createConflict`가 내용 기반 id를 쓰든 무작위 id를 쓰든, 그 값은 **payload에만**
실리고 append 경로는 그대로 통과한다. 두 번째 append는 거부되지 않는다.

### 3.2 유니크 제약은 실재하고, 조용한 무시가 아니라 예외다

이슈가 실물로 확인하라고 한 자리다.

- `events.id`는 v1부터 `TEXT NOT NULL UNIQUE`다 (`storage/db.ts:295-297`).
- `insertEvent`는 평범한 `INSERT`이고 `OR IGNORE`가 아니다 (`event-store.ts:172-193`).
  → 중복 id는 **조용한 무시가 아니라 `SQLITE_CONSTRAINT_UNIQUE` 예외**이며,
  `appendEvents`의 트랜잭션 안에서 던져지므로 배치 전체가 롤백된다
  (`event-store.ts:303-313`, JSDoc은 `:272-273`).
- 이 모양을 실제로 쓰는 선례가 이미 있다 — v18 `idx_events_genesis_once`
  (`storage/db.ts:884-889`)와 그 판별자 `isDuplicateGenesisError`
  (`event-store.ts:100-106`). #189 B가 노린 자리가 정확히 이것이다.

즉 "유니크 제약으로 중복 append를 거부한다"는 이 리포에서 검증된 수단이다. 다만 ㉰에
쓰려면 **호출자가 이벤트 id를 지정하는 새 이음매**가 필요하다 (`AppendEventInput.id`).
그것은 이벤트 정체성 변경이고, #282가 값을 낸 종류의 대가를 진다:

- 중복이 **예외**가 되어 `detectContradictions`의 꼬리에서 throw된다. 그 꼬리는 던지면
  안 되는 자리이고, 왜 안 되는지가 이미 적혀 있다 (`contradiction-service.ts:271-283`:
  두 호출자 모두 커서 커밋 전에 이것을 돌리므로, 여기서 던지면 창이 미소비로 남아
  _"buying a rare race with a certain duplicate"_).
  → `isDuplicateGenesisError` 모양의 판별자와 삼킴 경로를 하나 더 만들어야 한다.
- `memory.superseded`는 **전혀 건드리지 못한다.** 그 이벤트의 `scopeId`는 projectId이고
  (`contradiction-service.ts:247-253`), payload에는 id가 없으며, 이벤트 id 민팅 자리는
  동일하게 `event-store.ts:286`이다. 결정적 conflict id를 도입해도 중복
  `memory.superseded`는 그대로 남는다.

### 3.3 projector의 divergent-id throw와는 충돌하지 않는다

`projector.ts:345-350`의 throw는 `project.created` 전용(같은 스토어에 서로 다른 self
genesis id 두 개)이고, 바로 위 주석이 _"A repeated SAME id (idempotent re-pull) is fine"_
이라고 적어 놨다 (`projector.ts:342`). conflict 경로와는 무관하다.

### 3.4 정규화 함정 — 안 하면 "결정적"이 아니다

내용 기반 id의 재료로 자연스러운 `(projectId, leftVersion, rightVersion)`은 **그대로
쓰면 안 된다.** `leftVersion`/`rightVersion`은 스냅샷 순회 순서의 `a`/`b`이고
(`contradiction-service.ts:222-230`, 바깥 루프 `i` = a, 안쪽 루프 `j` = b), 그 순서의
출처인 `listValidMemories`의 SQL에는 **`ORDER BY`가 없다**
(`projection-store.ts:1017-1024`). 같은 쌍이 다음 패스에서 반대 순서로 나올 수 있으므로,
정렬 정규화(예: 두 id를 사전순 정렬한 뒤 해시)를 하지 않으면 id는 결정적이지 않다.
승자 선택은 이 순서에 영향받지 않는다 — `pickWinner`는 `(createdAt, id)` 대칭 규칙이다
(`contradiction-service.ts:125-133`).

### 3.5 (가)가 오늘 실제로 하는 일

새 이음매 없이 `createConflict`의 id만 결정적으로 바꾸면, 얻는 것은 **프로젝션 레벨의
접힘 하나**다: 두 `conflict.detected`의 `scopeId`가 같아져 `state.conflicts`의 같은 키에
덮어써지므로 `conflicts` 테이블이 2행 → 1행이 된다 (§2.2의 손해 (a)만 제거). 로그의 중복
이벤트 2건(손해 (d)), 중복 `memory.superseded`(§2.1), 낭비된 LLM 왕복(손해 (c))은
전부 그대로다.

## 4. Q4 — 정당한 재판정이 존재하는가

> **정당한 재판정이 존재하는가: 아니오.** 오늘의 배선에서 한 번 판정된 쌍이 다시
> 판정되어야 하는 경로는 없다. 근거 셋:
>
> 1. **메모리 텍스트는 불변이다.** `DomainEventType`에 메모리 본문을 바꾸는 이벤트가 없다 —
>    `memory.consolidated` / `memory.superseded` / `memory.retracted` / `memory.injected`가
>    전부다 (`domain/events.ts:64-76`). "텍스트가 바뀌어서 다시 판정" 경로는 존재하지 않는다.
> 2. **패배자는 되살아나지 못한다.** `invalidAt`을 **되돌리는** 이벤트가 없다 —
>    `memory.superseded`(`projector.ts:562-576`)와
>    `memory.retracted`(`projector.ts:577-605`) 둘 다 설정만 하고, 지우는 case가 없다.
>    `listValidMemories`는 `invalid_at IS NULL`만 읽으므로(`projection-store.ts:1024`)
>    패배자는 영구히 basis 밖이고, 같은 쌍은 다시 비교되지 않는다.
> 3. **승자는 결정적이다.** `pickWinner`는 `(createdAt, id)` 규칙이라
>    (`contradiction-service.ts:125-133`) 재판정이 일어나도 판정 결과 자체는 같다 —
>    "다시 판정해서 다른 답이 나와야 하는" 경우가 없다.

따라서 결정적 conflict id가 막을 "정당한 재판정"은 없고, id에 버전이나 경계 id를 더
섞을 필요도 없다. **(가)는 위험해서 각하되는 것이 아니라 append에 닿지 못해서 각하된다**
(§3.1).

회색지대 둘을 명시해 둔다.

- **복제본 사본**: `dedupeMemoriesBySource`(`projector.ts:234-265`)가 같은 lane의
  동일 내용 메모리를 접는데, 그 dedup 패배자는 `invalidAt`이 붙는다(`:258-262`) —
  즉 여기서도 되살아남은 없다. dedup이 **살려둔** 쪽이 나중에 다른 쌍을 이루는 경우는
  id가 다른 **새 쌍**이라 결정적 id에 막히지 않는다. `sourceObservationIds`가 빈
  메모리는 dedup 자체에서 제외된다 (`projector.ts:238-239`).
- **동기화 수신**: 오늘 이 리포에는 남의 이벤트를 로그로 받아들이는 경로가 없다 —
  `memory.retracted`를 append하는 프로덕션 코드는 0건이고 테스트뿐이며,
  `readEvents`를 쓰는 비-스토어 코드도 두 곳뿐이다(`projection-store.ts:378`,
  `memory-import-service.ts:213`). 수신 경로가 생겨도 근거 2(`invalidAt`은 되돌아가지
  않는다)는 유지되므로 결론은 바뀌지 않지만, 근거 1·3의 전제(단일 writer)는 그때
  다시 대조해야 한다.

부수적으로: 결정적 conflict id는 **복제본 간 수렴**에는 이득이다 — 두 복제본이 같은 쌍을
독립적으로 판정하면 오늘은 서로 다른 id 두 개가 union 뒤 둘 다 살아남고, 결정적 id면
하나로 접힌다. `dedupeMemoriesBySource`가 메모리에 대해 하는 일(P3-a)과 같은 모양이다.
이 이득은 실재하지만 ㉰와는 다른 축이므로 §7의 판정 근거로 쓰지 않는다.

## 5. Q5 — 후보② 로그 replay 근거와 실측

### 5.1 ㉰를 닫는가: 예, 근본에서 닫는다

basis를 `listValidMemories`(프로젝션) 대신 **로그 replay**로 잡으면, 첫 패스가 append한
`memory.superseded`가 이미 로그에 있으므로 두 번째 패스의 basis에서 패배자는 `invalidAt`을
갖는다 → 재판정 자체가 일어나지 않는다. **어떤 리빌드도 커밋될 필요가 없다.**
§1.3의 도달 조건 넷이 전부 무의미해진다.

구현 모양은 새로 발명할 것이 없다 — `memory-import-service.ts:210-230`의
`readValidMemoriesFromLog`가 **같은 이유로 이미 존재한다**: 프로젝션 캐시가 아니라
이벤트 로그가 멱등성의 정본이라는 것(`memory-import-service.ts:52-57`).
`kind === "decision"` 필터만 얹으면 된다.

### 5.2 ㉰ 관점에서 #282의 moot 판정과 값이 달라지는가: 예

#282는 후보②를 **㉯(FTS 간극) 관점에서** moot으로 판정했고, 그 판정은 옳다 — ㉯는
`search_fts` 색인이 언제 채워지느냐의 문제라서 판정 basis를 어디서 읽느냐와 무관하다.
㉰는 반대다: **basis 자체가 결함의 자리**다. 그래서 같은 후보가 ㉰ 관점에서는 유일하게
근본을 닫는 안이 된다.

부수 효과가 하나 더 있고, 이것이 이 후보의 진짜 값이다. 오늘 `detectContradictions`는
**head는 로그에서, basis는 프로젝션에서** 가져온다 (`contradiction-service.ts:171` vs
`:173`). `AppendEventsOptions.expectedHead`의 doc이 정확히 이 구멍을 적어 놨다:

> _"That guarantee covers only a race BETWEEN the two reads … when 'the basis' is a
> derived cursor or projection that a concurrent writer advances separately from its own
> append …, head-before-basis ordering here does not guarantee that cursor has caught
> up — the check can still PASS while the caller's basis is behind the log. See #263."_
> (`event-store.ts:246-256`)

리포는 이 문제를 이미 세 곳에서 같은 방법으로 닫았다 — **basis와 그것을 증명하는 head를
한 배열에서 뽑는다**: `readValidMemoriesFromLog`(#253,
`memory-import-service.ts:224-228`), `attemptProjectionRebuild`(#270,
`projection-store.ts:376-379`), 그리고 #262의 dedup 스냅샷. `detectContradictions`는
**그 규율이 적용되지 않은 마지막 자리**이고, 후보②는 그 자리를 채운다.

### 5.3 실측

측정 방법:

- 스크립트: 임시 파일(커밋하지 않음). 전문과 원출력은 PR 본문에 첨부.
- 셀마다 **13회** 실행, **앞 3회를 워밍업으로 폐기**, 남은 **10회의 중앙값**을 싣는다
  (#277이 쓴 형식).
- `n` = 로그의 `decision` 메모리 개수. 로그 길이는 `n + 1` (genesis 1건 포함).
- 스토어는 `n`마다 새로 만들고 `reindexSearch: true` 리빌드를 1회 돌린 뒤 측정 —
  따라서 SQLite 페이지 캐시가 **워밍된 상태**의 수치다 (콜드 스타트가 아니다).
- 환경: Node v22.23.2, better-sqlite3, 리눅스 컨테이너. 절대값이 아니라 **열 사이의 비**가
  판정 재료다.

|    n | 로그 길이 | `listValidMemories`+필터 (오늘의 basis) | `readHeadEventId` (오늘의 추가 조회) | replay basis (후보②) | 참고: `rebuild(reindexSearch:true)` |
| ---: | --------: | --------------------------------------: | -----------------------------------: | -------------------: | ----------------------------------: |
|    0 |         1 |                                 0.02 ms |                              0.01 ms |              0.07 ms |                             0.86 ms |
|   50 |        51 |                                 0.16 ms |                              0.01 ms |              0.46 ms |                             2.25 ms |
|  200 |       201 |                                 0.41 ms |                              0.01 ms |              0.95 ms |                             5.54 ms |
| 1000 |      1001 |                                 2.83 ms |                              0.01 ms |              4.96 ms |                            22.58 ms |
| 5000 |      5001 |                                11.12 ms |                              0.01 ms |             39.31 ms |                           758.48 ms |

`replay basis` 열은 `readEvents` + `reduceProjectState` + valid/self/decision 필터 +
head 추출을 한 덩어리로 잰 것이다 — 후보②가 하는 일 전부이며, 오늘의 두 조회(basis +
head)를 **대체**한다.

한계비용 = `replay` − (`projection` + `head`):

|    n |  한계비용 |
| ---: | --------: |
|    0 |  +0.04 ms |
|   50 |  +0.29 ms |
|  200 |  +0.53 ms |
| 1000 |  +2.12 ms |
| 5000 | +28.18 ms |

### 5.4 비용 해석

- 이 비용은 **`detectContradictions`가 실제로 도는 경계에서만** 발생한다. 그 함수는
  `inputs.length > 0`인 경계에서만 호출되고(`consolidate-service.ts:2646-2653`),
  embedder가 없으면 첫 줄에서 반환한다(`contradiction-service.ts:161`). replay를 그
  가드 **뒤에** 두면 임베딩이 꺼진 스토어의 비용은 0이다.
- 같은 경계가 이미 리빌드 1~2회(위 표의 `rebuild` 열)와 embedder 왕복 2회, 그리고 후보
  쌍마다 judge LLM 왕복 1회를 낸다(`project-lock.ts:120-128`이 이 꼬리 구성을 적어
  놨다). n=5000에서도 한계비용 28 ms는 **LLM 왕복 한 번보다 두 자릿수 작다.**
- 비교 기준: #282가 비용으로 각하한 always-reindex는 #277 실측 기준 capture마다
  n=1000 → ~319 ms였다. 위 표의 `rebuild` 열(22.6 ms @1000, 758 ms @5000)이 같은
  단위의 오늘 값이다. 후보②의 한계비용은 그보다 **두 자릿수 싸고**, 캡처 핫패스가
  아니라 이미 비싼 경계 꼬리에서만 낸다.

## 6. Q6 — 리포가 이미 내린 판정과의 대조

후보를 코드가 아니라 **이 리포가 이미 각하한 거래**에 붙여 본다.

| 리포의 판정                                              | 인용                                                                                                                                                                | (가) 결정적 id                                                           | ② replay basis                                                                         | 아무것도 안 함                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| 희귀한 레이스를 **확실한 재증류**와 바꾸지 않는다 (#211) | `consolidate-service.ts:1425-1426` — _"stopping without moving the cursor turns a rare race into a CERTAIN re-distillation"_                                        | 해당 없음 (커서를 건드리지 않음)                                         | 해당 없음                                                                              | 해당 없음                                 |
| 희귀한 레이스를 **확실한 중복**과 바꾸지 않는다          | `contradiction-service.ts:277-278` — _"buying a rare race with a certain duplicate"_                                                                                | 해당 없음                                                                | 해당 없음 — 사는 것은 확정적 _지연_ +0.04~28 ms이지 중복이 아니다                      | 해당 없음                                 |
| 같은 규율, 세 번째 사례 (#211 꼬리)                      | `project-lock.ts:136-137` — _"a rare race traded for a certain duplicate"_                                                                                          | 해당 없음                                                                | 해당 없음                                                                              | 해당 없음                                 |
| 비용이 **측정되지 않은** 전역 강화는 각하 (#282 → #284)  | `projection-store.ts:337-341` — always-reindex를 각하하며 #277 실측(n=1000 → ~319 ms)을 인용                                                                        | 비용 무시할 만함                                                         | §5.3에서 실측 (n=1000 → +2.1 ms)                                                       | 비용 0                                    |
| 호출자를 바꾸지 않는 회복을 선호 (#284)                  | `projection-store.ts:323-333` — _"The recovery is HERE, not at the five call sites"_                                                                                | `createConflict` 1곳                                                     | `detectContradictions` 내부 1곳, 호출자 0곳                                            | 0곳                                       |
| **프로덕션 호출자가 없는 경로는 굳이 가드하지 않는다**   | `conflict-service.ts:41-54` — _"It is unguarded only because this function has no production caller yet … Whoever wires the first real caller must take that lock"_ | ㉰의 표면(conflicts 소비자)은 오늘 0건 → 이 선례는 (가)를 **약화**시킨다 | basis는 표면이 아니라 **이미 프로덕션에서 도는 판정 근거**라 이 선례가 적용되지 않는다 | 이 선례는 "아무것도 안 함"을 **지지**한다 |

읽어낼 것 둘.

1. **"희귀한 레이스를 확실한 중복과 바꾸는" 규칙은 이번에 후보를 하나도 각하하지 못한다.**
   세 후보 모두 확정적 중복을 만들지 않는다. 그러므로 판정은 비용(§5.4)과 **무엇을 더
   닫는가**(§5.2)로 넘어간다.
2. `conflict-service.ts:41-54`의 선례는 §2.3(표면 소비자 0건)과 겹쳐 "아무것도 안 함"을
   꽤 강하게 지지한다. 이것이 이 산정에서 가장 팽팽한 자리이며, §7이 그대로 인정하고
   답한다.

## 7. Q7 — 권고와 후속 이슈

### 7.1 채택 — 후보② (판정 basis를 로그 replay로)

**권고는 정확히 1개다: `detectContradictions`의 판정 basis를 `listValidMemories`에서
로그 replay(`readValidMemoriesFromLog` 모양)로 옮긴다.**

근거 셋:

1. ㉰를 **근본에서** 닫는다 — 어떤 리빌드도 커밋될 필요가 없어지고, §1.3의 도달 조건이
   전부 사라진다. 중복 `conflict.detected`와 중복 `memory.superseded`를 **둘 다** 없앤다
   ((가)는 전자의 프로젝션 행만 접는다).
2. ㉰의 희귀함만으로는 값이 안 나온다는 것을 인정한 위에서 — 이 변경이 실제로 사는 것은
   **basis와 head가 서로 다른 출처에서 오는 마지막 자리**를 없애는 것이다
   (`event-store.ts:246-256`이 남긴 구멍, #263). 리포는 같은 규율을 이미 세 곳에서
   적용했고(#253/#270/#262), 여기만 남았다.
3. 비용이 측정됐고(§5.3) 작다 — n=1000에서 +2.1 ms, n=5000에서 +28 ms, embedder가
   없으면 0. 이벤트 정체성을 건드리지 않으므로 #282가 경고한 오판 비용을 지지 않는다.

후속 구현 이슈는 **1개**이고 **선행 없음**이다 (#282가 _"후속 이슈는 1개"_ 로 낸 형식).
수용 기준 초안:

- `detectContradictions`가 `listValidMemories` 대신 로그에서 basis를 만든다.
  `readValidMemoriesFromLog`와 같은 모양으로 **basis와 `expectedHead`를 같은
  `readEvents` 배열에서** 뽑는다 (별도 `readHeadEventId` 호출 제거).
- replay는 `if (!embedder) return []` 가드 **뒤에** 둔다 (embedder 없는 스토어의 비용 0).
- self lane + `invalidAt` 없음 + `kind === "decision"` 필터가 오늘의 basis와 동치임을
  보이는 회귀 테스트 1개, 그리고 **리빌드가 커밋되지 않은 상태에서 두 번째 패스가 중복을
  만들지 않는다**는 테스트 1개 (기존 `projection-rebuild-cas.test.ts` /
  `contradiction-service.test.ts`의 픽스처 재사용).
- `contradiction-service.ts:303-304`의 리빌드는 **그대로 둔다** — 그것은 basis가 아니라
  다른 독자를 위한 것이고, #284의 마커가 이미 그 실패를 회복시킨다.

### 7.2 각하 1 — 후보 (가) 결정적 conflict id

각하한다. 결정적 id는 두 번째 append를 **거부시키지 못한다**: 이벤트 id는 payload와
무관하게 `appendEvents`가 민팅하고(`event-store.ts:286`), `AppendEventInput`에는 id를
받는 필드가 없다(`:13-28`). 거부시키려면 호출자 지정 이벤트 id라는 새 이음매를 열어
`events.id` UNIQUE(`db.ts:297`)에 기대야 하는데, 그것은 이벤트 정체성 변경이고, 그
대가로 던지면 안 되는 꼬리(`contradiction-service.ts:271-283`)에서 중복이 예외로
올라오므로 `isDuplicateGenesisError` 모양의 판별자와 삼킴 경로를 하나 더 만들어야 한다.
그렇게까지 해도 중복 `memory.superseded`는 남는다 — 그 이벤트의 id 민팅 자리가 동일하고
payload에 conflict id가 없기 때문이다. 새 이음매 없이 id만 결정적으로 바꾸는 축소판은
`conflicts` 테이블 2행 → 1행이라는 프로젝션 접힘 하나를 사는데, 그 표면에는 오늘 소비자가
0건이고(§2.3), `conflict-service.ts:41-54`가 세운 선례("프로덕션 호출자가 없는 경로는
첫 호출자를 배선하는 사람이 가드한다")가 정확히 이런 지출을 미루라고 말한다. 덧붙여
정규화를 놓치면 id는 결정적이지도 않다(§3.4). **다만 복제본 간 수렴 이득(§4 말미)은
실재하므로, 동기화 수신 경로가 배선되는 날 이 후보는 그 축에서 다시 저울에 올라야 한다.**

### 7.3 각하 2 — 아무것도 하지 않는다 (이 문서로 끝낸다)

각하한다. 이것이 가장 팽팽한 후보였다: ㉰는 도달 조건이 넷이고(§1.3), 창은 커밋하는
리빌드 하나로 닫히며(§1.2), 표면 소비자는 0건이다(§2.3). 오직 ㉰만 놓고 비용·편익을
계산하면 "아무것도 안 함"이 이긴다 — 이 점은 인정한다. 각하하는 이유는 후보②가 사는 것이
㉰의 희귀함이 아니기 때문이다: 오늘 `detectContradictions`는 **head는 로그에서, basis는
프로젝션에서** 읽는 유일하게 남은 판정 경로이고, `AppendEventsOptions.expectedHead`의
doc이 그 조합에서 CAS가 통과해도 basis가 뒤처져 있을 수 있다고 명시한다
(`event-store.ts:246-256`). ㉰는 그 구조적 어긋남이 오늘 만들어내는 **관측 가능한 증상
하나**일 뿐이고, 증상만 희귀하다고 근거의 어긋남을 남겨 두면 다음 증상은 다른 이슈 번호로
다시 온다 — #263 → #270, #277 → #282 → #284가 같은 사슬을 세 번 돈 것이 그 증거다.
비용이 측정되어(§5.3) 두 자릿수 싸다는 것이 이 각하를 지탱한다. 비용이 always-reindex
수준이었다면 결론은 반대였을 것이다.

### 7.4 각하 3 — 리빌드의 `committed`를 보고 재판정을 건너뛴다

각하한다. `contradiction-service.ts:303-304`가 `{ committed: false }`를 받았을 때
무언가 하게 만들자는 안이다(예: 플래그를 남겨 다음 패스가 판정을 건너뛰게 한다). 두 가지로
막힌다. 첫째, **이 자리의 정책은 이미 확정돼 있다** — #284가 "`committed: false`로는
호출 자리에서 아무것도 하지 않는다"를 정본으로 못박았고 회복은 한 층 아래로 내렸다
(`projection-store.ts:323-333`, `consolidate-service.ts:2615-2624`). 다섯 호출 자리 중
하나만 다른 규율을 갖는 것은 그 결정을 되돌리는 것이다. 둘째, 그 플래그는 **판정을
건너뛰게** 만드는데, 건너뛴 경계는 진짜 새 모순을 놓친다 — 희귀한 중복을 확실한 누락과
바꾸는 것이고, 이것이야말로 §6의 세 인용이 금지하는 거래의 모양이다.

## 8. 산정 중 발견한 주석↔실물 어긋남 (고치지 않음)

#289는 코드 0줄이 우선 조건이므로 **고치지 않고 적어만 둔다.** 넷 다 크로스파일 줄 번호
드리프트이고, #274 / [PR #276](https://github.com/shakystar/mori/pull/276)이 같은 유형을
한 번 정리한 적이 있다. 원인은 #282(`c2ab1ed`)와 #284가 `consolidate-service.ts`의
같은 구간에 주석 블록을 넣어 뒤쪽이 ~40줄 밀린 것이다.

| 인용한 곳                 | 인용                                             | 실물 (`dbfc7ab`) |
| ------------------------- | ------------------------------------------------ | ---------------- |
| `projection-store.ts:146` | `consolidate-service.ts:2591-2592` (리빌드 호출) | `2630-2631`      |
| `projection-store.ts:147` | `(:2654)` (`commitBoundaryCursors` 호출)         | `2693`           |
| `project-lock.ts:115`     | `consolidate-service.ts:2591` (리빌드 게이트)    | `2630`           |
| `project-lock.ts:146`     | `consolidate-service.ts:2654-2660` (커서 커밋)   | `2693-2700`      |

같은 종류로, **#289 이슈 본문의 인용 1건도 실물과 다르다**: _"`conflict-service.ts`의
'buying a rare race with a certain duplicate'"_ 는 실제로는
`contradiction-service.ts:277-278`에 있다 (`conflict-service.ts`에는 그 문장이 없다).
§6의 표는 실물 위치로 인용했다.

내용상 어긋난 주석은 하나도 발견하지 못했다 — `consolidate-service.ts:2603-2606`의
"unconditionally"도 §1.1에서 본 대로 참이고, 빠진 것은 "커밋하는"이라는 한정어 하나다.
