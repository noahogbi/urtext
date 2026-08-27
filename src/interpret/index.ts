import type { Intent } from "../extract/intent.js";
import type { Changeset, Claim, Fact, InterpretResult } from "../types.js";
import { buildPrompt } from "./prompt.js";
import { requestClaims, unavailableReason, type ClientOptions } from "./client.js";

export { CLAIMS_SCHEMA, parseClaims } from "./schema.js";
export { buildPrompt } from "./prompt.js";
export { DEFAULT_MODEL, unavailableReason } from "./client.js";

export interface InterpretOptions extends ClientOptions {
  /** Skip the stage entirely, whatever the environment says. */
  disabled?: boolean;
  /**
   * The stated intent to compare the change against. Undefined means none was
   * available, and the stage runs without an intent block. The seam a future
   * `--intent` override arrives through: it constructs an `Intent` with a
   * different `source` and changes nothing below this line.
   */
  intent?: Intent;
}

/** Copy for a run whose range stated no intent at all — no commit messages to compare against. */
export const INTENT_ABSENT_NOTE =
  "no commit messages in this range, so the change was not compared against a stated intent";

/**
 * Copy for a run that had a stated intent, but not a complete one. Pluralized
 * inline in the style `review` in `../cli.ts` already uses for its
 * dropped-claims warning, and phrased as a reason like the skip copy beside
 * it: they land in the same list and a reader meets them as one thing.
 */
export function intentTruncatedNote(omitted: number): string {
  return `the stated intent covers only the most recent commit messages in this range; ${omitted} older message${omitted === 1 ? "" : "s"} left out, so a change described only there may be marked as beyond stated intent`;
}

/**
 * Deletes the marker from every claim. The schema advertises `beyondIntent`
 * unconditionally, so a model can set it on a request that stated no intent;
 * the badge would then say the commit messages do not account for something
 * when there were no commit messages. One line, closing that off structurally
 * rather than by trusting the field description — see
 * `test/interpret/index.test.ts`, "strips beyondIntent from every claim when
 * the run stated no intent".
 */
function withoutBeyondIntent(claims: Claim[]): Claim[] {
  return claims.map((claim) => {
    if (claim.beyondIntent === undefined) return claim;
    const stripped = { ...claim };
    delete stripped.beyondIntent;
    return stripped;
  });
}

/**
 * The interpretation stage. Never rejects: a network failure, a refusal, or
 * a malformed response all degrade the review to its analyzer findings and
 * say why in `skipped`, rather than losing the run — see
 * `test/interpret/index.test.ts`, "turns a thrown client error into a
 * skipped reason rather than a rejection".
 *
 * A refusal (`requestClaims` throws, caught below) and the model
 * legitimately finding nothing to add (`requestClaims` resolves with an
 * empty `claims` array) both end up with `claims: []`, but only the former
 * sets `skipped`. That is deliberate: "the model declined" and "the model
 * had nothing to add" must read differently to a reviewer, and an empty
 * array cannot carry that distinction on its own — `skipped` is what does.
 */
export async function interpret(
  changeset: Changeset,
  facts: Fact[],
  opts: InterpretOptions = {},
): Promise<InterpretResult> {
  // Every skipped path returns `model: ""`, never `opts.model`:
  // `InterpretResult.model` is the model that *produced* the claims, and a
  // skipped stage produced nothing — returning the requested model handed
  // `--json` consumers a model name for a stage that never ran.
  if (opts.disabled) {
    return { claims: [], model: "", skipped: "--no-llm was set, so the model was not asked" };
  }
  const unavailable = unavailableReason(opts);
  if (unavailable) {
    return { claims: [], model: "", skipped: unavailable };
  }
  if (facts.length === 0 && changeset.files.length === 0) {
    return { claims: [], model: "", skipped: "nothing changed" };
  }

  try {
    const result = await requestClaims(buildPrompt(changeset, facts, opts.intent), opts);
    const claims = opts.intent ? result.claims : withoutBeyondIntent(result.claims);
    // Only `interpret` knows whether the stage actually ran, so `interpret`
    // decides: recomputing this gate in `../cli.ts` would be the same
    // condition written twice.
    const intentNote = !opts.intent
      ? INTENT_ABSENT_NOTE
      : opts.intent.omitted > 0
        ? intentTruncatedNote(opts.intent.omitted)
        : undefined;
    return intentNote
      ? { claims, model: result.model, intentNote }
      : { claims, model: result.model };
  } catch (err) {
    return {
      claims: [],
      model: "",
      skipped: err instanceof Error ? err.message : String(err),
    };
  }
}
