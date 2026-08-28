import { describe, expect, it } from "vitest";
import {
  MIN_STANDALONE_REFERENCES,
  MODEL_CEILING,
  reconcile,
} from "../../src/score/reconcile.js";
import { WEIGHTS, scoreFact, tierFor } from "../../src/score/index.js";
import type { Claim, EffectKind, Fact } from "../../src/types.js";

const fact = (id: string, over: Partial<Fact> = {}): Fact => ({
  id,
  kind: "guard_removed",
  file: "a.ts",
  line: 3,
  qualifiedSymbol: "validate",
  detail: { guard: "if", symbol: "validate" },
  evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
  ...over,
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: "c1",
  file: "a.ts",
  line: 3,
  summary: "the auth check was removed",
  reasoning: "callers can now pass an empty token",
  severity: 0.8,
  ...over,
});

describe("tierFor", () => {
  it("marks an analyzer fact with no claim verified", () => {
    expect(tierFor(fact("f1"), undefined)).toBe("verified");
  });

  it("marks a claim with no corresponding fact model", () => {
    expect(tierFor(undefined, claim())).toBe("model");
  });

  it("marks a claim that corresponds to a fact inferred", () => {
    expect(tierFor(fact("f1"), claim({ correspondsTo: "f1" }))).toBe("inferred");
  });

  it("never returns model when a fact is present", () => {
    expect(tierFor(fact("f1"), claim())).not.toBe("model");
  });
});

describe("MODEL_CEILING", () => {
  it("sits strictly below the weakest score any real analyzer fact can produce", () => {
    // Independently recomputed here (not by calling `minPossibleAnalyzerScore`
    // itself) so this test would catch a bug in that function's coverage,
    // not just a drift in `WEIGHTS` it happens to share the blind spot with.
    const factKinds = Object.keys(WEIGHTS.factKind) as Fact["kind"][];
    const effectKinds = Object.keys(WEIGHTS.effect) as EffectKind[];
    const scores: number[] = [];
    for (const kind of factKinds) {
      if (kind === "effect_added" || kind === "effect_removed") {
        for (const effect of effectKinds) {
          scores.push(scoreFact(fact("x", { kind, detail: { effect, sites: 1 } })));
        }
      } else if (kind === "blast_radius") {
        scores.push(scoreFact(fact("x", { kind, detail: { references: 1 } })));
      } else {
        scores.push(scoreFact(fact("x", { kind, detail: {} })));
      }
    }
    const trueMin = Math.min(...scores);
    expect(MODEL_CEILING).toBeLessThan(trueMin);
  });
});

describe("reconcile", () => {
  it("keeps every fact except a claim-free sub-threshold reach row as a finding even when the model says nothing", () => {
    // Quoted verbatim by `reconcile`'s doc comment as the pin for its
    // survival rule; the exception's own pin is "suppresses a claim-free
    // lonely one-reference reach finding", below. Both facts go in here so
    // the name's "except" clause is exercised in the same breath as the
    // rule: the guard fact survives, the sub-threshold reach row does not.
    const belowThreshold = fact("blast_radius:a.ts:solo", {
      kind: "blast_radius",
      qualifiedSymbol: "solo",
      detail: { symbol: "solo", references: 1 },
      evidence: [
        { file: "a.ts", line: 8, excerpt: "export function solo() {}" },
        { file: "b.ts", line: 2, excerpt: "solo();" },
      ],
    });
    const out = reconcile([fact("f1"), belowThreshold], []);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("f1");
    expect(out[0].tier).toBe("verified");
  });

  it("attaches a corresponding claim to its fact's finding and downgrades the tier", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "f1" })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("inferred");
    expect(out[0].claim?.reasoning).toContain("empty token");
    expect(out[0].evidence).toHaveLength(1);
  });

  it("emits an uncorresponded claim as its own model-tier finding", () => {
    const out = reconcile([], [claim()]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("model");
    expect(out[0].title).toBe("the auth check was removed");
    expect(out[0].evidence).toEqual([]);
  });

  it("drops a claim whose correspondsTo names a fact that does not exist", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "nope" })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("verified");
  });

  it("ranks a model-tier finding below even the weakest verified fact", () => {
    // Deliberately the weakest kind/effect combination scoreFact can
    // produce, not guard_removed — a guarding test against the heaviest
    // fact kind would pass for any ceiling under its weight, including a
    // broken one.
    const weakest = fact("f1", {
      kind: "effect_removed",
      qualifiedSymbol: undefined,
      detail: { effect: "timing", sites: 1 },
    });
    const out = reconcile([weakest], [claim({ id: "c2", severity: 1 })]);
    const verified = out.find((f) => f.tier === "verified")!;
    const model = out.find((f) => f.tier === "model")!;
    expect(verified.score).toBeGreaterThan(model.score);
  });

  it("never lets a claim change a fact's evidence", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "f1", file: "elsewhere.ts", line: 99 })]);
    expect(out[0].evidence[0].file).toBe("a.ts");
    expect(out[0].file).toBe("a.ts");
    expect(out[0].line).toBe(3);
  });

  it("clamps a non-finite severity to 0 rather than poisoning the score comparison", () => {
    const out = reconcile([], [claim({ severity: NaN })]);
    expect(out[0].score).toBe(0);
    expect(Number.isFinite(out[0].score)).toBe(true);
  });

  it("clamps an out-of-range severity into 0..1", () => {
    const negative = reconcile([], [claim({ id: "neg", severity: -5 })]);
    const over = reconcile([], [claim({ id: "over", severity: 1000 })]);
    expect(negative[0].score).toBe(0);
    expect(over[0].score).toBe(MODEL_CEILING);
  });

  it("keeps the first claim on a duplicate correspondsTo, deterministically", () => {
    const first = claim({ id: "first", correspondsTo: "f1", reasoning: "first explanation" });
    const second = claim({ id: "second", correspondsTo: "f1", reasoning: "second explanation" });
    const out = reconcile([fact("f1")], [first, second]);
    expect(out).toHaveLength(1);
    expect(out[0].claim?.reasoning).toBe("first explanation");
  });

  it("counts the claims first-claim-wins drops, so a caller can disclose them", () => {
    // The losing claim is model output the reader never sees; silently
    // discarding it left no way to know the model said two things about one
    // finding. The count reaches `review` in cli.ts, which turns it into a
    // warnings line.
    const first = claim({ id: "first", correspondsTo: "f1" });
    const second = claim({ id: "second", correspondsTo: "f1", reasoning: "a different observation" });
    const third = claim({ id: "third", correspondsTo: "f1", reasoning: "yet another" });
    let dropped = 0;
    reconcile([fact("f1")], [first, second, third], (n) => {
      dropped = n;
    });
    expect(dropped).toBe(2);
  });

  it("does not call the dropped-claims callback when nothing was dropped", () => {
    let called = false;
    reconcile([fact("f1")], [claim({ correspondsTo: "f1" })], () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("does not count a dangling correspondsTo as a dropped claim", () => {
    // A dangling reference is dropped for its own documented reason —
    // presenting it as "the model said more about a finding" would be false.
    let called = false;
    reconcile(
      [fact("f1")],
      [claim({ correspondsTo: "f1" }), claim({ id: "c2", correspondsTo: "nope" })],
      () => {
        called = true;
      },
    );
    expect(called).toBe(false);
  });

  it("gives two claims that share a model-generated id distinct finding ids", () => {
    const out = reconcile([], [claim({ id: "dup", severity: 0.3 }), claim({ id: "dup", severity: 0.6 })]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((f) => f.id)).size).toBe(2);
  });

  it("breaks a tie on score, file, and line by id, rather than falling back to input order", () => {
    // Two standalone claims at the same file/line with equal clamped
    // severity (a huge value and the exact top of the range clamp to the
    // same severity) tie on every key but id.
    const out = reconcile(
      [],
      [
        claim({ id: "z-last", severity: 1000, file: "a.ts", line: 3 }),
        claim({ id: "a-first", severity: 1, file: "a.ts", line: 3 }),
      ],
    );
    expect(out.map((f) => f.id)).toEqual(
      [...out.map((f) => f.id)].sort((x, y) => x.localeCompare(y)),
    );
  });

  it("attaches a claim on a folded blast_radius fact to the sibling that absorbed it, not a rival finding", () => {
    // Realistic ids, matching what the analyzers actually emit.
    const sibling = fact("signature_changed:s.ts:s.ts:findByEmail", {
      kind: "signature_changed",
      file: "s.ts",
      line: 10,
      qualifiedSymbol: "findByEmail",
      detail: { export: "findByEmail", before: "(s: string) => User", after: "(s: string) => User | null" },
      evidence: [{ file: "s.ts", line: 10, excerpt: "export function findByEmail" }],
    });
    const radius = fact("blast_radius:s.ts:findByEmail", {
      kind: "blast_radius",
      file: "s.ts",
      line: 10,
      qualifiedSymbol: "findByEmail",
      detail: { symbol: "findByEmail", references: 34 },
      evidence: [
        { file: "s.ts", line: 10, excerpt: "export function findByEmail" },
        { file: "c.ts", line: 5, excerpt: "findByEmail(x)" },
      ],
    });
    const onRadius = claim({
      id: "cr",
      correspondsTo: "blast_radius:s.ts:findByEmail",
      summary: "widely used, changed anyway",
      reasoning: "34 call sites now see a nullable return",
    });

    const out = reconcile([sibling, radius], [onRadius]);

    // The claim is about the symbol, and the sibling's finding is the
    // symbol's finding — the blast_radius fact never had one of its own to
    // recover, so a correct fix produces exactly one finding here, not two.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signature_changed:s.ts:s.ts:findByEmail");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].reach?.references).toBe(34);
    expect(out[0].claim?.reasoning).toContain("nullable");
    // The reference count is stated once, by the reach amplification in
    // `rank` — not a second time by a standalone rendering of the fact.
    expect(out[0].body.match(/34/g)).toHaveLength(1);
  });

  it("lands a claim on the most serious sibling when a symbol has more than one, not whichever came first", () => {
    // guard_removed and signature_changed on the same symbol both
    // absorb this blast_radius fact's reach — `rank` amplifies both
    // regardless of which one the claim attaches to, since amplification is
    // keyed on (file, symbol), not on `absorbedBy`. Only *which finding the
    // claim lands on* is decided by weight, and it should be the guard: a
    // claim about this symbol is worth more attached to the most serious
    // finding about it than to whichever analyzer happened to run first.
    const guard = fact("guard_removed:m.ts:m.ts:validate", {
      kind: "guard_removed",
      file: "m.ts",
      line: 4,
      qualifiedSymbol: "validate",
      detail: { guard: "if", symbol: "validate" },
      evidence: [{ file: "m.ts", line: 4, excerpt: "if (!input) {" }],
    });
    const signature = fact("signature_changed:m.ts:m.ts:validate", {
      kind: "signature_changed",
      file: "m.ts",
      line: 9,
      qualifiedSymbol: "validate",
      detail: { export: "validate", before: "(x: string) => boolean", after: "(x: unknown) => boolean" },
      evidence: [{ file: "m.ts", line: 9, excerpt: "export function validate" }],
    });
    const radius = fact("blast_radius:m.ts:validate", {
      kind: "blast_radius",
      file: "m.ts",
      line: 4,
      qualifiedSymbol: "validate",
      detail: { symbol: "validate", references: 12 },
      evidence: [
        { file: "m.ts", line: 4, excerpt: "if (!input) {" },
        { file: "n.ts", line: 2, excerpt: "validate(x)" },
      ],
    });
    const onRadius = claim({
      id: "cr",
      correspondsTo: "blast_radius:m.ts:validate",
      summary: "widely used, changed anyway",
      reasoning: "12 call sites depend on the old guard behaviour",
    });

    // Facts deliberately ordered signature-then-guard, so a fix that just
    // takes the first sibling it finds would still land on the wrong one.
    const out = reconcile([signature, guard, radius], [onRadius]);

    expect(out).toHaveLength(2);
    const guardFinding = out.find((f) => f.id === "guard_removed:m.ts:m.ts:validate")!;
    const signatureFinding = out.find((f) => f.id === "signature_changed:m.ts:m.ts:validate")!;
    expect(guardFinding.tier).toBe("inferred");
    expect(guardFinding.claim?.reasoning).toContain("old guard behaviour");
    // Confirms the coordinator's "rank's output is unchanged" requirement:
    // the non-absorbing sibling is still amplified by the same reach and
    // carries no claim, exactly as it would without this fix.
    expect(signatureFinding.tier).toBe("verified");
    expect(signatureFinding.claim).toBeUndefined();
    expect(guardFinding.reach?.references).toBe(12);
    expect(signatureFinding.reach?.references).toBe(12);
  });

  it("never lets a claim on a high-reference folded blast_radius fact outrank the finding that absorbed it", () => {
    // The exact regression: at 100 references, scoreFact's log curve lifts
    // a lone blast_radius fact's raw score (WEIGHTS.factKind.blast_radius
    // times three, for two decades of references) above what its
    // export_added sibling actually scores once amplified by that same
    // reach (WEIGHTS.factKind.export_added times the bounded 1.5x).
    // Rendering the blast_radius fact as its own recovered finding — the
    // mechanism this test replaces — let that unamplified score outrank the
    // finding it was supposed to be folded into, and printed "100" in two
    // separate findings besides.
    const sibling = fact("export_added:g.ts:g.ts:foo", {
      kind: "export_added",
      file: "g.ts",
      line: 1,
      qualifiedSymbol: "foo",
      detail: { export: "foo" },
      evidence: [{ file: "g.ts", line: 1, excerpt: "export const foo = 1;" }],
    });
    const radius = fact("blast_radius:g.ts:foo", {
      kind: "blast_radius",
      file: "g.ts",
      line: 1,
      qualifiedSymbol: "foo",
      detail: { symbol: "foo", references: 100 },
      evidence: [
        { file: "g.ts", line: 1, excerpt: "export const foo = 1;" },
        { file: "u.ts", line: 3, excerpt: "foo()" },
      ],
    });
    const onRadius = claim({
      id: "cr",
      correspondsTo: "blast_radius:g.ts:foo",
      summary: "heavily used export",
      reasoning: "100 call sites depend on foo's current shape",
    });

    const out = reconcile([sibling, radius], [onRadius]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("export_added:g.ts:g.ts:foo");
    expect(out[0].score).toBe(37.5);
    expect(out.some((f) => f.id === "blast_radius:g.ts:foo")).toBe(false);
    expect(out[0].body.match(/100/g)).toHaveLength(1);
  });

  it("attaches a claim on a grouped export_added fact to the group's finding", () => {
    const exportFacts = ["foo", "bar", "baz", "qux"].map((name) =>
      fact(`export_added:g.ts:g.ts:${name}`, {
        kind: "export_added",
        file: "g.ts",
        line: 1,
        detail: { export: name },
        evidence: [{ file: "g.ts", line: 1, excerpt: `export const ${name} = 1;` }],
      }),
    );
    const onMember = claim({
      id: "cm",
      correspondsTo: "export_added:g.ts:g.ts:foo",
      summary: "foo is the new public entry point",
      reasoning: "other modules are expected to import foo directly",
    });

    const out = reconcile(exportFacts, [onMember]);

    // One finding, not a group plus a rival member finding: the claim is
    // about the symbol, and the group finding is the symbol's finding once
    // grouped.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("export_added_group:g.ts");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].title).toBe("exports 4 new symbols");
    expect(out[0].claim?.reasoning).toContain("import foo directly");
  });

  // The standalone-reach filter, pinned with literal reference counts on
  // both sides of the threshold — inputs recomputed from the constant would
  // survive the constant moving, which is exactly the mutation these must
  // catch. The toBe check documents the pairing.
  const lonelyRadius = (references: number): Fact =>
    fact("blast_radius:r.ts:helper", {
      kind: "blast_radius",
      file: "r.ts",
      line: 4,
      qualifiedSymbol: "helper",
      detail: { symbol: "helper", references },
      evidence: [
        { file: "r.ts", line: 4, excerpt: "export function helper() {}" },
        { file: "u.ts", line: 9, excerpt: "helper();" },
      ],
    });

  it("suppresses a claim-free lonely one-reference reach finding", () => {
    expect(MIN_STANDALONE_REFERENCES).toBe(2);
    expect(reconcile([lonelyRadius(1)], [])).toEqual([]);
  });

  it("keeps a claim-free lonely reach finding at exactly the threshold", () => {
    const out = reconcile([lonelyRadius(2)], []);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("verified");
    expect(out[0].title).toBe("helper changed and is referenced in 2 places");
  });

  it("keeps a below-threshold lonely reach finding that a claim explains, at its normal inferred tier", () => {
    // The whole reason the filter runs after claims attach: model context is
    // exactly what promotes this row out of "filler", so a claim citing the
    // fact must find its finding alive and ride along on it — never be
    // silently dropped by a row that vanished one stage earlier.
    const onRadius = claim({
      id: "cr",
      correspondsTo: "blast_radius:r.ts:helper",
      summary: "single caller, load-bearing",
      reasoning: "the one caller is the request entrypoint, so this change gates every request",
    });
    const out = reconcile([lonelyRadius(1)], [onRadius]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("blast_radius:r.ts:helper");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].title).toBe("helper changed and is referenced in one place");
    expect(out[0].claim?.reasoning).toContain("request entrypoint");
  });

  it("still amplifies a sibling with a one-reference absorbed fact, untouched by the standalone filter", () => {
    const sibling = fact("signature_changed:r.ts:4:helper:helper", {
      kind: "signature_changed",
      file: "r.ts",
      line: 4,
      qualifiedSymbol: "helper",
      detail: { export: "helper", before: "() => string", after: "() => number" },
      evidence: [{ file: "r.ts", line: 4, excerpt: "export function helper" }],
    });
    const out = reconcile([sibling, lonelyRadius(1)], []);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signature_changed:r.ts:4:helper:helper");
    expect(out[0].reach?.references).toBe(1);
    expect(out[0].body).toContain("One place in this repository references it.");
  });

  it("reports how many rows the standalone filter removed, through its callback", () => {
    let suppressed = 0;
    reconcile([lonelyRadius(1)], [], undefined, (n) => {
      suppressed = n;
    });
    expect(suppressed).toBe(1);
  });

  it("does not call the suppressed callback when nothing was suppressed", () => {
    let called = false;
    reconcile([lonelyRadius(2)], [], undefined, () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("attaches a claim on a grouped signature_changed fact to the group's finding", () => {
    const sigFacts = ["one", "two", "three"].map((name, i) =>
      fact(`signature_changed:g.ts:${i + 1}:${name}:${name}`, {
        kind: "signature_changed",
        file: "g.ts",
        line: i + 1,
        qualifiedSymbol: name,
        detail: { export: name, before: "string", after: "number" },
        evidence: [{ file: "g.ts", line: i + 1, excerpt: `export const ${name}` }],
      }),
    );
    const onMember = claim({
      id: "cm",
      correspondsTo: "signature_changed:g.ts:2:two:two",
      summary: "the shared url type moved",
      reasoning: "every const in this file re-derives from the same base type",
    });

    const out = reconcile(sigFacts, [onMember]);

    // One finding, not a group plus a rival member finding: a claim whose
    // correspondsTo cites any member fact lands on the group that now
    // speaks for it.
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signature_changed_group:g.ts");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].title).toBe("3 exports in g.ts changed their signature");
    expect(out[0].claim?.reasoning).toContain("same base type");
  });

  it("redirects a claim on a folded blast_radius fact through its grouped signature sibling", () => {
    // The double absorption: the blast_radius fact folds into its
    // signature_changed sibling, whose own finding is then collapsed into
    // the file's signature group — the claim must chain through both steps.
    const sigFacts = ["one", "two", "three"].map((name, i) =>
      fact(`signature_changed:g.ts:${i + 1}:${name}:${name}`, {
        kind: "signature_changed",
        file: "g.ts",
        line: i + 1,
        qualifiedSymbol: name,
        detail: { export: name, before: "string", after: "number" },
        evidence: [{ file: "g.ts", line: i + 1, excerpt: `export const ${name}` }],
      }),
    );
    const radius = fact("blast_radius:g.ts:two", {
      kind: "blast_radius",
      file: "g.ts",
      line: 2,
      qualifiedSymbol: "two",
      detail: { symbol: "two", references: 21 },
      evidence: [
        { file: "g.ts", line: 2, excerpt: "export const two" },
        { file: "u.ts", line: 3, excerpt: "two" },
      ],
    });
    const onRadius = claim({
      id: "cr",
      correspondsTo: "blast_radius:g.ts:two",
      summary: "widely used, changed anyway",
      reasoning: "21 call sites see the new type",
    });

    const out = reconcile([...sigFacts, radius], [onRadius]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signature_changed_group:g.ts");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].claim?.reasoning).toContain("21 call sites");
    expect(out[0].reach?.references).toBe(21);
  });

  it("keeps the first claim when two different facts both absorb into the same finding", () => {
    const exportFacts = ["foo", "bar", "baz"].map((name) =>
      fact(`export_added:g.ts:g.ts:${name}`, {
        kind: "export_added",
        file: "g.ts",
        line: 1,
        detail: { export: name },
        evidence: [{ file: "g.ts", line: 1, excerpt: `export const ${name} = 1;` }],
      }),
    );
    const onFoo = claim({
      id: "cf",
      correspondsTo: "export_added:g.ts:g.ts:foo",
      reasoning: "about foo",
    });
    const onBar = claim({
      id: "cb",
      correspondsTo: "export_added:g.ts:g.ts:bar",
      reasoning: "about bar",
    });

    const out = reconcile(exportFacts, [onFoo, onBar]);

    expect(out).toHaveLength(1);
    expect(out[0].claim?.reasoning).toBe("about foo");
  });

  it("carries the marker onto an attached finding, which stays inferred", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "f1", beyondIntent: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("inferred");
    expect(out[0].beyondIntent).toBe(true);
    // A claim never edits a fact: the marker annotates the finding, and the
    // fact's own fields are untouched.
    expect(out[0].file).toBe("a.ts");
    expect(out[0].line).toBe(3);
    expect(out[0].evidence).toHaveLength(1);
  });

  it("carries the marker through the attach-to-absorber path onto the absorbing finding", () => {
    // The absorber path is not a second rule with a second spread: the claim
    // names a fact that grouping folded away, `absorbedBy` redirects it to
    // the finding that now speaks for it, and the marker rides the same
    // claim to wherever it lands. Deleting the one conditional spread fails
    // this test and the plain attach test together, as it should.
    const exportFacts = ["foo", "bar", "baz", "qux"].map((name) =>
      fact(`export_added:g.ts:g.ts:${name}`, {
        kind: "export_added",
        file: "g.ts",
        line: 1,
        detail: { export: name },
        evidence: [{ file: "g.ts", line: 1, excerpt: `export const ${name} = 1;` }],
      }),
    );
    const onMember = claim({
      id: "cm",
      correspondsTo: "export_added:g.ts:g.ts:foo",
      summary: "foo is the new public entry point",
      reasoning: "other modules are expected to import foo directly",
      beyondIntent: true,
    });

    const out = reconcile(exportFacts, [onMember]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("export_added_group:g.ts");
    expect(out[0].tier).toBe("inferred");
    expect(out[0].beyondIntent).toBe(true);
  });

  it("carries the marker onto a standalone finding, which stays model tier", () => {
    const out = reconcile([], [claim({ beyondIntent: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("model");
    expect(out[0].beyondIntent).toBe(true);
  });

  it("leaves an unmarked finding's marker absent rather than false", () => {
    // There is no "covered by the stated intent" state for any layer to
    // render, so the field is absent or true and never false.
    const attached = reconcile([fact("f1")], [claim({ correspondsTo: "f1" })]);
    expect(attached[0].beyondIntent).toBeUndefined();
    const standalone = reconcile([], [claim()]);
    expect(standalone[0].beyondIntent).toBeUndefined();
  });

  it("produces no finding at all for a marked claim with a dangling correspondsTo", () => {
    // "The model named a fact that doesn't exist" must not become a badged
    // row: the marker does not rescue a dangling reference.
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "nope", beyondIntent: true })]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("f1");
    expect(out[0].tier).toBe("verified");
    expect(out[0].beyondIntent).toBeUndefined();
  });

  it("does not transfer a losing duplicate's marker to the winner", () => {
    // First-claim-wins is unchanged; merging them would compose a claim the
    // model never made. The loss is disclosed by the dropped-claims count,
    // which counts it like any other.
    let dropped = 0;
    const out = reconcile(
      [fact("f1")],
      [
        claim({ id: "c1", correspondsTo: "f1" }),
        claim({ id: "c2", correspondsTo: "f1", beyondIntent: true }),
      ],
      (n) => {
        dropped = n;
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].beyondIntent).toBeUndefined();
    expect(dropped).toBe(1);
  });

  it("changes no score and no ordering, with the marker or without it", () => {
    const facts = [
      fact("f1"),
      fact("f2", { kind: "effect_added", file: "b.ts", line: 7, detail: { effect: "network", sites: 1 } }),
    ];
    const plain = reconcile(facts, [
      claim({ id: "c1", correspondsTo: "f1" }),
      claim({ id: "c2", severity: 1 }),
    ]);
    const marked = reconcile(facts, [
      claim({ id: "c1", correspondsTo: "f1", beyondIntent: true }),
      claim({ id: "c2", severity: 1, beyondIntent: true }),
    ]);
    expect(marked.map((f) => f.id)).toEqual(plain.map((f) => f.id));
    expect(marked.map((f) => f.score)).toEqual(plain.map((f) => f.score));
    expect(marked.map((f) => f.tier)).toEqual(plain.map((f) => f.tier));
  });

  it("never renders a marker on a verified finding", () => {
    // The marker only ever arrives on a claim, and a finding with a claim
    // attached is inferred or model by construction. An invariant with its
    // own test, not an incidental property.
    const out = reconcile(
      [fact("f1"), fact("f2", { file: "b.ts", line: 9 })],
      [claim({ correspondsTo: "f1", beyondIntent: true }), claim({ id: "c9", beyondIntent: true })],
    );
    expect(out.filter((f) => f.tier === "verified").every((f) => f.beyondIntent === undefined)).toBe(
      true,
    );
    expect(out.some((f) => f.beyondIntent)).toBe(true);
  });
});

describe("reach never buries a defect, through the path a review takes", () => {
  // This sort runs last and governs what a reader sees. `rankWithAbsorption`
  // bands its own output, and this one used to re-sort by score alone and
  // throw that away — which a unit test over `rank` could not catch, because
  // `rank` is not what a review calls. It is tested here for that reason: the
  // ordering only means something at the end of the pipeline.
  it("puts a rotted citation above a widely-referenced export", () => {
    const out = reconcile(
      [
        fact("reach", {
          kind: "blast_radius",
          qualifiedSymbol: "helper",
          detail: { symbol: "helper", references: 67 },
        }),
        fact("rot", {
          kind: "citation_rot",
          file: "docs/a.md",
          qualifiedSymbol: undefined,
          detail: {
            citedFile: "src/lib.ts",
            citedLine: 3,
            rot: "content_drift",
            citingText: "see `src/lib.ts:3`",
          },
        }),
      ],
      [],
    );
    expect(out.map((f) => f.id)).toEqual(["rot", "reach"]);
    // And the demoted finding is still present — banded, not filtered.
    expect(out).toHaveLength(2);
  });
});
