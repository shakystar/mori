import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

/** Injected I/O — no `process.stdout`/`readline` touched directly, so this stays testable with a fake. */
export interface CliAuthInteractionIo {
  stdout(chunk: string): void;
  question(prompt: string): Promise<string>;
  openBrowser?(url: string): void;
}

/**
 * CLI adapter for pi-ai's `AuthInteraction` (login/OAuth prompts + notifications). This is
 * the only piece mori owns in the auth flow — pi-ai's `OAuthAuth`/`ApiKeyAuth` implementations
 * drive PKCE, device-code polling, and token storage; this module just renders their prompts
 * and events to a terminal-shaped `io`.
 */
export function createCliAuthInteraction(io: CliAuthInteractionIo): AuthInteraction {
  return {
    prompt: (prompt: AuthPrompt) => promptFor(io, prompt),
    notify: (event: AuthEvent) => notifyFor(io, event),
  };
}

async function promptFor(io: CliAuthInteractionIo, prompt: AuthPrompt): Promise<string> {
  switch (prompt.type) {
    case "text":
    case "secret":
    case "manual_code":
      return io.question(questionLine(prompt.message, prompt.placeholder));
    case "select":
      return promptSelect(io, prompt);
    default:
      return assertNever(prompt);
  }
}

function questionLine(message: string, placeholder?: string): string {
  return placeholder ? `${message} (${placeholder}): ` : `${message}: `;
}

async function promptSelect(
  io: CliAuthInteractionIo,
  prompt: Extract<AuthPrompt, { type: "select" }>,
): Promise<string> {
  io.stdout(`${prompt.message}\n`);
  prompt.options.forEach((option, index) => {
    const description = option.description ? ` — ${option.description}` : "";
    io.stdout(`  ${index + 1}) ${option.label}${description}\n`);
  });

  // Reprompt on out-of-range/empty input rather than silently defaulting to option 1 —
  // a mis-typed number must not send the user down the wrong login path.
  for (;;) {
    const answer = (await io.question(`번호를 선택하세요 (1-${prompt.options.length}): `)).trim();
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) {
      return prompt.options[index - 1].id;
    }
    io.stdout(`유효하지 않은 선택입니다: "${answer}"\n`);
  }
}

function notifyFor(io: CliAuthInteractionIo, event: AuthEvent): void {
  switch (event.type) {
    case "info":
      io.stdout(`${event.message}\n`);
      for (const link of event.links ?? []) {
        io.stdout(`  ${link.label ? `${link.label}: ` : ""}${link.url}\n`);
      }
      return;
    case "auth_url":
      if (event.instructions) io.stdout(`${event.instructions}\n`);
      io.stdout(`${event.url}\n`);
      io.openBrowser?.(event.url);
      return;
    case "device_code":
      // The headless flow's only cue: user must see both the code and where to enter it.
      io.stdout(`코드: ${event.userCode}\n`);
      io.stdout(`다음 주소에서 입력하세요: ${event.verificationUri}\n`);
      return;
    case "progress":
      io.stdout(`${event.message}\n`);
      return;
    default:
      assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`createCliAuthInteraction: unhandled case ${JSON.stringify(value)}`);
}
