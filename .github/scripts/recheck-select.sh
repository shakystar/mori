#!/usr/bin/env bash
# recheck-open-prs.yml — 재검증 대상 선정.
#
# 워크플로 YAML에서 분리한 이유는 셸 테스트(recheck-select.test.sh)로 검증할 수 있게 하기
# 위함이다. #112 항목 4("분류 실패가 run으로 위장")가 여기 있던 버그다.
#
# 입력(환경변수):
#   REPO           owner/repo
#   EVENT_NAME     push | pull_request (기본 push)
#   PUSH_SHA       push 이벤트의 github.sha — EVENT_NAME=push일 때 필수
#   PR_NUMBER      pull_request 이벤트의 PR 번호 — EVENT_NAME=pull_request일 때 필수
#   RETRY_ATTEMPTS 분류 재시도 횟수 (기본 5)
#   RETRY_SLEEP    재시도 간 대기 초 (기본 5)
# 출력($GITHUB_OUTPUT):
#   base_sha       검증 기준이 되는 현재 main 커밋
#   prs / count    러너에서 실제로 재검증할 PR 번호 JSON 배열과 그 개수
#   unverified     분류에 실패해 판정을 낼 수 없는 PR 번호 JSON 배열
#   report / report_count
#                  코멘트로 보고해야 하는 PR 전체(prs + unverified)와 그 개수
set -euo pipefail

: "${REPO:?REPO is required}"
EVENT_NAME="${EVENT_NAME:-push}"
RETRY_ATTEMPTS="${RETRY_ATTEMPTS:-5}"
RETRY_SLEEP="${RETRY_SLEEP:-5}"

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

# 검증 기준은 "지금의 main"이다. pull_request 이벤트의 github.sha는 PR 머지 커밋이라
# main HEAD가 아니므로 이벤트별로 다르게 구한다.
if [ "$EVENT_NAME" = "push" ]; then
  base_sha="${PUSH_SHA:?PUSH_SHA is required for push events}"
else
  if ! base_sha=$(gh api "repos/${REPO}/commits/main" --jq '.sha'); then
    echo "현재 main 커밋을 조회하지 못했습니다" >&2
    exit 1
  fi
fi
if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "base_sha가 커밋 SHA 모양이 아닙니다: '${base_sha}'" >&2
  exit 1
fi

log "## 재검증 대상 선정"
log ""
log "기준 base: \`main\` @ \`${base_sha}\` (이벤트: ${EVENT_NAME})"
log ""

numbers=()
if [ "$EVENT_NAME" = "push" ]; then
  if ! raw=$(gh api --paginate "repos/${REPO}/pulls?state=open&base=main&per_page=100" --jq '.[].number'); then
    echo "열린 PR 목록을 조회하지 못했습니다" >&2
    exit 1
  fi
  if [ -n "$raw" ]; then
    mapfile -t numbers <<<"$raw"
  fi
else
  numbers=("${PR_NUMBER:?PR_NUMBER is required for pull_request events}")
fi

# 열린 PR이 0건이면 할 일이 없다 — 빈 목록으로 성공 종료한다(뒤의 잡들은 if로 스킵된다).
if [ "${#numbers[@]}" -eq 0 ]; then
  log "열린 PR 0건 — 재검증할 것이 없습니다."
  emit "base_sha=${base_sha}"
  emit "prs=[]"
  emit "count=0"
  emit "unverified=[]"
  emit "report=[]"
  emit "report_count=0"
  exit 0
fi

# PR 하나의 분류가 실패해도 나머지 스윕은 계속돼야 한다. 그런데 함수를 `$(f) || ...`나
# `if ! f`의 피연산자로 부르면 bash는 **함수 본문 전체에서** errexit을 끈다. 그래서
# "함수 안에서 set -e로 죽으면 호출부가 잡는다"는 가정은 성립하지 않는다 (#112 항목 4:
# 예전 코드는 gh api가 실패해도 빈 문자열이 흘러가 `run`을 출력했다).
# 이 함수는 반환코드에 기대지 않는다 — 모든 실패를 명시적으로 검사해서 분류 문자열로
# 되돌린다. 값이 비어 있으면 특정 상태로 단정하지 않고 "불명"으로 다룬다.
classify() {
  local n="$1" json fields draft mergeable state attempt last=""
  local -a parsed

  for ((attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++)); do
    if ! json=$(gh api "repos/${REPO}/pulls/${n}"); then
      last="api-failed"
      sleep "$RETRY_SLEEP"
      continue
    fi

    # 타입까지 확인해서 뽑는다. `.draft // empty`는 false도 걸러버리고(jq의 `//`는 false를
    # 대체한다), 키가 없을 때와 null일 때를 구분하지 않으면 빈 문자열이 상태로 위장한다.
    # 줄 단위로 받아 mapfile로 읽는다 — @tsv + `IFS=$'\t' read`는 탭이 IFS 공백문자라서
    # 빈 필드가 접히고 값이 한 칸씩 밀린다.
    if ! fields=$(jq -r '
          (if (.draft | type) == "boolean" then (.draft | tostring) else "" end),
          (if (.mergeable | type) == "boolean" then (.mergeable | tostring) else "unknown" end),
          (if (.mergeable_state | type) == "string" then .mergeable_state else "" end)
        ' <<<"$json"); then
      last="bad-response"
      sleep "$RETRY_SLEEP"
      continue
    fi
    mapfile -t parsed <<<"$fields"
    draft="${parsed[0]:-}"
    mergeable="${parsed[1]:-}"
    state="${parsed[2]:-}"

    if [ -z "$draft" ] || [ -z "$state" ]; then
      last="bad-response"
      sleep "$RETRY_SLEEP"
      continue
    fi

    # 드래프트는 아직 리뷰 대상이 아니다.
    if [ "$draft" = "true" ]; then
      echo "skip:draft"
      return 0
    fi

    # mergeable이 null이면 GitHub이 머지 가능성을 아직 계산 중이다(이 GET이 계산을 촉발한다).
    if [ "$mergeable" != "unknown" ] && [ "$state" != "unknown" ]; then
      case "$state" in
        # 충돌(dirty) 건은 developer가 merge로 해소할 몫이다. 여기서 손대봐야 실패만 쌓인다.
        dirty) echo "skip:conflict" ;;
        *) echo "run" ;;
      esac
      return 0
    fi

    last="mergeability-unknown"
    sleep "$RETRY_SLEEP"
  done

  case "$last" in
    # 계산 중 상태가 끝까지 안 풀린 것은 GitHub 쪽 지연이다 — 다음 트리거에서 다시 본다.
    mergeability-unknown) echo "skip:mergeability-unknown" ;;
    *) echo "error:classify-${last:-failed}" ;;
  esac
}

sel=()
unverified=()
for n in "${numbers[@]}"; do
  reason=$(classify "$n")
  case "$reason" in
    run)
      sel+=("$n")
      log "- #${n} → 재검증"
      ;;
    skip:*)
      log "- #${n} → 건너뜀 (${reason#skip:})"
      ;;
    *)
      # 분류 실패는 "통과"가 아니다. 재검증은 못 하지만 판정 불가로는 보고해야 한다 —
      # 코멘트가 없으면 CONTRIBUTING.md 기준으로 통과로 읽힌다.
      unverified+=("$n")
      log "- #${n} → 분류 실패 (${reason}) — 판정 불가로 보고합니다"
      ;;
  esac
done

to_json() {
  if [ "$#" -eq 0 ]; then
    echo "[]"
  else
    printf '%s\n' "$@" | jq -c -R -s 'split("\n") | map(select(length > 0)) | map(tonumber)'
  fi
}

prs=$(to_json "${sel[@]+"${sel[@]}"}")
unverified_json=$(to_json "${unverified[@]+"${unverified[@]}"}")
report=$(jq -c -n --argjson a "$prs" --argjson b "$unverified_json" '$a + $b')

emit "base_sha=${base_sha}"
emit "prs=${prs}"
emit "count=$(jq -r 'length' <<<"$prs")"
emit "unverified=${unverified_json}"
emit "report=${report}"
emit "report_count=$(jq -r 'length' <<<"$report")"
