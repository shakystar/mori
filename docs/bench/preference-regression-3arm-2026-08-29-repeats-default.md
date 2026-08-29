# PreferenceRegression 3팔 실측 — 기본 반복(n=10) 1회차 (#457 조각 3/N, #483)

## 판정

**이 벤치는 지금 ON/OFF 델타의 부호를 읽을 수 있는가 — 아니오.**

`gap`(ORACLE−OFF 평균 간격)이 `sd`(팔별 표준편차)보다 큰 시나리오는 **1/3**
(`pnpm-workflow`)뿐이다. 나머지 둘(`tabs-indentation`, `concise-responses`)은 gap이
sd의 4분의 1도 안 된다 — 관측된 간격이 표본 잡음 안에 묻힌다.

| 시나리오             | gap (ORACLE−OFF) | sd 범위 (OFF·ORACLE) | gap > sd? |
| -------------------- | ----------------- | --------------------- | --------- |
| `tabs-indentation`   | +0.100             | 0.391 ~ 0.415          | 아니오    |
| `concise-responses`  | −0.050             | 0.332 ~ 0.403          | 아니오    |
| `pnpm-workflow`      | +0.300             | 0.000 ~ 0.245          | **예**    |

반복을 3(n=3 두 회차)에서 기본값 10(n=10, 시나리오·팔당 90 에피소드)까지 3배 넘게
올렸는데도 판정 가능 시나리오 수는 나아지지 않았다 — 아래 §1의 세 회차 비교표가 보이듯,
`gap > sd` 카운트는 회차1 1/3(그나마 sd=0인 시나리오가 우연히 걸린 경우) → 회차2 0/3 →
이번 n=10 1/3로, **세 번의 독립 측정 어느 것도 2/3에 닿지 못했다.** 표본을 늘리는 것만으로
해결될 문제가 아니라는 신호다(§5).

이 판정선(2/3)과 그 결과로 갈리는 다음 조치는 issue #483 코멘트(owner, 2026-08-29)에
사전 고지돼 있다 — 여기서는 관측치와 판정만 보고하고, `#344` 게이트 처리나 `#457` 나머지
조각의 착수 여부는 이 문서의 범위가 아니다(owner가 이 문서의 「N/3」 한 줄만 읽고 정한다).

## 1. 시나리오별 판정 — 세 회차 비교 (n=3 ×2, n=10 ×1)

| 시나리오            | 회차  | n(팔당) | OFF 평균 | ON 평균 | ORACLE 평균 | ORACLE−OFF | 킬 스위치¹      |
| ------------------- | ----- | ------- | -------- | ------- | ----------- | ---------- | --------------- |
| `tabs-indentation`  | n=3-1 | 3       | 0.500    | 0.500   | 1.000       | +0.500     | 통과            |
| `tabs-indentation`  | n=3-2 | 3       | 0.667    | 0.333   | 0.833       | +0.167     | 발동(gap<0.25)  |
| `tabs-indentation`  | n=10  | 10      | 0.550    | 0.650   | 0.650       | **+0.100** | 발동            |
| `concise-responses` | n=3-1 | 3       | 0.833    | 0.333   | 0.667       | −0.167     | 발동            |
| `concise-responses` | n=3-2 | 3       | 0.500    | 0.333   | 0.667       | +0.167     | 발동            |
| `concise-responses` | n=10  | 10      | 0.750    | 0.250   | 0.700       | **−0.050** | 발동            |
| `pnpm-workflow`     | n=3-1 | 3       | 0.833    | 0.833   | 1.000       | +0.167     | 발동            |
| `pnpm-workflow`     | n=3-2 | 3       | 1.000    | 0.667   | 0.833       | −0.167     | 발동            |
| `pnpm-workflow`     | n=10  | 10      | 0.700    | 0.450   | 1.000       | **+0.300** | **통과**        |

¹ 킬 스위치 판정 규약은 [`...-repeats-3.md`](preference-regression-3arm-run-2026-08-15-repeats-3.md)와
동일 — `kill-switch.ts`의 임계값(0.25) 상수, `sample-stats.ts`의 같은 추출·요약 함수를 그대로 쓴다.
이번 회차에서 코드는 건드리지 않았다(diff에 `kill-switch.ts` 없음, §4에서 재확인).

`pnpm-workflow`가 세 회차 중 처음으로 킬 스위치를 **통과**했다 — n=3 두 회차는 부호까지
뒤집혔는데(+0.167 → −0.167), n=10에서는 ORACLE이 sd=0(10/10 만점)으로 완전히 안정되고
OFF도 sd=0.245로 상대적으로 좁아 gap 0.300이 임계값과 sd 둘 다를 넘는다. 나머지 두
시나리오는 여전히 sd가 gap의 3~8배다.

## 2. 팔별 표본 산포 — n=10 (이번 회차)

`sampleStats`를 그대로 옮겼다. `sd`는 모집단 표준편차(n으로 나눔), 이전 회차와 같은 규약이다.

| 시나리오            | 팔     | n  | 평균  | sd    | [min, max] |
| ------------------- | ------ | -- | ----- | ----- | ---------- |
| `tabs-indentation`  | OFF    | 10 | 0.550 | 0.415 | [0, 1]     |
| `tabs-indentation`  | ON     | 10 | 0.650 | 0.320 | [0, 1]     |
| `tabs-indentation`  | ORACLE | 10 | 0.650 | 0.391 | [0, 1]     |
| `concise-responses` | OFF    | 10 | 0.750 | 0.403 | [0, 1]     |
| `concise-responses` | ON     | 10 | 0.250 | 0.250 | [0, 0.5]   |
| `concise-responses` | ORACLE | 10 | 0.700 | 0.332 | [0, 1]     |
| `pnpm-workflow`     | OFF    | 10 | 0.700 | 0.245 | [0.5, 1]   |
| `pnpm-workflow`     | ON     | 10 | 0.450 | 0.269 | [0, 1]     |
| `pnpm-workflow`     | ORACLE | 10 | 1.000 | 0.000 | [1, 1]     |

읽는 법: `tabs-indentation`·`concise-responses`는 OFF·ORACLE 두 팔의 sd가 0.33~0.42로
비슷하게 크고 평균은 거의 같다 — 「정답을 줘도 안 줘도 채점 잡음 안에서 구분이 안 된다」는
뜻이다. `pnpm-workflow`만 ORACLE이 sd=0으로 바닥을 찍어(10회 모두 만점) 신호가 잡음 위로
드러난다. 세 시나리오 모두에서 `repeatIndex` 0~9 전 구간에 걸쳐 매 팔·시나리오 조합이
정확히 10개 표본이다(§3에서 원본 JSON으로 검증).

## 3. 완료 조건 1 — `repeatIndex` 분포가 시나리오·팔당 10인가

리포트 JSON(`reports/preference-regression-3arm-2026-08-29-repeats-default.json`)의
`scenarios` 배열 90건을 (시나리오, 조건)으로 묶으면 9개 조합 **전부** 정확히 10건이다:

```
tabs-indentation |memory-off  10건
tabs-indentation |memory-on   10건
tabs-indentation |oracle      10건
concise-responses|memory-off  10건
concise-responses|memory-on   10건
concise-responses|oracle      10건
pnpm-workflow    |memory-off  10건
pnpm-workflow    |memory-on   10건
pnpm-workflow    |oracle      10건
```

`repeatsPerScenario` 필드도 `10`이다. `--repeats` 인자 없이 CLI 기본값
(`DEFAULT_SLICE_REPEATS_PER_SCENARIO`, nightly-slice.ts)을 그대로 썼다.

## 4. 코드 변경 없음 확인

이번 회차는 기존 CLI를 인자 없이(기본 반복값으로) 돌려 산출물만 만들었다 — 프로덕션 코드는
건드리지 않았다. `kill-switch.ts`의 임계값 상수(`KILL_SWITCH_GAP_THRESHOLD = 0.25`)도 그대로다
(이 브랜치의 diff는 `docs/bench/` 아래 파일만 포함한다).

## 5. 임계값(0.25) 소견 — 코드는 바꾸지 않는다

`kill-switch.ts`의 주석대로 0.25는 **단일 표본** 점수 척도(항목 하나가 갈리면 최소
0.5 차이가 난다)에서 유도됐다 — "차이가 0.25 미만이면 사실상 0과 같다"는 논리다. 이번
n=10 회차는 그 전제를 벗어난다: 팔별 평균은 이제 10개 표본의 평균이라 0.05 단위까지
촘촘하게 나오고(§2 평균값들이 실제로 .05 단위), 임계값과 비교해야 할 진짜 잡음은
개별 항목의 이산성이 아니라 **표본 표준편차(0.25~0.42)**다.

관측적으로는 0.25가 나쁜 문턱은 아니다 — 우연히도 이번 회차의 sd 대역(0.25~0.42)과
같은 자릿수라, "gap이 0.25를 넘는다"는 대략 "gap이 관측된 sd 중 가장 작은 값과
맞먹는다"는 요구와 비슷하게 작동한다(`pnpm-workflow`가 그 경계선에서 통과한 것도
우연이 아니다: gap 0.300 vs OFF sd 0.245). 다만 **표본 크기(n)를 반영하지 않는다**는
결함은 그대로다 — n을 더 올려 표준오차(SD/√n)를 줄여도 임계값 자체는 고정이라, n이
커질수록 이 문턱은 사실상 "표준오차의 몇 배"인지가 계속 달라진다(n=3에서는 SD/√3 대비
느슨했고, n=10에서는 SD/√10 ≈ 0.10~0.13이라 임계값 0.25가 SD/√n의 약 2~2.5배 —
95% 신뢰구간 폭과 우연히 비슷한 자릿수다). 표본이 더 커지면(§6) 이 우연한 일치가 깨질
수 있으므로, **n이 고정되지 않는 한 이 임계값이 계속 맞을 것이라는 보장은 없다** — 표본
크기를 반영하는 통계적 기준(예: gap > k·SE)으로 바꾸는 편이 장기적으로 안전하다는 것이
이번 회차의 소견이다. 판단은 owner 몫이며, 이 이슈에서 상수를 바꾸지 않았다(§4).

## 6. 다음 수단 (이 회차가 「아니오」이므로 최소 2안)

1. **표본을 더 올린다.** 현재 SE(=sd/√n)는 시나리오별로 0.08~0.13 수준이다.
   `tabs-indentation`(gap 0.100)·`concise-responses`(gap 0.050)의 gap을 SE의
   2배 이상으로 밀어 올리려면 SE를 각각 0.05·0.025 이하로 낮춰야 하고, 이는
   n ≈ (sd/목표SE)² 관계로 n을 4~16배(전체 40~150회 반복 수준)까지 올려야 한다는
   뜻이다. 이번 회차($0.245, 90 에피소드) 기준으로 비용은 **약 $1~$4** 선까지
   뛴다 — 표본을 올려도 부호가 계속 안 잡히면(특히 `concise-responses`처럼 두 회차
   연속 부호가 갈린 시나리오) 표본 부족이 아니라 시나리오·루브릭 자체의 문제일
   가능성이 커진다.
2. **시나리오·루브릭을 손질한다.** `pnpm-workflow`만 유일하게 ORACLE sd=0(완전
   결정적 채점)을 보인다 — 다른 두 시나리오의 judge 채점 자체가 잡음원일 가능성이
   있다. deterministic 채점 비중을 늘리거나(현재 시나리오당 deterministic 1개 +
   judge 1개), `concise-responses`처럼 부호가 회차마다 뒤집히는 시나리오를 교체하는
   방향. 비용은 실측이 아니라 엔지니어링 시간이고, 손질 뒤 재검증에 이번 회차 규모
   재실행(**$0.25 안팎**)이 한 번 더 필요하다.
3. **(참고, 이 이슈 비범위) 임계값을 SE 기반으로 바꾼다** — §5 소견을 코드에
   반영하는 안. owner 판단 대상.

## 7. 실측 비용 — 원장 기준

- 총비용: **$0.2450** (`total.cost.total`, 리포트 JSON)
- provider 스트림 호출: 1339건(캐시 적중 제외) — n=3 두 회차(481건 + 399건 = 880건)
  대비 약 1.5배. 반복 3→10(3.3배)만큼 선형으로 늘지 않은 것은 judge/reader 호출
  일부가 캐시 디렉터리(`MORI_BENCH_CACHE_DIR=/data/bench-cache`, 이 플릿의 공유
  경로)를 실제로 탔기 때문으로 보인다 — 에피소드 세션 턴 자체는 #473(PR #484, 아직
  미머지)이 배선되기 전이라 여전히 매 회차 실호출이다.
- 모델 세 자리(`MORI_MODEL`·`MORI_CONSOLIDATE_MODEL`·judge) 모두
  `deepseek/deepseek-v4-flash` — n=3 두 회차와 동일.

## 부록: 산출물

- 리포트 JSON: [`reports/preference-regression-3arm-2026-08-29-repeats-default.json`](reports/preference-regression-3arm-2026-08-29-repeats-default.json)
- 재현 명령: `MORI_MODEL=deepseek/deepseek-v4-flash MORI_CONSOLIDATE_MODEL=deepseek/deepseek-v4-flash pnpm bench:nightly-slice --out <경로>`
  (`--repeats` 생략 → 기본값 10)
- CLI는 킬 스위치 발동(무효 시나리오 2건)으로 종료 코드 1을 반환했다 — §1 참고,
  #401 선례대로 재실행 대상이 아니라 보고 대상이다.
- `rubricVersion`: 2 (#476 반영 — `uses-tab-indentation`의 `inconclusive` 판정이
  들어간 버전. #476 자체는 이 브랜치의 베이스 `main`에 이미 머지돼 있다).
