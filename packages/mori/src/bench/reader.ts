import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentText, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { BENCH_AXES, type BenchAxis } from "./axes.js";
import type { LlmCallCacheHooks, LlmCallCacheStore } from "./cache/llm-call-cache.js";
import { withLlmCallCache } from "./cache/llm-call-cache.js";
import type { CostLedger } from "./cost-ledger.js";

/**
 * Execution path for a bench-peripheral reader/analysis pass (#374's own scope — mori's own
 * ingestion/session driving stays on `"api"`, unconditionally, per #342's owner approval).
 * `"api"` bills the injected provider per call, cacheable via #372's `LlmCallCacheStore`.
 * `"claude-cli"` shells out to `claude -p`, billed against the subscription instead of the API
 * — the point of offering it at all is that a reader pass run this way costs the bench run
 * nothing incremental in API dollars.
 */
export type ReaderExecutionPath = "api" | "claude-cli";

const READER_PATH_ENV = "MORI_BENCH_READER_PATH";

/** Reads `MORI_BENCH_READER_PATH` ("api" | "claude-cli"); unset defaults to "api" (unchanged
 * product-path billing until a bench opts in). Any other value fails loudly rather than
 * silently falling back — a typo'd env value should not quietly bill the wrong path. */
export function resolveReaderExecutionPath(
  env: NodeJS.ProcessEnv = process.env,
): ReaderExecutionPath {
  const raw = env[READER_PATH_ENV];
  if (raw === undefined || raw === "api") return "api";
  if (raw === "claude-cli") return "claude-cli";
  throw new Error(
    `mori bench: 알 수 없는 reader 실행 경로 "${raw}" (${READER_PATH_ENV}). "api" 또는 "claude-cli"만 허용된다.`,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the cwd a `claude -p` reader subprocess runs in — the isolation guard #374's
 * completion conditions require. Defaults to a fresh directory under the OS temp dir, never
 * the repo root: a repo-root cwd's `CLAUDE.md` gets read by `claude -p` as developer-agent
 * instructions, and it refuses to hold a bench conversation (memorize#176's cwd-contamination
 * lesson). An explicit `cwd` is honored only if neither it nor any of its ancestors up to the
 * filesystem root has a `CLAUDE.md` — `claude -p` resolves project instructions by walking
 * ancestors the same way this session's own harness does, so a cwd nested under a
 * `CLAUDE.md`-bearing directory (e.g. a scratch subdirectory of the repo) is just as
 * contaminated as the repo root itself. Pointing this at a contaminated directory fails loudly
 * here instead of silently producing a refusal partway through a bench run.
 */
export async function resolveReaderCwd(explicitCwd?: string): Promise<string> {
  const cwd = explicitCwd ?? (await mkdtemp(join(tmpdir(), "mori-bench-reader-")));
  let dir = cwd;
  for (;;) {
    if (await pathExists(join(dir, "CLAUDE.md"))) {
      throw new Error(
        `mori bench: reader cwd ${cwd}의 조상 디렉터리 ${dir}에 CLAUDE.md가 있다 — claude -p가 조상까지 ` +
          `훑어 이를 개발 에이전트 지시로 읽어 벤치 대화를 거부한다(memorize#176). 리포 루트 하위가 아닌, ` +
          `완전히 중립적인 디렉터리를 지정해라.`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

export interface ReaderResult {
  text: string;
}

export interface Reader {
  read(prompt: string): Promise<ReaderResult>;
}

export interface ApiReaderConfig {
  model: Model<Api>;
  /** Underlying provider call. Wrapped in #372's `withLlmCallCache` before use — a reader pass
   * on this path is cache-eligible like any other (model, prompt, params) call. */
  streamFn: StreamFn;
  cacheStore: LlmCallCacheStore;
  cacheHooks?: LlmCallCacheHooks;
  /** #373's per-run accumulator. Unset means this reader's usage goes unrecorded — a caller
   * that wants "재실행 비용 ~$0" reporting for reader calls must pass one. */
  costLedger?: CostLedger;
  /** Defaults to `BENCH_AXES.cost`. Pass a specific axis (e.g. a bench's own analysis-cost
   * bucket) to keep reader spend distinguishable from the episode's own turns. */
  costAxis?: BenchAxis;
  systemPrompt?: string;
}

function createApiReader(config: ApiReaderConfig): Reader {
  return {
    async read(prompt: string): Promise<ReaderResult> {
      // Tracked per call (not hoisted to a shared closure) so concurrent `read()`s can't cross-
      // signal each other's hit/miss outcome onto the wrong call's cost record.
      let cacheHit = false;
      const hooks: LlmCallCacheHooks = {
        ...config.cacheHooks,
        onHit: (key) => {
          cacheHit = true;
          config.cacheHooks?.onHit?.(key);
        },
      };
      const cachedStream = withLlmCallCache(config.streamFn, config.cacheStore, hooks);
      const context: Context = {
        ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
        messages: [{ role: "user", content: prompt, timestamp: 0 }],
      };
      const stream = await cachedStream(config.model, context, undefined);
      const message = await stream.result();
      // A cache hit replays a stored `AssistantMessage` byte-for-byte, including its original
      // `usage`/`cost` — recording that again would make the cost report keep growing on every
      // replay even though the replayed call makes zero real provider calls. "재실행 비용 ~$0"
      // (owner review, #374 이월 2) is a report-level guarantee, not just a billing one.
      if (!cacheHit) {
        config.costLedger?.record(config.costAxis ?? BENCH_AXES.cost, message.usage);
      }
      return { text: contentText(message.content) };
    },
  };
}

export interface ClaudeCliReaderConfig {
  /** cwd the subprocess runs in, resolved through `resolveReaderCwd` — see that function's
   * doc for why this is never the repo root. */
  cwd?: string;
  /** Executable name/path. Defaults to `"claude"`. */
  command?: string;
  /** `node:child_process.spawn` substitute — test seam. */
  spawn?: typeof nodeSpawn;
}

async function createClaudeCliReader(config: ClaudeCliReaderConfig): Promise<Reader> {
  const cwd = await resolveReaderCwd(config.cwd);
  const spawnFn = config.spawn ?? nodeSpawn;
  const command = config.command ?? "claude";
  return {
    read(prompt: string): Promise<ReaderResult> {
      return new Promise((resolve, reject) => {
        const child = spawnFn(command, ["-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`mori bench: claude -p exited ${String(code)}: ${stderr.trim()}`));
            return;
          }
          resolve({ text: stdout.trim() });
        });
      });
    },
  };
}

export interface ReaderConfig {
  path: ReaderExecutionPath;
  api?: ApiReaderConfig;
  claudeCli?: ClaudeCliReaderConfig;
}

/**
 * Builds a `Reader` for the selected execution path — the branch #374's completion conditions
 * require to be test-provable: `"api"` never spawns a subprocess, `"claude-cli"` never calls
 * `streamFn`.
 */
export async function createReader(config: ReaderConfig): Promise<Reader> {
  if (config.path === "api") {
    if (!config.api) {
      throw new Error('mori bench: reader path "api"에는 `api` 설정이 필요하다.');
    }
    return createApiReader(config.api);
  }
  if (!config.claudeCli) {
    throw new Error('mori bench: reader path "claude-cli"에는 `claudeCli` 설정이 필요하다.');
  }
  return createClaudeCliReader(config.claudeCli);
}
