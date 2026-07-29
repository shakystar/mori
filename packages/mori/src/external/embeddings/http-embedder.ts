import type { Embedder } from "@mori/kernel";

import { EMBEDDINGS_TIMEOUT_MS, type EmbeddingsConfig } from "./config.js";

/**
 * The harness implementation of the kernel's `Embedder` seam: an HTTP client
 * against an OpenAI-compatible `/embeddings` endpoint. Vendor-independent — the
 * same client talks to OpenAI, a local Ollama (`http://localhost:11434/v1`),
 * LM Studio, etc.; only the endpoint/model differ.
 *
 * Moved out of `@mori/kernel` in #82 unchanged: the kernel declares the seam and
 * the harness owns fetch + config, so the kernel tree has zero network access.
 */

/**
 * Conservative initial char budget per embedding request. A batch whose summed
 * tokens exceed the model's context window is rejected wholesale by some servers
 * (Ollama returns HTTP 400 "the input length exceeds the context length"), so a
 * large set of inputs — a full LongMemEval haystack, a big `memory import` — is
 * packed into sub-requests of roughly this size. The exact char↔token ratio is
 * unknown per model/language, so this is only a starting point: `embedPacked`
 * adaptively halves any sub-batch the server still rejects for size.
 */
export const MAX_EMBED_BATCH_CHARS = 6_000;
/** Floor for the single-input truncation retry, so the halving loop terminates. */
export const MIN_EMBED_INPUT_CHARS = 512;

export class HttpEmbedder implements Embedder {
  constructor(private readonly config: EmbeddingsConfig) {}

  get model(): string {
    return this.config.model;
  }

  /**
   * Embed any number of texts → one vector per input, in input order. Inputs are
   * greedily packed into sub-requests of ~MAX_EMBED_BATCH_CHARS; `embedPacked`
   * then adaptively halves any sub-batch the server still rejects for size, so a
   * batch whose summed tokens exceed the model context (e.g. a full LongMemEval
   * haystack, a large `memory import`) always succeeds without us needing to know
   * the exact char↔token ratio.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    let batch: string[] = [];
    let batchChars = 0;
    for (const text of texts) {
      if (batch.length > 0 && batchChars + text.length > MAX_EMBED_BATCH_CHARS) {
        out.push(...(await this.embedPacked(batch)));
        batch = [];
        batchChars = 0;
      }
      batch.push(text);
      batchChars += text.length;
    }
    if (batch.length > 0) out.push(...(await this.embedPacked(batch)));
    return out;
  }

  /**
   * Embed one sub-batch, halving it on a size rejection (HTTP 400/413) until each
   * request fits. A single text still rejected is truncated and retried (lossy,
   * but better than dropping the memory entirely); non-size errors propagate.
   */
  private async embedPacked(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedBatch(texts);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const tooLarge = status === 400 || status === 413;
      if (tooLarge && texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const left = await this.embedPacked(texts.slice(0, mid));
        const right = await this.embedPacked(texts.slice(mid));
        return [...left, ...right];
      }
      if (tooLarge && texts.length === 1 && texts[0]!.length > MIN_EMBED_INPUT_CHARS) {
        const half = Math.max(MIN_EMBED_INPUT_CHARS, Math.floor(texts[0]!.length / 2));
        return this.embedPacked([texts[0]!.slice(0, half)]);
      }
      throw error;
    }
  }

  /** One HTTP request for a single sub-batch. Throws with `.status` on non-2xx. */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const response = await fetchImpl(`${this.config.endpoint.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? EMBEDDINGS_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(`Embeddings HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    // OpenAI returns `data` ordered by index; sort defensively before mapping.
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((entry) => entry.embedding ?? []);
  }
}
