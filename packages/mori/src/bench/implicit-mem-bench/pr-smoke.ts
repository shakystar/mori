import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { isMainEntry } from "../../cli/entrypoint.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from "../../agent/provider-selection.js";
import { FileLlmCallCacheStore } from "../cache/file-cache-store.js";
import { createFixtureCacheStreamFn } from "./pr-smoke-cache.js";
import { runImplicitMemBench } from "./runner.js";

/**
 * #397 3계층 케이든스의 "PR 스모크" 층 (#397 조각 1/3) — #374의 `createBenchRunner` +
 * ImplicitMemBench 러너(#387)를 100% 캐시 재생으로 구동해, 그 배선이 여전히 끝까지 도는지를
 * 매 PR마다 값싸게 확인한다. 실제 모델 품질 측정(#388)이나 메모리 주입 실측(consolidation이
 * 실제로 뭔가를 증류하는지)은 의도적으로 이 스크립트의 범위 밖이다 — `MORI_CONSOLIDATE_MODEL`을
 * 비워 둬 consolidation을 꺼진 채로 두고(session.ts/consolidation 계약, 세팅 안 하면 no-op),
 * `pr-smoke-cache.ts`의 고정 응답으로 파이프라인만 끝까지 통과시킨다. 실측 품질은 나이틀리/
 * 주간(#397b, 실비용 API) · 마일스톤(#397c, Batch API) 층의 몫이다.
 *
 * 이 디렉터리의 `pr-smoke-fixtures/cache/`는 커밋되는 픽스처다 — `--record`로 채우고 커밋한다.
 * 코드(시나리오·리더 프롬프트·러너 흐름)가 바뀌어 새 (모델,컨텍스트,파라미터) 조합이 생기면
 * 캐시가 미스하고, 기본 모드(레코드 아님)는 미스 1건이라도 있으면 비정상 종료한다 — "100% 적중"을
 * 로그를 읽어야만 아는 상태로 두지 않는다는 #405 완료 조건.
 */

const FIXTURE_CACHE_DIR = fileURLToPath(new URL("./pr-smoke-fixtures/cache/", import.meta.url));

const MODEL: Model<Api> = {
  id: DEFAULT_MODEL_ID,
  name: "Claude Sonnet (mori bench PR smoke)",
  api: "anthropic-messages",
  provider: DEFAULT_PROVIDER_ID,
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

/** No real credential is ever dialed out to (`pr-smoke-cache.ts`'s `streamFn` never calls a
 * real provider) — this only has to be present so `Models#checkAuth` clears the gate
 * `createMoriSession`/`createMoriAgent` runs before the first turn (session.test.ts's own
 * `ENV`/`InMemoryCredentialStore` pairing does the same for the same reason). */
function fixtureEnv(): NodeJS.ProcessEnv {
  return { ANTHROPIC_API_KEY: "sk-ant-mori-bench-pr-smoke-fixture" };
}

export async function runPrSmoke(options: { record: boolean }): Promise<number> {
  const store = new FileLlmCallCacheStore(FIXTURE_CACHE_DIR);
  const { streamFn, missCount, hitCount } = createFixtureCacheStreamFn(store);

  const workRoot = await mkdtemp(join(tmpdir(), "mori-bench-pr-smoke-work-"));
  const memorizeRoot = await mkdtemp(join(tmpdir(), "mori-bench-pr-smoke-store-"));

  try {
    const report = await runImplicitMemBench({
      model: MODEL,
      streamFn,
      cacheDir: FIXTURE_CACHE_DIR,
      workRoot,
      memorizeRoot,
      env: fixtureEnv(),
      credentialStore: new InMemoryCredentialStore(),
    });

    console.log(
      `mori bench PR smoke: ${report.scenarios.length}개 시나리오×조건 실행 완료 — ` +
        `캐시 hit=${hitCount()} miss=${missCount()}`,
    );

    // `IMPLICIT_MEM_BENCH_SCENARIOS`가 어떤 이유로든 비어버리면 hit/miss가 둘 다 0으로
    // 조용히 "통과"한다 — 대상이 0건일 때 그린이 되는 것이 바로 이 스모크가 막으려는
    // 회귀(#405)이므로, ci.yml의 turbo coverage guard와 같은 원칙으로 여기서도 실패로 만든다.
    if (report.scenarios.length === 0) {
      console.error(
        "mori bench PR smoke: 실행된 시나리오가 0건이다 — 가드가 헛돈 것이므로 실패로 처리한다.",
      );
      return 1;
    }

    if (missCount() > 0) {
      if (options.record) {
        console.log(
          `mori bench PR smoke: 픽스처 ${missCount()}건 신규 기록 (${FIXTURE_CACHE_DIR}) — ` +
            "변경분을 커밋해라.",
        );
        return 0;
      }
      console.error(
        `mori bench PR smoke: 캐시 미스 ${missCount()}건 — 커밋된 픽스처가 현재 코드와 ` +
          "어긋난다. `pnpm bench:pr-smoke:record`로 픽스처를 다시 채우고 커밋해라.",
      );
      return 1;
    }
    return 0;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
    await rm(memorizeRoot, { recursive: true, force: true });
  }
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  const record = process.argv.includes("--record");
  runPrSmoke({ record })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
