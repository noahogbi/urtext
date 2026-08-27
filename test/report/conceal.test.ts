import { describe, expect, it } from "vitest";
import {
  labelConcealed,
  plainText,
  segmentConcealed,
} from "../../src/report/conceal.js";

// Escapes rather than literal characters, for the same reason the table in
// `src/report/conceal.ts` is written as code points: a literal concealing
// character in this file is invisible to the next reader.
const RLO = "\u202E";
const ZWSP = "\u200B";
const TAG_A = "\u{E0041}";

describe("segmentConcealed", () => {
  it("groups ordinary text into runs and isolates each concealed code point", () => {
    expect(segmentConcealed(`a${RLO}b`)).toEqual([
      { kind: "text", text: "a" },
      { kind: "concealed", text: "U+202E" },
      { kind: "text", text: "b" },
    ]);
  });

  it("keeps adjacent concealed characters as separate segments, one per code point", () => {
    expect(segmentConcealed(`a${RLO}${ZWSP}b`)).toEqual([
      { kind: "text", text: "a" },
      { kind: "concealed", text: "U+202E" },
      { kind: "concealed", text: "U+200B" },
      { kind: "text", text: "b" },
    ]);
  });

  it("carries an astral tag character as one concealed segment, not a split surrogate pair", () => {
    expect(segmentConcealed(`x${TAG_A}`)).toEqual([
      { kind: "text", text: "x" },
      { kind: "concealed", text: "U+E0041" },
    ]);
  });

  it("returns one text run for clean text and no segments for empty text", () => {
    expect(segmentConcealed("return fetch(url);")).toEqual([
      { kind: "text", text: "return fetch(url);" },
    ]);
    expect(segmentConcealed("")).toEqual([]);
  });

  it("leaves a source-written label literal as ordinary text", () => {
    // The whole reason segments exist: a flattened label cannot be told
    // apart from source code that literally spells it, so the distinction
    // has to be structural, made before the text is ever flattened.
    expect(segmentConcealed("a[U+202E]b")).toEqual([
      { kind: "text", text: "a[U+202E]b" },
    ]);
  });

  it("distinguishes a real concealed character from its literal label in the same string", () => {
    // The conflation case itself: one input carrying both. Only the real
    // code point may become a concealed segment; the spelled-out label
    // stays ordinary text, even though both flatten to identical output.
    expect(segmentConcealed(`a${RLO}b[U+202E]c`)).toEqual([
      { kind: "text", text: "a" },
      { kind: "concealed", text: "U+202E" },
      { kind: "text", text: "b[U+202E]c" },
    ]);
    expect(plainText(segmentConcealed(`a${RLO}b[U+202E]c`))).toBe(
      labelConcealed(`a${RLO}b[U+202E]c`),
    );
  });
});

describe("plainText", () => {
  it("brackets concealed labels and keeps text runs verbatim", () => {
    expect(
      plainText([
        { kind: "text", text: "a" },
        { kind: "concealed", text: "U+202E" },
        { kind: "text", text: "b" },
      ]),
    ).toBe("a[U+202E]b");
    expect(plainText([])).toBe("");
  });

  it("reproduces exactly the string labelConcealed produces, for any input", () => {
    const inputs = [
      "",
      "clean text",
      `a${RLO}b`,
      `${ZWSP}leading and trailing${RLO}`,
      `tag${TAG_A}payload`,
      "literal [U+202E] label",
      "tabs\tand\nnewlines stay",
    ];
    for (const input of inputs) {
      expect(plainText(segmentConcealed(input))).toBe(labelConcealed(input));
    }
  });
});
