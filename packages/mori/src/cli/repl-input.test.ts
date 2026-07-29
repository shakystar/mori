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
  output.resume();
  return { input, output, source: createTerminalInput(input, output) };
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
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupts).toBe(1);
    stop();
    source.close();
  });
});
