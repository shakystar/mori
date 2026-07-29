import { describe, expect, it } from "vitest";
import { createCliAuthInteraction } from "./cli-interaction.js";

function fakeIo(answers: string[]) {
  const stdout: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];
  return {
    stdout: (chunk: string) => stdout.push(chunk),
    question: async (prompt: string) => {
      questions.push(prompt);
      const next = queue.shift();
      if (next === undefined) throw new Error("fakeIo: no more scripted answers");
      return next;
    },
    output: stdout,
    questions,
  };
}

describe("createCliAuthInteraction — prompt", () => {
  // text/secret/manual_code all resolve through the same io.question() call in
  // cli-interaction.ts's promptFor switch (fallthrough case) — one table covers the
  // shared code path for all three instead of three near-identical it()s.
  it.each([
    { type: "text", message: "이름을 입력하세요", answer: "hello" },
    { type: "secret", message: "비밀번호", answer: "s3cr3t" },
    { type: "manual_code", message: "코드를 입력하세요", answer: "ABCD-1234" },
  ] as const)(
    "$type: asks the question and returns the typed answer",
    async ({ type, message, answer: typed }) => {
      const io = fakeIo([typed]);
      const interaction = createCliAuthInteraction(io);

      const answer = await interaction.prompt({ type, message });

      expect(answer).toBe(typed);
      expect(io.questions).toEqual([`${message}: `]);
    },
  );

  it("text: includes the placeholder in the question line", async () => {
    const io = fakeIo(["value"]);
    const interaction = createCliAuthInteraction(io);

    await interaction.prompt({ type: "text", message: "값", placeholder: "예시" });

    expect(io.questions).toEqual(["값 (예시): "]);
  });

  it("select: lists options and returns the id for a valid selection", async () => {
    const io = fakeIo(["2"]);
    const interaction = createCliAuthInteraction(io);

    const answer = await interaction.prompt({
      type: "select",
      message: "프로바이더를 선택하세요",
      options: [
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
      ],
    });

    expect(answer).toBe("openai");
    expect(io.output.join("")).toContain("1) Anthropic");
    expect(io.output.join("")).toContain("2) OpenAI");
  });

  it("select: reprompts on an out-of-range number instead of defaulting to the first option", async () => {
    const io = fakeIo(["99", "1"]);
    const interaction = createCliAuthInteraction(io);

    const answer = await interaction.prompt({
      type: "select",
      message: "프로바이더를 선택하세요",
      options: [
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
      ],
    });

    expect(answer).toBe("anthropic");
    expect(io.questions).toHaveLength(2);
  });

  it("select: reprompts on empty input instead of defaulting to the first option", async () => {
    const io = fakeIo(["", "2"]);
    const interaction = createCliAuthInteraction(io);

    const answer = await interaction.prompt({
      type: "select",
      message: "프로바이더를 선택하세요",
      options: [
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
      ],
    });

    expect(answer).toBe("openai");
    expect(io.questions).toHaveLength(2);
  });
});

describe("createCliAuthInteraction — notify", () => {
  it("device_code: prints both the user code and the verification URI", async () => {
    const io = fakeIo([]);
    const interaction = createCliAuthInteraction(io);

    interaction.notify({
      type: "device_code",
      userCode: "WXYZ-9876",
      verificationUri: "https://example.com/device",
    });

    const printed = io.output.join("");
    expect(printed).toContain("WXYZ-9876");
    expect(printed).toContain("https://example.com/device");
  });

  it("auth_url: prints the URL and calls openBrowser when provided", async () => {
    const io = fakeIo([]);
    const opened: string[] = [];
    const interaction = createCliAuthInteraction({ ...io, openBrowser: (url) => opened.push(url) });

    interaction.notify({ type: "auth_url", url: "https://example.com/authorize" });

    expect(io.output.join("")).toContain("https://example.com/authorize");
    expect(opened).toEqual(["https://example.com/authorize"]);
  });

  it("auth_url: prints the URL and continues normally when openBrowser is absent", async () => {
    const io = fakeIo([]);
    const interaction = createCliAuthInteraction(io);

    expect(() =>
      interaction.notify({ type: "auth_url", url: "https://example.com/authorize" }),
    ).not.toThrow();
    expect(io.output.join("")).toContain("https://example.com/authorize");
  });

  it("info: prints the message and any links", async () => {
    const io = fakeIo([]);
    const interaction = createCliAuthInteraction(io);

    interaction.notify({
      type: "info",
      message: "로그인 안내",
      links: [{ url: "https://example.com/docs", label: "문서" }],
    });

    const printed = io.output.join("");
    expect(printed).toContain("로그인 안내");
    expect(printed).toContain("문서: https://example.com/docs");
  });

  it("progress: prints the message", async () => {
    const io = fakeIo([]);
    const interaction = createCliAuthInteraction(io);

    interaction.notify({ type: "progress", message: "토큰 교환 중..." });

    expect(io.output.join("")).toContain("토큰 교환 중...");
  });
});
