# consolidateBoundary 근거/head 갈림 산정 (#296, #189 잔여 ㉱, #263 승계)

`consolidateBoundary`의 `run()`은 판정 근거를 **네 개의 서로 다른 소스**에서 잡는데,
`#253`이 넣은 CAS는 그중 하나(로그)만 검사한다. 코드 자신이 그 갈림을 적어 두고
(`consolidate-service.ts:2444-2457`) #263을 가리키는데 #263은 CLOSED다. 이 문서가 그
자리를 받아, 갈림을 닫는 후보를 재고 권고를 하나 낸다.

**이 문서는 산정이다.** `packages/` 아래 변경은 위 주석의 `#263` 포인터를 이 이슈 번호로
갱신하는 **1줄**이 전부이며, 실제 구현은 §Q6이 정하는 후속 이슈의 몫이다.

## 필수 질문 → 절 매핑

| 질문                                  | 절                                                                         | 한 줄 답                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Q1 근거 셋의 로그 파생 가능성         | [Q1](#q1--근거-셋-각각이-로그에서-파생-가능한가)                           | `existing` 가능 / `consumed` 가능 / `watermark` 불가능                      |
| Q2 근거별 stale 손해                  | [Q2](#q2--근거별로-stale일-때의-실제-손해가-무엇인가)                      | 중복 증류 / 중복 증류 / 자가 치유 — 셋은 독립이 아니라 **사슬**이다         |
| Q3 ㉰ 수법의 성립과 비용              | [Q3](#q3--㉰의-수법근거를-로그에-결속이-여기서-성립하는가-비용은-얼마인가) | 성립한다. 한계비용은 같은 경계가 뒤에 내는 리빌드의 **0.07–0.40배**         |
| Q4 `watermark`를 묶지 않아도 닫히는가 | [Q4](#q4--watermark를-로그에-묶지-않고도-손해가-닫히는가)                  | **닫힌다 — 남는 손해 0.** 그것이 권고다                                     |
| Q5 방어선 셋의 역할 분담              | [Q5](#q5--방어선-셋의-역할-분담)                                           | ④ / CAS / 근거 결속은 서로 다른 셋을 잡는다. 기존 주석은 **한 군데 낙관적** |
| Q6 후속 조각의 개수와 순서            | [Q6](#q6--후속-구현-조각의-개수와-순서)                                    | **1개, 선행 없음**                                                          |

## 0. 기준선 — 오늘 `run()`이 무엇을 어디서 읽는가

`run()`의 도입부 다섯 줄이 이 산정의 전부다.

| 근거           | 자리                                              | 무엇에서 오는가                | 언제 따라잡는가                                                             |
| -------------- | ------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `expectedHead` | `consolidate-service.ts:2141` (`readHeadEventId`) | **로그**                       | 즉시 (append가 착지하는 순간)                                               |
| `watermark`    | `:2142` (`getConsolidateWatermark`)               | `meta` 테이블 커서             | 상대 boundary의 `commitBoundaryCursors` — 그 run의 **맨 끝** (`:2693`)      |
| `consumed`     | `:2167` (`consumedObservationIds`)                | `memories` **프로젝션 테이블** | 상대 boundary의 `rebuildProjectProjection`이 **커밋**될 때 (§Q5.3에서 정정) |
| `existing`     | `:2214` (`listValidMemories`)                     | `memories` **프로젝션 테이블** | 같음                                                                        |

CAS는 `:2466`의 `appendEvents(..., { expectedHead })` 하나뿐이고, 그것이 검사하는 것은
`expectedHead` **한 줄**이다. `AppendEventsOptions.expectedHead`의 doc이 이 한계를 직접
적는다:

> _"That guarantee covers only a race BETWEEN the two reads … It says nothing about a basis
> that was ALREADY stale before either read: when 'the basis' is a derived cursor or
> projection that a concurrent writer advances separately from its own append … the check
> can still PASS while the caller's basis is behind the log. See #263."_
> (`event-store.ts:250-256`)

즉 **결함은 희귀한 버그가 아니라 문서화된 구조적 어긋남**이고, 이 산정은 그 어긋남을
어디까지 없앨 수 있는지를 잰다.

**㉰(#289/#294)의 결론이 그대로 이전되지 않는 이유**는 두 가지다. (1) ㉰의 근거는 **하나**
(`detectContradictions`의 basis)였고 여기는 **셋**이다. (2) ㉰의 비용 논증은 _"두 호출자
모두 직전에 전량 리빌드를 끝낸다"_ 였는데(`docs/contradiction-repeat-adjudication.md`
§5.3-§5.4), `run()`의 근거 읽기는 **맨 앞**이고 `:2631`의 리빌드는 **뒤**다. 그래서 §Q3은
비용을 처음부터 다시 잰다.

## Q1 — 근거 셋 각각이 로그에서 파생 가능한가

### Q1.1 `existing` (`listValidMemories`, `:2214`) — **가능**

**같은 질의의 로그 파생판이 이미 리포에 있다.** `memory-import-service`의
`readValidMemoriesFromLog`(`memory-import-service.ts:210-230`)는 `readEvents` +
`reduceProjectState` 뒤에 정확히 같은 필터를 건다:

```ts
memories: Object.values(state.memories).filter(
  (memory) => !memory.invalidAt && (memory.sourceProjectId ?? SELF_LANE) === SELF_LANE,
),
```

(`memory-import-service.ts:221-223`)

그리고 `listValidMemories`의 SQL은
`WHERE memories.invalid_at IS NULL AND ${laneWhere(lane)}`, 기본 lane은 `"self"`
(`projection-store.ts:1014-1026`) — **술어가 같다.** 그 자신의 doc이 _"The filter mirrors
`listValidMemories(projectId)` exactly"_ 라고 적는다(`memory-import-service.ts:206-208`).

**프로젝션에만 있고 로그에 없는 것이 하나 있지만 이 호출부는 쓰지 않는다.**
`listValidMemories`는 `memory_access` 조인으로 `lastAccessedAt`을 같이 돌려주는데
(`projection-store.ts:1020, 1027-1030`), `run()`은 `.map((row) => row.memory)`로 **레코드만
꺼내고 버린다**(`consolidate-service.ts:2214`). 그러므로 이 자리에서 로그 파생판과
프로젝션판의 결과는 **동일하다**.

판정: **가능** (조건 없음 — 이 호출부에 한해).

### Q1.2 `consumed` (`consumedObservationIds`, `:2167`) — **가능**

실물부터 확인한다. `consumedObservationIds`가 질의하는 것은:

```ts
const rows = getDb(projectId).prepare("SELECT data FROM memories").all() as …;
for (const row of rows) {
  const memory = JSON.parse(row.data) as ConsolidatedMemory;
  for (const id of memory.sourceObservationIds ?? []) consumed.add(id);
}
```

(`consolidate-service.ts:1885-1895`)

즉 **`memories` 행 전량**(무효·retract·dedup 패자 포함, lane 무관)의
`sourceObservationIds` 합집합이다.

**그 사실이 이벤트 payload에 실려 있는가 — 실려 있다.**

1. `sourceObservationIds`는 `ConsolidatedMemory`의 **필드**다
   (`domain/entities/memory.ts:100-101`, _"Observations this memory was distilled from
   (provenance)"_).
2. `run()`은 그것을 채워 메모리를 만들고(`consolidate-service.ts:2320`, `:2331`), 그
   **메모리 객체 자체를 `memory.consolidated`의 payload로 실는다**
   (`:2338-2345`의 `payload: memory`).
3. projector는 payload를 **그대로** id-키로 저장한다 — self lane은 무가공, foreign lane만
   `sourceProjectId`를 덧붙인다(`projections/projector.ts:551-560`). 어느 경로도
   `sourceObservationIds`를 건드리지 않는다.
4. 리빌드는 `state.memories`를 **전량** `memories` 테이블에 다시 쓴다 — 무효·dedup 패자도
   포함이고, 걸러지는 것은 FTS 색인뿐이다(`projection-store.ts:656-688`).
5. `memories` 테이블에 쓰는 프로덕션 경로는 그 replace-all **하나뿐**이다
   (`INSERT INTO memories`는 `projection-store.ts:657`과 `db.ts:825`의 마이그레이션이
   전부; `DELETE FROM events`는 리포 전체에 0건).

따라서 **`memories` 행의 `sourceObservationIds` 합집합 = 로그의 모든
`memory.consolidated` payload의 `sourceObservationIds` 합집합**이며, 후자는
`reduceProjectState`조차 필요 없는 **선형 스캔 한 번**으로 얻는다.

> 세부 둘. (a) import가 만드는 메모리는 `sourceObservationIds: []`이므로
> (`memory-import-service.ts:735`, `:744`가 같은 `memory.consolidated` 타입을 쓴다) 양쪽
> 모두에 아무것도 더하지 않는다. (b) 같은 id의 `memory.consolidated`가 두 번 들어와도
> id-키 덮어쓰기라 결과 집합은 같다.

판정: **가능** (조건 없음).

### Q1.3 `watermark` (`getConsolidateWatermark`, `:2142`) — **불가능**

세 가지가 각각 독립으로 막는다.

1. **로그에 없다.** `meta` 테이블의 단일 행이다
   (`consolidate-service.ts:1239-1263`, `WATERMARK_META_KEY = "cls_consolidate_watermark"`).
   `meta`를 쓰는 이벤트 타입은 존재하지 않는다.
2. **로그가 표현하지 못하는 진행을 담는다.** noop 경로는 `rawObservationEvents`의 마지막
   id로 커서를 밀어 버린다(`:2190-2199`) — 그 `rawObservationEvents`에는 **foreign lane
   관측**과 **이미 consumed된 관측**이 섞여 있고, 후자를 밀었다는 사실은 로그에 아무
   흔적도 남기지 않는다. 정상 경로도 `bounded.observations`의 **접두**까지만 밀므로
   (`:2674-2683`), "예산 때문에 여기까지만 봤다"는 사실 역시 로그 밖의 정보다.
3. **되돌리는 경로가 로그와 반대 방향이다.** `setConsolidateWatermark`는 **의도적으로
   무가드**이며, 그 이유가 _"The gc repair … has to move the cursor BACKWARDS (to a
   surviving event, once the one it named was physically reclaimed)"_ 다
   (`consolidate-service.ts:1265-1275`). 이 리포의 로그는 invalidate-not-delete
   append-only이므로 **후진 이동은 로그로 표현할 수 없다.**

덧붙여 이 커서는 **머신-로컬 진행 표시**다 — `LAST_ATTEMPT_META_KEY`가 같은 `meta`에
사는 이유로 적힌 _"machine-local operational telemetry … must not pollute the append-only
log or sync to siblings"_ (`:88-97`)와 같은 부류다.

판정: **불가능.**

### Q1 요약

| 근거        | 판정       | 결정적 인용                                                                                                                                                               |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `existing`  | **가능**   | `memory-import-service.ts:210-230` (같은 술어의 로그 파생판이 이미 있다), `consolidate-service.ts:2214` (`lastAccessedAt`을 버린다)                                       |
| `consumed`  | **가능**   | `domain/entities/memory.ts:100-101` + `consolidate-service.ts:2345` (payload에 실린다), `projector.ts:551-560` (무가공 보존), `projection-store.ts:656-670` (전량 재기록) |
| `watermark` | **불가능** | `consolidate-service.ts:1239-1263` (meta), `:2190-2199`·`:2674-2683` (로그에 없는 진행), `:1265-1275` (gc의 후진 리페어)                                                  |

## Q2 — 근거별로 stale일 때의 실제 손해가 무엇인가

전제는 `:2444-2457`이 적은 인터리브다: **상대 holder의 append는 이 boundary가
`expectedHead`를 읽기 전에 착지했고, 그 holder의 rebuild/cursor-commit은 아직 미결이다.**
CAS는 통과한다.

### Q2.1 `consumed`가 stale — **중복 증류**

`consumed`는 `observationEvents`를 거르는 유일한 장치다(`:2167-2171`, 주석 자신이
_"Dedup guard for watermark loss"_). stale이면 **상대가 방금 증류한 관측이 이 boundary의
창에 그대로 남고**, 추출기에 다시 실려 `memory.consolidated`가 하나 더 로그에 남는다.
#132가 없애려던 바로 그 중복 증류다.

**projector의 자동 수렴이 이것을 접어 주지 않는다.** `dedupeMemoriesBySource`는
`lane + sourceObservationIds 집합(정렬) + kind + 정규화 텍스트`가 **전부 같을 때만**
접는다(`projector.ts:221-232`, `:238-247`). 두 boundary의 창은 예산·watermark 위치·
foreign 섞임 때문에 일반적으로 **다른 집합**이고, 추출기 텍스트도 LLM 호출마다 다르다.
접히는 것은 "복제본이 같은 창을 같은 텍스트로 증류한" 좁은 경우뿐이다.

분류: **중복 증류.**

### Q2.2 `existing`가 stale — **중복 증류** (+ 중복 supersede 부수)

`existing`은 두 곳으로 흘러간다.

- **추출 프롬프트의 existing-memories 블록**(`:2214` → `boundExtractionInput`). stale이면
  상대가 방금 만든 메모리를 모델이 못 보고, 같은 내용을 다시 뽑아 **중복 메모리**가 된다.
  Q2.1과 같은 이유로 dedup에 걸리지 않는다.
- **supersede 대상 화이트리스트**(`validIds`, `:2319`). stale이면 상대가 방금 supersede/
  retract한 메모리가 여전히 "유효"로 보여, 이 boundary가 그것을 **다시 supersede**한다.
  `docs/contradiction-repeat-adjudication.md` §2.1이 같은 모양을 이미 재 놨다: projector가
  행은 하나로 접지만 `invalidAt = event.createdAt`(`projector.ts:562-576`)이라 **나중
  이벤트의 시각이 이긴다** — 유효 창이 첫 supersede가 아니라 재판정 시점에 닫힌 것으로
  기록된다. 그 값을 읽는 프로덕션 소비자는 오늘 0건이다(§2.1의 표).

주된 손해는 첫째다.

분류: **중복 증류** (부수 손해인 중복 `memory.superseded`는 오늘 소비자 0건).

### Q2.3 `watermark`가 stale — **자가 치유되는 파생 버퍼**

두 방향을 나눠 본다.

- **뒤처진 경우(behind).** `readEventsSince(watermark)`가 더 넓은 창을 돌려주고, 이미
  증류된 관측이 창에 섞인다 — 그리고 `consumed`가 그것을 정확히 걸러 낸다(`:2167-2171`).
  남는 비용은 **더 넓은 스캔 한 번**뿐이다. 모듈 doc의 주장 그대로다:
  _"simply leaves the watermark behind — the next boundary re-collects the same
  observations and retries"_ (`consolidate-service.ts:56-60`).
- **앞선 경우(ahead).** 커서를 앞으로 미는 프로덕션 경로는
  `commitBoundaryCursors`뿐이고(`:2693`, `:2196`), 그것은 상대 run의 **맨 끝** — 즉 그
  append가 **이미 착지한 뒤** — 에만 실행된다. 그리고 밀리는 지점은 그 boundary가 실제로
  증류한 관측(`:2676`)이거나, 자기 창의 self-lane 관측이 **전부 이미 consumed된** 경우의
  스캔 끝(`:2682`, `:2196`)이다. 그러므로 **건너뛴 self-lane 관측은 모두 이미 증류된
  것**이고 건너뛰는 것이 옳다 — 놓침이 아니다.
- **되감기는 없다.** `commitBoundaryCursors`의 쓰기는 단조다
  (`watermarkWouldRegress`, `:1386-1394`, `:1471-1473`) — #211이 늦게 깨어난 dispossessed
  holder가 커서를 뒤로 끌지 못하게 막았다.

분류: **자가 치유되는 파생 버퍼.**

### Q2.4 셋은 독립인가 — **아니다. 사슬이다** (`watermark` 무해 주장은 `consumed`에 의존하는가: **예**)

**예.** Q2.3의 무해 논증은 두 자리 모두에서 `consumed`에 기댄다.

- behind 방향: 넓어진 창의 중복을 걸러 내는 것이 `consumed`다. 코드가 이 의존을 **직접
  적어 놨다** — `:2165-2166`의 주석이 `consumedObservationIds`를 _"Dedup guard for
  watermark loss"_ 라고 부른다. 즉 `consumed`는 `watermark`의 안전망으로 **설계된**
  것이다.
- ahead 방향: "건너뛴 것은 이미 증류된 것"이라는 판정 자체가 `consumed`의 신선도와 같은
  사실에 기댄다.

그러므로 **`consumed`가 stale이면 `watermark`의 무해도 무너진다.** 사슬의 방향은 한쪽이다:

```
consumed 신선  →  watermark stale 무해
consumed stale →  watermark stale도 중복 증류에 가담
```

이 사슬이 §Q4의 답을 결정한다.

### Q2 요약

| 근거        | 분류          | 오늘 손해                                             |
| ----------- | ------------- | ----------------------------------------------------- |
| `consumed`  | **중복 증류** | 로그에 `memory.consolidated` 하나 더, dedup에 안 걸림 |
| `existing`  | **중복 증류** | 같음 + 중복 `memory.superseded`(소비자 0건)           |
| `watermark` | **자가 치유** | 넓어진 스캔 1회 — **단, `consumed`가 신선할 때만**    |

## Q3 — ㉰의 수법(근거를 로그에 결속)이 여기서 성립하는가, 비용은 얼마인가

Q1이 **가능**으로 판정한 `existing`·`consumed`에 한해 답한다.

### Q3.1 성립한다 — 그리고 ㉰보다 이음매가 하나 적다

㉰의 수법은 _"basis와 head를 한 `readEvents` 배열에서 뽑는다"_ 였다. 여기서는 한 배열이
**네 가지**를 동시에 준다.

```ts
const events = await readEvents(projectId);          // 한 번의 읽기
const expectedHead = events.at(-1)?.id ?? null;      // 오늘 :2141
const state = reduceProjectState(events, projectId);
const existing = …invalidAt 없음 + self lane…;       // 오늘 :2214
const consumed = …memory.consolidated payload 합집합…; // 오늘 :2167
const eventsSince = …watermark 위치 뒤 슬라이스…;      // 오늘 :2143
```

`expectedHead`와 근거가 **같은 배열**에서 나오므로 "CAS는 통과하는데 근거는 낡았다"는
상태가 **정의상 불가능**해진다. 이것은 `#253`(`memory-import-service.ts:224-228`)과
`#270`(`projection-store.ts:373-379`)이 이미 두 번 쓴 패턴이고, 세 번째 적용이다.

`readEventsSince`도 같은 배열의 슬라이스로 대체된다 — 오늘 별도 질의인 창 스캔이
사라지므로, 창과 근거가 **다른 시점**일 가능성도 함께 닫힌다.

### Q3.2 실측

**측정 방법** (`docs/contradiction-repeat-adjudication.md` §5.3의 절차를 그대로 따랐다):

- 스크립트: 임시 파일(커밋하지 않음). 전문과 원출력은 PR 본문에 첨부.
- 셀마다 **23회** 실행, **앞 3회를 워밍업으로 폐기**, 남은 **20회**의 **최소값과 중앙값**을
  둘 다 싣는다.
- 샘플마다 `global.gc()`를 **타이머 밖에서** 먼저 돌린다(`node --expose-gc`). replay는
  이벤트당 객체 하나를 할당하므로, 강제하지 않으면 GC 일시정지를 재게 된다.
- **최소값을 싣는 이유**: 2 vCPU 컨테이너라 선점 노이즈가 시간을 **더하기만** 한다.
  최소값이 실제 비용에 가깝고 중앙값은 노이즈 섞인 상한이다. **결론은 둘 다에서 성립하는
  것만** 쓴다.
- 이벤트 믹스 = **25건 반복 단위** (§5.3과 동일):
  observation.captured 18 / memory.consolidated 4(progress·rationale) /
  memory.consolidated 1(decision) / memory.injected 1 / session.started 1.
  genesis(`project.created`)가 1번 이벤트. **한 단위의 메모리 5건은 그 단위의 관측 18건
  id를 전부 공유한다** — `run()`이 실제로 하는 일이다(`:2320`의
  `sourceObservationIds`가 배치 전체에 하나). 메모리 텍스트는 전부 달라
  `dedupeMemoriesBySource`가 접지 않는다.
- **watermark는 정상 상태 위치** — head에서 한 단위(25건) 뒤. 지난 boundary가 자기 창을
  소비하고 끝낸 스토어의 모양이다. (커서가 비어 있으면 `readEventsSince`는 전량으로
  퇴화한다 — `event-store.ts:396-405`.)
- 스토어는 셀마다 새로 만들고 `reindexSearch: true` 리빌드를 1회 돌린 뒤 측정 — SQLite
  페이지 캐시가 **워밍된** 수치다.
- 환경: Node v22.23.2, better-sqlite3 12.x, 2 vCPU 리눅스 컨테이너. **절대값이 아니라 열
  사이의 비가 판정 재료다.**

**측정 대상**

- **오늘**: `getConsolidateWatermark` + `readEventsSince(watermark)` +
  `consumedObservationIds` + `readHeadEventId` + `listValidMemories` (=`run()`의 `:2141`,
  `:2142`, `:2143`, `:2167`, `:2214`).
- **후보 A** (`consumed`만 결속): `readEvents` 전량 + `memory.consolidated` 선형 스캔 +
  head + 창 슬라이스. `existing`은 프로젝션 유지.
- **후보 B** (`consumed`+`existing` 결속): `readEvents` 전량 + `reduceProjectState` +
  네 값 모두 같은 배열에서.
- **참고**: `rebuildProjectProjection({reindexSearch:true})` — **같은 boundary가 `:2631`에서
  뒤에 내는 비용**.

모든 셀 `min / 중앙` ms:

|    n (총 이벤트) | 메모리 행 | 창 `readEventsSince` |    `consumed` |    `existing` |      `head` | **오늘 합계** |      **후보 A** |      **후보 B** |    참고 `rebuild` |
| ---------------: | --------: | -------------------: | ------------: | ------------: | ----------: | ------------: | --------------: | --------------: | ----------------: |
| 1 (genesis only) |         0 |          0.19 / 0.21 |   0.10 / 0.12 |   0.13 / 0.14 | 0.12 / 0.14 |   0.27 / 0.33 |     0.24 / 0.27 |     0.24 / 0.29 |       1.10 / 1.31 |
|               50 |        10 |          0.29 / 0.33 |   0.18 / 0.20 |   0.19 / 0.20 | 0.12 / 0.13 |   0.46 / 0.56 |     0.52 / 0.56 |     0.57 / 0.61 |       1.77 / 1.98 |
|              200 |        40 |          0.29 / 0.31 |   0.28 / 0.31 |   0.28 / 0.29 | 0.12 / 0.13 |   0.65 / 0.73 |     1.09 / 1.20 |     1.38 / 1.53 |       3.40 / 3.95 |
|             1000 |       200 |          0.29 / 0.31 |   0.90 / 1.01 |   0.72 / 0.77 | 0.11 / 0.13 |   1.76 / 1.92 |     4.83 / 5.19 |     5.66 / 5.96 |     14.39 / 18.03 |
|             5000 |      1000 |          0.31 / 0.36 |   4.06 / 4.48 |   3.04 / 3.43 | 0.13 / 0.14 |   7.65 / 8.64 |   33.39 / 36.57 |   42.42 / 46.87 |    87.85 / 900.66 |
|            20000 |      4000 |          0.32 / 0.35 | 19.45 / 23.24 | 18.99 / 22.29 | 0.12 / 0.14 | 38.66 / 42.53 | 192.08 / 215.18 | 217.73 / 245.76 | 2549.17 / 2673.73 |

> n=5000의 `rebuild` **중앙값 900.66 ms**는 min 87.85 ms의 10배로, 명백한 선점/GC
> 노이즈다. 아래 해석은 **min에서도 중앙에서도 같이 성립하는 것만** 쓰고, 이 셀의 중앙값
> 비에는 기대지 않는다.

**한계비용 = 후보 − 오늘 합계, 그리고 한계비용 ÷ `rebuild`:**

|     n |   후보 A 한계비용 |   후보 B 한계비용 | B 한계비용 ÷ rebuild | B ÷ 오늘 (배수) |
| ----: | ----------------: | ----------------: | -------------------: | --------------: |
|     1 |     −0.03 / −0.06 |     −0.03 / −0.04 |              ≈0 / ≈0 |     0.89 / 0.88 |
|    50 |     +0.06 / +0.00 |     +0.11 / +0.05 |          0.06 / 0.03 |     1.24 / 1.09 |
|   200 |     +0.44 / +0.47 |     +0.73 / +0.80 |          0.21 / 0.20 |     2.12 / 2.10 |
|  1000 |     +3.07 / +3.27 |     +3.90 / +4.04 |          0.27 / 0.22 |     3.22 / 3.10 |
|  5000 |   +25.74 / +27.93 |   +34.77 / +38.23 |      0.40 / (노이즈) |     5.54 / 5.42 |
| 20000 | +153.42 / +172.65 | +179.07 / +203.23 |          0.07 / 0.08 |     5.63 / 5.78 |

### Q3.3 비용 해석 — ㉰의 논증은 쓰지 않는다

㉰가 후보②를 떠받친 문장(_"호출 직전에 이미 전량 리빌드를 끝냈다"_)은 여기서 **쓸 수
없다.** 근거 읽기는 `run()`의 맨 앞이고 리빌드는 `:2631`, 즉 **뒤**다. 대신 실측이 실제로
말하는 셋을 쓴다.

1. **오늘의 기준선은 이미 같은 축 위에 있다.** 표의 `창` 열은 n이 2만 배로 늘어도
   **0.19 → 0.32 ms로 사실상 상수**다(watermark가 정상 위치이므로 창은 항상 25건). 오늘
   비용을 실제로 키우는 것은 `consumed`와 `existing` — **둘 다 프로젝션의 메모리 행 수에
   비례**해 이미 자란다(n=20000에서 합계 38 ms 중 38 ms). 로그 결속이 새 곡선을 들여오는
   것이 아니라, **이미 타고 있는 곡선의 상수를 약 5.6배로 올린다.**
2. **한계비용은 같은 boundary가 뒤에 내는 리빌드보다 항상 작다.** 비는 격자 전체에서
   **0.07–0.40**이고 1을 넘지 않는다. 그리고 그 리빌드는 **중복 증류가 발생하는 바로 그
   경로에서 보장된다** — `:2630`의 게이트가 `inputs.length > 0 || segmentsWritten > 0`이고,
   메모리를 만든 boundary는 `inputs.length > 0`이므로 반드시 성립한다. 즉 손해가 실재하는
   경로에서는 한계비용이 **이미 확정된 지출의 분수**다.
3. **자리가 핫패스가 아니다.** 이 지출은 capture마다가 아니라 boundary마다이고, 그
   boundary는 이미 추출 LLM 왕복 1회 + 리빌드 최대 2회 + embedder 왕복 2회 + judge LLM
   왕복(쌍마다)을 낸다(`project-lock.ts:113-129`가 이 꼬리 구성을 적어 놨다). n=20000의
   +179 ms는 그 꼬리에서 **LLM 왕복 한 번의 수십분의 일**이다.

**축소하지 않는다.** n=20000 스토어에서 후보 B의 근거 읽기는 218 ms이고, 로그는
append-only라 되돌아가지 않는다. 다만 그 곡선은 이 후보가 만든 것이 아니라 투영 설계
전체가 이미 타는 것이며(리빌드가 capture마다 전량 replay한다), 스냅샷/증분 replay로
그것을 꺾는 일은 이 산정과 다른 축이다.

### Q3.4 실측이 드러낸 결정적 사실 — 후보 A는 거의 아무것도 아끼지 못한다

`B − A`, 즉 **`existing`까지 `reduceProjectState`로 옮기는 몫**:

|     n | B − A (min / 중앙) | A 대비 증가율 |
| ----: | -----------------: | ------------: |
|  1000 |   +0.83 / +0.77 ms |     17% / 15% |
|  5000 |  +9.03 / +10.30 ms |     27% / 28% |
| 20000 | +25.65 / +30.58 ms |     13% / 14% |

비용의 대부분은 `readEvents` 자체(행 읽기 + `rowToEvent` + JSON 파싱)이고, 일단 그것을
지불하면 `reduceProjectState`를 얹는 값은 **13–28%**다. 후보 A는 그 13–28%를 아끼는
대가로 `existing`을 여전히 프로젝션에서 읽어 **두 근거가 서로 다른 시점의 것이 되는
창을 다시 연다.** §Q6이 조각을 하나로 두는 이유가 여기 있다.

### Q3 판정

**성립한다.** `existing`·`consumed`를 `expectedHead`와 **한 `readEvents` 배열**에 묶는 것은
구조적으로 갈림을 없애고, 비용은 같은 boundary가 뒤에 내는 리빌드의 0.07–0.40배다.

## Q4 — `watermark`를 로그에 묶지 않고도 손해가 닫히는가

§Q2.4가 사슬로 판정했으므로 이 질문에 답이 필요하다. 답은 **닫힌다 — 남는 손해 0**이다.

`consumed`+`existing`만 로그로 옮긴 세계에서 stale `watermark`가 할 수 있는 일을 전수한다.

| stale 방향 | 무슨 일이 일어나나               | 남는 손해                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **뒤처짐** | 창이 필요보다 넓어진다           | **없음.** 넓어진 부분은 `consumed`가 거른다 — 그리고 그 `consumed`는 이제 `expectedHead`와 같은 배열에서 나온 **로그의 진실**이라 stale일 수 없다. 남는 것은 스캔 비용뿐이고, 후보 B에서는 창이 애초에 그 전량 배열의 슬라이스라 **추가 비용이 0**이다                |
| **앞섬**   | 창이 늦게 시작해 관측을 건너뛴다 | **없음.** 커서를 미는 유일한 경로가 `commitBoundaryCursors`이고 그것은 상대 run의 **맨 끝**, 즉 그 append가 **이미 로그에 착지한 뒤**다(`:2693`). 그러므로 건너뛴 self-lane 관측은 이 boundary의 로그 파생 `consumed`에 **반드시 들어 있다** — 건너뛰는 것이 정답이다 |
| **되감김** | —                                | **발생하지 않는다.** `watermarkWouldRegress`(`:1386-1394`)가 단조성을 강제한다                                                                                                                                                                                        |

**핵심은 커서와 로그의 순서 관계다.** `commitBoundaryCursors`가 `appendEvents`보다
**항상 뒤**이므로, 커서는 로그보다 앞설 수 없다. 근거를 로그에 묶는 순간 이 boundary의
지식은 **커서보다 항상 같거나 신선**해지고, 커서는 "어디부터 스캔하면 되는가"라는
**성능 힌트**로 강등된다 — 틀려도 안전한 방향으로만 틀린다.

즉 §Q2.4의 사슬은 `consumed`를 로그에 묶는 것만으로 **끊긴다.** 사슬의 아래쪽
(`watermark`)을 따로 손볼 필요가 없다.

**남는 손해가 없으므로 그것이 권고다** — 로그 밖 커서를 건드리는 것보다 싸다.

## Q5 — 방어선 셋의 역할 분담

### Q5.1 표

|                                       | 무엇을 잡나                                                                                                                                                                          | 무엇을 못 잡나                                                                                                                                                                                                                                                                                | 왜                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **④ `throwIfDispossessed`** (`:2432`) | 이 holder가 **락을 잃었다는 신호를 이미 받은** 경우 — 큰 지출(추출 LLM, 세그먼트 쓰기, append) 앞에서 멈춘다                                                                         | (a) 아직 통지되지 않은 탈취 — 하트비트 주기(`LOCK_HEARTBEAT_MS = 5_000`, `project-lock.ts:482`)만큼 늦다. (b) **락을 아예 잡지 않는 writer** — `memory-import-service`가 그렇다(모듈 doc `:59-63`, _"Import has no kernel seam yet"_). (c) ④ **이후**의 꼬리 전체 (`project-lock.ts:108-131`) | 신호 기반이고, 신호를 만드는 것은 락이다                                                                             |
| **CAS** (`:2466`, `expectedHead`)     | `expectedHead`를 읽은 **뒤에** 착지한 append — 락 여부와 무관하게 모든 writer를 잡는다. 트랜잭션 **안**에서 head를 다시 읽으므로 read-then-write 창이 없다(`event-store.ts:262-272`) | **읽기 전에 이미 착지한 append로 인한 근거의 낡음.** `expectedHead`는 "판정 뒤에 로그가 움직였는가"만 본다                                                                                                                                                                                    | 근거가 로그가 아닌 **파생 저장소**(meta 커서, 프로젝션 테이블)에서 오고, 그 둘은 append와 **다른 시점에** 따라잡는다 |
| **근거 결속** (이 산정의 후보)        | 위의 잔여 전부 — 근거가 `expectedHead`보다 낡은 상태 자체를 **정의상 불가능**하게 만든다                                                                                             | append **이후**의 움직임 (그것이 CAS의 몫), 그리고 락이 지키는 상호배제 일반 (④/#132의 몫)                                                                                                                                                                                                    | 근거와 head가 **한 배열**에서 나오면 둘이 다른 append를 본 상태가 존재할 수 없다                                     |

셋은 서로를 대체하지 않는다. **④는 시간 축**(내가 아직 주인인가), **CAS는 로그 축**(내가
본 뒤에 로그가 움직였는가), **근거 결속은 근거 축**(내가 본 것이 로그와 같은 순간인가)을
각각 맡는다.

### Q5.2 `:2434-2444`의 기존 판정 재확인 — **맞다**

주석은 CAS가 잡는 것을 _"an append landing on the log AFTER `expectedHead` was read
above — the subset ④ (above) cannot catch, since ④ only fires once THIS holder's own
dispossession signal has arrived (up to one heartbeat behind the takeover) and never
fires at all for a writer that took no lock"_ 라고 적는다. 세 조각 모두 실물과 맞는다:

- `throwIfDispossessed`는 `signal?.aborted`만 본다(`project-lock.ts:578-586`) — 순수 신호
  기반이다. ✔
- 신호는 `withProjectLock`이 나눠 주고 하트비트 주기는 5초다(`project-lock.ts:474-482`). ✔
- 락을 잡지 않는 writer가 실재한다 — `memory-import-service` (모듈 doc `:59-63`). ✔

### Q5.3 `:2444-2457`의 인터리브 서술 — **맞다. 다만 한 군데가 낙관적이고, 그 방향은 갈림을 넓힌다**

주석은 `consumedObservationIds`에 대해 이렇게 적는다:

> _"…so it catches up as soon as that boundary's `rebuildProjectProjection` call completes"_

**실물은 "call completes"가 아니라 "a rebuild COMMITS"다.** `rebuildProjectProjection`은
`REBUILD_STALE_HEAD_RETRIES`(=2, `projection-store.ts:269`)회 재시도한 뒤 head가 계속
움직이면 **`{ committed: false }`를 돌려주고 아무것도 쓰지 않는다**
(`projection-store.ts:344-360`, `:351-355`의 _"Nothing is written on a lost attempt"_).
그리고 `:2631`의 호출부는 그 결과를 **의도적으로 버린다**(`:2617-2625`가 그 판단을 #284의
결론으로 적어 놨다). `project-lock.ts:322-330`의 T5/T6이 같은 결말을 적는다 —
_"A can exhaust its retries … leaving the projection exactly as B left it (B's rows
intact, A's own appended events not yet projected) until the next rebuild that completes."_

즉 상대 boundary의 리빌드가 CAS에 지면 그 boundary의 메모리는 `memories` 테이블에
**전혀 도달하지 못한 채** run이 끝나고, `consumed`는 **그 뒤 언젠가 커밋하는 리빌드까지**
낡은 채로 남는다.

**결론의 방향**: 이 정정은 주석의 판정을 뒤집지 않는다 — **갈림을 더 넓게 만든다.** 주석이
"rebuild 호출이 끝나면 닫힌다"고 읽히는 창은 실제로는 그보다 길다. `existing`도 같은
테이블에서 오므로 동일하게 적용된다.

(`#279`에서 같은 종류의 주석이 실제로 틀렸던 선례가 있어 전수로 확인했다. `:2444-2457`의
나머지 — `watermark`가 상대 run의 맨 끝에서만 움직인다, `expectedHead`는 즉시 따라잡는다,
CAS가 통과하면서 근거가 낡을 수 있다 — 는 모두 실물과 맞았다.)

## Q6 — 후속 구현 조각의 개수와 순서

### 권고 (정확히 1개)

**`consolidateBoundary`의 `existing`·`consumed`·`expectedHead`·관측 창을 `run()` 도입부의
단일 `readEvents` 배열에서 파생시킨다. `watermark`는 `meta` 커서로 남긴다.**

### 후속 이슈: **1개. 선행 없음.**

이 산정 자체에 선행이 없고(㉰의 #289/#294는 이미 머지됐다), 조각도 하나다.

**조각의 범위 (한 문단).** `consolidate-service.ts`의 `run()` 도입부(`:2141-2171`,
`:2214`)를 하나의 `readEvents(projectId)` 호출로 재배선한다: 그 배열의 마지막 id가
`expectedHead`가 되고(`:2141`의 `readHeadEventId` 제거), 배열을 `reduceProjectState`로
접어 `invalidAt` 없음 + self-lane 필터로 `existing`을 얻고(`:2214`의 `listValidMemories`
제거 — `lastAccessedAt`은 이 호출부가 이미 버린다), 같은 배열의 `memory.consolidated`
payload에서 `sourceObservationIds`를 모아 `consumed`를 얻고(`:2167`의
`consumedObservationIds` 호출 제거 — 그 함수의 호출부는 리포 전체에 `:2167` 하나뿐이라
함께 지운다), `watermark`가 가리키는 이벤트 뒤를 슬라이스해 창을 얻는다(`:2143`의
`readEventsSince` 제거). `watermark` 읽기(`:2142`)와 `commitBoundaryCursors`는 **그대로
둔다**. **수용 기준 넷**:

1. 지금까지 관측/메모리 프로젝션에서 오던 네 값이 모두 한 배열에서 나온다 — `run()`
   도입부에 `readEvents` 외의 근거 질의가 남지 않는다.
2. **두 근거의 필터가 서로 다르다는 것을 보존한다.** `existing`에는 `invalidAt` 없음 +
   self-lane 필터를 걸고(`listValidMemories`의 `laneWhere("self")` =
   `source_project_id IS NULL`, `projection-store.ts:95-97`), **`consumed`에는 어느 필터도
   걸지 않는다** — 오늘의 `consumedObservationIds`는 `SELECT data FROM memories`로 무효·
   retract·dedup 패자·foreign lane을 **전부** 포함한다(`:1885-1895`). 여기에 "일관성" 삼아
   valid/self 필터를 얹으면 무효화된 메모리가 소비한 관측이 미소비로 되돌아가 **재증류
   된다** — 갈림을 닫으러 가서 반대편에 같은 결함을 여는 셈이다. 순서도 오늘 그대로다:
   창 → lane 필터(`:2160-2162`) → `consumed` 필터(`:2168-2170`) → `boundExtractionInput`의
   예산 컷.
3. **비용 게이트** — 창에 self-lane 관측이 하나도 없고 대화 조각(`transcriptTail`)도
   없으면 전량 replay를 **아예 하지 않고** 오늘의 noop 경로(`:2190-2199`, 커서 전진
   포함)로 빠진다. §Q3의 실측이 보인 n=20000의 +179 ms를 조용한 boundary가 내지 않게 하는
   유일한 장치이며, ㉰ 구현이 `embedder` 가드 뒤에 replay를 둔 것과 같은 모양이다
   (`docs/contradiction-repeat-adjudication.md` §5.4). 이 게이트는 오늘 noop이 되는 경우의
   **부분집합**에서만 발동하므로(오늘의 조건은 `consumed` 필터 **뒤**의
   `observations.length === 0`) 근거를 건너뛰고 증류하는 일은 생기지 않는다.
4. 테스트는 **동작 하나당 하나** — 상대 holder의 append가 착지했고 리빌드는 미결인 상태를
   만든 뒤, 오늘은 중복 `memory.consolidated`가 나고 변경 후에는 나지 않음을 단언하는 통합
   테스트 1건 + 게이트(3)의 noop 경로가 replay를 타지 않음을 단언하는 1건.

### 왜 둘로 쪼개지 않는가

`consumed`와 `existing`을 서로 다른 이슈로 나누면, 중간 상태에서 **한쪽은 로그, 다른
쪽은 프로젝션**이 되어 두 근거 사이에 새 창이 열린다 — `#253`과 `#270`이 각각 없앤 바로
그 모양이다. 그리고 §Q3.4의 실측이 그 분할에 값이 없음을 보인다: `existing`까지 얹는
한계비용은 `consumed`만 얹을 때보다 **13–28%** 더 들 뿐이다. 조각을 나누면 위험은 늘고
절약은 없다.

### 각하한 후보 — 각각 **대가**를 사유로

각하 사유는 어느 것도 _"효과가 없어서"_ 가 아니다.

1. **`watermark`까지 로그에 묶는다** (진행 커서를 이벤트로). 대가 셋: (a) boundary마다
   커서 이벤트가 append-only 로그에 쌓이고, 그것이 동기화로 형제 스토어에 전파되어
   **머신-로컬 진행이 공유 상태가 된다** — `LAST_ATTEMPT_META_KEY`가 `meta`에 사는 이유와
   정면 충돌한다(`:88-97`); (b) gc의 **후진 리페어**(`:1265-1275`)가 표현 불가능해진다 —
   invalidate-not-delete 로그에 "커서를 뒤로"를 쓸 방법이 없고, 그 경로가 죽으면 스토어가
   자기 로그 전체를 영원히 재증류한다; (c) §Q4가 **남는 손해 0**을 보였으므로 대가만
   남는다.
2. **후보 A — `consumed`만 묶고 `existing`은 프로젝션에 둔다.** 대가: 두 근거가 서로 다른
   시점의 것이 되어 `#253`/`#270`이 없앤 창을 되살린다. 절약은 §Q3.4의 13–28%뿐이고,
   그것은 **오늘 이미 지불하는 `listValidMemories` 비용을 그대로 두는** 대가다.
3. **근거 읽기 직전에 리빌드를 한 번 돌린다.** 대가 둘: (a) noop 포함 **모든** boundary가
   전량 replay + 전체 테이블 replace-all을 무조건 낸다 — §Q3 표의 `rebuild` 열이 그
   값이고 n=20000에서 **2.5 s**로, 후보 B의 218 ms보다 한 자릿수 비싸다; (b) **갈림이
   닫히지도 않는다** — 리빌드와 근거 읽기 사이에 새 창이 열리고, 그 리빌드가
   `committed: false`로 끝날 수 있다(§Q5.3).
4. **락을 강화한다** (커밋 시점 동기 소유권 확인). 대가: `#189` 본문이 크로스-프로세스 락
   검증을 **CI 예산 밖**으로 못박았고, 강화해도 **락을 잡지 않는 writer**(`import`,
   §Q5.1)는 여전히 잡지 못한다 — 이 갈림의 한 축이 통째로 남는다.
5. **아무것도 하지 않는다** (이 문서로 끝낸다). 대가: `#132`가 없애려던 중복 증류가 열린
   채 남고, 코드가 스스로 적어 둔 갈림이 **어느 열린 이슈에도 등재되지 않은** 상태로
   돌아간다 — #263이 닫히면서 실제로 그렇게 됐고, 이 이슈가 그것을 고치러 열렸다.
6. **후보 (가) 결정적 이벤트 id / 호출자 지정 이벤트 id.**
   `docs/contradiction-repeat-adjudication.md` §7.2가 **대가**를 사유로 이미 각하했다
   (이벤트 정체성 불변 파괴, 예외 판별·삼킴 경로 추가, 오늘 드는 실비를 하나도 없애지
   못함). 이 산정은 그 판정을 승계하며 재제안하지 않는다.

## 부록 — 산정 중 발견한 실물 어긋남 (이 PR에서 고치지 않음)

범위 밖(이 PR의 `packages/` diff는 `:2457`의 1줄이 전부)이라 기록만 남긴다.

- `packages/kernel/src/storage/project-lock.ts:114` — 리빌드 게이트를
  `consolidate-service.ts:2591`로 인용하는데, 실제 자리는 **`:2630`**이다.
- `packages/kernel/src/storage/event-store.ts:256` — `AppendEventsOptions.expectedHead`의
  doc도 닫힌 **#263**을 가리킨다. 이 이슈의 완료 조건이 `consolidate-service.ts:2457`
  **한 줄**로 못박혀 있어 손대지 않았다.
