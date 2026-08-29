#!/usr/bin/env bash
# billed-usage-report.sh 테스트 — 검증 대상은 집계 산술 하나다: 고정된 가짜 run/timing
# 응답을 넣었을 때 워크플로별 청구 잡 수 합과 월 환산 값이 기대대로 나오는가 (#480).
# API 호출 횟수를 세는 테스트나 출력 스냅샷은 만들지 않는다.
set -uo pipefail

SUITE_NAME="billed-usage-report"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

reset_scenario() {
  unset GH_ROUTES GH_FAIL
  ROUTE_SEQ=0
  : >"$GH_LOG"
}

run_report() {
  env REPO="o/r" GH_LOG="$GH_LOG" GH_ROUTES="${GH_ROUTES:-}" GH_FAIL="${GH_FAIL:-}" \
    bash "${DIR}/billed-usage-report.sh" "$@"
}

setup_sandbox

it "청구 잡 수를 워크플로 이름별로 합산하고 월 환산 값을 낸다"
reset_scenario
route "actions/runs?created=" \
  '{"total_count":3,"workflow_runs":[{"id":101,"name":"CI"},{"id":102,"name":"CI"},{"id":103,"name":"Notify"}]}'
route "runs/101/timing" '{"billable":{"UBUNTU":{"total_ms":180000,"jobs":3}},"run_duration_ms":90000}'
route "runs/102/timing" '{"billable":{"UBUNTU":{"total_ms":300000,"jobs":5}},"run_duration_ms":150000}'
route "runs/103/timing" '{"billable":{"UBUNTU":{"total_ms":120000,"jobs":2}},"run_duration_ms":60000}'
out=$(run_report --since 2026-01-01 --until 2026-01-10)
code=$?
assert_eq "0" "$code"
assert_contains "$out" "| CI | 2 | 8 | 4.0 |"
assert_contains "$out" "| Notify | 1 | 2 | 1.0 |"
assert_contains "$out" "청구 잡 수 합계: 10"
assert_contains "$out" "월 환산 청구 잡 수 추정치 = 10 / 10일 × 30일 = 30.0"

it "total_ms=0인 run도 jobs·벽시계를 정상 run과 똑같이 합산한다"
reset_scenario
route "actions/runs?created=" \
  '{"total_count":3,"workflow_runs":[{"id":501,"name":"CI"},{"id":502,"name":"CI"},{"id":503,"name":"Paused Only"}]}'
route "runs/501/timing" '{"billable":{"UBUNTU":{"total_ms":180000,"jobs":3}},"run_duration_ms":90000}'
route "runs/502/timing" '{"billable":{"UBUNTU":{"total_ms":0,"jobs":1}},"run_duration_ms":30000}'
route "runs/503/timing" '{"billable":{"UBUNTU":{"total_ms":0,"jobs":2}},"run_duration_ms":60000}'
out=$(run_report --since 2026-01-01 --until 2026-01-10)
code=$?
assert_eq "0" "$code"
assert_contains "$out" "| CI | 2 | 4 | 2.0 |"
assert_contains "$out" "| Paused Only | 1 | 2 | 1.0 |"
assert_contains "$out" "청구 잡 수 합계: 6"
assert_contains "$out" "월 환산 청구 잡 수 추정치 = 6 / 10일 × 30일 = 18.0"

it "회귀: total_ms가 전부 0인 응답 묶음에서도 청구 잡 수 합계가 0이 아니다"
reset_scenario
route "actions/runs?created=" \
  '{"total_count":2,"workflow_runs":[{"id":601,"name":"CI"},{"id":602,"name":"CI"}]}'
route "runs/601/timing" '{"billable":{"UBUNTU":{"total_ms":0,"jobs":2}},"run_duration_ms":10000}'
route "runs/602/timing" '{"billable":{"UBUNTU":{"total_ms":0,"jobs":3}},"run_duration_ms":20000}'
out=$(run_report --since 2026-01-01 --until 2026-01-10)
code=$?
assert_eq "0" "$code"
assert_contains "$out" "청구 잡 수 합계: 5"
assert_contains "$out" "월 환산 청구 잡 수 추정치 = 5 / 10일 × 30일 = 15.0"

it "timing 조회가 도중 실패하면 그때까지 모은 부분 결과를 내고 종료코드 2로 끝난다"
reset_scenario
route "actions/runs?created=" \
  '{"total_count":2,"workflow_runs":[{"id":401,"name":"CI"},{"id":402,"name":"CI"}]}'
route "runs/401/timing" '{"billable":{"UBUNTU":{"total_ms":60000,"jobs":1}},"run_duration_ms":30000}'
fail_calls_matching "runs/402/timing"
out=$(run_report --since 2026-01-01 --until 2026-01-10 2>&1)
code=$?
assert_eq "2" "$code"
assert_contains "$out" "| CI | 1 | 1 | 0.5 |"
assert_contains "$out" "부분 결과: 전체 2건 중 1건까지 집계를 완료했습니다"

it "같은 워크플로 이름의 run이 서로 다른 event로 섞이면 이벤트별 청구 잡 수 합이 갈라진다"
reset_scenario
route "actions/runs?created=" \
  '{"total_count":3,"workflow_runs":[{"id":701,"name":"CI","event":"push"},{"id":702,"name":"CI","event":"pull_request"},{"id":703,"name":"CI","event":"push"}]}'
route "runs/701/timing" '{"billable":{"UBUNTU":{"total_ms":180000,"jobs":3}},"run_duration_ms":90000}'
route "runs/702/timing" '{"billable":{"UBUNTU":{"total_ms":60000,"jobs":1}},"run_duration_ms":30000}'
route "runs/703/timing" '{"billable":{"UBUNTU":{"total_ms":120000,"jobs":2}},"run_duration_ms":60000}'
out=$(run_report --since 2026-01-01 --until 2026-01-10)
code=$?
assert_eq "0" "$code"
assert_contains "$out" "| CI | push | 2 | 5 | 2.5 |"
assert_contains "$out" "| CI | pull_request | 1 | 1 | 0.5 |"

it "run 목록 조회 자체가 실패하면 부분 결과 없이 종료코드 1로 끝난다"
reset_scenario
fail_calls_matching "actions/runs?created="
out=$(run_report --since 2026-01-01 --until 2026-01-10 2>&1)
code=$?
assert_eq "1" "$code"
assert_not_contains "$out" "청구 잡 수 합계"

teardown_sandbox
finish
