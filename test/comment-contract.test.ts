import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  MAX_BASELINE_READS,
  MAX_CITATIONS_CHECKED,
  MAX_CITING_FILES,
} from "../src/analyze/citations.js";
import { MAX_EVIDENCE } from "../src/analyze/fact.js";
import { MAX_SIGNATURE_LENGTH } from "../src/analyze/surface.js";
import { MAX_RENDERED_SIGNATURE, WEIGHTS } from "../src/score/index.js";

/**
 * Guards against the class of defect this project keeps reintroducing: a
 * comment that hand-copies a `WEIGHTS` number — or another named tuning
 * constant — instead of pointing at the constant. A hand-copied number and
 * the constant it duplicates can drift apart the moment either one changes
 * without the other; a value that appears in exactly one place cannot go
 * stale.
 *
 * The forbidden set is derived from the live constants, not hardcoded here —
 * that is the whole point. If a weight or cap changes, the set this test
 * checks against changes with it, automatically. And the scan covers test/
 * as well as src/: the contract binds all comments, and the first audit
 * found the restated-weight drift class concentrated exactly one directory
 * over from where the guard was looking.
 */
const FORBIDDEN: Map<number, string[]> = new Map();

function remember(value: number, name: string): void {
  const names = FORBIDDEN.get(value) ?? [];
  names.push(name);
  FORBIDDEN.set(value, names);
}

for (const [key, value] of Object.entries(WEIGHTS.factKind)) {
  remember(value, `WEIGHTS.factKind.${key}`);
}
for (const [key, value] of Object.entries(WEIGHTS.effect)) {
  remember(value, `WEIGHTS.effect.${key}`);
}
remember(MAX_EVIDENCE, "MAX_EVIDENCE");
remember(MAX_SIGNATURE_LENGTH, "MAX_SIGNATURE_LENGTH");
remember(MAX_RENDERED_SIGNATURE, "MAX_RENDERED_SIGNATURE");
remember(MAX_CITING_FILES, "MAX_CITING_FILES");
remember(MAX_CITATIONS_CHECKED, "MAX_CITATIONS_CHECKED");
remember(MAX_BASELINE_READS, "MAX_BASELINE_READS");

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (extname(entry) === ".ts") {
      out.push(full);
    }
  }
  return out;
}

interface CommentSpan {
  /** Absolute character offset of the comment's first character in the file. */
  start: number;
  text: string;
}

/**
 * Every `//` and `/* *\/` comment in a file, JSDoc included — JSDoc is just
 * a `/**` multi-line comment attached as leading trivia, so no special-
 * casing is needed for it.
 *
 * Walked off the parsed AST's leaf tokens rather than the raw scanner: a
 * bare `ts.createScanner().scan()` loop does not track template-literal
 * substitution nesting (it has no parser driving `reScanTemplateToken`), so
 * on a file with `` `${x}` ``-style interpolation — this codebase's finding
 * bodies are full of it — the scanner desyncs after the first one and
 * silently stops finding comments for the rest of the file.
 *
 * A single pass over `getLeadingCommentRanges` is not enough on its own,
 * though: `getLeadingCommentRanges(text, pos)` only returns comments that
 * come *after* a line break following `pos`. A comment on the same line as
 * the token before it — `code; // note`, one sitting inside a template
 * interpolation before the closing brace, or one trailing the last token in
 * a file with no newline after it — is trailing trivia of the *previous*
 * token, not leading trivia of the next one, and a leading-only pass misses
 * it silently. So every leaf is asked twice: `getLeadingCommentRanges` at
 * its full start (comments after the preceding newline, up to this leaf)
 * and `getTrailingCommentRanges` at its end (comments on this leaf's own
 * line, before the next newline). Two adjacent leaves' spans are always
 * contiguous — each leaf's end equals the next leaf's full start, a
 * structural guarantee of how the parser assigns trivia — so together the
 * leading call on one side and the trailing call on the other cover every
 * character of trivia between them with no gap.
 *
 * Results are still deduplicated by comment start position, but not for
 * that leading/trailing split — called at the same non-zero position, the
 * two functions partition trivia disjointly and no comment satisfies both.
 * The real duplicate source is two *different* leaves sharing a position:
 * a zero-width node (e.g. the empty `SyntaxList` inside an empty function,
 * class, or interface body) ends exactly where the token right after it
 * starts, so both make a call — one leading, one trailing, or both
 * trailing — that lands on the same spot and returns the same comment (see
 * the `catches a planted weight ... exactly once` fixture below, which
 * proves this by counting the raw, undeduplicated hits). Position 0 is a
 * related edge case: both functions always collect trivia starting there,
 * so a file containing nothing but a comment would double-count it too.
 */
function extractComments(sourceText: string, fileName: string): CommentSpan[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const spans: CommentSpan[] = [];
  const seen = new Set<number>();

  function record(ranges: readonly ts.CommentRange[] | undefined): void {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      spans.push({ start: range.pos, text: sourceText.slice(range.pos, range.end) });
    }
  }

  function visit(node: ts.Node): void {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      record(ts.getLeadingCommentRanges(sourceText, node.getFullStart()));
      record(ts.getTrailingCommentRanges(sourceText, node.getEnd()));
      return;
    }
    children.forEach(visit);
  }
  visit(sourceFile);
  return spans;
}

/** 1-based line number of an absolute offset into `sourceText`. */
function lineAt(sourceText: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (sourceText[i] === "\n") line++;
  }
  return line;
}

interface ExcludedRange {
  start: number;
  end: number;
}

/**
 * The narrow, closed set of contexts where a numeral matching a `WEIGHTS`
 * value is not a restatement of that weight at all:
 *
 * - Array/tuple indices in prose (`evidence[0]`, `declarations[0]`,
 *   `evidence[1..]`) — the digit names a position, not a score. Narrowed to
 *   require a real identifier immediately before the bracket: without that,
 *   a bare bracketed numeral with nothing naming what it indexes would pass
 *   as an "index" and hide whichever weight it restates.
 * - The documented `0..1` / `[0, 1]` severity range that `Claim.severity`
 *   and `clampSeverity` operate on — unrelated to any fact-scoring weight.
 * - "1-based" / "0-based" line-numbering phrases — the digit names a
 *   counting convention, not a score. Narrowed to exactly those two digits:
 *   the only line-numbering conventions this codebase documents are 0-based
 *   and 1-based, so a broader `\d+-based` would also swallow any
 *   weight-`based` look-alike and hide whichever weight it carries.
 * - `U+` followed by hex digits — the standard notation for a Unicode code
 *   point, e.g. `U+E01EF` (a Variation Selectors Supplement character). The
 *   digits name a character, not a score, but `\d+` reads whatever decimal
 *   digits it finds inside the hex run regardless of the letters around
 *   them, and coincidence — not restatement — is what puts a `WEIGHTS`
 *   value there: the hex tail of `U+E01EF` contains a two-digit run that
 *   `Number` reads as exactly `WEIGHTS.effect.network` /
 *   `WEIGHTS.effect.database`. Narrowed to the `U+` prefix plus four to
 *   eight hex digits: four to six covers plain and BMP-padded code points
 *   (`U+0041`, `U+1F600`), and eight covers the `\U`-style zero-padded form
 *   some tooling uses for the same astral characters (`U+0001F600`) — so a
 *   bare numeral with no `U+` in front of it is still caught.
 * - `file.ext:123` locations and "line 123" phrases — a source position,
 *   not a score, and comments in test fixtures point at fixture lines
 *   constantly. Narrowed to a real extension-colon prefix or the literal
 *   word "line": a bare numeral with neither is still caught.
 * - Model ids (`claude-opus-5` and friends) — the digits are a version.
 *   Narrowed to the `claude-` prefix.
 * - Exponent-form numerals (`1e999`) — always a quoted overflow literal in
 *   this codebase; no constant is spelled that way.
 *
 * Deliberately not a blanket per-file exclusion: everything outside these
 * shapes is checked, including in `src/score/index.ts`, which is where the
 * real violations concentrated.
 */
function excludedRanges(text: string): ExcludedRange[] {
  const patterns = [
    /\[\s*0\s*,\s*1\s*\]/g, // "[0, 1]" severity range
    /\b0\.\.1\b/g, // "0..1" severity range
    /\b[01]-based\b/g, // "1-based" / "0-based" line numbering — only these two digits
    /\bU\+[0-9A-Fa-f]{4,8}\b/g, // "U+E01EF" / "U+0001F600" — a Unicode code point, not a weight
    /\.\w+:\d+\b/g, // "schema.ts:58" — a file:line location
    /\bline \d+\b/gi, // "line 5" — a line number in a fixture or a file
    /\bclaude-[a-z][\w.-]*\d\b/gi, // "claude-opus-5" — a model id's version digits
    /\b\d+e\d+\b/g, // "1e999" — an exponent-form overflow literal
    // "evidence[0]", "declarations[0]", "evidence[1..]" — the lookbehind
    // requires an identifier directly touching the bracket, so the excluded
    // range is just the bracket itself, not a name that happens to precede
    // an unrelated bracketed number elsewhere in the sentence.
    /(?<=[A-Za-z_$][\w$]*)\[\s*\d+\s*(\.\.\s*\d*)?\s*\]/g,
  ];
  const ranges: ExcludedRange[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return ranges;
}

function isExcluded(pos: number, ranges: ExcludedRange[]): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

interface Violation {
  file: string;
  line: number;
  value: number;
  matchedText: string;
  constants: string[];
}

const NUMBER_RE = /\d+(\.\d+)?/g;

/**
 * The scan core, factored out from file discovery so the adversarial
 * fixtures below can drive it directly on an inline snippet instead of a
 * file on disk — the guard's own extraction and exclusion logic is exactly
 * what those fixtures exist to pin.
 */
function findViolationsInText(sourceText: string, fileName: string, label: string): Violation[] {
  const violations: Violation[] = [];
  for (const comment of extractComments(sourceText, fileName)) {
    const excluded = excludedRanges(comment.text);
    for (const m of comment.text.matchAll(NUMBER_RE)) {
      const idx = m.index ?? 0;
      if (isExcluded(idx, excluded)) continue;
      const value = Number(m[0]);
      const constants = FORBIDDEN.get(value);
      if (!constants) continue;
      violations.push({
        file: label,
        line: lineAt(sourceText, comment.start + idx),
        value,
        matchedText: m[0],
        constants,
      });
    }
  }
  return violations;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const roots: Array<[string, string]> = [
    [SRC_DIR, "src"],
    [TEST_DIR, "test"],
  ];
  for (const [dir, label] of roots) {
    for (const absPath of listTsFiles(dir)) {
      const sourceText = readFileSync(absPath, "utf8");
      const relPath = relative(dir, absPath).split("\\").join("/");
      violations.push(...findViolationsInText(sourceText, absPath, `${label}/${relPath}`));
    }
  }
  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value - b.value,
  );
}

describe("comment contract", () => {
  it("never restates a WEIGHTS value as a bare numeral in a comment", () => {
    const violations = findViolations();
    if (violations.length === 0) return;
    const message = violations
      .map(
        (v) =>
          `${v.file}:${v.line} — found ${v.matchedText}, which duplicates ${v.constants.join(
            " / ",
          )}. Reference the constant by name instead of restating its value.`,
      )
      .join("\n");
    expect.fail(`${violations.length} comment(s) restate a WEIGHTS value:\n${message}`);
  });

  // These pin the extraction and exclusion logic itself, on inline
  // fixtures rather than real src/ files — the guard is only as good as
  // these two mechanisms, so they are the most important thing to test.
  describe("extraction: same-line comments the AST classifies as trailing trivia", () => {
    it("catches a planted weight in a same-line comment trailing a statement", () => {
      const src = "export function f(): number {\n  return 1; // uses 90 under the hood\n}\n";
      const violations = findViolationsInText(src, "fixture.ts", "fixture.ts");
      expect(violations.some((v) => v.value === 90)).toBe(true);
    });

    it("catches a planted weight in a same-line comment inside a template interpolation", () => {
      const src = "const s = `value ${/* 75 */ x}`;\n";
      const violations = findViolationsInText(src, "fixture.ts", "fixture.ts");
      expect(violations.some((v) => v.value === 75)).toBe(true);
    });

    it("catches a planted weight in a same-line trailing comment on the file's last line", () => {
      const src = "export const x = 1; // 90 trailing at eof, no newline after";
      const violations = findViolationsInText(src, "fixture.ts", "fixture.ts");
      expect(violations.some((v) => v.value === 90)).toBe(true);
    });
  });

  describe("extraction: deduplicating a comment reachable from two leaves", () => {
    it("catches a planted weight in an empty function body's comment exactly once, proving the raw walk would double it without the dedup", () => {
      const src = "function f() { /* 90 */ }\n";

      // Replicates extractComments's leading+trailing walk with the dedup
      // removed, to prove — rather than assert in prose — that this
      // fixture really does produce a raw duplicate. An empty body's
      // zero-width `SyntaxList` ends exactly where the token after it
      // starts, so both leaves independently return the same comment.
      const sourceFile = ts.createSourceFile("raw.ts", src, ts.ScriptTarget.Latest, true);
      const rawHitPositions: number[] = [];
      function walkUndeduped(node: ts.Node): void {
        const children = node.getChildren(sourceFile);
        if (children.length === 0) {
          for (const r of ts.getLeadingCommentRanges(src, node.getFullStart()) ?? []) {
            rawHitPositions.push(r.pos);
          }
          for (const r of ts.getTrailingCommentRanges(src, node.getEnd()) ?? []) {
            rawHitPositions.push(r.pos);
          }
          return;
        }
        children.forEach(walkUndeduped);
      }
      walkUndeduped(sourceFile);
      expect(rawHitPositions.length).toBeGreaterThan(1);

      // The real extractor collapses that raw duplicate to one span, and
      // the guard reports the planted weight exactly once, not twice.
      expect(extractComments(src, "fixture.ts")).toHaveLength(1);
      const violations = findViolationsInText(src, "fixture.ts", "fixture.ts");
      expect(violations.filter((v) => v.value === 90)).toHaveLength(1);
    });
  });

  describe("exclusions: exactly as wide as their justification, no wider", () => {
    it("excludes the real 1-based convention but still catches a 90-based look-alike", () => {
      const legit = findViolationsInText("/** 1-based, inclusive. */\n", "fixture.ts", "fixture.ts");
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText(
        "/** Counts are 90-based here, apparently. */\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(abusive.some((v) => v.value === 90)).toBe(true);
    });

    it("excludes a legitimate Unicode code point but still catches a bare weight numeral", () => {
      const legit = findViolationsInText(
        "// the Variation Selectors Supplement runs up to U+E01EF\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText(
        "// this costs 90 to run\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(abusive.some((v) => v.value === 90)).toBe(true);
    });

    it("excludes only the code point itself, not everything after it on the same line", () => {
      // The failure mode a pattern as loose as `/\bU\+[\s\S]*/g` would pass
      // undetected: a fixture with no `U+` in it at all cannot tell a
      // correctly narrow exclusion from one that swallows the rest of the
      // comment. This one plants a real code point and a real weight
      // restatement in the same comment — a `U+`-anchored match that ran to
      // the end of the text, rather than stopping at the hex run, would
      // hide the weight numeral behind it.
      const violations = findViolationsInText(
        "// U+E01EF costs 90 to render\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(violations.some((v) => v.value === 90)).toBe(true);
    });

    it("excludes an 8-digit zero-padded code point, the \\U-style width some tooling uses for astral characters", () => {
      const legit = findViolationsInText(
        "// rendered the same as U+0001F600 elsewhere in this codebase\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);
    });

    it("excludes file:line locations and 'line N' phrases but still catches a bare weight beside them", () => {
      const legit = findViolationsInText(
        "// anchored at schema.ts:75, i.e. line 75 of the fixture\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText(
        "// line 3 of a.ts costs 75 to score\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(abusive.some((v) => v.value === 75)).toBe(true);
    });

    it("excludes a model id's version digits but still catches a weight after the model name", () => {
      const legit = findViolationsInText(
        "// claude-opus-5 thinks by default\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText(
        "// claude scores this 90\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(abusive.some((v) => v.value === 90)).toBe(true);
    });

    it("excludes an exponent-form overflow literal but still catches a plain weight numeral", () => {
      const legit = findViolationsInText(
        "// 1e999 overflows to Infinity under JSON.parse\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText("// weighted 90 here\n", "fixture.ts", "fixture.ts");
      expect(abusive.some((v) => v.value === 90)).toBe(true);
    });

    it("excludes a bracketed index with a real identifier but still catches a bare bracket hiding a weight", () => {
      const legit = findViolationsInText(
        "/** evidence[1..] follows the declaration. */\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(legit).toHaveLength(0);

      const abusive = findViolationsInText(
        "/** Unrelated aside: [90] shows up here. */\n",
        "fixture.ts",
        "fixture.ts",
      );
      expect(abusive.some((v) => v.value === 90)).toBe(true);
    });
  });
});

describe("test title contract", () => {
  it("gives every test in a file a title unique within that file, so a citation naming the file resolves to one test", () => {
    // This repository's comments cite tests by file and title — `see
    // test/report/model.test.ts, "carries the mark's words"` — and never name
    // the enclosing describe block. So a title repeated inside one file makes
    // every citation of it ambiguous, and the citation analyzer cannot tell
    // which test was meant either.
    //
    // Scoped to within a file on purpose. The same title in two different
    // files is not ambiguous under that citation form and is often
    // deliberate: the surfaces test parallel behavior and saying so
    // identically is the point. Widening this to the whole suite would
    // forbid that parallelism to fix an ambiguity that does not exist.
    //
    // Known blind spot, so nobody mistakes this for full coverage: the
    // pattern sees line-start double-quoted titles only. It misses the
    // suite's template-literal titles and its `it.each` sites. That is not
    // a gap worth closing — every one of those titles is interpolated or
    // parameterized, so its literal text never appears in the file, and the
    // citation form this guard exists to protect could not resolve it
    // anyway. Coverage matches the citable population, not the call sites.
    // A commented-out `it(` is not a false positive: `//` sits between the
    // line start and `it`, so the pattern does not match it.
    const offenders: string[] = [];
    for (const file of listTsFiles(TEST_DIR)) {
      const counts = new Map<string, number>();
      for (const match of readFileSync(file, "utf8").matchAll(/^\s*it\("([^"]+)"/gm)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
      for (const [title, n] of counts) {
        if (n > 1) offenders.push(`${relative(TEST_DIR, file)}: "${title}" appears ${n} times`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
