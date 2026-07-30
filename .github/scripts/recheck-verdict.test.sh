#!/usr/bin/env bash
# recheck-verdict.sh 테스트 — 판정이 "출력 부재 ⇒ 불명" 규율을 지키는지 확인한다 (#112 항목 1).
set -uo pipefail

SUITE_NAME="recheck-verdict"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

run_verdict() {
  OUT_DIR="${SANDBOX}/result"
  rm -rf "$OUT_DIR"
  env PR="${PR:-7}" OUT_DIR="$OUT_DIR" \
    MERGE_RESULT="${MERGE_RESULT:-}" MERGE_OUTCOME="${MERGE_OUTCOME:-}" \
    MERGE_SHA="${MERGE_SHA:-}" HEAD_SHA="${HEAD_SHA:-}" \
    CHECKS_STATUS="${CHECKS_STATUS:-}" CHECKS_OUTCOME="${CHECKS_OUTCOME:-}" \
    FAILED="${FAILED:-}" LOG="${LOG:-}" \
    bash "${DIR}/recheck-verdict.sh" >/dev/null
}

field() {
  jq -r "$1" "${SANDBOX}/result/result.json"
}

reset_env() {
  unset MERGE_RESULT MERGE_OUTCOME MERGE_SHA HEAD_SHA CHECKS_STATUS CHECKS_OUTCOME FAILED LOG
}

setup_sandbox

it "체크가 green을 남기면 판정은 green이다"
reset_env
MERGE_RESULT=merged MERGE_OUTCOME=success MERGE_SHA=abc CHECKS_STATUS=green CHECKS_OUTCOME=success run_verdict
assert_eq "green" "$(field '.verdict')"

it "머지는 됐는데 체크 status가 비어 있으면 green이 아니라 error로 판정한다"
reset_env
# 선행 단계(Setup pnpm/Node) 실패로 `Run repo checks`가 스킵된 경로. 예전 코드는 여기서
# else로 떨어져 "🟢 그린입니다"를 출력했다.
MERGE_RESULT=merged MERGE_OUTCOME=success CHECKS_STATUS="" CHECKS_OUTCOME=skipped run_verdict
assert_eq "error" "$(field '.verdict')"

it "체크 status가 비어 있을 때 판정 사유가 선행 단계 실패를 가리킨다"
reset_env
MERGE_RESULT=merged MERGE_OUTCOME=success CHECKS_STATUS="" CHECKS_OUTCOME=skipped run_verdict
assert_contains "$(field '.detail')" "선행 단계가 실패하면"

it "머지 단계가 outcome을 남기지 않으면 conflict가 아니라 error로 판정한다"
reset_env
# git fetch 실패처럼 충돌이 아닌 이유로 머지 단계가 죽은 경로. 예전 코드는 MERGED != true를
# 곧바로 "현재 main과 충돌합니다"로 보고했다.
MERGE_RESULT="" MERGE_OUTCOME=failure run_verdict
assert_eq "error" "$(field '.verdict')"

it "머지 단계 실패의 판정 사유가 충돌이 아님을 밝힌다"
reset_env
MERGE_RESULT="" MERGE_OUTCOME=failure run_verdict
assert_contains "$(field '.detail')" "충돌이 아닌 이유"

it "머지가 충돌로 끝나면 판정은 conflict다"
reset_env
MERGE_RESULT=conflict MERGE_OUTCOME=success run_verdict
assert_eq "conflict" "$(field '.verdict')"

it "체크가 red를 남기면 실패한 명령이 판정에 보존된다"
reset_env
MERGE_RESULT=merged MERGE_OUTCOME=success CHECKS_STATUS=red CHECKS_OUTCOME=success FAILED="pnpm lint" run_verdict
assert_eq "red|pnpm lint" "$(field '.verdict')|$(field '.failed')"

it "검증한 head 커밋이 판정에 기록된다"
reset_env
MERGE_RESULT=merged MERGE_OUTCOME=success CHECKS_STATUS=green HEAD_SHA=deadbeef run_verdict
assert_eq "deadbeef" "$(field '.head_sha')"

it "체크 로그가 있으면 판정 디렉터리로 함께 복사된다"
reset_env
printf 'tail of the log\n' >"${SANDBOX}/checks.log"
MERGE_RESULT=merged MERGE_OUTCOME=success CHECKS_STATUS=red LOG="${SANDBOX}/checks.log" run_verdict
assert_eq "tail of the log" "$(cat "${SANDBOX}/result/checks.log")"

teardown_sandbox
finish
