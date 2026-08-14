# 임계 도달 압축 기준선 — `compactIfContextFull` 자연 발화 시나리오 (#442, #7 선행)

> **결과 기록 · 동결됨 (커밋 `6ab57096a29934b5d644fe3506bcbeae25036818` 시점).** 이 문서는
> 그 시점의 실측이며 오늘의 코드를 보증하지 않는다. **갱신하지 않는다** — 낡으면 새 문서가
> 대체(supersede)한다.

[#442](https://github.com/shakystar/mori/issues/442)의 결과 문서다 — `packages/mori/src/cli/compaction-baseline.test.ts`(새 시험)의 실측을 기록한다.

## 결론

**`compactIfContextFull`을 통해 자연 발화한 압축은, 압축 직전 가장 최근 응답(`retainedTail`)에
있던 정보는 verbatim으로 보존하지만, 그보다 오래된 정보는 오늘 배선(요약 계약 자체)이
아무것도 보장하지 않는다.** 이번 시나리오에서 심은 두 사실 중 **파일 경로(최근 turn)는
압축 후 컨텍스트에 그대로 남았고, 결정문(더 오래된 turn)은 사라졌다.**

다만 이 결과가 답하는 것은 **압축의 결정적 구조(트리거 임계·컷포인트·retainedTail)**
뿐이다 — 컷 이전으로 밀린 정보를 **실제 요약 LLM이 얼마나 보존하는가**는 이 시험의 범위
밖이다(§비고 참고). 그 축은 #401의 몫이다.

## (a) 발화 임계와 도달 방법

- 임계 정의는 pi-agent-core `shouldCompact`: `estimateContextTokens(messages).tokens >
model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens`.
- 이 시나리오의 모델(anthropic `claude-sonnet-4-6`)은 `contextWindow = 1,000,000`,
  `reserveTokens = 16384` → 발화 임계는 컨텍스트 토큰 `983,616` 초과.
- **도달 방법: 임계 주입** (이슈가 권한 저비용 경로). 실제 창을 채우는 대신, 세 번째 턴의
  provider 응답에 `usage.totalTokens = 10,000,000`을 스크립트로 보고시켜 `shouldCompact`가
  그 턴 직후 참을 반환하게 만들었다 — `compaction.test.ts`가 이미 쓰는 동일한 기법
  (`OVER_THRESHOLD`)이다. 컨텍스트 자체는 `session.compact()`를 직접 부르지 않았다:
  `compactIfContextFull(agent, onError)`을 매 턴 뒤 호출해, 그 함수 내부의 임계 판정이 스스로
  `agent.compact()`를 부르게 했다(`rg -n 'compact\(\)' packages/mori/src/cli/compaction-baseline.test.ts` = 0건).
- `retainedTail`이 실제로 무언가를 남기게 하려면(=컷할 이력이 있으려면) 턴 응답 하나가
  `keepRecentTokens`(20,000 토큰 ≈ 80,000자, pi의 chars/4 어림)를 혼자 넘어서야 한다 — 그래서
  각 턴 본문을 84,000자로 채웠다(`LONG_REPLY_CHARS`, 역시 `compaction.test.ts`와 동일 상수).

## (b) 잘려나간 메시지 수

- 압축 직전 엔트리 로그: **6개** (user·assistant 페어 3턴). 압축이 발화하며 **7번째 엔트리
  (compaction 엔트리)**가 append됐다 — pi의 압축은 삭제가 아니라 append이므로 엔트리 로그
  자체는 그대로 6에서 7로 **늘었다**(#409 정본 문서 §Q3와 일치).
- 다음 턴에 실제로 전송되는 컨텍스트 메시지 수는 **5개 → 3개**로 줄었다:
  - 압축 직전 컨텍스트: `user, assistant(TURN-1, 결정 포함), user, assistant(TURN-2), user(TURN-3 프롬프트)`.
  - 압축 직후 컨텍스트: `user(요약), assistant(TURN-3 응답, 파일 경로 포함), user(회상 질문)`.
  - 즉 **원본 메시지 4개(턴1 user+assistant, 턴2 user+assistant)가 요약 메시지 1개로
    흡수**됐고, **턴3의 assistant 응답만 verbatim으로 유지**됐다.
- 흥미로운 관찰: 컷포인트가 턴3 **중간**(사용자 프롬프트와 그 응답 사이)에 떨어져
  `isSplitTurn`이 참이 됐다 — 턴3의 **사용자 프롬프트**는 "Turn Context (split turn)" 절로
  요약 쪽에 흡수되고, **턴3의 assistant 응답만** `retainedTail`로 남았다. 다음 턴이 보는
  컨텍스트에 턴3의 원 질문("three")이 그대로 남아있지 않다는 뜻이다.

## (c) 압축 요약 전문

이 시험은 `compaction.test.ts`와 동일하게 압축 요약 LLM 호출을 결정적 스크립트 provider로
대체한다(시스템 프롬프트로 턴 요청과 구분, §비고). 실제로 다음 턴 컨텍스트에 삽입된 요약
전문은:

```
The conversation history before this point was compacted into the following summary:

<summary>
COMPACTED-SUMMARY

---

**Turn Context (split turn):**

COMPACTED-SUMMARY
</summary>
```

(`COMPACTED-SUMMARY`는 시험이 지정한 고정 placeholder 문자열이다 — 실제 서비스 배선에서는
`generateSummary`가 모델에 요청해 받은 실제 요약 텍스트가 이 자리에 들어간다.)

## (d) 결정·파일 경로 회상 판정 결과

기계적 판정(문자열 포함 검사, judge 모델 미도입) — 압축 후 컨텍스트에 각 사실이 그대로
남아 있는지로 판정했다:

| 심은 사실                                                     | 심은 위치                       | 압축 후 컨텍스트에 남았는가 |
| ------------------------------------------------------------- | ------------------------------- | --------------------------- |
| 결정 1건 (`결정: 세션 저장소를 SQLite에서 Postgres로 옮긴다`) | 턴1 (요약 대상 구간)            | **아니오** — 사라짐         |
| 파일 경로 1건 (`packages/mori/src/session.ts`)                | 턴3 (압축 직전 최근 구간, tail) | **예** — verbatim 유지      |

대응 시험: `compaction-baseline.test.ts`의
`"retains the recent file path across a naturally-triggered compaction"`(경로) /
`"loses the older decision once it falls past the retained tail"`(결정) — 각 사실당 시험
하나, 총 2건.

## 비고 — 이 결과가 답하지 않는 것

- **요약 LLM의 실제 보존 품질.** 위 결과는 `retainedTail`의 결정적(비-LLM) 유지 메커니즘만
  실측한다. 실제 배선에서 요약을 만드는 것은 모델이고, 그 모델이 결정문 같은 오래된 정보를
  얼마나 잘 압축해 담는지는 이 스크립트 provider로는 잴 수 없다 — 그 실측(정량 점수)은
  #401의 `memory-off` 팔(하네스 기본 압축 요약) 몫이다. 이 문서는 그 축의 "오늘의 압축이
  이미 하고 있는 일"의 **구조적** 기준선이지, 요약 품질 기준선이 아니다.
- **judge 모델 도입 없음.** 이슈 비범위 그대로, 회상 품질을 점수화하는 별도 judge는 쓰지
  않았다 — 문자열 포함 검사로 충분했다.
- **증류·재주입 경로.** #7 본 설계(요약이 잃은 것을 커널 증류로 되살릴지)는 여기서 다루지
  않는다 — #401·#402의 숫자가 나와야 전제가 선다.
