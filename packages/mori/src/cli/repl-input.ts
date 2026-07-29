import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";

/** The byte a terminal in raw mode sends for Ctrl-C. */
const CTRL_C = 0x03;

/** A stdin that may or may not be a terminal — `process.stdin` is, a test double is not. */
type MaybeTty = NodeJS.ReadableStream &
  Partial<Pick<NodeJS.ReadStream, "isTTY" | "isRaw" | "setRawMode">>;

/**
 * One read from the REPL's line source. The three cases are the three ways a terminal can
 * answer "give me the next line": the user typed one, the stream ended (Ctrl-D), or the
 * read was interrupted (Ctrl-C while nothing was running).
 */
export type ReplLine = { type: "line"; value: string } | { type: "eof" } | { type: "interrupt" };

/**
 * The REPL's only contact with stdin. Keeping it an interface — rather than reaching for
 * `process.stdin` inside the loop — is what lets `runRepl` be tested with a scripted list
 * of lines instead of a real TTY (see TESTING.md: no test may require one).
 */
export interface ReplInputSource {
  /**
   * Writes `prompt` and resolves with the next line. Only ever called while no turn is in
   * flight, so the prompt cannot interleave with streamed output.
   */
  readLine(prompt: string): Promise<ReplLine>;
  /**
   * Ctrl-C arriving while no `readLine` is pending — during a turn, or during the startup
   * window between opening the source and the loop's first read (index.ts). An interrupt
   * that arrives while a `readLine` *is* pending resolves it as `{ type: "interrupt" }`
   * instead, so exactly one of the two paths sees any given Ctrl-C.
   */
  onInterrupt(handler: () => void): () => void;
  close(): void;
}

/**
 * The real terminal line source: a readline interface held open for the whole REPL, so raw
 * mode (and with it Ctrl-C delivery) stays active during turns as well as between them.
 *
 * Three readline sharp edges are handled here rather than in the loop:
 * - `question()` never settles when the input stream closes, so EOF is picked up from the
 *   interface's own `close` event and raced against it.
 * - Ctrl-C reaches us as readline's `SIGINT` event, which pre-empts the process default of
 *   killing mori outright. That is the whole reason the interface is created up front.
 * - An interface that stays open also keeps *reading*: keystrokes typed mid-turn would be
 *   echoed into the streaming output and then handed to the next `question()` as a
 *   pre-filled edit buffer. So readline is not wired to `input` directly — it reads from a
 *   gate that only passes keystrokes through while a read is pending (see `onData`).
 */
export function createTerminalInput(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReplInputSource {
  const gate = new PassThrough();
  const rl = createInterface({ input: gate, output, terminal: true });

  const interruptHandlers = new Set<() => void>();
  let pendingRead: AbortController | undefined;
  let closed = false;
  let reading = false;
  const closeListeners = new Set<() => void>();

  const onData = (chunk: Buffer): void => {
    if (reading) {
      gate.write(chunk);
      return;
    }

    // Nothing is waiting for a line, which means a turn is running: what the user typed has
    // no destination and is dropped here (#26 — "출력과 입력이 섞이지 않게"). Dropping it
    // before readline sees it is what keeps it from being echoed between response chunks
    // and from being carried into the next prompt.
    //
    // Ctrl-C is the exception: it still has a destination, because readline is what turns
    // it into the SIGINT event `onInterrupt` is built on.
    let interrupts = 0;
    for (const byte of chunk) if (byte === CTRL_C) interrupts++;
    if (interrupts > 0) gate.write(Buffer.alloc(interrupts, CTRL_C));
  };

  const onEnd = (): void => {
    gate.end();
  };

  input.on("data", onData);
  input.on("end", onEnd);

  // readline would put the terminal into raw mode itself, but it is holding the gate, not
  // the terminal — so this is now our job. Without raw mode the tty driver keeps line
  // discipline and Ctrl-C kills mori instead of arriving as a keystroke.
  const tty = input as MaybeTty;
  const rawModeSupported = tty.isTTY === true && typeof tty.setRawMode === "function";
  const wasRaw = tty.isRaw === true;
  if (rawModeSupported) tty.setRawMode?.(true);

  rl.on("close", () => {
    closed = true;
    for (const listener of closeListeners) listener();
  });

  rl.on("SIGINT", () => {
    if (pendingRead) {
      pendingRead.abort();
      return;
    }
    for (const handler of interruptHandlers) handler();
  });

  return {
    async readLine(prompt: string): Promise<ReplLine> {
      if (closed) return { type: "eof" };

      const controller = new AbortController();
      pendingRead = controller;
      reading = true;

      let onClose = (): void => {};
      const eof = new Promise<ReplLine>((resolve) => {
        onClose = () => resolve({ type: "eof" });
        closeListeners.add(onClose);
      });

      const asked = rl.question(prompt, { signal: controller.signal }).then(
        (line): ReplLine => ({ type: "line", value: line }),
        (error: unknown): ReplLine => {
          if (controller.signal.aborted) return { type: "interrupt" };
          throw error;
        },
      );

      // When EOF wins the race nothing else observes `asked`; keep a late failure from it
      // from surfacing as an unhandled rejection.
      void asked.catch(() => {});

      try {
        return await Promise.race([asked, eof]);
      } finally {
        closeListeners.delete(onClose);
        pendingRead = undefined;
        reading = false;
      }
    },

    onInterrupt(handler: () => void): () => void {
      interruptHandlers.add(handler);
      return () => interruptHandlers.delete(handler);
    },

    close(): void {
      rl.close();
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      // Leave the terminal as it was found: raw mode is mori's for the duration of the
      // REPL, not the shell's afterwards.
      if (rawModeSupported) tty.setRawMode?.(wasRaw);
      input.pause();
    },
  };
}
