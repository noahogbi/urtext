# package.json dependency facts — design

**Date:** 2026-09-01
**Status:** proposed (revised after review)

> **Revision 2, after a Fable review returned REVISE with five blocking findings.** Two were
> false claims about cited code — the kind this project's citation rule exists to catch, and
> the third instance of that class in a week. Three were handling sites the enumeration missed,
> two of them silent. All five are fixed; see "What revision 1 got wrong".

## Why this exists, and why it is not scope creep

urtext's code analyzers read TypeScript, and the README states that as a limit rather than a
roadmap item. Since 0.3.0 every review also names the changed files no analyzer reported on,
so the limit is disclosed per run instead of merely documented.

That disclosure is what motivates this. The measurements quoted below were run on 2026-08-31
and their reports live under the gitignored `.urtext/`, so they cannot be reproduced from this
repository — re-run rather than trust them. On a real range of this repository's own history the
note read: *"No analyzer reported on 7 of 9 changed files: .github/workflows/scorecard.yml,
README.md, SECURITY.md, action.yml, docs/…-least-expected-first-design.md, package.json,
scripts/stamp-build.mjs."* The same file keeps appearing. Separately, across six measured
ranges every finding the model marked `beyondIntent` sat on a file no analyzer reported on,
and two of the four landed on `package.json` and a workflow YAML.

**This design covers `package.json` only.** Workflow facts and lockfile drift were considered
and deliberately excluded: CI security is a different domain with its own failure modes, and
widening into it would make the README's limit false. `package.json` does not, and the reason
is structural rather than a judgement call — see the next section.

## The positioning question, answered from the code

A reasonable objection: urtext says it analyses TypeScript, and `package.json` is not
TypeScript.

The answer is that `package.json` is already inside the boundary. `createProgramAt`
(`src/analyze/program.ts:204-206`) selects the files it feeds the compiler with a filter that
admits `TS_SOURCE` files **plus** `package.json` and any `*/package.json`, because the manifest
is what tells the compiler whether a directory is ESM or CommonJS under `node16`/`nodenext`.
urtext already opens this file on every run that builds a program.

So the frame does not move: urtext analyses TypeScript *projects*, and a project's manifest
declares the module graph its analyzers already traverse. What changes is that a file urtext
opens for the compiler's benefit now also produces facts for the reader's.

**This does not extend `program.ts`.** That read exists for module-format resolution and its
results are consumed by the TypeScript compiler host, not by any fact. Dependency facts need
the manifest at two revisions, need no compiler, and belong in their own analyzer. Reusing the
program read would couple a cheap textual diff to the most expensive thing urtext does.

## What is built

One analyzer, three fact kinds, and the enumerated-mapping entries a new `FactKind` obliges.

### The analyzer

`dependencyAnalyzer`, in a new `src/analyze/dependencies.ts`, registered in `ANALYZERS`
(`src/analyze/index.ts:17-23`) beside the five that exist.

It reads each `package.json` in the changeset at `range.from` and at `range.to` through
`ctx.readAt` (`src/types.ts:242`) and diffs four maps: `dependencies`, `devDependencies`,
`peerDependencies`, `optionalDependencies`.

**Both sides are resolved the way every peer analyzer resolves them**, and this is not a
detail: getting it wrong produces wrong `verified` findings.

- The before side reads `file.previousPath ?? file.path`, not `file.path`. `parseUnifiedDiff`
  detects renames (`src/extract/diff.ts:50-54`), and a moved workspace directory renames its
  manifest. Reading the new path at the old revision returns null, and a null before side means
  *every* dependency in that manifest emits as `dependency_added` — a screen of false verified
  findings from one directory move.
- `status === "added"` means no before side: every entry is `dependency_added`, no read
  attempted.
- `status === "deleted"` means no after side: every entry is `dependency_removed`, evidenced on
  the before side.

`effectsAnalyzer` does exactly this at `src/analyze/effects.ts:265-271`; `guardsAnalyzer`
(`src/analyze/guards.ts:162`) and `surfaceAnalyzer` (`src/analyze/surface.ts:348`) resolve
`previousPath` the same way.

It never calls `ctx.programAt`. The context's own comment says constructing a program parses
every TypeScript file in the repository and that analyzers which do not need the checker must
not call it (`src/types.ts:243-247`); this one does not.

A changeset carrying several manifests — a monorepo — is diffed per manifest, with no special
case. The analyzer iterates `changeset.files` and handles each `package.json` it finds, so
support for workspaces is a consequence of the loop rather than a feature.

One limit inherited rather than chosen: a brand-new workspace whose `package.json` is untracked
is invisible, because `git diff` omits untracked files and `changeset.files` never lists them
(`src/extract/diff.ts:103-107`). The unanalyzed-files disclosure does not cover it either,
since that also reads `changeset.files`. Worth knowing before someone reports it as a bug.

### The three kinds

`dependency_added`, `dependency_removed`, `dependency_changed`, added to `FactKind`
(`src/types.ts:100-108`).

Three rather than one, because banding and weighting are keyed on kind: `CONTEXT_KINDS`
(`src/score/index.ts:562-565`) and `WEIGHTS.factKind` (`src/score/index.ts:24`) both take a
kind, so a single `dependency_changed` kind could not rank a new runtime dependency
differently from a version-range edit except by score. The naming follows the pairs already in
use — `effect_added`/`effect_removed`, `export_added`/`export_removed` — so a reader who knows
those knows these.

`detail` carries `{ map, name, from?, to? }`: which of the four maps, the package name, and
the version ranges on each side. `from` is absent for an addition and `to` for a removal.

### Evidence, and the side a removal is evidenced on

Every fact carries evidence, and `Fact.file`/`Fact.line` are derived from `evidence[0]`
(`src/analyze/fact.ts:45-56`), so the evidence decides where the finding points.

An addition or a version change is evidenced by the manifest line for that entry at the
reviewed revision. **A removal has no such line there**, so it is evidenced on the before side
with `side: "before"` — the field `EvidenceRef` carries because a before-side line's numbers
"need not exist in the working tree at all" (`src/types.ts:114-122`), and the same reason
`effectsAnalyzer` reads the before side of a deleted file.

The line is found by scanning the manifest text for the entry's key within its map's block.
This is textual, so a manifest that declares the same package name in two maps yields the line
in the map being diffed rather than the first match anywhere.

### Scoring

New entries in `WEIGHTS.factKind`: `dependency_added` 55, `dependency_removed` 45,
`dependency_changed` 30. These sit between `effect_added` (60) and `export_added` (25) on the
existing scale, which runs from `guard_removed` at 90 down to `blast_radius` and
`effect_removed` at 15.

**These numbers are proposed, not validated.** `WEIGHTS`'s comment (`src/score/index.ts:19-22`)
says its values "will need adjusting once they have been run against real diffs" — so *none* of
them claims to be calibrated, and these least of all. Calibrating against real ranges is part of
the implementation, not a follow-up.

`scoreFact` then scales by `detail.map`, so a change to `dependencies` or `peerDependencies`
outranks the same change to `devDependencies` or `optionalDependencies`. This needs no new
kind and no new mechanism: `scoreFact` already scales `blast_radius` from its detail, and the
comment at `src/score/index.ts:31-40` records why that scaling exists and what happened when
its base was wrong.

The distinction matters because dev churn is constant in an active repository. Without it, one
new runtime dependency sorts identically to three devDependency bumps, and the runtime one is
what ships to every consumer — `SECURITY.md:96` singles out this project's three runtime
dependencies for that reason.

**Detail-scaling obliges two more sites, and one of them guards an invariant.**
`minPossibleAnalyzerScore` (`src/score/index.ts:124-139`) computes the floor `MODEL_CEILING`
derives from (`src/score/reconcile.ts:14`) by enumerating detail variants for each
detail-scaled kind — a branch per effect, a branch for `blast_radius` — and falling through to
`scoreFact(syntheticFact(kind, {}))` for the rest. A dependency fact with no `map` in its
detail is not a fact this analyzer can emit, so the fallthrough would compute a floor from an
impossible input. If the dev multiplier is below 1, the true minimum sits under the computed
one, `MODEL_CEILING` rises above a real analyzer score, and a model claim can outrank a fact —
the single thing that derivation exists to prevent.

So `minPossibleAnalyzerScore` gains a branch enumerating the four maps for the three
dependency kinds. **And so does the guard test**: `test/score/reconcile.test.ts:50-70`
recomputes the minimum independently, specifically "so this test would catch a bug in that
function's coverage" — but its else-branch uses `detail: {}` too, so left alone it inherits the
same blind spot and would confirm a floor neither computation can see below.

### Routing and banding

A new `Subject`, `"dependency"` (`src/report/model.ts:98`), mapped in `SUBJECT_OF_KIND`
(`:488-497`, whose `satisfies Record<FactKind, Subject>` makes a new kind a compile error until
it is handled) and in `LENS_OF_SUBJECT` (`:673-679`) to the `narrative` lens.

`narrative` rather than a sixth lens: `Lens` is `"narrative" | "effects" | "surface"`
(`:85`), the HTML report renders exactly three panes, and a dependency change is neither an
effect the analyzers traced nor an API surface. Adding a lens would change every surface's
layout to carry one kind of finding.

**The HTML effects pane names what the narrative holds, in hardcoded copy.** `src/report/html.ts:313`
ends "All three appear in the narrative", enumerating model-only claims, standalone reach
findings and citation findings. A fourth narrative subject makes that sentence false, and
*nothing fails*: no mapping is total over it, and the tests pinning that copy
(`test/report/html.test.ts:763`, `:793`) assert the sentence as written. The comment above it
(`html.ts:302-310`) records this exact failure shipping twice already — once when standalone
reach was added, once when citations were. This design is the third occasion, and the clause
must be extended in the same commit that adds the subject.

**Fact ids must carry the kind as a prefix.** All routing recovers the kind from the id prefix
before the colon (`src/report/model.ts:499-514`, `:622-628`, `:649-662`), so ids read
`dependency_added:<path>:<name>`. Without the prefix the `SUBJECT_OF_KIND` entry is inert and
the finding falls to the narrative by default — the right lens by accident, which is worse than
by design because nothing would reveal the mistake. The convention is pinned only against
existing analyzers today (`test/report/html.test.ts:947-955`), on a fixture that changes no
manifest, so the real-path test below asserts the prefix.

**`test/analyze/index.test.ts:60` asserts `ANALYZERS` has five entries** and fails on
registration. Loud rather than silent, but it is part of what a sixth analyzer obliges.

**All three kinds stay out of `CONTEXT_KINDS`**, so `bandOf` (`src/score/index.ts:580-582`) puts them in the
defect band.

This is a deliberate departure from the literal reading of that band. The context band holds
`blast_radius` and `export_added` — findings that cannot break an existing caller — and a newly
added dependency cannot either, by that test. But the test is about behaviour, and a dependency
is a different thing from an export: it changes what installs and what executes, and install
scripts run whether or not any source file imports the package.

The concrete cost of the literal reading decides it. A standalone model claim belongs to no
fact, so it takes the defect band by default and sorts above every context row regardless of
score (`src/score/reconcile.ts:216-219`). Putting `dependency_added` in the context band would
therefore rank a new runtime dependency below every uncorroborated model claim in the report —
the same inversion the intent-gap index was designed to avoid.

### A manifest that does not parse

A `package.json` mid-merge-conflict, or malformed for any other reason, produces no facts and
one note saying so.

**Emitting that note decides the analyzer's shape.** `Analyzer` is
`(changeset, ctx) => Promise<Fact[]>` (`src/types.ts:251-254`) — it returns facts and has no
channel for anything else. Citations solves this by not being a plain analyzer: it is a
factory, `makeCitationsAnalyzer({ sweep, exclude, onNote })`, which closes over the callback,
and `review` swaps the configured instance in for the registered one (`src/cli.ts:397-405`).

So this analyzer follows that shape rather than inventing one: `makeDependencyAnalyzer({ onNote })`,
with a plain `dependencyAnalyzer` registered in `ANALYZERS` for the default path and the
configured instance substituted the same way. The note reaches `warnings` and every surface
from there.

The alternative is to throw, and the reason that is wrong is *not* that the message is lost.
`runAnalyzers` forwards it (`src/analyze/index.ts:67`) and `review` renders it verbatim —
"the … analyzer failed, so this review is partial: …" (`src/cli.ts:409-411`). An earlier draft
of this document claimed otherwise and was wrong.

Throwing is wrong for three real reasons. It increments `failureCount` and brands the whole
review partial, which feeds the exit-code rules (`src/cli.ts:476-478`). And failure granularity
is per analyzer, not per file: one unparseable manifest in a monorepo would discard the facts
this analyzer had already derived from every *other* manifest in the same changeset. A note
keeps those facts and still says what could not be read.

The factory must also give its returned analyzer a name. Failure copy reads `.name`
(`src/analyze/index.ts:60-66`), which a directly-returned closure does not have, so it would
report as "analyzer #6". `makeCitationsAnalyzer` solves this by assigning to an inner named
const before returning it (`src/analyze/citations.ts:1094`), so the binding supplies the name;
this factory does the same.

Not silence: a run that reports no dependency changes because it could not read the manifest is
indistinguishable, to a reader, from a run that read it and found none. That is the failure
mode the unanalyzed-files disclosure was built to close, and reintroducing it inside a new
analyzer would be the same mistake in a smaller place.

## Behaviour under `--no-llm`

Unchanged, and this is the point of the design. Every fact here is deterministic and
analyzer-produced, so these findings are `verified` tier and appear on a keyless run. Unlike
the intent-gap index, which requires a key, this lands in the GitHub Action's default path:
with no key configured the action passes `--no-llm` (README), and dependency facts still
report.

## Testing

- Each kind, in each of the four maps: added, removed, version-changed.
- A removal is evidenced on the before side. Assert `side === "before"`, because the anchor is
  what decides where the finding points and an after-side anchor for a removed entry points at
  an unrelated line.
- A manifest that does not parse yields no facts and one note. Assert the note reaches
  `warnings`, not merely that no facts came back — the fact-free half passes trivially.
- Two manifests in one changeset produce facts for both, each anchored in its own file.
- A package declared in two maps anchors on the line in the map being diffed.
- Runtime outranks dev: construct one `dependency_added` in `dependencies` and one in
  `devDependencies` and assert the ranked order, through `rank`, not by reading weights.
- **One test drives the real path**: `runAnalyzers` with the registered analyzer over a real
  temporary repository, not a direct call to the analyzer function. This repository's banding
  bug shipped because a unit test over `rank` stayed green while the path a review takes was
  never exercised, and the intent-gap plan adopted the same rule after a fixture-only test
  proved vacuous under mutation.
- A changeset with no `package.json` produces no facts and never constructs a program.
- **A renamed manifest with unchanged dependencies produces no facts.** The single most
  valuable test here: without `previousPath` resolution it emits every entry as added, and a
  screen of false `verified` findings is the failure this design most has to avoid.
- An added manifest yields only `dependency_added`; a deleted one only `dependency_removed`,
  evidenced before-side.
- Fact ids carry the `dependency_*:` prefix, asserted on the real path rather than a fixture.
- `MODEL_CEILING` still sits below the true minimum once dependency kinds are detail-scaled,
  asserted through the independent recomputation in `test/score/reconcile.test.ts:50-70` with
  its else-branch extended to enumerate the maps.
- The HTML effects-pane note names the dependency subject alongside the other three.

## Risks

| Risk | Handling |
|---|---|
| The weights are wrong and dependency findings crowd or vanish from real reviews | Stated above as uncalibrated; calibration against real ranges is part of implementation |
| Defect-band placement makes routine dev bumps prominent | The `detail.map` scaling ranks dev changes below runtime ones within the band. The obvious fallback — moving `dependency_changed` to the context band — carries the cost this document argues against elsewhere: it would sort below every standalone model claim (`src/score/reconcile.ts:216-230`). Prefer retuning the multiplier |
| The line-scanning anchor picks the wrong line in an unusual manifest | Tested against a manifest declaring one name in two maps; a wrong anchor is a wrong `file:line`, which is the one thing a `verified` finding must never carry |
| Scope creep toward workflows and lockfiles | Excluded here in writing, with the reason; a later design may revisit it, and would have to argue the README's limit |

## What revision 1 got wrong

Recorded rather than quietly fixed. Two of these are the error class this project's citation
rule names, and the rule did not prevent them.

1. **"`WEIGHTS`'s own comment says the values there have been run against real diffs."** It says
   the opposite: they "will need adjusting once they have been run" (`src/score/index.ts:19-22`).
   The citation pointed at the right lines and the claim inverted them. This is the third
   instance of that class in a week — the others read a comment about `subjectOf` as a claim
   about `kindOf`, and a stale "three surfaces" comment as a count of renderers.

2. **"`runAnalyzers` turns a throw into 'the analyzer failed', losing the reason."** False; the
   message is forwarded (`src/analyze/index.ts:67`) and rendered verbatim (`src/cli.ts:409-411`).
   The conclusion — use the factory shape — was right, and was resting on a false premise. The
   real reasons are per-analyzer failure granularity and the partial-review brand.

3. **The enumeration of what a new `FactKind` obliges was built by grep, and grep found seven of
   ten.** It missed the hardcoded HTML narrative note, `minPossibleAnalyzerScore`'s detail
   enumeration, and the `ANALYZERS` length assertion. The first two are silent: no mapping is
   total over the HTML sentence, and a floor computed from an impossible synthetic fact simply
   returns a number. **The error class: an exhaustiveness question answered by search rather than
   by following the consumers.** Every site that is total over `FactKind` is a compile error and
   therefore safe; the dangerous ones are precisely those a compiler cannot see.

4. **Status handling was absent.** The analyzer was specified as reading both revisions of
   `file.path`, with no `previousPath`, no added/deleted branches. A renamed manifest would have
   emitted every dependency as added — wrong `verified` findings, which the risk table already
   said must never happen.
