#!/usr/bin/env bash
# 줄 인용 advisory 코멘트를 PR에 올린다 (#303 조각2 / #322).
# recheck-open-prs의 선례를 따른다 — 마커 주석이 붙은 **봇 코멘트 하나**를 계속 갱신한다.
# 다만 이것은 판정 코멘트가 아니므로 `recheck-verdict` 계열 마커는 심지 않는다.
#
# 규율 하나가 이 스크립트의 전부다: **경고 0건에서는 코멘트를 만들지 않는다.**
# "이상 없음" 코멘트는 검사 대상이 0건인 상황(인용이 하나도 없는 PR)과 구분되지 않아
# false-green으로 읽힌다 (docs/line-citation-staleness-adjudication.md §Q5).
# 이미 경고를 올린 뒤 그 경고가 사라진 경우만 예외다 — 그때는 새로 말을 거는 것이 아니라
# 이미 한 말을 거두는 것이므로, 기존 코멘트를 갱신해 낡은 목록을 남겨 두지 않는다.
#
# 입력 (환경변수):
#   REPO        owner/repo
#   PR          PR 번호
#   WARN_COUNT  경고 건수
#   BODY_FILE   WARN_COUNT > 0 일 때 올릴 본문 파일 (마커를 포함해야 한다)
#   HEAD_SHA    표시용 head SHA (경고가 사라졌을 때의 본문에 적는다)
#   BOT_LOGIN   갱신 대상으로 인정할 작성자 (기본 github-actions[bot])
set -euo pipefail

REPO="${REPO:?REPO가 필요하다}"
PR="${PR:?PR이 필요하다}"
WARN_COUNT="${WARN_COUNT:?WARN_COUNT가 필요하다}"
BODY_FILE="${BODY_FILE:-}"
HEAD_SHA="${HEAD_SHA:-}"
# 작성자를 확인하지 않으면, 이 마커를 인용한 아무 코멘트나 갱신 대상이 된다 (#112 항목 2와
# 같은 고장). 이 리포에는 에이전트가 CI 코멘트를 그대로 인용하는 관례가 있다.
BOT_LOGIN="${BOT_LOGIN:-github-actions[bot]}"
MARKER='<!-- line-citation-advisory -->'

log() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# 마커를 포함하고 봇이 작성한 코멘트 중 **가장 이른 것**의 id. 없으면 빈 출력.
# 봇 코멘트는 한 번 만든 뒤 PATCH로만 갱신되어 자리가 고정되므로 first가 맞다.
find_existing() {
  gh api --paginate "repos/${REPO}/issues/${PR}/comments?per_page=100" |
    jq -s -r --arg m "$MARKER" --arg bot "$BOT_LOGIN" '
      (add // [])
      | map(select(((.user.login // "") == $bot) and ((.body // "") | contains($m))))
      | first | if . == null then "" else (.id | tostring) end
    '
}

existing="$(find_existing)"

if [ "$WARN_COUNT" -gt 0 ]; then
  [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ] || {
    echo "::error::경고 ${WARN_COUNT}건인데 본문 파일이 없다 (BODY_FILE=${BODY_FILE})"
    exit 1
  }
  if [ -n "$existing" ]; then
    gh api --silent --method PATCH "repos/${REPO}/issues/comments/${existing}" -F "body=@${BODY_FILE}"
    log "줄 인용 advisory: 경고 ${WARN_COUNT}건 — 기존 코멘트(${existing})를 갱신했다."
  else
    gh api --silent --method POST "repos/${REPO}/issues/${PR}/comments" -F "body=@${BODY_FILE}"
    log "줄 인용 advisory: 경고 ${WARN_COUNT}건 — 코멘트를 새로 달았다."
  fi
  exit 0
fi

if [ -z "$existing" ]; then
  log "줄 인용 advisory: 경고 0건 · 기존 코멘트 없음 — 코멘트를 만들지 않는다."
  exit 0
fi

cleared="$(mktemp)"
{
  echo "$MARKER"
  echo "### 줄 인용 advisory — 현재 head에는 해당 인용이 없습니다"
  echo
  echo "앞서 이 자리에 올렸던 경고 목록은 현재 head(\`${HEAD_SHA:-미상}\`) 기준으로 더는 뜨지 않습니다"
  echo "(대상 파일이 diff에서 빠졌거나 인용이 바뀌었습니다). 낡은 목록을 남겨 두지 않기 위해 갱신합니다."
  echo
  echo "<sub>이 코멘트는 판정이 아니며 required check가 아닙니다 — \`docs/line-citation-staleness-adjudication.md\` §Q4 / #303 조각2.</sub>"
} >"$cleared"
gh api --silent --method PATCH "repos/${REPO}/issues/comments/${existing}" -F "body=@${cleared}"
rm -f "$cleared"
log "줄 인용 advisory: 경고 0건 — 기존 코멘트(${existing})를 '해당 없음'으로 갱신했다."
