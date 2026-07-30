#!/usr/bin/env bash
# recheck-open-prs.yml — 한 PR의 재검증 판정을 결과 파일로 확정한다.
#
# 워크플로 YAML에서 분리한 이유는 셸 테스트(recheck-verdict.test.sh)로 검증할 수 있게 하기
# 위함이다. #112 항목 1(false-green)이 바로 이 판정 로직에 있었다.
#
# **이 스크립트의 규율: 출력 부재를 특정 상태로 단정하지 않는다.**
# 선행 단계(pnpm/Node 셋업, 머지)가 실패하면 그 단계의 출력이 비는데, 예전 코드는
#   - 체크 status가 비면 else로 떨어져 "그린"으로,
#   - merge 출력이 비면 "현재 main과 충돌합니다"로
# 단정했다. 둘 다 "부재 ⇒ 불명(error)"으로 바꾼다. 그린은 체크가 실제로 green을 남겼을
# 때만 나온다.
#
# 입력(환경변수):
#   PR              PR 번호
#   MERGE_RESULT    머지 단계의 outputs.outcome — merged | conflict | (빈 값)
#   MERGE_OUTCOME   머지 단계의 steps.<id>.outcome — success | failure | skipped
#   MERGE_SHA       러너에서 만든 머지 커밋 (있을 때)
#   HEAD_SHA        검증한 PR head 커밋 (있을 때)
#   CHECKS_STATUS   체크 단계의 outputs.status — green | red | (빈 값)
#   CHECKS_OUTCOME  체크 단계의 steps.<id>.outcome
#   FAILED          레드일 때 실패한 명령
#   OUT_DIR         result.json(+ checks.log)을 쓸 디렉터리
#   LOG             체크 출력 로그 경로 (있으면 OUT_DIR로 복사한다)
set -euo pipefail

: "${PR:?PR is required}"
: "${OUT_DIR:?OUT_DIR is required}"
MERGE_RESULT="${MERGE_RESULT:-}"
MERGE_OUTCOME="${MERGE_OUTCOME:-}"
MERGE_SHA="${MERGE_SHA:-}"
HEAD_SHA="${HEAD_SHA:-}"
CHECKS_STATUS="${CHECKS_STATUS:-}"
CHECKS_OUTCOME="${CHECKS_OUTCOME:-}"
FAILED="${FAILED:-}"

detail=""
case "$MERGE_RESULT" in
  conflict)
    verdict="conflict"
    ;;
  merged)
    case "$CHECKS_STATUS" in
      green) verdict="green" ;;
      red) verdict="red" ;;
      *)
        # 체크가 판정을 남기지 않았다. `Run repo checks`는 셋업 단계가 실패하면 스킵되고,
        # 그때 status는 빈 문자열이다 — 이것을 그린으로 읽으면 "한 번도 안 돌았다"가
        # "그린"이 된다 (#112 항목 1).
        verdict="error"
        detail="체크 단계가 판정을 남기지 않았습니다 (단계 결과: ${CHECKS_OUTCOME:-unknown}). pnpm/Node 셋업 같은 선행 단계가 실패하면 체크는 한 번도 돌지 않습니다."
        ;;
    esac
    ;;
  *)
    # 머지 단계가 outcome을 남기지 않았다 = 충돌이 아닌 이유로 죽었거나 아예 돌지 않았다
    # (예: git fetch 실패). 충돌로 단정하면 developer에게 없는 충돌을 고치라고 시킨다.
    verdict="error"
    detail="머지 단계가 결과를 남기지 않았습니다 (단계 결과: ${MERGE_OUTCOME:-unknown}). 충돌이 아닌 이유(git fetch/merge 오류 등)로 끝났을 때 이 경로로 옵니다 — 실행 로그를 확인하세요."
    ;;
esac

mkdir -p "$OUT_DIR"
jq -n \
  --argjson pr "$PR" \
  --arg verdict "$verdict" \
  --arg detail "$detail" \
  --arg failed "$FAILED" \
  --arg merge_sha "$MERGE_SHA" \
  --arg head_sha "$HEAD_SHA" \
  '{pr: $pr, verdict: $verdict, detail: $detail, failed: $failed, merge_sha: $merge_sha, head_sha: $head_sha}' \
  >"${OUT_DIR}/result.json"

# 레드 보고에 붙일 출력 꼬리는 보고 잡으로 넘겨야 한다(같은 잡이 아니다).
if [ -n "${LOG:-}" ] && [ -f "$LOG" ]; then
  cp "$LOG" "${OUT_DIR}/checks.log"
fi

echo "PR #${PR} 판정: ${verdict}${detail:+ — ${detail}}"
