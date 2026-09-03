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
});
