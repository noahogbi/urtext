# Urtext Citation Rot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** urtext answers one new deterministic question about the repository's account of itself — *when this citing line was last written, this citation resolved; it does not resolve the same way now* — and reports it as a `verified` finding that names the citation and what no longer resolves, and nothing else.

**Architecture:** A new `src/analyze/citations.ts` is built in two halves. The pure half extracts citations from prose files and TypeScript comments: two regexes (a `path:line` form and a backticked-path-plus-quoted-phrase form), a fence mask, a URL mask, and its own copy of the comment leaf-walk that `test/comment-contract.test.ts` documents, extended with an unwrap that carries an offset map so a wrapped citation is reported at the line its path actually sits on. The git half finds candidate citing files (`git grep` in the default mode, `git ls-files` under `--citations`), dates each citing line with one memoized `git blame --line-porcelain` per file, and runs four rot tests — `missing_file`, `line_out_of_range`, `quote_absent`, `content_drift` — each gated on the citation having resolved at that baseline. `makeCitationsAnalyzer` wraps that engine as the fifth `Analyzer`; a new `citation_rot` fact kind reaches the existing scoring, report-model, and renderer machinery with one new weight, one new `Subject`, one lens-routing entry, one amended sentence in the HTML effects pane, and no new render surface at all.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, vitest, tsx. **No new dependency, runtime or dev.** Blame and grep go through the existing `git()` helper in `src/extract/git.ts` — same locale pinning, same buffer cap, same failure semantics. File reads go through `AnalysisContext.readAt`. Comment parsing uses the `typescript` package already in use. The TypeScript *program* is never built: this is the only one of the five analyzers that touches no compiler API.

**Spec:** `docs/superpowers/specs/2026-08-23-urtext-citation-rot-design.md` — the binding authority. Implementers read it before their task; where this plan and the spec disagree, the spec wins and the conflict is a ruling for the controller. Three places where the spec is silent or disagrees with itself are recorded in "Self-review notes → Ambiguities" below, each with the resolution this plan adopts and the reason.

**Predecessors:** `2026-08-15-urtext-diff-review-core.md` (PR #1), `2026-08-16-urtext-analyzers.md` (PR #2), `2026-08-16-urtext-interpretation.md` (PR #3), `2026-08-22-urtext-export-model.md` (PR #10), `2026-08-23-urtext-intent-comparison.md` (PR #11) — all merged. This is the sixth plan in the sequence.

## Global Constraints

- Node 20+, ESM only; relative imports carry `.js` extensions. TypeScript `strict: true` with `noUnusedLocals`/`noUnusedParameters`; no `any` in exported signatures.
- **The claim discipline, carried verbatim from the spec's "The claim, exactly".** Everything this feature emits must be exactly this sentence and no more:

  > When this citing line was last written, this citation resolved. It does not resolve the same way now.

  1. **The finding names the citation and what no longer resolves, never the correctness of the prose and never who caused it.** "This line cites `src/analyze/fact.ts:45`, which no longer reads the same" is the shape. "This documentation is wrong", "this comment is out of date", "this reference is stale" are not, in any surface, ever — and neither is "which this change moved", which asserts a cause the baseline cannot establish.
  2. **There is deliberately no "which this change moved" title variant, and this plan must not reintroduce one.** `content_drift` has ONE title in both modes — `` cites `${cited}:${n}`, which no longer reads the same `` — and the proven fact that the reviewed range touched the cited file goes in the **body**, as its own appended sentence: `` This change touched `${cited}`. `` The baseline is the commit that last wrote the *citing* line, which can predate the reviewed range by any number of commits; the drift may have happened in any of them. The same rule binds `missing_file` and `line_out_of_range`: they say the file is absent or short *at this revision*, never that this change removed or shortened it.
  3. **No fix, no suggestion, no "did you mean".** urtext does not know where the cited content went, and guessing would put a `verified` badge on a search result.
  4. **The finding anchors on the citing line, not the cited line.** `Fact.file`/`Fact.line` name the prose, which `makeFact` derives from `evidence[0]`.
- **The eight forbidden words.** The words **"wrong", "incorrect", "outdated", "stale", "obsolete", "misleading", "broken", and "lies" are forbidden in urtext's own citation copy** — titles, bodies, disclosure notes, the CLI, USAGE. A copy guard test enforces this the way the intent design's does (Task 3, Step 6). Note the substring trap: `lies` is inside "applies", "relies", "families", so that one word is matched on a word boundary while the other seven are matched as substrings — see the guard's own comment in Task 3.
- **The baseline gate is not optional and is not an optimization.** Every rot kind asks two questions — did this test pass at the commit that last wrote the citing line, and does it fail now — and rot is exactly both together. A citation that never resolved is a typo, an illustration, or a plan for a file that does not exist yet, and urtext cannot tell those apart, so it says nothing about them. Deleting the gate must fail a test (Task 2, Step 6, mutation check 1).
- **Under-reporting is intended, everywhere, and is not a defect to be fixed later.** Blame gives when the citing line was last *touched*, not when the citation was last *verified*: a typo fix or a reflow resets the baseline to a commit at which the citation may already have been rotting, and urtext then finds no drift. So do the mandatory separator, the phrase-must-contain-whitespace rule, the trimmed comparison, and the skipped uncommitted baseline. **This is the correct direction of error for a `verified` badge:** the failure mode is a rotted citation urtext stays silent about, never a sound citation urtext accuses. A `verified` finding that misses things is a tool a reader keeps trusting; a `verified` finding that invents one is trusted exactly once. Any test named for a deliberate miss says so in its name, so nobody later "fixes" it.
- **No auto-fix.** No rewrite, no `--fix`, no suggested line number, no "did you mean", no record of which citations rotted in an earlier run, no trend. No network access is added: URLs are masked out before extraction rather than followed.
- **Comment contract:** comments name constants, never restate values, and `test/comment-contract.test.ts` must stay green. Two hazards this feature introduces, both avoidable:
  - **The guarded set already contains the value one** (`WEIGHTS.effect.network`). A comment describing a regex quantifier, a chunk width, or a bound must not spell its digits — describe the shape in words and name the constant, exactly as the spec's own regex descriptions do. The safest rule while writing this feature: **put no bare digit in any comment at all.**
  - **Registering a new cap forbids its numeral in every comment in the repository, forever.** See the boxed warning in Task 2, Step 5 — it resolves a discrepancy in the spec and is the single most consequential edit in this plan.
- Invariant claims quote their enforcing test verbatim, in the style the existing modules already use.
- **No new runtime dependency**, and no dev dependency either. `git()`, `ctx.readAt`, and `typescript` are the whole toolbox.
- **No existing expected string changes**, with exactly one exception, named in the spec: the `effectsLens` note in `src/report/html.ts` gains a clause. Any *other* existing test that goes red is a bug in the new code, not a test to edit. One existing *non-string* expectation does change and is called out where it happens: `test/analyze/index.test.ts`'s "registers four analyzers" becomes five (Task 3, Step 5) — see Ambiguity 3.
- Byte-check every changed file for NUL bytes before every commit:
  `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" <files>` must print `0`.
- Every behavior change lands with a test that fails before it. Run `npx vitest run` **BARE** and gate on its exit code — never through a pipe.

## File Structure

- Create: `src/analyze/citations.ts` — built in two passes. Task 1 creates it with the extraction half (the two regexes, the masks, the comment walk and unwrap, the caps that bound extraction). Task 2 extends the same file with the scan engine (candidate discovery, blame, the four rot tests, the caps that bound git work, the three disclosure notes). Task 3 adds the analyzer factory and the fact construction. The spec puts all of it in one file; this plan keeps that and splits only the *work*, not the module.
- Modify: `src/types.ts` — `FactKind` gains `"citation_rot"` (Task 3).
- Modify: `src/score/index.ts` — `WEIGHTS.factKind.citation_rot` and one `toFinding` case (Task 3).
- Modify: `src/report/model.ts` — `Subject` gains `"citation"`; `SUBJECT_OF_KIND` and `LENS_OF_SUBJECT` gain one entry each (Task 3).
- Modify: `src/report/html.ts` — the `effectsLens` note gains one clause (Task 3). The only existing expected string that changes anywhere.
- Modify: `src/analyze/index.ts` — one re-export, one `ANALYZERS` entry (Task 3).
- Modify: `src/cli.ts` — `CliOptions.citations`, the `--citations` parse arm, one `USAGE` entry, the identity swap (Task 4).
- Modify: `test/comment-contract.test.ts` — three `remember(...)` lines (Task 2, Step 5).
- Tests: create `test/analyze/citations.test.ts` (extraction and comment scanning, Task 1) and `test/analyze/citations-rot.test.ts` (fixture repositories, Task 2); extend `test/score/index.test.ts`, `test/report/model.test.ts`, `test/report/terminal.test.ts`, `test/report/html.test.ts`, `test/report/markdown.test.ts`, `test/report/pdf.test.ts`, `test/report/copy-guard.test.ts`, `test/analyze/index.test.ts` (Task 3), `test/cli.test.ts` (Task 4).

The spec names `test/analyze/citations.test.ts` for the extraction cases and names no file for the rot cases. Splitting the rot cases into `test/analyze/citations-rot.test.ts` keeps Task 1 free of `beforeAll` git fixtures entirely, which is what makes it reviewable on its own.

---

### Task 1: Citation extraction, with no git at all

Everything that decides *what a citation is* — both forms, the three structural false-positive guards, and the comment walk — as pure functions over strings. Nothing in this task reads a repository, so every case is a one-line fixture and every guard gets its own named test.

**Files:**
- Create: `src/analyze/citations.ts`
- Test: create `test/analyze/citations.test.ts`

**Interfaces:**
- Consumes: `isTypeScriptFile` from `src/extract/symbols.js`; `typescript` (the `ts` default import), for `createSourceFile`, `getLeadingCommentRanges`, `getTrailingCommentRanges`. Nothing else — no `git`, no `AnalysisContext`, no `Fact`.
- Produces (verbatim from the spec where the spec gives it; Tasks 2 and 3 rely on these exact names):

```ts
export type CitationForm = "line" | "quote";

export interface Citation {
  form: CitationForm;
  /** The path exactly as the prose spelled it, before any resolution. */
  path: string;
  /** Form A only: the cited start line, and the end line for a range. */
  line?: number;
  endLine?: number;
  /** Form B only: the quoted phrase, already normalized. */
  quote?: string;
  /** 1-based line in the citing file where `path` sits. */
  citingLine: number;
  /** That line's text, trimmed, for `evidence[0].excerpt`. */
  citingText: string;
}

export const LINE_CITATION: RegExp;
export const QUOTED_CITATION: RegExp;
export const PROSE_EXTENSIONS: readonly string[];
export const CITATION_PATHSPECS: readonly string[];
export const MAX_QUOTE_CHARS = 240;
export const CITATION_TRUNCATION_MARKER = "… [line truncated]";

export function normalizeText(text: string): string;
export function maskFences(text: string): string;
export function maskUrls(text: string): string;
export function isProseFile(path: string): boolean;
export function citationsInProse(text: string): Citation[];
export function citationsInComments(source: string, fileName: string): Citation[];
export function citationsIn(path: string, text: string): Citation[];
```

- [ ] **Step 1: Write the failing tests**

Create `test/analyze/citations.test.ts`. Every fixture here is an inline string — a fixture written to match the parser cannot notice the parser changing, so the *rot* tests in Task 2 use real repositories; these pin the grammar, where an inline fixture is the honest instrument.

```ts
import { describe, expect, it } from "vitest";
import {
  citationsIn,
  citationsInComments,
  citationsInProse,
  MAX_QUOTE_CHARS,
  maskFences,
  maskUrls,
  normalizeText,
} from "../../src/analyze/citations.js";

describe("Form A — a path and a line", () => {
  it("captures the path and the line", () => {
    const [c] = citationsInProse("See src/analyze/fact.ts:45 for the rule.\n");
    expect(c.form).toBe("line");
    expect(c.path).toBe("src/analyze/fact.ts");
    expect(c.line).toBe(45);
    expect(c.endLine).toBeUndefined();
    expect(c.citingLine).toBe(1);
    expect(c.citingText).toBe("See src/analyze/fact.ts:45 for the rule.");
  });

  it("captures a range's start and end", () => {
    const [c] = citationsInProse("See src/analyze/fact.ts:45-63.\n");
    expect(c.line).toBe(45);
    expect(c.endLine).toBe(63);
  });

  it("reports the line the citation sits on, not the first line of the file", () => {
    const [c] = citationsInProse("intro\n\nthen src/cli.ts:12 here\n");
    expect(c.citingLine).toBe(3);
  });

  it("does not match a shorter line number inside a longer one", () => {
    // The trailing lookahead: `fact.ts:45` must not be found inside
    // `fact.ts:456`, which would cite a line the prose never named.
    const found = citationsInProse("src/analyze/fact.ts:456\n");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(456);
  });

  it("does not start a match in the middle of a longer path", () => {
    const found = citationsInProse("vendor/src/analyze/fact.ts:45\n");
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("vendor/src/analyze/fact.ts");
  });

  it("discards a line number too large to be a line", () => {
    // A forty-digit numeral is not a line, and `Number` would round it
    // silently into one that looks checkable.
    expect(citationsInProse(`src/a.ts:${"9".repeat(40)}\n`)).toHaveLength(0);
  });

  it("CITATION_GUARD_SEPARATOR: a bare filename with no separator is not a citation", () => {
    // Ordinary prose supplies endless look-alikes; each would resolve to no
    // file and, absent the baseline gate, be reported as missing.
    expect(citationsInProse("Something.js:14 and Node.js:14 and Fig.3:2\n")).toHaveLength(0);
  });
});

describe("Form B — a path and a quoted phrase", () => {
  it("captures the path and the phrase", () => {
    const [c] = citationsInProse('see `test/report/model.test.ts`, "carries the mark\'s words"\n');
    expect(c.form).toBe("quote");
    expect(c.path).toBe("test/report/model.test.ts");
    expect(c.quote).toBe("carries the mark's words");
  });

  it("accepts curly quotes and no separating punctuation", () => {
    const [c] = citationsInProse("see `src/cli.ts` “the range ends there”\n");
    expect(c.quote).toBe("the range ends there");
  });

  it("CITATION_GUARD_PHRASE: a single-word quote is not a citation", () => {
    // Prose emphasis far more often than a pointer, and one word is too weak
    // a needle to conclude anything from. This under-reports on purpose.
    expect(citationsInProse('see `src/cli.ts`, "--open"\n')).toHaveLength(0);
  });

  it("CITATION_GUARD_PHRASE: a phrase past MAX_QUOTE_CHARS is not a citation", () => {
    const long = "word ".repeat(MAX_QUOTE_CHARS);
    expect(citationsInProse(`see \`src/cli.ts\`, "${long}"\n`)).toHaveLength(0);
  });

  it("normalizes the captured phrase, so a wrapped quote compares like a flat one", () => {
    const [c] = citationsInProse('see `src/cli.ts`, "carries\n   the mark\'s words"\n');
    expect(c.quote).toBe("carries the mark's words");
  });
});

describe("masks", () => {
  it("CITATION_GUARD_FENCE: a citation inside a fenced block is not one, and the same text outside it is", () => {
    const text = ["```", "src/db.ts:14", "```", "", "src/db.ts:14", ""].join("\n");
    const found = citationsInProse(text);
    expect(found).toHaveLength(1);
    expect(found[0].citingLine).toBe(5);
  });

  it("closes a fence only on a run at least as long, in the same character", () => {
    const text = ["~~~~", "~~~", "src/db.ts:14", "~~~~", "src/db.ts:14", ""].join("\n");
    const found = citationsInProse(text);
    expect(found).toHaveLength(1);
    expect(found[0].citingLine).toBe(5);
  });

  it("keeps every offset, so masking never moves a later citation's line", () => {
    const text = ["```", "x", "```", "src/db.ts:14", ""].join("\n");
    expect(maskFences(text)).toHaveLength(text.length);
    expect(citationsInProse(text)[0].citingLine).toBe(4);
  });

  it("CITATION_GUARD_URL: a path:line inside a URL or a link destination is not a citation", () => {
    expect(citationsInProse("https://example.com/src/a.ts:12\n")).toHaveLength(0);
    expect(citationsInProse("[the file](../src/a.ts:12)\n")).toHaveLength(0);
    expect(maskUrls("https://example.com/src/a.ts:12\n")).toHaveLength(
      "https://example.com/src/a.ts:12\n".length,
    );
  });

  it("does not mask a four-space indented block, by decision", () => {
    // Indistinguishable from a list continuation in this repository's prose;
    // the baseline gate covers the illustrative ones instead.
    expect(citationsInProse("    src/db.ts:14\n")).toHaveLength(1);
  });
});

describe("comment scanning", () => {
  const src = [
    "// see src/analyze/fact.ts:45",
    "/**",
    " * And `test/report/model.test.ts`,",
    ' * "carries the mark\'s',
    ' * words" is quoted here.',
    " */",
    'export const s = "src/analyze/fact.ts:99";',
    "export const t = 1; // trailing src/cli.ts:12",
    "",
  ].join("\n");

  it("finds a citation in a line comment, a JSDoc block, and a trailing comment", () => {
    const found = citationsInComments(src, "a.ts");
    expect(found.some((c) => c.path === "src/analyze/fact.ts" && c.line === 45)).toBe(true);
    expect(found.some((c) => c.path === "src/cli.ts" && c.line === 12)).toBe(true);
    expect(found.some((c) => c.form === "quote")).toBe(true);
  });

  it("does not find one inside a string literal", () => {
    // Usually a test fixture's expected output, and inside code it is not
    // prose making a claim.
    expect(citationsInComments(src, "a.ts").some((c) => c.line === 99)).toBe(false);
  });

  it("reports the line the path sits on for a quote that wrapped across comment lines", () => {
    // The offset map, pinned directly. A naive "line of the comment's start"
    // would misreport every wrapped citation in src/, which are most of them.
    const quoted = citationsInComments(src, "a.ts").find((c) => c.form === "quote")!;
    expect(quoted.quote).toBe("carries the mark's words");
    expect(quoted.citingLine).toBe(3);
    expect(quoted.citingText).toContain("test/report/model.test.ts");
  });

  it("survives a template interpolation, which desyncs a raw scanner loop", () => {
    const withTemplate = [
      "const a = `value ${x} more`;",
      "// after the interpolation: src/cli.ts:12",
      "",
    ].join("\n");
    expect(citationsInComments(withTemplate, "b.ts")).toHaveLength(1);
  });
});

describe("citationsIn", () => {
  it("scans prose as raw text and TypeScript as comments only", () => {
    const text = 'const x = "src/cli.ts:12";\n';
    expect(citationsIn("docs/a.md", text)).toHaveLength(1);
    expect(citationsIn("src/a.ts", text)).toHaveLength(0);
    expect(citationsIn("assets/logo.png", text)).toHaveLength(0);
  });
});

describe("normalizeText", () => {
  it("collapses every whitespace run, newlines included, and trims", () => {
    expect(normalizeText("  a \n\t b  \r\n c ")).toBe("a b c");
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/analyze/citations.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/analyze/citations.js"`; the module does not exist.

- [ ] **Step 3: Create `src/analyze/citations.ts`**

Transcribe `LINE_CITATION`, `QUOTED_CITATION`, `MAX_QUOTE_CHARS`, and `CITATION_TRUNCATION_MARKER` from the spec's "What counts as a citation" and "Named caps" sections **verbatim, including their doc comments**, then add the glue below. The whole file as of this task:

```ts
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";

/**
 * A repository-relative path followed by a line, or a line range. The path
 * must contain at least one directory separator — see
 * CITATION_GUARD_SEPARATOR in the design's false-positive guards for why a
 * bare `Something.js:14` is not treated as a citation at all.
 *
 * Left to right: a lookbehind rejecting a preceding path character, so a
 * match cannot start in the middle of a longer path; one or more `segment/`
 * groups, which is what makes the separator mandatory; a final segment with
 * a dot and an alphanumeric extension; a colon; a line number with no
 * leading zero; optionally a hyphen and an end line; and a lookahead
 * rejecting a trailing digit, letter, underscore, slash, or hyphen, so a
 * citation is not matched inside a longer line number. Capture groups: path,
 * start line, end line or undefined.
 */
export const LINE_CITATION =
  /(?<![A-Za-z0-9_@./-])((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*):([1-9][0-9]*)(?:-([1-9][0-9]*))?(?![0-9A-Za-z_/-])/g;

/**
 * A backticked repository-relative path, then a quoted phrase — urtext's own
 * comment-contract form, and the most checkable citation form in the
 * repository, because the quoted text either appears in the named file or it
 * does not. The same mandatory-separator path, inside backticks; an optional
 * comma, semicolon, or colon; a short run of whitespace; then a straight or
 * left curly double quote, the phrase, and a straight or right curly close.
 * Capture groups: path, phrase.
 */
export const QUOTED_CITATION =
  /`((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*)`[,;:]?\s{0,3}["“]([^"”]+)["”]/g;

/**
 * The most code points a quoted phrase, or a stored was/now line, carries.
 * Longer than this is a block quotation rather than a pointer.
 */
export const MAX_QUOTE_CHARS = 240;

/** Appended to a was/now line the cap cut, so no line merely appears to end. */
export const CITATION_TRUNCATION_MARKER = "… [line truncated]";

/** Tracked files scanned as raw text, after masking. */
export const PROSE_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

/**
 * The pathspecs the candidate-file queries in `./citations.ts`'s scan half
 * pass to git. Narrower than `isTypeScriptFile` accepts — it also takes the
 * module-explicit extensions, which no pathspec here names — so a citation
 * written in one of those files is not checked at all. An under-report, the
 * direction every approximation in this feature leans.
 */
export const CITATION_PATHSPECS = ["*.md", "*.markdown", "*.txt", "*.ts", "*.tsx"] as const;

export type CitationForm = "line" | "quote";

export interface Citation {
  form: CitationForm;
  /** The path exactly as the prose spelled it, before any resolution. */
  path: string;
  /** Form A only: the cited start line, and the end line for a range. */
  line?: number;
  endLine?: number;
  /** Form B only: the quoted phrase, already normalized. */
  quote?: string;
  /** One-based line in the citing file where `path` sits. */
  citingLine: number;
  /** That line's text, trimmed, for the fact's anchor evidence. */
  citingText: string;
}

/**
 * Every whitespace run, newlines included, collapsed to a single space, then
 * trimmed. Matching and comparison both run on normalized text, and the
 * cited file is normalized identically before a containment test. Without
 * this, every comment-contract citation in `src/` would fail: they wrap
 * across continuation lines, so the phrase as written carries newlines and
 * asterisks the cited file never had.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Replaces every character of a span with a space, keeping newlines. Length
 * is preserved exactly, which is the whole point: every offset computed
 * after a mask still names the same character of the original text, so a
 * masked fence cannot move a later citation's reported line. See
 * `test/analyze/citations.test.ts`, "keeps every offset, so masking never
 * moves a later citation's line".
 */
function blankSpan(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * CITATION_GUARD_FENCE. Spans from a line opening a fence through the next
 * line closing that fence — same character, at least as long a run —
 * inclusive, are blanked. A path and line inside a fence is sample output,
 * and treating sample output as an assertion about the repository is the
 * most common false positive available. An unclosed fence blanks to the end
 * of the text: silence about a run of prose costs less than a finding built
 * on a code block nobody closed. Indented blocks are deliberately not
 * masked — they are indistinguishable from list continuations in this
 * repository's prose, and the baseline gate already covers the illustrative
 * ones. See `test/analyze/citations.test.ts`, "CITATION_GUARD_FENCE: a
 * citation inside a fenced block is not one, and the same text outside it
 * is".
 */
export function maskFences(text: string): string {
  const lines = text.split("\n");
  let open: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (open === undefined) {
      if (fence) {
        open = fence[1];
        lines[i] = blankSpan(lines[i]);
      }
      continue;
    }
    const closes = fence !== null && fence[1][0] === open[0] && fence[1].length >= open.length;
    lines[i] = blankSpan(lines[i]);
    if (closes) open = undefined;
  }
  return lines.join("\n");
}

const URL_SPAN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const LINK_DESTINATION = /\]\([^)]*\)/g;

/**
 * CITATION_GUARD_URL. A link to another host is a link to another host, and
 * its path-and-line tail says nothing about this repository. The regexes'
 * lookbehind is a second line of defense, not a substitute: masking is what
 * makes the intent explicit and testable.
 */
export function maskUrls(text: string): string {
  return text.replace(URL_SPAN, blankSpan).replace(LINK_DESTINATION, blankSpan);
}

export function isProseFile(path: string): boolean {
  return PROSE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

/** Absolute offset of the start of every line, for offset-to-line lookup. */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineOfOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function textOfLine(source: string, starts: number[], line: number): string {
  const start = starts[line - 1];
  const end = starts[line] === undefined ? source.length : starts[line] - 1;
  return source.slice(start, end).replace(/\r$/, "").trim();
}

/**
 * Runs both forms over `haystack` and reports each hit against `source`,
 * which is the file as written. `toSource` maps a haystack index back to an
 * absolute source offset: it is the identity for prose, where masking
 * preserves length, and the unwrap's offset map for comments, where it is
 * not.
 *
 * The two post-match rules for Form B live here rather than in the pattern
 * so their reasons stay readable. A parsed line number that is not a safe
 * integer is discarded rather than checked, because `Number` would silently
 * round a numeral too long to be a line into one that looks checkable.
 */
function matchCitations(
  haystack: string,
  toSource: (index: number) => number,
  source: string,
): Citation[] {
  const starts = lineStartsOf(source);
  const out: Citation[] = [];

  const push = (index: number, parts: Omit<Citation, "citingLine" | "citingText">): void => {
    const citingLine = lineOfOffset(starts, toSource(index));
    out.push({ ...parts, citingLine, citingText: textOfLine(source, starts, citingLine) });
  };

  for (const m of haystack.matchAll(LINE_CITATION)) {
    const line = Number.parseInt(m[2], 10);
    const endLine = m[3] === undefined ? undefined : Number.parseInt(m[3], 10);
    if (!Number.isSafeInteger(line)) continue;
    if (endLine !== undefined && !Number.isSafeInteger(endLine)) continue;
    push(m.index, endLine === undefined
      ? { form: "line", path: m[1], line }
      : { form: "line", path: m[1], line, endLine });
  }

  for (const m of haystack.matchAll(QUOTED_CITATION)) {
    const quote = normalizeText(m[2]);
    // The phrase must contain whitespace: a single quoted word is prose
    // emphasis far more often than a citation, and one word is too weak a
    // needle to conclude anything from. Counted with the spread for the
    // reason `truncateSignature` in `./surface.ts` documents.
    if (!/\s/.test(quote)) continue;
    if ([...quote].length > MAX_QUOTE_CHARS) continue;
    push(m.index, { form: "quote", path: m[1], quote });
  }

  return out.sort(
    (a, b) => a.citingLine - b.citingLine || a.path.localeCompare(b.path) || a.form.localeCompare(b.form),
  );
}

export function citationsInProse(text: string): Citation[] {
  return matchCitations(maskUrls(maskFences(text)), (index) => index, text);
}

interface CommentSpan {
  /** Absolute offset of the comment's first character. */
  start: number;
  text: string;
}

/**
 * Every comment in a file, walked off the parsed AST's leaf tokens.
 *
 * This is a deliberate second copy of the walk `test/comment-contract.test.ts`
 * documents at length, and the design names the duplication so a reviewer
 * does not treat it as an oversight: a plan that wants one copy should hoist
 * it into a shared module and update both call sites in the same change, not
 * import test code into `src/`. The reasons the walk has this shape are
 * recorded there in full; the short version is that a raw scanner loop
 * desynchronizes on the first template interpolation, and this codebase's
 * comments sit beside plenty of those, while a leading-only pass silently
 * misses every comment on the same line as the token before it. Two
 * different leaves can share a position — a zero-width node ends exactly
 * where the next token starts — so hits are deduplicated by range start.
 */
function commentSpans(source: string, fileName: string): CommentSpan[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const spans: CommentSpan[] = [];
  const seen = new Set<number>();

  const record = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      spans.push({ start: range.pos, text: source.slice(range.pos, range.end) });
    }
  };

  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      record(ts.getLeadingCommentRanges(source, node.getFullStart()));
      record(ts.getTrailingCommentRanges(source, node.getEnd()));
      return;
    }
    children.forEach(visit);
  };
  visit(sourceFile);
  return spans.sort((a, b) => a.start - b.start);
}

interface Unwrapped {
  /** The comment's body as one logical string, decorations removed. */
  text: string;
  /** Absolute source offset of every logical index, same length as `text`. */
  offsets: number[];
}

/**
 * Strips a comment's opening, closing, and continuation decorations and
 * joins its lines with single spaces, carrying an offset map alongside.
 * The citing line reported in evidence is derived from that map, so a
 * quoted citation whose phrase wraps across several comment lines is
 * reported at the line its path actually sits on — see
 * `test/analyze/citations.test.ts`, "reports the line the path sits on for a
 * quote that wrapped across comment lines". A naive "line of the comment's
 * start" would misreport every wrapped citation in `src/`, which are most of
 * them.
 */
function unwrapComment(span: CommentSpan): Unwrapped {
  const chars: string[] = [];
  const offsets: number[] = [];
  let lineStart = span.start;

  span.text.split("\n").forEach((line, index) => {
    let from = 0;
    let to = line.length;
    if (to > from && line[to - 1] === "\r") to--;
    while (from < to && (line[from] === " " || line[from] === "\t")) from++;
    // The close is stripped before the opens, so a line that is nothing but
    // a closing decoration contributes no stray character.
    if (to - from >= 2 && line.slice(to - 2, to) === "*/") to -= 2;
    if (line.startsWith("//", from)) from += 2;
    else if (line.startsWith("/*", from)) {
      from += 2;
      if (line[from] === "*") from++;
    } else if (line[from] === "*") from++;

    if (index > 0) {
      chars.push(" ");
      offsets.push(lineStart + Math.min(from, to));
    }
    for (let k = from; k < to; k++) {
      chars.push(line[k]);
      offsets.push(lineStart + k);
    }
    lineStart += line.length + 1;
  });

  return { text: chars.join(""), offsets };
}

/**
 * Comments only. A path and line inside a string literal is usually a test
 * fixture's expected output, and inside code it is not prose making a claim.
 * Fences are not masked here — a fence is a prose construct — but URLs are,
 * for the same reason they are in prose.
 */
export function citationsInComments(source: string, fileName: string): Citation[] {
  const out: Citation[] = [];
  for (const span of commentSpans(source, fileName)) {
    const { text, offsets } = unwrapComment(span);
    out.push(...matchCitations(maskUrls(text), (index) => offsets[index] ?? span.start, source));
  }
  return out.sort((a, b) => a.citingLine - b.citingLine || a.path.localeCompare(b.path));
}

/** Every citation in one file, scanned the way that file's kind is scanned. */
export function citationsIn(path: string, text: string): Citation[] {
  if (isProseFile(path)) return citationsInProse(text);
  if (isTypeScriptFile(path)) return citationsInComments(text, path);
  return [];
}
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run test/analyze/citations.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Mutation checks**

Both are one-line deletions; restore the line after each, and report the observed failure. A deletion that leaves the suite green means the test is not pinning what it claims.

1. **Delete the fence mask.** Change `citationsInProse` to `matchCitations(maskUrls(text), ...)`.
   `npx vitest run test/analyze/citations.test.ts` must fail *"CITATION_GUARD_FENCE: a citation inside a fenced block is not one, and the same text outside it is"*. Restore.
2. **Delete the separator requirement.** Replace the `((?:[A-Za-z0-9_@.-]+\/)+ ...)` group in `LINE_CITATION` with a single non-repeating segment, so a bare filename matches.
   The same file must fail *"CITATION_GUARD_SEPARATOR: a bare filename with no separator is not a citation"*. Restore.

- [ ] **Step 6: Full-suite gate**

Run, in order, and gate on each:
- `npx vitest run` (BARE — exit code is the gate, never a pipe)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" src/analyze/citations.ts test/analyze/citations.test.ts` → must print `0`

Nothing imports `citations.ts` yet, so the rest of the suite must be untouched.

- [ ] **Step 7: Commit**

```bash
git add src/analyze/citations.ts test/analyze/citations.test.ts
git commit -m "feat(analyze): extract path-and-line and quoted citations from prose and comments"
```

---

### Task 2: The baseline gate, the four rot tests, and degradation

The half that reads history. Candidate discovery in both modes, one blame per citing file, the gate, the four tests in order, the caps, and the three disclosure sentences. Still no `Fact`, no `FactKind`, no analyzer: this task's product is a plain `CitationRot[]`, which is what lets it be reviewed against real repositories without touching scoring or rendering.

**Files:**
- Modify: `src/analyze/citations.ts` (append the scan half)
- Modify: `test/comment-contract.test.ts` (three lines — read the boxed warning in Step 5 first)
- Test: create `test/analyze/citations-rot.test.ts`

**Interfaces:**
- Consumes: `git(args: string[], cwd: string): Promise<string>` from `../extract/git.js`; `AnalysisContext`, `Changeset`, `WORKTREE`, `REPORT_DIR` from `../types.js`; Task 1's `citationsIn`, `normalizeText`, `isProseFile`, `MAX_QUOTE_CHARS`, `CITATION_TRUNCATION_MARKER`, `CITATION_PATHSPECS` from this same module.
- Produces:

```ts
export type RotKind = "missing_file" | "line_out_of_range" | "quote_absent" | "content_drift";

export interface CitationRot {
  rot: RotKind;
  citingFile: string;
  citingLine: number;
  citingText: string;
  /** The resolved cited path, not the path as written. */
  citedFile: string;
  citedLine?: number;
  citedEndLine?: number;
  quote?: string;
  /** content_drift only: the first differing line, both sides, truncated. */
  was?: string;
  now?: string;
  /** Abbreviated baseline commit. Absent means history could not be read. */
  baseline?: string;
  /** line_out_of_range only: the cited file's line count at this revision. */
  lineCount?: number;
  /** The cited line's current text, when the file and line exist now. */
  citedText?: string;
  /** True when the reviewed range touched `citedFile`. Proven, not inferred. */
  citedTouched: boolean;
}

export interface CitationScanOptions {
  sweep?: boolean;
  onNote?: (note: string) => void;
}

export function findCitationRot(
  changeset: Changeset,
  ctx: AnalysisContext,
  options?: CitationScanOptions,
): Promise<CitationRot[]>;

export function parseBlame(out: string): Map<number, string>;

export const MAX_CITATIONS_CHECKED = 2000;
export const MAX_CITING_FILES = 320;
export const MAX_BASELINE_READS = 480;
export const MAX_GREP_TERMS = 96;

export function citingFilesCappedNote(scanned: number, found: number): string;
export function citationsCappedNote(checked: number, found: number): string;
export function baselineReadsCappedNote(unchecked: number): string;
export function blameUnavailableNote(count: number, reason: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `test/analyze/citations-rot.test.ts`. Every history case is built by **actually moving code in a real fixture repository and committing** — a fixture written to match the checker cannot notice the checker changing. The isolation flags and `mkdtempSync` pattern are `test/extract/git.test.ts`'s and `test/analyze/blast-radius.test.ts`'s.

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  baselineReadsCappedNote,
  blameUnavailableNote,
  citationsCappedNote,
  citingFilesCappedNote,
  findCitationRot,
  MAX_CITING_FILES,
  parseBlame,
} from "../../src/analyze/citations.js";
import { createContext, extract } from "../../src/extract/index.js";

// Insulate the temp repo from whatever the developer's global git config
// says: commit signing and a global hooksPath both fail here for reasons
// that have nothing to do with the code under test.
const GIT_ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function makeRepo(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), name));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@e.com"]);
  git(repo, ["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", [...GIT_ISOLATION, ...args], { cwd: repo, stdio: "pipe" }).toString();
}

function write(repo: string, path: string, lines: string[]): void {
  writeFileSync(join(repo, path), lines.join("\n") + "\n");
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
}

/** The scan over the whole repository, which is what every rot case wants. */
async function sweep(repo: string) {
  const cs = await extract(repo);
  return findCitationRot(cs, createContext(repo, cs.range), { sweep: true });
}

describe("the four rot kinds", () => {
  it("missing_file: the cited file is not there any more", async () => {
    const repo = makeRepo("urtext-rot-missing-");
    write(repo, "src/gone.ts", ["export const gone = 1;"]);
    write(repo, "docs/a.md", ["The rule lives in src/gone.ts:1."]);
    commit(repo, "first");
    git(repo, ["rm", "src/gone.ts"]);
    commit(repo, "delete the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const rots = await sweep(repo);
    const r = rots.find((x) => x.rot === "missing_file")!;
    expect(r).toBeDefined();
    expect(r.citedFile).toBe("src/gone.ts");
    // Anchored on the citing line, which is where the reader's work is.
    expect(r.citingFile).toBe("docs/a.md");
    expect(r.citingLine).toBe(1);
    expect(r.baseline).toBeTruthy();
  });

  it("line_out_of_range: the line number is past the end of the file", async () => {
    const repo = makeRepo("urtext-rot-range-");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    write(repo, "docs/a.md", ["See src/a.ts:3 for the third."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 1;"]);
    commit(repo, "shorten the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "line_out_of_range")!;
    expect(r).toBeDefined();
    expect(r.citedFile).toBe("src/a.ts");
    expect(r.citedLine).toBe(3);
    expect(r.lineCount).toBe(1);
    expect(r.citingLine).toBe(1);
  });

  it("quote_absent: the quoted phrase is not in the file", async () => {
    const repo = makeRepo("urtext-rot-quote-");
    write(repo, "src/a.ts", ["// keeps the door shut", "export const a = 1;"]);
    write(repo, "docs/a.md", ['See `src/a.ts`, "keeps the door shut".']);
    commit(repo, "first");
    write(repo, "src/a.ts", ["// leaves the door open", "export const a = 1;"]);
    commit(repo, "reword the cited comment");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "quote_absent")!;
    expect(r).toBeDefined();
    expect(r.quote).toBe("keeps the door shut");
    expect(r.citedFile).toBe("src/a.ts");
  });

  it("content_drift: the line still exists and no longer says the same thing", async () => {
    const repo = makeRepo("urtext-rot-drift-");
    write(repo, "src/a.ts", ["export const limit = 1;", "export const other = 2;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;", "export const other = 2;"]);
    commit(repo, "change the cited line");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "content_drift")!;
    expect(r).toBeDefined();
    expect(r.was).toBe("export const limit = 1;");
    expect(r.now).toBe("export const limit = 99;");
    expect(r.citingFile).toBe("docs/a.md");
  });

  it("reports a re-indent as nothing at all", async () => {
    const repo = makeRepo("urtext-rot-indent-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["    export const limit = 1;"]);
    commit(repo, "re-indent the cited line");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect((await sweep(repo)).filter((x) => x.rot === "content_drift")).toHaveLength(0);
  });

  it("emits one fact for one citation, not one per test that could fire", async () => {
    // A missing file has no lines to be out of range and no content to have
    // drifted; emitting more than one would be one finding said four ways.
    const repo = makeRepo("urtext-rot-first-wins-");
    write(repo, "src/gone.ts", ["const a = 1;", "const b = 2;"]);
    write(repo, "docs/a.md", ["Both src/gone.ts:2 and `src/gone.ts`, \"const b = 2\"."]);
    commit(repo, "first");
    git(repo, ["rm", "src/gone.ts"]);
    commit(repo, "delete it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const rots = await sweep(repo);
    for (const kind of new Set(rots.map((r) => `${r.citingLine}:${r.rot}`))) {
      expect(rots.filter((r) => `${r.citingLine}:${r.rot}` === kind)).toHaveLength(1);
    }
    expect(rots.every((r) => r.rot === "missing_file")).toBe(true);
  });
});

describe("CITATION_GUARD_BASELINE — the gate", () => {
  it("says nothing about a citation that never resolved, for missing_file", async () => {
    // The most important test in the suite: it is the one standing between a
    // verified badge and every illustrative path in this repository's own
    // specs.
    const repo = makeRepo("urtext-gate-missing-");
    write(repo, "docs/a.md", ["An example: src/db.ts:14 never existed here."]);
    commit(repo, "first");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("says nothing about a line number that was never in the cited file", async () => {
    const repo = makeRepo("urtext-gate-range-");
    write(repo, "src/a.ts", ["const a = 1;"]);
    write(repo, "docs/a.md", ["See src/a.ts:900, a typo."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 2;"]);
    commit(repo, "touch the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("says nothing about a quote that was never in the cited file", async () => {
    const repo = makeRepo("urtext-gate-quote-");
    write(repo, "src/a.ts", ["// something else entirely"]);
    write(repo, "docs/a.md", ['See `src/a.ts`, "a phrase never present".']);
    commit(repo, "first");
    write(repo, "src/a.ts", ["// something else again"]);
    commit(repo, "touch the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("misses a drift that predates the citing line's last edit — the documented, intended miss", async () => {
    // Blame gives when the citing line was last TOUCHED, not when the
    // citation was last VERIFIED. This test is named for the miss so nobody
    // later "fixes" it: the failure mode is silence about a rotted citation,
    // never an accusation against a sound one.
    const repo = makeRepo("urtext-gate-underreport-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "change the cited line");
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1.", "", "An unrelated new paragraph."]);
    commit(repo, "reflow the doc, resetting the baseline");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("skips an uncommitted citing line and discloses nothing — an absence of history is not a degradation", async () => {
    const repo = makeRepo("urtext-gate-uncommitted-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "change it");
    // Written but never committed: as new as the change under review.
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const rots = await findCitationRot(cs, createContext(repo, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });
    expect(rots).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });
});

describe("degradation", () => {
  it("falls back to existence-only checking and discloses it once, whatever the count", async () => {
    const repo = makeRepo("urtext-degrade-");
    write(repo, "docs/a.md", ["Gone: src/gone.ts:1 and src/also-gone.ts:2 and src/third.ts:3."]);
    commit(repo, "first");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const failing = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === "blame") throw new Error("fatal: no such ref");
      return actualGit(args, cwd);
    });
    vi.doMock("../../src/extract/git.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/extract/git.js")>();
      return { ...actual, git: failing };
    });
    const actualGit = (await vi.importActual<typeof import("../../src/extract/git.js")>(
      "../../src/extract/git.js",
    )).git;
    const { findCitationRot: degraded } = await import("../../src/analyze/citations.js");

    const notes: string[] = [];
    const cs = await extract(repo);
    const rots = await degraded(cs, createContext(repo, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });
    // Test (a) alone, ungated, so every absent path is reported — the one
    // place a false positive is reachable, disclosed in the same breath.
    expect(rots.every((r) => r.rot === "missing_file")).toBe(true);
    expect(rots.every((r) => r.baseline === undefined)).toBe(true);
    const blameNotes = notes.filter((n) => n.includes("could not be dated"));
    expect(blameNotes).toHaveLength(1);
    expect(blameNotes[0]).toBe(blameUnavailableNote(3, "fatal: no such ref"));
    vi.doUnmock("../../src/extract/git.js");
    vi.resetModules();
  });
});

describe("blame", () => {
  it("keeps one commit per final line from --line-porcelain output", () => {
    const out = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2",
      "author T",
      "\tfirst line",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2",
      "author T",
      "\tsecond line",
      "",
    ].join("\n");
    const map = parseBlame(out);
    expect(map.get(1)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(map.get(2)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(map.size).toBe(2);
  });

  it("runs one blame per citing file, not one per citation", async () => {
    const repo = makeRepo("urtext-blame-memo-");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    write(repo, "docs/a.md", [
      "One src/a.ts:1.",
      "Two src/a.ts:2.",
      "Three src/a.ts:3.",
    ]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 9;", "const b = 9;", "const c = 9;"]);
    commit(repo, "change all three");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const calls: string[][] = [];
    vi.doMock("../../src/extract/git.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/extract/git.js")>();
      return {
        ...actual,
        git: (args: string[], cwd: string) => {
          calls.push(args);
          return actual.git(args, cwd);
        },
      };
    });
    const { findCitationRot: counted } = await import("../../src/analyze/citations.js");

    const cs = await extract(repo);
    const rots = await counted(cs, createContext(repo, cs.range), { sweep: true });
    expect(rots.filter((r) => r.rot === "content_drift")).toHaveLength(3);
    // Three citations in one file cost exactly one blame.
    expect(calls.filter((a) => a[0] === "blame")).toHaveLength(1);
    vi.doUnmock("../../src/extract/git.js");
    vi.resetModules();
  });
});

describe("the two modes", () => {
  it("checks a citation into an unchanged file only under sweep", async () => {
    // One test, both assertions, so the mode boundary cannot half-move.
    const repo = makeRepo("urtext-modes-");
    write(repo, "src/untouched.ts", ["export const limit = 1;"]);
    write(repo, "src/touched.ts", ["export const t = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/untouched.ts:1."]);
    commit(repo, "first");
    write(repo, "src/untouched.ts", ["export const limit = 99;"]);
    commit(repo, "drift the cited line");
    // The reviewed range touches only the other file.
    write(repo, "src/touched.ts", ["export const t = 2;"]);

    const cs = await extract(repo, "HEAD");
    const ctx = createContext(repo, cs.range);
    expect(await findCitationRot(cs, ctx)).toHaveLength(0);
    const swept = await findCitationRot(cs, ctx, { sweep: true });
    expect(swept.filter((r) => r.rot === "content_drift")).toHaveLength(1);
  });

  it("never scans REPORT_DIR, so urtext's own output cannot feed itself", async () => {
    const repo = makeRepo("urtext-reportdir-");
    mkdirSync(join(repo, ".urtext"), { recursive: true });
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, ".urtext/review.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });
});

describe("caps", () => {
  it("emits no note when every cap is clear", async () => {
    const repo = makeRepo("urtext-caps-clear-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    await findCitationRot(cs, createContext(repo, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });
    expect(notes).toHaveLength(0);
  });

  it("discloses a bitten citing-file cap with counts that add up, deterministically", async () => {
    const repo = makeRepo("urtext-caps-files-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    const extra = 3;
    const found = MAX_CITING_FILES + extra;
    for (let i = 0; i < found; i++) {
      // Zero-padded so path order is the obvious order, and every file
      // carries a citation so none is skipped for being citation-free.
      write(repo, `docs/f${String(i).padStart(5, "0")}.md`, ["The limit is set at src/a.ts:1."]);
    }
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const ctx = createContext(repo, cs.range);
    const first = await findCitationRot(cs, ctx, { sweep: true, onNote: (n) => notes.push(n) });
    expect(notes).toContain(citingFilesCappedNote(MAX_CITING_FILES, found));
    expect(first).toHaveLength(MAX_CITING_FILES);
    // A capped run is deterministic: the same files, in path order, twice.
    const second = await findCitationRot(cs, ctx, { sweep: true });
    expect(second.map((r) => r.citingFile)).toEqual(first.map((r) => r.citingFile));
  });

  it("composes the citation and baseline-read notes with the counts they are given", () => {
    // Driving MAX_CITATIONS_CHECKED and MAX_BASELINE_READS over their edges
    // with real commits would build a repository large enough to dominate the
    // suite's runtime; the enforcement paths are pinned by the citing-file
    // case above, which shares the counting code, and these pin the copy the
    // reader actually receives.
    expect(citationsCappedNote(10, 12)).toContain("stopped after 10 citations");
    expect(citationsCappedNote(10, 12)).toContain("2 further citations");
    expect(citationsCappedNote(10, 11)).toContain("1 further citation ");
    expect(baselineReadsCappedNote(2)).toContain("2 citations");
    expect(baselineReadsCappedNote(1)).toContain("1 citation ");
    expect(blameUnavailableNote(1, "boom")).toContain("1 citation ");
    expect(blameUnavailableNote(2, "boom")).toContain("2 citations");
  });

  it("says none of the eight forbidden words in any disclosure sentence", () => {
    const sentences = [
      citingFilesCappedNote(1, 2),
      citationsCappedNote(1, 2),
      baselineReadsCappedNote(1),
      blameUnavailableNote(1, "fatal: no such ref"),
    ].join(" ").toLowerCase();
    for (const word of ["wrong", "incorrect", "outdated", "obsolete", "misleading", "broken"]) {
      expect(sentences.includes(word), word).toBe(false);
    }
    expect(/\bstale\b/.test(sentences)).toBe(false);
    expect(/\blies\b/.test(sentences)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/analyze/citations-rot.test.ts`
Expected: FAIL — `findCitationRot`, `parseBlame`, the four caps, and the four note composers are not exported from `src/analyze/citations.js`.

- [ ] **Step 3: Append the scan half to `src/analyze/citations.ts`**

Transcribe the four cap constants from the spec's "Named caps" **verbatim with their doc comments**, and the three cap sentences from "Cap disclosure copy" and `blameUnavailableNote` from "Degradation" verbatim. The glue below is what the spec leaves open.

```ts
import { git } from "../extract/git.js";
import { REPORT_DIR, WORKTREE, type AnalysisContext, type Changeset } from "../types.js";

export const MAX_CITATIONS_CHECKED = 2000;
export const MAX_CITING_FILES = 320;
export const MAX_BASELINE_READS = 480;
export const MAX_GREP_TERMS = 96;

/**
 * Pluralized inline in the style `review` in `../cli.ts` already uses, and
 * phrased as reasons so they read alongside the existing warnings. They land
 * in `warnings`, which becomes `ReportModel.notes`, which trips the "This
 * review is partial." banner — correctly. A capped run genuinely did not
 * check everything it was asked to.
 */
export function citingFilesCappedNote(scanned: number, found: number): string {
  return `citation checking scanned ${scanned} of ${found} candidate files, so citations in the other ${found - scanned} were not checked`;
}

export function citationsCappedNote(checked: number, found: number): string {
  const left = found - checked;
  return `citation checking stopped after ${checked} citations, so ${left} further citation${left === 1 ? "" : "s"} in this repository ${left === 1 ? "was" : "were"} not checked`;
}

export function baselineReadsCappedNote(unchecked: number): string {
  return `citation checking stopped reading historical file contents, so ${unchecked} citation${unchecked === 1 ? "" : "s"} ${unchecked === 1 ? "was" : "were"} checked only for whether the cited file exists`;
}

/** Copy for citations whose history could not be read. */
export function blameUnavailableNote(count: number, reason: string): string {
  return `${count} citation${count === 1 ? "" : "s"} could not be dated (git blame failed: ${reason}), so ${count === 1 ? "it was" : "they were"} checked only for whether the cited file exists`;
}

export type RotKind = "missing_file" | "line_out_of_range" | "quote_absent" | "content_drift";

// `CitationRot` is declared exactly as this task's Interfaces block gives it,
// field for field and doc comment for doc comment — copy it from there rather
// than re-deriving it, since Task 3 reads every one of those fields by name.

export interface CitationScanOptions {
  /**
   * Check every citation in the repository rather than only those pointing
   * into files the reviewed range touched. Set by `--citations`.
   */
  sweep?: boolean;
  /**
   * Called once per cap that bit and once for unreadable history, with the
   * sentence the user is owed. An analyzer returns facts and nothing else, so
   * this is the only channel a disclosure has; `review` in `../cli.ts` passes
   * one that pushes into `warnings`. A caller that passes none gets the facts
   * and no indication anything was skipped — the same contract, and the same
   * hazard, as `runAnalyzers`'s `onFailure`.
   */
  onNote?: (note: string) => void;
}

/**
 * A blame line's porcelain header: the commit, the line in the original
 * file, the line in the final file, and — only on the first line of a run —
 * how many lines the run covers. The parse keeps one thing, a map from final
 * line to commit; every other header and the tab-prefixed content are
 * skipped. See `test/analyze/citations-rot.test.ts`, "keeps one commit per
 * final line from --line-porcelain output".
 */
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

export function parseBlame(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) map.set(Number.parseInt(m[2], 10), m[1]);
  }
  return map;
}

/** An uncommitted line blames to the all-zeros commit. */
const UNCOMMITTED = /^0+$/;

/**
 * `git grep` exits one when nothing matches. That rejection is an absence,
 * not a failure — it is read as "no candidate files", exactly as `readAt`
 * reads git's absence wording as null — and it is told apart from a real
 * failure by the pair of things git guarantees for it: the exit status, and
 * an empty stderr. Anything else travels the degradation path.
 */
function isNoMatch(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const stderr = (err as { stderr?: unknown }).stderr;
  return code === 1 && typeof stderr === "string" && stderr.trim() === "";
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  // A file ending in a newline splits to a trailing empty element that is
  // not a line of the file; counting it would put every last-line citation
  // one short of the end.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.replace(/\r$/, ""));
}

/**
 * Both sides of a was/now pair are truncated for storage and rendering, with
 * CITATION_TRUNCATION_MARKER appended when the cut runs, so no line merely
 * appears to end. Counted by code point for the reason `truncateSignature`
 * in `./surface.ts` documents.
 */
function truncateLine(text: string): string {
  const points = [...text];
  if (points.length <= MAX_QUOTE_CHARS) return text;
  return points.slice(0, MAX_QUOTE_CHARS).join("") + CITATION_TRUNCATION_MARKER;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export async function findCitationRot(
  changeset: Changeset,
  ctx: AnalysisContext,
  options: CitationScanOptions = {},
): Promise<CitationRot[]> {
  const now = changeset.range.to;
  const cwd = ctx.cwd;
  const note = options.onNote;

  // Every path the range touched, both sides, so a rename is covered on
  // both. This is the default mode's whole filter, and it is what bounds
  // cost by the change rather than by the repository.
  const touched = new Set<string>();
  for (const file of changeset.files) {
    touched.add(file.path);
    if (file.previousPath) touched.add(file.previousPath);
  }

  // One read per revision-and-path pair. `readAt` is a `git show` per call
  // and is not memoized upstream; memoizing here is what turns many
  // citations into one file at one baseline commit into one read.
  const reads = new Map<string, Promise<string | null>>();
  const historical = new Set<string>();
  let baselineReadsRefused = 0;
  const readAt = (rev: string, path: string): Promise<string | null> => {
    const key = `${rev}${path}`;
    let read = reads.get(key);
    if (!read) {
      read = ctx.readAt(rev, path);
      read.catch(() => reads.delete(key));
      reads.set(key, read);
    }
    return read;
  };
  /** A historical read, refused once the distinct-pair budget is spent. */
  const readHistorical = (rev: string, path: string): Promise<string | null> | undefined => {
    const key = `${rev}${path}`;
    if (!historical.has(key)) {
      if (historical.size >= MAX_BASELINE_READS) return undefined;
      historical.add(key);
    }
    return readAt(rev, path);
  };

  // One blame per citing file, never per citation. A file with forty
  // citations costs one blame. A resolved null is a blame that failed, and
  // its reason travels beside it.
  const blames = new Map<string, Promise<Map<number, string> | null>>();
  let blameReason: string | undefined;
  const blameOf = (path: string): Promise<Map<number, string> | null> => {
    let blame = blames.get(path);
    if (!blame) {
      const args = ["blame", "--line-porcelain", "--root"];
      if (now !== WORKTREE) args.push(now);
      blame = git([...args, "--", path], cwd)
        .then(parseBlame)
        .catch((err: unknown) => {
          blameReason ??= reasonOf(err);
          return null;
        });
      blames.set(path, blame);
    }
    return blame;
  };

  const candidates = options.sweep
    ? await sweepCandidates(cwd)
    : await touchedCandidates(cwd, now, touched);
  if (candidates.length === 0) return [];

  const scanned = candidates.slice(0, MAX_CITING_FILES);
  if (scanned.length < candidates.length) {
    note?.(citingFilesCappedNote(scanned.length, candidates.length));
  }

  // Extraction first, across every scanned file, because the citation cap's
  // sentence states how many were found as well as how many were checked —
  // and extraction costs no git at all.
  const pending: Array<{ file: string; citation: Citation }> = [];
  for (const file of scanned) {
    const text = await readAt(now, file);
    if (text === null) continue;
    for (const citation of citationsIn(file, text)) pending.push({ file, citation });
  }

  const checking = pending.slice(0, MAX_CITATIONS_CHECKED);
  if (checking.length < pending.length) {
    note?.(citationsCappedNote(checking.length, pending.length));
  }

  const rots: CitationRot[] = [];
  let undated = 0;

  for (const { file, citation } of checking) {
    const blame = await blameOf(file);
    const baseline = blame?.get(citation.citingLine);
    // An uncommitted citing line is as new as the change under review:
    // there is no earlier state to compare against, all four tests are
    // skipped, and nothing is disclosed, because nothing was lost.
    if (blame !== null && (baseline === undefined || UNCOMMITTED.test(baseline))) continue;
    if (blame === null) undated++;

    const rot = await checkCitation({
      file,
      citation,
      baseline: blame === null ? undefined : baseline,
      now,
      touched,
      sweep: options.sweep === true,
      readAt,
      readHistorical,
      onRefusedBaseline: () => {
        baselineReadsRefused++;
      },
    });
    if (rot) rots.push(rot);
  }

  if (undated > 0) note?.(blameUnavailableNote(undated, blameReason ?? "unknown reason"));
  if (baselineReadsRefused > 0) note?.(baselineReadsCappedNote(baselineReadsRefused));

  return rots;
}
```

and the two candidate-discovery functions plus the per-citation checker:

```ts
/**
 * Sweep candidates: every tracked file the pathspecs admit, minus
 * REPORT_DIR. urtext's own reports quote source lines by path and line by
 * construction; scanning them would make every review generate citations
 * that the next review reports as rotted. Sorted, so a capped run takes the
 * same files twice.
 *
 * `ls-files` lists the index rather than a revision, which is safe because
 * every candidate is then read through `readAt` at the reviewed revision: a
 * file absent there yields null and is skipped.
 */
async function sweepCandidates(cwd: string): Promise<string[]> {
  const out = await git(["ls-files", "-z", "--", ...CITATION_PATHSPECS], cwd);
  return out
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith(`${REPORT_DIR}/`))
    .sort();
}

/**
 * Default-mode candidates: files git can prove mention one of the changed
 * files' basenames. Basenames rather than full paths, because prose cites a
 * file by many spellings and the resolution rules decide what a path means;
 * the full-path filter is applied after extraction, on resolved paths, where
 * it is exact. Terms are chunked at MAX_GREP_TERMS per invocation and the
 * results unioned — chunking loses nothing, so unlike the caps it needs no
 * disclosure.
 */
async function touchedCandidates(
  cwd: string,
  now: string,
  touched: Set<string>,
): Promise<string[]> {
  const basenames = [...new Set([...touched].map((path) => path.split("/").pop() ?? path))].sort();
  if (basenames.length === 0) return [];
  const found = new Set<string>();
  for (let i = 0; i < basenames.length; i += MAX_GREP_TERMS) {
    const terms = basenames.slice(i, i + MAX_GREP_TERMS).flatMap((name) => ["-e", name]);
    const args = ["grep", "-I", "-l", "-F", ...terms];
    if (now !== WORKTREE) args.push(now);
    let out: string;
    try {
      out = await git([...args, "--", ...CITATION_PATHSPECS], cwd);
    } catch (err) {
      if (isNoMatch(err)) continue;
      throw err;
    }
    for (const line of out.split("\n")) {
      // With a revision argument git prefixes each path with `<rev>:`.
      const path = now === WORKTREE ? line : line.slice(line.indexOf(":") + 1);
      if (path !== "" && !path.startsWith(`${REPORT_DIR}/`)) found.add(path);
    }
  }
  return [...found].sort();
}
```

```ts
/**
 * The four tests, in order, first one wins. A missing file has no lines to
 * be out of range and no content to have drifted, so emitting more than one
 * fact for one citation would be one finding said four ways.
 *
 * Which tests a citation is eligible for follows from its form and no other
 * rule: missing_file applies to both forms; line_out_of_range and
 * content_drift to the path-and-line form only, since they need a line
 * number; quote_absent to the quoted form only, since it needs a phrase. A
 * form is never checked by a test it has no input for.
 *
 * With no baseline — blame failed, or the historical-read budget is spent —
 * only the first test runs, ungated, against the reviewed revision. That is
 * the one place a false positive is reachable, and it is disclosed in the
 * same breath by `blameUnavailableNote` or `baselineReadsCappedNote`.
 */
async function checkCitation(args: {
  file: string;
  citation: Citation;
  baseline: string | undefined;
  now: string;
  touched: Set<string>;
  sweep: boolean;
  readAt: (rev: string, path: string) => Promise<string | null>;
  readHistorical: (rev: string, path: string) => Promise<string | null> | undefined;
  onRefusedBaseline: () => void;
}): Promise<CitationRot | undefined> {
  const { file, citation, baseline, now, touched, sweep, readAt, readHistorical } = args;
  const isProse = isProseFile(file);

  // Repository-root-relative first, which is how every path in this codebase
  // is spelled and how `git show <rev>:<path>` resolves; then relative to
  // the citing file's own directory, for prose only. A comment in `src/x.ts`
  // that names `report/model.ts` means the repository path, and resolving it
  // against `src/` would invent a file.
  const spellings = [normalizePath(citation.path)];
  if (isProse && dirOf(file) !== "") {
    spellings.push(normalizePath(`${dirOf(file)}/${citation.path}`));
  }

  let citedFile: string | undefined;
  let baselineText: string | null = null;
  if (baseline === undefined) {
    // Existence-only: resolve against the reviewed revision, since there is
    // no baseline to resolve against.
    for (const spelling of spellings) {
      if ((await readAt(now, spelling)) !== null) return undefined;
      citedFile ??= spelling;
    }
    return {
      rot: "missing_file",
      citingFile: file,
      citingLine: citation.citingLine,
      citingText: citation.citingText,
      citedFile: citedFile!,
      ...(citation.line === undefined ? {} : { citedLine: citation.line }),
      ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
      ...(citation.quote === undefined ? {} : { quote: citation.quote }),
      citedTouched: touched.has(citedFile!),
    };
  }

  for (const spelling of spellings) {
    const read = readHistorical(baseline, spelling);
    if (read === undefined) {
      args.onRefusedBaseline();
      return undefined;
    }
    const text = await read;
    if (text !== null) {
      citedFile = spelling;
      baselineText = text;
      break;
    }
  }
  // Resolved neither way at the baseline: the citation never resolved, and
  // urtext cannot tell a typo from an illustration from a plan for a file
  // that does not exist yet. It says nothing.
  if (citedFile === undefined || baselineText === null) return undefined;

  // The default mode's exact filter, applied on the resolved path.
  const citedTouched = touched.has(citedFile);
  if (!sweep && !citedTouched) return undefined;

  const common = {
    citingFile: file,
    citingLine: citation.citingLine,
    citingText: citation.citingText,
    citedFile,
    baseline,
    citedTouched,
  };

  const nowText = await readAt(now, citedFile);
  if (nowText === null) {
    return {
      rot: "missing_file",
      ...common,
      ...(citation.line === undefined ? {} : { citedLine: citation.line }),
      ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
      ...(citation.quote === undefined ? {} : { quote: citation.quote }),
    };
  }

  const baseLines = linesOf(baselineText);
  const nowLines = linesOf(nowText);

  if (citation.line !== undefined) {
    const last = citation.endLine ?? citation.line;
    // Gate: a citation to a line the file never had is a typo, not rot.
    if (citation.line > baseLines.length || last > baseLines.length) return undefined;
    if (citation.line > nowLines.length || last > nowLines.length) {
      return {
        rot: "line_out_of_range",
        ...common,
        citedLine: citation.line,
        ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
        lineCount: nowLines.length,
      };
    }
  }

  if (citation.quote !== undefined) {
    // Containment, not equality, and normalization on both sides, so
    // re-wrapping a source comment does not fire this and a genuine
    // rewording does.
    if (!normalizeText(baselineText).includes(citation.quote)) return undefined;
    if (!normalizeText(nowText).includes(citation.quote)) {
      return { rot: "quote_absent", ...common, quote: citation.quote };
    }
    return undefined;
  }

  if (citation.line !== undefined) {
    const last = citation.endLine ?? citation.line;
    for (let n = citation.line; n <= last; n++) {
      // Compared with leading and trailing whitespace stripped per line: a
      // pure re-indent moves no content, and reporting it would be noise a
      // reader cannot act on. For a range, the first differing line is the
      // one reported.
      const was = baseLines[n - 1] ?? "";
      const current = nowLines[n - 1] ?? "";
      if (was.trim() === current.trim()) continue;
      return {
        rot: "content_drift",
        ...common,
        citedLine: citation.line,
        ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
        was: truncateLine(was.trim()),
        now: truncateLine(current.trim()),
        // The cited line as it currently stands, taken from text already in
        // hand so the analyzer composing `evidence[1]` never reads it again.
        citedText: current.trim(),
      };
    }
  }

  return undefined;
}
```

One note for the reviewer of this task: `citedText` is set on `content_drift` and on no other kind, deliberately. `missing_file` has no file to read a line from and `line_out_of_range`'s line is past the end, so in both there is no current text to show — and Task 3 only pushes `evidence[1]` when `citedLine` and `citedText` are both present, because a `verified` finding whose second evidence ref carried an empty excerpt would ask the reader to take it on faith, the same reason `blastRadiusAnalyzer` drops a fact whose anchor excerpt is blank. `quote_absent` names no line at all, so it has no second ref either.

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run test/analyze/citations-rot.test.ts`
Expected: PASS, every case. If the degradation test's `vi.doMock` ordering fights the module graph, move the mocked-module cases into their own file (`test/analyze/citations-degraded.test.ts`) rather than weakening the assertion — the call-count and blame-failure assertions are two of the five named mutation checks and must stay real.

- [ ] **Step 5: Register the caps in the comment contract**

> ### ⚠ STOP AND READ — this edit binds the entire repository, permanently.
>
> **CONTROLLER RULING (made — do not re-open): register THREE.**
> `MAX_CITING_FILES`, `MAX_CITATIONS_CHECKED`, `MAX_BASELINE_READS` — the values
> that reach a user-facing disclosure sentence, where a second copy could drift.
> `MAX_QUOTE_CHARS` is **excluded**: a cut is marked with
> `CITATION_TRUNCATION_MARKER`, never with a number, so no second copy exists for
> a comment to contradict — registering it would tax every comment in the
> repository to guard a drift that cannot happen. The drafter's reasoning below
> is adopted; the Testing section wins over the "Named caps" prose. Re-run the
> "value appears nowhere as a numeral" scan immediately before the commit, since
> the tree moves under this plan.
>
> Adding a value to `FORBIDDEN` in `test/comment-contract.test.ts` forbids that
> **numeral in every comment in `src/` and `test/`, forever** — not just in this
> feature's files. A future author writing an unrelated comment in an unrelated
> module gets a test failure naming a citation constant they have never heard
> of. This is a real, permanent tax, and it must be paid only where it buys
> something.
>
> **The spec contradicts itself about how many values to register.** Its "Named
> caps" prose says the plan "registers the **first four** in
> `test/comment-contract.test.ts`'s `FORBIDDEN` set" — that is
> `MAX_CITATIONS_CHECKED`, `MAX_CITING_FILES`, `MAX_BASELINE_READS`, and
> `MAX_QUOTE_CHARS`. Its Testing section says the contract stays green "with
> `citation_rot`'s weight and the **three disclosed caps** registered in
> `FORBIDDEN`".
>
> **Resolution — register three, not four.** Register `MAX_CITING_FILES`,
> `MAX_CITATIONS_CHECKED`, and `MAX_BASELINE_READS`. Do **not** register
> `MAX_QUOTE_CHARS`. The reasons, in the order they matter:
>
> 1. **The contract guards against drift between a comment and a value a reader
>    can also see somewhere else.** The three disclosed caps each produce a
>    user-facing sentence when they bite (`citingFilesCappedNote`,
>    `citationsCappedNote`, `baselineReadsCappedNote`), so a future author
>    explaining one of those notes is exactly the author who might restate its
>    bound in a comment. `MAX_QUOTE_CHARS` reaches no note, no body, no title,
>    and no USAGE line: a cut is marked with `CITATION_TRUNCATION_MARKER`, which
>    is not a number. There is no second copy for a comment to drift against.
> 2. **The house already registers far less than this.** `FORBIDDEN` today
>    carries the `WEIGHTS` tables, `MAX_EVIDENCE`, `MAX_SIGNATURE_LENGTH`, and
>    `MAX_RENDERED_SIGNATURE`. The immediately preceding feature registered
>    *nothing* — `MAX_INTENT_COMMITS` and `MAX_INTENT_MESSAGE_CHARS` are both
>    unregistered. Three is already more than precedent; four is more still.
> 3. **Over-registration costs more than it saves.** `240` is an ordinary
>    numeral — a code-point budget, a width, a timeout — and forbidding it
>    repo-wide forever taxes comments in modules that have nothing to do with
>    citations. The predictable response to a guard that fires on innocent
>    prose is to route around it ("two hundred and forty"), which weakens the
>    guard everywhere, including where it earns its keep.
> 4. **`citation_rot`'s weight needs no line at all.** The file's existing
>    `for (const [key, value] of Object.entries(WEIGHTS.factKind))` loop
>    registers it automatically the moment Task 3 adds the weight. Do not add a
>    `remember(...)` for it; a hand-written duplicate would be the very defect
>    this test exists to catch.
> 5. **`MAX_GREP_TERMS` and `CITATION_TRUNCATION_MARKER` are not registered**,
>    per the spec: the first is a batch width no comment would restate, the
>    second is not a number.
>
> **Verified before writing this:** a scan of every `.ts` comment in `src/` and
> `test/` for the numerals `18`, `320`, `480`, `2000`, and `240` found zero
> occurrences, so all three registrations (and the weight's automatic one) are
> safe today. Re-run that scan before committing — a comment added between now
> and then would fail the guard in a file this feature never touched.
>
> If the controller prefers the "first four" reading, the change is one extra
> `remember(MAX_QUOTE_CHARS, "MAX_QUOTE_CHARS")` line and nothing else. Raise it
> as a ruling rather than deciding it silently.

Add to `test/comment-contract.test.ts`, beside the existing `remember` calls:

```ts
import {
  MAX_BASELINE_READS,
  MAX_CITATIONS_CHECKED,
  MAX_CITING_FILES,
} from "../src/analyze/citations.js";
```

```ts
remember(MAX_CITING_FILES, "MAX_CITING_FILES");
remember(MAX_CITATIONS_CHECKED, "MAX_CITATIONS_CHECKED");
remember(MAX_BASELINE_READS, "MAX_BASELINE_READS");
```

Then run `npx vitest run test/comment-contract.test.ts` and confirm it is green. If it is not, the failure names the offending comment and the constant it duplicates: fix the comment, never the guard.

- [ ] **Step 6: Mutation checks**

Restore each line after its check, and report the observed failure.

1. **Delete the baseline gate.** In `checkCitation`, replace the resolution loop's "resolved neither way" early return with a fallback that resolves against `now` instead. `npx vitest run test/analyze/citations-rot.test.ts` must fail *"says nothing about a citation that never resolved, for missing_file"*. Restore. (Do the same for the two other gates — the `citation.line > baseLines.length` return and the `!normalizeText(baselineText).includes(...)` return — each must fail its own named test.)
2. **Delete the blame memoization.** Replace `blameOf`'s map lookup with an unconditional `git(...)` call. The same file must fail *"runs one blame per citing file, not one per citation"* on the call-count assertion. Restore.

- [ ] **Step 7: Full-suite gate**

- `npx vitest run` (BARE)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" src/analyze/citations.ts test/analyze/citations-rot.test.ts test/comment-contract.test.ts` → `0`

Nothing outside `citations.ts` consumes `findCitationRot` yet, so the rest of the suite must still be untouched.

- [ ] **Step 8: Commit**

```bash
git add src/analyze/citations.ts test/analyze/citations-rot.test.ts test/comment-contract.test.ts
git commit -m "feat(analyze): date each citation against the commit that last wrote it and check for rot"
```

---

### Task 3: The analyzer, the fact kind, and its one sentence on each surface

Turns `CitationRot[]` into `Fact[]` and carries a `citation_rot` finding through scoring, the report model, and all four renderers. The factory lands here rather than in Task 4 because `ANALYZERS` cannot register `citationsAnalyzer` without it — an adjustment to the controller's sketch, made so each task stays independently runnable.

**Files:**
- Modify: `src/analyze/citations.ts` (the factory and fact construction)
- Modify: `src/analyze/index.ts`, `src/types.ts`, `src/score/index.ts`, `src/report/model.ts`, `src/report/html.ts`
- Test: extend `test/analyze/citations-rot.test.ts`, `test/analyze/index.test.ts`, `test/score/index.test.ts`, `test/report/model.test.ts`, `test/report/terminal.test.ts`, `test/report/html.test.ts`, `test/report/markdown.test.ts`, `test/report/pdf.test.ts`, `test/report/copy-guard.test.ts`

**Interfaces:**
- Consumes: `makeFact`, `MAX_EVIDENCE` from `./fact.js`; `Analyzer`, `Fact`, `EvidenceRef`, `FactKind`, `Subject` from `../types.js` / `../report/model.js`; Task 2's `findCitationRot` and `CitationRot`.
- Produces:

```ts
// src/analyze/citations.ts
export interface CitationsOptions {
  sweep?: boolean;
  onNote?: (note: string) => void;
}
export function makeCitationsAnalyzer(options?: CitationsOptions): Analyzer;
/**
 * The default-mode instance, and the member of ANALYZERS. Also the identity
 * `review` matches on when it swaps in a configured instance, so it must stay
 * a single shared value rather than being reconstructed per call.
 */
export const citationsAnalyzer: Analyzer;

// src/analyze/index.ts
export { citationsAnalyzer, makeCitationsAnalyzer } from "./citations.js";
export const ANALYZERS: Analyzer[]; // five members

// src/types.ts
export type FactKind = /* ... */ | "citation_rot";

// src/score/index.ts — WEIGHTS.factKind.citation_rot, and one toFinding case

// src/report/model.ts
export type Subject = "effect" | "guard" | "surface" | "reach" | "citation";
```

`CitationsOptions` and `CitationScanOptions` are the same shape by design; declare `CitationsOptions` as the exported name the spec gives and have `CitationScanOptions` be an alias of it (`export type CitationScanOptions = CitationsOptions;`) so there is one field list, not two that can drift.

- [ ] **Step 1: Write the failing tests**

Append to `test/analyze/citations-rot.test.ts` (its `makeRepo`/`write`/`commit` helpers apply):

```ts
describe("the analyzer", () => {
  it("anchors the fact on the citing line and shows the cited line as it now stands", async () => {
    const repo = makeRepo("urtext-analyzer-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f.kind).toBe("citation_rot");
    expect(f.id).toBe("citation_rot:docs/a.md:1:content_drift");
    // The reader's work is at the prose, so Fact.file/line name the prose.
    expect(f.file).toBe("docs/a.md");
    expect(f.line).toBe(1);
    expect(f.evidence[0].file).toBe("docs/a.md");
    expect(f.evidence[0].side).toBe("after");
    // The now half of a drift is shown rather than asserted.
    expect(f.evidence[1].file).toBe("src/a.ts");
    expect(f.evidence[1].excerpt).toBe("export const limit = 99;");
    expect(f.detail.rot).toBe("content_drift");
    expect(f.detail.was).toBe("export const limit = 1;");
  });

  it("carries no qualifiedSymbol, so no grouping or absorption pass can see it", async () => {
    // A citation is about a file and a line, not a symbol. This also keeps
    // citation facts out of foldReach, which matches on file and symbol — a
    // citation fact must never absorb, or be absorbed by, a blast-radius fact
    // that happens to share a file.
    const repo = makeRepo("urtext-analyzer-nosym-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    expect(facts[0].qualifiedSymbol).toBeUndefined();
  });

  it("never stores the baseline text as evidence", async () => {
    // EvidenceRef.side distinguishes the before and after sides of the
    // REVIEWED RANGE; the baseline is some other commit entirely, and a
    // before-side ref carrying its line number would send a reader to a line
    // in a revision the report never names.
    const repo = makeRepo("urtext-analyzer-noside-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    expect(facts[0].evidence.every((e) => e.side !== "before")).toBe(true);
    expect(facts[0].evidence.some((e) => e.excerpt === "export const limit = 1;")).toBe(false);
    expect(facts[0].detail.was).toBe("export const limit = 1;");
  });

  it("names itself when it throws, so the disclosure never says analyzer #N", async () => {
    // `runAnalyzers` reports a failed analyzer by `analyzers[i].name`, and an
    // arrow returned directly from a factory has no name. The existing four
    // get their names from NamedEvaluation of a variable declaration; this one
    // has to do it one scope in.
    const notARepo = mkdtempSync(join(tmpdir(), "urtext-not-a-repo-"));
    const range = { from: "HEAD", to: WORKTREE, label: "test" };
    const changeset: Changeset = {
      range,
      files: [{ path: "src/a.ts", status: "modified", hunks: [], symbols: [] }],
    };
    const ctx: AnalysisContext = {
      cwd: notARepo,
      range,
      readAt: async () => null,
      programAt: () => {
        throw new Error("the citations analyzer must never build a program");
      },
    };
    const failures: AnalyzerFailure[] = [];
    const facts = await runAnalyzers(changeset, ctx, [makeCitationsAnalyzer()], (f) =>
      failures.push(f),
    );
    expect(facts).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].analyzer).toBe("citationsAnalyzer");
  });

  it("never builds the TypeScript program", async () => {
    // `ctx.programAt` parses every TS file in the repository; citation
    // checking needs text and comments, not types. The ctx above throws from
    // programAt, and the run above completed — but pin it on a working
    // repository too, where a call would otherwise succeed silently.
    const repo = makeRepo("urtext-analyzer-noprogram-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const real = createContext(repo, cs.range);
    const programAt = vi.fn(real.programAt);
    await makeCitationsAnalyzer()({ ...cs }, { ...real, programAt });
    expect(programAt).not.toHaveBeenCalled();
  });
});
```

(Add to that file's imports: `makeCitationsAnalyzer` from the module under test; `runAnalyzers`, `type AnalyzerFailure` from `../../src/analyze/index.js`; `WORKTREE`, `type AnalysisContext`, `type Changeset` from `../../src/types.js`.)

Append to `test/analyze/index.test.ts`:

```ts
  it("registers the citations analyzer under its own name", () => {
    expect(ANALYZERS.map((a) => a.name)).toContain("citationsAnalyzer");
  });
```

and change the existing count expectation — the one existing non-string expectation this feature moves:

```ts
  it("registers five analyzers", () => {
    expect(ANALYZERS).toHaveLength(5);
  });
```

Append to `test/score/index.test.ts`:

```ts
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
    evidence: [{ file: "docs/a.md", line: 1, excerpt: "The limit is set at src/a.ts:1.", side: "after" }],
    ...over,
  });

  it("scores the weight itself, with no scaling", () => {
    // A citation is rotted or it is not; inventing a severity for "how
    // rotted" would be a judgment nothing here supports.
    expect(scoreFact(rotFact())).toBe(WEIGHTS.factKind.citation_rot);
  });

  it("leaves minPossibleAnalyzerScore, and therefore MODEL_CEILING, exactly where it was", () => {
    // A silent shift here would re-rank every model finding in every report
    // for a reason no reader could see.
    expect(minPossibleAnalyzerScore()).toBe(
      WEIGHTS.factKind.effect_removed * WEIGHTS.effect.timing,
    );
    expect(MODEL_CEILING).toBe(minPossibleAnalyzerScore() * MODEL_CEILING_FRACTION);
  });

  it("composes one title and one body per rot kind, and never a causal claim", () => {
    const drift = toFinding(rotFact());
    expect(drift.title).toBe("cites `src/a.ts:1`, which no longer reads the same");
    expect(drift.body).toContain("When this line was last written (3f2a1c9)");
    expect(drift.body).toContain("It now reads `export const limit = 99;`");
    expect(drift.body).toContain("urtext does not know whether the new line is what this sentence meant.");
    // The amendment the spec makes binding: there is no "which this change
    // moved" variant, and membership of the cited path in the changed set is
    // stated as a fact in the body, never as a cause in the title.
    expect(drift.title).not.toContain("moved");
    expect(drift.body).not.toContain("This change touched");

    const touched = toFinding(rotFact({ detail: { ...rotFact().detail, citedTouched: true } }));
    expect(touched.title).toBe(drift.title);
    expect(touched.body).toContain("This change touched `src/a.ts`.");

    const missing = toFinding(
      rotFact({ detail: { rot: "missing_file", citedFile: "src/gone.ts", citedLine: 1, baseline: "3f2a1c9" } }),
    );
    expect(missing.title).toBe("cites `src/gone.ts`, which is not in this repository any more");
    expect(missing.body).toContain("is not present at this revision");

    const range = toFinding(
      rotFact({ detail: { rot: "line_out_of_range", citedFile: "src/a.ts", citedLine: 3, lineCount: 1, baseline: "3f2a1c9" } }),
    );
    expect(range.title).toBe("cites `src/a.ts:3`, which is past the end of that file");
    expect(range.body).toContain("has 1 lines at this revision");

    const quote = toFinding(
      rotFact({ detail: { rot: "quote_absent", citedFile: "src/a.ts", quote: "keeps the door shut", baseline: "3f2a1c9" } }),
    );
    expect(quote.title).toBe("cites `src/a.ts` for a quoted phrase that is not in it");
    expect(quote.body).toContain("it does not know whether the text moved, was reworded, or was deliberately dropped");
  });

  it("claims nothing about history it could not read", () => {
    // The degraded, existence-only finding: with no baseline there is no
    // commit to name and no proof the file was ever there, so the copy must
    // not borrow the gated wording. See Ambiguity 2 in this plan.
    const undated = toFinding(
      rotFact({ detail: { rot: "missing_file", citedFile: "src/gone.ts", citedLine: 1 } }),
    );
    expect(undated.title).toBe("cites `src/gone.ts`, which is not in this repository at this revision");
    expect(undated.body).not.toContain("existed when this line was last written");
    expect(undated.body).toContain("could not read this line's history");
  });
});
```

(Extend that file's imports with `MODEL_CEILING`/`MODEL_CEILING_FRACTION` from `../../src/score/reconcile.js` if they are not already there; if `MODEL_CEILING_FRACTION` is not exported, assert `MODEL_CEILING` against a snapshot of its current numeric value read from the module instead of recomputing it — the point is only that it does not move.)

Append to `test/report/model.test.ts`:

```ts
  it("routes a citation finding to its own subject and the narrative lens", () => {
    // Its own subject rather than a reuse of `reach`, because the HTML's
    // effects pane filters on subject directly, and folding citations into
    // reach would make that pane's note describe something it is not.
    const model = buildReportModel(
      changeset,
      [finding({ id: "citation_rot:docs/a.md:1:content_drift", tier: "verified" })],
      meta(),
    );
    expect(model.findings[0].subject).toBe("citation");
    expect(model.findings[0].lens).toBe("narrative");
  });
```

Append one test each to `test/report/terminal.test.ts`, `test/report/html.test.ts`, `test/report/markdown.test.ts`, and `test/report/pdf.test.ts`, in each file's established per-surface pattern: a model containing one citation finding renders its headline, its body, and both evidence refs. In `test/report/html.test.ts`, additionally:

```ts
  it("names citation findings in the effects pane's note about what it does not show", () => {
    // The pane's note enumerates the kinds it does not show, and its comment
    // records that naming only one had already misled a reader once. A third
    // kind arriving without a clause would make that sentence false in
    // urtext's own voice, in the one place the tier badges do not reach.
    const html = renderHtml(noSymbols, [finding({ id: "citation_rot:docs/a.md:1:content_drift" })], meta());
    const effects = lens(html, "effects");
    expect(effects).toContain("citation");
    expect(effects).toContain("narrative");
  });
```

Extend `test/report/copy-guard.test.ts` with a second guard over a citation fixture:

```ts
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

const citationFindings: Finding[] = (["missing_file", "line_out_of_range", "quote_absent", "content_drift"] as const).map(
  (rot, i) =>
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
```

(`citationSurfaces()` is a copy of the existing `surfaces()` helper taking `citationFindings` and a `meta` whose `warnings` are the four citation disclosure sentences from Task 2; `scannable` is reused unchanged. Import `toFinding` from `../../src/score/index.js`.)

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/analyze test/score test/report`
Expected: FAIL — TypeScript rejects `"citation_rot"` as a `FactKind`; `WEIGHTS.factKind.citation_rot`, `makeCitationsAnalyzer`, and `Subject`'s `"citation"` member do not exist; `ANALYZERS` has four members.

- [ ] **Step 3: `src/types.ts`**

```ts
export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed"
  | "export_added"
  | "export_removed"
  | "signature_changed"
  | "blast_radius"
  | "citation_rot";
```

Adding it is a compile error in two places by construction, and both are the point: `WEIGHTS.factKind` (`satisfies Record<Fact["kind"], number>`) and `SUBJECT_OF_KIND` in `src/report/model.ts` (`satisfies Record<FactKind, Subject>`). A new kind cannot silently reach a report unweighted or unclassified.

- [ ] **Step 4: `src/score/index.ts`**

One weight, transcribed with its comment:

```ts
    // A rotted citation is a defect in the repository's account of itself, not
    // in its behavior: nothing a reader merges is broken by it. So it sits
    // above the kinds that report cost rather than a problem, and below the
    // kinds that report new public surface or a regression. See
    // `test/score/index.test.ts`.
    citation_rot: 18,
```

`scoreFact` needs no new branch: `citation_rot` falls through to `return base`, like `guard_removed` and the export kinds.

One `toFinding` case. Titles are lowercase-led, because every renderer prefixes them with `file:line — `.

```ts
    case "citation_rot": {
      const cited = str(fact.detail.citedFile, "the cited file");
      const start = num(fact.detail.citedLine, 0);
      const end = num(fact.detail.citedEndLine, 0);
      // The citation as the prose wrote it: a line, a range, or — for the
      // quoted form — no line at all.
      const at = start === 0 ? "" : end === 0 ? `:${start}` : `:${start}-${end}`;
      const spanned = end !== 0;
      const hash = fact.detail.baseline;
      const dated = isNonEmptyString(hash);
      const when = dated ? `when this line was last written (${hash})` : "";
      switch (fact.detail.rot) {
        case "missing_file":
          if (!dated) {
            // No baseline means no commit to name and no proof the path was
            // ever there, so this branch claims neither. See this plan's
            // Ambiguity 2.
            title = `cites \`${cited}\`, which is not in this repository at this revision`;
            body = `This line cites \`${cited}${at}\`. That path is not present at this revision. urtext could not read this line's history here, so it does not know whether the citation ever resolved.`;
            break;
          }
          title = `cites \`${cited}\`, which is not in this repository any more`;
          body = `This line cites \`${cited}${at}\`. That file existed ${when} and is not present at this revision, so the citation does not resolve. What it was meant to point at is not something urtext can recover.`;
          break;
        case "line_out_of_range": {
          const count = num(fact.detail.lineCount, 0);
          title = `cites \`${cited}${at}\`, which is past the end of that file`;
          body = `\`${cited}\` has ${count} lines at this revision, so ${spanned ? `lines ${start}-${end} are not all in it` : `line ${start} is not in it`}. The citation resolved ${when}; it resolves to nothing now.`;
          break;
        }
        case "quote_absent": {
          const phrase = str(fact.detail.quote, "the quoted phrase");
          title = `cites \`${cited}\` for a quoted phrase that is not in it`;
          body = `This line cites \`${cited}\` and quotes “${phrase}”. That text was in \`${cited}\` ${when} and is not in it at this revision. urtext compares the quoted text against the file's contents; it does not know whether the text moved, was reworded, or was deliberately dropped.`;
          break;
        }
        default: {
          const was = str(fact.detail.was, "something else");
          const current = str(fact.detail.now, "something else");
          title = `cites \`${cited}${at}\`, which no longer reads the same`;
          // Membership of the cited path in the changed set is proven, so the
          // body states exactly that and nothing more. Attributing the
          // movement to the reviewed change would be a causal claim under a
          // verified badge that the evidence does not carry.
          const touched = fact.detail.citedTouched === true ? ` This change touched \`${cited}\`.` : "";
          body = `When this line was last written (${hash}), \`${cited}${at}\` read \`${was}\`. It now reads \`${current}\`. The citation still resolves to a line; it no longer resolves to the same content. urtext does not know whether the new line is what this sentence meant.${touched}`;
        }
      }
      break;
    }
```

Each body's closing sentence is the trust boundary made explicit at the point of the claim, in the same spirit as `MODEL_CAUTION_CLAIM` in `../report/model.ts`: state what was checked, then state what was not.

- [ ] **Step 5: `src/report/model.ts`, `src/report/html.ts`, `src/analyze/index.ts`**

```ts
export type Subject = "effect" | "guard" | "surface" | "reach" | "citation";
```

```ts
  citation_rot: "citation",
```
in `SUBJECT_OF_KIND`, and

```ts
  citation: "narrative",
```
in `LENS_OF_SUBJECT`. A rotted citation is not an effect, not a guard, and not a change to the public surface; it belongs to the account of what this change did, which is what the narrative is. The narrative shows every finding regardless of lens, so nothing is hidden by this routing.

In `src/report/html.ts`, `effectsLens`'s note gains one clause and its comment gains one sentence. **This is the only existing expected string in the repository that changes.**

```ts
  // Names all three kinds of finding this lens does not show. It used to name
  // only the first, while the model classifies a standalone reach finding
  // under a subject no section filters on — so a reader was told the
  // narrative held nothing extra except model claims, and it held that too.
  // A citation finding is the third, for the same reason and with the same
  // cost if it goes unnamed.
  const note = `<p class="blurb">Built from what the analyzers proved, and not the whole list. A model-only claim has no analyzer behind it to classify. A standalone reach finding — a changed export with callers, and nothing else known about it — reports cost rather than a problem, and belongs to none of these three. A citation finding — prose in this repository whose pointer into the code no longer resolves the same way — belongs to none of them either. All three appear in the narrative.</p>`;
```

In `src/analyze/index.ts`:

```ts
import { citationsAnalyzer } from "./citations.js";

export { citationsAnalyzer, makeCitationsAnalyzer } from "./citations.js";

export const ANALYZERS: Analyzer[] = [
  effectsAnalyzer,
  guardsAnalyzer,
  surfaceAnalyzer,
  blastRadiusAnalyzer,
  citationsAnalyzer,
];
```

- [ ] **Step 6: The factory and fact construction, in `src/analyze/citations.ts`**

```ts
import { makeFact, MAX_EVIDENCE } from "./fact.js";
import type { Analyzer, EvidenceRef, Fact } from "../types.js";

export type CitationsOptions = CitationScanOptions;

/**
 * Returns its analyzer through a NAMED binding, and this is load-bearing:
 * `runAnalyzers` reports a failed analyzer by `analyzers[i].name`, and an
 * arrow returned directly from a factory has no name, so a citation analyzer
 * that threw would be disclosed to the user as a numbered anonymous one. The
 * existing four get their names from exactly this mechanism (NamedEvaluation
 * of a variable declaration); this one has to do it one scope in. See
 * `test/analyze/citations-rot.test.ts`, "names itself when it throws, so the
 * disclosure never says analyzer #N".
 */
export function makeCitationsAnalyzer(options: CitationsOptions = {}): Analyzer {
  const citationsAnalyzer: Analyzer = async (changeset, ctx): Promise<Fact[]> => {
    const rots = await findCitationRot(changeset, ctx, options);
    return rots.map((rot) => {
      // evidence[0] is the citing line, so Fact.file/Fact.line land on the
      // prose the reader has to fix. evidence[1], when the cited file and
      // line exist now, is the cited location as it currently stands — the
      // "now" half of a drift, shown rather than asserted. The baseline
      // content is deliberately never an EvidenceRef: `side` distinguishes
      // the before and after sides of the reviewed range, and the baseline
      // is some other commit entirely. It lives in `detail.was` and in the
      // finding body, where the commit that produced it is named beside it.
      const evidence: EvidenceRef[] = [
        {
          file: rot.citingFile,
          line: rot.citingLine,
          excerpt: rot.citingText,
          side: "after",
        },
      ];
      if (rot.citedLine !== undefined && rot.citedText !== undefined) {
        evidence.push({
          file: rot.citedFile,
          line: rot.citedLine,
          excerpt: rot.citedText,
          side: "after",
        });
      }
      return makeFact({
        // The kind and a colon, which is the convention `subjectOf` in
        // `../report/model.ts` recovers the lens from. The citing location
        // plus the rot kind is the identity: one citing line can carry two
        // citations, and both may rot. `qualifiedSymbol` is omitted — a
        // citation is about a file and a line, not a symbol.
        id: `citation_rot:${rot.citingFile}:${rot.citingLine}:${rot.rot}`,
        kind: "citation_rot",
        detail: {
          rot: rot.rot,
          citedFile: rot.citedFile,
          ...(rot.citedLine === undefined ? {} : { citedLine: rot.citedLine }),
          ...(rot.citedEndLine === undefined ? {} : { citedEndLine: rot.citedEndLine }),
          ...(rot.quote === undefined ? {} : { quote: rot.quote }),
          ...(rot.was === undefined ? {} : { was: rot.was }),
          ...(rot.now === undefined ? {} : { now: rot.now }),
          ...(rot.baseline === undefined ? {} : { baseline: abbreviate(rot.baseline) }),
          ...(rot.lineCount === undefined ? {} : { lineCount: rot.lineCount }),
          citedTouched: rot.citedTouched,
        },
        // Shared with the analyzers that sample evidence, so the cap cannot
        // drift between them, though a citation fact never has more than two
        // refs today.
        evidence: evidence.slice(0, MAX_EVIDENCE),
      });
    });
  };
  return citationsAnalyzer;
}

export const citationsAnalyzer: Analyzer = makeCitationsAnalyzer();
```

`abbreviate` is a local one-liner taking the hash's leading short-hash width; write it with the width as a named constant (`const ABBREVIATED_HASH = 7;`) and never spell that number in a comment.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/analyze test/score test/report`
Expected: PASS, with every pre-existing test in those directories green and unedited apart from the analyzer-count expectation named in Step 1 and the effects-pane sentence in Step 5.

- [ ] **Step 8: Mutation check**

**Delete the named binding.** Replace `makeCitationsAnalyzer`'s body with `return async (changeset, ctx) => { ... };`. `npx vitest run test/analyze/citations-rot.test.ts` must fail *"names itself when it throws, so the disclosure never says analyzer #N"* — the reported name becomes the numbered fallback. Restore, and report the observed message.

- [ ] **Step 9: Full-suite gate**

- `npx vitest run` (BARE)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" src/analyze/citations.ts src/analyze/index.ts src/types.ts src/score/index.ts src/report/model.ts src/report/html.ts` → `0`

- [ ] **Step 10: Commit**

```bash
git add src/analyze src/types.ts src/score/index.ts src/report/model.ts src/report/html.ts test/analyze test/score test/report
git commit -m "feat(analyze): report a rotted citation as a verified finding on every surface"
```

---

### Task 4: `--citations`, the sweep mode, and the disclosure channel

The last wire. The flag, one `USAGE` entry, the identity swap that hands the configured instance its `onNote`, and the end-to-end proof that a disclosure sentence reaches a `Note:` line and `--json`'s `warnings`.

**Files:**
- Modify: `src/cli.ts`
- Test: extend `test/cli.test.ts`

**Interfaces:**
- Consumes: `citationsAnalyzer`, `makeCitationsAnalyzer` from `./analyze/index.js` (Task 3's exports).
- Produces:

```ts
export interface CliOptions {
  // ... unchanged fields ...
  /**
   * Sweep every citation in the repository rather than only those pointing
   * into changed files. Optional like `open` and `exportFormats`: every
   * pre-existing caller constructs a `CliOptions` literal without it.
   */
  citations?: boolean;
}
```

No new `--json` key, no new flag beyond `--citations`, no change to the exit-code matrix. `allAnalyzersFailed` compares `failureCount` against `analyzers.length`, which is now five and which the identity swap leaves unchanged in length.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts`:

```ts
describe("--citations", () => {
  it("parses the flag, and still rejects a near miss", () => {
    expect(parseArgs(["review", "--citations"]).citations).toBe(true);
    expect(parseArgs(["review"]).citations).toBeUndefined();
    expect(() => parseArgs(["review", "--citation"])).toThrow(/Unknown option: --citation\b/);
  });

  it("names the flag in USAGE without saying any of the eight words", () => {
    expect(USAGE).toContain("--citations");
    const usage = USAGE.toLowerCase();
    for (const word of ["wrong", "incorrect", "outdated", "obsolete", "misleading", "broken"]) {
      expect(usage.includes(word), word).toBe(false);
    }
    expect(/\bstale\b/.test(usage)).toBe(false);
  });

  it("reports a real rotted citation, and only under the flag when the cited file is untouched", async () => {
    const rotRepo = mkCanonicalTempDir("urtext-cli-citations-");
    const run = (args: string[]) => gitIn(rotRepo, args);
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    mkdirSync(join(rotRepo, "src"), { recursive: true });
    writeFileSync(join(rotRepo, "src", "limits.ts"), "export const limit = 1;\n");
    writeFileSync(join(rotRepo, "src", "other.ts"), "export const other = 1;\n");
    writeFileSync(join(rotRepo, "NOTES.md"), "The limit is set at src/limits.ts:1.\n");
    run(["add", "-A"]);
    run(["commit", "-m", "first"]);
    writeFileSync(join(rotRepo, "src", "limits.ts"), "export const limit = 99;\n");
    run(["add", "-A"]);
    run(["commit", "-m", "raise the limit"]);
    // The reviewed range touches only the other file.
    writeFileSync(join(rotRepo, "src", "other.ts"), "export const other = 2;\n");

    const base = { command: "review", json: true, noLlm: true, help: false } as const;
    const plain = JSON.parse((await review(rotRepo, { ...base })).output);
    expect(plain.findings.some((f: { id: string }) => f.id.startsWith("citation_rot:"))).toBe(false);

    const swept = JSON.parse((await review(rotRepo, { ...base, citations: true })).output);
    const rot = swept.findings.find((f: { id: string }) => f.id.startsWith("citation_rot:"));
    expect(rot).toBeDefined();
    expect(rot.tier).toBe("verified");
    expect(rot.file).toBe("NOTES.md");
    expect(rot.title).toContain("no longer reads the same");
    // Deterministic, so it runs in both — --citations is independent of
    // --no-llm.
    expect(swept.warnings.some((w: string) => w.includes("citation checking"))).toBe(false);
  });
});

describe("citation disclosure", () => {
  it("carries a note from the analyzer to a Note: line and to --json's warnings, and none when there is none", async () => {
    // Only the factory is mocked, and only to make a cap bite without
    // building a repository large enough to do it for real. `citationsAnalyzer`
    // itself stays the real exported value, because the swap in `review`
    // matches on that identity.
    const note = "citation checking scanned 2 of 4 candidate files, so citations in the other 2 were not checked";
    const options: unknown[] = [];
    vi.doMock("../src/analyze/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/analyze/index.js")>();
      return {
        ...actual,
        makeCitationsAnalyzer: (opts: { onNote?: (n: string) => void; sweep?: boolean }) => {
          options.push(opts);
          const citationsAnalyzer = async () => {
            opts.onNote?.(note);
            return [];
          };
          return citationsAnalyzer;
        },
      };
    });
    const { review: mocked } = await import("../src/cli.js");

    const term = await mocked(repo, { command: "review", json: false, noLlm: true, help: false, citations: true });
    expect(term.output).toContain(`Note: ${note}`);
    expect(options[0]).toMatchObject({ sweep: true });

    const json = await mocked(repo, { command: "review", json: true, noLlm: true, help: false });
    expect(JSON.parse(json.output).warnings).toContain(note);
    expect(options[1]).toMatchObject({ sweep: false });

    vi.doUnmock("../src/analyze/index.js");
    vi.resetModules();
  });

  it("surfaces no citation note at all when nothing was skipped", async () => {
    const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
    expect(JSON.parse(r.output).warnings.some((w: string) => w.includes("citation checking"))).toBe(false);
  });
});
```

(Add `mkdirSync` to the `node:fs` import and `vi` to the `vitest` import if they are not already there.)

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `CliOptions` has no `citations` field (a TypeScript error at each literal), `--citations` is rejected as an unknown option, `USAGE` does not name it, and no note reaches `warnings`.

- [ ] **Step 3: Edit `src/cli.ts`**

Add the field to `CliOptions` (the doc comment is in the Interfaces block above), the parse arm beside `--open`:

```ts
    else if (arg === "--citations") opts.citations = true;
```

one `USAGE` entry, in the existing column layout:

```
  --citations Check every path:line citation in this repository, not only the
              ones pointing into files this range touched
```

and the swap, immediately before the `runAnalyzers` call:

```ts
  // Swapped in by identity, which keeps the `analyzers` parameter's existing
  // default and every test that passes its own list working untouched: a
  // hand-built list contains no `citationsAnalyzer`, so the map is a no-op
  // for it. The disclosure channel is the same `warnings` array every other
  // shortfall uses — no new key anywhere.
  const runnable = analyzers.map((a) =>
    a === citationsAnalyzer
      ? makeCitationsAnalyzer({
          sweep: opts.citations === true,
          onNote: (note) => warnings.push(note),
        })
      : a,
  );
  const facts = await runAnalyzers(changeset, ctx, runnable, (f) => { /* unchanged */ });
```

(Extend the existing import from `./analyze/index.js` with `citationsAnalyzer` and `makeCitationsAnalyzer`.)

`--citations` is independent of `--no-llm`: citation checking is deterministic and runs in both.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS, with every pre-existing test in the file green and unedited.

- [ ] **Step 5: Verify against the real tool**

Run, from the urtext repository itself:

- `npx tsx src/bin.ts review HEAD~1 --no-llm` — exit 0, and any citation findings it reports are into files that revision touched.
- `npx tsx src/bin.ts review HEAD~1 --no-llm --citations` — exit 0. This is the audit run: it answers "is this repository's prose still true about its own code?"

Read the output and report honestly. Three things to check by hand, because no test can:

1. **Every reported citation is genuinely rotted.** Open two or three and confirm the cited line really has moved. A single false positive here is the failure this whole design exists to prevent, and the honest response is to raise a guard, not to soften the copy.
2. **No finding's prose attributes a cause.** No title says a change moved anything; the "This change touched …" sentence appears only in bodies, and only where the cited file really is in the changeset.
3. **The run is fast enough to leave on by default.** Time both. If the default run is not bounded by the change in practice, say so — the caps exist to bound the sweep, not to rescue a default mode that reads the repository.

- [ ] **Step 6: Full-suite gate**

- `npx vitest run` (BARE)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" src/cli.ts test/cli.test.ts` → `0`

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): --citations sweeps every citation in the repository"
```

---

## Self-review notes

**Spec coverage — every section to a task.**

| Spec section | Task |
|---|---|
| Purpose; the inverse-of-blast-radius framing | Architecture; Task 3's fact construction (no `qualifiedSymbol`, so `foldReach` never sees it) |
| The claim, exactly (all five consequences) | Global Constraints; Task 3 Step 4's copy and Step 1's "never a causal claim" test; Task 3 Step 6's copy guard |
| What counts as a citation — Form A, Form B, the two post-match rules, normalization | Task 1 |
| Where citations are looked for — prose, TS comments, the deliberate leaf-walk duplication, the unwrap and its offset map, `REPORT_DIR` | Task 1 (walk, unwrap, offset map); Task 2 (`REPORT_DIR` exclusion, both candidate queries) |
| The two modes; the `git grep` invocation; exit-one-is-absence; `MAX_GREP_TERMS` chunking | Task 2 (`touchedCandidates`, `sweepCandidates`, `isNoMatch`) |
| Resolving a cited path | Task 2 (`checkCitation`'s `spellings`, prose-only relative resolution) |
| The baseline gate; the blame command and parse; the two special baselines | Task 2 (`parseBlame`, `blameOf`, the uncommitted skip, the degradation branch) |
| Limitation: blame under-reports, deliberately | Global Constraints; Task 2's test named for the intended miss |
| The four rot tests, in order, first one wins | Task 2 (`checkCitation`) and its four named tests plus the first-wins test |
| The copy, per rot kind, incl. the controller's amendment (one `content_drift` title; membership in the body) | Task 3 Step 4, pinned by "composes one title and one body per rot kind, and never a causal claim" |
| Degradation (all three places) | Task 2 (existence-only path, `blameUnavailableNote`, the aggregated single note); Task 3 (the undated copy branch — see Ambiguity 2) |
| Cost discipline: one blame per file, one read per pair, no program | Task 2 (`blameOf`, `readAt`/`readHistorical` memos) and its call-count test; Task 3's "never builds the TypeScript program" |
| Named caps and cap disclosure copy | Task 2 Steps 3 and 5 |
| False-positive guards (all six, each named) | Task 1 (separator, fence, url, phrase); Task 2 (baseline, `REPORT_DIR`) |
| The analyzer: `CitationsOptions`, the factory, the named binding, `ANALYZERS` | Task 3 Steps 5, 6, 8 |
| Fact construction (id, no `qualifiedSymbol`, `evidence[0]`/`[1]`, no baseline evidence, `MAX_EVIDENCE`) | Task 3 Steps 1 and 6 |
| Types (`FactKind`) | Task 3 Step 3 |
| Score (weight, no `scoreFact` branch, `minPossibleAnalyzerScore` unchanged) | Task 3 Steps 1 and 4 |
| Report model and lens routing; the single effects-pane sentence | Task 3 Step 5 |
| CLI (flag, `USAGE`, identity swap, independence from `--no-llm`) | Task 4 |
| Unchanged, stated explicitly (exit codes, `MODEL_CEILING`, folding, interpretation, concealment, existing expectations) | Global Constraints; Task 3's `MODEL_CEILING` test and no-`qualifiedSymbol` test; Task 4's unchanged exit-code note |
| Testing (every bullet) | extraction + comment scanning → Task 1; four rot kinds, both gate directions, the under-report, uncommitted, degradation, caps, mode boundary, `REPORT_DIR` → Task 2; score, model, four surfaces, copy guard, comment contract → Task 3; CLI → Task 4; the five named mutation checks → Task 1 Step 5 (fence, separator), Task 2 Step 6 (baseline gate, blame memoization), Task 3 Step 8 (named binding) |
| Out of scope (auto-fix, URLs, cross-repository, non-git sources, new surfaces, bare-path citations, citation history) | appear in no task; the URL mask and the mandatory separator are the two that are enforced by code rather than by omission |

**Placeholder scan.** Every test step contains runnable code written against the real harnesses, named as they actually are: `test/extract/git.test.ts`'s `GIT_ISOLATION` flags and `mkdtempSync` pattern and `test/analyze/blast-radius.test.ts`'s `execFileSync` fixture shape for the rot repositories; `createContext(repo, cs.range)` and `extract(repo)` / `extract(repo, "HEAD")` from `src/extract/index.ts`; `test/cli.test.ts`'s `mkCanonicalTempDir` and `gitIn` helpers and its `review(cwd, opts)` signature; `test/report/copy-guard.test.ts`'s `scannable` and `surfaces()` helpers and its `unpdf` `getDocumentProxy`/`extractText` extraction; `test/report/html.test.ts`'s `lens()` helper and `noSymbols`/`finding`/`meta` fixtures; the `vi.mock`-with-`importOriginal` pattern the interpretation stage's tests established, used here for the `git()` call counter and the CLI's factory. Field names come from `src/types.ts` as it stands (`qualifiedSymbol`, `EvidenceRef.side`, `Fact.detail` as `Record<string, unknown>`, `ChangedFile.previousPath`). Two implementation steps deliberately say "transcribe verbatim from the spec" rather than repeating text — the regexes and their doc comments (Task 1 Step 3), the cap constants and their doc comments (Task 2 Step 3) — and both name the exact spec section; everything else carries full code plus the glue the spec leaves open (the fence state machine, the offset-carrying unwrap, the memo maps, the resolution order, the four tests' gate arithmetic, the note pluralization, the identity swap). No step says "similar to Task N".

**Type consistency across tasks.** `Citation` is defined once, in Task 1, and consumed by value only inside `citations.ts`. `CitationRot` is defined once, in Task 2, and never leaves the module: Task 3 maps it to `Fact` and nothing downstream imports it. `CitationsOptions` is the spec's exported name and `CitationScanOptions` is declared as an alias of it, so `sweep?: boolean` and `onNote?: (note: string) => void` have exactly one declaration. `RotKind` is a string union in the module and reaches the rest of the system only as `detail.rot`, a `string` inside `Record<string, unknown>` — read back defensively through the existing `str`/`num` helpers in `toFinding`, never cast. `FactKind` gains `"citation_rot"` in Task 3 and that single edit is what makes `WEIGHTS.factKind` and `SUBJECT_OF_KIND` fail to compile until both are extended, which is the mechanism the spec relies on. `Subject` gains `"citation"` in the same task, and `LENS_OF_SUBJECT` is a total `Record<Subject, Lens>`, so the routing entry is compulsory too. `citationsAnalyzer` is one shared `Analyzer` value, exported once, and Task 4's swap matches on that identity — reconstructing it per call would silently disable `--citations`. No task widens an existing signature: `runAnalyzers`, `reconcile`, `buildReportModel`, `renderTerminal`, `renderHtml`, `renderMarkdown`, and `renderPdf` are all called exactly as they are called today.

**Ambiguities found in the spec, and how this plan resolves them.** Each is a ruling for the controller; the plan proceeds on the resolution stated.

1. **`FORBIDDEN` registration: four values or three?** "Named caps" says the plan registers "the first four"; Testing says "the three disclosed caps". **Resolved: three** — `MAX_CITING_FILES`, `MAX_CITATIONS_CHECKED`, `MAX_BASELINE_READS` — with `MAX_QUOTE_CHARS` left out because it appears in no user-facing sentence, so there is no second copy for a comment to drift against, and because registering a numeral taxes every comment in the repository forever. `citation_rot`'s weight needs no line: the existing `WEIGHTS.factKind` loop registers it. Full argument in the boxed warning at Task 2, Step 5.
2. **The degraded `missing_file` copy asserts something the degraded path cannot prove.** The spec mandates existence-only checking when blame fails or the historical-read budget is spent, *and* gives `missing_file` a single body that says "That file existed when this line was last written (`${hash}`)" — with no baseline there is no hash and no proof the file was ever there. The title, "which is not in this repository any more", carries the same unprovable implication. Emitting that copy on the degraded path would put a fabricated historical claim under a `verified` badge, which is precisely the mistake "The claim, exactly" exists to prevent, arriving through phrasing rather than through logic. **Resolved: a second, weaker title and body for baseline-less findings** — "which is not in this repository at this revision", and a body that says the path is not present at this revision and that urtext could not read the citing line's history, so it does not know whether the citation ever resolved. The aggregated `blameUnavailableNote` / `baselineReadsCappedNote` sentence carries the rest. Pinned by Task 3's "claims nothing about history it could not read". The gated path's copy is unchanged and verbatim from the spec.
3. **"No existing expected string changes" versus `ANALYZERS` becoming five.** The spec says every existing test expectation is unchanged apart from the effects-pane sentence, and separately prints an `ANALYZERS` literal with five members. `test/analyze/index.test.ts` asserts `toHaveLength(4)` under the title "registers four analyzers". **Resolved: change it.** It is a count, not an expected string; the five-member array is explicit in the spec; and the spec's own "Unchanged, stated explicitly" section already reasons about `analyzers.length` being five. The test's title changes with its expectation, and this is the only existing expectation outside the effects-pane sentence that this feature moves. Called out at Task 3, Step 1 so it cannot be mistaken for drift.

Two smaller silences, resolved in code with a comment rather than raised as rulings: a Form B citation has no line number, so the `missing_file` body's `:${n}` suffix is composed only when a line exists (Task 3, the `at` local); and a reversed range (`45-12`) is left as a citation rather than given a new rejection rule — its slice is empty on both sides, so it produces no fact, which is the same under-reporting direction as every other approximation here.
