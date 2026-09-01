# package.json Dependency Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sixth analyzer producing deterministic, `verified`-tier facts from `package.json` dependency changes — added, removed, version-changed — on every run, including `--no-llm`.

**Architecture:** A pure diffing core (`dependencyFactsFor`) testable without git, wrapped by a factory analyzer (`makeDependencyAnalyzer({ onNote })`) that handles statuses, renames, and unparseable manifests, registered beside the existing five. Three new `FactKind`s ripple through the enumerated mappings first, so every commit stays green.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest. No new dependencies — the parser is `JSON.parse`.

**Spec:** `docs/superpowers/specs/2026-09-01-urtext-dependency-facts-design.md` (revision 3, after two Fable reviews). Read it first — its "What earlier revisions got wrong" section names nine errors already made and corrected while designing this; the plan exists to not remake them.

## Global Constraints

- Work continues on this branch; one PR at the end. Direct pushes to master bypass a declared protection rule — never push master.
- Every commit leaves `npx tsc --noEmit` AND `npx vitest run` green. vitest does not typecheck; CI runs both.
- Fact ids: `dependency_added:<path>:<map>:<name>` — kind prefix, then path, then **map** (ids collide without it: peer+dev same-package is the standard library convention), then name. `<path>` is `file.path` as the changeset lists it.
- The before side of every read is `file.previousPath ?? file.path`; `status === "added"` skips the before read, `"deleted"` skips the after read. Getting this wrong emits false `verified` findings on renamed manifests.
- The analyzer never calls `ctx.programAt` (`src/types.ts:243-247` says analyzers that do not need the checker must not).
- The factory names its analyzer via `Object.defineProperty(fn, "name", { value: "dependencyAnalyzer" })` — an inner const is NOT sufficient; esbuild renames shadowed bindings (`src/analyze/citations.ts:1083-1090`, fix at `:1158`).
- New reader-facing copy contains none of: `unsanctioned`, `unauthorized`, `approved`, `permission`, `forbidden`, `allowed` (`test/report/copy-guard.test.ts:29-36`), and never issues a verdict.
- Comments must not restate a `WEIGHTS` value as a bare numeral — `test/comment-contract.test.ts` fails on it (this bit three times during the intent-gap work; avoid digits in comments near scoring).
- Weights are uncalibrated by the spec's own admission. Task 6 calibrates against real ranges before the PR.

> **Line numbers** below were verified on 2026-09-01 at commit `ccc9f72` and drift as tasks land. Anchor on symbol names.

---

### Task 1: The kinds exist, score, band, route, and speak

Everything the compiler forces, plus the prose, in one commit — a new `FactKind` trips `SUBJECT_OF_KIND`'s `satisfies` and `toFinding`'s definite assignment the moment it exists, so this is the smallest green unit.

**Files:**
- Modify: `src/types.ts` (FactKind union, ~line 100)
- Modify: `src/report/model.ts` (Subject ~98 + its doc comment ~94-96; SUBJECT_OF_KIND ~488; LENS_OF_SUBJECT ~673 + its doc comment ~664-672)
- Modify: `src/score/index.ts` (WEIGHTS ~23; scoreFact ~68; minPossibleAnalyzerScore ~124; toFinding switch ~359)
- Test: `test/report/model.test.ts`, `test/score/index.test.ts` (or the file holding `toFinding`/`rank` tests — check `grep -rl "toFinding" test/`), `test/score/reconcile.test.ts`

**Interfaces:**
- Produces: `FactKind` members `"dependency_added" | "dependency_removed" | "dependency_changed"`; `Subject` member `"dependency"` → lens `"narrative"`; `WEIGHTS.factKind` entries 55/45/30; `WEIGHTS.dependencyMap: { dependencies: 1, peerDependencies: 1, devDependencies: 0.5, optionalDependencies: 0.5 }`; `detail` contract `{ map: string, name: string, from?: string, to?: string }`.
- Consumed by Tasks 2-5 exactly as named here.

- [ ] **Step 1: Write the failing copy and scoring tests**

In the test file that already exercises `toFinding` (find it: `grep -rln "toFinding(" test/`):

```typescript
describe("dependency findings", () => {
  const dep = (kind: FactKind, detail: Record<string, unknown>): Fact => ({
    id: `${kind}:package.json:${detail.map}:${detail.name}`,
    kind,
    file: "package.json",
    line: 12,
    detail,
    evidence: [{ file: "package.json", line: 12, excerpt: '"left-pad": "^1.3.0"' }],
  });

  it("says what each dependency finding means, in the spec's copy", () => {
    const added = toFinding(
      dep("dependency_added", { map: "dependencies", name: "left-pad", to: "^1.3.0" }),
    );
    expect(added.title).toBe("adds left-pad to dependencies");
    expect(added.body).toContain('now declares `left-pad` (`^1.3.0`) in `dependencies`');
    // The runtime clause appears for runtime maps only.
    expect(added.body).toContain("install scripts run whether or not anything imports it");

    const devAdded = toFinding(
      dep("dependency_added", { map: "devDependencies", name: "eslint", to: "^9.0.0" }),
    );
    expect(devAdded.body).not.toContain("install scripts run");

    const removed = toFinding(
      dep("dependency_removed", { map: "dependencies", name: "left-pad", from: "^1.3.0" }),
    );
    expect(removed.title).toBe("removes left-pad from dependencies");
    expect(removed.body).toContain("no longer declares");

    const changed = toFinding(
      dep("dependency_changed", { map: "dependencies", name: "typescript", from: "^5.0.0", to: "^6.0.0" }),
    );
    expect(changed.title).toBe("changes typescript in dependencies: ^5.0.0 → ^6.0.0");
    expect(changed.body).toContain("the lockfile decides what actually resolves");
  });

  it("ranks a runtime addition above the same addition in devDependencies", () => {
    // Through rank, not by reading weights — the multiplier only matters if
    // the sort feels it.
    const runtime = dep("dependency_added", { map: "dependencies", name: "a", to: "1" });
    const dev = dep("dependency_added", { map: "devDependencies", name: "b", to: "1" });
    const ranked = rank([dev, runtime]);
    expect(ranked[0].detail.map).toBe("dependencies");
  });

  it("routes dependency findings to the narrative lens", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ id: "dependency_added:package.json:dependencies:left-pad", tier: "verified", file: "package.json" })],
      { warnings: [] },
    );
    expect(m.findings[0].lens).toBe("narrative");
    expect(m.findings[0].subject).toBe("dependency");
  });
});
```

(The `rank`/`buildReportModel`/fixture helpers differ per test file — reuse each file's existing helpers rather than pasting these verbatim; the assertions are the contract.)

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/score test/report/model.test.ts -t "dependency"`
Expected: FAIL at compile or assertion — `"dependency_added"` is not a `FactKind`.

- [ ] **Step 3: Implement the union and mappings**

`src/types.ts` — extend the union:

```typescript
export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed"
  | "export_added"
  | "export_removed"
  | "signature_changed"
  | "blast_radius"
  | "citation_rot"
  | "dependency_added"
  | "dependency_removed"
  | "dependency_changed";
```

`src/report/model.ts` — extend `Subject` and both mappings, and extend the two prose
enumerations of narrative-only subjects (the `Subject` doc comment and `LENS_OF_SUBJECT`'s)
in the same edit — this repository runs a citation analyzer over its own comments:

```typescript
export type Subject = "effect" | "guard" | "surface" | "reach" | "citation" | "dependency";
```

```typescript
  dependency_added: "dependency",
  dependency_removed: "dependency",
  dependency_changed: "dependency",
```

```typescript
  dependency: "narrative",
```

- [ ] **Step 4: Implement scoring**

`src/score/index.ts`. In `WEIGHTS`, add to `factKind` (place beside the existing entries; keep the object's comment style):

```typescript
    dependency_added: 55,
    dependency_removed: 45,
    dependency_changed: 30,
```

Add a sibling map to `WEIGHTS` (beside `effect`):

```typescript
  /**
   * Scales a dependency fact by which map declared it. Runtime maps ship to
   * every consumer; dev and optional maps do not, and dev churn is constant
   * in an active repository — unscaled, a run of devDependency bumps buries
   * the one runtime addition that matters.
   */
  dependencyMap: {
    dependencies: 1,
    peerDependencies: 1,
    devDependencies: 0.5,
    optionalDependencies: 0.5,
  } as Record<string, number>,
```

In `scoreFact`, after the `blast_radius` branch:

```typescript
  if (
    fact.kind === "dependency_added" ||
    fact.kind === "dependency_removed" ||
    fact.kind === "dependency_changed"
  ) {
    const map = typeof fact.detail.map === "string" ? fact.detail.map : "dependencies";
    return base * (WEIGHTS.dependencyMap[map] ?? 1);
  }
```

In `minPossibleAnalyzerScore`, before the fallthrough — a dependency fact always carries a
map, so a `{}` synthetic is an input the analyzer cannot produce, and the floor must be
computed from real shapes only:

```typescript
    if (
      kind === "dependency_added" ||
      kind === "dependency_removed" ||
      kind === "dependency_changed"
    ) {
      return Object.keys(WEIGHTS.dependencyMap).map((map) =>
        scoreFact(syntheticFact(kind, { map })),
      );
    }
```

Extend the guard test's independent recomputation the same way — `test/score/reconcile.test.ts:50-70`, whose else-branch currently uses `detail: {}`; add a matching `else if` enumerating the maps. Without it the guard inherits the blind spot it exists to catch.

- [ ] **Step 5: Implement the three `toFinding` branches**

In the switch (`src/score/index.ts:359-527`), using the file's existing `str` helper:

```typescript
    case "dependency_added": {
      const map = str(fact.detail.map, "dependencies");
      const name = str(fact.detail.name, "a package");
      const to = str(fact.detail.to, "unknown");
      const runtime = map === "dependencies" || map === "peerDependencies";
      title = `adds ${name} to ${map}`;
      body =
        `package.json now declares \`${name}\` (\`${to}\`) in \`${map}\`.` +
        (runtime
          ? " A runtime dependency installs for every consumer; its install scripts run whether or not anything imports it."
          : "");
      break;
    }
    case "dependency_removed": {
      const map = str(fact.detail.map, "dependencies");
      const name = str(fact.detail.name, "a package");
      const from = str(fact.detail.from, "unknown");
      title = `removes ${name} from ${map}`;
      body = `package.json no longer declares \`${name}\` (was \`${from}\`) in \`${map}\`. Anything still importing it now resolves only if something else provides it.`;
      break;
    }
    case "dependency_changed": {
      const map = str(fact.detail.map, "dependencies");
      const name = str(fact.detail.name, "a package");
      const from = str(fact.detail.from, "unknown");
      const to = str(fact.detail.to, "unknown");
      title = `changes ${name} in ${map}: ${from} → ${to}`;
      body = `The declared range moved. This is the manifest's constraint, not what installs: within a range, the lockfile decides what actually resolves.`;
      break;
    }
```

- [ ] **Step 6: Full gate and commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — including `test/score/reconcile.test.ts` (floor unmoved: 30 × 0.5 = 15 > 6) and the copy guard (new copy has none of the six words).

```bash
git add -A
git commit -m "feat: dependency fact kinds, scoring, routing, and copy"
```

---

### Task 2: The pure diffing core

**Files:**
- Create: `src/analyze/dependencies.ts` (the pure half only)
- Test: `test/analyze/dependencies.test.ts` (new)

**Interfaces:**
- Produces: `export function dependencyFactsFor(path: string, beforeText: string | null, afterText: string | null): Fact[]` and `export class ManifestParseError extends Error { constructor(public side: "before" | "after", cause: unknown) }` — thrown when a non-null side fails `JSON.parse`; the factory (Task 3) catches it.
- Consumes: `makeFact` (`src/analyze/fact.ts`), `FactKind` from Task 1.

**Rules the code must embody (all from the spec):**
- Four maps: `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`.
- `beforeText === null` ⇒ every entry `dependency_added`; `afterText === null` ⇒ every entry `dependency_removed` with before-side evidence.
- A map-to-map move is one removal plus one addition — two facts, deliberately.
- Ids: `` `${kind}:${path}:${map}:${name}` ``.
- Evidence line: exact `"<key>":` match with brace-tracked block bounds. `"peerDependenciesMeta"` must not satisfy a scan for `"peerDependencies"`, and a name appearing only in `overrides`/`resolutions` anchors nothing. Removal evidence: the line at the **before** text, `side: "before"`; added/changed: the line at the after text, no `side`.

- [ ] **Step 1: Write the failing tests**

```typescript
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
    const changed = facts.find((f) => f.kind === "dependency_changed")!;
    expect(changed.detail).toMatchObject({ map: "dependencies", name: "bump", from: "^1.0.0", to: "^2.0.0" });
  });

  it("treats a null before side as all added and a null after side as all removed", () => {
    const text = manifest({ dependencies: { only: "^1.0.0" } });
    expect(dependencyFactsFor("package.json", null, text).map((f) => f.kind)).toEqual(["dependency_added"]);
    const removed = dependencyFactsFor("package.json", text, null);
    expect(removed.map((f) => f.kind)).toEqual(["dependency_removed"]);
    expect(removed[0].evidence[0].side).toBe("before");
  });

  it("renders a map-to-map move as one removal plus one addition", () => {
    const before = manifest({ dependencies: { moved: "^1.0.0" } });
    const after = manifest({ devDependencies: { moved: "^1.0.0" } });
    const kinds = dependencyFactsFor("package.json", before, after).map((f) => `${f.kind}:${f.detail.map}`).sort();
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
    const after = manifest({ dependencies: { "left-pad": "^1.3.0" }, devDependencies: { "left-pad": "^1.3.0" } });
    const runtime = dependencyFactsFor("package.json", before, after).find(
      (f) => f.detail.map === "dependencies",
    )!;
    const lines = after.split("\n");
    expect(lines[runtime.line - 1]).toContain('"left-pad"');
    // The dependencies block precedes devDependencies in this fixture, so the
    // runtime fact's line must be the earlier occurrence.
    const dev = dependencyFactsFor("package.json", before, after).find(
      (f) => f.detail.map === "devDependencies",
    )!;
    expect(runtime.line).toBeLessThan(dev.line);
  });

  it("is not fooled by peerDependenciesMeta or overrides", () => {
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

  it("throws ManifestParseError naming the unparseable side", () => {
    expect(() => dependencyFactsFor("package.json", "{ not json", manifest({}))).toThrow(ManifestParseError);
    try {
      dependencyFactsFor("package.json", manifest({}), "{ nope");
    } catch (e) {
      expect((e as ManifestParseError).side).toBe("after");
    }
  });

  it("returns no facts when nothing changed", () => {
    const text = manifest({ dependencies: { same: "^1.0.0" } });
    expect(dependencyFactsFor("package.json", text, text)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/analyze/dependencies.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`src/analyze/dependencies.ts`, the pure half. Shape (fill in with real code, not this outline — the outline is the contract, the tests are the spec):

```typescript
import { makeFact } from "./fact.js";
import type { EvidenceRef, Fact } from "../types.js";

const MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export class ManifestParseError extends Error {
  constructor(
    public readonly side: "before" | "after",
    cause: unknown,
  ) {
    super(`package.json did not parse on the ${side} side`, { cause });
  }
}

function parseSide(text: string | null, side: "before" | "after"): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    throw new ManifestParseError(side, e);
  }
}

function mapOf(manifest: Record<string, unknown> | null, key: string): Record<string, string> {
  // null manifest (absent side) and non-object map both read as empty.
}

/**
 * The line of `"name":` inside the top-level `"<map>":` block, by exact key
 * match with brace tracking. `"peerDependenciesMeta"` is a superstring of
 * `"peerDependencies"` and `overrides` holds the same names as keys, so a
 * bare indexOf anchors the wrong line.
 */
function entryLine(text: string, map: string, name: string): number | undefined {
  // Walk lines; enter the block when a line's trimmed start is `"<map>":` at
  // depth 1 (track depth by counting braces per line); inside it, the first
  // line whose trimmed start is `"<name>":` wins; leave at the block's close.
}

export function dependencyFactsFor(
  path: string,
  beforeText: string | null,
  afterText: string | null,
): Fact[] {
  const before = parseSide(beforeText, "before");
  const after = parseSide(afterText, "after");
  const facts: Fact[] = [];
  for (const map of MAPS) {
    const b = mapOf(before, map);
    const a = mapOf(after, map);
    // added: in a, not b — evidence at afterText's entryLine, no side.
    // removed: in b, not a — evidence at beforeText's entryLine, side "before".
    // changed: in both, different value — evidence at afterText's entryLine.
    // Fall back to line 1 with the map name as excerpt if the scan finds
    // nothing (a manifest formatted on one line); the fact is still true.
  }
  return facts;
}
```

- [ ] **Step 4: Run to green, then the full gate**

Run: `npx vitest run test/analyze/dependencies.test.ts` then `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/dependencies.ts test/analyze/dependencies.test.ts
git commit -m "feat: pure dependency diffing core"
```

---

### Task 3: The factory, wiring, and the real path

**Files:**
- Modify: `src/analyze/dependencies.ts` (add the factory + module analyzer)
- Modify: `src/analyze/index.ts` (register; export)
- Modify: `src/cli.ts` (substitution branch beside the citations one, ~line 397-405)
- Test: `test/analyze/dependencies.test.ts`, `test/analyze/index.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `export function makeDependencyAnalyzer(options: { onNote?: (note: string) => void } = {}): Analyzer` and `export const dependencyAnalyzer: Analyzer = makeDependencyAnalyzer()`, `.name === "dependencyAnalyzer"` on both.
- Consumes: `dependencyFactsFor`, `ManifestParseError` from Task 2.

**The factory's loop, per the spec:** for each `changeset.files` entry whose basename is `package.json`: before text = `status === "added" ? null : await ctx.readAt(range.from, file.previousPath ?? file.path)`; after text = `status === "deleted" ? null : await ctx.readAt(range.to, file.path)`; `ManifestParseError` from one manifest becomes one `onNote(...)` line naming the path and side, and the loop continues — other manifests' facts survive. The analyzer name is set with `Object.defineProperty(fn, "name", { value: "dependencyAnalyzer" })`; an inner named const is not enough (esbuild renames shadowed bindings — `src/analyze/citations.ts:1083-1090`, `:1158`).

- [ ] **Step 1: Write the failing tests**

Registration (`test/analyze/index.test.ts` — the existing pins at `:59-64`):

```typescript
  it("registers six analyzers", () => {
    expect(ANALYZERS).toHaveLength(6);
  });

  it("registers the dependency analyzer under its own name", () => {
    expect(ANALYZERS.map((a) => a.name)).toContain("dependencyAnalyzer");
  });
```

(Change the existing "registers five analyzers" test — its 5 becomes this 6; do not leave both.)

Real path + rename, in `test/analyze/dependencies.test.ts` (temporary git repo, same fixture pattern as `test/analyze/index.test.ts`'s `beforeAll`):

```typescript
describe("through the real pipeline", () => {
  it("emits prefixed, map-segmented ids from a real diff, and none for a pure rename", async () => {
    // repo: commit package.json with {dependencies:{keep:"^1.0.0"}}, then
    // working tree adds {devDependencies:{vitest:"^4.0.0"}} and bumps keep.
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range));
    const dep = facts.filter((f) => f.kind.startsWith("dependency_"));
    expect(dep.map((f) => f.id).sort()).toEqual([
      "dependency_added:package.json:devDependencies:vitest",
      "dependency_changed:package.json:dependencies:keep",
    ]);
  });

  it("emits nothing for a renamed manifest with unchanged dependencies", async () => {
    // repo: commit pkgs/a/package.json, then `git mv pkgs/a pkgs/b` and commit.
    // Review that range. Without previousPath resolution every entry emits as
    // added — a screen of false verified findings from one directory move.
    const cs = await extract(renameRepo);
    const facts = await runAnalyzers(cs, createContext(renameRepo, cs.range));
    expect(facts.filter((f) => f.kind.startsWith("dependency_"))).toEqual([]);
  });
});
```

Malformed manifest through `review` (`test/cli.test.ts`, beside the mixed-repo fixtures):

```typescript
  it("says a manifest could not be read, and keeps the other manifest's facts", async () => {
    // repo: two package.json files committed valid; working tree makes one
    // unparseable and adds a dependency to the other.
    const r = await review(badManifestRepo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.warnings.some((w: string) => w.includes("did not parse"))).toBe(true);
    expect(parsed.findings.some((f: Finding) => f.id.startsWith("dependency_added:"))).toBe(true);
  });
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/analyze -t "six analyzers"` (and the new describes)
Expected: FAIL — length 5, name absent, no dependency facts.

- [ ] **Step 3: Implement the factory and register it**

Factory in `dependencies.ts` per the Interfaces block above. Register in `src/analyze/index.ts` (`ANALYZERS` gains `dependencyAnalyzer`; export `dependencyAnalyzer, makeDependencyAnalyzer`). In `src/cli.ts`, extend the `runnable` map beside the citations branch:

```typescript
      : a === dependencyAnalyzer
        ? makeDependencyAnalyzer({ onNote: (note) => warnings.push(note) })
        : a,
```

- [ ] **Step 4: Full gate**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. If the copy-guard or comment-contract suites object to new copy or comments, fix the copy — never the guard.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: the dependency analyzer, wired and named"
```

---

### Task 4: The silent sites

The sites no compiler protects — each shipped or nearly shipped a stale-copy bug before.

**Files:**
- Modify: `src/report/html.ts:313` (the narrative enumeration), `src/report/model.ts` (KIND_NOTES ~537; kindNotesFor ~634), `src/report/coverage.ts` (unanalyzedFiles ~150-163)
- Test: `test/report/html.test.ts` (pins at `:763`, `:793`), `test/report/model.test.ts`, `test/report/coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// html.test.ts — update BOTH existing pins from "All three appear in the
// narrative." to the new sentence, and add:
it("names dependency findings among what the effects lens does not show", () => {
  expect(lens(html, "effects")).toContain("A dependency finding");
  expect(lens(html, "effects")).toContain("All four appear in the narrative.");
});

// model.test.ts:
it("states the manifest-versus-lockfile note once for any mix of dependency kinds", () => {
  const m = buildReportModel(
    changeset(),
    [
      finding({ id: "dependency_added:package.json:dependencies:a", tier: "verified", file: "package.json" }),
      finding({ id: "dependency_removed:package.json:dependencies:b", tier: "verified", file: "package.json" }),
    ],
    { warnings: [] },
  );
  const depNotes = m.kindNotes.filter((n) => n.includes("lockfile decides"));
  expect(depNotes).toHaveLength(1);
});

// coverage.test.ts:
it("does not list a renamed file whose evidence names its old path", () => {
  const cs = changesetWith([
    { path: "pkgs/b/package.json", previousPath: "pkgs/a/package.json", status: "renamed", hunks: [], symbols: [] },
  ]);
  const f = findingOn("pkgs/a/package.json", "verified");
  expect(unanalyzedFiles(cs, [f])).toEqual([]);
});
```

(Check `FileStatus` includes `"renamed"` and the field is `previousPath` — `src/types.ts:70` region — before writing the fixture.)

- [ ] **Step 2: Run and watch fail** — the html pins fail on the old sentence only after Step 3 edits it, so run all three suites now and after.

- [ ] **Step 3: Implement**

`html.ts:313` — extend the sentence before its final clause: `… belongs to none of them either. A dependency finding — a change to what package.json declares — belongs to none of them either. All four appear in the narrative.` (Reword to read well; keep every existing clause; the count word changes from three to four in both places it appears.)

`model.ts` — `KIND_NOTES` gains one shared sentence under all three kinds:

```typescript
  dependency_added: DEPENDENCY_NOTE,
  dependency_removed: DEPENDENCY_NOTE,
  dependency_changed: DEPENDENCY_NOTE,
```

with `const DEPENDENCY_NOTE = "Dependency findings report the manifest's declared constraints; within a range, the lockfile decides what actually resolves.";` and `kindNotesFor` deduping by note text (track a `Set` of pushed notes instead of kinds — behaviour identical for existing kinds, whose notes are all distinct).

`coverage.ts` — `unanalyzedFiles` subtracts a file when **either** of its names appears in fact-backed evidence:

```typescript
    .filter(
      (f) =>
        !isTypeScriptFile(f.path) &&
        !reported.has(f.path) &&
        !(f.previousPath !== undefined && reported.has(f.previousPath)),
    )
```

(Update the function's doc comment: a renamed manifest whose only facts are removals carries before-side evidence under its old name, and a disclaimer above its own findings is the bug this function exists to avoid.)

- [ ] **Step 4: Full gate and commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add -A
git commit -m "feat: extend the sites no compiler protects for dependency findings"
```

---

### Task 5: Docs — the twelfth site

**Files:**
- Modify: `README.md` (~line 33: "Five analyzers run over the change:"), `CHANGELOG.md`, `docs/superpowers/specs/2026-09-01-urtext-dependency-facts-design.md` (status)

The spec's postmortem records grep finding seven of ten obligations; planning found a twelfth neither revision names: **the README enumerates the five analyzers by name.** A sixth analyzer makes that sentence false in the project's front door.

- [ ] **Step 1: README** — "Five" becomes "Six"; add the bullet in the analyzer list: `- **dependencies** — package.json entries added, removed, or version-changed, in any of the four dependency maps`. Check for any other count of analyzers: `grep -n "[Ff]ive" README.md SECURITY.md action.yml`.

- [ ] **Step 2: CHANGELOG** — add an Unreleased/0.4.0 section describing the feature in the 0.3.0 entry's voice: what it reports, that it is verified-tier and works under `--no-llm`, the manifest-versus-lockfile caveat, and the untracked-workspace limit.

- [ ] **Step 3: Spec status** — `proposed (revised after review)` → `implemented (2026-09-01)`, and append the README site to the postmortem's missed-sites item so the count is honest.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-09-01-urtext-dependency-facts-design.md
git commit -m "docs: document the dependency analyzer"
```

---

### Task 6: Calibration against real ranges

The spec: "Calibrating against real ranges is part of the implementation, not a follow-up." Free — every run is `--no-llm`.

- [ ] **Step 1:** Build (`npm run build`), then run `node dist/bin.js review --no-llm --json <range>` over at least: `HEAD~14...HEAD~6` on this repository at master (the range whose package.json change motivated the feature — adjust the range to wherever that commit now sits: `git log --oneline --follow package.json`), a range in `C:/users/noaho/omnisscientia` with a manifest change, and this branch's own diff if it touches package.json.

- [ ] **Step 2:** For each, record in the PR description: where dependency findings ranked, whether a runtime change outranked dev changes in the same review, and whether any finding's anchor line was wrong (open the manifest and look).

- [ ] **Step 3:** If dev churn crowds the top or runtime findings sink, adjust `WEIGHTS.dependencyMap` / the three bases, rerun, and record the before/after. If no adjustment is needed, say so with the numbers.

- [ ] **Step 4: Commit** any weight changes with the evidence in the message.

---

### Task 7: PR

- [ ] **Step 1:** `npx tsc --noEmit && npx vitest run` one final time.
- [ ] **Step 2:** Push the branch; open a PR titled `feat: package.json dependency facts` whose body carries: the spec path, the two Fable review summaries (spec) plus the plan's (see below), the calibration numbers from Task 6, and the untracked-workspace limit stated plainly. Do not merge without the repo's required checks.

---

## Self-Review

**Spec coverage.** Every spec section maps: the analyzer/factory/statuses → Tasks 2-3; kinds/ids/evidence → Tasks 1-2; scoring + floor + guard test → Task 1; routing/banding → Task 1; findings copy + KIND_NOTES → Tasks 1, 4; html.ts:313 + doc comments + unanalyzedFiles → Task 4; malformed manifest → Tasks 2-3; `--no-llm` behaviour → verified free in Task 6's runs; calibration → Task 6. Banding needs no code: the kinds are simply not added to `CONTEXT_KINDS`, and Task 1's rank test plus the floor guard cover the consequences.

**Placeholder scan.** Task 2 Step 3 deliberately shows two function bodies as commented contracts rather than full code (`mapOf`, `entryLine`) with their tests fully specified in Step 1 — the tests are the binding spec; everything else is complete code.

**Type consistency.** `dependencyFactsFor(path, beforeText, afterText)` and `makeDependencyAnalyzer({ onNote })` are named identically in Tasks 2, 3; `WEIGHTS.dependencyMap` in Tasks 1, 6; detail `{ map, name, from?, to? }` in Tasks 1-2; the id format is stated once in Global Constraints and repeated verbatim in every test that asserts it.

**Known gaps the executor must close rather than trust:** the exact test-file home for `toFinding` tests (grep first); `FileStatus`/`previousPath` field names for Task 4's fixture; every line number after any task lands.
