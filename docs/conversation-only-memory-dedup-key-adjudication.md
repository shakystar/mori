# 대화 전용 증류 메모리의 dedup 키 산정 (#352, idea #332, mori-nest#31 답 반영)

`dedupeMemoriesBySource`는 소스 관찰 집합이 빈 메모리를 루프 첫머리에서 건너뛴다
(`packages/kernel/src/projections/projector.ts:238-239`). 그 위 doc 주석이 그것을 의도로 적는다 —
_"Empty/absent source sets never group (each stands alone)"_ (`:229`). 관찰 0 + `transcriptTail`만으로
도는 **대화 전용 증류 경계**는 그 게이트 밖에 놓이고, 그 축에는 `memory-import-service`의
`textKey` 같은 대체 dedup이 없다.

이 문서는 그 축에 dedup 키가 **있어야 하는지**, 있어야 한다면 **무엇이어야 하는지**를 잰다.

**이 문서는 산정이지 스펙이 아니다.** 결론을 MUST/MUST NOT으로 쓰지 않는다. `packages/` 변경은
**0줄**이며, 키 도입은 §Q5가 자른 조각의 몫이다.

## 필수 질문 → 절 매핑

| 질문                                    | 절                                                       | 한 줄 답                                                                          |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1 오늘 중복이 만들어지는 경로가 있는가 | [Q1](#q1--오늘-실제로-중복이-만들어지는-경로가-있는가)   | **있다.** 배열은 실제로 비고, 홀드된 슬라이스의 재증류로 실물 중복 2건을 만들었다 |
| Q2 키는 무엇인가                        | [Q2](#q2--키-후보-넷을-재고-하나를-고른다)               | **후보4 — 증류 입력 내용 해시.** 창 후보는 이 축에서 상수로 붕괴한다              |
| Q3 P3-a lane 규율을 깨는가              | [Q3](#q3--고른-키가-p3-a-lane-규율sot-040을-깨지-않는다) | **깨지 않는다** — lane 조각을 그대로 앞에 두고, 나머지 조각만 갈아 끼운다         |
| Q4 replay 결정성                        | [Q4](#q4--replay-결정성을-지키는가)                      | **결정성은 지킨다.** 대신 **recall이 로컬 예산에 의존**한다 (거짓 양성 아님)      |
| Q5 후속 조각                            | [Q5](#q5--그래서-다음은-무엇인가--조각-3개)              | **3개, 순서 고정**                                                                |

## 0. 기준선

### 0.1 기준 커밋

**`74f2933`** (착수 시점 `main`. PR [#349](https://github.com/shakystar/mori/pull/349)가 머지된 상태).

이 문서의 **모든 `파일:줄` 인용은 이 커밋에서 직접 열어 확인한 것이다.** #352 본문과 #332가 옮겨 적은
인용을 복사하지 않았다 — 이 리포에서 낡은 크로스파일 인용이 이미 일곱 번 사이클을 썼다
(#274·#276, #299, #300·#302, #306, #309·#311, #312, #346). 인용 형식은 `CONTRIBUTING.md`의
「코드 주석의 크로스파일 줄 인용」(`:166-175`)이 정한 리포 루트 상대 경로를 따른다.

### 0.2 §Q1의 실측 방법

§Q1.3의 숫자는 **읽어서 추론한 것이 아니라 돌려서 받은 것이다.** 기준 커밋의 워크트리에
임시 vitest 파일 둘을 놓고 실행한 뒤 지웠다 — 이 이슈는 테스트를 추가하지 않으므로
(`TESTING.md`의 문구 검사 금지 패턴, #352 「테스트」절) **리포에 남지 않는다.** 재현에 필요한
것은 전부 §Q1.3에 적혀 있다: 쓰인 씨앗, 주입한 가짜 `ConversationSource`·`Consolidator`, 그리고
출력.

### 0.3 이 산정의 입력이 된 형제 리포 판정

[mori-nest#31 산정](https://github.com/shakystar/mori-nest/pull/39) (`docs/replica-identity-and-join-adjudication.md`,
기준 커밋 `0c97aa1`)의 결론 둘이 §Q4의 입력이다. **읽기만 했고 그 리포는 건드리지 않는다.**

- **§Q2.1 판정** — _"결정이 적은 전제 «UNIQUE + 커서가 이 감지의 부품을 이미 제공한다» 는 — 거짓이다."_
  전송 평면이 저장하는 행에 _"이 요청이 R1에서 왔다는 사실을 가리키는 바이트가 하나도 없다"_ (§Q2.4).
- **§Q4.1 공백 2** — _"`0003`에 `replica`라는 낱말이 없다"_. 제어 평면이 아는 주체는 subject와
  workspace뿐이고 replica 축은 아직 스펙에 없다.

## Q1 — 오늘 실제로 중복이 만들어지는 경로가 있는가

**있다.** 세 걸음으로 닫는다: (1) 대화 전용 경계가 성립하는 조건이 어느 게이트를 통과해 오는가,
(2) 민팅 지점에서 배열이 비는가, (3) 그 메모리가 **둘 이상 만들어지는** 경로가 실재하는가.

### Q1.1 호출 사슬 — 대화 전용 경계가 통과하는 게이트 둘

`consolidate()`의 내부 `run()`(`packages/kernel/src/services/consolidate-service.ts:2217`)에서,
관찰 0 + `transcriptTail` 존재인 경계가 지나는 자리를 심볼 이름으로 적는다.

| #   | 자리                                                                           | 하는 일                                               | 대화 전용 경계에서                                    |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| 1   | `probeBoundaryStart` (`consolidate-service.ts:1913`, 호출 `:2255`)             | 창 안 self-lane 관찰 수 + head 스탬프                 | `boundaryStart.selfObservations === 0`                |
| 2   | `readConversationOffset` → `source.read(...)` (`:2270-2272`)                   | 대화 슬라이스를 읽어 `transcriptTail`을 만든다        | **`transcriptTail`이 `undefined`가 아니다**           |
| 3   | **비용 게이트** `:2295` — `selfObservations === 0 && !transcriptTail`          | 아무것도 할 게 없는 경계를 로그 replay 전에 잘라낸다  | `transcriptTail`이 있으므로 **통과** (게이트 안 걸림) |
| 4   | **noop 게이트** `:2415` — `observations.length === 0 && !transcriptTail`       | 관찰이 전부 소비됐고 대화도 없으면 커서만 밀고 끝낸다 | 같은 이유로 **통과**                                  |
| 5   | `boundExtractionInput` (`:2455`, 정의 `:721`)                                  | 프롬프트 예산에 맞춰 입력을 자른다                    | `bounded.observations`가 **빈 배열 그대로**           |
| 6   | `const sourceObservationIds = bounded.observations.map((o) => o.id)` (`:2573`) | 민팅에 실릴 출처 배열                                 | **`[]`**                                              |
| 7   | `createConsolidatedMemory({ … sourceObservationIds })` (`:2578`)               | `memory.ts:152`의 `input.sourceObservationIds ?? []`  | 필드가 **빈 배열로 저장된다** (부재가 아니라 `[]`)    |
| 8   | `dedupeMemoriesBySource` (`projector.ts:234`, 호출 `:616`)                     | `if (ids.length === 0) continue;` (`:239`)            | **그룹을 만들지 않고 건너뛴다**                       |

5번이 배열을 비게 두는 근거는 `boundExtractionInput`의 관찰 절 자신이다. 빈 입력에
`Math.max(keptObservations, 1)`의 바닥이 걸려도 결과는 여전히 빈 배열이다 —
`[].slice(0, 1)`은 `[]`이기 때문이다:

```ts
const keptObservations = largestFitting(input.observations.length, (n) => ({
  observations: input.observations.slice(0, n),
  existingMemories: [],
}));
let observations = input.observations.slice(0, Math.max(keptObservations, 1));
```

(`consolidate-service.ts:753-757`)

**3번과 4번이 이 축을 만드는 게이트다.** 둘 다 `&& !transcriptTail`을 달고 있어서, 대화 내용이
있는 한 관찰이 0이어도 경계가 끝까지 간다. 3번 위 주석이 그 의도를 직접 적는다 — #99 cat-1,
_"a conversation-only session (zero observations) still consolidates"_ (`:2261`).

### Q1.2 코드가 이미 같은 사실을 적고 있다

#314가 남긴 후보2 각하 주석이 민팅 지점 바로 위에서 같은 것을 진술한다:

> _"Import always writes it empty (memory-import-service.ts:654-656) and a conversation-only
> boundary also yields `[]` here"_
> (`consolidate-service.ts:2560-2561`)

**다만 이것은 정황이지 판정이 아니다** — 그 주석의 목적은 로그 UNIQUE 인덱스 후보를 각하하는
것이었지 이 축을 판정하는 것이 아니었다. §Q1.3이 실물로 닫는다.

### Q1.3 실측 — 배열이 비고, 같은 창이 두 번 증류된다

**실측 A — 대화 전용 경계 1회.** 관찰 0건, 슬라이스 `"USER: we decided to ship on friday"`,
고정 응답 `[{kind:"decision", text:"ship on friday", salience:5}]`을 내는 가짜 `Consolidator`.
`readEvents`로 `memory.consolidated` 페이로드를 그대로 꺼냈다:

```json
{
  "id": "mem_msho66f3_rilfp084",
  "kind": "decision",
  "text": "ship on friday",
  "salience": 5,
  "sourceObservationIds": []
}
```

결과 요약도 함께: `{ observationsProcessed: 0, consolidated: 1, outcome: "ok" }`.
**배열은 부재가 아니라 빈 배열이고, `projector.ts:239`가 정확히 그것을 건너뛴다.**

**실측 B — 홀드된 슬라이스의 재증류 (중복이 실제로 만들어지는 경로).**
`MEMORIZE_RAW_SEGMENTS=0`으로 원본 버퍼를 끄고, `resumePoints`를 선언하지 않는
`ConversationSource`가 예산을 넘는 슬라이스 하나를 계속 돌려주게 했다. 경계를 두 번 돌렸다.

| 경계 | `read`가 받은 offset | `consolidated` | `conversationSliceHeld` |
| ---- | -------------------- | -------------- | ----------------------- |
| 1    | `0`                  | 1              | `true`                  |
| 2    | **`0`**              | 1              | `true`                  |

그리고 두 경계 뒤 `listValidMemories`:

```json
[
  { "id": "mem_msho7usi_lxhwam6a", "kind": "decision", "text": "ship on friday", "src": [] },
  { "id": "mem_msho7uue_x9r4hbrh", "kind": "decision", "text": "ship on friday", "src": [] }
]
```

**같은 lane · 같은 kind · 같은 정규화 텍스트 · 같은 증류 창인 메모리 둘이 나란히 valid로 남는다.**
관찰 집합이 하나라도 있었다면 `dedupeMemoriesBySource`가 정확히 이 형태를 접었을 것이다.

이 경로의 자리는 코드에 있다. 슬라이스를 소비할 수 없으면 `conversationSliceHeld = true`가 되고
(`consolidate-service.ts:2843`) `conversationOffsetTarget`이 설정되지 않은 채 끝나므로, 다음 경계는
**같은 오프셋에서 같은 슬라이스를 다시 읽는다.** `ConsolidateResult.conversationSliceHeld`의 doc이
_"three ways to hold survive"_ 로 그 셋을 열거한다(`:2004`, 목록 `:2007-2018`) — 실측 B는 그중 1번
(_"The source declares no usable `resumePoints`"_)이다.

### Q1.4 대체 방어선은 있는가 — **있지만 구조적이지 않다**

정직하게 적는다. 이 축이 완전히 무방비인 것은 아니다. 추출 프롬프트가 기존 유효 메모리를 보여 주고
재발행을 금지한다:

> _"Existing valid memories are for deduplication and contradiction checks only. Do not re-emit an
> existing memory unless the new session changes, contradicts, or completes it."_
> (`consolidate-service.ts:383-385`)

**그러나 이 방어선은 확률적인 데다, 예산에 따라 0으로 내려간다.** `boundExtractionInput`은 원본
버퍼가 꺼져 있을 때 꼬리를 **기존 메모리보다 먼저** 예약하고(`reserveTail`, `:851-871`), 남은
예산으로만 메모리를 채운다(`fitMemories`, `:798-805`). 예약이 성립하면서 남는 예산이 없는 구간이
실재한다. 예약이 **실패**했을 때 무슨 일이 생기는지는 코드가 직접 적어 뒀다 —
_"without it every boundary would re-extract the same held slice with no way to notice it is
re-emitting the same memories"_ (`:874-878`). 이 문장이 가정하는 방어선이 바로 아래 표의
0건 구간에서 사라진다.

**실측 C** — 유효 메모리 5건, `maxChars: 2200`, `tailPersistedElsewhere: false`, 꼬리 길이를
1894→2054자로 늘려 가며 `boundExtractionInput`을 직접 호출:

| 꼬리 길이     | `transcriptTailCoverage` | 프롬프트에 실린 기존 메모리 수 |
| ------------- | ------------------------ | ------------------------------ |
| 1894–1910     | `whole`                  | 2                              |
| 1926–1974     | `whole`                  | 1                              |
| **1990–2022** | **`whole`**              | **0**                          |
| 2038–2054     | `clipped`                | 5                              |

**1990–2022자 구간에서 추출기는 기존 메모리를 한 건도 보지 못한다** — 프롬프트의 dedup 지시가
가리킬 대상이 없으므로 그 구간에서 방어선은 완전히 꺼진다. (숫자 자체는 합성 예산의 것이고, 이
표가 주장하는 것은 _"그 구간이 도달 가능하다"_ 뿐이다. 2038에서 값이 5로 튀는 것은 예약이 실패해
`else` 갈래로 떨어지면서 메모리가 예산을 먼저 받기 때문이다 — `:872-879`.)

### Q1.5 Q1 결론

**각하되지 않는다.** 배열은 실제로 비고(실측 A), 같은 창을 두 번 증류해 같은 문장을 두 벌 남기는
경로가 오늘 코드에 있으며(실측 B), 대체 방어선은 구조적이지 않다(실측 C).
그러므로 ②③④로 간다.

## Q2 — 키 후보 넷을 재고 하나를 고른다

### Q2.0 먼저 — 키 재료가 놓일 수 있는 자리는 페이로드뿐이다

`dedupeMemoriesBySource`가 보는 것은 `Record<string, MemoryRecord>` 하나뿐이고
(`projector.ts:234`), `MemoryRecord`는 `ConsolidatedMemory`에 프로젝션이 계산하는 세 필드
(`invalidAt`·`supersededBy`·`dedupedBy`)와 lane(`sourceProjectId`)을 더한 것이다(`projector.ts:36-56`, `dedupedBy` `:39-46`).
**따라서 새 키 재료는 `memory.consolidated` 페이로드에 실려야 한다.** 이것은 취향이 아니라 제약이고,
아래 표의 4열(`replay 결정성`)을 대부분 결정한다.

`meta`에 있는 값은 후보가 될 수 없다. #314 주석이 이미 그 이유를 적었다 —
_"The window's real identity lives in `meta`, not the log: `WATERMARK_META_KEY` (line 90) and
`conversationOffsetKey` (line 1286). Neither rides on an event"_ (`consolidate-service.ts:2563-2565`).

### Q2.1 후보 표

「같은 창」 열은 각 후보가 **무엇이 같으면 두 메모리를 한 창에서 나온 것으로 보는가**이다.

| 후보                                        | 무엇을 「같은 창」으로 보는가                              | 재증류를 잡는가                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 다른 근거의 같은 문장을 잘못 묶는가                                                                                    | replay 결정성                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 경계 창 (`watermark` 구간)**           | 소비한 관찰 이벤트 구간 `(prevWatermark, watermark]`       | **못 잡는다 — 그 이전에 붕괴한다.** 이 축은 관찰이 0이라 워터마크가 움직이지 않는다: `if (bounded.observations.length > 0)`가 거짓이고 스캔된 원시 이벤트도 없으면 `eventWatermarkId`가 `undefined`로 남는다(`consolidate-service.ts:2950-2958`). 회귀 테스트가 그것을 못박는다 — `expect(getConsolidateWatermark(projectId)).toBeUndefined()` (`packages/kernel/tests/integration/consolidate-service.test.ts:2015-2032`). 즉 모든 대화 전용 경계가 **같은 빈 구간**을 갖는다 | **묶는다.** 구간이 상수이므로 키가 `lane+kind+text`로 붕괴한다 — 후보3과 같아진다                                      | 구간을 페이로드에 실으면 결정적. 그러나 구간이 상수라 잡을 것이 없다                                                                                                                                                                                                             |
| **2. 트랜스크립트 슬라이스 범위**           | `source.id` + 보여 준 범위 `[sliceStartOffset, newOffset)` | **잡는다.** 홀드는 오프셋을 그대로 두므로(§Q1.3 실측 B: `read`가 두 번 다 `0`을 받음) 두 경계의 범위가 글자까지 같다                                                                                                                                                                                                                                                                                                                                                           | **묶지 않는다** — 범위가 다르면 키가 다르다. 다만 부분 소비(#144 resume prefix)로 범위가 어긋난 재증류는 놓친다 (미탐) | **위험하다.** 오프셋은 로컬 커서(`conversationOffsetKey`, `:1286`)이고 `source.id`는 하네스가 주는 문자열이다 — 계약이 요구하는 것은 _"이 스토어 안에서 경계·세션을 가로질러 안정"_ 뿐이다(`packages/kernel/src/index.ts:211-215`). **두 replica의 오프셋은 비교 대상이 아니다** |
| **3. 텍스트만** (`lane+kind+정규화 텍스트`) | 문장 자체                                                  | 잡는다 (모든 재발행을 잡는다)                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **잘못 묶는다 — 이것이 이 후보의 실격 사유다.** 아래 §Q2.2                                                             | 결정적 (페이로드 안 값만 씀)                                                                                                                                                                                                                                                     |
| **4. 증류 입력 내용 해시** ✅               | 추출기에 **실제로 보여 준** 대화 바이트의 해시             | **잡는다.** 홀드 재증류는 같은 바이트를 다시 보여 주므로 해시가 같다                                                                                                                                                                                                                                                                                                                                                                                                           | **묶지 않는다.** 다른 대화 바이트 → 다른 해시 → 다른 키                                                                | **결정적.** 해시를 페이로드에 실으면 프로젝터는 순수·내용 기반으로 남는다 (§Q4)                                                                                                                                                                                                  |

### Q2.2 「텍스트만」이 왜 위험한가

이 열을 따로 적으라는 것이 완료 조건 ②의 지시이므로 나눠 적는다.

**(a) 두 사건이 구분되지 않는다.** 「같은 문장을 **다른 근거로 두 번 주장한 것**」과
「**같은 근거를 두 번 센 것**」이 텍스트만으로는 같아 보인다. 앞의 것은 **신호**다 — 서로 다른 두
대화에서 같은 결론이 독립적으로 나왔다는 사실 자체가 정보이고, 뒤의 것만이 결함이다. 텍스트 키는
앞의 것을 뒤의 것으로 취급해 조용히 무효화한다.

**(b) 오늘 키의 설계 의도와 정반대다.** `dedupeMemoriesBySource`의 doc이 그 대칭을 직접 적는다 —
_"same window with different text is N distinct memories, not duplicates; only same window + same
kind + same text … is a true duplicate"_ (`projector.ts:226-229`). 텍스트 키는 그 문장의 앞쪽 절반만
남기고 **창 조건을 통째로 버린다.**

**(c) import 축을 침범한다 — 이 이슈의 비범위다.** import된 메모리도
`sourceObservationIds: []`로 들어온다(`packages/kernel/src/services/memory-import-service.ts:759`).
「빈 집합인 메모리를 텍스트로 묶는다」는 규칙은 대화 증류 메모리와 import 메모리를 **한 그룹에
넣는다.** import 축의 중복은 이미 `textKey` 기반 멱등 가드가 이벤트 로그를 읽어 막고 있고
(`memory-import-service.ts:654-663`), 그 자리는 #352의 비범위다. 후보4는 이 문제가 없다 —
import 경로는 해시 필드를 싣지 않으므로 여전히 오늘처럼 그룹에서 빠진다.

### Q2.3 고른 것 — 후보4, 그리고 정확히 어떤 모양인가

**「증류 입력 내용 해시」를 고른다.** 오늘 키를 갈아 끼우는 것이 아니라 **빈 집합 갈래에만 두 번째
키 산식을 붙이는** 모양이다:

- 민팅 지점(`consolidate-service.ts:2573` 근처)에서 `bounded.transcriptTail`이 있을 때만 그 바이트의
  해시를 페이로드의 새 선택 필드에 싣는다. 관찰이 있는 경계는 오늘과 **동일**하다.
- `dedupeMemoriesBySource`는 `ids.length === 0`일 때 곧장 `continue`하는 대신, 그 필드가 있으면
  `lane \n "tail:"+해시 \n kind \n 정규화 텍스트`로 그룹을 만든다. 필드가 없으면(import, 레거시)
  **오늘처럼 건너뛴다.**

이 모양이 #352의 비범위 셋을 그대로 지킨다: 관찰 집합이 **있는** 메모리의 동작 불변, import
`textKey` 불변, 주입 랭킹 무관.

**왜 「범위」(후보2)가 아니라 「해시」인가.** 오늘 키의 첫 재료인 정렬된 관찰 id는 **로그를 타고
동기화되는 내용**이다 — 그래서 두 replica가 같은 창을 증류하면 키가 일치한다. 그것과 같은 성질을
갖는 대화 축의 재료는 오프셋이 아니라 **바이트**다. 오프셋은 `meta`에 사는 로컬 커서이고
(§Q2.0), replica를 가로질러 같은 값을 뜻한다는 보장이 어디에도 없다.

## Q3 — 고른 키가 P3-a lane 규율(SoT-040)을 깨지 않는다

### Q3.1 오늘 키의 첫 조각이 lane인 이유

키 바로 위 주석이 이유를 적는다:

> _"Dedup is lane-scoped (M2): P3-a collapses SAME-store replica duplicates (same lane, cross-device
> sync), NOT independent assertions from different union writers — a foreign lane must never
> invalidate a self memory (SoT-040). '\n' cannot appear in a lane id, observation id, or `kind`, so
> the key parts can never collide across positions."_
> (`packages/kernel/src/projections/projector.ts:240-244`)

그리고 그 lane 값이 어디서 오는지는 `MemoryRecord.sourceProjectId`의 doc이 적는다 —
_"Set from the consolidating event's `sourceProjectId` when it came from a foreign origin store (a
workspace union), so union reads can group/filter shared memories by writer instead of folding them
into local truth"_ (`projector.ts:50-55`).

### Q3.2 후보4가 그 성질을 지키는 근거 — 셋

1. **lane 조각을 건드리지 않는다.** 제안은 키의 **두 번째** 조각(정렬된 관찰 id)을 빈 집합일 때만
   해시로 대체하는 것이고, `const lane = memory.sourceProjectId ?? SELF_LANE`가 만드는 첫 조각과
   그것을 맨 앞에 두는 순서는 그대로다. 외래 lane 메모리는 여전히 self 메모리와 **다른 키**를
   가지므로 같은 그룹에 들어갈 수 없고, 따라서 winner가 될 수도 loser를 만들 수도 없다.

2. **구분자 불변식이 유지된다.** 위 주석이 근거로 삼는 것은 _"`'\n'` cannot appear in …"_ 다.
   해시는 16진(또는 base64url) 문자열이므로 `'\n'`을 포함할 수 없고, `"tail:"` 접두사가 붙어
   **관찰 id 목록과 해시가 같은 자리에서 충돌하지도 않는다** (관찰 id는 `,`로 이어진 `obs_…`
   토큰이고 `tail:`로 시작할 수 없다).

3. **외래 lane에 새 재료가 생기지 않는다.** 해시는 그 스토어의 대화 슬라이스에서 나오므로,
   외래 lane 메모리가 이 필드를 싣고 들어오더라도 첫 조각이 다른 이상 self 그룹에 닿지 않는다.
   즉 이 제안은 **lane 규율을 우회할 새 경로를 만들지 않는다.**

## Q4 — replay 결정성을 지키는가

### Q4.1 오늘 무엇이 보장되는가

`dedupeMemoriesBySource`의 doc 마지막 문장이 그 보장이다 —
_"Pure + content-keyed → identical result on every replica regardless of sync order"_
(`projector.ts:232-233`). `MemoryRecord.dedupedBy`의 doc도 같은 것을 다른 각도에서 적는다 —
_"`dedupedBy` is projection-computed, deterministic"_, 그리고 이 장치가 겨냥한 사건은
_"same `sourceObservationIds` distilled concurrently on two replicas"_ (`projector.ts:40-45`).

### Q4.2 제약 — 키는 replica 판별에 기댈 수 없다 (mori-nest#31 §Q2)

이 항목의 **입력**이 형제 리포의 판정이다. 「두 사본이 같은 창을 증류했다」를 서버가 알려 주는
길은 오늘 없다:

- **§Q2.1 판정 `거짓`** — _"UNIQUE는 감지의 부품이 아니라 P3가 만드는 피해의 통로이고, 커서는
  감지가 요구하는 종류의 상태가 아니다."_ 저장된 행에 대해 §Q2.4가 못박는다 — _"서버가 본 것:
  `log_id`, `event_id`, payload 바이트. 끝이다. 이 요청이 R1에서 왔다는 사실을 가리키는 바이트가
  하나도 없다."_ 두 사본이 같은 id를 만들면 감지가 아니라 first-write-wins에 의한 **조용한 유실**이다.
- **§Q4.1 공백 2** — _"`0003`에 `replica`라는 낱말이 없다."_ replica 축은 아직 스펙에 없다.

**따라서 키는 스토어 안에서 내용으로 닫혀야 한다.** 「이 메모리를 어느 replica가 만들었나」를 묻는
어떤 조각도 오늘 답을 받을 수 없고, 받게 될 시점도 정해져 있지 않다. 후보2(오프셋 범위)가 여기서
탈락하는 이유가 이것이다 — 오프셋은 replica마다 자기 것이고, 두 오프셋이 같은 대화의 같은 자리를
가리키는지 판정할 주체가 전송 평면에도 제어 평면에도 없다.

### Q4.3 후보4가 시간·수신 순서·로컬 상태에 기대지 않는다

세 축을 나눠 적는다.

| 축            | 후보4는 무엇에 기대는가                                                                                                                                                     | 판정          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **시간**      | 없음. 해시는 민팅 시점에 계산돼 페이로드에 굳는다. 그룹 안 winner 선정은 오늘 그대로 `(createdAt, id)` 오름차순(`projector.ts:252-255`)이고, 그 둘도 이벤트 페이로드 값이다 | 기대지 않는다 |
| **수신 순서** | 없음. 그룹핑은 `Object.values(memories)` 전수 순회 뒤 결정적 정렬이므로, 같은 이벤트 집합이면 도착 순서와 무관하게 같은 키·같은 winner가 나온다                             | 기대지 않는다 |
| **로컬 상태** | 없음 — **프로젝션 시점에는**. 해시가 `meta`나 디스크가 아니라 페이로드에서 오기 때문이다(§Q2.0)                                                                             | 기대지 않는다 |

**대신 정직하게 적어야 하는 것이 하나 있다.** 해시의 **값**은 민팅 시점의 로컬 예산에 의존한다.
`bounded.transcriptTail`은 `extractionCharBudget(params.llm)`이 주는 예산
(`consolidate-service.ts:2475`, 정의 `:526`)과 `MEMORIZE_RAW_SEGMENTS`(`:2474`)에 따라 원본
슬라이스의 전체·접두·꼬리 중 하나다. 컨텍스트 창이 다른 두 replica는 **같은 대화에서 다른 해시**를
낼 수 있다.

그 결과는 **미탐(false negative)이지 오탐이 아니다** — 다른 바이트를 보여 준 두 증류는 애초에
「같은 창」이 아니고, 키가 다르면 아무것도 접히지 않아 오늘과 동일한 상태로 남는다. 정리하면:

- **결정성(같은 로그 → 모든 replica에서 같은 결과)은 지킨다.** 이것이 완료 조건 ④가 요구한 성질이고,
  후보4는 그것을 만족한다.
- **recall(무엇까지 잡는가)은 로컬 예산에 의존한다.** 홀드 재증류(§Q1.3 실측 B)처럼 **같은 기기에서
  같은 예산으로** 같은 슬라이스를 다시 보여 주는 경우는 확실히 잡고, 예산이 다른 기기 사이의
  재증류는 놓친다.

이 절충을 받아들이는 이유는 §Q4.2다. recall을 더 넓히려면 「두 증류가 같은 대화의 같은 자리」임을
바이트 밖에서 판정해야 하는데, 그 주체가 오늘 스펙에 없다.

## Q5 — 그래서 다음은 무엇인가 — 조각 3개

키를 도입하기로 했으므로 조각을 낸다. **순서가 고정돼 있다** — 조각1이 조각2의 입력을 만들고,
조각3은 둘 다 선다. 이 이슈는 **자르기까지**이고 구현은 하지 않는다.

### 조각1 — 페이로드에 증류 입력 해시 필드를 세운다 (동작 변경 없음)

- **범위.** `ConsolidatedMemory`(`packages/kernel/src/domain/entities/memory.ts:92-124`)에 선택 필드
  하나를 더하고, `createConsolidatedMemory`(`:131`)가 그것을 통과시키게 한다. 민팅 지점
  (`consolidate-service.ts:2573-2600`)에서 `bounded.transcriptTail`이 있을 때만 해시를 계산해 싣는다.
  **`dedupeMemoriesBySource`는 이 조각에서 건드리지 않는다** — 필드는 실리기만 하고 아무도 읽지 않는다.
- **이 조각이 먼저인 이유.** 필드가 없는 동안 만들어진 메모리는 영원히 필드가 없다(로그는
  append-only). 키를 먼저 켜면 **켜기 전 메모리와 켠 뒤 메모리가 서로 다른 갈래로 갈라진 채**
  잔여가 고정된다. 필드를 먼저 세워 두면 조각2가 켜질 때 이미 데이터가 쌓여 있다.
- **정해야 할 것.** 해시 함수와 인코딩(예: SHA-256 → base64url), 그리고 **원문이 아니라 해시만**
  싣는다는 것 — 대화 원문이 메모리 페이로드에 실리면 그것 자체가 유출 표면이다
  (`docs/storage-boundary-secrets.md`). 해시도 원문의 **링크**이므로 프롬프트·로그·에러 메시지에
  실지 않는다: 이 값이 필요한 곳은 프로젝터 한 군데뿐이다.
- **빈 값에서 키가 통째로 꺼지거나 통째로 켜지지 않게 한다.** 이 자리가 이 조각의 가장 쉬운
  결함이다. **빈 문자열 꼬리에 해시를 매기면 상수 키가 되어 서로 무관한 메모리가 전부 한 그룹이
  된다.** 오늘 `transcriptTail`은 `slice.text.length > 0`일 때만 세워지므로
  (`consolidate-service.ts:2272`) 자연히 막히지만, 그것은 **다른 자리의 성질**이지 이 필드의
  성질이 아니다 — 필드를 세우는 쪽에서 비어 있지 않음을 직접 확인한다.
- **완료 조건 초안**
  - [ ] 대화 전용 경계 1회 뒤 `memory.consolidated` 페이로드에 필드가 실린다 (테스트 1개)
  - [ ] 관찰이 있는 경계의 페이로드가 **바이트 단위로 이전과 같다** (필드 부재)
  - [ ] import 경로의 페이로드에 필드가 실리지 않는다
  - [ ] 꼬리가 빈 문자열이면 필드가 **부재**다 (상수 해시가 실리지 않는다)
  - [ ] `pnpm build` · `pnpm lint` · `pnpm format:check` 통과, `build-and-test` 초록

### 조각2 — 빈 집합 갈래에 두 번째 키 산식을 붙인다

- **범위.** `dedupeMemoriesBySource`(`projector.ts:234-266`)의 `if (ids.length === 0) continue;`
  (`:239`)를 「필드가 있으면 `lane \n "tail:"+해시 \n kind \n 정규화 텍스트`로 그룹, 없으면 종전대로
  건너뜀」으로 바꾼다. doc 주석의 _"Empty/absent source sets never group"_ 문장(`:229`)을 함께 고친다.
- **선행.** 조각1. (필드 없이는 잡을 것이 없다.)
- **주의.** 필드가 **없는** 메모리의 경로는 오늘과 글자 하나 다르지 않아야 한다 — import 메모리와
  레거시 메모리가 여기로 흘러들면 §Q2.2-(c)의 비범위 침범이 된다.
- **「묶이지 않는다」를 검사하는 테스트는 false-green이 되기 쉽다.** 메모리가 0건이어도
  _"아무것도 무효화되지 않았다"_ 는 참이다. 아래 세 항목은 **먼저 개수를 고정한 뒤**
  무효화 여부를 본다.
- **완료 조건 초안**
  - [ ] §Q1.3 실측 B의 시나리오(홀드된 같은 슬라이스 2회 증류)에서 메모리가 **2건 생성됐고**
        그중 두 번째가 `dedupedBy`를 달고 무효화된다
  - [ ] 서로 다른 대화 바이트에서 나온 같은 문장 둘은 **2건 생성돼 둘 다 valid로 남는다**
        (§Q2.2-(a))
  - [ ] 외래 lane 메모리가 **존재하는 상태에서** self 메모리를 무효화하지 않는다 (§Q3의 회귀)
  - [ ] 같은 텍스트의 import 메모리 **2건이 남아 있고** 이 갈래로 묶이지 않는다
  - [ ] `pnpm build` · `pnpm lint` · `pnpm format:check` 통과, `build-and-test` 초록

### 조각3 — 홀드 자체를 관측 가능하게 남길지 정한다 (선택, 후순위)

- **왜 있는가.** §Q1.3 실측 B의 중복은 **홀드의 증상**이다. 키는 증상을 접지만 원인(대화 축이
  핀된 상태)은 그대로다. `conversationSliceHeld`가 이미 결과와 attempt 텔레메트리에 실리므로
  (`consolidate-service.ts:1556`, `:2023`) **새 상태를 만들 필요는 없고**, 연속 홀드를
  `mori status` 같은 표면에 드러낼지가 남은 판단이다.
- **선행.** 조각2. **이 조각은 dedup 축이 아니므로 별도 idea로 열려도 된다** — 여기 적는 것은
  「키를 넣어도 남는 것」을 다음 사람이 잊지 않게 하기 위해서다.

---

**비범위 재확인 (#332에서 승계).** 관찰 집합이 **있는** 메모리의 키, import 경로 `textKey` dedup,
주입 랭킹의 텍스트 dedup([#310에서 「오늘 결함이 아니다」로 판정](https://github.com/shakystar/mori/issues/310)),
그리고 mori-nest 쪽 스펙 — 이 문서는 어느 것도 건드리지 않는다.
