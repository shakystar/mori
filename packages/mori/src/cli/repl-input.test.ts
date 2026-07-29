import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTerminalInput } from "./repl-input.js";

/** The byte a terminal sends for Ctrl-C. */
const CTRL_C = "\u0003";

/**
 * `createTerminalInput` is driven here through a pair of in-memory streams rather than a
 * real TTY (TESTING.md). readline still runs in terminal mode over them, so the two
 * behaviours worth pinning — EOF, and Ctrl-C arriving as a control byte — go through the
 * same code paths a terminal would take.
 */
function terminalPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  return {
    input,
    output,
    written: () => written.join(""),
    source: createTerminalInput(input, output),
  };
}

/** Lets whatever the streams have queued be delivered before the test looks at the result. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createTerminalInput", () => {
  it("resolves with the line the user typed", async () => {
    const { input, source } = terminalPair();

    const pending = source.readLine("› ");
    input.write("hello\n");

    expect(await pending).toEqual({ type: "line", value: "hello" });
    source.close();
  });

  it("reports EOF when the input stream ends mid-read", async () => {
    // readline's own `question()` promise never settles when its input closes, so this is
    // the case that would hang the REPL forever if the close event were not raced.
    const { input, source } = terminalPair();

    const pending = source.readLine("› ");
    input.end();

    expect(await pending).toEqual({ type: "eof" });
  });

  it("reports EOF immediately once the input has already ended", async () => {
    const { input, source } = terminalPair();

    input.end();
    await source.readLine("› ");

    expect(await source.readLine("› ")).toEqual({ type: "eof" });
  });

  it("turns a Ctrl-C during a read into an interrupt instead of killing mori", async () => {
    const { input, source } = terminalPair();

    const pending = source.readLine("› ");
    input.write(CTRL_C);

    expect(await pending).toEqual({ type: "interrupt" });
    source.close();
  });

  it("routes a Ctrl-C outside a read to the interrupt handler", async () => {
    // The mid-turn path: nothing is reading, so the handler `runRepl` registers is what
    // must see the signal.
    const { input, source } = terminalPair();
    let interrupts = 0;
    const stop = source.onInterrupt(() => interrupts++);

    input.write(CTRL_C);
    await settle();

    expect(interrupts).toBe(1);
    stop();
    source.close();
  });

  it("drops what was typed while no read was pending, echo included", async () => {
    // The mid-turn case: the interface stays open for Ctrl-C, so without the gate readline
    // would echo these keystrokes into the streaming response and then hand them to the
    // next `question()` as a pre-filled buffer — "abc" + "def" would be submitted as
    // "defabc" and billed as a request the user never made (#26 review).
    const { input, written, source } = terminalPair();

    input.write("abc");
    await settle();

    const pending = source.readLine("› ");
    input.write("def\n");

    expect(await pending).toEqual({ type: "line", value: "def" });
    expect(written()).not.toContain("abc");
    source.close();
  });

  it("puts a real terminal into raw mode and restores it on close", async () => {
    // readline sets raw mode on whatever stream it reads from, and it reads from the gate —
    // so mori has to do it for the terminal itself. If this regresses, Ctrl-C goes back to
    // being a tty-driver SIGINT that kills the process mid-turn.
    const input = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode: boolean) => {
      rawModes.push(mode);
      input.isRaw = mode;
      return input as unknown as NodeJS.ReadStream;
    };
    const output = new PassThrough();
    output.resume();

    const source = createTerminalInput(input, output);
    expect(rawModes).toEqual([true]);

    source.close();
    expect(rawModes).toEqual([true, false]);
  });
});
