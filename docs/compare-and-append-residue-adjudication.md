# A 축(compare-and-append) 잔여 범위 재측정 (#301, #189 A, 2026-08-04 사람 결정)

2026-08-04 사람 결정이 #189의 1안(A+B+C 스토어 강제)을 채택하면서 순서를 **C → B → A**로
못박고, A에는 조건을 하나 더 걸었다 — [#236(B)](https://github.com/shakystar/mori/issues/236)이
머지되면 **A의 범위를 다시 재서** 별도 이슈로 연다. 그 게이트는 2026-08-04에 충족됐다
(#236 CLOSED). 이 문서가 그 재측정이다.

**이 문서는 산정이다.** `packages/` 아래 변경은 **0줄**이고, 실행되는 코드도 0줄이다.
결론은 §Q5의 후속 조각 목록으로 나간다.

**기준선**: `main` = `db80dfc`
(`fix(kernel): consolidateBoundary의 근거를 단일 readEvents에 결속한다 … (#298, #189 ㉱) (#299)`).
이 문서의 모든 `파일:줄` 인용은 그 커밋에서 파일을 열어 대조한 것이다 — 이슈 본문이나
선행 문서의 줄번호를 옮겨 적은 것은 하나도 없다. 이 리포는 크로스파일 인용이 반복해서
낡았고(#274·#300), 이 문서는 후속 이슈의 입력이 되므로 틀린 인용이 그대로 전파된다.

## 필수 질문 → 절 매핑

| 질문                                     | 절                                                     | 한 줄 답                                                                                   |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Q1 append 호출부 전수 조사               | [Q1](#q1--append-호출부-전수-조사)                     | 프로덕션 **7건**. 덮임 3 / 다른 수단으로 덮임 1 / 해당 없음 2 / **열림 1**                 |
| Q2 #189가 지목한 세 자리                 | [Q2](#q2--189가-지목한-세-자리의-현재-상태)            | #132② 닫힘 · #114② 닫힘(`memory-import`, `capture`가 아니다) · **#118⑤ 열림**              |
| Q3 단수형 `appendEvent`에 CAS를 어떻게   | [Q3](#q3--단수형-appendevent에-cas를-어떻게-줄-것인가) | 선택지 4개를 실측 파급과 함께 놓는다. 어느 것도 **지금** 쓰지 않기를 권고한다 (§Q4가 이유) |
| Q4 `conflict-service`를 지금 고칠 것인가 | [Q4](#q4--conflict-service를-지금-고칠-것인가)         | **아무것도 하지 않는다.** 트리거 문장 초안을 남긴다                                        |
| Q5 후속 조각                             | [Q5](#q5--후속-조각)                                   | **2개.** 둘 다 구현이 아니다 (주석 1줄 · 낡은 인용 갱신). CAS 적용 조각은 **0개**          |

**A 축의 결론 한 줄**: `expectedHead`를 실을 자리는 **더 남아 있지 않다.** 열려 있는
한 자리(`resolveConflict`)는 CAS로 닫을 자리가 아니고, 프로덕션 호출자가 없어 지금
닫는 것이 옳지도 않다. §Q5의 두 조각이 머지되면 #189의 A 축을 닫을 수 있다.

## 0. 대상 집합 — 무엇을 전수 조사라고 부르는가

### 0.1 정의한 grep

```
$ grep -rnE "\bappendEvents?[[:space:]]*(<[^()]*>)?\(" packages/ --include='*.ts' \
    --exclude-dir=dist --exclude-dir=node_modules
```

세 가지가 이 명령의 형태를 정한다.

**제네릭 호출까지 잡는다.** 단순 `appendEvents?\(` 패턴은
`appendEvents<MemorySupersededPayload | Conflict>(`를 **놓친다** —
`contradiction-service.ts:287`이 그 형태이고, 그것이 이 리포에서 CAS가 적용된 세 자리
중 하나다. 놓친 채로 표를 그리면 전수 조사가 아니다.

**`--exclude-dir=dist`가 없으면 건수가 빌드 여부에 따라 달라진다.** `pnpm build`를
돌린 트리에는 `packages/kernel/dist/storage/event-store.d.ts`가 생기고 거기에 두 함수의
`export declare`가 들어 있어 같은 명령이 **138**을 낸다. `dist/`는 `.gitignore:2`에
있어 추적되지 않으므로 소스 집합이 아니고, 빼지 않으면 아래 §0.2의 산술이 검증자의
트리 상태에 따라 맞거나 틀린다. **이 문서의 모든 숫자는 빌드 산출물을 제외한 값이다.**

**`--exclude-dir=node_modules`는 예방적이다.** 이 워크스페이스에서 실측하면 0건이지만
(pnpm이 심링크로 깔고 GNU grep은 `-r`에서 심링크를 따라가지 않는다) grep 구현에 기대는
0건이라, 명령 자체에 적어 둔다.

### 0.2 건수 대조

| 집합                                                            | 건수    |
| --------------------------------------------------------------- | ------- |
| 전체 매치 (`packages/`, `*.ts`, `dist`·`node_modules` 제외)     | **136** |
| 그중 테스트(`*.test.ts`)                                        | **125** |
| 남은 비테스트 매치                                              | **11**  |
| 그중 정의(`event-store.ts:197`, `:293`)                         | 2       |
| 그중 주석(`event-store.ts:219`, `contradiction-service.ts:275`) | 2       |
| **프로덕션 호출부**                                             | **7**   |

`136 = 125 + 2 + 2 + 7`. §Q1 표의 행 수는 **7**로, 이 숫자와 일치한다.

**테스트 제외는 125건이다.** 테스트 트리에는 `*.test.ts`가 아닌 헬퍼가 하나 있지만
(`packages/kernel/tests/support/property.ts`) append 호출부가 0건이라 제외 대상에
들어가지 않는다:

```
$ find packages -path '*/node_modules/*' -prune -o -path '*/dist/*' -prune \
    -o -path '*/tests/*' -name '*.ts' ! -name '*.test.ts' -print
packages/kernel/tests/support/property.ts

$ grep -lE "\bappendEvents?[[:space:]]*(<[^()]*>)?\(" packages/kernel/tests/support/property.ts
(빈 출력 — 이 파일에 append 호출부 0건)
```

`packages/*/src` 아래에도 `*.test.ts`가 25개 코로케이션돼 있고, 그것들은 `.test.ts:`
필터가 그대로 걷어낸다 — 위 125건에 포함된다.

### 0.3 이 집합이 로그 라이터 전부인가 — 예

Q1의 대상 집합은 "`appendEvent`/`appendEvents`의 호출부"로 정의됐다. 그것이 `events`
테이블 쓰기 **전부**인지는 별 질문이라 따로 쟀다.

```
$ grep -rn "INSERT INTO events" packages/ --include='*.ts' \
    --exclude-dir=dist --exclude-dir=node_modules | grep -v '\.test\.ts'
packages/kernel/src/storage/event-store.ts:173:    `INSERT INTO events
packages/kernel/src/storage/db.ts:420:      INSERT INTO events_new
```

- `event-store.ts:173`은 `insertEvent`이고, 두 append 함수만 그것을 부른다.
- `db.ts:420`은 마이그레이션의 테이블 재작성(`events_new`)이다. 동시성 축이 아니고
  (`runMigrations`가 `BEGIN IMMEDIATE`로 직렬화한다, `db.ts:892-895`), read-then-write
  판정 대상도 아니다.
- `insertExternalEvents`/`pullProject`는 **아직 코드가 없다** — `db.ts:577`, `:721`,
  `:853`의 언급은 모두 "그런 경로가 없다"를 근거로 쓰는 주석이다.

따라서 §Q1의 7행은 프로덕션에서 로그에 이벤트를 싣는 자리 전부다.

## Q1 — append 호출부 전수 조사

### Q1 표

| 호출부                                                                     | 단/복 | 앞선 스토어 읽기                                                                         | 그 읽기가 이 append의 판정 근거인가               | CAS  | 판정                                          |
| -------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ---- | --------------------------------------------- |
| `sqlite-memory-kernel.ts:613` (`memory.injected`)                          | 단수  | 있음 — `buildMemoryContext` (`:505`), 프로젝션                                           | **아니다** — payload의 출처이지 전제조건이 아니다 | 없음 | 해당 없음 (read-then-write 아님)              |
| `sqlite-memory-kernel.ts:878` (`project.created`)                          | 단수  | 있음 — `hasGenesisEvent` (`:868` → `event-store.ts:72-81`), **로그 직접**                | 그렇다                                            | 없음 | 다른 수단으로 덮임 — v18 partial unique index |
| `capture-service.ts:293` (`observation.captured`)                          | 단수  | **없음** — 앞선 두 단계가 순수 함수다                                                    | 해당 없음                                         | 없음 | 해당 없음 (read-then-write 아님)              |
| `conflict-service.ts:97` (`conflict.resolved`)                             | 단수  | 있음 — `getConflict` (`:75`), 프로젝션                                                   | 그렇다 — `:79` 전이 검사의 입력                   | 없음 | **열림**                                      |
| `consolidate-service.ts:2693` (`memory.consolidated` 외)                   | 복수  | 있음 — `probeBoundaryStart` (`:2238`) · 대화 슬라이스 (`:2254`) · `readEvents` (`:2331`) | 그렇다                                            | 있음 | 덮임                                          |
| `memory-import-service.ts:810` (`memory.consolidated` 외)                  | 복수  | 있음 — `readValidMemoriesFromLog` (`:627` → `:210-230`), **로그**                        | 그렇다                                            | 있음 | 덮임                                          |
| `contradiction-service.ts:287` (`memory.superseded` + `conflict.detected`) | 복수  | 있음 — `readEvents` (`:190`), **로그**                                                   | 그렇다                                            | 있음 | 덮임                                          |

집계: **덮임 3 · 다른 수단으로 덮임 1 · 해당 없음 2 · 열림 1.**

---

### Q1.1 `sqlite-memory-kernel.ts:613` — `memory.injected` — **해당 없음**

`transformContext`(`:441`)가 주입에 성공한 뒤 남기는 관측성 append다
(`:613-620`, `try`/`catch`로 감싼 best-effort — `:612`, `:621-623`).

앞선 스토어 읽기는 **있다**: `buildMemoryContext`(`:505`)가 프로젝션에서 메모리를
읽고, payload의 `memoryIds`가 그 결과에서 나온다.

**그럼에도 read-then-write 하자가 아닌 이유**는 이 append가 *판정*이 아니라 *기록*이기
때문이다. 이벤트가 주장하는 명제는 "이번 턴에 모델이 이 id들을 봤다"이고, 그 명제는
로그가 그 사이 움직였는지와 무관하게 참으로 남는다. 다른 프로세스가 새 메모리를
append했다고 해서 이 턴이 실제로 보낸 목록이 달라지지 않는다. 주석 자신이 그 grain을
적어 두었다 (`:607-611`) — "the event answers 'what did the model see this turn'".

여기에 CAS를 걸면 손해만 남는다: 이 자리는 never-throw 계약 안의 `catch {}`이므로
(`:429-434`, `:621-623`) 거절은 예외가 아니라 **텔레메트리의 조용한 소실**로 나타나고,
조건은 "다른 누군가가 append했다"이므로 바쁜 스토어에서 상시 소실된다.

**다만 이 자리에는 A의 축이 아닌 성질이 하나 있다**: 이것은 프로덕션에서
`withProjectLock` **밖**에서 실행되는 유일한 append다 (`observe`는 `:724`, `consolidate`는
`:794`에서 락을 잡는다. 락을 잡지 않는 `importMemories`·`resolveConflict`는 프로덕션
호출자가 없다 — `projection-store.ts:160-165`이 같은 사실을 적는다). head는 이벤트
종류를 가리지 않으므로(`consolidate-service.ts:1936-1938`) 이 append는 동시에 도는
경계의 CAS를 실패로 돌릴 수 있다. **그것은 이미 등록된 창이다** —
`docs/compaction-consolidation-boundary.md`의 **W9**(§4.3 표)와 **C5**(§4.4)가 같은 경로를
적고 "A(#189)의 축이 아니다 — CAS 자체는 설계대로 동작한다(#253); 늘어나는 것은
재시도까지의 벽시계 시간이다"로 분류했다. 이 문서는 그 분류를 승계한다. (그 두 곳의
`consolidate-service.ts` 줄번호는 지금 낡았다 — §부록 F1.)

### Q1.2 `sqlite-memory-kernel.ts:878` — `project.created` — **다른 수단으로 덮임**

`ensureGenesis`(`:864`)는 `hasGenesisEvent`(`:868`)로 로그를 직접 조회한 뒤
(`event-store.ts:72-81`, `SELECT 1 FROM events WHERE type='project.created'`) `:878`에서
append한다. 전형적인 read-then-write이고, 두 프로세스가 새 스토어를 동시에 부트스트랩할
때 둘 다 검사를 통과할 수 있다.

**닫은 것은 CAS가 아니라 제약이다.** #236(B)이 넣은 v18 partial unique index
`idx_events_genesis_once`(`db.ts:886-888`)가 진 쪽의 INSERT를 실패시키고,
`isDuplicateGenesisError`(`event-store.ts:100-106`,
`SQLITE_CONSTRAINT_UNIQUE` + `events.project_id`)가 그 실패를 성공으로 취급한다
(`sqlite-memory-kernel.ts:888-889`). 그 논거는 코드 주석에 있다
(`:853-862`) — 락은 임계구역을 끝까지 돌린 뒤 상실을 보고하므로 락만으로는 이 창이
남는다.

**따라서 A의 대상 목록에서 이 자리는 빠진다.** `appendEvent`에 CAS 옵션이 생겨도 여기
쓸 이유가 없다: 제약은 락 누락·홀더 크래시·락 강탈을 전부 넘어서 걸리고(#189 B의
논거), CAS는 "로그가 그 사이 안 움직였다"만 검사하므로 **다른 종류의 append가 하나라도
끼면 genesis 중복과 무관하게 거절**된다. 부트스트랩을 경합에 더 취약하게 만드는 교환이다.

### Q1.3 `capture-service.ts:293` — `observation.captured` — **해당 없음**

`captureObservation`(`:259`)이 append 앞에서 하는 일은 셋뿐이다:

1. `evaluateCapture(params.toolName, params.toolInputText)` (`:262`) — 툴 입력만 보는 순수 함수
2. `createObservation({...})` (`:265`) — 도메인 엔티티 생성, 순수
3. `throwIfDispossessed(params.signal)` (`:291`, #158 체크포인트 ①) — 신호 확인, 스토어 접근 없음

이 파일의 import 4개(`:1-4`)에 스토어 리더가 없다 —
`appendEvent`·`throwIfDispossessed`·`rebuildProjectProjection`과 도메인뿐이다.
**append 앞에 스토어 읽기가 없으므로 read-then-write가 아니다.**

**#301 본문의 ③ 추정이 맞다**: `#114②`가 이 자리를 가리킨다면 없는 결함에 CAS를 붙이는
일이 된다. 실제로 `#114②`는 다른 자리다 — §Q2.2.

**혼동하기 쉬운 자리 하나를 분리한다.** `#132①`이 지적한 read-modify-write는 이 append가
아니라 **그 다음 줄의 프로젝션 리빌드**(`:314`)다. 그쪽은 세 겹으로 덮여 있다:
`withProjectLock`(`sqlite-memory-kernel.ts:724`) + `#158` 체크포인트 ②(`:312`) +
`#270`의 리빌드 자체 CAS(`projection-store.ts:441`, `headEventId(db) !== snapshotHead`면
커밋하지 않는다). 로그 append 축이 아니므로 Q1 표의 판정에는 영향이 없다.

### Q1.4 `conflict-service.ts:97` — `conflict.resolved` — **열림**

스팬은 `resolveConflict`(`:40`) 안에서 **`:55`에서 시작해 `:77`에서 끝난다**:

- `:55` `const existing = getConflict(params.projectId, params.conflictId);` — 프로젝션 읽기
- `:59` `assertConflictStatusTransition(existing.status, params.status);` — 그 읽기를 근거로 한 판정
- `:77` `await appendEvent({ type: "conflict.resolved", … })` — 판정 결과를 로그에 쓴다

이 함수는 스스로 열려 있다고 적어 두었다 (`:41-54`). 그 주석의 요지 셋:

1. 두 호출자가 같은 `detected` conflict를 동시에 해소하면 둘 다 변하지 않은 프로젝션을
   읽고 검사를 통과한 뒤 서로 다른 결과를 append할 수 있다.
2. 재생 쪽은 검사를 하지 않는다 — projector가 last-write-wins로 덮으므로 상태 기계가
   금지한 상태가 프로젝션에 남는다.
3. 열어 둔 이유는 하나다 — _"It is unguarded only because this function has no production
   caller yet — it is reachable from tests alone."_

**그 이유는 오늘도 사실이다.** 실측:

```
$ grep -rn "resolveConflict" packages/ --include='*.ts' | grep -v assertConflictStatus
packages/kernel/src/services/conflict-service.ts:40:            (정의)
packages/kernel/src/services/projection-store.ts:162,199:      (주석 2건)
packages/kernel/tests/integration/conflict-service.test.ts:      (7건)
packages/kernel/tests/integration/two-reader-equivalence.test.ts: (2건)
```

프로덕션 호출부 **0건**. `packages/kernel/src/index.ts`에서 export되지도 않고
`SqliteMemoryKernel`이 부르지도 않는다 — `projection-store.ts:160-165`이 같은 확인을
이미 적어 두었다.

`#118⑤`가 이 자리를 **코드 변경 없이 명문화만** 하기로 정했고(그 이슈의 수용 기준),
`:53-54`의 *"#118 item 5 — deliberately no CAS added here"*가 그 결정의 흔적이다.
판정은 **열림**이며, 지금 닫는 것이 옳은지는 §Q4에서 따로 재다.

### Q1.5 `consolidate-service.ts:2693` — **덮임**

`run()`의 근거 읽기와 append의 순서 (전부 `db80dfc`에서 확인):

| 자리    | 읽는 것                                          | 무엇에서 오는가        |
| ------- | ------------------------------------------------ | ---------------------- |
| `:2211` | `getConsolidateWatermark`                        | `meta` 커서            |
| `:2238` | `probeBoundaryStart` → `headEventId`             | **로그** (head 스탬프) |
| `:2239` | `const expectedHead = boundaryStart.headEventId` | —                      |
| `:2254` | `source.read(sliceStartOffset)` (대화 슬라이스)  | 트랜스크립트           |
| `:2331` | `readEvents(params.projectId)`                   | **로그**               |
| `:2332` | `reduceProjectState(events, …)`                  | 위 배열 파생           |
| `:2380` | `consumed` 집합                                  | 위 배열 파생           |
| `:2428` | `existing`                                       | 위 배열 파생           |
| `:2693` | `appendEvents(…, { expectedHead })`              | —                      |

세 성질이 이 판정을 지탱한다:

1. **head가 근거보다 먼저 스탬프된다** (`:2213-2237`의 ORDERING INVARIANT 주석).
   `:2238` 위에서 읽는 것은 워터마크뿐이고, 그것은 근거가 아니다 (아래 3).
2. **근거 셋이 로그 하나에서 나온다** (#298, `:2307-2330`의 주석). `consumed`·`existing`·
   윈도우가 전부 `:2331`의 배열 파생이므로, "CAS가 통과했다"와 "근거가 같은 로그를
   봤다"가 같은 문장이 된다. 이것이 #253의 CAS만으로는 남았던 갈림
   (`docs/consolidate-evidence-binding-adjudication.md` §Q1)을 닫은 수법이다.
3. **워터마크는 근거가 아니다** (`:2201-2210`). `commitBoundaryCursors`가 boundary 맨
   끝(`:2920`)에서 돌므로 커서는 로그보다 앞설 수 없고, 뒤처지면 윈도우가 넓어지는데
   그것은 로그 파생 `consumed` 필터가 흡수한다. #296 §Q4가 이 논거를 확정했다.

### Q1.6 `memory-import-service.ts:810` — **덮임**

`readValidMemoriesFromLog`(`:210-230`)가 근거와 head를 **같은 배열 하나**에서 낸다 —
`readEvents` → `reduceProjectState` → 필터, 그리고 `head: events.at(-1)?.id ?? null`
(`:228`). `runImport`가 그것을 한 번에 받는다 (`:627-629`), append가 그 head를 싣는다
(`:810`).

이 자리는 프로덕션 크로스프로세스 락이 없다(모듈 doc `:36-63`) — 있는 것은
같은 프로세스 안의 promise-chain 뮤텍스 `withProjectImportLock`(`:85`, 적용 `:239`)뿐이다.
그래서 CAS가 유일한 커버이고, `:803-809`의 주석이 그 사실을 적는다.

거절 복구가 이 자리에만 있는 것도 정합적이다: `importMemories`가 append **이전**
실패만 재시도한다 (`:239-273`, `IMPORT_STALE_HEAD_RETRIES = 2` `:280`, `onAppended`
관측 `:262-268`). append 이전에는 디스크에 아무것도 쓰이지 않았고(`:240-247`) 재시도
비용이 로그 replay 한 번이므로 — LLM 왕복을 다시 사는 다른 두 자리와 다르다.

### Q1.7 `contradiction-service.ts:287` — **덮임**

`detectContradictions`(`:162`)가 `:190`에서 `readEvents` 한 번을 읽고, 그 배열에서
head(`:203` `let expectedHead = events.at(-1)?.id ?? null`)와 판정 대상 decision 집합
(`:212-218`)을 함께 낸다. `:287-311`의 append가 그 head를 싣고, 거절되면 그 패스를
포기한다 (`:312-328`, `staleBasis = true`). 자기 append는 head를 전진시킨다 (`:333`).

이것이 ㉰(#289/#294)가 basis를 프로젝션에서 로그 replay로 옮긴 결과다
(`docs/contradiction-repeat-adjudication.md`).

**근거 하나는 로그 밖이다 — 임베딩 테이블** (`listEmbeddings(projectId, "memory",
embedder.model)`, `:226-228`). 손해의 방향을 재면 판정은 바뀌지 않는다: 벡터가 없거나
낡으면 그 쌍은 코사인 프리필터에서 건너뛰어진다(`:243-244`·`:249-251`). 결과는 **누락**이고
append되는 내용에는 영향이 없다 — 승자·패자와 supersede 이유는 로그 파생 decision에서
나온다(`:253-262`). 모순 탐지는 반복되는 best-effort 스윕이므로 다음 경계·import가 다시
돈다(`:314-326`의 주석이 그 계약을 적는다).

### Q1.8 완료조건 3 — `덮임` 판정의 근거는 어디서 나오는가

PR #299 리뷰에서 확정된 구별을 그대로 승계한다: **CAS 통과는 "로그가 안 움직였다"만
증명하지 "프로젝션이 신선하다"를 증명하지 않는다.** 그래서 `덮임` 3건과
`다른 수단으로 덮임` 1건을 근거별로 다시 쪼갠다.

| 자리                           | 근거                      | 어디서 오는가                        | CAS가 그 근거에 충분한가                                                                                               |
| ------------------------------ | ------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `consolidate-service.ts:2693`  | 윈도우 (관측 집합)        | **로그** (`:2331` 배열)              | 충분 — head가 그 배열보다 먼저 스탬프됨 (`:2213-2237`)                                                                 |
|                                | `consumed`                | **로그** (`:2380`, 같은 배열)        | 충분 — #298이 `memories` 프로젝션 질의를 대체함 (`:2368-2379`)                                                         |
|                                | `existing`                | **로그** (`:2428`, 같은 배열)        | 충분 — 같음                                                                                                            |
|                                | 대화 슬라이스             | **트랜스크립트** (로그로 표현 안 됨) | CAS가 **유일한** 커버. head-먼저 순서가 그것을 성립시킨다 (`:2225-2235`). #298이 이 축의 순서를 뒤집었다가 되돌린 자리 |
|                                | 워터마크                  | `meta` 커서                          | 커버 불필요 — 뒤처지기만 하고, 넓어진 윈도우는 `consumed`가 흡수 (`:2201-2210`, #296 §Q4)                              |
| `memory-import-service.ts:810` | dedup 스냅샷 + `validIds` | **로그** (`:210-230`)                | 충분 — head가 **같은 배열**에서 나옴 (`:228`), 두 읽기 사이 창 자체가 없다                                             |
| `contradiction-service.ts:287` | decision 집합             | **로그** (`:190`)                    | 충분 — head가 같은 배열에서 나옴 (`:203`)                                                                              |
|                                | 임베딩 벡터               | `embeddings` 테이블                  | 충분하지 않지만 **손해가 누락 한 종류**다 — append 내용에 영향 없음 (§Q1.7)                                            |
| `sqlite-memory-kernel.ts:878`  | `hasGenesisEvent`         | **로그** (`event-store.ts:72-81`)    | 해당 없음 — CAS가 아니라 unique index가 덮는다. 이 자리에 CAS는 부적합 (§Q1.2)                                         |

요지: **`덮임`으로 센 3건 중 어느 것도 "그 파일이 `expectedHead`를 쓴다"만으로 세지
않았다.** 로그 파생이 아닌 근거가 남은 자리는 둘(대화 슬라이스, 임베딩)이고, 각각
왜 그래도 판정이 서는지를 위 표의 마지막 칸에 적었다.

## Q2 — #189가 지목한 세 자리의 현재 상태

#189 A의 완료 조건 원문: _"#132②·#114②·#118⑤의 read-then-write 스팬이 `expectedHead`를
싣고, 경쟁 시 진 쪽이 조용히 성공하는 대신 거절을 받는다."_

### Q2.1 `#132②` — consolidation 경계 — **닫힘**

**#132②의 원문**(PR #130 Codex P1, `cli/consolidation.ts:27`): 같은 working root의 두 mori
세션이 동시에 종료하면 서로 다른 커널 인스턴스라 `WeakMap`이 직렬화하지 못하고, 둘 다
같은 워터마크를 읽은 뒤 같은 관측에 대해 독립적으로 `memory.consolidated`를 append한다.

**오늘 어디**: `consolidate-service.ts`의 `run()` — `:2238`(head 스탬프)에서
`:2693`(append)까지.

**닫은 것 셋** (하나로는 닫히지 않았다):

| 무엇               | 어디                                                                                     | 이슈/PR                    |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------- |
| 프로세스 간 락     | `sqlite-memory-kernel.ts:794` (`withProjectLock`)                                        | #132 / 그 자신             |
| CAS                | `consolidate-service.ts:2693` (`{ expectedHead }`)                                       | #253                       |
| 근거를 로그에 결속 | `consolidate-service.ts:2307-2330` (단일 `readEvents`) + `:2213-2237` (head-먼저 불변식) | #298 / PR #299 (`db80dfc`) |

세 번째가 없으면 CAS는 통과하면서 근거가 탈취 이전 것일 수 있었다 —
`:2661-2670`의 주석이 그 시나리오를 적는다. `#189 A`가 요구한 형태
("진 쪽이 조용히 성공하는 대신 거절을 받는다")는 `:2686-2692`이 적는 전파 경로로
성립한다: 거절되면 커서가 둘 다 그대로이고 `recordAttempt`가 실패로 기록한다.

**남는 창은 있고, A의 축이 아니다.** `docs/compaction-consolidation-boundary.md` §4.3의
W1·W2·W6·W8이 락 상실 이후의 꼬리 구간을 다루고, 그 표가 스스로 "락 경합이 아니라
… A의 축이 아니다"로 분류한다. 워터마크를 로그에 묶지 않기로 한 결정은 #296 §Q4가
"남는 손해 0"으로 판정했다.

### Q2.2 `#114②` — **닫힘. 그리고 `capture-service`가 아니다**

**#114②의 원문**: _"`:86-88` — 중복 검사와 append가 직렬화되지 않는다 (P1)"_. 대상 파일이
이슈 제목에 박혀 있다 — `packages/kernel/src/services/memory-import-service.ts`. 지적한
스팬은 멱등성 가드(`listValidMemories` → `memories` 프로젝션 테이블) → `appendEvents`이고,
깨지는 두 경로는 (1) 같은 프로세스 안 겹친 호출, (2) append 성공 후 리빌드 전 크래시다.

**#301 본문 ③의 추정은 맞다 — `#114②`는 `capture-service`가 아니다.** 근거 둘:

1. `capture-service.ts`에는 append 앞 스토어 읽기가 없다 (§Q1.3의 실측).
2. #114의 제목·본문·수용 기준이 전부 `memory-import-service.ts`를 가리킨다. ②의 수용
   기준 세 줄이 "import 두 건이 겹쳐 실행돼도", "append와 재구축 사이에서 중단된 뒤
   재시도해도", "파일 헤더 `:24-27`의 'No file lock' 논증을 이 경로에 대해 수정"이다.

**오늘 어디**: `memory-import-service.ts:627`(근거 읽기) → `:810`(append).

**무엇이 닫았나 — 세 겹이고, CAS는 그중 하나다**:

| 무엇                          | 어디                                         | 이슈         |
| ----------------------------- | -------------------------------------------- | ------------ |
| 같은 프로세스 직렬화          | `withProjectImportLock` (`:85`, 적용 `:239`) | #114         |
| 근거를 프로젝션에서 로그로    | `readValidMemoriesFromLog` (`:210-230`)      | #114 / #137③ |
| CAS + append 이전 한정 재시도 | `:810` (`{ expectedHead }`), `:239-273`      | #253         |

모듈 doc `:36-63`가 이 셋의 역할 분담을 적고, 그것이 #114②의 세 번째 수용 기준("헤더의
'No file lock' 논증을 이 경로에 대해 사실에 맞게 수정")의 산출물이다.

**#189 A가 요구한 형태로도 닫혀 있다**: 진 쪽은 `StaleHeadError`를 받고
(`event-store.ts:115-130`), `importMemories`가 append 이전이면 최대 2회 재시도한 뒤
전파한다. 조용한 성공은 남지 않는다.

### Q2.3 `#118⑤` — `resolveConflict` — **열림**

**#118⑤의 원문**: _"`resolveConflict`의 전이 검사와 append 사이가 직렬화되지 않는다 —
**코드 변경 없이 불변식만 명문화**"_. 그 이슈가 명시적으로 *"이번 이슈에서 락·CAS 기계를
추가하지 마라"*고 적었고, 수용 기준은 주석 하나였다.

**오늘 어디, 정확한 스팬**: `packages/kernel/src/services/conflict-service.ts`

- 스팬 시작: **`:55`** — `const existing = getConflict(params.projectId, params.conflictId);`
- 스팬 안: `:56-58`(미발견 시 throw), **`:59`** — `assertConflictStatusTransition(existing.status, params.status);`, `:61-69`(순수 계산)
- 스팬 끝: **`:77`** — `await appendEvent({ type: "conflict.resolved", … })`
- 그 뒤: `:85` `await rebuildProjectProjection(params.projectId)`

**열려 있고, 열어 둔 이유도 그대로다** — 프로덕션 호출부 0건(§Q1.4의 실측).
`:41-54`의 주석이 #118⑤의 산출물이며, 그것이 요구한 명문화는 이미 충족돼 있다:
비원자성, 재생이 금지된 상태를 남길 수 있음, 단일 라이터 전제, 그리고
_"Whoever wires the first real caller must take that lock here — or wrap the span in a
transaction"_.

**#189 A의 완료 조건 문구 기준으로는 미충족이다** (`expectedHead`를 싣지 않았다).
그것을 지금 충족시키는 것이 옳은지는 §Q4에서 재고, 결론은 아니다.

### Q2 요약

| 자리    | 오늘 자리                               | 열림/닫힘 | 무엇이 닫았나                                     |
| ------- | --------------------------------------- | --------- | ------------------------------------------------- |
| `#132②` | `consolidate-service.ts:2238` → `:2693` | 닫힘      | #132(락) + #253(CAS) + #298/PR #299(근거 결속)    |
| `#114②` | `memory-import-service.ts:627` → `:810` | 닫힘      | #114(뮤텍스+로그 근거) + #137③ + #253(CAS+재시도) |
| `#118⑤` | `conflict-service.ts:75` → `:97`        | **열림**  | — (#118이 명문화만 하기로 확정)                   |

**못 찾은 것은 없다.** #301 본문이 대비를 요구한 "`#114②`가 `capture-service`가
아니라면 어느 자리인가"는 `memory-import-service.ts:627`→`:810`으로 특정됐다.

## Q3 — 단수형 `appendEvent`에 CAS를 어떻게 줄 것인가

Q1의 `열림`은 1건이고 단수형을 쓰므로 이 절은 해당된다. **CAS 옵션이 복수형에만 있는
것은 실물이다**: `AppendEventsOptions`(`event-store.ts:224-274`)는 `appendEvents`(`:293-296`)의
세 번째 인자이고, `appendEvent`(`:197-199`)의 시그니처는 `input` **하나**다.

측정 기준선 (§0의 grep을 단/복수로 쪼갠 것):

| 심볼           | 전체 매치 | 테스트 | 정의·주석 | **프로덕션 호출부** |
| -------------- | --------- | ------ | --------- | ------------------- |
| `appendEvent`  | 126       | 120    | 2         | **4**               |
| `appendEvents` | 10        | 5      | 2         | **3**               |

`126 + 10 = 136` (§0.2와 일치).

### (a) 단수형에 옵션 인자를 추가한다

`appendEvent(input, options?: AppendEventsOptions)`. 트랜잭션 안에서 head를 재확인하는
로직은 이미 `appendEvents`에 있으므로(`:317-345`) 구현은 단수형을 복수형에 위임하거나
같은 블록을 복제하는 일이다.

**파급 실측**: 강제로 고쳐야 하는 호출부 **0건**. 인자가 후위 옵셔널이므로 기존 126개
매치 전부 그대로 컴파일된다. 실제로 손대는 곳은 정의 1곳 + CAS를 켤 호출부 1곳
(`conflict-service.ts:97`) = **2곳**.

- **장점**: 파급이 가장 작다. "CAS를 걸 수 있는 API가 그 자리에 없다"는 사실 자체가 없어지고,
  나중에 다른 단수형 자리(오늘은 없다)가 필요해져도 옵션이 이미 있다.
- **단점 1**: 단수형은 오늘 트랜잭션을 쓰지 않는다 — `insertEvent(getDb(...), event)` 한 줄이다
  (`:218-220`). CAS를 넣으면 그 자리에 `BEGIN IMMEDIATE` 트랜잭션이 생긴다. 복수형이
  `expectedHead` 유무로 DEFERRED/IMMEDIATE를 갈라 두었으므로(`:330-345`) 같은 분기를 하나 더
  들이는 일이다.
- **단점 2**: 두 append 함수의 차이가 "이벤트 개수"에서 "개수 + 옵션 유무의 조합"으로
  넓어진다. `:291`의 규율(_"single-event flows keep using `appendEvent`"_)이 지금은 한 문장으로
  서지만, 옵션이 양쪽에 생기면 어느 것을 쓸지를 개수만으로 정할 수 없다.
- **단점 3**: 옵션만 생기고 켜는 자리가 하나뿐이면(§Q4의 권고대로 켜지 않으면 0곳) **아무도
  쓰지 않는 API 표면**이 남는다.

### (b) 그 호출부를 복수형(1건 배열)으로 옮긴다

`appendEvents(projectId, [input], { expectedHead })`.

**파급 실측**: 프로덕션 **1곳**(`conflict-service.ts:97-104` → `appendEvents` 호출로 치환,
import 줄 `:5`도 함께). 테스트 파급은 이 함수를 부르는 파일 **2개** —
`tests/integration/conflict-service.test.ts`(`resolveConflict` 7건),
`tests/integration/two-reader-equivalence.test.ts`(2건). 두 파일 모두 `resolveConflict`의
반환값·프로젝션 효과만 단언하므로 치환 자체로 깨지지는 않고, 새로 생기는 거절 경로에 대한
테스트가 추가로 필요하다.

- **장점**: API 표면이 안 늘고, 복수형의 트랜잭션·IMMEDIATE 논거를 그대로 물려받는다.
  이 리포에서 CAS를 쓰는 세 자리와 모양이 같아진다.
- **단점 1**: `:291`의 규율을 이 자리에서 어긴다 — 1건 배열을 복수형에 넣는 것은 "여러
  이벤트를 한 논리 연산으로 묶는다"는 그 함수의 존재 이유가 아니다. 주석을 함께 고쳐야 한다.
- **단점 2**: **이것만으로는 이 자리가 닫히지 않는다.** 근거가 `getConflict`(프로젝션)이므로
  §Q1.8의 구별이 그대로 걸린다 — CAS 통과가 "프로젝션이 신선하다"를 말해 주지 않는다.
  실제로 닫으려면 근거를 로그 파생으로 바꿔야 하고(§(d)), 그것은 1줄 치환이 아니다.

### (c) CAS가 아니라 락 또는 트랜잭션으로 덮는다

`:53-54`의 주석이 직접 지목한 선택지다 — _"Whoever wires the first real caller must take
that lock here — or wrap the span in a transaction"_.

**파급 실측**: 배선해야 할 프로덕션 호출자 **0건**(§Q1.4). `withProjectLock`을 쓰면
`conflict-service.ts`에 `storage/project-lock.ts` 의존이 새로 생긴다(오늘 import 5줄에 없다).
락을 서비스 안에서 잡는 것은 이 리포의 오늘 패턴과 다르다 — 커널이 잡고 서비스는
`signal`만 받는다(`capture-service.ts:291`, `consolidate-service.ts`의 `lockSignal`).
`resolveConflict`에서 잡으면 커널이 이미 락을 쥔 채 부를 때 재진입 교착이 되고,
`withProjectLock`은 non-reentrant다 (#189가 `WriteTx` 기각 논거 3으로 적은 것과 같은 함정).

- **장점**: 프로젝션 근거의 신선도까지 함께 덮는다 — CAS가 못 하는 부분이다(§Q1.8).
  `#118⑤`의 주석이 이미 이 방향을 적어 두었다.
- **단점 1**: 락 획득 지점이 **호출자에 따라 갈린다.** 커널 seam을 통해 들어오면 커널이
  잡아야 하고, import처럼 seam 밖 경로면 그 자리에서 잡아야 한다. 호출자가 없는
  지금은 어느 쪽인지 고를 근거가 없다.
- **단점 2**: 트랜잭션으로 감싸는 쪽은 더 크다 — `getConflict`(동기 프로젝션 읽기)과
  `appendEvent`(비동기)가 한 트랜잭션 안에 들어가야 하고, `rebuildProjectProjection`(`:85`)까지
  포함할지 갈린다. better-sqlite3의 트랜잭션 콜백은 동기라서
  `event-store.ts:158-163`이 적은 제약(비동기 함수는 그 콜백에서 못 부른다)에 그대로 걸린다.

### (d) 근거를 로그 파생으로 바꾼 뒤 (b) — #253/#298/㉰가 세 번 쓴 수법

`getConflict`(프로젝션) 대신 `readEvents` + `reduceProjectState`로 conflict를 얻고, head를
같은 배열에서 뽑아 복수형 CAS에 싣는다. 리포에 선례가 셋 있다 —
`memory-import-service.ts:210-230`(#253), `projection-store.ts:441`(#270),
`consolidate-service.ts:2331`(#298).

**파급 실측**: 프로덕션 **1곳**(`conflict-service.ts:75` 치환 + `:97` 치환 + import 조정).
`getConflict`의 다른 호출부는 이 파일의 `readConflict`(`:17`)뿐이고 그것은 순수 리더라
바뀌지 않는다. 테스트 파급은 (b)와 같은 2개 파일.

- **장점**: §Q1.8의 구별을 만족하는 유일한 CAS 안이다. 이 리포가 세 번 검증한 형태다.
- **단점**: `resolveConflict` 한 번이 **전량 로그 replay**를 사게 된다. #296 §Q3이 그 비용을
  20k 이벤트 스토어에서 +179 ms로 실측했다. 호출자가 없어 호출 빈도를 모르므로 그 교환을
  지금 값 매길 수 없고, 이 함수는 `:85`에서 이미 전량 리빌드를 하므로 상대 비용이 작을
  가능성도 있지만 **그 판단의 입력이 호출자다.**

### Q3 판정

네 안 모두 기술적으로 성립하고, 파급은 (b) 1곳 · (d) 1곳 · (a) 2곳 · (c) 0곳(배선할 것이
없음)이다. **그런데 어느 것을 골라도 지금은 값을 매길 수 없다** — (c)의 획득 지점, (d)의
replay 비용, (a)의 API 표면이 전부 "첫 호출자가 무엇인가"에 달려 있다. 그래서 이 절의
권고는 **선택 자체를 첫 호출자에게 넘기는 것**이고, §Q4가 그 형태를 정한다.

굳이 오늘 하나를 고른다면 **(d)** 다 — CAS 안 중 §Q1.8을 만족하는 유일한 것이고 파급이
1곳이다. (b)를 단독으로 쓰는 것은 권고하지 않는다: CAS는 붙지만 근거는 프로젝션에
남으므로 "닫혔다"고 세기 어려운 자리를 하나 만든다.

## Q4 — `conflict-service`를 지금 고칠 것인가

### 지금 닫자는 쪽

1. **주석은 시간이 지나면 안 읽힌다.** `:41-54`가 14줄로 무엇을 해야 하는지 적고 있지만,
   첫 호출자를 배선하는 사람이 그 파일의 그 자리를 열어 본다는 보장이 규율뿐이다.
2. **파급이 작다.** (d)로 1곳, (a)로 2곳(§Q3 실측). 지금이 가장 싸다.
3. **#189 A의 완료 조건 문구가 이 자리를 명시적으로 센다.** 문구대로면 A는 미완이다.
4. **`resolveConflict`는 이미 락 밖 리빌드를 한다** (`:85`). `projection-store.ts:160-165`이
   *"a new caller that reaches `importMemories` / `resolveConflict` outside the project lock
   would widen this gap"*라고 적는다 — 즉 이 자리는 CAS 축 하나가 아니라 둘이다.

### 지금 닫지 말자는 쪽

1. **관측 가능한 결함이 오늘 0건이다.** 프로덕션 호출부 0건(§Q1.4). 고쳐도 프로덕션
   동작은 한 비트도 달라지지 않는다.
2. **올바른 가드의 모양이 호출자에 달려 있다** (§Q3의 단점 실측). 커널 seam 안이면
   락 획득은 커널 몫이고(`sqlite-memory-kernel.ts:724`, `:794`의 패턴) 서비스는 `signal`만
   받는 형태가 맞다. seam 밖 경로면 `memory-import-service`의 모양(자체 뮤텍스 + 로그 근거
   - CAS + 재시도)이 맞다. **둘은 서로 다른 코드다.** 지금 고르는 것은 추측이다.
3. **#118⑤이 이미 이 질문을 받고 "명문화만"으로 답했다.** 그 결정 이후 바뀐 사실은
   "CAS API가 복수형에 생겼다"뿐이고, 그것은 §Q3 단점 2가 보여주듯 이 자리를 CAS 하나로
   닫히게 만들지 않는다 — 근거가 프로젝션이라는 성질은 그대로다. **새 정보 없이 이전
   결정을 되돌리는 것**이 된다.
4. **테스트만 도는 경로에 동시성 기계를 넣으면 검증이 테스트 자신으로 닫힌다.**
   `#189`가 property test를 기각한 논거와 같은 모양이다 — 그린이 "결함 없음"으로 읽히는데
   그 그린을 만드는 것이 유일한 호출자다.
5. **(d)의 replay 비용은 호출 빈도 없이는 값 매길 수 없다** (§Q3). 지금 정하면
   측정 없이 성능 결정을 하는 것이다.

### 권고 — **지금은 아무것도 하지 않는다**

`resolveConflict`는 오늘 상태로 둔다. 근거는 위 2·3·5다: 파급이 작다는 것(찬성 2)은
사실이지만, **작은 변경을 잘못된 모양으로 넣으면 첫 호출자가 그것을 걷어내야 한다** —
락 획득 지점이 틀린 코드는 없는 코드보다 비싸다.

찬성 1(주석은 안 읽힌다)은 유효한 반론이고, 그것에 대한 답이 아래 트리거 문장이다.
현재 주석은 *"Whoever wires the first real caller must take that lock here — or wrap the
span in a transaction"*까지만 적고, **그 배선 PR이 무엇을 통과해야 하는지**를 적지 않는다.
그 한 줄을 채우는 것이 §Q5 조각 1이다.

### 트리거 문장 초안

`conflict-service.ts:53-54`의 _"— or wrap the span in a transaction (#118 item 5 —
deliberately no CAS added here)"_ 뒤에 이어 붙일 문장이다. 영어로 쓴 것은 이 파일의
주석 언어를 따른 것이다.

```
   * TRIGGER (#301 §Q4): the PR that wires the first production caller of this
   * function closes this span in the SAME PR — a caller landing without it is
   * the whole defect, not a follow-up. Which shape depends on where that caller
   * sits, and #301 §Q3 priced all four:
   *   - Inside the kernel seam (like `observe`/`consolidate`, which take
   *     `withProjectLock` at sqlite-memory-kernel.ts:724/:794 and pass a signal
   *     down): the lock belongs to the kernel, not here. Take a `signal` param
   *     and check it, as capture-service.ts:291 does.
   *   - Outside that seam (like `importMemories`): the shape is
   *     memory-import-service.ts's — a per-project mutex (:85), a LOG-derived
   *     basis (:210-230) replacing the `getConflict` read below, and
   *     `appendEvents(projectId, [input], { expectedHead })` with a pre-append
   *     retry (:239-273).
   * Adding `expectedHead` ALONE does not close it: the basis below is the
   * `conflicts` projection, and a CAS pass says only that the log did not move
   * — not that the projection was fresh (#301 §Q1.8, PR #299 review). Whichever
   * shape is taken, add the interleave test with it: two callers resolving the
   * same `detected` conflict, asserting the loser is refused rather than
   * silently landing a forbidden transition.
```

## Q5 — 후속 조각

**CAS 적용 조각은 0개다.** `expectedHead`를 실을 자리가 더 남아 있지 않다 —
`덮임` 3건은 이미 싣고 있고, `다른 수단으로 덮임` 1건은 CAS가 부적합하며(§Q1.2),
`해당 없음` 2건은 read-then-write가 아니고, `열림` 1건은 §Q4가 지금 손대지 않기로
권고했다.

남는 조각 **2개**는 둘 다 구현이 아니다.

### 조각 1 — `conflict-service.ts`에 트리거 문장을 남긴다

**형태**: `packages/kernel/src/services/conflict-service.ts`의 `:41-54` 주석 블록 끝에
§Q4의 초안을 붙인다. 실행되는 코드 변경 0줄.

**완료 조건 초안**:

- [ ] `resolveConflict`의 주석에, 첫 프로덕션 호출자를 배선하는 PR이 **같은 PR에서**
      이 스팬을 닫아야 한다는 것이 적혀 있다
- [ ] 호출자 위치별로 두 모양(커널 seam 안 → 락은 커널, `signal`만 받는다 / seam 밖 →
      뮤텍스 + 로그 파생 근거 + `appendEvents` CAS + append 이전 재시도)이 각각 실물
      `파일:줄`과 함께 적혀 있다
- [ ] `expectedHead`만 추가하는 것으로는 닫히지 않는다는 것과 그 이유(근거가 프로젝션)가
      적혀 있다
- [ ] 배선 PR이 함께 내야 할 인터리브 테스트의 형태가 한 문장으로 적혀 있다
- [ ] `packages/` 아래 실행 코드 변경 0줄 — `git diff origin/main -- packages/` 출력이
      주석 hunk 하나뿐임을 PR 본문에 첨부
- [ ] `pnpm build` · `pnpm lint` · `pnpm format:check` 통과

**순서 근거**: 선행 없음. `conflict-service.ts`를 만지는 열린 PR이 없다 (PR #302는
`embeddings-store.ts`·`projection-store.ts`·`project-lock.ts`·
`pi-consolidator.test.ts`만 만진다). #189 A를 닫기 전에 머지되는 것이 좋다 — A를 닫으면서
`resolveConflict`를 열린 채 두는 근거가 이 주석이기 때문이다.

**되돌리기 난이도**: 극저. 주석 hunk 하나를 revert하면 끝난다.

### 조각 2 — `docs/compaction-consolidation-boundary.md`의 낡은 인용 갱신

**형태**: 그 문서의 W9(§4.3 표)와 C5(§4.4)가 인용하는 `consolidate-service.ts:2141, 2466`,
그리고 W4가 인용하는 `consolidate-service.ts:2437-2465`가 `db80dfc`에서 다른 코드를
가리킨다 (§부록 F1의 실측). 실물에 맞춘다.

**완료 조건 초안**:

- [ ] W9·C5의 `consolidate-service.ts:2141, 2466`이 실제 자리로 갱신됐다 — head 스탬프
      `:2238-2239`, CAS append `:2693`
- [ ] W4의 `consolidate-service.ts:2437-2465`가 CAS 부분집합 논의의 실제 자리
      (`:2651-2691`)로 갱신됐다
- [ ] 그 문서의 나머지 `consolidate-service.ts` 인용도 같은 기준으로 대조됐다 — 대조한
      목록(맞은 것 포함)을 PR 본문에
- [ ] `packages/` 아래 변경 0줄
- [ ] 서술 내용은 바꾸지 않는다 — W4·W9·C5의 판정("A의 축이 아니다")은 §Q1.1이
      승계했으므로 그대로 둔다

**순서 근거**: 선행 없음, 조각 1과도 독립(다른 파일). PR #302(#300)와 성격이 같지만
파일 교집합이 0이므로 병행 가능하다 — #302는 `packages/` 아래 인용만 고친다.

**되돌리기 난이도**: 극저. 문서 인용 갱신이다.

### #189 A 축을 닫을 수 있는가 — 조건부로 예

**CAS 구현 잔여는 0이다.** #189 A의 완료 조건 문구는 세 자리 전부에 `expectedHead`를
요구했고, 오늘 2/3이 문구대로 충족됐다(§Q2.1, §Q2.2). 세 번째(`#118⑤`)는 §Q4가
**의도적으로 미충족으로 남기기를** 권고한다 — 프로덕션 호출자가 없고, 올바른 가드의
모양이 그 호출자에 달려 있기 때문이다.

따라서 A 축은 **조각 1이 머지되면** 닫을 수 있다. 조각 1이 하는 일은 미충족 한 자리를
"잊힌 잔여"에서 "트리거가 걸린 대기"로 바꾸는 것이고, 그것이 이 산정이 A에 남길 수 있는
가장 정직한 상태다. 조각 2는 A와 무관한 위생 작업이므로 A를 닫는 데 선행이 아니다.

## 부록 — 산정 중 발견한 것 (이 PR에서 고치지 않는다)

`#301` 본문의 지시대로, 산정 중 발견한 실물 어긋남은 여기 적고 §Q5의 조각으로 낸다.

### F1. `docs/compaction-consolidation-boundary.md`의 `consolidate-service.ts` 인용 3건이 낡았다

`db80dfc`에서 실제로 대조한 결과:

| 인용 자리               | 인용된 줄                          | `db80dfc`에서 그 줄이 실제로 무엇인가  | 가리키려던 자리                                       |
| ----------------------- | ---------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| W9 (§4.3 표), C5 (§4.4) | `consolidate-service.ts:2141`      | `recordAttempt`의 outer cell 설명 주석 | head 스탬프 — `:2238` (`probeBoundaryStart`), `:2239` |
| W9 (§4.3 표), C5 (§4.4) | `consolidate-service.ts:2466`      | `#158` 체크포인트 ② 주석               | CAS append — `:2693`                                  |
| W4 (§4.3 표)            | `consolidate-service.ts:2437-2465` | `boundExtractionInput` 호출            | CAS 부분집합 논의 — `:2651-2691`                      |

같은 표의 다른 인용은 맞다 — 예: `capture-service.ts:291`(체크포인트 ①)은 정확하다.

**고치지 않는 이유**: `#301`이 이 이슈의 범위를 "`docs/` 아래 신규 1파일"로 못박았고
`packages/` 변경 0줄을 요구한다. PR #302(#300)가 같은 종류의 작업을 하고 있지만 그
PR은 `packages/` 아래만 만지므로 이 3건은 덮이지 않는다. §Q5 조각 2가 이것이다.

### F2. `memory.injected`가 프로덕션에서 락 밖 유일한 append다 — 이미 등록된 창

§Q1.1의 사실이다. 새 발견이 아니라 `docs/compaction-consolidation-boundary.md`의
W9/C5가 이미 적은 것이고, 그 문서가 "A(#189)의 축이 아니다"로 분류했다. 이 문서는
그 분류를 승계하며 새 조각을 내지 않는다 — 손해는 데이터 손상이 아니라 경계
재시도까지의 벽시계 시간이고, 거절 시 커서가 움직이지 않아 다음 경계가 같은 창을
다시 집는다(`consolidate-service.ts:2686-2692`).

### F3. 이 문서가 각하한 것 — 다시 제안하지 않는다

- **`appendEvent`에 옵션만 미리 추가하기** (§Q3 (a)를 켜는 자리 없이 넣는 것). 쓰는
  자리가 0인 API 표면이 남고, `event-store.ts:291`의 "단수/복수 선택 기준"이 흐려진다.
- **`resolveConflict`에 `expectedHead`만 추가하기** (§Q3 (b) 단독). CAS는 붙지만 근거가
  프로젝션에 남아, §Q1.8의 기준으로 `덮임`이라 세기 어려운 자리를 새로 만든다.
- **워터마크를 로그에 결속하기.** #296 §Q4가 "묶지 않아도 남는 손해 0"으로 판정했고
  `consolidate-service.ts:2201-2210`이 그 근거(커서는 뒤처지기만 한다 + `consumed`가 흡수)를
  적는다. A의 잔여가 아니다.
- **B 축의 남은 후보 둘**(증류 창 유니크, import 정규화 텍스트 유니크). #236이 게이트에서
  뺐고 별개 축이다. §Q1 표에서 해당 자리들이 `다른 수단으로 덮임`인지만 판정했다 —
  genesis만 그렇고(§Q1.2) 나머지 둘은 오늘 유니크 제약이 없다.
