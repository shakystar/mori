#!/usr/bin/env node
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMoriModels } from "../../agent/model-wiring.js";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "../../agent/provider-selection.js";
import { defaultCredentialsPath, FileCredentialStore } from "../../auth/credential-store.js";
import { isMainEntry } from "../../cli/entrypoint.js";
import { consolidateModelRequiredMessage, unauthenticatedMessage } from "../../cli/messages.js";
import { resolveConsolidatorConfig } from "../../external/consolidator/config.js";
import { resolveBenchCacheDir } from "../cache/bench-cache-dir.js";
import { writeCostReport } from "../cost-ledger.js";
import { runNightlySlice, type NightlySliceReport } from "./nightly-slice.js";

export interface NightlySliceCliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

interface ParsedArgs {
  repeats?: number;
  out: string;
  cacheDir?: string;
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join("bench-reports", `nightly-slice-${stamp}.json`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let repeats: number | undefined;
  let out: string | undefined;
  let cacheDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repeats") {
      const value = argv[++i];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `mori bench: --repeats는 1 이상의 정수여야 한다 (받은 값: "${String(value)}")`,
        );
      }
      repeats = parsed;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("mori bench: --out에 경로가 필요하다");
      out = value;
    } else if (arg === "--cache-dir") {
      const value = argv[++i];
      if (!value) throw new Error("mori bench: --cache-dir에 경로가 필요하다");
      cacheDir = value;
    } else {
      throw new Error(
        `mori bench: 알 수 없는 인자 "${String(arg)}" (지원: --repeats, --out, --cache-dir)`,
      );
    }
  }

  return {
    ...(repeats === undefined ? {} : { repeats }),
    ...(cacheDir === undefined ? {} : { cacheDir }),
    out: out ?? defaultOutPath(),
  };
}

/** 리포트를 기록하고 종료 코드를 정한다.
 *
 * 1. `report.scenarios.length === 0`이면 — 대상 0건이 "측정했고 문제 없었다"와 구별되지 않는
 *    그린으로 새어 나간다(PR 스모크 층의 #405 선례와 같은 회귀, #416).
 * 2. `report.killSwitch.invalid`이면 — ORACLE(정답을 통째로 준 팔)과 OFF(하네스 압축 요약만
 *    받은 팔)의 점수 간격이 임계값(kill-switch.ts) 미만인 시나리오가 하나라도 있으면, 그
 *    시나리오는 "정답을 알아도 점수가 안 오른다"는 뜻이라 그 위에서 잰 mori 점수가 아무것도
 *    말하지 못한다(#435, milestone-cli.ts `reportMilestoneOutcome`의 4번째 가드와 같은 판정).
 *    재실행으로 바뀌는 판정이 아니다 — 시나리오가 잴 수 있는 물건이 아니라는 뜻이므로, 이
 *    호출자는 재시도 대신 이 회차의 관측 결과로 보고해야 한다(#401).
 * 3. `report.killSwitch.scenarios`가 비어 있으면 — 시나리오는 돌았는데 킬 스위치가 판정한
 *    시나리오가 0건이면, ORACLE·OFF 두 팔이 함께 실행된 시나리오가 없어서
 *    `computeKillSwitchReport`가 전부 건너뛴 것이다(kill-switch.ts의 `continue`). 그때
 *    `invalid`는 `some()`이라 `false`가 되므로, 이 가드가 없으면 **판정을 한 번도 못 한 회차가
 *    그린으로 나간다** — 2번 가드가 통째로 꺼진 채 통과하는 것과 같다(#401). 1번 가드와
 *    분리해 두는 이유는 세는 대상이 다르기 때문이다: 1번은 실행 결과 건수, 이것은 판정 건수다.
 *
 * auth 해석과 분리해 둔 이유는 이 판정 로직만 순수 함수로 직접 테스트하기 위해서다(milestone-cli.ts의
 * `reportMilestoneOutcome` 선례를 따른다). */
export function reportNightlySliceOutcome(
  report: NightlySliceReport,
  out: string,
  io: NightlySliceCliIO,
): number {
  io.stdout(
    `mori bench: 나이틀리/주간 슬라이스 완료 — 반복 ${String(report.repeatsPerScenario)}회, ` +
      `시나리오 결과 ${String(report.scenarios.length)}건, 총비용 $${report.total.cost.total.toFixed(4)}, ` +
      `비용 리포트: ${out}\n`,
  );
  if (report.scenarios.length === 0) {
    io.stderr("mori bench: 실행된 시나리오가 0건이다 — 가드가 헛돈 것이므로 실패로 처리한다.\n");
    return 1;
  }
  if (report.killSwitch.scenarios.length === 0) {
    io.stderr(
      "mori bench: 킬 스위치가 판정한 시나리오가 0건이다 — ORACLE·OFF 두 팔이 모두 실행된 " +
        "시나리오가 하나도 없다는 뜻이라 판정 자체가 서지 않았다. 무판정을 그린으로 내보내지 " +
        "않는다.\n",
    );
    return 1;
  }
  if (report.killSwitch.invalid) {
    const invalidScenarios = report.killSwitch.scenarios.filter((s) => s.invalid);
    io.stderr(
      `mori bench: 킬 스위치 발동 — ORACLE−OFF 간격이 임계값(${String(report.killSwitch.threshold)}) ` +
        `미만인 시나리오 ${String(invalidScenarios.length)}건: ` +
        `${invalidScenarios.map((s) => `${s.scenarioId}(gap=${String(s.gap)})`).join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * `mori-nightly-slice` — #406(#397 조각 2/3). 나이틀리/주간 크론이 부르는 진입점: 실 인증
 * (`FileCredentialStore`)과 실 provider 스트림(`models.streamSimple`)으로
 * `runNightlySlice`를 구동하고, 결과를 `writeCostReport`로 JSON에 남긴다. 인증/모델 해석은
 * `cli/runtime.ts`의 `prepareAgent`와 같은 경로(`createMoriModels` → `checkAuth` →
 * `getModel`)를 그대로 밟는다 — 이 스크립트만의 별도 인증 로직은 없다.
 */
export async function runNightlySliceCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: NightlySliceCliIO = {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  },
): Promise<number> {
  const args = parseArgs(argv);

  // #452: 이 CLI는 항상 세 팔(memory-off/memory-on/oracle)을 함께 돌린다 — 어느 팔이
  // 도는지 걸러낼 지점이 없으므로 무조건 요구한다(이슈 #452 기본안). 인증·프로바이더
  // 검사와 같은 층·같은 종료 규약: 에피소드를 하나도 돌리기 전에 실패한다.
  if (!resolveConsolidatorConfig(env)) {
    io.stderr(consolidateModelRequiredMessage());
    return 1;
  }

  const { providerId, modelId } = resolveProviderSelection(env);
  if (!supportedProviderIds(env).includes(providerId)) {
    io.stderr(unknownProviderMessage(providerId, env));
    return 1;
  }

  const credentialStore = new FileCredentialStore(defaultCredentialsPath(env), io.stderr);
  const models = createMoriModels(env, credentialStore);
  const authCheck = await models.checkAuth(providerId);
  if (!authCheck) {
    io.stderr(unauthenticatedMessage(providerId));
    return 1;
  }

  const model = models.getModel(providerId, modelId);
  if (!model) {
    io.stderr(
      `mori bench: 알 수 없는 모델 "${modelId}" (프로바이더 "${providerId}").\n` +
        `사용 가능한 모델: ${models
          .getModels(providerId)
          .map((m) => m.id)
          .join(", ")}\n`,
    );
    return 1;
  }

  // #422: `cacheDir` is a fixed, reused-across-runs path (unlike `workRoot`/`memorizeRootBase`
  // below, which stay one-mkdtemp-per-run scratch dirs on purpose — see nightly-slice.ts's
  // `runNightlySlice` doc for why those two must never be shared across runs). Reusing the
  // cache dir is what makes a rerun with unchanged scenarios/prompts free instead of full price.
  const cacheDir = resolveBenchCacheDir(args.cacheDir, env);
  await mkdir(cacheDir, { recursive: true });
  const workRoot = await mkdtemp(join(tmpdir(), "mori-nightly-slice-work-"));
  const memorizeRootBase = await mkdtemp(join(tmpdir(), "mori-nightly-slice-store-"));

  const report = await runNightlySlice({
    model,
    streamFn: models.streamSimple.bind(models),
    cacheDir,
    workRoot,
    memorizeRootBase,
    env,
    credentialStore,
    ...(args.repeats === undefined ? {} : { repeatsPerScenario: args.repeats }),
  });

  await writeCostReport(report, args.out);
  return reportNightlySliceOutcome(report, args.out, io);
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runNightlySliceCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `mori bench: 나이틀리/주간 슬라이스 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
