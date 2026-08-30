#!/usr/bin/env node
import { isMainEntry } from "../../cli/entrypoint.js";
import { resolveLongMemEvalV1DataDir } from "./data-dir.js";
import { loadQuestions } from "./loader.js";
import { MEMORY_ABILITIES, type MemoryAbility } from "./types.js";

/**
 * The reproduction command #507's feasibility doc points at — loads
 * `longmemeval_s_cleaned.json` from a real, previously-fetched snapshot (see
 * `fetch-dataset.ts`) and prints the total question count plus a per-ability breakdown, so a
 * reader can check this loader's counts against the paper's stated 500 without writing any code
 * of their own (mirrors `../longmemeval-v2/print-question-count.ts`).
 */
export async function printQuestionCount(
  dataDir: string,
  io: { stdout: (chunk: string) => void } = { stdout: (c) => process.stdout.write(c) },
): Promise<void> {
  const questions = await loadQuestions(dataDir);
  const byAbility = new Map<MemoryAbility, number>();
  for (const ability of Object.values(MEMORY_ABILITIES)) byAbility.set(ability, 0);
  for (const question of questions) {
    byAbility.set(question.ability, (byAbility.get(question.ability) ?? 0) + 1);
  }
  io.stdout(`total questions: ${String(questions.length)}\n`);
  for (const [ability, count] of byAbility) {
    io.stdout(`  ${ability}: ${String(count)}\n`);
  }
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  printQuestionCount(resolveLongMemEvalV1DataDir()).catch((error: unknown) => {
    process.stderr.write(
      `longmemeval-v1: 문항 수 출력 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
