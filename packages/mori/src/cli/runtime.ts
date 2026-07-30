import type { Agent } from "@earendil-works/pi-agent-core";
import type { ConsolidatorLlm } from "@mori/kernel";
import { createMoriAgent, createMoriModels, type MoriKernel } from "../agent/index.js";
import { defaultCredentialsPath, FileCredentialStore } from "../auth/credential-store.js";
import { getConsolidatorLlm, resolveConsolidatorConfig } from "../external/consolidator/index.js";
import { createMoriKernel, moriStoreExists } from "../kernel/index.js";
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
  | { ok: true; agent: Agent; kernel: MoriKernel; llm: ConsolidatorLlm | undefined }
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
  // happen is for both to ask the same question of the same instance.
  const models = createMoriModels(env, credentialStore);
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
  const kernel =
    deps.kernel ?? createMoriKernel({ root: deps.root ?? process.cwd(), env, warn: stderr });
  let agent: Agent;
  try {
    agent = createMoriAgent(kernel, credentialStore, env, deps.streamFn, {
      ...(deps.root ? { root: deps.root } : {}),
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

  return { ok: true, agent, kernel, llm };
}

/**
 * The `llm` a session-end trigger should actually see: `undefined` (quiet no-op,
 * `consolidation.ts`'s existing contract) when the real on-disk store this session ran
 * against was never created. `observe`'s own `ensureGenesis` creates that store the moment
 * anything passes the capture filter, so "no store" here means nothing did — running a
 * boundary anyway would be the first write of a session that only read files (README's
 * "no trace on disk" guarantee, #107 review). Only second-guesses the trigger for the real
 * kernel (`deps.kernel` unset, per its own doc in `cli/types.ts`) — an injected kernel
 * (tests) has no on-disk store this check could observe.
 */
export function sessionEndLlm(
  llm: ConsolidatorLlm | undefined,
  deps: RunCliDeps,
): ConsolidatorLlm | undefined {
  if (deps.kernel) return llm;
  return moriStoreExists(deps.root ?? process.cwd()) ? llm : undefined;
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

  const { agent, kernel, llm } = prepared;

  try {
    await agent.prompt(prompt);
  } finally {
    // The caller exits the process on return, and `observe` is fire-and-forget by
    // contract — so this is the one place that can keep the turn's last
    // observation from being lost to `process.exit`. In the `finally` because a
    // turn that failed still observed everything that happened before it did.
    await kernel.drain();
    // Session-end consolidation trigger (#107). After drain so the turn's own
    // observations are in the window being consolidated. Never throws — see
    // consolidation.ts — so a bad extractor cannot change this turn's exit code.
    await consolidateOnSessionEnd(kernel, sessionEndLlm(llm, deps), io.stderr);
  }
  io.stdout("\n");

  const last = agent.state.messages.at(-1);
  if (last?.role === "assistant" && last.stopReason === "error") {
    io.stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
    return 1;
  }

  return 0;
}
