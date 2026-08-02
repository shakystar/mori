#!/usr/bin/env bash
# recheck-report.sh 테스트 — 판정 부재가 그린으로 보고되지 않고(#112 항목 1), 게이트 코멘트가
# 봇 작성자로 고정되며 PATCH 실패가 보고를 사라지게 하지 않는지(#112 항목 2), 낡은
# head의 판정이 최신 판정을 덮지 않는지(#112 리뷰 1번), 그리고 낡은 **base**의 그린이 최신
# base의 레드를 덮지 않는지(#125 항목 1 = PR #119 Codex 1번) 확인한다.
set -uo pipefail

SUITE_NAME="recheck-report"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

BASE="1111111111111111111111111111111111111111"
# 검증에 쓴 base(BASE)가 곧 현재 main인 것이 정상이다. MAIN_B는 그 뒤 main에 push가 들어와
# base가 낡은 상태 — T1~T4 전개의 base B다.
MAIN_B="2222222222222222222222222222222222222222"
# HEAD_A는 "판정이 본 head"이자 기본 시나리오의 현재 head다. HEAD_B는 그 뒤에 developer가
# push한 새 head — 이 둘이 갈리는 것이 낡은 판정 시나리오다.
HEAD_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HEAD_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MERGE="cccccccccccccccccccccccccccccccccccccccc"
DEFAULT_HEAD="$HEAD_A"
BOT="github-actions[bot]"
MARKER="<!-- recheck-open-prs -->"

reset_scenario() {
  unset GH_ROUTES GH_FAIL RESULT_SUFFIX NO_RESULT_DETAIL BASE_SHA_OVERRIDE AUTHORITATIVE
  ROUTE_SEQ=0
  rm -rf "${SANDBOX}/results"
  mkdir -p "${SANDBOX}/results"
  : >"$GH_LOG"
  : >"$GH_BODY_LOG"
  : >"$GITHUB_STEP_SUMMARY"
}

# make_result <pr> <verdict> <detail> <failed> <merge_sha> <head_sha> [artifact_suffix]
make_result() {
  local d="${SANDBOX}/results/recheck-result-$1${7:-}"
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

# main_route <sha> — 현재 main 커밋 조회 응답
main_route() {
  route "commits/main" "{\"sha\":\"$1\"}"
}

# 검증에 쓴 base가 곧 현재 main인 것이 기본값이다(정상 운영). 낡은 base 시나리오는 각 케이스가
# main_route로 따로 등록한다 — default_head_route와 같은 이유로 마지막에 붙는다.
default_main_route() {
  case "${GH_ROUTES:-}" in
    *"commits/main"*) ;;
    *) main_route "$BASE" ;;
  esac
}

run_report() {
  default_head_route
  default_main_route
  env REPO=o/r PRS="${PRS:-[7]}" UNVERIFIED="${UNVERIFIED:-[]}" \
    RESULTS_DIR="${SANDBOX}/results" BASE_SHA="${BASE_SHA_OVERRIDE-$BASE}" \
    AUTHORITATIVE="${AUTHORITATIVE:-1}" \
    RESULT_SUFFIX="${RESULT_SUFFIX:-}" NO_RESULT_DETAIL="${NO_RESULT_DETAIL:-}" \
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

# --- 낡은 base의 그린이 최신 base의 레드를 덮지 않는다 (#125 항목 1) --------------------
# T1 PR의 synchronize 실행이 base A로 검증 시작 → 그린
# T2 main에 push → 스윕이 base B로 같은 PR을 검증 → 레드
# T3 스윕이 먼저 끝나 코멘트를 🔴로 PATCH        (base B — 최신)
# T4 더 느린 synchronize 실행이 🟢로 PATCH       (base A — 낡음)  ← 막아야 하는 것
# head는 T1~T4 내내 그대로라 head 가드로는 걸리지 않는다.

it "낡은 base의 그린 판정은 기존 레드 코멘트를 그린으로 덮지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A" # head는 일치한다 — 이 가드로는 못 막는다는 것이 이 케이스의 요지
main_route "$MAIN_B"   # 그 사이 main이 움직였다 = 이 판정의 base는 낡았다
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_eq "no-patch|no-post|0" \
  "$(grep -q 'method PATCH' "$GH_LOG" && echo patched || echo no-patch)|$(grep -q 'method POST' "$GH_LOG" && echo posted || echo no-post)|${REPORT_RC}"

it "낡은 base의 그린은 기존 봇 코멘트가 없으면 침묵하지 않고 판정 불가로 남긴다"
reset_scenario
# 코멘트가 아예 없으면 CONTRIBUTING.md 기준으로 통과다. 낡았다고 침묵하면 곧 false-green이다.
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$MAIN_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

it "낡은 base 판정 본문은 어느 base가 어긋났는지 밝힌다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$MAIN_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 \`main\`는 \`${MAIN_B}\`"

it "낡은 base라도 레드 판정은 강등하지 않고 그대로 보고한다"
reset_scenario
# 이 가드가 막는 고장은 "낡은 그린이 최신 레드를 덮는다" 하나다. 레드를 강등하면 근거만 잃는다.
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$MAIN_B"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 이전 판정")]"
run_report
assert_eq "patched|현재 main 기준으로 레드입니다" \
  "$(grep -q 'method PATCH' "$GH_LOG" && echo patched || echo no-patch)|$(grep -o '현재 main 기준으로 레드입니다' "$GH_BODY_LOG" | head -1)"

it "낡은 base라도 충돌 판정은 강등하지 않고 그대로 보고한다"
reset_scenario
make_result 7 conflict "" "" "" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$MAIN_B"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main과 충돌합니다"

it "현재 main을 조회하지 못하면 그린으로 보고하지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
fail_calls_matching "commits/main"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_eq "판정 불가|no-green" \
  "$(grep -o '판정 불가' "$GH_BODY_LOG" | head -1)|$(grep -q '🟢' "$GH_BODY_LOG" && echo green || echo no-green)"

it "현재 main을 조회하지 못해도 레드 판정은 그대로 보고한다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
fail_calls_matching "commits/main"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main 기준으로 레드입니다"

it "현재 main을 조회하지 못해도 충돌 판정은 그대로 보고한다"
reset_scenario
make_result 7 conflict "" "" "" "$HEAD_A"
head_route 7 "$HEAD_A"
fail_calls_matching "commits/main"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main과 충돌합니다"

it "BASE_SHA가 비어 있으면 그린으로 보고하지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
BASE_SHA_OVERRIDE=""
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

# --- 정상 운영에서 게이트가 침묵하지 않는다 (#125 항목 1의 두 번째 완료 조건) ------------
# push 스윕의 base는 자기 push의 sha이고 cancel-in-progress가 앞선 스윕을 취소하므로 보통
# 신선하다. 신선하면 아래처럼 판정이 그대로 나간다 — 가드가 게이트를 "판정 불가"로 상시
# 강등하지 않는다는 근거다.

it "base가 신선하면 그린 판정이 기존 코멘트를 그대로 갱신한다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$BASE"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_eq "patched|그린입니다" \
  "$(grep -q 'method PATCH repos/o/r/issues/comments/100' "$GH_LOG" && echo patched || echo no-patch)|$(grep -o '그린입니다' "$GH_BODY_LOG" | head -1)"

it "base가 신선하면 그린 판정이 판정 불가로 강등되지 않는다"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
main_route "$BASE"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 🔴 레드입니다")]"
run_report
assert_not_contains "$(cat "$GH_BODY_LOG")" "판정 불가"

it "base가 신선한 스윕에서는 여러 PR의 그린이 모두 그대로 보고된다"
reset_scenario
PRS='[7,8]'
make_result 7 green "" "" "$MERGE" "$HEAD_A"
make_result 8 green "" "" "$MERGE" "$HEAD_A"
head_route 7 "$HEAD_A"
head_route 8 "$HEAD_A"
main_route "$BASE"
route "issues/7/comments" "[$(comment 100 "$BOT" "🤖 [ci] ${MARKER} 이전 판정")]"
route "issues/8/comments" "[$(comment 200 "$BOT" "🤖 [ci] ${MARKER} 이전 판정")]"
run_report
assert_eq "2|0" \
  "$(grep -c 'method PATCH' "$GH_LOG")|$(grep -c '판정 불가' "$GH_BODY_LOG")"
PRS='[7]'

it "현재 main은 PR 수와 무관하게 실행당 한 번만 조회한다"
reset_scenario
# PR마다 다시 물으면 보고 도중 main이 움직였을 때 같은 스윕 안에서 기준이 갈린다.
PRS='[7,8]'
make_result 7 green "" "" "$MERGE" "$HEAD_A"
make_result 8 green "" "" "$MERGE" "$HEAD_A"
route "issues/7/comments" '[]'
route "issues/8/comments" '[]'
run_report
assert_eq "1" "$(grep -c 'commits/main' "$GH_LOG")"
PRS='[7]'

# --- 재실행 시 이전 시도의 판정 아티팩트가 보고되지 않는다 (#125 항목 2) ------------------
# 워크플로는 아티팩트 이름을 recheck-result-<PR>-attempt-<run_attempt>로 시도별로 가르고,
# download-artifact의 pattern도 현재 시도만 매칭한다. 스크립트 쪽 몫은 그 접미사를 붙인
# 디렉터리에서만 판정을 읽는 것이다.

it "RESULT_SUFFIX가 붙은 아티팩트 디렉터리에서 판정을 읽는다"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A" "-attempt-2"
RESULT_SUFFIX="-attempt-2"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "현재 main 기준으로 레드입니다"

it "현재 시도의 아티팩트가 없으면 이전 시도의 그린을 보고하지 않는다"
reset_scenario
# 재실행에서 업로드가 실패한 경로. 예전 이름(접미사 없음)에는 이전 시도의 그린이 남아 있다.
make_result 7 green "" "" "$MERGE" "$HEAD_A"
make_result 7 green "" "" "$MERGE" "$HEAD_A" "-attempt-1"
RESULT_SUFFIX="-attempt-2"
route "issues/7/comments" '[]'
run_report
assert_eq "판정 불가|no-green" \
  "$(grep -o '판정 불가' "$GH_BODY_LOG" | head -1)|$(grep -q '🟢' "$GH_BODY_LOG" && echo green || echo no-green)"

# --- discover 실패가 "코멘트 없음"으로 끝나지 않는다 (#125 항목 3) ------------------------

it "NO_RESULT_DETAIL로 판정 부재의 원인을 discover 실패로 밝힐 수 있다"
reset_scenario
NO_RESULT_DETAIL="대상 선정(discover) 잡이 실패해 재검증 대상을 정하지 못했습니다."
route "issues/7/comments" '[]'
run_report
assert_eq "posted|대상 선정(discover) 잡이 실패해 재검증 대상을 정하지 못했습니다." \
  "$(grep -q 'method POST repos/o/r/issues/7/comments' "$GH_LOG" && echo posted || echo no-post)|$(grep -o '대상 선정(discover) 잡이 실패해 재검증 대상을 정하지 못했습니다.' "$GH_BODY_LOG" | head -1)"

# --- 폴백 보고(AUTHORITATIVE=0)가 확정 판정을 덮지 않는다 (#152) -------------------------
# report-discovery-failure 잡은 discover가 죽어 **어떤 head·base를 검증할지조차 정하지 못한
# 채** 도는 잡이다. 그 잡이 남기는 "판정 불가"가 겹친 다른 실행(push 스윕 ↔ synchronize)이
# 방금 남긴 확정 판정을 덮으면, 판정하지 않은 잡이 판정한 잡의 결과를 지우는 것이 된다:
#   T1 push 스윕이 PR 7을 검증 → 🔴로 마커 PATCH        (확정 판정)
#   T2 PR 7에 synchronize → 그 실행의 discover가 죽는다
#   T3 폴백이 같은 마커를 ⛔ 판정 불가로 PATCH           ← 이것을 막는다
# 다만 침묵해서는 안 되므로(#125 항목 3) 게이트 마커가 없는 별도 알림 코멘트를 남긴다.

GREEN_HEAD="🟢 이 PR은 현재 main 기준으로 그린입니다."
RED_HEAD="🔴 **이 PR은 현재 main 기준으로 레드입니다.**"
STALE_HEAD="⛔ **판정 불가 — 이 재검증 결과가 현재 PR head·현재 \`main\` 기준인지 확인되지 않습니다.**"
NOTICE_MARKER="<!-- recheck-open-prs-notice -->"
FALLBACK_DETAIL="재검증 대상 선정(discover) 잡이 실패해 이 PR을 검증하지 못했습니다."

# gate_body <verdict> <headline> — 판정 종류를 마커에 심은 게이트 코멘트 본문.
# `\\n`은 JSON 문자열 안의 개행 이스케이프다 (comment()가 본문을 JSON에 그대로 끼워 넣는다).
gate_body() {
  printf '🤖 [ci]\\n\\n%s\\n<!-- recheck-verdict:%s -->\\n%s' "$MARKER" "$1" "$2"
}

# legacy_gate_body <headline> [추가 줄] — 판정 마커가 없던 시절(이 이슈 이전)의 본문.
# 이미 열려 있는 PR에 붙어 있는 코멘트가 이 모양이므로 이쪽도 읽어낼 수 있어야 한다.
legacy_gate_body() {
  printf '🤖 [ci]\\n\\n%s\\n%s\\n%s' "$MARKER" "$1" "${2:-}"
}

# discover 실패 폴백 잡과 같은 입력: 판정 아티팩트 없음, base 없음, 자기 원인 문구.
use_fallback_env() {
  AUTHORITATIVE=0
  BASE_SHA_OVERRIDE=""
  NO_RESULT_DETAIL="$FALLBACK_DETAIL"
}

it "폴백 보고는 겹친 실행이 남긴 확정 레드를 판정 불가로 덮지 않는다 (T1–T3)"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "폴백 보고는 확정 그린도 덮지 않는다"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body green "$GREEN_HEAD")")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "폴백 보고는 충돌 판정도 덮지 않는다"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body conflict "⚠️ **현재 \`main\` 기준 재검증을 하지 못했습니다.**")")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "확정 판정을 지키면서도 discover 실패는 새 코멘트로 보인다 (침묵 금지)"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")")]"
run_report
assert_eq "posted|${FALLBACK_DETAIL}" \
  "$(grep -q 'method POST repos/o/r/issues/7/comments' "$GH_LOG" && echo posted || echo no-post)|$(grep -o "$FALLBACK_DETAIL" "$GH_BODY_LOG" | head -1)"

it "폴백 알림 코멘트는 게이트 마커를 심지 않는다 (게이트 신호는 하나로 유지)"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")")]"
run_report
# 게이트를 덮지 않았으므로 이 실행이 쓴 본문은 알림 코멘트 하나뿐이다.
assert_not_contains "$(cat "$GH_BODY_LOG")" "$MARKER"

it "폴백 알림 코멘트가 이미 있으면 새로 만들지 않고 갱신한다"
reset_scenario
use_fallback_env
route "issues/7/comments" \
  "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")"),$(comment 300 "$BOT" "🤖 [ci]\\n\\n${NOTICE_MARKER}\\n⚠️ 지난 실행의 알림")]"
run_report
assert_eq "patched|no-post" \
  "$(grep -q 'method PATCH repos/o/r/issues/comments/300' "$GH_LOG" && echo patched || echo no-patch)|$(grep -q 'method POST' "$GH_LOG" && echo posted || echo no-post)"

it "폴백 알림 코멘트는 게이트 코멘트로 오인되지 않는다"
reset_scenario
use_fallback_env
# 알림만 있고 게이트 코멘트는 없는 상태. 알림을 게이트로 오인하면 그것을 PATCH해 버린다.
route "issues/7/comments" "[$(comment 300 "$BOT" "🤖 [ci]\\n\\n${NOTICE_MARKER}\\n⚠️ 지난 실행의 알림")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/300"

it "기존 게이트 코멘트가 없으면 폴백도 종전대로 판정 불가를 남긴다"
reset_scenario
use_fallback_env
route "issues/7/comments" '[]'
run_report
assert_eq "posted|판정 불가" \
  "$(grep -q 'method POST repos/o/r/issues/7/comments' "$GH_LOG" && echo posted || echo no-post)|$(grep -o '판정 불가' "$GH_BODY_LOG" | head -1)"

it "기존 게이트 코멘트가 이미 판정 불가면 폴백이 그 코멘트를 갱신한다"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body stale "$STALE_HEAD")")]"
run_report
assert_eq "patched|${FALLBACK_DETAIL}" \
  "$(grep -q 'method PATCH repos/o/r/issues/comments/100' "$GH_LOG" && echo patched || echo no-patch)|$(grep -o "$FALLBACK_DETAIL" "$GH_BODY_LOG" | head -1)"

it "판정 마커가 없는 옛 코멘트도 헤드라인으로 확정 판정으로 읽어 덮지 않는다"
reset_scenario
use_fallback_env
route "issues/7/comments" "[$(comment 100 "$BOT" "$(legacy_gate_body "$RED_HEAD")")]"
run_report
assert_not_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "판정 종류는 헤드라인에서만 읽는다 — 본문 뒤쪽의 그린 인용에 속지 않는다"
reset_scenario
use_fallback_env
# 레드 본문은 체크 출력 꼬리를 그대로 싣는다. 본문 전체를 이모지로 훑으면 판정 불가 코멘트가
# 확정 그린으로 읽혀 폴백이 침묵하게 된다.
route "issues/7/comments" "[$(comment 100 "$BOT" "$(legacy_gate_body "$STALE_HEAD" "이전 판정 인용: 🟢 그린입니다")")]"
run_report
assert_contains "$(cat "$GH_LOG")" "method PATCH repos/o/r/issues/comments/100"

it "기존 코멘트 조회에 실패하면 폴백은 게이트를 건드리지 않고 알림만 남긴다"
reset_scenario
use_fallback_env
# 확정 판정이 거기 있는지 알 수 없다 — 덮지 않는 쪽이 보수적이고, 알림이 침묵을 막는다.
fail_calls_matching "issues/7/comments?per_page"
run_report
assert_eq "posted|no-marker" \
  "$(grep -q 'method POST repos/o/r/issues/7/comments' "$GH_LOG" && echo posted || echo no-post)|$(grep -q -- "$MARKER" "$GH_BODY_LOG" && echo marker || echo no-marker)"

it "정상 report 잡은 판정 아티팩트가 없을 때 확정 레드를 판정 불가로 갱신한다 (회귀 없음)"
reset_scenario
# 이 잡은 authoritative하다 — 이번 실행에서 실제로 검증을 시도했고 결과가 없다고 보고한다.
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")")]"
run_report
assert_eq "patched|판정 불가" \
  "$(grep -q 'method PATCH repos/o/r/issues/comments/100' "$GH_LOG" && echo patched || echo no-patch)|$(grep -o '판정 불가' "$GH_BODY_LOG" | head -1)"

it "게이트 코멘트 본문에 판정 종류가 기계적으로 읽을 수 있게 심긴다 (레드)"
reset_scenario
make_result 7 red "" "pnpm lint" "$MERGE" "$HEAD_A"
route "issues/7/comments" '[]'
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "<!-- recheck-verdict:red -->"

it "게이트 코멘트 본문에 판정 종류가 기계적으로 읽을 수 있게 심긴다 (그린)"
reset_scenario
make_result 7 green "" "" "$MERGE" "$HEAD_A"
route "issues/7/comments" "[$(comment 100 "$BOT" "$(gate_body red "$RED_HEAD")")]"
run_report
assert_contains "$(cat "$GH_BODY_LOG")" "<!-- recheck-verdict:green -->"

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
