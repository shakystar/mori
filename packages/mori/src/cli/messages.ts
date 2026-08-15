import { apiKeyEnvVarFor } from "../auth/resolve-credentials.js";

export const usageMessage =
  "usage: mori <prompt>\n" +
  "       mori                      # 터미널에서 실행하면 REPL로 진입합니다\n" +
  "       mori login [provider]     # 자격증명을 저장합니다\n" +
  "       mori logout [provider]    # 저장된 자격증명을 지웁니다\n";

export function replBanner(): string {
  return "mori REPL — /exit 또는 Ctrl-D로 종료, /clear로 대화 초기화, /consolidate로 증류 실행\n";
}

export function replClearedMessage(): string {
  return "mori: 대화를 초기화했습니다.\n";
}

export function replTurnCancelledMessage(): string {
  return "mori: 턴을 취소했습니다.\n";
}

export function replConsolidateSkippedMessage(): string {
  return "mori: MORI_CONSOLIDATE_MODEL이 설정되지 않아 증류할 것이 없습니다.\n";
}

export function replConsolidateOkMessage(): string {
  return "mori: 증류를 완료했습니다.\n";
}

export function replConsolidateCancelledMessage(): string {
  return "mori: 증류를 취소했습니다.\n";
}

export function replConsolidateFailedMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `mori: 증류에 실패했습니다 — ${reason}\n`;
}

/**
 * `mori bench:nightly-slice` / `mori bench:milestone`이 `memory-on` 팔을 돌리기 전에 부르는
 * 시작 전제 실패 메시지(#452, #446 후속 제안 2). 두 CLI 모두 세 팔(memory-off/memory-on/oracle)을
 * 항상 함께 돌리므로 예외 없이 요구한다 — `MORI_CONSOLIDATE_MODEL`이 없으면 증류 boundary가
 * 조용히 no-op이 되어(`../external/consolidator/config.js`) memory-on 팔이 «증류 없음»으로
 * 끝까지 돌고 리포트가 그 사실을 「측정 안 함」이 아니라 「0」으로 내보낸다.
 */
export function consolidateModelRequiredMessage(): string {
  return (
    "mori bench: MORI_CONSOLIDATE_MODEL이 설정되지 않았다 — memory-on 팔은 증류가 있어야 " +
    "측정된다(설정 안 하면 증류가 조용히 no-op돼 '측정 안 함'이 '0'으로 새어 나간다).\n" +
    "  export MORI_CONSOLIDATE_MODEL=deepseek/deepseek-v4-flash     # 또는 provider 기본값(anthropic)에 맡기려면 모델 id만: sonnet-4-5\n"
  );
}

export function unauthenticatedMessage(providerId: string): string {
  const apiKeyEnv = apiKeyEnvVarFor(providerId);
  if (!apiKeyEnv) {
    // A provider with no API-key auth at all (pi-ai's OAuth-only `openai-codex`): naming an
    // API key env var here would point the user at a path this provider cannot serve.
    return "mori: 인증이 필요합니다.\n" + `  mori login ${providerId}\n`;
  }

  return (
    "mori: 인증이 필요합니다.\n" +
    `  mori login ${providerId}     # API key를 입력해 저장합니다\n` +
    "또는 환경변수로 직접 넘기려면:\n" +
    `  export ${apiKeyEnv}=...\n`
  );
}

export function loginSuccessMessage(providerId: string): string {
  return `mori: ${providerId} 로그인 완료.\n`;
}

export function loginFailedMessage(providerId: string, reason: string): string {
  return `mori: ${providerId} 로그인에 실패했습니다 — ${reason}\n`;
}

export function logoutSuccessMessage(providerId: string): string {
  return `mori: ${providerId} 로그아웃 완료 — 저장된 자격증명을 삭제했습니다.\n`;
}

export function logoutFailedMessage(providerId: string, reason: string): string {
  return `mori: ${providerId} 로그아웃에 실패했습니다 — ${reason}\n`;
}

/**
 * Printed once, to stderr, after a successful login through the experimental OpenAI
 * subscription-OAuth route. The human decision behind #44 allowed this route only as an
 * unofficial development path, on the condition that whoever reaches it is told what it is
 * and what it can cost them — an account restriction, not a broken feature.
 */
export function experimentalOpenAiOAuthNotice(): string {
  return (
    "⚠️  mori: 이 로그인은 비공식·실험적 경로입니다.\n" +
    "    OpenAI는 서드파티 클라이언트가 ChatGPT 구독 계정으로 로그인하는 것을 공식 auth\n" +
    "    문서에서 허용한다고 밝힌 적이 없습니다. 이 경로를 사용하다 계정이 제한되거나\n" +
    "    정지될 수 있으며, 그 위험은 사용자 본인이 감수하는 것입니다.\n" +
    "    지원되는 경로가 필요하면 OPENAI_API_KEY로 `openai` 프로바이더를 쓰세요.\n"
  );
}
