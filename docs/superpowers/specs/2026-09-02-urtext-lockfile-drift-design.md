# package-lock.json drift facts — design

**Date:** 2026-09-02
**Status:** proposed

## Why this exists

Since 0.3.0 every review names the changed files no analyzer reported on
(`unanalyzedFiles`, `src/report/coverage.ts:154`). Re-measured on this repository at
0.4.0 — `review HEAD~40...HEAD --no-llm --json` — that list held 13 files: 6 `.yml`,
4 `.md`, 2 `.mjs`, and `package-lock.json`. Re-run it rather than trusting that number;
it is a live measurement and that is the point of it.

There is a second reason, and it is sharper. 0.4.0 already prints one sentence to every
reader of a dependency finding (`DEPENDENCY_NOTE`, `src/report/model.ts:546-547`):

> Dependency findings report the manifest's declared constraints; within a range, the
> lockfile decides what actually resolves.

urtext tells the reader that the lockfile is what matters, and then says nothing about
it. This design closes that specific gap.

## What drift is not

The obvious definition — `package-lock.json` moving without `package.json`, or the
reverse — was measured against this repository's history and **rejected**. Of the 16
commits touching either file, **7 move only one of them**, and all 7 are benign: 3 are
release version bumps, 4 are Dependabot bumps within an unchanged range. As specified it
is a false-positive generator, and shipping it would put a screen of verified findings on
top of correct commits.

Traced on `087674a` (`chore(deps): bump @types/node from 26.3.0 to 26.4.0`, which touches
only the lockfile):

| | before | after |
|---|---|---|
| `package.json` range | `^26.3.0` | `^26.3.0` |
| lockfile `packages[""]` range | `^26.3.0` | `^26.3.0` |
| lockfile resolved version | `26.3.0` | **`26.4.0`** |

The manifest analyzer is structurally blind here, and the resolved version is the whole
change. That is the fact worth reporting — not the file-membership coincidence.

## The positioning question, answered honestly

`package.json` entered scope on a structural argument: `createProgramAt` feeds it to the
compiler, because the manifest is what tells module resolution whether a directory is ESM
or CommonJS. The filter is at `src/analyze/program.ts:205`:

```ts
(p) => TS_SOURCE.test(p) || p === "package.json" || p.endsWith("/package.json"),
```

**`package-lock.json` matches neither clause.** It is not inside the compiler boundary,
and the argument that carried the manifest does not carry the lockfile. The honest
statement is weaker and is by adjacency: a lockfile is a manifest of the same package, in
the same format, produced by the same tool, and the analyzer that owns manifests is its
natural owner. Two of the four kinds below read only `packages[""]`, which is a mirror of
a file already in scope. The fourth kind — tree churn — is the one that genuinely reaches
past it, and it is deliberately the least specific of the four.

This does not make the README's "It analyses TypeScript projects" false: a lockfile
belongs to a TypeScript project the same way its manifest does, and nothing here reads
YAML, a CI configuration, or a workflow. The line this design does not cross is the one
that would require a YAML parser.

## What is built

### The analyzer

A new `src/analyze/lockfile.ts`, registered in `ANALYZERS` (`src/analyze/index.ts`),
**not** an extension of `dependencies.ts`. Two reasons, both structural rather than
stylistic:

1. It must fire when `package-lock.json` moves and `package.json` does not — the
   Dependabot case, which is most of the real history. `dependencyAnalyzer` iterates
   manifests and would never reach it.
2. It reads **two files at one revision** in order to compare them, where every existing
   analyzer reads **one file at two revisions**. That is a different access shape, and
   folding it into the manifest loop would tangle both.

Shaped like its sibling: a pure `lockfileFactsFor(path, beforeManifest, afterManifest,
beforeLock, afterLock)` taking text and returning facts, plus a
`makeLockfileAnalyzer({ onNote })` factory owning git, rename resolution, and parse
failures. The factory exists for the reason `makeCitationsAnalyzer` and
`makeDependencyAnalyzer` do: `Analyzer` returns facts and has no channel for anything
else, and `runAnalyzers` keeps facts per analyzer, so a throw discards every other file's
facts and brands the review partial (`src/analyze/index.ts`).

It reads npm lockfiles only — `package-lock.json` and `npm-shrinkwrap.json` — and only
the pair at the repository root. `pnpm-lock.yaml` and `yarn.lock` are not JSON, and
parsing them means taking a YAML dependency, which is the boundary the previous section
names. npm workspaces place every package under one root lockfile with
`packages["packages/foo"]` entries, so pairing a nested manifest with it is a separate
problem; it is declared a limit, not solved.

The relevant shape is `lockfileVersion: 3`, whose `packages[""]` entry carries a copy of
the root manifest's four dependency maps, and whose `packages["node_modules/<name>"]`
entries carry resolved `version` fields.

### The four kinds

**`lockfile_out_of_sync`** — a range in `package.json` disagrees with the lockfile's
`packages[""]` copy of it, in any of the four maps. Detail: `{ map, name, manifest, lock }`.

A defect with a verified consequence rather than an inferred one. Traced by experiment,
not composed: editing a manifest range with the lockfile untouched makes `npm ci` exit 1
with

> `npm error code EUSAGE`
> `npm ci` can only install packages when your package.json and package-lock.json or
> npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before
> continuing.

so the branch cannot clean-install and every CI run on it fails.

**`dependency_resolved_changed`** — a package named in `package.json` has a different
resolved version in the lockfile than it had before. Detail:
`{ name, from, to, range, rangeChanged }`. `rangeChanged` is false in the Dependabot case
above, which is the case the manifest analyzer cannot see.

**`lockfile_version_stale`** — the lockfile's root `version` (and `packages[""].version`)
disagrees with the manifest's. Detail: `{ manifest, lock }`.

Verified to be cosmetic, and the spec says so rather than implying severity by
association: with only the root version bumped and dependencies identical, `npm ci`
**succeeds, exit 0**. It reports that the lockfile was not regenerated, nothing more.

**`lockfile_tree_changed`** — one summary fact per lockfile. Detail:
`{ entered, left, moved }`, counting `packages` entries added, removed, and
version-changed, excluding `""` and excluding the direct dependencies already enumerated
above.

Never enumerated, and the reason is measured. Direct-dependency changes in this
repository's entire history **never exceed one per commit**. Transitive churn reaches
115. On `3ac5880` (`chore(deps): vitest 2 to 4`) the lockfile moved 116 entries — 39
entered, 61 left, 16 changed version. Enumerating that is 116 findings from one commit;
counting it is one sentence carrying the number a reviewer actually wants.

### Evidence

`makeFact` derives `Fact.file` and `Fact.line` from `evidence[0]` and throws on empty
evidence (`src/analyze/fact.ts`), so every kind must produce a real reference.

- `lockfile_out_of_sync` and `lockfile_version_stale` evidence the **lockfile**, at the
  line of the disagreeing key inside `packages[""]`. Pointing at the manifest would invert
  the claim: the manifest is what the author edited, the lockfile is what is stale.
- `dependency_resolved_changed` evidences the `"version":` line of the package's own
  `node_modules/<name>` entry.
- `lockfile_tree_changed` evidences the lockfile's `"packages":` line.

Line lookup reuses the approach `dependencies.ts` established and the reason it exists —
`JSON.parse` yields no positions, so the line is found textually, by exact `"<key>":`
match with brace-tracked block bounds. `entryLine` in `dependencies.ts` is not reused
directly: it scans for a key inside a top-level map at `depth === 1`, and the entries here
live one level deeper, under `packages`. A lockfile serialized on one line falls back to
line 1, as the manifest scanner does. There is no before-side evidence case: a removed
transitive package is only ever counted, never evidenced individually.

### Scoring

New entries in `WEIGHTS.factKind` (`src/score/index.ts:23`), placed against the existing
scale — `guard_removed: 90`, `signature_changed: 75`, `export_removed: 70`,
`effect_added: 60`, `dependency_added: 55`, `dependency_removed: 45`,
`dependency_changed: 30`, `export_added: 25`, `citation_rot: 18`, `blast_radius: 15`:

| kind | weight | reasoning |
|---|---|---|
| `lockfile_out_of_sync` | 65 | Certain rather than probable, so above every `dependency_*` kind. Below `export_removed` (70) deliberately: CI already fails loudly on it, and urtext's frame is the sites no compiler protects. Catching it before merge is the value, and that is worth less than a regression nothing else reports. |
| `dependency_resolved_changed` | 35 | Just above `dependency_changed` (30). It reports what actually installs rather than a constraint the author chose, but it is the consequence of a range the author already approved. |
| `lockfile_version_stale` | 15 | Beside `citation_rot` (18) and below it: both are defects in the repository's account of itself, and this one has a verified null effect on installs. |
| `lockfile_tree_changed` | 15, log-scaled | Base as `blast_radius`, and scaled by the same curve. |

`scoreFact` (`src/score/index.ts:89`) gains two branches. `lockfile_tree_changed` joins
the log-scaled path (`:96`), keyed on `detail.entered` rather than `detail.references`,
and clamped to the same `WEIGHTS.factKind.effect_added` ceiling for the same stated
reason: tree churn reports cost, not a defect, so no package count may push it above a
kind that reports a problem. `dependency_resolved_changed` joins the
`WEIGHTS.dependencyMap` branch (`:115-118`), so a devDependency's movement is halved
exactly as a devDependency's range change is — Dependabot churn is overwhelmingly dev, and
unscaled it would bury the runtime bump that matters.

The table's own comment says these weights are "proposed, not yet calibrated against real
diffs". These are too, and are written down so a real range can argue with them.

### What the findings say

Four new cases in `toFinding`'s switch (`src/score/index.ts:402-406`). This is the site
two earlier drafts of the dependency-facts spec missed, so it is named explicitly here.

- `lockfile_out_of_sync` — title `` package-lock.json disagrees with package.json about ${name} ``.
  Body: "package.json declares `${manifest}` in `${map}`; the lockfile records `${lock}`.
  `npm ci` refuses to install from a manifest and lockfile that disagree, so this fails
  every clean install until `npm install` is run and the result committed."
- `dependency_resolved_changed` — title `` ${name} now resolves to ${to} ``. Body, when
  the range did not move: "The declared range `${range}` did not change; the version the
  lockfile pins moved from `${from}` to `${to}`. This is what installs." When it did move:
  the same sentence without the first clause.
- `lockfile_version_stale` — title `` package-lock.json still says ${lock} ``. Body:
  "package.json declares version `${manifest}`. This does not affect what installs —
  `npm ci` succeeds — but the lockfile was not regenerated when the version was bumped."
- `lockfile_tree_changed` — title `` the dependency tree moved: ${entered} in, ${left} out ``.
  Body: "`${entered}` packages entered the tree, `${left}` left, and `${moved}` changed
  version. These are transitive: nothing in package.json names them, and they are counted
  rather than listed."

`KIND_NOTES` (`src/report/model.ts:549`) gains one shared sentence for all four —
"Lockfile findings report what a clean install would actually resolve, which is not always
what package.json declares." `kindNotesFor` already dedupes by note **text** rather than by
kind (`src/report/model.ts:650-665`), added for `DEPENDENCY_NOTE`, so one sentence shared
across four kinds prints once with no further change.

### Routing and banding

The four kinds map to the **existing** `"dependency"` subject in `SUBJECT_OF_KIND`
(`src/report/model.ts:489-501`), not to a new one. A lockfile finding is a dependency
finding; a sixth subject would buy nothing and would cost a fifth clause in the copy
below. `LENS_OF_SUBJECT` (`:693`) therefore needs no change, and neither does `Lens`
(`:85`), which stays three panes.

**Two prose sites become false and nothing fails.** Both say a dependency finding is a
change to what `package.json` declares, which stops being the whole truth:

- `src/report/html.ts:313` — the effects pane's note, ending "All four appear in the
  narrative", whose fourth clause reads "A dependency finding — a change to what
  package.json declares". Tests pin this sentence as written (`test/report/html.test.ts`),
  so they will fail on the copy change but would **not** have failed on its becoming
  untrue.
- `src/report/model.ts:689-691` — the `LENS_OF_SUBJECT` doc comment, carrying the same
  claim in the same words.

The comment above the HTML copy records this exact failure shipping once already and names
the citation clause as prevention of a second. This is the third occasion. Both sites
change in the commit that adds the kinds.

**Fact ids** follow the established convention, kind as prefix and the distinguishing facet
as a segment, because `reconcile` indexes facts by id (`src/score/reconcile.ts`) and a
collision silently drops one:

- `lockfile_out_of_sync:<path>:<map>:<name>` — the map segment for the same reason the
  manifest kinds carry it: one package legitimately appears in two maps.
- `dependency_resolved_changed:<path>:<name>` — no map segment; a package resolves once in
  the tree regardless of which map declared it.
- `lockfile_version_stale:<path>` and `lockfile_tree_changed:<path>` — one per lockfile.

### A lockfile that does not parse

Same handling as an unparseable manifest, for the same reason: `onNote` produces one
warnings line naming the file and the side, and the analyzer continues. A lockfile is large
and machine-written, so the realistic failure is a conflict marker left in after a bad
merge — precisely when a review is most wanted. The note reads `<path> did not parse on the
<side> side, so its lockfile changes were not analyzed.`

A missing lockfile on either side is not an error and not a finding: added and deleted
lockfiles read as absent, and every kind requires both sides to compare.

## What the compiler catches, and what it does not

Verified by adding a throwaway kind to `FactKind` and running `tsc --noEmit`, rather than
reasoned about. **Five sites in `src/` fail to compile**, which is the safety net:

| site | error |
|---|---|
| `src/report/model.ts:501` | `SUBJECT_OF_KIND` — `satisfies Record<FactKind, Subject>` |
| `src/score/index.ts:59` | `WEIGHTS.factKind` — `satisfies Record<FactKind, number>` |
| `src/score/index.ts:90` | `scoreFact` indexing `WEIGHTS.factKind[fact.kind]` |
| `src/score/index.ts:595-596` | **`title` / `body` "used before being assigned"** |
| `src/score/index.ts:675` | a second `WEIGHTS.factKind` index |

The fourth is the important one: `toFinding` declares `let title: string` with no
initializer and the switch has no `default:`, so definite-assignment analysis makes an
unhandled kind a compile error. The prose site earlier drafts forgot is protected by
construction — but only for as long as nobody adds a `default:` case or an initializer.

**Four sites are silent** and must be handled by hand:

- `KIND_NOTES` is `Record<string, string>` (`src/report/model.ts:549`), deliberately not
  keyed on `FactKind`. A kind with no note simply prints none.
- `src/report/html.ts:313` and `src/report/model.ts:689-691`, above.
- `test/analyze/index.test.ts:59-61` asserts `ANALYZERS` has **six** entries and fails at
  test time, not compile time. It becomes seven, with a sibling asserting
  `lockfileAnalyzer` by name, matching the existing per-analyzer assertions.

## Behaviour under `--no-llm`

Every kind here is deterministic, so all four are `verified` and the analyzer is unaffected
by the flag. The stage that changes is coverage: any non-model finding whose evidence names
`package-lock.json` removes it from `unanalyzedFiles` (`src/report/coverage.ts:154-172`),
which is how this work is measured. That disclosure counts **findings**, not facts — a fact
filtered out before it becomes a finding leaves the file in the list, so the measurement
must be re-run rather than assumed.

## Testing

Pure-function tests over `lockfileFactsFor` with inline fixtures, which is what keeping the
parsing pure buys:

- A range disagreement in each of the four maps yields `lockfile_out_of_sync`; agreement
  yields none.
- The Dependabot shape — manifest untouched, `packages[""]` untouched, one resolved version
  moved — yields exactly one `dependency_resolved_changed` with `rangeChanged: false`, and
  **no** `lockfile_out_of_sync`. This is the false positive the rejected definition would
  have produced, and is the single most important test here.
- A release-shape change — manifest version bumped, dependencies identical — yields
  `lockfile_version_stale` and nothing else.
- A transitive-only change yields `lockfile_tree_changed` with exact counts and no
  per-package findings.
- A lockfile serialized on one line still produces facts, at line 1.
- Malformed JSON on either side produces one note and no throw.
- Id format: prefix and map segment asserted on real paths, since the existing convention
  test runs on a fixture that changes no lockfile.

Two integration checks against this repository, which are also the acceptance criteria:

1. Reviewing `087674a` produces one `dependency_resolved_changed` for `@types/node`
   (`26.3.0 → 26.4.0`, range unchanged) and no sync finding.
2. Reviewing a range containing `5206587` produces `lockfile_version_stale`. This is live:
   `package-lock.json` records `0.1.2` while `package.json` declares `0.4.0`. It tracked
   correctly through 0.1.0, 0.1.1 and 0.1.2 and then froze, so the release process changed
   at 0.2.0 and has shipped a stale lockfile since. urtext finding this in its own
   repository is the demonstration.

## Risks

| risk | handling |
|---|---|
| The rejected definition creeps back in as "simpler" | Named here with the measurement that killed it: 7 of 16 commits, all benign |
| Tree churn floods a review | Counted, never enumerated; measured worst case is 116 entries → 1 finding |
| Positioning argument overstated | Stated as adjacency, not structure, with the `program.ts:205` filter quoted showing the lockfile is outside it |
| The two prose sites go stale silently | Enumerated above; neither is compile-protected; third known occurrence of this trap |
| Weights wrong | Same status as every other weight in the table: proposed, and written down to be argued with |
| Scope drifts toward CI security | Nothing here reads YAML; that boundary is the stated limit, and pieces 2 and 3 of the wider "yml work" remain unbuilt and undecided |

## Review history

Per the rule adopted in `2026-08-30-urtext-intent-gap-index-design.md`: every `file:line`
claim in this document was checked against the file at `57f2faa`, and checking that a
citation points at the right line is not the same as checking that the claim about its
behaviour is true. The behavioural claims here — `npm ci` failing on a dependency mismatch
and succeeding on a version mismatch, and the five compile errors a new `FactKind` produces
— were each produced by running the thing, not by composing a plausible example. The commit
counts, the 116-entry churn, and the `@types/node` table were derived by walking this
repository's history.
