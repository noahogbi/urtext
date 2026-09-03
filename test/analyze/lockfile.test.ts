import { describe, expect, it } from "vitest";
import { lockfileFactsFor, LockfileParseError } from "../../src/analyze/lockfile.js";
import { toFinding } from "../../src/score/index.js";

const mkManifest = (o: Record<string, unknown>) => JSON.stringify({ name: "p", version: "1.0.0", ...o }, null, 2);
const mkLock = (root: Record<string, unknown>, pkgs: Record<string, unknown> = {}, version = "1.0.0") =>
  JSON.stringify({ name: "p", version, lockfileVersion: 3, packages: { "": { name: "p", version, ...root }, ...pkgs } }, null, 2);
// An older lockfile format written before the `packages` map existed: a
// `dependencies` map of resolved objects at the document root, no
// `packages` key at all.
const mkLegacyLock = (deps: Record<string, unknown> = {}, version = "1.0.0") =>
  JSON.stringify({ name: "p", version, lockfileVersion: 1, dependencies: deps }, null, 2);

describe("lockfileFactsFor", () => {
  it("reports a range the lockfile does not agree with", () => {
    const before = mkManifest({ dependencies: { a: "^1.0.0" } });
    const after = mkManifest({ dependencies: { a: "^2.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.1" } });
    const facts = lockfileFactsFor("package-lock.json", before, after, lock, lock);
    const sync = facts.filter((f) => f.kind === "lockfile_out_of_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].detail).toMatchObject({ map: "dependencies", name: "a", manifest: "^2.0.0", lock: "^1.0.0" });
    expect(sync[0].id).toBe("lockfile_out_of_sync:package-lock.json:dependencies:a");
  });

  it("names the lockfile as the evidence file, not its contents", () => {
    // Both parameters of the evidence helper are strings, so passing the
    // text where the path belongs typechecks and every other test here
    // still passes — while the whole lockfile ends up in Fact.file, and
    // coverage stops recognising that the file was reported on.
    const manifest = mkManifest({ dependencies: { a: "^2.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" } });
    const [fact] = lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock);
    expect(fact.file).toBe("package-lock.json");
    expect(fact.evidence[0].file).toBe("package-lock.json");
  });

  it("anchors an added-but-not-installed dependency even though no key exists to point at", () => {
    // The commonest out-of-sync commit: added to the manifest, npm install
    // never run. There is no key in packages[""] for it, so the anchor must
    // degrade to the map, and the assertion must be able to fail — asserting
    // only that a line is positive is a tautology, since every fallback
    // returns at least the first line.
    const before = mkManifest({ dependencies: {} });
    const after = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLock({ dependencies: {} });
    const facts = lockfileFactsFor("package-lock.json", before, after, lock, lock);
    const sync = facts.filter((f) => f.kind === "lockfile_out_of_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].detail).toMatchObject({ name: "a", manifest: "^1.0.0", lock: null });
    // The `"dependencies":` line inside packages[""], found by locating it in
    // the fixture rather than hard-coding a number that silently rots.
    const expected = lock.split("\n").findIndex((l) => l.trim().startsWith('"dependencies":')) + 1;
    expect(expected).toBeGreaterThan(1);
    expect(sync[0].line).toBe(expected);
  });

  it("anchors inside the map that owns the key when a package is in two maps", () => {
    // Unbounded scanning would anchor the devDependencies finding at the
    // dependencies copy of the same name and quote the wrong range.
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" }, devDependencies: { a: "^9.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" }, devDependencies: { a: "^8.0.0" } });
    const sync = lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock)
      .filter((f) => f.kind === "lockfile_out_of_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].detail).toMatchObject({ map: "devDependencies", manifest: "^9.0.0", lock: "^8.0.0" });
    expect(sync[0].evidence[0].excerpt).toContain("8.0.0");
  });

  it("reports a resolved change under an unchanged range, and no sync finding", () => {
    // The Dependabot shape. This is the false positive the rejected
    // definition would have produced, and is the most important test here.
    const manifest = mkManifest({ devDependencies: { a: "^26.3.0" } });
    const before = mkLock({ devDependencies: { a: "^26.3.0" } }, { "node_modules/a": { version: "26.3.0" } });
    const after = mkLock({ devDependencies: { a: "^26.3.0" } }, { "node_modules/a": { version: "26.4.0" } });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, before, after);
    expect(facts.filter((f) => f.kind === "lockfile_out_of_sync")).toHaveLength(0);
    const moved = facts.filter((f) => f.kind === "dependency_resolved_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0].detail).toMatchObject({
      map: "devDependencies", name: "a", from: "26.3.0", to: "26.4.0", range: "^26.3.0", rangeChanged: false,
    });
  });

  it("reports a stale root version and nothing else when only the version moved", () => {
    const before = mkManifest({ dependencies: { a: "^1.0.0" } });
    const after = JSON.stringify({ name: "p", version: "2.0.0", dependencies: { a: "^1.0.0" } }, null, 2);
    const lock = mkLock({ dependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    const facts = lockfileFactsFor("package-lock.json", before, after, lock, lock);
    expect(facts.map((f) => f.kind)).toEqual(["lockfile_version_stale"]);
    expect(facts[0].detail).toMatchObject({ manifest: "2.0.0", lock: "1.0.0" });
  });

  it("counts transitive movement instead of listing it, and excludes the direct package", () => {
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const before = mkLock({ dependencies: { a: "^1.0.0" } }, {
      "node_modules/a": { version: "1.0.0" }, "node_modules/x": { version: "1.0.0" }, "node_modules/y": { version: "1.0.0" },
    });
    const after = mkLock({ dependencies: { a: "^1.0.0" } }, {
      "node_modules/a": { version: "1.1.0" }, "node_modules/y": { version: "2.0.0" }, "node_modules/z": { version: "1.0.0" },
    });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, before, after);
    const tree = facts.filter((f) => f.kind === "lockfile_tree_changed");
    expect(tree).toHaveLength(1);
    // a is direct and enumerated separately; x left, z entered, y moved.
    expect(tree[0].detail).toMatchObject({ entered: 1, left: 1, moved: 1 });
    expect(facts.filter((f) => f.kind === "dependency_resolved_changed")).toHaveLength(1);
  });

  it("emits no tree fact when nothing transitive moved", () => {
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    expect(lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock)).toEqual([]);
  });

  it("still produces a fact when the lockfile is on one line", () => {
    const manifest = mkManifest({ dependencies: { a: "^2.0.0" } });
    const lock = JSON.stringify({ name: "p", version: "1.0.0", lockfileVersion: 3, packages: { "": { version: "1.0.0", dependencies: { a: "^1.0.0" } } } });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock);
    expect(facts[0].line).toBe(1);
  });

  it("throws a typed error naming the side and the file that did not parse", () => {
    const manifest = mkManifest({ dependencies: {} });
    const lock = mkLock({});

    // Catches the thrown LockfileParseError so its `side`/`which` fields can
    // be asserted directly — `toThrow(LockfileParseError)` alone only
    // checks the error's class, not which of the four parse call sites
    // threw it or what it claimed about itself, so swapping "before" for
    // "after" or "manifest" for "lockfile" at any of them would still pass.
    const thrown = (fn: () => unknown): LockfileParseError => {
      try {
        fn();
      } catch (e) {
        if (e instanceof LockfileParseError) return e;
        throw e;
      }
      throw new Error("expected lockfileFactsFor to throw");
    };

    const beforeManifestErr = thrown(() =>
      lockfileFactsFor("package-lock.json", "{ not json", manifest, lock, lock),
    );
    expect(beforeManifestErr.side).toBe("before");
    expect(beforeManifestErr.which).toBe("manifest");

    const afterManifestErr = thrown(() =>
      lockfileFactsFor("package-lock.json", manifest, "{ not json", lock, lock),
    );
    expect(afterManifestErr.side).toBe("after");
    expect(afterManifestErr.which).toBe("manifest");

    const beforeLockErr = thrown(() =>
      lockfileFactsFor("package-lock.json", manifest, manifest, "{ not json", lock),
    );
    expect(beforeLockErr.side).toBe("before");
    expect(beforeLockErr.which).toBe("lockfile");

    const afterLockErr = thrown(() =>
      lockfileFactsFor("package-lock.json", manifest, manifest, lock, "{ not json"),
    );
    expect(afterLockErr.side).toBe("after");
    expect(afterLockErr.which).toBe("lockfile");
  });

  it("produces nothing when either side is absent", () => {
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" } });
    expect(lockfileFactsFor("package-lock.json", manifest, manifest, null, lock)).toEqual([]);
    expect(lockfileFactsFor("package-lock.json", manifest, manifest, lock, null)).toEqual([]);
  });

  it("excludes a package this same change adds to package.json from the transitive tree count", () => {
    // The tree finding's body says the current package.json does not name
    // these packages, so the exclusion set must be built from the after-side
    // manifest, not the before-side one. Package b is absent from the before
    // manifest and lockfile, and present — already installed — on the after
    // side of both: a before-side exclusion set would miss it entirely and
    // miscount its arrival as transitive churn, when it is in fact a direct,
    // already-declared dependency the after manifest names.
    const before = mkManifest({ dependencies: { a: "^1.0.0" } });
    const after = mkManifest({ dependencies: { a: "^1.0.0", b: "^1.0.0" } });
    const beforeLock = mkLock({ dependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    const afterLock = mkLock({ dependencies: { a: "^1.0.0", b: "^1.0.0" } }, {
      "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "1.0.0" },
    });
    expect(lockfileFactsFor("package-lock.json", before, after, beforeLock, afterLock)).toEqual([]);
  });

  it("emits no out-of-sync facts against a legacy lockfile that carries no packages map", () => {
    // A lockfile written before the packages map existed has nothing
    // recorded to compare the manifest's ranges against, so the out-of-sync
    // pass must be skipped rather than reporting every declared dependency
    // as unrecorded.
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLegacyLock({ a: { version: "1.0.1", resolved: "https://example.invalid/a", integrity: "sha-fake" } });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock);
    expect(facts.filter((f) => f.kind === "lockfile_out_of_sync")).toEqual([]);
  });

  it("still reports a stale root version against a legacy lockfile with no packages map", () => {
    const before = mkManifest({ dependencies: { a: "^1.0.0" } });
    const after = JSON.stringify({ name: "p", version: "2.0.0", dependencies: { a: "^1.0.0" } }, null, 2);
    const lock = mkLegacyLock({ a: { version: "1.0.1", resolved: "https://example.invalid/a", integrity: "sha-fake" } });
    const facts = lockfileFactsFor("package-lock.json", before, after, lock, lock);
    expect(facts.map((f) => f.kind)).toEqual(["lockfile_version_stale"]);
    expect(facts[0].detail).toMatchObject({ manifest: "2.0.0", lock: "1.0.0" });
  });

  it("flags rangeChanged when the declared range itself moved, and changes the finding's leading clause", () => {
    // The Dependabot test pins rangeChanged: false under an unchanged range.
    // A hard-coded false would still pass that test, since its fixture never
    // moves the range. Here the before manifest's range genuinely differs
    // from the after manifest's, so only a real comparison returns true —
    // and the rendered finding body changes its opening clause to match.
    const before = mkManifest({ devDependencies: { a: "^26.2.0" } });
    const after = mkManifest({ devDependencies: { a: "^26.3.0" } });
    const beforeLock = mkLock({ devDependencies: { a: "^26.2.0" } }, { "node_modules/a": { version: "26.2.0" } });
    const afterLock = mkLock({ devDependencies: { a: "^26.3.0" } }, { "node_modules/a": { version: "26.3.0" } });
    const facts = lockfileFactsFor("package-lock.json", before, after, beforeLock, afterLock);
    const moved = facts.filter((f) => f.kind === "dependency_resolved_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0].detail).toMatchObject({ rangeChanged: true, range: "^26.3.0" });
    expect(toFinding(moved[0]).body).not.toMatch(/did not change/);
  });

  it("does not swap entered and left: an asymmetric count only a correct pairing survives", () => {
    // The only existing tree-churn fixture uses one-in, one-out, one-moved —
    // symmetric enough that swapping the entered and left branches still
    // produces the same object. This fixture is asymmetric on purpose.
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const before = mkLock({ dependencies: { a: "^1.0.0" } }, {
      "node_modules/a": { version: "1.0.0" }, "node_modules/x": { version: "1.0.0" }, "node_modules/y": { version: "1.0.0" },
    });
    const after = mkLock({ dependencies: { a: "^1.0.0" } }, {
      "node_modules/a": { version: "1.0.0" }, "node_modules/w": { version: "1.0.0" },
    });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, before, after);
    const tree = facts.filter((f) => f.kind === "lockfile_tree_changed");
    expect(tree).toHaveLength(1);
    expect(tree[0].detail).toMatchObject({ entered: 1, left: 2, moved: 0 });
  });

  it("does not let the bound-exit guard leak past an empty map into a sibling map's same-named key", () => {
    // A weakened exit guard would let the scan continue past the closed,
    // empty dependencies block and match b inside the sibling
    // devDependencies block instead, quoting that block's range as if it
    // belonged to dependencies. The existing two-map test only exercises the
    // forward case, where the key is present in its own map.
    const manifest = mkManifest({ dependencies: { b: "^1.0.0" } });
    const lock = mkLock({ dependencies: {}, devDependencies: { b: "^9.9.9" } });
    const sync = lockfileFactsFor("package-lock.json", manifest, manifest, lock, lock).filter(
      (f) => f.kind === "lockfile_out_of_sync" && f.detail.map === "dependencies" && f.detail.name === "b",
    );
    expect(sync).toHaveLength(1);
    expect(sync[0].evidence[0].excerpt).not.toContain("9.9.9");
    expect(sync[0].evidence[0].excerpt).toContain("dependencies");
  });

  it("quotes the after-side lockfile text as evidence, not the before-side text", () => {
    // Both fact-emitting evidence calls read afterLockText. Switching either
    // one to beforeLockText would quote the wrong revision's range or
    // resolved version, while every detail-based assertion elsewhere in
    // this file still passes, since detail is built independently of
    // evidence.
    const manifest = mkManifest({ dependencies: { a: "^2.0.0" } });
    const beforeLock = mkLock({ dependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    const afterLock = mkLock({ dependencies: { a: "^3.0.0" } }, { "node_modules/a": { version: "3.0.0" } });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, beforeLock, afterLock);

    const sync = facts.find((f) => f.kind === "lockfile_out_of_sync");
    expect(sync?.evidence[0].excerpt).toContain("3.0.0");
    expect(sync?.evidence[0].excerpt).not.toContain("1.0.0");

    const moved = facts.find((f) => f.kind === "dependency_resolved_changed");
    expect(moved?.evidence[0].excerpt).toContain("3.0.0");
    expect(moved?.evidence[0].excerpt).not.toContain("1.0.0");
  });

  it("gives each fact its own id, not a constant shared across a fact kind's occurrences", () => {
    // reconcile indexes findings by id, so a per-path constant for any of
    // these formats would silently collapse several distinct facts into
    // one entry. Two changed direct dependencies pin the
    // dependency_resolved_changed format; the version and tree facts pin
    // their own, otherwise-unasserted-elsewhere formats.
    const before = mkManifest({ dependencies: { a: "^1.0.0", c: "^1.0.0" } });
    const after = JSON.stringify({ name: "p", version: "2.0.0", dependencies: { a: "^1.0.0", c: "^1.0.0" } }, null, 2);
    const beforeLock = mkLock({ dependencies: { a: "^1.0.0", c: "^1.0.0" } }, {
      "node_modules/a": { version: "1.0.0" }, "node_modules/c": { version: "1.0.0" }, "node_modules/x": { version: "1.0.0" },
    });
    const afterLock = mkLock({ dependencies: { a: "^1.0.0", c: "^1.0.0" } }, {
      "node_modules/a": { version: "1.1.0" }, "node_modules/c": { version: "1.1.0" }, "node_modules/y": { version: "1.0.0" },
    });
    const facts = lockfileFactsFor("package-lock.json", before, after, beforeLock, afterLock);

    const moved = facts.filter((f) => f.kind === "dependency_resolved_changed");
    expect(moved.map((f) => f.id).sort()).toEqual([
      "dependency_resolved_changed:package-lock.json:a",
      "dependency_resolved_changed:package-lock.json:c",
    ]);

    const stale = facts.find((f) => f.kind === "lockfile_version_stale");
    expect(stale?.id).toBe("lockfile_version_stale:package-lock.json");

    const tree = facts.find((f) => f.kind === "lockfile_tree_changed");
    expect(tree?.id).toBe("lockfile_tree_changed:package-lock.json");
  });

  it("keeps the first-declared map when a package appears in two maps, not the last", () => {
    // detail.map halves the score for dev/optional maps (see the
    // first-map-wins comment above direct.set in the source). Last-wins
    // would silently halve a runtime dependency's score whenever it is
    // also duplicated in devDependencies.
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" }, devDependencies: { a: "^1.0.0" } });
    const before = mkLock({ dependencies: { a: "^1.0.0" }, devDependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.0.0" } });
    const after = mkLock({ dependencies: { a: "^1.0.0" }, devDependencies: { a: "^1.0.0" } }, { "node_modules/a": { version: "1.1.0" } });
    const facts = lockfileFactsFor("package-lock.json", manifest, manifest, before, after);
    const moved = facts.filter((f) => f.kind === "dependency_resolved_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0].detail).toMatchObject({ map: "dependencies" });
  });
});
