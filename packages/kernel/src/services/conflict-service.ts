import { nowIso } from "../domain/common.js";
import type { Conflict, ConflictStatus } from "../domain/entities.js";
import { assertConflictStatusTransition } from "../domain/state-machines.js";
import { MemorizeError } from "../shared/errors.js";
import { appendEvent } from "../storage/event-store.js";
import { getConflict, rebuildProjectProjection } from "./projection-store.js";

/**
 * Thin service layer over the conflict domain (entity + state machine,
 * ported in #10) and its projection (`getConflict`/`listOpenConflicts`,
 * ported in #10). `detectContradictions` (contradiction-service.ts) is the
 * only writer of `conflict.detected`; this module owns the read + the
 * resolution write (`conflict.resolved`).
 */

/** Read a single conflict by id. Pure passthrough of the projection reader. */
export function readConflict(projectId: string, conflictId: string): Conflict | undefined {
  return getConflict(projectId, conflictId);
}

export interface ResolveConflictParams {
  projectId: string;
  conflictId: string;
  /** Target status — guarded by assertConflictStatusTransition. */
  status: Exclude<ConflictStatus, "detected">;
  actor: string;
  resolutionSummary?: string;
  resolvedBy?: string;
}

/**
 * Transition a conflict's status, guarded by the domain state machine
 * (`detected` -> `auto_resolved` | `escalated` | `resolved`, `escalated` ->
 * `resolved`). Throws `MemorizeError` for an unknown conflict id or an
 * invalid transition (assertConflictStatusTransition throws the same error
 * type). Appends `conflict.resolved` and rebuilds the projection — mirrors
 * `decision.superseded`'s invalidate-not-delete pattern (the original
 * `conflict.detected` event and row are never touched).
 */
export async function resolveConflict(params: ResolveConflictParams): Promise<Conflict> {
  // The projection read + assertConflictStatusTransition check below and the
  // appendEvent write further down are NOT one atomic unit — two concurrent
  // callers resolving the same `detected` conflict could both read the
  // unchanged projection, both pass the transition check, and then append
  // conflicting outcomes (e.g. `resolved` and `escalated`) that replay
  // (projector.ts) would apply as a last-write-wins overwrite, landing on a
  // status the state machine forbids. It is unguarded only because this
  // function has no production caller yet — it is reachable from tests alone.
  // The premise it used to cite (consolidate-service's "there is no second
  // process to serialize against") is gone: #132 established that two mori
  // processes DO open the same store, and gave the kernel a project-scoped
  // lock (`storage/project-lock.ts`) for exactly these spans. Whoever wires the
  // first real caller must take that lock here — or wrap the span in a
  // transaction (#118 item 5 — deliberately no CAS added here).
  //
  // TRIGGER (#301 §Q4): the PR that wires the first production caller of this
  // function closes this span in the SAME PR — a caller landing without it is
  // the whole defect, not a follow-up. Which shape depends on where that caller
  // sits, and #301 §Q3 priced all four:
  //   - Inside the kernel seam (like `observe`/`consolidate`, which take
  //     `withProjectLock` at packages/kernel/src/kernel/sqlite-memory-kernel.ts:724 and packages/kernel/src/kernel/sqlite-memory-kernel.ts:794, then pass a signal
  //     down): the lock belongs to the kernel, not here. Take a `signal` param
  //     and check it, as packages/kernel/src/services/capture-service.ts:291 does.
  //   - Outside that seam (like `importMemories`): the shape is
  //     memory-import-service.ts's — a per-project mutex (packages/kernel/src/services/memory-import-service.ts:85), a LOG-derived
  //     basis (packages/kernel/src/services/memory-import-service.ts:234-254) replacing the `getConflict` read below, and
  //     `appendEvents(projectId, inputs, { expectedHead })` with a pre-append
  //     retry (packages/kernel/src/services/memory-import-service.ts:263-297).
  // Adding `expectedHead` ALONE does not close it: the basis below is the
  // `conflicts` projection, and a CAS pass says only that the log did not move
  // — not that the projection was fresh (#301 §Q1.8, PR #299 review). Whichever
  // shape is taken, add the interleave test with it: two callers resolving the
  // same `detected` conflict, asserting the loser is refused rather than
  // silently landing a forbidden transition.
  const existing = getConflict(params.projectId, params.conflictId);
  if (!existing) {
    throw new MemorizeError(`Conflict not found: ${params.conflictId}`);
  }
  assertConflictStatusTransition(existing.status, params.status);

  const resolvedAt = nowIso();
  const updated: Conflict = {
    ...existing,
    updatedAt: resolvedAt,
    status: params.status,
    ...(params.resolutionSummary ? { resolutionSummary: params.resolutionSummary } : {}),
    ...(params.resolvedBy ? { resolvedBy: params.resolvedBy } : {}),
    ...(params.status === "resolved" || params.status === "auto_resolved" ? { resolvedAt } : {}),
  };

  // scopeId = the conflict's OWN id, not projectId: the projector's reducer
  // keys `state.conflicts` by `event.scopeId` (projector.ts, ported #10), and
  // `DomainEvent.scopeType` has no dedicated "conflict" member — using
  // projectId here (as a single-conflict fixture might) would collapse every
  // conflict in a project onto the same map key and silently drop all but the
  // last from the rebuilt projection.
  await appendEvent({
    type: "conflict.resolved",
    projectId: params.projectId,
    scopeType: "project",
    scopeId: updated.id,
    actor: params.actor,
    payload: updated,
  });
  await rebuildProjectProjection(params.projectId);
  return updated;
}
