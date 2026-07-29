import type { StartupContextPayload } from "../domain/entities.js";
import { getEmbedder, resolveEmbeddingsConfig } from "./embeddings-service.js";
import {
  reinforceInjectedMemories,
  retrieveMemoryContext,
  retrieveSegments,
} from "./memory-retrieval-service.js";
import { semanticMemoryScores } from "./search-service.js";

/** Tight embed timeout at SessionStart — the network must never block boot. */
export const SESSION_START_EMBED_TIMEOUT_MS = 5_000;

export type MemoryContext = Pick<
  StartupContextPayload,
  "rawSegments" | "consolidatedMemories" | "recentObservations"
>;

/**
 * Kernel-scope slice of upstream memorize's `loadStartContext`: the
 * freshness/relevance-ranked memory context assembly (P3-c semantic boost +
 * CLS two-layer retrieval + raw-segment channel), reinforcing whatever gets
 * injected. Everything else upstream's `loadStartContext` also assembles
 * (project/workstream/task/handoff/checkpoint, other-active-tasks, personal
 * and shared memory channels, inbound task requests) reads through
 * project-service/session-service/task-service/workspace-service/
 * personal-store-service — host-CLI product services with no kernel
 * consumer yet, so they stay out of this port (mori#63).
 */
export async function buildMemoryContext(
  projectId: string,
  opts: { taskTitle?: string } = {},
): Promise<MemoryContext> {
  // P3-c — semantic relevance boost: embed the task title and score memories
  // by cosine similarity (graded boost in retrieveMemoryContext). Best-effort
  // with a tight timeout so SessionStart never blocks on the network; degrades
  // to FTS-only when no embeddings endpoint is configured or the embed times
  // out. semanticMemoryScores is itself never-throw, but guard defensively.
  let semanticScores: Map<string, number> | undefined;
  if (opts.taskTitle) {
    try {
      const config = resolveEmbeddingsConfig();
      if (config) {
        const scores = await semanticMemoryScores(
          projectId,
          opts.taskTitle,
          getEmbedder({ ...config, timeoutMs: SESSION_START_EMBED_TIMEOUT_MS }),
        );
        if (scores.size > 0) semanticScores = scores;
      }
    } catch {
      // best-effort — fall back to FTS relevance only.
    }
  }

  // CLS two-layer retrieval: rank consolidated memories + the previous
  // session's observation tail in one pool, then stamp the injected
  // memories as accessed (reinforcement — projection-only, best-effort).
  const retrieved = retrieveMemoryContext(projectId, {
    ...(opts.taskTitle ? { taskTitle: opts.taskTitle } : {}),
    ...(semanticScores ? { semanticScores } : {}),
  });
  reinforceInjectedMemories(projectId, retrieved.memories);

  // Raw-detail channel: verbatim transcript segments for the task, surfaced
  // ALONGSIDE consolidated memories with their own budget. Best-effort; empty
  // without a task title, segments, or embedder. Reuses the session-start
  // embedder + tight timeout so SessionStart never blocks on the network.
  let rawSegments: StartupContextPayload["rawSegments"] = [];
  if (opts.taskTitle) {
    try {
      const config = resolveEmbeddingsConfig();
      const embedder = config
        ? getEmbedder({ ...config, timeoutMs: SESSION_START_EMBED_TIMEOUT_MS })
        : undefined;
      rawSegments = await retrieveSegments(projectId, {
        taskTitle: opts.taskTitle,
        ...(embedder ? { embedder } : {}),
      });
    } catch {
      // best-effort — segments are augmentative.
    }
  }

  return {
    ...(rawSegments && rawSegments.length > 0 ? { rawSegments } : {}),
    ...(retrieved.memories.length > 0
      ? {
          consolidatedMemories: retrieved.memories.map(({ memory }) => ({
            id: memory.id,
            kind: memory.kind,
            text: memory.text,
            salience: memory.salience,
            createdAt: memory.createdAt,
          })),
        }
      : {}),
    ...(retrieved.observations.length > 0
      ? {
          recentObservations: retrieved.observations.map((observation) => ({
            signal: observation.signal,
            ...(observation.toolName ? { toolName: observation.toolName } : {}),
            ...(observation.summary ? { summary: observation.summary } : {}),
            createdAt: observation.createdAt,
          })),
        }
      : {}),
  };
}
