import { describe, expect, it } from "vitest";
import {
  CITATION_PATHSPECS,
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

describe("normalizeText", () => {
  it("collapses every whitespace run, newlines included, and trims", () => {
    expect(normalizeText("  a \n\t b  \r\n c ")).toBe("a b c");
  });
});
