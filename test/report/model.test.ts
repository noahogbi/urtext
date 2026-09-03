import { describe, expect, it } from "vitest";
import {
  BEYOND_INTENT_MARK,
  BEYOND_INTENT_MEANING,
  buildReportModel,
  KIND_NOTES,
  MODEL_CAUTION_STANDALONE,
  plainText,
  TIER_GLYPH,
  UNNAMED_MODEL,
} from "../../src/report/model.js";
import { renderHtml } from "../../src/report/html.js";
import { renderMarkdown } from "../../src/report/markdown.js";
import { renderTerminal } from "../../src/report/terminal.js";
import { makeFact } from "../../src/analyze/fact.js";
import { reconcile } from "../../src/score/reconcile.js";
import {
  WORKTREE,
  type Changeset,
  type Claim,
  type Finding,
  type Tier,
} from "../../src/types.js";

// Escapes rather than literal characters, for the same reason
// `src/report/conceal.ts` writes its table as code points: a literal
// concealing character in this file is invisible to the next reader.
const RLO = "\u202E";
const ZWSP = "\u200B";

const changeset = (over: Partial<Changeset> = {}): Changeset => ({
  range: { from: "main", to: WORKTREE, label: "vs main" },
  files: [],
  untrackedCount: 0,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "effect_added:src/a.ts:network",
  tier: "verified",
  file: "src/a.ts",
  line: 3,
  title: "introduces a network effect",
  body: "This file previously had no network effect. It now does, at one site.",
  score: 10,
  evidence: [{ file: "src/a.ts", line: 3, excerpt: "return fetch(url);" }],
  ...over,
});

describe("buildReportModel lens routing", () => {
  it("routes findings to lenses by their id's kind prefix", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({ id: "effect_added:a.ts:network" }),
        finding({ id: "effect_removed:a.ts:timing" }),
        finding({ id: "guard_removed:a.ts:9:run:if" }),
        finding({ id: "export_added:a.ts:helper" }),
        finding({ id: "export_removed:a.ts:helper" }),
        finding({ id: "signature_changed:a.ts:helper" }),
        finding({ id: "export_added_group:a.ts" }),
        finding({ id: "signature_changed_group:a.ts" }),
        finding({ id: "blast_radius:a.ts:helper" }),
        finding({ id: "claim:0:m1", tier: "model", evidence: [] }),
      ],
      { warnings: [] },
    );
    expect(m.findings.map((f) => f.lens)).toEqual([
      "effects",
      "effects",
      "effects",
      "surface",
      "surface",
      "surface",
      "surface",
      "surface",
      "narrative",
      "narrative",
    ]);
  });

  it("keeps the finer subject beside the lens, so a walker can split effects from guards and show contracts in both panes", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({ id: "effect_added:a.ts:network" }),
        finding({ id: "guard_removed:a.ts:9:run:if" }),
        finding({ id: "signature_changed:a.ts:helper" }),
        finding({ id: "blast_radius:a.ts:helper" }),
        finding({ id: "claim:0:m1", tier: "model", evidence: [] }),
      ],
      { warnings: [] },
    );
    expect(m.findings.map((f) => f.subject)).toEqual([
      "effect",
      "guard",
      "surface",
      "reach",
      undefined,
    ]);
  });

  it("sends an id with no colon to the narrative alone", () => {
    // An id with no kind prefix has no subject; slicing a not-found index
    // would hand back a near-miss prefix instead, which is the failure the
    // routing exists to reject.
    const m = buildReportModel(changeset(), [finding({ id: "export_added" })], {
      warnings: [],
    });
    expect(m.findings[0].lens).toBe("narrative");
    expect(m.findings[0].subject).toBeUndefined();
  });

  it("routes a citation finding to its own subject and the narrative lens", () => {
    // Its own subject rather than a reuse of `reach`, because the HTML's
    // effects pane filters on subject directly, and folding citations into
    // reach would make that pane's note describe something it is not.
    const m = buildReportModel(
      changeset(),
      [finding({ id: "citation_rot:docs/a.md:1:content_drift" })],
      { warnings: [] },
    );
    expect(m.findings[0].subject).toBe("citation");
    expect(m.findings[0].lens).toBe("narrative");
  });
});

describe("buildReportModel ordering and counts", () => {
  it("preserves rank order exactly", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ id: "a", score: 1 }), finding({ id: "b", score: 99 })],
      { warnings: [] },
    );
    // The model does not re-rank: the findings array IS the ranking.
    expect(m.findings.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("counts tiers from the findings themselves", () => {
    const m = buildReportModel(
      changeset(),
      [finding(), finding({ tier: "inferred" }), finding({ tier: "model", evidence: [] })],
      { warnings: [] },
    );
    expect(m.counts).toEqual({ verified: 1, inferred: 1, model: 1 });
  });

  it("assigns each tier its glyph", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding(),
        finding({ tier: "inferred" }),
        finding({ tier: "model", evidence: [] }),
      ],
      { warnings: [] },
    );
    expect(m.findings.map((f) => f.glyph)).toEqual([
      TIER_GLYPH.verified,
      TIER_GLYPH.inferred,
      TIER_GLYPH.model,
    ]);
    expect(TIER_GLYPH).toEqual({ verified: "▲", inferred: "●", model: "○" });
  });
});

describe("buildReportModel scope", () => {
  it("composes the scope line from files, lines, and the range label, counting deletions as changed lines", () => {
    const m = buildReportModel(
      changeset({
        files: [
          {
            path: "a.ts",
            status: "modified",
            hunks: [{ oldStart: 4, oldLines: 3, newStart: 3, newLines: 0 }],
            symbols: [],
          },
          {
            path: "b.ts",
            status: "modified",
            hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 4 }],
            symbols: [],
          },
        ],
      }),
      [],
      { warnings: [] },
    );
    expect(m.scope).toBe("2 files, 7 lines changed · vs main");
    expect(m.fileCount).toBe(2);
    expect(m.lineCount).toBe(7);
    expect(m.rangeLabel).toBe("vs main");
  });

  it("uses singular forms for a single file and line", () => {
    const m = buildReportModel(
      changeset({
        files: [
          {
            path: "a.ts",
            status: "modified",
            hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }],
            symbols: [],
          },
        ],
      }),
      [],
      { warnings: [] },
    );
    expect(m.scope).toBe("1 file, 1 line changed · vs main");
  });
});

describe("buildReportModel structural concealment", () => {
  it("segments a concealing character in an excerpt instead of carrying it raw", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          evidence: [{ file: "src/a.ts", line: 3, excerpt: `a${RLO}b` }],
        }),
      ],
      { warnings: [] },
    );
    expect(m.findings[0].evidence[0].excerpt).toEqual([
      { kind: "text", text: "a" },
      { kind: "concealed", text: "U+202E" },
      { kind: "text", text: "b" },
    ]);
    expect(plainText(m.findings[0].evidence[0].excerpt)).toBe("a[U+202E]b");
  });

  it("keeps a source-written label literal as ordinary text, distinguishable from a concealed character", () => {
    const literal = buildReportModel(
      changeset(),
      [finding({ body: "a[U+202E]b" })],
      { warnings: [] },
    );
    expect(literal.findings[0].body[0]).toEqual([{ kind: "text", text: "a[U+202E]b" }]);

    const real = buildReportModel(changeset(), [finding({ body: `a${RLO}b` })], {
      warnings: [],
    });
    expect(real.findings[0].body[0]).toEqual([
      { kind: "text", text: "a" },
      { kind: "concealed", text: "U+202E" },
      { kind: "text", text: "b" },
    ]);

    // Flattened, the two are identical — which is exactly why the model
    // carries the difference structurally: only the segments let a walker
    // style the real concealed character without styling the literal.
    expect(plainText(literal.findings[0].body[0])).toBe(
      plainText(real.findings[0].body[0]),
    );
  });

  it("carries no raw concealing character anywhere: titles, bodies, headlines, file paths, the range label, warnings, the model name, and the coverage note", () => {
    const m = buildReportModel(
      changeset({
        range: { from: "main", to: WORKTREE, label: `vs ma${RLO}in` },
        files: [
          {
            path: `gon${RLO}e.ts`,
            status: "deleted",
            hunks: [{ oldStart: 1, oldLines: 4, newStart: 0, newLines: 0 }],
            symbols: [],
          },
        ],
      }),
      [
        finding({
          file: `src/a${RLO}.ts`,
          title: `sneak${RLO} changed its signature`,
          body: `Payload${ZWSP} here.`,
          tier: "inferred",
          claim: { summary: "s", reasoning: `hidden${RLO} reasoning` },
          evidence: [{ file: `src/a${RLO}.ts`, line: 3, excerpt: "x" }],
        }),
      ],
      { model: `model${RLO}name`, warnings: [`warning with${RLO} an override`] },
    );
    const everything = JSON.stringify(m);
    expect(everything).not.toContain(RLO);
    expect(everything).not.toContain(ZWSP);
    expect(plainText(m.findings[0].title)).toContain("[U+202E]");
    expect(plainText(m.findings[0].headline)).toContain("[U+202E]");
    expect(plainText(m.findings[0].body[0])).toContain("[U+200B]");
    expect(plainText(m.findings[0].modelNote!.text)).toContain("[U+202E]");
    expect(m.findings[0].file).toBe("src/a[U+202E].ts");
    expect(m.findings[0].evidence[0].file).toBe("src/a[U+202E].ts");
    expect(m.rangeLabel).toBe("vs ma[U+202E]in");
    expect(m.scope).toContain("vs ma[U+202E]in");
    expect(m.coverageNote).toContain("gon[U+202E]e.ts");
    expect(m.notes[0]).toContain("[U+202E]");
    expect(m.provenance).toContain("[U+202E]");
    expect(m.modelName).toBe("model[U+202E]name");
  });
});

describe("buildReportModel surface symbols", () => {
  const withSymbols = () =>
    changeset({
      files: [
        {
          path: "a.ts",
          status: "modified",
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
          symbols: [
            {
              name: "send",
              qualifiedName: "send",
              kind: "function",
              exported: true,
              range: { startLine: 1, endLine: 2 },
              change: "modified",
            },
          ],
        },
      ],
    });

  // Titled for what it asserts. The plan called this "carries only the
  // exported declarations", but the fixture holds one exported symbol —
  // delete the `exported` filter and it still passes. The word "only" is
  // earned by the next test, which is where it now lives.
  it("carries an exported declaration's change, name, kind, and file", () => {
    const m = buildReportModel(withSymbols(), [], { warnings: [] });
    expect(m.surfaceSymbols).toHaveLength(1);
    expect(plainText(m.surfaceSymbols[0].qualifiedName)).toBe("send");
    expect(plainText(m.surfaceSymbols[0].kind)).toBe("function");
    expect(plainText(m.surfaceSymbols[0].file)).toBe("a.ts");
    expect(m.surfaceSymbols[0].change).toBe("modified");
  });

  it("leaves an unexported declaration out, as the symbol table always has", () => {
    const cs = withSymbols();
    cs.files[0].symbols[0].exported = false;
    expect(buildReportModel(cs, [], { warnings: [] }).surfaceSymbols).toEqual([]);
  });

  it("conceals a symbol name, so no surface has to", () => {
    // The reason this view exists rather than the HTML reading the changeset:
    // concealment happens in the model, and a symbol name is text the author
    // of the reviewed change controls.
    const cs = withSymbols();
    cs.files[0].symbols[0].qualifiedName = `sen${RLO}d`;
    const m = buildReportModel(cs, [], { warnings: [] });
    expect(plainText(m.surfaceSymbols[0].qualifiedName)).toBe("sen[U+202E]d");
    expect(JSON.stringify(m)).not.toContain(RLO);
  });
});

describe("buildReportModel written paths", () => {
  it("labels the paths of what was written, like every other path it carries", () => {
    // The plan planted the concealing character in the report path alone,
    // which left the title's plural unearned: `labelConcealed` could be
    // dropped from the export paths and this test would still have passed. An
    // export path carries one too, so each labeling is pinned by an
    // assertion of its own — and the untouched pdf path pins that a path with
    // nothing to conceal comes back exactly as it went in.
    const m = buildReportModel(changeset(), [], {
      warnings: [],
      reportPath: `/tmp/.urtext/rev${RLO}iew.html`,
      exportPaths: [
        { format: "md", path: `/tmp/.urtext/rev${RLO}iew.md` },
        { format: "pdf", path: "/tmp/.urtext/review.pdf" },
      ],
    });
    expect(m.reportPath).toBe("/tmp/.urtext/rev[U+202E]iew.html");
    expect(m.exportPaths.map((e) => e.format)).toEqual(["md", "pdf"]);
    expect(m.exportPaths[0].path).toBe("/tmp/.urtext/rev[U+202E]iew.md");
    expect(m.exportPaths[1].path).toBe("/tmp/.urtext/review.pdf");
    expect(JSON.stringify(m)).not.toContain(RLO);
  });

  it("carries an empty export list rather than none, and no path when none was written", () => {
    const m = buildReportModel(changeset(), [], { warnings: [] });
    expect(m.exportPaths).toEqual([]);
    expect(m.reportPath).toBeUndefined();
  });
});

describe("buildReportModel provenance", () => {
  it("gates provenance on a model name AND a model-derived tier", () => {
    const none = buildReportModel(changeset(), [finding()], {
      model: "claude-opus-5",
      warnings: [],
    });
    expect(none.provenance).toBeUndefined();
    const some = buildReportModel(changeset(), [finding({ tier: "inferred" })], {
      model: "claude-opus-5",
      warnings: [],
    });
    expect(some.provenance).toContain("claude-opus-5");
    expect(some.provenance).toBe("claude-opus-5 interpreted this change.");
  });

  it("keeps provenance when the only model-derived finding is model-tier", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ tier: "model", evidence: [] })],
      { model: "claude-opus-5", warnings: [] },
    );
    expect(m.provenance).toBe("claude-opus-5 interpreted this change.");
  });

  it("omits provenance when no model name was recorded, even with model-tier findings", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ tier: "model", evidence: [] })],
      { warnings: [] },
    );
    expect(m.provenance).toBeUndefined();
    expect(m.modelName).toBeUndefined();
  });

  it("carries the raw model name apart from the gated provenance line", () => {
    const m = buildReportModel(changeset(), [finding()], {
      model: "claude-opus-5",
      warnings: [],
    });
    // Every finding is verified, so there is no provenance — but a walker
    // still needs the name to gate claim prose the way the terminal does.
    expect(m.provenance).toBeUndefined();
    expect(m.modelName).toBe("claude-opus-5");
  });
});

describe("buildReportModel disclosures", () => {
  it("carries each disclosure exactly once, in the field renderers must read it from", () => {
    const m = buildReportModel(
      changeset({
        untrackedCount: 2,
        files: [
          {
            path: "gone.ts",
            status: "deleted",
            hunks: [{ oldStart: 1, oldLines: 4, newStart: 0, newLines: 0 }],
            symbols: [],
          },
        ],
      }),
      [finding()],
      { warnings: ["the surfaceAnalyzer analyzer failed"], suppressed: 3 },
    );
    expect(m.notes.some((n) => n.includes("surfaceAnalyzer"))).toBe(true);
    expect(m.notes.some((n) => n.includes("untracked"))).toBe(true);
    expect(m.filterNote).toContain("3");
    // The filter note is not a shortfall and must not sit among the notes.
    expect(m.notes.some((n) => n.includes("suppressed"))).toBe(false);
    // The deleted-file note is coverage, not a shortfall: the HTML report
    // keeps it out of the partial-review banner so routine deletions cannot
    // teach readers to skip it, and the model preserves that distinction.
    expect(m.coverageNote).toContain("gone.ts");
    expect(m.notes.some((n) => n.includes("deleted"))).toBe(false);
  });

  it("keeps the citation distribution out of the notes, so a complete sweep is not called partial", () => {
    // The third disclosure that describes a result rather than a shortfall.
    // A sweep that checked everything it set out to check is not a partial
    // review, and a banner firing on every sweep is one a reader learns to
    // skip — the reasoning the filter and coverage notes are kept out for.
    const m = buildReportModel(
      changeset({}),
      [
        finding({ id: "citation_rot:docs/a.md:3:x", file: "docs/a.md" }),
        finding({ id: "citation_rot:docs/b.md:9:y", file: "docs/b.md" }),
      ],
      { warnings: [], citationSweep: true },
    );
    expect(m.distributionNote).toContain("docs/");
    expect(m.notes.some((n) => n.includes("docs/"))).toBe(false);
    expect(m.notes).toHaveLength(0);
  });

  it("describes no distribution when citations were not swept, only checked against the change", () => {
    // Default mode scopes citations to files the range touched, so there are
    // few of them and their spread says nothing. The note is for the audit.
    const m = buildReportModel(
      changeset({}),
      [finding({ id: "citation_rot:docs/a.md:3:x", file: "docs/a.md" })],
      { warnings: [] },
    );
    expect(m.distributionNote).toBeUndefined();
  });

  it("words the untracked note as both surfaces print it today", () => {
    const m = buildReportModel(changeset({ untrackedCount: 2 }), [], { warnings: [] });
    expect(m.notes).toContain(
      "2 untracked files not reviewed — git diff does not include them.",
    );
    const one = buildReportModel(changeset({ untrackedCount: 1 }), [], { warnings: [] });
    expect(one.notes).toContain(
      "1 untracked file not reviewed — git diff does not include them.",
    );
  });

  it("discloses files no analyzer reported on, as coverage rather than a shortfall", () => {
    // urtext ran its whole pipeline; a diff it has no analyzer for is scope,
    // not a partial review. Same channel as the deleted-file note, and kept
    // out of `notes` for the same reason.
    const m = buildReportModel(
      changeset({
        files: [
          { path: "src/a.ts", status: "modified", hunks: [], symbols: [] },
          { path: "package.json", status: "modified", hunks: [], symbols: [] },
        ],
      }),
      [finding()],
      { warnings: [] },
    );
    expect(m.unanalyzedNote).toContain("package.json");
    expect(m.unanalyzedNote).toContain("1 of 2 changed files");
    expect(m.notes.some((n) => n.includes("package.json"))).toBe(false);
  });

  it("composes no such note when every changed file is TypeScript", () => {
    const m = buildReportModel(
      changeset({
        files: [{ path: "src/a.ts", status: "modified", hunks: [], symbols: [] }],
      }),
      [finding()],
      { warnings: [] },
    );
    expect(m.unanalyzedNote).toBeUndefined();
  });

  it("omits every optional disclosure when there is nothing to disclose", () => {
    const m = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(m.notes).toEqual([]);
    expect(m.coverageNote).toBeUndefined();
    expect(m.unanalyzedNote).toBeUndefined();
    expect(m.filterNote).toBeUndefined();
    const zero = buildReportModel(changeset(), [], { warnings: [], suppressed: 0 });
    expect(zero.filterNote).toBeUndefined();
  });
});

describe("buildReportModel findings", () => {
  it("composes the headline as location — title, marking a before-side anchor", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "guard_removed:old.ts:119:run:if",
          file: "old.ts",
          line: 119,
          title: "an if guard was removed from run",
          evidence: [
            { file: "old.ts", line: 119, excerpt: "if (x) return;", side: "before" },
          ],
        }),
      ],
      { warnings: [] },
    );
    const f = m.findings[0];
    expect(plainText(f.headline)).toBe(
      "old.ts:119 (before) — an if guard was removed from run",
    );
    expect(f.side).toBe("before");
    expect(f.evidence[0].side).toBe("before");
  });

  it("leaves an after-side anchor unmarked", () => {
    const m = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(plainText(m.findings[0].headline)).toBe(
      "src/a.ts:3 — introduces a network effect",
    );
    expect(m.findings[0].side).toBeUndefined();
  });

  it("carries every evidence ref uncapped", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          evidence: [
            { file: "a.ts", line: 3, excerpt: "fetch(one);" },
            { file: "a.ts", line: 7, excerpt: "fetch(two);" },
            { file: "a.ts", line: 9, excerpt: "fetch(three);" },
          ],
        }),
      ],
      { warnings: [] },
    );
    expect(m.findings[0].evidence.map((e) => plainText(e.excerpt))).toEqual([
      "fetch(one);",
      "fetch(two);",
      "fetch(three);",
    ]);
  });

  it("moves model-tier prose into the attributed model note, leaving no bare body", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "claim:0:m1",
          tier: "model",
          body: "The retry loop can now hammer the endpoint.",
          evidence: [],
        }),
      ],
      { model: "claude-opus-5", warnings: [] },
    );
    const f = m.findings[0];
    expect(f.body).toEqual([]);
    expect(plainText(f.modelNote!.text)).toBe(
      "The retry loop can now hammer the endpoint.",
    );
    expect(f.modelNote?.model).toBe("claude-opus-5");
    expect(f.modelNote?.caution).toContain("Nothing mechanical corroborates this");
  });

  it("attributes model-tier prose to the unnamed-model fallback when no name was recorded", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ tier: "model", evidence: [] })],
      { warnings: [] },
    );
    expect(m.findings[0].modelNote?.model).toBe(UNNAMED_MODEL);
  });

  it("attaches a claim's reasoning as an attributed model note beside the analyzer body", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          tier: "inferred",
          claim: { summary: "s", reasoning: "This effect is on a hot request path." },
        }),
      ],
      { model: "claude-opus-5", warnings: [] },
    );
    const f = m.findings[0];
    expect(f.body.map(plainText)).toEqual([
      "This file previously had no network effect. It now does, at one site.",
    ]);
    expect(plainText(f.modelNote!.text)).toBe("This effect is on a hot request path.");
    expect(f.modelNote?.model).toBe("claude-opus-5");
    expect(f.modelNote?.caution).toContain("analyzer");
  });

  it("gives a claim-free analyzer finding no model note", () => {
    const m = buildReportModel(changeset(), [finding()], {
      model: "claude-opus-5",
      warnings: [],
    });
    expect(m.findings[0].modelNote).toBeUndefined();
  });
});

describe("buildReportModel reach", () => {
  const site = (line: number) => ({ file: "caller.ts", line, excerpt: `use(${line});` });

  it("caps reach sites as the HTML report does and counts the overflow", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          reach: {
            references: 40,
            sites: [site(1), site(2), site(3), site(4), site(5), site(6), site(7)],
          },
        }),
      ],
      { warnings: [] },
    );
    const r = m.findings[0].reach;
    expect(r?.references).toBe(40);
    expect(r?.sites).toHaveLength(5);
    expect(r?.overflow).toBe(2);
  });

  it("reports zero overflow when every collected site is shown", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ reach: { references: 3, sites: [site(1), site(2), site(3)] } })],
      { warnings: [] },
    );
    const r = m.findings[0].reach;
    expect(r?.sites).toHaveLength(3);
    expect(r?.overflow).toBe(0);
  });

  it("carries no reach view when the finding has no sites to show", () => {
    const none = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(none.findings[0].reach).toBeUndefined();
    const empty = buildReportModel(
      changeset(),
      [finding({ reach: { references: 3, sites: [] } })],
      { warnings: [] },
    );
    expect(empty.findings[0].reach).toBeUndefined();
  });
});

describe("buildReportModel beyond stated intent", () => {
  const marked = () => finding({ tier: "inferred", beyondIntent: true });

  it("carries the mark's words, composed here so no renderer composes them", () => {
    const m = buildReportModel(changeset(), [marked()], { warnings: [], model: "claude-opus-5" });
    expect(m.findings[0].beyondIntent).toBe(BEYOND_INTENT_MARK);
  });

  it("leaves the field absent on an unmarked finding", () => {
    const m = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(m.findings[0].beyondIntent).toBeUndefined();
  });

  it("states the legend exactly when a marked finding exists", () => {
    const withMark = buildReportModel(changeset(), [marked()], { warnings: [] });
    expect(withMark.beyondIntentLegend).toBe(BEYOND_INTENT_MEANING);
    const without = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(without.beyondIntentLegend).toBeUndefined();
  });

  it("keeps the legend out of notes, so a badge doing its job never trips partial-review copy", () => {
    const m = buildReportModel(changeset(), [marked()], { warnings: [] });
    expect(m.notes).toEqual([]);
    expect(m.notes.some((n) => n.includes("beyond stated intent"))).toBe(false);
    expect(m.filterNote).toBeUndefined();
  });

  it("never puts the mark on a verified finding view", () => {
    const m = buildReportModel(
      changeset(),
      [finding(), marked(), finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true })],
      { warnings: [] },
    );
    for (const view of m.findings) {
      if (view.tier === "verified") expect(view.beyondIntent).toBeUndefined();
    }
    expect(m.findings.filter((f) => f.beyondIntent).length).toBe(2);
  });
});

describe("per-kind guidance", () => {
  it("answers for a grouped finding as the kind its members were", () => {
    // A group's id is no member's, so a lookup keyed on the raw prefix finds
    // nothing for it. That is the case where saying the guidance once matters
    // most: grouping happens when a file has several findings of one kind, so
    // the reader who most needs to know what the kind means is the one whose
    // review has a group in it.
    const m = buildReportModel(
      changeset(),
      [
        finding({ id: "export_added_group:a.ts" }),
        finding({ id: "signature_changed_group:b.ts" }),
        finding({ id: "blast_radius:c.ts:helper" }),
        // A second finding of a kind already noted, ungrouped and in another
        // file: the note is about the kind, so it is still said once.
        finding({ id: "export_added:d.ts:one" }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([
      KIND_NOTES.export_added,
      KIND_NOTES.signature_changed,
      KIND_NOTES.blast_radius,
    ]);
  });

  it("answers for a kind grouped by a pass that does not exist yet", () => {
    // The rule is the grouping suffix, not a list of today's two group
    // prefixes: a pass that folds a file's reach rows tomorrow would produce
    // `blast_radius_group:` ids, and a list would silently drop the note for
    // them — which is the defect this describe block exists to fix, waiting
    // to happen again. A kind whose own name ends in the suffix is answered
    // as itself instead of being stripped; nothing in `FactKind` is named
    // that way today, so only `kindOf`'s own reasoning covers it.
    const m = buildReportModel(changeset(), [finding({ id: "blast_radius_group:a.ts" })], {
      warnings: [],
    });
    expect(m.kindNotes).toEqual([KIND_NOTES.blast_radius]);
  });

  it("says nothing about a kind that carries no guidance", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ id: "guard_removed:a.ts:9:run:if" }), finding({ id: "claim:0:m1", tier: "model" })],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([]);
  });
});

describe("the per-kind guidance reaches every surface", () => {
  // Same contract as the distribution note below, and pinned for the same
  // reason: these sentences left the finding bodies to be said once, and a
  // surface that never reads `kindNotes` now prints nothing where it used to
  // print the guidance on every finding. The PDF's half of this is in
  // `test/report/pdf.test.ts`, "prints each kind's guidance once".
  const findings = [finding({ id: "export_added_group:a.ts", file: "a.ts" })];
  const note = KIND_NOTES.export_added;

  it("prints a kind's guidance in the terminal, the Markdown, and the HTML", () => {
    // One model, three surfaces — expressible only now, and the stronger
    // claim: three separately built models could agree merely because they
    // were built the same way, while this pins that every surface reads the
    // same instance.
    const m = buildReportModel(changeset(), findings, { warnings: [] });
    expect(renderTerminal(m)).toContain(note);
    expect(renderMarkdown(m)).toContain(note);
    expect(renderHtml(m)).toContain(note);
  });
});

describe("the distribution note reaches every surface", () => {
  // The model carrying a disclosure is half the contract; a renderer that
  // drops it silently is the other half, and nothing pinned that. `filterNote`
  // has per-surface tests for exactly this reason — a note only a reader of
  // one surface sees is a note the other three lie by omitting.
  const swept = () =>
    buildReportModel(
      changeset({}),
      [
        finding({ id: "citation_rot:docs/a.md:3:x", file: "docs/a.md" }),
        finding({ id: "citation_rot:src/b.ts:9:y", file: "src/b.ts" }),
      ],
      { warnings: [], citationSweep: true },
    );

  it("prints the note in the terminal, the Markdown, and the HTML", () => {
    const m = swept();
    const note = m.distributionNote ?? "";
    expect(note).not.toBe("");

    // Rendered through each surface's own entry point rather than by reading
    // the model back, so a renderer that never consults the field fails. One
    // model reaches all three: every surface takes one now, so a second build
    // of the same fixture would only be a chance for the three to diverge.
    const terminal = renderTerminal(m);
    expect(terminal).toContain("Citations:");

    const md = renderMarkdown(m);
    expect(md).toContain("Citations:");

    const html = renderHtml(m);
    expect(html).toContain("Citations:");
    // And it must not be inside the partial-review banner on any of them.
    expect(html).not.toMatch(/This review is partial[\s\S]{0,200}Citations:/);
  });
});

describe("buildReportModel intent-gap index", () => {
  it("puts fact-backed entries before standalone ones, against findings order", () => {
    // `findings` sorts band before score, and a standalone claim lands in the
    // defect band while `export_added` is a context kind — so in `findings`
    // the claim comes first. The index must invert that. A fixture using a
    // defect-band fact-backed finding would pass under this rule and under
    // the retracted filter-in-place one, and so would prove nothing.
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "claim:0:c1",
          tier: "model",
          file: "src/sync.ts",
          line: 64,
          title: "retry loop may not terminate",
          score: 3,
          evidence: [],
          beyondIntent: true,
        }),
        finding({
          id: "export_added:src/admin.ts:handler",
          tier: "inferred",
          file: "src/admin.ts",
          line: 88,
          title: "handler is newly exported",
          score: 40,
          beyondIntent: true,
        }),
      ],
      { warnings: [] },
    );
    expect(m.intentGap.map((e) => e.id)).toEqual([
      "export_added:src/admin.ts:handler",
      "claim:0:c1",
    ]);
  });

  it("is an empty array, not absent, when nothing is marked", () => {
    const m = buildReportModel(changeset(), [finding()], { warnings: [] });
    expect(m.intentGap).toEqual([]);
  });

  it("preserves findings order within each pass", () => {
    // `evidence: undefined` would override the fixture default rather than
    // fall back to it, so the empty array is spread in only for model tier.
    const mk = (id: string, tier: Tier, score: number) =>
      finding({ id, tier, score, beyondIntent: true, ...(tier === "model" ? { evidence: [] } : {}) });
    const m = buildReportModel(
      changeset(),
      [
        mk("effect_added:a.ts:network", "inferred", 60),
        mk("claim:0:c1", "model", 3),
        mk("guard_removed:b.ts:auth", "inferred", 50),
        mk("claim:0:c2", "model", 2),
      ],
      { warnings: [] },
    );
    expect(m.intentGap.map((e) => e.id)).toEqual([
      "effect_added:a.ts:network",
      "guard_removed:b.ts:auth",
      "claim:0:c1",
      "claim:0:c2",
    ]);
  });

  it("labels a fact-backed entry with its kind and a standalone one with its summary", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({ id: "guard_removed:b.ts:auth", tier: "inferred", beyondIntent: true }),
        finding({
          id: "claim:0:c1",
          tier: "model",
          title: "retry loop may not terminate",
          evidence: [],
          beyondIntent: true,
        }),
      ],
      { warnings: [] },
    );
    expect(plainText(m.intentGap[0].label)).toBe("guard_removed");
    expect(plainText(m.intentGap[1].label)).toBe("retry loop may not terminate");
  });

  it("labels a group with the group finding's title, not its stripped member kind", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "export_added_group:src/api.ts",
          tier: "inferred",
          title: "7 exports added in src/api.ts",
          beyondIntent: true,
        }),
      ],
      { warnings: [] },
    );
    expect(plainText(m.intentGap[0].label)).toBe("7 exports added in src/api.ts");
  });

  it("carries label as segments, so a bidirectional override cannot reach a surface raw", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "claim:0:c1",
          tier: "model",
          title: `drops retries${RLO}for admins`,
          evidence: [],
          beyondIntent: true,
        }),
      ],
      { warnings: [] },
    );
    expect(plainText(m.intentGap[0].label)).toContain("[U+202E]");
    expect(plainText(m.intentGap[0].label)).not.toContain(RLO);
  });

  it("labels a concealing character in the path, not just in the label", () => {
    // The index carries `file` as its own field, so the headline's
    // segmentation does not cover it. `toFindingView` labels the path for
    // this reason; an index that skipped it would be a new leak of exactly
    // the kind the concealment charter exists to prevent.
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "guard_removed:src/auth.ts:session",
          tier: "inferred",
          file: `src/${RLO}auth.ts`,
          beyondIntent: true,
        }),
      ],
      { warnings: [] },
    );
    expect(m.intentGap[0].file).toContain("[U+202E]");
    expect(m.intentGap[0].file).not.toContain(RLO);
  });

  it("attributes the index exactly when it carries a standalone claim", () => {
    const withClaim = buildReportModel(
      changeset(),
      [finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true })],
      { warnings: [], model: "claude-opus-5" },
    );
    expect(withClaim.intentGapAttribution).toContain("claude-opus-5");
    expect(withClaim.intentGapAttribution).toContain(MODEL_CAUTION_STANDALONE);

    // A fact-backed entry's label is a kind, not model prose, so it needs no
    // such caution and must not summon one.
    const withoutClaim = buildReportModel(
      changeset(),
      [finding({ id: "guard_removed:b.ts:auth", tier: "inferred", beyondIntent: true })],
      { warnings: [], model: "claude-opus-5" },
    );
    expect(withoutClaim.intentGapAttribution).toBeUndefined();
  });

  it("names an unrecorded model rather than dropping attribution", () => {
    // Visibly incomplete attribution beats absent attribution.
    const m = buildReportModel(
      changeset(),
      [finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true })],
      { warnings: [] },
    );
    expect(m.intentGapAttribution).toContain(UNNAMED_MODEL);
  });

  it("produces no verified index entry, through the real reconcile path", () => {
    // Not hand-built findings. This repository's banding bug shipped because
    // a unit test over `rank` stayed green while the path a review actually
    // takes was never exercised, so at least one test here must drive
    // reconcile -> buildReportModel.
    const facts = [
      makeFact({
        id: "guard_removed:src/auth.ts:session",
        kind: "guard_removed",
        detail: {},
        evidence: [{ file: "src/auth.ts", line: 142, excerpt: "if (!session) return;" }],
      }),
      // A fact no claim explains, so reconcile produces a `verified` finding
      // that is not marked. Without it the assertion below is vacuous: a
      // fixture containing no verified finding cannot demonstrate that none
      // reaches the index, and the test passes even if the index collects
      // every finding regardless of its mark.
      makeFact({
        id: "effect_added:src/sync.ts:network",
        kind: "effect_added",
        detail: {},
        evidence: [{ file: "src/sync.ts", line: 31, excerpt: "return fetch(url);" }],
      }),
    ];
    // Annotated, not inferred. An untyped array literal widens `beyondIntent`
    // to `boolean` against `Claim.beyondIntent?: true`, which vitest would
    // transpile happily and `tsc --noEmit` in CI would reject.
    const claims: Claim[] = [
      {
        id: "c1",
        file: "src/auth.ts",
        line: 142,
        summary: "the session guard is gone",
        reasoning: "Requests now reach the handler unauthenticated.",
        severity: 0.9,
        correspondsTo: "guard_removed:src/auth.ts:session",
        beyondIntent: true,
      },
    ];
    const m = buildReportModel(changeset(), reconcile(facts, claims), {
      warnings: [],
      model: "claude-opus-5",
    });
    // The premise: a verified finding exists in this review, and exactly one
    // finding is marked.
    expect(m.findings.some((f) => f.tier === "verified")).toBe(true);
    expect(m.intentGap).toHaveLength(1);
    // Pins the tier chain rather than the fixture builder: a marked finding
    // reaches a fact only through the claim-attachment path, which forces
    // `inferred`, so "marked and verified" is unreachable by construction.
    for (const e of m.intentGap) expect(e.tier).not.toBe("verified");
  });

  it("points at every marked finding exactly once, and drops none from findings", () => {
    const all = [
      finding({ id: "effect_added:a.ts:network", tier: "inferred", beyondIntent: true }),
      finding({ id: "guard_removed:b.ts:auth", tier: "verified" }),
      finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true }),
    ];
    const m = buildReportModel(changeset(), all, { warnings: [] });
    const ids = m.intentGap.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.findings).toHaveLength(3);
    for (const id of ids) expect(m.findings.some((f) => f.id === id)).toBe(true);
  });
});

describe("dependency routing", () => {
  it("routes dependency findings to the narrative lens under the dependency subject", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "dependency_added:package.json:dependencies:left-pad",
          tier: "verified",
          file: "package.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.findings[0].lens).toBe("narrative");
    expect(m.findings[0].subject).toBe("dependency");
  });
});

describe("dependency kind notes", () => {
  it("states the manifest-versus-lockfile note once for any mix of dependency kinds", () => {
    // The note is shared by three kinds; a kind-keyed dedup would print it
    // once per kind present.
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "dependency_added:package.json:dependencies:a",
          tier: "verified",
          file: "package.json",
        }),
        finding({
          id: "dependency_removed:package.json:dependencies:b",
          tier: "verified",
          file: "package.json",
        }),
      ],
      { warnings: [] },
    );
    const depNotes = m.kindNotes.filter((n) => n.includes("lockfile decides"));
    expect(depNotes).toHaveLength(1);
  });
});

describe("lockfile kind notes", () => {
  it("prints the shared lockfile note once across several lockfile kinds", () => {
    // The note is shared by four kinds; a kind-keyed dedup would print it
    // once per kind present.
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "lockfile_out_of_sync:package-lock.json:dependencies:a",
          tier: "verified",
          file: "package-lock.json",
        }),
        finding({
          id: "lockfile_tree_changed:package-lock.json",
          tier: "verified",
          file: "package-lock.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes.filter((n) => n.startsWith("Lockfile findings"))).toHaveLength(1);
  });

  // The test above only ever mixes two of the four kinds LOCKFILE_NOTE is
  // keyed under, in one review — enough to prove the note dedupes, not
  // enough to prove all four mappings still exist. Deleting
  // `lockfile_version_stale: LOCKFILE_NOTE` from `KIND_NOTES` left the whole
  // suite green until these four were added: each finding here appears
  // alone, with no sibling finding of a different lockfile kind present to
  // supply the note in its place, so dropping any one kind's mapping
  // silences the note in exactly the test for that kind.
  it("states the shared lockfile note for a lockfile_out_of_sync finding on its own", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "lockfile_out_of_sync:package-lock.json:dependencies:a",
          tier: "verified",
          file: "package-lock.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([
      "Lockfile findings report what package-lock.json records, which is not always what package.json declares.",
    ]);
  });

  it("states the shared lockfile note for a dependency_resolved_changed finding on its own", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "dependency_resolved_changed:package-lock.json:a",
          tier: "verified",
          file: "package-lock.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([
      "Lockfile findings report what package-lock.json records, which is not always what package.json declares.",
    ]);
  });

  it("states the shared lockfile note for a lockfile_version_stale finding on its own", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "lockfile_version_stale:package-lock.json",
          tier: "verified",
          file: "package-lock.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([
      "Lockfile findings report what package-lock.json records, which is not always what package.json declares.",
    ]);
  });

  it("states the shared lockfile note for a lockfile_tree_changed finding on its own", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          id: "lockfile_tree_changed:package-lock.json",
          tier: "verified",
          file: "package-lock.json",
        }),
      ],
      { warnings: [] },
    );
    expect(m.kindNotes).toEqual([
      "Lockfile findings report what package-lock.json records, which is not always what package.json declares.",
    ]);
  });
});
