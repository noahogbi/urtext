import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import {
  baselineReadsCappedNote,
  blameUnavailableNote,
  citationsCappedNote,
  citingFilesCappedNote,
  shallowRepositoryNote,
} from "../../src/analyze/citations.js";
import { INTENT_ABSENT_NOTE, intentTruncatedNote } from "../../src/interpret/index.js";
import { renderHtml } from "../../src/report/html.js";
import { renderMarkdown } from "../../src/report/markdown.js";
import {
  BEYOND_INTENT_MEANING,
  buildReportModel,
  type ReportModel,
} from "../../src/report/model.js";
import { renderPdf } from "../../src/report/pdf.js";
import { renderTerminal } from "../../src/report/terminal.js";
import { toFinding } from "../../src/score/index.js";
import { WORKTREE, type Changeset, type Finding } from "../../src/types.js";

/**
 * The words urtext must never say in its own voice. urtext detects a
 * divergence between what a change claims about itself and what it does — not
 * between what a person sanctioned and what was delivered — and this
 * vocabulary would assert an authority the tool does not have.
 */
const FORBIDDEN = [
  "unsanctioned",
  "unauthorized",
  "approved",
  "permission",
  "forbidden",
  "allowed",
];

const changeset: Changeset = {
  range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
  files: [
    {
      path: "a.ts",
      status: "modified",
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }],
      symbols: [],
    },
  ],
};

/**
 * Every claim's prose is deliberately neutral, so a hit is provably urtext's
 * own copy rather than the model's. The warnings carry the intent disclosure
 * copy too: it is urtext's voice in exactly the same sense the badge is.
 */
const findings: Finding[] = [
  {
    id: "effect_added:a.ts:network",
    tier: "inferred",
    file: "a.ts",
    line: 3,
    title: "introduces a network effect",
    body: "This file previously had no network effect. It now does, at one site.",
    score: 60,
    evidence: [{ file: "a.ts", line: 3, excerpt: "return fetch(url);" }],
    claim: { summary: "reaches the network", reasoning: "The call runs on every request." },
    beyondIntent: true,
  },
  {
    // A dependency finding with the longest body (runtime map), so the new
    // titles, bodies, and the shared kind note render on every surface the
    // guard scans — the guard is total over copy only if the fixture
    // produces it.
    id: "dependency_added:package.json:dependencies:left-pad",
    tier: "verified",
    file: "package.json",
    line: 12,
    title: "adds left-pad to dependencies",
    body: "package.json now declares `left-pad` (`^1.3.0`) in `dependencies`. A runtime dependency installs for every consumer; its install scripts run whether or not anything imports it.",
    score: 55,
    evidence: [{ file: "package.json", line: 12, excerpt: '"left-pad": "^1.3.0"' }],
  },
  {
    id: "claim:0:c1",
    tier: "model",
    file: "a.ts",
    line: 9,
    title: "may drop retries",
    body: "The retry loop looks removed.",
    score: 2,
    evidence: [],
    beyondIntent: true,
  },
];

const meta = {
  model: "claude-opus-5",
  warnings: [INTENT_ABSENT_NOTE, intentTruncatedNote(2)],
  suppressed: 1,
};

const model = buildReportModel(changeset, findings, meta);

/**
 * Whitespace collapsed before the scan: pdfkit wraps long lines at word
 * boundaries and unpdf renders each wrap as a newline, so a forbidden word
 * split across a wrap would otherwise escape the match. No other
 * transformation, and no exemptions: the guard is total by controller ruling
 * — the meaning sentence was reworded rather than excused.
 */
function scannable(rendered: string): string {
  return rendered.replace(/\s+/g, " ");
}

async function pdfText(m: ReportModel = model): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(await renderPdf(m)));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** Every surface, rendered from the one marked fixture, named for the failure message. */
async function surfaces(m: ReportModel = model): Promise<Array<[string, string]>> {
  return [
    ["terminal", renderTerminal(m)],
    ["html", renderHtml(m)],
    ["markdown", renderMarkdown(m)],
    ["pdf", await pdfText(m)],
  ];
}

describe("copy guard", () => {
  it("says none of the six words on any surface", async () => {
    for (const [name, rendered] of await surfaces()) {
      const text = scannable(rendered).toLowerCase();
      for (const word of FORBIDDEN) {
        expect(text.includes(word), `${name} says "${word}"`).toBe(false);
      }
    }
  });

  it("would catch a planted word, so a green scan means the surfaces are clean", () => {
    // Proves the scan itself works: a fixture that plants one of the six
    // words must be caught. (pdfkit wraps at word boundaries, so collapse
    // never has to rejoin a word split mid-way.)
    const planted = scannable("this change\nwas not app" + "roved").toLowerCase();
    expect(planted.includes("app" + "roved")).toBe(true);
  });

  it("scans surfaces that actually carry the badge copy, so a clean scan is not an empty one", async () => {
    // The other half of the same proof. A scan of four surfaces none of
    // which rendered the legend would pass while saying nothing about the
    // copy the guard exists for — so each surface is checked to contain the
    // very sentence under scrutiny, collapsed the same way the scan
    // collapses it.
    for (const [name, rendered] of await surfaces()) {
      expect(scannable(rendered).includes(BEYOND_INTENT_MEANING), `${name} omits the legend`).toBe(
        true,
      );
    }
  });
});

/**
 * The words urtext must never say about a citation. A rotted citation is not
 * wrong documentation: urtext has no idea what the author meant, and this
 * vocabulary would assert a judgment about the prose that nothing here
 * supports.
 *
 * "lies" is matched on a word boundary and the other seven as substrings:
 * "applies", "relies", and "families" are ordinary English this codebase's
 * copy is entitled to use, and a substring scan would ban them by accident.
 */
const CITATION_FORBIDDEN = [
  "wrong",
  "incorrect",
  "outdated",
  "stale",
  "obsolete",
  "misleading",
  "broken",
];

const citationFindings: Finding[] = (
  ["missing_file", "line_out_of_range", "quote_absent", "content_drift"] as const
).map((rot, i) =>
  toFinding({
    id: `citation_rot:docs/a.md:${i + 1}:${rot}`,
    kind: "citation_rot",
    file: "docs/a.md",
    line: i + 1,
    detail: {
      rot,
      citedFile: "src/a.ts",
      citedLine: 1,
      lineCount: 1,
      quote: "keeps the door shut",
      was: "export const limit = 1;",
      now: "export const limit = 99;",
      baseline: "3f2a1c9",
      citedTouched: true,
    },
    // Neutral fixture prose, so a hit is provably urtext's own copy.
    evidence: [{ file: "docs/a.md", line: i + 1, excerpt: "The limit is set here.", side: "after" }],
  }),
);

/**
 * The disclosure sentences citation checking can emit, carried as warnings so
 * the scan covers the copy this feature adds outside the findings too.
 */
const citationMeta = {
  warnings: [
    citingFilesCappedNote(1, 2),
    citationsCappedNote(1, 2),
    baselineReadsCappedNote(1),
    blameUnavailableNote(1, "fatal: no such ref"),
    shallowRepositoryNote(),
  ],
};

const citationModel = buildReportModel(changeset, citationFindings, citationMeta);

async function citationPdfText(): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(await renderPdf(citationModel)));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** The same four surfaces, rendered from the citation fixture. */
async function citationSurfaces(): Promise<Array<[string, string]>> {
  return [
    ["terminal", renderTerminal(citationModel)],
    ["html", renderHtml(citationModel)],
    ["markdown", renderMarkdown(citationModel)],
    ["pdf", await citationPdfText()],
  ];
}

describe("citation copy guard", () => {
  it("says none of the eight words on any surface", async () => {
    for (const [name, rendered] of await citationSurfaces()) {
      const text = scannable(rendered).toLowerCase();
      for (const word of CITATION_FORBIDDEN) {
        expect(text.includes(word), `${name} says "${word}"`).toBe(false);
      }
      expect(/\blies\b/.test(text), `${name} says "lies"`).toBe(false);
    }
  });

  it("scans surfaces that actually carry the citation copy, so a clean scan is not an empty one", async () => {
    for (const [name, rendered] of await citationSurfaces()) {
      expect(scannable(rendered).includes("no longer reads the same"), `${name} omits the copy`).toBe(
        true,
      );
    }
  });
});


describe("coverage disclosures reach every surface", () => {
  // `coverageNote` is printed by four renderers, not the two its own module
  // doc once claimed. A disclosure wired to some of them is the cross-surface
  // drift `coverage.ts` exists to prevent — one report telling a reader what
  // went unanalyzed and another staying silent about the same diff.
  const mixed = buildReportModel(
    {
      range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
      files: [
        { path: "a.ts", status: "modified", hunks: [], symbols: [] },
        // Not package.json: the fixture now carries a verified dependency
        // finding anchored there, and the unanalyzed-files rule correctly
        // drops a file an analyzer reported on — which would empty the very
        // note this test pins across surfaces. A workflow file is what no
        // analyzer reports on.
        { path: "ci.yml", status: "modified", hunks: [], symbols: [] },
      ],
    },
    findings,
    meta,
  );

  it("states what no analyzer reported on, identically on all four", async () => {
    expect(mixed.unanalyzedNote).toBeDefined();
    for (const [name, rendered] of await surfaces(mixed)) {
      expect(
        scannable(rendered).includes(scannable(mixed.unanalyzedNote ?? "")),
        `${name} omits the unanalyzed-files disclosure`,
      ).toBe(true);
    }
  });
});

describe("the intent-gap index", () => {
  // Four surfaces, not five: `surfaces()` renders terminal, HTML, Markdown
  // and PDF. `--json` is covered in test/cli.test.ts, where the model-keys
  // guard also watches it.
  it("appears on all four rendered surfaces", async () => {
    expect(model.intentGap.length).toBeGreaterThan(0);
    for (const [name, rendered] of await surfaces()) {
      const text = scannable(rendered);
      // Two apostrophe-free substrings rather than the whole heading: HTML
      // escapes `'` to `&#39;`, so asserting the raw sentence would fail a
      // correct implementation on that surface. Together these still pin
      // both the wording and the count.
      expect(text.includes("Not described by this change"), `${name} omits the index`).toBe(true);
      expect(
        text.includes(`messages (${model.intentGap.length})`),
        `${name} omits the index count`,
      ).toBe(true);
    }
  });

  it("carries its attribution on every surface, since the fixture holds a model claim", async () => {
    expect(model.intentGapAttribution).toBeDefined();
    for (const [name, rendered] of await surfaces()) {
      expect(
        scannable(rendered).includes(scannable(model.intentGapAttribution ?? "")),
        `${name} omits the index attribution`,
      ).toBe(true);
    }
  });
});
