import Anthropic from "@anthropic-ai/sdk";
import { CLAIMS_SCHEMA, parseClaims } from "./schema.js";
import type { Claim } from "../types.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClientOptions {
  model?: string;
  apiKey?: string;
}

/** Why the stage cannot run, or undefined when it can. */
export function unavailableReason(opts: ClientOptions = {}): string | undefined {
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return "no ANTHROPIC_API_KEY set — showing analyzer findings only";
  }
  return undefined;
}

/**
 * Asks the model for claims. Returns them, or throws with a message the
 * caller (`interpret`, in `index.ts`) turns into a skipped-stage reason. Its
 * own branching — the refusal check, the missing-text guard, which model
 * gets requested — is exercised directly in `test/interpret/client.test.ts`
 * against a mocked SDK class, not just indirectly through `index.test.ts`'s
 * mock of this whole function.
 *
 * `fallbacks: "default"` is on because this model's safety classifiers can
 * decline a request outright, and a review that stops because a diff
 * mentioned a security topic is worse than one answered by another model. A
 * refusal that survives the fallback still throws here — `interpret` is what
 * turns that into a skipped stage rather than an empty claim list; this
 * function only distinguishes the two by the message it throws.
 */
export async function requestClaims(
  prompt: string,
  opts: ClientOptions = {},
): Promise<{ claims: Claim[]; model: string }> {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? DEFAULT_MODEL;

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CLAIMS_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new Error(`model declined to interpret this change (${category})`);
  }

  // Checked before the text is ever extracted, and regardless of whether a
  // (partial) text block exists — but the two reasons are different
  // mechanisms and get different messages, not one shared guess:
  //
  // - `max_tokens`: the response was truncated mid-generation. On
  //   `claude-opus-5`, thinking is on by default and shares `max_tokens`
  //   with the output, so budget exhaustion during thinking can produce zero
  //   text blocks — the expected shape of this failure, not an edge case of
  //   it. Left unhandled, this either fails `JSON.parse` inside
  //   `parseClaims` with "Unexpected end of JSON input" (reads as "the model
  //   emitted garbage") or falls into the "no text" branch below, which is
  //   flatly wrong when no text block ever opened: there was an answer in
  //   progress, it just never finished.
  // - `pause_turn`: the server-side tool-use loop hit its iteration limit.
  //   Content up to that point is complete, not truncated, and the turn is
  //   resumable by sending the response back as-is. `requestClaims` sends no
  //   `tools` in the request above, so this stop reason should be
  //   unreachable in practice — handled anyway, on the theory that an
  //   unreachable-today path is still part of the API contract, and
  //   describing a resumable pause as a truncation would misreport what
  //   actually happened if it is ever reached.
  //
  // See `test/interpret/client.test.ts`, "unusual stop_reason (max_tokens /
  // pause_turn)".
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "interpretation response was cut off by max_tokens before it finished — this model spends its token budget on thinking and output together, so this can happen even with no text produced yet",
    );
  }
  if (response.stop_reason === "pause_turn") {
    throw new Error(
      'interpretation response paused before finishing (stop_reason: "pause_turn") — the server-side tool loop hit its iteration limit; the response is a resumable pause, not a truncated fragment, but requestClaims sends no tools, so this should not occur',
    );
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text) {
    throw new Error("interpretation response contained no text");
  }

  return { claims: parseClaims(text.text), model: response.model };
}
