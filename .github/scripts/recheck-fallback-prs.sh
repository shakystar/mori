#!/usr/bin/env bash
# recheck-open-prs.yml — discover(대상 선정)가 죽었을 때 "판정 불가"를 알릴 PR 목록을 만든다.
#
# 왜 따로 있나. report 잡의 if는 `needs.discover.result == 'success'`를 요구하므로 discover가
# 죽으면 보고가 한 건도 나가지 않는다. CONTRIBUTING.md `:124` 기준으로 **코멘트 없음은
# 통과**이므로 그 침묵이 곧 false-green이다 (#125 항목 3). 워크플로 실행이 레드로 남지만
# owner의 머지 판단 근거는 PR 코멘트다.
#
# 이 스크립트는 판정을 하지 않는다 — 누구에게 "판정 불가"를 알릴지만 정한다. 그래서
# recheck-select.sh의 classify(재시도·머지가능성 계산 대기)를 쓰지 않고 목록 조회 한 번으로
# 끝낸다: discover가 이미 죽은 상황이라 같은 무거운 경로를 다시 타 봐야 같이 죽을 뿐이다.
#
# 조회가 실패하면 침묵하지 않고 exit 1로 죽는다. 빈 목록으로 성공하면 그것이 다시
# "코멘트 없음 = 통과"가 된다.
#
# 한계: 이 파일이 아직 기본 브랜치에 없으면(이 워크플로를 처음 들여오는 PR) 폴백 잡도
# 스크립트를 찾지 못해 죽는다. 그때는 실행이 레드로 남는 것이 유일한 신호다 — discover의
# "Verify the trusted scripts exist"와 같은 부트스트랩 상태이고, 머지되면 해소된다.
#
# 입력(환경변수):
#   REPO       owner/repo
#   EVENT_NAME push | pull_request (기본 push)
#   PR_NUMBER  pull_request 이벤트의 PR 번호
#   PR_DRAFT   pull_request 이벤트의 draft 여부 (true|false)
# 출력($GITHUB_OUTPUT):
#   prs / count  알릴 PR 번호 JSON 배열과 그 개수
set -euo pipefail

: "${REPO:?REPO is required}"
EVENT_NAME="${EVENT_NAME:-push}"

log() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >>"$GITHUB_OUTPUT"
  fi
}

log "## 대상 선정 실패 — 판정 불가 보고 대상"
log ""

if [ "$EVENT_NAME" = "pull_request" ]; then
  : "${PR_NUMBER:?PR_NUMBER is required for pull_request events}"
  if [ "${PR_DRAFT:-false}" = "true" ]; then
    # 드래프트는 discover도 건너뛴다. 여기서만 알리면 없던 게이트가 생긴다.
    log "- #${PR_NUMBER} → 드래프트라 보고하지 않습니다"
    prs="[]"
  else
    prs=$(jq -c -n --argjson n "$PR_NUMBER" '[$n]')
  fi
else
  # draft는 같은 응답에 들어 있으므로 추가 호출 없이 거른다.
  if ! prs=$(gh api --paginate "repos/${REPO}/pulls?state=open&base=main&per_page=100" \
    --jq '[.[] | select(.draft != true) | .number]' | jq -c -s 'add // []'); then
    echo "열린 PR 목록을 조회하지 못했습니다 — 판정 불가 보고 대상을 정할 수 없습니다" >&2
    exit 1
  fi
fi

if ! jq -e 'type == "array" and all(type == "number")' <<<"$prs" >/dev/null 2>&1; then
  echo "PR 목록을 번호 배열로 읽지 못했습니다: '${prs}'" >&2
  exit 1
fi

count=$(jq -r 'length' <<<"$prs")
log "- 보고 대상 ${count}건: \`${prs}\`"

emit "prs=${prs}"
emit "count=${count}"
