#!/usr/bin/env node
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
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
import {
  runNightlySlice,
  type NightlySliceOptions,
  type NightlySliceReport,
} from "./nightly-slice.js";

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
  providerCalls?: number,
): number {
  io.stdout(
    `mori bench: 나이틀리/주간 슬라이스 완료 — 반복 ${String(report.repeatsPerScenario)}회, ` +
      `시나리오 결과 ${String(report.scenarios.length)}건, 총비용 $${report.total.cost.total.toFixed(4)}, ` +
      `비용 리포트: ${out}\n`,
  );
  if (providerCalls !== undefined) {
    // #469 완료 조건 2의 증거 출력. 여기서 세는 것은 **이 CLI가 넘긴 product-path `streamFn`을
    // 실제로 통과한 호출**이다 — 캐시 적중은 `withLlmCallCache`가 저장된 응답을 재생하고 이
    // 함수를 부르지 않으므로 세지 않는다. 두 번 연속 돌렸을 때 이 숫자가 어떻게 변하는지가
    // 「재생이 캐시를 실제로 탔는가」의 관측치다. 세지 **않는** 것 하나: 증류 호출 —
    // `getConsolidatorLlm`(cli/runtime.ts)이 `models`에서 직접 만드므로 이 `streamFn`을 타지
    // 않고 캐시도 없다(단, 이 카운터가 아니라 재실행 자체가 실호출이라는 뜻 — 증류 비용은
    // `session-end-distillation` 축으로 별도 집계된다).
    //
    // 에피소드 세션 턴은 #473부터 `cacheStore`를 받는다(runner.ts
    // `PreferenceRegressionOptions.cacheEpisodes`, 기본 `true`, 이 CLI는 넘기지 않으므로
    // 기본값으로 돈다 — `cacheEpisodes: false`로 도는 호출자는 pr-smoke.ts뿐이고 이 카운터를
    // 쓰지 않는다). 재실행 시 **대부분** 이 카운터에서 빠지지만 **전부는 아니다** — 캐시는
    // LLM 호출만 감싸고, 그 응답에 실린 tool_call이 트리거하는 실제 도구 실행(예: `bash`의
    // 디렉터리 목록·파일 쓰기)까지는 감싸지 않는다. 재생된 assistant 메시지가 tool_call을
    // 담고 있으면 그 도구는 실행마다 실제로 다시 돌고, 결과 텍스트가 실행마다 달라지면
    // (예: `ls -la`의 mtime — `normalizeVolatilePaths`가 잡는 "경로 문자열"과는 다른 값이라
    // 그 정규화로는 안 잡힌다) 그 지점부터 같은 에피소드의 나머지 호출(후속 세션 턴,
    // 그 출력에 기대는 judge 판정)이 연쇄로 캐시 밖이 된다. 실측(#473 PR #484 후속): 1건
    // 시나리오·`--repeats 2`·3팔을 같은 `--cache-dir`로 연속 2회 실행하면 38→8건으로
    // 줄지만 0은 아니다 — 남은 8건의 항목별 귀속은 PR #484 코멘트 참고. `memory-off`·
    // `oracle`처럼 도구를 안 쓰는 팔·시나리오라도 하네스가 자체적으로 탐색성 도구 호출을
    // 내면 같은 연쇄가 생긴다(실측: memory-on 없이도 재실행에 미스가 남았다) — memory-on
    // 고유의 현상이 아니라 **도구를 실제로 실행하는 모든 세션**의 구조적 한계다.
    io.stdout(`mori bench: provider 스트림 호출 ${String(providerCalls)}건 (캐시 적중 제외)\n`);
  }
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
 * #512: `runNightlySlice`를 돌리면서 회차가 끝날 때마다 `out`에 부분 리포트를 덮어쓴다(별도
 * 플래그 없는 기본 동작). 루프 도중 예외가 나도 마지막으로 완료된 회차분은 이미 `out`에 남은
 * 채로 그 예외를 그대로 다시 던진다(flush 후 rethrow) — 실패를 성공으로 삼키지 않는다. auth·
 * 모델 해석과 분리해 둔 이유는 이 흐름만 실 provider 없이 직접 테스트하기 위해서다
 * (`reportNightlySliceOutcome`과 같은 이유).
 */
export async function runNightlySliceWithPartialFlush(
  options: NightlySliceOptions,
  out: string,
  io: NightlySliceCliIO,
): Promise<NightlySliceReport> {
  let lastPartial: NightlySliceReport | undefined;
  try {
    const report = await runNightlySlice({
      ...options,
      onRepeatComplete: async (partial) => {
        lastPartial = partial;
        await writeCostReport(partial, out);
      },
    });
    await writeCostReport(report, out);
    return report;
  } catch (error) {
    if (lastPartial) {
      io.stdout(
        `mori bench: 부분 리포트 ${String(lastPartial.completedRepeats)}/` +
          `${String(lastPartial.repeatsPerScenario)} 회차분을 ${out}에 남겼다\n`,
      );
    }
    throw error;
  }
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

  // #469 완료 조건 2의 호출 카운터 — 재실행이 캐시를 탔는지를 리포트 밖에서 관측할 수 있는
  // 유일한 자리다(비용 원장은 캐시 적중 시 저장된 `usage`를 그대로 다시 싣는 경로가 있어
  // "0건"의 증거로 쓸 수 없다). `reportNightlySliceOutcome`의 주석에 무엇이 이 숫자에서 빠지는지
  // 적혀 있다.
  const streamSimple = models.streamSimple.bind(models);
  let providerCalls = 0;
  const countingStreamFn: StreamFn = (streamModel, context, streamOptions) => {
    providerCalls += 1;
    return streamSimple(streamModel, context, streamOptions);
  };

  const report = await runNightlySliceWithPartialFlush(
    {
      model,
      streamFn: countingStreamFn,
      cacheDir,
      workRoot,
      memorizeRootBase,
      env,
      credentialStore,
      ...(args.repeats === undefined ? {} : { repeatsPerScenario: args.repeats }),
    },
    args.out,
    io,
  );

  return reportNightlySliceOutcome(report, args.out, io, providerCalls);
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
