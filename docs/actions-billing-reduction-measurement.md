# Actions 청구 감축 실측 — #479 반사실 확정 (#478 조각 3/N)

과금정지(2026-08-15 13:39 UTC ~ 08-29 10:02 UTC) 구간이 섞여 "after를 그냥 재는" 방법을
쓸 수 없어서, 과거의 깨끗한 구간에서 반사실(counterfactual)로 확정한다. 집계 도구:
`.github/scripts/billed-usage-report.sh` (#486에서 워크플로 × 트리거 이벤트 분해 추가).

## (a) 깨끗한 구간의 실제 출력

```
$ REPO=shakystar/mori bash .github/scripts/billed-usage-report.sh --since 2026-08-01 --until 2026-08-14

## Actions 청구 잡 수 집계 (2026-08-01..2026-08-14, 14일)

| 워크플로 | 실행 수 | 청구 잡 수 | 벽시계 분 |
|---|---:|---:|---:|
| Refresh armed PRs | 59 | 114 | 32.7 |
| CI | 223 | 225 | 378.8 |
| Recheck open PRs | 151 | 661 | 322.4 |
| Notify merge | 72 | 72 | 10.2 |
| Line citation advisory | 48 | 48 | 14.7 |

| 워크플로 | 이벤트 | 실행 수 | 청구 잡 수 | 벽시계 분 |
|---|---|---:|---:|---:|
| Refresh armed PRs | push | 58 | 112 | 32.3 |
| CI | push | 74 | 73 | 138.8 |
| Recheck open PRs | push | 74 | 353 | 134.7 |
| Notify merge | pull_request | 72 | 72 | 10.2 |
| Line citation advisory | pull_request | 48 | 48 | 14.7 |
| CI | pull_request | 149 | 152 | 240.0 |
| Recheck open PRs | pull_request | 77 | 308 | 187.8 |
| Refresh armed PRs | workflow_dispatch | 1 | 2 | 0.4 |

청구 잡 수 합계: 1120

월 환산 청구 잡 수 추정치 = 1120 / 14일 × 30일 = 2400.0

* 이 리포의 timing API는 total_ms를 채우지 않아(#480 실측, 2026-08-29) 과금정지 run과
  정상 run을 구분할 수 없다. 위 합계는 기간 내 전체 run의 billable.jobs 합이며,
  과금정지 구간(2026-08-15 13:39 UTC~08-29 10:02 UTC)이 섞였는지는 --since/--until로
  기간을 좁혀 확인한다.
```

종료 코드 0 (기간 전체 완주, 부분 결과 아님).

**08-16까지 쓰지 않는 이유**: 08-15 13:39 UTC부터 과금정지 run이 섞이는데, 이 리포의
`timing` API가 `total_ms`를 채우지 않아 집계기가 정지 run과 정상 run을 구분하지 못하므로
(위 각주), 정지 시작 이전 날짜(08-14)까지만 자른다.

## (b) 변경 후 회당 청구 잡 수의 확정

`.github/workflows/recheck-open-prs.yml`의 `pull_request` 트리거(`synchronize`,
`reopened`, `ready_for_review`, 27\~29행)는 잡 셋으로 구성된다 — `discover`(44\~95행,
조건 없이 항상 실행), `recheck`(97\~110행, `if: needs.discover.outputs.count != '0'`,
`matrix.pr = needs.discover.outputs.prs`), `report`(275\~280행,
`if: !cancelled() && needs.discover.result == 'success' && needs.discover.outputs.report_count != '0'`).
대상 선정은 `.github/scripts/recheck-select.sh`가 한다.

`pull_request` 이벤트에서 `recheck-select.sh`는 대상 후보를 트리거한 PR 하나로 고정한다
(`numbers=("${PR_NUMBER:?...}")`, 70행) — `push` 이벤트처럼 열린 PR 전체를 조회하지
않는다(61\~68행은 `push` 분기 전용). 그 PR 하나를 `classify()`(91\~151행)로 판정해
`run`(재검증 대상, 158\~160행) / `skip:*`(드래프트·충돌·머지가능성 계산중 — 로그만 남기고
`sel`·`unverified` 어디에도 담기지 않음, 162\~164행) / `error:classify-*`(재시도
`RETRY_ATTEMPTS`회를 다 써도 판정 불가 — `unverified`에 담김, 165\~170행) 셋으로 가른다.
`count`는 `sel`(재검증 대상)의 길이(188행), `report_count`는 `sel + unverified`의
길이(182\~191행)다.

**① 트리거한 PR이 스윕 대상일 때(`classify()` → `run`)**

- `count`는 1(`sel`에 그 PR 1건, 158~160행) → `recheck`의 `if`를 통과하고 `matrix.pr`
  원소가 1개 → **recheck 1잡**.
- `report_count`도 1(`sel`에 있던 PR이 `report`에도 들어감, 184행) → `report`의 `if`를
  통과 → **report 1잡**.
- `discover`는 항상 실행 → **discover 1잡**.
- 합계 **discover(1) + recheck(1) + report(1) = 3잡**. PR #481 본문이 적은 값과
  일치한다 — 어긋남 없음.

**② `count`가 0일 때(트리거한 PR이 스윕 대상이 아닐 때)**

`classify()`의 반환값에 따라 다시 갈린다:

- `skip:draft` / `skip:conflict` / `skip:mergeability-unknown`(162~164행의 `skip:*`
  분기)이면 그 PR은 `sel`에도 `unverified`에도 안 담긴다 → `report`가 빈 배열 →
  `report_count=0` → `report`의 `if`가 거짓이라 **report 잡 자체가 청구되지 않는다**.
  `recheck`도 `count=0`이라 `if`가 거짓 — **매트릭스가 펴지지 않고, 그 잡은 청구되지
  않는다**(GitHub Actions는 `if`가 거짓인 잡을 실행도 청구도 하지 않는다 — 매트릭스
  0개짜리 잡이 1잡으로 잡히는 게 아니다). → **discover(1)만 청구, 합계 1잡**.
- `error:classify-*`(재시도를 다 써도 판정 불가, 165~170행의 default 분기)이면 그 PR은
  `unverified`에 담긴다 → `report_count=1` → **report 1잡**은 청구된다. `recheck`는
  여전히 `count=0`이라 스킵. → **discover(1) + report(1) = 2잡**.
- 합계 **1잡(스킵/충돌/계산중 미해결) 또는 2잡(분류 자체가 끝내 실패)**. PR #481 본문의
  "discover(1) + report(0 or 1)"과 일치한다.

**timing 호출 수**: run당 1회 그대로다. `event`는 run 목록 조회에 이미 있던 필드고
(`billed-usage-report.sh:89`가 `.workflow_runs[].event`를 `map`에서 살리기만 했다),
`timing` API 호출(`billed-usage-report.sh:133`)은 `while` 루프 반복당(= run당) 1회이며
이 조각에서 호출 위치나 횟수를 바꾸지 않았다.

## (c) 반사실 절감

이 창(2026-08-01~08-14)은 이미 narrowing 적용 **이후**다 — narrowing 자체는 #112(커밋
4cd05c2, PR #119, 2026-07-30 머지)로 들어갔고, #479(PR #481)는 그 위에 "왜 좁히는지"
문서화만 추가했을 뿐 코드 diff가 없다(PR #481 본문: "이 PR이 실제로 채우는 것은... 문서화뿐이다").
그래서 이 창의 `Recheck open PRs × pull_request` 실측(실행 77, 청구 잡 수 308)은
**narrowing 적용 전 표본을 포함하지 않는다** — #479 자체의 전/후 델타를 낼 "narrowing 이전"
표본이 이 창 안에는 없다.

(a)·(b)의 숫자만으로 재현 가능한 확인은 (b)에서 확정한 모델이 실측을 설명하는 정도다:

```
절감 확인 = 실측 잡 수 − 실행 수 × 회당 잡 수(①의 상한, 3)
          = 308 − 77 × 3
          = 308 − 231
          = +77
```

부호가 양수라는 것은 실측(308)이 narrowed 모델의 이론적 상한(77건 전부가 ①이라 가정한
최댓값 231)을 77잡 **초과**한다는 뜻이다. narrowing이 풀렸거나 롤백된 흔적은 없으므로
(코드는 여전히 트리거 PR 1건으로 고정) 이 초과분은 이 조각의 3-1-2잡 모델이 설명하지
못하는 요인(예: 잡 재시도/재실행이 같은 run id의 `billable.jobs`에 누적되는 경우)에서
온다고 보는 것이 가장 근거 있는 해석이다. 잡 단위 정확 산정(재시도 포함)은 #486 비범위
("잡 단위 정확 분 산정... 이번 판정에는 충분하지 않다")다.

**⇒ #479에 귀속되는 반사실 절감분 = 0잡.** 관측이 불가능해서가 아니라, #479가 코드를
바꾸지 않았으므로 낼 전/후 델타 자체가 없다 — narrowing이 만든 절감은 이 창 이전(07-30
이전 대비)에 이미 실현되어 있고, 그 이전 구간은 이 리포의 run 보존 기간·측정 범위 밖이라
반사실을 세울 표본이 없다.

절감 후(= 현재, 이미 narrowed) 월 환산 추정치는 실측치 그대로다:

```
Recheck open PRs × pull_request 월 환산 = 308 / 14일 × 30일 = 660.0잡/월
```

## (d) 3,000분 예산 대비 위치

청구 잡 수는 청구 분의 **하한**이다 — 잡 하나가 1분 올림으로 청구되므로, 1분을 넘는 잡은
그만큼 더 나간다.

집계기가 (a)의 실행에서 이미 계산한 전체 워크플로 월 환산 추정치는:

```
1120 / 14일 × 30일 = 2400.0잡/월
```

이는 청구 **분**의 하한이므로 실제 청구 분은 이보다 크거나 같다. #478의 완료 기준(3,000의
절반 = 1,500)과 비교하면 **하한(2400.0)이 이미 1,500을 넘는다** — 결론: **추가 감축
필요**.

다음 감축 대상 1순위는 (a)의 이벤트 분해 표에서 숫자로 드러난다:

| 워크플로         | 이벤트 | 실행 수 | 청구 잡 수 | 벽시계 분 |
| ---------------- | ------ | ------: | ---------: | --------: |
| Recheck open PRs | push   |      74 |        353 |     134.7 |

이 행이 이벤트 분해 표 전체에서 청구 잡 수 **최댓값**이다(2위 `Recheck open PRs ×
pull_request` 308, 3위 `CI × pull_request` 152). `push:[main]` 트리거는 여전히 열린 PR
전체를 스윕하는, narrowing이 적용되지 않은 경로다(`recheck-open-prs.yml:20~26` 주석 —
"push:[main]의 전체 스윕과 다르다") — #479/PR #481이 "의도된 동작"으로 명시적으로 남겨
둔 부분이지만, 청구 잡 수 기준으로는 이제 이 행이 단일 최대 기여자다.

## (e) 재측정 레시피

복구(2026-08-29 10:02 UTC) 이후 7일 표본이 쌓이면 아래를 그대로 실행한다:

```
REPO=shakystar/mori bash .github/scripts/billed-usage-report.sh --since 2026-08-30 --until 2026-09-05
```

이번 조각에서는 표본이 없어 **미측정**.
