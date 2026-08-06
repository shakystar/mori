#!/usr/bin/env node
// packages/ 안의 크로스파일 줄 인용을 뽑아, 그 인용이 가리키는 대상 파일이 PR diff에 들었는지
// 판정하는 추출기다 (#303 조각2 / #322). 판정을 내리지 않는다 — 목록만 만든다.
//
// 왜 이것이 있는가: 이 리포는 크로스파일 줄 인용이 세 PR 연속으로 낡았다(#276·#299·#302).
// 원인은 인용의 형태가 아니라 **파괴자와 인용자가 다른 PR**이라는 것이고
// (docs/line-citation-staleness-adjudication.md §Q2), 그래서 인용을 고치는 쪽이 아니라
// 대상 파일을 만지는 쪽에 말을 건다. 근거·후보 비교는 그 문서 §Q3.5·§Q4에 있다.
//
// ── 인용으로 **인정하는** 형태 (§Q1.1의 ㉠ 계열. 괄호 안은 이 리포의 실제 문자열) ─────────
//   ㉠a/㉠b 루트 상대 경로 + 줄/범위
//        packages/kernel/src/services/consolidate-service.ts:2878
//        packages/kernel/src/services/memory-import-service.ts:234-254
//        → CONTRIBUTING.md «코드 주석의 크로스파일 줄 인용»이 정한 정본 형태다.
//   ㉠a/㉠b 파일명(basename) + 줄/범위
//        consolidate-service.ts:2857 · consolidate-service.ts:2639-2643 · pi-consolidator.ts:103
//        → CONTRIBUTING.md는 **새로 쓰는** 인용에 루트 상대를 요구하지만, 그 관례 이전에
//          쓰인 basename 인용이 오늘도 packages/에 남아 있다(그 문단이 "이행되지 않은 잔여"로
//          명시한 것). 이 형태를 안 받으면 §Q3.5-a의 탐지 실측 10/11이 성립하지 않는다 —
//          #299에서 뜬 경고 3건 중 2건이 basename 형태다. 그래서 **받는다.** 대상은
//          트리 전체에서 같은 basename이 유일할 때만 확정하고, 둘 이상이면 미해결로 남긴다.
//   ㉠c 확장자 없는 파일명 + 줄/범위 — 허용 목록(README·CONTRIBUTING·TESTING)만
//        README:140-142 (오늘 packages/에 0건. 조각1이 README.md:140-142로 바꿨다)
//        → **리포 루트 상대**로 푼다. 정규식으로 확장자 없는 이름을 열면 ISO 타임스탬프가
//          166건 걸리고(§Q1.3-4), basename으로 풀면 README.md가 리포에 둘이라 중의적이다
//          (§Q1.1a). 허용 목록 + 루트 상대가 그 둘을 동시에 닫는 유일한 규칙이고,
//          CONTRIBUTING.md의 관례와 같은 규칙이다.
//   ㉡d 쉼표 이어쓰기 — 머리 토큰에서 대상 파일을 받는다
//        consolidate-service.ts:2141, 2466  (오늘 packages/에 0건, docs/에 7건)
//        → 이어쓰기 항목의 대상은 "앞 문맥"이 아니라 **같은 목록의 머리 토큰**이라 토큰
//          단위로 확정된다(§Q1.2의 예외). 지금 안 넣으면 이 형태가 packages/에 들어오는
//          순간 조용히 놓친다.
//
// ── 인용으로 **인정하지 않는** 형태 ────────────────────────────────────────────────────
//   ㉡a/㉡b/㉡c 파일명 없는 줄 참조   `:2920` · (:2920) · `:2160-2162` · 감싸지 않은 :2141
//        → 대상 파일이 기계적으로 정해지지 않는다. "가장 가까운 앞선 ㉠"이라는 규칙을 ㉡
//          154건에 적용하면 44건이 파일 길이를 넘는 줄을 가리킨다 = 규칙이 반증된다(§Q1.2).
//   산문형 리포 밖 위치        PR #136 diff line 377
//        (packages/kernel/tests/integration/consolidate-service.test.ts에 실재한다)
//        → 대상 파일이 이 리포에 없다. CONTRIBUTING.md가 "리포 밖 위치는 줄 인용 형태로
//          쓰지 않는다"고 정한 뒤 남은 산문 표기이고, `<파일>:<줄>` 형태가 아니므로 여기
//          걸리지 않는다. PR #337 승인이 이 판정을 오탐으로 확정하며 경계의 성문화를
//          #322로 이관했다 — 이 목록과 citation-extract.test.sh의 경계 케이스가 그 성문이다.
//   L1234 단독 / #189 (이슈 참조) / ISO 타임스탬프(2026-04-11T00:00:00.000Z) / 시각(07:51)
//   / JSON·정규식 리터럴("salience":99) / URL 포트(localhost:11434)
//        → 전부 §Q1.3의 "인용처럼 보이지만 인용이 아닌 것"이다.
//   대상이 node_modules/ · dist/ 아래인 것
//        → 리포가 관리하지 않는 산출물이다(§Q1.3-1의 다른 저장소 dist/ 3건이 이 부류).
//
// ── 경고가 되는 두 가지 ───────────────────────────────────────────────────────────────
//   (1) **대상 있음** — 인용의 대상 파일이 head 트리에 있고, 그 경로가 PR diff에 들었다.
//        → "그 줄이 아직 인용이 말하는 내용인지 확인하라".
//   (2) **대상 없음(삭제·리네임)** — 인용의 대상이 head 트리에 **없고**, 그 경로가 PR diff에
//        들었다. 그 PR이 대상 파일을 지웠거나 이름을 바꾼 것이다.
//        → 줄이 밀린 정도가 아니라 **가리키는 자리가 통째로 없어진** 인용이므로 낡음의
//          최악의 경우인데, (1)만 세면 미해결로 빠져 잡 요약에만 남고 코멘트가 아예
//          생기지 않는다 = false-green (PR #351 owner 수정요청 1 / Codex P2 ①).
//        판정 규칙은 토큰 형태별로 이렇다:
//          · 루트 상대(`packages/a/b.ts`) — changed 목록에 그 경로가 그대로 있으면 경고
//          · ㉠c(`README`)              — `README.md`가 changed에 있으면 경고
//          · basename(`b.ts`)           — changed 경로 중 `/b.ts`로 끝나는 것이 있으면 경고.
//            **basename도 경고로 올린다.** basename 잔여가 packages/에 실재하는 한(위 ㉠a/㉠b
//            항목), 안 올리면 가장 많이 인용되는 파일이 삭제·리네임될 때만 잡이 침묵한다 —
//            탐지에서 가장 아픈 자리다. 오탐 위험은 좁다: 이 갈래에 오는 토큰은 head 트리에
//            같은 basename이 **0건**이라, 매치된 changed 경로는 반드시 이 PR에서 사라진 파일이다.
//          · basename 중의(트리에 2건 이상) — 대상이 살아 있으므로 여기 오지 않는다.
//   리네임의 옛 경로가 changed 목록에 들어오는 것은 워크플로 몫이다 — GitHub의 pulls/files는
//   리네임에 filename=새 경로 / previous_filename=옛 경로를 주므로 **둘 다** 뽑아야 한다.
//   (citation-advisory.yml의 `Collect the PR's changed files`)
//
// 수집 범위는 packages/ 아래로 못 박는다. docs/를 넣으면 PR당 최대 107건이 뜨고, 경고를 받은
// PR은 docs/를 고칠 권한이 없다 — 신호가 아니라 소음이 된다(§Q4.1).
//
// 사용법:
//   node citation-extract.mjs --root <트리> [--changed <파일목록>] [--format json|text|markdown]
//     --root      인용을 뽑을 트리의 루트. **PR head 트리여야 한다** — base에서 뽑으면 인용과
//                 그 인용을 낡게 만든 편집이 같은 PR에 든 형태를 못 본다(§Q3.5-a의 e1dcba3,
//                 탐지 10/11 → 8/11).
//     --changed   그 PR이 만진 파일 목록(줄바꿈 구분, 리포 루트 상대). 없으면 교집합을 재지
//                 않고 전수만 낸다 — 전수 세기(완료 조건)와 재현에 쓴다.
//     --format    json(기본) · text(사람이 읽는 목록) · markdown(PR 코멘트 본문)
//     --head-sha  markdown 각주에 적을 head SHA (표시용)
//     --out       출력 파일 (없으면 stdout)

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 대상 파일로 인정하는 확장자. 이 리포의 인용이 실제로 가리키는 것들이다(§Q1.0).
const CITED_EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs", "json", "md", "yml", "yaml"];
// 확장자 없는 이름은 이 셋만 받고 루트 상대 .md로 푼다 (§Q1.1a).
const BARE_NAME_ALLOWLIST = ["README", "CONTRIBUTING", "TESTING"];
// 트리를 걷지도, 대상으로 인정하지도 않는 디렉터리.
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", ".turbo", "coverage"]);
// 인용을 수집하는 범위. 여기를 넓히려면 §Q4.1을 먼저 읽어라.
const SOURCE_ROOT = "packages";
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
// 코멘트 표에 싣는 최대 행수. 넘으면 남은 건수를 **명시하고** 전체는 잡 로그에 남긴다 —
// 조용히 자르면 "이게 전부"로 읽힌다.
const COMMENT_ROW_CAP = 100;
const MARKER = "<!-- line-citation-advisory -->";

const EXT_ALT = CITED_EXTENSIONS.join("|");
const BARE_ALT = BARE_NAME_ALLOWLIST.join("|");
// 앞의 부정형 lookbehind가 두 가지를 막는다: (1) 경로 중간(`.../kernel/x.ts`)에서 매치가
// 시작돼 앞 경로가 잘리는 것, (2) `xREADME:12` 같은 이름 꼬리에서 허용 목록이 걸리는 것.
const CITATION_RE = new RegExp(
  `(?<![A-Za-z0-9_./-])((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:${EXT_ALT})|(?:${BARE_ALT})):(\\d+)(?:-(\\d+))?`,
  "g",
);
// ㉡d — 머리 토큰 바로 뒤에 쉼표로 이어 붙인 줄/범위. 숫자로 이어질 때만 목록으로 본다
// (`foo.ts:10, and …` 같은 산문은 걸리지 않는다).
const CONTINUATION_RE = /^,[ \t]*(\d+)(?:-(\d+))?/;

/**
 * 한 줄의 텍스트에서 ㉠ 계열 인용을 뽑는다. 파일시스템을 보지 않는다 — 형태만 판정한다.
 * @param {string} text
 * @returns {{token: string, raw: string, line: number, endLine: number|null, form: string}[]}
 */
export function parseCitations(text) {
  const found = [];
  CITATION_RE.lastIndex = 0;
  let match;
  while ((match = CITATION_RE.exec(text)) !== null) {
    const [raw, token, start, end] = match;
    const form = token.includes("/") ? "path" : token.includes(".") ? "basename" : "bare";
    found.push({
      token,
      raw,
      line: Number(start),
      endLine: end === undefined ? null : Number(end),
      form,
    });

    // 머리 토큰에 붙은 이어쓰기를 소비한다. 대상 파일은 머리에서 받는다.
    let cursor = match.index + raw.length;
    let tail;
    while ((tail = CONTINUATION_RE.exec(text.slice(cursor))) !== null) {
      found.push({
        token,
        raw: tail[0].trim(),
        line: Number(tail[1]),
        endLine: tail[2] === undefined ? null : Number(tail[2]),
        form: "continuation",
      });
      cursor += tail[0].length;
    }
    CITATION_RE.lastIndex = cursor;
  }
  return found;
}

const hasExcludedSegment = (path) => path.split("/").some((seg) => EXCLUDED_SEGMENTS.has(seg));

/**
 * 인용 토큰을 리포 루트 상대 경로로 푼다. 못 풀면 path=null과 사유를 낸다 — 조용히 버리지
 * 않는 것이 중요하다. 버려진 인용이 곧 "조용히 놓치는 인용"이기 때문이다.
 *
 * 못 풀 때의 `code`는 기계가 읽는다: `missing`은 "대상이 트리에 없다"이고, 그 경로가 PR diff에
 * 들어 있으면 경고로 올라간다(위 §경고가 되는 두 가지). `ambiguous`는 대상이 살아 있으나
 * 어느 것인지 정할 수 없는 것이라 경고로 올리지 않는다.
 * @param {string} token
 * @param {Set<string>} tree 리포 루트 상대 경로 집합
 */
export function resolveTarget(token, tree) {
  if (hasExcludedSegment(token)) {
    // 미해결이 아니라 **비인용**이다 — §Q1.3-1이 다른 저장소의 dist/ 산출물 3건을 인용에서
    // 뺀 것과 같은 판정이라, 미해결 목록에 남겨 사람을 부르지 않는다.
    return { path: null, dropped: true, reason: "리포가 관리하지 않는 경로(node_modules/dist 등)" };
  }
  if (!token.includes(".")) {
    // ㉠c — 허용 목록의 확장자 없는 이름. 루트 상대의 .md로만 푼다.
    const candidate = `${token}.md`;
    return tree.has(candidate)
      ? { path: candidate }
      : { path: null, code: "missing", candidate, reason: `리포 루트에 ${candidate}가 없다` };
  }
  if (tree.has(token)) return { path: token };
  if (token.includes("/")) {
    return {
      path: null,
      code: "missing",
      candidate: token,
      reason: "루트 상대 경로가 트리에 없다",
    };
  }
  const matches = [...tree].filter((p) => p.endsWith(`/${token}`));
  if (matches.length === 1) return { path: matches[0] };
  if (matches.length === 0) {
    // candidate=null — 대상 경로를 하나로 지목할 수 없다. changed 목록과는 basename으로 맞춘다.
    return { path: null, code: "missing", candidate: null, reason: "리포에 그 이름의 파일이 없다" };
  }
  return {
    path: null,
    code: "ambiguous",
    candidate: null,
    reason: `basename이 중의적이다(${matches.length}건: ${matches.join(", ")})`,
  };
}

function walk(root, rel, out) {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

function readTextFile(root, rel) {
  try {
    if (statSync(join(root, rel)).size > MAX_SOURCE_BYTES) return null;
    const buf = readFileSync(join(root, rel));
    if (buf.includes(0)) return null; // 바이너리
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 트리 하나에서 packages/ 아래 인용 전수를 뽑아 대상 파일까지 푼다.
 * @param {string} root
 */
export function collectCitations(root) {
  const tree = new Set(walk(root, "", []));
  const citations = [];
  const unresolved = [];
  for (const rel of [...tree].sort()) {
    if (rel !== SOURCE_ROOT && !rel.startsWith(`${SOURCE_ROOT}/`)) continue;
    const text = readTextFile(root, rel);
    if (text === null) continue;
    text.split("\n").forEach((lineText, index) => {
      for (const hit of parseCitations(lineText)) {
        const resolved = resolveTarget(hit.token, tree);
        const record = {
          source: rel,
          sourceLine: index + 1,
          raw: hit.raw,
          token: hit.token,
          form: hit.form,
          target: resolved.path,
          targetLine: hit.line,
          targetEndLine: hit.endLine,
        };
        if (resolved.dropped) continue;
        if (resolved.path === null) {
          unresolved.push({
            ...record,
            reason: resolved.reason,
            code: resolved.code,
            candidate: resolved.candidate ?? null,
          });
        } else citations.push(record);
      }
    });
  }
  return { citations, unresolved };
}

const cite = (c) =>
  `${c.target ?? c.token}:${c.targetLine}${c.targetEndLine ? `-${c.targetEndLine}` : ""}`;
const at = (c) => `${c.source}:${c.sourceLine}`;

/**
 * 대상을 못 푼 인용(`code === "missing"`)의 토큰이 PR이 만진 경로와 맞는지 본다. 맞으면 그
 * PR이 대상 파일을 지웠거나 이름을 바꾼 것이다 — 맞은 경로들을 낸다(없으면 빈 배열).
 * @param {{token: string, candidate: string|null}} u
 * @param {Set<string>} changed
 */
export function matchMissingTarget(u, changed) {
  // 루트 상대·㉠c는 대상 경로가 하나로 정해지므로 문자열 비교로 끝난다.
  if (u.candidate !== null) return changed.has(u.candidate) ? [u.candidate] : [];
  // basename 토큰은 지목할 경로가 없다. head 트리에 같은 이름이 0건이라는 것이 이 갈래의
  // 전제이므로, changed에 같은 basename이 있으면 그것이 사라진 그 파일이다.
  return [...changed].filter((p) => p === u.token || p.endsWith(`/${u.token}`)).sort();
}

function renderText(result) {
  const lines = [];
  lines.push(`인용 전수(packages/, ㉠ 계열): ${result.citations.length}건`);
  for (const c of result.citations) lines.push(`  ${at(c)}  →  ${cite(c)}  [${c.form}]`);
  if (result.unresolved.length > 0) {
    lines.push(`대상 미해결: ${result.unresolved.length}건`);
    for (const u of result.unresolved) lines.push(`  ${at(u)}  →  ${u.raw}  (${u.reason})`);
  }
  if (result.changedCount !== null) {
    lines.push(`PR이 만진 파일: ${result.changedCount}건 (리네임의 옛 경로 포함)`);
    lines.push(`경고(대상 파일 ∈ diff): ${result.warnings.length}건`);
    for (const c of result.warnings) {
      const tail = c.missing ? `  [대상 없음(삭제·리네임): ${c.missingMatch}]` : "";
      lines.push(`  ${at(c)}  →  ${cite(c)}${tail}`);
    }
  }
  return lines.join("\n");
}

function renderMarkdown(result, headSha) {
  const shown = result.warnings.slice(0, COMMENT_ROW_CAP);
  const rest = result.warnings.length - shown.length;
  const missingCount = result.warnings.filter((c) => c.missing).length;
  const body = [
    MARKER,
    `### 줄 인용 advisory — 이 PR이 만진 파일을 가리키는 인용 ${result.warnings.length}건`,
    "",
    "차단하지 않습니다. 아래는 `packages/` 안의 코드 주석이 **이 PR이 건드린 파일의 특정 줄**을",
    "가리키고 있다는 목록입니다. 그 줄이 여전히 인용이 말하는 내용인지 확인하고, 어긋났다면",
    "이 PR에서 함께 고치거나(같은 줄 번호 갱신) 별건으로 남겨 주세요.",
  ];
  if (missingCount > 0) {
    // 「줄 번호를 확인하라」와 「가리키는 파일이 사라졌다」는 사람이 다르게 읽어야 한다.
    body.push(
      "",
      `그중 **${missingCount}건은 대상 파일이 이 PR의 head 트리에 아예 없습니다**(삭제되었거나 이름이`,
      "바뀌었습니다). 줄 번호를 맞추는 문제가 아니라 인용이 가리키는 자리가 없어진 것이므로,",
      "인용을 새 경로로 옮기거나 지워 주세요.",
    );
  }
  body.push(
    "",
    "| 인용 위치 | 인용 | 대상 |",
    "| --- | --- | --- |",
    ...shown.map((c) => {
      const target = c.missing
        ? `**대상 없음(삭제·리네임)** — \`${c.missingMatch}\``
        : `\`${cite(c)}\``;
      return `| \`${at(c)}\` | \`${c.raw}\` | ${target} |`;
    }),
  );
  if (rest > 0) {
    body.push("", `…외 ${rest}건 (표는 ${COMMENT_ROW_CAP}행까지만 싣습니다 — 전체는 잡 로그에).`);
  }
  body.push(
    "",
    `<sub>추출: PR head 트리 \`${headSha || "(미상)"}\` · 범위 \`packages/\` · ㉠ 계열만 ` +
      "(`docs/line-citation-staleness-adjudication.md` §Q4 / #303 조각2). " +
      "이 코멘트는 판정이 아니며 required check가 아닙니다.</sub>",
  );
  return body.join("\n");
}

/**
 * 경고 목록을 만든다. 교집합은 **대상 파일**로 잰다 — 인용이 적힌 파일이 diff에 있는지는 묻지
 * 않는다. 인용과 그 인용을 낡게 만든 편집이 같은 PR에 든 형태를 잡아야 하기 때문이다(§Q3.5-a).
 * @param {object[]} citations
 * @param {object[]} unresolved
 * @param {Set<string>} changed
 */
export function collectWarnings(citations, unresolved, changed) {
  const missing = [];
  for (const u of unresolved) {
    if (u.code === "ambiguous") continue;
    if (u.code !== "missing") {
      // 사유 코드를 모르는 미해결을 조용히 건너뛰면 그것이 곧 "조용히 놓치는 인용"이다.
      // 새 사유가 생기면 여기서 죽어서, 경고에 넣을지 말지를 사람이 정하게 한다.
      throw new Error(`알 수 없는 미해결 코드 ${JSON.stringify(u.code)}: ${at(u)} → ${u.raw}`);
    }
    const hits = matchMissingTarget(u, changed);
    if (hits.length > 0) missing.push({ ...u, missing: true, missingMatch: hits.join(", ") });
  }
  const present = citations
    .filter((c) => changed.has(c.target))
    .map((c) => ({ ...c, missing: false, missingMatch: null }));
  // **대상 없음을 앞에 둔다.** 표에는 COMMENT_ROW_CAP행만 실리는데, 뒤에 두면 대상 있음이
  // 100건을 넘는 PR에서 더 심한 쪽(가리키는 자리가 통째로 없어진 인용)이 통째로 잘려 나간다.
  return [...missing, ...present];
}

function parseArgs(argv) {
  const args = { root: ".", changed: null, format: "json", out: null, headSha: "" };
  const keys = {
    "--root": "root",
    "--changed": "changed",
    "--format": "format",
    "--out": "out",
    "--head-sha": "headSha",
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]];
    if (key === undefined) throw new Error(`알 수 없는 인자: ${argv[i]}`);
    args[key] = argv[i + 1] ?? "";
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const { citations, unresolved } = collectCitations(args.root);

  let changed = null;
  if (args.changed !== null) {
    changed = new Set(
      readFileSync(args.changed, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    );
  }
  const warnings = changed === null ? [] : collectWarnings(citations, unresolved, changed);

  const result = {
    root: args.root,
    citations,
    unresolved,
    changedCount: changed === null ? null : changed.size,
    warnings,
  };

  const rendered =
    args.format === "markdown"
      ? renderMarkdown(result, args.headSha)
      : args.format === "text"
        ? renderText(result)
        : JSON.stringify(result, null, 2);

  if (args.out) writeFileSync(args.out, `${rendered}\n`);
  else process.stdout.write(`${rendered}\n`);
  return result;
}

// 라이브러리로 import될 때는 아무것도 실행하지 않는다 (테스트가 함수만 부를 수 있게).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
