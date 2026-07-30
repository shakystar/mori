#!/usr/bin/env bash
# recheck-report.sh 테스트 — 판정 부재가 그린으로 보고되지 않고(#112 항목 1), 게이트 코멘트가
# 봇 작성자로 고정되며 PATCH 실패가 보고를 사라지게 하지 않는지(#112 항목 2), 그리고 낡은
# head의 판정이 최신 판정을 덮지 않는지(#112 리뷰 1번) 확인한다.
set -uo pipefail

SUITE_NAME="recheck-report"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

BASE="1111111111111111111111111111111111111111"
# HEAD_A는 "판정이 본 head"이자 기본 시나리오의 현재 head다. HEAD_B는 그 뒤에 developer가
# push한 새 head — 이 둘이 갈리는 것이 낡은 판정 시나리오다.
HEAD_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEAD_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MERGE="cccccccccccccccccccccccccccccccccccccccc"
DEFAULT_HEAD="$HEAD_A"
BOT="github-actions[bot]"
MARKER="<!-- recheck-open-prs -->"

reset_scenario() {
  unset GH_ROUTES GH_FAIL
  ROUTE_SEQ=0
  rm -rf "${SANDBOX}/results"
  mkdir -p "${SANDBOX}/results"
  : >"$GH_LOG"
  : >"$GH_BODY_LOG"
  : >"$GITHUB_STEP_SUMMARY"
}

# make_result <pr> <verdict> <detail> <failed> <merge_sha> <head_sha>
make_result() {
  local d="${SANDBOX}/results/recheck-result-$1"
  mkdir -p "$d"
  jq -n --argjson pr "$1" --arg v "$2" --arg dt "$3" --arg f "$4" --arg m "$5" --arg h "$6" \
    '{pr: $pr, verdict: $v, detail: $dt, failed: $f, merge_sha: $m, head_sha: $h}' \
    >"${d}/result.json"
}

comment() {
  printf '{"id":%s,"user":{"login":"%s"},"body":"%s"}' "$1" "$2" "$3"
}

# head_route <pr> <sha> — 그 PR의 현재 head 조회 응답
head_route() {
  route "pulls/$1" "{\"head\":{\"sha\":\"$2\"}}"
}

# 판정의 head가 곧 현재 head인 것이 기본값이다. 낡은 head 시나리오는 각 케이스가
# `route "pulls/<pr>" ...`로 따로 등록한다 — 라우트는 등록 순서대로 매칭되므로 기본값은
# 모든 route() 호출이 끝난 뒤(= 여기)에 붙어야 개별 라우트가 이긴다.
default_head_route() {
  case "${GH_ROUTES:-}" in
    *"pulls/"*) ;;
    *) route "pulls/" "{\"head\":{\"sha\":\"${DEFAULT_HEAD}\"}}" ;;
  esac
}

run_report() {
  default_head_route
  env REPO=o/r PRS="${PRS:-[7]}" UNVERIFIED="${UNVERIFIED:-[]}" \
    RESULTS_DIR="${SANDBOX}/results" BASE_SHA="$BASE" \
    RUN_URL="https://example.test/run/1" BOT_LOGIN="$BOT" TMPDIR="$SANDBOX" \
    GH_LOG="$GH_LOG" GH_BODY_LOG="$GH_BODY_LOG" \
    GH_ROUTES="${GH_ROUTES:-}" GH_FAIL="${GH_FAIL:-}" \
    GITHUB_STEP_SUMMARY="$GITHUB_STEP_SUMMARY" \
    bash "${DIR}/recheck-report.sh" >/dev/null 2>&1
  REPORT_RC=$?
}

setup_sandbox

it "그린이고 기존 봇 코멘트도 없으면 코멘트를 만들지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
route "issues/7/comments" '[]'
run_report
assert_not_contains "$(cat "$GH_LOG")" "method POST"

it "그린이고 기존 봇 코멘트가 있으면 그 코멘트를 갱신한다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드")]"
run_report
assert_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "판정 파일이 없으면 그린이 아니라 판정 불가로 보고한다"
reset_scenario
# recheck 잡이 죽어 아티팩트가 없는 경로. 예전 코드에는 이 경로 자체가 없었고, 빈 STATUS는
# 곧바로 "🟢 그린입니다"가 됐다.
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

it "판정 불가 본문에는 그린 문구가 들어가지 않는다"
reset_scenario
route "issues/7/comments" '[]'
run_report
assert_not_contains "$(cat "$GH_BODY_LOG")" "🟢"

it "판정 불가는 기존 코멘트가 없어도 새 코멘트로 남긴다"
reset_scenario
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_LOG")" "method POST repos/o/r/issues/7/comments"

it "판정 불가로 기존 레드 코멘트를 갱신해도 그린으로 덮이지 않는다"
reset_scenario
make_result 7 error "체크 단계가 판정을 남기지 않았습니다" "" "" "$HEAD_A"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_not_contains "$(cat "$GH_BODY_LOG")" "그린입니다"

it "본문에 마커를 인용한 사람 코멘트가 더 최신이어도 게이트는 봇 코멘트에 남는다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
# 이 리포에는 에이전트가 CI 코멘트 본문을 인용하는 관례가 있다. 예전 코드는 `last`를 골라
# 나중에 달린 인용 코멘트가 항상 이겼다.
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 이전 판정"),$(comment 200 "developer" "판정 근거 인용: ${MARKER}")]"
run_report
assert_contains "$(cat "$GH_LOG")" "issues/comments/100"

it "봇 코멘트 없이 인용 코멘트만 있으면 그 코멘트를 갱신하지 않고 새로 만든다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
route "issues/7/comments" "[$(comment 200 "developer" "판정 근거 인용: ${MARKER}")]"
run_report
assert_eq "no-patch|posted" \
  "$(grep -q 'issues/comments/200' "$GH_LOG" && echo patched || echo no-patch)|$(grep -q 'method POST' "$GH_LOG" && echo posted || echo no-post)"

it "코멘트 갱신(PATCH)이 실패하면 새 코멘트로 폴백해 보고를 남긴다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 이전 판정")]"
fail_calls_matching "issues/comments/100"
run_report
assert_eq "0|posted" "${REPORT_RC}|$(grep -q 'method POST' "$GH_LOG" && echo posted || echo no-post)"

it "갱신도 신설도 실패하면 잡을 실패시켜 코멘트 없음이 통과로 읽히지 않게 한다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 이전 판정")]"
fail_calls_matching "issues/comments/100"
fail_calls_matching "method POST"
run_report
assert_eq "1" "${REPORT_RC}"

it "코멘트 목록 조회가 실패하면 그린이라도 새 코멘트로 보고를 남긴다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
fail_calls_matching "issues/7/comments?per_page"
run_report
assert_contains "$(cat "$GH_LOG")" "method POST repos/o/r/issues/7/comments"

it "충돌 판정은 충돌 해소 안내로 보고된다"
reset_scenario
make_result 7 conflict "" "" "" "$HEAD_A"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main과 충돌합니다"

it "레드 판정 본문에는 실패한 명령과 체크 출력 꼬리가 들어간다"
reset_scenario
make_result 7 red "" "pnpm typecheck:test" "$MERGE" "$HEAD_A"
printf 'error TS2345: nope\n' >"${SANDBOX}/results/recheck-result-7/checks.log"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "error TS2345: nope"

it "분류에 실패한 PR은 대상 선정 단계가 원인임을 본문에 밝힌다"
reset_scenario
PRS='[7]' UNVERIFIED='[7]'
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "대상 선정 단계가 이 PR을 분류하지 못했습니다"
unset UNVERIFIED

it "본문에 이 판정이 어느 PR head 기준인지 기록된다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_B"
head_route 7 "$HEAD_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "검증한 PR head: \`${HEAD_B}\`"

# --- 낡은 판정이 최신 판정을 덮지 않는다 (#112 리뷰 1번) ---------------------------------
# main push 스윕(github.ref=refs/heads/main)과 같은 PR의 synchronize 실행(refs/pull/N/merge)은
# concurrency 그룹이 달라 서로 취소하지 못한다. 스윕이 더 느리므로 낡은 head로 얻은 판정이
# 나중에 도착해 최신 판정을 덮을 수 있다.

it "낡은 head의 그린 판정은 기존 레드 코멘트를 그린으로 덮지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_B"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_eq "no-patch|no-post|0" \
  "$(grep -q 'method PATCH' "$GH_LOG" && echo patched || echo no-patch)|$(grep -q 'method POST' "$GH_LOG" && echo posted || echo no-post)|${REPORT_RC}"

it "낡은 head의 레드 판정도 기존 코멘트를 덮지 않는다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_B"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🟢 그린입니다")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH"

it "낡은 head의 판정은 기존 봇 코멘트가 없으면 침묵하지 않고 판정 불가로 남긴다"
reset_scenario
# 코멘트가 아예 없으면 CONTRIBUTING.md 기준으로 "통과"다. 낡았다고 침묵하면 게이트가 사라진다.
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

it "낡은 판정 본문은 어느 head가 어긋났는지 밝힌다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 head는 \`${HEAD_B}\`"

it "현재 head를 조회하지 못하면 그린으로 보고하지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
fail_calls_matching "pulls/7"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_not_contains "$(cat "$GH_BODY_LOG")" "🟢"

it "판정에 head가 없으면 그린으로 보고하지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" ""
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

it "현재 head를 조회하지 못해도 레드 판정은 그대로 보고한다"
reset_scenario
# 그린으로 덮는 경로만 막는다. 레드·충돌을 판정 불가로 강등하면 근거만 잃는다.
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
fail_calls_matching "pulls/7"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main 기준으로 레드입니다"

it "여러 PR을 보고할 때 각 PR에 코멘트를 남긴다"
reset_scenario
PRS='[7,8]'
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
make_result 8 conflict "" "" "" "$HEAD_A"
route "issues/7/comments" '[]'
route "issues/8/comments" '[]'
run_report
assert_eq "2" "$(grep -c 'method POST' "$GH_LOG")"
PRS='[7]'

teardown_sandbox
finish
