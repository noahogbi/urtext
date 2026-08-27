import type { Claim } from "../types.js";

/**
 * The response shape the model's structured output must satisfy. Constrained
 * rather than free prose because the output is merged with analyzer facts in
 * `reconcile`, and a claim that cannot be attached to a fact or placed in a
 * file is not usable there.
 */
export const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Repo-relative path this claim is about." },
          line: { type: "integer", description: "1-based line in that file." },
          summary: { type: "string", description: "One sentence. The finding headline." },
          reasoning: { type: "string", description: "Why it matters, in one or two sentences." },
          severity: { type: "number", description: "0..1. How much this should worry a reviewer." },
          correspondsTo: {
            type: "string",
            description:
              "The id of the analyzer fact this explains, when it explains one. Omit for an observation the analyzers did not make.",
          },
          beyondIntent: {
            type: "boolean",
            description:
              "True when this change does something the stated intent does not account for. Only meaningful when a `Stated intent` block was given above; omit it otherwise, and omit it rather than guessing.",
          },
        },
        required: ["file", "line", "summary", "reasoning", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
} as const;

/**
 * Validates and coerces model output into `Claim[]`. Throws on the whole
 * response — rather than keeping whatever claims happened to parse — when
 * any single claim is malformed: a partially-parsed set is indistinguishable
 * from a complete one to `reconcile`, and the tier system's value rests on
 * knowing exactly what the model said. See
 * `test/interpret/schema.test.ts`, "rejects the whole response when one
 * claim among several is malformed".
 *
 * `severity` and `line` are coerced rather than rejected when out of range.
 * `severity` is zeroed on non-finite input (matching, deliberately, what
 * `reconcile.clampSeverity` independently does to the same value) before
 * being clamped to 0..1 — the two layers must agree here, because a value
 * that slipped past this one by mapping `Infinity` to the top of that range
 * would hand a claim the top of the model tier, the exact outcome
 * `clampSeverity`'s own non-finite guard exists to prevent. `line` has no
 * second guard downstream, so an
 * invalid, non-finite, or non-positive value is repaired here to the first
 * line instead of propagating a value `reconcile` and the renderer both
 * assume is a real line number.
 */
export function parseClaims(text: string): Claim[] {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || !("claims" in raw)) {
    throw new Error("interpretation response has no `claims` array");
  }
  const list = (raw as { claims: unknown }).claims;
  if (!Array.isArray(list)) throw new Error("`claims` is not an array");

  return list.map((item, i): Claim => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`claim ${i} is not an object`);
    }
    const c = item as Record<string, unknown>;
    const str = (k: string): string => {
      const v = c[k];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`claim ${i}: \`${k}\` must be a non-empty string`);
      }
      return v;
    };
    const severity = typeof c.severity === "number" && Number.isFinite(c.severity) ? c.severity : 0;
    return {
      id: `m${i + 1}`,
      file: str("file"),
      // Math.max after the floor, not a positivity guard before it: a
      // fractional line between zero and one passes such a guard and then
      // floors to zero, a line that does not exist under the 1-based
      // contract.
      line:
        typeof c.line === "number" && Number.isFinite(c.line)
          ? Math.max(1, Math.floor(c.line))
          : 1,
      summary: str("summary"),
      reasoning: str("reasoning"),
      severity: Math.min(Math.max(severity, 0), 1),
      correspondsTo: typeof c.correspondsTo === "string" ? c.correspondsTo : undefined,
      // Strict `true` only, and deliberately not truthiness: this field puts an
      // accusation in front of a reader, so nothing but the exact affirmative earns
      // it. A string "true", a numeral, or a null is a malformed answer, and the
      // honest repair for a malformed answer is the quiet default — the same
      // direction `line` and `severity` are repaired in, toward the value that
      // cannot mislead. See `test/interpret/schema.test.ts`, "marks a claim only on
      // a literal boolean true".
      beyondIntent: c.beyondIntent === true ? true : undefined,
    };
  });
}
