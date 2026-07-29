import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { BufferKernel } from "@mori/kernel";
import { createMoriAgent, createMoriModels } from "../agent.js";
import { defaultCredentialsPath, FileCredentialStore } from "../auth/credential-store.js";
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
export type PreparedAgent = { ok: true; agent: Agent } | { ok: false; exitCode: number };

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
  const authCheck = await createMoriModels(env, credentialStore).checkAuth(providerId);
  if (!authCheck) {
    stderr(unauthenticatedMessage(providerId));
    return { ok: false, exitCode: 1 };
  }

  const kernel = new BufferKernel<AgentMessage, AgentEvent>();
  let agent: Agent;
  try {
    agent = createMoriAgent(kernel, credentialStore, env, deps.streamFn, { root: deps.root });
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

  return { ok: true, agent };
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

  const { agent } = prepared;

  await agent.prompt(prompt);
  io.stdout("\n");

  const last = agent.state.messages.at(-1);
  if (last?.role === "assistant" && last.stopReason === "error") {
    io.stderr(`mori: ${last.errorMessage ?? "unknown provider error"}\n`);
    return 1;
  }

  return 0;
}
