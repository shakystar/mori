/**
 * The repo's ONE chars↔tokens approximation, and the only one any service is
 * allowed to derive a budget from.
 *
 * It lived in `consolidate-service.ts` until #238 needed the same conversion
 * for the injection budget (`injection-budget.ts`). Two services deriving
 * budgets from the same constant is exactly how the two drift apart — the
 * conversion was tuned three times (#143②, #174, #212) against real provider
 * behaviour, and a copy would have to be re-tuned in lockstep. So it moved
 * here, to a module that owns nothing but the approximation, and
 * `consolidate-service` re-exports it for its existing callers (its tests own
 * the regression coverage, per #238's non-goals).
 *
 * NOT a tokenizer, deliberately: adding one is a separate decision (#238
 * non-goal). A fixed, documented, conservative approximation is the contract.
 */

/**
 * #143 item② — chars-per-token used to translate a declared token budget into
 * a character budget. This is a MULTIPLIER (`chars = tokens *
 * CONSERVATIVE_CHARS_PER_TOKEN`), so lower is safer — it makes a derived char
 * budget UNDER-estimate how much text a given token count buys, which is the
 * conservative direction. `2`, then `1`, were both tried and rejected (PR #168
 * review, two rounds): a Hangul syllable is 3 bytes in UTF-8, and a byte-level
 * BPE tokenizer's worst case is one token PER BYTE — so one Hangul character
 * can cost up to 3 tokens, not 1. `1` chars/token still under-reserves by up
 * to 3x for exactly the CJK-heavy content this project's
 * observations/conversation tails are substantially made of. The floor this
 * worst case implies is `1/3` chars/token (1 char <= 3 tokens, inverted).
 *
 * Applies to USER content only — the fixed English extraction system prompt
 * uses `consolidate-service`'s own `SYSTEM_PROMPT_CHARS_PER_TOKEN` instead
 * (#174: reusing this CJK worst-case constant for it over-reserved so much
 * that small declared context windows derived a budget of 0). Injected memory
 * (#238) is user content in this sense: memories, observation summaries and
 * verbatim segments are all agent/user-written and routinely CJK.
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 1 / 3;

/** Chars → estimated tokens, using the same conservative constant throughout
 *  so a budget derived from it and a later check against it never disagree. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CONSERVATIVE_CHARS_PER_TOKEN);
}
