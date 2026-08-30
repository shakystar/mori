#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { isMainEntry } from "../../cli/entrypoint.js";
import { resolveLongMemEvalV1DataDir } from "./data-dir.js";

/**
 * Acquisition script for LongMemEval(v1) `longmemeval-cleaned` (#507's "취득 스크립트 또는 경로
 * 규약" completion condition, mirroring `../longmemeval-v2/fetch-dataset.ts`). The dataset
 * (MIT) is never committed to this repo; this script downloads the released file straight from
 * the Hugging Face dataset repo (`xiaowu0162/longmemeval-cleaned`) into
 * `resolveLongMemEvalV1DataDir()`'s directory over plain HTTPS (confirmed via `curl` during
 * #507's feasibility check — no `huggingface_hub`/Python dependency needed).
 *
 * Only `longmemeval_s_cleaned.json` (the `LongMemEval_S` split #344 targets) is fetched by
 * default — `longmemeval_m_cleaned.json`/`longmemeval_oracle.json` exist in the same repo but
 * are out of this slice's scope (see feasibility doc's 비범위).
 */
const HF_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
const BASE_URL = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${HF_REVISION}`;

const DEFAULT_FILE = "longmemeval_s_cleaned.json";

async function downloadFile(fileName: string, dataDir: string, io: FetchDatasetIO): Promise<void> {
  const url = `${BASE_URL}/${fileName}`;
  const dest = `${dataDir}/${fileName}`;
  await mkdir(dataDir, { recursive: true });
  io.stderr(`longmemeval-v1: 다운로드 중 ${url} -> ${dest}\n`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`longmemeval-v1: ${url} 다운로드 실패 (HTTP ${String(response.status)})`);
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
  file: string;
}

export function parseFetchDatasetArgs(argv: string[]): FetchDatasetArgs {
  let dataDir: string | undefined;
  let file = DEFAULT_FILE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--file") {
      file = argv[++i] ?? file;
    } else {
      throw new Error(`longmemeval-v1: 알 수 없는 인자 "${arg ?? ""}"`);
    }
  }
  return { ...(dataDir === undefined ? {} : { dataDir }), file };
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
  const dataDir = args.dataDir ?? resolveLongMemEvalV1DataDir(env);
  await downloadFile(args.file, dataDir, io);
  io.stdout(`longmemeval-v1: 완료 — ${dataDir}\n`);
  return 0;
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runFetchDatasetCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `longmemeval-v1: 취득 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
