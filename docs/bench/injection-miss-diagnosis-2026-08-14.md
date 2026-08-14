# ON 팔 주입 적중률 33.3% 원인 규명 (#446) — 2026-08-14

> **판정 기록 · 동결됨 (커밋 `a1b4776` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

## 판정

**원인은 (a) capture 실패다.** 주입 0건이었던 두 에피소드는 후속 세션이 조회할 때 **스토어
자체가 존재하지 않았다**. 조회할 것이 애초에 없었으므로 retrieval은 실행되지도 않았고
(`SqliteMemoryKernel.transformContext`가 `projectStoreExists` 게이트에서 그대로 반환한다),
따라서 (b) 쿼리가 못 찾은 것도 (c) 임계·예산에 걸려 탈락한 것도 아니다.

한 걸음 더 들어가면 이렇다: 이 시나리오들의 맥락 세션은 **대화만 한다.** mori의 capture는
쓰기·셸 도구 호출만 관찰하고(`TOOL_CAPTURE`, `packages/mori/src/kernel/index.ts`), 대화
자체를 기억으로 만드는 경로(`ConversationSource`, #426)는 **벤치 배선에서 연결되지 않는다** —
`prepareAgent`(`packages/mori/src/cli/runtime.ts`)가 `deps.kernel`을 받은 분기에서는
`conversationSource`를 붙이지 않기 때문이다. 게다가 이 실행 환경에는
`MORI_CONSOLIDATE_MODEL`이 없어 세션 종료 증류 자체가 no-op다
(`consolidateOnSessionEnd`, `packages/mori/src/cli/consolidation.ts`의 `if (!llm) return`).
세 겹이 겹쳐,
**현재 배선의 ON 팔은 모델이 우연히 셸/쓰기 도구를 쓸 때에만 스토어를 갖는다.**

그 「우연」이 `pnpm-workflow` 1건이고, 그것이 적중률 1/3의 정체다. 그리고 그 1건이 주입한
것도 증류된 선호가 아니라 **자기가 방금 돌린 셸 명령의 관찰 꼬리**였다(§3).

원인이 한 줄 수정으로 끝나지 않으므로, 수정 제안은 §6에 후속 이슈 후보로 적는다.

## 1. 주입 0건이었던 2 에피소드

정본은 `docs/bench/reports/preference-regression-3arm-2026-08-14.json`이다. 그 파일의
`scenarios[]`에서 `condition === "memory-on"`인 세 항목 중 `injected === false`인 둘:

| # (배열 인덱스) | `scenarioId`        | `condition` | `injected` | 점수 |
| --------------- | ------------------- | ----------- | ---------- | ---- |
| `scenarios[1]`  | `tabs-indentation`  | `memory-on` | **false**  | 0.0  |
| `scenarios[4]`  | `concise-responses` | `memory-on` | **false**  | 0.0  |
| `scenarios[7]`  | `pnpm-workflow`     | `memory-on` | true       | 0.5  |

`axisRates.injectionHitRate = 0.3333…`가 이 셋에서 나온 값이다(`computeAxisRates`의 분모는
ON 팔 하나다).

## 2. 관측치

`pnpm-workflow`는 진단 대상이 아니라 **대조군**이다 — 같은 배선에서 주입이 되는 유일한
에피소드라, "쿼리·retrieval 층은 멀쩡한데 넣을 것이 없었다"를 보이는 데 쓴다.

원본 관측 JSON: [`reports/injection-miss-diagnosis-2026-08-14.json`](reports/injection-miss-diagnosis-2026-08-14.json).
계측 방법은 부록.

### 2.1 `tabs-indentation` (memory-on)

| 관측 항목                         | 값                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 조회 시점 스토어의 후보 이벤트 수 | **0 — 스토어 파일 자체가 없음** (`projectStoreExists` = false)                                                                                                                            |
| retrieval에 넘어간 쿼리           | `"두 문자열을 이어붙이는 concat 함수를 TypeScript로 짜줘. 둘 중 한쪽이 빈 문자열이면 다른 쪽을 그대로 반환하도록 분기도 넣고, 함수는 블록 본문으로 작성해줘."` (turnId `1:1786740220452`) |
| 반환 후보 수와 점수               | **retrieval 미실행** — 스토어 게이트에서 반환되어 `buildMemoryContext`가 호출되지 않는다. 검증차 같은 쿼리로 직접 호출해도 후보 0건                                                       |
| 주입 임계에서의 탈락 여부         | **해당 없음** — 예산 트림(`dropped`)·빈 컨텍스트 판정(`isEmptyMemoryContext`)에 도달하지 못했다                                                                                           |

맥락 세션의 도구 호출은 `list_dir` 1건뿐이고, 그 판정은 `read-only`라 capture 후보가 되지
않는다(`toolCaptureVerdict("list_dir") === "read-only"`). 즉 capture 후보가 0건이다.

### 2.2 `concise-responses` (memory-on)

| 관측 항목                         | 값                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| 조회 시점 스토어의 후보 이벤트 수 | **0 — 스토어 파일 자체가 없음**                                                          |
| retrieval에 넘어간 쿼리           | `"TypeScript에서 유니언 타입과 인터섹션 타입의 차이가 뭐야?"` (turnId `1:1786740331907`) |
| 반환 후보 수와 점수               | **retrieval 미실행** (2.1과 같은 게이트)                                                 |
| 주입 임계에서의 탈락 여부         | **해당 없음**                                                                            |

이 에피소드는 맥락 세션에서 **도구 호출이 한 건도 없었다**(`tool_execution_end` 0건). 순수
대화만 오갔고, 그 대화는 어떤 경로로도 스토어에 남지 않는다.

### 2.3 `pnpm-workflow` (memory-on) — 대조군

| 관측 항목                         | 값                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| 조회 시점 스토어의 후보 이벤트 수 | **12** (`project.created` 1, `observation.captured` 9, `memory.injected` 2)               |
| retrieval에 넘어간 쿼리           | `"새 패키지 lodash를 추가하고 싶은데, 설치 명령이랑 CI 스텝 예시를 하나 만들어줘."`       |
| 반환 후보 수와 점수               | 증류 기억 **0건**(점수 없음 — 후보 자체가 없다), 원문 세그먼트 **0건**, 관찰 꼬리 **9건** |
| 주입 임계에서의 탈락 여부         | **탈락 없음** — `dropped`가 빈 배열, `isEmptyMemoryContext` = false → 주입됨              |

맥락 세션이 `bash` 55회·`edit_file` 2회를 호출했고(모델이 임시 작업 루트에서 실제 셸을 썼다),
그중 셸 53건이 mori 쪽 필터를 통과해 커널로 넘어갔으며, 커널의 2차 필터
(`evaluateCapture` — 변경성 명령·작업 전이·결정 키워드만 남긴다)를 최종 통과한 것이 9건이다.
`edit_file` 2건은 둘 다 작업 루트 밖을 가리켜 실패했으므로(`ok: false`) 캡처되지 않았다.

## 3. (b)·(c)가 배제되는 근거

- **(b) retrieval 실패가 아니다.** 두 에피소드 모두 쿼리는 정상적으로 도출됐다(§2.1·2.2의
  쿼리 문자열 — `readTurnQuery`가 후속 프롬프트를 그대로 잡아냈다). 문제는 그 쿼리가 못
  찾은 것이 아니라 **찾아갈 스토어가 없었다**는 것이다. 같은 쿼리 도출 경로를 탄 대조군은
  스토어가 있자 후보 9건을 돌려받았다 — 쿼리·랭킹 층은 동작한다.
- **(c) 주입 게이트 탈락이 아니다.** 예산 트림 `dropped`는 대조군에서 빈 배열이고, 두
  에피소드에서는 그 코드에 **도달조차 하지 않는다**:
  `SqliteMemoryKernel.transformContext`(`packages/kernel/src/kernel/sqlite-memory-kernel.ts`)는
  `if (!projectStoreExists(this.options.projectId)) return messages;`에서 먼저 반환하고, 그
  게이트는 `isEmptyMemoryContext`·`fitInjectionBudget`보다 앞에 있다.
- **(a) capture 실패다.** 스토어는 첫 capture가 만든다(`ensureGenesis`). 두 에피소드의
  capture 후보 수는 각각 0건(`read-only` 1건뿐)과 0건(도구 호출 없음)이었고, 그래서 스토어
  파일이 만들어지지 않았다. 대조군만 셸 명령이 캡처돼 스토어가 생겼다.

## 4. 이 진단이 #7 전제에 대해 말하는 것

#7의 전제는 *「압축으로 잃는 정보는 event log에 남아 턴 단위 retrieval(#5)로 되돌아온다」*이다.
이번 실측은 그 전제의 **후반부(retrieval)가 아니라 전반부(event log에 남는다)가 성립하지
않았음**을 보인다. 잃은 정보가 event log에 남지 않았으므로 되돌아올 것도 없었다. 이것은
retrieval의 반증이 아니라, **선호처럼 대화에만 드러나는 정보는 현재 capture 어휘
(쓰기·셸 도구 호출)에 걸리지 않는다**는 사실이다. 대조군은 반대편을 보여준다 — event log에
있던 것(셸 관찰 9건)은 실제로 되돌아왔다.

## 5. 테스트

원인 층은 **벤치 ON 팔 배선**이다(capture 자체는 설계대로 동작했다 — read-only 도구를
캡처하지 않는 것은 의도된 동작이고 이미 고정돼 있다).

이미 고정돼 있어 새로 만들지 않은 것:

- `packages/mori/src/kernel/index.test.ts` — "ignores read-only tools"
- `packages/mori/src/kernel/index.test.ts` — "writes nothing at all for a read-only turn even
  with consolidation configured (#107 review)"
- `packages/kernel/tests/integration/sqlite-memory-kernel.test.ts` — "leaves no store on disk
  when the filter rejects every observed call"
- `packages/kernel/tests/integration/kernel-context-injection.test.ts` — "injects nothing, and
  creates no store, when the project has never been written"

고정돼 있지 **않던** 것은 그 위층이다: `buildFollowUpCarryOver`는 `"memory-off"` 팔의 이월물이
비면 **던진다**(빈 압축 요약을 «봤다»로 리포트하지 않기 위해). ON 팔에는 그 대칭이 없어,
이월물이 통째로 빈 에피소드도 그냥 채점되고 평균에 섞인다. 그래서 다음 한 건을 추가했다
(`packages/mori/src/bench/preference-regression/runner.test.ts`):

- describe: `runPreferenceRegressionScenario — 빈손 retrieval의 가시성 (#446)`
- it: `memory-on: a context session that captures nothing leaves the follow-up with an empty store, and the report says so instead of swallowing it`

실제 `createMoriKernel`을 양쪽 세션에 물리고 맥락 세션이 아무 도구도 부르지 않게 한 뒤,
`injected === false`와 `computeAxisRates(...).injectionHitRate === 0`을 함께 고정한다 —
빈손으로 돌아온 상황이 리포트에서 **드러나야 한다**는 것이 이 테스트가 지키는 동작이다.

## 6. 후속 이슈 제안 (이슈 생성은 owner 몫)

원인은 한 줄 수정으로 끝나지 않는다. 세 갈래이고, 어느 것을 택할지가 곧 축의 정의를 다시
건드리므로 여기서 고르지 않는다.

1. **ON 팔에 대화 경로를 연결한다** — 벤치가 만드는 커널에 `ConversationSource`(#426)를
   물린다. `prepareAgent`의 `deps.kernel` 분기가 지금은 그것을 붙이지 않고, 벤치 러너는
   하네스 `Session` 핸들을 갖고 있지 않다(`runner.ts`의 `CreateKernelFn`은 `(root,
sessionId, env)`만 받는다). seam을 하나 넓혀야 하는 변경이다.
2. **벤치 실행에 `MORI_CONSOLIDATE_MODEL`을 요구한다** — 지금은 미설정이면 증류 boundary가
   조용히 no-op이라, 대화 경로를 연결해도 증류물이 생기지 않는다. 나이틀리/마일스톤 CLI가
   시작 시 이 설정을 확인하고 없으면 실패하게 하는 편이 «측정 안 함»을 «0»으로 내보내는
   것보다 낫다.
3. **ON 팔의 빈 이월물을 소리 나게 한다** — `"memory-off"`의 빈 압축 요약 throw와 대칭으로,
   ON 팔의 주입 0건도 리포트 층에서 실패 신호가 되게 할지 결정한다. §5의 테스트는 현재
   동작을 고정할 뿐, 게이트를 세우지는 않는다(게이트는 진단 범위 밖이다).

덧붙여, 이번 계측에서 벤치 에피소드의 `bash` 도구가 **임시 작업 루트 밖으로 나가 이 체크아웃
안에서 명령을 실행하는 것**을 관측했다(§2.3의 55회 중 일부가 `cd <이 리포 경로> && git status`
류였다). `edit_file`은 작업 루트 밖 경로를 거부했지만 `bash`에는 그 제한이 없다. 벤치 격리와
관련된 별개 사안이라 이 이슈에서 다루지 않고 여기 남긴다.

## 부록: 계측 방법

계측은 일회성 스크립트로 했고 커밋하지 않았다 — 커널 내부(`buildMemoryContext`,
`readEvents`)를 직접 들여다봐야 하는데 그 둘은 `@mori/kernel`의 공개 seam이 아니라,
`packages/mori`에서 `../../../../kernel/src/...`로 깊이 import해야 한다. 그 층 위반을
제품 패키지에 남기는 대신, 무엇을 어떻게 쟀는지를 여기 적는다. 다시 만들려면:

`runPreferenceRegressionEpisode`(`runner.ts`)를 `condition: "memory-on"`으로 부르되,
`createKernel` 옵션에 `createMoriKernel`을 감싼 데코레이터를 넘긴다. 데코레이터는

- `observe`에서 이벤트를 종류별로 세고, `createAgentEventObserver()` 인스턴스를 하나 더
  돌려 각 `tool_execution_end`가 capture 후보가 되는지 판정을 그대로 찍는다
  (`toolCaptureVerdict`도 함께 기록),
- `follow-up` 세션의 **첫** `transformContext`에서 위임 전에
  `readTurnQuery(messages)`(쿼리·turnId), `projectStoreExists(projectId)`(스토어 존재),
  `readEvents(projectId)`(후보 이벤트 수·종류), `buildMemoryContext(projectId, {taskTitle})`
  (반환 후보와 `dropped`), `isEmptyMemoryContext(context)`(빈 컨텍스트 판정)를 찍는다.
  `buildMemoryContext`는 retrieval-only(강화는 호출자 몫)라 이 재호출은 부작용이 없다.

실행 환경은 `docs/bench/preference-regression-3arm-run-2026-08-14.md`의 재현 명령과 같다
(`DEEPSEEK_API_KEY` + `MORI_MODEL`, 모델 `deepseek/deepseek-v4-flash`). 시나리오당 1회,
ON 팔만 돌렸다. 세 시나리오의 `injected` 값은 #401 회차와 동일하게 재현됐다
(false / false / true).
