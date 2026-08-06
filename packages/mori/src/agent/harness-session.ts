import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";

/**
 * Builds the pi `Session` an `AgentHarness` is constructed on.
 *
 * **Nothing calls this yet.** `AgentHarnessOptions.session` is a required constructor
 * argument, so the harness migration (#287) has to answer "which storage" before it can
 * start; this piece answers it and stops. The call site arrives with piece D, which moves
 * `createMoriAgent` onto the harness — do not add one here.
 *
 * ## Storage: `InMemorySessionStorage` — and why the other two are deferred
 *
 * Entries live in the instance and die with the process, which is exactly today's behavior:
 * `mori` builds its `Agent` per run and the conversation does not outlive it. Choosing this
 * is therefore the one option that makes no user-visible change, which matters because this
 * is the hard-to-undo decision of the migration (docs/agent-harness-adoption.md §Q7 marks
 * piece C ★): the moment session files appear on disk, their path and format become a
 * contract with the user, and contracts are not retracted by reverting a commit.
 *
 * The two options NOT taken, and what would have to be true to take them:
 *
 * - **`JsonlSessionStorage` / `JsonlSessionRepo` (one JSONL file per session, on disk).**
 *   Deferred because it creates precisely that contract — `JsonlSessionRepo`'s
 *   `sessionsRoot` is a constructor argument with no default, so whoever wires it picks a
 *   user-visible location, and the on-disk line format becomes something users' tooling can
 *   read. It is deferred, not rejected: this is pi's own format, so operating principle 2
 *   ("prefer a format compatible with pi's types if storage is needed") points here first
 *   when persistence is actually wanted. Swapping is a one-line change at this function,
 *   because everything downstream sees `Session`, not the storage. §Q4 has the comparison.
 *
 * - **A mori-owned `SessionStorage` implementation** (the interface is public, so mori
 *   could back sessions with its own store, e.g. SQLite alongside the kernel's event log).
 *   Deferred as the more expensive half of operating principle 2 — mori storing conversation
 *   in its own format is the data-ownership move the principle says to make carefully. The
 *   requirement that would justify it is "conversation and memory must commit in one
 *   transaction", and that requirement arrives with `ConversationSource` wiring, which is a
 *   separate piece and a separate decision. §Q4 records the seam that exists today anyway:
 *   session-entry appends and kernel-event appends are not one transaction, so a crash
 *   between them leaves a span present in one and absent in the other.
 *
 * ## Keep the returned `Session` — handing it to the harness is not giving it away
 *
 * `AgentHarness` takes `session` in its constructor, stores it in a **private** field, and
 * exposes no getter for it on its public surface. So the reference this function returns is
 * the only handle mori will ever have on the session tree. A caller that constructs the
 * harness and drops the reference silently closes the door on reading conversation text,
 * with no compile error to mark it.
 *
 * What is behind that door: `Session.getEntries({ afterEntrySeq })` returns stored entries
 * as they are, with an append-only offset cursor and no filtering — the surface the
 * follow-on `ConversationSource` piece stands on (§Q3). `Session.getBranch()` cannot
 * substitute: it walks to the nearest compaction entry and stops, so once compaction fires
 * (piece E) everything before the cut is unreachable through it.
 *
 * ## What `/clear` would need on top of this shape — two branches, deliberately not chosen
 *
 * How `/clear` replaces the conversation is a human decision (#7, carried over from PR #290),
 * and it is upstream of piece D. This piece only makes the decision answerable; picking here
 * would make the choice by writing it into the code, so the branches are recorded as facts
 * about pi 0.82.1's public surface, checked against the installed declarations:
 *
 * - **(a) Rebuild the harness.** Call this function again for a fresh `Session` and
 *   construct a new `AgentHarness` around it. Mechanically available today — `session` is a
 *   constructor option, so a new harness is the supported way to get a new one. What gets
 *   dropped with the old harness: the previous `Session` reference (and with
 *   `InMemorySessionStorage`, its entries, since nothing else holds them — anything the
 *   kernel had not yet consumed is gone), plus harness-local state that would have to be
 *   re-applied to the replacement — `models`/`tools`/`activeTools`, `model` and
 *   `thinkingLevel`, `resources`, `streamOptions`, the queue modes, the queued steer /
 *   follow-up / next-turn messages, and every `subscribe()`/`on()` registration.
 *
 * - **(b) Swap the session while keeping the harness.** **There is no such operation.**
 *   `AgentHarness`'s public methods are `prompt`, `skill`, `promptFromTemplate`, `steer`,
 *   `followUp`, `nextTurn`, `appendMessage`, `compact`, `navigateTree`, `getModel`,
 *   `setModel`, `getThinkingLevel`, `setThinkingLevel`, `getTools`, `setTools`,
 *   `getActiveTools`, `setActiveTools`, `getSteeringMode`, `setSteeringMode`,
 *   `getFollowUpMode`, `setFollowUpMode`, `getResources`, `setResources`, `getStreamOptions`,
 *   `setStreamOptions`, `abort`, `waitForIdle`, `subscribe`, `on` — there is no
 *   `setSession` and no `getSession`. Three surfaces sit near this and are none of it:
 *   `AgentHarness.navigateTree(targetId)` and `Session.moveTo(entryId | null)` move the leaf
 *   **within the same session tree** (`moveTo(null)` sets the leaf to null, which empties the
 *   context path while leaving every entry in place and readable through `getEntries()` —
 *   the leaf pointer is itself append-only, so this adds a `leaf` entry rather than removing
 *   anything); and
 *   `InMemorySessionRepo`'s `create`/`open`/`fork` mint `Session`s but cannot re-point a live
 *   harness at one. So (b) as literally stated is unavailable, and the shapes that do exist
 *   differ from (a) in what survives — that difference is the decision material, not a
 *   verdict.
 */
export function createHarnessSession(): Session {
  return new Session(new InMemorySessionStorage());
}
