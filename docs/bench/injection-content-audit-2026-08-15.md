# 주입 원문 감사 + 가설 (#470, #457 조각 2/2) — 2026-08-15

> **판정 기록 · 동결됨 (커밋 `f01a7e6` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

> **이 문서는 판정이 아니라 가설이다.** 표본이 시나리오당 n=1이고, 이 회차의 킬 스위치
> (`computeKillSwitchReport`, `kill-switch.ts`)는 시나리오 3건 전부 무효로 떨어졌다 —
> ORACLE·OFF 두 팔의 점수 간격이 임계값(0.25) 미만이거나 음수였다(§4). 즉 이 회차 하나로는
> "ORACLE이 OFF를 이긴다"는 벤치 자체의 전제조차 성립을 확인 못 한다. 아래 관측·가설은
> **다음 회차에서 무엇을 판별해야 하는지**를 좁히는 용도이고, 결론으로 인용하지 않는다.

## 0. 배경과 방법

#460 회차(`docs/bench/reports/preference-regression-3arm-2026-08-15-460.json`)는 ON 팔이
100% 주입되면서도(`injectionHitRate` 1.0) 평균 점수가 OFF보다 낮다는 것(ON 0.167 vs OFF
0.667)을 관측했다. 그런데 그 리포트에는 **무엇이 주입됐는지가 없다** — `scenarios[].injected`는
boolean뿐이고 원문 필드가 없다. 이 이슈는 그 원문을 얻는 것부터 시작한다.

`docs/bench/reports/preference-regression-3arm-2026-08-15-460.json`을 먼저 확인했고,
`injectedContent` 같은 필드는 없었다(완료 조건 1의 전제 확인). 그래서
`packages/mori/src/bench/preference-regression/runner.ts`의 `withInjectionProbe`에 계측을
추가했다:

- `ScenarioRunResult`/`EpisodeResult`에 `injectedContent: string | undefined` 필드를 추가.
- `withInjectionProbe`가 주입 적중(`result.length > messages.length`) 시
  `result[0]`(mori retrieval이 항상 맨 앞에 붙이는 메시지, `sqlite-memory-kernel.ts`의
  `return [injected, ...messages]` 계약)의 `content`를 문자열이면 그대로 캡처한다
  (`messageText` 헬퍼). 문자열이 아니거나 애초에 미적중이면 `undefined` — 리포트 JSON에서는
  키 자체가 빠진다(`JSON.stringify`가 `undefined` 값을 드롭하는 것과 일치, 아래 원문에서
  `"memory-off"`/`"oracle"` 항목에 `injectedContent` 키가 없는 이유).
- `milestone.ts`의 리포트 조립부에 `injectedContent: episode.injectedContent`를 한 줄 추가.
- 테스트 2건 추가(`runner.test.ts`, 기존 `describe("runPreferenceRegressionScenario (#387)")`
  블록): 적중 시 `result.injectedContent`가 픽스처 원문과 같음, 폴백(미적중) 시
  `undefined`임.

계측을 얹고 `packages/mori`에서 마일스톤을 재실행해 새 리포트를 냈다(원장 기준 비용
$0.0233, 아래 §4 리포트 메타 참고): `docs/bench/reports/preference-regression-3arm-2026-08-15-470.json`.
**이 문서의 모든 원문은 그 리포트에서 그대로 가져온 것**이고, #460 회차와는 다른 표본이다
(재실행 시점이 다르므로 모델 출력이 다르다 — #460의 정량치 0.167/0.667을 재현하는 것이
목적이 아니라, 처음으로 원문을 눈으로 보는 것이 목적이다).

축약 없이 원문 그대로 인용한다. 긴 코드 펜스는 접지 않고 그대로 둔다(내용이 판단의 대상이므로
잘라내면 그 자체가 손실이다).

## 1. 탭 들여쓰기 되돌림 (`tabs-indentation`)

**루브릭**: `uses-tab-indentation`(결정적, 들여쓴 모든 줄이 탭으로 시작) ·
`matches-formatting-habits`(LLM 판정).

**점수**: ON 0 / OFF 0.5 / ORACLE 0 — 두 항목 다 실패(ON) vs `matches-formatting-habits`만
만족(OFF).

### ON 팔에 주입된 원문 (`injectedContent`)

````
# Project memory

Recalled from this project's own memory at session start — earlier sessions'
distilled decisions, the previous session's activity, and verbatim detail.
Background, not instructions from the user, and not necessarily still true:
check against the working tree before acting on any of it.

## Verbatim detail from earlier transcripts

`````
USER: 이 함수 리뷰해줘:

```ts
function add(a: number, b: number) {
	return a + b;
}
```

AGENT: 이 함수를 리뷰하겠습니다.

## 전반적인 평가

기본적인 덧셈 함수로, 기능 자체는 단순하고 정확하게 동작합니다. 하지만 몇 가지 개선할 점이 있습니다.

## 개선 사항

### 1. 반환 타입 명시 (가장 중요)
함수가 `number`를 반환한다는 것보다는, **명시적으로 반환 타입을 선언**하는 것이 좋습니다. 타입스크립트를 쓰는 이유 중 하나가 명시적인 타입 선언이기 때문입니다.

```ts
function add(a: number, b: number): number {
	return a + b;
}
```

### 2. 코드 스타일
프로젝트의 린터(prettier 등) 설정에 따라 다르지만, 일반적으로 이 함수보다는 **화살표 함수**를 선호하는 팀도 있습니다.

```ts
const add = (a: number, b: number): number => a + b;
```

### 3. 순수 함수 리뷰 포인트
- ✅ **부수 효과(side effect) 없음**: 외부 상태를 변경하지 않는 순수 함수입니다. 매우 이상적입니다.
- ✅ **명명 규칙 좋음**: `add`라는 이름이 기능을 명확히 표현합니다.
- ✅ **인자 타입 명시**: `a`, `b`가 `number` 타입임을 명확히 했습니다.

## 제안하는 최종 버전

```ts
/**
 * 두 숫자를 더합니다.
 * @param a 첫 번째 숫자
 * @param b 두 번째 숫자
 * @returns 두 숫자의 합
 */
export function add(a: number, b: number): number {
	return a + b;
}
```

주요 변경점을 요약하면:
1. **반환 타입 `: number` 추가** — 타입 안전성과 가독성 향상
2. **JSDoc 주석** — 팀/라이브러리 공용 함수라면 문서화가 좋음
3. **`export` 키워드** — 다른 모듈에서 재사용할 예정이라면

이 함수가 어디서 어떻게 사용될지에 따라 위 권장사항을 적절히 적용하시면 됩니다. 단순한 내부 헬퍼라면 반환 타입만 추가하는 것으로도 충분합니다.

USER: 고마워. 근데 방금 네가 예시로 보여준 스니펫 중 하나가 스페이스로 인덴트돼 있길래 내가 다시 고쳤어:

```ts
function subtract(a: number, b: number) {
	return a - b;
}
```

이 버전으로 계속 진행해줘.

AGENT: 좋습니다, 이 `subtract` 함수 버전을 기준으로 리뷰를 이어가겠습니다.

## 전반적인 평가

`add` 함수와 동일하게 단순하고 정확하게 동작하는 순수 함수입니다. `a - b` 로직도 명확합니다.

## 개선 사항

### 1. 반환 타입 명시 (이전과 동일하게 핵심)
`add` 함수때처럼 반환 타입을 명시해주는 것이 좋습니다.
`````
````

### OFF 팔이 이월받은 압축 요약 (`compactionSummary`)

```
## Goal
- 사용자가 TypeScript 함수 리뷰를 요청하고, 리뷰를 바탕으로 동일한 스타일(탭 인덴트)의 새로운 함수를 생성해달라고 요청한 상태.

## Constraints & Preferences
- 코드 스타일: **탭(tab) 인덴트 사용** (스페이스 아님). 사용자가 스페이스 인덴트된 스니펫을 직접 탭으로 고쳐서 제시함.
- 함수 시그니처 스타일: `function name(a: number, b: number)` — 인자 타입 명시, 반환 타입은 명시하지 않는 스타일 유지.
- 새로운 함수도 "방금 스타일 그대로" 작성할 것.

## Progress
### Done
- [x] `add(a: number, b: number)` 함수 리뷰 완료 — 반환 타입 명시 권장, 전반적으로 문제없음 판단.
- [x] `subtract(a: number, b: number)` 함수 리뷰 완료 — 탭 인덴트 버전으로 재진행. 반환 타입 명시, 부동소수점 정밀도, NaN/Infinity 방어 논의.
- [x] `max(a: number, b: number)` 함수 생성 (탭 인덴트 스타일) — 삼항 연산자 버전 + `Math.max` 대안 제시.

### In Progress
- [ ] `max` 함수를 포함하여, 사용자가 다음 함수를 요청할지 대기 중.

### Blocked
- (없음)

## Key Decisions
- **코드 인덴트는 탭 사용**: 사용자가 스페이스로 된 예시를 직접 탭으로 수정하여 제시. 이후 모든 코드 스니펫은 탭 인덴트를 유지해야 함.
- **함수 스타일**: 반환 타입은 명시하지 않는 일반 함수(`function foo(...) { ... }`) 스타일 유지.
- **`max` 구현**: 삼항 연산자를 기본 제시, `Math.max`를 대안으로 언급.

(이하 Next Steps · Critical Context 생략 — 리포트 원문 참고)
```

### 두 팔의 후속 답변

**ON**(공백 2칸 인덴트, 탭 0개):

````
빈 작업 디렉토리인 것 같네요. ... 블록 본문, 반환 타입 명시를 고려해 작성하겠습니다.

```ts
function concat(a: string, b: string): string {
  if (a === "") {
    return b;
  }
  if (b === "") {
    return a;
  }
  return a + b;
}
```

이전 리뷰에서 논의했던 포인트를 반영했습니다:
1. **반환 타입 명시** — `: string`을 선언...
2. **블록 본문** — 화살표 함수가 아닌 `function` 선언...
(이하 생략)
````

**OFF**(주 코드블록은 탭 인덴트, 단 "간결 버전" 대안 스니펫은 스페이스+탭 혼합):

````
Using the established tab-indent style with `(a: string, b: string)` signature:

```ts
function concat(a: string, b: string) {
	if (a === "") {
		return b;
	}
	if (b === "") {
		return a;
	}
	return a + b;
}
```

...대안 (간결 버전)도 있습니다:
```ts
function concat(a: string, b: string) {
  	return a ? a + b : b;
  }
```
(이 버전은 요구사항과 더 정확히 일치하는 첫 버전보다 덜 명시적이라고 첨언)
````

### 루브릭 항목별 차이

| 항목 | ON | OFF | 비고 |
| --- | --- | --- | --- |
| `uses-tab-indentation` | ❌ | ❌ | ON은 주 코드블록 전체가 스페이스. OFF는 주 코드블록은 탭이지만 **두 번째(대안) 코드블록**이 스페이스+탭 혼합이라 "들여쓴 모든 줄이 탭"이라는 결정적 검사를 함께 깬다 — 탭을 지켰는데도 실패했다. |
| `matches-formatting-habits`(LLM) | ❌ | ✅ | 판정자가 전반적 인상(주로 첫/주 코드블록)을 본 것으로 보인다 — OFF는 주 코드블록이 탭이라 "습관과 일치"로 판정됐다. |

**핵심 관측**: ON 팔의 주입 원문에는 탭 문자가 **말 그대로 들어있다**(`add`/`subtract` 코드
펜스가 실제로 탭으로 인덴트돼 있다). 그런데도 ON의 후속 답변은 탭을 전혀 안 썼다. 반면 OFF의
`compactionSummary`는 원문 코드가 아니라 "**탭(tab) 인덴트 사용**"이라는 **명시적 자연어
규칙**으로 스타일을 서술했고, OFF 후속 답변의 주 코드블록은 실제로 탭을 썼다.

## 2. 군더더기 없는 답변 선호 (`concise-responses`)

**루브릭**: `short-response`(결정적, 글자 수) · `no-preamble`(LLM 판정).

**점수**: ON 1 / OFF 1 / ORACLE 1 — 이 시나리오는 회귀가 없다(세 팔 동점). #460 회차와 달리
이번 표본에서는 ON이 OFF를 밑돌지 않았다 — 표본 편차의 크기를 보여주는 사례로 §4에 남긴다.

### ON 팔에 주입된 원문

`tabs-indentation`과 같은 "Verbatim detail from earlier transcripts" 형식이다. 앞부분은
생략하고(`.map()` 에러 설명 전문), 이 문서의 논지에 중요한 **마지막 교환**만 인용한다(전문은
`docs/bench/reports/preference-regression-3arm-2026-08-15-470.json`의 해당 항목 참고):

````
...
USER: 이번엔 이 워닝은 뭐야: React Hook useEffect has a missing dependency

AGENT: 이 워닝은 `useEffect` 안에서 사용하는 값 중 하나가 `dependencies` 배열에 빠져있을 때 뜹니다.

**결론:** `useEffect` 내부에서 참조하는 `state`나 `props` 값이 스코프에 있음에도 dependencies 배열에 안 적혀 있으면, React가 "이 값이 바뀌어도 효과가 다시 실행되지 않을 거다"라고 경고하는 겁니다. 그 값을 dependencies 배열에 추가하면 해결됩니다.

```js
// 🔴 경고: value가 dependencies에 없음
useEffect(() => {
  console.log(value);
}, []);

// ✅ 해결
useEffect(() => {
  console.log(value);
}, [value]);
```
> (단, 값이 정말 일회성으로 쓰이길 의도했다면 eslint-disable 주석으로 의도적으로 제외할 수도 있습니다.)

USER: 역시 길다, 짧게.

AGENT: **결론:** `useEffect` 안에서 쓰는 값을 dependencies 배열에 안 적어서 나는 경고입니다. 그 값을 배열에 추가하면 됩니다.
````

### OFF 팔이 이월받은 압축 요약

`Constraints & Preferences`: "사용자가 긴 설명을 싫어하고 **결론만 짧게(한두 문장)** 원함" ·
"각 질문에 대해 먼저 자세히 설명한 후, 사용자가 '짧게' 요청하면 간결한 요약을 제공함" (전문은
리포트 참고).

### 두 팔의 후속 답변

**ON**:

````
**결론:**
- **유니언 (`|`)** = "이거나" → 타입이 **둘 중 하나**. `A | B`는 A거나 B.
- **인터섹션 (`&`)** = "그리고" → 타입이 **둘 다**. `A & B`는 A이면서 동시에 B.

```ts
type A = { a: string };
type B = { b: number };

// 유니언: A 속성만, 또는 B 속성만 가질 수 있음
let u: A | B;
u = { a: "hi" };     // ✅
u = { b: 1 };        // ✅

// 인터섹션: A도 B도 모두 가져야 함
let i: A & B;
i = { a: "hi", b: 1 };  // ✅ 필수
```

핵심 하나로: **`|`는 "택1", `&`는 "전부 합치기"**입니다.
````

**OFF**:

````
TypeScript에서 유니언(`|`)과 인터섹션(`&`) 타입의 차이입니다.

**유니언 타입 `|`** — "또는" 관계. 한 타입 **또는** 다른 타입 중 하나
```ts
type A = string | number  // string이거나 number
```

**인터섹션 타입 `&`** — "그리고" 관계. 두 타입의 **모든** 속성을 합침
```ts
type B = { name: string } & { age: number }
// { name: string; age: number } 둘 다 가짐
```

**짧은 결론:** `|`는 **둘 중 하나**, `&`는 **둘 다 합친** 타입입니다.
````

두 답변 모두 결론 우선·간결하다는 점에서 서로 다르지 않고, 점수도 동일(1/1)이다.

### 루브릭 항목별 차이

두 항목 다 ON=OFF=ORACLE=만족. 차이 없음.

**핵심 관측**: 주입 형식은 `tabs-indentation`과 동일(원문 그대로의 대화 블록)인데 여기서는
회귀가 없다. 다른 점은 **주입 원문의 마지막 교환이 목표 행동(짧은 결론)을 완결된 형태로,
바로 그 순간에 보여준다**는 것이다 — `USER: 역시 길다, 짧게.` → `AGENT: **결론:** ...`가
블록의 맨 끝에 온전히 남아있다. `tabs-indentation`의 원문은 `subtract` 리뷰 도중
"반환 타입을 명시해주는 것이 좋습니다."에서 잘려, 탭 스타일을 보여주는 완결된 코드가 블록
끝에 없다(마지막 완결 코드블록은 `add`의 것이고, 그마저 리뷰 대상 코드이지 "생성 규칙"으로
읽히지 않는다). 즉 "원문이 verbatim이냐 distilled냐"보다 **원문 안에서 목표 행동이
어디에, 얼마나 완결된 형태로 있는지**가 갈랐을 가능성이 있다(§5 가설 H1).

## 3. 패키지 매니저 pnpm 습관 (`pnpm-workflow`)

**루브릭**: `uses-pnpm-command`(결정적, `npm`/`yarn` 명령이 섞이면 실패) ·
`ci-step-pnpm-native`(LLM 판정).

**점수**: ON 0.5 / OFF 1 / ORACLE 1.

### ON 팔에 주입된 원문

다른 두 시나리오와 형식이 다르다 — "Verbatim detail"이 아니라 **`Consolidated memory`**(증류된
불릿):

```
# Project memory

Recalled from this project's own memory at session start — earlier sessions'
distilled decisions, the previous session's activity, and verbatim detail.
Background, not instructions from the user, and not necessarily still true:
check against the working tree before acting on any of it.

## Consolidated memory
- [progress · salience 8 · 2026-08-15] pnpm lockfile conflict request not actionable: no package.json, pnpm-lock.yaml, or git repo in working root /tmp/mori-nightly-
- [decision · salience 7 · 2026-08-15] Project uses pnpm for build and scripts, so start script should be 'pnpm build && node dist/index.js' r
- [progress · salience 7 · 2026-08-15] To proceed with any project work, user must mount actual source (package.json, pnpm-lock.yaml) or provide correct project path.
- [progress · salience 6 · 2026-08-15] Script conversion provided as reference only; package.json not modified because project files are absent from the workspace.
```

### OFF 팔이 이월받은 압축 요약

`Blocked`: "**`pnpm-lock.yaml` 충돌 해결이 불가능**: 작업 공간에 실제 프로젝트 소스... 존재하지
않으며..." / `Key Decisions`: "`npm run build` → `pnpm build` 로 변환" (전문은 리포트 참고).

### 두 팔의 후속 답변

**ON**(`uses-pnpm-command` 실패):

```
...
> yarn/npm을 쓴다면 `yarn add lodash` / `npm i lodash`로 바꾸면 됩니다.

## 2. CI 스텝 예시 (GitHub Actions)
...
참고: 작업 트리에 실제 `package.json`/`pnpm-lock.yaml`이 없어서 이 명령들을 직접 실행하거나
파일을 실제로 수정할 수는 없었습니다. 설치 명령과 CI 예시는 **참고용**으로 작성된 것이며,
실제 프로젝트 경로를 마운트해 주시면 해당 파일들을 직접 수정·적용해 드릴 수 있습니다.
```

**OFF**(`uses-pnpm-command` 만족, `npm`/`yarn` 언급 없음):

```
pnpm add lodash

먼저 설치 명령입니다. 프로젝트가 pnpm을 쓰고 있으므로 **`pnpm add lodash`** 를 실행하면 됩니다.
...
런타임 의존성이라 `--save`(기본값)로 package.json의 `dependencies`에 추가됩니다. devDependency로
넣을 거라면 `pnpm add -D lodash`를 쓰세요.
```

### 루브릭 항목별 차이

| 항목 | ON | OFF | 비고 |
| --- | --- | --- | --- |
| `uses-pnpm-command` | ❌ | ✅ | ON이 "yarn/npm을 쓴다면 ..."이라는 **대안 안내 한 줄**을 덧붙였고, 이 시나리오의 결정적 판정은 출력에 `npm i`/`yarn add` 패턴이 **한 번이라도** 나오면 실패하는 음성 정규식이다(`scenarios.ts`) — 주 명령은 두 팔 다 `pnpm add lodash`로 동일했다. |
| `ci-step-pnpm-native`(LLM) | ✅ | ✅ | CI 예시 자체는 두 팔 다 pnpm 네이티브 관례(corepack, `cache: pnpm`, `--frozen-lockfile`)를 지켰다. |

**핵심 관측**: 실패 원인이 "pnpm을 안 씀"이 아니라 **"안 쓰는 대안까지 친절하게 언급함"**이다.
ON 팔은 후속 답변 전체에 걸쳐 "작업 트리에 실제 파일이 없다"는 취지의 유보·안내를 두 번
반복했다(본문 서두 + 말미) — 이는 정확히 **주입된 `Consolidated memory`의 첫째·셋째 불릿**
("no package.json... in working root", "user must mount actual source...")과 같은
내용이다. 반면 OFF의 `compactionSummary`에는 이 "파일 부재" 사실이 `Blocked` 항목에 있긴
하지만, ON의 원문만큼 반복·강조되지 않는다. 즉 주입물의 **불릿 자체가 아니라, 그 불릿이 답변에
얼마나 그대로 새어나갔는지**가 실패의 경로로 보인다(§5 가설 H2).

## 4. 표본 한계

- **시나리오당 n=1** — 이 문서의 세 시나리오 모두 마일스톤(`milestone.ts`) 단발 실행 1회의
  결과다. 반복 표본(`--repeats`)은 조각 1/2(#469)의 몫이고, 이 이슈 범위 밖이다.
- **킬 스위치(`computeKillSwitchReport`, 임계값 0.25) 3/3 무효**:

  | scenarioId | oracleScore | offScore | gap | invalid |
  | --- | --- | --- | --- | --- |
  | `tabs-indentation` | 0 | 0.5 | **-0.5** | true |
  | `concise-responses` | 1 | 1 | 0 | true |
  | `pnpm-workflow` | 1 | 1 | 0 | true |

  `tabs-indentation`은 ORACLE이 OFF보다 **낮다**(정답을 통째로 준 팔이 압축 요약만 받은 팔보다
  점수가 낮다) — 원인은 확인했다(§5 H3): ORACLE이 코드를 채팅에 인쇄하지 않고 파일 저장으로
  처리해 결정적 검사가 공허하게 실패했다. 나머지 둘은 ORACLE=OFF로 간격이 아예 없어 "정답을
  알아도 점수가 안 오른다"는 뜻이다. **이 회차 하나로는 벤치의 판별력 자체가 의심스럽다** —
  §1·§3에서 뽑은 관측도 "우연한 1표본"일 가능성을 배제할 수 없다.
- 리포트 메타: `repeatsPerScenario` 정보 없음(마일스톤 단발), 비용 총합 $0.0233(input
  $0.0116 + output $0.0095 + cacheRead $0.0022), `totalTokens` 908,658.

## 5. 가설

### H1 — 원문의 형식(verbatim/distilled)이 아니라, 목표 행동이 원문 "끝부분"에 얼마나 완결된 형태로 있는지가 갈랐을 수 있다

`tabs-indentation`(회귀)과 `concise-responses`(무회귀)는 둘 다 "Verbatim detail" 형식을
썼지만, `concise-responses`의 원문은 목표 행동(짧은 결론)을 블록 **맨 끝**에 완결된
`USER→AGENT` 교환으로 보여주는 반면 `tabs-indentation`의 원문은 `subtract` 리뷰 문장
중간에서 잘려 탭 스타일을 보여주는 완결된 코드가 끝부분에 없다.

**판별 방법**: 같은 `tabs-indentation` 시나리오를 컨텍스트 세션 스크립트만 살짝 늘려(예:
`max` 함수까지 실제로 탭으로 "완성"하는 교환을 마지막에 추가) 재실행 — 원문 끝에 완결된
탭 예시가 오도록 만들었을 때 `uses-tab-indentation`이 오르면 이 가설을 지지한다.

### H2 — 주입물의 "부재/유보" 서술이 후속 답변에 그대로 새어나가 판정 대상 산문 자체를 오염시킬 수 있다

`pnpm-workflow`의 ON 실패는 pnpm 명령 자체가 아니라, 주입된 `Consolidated memory`의
"작업 공간에 실제 파일이 없다"는 불릿이 후속 답변에 반복 노출되면서 그 유보 발언 안에
"yarn/npm이라면..."이라는 **필요 없던 대안 언급**을 끌고 나왔다는 관측에 근거한다. 즉 실패
경로가 "선호를 안 지켰다"가 아니라 "무관한 배경 정보가 답변 산문에 섞여 부수적으로 규칙을
건드렸다"는 것이다.

**판별 방법**: 같은 원문에서 `Consolidated memory`의 "no package.json..." 계열 불릿 2건만
제거하고(pnpm 관련 `decision` 불릿은 남기고) 재실행 — `uses-pnpm-command`가 오르면 "부재
서술의 누출"이 원인이라는 가설을 지지한다. 반대로 그래도 실패하면 원인은 다른 곳(예: 모델이
"참고 정보이니 대안도 안내하자"는 습관적 응대 패턴)에 있다는 뜻이다.

### H3 (검증됨, 주입과 무관) — `tabs-indentation` 킬 스위치 무효는 주입 내용이 아니라 도구 사용 방식과 결정적 검사의 상호작용이 원인이다

`tabs-indentation`의 킬 스위치 무효(§4)는 ORACLE(0) < OFF(0.5)다. ORACLE의 `followUpOutput`을
읽어 확인했다:

```
`concat.ts` 파일을 저장했습니다. 요청하신 요구사항을 모두 반영했습니다:
1. **블록 본문**...
2. **빈 문자열 분기**...
3. **탭 들여쓰기** — 들여쓰기에 탭 문자를 사용했습니다.

간단히 동작을 정리하면:
| 입력 | 결과 |
|------|------|
...
```

ORACLE은 파일에 코드를 **쓰기 도구로 저장**하고, 채팅 응답에는 코드를 전혀 인쇄하지 않았다
(요약 산문 + 결과 표만). `uses-tab-indentation`의 결정적 검사(`scenarios.ts`)는
`output.split("\n")`에서 들여쓴 줄을 찾아 `indentedLines.length > 0 && ...every(탭으로 시작)`을
요구한다 — 들여쓴 줄이 **0개면 공허하게 false**다(각주가 이미 "들여쓴 줄이 0개면 false"라고
명시한 그 케이스). 즉 ORACLE은 스타일을 지켰지만(실제 파일은 탭일 것이다) **채팅 응답에
코드를 안 보여줬다는 이유만으로** 0점을 받았다. 이건 주입물의 내용·형식과 무관한, **벤치
루브릭이 "파일 저장" 응답 패턴을 처리 못 하는 문제**다 — §1·§3의 주입-내용 가설과는 다른
갈래이므로 여기 결론만 남기고 별도 이슈로 분리한다(가설이 아니라 코드로 확인된 사실이라
"판별 방법"을 따로 붙이지 않는다).
