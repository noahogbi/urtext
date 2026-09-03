import { describe, expect, it } from "vitest";
import { detectEffects } from "../../src/analyze/effects.js";
import { collectGuards } from "../../src/analyze/guards.js";
import { mapSymbols } from "../../src/extract/symbols.js";
import type { Hunk } from "../../src/types.js";

/**
 * One table over extensions. Every syntactic analyzer runs over the same
 * source in each extension, so a call site missed in one analyzer changes a
 * cell here instead of vanishing. The predicate this pins has already caused
 * the silent-invisibility failure once; see isTypeScriptFile's comment.
 */
const SOURCE = [
  'import { readFileSync } from "node:fs";',
  "export function pick(a) {",
  '  if (!a) throw new Error("no");',
  '  return readFileSync("f");',
  "}",
].join("\n");

const SYNTACTIC = ["a.ts", "a.mts", "a.cts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx"];
const NOT_SOURCE = ["a.json", "a.md", "a.yml", "a.d.ts"];

// The whole file is new — a single hunk covering every line, as a diff
// against an empty before-file would report it.
const hunkFor = (text: string): Hunk[] => [
  { oldStart: 0, oldLines: 0, newStart: 1, newLines: text.split("\n").length },
];
const hunk = (): Hunk[] => hunkFor(SOURCE);

describe("every syntactic analyzer reads every source extension", () => {
  it.each(SYNTACTIC)("effects reads %s", (path) => {
    expect(detectEffects(path, SOURCE).length).toBeGreaterThan(0);
  });

  it.each(SYNTACTIC)("guards reads %s", (path) => {
    expect(collectGuards(path, SOURCE).length).toBeGreaterThan(0);
  });

  it.each(SYNTACTIC)("symbol extraction reads %s", (path) => {
    expect(mapSymbols(path, null, SOURCE, hunk()).length).toBeGreaterThan(0);
  });

  it.each(NOT_SOURCE)("nothing reads %s", (path) => {
    expect(detectEffects(path, SOURCE)).toEqual([]);
    expect(collectGuards(path, SOURCE)).toEqual([]);
    expect(mapSymbols(path, null, SOURCE, hunk())).toEqual([]);
  });
});

/**
 * The table above only pins the gate — that a `.jsx` path reaches each
 * analyzer at all. `SOURCE` contains no actual JSX tag, so every analyzer
 * parses it identically whether it is handed the JSX ScriptKind or the plain
 * TypeScript one; a call site quietly reverted from `scriptKindFor(path)`
 * back to a `path.endsWith(".tsx") ? TSX : TS` ternary would still leave
 * every row above green, because for this source the two kinds agree.
 *
 * These fixtures close that gap by putting a real JSX tag where each
 * analyzer's output can only be right if the tag itself was parsed as JSX
 * rather than misread as a type assertion. Confirmed by reverting
 * `scriptKindFor` to that exact ternary and rerunning this file: the effects
 * fixture below found nothing, the guard's captured condition text was cut
 * short at the JSX attribute, and symbol extraction invented an extra
 * "method" out of the mangled parse — each a distinct wrong answer, not
 * just a missing one.
 */
describe("scriptKindFor is exercised through real JSX, not just reached", () => {
  const EFFECT_IN_JSX = [
    'import { readFileSync } from "node:fs";',
    "export function Pick(a) {",
    '  return <div className="x">{readFileSync("f")}</div>;',
    "}",
  ].join("\n");

  const GUARD_IN_JSX = [
    "export function Pick(a) {",
    "  if (<Warn shown={a} />) {",
    '    throw new Error("no");',
    "  }",
    "  return a;",
    "}",
  ].join("\n");

  it("finds the filesystem effect nested inside a JSX child expression", () => {
    const sites = detectEffects("a.jsx", EFFECT_IN_JSX);
    expect(sites.map((s) => s.kind)).toEqual(["filesystem"]);
  });

  it("captures a guard's condition text in full, not truncated at a JSX attribute", () => {
    const guards = collectGuards("a.jsx", GUARD_IN_JSX);
    const g = guards.find((x) => x.signature.startsWith("if"));
    expect(g?.signature).toBe("if:<Warn shown={a} />");
  });

  it("does not fabricate a symbol out of a JSX child expression", () => {
    const symbols = mapSymbols("a.jsx", null, EFFECT_IN_JSX, hunkFor(EFFECT_IN_JSX));
    expect(symbols.map((s) => s.name)).toEqual(["Pick"]);
  });
});
