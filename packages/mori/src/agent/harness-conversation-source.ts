import { randomUUID } from "node:crypto";
import type { AgentMessage, Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { ConversationResumePoint, ConversationSlice, ConversationSource } from "@mori/kernel";

/**
 * The kernel's `ConversationSource` (packages/kernel/src/index.ts), implemented over the pi
 * `Session`'s ENTRY LOG (#425, #7 human decision — pull adapter, base commit `0a73bc4`).
 *
 * This module is the adapter only; injecting it into the kernel/boundary is the follow-on
 * piece. Until that wiring lands, the `post-compact` boundary keeps handing the kernel zero
 * conversation text — `cli/compaction.ts` states that verdict and names this seam as the fix.
 *
 * ## `getEntries`, never `getBranch`
 *
 * `Session.getBranch()` walks from the leaf to the nearest compaction entry and stops
 * (`InMemorySessionStorage.getPathToRootOrCompaction`), so the moment compaction fires,
 * everything before the cut is unreachable through it — and that span is the entire reason
 * this wiring exists (`harness-session.ts`). `getEntries({ afterEntrySeq })` returns stored
 * entries as they are, append-only and unfiltered, so a compaction changes nothing about what
 * this adapter can read.
 *
 * ## The offset IS `afterEntrySeq`
 *
 * `SessionEntryCursorOptions.afterEntrySeq` is an index into the append-only entry array
 * (`getEntries` is `entries.slice(afterEntrySeq, …)` in both `InMemorySessionStorage` and
 * `JsonlSessionStorage`), so it is exactly the "count of entries already consumed" — an
 * integer that only grows as the conversation grows, which is the property the kernel's
 * contract asks for (it compares an offset against the stored watermark and does no
 * arithmetic on it). `newOffset` is therefore `offset + entries.length`.
 *
 * ## `id` is per-`Session`-instance and dies with the process — deliberately
 *
 * The kernel keys its conversation watermark by `id` and stores it in its own SQLite DB, which
 * outlives the process. Today's session storage is `InMemorySessionStorage`
 * (`harness-session.ts`), whose entries do NOT: they die with the process, and the next
 * process's entry log starts empty, i.e. at offset 0. An `id` that survived the process would
 * therefore have the kernel read at a watermark far past the end of a fresh log — no slice
 * ever advances past it, so the conversation axis never drains again. Minting the id per
 * `Session` instance (below) keeps the two lifetimes equal, which is the invariant, not the
 * particular id format.
 *
 * The kernel's own note on `id` — it "must survive across boundaries and across sessions
 * sharing one conversation (compaction splits one conversation over several sessions)" — does
 * not conflict, because in mori compaction does NOT split a session. `AgentHarness.compact()`
 * appends the summary to the SAME session tree (`this.session.appendCompaction(...)`, pi
 * 0.82.1) and mints no new `Session`; `/clear`'s `Session.moveTo(null)` likewise appends a
 * `leaf` entry to the same tree rather than replacing it. So one `Session` IS one conversation
 * here, for its whole life, and "survives across boundaries" is what a per-instance id already
 * gives — boundaries are calls, not process restarts.
 *
 * Durability of the unconsumed tail (switching to `JsonlSessionStorage`) is explicitly out of
 * scope (#425 non-scope, deferred by the same human decision). If that switch ever happens,
 * this id must NOT be replaced by the storage's persisted session id without also making the
 * offset survive alongside it — the two lifetimes are one decision.
 */

/**
 * One id per `Session` instance, for the lifetime of the process and no longer.
 *
 * A `WeakMap` rather than a counter captured in the factory so that constructing the adapter
 * twice over one `Session` — a plausible wiring accident — yields ONE conversation identity
 * rather than two racing watermarks over the same entry log. The keys are `Session` objects,
 * so nothing here outlives the sessions themselves.
 */
const conversationIds = new WeakMap<Session, string>();

function conversationIdOf(session: Session): string {
  const existing = conversationIds.get(session);
  if (existing !== undefined) return existing;
  // Random rather than derived from the session: `Session.getMetadata().id` is minted by the
  // STORAGE, so it would start surviving processes the day storage does — silently taking the
  // id's lifetime past the entry log's, which is the failure this whole note is about.
  const id = `mori-harness-session:${randomUUID()}`;
  conversationIds.set(session, id);
  return id;
}

/**
 * A `ConversationSource` reading the conversational turns out of `session`'s entry log.
 *
 * `read` never throws (kernel contract: an unreadable conversation degrades a boundary, it
 * does not fail one) and returns `undefined` when the log has nothing after `offset`.
 */
export function createHarnessConversationSource(session: Session): ConversationSource {
  return {
    id: conversationIdOf(session),
    async read(offset: number): Promise<ConversationSlice | undefined> {
      let entries: SessionTreeEntry[];
      try {
        entries = await session.getEntries({ afterEntrySeq: offset });
      } catch {
        // Storage failures are the "unreadable" case, not a boundary failure.
        return undefined;
      }
      if (entries.length === 0) return undefined;
      return buildSlice(entries, offset);
    },
  };
}

/**
 * Assembles the slice for `entries`, which are the entries at `offset`, `offset + 1`, … in the
 * append-only log.
 *
 * Resume points are recorded at ENTRY boundaries only: the kernel hands the extractor
 * `text.slice(0, chars)` verbatim, so a point inside a turn would deliver a fragment. One
 * point per distinct prefix length, holding the FURTHEST offset that still shows exactly that
 * prefix — entries contributing no text (tool traffic, a compaction entry) can be consumed
 * without showing anything more, and pinning them behind an earlier offset would only slow the
 * drain.
 */
function buildSlice(entries: readonly SessionTreeEntry[], offset: number): ConversationSlice {
  const turns: string[] = [];
  // chars → the largest offset whose prefix of `text` is exactly `chars` long.
  const pointsByChars = new Map<number, number>();
  let chars = 0;

  for (const [index, entry] of entries.entries()) {
    const turn = turnOf(entry);
    if (turn !== undefined) {
      // The blank-line join contributes to the prefix length of every turn but the first.
      chars += (turns.length === 0 ? 0 : 2) + turn.length;
      turns.push(turn);
    }
    pointsByChars.set(chars, offset + index + 1);
  }

  const text = turns.join("\n\n");
  const newOffset = offset + entries.length;
  const resumePoints: ConversationResumePoint[] = [];
  for (const [pointChars, pointOffset] of pointsByChars) {
    // `0 < chars < text.length` and `offset < newOffset`: an empty prefix resumes nothing, and
    // the whole slice is `newOffset`'s job, never a point's. Both bounds are the kernel's
    // (`resumePointsOf`), which drops violators rather than reporting them.
    if (pointChars > 0 && pointChars < text.length && pointOffset < newOffset) {
      resumePoints.push({ chars: pointChars, offset: pointOffset });
    }
  }
  // Insertion order over the entry log is already ascending in both fields.
  return { text, newOffset, resumePoints };
}

/**
 * The one conversational turn `entry` carries, or `undefined` when it carries none. Exactly two
 * of pi 0.82.1's message roles are conversation — `user` and `assistant` — and only their TEXT
 * blocks are; the rest fall through to `undefined`, each for its own reason:
 *
 * - `toolResult` and `bashExecution`, plus the `toolCall`/`thinking` blocks inside an assistant
 *   message: tool traffic is not conversation (kernel contract), and an assistant turn left
 *   with no text after they are dropped contributes no turn at all.
 * - `compactionSummary` and `branchSummary` (and a `compaction` ENTRY's own `summary`): a
 *   summary is already an extractor-compressed artifact, so feeding it back into distillation
 *   would distill it twice. The verbatim span the summary replaced is still in this very log —
 *   that is what this adapter reads — so nothing is lost by skipping it. (정본 문서 §5.2 R5
 *   keeps the summary as a safety net SEPARATE from kernel re-injection, for the same reason.)
 * - `custom`: harness-authored UI messages, neither said by a human nor answered by the agent.
 *
 * Every other entry type (`leaf`, `label`, `model_change`, …) is bookkeeping, not a message.
 */
function turnOf(entry: SessionTreeEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message: AgentMessage = entry.message;
  if (message.role === "user") return prefixed("USER", textOf(message.content));
  if (message.role === "assistant") return prefixed("AGENT", textOf(message.content));
  return undefined;
}

function prefixed(speaker: string, text: string): string | undefined {
  return text === "" ? undefined : `${speaker}: ${text}`;
}

/** The human-readable text of a message body, with images and non-text blocks dropped. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block: unknown): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
