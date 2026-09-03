# JavaScript in a TypeScript project — design

**Date:** 2026-09-03
**Status:** proposed

## Why this exists

urtext ships JavaScript it cannot read. `action/compose-comment.mjs` and
`action/compose-comment-bin.mjs` compose the pull request comment every consumer of the
action sees, and no analyzer has ever looked at either. `scripts/measure-intent-gap.mjs`
and `scripts/stamp-build.mjs` are likewise invisible.

They show up in the disclosure that exists to catch this. Measured on `HEAD~40...HEAD` at
`0698cbf`, `coverage.unanalyzedFiles` holds 13 files: 7 `.yml`, 4 `.md`, and those 2
`.mjs`. Re-run it rather than trusting the number.

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
TypeScript projects, including the JavaScript those projects declare to be theirs.

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
including the six that must stay narrow.

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
| `src/analyze/citations.ts:367` | comment scanning; a `.mjs` comment can rot a citation exactly as a `.ts` one can |
| `src/extract/symbols.ts:244` | symbol extraction is syntactic |
| `src/extract/index.ts:48` | the read gate feeding extraction; its comment ("mapSymbols discards non-TypeScript files anyway") stops being true and changes with it |

**Left narrow, deliberately:**

| site | why |
|---|---|
| `src/analyze/surface.ts:324` | typed analyzer — gated separately, below |
| `src/analyze/blast-radius.ts:144` | typed analyzer — gated separately, below |
| `src/analyze/program.ts:67`, `:239` | program roots — gated by `allowJs`, below |
| `src/report/coverage.ts:26`, `:167` | see "Coverage needs no change" |

### The extraction chain, which is not obvious

`blast-radius.ts:144` filters on `f.symbols.some(...)`, and `f.symbols` is populated by
`mapSymbols` (`src/extract/symbols.ts:244`) from text read at `src/extract/index.ts:48`.
So the typed analyzers depend on extraction having run, and extraction is two layers below
them.

Extraction widens **unconditionally**, with the syntactic tier, because it is syntactic
work and because the layer has no access to the repository's compiler options. The cost is
that a project with `allowJs: false` extracts symbols for JavaScript that surface and blast
radius then ignore. That is wasted work, not wrong output, and it is the cheaper of the two
errors: threading tsconfig down into extraction to save it would put a compiler-configuration
dependency in the layer that deliberately has none.

### The typed tier's gate

`createProgramAt` already reads the repository's options. It gains a JavaScript branch
keyed on the option the project set:

- `src/analyze/program.ts:205` — the host read filter admits `.js`/`.mjs`/`.cjs`/`.jsx`
  when `options.allowJs` is true, alongside the TypeScript extensions it always admits.
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

Both syntactic analyzers construct their `SourceFile` with an explicit kind:

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
otherwise `TS` — extracted into one exported helper in `src/extract/symbols.ts` so the two
analyzers cannot drift apart, and pinned by a test asserting a JSX fixture parses without
diagnostics.

### Machine-written JavaScript

Nothing today excludes committed build output. `listPathsAt`
(`src/analyze/program.ts:52`) filters `node_modules` and nothing else, so a repository
with a bundle in `dist/` would have it parsed by three analyzers and could have a review
dominated by effect findings nobody can act on.

Skipped by **shape, not by path**: a JavaScript file whose content is one very long line
is machine-written, whatever directory it sits in. Path conventions are a guess about
someone else's layout — a project shipping hand-written code from `dist/` would lose it
silently, and one committing a bundle to `src/` would still be analyzed.

The threshold is a single line longer than a constant named for what it detects, not for
its value. Only JavaScript is subject to it: a minified `.ts` file is not a thing that
occurs, and applying the test to TypeScript would change existing behaviour for no reason.

**The skip is disclosed, never silent.** It becomes one warnings line naming the files, in
the register of the existing notes — `<path> is a single line of generated JavaScript, so
it was not analyzed.` Silence would leave a reader believing three analyzers had looked at
a file they skipped, which is precisely the impression `unanalyzedFiles` exists to prevent.

### Coverage needs no change

`unanalyzedFiles` (`src/report/coverage.ts:154-172`) lists a changed file when it is not
TypeScript **and** no non-model finding names it. A `.mjs` file is not TypeScript, so it is
listed today — which is exactly why the two are in the backlog — and the moment an analyzer
reports on one, `reported.has` drops it. A file skipped for being machine-written keeps its
place in the list, correctly, because nothing reported on it.

So the disclosure becomes accurate on its own and `coverage.ts` is not edited. This is
worth stating because the obvious move — widening `isTypeScriptFile` there too — would
break it: JavaScript would be excluded from the disclaimer whether or not anything actually
read it.

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

Acceptance, on this repository: `review HEAD~40...HEAD --no-llm --json` reports on the two
`.mjs` files, and `coverage.unanalyzedFiles` drops from 13 to 11.

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
