import {
  AgentHarness,
  type AgentEvent,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type Session,
  type SessionEntryCursorOptions,
  type SessionTreeEntry,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { MemoryKernel } from "@mori/kernel";
import { overrideProviderStream } from "./fake-provider-models.js";
import { createHarnessSession } from "./harness-session.js";
import { createMoriModels } from "./model-wiring.js";
import {
  resolveProviderSelection,
  supportedProviderIds,
  unknownProviderMessage,
} from "./provider-selection.js";
import { createBashBeforeToolCall, createMoriTools } from "../tools/index.js";

export { createMoriModels };

/**
 * The harness `createMoriAgent` returns, plus the two capabilities `AgentHarness`'s own
 * public surface has no room for: `session` is a private constructor field with no getter
 * (`pi/dist/harness/agent-harness.d.ts`), so nothing outside this module can reach the
 * `Session` `moveTo`/`getEntries` live on.
 *
 * - `resetSession` — `/clear`'s session replacement. Human decision #7 (2026-08-07) picked
 *   `Session.moveTo(null)` over rebuilding the harness: it moves the session's leaf to
 *   null, which empties the context path for the next turn while every entry stays in
 *   place (`moveTo` only ever appends a `leaf` entry; nothing is deleted) and the harness
 *   instance, its local state, and every `subscribe()`/`on()` registration all survive
 *   untouched (harness-session.ts).
 * - `getEntries` — `Session.getEntries`, bound. The one production consumer left holding
 *   `agent.state.messages` after the low-level `Agent` (session.ts's turn-usage summing,
 *   which needs every reply a tool-call loop produced, not just the last) reads the same
 *   append-only entry log this way instead.
 * - `contextMessages` — `Session.buildContext().messages`, the message list the NEXT turn
 *   would be built from. The compaction decision (`cli/compaction.ts`, #409) needs exactly
 *   this list and `getEntries` is not a substitute: the entry log is the raw append-only
 *   record, while `buildContext` is what `AgentHarness.createTurnState` itself feeds the
 *   provider — it walks the branch and applies the compaction transform, so after a
 *   compaction it yields summary + `retainedTail` rather than the history that was cut.
 *   Deciding off the entry log would therefore keep measuring context that no longer
 *   exists and re-fire compaction every turn.
 */
export type MoriAgent = AgentHarness & {
  resetSession(): Promise<void>;
  getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]>;
  contextMessages(): Promise<AgentMessage[]>;
};

/**
 * The `AgentEvent` variants, as a total map so the compiler reports it when pi's union
 * moves — a `Set` of strings would go quietly stale and start dropping real events.
 *
 * This is the whole of the narrowing below: `AgentHarness.subscribe` hands out
 * `AgentHarnessEvent`, which is `AgentEvent` plus the harness's own lifecycle events
 * (compaction, retries, queue updates, save points…), while the kernel's observer is
 * declared over `AgentEvent` alone. Widening the kernel's `E` was the other option and is
 * bigger: the seam would then owe an answer for events the memory model has no opinion
 * about.
 */
const AGENT_EVENT_TYPES: Readonly<Record<AgentEvent["type"], true>> = {
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
};

function isAgentEvent(event: AgentHarnessEvent): event is AgentEvent {
  return Object.prototype.hasOwnProperty.call(AGENT_EVENT_TYPES, event.type);
}

/**
 * The kernel seam as mori instantiates it, plus `drain`.
 *
 * `drain` is not on `MemoryKernel` — the seam's `observe` is synchronous, so a
 * kernel that persists anything has to finish that work after `observe` returned,
 * and only the HOST knows when it is about to stop giving it the chance. `mori
 * "…"` exits the process as soon as the turn ends, so without a settle point the
 * last observation of every one-shot run would be lost. Requiring it here rather
 * than widening the replaceable seam keeps that a harness-lifecycle concern.
 */
export interface MoriKernel extends MemoryKernel<AgentMessage, AgentEvent> {
  /** Settle whatever `observe` queued. Resolves when the store has caught up. */
  drain(): Promise<void>;
}

export interface CreateMoriAgentOptions {
  /**
   * Working root shared by every tool: the path guard (read_file/list_dir/grep/edit_file)
   * resolves paths against it, and it becomes the bash tool's child cwd. Defaults to
   * `process.cwd()`.
   */
  root?: string;
  /**
   * Tools to register, in place of the default toolset built from `root`. Pass `[]` to
   * get the pre-toolset single-prompt behavior back (e.g. for regression tests).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool<TArgs> erasure for a heterogeneous tool array
  tools?: AgentTool<any>[];
  /**
   * Test seam: the `Models` this agent resolves its model and streaming through, in
   * place of building one via `createMoriModels(env, credentialStore)`. `cli/runtime.ts`'s
   * `prepareAgent` passes its own `models` (real, or the `RunCliDeps.models` test seam)
   * here so the auth gate and the turn always see the same instance — see `cli/types.ts`'s
   * `models` doc for why that identity matters. Unset — the default at every non-test call
   * site — builds a fresh instance exactly as before this seam existed.
   *
   * Setting it leaves the `credentialStore` argument unused by this function: the injected
   * instance already carries whichever store it was built from. Build it from that same
   * store, or the agent resolves auth against one store while its caller believes another.
   */
  models?: MutableModels;
  /**
   * The `Session` the harness is built on, in place of a fresh `createHarnessSession()`.
   *
   * `prepareAgent` (#426, #7 조각 2/2) sets this so the SAME `Session` instance backs both
   * the harness AND the `ConversationSource` wired into `kernel` at construction — the two
   * must be one object, not two independently-created sessions, or the kernel's
   * conversation boundary reads an entry log the harness never writes to
   * (harness-conversation-source.ts's per-`Session` `id`). Unset — every other call site —
   * builds a fresh session exactly as before this seam existed.
   */
  session?: Session;
  /**
   * mori#489 — when `tools` is unset (the default toolset is built here from `root`),
   * confine the `bash` tool's writes to `root` at the kernel level (`tools/bash-jail.ts`).
   * Unset — every non-bench call site — leaves `bash` exactly as `tools/bash.ts`'s module
   * comment describes it: cwd pinned, nothing else restricted. `prepareAgent`
   * (cli/runtime.ts) threads this from `RunCliDeps.confineBashWrites`, which the bench
   * execution path (`bench/preference-regression/runner.ts`) sets — the one caller that
   * runs a model against prompts nobody has reviewed for what tool calls they provoke.
   * Has no effect when `tools` is set — a caller supplying its own toolset owns that
   * toolset's confinement, if any.
   */
  confineBashWrites?: boolean;
}

export function createMoriAgent(
  kernel: MoriKernel,
  credentialStore: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
  streamFn?: StreamFn,
  options: CreateMoriAgentOptions = {},
): MoriAgent {
  const models = options.models ?? createMoriModels(env, credentialStore);

  const { providerId, modelId } = resolveProviderSelection(env);
  if (!supportedProviderIds(env).includes(providerId)) {
    throw new Error(unknownProviderMessage(providerId, env));
  }

  const model = models.getModel(providerId, modelId);
  if (!model) {
    throw new Error(
      `mori: 알 수 없는 모델 "${modelId}" (프로바이더 "${providerId}").\n` +
        `사용 가능한 모델: ${models
          .getModels(providerId)
          .map((m) => m.id)
          .join(", ")}\n`,
    );
  }

  // `AgentHarness` streams through `models.streamSimple` and accepts no `streamFn` of its
  // own (docs/agent-harness-adoption.md §Q2 — "대응 없음"), so this seam moves one level
  // down instead of disappearing: the selected provider's stream functions are replaced,
  // which is where #336 already put the equivalent for tests. The visible difference is
  // that a request now resolves auth through `Models` before reaching the double, exactly
  // as `fakeProviderModels` documents; the one caller (`RunCliDeps.streamFn`) configures
  // credentials anyway, because the auth gate it passes first requires them.
  if (streamFn) overrideProviderStream(models, providerId, streamFn);

  const tools =
    options.tools ??
    createMoriTools(options.root ?? process.cwd(), env, options.confineBashWrites ?? false);

  // Kept in this closure rather than dropped once handed to the harness: `AgentHarness`
  // stores `session` in a private field with no getter, and `resetSession`/`getEntries`
  // below (the only door onto `Session`, #398) need the same reference the harness reads
  // from. `options.session` (#426) lets `prepareAgent` hand in the SAME instance it
  // already wrapped into the kernel's `ConversationSource` — see that option's doc for
  // why a second, independently-created session here would be a silent bug.
  const session = options.session ?? createHarnessSession();

  const harness = new AgentHarness({
    session,
    models,
    model,
    systemPrompt: "You are mori, a memory-native coding agent.",
    tools,
    // No `toolExecution` here, and none available: the harness does not take it (§Q1 ③).
    // Sequential execution is carried by the `executionMode: "sequential"` on the `bash`
    // and `edit_file` tool definitions instead (#320) — the agent loop forces the whole
    // batch sequential if any tool in it says so, which is why that had to land first.
  });

  const agent = Object.assign(harness, {
    resetSession: () => session.moveTo(null).then(() => undefined),
    getEntries: session.getEntries.bind(session),
    contextMessages: () => session.buildContext().then((context) => context.messages),
  }) as MoriAgent;

  /**
   * The run's `AbortSignal`, as `subscribe` hands it out.
   *
   * `ContextEvent` has no `signal` field and `emitHook` passes the handler nothing else, so
   * the second argument `transformContext(messages, signal)` used to receive has no route
   * through the `context` hook itself. It does have one through `subscribe`: the harness
   * emits `agent_start` with the run's signal before the first `context` hook fires, and it
   * is the same object the loop threads into `transformContext` and tool `execute` (checked
   * by identity against pi 0.82.1). Cancellation equivalence therefore holds — a turn that
   * is cancelled mid-retrieval still aborts instead of spending the attempt.
   */
  let runSignal: AbortSignal | undefined;

  harness.subscribe((event, signal) => {
    if (event.type === "agent_start") runSignal = signal;

    if (isAgentEvent(event)) {
      kernel.observe(event);
    }
    // else: a harness-own event (compaction, retries, queue updates, save points, …). The
    // kernel's observer is declared over `AgentEvent` and has no reading for these, so they
    // are dropped HERE, deliberately and visibly, rather than being cast through the seam
    // and reaching `createAgentEventObserver`'s `event.type !== "tool_execution_end"` fall-
    // through as if they had been considered.

    // A signal that outlived its run must not be handed to the next turn's retrieval: it is
    // already aborted whenever the run was cancelled.
    if (event.type === "agent_end") runSignal = undefined;
  });

  harness.on("context", async (event) => ({
    messages: await kernel.transformContext(event.messages, runSignal),
  }));

  const guardBashCall = createBashBeforeToolCall();
  harness.on("tool_call", (event) =>
    guardBashCall({ toolCall: { name: event.toolName }, args: event.input }),
  );

  return agent;
}
