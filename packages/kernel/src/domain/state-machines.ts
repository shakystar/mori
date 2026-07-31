import { MemorizeError } from "../shared/errors.js";
import type {
  ConflictStatus,
  Session,
  SyncStatus,
  TaskStatus,
  WorkstreamStatus,
} from "./entities.js";

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "blocked", "cancelled"],
  in_progress: ["handoff_ready", "done", "blocked", "cancelled"],
  handoff_ready: ["in_progress", "done", "cancelled"],
  blocked: ["in_progress", "handoff_ready", "cancelled"],
  done: [],
  cancelled: [],
};

const workstreamTransitions: Record<WorkstreamStatus, WorkstreamStatus[]> = {
  active: ["paused", "closed"],
  paused: ["active", "closed"],
  closed: [],
};

const sessionTransitions: Record<Session["status"], Session["status"][]> = {
  active: ["paused", "completed", "abandoned"],
  // `paused` ↔ `active` is the SessionEnd → resume cycle: SessionEnd
  // pauses (pointer kept), claude --resume / codex resume reactivates.
  // `paused → abandoned` is the reap path when no resume happens
  // before the staleness threshold.
  paused: ["active", "completed", "abandoned"],
  completed: [],
  abandoned: [],
};

const conflictTransitions: Record<ConflictStatus, ConflictStatus[]> = {
  detected: ["auto_resolved", "escalated", "resolved"],
  auto_resolved: [],
  escalated: ["resolved"],
  resolved: [],
};

const syncTransitions: Record<SyncStatus, SyncStatus[]> = {
  idle: ["syncing"],
  syncing: ["idle", "conflicted", "offline"],
  conflicted: ["syncing"],
  offline: ["syncing"],
};

function assertTransition<T extends string>(
  label: string,
  from: T,
  to: T,
  transitions: Record<T, T[]>,
): void {
  if (!transitions[from].includes(to)) {
    throw new MemorizeError(`Invalid ${label} transition: ${from} -> ${to}`);
  }
}

export function assertTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition("task status", from, to, taskTransitions);
}

export function assertWorkstreamStatusTransition(
  from: WorkstreamStatus,
  to: WorkstreamStatus,
): void {
  assertTransition("workstream status", from, to, workstreamTransitions);
}

export function assertSessionStatusTransition(
  from: Session["status"],
  to: Session["status"],
): void {
  assertTransition("session status", from, to, sessionTransitions);
}

export function assertConflictStatusTransition(from: ConflictStatus, to: ConflictStatus): void {
  assertTransition("conflict status", from, to, conflictTransitions);
}

/**
 * Conflict statuses with no outgoing transition — `resolved` and
 * `auto_resolved` are both terminal (`escalated` still has `-> resolved`, so
 * it stays open). The state machine is the single source of truth for
 * "closed"; readers (e.g. `listOpenConflicts`'s SQL predicate) derive from
 * this instead of hardcoding a status list that could drift from
 * `conflictTransitions`.
 */
export const TERMINAL_CONFLICT_STATUSES: ConflictStatus[] = (
  Object.keys(conflictTransitions) as ConflictStatus[]
).filter((status) => conflictTransitions[status].length === 0);

export function assertSyncStatusTransition(from: SyncStatus, to: SyncStatus): void {
  assertTransition("sync status", from, to, syncTransitions);
}
