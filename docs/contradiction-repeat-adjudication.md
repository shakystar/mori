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

- 기준 커밋: `db6ff67` (PR #293 머지 직후, `main`). 인용한 줄 번호는 이 시점의 것이다.
  첫 판은 `dbfc7ab` 기준이었고, 그 사이의 유일한 커밋 `db6ff67`은
  `docs/compaction-consolidation-boundary.md` 한 파일만 바꿨으므로 이 문서가 인용하는
  `packages/kernel/**`는 두 커밋에서 바이트 동일하다.
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

`consolidate-service.ts:2623-2626`의 _"any later rebuild replays the full log
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
하나로 접힌다.** 다만 `invalidAt = event.createdAt`(`projector.ts:572`)이라 **두 번째(나중)
이벤트의 시각이 이긴다** — 유효 창이 첫 supersede가 아니라 재판정 시점에 닫힌 것으로
기록된다.

**손해가 굳는 자리를 정확히 짚는다 — 시점 재생이 아니다.**
`getProjectStateAtRevision`은 `readEventsUpTo`가 돌려준 **접두**를 그대로 접는다
(`projection-store.ts:779-784`), 그리고 그 접두는 `seq <= watermark`의 포함 상한이다
(`event-store.ts:452-465`). 그러므로 "두 append 사이 구간"을 시점 재생으로 물으면 그 접두에
**첫 supersede가 이미 들어 있고**, 답은 그때도 "invalid"다. 중복 이벤트는 그 답을 바꾸지
못한다 — 시점 재생은 이 손해가 **드러나지 않는** 경로다.

손해가 실제로 굳는 자리는 **전량 replay로 세운 최종 프로젝션의 `invalidAt` 값**이다.
리빌드는 로그 전체를 `seq` 순으로 접고(`event-store.ts:377` → `projection-store.ts:378-379`)
나중 이벤트가 이기므로, `memories.invalid_at` 열에 첫 supersede 시각이 아니라 **재판정
시각**이 쓰인다 (`projection-store.ts:656-673`의 `invalidAt: memory.invalidAt ?? null`).

**그 값을 오늘 읽는 소비자는 0건이다** (§2.3과 같은 방식으로 전수 확인).

| `invalidAt`을 만지는 프로덕션 자리                          | 무엇으로 쓰나                                                   | 값이 보이나                               |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `listValidMemories` (`projection-store.ts:1024`)            | `invalid_at IS NULL` — **불리언 술어**                          | 안 보임                                   |
| `readValidMemoriesFromLog` (`memory-import-service.ts:246`) | `!memory.invalidAt` — **불리언 술어**                           | 안 보임                                   |
| `dedupeMemoriesBySource` (`projector.ts:237`)               | `if (memory.invalidAt) continue` — **불리언 술어**              | 안 보임                                   |
| 임베딩 스코프 (`embeddings-store.ts:161`)                   | `invalid_at IS NULL` — **불리언 술어**                          | 안 보임                                   |
| `projector.ts:599` (`memory.retracted`)                     | `existing.invalidAt ?? event.createdAt` — **보존용 읽기**       | 값을 읽지만 다시 `invalidAt`으로만 흘러감 |
| `getMemory` (`projection-store.ts:994-1006`)                | 무효 메모리도 레코드째 돌려준다 — **값이 드러나는 유일한 독자** | **호출부 0건**, `index.ts` export 0건     |
| `getProjectStateAtRevision` (`projection-store.ts:779`)     | 접두 재생 (위) — 애초에 드러나지 않음                           | **호출부 0건**                            |

`reason`은 프로젝션에 실리지 않으므로(`projector.ts:570-574`가 읽지 않는다) 로그에만
남는다 — judge의 자유 서술이 매번 달라도 프로젝션은 동일하다.

### 2.2 중복 `conflict.detected` — 두 행이 남는다

`projector.ts:467-469`는 `conflict.detected`/`conflict.resolved`를 `event.scopeId`로
키잉한다. `detectContradictions`는 `scopeId`에 **conflict 자신의 id**를 싣고
(`contradiction-service.ts:256-262`, 그렇게 하는 이유는 `conflict-service.ts:91-96`),
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
- (b) **최종 프로젝션의 `invalidAt`이 첫 supersede가 아니라 재판정 시점으로 밀림** (§2.1) —
  시점 재생에서는 드러나지 않고, 그 값을 읽는 프로덕션 소비자도 **오늘 0건**이다(§2.1의 표).
  즉 (b)는 (a)와 같은 부류다: 첫 소비자가 배선되는 날 표면화된다.
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

즉 "중복 append가 유니크 제약에 걸린다"는 이 리포에서 검증된 수단이다. 다만 ㉰에
쓰려면 **호출자가 이벤트 id를 지정하는 새 이음매**가 필요하다 (`AppendEventInput.id`).

**그 이음매를 넣으면 (가)는 ㉰를 실제로 완전히 닫는다.** 두 이벤트는 **한 번의
`appendEvents` 호출**에 배열로 들어가고 (`contradiction-service.ts:245-270` —
`memory.superseded`가 `[0]`, `conflict.detected`가 `[1]`), `appendEvents`는 그 배열
전체를 `db.transaction` **하나**로 돌린다 (`event-store.ts:303-313`). 그러므로 두 번째
insert가 `SQLITE_CONSTRAINT_UNIQUE`로 던지면 **첫 번째 insert도 함께 롤백된다** — 중복
`conflict.detected`도, 중복 `memory.superseded`도 남지 않는다. 이 성질은 부작용이 아니라
**의도된 설계**이고 소스 주석이 그렇게 적어 놨다 (`contradiction-service.ts:232-235`):

> _"One confirmed contradiction is logically a single operation — both events go through
> appendEvents (one db.transaction) **so a failure on the second insert can never leave the
> loser durably superseded without the conflict that explains why** (#118 item 3)."_

`appendEvents`의 JSDoc도 같은 말을 한다 — _"The refusal rolls back exactly like any other
throw in the block, so there is no partial append to clean up"_ (`event-store.ts:272-273`).

따라서 (가)의 각하는 **효과가 부족해서가 아니라 대가 때문**이다. 이음매를 넣을 때 남는
대가는 셋이고, 셋 다 실물에서 확인된다:

1. **이벤트 정체성 변경.** `AppendEventInput`에 id 필드를 여는 것은 "이벤트 id는 append
   경로가 민팅한다"는 오늘의 불변을 깬다 (`event-store.ts:13-28`, `:286`). #282가 값을
   낸 자리가 정확히 "가장 자연스러워 보이는 후보가 결함을 가드 밖으로 옮기는 거래"였고,
   이벤트 정체성은 그 종류의 오판 비용이 가장 비싼 축이다.
2. **예외 판별·삼킴 경로 추가.** 중복이 예외로 `detectContradictions`의 꼬리에서
   올라오는데, 그 꼬리는 던지면 안 되는 자리다 (`contradiction-service.ts:271-283`:
   두 호출자 모두 커서 커밋 전에 이것을 돌리므로, 여기서 던지면 창이 미소비로 남아
   _"buying a rare race with a certain duplicate"_ — `:277-278`). 그러므로
   `isDuplicateGenesisError`(`event-store.ts:100-106`) 모양의 판별자와 삼킴 경로를 하나
   더 만들어야 하고, **그 판별자는 "우리가 기대한 중복"과 "다른 UNIQUE 위반"을 구별해야
   한다** — 후자를 같이 삼키면 진짜 append 실패가 조용히 사라진다.
3. **judge LLM 왕복은 어차피 이미 지불됐다.** 거부는 append 시점에 일어나므로 §2.4의
   손해 (c)(낭비된 판정 왕복)는 (가)로 **줄어들지 않는다.** ㉰가 만드는 손해 중 오늘
   유일하게 값이 붙는 것이 바로 그것이므로(§2.3: 표면 소비자 0건), (가)는 **오늘 실제로
   드는 비용을 하나도 없애지 못한 채** 위 1·2를 지불한다.

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

> **정당한 재판정이 존재하는가: 예.** 한 쌍이 **append 없이** 판정 패스를 빠져나가는
> 분기가 여럿 있고, 그 분기로 빠진 쌍은 둘 다 valid로 남아 **다음 경계·import 패스에서
> 정당하게 다시 판정된다.** 소스 주석 자신이 이 함수를 _"a repeated best-effort sweep —
> the next boundary or import runs it again over current data"_ 라고 규정한다
> (`contradiction-service.ts:281-283`).
>
> **다만 결정적 conflict id는 그 재판정을 막지 못한다: 아니오.** 아래 분기들은 전부
> **append가 0건**이라 그 쌍의 conflict id가 애초에 민팅·기록되지 않는다. 나중의 양성
> 판정은 그 쌍의 **첫 번째** append이고, 충돌할 상대가 없다. 결정적 id가 거부하는 것은
> *이미 양성으로 판정돼 append까지 끝난 쌍*의 두 번째 append뿐이며, 그것이 정확히 ㉰다.

### 4.1 append 없이 쌍이 valid로 남는 분기 — 루프 전수

`detectContradictions`의 판정 루프에서 제어가 빠져나가는 자리는 열 곳이고, 그중
**쌍을 둘 다 valid로 남기는** 것은 일곱이다.

| 자리                                              | 조건                        | 쌍이 valid로 남나                       |
| ------------------------------------------------- | --------------------------- | --------------------------------------- |
| `:161` `if (!embedder) return []`                 | embedder 미배선             | **예** — 패스 전체가 무판정             |
| `:176` `if (decisions.length < 2) return []`      | decision < 2                | **예** — 세 번째 decision이 생기면 판정 |
| `:200` `alreadyResolved.has(a.id)` → `continue`   | `a`가 이 패스에서 이미 패배 | 아니오 — `a`는 무효화됐다               |
| `:202` `if (!vecA) continue`                      | `a`의 벡터 없음             | **예** — 벡터가 채워지면 판정           |
| `:206` `alreadyResolved.has(b.id)` → `continue`   | `b`가 이 패스에서 이미 패배 | 아니오 — `b`는 무효화됐다               |
| `:208` `if (!vecB) continue`                      | `b`의 벡터 없음             | **예**                                  |
| `:209` `cosineSimilarity(vecA, vecB) < threshold` | 프리필터 탈락               | **예**                                  |
| `:215` `if (!verdict.contradicts) continue`       | judge 음성                  | **예** — 이번 반송의 핵심               |
| `:286` `break` (staleBasis)                       | CAS 거부로 패스 포기        | **예** — 남은 쌍 전부 무판정            |
| `:299` `if (loser.id === a.id) break`             | `a`가 졌다                  | 아니오 — `a`는 무효화됐다               |

`:200`·`:206`·`:299` 셋만 "이미 판정이 내려진 뒤"의 패스 내 단축이고, 나머지 일곱은
**판정이 아예 없었던** 자리다.

### 4.2 그중 `:215`(judge 음성)가 가장 실재한다

`verdict.contradicts`가 거짓이면 `continue`이고 append가 없다 (`:215`). 그 경로는
`alreadyResolved`에 아무것도 넣지 않는다 — `alreadyResolved.add(loser.id)`는 `:293`,
즉 양성 판정 뒤에만 실행된다. 두 메모리는 둘 다 valid로 남아 다음 패스의
`listValidMemories` basis(`:173`)에 그대로 다시 오르고, 프리필터를 다시 통과하고,
**judge에 다시 간다.**

그리고 judge의 음성은 "그 쌍은 모순이 아니다"라는 안정된 사실이 아니다.
`makeLlmJudge`(`contradiction-service.ts:95-105`)를 보면 음성이 나오는 자리가 셋이다:

- `if (!llm) return { contradicts: false }` (`:97`) — **LLM 미배선 스토어는 모든 쌍이 음성**이다.
  `consolidate-service.ts:2670`이 `makeLlmJudge(params.llm)`로 부르고 `params.llm`은 선택적이다.
- `catch { return { contradicts: false } }` (`:101-103`) — **LLM 일시 장애도 음성**이다.
- 실제 LLM 응답 (`:99-100`) — 비결정적이다.

즉 LLM이 배선되거나 장애에서 복구되면, 전에 음성이던 같은 쌍이 **정당하게 양성**이 된다.
이것은 가설이 아니라 오늘의 배선에서 바로 도달하는 경로다.

프리필터(`:209`) 쪽도 패스 간에 고정이 아니다. 임계값은 호출자 파라미터이고
(`cosineThreshold?: number` — `:122`, `:187`), 벡터는 `embedder.model`로 필터되며
(`:184-186`), 모델이 바뀌면 `ensureEmbeddings`가 `current.model !== embedder.model`로
전량을 다시 임베딩한다 (`embeddings-service.ts:101-106`). 같은 쌍의 코사인이 패스마다
다를 수 있다.

### 4.3 양성으로 판정된 쌍에 한해서는 재판정이 없다

Q4가 (가)의 반대 위험으로 물은 것은 이쪽이다 — **결정적 id가 거부하게 될 그 쌍**이 다시
판정되어야 하는가. 확인한 범위에서는 아니다. 근거 셋:

1. **메모리 텍스트는 불변이다.** `DomainEventType`에 메모리 본문을 바꾸는 이벤트가 없다 —
   `memory.consolidated` / `memory.superseded` / `memory.retracted` / `memory.injected`가
   전부다 (`domain/events.ts:64-76`). "텍스트가 바뀌어서 다시 판정" 경로는 없다.
2. **패배자는 되살아나지 못한다 — 다만 그 보장은 projector가 아니라 id 민팅에 얹혀 있다.**
   `invalidAt`을 **지우는** case는 없다: `memory.superseded`(`projector.ts:570-574`)와
   `memory.retracted`(`projector.ts:595-602`) 둘 다 설정만 하고, 후자는
   `existing.invalidAt ?? event.createdAt`으로 오히려 **보존**한다. 그러나 지우는 case가
   없다는 것만으로는 부족하다 — `memory.consolidated` case는 레코드를 **통째로 덮어쓰므로**
   (`projector.ts:551-559`의 `state.memories[memory.id] = memory`) 같은 memory id를 실은
   그 이벤트가 supersede 뒤에 한 번 더 오면 `invalidAt`이 **사라진다.** 오늘 그 경로가
   닫혀 있는 이유는 projector가 아니라 **두 appender가 전부 새 id를 민팅**하기 때문이다
   (경계는 `consolidate-service.ts:2325`의 `createConsolidatedMemory` → `:2339-2345`의 append,
   import는 `memory-import-service.ts:753`의 같은 팩토리 → `:743-750`의 append). 남의 이벤트를 받아들이는
   경로가 생기는 날 이 근거는 다시 대조해야 한다 (아래 회색지대).
3. **승자는 결정적이다.** `pickWinner`는 `(createdAt, id)` 규칙이라
   (`contradiction-service.ts:125-133`) 같은 쌍을 다시 판정해도 승패가 뒤집히지 않는다 —
   "다시 판정해서 다른 답이 나와야 하는" 경우가 없다.

따라서 (가)의 반대 위험은 성립하지 않는다: **결정적 conflict id는 §4.1의 일곱 분기가
만드는 정당한 재판정을 하나도 막지 않고**(그 분기들은 append를 남기지 않으므로 충돌할 id가
없다), 그것이 거부하는 유일한 append는 이미 양성으로 확정된 쌍의 두 번째 것이다. id에
버전이나 경계 id를 더 섞을 필요도 없다 — 섞어야 하는 경우는 "같은 쌍이 같은 양성 판정을
두 번 정당하게 남겨야 하는 경우"인데, 위 근거 셋이 그 경우를 배제한다.
**(가)의 각하는 위험 때문이 아니라 대가 때문이다** (§7.2).

### 4.4 회색지대 둘

- **복제본 사본**: `dedupeMemoriesBySource`(`projector.ts:234-265`)가 같은 lane의
  동일 내용 메모리를 접는데, 그 dedup 패배자는 `invalidAt`이 붙는다(`:258-262`) —
  즉 여기서도 되살아남은 없다. dedup이 **살려둔** 쪽이 나중에 다른 쌍을 이루는 경우는
  id가 다른 **새 쌍**이라 결정적 id에 막히지 않는다. `sourceObservationIds`가 빈
  메모리는 dedup 자체에서 제외된다 (`projector.ts:238-239`).
- **동기화 수신**: 오늘 이 리포에는 남의 이벤트를 로그로 받아들이는 경로가 없다 —
  `memory.retracted`를 append하는 프로덕션 코드는 0건이고 테스트뿐이며,
  `readEvents`를 쓰는 비-스토어 코드도 두 곳뿐이다(`projection-store.ts:378`,
  `memory-import-service.ts:237`). 수신 경로가 생기면 §4.3 근거 **1·2·3을 전부** 다시
  대조해야 한다. 특히 근거 2가 그렇다 — 그 보장은 projector가 아니라 "두 appender가 전부
  새 id를 민팅한다"에 얹혀 있고, 남이 보낸 `memory.consolidated`가 이미 무효화된 memory
  id를 실어 오면 `projector.ts:551-559`의 통째 덮어쓰기가 `invalidAt`을 지운다. 즉
  **수신 경로는 근거 2를 깨는 가장 짧은 길이다.**

부수적으로: 결정적 conflict id는 **복제본 간 수렴**에는 이득이다 — 두 복제본이 같은 쌍을
독립적으로 판정하면 오늘은 서로 다른 id 두 개가 union 뒤 둘 다 살아남고, 결정적 id면
하나로 접힌다. `dedupeMemoriesBySource`가 메모리에 대해 하는 일(P3-a)과 같은 모양이다.
이 이득은 실재하지만 ㉰와는 다른 축이므로 §7의 판정 근거로 쓰지 않는다.

## 5. Q5 — 후보② 로그 replay 근거와 실측

### 5.1 ㉰를 닫는가: 예, 근본에서 닫는다

basis를 `listValidMemories`(프로젝션) 대신 **로그 replay**로 잡으면, 첫 패스가 append한
`memory.superseded`가 이미 로그에 있으므로 두 번째 패스의 basis에서 패배자는 `invalidAt`을
갖는다 → **그 쌍의** 재판정 자체가 일어나지 않는다. **㉰의 유효성 판정에는 어떤 리빌드도
커밋될 필요가 없어지고**, §1.3의 도달 조건 넷이 전부 무의미해진다. (여기서 사라지는 것은
**양성으로 판정돼 패배자가 무효화된 쌍**의 재판정뿐이다. 음성으로 판정된 쌍은 오늘도
후보② 뒤에도 매 패스 다시 판정되고, 그것은 결함이 아니라 설계다 — §4.2.)

구현 모양은 새로 발명할 것이 없다 — `memory-import-service.ts:234-254`의
`readValidMemoriesFromLog`가 **같은 이유로 이미 존재한다**: 프로젝션 캐시가 아니라
이벤트 로그가 멱등성의 정본이라는 것(`memory-import-service.ts:52-57`).
`kind === "decision"` 필터만 얹으면 된다.

**한정 — 이 패스가 프로젝션에서 완전히 독립하지는 않는다.** 반례를 찾다가 하나 나왔고,
권고를 바꾸지는 않지만 후속 이슈가 알아야 한다. `detectContradictions`의 코사인 프리필터는
`listEmbeddings(projectId, "memory", embedder.model)`로 벡터를 읽고, 벡터가 없는 메모리는
**조용히 건너뛴다** (`contradiction-service.ts:184-186`, `:201-202`·`:207-208`의
`if (!vecA) continue` / `if (!vecB) continue`). 그런데 그 벡터를 채우는 `ensureEmbeddings`는
**여전히 `listValidMemories`(프로젝션)를 읽는다** (`embeddings-service.ts:95`). 그러므로
리빌드가 커밋되지 않으면 새 메모리는 벡터가 없고, 후보②의 replay basis에 들어와도
프리필터에서 탈락한다.

이것이 결론을 흔들지 않는 이유는 방향이 반대이기 때문이다: 그것은 **누락**(비교되지 않음)
이지 ㉰가 문제 삼는 **중복**이 아니고, 오늘도 똑같이 일어나며(그래서 `consolidate-service.ts:2661-2663` 주석이
`detectContradictions`를 `ensureEmbeddings` **뒤에** 두라고 적어 놨다) 후보②가 악화시키지
않는다. 다만 _"후보②는 판정을 로그 위에 온전히 올린다"_ 는 **과장이므로 쓰지 않는다** —
후보②가 로그 위로 올리는 것은 **유효성 집합**이고, **커버리지(어느 쌍이 비교되는가)는
그대로 프로젝션 경유**다. `embeddings`는 리빌드의 replace-all 대상이 아니므로
(`SINGLETON_TABLES` + `ENTITY_TABLES`에 없다 — `projection-store.ts:99-112`) 리빌드가
기존 벡터를 지우지는 않는다.

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
`memory-import-service.ts:248-252`), `attemptProjectionRebuild`(#270,
`projection-store.ts:376-379`), 그리고 #262의 dedup 스냅샷. 후보②는 `detectContradictions`에
같은 규율을 적용한다.

**닫는 자리와 남는 자리를 정확히 적는다 — 후보②는 이 부류의 마지막 자리가 아니다.**

| basis/head가 갈리는 자리            | 실물                                                                                                                           | 후보②가 닫나             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `detectContradictions`              | head는 `readHeadEventId`(`contradiction-service.ts:171`), basis는 `listValidMemories`(`:173`)                                  | **닫는다**               |
| `consolidateBoundary`의 재증류 판정 | head는 `readHeadEventId`(`consolidate-service.ts:2141`), 근거는 `consumedObservationIds`(`:2167`)·`listValidMemories`(`:2214`) | **닫지 않는다 — 남는다** |

두 번째 행은 추측이 아니라 그 자리의 주석이 **스스로 적어 놓은 갈림**이다
(`consolidate-service.ts:2451-2459`):

> _"a takeover whose append already landed BEFORE this boundary read `expectedHead` above,
> but whose rebuild/cursor-commit is still pending, leaves `expectedHead` correctly
> reflecting 'no further log movement' while one or both of this boundary's evidence
> sources are still the pre-takeover ones — CAS passes and this boundary redistills
> observations the other holder just consolidated. **#263 tracks closing that gap**"_

즉 후보②가 사는 것은 _"마지막 자리를 없앤다"_ 가 아니라 **_"같은 부류의 한 자리를,
리포가 이미 세 번 쓴 그 방법으로 닫는다"_** 이다. `consolidateBoundary`의 갈림은 #263이
따로 추적하고 있고 이 산정의 후속 이슈 범위에도 들어가지 않는다 (§7.1).

### 5.3 실측 (총 로그 길이 기준)

**측정 축을 고쳤다.** 이 문서의 첫 판은 `n`을 `decision` 메모리 개수로 잡고 로그 길이를
`n + 1`로 두었는데, 그것은 **틀린 축**이다. 후보②는 `readEvents` +
`reduceProjectState`이고 `readEvents`에는 타입 필터가 없다 —
`SELECT * FROM events ORDER BY seq` 전량이다 (`event-store.ts:377`, `readEvents`는
`readEventsWithIntegrity`를 그대로 돌려준다 `:381-384`). 구현 모양으로 제시한
`readValidMemoriesFromLog`도 마찬가지로 전량 replay다
(`memory-import-service.ts:237-238`). 실제 스토어에서 `decision`은 로그의 소수이고
`observation.captured`가 압도적 다수이므로, decision 축의 수치는 비용을 **과소평가한다.**
아래는 `n`을 **총 로그 이벤트 수**로 다시 잡은 재측정이며, 첫 판의 표를 **폐기하고 대체**한다.

측정 방법:

- 스크립트: 임시 파일(커밋하지 않음). 전문과 원출력은 PR 본문에 첨부.
- 셀마다 **23회** 실행, **앞 3회를 워밍업으로 폐기**, 남은 **20회**에서 최소값과 중앙값을
  둘 다 싣는다.
- 샘플마다 `global.gc()`를 **타이머 밖에서** 먼저 돌린다 (`node --expose-gc`). replay는
  이벤트당 객체 하나를 할당하므로, 강제하지 않으면 한 샘플이 앞 샘플의 쓰레기를 물려받아
  측정이 GC 일시정지 측정으로 변질된다 — 강제 전에는 같은 5000건 `readEvents`가 연속
  반복에서 20 ms와 796 ms로 찍혔다. 각 샘플은 **자기 자신의 할당 비용은 그대로 낸다.**
- **최소값을 싣는 이유**: 이 상자는 2 vCPU 컨테이너이고 측정 중 load average가 1.0–1.4다.
  선점 노이즈는 시간을 **더하기만** 하므로 최소값이 실제 비용에 가장 가깝고, 중앙값은
  노이즈가 섞인 상한이다. 둘 다 싣고 결론은 **둘 다에서 성립하는 것만** 쓴다.
- 이벤트 믹스 = 25건 반복 단위 (실제 스토어 모양을 본뜬 것):
  **observation.captured 18 / memory.consolidated 4(progress·rationale) /
  memory.consolidated 1(decision) / memory.injected 1 / session.started 1.**
  → **decision은 로그의 4%**, 메모리 행 전체가 20%. genesis(`project.created`)가 모든
  로그의 1번 이벤트다. 메모리 텍스트는 전부 다르게 만들어
  `dedupeMemoriesBySource`(`projector.ts:234-265`)가 접지 않게 했다.
- 스토어는 셀마다 새로 만들고 `reindexSearch: true` 리빌드를 1회 돌린 뒤 측정 — SQLite
  페이지 캐시가 **워밍된 상태**의 수치다 (콜드 스타트가 아니다).
- 환경: Node v22.23.2, better-sqlite3, 2 vCPU 리눅스 컨테이너. **절대값이 아니라 열 사이의
  비가 판정 재료다** (§5.4).

|    n (총 이벤트) | 메모리 행 | decision | `listValidMemories`+필터 (오늘) | `readHeadEventId` (오늘) | replay basis (후보②) min/중앙 | 참고: `rebuild(reindexSearch:true)` min/중앙 |
| ---------------: | --------: | -------: | ------------------------------: | -----------------------: | ----------------------------: | -------------------------------------------: |
| 1 (genesis only) |         0 |        0 |                  0.12 / 0.14 ms |           0.11 / 0.12 ms |                0.24 / 0.27 ms |                               1.09 / 1.22 ms |
|               50 |        10 |        2 |                  0.19 / 0.23 ms |           0.12 / 0.14 ms |                0.57 / 0.74 ms |                               1.80 / 2.57 ms |
|              200 |        40 |        8 |                  0.25 / 0.33 ms |           0.12 / 0.14 ms |                1.36 / 1.62 ms |                              4.24 / 78.77 ms |
|             1000 |       200 |       40 |                  0.54 / 0.74 ms |           0.12 / 0.14 ms |               5.81 / 79.32 ms |                            16.35 / 165.05 ms |
|             5000 |      1000 |      200 |                  2.14 / 3.95 ms |           0.12 / 0.14 ms |             85.38 / 563.63 ms |                          561.92 / 1362.67 ms |
|            20000 |      4000 |      800 |                8.64 / 121.05 ms |           0.13 / 0.17 ms |          1664.10 / 2401.36 ms |                         2338.97 / 2486.31 ms |

`replay basis` 열은 `readEvents` + `reduceProjectState` + valid/self/decision 필터 +
head 추출을 한 덩어리로 잰 것이다 — 후보②가 하는 일 전부이며, 오늘의 두 조회(basis +
head)를 **대체**한다. 20000 셀은 이슈가 준 격자에 없지만, 로그가 append-only라 스토어
수명과 함께 단조 증가한다는 점 때문에 추세를 보려고 하나 더 뒀다.

한계비용 = `replay` − (`projection` + `head`), 그리고 **replay ÷ rebuild 비**:

|     n | 한계비용 min | 한계비용 중앙 | replay/rebuild 비 min | replay/rebuild 비 중앙 |
| ----: | -----------: | ------------: | --------------------: | ---------------------: |
|     1 |     +0.00 ms |      +0.01 ms |                  0.22 |                   0.22 |
|    50 |     +0.26 ms |      +0.38 ms |                  0.32 |                   0.29 |
|   200 |     +0.99 ms |      +1.15 ms |                  0.32 |                   0.02 |
|  1000 |     +5.15 ms |     +78.44 ms |                  0.36 |                   0.48 |
|  5000 |    +83.12 ms |    +559.54 ms |                  0.15 |                   0.41 |
| 20000 |  +1655.32 ms |   +2280.15 ms |                  0.71 |                   0.97 |

첫 판이 낸 수치(n=1000 → +2.1 ms, n=5000 → +28 ms)는 **버린다.** 같은 격자를 총 로그
길이로 다시 잡으면 한계비용은 그보다 한두 자릿수 크고, 20000건에서는 **초 단위**다.

### 5.4 비용 해석 — 결론을 측정에 맞춘다

첫 판은 _"후보②의 한계비용은 rebuild보다 두 자릿수 싸다"_ 로 권고를 떠받쳤다. **재측정은
그 문장을 지지하지 않는다.** 위 표에서 한계비용은 rebuild와 **같은 자릿수**이고, 20000건
셀에서는 rebuild의 0.7–1.0배까지 올라간다. 권고를 다시 세우려면 다른 근거가 필요하고,
그 근거는 실물에 있다.

**결정적 사실: 두 호출자 모두 `detectContradictions`를 부르기 직전에 전량 리빌드를 이미
한 번 끝낸다.**

- 경계: `if (inputs.length > 0 || segmentsWritten > 0)` 게이트 안에서
  `rebuildProjectProjection(..., { reindexSearch: true })`
  (`consolidate-service.ts:2650-2651`) → 그 다음 `if (inputs.length > 0)` 안에서
  `detectContradictions` (`:2646-2653`). 뒤 게이트가 성립하면 앞 게이트는 **반드시**
  성립하므로, 이것은 확률이 아니라 **보장**이다.
- import: `rebuildProjectProjection(..., { reindexSearch: true })`
  (`memory-import-service.ts:839`) → 바로 다음 줄 `detectContradictions` (`:817`).

그리고 **리빌드는 replay + 쓰기**다 — 같은 `readEvents` 전량 replay를 안에 품고 있다
(§1.1, `projection-store.ts:378-379`의 `readEvents` + `:447-449`의 replace-all). 그래서 후보②의 한계비용은 위 표의
`replay/rebuild 비`가 말하는 그대로 **직전에 이미 지불한 리빌드의 0.15–0.97배**이고,
이 비는 로그 길이가 20배 늘어도 1을 넘지 않는다. 즉 후보②는 새로운 비용 곡선을
들여오지 않는다 — **이미 이 경로가 타고 있는 곡선 위에서 상수배 1 미만을 더한다.**

나머지 해석 셋:

- **호출자는 둘이고, 오늘 프로덕션 도달은 경계 하나뿐이다.**
  `detectContradictions`는 경계(`consolidate-service.ts:2666-2673`)와
  import(`memory-import-service.ts:841`) 두 곳에서 호출되며, 주석 자신이 _"this function
  is tail work for **both its callers** (a consolidation boundary and an import)"_ 라고
  적는다 (`contradiction-service.ts:273-274`). import 경로는 오늘 `packages/kernel/src/index.ts`에서
  export되지 않아 프로덕션 호출부가 0건이므로(#189 "확인된 사실") **오늘 비용을 내는 것은
  경계뿐이지만, 배선되는 날 이 경로가 후보②의 비용을 그대로 상속한다.**
- **embedder가 꺼진 스토어의 비용은 0이다.** `detectContradictions`는 첫 줄이
  `if (!embedder) return []`이므로(`contradiction-service.ts:161`) replay를 그 가드
  **뒤에** 두면 임베딩이 없는 스토어는 한 건도 replay하지 않는다. 이것은 후속 구현의
  수용 기준이다 (§7.1).
- **비교 기준 (#282가 비용으로 각하한 always-reindex).** 그것이 비쌌던 이유는 절대값이
  아니라 **자리**였다 — capture마다(#277 실측 n=1000 → ~319 ms) 내는 핫패스 비용이었다.
  후보②는 capture가 아니라 이미 리빌드·embedder 왕복·pair마다 judge LLM 왕복을 내고 있는
  **경계 꼬리**에서만 낸다 (`project-lock.ts:120-128`이 이 꼬리 구성을 적어 놨다).
  20000건 셀의 +1.7 s조차 같은 경계가 방금 낸 리빌드 2.3 s보다 작다.

**그럼에도 재측정이 드러낸 것을 축소하지 않는다**: 20000건 스토어에서 이 경로는 이미
경계당 초 단위이고, 로그는 append-only라 되돌아가지 않는다(#289 비범위의
invalidate-not-delete 규율). 그 곡선은 후보②가 만든 것이 아니라 **투영 설계 전체가 이미
타고 있는 것**이며(리빌드가 capture마다 전량 replay한다 — `capture-service.ts:314`),
스냅샷/증분 replay로 그 곡선을 꺾는 일은 이 산정과 다른 축의 별건이다. 후보②를 채택하든
안 하든 그 축은 그대로 남는다.

## 6. Q6 — 리포가 이미 내린 판정과의 대조

후보를 코드가 아니라 **이 리포가 이미 각하한 거래**에 붙여 본다.

| 리포의 판정                                              | 인용                                                                                                                                                                | (가) 결정적 id                                                           | ② replay basis                                                                                                              | 아무것도 안 함                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 희귀한 레이스를 **확실한 재증류**와 바꾸지 않는다 (#211) | `consolidate-service.ts:1425-1426` — _"stopping without moving the cursor turns a rare race into a CERTAIN re-distillation"_                                        | 해당 없음 (커서를 건드리지 않음)                                         | 해당 없음                                                                                                                   | 해당 없음                                 |
| 희귀한 레이스를 **확실한 중복**과 바꾸지 않는다          | `contradiction-service.ts:277-278` — _"buying a rare race with a certain duplicate"_                                                                                | 해당 없음                                                                | 해당 없음 — 사는 것은 확정적 _지연_ (§5.3 재측정 한계비용 중앙값: n=1에서 +0.01 ms, n=20000에서 +2280 ms)이지 중복이 아니다 | 해당 없음                                 |
| 같은 규율, 세 번째 사례 (#211 꼬리)                      | `project-lock.ts:136-137` — _"a rare race traded for a certain duplicate"_                                                                                          | 해당 없음                                                                | 해당 없음                                                                                                                   | 해당 없음                                 |
| 비용이 **측정되지 않은** 전역 강화는 각하 (#282 → #284)  | `projection-store.ts:337-341` — always-reindex를 각하하며 #277 실측(n=1000 → ~319 ms)을 인용                                                                        | 비용 무시할 만함                                                         | §5.3에서 실측 (n=1000 → +5.15 ms min / +78.44 ms 중앙)                                                                      | 비용 0                                    |
| 호출자를 바꾸지 않는 회복을 선호 (#284)                  | `projection-store.ts:323-333` — _"The recovery is HERE, not at the five call sites"_                                                                                | `createConflict` 1곳                                                     | `detectContradictions` 내부 1곳, 호출자 0곳                                                                                 | 0곳                                       |
| **프로덕션 호출자가 없는 경로는 굳이 가드하지 않는다**   | `conflict-service.ts:41-54` — _"It is unguarded only because this function has no production caller yet … Whoever wires the first real caller must take that lock"_ | ㉰의 표면(conflicts 소비자)은 오늘 0건 → 이 선례는 (가)를 **약화**시킨다 | basis는 표면이 아니라 **이미 프로덕션에서 도는 판정 근거**라 이 선례가 적용되지 않는다                                      | 이 선례는 "아무것도 안 함"을 **지지**한다 |

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
   전부 사라진다. 중복 `conflict.detected`와 중복 `memory.superseded`를 **둘 다** 없애면서,
   ㉰가 오늘 실제로 물리는 유일한 값인 **낭비된 judge LLM 왕복**(§2.4 손해 (c))도 없앤다 —
   **양성으로 판정된 그 쌍에 한해** 재판정 자체가 일어나지 않으므로 judge를 다시 부르지
   않는다. (음성으로 판정된 쌍은 오늘도, 후보② 뒤에도 매 패스 judge에 다시 간다 — §4.2.
   후보②가 옮기는 것은 basis이지 프리필터·judge 경로가 아니다.) (가)는 이음매까지 넣어야
   중복을 없애고, 그렇게 해도 그 왕복은 이미 지불된 뒤에 append에서 거부되므로 못 없앤다
   (§3.2).
2. ㉰의 희귀함만으로는 값이 안 나온다는 것을 인정한 위에서 — 이 변경이 실제로 사는 것은
   `detectContradictions`의 **basis/head 갈림 하나**를, 리포가 이미 세 곳에서 쓴 그
   방법(basis와 head를 한 `readEvents` 배열에서 뽑기, #253/#270/#262)으로 닫는 것이다
   (`event-store.ts:246-256`이 남긴 구멍, #263). **이것은 그 부류의 마지막 자리가 아니다** —
   `consolidateBoundary`의 같은 부류 갈림(`consolidate-service.ts:2451-2459`, #263이 추적)은
   **남는다**. §5.2의 표가 닫는 자리와 남는 자리를 각각 명시한다.
3. 비용이 재측정됐고(§5.3, 총 로그 길이 축), **직전에 이미 지불한 리빌드의 0.15–0.97배로
   상한이 잡힌다** — 두 호출자 모두 `detectContradictions` 직전에 전량 리빌드를 끝내기
   때문이고(`consolidate-service.ts:2650-2651` → `:2647`,
   `memory-import-service.ts:839` → `:817`), 그 비는 로그가 20배 길어져도 1을 넘지
   않는다. embedder가 없으면 0. 이벤트 정체성을 건드리지 않으므로 #282가 경고한 오판
   비용을 지지 않는다. **첫 판이 쓴 _"두 자릿수 싸다"_ 는 틀렸고 폐기한다** (§5.4).

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

**후속 이슈가 닫지 않는 것**(범위를 여기서 못박는다):

- `consolidateBoundary`의 basis/head 갈림 (`consolidate-service.ts:2451-2459`) — **#263의
  몫이고 이 후속 이슈의 범위가 아니다.** 후보②는 `detectContradictions`만 옮긴다.
- 전량 replay의 로그 길이 확장성 (§5.4 말미) — 스냅샷/증분 replay는 리빌드와 후보②에
  똑같이 걸리는 별개 축이고, 후보② 채택 여부와 무관하게 남는다.
- import 경로의 배선 (`importMemories`가 export되지 않는다는 #189 확인된 사실) — 배선하는
  사람이 후보②의 비용을 상속한다(§5.4)는 사실만 적어 두고, 배선 자체는 하지 않는다.
- **음성 판정 쌍의 반복 judge 왕복.** `:215`가 append 없이 `continue`하므로 같은 쌍이
  매 패스 judge에 다시 간다(§4.2). 오늘도 그렇고 후보②도 바꾸지 않는다. 이것은 설계
  의도이지(`contradiction-service.ts:281-283`의 _"a repeated best-effort sweep"_) 결함이
  아니므로 이 후속 이슈에서 건드리지 않는다. **후속 이슈가 _"한 번 판정된 쌍은 다시
  판정되지 않는다"_ 를 불변으로 전제해서는 안 된다** — 그 전제는 오늘도 거짓이다.
  성립하는 것은 _"양성으로 판정돼 append까지 끝난 쌍은 다시 판정되지 않는다"_ 뿐이고,
  그것도 §4.3이 확인한 범위(단일 writer, id 민팅) 안에서다.

### 7.2 각하 1 — 후보 (가) 결정적 conflict id

각하한다. **효과가 없어서가 아니라 대가 때문이다** — 이 문단은 그 구별 위에 선다.

**(가)를 이음매 없이 쓰면 ㉰를 거의 못 닫는다.** 이벤트 id는 payload와 무관하게
`appendEvents`가 민팅하고(`event-store.ts:286`), `AppendEventInput`에는 id를 받는 필드가
없으므로(`:13-28`) 결정적 conflict id는 payload에만 실린다. 두 번째 append는 통과하고,
얻는 것은 `conflicts` 테이블 2행 → 1행이라는 프로젝션 접힘 하나뿐이다(§3.5). 그 표면에는
오늘 소비자가 0건이고(§2.3), `conflict-service.ts:41-54`가 세운 선례("프로덕션 호출자가
없는 경로는 첫 호출자를 배선하는 사람이 가드한다")가 정확히 이런 지출을 미루라고 말한다.

**(가)에 호출자 지정 이벤트 id라는 이음매를 더하면 ㉰는 실제로 완전히 닫힌다.** 두
이벤트가 한 `appendEvents` 배열로 들어가고(`contradiction-service.ts:245-270`) 그 배열이
`db.transaction` 하나이므로(`event-store.ts:303-313`), 두 번째 insert의 UNIQUE 위반이
배치 전체를 롤백시켜 중복 `conflict.detected`와 중복 `memory.superseded`가 **둘 다**
남지 않는다 — 소스 주석이 그 성질을 의도로 적어 놨다(`contradiction-service.ts:232-235`).
그럼에도 각하하는 이유는 셋이고, 각각이 후보②에는 없는 대가다(§3.2 상술):

1. **이벤트 정체성 변경.** "이벤트 id는 append 경로가 민팅한다"는 불변을 깨는 것이고,
   #282가 값을 낸 자리가 정확히 "가장 자연스러워 보이던 후보가 결함을 가드 밖으로 옮기는
   거래"였다. 후보②는 이 축을 건드리지 않는다.
2. **예외 판별·삼킴 경로 추가.** 중복이 던지면 안 되는 꼬리
   (`contradiction-service.ts:271-283`)에서 예외로 올라오므로
   `isDuplicateGenesisError`(`event-store.ts:100-106`) 모양의 판별자가 하나 더 필요하고,
   그 판별자가 "기대한 중복"과 "다른 UNIQUE 위반"을 잘못 뭉뚱그리면 진짜 append 실패가
   조용히 사라진다.
3. **오늘 실제로 드는 비용을 하나도 없애지 못한다.** 거부는 append 시점이므로 낭비된
   judge LLM 왕복(§2.4 손해 (c))은 그대로 지불되는데, 표면 소비자가 0건인 오늘 그것이
   ㉰의 유일한 실비다. 후보②는 **그 쌍의** 재판정 자체를 없애 그 왕복까지 없앤다
   (음성 판정 쌍의 왕복은 어느 후보도 없애지 않는다 — §4.2·§7.1).

덧붙여 정규화를 놓치면 id는 결정적이지도 않다(§3.4). **다만 복제본 간 수렴 이득(§4 말미)은
실재하므로, 동기화 수신 경로가 배선되는 날 이 후보는 그 축에서 다시 저울에 올라야 한다.**

### 7.3 각하 2 — 아무것도 하지 않는다 (이 문서로 끝낸다)

각하한다. 이것이 가장 팽팽한 후보였고, **재측정(§5.3) 이후 더 팽팽해졌다** — 첫 판이
이 각하를 떠받친 _"비용이 두 자릿수 싸다"_ 가 틀린 축에서 나온 수치였기 때문이다. 그
문장을 걷어낸 자리에 다시 세운다.

㉰만 놓고 보면 "아무것도 안 함"이 이긴다 — 도달 조건이 넷이고(§1.3), 창은 커밋하는 리빌드
하나로 닫히며(§1.2), 표면 소비자는 0건이다(§2.3). 이 점은 인정한다. 각하하는 이유는
후보②가 사는 것이 ㉰의 희귀함이 아니기 때문이다: `detectContradictions`는 **head는
로그에서, basis는 프로젝션에서** 읽고, `AppendEventsOptions.expectedHead`의 doc이 그
조합에서 CAS가 통과해도 basis가 뒤처져 있을 수 있다고 명시한다
(`event-store.ts:246-256`). ㉰는 그 구조적 어긋남이 오늘 만들어내는 **관측 가능한 증상
하나**일 뿐이고, 증상만 희귀하다고 근거의 어긋남을 남겨 두면 다음 증상은 다른 이슈 번호로
다시 온다 — #263 → #270, #277 → #282 → #284가 같은 사슬을 세 번 돈 것이 그 증거다.
(이 문장을 §5.2가 정정한 범위 안에서 읽어야 한다: 후보②가 닫는 것은 이 부류의 **마지막
자리가 아니라 한 자리**이고, `consolidateBoundary`의 갈림은 #263에 남는다.)

**비용 쪽 근거는 바뀌었다.** 재측정 후에도 각하가 서는 근거는 "싸다"가 아니라
**"이미 내고 있는 것보다 더 내지 않는다"** 이다: 두 호출자 모두 `detectContradictions`
직전에 전량 리빌드를 끝내므로(`consolidate-service.ts:2650-2651` → `:2647`,
`memory-import-service.ts:839` → `:817`) 후보②의 한계비용은 그 리빌드의 0.15–0.97배로
상한이 잡히고, 그 비는 로그 길이에 따라 발산하지 않는다(§5.4). 만약 재측정이 이 상한을
깼다면 — 즉 replay가 리빌드보다 비쌌다면 — 이 각하는 뒤집혔을 것이고, 그 경우의 정당한
결론은 "고치지 않는다"였을 것이다(#289 Q1이 그 결론도 정당하다고 적었다).

### 7.4 각하 3 — 리빌드의 `committed`를 보고 재판정을 건너뛴다

각하한다. `contradiction-service.ts:303-304`가 `{ committed: false }`를 받았을 때
무언가 하게 만들자는 안이다(예: 플래그를 남겨 다음 패스가 판정을 건너뛰게 한다). 두 가지로
막힌다. 첫째, **이 자리의 정책은 이미 확정돼 있다** — #284가 "`committed: false`로는
호출 자리에서 아무것도 하지 않는다"를 정본으로 못박았고 회복은 한 층 아래로 내렸다
(`projection-store.ts:323-333`, `consolidate-service.ts:2635-2644`). 다섯 호출 자리 중
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
