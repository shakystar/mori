# B 축 후보 2·3(증류 창 유니크 · import 정규화 텍스트 유니크) 재측정 (#310, #189 B, 2026-08-04 사람 결정)

2026-08-04 사람 결정이 #189의 1안(A+B+C 스토어 강제)을 채택하고 순서를 **C → B → A**로
못박았다. C는 #235가, A는 #305/PR #308이 닫았고, B는 **후보1(genesis)만** #236/PR #251이
닫았다(v18 `idx_events_genesis_once`). **후보2·3이 이 idea의 마지막 잔여다.**

**이 문서는 산정이다.** `packages/` 아래 변경은 **0줄**이고 실행되는 코드도 0줄이다.
결론은 §Q5·§Q6의 후속 조각 목록으로 나간다.

**기준선**: `main` = `60f8931`
(`docs(kernel): resolveConflict에 트리거 문장을 남긴다 … (#301 §Q5 조각 1, #189 A) (#308)`,
`2026-08-06T08:06:52+09:00`).
이 문서의 모든 `파일:줄` 인용은 **그 커밋에서 파일을 직접 열어 대조한 것**이다 — 이슈 본문,
#189·#236 본문, 선행 문서의 줄번호를 옮겨 적은 것은 하나도 없다. 대조표는 [부록 A](#부록-a--인용-대조표)에
전부 있다. 이 리포는 크로스파일 인용이 다섯 번 낡았고(#274·#276, #299, #300·#302, #306, #309),
이 문서는 후속 판단의 입력이 되므로 틀린 인용이 그대로 전파된다.

**SQLite 판정은 추정이 아니라 실측이다.** 이 리포가 실제로 링크하는 엔진
(`sqlite_version() = 3.53.2`, `better-sqlite3 12.11.1`) 위에서 DDL을 실행해 얻은 결과이며,
스크립트와 원문 출력은 [부록 B](#부록-b--sqlite-실측)에 있다.

## 필수 질문 → 절 매핑

| 질문                                 | 절                                           | 한 줄 답                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 후보2가 오늘도 막는 것이 있는가   | [Q1](#q1--후보2가-오늘도-막는-것이-있는가)   | **없다.** `memory.consolidated`를 찍는 프로덕션 자리는 **2곳뿐이고 둘 다 CAS를 싣는다.** CAS가 못 덮는 잔여(R1)가 하나 남지만 **후보2의 인덱스도 그것을 못 덮는다**                                              |
| Q2 후보2를 인덱스로 표현할 수 있는가 | [Q2](#q2--후보2를-인덱스로-표현할-수-있는가) | **DDL은 만들어지지만 후보2를 표현하지 못한다.** 창의 정체성(워터마크·오프셋)은 `events`에 없고 `meta`에 있다. 로그에 있는 유일한 대용값 `sourceObservationIds`는 **정상 경계 하나가 여러 행에 같은 값을 찍는다** |
| Q3 후보3(import 정규화 텍스트)       | [Q3](#q3--후보3import-정규화-텍스트)         | **같은 `(kind, 정규화 텍스트)`가 합법적으로 두 번 들어오는 경로가 3개 있다.** 정규화 텍스트는 저장값이 아니라 매번 계산되는 값이고, SQL로 재현하면 JS와 **결과가 갈린다**(실측)                                  |
| Q4 마이그레이션 호환                 | [Q4](#q4--마이그레이션-호환)                 | 후보2·3 **둘 다** 기존 스토어에 위반 데이터가 있을 수 있고, 그 위반이 **정상 운영에서 생긴다.** #236 선례(prescan → 진단 throw → additive index)는 형태는 그대로 쓸 수 있으나 **진단이 가리킬 잘못이 없다**      |
| Q5 권고                              | [Q5](#q5--권고)                              | **후보2 넣지 않는다 · 후보3 넣지 않는다.** 둘 다 근거를 코드 옆에 남길 필요가 있다                                                                                                                               |
| Q6 조각 나누기                       | [Q6](#q6--조각-나누기)                       | **인덱스 조각 0개.** Q5가 §Q6으로 넘긴 트리거 문장 조각 2개만 남는다 (둘 다 ★ 아님)                                                                                                                              |

**B 축의 결론 한 줄**: 후보2·3은 **넣을 것이 아니다.** 후보2는 막을 것이 남지 않았고
(§Q1), 남았더라도 로그가 그 창을 표현하지 못한다(§Q2). 후보3은 제약 자체가 틀렸다 —
같은 `(kind, 정규화 텍스트)`의 재입력은 오늘 **의도된 동작**이다(§Q3). §Q6의 두 조각이
머지되면 #189의 B 축에 남는 인덱스 작업은 0건이 된다.

## 0. 무엇을 후보2·3라고 부르는가

#189 본문이 B 축의 유니크 제약 후보 셋을 이렇게 적었다.

- 후보1 — `project.created` 스토어당 1회 → **#236이 닫음** (`db.ts:882-888`, v18)
- 후보2 — **증류 창(워터마크 이벤트 id + boundary): 이중 증류의 두 번째가 커밋에 실패한다**
- 후보3 — **import 메모리 `(kind, 정규화 텍스트)`: 중복 대신 제약 위반**

두 후보의 공통 전제는 하나다: **CAS(`expectedHead`)는 호출자가 규율을 지킬 때만 듣고,
유니크 제약은 아무것도 의존하지 않는다.** 그 전제는 지금도 그대로다 — 락은 임계구역 실행
중에 빼앗길 수 있고(`project-lock.ts:555`의 `ProjectLockCompromisedError`),
`withProjectLock`은 빼앗긴 뒤에도 `fn`을 **끝까지 돌린 뒤 보고만 한다**
(`project-lock.ts:760`에서 시작해 `project-lock.ts:826`에서 비로소 던진다).

그래서 이 산정이 답해야 하는 것은 "제약이 CAS보다 강한가"(그렇다)가 아니라
**"그 강함이 오늘 이 두 자리에서 살 곳이 있는가"**다. 아래 셋을 후보별로 차례로 본다.

1. **막을 것이 남아 있는가** (§Q1 / §Q3 앞부분)
2. **로그가 그것을 표현할 수 있는가** (§Q2 / §Q3 뒷부분)
3. **기존 스토어에 넣을 수 있는가** (§Q4 — 사람 결정이 B에 단 착수 조건)

셋 중 하나라도 아니면 그 후보는 넣지 않는 것이 결론이다.

## Q1 — 후보2가 오늘도 막는 것이 있는가

### 판정: **없다.**

정확히는 — **CAS가 못 막는 이중 증류가 하나(R1) 남아 있지만, 후보2의 인덱스도 그것을
막지 못한다.** 후보2가 막을 수 있는 것과 CAS가 이미 막는 것의 차집합이 비어 있다는 뜻이며,
"이중 증류가 완전히 사라졌다"는 뜻이 **아니다**. 두 문장의 구별이 이 절의 전부다.

### Q1.0 대상 집합 — `memory.consolidated`를 찍는 자리

후보2가 걸릴 이벤트 타입은 `memory.consolidated` 하나다. 프로덕션에서 그것을 찍는
자리를 전수 조사한다.

```
$ grep -rnE "\bappendEvents?[[:space:]]*(<[^()]*>)?\(" packages/ --include='*.ts' \
    --exclude-dir=dist --exclude-dir=node_modules | grep -v tests/
packages/kernel/src/kernel/sqlite-memory-kernel.ts:613
packages/kernel/src/kernel/sqlite-memory-kernel.ts:878
packages/kernel/src/services/consolidate-service.ts:2693
packages/kernel/src/services/memory-import-service.ts:810
packages/kernel/src/services/capture-service.ts:293
packages/kernel/src/services/conflict-service.ts:97
packages/kernel/src/services/contradiction-service.ts:287
```

(`conflict-service.ts:67`은 주석 안의 `appendEvents` 언급이라 호출부가 아니다. `event-store.ts`
자신은 정의 파일이므로 제외했다. 프로덕션 호출부 **7건** — #301 §Q1이 센 것과 같은 수다.)

**이 census가 로그 라이터 전부인지부터 확인했다** — `appendEvents`를 거치지 않고 테이블에
직접 쓰는 경로가 있으면 위 표는 0건 통과(false-green)가 된다.

```
$ grep -rn "INSERT INTO events" packages --include='*.ts' | grep -v tests/
packages/kernel/src/storage/db.ts:420          # v5 create-copy-swap의 events_new 복사
packages/kernel/src/storage/event-store.ts:173 # appendEvents 자신
```

프로덕션에서 `events`에 INSERT하는 자리는 **`appendEvents` 하나뿐**이고, 나머지 하나는
마이그레이션의 테이블 재구축이다. 따라서 위 표는 로그에 이벤트를 찍는 경로 전부를 덮는다.

| #   | 호출부                             | 찍는 타입                                         | `expectedHead`                     | 후보2 대상인가 |
| --- | ---------------------------------- | ------------------------------------------------- | ---------------------------------- | -------------- |
| 1   | `sqlite-memory-kernel.ts:613`      | `memory.injected`                                 | 없음                               | 아니다         |
| 2   | `sqlite-memory-kernel.ts:878`      | `project.created`                                 | 없음 (v18 인덱스가 덮는다 — 후보1) | 아니다         |
| 3   | `capture-service.ts:293`           | `observation.captured`                            | 없음                               | 아니다         |
| 4   | `conflict-service.ts:97`           | `conflict.resolved`                               | 없음 (#305가 트리거 문장을 남김)   | 아니다         |
| 5   | `contradiction-service.ts:287`     | `memory.superseded` + `conflict.detected`         | **있음**                           | 아니다         |
| 6   | **`consolidate-service.ts:2693`**  | **`memory.consolidated`** (+ `memory.superseded`) | **있음**                           | **그렇다**     |
| 7   | **`memory-import-service.ts:810`** | **`memory.consolidated`** (+ `memory.superseded`) | **있음**                           | **그렇다**     |

**`memory.consolidated`를 찍는 프로덕션 자리는 6·7 둘뿐이고, 둘 다 CAS를 싣는다.**
"`expectedHead`를 안 싣는 호출자가 새로 생기는 경우"는 오늘 0건이다 — 그리고 그 위험은
후보2가 아니라 #305가 `resolveConflict`에 남긴 트리거 문장이 이미 다루는 축이다.

### Q1.1 6번(`consolidate-service`)에서 CAS가 덮는 것

`run()`의 순서 불변식이 그것을 정한다. 실물 순서:

| 줄                                 | 무엇                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `consolidate-service.ts:2211`      | `getConsolidateWatermark` — **meta 커서**를 읽는다 (로그가 아니다)          |
| `consolidate-service.ts:2238-2239` | `probeBoundaryStart` → **`expectedHead` 스탬프**. 로그의 첫 접촉            |
| `consolidate-service.ts:2331`      | `readEvents` — 창·`consumed`·`existing`이 전부 여기서 나온다 (#298)         |
| `consolidate-service.ts:2380`      | `consumed` — `memory.consolidated` 페이로드의 `sourceObservationIds` 합집합 |
| `consolidate-service.ts:2428`      | `existing` — `!invalidAt && self-lane`                                      |
| `consolidate-service.ts:2536`      | `sourceObservationIds = bounded.observations.map((o) => o.id)`              |
| `consolidate-service.ts:2693`      | `appendEvents(..., { expectedHead })` — **CAS**                             |
| `consolidate-service.ts:2920`      | `commitBoundaryCursors` — 워터마크·오프셋 커밋 (append **뒤**)              |

세 시나리오를 각각 본다. **누가 먼저 읽고 누가 나중에 쓰는지**를 명시한다.

**(a) 락 강탈 — 훔친 쪽이 먼저 읽는 경우.** A가 락을 잡고 `:2239`에서 `H0`을 스탬프한다.
B가 락을 강탈하고 역시 `H0`을 읽는다(로그가 아직 안 움직였다). 둘 다 같은 창을 증류한다.
A가 먼저 `:2693`에 도달해 append → head가 `H1`. B가 `:2693`에 도달하면 CAS가 `H0 ≠ H1`을
보고 `StaleHeadError`(`event-store.ts:322`)를 던진다. **B의 두 번째 증류는 커밋되지 않는다.**
이것이 후보2가 하려던 바로 그 일이고, CAS가 이미 한다.

**(b) 락 강탈 — 훔친 쪽이 나중에 읽는 경우.** A가 `H0`을 스탬프하고 LLM 추출(수십 초)에
들어간다. B가 락을 강탈하고 `H0`을 스탬프한 뒤 증류해 append → `H1`. A가 추출에서 돌아와
`:2693`에 도달하면 CAS가 `H0 ≠ H1`을 보고 던진다. **먼저 읽은 쪽이 나중에 쓰면 그쪽이
물러난다.** `throwIfDispossessed`(④)는 A가 자기 박탈 신호를 받은 뒤에야 울리고 최대
하트비트 하나만큼 늦지만, CAS는 신호와 무관하게 이 자리에서 듣는다.

**(c) 홀더 크래시 — 커서 커밋 전.** A가 `:2693`에서 append에 성공(`H0 → H1`)한 뒤
`:2920`의 `commitBoundaryCursors`에 닿기 전에 죽는다. **워터마크도 오프셋도 안 움직였다.**
B가 새로 시작한다. B는 `:2238`에서 `H1`을 스탬프하므로 **B의 CAS는 통과한다** — 로그가
B의 스탬프 이후로 안 움직였고, 그게 CAS가 말하는 전부이기 때문이다.

- **관찰 축**: B의 `:2331` `readEvents`가 A의 `memory.consolidated`를 포함하므로
  `:2380`의 `consumed`가 A가 소비한 관찰 id를 전부 담는다 → `:2387`의 필터가 그것들을
  창에서 뺀다. **로그 파생 필터가 흡수한다.** (후보2가 아니라 `consumed`가 하는 일이다.)
- **대화 축**: 대화 오프셋은 `meta`에 있고(`consolidate-service.ts:1286`의
  `cls_conversation_offset:<sourceId>`) A의 크래시로 안 움직였다. B는 **같은 대화 슬라이스를
  다시 읽어 다시 증류한다.** 세그먼트 id는 주조되고(`createId("seg")`) 오프셋 커서는
  단조 증가만 하므로 흡수하는 것이 없다. `:2428`의 `existing`에 A의 메모리가 실려
  추출기에게 보이긴 하지만, 그것을 supersede로 접는 것은 **추출기의 재량**이지 코드가 거는
  판정이 아니다.

**이 (c)의 대화 축이 CAS가 덮지 않는 잔여다 — 이 문서는 이것을 R1이라 부른다.**
코드 자신이 그 갈림을 `:2653-2680` 주석에 이미 적어 뒀다 (대화 슬라이스는 로그에서 파생될
수 없고 downstream에 흡수자가 없다). #103이 세그먼트 중복은 "bounded and self-healing"으로
받아들였지만, **거기서 같이 생기는 메모리 중복은 그 문장이 다루지 않는다.**

### Q1.2 7번(`memory-import-service`)에서 CAS가 덮는 것

`memory-import-service.ts:627`의 `readValidMemoriesFromLog`가 **dedup 스냅샷과 그 스냅샷을
증명하는 head를 한 배열에서** 뽑고(`memory-import-service.ts:210-230`), `:810`이 그 head로
CAS를 건다. import는 **크로스프로세스 락을 아예 안 잡는다** — 모듈 doc이 그렇게 적었고,
`:803-809` 주석이 "이것이 동시 라이터와 중복 import 사이에 서 있는 유일한 것"이라고
스스로 말한다. 즉 여기서 CAS는 규율이 아니라 **유일한 수단**이고, 그만큼 확실히 실려 있다.

import 쪽의 이중 기록은 후보2가 아니라 **후보3의 영역**이다(§Q3). 여기서 후보2에 관해
중요한 사실은 하나다: **import도 `memory.consolidated`를 찍고, 그 페이로드의
`sourceObservationIds`는 항상 비어 있다** (`memory-import-service.ts:630-632` 주석:
_"imported memories have EMPTY sourceObservationIds"_). 이 사실이 §Q2에서 후보2를 죽인다.

### Q1.3 후보2의 인덱스가 R1을 덮는가 — 덮지 못한다

R1이 남았으므로, 후보2가 **그것을** 막는다면 "막는 것이 있다"가 답이 된다. 막지 못한다.

후보2가 걸 수 있는 유일한 로그 파생 키는 `payload.$.sourceObservationIds`다(§Q2가 왜
그것뿐인지 보인다). R1의 두 증류에 그 값이 어떻게 실리는지 따라가면:

- **혼합 경계(관찰 + 대화)에서**: A의 경계는 관찰 `{o1, o2}`를 소비했으므로
  A가 찍는 행의 키는 `["o1","o2"]`. B는 `:2380`의 `consumed`가 `o1`·`o2`를 이미 뺐으므로
  `observations`가 비고, `:2536`의 `bounded.observations.map(...)`은 **`[]`**를 낸다.
  → **두 키가 다르다. 인덱스가 울리지 않는다.** R1은 그대로 통과한다.
- **대화 전용 경계에서**: A도 B도 키가 `[]`라 충돌한다 — 즉 인덱스가 두 번째를 막긴 한다.
  그러나 같은 이유로 **정상적인 두 번째 대화 전용 경계도, 모든 import도** 막는다(§Q2, 실측 D).
  막는 것이 아니라 그 자리를 아예 못 쓰게 만드는 것이다.

**혼합 경계에서 못 막고, 대화 전용 경계에서는 정상 동작까지 같이 막는다.** 후보2가 R1에
대해 내놓는 것은 "덮음"이 아니라 "빗나감 또는 오작동"이다.

### Q1.4 이 결론을 떠받치는 것 — 그리고 떠받치지 않는 것

이슈 본문이 요구한 구별(PR #299 리뷰가 만든 것)을 그대로 적는다.

**CAS 통과는 _"내가 head를 찍은 뒤 로그가 안 움직였다"_ 만 말한다. _"프로젝션이 신선하다"_ 는
말하지 않는다.** 그래서 "후보2는 넣지 않는다"를 떠받치는 것은 CAS **단독**이 아니라 셋이다.

| 무엇이 떠받치는가                           | 무엇을 말하는가                                    | 근거                                            |
| ------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| **CAS** (`:2239` 스탬프 → `:2693` 비교)     | head 스탬프 이후 로그가 안 움직였다                | `event-store.ts:273`·`:322`                     |
| **#298의 결속** (`:2331` 단일 `readEvents`) | 판정 근거가 **로그 파생**이라 CAS의 스팬 안에 있다 | `consolidate-service.ts:2331`, `:2380`, `:2428` |
| **`consumed` 필터** (`:2380-2388`)          | 커서가 뒤처져도 이미 증류된 관찰은 창에서 빠진다   | `consolidate-service.ts:2380`                   |

**후보2의 근거가 로그 파생인지부터 판정한다** — 이슈가 지목한 질문이다. 답: **관찰 축은
로그 파생이고(그래서 CAS+`consumed`가 덮는다), 대화 축은 로그 파생이 아니다**
(오프셋이 `meta`에 있고 세그먼트 id가 주조된다). 그리고 **로그 파생이 아닌 바로 그 축이
유니크 제약으로도 표현되지 않는다** — 제약은 로그 안의 값만 볼 수 있기 때문이다.
후보2가 노린 축과 후보2가 도달할 수 있는 축이 어긋나 있다는 것이 이 절의 결론이다.

## Q2 — 후보2를 인덱스로 표현할 수 있는가

### 판정: **DDL은 만들어진다. 그러나 후보2를 표현하지는 못한다.**

### Q2.1 창의 정체성은 `events`의 컬럼인가 — 아니다

`events` 테이블의 오늘 컬럼을 실물 마이그레이션에서 조립한다.

- v1 최초 DDL: `db.ts:295` — `seq, id, schema_version, created_at, updated_at, type,
project_id, scope_type, scope_id, actor, payload`
- v5 create-copy-swap(`schema_version`을 INTEGER→TEXT): `db.ts:407` — 컬럼 집합은 동일
- v11 additive: `db.ts:541-542` — `ALTER TABLE events ADD COLUMN writer TEXT;` /
  `ADD COLUMN source_project_id TEXT;`

`MIGRATIONS` 배열(`db.ts:291`)에서 `events`를 건드리는 항목은 이 셋과 v18 인덱스
(`db.ts:882-888`)가 전부다. 따라서 **오늘 `events`의 컬럼은 13개**이고, 그중
**워터마크도 boundary도 대화 오프셋도 없다.**

그 값들이 실제로 사는 곳:

| 값                       | 사는 곳                                                    | 근거                                                    |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| 증류 워터마크(이벤트 id) | **`meta` 테이블**, 키 `cls_consolidate_watermark`          | `consolidate-service.ts:90`, 접근자 `:1261`/`:1273`     |
| 대화 오프셋              | **`meta` 테이블**, 키 `cls_conversation_offset:<sourceId>` | `consolidate-service.ts:1286`                           |
| boundary 식별자          | **없다** — 경계는 이벤트로 기록되지 않는다                 | `consolidate-service.ts:2693`이 찍는 것은 결과 메모리뿐 |

`:2205-2216`의 주석이 이것을 설계 의도로 못박아 뒀다: _"the watermark stays a `meta` cursor
and is NOT bound to the log. The log cannot express it"_ — noop 경로가 커서를 로그에 흔적
없이 건너뛰고(`:2405`), gc 복구는 커서를 **뒤로** 옮겨야 하기 때문이다(`:1273`
`setConsolidateWatermark`).

**결론: 후보2가 #189에서 이름 붙인 정체성(_워터마크 이벤트 id + boundary_)은 로그에 없다.**
유니크 제약은 로그 안의 값만 볼 수 있으므로, 그 정체성으로는 인덱스를 만들 수 없다.
남는 것은 대용값 하나 — `payload` JSON 안의 `sourceObservationIds`
(`domain/entities/memory.ts:101`, 채워지는 자리는 `consolidate-service.ts:2536`)뿐이다.

### Q2.2 `payload` JSON에 partial unique index를 걸 수 있는가 — 걸린다 (실측)

SQLite는 index expression에 deterministic 함수만 허용하고, `json_extract`는
`SQLITE_DETERMINISTIC`으로 등록된 함수다. **추정하지 않고 실물 엔진에서 실행했다**
(부록 B, 항목 A·B):

```sql
CREATE UNIQUE INDEX ix1
  ON events(project_id, json_extract(payload,'$.sourceObservationIds'))
  WHERE type = 'memory.consolidated';
```

→ `A json_extract expression unique index: CREATED`
→ 같은 값의 두 번째 INSERT: `B identical REJECTED: UNIQUE constraint failed: index 'ix1'`

**DDL은 만들어지고 실제로 강제된다.** 여기까지는 후보2에 유리한 답이다. 문제는 다음이다.

### Q2.3 그 인덱스가 표현하는 것이 후보2인가 — 아니다

실측 네 건이 각각 하나씩 무너뜨린다.

**① 정상 경계 하나가 같은 키로 여러 행을 찍는다 — 치명적.**
`:2540-2562`의 루프는 추출된 메모리 **항목마다** `memory.consolidated`를 하나씩 만들고,
전부 `:2536`에서 한 번 계산한 **같은 `sourceObservationIds` 배열**을 싣는다. 즉 메모리를
2개 이상 뽑아낸 평범한 경계는 이 인덱스 아래에서 두 번째 행부터 실패한다(실측 B가 그
형태 그대로다). **이 인덱스는 이중 증류가 아니라 다중 메모리 경계를 막는다.**

**② 빈 배열이 전부 충돌한다.**
import는 `sourceObservationIds`를 항상 비워 찍고(`memory-import-service.ts:630-632`),
대화 전용 경계도 `:2536`에서 `[]`를 낸다. 실측 D: 두 번째 `[]` 행이
`UNIQUE constraint failed`. → **모든 두 번째 import, 모든 두 번째 대화 전용 경계가
스토어에 못 들어간다.**

**③ 집합이 아니라 배열 텍스트라 순서에 민감하다.**
실측 C: `["o1","o2"]`와 `["o2","o1"]`이 **서로 다른 키로 통과**한다. 창은 집합인데 키는
직렬화 문자열이므로, 후보2가 막고 싶은 "같은 창"조차 순서가 다르면 놓친다.

**④ 키가 없는 행은 NULL이 되어 인덱스가 조용히 비껴간다.**
실측 E: `sourceObservationIds`가 없는 페이로드 두 개가 **둘 다 통과**한다 — 유니크 인덱스에서
NULL은 서로 구별되기 때문이다. 레거시 행이나 스키마가 다른 행에는 제약이 사실상 없다.

**종합**: partial expression unique index는 **문법적으로 가능하고 의미적으로 틀렸다.**
정상 동작을 막고(①②), 막아야 할 것을 놓친다(③④). 이슈가 말한 대로 _"제약을 못 거는 사실은
결론이지 실패가 아니다"_ — 여기서는 한 걸음 더 나아가, **걸 수는 있는데 걸면 안 된다.**

## Q3 — 후보3(import 정규화 텍스트)

### 판정: **제약 자체가 틀렸다.** 합법적 이중 입력 경로가 셋 있다.

이슈가 지시한 대로 **이 질문을 먼저 닫는다.**

### Q3.1 같은 `(kind, 정규화 텍스트)`가 합법적으로 두 번 들어오는 경로 — 3개

오늘 import의 dedup은 `runImport` 안에서 돈다:
`memory-import-service.ts:627`이 `readValidMemoriesFromLog`로 스냅샷을 잡고,
`:641`이 그 스냅샷을, `:658`이 입력 항목을 각각 `textKey`(`:181`)로 눌러 비교한다.
스냅샷의 필터는 `memory-import-service.ts:222`다:

```ts
(memory) => !memory.invalidAt && (memory.sourceProjectId ?? SELF_LANE) === SELF_LANE,
```

이 **두 조건이 곧 세 개의 합법 경로**다.

**경로 1 — supersede/invalidate 뒤의 재입력 (`!invalidAt`).**
메모리가 `memory.superseded`로 무효화되면 `invalidAt`이 서고, 스냅샷에서 빠진다. 그러면
같은 `(kind, 텍스트)`의 새 import가 **접히지 않고 새 메모리로 들어온다 — 의도된 동작이다.**
`:631-633` 주석이 dedup의 목적을 _"Skip items whose kind+normalized text already exists as a
**valid** memory"_ 로 적었다. 그런데 이벤트 로그는 append-only라 무효화된 메모리의
`memory.consolidated` 행이 **그대로 남아 있다.** 로그 위의 유니크 인덱스는 그 남은 행과
새 행을 충돌로 보고 **정상 재입력을 실패시킨다.**

**경로 2 — foreign lane (`sourceProjectId === SELF_LANE`).**
워크스페이스 union에서 동기화된 형제 프로젝트의 메모리는 로컬 진실이 아니므로(SoT-040)
로컬 import를 침묵시키지 않는다 — `:222`가 그렇게 적혀 있고 `consolidate-service.ts:2428`이
같은 필터를 쓴다. 즉 **같은 텍스트가 self 레인과 foreign 레인에 하나씩 있는 것이 정상이다.**
`events(project_id, kind, text)` 인덱스는 두 레인을 구별하지 않으므로 이것을 충돌로 본다.
`WHERE source_project_id IS NULL`로 도려낼 수는 있으나, 그러면 §Q2 ④와 같은 NULL 문제
(v11 이전 행은 `source_project_id`가 NULL이라 self로 읽힌다)를 다시 안게 된다.

**경로 3 — 증류와 import의 교차.**
`consolidate-service.ts:2693`이 찍는 `memory.consolidated`는 `textKey`를 **전혀 거치지
않는다.** 증류 경로에 텍스트 dedup은 없다. 그래서 추출기가 뽑은 메모리와 사람이 import한
메모리가 같은 `(kind, 텍스트)`를 갖는 것은 오늘 흔하고 합법이다. 후보3의 인덱스는
`type = 'memory.consolidated'` 위에 걸릴 수밖에 없으므로(두 경로가 같은 타입을 쓴다)
**증류 결과와 import를 서로 충돌시킨다.**

**이 절이 이슈의 완료 조건 하나를 그 자체로 닫는다**: 위반이 정상 운영에서 생기므로,
이슈 본문의 규칙("위반 데이터가 정상 운영에서 생길 수 있는 것이면 그 후보는 제약이 아니라
다른 수단이 맞다")에 따라 후보3은 **여기서 이미 끝난다.** 아래 Q3.2는 설령 이 세 경로를
전부 도려낸다 해도 남는 두 번째 문제다.

### Q3.2 "정규화 텍스트"는 저장값인가 — 아니다, 매번 계산된다

`memory-import-service.ts:181`:

```ts
function textKey(kind: string, text: string): string {
  return `${kind}\n${text.trim().toLowerCase()}`;
}
```

**JS 함수다. 어디에도 저장되지 않는다.** `MemoryRecord`에 정규화 텍스트 필드가 없고
(`domain/entities/memory.ts`), `events.payload`에도 원문 `text`만 실린다. 제약을 걸려면
둘 중 하나가 필요하다.

**(가) 저장 컬럼을 추가한다.** `ALTER TABLE events ADD COLUMN normalized_text TEXT` +
기존 행 백필. 비용 두 가지가 붙는다 — ① 백필은 별도 마이그레이션 항목이어야 하고
(v15/v16이 그 형태다), ② **파생 정규화 값을 append-only 로그 테이블에 써 넣는 것**이라
"이벤트는 쓴 뒤에 안 바뀐다"는 성질을 침범한다. 게다가 정규화 규칙이 바뀌면
(`trim`/`toLowerCase` 말고 NFC 정규화를 추가한다든지) 컬럼과 코드가 갈라지고, 갈라진 순간
**인덱스는 옛 규칙을 강제한다.**

**(나) expression index로 SQL에서 재현한다.** 만들어지긴 한다 (실측 F):

```sql
CREATE UNIQUE INDEX ix3
  ON events(project_id, json_extract(payload,'$.kind'),
            lower(trim(json_extract(payload,'$.text'))))
  WHERE type = 'memory.consolidated';
```

그러나 **SQL의 `lower`/`trim`은 JS의 `toLowerCase`/`trim`과 같은 함수가 아니다.**
같은 엔진에서 실측했다 (부록 B, 항목 F·G):

| 입력                                     | JS                          | SQLite                                                 | 일치           |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------ | -------------- |
| `'  Use Postgres  '` vs `'use postgres'` | 같은 키                     | 같은 키 (실측 G: REJECTED)                             | ✔ ASCII는 일치 |
| `'ECOLÉ'` vs `'ecolé'`                   | `toLowerCase` 결과 **같다** | `lower()` 결과 **다르다** (`lower('ECOLÉ') = 'ecolÉ'`) | ✘              |
| `'  a\tb\n'`                             | `trim()` → `'a\tb'`         | `trim()` → `'a\tb\n'` (공백만 제거)                    | ✘              |

SQLite의 내장 `lower`는 **ASCII 전용**이고(ICU 확장 없이는 비-ASCII를 건드리지 않는다),
`trim(X)`은 **스페이스만** 제거한다. 반면 JS `toLowerCase`는 유니코드 전체를,
`String.prototype.trim`은 모든 유니코드 공백을 다룬다. 결과: expression index의 키는
`textKey`보다 **성기다** — 애플리케이션 가드가 접는 중복 중 비-ASCII·탭/개행이 섞인 것들을
인덱스는 서로 다른 것으로 본다. 즉 **가드와 제약이 서로 다른 두 규칙이 되고, 제약 쪽이
약하다.** #189가 제약에 기대한 성질("아무것도 의존하지 않는다")이 여기서는 성립하지 않는다 —
제약은 SQLite 빌드의 문자 처리에 의존한다.

### Q3.3 오늘 dedup과 #253 CAS의 맞물림

후보3을 넣지 않을 때 무엇이 남는지 적어 둔다. `readValidMemoriesFromLog`
(`memory-import-service.ts:210`)는 스냅샷과 head를 **한 `readEvents` 배열에서** 뽑고
(`:224-229` 주석: _"the head OF THIS VERY READ"_), `:810`이 그 head로 CAS를 건다.
그래서 "가드가 본 로그"와 "append가 검사하는 로그"가 같은 것이 **구조적으로** 보장된다 —
후보3이 채우려던 자리를 #253이 이미 이 형태로 메웠다.

여기에 `importMemories`(`:232`)의 유계 재시도가 붙어, CAS 거절이 오면 아무것도 쓰이지 않은
상태에서 스냅샷을 다시 떠 재시도한다(`:240-270`). **import에는 크로스프로세스 락이 없고,
이 조합이 그 자리를 대신한다.** 후보3의 제약을 넣지 않아도 import의 이중 기록을 막는 것은
이 조합이며, 그것이 §Q1의 6·7번 판정과 같은 근거다.

## Q4 — 마이그레이션 호환

사람 결정이 B에 단 착수 조건이다: _"B는 마이그레이션 호환 검증(기존 데이터 중복 검사 포함)이
착수 조건"_. **권고가 "넣지 않는다"로 났더라도(§Q5) 이 검증을 건너뛰지 않는다** — 착수 조건은
"권고하면 검증하라"가 아니라 "검증하고 판단하라"였고, 검증 결과 자체가 §Q5의 근거이기 때문이다.
후보2·3 각각을 본다.

### Q4.0 #236이 세운 선례

v18(`db.ts:882-888`)의 세 단계를 그대로 옮겨 적는다.

1. **prescan** — `findDuplicateGenesis`(`db.ts:243`)가 `SELECT`만으로 위반 identity를 센다
2. **진단 throw** — `duplicateGenesisError`(`db.ts:261`)가 무엇이 몇 개인지, 아무것도
   지우지 않았음을, 판단이 사람 몫임을 말한다. 던지면 `runMigrations`(`db.ts:892`)의
   트랜잭션이 사다리 전체를 되감고 **스토어는 열리지 않는다**
3. **additive partial index** — `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_genesis_once
ON events(project_id) WHERE type = 'project.created'` (`db.ts:886-887`).
   v5/v17의 create-copy-swap이 아니라 있는 그대로의 테이블에 인덱스만 붙인다

doc가 적어 둔 두 문장이 이 선례의 핵심이다 — _"deleting or rewriting the offending rows is
deliberately not done here"_, _"Additive index only, no table rebuild (unlike v5/v17's
create-copy-swap)"_.

### Q4.1 후보2 — 위반 데이터가 **거의 모든 스토어에** 이미 있다

`CREATE UNIQUE INDEX`는 기존 행 위에서 만들어지므로, 위반 행이 있으면 인덱스 생성 자체가
실패한다. 실측 H가 그 형태다: `[]` 키를 가진 행 둘이 있는 테이블에 인덱스를 만들면
`UNIQUE constraint failed: index 'ixz'`.

문제는 그 위반이 **드문 사고가 아니라 정상 상태**라는 점이다.

- import를 두 번 이상 한 스토어: `sourceObservationIds = []` 행이 둘 이상 (§Q1.2)
- 대화 전용 경계를 두 번 이상 돈 스토어: 같은 이유
- 한 경계에서 메모리를 둘 이상 뽑은 스토어: 같은 `["o1","o2"]` 행이 둘 이상 (§Q2.3 ①)

셋 중 아무것에도 해당하지 않는 스토어는 사실상 없다. **마이그레이션은 거의 모든 실제
스토어에서 실패하고, 그 스토어들은 열리지 않는다.**

- **#236 선례를 형태로는 쓸 수 있다** — prescan SQL이 그대로 성립한다(실측 I:
  `GROUP BY project_id, json_extract(...) HAVING COUNT(*)>1`이 위반 그룹을 정확히 낸다).
- **그러나 진단이 가리킬 잘못이 없다.** v18의 진단은 "이 스토어에 중복 genesis가 있으니
  사람이 판단하라"는 실제 이상 징후를 보고한다. 후보2의 진단은 **정상적으로 만들어진 데이터**를
  이상으로 보고하게 된다. 사용자에게 "당신의 정상 스토어가 새 제약을 만족하지 않으니 열 수
  없다"고 말하는 마이그레이션이다.
- **additive인가 create-copy-swap인가**: DDL 형태로는 **additive**(인덱스만 붙인다,
  테이블 재구축 없음). 그러나 위 이유로 형태 판정이 의미를 갖지 못한다 — additive든
  아니든 통과하지 못한다.

**후보2에 대한 Q4 판정: 넣을 수 없다.** 이슈 본문의 규칙("위반 데이터가 정상 운영에서 생길 수
있는 것이면 그 후보는 제약이 아니라 다른 수단이 맞다")에 정면으로 해당한다.

### Q4.2 후보3 — 위반이 정상 운영에서 생긴다

§Q3.1의 세 경로가 그대로 기존 데이터의 위반이 된다.

- **경로 1**(supersede 뒤 재입력): 로그에 무효화된 원본과 새 메모리가 같은 텍스트로 남아
  있다. append-only이므로 **과거 행이 지워지지 않고 계속 위반으로 남는다**
- **경로 2**(foreign lane): union 스토어라면 형제의 같은 텍스트 메모리가 이미 들어와 있다
- **경로 3**(증류 × import): 추출기가 뽑은 문장과 import한 문장이 겹친 스토어

- **#236 선례 적용 가능성**: prescan은 쓸 수 있다(같은 `GROUP BY … HAVING COUNT(*)>1` 형태).
  그러나 후보2와 같은 이유로 **진단이 정상 데이터를 이상으로 보고한다.**
- **additive인가 create-copy-swap인가**: **선택지에 따라 갈린다.**
  - Q3.2 (나) expression index 경로 → **additive** (`CREATE UNIQUE INDEX` 한 줄)
  - Q3.2 (가) 저장 컬럼 경로 → **additive column + 별도 백필 마이그레이션**.
    `ALTER TABLE events ADD COLUMN`은 v11이 이미 한 형태라 create-copy-swap은 필요 없다.
    다만 백필이 **append-only 로그 테이블의 기존 행을 UPDATE한다**는 점에서 v15/v16의
    프로젝션 백필과 성격이 다르다 — 그쪽은 파생 테이블을 고쳤고, 이쪽은 원장을 고친다

**후보3에 대한 Q4 판정: 넣을 수 없다.** 위반이 정상 운영의 산물이므로 제약이 아니라 다른
수단(오늘의 `textKey` 가드 + #253 CAS)이 맞다.

### Q4.3 두 후보에 공통인 관찰 — 이 표는 후보1과 무엇이 달랐나

|                             | 후보1 (v18, 머지됨)                        | 후보2                                  | 후보3                                 |
| --------------------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------- |
| 키가 로그 컬럼인가          | **예** (`project_id`, `type`)              | 아니오 (`payload` JSON, 그나마 대용값) | 아니오 (`payload` JSON + 정규화 필요) |
| 정상 운영에서 위반이 생기나 | **아니오** (genesis는 스토어당 1회가 정의) | **예** (다중 메모리 경계, 반복 import) | **예** (supersede 후 재입력 등 3경로) |
| prescan이 가리키는 것       | 실제 이상 상태                             | 정상 데이터                            | 정상 데이터                           |
| additive로 끝나나           | 예                                         | 예(형태만)                             | 예 / 예+백필                          |

**후보1이 통과한 이유는 인덱스가 additive였기 때문이 아니라 _제약이 도메인 규칙과 같았기
때문_이다.** "스토어당 genesis 1회"는 원래 참인 명제이고, 인덱스는 그것을 기계가 강제하게
만들었을 뿐이다. 후보2·3에는 그런 참인 명제가 없다 — "창당 증류 1회"는 참이지만 로그가 창을
표현하지 못하고(§Q2), "(kind, 텍스트)당 메모리 1개"는 **아예 참이 아니다**(§Q3.1).

## Q5 — 권고

### 후보2 — **넣지 않는다**

세 근거가 각각 독립적으로 충분하다.

1. **막을 것이 남지 않았다** (§Q1). `memory.consolidated`를 찍는 프로덕션 자리 2곳이 모두
   CAS를 싣고, 락 강탈 두 방향(§Q1.1 a·b)이 CAS로 닫힌다. 크래시 잔여 R1(§Q1.1 c)은
   남지만 **후보2가 그것을 못 덮는다**(§Q1.3).
2. **로그가 창을 표현하지 못한다** (§Q2.1). 워터마크·오프셋은 설계상 `meta`에 있고,
   `:2205-2216`이 그것을 의도로 적어 뒀다.
3. **대용값으로 만든 인덱스는 정상 동작을 막는다** (§Q2.3 ①②, 실측 B·D).

### 후보3 — **넣지 않는다**

1. **제약이 도메인적으로 틀렸다** (§Q3.1). 같은 `(kind, 정규화 텍스트)`의 재입력이
   합법인 경로가 셋이고, 그중 경로 1은 dedup 가드가 **의도적으로 허용하는** 동작이다.
2. **정규화 텍스트가 저장값이 아니고**, SQL로 재현하면 JS와 결과가 갈린다 (§Q3.2, 실측 F·G).
3. **오늘 그 자리는 비어 있지 않다** (§Q3.3). #253의 단일-배열 스냅샷+CAS+유계 재시도가
   락 없는 import의 이중 기록을 맡고 있다.

### 근거를 코드 옆에 남겨야 하는가 — **두 후보 모두 그렇다**

#305가 `resolveConflict`에 트리거 문장을 남긴 것과 같은 모양이다. 이 문서의 결론은
**코드를 안 고치기로 한 결정**이라 diff가 없고, diff가 없는 결정은 다음 사람이 같은 자리를
다시 판단하게 만든다. 실제로 이 리포에서 #189 B는 **두 번째로** 이 판단을 하고 있다
(#236이 후보2·3을 한 번 배제했고, 그 근거가 코드 옆에 없어 이 이슈가 다시 열렸다).

- **후보2**: `consolidate-service.ts:2536`의 `sourceObservationIds` 옆.
  이 값이 창의 식별자가 아니라는 것, 경계 하나가 여러 행에 같은 값을 찍는다는 것,
  그래서 유니크 키가 될 수 없다는 것.
- **후보3**: `memory-import-service.ts:181`의 `textKey` 옆.
  이 키가 `!invalidAt` + self-lane **위에서만** 성립하는 동적 성질이지 append 시점의
  정적 성질이 아니라는 것, 그래서 제약이 아니라 가드가 맞는 자리라는 것.

두 문장 모두 **판단을 다시 열 트리거**를 포함해야 한다 — 무엇이 바뀌면 이 결론이 바뀌는지.
초안은 §Q6에 있다.

## Q6 — 조각 나누기

**§Q5가 "넣는다"로 닫은 후보는 0건이다. 따라서 인덱스·마이그레이션 조각은 0개이고,
★(되돌리기 어려운 조각)도 0개다.**

§Q5 마지막 절이 §Q6으로 넘긴 조각 둘만 남는다. 둘 다 주석 한 문단이고 마이그레이션이
붙지 않으므로 ★가 아니다.

### 조각 1 — `sourceObservationIds` 옆 트리거 문장 (★ 아님)

- **파일**: `packages/kernel/src/services/consolidate-service.ts`, `:2536` 근처
- **완료 조건 초안**
  - [ ] 주석이 **이 값이 창의 식별자가 아니라는 것**을 적었다 — 경계 하나가 추출 항목마다
        행을 찍고 전부 이 배열을 공유한다(`:2540-2562`), import는 항상 비워 찍는다
        (`memory-import-service.ts:630-632`), 대화 전용 경계도 `[]`다
  - [ ] 주석이 **창의 실제 식별자는 `meta`에 있다**고 가리켰다
        (`cls_consolidate_watermark` `:90`, `cls_conversation_offset` `:1286`)
  - [ ] 주석이 **재판단 트리거**를 적었다: 워터마크나 대화 오프셋이 `meta`를 떠나
        이벤트 페이로드로 들어오면, 또는 경계가 자기 자신을 나타내는 이벤트를 찍게 되면
        후보2를 다시 잰다
  - [ ] `packages/` 아래 실행되는 코드 변경 0줄 (주석만)
- **인터리브 테스트**: **없다.** 실행 동작이 안 바뀌므로 새 테스트를 붙이지 않는다
  (`TESTING.md`의 금지 패턴 — 문구를 검사하는 테스트).

### 조각 2 — `textKey` 옆 트리거 문장 (★ 아님)

- **파일**: `packages/kernel/src/services/memory-import-service.ts`, `:181` 근처
- **완료 조건 초안**
  - [ ] 주석이 **이 키가 동적 성질이라는 것**을 적었다 — `!invalidAt` + self-lane 스냅샷
        (`:222`) 위에서만 성립하고, append 시점의 정적 속성이 아니다
  - [ ] 주석이 **합법적 재입력 경로 셋**을 한 줄씩 적었다 (supersede 후 재입력 / foreign
        lane / 증류 × import). 이것이 "로그에 유니크 제약을 걸면 안 되는 이유"다
  - [ ] 주석이 **SQL 재현이 등가가 아님**을 적었다 — SQLite `lower`는 ASCII 전용,
        `trim`은 스페이스만. 즉 제약을 걸면 가드보다 약한 두 번째 규칙이 생긴다
  - [ ] 주석이 **재판단 트리거**를 적었다: 정규화 텍스트가 실제 저장 컬럼이 되고
        `invalidAt`/lane 조건이 dedup에서 빠지면 후보3을 다시 잰다
  - [ ] `packages/` 아래 실행되는 코드 변경 0줄 (주석만)
- **인터리브 테스트**: **없다** (조각 1과 같은 이유).

### 참고 — R1을 조각으로 만들지 않는 이유

§Q1.1 (c)의 R1(크래시 뒤 대화 슬라이스 재증류)은 **이 이슈의 범위가 아니다.** 후보2가
그것을 덮지 못한다는 사실은 §Q1의 판정 근거로 쓰였을 뿐이고, R1 자체를 고치는 것은
유니크 제약이 아니라 커서 커밋 순서 문제다. 후속 이슈로 열지 여부는 owner의 기획 패스
몫이므로 [발견](#발견) 절에 적어 둔다.

**만약** 그것이 나중에 조각이 된다면 인터리브 테스트의 형태는 이렇게 된다 (형태만 적는다,
쓰는 것은 그 조각의 몫이다): `kernel-capture-race.test.ts:55`가 `readEvents`에 호출 순서대로
지연을 주입하는 seam이 선례다(sleep이 아니라 seam 주입이라 flaky하지 않다).
R1은 `readEvents`가 아니라 **`commitBoundaryCursors`(`consolidate-service.ts:1445`)에 seam을
두고 첫 경계의 커서 커밋을 건너뛰게 만든 뒤**, 두 번째 경계가 같은 대화 슬라이스를
다시 증류하는지 보는 형태다 — 첫 경계의 append는 성공시키고 커서 커밋만 잃게 하는 것이
크래시 창의 정확한 재현이다.

## 발견

이 산정 중에 발견했으나 이 이슈에서 고치지 않는 것들이다 (비범위 규칙에 따라 기록만 한다).

- **(발견, 범위 밖) `packages/kernel/src/services/consolidate-service.ts` —
  append(`:2693`)와 커서 커밋(`:2920`) 사이에서 크래시하면 대화 슬라이스가 재증류된다
  (R1).** 관찰 축은 `:2380`의 `consumed`가 흡수하지만 대화 축은 흡수자가 없다 — 오프셋은
  `meta`에 있고(`:1286`) 세그먼트 id는 주조된다. #103이 세그먼트 중복만 "bounded and
  self-healing"으로 받아들였고, 같이 생기는 **메모리 중복**은 그 문장이 다루지 않는다.
  CAS도 덮지 않는다(두 번째 경계는 신선한 head를 스탬프하므로 통과한다).
  A 축·C 축은 닫혔으므로 재개하지 않고, 여기 적어 owner의 기획 패스로 넘긴다.

- **(발견, 범위 밖) `packages/kernel/src/services/memory-import-service.ts:181` 대
  `packages/kernel/src/services/consolidate-service.ts:2536` — 텍스트 dedup의 비대칭.**
  import는 `textKey`로 접지만 증류는 텍스트 dedup을 전혀 하지 않는다. 이것이 §Q3.1 경로 3의
  원인이다. 오늘 결함은 아니다(추출기가 `existing`을 보고 supersede를 내는 것이 설계된
  경로다) — 다만 후보3을 다시 잴 사람이 이 비대칭부터 봐야 한다.

## 부록 A — 인용 대조표

기준선 `60f8931`에서 **직접 열어 대조한** 전체 목록이다. 맞은 것도 "맞음"으로 적는다.

| 인용                                                   | 그 줄의 실제 내용                                                                            | 대조 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---- |
| `db.ts:243`                                            | `function findDuplicateGenesis(`                                                             | 맞음 |
| `db.ts:261`                                            | `export function duplicateGenesisError(`                                                     | 맞음 |
| `db.ts:291`                                            | `const MIGRATIONS: ReadonlyArray<...> = [`                                                   | 맞음 |
| `db.ts:295`                                            | `CREATE TABLE IF NOT EXISTS events (`                                                        | 맞음 |
| `db.ts:407`                                            | `CREATE TABLE events_new (`                                                                  | 맞음 |
| `db.ts:541`                                            | `ALTER TABLE events ADD COLUMN writer TEXT;`                                                 | 맞음 |
| `db.ts:542`                                            | `ALTER TABLE events ADD COLUMN source_project_id TEXT;`                                      | 맞음 |
| `db.ts:882`                                            | `const duplicates = findDuplicateGenesis(db);`                                               | 맞음 |
| `db.ts:886`                                            | `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_genesis_once`                                  | 맞음 |
| `db.ts:892`                                            | `function runMigrations(db: Database.Database, projectId?: string): void {`                  | 맞음 |
| `event-store.ts:115`                                   | `export class StaleHeadError extends MemorizeError {`                                        | 맞음 |
| `event-store.ts:164`                                   | `export function headEventId(db: Database.Database): string \| undefined {`                  | 맞음 |
| `event-store.ts:224`                                   | `export interface AppendEventsOptions {`                                                     | 맞음 |
| `event-store.ts:273`                                   | `expectedHead?: string \| null;`                                                             | 맞음 |
| `event-store.ts:293`                                   | `export async function appendEvents<TPayload extends DomainEventPayload>(`                   | 맞음 |
| `event-store.ts:322`                                   | `throw new StaleHeadError(projectId, expectedHead, actualHead);`                             | 맞음 |
| `project-lock.ts:555`                                  | `export class ProjectLockCompromisedError extends MemorizeError {`                           | 맞음 |
| `project-lock.ts:760`                                  | `export async function withProjectLock<T>(`                                                  | 맞음 |
| `project-lock.ts:826`                                  | `if (dispossessed) throw new ProjectLockCompromisedError(projectId);`                        | 맞음 |
| `consolidate-service.ts:90`                            | `const WATERMARK_META_KEY = "cls_consolidate_watermark";`                                    | 맞음 |
| `consolidate-service.ts:1261`                          | `export function getConsolidateWatermark(projectId: string): string \| undefined {`          | 맞음 |
| `consolidate-service.ts:1273`                          | `export function setConsolidateWatermark(projectId: string, eventId: string): void {`        | 맞음 |
| `consolidate-service.ts:1286`                          | `function conversationOffsetKey(sourceId: string): string {`                                 | 맞음 |
| `consolidate-service.ts:1445`                          | `function commitBoundaryCursors(`                                                            | 맞음 |
| `consolidate-service.ts:2211`                          | `const watermark = getConsolidateWatermark(params.projectId);`                               | 맞음 |
| `consolidate-service.ts:2238`                          | `const boundaryStart = probeBoundaryStart(params.projectId, watermark);`                     | 맞음 |
| `consolidate-service.ts:2239`                          | `const expectedHead = boundaryStart.headEventId;`                                            | 맞음 |
| `consolidate-service.ts:2331`                          | `const events = await readEvents(params.projectId);`                                         | 맞음 |
| `consolidate-service.ts:2380`                          | `const consumed = new Set<string>();`                                                        | 맞음 |
| `consolidate-service.ts:2428`                          | `const existing = Object.values(state.memories).filter(`                                     | 맞음 |
| `consolidate-service.ts:2536`                          | `const sourceObservationIds = bounded.observations.map((o) => o.id);`                        | 맞음 |
| `consolidate-service.ts:2693`                          | `await appendEvents(params.projectId, inputs, { expectedHead });`                            | 맞음 |
| `consolidate-service.ts:2920`                          | `const cursorCommit = commitBoundaryCursors(params.projectId, {`                             | 맞음 |
| `memory-import-service.ts:181`                         | `function textKey(kind: string, text: string): string {`                                     | 맞음 |
| `memory-import-service.ts:210`                         | `async function readValidMemoriesFromLog(`                                                   | 맞음 |
| `memory-import-service.ts:222`                         | `(memory) => !memory.invalidAt && (memory.sourceProjectId ?? SELF_LANE) === SELF_LANE,`      | 맞음 |
| `memory-import-service.ts:627`                         | `const { memories: existingMemories, head: expectedHead } = await readValidMemoriesFromLog(` | 맞음 |
| `memory-import-service.ts:810`                         | `await appendEvents(params.projectId, inputs, { expectedHead });`                            | 맞음 |
| `capture-service.ts:293`                               | `await appendEvent({` (타입 `observation.captured`)                                          | 맞음 |
| `conflict-service.ts:97`                               | `await appendEvent({` (타입 `conflict.resolved`)                                             | 맞음 |
| `contradiction-service.ts:287`                         | `appended = await appendEvents<MemorySupersededPayload \| Conflict>(`                        | 맞음 |
| `sqlite-memory-kernel.ts:613`                          | `await appendEvent({` (타입 `memory.injected`)                                               | 맞음 |
| `sqlite-memory-kernel.ts:878`                          | `await appendEvent({` (타입 `project.created`)                                               | 맞음 |
| `domain/entities/memory.ts:101`                        | `sourceObservationIds: EntityId[];`                                                          | 맞음 |
| `tests/integration/kernel-capture-race.test.ts:55`     | `readEvents: async (projectId: string) => {` (seam)                                          | 맞음 |
| `tests/integration/compare-and-append-race.test.ts:76` | `it("refuses the second verdict written against a head both judgments read", ...)`           | 맞음 |

범위 인용(`:2205-2216`, `:2540-2562`, `:2653-2680`, `:240-270`, `:630-632`, `:803-809`,
`:224-229`, `:2387`, `:2405`, `:641`, `:658`, `:886-887`, `:882-888`, `:210-230`)도 같은
커밋에서 열어 대조했다. 모두 본문이 서술한 내용과 일치한다.

## 부록 B — SQLite 실측

리포가 링크하는 엔진에서 직접 실행했다. `pnpm install` 후
`packages/kernel`에서 `node -e '...'`로 돌린 결과의 원문이다.

```
sqlite_version: 3.53.2
better-sqlite3: 12.11.1

# 후보2 — events(project_id, json_extract(payload,'$.sourceObservationIds'))
#          WHERE type='memory.consolidated'
A json_extract expression unique index: CREATED
B identical REJECTED: UNIQUE constraint failed: index 'ix1'      # ["o1","o2"] 두 번
C reordered: ACCEPTED (distinct key)                              # ["o2","o1"]은 다른 키
D second empty REJECTED: UNIQUE constraint failed: index 'ix1'    # [] 두 번 — import·대화전용
E two NULL-extract rows: ACCEPTED (NULL distinct in unique index) # 키 없는 행은 제약 밖

# 후보3 — events(project_id, json_extract(payload,'$.kind'),
#                lower(trim(json_extract(payload,'$.text'))))
F kind+lower(trim(text)) expression unique index: CREATED
G ASCII-normalized dup REJECTED (matches JS textKey)              # '  Use Postgres  ' vs 'use postgres'
   JS  toLowerCase equal? true       # 'ECOLÉ' vs 'ecolé'
   SQL lower() equal? false          # ← 갈린다
   SQL lower('ECOLÉ') = "ecolÉ"
   JS  'ECOLÉ'.toLowerCase() = "ecolé"
SQL trim('  a\tb\n') = "a\tb\n"      # 스페이스만 제거
JS  '  a\tb\n'.trim() = "a\tb"       # 모든 공백 제거

# Q4 — 위반 행이 이미 있는 스토어에 인덱스를 만들면
H index over violating store FAILED: UNIQUE constraint failed: index 'ixz'
I prescan SQL: [{"project_id":"p1","k":"[]","n":2}]               # #236 형태 prescan은 성립한다
```

재현 스크립트(요지):

```js
const db = new (require("better-sqlite3"))(":memory:");
db.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE,
         type TEXT, project_id TEXT, payload TEXT)`);
db.exec(`CREATE UNIQUE INDEX ix1
           ON events(project_id, json_extract(payload,'$.sourceObservationIds'))
           WHERE type='memory.consolidated'`);
// 같은 sourceObservationIds로 두 행을 넣으면 두 번째가 실패한다 (B/D)
```

## 참조

- #189 (idea 본문 B 절 — 후보 셋의 원문)
- #236 / PR #251 — 후보1. prescan → 진단 throw → additive partial index 선례 (`db.ts:882-888`)
- #235 — C 축(락 밖 read-modify-write 제거), 닫힘
- #253 — compare-and-append 도입 (`event-store.ts:224-273`)
- #294 — `detectContradictions` 근거를 로그 replay로
- #298 / PR #299 — `consolidateBoundary` 근거 결속, "결속이 순서를 대체하지 않는다"
- #301 / PR #304 — A 재측정. **"안 넣는다"로 닫은 산정의 선례**
- #305 / PR #308 — `resolveConflict`에 트리거 문장을 남긴 형태 (§Q5가 따르는 모양)
- #154 — 마이그레이션이 만만치 않았던 사례
- `TESTING.md` — 문서 문구를 검사하는 테스트 금지
