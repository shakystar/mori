#!/usr/bin/env bash
# citation-extract.mjs 테스트 — 추출기가 **어떤 형태를 인용으로 보는가**의 정본이다 (#322).
#
# 검사하는 것은 추출 함수의 동작뿐이다: 형태 하나를 넣고, 대상 파일이 무엇으로 풀리는지
# (또는 뽑히지 않는지)를 본다. 워크플로 YAML이나 코멘트 본문 문자열은 검사하지 않는다
# (TESTING.md의 금지 패턴). 코멘트가 생기는지/안 생기는지는 이슈 완료 조건의 재현 실행이
# 판정한다.
#
# 케이스 ①~⑧은 #322 완료 조건의 8케이스고, 마지막 「명세 경계」는 PR #337 승인이 #322로
# 이관한 항목이다 — "무엇이 줄 인용 형태인가"의 경계를 사람의 읽기가 아니라 코드가 들고
# 있게 한다.
set -uo pipefail

SUITE_NAME="citation-extract"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${DIR}/_test-lib.sh"

# 픽스처 트리: 인용이 적히는 파일 하나(packages/kernel/src/source.ts)와, 인용이 가리킬 수
# 있는 실물 몇 개. 대상 해석이 실제 트리를 보므로 실물이 있어야 한다.
make_fixture() {
  local dir
  dir="$(mktemp -d "${SANDBOX}/fixture-XXXXXX")"
  mkdir -p "${dir}/packages/kernel/src/services" "${dir}/node_modules/pkg" "${dir}/dist"
  : >"${dir}/packages/kernel/src/file.ts"
  : >"${dir}/packages/kernel/src/services/consolidate-service.ts"
  : >"${dir}/node_modules/pkg/index.js"
  : >"${dir}/dist/agent-loop.js"
  # 루트 README.md. ㉠c는 리포 루트 상대로만 풀리므로 이 파일이 대상이다.
  seq 200 >"${dir}/README.md"
  printf '// %s\n' "$@" >"${dir}/packages/kernel/src/source.ts"
  echo "$dir"
}

extract() {
  node "${DIR}/citation-extract.mjs" --root "$1" --format json
}

# PR이 만진 파일 목록을 만들고 그 경로를 낸다.
changed_list() {
  local f
  f="$(mktemp "${SANDBOX}/changed-XXXXXX")"
  printf '%s\n' "$@" >"$f"
  echo "$f"
}

extract_changed() {
  node "${DIR}/citation-extract.mjs" --root "$1" --changed "$2" --format json
}

# 뽑힌 인용을 `<대상>:<줄>[-<끝줄>]` 한 줄짜리 요약으로 접는다 (없으면 빈 문자열).
targets() {
  jq -r '.citations | map("\(.target):\(.targetLine)\(if .targetEndLine then "-\(.targetEndLine)" else "" end)") | join(" ")'
}

setup_sandbox

it "① ㉠a — 파일명 + 단일 줄은 대상 파일 하나로 뽑힌다"
assert_eq "packages/kernel/src/file.ts:10" \
  "$(extract "$(make_fixture 'guard mirrors file.ts:10')" | targets)"

it "② ㉠b — 파일명 + 범위도 같은 대상으로 뽑힌다"
assert_eq "packages/kernel/src/file.ts:10-20" \
  "$(extract "$(make_fixture 'guard mirrors file.ts:10-20')" | targets)"

# 픽스처의 줄 번호는 착수 시점 packages/의 실물 인용(README.md:140-142)에서 가져왔다.
# 확장자만 뗀 형태가 ㉠c다 — 조각1이 packages/의 ㉠c를 0건으로 만들었지만, 그 형태가 다시
# 들어올 때 조용히 놓치지 않도록 추출기는 계속 받는다.
it "③ ㉠c — 확장자 없는 허용 목록 이름은 리포 루트 상대의 README.md로 풀린다"
assert_eq "README.md:140-142" \
  "$(extract "$(make_fixture 'read-only turn guarantee: README:140-142')" | targets)"

it "④ ㉡a — 파일명 없는 줄 참조는 뽑히지 않는다"
assert_eq "" "$(extract "$(make_fixture 'the early return (`:2920`) does this')" | targets)"

it "⑤ ㉡d — 쉼표 이어쓰기는 두 건으로 뽑히고 둘 다 머리 토큰의 대상을 받는다"
assert_eq "packages/kernel/src/file.ts:10 packages/kernel/src/file.ts:20" \
  "$(extract "$(make_fixture 'see file.ts:10, 20')" | targets)"

it "⑥ 외부 경로 — node_modules/·dist/ 아래는 뽑히지 않는다"
assert_eq "" \
  "$(extract "$(make_fixture 'node_modules/pkg/index.js:10 and dist/agent-loop.js:180-182')" | targets)"

it "⑥' 외부 경로는 미해결로도 남지 않는다 (판정이 끝난 비인용이다)"
assert_eq "0" \
  "$(extract "$(make_fixture 'node_modules/pkg/index.js:10 and dist/agent-loop.js:180-182')" | jq '.unresolved | length')"

it "⑦ 이슈 참조 — #189는 뽑히지 않는다"
assert_eq "" "$(extract "$(make_fixture 'adjudicated in #189 and #300')" | targets)"

it "⑧ ISO 타임스탬프 — 2026-04-11T00:00:00.000Z는 뽑히지 않는다"
assert_eq "" "$(extract "$(make_fixture 'createdAt: "2026-04-11T00:00:00.000Z"')" | targets)"

# PR #337 승인이 이관한 경계. 네 형태를 한 번에 넣어, 인정 둘 / 비인정 둘이 명세대로
# 갈리는지 본다. 문자열은 전부 이 리포에 실재하는 형태다.
it "명세 경계 — 루트 상대·basename은 인정하고 산문형(PR #136 diff line 377)·L1234는 인정하지 않는다"
assert_eq "packages/kernel/src/services/consolidate-service.ts:2877 packages/kernel/src/services/consolidate-service.ts:2877" \
  "$(extract "$(make_fixture \
    'packages/kernel/src/services/consolidate-service.ts:2877' \
    'consolidate-service.ts:2877' \
    'Owner adjudication on PR #136 diff line 377' \
    'the anchor L1234 form is not used here')" | targets)"

# owner가 명시적으로 허가한 추가 케이스 (PR #351 수정요청 4). 대상 파일이 head 트리에 없는
# 인용은 이전에 미해결로만 빠져 경고가 0건이 되고, 그러면 코멘트가 아예 안 생겨 false-green이
# 됐다 — 인용 낡음의 최악의 경우(가리키는 자리가 없어짐)에만 잡이 침묵하던 자리다.
# **삭제와 리네임은 여기서 같은 코드 경로다**: 리네임의 옛 경로도 워크플로가 previous_filename을
# 함께 뽑으므로 「changed에 있고 트리에 없다」로 똑같이 들어온다. 그래서 케이스는 하나다.
# 세 인용을 한 번에 넣어 두 갈래(루트 상대 · basename)가 경고로 올라오고, diff에 없는
# 사라진 대상은 올라오지 않는 것까지 본다.
warnings() {
  jq -r '.warnings | map(if .missing then "없음:\(.token):\(.targetLine)" else "\(.target):\(.targetLine)" end) | join(" ")'
}

it "대상 파일이 사라지고(삭제·리네임) 그 경로가 diff에 들면 경고로 뜬다 — diff 밖이면 안 뜬다"
fixture="$(make_fixture \
  'mirrors packages/kernel/src/deleted.ts:10' \
  'mirrors renamed-away.ts:20' \
  'mirrors untouched-gone.ts:30')"
assert_eq "없음:packages/kernel/src/deleted.ts:10 없음:renamed-away.ts:20" \
  "$(extract_changed "$fixture" \
    "$(changed_list 'packages/kernel/src/deleted.ts' 'packages/kernel/src/services/renamed-away.ts')" |
    warnings)"

finish
