import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConsolidatorLlm } from "@mori/kernel";
import {
  createMoriAgent,
  createMoriModels,
  type MoriAgent,
  type MoriKernel,
} from "../agent/index.js";
import { defaultCredentialsPath, FileCredentialStore } from "../auth/credential-store.js";
import { getConsolidatorLlm, resolveConsolidatorConfig } from "../external/consolidator/index.js";
import { createMoriKernel, moriStoreExistsForId } from "../kernel/index.js";
import { consolidateOnSessionEnd } from "./consolidation.js";
import { unauthenticatedMessage } from "./messages.js";
import type { RunCliDeps } from "./types.js";

export interface RunPromptIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/**
 * Either an agent ready to take prompts, or the exit code the caller should return — in
 * which case the user-facing message has already been written to stderr.
 */
export type PreparedAgent =
  | {
      ok: true;
      agent: MoriAgent;
      kernel: MoriKernel;
      llm: ConsolidatorLlm | undefined;
      /**
       * The real kernel's `projectId`, pinned at construction (#230) — `undefined` when
       * `deps.kernel` was injected (a test double has no on-disk store `sessionEndLlm`
       * could check anyway; see its own doc).
       */
      projectId: string | undefined;
    }
  | { ok: false; exitCode: number };

/**
 * Everything that must happen before the first turn: credential store -> auth gate ->
 * kernel/agent construction -> event subscription.
 *
 * Split out of `runPrompt` for the REPL (#26), which runs this exactly once and then reuses
 * the agent for every turn. Per-turn preparation would rebuild the kernel and drop the
 * transcript, and an unauthenticated REPL would only discover it after accepting a prompt
 * rather than at startup.
 */
export async function prepareAgent(
  providerId: string,
  env: NodeJS.ProcessEnv,
  deps: RunCliDeps,
  io: RunPromptIO,
): Promise<PreparedAgent> {
  const { stdout, stderr } = io;

  const credentialStore =
    deps.credentialStore ?? new FileCredentialStore(defaultCredentialsPath(env), stderr);

  // Gate through the exact same Models/provider/store configuration the real turn below
  // uses (see agent.ts's createMoriModels) — the only way "gate passes, turn fails" can't
  // happen is for both to ask the same question of the same instance. `deps.models` (test
  // seam, cli/types.ts) lets a test substitute this instance; production always builds a
  // fresh one here and threads it down to `createMoriAgent` below rather than letting that
  // build a second, independently-constructed one.
  const models = deps.models ?? createMoriModels(env, credentialStore);
  const authCheck = await models.checkAuth(providerId);
  if (!authCheck) {
    stderr(unauthenticatedMessage(providerId));
    return { ok: false, exitCode: 1 };
  }

  // The consolidation seam (#106/#107): undefined when `MORI_CONSOLIDATE_MODEL` is
  // unconfigured, in which case both triggers stay off (consolidation.ts). Resolving the
  // config explicitly, rather than letting `getConsolidatorLlm` re-read `process.env`, is
  // what makes this respect the injected `env` the rest of `prepareAgent` uses.
  const llm = getConsolidatorLlm(models, resolveConsolidatorConfig(env));

  // The real memory kernel (#12), sharing the toolset's working root so "which
  // checkout is this" has one answer. It writes nothing until an observation
  // passes the capture filter, so preparing an agent stays side-effect-free.
  //
  // `projectId` is only set on the real-kernel branch: it is the id THIS construction
  // resolved (#230), carried forward for `sessionEndLlm` instead of being re-read from
  // disk at session end, when `.mori/project.json` may no longer say the same thing.
  let kernel: MoriKernel;
  let projectId: string | undefined;
  if (deps.kernel) {
    kernel = deps.kernel;
  } else {
    const created = createMoriKernel({ root: deps.root ?? process.cwd(), env, warn: stderr });
    kernel = created;
    projectId = created.projectId;
  }
  let agent: MoriAgent;
  try {
    agent = createMoriAgent(kernel, credentialStore, env, deps.streamFn, {
      ...(deps.root ? { root: deps.root } : {}),
      models,
    });
  } catch (err) {
    // Unknown-model errors from createMoriAgent are already a plain, user-facing message
    // (see agent.ts) — surface it as CLI output, not an uncaught stack trace.
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, exitCode: 1 };
  }

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      stdout(event.assistantMessageEvent.delta);
    }
  });

  return { ok: true, agent, kernel, llm, projectId };
}

/**
 * The `llm` a session-end trigger should actually see: `undefined` (quiet no-op,
 * `consolidation.ts`'s existing contract) when the real on-disk store this session ran
 * against was never created. `observe`'s own `ensureGenesis` creates that store the moment
 * anything passes the capture filter, so "no store" here means nothing did — running a
 * boundary anyway would be the first write of a session that only read files (README's
 * "no trace on disk" guarantee, #107 review).
 *
 * `projectId` is `prepareAgent`'s kernel-construction-time id (#230), never re-derived here:
 * before this fix the check re-read `.mori/project.json` from `root` at session-end time,
 * which can name a DIFFERENT store than the one the kernel actually captured into if the
 * file changed mid-session (a tool checking out another branch or worktree — this very
 * fleet's own pattern, one `.mori/project.json` per issue). That skipped the boundary for
 * the kernel's real id and checked a store that was never this session's to begin with.
 * Reading the id back from where the kernel construction pinned it, instead of asking the
 * root again, closes that gap. `undefined` (`deps.kernel` injected, per `cli/types.ts`) keeps
 * the existing test-seam contract: an injected kernel has no on-disk store this could check.
 */
export function sessionEndLlm(
  llm: ConsolidatorLlm | undefined,
  projectId: string | undefined,
): ConsolidatorLlm | undefined {
  if (projectId === undefined) return llm;
  return moriStoreExistsForId(projectId) ? llm : undefined;
}

/**
 * Wires a single prompt end to end and returns its exit code. This is the runtime-wiring
 * concern of `runCli` (index.ts), split out from user-facing messages and argv parsing.
 */
export async function runPrompt(
  prompt: string,
  providerId: string,
  env: NodeJS.ProcessEnv,
  deps: RunCliDeps,
  io: RunPromptIO,
): Promise<number> {
  const prepared = await prepareAgent(providerId, env, deps, io);
  if (!prepared.ok) return prepared.exitCode;

  const { agent, kernel, llm, projectId } = prepared;

  let last: AssistantMessage;
  try {
    last = await agent.prompt(prompt);
  } finally {
    // The caller exits the process on return, and `observe` is fire-and-forget by
    // contract — so this is the one place that can keep the turn's last
    // observation from being lost to `process.exit`. In the `finally` because a
    // turn that failed still observed everything that happened before it did.
    await kernel.drain();
    // Session-end consolidation trigger (#107). After drain so the turn's own
    // observations are in the window being consolidated. Never throws — see
    // consolidation.ts — so a bad extractor cannot change this turn's exit code.
    await consolidateOnSessionEnd(kernel, sessionEndLlm(llm, projectId), io.stderr);
  }
  io.stdout("\n");

  if (last.stopReason === "error") {
    io.stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
    return 1;
  }

  return 0;
}
