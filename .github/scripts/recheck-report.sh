#!/usr/bin/env bash
# recheck-open-prs.yml — 재검증 결과를 PR 코멘트 하나로 upsert한다.
#
# 워크플로 YAML에서 분리한 이유는 셸 테스트(recheck-report.test.sh)로 검증할 수 있게 하기
# 위함이다. 이 스크립트는 `pull-requests: write` 토큰을 쥐는 유일한 지점이므로 PR에서 온
# 코드를 돌리는 잡과 **분리된 잡**에서만 실행된다 (#112 항목 5).
#
# 입력(환경변수):
#   REPO         owner/repo
#   PRS          코멘트를 남길 PR 번호 JSON 배열
#   UNVERIFIED   그중 대상 선정 단계에서 분류에 실패한 PR 번호 JSON 배열 (기본 [])
#   RESULTS_DIR  recheck-result-<PR>/result.json 들이 풀려 있는 디렉터리 (기본 results)
#   BASE_SHA     검증 기준 main 커밋
#   RUN_URL      워크플로 실행 URL
#   BOT_LOGIN    게이트 코멘트의 작성자로 인정할 로그인 (기본 github-actions[bot])
set -euo pipefail

: "${REPO:?REPO is required}"
: "${PRS:?PRS is required}"
: "${RUN_URL:?RUN_URL is required}"
RESULTS_DIR="${RESULTS_DIR:-results}"
UNVERIFIED="${UNVERIFIED:-[]}"
BASE_SHA="${BASE_SHA:-}"
# 게이트로 인정할 코멘트의 작성자. 마커는 워크플로 파일에 평문으로 있고 이 리포에는
# 에이전트가 CI 코멘트를 인용하는 관례가 있다 — 작성자를 확인하지 않으면 인용 코멘트가
# 게이트를 영구히 가로챈다 (#112 항목 2).
BOT_LOGIN="${BOT_LOGIN:-github-actions[bot]}"
MARKER='<!-- recheck-open-prs -->'

log() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# 마커를 포함하고 **봇이 작성한** 코멘트만 고른다. 봇 코멘트는 한 번 만든 뒤 PATCH로만
# 갱신되어 위치가 고정되므로 가장 이른 것(first)을 대상으로 삼는다 — 예전 코드의 `last`는
# "나중에 달린 아무 일치 코멘트가 항상 이긴다"는 뜻이었다.
find_existing() {
  local pr="$1"
  gh api --paginate "repos/${REPO}/issues/${pr}/comments?per_page=100" |
    jq -s -r --arg m "$MARKER" --arg bot "$BOT_LOGIN" \
      '(add // [])
       | map(select(((.user.login // "") == $bot) and ((.body // "") | contains($m))))
       | first | .id // empty'
}

post_new() {
  local pr="$1" body="$2"
  if gh api --silent --method POST "repos/${REPO}/issues/${pr}/comments" -F "body=@${body}"; then
    log "- #${pr}: 코멘트 신설"
    return 0
  fi
  log "- #${pr}: 코멘트 생성 실패"
  return 1
}

build_body() {
  local verdict="$1" detail="$2" failed="$3" merge_sha="$4" head_sha="$5" logfile="$6"

  echo "🤖 [ci]"
  echo
  echo "$MARKER"
  case "$verdict" in
    green)
      echo "🟢 이 PR은 현재 main 기준으로 그린입니다."
      ;;
    red)
      echo "🔴 **이 PR은 현재 main 기준으로 레드입니다.**"
      echo
      echo "실패한 명령: \`${failed:-N/A}\`"
      echo
      echo "이 PR에 붙은 기존 CI 그린은 더 낡은 base의 결과입니다. main을 merge로 받아넣고"
      echo "(rebase·force push 금지) 고친 뒤 다시 push하세요 — head를 갱신하면 이 워크플로가"
      echo "다시 돌아 이 코멘트를 갱신합니다."
      if [ -n "$logfile" ] && [ -f "$logfile" ]; then
        echo
        echo "<details><summary>출력 마지막 부분</summary>"
        echo
        echo '```'
        tail -c 3000 "$logfile" || true
        echo '```'
        echo
        echo "</details>"
      fi
      ;;
    conflict)
      echo "⚠️ **현재 \`main\` 기준 재검증을 하지 못했습니다 — 이 PR은 현재 main과 충돌합니다.**"
      echo
      echo "GitHub이 보고하는 \`mergeable\`은 PR이 마지막으로 갱신된 시점의 base로 계산된 값이라"
      echo "\`clean\`으로 보일 수 있습니다. \`main\`을 merge로 받아넣어 해소해 주세요"
      echo "(rebase·force push 금지)."
      ;;
    *)
      # 알 수 없는/빈 판정은 그린이 아니다. "부재 ⇒ 불명"이 이 워크플로의 규율이다.
      echo "⛔ **판정 불가 — 현재 \`main\` 기준 재검증을 끝내지 못했습니다.**"
      echo
      echo "**이 코멘트는 그린도 레드도 아닙니다.** 재검증이 완료되지 않았으므로 이 PR에 붙어 있는"
      echo "기존 CI 그린은 현재 main 기준의 근거가 되지 못합니다 (CONTRIBUTING.md"
      echo "\"낡은 그린 체크 재검증\" 참조). 머지 전에 사람이 판단해야 합니다."
      if [ -n "$detail" ]; then
        echo
        echo "원인: ${detail}"
      fi
      echo
      echo "재검증을 다시 돌리려면 이 워크플로를 재실행하거나 PR head를 갱신하세요."
      ;;
  esac
  echo
  echo "- base: \`${BASE_SHA:-N/A}\`"
  # 이 판정이 어느 head 기준인지 남긴다 — owner가 낡은 판정을 알아볼 수 있어야 한다.
  echo "- 검증한 PR head: \`${head_sha:-N/A}\`"
  echo "- 검증한 머지 커밋: \`${merge_sha:-N/A}\`"
  echo "- 실행 로그: ${RUN_URL}"
}

# 실패를 반환코드로만 알리지 않는다 — 이 함수는 `if !`로 호출되므로 본문에서 errexit이
# 꺼진다(recheck-select.sh의 classify와 같은 이유). 모든 실패를 명시적으로 검사한다.
report_one() {
  local pr="$1"
  local dir="${RESULTS_DIR}/recheck-result-${pr}"
  local result="${dir}/result.json"
  local logfile="${dir}/checks.log"
  local verdict detail failed merge_sha head_sha force_new=0

  failed=""
  merge_sha=""
  head_sha=""
  if [ -f "$result" ]; then
    # 필드를 하나씩 읽는다. @tsv + `IFS=$'\t' read`는 탭이 IFS 공백문자라서 빈 필드가
    # 접혀 값이 밀린다(그래서 detail이 비면 failed에 merge_sha가 들어갔다).
    if ! jq -e 'type == "object"' "$result" >/dev/null 2>&1; then
      verdict="error"
      detail="재검증 결과 파일을 읽지 못했습니다 (${result})."
    else
      verdict=$(jq -r '.verdict // ""' "$result")
      detail=$(jq -r '.detail // ""' "$result")
      failed=$(jq -r '.failed // ""' "$result")
      merge_sha=$(jq -r '.merge_sha // ""' "$result")
      head_sha=$(jq -r '.head_sha // ""' "$result")
    fi
  else
    verdict="error"
    if jq -e --argjson n "$pr" 'index($n) != null' <<<"$UNVERIFIED" >/dev/null; then
      detail="대상 선정 단계가 이 PR을 분류하지 못했습니다 (GitHub API 조회 실패 등)."
    else
      detail="재검증 잡이 결과를 남기지 못했습니다 (잡 실패·취소 또는 아티팩트 누락)."
    fi
  fi

  local body="${TMPDIR:-/tmp}/recheck-body-${pr}.md"
  if ! build_body "$verdict" "$detail" "$failed" "$merge_sha" "$head_sha" "$logfile" >"$body"; then
    log "- #${pr}: 코멘트 본문 생성 실패"
    return 1
  fi

  local existing
  if ! existing=$(find_existing "$pr"); then
    # 조회에 실패하면 기존 코멘트 유무를 알 수 없다. 보고가 사라지는 쪽보다 중복되는 쪽이
    # 안전하다 — "코멘트 없음"은 CONTRIBUTING.md 기준으로 통과이기 때문이다.
    log "- #${pr}: 기존 코멘트 조회 실패 — 새 코멘트로 남깁니다"
    existing=""
    force_new=1
  fi

  if [ -n "$existing" ]; then
    if gh api --silent --method PATCH "repos/${REPO}/issues/comments/${existing}" -F "body=@${body}"; then
      log "- #${pr}: 코멘트 ${existing} 갱신 (${verdict})"
      return 0
    fi
    # PATCH 실패로 보고가 통째로 사라지면 게이트가 없어진다 (#112 항목 2 후반).
    # 새 코멘트로 폴백하고, 그마저 실패하면 잡을 실패시켜 사람이 알게 한다.
    log "- #${pr}: 코멘트 ${existing} 갱신 실패 — 새 코멘트로 폴백합니다"
    post_new "$pr" "$body"
    return $?
  fi

  if [ "$verdict" = "green" ] && [ "$force_new" -eq 0 ]; then
    # 그린인데 이력도 없으면 알릴 것이 없다 — 코멘트를 만들지 않는다.
    log "- #${pr}: 그린이고 기존 봇 코멘트도 없어 코멘트를 남기지 않았습니다"
    return 0
  fi

  post_new "$pr" "$body"
  return $?
}

# PR 번호만 통과시킨다 — 이 스크립트는 쓰기 토큰을 쥐고 있고 PR 번호를 경로·URL에 넣는다.
if ! prs_list=$(jq -r '.[] | select(type == "number") | tostring' <<<"$PRS"); then
  echo "PRS를 PR 번호 배열로 읽지 못했습니다: ${PRS}" >&2
  exit 1
fi

overall=0
for pr in $prs_list; do
  if ! report_one "$pr"; then
    overall=1
  fi
done
exit "$overall"
