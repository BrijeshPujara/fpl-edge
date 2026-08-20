import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { getDb, isDbConfigured } from "@/lib/db/client";

/**
 * The provider boundary.
 *
 * One rule governs this whole directory, and it is in the README as an
 * architectural constraint rather than a preference: **the deterministic engine
 * must work with no key present.** The LLM explains numbers the engine has
 * already computed. It never computes one, and it never decides anything.
 *
 * So every function here returns null rather than throwing when there is no
 * key, and callers render the analysis without commentary. A missing key is a
 * configuration state, not an error.
 */

/** Routine weekly writing. Cheap, fast, and entirely adequate for prose. */
export const BRIEF_MODEL = "claude-haiku-4-5";

/** Reserved for wildcard drafts and chip calls — bigger, rarer decisions. */
export const DELIBERATION_MODEL = "claude-sonnet-5";

/** Enough for a brief, short enough that a runaway response cannot cost much. */
export const MAX_BRIEF_TOKENS = 1500;

export function isLlmConfigured(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * Ask for prose.
 *
 * `system` is sent as a cacheable block: it is identical between managers and
 * between gameweeks, so caching it is the difference between paying for the
 * instructions once and paying for them on every call.
 *
 * Returns null with no key, and null on any failure. A brief that fails to
 * generate must never take down a screen whose numbers are all present — the
 * commentary is the optional half.
 */
export async function complete(options: {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
}): Promise<LlmResult | null> {
  if (!isLlmConfigured()) return null;

  const model = options.model ?? BRIEF_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens ?? MAX_BRIEF_TOKENS,
      system: [
        {
          type: "text",
          text: options.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: options.prompt }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (text.length === 0) return null;

    return {
      text,
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedTokens:
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Record what a call cost.
 *
 * Separate from the call itself so a logging failure cannot lose a brief that
 * was already paid for.
 */
export async function logUsage(
  result: LlmResult,
  purpose: string,
  entryId: number | null,
  gw: number | null,
): Promise<void> {
  if (!isDbConfigured()) return;

  await getDb()
    .from("llm_usage")
    .insert({
      entry_id: entryId,
      gw,
      model: result.model,
      purpose,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cached_tokens: result.cachedTokens,
    });
}
