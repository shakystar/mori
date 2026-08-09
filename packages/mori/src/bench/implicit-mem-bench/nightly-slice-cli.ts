#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
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
import { unauthenticatedMessage } from "../../cli/messages.js";
import { writeCostReport } from "../cost-ledger.js";
import { runNightlySlice, type NightlySliceReport } from "./nightly-slice.js";

export interface NightlySliceCliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

interface ParsedArgs {
  repeats?: number;
  out: string;
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join("bench-reports", `nightly-slice-${stamp}.json`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let repeats: number | undefined;
  let out: string | undefined;

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
    } else {
      throw new Error(`mori bench: 알 수 없는 인자 "${String(arg)}" (지원: --repeats, --out)`);
    }
  }

  return { ...(repeats === undefined ? {} : { repeats }), out: out ?? defaultOutPath() };
}

/** 리포트를 기록하고, `report.scenarios.length === 0`이면 stderr에 사유를 남기고 0이 아닌 종료
 * 코드를 반환한다 — 그렇지 않으면 대상 0건이 "측정했고 문제 없었다"와 구별되지 않는 그린으로
 * 새어 나간다(PR 스모크 층의 #405 선례와 같은 회귀, #416). auth 해석과 분리해 둔 이유는 이
 * 판정 로직만 순수 함수로 직접 테스트하기 위해서다(milestone-cli.ts의 `reportMilestoneOutcome`
 * 선례를 따른다). */
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

  const cacheDir = await mkdtemp(join(tmpdir(), "mori-nightly-slice-cache-"));
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
