#!/usr/bin/env node
import { isMainEntry } from "../../cli/entrypoint.js";
import { resolveLongMemEvalDataDir } from "./data-dir.js";
import { loadQuestions } from "./loader.js";
import { MEMORY_ABILITIES, type MemoryAbility } from "./types.js";

/**
 * The reproduction command #490's feasibility doc points at — loads `questions.jsonl` from a
 * real, previously-fetched LongMemEval-V2 snapshot (see `fetch-dataset.ts`) and prints the
 * total question count plus a per-ability breakdown, so a reader can check this loader's counts
 * against the paper's stated 451 without writing any code of their own.
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
  printQuestionCount(resolveLongMemEvalDataDir()).catch((error: unknown) => {
    process.stderr.write(
      `longmemeval-v2: 문항 수 출력 실패 — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
