import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dependencyFactsFor, ManifestParseError } from "../../src/analyze/dependencies.js";
import { runAnalyzers } from "../../src/analyze/index.js";
import { createContext, extract } from "../../src/extract/index.js";

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

describe("through the real pipeline", () => {
  let repo: string;
  let renameRepo: string;

  const gitIn = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      stdio: "pipe",
    });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "urtext-deps-"));
    gitIn(repo, ["init", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "t@e.com"]);
    gitIn(repo, ["config", "user.name", "T"]);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { keep: "^1.0.0" } }, null, 2),
    );
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "first"]);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          version: "1.0.0",
          dependencies: { keep: "^2.0.0" },
          devDependencies: { vitest: "^4.0.0" },
        },
        null,
        2,
      ),
    );

    renameRepo = mkdtempSync(join(tmpdir(), "urtext-deps-mv-"));
    gitIn(renameRepo, ["init", "-b", "main"]);
    gitIn(renameRepo, ["config", "user.email", "t@e.com"]);
    gitIn(renameRepo, ["config", "user.name", "T"]);
    mkdirSync(join(renameRepo, "pkgs", "a"), { recursive: true });
    writeFileSync(
      join(renameRepo, "pkgs", "a", "package.json"),
      JSON.stringify({ name: "a", version: "1.0.0", dependencies: { keep: "^1.0.0" } }, null, 2),
    );
    gitIn(renameRepo, ["add", "-A"]);
    gitIn(renameRepo, ["commit", "-m", "first"]);
    gitIn(renameRepo, ["mv", "pkgs/a", "pkgs/b"]);
    gitIn(renameRepo, ["commit", "-m", "move the workspace"]);
  });

  it("emits prefixed, map-segmented ids from a real diff", async () => {
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range));
    const dep = facts.filter((f) => f.kind.startsWith("dependency_"));
    expect(dep.map((f) => f.id).sort()).toEqual([
      "dependency_added:package.json:devDependencies:vitest",
      "dependency_changed:package.json:dependencies:keep",
    ]);
  });

  it("emits nothing for a renamed manifest with unchanged dependencies", async () => {
    // Without previousPath resolution the before side reads null and every
    // entry emits as added -- a screen of false verified findings from one
    // directory move.
    const cs = await extract(renameRepo, "HEAD~1...HEAD");
    const facts = await runAnalyzers(cs, createContext(renameRepo, cs.range));
    expect(facts.filter((f) => f.kind.startsWith("dependency_"))).toEqual([]);
  });
});
