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
});
