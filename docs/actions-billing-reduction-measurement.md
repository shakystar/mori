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

(참고, 비게이팅) `Recheck open PRs` 워크플로별 벽시계 분(322.4)과 이벤트 분해 두 행의
합(134.7 + 187.8 = 322.5)이 0.1 어긋난다 — 워크플로별·이벤트별 합계를 각각 독립적으로
`%.1f`로 반올림해서 생기는 표시 오차다(실행 수 74+77=151, 청구 잡 수 353+308=661은
정확히 크로스풋된다 — ms 단위 원본 합산 자체는 문제없다).

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
  일치한다 — 다만 이 일치는 **머지된 코드(`recheck-open-prs.yml`·`recheck-select.sh`)를
  읽어 세운 모델끼리의 일치**이지 실측과의 일치가 아니다. (a)의 실측
  `Recheck open PRs × pull_request`는 77실행 / 308잡, 즉 **회당 4.0잡**으로 이 모델의
  상한 3잡을 33% 넘는다. 초과분의 해석은 아래 (c) 참조 — 결론만 먼저 적으면, 이
  3잡 모델 자체가 틀렸다: (f)에서 밝히듯 실제로는 네 번째 잡(`report-discovery-failure`)이
  매 run마다 존재해 **①의 상한은 3잡이 아니라 4잡**이다.

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
온다고 보는 것이 가장 근거 있는 해석이다. 이 가설은
`GET /repos/{owner}/{repo}/actions/runs/{run_id}` 의 `run_attempt` 와
`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs?filter=all` 의 `jobs[].run_attempt`
분포를 대조하면 갈린다 — 같은 run id에 `run_attempt ≥ 2` 인 잡이 있으면 재시도분이
`timing` 의 `billable.*.jobs` 에 누적된 것이다. **이 조각에서는 조회하지 않는다**(#486 비범위).
잡 단위 정확 산정(재시도 포함)은 #486 비범위다("잡 단위 정확 분 산정 … (d)의 **하한**으로
이번 판정에는 충분하다").

**(f)(#494)가 이 대조를 실제로 실행했다 — 재시도 가설은 기각됐다.** 77실행 전부
`run_attempt=1`(재시도 0건)이고, 초과 77잡은 (b)의 모델이 세지 않은 네 번째 잡
(`report-discovery-failure`)이 매 run마다 등장하기 때문이다. 자세한 재현·분해는 (f) 참조.

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

## (f) 회당 4.0잡 초과분의 해명 — run_attempt 대조 (#478 조각 5/N)

(b)가 세운 모델은 `pull_request` 트리거·스윕 대상 PR 1건일 때
discover(1) + recheck(1) + report(1) = **상한 3잡**이라고 했지만, (a)의 실측은
77실행/308잡, 즉 **회당 4.0잡**이었다 — 상한을 77잡(33%) 초과한다. (c)는 이 초과분의
후보로 "잡 재시도/재실행이 같은 run id의 `billable.*.jobs`에 누적되는 경우"를 가설로
남기고 조회는 다음 조각으로 미뤘다(#486 비범위). 이 절이 그 조회다.

### 재현 명령

```bash
REPO=shakystar/mori
WF_ID=$(gh api "repos/${REPO}/actions/workflows" --jq \
  '.workflows[] | select(.name=="Recheck open PRs") | .id')

# 1) 대상 run 목록 (2026-08-01~08-14, pull_request 이벤트) — (a)의 77실행과 일치해야 한다
gh api --paginate "repos/${REPO}/actions/workflows/${WF_ID}/runs?created=2026-08-01..2026-08-14&event=pull_request&per_page=100" \
  | jq -s '[.[].workflow_runs[]?] | length'
# => 77

# 2) run 목록 자체의 run_attempt(최신 시도 번호) 분포 — rerun이 있었으면 2 이상이 섞인다
gh api --paginate "repos/${REPO}/actions/workflows/${WF_ID}/runs?created=2026-08-01..2026-08-14&event=pull_request&per_page=100" \
  | jq -s '[.[].workflow_runs[]?.run_attempt] | group_by(.) | map({attempt: .[0], count: length})'
# => [{"attempt":1,"count":77}]  — 전부 attempt 1, run 단위 재시도 0건

# 3) run별 jobs(filter=all)로 잡 수·잡별 run_attempt·매트릭스 펼침 여부를 모은다
ids=$(gh api --paginate "repos/${REPO}/actions/workflows/${WF_ID}/runs?created=2026-08-01..2026-08-14&event=pull_request&per_page=100" \
  | jq -s -r '[.[].workflow_runs[]?.id] | .[]')
: > /tmp/job_names.tsv
for id in $ids; do
  gh api "repos/${REPO}/actions/runs/${id}/jobs?filter=all&per_page=100" \
    | jq -r --arg id "$id" '.jobs[] | [$id, .name, .conclusion, .run_attempt] | @tsv' \
    >> /tmp/job_names.tsv
done

wc -l /tmp/job_names.tsv                                     # => 308  (= 77 x 4)
awk -F'\t' '{print $4}' /tmp/job_names.tsv | sort | uniq -c   # => "308 1" — 잡 단위도 재시도 0건
awk -F'\t' '{n=$2; gsub(/\([0-9]+\)/,"(N)",n); print n"\t"$3}' /tmp/job_names.tsv \
  | sort | uniq -c

# 4) run별 Recheck PR* 잡 수 분포 — 매트릭스 2건 이상 run이 있는지 직접 센다.
#    (잡이 0개인 run도 세야 하므로 run id 목록을 돌며 센다. tsv만 group-by 하면 0건 run이 빠진다.)
for id in $ids; do
  awk -F'\t' -v id="$id" '$1==id && $2 ~ /^Recheck PR/ {c++} END {print c+0}' /tmp/job_names.tsv
done | sort | uniq -c
# => "     77 1"  — 77개 run이 각각 정확히 1건. 2 이상이나 0이 하나라도 나오면 분해 표의
#    「매트릭스 2건 이상」 버킷은 0이 아니며, 실제 분포에 맞춰 표를 고쳐야 한다.

# 5) run별 report-discovery-failure 잡 수 분포 — 잔여분 77의 직접 근거.
for id in $ids; do
  awk -F'\t' -v id="$id" '$1==id && $2=="Report that PR selection failed" {c++} END {print c+0}' /tmp/job_names.tsv
done | sort | uniq -c
# => "     77 1"
```

세 번째 명령의 출력(2026-08-29 조회):

```
     1 Recheck PR	cancelled
     1 Recheck PR	skipped
     3 Recheck PR (N)	cancelled
     6 Recheck PR (N)	failure
    66 Recheck PR (N)	success
     5 Report results on the PRs	cancelled
     1 Report results on the PRs	skipped
    71 Report results on the PRs	success
     1 Report that PR selection failed	cancelled
    76 Report that PR selection failed	skipped
     1 Select open PRs	cancelled
    76 Select open PRs	success
```

네 번째·다섯 번째 명령의 실제 출력(2026-08-30 재조회) — 각각 run별 `Recheck PR*`
잡 수, run별 `report-discovery-failure` 잡 수 분포다:

```
     77 1
```

```
     77 1
```

두 분포 모두 77개 run 전부 정확히 1건 — 0건이나 2건 이상인 run은 없다.

### 분해

| 항목                             |  잡 수 |
| -------------------------------- | -----: |
| 재시도분 (`run_attempt` ≥ 2)     |      0 |
| 매트릭스 2건 이상으로 펼쳐진 run |      0 |
| 잔여분                           |     77 |
| **합계(= 초과분 77과 일치)**     | **77** |

- **재시도분 = 0**: run 목록의 `run_attempt`(77건 전부 1)와 잡 목록의
  `jobs[].run_attempt`(308건 전부 1) 양쪽 다 2 이상이 단 하나도 없다. (c)가 남긴
  재시도 가설은 **기각**된다.
- **매트릭스 2건 이상 = 0**: run별 `Recheck PR*` 잡 수 분포(위 네 번째 명령)가 77개 run
  전부 정확히 1건이다 — 전역 합계(`Recheck PR`+`Recheck PR (N)`=77)가 run 수와 같다는
  것만으로는 「한 run이 2건, 다른 run이 0건」인 상쇄를 배제할 수 없어 run 단위로 직접
  센 결과다. 어떤 run도 2건 이상으로 펼쳐지지 않았다. `recheck-select.sh`가
  `pull_request` 이벤트에서 트리거 PR 1건으로 후보를 고정한다는 (b)의 서술과 일치한다.
- **잔여분 = 77**: run별 `report-discovery-failure` 잡 수 분포(위 다섯 번째 명령)도
  77개 run 전부 정확히 1건이다(전역 합계로는 76 skipped + 1 cancelled = 77이었던 것과
  같은 이유로, run 단위 분포를 별도로 확인했다). `report-discovery-failure`
  (`recheck-open-prs.yml:326-354`)가 **run마다 예외 없이 1개씩** 등장한다. (b)의
  모델은 discover·recheck·report 세 잡만 셌지만, 워크플로에는 네 번째 top-level 잡
  `report-discovery-failure`(`if: !cancelled() && needs.discover.result == 'failure'`,
  329행)가 항상 존재한다. discover가 성공하는 정상 경로(①)에서는 이 잡의 `if`가
  거짓이라 `conclusion=skipped`로 끝나지만, `timing` API의 `billable.<os>.jobs`는
  이 skipped 잡도 그대로 1잡으로 센다 — 예를 들어 run 31848253299의 `timing` 응답은
  `billable.UBUNTU.jobs: 4`이고, `job_runs` 네 번째 항목(skip된
  report-discovery-failure)의 `duration_ms`는 0이다(청구 **분**은 0이지만 청구
  **잡 수**에는 그대로 잡힌다). 즉 **①의 상한은 3잡이 아니라 4잡**이었다.

### 결론

**초과 77잡은 재시도가 아니라 (b)의 모델이 빠뜨린 네 번째 잡
(`report-discovery-failure`, discover 성공 시 매번 skipped로 끝나지만
`billable.jobs`에는 그대로 집계됨) 때문이다 — 회당 4.0잡이 맞고, ①의 모델은
discover(1) + recheck(1) + report(1) + report-discovery-failure(1) = **4잡**으로
고쳐야 한다.**

(b)의 결론 문단은 이 절의 결과에 맞춰 정정했다(모델 상한 3잡 → 4잡) — 틀린 결론을 그대로
두고 링크만 거는 것보다 문서의 정확성을 높이는 방향이라 판단했다. 워크플로 YAML과
`recheck-select.sh`는 이슈 비범위대로 이 조각에서 손대지 않았다.

재시도가 원인이 아니므로 `.github/scripts/billed-usage-report.sh`의 헤더 주석·출력
각주는 이 조각에서 손대지 않는다(완료 조건: "원인이 아니면 이 항목은 하지 않는다").
