# pi `AgentHarness` 채택 비용 산정 (#287, #7 사람 결정 1안)

로드맵 [#7](https://github.com/shakystar/mori/issues/7)의 압축 경계 seam이
[2026-08-05 08:59 사람 결정](https://github.com/shakystar/mori/issues/7#issuecomment-5189884614)으로
**1안(pi `AgentHarness` 채택)** 으로 닫혔다. 이 문서는 그 방향을 실물에 적용해서
**이주가 무엇을 얻고 무엇을 잃는지, 그리고 몇 조각으로 잘리는지**를 적는다.

`docs/compaction-consolidation-boundary.md`·`docs/storage-boundary-secrets.md`와 같은
규율을 따른다: **코드가 정본이고 이 문서는 그 지도다.** 아래의 모든 인용은 §0의 기준선
시점 실물이며, 코드와 어긋나면 코드를 따르고 이 문서를 고친다.

이 문서는 **구현하지 않는다.** `packages/` 아래 실행 줄을 한 줄도 바꾸지 않았다.
`AgentHarness` 배선은 §7이 자르는 조각의 몫이다.

## 0. 기준선

- 기준 커밋: `dbfc7ab` (PR #288 머지 직후). 인용한 줄 번호는 이 시점의 것이다.
- 대상 버전: `packages/mori/package.json`이 고정한 `@earendil-works/pi-agent-core`
  **0.82.1**, `@earendil-works/pi-ai` **0.82.1**.
- pi 쪽 인용의 경로 접두사는 모두
  `packages/mori/node_modules/@earendil-works/pi-agent-core/` 이며, 아래에서는
  **`pi/`** 로 줄여 쓴다 (예: `pi/dist/harness/types.d.ts:444`). 판단 근거는
  `node_modules` 안의 실물(`.d.ts` · 컴파일된 `.js`)이지 upstream 문서가 아니다.
- 기존 정본 문서 `docs/compaction-consolidation-boundary.md`는 **열어서 읽기만 했다**
  (§6). 그 파일을 고치는 것은 [#285](https://github.com/shakystar/mori/issues/285)의 몫이다.

---

## Q1. `AgentHarness`의 export 표면

[02:58 로드맵 점검](https://github.com/shakystar/mori/issues/7#issuecomment-5188061118)이
이름으로 거명한 여덟 개를 0.82.1 실물에서 전수 확인했다.

### 판정표

| 이름                     | 판정                                     | 근거 (0.82.1 실물)                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentHarness`           | **export** (클래스)                      | `pi/dist/harness/agent-harness.d.ts:4` 선언, `pi/dist/index.d.ts:4`가 `export * from "./harness/agent-harness.ts"`로 루트에 올림                                                                                               |
| `compact()`              | **export** (둘 다)                       | 하네스 메서드 `pi/dist/harness/agent-harness.d.ts:64`, 자유 함수 `pi/dist/harness/compaction/compaction.d.ts:106` + `pi/dist/index.d.ts:6` 명시 재export                                                                       |
| `prepareCompaction`      | **export**                               | `pi/dist/harness/compaction/compaction.d.ts:103`, `pi/dist/index.d.ts:6`                                                                                                                                                       |
| `findCutPoint`           | **export**                               | `pi/dist/harness/compaction/compaction.d.ts:72`, `pi/dist/index.d.ts:6`                                                                                                                                                        |
| `shouldCompact`          | **export** — 다만 하네스가 부르지 않는다 | `pi/dist/harness/compaction/compaction.d.ts:57`, `pi/dist/index.d.ts:6`. 호출부 전수 검색 결과 `pi/dist` 안에 **0건** (아래 "거명되지 않은 부재" ①)                                                                            |
| `estimateContextTokens`  | **export** — 임계 판정에는 안 쓰인다     | `pi/dist/harness/compaction/compaction.d.ts:55`, `pi/dist/index.d.ts:6`. 호출부는 `pi/dist` 안에 1건 — `prepareCompaction`이 `tokensBefore`를 채울 때 (`compaction.js:451`). **`shouldCompact`에 넘기는 자리는 없다** (아래 ①) |
| `SessionTreeEntry`       | **export** (타입)                        | `pi/dist/harness/types.d.ts:306` 유니온 선언, `pi/dist/index.d.ts:18`이 `export * from "./harness/types.ts"`                                                                                                                   |
| `session_before_compact` | **export** (타입 + `on()` 훅 채널)       | 이벤트 `pi/dist/harness/types.d.ts:444-450`, 결과 `:534-537`, 결과맵 `:558`. 발화는 `pi/dist/harness/agent-harness.js:655-661`의 `emitHook`                                                                                    |
| `session_compact`        | **export** (타입) — **채널이 다르다**    | 이벤트 `pi/dist/harness/types.d.ts:451-455`, 결과맵 `:559`. 발화는 `pi/dist/harness/agent-harness.js:674`의 **`emitOwn`** (아래 "거명되지 않은 부재" ②)                                                                        |

**부재는 없다.** 거명된 여덟 이름 전부 0.82.1의 public export이므로, 사람 결정의 운용
원칙 3(포크·복제가 아니라 upstream export PR)이 **이 여덟 개에 대해서는 걸리지 않는다.**
지금 시점에 upstream에 요청할 export는 없다.

### 거명되지 않았지만 이주에 걸리는 것 넷

판정표가 그린이라고 이주가 공짜인 것은 아니다. export 표면이 아니라 **동작**에서
걸리는 자리가 넷 있다. 이것이 이 절의 진짜 산출이다.

**① 하네스에는 자동 압축이 없다.** 임계 판정 함수 `shouldCompact`의 호출부는
`pi/dist` 전체에서 **0건**이다 — 정의(`compaction.js:157`)와 재export(`index.js:8`)뿐이다.
`estimateContextTokens`는 호출부가 1건 있지만 그것은 `prepareCompaction`이 이미 결정된
압축의 `tokensBefore`를 채우는 자리이지(`compaction.js:451`) **"압축할 때인가"를 묻는
자리가 아니다.** 두 값을 이어 붙여 판정을 만드는 코드가 pi 안에 없다. `compact()`는
**호출자가 명시적으로 부를 때만** 돈다 (`pi/dist/harness/agent-harness.js:640`), 그것도
`phase !== "idle"`이면 `AgentHarnessError("busy")`로 끝난다 (`:641-642`). 즉
**"하네스를 채택하면 압축 트리거가 따라온다"는 읽기는 실물과 어긋난다** — 따라오는 것은
압축의 *실행*과 *기록*이고, **"언제 압축하는가"의 판정 호출부는 mori가 만들어야 한다.**
판정에 쓸 재료(임계식 `contextTokens > contextWindow - reserveTokens`,
`pi/dist/harness/compaction/compaction.js:157-161`, 기본값 `enabled: true` /
`reserveTokens: 16384` / `keepRecentTokens: 20000`, `:88-92`)는 그대로 쓸 수 있다.

**② `session_compact`는 `on()`이 아니라 `subscribe()`로 온다.** `AgentHarnessEventResultMap`이
`session_compact`를 키로 갖고 있어(`pi/dist/harness/types.d.ts:559`)
`on("session_compact", handler)`가 타입 검사를 통과하지만, 발화 경로는
`emitOwn`(`pi/dist/harness/agent-harness.js:674`)이고 `emitOwn`은 구독자 채널
`SUBSCRIBER_EVENT_TYPE = "*"`의 핸들러만 순회한다 (`:161-170`, 상수는 `:98`).
`on()`이 등록하는 곳은 타입별 채널이다 (`:955-963`). 그래서 `on("session_compact", …)`로
등록한 핸들러는 호출되지 않는다. **압축 완료 통보를 받는 자리는 `subscribe()`다.**
같은 성질이 `session_tree` · `save_point` · `settled` · `abort` · `queue_update` ·
`retry_*` · `model_update` · `thinking_level_update` · `tools_update` ·
`resources_update`에도 적용된다 (`AgentHarnessOwnEvent`,
`pi/dist/harness/types.d.ts:508`).

**③ `toolExecution` 설정이 하네스 옵션에 없다.** `AgentHarnessOptionsBase`
(`pi/dist/harness/types.d.ts:648-672`)에 그 필드가 없고, 하네스가 만드는 루프 설정
(`pi/dist/harness/agent-harness.js:356-409`)도 그것을 넣지 않는다. 루프의 기본값은
`"parallel"`이다 (`pi/dist/types.d.ts:216-226`의 _"Default: parallel"_). 자세한 것은 §2.

**④ `streamFn` 주입점이 하네스 옵션에 없다.** 하네스는 스트림 함수를 스스로 만들고
`this.models.streamSimple(...)`로 고정한다 (`pi/dist/harness/agent-harness.js:319-341`).
저수준 `Agent`는 `streamFn`이 **필수 옵션**이었다 (`pi/dist/agent.d.ts:9`). 자세한 것은 §2.

①③④는 **export가 없어서 생긴 것이 아니라 하네스의 설계가 그런 것**이므로 upstream
export PR로 풀 문제가 아니다. ②는 upstream 쪽 표면과 발화의 어긋남으로 보이지만,
`subscribe()`라는 성립하는 경로가 이미 있으므로 이주를 막지 않는다 — 보고 대상이지
차단 요인이 아니다.

---

## Q2. 오늘의 `createMoriAgent` 구성 요소가 하네스에서 어디로 가는가

`packages/mori/src/agent/index.ts:77-93`이 저수준 `Agent`에 넘기는 것 전부와,
`MoriKernel`의 `drain`(`:30-33`)이다.

| 오늘의 항목                                         | 판정                               | 어디로 / 무엇을 잃는가                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialState.systemPrompt` (`agent/index.ts:79`)   | **대응 있음**                      | `AgentHarnessOptions.systemPrompt` (`pi/dist/harness/types.d.ts:662`). 문자열 그대로도 되고, 세션·모델·활성 툴·리소스를 받는 콜백도 된다 (`:641-647`)                                                                                                                                                                                                                                                                       |
| `initialState.model` (`agent/index.ts:80`)          | **대응 있음**                      | `AgentHarnessOptions.model` (`pi/dist/harness/types.d.ts:667`), 런타임 교체는 `setModel` (`pi/dist/harness/agent-harness.d.ts:72`). 추가로 `models: Models`가 **필수**가 된다 (`types.d.ts:655`) — `createMoriModels`가 반환하는 `MutableModels`가 `Models`를 확장하므로(`pi-ai/dist/models.d.ts:124`) 그대로 들어간다                                                                                                      |
| `initialState.tools` (`agent/index.ts:81`)          | **대응 있음 — 시그니처가 바뀐다**  | `AgentHarnessOptions.tools?: TTool[]` (`types.d.ts:656`). 다만 `AgentHarnessTool`은 `execute`에 **다섯 번째 인자 `context: TContext`** 를 붙인 형태다 (`types.d.ts:58-61`). mori가 컨텍스트를 안 쓰면 `TContext = undefined`로 두면 되고, 그때 `toolContext`는 선택 필드다 (`:673-679`). 툴 5개의 `execute` 시그니처를 넓히는 기계적 변경                                                                                   |
| `transformContext` (`agent/index.ts:83`)            | **대응 있음 — 한계도 그대로**      | `context` 훅. 하네스가 루프의 `transformContext` 슬롯에 `emitHook({type:"context", …})`를 꽂고 `result?.messages ?? messages`를 돌려준다 (`pi/dist/harness/agent-harness.js:358-361`). 결과 타입은 `ContextResult { messages }` (`types.d.ts:514-516`). **반환값의 수명은 §5대로 바뀌지 않는다**                                                                                                                            |
| `streamFn` (`agent/index.ts:84`)                    | **대응 없음**                      | 하네스는 `this.models.streamSimple(...)`로 고정한다 (`agent-harness.js:319-341`). **잃는 것: 함수 하나를 꽂아 프로바이더를 통째로 대체하던 테스트 seam.** 오늘 `RunCliDeps.streamFn`(`packages/mori/src/cli/types.ts:9`)이 그 seam이고, `runtime.ts:89`를 거쳐 `repl.test.ts`·`agent/index.test.ts`의 거의 모든 케이스가 이것으로 돈다. 등가는 `Models`에 가짜 provider를 등록하는 것(`models.setProvider`)이다 — §7 조각 B |
| `beforeToolCall` (`agent/index.ts:85`)              | **대응 있음**                      | `tool_call` 훅. 하네스가 루프의 `beforeToolCall`에 꽂는다 (`agent-harness.js:362-370`), 결과는 `ToolCallResult { block?, reason? }` (`types.d.ts:523-526`) — 오늘 `createBashBeforeToolCall`이 돌려주는 모양과 같다 (`packages/mori/src/tools/bash.ts:115-120`)                                                                                                                                                             |
| `toolExecution: "sequential"` (`agent/index.ts:90`) | **대응 없음 — 대체 경로 있음**     | 아래 별도 항목                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent.subscribe(observe)` (`agent/index.ts:93`)    | **대응 있음 — 이벤트가 넓어진다**  | `AgentHarness.subscribe` (`pi/dist/harness/agent-harness.d.ts:89`). 받는 것은 `AgentHarnessEvent = AgentEvent \| AgentHarnessOwnEvent` (`types.d.ts:509`). 커널의 `observeEvent`는 `ToolCallObserver<AgentEvent>`(`packages/mori/src/kernel/index.ts:137`)이므로, 넓어진 유니온을 좁히거나 커널의 `E`를 넓히는 선택이 생긴다. 좁히는 쪽이 작다 — 관찰자는 이미 모르는 타입을 `undefined`로 흘린다 (`kernel/index.ts:152`)   |
| `createMoriTools` (`agent/index.ts:75`)             | **대응 있음**                      | 위 `tools` 행과 같다. 툴 **선택**(`options.tools ?? createMoriTools(...)`)은 mori 쪽 코드이므로 그대로 남는다                                                                                                                                                                                                                                                                                                               |
| `MoriKernel.drain()` (`agent/index.ts:30-33`)       | **대응 없음 — 그러나 잃지 않는다** | 하네스에 `drain` 상당이 없다. `waitForIdle()`은 **하네스의 런**이 끝나기를 기다리는 것이지(`agent-harness.d.ts:88`) 커널이 큐에 넣은 쓰기를 정산하지 않는다. `drain`은 애초에 `MemoryKernel` 위에 mori가 얹은 것이고(`agent/index.ts:20-33`의 doc), 호출자는 mori 자신이다 (`packages/mori/src/index.ts:107`, `cli/runtime.ts`). **하네스 이주와 무관하게 그대로 남는다**                                                   |

### `toolExecution: "sequential"` — 특히 주의해서 본 자리

오늘 그 값을 고른 이유가 코드 주석에 그대로 있다 (`packages/mori/src/agent/index.ts:86-90`):

> bash is not a sandbox (arbitrary reads/writes anywhere the host user can reach) and
> `edit_file` performs its own read-modify-write cycle; running either concurrently with
> another tool call risks racing on the same files with no isolation to fall back on.
> Sequential is the safe default until per-tool concurrency is audited.

**하네스는 이 설정을 받지 않는다** (§Q1 ③). 그대로 이주하면 루프 기본값 `"parallel"`이
적용되고, 한 assistant 메시지에 담긴 여러 툴 콜이 동시에 실행된다 — 즉 **이주가 조용히
안전성을 되돌리는** 자리다.

다만 **같은 효과를 내는 다른 경로가 있다.** 루프의 분기는 둘 중 하나만 참이면 순차로 간다
(`pi/dist/agent-loop.js:287-294`):

```js
const hasSequentialToolCall = toolCalls.some(
  (tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) { … }
```

`executionMode`는 `AgentTool`의 선택 필드이고 (`pi/dist/types.d.ts:343-350`),
`AgentHarnessTool`은 `AgentTool`에서 `execute`만 갈아끼운 타입이므로
(`pi/dist/harness/types.d.ts:58-61`) 그 필드를 그대로 갖는다. 그래서
**`bash`와 `edit_file` 툴 정의에 `executionMode: "sequential"`을 다는 것이 등가 대체**다.
범위가 좁아지는 차이는 있다 — 오늘은 _모든_ 툴 콜이 순차이고, 대체 후에는
*그 두 툴이 섞인 메시지*가 순차다. 주석이 근거로 든 위험(파일 레이스)은 그 두 툴에만
붙어 있으므로 이 좁힘은 주석의 근거와 어긋나지 않는다. 단 `read_file`/`list_dir`/`grep`
셋만 담긴 메시지는 병렬로 가게 되며, 그 셋은 `TOOL_CAPTURE`가 `read-only`로 분류한
툴이다 (`packages/mori/src/kernel/index.ts:54-60`).

**순서가 중요하다.** 이 대체를 이주보다 **먼저** 하면 두 상태 모두에서 안전성이 유지된다
(오늘은 `toolExecution`과 `executionMode`가 OR로 겹치므로 무해). 이주와 같은 조각에서
하면 리뷰가 그 한 줄을 놓칠 때 조용히 되돌아간다. §7 조각 A가 이 이유로 첫 조각이다.

---

## Q3. 경계 판정 — "세션의 형태 = pi / 기억의 의미 = mori"

사람 결정이 준 기준을 Q2의 항목과 압축 경로에 적용한다.

| 항목                                    | 어느 쪽                      | 근거                                                                                                                        |
| --------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 세션 트리·엔트리·리프                   | **pi**                       | `SessionTreeEntry`·`Session`이 pi의 타입이고 하네스가 직접 append한다 (`agent-harness.js:454-459`)                          |
| 압축의 실행(요약 생성·엔트리 기록)      | **pi**                       | `compact()` 한 메서드 안에 준비·요약·기록이 다 있다 (`agent-harness.js:640-684`)                                            |
| 압축의 **판정**(언제 부르는가)          | **mori**                     | 하네스가 부르는 곳이 없다 (§Q1 ①). 재료는 pi 것을 쓴다 — 두 번째 임계를 만들지 않는다는 정본 문서 §6.1의 기본안과 같은 방향 |
| 압축된 메시지의 **의미**(무엇을 남길지) | **mori**                     | `session_before_compact`가 넘겨주는 것을 커널 증류 입력으로 쓴다 — 아래 참조                                                |
| 툴 실행 순서                            | **pi(설정) + mori(툴 정의)** | 설정 필드는 사라지고 툴 정의의 `executionMode`가 남는다 (§Q2)                                                               |
| 관찰(툴 콜) 캡처                        | **mori**                     | `subscribe`로 받은 `AgentEvent`를 커널이 해석한다. 이주로 바뀌지 않는다                                                     |
| retrieval 재주입                        | **mori**                     | `context` 훅. 수명 한계도 그대로 (§5)                                                                                       |
| 세션 저장의 **장소와 포맷**             | **선택 사항**                | `Session`은 하네스의 필수 옵션이지만 `SessionStorage`는 인터페이스다 (§4)                                                   |

### 가장 중요한 한 자리 — 잘려나갈 메시지를 증류 입력으로 넘길 수 있는가

**예.** 타입 수준에서 성립한다.

훅 이벤트의 시그니처 (`pi/dist/harness/types.d.ts:444-450`):

```ts
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionTreeEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}
```

`CompactionPreparation` (`pi/dist/harness/types.d.ts:600-610`):

```ts
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  retainedTail: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}
```

`preparation.messagesToSummarize`가 **정확히 잘려나갈 메시지들**이고 타입은
`AgentMessage[]` — mori가 이미 커널의 `M`으로 쓰고 있는 바로 그 타입이다
(`packages/mori/src/agent/index.ts:30`의 `MemoryKernel<AgentMessage, AgentEvent>`).
`turnPrefixMessages`(턴이 쪼개질 때의 앞부분)와 `retainedTail`(남는 꼬리)까지 같이
오므로, "무엇이 사라지고 무엇이 남는가"를 커널 쪽에서 구분할 수 있다.
발화 지점은 압축 엔트리를 append하기 **전**이다 (`agent-harness.js:655-661` → 기록은
`:671`), 그래서 훅은 드랍이 랜딩하기 전에 원문을 본다.

세 가지 단서를 함께 적는다 — 배선하는 조각이 알고 시작해야 하는 것들이다.

1. **훅이 던지면 압축 전체가 실패한다.** `emitHook`은 핸들러의 예외를
   `normalizeHookError`로 감싸 다시 던지고 (`agent-harness.js:181-198`),
   `compact()`는 그것을 `AgentHarnessError("compaction", …)`로 바꿔 호출자에게 던진다
   (`:678-680`). 커널의 `transformContext`·`observe`가 "던지지 않는다"를 규율로 삼은 것과
   같은 이유가 이 자리에도 적용된다 (`sqlite-memory-kernel.ts:429-434`의 doc).
2. **`signal`은 발화 시점에 새로 만든 컨트롤러의 것이다** —
   `signal: new AbortController().signal` (`agent-harness.js:660`). 그 컨트롤러에 대한
   참조를 아무도 갖고 있지 않으므로 이 신호는 발화되지 않는다. 커널의 협조적 취소
   경로를 이 신호에 걸면 아무것도 취소되지 않는다. 요약 LLM 호출에 넘어가는 signal도
   `undefined`다 (`:667`의 다섯 번째 인자).
3. **핸들러가 여럿이면 마지막 non-undefined 결과가 이긴다** (`agent-harness.js:186-192`).
   `SessionBeforeCompactResult`(`types.d.ts:534-537`)로 `cancel: true`를 돌려주면 압축이
   `AgentHarnessError("compaction", "Compaction cancelled")`로 끝나고 (`:662-663`),
   `compaction`을 돌려주면 pi의 요약 생성을 통째로 대체한다 (`:664-667`). 즉 이 훅은
   "구경"이 아니라 **압축의 결정권**을 갖는다 — 커널이 관찰만 하려면 `undefined`를
   돌려주면 된다.

압축 **완료** 통보는 `subscribe()`로 받는다 (§Q1 ②). `SessionCompactEvent`가
`compactionEntry: CompactionEntry`를 실어 오므로 (`types.d.ts:451-455`), 요약 문자열과
`retainedTail`과 `tokensBefore`가 그 자리에서 다 보인다 (`:263-272`). 정본 문서 §6.3이
말한 post-compact 증류 트리거를 거는 자리가 여기다.

---

## Q4. 데이터 소유 — 하네스가 무엇을 어디에 저장하는가

### 무엇을

세션 트리의 엔트리 전부다. `SessionTreeEntry`는 11개 변종의 유니온이고
(`pi/dist/harness/types.d.ts:306`), 그중 대화·압축과 직접 관계있는 것은
`MessageEntry`(`:246-249`)와 `CompactionEntry`(`:263-272`)다:

```ts
export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore: number;
  retainedTail?: AgentMessage[];
  details?: T;
  usage?: Usage;
  fromHook?: boolean;
}
```

즉 **압축 요약과 `retainedTail`은 세션 트리 엔트리 하나에 같이 실린다.** 그 엔트리가
있으면 컨텍스트 조립이 "압축 엔트리 + 그 이후"만 남기고 앞을 버린다
(`pi/dist/harness/session/session.js:23-52`의 `defaultContextEntryTransform`) — 이것이
"압축이 세션을 줄인다"의 실제 메커니즘이며, 오늘 `transformContext`가 못 하는 일이다
(§5).

### 어디에

**하네스는 장소를 정하지 않는다.** `AgentHarnessOptions.session: Session`이 필수일 뿐
(`types.d.ts:649`), `Session`은 `SessionStorage` 인터페이스 위에 있다
(`pi/dist/harness/session/session.d.ts:16-19`, 인터페이스는 `types.d.ts:337-353`).
0.82.1이 함께 주는 구현은 둘이다:

| 구현                        | 장소                                               | 근거                                                                                             |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `InMemorySessionStorage`    | 프로세스 메모리. 종료하면 사라진다                 | `pi/dist/harness/session/memory-storage.d.ts:2`                                                  |
| `JsonlSessionStorage`       | JSONL 파일 1개 = 세션 1개                          | `pi/dist/harness/session/jsonl-storage.d.ts:4`                                                   |
| (`JsonlSessionRepo`가 관리) | `sessionsRoot`는 **생성자 인자**이고 기본값이 없다 | `pi/dist/harness/session/jsonl-repo.d.ts:7-10`, `jsonl-repo.js:13-26`. 경로를 정하는 것은 호출자 |

세 번째 선택지로 **mori가 `SessionStorage`를 직접 구현**할 수도 있다 (인터페이스가
public이므로). 운용 원칙 2가 정확히 여기에 걸린다.

### 이중 저장인가

**오늘 기준으로는 아니다.** 두 저장소가 담는 것이 다르다:

- 커널의 이벤트 로그는 **관찰과 메모리**를 담는다 — `observation.captured`(툴 콜의
  경로·명령어), 증류된 `memory.*`, `memory.injected`. 대화 메시지 원문은 담지 않는다.
- 세션 트리는 **대화 메시지**를 담는다.

교집합이 생기는 지점은 하나다: **`ConversationSource`가 배선되는 순간.** 그 seam이
배선되면 경계가 대화 원문을 읽어 세그먼트로 쓰기 시작하고
(`docs/compaction-consolidation-boundary.md` §0-4, §6.2), 그때 같은 대화 텍스트가
세션 트리(pi 포맷)와 커널 세그먼트 테이블(mori 포맷) 양쪽에 남는다. 오늘 그 seam은
미배선이다 — `createMoriKernel`이 커널에 넘기는 옵션에 `conversation`이 없다
(`packages/mori/src/kernel/index.ts:620-635`).

**"mori가 자기 포맷으로 저장을 시작해야 하는 지점이 있는가": 아니오** — 하네스 채택
자체는 그 지점을 만들지 않는다. 근거 셋:

1. 세션 저장이 필요 없으면 `InMemorySessionStorage`로 충분하고, 그것이 오늘의 동작
   (프로세스가 끝나면 대화가 사라진다)과 등가다.
2. 세션 저장이 필요해지면 `JsonlSessionRepo`가 **pi 타입과 호환되는 포맷**을 이미 준다 —
   운용 원칙 2가 우선하라고 한 바로 그 조건이다.
3. mori 자체 `SessionStorage` 구현(예: SQLite)은 **지금 필요하지 않다.** 그것이
   필요해지는 것은 "대화와 메모리를 한 트랜잭션에 묶고 싶다"는 요구가 생길 때이고,
   그 요구는 `ConversationSource` 배선과 같이 온다 — 별개 조각, 별개 결정.

두 저장소가 갈라질 수 있는 자리는 하나 있고, 지금 등재해 둔다: **세션 엔트리 append와
커널 이벤트 append는 서로 다른 파일이고 하나의 트랜잭션으로 묶이지 않는다.** 프로세스가
그 둘 사이에서 죽으면 "대화에는 있는데 관찰에는 없는" 또는 그 반대의 구간이 남는다.
오늘도 같은 성질이 커널 큐와 프로세스 종료 사이에 있고(정본 문서 §2.2-a의 W7), 세션
저장을 켜면 축이 하나 늘어난다. 대칭 복구가 필요한 성질이 아니라 — 정본이 갈리지 않으므로
— **기록해 두고 조각 C가 어느 저장소를 정본으로 삼는지 명시하면 된다.**

---

## Q5. `transformContext`의 알려진 한계가 하네스 위에서도 그대로인가

**그대로다.** 하네스는 이 한계를 우회하지 않는다.

정본 문서 §0-2가 확인한 사실은 루프 안에 있다
(`pi/dist/agent-loop.js:178-183`, 함수 `streamAssistantResponse`):

```js
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}
```

`messages`는 지역 변수이고 `context.messages`는 재대입되지 않는다. **하네스는 이 슬롯을
그대로 쓴다** — `createLoopConfig`가 같은 `transformContext` 키에 `context` 훅을 꽂는다
(`pi/dist/harness/agent-harness.js:356-361`):

```js
transformContext: async (messages) => {
  const result = await this.emitHook({ type: "context", messages: [...messages] });
  return result?.messages ?? messages;
},
```

그래서 `context` 훅에서 prepend한 것은 그 프로바이더 요청 하나에만 살고, 드랍한 것은
다음 호출에 그대로 돌아온다. 하네스에서는 **한 겹 더 강해진다**: 다음 턴의 메시지는
`createTurnState`가 `session.buildContext()`로 세션에서 다시 만들고
(`agent-harness.js:277-278`), `prepareNextTurn`이 매 턴 그것을 갈아끼운다
(`:396-405`). 훅의 반환값은 세션에 닿지 않는다.

**retrieval 재주입 경로는 이주로 좋아지지도 나빠지지도 않는다.** 커널이 매 요청마다
블록을 다시 붙이는 규율(`sqlite-memory-kernel.ts:441-474`, `TurnRetrieval` doc은 `:256-278`)이
그대로 필요하고 그대로 동작한다. 훅 이름과 결과 타입만 바뀐다
(`(messages, signal) => M[]` → `{type:"context", messages} → ContextResult | undefined`).

한 가지 차이는 **신호의 모양**이다. 오늘 커널은 `transformContext(messages, signal)`의
두 번째 인자로 취소 신호를 받아 취소된 턴이 세션의 시도를 소모하지 않게 한다
(`sqlite-memory-kernel.ts:446-449`). 하네스의 `context` 훅 이벤트에는 `signal` 필드가
없고 (`ContextEvent`, `pi/dist/harness/types.d.ts:408-411`), `emitHook`은 signal을
넘기지 않는다 (`agent-harness.js:181-198`). **잃는 것: 훅 인자로 오던 취소 신호.**
대체는 있다 — `subscribe` 리스너는 signal을 받고 (`agent-harness.d.ts:89`), 하네스가
런마다 새 `AbortController`를 만들어(`agent-harness.js:515`) 루프와 리스너에 함께
넘기므로 (`:523`) 구독으로 받은
signal을 커널에 넘기는 배선이 가능하다. 이것은 조각 D가 등가로 유지해야 하는 항목이다.

**압축 축에서는 달라지는 것이 하나 있다.** 정본 문서 §5.2 R5가 _"압축된 대화 원문의
커널 재주입은 0이고 그 축의 안전망은 압축 요약뿐"_ 이라고 적었는데, 오늘은 그 요약을
만드는 주체 자체가 없다. 하네스를 채택하면 요약과 `retainedTail`이 실제로 생기고
세션에 남는다 (§4). 이것은 **재주입 경로의 개선이 아니라 다른 채널이 처음 채워지는
것**이다 — 커널을 통해 돌아오는 양은 그대로 0이고, 그 0을 바꾸는 것은
`ConversationSource` 배선이다 (별개 조각, §7 비고).

---

## Q6. 정본 문서(`docs/compaction-consolidation-boundary.md`)와의 대조

**그 파일은 열어서 읽기만 했다.** 아래는 보고이며, 고치는 것은 #285의 몫이다.

| 정본 문서의 서술                                                              | 하네스 채택 후                                                                                                              | 판정                                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §0-1 오늘의 mori에는 압축이 없다                                              | 조각 E 이후 생긴다                                                                                                          | **그대로 참**. 이 문서가 그 §0-1의 "어디서 가져올지"에 답한다                                                                                                      |
| §0-2 `transformContext` 반환값은 요청 하나에만 산다                           | 하네스 위에서도 같다                                                                                                        | **그대로 참** (§5)                                                                                                                                                 |
| §0-4 `ConversationSource` 미배선                                              | 하네스 채택으로 바뀌지 않는다                                                                                               | **그대로 참**. 별개 축                                                                                                                                             |
| §2.2 압축 요약 + `retainedTail`이 대화 축의 유일한 안전망, 소유자가 있을 때만 | (가)에서 소유자는 하네스                                                                                                    | **실물에서 성립한다** — `CompactionEntry.retainedTail`(`types.d.ts:268`) + `defaultContextEntryTransform`(`session.js:35-40`)이 그 엔트리 이후만 컨텍스트로 만든다 |
| §5.2 R5 압축된 대화 원문의 커널 재주입 0                                      | 그대로 0                                                                                                                    | **그대로 참** (§5)                                                                                                                                                 |
| §6.1 판정의 정본은 하네스 쪽 값이다                                           | 상수·판정식은 pi 것을 쓰지만 **호출부는 mori가 만든다**                                                                     | **어긋난다 (보고)** — 아래                                                                                                                                         |
| §6.2 새 파이프라인을 만들지 않는다 (`boundary: "post-compact"`)               | 통보 지점이 `subscribe`의 `session_compact`로 특정된다                                                                      | **그대로 참**, 자리가 하나 더 구체화됨                                                                                                                             |
| §6.4 (가)의 대가 = "mori의 에이전트 구성이 하네스 위로 옮겨간다"              | Q2가 그 대가를 항목별로 셌다: 잃는 것 둘(`streamFn` 주입점, `toolExecution`), 시그니처가 바뀌는 것 둘(툴, subscribe 이벤트) | **그대로 참, 크기가 확정됨**                                                                                                                                       |
| §4.3 W6 (`pruneSegments` 인터리브)                                            | `ConversationSource` 배선 시 열린다 — 하네스와 무관                                                                         | **그대로 참**                                                                                                                                                      |
| §4.3 W9 (`memory.injected` append가 경계 CAS를 밀어내는 창)                   | 이주로 바뀌지 않는다                                                                                                        | **그대로 참**                                                                                                                                                      |

### 어긋난 곳 (비범위 참조 — 고치지 않았다)

**§6.1의 _"판정의 정본은 하네스 쪽 값이다"_ 는 상수에 대해서는 참이고, 트리거에
대해서는 실물과 어긋난다.** 하네스는 `shouldCompact`를 부르지 않는다 (§Q1 ①). 그래서
_"커널에 두 번째 임계를 만들지 않는다"_ 는 기본안은 그대로 서지만, "그럼 첫 번째 임계는
누가 부르는가"의 답이 **"하네스가"** 가 아니라 **"mori의 새 호출부가 pi의 상수와 식을
써서"** 다. 정본 문서가 인용한 `compaction.js:88-92, 157-161`은 0.82.1 실물과 일치하며
(재확인함), 어긋난 것은 인용이 아니라 **그 함수를 누가 부르는지에 대한 함의**다.

§6.1이 "미정으로 남긴다"고 한 `threshold` 트리거와의 관계(①흡수 / ②공존 / ③threshold만)는
이 산정으로도 결정되지 않는다 — 근거가 될 값은 여전히 §2.3의 실측이다. 다만 이 산정이
하나를 좁힌다: 압축 판정 호출부를 mori가 어차피 만들어야 하므로, ①(압축 경계가 흡수)의
구현 비용이 §6.1이 상정한 것보다 조금 크다.

두 번째로, **§2.2의 표에서 "압축 요약 (커널 밖)" 행이 _"커널이 관여하지 않는다"_ 라고
적은 것은 (가)에서 한 겹 약해진다.** `session_before_compact`가 `cancel`과
`compaction`(요약 대체)을 돌려줄 수 있으므로 (§3), 커널이 관여하지 **않기로 선택**하는
것이지 관여할 자리가 없는 것이 아니다. 이 문서의 권고는 커널이 `undefined`를 돌려주고
관찰만 하는 것이다 — 요약 생성은 "세션의 형태" 쪽이다.

세 번째로, 이주와는 무관하지만 대조하다 눈에 띈 절 참조 오타 둘을 적어 둔다:
**PR #288이 §2.2-b와 §4.3 W8 행에 넣은 `§6 R2`는 `§5.2 R2`여야 한다.** `R1`–`R5`는
§5.2에 있고 (`docs/compaction-consolidation-boundary.md:497`이 R2, `:525`가 R5), §6은
"설계 판단"이다 (`:537`). 이 문서는 그 파일을 고치지 않는다 — #285의 몫이다.

---

## Q7. 권고안 — 이주를 다섯 조각으로 자른다

각 조각은 developer가 한 세션에 끝낼 크기이고, 각각 끝난 시점에 리포가 그린으로 선다.

### 순서와 근거

```
A(툴 순차성 등가)  →  B(스트림 seam 이전)  →  C(세션 소유권★)  →  D(하네스 이주)  →  E(압축 점화)
   안전성 먼저          테스트 먼저            결정 먼저          기계적 이전       기능 마지막
```

- **A가 첫 번째인 이유**: D가 `toolExecution`을 잃는 자리를 **잃기 전에** 메운다.
  같은 조각에서 하면 리뷰가 한 줄을 놓칠 때 안전성이 조용히 되돌아간다 (§Q2).
- **B가 D보다 앞인 이유**: D는 `createMoriAgent`를 갈아엎는 조각인데, 오늘 그 코드의
  테스트 거의 전부가 `streamFn` 주입으로 돈다. seam을 먼저 옮겨 두면 D의 diff에서
  "행동 변화"와 "테스트 배선 변화"가 섞이지 않는다.
- **C가 D보다 앞인 이유**: `session`은 하네스 생성자의 **필수 인자**다
  (`pi/dist/harness/types.d.ts:649`). D를 시작하려면 이미 답이 있어야 한다.
- **E가 마지막인 이유**: A–D가 끝나도 압축은 아무도 부르지 않는 상태이므로 (§Q1 ①),
  D까지의 리포는 오늘과 행동이 같다. 기능이 켜지는 것은 E 하나뿐이고, 되돌리려면
  E만 되돌리면 된다.

### 조각 목록

#### A. bash·edit_file 툴에 `executionMode: "sequential"`을 단다

- **되돌리기**: 쉽다 (필드 둘)
- **완료 조건 초안**
  - `createBashTool`(`packages/mori/src/tools/bash.ts`)과
    `createEditFileTool`(`packages/mori/src/tools/edit-file.ts`)이 돌려주는 툴 객체에
    `executionMode: "sequential"`이 있다
  - `createMoriAgent`의 `toolExecution: "sequential"`은 **그대로 둔다** (둘은 OR로
    겹치므로 오늘 동작이 바뀌지 않는다) — 그 줄을 지우는 것은 D의 몫
  - 새 테스트: 한 assistant 메시지에 `bash` + `read_file` 두 콜을 담은 스크립트
    streamFn으로, `toolExecution`을 지정하지 않은 `Agent`에서도 두 콜이 순차로
    실행됨을 확인한다 (`agent/index.test.ts`의 기존 스크립트 streamFn 헬퍼 재사용)
  - `pnpm build` · `pnpm lint` · `pnpm test` 그린

#### B. 테스트의 프로바이더 대체를 `streamFn` 주입에서 provider 등록으로 옮긴다

- **되돌리기**: 쉽다 (테스트와 얇은 헬퍼만)
- **완료 조건 초안**
  - 테스트용 가짜 provider를 만드는 헬퍼가 하나 생기고,
    `repl.test.ts` · `agent/index.test.ts` · `runtime.test.ts`가 `deps.streamFn` 대신
    그 헬퍼로 돈다
  - `RunCliDeps.streamFn`(`packages/mori/src/cli/types.ts:9`)과
    `createMoriAgent`의 `streamFn` 인자는 **이 조각에서 지우지 않는다** (D가 지운다) —
    두 경로가 공존하는 중간 상태가 되돌리기를 싸게 만든다
  - 옮긴 테스트가 옮기기 전과 같은 것을 검증한다는 근거를 PR 본문에 적는다
    (CONTRIBUTING의 "삭제한 테스트마다 근거" 규율)
  - `pnpm test` 그린

#### C. 세션 저장소를 정한다 — **되돌리기 어려운 조각 ★**

- **되돌리기**: **어렵다.** 운용 원칙 2가 걸리는 유일한 조각이다. 세션 파일이 디스크에
  생기기 시작하면 경로와 포맷이 사용자와의 계약이 된다
- **권고**: `InMemorySessionStorage`로 시작한다. 오늘의 행동(프로세스가 끝나면 대화가
  사라진다)과 등가이므로 이 조각이 사용자에게 보이는 변화를 만들지 않고, 지속성이
  필요해질 때 `JsonlSessionRepo`로 올라가는 길이 열려 있다 (§4). mori 자체
  `SessionStorage` 구현은 **이 조각에서 하지 않는다**
- **완료 조건 초안**
  - 세션을 만드는 함수 하나가 `packages/mori/src/agent/` 아래에 생기고,
    `Session`(pi 타입)을 돌려준다
  - 선택한 저장소와 **선택하지 않은 둘을 왜 미뤘는지**가 그 함수의 doc 주석에 있다
    (`docs/storage-boundary-secrets.md`와 같은 규율 — 결정을 코드 옆에 둔다)
  - 이 조각만으로는 아무도 그 함수를 부르지 않는다 (D가 부른다). `pnpm build`가 미사용
    export를 문제 삼지 않음을 확인한다
  - `pnpm build` · `pnpm lint` · `pnpm test` 그린

#### D. `createMoriAgent`를 `AgentHarness` 위로 옮긴다 (압축은 켜지 않는다)

- **되돌리기**: 보통 (한 커밋 되돌리기로 복구되지만 diff가 넓다)
- **완료 조건 초안**
  - `createMoriAgent`가 `AgentHarness`를 돌려주고, Q2 표의 대응이 전부 배선된다:
    `systemPrompt` / `model` + `models` / `tools`(+`executionMode`) /
    `transformContext`→`context` 훅 / `beforeToolCall`→`tool_call` 훅 /
    `subscribe`→`subscribe`
  - `cli/repl.ts`·`cli/runtime.ts`의 세 자리가 대체된다:
    `agent.state.messages.at(-1)`(`repl.ts:124`, `runtime.ts:165`) → `prompt()`의 반환값,
    `agent.reset()`(`repl.ts:86`) → 새 세션, `agent.abort()`(`repl.ts:62`) → 하네스의
    `abort()` (반환 타입이 `Promise<AbortResult>`로 바뀐다)
  - `context` 훅에서 커널로 넘어가던 **취소 신호의 등가 경로**가 있다 (§5의 차이)
  - 커널의 `observeEvent`가 넓어진 `AgentHarnessEvent`를 안전하게 좁힌다
  - `toolExecution: "sequential"` 줄이 사라지고, A가 단 `executionMode`가 그 자리를 잇는다
  - **압축을 부르는 코드는 없다.** `compact()` 호출부 0건임을 grep으로 PR 본문에 첨부
  - `pnpm build` · `pnpm lint` · `pnpm test` 그린 — 특히 `repl.test.ts`의 컨텍스트
    검증(주입 블록이 매 요청 붙는지)이 이주 후에도 같은 것을 본다

#### E. 압축을 점화하고 커널에 잇는다

- **되돌리기**: 보통 (기능 하나. 되돌리면 D 상태로 돌아간다)
- **완료 조건 초안**
  - 턴 사이에서 `estimateContextTokens` + `shouldCompact`로 판정하고
    `harness.compact()`를 부르는 호출부가 하나 생긴다. 임계 상수는 pi의
    `DEFAULT_COMPACTION_SETTINGS`를 쓰고 **두 번째 임계를 만들지 않는다**
    (정본 문서 §6.1)
  - `on("session_before_compact", …)`가 `preparation.messagesToSummarize`를 커널의
    증류 입력으로 넘긴다. 그 핸들러는 **던지지 않고 `undefined`를 돌려준다**
    (§3의 단서 1·3)
  - `subscribe`에서 `session_compact`를 받아 `boundary: "post-compact"` 경계를 건다.
    `on("session_compact", …)`를 쓰지 않는다 (§Q1 ②)
  - 경계는 압축을 기다리지 않는다(정본 문서 §1 D1) — 기다리지 않는 호출자가 자기 거부
    싱크를 붙인다 (§6.3 D7)
  - `phase !== "idle"`일 때 `compact()`가 `busy`로 끝나는 경로에 대한 처리가 있다
    (`agent-harness.js:641-642`)
  - 테스트: 압축이 걸린 뒤 다음 턴의 컨텍스트가 요약 + `retainedTail`로 줄어드는 것과,
    그 시점에 경계가 한 번 트리거되는 것

### 첫 조각과 그린

**첫 조각은 A다.** 툴 정의에 필드 하나씩을 더하고 테스트 하나를 추가하는 크기이고,
그것만으로 리포가 그린으로 선다 — `toolExecution: "sequential"`이 아직 그대로 있으므로
행동이 바뀌지 않고, 바뀌는 것은 **D가 그 설정을 잃어도 안전성이 남는다**는 성질뿐이다.

### 이 목록에 없는 것

- **`ConversationSource` 배선.** 하네스 채택과 별개 축이다 (§4, §5). 배선되는 순간
  정본 문서의 W6이 열리고 세그먼트 보존 상한이 실효를 갖기 시작하므로, 그 조각은
  이 다섯과 독립적으로 잘려야 한다
- **세션 지속성(디스크 JSONL).** C가 `InMemorySessionStorage`를 권고하므로, 디스크
  저장은 별도 결정이다 — 운용 원칙 2가 걸리는 두 번째 자리
- **`threshold` 트리거와의 관계 결정** (정본 문서 §6.1의 ①/②/③). 근거가 될 값은
  실측이고, E가 그 실측을 처음 가능하게 만든다

---

## 8. 이 문서가 인용한 실물

**pi-agent-core 0.82.1** (`packages/mori/node_modules/@earendil-works/pi-agent-core/`)

- `dist/index.d.ts:4, 6, 18` — 루트 export 표면
- `dist/agent.d.ts:5-24` — `AgentOptions` (오늘 mori가 쓰는 저수준 표면)
- `dist/agent-loop.js:178-183` — `transformContext`의 지역 수명
- `dist/agent-loop.js:287-294` — 툴 실행 모드 분기
- `dist/types.d.ts:216-226, 343-350` — `toolExecution` 기본값, `executionMode`
- `dist/harness/agent-harness.d.ts:4, 64, 87-92` — 클래스 표면
- `dist/harness/agent-harness.js:98, 161-198, 277-278, 319-341, 356-409, 454-483, 515-523, 640-684, 946-963`
- `dist/harness/types.d.ts:58-61, 246-249, 263-272, 306, 337-353, 408-411, 444-455, 508-509, 514-516, 523-526, 534-537, 550-573, 581-589, 600-610, 641-679`
- `dist/harness/compaction/compaction.d.ts:38, 55, 57, 72, 103, 106`
- `dist/harness/compaction/compaction.js:88-92, 157-161`
- `dist/harness/session/session.d.ts:16-19` · `session.js:23-52`
- `dist/harness/session/jsonl-storage.d.ts:4` · `memory-storage.d.ts:2` · `jsonl-repo.d.ts:7-10` · `jsonl-repo.js:13-26`

**pi-ai 0.82.1** — `dist/models.d.ts:124-135` (`MutableModels extends Models`)

**mori** (기준 커밋 `dbfc7ab`)

- `packages/mori/package.json` — 버전 고정
- `packages/mori/src/agent/index.ts:20-33, 50-96`
- `packages/mori/src/agent/model-wiring.ts:86-103`
- `packages/mori/src/tools/index.ts:23-35` · `tools/bash.ts:72-131`
- `packages/mori/src/kernel/index.ts:54-60, 137-181, 620-635`
- `packages/mori/src/cli/types.ts:9` · `cli/runtime.ts:89, 99, 151, 165` · `cli/repl.ts:62, 86, 121, 124`
- `packages/mori/src/index.ts:107`
- `packages/kernel/src/kernel/sqlite-memory-kernel.ts:256-278, 429-434, 441-474`
- `docs/compaction-consolidation-boundary.md` — §0, §2.2, §5.2, §6.1–§6.4 (읽기만)
