import { describe, expect, it } from "vitest";
import { dependencyFactsFor, ManifestParseError } from "../../src/analyze/dependencies.js";

const manifest = (maps: Record<string, Record<string, string>>): string =>
  JSON.stringify({ name: "fixture", version: "1.0.0", ...maps }, null, 2);

describe("dependencyFactsFor", () => {
  it("reports added, removed, and changed entries per map", () => {
    const before = manifest({ dependencies: { keep: "^1.0.0", gone: "^2.0.0", bump: "^1.0.0" } });
    const after = manifest({ dependencies: { keep: "^1.0.0", added: "^3.0.0", bump: "^2.0.0" } });
    const facts = dependencyFactsFor("package.json", before, after);
    const ids = facts.map((f) => f.id).sort();
    expect(ids).toEqual([
      "dependency_added:package.json:dependencies:added",
      "dependency_changed:package.json:dependencies:bump",
      "dependency_removed:package.json:dependencies:gone",
    ]);
    const changed = facts.find((f) => f.kind === "dependency_changed");
    expect(changed?.detail).toMatchObject({
      map: "dependencies",
      name: "bump",
      from: "^1.0.0",
      to: "^2.0.0",
    });
  });

  it("treats a null before side as all added and a null after side as all removed", () => {
    const text = manifest({ dependencies: { only: "^1.0.0" } });
    expect(dependencyFactsFor("package.json", null, text).map((f) => f.kind)).toEqual([
      "dependency_added",
    ]);
    const removed = dependencyFactsFor("package.json", text, null);
    expect(removed.map((f) => f.kind)).toEqual(["dependency_removed"]);
    expect(removed[0].evidence[0].side).toBe("before");
  });

  it("renders a map-to-map move as one removal plus one addition", () => {
    const before = manifest({ dependencies: { moved: "^1.0.0" } });
    const after = manifest({ devDependencies: { moved: "^1.0.0" } });
    const kinds = dependencyFactsFor("package.json", before, after)
      .map((f) => `${f.kind}:${String(f.detail.map)}`)
      .sort();
    expect(kinds).toEqual(["dependency_added:devDependencies", "dependency_removed:dependencies"]);
  });

  it("gives the same package in two maps two distinct ids", () => {
    const before = manifest({});
    const after = manifest({
      peerDependencies: { react: "^19.0.0" },
      devDependencies: { react: "^19.0.0" },
    });
    const ids = dependencyFactsFor("package.json", before, after).map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("anchors evidence on the entry's own line in its own map", () => {
    const before = manifest({});
    const after = manifest({
      dependencies: { "left-pad": "^1.3.0" },
      devDependencies: { "left-pad": "^1.3.0" },
    });
    const facts = dependencyFactsFor("package.json", before, after);
    const runtime = facts.find((f) => f.detail.map === "dependencies");
    const dev = facts.find((f) => f.detail.map === "devDependencies");
    const lines = after.split("\n");
    expect(lines[(runtime?.line ?? 1) - 1]).toContain('"left-pad"');
    // The dependencies block precedes devDependencies in this fixture, so the
    // runtime fact's line must be the earlier occurrence.
    expect(runtime?.line ?? 0).toBeLessThan(dev?.line ?? 0);
  });

  it("produces no facts from peerDependenciesMeta or overrides alone", () => {
    const before = manifest({});
    const afterObj = {
      name: "fixture",
      version: "1.0.0",
      peerDependenciesMeta: { "left-pad": { optional: true } },
      overrides: { "left-pad": "^9.9.9" },
    };
    const facts = dependencyFactsFor("package.json", before, JSON.stringify(afterObj, null, 2));
    expect(facts).toEqual([]);
  });

  it("anchors inside the real peerDependencies block, past the Meta superstring", () => {
    // The anchoring adversary, not just the parsing one: an earlier draft's
    // fixture held no real map at all, so the scan was never exercised and
    // the test could not fail. Here peerDependenciesMeta comes FIRST,
    // holding the same package name as a key -- a substring match on the map
    // key, or a first-occurrence match on the name, anchors the wrong block.
    const before = manifest({});
    const afterObj = {
      name: "fixture",
      version: "1.0.0",
      peerDependenciesMeta: { "left-pad": { optional: true } },
      peerDependencies: { "left-pad": "^1.3.0" },
    };
    const afterText = JSON.stringify(afterObj, null, 2);
    const [fact] = dependencyFactsFor("package.json", before, afterText);
    expect(fact.detail.map).toBe("peerDependencies");
    const lines = afterText.split("\n");
    expect(lines[fact.line - 1]).toContain('"left-pad": "^1.3.0"');
  });

  it("throws ManifestParseError naming the unparseable side", () => {
    // Not try/catch with an assertion in the catch body -- if nothing
    // throws, a catch-body assertion never runs and the test passes
    // vacuously.
    expect(() => dependencyFactsFor("package.json", "{ not json", manifest({}))).toThrowError(
      ManifestParseError,
    );
    expect(() => dependencyFactsFor("package.json", "{ not json", manifest({}))).toThrowError(
      expect.objectContaining({ side: "before" }),
    );
    expect(() => dependencyFactsFor("package.json", manifest({}), "{ nope")).toThrowError(
      expect.objectContaining({ side: "after" }),
    );
  });

  it("returns no facts when nothing changed", () => {
    const text = manifest({ dependencies: { same: "^1.0.0" } });
    expect(dependencyFactsFor("package.json", text, text)).toEqual([]);
  });
});
