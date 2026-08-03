#!/usr/bin/env bash
# recheck-open-prs.yml — 재검증 결과를 PR 코멘트 하나로 upsert한다.
#
# 워크플로 YAML에서 분리한 이유는 셸 테스트(recheck-report.test.sh)로 검증할 수 있게 하기
# 위함이다. 이 스크립트는 `pull-requests: write` 토큰을 쥐는 유일한 지점이므로 PR에서 온
# 코드를 돌리는 잡과 **분리된 잡**에서만 실행된다 (#112 항목 5).
#
# 코멘트를 쓰기 전에 대상 PR의 현재 head와 현재 main을 조회한다 — 낡은 판정이 최신 판정을
# 덮지 않게 하기 위함이다(current_head · current_main 참조). 그래서 이 스크립트에는 PR·커밋
# 읽기 권한도 필요하다.
#
# 입력(환경변수):
#   REPO           owner/repo
#   PRS            코멘트를 남길 PR 번호 JSON 배열
#   UNVERIFIED     그중 대상 선정 단계에서 분류에 실패한 PR 번호 JSON 배열 (기본 [])
#   RESULTS_DIR    recheck-result-<PR><RESULT_SUFFIX>/result.json 들이 풀려 있는 디렉터리
#                  (기본 results)
#   RESULT_SUFFIX  판정 아티팩트 이름의 PR 번호 뒤에 붙는 접미사 (기본 없음).
#                  워크플로는 시도별로 갈린 이름(-attempt-<run_attempt>)을 쓴다.
#   BASE_SHA       검증 기준 main 커밋
#   BASE_REF       BASE_SHA의 신선도를 대조할 브랜치 (기본 main)
#   NO_RESULT_DETAIL
#                  판정 파일이 없을 때 본문에 적을 원인 (기본: 재검증 잡이 결과를 남기지 못함).
#                  discover 실패 폴백 경로가 자기 원인으로 덮어쓴다.
#   AUTHORITATIVE  이 보고가 실제로 검증을 시도한 잡의 것인가 (기본 1).
#                  discover 실패 폴백 경로만 0을 준다 — 그 잡은 어떤 head·base를 검증할지조차
#                  정하지 못한 채 돌기 때문이다 (#152). 0이면 게이트 코멘트가 이미 있는 한
#                  판정 종류와 무관하게 PATCH하지 않는다 (#183 — report_one 참조).
#   RUN_URL        워크플로 실행 URL
#   BOT_LOGIN      게이트 코멘트의 작성자로 인정할 로그인 (기본 github-actions[bot])
set -euo pipefail

: "${REPO:?REPO is required}"
: "${PRS:?PRS is required}"
: "${RUN_URL:?RUN_URL is required}"
RESULTS_DIR="${RESULTS_DIR:-results}"
RESULT_SUFFIX="${RESULT_SUFFIX:-}"
UNVERIFIED="${UNVERIFIED:-[]}"
BASE_SHA="${BASE_SHA:-}"
BASE_REF="${BASE_REF:-main}"
NO_RESULT_DETAIL="${NO_RESULT_DETAIL:-재검증 잡이 결과를 남기지 못했습니다 (잡 실패·취소 또는 아티팩트 누락).}"
AUTHORITATIVE="${AUTHORITATIVE:-1}"
# 게이트로 인정할 코멘트의 작성자. 마커는 워크플로 파일에 평문으로 있고 이 리포에는
# 에이전트가 CI 코멘트를 인용하는 관례가 있다 — 작성자를 확인하지 않으면 인용 코멘트가
# 게이트를 영구히 가로챈다 (#112 항목 2).
BOT_LOGIN="${BOT_LOGIN:-github-actions[bot]}"
MARKER='<!-- recheck-open-prs -->'
# 게이트가 아닌 알림 코멘트의 마커. 폴백 보고가 확정 판정을 덮지 않으면서도 침묵하지 않기 위해
# 쓴다 (#152). **이 문자열은 MARKER를 부분문자열로 포함하지 않는다** — `<!-- recheck-open-prs`
# 뒤가 `-notice -->`라 `<!-- recheck-open-prs -->`와 겹치지 않는다. 겹치면 find_existing이 이
# 알림을 게이트 코멘트로 오인하므로(#112 항목 2와 같은 고장), 이 마커를 고칠 때 함께 확인한다.
NOTICE_MARKER='<!-- recheck-open-prs-notice -->'

log() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# 마커를 포함하고 **봇이 작성한** 코멘트만 고른다. 봇 코멘트는 한 번 만든 뒤 PATCH로만
# 갱신되어 위치가 고정되므로 가장 이른 것(first)을 대상으로 삼는다 — 예전 코드의 `last`는
# "나중에 달린 아무 일치 코멘트가 항상 이긴다"는 뜻이었다.
#
# 출력은 `<코멘트 id><TAB><판정 종류>` 한 줄이고, 없으면 아무것도 출력하지 않는다.
# 판정 종류는 report_one이 폴백(AUTHORITATIVE=0) 판단에 더는 쓰지 않는다(#183 항목 ① —
# 게이트 존재 자체로 가른다) — 여기서 읽는 값은 이제 알림 코멘트에 "기존 판정이 무엇이었는지"
# 사람에게 보여주는 표시용이다. 그래도 오독은 여전히 피해야 한다(오독된 라벨이 알림에 실린다).
# 읽는 순서 (#152):
#   1. 게이트 마커 **바로 다음 줄**의 `<!-- recheck-verdict:<종류> -->` 마커 (build_body가
#      심는다). 이 줄만 본다 — 본문 전체를 `scan`하면 레드 본문 뒤쪽에 실리는 체크 출력
#      꼬리(마지막 3000바이트)에 우연히 같은 모양의 문자열이 섞였을 때 그것을 마커로
#      오인한다(#183 항목 ②, 이 리포의 체크 출력엔 recheck-report.test.sh의 픽스처
#      문자열이 실릴 수 있다). 값은 build_body의 5종(green|red|conflict|stale|error)
#      화이트리스트로 걸러 벗어나면 `unknown`으로 정규화한다 — 화이트리스트가 없으면
#      임의의 철자가 판정 종류로 그대로 통과했다.
#   2. 마커가 없는 옛 코멘트는 **헤드라인의 이모지**로 읽는다. 헤드라인 = 게이트 마커 줄의
#      나머지, 비어 있으면 그 다음의 첫 비주석·비공백 줄. 본문 전체를 훑지 않는 이유는
#      1번과 같다.
#   3. 둘 다 실패하면 `unknown`.
find_existing() {
  local pr="$1" marker="$2"
  gh api --paginate "repos/${REPO}/issues/${pr}/comments?per_page=100" |
    jq -s -r --arg m "$marker" --arg bot "$BOT_LOGIN" '
      def trim: sub("^\\s+"; "") | sub("\\s+$"; "");
      def marker_lines($b):
        ($b | split("\n")) as $ls
        | {ls: $ls, mk: ([$ls | to_entries[] | select(.value | contains($m))] | first)};
      def headline($ml):
        ($ml.mk) as $mk
        | if $mk == null then ""
          else
            (($mk.value | split($m) | .[1] // "") | trim) as $rest
            | if $rest != "" then $rest
              else
                ([$ml.ls[($mk.key + 1):][] | select((trim != "") and (trim | startswith("<!--") | not))]
                 | first // "")
              end
          end;
      # 판정 마커는 게이트 마커 **바로 다음 줄**만 본다(build_body가 그 자리에 심는다).
      # 본문 전체를 scan하면 레드 본문 뒤쪽의 체크 출력 꼬리(마지막 3000바이트)에 우연히
      # 같은 모양의 문자열이 섞였을 때 그것을 마커로 오인한다 (#183 항목 ②).
      def verdict_marker($ml):
        ($ml.mk) as $mk
        | if $mk == null then null
          else
            ($ml.ls[$mk.key + 1] // "") as $next
            | ([$next | scan("<!-- recheck-verdict:([a-zA-Z0-9_-]+) -->")] | first) as $cap
            | if $cap == null then null else $cap[0] end
          end;
      def verdict_of($b):
        marker_lines($b) as $ml
        | (verdict_marker($ml)) as $tag
        | if $tag != null then
            # build_body가 심는 값은 5종뿐이다. 그 밖의 철자(오타·미래에 추가된 종류 등)를
            # 그대로 판정 종류로 통과시키면 안 된다 — 화이트리스트를 벗어나면 unknown으로
            # 정규화한다 (#183 항목 ②).
            (if ($tag | test("^(green|red|conflict|stale|error)$")) then $tag else "unknown" end)
          else
            (headline($ml)) as $h
            | if ($h | contains("🟢")) then "green"
              elif ($h | contains("🔴")) then "red"
              elif ($h | contains("⚠️")) then "conflict"
              elif ($h | contains("⛔")) then "stale"
              else "unknown"
              end
          end;
      (add // [])
      | map(select(((.user.login // "") == $bot) and ((.body // "") | contains($m))))
      | first
      | if . == null then empty
        else [(.id | tostring), verdict_of(.body // "")] | @tsv
        end'
}

verdict_label() {
  case "$1" in
    green) echo "🟢 그린" ;;
    red) echo "🔴 레드" ;;
    conflict) echo "⚠️ 충돌" ;;
    stale | error) echo "⛔ 판정 불가" ;;
    unknown) echo "판독하지 못함 (확정 판정일 수 있어 그대로 두었습니다)" ;;
    *) echo "확인하지 못함 (기존 코멘트 조회 실패)" ;;
  esac
}

# 이 판정이 **지금의** PR head 기준인지 확인한다. main push 스윕(github.ref=refs/heads/main)과
# 같은 PR의 synchronize 실행(refs/pull/N/merge)은 concurrency 그룹이 달라 서로를 취소하지
# 못한다. 스윕은 열린 PR 전체를 매트릭스로 돌아 더 느리므로, 늦게 끝난 스윕이 낡은 head의
# 판정으로 최신 판정을 덮어쓸 수 있다 (#112 리뷰 1번 — 이 워크플로가 새로 만든 false-green).
# 실패하면 빈 문자열을 돌려준다 = "확인 불가"이고, 확인 불가는 그린이 아니다.
current_head() {
  local pr="$1" sha
  if ! sha=$(gh api "repos/${REPO}/pulls/${pr}" --jq '.head.sha'); then
    return 0
  fi
  # 개행·공백이 섞여 오면 비교가 어긋난다. SHA 모양이 아니면 확인 불가로 다룬다.
  sha="$(tr -d '[:space:]' <<<"$sha")"
  if [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "$sha"
  fi
}

# 이 판정이 **지금의** main 기준인지 확인한다. head 가드(current_head)와 짝이고, 막는 것은
# 다음 전개다 (#119 Codex 1번 — head만 보면 통과한다):
#   T1 PR N의 synchronize 실행이 base A로 검증을 시작한다 → 그린
#   T2 main에 push → 스윕이 base B로 같은 PR을 검증한다 → 레드 (새 main이 이 PR을 깨뜨린다)
#   T3 스윕이 먼저 끝나 마커 코멘트를 🔴로 PATCH             (base B — 최신)
#   T4 더 느린 synchronize 실행이 같은 코멘트를 🟢로 PATCH   (base A — 낡음)
# head는 T1~T4 내내 그대로이므로 head 가드는 통과한다. concurrency 그룹이 갈려
# (recheck-open-prs-${github.ref}) 두 실행은 서로를 취소하지도 못한다.
#
# 실패하면 빈 문자열을 돌려준다 = "확인 불가"이고, 확인 불가는 그린이 아니다.
# 호출부는 이 값을 실행 시작 시점에 한 번만 구한다(CURRENT_MAIN) — PR마다 다시 물으면 보고
# 도중 main이 움직였을 때 같은 스윕 안에서 PR별로 다른 기준이 적용된다.
current_main() {
  local sha
  if ! sha=$(gh api "repos/${REPO}/commits/${BASE_REF}" --jq '.sha'); then
    return 0
  fi
  sha="$(tr -d '[:space:]' <<<"$sha")"
  if [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "$sha"
  fi
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
  local kind

  # 판정 종류를 기계적으로 읽을 수 있게 마커로 심는다 (#152). 아래 case와 갈리지 않도록
  # 알 수 없는 값은 여기서도 error로 모은다 — case의 `*` 분기가 쓰는 이름과 같다.
  case "$verdict" in
    green | red | conflict | stale) kind="$verdict" ;;
    *) kind="error" ;;
  esac

  echo "🤖 [ci]"
  echo
  echo "$MARKER"
  echo "<!-- recheck-verdict:${kind} -->"
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
    stale)
      # 낡은/확인 불가 head 또는 base의 판정. 그린도 레드도 아니고, 무엇보다 **그린이 아니다**.
      # 어느 쪽이 어긋났는지는 아래 detail이 밝힌다.
      echo "⛔ **판정 불가 — 이 재검증 결과가 현재 PR head·현재 \`main\` 기준인지 확인되지 않습니다.**"
      echo
      echo "**이 코멘트는 그린도 레드도 아닙니다.** 재검증에 쓰인 PR head 또는 base가 현재의 것과"
      echo "다르거나 확인되지 않아, 이 결과를 현재 상태의 근거로 삼을 수 없습니다."
      if [ -n "$detail" ]; then
        echo
        echo "원인: ${detail}"
      fi
      echo
      echo "현재 head에 대한 재검증은 head 갱신(\`synchronize\`)이나 다음 \`main\` push에서 다시"
      echo "돌고, 그 결과가 이 코멘트를 갱신합니다."
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

# 폴백 보고(AUTHORITATIVE=0)가 확정 판정을 덮지 않을 때 남기는 알림. 게이트 마커를 심지
# 않으므로 판정 신호는 마커 코멘트 하나로 유지되고(CONTRIBUTING.md "낡은 그린 체크 재검증"),
# 동시에 discover 실패가 "코멘트 없음"으로 끝나지도 않는다 (#125 항목 3).
build_notice_body() {
  local kept="$1" detail="$2"

  echo "🤖 [ci]"
  echo
  echo "$NOTICE_MARKER"
  echo "⚠️ **재검증 대상 선정(\`discover\`) 잡이 실패해 이번 실행은 이 PR을 판정하지 못했습니다.**"
  echo
  echo "이 실행은 어떤 PR head·base로 검증할지조차 정하지 못했으므로 **판정하지 않았습니다.**"
  echo "그래서 이 PR의 재검증 게이트 코멘트를 덮지 않았습니다 (기존 판정: ${kept}) —"
  echo "판정하지 않은 실행이 판정한 실행의 결과를 지우지 않게 하기 위함입니다."
  echo
  echo "**읽는 법:** 머지 판단의 근거는 여전히 재검증 게이트 코멘트 하나입니다. 이 코멘트는"
  echo "판정이 아니며 그린도 레드도 아닙니다 — 게이트 코멘트의 판정이 **이 실행보다 앞선"
  echo "실행에서 나온 것**임을 알릴 뿐입니다. 게이트 코멘트가 레드·판정 불가면 종전대로"
  echo "머지하지 마세요. 게이트 코멘트가 그린이더라도 그것은 이 실행이 확인한 그린이 아니므로,"
  echo "머지 전에 재검증을 다시 돌리거나 PR head를 갱신해 최신 판정을 받으세요."
  echo
  if [ -n "$detail" ]; then
    echo "- 원인: ${detail}"
  fi
  echo "- 실행 로그: ${RUN_URL}"
}

# 게이트 코멘트를 건드리지 않았음을 알린다. 알림 자체도 upsert라 실행마다 쌓이지 않는다.
notify_not_authoritative() {
  local pr="$1" existing="$2" existing_class="$3" detail="$4"
  local body="${TMPDIR:-/tmp}/recheck-notice-${pr}.md"
  local nline="" nid=""

  if [ -n "$existing" ]; then
    log "- #${pr}: 판정하지 않은 폴백 보고이므로 기존 확정 판정 코멘트 ${existing}(${existing_class})를 덮지 않았습니다"
  else
    log "- #${pr}: 판정하지 않은 폴백 보고인데 기존 코멘트를 확인하지 못해 게이트 코멘트를 건드리지 않았습니다"
  fi

  if ! build_notice_body "$(verdict_label "$existing_class")" "$detail" >"$body"; then
    log "- #${pr}: 알림 코멘트 본문 생성 실패"
    return 1
  fi

  # 알림 코멘트 조회에 실패하면 중복을 감수하고 새로 남긴다 — 침묵이 더 나쁘다.
  if ! nline=$(find_existing "$pr" "$NOTICE_MARKER"); then
    nline=""
  fi
  IFS=$'\t' read -r nid _ <<<"$nline" || true

  if [ -n "$nid" ]; then
    if gh api --silent --method PATCH "repos/${REPO}/issues/comments/${nid}" -F "body=@${body}"; then
      log "- #${pr}: 알림 코멘트 ${nid} 갱신"
      return 0
    fi
    log "- #${pr}: 알림 코멘트 ${nid} 갱신 실패 — 새 코멘트로 폴백합니다"
  fi

  post_new "$pr" "$body"
  return $?
}

# 실패를 반환코드로만 알리지 않는다 — 이 함수는 `if !`로 호출되므로 본문에서 errexit이
# 꺼진다(recheck-select.sh의 classify와 같은 이유). 모든 실패를 명시적으로 검사한다.
report_one() {
  local pr="$1"
  local dir="${RESULTS_DIR}/recheck-result-${pr}${RESULT_SUFFIX}"
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
      detail="$NO_RESULT_DETAIL"
    fi
  fi

  local existing_line existing existing_class
  if ! existing_line=$(find_existing "$pr" "$MARKER"); then
    # 조회에 실패하면 기존 코멘트 유무를 알 수 없다. 보고가 사라지는 쪽보다 중복되는 쪽이
    # 안전하다 — "코멘트 없음"은 CONTRIBUTING.md 기준으로 통과이기 때문이다.
    log "- #${pr}: 기존 코멘트 조회 실패 — 새 코멘트로 남깁니다"
    existing_line=""
    force_new=1
  fi
  # find_existing은 id와 판정 종류를 탭으로 붙여 한 줄로 준다. 코멘트가 없으면 빈 줄이라
  # 둘 다 빈 값이 되고, 있으면 판정 종류는 절대 비지 않는다(최소 `unknown`) — 빈 필드가
  # 접혀 값이 밀리는 문제(report_one 위쪽 @tsv 주석 참조)가 생기지 않는다.
  IFS=$'\t' read -r existing existing_class <<<"$existing_line" || true

  # 이 보고가 **판정한 잡의 것인가.** discover 실패 폴백(AUTHORITATIVE=0)은 어떤 head·base로
  # 검증할지조차 정하지 못한 채 도는 잡이다. 그 잡의 "판정 불가"가 겹친 다른 실행(push 스윕과
  # pull_request 실행은 concurrency 그룹이 갈려 서로를 취소하지 못한다)이 방금 남긴 확정
  # 판정을 덮으면, 판정하지 않은 잡이 판정한 잡의 결과를 지우는 것이 된다 (#152):
  #   T1 push 스윕이 PR N을 검증 → 🔴로 마커 PATCH
  #   T2 PR N에 synchronize → 그 실행의 discover가 죽는다
  #   T3 폴백이 같은 마커를 ⛔ 판정 불가로 PATCH   ← 여기를 막는다
  # 대신 침묵하지 않는다 — 게이트 마커가 없는 별도 알림 코멘트를 남긴다 (#125 항목 3).
  #
  # 예전에는 이 판단을 existing_class(위에서 읽은 판정 종류)가 "확정"인지로 갈랐다
  # (green|red|conflict|unknown 이면 지키고, stale|error면 종전대로 덮었다). 그런데
  # existing_class는 **이 GET 시점의 스냅샷**이다. GET 당시 stale/error였다가 그 직후
  # 겹친 authoritative 실행이 같은 코멘트를 확정 판정(red 등)으로 PATCH하면, 이 폴백은
  # 자신이 든 낡은 스냅샷(stale/error)을 근거로 그 확정 판정을 다시 덮어써 버린다 — T1-T3와
  # 같은 재전개다 (#183 항목 ①). 판정 종류로 가르는 한 이 창은 구조적으로 남는다.
  #
  # 그래서 판정 종류를 아예 보지 않는다: 게이트 코멘트가 **존재하기만 하면**(판정 종류
  # 무관, 조회 실패로 유무를 모를 때도) 폴백은 그것을 절대 PATCH하지 않고 알림만 남긴다.
  # 게이트가 **없을 때만** 아래로 내려가 처음 코멘트를 남긴다 — 그 경로엔 덮어쓸 기존
  # 판정이 없으므로 이 레이스가 성립하지 않는다.
  if [ "$AUTHORITATIVE" != "1" ] && { [ "$force_new" -eq 1 ] || [ -n "$existing" ]; }; then
    notify_not_authoritative "$pr" "$existing" "$existing_class" "$detail"
    return $?
  fi

  # 판정을 쓰기 전에 "이 판정이 최신 head 기준인가"를 확인한다. 세 갈래로 나뉜다:
  #   일치     — 그대로 보고한다
  #   불일치   — 이 판정은 낡았다. 기존 코멘트를 **덮지 않는다**(최신 head의 판정이 이미 거기
  #              있을 수 있고, 낡은 그린이 그것을 덮는 것이 바로 이 결함이다). 기존 코멘트가
  #              없으면 침묵하지 않고 "판정 불가"로 남긴다 — 코멘트 없음은 통과로 읽힌다.
  #   확인 불가 — 현재 head를 조회하지 못했거나 판정에 head가 없다. 그린으로 단정하지 않고
  #              "판정 불가"로 강등한다. 레드·충돌·판정 불가는 그대로 둔다(그린으로 덮는
  #              경로만 막으면 되고, 막는 쪽이 보수적이다).
  local current
  current=$(current_head "$pr")
  if [ -n "$current" ] && [ -n "$head_sha" ] && [ "$current" != "$head_sha" ]; then
    if [ -n "$existing" ]; then
      log "- #${pr}: 검증한 head(\`${head_sha}\`)가 현재 head(\`${current}\`)와 달라 기존 코멘트 ${existing}를 덮지 않았습니다 (${verdict})"
      return 0
    fi
    verdict="stale"
    detail="이 재검증은 PR head \`${head_sha}\` 기준인데 현재 head는 \`${current}\`입니다 — 판정이 낡았습니다."
  elif [ -z "$current" ] || [ -z "$head_sha" ]; then
    if [ "$verdict" = "green" ]; then
      verdict="stale"
      detail="현재 PR head를 확인하지 못해(조회 실패 또는 판정에 head 없음) 이 그린이 최신 head 기준인지 알 수 없습니다."
    fi
  fi

  # 같은 질문을 base에 대해서도 한다: 이 판정이 **지금의** main 기준인가 (current_main의
  # T1–T4 참조). head 가드와 갈라지는 점이 하나 있다 — **그린에만** 적용한다.
  #
  #   왜 그린에만인가. 이 가드가 막는 고장은 "낡은 base의 그린이 최신 base의 레드를 덮는다"
  #   하나뿐이다. 낡은 base의 레드·충돌은 그 고장이 아니고, 그것을 강등하면 게이트가 근거를
  #   잃기만 한다 (레드 과잉 강등 금지 — PR #119 라운드 2에서 확정한 규율).
  #
  #   왜 게이트가 상시 침묵하지 않는가. base가 낡는 원인은 오직 main push이고, 그 push가 곧
  #   열린 PR 전체를 도는 새 스윕을 띄운다. 그 스윕의 base는 자기 push의 sha이고
  #   cancel-in-progress가 앞선 스윕을 취소하므로 신선하다. 즉 이 가드가 발동할 때는 신선한
  #   판정이 이미 쓰였거나 곧 쓰인다 — 가드는 그 신선한 판정을 낡은 그린이 덮는 것만 막는다.
  #   신선한 base의 실행은 이 분기에 들어오지 않으므로 정상 운영에서 판정이 강등되지 않는다.
  if [ "$verdict" = "green" ]; then
    if [ -n "$CURRENT_MAIN" ] && [ -n "$BASE_SHA" ] && [ "$CURRENT_MAIN" != "$BASE_SHA" ]; then
      if [ -n "$existing" ]; then
        # 기존 코멘트에 최신 base의 판정이 이미 있을 수 있다. 낡은 그린으로 덮지 않는다.
        log "- #${pr}: 검증 base(\`${BASE_SHA}\`)가 현재 ${BASE_REF}(\`${CURRENT_MAIN}\`)와 달라 기존 코멘트 ${existing}를 덮지 않았습니다 (green)"
        return 0
      fi
      # 기존 코멘트가 없으면 침묵이 곧 통과다 (CONTRIBUTING.md). 판정 불가로 남긴다.
      verdict="stale"
      detail="이 재검증은 base \`${BASE_SHA}\` 기준인데 현재 \`${BASE_REF}\`는 \`${CURRENT_MAIN}\`입니다 — 판정이 낡았습니다."
    elif [ -z "$CURRENT_MAIN" ] || [ -z "$BASE_SHA" ]; then
      verdict="stale"
      detail="현재 \`${BASE_REF}\` 커밋을 확인하지 못해(조회 실패 또는 base 없음) 이 그린이 최신 base 기준인지 알 수 없습니다."
    fi
  fi

  local body="${TMPDIR:-/tmp}/recheck-body-${pr}.md"
  if ! build_body "$verdict" "$detail" "$failed" "$merge_sha" "$head_sha" "$logfile" >"$body"; then
    log "- #${pr}: 코멘트 본문 생성 실패"
    return 1
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

# 현재 main은 실행당 한 번만 조회한다 (current_main 참조).
CURRENT_MAIN="$(current_main)"

overall=0
for pr in $prs_list; do
  if ! report_one "$pr"; then
    overall=1
  fi
done
exit "$overall"
