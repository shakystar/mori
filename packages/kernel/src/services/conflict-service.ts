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
