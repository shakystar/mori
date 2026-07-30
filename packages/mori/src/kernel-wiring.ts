/**
 * Where mori's loop meets the memory kernel (#12).
 *
 * The seam is deliberately one-directional: `@mori/kernel` knows nothing about
 * pi-agent-core, so everything pi-shaped — the `AgentEvent` vocabulary, the tool
 * names, the working root, the embedder — is resolved here and handed over as
 * plain parameters. This file is the only place that has to change when the
 * harness's event shape does.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  observedShell,
  observedWrite,
  SqliteMemoryKernel,
  type Embedder,
  type ObservedToolCall,
  type ToolCallObserver,
} from "@mori/kernel";
import { getEmbedder, resolveEmbeddingsConfig } from "./external/embeddings/index.js";
import { BASH_TOOL_NAME } from "./tools/bash.js";

/** Provenance recorded on every event this harness appends. */
export const MORI_ACTOR = "mori";

/**
 * How each of mori's tools maps onto the kernel's capture vocabulary.
 *
 * Keep in sync with `createMoriTools` (tools/index.ts) — `kernel-wiring.test.ts`
 * fails if a tool ships without a verdict here, because the silent alternative
 * is a new write tool whose edits never reach memory.
 *
 * `read-only` is a decision, not an omission: read_file/list_dir/grep produce no
 * state change, and capture's whole discipline is that noise in the raw layer is
 * the one thing that cannot be cheaply undone (capture-service's module doc).
 */
const TOOL_CAPTURE: Record<string, ToolCaptureVerdict> = {
  edit_file: "write",
  [BASH_TOOL_NAME]: "shell",
  read_file: "read-only",
  list_dir: "read-only",
  grep: "read-only",
};

/** Which capture family a tool belongs to, or `read-only` for tools that signal nothing. */
export type ToolCaptureVerdict = "write" | "shell" | "read-only";

/** The verdict for a tool name, or undefined for a tool nothing has classified yet. */
export function toolCaptureVerdict(toolName: string): ToolCaptureVerdict | undefined {
  return TOOL_CAPTURE[toolName];
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Builds the `AgentEvent` → capture-candidate mapping.
 *
 * Stateful by necessity: `tool_execution_end` is the event that reports whether
 * the call SUCCEEDED, but only `tool_execution_start` carries the arguments, so
 * the arguments are held per tool-call id until the matching end arrives. Calls
 * that never end (an aborted turn) are dropped at `agent_end`, so the map cannot
 * outlive a run.
 *
 * Only successful calls are captured, which is the memorize behaviour this ports
 * (its filter ran on PostToolUse): a refused destructive command or a failed
 * edit changed nothing, so recording it as a work signal would be a lie.
 */
export function createAgentEventObserver(): ToolCallObserver<AgentEvent> {
  const pending = new Map<string, unknown>();

  return (event: AgentEvent): ObservedToolCall | undefined => {
    if (event.type === "tool_execution_start") {
      if (TOOL_CAPTURE[event.toolName] === undefined) return undefined;
      pending.set(event.toolCallId, event.args);
      return undefined;
    }

    if (event.type === "agent_end") {
      pending.clear();
      return undefined;
    }

    if (event.type !== "tool_execution_end") return undefined;

    const args = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError) return undefined;

    switch (TOOL_CAPTURE[event.toolName]) {
      case "write": {
        // The PATH, never the tool input as a whole: `edit_file`'s arguments also
        // carry `oldString`/`newString`, and passing the object through would
        // record a file body in the observation's `filePath` (#61 review).
        const filePath = stringArg(args, "path");
        return filePath ? observedWrite({ toolName: event.toolName, filePath }) : undefined;
      }
      case "shell": {
        const command = stringArg(args, "command");
        return command ? observedShell({ toolName: event.toolName, command }) : undefined;
      }
      default:
        return undefined;
    }
  };
}

/**
 * Store id for a working root: stable across runs (same checkout ⇒ same memory)
 * and distinct across checkouts (two repos never share a store).
 *
 * A hash rather than the path itself because the id is also a directory name and
 * has to satisfy the kernel's `ID_PATTERN`. Deriving it here and not in the
 * kernel is the seam discipline — "which project am I" is a harness question.
 */
export function moriProjectId(root: string): string {
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex");
  return `proj_${digest.slice(0, 16)}`;
}

export interface CreateMoriKernelOptions {
  /** Working root; identifies the store and titles its genesis. Defaults to cwd. */
  root?: string;
  /** Env the embedder is configured from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Semantic index seam, in place of the env-configured one. Absent AND
   * unconfigured ⇒ the kernel degrades to FTS-only, which is not an error.
   */
  embedder?: Embedder;
  /**
   * Sink for a capture that failed after the turn moved on. Called at most once
   * per kernel: a store that is broken is broken for every later event, and the
   * agent's output is not a log.
   */
  warn?: (message: string) => void;
}

/**
 * The kernel mori runs. Nothing here is lazy about configuration but everything
 * is lazy about disk: the store's directory and database are created by the
 * first observation that passes the capture filter, so a session that only reads
 * files leaves no trace on disk.
 *
 * The store lives under the kernel's own root (`~/.mori`, or `MEMORIZE_ROOT`) —
 * resolved inside the kernel's path-resolver from `process.env`, which is why
 * tests that exercise this must set that variable rather than pass an env object.
 */
export function createMoriKernel(
  options: CreateMoriKernelOptions = {},
): SqliteMemoryKernel<AgentMessage, AgentEvent> {
  const root = path.resolve(options.root ?? process.cwd());
  const warn = options.warn;
  let warned = false;

  // The one construction point for the `Embedder` seam (external/embeddings) —
  // the kernel never builds one and never reads this config.
  const embedder = options.embedder ?? getEmbedder(resolveEmbeddingsConfig(options.env));

  return new SqliteMemoryKernel<AgentMessage, AgentEvent>({
    projectId: moriProjectId(root),
    actor: MORI_ACTOR,
    project: { title: path.basename(root) || root, rootPath: root },
    observeEvent: createAgentEventObserver(),
    ...(embedder ? { embedder } : {}),
    onCaptureError: (error: unknown) => {
      if (!warn || warned) return;
      warned = true;
      warn(`mori: 메모리 캡처 실패 — 이번 세션의 관찰 기록은 남지 않습니다: ${errorText(error)}\n`);
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
