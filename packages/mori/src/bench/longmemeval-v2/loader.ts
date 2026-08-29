import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  abilityForQuestionType,
  type LongMemEvalQuestion,
  type LongMemEvalTrajectory,
  type LongMemEvalTrajectoryState,
} from "./types.js";

function requireString(value: unknown, field: string, id: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`longmemeval-v2: "${field}" 필드가 비어있거나 문자열이 아니다 (id=${id})`);
  }
  return value;
}

function requireDomain(value: unknown, id: string): "web" | "enterprise" {
  if (value !== "web" && value !== "enterprise") {
    throw new Error(`longmemeval-v2: 알 수 없는 domain "${String(value)}" (id=${id})`);
  }
  return value;
}

/** Parses a `.jsonl` file into one object per non-empty line. Fails loudly on a malformed
 * line rather than skipping it — a silently dropped record would understate the question/
 * trajectory count this loader's whole job is to report accurately. */
async function readJsonlObjects(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  const rows: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `longmemeval-v2: ${path}:${i + 1} JSON 파싱 실패 — ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`longmemeval-v2: ${path}:${i + 1} JSON 객체가 아니다`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

/** Reads `questions.jsonl` under `dataDir` and maps each row to `LongMemEvalQuestion`,
 * resolving `ability` from the raw `question_type` via `abilityForQuestionType` (fails loudly
 * on an unrecognized type — see types.ts). */
export async function loadQuestions(dataDir: string): Promise<LongMemEvalQuestion[]> {
  const rows = await readJsonlObjects(join(dataDir, "questions.jsonl"));
  return rows.map((row) => {
    const id = requireString(row.id, "id", String(row.id));
    const questionType = requireString(row.question_type, "question_type", id);
    const image = row.image;
    if (image !== null && typeof image !== "string") {
      throw new Error(`longmemeval-v2: "image" 필드는 null이거나 문자열이어야 한다 (id=${id})`);
    }
    return {
      id,
      domain: requireDomain(row.domain, id),
      environment: requireString(row.environment, "environment", id),
      questionType,
      ability: abilityForQuestionType(questionType),
      question: requireString(row.question, "question", id),
      image,
      answer: requireString(row.answer, "answer", id),
      evalFunction: requireString(row.eval_function, "eval_function", id),
    };
  });
}

function parseState(
  raw: unknown,
  trajectoryId: string,
  expectedIndex: number,
): LongMemEvalTrajectoryState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `longmemeval-v2: trajectory ${trajectoryId}의 state[${expectedIndex}]가 JSON 객체가 아니다`,
    );
  }
  const state = raw as Record<string, unknown>;
  const stateIndex = state.state_index;
  if (typeof stateIndex !== "number" || stateIndex !== expectedIndex) {
    throw new Error(
      `longmemeval-v2: trajectory ${trajectoryId}의 state_index가 순서를 벗어났다 (기대값 ${expectedIndex}, 실값 ${String(stateIndex)}) — 세션 경계가 깨졌을 수 있다`,
    );
  }
  const step = state.step;
  if (step !== null && step !== undefined && typeof step !== "number") {
    throw new Error(
      `longmemeval-v2: trajectory ${trajectoryId} state[${expectedIndex}]의 "step"이 유효하지 않다`,
    );
  }
  const action = state.action;
  if (action !== null && typeof action !== "string") {
    throw new Error(
      `longmemeval-v2: trajectory ${trajectoryId} state[${expectedIndex}]의 "action"이 유효하지 않다`,
    );
  }
  const thought = state.thought;
  if (thought !== null && thought !== undefined && typeof thought !== "string") {
    throw new Error(
      `longmemeval-v2: trajectory ${trajectoryId} state[${expectedIndex}]의 "thought"가 유효하지 않다`,
    );
  }
  return {
    stateIndex,
    step: step ?? null,
    url: requireString(state.url, "url", `${trajectoryId}[${expectedIndex}]`),
    action,
    thought: thought ?? null,
    accessibilityTree: requireString(
      state.accessibility_tree,
      "accessibility_tree",
      `${trajectoryId}[${expectedIndex}]`,
    ),
    screenshot: requireString(state.screenshot, "screenshot", `${trajectoryId}[${expectedIndex}]`),
  };
}

/** Reads `trajectories.jsonl` under `dataDir` and maps each row to `LongMemEvalTrajectory`.
 * Each trajectory is one session boundary — `states` must be present, ordered from
 * `state_index` 0 with no gaps (`parseState` throws otherwise), since a loader that silently
 * accepted out-of-order states would misreport where one session ends and the next begins. */
export async function loadTrajectories(dataDir: string): Promise<LongMemEvalTrajectory[]> {
  const rows = await readJsonlObjects(join(dataDir, "trajectories.jsonl"));
  const seenIds = new Set<string>();
  return rows.map((row) => {
    const id = requireString(row.id, "id", String(row.id));
    if (seenIds.has(id)) {
      throw new Error(`longmemeval-v2: trajectories.jsonl에 중복 id "${id}"가 있다`);
    }
    seenIds.add(id);
    const outcome = row.outcome;
    if (outcome !== "success" && outcome !== "failure") {
      throw new Error(`longmemeval-v2: trajectory ${id}의 outcome이 유효하지 않다`);
    }
    const rawStates = row.states;
    if (!Array.isArray(rawStates) || rawStates.length === 0) {
      throw new Error(`longmemeval-v2: trajectory ${id}에 states가 없거나 비어있다`);
    }
    const states = rawStates.map((state, index) => parseState(state, id, index));
    return {
      id,
      domain: requireDomain(row.domain, id),
      environment: requireString(row.environment, "environment", id),
      goal: requireString(row.goal, "goal", id),
      outcome,
      startUrl: requireString(row.start_url, "start_url", id),
      states,
    };
  });
}
