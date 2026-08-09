import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createHarnessConversationSource } from "./harness-conversation-source.js";

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantMessage(content: AssistantContent): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function agentSays(text: string): AgentMessage {
  return assistantMessage([{ type: "text", text }]);
}

function agentCallsTool(name: string): AgentMessage {
  return assistantMessage([{ type: "toolCall", id: "call-1", name, arguments: {} }]);
}

function toolResult(name: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function newSession(): Session {
  return new Session(new InMemorySessionStorage());
}

/** A real `SessionStorage` whose entry log cannot be read — the "unreadable conversation" case. */
class UnreadableSessionStorage extends InMemorySessionStorage {
  override getEntries(): Promise<SessionTreeEntry[]> {
    return Promise.reject(new Error("storage is gone"));
  }
}

async function append(session: Session, ...messages: AgentMessage[]): Promise<void> {
  for (const message of messages) await session.appendMessage(message);
}

describe("createHarnessConversationSource", () => {
  it("returns only the entries after the requested offset, with newOffset at the log's end", async () => {
    const session = newSession();
    await append(session, userMessage("first"), agentSays("first reply"));
    const source = createHarnessConversationSource(session);
    await append(session, userMessage("second"), agentSays("second reply"));

    const slice = await source.read(2);

    expect(slice?.text).toBe("USER: second\n\nAGENT: second reply");
    expect(slice?.newOffset).toBe(4);
  });

  it("returns undefined when nothing was appended after the offset", async () => {
    const session = newSession();
    await append(session, userMessage("only turn"));
    const source = createHarnessConversationSource(session);

    expect(await source.read(1)).toBeUndefined();
  });

  it("reports empty text for a span that is tool traffic alone", async () => {
    const session = newSession();
    await append(session, agentCallsTool("bash"), toolResult("bash", "exit 0"));
    const source = createHarnessConversationSource(session);

    const slice = await source.read(0);

    // Empty, not undefined: the span holds no conversation but it HAS been read, and the
    // kernel advances the cursor over an empty slice so tool traffic never pins the axis.
    expect(slice?.text).toBe("");
    expect(slice?.newOffset).toBe(2);
  });

  it("cuts resume points at turn boundaries, ascending and strictly inside the text", async () => {
    const session = newSession();
    await append(session, userMessage("one"), agentSays("two"), userMessage("three"));
    const source = createHarnessConversationSource(session);

    const slice = await source.read(0);

    expect(slice?.resumePoints).toEqual([
      { chars: 9, offset: 1 },
      { chars: 21, offset: 2 },
    ]);
    expect(slice?.text.slice(0, 9)).toBe("USER: one");
    expect(slice?.text.slice(0, 21)).toBe("USER: one\n\nAGENT: two");
    for (const point of slice?.resumePoints ?? []) {
      expect(point.chars).toBeGreaterThan(0);
      expect(point.chars).toBeLessThan(slice?.text.length ?? 0);
      expect(point.offset).toBeLessThan(slice?.newOffset ?? 0);
    }
  });

  it("lets a resume point consume the tool traffic that follows its turn", async () => {
    const session = newSession();
    await append(
      session,
      userMessage("one"),
      agentCallsTool("bash"),
      toolResult("bash", "exit 0"),
      agentSays("done"),
    );
    const source = createHarnessConversationSource(session);

    const slice = await source.read(0);

    // One point for the one prefix that exists, carrying the FURTHEST offset showing it —
    // the two tool entries add no text, so holding them back would only slow the drain.
    expect(slice?.resumePoints).toEqual([{ chars: 9, offset: 3 }]);
  });

  it("still reads the span before a compaction cut", async () => {
    const session = newSession();
    await append(session, userMessage("before the cut"), agentSays("reply before the cut"));
    const firstKeptEntryId = await session.appendMessage(userMessage("after the cut"));
    await session.appendCompaction("a summary of everything before the cut", firstKeptEntryId, 42);
    const source = createHarnessConversationSource(session);

    const slice = await source.read(0);

    // The regression this wiring exists to avoid: `getBranch()` stops at the compaction entry,
    // so the pre-cut span — the very text compaction dropped from the context — would be gone.
    expect(slice?.text).toBe(
      "USER: before the cut\n\nAGENT: reply before the cut\n\nUSER: after the cut",
    );
  });

  it("does not carry a compaction summary as conversation text", async () => {
    const session = newSession();
    await session.appendCompaction("a summary the extractor already compressed", undefined, 42);
    const source = createHarnessConversationSource(session);

    const slice = await source.read(0);

    // Re-distilling an extractor's own output is double distillation; the verbatim span the
    // summary replaced is in this same log anyway.
    expect(slice?.text).toBe("");
  });

  it("reads from the start of the log when the offset is not a usable cursor", async () => {
    const session = newSession();
    await append(session, userMessage("one"), agentSays("two"));
    const source = createHarnessConversationSource(session);

    const slice = await source.read(Number.NaN);

    // Not `slice(NaN)`'s whole log paired with a `NaN` cursor: re-reading is recoverable,
    // an unorderable cursor pins the axis for good.
    expect(slice?.text).toBe("USER: one\n\nAGENT: two");
    expect(slice?.newOffset).toBe(2);
  });

  it("returns undefined instead of throwing when the entry log cannot be read", async () => {
    const source = createHarnessConversationSource(new Session(new UnreadableSessionStorage()));

    await expect(source.read(0)).resolves.toBeUndefined();
  });

  it("gives one id per session, and different ids to different sessions", async () => {
    const session = newSession();

    expect(createHarnessConversationSource(session).id).toBe(
      createHarnessConversationSource(session).id,
    );
    expect(createHarnessConversationSource(newSession()).id).not.toBe(
      createHarnessConversationSource(session).id,
    );
  });
});
