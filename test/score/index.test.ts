import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_OWNER,
  GETTER_FRAME_PREFIX,
  LOCAL_SCOPE,
  MODULE_OWNER,
  SCOPE_SENTINELS,
  SETTER_FRAME_PREFIX,
} from "../../src/extract/scope.js";
import {
  bandOfKind,
  MAX_RENDERED_SIGNATURE,
  minPossibleAnalyzerScore,
  rank,
  scoreFact,
  tierFor,
  toFinding,
  WEIGHTS,
} from "../../src/score/index.js";
import { MODEL_CEILING } from "../../src/score/reconcile.js";
import type { Fact } from "../../src/types.js";

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "f1",
  kind: "effect_added",
  file: "a.ts",
  line: 3,
  detail: { effect: "network", sites: 1 },
  evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
  ...over,
});

describe("scoreFact", () => {
  it("scores an added effect above a removed one", () => {
    const added = scoreFact(fact());
    const removed = scoreFact(fact({ kind: "effect_removed" }));
    expect(added).toBeGreaterThan(removed);
  });

  it("weights network and database above timing", () => {
    const net = scoreFact(fact({ detail: { effect: "network", sites: 1 } }));
    const time = scoreFact(fact({ detail: { effect: "timing", sites: 1 } }));
    expect(net).toBeGreaterThan(time);
  });

  it("produces a finite numeric score for unrecognized effect strings", () => {
    const score = scoreFact(fact({ detail: { effect: "netwrok", sites: 1 } }));
    expect(isFinite(score)).toBe(true);
    expect(typeof score).toBe("number");
  });

  it("produces a finite numeric score for prototype keys like toString", () => {
    const score = scoreFact(fact({ detail: { effect: "toString", sites: 1 } }));
    expect(isFinite(score)).toBe(true);
    expect(typeof score).toBe("number");
  });
});

describe("tierFor", () => {
  it("marks analyzer-derived facts verified", () => {
    expect(tierFor(fact(), undefined)).toBe("verified");
  });
});

describe("toFinding", () => {
  it("writes a readable title naming the effect, leaving location to the renderer", () => {
    const f = toFinding(fact());
    expect(f.title).toBe("introduces a network effect");
    expect(f.title).not.toContain("a.ts");
    expect(f.file).toBe("a.ts");
    expect(f.tier).toBe("verified");
    expect(f.evidence).toHaveLength(1);
    expect(f.id).toBe("f1");
  });

  it("writes a removal title", () => {
    const f = toFinding(fact({ kind: "effect_removed" }));
    expect(f.title).toBe("no longer has a network effect");
  });

  it("uses the right article for a vowel-initial effect name", () => {
    expect(toFinding(fact({ detail: { effect: "env", sites: 1 } })).title).toBe(
      "introduces an env effect",
    );
    expect(
      toFinding(fact({ kind: "effect_removed", detail: { effect: "env", sites: 2 } }))
        .body,
    ).toContain("an env effect");
  });

  it("mentions the site count in the body when there are several", () => {
    const f = toFinding(fact({ detail: { effect: "network", sites: 3 } }));
    expect(f.body).toContain("3");
  });
});

describe("rank", () => {
  it("orders by descending score", () => {
    const findings = rank([
      fact({ id: "low", kind: "effect_removed", detail: { effect: "timing", sites: 1 } }),
      fact({ id: "high", kind: "effect_added", detail: { effect: "network", sites: 1 } }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["high", "low"]);
  });

  it("breaks ties deterministically by file then line", () => {
    const findings = rank([
      fact({ id: "b", file: "b.ts", line: 1 }),
      fact({ id: "a", file: "a.ts", line: 9 }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no facts", () => {
    expect(rank([])).toEqual([]);
  });

  it("maintains correct ordering when unrecognized effect strings are present", () => {
    const findings = rank([
      fact({ id: "unknown", kind: "effect_added", detail: { effect: "unknown_effect", sites: 1 } }),
      fact({ id: "high", kind: "effect_added", detail: { effect: "network", sites: 1 } }),
      fact({ id: "low", kind: "effect_removed", detail: { effect: "timing", sites: 1 } }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["high", "unknown", "low"]);
  });

  it("maintains correct ordering when prototype keys like toString are mixed in", () => {
    const findings = rank([
      fact({ id: "proto", kind: "effect_added", detail: { effect: "toString", sites: 1 } }),
      fact({ id: "high", kind: "effect_added", detail: { effect: "network", sites: 1 } }),
      fact({ id: "low", kind: "effect_removed", detail: { effect: "timing", sites: 1 } }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["high", "proto", "low"]);
  });
});

describe("rank composed with reach", () => {
  const guardFact = (over: Partial<Fact> = {}): Fact => ({
    id: "guard1",
    kind: "guard_removed",
    file: "a.ts",
    line: 3,
    qualifiedSymbol: "validate",
    detail: { guard: "if", symbol: "validate" },
    evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
    ...over,
  });

  const sigFact = (over: Partial<Fact> = {}): Fact => ({
    id: "sig1",
    kind: "signature_changed",
    file: "a.ts",
    line: 5,
    qualifiedSymbol: "used",
    detail: { export: "used" },
    evidence: [{ file: "a.ts", line: 5, excerpt: "export function used() {}" }],
    ...over,
  });

  const blastFact = (over: Partial<Fact> = {}): Fact => ({
    id: "br1",
    kind: "blast_radius",
    file: "a.ts",
    line: 5,
    qualifiedSymbol: "used",
    detail: { symbol: "used", references: 34 },
    evidence: [
      { file: "a.ts", line: 5, excerpt: "export function used() {}" },
      { file: "b.ts", line: 2, excerpt: "used();" },
    ],
    ...over,
  });

  it("gives a lonely blast_radius fact exactly one finding, with the reference count stated once", () => {
    const findings = rank([blastFact()]);
    expect(findings).toHaveLength(1);
    // A regression check for the fact amplifying and restating itself: the
    // old bug looked up the fact's own reach entry, appending a second
    // "N places... reference it" sentence on top of the one `toFinding`
    // already wrote.
    expect(findings[0].body.match(/34/g)).toHaveLength(1);
    expect(findings[0].reach).toBeUndefined();
  });

  it("does not let a lonely blast_radius finding, even at a massive reference count, outrank guard_removed or signature_changed", () => {
    const massive = blastFact({
      id: "br-massive",
      qualifiedSymbol: "hot",
      file: "z.ts",
      line: 1,
      detail: { symbol: "hot", references: 1_000_000 },
      evidence: [{ file: "z.ts", line: 1, excerpt: "export function hot() {}" }],
    });
    const findings = rank([massive, guardFact(), sigFact()]);
    const massiveFinding = findings.find((f) => f.id === "br-massive")!;
    const guardFinding = findings.find((f) => f.id === "guard1")!;
    const sigFinding = findings.find((f) => f.id === "sig1")!;
    expect(massiveFinding.score).toBeLessThan(guardFinding.score);
    expect(massiveFinding.score).toBeLessThan(sigFinding.score);
  });

  it("folds a blast_radius fact into its sibling's body exactly once", () => {
    const findings = rank([sigFact(), blastFact()]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("sig1");
    expect(findings[0].reach?.references).toBe(34);
    expect(findings[0].body.match(/34/g)).toHaveLength(1);
    expect(findings[0].body.match(/places/g)).toHaveLength(1);
  });

  it("keeps a one-reference lonely blast_radius finding — its suppression belongs to reconcile, after claims attach", () => {
    // The claim-free "referenced in one place" row is removed by
    // MIN_STANDALONE_REFERENCES in src/score/reconcile.ts, not here: a
    // model claim citing this fact can only attach to a finding that still
    // exists when reconcile looks, so rank must keep the row or the
    // claim-carrying case could never survive.
    const findings = rank([
      blastFact({
        detail: { symbol: "used", references: 1 },
        evidence: [
          { file: "a.ts", line: 5, excerpt: "export function used() {}" },
          { file: "b.ts", line: 2, excerpt: "used();" },
        ],
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe("used changed and is referenced in one place");
  });

  it("agrees the amplified body's verb with a singular 'One place' subject", () => {
    const findings = rank([
      sigFact(),
      blastFact({
        detail: { symbol: "used", references: 1 },
        evidence: [{ file: "a.ts", line: 5, excerpt: "export function used() {}" }],
      }),
    ]);
    expect(findings[0].body).toContain("One place in this repository references it.");
    expect(findings[0].body).not.toContain("One place in this repository reference it.");
  });

  // These two pin the *default* grouping threshold from the outside, with
  // literal member counts on both sides of it — the unit suite in
  // reach.test.ts passes the threshold explicitly, so only these would
  // notice the constant itself moving.
  const sameFileSigs = (names: string[]) =>
    names.map((name, i) =>
      sigFact({
        id: `signature_changed:a.ts:${i + 1}:${name}:${name}`,
        line: i + 1,
        qualifiedSymbol: name,
        detail: { export: name, before: "string", after: "number" },
        evidence: [{ file: "a.ts", line: i + 1, excerpt: `export const ${name}` }],
      }),
    );

  it("folds three same-file signature facts into one grouped finding", () => {
    const findings = rank(sameFileSigs(["one", "two", "three"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("signature_changed_group:a.ts");
    expect(findings[0].title).toBe("3 exports in a.ts changed their signature");
    expect(findings[0].body).toContain("one was string and is now number.");
    expect(findings[0].body).toContain("three was string and is now number.");
    expect(findings[0].evidence).toHaveLength(3);
  });

  it("leaves two same-file signature facts as their own findings", () => {
    const findings = rank(sameFileSigs(["one", "two"]));
    expect(findings).toHaveLength(2);
    for (const f of findings) {
      expect(f.id.startsWith("signature_changed_group")).toBe(false);
    }
  });

  it("leads the group with the amplified member even when it sits last by declaration line", () => {
    // The re-review's live demo: six same-file signature facts, the last of
    // them by line order carrying a folded blast_radius that drives the
    // whole group's score and reach. That member must lead the body and the
    // evidence — never hide behind members that contribute nothing.
    const trivial = sameFileSigs(["aa", "bb", "cc", "dd", "ee"]);
    const hotSig = sigFact({
      id: "signature_changed:a.ts:90:hot:hot",
      line: 90,
      qualifiedSymbol: "hot",
      detail: { export: "hot", before: "string", after: "number" },
      evidence: [{ file: "a.ts", line: 90, excerpt: "export const hot" }],
    });
    const hotReach = blastFact({
      id: "blast_radius:a.ts:hot",
      qualifiedSymbol: "hot",
      line: 90,
      detail: { symbol: "hot", references: 500 },
      evidence: [
        { file: "a.ts", line: 90, excerpt: "export const hot" },
        { file: "caller.ts", line: 7, excerpt: "hot;" },
      ],
    });
    const findings = rank([...trivial, hotSig, hotReach]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("signature_changed_group:a.ts");
    expect(findings[0].body.startsWith("hot was string and is now number.")).toBe(true);
    expect(findings[0].evidence).toHaveLength(6);
    expect(findings[0].evidence[0].line).toBe(90);
    expect(findings[0].line).toBe(90);
    expect(findings[0].reach?.references).toBe(500);
  });

  it("carries a folded sibling's reach into the group and scores as the amplified member", () => {
    const sigs = sameFileSigs(["one", "two", "three"]);
    const findings = rank([
      ...sigs,
      blastFact({
        id: "blast_radius:a.ts:two",
        qualifiedSymbol: "two",
        line: 2,
        detail: { symbol: "two", references: 34 },
        evidence: [
          { file: "a.ts", line: 2, excerpt: "export const two" },
          { file: "b.ts", line: 2, excerpt: "two;" },
        ],
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("signature_changed_group:a.ts");
    expect(findings[0].reach?.references).toBe(34);
    // The amplified member is the group's highest-scoring one, so the group
    // scores exactly as that member would have alone — grouping never
    // amplifies on its own.
    const [amplified] = rank([sigs[1], blastFact({
      id: "blast_radius:a.ts:two",
      qualifiedSymbol: "two",
      line: 2,
      detail: { symbol: "two", references: 34 },
      evidence: [
        { file: "a.ts", line: 2, excerpt: "export const two" },
        { file: "b.ts", line: 2, excerpt: "two;" },
      ],
    })]);
    expect(findings[0].score).toBe(amplified.score);
  });
});

describe("new fact kinds", () => {
  const of = (over: Partial<Fact>): Fact => ({
    id: "x",
    kind: "guard_removed",
    file: "a.ts",
    line: 3,
    detail: {},
    evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
    ...over,
  });

  it("ranks a removed guard above an added effect", () => {
    expect(
      scoreFact(of({ kind: "guard_removed", detail: { guard: "if", symbol: "validate" } })),
    ).toBeGreaterThan(
      scoreFact(of({ kind: "effect_added", detail: { effect: "network", sites: 1 } })),
    );
  });

  it("ranks a changed signature above an added export", () => {
    expect(
      scoreFact(of({ kind: "signature_changed", detail: { export: "f" } })),
    ).toBeGreaterThan(scoreFact(of({ kind: "export_added", detail: { export: "g" } })));
  });

  // The previous version of this test compared 3, 40 and 80 references and
  // passed only because the curve had already saturated at the ceiling by
  // 4 references: every blast-radius finding in a real run scored exactly
  // at the effect_added ceiling and sorted by file path. A constant
  // function would have passed it.
  // What matters is that ordinary reference counts are *distinguishable*,
  // so that is what is asserted.
  it("gives ordinary reference counts distinct, increasing scores", () => {
    const at = (references: number) =>
      scoreFact(of({ kind: "blast_radius", detail: { references } }));
    const scores = [1, 3, 10, 30, 100].map(at);
    expect(new Set(scores).size).toBe(scores.length);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
    // Still under the ceiling at counts a real repository produces, or the
    // ordering above is decoration.
    expect(at(100)).toBeLessThan(60);
  });

  it("scales blast radius sub-linearly", () => {
    const at = (references: number) =>
      scoreFact(of({ kind: "blast_radius", detail: { references } }));
    // Equal ratios, so a linear scale would give equal steps; a log scale
    // does too — what makes this sub-linear is that equal *differences* in
    // count give shrinking steps.
    expect(at(30) - at(20)).toBeLessThan(at(20) - at(10));
  });

  it("never lets blast radius outrank a fact that names a real defect, however large the reference count", () => {
    const massive = scoreFact(of({ kind: "blast_radius", detail: { references: 1_000_000 } }));
    const guard = scoreFact(
      of({ kind: "guard_removed", detail: { guard: "if", symbol: "validate" } }),
    );
    expect(massive).toBeLessThan(guard);
  });

  it("writes readable text for every new kind", () => {
    const cases: Fact[] = [
      of({ kind: "guard_removed", detail: { guard: "if", symbol: "validate" } }),
      of({ kind: "export_added", detail: { export: "addedLater" } }),
      of({ kind: "export_removed", detail: { export: "willBeRemoved" } }),
      of({
        kind: "signature_changed",
        detail: { export: "findByEmail", before: "(e: string) => X", after: "(e: string) => X | null" },
      }),
      of({ kind: "blast_radius", detail: { symbol: "used", references: 34 } }),
    ];
    for (const f of cases) {
      const finding = toFinding(f);
      expect(finding.title.length).toBeGreaterThan(0);
      expect(finding.body.length).toBeGreaterThan(0);
      expect(finding.title).not.toContain("undefined");
      expect(finding.body).not.toContain("undefined");
      expect(finding.score).toBeGreaterThan(0);
    }
  });

  it("translates every scope sentinel wherever it sits in the path", () => {
    const titleFor = (symbol: string) =>
      toFinding(of({ kind: "guard_removed", detail: { guard: "if", symbol } })).title;
    // A guard's owner is a qualified path, and any segment of it can be a
    // sentinel no reader should be shown verbatim. Driven from
    // `SCOPE_SENTINELS`, not from the cases someone remembered: a fourth
    // sentinel with no translation fails here instead of reaching a report.
    // The version this replaces handled only the whole path and the last
    // segment, and printed `<anonymous>.inner` verbatim.
    for (const sentinel of SCOPE_SENTINELS) {
      for (const path of [
        sentinel,
        `outer.${sentinel}`,
        `${sentinel}.inner`,
        `a.${sentinel}.b`,
        `${sentinel}.${sentinel}`,
      ]) {
        expect(titleFor(path), path).not.toContain(sentinel);
      }
    }

    // A path of real names is printed as it stands, and each wording is
    // pinned: "contains no sentinel" on its own would accept nonsense.
    expect(titleFor("Worker.run")).toContain("Worker.run");
    const cases: ReadonlyArray<readonly [string, string]> = [
      [MODULE_OWNER, "the top level of this file"],
      [ANONYMOUS_OWNER, "an anonymous function"],
      [LOCAL_SCOPE, "an unnamed block"],
      [`Worker.run.${ANONYMOUS_OWNER}`, "an anonymous function in Worker.run"],
      [`${ANONYMOUS_OWNER}.inner`, "inner in an anonymous function"],
      [`a.${ANONYMOUS_OWNER}.b`, "b in an anonymous function in a"],
      [`${LOCAL_SCOPE}.run`, "run in an unnamed block"],
      // Accessor frames, at the end of a path and mid-path: like the
      // sentinels they are not searchable source text, so they must render
      // as prose wherever they sit.
      [`Config.${GETTER_FRAME_PREFIX}value`, "the value getter in Config"],
      [`Config.${SETTER_FRAME_PREFIX}value`, "the value setter in Config"],
      [
        `Config.${GETTER_FRAME_PREFIX}value.${ANONYMOUS_OWNER}`,
        "an anonymous function in the value getter in Config",
      ],
      // Mid-path locals, the shapes the statement-scope rule now produces
      // inside named frames: a static-block local, and a function-local
      // object's method under a merged namespace.
      [`Registry.${LOCAL_SCOPE}.helper`, "helper in an unnamed block in Registry"],
      [
        `api.${LOCAL_SCOPE}.handlers.run`,
        "handlers.run in an unnamed block in api",
      ],
      [
        `${ANONYMOUS_OWNER}.${ANONYMOUS_OWNER}`,
        "an anonymous function in an anonymous function",
      ],
    ];
    for (const [path, expected] of cases) {
      expect(titleFor(path), path).toContain(expected);
    }
  });

  it("names the symbol and count in the blast-radius text", () => {
    const f = toFinding(of({ kind: "blast_radius", detail: { symbol: "used", references: 34 } }));
    expect(f.title).toContain("used");
    expect(f.body).toContain("34");
  });

  it("capitalises the signature-changed body even when detail is entirely missing", () => {
    const f = toFinding(of({ kind: "signature_changed", detail: {} }));
    expect(f.body[0]).toBe(f.body[0].toUpperCase());
    expect(f.body).not.toContain("undefined");
  });

  it("capitalises the blast-radius body even when detail is entirely missing", () => {
    const f = toFinding(of({ kind: "blast_radius", detail: {} }));
    expect(f.body[0]).toBe(f.body[0].toUpperCase());
    expect(f.body).not.toContain("undefined");
  });

  it("does not force-capitalise a real, lowercase-led symbol name", () => {
    const f = toFinding(
      of({ kind: "blast_radius", detail: { symbol: "used", references: 34 } }),
    );
    expect(f.body.startsWith("used")).toBe(true);
  });

  describe("rendered-signature cap in the was→now sentence", () => {
    const sigFinding = (before: string, after: string) =>
      toFinding(of({ kind: "signature_changed", detail: { export: "token", before, after } }));

    it("middle-truncates a long literal on either side, stating its original length", () => {
      // The dogfood regression: a JWT-sized string literal printed verbatim.
      const jwt = `"eyJhbGciOi${"a".repeat(192)}5_Yr"`;
      const f = sigFinding(jwt, "string");
      expect(jwt.length).toBe(208);
      expect(f.body).not.toContain(jwt);
      expect(f.body).toContain("(208 chars)");
      // The head survives so the reader can recognise what the value opened
      // with, and the tail so two literals sharing a prefix stay tellable
      // apart.
      expect(f.body).toContain('"eyJhbGciOi');
      expect(f.body).toContain('5_Yr" (208 chars)');
      expect(f.body).toContain("…");

      const widened = sigFinding("string", jwt);
      expect(widened.body).not.toContain(jwt);
      expect(widened.body).toContain("(208 chars)");
    });

    it("renders a signature at exactly the cap verbatim, and one past it truncated", () => {
      const atCap = "x".repeat(MAX_RENDERED_SIGNATURE);
      expect(sigFinding(atCap, "string").body).toContain(`was ${atCap} and`);

      const pastCap = "y".repeat(MAX_RENDERED_SIGNATURE + 1);
      const f = sigFinding(pastCap, "string");
      expect(f.body).not.toContain(pastCap);
      expect(f.body).toContain(`(${MAX_RENDERED_SIGNATURE + 1} chars)`);
    });

    it("counts and cuts by code point, leaving no lone surrogate", () => {
      const astral = "🜁".repeat(MAX_RENDERED_SIGNATURE + 30);
      const f = sigFinding(astral, "string");
      // The stated length is code points, not UTF-16 units — the unit count
      // would be double.
      expect(f.body).toContain(`(${MAX_RENDERED_SIGNATURE + 30} chars)`);
      // A cut through the middle of an astral character leaves an unpaired
      // surrogate half; the body must contain none, on either side of the
      // ellipsis.
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(lone.test(f.body)).toBe(false);
    });

    it("hedges when the new type renders exactly as any and the old one did not", () => {
      // The dogfood regression: the reviewed repo's dependencies were not
      // installed at that revision, every import resolved to `any`, and the
      // report asserted a widening that never happened.
      const f = sigFinding('"https://api.example.com"', "any");
      expect(f.body).toContain("could not be resolved at this revision");
      expect(f.body).toContain("missing dependencies");
      expect(f.body).toContain("narrower than it looks");
      // The hedge names its export, so it survives being read next to other
      // findings — and next to group members — without ambiguity.
      expect(f.body).toContain("If token's new type reads as any");
    });

    it("does not hedge for a resolved new type, an any-to-narrower change, or a near-miss like any[]", () => {
      expect(sigFinding("string", "number").body).not.toContain("could not be resolved");
      // A before side reading `any` genuinely narrowed; that needs no hedge.
      expect(sigFinding("any", "string").body).not.toContain("could not be resolved");
      // Exact-match keying: `any[]` is a resolved array type, not the
      // checker's unresolved sentinel.
      expect(sigFinding("string[]", "any[]").body).not.toContain("could not be resolved");
      // Missing detail falls back to prose placeholders, never to the hedge.
      const bare = toFinding(of({ kind: "signature_changed", detail: {} }));
      expect(bare.body).not.toContain("could not be resolved");
    });

    it("states the analyzer-recorded true length and drops the storage marker when detail carries the count", () => {
      const stored = `${"x".repeat(400)}… [truncated, 202 more chars]`;
      const f = toFinding(
        of({
          kind: "signature_changed",
          detail: { export: "token", before: stored, beforeChars: 602, after: "string" },
        }),
      );
      // The marker's number is the type's real size, measured before the
      // storage cap ran — never the length of whatever text survived it.
      expect(f.body).toContain("(602 chars)");
      expect(f.body).not.toContain(`(${stored.length} chars)`);
      // The storage marker is dropped ahead of the middle cut, so its tail
      // fragment cannot sit inside the rendered tail.
      expect(f.body).not.toContain("more chars]");
    });

    it("falls back to the stored text's own count, marker included, when no true length was recorded", () => {
      const stored = `${"y".repeat(400)}… [truncated, 202 more chars]`;
      const f = toFinding(
        of({
          kind: "signature_changed",
          detail: { export: "token", before: stored, after: "string" },
        }),
      );
      expect(f.body).toContain(`(${[...stored].length} chars)`);
    });

    it("keeps truncated bodies in both rendered surfaces by composing once in toFinding", () => {
      // Both renderers print `finding.body` as-is, so pinning the body pins
      // the terminal and the HTML at the same time; this test exists to make
      // that composition point load-bearing rather than incidental.
      const long = "z".repeat(MAX_RENDERED_SIGNATURE * 2);
      const f = sigFinding("string", long);
      expect(f.body).toContain(`(${MAX_RENDERED_SIGNATURE * 2} chars)`);
    });
  });
});

describe("citation_rot scoring", () => {
  const rotFact = (over: Partial<Fact> = {}): Fact => ({
    id: "citation_rot:docs/a.md:1:content_drift",
    kind: "citation_rot",
    file: "docs/a.md",
    line: 1,
    detail: {
      rot: "content_drift",
      citedFile: "src/a.ts",
      citedLine: 1,
      was: "export const limit = 1;",
      now: "export const limit = 99;",
      baseline: "3f2a1c9",
    },
    evidence: [
      { file: "docs/a.md", line: 1, excerpt: "The limit is set at src/a.ts:1.", side: "after" },
    ],
    ...over,
  });

  it("scores the weight itself, with no scaling", () => {
    // A citation is rotted or it is not; inventing a severity for "how
    // rotted" would be a judgment nothing here supports.
    expect(scoreFact(rotFact())).toBe(WEIGHTS.factKind.citation_rot);
  });

  it("leaves minPossibleAnalyzerScore, and therefore MODEL_CEILING, exactly where it was", () => {
    // A silent shift here would re-rank every model finding in every report
    // for a reason no reader could see. The floor is still the same kind and
    // the same effect it bottomed out on before this weight existed, and the
    // ceiling still derives from that floor — recomputed from the constants
    // rather than hand-copied as a literal.
    expect(minPossibleAnalyzerScore()).toBe(
      WEIGHTS.factKind.effect_removed * WEIGHTS.effect.timing,
    );
    expect(MODEL_CEILING).toBe((WEIGHTS.factKind.effect_removed * WEIGHTS.effect.timing) / 2);
  });

  it("composes one title and one body per rot kind, and never a causal claim", () => {
    const drift = toFinding(rotFact());
    expect(drift.title).toBe("cites `src/a.ts:1`, which no longer reads the same");
    expect(drift.body).toContain("When this line was last written (3f2a1c9)");
    expect(drift.body).toContain("It now reads `export const limit = 99;`");
    expect(drift.body).toContain(
      "urtext does not know whether the new line is what this sentence meant.",
    );
    // The amendment the spec makes binding: there is no "which this change
    // moved" variant, and membership of the cited path in the changed set is
    // stated as a fact in the body, never as a cause in the title.
    expect(drift.title).not.toContain("moved");
    expect(drift.body).not.toContain("This change touched");

    const touched = toFinding(rotFact({ detail: { ...rotFact().detail, citedTouched: true } }));
    expect(touched.title).toBe(drift.title);
    expect(touched.body).toContain("This change touched `src/a.ts`.");

    const missing = toFinding(
      rotFact({
        detail: { rot: "missing_file", citedFile: "src/gone.ts", citedLine: 1, baseline: "3f2a1c9" },
      }),
    );
    expect(missing.title).toBe("cites `src/gone.ts`, which is not in this repository any more");
    expect(missing.body).toContain("is not present at this revision");

    const range = toFinding(
      rotFact({
        detail: {
          rot: "line_out_of_range",
          citedFile: "src/a.ts",
          citedLine: 3,
          lineCount: 1,
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(range.title).toBe("cites `src/a.ts:3`, which is past the end of that file");
    expect(range.body).toContain("has 1 line at this revision");

    const quote = toFinding(
      rotFact({
        detail: {
          rot: "quote_absent",
          citedFile: "src/a.ts",
          quote: "keeps the door shut",
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(quote.title).toBe("cites `src/a.ts` for a quoted phrase that is not in it");
    expect(quote.body).toContain(
      "it does not know whether the text moved, was reworded, or was deliberately dropped",
    );
  });

  it("names the span the prose wrote in a drift title, and the drifted line inside it in the body", () => {
    // A drift's `citedLine` is the line that moved; the citation is carried
    // apart from it. The title has to name the citation — that is the string
    // the reader searches their own document for — while the body says which
    // line inside it moved, which is the line the evidence points at.
    const span = toFinding(
      rotFact({
        detail: {
          rot: "content_drift",
          citedFile: "src/a.ts",
          citedLine: 4,
          writtenLine: 2,
          writtenEndLine: 6,
          was: "const c = 3;",
          now: "const c = 99;",
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(span.title).toBe("cites `src/a.ts:2-6`, which no longer reads the same");
    expect(span.body).toContain("line 4 of `src/a.ts:2-6` read `const c = 3;`");
    expect(span.body).toContain("It now reads `const c = 99;`");
    // Neither the drifted line alone — unfindable in the reader's document —
    // nor the citation's end pinned to it as a start, which is a span nobody
    // wrote.
    expect(span.title).not.toContain("src/a.ts:4");
    expect(span.title).not.toContain("4-6");
  });

  it("says which line moved only where the citation reaches more than one", () => {
    // On a single-line citation the clause would restate the line it has just
    // named, so the body of a one-line drift reads exactly as it always did.
    const single = toFinding(
      rotFact({ detail: { ...rotFact().detail, writtenLine: 1 } }),
    );
    expect(single.title).toBe("cites `src/a.ts:1`, which no longer reads the same");
    expect(single.body).toContain("(3f2a1c9), `src/a.ts:1` read");
    expect(single.body).not.toContain("line 1 of");
  });

  it("names both ends of a span in the title only where the fact is about the span", () => {
    // line_out_of_range keeps citedEndLine, because there the fact is about
    // the citation's whole reach; content_drift deliberately carries none, so
    // no renderer can print a span beside a start line the prose never
    // paired it with. See `src/analyze/citations.ts`, "The citation's end
    // line, for a range."
    const span = toFinding(
      rotFact({
        detail: {
          rot: "line_out_of_range",
          citedFile: "src/a.ts",
          citedLine: 2,
          citedEndLine: 4,
          lineCount: 3,
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(span.title).toBe("cites `src/a.ts:2-4`, which is past the end of that file");
    expect(span.body).toContain("lines 2-4 are not all in it");
    // The plural side of the line count, whose singular the case above pins.
    expect(span.body).toContain("has 3 lines at this revision");
  });

  it("agrees with a line count of one, and with a count of none", () => {
    // Both singular-reachable ends of `lineCount`: a one-line file, and a
    // file emptied entirely. A count and a noun that disagree would be
    // urtext's own grammar failing in the one place no tier badge covers.
    const one = toFinding(
      rotFact({
        detail: {
          rot: "line_out_of_range",
          citedFile: "src/a.ts",
          citedLine: 3,
          lineCount: 1,
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(one.body).toContain("has 1 line at this revision");
    expect(one.body).not.toContain("1 lines");

    const none = toFinding(
      rotFact({
        detail: {
          rot: "line_out_of_range",
          citedFile: "src/a.ts",
          citedLine: 3,
          lineCount: 0,
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(none.body).toContain("has 0 lines at this revision");
  });

  it("counts a degenerate range as the one line it is, without editing the citation in the title", () => {
    // A citation written `X:2-2` is a range in the prose and one line in
    // fact. The title echoes what the prose wrote — correcting it there would
    // misquote the sentence a reader is being sent to — while the body, which
    // is urtext's own account, says "line 2".
    const degenerate = toFinding(
      rotFact({
        detail: {
          rot: "line_out_of_range",
          citedFile: "src/a.ts",
          citedLine: 2,
          citedEndLine: 2,
          lineCount: 1,
          baseline: "3f2a1c9",
        },
      }),
    );
    expect(degenerate.title).toBe("cites `src/a.ts:2-2`, which is past the end of that file");
    expect(degenerate.body).toContain("line 2 is not in it");
    expect(degenerate.body).not.toContain("lines 2-2");
  });

  it("claims nothing about history it could not read", () => {
    // The degraded, existence-only finding: with no baseline there is no
    // commit to name and no proof the file was ever there, so the copy must
    // not borrow the gated wording.
    const undated = toFinding(
      rotFact({ detail: { rot: "missing_file", citedFile: "src/gone.ts", citedLine: 1 } }),
    );
    expect(undated.title).toBe(
      "cites `src/gone.ts`, which is not in this repository at this revision",
    );
    expect(undated.body).not.toContain("existed when this line was last written");
    expect(undated.body).toContain("could not read this line's history");
  });
});

describe("reach never buries a defect", () => {
  // `scoreFact` already caps a blast-radius score so "no reference count may
  // push it above a fact that does [name a problem]". That ceiling is
  // `effect_added`, chosen when the kinds naming a problem all sat above it.
  // `citation_rot` was added later and sits below it, so the invariant the
  // comment states quietly stopped holding for the newest defect kind: on a
  // real pull request a widely-referenced export ranked seven places above
  // the one finding naming something a person could go and fix.
  //
  // Fixed at the sort rather than the weights, because the weights are both
  // right: a rotted citation genuinely is less severe than a removed guard,
  // and forty callers genuinely differ from three. What was wrong is using
  // one number to answer two questions — how bad is this, and is it a defect
  // at all.

  it("ranks a rotted citation above a widely-referenced export", () => {
    const findings = rank([
      fact({
        id: "reach",
        kind: "blast_radius",
        detail: { symbol: "helper", references: 67 },
      }),
      fact({
        id: "rot",
        kind: "citation_rot",
        file: "docs/a.md",
        detail: {
          citedFile: "src/lib.ts",
          citedLine: 3,
          rot: "content_drift",
          citingText: "see `src/lib.ts:3`",
        },
      }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["rot", "reach"]);
  });

  it("still orders reach findings among themselves by how far they reach", () => {
    // The band must not flatten what it demotes: blast radius keeps its
    // log-scaled ordering inside its own tier, which is the whole reason the
    // fix is not simply capping its score at the lowest defect weight.
    const findings = rank([
      fact({ id: "few", kind: "blast_radius", detail: { symbol: "a", references: 3 } }),
      fact({ id: "many", kind: "blast_radius", detail: { symbol: "b", references: 67 } }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["many", "few"]);
  });
});

describe("dependency findings", () => {
  const dep = (kind: Fact["kind"], detail: Record<string, unknown>): Fact =>
    fact({
      id: `${kind}:package.json:${String(detail.map)}:${String(detail.name)}`,
      kind,
      file: "package.json",
      line: 12,
      detail,
      evidence: [{ file: "package.json", line: 12, excerpt: '"left-pad": "^1.3.0"' }],
    });

  it("says what each dependency finding means, in the spec's copy", () => {
    const added = toFinding(
      dep("dependency_added", { map: "dependencies", name: "left-pad", to: "^1.3.0" }),
    );
    expect(added.title).toBe("adds left-pad to dependencies");
    expect(added.body).toContain("now declares `left-pad` (`^1.3.0`) in `dependencies`");
    // The runtime clause appears for runtime maps only.
    expect(added.body).toContain("install scripts run whether or not anything imports it");

    const devAdded = toFinding(
      dep("dependency_added", { map: "devDependencies", name: "eslint", to: "^9.0.0" }),
    );
    expect(devAdded.body).not.toContain("install scripts run");

    const removed = toFinding(
      dep("dependency_removed", { map: "dependencies", name: "left-pad", from: "^1.3.0" }),
    );
    expect(removed.title).toBe("removes left-pad from dependencies");
    expect(removed.body).toContain("no longer declares");

    const changed = toFinding(
      dep("dependency_changed", {
        map: "dependencies",
        name: "typescript",
        from: "^5.0.0",
        to: "^6.0.0",
      }),
    );
    expect(changed.title).toBe("changes typescript in dependencies: ^5.0.0 → ^6.0.0");
    expect(changed.body).toContain("the lockfile decides what actually resolves");
  });

  it("ranks a runtime addition above the same addition in devDependencies", () => {
    // Through rank, not by reading weights — the multiplier only matters if
    // the sort feels it. `rank` returns Finding[], which carries no `detail`;
    // the map is recovered from the id, where it is a segment.
    const runtime = dep("dependency_added", { map: "dependencies", name: "a", to: "^1.0.0" });
    const dev = dep("dependency_added", { map: "devDependencies", name: "b", to: "^1.0.0" });
    const ranked = rank([dev, runtime]);
    expect(ranked[0].id).toContain(":dependencies:");
  });
});

describe("lockfile findings", () => {
  const fact = (kind: Fact["kind"], detail: Record<string, unknown>): Fact => ({
    id: `${kind}:package-lock.json`,
    kind,
    file: "package-lock.json",
    line: 1,
    detail,
    evidence: [{ file: "package-lock.json", line: 1, excerpt: "x" }],
  });

  it("ranks an out-of-sync lockfile above every manifest dependency kind", () => {
    const outOfSync = scoreFact(
      fact("lockfile_out_of_sync", { map: "dependencies", name: "a", manifest: "^2.0.0", lock: "^1.0.0" }),
    );
    expect(outOfSync).toBeGreaterThan(
      scoreFact(fact("dependency_added", { map: "dependencies", name: "a", to: "^1.0.0" })),
    );
    expect(outOfSync).toBeLessThan(WEIGHTS.factKind.export_removed);
  });

  it("halves a resolved change in a dev map, which needs detail.map to work at all", () => {
    const dev = fact("dependency_resolved_changed", {
      map: "devDependencies", name: "a", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
    });
    const runtime = fact("dependency_resolved_changed", {
      map: "dependencies", name: "a", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
    });
    expect(scoreFact(dev)).toBe(scoreFact(runtime) / 2);
  });

  it("log-scales tree churn on total movement, not arrivals alone", () => {
    const arrivals = scoreFact(fact("lockfile_tree_changed", { entered: 40, left: 0, moved: 0 }));
    const departures = scoreFact(fact("lockfile_tree_changed", { entered: 0, left: 40, moved: 0 }));
    expect(departures).toBe(arrivals);
    expect(scoreFact(fact("lockfile_tree_changed", { entered: 1, left: 0, moved: 0 }))).toBeLessThan(arrivals);
  });

  it("never lets tree churn outrank a kind that reports a problem", () => {
    const huge = scoreFact(fact("lockfile_tree_changed", { entered: 5000, left: 5000, moved: 5000 }));
    expect(huge).toBeLessThanOrEqual(WEIGHTS.factKind.effect_added);
  });

  it("sorts tree churn into the context band and the other three into the defect band", () => {
    expect(bandOfKind("lockfile_tree_changed")).toBe(bandOfKind("blast_radius"));
    expect(bandOfKind("lockfile_out_of_sync")).toBe(bandOfKind("dependency_changed"));
    expect(bandOfKind("lockfile_version_stale")).toBe(bandOfKind("dependency_changed"));
    expect(bandOfKind("dependency_resolved_changed")).toBe(bandOfKind("dependency_changed"));
  });

  it("leaves the analyzer floor where it was, so MODEL_CEILING does not move", () => {
    expect(minPossibleAnalyzerScore()).toBe(6);
  });
});

describe("lockfile finding copy", () => {
  const fact = (kind: Fact["kind"], detail: Record<string, unknown>): Fact => ({
    id: `${kind}:package-lock.json`,
    kind,
    file: "package-lock.json",
    line: 1,
    detail,
    evidence: [{ file: "package-lock.json", line: 1, excerpt: "x" }],
  });

  it("states all three tree-churn counts in the title, not the old two-count form", () => {
    const f = toFinding(fact("lockfile_tree_changed", { entered: 0, left: 0, moved: 500 }));
    expect(f.title).toContain("0 in");
    expect(f.title).toContain("0 out");
    expect(f.title).toContain("500 changed");
    // The pre-fix title named only entered/left, so an all-zero-but-moved
    // shape — the one a plain `npm update` produces — read "0 in, 0 out"
    // while carrying most of the score. Pinned as the exact string a
    // regression would reproduce.
    expect(f.title).not.toBe("the dependency tree moved: 0 in, 0 out");
  });

  it("pluralizes each tree-churn count on its own, singular only at exactly one", () => {
    // The floor shape minPossibleAnalyzerScore names as producible, so this
    // is the one that must stay right. At the two zero positions a correct
    // ternary and a hardcoded plural render identically ("0 packages"), so
    // this shape alone cannot prove either the left or the moved ternary is
    // still there — see the two tests below, which put every position at a
    // value where singular and plural actually differ.
    const f = toFinding(fact("lockfile_tree_changed", { entered: 1, left: 0, moved: 0 }));
    expect(f.body).toContain("1 package entered the tree");
    expect(f.body).toContain("0 packages left");
    expect(f.body).toContain("0 packages changed version");
  });

  it("reads singular in every position when every count is one", () => {
    const f = toFinding(fact("lockfile_tree_changed", { entered: 1, left: 1, moved: 1 }));
    expect(f.body).toContain(
      "1 package entered the tree, 1 package left, and 1 package changed version.",
    );
  });

  it("reads plural in every position when every count is more than one", () => {
    const f = toFinding(fact("lockfile_tree_changed", { entered: 2, left: 2, moved: 2 }));
    expect(f.body).toContain(
      "2 packages entered the tree, 2 packages left, and 2 packages changed version.",
    );
  });

  it("names both sides of the disagreement when the lockfile has an entry", () => {
    const f = toFinding(
      fact("lockfile_out_of_sync", {
        map: "dependencies", name: "left-pad", manifest: "^2.0.0", lock: "^1.0.0",
      }),
    );
    expect(f.body).toContain("package.json declares `^2.0.0`");
    expect(f.body).toContain("the lockfile records `^1.0.0`");
  });

  it("says the lockfile has no entry for it when lock is absent", () => {
    const f = toFinding(
      fact("lockfile_out_of_sync", {
        map: "dependencies", name: "left-pad", manifest: "^2.0.0", lock: null,
      }),
    );
    expect(f.body).toContain("the lockfile has no entry for it");
  });

  it("leads with the unchanged range only when rangeChanged is false", () => {
    const unchanged = toFinding(
      fact("dependency_resolved_changed", {
        name: "left-pad", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
      }),
    );
    expect(unchanged.body).toContain("The declared range `^1.0.0` did not change; the version");

    const changed = toFinding(
      fact("dependency_resolved_changed", {
        name: "left-pad", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: true,
      }),
    );
    expect(changed.body).not.toContain("did not change");
    expect(changed.body.startsWith("The version")).toBe(true);
  });

  it("states the lockfile's role rather than predicting an install outcome that a sibling lockfile_out_of_sync finding can falsify", () => {
    // The old closing sentence, "This is what installs.", is false whenever
    // a lockfile_out_of_sync finding is also present in the same review:
    // npm ci then refuses to install at all. The replacement states a role,
    // not an outcome, so it stays true in that same review.
    const f = toFinding(
      fact("dependency_resolved_changed", {
        name: "left-pad", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
      }),
    );
    expect(f.body).toContain("The lockfile, not the declared range, is what an install follows.");
    expect(f.body).not.toContain("This is what installs");
  });

  it("says what a stale lockfile version field means", () => {
    const f = toFinding(fact("lockfile_version_stale", { manifest: "2.0.0", lock: "1.0.0" }));
    expect(f.title).toBe("package-lock.json still says 1.0.0");
    expect(f.body).toContain("package.json declares version `2.0.0`");
    expect(f.body).toContain("the lockfile was not regenerated");
  });
});
