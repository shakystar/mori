# LongMemEval-V2 입수·적재 가능성 확정 (#490, #344 조각 1/N)

> **판정 기록 · 동결됨 (커밋 `d878d62` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

## 판정 먼저

- **데이터셋은 실존하고 실제로 받아진다.** 배포처·라이선스·파일 형식 전부 확인했고, 실제
  파일에서 문항 451건을 직접 셌다 (아래 §1).
- **judge(공식 프로토콜 gpt-4o/gpt-5.2) 접근 불가 — 아니오.** `OPENAI_API_KEY`가 이 환경에
  없다 (§3).
- **구조적 경고 (owner 판단 필요): LongMemEval-V2는 기존 LongMemEval의 "버전 2"가 아니라
  별도 벤치다.** 원본 LongMemEval(MIT, ICLR 2025, 대화형 챗봇 장기기억)과 저자(Di Wu 외)는
  겹치지만, V2는 **웹/엔터프라이즈 에이전트의 트라젝토리 기억**(WebArena·ServiceNow류 환경의
  스크린샷+접근성 트리+행동 시퀀스)을 재는 완전히 다른 벤치다. 대화 세션이 아니라 "에이전트가
  브라우저를 조작한 기록"이 한 "세션"(트라젝토리) 단위다. mori는 대화형 어시스턴트의 세션
  기억(`preference-regression/` 참고)을 다루므로, **#344가 상정한 "LongMemEval-V2 베이스라인"이
  실제로 무엇을 재는지 owner가 한 번 더 확인해야 한다** — 이 조각은 로더까지만 만들고 그
  재해석은 하지 않는다(비범위).

## §1. 배포처·라이선스·파일 목록

| 항목      | 값                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 논문      | arXiv [2605.12493](https://arxiv.org/abs/2605.12493) — "LongMemEval-V2: Evaluating Long-Term Agent Memory Toward Experienced Colleagues" (2026-05-12 제출, UCLA)                 |
| 코드 리포 | [github.com/xiaowu0162/LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2/) — Apache-2.0                                                                               |
| 데이터셋  | [huggingface.co/datasets/xiaowu0162/longmemeval-v2](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2), revision `f152293e235517d504809563c833d7190b8c713b` — Apache-2.0 |

파일 목록과 크기 (HF 리포 트리, 위 revision 기준):

| 파일                              | 크기                        | 비고                                                                                         |
| --------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `questions.jsonl`                 | 286,186 B                   | 451줄, 일반 HTTPS로 직접 받아짐 (LFS 아님)                                                   |
| `trajectories.jsonl`              | 1,195,604,539 B (≈1.11 GiB) | 1,870줄, git-LFS이지만 `resolve/main` URL로 curl 직접 다운로드 가능 (huggingface_hub 불필요) |
| `haystacks/lme_v2_small.json`     | 822,632 B                   | 문항 451개 → 각 100개 트라젝토리 id 배열                                                     |
| `haystacks/lme_v2_medium.json`    | 4,054,244 B                 | 문항 451개 → 각 최대 500개 트라젝토리 id 배열                                                |
| `SCHEMA.md` / `DATA_CARD.md`      | 1,879 B / 2,506 B           | 필드 문서 (아래 §2가 요약)                                                                   |
| `question_screenshots/*.png`      | 다수 (이미지 문항용)        | 이 조각에서는 받지 않음 (텍스트 로더만)                                                      |
| `trajectory_screenshots/*.tar.gz` | 다수, 전체 ≈7.12GB          | 이 조각에서는 받지 않음                                                                      |

**LongMemEval(v1)과의 관계**: `github.com/xiaowu0162/LongMemEval` (MIT, ICLR 2025,
"Benchmarking Chat Assistants on Long-Term Interactive Memory")과 저자가 겹치는 후속작이지만,
과제 형식이 다른 별도 벤치다 — 위 "구조적 경고" 참고. V2가 V1의 데이터/체크포인트를
버전업하는 관계는 아니다.

### 실제로 센 문항 수

```
$ wc -l questions.jsonl
451 questions.jsonl
```

**451 — 이슈·논문이 말하는 수와 일치한다.**

## §2. 스키마 — 5능력 라벨의 필드명과 능력별 문항 수

`questions.jsonl`의 능력 라벨 필드명은 **`question_type`**이다 (`SCHEMA.md`: "memory ability
category"). 그런데 실제 값은 5개가 아니라 **7개**다 — `-abs`(abstention) 접미사가 붙은 변형이
static/dynamic/procedure 셋에 따로 있다. 논문(§3.2: "based on existing static, dynamic, and
workflow questions, we curate abstention questions with wrong premises")과 `DATA_CARD.md`("...
premise-awareness/abstention categories")를 근거로, **이 조각이 직접 내린 매핑**은 다음과
같다 (공식 문서에 7→5 매핑표가 없어 추론했다 — `types.ts`의 `QUESTION_TYPE_TO_ABILITY` 주석
참고):

| `question_type` (raw)     | 문항 수 | → 5능력                |
| ------------------------- | ------: | ---------------------- |
| `static-environment`      |     134 | static state recall    |
| `static-environment-abs`  |      55 | premise awareness      |
| `dynamic-environment`     |      86 | dynamic state tracking |
| `dynamic-environment-abs` |      41 | premise awareness      |
| `procedure`               |      74 | workflow knowledge     |
| `procedure-abs`           |      32 | premise awareness      |
| `errors-gotchas`          |      29 | environment gotchas    |
| **합계**                  | **451** |                        |

능력별 합계: static state recall 134 · dynamic state tracking 86 · workflow knowledge 74 ·
environment gotchas 29 · **premise awareness 128**(=55+41+32). 도메인 분포:
`domain` 필드가 `web` 240건 / `enterprise` 211건.

## §3. judge 접근 가능 여부

**아니오.** 공식 프로토콜은 judge로 `gpt-4o`(이슈 본문 기준) 또는 리포 README 기준
`gpt-5.2`(`medium` reasoning)를 쓰고, 둘 다 `OPENAI_API_KEY`로 인증한다. 이 세션 환경에
`OPENAI_API_KEY`가 **없다** (`ANTHROPIC_API_KEY`도 없음 — mori 자체는 `DEEPSEEK_API_KEY`로
움직인다). 키가 아예 없어 소명 호출 자체가 불가능하다 — 1회 호출로 확인할 대상이 없다.

**대안과 비교 가능성 손실**: mori 벤치가 이미 쓰는 `DeepSeek V4 Flash`를 judge로 쓸 수는
있지만, LMEv2 리더보드에 실린 모든 점수는 `gpt-4o`/`gpt-5.2` judge 기준이다. judge 모델이
바뀌면 (a) 채점 관대함(leniency)이 달라지고 (b) 논문·공식 리더보드의 baseline 점수와 우리
점수를 나란히 놓고 비교할 수 없게 된다 — "OFF/mori/공식 memory tool" 3-arm 내부 비교에는
쓸 수 있어도 "논문 대비 우리가 어디에 있는가"라는 질문에는 답할 수 없다. `OPENAI_API_KEY`를
확보하기 전까지는 내부 비교용으로만 결과를 해석해야 한다.

## §4. 25M 슬라이스 경계 실측

측정 방법: `trajectories.jsonl`을 전량(1,870개 트라젝토리) 다운로드해 각 트라젝토리를
직렬화한 JSON 한 줄의 **문자 수 ÷ 4**로 토큰을 근사했다 (표준 GPT류 근사치 — 이 리포에
토크나이저 의존성이 없어 실제 토크나이저를 새로 들이는 대신 근사를 썼다; 논문이 보고하는
"최대 115M 토큰"과 아래 실측 최대값 140M 사이의 차이는 이 근사 오차 + 논문이 어떤 토크나이저를
썼는지 불명인 데서 온다 — **정확한 수치가 아니라 절단 위치의 근사 오더**로 읽어야 한다).

**small tier(도메인 공유 100개 트라젝토리)는 25M을 넘지 않는다**: web 도메인 100개 합계
≈19.3M 토큰, enterprise 도메인 100개 합계 ≈23.4M 토큰. 25M 절단은 **medium tier(문항별 최대
500개)에서만 의미가 있다.**

medium tier 451개 문항 전부를 실측(각 문항의 해시스택을 트라젝토리 순서대로 누적):

- 451개 문항 **전부** 전체 해시스택 합계가 25M 토큰을 넘는다 (즉 모든 문항이 25M 슬라이스를
  적용하려면 실제로 잘라야 한다 — "이미 25M 미만이라 자를 필요 없는" 문항은 0건).
- 해시스택 총합: 최소 27,870,937 토큰(문항 `f9f9cd61`, web, n=387) ~ 최대 140,388,451
  토큰(문항 `e033e796`, enterprise, n=500) ~ 중앙값 75,642,565 토큰(문항 `2ca2d443`, web,
  n=500).
- 25M 토큰을 넘기는 **트라젝토리 번호**(세션 순번): 최소 76번째 ~ 중앙값 138번째 ~ 최대
  395번째 (문항마다 트라젝토리당 토큰 수가 달라 절단 지점이 문항별로 크게 흔들린다).

누적 토큰 표 — **최악 사례**(문항 `e033e796`, enterprise, 500개, 총 140.4M):

| 트라젝토리 # |                   누적 토큰 |
| -----------: | --------------------------: |
|           10 |                   3,211,971 |
|           25 |                   7,965,806 |
|           50 |                  14,712,079 |
|       **96** | **25,011,620 ← 25M 절단선** |
|          100 |                  25,800,507 |
|          150 |                  39,772,601 |
|          200 |                  51,751,030 |
|          300 |                  82,971,904 |
|          400 |                 114,046,432 |
|          500 |                 140,388,451 |

중앙값 사례(문항 `2ca2d443`, web, 500개, 총 75.6M):

| 트라젝토리 # |                   누적 토큰 |
| -----------: | --------------------------: |
|          100 |                  20,077,019 |
|      **132** | **25,055,553 ← 25M 절단선** |
|          150 |                  27,236,445 |
|          500 |                  75,642,565 |

**결론**: 25M 슬라이스는 문항마다 다른 트라젝토리 수(76~395개, 중앙값 138개)에서 잘린다 —
"트라젝토리 N개까지만 ingest"처럼 문항 전체에 공통된 고정 컷은 쓸 수 없고, **문항별로 누적
합을 실측해 절단 지점을 정해야 한다.** 다음 조각(ingestion 실행)이 이 실측을 그대로 재사용할
수 있도록 위 절단 방법(문항별 haystack 순서대로 누적, 25M 넘는 지점에서 정지)을 여기 남긴다.

## §5. 로더 — 기존 공통 기반과의 연결

`packages/mori/src/bench/longmemeval-v2/`에 최소 로더를 뒀다: `types.ts`(스키마 타입 +
`question_type`→5능력 매핑), `data-dir.ts`(`MORI_BENCH_LMEV2_DATA_DIR` 환경변수 —
`cache/bench-cache-dir.ts`의 `resolveBenchCacheDir`와 같은 관례), `loader.ts`(`questions.jsonl`
/ `trajectories.jsonl` 파싱, 세션 경계=트라젝토리 경계 검증), `fetch-dataset.ts`(취득 스크립트
— HF `resolve/<revision>` URL에서 plain HTTPS로 받는다, `huggingface_hub` 불필요),
`print-question-count.ts`(재현 명령). **`runner.ts`/`batch/`/`cache/`/`cost-ledger.ts`(#342)에는
아직 배선하지 않았다** — 이 로더는 순수 데이터 변환만 하고, LLM 호출·비용 기록·배치 제출은
전혀 하지 않는다. 다음 조각(ingestion 실행)이 `createBenchRunner`의 `reader`로 트라젝토리
텍스트(`accessibilityTree`/`thought`/`action`)를 흘려보내는 지점이 될 것이다 — 다만 "구조적
경고"에서 적었듯, mori의 세션/턴 모델과 이 트라젝토리 모델(브라우저 상태/행동)을 어떻게
대응시킬지는 이 조각이 정하지 않는다.

### 재현 명령

```bash
# 1회: 데이터 받기 (questions + haystacks만, trajectories.jsonl 1.1GB는 --skip-trajectories로 생략 가능)
pnpm exec tsx packages/mori/src/bench/longmemeval-v2/fetch-dataset.ts --skip-trajectories

# 재현 명령 (owner가 그대로 실행해 문항 수를 검산한다)
MORI_BENCH_LMEV2_DATA_DIR="$HOME/.cache/mori/bench/longmemeval-v2" \
  pnpm exec tsx packages/mori/src/bench/longmemeval-v2/print-question-count.ts
```

기대 출력 (§2 표와 동일):

```
total questions: 451
  static-state-recall: 134
  dynamic-state-tracking: 86
  workflow-knowledge: 74
  environment-gotchas: 29
  premise-awareness: 128
```

## 완료 조건 대조

- [x] 배포처 URL·라이선스·파일 목록/크기 — §1.
- [x] 실제로 센 문항 수(451, 일치) — §1.
- [x] 5능력 라벨의 필드명(`question_type`)과 능력별 문항 수 — §2.
- [x] 재현 명령 한 줄 — §5, `print-question-count.ts`가 실제 파일에서 문항 수를 출력.
- [x] 25M 슬라이스 경계표 — §4.
- [x] judge 접근 가능 여부 예/아니오 + 근거 — §3.
- [x] 데이터셋 원본 미커밋 — `fetch-dataset.ts`/경로 규약만 커밋, `questions.jsonl` 등
      실제 데이터 파일은 리포에 없음 (fixtures는 손으로 쓴 수 KB 픽스처).
- [x] `pnpm build` 통과.
