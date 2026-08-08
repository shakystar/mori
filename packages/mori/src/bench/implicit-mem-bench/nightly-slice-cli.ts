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
import { runNightlySlice } from "./nightly-slice.js";

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
  io.stdout(
    `mori bench: 나이틀리/주간 슬라이스 완료 — 반복 ${String(report.repeatsPerScenario)}회, ` +
      `시나리오 결과 ${String(report.scenarios.length)}건, 총비용 $${report.total.cost.total.toFixed(4)}, ` +
      `비용 리포트: ${args.out}\n`,
  );
  return 0;
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
