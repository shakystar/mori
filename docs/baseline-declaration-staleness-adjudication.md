# 산정 문서의 "기준 커밋 = X" 전칭 선언 낡음 — 실측 + 관례 확정 (#324)

[#324](https://github.com/shakystar/mori/issues/324)의 산정 문서다. **구현하지 않는다** — 기존
`docs/` 문서는 한 글자도 고치지 않는다. `packages/` 0줄, `.github/` 0줄. 결론은 §Q4의 후속
조각 목록으로 나간다.

## 0. 기준선

- **기준 커밋**: `7f45c9d032c3e4df8d882d1f50c705fc180e2426` (착수 시점 `main` HEAD,
  `feat(tools): bash·edit_file에 executionMode: "sequential" …` (#335)).
- 아래 §Q1의 모든 `git log`/`git show` 출력은 이 커밋에서 직접 실행한 것이다. 이 문서 자신이
  재는 관례("전칭 선언은 커밋을 박아야 검증 가능하다")를 자기가 어기지 않는다.
- **PR #339 리뷰 반영**: §Q4의 #314 관련 서술은 이 기준선 이후(2026-08-06 11:47 UTC,
  #314가 PR #338로 머지)에 실제로 일어난 사실을 반영해 갱신했다. §Q1~§Q3의 판정(참/거짓/
  판정불가, 어긋난 인용 수, 권고안)은 이 기준선 시점 스냅샷 그대로다 — 바뀐 것은 §Q2의
  각주 2 재분류와 §Q4의 파일 목록·순서뿐이다.

## 필수 질문 → 절 매핑

| 질문                                              | 한 줄 답                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Q1](#q1--7건대상-문서-각각의-선언이-오늘-참인가) | 대상 문서는 7건이 아니라 **8건**(PR #325가 8번째를 들여왔다). 참 4 · 거짓 3 · 판정불가 1                                                                                                                                                                                                                             |
| [Q2](#q2--거짓인-것은-얼마나-거짓인가)            | 거짓 3건의 어긋난 인용 수(이동/신규 분리): `compare-and-append` 24/0=24 · `contradiction-repeat` 1/0=1 · `compaction-consolidation-boundary` 25/15=**40**(PR #339 리뷰가 각주 2의 "컬럼 폭 변화만" 주장을 반박 — `ff60e32`·`dbfc7ab`가 신규 인용도 심었다). **검산 25는 재현되지 않았다 — 24가 나왔다** (이유는 §Q2) |
| [Q3](#q3--관례를-어떻게-고칠-것인가)              | 권고: **(c) 단정 철회.** (a)·(b)는 전칭 문장을 유지한 채 주변을 덧대는 안이라 같은 실패가 반복된다                                                                                                                                                                                                                   |
| [Q4](#q4--후속-조각)                              | 3조각, 전부 즉시 가능(#314는 착수 도중 PR #338로 머지됐다 — 실물 7파일 교집합, §Q4 참고)                                                                                                                                                                                                                             |

## 1. Q1 — 7건(대상 문서) 각각의 선언이 오늘 참인가

이 이슈 본문의 표를 옮겨 적지 않고, 착수 시점 `main`에서 다시 셌다:

```sh
$ grep -nE "기준선|기준 커밋" docs/*.md
```

결과는 **8개 문서**다 (이슈 본문의 7건 + `consolidate-cursor-commit-crash-residue-adjudication.md`).
이 이슈의 두 번째 코멘트(2026-08-06 06:42 UTC)가 이미 이 차이를 예고했다 — PR #325(squash
`03abc0e`)가 그 문서를 새로 들여오며 8번째 선언이 생겼다. 그 코멘트가 예고한 그대로다.

각 문서마다 `git log --oneline <선언SHA>..7f45c9d -- docs/<파일>`로 선언 이후 그 문서를
건드린 커밋을 전수로 열거하고, 각 커밋의 diff를 직접 읽어 **파일:줄 인용값을 옮긴 것**과
**서술·수치(성능 ms 등)만 고친 것**을 구분했다. 후자는 문서 자신의 선언
("인용한 줄 번호는 이 시점의 것이다")이 파일:줄 인용만을 대상으로 하므로 거짓 판정에
넣지 않는다 — 각주에 근거를 적었다.

| #   | 문서                                                      | 선언 SHA  | 선언 이후 이 문서를 바꾼 커밋                                                                                                                       | 그중 인용값을 옮긴 것                                                         | 판정             |
| --- | --------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| 1   | `agent-harness-adoption.md`                               | `dbfc7ab` | `1316225`(자기 생성 커밋, #290)                                                                                                                     | 없음                                                                          | **참**           |
| 2   | `compare-and-append-residue-adjudication.md`              | `db80dfc` | `344b3ed`(생성, #304) → `eff6763`(#311) → `c58d5c2`(#323)                                                                                           | `eff6763`·`c58d5c2` 둘 다                                                     | **거짓**         |
| 3   | `contradiction-repeat-adjudication.md`                    | `db6ff67` | `42602ae`(생성, #292) → `76954a0`(#295, 코드+문서) → `eff6763`(#311) → `c58d5c2`(#323)                                                              | `eff6763`만[^1]                                                               | **거짓**         |
| 4   | `line-citation-staleness-adjudication.md`                 | `4eeb794` | `a482562`(자기 생성 커밋, #307)                                                                                                                     | 없음                                                                          | **참**           |
| 5   | `compaction-consolidation-boundary.md`                    | `8e8782b` | `9920b1c`(생성, #273) → `ff60e32`(#281) → `dbfc7ab`(#288) → `db6ff67`(#293) → `23d9716`(#326) → `337f2cb`(#329) → `ebd55f1`(#333) → `f1d80ce`(#334) | `23d9716`·`337f2cb`·`ebd55f1`·`f1d80ce`(이동) + `ff60e32`·`dbfc7ab`(신규)[^2] | **거짓**         |
| 6   | `consolidate-cursor-commit-crash-residue-adjudication.md` | `c58d5c2` | `03abc0e`(자기 생성 커밋, #325)                                                                                                                     | 없음                                                                          | **참**           |
| 7   | `log-unique-constraint-b-residue-adjudication.md`         | `60f8931` | `3b14890`(자기 생성 커밋, #313)                                                                                                                     | 없음                                                                          | **참**           |
| 8   | `consolidate-evidence-binding-adjudication.md`            | (없음)    | `46789ef`(자기 생성 커밋, #297)                                                                                                                     | 대조 불가                                                                     | **판정불가**[^3] |

[^1]:
    `76954a0`(#295)은 같은 표의 §5.3 성능 재측정값(ms)만 갱신했다 — 실물로 확인: 6개 행의
    `` `파일:줄` `` 토큰(`consolidate-service.ts:1425-1426` 등)은 diff 전후 바이트 동일하고,
    바뀐 것은 괄호 안 ms 수치뿐이다. 이 문서 §0의 선언 문구가 "**인용한 줄 번호**는 이 시점의
    것"이라고 파일:줄만 특정하므로, 이 커밋은 선언을 거짓으로 만들지 않는다. `c58d5c2`도
    `:210`의 어휘("거부한다"→"유니크 제약에 걸린다")만 고쳐 같은 이유로 제외했다. `eff6763`은
    `:71-76`→`:91-96` 1건의 실제 파일:줄 인용을 옮겨 거짓 판정의 근거가 됐다.

[^2]:
    **PR #339 리뷰(owner, Codex P2 동의)로 정정**: 최초 버전은 이 세 커밋을 뭉뚱그려 "컬럼 폭
    변화만"이라고 적었으나 틀렸다. 커밋별로 diff를 다시 읽었다(추가된 `+` 토큰과 삭제된 `-`
    토큰의 집합·개수를 대조):

    - **`db6ff67`(#293)**: 표 행 9개를 다시 썼지만 `project-lock.ts:79-107` 류 file:line
      토큰은 `+`/`-` 양쪽 집합·개수가 정확히 같다(8개 토큰 전수 대조) — 순수 절 참조 정정
      (§6 R2 → §5.2 R2)이다. **이 커밋만 원래 각주의 "컬럼 폭 변화만"이 맞다.**
    - **`ff60e32`(#281)**: **컬럼 폭 변화가 아니다.** W7·W8 두 행 + §2.2-b 본문을 새로
      추가하면서, 이전에 이 문서 어디에도 없던 file:line 토큰을 위치 기준(중복 포함) **14개**
      신규로 심었다 — `capture-service.ts:291-314`(×2)·`:291`(×2)·`:293-300`·`:293-312`,
      `projection-store.ts:238-239`·`:283-295`(×2), `sqlite-memory-kernel.ts:612-623`(×2)·
      `:828-834`(×2)·`:836-842`. (`project-lock.ts:79-107` 류·
      `consolidate-service.ts:2400-2412`/`:2437-2465`·`sqlite-memory-kernel.ts:690-736`은
      `+`/`-` 개수가 동일해 컬럼 폭 변화가 맞다 — 이 부분만 원래 각주가 옳았다.)
    - **`dbfc7ab`(#288)**: W8 행에 `memory-retrieval-service.ts:46-47`(관찰 tail 창 상수)
      1개를 신규로 추가했다. 다른 토큰은 `+`/`-` 개수가 동일해 컬럼 폭 변화다.

    **왜 중요한가**: 이 문서의 전칭 선언("모든 파일:줄 인용은 커밋 X의 것")은 값이 옮겨진
    인용뿐 아니라, 선언 시점(`8e8782b`) 이후 새로 심어진 인용에도 적용된다 — 신규 인용은
    애초에 그 시점에서 대조된 적이 없다. 원래 §Q2 방법("옮긴 값을 센다")은 "이동"만 잡고
    "신규"를 놓쳤다 — §Q2에서 이 두 축을 나눠 다시 센다.

[^3]:
    §0에 "기준선" 절 제목은 있으나 본문에 커밋 SHA가 없다 (`` `[0-9a-f]{7,}` `` 패턴 grep
    0건). 대조할 기준 시점이 없으므로 참/거짓을 매길 수 없다 — 이 문서는 자신을 관례
    위반으로 만들 전칭 문장조차 아직 쓰지 않은 상태다.

**요약**: 참 4 · 거짓 3 · 판정불가 1. 이슈 본문이 "이미 거짓"이라 확정한 1건
(`compare-and-append-residue-adjudication.md`)에 더해, 착수 시점 기준 **2건이 추가로
거짓**이다(`contradiction-repeat-adjudication.md`, `compaction-consolidation-boundary.md` —
후자는 이슈의 첫 코멘트가 이미 PR #326으로 예고했다).

## 2. Q2 — 거짓인 것은 얼마나 거짓인가

방법: 두 축을 나눠 센다.

- **이동** — Q1이 찾은 커밋의 diff에서 `-`/`+` 쌍마다 바뀐 개별 `` `파일:줄` `` 토큰
  (콤마로 이어진 다중 인용은 토큰별로 센다 — 이 리포 자신의 커밋 메시지 관례가 그렇다,
  아래 검산 참고).
- **신규** — 같은 diff의 `+` 쪽에만 있고 `-` 쪽 어디에도 없는 `` `파일:줄` `` 토큰. 선언
  시점 이후 새로 심어져 애초에 §0 커밋에서 대조된 적이 없는 인용이므로, "이동"과 마찬가지로
  전칭 선언을 거짓으로 만든다.

둘 다 전수 재대조가 아니라 이미 일어난 갱신 diff에서 세는 것이다. **"신규" 축은 최초
버전에는 없었다** — PR #339 리뷰(owner, Codex P2 동의)가 각주 2의 "컬럼 폭 변화만"이라는
주장이 `ff60e32`·`dbfc7ab`에는 틀렸음(신규 인용을 놓침)을 지적한 뒤 추가했다.

### 검산 — `compare-and-append-residue-adjudication.md`는 25가 나와야 한다

이 이슈 본문: _"PR #311 11건 + PR #323 14건 = 25건"_. 두 커밋의 diff를 토큰 단위로 직접 셌다:

- `eff6763`(#311): `git show eff6763 -- docs/compare-and-append-residue-adjudication.md`의
  6개 hunk를 전수로 읽어 바뀐 토큰을 세면 **10개**다 (`:55→:75`, `:59→:79`, `:77→:97`(4곳),
  `:56-58→:76-78`, `:61-69→:81-89`, `:77-84→:97-104`, `:85→:105`(3곳) — 정확히는 10개
  개별 토큰, 중복 제거 없이 발생 위치별로). 같은 커밋이 `contradiction-repeat-adjudication.md`도
  1건 고쳤다(`:71-76→:91-96`) — 커밋 메시지의 "총 12건, 11개 토큰"은 **두 문서 합산**이고
  (10+1=11), 이슈 본문이 그 11 전부를 `compare-and-append` 한 문서로 귀속시킨 것이 어긋난다.
- `c58d5c2`(#323): 같은 방식으로 6개 hunk에서 **14개** 토큰(`:40`·`:160-165`는 hunk 안에
  있지만 값이 안 바뀐 bystander라 제외) — 이건 이슈 본문의 14와 일치한다.

**합: 10 + 14 = 24, 25가 아니다.** 방법을 25에 맞추려고 구부리지 않았다 — 두 커밋의 diff를
전수로 다시 읽어도 10과 14가 나온다. 어긋난 지점은 `eff6763`의 귀속이다: 그 커밋은
`compare-and-append-residue-adjudication.md`에 10건, `contradiction-repeat-adjudication.md`에
1건을 갱신했는데, 커밋 메시지 제목("11건 갱신")과 이슈 본문이 그 11을 전부
`compare-and-append` 한 문서의 몫으로 셌다. **이슈 본문의 계산 자체가 두 문서 합산 수치를
한 문서에 귀속시킨 오차이지, 코드나 커밋이 틀린 것이 아니다** — 이 문서가 겨누는 "인용은
옮겨 적으면 낡는다"의 사례가 이 이슈의 계산 과정 자체에서도 나온 셈이다.

**신규 축 재확인** (§Q2 방법을 넓힌 뒤 이 문서에도 같은 렌즈를 다시 대봤다 — owner
PR #339 리뷰가 요구한 재검산): `eff6763`·`c58d5c2` 두 커밋의 diff를 신규 렌즈로 다시
읽었다. `+`(추가) 토큰과 `-`(삭제) 토큰의 집합·개수가 두 커밋 모두 정확히 일치한다 —
`eff6763`은 `:55→:75`·`:59→:79`·`:71-76→:91-96`·`:77→:97`(×3)·`:77-84→:97-104` 전부 1:1
치환이고, `c58d5c2`도 `:85`(4)→`:105`(4)·`:55`(3)→`:75`(3)·`:56-58`(1)→`:76-78`(1)·
`:59`(2)→`:79`(2)·`:61-69`(1)→`:81-89`(1)·`:77`(3)→`:97`(3) 전부 개수가 맞아떨어진다.
**신규 토큰 0개.** `compare-and-append-residue-adjudication.md`의 24는 이동만으로 이미
전수였고, 넓힌 방법으로도 그대로 24다(owner PR #339 리뷰 지시: "25에 맞추려고
되돌리지 마라"와 같은 이유로, 24를 40으로 부풀리지도 않는다 — 있는 그대로 적는다).
`contradiction-repeat-adjudication.md`의 `eff6763` 1건(`:71-76→:91-96`)도 순수 이동이라
1 그대로다.

### 세 문서 — 이동/신규 분리

| 문서                                         | 이동 | 신규 |     합 | 근거                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ---: | ---: | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compare-and-append-residue-adjudication.md` |   24 |    0 | **24** | 위 검산(`eff6763` 10 + `c58d5c2` 14), 신규 축 재확인 0건                                                                                                                                                                                                                                                                |
| `contradiction-repeat-adjudication.md`       |    1 |    0 |  **1** | `eff6763`의 `:71-76→:91-96` 1건, 신규 축 재확인 0건                                                                                                                                                                                                                                                                     |
| `compaction-consolidation-boundary.md`       |   25 |   15 | **40** | 이동 25: `23d9716` 2(`:2400-2412`가 `:2252-2255`·`:2611-2627` 둘로 갈라짐, 신규값 둘 다 카운트) + `337f2cb` 11(커밋 메시지 자체가 "11건" — 직접 diff로도 재현됨) + `ebd55f1` 10(9건 갱신 + grep 블록 예시 출력 1건) + `f1d80ce` 2(`:2141,2466→:2239,2693`, 콤마 토큰 각각). 신규 15: `ff60e32` 14 + `dbfc7ab` 1(각주 2) |

## 3. Q3 — 관례를 어떻게 고칠 것인가

### (a) 유지보수 원장

§0 밑에 `이후 갱신` 표를 두고, 인용을 옮기는 PR마다 `PR | 대상 파일 | 갱신한 인용 수 | 이제
어느 커밋 기준인가` 한 행을 덧붙인다.

- **장점**: 원 서술(§0 첫 문단)을 안 건드린다 — 이 리포의 유지보수 PR 다수가 이미
  "서술 무변경"을 완료조건으로 못박아 왔다(#312, #316–#319). 감사 이력이 남는다.
- **단점**: §0 첫 문단은 여전히 거짓인 채로 남는다 — 독자가 "이 문서는 커밋 X 기준"이라고
  읽고 원장까지 안 내려가면 다시 틀린 줄을 찾아간다. 원장이 길어질수록(compaction-consolidation-boundary.md는
  이미 4개 조각 + 3개 prose PR이 스쳤다) 그 자체가 다음 유지보수 비용이 된다.
- **PR이 추가로 해야 하는 일**: 원장에 행 1개 추가 — 오버헤드는 낮다.

### (b) 재기준선(re-baseline)

인용을 옮긴 PR이 §0의 SHA를 자기 base로 갱신하고, 갱신하지 않은 인용까지 그 SHA에서
참인지는 보증하지 않는다고 명시한다.

- **장점**: §0가 항상 "가장 최근 갱신"을 반영해 독자 혼란이 준다.
- **단점**: "갱신 안 한 인용은 보증 안 함"이 전칭 선언의 존재 이유(§Q1의 완결성 주장)를
  스스로 포기하는 것과 같다. `compaction-consolidation-boundary.md`처럼 구간별 조각 PR이
  일어나는 경우(1~~213줄, 214~~377줄, …) SHA 하나로는 "어느 구간이 그 SHA 기준인지"를 잃는다
  — 이는 §Q1에서 실제로 관찰된 실패 모드이고, "서술 무변경" 완료조건과 정면으로 충돌한다
  (#312, #316–#319 전부 이 조건이 있었다 — (b)는 그 조건 자체를 뒤집어야 성립한다).
- **PR이 추가로 해야 하는 일**: §0 SHA 갱신 + 부분 갱신 시 구간 명시 — (a)보다 무겁다.

### (c) 단정 철회

"모든 인용은 커밋 X의 것"이라는 전칭 문장을 버리고, 시점이 중요한 인용 자리에만 국소적으로
SHA를 단다.

- **장점**: §Q1의 근본 원인(전칭 선언이 인용 유지보수 PR 하나로 거짓이 됨)을 구조적으로
  없앤다. 조각 PR과 자연히 맞는다 — 조각이 자기가 옮긴 인용 옆에만 로컬 근거를 남기면
  §0을 안 건드려도 되므로 "서술 무변경" 조건과 충돌하지 않는다. `line-citation-staleness-adjudication.md:644`가
  이미 이 방향을 스치고 지나갔다("관례로 권장하고 있으면서 그것이 유지보수로 낡는다는 것은
  아직 안 쟀다") — 이 문서가 그 다음 단계다.
- **단점**: §0의 "이 문서 전체를 신뢰해도 되는 단일 기준"이 사라진다. 인용마다 로컬 SHA를
  찾아야 하고, 없으면 재대조가 필요하다. 다만 "코드가 정본, 문서는 지도"라는 이 리포의
  기존 규율을 지키려면 어차피 실물 대조가 전제이므로 실질 비용 증가는 제한적이다.
- **PR이 추가로 해야 하는 일**: 없음 — 지금 하던 대로 인용 값만 옮기면 된다. 기존 8개
  문서의 §0 문장을 실제로 고치는 것은 이 이슈의 비범위이며 §Q4가 후속으로 자른다.

### 권고: (c)

§Q1이 보여준 실패는 예외 없이 "전칭 문장이 유지보수 한 번으로 깨진다"는 모양이다 — 8건 중
3건이 이미 깨졌다. **#314는 이 문서 작성 도중 PR #338로 실제로 착지했다**(2026-08-06
11:47 UTC 머지, squash `37a449d`) — 실물 파일 목록(`gh pr view 338 -R shakystar/mori --json
files`)은 `docs/` **7개**다: `compaction-consolidation-boundary.md`·
`compare-and-append-residue-adjudication.md`·
`consolidate-cursor-commit-crash-residue-adjudication.md`·
`consolidate-evidence-binding-adjudication.md`·`contradiction-repeat-adjudication.md`·
`line-citation-staleness-adjudication.md`·`log-unique-constraint-b-residue-adjudication.md`.
이 7건을 §Q1 표에 대면, 착수 시점 "참"이던 4건 중 `line-citation-staleness-adjudication.md`·
`consolidate-cursor-commit-crash-residue-adjudication.md`·
`log-unique-constraint-b-residue-adjudication.md` **정확히 3건**이 포함돼 있었다 — 이
문단의 "3"이라는 수 자체는 처음부터 옳았고, 틀렸던 것은 근거로 든 "#314가 손대는 5개
문서"라는 목록이었다(실제로는 7개였고, 그 7개 중 3개가 착수 시점 "참"이다). PR #339
리뷰(owner, Codex P2 동의)가 이 불일치를 지적했다 — 자세한 재구성은 §Q4·§5를 참고.
(a)·(b)는 전칭 문장을 유지한 채 주변을 덧대는 안이라 같은 실패가 되풀이된다 — (a)는
원장이 길어질수록 "§0 대신 원장을 읽어라"는 새 규율을 매번 지켜야 하고, (b)는 구간별
조각 PR이라는 이 리포의 실제 패턴과 충돌한다. (c)는 이 실패 모양 자체를 없앤다.

### §Q3을 §Q1의 8행에 적용한 결과

| #   | 문서                                                      | (c) 적용 시                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `agent-harness-adoption.md`                               | 참 상태 유지 — 급하지 않음. 다음 유지보수 PR이 로컬 SHA만 남기면 영구히 참으로 유지된다                                                                                                                                                                                |
| 2   | `compare-and-append-residue-adjudication.md`              | **닫힘** — 전칭 문장 제거 시 "거짓" 판정 자체가 성립할 표면이 없어진다. 이미 옮긴 인용값은 그대로 유효해 재작업 불필요                                                                                                                                                 |
| 3   | `contradiction-repeat-adjudication.md`                    | **닫힘** — 동일                                                                                                                                                                                                                                                        |
| 4   | `line-citation-staleness-adjudication.md`                 | 참 상태 유지. 다만 이 문서 자신이 §Q3 예시로 인용되므로(`:644`) 표현 정리 필요(§Q4)                                                                                                                                                                                    |
| 5   | `compaction-consolidation-boundary.md`                    | **닫힘** — 4조각이 이미 옮긴 인용은 유효, 전칭 문장만 제거하면 됨                                                                                                                                                                                                      |
| 6   | `consolidate-cursor-commit-crash-residue-adjudication.md` | 착수 시점 참이었으나 **#314(PR #338, 2026-08-06 11:47 UTC 머지)가 이 문서도 포함해 인용을 밀었다**(71 insertions/71 deletions, §Q4 참고) — baseline `c58d5c2` 기준으로 지금은 거짓이다. `#328`이 지적한 별개의 판정 오류(코드 diff 무관, 서술 오류)는 여전히 열려 있다 |
| 7   | `log-unique-constraint-b-residue-adjudication.md`         | 착수 시점 참이었으나 **#314(PR #338)가 착지하며 거짓으로 넘어갔다** — 31 insertions/31 deletions로 `consolidate-service.ts`/`memory-import-service.ts` 인용을 밀었다(§Q4 참고)                                                                                         |
| 8   | `consolidate-evidence-binding-adjudication.md`            | (c) 상태에 가장 가깝다 — SHA가 아예 없어 전칭 선언 표면이 없다. 다만 "기준선"이라는 절 제목만 있고 내용이 없어 오해 소지 — §Q4에서 로컬 SHA 스타일로 명시 전환 권장                                                                                                    |

## 4. Q4 — 후속 조각

**한 조각 = 한 세션.** 오늘 열려 있는 인용 관련 일감과의 파일 교집합을 조각마다 명시한다.

**PR #339 리뷰 반영**: 아래 조각 1·2의 대상 파일은 착수 시점(§0, `7f45c9d`)에 예상한
"#314가 손댈 5개 문서"가 아니라, **#314가 PR #338로 실제로 손댄 파일 목록**
(`gh pr view 338 -R shakystar/mori --json files` 실물 출력, §Q3 참고)으로 다시 짰다 —
7개 문서 + 나머지 1개 문서로 8개 전부가 빠짐없이(합집합 8, 교집합 0) 배정된다. 순서
제약도 갱신했다: **#314는 이제 열려 있지 않고 머지됐다**(PR #338, `37a449d`,
2026-08-06 11:47 UTC) — 조각 1의 "#314 다음"이라는 과거의 순서 제약은 이미 충족됐고,
조각 1·2·3 모두 즉시 착수 가능하다. §0 기준선(`7f45c9d`)은 그대로 두되, 이 사실은
그 이후에 일어난 일이다 — 바로 이 상황(선행이 리뷰 왕복 중에 착지한다)이 이 문서가
재는 낡음 그 자체다.

| 조각 | 내용                                                                                                                                                                                                                                                                                                                                                                                                    | 대상 파일         | 다른 이슈와의 교집합                                                                                                                                                | 순서                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | §0 전칭 선언을 (c)로 전환 — #314(PR #338)가 실제로 손댄 7개 문서(`compaction-consolidation-boundary.md`, `compare-and-append-residue-adjudication.md`, `consolidate-cursor-commit-crash-residue-adjudication.md`, `consolidate-evidence-binding-adjudication.md`, `contradiction-repeat-adjudication.md`, `line-citation-staleness-adjudication.md`, `log-unique-constraint-b-residue-adjudication.md`) | `docs/` 7파일     | **#314와의 교집합은 이제 리스크가 아니다** — #314는 PR #338로 2026-08-06 11:47 UTC에 이미 머지됐다(squash `37a449d`). 더 이상 열려 있지 않으므로 재낡힘 걱정이 없다 | **선행 없음, 즉시 가능**(과거엔 "#314 다음"이었으나 #314가 이미 착지했다) |
| 2    | §0 전칭 선언을 (c)로 전환 — #314(PR #338)가 손대지 않은 나머지 1개 문서(`agent-harness-adoption.md`)                                                                                                                                                                                                                                                                                                    | `docs/` 1파일     | 다른 조각·다른 이슈와 교집합 0                                                                                                                                      | **선행 없음, 즉시 가능**                                                  |
| 3    | §Q3 권고((c) 단정 철회)를 `CONTRIBUTING.md`(또는 동등한 관례 문서)에 명문화 — 이후 추가되는 산정 문서는 전칭 기준선 대신 로컬 SHA를 쓴다                                                                                                                                                                                                                                                                | `CONTRIBUTING.md` | `.github/`는 안 건드려 #322(CI advisory, `.github/` 담당)와 교집합 0. 다른 조각과도 교집합 0                                                                        | 선행 없음, 다른 조각과 병행 가능                                          |

조각 1·2는 대상 파일이 겹치지 않아(7+1=8, 교집합 0) 서로 순서 무관, 조각 3도 독립이다.
과거엔 조각 1만 #314 뒤로 미뤄야 했지만, #314가 이미 착지했으므로 지금은 셋 다 즉시
병행 가능하다.

## 5. 발견(범위 밖) — 고치지 않음

- `consolidate-evidence-binding-adjudication.md` §0은 "기준선" 절 제목만 있고 커밋 SHA가
  없다 — §Q1 각주 3, §Q4 조각 1에서 흡수.
- 이 이슈 본문 자체의 §Q2 검산 수치(25)가 두 문서 합산을 한 문서로 귀속한 계산 오차였다
  (§Q2 검산 절 참고). 이슈 코멘트로 남긴다 — 이 문서 안에서 고치지 않는다(이슈는 손댈 수
  없는 대상이다).
- PR #339 리뷰 왕복에서 §Q3의 "3"이라는 수와 (구) §Q4 조각 1의 "#314가 손대는 5개 문서"
  목록이 서로 모순됐다. Codex는 §Q4의 5파일 목록을 정본으로 삼아 "3"을 "1"로 고치라고
  처방했지만 틀렸다 — 실물(`gh pr view 338 --json files`)을 열어보니 §Q4의 5파일 목록
  자체가 틀렸고(실제 7파일) "3"이 옳았다. **문서 안의 두 수치가 어긋날 때 어느 쪽이
  실물인지는 실물을 열어야 안다**는, 바로 이 문서가 겨누는 주장의 사례가 이 리뷰 왕복
  자체에서 한 번 더 나온 셈이다.

## 6. 부록 — §Q1 판정 근거 원출력

owner PR #339 리뷰(완료 조건 미충족 지적 3번): §Q1 표의 "선언 이후 이 문서를 바꾼 커밋"
칸은 아래 명령들의 출력을 **요약**한 것이다. 요약은 재현 가능한 근거가 아니므로, 실제로
실행한 명령과 그 출력을 여기 그대로 붙인다. 전부 §0 기준 커밋 `7f45c9d`에서 실행했다.

### 대상 문서 재탐색

```sh
$ grep -nE "기준선|기준 커밋" docs/*.md
```

```
docs/agent-harness-adoption.md:9:규율을 따른다: **코드가 정본이고 이 문서는 그 지도다.** 아래의 모든 인용은 §0의 기준선
docs/agent-harness-adoption.md:15:## 0. 기준선
docs/agent-harness-adoption.md:17:- 기준 커밋: `dbfc7ab` (PR #288 머지 직후). 인용한 줄 번호는 이 시점의 것이다.
docs/agent-harness-adoption.md:917:**mori** (기준 커밋 `dbfc7ab`)
docs/compare-and-append-residue-adjudication.md:11:**기준선**: `main` = `db80dfc`
docs/compare-and-append-residue-adjudication.md:415:측정 기준선 (§0의 grep을 단/복수로 쪼갠 것):
docs/consolidate-evidence-binding-adjudication.md:22:## 0. 기준선 — 오늘 `run()`이 무엇을 어디서 읽는가
docs/consolidate-evidence-binding-adjudication.md:342:1. **오늘의 기준선은 이미 같은 축 위에 있다.** 표의 `창` 열은 n이 2만 배로 늘어도
docs/compaction-consolidation-boundary.md:8:그 지도다.** 아래의 모든 인용은 아래 §0의 기준선 시점 `main` 실물이며, 코드와 어긋나면
docs/compaction-consolidation-boundary.md:29:## 0. 기준선과 오늘의 실물
docs/compaction-consolidation-boundary.md:31:- 기준 커밋: `8e8782b` (PR #271 = #270 머지 직후). 인용한 줄 번호는 이 시점의 것이다.
docs/line-citation-staleness-adjudication.md:12:**기준 커밋: `4eeb794` (`main`, PR #302 squash).** 아래 모든 숫자는 이 커밋에서 직접 수집했다.
docs/line-citation-staleness-adjudication.md:17:- **살아 있는 인용** — 기준 커밋의 실물을 가리킨다. 전부 대조했다.
docs/line-citation-staleness-adjudication.md:572:각 열의 뜻: **탐지** = §Q3 서두의 정답지 11건 중 잡는 수 · **오탐** = 기준 커밋 `4eeb794`의 인용
docs/line-citation-staleness-adjudication.md:644:이 문서가 첫머리에 `기준 커밋: 4eeb794`를 적은 것이 그 관례의 시연이다. 다만 `#303`은 "오늘 낡아
docs/consolidate-cursor-commit-crash-residue-adjudication.md:11:**기준선**: `main` = `c58d5c2`
docs/consolidate-cursor-commit-crash-residue-adjudication.md:46:이 문서는 그 정의를 기준선에서 다시 세우고(§Q1.0), 세 가지를 새로 판정한다.
docs/consolidate-cursor-commit-crash-residue-adjudication.md:55:### Q1.0 R1의 자리 — 기준선 실물
docs/consolidate-cursor-commit-crash-residue-adjudication.md:102:기준선에서 `:2694`부터 `:2919`까지를 전수로 훑었다. `await`는 **정확히 4개**이고, 그 밖의 코드는
docs/consolidate-cursor-commit-crash-residue-adjudication.md:200:  기준선에서 `:2694`부터 `:2919`까지를 훑어 **`throwIfDispossessed` 호출이 0건**임을 확인했다
docs/consolidate-cursor-commit-crash-residue-adjudication.md:958:기준선 `c58d5c2`에서 **직접 열어 대조한** 전체 목록이다. 맞은 것도 "맞음"으로 적는다.
docs/consolidate-cursor-commit-crash-residue-adjudication.md:1094:같다 — 착수 시점 `main`(= `23d9716`, 이 브랜치의 병합 커밋 `076dd2b` 기준선)에서 직접 열어
docs/contradiction-repeat-adjudication.md:9:규율을 따른다: **코드가 정본이고 이 문서는 그 지도다.** 아래 모든 인용은 §0의 기준 커밋
docs/contradiction-repeat-adjudication.md:24:그 밖에: [§0 기준선과 결함의 모양](#0-기준선과-결함의-모양),
docs/contradiction-repeat-adjudication.md:27:## 0. 기준선과 결함의 모양
docs/contradiction-repeat-adjudication.md:29:- 기준 커밋: `db6ff67` (PR #293 머지 직후, `main`). 인용한 줄 번호는 이 시점의 것이다.
docs/log-unique-constraint-b-residue-adjudication.md:10:**기준선**: `main` = `60f8931`
docs/log-unique-constraint-b-residue-adjudication.md:600:기준선 `60f8931`에서 **직접 열어 대조한** 전체 목록이다. 맞은 것도 "맞음"으로 적는다.
```

(이 문서 자신의 매치는 제외했다 — 대상은 다른 문서를 "가리키는" 선언이지 이 문서가 아니다.)
8개 문서가 나온다 — §Q1 표의 8행과 일치한다.

### 문서별 `git log` — 선언 SHA 이후 `7f45c9d`까지

```sh
$ git log --oneline dbfc7ab..7f45c9d -- docs/agent-harness-adoption.md
```

```
1316225 docs+investigate(mori): pi AgentHarness 채택 비용 산정 — 이주 경계와 조각 나누기 (#287) (#290)
```

```sh
$ git log --oneline db80dfc..7f45c9d -- docs/compare-and-append-residue-adjudication.md
```

```
c58d5c2 docs(kernel): 낡힌 bare 줄번호 인용 전수 판정 — conflict-service.ts 14건 갱신 (#309 후속) (#312) (#323)
eff6763 docs(kernel): PR #308이 낡힌 conflict-service.ts 인용 11건 갱신 (#309) (#311)
344b3ed docs(kernel): A 축 잔여 범위 재측정 — append 호출부 7건 전수 판정, 남은 CAS 조각 0개 (#301, #189 A) (#304)
```

```sh
$ git log --oneline db6ff67..7f45c9d -- docs/contradiction-repeat-adjudication.md
```

```
c58d5c2 docs(kernel): 낡힌 bare 줄번호 인용 전수 판정 — conflict-service.ts 14건 갱신 (#309 후속) (#312) (#323)
eff6763 docs(kernel): PR #308이 낡힌 conflict-service.ts 인용 11건 갱신 (#309) (#311)
76954a0 feat(kernel): detectContradictions의 판정 basis를 로그 replay로 옮긴다 — ㉰ 중복 재판정 닫기 (#294, #189 ㉰) (#295)
42602ae docs(kernel): detectContradictions 중복 재판정 산정 — 권고는 로그 replay basis (#289, #189 잔여 ㉰) (#292)
```

```sh
$ git log --oneline 4eeb794..7f45c9d -- docs/line-citation-staleness-adjudication.md
```

```
a482562 docs(repo): 크로스파일 줄번호 인용 낡음 방지 수단 산정 — 권고는 packages/ 한정 advisory 경고 (#303) (#307)
```

```sh
$ git log --oneline 8e8782b..7f45c9d -- docs/compaction-consolidation-boundary.md
```

```
f1d80ce docs(memory): compaction 경계 문서 인용 전수 대조 — 조각 4/4 (435~683줄, §4.4~§8, #306) (#334)
ebd55f1 docs(memory): compaction 경계 문서 인용 전수 대조 — 조각 2/4 (214~377줄, #306) (#333)
337f2cb docs(memory): compaction 경계 문서 인용 전수 대조 — 조각 3/4 (378~434줄, #306) (#329)
23d9716 docs(memory): compaction 경계 문서 인용 전수 대조 — 조각 1/4 (1~213줄, #306) (#326)
db6ff67 docs(memory): compaction 경계 문서의 깨진 절 참조 정정 — §6 R2 → §5.2 R2 (#288 잔여) (#293)
dbfc7ab docs(memory): W8이 닫히는 조건에 관찰 tail 창(24h/20건) 한정을 싣는다 (#281 Codex 후속) (#288)
ff60e32 docs(memory): compaction 경계 문서의 커버리지 한정 3건 보정 (#273 Codex 후속) (#281)
9920b1c docs(memory): compaction 경계 = consolidation 경계 설계 문서 (#272, #7 첫 조각) (#273)
```

```sh
$ git log --oneline c58d5c2..7f45c9d -- docs/consolidate-cursor-commit-crash-residue-adjudication.md
```

```
03abc0e docs+investigate(kernel): append와 커서 커밋 사이 잔여(R1) 산정 — 권고는 커서 커밋을 append 트랜잭션에 합류 (#315, #310 발견) (#325)
```

```sh
$ git log --oneline 60f8931..7f45c9d -- docs/log-unique-constraint-b-residue-adjudication.md
```

```
3b14890 docs(kernel): B 축 후보 2·3 재측정 — 증류 창·import 정규화 텍스트 유니크 둘 다 넣지 않는다 (#310, #189 B) (#313)
```

`consolidate-evidence-binding-adjudication.md`는 §0에 SHA가 없어(§Q1 각주 3) `<선언SHA>..`
형태의 `git log`를 돌릴 기준점 자체가 없다. 대신 SHA 부재를 재확인한 명령:

```sh
$ grep -nE '`[0-9a-f]{7,}`' docs/consolidate-evidence-binding-adjudication.md
```

```
(출력 없음 — 0건)
```

8개 명령의 결과가 §Q1 표의 "선언 이후 이 문서를 바꾼 커밋" 칸과 전부 일치한다.
