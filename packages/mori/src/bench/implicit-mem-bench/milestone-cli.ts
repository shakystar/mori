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
import { runImplicitMemBenchMilestone, type MilestoneReport } from "./milestone.js";

export interface MilestoneCliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

interface ParsedArgs {
  pollIntervalMs?: number;
  timeoutMs?: number;
  out: string;
}

function defaultOutPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join("bench-reports", `milestone-${stamp}.json`);
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `mori bench: ${flag}는 1 이상의 정수(ms)여야 한다 (받은 값: "${String(value)}")`,
    );
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  let pollIntervalMs: number | undefined;
  let timeoutMs: number | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--poll-interval-ms") {
      pollIntervalMs = parsePositiveInt("--poll-interval-ms", argv[++i]);
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt("--timeout-ms", argv[++i]);
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("mori bench: --out에 경로가 필요하다");
      out = value;
    } else {
      throw new Error(
        `mori bench: 알 수 없는 인자 "${String(arg)}" (지원: --poll-interval-ms, --timeout-ms, --out)`,
      );
    }
  }

  return {
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    out: out ?? defaultOutPath(),
  };
}

/** 리포트를 기록하고, `report.batchFailures`가 비어있지 않으면 실패 건수·custom_id를 stderr에
 * 남기고 0이 아닌 종료 코드를 반환한다 — 그렇지 않으면 인프라 실패(배치 항목 만료·취소·오류)가
 * "모델이 못 했다"로 조용히 섞여 그린 리포트처럼 보인다(#407 owner 수정요청). auth 해석과
 * 분리해 둔 이유는 이 판정 로직만 순수 함수로 직접 테스트하기 위해서다. */
export function reportMilestoneOutcome(
  report: MilestoneReport,
  out: string,
  io: MilestoneCliIO,
): number {
  io.stdout(
    `mori bench: 마일스톤 풀런 완료 — 시나리오 결과 ${String(report.scenarios.length)}건, ` +
      `총비용 $${report.total.cost.total.toFixed(4)}, 비용 리포트: ${out}\n`,
  );
  if (report.batchFailures.length > 0) {
    io.stderr(
      `mori bench: judge 배치 항목 ${String(report.batchFailures.length)}건이 실패했다 — ` +
        `이 리포트의 점수는 신뢰할 수 없다. 실패 항목: ` +
        `${report.batchFailures.map((f) => `${f.customId}(${f.error})`).join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * `mori-milestone` — 마일스톤 풀런(#407, #397 조각 3/3). 수동 트리거 전제(#397 비범위: 실제
 * 트리거 인프라는 이 스크립트의 몫이 아니다). 세션 턴(맥락 주입·후속 프롬프트)은
 * `nightly-slice-cli.ts`와 같은 실시간 `streamFn` 경로를 그대로 타지만, judge/reader 채점
 * 패스만 이 스크립트가 만드는 `AnthropicBatchClient`(anthropic-batch-client.ts)를 거친다 —
 * 그 배선은 `runImplicitMemBenchMilestone`(milestone.ts) 안에서 이뤄진다, 이 CLI는 인증
 * 해석과 리포트 기록만 맡는다.
 *
 * 배치 API 인증은 세션 턴과 같은 `anthropic` provider 자격증명을 공유한다 —
 * `models.getAuth("anthropic")`로 해석해 raw api key를 얻는다(`pi-ai`가 저장된 자격증명 →
 * `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` 순으로 이미 하는 해석을
 * 재사용 — 별도 해석 로직을 만들지 않는다). Batch API는 OAuth 헤더가 아니라 api key만
 * 받으므로, 해석된 auth가 `apiKey`를 담고 있지 않으면(OAuth 전용 인증) 에러로 종료한다.
 */
export async function runMilestoneCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: MilestoneCliIO = {
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

  if (providerId !== "anthropic") {
    io.stderr(
      `mori bench: 마일스톤 풀런의 judge 배치 채점은 Anthropic Batch API 전용이다 — ` +
        `현재 선택된 프로바이더 "${providerId}"로는 돌릴 수 없다 (MORI_PROVIDER=anthropic 필요).\n`,
    );
    return 1;
  }

  const batchAuth = await models.getAuth(providerId);
  if (!batchAuth?.auth.apiKey) {
    io.stderr(
      "mori bench: Anthropic Batch API에는 api key 인증이 필요하다 — 현재 해석된 인증에는 " +
        "api key가 없다(OAuth 세션은 배치 제출에 쓸 수 없다). `mori login`으로 api key를 " +
        "저장하거나 ANTHROPIC_API_KEY를 설정해라.\n",
    );
    return 1;
  }

  const workRoot = await mkdtemp(join(tmpdir(), "mori-milestone-work-"));
  const memorizeRoot = await mkdtemp(join(tmpdir(), "mori-milestone-store-"));

  const report = await runImplicitMemBenchMilestone({
    model,
    streamFn: models.streamSimple.bind(models),
    batchApiKey: batchAuth.auth.apiKey,
    workRoot,
    memorizeRoot,
    env,
    credentialStore,
    ...(args.pollIntervalMs === undefined ? {} : { pollIntervalMs: args.pollIntervalMs }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });

  await writeCostReport(report, args.out);
  return reportMilestoneOutcome(report, args.out, io);
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runMilestoneCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `mori bench: 마일스톤 풀런 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
