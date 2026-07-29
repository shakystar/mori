/**
 * Shapes shared by every read-only/edit tool's `execute`: a single text content block
 * plus the structured `details` the tool's own result type carries.
 */

/** Wraps `text` as the single content block an `AgentTool.execute` returns, alongside `details`. */
export function textResult<D>(text: string, details: D): { content: [{ type: "text"; text: string }]; details: D } {
  return { content: [{ type: "text", text }], details };
}

/** `textResult` for the `{ ok: false, reason }` branch every tool result type shares. */
export function errorResult<D extends { reason: string }>(
  details: D,
): { content: [{ type: "text"; text: string }]; details: D } {
  return textResult(`Error: ${details.reason}`, details);
}

/** Notice appended when a tool truncates its output to the first `shown` of `total` `unit`. */
export function truncationNotice(unit: string, shown: number, total: number): string {
  return `\n\n[truncated: showing first ${shown} of ${total} ${unit}]`;
}
