import { defineConfig } from "vitest/config";

// `turbo run test`(정본 게이트 경로, #185)는 각 패키지 디렉터리에서 vitest를 돌리므로
// packages/{kernel,mori}/vitest.config.ts를 그 디렉터리 기준으로 정상 로드한다 — 이 파일이
// 없어도 그 경로는 항상 정본 testTimeout(20000ms, #223)을 썼다.
//
// 문제는 **리포 루트**에서 직접 부르는 `pnpm exec vitest run`이었다(#244) — vitest는 설정을
// project root(기본 `process.cwd()`) 기준으로만 찾고 패키지 안의 설정을 재귀적으로 주워오지
// 않는다. 그래서 루트 실행은 어떤 명시 설정도 못 찾고 vitest 기본값(5000ms)으로 조용히
// 떨어졌다 — `.github/workflows/recheck-open-prs.yml`의 재검증 커맨드가 정확히 이 경로다.
//
// vitest 3의 `projects`로 각 패키지 디렉터리를 프로젝트로 등록하면, 루트에서 실행해도 vitest가
// 각 디렉터리의 기존 vitest.config.ts를 그 프로젝트의 설정으로 로드한다 — testTimeout 값을
// 여기서 재선언하지 않는다(값의 정본은 여전히 패키지별 파일 하나뿐이다, #244 비범위: 값
// 재산정 아님).
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
