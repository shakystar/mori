import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  abilityForQuestion,
  type LongMemEvalHaystackSession,
  type LongMemEvalQuestion,
  type LongMemEvalTurn,
} from "./types.js";

function requireString(value: unknown, field: string, id: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`longmemeval-v1: "${field}" 필드가 비어있거나 문자열이 아니다 (id=${id})`);
  }
  return value;
}

/** Unlike `requireString`, allows an empty string — the real `longmemeval_s_cleaned.json` has
 * 12/246,750 turns (9 user, 3 assistant) with `content: ""`, a genuine blank message in the
 * source conversation log rather than a missing field (confirmed dataset-wide: `content` is
 * always type `string`, never absent/null — only occasionally empty). */
function requireContentString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`longmemeval-v1: ${where}의 content가 문자열이 아니다`);
  }
  return value;
}

/** `answer` is a string for every question_type except 32/500 `multi-session` counting
 * questions (e.g. "how many trips..."), where the real `longmemeval_s_cleaned.json` stores a
 * bare JSON number (e.g. `3`) instead of `"3"` — confirmed dataset-wide, no other field has
 * this quirk. Coerced to string here so `LongMemEvalQuestion.answer` stays a single type for
 * callers (the judge compares it as text either way). */
function coerceAnswerToString(value: unknown, id: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  throw new Error(`longmemeval-v1: "answer" 필드가 비어있거나 문자열/숫자가 아니다 (id=${id})`);
}

function requireStringArray(value: unknown, field: string, id: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`longmemeval-v1: "${field}" 필드가 문자열 배열이 아니다 (id=${id})`);
  }
  return value as string[];
}

function parseTurn(
  raw: unknown,
  questionId: string,
  sessionIndex: number,
  turnIndex: number,
): LongMemEvalTurn {
  const where = `${questionId}[session ${String(sessionIndex)}][turn ${String(turnIndex)}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`longmemeval-v1: ${where}가 JSON 객체가 아니다`);
  }
  const turn = raw as Record<string, unknown>;
  const role = turn.role;
  if (role !== "user" && role !== "assistant") {
    throw new Error(`longmemeval-v1: ${where}의 role이 유효하지 않다 (값: ${String(role)})`);
  }
  const hasAnswer = turn.has_answer;
  if (hasAnswer !== undefined && typeof hasAnswer !== "boolean") {
    throw new Error(`longmemeval-v1: ${where}의 has_answer는 있으면 boolean이어야 한다`);
  }
  return {
    role,
    content: requireContentString(turn.content, where),
    ...(hasAnswer === undefined ? {} : { hasAnswer }),
  };
}

function parseHaystackSessions(
  row: Record<string, unknown>,
  id: string,
): LongMemEvalHaystackSession[] {
  const sessionIds = requireStringArray(row.haystack_session_ids, "haystack_session_ids", id);
  const dates = requireStringArray(row.haystack_dates, "haystack_dates", id);
  const sessions = row.haystack_sessions;
  if (!Array.isArray(sessions)) {
    throw new Error(`longmemeval-v1: "haystack_sessions" 필드가 배열이 아니다 (id=${id})`);
  }
  if (sessionIds.length !== dates.length || sessionIds.length !== sessions.length) {
    throw new Error(
      `longmemeval-v1: haystack_session_ids(${String(sessionIds.length)})/haystack_dates(${String(dates.length)})/haystack_sessions(${String(sessions.length)}) 길이가 다르다 (id=${id})`,
    );
  }
  return sessions.map((rawTurns, sessionIndex) => {
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
      throw new Error(
        `longmemeval-v1: ${id}의 session[${String(sessionIndex)}]에 turns가 없거나 비어있다`,
      );
    }
    return {
      sessionId: sessionIds[sessionIndex] as string,
      date: dates[sessionIndex] as string,
      turns: rawTurns.map((rawTurn, turnIndex) => parseTurn(rawTurn, id, sessionIndex, turnIndex)),
    };
  });
}

function parseQuestion(raw: unknown): LongMemEvalQuestion {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("longmemeval-v1: 문항 레코드가 JSON 객체가 아니다");
  }
  const row = raw as Record<string, unknown>;
  const id = requireString(row.question_id, "question_id", String(row.question_id));
  const questionType = requireString(row.question_type, "question_type", id);
  const haystackSessions = parseHaystackSessions(row, id);
  const answerSessionIds = requireStringArray(row.answer_session_ids, "answer_session_ids", id);
  const haystackSessionIds = new Set(haystackSessions.map((s) => s.sessionId));
  for (const answerSessionId of answerSessionIds) {
    if (!haystackSessionIds.has(answerSessionId)) {
      throw new Error(
        `longmemeval-v1: answer_session_ids의 "${answerSessionId}"가 haystack_session_ids에 없다 (id=${id})`,
      );
    }
  }
  return {
    id,
    questionType,
    ability: abilityForQuestion(questionType, id),
    isAbstention: id.endsWith("_abs"),
    question: requireString(row.question, "question", id),
    questionDate: requireString(row.question_date, "question_date", id),
    answer: coerceAnswerToString(row.answer, id),
    answerSessionIds,
    haystackSessions,
  };
}

/** Reads `longmemeval_s_cleaned.json` under `dataDir` and maps each entry to
 * `LongMemEvalQuestion`. Unlike `longmemeval-v2/loader.ts`'s `.jsonl` files, the v1 release
 * ships one big JSON array (≈277MB for `longmemeval_s_cleaned.json`) rather than
 * newline-delimited records — a plain `readFile` + `JSON.parse` handles that size well within
 * Node's default heap (measured on the real file: ~2s read + ~0.8s parse, ~850MB peak RSS; see
 * `docs/bench/longmemeval-v1-feasibility-2026-08-30.md` §3), so this loader does not need the v2
 * loader's line-by-line streaming. Fails loudly on a malformed entry rather than skipping it. */
export async function loadQuestions(
  dataDir: string,
  fileName = "longmemeval_s_cleaned.json",
): Promise<LongMemEvalQuestion[]> {
  const raw = await readFile(join(dataDir, fileName), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `longmemeval-v1: ${fileName} JSON 파싱 실패 — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`longmemeval-v1: ${fileName}이 JSON 배열이 아니다`);
  }
  const seenIds = new Set<string>();
  return parsed.map((row) => {
    const question = parseQuestion(row);
    if (seenIds.has(question.id)) {
      throw new Error(`longmemeval-v1: ${fileName}에 중복 question_id "${question.id}"가 있다`);
    }
    seenIds.add(question.id);
    return question;
  });
}
