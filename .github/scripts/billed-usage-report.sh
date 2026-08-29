#!/usr/bin/env bash
# billed-usage-report.sh — Actions 청구를 벽시계가 아니라 "청구된 잡 수" 기준으로
# 워크플로별로 집계한다 (#480, #478 조각 2/2).
#
# 배경: GitHub Actions 과금은 잡 단위 1분 올림이다. 벽시계 합으로는 어느 워크플로를
# 손대야 하는지 순위조차 뒤집힌다 — 매트릭스가 펴진 워크플로는 벽시계로는 작아 보여도
# 청구 잡 수는 클 수 있다. `GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing`이
# run 하나당 `billable.<OS>.jobs`(청구된 잡 수)와 `billable.<OS>.total_ms`를 준다 — 이
# 값을 run 목록 위에서 워크플로 이름별로 합산한다.
#
# CI에서 자동으로 돌리지 않는다 — 사람이 필요할 때 손으로 부르는 도구다. timing 호출은
# run 하나당 1회이므로 호출 수가 run 수에 비례한다. 측정 도구가 스스로 청구를 만들면
# 안 되므로 이 스크립트를 워크플로 파일에 엮지 않는다.
#
# 입력(환경변수):
#   REPO    owner/repo
# 인자:
#   --since YYYY-MM-DD   집계 시작일 (포함)
#   --until YYYY-MM-DD   집계 종료일 (포함)
# 출력: 워크플로 이름별 표 + 월 환산 청구 잡 수 추정치 (stdout).
# 종료 코드:
#   0  기간 전체를 완주했다.
#   1  인자 오류이거나 run 목록 조회 자체가 실패했다 — 부분 결과조차 없다.
#   2  run 목록은 얻었지만 도중에 timing 조회가 실패했다(레이트리밋 등) — 그때까지
#      모은 부분 결과를 냈다.
set -euo pipefail

: "${REPO:?REPO is required}"

SINCE=""
UNTIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since)
      SINCE="${2:?--since requires a value}"
      shift 2
      ;;
    --until)
      UNTIL="${2:?--until requires a value}"
      shift 2
      ;;
    *)
      echo "알 수 없는 인자: $1" >&2
      exit 1
      ;;
  esac
done

: "${SINCE:?--since YYYY-MM-DD가 필요합니다}"
: "${UNTIL:?--until YYYY-MM-DD가 필요합니다}"

for d in "$SINCE" "$UNTIL"; do
  if [[ ! "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "날짜는 YYYY-MM-DD 형식이어야 합니다: '${d}'" >&2
    exit 1
  fi
done

if ! since_epoch=$(date -d "$SINCE" +%s 2>/dev/null); then
  echo "--since 날짜를 해석하지 못했습니다: '${SINCE}'" >&2
  exit 1
fi
if ! until_epoch=$(date -d "$UNTIL" +%s 2>/dev/null); then
  echo "--until 날짜를 해석하지 못했습니다: '${UNTIL}'" >&2
  exit 1
fi

period_days=$(( (until_epoch - since_epoch) / 86400 ))
if [ "$period_days" -le 0 ]; then
  echo "--until은 --since보다 뒤여야 합니다 (since=${SINCE}, until=${UNTIL})" >&2
  exit 1
fi

echo "## Actions 청구 잡 수 집계 (${SINCE}..${UNTIL}, ${period_days}일)"
echo

if ! runs=$(gh api --paginate "repos/${REPO}/actions/runs?created=${SINCE}..${UNTIL}&per_page=100" |
  jq -s '[.[].workflow_runs[]?] | map({id, name})'); then
  echo "run 목록을 조회하지 못했습니다 (REPO=${REPO}, 기간=${SINCE}..${UNTIL})" >&2
  exit 1
fi

total_runs=$(jq 'length' <<<"$runs")
if [ "$total_runs" -eq 0 ]; then
  echo "이 기간에 run이 0건입니다."
  exit 0
fi

# 워크플로 이름별 누적치. ORDER는 처음 등장한 순서를 표에 그대로 반영하기 위한 것이다
# (연관배열은 순서를 보장하지 않는다).
declare -A SEEN=() NORMAL_RUNS=() PAUSED_RUNS=() JOBS_SUM=() MS_SUM=() WALL_MS_SUM=()
ORDER=()

ensure_order() {
  local name="$1"
  if [ -z "${SEEN[$name]:-}" ]; then
    SEEN[$name]=1
    ORDER+=("$name")
  fi
}

processed=0
partial=0
last_id=""

# 프로세스 치환(< <(...))으로 돌린다 — 파이프(| while)로 돌리면 루프가 서브셸에서 실행돼
# 위 연관배열에 쌓은 값이 루프가 끝나는 순간 사라진다.
while IFS=$'\t' read -r id name; do
  last_id="$id"
  if ! timing=$(gh api "repos/${REPO}/actions/runs/${id}/timing"); then
    echo "run ${id}(${name})의 timing 조회 실패 — 여기서 집계를 멈춥니다." >&2
    partial=1
    break
  fi

  ensure_order "$name"
  jobs=$(jq '[.billable[]?.jobs // 0] | add // 0' <<<"$timing")
  ms=$(jq '[.billable[]?.total_ms // 0] | add // 0' <<<"$timing")
  wall=$(jq '.run_duration_ms // 0' <<<"$timing")

  # total_ms=0은 잡이 시작되지 못한 run이다(과금 정지 구간 등). 0분으로 조용히 합산하면
  # "청구가 줄었다"는 착시가 나므로 별도 카운터로만 센다 — 정상 합계에 넣지 않는다.
  if [ "$ms" -eq 0 ]; then
    PAUSED_RUNS[$name]=$(( ${PAUSED_RUNS[$name]:-0} + 1 ))
  else
    NORMAL_RUNS[$name]=$(( ${NORMAL_RUNS[$name]:-0} + 1 ))
    JOBS_SUM[$name]=$(( ${JOBS_SUM[$name]:-0} + jobs ))
    MS_SUM[$name]=$(( ${MS_SUM[$name]:-0} + ms ))
    WALL_MS_SUM[$name]=$(( ${WALL_MS_SUM[$name]:-0} + wall ))
  fi

  processed=$((processed + 1))
done < <(jq -r '.[] | [.id, .name] | @tsv' <<<"$runs")

echo "| 워크플로 | 정상 실행 | 청구 잡 수 | 벽시계 분 | 과금정지 실행 |"
echo "|---|---:|---:|---:|---:|"

total_jobs=0
for name in "${ORDER[@]}"; do
  n="${NORMAL_RUNS[$name]:-0}"
  j="${JOBS_SUM[$name]:-0}"
  w="${WALL_MS_SUM[$name]:-0}"
  p="${PAUSED_RUNS[$name]:-0}"
  wall_min=$(awk -v ms="$w" 'BEGIN{printf "%.1f", ms/60000}')
  echo "| ${name} | ${n} | ${j} | ${wall_min} | ${p} |"
  total_jobs=$((total_jobs + j))
done

echo
echo "청구 잡 수 합계(과금 정지 run 제외): ${total_jobs}"
echo
monthly=$(awk -v jobs="$total_jobs" -v days="$period_days" 'BEGIN{printf "%.1f", jobs/days*30}')
echo "월 환산 청구 잡 수 추정치 = ${total_jobs} / ${period_days}일 × 30일 = ${monthly}"
echo
echo "* 과금정지 실행 열은 total_ms=0(잡이 시작되지 못한 run)의 건수다 — 0분으로 합산하지"
echo "  않고 별도로 뺐다. 이 구간이 정상 구간과 섞이면 청구가 준 것처럼 보이는 착시가 난다."

if [ "$partial" -eq 1 ]; then
  echo
  echo "부분 결과: 전체 ${total_runs}건 중 ${processed}건까지 집계를 완료했습니다" \
    "(run id ${last_id}에서 timing 조회가 실패해 중단했습니다)." >&2
  exit 2
fi

exit 0
