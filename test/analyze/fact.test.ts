import { describe, expect, it } from "vitest";
import { makeFact } from "../../src/analyze/fact.js";

describe("makeFact", () => {
  it("derives file and line from the first evidence ref", () => {
    const fact = makeFact({
      id: "guard_removed:old.ts:12:validate:if:!token",
      kind: "guard_removed",
      qualifiedSymbol: "validate",
      detail: { guard: "if", symbol: "validate" },
      evidence: [
        { file: "old.ts", line: 12, excerpt: "if (!token) {", side: "before" },
        { file: "old.ts", line: 20, excerpt: "if (!other) {", side: "before" },
      ],
    });
    expect(fact.file).toBe("old.ts");
    expect(fact.line).toBe(12);
    // The second ref does not get a say — the anchor is evidence[0].
    expect(fact.evidence).toHaveLength(2);
  });

  it("throws rather than emitting a fact with no evidence", () => {
    expect(() =>
      makeFact({
        id: "x",
        kind: "export_added",
        detail: {},
        evidence: [],
      }),
    ).toThrow(/at least one EvidenceRef/);
  });

  it("names the fact in the failure, so the analyzer at fault is obvious", () => {
    expect(() =>
      makeFact({ id: "bad-id", kind: "blast_radius", detail: {}, evidence: [] }),
    ).toThrow(/blast_radius.*bad-id/);
  });

  it("omits symbol entirely when none was given", () => {
    const fact = makeFact({
      id: "y",
      kind: "effect_added",
      detail: { effect: "network", sites: 1 },
      evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
    });
    expect("symbol" in fact).toBe(false);
  });
});
