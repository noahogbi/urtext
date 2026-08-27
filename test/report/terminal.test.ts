import { describe, expect, it } from "vitest";
import { BEYOND_INTENT_MEANING } from "../../src/report/model.js";
import { renderTerminal } from "../../src/report/terminal.js";
import { toFinding } from "../../src/score/index.js";
import { WORKTREE, type Changeset, type Finding } from "../../src/types.js";

const changeset: Changeset = {
  range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
  files: [
    { path: "a.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }], symbols: [] },
    { path: "b.ts", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }], symbols: [] },
  ],
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  tier: "verified",
  file: "a.ts",
  line: 3,
  title: "introduces a network effect",
  body: "This file previously had no network effect. It now does, at one site.",
  score: 60,
  evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
  ...over,
});

describe("renderTerminal before-side evidence", () => {
  const removal = finding({
    file: "old.ts",
    line: 119,
    title: "an if guard was removed from diff",
    evidence: [
      { file: "old.ts", line: 119, excerpt: "if (afterNames.has(d.name)) continue;", side: "before" },
    ],
  });

  it("marks a before-side line so the reader does not click through to an unrelated line", () => {
    const out = renderTerminal(changeset, [removal]);
    expect(out).toContain("old.ts:119 (before)");
    // Both the headline and the evidence line: they name the same place.
    expect(out.match(/old\.ts:119 \(before\)/g)).toHaveLength(2);
  });

  it("leaves after-side evidence unannotated", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("a.ts:3");
    expect(out).not.toContain("(before)");
  });

  it("prints a partial-review warning above the findings", () => {
    const out = renderTerminal(changeset, [finding()], undefined, [
      "the surfaceAnalyzer analyzer failed, so this review is partial: boom",
    ]);
    expect(out).toContain("surfaceAnalyzer analyzer failed");
    expect(out.indexOf("surfaceAnalyzer")).toBeLessThan(out.indexOf("introduces a network"));
  });

  it("says nothing about analyzers when none failed", () => {
    expect(renderTerminal(changeset, [finding()])).not.toContain("partial");
  });
});

describe("renderTerminal", () => {
  it("shows the range label and file count", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("vs origin/main");
    expect(out).toContain("2 files");
  });

  it("shows tier counts", () => {
    const out = renderTerminal(changeset, [
      finding({ id: "a" }),
      finding({ id: "b", tier: "model" }),
    ]);
    expect(out).toContain("EVIDENCE");
    expect(out).toContain("1 verified");
    expect(out).toContain("1 model-only");
  });

  it("prints each finding with its location and tier badge", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("a.ts:3");
    expect(out).toContain("[verified]");
    expect(out).toContain("introduces a network effect");
  });

  it("names the file once, in the location prefix rather than the title", () => {
    const out = renderTerminal(changeset, [finding()]);
    const head = out.split("\n").find((l) => l.includes("introduces"))!;
    expect(head).toContain("a.ts:3 — introduces a network effect");
    expect(head.match(/a\.ts/g)).toHaveLength(1);
  });

  it("shows the source excerpt behind each finding", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("fetch(u);");
    expect(out).toContain("a.ts:3  fetch(u);");
  });

  it("shows a couple of evidence refs and counts the rest", () => {
    const out = renderTerminal(changeset, [
      finding({
        evidence: [
          { file: "a.ts", line: 3, excerpt: "fetch(one);" },
          { file: "a.ts", line: 7, excerpt: "fetch(two);" },
          { file: "a.ts", line: 9, excerpt: "fetch(three);" },
        ],
      }),
    ]);
    expect(out).toContain("fetch(one);");
    expect(out).toContain("fetch(two);");
    expect(out).not.toContain("fetch(three);");
    expect(out).toContain("… 1 more");
  });

  it("counts deletions as changed lines, not just insertions", () => {
    const deletionOnly: Changeset = {
      range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
      files: [
        {
          path: "a.ts",
          status: "modified",
          hunks: [{ oldStart: 4, oldLines: 3, newStart: 3, newLines: 0 }],
          symbols: [],
        },
      ],
    };
    const out = renderTerminal(deletionOnly, []);
    expect(out).toContain("3 lines changed");
    expect(out).not.toContain("0 lines changed");
  });

  it("says how many untracked files were left out", () => {
    const out = renderTerminal({ ...changeset, untrackedCount: 2 }, []);
    expect(out).toContain("2 untracked files not reviewed");
  });

  it("stays quiet about untracked files when there are none", () => {
    expect(renderTerminal(changeset, [])).not.toContain("untracked");
  });

  it("names deleted TypeScript files and what about them went unexamined", () => {
    const withDeletion: Changeset = {
      ...changeset,
      files: [
        ...changeset.files,
        {
          path: "gone.ts",
          status: "deleted",
          hunks: [{ oldStart: 1, oldLines: 4, newStart: 0, newLines: 0 }],
          symbols: [],
        },
      ],
    };
    const out = renderTerminal(withDeletion, []);
    expect(out).toContain("gone.ts");
    expect(out).toContain("1 deleted TypeScript file");
    expect(out).toContain("exports, callers, and guards are not analyzed");
    // `effectsAnalyzer` does read the before side of a deletion, so the note
    // must not tell the reader that nothing describes the file.
    expect(out).not.toContain("every analyzer skips");
  });

  it("says nothing about deleted files when none were deleted, and ignores a non-TypeScript deletion", () => {
    expect(renderTerminal(changeset, [])).not.toContain("deleted TypeScript");
    const deletedMarkdown: Changeset = {
      ...changeset,
      files: [{ path: "notes.md", status: "deleted", hunks: [], symbols: [] }],
    };
    expect(renderTerminal(deletedMarkdown, [])).not.toContain("deleted TypeScript");
  });

  it("says so plainly when nothing was found", () => {
    const out = renderTerminal(changeset, []);
    expect(out).toContain("No findings");
    expect(out).not.toContain("EVIDENCE");
  });

  it("includes the report path when one is given", () => {
    const out = renderTerminal(changeset, [finding()], ".urtext/review.html");
    expect(out).toContain(".urtext/review.html");
  });

  it("omits the report line when no path is given", () => {
    expect(renderTerminal(changeset, [finding()])).not.toContain("Full report");
  });

  it("prints the report path even when there are no findings", () => {
    // A genuinely clean review still writes a report; the reader needs to
    // be told where it went exactly when there is nothing else to read.
    const out = renderTerminal(changeset, [], ".urtext/review.html");
    expect(out).toContain("No findings");
    expect(out).toContain("Full report: .urtext/review.html");
  });

  it("prints one filter footnote when standalone reach rows were suppressed", () => {
    // Beside "No findings", so the two cannot be read together as "this
    // range is clean" — one row existed, and the filter removed it. The
    // copy describes the filter, never the code.
    const out = renderTerminal(changeset, [], undefined, [], undefined, 1);
    expect(out).toContain("Filtered: 1 finding suppressed (low-signal: single unclaimed reference).");

    const plural = renderTerminal(changeset, [finding()], undefined, [], undefined, 2);
    expect(plural).toContain("Filtered: 2 findings suppressed (low-signal: single unclaimed reference).");
  });

  it("prints no filter footnote when nothing was suppressed", () => {
    expect(renderTerminal(changeset, [finding()])).not.toContain("Filtered:");
    expect(renderTerminal(changeset, [], undefined, [], undefined, 0)).not.toContain("Filtered:");
  });
});

describe("renderTerminal model tiers", () => {
  const inferred = finding({
    tier: "inferred",
    claim: { summary: "s", reasoning: "This effect is on a hot request path." },
  });
  const modelOnly = finding({ id: "m1", tier: "model", evidence: [] });

  it("shows the model's reasoning beneath a finding that carries one", () => {
    const out = renderTerminal(changeset, [inferred], undefined, [], "claude-opus-5-20260101");
    expect(out).toContain("This effect is on a hot request path.");
  });

  it("says nothing extra for a finding with no claim attached", () => {
    const out = renderTerminal(changeset, [finding()], undefined, [], "claude-opus-5-20260101");
    expect(out).not.toContain("model:");
  });

  it("names the model in a provenance line when a finding is inferred or model-only", () => {
    const out = renderTerminal(changeset, [inferred], undefined, [], "claude-opus-5-20260101");
    expect(out).toContain("claude-opus-5-20260101");
    const out2 = renderTerminal(changeset, [modelOnly], undefined, [], "claude-opus-5-20260101");
    expect(out2).toContain("claude-opus-5-20260101");
  });

  it("omits the provenance line when every finding is verified", () => {
    const out = renderTerminal(changeset, [finding()], undefined, [], "claude-opus-5-20260101");
    expect(out).not.toContain("claude-opus-5-20260101");
  });

  it("omits the provenance line when no model name is given, even with model-tier findings", () => {
    const out = renderTerminal(changeset, [modelOnly]);
    expect(out).not.toContain("MODEL");
  });

  it("never prints model prose without its attribution", () => {
    // `inferred` carries a claim whose reasoning would otherwise print
    // regardless of `model` — the exact state this product must never
    // reach: prose a reader would read as machine-checked, with no machine
    // named. Both the provenance line and the per-finding reasoning line
    // must stay silent together, not just the line that happens to be
    // gated first.
    const out = renderTerminal(changeset, [inferred, modelOnly]);
    expect(out).not.toContain("MODEL");
    expect(out).not.toContain("model:");
    expect(out).not.toContain("This effect is on a hot request path.");
  });
});

describe("renderTerminal concealing characters", () => {
  // The terminal is the default surface, and the whole promise of a
  // `verified` finding is "here is the line, look at it yourself" — an
  // excerpt whose bytes display in a different order (bidi overrides) or
  // carry an invisible payload (zero-width, Tag block) breaks exactly that.
  // Same table and substitution the HTML report applies, from
  // `src/report/conceal.ts`.
  const RLO = "\u202E";
  const TAG_A = "\u{E0041}";
  const ZWSP = "\u200B";

  it("labels a bidi override in an evidence excerpt instead of obeying it", () => {
    const out = renderTerminal(changeset, [
      finding({
        evidence: [{ file: "a.ts", line: 3, excerpt: `const sneak = "a${RLO}b";` }],
      }),
    ]);
    expect(out).not.toContain(RLO);
    expect(out).toContain("[U+202E]");
  });

  it("labels concealing characters in titles and bodies", () => {
    const out = renderTerminal(changeset, [
      finding({
        title: `sneak${RLO} changed its signature`,
        body: `Payload${TAG_A} hidden${ZWSP} here.`,
      }),
    ]);
    expect(out).not.toContain(RLO);
    expect(out).not.toContain(TAG_A);
    expect(out).not.toContain(ZWSP);
    expect(out).toContain("[U+202E]");
    expect(out).toContain("[U+E0041]");
    expect(out).toContain("[U+200B]");
  });

  it("labels concealing characters in warnings and the model name", () => {
    const out = renderTerminal(
      changeset,
      [finding({ tier: "model", claim: undefined, evidence: [] })],
      undefined,
      [`warning with${RLO} an override`],
      `model${RLO}name`,
    );
    expect(out).not.toContain(RLO);
    expect(out.match(/\[U\+202E\]/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves ordinary output byte-identical", () => {
    const out = renderTerminal(changeset, [finding()], "path/to/report.html", ["a note"]);
    expect(out).toContain("a.ts:3 — introduces a network effect");
    expect(out).toContain("fetch(u);");
    expect(out).toContain("path/to/report.html");
  });

  it("never splits a surrogate pair at the excerpt truncation boundary", () => {
    // An astral character straddling the code-unit cut left a lone surrogate
    // that renders as U+FFFD. Truncation counts code points now, so the
    // 55th point — the first emoji — survives whole ahead of the ellipsis.
    const excerpt = "x".repeat(54) + "\u{1F600}\u{1F600}\u{1F600}";
    const out = renderTerminal(changeset, [
      finding({ evidence: [{ file: "a.ts", line: 3, excerpt }] }),
    ]);
    // No lone surrogate anywhere: strip well-formed pairs, then assert no
    // surrogate code unit is left over.
    const unpaired = /[\uD800-\uDFFF]/.test(
      out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
    );
    expect(unpaired).toBe(false);
    expect(out).toContain("\u{1F600}…");
  });
});

describe("renderTerminal beyond stated intent", () => {
  it("appends the mark after the tier badge and prints the legend once", () => {
    const out = renderTerminal(
      changeset,
      [finding({ tier: "inferred", beyondIntent: true, claim: { summary: "s", reasoning: "r" } })],
      undefined,
      [],
      "claude-opus-5",
    );
    expect(out).toContain("[inferred]  (beyond stated intent)");
    expect(out).toContain(BEYOND_INTENT_MEANING);
    expect(out.split(BEYOND_INTENT_MEANING)).toHaveLength(2);
    // Above the findings: the legend explains a badge the reader is about to
    // meet, so it cannot sit under the list.
    expect(out.indexOf(BEYOND_INTENT_MEANING)).toBeLessThan(out.indexOf("(beyond stated intent)"));
  });

  it("prints neither the mark nor the legend when no finding carries one", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).not.toContain("beyond stated intent");
  });
});

/**
 * One real citation finding, composed by `toFinding` rather than written out
 * here, so this surface is checked against the copy the scorer actually
 * produces and not against a restatement of it.
 */
const citationFinding = (): Finding =>
  toFinding({
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
      { file: "src/a.ts", line: 1, excerpt: "export const limit = 99;", side: "after" },
    ],
  });

describe("renderTerminal citation findings", () => {
  it("prints a citation finding's headline, body, and both evidence lines", () => {
    // Whitespace collapsed before the containment checks: this surface wraps
    // body paragraphs and pads its evidence lines, so a sentence asserted
    // verbatim could otherwise be split anywhere the wrap happened to land.
    const out = renderTerminal(changeset, [citationFinding()]).replace(/\s+/g, " ");
    expect(out).toContain("docs/a.md:1 — cites `src/a.ts:1`, which no longer reads the same");
    expect(out).toContain(
      "The citation still resolves to a line; it no longer resolves to the same content.",
    );
    expect(out).toContain("docs/a.md:1 The limit is set at src/a.ts:1.");
    expect(out).toContain("src/a.ts:1 export const limit = 99;");
  });
});
