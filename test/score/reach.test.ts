import { describe, expect, it } from "vitest";
import {
  foldReach,
  groupAddedExports,
  groupSignatureChanges,
  reachKey,
  typeUnresolvedNoteFor,
  type SignatureChangeDetail,
} from "../../src/score/reach.js";
import { WEIGHTS } from "../../src/score/index.js";
import type { Fact, Finding } from "../../src/types.js";

const ev = (file: string, line: number, excerpt = "x") => ({ file, line, excerpt });

const fact = (over: Partial<Fact> & Pick<Fact, "kind">): Fact => ({
  id: `${over.kind}:a.ts:s`,
  file: "a.ts",
  line: 1,
  detail: {},
  evidence: [ev("a.ts", 1)],
  ...over,
});

// The real ranking `rankWithAbsorption` passes in production — used here too
// so a sibling-selection test exercises the actual weights, not a stand-in
// that could pass while the real ordering is wrong.
const weight = (f: Fact): number => WEIGHTS.factKind[f.kind];

describe("foldReach", () => {
  it("removes blast_radius facts from the fact list", () => {
    const { facts } = foldReach(
      [
        fact({ kind: "signature_changed", qualifiedSymbol: "used", detail: { export: "used" } }),
        fact({ kind: "blast_radius", qualifiedSymbol: "used", detail: { symbol: "used", references: 34 } }),
      ],
      weight,
    );
    expect(facts.map((f) => f.kind)).toEqual(["signature_changed"]);
  });

  it("keys reach by file and symbol", () => {
    const { reach } = foldReach(
      [fact({ kind: "blast_radius", qualifiedSymbol: "used", detail: { symbol: "used", references: 34 } })],
      weight,
    );
    expect(reach.get(reachKey("a.ts", "used"))?.references).toBe(34);
  });

  it("carries the reference sites through as evidence", () => {
    const { reach } = foldReach(
      [
        fact({
          kind: "blast_radius",
          qualifiedSymbol: "used",
          detail: { symbol: "used", references: 2 },
          evidence: [ev("a.ts", 1), ev("b.ts", 7), ev("c.ts", 9)],
        }),
      ],
      weight,
    );
    // evidence[0] is the declaration; the rest are the call sites.
    expect(reach.get(reachKey("a.ts", "used"))?.sites.map((s) => s.file)).toEqual(["b.ts", "c.ts"]);
  });

  it("keeps a blast_radius fact that has no sibling, so reach is never silently lost", () => {
    const { facts } = foldReach(
      [fact({ kind: "blast_radius", qualifiedSymbol: "lonely", detail: { symbol: "lonely", references: 3 } })],
      weight,
    );
    expect(facts.map((f) => f.kind)).toEqual(["blast_radius"]);
  });

  it("keeps a lonely one-reference blast_radius fact — the standalone filter runs after reconcile, not here", () => {
    // MIN_STANDALONE_REFERENCES lives in src/score/reconcile.ts and is
    // applied only after model claims attach: a claim citing this fact can
    // only find it if its finding still exists. This pins that foldReach
    // never re-grows the fold-level filter that silently dropped such a
    // claim.
    const { facts, reach } = foldReach(
      [
        fact({
          kind: "blast_radius",
          qualifiedSymbol: "lonely",
          detail: { symbol: "lonely", references: 1 },
        }),
      ],
      weight,
    );
    expect(facts.map((f) => f.kind)).toEqual(["blast_radius"]);
    expect(reach.get(reachKey("a.ts", "lonely"))?.references).toBe(1);
  });

  it("absorbs a one-reference blast_radius fact into its sibling with its reach intact", () => {
    const sibling = fact({
      id: "signature_changed:a.ts:used",
      kind: "signature_changed",
      qualifiedSymbol: "used",
      detail: { export: "used" },
    });
    const radius = fact({
      id: "blast_radius:a.ts:used",
      kind: "blast_radius",
      qualifiedSymbol: "used",
      detail: { symbol: "used", references: 1 },
    });
    const { facts, reach, absorbedBy } = foldReach([sibling, radius], weight);
    // Absorption is independent of the reference count, so the sibling gets
    // this fact's reach and the absorption record whatever the count is —
    // the post-reconcile standalone filter never sees an absorbed fact.
    expect(absorbedBy.get("blast_radius:a.ts:used")).toBe("signature_changed:a.ts:used");
    expect(facts.map((f) => f.kind)).toEqual(["signature_changed"]);
    expect(reach.get(reachKey("a.ts", "used"))?.references).toBe(1);
  });

  it("does not treat a differently-qualified same-named symbol as a sibling", () => {
    // `Worker.run` and the top-level `run` in one file. The method's guard
    // fact must not absorb the export's reach, and the export's own
    // blast_radius fact must survive to speak for itself.
    const { facts, reach, absorbedBy } = foldReach(
      [
        fact({
          id: "guard_removed:a.ts:5:Worker.run:if",
          kind: "guard_removed",
          qualifiedSymbol: "Worker.run",
          detail: { guard: "if", symbol: "Worker.run" },
        }),
        fact({
          id: "blast_radius:a.ts:run",
          kind: "blast_radius",
          qualifiedSymbol: "run",
          detail: { symbol: "run", references: 3 },
        }),
      ],
      weight,
    );
    expect(facts.map((f) => f.kind).sort()).toEqual(["blast_radius", "guard_removed"]);
    expect(absorbedBy.size).toBe(0);
    expect(reach.get(reachKey("a.ts", "Worker.run"))).toBeUndefined();
    expect(reach.get(reachKey("a.ts", "run"))?.references).toBe(3);
  });

  it("leaves facts alone when there is no reach at all", () => {
    const input = [fact({ kind: "guard_removed", qualifiedSymbol: "v", detail: { guard: "if", symbol: "v" } })];
    expect(foldReach(input, weight).facts).toEqual(input);
  });

  it("records which sibling absorbed a folded blast_radius fact", () => {
    const sibling = fact({
      id: "signature_changed:a.ts:used",
      kind: "signature_changed",
      qualifiedSymbol: "used",
      detail: { export: "used" },
    });
    const radius = fact({
      id: "blast_radius:a.ts:used",
      kind: "blast_radius",
      qualifiedSymbol: "used",
      detail: { symbol: "used", references: 34 },
    });
    const { absorbedBy } = foldReach([sibling, radius], weight);
    expect(absorbedBy.get("blast_radius:a.ts:used")).toBe("signature_changed:a.ts:used");
  });

  it("does not record absorption for a lonely blast_radius fact", () => {
    const { absorbedBy } = foldReach(
      [fact({ kind: "blast_radius", qualifiedSymbol: "lonely", detail: { symbol: "lonely", references: 3 } })],
      weight,
    );
    expect(absorbedBy.size).toBe(0);
  });

  it("picks the heaviest sibling when a symbol has more than one, not whichever came first", () => {
    // guard_removed outweighs signature_changed in WEIGHTS.factKind. Order
    // them signature_changed-then-guard_removed in the input so a fix that
    // just takes the first match would still pass — only weight-based
    // selection gets this right regardless of input order.
    const weaker = fact({
      id: "signature_changed:a.ts:foo",
      kind: "signature_changed",
      qualifiedSymbol: "foo",
      detail: { export: "foo" },
    });
    const stronger = fact({
      id: "guard_removed:a.ts:foo",
      kind: "guard_removed",
      qualifiedSymbol: "foo",
      detail: { guard: "if", symbol: "foo" },
    });
    const radius = fact({
      id: "blast_radius:a.ts:foo",
      kind: "blast_radius",
      qualifiedSymbol: "foo",
      detail: { symbol: "foo", references: 5 },
    });
    const { absorbedBy } = foldReach([weaker, stronger, radius], weight);
    expect(absorbedBy.get("blast_radius:a.ts:foo")).toBe("guard_removed:a.ts:foo");
  });

  it("breaks an equal-weight tie between siblings by fact id", () => {
    const a = fact({
      id: "signature_changed:a.ts:foo:a",
      kind: "signature_changed",
      qualifiedSymbol: "foo",
      detail: { export: "foo" },
    });
    const b = fact({
      id: "signature_changed:a.ts:foo:b",
      kind: "signature_changed",
      qualifiedSymbol: "foo",
      detail: { export: "foo" },
    });
    const radius = fact({
      id: "blast_radius:a.ts:foo",
      kind: "blast_radius",
      qualifiedSymbol: "foo",
      detail: { symbol: "foo", references: 5 },
    });
    // Input order deliberately reversed relative to id order, so passing
    // requires an actual tiebreak, not an accident of iteration order.
    const { absorbedBy } = foldReach([b, a, radius], weight);
    expect(absorbedBy.get("blast_radius:a.ts:foo")).toBe("signature_changed:a.ts:foo:a");
  });
});

const finding = (over: Partial<Finding>): Finding => ({
  id: "x",
  tier: "verified",
  file: "a.ts",
  line: 1,
  title: "t",
  body: "b",
  score: 25,
  evidence: [ev("a.ts", 1)],
  ...over,
});

describe("groupAddedExports", () => {
  it("groups added exports in one file above the threshold", () => {
    const findings = [
      finding({ id: "export_added:a.ts:one", title: "one is newly exported" }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({ id: "export_added:a.ts:three", title: "three is newly exported" }),
    ];
    const { findings: out } = groupAddedExports(findings, 3);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("exports 3 new symbols");
    expect(out[0].body).toContain("one");
    expect(out[0].body).toContain("three");
    expect(out[0].evidence).toHaveLength(3);
  });

  it("leaves a file below the added-export threshold alone", () => {
    const findings = [finding({ id: "export_added:a.ts:one", title: "one is newly exported" })];
    expect(groupAddedExports(findings, 3).findings).toEqual(findings);
  });

  it("does not group findings of other kinds", () => {
    const findings = [
      finding({ id: "guard_removed:a.ts:1", title: "a guard went" }),
      finding({ id: "guard_removed:a.ts:2", title: "another guard went" }),
      finding({ id: "guard_removed:a.ts:3", title: "a third guard went" }),
    ];
    expect(groupAddedExports(findings, 3).findings).toEqual(findings);
  });

  it("groups added exports per file, not across files", () => {
    const findings = [
      finding({ id: "export_added:a.ts:one", file: "a.ts", title: "one is newly exported" }),
      finding({ id: "export_added:a.ts:two", file: "a.ts", title: "two is newly exported" }),
      finding({ id: "export_added:b.ts:three", file: "b.ts", title: "three is newly exported" }),
    ];
    const { findings: out } = groupAddedExports(findings, 2);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("sums added-export reach across the group instead of dropping it", () => {
    const findings = [
      finding({
        id: "export_added:a.ts:one",
        title: "one is newly exported",
        reach: { references: 5, sites: [ev("b.ts", 1)] },
      }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({
        id: "export_added:a.ts:three",
        title: "three is newly exported",
        reach: { references: 12, sites: [ev("c.ts", 2)] },
      }),
    ];
    const { findings: out } = groupAddedExports(findings, 3);
    expect(out).toHaveLength(1);
    // The two grouped findings' reference counts sum; the ungrouped middle
    // finding carried no reach and contributes neither a count nor a site.
    expect(out[0].reach?.references).toBe(17);
    expect(out[0].reach?.sites.map((s) => s.file)).toEqual(["b.ts", "c.ts"]);
    expect(out[0].body).toContain("17");
  });

  it("agrees the reach sentence's verb with the singular subject at exactly one reference", () => {
    const findings = [
      finding({
        id: "export_added:a.ts:one",
        title: "one is newly exported",
        reach: { references: 1, sites: [ev("b.ts", 1)] },
      }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({ id: "export_added:a.ts:three", title: "three is newly exported" }),
    ];
    const { findings: out } = groupAddedExports(findings, 3);
    expect(out[0].body).toContain("One place in this repository references them.");
    expect(out[0].body).not.toContain("One place in this repository reference them.");
  });

  it("keeps the plural verb once reach is more than one reference", () => {
    const findings = [
      finding({
        id: "export_added:a.ts:one",
        title: "one is newly exported",
        reach: { references: 5, sites: [ev("b.ts", 1)] },
      }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({ id: "export_added:a.ts:three", title: "three is newly exported" }),
    ];
    const { findings: out } = groupAddedExports(findings, 3);
    expect(out[0].body).toContain("5 places in this repository reference them.");
  });

  it("records which added-export group finding absorbed each collapsed member", () => {
    const findings = [
      finding({ id: "export_added:a.ts:one", title: "one is newly exported" }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({ id: "export_added:a.ts:three", title: "three is newly exported" }),
    ];
    const { absorbedBy } = groupAddedExports(findings, 3);
    expect(absorbedBy.get("export_added:a.ts:one")).toBe("export_added_group:a.ts");
    expect(absorbedBy.get("export_added:a.ts:two")).toBe("export_added_group:a.ts");
    expect(absorbedBy.get("export_added:a.ts:three")).toBe("export_added_group:a.ts");
  });

  it("does not record absorption for a file below the threshold", () => {
    const findings = [finding({ id: "export_added:a.ts:one", title: "one is newly exported" })];
    expect(groupAddedExports(findings, 3).absorbedBy.size).toBe(0);
  });

  it("counts a referencing line shared by several members as one place, not one per member", () => {
    const shared = ev("consumer.ts", 2);
    const findings = ["one", "two", "three"].map((name) =>
      finding({
        id: `export_added:a.ts:${name}`,
        title: `${name} is newly exported`,
        reach: { references: 1, sites: [shared] },
      }),
    );
    const { findings: out } = groupAddedExports(findings, 3);
    expect(out[0].reach?.references).toBe(1);
    expect(out[0].reach?.sites).toHaveLength(1);
    expect(out[0].body).toContain("One place in this repository references them.");
  });
});

describe("groupSignatureChanges", () => {
  const sig = (name: string, over: Partial<Finding> = {}): Finding =>
    finding({
      id: `signature_changed:a.ts:1:${name}:${name}`,
      title: `${name} changed its signature`,
      body: `${name} was string and is now number.`,
      ...over,
    });

  const detailsFor = (
    findings: Finding[],
    typeUnresolved = false,
  ): Map<string, SignatureChangeDetail> =>
    new Map(
      findings.map((f) => {
        const name = f.id.split(":")[3];
        return [
          f.id,
          { name, sentence: `${name} was string and is now number.`, typeUnresolved },
        ];
      }),
    );

  it("groups same-file signature findings at the threshold into one file-scoped finding", () => {
    const findings = [sig("one"), sig("two"), sig("three")];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("signature_changed_group:a.ts");
    expect(out[0].title).toBe("3 exports in a.ts changed their signature");
    for (const name of ["one", "two", "three"]) {
      expect(out[0].body).toContain(`${name} was string and is now number.`);
    }
    expect(out[0].body).toContain("check the call sites");
    expect(out[0].evidence).toHaveLength(3);
    expect(out[0].tier).toBe("verified");
  });

  it("leaves a file below the signature-change threshold alone", () => {
    const findings = [sig("one"), sig("two")];
    expect(groupSignatureChanges(findings, detailsFor(findings), 3).findings).toEqual(findings);
  });

  it("groups signature changes per file, not across files", () => {
    const findings = [
      sig("one"),
      sig("two"),
      sig("three", { id: "signature_changed:b.ts:1:three:three", file: "b.ts" }),
    ];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 2);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("does not group findings of other kinds, or members it has no details for", () => {
    const strangers = [
      finding({ id: "export_removed:a.ts:1:one:one" }),
      finding({ id: "export_removed:a.ts:1:two:two" }),
      finding({ id: "export_removed:a.ts:1:three:three" }),
    ];
    expect(groupSignatureChanges(strangers, new Map(), 3).findings).toEqual(strangers);

    const undescribed = [sig("one"), sig("two"), sig("three")];
    expect(groupSignatureChanges(undescribed, new Map(), 3).findings).toEqual(undescribed);
  });

  it("scores the group as its highest-scoring member — presentation, not amplification", () => {
    const findings = [
      sig("one", { score: 40 }),
      sig("two", { score: 55 }),
      sig("three", { score: 48 }),
    ];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out[0].score).toBe(55);
  });

  it("records which signature-change group finding absorbed each collapsed member", () => {
    const findings = [sig("one"), sig("two"), sig("three")];
    const { absorbedBy } = groupSignatureChanges(findings, detailsFor(findings), 3);
    for (const f of findings) {
      expect(absorbedBy.get(f.id)).toBe("signature_changed_group:a.ts");
    }
  });

  it("lists every member uncapped, with the score-driving member leading the body, the evidence, and the anchor", () => {
    // The regression this pins: a line-ordered, capped listing let the one
    // member whose amplified score and reach drove the whole group sit
    // hidden behind the cap, while the body asserted its reach
    // collectively. Six members — one more than the old cap — with the
    // driver last by line order.
    const names = ["aa", "bb", "cc", "dd", "ee"];
    const trivial = names.map((n, i) => sig(n, { line: i + 1, evidence: [ev("a.ts", i + 1)] }));
    const driver = sig("hot", {
      line: 90,
      evidence: [ev("a.ts", 90)],
      score: 112.5,
      reach: { references: 500, sites: [ev("caller.ts", 7)] },
    });
    const findings = [...trivial, driver];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out).toHaveLength(1);
    // Every member is present — nothing contributes invisibly.
    expect(out[0].evidence).toHaveLength(names.length + 1);
    for (const n of [...names, "hot"]) {
      expect(out[0].body).toContain(`${n} was string and is now number.`);
    }
    // The driver leads everywhere a reader looks first.
    expect(out[0].body.startsWith("hot was string and is now number.")).toBe(true);
    expect(out[0].evidence[0].line).toBe(90);
    expect(out[0].line).toBe(90);
    expect(out[0].score).toBe(112.5);
  });

  it("falls back to declaration-line order among equal-scoring members", () => {
    const findings = [
      sig("late", { line: 30, evidence: [ev("a.ts", 30)] }),
      sig("early", { line: 2, evidence: [ev("a.ts", 2)] }),
      sig("middle", { line: 9, evidence: [ev("a.ts", 9)] }),
    ];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out[0].line).toBe(2);
    expect(out[0].evidence.map((e) => e.line)).toEqual([2, 9, 30]);
    expect(out[0].body.indexOf("early")).toBeLessThan(out[0].body.indexOf("middle"));
    expect(out[0].body.indexOf("middle")).toBeLessThan(out[0].body.indexOf("late"));
  });

  it("appends the unresolved-type hedge exactly once when any member carries it, naming them all", () => {
    const findings = [sig("one"), sig("two"), sig("three")];
    const details = detailsFor(findings, true);
    const { findings: out } = groupSignatureChanges(findings, details, 3);
    // Names appear in member order — equal scores and lines here, so the
    // id tiebreak decides, and "three" sorts before "two".
    const note = typeUnresolvedNoteFor(["one", "three", "two"]);
    expect(out[0].body).toContain(note);
    expect(out[0].body.indexOf(note)).toBe(out[0].body.lastIndexOf(note));

    const clean = groupSignatureChanges(findings, detailsFor(findings, false), 3);
    expect(clean.findings[0].body).not.toContain("could not be resolved");
  });

  it("names only the member whose type is unresolved, not the whole group", () => {
    const findings = [sig("one"), sig("two"), sig("three")];
    const details = detailsFor(findings);
    details.set(findings[1].id, {
      name: "two",
      sentence: "two was string and is now any.",
      typeUnresolved: true,
    });
    const { findings: out } = groupSignatureChanges(findings, details, 3);
    expect(out[0].body).toContain(typeUnresolvedNoteFor(["two"]));
    expect(out[0].body).toContain("If two's new type reads as any");
    expect(out[0].body).not.toContain("If one's new type");
    expect(out[0].body).not.toContain("If three's new type");
  });

  it("sums signature-change reach across the group instead of dropping it", () => {
    const findings = [
      sig("one", { reach: { references: 4, sites: [ev("b.ts", 1)] } }),
      sig("two"),
      sig("three", { reach: { references: 9, sites: [ev("c.ts", 2)] } }),
    ];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out[0].reach?.references).toBe(13);
    expect(out[0].reach?.sites.map((s) => s.file)).toEqual(["b.ts", "c.ts"]);
    expect(out[0].body).toContain("13 places in this repository reference them.");
  });

  it("counts a referencing line shared by several members as one place, deduplicating the site list", () => {
    // The re-review's probe case: one consumer line names three of the
    // grouped consts; each member's reach is exact on its own, but the
    // merged sentence must not call that one line three places.
    const shared = ev("consumer.ts", 2);
    const findings = [
      sig("one", { reach: { references: 1, sites: [shared] } }),
      sig("two", { reach: { references: 1, sites: [shared] } }),
      sig("three", { reach: { references: 2, sites: [shared, ev("d.ts", 5)] } }),
    ];
    const { findings: out } = groupSignatureChanges(findings, detailsFor(findings), 3);
    expect(out[0].reach?.references).toBe(2);
    expect(out[0].reach?.sites.map((s) => `${s.file}:${s.line}`)).toEqual([
      "consumer.ts:2",
      "d.ts:5",
    ]);
    expect(out[0].body).toContain("2 places in this repository reference them.");
  });
});
