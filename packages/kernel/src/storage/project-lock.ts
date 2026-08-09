/**
 * Project-scoped, cross-PROCESS mutual exclusion for the store under
 * `getProjectRoot(projectId)` (#132).
 *
 * Everything the kernel had before this was object-scoped and therefore could
 * not cross a process boundary: `SqliteMemoryKernel`'s `enqueue` chain is an
 * instance field, and the harness's `chains` `WeakMap` is keyed by kernel
 * identity. Two `mori` processes opened on the same working root resolve the
 * same `projectId` and write the same database, so both of the kernel's
 * read-modify-write spans were unguarded across them:
 *
 * - **Capture.** `captureObservation` appends the event and then rebuilds the
 *   projection by REPLACING it from a snapshot of the log read moments earlier.
 *   Interleave two of those and the later replace-all commits a snapshot taken
 *   before the other's append: the observation stays in the event log and
 *   disappears from the projection indefinitely (PR #127 Codex P1). The same
 *   gap lets both processes pass the `hasGenesisEvent` check and append two
 *   `project.created` events.
 * - **Boundary.** Two consolidations read the same watermark before either
 *   advances it, and both distill the same window (PR #130 Codex P1).
 *
 * ## How ownership moves
 *
 * The lock is a DIRECTORY created with `fs.mkdir` — `mkdir` on an existing path
 * fails with `EEXIST` on every platform mori supports, which is the whole
 * atomicity requirement for TAKING A FREE LOCK. Deliberately no new dependency:
 * `proper-lockfile` and friends buy retry policy and process-liveness checks
 * that are ~100 lines here, and this repo has already spent two issues (#11,
 * #94) removing exactly that kind of inherited dependency.
 *
 * Taking a free lock is the easy half. The hard half is taking one AWAY from a
 * crashed owner, because a filesystem offers no compare-and-swap: "this lock is
 * abandoned" and "therefore remove it" are separate syscalls, and in between the
 * lock can be released, taken again, and be very much alive. Removing it in
 * place is how a lock silently stops being one (PR #156 review, Codex P1 ①②).
 * So this module never removes `lockDir` in place. One rule covers every
 * transfer:
 *
 * > **Detach, then judge.** An instance is taken with
 * > `rename(lockDir, <unique private path>)`. `rename` is atomic, so for any
 * > given instance exactly one process can detach it and the losers get
 * > `ENOENT` instead of doing damage. What the winner holds is now PRIVATE —
 * > unreachable by anyone else, so it cannot change while being examined. Only
 * > then does the detacher read the owner record and decide whether this is the
 * > instance it meant to take. If it is, dispose of it; if it is not — the lock
 * > turned over between the decision and the `rename` — put it back with
 * > `rename(<private path>, lockDir)` and start over.
 *
 * Reclaiming a crashed owner's lock, releasing our own, and rolling back a
 * half-created one all go through {@link detachAndJudge}. The judgment differs;
 * the mechanism does not.
 *
 * ## How a holder notices it was dispossessed
 *
 * "Detach, then judge" makes an ill-timed detach harmless — the instance goes
 * back — but it cannot make one impossible: the restore fails if a third party
 * has already created a new lock at the path. So a holder watches its own lock
 * instead of assuming it. The heartbeat that refreshes the mtime also re-reads
 * `owner.json`, and a holder whose lock has vanished or now records someone
 * else's token declares it COMPROMISED. Capture surfaces that through
 * `onCaptureError` (one dropped observation); a boundary propagates it. Both
 * beat the silence this module exists to end.
 *
 * That notice reaches `fn` as an `AbortSignal` (#158) — a way for the critical
 * section to bail out of its own accord at a point where bailing out is safe.
 * It is emphatically not a brake this module may pull from outside, and the
 * distinction is the whole of ⑤. A running promise cannot be cancelled from
 * outside, so `withProjectLock` still waits for `fn` to settle and only then
 * fails with {@link ProjectLockCompromisedError}. Settling the wait early —
 * racing the signal against `fn` — would hand the caller a finished call while
 * the work went on running, and the caller that suffers most is the kernel's
 * own capture chain: `enqueue` reads a settled task as "that capture is done"
 * and starts the next one on top of a replace-all projection rebuild still in
 * flight. That is this issue's ① reproduced INSIDE one process, in the one
 * place that had always been safe from it (PR #156 review, Codex P1 ⑤). A
 * section that ignores the signal is therefore still correct — it just holds
 * the overlap open for as long as it runs, which is where this started.
 *
 * ## The overlap that remains
 *
 * One third-party race can still put two critical sections in flight, and it is
 * worth naming precisely (PR #156 review, Codex P1 ⑥). A detacher that judges a
 * private instance NOT to be the one it meant to take restores it — but the
 * restore needs the path to be free, and a third acquirer may have `mkdir`'d
 * there first. The restore then fails and the detacher disposes of a lock that
 * belongs to a live holder, who now shares the section with that third
 * acquirer. Entry is narrow: the filter in {@link acquire} does not disturb
 * locks whose local owner is alive, so reaching the restore path at all takes a
 * lock turning over between the filter and the `rename`.
 *
 * How long it lasts is the honest part, and #158 shortened it. The dispossessed
 * holder still learns within one heartbeat, but learning is now also STOPPING:
 * `withProjectLock` hands `fn` an `AbortSignal` that {@link lose} aborts, and
 * the critical sections check it at named points. The overlap therefore ends at
 * the dispossessed section's next check point rather than when its `fn` ends —
 * which matters most at a consolidation boundary, where `fn` can sit inside an
 * extraction LLM call for minutes. The check points, each chosen so that
 * nothing the section meant to commit has reached disk yet:
 *
 * - `capture-service.ts`'s `captureObservation` — before the
 *   `observation.captured` append, and again before the replace-all projection
 *   rebuild.
 * - `consolidate-service.ts`'s `consolidate` — before the watermark-only noop
 *   commit, before the extraction call (and forwarded INTO it, so an in-flight
 *   request is cancelled too), before the raw-segment write, and before the
 *   `memory.consolidated` append.
 *
 * ### Where the check points stop, and what covers the rest (#211)
 *
 * "Ends at the next check point" is true only where a next check point can
 * exist, and at a boundary it runs out before the section does. The last one
 * is check point ④, immediately before the rest of the tail; everything after
 * it has none. What gates entry into that rest is not the
 * `memory.consolidated` append alone: the rebuild below runs on
 * `inputs.length > 0 || segmentsWritten > 0` (`packages/kernel/src/services/consolidate-service.ts:2910`),
 * so a conversation-only boundary — no memories extracted (`inputs.length ===
 * 0`) but raw segments written from the transcript slice — still reaches
 * `pruneSegments`, `rebuildProjectProjection` (its segment-FTS reindex
 * included), and `ensureSegmentEmbeddings`, with no `memory.consolidated`
 * event ever appended (#248, correcting an earlier draft that named the
 * append as the tail's only gate — Codex P2 on PR #245, third round). That
 * TAIL holds most of a boundary's wall-clock (up to two projection rebuilds,
 * two embedder round trips, and — whenever a configured judge flags a
 * candidate pair — one LLM call per pair compared, `detectContradictions`'s
 * judge loop, which only runs on the `inputs.length > 0` branch, so a
 * segment-only tail is shorter but no better protected; #227 corrects an
 * earlier count that omitted the judge calls, Codex P2 on PR #245). A holder
 * dispossessed inside it therefore runs to the end, and the doc must not read
 * as though it stopped.
 *
 * There is no fifth check point to add, and that is a consequence of the rule
 * above rather than an omission — though what is already on disk, and what a
 * fifth check point would protect, differs by which branch let the tail
 * start. Where memories were extracted: past the append, the memories ARE on
 * disk, so stopping there would leave them distilled with the cursor unmoved
 * and hand the same window to the next boundary — a rare race traded for a
 * certain duplicate. Where none were, only `segmentsWritten > 0`: there is no
 * append to stop after — the raw segments are already on disk before the tail
 * even starts (check point ④ sits after the raw-segment write, per the check
 * point list above). What a fifth check point would instead protect is the
 * segment-FTS reindex inside `rebuildProjectProjection` — but
 * `commitBoundaryCursors` (①), including the CONVERSATION offset it advances
 * on `sliceFullyStored` (`consolidate-service.ts`'s `consolidate()`, which
 * does not consult `inputs.length` at all), sits at the very end of
 * `consolidate()`, after that reindex. Stopping before it therefore means
 * neither cursor moves (`packages/kernel/src/services/consolidate-service.ts:2681-2685`), same as check
 * point ④ already guarantees on the memory-extraction branch: the watermark
 * stays exactly where `consolidate()` found it, and the next boundary
 * re-chunks and re-inserts the same slice — a duplicate `pruneSegments`
 * bounds and heals, not a lost SEGMENT PROJECTION behind an already-advanced
 * offset.
 *
 * What runs after the append, in order, each classified by what a race there
 * can actually cost (#227; corrects an earlier draft that missed three writes
 * and over- or under-stated two more — Codex P2 on PR #245, two rounds):
 *
 * - `pruneSegments` — the lock-free DELETE races exactly as before (see
 *   below); what #255 closes is the accounting a caller built on top of it.
 *   `segments` the table was always immune. The boundary that wrote the
 *   pruned ids no longer trusts its own stale `prunedSegmentIds` snapshot —
 *   `commitBoundaryCursors` re-verifies LIVE, inside its own commit
 *   transaction, that those ids are still rows before advancing the
 *   conversation offset they justify (see below, and ① below).
 * - `rebuildProjectProjection` — the lock-free replace-all races exactly as
 *   before (see below); what #270 closes is the write it used to land on a
 *   snapshot the log had already moved past. The rebuild no longer trusts the
 *   `readEvents` array it computed from — it carries THAT read's own head as a
 *   token and re-compares it LIVE, inside its own IMMEDIATE write transaction,
 *   before the first DELETE. A successor's rows are therefore no longer
 *   overwritten by an older state: the stale rebuild writes nothing, re-reads,
 *   and (past `REBUILD_STALE_HEAD_RETRIES`) reports `committed: false` rather
 *   than a rebuild that did not happen. Still UNSAFE for the READER, and
 *   that half is untouched here: committing only current snapshots bounds how
 *   stale a rebuild's OWN write can be, not how stale the projection a
 *   consumer (`listValidMemories` in `memory-retrieval-service`,
 *   `search-service`, `embeddings-service`) reads at the moment it reads it —
 *   #263 axis 1, open on #189. `consolidateBoundary` is no longer one of those
 *   consumers: #298 derives its whole basis from the log instead.
 * - `ensureEmbeddings` — SAFE ENOUGH: a keyed UPSERT into `embeddings`, a
 *   table this rebuild never touches, so a stale write is not "healed by the
 *   next rebuild" (an earlier draft's error) but by that entity's own next
 *   `ensureEmbeddings` pass, via its `textHash`/`model` staleness check.
 * - `detectContradictions` — UNSAFE: runs after `ensureEmbeddings` (reads its
 *   vectors), and its own `memory.superseded` + `conflict.detected` append is
 *   not idempotent — `createConflict` mints a fresh random id, not one derived
 *   from the judged pair, so a dispossessed judge's stale verdict and a
 *   successor's both land as permanent, separate log entries; it also fires a
 *   second `rebuildProjectProjection`, exposed to the same race as above.
 * - `ensureSegmentEmbeddings` — the DELETE on the other side of the same
 *   `pruneSegments` race still lands under it exactly as before (see below);
 *   what #255 closes is what an in-flight embed call used to leave behind.
 *   `upsertSegmentEmbeddingIfLive` re-checks LIVE, inside its own commit
 *   transaction, that the segment is still a `segments` row before writing
 *   its vector — SKIPPED, not orphaned, when it is not
 *   (`embeddings-service.ts`, #255 defect 2; see below).
 * - `commitBoundaryCursors` (①) — SAFE: MONOTONIC against stored state inside
 *   the commit transaction, so it holds whether or not this holder ever learns
 *   it was dispossessed (PR #210 Codex P1). Since #255 the same IMMEDIATE
 *   transaction also carries a second, unrelated guard:
 *   `conversationOffsetGuardIds` re-verifies LIVE, via `segmentsStillPresent`,
 *   that the segments `sliceFullyStored` trusted are still on disk before
 *   writing the conversation offset they justify — a concurrent
 *   `pruneSegments` that beat this transaction to it drops that write instead
 *   of landing it on a stale premise (`conversationSliceHeld` surfaces the
 *   drop as "held", the same signal a check point failure would give).
 * - `recordAttempt` (②) — PARTIALLY GUARDED: declines once this holder's
 *   signal has fired, but the signal lags the actual takeover by up to one
 *   heartbeat, so a successor fast enough to finish inside that lag can still
 *   be overwritten (PR #225 review, Codex P2). What survives is an
 *   OBSERVABILITY-only defect — nothing branches on `last_consolidate_attempt`
 *   — closing it needs a lock redesign or a relocated record, both out of
 *   #211's and this doc's scope (idea #189).
 *
 * ### The lock-free DELETE that is safe for `segments`, and — since #255 — for what gets built on it too: `pruneSegments`
 *
 * `pruneSegments` (`segment-store.ts`) reads which segment ids are aged out or
 * over the retention cap, then deletes exactly those ids from
 * `segments`/`embeddings`/`search_fts` in one transaction — a
 * SELECT-then-DELETE-by-id pair with the same shape of gap this doc is
 * otherwise about. `segments` THE TABLE stays consistent no matter how that
 * interleaves — `embeddings` and `search_fts`, deleted by the same
 * transaction, do NOT share that immunity (see below) — for a reason specific
 * to `segments`: its rows are INSERT-or-DELETE only, never UPDATE'd, so
 * nothing a concurrent successor does can un-mark an
 * id one of these two SELECTs already named aged-out or over-cap, and a
 * successor racing its own `pruneSegments` over the same ids just deletes zero
 * rows the second time — idempotent, not corrupting. `rebuildProjectProjection`'s
 * own segment-FTS reindex (`listSegments(projectId, "union")`, `projection-store.ts`)
 * makes the same point from the other side: unlike the entity tables below, it
 * is queried LIVE inside the synchronous replace-all transaction rather than
 * carried in the pre-`await` snapshot, so whatever `pruneSegments` has
 * committed by the time that transaction runs is exactly what gets reindexed.
 *
 * What is NOT safe is the accounting a caller builds on top of it (Codex P2 on
 * PR #245, correcting an earlier "turns out to be safe" verdict in this doc) —
 * or rather, was not, until #255 closed it at the point that accounting gets
 * spent. The aged-row SELECT and the over-cap SELECT above are themselves two
 * separate autocommit statements, not one snapshot bundled with the DELETE —
 * the aged query runs, then, with nothing holding the two together, the
 * over-cap query runs against whatever `segments` looks like by then. A
 * successor's `insertSegments` can land in between, and on an oversized slice
 * (over `SEGMENT_RETENTION_MAX`) or a caller-supplied smaller cap — the same
 * condition that already lets a single boundary evict its OWN just-written
 * chunks within the same call (`consolidate-service.ts`'s
 * `ConsolidateResult.conversationSliceHeld` doc, case 3) — a `created_at` tie
 * between two boundaries racing within the same millisecond,
 * broken only by `ordinal DESC`, can put some of the SUCCESSOR's own
 * just-inserted ids past the cap instead of the caller's own older ones. If A
 * (dispossessed, still running this tail) deletes part of B's (the new
 * holder's) slice this way before B reaches its own `pruneSegments` call, the
 * INTERLEAVE itself still happens exactly as it always did — #255 touches
 * neither this DELETE nor the two SELECTs above it. What no longer follows
 * from it is B's offset silently advancing over the gap: `sliceFullyStored`
 * in `consolidate-service.ts` is still computed from only the
 * `prunedSegmentIds` B's OWN call returned, but that premise is no longer
 * trusted as final — `commitBoundaryCursors` re-checks it LIVE, via
 * `segmentsStillPresent`, inside the same transaction that would otherwise
 * write the conversation offset it justifies (#255). If any of B's ids are
 * gone by then, that write is dropped instead of landing: the offset holds,
 * `ConsolidateResult.conversationSliceHeld` surfaces the hold, and the next
 * boundary re-chunks and re-stores the same slice rather than resuming past
 * content whose one durable copy is gone. `segments` the TABLE is the one
 * piece of a boundary's tail the projection race below does not touch;
 * `segments` the RETENTION BUFFER still races the same way as always — only
 * the CONSEQUENCE of that race changed, from a silently advanced offset to an
 * observable hold.
 *
 * A second gap sat on the `embeddings` side of the same DELETE (Codex P2 on
 * PR #245; closed by #255, this round). `ensureSegmentEmbeddings`
 * (`embeddings-service.ts`) still snapshots `listSegments` before its embedder
 * `await`, and the DELETE still races that `await` exactly as before — #255
 * removes neither the snapshot nor the race. What changed is the write at the
 * other end: a stale segment's vector no longer lands in `embeddings` by a
 * plain upsert keyed on `seg.id`. `upsertSegmentEmbeddingIfLive` re-checks
 * LIVE, inside its own commit transaction, that the segment is still a
 * `segments` row before writing; if a `pruneSegments` call deleted it from
 * `segments`/`embeddings`/`search_fts` while the embedder call was in flight,
 * the write is skipped and not counted toward `embedded` (#255 defect 2) —
 * where the old behavior landed an orphaned `embeddings` row nothing
 * downstream retargeted, the new one leaves no row to orphan. Cleaning up
 * orphans that predate #255 is idea #189's, not this doc's.
 *
 * ### The lock-free replace-all, and what it refuses to commit since #270: `rebuildProjectProjection` (Codex P2, PR #225)
 *
 * The entity tables (`memories`, `tasks`, `decisions`, ...) do not get the
 * same pass. `rebuildProjectProjection` snapshots the event log with
 * `readEvents` before its `await`s, and its write transaction later replaces
 * those tables wholesale from that snapshot — so a successor who commits a
 * newer one in between used to be not merged with, but OVERWRITTEN BY, the
 * stale one:
 *
 * ```
 * T1  A passes ④, the memory.consolidated append lands on disk
 * T2  A's rebuildProjectProjection snapshots the event log (readEvents)
 * T3  A's window runs from the T2 snapshot to the write transaction's start —
 *     first a SYNCHRONOUS full-log replay (`reduceProjectState`,
 *     `latestImportedRules`, `buildMemoryIndex`), only then, if
 *     `reindexSearch` is true, an `await` per imported topic's `.md` file
 *     (skipped entirely when false, the capture path) — so it opens on log
 *     size alone, even with zero imported topics, not on `.md` reads alone
 *     (#227, correcting an earlier draft that named only the file reads —
 *     Codex P2 on PR #245). Sometime in that window a third acquirer's
 *     detach-then-judge races A's still-live lock ("The overlap that remains"
 *     above) and loses the restore to B's fresh mkdir, so A's instance is
 *     disposed and B takes the lock — NOT a heartbeat lapse: a live local
 *     owner is never reclaimed on age ({@link isAbandoned})
 * T4  B runs a boundary of its own: append, rebuild, cursor commit — the full
 *     sequence, though T5 below only needs B's first two to land before it;
 *     see the requirement note past this diagram
 * T5  A wakes and opens its write transaction. PRE-#270 it replaced the
 *     projection tables from its T2 snapshot and B's memories vanished from
 *     the projection (the event log still had them). SINCE #270 the first
 *     thing inside that transaction is the head re-check, which sees B's
 *     T4 append and not A's T2 token, so A writes nothing at all — not one
 *     DELETE, and not the topic `.md` files either — and goes back to T2 for
 *     a fresh snapshot, one that now contains B's events
 * T6  A's commitBoundaryCursors compares against stored state and loses — ①'s
 *     monotonic guard correctly drops A's target, so the watermark stays at
 *     B's, not A's
 * ```
 *
 * The pre-#270 result was a store that said the window was consumed (the
 * watermark is past it) while the projection could not show what it was
 * consumed INTO (B's memories missing from it) — until something rebuilt
 * again. Since #270 that specific divergence does not open: the only writes
 * that land are ones whose snapshot was still the log's head when the write
 * transaction took its lock, so the projection never regresses behind an
 * append it has already shown. What replaces it is a WEAKER outcome, not
 * nothing — A can exhaust its retries on a store that keeps moving and return
 * `committed: false`, leaving the projection exactly as B left it (B's rows
 * intact, A's own appended events not yet projected) until the next rebuild
 * that completes. That is the same "recovery is bounded by the next capture
 * or boundary that RUNS TO COMPLETION" the paragraphs below describe, reached
 * without overwriting anyone.
 *
 * What #270 does NOT give — and the reason this section's classification above
 * stays qualified — is freshness for a READER. A consumer that reads the
 * projection between B's append and B's rebuild still sees a state older than
 * the log, exactly as before; #270 constrains who may write, not when the
 * write has happened by. That half is #263's axis 1, still open on #189.
 *
 * PR #225 changed what that "until" costs — though not as unconditionally as
 * an earlier draft of this doc claimed (Codex P2 on PR #245, corrected here).
 * Before it, ①'s guard did not exist, so T6 wrote A's target over B's
 * unconditionally. That is a rollback the next boundary is handed a gap to
 * reprocess ONLY when B's window reached FARTHER than A's — a newer
 * observation or a longer conversation slice arriving during the race. In the
 * narrower case T1–T6 actually describes, where B starts before A has
 * committed anything and so re-reads the identical stale watermark A did,
 * A's unconditional write lands an EQUAL target, not a rollback — there is no
 * gap for a third boundary to find, and what A and B both paid for is the
 * ordinary duplicate distillation #132 exists to remove, not an additional
 * loss. And even where a gap does open, "reprocessed B's window
 * deterministically, and ITS rebuild restored the projection" overstates the
 * recovery: A's own stale replace-all (T5 as it stood before #270 refused it)
 * already wrote A's memory for the
 * shared part of the window into the projection, so the next boundary's
 * `consumed` dedup guard (`consolidate-service.ts`'s `consolidate()`)
 * suppresses those
 * same observations again regardless of where the watermark points — since
 * #298 that guard reads the `memory.consolidated` payloads out of the log
 * itself, so it no longer even depends on A's replace-all having landed — what a
 * pre-#225 rollback recovered was B's memory, not A's, and only for the part
 * of B's window A's target did not already reach. ①'s guard rejecting the
 * rollback is correct either way — the duplicate was the actual defect — but
 * what it removes is narrower than "the only thing closing this gap": before
 * #225 the honest answer to "what covers this tail" was "an unrelated
 * guarantee, incidentally, and only when a successor's window outran the one
 * it deposed".
 *
 * Codex's original framing overstates what survives: "even another
 * consolidation with no new input will not rebuild them" is not what the code
 * does. `rebuildProjectProjection` replaces the entity tables from the WHOLE
 * event log, not a window, so B's memories — still in the log, never lost —
 * come back into the projection at the next rebuild that actually completes.
 * That is not unconditionally the next capture (Codex P2 on PR #245,
 * corrected here): `captureObservation` checks `throwIfDispossessed` right
 * before its own rebuild call (`capture-service.ts` check point ②) and exits
 * WITHOUT rebuilding when its own signal has already fired — the identical
 * tail gap this doc is about, one layer up, on the cheapest path through the
 * kernel. What is true is that rebuilds are frequent rather than rare — a
 * boundary rebuilds whenever it wrote anything (`inputs.length > 0 ||
 * segmentsWritten > 0`), and every capture attempts one — so recovery is
 * bounded by the next capture or boundary that RUNS TO COMPLETION, not
 * strictly the next one attempted. #270 adds one more way an attempted
 * rebuild declines to write (losing its head CAS past the retry cap, above),
 * which lengthens that bound in exactly the contended case where the OLD
 * behavior would have written the wrong thing instead. On an active project that is still
 * minutes, not indefinite; a project whose captures keep landing mid-takeover
 * (a pathological run of bad luck, not the typical case) could see it
 * stretch further. The damage stays observation staleness, never permanent
 * loss — the log always has it — but "the next capture" was too strong a
 * bound to promise it by.
 *
 * The window itself is narrow, and the doc should not hide that either — but
 * "no external call in it" is narrower than an earlier draft made it sound
 * (#227, correcting that draft; Codex P2 on PR #245). What T4 actually needs
 * is narrower still than #227 left it (#248, correcting THAT draft; Codex P2
 * on PR #245, third round): the damage at T5 only needs B's OWN
 * `memory.consolidated` append and B's OWN `rebuildProjectProjection` to land
 * before A's write transaction starts, not the whole of T4. B's
 * `commitBoundaryCursors` — the last call in a boundary
 * (`consolidate-service.ts`, after the rebuild and the embedder/judge calls)
 * — does not have to finish inside T3 at all; it can land after A's T5, even
 * after A's T6, since ①'s monotonic guard there compares A's target against
 * whatever IS stored at commit time and drops it correctly either way. The T4
 * line above still lists all three calls because that is what a full
 * boundary actually runs, not because the cursor commit is part of what has
 * to fit inside T3. AND T3 itself only opens through the narrow three-party
 * detach race above, not on every contended acquire. T3 is short relative to
 * an extraction LLM call, but this is only the FIRST rebuild's T3;
 * `detectContradictions` runs later in the same tail and opens the identical
 * race around its OWN `rebuildProjectProjection` call, regardless of whether
 * extraction used an LLM at all — any boundary with a configured judge and a
 * decision pair over the cosine threshold pays an LLM round trip there. A
 * tail with judge calls in it is a LONGER tail, so the real requirement is no
 * external call ANYWHERE in the tail, not just no extraction LLM — narrower
 * than "a rule-based consolidator" alone guarantees. Narrow is not the same
 * as absent, and dropping the cursor-commit requirement makes it wider than
 * #227 had it, not narrower — it is still why Codex rated this P2 rather than
 * P1, on the strength of the three-party race and the no-external-call
 * requirement alone.
 *
 * Closing it for real needs the store to enforce what a filesystem lock
 * cannot: a projection write that fails against a newer snapshot instead of
 * silently winning against it (a compare-and-swap on the replace-all, or
 * removing the lock-free write entirely). That is a storage-layer change, not
 * a lock one, and was out of the scope of the issue this paragraph was written
 * for. #270 has since taken the first of those two options for the replace-all
 * — the head CAS described above — so the projection write is no longer the
 * part that silently wins. What the same three-party race can still cost is
 * the appends made around it: `detectContradictions`'s non-idempotent
 * `memory.superseded` + `conflict.detected` pair (above), and the staleness a
 * consumer reads between an append and the rebuild that projects it (#263 axis
 * 1). Both remain open on idea #189.
 *
 * What did NOT change is ⑤: the signal is a way out from INSIDE `fn`, never a
 * way to settle the wait around it. `withProjectLock` still returns only once
 * `fn` has settled, for exactly the reason below.
 *
 * That is still the better failure. The overlap this module exists to end is
 * unbounded, unconditional and SILENT — every pair of processes, every capture,
 * discovered only as a memory that is missing. This one needs a three-way race
 * to start, and it announces itself to the loser: one reported error against a
 * store that quietly loses observations.
 *
 * Related but separate: `fs-utils.ts`'s {@link withFileLock} guards an
 * arbitrary FILE path (the event-store's own use, #18) and takes no view of
 * project identity or of who owns the lock. This module is the project-scoped
 * one — it knows the path rule, records an owner, and reclaims after a crash.
 */

import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MemorizeError } from "../shared/errors.js";
import { ensureDir, isEnoent } from "./fs-utils.js";
import { getProjectRoot } from "./path-resolver.js";

/** Lock directory name, directly under the project root (`path-resolver.ts`'s rule). */
const LOCK_DIR_NAME = "kernel.lock";

/** Owner record, written inside the lock dir right after the winning `mkdir`. */
const OWNER_FILE_NAME = "owner.json";

/**
 * How long a lock whose owner we CANNOT interrogate may go without a heartbeat
 * before another acquirer treats it as abandoned.
 *
 * That is two cases and only two: an owner recorded on another host (a shared
 * home directory — we cannot ask about a process on another machine) and an
 * instance whose owner record is missing or corrupt. A lock owned by a live
 * process on THIS host is never reclaimed on age, however long it has been
 * silent — see {@link isAbandoned}.
 *
 * The holder refreshes the lock's mtime every {@link LOCK_HEARTBEAT_MS} while
 * it works, so this is not a bound on how long a critical section may run: a
 * consolidation boundary that spends two minutes inside an extraction LLM call
 * keeps its lock the whole time.
 */
const LOCK_STALE_MS = 30_000;

/** Heartbeat period; {@link LOCK_STALE_MS} / 6. Unref'd, so it never holds the process open. */
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Upper bound on waiting for someone else's lock.
 *
 * Chosen strictly GREATER than {@link LOCK_STALE_MS} on purpose: an
 * uninterrogable owner is reclaimed after at most `LOCK_STALE_MS`, and a dead
 * local one immediately, so hitting this timeout means a LIVE holder genuinely
 * ran for a minute — a wedged extractor, not a corpse. That distinction is what
 * makes the timeout reportable rather than routine.
 *
 * It is bounded at all because the capture path must not be able to hang an
 * agent's session-end drain forever; a dropped observation degrades memory,
 * a hung boundary hangs the user.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

/** Poll backoff bounds while waiting for a held lock. */
const POLL_MIN_MS = 10;
const POLL_MAX_MS = 250;

/**
 * Grace period after the winning `mkdir` before re-reading the owner file to
 * confirm we are still the recorded owner.
 *
 * A backstop, not the mechanism: "detach, then judge" is what keeps a live lock
 * from being carried off. This catches the residue — a detacher putting an
 * instance back can only do so while the path is free, and its `rename` will
 * overwrite an empty directory another acquirer has just `mkdir`'d. The victim
 * of that is always mid-acquisition, and this re-read is how it finds out.
 */
const LOCK_SETTLE_MS = 10;

export interface ProjectLockOptions {
  /** Override {@link LOCK_ACQUIRE_TIMEOUT_MS}. Tests only — callers use the default. */
  acquireTimeoutMs?: number;
  /** Override {@link LOCK_STALE_MS}. Tests only — callers use the default. */
  staleMs?: number;
  /** Override {@link LOCK_HEARTBEAT_MS}. Tests only — callers use the default. */
  heartbeatMs?: number;
}

/** Thrown when the lock could not be taken within the acquire timeout. */
export class ProjectLockTimeoutError extends MemorizeError {
  constructor(projectId: string, waitedMs: number, lockDir: string) {
    super(
      `Timed out after ${waitedMs}ms waiting for the project lock of ${projectId} ` +
        `(another mori process is holding it). If no mori process is running, ` +
        `remove ${lockDir} to clear it.`,
    );
    this.name = "ProjectLockTimeoutError";
  }
}

/**
 * Thrown when the lock was taken away from us while we were inside it.
 *
 * A verdict on the span, and — since #158 — also the reason carried by the
 * `AbortSignal` handed to `fn`, so a critical section that stops itself at a
 * check point rejects with the very error `withProjectLock` would have thrown
 * after it. The two paths are deliberately indistinguishable to a caller: what
 * differs is how much of the section ran, never what the failure is called.
 *
 * `withProjectLock` still waits for `fn` to settle and reports afterwards,
 * because settling the call while the work continues is its own corruption (see
 * the module doc). What this error buys is that the span cannot be MISTAKEN for
 * a guarded one: an overlap that would otherwise have committed in silence
 * reaches the caller.
 */
export class ProjectLockCompromisedError extends MemorizeError {
  constructor(projectId: string) {
    super(
      `The project lock of ${projectId} was taken over by another process while it ` +
        `was held; the work it was guarding is not safe to trust.`,
    );
    this.name = "ProjectLockCompromisedError";
  }
}

/**
 * Cooperative cancellation check point (#158) — throw if this section's lock is
 * already gone, otherwise return and carry on.
 *
 * Rethrows the signal's own `reason`, which for every signal `withProjectLock`
 * hands out is a {@link ProjectLockCompromisedError}. That is what unifies the
 * two exits: #132 fixed the rule that `withProjectLock` never overwrites `fn`'s
 * rejection, and this needs no exception to it — `fn`'s rejection simply IS the
 * lock's verdict.
 *
 * Every call site must satisfy one condition, and it is the entire safety
 * argument for this feature: **nothing the section meant to commit may already
 * be on disk.** Stopping halfway through a commit would manufacture exactly the
 * damage #132 removed — a projection replaced from a stale snapshot, a
 * watermark advanced past a window nothing distilled. What HAS reached disk at
 * each check point is spelled out at the check point itself.
 */
export function throwIfDispossessed(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  // Defensive: a signal from anywhere but `lose()` still means stop, it just
  // cannot claim to be a lock verdict, so it is reported as what it is.
  throw reason instanceof Error
    ? reason
    : new MemorizeError(`Critical section aborted: ${String(reason)}`);
}

interface OwnerRecord {
  /** Unique per acquisition — distinguishes our lock from a same-PID re-acquisition. */
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/** A lock instance as seen at one path at one moment. */
interface InstanceView {
  stat: Stats;
  owner: OwnerRecord | undefined;
}

export function getProjectLockDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), LOCK_DIR_NAME);
}

/** True when the owner record was written by a process on this machine. */
function isLocalOwner(owner: OwnerRecord): boolean {
  return owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0;
}

/**
 * True when a LOCAL `pid` is definitely gone.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the process is
 * addressable. `EPERM` means it exists but belongs to another user, which is
 * "alive" for our purposes.
 */
function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readOwner(lockDir: string): Promise<OwnerRecord | undefined> {
  try {
    const raw = await fs.readFile(path.join(lockDir, OWNER_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<OwnerRecord>;
    if (typeof parsed.token !== "string" || typeof parsed.hostname !== "string") return undefined;
    if (typeof parsed.pid !== "number") return undefined;
    return parsed as OwnerRecord;
  } catch {
    // Missing, half-written or corrupt: the caller falls back to the mtime
    // check, which needs no cooperation from the owner.
    return undefined;
  }
}

/**
 * Look at whatever is at `target`, or `undefined` when nothing is.
 *
 * Throws for a non-directory: a plain file where a lock belongs is not a lock
 * we can reason about, and no amount of waiting will turn it into one.
 */
async function inspect(target: string): Promise<InstanceView | undefined> {
  let stat: Stats;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new MemorizeError(`Project lock path exists but is not a directory: ${target}`);
  }
  return { stat, owner: await readOwner(target) };
}

/**
 * Whether an instance may be taken away from its recorded owner.
 *
 * When the owner is a process on this host the OS is authoritative and age is
 * not evidence: `kill(pid, 0)` answers the question outright, so a live owner
 * keeps its lock however long its heartbeat has been silent. The heartbeat is a
 * `setInterval`, and what stops it running is a blocked event loop — a
 * synchronous projection rebuild over a large log, or a suspended laptop —
 * which is precisely when the owner is about to wake up and commit (PR #156
 * review, Codex P1 ③). Reclaiming there recreates the corruption this module
 * exists to prevent.
 *
 * Age stays the only available signal for an owner on another host, and for an
 * instance whose owner record cannot be read at all.
 *
 * The residue is PID reuse: a crashed owner whose number has been inherited by
 * an unrelated process reads as alive forever, so its lock is never reclaimed.
 * We accept that, because the alternative is a clock racing an unbounded
 * critical section — which is exactly what ③ is. This failure is loud and
 * fixable in one step ({@link ProjectLockTimeoutError} names the directory to
 * remove); an over-eager reclaim is silent and corrupts the store.
 */
function isAbandoned(view: InstanceView, staleMs: number): boolean {
  const owner = view.owner;
  if (owner && isLocalOwner(owner)) return isPidGone(owner.pid);
  return Date.now() - view.stat.mtimeMs > staleMs;
}

/**
 * Take the instance currently at `lockDir` out of everyone else's reach, decide
 * whether it is the one we meant to take, and either dispose of it or put it
 * back. The one place ownership is ever transferred — see the module doc.
 *
 * `accept` runs against the DETACHED instance, where it cannot change under us.
 */
async function detachAndJudge(
  lockDir: string,
  privatePath: string,
  accept: (view: InstanceView) => boolean,
): Promise<"disposed" | "restored" | "absent"> {
  try {
    await fs.rename(lockDir, privatePath);
  } catch (error) {
    // Someone else detached it first, or it was released outright. Either way
    // we did no damage and there is nothing here to transfer.
    if (isEnoent(error)) return "absent";
    throw error;
  }

  let view: InstanceView | undefined;
  try {
    view = await inspect(privatePath);
  } catch {
    // Unreadable — not something we can claim to recognize. Put it back.
    view = undefined;
  }

  if (view && accept(view)) {
    await fs.rm(privatePath, { recursive: true, force: true }).catch(() => {});
    return "disposed";
  }

  try {
    await fs.rename(privatePath, lockDir);
    return "restored";
  } catch {
    // The path is occupied again, so a NEWER instance already owns this lock
    // and the one in our hands is obsolete whatever we do with it. Dropping it
    // beats leaving a stray directory behind.
    await fs.rm(privatePath, { recursive: true, force: true }).catch(() => {});
    return "disposed";
  }
}

/**
 * Run `fn` while holding this project's lock, then release it.
 *
 * The lock directory lives under `getProjectRoot(projectId)`, so acquiring it
 * creates that directory when it is missing. That is not "the lock creating the
 * store": `projectStoreExists` keys off the DATABASE file, and every caller of
 * this function is on its way to `ensureProjectDirectories` in the same breath.
 * A session that captures nothing and consolidates nothing never gets here at
 * all, which is what keeps the read-only-turn guarantee (README.md:163-165) intact.
 *
 * NOT reentrant. A holder must not call back into this function for the same
 * project — see `SqliteMemoryKernel.consolidateWithResult`, which drains its
 * capture queue OUTSIDE the lock precisely because those queued captures take
 * it themselves.
 *
 * `fn` receives an `AbortSignal` that fires the moment this holder is
 * dispossessed (#158). Honouring it is OPTIONAL — a zero-argument `fn` is still
 * a valid one and behaves exactly as it did — and it is only ever a way out
 * from inside; see {@link throwIfDispossessed} for the rule every check point
 * obeys, and the module doc for why the wait around `fn` is never raced.
 */
export async function withProjectLock<T>(
  projectId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: ProjectLockOptions = {},
): Promise<T> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const lockDir = getProjectLockDir(projectId);
  const owner: OwnerRecord = {
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  await acquire(lockDir, owner, acquireTimeoutMs, staleMs, projectId);

  // Set by the heartbeat, read once `fn` has settled. A flag rather than a
  // racing promise on purpose — see "How a holder notices it was dispossessed".
  let dispossessed = false;

  // #158: the same verdict, delivered INWARD. Never raced against `fn` — the
  // only thing that can act on it is `fn` itself, at a check point of its own
  // choosing (⑤).
  const dispossession = new AbortController();

  const heartbeat = setInterval(() => {
    void beat();
  }, heartbeatMs);
  heartbeat.unref();

  function lose(): void {
    dispossessed = true;
    clearInterval(heartbeat);
    // The reason is the error the caller would get anyway, so a section that
    // stops itself and one that runs to the end fail identically.
    dispossession.abort(new ProjectLockCompromisedError(projectId));
  }

  async function beat(): Promise<void> {
    const now = new Date();
    try {
      await fs.utimes(lockDir, now, now);
    } catch (error) {
      // Gone means gone: only an owner or a reclaimer removes a lock, and we
      // are the owner. Any other error (a full disk, say) says nothing about
      // ownership and is no reason to declare the lock lost.
      if (isEnoent(error)) lose();
      return;
    }
    const current = await readOwner(lockDir);
    // An unreadable record is NOT evidence of a takeover — a dispossessor
    // replaces the whole directory, which the check above already catches.
    if (current && current.token !== owner.token) lose();
  }

  try {
    const result = await fn(dispossession.signal);
    // Only here, with `fn` settled: a caller who is told this call is over must
    // be able to believe that the work it guarded is over too.
    //
    // A rejection from `fn` itself is left alone rather than overwritten with
    // this one. The caller already learns the section failed, and `fn`'s error
    // is the one that says what went wrong; a lost lock adds no diagnosis a
    // failed span needs.
    if (dispossessed) throw new ProjectLockCompromisedError(projectId);
    return result;
  } finally {
    clearInterval(heartbeat);
    // Reached only once `fn` has settled, so the lock is never handed on while
    // the work it guarded is still running.
    //
    // A holder that was dispossessed skips the release: nothing at the path is
    // ours any more, and detaching to prove it would briefly expose whoever
    // holds it now. Releasing a lock we lost is exactly the in-place removal
    // this module refuses to do.
    if (!dispossessed) await release(lockDir, owner.token);
  }
}

async function acquire(
  lockDir: string,
  owner: OwnerRecord,
  acquireTimeoutMs: number,
  staleMs: number,
  projectId: string,
): Promise<void> {
  const deadline = Date.now() + acquireTimeoutMs;
  let backoffMs = POLL_MIN_MS;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const result = await tryAcquireOnce(lockDir, owner, attempt);
    if (result === "acquired") return;

    // "retry" = the project root was missing and we just created it; the lock
    // itself was never contended, so go straight back to the mkdir. A reclaim
    // likewise loops without backing off — it made progress. Both still honour
    // the deadline, so no filesystem pathology can spin here forever.
    let progressed = result === "retry";

    if (result === "held") {
      const view = await inspect(lockDir);
      if (!view) {
        // Released while we looked; the next mkdir simply wins.
        progressed = true;
      } else if (isAbandoned(view, staleMs)) {
        // This judgment is only a FILTER — it keeps us from disturbing locks
        // that are plainly alive. The judgment that decides is the one
        // `detachAndJudge` makes on the instance once it is private.
        const outcome = await detachAndJudge(
          lockDir,
          privatePath(lockDir, owner.token, attempt),
          (detached) => isAbandoned(detached, staleMs),
        );
        progressed = outcome !== "restored";
      }
    }

    if (Date.now() >= deadline) {
      throw new ProjectLockTimeoutError(projectId, acquireTimeoutMs, lockDir);
    }
    if (progressed) continue;

    const jitter = Math.random() * backoffMs;
    await sleep(Math.min(backoffMs + jitter, Math.max(0, deadline - Date.now()) + 1));
    backoffMs = Math.min(backoffMs * 2, POLL_MAX_MS);
  }
}

type AcquireAttempt = "acquired" | "held" | "retry";

/** Where a detached instance is parked: unique per attempt, beside the lock. */
function privatePath(lockDir: string, token: string, attempt: number): string {
  return `${lockDir}.detached-${token}-${attempt}`;
}

/** One `mkdir` attempt, its owner write, and the settle re-read. */
async function tryAcquireOnce(
  lockDir: string,
  owner: OwnerRecord,
  attempt: number,
): Promise<AcquireAttempt> {
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "held";
    if (code === "ENOENT") {
      // The project root does not exist yet — this is the first write into
      // this store. Create it and retry the mkdir.
      await ensureDir(path.dirname(lockDir));
      return "retry";
    }
    throw error;
  }

  try {
    await fs.writeFile(path.join(lockDir, OWNER_FILE_NAME), JSON.stringify(owner));
  } catch (error) {
    if (isEnoent(error)) {
      // Our own directory is gone: a detacher carried it off in the instant
      // before we could stamp it. Nothing of ours is left to clean up.
      return "held";
    }
    // A real write failure (ENOSPC, EIO). Leaving the directory behind would
    // turn one transient metadata error into a lock nobody can take until the
    // stale window elapses, so take back the instance we just made — and only
    // that one, which is what the ownerless judgment checks (Codex P2 ④).
    await detachAndJudge(
      lockDir,
      privatePath(lockDir, owner.token, attempt),
      (detached) => !detached.owner,
    );
    throw error;
  }

  await sleep(LOCK_SETTLE_MS);
  const current = await readOwner(lockDir);
  if (current?.token === owner.token) return "acquired";

  // Our instance was carried off between the mkdir and now, and the path
  // belongs to someone else. Do not touch theirs — go back to waiting.
  return "held";
}

/**
 * Give up the lock — by detaching it and confirming what came away is ours.
 *
 * The naive form (read the owner, then remove the directory) has the same
 * TOCTOU as an in-place reclaim: a successor can take the lock between the two
 * steps and we delete a live one (PR #156 review, Codex P1 ②). A MISSING owner
 * record is not permission to delete either — that is what a successor looks
 * like between its `mkdir` and its own owner write — so the judgment demands a
 * positive match on our token.
 */
async function release(lockDir: string, token: string): Promise<void> {
  await detachAndJudge(
    lockDir,
    `${lockDir}.released-${token}`,
    (detached) => detached.owner?.token === token,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
