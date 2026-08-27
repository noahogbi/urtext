import { describe, expect, it } from "vitest";
import { CLAIMS_SCHEMA, parseClaims } from "../../src/interpret/schema.js";

const validClaim = {
  file: "a.ts",
  line: 3,
  summary: "the auth check was removed",
  reasoning: "callers can now pass an empty token",
  severity: 0.8,
};

describe("parseClaims", () => {
  it("parses a valid response into Claim objects", () => {
    const claims = parseClaims(JSON.stringify({ claims: [validClaim] }));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id: "m1",
      file: "a.ts",
      line: 3,
      summary: "the auth check was removed",
      reasoning: "callers can now pass an empty token",
      severity: 0.8,
    });
  });

  it("returns an empty array for an empty claims list", () => {
    expect(parseClaims(JSON.stringify({ claims: [] }))).toEqual([]);
  });

  it("throws when the top-level `claims` key is missing", () => {
    expect(() => parseClaims(JSON.stringify({}))).toThrow(/claims/);
  });

  it("throws when `claims` is not an array", () => {
    expect(() => parseClaims(JSON.stringify({ claims: "nope" }))).toThrow(/array/);
  });

  it("throws when a claim is missing `summary`", () => {
    const { summary, ...rest } = validClaim;
    expect(() => parseClaims(JSON.stringify({ claims: [rest] }))).toThrow(/summary/);
  });

  it("rejects the whole response when one claim among several is malformed", () => {
    const { summary, ...broken } = validClaim;
    expect(() =>
      parseClaims(JSON.stringify({ claims: [validClaim, broken] })),
    ).toThrow(/summary/);
  });

  it("clamps a severity above 1 down to 1", () => {
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, severity: 5 }] }));
    expect(claims[0].severity).toBe(1);
  });

  it("clamps a negative severity up to 0", () => {
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, severity: -3 }] }));
    expect(claims[0].severity).toBe(0);
  });

  it("falls back a non-numeric line to line 1", () => {
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, line: "not a number" }] }));
    expect(claims[0].line).toBe(1);
  });

  it("falls back a zero or negative line to line 1", () => {
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, line: -5 }] }));
    expect(claims[0].line).toBe(1);
  });

  it("repairs a fractional line between zero and one to the first line, not line 0", () => {
    // The boundary the zero/negative cases miss: 0.5 passed the positivity
    // guard and Math.floor took it to 0 — a line that does not exist,
    // contradicting the 1-based contract this function documents. This is
    // exactly the test that dies if the clamp reverts to the old
    // positivity-guard-then-floor shape.
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, line: 0.5 }] }));
    expect(claims[0].line).toBe(1);
  });

  it("floors a fractional line above 1 rather than rejecting it", () => {
    const claims = parseClaims(JSON.stringify({ claims: [{ ...validClaim, line: 6.9 }] }));
    expect(claims[0].line).toBe(6);
  });

  // `JSON.stringify` cannot produce a literal that parses back to `Infinity`
  // (it serializes `Infinity`/`NaN` as `null`), so these two build the raw
  // JSON text directly — `1e999` is valid JSON syntax that `JSON.parse`
  // overflows to `Infinity`, which is exactly the value a maximally
  // confident (or malfunctioning) model response could contain.
  const rawClaim = (field: "severity" | "line", literal: string): string =>
    `{"claims":[{"file":"a.ts","line":3,"summary":"s","reasoning":"r","severity":0.5,"${field}":${literal}}]}`;

  it("zeroes a non-finite severity instead of clamping it to the top of the range", () => {
    const claims = parseClaims(rawClaim("severity", "1e999"));
    expect(claims[0].severity).toBe(0);
  });

  it("zeroes a negative-infinite severity too, not just positive", () => {
    const claims = parseClaims(rawClaim("severity", "-1e999"));
    expect(claims[0].severity).toBe(0);
  });

  it("falls back a non-finite line to line 1 instead of propagating Infinity", () => {
    const claims = parseClaims(rawClaim("line", "1e999"));
    expect(claims[0].line).toBe(1);
  });

  it("carries `correspondsTo` through when present", () => {
    const claims = parseClaims(
      JSON.stringify({ claims: [{ ...validClaim, correspondsTo: "f1" }] }),
    );
    expect(claims[0].correspondsTo).toBe("f1");
  });

  it("leaves `correspondsTo` undefined when absent", () => {
    const claims = parseClaims(JSON.stringify({ claims: [validClaim] }));
    expect(claims[0].correspondsTo).toBeUndefined();
  });

  it("assigns each claim a unique, order-derived id", () => {
    const claims = parseClaims(JSON.stringify({ claims: [validClaim, validClaim] }));
    expect(claims.map((c) => c.id)).toEqual(["m1", "m2"]);
  });
});

describe("parseClaims beyondIntent", () => {
  it("marks a claim only on a literal boolean true", () => {
    const claims = parseClaims(
      JSON.stringify({ claims: [{ ...validClaim, beyondIntent: true }] }),
    );
    expect(claims[0].beyondIntent).toBe(true);
  });

  it("repairs every non-affirmative value to the quiet default", () => {
    // This field puts an accusation in front of a reader, so nothing but the
    // exact affirmative earns it — the same direction `line` and `severity`
    // are repaired in, toward the value that cannot mislead.
    for (const value of ['"true"', "1", "false", "null"]) {
      const claims = parseClaims(
        `{"claims":[{"file":"a.ts","line":3,"summary":"s","reasoning":"r","severity":0.5,"beyondIntent":${value}}]}`,
      );
      expect(claims[0].beyondIntent, value).toBeUndefined();
    }
  });

  it("leaves the field absent when the model omitted it", () => {
    expect(parseClaims(JSON.stringify({ claims: [validClaim] }))[0].beyondIntent).toBeUndefined();
  });

  it("still rejects the whole response when a claim beside a marked one is malformed", () => {
    const { summary, ...broken } = validClaim;
    expect(() =>
      parseClaims(JSON.stringify({ claims: [{ ...validClaim, beyondIntent: true }, broken] })),
    ).toThrow(/summary/);
  });

  it("advertises the field in the schema, so the model can set it", () => {
    expect(CLAIMS_SCHEMA.properties.claims.items.properties.beyondIntent.type).toBe("boolean");
    expect(CLAIMS_SCHEMA.properties.claims.items.required).not.toContain("beyondIntent");
    expect(CLAIMS_SCHEMA.properties.claims.items.additionalProperties).toBe(false);
  });
});
