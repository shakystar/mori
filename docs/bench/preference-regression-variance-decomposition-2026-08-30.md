# PreferenceRegression 판별력 부재 원인 — 채점기별 분산 분해 (#457 조각 4/N, #501)

**실측 비용 $0.** 이 문서는 이미 커밋된 리포트 JSON 3개(`docs/bench/reports/`)만 읽어 계산했다.
새 벤치 실행은 없다.

## 판정 요약

세 시나리오는 판별력 부재의 원인이 서로 다르다 — 어느 것도 owner가 사전 고지한
「(a) judge 잡음 지배 → 2안(deterministic 비중 확대)」의 깨끗한 사례는 아니다. judge
채점기의 sd가 deterministic보다 구조적으로 지배적인 시나리오는 하나도 없다(§2.4).

| 시나리오             | 판정                          | 근거 요약 |
| -------------------- | ----------------------------- | --------- |
| `tabs-indentation`   | **(b) 시나리오 자체가 무신호** | ON−OFF gap 부호가 세 회차에 걸쳐 0 → 음 → 양으로 뒤집힌다. judge 기여 몫(46%)이 deterministic(34%)보다 크지만 "지배적"이라 부를 격차가 아니고, deterministic만으로 재집계해도 gap>sd를 못 넘는다. |
| `concise-responses`  | **(c) 둘 다 아님 — 데이터로 안 갈림** | ON−OFF gap 부호는 세 회차 모두 음수(−0.500/−0.167/−0.500)라 「무신호」는 아니다. 그런데 그 신호를 잡아내는 채점기가 회차마다 바뀐다(n=3-1은 judge만 gap>sd, n=10은 deterministic만 gap>sd) — 특정 채점기의 잡음으로 귀속할 수 없다. |
| `pnpm-workflow`      | **(c) 둘 다 아님 — 데이터로 안 갈림** | 오염 제외 시 표본이 팔당 3~4건(n=10 회차 기준)으로 줄어 채점기 분해 자체가 신뢰할 수 있는 크기가 아니다. 원인은 판별력이 아니라 데이터 품질(오염, §1)이다. |

이하 §1~§4가 이 판정의 근거다.

## 0. 용어·표기 — 이슈 지시와 선례 문서의 차이

- 이 문서의 **`gap`은 issue #501 §2 지시대로 `memory-on − memory-off`**다. 선례 문서
  (`preference-regression-3arm-2026-08-29-repeats-default.md`)가 쓴 `gap`은
  `oracle − memory-off`(킬 스위치 판정식)로, **다른 지표**다 — 이름이 같아 혼동하기 쉽지만
  "정답을 줘도 점수가 오르는가"(검증용, 킬 스위치)와 "메모리 기능이 실제로 선호를
  유지시키는가"(이 벤치의 본래 질문)는 별개다. 이 문서는 후자만 다룬다. 선례의 `oracle-off`
  판정("아니오")은 건드리지 않는다 — 비범위(issue §비범위).
- `sd`는 `sample-stats.ts`와 같은 **모집단 표준편차**(n으로 나눔).
- "채점기별" 점수는 `deterministic` 기준을 0/1(충족/미충족)로, `llm-judge` 기준을 0/1로
  뽑은 것이다. `"inconclusive"`(deterministic만 가능, #475)는 분모에서 제외한다 — §2.1.

## 1. 오염 판별식 — 세 회차 전부 적용

issue #501 §1이 지시한 재현 커맨드(`compactionSummary`가 `"483"`을 포함하는 엔트리)를
그대로 세 파일에 돌렸다:

```bash
jq -r '.scenarios[] | select((.compactionSummary//"") | contains("483")) | "\(.condition)|\(.repeatIndex)"' <report>
```

| 리포트 | `contains("483")` 건수 |
| --- | --- |
| `...2026-08-15-469-repeats3.json` (n=3-1)      | **0건** |
| `...2026-08-15-469-repeats3-run2.json` (n=3-2) | **0건** |
| `...2026-08-29-repeats-default.json` (n=10)    | **11건** |

**「0건」은 판별식이 일반화되지 않는다는 뜻이지, 08-15 회차가 깨끗하다는 뜻이 아니다.**
`"483"`은 08-29 회차의 벤치 실행 세션 자신이 우연히 `mori-issue-483` worktree 안에서 돌아
`compactionSummary`가 그 경로를 스스로 서술한 결과다(선례 문서 §8 인용 참고) — 이 문자열은
08-29 회차 고유의 우연이지, 08-15 회차(다른 issue 번호의 worktree에서 실행)에 나타날 이유가
없는 값이다. 그대로 결론을 내리면 「08-15는 오염이 0건」이라는 틀린 결론이 된다.

그래서 issue 배경이 명시한 오염의 **일반 정의**("working root 밖의 공유 클론
`/data/repos/mori`를 읽고 쓴 표본")로 판별식을 일반화해 세 파일에 다시 적용했다:

```bash
jq -r '.scenarios[] | select((.compactionSummary//"") | test("/data/repos|workspace/work/mori-issue")) | "\(.scenarioId)|\(.condition)|\(.repeatIndex)"' <report>
```

(`/data/repos` — 영속 클론 직접 이스케이프. `workspace/work/mori-issue` — 다른 issue의 developer
worktree를 "발견된 프로젝트"로 읽어들인 경우, 08-29 §8 인용의 `memory-off|9`가 이 패턴이다.
둘 다 "이 반복에 할당된 `/tmp/mori-nightly-slice-work-*` 밖의 실제 파일시스템 상태를 읽거나
썼다"는 같은 사실을 가리킨다.)

| 리포트 | 일반화 판별식 건수 | 대상 |
| --- | --- | --- |
| n=3-1 | **3건** | `pnpm-workflow\|memory-on\|0,1,2` |
| n=3-2 | **3건** | `pnpm-workflow\|memory-off\|1,2`, `memory-on\|1` |
| n=10  | **13건** | `pnpm-workflow\|memory-off\|0,2,3,4,7,8,9`, `memory-on\|0,1,4,5,7,9` |

세 회차 모두 오염은 **`pnpm-workflow`에만** 있다(`oracle` 조건 포함 다른 어떤 시나리오·조건에도
없음) — 선례 문서의 관찰과 일치한다.

**참고 — 선례 문서(§8)의 서술 오류.** 선례 문서는 "§8의 재현 명령에서 파일명만 바꿔 그대로
돌린 결과"라며 n=3 두 회차에 각 3건·2건을 보고했다. 그 **건수**(3건, 2건)는 `/data/repos`
단독 판별식(위 표의 `workspace/work/mori-issue` 확장 없이)과 일치하지만, "483 문자열 재사용"이라는
**서술**은 위에서 보였듯 그 문자열로는 0건만 나와 사실과 다르다 — 아마 그때도 `/data/repos`
패턴으로 다시 돌렸을 것이다. 결론(오염 건수)은 맞았지만 재현 절차 서술이 부정확했다는
뜻이라, 이 문서가 재현 커맨드를 다시 명시한다.

**이 문서의 나머지 절은 일반화 판별식(위 두 번째 표, 3/3/13건)을 오염 표본으로 취급한다** —
issue 배경의 정의에 더 가깝고, 세 회차에 일관되게 적용 가능하다. "오염 포함" 집계도 함께
낸다(완료 조건).

## 2. 채점기별 분산 분해

### 2.1 분해식 — `scorer.ts` 기준

`scoreBehavioralAdaptation`(`scorer.ts:75-113`)의 실제 계산:

```
scorable = criteria.filter(c => c.satisfied !== "inconclusive")
score = scorable.length === 0 ? 0
      : scorable.filter(c => c.satisfied === true).length / scorable.length
```

세 시나리오 모두 루브릭이 `deterministic` 1개 + `llm-judge` 1개다(`scenarios.ts`). judge는
항상 boolean이라 `inconclusive`가 될 수 없다 — `inconclusive`는 오직 deterministic 쪽에서만
나온다(#475). 그러므로 실제로 나오는 식은 둘 중 하나다:

- **일반적인 경우** (deterministic이 판정 가능): `score = 0.5·D + 0.5·J` (D, J ∈ {0,1})
- **deterministic이 `inconclusive`인 경우**: `score = J` (D는 분자·분모에서 아예 빠진다 — `0`으로
  넣는 게 아니다)

일반적인 경우(`score = 0.5D + 0.5J`)에서, 모집단 분산은 정확히 다음으로 분해된다:

```
Var(score) = 0.25·Var(D) + 0.25·Var(J) + 0.5·Cov(D, J)
```

이 식을 세 리포트의 오염 제외 데이터에서 검산했다 — 27개 (시나리오,조건) 조합 중
`inconclusive`가 없는 25개 전부에서 우변 합과 `Var(score)`가 부동소수점 오차 이내로 일치했다
(§2.2 각주의 예시 참고). **예외 1건**: `tabs-indentation`의 `oracle` 조건(n=10 회차)에
`inconclusive` 2건(`repeatIndex` 4, 8)이 있어 이 조합만 위 식이 정확히 성립하지 않는다 —
`det`의 표본은 8건(9,10번째 반복 제외), `judge`·`combined`의 표본은 10건이라 분모가 다르다.
아래 표에는 `det`의 `n`을 따로 표기해 구분한다.

**judge 기여 몫**은 `0.25·Var(J) / Var(score)`로 정의한다(공분산 항은 "상호작용"으로 따로
보고 — judge에게만 귀속시키는 것은 D·J가 같은 잠재 신호에 반응해 함께 움직이는 부분까지
"judge 탓"으로 돌리는 셈이라 과대추정이다).

### 2.2 표본별 mean·sd — 시나리오 × 조건 × 채점기

`tabs-indentation`·`concise-responses`는 오염이 없어 포함/제외 값이 같다. `pnpm-workflow`만
포함/제외 두 값을 병기한다(`제외` 열, `—`는 표본 0건).

**n=3-1 (2026-08-15, 469, repeats=3)**

| 시나리오 | 조건 | n | combined mean·sd | det mean·sd | judge mean·sd | Cov(D,J) |
|---|---|---|---|---|---|---|
| tabs-indentation | off | 3 | 0.500 · 0.000 | 1.000 · 0.000 | 0.000 · 0.000 | 0.000 |
| tabs-indentation | on | 3 | 0.500 · 0.000 | 1.000 · 0.000 | 0.000 · 0.000 | 0.000 |
| tabs-indentation | oracle | 3 | 1.000 · 0.000 | 1.000 · 0.000 | 1.000 · 0.000 | 0.000 |
| concise-responses | off | 3 | 0.833 · 0.236 | 0.667 · 0.471 | 1.000 · 0.000 | 0.000 |
| concise-responses | on | 3 | 0.333 · 0.471 | 0.333 · 0.471 | 0.333 · 0.471 | 0.222 |
| concise-responses | oracle | 3 | 0.667 · 0.236 | 0.333 · 0.471 | 1.000 · 0.000 | 0.000 |
| pnpm-workflow | off | 3 | 0.833 · 0.236 | 1.000 · 0.000 | 0.667 · 0.471 | 0.000 |
| pnpm-workflow | on (포함, n=3) | 3 | 0.833 · 0.236 | 1.000 · 0.000 | 0.667 · 0.471 | 0.000 |
| pnpm-workflow | on (제외) | 0 | — | — | — | — |
| pnpm-workflow | oracle | 3 | 1.000 · 0.000 | 1.000 · 0.000 | 1.000 · 0.000 | 0.000 |

**n=3-2 (2026-08-15, 469, repeats=3, 2회차)**

| 시나리오 | 조건 | n | combined mean·sd | det mean·sd | judge mean·sd | Cov(D,J) |
|---|---|---|---|---|---|---|
| tabs-indentation | off | 3 | 0.667 · 0.236 | 1.000 · 0.000 | 0.333 · 0.471 | 0.000 |
| tabs-indentation | on | 3 | 0.333 · 0.236 | 0.667 · 0.471 | 0.000 · 0.000 | 0.000 |
| tabs-indentation | oracle | 3 | 0.833 · 0.236 | 1.000 · 0.000 | 0.667 · 0.471 | 0.000 |
| concise-responses | off | 3 | 0.500 · 0.408 | 0.333 · 0.471 | 0.667 · 0.471 | 0.111 |
| concise-responses | on | 3 | 0.333 · 0.236 | 0.000 · 0.000 | 0.667 · 0.471 | 0.000 |
| concise-responses | oracle | 3 | 0.667 · 0.236 | 0.667 · 0.471 | 0.667 · 0.471 | −0.111 |
| pnpm-workflow | off (포함, n=3) | 3 | 1.000 · 0.000 | 1.000 · 0.000 | 1.000 · 0.000 | 0.000 |
| pnpm-workflow | off (제외) | 1 | 1.000 · 0.000 | 1.000 · 0.000 | 1.000 · 0.000 | — |
| pnpm-workflow | on (포함, n=3) | 3 | 0.667 · 0.471 | 0.667 · 0.471 | 0.667 · 0.471 | 0.222 |
| pnpm-workflow | on (제외, n=2) | 2 | 0.500 · 0.500 | 0.500 · 0.500 | 0.500 · 0.500 | 0.250 |
| pnpm-workflow | oracle | 3 | 0.833 · 0.236 | 1.000 · 0.000 | 0.667 · 0.471 | 0.000 |

**n=10 (2026-08-29, repeats-default)**

| 시나리오 | 조건 | n | combined mean·sd | det mean·sd (n) | judge mean·sd | Cov(D,J) |
|---|---|---|---|---|---|---|
| tabs-indentation | off | 10 | 0.550 · 0.415 | 0.600 · 0.490 (10) | 0.500 · 0.500 | 0.100 |
| tabs-indentation | on | 10 | 0.650 · 0.320 | 0.800 · 0.400 (10) | 0.500 · 0.500 | 0.000 |
| tabs-indentation | oracle | 10 | 0.650 · 0.391 | 0.875 · 0.331 (**8**, inconclusive 2) | 0.500 · 0.500 | 0.063¹ |
| concise-responses | off | 10 | 0.750 · 0.403 | 0.700 · 0.458 (10) | 0.800 · 0.400 | 0.140 |
| concise-responses | on | 10 | 0.250 · 0.250 | 0.100 · 0.300 (10) | 0.400 · 0.490 | −0.040 |
| concise-responses | oracle | 10 | 0.700 · 0.332 | 0.600 · 0.490 (10) | 0.800 · 0.400 | 0.020 |
| pnpm-workflow | off (포함, n=10) | 10 | 0.700 · 0.245 | 0.900 · 0.300 | 0.500 · 0.500 | −0.050 |
| pnpm-workflow | off (제외, n=3) | 3 | 0.833 · 0.236 | 0.667 · 0.471 | 1.000 · 0.000 | 0.000 |
| pnpm-workflow | on (포함, n=10) | 10 | 0.450 · 0.269 | 0.800 · 0.400 | 0.100 · 0.300 | 0.020 |
| pnpm-workflow | on (제외, n=4) | 4 | 0.500 · 0.354 | 0.750 · 0.433 | 0.250 · 0.433 | 0.063 |
| pnpm-workflow | oracle | 10 | 1.000 · 0.000 | 1.000 · 0.000 | 1.000 · 0.000 | 0.000 |

¹ `Cov(D,J)`는 D가 정의된 8건 위에서 계산(§2.1 예외).

### 2.3 gap(ON−OFF)·gap/sd — 시나리오 × 채점기

`gap = mean(on) − mean(off)`. `sd`는 `max(sd_off, sd_on)`(더 시끄러운 팔 기준 — 선례 문서
§「판정」의 관례와 동일하게 보수적 방향). `제외`가 있는 행만 두 벌.

**n=3-1**

| 시나리오 | 채점기 | off mean·sd | on mean·sd | gap | gap/sd | gap>sd? |
|---|---|---|---|---|---|---|
| tabs-indentation | det | 1.000·0.000 | 1.000·0.000 | 0.000 | — | 아니오 |
| tabs-indentation | judge | 0.000·0.000 | 0.000·0.000 | 0.000 | — | 아니오 |
| tabs-indentation | combined | 0.500·0.000 | 0.500·0.000 | 0.000 | — | 아니오 |
| concise-responses | det | 0.667·0.471 | 0.333·0.471 | −0.333 | −0.707 | 아니오 |
| concise-responses | judge | 1.000·0.000 | 0.333·0.471 | −0.667 | −1.414 | **예** |
| concise-responses | combined | 0.833·0.236 | 0.333·0.471 | −0.500 | −1.061 | **예** |
| pnpm-workflow (포함) | det | 1.000·0.000 | 1.000·0.000 | 0.000 | — | 아니오 |
| pnpm-workflow (포함) | judge | 0.667·0.471 | 0.667·0.471 | 0.000 | 0.000 | 아니오 |
| pnpm-workflow (포함) | combined | 0.833·0.236 | 0.833·0.236 | 0.000 | 0.000 | 아니오 |
| pnpm-workflow (제외) | 전체 | — | on 표본 0건 (전량 오염) | — | — | 계산 불가 |

**n=3-2**

| 시나리오 | 채점기 | off mean·sd | on mean·sd | gap | gap/sd | gap>sd? |
|---|---|---|---|---|---|---|
| tabs-indentation | det | 1.000·0.000 | 0.667·0.471 | −0.333 | −0.707 | 아니오 |
| tabs-indentation | judge | 0.333·0.471 | 0.000·0.000 | −0.333 | −0.707 | 아니오 |
| tabs-indentation | combined | 0.667·0.236 | 0.333·0.236 | −0.333 | −1.414 | **예** |
| concise-responses | det | 0.333·0.471 | 0.000·0.000 | −0.333 | −0.707 | 아니오 |
| concise-responses | judge | 0.667·0.471 | 0.667·0.471 | 0.000 | 0.000 | 아니오 |
| concise-responses | combined | 0.500·0.408 | 0.333·0.236 | −0.167 | −0.408 | 아니오 |
| pnpm-workflow (포함) | det | 1.000·0.000 | 0.667·0.471 | −0.333 | −0.707 | 아니오 |
| pnpm-workflow (포함) | judge | 1.000·0.000 | 0.667·0.471 | −0.333 | −0.707 | 아니오 |
| pnpm-workflow (포함) | combined | 1.000·0.000 | 0.667·0.471 | −0.333 | −0.707 | 아니오 |
| pnpm-workflow (제외) | det | 1.000·0.000 (n=1) | 0.500·0.500 (n=2) | −0.500 | −1.000 | 아니오 |
| pnpm-workflow (제외) | judge | 1.000·0.000 (n=1) | 0.500·0.500 (n=2) | −0.500 | −1.000 | 아니오 |
| pnpm-workflow (제외) | combined | 1.000·0.000 (n=1) | 0.500·0.500 (n=2) | −0.500 | −1.000 | 아니오 |

**n=10**

| 시나리오 | 채점기 | off mean·sd | on mean·sd | gap | gap/sd | gap>sd? |
|---|---|---|---|---|---|---|
| tabs-indentation | det | 0.600·0.490 | 0.800·0.400 | +0.200 | 0.408 | 아니오 |
| tabs-indentation | judge | 0.500·0.500 | 0.500·0.500 | 0.000 | 0.000 | 아니오 |
| tabs-indentation | combined | 0.550·0.415 | 0.650·0.320 | +0.100 | 0.241 | 아니오 |
| concise-responses | det | 0.700·0.458 | 0.100·0.300 | −0.600 | −1.309 | **예** |
| concise-responses | judge | 0.800·0.400 | 0.400·0.490 | −0.400 | −0.816 | 아니오 |
| concise-responses | combined | 0.750·0.403 | 0.250·0.250 | −0.500 | −1.240 | **예** |
| pnpm-workflow (포함) | det | 0.900·0.300 | 0.800·0.400 | −0.100 | −0.250 | 아니오 |
| pnpm-workflow (포함) | judge | 0.500·0.500 | 0.100·0.300 | −0.400 | −0.800 | 아니오 |
| pnpm-workflow (포함) | combined | 0.700·0.245 | 0.450·0.269 | −0.250 | −0.928 | 아니오 |
| pnpm-workflow (제외) | det | 0.667·0.471 (n=3) | 0.750·0.433 (n=4) | +0.083 | 0.177 | 아니오 |
| pnpm-workflow (제외) | judge | 1.000·0.000 (n=3) | 0.250·0.433 (n=4) | −0.750 | −1.732 | **예** |
| pnpm-workflow (제외) | combined | 0.833·0.236 (n=3) | 0.500·0.354 (n=4) | −0.333 | −0.943 | 아니오 |

**det-only 재집계로 2/3 이상이 되는가(§3의 (a) 판정 조건)** — n=10, 오염 제외 기준:
`tabs-indentation` 아니오, `concise-responses` **예**, `pnpm-workflow` 아니오 → **1/3**.
2/3 문턱에 못 미친다 — (a)의 "deterministic만으로 재집계하면 2/3 이상" 조건은 세 시나리오
전체로는 성립하지 않는다.

### 2.4 judge 기여 몫 — 시나리오별 (조건 3개 풀링, 오염 제외)

각 시나리오의 `off`+`on`+`oracle` 표본을 모아(조건 간 분산도 함께 반영하는 큰 표본으로) 계산.
`inconclusive` 2건(`tabs-indentation` oracle, n=10)은 D·J 둘 다 정의된 표본에서만 계산하므로
자동 제외된다.

| 회차 | 시나리오 | n(풀링) | Var(D) 몫 | Var(J) 몫(judge 기여) | Cov(D,J) 몫(상호작용) | judge가 deterministic보다 지배적? |
|---|---|---|---|---|---|---|
| n=3-1 | tabs-indentation | 9 | 0.0% | **100.0%** | 0.0% | 예(단, Var(D)=0 — 우연히 3회 다 같은 값) |
| n=3-1 | concise-responses | 9 | 40.0% | 28.0% | 32.0% | 아니오 |
| n=3-1 | pnpm-workflow | 6 | 0.0% | **100.0%** | 0.0% | 예(Var(D)=0) |
| n=3-2 | tabs-indentation | 9 | 25.0% | 56.2% | 18.8% | 예 |
| n=3-2 | concise-responses | 9 | 50.0% | 50.0% | 0.0% | 동률 |
| n=3-2 | pnpm-workflow | 6 | 23.8% | 38.1% | 38.1% | 예(약간) |
| **n=10** | **tabs-indentation** | 28 | 34.4% | **45.9%** | 19.7% | 예(약간) |
| **n=10** | **concise-responses** | 30 | **38.4%** | 34.2% | 27.4% | **아니오** |
| **n=10** | **pnpm-workflow** | 17 | 31.9% | **44.7%** | 23.4% | 예(약간) |

**읽는 법.** n=3 회차의 "judge 100%"는 표본 3개에서 deterministic이 우연히 매번 같은 값이
나온(Var(D)=0) 결과이지, judge가 구조적으로 시끄럽다는 증거가 아니다 — 이 패턴은 n=10에서
사라진다(`tabs-indentation`·`pnpm-workflow` 둘 다 Var(D)>0으로 돌아온다). **가장 신뢰할 수
있는 n=10 기준으로는 judge 몫이 34~46%, deterministic 몫이 32~38%로 세 시나리오 다
비슷한 자릿수다** — judge가 "지배적"이라 부를 만큼 크지 않다. `concise-responses`는 오히려
deterministic 쪽 분산이 judge보다 크다.

공분산 항(19~27%, 전부 양수)이 매 시나리오에서 무시 못 할 크기라는 것도 눈에 띈다 — 두
채점기가 어느 정도 같은 방향으로 움직인다는 뜻이라(완전히 독립된 잡음이 아니라 부분적으로
공유된 신호에 반응), "judge만 떼어내면 깨끗해진다"는 가설과 반대 방향이다.

## 3. 판정 — 시나리오별 (a) / (b) / (c)

### `tabs-indentation` — **(b) 시나리오 자체가 무신호**

- ON−OFF gap(combined)이 세 회차에 걸쳐 **0.000 → −0.333 → +0.100**로 부호가 두 번 뒤집힌다
  (§2.3). 가장 큰 표본(n=10)에서도 gap 0.100은 sd 0.415의 4분의 1이다.
- judge 기여 몫(45.9%, n=10)이 deterministic(34.4%)보다 크긴 하지만, "지배적"이라 부를
  격차(§2.4 표의 다른 두 시나리오와 비슷한 자릿수)는 아니다.
- deterministic만으로 재집계해도(§2.3 n=10) gap 0.200 < sd 0.490 — 여전히 못 잡는다. judge를
  없애도 신호가 나타나지 않는다는 것은 (a)(judge 잡음 지배)를 반증한다.
- → **손질이 아니라 시나리오 교체가 맞다.** 다음 조각: 이 시나리오를 무엇으로 바꿀지 설계.

### `concise-responses` — **(c) 둘 다 아님 / 데이터로 갈리지 않음**

- ON−OFF gap(combined)이 세 회차 모두 **음수**(−0.500 / −0.167 / −0.500) — 부호가 안정적이다.
  「무신호」(b)는 아니다: 메모리 압축이 개입하면 짧은 응답·불필요한 서두 생략 선호가
  오히려 더 안 지켜지는 방향으로, 재현 가능한 신호가 있어 보인다.
- 그런데 **그 신호를 어느 채점기가 잡아내는지가 회차마다 다르다**: n=3-1에서는 judge만
  gap>sd(−1.414)이고 deterministic은 못 잡는다(−0.707인데 sd도 0.471이라 문턱 미달). n=10에서는
  반대로 deterministic만 gap>sd(−1.309)이고 judge는 못 잡는다(−0.816, sd 0.490 미달). n=3-2는
  둘 다 못 잡는다.
- 이 반전 자체가 (a)를 반증한다 — "judge가 잡음원"이라면 judge를 빼면 항상 더 선명해져야
  하는데, 한 회차(n=10)에서는 반대로 judge가 deterministic보다 신호를 못 잡는다.
- `Var(D)`(0.249)가 `Var(J)`(0.222)보다 큰 것도(n=10, §2.4) (a)의 "judge sd가 지배적" 전제와
  안 맞는다.
- → 표본을 늘리면(1안) 어느 채점기가 실제로 안정적인 신호원인지 가려질 가능성이 있다 —
  이 시나리오만 놓고 보면 1안이 유효한 다음 수단이다. 다만 부호가 이미 일관되게 음수라는
  점은 owner가 검토할 가치가 있다(§3 하단 특기사항).

### `pnpm-workflow` — **(c) 둘 다 아님 / 데이터로 갈리지 않음 (원인: 오염)**

- 오염 제외 시 팔당 표본이 n=10 회차 기준 OFF 3건·ON 4건(§2.2)까지 줄어든다 — 세 채점기
  분해 자체가 신뢰구간을 낼 수 없는 크기다. n=3 두 회차는 더 심해서 n=3-1은 ON 표본이
  0건까지 떨어진다(§2.3).
- 판정 불가의 원인이 채점기 잡음도 시나리오 무신호도 아니라 **표본 오염**이라는 점이
  다른 두 시나리오와 다르다 — (a)/(b) 어느 쪽도 이 시나리오에 적용할 근거 자체가 부족하다.
- → 다음 조각은 손질도 교체도 아니라 **깨끗한 재수집**이다. bash jail(#489/#491, 08-29
  22:07 머지)이 이스케이프 경로를 이미 닫았으므로, 지금 다시 돌리면 오염 없이 표본을 얻을
  수 있을 것으로 보인다(검증되지 않은 가정 — 재실행이 그 자체로 확인이 된다).

### 특기사항 — owner 검토용 (이 이슈의 판정을 바꾸지 않음)

`concise-responses`의 ON−OFF gap이 세 독립 회차 모두 음수라는 것은, 이 조각의 판정
((a)/(b)/(c))과는 별개로 **이 벤치의 본래 질문("메모리가 선호 유지에 도움되는가")에 대해
선례 문서의 `oracle-off` 기반 "아니오"보다 구체적인 관측**이다 — `oracle-off`는 "판정 가능한가"만
보는 검증 지표이고, 이 문서가 새로 낸 `on-off`가 실제 목표 지표다. 이 관측을 근거로 아무
조치도 제안하지 않는다(§비범위: 시나리오·루브릭 실제 수정은 이 이슈 몫이 아니다) — 다만
다음 조각을 설계할 때 이 부호가 우연이 아닐 가능성을 염두에 두는 편이 좋다.

## 4. 다음 조각 — 대상과 예상 실측 비용

| 대상 | 작업 | 예상 실측 비용 |
|---|---|---|
| `tabs-indentation` | 시나리오 교체 설계(무엇으로 바꿀지) 후 n=10 규모 재검증 1회 | 선례 문서 §6-2와 동일 자릿수, **$0.25 안팎** (전체 3시나리오 재검증 비용의 1/3 정도로 추정 — 개별 시나리오만 재실행하면 더 낮아질 수 있음) |
| `concise-responses` | 표본 확대(1안) — 채점기 반전이 실제 신호인지 잡음인지 가르기. SE를 절반으로 줄이려면 n≈4배(약 40회) 필요(선례 §6-1 산식과 동일) | **$0.5~$1** (선례 §6-1의 전체 3시나리오 견적 $1~4을 시나리오 1개로 축소) |
| `pnpm-workflow` | 격리 확인 후(#489/#491 머지됨) 재실행 — 손질·교체 아님 | 시나리오 1개, n=10 규모 기준 **$0.1 미만**(전체 $0.245의 1/3보다 작음, `pnpm-workflow`는 조건별 응답이 더 짧다) |

세 대상을 한 회차에 묶어 돌리면(같은 CLI 실행) 개별 합보다 저렴할 수 있다 — 다만 시나리오
교체(`tabs-indentation`)와 표본 확대(`concise-responses`)는 설계 작업이 선행돼야 해서 지금
바로 묶어 돌릴 수 있는 것은 `pnpm-workflow` 재실행뿐이다.

## 부록 — 재현

```bash
# §1 오염 판별식 (일반화 버전)
jq -r '.scenarios[] | select((.compactionSummary//"") | test("/data/repos|workspace/work/mori-issue")) | "\(.scenarioId)|\(.condition)|\(.repeatIndex)"' <report>

# §1 오염 판별식 (issue 원문, 08-29 회차에만 유효)
jq -r '.scenarios[] | select((.compactionSummary//"") | contains("483")) | "\(.condition)|\(.repeatIndex)"' <report>

# §2 inconclusive deterministic 건수
jq '[.scenarios[].score.criteria[] | select(.kind=="deterministic" and .satisfied=="inconclusive")] | length' <report>
```

sd·gap·공분산 계산은 일회성 Node 스크립트(리포에 커밋하지 않음)로 했다 — `sample-stats.ts`의
모집단 분산 정의를 그대로 따랐고, §2.1의 검산으로 `scorer.ts`의 합산식과 일치함을 확인했다.
