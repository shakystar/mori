import { createInterface } from "node:readline/promises";

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
   * Ctrl-C arriving while no `readLine` is pending — i.e. during a turn. An interrupt that
   * arrives while a `readLine` *is* pending resolves it as `{ type: "interrupt" }` instead,
   * so exactly one of the two paths sees any given Ctrl-C.
   */
  onInterrupt(handler: () => void): () => void;
  close(): void;
}

/**
 * The real terminal line source: a readline interface held open for the whole REPL, so raw
 * mode (and with it Ctrl-C delivery) stays active during turns as well as between them.
 *
 * Two readline sharp edges are handled here rather than in the loop:
 * - `question()` never settles when the input stream closes, so EOF is picked up from the
 *   interface's own `close` event and raced against it.
 * - Ctrl-C reaches us as readline's `SIGINT` event, which pre-empts the process default of
 *   killing mori outright. That is the whole reason the interface is created up front.
 */
export function createTerminalInput(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReplInputSource {
  const rl = createInterface({ input, output, terminal: true });

  const interruptHandlers = new Set<() => void>();
  let pendingRead: AbortController | undefined;
  let closed = false;
  const closeListeners = new Set<() => void>();

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
      }
    },

    onInterrupt(handler: () => void): () => void {
      interruptHandlers.add(handler);
      return () => interruptHandlers.delete(handler);
    },

    close(): void {
      rl.close();
    },
  };
}
