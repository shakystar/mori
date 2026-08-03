#!/usr/bin/env bash
# refresh-armed-prs.sh 테스트 — 선별 판정 함수의 입출력을 검증한다 (#195).
#
# 검증 대상은 **어떤 PR이 갱신 대상이 되는가**다. 픽스처는 GitHub API 응답 형태의 JSON이고,
# 단언은 스크립트가 내놓은 목록($GITHUB_OUTPUT)에 대해서만 한다 — "API가 호출됐는지"를
# 단언하지 않는다 (TESTING.md의 구현 세부 결합).
set -uo pipefail

SUITE_NAME="refresh-armed-prs"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

BASE="1111111111111111111111111111111111111111"
BRANCH_HEAD="2222222222222222222222222222222222222222"
HEAD7="7777777777777777777777777777777777777777"
HEAD8="8888888888888888888888888888888888888888"
# BASE_SHA가 main에 포함돼 있을 때의 compare 응답 (main이 BASE_SHA보다 3커밋 앞섬).
BASE_IN_MAIN='{"status":"ahead","ahead_by":3,"behind_by":0}'

reset_scenario() {
  unset GH_ROUTES GH_FAIL
  ROUTE_SEQ=0
  REFRESH_STATUS=0
  : >"$GITHUB_OUTPUT"
  : >"$GITHUB_STEP_SUMMARY"
  : >"$GH_LOG"
  # BASE_SHA가 main에 포함된 커밋인지 확인하는 compare다. 각 케이스가 등록하는 넓은
  # `compare/` 라우트보다 먼저 잡히도록 여기서 등록한다 (먼저 등록한 라우트가 이긴다).
  # 인자를 주면 그 응답으로 바꾼다 — 포함 확인 자체를 검증하는 케이스가 쓴다.
  route "compare/${BASE}...main" "${1:-$BASE_IN_MAIN}"
}

run_refresh() {
  env REPO=o/r BASE_SHA="${BASE_SHA:-$BASE}" RETRY_ATTEMPTS=2 RETRY_SLEEP=0 \
    GITHUB_OUTPUT="$GITHUB_OUTPUT" GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY" \
    GH_LOG="$GH_LOG" GH_ROUTES="${GH_ROUTES:-}" GH_FAIL="${GH_FAIL:-}" \
    bash "${DIR}/refresh-armed-prs.sh" >/dev/null 2>&1
  REFRESH_STATUS=$?
}

# GitHub의 GET /repos/{repo}/pulls/{n} 응답 형태. armed는 auto_merge 객체의 유무로 표현된다.
pr_json() {
  local armed="$1" draft="$2" state="$3" head="$4"
  local auto='null'
  [ "$armed" = "true" ] && auto='{"enabled_by":{"login":"shakystar"},"merge_method":"squash"}'
  printf '{"number":7,"draft":%s,"auto_merge":%s,"mergeable_state":"%s","head":{"sha":"%s"}}' \
    "$draft" "$auto" "$state" "$head"
}

# GitHub의 GET /repos/{repo}/compare/{base}...{head} 응답 형태.
compare_json() {
  printf '{"status":"%s","ahead_by":1,"behind_by":%s}' "$2" "$1"
}

# 라우트는 등록 순서대로 부분문자열 매칭돼 첫 일치가 이긴다. `pulls/7`은 `pulls/7/update-branch`도
# 잡으므로 더 좁은 패턴을 먼저 등록한다.
route_pr() {
  local n="$1" body="$2"
  route "pulls/${n}/update-branch" '{}'
  route "pulls/${n}" "$body"
}

setup_sandbox

it "armed·충돌 없음·main보다 뒤처진 PR은 갱신 대상이 된다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
run_refresh
assert_eq "[7]|1|0" "$(output_of refreshed)|$(output_of refreshed_count)|${REFRESH_STATUS}"

it "auto-merge가 걸려 있지 않은 PR은 갱신하지 않는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json false false blocked "$HEAD7")"
run_refresh
assert_eq "[]|[7]" "$(output_of refreshed)|$(output_of skipped)"

it "충돌(dirty) PR은 갱신하지 않는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false dirty "$HEAD7")"
run_refresh
assert_eq "[]|[7]" "$(output_of refreshed)|$(output_of skipped)"

it "이미 현재 main을 포함한 PR은 갱신하지 않는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 0 ahead)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
run_refresh
assert_eq "[]|[7]" "$(output_of refreshed)|$(output_of skipped)"

it "required check가 레드라 mergeable_state가 blocked인 PR도 뒤처졌으면 갱신 대상이다"
# mergeStateStatus는 단일 값이고 BLOCKED가 BEHIND를 가린다. `mergeable_state == "behind"`로
# 걸렀다면 이 이슈가 풀려는 7건이 한 건도 선정되지 않는다 (#195 실측: PR #187은
# behind_by=1인데 mergeable_state는 blocked였다).
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
run_refresh
assert_eq "[7]" "$(output_of refreshed)"

it "auto_merge 키가 없는 응답은 미승인으로 단정하지 않고 분류 실패로 남긴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "{\"number\":7,\"draft\":false,\"mergeable_state\":\"blocked\",\"head\":{\"sha\":\"${HEAD7}\"}}"
run_refresh
assert_eq "[]|[]|[7]" "$(output_of refreshed)|$(output_of skipped)|$(output_of unresolved)"

it "mergeable_state가 unknown이면 충돌 아님으로 단정하지 않고 건너뛴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false unknown "$HEAD7")"
run_refresh
assert_eq "[]|[7]|[]" "$(output_of refreshed)|$(output_of skipped)|$(output_of unresolved)"

it "compare 조회가 실패하면 뒤처짐 여부를 단정하지 않고 분류 실패로 남긴다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
# 기준 base 확인용 compare가 아니라 **그 PR의** compare만 실패시킨다.
fail_calls_matching "compare/${BASE}...${HEAD7}"
run_refresh
assert_eq "[]|[7]" "$(output_of refreshed)|$(output_of unresolved)"

it "PR 조회가 실패한 PR은 갱신 대상이 되지 않는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
fail_calls_matching "pulls/7"
run_refresh
assert_eq "[]|[7]" "$(output_of refreshed)|$(output_of unresolved)"

it "update-branch가 실패한 PR은 갱신 목록이 아니라 실패 목록에 남는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
fail_calls_matching "update-branch"
run_refresh
assert_eq "[]|[7]|1" "$(output_of refreshed)|$(output_of failed)|$(output_of failed_count)"

it "갱신 실패는 잡을 레드로 만든다 — 조용히 멈춘 PR이 어디에도 안 보이는 것을 막는다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
fail_calls_matching "update-branch"
run_refresh
assert_eq "1" "${REFRESH_STATUS}"

it "한 PR의 분류가 실패해도 나머지 PR 갱신은 계속된다"
reset_scenario
route "pulls?state=open" '[{"number":7},{"number":8}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
route_pr 8 "$(pr_json true false blocked "$HEAD8")"
fail_calls_matching "pulls/8"
run_refresh
assert_eq "[7]|[8]" "$(output_of refreshed)|$(output_of unresolved)"

it "열린 PR이 0건이면 갱신 대상도 0건이다"
reset_scenario
route "pulls?state=open" '[]'
run_refresh
assert_eq "[]|0|0" "$(output_of refreshed)|$(output_of refreshed_count)|${REFRESH_STATUS}"

it "BASE_SHA가 커밋 SHA 모양이 아니면 아무 PR도 갱신하지 않고 실패한다"
# 기준 base가 비면 "뒤처졌는가"를 재는 자가 사라진다. 조용히 전건 통과/전건 갱신으로
# 뒤집히지 않고 여기서 죽어야 한다.
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
BASE_SHA="main" run_refresh
assert_eq "|1" "$(output_of refreshed)|${REFRESH_STATUS}"

it "모양은 SHA여도 main에 포함되지 않은 BASE_SHA면 아무 PR도 갱신하지 않고 실패한다"
# 모양 검사는 40자 hex이기만 하면 통과하므로 **다른 브랜치의 head SHA**를 걸러내지 못한다.
# 그 값을 기준 base로 쓰면 뒤처짐을 엉뚱한 자로 재게 되어 갱신/스킵이 뒤집힌다 (#195 리뷰 ①).
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
BASE_SHA="$BRANCH_HEAD" run_refresh
assert_eq "|1" "$(output_of refreshed)|${REFRESH_STATUS}"

it "BASE_SHA의 main 포함 여부를 확인하지 못하면 확인된 것으로 치지 않고 실패한다"
reset_scenario
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
fail_calls_matching "compare/${BASE}...main"
run_refresh
assert_eq "|1" "$(output_of refreshed)|${REFRESH_STATUS}"

it "포함 여부를 읽을 수 없는 compare 응답은 포함된 것으로 치지 않는다"
reset_scenario '{"status":"ahead","ahead_by":3}'
route "pulls?state=open" '[{"number":7}]'
route "compare/" "$(compare_json 1 diverged)"
route_pr 7 "$(pr_json true false blocked "$HEAD7")"
run_refresh
assert_eq "|1" "$(output_of refreshed)|${REFRESH_STATUS}"

teardown_sandbox
finish
