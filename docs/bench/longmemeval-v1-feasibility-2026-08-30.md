# LongMemEval-V1(longmemeval-cleaned) 로더 + 세션 모델 확정 (#507, #344 조각 2/4)

> **판정 기록 · 동결됨 (커밋 `a8669d1` 시점).** 이 문서는 그 시점의 기록이며 오늘의 코드를
> 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가 대체(supersede)한다. 인용이 코드와
> 어긋나 보이면 이 문서가 아니라 코드를 따른다.

## 판정 먼저

- **데이터셋은 실존하고 실제로 받아진다.** 실제 `longmemeval_s_cleaned.json`(≈277MB)을
  전량 다운로드해 500문항을 직접 파싱·검증했다 (아래 §1).
- **라이선스(MIT)와 judge 요구사항(공식 gpt-4o, 이 로드맵은 DeepSeek으로 대체)은 이미
  2026-08-10 · 2026-08-30 사람 결정으로 확정됐다 — 이 문서에서 재조사하지 않는다.**
- 실제 파일 검증 중 로더 설계 당시 예상하지 못한 스키마 함정 2건을 발견해 로더에서
  흡수했다 (§2) — 둘 다 커밋 `a8669d1`에 반영·테스트됨.
- 세션 모델 매핑(§4): v1의 "session"(role/content 턴 배열)은 mori의 턴 모델과 필드
  수준에서는 직접 대응하지만, **양쪽 역할(user/assistant)의 원문을 그대로 보존해야 한다**
  는 제약이 있다 — 자세한 근거는 §4.

## §1. 배포처·파일 확인

| 항목       | 값                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 논문       | arXiv [2410.10813](https://arxiv.org/abs/2410.10813) — "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory" (ICLR 2025)                                                       |
| 데이터셋   | [huggingface.co/datasets/xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (2025-09 정제판), revision `98d7416c24c778c2fee6e6f3006e7a073259d48f` — MIT |
| 대상 split | `LongMemEval_S`, 파일 `longmemeval_s_cleaned.json` — 일반 HTTPS로 직접 받아짐(LFS 아님, `huggingface_hub` 불필요)                                                                                    |
| 파일 크기  | 277,383,467 B (≈277MB), `curl -I`로 확인                                                                                                                                                             |

전량 다운로드 후 `JSON.parse`로 파싱해 직접 셌다:

```
$ node -e '... loadQuestions 등가 로직으로 전량 파싱 ...'
count: 500
```

**500 — 이슈·논문이 말하는 문항 수와 일치한다.**

읽기·파싱 성능(같은 세션 환경, 힙 상한 지정 없이):

```
read ms: 2591  parse ms: 913  count: 500  peak rss: ~892 MB
```

277MB 단일 JSON 배열이지만 Node 기본 힙으로 무리 없이 처리된다 — v2(`trajectories.jsonl`,
1.1GB, `--max-old-space-size` 필요)와 달리 이 로더는 스트리밍이 필요 없다
(`loader.ts`의 `loadQuestions` 독스트링에도 근거로 남겨뒀다).

## §2. 스키마 — 능력 라벨 매핑 + 실물 검증 중 발견한 함정 2건

### 능력 라벨: `question_type`(6값) + `_abs` 접미사 → 5능력

논문(§1)이 말하는 5개 능력은 raw `question_type`(6값)과 1:1이 아니다 — abstention은
별도 필드가 아니라 `question_id`가 `_abs`로 끝나는지로 식별된다. 전량 실측:

| `question_type` (raw)       | 문항 수 | 그중 `_abs` | → 능력                  |
| --------------------------- | ------: | ----------: | ----------------------- |
| `single-session-user`       |      70 |           6 | information extraction  |
| `single-session-assistant`  |      56 |           0 | information extraction  |
| `single-session-preference` |      30 |           0 | information extraction  |
| `multi-session`             |     133 |          12 | multi-session reasoning |
| `knowledge-update`          |      78 |           6 | knowledge updates       |
| `temporal-reasoning`        |     133 |           6 | temporal reasoning      |
| **합계**                    | **500** |      **30** |                         |

능력별 합계(abstention 제외분을 각 base 능력에서 뺀 뒤 abstention 30건을 별도 집계) —
`print-question-count.ts`의 실제 출력과 일치:

```
total questions: 500
  information-extraction: 150
  multi-session-reasoning: 121
  knowledge-updates: 72
  temporal-reasoning: 127
  abstention: 30
```

`single-session-preference`→information extraction 매핑은 공식 문서가 명시하지 않는
**이 조각의 판단**이다 — 논문이 세 개 single-session 타입을 구성 방법론상 한 그룹으로
묶어 설명하고 5능력 중 별도 버킷을 주지 않기 때문(근거·인용 전문은
`types.ts`의 `QUESTION_TYPE_TO_ABILITY` 독스트링). 능력별 채점을 다시 쓸 일이 있으면
이 판단을 다시 검토할 것.

### 함정 1 — `answer`가 32/500 문항에서 문자열이 아니라 bare number

`multi-session` 타입의 "몇 개/몇 번" 류 개수 질문 32건에서 `answer` 필드가 JSON 문자열이
아니라 **bare number**로 저장돼 있다 (예: `question_id="0a995998"`, `answer: 3`). 다른
6개 필드(`question_id`/`question_type`/`question`/`question_date`/`answer_session_ids[]`/
`haystack_session_ids[]`/`haystack_dates[]`)는 전량 문자열로 일관됨을 확인했다 — `answer`만의
함정이다. 로더 초안은 이 필드도 `requireString`으로 거부했는데, 실물 검증에서 32건 전부가
loud fail로 죽는 것을 보고 발견했다. **결정: `LongMemEvalQuestion.answer`는 항상
`string`으로 유지하고, 로더가 `coerceAnswerToString`으로 숫자를 문자열 변환한다** — judge가
어차피 텍스트로 비교하므로 타입을 굳이 나눌 이유가 없다. `loader.test.ts`에 회귀 fixture
(`fx-q8`, `answer: 2` → `"2"`) 고정.

### 함정 2 — `content`가 12/246,750 턴에서 빈 문자열

전체 246,750개 haystack 턴 중 12건(user 9 · assistant 3)이 `content: ""`다 — 필드
누락이 아니라 **원본 대화 로그의 실제 공백 메시지**다(`content`는 데이터셋 전체에서
타입이 항상 `string`, `null`/누락은 0건 — 값이 가끔 비어있을 뿐). 로더 초안은
`requireString`(빈 문자열 거부)을 재사용해 이 12건에서 loud fail했다. **결정: `content`
전용 검증기(`requireContentString`)를 분리해 빈 문자열을 허용**한다 — 다른 필드
(`question`/`answer` 등)의 빈 문자열은 여전히 loud fail 대상으로 남긴다(그쪽은 실제로
빈 값이 나온 적이 없고, 나오면 진짜 이상 데이터일 가능성이 높다). `loader.test.ts`에
회귀 fixture(`fx-q9`) 고정.

### 그 외 실물 검증으로 확인한 구조적 사실(로더가 이미 반영)

- **haystack 세션 id는 문항 내에서 유일하지 않다** — 같은 `sessionId`가 다른 위치·날짜로
  재등장하는 문항이 500개 중 13건. `(sessionId, index)`로 식별해야 하며, `sessionId`
  단독으로는 세션을 구분할 수 없다(`types.ts`의 `LongMemEvalHaystackSession.sessionId`
  독스트링, `loader.test.ts`의 fx-q3 fixture로 고정).
- **`has_answer` 필드는 세션 단위로 전부 있거나 전부 없다** — 부분적으로만 라벨된 세션은
  0건(23,867개 세션 전수 확인). 정답 근거 세션은 모든 턴에 `has_answer: true`/`false`가
  붙고, filler 세션은 필드 자체가 없다.
- 정답 근거로 라벨된 턴(`has_answer: true`) 896건 중 **842건은 user 턴, 54건은 assistant
  턴**이다 — `single-session-assistant` 문항(예: "어시스턴트가 추천한 스트레칭은?")처럼
  답이 assistant의 발화 내용 자체인 경우가 실재한다. §4의 세션 매핑 결정에 직결되는
  숫자다.
- `answer_session_ids`의 모든 원소가 같은 문항의 `haystack_session_ids`에 존재함을
  500문항 전수 확인(불일치 0건).
- haystack 세션 턴 수 분포: 최소 1, 중앙값 12, p90 12, 최대 132. 문항당 평균 47.7개
  세션. 전체 대화 텍스트 근사 토큰 수(문자수÷4): 총 ≈61.2M, 문항당 평균 ≈122k — 이슈
  본문이 인용한 "문항당 ≈115k tok"과 오더가 일치한다(근사 방식 차이로 인한 편차, v2
  feasibility 문서와 같은 이유로 정확한 토크나이저 수치가 아니라 오더로 읽는다).
- 날짜 필드(`question_date`/`haystack_dates[]`)는 ISO 8601이 아니라 자유 텍스트
  `"YYYY/MM/DD (Ddd) HH:MM"` 형식이다 — 로더는 파싱하지 않고 원문 그대로 보관한다
  (파싱은 이 조각의 범위 밖).

## §3. judge 요구사항 (재조사 아님 — 인용)

이슈 본문 인용: "공식 judge는 GPT-4o이고 `OPENAI_API_KEY`를 요구하지만(README
`export OPENAI_API_KEY=...`), 이 로드맵은 DeepSeek을 judge로 쓴다 — 키 요구사항을 다시
조사하지 마라(2026-08-30 사람 결정 코멘트가 그 확인이다)." 이 문서는 이 결정을 그대로
인용할 뿐 재확인하지 않는다. `OPENAI_API_KEY` 부재는 이 조각의 차단 사유가 아니다.

## §4. mori 세션 모델 매핑 결정 (문서만 — 구현은 조각 3/4)

**v1의 "session"은 v2(웹 에이전트 트라젝토리)와 달리 정말로 대화 세션이다** — `role`
(`user`/`assistant`)과 `content`(자유 텍스트)만 있는 턴의 순서 배열. 이는 필드 수준에서
mori의 턴 모델(`session.ts`의 `MoriSession`/`MoriSessionTurn` — 텍스트를 넣고 텍스트를
받는 프롬프트-응답 쌍)과 형태가 같다.

**그러나 그대로 `MoriSession.prompt(text)`에 흘려 넣을 수는 없다.** `prompt()`는 매
호출마다 **실제 LLM을 호출해 assistant 응답을 새로 생성**한다(`session.ts`:
"Runs one turn to completion" — 세션의 실제 provider 왕복). haystack 세션의 assistant
턴은 데이터셋에 이미 고정된 과거 발화이고, §2에서 실측했듯 **54개 문항의 정답 근거가
바로 그 assistant 발화 자체**다(`single-session-assistant` 타입). `prompt()`로 재생하면
라이브 모델이 매번 다른 assistant 텍스트를 새로 생성하므로, 원본 assistant 턴의 내용을
잃고 그 54개 문항은 애초에 답할 수 없는 질문이 된다.

**결정: ingestion(조각 3/4)은 haystack 세션의 user/assistant 턴 원문을 그대로,
`prompt()`의 라이브 생성 경로를 거치지 않고 mori 커널에 과거 사실로 주입해야 한다.**
`MoriSession`(session.ts) 레벨에는 이런 "생성 없이 과거 턴을 그대로 심는" API가 없다 —
가장 가까운 기존 패턴은 커널의 `services/memory-import-service.ts`(사전 추출된 메모리
항목을 이벤트 로그에 직접 append, LLM 호출 없이)이지만 이건 "이미 증류된 메모리 항목"을
받지 "원문 대화 턴"을 받지 않는다. 즉 **조각 3/4은 새로운 주입 경로가 필요하다** —
haystack 세션 턴을 (a) mori의 통상적 대화 증류 파이프라인에 태워 메모리로 흡수시키거나,
(b) `event-store.ts`의 `appendEvents`를 세션 재생 전용으로 직접 호출하는 저수준 경로 중
하나를 택해야 한다. 어느 쪽이든 **assistant 턴의 원문 텍스트를 보존**해야 한다는 제약은
동일하다 — 이 조각은 그 제약과 두 후보만 문서화하고, 택일·구현은 하지 않는다(비범위).

질문 자체(`question`)는 별도로 취급한다 — haystack 재생이 끝난 뒤 실제
`MoriSession.prompt(question)`을 호출해 라이브 응답을 받고, 그 응답을 judge가 `answer`와
비교하는 것이 벤치의 통상 프로토콜과 일치한다(질문은 라이브로 묻는 것이 맞다 — 답을 이미
알고 있는지 재는 것이 벤치의 목적이므로).

## §5. 로더 산출물

`packages/mori/src/bench/longmemeval-v1/`:

- `types.ts` — 스키마 타입 + `question_type`→5능력 매핑(`QUESTION_TYPE_TO_ABILITY`) +
  `abilityForQuestion`(알 수 없는 값에 loud fail).
- `data-dir.ts` — `MORI_BENCH_LMEV1_DATA_DIR` 환경변수(v2의 `resolveLongMemEvalDataDir`
  관례와 동일).
- `loader.ts` — `longmemeval_s_cleaned.json` 파싱, §2의 함정 2건 흡수, 구조적 불변식
  검증(길이 일치, `answer_session_ids` ⊆ `haystack_session_ids`, 중복 `question_id` 거부).
- `fetch-dataset.ts` — 취득 스크립트, HF `resolve/<revision>` URL에서 plain HTTPS로 받는다.
- `print-question-count.ts` — 재현 명령(문항 수 + 능력별 분포 출력).
- `fixtures/questions.json` + `loader.test.ts` — 실제 다운로드 없이 커밋된 소형 fixture로
  9문항 검증(6개 base type + abstention + 세션 replay + has_answer 세션 단위 라벨 +
  §2의 함정 2건 회귀).

### 재현 명령

```bash
# 1회: 데이터 받기
corepack pnpm exec tsx packages/mori/src/bench/longmemeval-v1/fetch-dataset.ts

# 재현 명령 (owner가 그대로 실행해 문항 수·능력 분포를 검산한다)
MORI_BENCH_LMEV1_DATA_DIR="$HOME/.cache/mori/bench/longmemeval-v1" \
  corepack pnpm exec tsx packages/mori/src/bench/longmemeval-v1/print-question-count.ts
```

기대 출력 (§2와 동일):

```
total questions: 500
  information-extraction: 150
  multi-session-reasoning: 121
  knowledge-updates: 72
  temporal-reasoning: 127
  abstention: 30
```

## 비범위 (조각 3/4·4/4로 이월)

- §4가 남긴 두 후보 중 택일 + 실제 ingestion 구현.
- 3-arm 러너·Batch API·DeepSeek judge 배선.
- 실제 벤치 실행.
- 라이선스·judge 요구사항 재조사 — 이미 확정됨(§3 인용 그대로).
