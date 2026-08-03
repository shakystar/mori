#!/usr/bin/env bash
# refresh-armed-prs.yml — 갱신 대상 선정과 update-branch 호출.
#
# 왜 필요한가 (#195): required status check(`build-and-test`)는 **PR head 커밋에 붙은 check-run의
# 결론**으로 평가된다. `main`이 앞서 나가도 PR head SHA는 그대로이므로 그 SHA에 박힌 `failure`도
# 그대로 남고, `ci.yml`은 base가 움직이는 것을 트리거로 삼지 않는다. PR 자기 diff와 무관한
# 이유로(원인이 `main`에 있어서) 레드가 박히면 그 PR은 스스로 할 수 있는 일이 없고, armed된
# auto-merge는 조건 미충족으로 영원히 대기한다. head를 현재 `main`으로 갱신하면 진짜
# `synchronize` 이벤트가 나고 `ci.yml`이 **현재 `main`을 포함한 head에서** 새 `build-and-test`를
# 남긴다 — required check의 생산 주체는 `ci.yml` 하나로 유지된다.
#
# 워크플로 YAML에서 분리한 이유는 recheck-select.sh와 같다: 선별 판정을 셸 테스트
# (refresh-armed-prs.test.sh)로 검증할 수 있게 하기 위함이다.
#
# 입력(환경변수):
#   REPO           owner/repo
#   BASE_SHA       현재 main 커밋 (push 이벤트의 github.sha). main에 포함된 커밋이어야 하며,
#                  아래에서 compare API로 확인한 뒤에만 기준 base로 쓴다.
#   GH_TOKEN       gh가 쓰는 토큰. 기본 GITHUB_TOKEN이 아니라 **App 설치 토큰**이어야 한다 —
#                  GITHUB_TOKEN이 만든 synchronize run은 approval-required 상태로 생성돼
#                  사람이 "Approve and run"을 누를 때까지 시작하지 않는다 (#195 실측 3).
#   RETRY_ATTEMPTS 분류 재시도 횟수 (기본 5)
#   RETRY_SLEEP    재시도 간 대기 초 (기본 5)
# 출력($GITHUB_OUTPUT):
#   refreshed / refreshed_count  update-branch가 접수된 PR 번호 JSON 배열과 개수
#   skipped                      갱신 대상이 아니어서 건너뛴 PR 번호 JSON 배열
#   unresolved                   분류하지 못해 이번 회차에 판단을 못 내린 PR 번호 JSON 배열
#   failed / failed_count        갱신을 시도했지만 실패한 PR 번호 JSON 배열
set -euo pipefail

: "${REPO:?REPO is required}"
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

to_json() {
  if [ "$#" -eq 0 ]; then
    echo "[]"
  else
    printf '%s\n' "$@" | jq -c -R -s 'split("\n") | map(select(length > 0)) | map(tonumber)'
  fi
}

# 기준 base가 없거나 모양이 이상하면 여기서 죽는다. 이 값은 "PR이 뒤처졌는가"를 재는 자이므로,
# 빈 값이 흘러가면 비교가 통째로 무의미해지고 판정이 조용히 뒤집힌다.
base_sha="${BASE_SHA:?BASE_SHA is required}"
if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "BASE_SHA가 커밋 SHA 모양이 아닙니다: '${base_sha}'" >&2
  exit 1
fi

# 모양 검사만으로는 부족하다 (#195 리뷰). 40자 hex이기만 하면 **다른 브랜치의 head SHA**도
# 그대로 "기준 base"로 통과하는데, 그러면 뒤처짐을 엉뚱한 자로 재게 되어 갱신/스킵 판정이
# 조용히 뒤집힌다 — 빈 값이 흘러갈 때와 같은 사고이고, 모양은 멀쩡하므로 더 안 보인다.
# 그 값이 실제로 `main`에 포함된 커밋인지 확인한다. 같음이 아니라 포함으로 재는 이유: main이
# 연달아 push되면 앞선 실행의 BASE_SHA는 이미 main의 head가 아니지만 여전히 main의 조상이고,
# 그 실행이 내리는 판정은 (좁을 뿐) 틀리지 않는다. compare의 behind_by는 "head(main)에 없는
# base(BASE_SHA) 커밋 수"이므로, 포함돼 있으면 0이다.
if ! base_cmp=$(gh api "repos/${REPO}/compare/${base_sha}...main"); then
  echo "BASE_SHA가 main에 포함된 커밋인지 확인하지 못했습니다: '${base_sha}'" >&2
  exit 1
fi
base_behind=$(jq -r 'if (.behind_by | type) == "number" then (.behind_by | tostring) else "" end' <<<"$base_cmp" || true)
if [ -z "$base_behind" ]; then
  echo "compare 응답에서 BASE_SHA의 포함 여부를 읽지 못했습니다: '${base_sha}'" >&2
  exit 1
fi
if [ "$base_behind" -ne 0 ]; then
  echo "BASE_SHA가 main에 포함된 커밋이 아닙니다 (main에 없는 커밋 ${base_behind}개): '${base_sha}'" >&2
  echo "이 워크플로는 main에서만 돌아야 합니다 — 다른 ref의 head를 기준 base로 쓰면 뒤처짐 판정이 뒤집힙니다." >&2
  exit 1
fi

log "## armed PR head 갱신"
log ""
log "기준 base: \`main\` @ \`${base_sha}\`"
log ""

numbers=()
if ! raw=$(gh api --paginate "repos/${REPO}/pulls?state=open&base=main&per_page=100" --jq '.[].number'); then
  echo "열린 PR 목록을 조회하지 못했습니다" >&2
  exit 1
fi
if [ -n "$raw" ]; then
  mapfile -t numbers <<<"$raw"
fi

if [ "${#numbers[@]}" -eq 0 ]; then
  log "열린 PR 0건 — 갱신할 것이 없습니다."
  emit "refreshed=[]"
  emit "refreshed_count=0"
  emit "skipped=[]"
  emit "unresolved=[]"
  emit "failed=[]"
  emit "failed_count=0"
  exit 0
fi

# 선별 조건은 셋이고 전부 이 함수 안에 있다. 조건을 넓히면 매 main push마다 열린 PR 전부의
# CI가 다시 돌아 소모가 커지므로 좁게 건다.
#
#   1) armed          `.auto_merge != null` — owner가 머지를 승인한 건만 건드린다
#   2) 충돌 아님       `.mergeable_state != "dirty"` — 충돌 건은 update-branch가 실패하고,
#                     해소는 developer 몫이다 (owner 리뷰 패스의 충돌 반송 경로가 담당한다)
#   3) 뒤처짐          compare API의 `behind_by > 0` — 이미 현재 main을 포함한 head를 갱신하면
#                     의미 없는 CI만 돈다
#
# 3)을 `mergeable_state == "behind"`로 재지 **않는** 이유: mergeStateStatus는 단일 값이고
# BLOCKED가 BEHIND보다 우선한다. 실측(#195) — PR #187은 `behind_by: 1`인데 `mergeable_state`는
# `blocked`였다. required check가 레드인 PR은 뒤처져 있어도 절대 `behind`로 보고되지 않으므로,
# 그 필드로 걸면 이 이슈가 풀려 하는 7건이 **한 건도** 선정되지 않는다.
#
# 반환값에 기대지 않고 모든 실패를 분류 문자열로 되돌린다 — 함수를 조건문의 피연산자로 부르면
# bash가 함수 본문 전체에서 errexit을 끄기 때문이다 (#112 항목 4, recheck-select.sh와 같은 규율).
classify() {
  local n="$1" json fields armed draft state head attempt last=""
  local -a parsed

  for ((attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++)); do
    if ! json=$(gh api "repos/${REPO}/pulls/${n}"); then
      last="api-failed"
      sleep "$RETRY_SLEEP"
      continue
    fi

    # 타입까지 확인해서 뽑는다. 필드가 없을 때와 값이 있을 때를 구분하지 않으면 빈 문자열이
    # 상태로 위장한다. `auto_merge`는 **키의 존재**로 응답의 온전함을 보고, armed 여부는
    # 그 값이 null인지로 본다 — 키가 통째로 없는 응답을 "미승인"으로 단정하지 않는다.
    if ! fields=$(jq -r '
          (if has("auto_merge") then (if .auto_merge == null then "false" else "true" end) else "" end),
          (if (.draft | type) == "boolean" then (.draft | tostring) else "" end),
          (if (.mergeable_state | type) == "string" then .mergeable_state else "" end),
          (if (.head.sha | type) == "string" then .head.sha else "" end)
        ' <<<"$json"); then
      last="bad-response"
      sleep "$RETRY_SLEEP"
      continue
    fi
    mapfile -t parsed <<<"$fields"
    armed="${parsed[0]:-}"
    draft="${parsed[1]:-}"
    state="${parsed[2]:-}"
    head="${parsed[3]:-}"

    if [ -z "$armed" ] || [ -z "$draft" ] || [ -z "$state" ] || [ -z "$head" ]; then
      last="bad-response"
      sleep "$RETRY_SLEEP"
      continue
    fi

    # 조건 1 — auto-merge가 걸리지 않은 PR은 아직 owner 승인 전이다.
    if [ "$armed" != "true" ]; then
      echo "skip:not-armed"
      return 0
    fi

    # 드래프트에는 auto-merge를 걸 수 없으므로 조건 1이 이미 걸러내지만, 응답이 그 조합을
    # 주면 손대지 않는다.
    if [ "$draft" = "true" ]; then
      echo "skip:draft"
      return 0
    fi

    # mergeable_state가 unknown이면 GitHub이 머지 가능성을 아직 계산 중이라 조건 2를 판단할 수
    # 없다(이 GET이 계산을 촉발한다). 계산 중을 "충돌 아님"으로 단정하지 않는다.
    if [ "$state" = "unknown" ]; then
      last="mergeability-unknown"
      sleep "$RETRY_SLEEP"
      continue
    fi

    # 조건 2 — 충돌 건.
    if [ "$state" = "dirty" ]; then
      echo "skip:conflict"
      return 0
    fi

    # 조건 3 — 현재 main을 이미 포함하고 있는가. compare는 병합 기준(merge base) 대비로 세므로
    # `behind_by`는 "head에 없는 main 커밋 수"다.
    local cmp behind
    if ! cmp=$(gh api "repos/${REPO}/compare/${base_sha}...${head}"); then
      last="compare-failed"
      sleep "$RETRY_SLEEP"
      continue
    fi
    if ! behind=$(jq -r 'if (.behind_by | type) == "number" then (.behind_by | tostring) else "" end' <<<"$cmp"); then
      last="bad-compare"
      sleep "$RETRY_SLEEP"
      continue
    fi
    if [ -z "$behind" ]; then
      last="bad-compare"
      sleep "$RETRY_SLEEP"
      continue
    fi
    if [ "$behind" -eq 0 ]; then
      echo "skip:up-to-date"
      return 0
    fi

    # 갱신 대상. head SHA를 함께 넘겨 아래 update-branch가 **여기서 본 head**에만 걸리게 한다.
    echo "run:${head}"
    return 0
  done

  case "$last" in
    # 계산 중 상태가 끝까지 안 풀린 것은 GitHub 쪽 지연이다 — 다음 main push에서 다시 본다.
    mergeability-unknown) echo "skip:mergeability-unknown" ;;
    *) echo "error:classify-${last:-failed}" ;;
  esac
}

refreshed=()
skipped=()
unresolved=()
failed=()

for n in "${numbers[@]}"; do
  reason=$(classify "$n")
  case "$reason" in
    run:*)
      head_sha="${reason#run:}"
      # expected_head_sha로 읽기-쓰기 쌍을 묶는다. 분류와 이 호출 사이에 head가 움직였다면
      # (개발자가 push했거나 다른 실행이 이미 갱신했다면) 그 갱신은 우리가 판단한 head가
      # 아니므로 422로 거절되는 편이 맞다 — 다음 main push에서 새 head로 다시 본다.
      if gh api -X PUT "repos/${REPO}/pulls/${n}/update-branch" \
        -f "expected_head_sha=${head_sha}" >/dev/null; then
        refreshed+=("$n")
        log "- #${n} → head 갱신 요청 (\`${head_sha}\`)"
      else
        failed+=("$n")
        log "- #${n} → ⚠️ head 갱신 실패 (\`${head_sha}\`)"
      fi
      ;;
    skip:*)
      skipped+=("$n")
      log "- #${n} → 건너뜀 (${reason#skip:})"
      ;;
    *)
      # 분류 실패는 "대상 아님"이 아니다. 갱신되지 않은 채 남으므로 드러나게 적는다.
      unresolved+=("$n")
      log "- #${n} → 분류 실패 (${reason}) — 이번 회차에는 갱신하지 않았습니다"
      echo "::warning::PR #${n}의 갱신 대상 여부를 판단하지 못했습니다 (${reason})"
      ;;
  esac
done

refreshed_json=$(to_json "${refreshed[@]+"${refreshed[@]}"}")
skipped_json=$(to_json "${skipped[@]+"${skipped[@]}"}")
unresolved_json=$(to_json "${unresolved[@]+"${unresolved[@]}"}")
failed_json=$(to_json "${failed[@]+"${failed[@]}"}")

emit "refreshed=${refreshed_json}"
emit "refreshed_count=$(jq -r 'length' <<<"$refreshed_json")"
emit "skipped=${skipped_json}"
emit "unresolved=${unresolved_json}"
emit "failed=${failed_json}"
emit "failed_count=$(jq -r 'length' <<<"$failed_json")"

# 갱신 실패도, 분류 실패도 침묵시키지 않는다. 둘 다 armed PR이 갱신되지 않은 채 남는다는
# 점에서 결과가 같다 — 이 잡은 어떤 머지도 게이팅하지 않으므로 레드로 남겨도 막히는 것이
# 없고, 다음 main push가 다시 시도한다. 원인이 다르므로 메시지는 구분해서 남긴다: failed는
# update-branch 호출 자체가 실패한 것이고, unresolved는 재시도를 다 써도 갱신 대상 여부조차
# 판단하지 못한 것이다 (classify()가 error:classify-*를 낸 경우 — skip:mergeability-unknown은
# GitHub이 계산 중인 정상 상태라 여기 포함되지 않는다).
exit_code=0
if [ "${#failed[@]}" -ne 0 ]; then
  echo "update-branch 호출이 실패한 PR이 있습니다: ${failed[*]}" >&2
  exit_code=1
fi
if [ "${#unresolved[@]}" -ne 0 ]; then
  echo "갱신 대상 여부를 판단하지 못한 PR이 있습니다: ${unresolved[*]}" >&2
  exit_code=1
fi
exit "$exit_code"
