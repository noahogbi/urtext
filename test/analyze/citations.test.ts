import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CITATION_PATHSPECS,
  type Citation,
  citationsIn,
  citationsInComments,
  citationsInProse,
  MAX_QUOTE_CHARS,
  maskFences,
  maskUrls,
  normalizeText,
} from "../../src/analyze/citations.js";
import { isSyntacticSource } from "../../src/extract/symbols.js";

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
    const [c] = citationsInProse("See src/analyze/fact.ts:45-63 for the rule.\n");
    expect(c.line).toBe(45);
    expect(c.endLine).toBe(63);
  });

  it("extracts a citation a sentence's closing period touches, in both forms", () => {
    // The trailing lookahead rejects a digit, letter, underscore, slash, or
    // hyphen and stops there, so the period ending a sentence does not end
    // the citation with it. Prose ends sentences on citations, and a
    // lookahead that also rejected the period would lose every one of them
    // silently. Both shapes are pinned: the range form reaches the lookahead
    // through the optional end-line branch, not the branch the single line
    // takes.
    const [single] = citationsInProse("See src/analyze/fact.ts:45.\n");
    expect(single.path).toBe("src/analyze/fact.ts");
    expect(single.line).toBe(45);
    expect(single.endLine).toBeUndefined();

    const [range] = citationsInProse("See src/analyze/fact.ts:45-63.\n");
    expect(range.path).toBe("src/analyze/fact.ts");
    expect(range.line).toBe(45);
    expect(range.endLine).toBe(63);
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

  it("captures every segment of a deep path, and reports it once", () => {
    // What this pins is leftmost matching, not the lookbehind: the scan
    // already starts at the path's first segment here, so this fixture stays
    // green with the lookbehind deleted. The test below is the one that
    // pins it.
    const found = citationsInProse("vendor/src/analyze/fact.ts:45\n");
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("vendor/src/analyze/fact.ts");
  });

  it("does not read a host out of a scheme-less // link as a repository path", () => {
    // The lookbehind, pinned by the only fixture shape that needs it: one
    // where the text before the path cannot itself start a match, so
    // leftmost matching does not hide the lookbehind's absence. `maskUrls`
    // recognizes only `scheme://`, so a protocol-relative link arrives
    // unmasked; without the lookbehind the match would begin after the
    // leading slashes and report the host as a tracked directory.
    expect(citationsInProse("See //example.com/src/a.ts:12 here\n")).toHaveLength(0);
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

  it("CITATION_GUARD_SEPARATOR: the same names keep matching once a separator is in front of them", () => {
    // The other half of the guard, and the half a mutation can actually
    // notice: a separator requirement that silenced these too would be
    // rejecting the form the feature exists to check, not the look-alikes.
    const found = citationsInProse("lib/Something.js:14 and vendor/Node.js:14\n");
    expect(found.map((c) => c.path)).toEqual(["lib/Something.js", "vendor/Node.js"]);
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

  it("CITATION_GUARD_PHRASE: a phrase exactly at MAX_QUOTE_CHARS is still a citation", () => {
    // The far side of the boundary the cap is written at. Without this, a
    // comparison loosened from `>` to `>=` would drop a phrase sitting
    // exactly on the cap and the over-long fixture above would still pass,
    // so the cap's edge would be untested in the only direction it moves.
    const head = "at the cap ";
    const phrase = head + "x".repeat(MAX_QUOTE_CHARS - head.length);
    const [c] = citationsInProse(`see \`src/cli.ts\`, "${phrase}"\n`);
    expect([...c.quote!]).toHaveLength(MAX_QUOTE_CHARS);
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

  it("CITATION_GUARD_FENCE: an unclosed fence blanks to the end of the text", () => {
    const text = ["```", "src/db.ts:14", "", "src/db.ts:99", ""].join("\n");
    expect(citationsInProse(text)).toHaveLength(0);
  });

  it("CITATION_GUARD_FENCE: a fenced block inside a blockquote is masked like any other", () => {
    // The guard's own stated class, failing: `FENCE_LINE`'s indent
    // allowance is defeated by a blockquote marker, so the fence went
    // unrecognized and its sample output read as an assertion about the
    // repository. Both halves are pinned here, because a recognizer
    // loosened until it swallowed the document would satisfy the negative
    // on its own.
    const quoted = ["> ```", "> src/db.ts:14", "> ```", ""].join("\n");
    expect(citationsInProse(quoted)).toHaveLength(0);

    const alsoOutside = ["> ```", "> src/db.ts:14", "> ```", "", "src/db.ts:14", ""].join("\n");
    const found = citationsInProse(alsoOutside);
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

  it("CITATION_GUARD_URL: masks the URL span and nothing past the whitespace that ends it", () => {
    // The failure a URL fixture on its own cannot see: a mask that ran to the
    // end of the line — or the end of the text — would swallow a real
    // citation sitting after the link and report nothing, which reads exactly
    // like the guard working.
    const found = citationsInProse("https://example.com/src/a.ts:12 and src/db.ts:14 here\n");
    expect(found.map((c) => c.path)).toEqual(["src/db.ts"]);
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

  it("reports the line a citation sits on several lines into a block comment", () => {
    // The same offset map on Form A, where the naive "line of the comment's
    // start" and the right answer differ by a count no fixture can reach by
    // accident. Without the map every citation here would report line 1.
    const block = ["/**", " * lead", " * lead", " * see src/cli.ts:12", " */", ""].join("\n");
    const [c] = citationsInComments(block, "b.ts");
    expect(c.citingLine).toBe(4);
    expect(c.citingText).toBe("* see src/cli.ts:12");
  });

  it("does not mask fences inside comments, since a fence is a prose construct", () => {
    const block = ["// ```", "// src/cli.ts:12", "// ```", ""].join("\n");
    expect(citationsInComments(block, "c.ts")).toHaveLength(1);
  });

  it("survives a template interpolation, which desyncs a raw scanner loop", () => {
    const withTemplate = [
      "const a = `value ${x} more`;",
      "// after the interpolation: src/cli.ts:12",
      "",
    ].join("\n");
    expect(citationsInComments(withTemplate, "b.ts")).toHaveLength(1);
  });

  it("finds a JSDoc block that ends the file after its last statement", () => {
    // Shrunk from the planted-citation property below, on its first run. A
    // JSDoc block that precedes nothing but the end of the file is hung off
    // the end-of-file token as that token's child, so the token is no
    // longer a leaf: the walk descended to the JSDoc node instead, whose
    // position is the block's own opener, and a leading-comment scan from
    // there collects nothing before the first line break. Lost: the block,
    // and every comment between the last statement and it. Read all along:
    // whatever followed the block, a plain block or line comment ending the
    // file in its place, a file holding nothing but the block, and a JSDoc
    // block anywhere else — which is why no fixture had caught it. The lone
    // block is asserted so the fix is seen to read it once, not twice.
    const ending = ["const s = 1;", "/**", " * see src/cli.ts:12", " */", ""].join("\n");
    const [c] = citationsInComments(ending, "e.ts");
    expect(c).toBeDefined();
    expect(c.citingLine).toBe(3);
    expect(citationsInComments("/**\n * see src/cli.ts:12\n */\n", "f.ts")).toHaveLength(1);
    const between = ["const s = 1;", "// see src/cli.ts:12", "/**", " * see src/cli.ts:34", " */", ""].join("\n");
    expect(citationsInComments(between, "g.ts").map((found) => found.citingLine)).toEqual([2, 4]);
  });

  it("orders the citations of two comments on one line by path", () => {
    // The walk yields comments in source order and each comment's own
    // citations come back already sorted, so the sort on the way out is
    // visible only between two comments that share a line. The property
    // below holds the line order; this holds the tie-break.
    const found = citationsInComments("/* a/z.ts:12 */ /* a/a.ts:34 */\n", "o.ts");
    expect(found.map((c) => c.path)).toEqual(["a/a.ts", "a/z.ts"]);
  });

  it("reports a comment reachable from two leaves exactly once", () => {
    // An empty body's zero-width node ends exactly where the next token
    // starts, so both leaves return the same comment range; without the
    // dedup by range start this citation would be reported twice.
    const doubled = "function f() { /* see src/cli.ts:12 */ }\n";
    expect(citationsInComments(doubled, "d.ts")).toHaveLength(1);
  });
});

describe("citationsIn", () => {
  it("scans prose as raw text and TypeScript as comments only", () => {
    const text = 'const x = "src/cli.ts:12";\n';
    expect(citationsIn("docs/a.md", text)).toHaveLength(1);
    expect(citationsIn("src/a.ts", text)).toHaveLength(0);
    expect(citationsIn("assets/logo.png", text)).toHaveLength(0);
  });

  it("checks a citation written in a JavaScript comment", () => {
    // The dispatch in citationsIn is not the gate. CITATION_PATHSPECS decides
    // which files ever become candidates, so widening the dispatch alone
    // leaves this dead.
    expect([...CITATION_PATHSPECS]).toContain("*.mjs");
    expect(citationsIn("a.mjs", "// see src/x.ts:3\n")).toHaveLength(1);
  });

  it("checks a citation written in a module-explicit TypeScript comment", () => {
    // A pre-existing under-report the pathspec comment has documented all
    // along: isTypeScriptFile accepts .mts, no pathspec named it.
    expect([...CITATION_PATHSPECS]).toContain("*.mts");
    expect(citationsIn("a.mts", "// see src/x.ts:3\n")).toHaveLength(1);
  });
});

describe("CITATION_PATHSPECS stays in step with isSyntacticSource", () => {
  it("has a pathspec entry for every extension isSyntacticSource accepts", () => {
    // The comment above CITATION_PATHSPECS calls the two lists an invariant
    // "the two lists must stay in step" and names a history of them
    // drifting apart. That sentence alone enforces nothing — deleting an
    // entry from the pathspec list left the whole suite green until now.
    // This derives the check from the predicate itself rather than from a
    // second hand-copied list of extensions: candidates that are not real
    // source extensions (prose, data, and near-miss suffixes) are included
    // on purpose, to prove the loop below is checking what the predicate
    // says yes to, not merely echoing the pathspec back at itself.
    const candidates = [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "mjs",
      "cjs",
      "jsx",
      "json",
      "md",
      "markdown",
      "txt",
      "yml",
      "py",
    ];
    const accepted = candidates.filter((ext) => isSyntacticSource(`a.${ext}`));
    // A sanity floor: an empty `accepted` would make the loop below vacuous
    // and let this test pass no matter what CITATION_PATHSPECS contains.
    expect(accepted.length).toBeGreaterThan(0);
    for (const ext of accepted) {
      expect([...CITATION_PATHSPECS]).toContain(`*.${ext}`);
    }
  });
});

describe("normalizeText", () => {
  it("collapses every whitespace run, newlines included, and trims", () => {
    expect(normalizeText("  a \n\t b  \r\n c ")).toBe("a b c");
  });
});

// ---------------------------------------------------------------------------
// Properties. Each fixture above is one point in a space; these walk the
// space. The generator owns the ground truth — it decides where every
// citation is planted and whether the region around it is masked — so the
// assertion is exact recovery of what was planted, not "found something".
// A failure prints the seed; pin the counterexample as a fixture above
// before fixing, so the shrunk case survives the property being rewritten.

/** Runs per property, named once so a change is a change everywhere. */
const RUNS = 250;

/** What a planted citation must come back as, before its line is known. */
type Planted = Omit<Citation, "citingLine" | "citingText">;

/** One physical line and the citations it must yield. */
interface Line {
  text: string;
  planted: Planted[];
}

/**
 * Prose that cannot hold a citation, by construction. No `/`, so no path can
 * satisfy CITATION_GUARD_SEPARATOR; no backtick or tilde, so no line can
 * open a fence the generator did not plant; no parentheses or brackets, so
 * no accidental link destination — `maskUrls` blanks from `](` to the next
 * `)` across newlines. Everything the guards do care about stays in: colons,
 * digits, dots, quotes, and a character outside the BMP, which is two UTF-16
 * units long and is what separates a length-preserving mask from one that
 * preserves code points.
 */
const fillerUnit = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEF0123456789 :._-#*\"'!?,", "😀");
const filler = fc.string({ unit: fillerUnit, maxLength: 24 });

const segment = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"),
  minLength: 1,
  maxLength: 6,
});
const path = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), segment, fc.constantFrom("ts", "md", "js", "json"))
  .map(([dirs, base, ext]) => `${dirs.join("/")}/${base}.${ext}`);
const lineNumber = fc.integer({ min: 1, max: 999_999 });

const lineCitation = fc
  .record({ path, line: lineNumber, endLine: fc.option(lineNumber, { nil: undefined }) })
  .map(({ path, line, endLine }) => ({
    text: `${path}:${line}${endLine === undefined ? "" : `-${endLine}`}`,
    planted: [
      endLine === undefined
        ? { form: "line" as const, path, line }
        : { form: "line" as const, path, line, endLine },
    ],
  }));

const word = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), minLength: 1, maxLength: 8 });
const words = fc.array(word, { minLength: 2, maxLength: 6 });
const quoteCitation = fc
  .record({
    path,
    words,
    separator: fc.constantFrom("", ",", ";", ":"),
    gap: fc.constantFrom("", " ", "  ", "   "),
    joiner: fc.constantFrom(" ", "  "),
    open: fc.constantFrom('"', "“"),
    close: fc.constantFrom('"', "”"),
  })
  .map(({ path, words, separator, gap, joiner, open, close }) => ({
    text: `\`${path}\`${separator}${gap}${open}${words.join(joiner)}${close}`,
    planted: [{ form: "quote" as const, path, quote: words.join(" ") }],
  }));

const citation: fc.Arbitrary<Line> = fc.oneof(lineCitation, quoteCitation);

/** Leading indent, and sometimes prose, which then ends in a space so the lookbehind sees one. */
const prefix = fc
  .tuple(fc.constantFrom("", " ", "    ", "\t"), fc.option(filler))
  .map(([indent, text]) => indent + (text === null ? "" : `${text} `));
/** What may touch a citation's tail: nothing, sentence punctuation, or a space and prose. */
const suffix = fc.oneof(fc.constant(""), fc.constantFrom(".", ","), filler.map((text) => ` ${text}`));

const plainLine: fc.Arbitrary<Line> = filler.map((text) => ({ text, planted: [] }));

const citationLine: fc.Arbitrary<Line> = fc
  .tuple(prefix, fc.array(citation, { minLength: 1, maxLength: 2 }), suffix)
  .map(([before, cited, after]) => ({
    text: before + cited.map((c) => c.text).join(" ") + after,
    planted: cited.flatMap((c) => c.planted),
  }));

/**
 * A URL carrying a path-and-line after a query or fragment separator. The
 * separator matters: after `/` the citation pattern's own lookbehind already
 * refuses the match, so a URL of that shape would pass with the mask
 * deleted. After `=`, `?`, `&` or `#` only the mask stands between the URL
 * and a false finding. A real citation may follow on the same line, and must
 * survive the mask.
 */
const urlLine: fc.Arbitrary<Line> = fc
  .record({
    before: prefix,
    scheme: fc.constantFrom("https", "http", "ftp", "git+ssh"),
    host: fc.constantFrom("example.com", "x.io", "😀.dev"),
    separator: fc.constantFrom("?", "=", "&", "#"),
    inside: fc.tuple(path, lineNumber),
    after: fc.option(citation),
  })
  .map(({ before, scheme, host, separator, inside, after }) => ({
    text: `${before}${scheme}://${host}/q${separator}${inside[0]}:${inside[1]}${after === null ? "" : ` ${after.text}`}`,
    planted: after === null ? [] : after.planted,
  }));

const linkLine: fc.Arbitrary<Line> = fc
  .record({
    before: prefix,
    label: word,
    relative: fc.constantFrom("", "./", "../"),
    inside: fc.tuple(path, lineNumber),
    after: fc.option(citation),
  })
  .map(({ before, label, relative, inside, after }) => ({
    text: `${before}[${label}](${relative}${inside[0]}:${inside[1]})${after === null ? "" : ` ${after.text}`}`,
    planted: after === null ? [] : after.planted,
  }));

/** A line number too long to be a safe integer is discarded, in either position. */
const unsafeLine: fc.Arbitrary<Line> = fc
  .record({ before: prefix, path, digits: fc.integer({ min: 17, max: 20 }), asEnd: fc.boolean() })
  .map(({ before, path, digits, asEnd }) => ({
    text: `${before}${path}:${asEnd ? `12-${"9".repeat(digits)}` : "9".repeat(digits)}`,
    planted: [],
  }));

/**
 * A citation glued to a letter, an underscore, a hyphen or a slash: `a/b.ts:12x`,
 * `a/b.ts:12-34/`. Not a citation, by the trailing boundary in `LINE_CITATION`;
 * without that boundary the line would match up to the glue.
 */
const gluedLine: fc.Arbitrary<Line> = fc
  .record({
    before: prefix,
    path,
    line: lineNumber,
    endLine: fc.option(lineNumber),
    glue: fc.constantFrom("a", "Z", "_", "-", "/"),
  })
  .map(({ before, path, line, endLine, glue }) => ({
    text: `${before}${path}:${line}${endLine === null ? "" : `-${endLine}`}${glue}`,
    planted: [],
  }));

/**
 * A line opening with one or two fence characters, which opens no fence:
 * `FENCE_LINE` wants a run of three. A shorter run accepted as an opener would
 * mask every line from here to the next run of the same character.
 */
const shortFenceLine: fc.Arbitrary<Line> = fc
  .tuple(fc.constantFrom("`", "``", "~", "~~"), fc.option(filler))
  .map(([mark, rest]) => ({ text: rest === null ? mark : `${mark}${rest}`, planted: [] }));

/** Inside a fence every planted citation is masked, whatever else the line holds. */
const fencedContent: fc.Arbitrary<string> = fc.oneof(
  filler,
  citationLine.map((l) => l.text),
  fc.tuple(prefix, citation).map(([before, c]) => `${before}${c.text}`),
);

/**
 * A fenced block, in the shapes `maskFences` documents: three to five of one
 * character, an optional info string, an optional blockquote prefix, and up
 * to three spaces of indent. Interior lines may carry runs that do not close
 * it — the other character, or a shorter run of the same one — and the
 * close is at least as long as the open.
 */
const fencedBlock: fc.Arbitrary<Line[]> = fc
  .record({
    mark: fc.constantFrom("`", "~"),
    length: fc.integer({ min: 3, max: 5 }),
    extra: fc.integer({ min: 0, max: 2 }),
    quote: fc.constantFrom("", "> ", "> > "),
    indent: fc.constantFrom("", " ", "   "),
    info: fc.constantFrom("", "ts", "json"),
    interior: fc.array(
      fc.oneof(
        fencedContent.map((text) => ({ kind: "content" as const, text })),
        fc.constant({ kind: "other" as const, text: "" }),
        fc.constant({ kind: "shorter" as const, text: "" }),
      ),
      { maxLength: 3 },
    ),
  })
  .map(({ mark, length, extra, quote, indent, info, interior }) => {
    const other = mark === "`" ? "~" : "`";
    const lines = interior.map((item) => {
      if (item.kind === "other") return other.repeat(length);
      if (item.kind === "shorter") return mark.repeat(length - 1);
      return quote + item.text;
    });
    return [
      `${quote}${indent}${mark.repeat(length)}${info}`,
      ...lines,
      `${quote}${indent}${mark.repeat(length + extra)}`,
    ].map((text) => ({ text, planted: [] }));
  });

/** An unclosed fence blanks to the end of the text, so it can only come last. */
const unclosedTail: fc.Arbitrary<Line[]> = fc
  .tuple(fc.constantFrom("```", "~~~"), fc.array(fencedContent, { maxLength: 3 }))
  .map(([open, rest]) => [open, ...rest].map((text) => ({ text, planted: [] })));

const block: fc.Arbitrary<Line[]> = fc.oneof(
  { weight: 3, arbitrary: plainLine.map((l) => [l]) },
  { weight: 4, arbitrary: citationLine.map((l) => [l]) },
  { weight: 2, arbitrary: urlLine.map((l) => [l]) },
  { weight: 2, arbitrary: linkLine.map((l) => [l]) },
  { weight: 1, arbitrary: unsafeLine.map((l) => [l]) },
  { weight: 1, arbitrary: gluedLine.map((l) => [l]) },
  { weight: 1, arbitrary: shortFenceLine.map((l) => [l]) },
  { weight: 2, arbitrary: fencedBlock },
);

const proseDocument = fc
  .record({
    blocks: fc.array(block, { maxLength: 10 }),
    tail: fc.option(unclosedTail),
    crlf: fc.boolean(),
    trailingNewline: fc.boolean(),
  })
  .map(({ blocks, tail, crlf, trailingNewline }) => {
    const lines = [...blocks.flat(), ...(tail ?? [])];
    const text =
      lines.map((l) => l.text + (crlf ? "\r" : "")).join("\n") + (trailingNewline ? "\n" : "");
    const expected: Citation[] = lines.flatMap((l, i) =>
      l.planted.map((p) => ({ ...p, citingLine: i + 1, citingText: l.text.trim() })),
    );
    return { text, expected };
  });

/** A canonical string per citation, so two lists compare as multisets. */
const canonical = (c: Citation): string =>
  JSON.stringify([c.citingLine, c.form, c.path, c.line ?? null, c.endLine ?? null, c.quote ?? null, c.citingText]);

/** Unconstrained text, for the properties that hold whatever the input. */
const anyText = fc.string({
  unit: fc.constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABC0123456789 \t\n\r:./\\-_`~>#*\"“”'()[]{}!?,;=&@$%",
    "😀",
  ),
  maxLength: 300,
});

describe("properties: prose", () => {
  it("recovers every planted citation at its line, and nothing from a masked region", () => {
    fc.assert(
      fc.property(proseDocument, ({ text, expected }) => {
        const found = citationsInProse(text);
        expect(found.map(canonical).sort()).toEqual(expected.map(canonical).sort());
        const lines = found.map((c) => c.citingLine);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
      }),
      { numRuns: RUNS },
    );
  });

  it("masks without moving a single UTF-16 unit or newline", () => {
    // The identity `toSource` in citationsInProse is sound only because of
    // this. Pinned to `.length` and to newline positions in UTF-16 units,
    // not code points: a mask that collapsed a surrogate pair to one space
    // would shift every later line by one. Run over the planted documents
    // as well as unconstrained text: a fence or a URL almost never forms by
    // chance in the latter, and a mask that collapsed surrogate pairs went
    // unnoticed here until the planted documents were added.
    fc.assert(
      fc.property(fc.oneof(anyText, proseDocument.map((d) => d.text)), (text) => {
        for (const masked of [maskFences(text), maskUrls(text), maskUrls(maskFences(text))]) {
          expect(masked).toHaveLength(text.length);
          // Indexed by UTF-16 unit on purpose; a spread would walk code points
          // and drift from `masked[i]` at the first surrogate pair.
          let moved = -1;
          for (let i = 0; i < text.length && moved < 0; i++) {
            if (masked[i] !== text[i] && !(masked[i] === " " && text[i] !== "\n")) moved = i;
          }
          expect(moved).toBe(-1);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("never throws, and every reported line exists and holds the path it names", () => {
    // Arbitrary text rarely holds a citation, so the loop below would seldom
    // run on it alone; the planted documents are what put reported lines
    // through the checks.
    fc.assert(
      fc.property(fc.oneof(anyText, proseDocument.map((d) => d.text)), (text) => {
        const lines = text.split("\n");
        for (const c of citationsInProse(text)) {
          expect(c.citingLine).toBeGreaterThanOrEqual(1);
          expect(c.citingLine).toBeLessThanOrEqual(lines.length);
          const line = lines[c.citingLine - 1];
          expect(line).toContain(c.path);
          expect(c.citingText).toBe(line.replace(/\r$/, "").trim());
        }
      }),
      { numRuns: RUNS },
    );
  });
});

/**
 * Comment prose that can neither end a block comment nor hold a citation: no
 * `/` or `*`, so nothing in it can close the comment, and no backtick, so a quoted citation
 * cannot start. The unwrap strips decorations by looking at line starts and
 * ends, so what a line begins and ends with is exactly what the generator
 * varies below.
 */
const commentFiller = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 :._-#\"'!?,", "😀"),
  maxLength: 20,
});

/**
 * A URL inside a comment, with a citation-shaped tail after one of the
 * separators the mask alone protects — `urlLine` again, in the comment
 * alphabet. The comment scan masks URLs on its own unwrapped text, a
 * separate call from the prose scan's, and nothing else exercised it: with
 * that call deleted every fixture still passed.
 */
const commentUrl: fc.Arbitrary<Line> = fc
  .record({
    before: fc.option(commentFiller),
    scheme: fc.constantFrom("https", "http", "ftp", "git+ssh"),
    host: fc.constantFrom("example.com", "x.io", "😀.dev"),
    separator: fc.constantFrom("?", "=", "&", "#"),
    inside: fc.tuple(path, lineNumber),
    after: fc.option(citation),
  })
  .map(({ before, scheme, host, separator, inside, after }) => ({
    text: `${before === null ? "" : before + " "}${scheme}://${host}/q${separator}${inside[0]}:${inside[1]}${after === null ? "" : ` ${after.text}`}`,
    planted: after === null ? [] : after.planted,
  }));

/** A content line inside a comment: prose, a URL, or prose and a planted citation. */
const commentContent: fc.Arbitrary<Line> = fc.oneof(
  commentFiller.map((text) => ({ text, planted: [] })),
  commentUrl,
  fc
    .tuple(fc.option(commentFiller), citation, fc.option(commentFiller))
    .map(([before, c, after]) => ({
      text: (before === null ? "" : before + " ") + c.text + (after === null ? "" : " " + after),
      planted: c.planted,
    })),
);

/**
 * A quoted citation whose phrase continues onto later comment lines. The
 * offset map is what makes its reported line the one the path sits on
 * rather than the comment's first line — the case "reports the line the
 * path sits on for a quote that wrapped across comment lines" pins once.
 */
const wrappedQuote: fc.Arbitrary<Line[]> = fc
  .record({ path, head: words, tails: fc.array(words, { minLength: 1, maxLength: 2 }) })
  .map(({ path, head, tails }) => {
    const all = [...head, ...tails.flat()];
    const last = tails.length - 1;
    return [
      { text: `\`${path}\` "${head.join(" ")}`, planted: [{ form: "quote" as const, path, quote: all.join(" ") }] },
      ...tails.map((t, i) => ({ text: `${t.join(" ")}${i === last ? '"' : ""}`, planted: [] })),
    ];
  });

/**
 * Every decoration shape `unwrapComment` strips: a JSDoc block with starred
 * continuations, a bare block with indented continuations, a block whose
 * close shares the last content line, a run of line comments, and a comment
 * trailing code. Between them, code — including a string literal holding a
 * citation-shaped value, which must never be reported, and a template
 * interpolation, which desynchronizes a raw scanner loop.
 */
const commentItem: fc.Arbitrary<Line[]> = fc.oneof(
  // JSDoc: `/**`, ` * …` lines, ` */`.
  fc
    .tuple(fc.array(fc.oneof(commentContent.map((l) => [l]), wrappedQuote), { minLength: 1, maxLength: 3 }), fc.constantFrom(" * ", " *", "\t* "))
    .map(([body, lead]) => [
      { text: "/**", planted: [] },
      ...body.flat().map((l) => ({ ...l, text: `${lead}${l.text}` })),
      { text: " */", planted: [] },
    ]),
  // A bare block whose continuations carry no star.
  fc
    .tuple(fc.array(fc.oneof(commentContent.map((l) => [l]), wrappedQuote), { minLength: 1, maxLength: 3 }), fc.boolean())
    .map(([body, closeOnLast]) => {
      const lines = body.flat().map((l) => ({ ...l, text: `   ${l.text}` }));
      if (closeOnLast) {
        const end = lines[lines.length - 1];
        return [{ text: "/*", planted: [] }, ...lines.slice(0, -1), { ...end, text: `${end.text} */` }];
      }
      return [{ text: "/*", planted: [] }, ...lines, { text: "*/", planted: [] }];
    }),
  // A one-line block comment on its own line.
  commentContent.map((l) => [{ ...l, text: `/* ${l.text} */` }]),
  // Consecutive line comments, each its own comment to the scanner.
  fc
    .array(fc.tuple(fc.constantFrom("// ", "//", "  // "), commentContent), { minLength: 1, maxLength: 3 })
    .map((lines) => lines.map(([lead, l]) => ({ ...l, text: `${lead}${l.text}` }))),
  // A comment trailing a statement.
  fc
    .tuple(fc.constantFrom("let a = 0;", "a += 1;", "const t = `x${a}y`;"), commentContent)
    .map(([code, l]) => [{ ...l, text: `${code} // ${l.text}` }]),
  // Code that is not a comment, holding what would be a citation in prose.
  fc.tuple(lineCitation, fc.option(commentContent)).map(([c, trailing]) => [
    trailing === null
      ? { text: `const s = "${c.text}";`, planted: [] }
      : { ...trailing, text: `const s = "${c.text}"; // ${trailing.text}` },
  ]),
  fc.constant<Line[]>([{ text: "let a = 0;", planted: [] }]),
  fc.constant<Line[]>([{ text: "", planted: [] }]),
);

const commentDocument = fc
  .record({ items: fc.array(commentItem, { maxLength: 8 }), crlf: fc.boolean() })
  .map(({ items, crlf }) => {
    const lines = items.flat();
    const source = lines.map((l) => l.text + (crlf ? "\r" : "")).join("\n") + (crlf ? "\r\n" : "\n");
    const expected: Citation[] = lines.flatMap((l, i) =>
      l.planted.map((p) => ({ ...p, citingLine: i + 1, citingText: l.text.trim() })),
    );
    return { source, expected };
  });

describe("properties: comments", () => {
  it("recovers every planted citation at the line its path sits on, through every decoration", () => {
    fc.assert(
      fc.property(commentDocument, fc.constantFrom("a.ts", "a.mts", "a.js", "a.mjs"), ({ source, expected }, name) => {
        const found = citationsInComments(source, name);
        expect(found.map(canonical).sort()).toEqual(expected.map(canonical).sort());
        const lines = found.map((c) => c.citingLine);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
      }),
      { numRuns: RUNS },
    );
  });

  it("never throws on arbitrary source, and every reported line exists and holds the path", () => {
    // As above: the planted documents are what give the loop lines to check.
    fc.assert(
      fc.property(fc.oneof(anyText, commentDocument.map((d) => d.source)), (source) => {
        const lines = source.split("\n");
        for (const c of citationsInComments(source, "a.ts")) {
          expect(c.citingLine).toBeGreaterThanOrEqual(1);
          expect(c.citingLine).toBeLessThanOrEqual(lines.length);
          const line = lines[c.citingLine - 1];
          expect(line).toContain(c.path);
          expect(c.citingText).toBe(line.replace(/\r$/, "").trim());
        }
      }),
      { numRuns: RUNS },
    );
  });
});
