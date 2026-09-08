import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAPS, lineOf, mapOf } from "../../src/analyze/manifest-json.js";

/**
 * The shape helpers `dependencies.ts` and `lockfile.ts` share. Both analyzers
 * exercise them through their own suites; this file pins the behaviour they
 * rely on directly, so a change here fails on its own terms rather than as a
 * puzzling anchor shift two files away.
 */

const manifest = [
  "{",
  '  "name": "p",',
  '  "dependencies": {',
  '    "left-pad": "^1.0.0"',
  "  },",
  '  "devDependencies": {',
  '    "left-pad": "^9.0.0",',
  '    "vitest": "^4.0.0"',
  "  },",
  '  "peerDependenciesMeta": {',
  '    "left-pad": { "optional": true }',
  "  }",
  "}",
].join("\n");

describe("MAPS", () => {
  it("lists npm's four resolution maps", () => {
    expect([...MAPS]).toEqual([
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]);
  });
});

describe("mapOf", () => {
  it("reads a map of strings", () => {
    expect(mapOf(JSON.parse(manifest), "dependencies")).toEqual({ "left-pad": "^1.0.0" });
  });

  it("reads an absent source, an absent map, and a non-object map as empty", () => {
    expect(mapOf(null, "dependencies")).toEqual({});
    expect(mapOf(undefined, "dependencies")).toEqual({});
    expect(mapOf({}, "dependencies")).toEqual({});
    expect(mapOf({ dependencies: "not an object" }, "dependencies")).toEqual({});
    expect(mapOf({ dependencies: ["left-pad"] }, "dependencies")).toEqual({});
  });

  it("keeps a package whose name collides with an inherited member", () => {
    // A dependency name is text from the manifest used directly as a key.
    // Assigned onto an ordinary object, __proto__ goes through the inherited
    // setter and the entry vanishes with nothing said — a fact disappearing
    // silently, which is the thing this project exists to prevent.
    const source = JSON.parse('{"dependencies":{"__proto__":"^9.0.0","left-pad":"^1.0.0"}}');
    expect(Object.keys(mapOf(source, "dependencies")).sort()).toEqual(["__proto__", "left-pad"]);
  });

  it("reads an absent name as absent even when Object.prototype has one", () => {
    // The read side of the same defect. On an ordinary object `map.toString`
    // is a function rather than undefined, so `dependencies.ts` takes a
    // package that was added for one that changed and reports a previous
    // version that is really a function.
    const map = mapOf(JSON.parse('{"dependencies":{"left-pad":"^1.0.0"}}'), "dependencies");
    expect(map["toString"]).toBeUndefined();
    expect(map["constructor"]).toBeUndefined();
    expect(map["valueOf"]).toBeUndefined();
    // The same must hold for the early return, or the shape depends on which
    // path produced it.
    expect(mapOf({}, "dependencies")["toString"]).toBeUndefined();
  });

  it("drops non-string values rather than coercing them", () => {
    // A nested object under a dependency map is not a version range. Emitting
    // one would put a fact on screen that the manifest does not state.
    expect(mapOf({ dependencies: { a: "^1.0.0", b: { nested: true }, c: null } }, "dependencies")).toEqual({
      a: "^1.0.0",
    });
  });
});

describe("lineOf", () => {
  it("finds a key inside the block that owns it, not a same-named key elsewhere", () => {
    // Both maps declare left-pad. Each path must reach its own copy.
    expect(lineOf(manifest, ["dependencies", "left-pad"])).toBe(4);
    expect(lineOf(manifest, ["devDependencies", "left-pad"])).toBe(7);
  });

  it("does not enter a map whose name merely starts with the one asked for", () => {
    // peerDependenciesMeta is a superstring of peerDependencies and holds the
    // same package names. The closing quote in the match is what separates them.
    expect(lineOf(manifest, ["peerDependencies", "left-pad"])).toBeUndefined();
    expect(lineOf(manifest, ["peerDependenciesMeta", "left-pad"])).toBe(11);
  });

  it("resolves a path deeper than two keys", () => {
    const lock = [
      "{",
      '  "packages": {',
      '    "": {',
      '      "devDependencies": {',
      '        "left-pad": "^1.0.0"',
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(lineOf(lock, ["packages", "", "devDependencies", "left-pad"])).toBe(5);
  });

  it("returns undefined when a path does not resolve, so callers can fall back", () => {
    expect(lineOf(manifest, ["dependencies", "absent"])).toBeUndefined();
    expect(lineOf(manifest, ["absent", "left-pad"])).toBeUndefined();
    // A document on one line has no line to point at but the first.
    expect(lineOf(JSON.stringify(JSON.parse(manifest)), ["dependencies", "left-pad"])).toBeUndefined();
  });

  it("stops looking once the block that should hold the key has closed", () => {
    // Without the exit bound this walks on and matches the sibling map's copy,
    // anchoring the finding at the wrong version.
    const empty = [
      "{",
      '  "dependencies": {},',
      '  "devDependencies": {',
      '    "left-pad": "^9.0.0"',
      "  }",
      "}",
    ].join("\n");
    expect(lineOf(empty, ["dependencies", "left-pad"])).toBeUndefined();
  });

  it("finds a top-level key on its own", () => {
    expect(lineOf(manifest, ["name"])).toBe(2);
    expect(lineOf(manifest, ["dependencies"])).toBe(3);
  });

  it("does not count a brace inside a string value as structure", () => {
    // Both documents are plain JSON.stringify output. Counting the brace in
    // the value collapsed the depth, after which a nested key matched as
    // though it sat at the root: the first anchored a path that does not
    // exist, and the second anchored on the nested copy rather than the real
    // one — a confidently wrong line, which is the worst thing here can do.
    const absent = JSON.stringify({ a: "}", b: { x: true } }, null, 2);
    expect(lineOf(absent, ["x"])).toBeUndefined();

    const shadowed = JSON.stringify({ "}": { b: "nested" }, b: "real" }, null, 2);
    expect(lineOf(shadowed, ["b"])).toBe(5);
  });

  it("keeps counting inside a string when a quote is escaped", () => {
    // The closing quote of `"q\"{"` is the last one, not the escaped one in
    // the middle. Ending the string early leaves the scan inside-out for the
    // rest of the line, so it never sees the brace that opens the next block.
    //
    // An escaped quote is the only thing that can catch this. A string ending
    // in an escaped backslash closes at the same character whether or not the
    // backslash is honoured, because an even run of them does; only an odd run
    // — which is an escaped quote — tells the two apart. A fixture built on
    // `"back\\"` was written here first and deleted: it stayed green against
    // every mutation of the code it claimed to cover.
    const doc = ['{', '  "a": "q\\"{",', '  "b": {', '    "c": "v"', "  }", "}"].join("\n");
    expect(lineOf(doc, ["b", "c"])).toBe(4);
  });

  it("does not continue a path below a value that opens no block", () => {
    // Shrunk from the no-false-resolution property below, on its first run.
    // After `"a"` matched, the next key was expected one level deeper — and
    // the brace that opened `"b"` took the scan there, with nothing tying
    // that brace to `"a"`. The path `["a", "x"]` does not resolve, and the
    // scan answered it with the line of `"b"`'s own `"x"`. The lockfile
    // analyzer asks exactly this when a manifest declares a name under one
    // of the four maps and the lockfile's root package entry carries that
    // map as a string: the map reads as empty, the name is anchored below
    // it, and the out-of-sync finding pointed at the next map's entry.
    const doc = ["{", '  "a": "1.0.0",', '  "b": {', '    "x": "2.0.0"', "  }", "}"].join("\n");
    expect(lineOf(doc, ["a", "x"])).toBeUndefined();
    const arr = ["{", '  "a": [', '    "1.0.0"', "  ],", '  "b": {', '    "x": "2.0.0"', "  }", "}"].join("\n");
    expect(lineOf(arr, ["a", "x"])).toBeUndefined();
  });

  it("accepts a block that opens on the line after its key, and nothing else there", () => {
    // Nothing npm writes puts the brace on its own line, and neither does the
    // layout oracle below, so this branch is held only here. The scan looks
    // one line down and no further: a brace opening the next line continues
    // the path, and anything else there — a value, or a blank line before
    // the brace — ends it.
    const split = ["{", '  "a":', "  {", '    "x": "1.0.0"', "  }", "}"].join("\n");
    expect(lineOf(split, ["a", "x"])).toBe(4);
    const primitive = ["{", '  "a":', '  "1.0.0",', '  "b": {', '    "x": "2.0.0"', "  }", "}"].join("\n");
    expect(lineOf(primitive, ["a", "x"])).toBeUndefined();
  });
});

/*
 * Property-based from here down. The generators own the ground truth: a
 * document is laid out by an oracle that records the line every key lands on,
 * and the oracle is itself checked against `JSON.stringify` before anything is
 * asserted about `lineOf`. A failure prints the seed and the shrunk document;
 * pin that document as a fixture above before fixing.
 */

const RUNS = 250;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A key from the alphabet npm package names and lockfile paths draw on. No
 * quote and no backslash: a key holding an escape is documented not to
 * resolve. The empty key is in range on purpose — a lockfile's root package
 * sits under it.
 */
const key = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"),
  maxLength: 8,
});

/**
 * A value whose text carries every character the scan must not count as
 * structure — braces, quotes, backslashes, colons, newlines — all quoted or
 * escaped by the time they reach the document.
 */
const primitive: fc.Arbitrary<Json> = fc.oneof(
  fc.string({ unit: fc.constantFrom(..."abc {}\"\\:,[]\n"), maxLength: 12 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
/** Arrays hold primitives only; a path `lineOf` takes never crosses an array. */
const leaf: fc.Arbitrary<Json> = fc.oneof(primitive, fc.array(primitive, { maxLength: 3 }));
const inner: fc.Arbitrary<Json> = fc.dictionary(key, leaf, { maxKeys: 4 });
const middle: fc.Arbitrary<Json> = fc.dictionary(key, fc.oneof(leaf, inner), { maxKeys: 4 });
const root = fc.dictionary(key, fc.oneof(leaf, middle), { maxKeys: 4 });

interface Anchor {
  line: number;
  /** Whether the value under the key opens a block, so a path can continue below it. */
  block: boolean;
}

/**
 * Lays `value` out the way `JSON.stringify(value, null, 2)` does, one entry
 * per line, recording the line each key lands on under its path from the
 * root. `head` is what the first line begins with — the indented key, for an
 * object entry — and `tail` the comma that follows every entry but the last.
 */
function layout(
  value: Json,
  pad: string,
  head: string,
  tail: string,
  path: string[],
  lines: string[],
  at: Map<string, Anchor>,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${head}[]${tail}`);
      return;
    }
    lines.push(`${head}[`);
    value.forEach((item, i) => lines.push(`${pad}  ${JSON.stringify(item)}${i < value.length - 1 ? "," : ""}`));
    lines.push(`${pad}]${tail}`);
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${head}{}${tail}`);
      return;
    }
    lines.push(`${head}{`);
    keys.forEach((k, i) => {
      const below = [...path, k];
      const child = value[k];
      const block = child !== null && typeof child === "object" && !Array.isArray(child);
      at.set(JSON.stringify(below), { line: lines.length + 1, block });
      layout(child, `${pad}  `, `${pad}  ${JSON.stringify(k)}: `, i < keys.length - 1 ? "," : "", below, lines, at);
    });
    lines.push(`${pad}}${tail}`);
    return;
  }
  lines.push(`${head}${JSON.stringify(value)}${tail}`);
}

const laidOut = fc.record({ value: root, crlf: fc.boolean() }).map(({ value, crlf }) => {
  const lines: string[] = [];
  const at = new Map<string, Anchor>();
  layout(value, "", "", "", [], lines, at);
  return { value, lines, text: lines.join(crlf ? "\r\n" : "\n"), at };
});

/** A key outside the key alphabet, so it is absent from every object generated. */
const ABSENT = "~";

describe("properties: lineOf", () => {
  it("lays a document out exactly as JSON.stringify does", () => {
    // The oracle is trusted only because this holds; the two properties
    // below assert nothing that this one has not first tied to the real
    // layout.
    fc.assert(
      fc.property(laidOut, ({ value, lines }) => {
        expect(lines.join("\n")).toBe(JSON.stringify(value, null, 2));
      }),
      { numRuns: RUNS },
    );
  });

  it("anchors every key on the line the oracle put it, in either line ending", () => {
    fc.assert(
      fc.property(laidOut, ({ text, at }) => {
        for (const [path, anchor] of at) {
          expect(lineOf(text, JSON.parse(path) as string[])).toBe(anchor.line);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("resolves nothing below an absent key, or below a value that opens no block", () => {
    // Every key name in the document is asked for below every key it does not
    // sit under. Below a block, that is what holds the scan inside the block
    // it descended into — a name that exists only in a later sibling must not
    // be answered once this block has closed. Below a string, number or
    // array, no path continues at all, and the same name must not be answered
    // from whichever block happens to open next. A name outside the alphabet
    // covers the root.
    fc.assert(
      fc.property(laidOut, ({ text, at }) => {
        const paths = [...at.keys()].map((path) => JSON.parse(path) as string[]);
        const names = new Set(paths.map((parts) => parts[parts.length - 1]));
        const under = (parts: string[]): Set<string> =>
          new Set(
            paths
              .filter((p) => p.length === parts.length + 1 && parts.every((k, i) => p[i] === k))
              .map((p) => p[p.length - 1]),
          );
        expect(lineOf(text, [ABSENT])).toBeUndefined();
        for (const [path, anchor] of at) {
          const parts = JSON.parse(path) as string[];
          const own = anchor.block ? under(parts) : new Set<string>();
          for (const name of [...names, ABSENT]) {
            if (!own.has(name)) expect(lineOf(text, [...parts, name])).toBeUndefined();
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("properties: mapOf", () => {
  const inherited = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
  const name = fc.oneof(fc.constantFrom(...inherited), fc.string({ maxLength: 12 }));
  const entries = fc.uniqueArray(fc.tuple(name, fc.string({ maxLength: 8 })), {
    selector: ([n]) => n,
    maxLength: 6,
  });

  it("preserves every name and range through a manifest, whatever the names are", () => {
    fc.assert(
      fc.property(entries, (list) => {
        // Through JSON, as the analyzers read it, so the object under test is
        // the one JSON.parse builds rather than one assembled here.
        const source = JSON.parse(JSON.stringify({ dependencies: Object.fromEntries(list) })) as Record<
          string,
          unknown
        >;
        const map = mapOf(source, "dependencies");
        expect(Object.getPrototypeOf(map)).toBeNull();
        expect(Object.keys(map).sort()).toEqual(list.map(([n]) => n).sort());
        for (const [n, v] of list) expect(map[n]).toBe(v);
        const present = new Set(list.map(([n]) => n));
        for (const n of inherited) if (!present.has(n)) expect(map[n]).toBeUndefined();
      }),
      { numRuns: RUNS },
    );
  });
});
