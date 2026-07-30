# 공통 테스트 하네스 — recheck-*.test.sh가 source한다.
#
# GitHub Actions 러너 없이 recheck-*.sh를 돌리기 위한 최소 장치다:
#   - PATH 앞에 가짜 `gh`를 심어 호출을 기록·조작한다 (네트워크 없음)
#   - $GITHUB_OUTPUT / $GITHUB_STEP_SUMMARY를 임시 파일로 준다
#   - 통과/실패를 세서 마지막에 종료코드로 알린다
#
# 셸 스크립트를 vitest가 아니라 셸로 테스트하는 이유: 검증 대상이 bash의 errexit 의미론과
# 빈 출력 처리이고, 그건 실제 bash로 돌려야만 재현된다 (#112 항목 1·4).

TESTS_RUN=0
TESTS_FAILED=0
CURRENT_CASE=""

# shellcheck disable=SC2034
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

setup_sandbox() {
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/recheck-test-XXXXXX")"
  BIN="${SANDBOX}/bin"
  mkdir -p "$BIN"
  GH_LOG="${SANDBOX}/gh.log"
  GH_BODY_LOG="${SANDBOX}/gh-bodies.log"
  GITHUB_OUTPUT="${SANDBOX}/github_output"
  GITHUB_STEP_SUMMARY="${SANDBOX}/github_step_summary"
  : >"$GH_LOG"
  : >"$GH_BODY_LOG"
  : >"$GITHUB_OUTPUT"
  : >"$GITHUB_STEP_SUMMARY"
  export GH_LOG GH_BODY_LOG GITHUB_OUTPUT GITHUB_STEP_SUMMARY
  install_fake_gh
  PATH="${BIN}:${PATH}"
  export PATH
}

teardown_sandbox() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  unset GH_FAIL GH_ROUTES
}

# 가짜 gh. 실제 gh처럼 --jq를 적용하고, -F body=@파일의 내용을 기록한다.
#   GH_FAIL   : 줄단위 부분문자열 목록 — 인자에 걸리면 종료코드 1
#   GH_ROUTES : 줄단위 "부분문자열|응답파일" 목록
install_fake_gh() {
  cat >"${BIN}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
args="$*"
echo "$args" >>"$GH_LOG"

for a in "$@"; do
  case "$a" in
    body=@*)
      src="${a#body=@}"
      if [ -n "${GH_BODY_LOG:-}" ] && [ -f "$src" ]; then
        {
          echo "=== ${args}"
          cat "$src"
        } >>"$GH_BODY_LOG"
      fi
      ;;
  esac
done

if [ -n "${GH_FAIL:-}" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$args" in *"$pat"*) exit 1 ;; esac
  done <<<"$GH_FAIL"
fi

jqexpr=""
prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && jqexpr="$a"
  prev="$a"
done

if [ -n "${GH_ROUTES:-}" ]; then
  while IFS='|' read -r pat file; do
    [ -z "$pat" ] && continue
    case "$args" in
      *"$pat"*)
        if [ -n "$jqexpr" ]; then
          jq -r "$jqexpr" "$file"
        else
          cat "$file"
        fi
        exit 0
        ;;
    esac
  done <<<"$GH_ROUTES"
fi
exit 0
FAKE_GH
  chmod +x "${BIN}/gh"
}

# 응답 파일을 만들고 라우트를 등록한다: route "<부분문자열>" '<JSON>'
route() {
  local pat="$1" json="$2"
  local file
  file="${SANDBOX}/route-$(( ${ROUTE_SEQ:=0} + 1 )).json"
  ROUTE_SEQ=$((ROUTE_SEQ + 1))
  printf '%s' "$json" >"$file"
  GH_ROUTES="${GH_ROUTES:-}${GH_ROUTES:+$'\n'}${pat}|${file}"
  export GH_ROUTES
}

fail_calls_matching() {
  GH_FAIL="${GH_FAIL:-}${GH_FAIL:+$'\n'}$1"
  export GH_FAIL
}

it() {
  CURRENT_CASE="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
}

pass_case() {
  echo "  ok   — ${CURRENT_CASE}"
}

fail_case() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "  FAIL — ${CURRENT_CASE}"
  echo "         $1"
}

assert_eq() {
  local expected="$1" actual="$2"
  if [ "$expected" = "$actual" ]; then
    pass_case
  else
    fail_case "expected [${expected}] but got [${actual}]"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2"
  case "$haystack" in
    *"$needle"*) pass_case ;;
    *) fail_case "expected to contain [${needle}] — got: $(printf '%s' "$haystack" | head -c 400)" ;;
  esac
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  case "$haystack" in
    *"$needle"*) fail_case "expected NOT to contain [${needle}] — got: $(printf '%s' "$haystack" | head -c 400)" ;;
    *) pass_case ;;
  esac
}

# $GITHUB_OUTPUT에 기록된 key의 마지막 값
output_of() {
  grep "^$1=" "$GITHUB_OUTPUT" | tail -1 | cut -d= -f2-
}

finish() {
  echo
  if [ "$TESTS_FAILED" -eq 0 ]; then
    echo "${SUITE_NAME:-suite}: ${TESTS_RUN}건 전부 통과"
    exit 0
  fi
  echo "${SUITE_NAME:-suite}: ${TESTS_RUN}건 중 ${TESTS_FAILED}건 실패"
  exit 1
}
