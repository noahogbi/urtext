# package-lock.json Drift Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seventh analyzer producing deterministic, `verified`-tier facts from `package-lock.json` — manifest/lock inconsistency, resolved-version movement, a stale root version, and a counted summary of transitive churn — on every run, including `--no-llm`.

**Architecture:** A pure diffing core (`lockfileFactsFor`) testable without git, wrapped by a factory analyzer (`makeLockfileAnalyzer({ onNote })`) that owns statuses, renames, pairing the manifest with the lockfile, and unparseable JSON. Four new `FactKind`s ripple through the enumerated mappings first, so every commit stays green.

**Tech Stack:** TypeScript (strict, ESM), vitest. No new dependencies — the parser is `JSON.parse`.

**Spec:** `docs/superpowers/specs/2026-09-02-urtext-lockfile-drift-design.md` (revision 1, after a Fable review). Read it first. Its revision header names four errors already made and corrected while designing this; the plan exists to not remake them.

## Global Constraints

- Work continues on one branch; one PR at the end. Direct pushes to `master` bypass a declared protection rule — never push `master`.
- Every commit leaves `npx tsc --noEmit` **and** `npx vitest run` green. vitest does not typecheck; CI runs both.
- The analyzer never calls `ctx.programAt` — `src/types.ts` says analyzers that do not need the checker must not.
- The before side of every read is `file.previousPath ?? file.path`; `status === "added"` skips the before read, `"deleted"` skips the after read.
- The factory names its analyzer with `Object.defineProperty(fn, "name", { value: "lockfileAnalyzer" })`. An inner `const` is **not** sufficient: esbuild renames shadowed bindings. See the note in `src/analyze/dependencies.ts` above its `Object.defineProperty` call.
- New reader-facing copy contains none of: `unsanctioned`, `unauthorized`, `approved`, `permission`, `forbidden`, `allowed` (`test/report/copy-guard.test.ts:29-36`), and never issues a verdict.
- **Comments must not contain a bare numeral that matches a `WEIGHTS` value** (`test/comment-contract.test.ts:38-42`). This plan adds `65` and `35` to that forbidden set, and `15` is already in it. Write no digits in comments near the scoring code. This has bitten this repository repeatedly.
- Fact ids: `lockfile_out_of_sync:<path>:<map>:<name>`, `dependency_resolved_changed:<path>:<name>`, `lockfile_version_stale:<path>`, `lockfile_tree_changed:<path>`. `reconcile` indexes facts by id, so a collision silently drops one.
- `detail.map` is required on `dependency_resolved_changed` even though the id omits it — `scoreFact`'s halving branch reads `fact.detail.map` and nothing else.

> **Line numbers** below were verified on 2026-09-02 at commit `1d30c8b` and drift as tasks land. Anchor on symbol names, not on line numbers.

### The ten sites a new `FactKind` touches

Five fail to compile (verified by adding a throwaway kind and running `tsc --noEmit`):

| site | what fires |
|---|---|
| `src/report/model.ts` `SUBJECT_OF_KIND` | `satisfies Record<FactKind, Subject>` |
| `src/score/index.ts` `WEIGHTS.factKind` | `satisfies Record<FactKind, number>` |
| `src/score/index.ts` `scoreFact` | indexing `WEIGHTS.factKind[fact.kind]` |
| `src/score/index.ts` `toFinding` | `title`/`body` "used before being assigned" |
| `src/score/index.ts` (second index site) | same as above |

Five are **silent** — nothing objects, so they are steps in this plan:

| site | why it is silent |
|---|---|
| `src/report/model.ts` `KIND_NOTES` | `Record<string, string>`, not keyed on `FactKind` |
| `src/score/index.ts` `CONTEXT_KINDS` | a `Set`, not a `Record` — a new kind lands in the **defect** band by default |
| `src/score/index.ts` `minPossibleAnalyzerScore` | `FACT_KINDS` is derived from `WEIGHTS`, so the kind is auto-included but falls to the `{}` branch and computes a floor from a shape the analyzer cannot produce. `MODEL_CEILING` is this value halved (`src/score/reconcile.ts:14`), so a wrong floor silently changes which model-only claims survive |
| `src/report/html.ts:313` + `src/report/model.ts:689-691` | prose asserting a dependency finding is "a change to what package.json declares" |
| `README.md:26-30`, `:38`, `:40-48` | "Six analyzers", the bullet list, and "two of the six" |

---

### Task 1: The kinds exist, score, band, route, and speak

Everything the compiler forces plus every silent report site, in one commit — a new `FactKind` trips `SUBJECT_OF_KIND`'s `satisfies` and `toFinding`'s definite assignment the moment it exists, so this is the smallest green unit.

**Files:**
- Modify: `src/types.ts` (`FactKind` union)
- Modify: `src/score/index.ts` (`WEIGHTS.factKind`; `scoreFact`; `CONTEXT_KINDS`; `minPossibleAnalyzerScore`; `toFinding` switch)
- Modify: `src/report/model.ts` (`SUBJECT_OF_KIND`; `KIND_NOTES`; `LENS_OF_SUBJECT` doc comment)
- Modify: `src/report/html.ts` (the effects-pane note)
- Test: `test/score/index.test.ts`, `test/report/model.test.ts`, `test/report/html.test.ts`

**Interfaces:**
- Produces: `FactKind` members `"lockfile_out_of_sync" | "dependency_resolved_changed" | "lockfile_version_stale" | "lockfile_tree_changed"`, all mapping to the existing `Subject` `"dependency"` and so to the `narrative` lens. `WEIGHTS.factKind` entries `65 / 35 / 15 / 15`. Detail contracts: `{ map: string, name: string, manifest: string | null, lock: string | null }`, `{ map: string, name: string, from: string, to: string, range: string, rangeChanged: boolean }`, `{ manifest: string, lock: string }`, `{ entered: number, left: number, moved: number }`.
- Consumed by Tasks 2-4 exactly as named here.

- [ ] **Step 1: Write the failing scoring, banding and floor tests**

In `test/score/index.test.ts`:

```typescript
describe("lockfile findings", () => {
  const fact = (kind: Fact["kind"], detail: Record<string, unknown>): Fact => ({
    id: `${kind}:package-lock.json`,
    kind,
    file: "package-lock.json",
    line: 1,
    detail,
    evidence: [{ file: "package-lock.json", line: 1, excerpt: "x" }],
  });

  it("ranks an out-of-sync lockfile above every manifest dependency kind", () => {
    const outOfSync = scoreFact(
      fact("lockfile_out_of_sync", { map: "dependencies", name: "a", manifest: "^2.0.0", lock: "^1.0.0" }),
    );
    expect(outOfSync).toBeGreaterThan(
      scoreFact(fact("dependency_added", { map: "dependencies", name: "a", to: "^1.0.0" })),
    );
    expect(outOfSync).toBeLessThan(WEIGHTS.factKind.export_removed);
  });

  it("halves a resolved change in a dev map, which needs detail.map to work at all", () => {
    const dev = fact("dependency_resolved_changed", {
      map: "devDependencies", name: "a", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
    });
    const runtime = fact("dependency_resolved_changed", {
      map: "dependencies", name: "a", from: "1.0.0", to: "1.1.0", range: "^1.0.0", rangeChanged: false,
    });
    expect(scoreFact(dev)).toBe(scoreFact(runtime) / 2);
  });

  it("log-scales tree churn on total movement, not arrivals alone", () => {
    const arrivals = scoreFact(fact("lockfile_tree_changed", { entered: 40, left: 0, moved: 0 }));
    const departures = scoreFact(fact("lockfile_tree_changed", { entered: 0, left: 40, moved: 0 }));
    expect(departures).toBe(arrivals);
    expect(scoreFact(fact("lockfile_tree_changed", { entered: 1, left: 0, moved: 0 }))).toBeLessThan(arrivals);
  });

  it("never lets tree churn outrank a kind that reports a problem", () => {
    const huge = scoreFact(fact("lockfile_tree_changed", { entered: 5000, left: 5000, moved: 5000 }));
    expect(huge).toBeLessThanOrEqual(WEIGHTS.factKind.effect_added);
  });

  it("sorts tree churn into the context band and the other three into the defect band", () => {
    expect(bandOfKind("lockfile_tree_changed")).toBe(bandOfKind("blast_radius"));
    expect(bandOfKind("lockfile_out_of_sync")).toBe(bandOfKind("dependency_changed"));
    expect(bandOfKind("lockfile_version_stale")).toBe(bandOfKind("dependency_changed"));
    expect(bandOfKind("dependency_resolved_changed")).toBe(bandOfKind("dependency_changed"));
  });

  it("leaves the analyzer floor where it was, so MODEL_CEILING does not move", () => {
    expect(minPossibleAnalyzerScore()).toBe(6);
  });
});
```

`bandOfKind` does not exist yet — export it from `src/score/index.ts` in Step 3 as a thin named wrapper over the existing private `bandOf`, so the banding decision is testable rather than only observable through a full `rank`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/score/index.test.ts`
Expected: FAIL. `bandOfKind` is not exported, and the four kinds are not members of `FactKind`, so this will not even typecheck under `npx tsc --noEmit` — which is the point.

- [ ] **Step 3: Add the kinds and everything the compiler then demands**

`src/types.ts`, extending the `FactKind` union:

```typescript
  | "dependency_changed"
  | "lockfile_out_of_sync"
  | "dependency_resolved_changed"
  | "lockfile_version_stale"
  | "lockfile_tree_changed";
```

`src/score/index.ts`, in `WEIGHTS.factKind` after the `dependency_*` entries. Note the comment carries no digits:

```typescript
    // A lockfile reports what a clean install actually resolves. An
    // inconsistent lockfile outranks every manifest kind because it is
    // certain rather than probable — the install refuses — but it sits below
    // the kinds that report a regression nothing else catches, since a
    // failing install announces itself. A resolved change sits just above a
    // range change: it is what installs rather than what was declared. A
    // stale version field sits with citation rot, a defect in the
    // repository's account of itself. Tree churn shares the reach base.
    lockfile_out_of_sync: 65,
    dependency_resolved_changed: 35,
    lockfile_version_stale: 15,
    lockfile_tree_changed: 15,
```

Extract the shared curve so `blast_radius` and `lockfile_tree_changed` cannot drift apart. Above `scoreFact`:

```typescript
/**
 * The log curve two kinds share, with the ceiling both are held to.
 *
 * Both report cost rather than a defect — reach for one, tree movement for
 * the other — so neither may outrank a kind that names a problem, whatever
 * count it carries. The ceiling is `effect_added` for the reason stated on
 * that weight.
 */
function logScaledScore(base: number, count: number): number {
  return Math.min(base * (1 + Math.log10(Math.max(count, 1))), WEIGHTS.factKind.effect_added);
}
```

Rewrite the `blast_radius` branch to call it, and add the tree branch beside it:

```typescript
  if (fact.kind === "blast_radius") {
    const refs = typeof fact.detail.references === "number" ? fact.detail.references : 1;
    return logScaledScore(base, refs);
  }

  if (fact.kind === "lockfile_tree_changed") {
    // Total movement, not arrivals: a package leaving costs the same review
    // attention as one arriving, and keying on arrivals scores a purely
    // subtractive change at bare base.
    const n = (k: string) => (typeof fact.detail[k] === "number" ? (fact.detail[k] as number) : 0);
    return logScaledScore(base, n("entered") + n("left") + n("moved"));
  }
```

Add the resolved kind to the existing dependency-map branch:

```typescript
  if (
    fact.kind === "dependency_added" ||
    fact.kind === "dependency_removed" ||
    fact.kind === "dependency_changed" ||
    fact.kind === "dependency_resolved_changed"
  ) {
```

`CONTEXT_KINDS` — the site that is a `Set` and therefore silent:

```typescript
const CONTEXT_KINDS: ReadonlySet<Fact["kind"]> = new Set<Fact["kind"]>([
  "blast_radius",
  "export_added",
  // Tree churn reports arrival and departure, not a defect: nothing here is
  // something to go and fix. The other three lockfile kinds are — an install
  // that refuses, a version that resolved differently, a lockfile that was
  // not regenerated — so they stay in the defect band.
  "lockfile_tree_changed",
]);

/** `bandOf` by kind, exported so the banding decision is directly testable. */
export function bandOfKind(kind: Fact["kind"]): number {
  return bandOf(kind);
}
```

`minPossibleAnalyzerScore` — add the resolved kind to the dependency-map branch and give tree churn a producible shape:

```typescript
    if (
      kind === "dependency_added" ||
      kind === "dependency_removed" ||
      kind === "dependency_changed" ||
      kind === "dependency_resolved_changed"
    ) {
      return Object.keys(WEIGHTS.dependencyMap).map((map) =>
        scoreFact(syntheticFact(kind, { map })),
      );
    }
    if (kind === "lockfile_tree_changed") {
      // One moved entry is the floor: the analyzer emits no tree fact when
      // nothing moved, so a zeroed synthetic is a shape it cannot produce.
      return [scoreFact(syntheticFact(kind, { entered: 1, left: 0, moved: 0 }))];
    }
```

`src/report/model.ts`, in `SUBJECT_OF_KIND` — the existing subject, not a new one:

```typescript
  dependency_changed: "dependency",
  lockfile_out_of_sync: "dependency",
  dependency_resolved_changed: "dependency",
  lockfile_version_stale: "dependency",
  lockfile_tree_changed: "dependency",
```

- [ ] **Step 4: Write the four finding prose cases**

In `toFinding`'s switch in `src/score/index.ts`, after the `dependency_changed` case:

```typescript
    case "lockfile_out_of_sync": {
      const map = str(fact.detail.map, "dependencies");
      const name = str(fact.detail.name, "a package");
      const manifest = fact.detail.manifest;
      const lock = fact.detail.lock;
      title = `package-lock.json disagrees with package.json about ${name}`;
      const declared =
        typeof manifest === "string"
          ? `package.json declares \`${manifest}\` in \`${map}\``
          : `package.json no longer declares \`${name}\` in \`${map}\``;
      const recorded =
        typeof lock === "string"
          ? `the lockfile records \`${lock}\``
          : `the lockfile has no entry for it`;
      body = `${declared}; ${recorded}. \`npm ci\` refuses to install from a manifest and lockfile that disagree, so this fails every clean install until \`npm install\` is run and the result committed.`;
      break;
    }
    case "dependency_resolved_changed": {
      const name = str(fact.detail.name, "a package");
      const from = str(fact.detail.from, "unknown");
      const to = str(fact.detail.to, "unknown");
      const range = str(fact.detail.range, "");
      title = `${name} now resolves to ${to}`;
      const unchanged =
        fact.detail.rangeChanged === false && range !== ""
          ? `The declared range \`${range}\` did not change; the `
          : `The `;
      body = `${unchanged}version the lockfile pins moved from \`${from}\` to \`${to}\`. This is what installs.`;
      break;
    }
    case "lockfile_version_stale": {
      const manifest = str(fact.detail.manifest, "unknown");
      const lock = str(fact.detail.lock, "unknown");
      title = `package-lock.json still says ${lock}`;
      body = `package.json declares version \`${manifest}\`. This does not affect what installs — \`npm ci\` succeeds — but the lockfile was not regenerated when the version was bumped.`;
      break;
    }
    case "lockfile_tree_changed": {
      const entered = num(fact.detail.entered, 0);
      const left = num(fact.detail.left, 0);
      const moved = num(fact.detail.moved, 0);
      title = `the dependency tree moved: ${entered} in, ${left} out`;
      body = `${entered} packages entered the tree, ${left} left, and ${moved} changed version. These are transitive: nothing in package.json names them, and they are counted rather than listed.`;
      break;
    }
```

Then `KIND_NOTES` in `src/report/model.ts`, beside `DEPENDENCY_NOTE`:

```typescript
const LOCKFILE_NOTE =
  "Lockfile findings report what a clean install would actually resolve, which is not always what package.json declares.";
```

```typescript
  dependency_changed: DEPENDENCY_NOTE,
  lockfile_out_of_sync: LOCKFILE_NOTE,
  dependency_resolved_changed: LOCKFILE_NOTE,
  lockfile_version_stale: LOCKFILE_NOTE,
  lockfile_tree_changed: LOCKFILE_NOTE,
```

`kindNotesFor` already dedupes by note **text**, so one sentence across four kinds prints once. No change is needed there — assert it instead, in `test/report/model.test.ts`:

```typescript
it("prints the shared lockfile note once across several lockfile kinds", () => {
  const notes = kindNotesFor([
    { id: "lockfile_out_of_sync:package-lock.json:dependencies:a" } as Finding,
    { id: "lockfile_tree_changed:package-lock.json" } as Finding,
  ]);
  expect(notes.filter((n) => n.startsWith("Lockfile findings"))).toHaveLength(1);
});
```

- [ ] **Step 5: Correct the two prose sites that silently became false**

`src/report/html.ts:313` — the clause interior only. The clause count stays four, so "All four appear in the narrative." is unchanged:

```
A dependency finding — a change to what package.json declares, or to what package-lock.json resolves — belongs to none of them either.
```

The `LENS_OF_SUBJECT` doc comment in `src/report/model.ts:689-691` carries the identical claim in the same words. Change it the same way, in this commit.

Then pin the new wording, since the existing tests pin only fragments:

```typescript
it("says the narrative holds lockfile findings too", () => {
  expect(lens(html, "effects")).toContain("or to what package-lock.json resolves");
});
```

- [ ] **Step 6: Run everything and confirm green**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. If `test/comment-contract.test.ts` fails, a comment you wrote contains a bare `65`, `35` or `15` — remove the digit rather than the comment.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/score/index.ts src/report/model.ts src/report/html.ts test/
git commit -m "feat: lockfile fact kinds, scoring, banding, routing, and copy"
```

---

### Task 2: The pure diffing core

**Files:**
- Create: `src/analyze/lockfile.ts`
- Test: `test/analyze/lockfile.test.ts`

**Interfaces:**
- Consumes: the four `FactKind`s and detail contracts from Task 1; `makeFact` from `src/analyze/fact.js`.
- Produces: `export function lockfileFactsFor(path: string, beforeManifest: string | null, afterManifest: string | null, beforeLock: string | null, afterLock: string | null): Fact[]` and `export class LockfileParseError extends Error` with `side: "before" | "after"` and `which: "manifest" | "lockfile"`.

- [ ] **Step 1: Write the failing core tests**

In `test/analyze/lockfile.test.ts`. `mkLock` and `mkManifest` build the two JSON shapes; keep them local so the fixtures read as data:

```typescript
import { describe, expect, it } from "vitest";
import { lockfileFactsFor, LockfileParseError } from "../../src/analyze/lockfile.js";

const mkManifest = (o: Record<string, unknown>) => JSON.stringify({ name: "p", version: "1.0.0", ...o }, null, 2);
const mkLock = (root: Record<string, unknown>, pkgs: Record<string, unknown> = {}, version = "1.0.0") =>
  JSON.stringify({ name: "p", version, lockfileVersion: 3, packages: { "": { name: "p", version, ...root }, ...pkgs } }, null, 2);

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

  it("anchors an added-but-not-installed dependency even though no key exists to point at", () => {
    // The commonest out-of-sync commit: added to the manifest, npm install
    // never run. There is no key in packages[""] for it.
    const before = mkManifest({ dependencies: {} });
    const after = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLock({ dependencies: {} });
    const facts = lockfileFactsFor("package-lock.json", before, after, lock, lock);
    const sync = facts.filter((f) => f.kind === "lockfile_out_of_sync");
    expect(sync).toHaveLength(1);
    expect(sync[0].detail).toMatchObject({ name: "a", manifest: "^1.0.0", lock: null });
    expect(sync[0].line).toBeGreaterThan(0);
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
    expect(() => lockfileFactsFor("package-lock.json", manifest, manifest, lock, "{ not json")).toThrow(LockfileParseError);
  });

  it("produces nothing when either side is absent", () => {
    const manifest = mkManifest({ dependencies: { a: "^1.0.0" } });
    const lock = mkLock({ dependencies: { a: "^1.0.0" } });
    expect(lockfileFactsFor("package-lock.json", manifest, manifest, null, lock)).toEqual([]);
    expect(lockfileFactsFor("package-lock.json", manifest, manifest, lock, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/analyze/lockfile.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the core**

`src/analyze/lockfile.ts`. Follow `src/analyze/dependencies.ts` for the shape of `parseSide` and `mapOf`; do not import its private `entryLine`, which scans at a depth this file's keys do not sit at.

```typescript
import { makeFact } from "./fact.js";
import type { EvidenceRef, Fact } from "../types.js";

const MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export class LockfileParseError extends Error {
  constructor(
    public readonly side: "before" | "after",
    public readonly which: "manifest" | "lockfile",
    cause: unknown,
  ) {
    super(`the ${which} did not parse on the ${side} side`, { cause });
  }
}

function parse(text: string | null, side: "before" | "after", which: "manifest" | "lockfile"): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    throw new LockfileParseError(side, which, e);
  }
}

function mapOf(source: Record<string, unknown> | null | undefined, key: string): Record<string, string> {
  const raw = source?.[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The `packages` map of a lockfile, or an empty object. */
function packagesOf(lock: Record<string, unknown> | null): Record<string, Record<string, unknown>> {
  const raw = lock?.packages;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, Record<string, unknown>>;
}

function versionOf(entry: Record<string, unknown> | undefined): string | undefined {
  return typeof entry?.version === "string" ? entry.version : undefined;
}

/**
 * Line of a `"<key>":` occurring inside the `"packages"` block, preferring the
 * first match at or after the `packages[""]` entry. Textual because
 * `JSON.parse` yields no positions, and tolerant because the anchor degrades
 * rather than failing: a fact with no evidence is a throw, not a silent drop.
 */
function lineOf(text: string, keys: readonly string[]): number {
  const lines = text.split("\n");
  for (const key of keys) {
    const needle = `"${key}":`;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith(needle)) return i + 1;
    }
  }
  return 1;
}

function evidence(path: string, text: string, keys: readonly string[]): EvidenceRef[] {
  const line = lineOf(text, keys);
  return [{ file: path, line, excerpt: (text.split("\n")[line - 1] ?? "").trim() || path }];
}

export function lockfileFactsFor(
  path: string,
  beforeManifestText: string | null,
  afterManifestText: string | null,
  beforeLockText: string | null,
  afterLockText: string | null,
): Fact[] {
  // Every kind compares two sides. An added or deleted lockfile is not a
  // finding, so both sides are required before anything is computed.
  if (beforeLockText === null || afterLockText === null) return [];
  if (afterManifestText === null) return [];

  const afterManifest = parse(afterManifestText, "after", "manifest");
  // Parsed once, and its result kept: it is read below for `rangeChanged`,
  // and parsing it inside the loop would re-throw the same error per entry.
  const beforeManifest = parse(beforeManifestText, "before", "manifest");
  const beforeLock = parse(beforeLockText, "before", "lockfile");
  const afterLock = parse(afterLockText, "after", "lockfile");

  const facts: Fact[] = [];
  const afterPkgs = packagesOf(afterLock);
  const beforePkgs = packagesOf(beforeLock);
  const lockRoot = afterPkgs[""];

  // 1. Manifest ranges against the lockfile's copy of them.
  const direct = new Map<string, string>();
  for (const map of MAPS) {
    const declared = mapOf(afterManifest, map);
    const recorded = mapOf(lockRoot, map);
    for (const name of Object.keys(declared)) direct.set(name, map);
    for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
      const manifest = declared[name] ?? null;
      const lock = recorded[name] ?? null;
      if (manifest === lock) continue;
      facts.push(
        makeFact({
          id: `lockfile_out_of_sync:${path}:${map}:${name}`,
          kind: "lockfile_out_of_sync",
          detail: { map, name, manifest, lock },
          evidence: evidence(afterLockText, afterLockText, [name, map, "packages"]),
        }),
      );
    }
  }

  // 2. Resolved versions of packages the manifest names.
  for (const [name, map] of direct) {
    const key = `node_modules/${name}`;
    const from = versionOf(beforePkgs[key]);
    const to = versionOf(afterPkgs[key]);
    if (from === undefined || to === undefined || from === to) continue;
    const range = mapOf(afterManifest, map)[name] ?? "";
    const rangeChanged = (mapOf(beforeManifest, map)[name] ?? range) !== range;
    facts.push(
      makeFact({
        id: `dependency_resolved_changed:${path}:${name}`,
        kind: "dependency_resolved_changed",
        detail: { map, name, from, to, range, rangeChanged },
        evidence: evidence(afterLockText, afterLockText, [key, "packages"]),
      }),
    );
  }

  // 3. The root version field.
  const manifestVersion = typeof afterManifest?.version === "string" ? afterManifest.version : undefined;
  const lockVersion = typeof afterLock?.version === "string" ? afterLock.version : undefined;
  if (manifestVersion !== undefined && lockVersion !== undefined && manifestVersion !== lockVersion) {
    facts.push(
      makeFact({
        id: `lockfile_version_stale:${path}`,
        kind: "lockfile_version_stale",
        detail: { manifest: manifestVersion, lock: lockVersion },
        evidence: evidence(afterLockText, afterLockText, ["version"]),
      }),
    );
  }

  // 4. Everything else in the tree, counted.
  const enumerated = new Set([...direct.keys()].map((n) => `node_modules/${n}`));
  let entered = 0;
  let left = 0;
  let moved = 0;
  for (const key of new Set([...Object.keys(beforePkgs), ...Object.keys(afterPkgs)])) {
    if (key === "" || enumerated.has(key)) continue;
    const inBefore = key in beforePkgs;
    const inAfter = key in afterPkgs;
    if (!inBefore && inAfter) entered++;
    else if (inBefore && !inAfter) left++;
    else if (versionOf(beforePkgs[key]) !== versionOf(afterPkgs[key])) moved++;
  }
  if (entered + left + moved > 0) {
    facts.push(
      makeFact({
        id: `lockfile_tree_changed:${path}`,
        kind: "lockfile_tree_changed",
        detail: { entered, left, moved },
        evidence: evidence(afterLockText, afterLockText, ["packages"]),
      }),
    );
  }

  return facts;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx tsc --noEmit && npx vitest run test/analyze/lockfile.test.ts`
Expected: PASS, all ten.

- [ ] **Step 5: Commit**

```bash
git add src/analyze/lockfile.ts test/analyze/lockfile.test.ts
git commit -m "feat: pure lockfile diffing core"
```

---

### Task 3: The analyzer, registered and named

**Files:**
- Modify: `src/analyze/lockfile.ts` (append the factory)
- Modify: `src/analyze/index.ts` (export and register)
- Modify: `README.md` (`:26-30`, `:38`, the bullet list)
- Test: `test/analyze/lockfile.test.ts`, `test/analyze/index.test.ts`

**Interfaces:**
- Consumes: `lockfileFactsFor` from Task 2.
- Produces: `export function makeLockfileAnalyzer(options?: { onNote?: (note: string) => void }): Analyzer` and `export const lockfileAnalyzer: Analyzer`; `ANALYZERS` has seven entries.

- [ ] **Step 1: Write the failing registration and factory tests**

In `test/analyze/index.test.ts`, update the count assertion and add a sibling:

```typescript
  it("registers seven analyzers", () => {
    expect(ANALYZERS).toHaveLength(7);
  });

  it("registers the lockfile analyzer under its own name", () => {
    expect(ANALYZERS.map((a) => a.name)).toContain("lockfileAnalyzer");
  });
```

In `test/analyze/lockfile.test.ts`:

```typescript
it("turns an unparseable lockfile into one note rather than a throw", async () => {
  const notes: string[] = [];
  const analyzer = makeLockfileAnalyzer({ onNote: (n) => notes.push(n) });
  const changeset = { range: { from: "a", to: "b", label: "x" }, files: [{ path: "package-lock.json", status: "modified" as const }] };
  const ctx = {
    cwd: ".",
    range: { from: "a", to: "b", label: "x" },
    readAt: async (_rev: string, p: string) => (p.endsWith("lock.json") ? "{ not json" : '{"name":"p","version":"1.0.0"}'),
    programAt: async () => { throw new Error("must not be called"); },
  };
  await expect(analyzer(changeset as never, ctx as never)).resolves.toEqual([]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("package-lock.json");
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/analyze/index.test.ts test/analyze/lockfile.test.ts`
Expected: FAIL — `ANALYZERS` has six, and `makeLockfileAnalyzer` does not exist.

- [ ] **Step 3: Write the factory**

Appended to `src/analyze/lockfile.ts`:

```typescript
/**
 * The analyzer, as a factory for the reason `makeDependencyAnalyzer` is one:
 * `Analyzer` returns facts and has no channel for anything else, and a
 * lockfile that does not parse must become one warnings line rather than a
 * throw. `runAnalyzers` keeps facts per analyzer, not per file, so a throw
 * discards what every other file in the changeset already produced. A
 * lockfile is large and machine-written, so the realistic failure is a
 * conflict marker left in after a bad merge — exactly when a review is most
 * wanted.
 */
export function makeLockfileAnalyzer(
  options: { onNote?: (note: string) => void } = {},
): Analyzer {
  const lockfileAnalyzer: Analyzer = async (changeset, ctx): Promise<Fact[]> => {
    const facts: Fact[] = [];
    for (const file of changeset.files) {
      if (!isLockfile(file.path)) continue;
      const beforePath = file.previousPath ?? file.path;
      const manifestPath = file.path.replace(/[^/]+$/, "package.json");
      const beforeManifestPath = beforePath.replace(/[^/]+$/, "package.json");
      const beforeLock = file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforePath);
      const afterLock = file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, file.path);
      const beforeManifest = file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforeManifestPath);
      const afterManifest = file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, manifestPath);
      try {
        facts.push(...lockfileFactsFor(file.path, beforeManifest, afterManifest, beforeLock, afterLock));
      } catch (e) {
        if (e instanceof LockfileParseError) {
          options.onNote?.(
            `${file.path} did not parse on the ${e.side} side, so its lockfile changes were not analyzed.`,
          );
          continue;
        }
        throw e;
      }
    }
    return facts;
  };
  // Written down rather than inferred: this binding shadows the module-level
  // singleton below, and esbuild renames shadowed bindings, taking the
  // inferred name with it. See makeCitationsAnalyzer, which learned it first.
  Object.defineProperty(lockfileAnalyzer, "name", { value: "lockfileAnalyzer" });
  return lockfileAnalyzer;
}

/** The default instance `ANALYZERS` registers; `review` swaps in a configured one. */
export const lockfileAnalyzer: Analyzer = makeLockfileAnalyzer();
```

Add near the top of the file:

```typescript
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];

function isLockfile(path: string): boolean {
  return LOCKFILES.some((n) => path === n || path.endsWith(`/${n}`));
}
```

Extend the import to `import type { Analyzer, EvidenceRef, Fact } from "../types.js";`.

In `src/analyze/index.ts`, add the import, the re-export beside the others, and `lockfileAnalyzer` to `ANALYZERS`.

Wire the note channel where `review` already configures `makeDependencyAnalyzer`: find it with `grep -n "makeDependencyAnalyzer" src/cli.ts` and give `makeLockfileAnalyzer` the same `onNote: (note) => warnings.push(note)` treatment, in the same array.

- [ ] **Step 4: Update the README, which is now wrong in three places**

Nothing fails on any of these. `README.md:38`:

```
Seven analyzers run over the change:
```

A bullet after the `dependencies` one:

```
- **lockfile** — `package-lock.json` against `package.json` and against its own previous state:
  a lockfile the manifest disagrees with, a resolved version that moved, a stale root version,
  and a count of how the transitive tree changed
```

And `README.md:26-30`, where "two of the six" becomes three of seven:

```
Rust repository and the code analyzers find nothing; the citations analyzer still checks
prose in `.md` and `.txt`, and the dependencies and lockfile analyzers still read
`package.json` and `package-lock.json` — three of the seven. That is a limit, not a
roadmap item.
```

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/lockfile.ts src/analyze/index.ts src/cli.ts README.md test/
git commit -m "feat: the lockfile analyzer, wired and named"
```

---

### Task 4: Acceptance against this repository's own history

The spec's two acceptance criteria, run against real commits rather than fixtures. This is the task that would catch a core that passes its own fixtures and fails on a real lockfile.

**Files:**
- Test: `test/analyze/lockfile.test.ts` (a `describe` block that shells out to git)

- [ ] **Step 1: Write the failing acceptance tests**

```typescript
import { execFileSync } from "node:child_process";

const at = (rev: string, path: string): string | null => {
  try { return execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 1e9 }); }
  catch { return null; }
};

describe("against this repository's history", () => {
  it("reads the Dependabot commit as one resolved change and no drift", () => {
    const facts = lockfileFactsFor(
      "package-lock.json",
      at("087674a~1", "package.json"), at("087674a", "package.json"),
      at("087674a~1", "package-lock.json"), at("087674a", "package-lock.json"),
    );
    expect(facts.filter((f) => f.kind === "lockfile_out_of_sync")).toHaveLength(0);
    const moved = facts.filter((f) => f.kind === "dependency_resolved_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0].detail).toMatchObject({
      name: "@types/node", from: "26.3.0", to: "26.4.0", map: "devDependencies", rangeChanged: false,
    });
    // Halved because it is a dev map. An unhalved score is what a missing
    // detail.map silently produces, so the number is the assertion.
    expect(scoreFact(moved[0])).toBe(WEIGHTS.factKind.dependency_resolved_changed / 2);
  });

  it("finds this repository's own stale lockfile version", () => {
    const facts = lockfileFactsFor(
      "package-lock.json",
      at("5206587~1", "package.json"), at("5206587", "package.json"),
      at("5206587~1", "package-lock.json"), at("5206587", "package-lock.json"),
    );
    const stale = facts.filter((f) => f.kind === "lockfile_version_stale");
    expect(stale).toHaveLength(1);
    expect(stale[0].detail).toMatchObject({ manifest: "0.4.0", lock: "0.1.2" });
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/analyze/lockfile.test.ts`
Expected: PASS. If the resolved-change test finds zero facts, the direct-dependency map is being read from the wrong side; if it finds many, the transitive exclusion is not applied.

- [ ] **Step 3: Run urtext on its own working tree and read the output**

Run: `npx tsx src/bin.ts review HEAD~40...HEAD --no-llm`
Expected: `package-lock.json` no longer appears in the "No analyzer reported on N of M changed files" note. Confirm with:

Run: `npx tsx src/bin.ts review HEAD~40...HEAD --no-llm --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).coverage.unanalyzedFiles))"`
Expected: the list is one shorter and does not contain `package-lock.json`. If it still does, the facts are being filtered out before they become findings — the disclosure counts findings, not facts.

- [ ] **Step 4: Commit**

```bash
git add test/analyze/lockfile.test.ts
git commit -m "test: lockfile facts against real commits in this repository"
```

---

### Task 5: Calibrate, document, and open the PR

**Files:**
- Modify: `src/score/index.ts` (weights, only if the ranges argue for it)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Rank real ranges and read the order**

Run: `npx tsx src/bin.ts review 3ac5880~1...3ac5880 --no-llm` and `npx tsx src/bin.ts review HEAD~40...HEAD --no-llm`

Check three things the weights are supposed to buy: a `lockfile_out_of_sync` sorts above every manifest dependency finding; a tree-churn finding sorts into the context band, below the defect findings, however large its counts; a dev-map resolved change does not outrank a runtime one. If any is false, adjust the weight and say why in the comment — without writing the numeral.

- [ ] **Step 2: Add the CHANGELOG entry**

Match the format of the existing entries; describe what a reader now sees that they did not before, not the implementation.

- [ ] **Step 3: Final green check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, with the analyzer count at seven.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "feat: package-lock.json drift facts" --body "<summary, spec link, what the acceptance runs showed>"
```

Then wait for checks: `gh pr checks --watch`. Do not merge; hand the PR to Noah.

## Self-Review

**Spec coverage.** Four kinds → Tasks 1-2. Evidence rules including the absent-key anchor → Task 2 Step 3 (`lineOf` degrades through key, map, `packages`, line 1) with its own test. Scoring and the `dependencyMap` halving → Task 1, asserted again on real data in Task 4. Banding → Task 1 Steps 1 and 3. Finding prose → Task 1 Step 4. `KIND_NOTES` dedupe → Task 1 Step 4. Routing via the existing `dependency` subject → Task 1 Step 3. Both prose sites → Task 1 Step 5. Parse failure → Tasks 2 and 3. npm-only, root-pair-only → Task 3 `isLockfile`. `--no-llm` coverage effect → Task 4 Step 3. Testing list → Tasks 2 and 4. The one thing the spec does not mention and this plan adds: `minPossibleAnalyzerScore` and `README.md`, both silent sites found while planning.

**Placeholders.** None: every step carries the code or the command.

**Type consistency.** `lockfileFactsFor` has one signature, used identically in Tasks 2, 3 and 4. `makeLockfileAnalyzer`/`lockfileAnalyzer` match `makeDependencyAnalyzer`/`dependencyAnalyzer`. Detail keys — `map`, `name`, `manifest`, `lock`, `from`, `to`, `range`, `rangeChanged`, `entered`, `left`, `moved` — are spelled the same in the kinds table, the core, the prose cases and the tests.
