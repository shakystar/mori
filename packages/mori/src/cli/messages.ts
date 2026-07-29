import { apiKeyEnvVarFor } from "../auth/resolve-credentials.js";

export const usageMessage = "usage: mori <prompt>\n";

export function unauthenticatedMessage(providerId: string): string {
  const apiKeyEnv = apiKeyEnvVarFor(providerId) ?? "API_KEY";
  return (
    "mori: 인증이 필요합니다.\n" +
    "  mori login          # 권장 — 브라우저로 로그인\n" +
    "또는 API key를 쓰려면:\n" +
    `  export ${apiKeyEnv}=...\n`
  );
}

export function loginNotImplementedMessage(providerId: string): string {
  const apiKeyEnv = apiKeyEnvVarFor(providerId) ?? "API_KEY";
  return (
    "mori: `mori login`은 아직 사용할 수 없습니다.\n" +
    "지금은 API key를 쓰세요:\n" +
    `  export ${apiKeyEnv}=...\n`
  );
}
