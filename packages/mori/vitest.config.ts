import { defineConfig } from "vitest/config";

// vitest 기본 testTimeout(5000ms)은 이 리포 어디에도 정의돼 있지 않은 암묵값이었다(#223) —
// 아무도 고른 적 없는 값에 게이트의 실패 임계값이 걸려 있었다는 뜻이다.
//
// CI `build-and-test`의 per-test duration을 실측했다(캐시 미스 실행 3회, 자체 explicit
// timeout이 없는 케이스만 — bin-entrypoint.test.ts는 아래 참고). 관측된 최대치:
//   - withProjectLock 재확보 레이스(kernel/project-lock-transfer.test.ts): 818ms/753ms/702ms
//   - cap-boundary property invariant2(kernel/cap-boundary-properties.test.ts, #188/#220): 761ms/757ms/723ms
//   - runBash 백그라운드 자식 kill(bash.test.ts, 이 패키지): 611ms/610ms/606ms
//   (run 30880957853, 30879605395, 30880658478 — 세 러너 모두 5000ms 대비 6배 이상 여유,
//   #220이 cap-boundary 3건을 오탐으로 판정한 것과 일치한다.)
//
// 반면 developer가 PR #221에서 로컬 풀스위트로 보고한 근접값(kernel 3건, 4881ms/5000ms,
// 여유 2.4%)은 CI를 대표하진 않지만(#223 본문 — 로컬 벽시계 편차가 큰 샌드박스) 러너가
// 밀리는 조건에서 무슨 일이 나는지의 실측 사례로는 유효하다.
//
// 20000ms = CI 조용한 꼬리(818ms)의 ~24배, 위 경합 관측치(4881ms)의 ~4.1배. #147이
// 프로세스 스폰 케이스에 "관측 꼬리의 ~4.4배"로 30000ms를 고른 것과 같은 자리수다.
// bin-entrypoint.test.ts(30000ms, 이 패키지)·cooperative-cancellation.test.ts(60000ms, kernel)는
// 이 기본값을 웃도는 자기 사유(프로세스 스폰·의도적으로 느린 5s 하트비트 대기)가 있어
// 그대로 자체 timeout을 유지한다 — 이 기본값이 그 둘을 대체하지 않는다.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
