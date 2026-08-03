/**
 * #208 — a small hand-rolled property-test harness (no devDependency added;
 * see the PR body for the fast-check-vs-hand-rolled tradeoff). Two pieces:
 * a seeded PRNG (so any failing run is reproducible from its seed alone) and
 * a fixed-iteration-count runner that turns a thrown assertion into a
 * human-readable counterexample (seed + run index + the generated input).
 */

/** mulberry32 — tiny, deterministic, good enough distribution for test generators. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function nextFloat(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number;
  /** Uniformly picks one element (array must be non-empty). */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
}

export function makeRng(seed: number): Rng {
  const nextFloat = mulberry32(seed);
  return {
    next: nextFloat,
    int(min: number, max: number): number {
      return min + Math.floor(nextFloat() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Rng.pick: empty array");
      return items[Math.floor(nextFloat() * items.length)]!;
    },
    bool(p = 0.5): boolean {
      return nextFloat() < p;
    },
  };
}

export interface ForAllOptions {
  /** Fixed number of generated cases to run — see PR body for the count rationale. */
  runs: number;
  /** Base seed; run `i` uses `seed + i`, so any single run reproduces on its own. */
  seed: number;
}

/**
 * Runs `check` against `runs` generated cases. On failure, rethrows with the
 * seed, run index, and the generated input serialized alongside the original
 * assertion error — a bare vitest `expect` failure from inside a loop would
 * otherwise only show the LAST iteration's stack, not which input broke it.
 */
export async function forAll<T>(
  label: string,
  opts: ForAllOptions,
  generate: (rng: Rng, runIndex: number) => T,
  check: (input: T, runIndex: number, seed: number) => void | Promise<void>,
): Promise<void> {
  for (let i = 0; i < opts.runs; i++) {
    const runSeed = opts.seed + i;
    const input = generate(makeRng(runSeed), i);
    try {
      await check(input, i, runSeed);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      throw new Error(
        `[property:${label}] failed on run ${i}/${opts.runs} (seed=${runSeed}, ` +
          `reproduce with base seed ${runSeed - i})\n` +
          `input = ${JSON.stringify(input, null, 2)}\n\n${message}`,
        { cause: err },
      );
    }
  }
}
