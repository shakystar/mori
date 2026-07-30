import { type Observation, type ObservationSignal, createObservation } from "../domain/entities.js";
import { appendEvent } from "../storage/event-store.js";
import { rebuildProjectProjection } from "./projection-store.js";

/**
 * CLS Phase 1 — short-term capture (the cheap half of D3).
 *
 * Runs on every tool-call event the harness observes. NO LLM, no transcript
 * read, no FTS reindex — just a rule-based decision-signal filter and, on a
 * pass, one event append. Everything expensive is deferred to the
 * consolidation boundary. The filter starts CONSERVATIVE (decision ③,
 * 2026-06-08): missed signals are acceptable because the boundary
 * consolidator also reads the transcript tail (D2 hybrid ownership) — noise
 * in the raw layer is the thing we cannot cheaply undo.
 */

/** Tools whose successful use is inherently a state-changing work signal.
 *  Spans harness vocabularies: Claude (Write/Edit/MultiEdit), Gemini CLI
 *  (`write_file`, and `replace` — Gemini's edit tool), Hermes (`write_file`
 *  for create, `patch` for edit), and Cursor (`Write`, shared with Claude).
 *  Recognizing a superset is harmless: a harness that never emits a given name
 *  simply never matches it. (Gemini and Hermes tool names confirmed via
 *  conformance dogfood; Cursor's are documented, not live-dogfooded — it has no
 *  headless CLI.)
 *
 *  `edit_file` is mori's OWN write tool (packages/mori/src/tools/edit-file.ts),
 *  added when the kernel stopped being a placeholder and started observing this
 *  harness's loop (#12). Naming it here rather than translating it to `Edit` at
 *  the wiring layer keeps the observation row's `toolName` honest — collision
 *  detection and telemetry read that field. */
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "write_file",
  "replace",
  "patch",
  "edit_file",
]);

/**
 * Codex performs file edits through a single `apply_patch` tool rather than
 * Write/Edit/MultiEdit. Its hook input reports `tool_name: "apply_patch"` and
 * carries the raw patch body in `tool_input.command` (openai/codex#18391,
 * merged 2026-04-22, shipped in codex 0.137.0). Treating it as a write signal
 * is what makes codex sessions contribute file observations — without it,
 * codex's edits are invisible to cross-session sharing and collision
 * detection (Phase 1 only saw codex's Bash activity).
 */
const APPLY_PATCH_TOOLS = new Set(["apply_patch", "ApplyPatch"]);

/**
 * Extract the file paths an apply_patch envelope touches. The patch body uses
 * `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File:
 * <path>` headers (and `*** Move to: <path>` for renames). Returns every
 * referenced path in order; empty when the body is not a recognizable patch.
 */
export function extractApplyPatchPaths(patchBody: string): string[] {
  const paths: string[] = [];
  // "*** Add File: p" / "*** Update File: p" / "*** Delete File: p" plus the
  // rename target "*** Move to: p" (which has no "File" keyword).
  const pattern = /^\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move to):\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patchBody)) !== null) {
    paths.push(match[1]!);
  }
  return paths;
}

/**
 * Mutating Bash command patterns (tuning parameter — seed list from the
 * 2026-06-08 decision; adjust against real transcripts). Read-only commands
 * (ls / cat / git status / grep …) intentionally do NOT match.
 */
const MUTATING_BASH_PATTERN = new RegExp(
  [
    String.raw`\bgit\s+(commit|push|merge|rebase|reset|revert|cherry-pick|tag|stash)\b`,
    String.raw`\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|publish|link)\b`,
    String.raw`\bpip3?\s+install\b`,
    String.raw`\b(rm|rmdir|del|mv|move|ren)\s`,
  ].join("|"),
);

/**
 * Destructive operations on the SHARED git state (the common `.git` dir or the
 * `.worktrees/` set). Concurrent sessions running any two of these race and can
 * corrupt the shared repo (2026-06-22 incident). Used both to ADMIT these as
 * mutating-bash observations and, in realtime-share, to DETECT cross-session
 * collisions — one source of truth so the two never drift. Read-only forms
 * (`git worktree list`, `git branch`, `rm -rf build`) intentionally do not match.
 */
export const DESTRUCTIVE_GIT_PATTERN = new RegExp(
  [
    String.raw`\bgit\s+worktree\s+(remove|prune)\b`,
    String.raw`\bgit\s+branch\s+(-d\b|-D\b|--delete\b)`,
    String.raw`\b(rm|rmdir)\s+[^\n]*(\.git\b|\.worktrees\b)`,
  ].join("|"),
);

/** `memorize task …` invocations that mark a task state transition. */
const TASK_TRANSITION_PATTERN =
  /\bmemorize\s+task\s+(update|handoff|checkpoint|claim|complete|create)\b/;

/**
 * Decision-keyword heuristic (tuning parameter — seed list). Matched against
 * the Bash command text only — the write-tool branch above returns before
 * this pattern is ever evaluated, so it never sees write-tool input either
 * way.
 *
 * #113 (resolving the #109 contract question this file used to beg): write
 * signals do NOT carry file contents in `toolInputText`. `toolInputText` is a
 * PATH for write tools, a raw patch body for `apply_patch` (whose `*** …
 * File:` headers name the paths, extracted above), and command text for
 * shell tools — pinned at the type level by `observedWrite` / `observedPatch`
 * / `observedShell` in `packages/kernel/src/kernel/sqlite-memory-kernel.ts`
 * (PR #127, #109's approved resolution: "path + separate field", not
 * content). `evaluateCapture` itself stays defensive regardless: it never
 * assumes a caller honored that contract (its own parameter type is a plain
 * `string`, unenforced), so nothing downstream — see
 * `RuleBasedConsolidator.extract()` in consolidate-service.ts — treats a
 * write-tool observation's `summary`/`filePath` as safe-to-echo content.
 */
const DECISION_KEYWORD_PATTERN =
  /결정|선택|포기|대신|하기로|방향|\bdecided?\b|\bdecision\b|\bchose\b|\binstead of\b|\babandon\b/i;

const MAX_SUMMARY_LENGTH = 240;

export interface CaptureVerdict {
  capture: boolean;
  signal?: ObservationSignal;
  /** Cheap rule-derived one-liner for the observation row. */
  summary?: string;
  /** Structured file path for write signals (Phase 2 collision detection).
   *  For apply_patch (multi-file) this is the FIRST touched path; the full
   *  list is in `summary`. */
  filePath?: string;
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The decision-signal filter (rule-based, LLM-free). Exported for unit
 * tests — captureObservation is the only production caller.
 */
export function evaluateCapture(
  toolName: string | undefined,
  toolInputText: string,
): CaptureVerdict {
  if (!toolName) return { capture: false };

  if (WRITE_TOOLS.has(toolName)) {
    return {
      capture: true,
      signal: "write-tool",
      summary: clip(`${toolName}: ${toolInputText}`),
      ...(toolInputText ? { filePath: toolInputText } : {}),
    };
  }

  // Codex edits via apply_patch (tool_input.command = raw patch body). Extract
  // the touched paths so the observation carries a structured filePath for
  // collision detection, exactly like a Write/Edit.
  if (APPLY_PATCH_TOOLS.has(toolName)) {
    const paths = extractApplyPatchPaths(toolInputText);
    return {
      capture: true,
      signal: "write-tool",
      summary: clip(
        paths.length > 0 ? `apply_patch: ${paths.join(", ")}` : `apply_patch: ${toolInputText}`,
      ),
      ...(paths[0] ? { filePath: paths[0] } : {}),
    };
  }

  // Shell-tool branch across harnesses: Claude `Bash`, Codex `shell`, Gemini
  // CLI `run_shell_command`, Hermes `terminal`, Cursor `Shell`, and mori's own
  // lowercase `bash` (#12 — see WRITE_TOOLS on why the name is not translated).
  if (
    toolName === "Bash" ||
    toolName === "bash" ||
    toolName === "shell" ||
    toolName === "run_shell_command" ||
    toolName === "terminal" ||
    toolName === "Shell"
  ) {
    if (TASK_TRANSITION_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: "task-transition",
        summary: clip(toolInputText),
      };
    }
    if (MUTATING_BASH_PATTERN.test(toolInputText) || DESTRUCTIVE_GIT_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: "mutating-bash",
        summary: clip(toolInputText),
      };
    }
    if (DECISION_KEYWORD_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: "decision-keyword",
        summary: clip(toolInputText),
      };
    }
  }

  return { capture: false };
}

export interface CaptureObservationParams {
  projectId: string;
  /**
   * Free-form provenance string for the appended event's `actor` field
   * (kernel-native — `DomainEvent.actor` is already a plain `string`, not a
   * closed harness-identity enum). Replaces the original's `agent:
   * AdapterAgent`, which named one of the memorize CLI's out-of-scope
   * multi-harness adapters; @mori/kernel has no such registry.
   */
  actor: string;
  /** Already-resolved memorize session id, when one exists. */
  sessionId?: string;
  toolName?: string;
  toolInputText: string;
  transcriptPath?: string;
  agentSessionId?: string;
  conversationId?: string;
  generationId?: string;
  toolUseId?: string;
}

/**
 * Tool-call capture entry point: filter → (on pass) append
 * `observation.captured` → rebuild projection WITHOUT reindexing FTS
 * (decision ④ — observations are not searchable entities; the expensive
 * index work happens once at the consolidation boundary, same pattern as
 * session heartbeats).
 *
 * Returns the captured observation, or undefined when the filter rejected
 * the event (read-only tool, chatter).
 */
export async function captureObservation(
  params: CaptureObservationParams,
): Promise<Observation | undefined> {
  const verdict = evaluateCapture(params.toolName, params.toolInputText);
  if (!verdict.capture || !verdict.signal) return undefined;

  const observation = createObservation({
    projectId: params.projectId,
    signal: verdict.signal,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(verdict.summary ? { summary: verdict.summary } : {}),
    ...(verdict.filePath ? { filePath: verdict.filePath } : {}),
    ...(params.transcriptPath ? { transcriptPath: params.transcriptPath } : {}),
    ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    ...(params.generationId ? { generationId: params.generationId } : {}),
    ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
  });

  // Scope fallback: real session → project. (The original also fell back to
  // a per-transcript scope key when the session id was unresolved — a
  // work-around for external-harness hook session recovery misses. That
  // resolution chain isn't ported into @mori/kernel — see this service's
  // module doc / PR notes — so there is no unresolved-session case to fall
  // back from here.)
  const scopeId = params.sessionId ?? params.projectId;

  await appendEvent({
    type: "observation.captured",
    projectId: params.projectId,
    scopeType: "session",
    scopeId,
    actor: params.actor,
    payload: observation,
  });
  await rebuildProjectProjection(params.projectId, { reindexSearch: false });
  return observation;
}
