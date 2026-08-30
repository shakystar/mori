#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMainEntry } from "../../cli/entrypoint.js";
import { resolveLongMemEvalDataDir } from "./data-dir.js";

/**
 * Acquisition script for LongMemEval-V2 (#490 — the issue's "취득 스크립트 또는 경로 규약"
 * completion condition). The dataset (Apache-2.0) is never committed to this repo; this script
 * just downloads the released files straight from the Hugging Face dataset repo
 * (`xiaowu0162/longmemeval-v2`) into `resolveLongMemEvalDataDir()`'s directory. Files are
 * served over plain HTTPS (confirmed via `curl` during #490's feasibility check) — no
 * `huggingface_hub`/Python dependency needed, unlike the upstream repo's own
 * `data/download_data.py`.
 *
 * `trajectories.jsonl` is ~1.1GB (git-LFS-backed on the HF side, transparent over HTTPS) —
 * `--skip-trajectories` fetches only `questions.jsonl` and the two haystack files, enough to
 * run `print-question-count.ts` or inspect question/ability distribution without the full
 * trajectory corpus.
 */
const HF_REVISION = "f152293e235517d504809563c833d7190b8c713b";
const BASE_URL = `https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/resolve/${HF_REVISION}`;

const CORE_FILES = [
  "questions.jsonl",
  "haystacks/lme_v2_small.json",
  "haystacks/lme_v2_medium.json",
];
const TRAJECTORIES_FILE = "trajectories.jsonl";

async function downloadFile(relPath: string, dataDir: string, io: FetchDatasetIO): Promise<void> {
  const url = `${BASE_URL}/${relPath}`;
  const dest = join(dataDir, relPath);
  await mkdir(dirname(dest), { recursive: true });
  io.stderr(`longmemeval-v2: 다운로드 중 ${url} -> ${dest}\n`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`longmemeval-v2: ${url} 다운로드 실패 (HTTP ${String(response.status)})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(dest, buffer);
}

export interface FetchDatasetIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface FetchDatasetArgs {
  dataDir?: string;
  skipTrajectories: boolean;
}

export function parseFetchDatasetArgs(argv: string[]): FetchDatasetArgs {
  let dataDir: string | undefined;
  let skipTrajectories = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--skip-trajectories") {
      skipTrajectories = true;
    } else {
      throw new Error(`longmemeval-v2: 알 수 없는 인자 "${arg ?? ""}"`);
    }
  }
  return { ...(dataDir === undefined ? {} : { dataDir }), skipTrajectories };
}

export async function runFetchDatasetCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: FetchDatasetIO = {
    stdout: (c) => process.stdout.write(c),
    stderr: (c) => process.stderr.write(c),
  },
): Promise<number> {
  const args = parseFetchDatasetArgs(argv);
  const dataDir = args.dataDir ?? resolveLongMemEvalDataDir(env);
  const files = args.skipTrajectories ? CORE_FILES : [...CORE_FILES, TRAJECTORIES_FILE];
  for (const relPath of files) {
    await downloadFile(relPath, dataDir, io);
  }
  io.stdout(`longmemeval-v2: 완료 — ${dataDir}\n`);
  return 0;
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runFetchDatasetCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `longmemeval-v2: 취득 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
