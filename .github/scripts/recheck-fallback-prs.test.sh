#!/usr/bin/env bash
# recheck-fallback-prs.sh 테스트 — discover가 죽었을 때 보고 대상이 조용히 비지 않는지
# 확인한다 (#125 항목 3). 빈 목록으로 성공하면 그것이 곧 "코멘트 없음 = 통과"다.
set -uo pipefail

SUITE_NAME="recheck-fallback-prs"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

run_fallback() {
  env REPO=o/r EVENT_NAME="${EVENT_NAME:-push}" \
    PR_NUMBER="${PR_NUMBER:-}" PR_DRAFT="${PR_DRAFT:-false}" \
    GH_LOG="$GH_LOG" GH_ROUTES="${GH_ROUTES:-}" GH_FAIL="${GH_FAIL:-}" \
    GITHUB_OUTPUT="$GITHUB_OUTPUT" GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY" \
    bash "${DIR}/recheck-fallback-prs.sh" >/dev/null 2>&1
  FALLBACK_RC=$?
}

reset_scenario() {
  unset GH_ROUTES GH_FAIL EVENT_NAME PR_NUMBER PR_DRAFT
  ROUTE_SEQ=0
  : >"$GH_LOG"
  : >"$GITHUB_OUTPUT"
  : >"$GITHUB_STEP_SUMMARY"
}

setup_sandbox

it "push 이벤트에서는 열린 PR 전체를 보고 대상으로 낸다"
reset_scenario
route "pulls?state=open" '[{"number":7,"draft":false},{"number":8,"draft":false}]'
run_fallback
assert_eq "[7,8]|2" "$(output_of prs)|$(output_of count)"

it "드래프트 PR은 보고 대상에서 빠진다"
reset_scenario
# discover도 드래프트는 건너뛴다. 여기서만 알리면 없던 게이트가 생긴다.
route "pulls?state=open" '[{"number":7,"draft":true},{"number":8,"draft":false}]'
run_fallback
assert_eq "[8]|1" "$(output_of prs)|$(output_of count)"

it "열린 PR이 0건이면 빈 목록으로 성공한다"
reset_scenario
route "pulls?state=open" '[]'
run_fallback
assert_eq "[]|0|0" "$(output_of prs)|$(output_of count)|${FALLBACK_RC}"

it "PR 목록 조회가 실패하면 빈 목록으로 성공하지 않고 죽는다"
reset_scenario
# 조용히 0건으로 성공하면 그것이 다시 "코멘트 없음 = 통과"다.
fail_calls_matching "pulls?state=open"
run_fallback
assert_eq "1|" "${FALLBACK_RC}|$(output_of prs)"

it "pull_request 이벤트에서는 그 PR 하나만 보고 대상으로 낸다"
reset_scenario
EVENT_NAME=pull_request PR_NUMBER=42
run_fallback
assert_eq "[42]|1" "$(output_of prs)|$(output_of count)"

it "pull_request 이벤트에서는 PR 목록을 조회하지 않는다"
reset_scenario
EVENT_NAME=pull_request PR_NUMBER=42
run_fallback
assert_not_contains "$(cat "$GH_LOG")" "pulls?state=open"

it "드래프트 PR의 pull_request 이벤트는 보고 대상이 비어 있다"
reset_scenario
EVENT_NAME=pull_request PR_NUMBER=42 PR_DRAFT=true
run_fallback
assert_eq "[]|0|0" "$(output_of prs)|$(output_of count)|${FALLBACK_RC}"

it "pull_request 이벤트에 PR 번호가 없으면 죽는다"
reset_scenario
EVENT_NAME=pull_request
run_fallback
assert_eq "1" "${FALLBACK_RC}"

teardown_sandbox
finish
