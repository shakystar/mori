# 압축 요약이 「빈 대화」 보일러플레이트로 나오는 원인 규명 (#462) — 2026-08-15

> **판정 기록 · 동결됨 (커밋 `5f4f6d9` 시점, pi 0.82.1).** 이 문서는 그 시점의 기록이며
> 오늘의 코드를 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다.
> 인용이 코드와 어긋나 보이면 이 문서가 아니라 코드를 따른다.

## 판정

**원인은 (b) pi의 `compact()` 경로다.** 맥락 턴은 세션에 **전부 남아 있고**(관측: 4턴 →
엔트리 8개, 그 다음 턴이 프로바이더에 실제로 보낸 메시지 7개), 압축 요약 LLM 호출은 그
히스토리를 **하나도 싣지 않은 채** 나간다 — 요청 본문이 문자 그대로
`<conversation>\n\n</conversation>`이다. 모델은 빈 대화를 받았으니 정직하게 "The conversation
is empty"라고 답했다. 즉 요약기가 거짓말을 한 것도, 벤치가 히스토리를 잃은 것도 아니라,
**압축 준비 단계가 요약 대상 집합을 빈 배열로 만들어 넘긴다.**

한 걸음 더 들어가면 이렇다. pi의 압축은 「컨텍스트 창이 찼을 때 **오래된 앞부분**을 잘라
요약하고 **최근 꼬리는 원문 그대로 남긴다**」는 임계 구동 설계다. 최근 꼬리의 크기는
`DEFAULT_COMPACTION_SETTINGS.keepRecentTokens = 20000`이 정한다. 벤치의 맥락 세션은 3~4턴
(관측된 `tokensBefore`는 스텁 프로바이더 기준 **53 토큰**, 실측 리포트 기준으로도 에피소드당
수천 토큰대)이라 **대화 전체가 「최근 꼬리」 안에 들어간다.** 그래서 자를 앞부분이 없고,
요약 대상은 공집합이 되며, pi는 그 공집합을 **거르지 않고** 요약 LLM에 그대로 보낸다.

이것이 (b)인 이유: 히스토리는 있는데(=(a)·(c) 배제) 압축 입력을 그 히스토리에서 만들어내지
못한다. 그리고 이것이 「pi의 버그」라기보다 **pi의 전제와 벤치의 호출 방식이 어긋난 지점**임을
§3.3에 적어 둔다 — 수정 방향이 상류·하류 어느 쪽으로도 갈 수 있기 때문이다.

## 1. 무엇이 관측됐나

정본은 [`docs/bench/reports/preference-regression-3arm-2026-08-15.json`](https://github.com/shakystar/mori/blob/agent/issue-459/docs/bench/reports/preference-regression-3arm-2026-08-15.json)
(브랜치 `agent/issue-459`)이다. `scenarios[]`에서 `compactionSummary`가 있는 6건 **전부**가
빈 대화 보일러플레이트다:

| `scenarioId`        | `condition`  | `compactionSummary` 첫 줄                                                            |
| ------------------- | ------------ | ------------------------------------------------------------------------------------ |
| `tabs-indentation`  | `memory-off` | `The conversation is empty—there is no user request or task to summarize.`           |
| `tabs-indentation`  | `memory-on`  | `The conversation is empty; there is no task or goal to summarize.`                  |
| `concise-responses` | `memory-off` | `Summarize a conversation … (no specific task identified in the empty conversation)` |
| `concise-responses` | `memory-on`  | `The conversation is empty—no user goal or task has been stated yet.`                |
| `pnpm-workflow`     | `memory-off` | `The conversation is empty — no user or assistant messages were provided…`           |
| `pnpm-workflow`     | `memory-on`  | `The conversation is empty — there is no user request, task, or objective…`          |

`oracle` 팔 3건은 `compactionSummary`가 `undefined`다 — 그 팔은 압축을 부르지 않으므로
(runner.ts의 `condition === "memory-off"` 게이트) 정상이다.

같은 패턴이 **사전에 존재했다**: `docs/bench/reports/preference-regression-3arm-2026-08-14.json`
(#401 회차)의 `memory-off` 3건도 전부 같은 보일러플레이트다. #459가 만든 결함이 아니다 —
#459는 `memory-on` 폴백을 추가하면서 **같은 결함을 한 팔 더 노출시켰을 뿐**이다.

## 2. 재현

**결론부터**: 맥락 턴 N=4를 태운 뒤 `MoriSession.compact()`를 부르면, 세션에는 엔트리 8개가
있는데 요약 LLM은 빈 `<conversation>` 블록을 받는다. API 키 없이 스텁 프로바이더로 재현된다
(따라서 이 재현은 모델 응답의 우연에 기대지 않는다 — 요약기가 **무엇을 받았는가**를 직접 찍는다).

### 2.1 절차

1. 워크트리에서 `pnpm install && pnpm build` (vitest가 `@mori/kernel`의 빌드 산출물을 요구한다).
2. `packages/mori/src/bench/preference-regression/`에 §부록의 스크래치 테스트를 저장한다.
   **커밋하지 않는다** — 이 조각은 코드를 고치지 않으므로 남길 테스트가 없다(이슈 지시).
3. `npx vitest run packages/mori/src/bench/preference-regression/repro462.scratch.test.ts`
4. 확인 후 스크래치 파일을 지운다.

시나리오는 실물(`PREFERENCE_REGRESSION_SCENARIOS`의 `concise-responses`, `contextTurns` 4개)을
그대로 쓴다 — 픽스처가 아니라 리포트를 만든 그 데이터다.

### 2.2 출력 (2026-08-15 실행, 그대로 인용)

관측 A — 에이전트 층. `compact()` 직전 세션이 실제로 들고 있는 것과, pi의 압축 준비가 그것을
어떻게 나누는가:

```
[A] contextTurns=4 entries=8 entryTypes=[ 'message' × 8 ] contextMessages=8
    roles=[ 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant' ]
[A] prepareCompaction: defined=true messagesToSummarize=0 retainedTail=8 isSplitTurn=false
    tokensBefore=53 keepRecentTokens=20000
```

관측 B — 벤치가 실제로 타는 층(`MoriSession.compact()`). 압축 호출이 프로바이더에 보낸
요청 본문:

```
[B] 마지막 맥락 턴이 프로바이더에 보낸 메시지=7
    roles=[ 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user' ]
[B] 압축 호출 systemPrompt=You are a context summarization assistant. Your task is to read a conversation …
[B] 압축 호출 user prompt(앞 900자)=[{"role":"user","content":[{"type":"text","text":
    "<conversation>\n\n</conversation>\n\nThe messages above are a conversation to summarize. …
```

두 줄이 판정의 전부다:

- `entries=8` / `마지막 맥락 턴이 보낸 메시지=7` → **히스토리는 세션에 있다.** 맥락 턴은
  압축 시점까지 살아 있고, 직전 턴은 그 히스토리를 실제로 프로바이더에 실어 보냈다.
- `messagesToSummarize=0` / `<conversation>\n\n</conversation>` → **압축 입력은 비어 있다.**

## 3. 메커니즘

인용은 설치된 pi 0.82.1의 dist(`packages/mori/node_modules/@earendil-works/pi-agent-core/dist/`)
기준이고, 괄호 안이 소스맵이 가리키는 상류 파일이다.

### 3.1 자를 앞부분이 없으면 컷은 맨 앞에 선다

`harness/compaction/compaction.js:274-296` (`src/harness/compaction/compaction.ts`, `findCutPoint`):

```js
let cutIndex = cutPoints[0];                    // 유효 컷 후보의 첫 번째 = 대화의 맨 앞
for (let i = endIndex - 1; i >= startIndex; i--) {
    ...
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) { /* 여기서만 cutIndex가 뒤로 밀린다 */ break; }
}
```

뒤에서부터 토큰을 쌓다가 `keepRecentTokens`(20000)를 넘는 지점에서 컷을 잡는다. 대화 전체가
20000 토큰 미만이면 이 `if`는 **한 번도 참이 되지 않고**, `cutIndex`는 초기값 `cutPoints[0]`
— 즉 대화의 첫 메시지 — 에 그대로 남는다.

### 3.2 그래서 요약 대상이 공집합이 되고, 아무도 막지 않는다

`harness/compaction/compaction.js:452-464` (`prepareCompaction`):

```js
const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
const messagesToSummarize = [];
for (let i = boundaryStart; i < historyEnd; i++) { … }   // historyEnd === boundaryStart → 0회
```

`firstKeptEntryIndex === boundaryStart`이므로 루프가 한 번도 돌지 않는다. `retainedTail`은
반대로 대화 **전부**를 담는다(관측 A의 `retainedTail=8`).

`harness/agent-harness.js:640-670` (`AgentHarness.compact()`)의 유일한 방어선은
`preparation`이 `undefined`일 때뿐이다:

```js
const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
const preparation = preparationResult.value;
if (!preparation) throw new AgentHarnessError("compaction", "Nothing to compact");
```

`prepareCompaction`이 `undefined`를 돌려주는 경우는 **엔트리가 0개이거나 마지막 엔트리가 이미
압축일 때**뿐이다(`compaction.js:429-432`). 「엔트리는 있는데 자를 앞부분이 없다」는 이 경우는
그 그물에 걸리지 않는다. 그대로 `compaction.js:538-543`으로 내려가

```js
const summaryResult = await generateSummaryWithUsage(messagesToSummarize, …);   // 빈 배열
```

`generateSummaryWithUsage`(`compaction.js:395-403`)가 빈 배열을 직렬화해
`<conversation>\n\n</conversation>`을 만들고, 그것이 요약 LLM에 나간다. 모델이 「빈 대화다」라고
답하면 그 문자열이 그대로 `CompactResult.summary`가 되고 — **비어 있지 않으므로** — 아래
모든 소비자에게 정상 요약으로 통과한다.

### 3.3 벤치 쪽의 전제

`packages/mori/src/bench/preference-regression/runner.ts:397-405`는 임계를 기다리지 않고
`compact()`를 직접 부른다. 그 주석이 이유를 이미 적어 뒀다 — 「이 시나리오들의 맥락 세션은
컨텍스트 창을 채울 만큼 길지 않아 자동 트리거가 영영 안 걸린다」. **바로 그 짧음이 §3.1의
`if`를 영영 안 걸리게 하는 것과 같은 짧음이다.** 벤치는 "compact()를 부르면 이 대화의 요약이
나온다"를 전제했고, pi는 "compact()는 최근 20000 토큰을 남기고 그보다 오래된 것을 요약한다"를
구현했다. 짧은 대화에서 둘의 교집합은 공집합이다.

그래서 §5의 수정 방향은 두 갈래로 갈린다: 상류에 「요약할 것이 없다」를 인식시키는 길과,
하류에서 컷 지점을 강제하는 길.

## 4. (a)·(c)가 배제되는 근거

- **(a) 벤치 러너 배선 — 맥락 턴이 `compact()`가 읽는 히스토리에 남지 않는다: 배제.**
  `compact()`가 읽는 것은 `this.session.getBranch()`(`agent-harness.js:648`)이고, 관측 A는
  같은 세션에서 `getEntries()`가 엔트리 8개(user 4 + assistant 4)를 돌려준다는 것을 찍었다.
  관측 B는 한 걸음 더 나가 **직전 턴이 그 히스토리를 프로바이더에 실제로 실어 보냈음**(메시지 7개)을
  찍었다 — 커널 주입 seam도 세션 수명도 히스토리를 잃지 않았다. 잃었다면 `retainedTail=8`이
  나올 수 없다.
- **(c) 시나리오 정의 — `contextTurns`가 압축 시점에 이미 세션 밖에 있다: 배제.**
  같은 관측이 이것도 배제한다. `contextTurns` 4개는 압축 시점에 세션 안에 있었고,
  `prepareCompaction`은 그 8개를 **버린 것이 아니라 `retainedTail`로 분류**했다. 시나리오
  데이터는 실물 그대로 흘렀다(재현이 픽스처가 아닌 `PREFERENCE_REGRESSION_SCENARIOS`를 쓴 이유).

## 5. 수정 방향과 예상 변경 지점

**이 조각은 코드를 고치지 않는다**(이슈 비범위). 아래는 층을 단정한 결과로서의 방향이고,
실제 수정은 별도 조각의 몫이다.

### 5.1 상류(pi 0.82.1)가 원인인 부분과 우회 가능성

상류 위치:

- `src/harness/compaction/compaction.ts` — `prepareCompaction`(dist `compaction.js:452-464`):
  `messagesToSummarize`가 빈 배열이 되는 경우를 「압축할 것이 없음」으로 돌려주지 않는다.
- `src/harness/agent-harness.ts` — `AgentHarness.compact()`(dist `agent-harness.js:640-670`):
  `DEFAULT_COMPACTION_SETTINGS`를 **하드코딩**한다. 호출자가 `keepRecentTokens`를 못 준다.
  공개 시그니처는 `compact(customInstructions?: string)` 하나뿐(`agent-harness.d.ts:64`).

**우회는 가능하다.** pi를 고치지 않고도 두 갈래가 있고, 둘 다 pi의 압축 코드 경로(같은 요약
프롬프트·같은 요약기)를 그대로 탄다 — #434가 OFF 팔에 요구한 「하네스 자신의 압축 요약」이라는
성질을 잃지 않는 것이 중요하다:

1. **`session_before_compact` 훅으로 `CompactResult`를 공급한다.** 훅은
   `{ cancel?, compaction? }`를 돌려줄 수 있고(`harness/types.d.ts:534-537`), `compaction`이
   있으면 하네스는 자기 요약을 건너뛰고 그것을 그대로 세션에 적층한다(`agent-harness.js:664-671`).
   mori는 훅이 함께 주는 `branchEntries`로 `prepareCompaction(entries, { …DEFAULT_COMPACTION_SETTINGS,
keepRecentTokens: 0 })` → pi가 export하는 `compact(preparation, …)`를 불러 결과를 돌려주면 된다
   (둘 다 `@earendil-works/pi-agent-core` 공개 export — `dist/index.d.ts:6`).
2. **`compact()`를 부르기 전에 컷을 강제한다** — 같은 조합을 `MoriSession.compact()` 안에서
   직접 수행하고 요약만 꺼낸다. 세션 트리에 압축 엔트리를 적층하지 않아도 되는 벤치 용도라면
   이쪽이 더 작다.

두 방식 모두 **`keepRecentTokens: 0`이 「전부 요약」을 뜻하지는 않는다**는 점을 감안해야 한다.
`findCutPoint`는 첫 반복에서 곧바로 임계를 넘으므로 **마지막 메시지 1건은 여전히
`retainedTail`로 남는다**(`compaction.js:281-296`). OFF 팔은 요약만 이월하므로 마지막 어시스턴트
응답이 이월물에서 빠진다. 수정 조각은 (i) 꼬리도 함께 이월할지, (ii) `generateSummaryWithUsage`를
전체 메시지에 직접 부를지를 **명시적으로 정해야 한다** — 여기서 조용히 고르면 「무엇을 이월했는가」가
또 불투명해진다.

### 5.2 예상 변경 지점 (하류, mori)

- `packages/mori/src/session.ts:250-261` — `MoriSession.compact()`. 위 우회의 착지점.
  현재는 `agent.compact()`를 그대로 흘려보내고 `summary`/`usage`만 꺼낸다.
- `packages/mori/src/session.ts:84-104` — `compact()`의 doc. 「하네스 기본 압축 그대로」라는
  현재 서술은 이 결함을 고치는 순간 참이 아니게 된다(같은 코드 경로이되 설정이 달라진다).
  고치는 조각이 이 문장을 함께 갱신해야 한다.
- `packages/mori/src/bench/preference-regression/runner.ts:397-405` — 압축 호출 지점. 여기서
  「짧아서 자동 트리거가 안 걸린다」를 이미 알고 있었으므로, 강제 컷의 근거도 여기 남는 것이 맞다.
  **단 PR #461이 이 파일을 잡고 있으므로 파일 교집합을 피하려면 착지점은 `session.ts` 쪽이 낫다.**
- `packages/mori/src/cli/compaction.ts:49-60`(`compactIfContextFull`) — **바꿀 필요 없다.**
  이 경로는 컨텍스트 창(200k)에 대한 임계로만 발화하므로 그때는 20000 토큰보다 훨씬 오래된
  앞부분이 반드시 존재한다. 프로덕션 REPL의 압축은 이 결함의 영향을 받지 않는다.
- 회귀 방지 시험의 자리: `packages/mori/src/session.test.ts` — 스텁 프로바이더가 받은 요약
  요청에 `<conversation>` 블록이 비어 있지 않음을 단언하면 이 결함은 다시 들어올 수 없다
  (관측 B가 그 시험의 초안이다).

## 6. 이 결함이 무효화하는 수치와 무효화하지 않는 수치

**무효화한다.** #401(2026-08-14)·#459(2026-08-15) 두 리포트의 **`memory-off` 팔 점수 전부**와,
#459 리포트의 **압축 폴백으로 이월받은 `memory-on` 팔 점수**는 「압축 요약을 이월받은 팔」의
점수가 아니다. 그 팔들이 후속 세션에서 실제로 받은 것은 머리말 한 줄 + 빈 대화 보일러플레이트,
즉 **맥락을 아예 안 준 베이스라인과 사실상 같다**. `buildFollowUpCarryOver`(runner.ts:121-140)의
빈 요약 가드가 이것을 못 막았다 — 보일러플레이트는 「비어 있지 않은 문자열」이기 때문이다. 그
가드가 되살아나지 않게 하려고 막았던 상태(「맥락을 아예 안 준 베이스라인이 이름만 바꿔
되살아난다」)가 **이름만 바꿔 실제로 되살아나 있었다.** 따라서 OFF를 기준선으로 삼는 파생값 —
델타 `ON-OFF`, 킬 스위치의 `gap`(#459 회차: 세 시나리오 모두 `offScore=0`, gap 1.0/0.5/1.0) — 은
「압축 요약 대비 이득」이 아니라 「무맥락 대비 이득」으로만 읽어야 한다.

**무효화하지 않는다.** 압축과 무관한 축은 그대로 살아 있다: `oracle` 팔 점수(압축을 부르지 않는다),
`memory-on` 팔에서 **retrieval이 실제로 적중한** 에피소드(#459 회차의 `pnpm-workflow`,
`injected=true`, 2/2), `axisRates.injectionHitRate = 0.333`, 비용 원장 수치, 그리고 #446이
단정한 capture 실패 진단. 또한 **「ON ⊇ OFF가 배선상 보장된다」(#459)는 배선 명제로서는 여전히
참이다** — 다만 두 팔이 같이 받는 그 「같은 것」이 내용상 아무것도 아니었으므로, 그 보장이
**내용 수준의 명제로 승격되지는 않는다.** 다음 회차가 과거 수치를 인용할 때는 이 문단을 함께
인용해야 한다.

## 7. 후속 제안 (이슈 생성은 owner 몫)

1. **수정 조각**: §5의 두 우회 중 하나를 골라 `MoriSession.compact()`가 짧은 대화에서도
   실제 대화를 요약하게 만든다. 이월물에 꼬리를 포함할지를 함께 결정한다(§5.1). 회귀 시험은
   §5.2의 마지막 항목.
2. **상류 보고**: pi에 「`messagesToSummarize`가 공집합이면 요약 호출을 하지 말고 `Nothing to
compact`로 돌려라」 + 「`compact()`가 압축 설정을 인자로 받게 하라」를 제안한다. 지금은 빈
   대화를 요약하는 데 **실제 토큰을 태우고** 그 비용이 벤치 원장의 `cost` 축에 들어간다.
3. **재실측 순서**: 수정이 착지한 뒤에 #460이 돌아야 한다. 그 전에 돌면 그 회차의 OFF
   기준선도 같은 공백 위에 선다.

## 부록: 재현 스크래치 코드

커밋되지 않는다. §2.1의 경로에 저장하고 실행 후 지운다.

```ts
/** SCRATCH — #462 재현용. 커밋하지 않는다. */
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createMoriAgent, type MoriKernel } from "../../agent/index.js";
import { createMoriSession } from "../../session.js";
import { PREFERENCE_REGRESSION_SCENARIOS } from "./scenarios.js";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test" } as const;

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 프로바이더에 실제로 나간 Context를 전부 기록한다 — 이 기록이 관측치다. */
function scriptedProvider() {
  const contexts: Context[] = [];
  const streamFn: StreamFn = (model, context) => {
    contexts.push(context);
    const text = `reply-${String(contexts.length)}`;
    const stream = createAssistantMessageEventStream();
    const base: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: usage(),
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "start", partial: base } satisfies AssistantMessageEvent);
    const final: AssistantMessage = { ...base, content: [{ type: "text", text }] };
    stream.push({ type: "done", reason: "stop", message: final } satisfies AssistantMessageEvent);
    return stream;
  };
  return { streamFn, contexts };
}

function storeFreeKernel(): MoriKernel {
  return {
    transformContext: async (messages: AgentMessage[]) => messages,
    observe: () => {},
    consolidate: async () => {},
    resetConversation: () => {},
    drain: async () => {},
  };
}

const SCENARIO = PREFERENCE_REGRESSION_SCENARIOS.find((s) => s.id === "concise-responses");
if (!SCENARIO) throw new Error("scenario missing");

describe("#462 repro", () => {
  it("A: compact() 직전 세션이 들고 있는 엔트리와 prepareCompaction의 분할", async () => {
    const provider = scriptedProvider();
    const agent = createMoriAgent(
      storeFreeKernel(),
      new InMemoryCredentialStore(),
      ENV,
      provider.streamFn,
    );
    for (const turn of SCENARIO.contextTurns) await agent.prompt(turn);

    const entries = await agent.getEntries();
    const contextMessages = await agent.contextMessages();
    console.log(
      "[A] contextTurns=%d entries=%d entryTypes=%o contextMessages=%d roles=%o",
      SCENARIO.contextTurns.length,
      entries.length,
      entries.map((e) => e.type),
      contextMessages.length,
      contextMessages.map((m) => m.role),
    );

    const prep = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
    if (!prep.ok) throw prep.error;
    const p = prep.value;
    console.log(
      "[A] prepareCompaction: defined=%s messagesToSummarize=%d retainedTail=%d isSplitTurn=%s tokensBefore=%d keepRecentTokens=%d",
      String(p !== undefined),
      p?.messagesToSummarize.length ?? -1,
      p?.retainedTail.length ?? -1,
      String(p?.isSplitTurn),
      p?.tokensBefore ?? -1,
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );
    expect(p?.messagesToSummarize.length).toBe(0);
  });

  it("B: MoriSession.compact()가 요약 LLM에 실제로 보내는 대화", async () => {
    const provider = scriptedProvider();
    const result = await createMoriSession(ENV, {
      credentialStore: new InMemoryCredentialStore(),
      streamFn: provider.streamFn,
      kernel: storeFreeKernel(),
    });
    if (!result.ok) throw new Error("session create failed");
    for (const turn of SCENARIO.contextTurns) await result.session.prompt(turn);

    const beforeCalls = provider.contexts.length;
    const lastTurnContext = provider.contexts[beforeCalls - 1];
    console.log(
      "[B] 마지막 맥락 턴이 프로바이더에 보낸 메시지=%d roles=%o",
      lastTurnContext?.messages.length,
      lastTurnContext?.messages.map((m) => m.role),
    );

    const compaction = await result.session.compact();
    const compactionContext = provider.contexts[beforeCalls];
    console.log("[B] 압축 호출 systemPrompt=%s", compactionContext?.systemPrompt?.slice(0, 120));
    console.log(
      "[B] 압축 호출 user prompt(앞 900자)=%s",
      JSON.stringify(compactionContext?.messages).slice(0, 900),
    );
    console.log("[B] summary=%s", compaction.summary.slice(0, 200));
    await result.session.close();
  });
});
```
