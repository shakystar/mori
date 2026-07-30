#!/usr/bin/env bash
# recheck-select.sh 테스트 — 분류 실패가 `run`으로 위장되지 않는지 확인한다 (#112 항목 4).
set -uo pipefail

SUITE_NAME="recheck-select"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

BASE="1111111111111111111111111111111111111111"

reset_scenario() {
  unset GH_ROUTES GH_FAIL
  ROUTE_SEQ=0
  : >"$GITHUB_OUTPUT"
  : >"$GITHUB_STEP_SUMMARY"
  : >"$GH_LOG"
}

run_select() {
  env REPO=o/r EVENT_NAME="${EVENT_NAME:-push}" PUSH_SHA="${PUSH_SHA:-$BASE}" \
    PR_NUMBER="${PR_NUMBER:-}" RETRY_ATTEMPTS=2 RETRY_SLEEP=0 \
    GITHUB_OUTPUT="$GITHUB_OUTPUT" GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY" \
    GH_LOG="$GH_LOG" GH_ROUTES="${GH_ROUTES:-}" GH_FAIL="${GH_FAIL:-}" \
    bash "${DIR}/recheck-select.sh" >/dev/null 2>&1
}

pr_json() {
  printf '{"draft":%s,"mergeable":%s,"mergeable_state":%s}' "$1" "$2" "$3"
}

setup_sandbox

it "머지 가능한 PR은 재검증 대상으로 선정된다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "pulls/7" "$(pr_json false true '"clean"')"
run_select
assert_eq "[7]|1" "$(output_of prs)|$(output_of count)"

it "드래프트 PR은 건너뛴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "pulls/7" "$(pr_json true null '"unknown"')"
run_select
assert_eq "[]|0" "$(output_of prs)|$(output_of count)"

it "충돌(dirty) PR은 건너뛴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "pulls/7" "$(pr_json false false '"dirty"')"
run_select
assert_eq "[]" "$(output_of prs)"

it "gh api 조회가 실패한 PR은 재검증 대상이 되지 않는다"
reset_scenario
# 예전 코드는 여기서 빈 문자열이 흘러가 `run`을 출력했다 — 분류 실패가 재검증 대상으로 위장됐다.
route "pulls?state=open" '[{"number":7}]'
fail_calls_matching "pulls/7"
run_select
assert_eq "[]" "$(output_of prs)"

it "gh api 조회가 실패한 PR은 판정 불가 보고 대상(unverified)으로 넘어간다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
fail_calls_matching "pulls/7"
run_select
assert_eq "[7]|[7]" "$(output_of unverified)|$(output_of report)"

it "분류 실패가 잡 요약에 error 사유로 기록된다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
fail_calls_matching "pulls/7"
run_select
assert_contains "$(cat "$GITHUB_STEP_SUMMARY")" "error:classify-api-failed"

it "한 PR의 분류가 실패해도 나머지 PR 선정은 계속된다"
reset_scenario
route "pulls?state=open" '[{"number":7},{"number":8}]'
route "pulls/7" "$(pr_json false true '"clean"')"
fail_calls_matching "pulls/8"
run_select
assert_eq "[7]|[8]" "$(output_of prs)|$(output_of unverified)"

it "mergeable 계산이 끝나지 않은 PR은 판정 불가가 아니라 건너뛴 것으로 남는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "pulls/7" "$(pr_json false null '"unknown"')"
run_select
assert_eq "[]|[]" "$(output_of prs)|$(output_of unverified)"

it "응답에 draft 필드가 없으면 상태를 단정하지 않고 판정 불가로 넘긴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "pulls/7" '{"mergeable":true,"mergeable_state":"clean"}'
run_select
assert_eq "[]|[7]" "$(output_of prs)|$(output_of unverified)"

it "열린 PR이 0건이면 보고 대상도 0건이다"
reset_scenario
route "pulls?state=open" '[]'
run_select
assert_eq "0|0" "$(output_of count)|$(output_of report_count)"

it "pull_request 이벤트는 그 PR 하나만 대상으로 삼는다"
reset_scenario
EVENT_NAME=pull_request PR_NUMBER=42
route "commits/main" "{\"sha\":\"${BASE}\"}"
route "pulls/42" "$(pr_json false true '"clean"')"
run_select
assert_eq "[42]" "$(output_of prs)"
unset EVENT_NAME PR_NUMBER

it "pull_request 이벤트의 base는 PR 머지 커밋이 아니라 현재 main이다"
reset_scenario
EVENT_NAME=pull_request PR_NUMBER=42 PUSH_SHA="2222222222222222222222222222222222222222"
route "commits/main" "{\"sha\":\"${BASE}\"}"
route "pulls/42" "$(pr_json false true '"clean"')"
run_select
assert_eq "$BASE" "$(output_of base_sha)"
unset EVENT_NAME PR_NUMBER PUSH_SHA

teardown_sandbox
finish
