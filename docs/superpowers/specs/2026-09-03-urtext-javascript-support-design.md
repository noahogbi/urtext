# JavaScript in a TypeScript project — design

**Date:** 2026-09-03
**Status:** proposed

> **Revision 1, after a Fable review returned REVISE with four blocking findings.** Each was
> checked against the code before being accepted; all four held. Two were caught only by
> running the design, not by reading it.
>
> The worst made a headline feature inert. Widening `citationsIn` does nothing on its own,
> because `CITATION_PATHSPECS` selects candidates before that dispatch is ever reached — and
> that constant's own comment has been documenting the same gap for `.mts`/`.cts` all along.
> An earlier draft cited that comment and missed what it said.
>
> "Wasted work, not wrong output" was false: `changeset.files[].symbols` also feeds the
> report's exported-symbol table and the model's prompt, so widening extraction changes
> visible output in every project.
>
> The `ScriptKind` ternary exists at four sites, not two, and the fourth is the one this
> design routes `.jsx` through. TypeScript's error recovery salvages names from mis-parsed
> JSX, so a findings-based test would have passed over it.
>
> And the typed tier's gate tested the wrong option: `checkJs: true` turns JavaScript on
> while leaving `allowJs` unset, so reading the raw field would have silently excluded a
> project whose compiler does include its JavaScript — the exact failure this document's
> risk table leads with.
>
> Seven local defects fixed alongside, including a minified-skip that had no channel to
> report through, a positioning claim stronger than the code supports, and an acceptance
> range that moves.

## As built

Executed 2026-09-03, across several follow-on commits and a final whole-branch review. Three
of this document's own sentences did not survive execution; they are recorded here because the
spec is a record of intent, not a description of the shipped code, and "### Coverage needs no
change" below is the section that no longer holds.

- **`coverage.ts` was edited.** The section's opening claim — "So `coverage.ts` is not edited"
  — is false. `generatedFiles` and `generatedFilesNote` were added for the machine-written-
  JavaScript disclosure, `deletedTypeScriptFiles` was renamed, and both functions' doc comments
  were rewritten more than once as the review process found sharper wording.
- **`deletedTypeScriptFiles` did not stay narrow**, contradicting both places the section below
  says so. It was renamed to `deletedSourceFiles` and widened from `isTypeScriptFile` to
  `isSyntacticSource`, so a deleted `.mjs` now earns the same "exports, callers, and guards not
  analyzed" sentence a deleted `.ts` always has — resolving the gap the section's own "second
  case" describes, rather than leaving it stated in the review as the section's other option
  describes.
- **A further coverage defect surfaced only in a later whole-branch review and was fixed
  separately from this design.** `generatedFiles` filtered on `ChangedFile.generated` alone, so
  a generated file that was also the *cited target* of a citation finding could be named "no
  analyzer reported on it" beside a `verified` finding quoting that exact file. It now
  subtracts evidence the same way `unanalyzedFiles` already did, closing a gap this section did
  not anticipate.

## Why this exists

urtext ships JavaScript it cannot read. `action/compose-comment.mjs` and
`action/compose-comment-bin.mjs` compose the pull request comment every consumer of the
action sees, and no analyzer has ever looked at either. `scripts/measure-intent-gap.mjs`
and `scripts/stamp-build.mjs` are likewise invisible.

They show up in the disclosure that exists to catch this. Measured at `0698cbf~40...0698cbf`
— pinned, because `HEAD~40` moves and this document's own commits enter the range —
`coverage.unanalyzedFiles` holds 13 files: 7 `.yml`, 4 `.md`, and 2 `.mjs`. The two are
`scripts/measure-intent-gap.mjs` and `scripts/stamp-build.mjs`, not the `action/` files
named above, which that range does not touch. Re-run it rather than trusting the number.

The gap is not a considered limit. It is a filter nobody revisited: `isTypeScriptFile`
(`src/extract/symbols.ts:13-15`) matches `.ts`, `.tsx`, `.mts`, `.cts` and nothing else,
while this repository's own `tsconfig.json:13-14` sets `allowJs: true` and
`checkJs: true` — the project asks for its JavaScript to be checked, and urtext declines.

## The positioning question, answered from the code

The README's `**It analyses TypeScript projects.**` is deliberate and well defended, so
the test is whether reading `.js` moves it.

It does not, and the argument is structural rather than a judgement call.
`compilerOptions` (`src/analyze/program.ts:71-99`) reads the repository's own
`tsconfig.json` and adopts its options wholesale, dropping only the emit-shaped ones. The
hardcoded `allowJs: false` at `:79` lives in the **fallback** used when a repository has
no usable tsconfig — it is not a policy urtext applies to configured projects. So for any
project that sets `allowJs`, the compiler urtext builds already includes JavaScript; the
only thing keeping those files out is which paths get selected as roots.

The sentence therefore gains precision rather than changing scope: urtext analyses
TypeScript projects, including the JavaScript in them.

**One caveat, so the argument is not stronger than it is.** Roots come from `listPathsAt`,
never from the tsconfig's own `files`/`include` list — this is existing behaviour for
TypeScript too. This repository's `tsconfig.json` includes `src`, `test` and `action` but
**not** `scripts/`, so "the project asks for its JavaScript to be checked" is not true of
`scripts/measure-intent-gap.mjs` or `scripts/stamp-build.mjs`, two of the files this design
sets out to reach. The honest form of the claim is narrower: urtext reads what the
repository tracks, and the project's `allowJs` decides only whether the *typed* analyzers
join in.

## The split this design turns on

The five code analyzers do not need the same things, and treating them alike would be
the design error here.

| analyzer | how it reads source | needs the program |
|---|---|---|
| effects (`src/analyze/effects.ts:157`) | `ts.createSourceFile` | no |
| guards (`src/analyze/guards.ts:52`, `:252`) | `ts.createSourceFile` | no |
| citations (`src/analyze/citations.ts:367`) | text and comment scanning | no |
| surface (`src/analyze/surface.ts:324`) | `ctx.programAt`, type checker | **yes** |
| blast radius (`src/analyze/blast-radius.ts:144`) | `ctx.programAt`, type checker | **yes** |

Three of the five never consult a compiler option. Verified rather than assumed:
`grep` for `programAt|getTypeChecker` returns nothing in `effects.ts`, `guards.ts` or
`citations.ts`.

So:

- **The syntactic three read JavaScript unconditionally.** Nothing is being overridden —
  they build their own `SourceFile` and never see `allowJs`.
- **The typed two read it only when the project's tsconfig sets `allowJs`.** Without it
  the compiler genuinely excludes those files, so feeding them as roots achieves nothing;
  forcing the option would make urtext analyse a program the project does not build, and
  surface type errors it never opted into.

## What is built

### Two predicates, and why not one widened one

`isTypeScriptFile` is **unchanged**. Its own comment records that the `.tsx?`-only version
of this test "made every `.mts`/`.cts` file invisible to every analyzer, silently — the
worst outcome this tool has" (`src/extract/symbols.ts:5-12`), and fourteen usages
across nine files depend on it meaning what its name says — thirteen calls plus one
passed to `.filter` as a predicate reference (`src/analyze/program.ts:67`), which is why a
grep for the call form alone undercounts it. Widening it would move all fourteen at once,
including the six that must stay narrow. That count is `src/` only; `test/extract/symbols.test.ts`
holds twelve more calls, which pin the predicate narrow and are expected to survive this
change unaltered — if one of them needs editing, the predicate was widened when it should
not have been.

Added beside it, in the same file:

```ts
/** A JavaScript implementation file, in every extension the language has. */
export function isJavaScriptFile(path: string): boolean {
  return /\.(?:js|mjs|cjs|jsx)$/.test(path);
}

/** Source an analyzer can read without a program: TypeScript or JavaScript. */
export function isSyntacticSource(path: string): boolean {
  return isTypeScriptFile(path) || isJavaScriptFile(path);
}
```

Four extensions, and the omissions are deliberate for the reason the TypeScript comment
already gives: there is no `.mjsx` or `.cjsx`, because JSX never got module-explicit
flavours. There is no declaration flavour to exclude — JavaScript has no `.d.js`.

Every call site then states which tier it means. The fourteen divide as follows.

**Widened to `isSyntacticSource`:**

| site | why |
|---|---|
| `src/analyze/effects.ts:155`, `:265` | syntactic analyzer |
| `src/analyze/guards.ts:50`, `:159`, `:251` | syntactic analyzer |
| `src/analyze/citations.ts:367` | comment scanning — but this alone is inert; see below |
| `src/extract/symbols.ts:244` | symbol extraction is syntactic |
| `src/extract/index.ts:48` | the read gate feeding extraction; its comment ("mapSymbols discards non-TypeScript files anyway") stops being true and changes with it |

**Left narrow, deliberately:**

| site | why |
|---|---|
| `src/analyze/surface.ts:324` | typed analyzer — gated separately, below |
| `src/analyze/blast-radius.ts:144` | typed analyzer — gated separately, below |
| `src/analyze/program.ts:67`, `:239` | program roots — gated by `allowJs`, below |
| `src/report/coverage.ts:26`, `:167` | see "Coverage needs no change" |

### Citations have a second gate, and it is the real one

Widening `citationsIn` (`citations.ts:367`) on its own does nothing. That function only ever
receives files already chosen as candidates, and both selection paths — `sweepCandidates`
(`:823`) and `touchedCandidates` (`:871`) — hand git a fixed pathspec list:

```ts
export const CITATION_PATHSPECS = ["*.md", "*.markdown", "*.txt", "*.ts", "*.tsx"] as const;
```
(`src/analyze/citations.ts:68`)

A `.mjs` file never becomes a candidate, so the widened dispatch would be dead code.

The constant's own comment says so, about a different extension: it is "narrower than
`isTypeScriptFile` accepts — it also takes the module-explicit extensions, which no
pathspec here names — so a citation written in one of those files is not checked at all.
An under-report" (`:62-67`). That comment was cited in an earlier draft of this document
and its meaning missed.

So `CITATION_PATHSPECS` gains `*.js`, `*.mjs`, `*.cjs`, `*.jsx` — **and** `*.mts`, `*.cts`,
which closes the under-report its comment has been documenting all along. The comment is
rewritten in the same commit to describe the list as it then is; leaving it describing a
gap that no longer exists would be the same defect in the other direction.

### The extraction chain, which is not obvious

`blast-radius.ts:144` filters on `f.symbols.some(...)`, and `f.symbols` is populated by
`mapSymbols` (`src/extract/symbols.ts:244`) from text read at `src/extract/index.ts:48`.
So the typed analyzers depend on extraction having run, and extraction is two layers below
them.

Extraction widens **unconditionally**, with the syntactic tier, because it is syntactic
work and because the layer has no access to the repository's compiler options.

**This is a visible behavioural change in every project, including `allowJs: false` ones,
and it is intended.** An earlier draft called it "wasted work, not wrong output"; that was
false. `changeset.files[].symbols` has two consumers beyond the typed analyzers:

- `src/report/model.ts:864` builds `surfaceSymbols`, the report's exported-symbol table,
  directly from it.
- `src/interpret/prompt.ts:117-118` puts every file's symbols into the model's prompt.

So JavaScript symbols will appear in the report and in what the model is told, whatever the
project's `allowJs` says. That is the right outcome — a changed export in a `.mjs` file is a
real change, and describing it is what those two surfaces are for — but it is a decision,
not a side effect, and it means this design's blast radius is wider than the analyzer list
suggests. The alternative, threading tsconfig down into extraction, would put a
compiler-configuration dependency in a layer that deliberately has none.

### The typed tier's gate

`createProgramAt` already reads the repository's options. It gains a JavaScript branch
keyed on the option the project set:

The condition is **`ts.getAllowJSCompilerOption(options)`**, never `options.allowJs`.
TypeScript turns JavaScript on when `checkJs` is set even though `allowJs` stays unset, so
reading the raw field silently excludes a project whose compiler does include its JavaScript
— the "invisible to one analyzer, silently" failure this document's risk table leads with.
Measured:

```
{"checkJs":true}   options.allowJs = undefined  getAllowJSCompilerOption = true
{"allowJs":true}   options.allowJs = true       getAllowJSCompilerOption = true
{}                 options.allowJs = undefined  getAllowJSCompilerOption = false
```

- `src/analyze/program.ts:205` — the host read filter admits `.js`/`.mjs`/`.cjs`/`.jsx`
  under that condition, alongside the TypeScript extensions it always admits.
- `src/analyze/program.ts:239` — root selection admits the same files under the same
  condition.
- `src/analyze/program.ts:67` (`listTypeScriptFilesAt`) — same condition. Its name becomes
  inaccurate the moment it can return `.js`, so it is renamed `listProgramSourcesAt`;
  a stale name here is the class of defect this project's citation rule exists to catch.
- `surface.ts:324` and `blast-radius.ts:144` — accept JavaScript when the program includes
  it. Each analyzer already holds `ctx`, so each can ask.

The fallback options at `:79` keep `allowJs: false`. A repository with no usable tsconfig
is not a project that has declared JavaScript to be part of it, and the syntactic three
still read its JavaScript regardless.

### The `ScriptKind` trap

**Four** sites construct a `SourceFile` with an explicit kind — not two, as an earlier
draft said: `src/analyze/effects.ts:162`, `src/analyze/guards.ts:57`, `src/analyze/guards.ts:257`,
and `src/extract/symbols.ts:37` (`parse()`, which `mapSymbols` calls). The fourth matters most,
because this design routes `.jsx` through `mapSymbols`. All four read:

```ts
path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
```

Passing a `.jsx` file through that ternary yields `ScriptKind.TS`, and TypeScript then
reads `<div className="a">` as a type assertion. Traced rather than reasoned about:

```
ScriptKind.TS  on a.jsx → parse diagnostics: "'>' expected." | "',' expected."
ScriptKind.JSX on a.jsx → parse diagnostics: none
```

Every JSX file would mis-parse silently, producing no findings and no error. The ternary
becomes a four-way choice — `.tsx` → `TSX`, `.jsx` → `JSX`, `.js`/`.mjs`/`.cjs` → `JS`,
otherwise `TS` — extracted into one exported helper in `src/extract/symbols.ts` that
**replaces all four sites**, and pinned by a test asserting a JSX fixture parses with zero
diagnostics through each of them, `mapSymbols` included.

The pin must be on **diagnostics**, not on findings. TypeScript's error recovery salvages
top-level declaration names and line ranges from mis-parsed JSX, so an analyzers-by-extension
table can pass while `mapSymbols` is quietly parsing garbage in a richer file. A findings-only
assertion would not see it.

The `.js` leg is load-bearing too, not filler: JSX inside a plain `.js` file — the Babel
convention — also mis-parses under `ScriptKind.TS` and parses clean under `ScriptKind.JS`, so
it gets its own fixture. Non-JSX JavaScript (JSDoc types, `#private` fields) parses identically
under either kind, so nothing else here depends on the change.

### Machine-written JavaScript

Nothing today excludes committed build output. `listPathsAt`
(`src/analyze/program.ts:52`) filters `node_modules` and nothing else, so a repository
with a bundle in `dist/` would have it parsed by three analyzers and could have a review
dominated by effect findings nobody can act on.

Skipped by **shape, not by path**: a JavaScript file whose *first* line exceeds a length
constant named for what it detects rather than for its value. First line, not any line —
"any line" would skip a hand-written file carrying one long data URI, under a warning that
mis-describes it. Path conventions are a guess about someone else's layout: a project
shipping hand-written code from `dist/` would lose it silently, and one committing a bundle
to `src/` would still be analysed.

**The detector is deliberately weak, and the spec says so rather than implying otherwise.**
A bundle with a banner comment, or minified output that a tool line-wrapped, has a short
first line and will not be skipped. This catches the common case — one enormous line — and
nothing else. It is not a general "is this generated?" test and must not be described as one.

**Where the detection lives, because the obvious place has no channel.** An earlier draft
said the skip becomes "one warnings line" without checking that anything could emit it.
`effectsAnalyzer` and `guardsAnalyzer` are plain `Analyzer` constants; only the factory
pattern reaches `warnings` (`src/cli.ts:406-416`), and `extract()` has no note channel at
all. Emitting from three analyzers would also mean three copies of one sentence, or
cross-analyzer dedupe.

So detection happens **once, at extraction**, where the file's text is already read
(`src/extract/index.ts:48`). The changed-file record gains one optional field marking the
file as machine-written. Then:

- the syntactic three skip on the field rather than each re-detecting;
- program root selection skips it too, so a bundle in an `allowJs` project does not become
  a root and get type-checked — a hole the per-analyzer design would have left open;
- the disclosure names it with a reason, distinguishing "no analyzer reported on this" from
  "this was skipped because it is machine-written".

One detection point, one field, one sentence to the reader. If the field proves more
invasive than this section assumes, the fallback is to skip silently and let
`unanalyzedFiles` disclose it generically — weaker, but never false.

### Coverage needs no change

`unanalyzedFiles` (`src/report/coverage.ts:154-172`) lists a changed file when it is not
TypeScript **and** no non-model finding names it. A `.mjs` file is not TypeScript, so it is
listed today — which is exactly why the two are in the backlog — and the moment an analyzer
reports on one, `reported.has` drops it. A file skipped for being machine-written keeps its
place in the list, correctly, because nothing reported on it.

So `coverage.ts` is not edited, and the obvious move — widening `isTypeScriptFile` there
too — would break it: JavaScript would be excluded from the disclaimer whether or not
anything actually read it.

**But "accurate on its own" would overstate it, and two cases show why.** A `.mjs` file that
is read by three analyzers and yields no findings stays on the list, because nothing named
it. The note's wording survives this — it "claims non-reporting, not non-reading"
(`src/report/coverage.ts:177`) — but JavaScript now sits in a middle state that TypeScript
does not: analysed like TypeScript, disclosed like YAML. That is defensible and it is not
invisible, but it is a difference this design creates and should own.

The second case is a real gap. `deletedTypeScriptFiles` (`:26`) stays narrow, so a **deleted**
`.mjs` gets no note at all: its effects finding vanishes with it, it leaves the unanalyzed
list, and nothing tells the reader its exports and callers went unexamined — which is exactly
what `deletedFilesNote` exists to say for TypeScript. Widening `:26` would make that note's
own wording false. Resolving this is in scope for the plan, not deferred: either the note is
reworded to cover both languages, or the gap is stated in the review rather than left silent.

`deletedTypeScriptFiles` (`:26`) stays narrow. It backs a note about deleted TypeScript
files specifically, and widening it would make that note's wording false.

## What the compiler catches, and what it does not

Nothing here is defended by a type. `isTypeScriptFile` returns a boolean at fourteen
usages, and every one of them compiles whichever predicate it calls. The failure this design
risks is exactly the one already in the record: a file class that is invisible to one
analyzer, silently, because a single call site was missed.

The guard is therefore a test, and it is the centre of the testing plan rather than an
afterthought: **one table over analyzers × extensions**. A fixture per extension —
`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.d.ts` — each containing a
guard, an effect, an export with a caller, and a comment citing a real line, run through
every analyzer, asserting which report and which do not. A missed call site changes a cell.

## Testing

- The table above, which is what makes a missed call site fail rather than vanish.
- `isJavaScriptFile` accepts all four extensions and rejects `.ts`, `.json`, `.md`, and a
  path merely containing `.js` (`a.json`, `x.js.map`).
- A `.jsx` fixture parses with no diagnostics and yields the same findings as its `.tsx`
  twin — the `ScriptKind` regression test.
- Effects and guards report on `action/compose-comment.mjs`, this repository's own shipped
  JavaScript, at real lines.
- A citation in a `.mjs` comment rots exactly as one in a `.ts` comment does.
- With `allowJs: false` in a fixture project: the syntactic three still report; surface and
  blast radius do not, and nothing throws.
- With `allowJs: true`: surface reports an added export in a `.mjs` file.
- A single-line JavaScript file produces no findings and exactly one warnings note naming
  it; a normal multi-line file produces no such note.
- `unanalyzedFiles` on a range touching `action/compose-comment.mjs` no longer lists it,
  and still lists a minified file.

One build hazard worth naming because it bites immediately: widening `citations.ts:367`
orphans that file's `isTypeScriptFile` import, and `noUnusedLocals` turns that into a build
error rather than a warning. The same applies anywhere a call site is the last user of the
narrow predicate in its file.

Acceptance, on this repository, at the pinned range `0698cbf~40...0698cbf`:
`review 0698cbf~40...0698cbf --no-llm --json` reports on both `.mjs` files and
`coverage.unanalyzedFiles` drops from **13 to 11**.

Two things about that number, so it is not read as proving more than it does. The two files
are `scripts/*.mjs`, and they drop off **solely because effects fires** on them: guards skips
added files (`guards.ts:160`) and both are added in that range, and citations cannot reach
them until `CITATION_PATHSPECS` widens. So the acceptance run exercises one analyzer, not
three, and a plan that treats it as end-to-end coverage of the whole design would be wrong.

## Risks

| risk | handling |
|---|---|
| A call site missed, silently — the failure already in this file's record | The analyzers × extensions table; a missed cell fails |
| `.jsx` mis-parsed as TypeScript | Traced above with real diagnostics; one shared `ScriptKind` helper, pinned |
| A committed bundle floods a review | Skipped by shape and disclosed; content-based, so no guess about layout |
| Widening `isTypeScriptFile` by reflex in a later change | It is left untouched here, and its comment already says what that cost |
| `listTypeScriptFilesAt` returning JavaScript under a TypeScript name | Renamed in the same commit that widens it |
| Extraction doing work no analyzer consumes under `allowJs: false` | Accepted and stated; the alternative puts compiler configuration in a layer that has none |

## Review history

Per the rule in `2026-08-30-urtext-intent-gap-index-design.md`: every `file:line` claim
here was checked against the file at `0698cbf`, and checking that a citation points at the
right line is not the same as checking the claim about its behaviour is true. The
behavioural claims — that three analyzers never touch the program, that `.jsx` mis-parses
under `ScriptKind.TS`, that `compilerOptions` adopts the repository's `allowJs`, and that
`unanalyzedFiles` needs no edit — were each produced by reading the code or running it,
not by composing a plausible account. The unanalyzed-file counts came from running the
tool.
