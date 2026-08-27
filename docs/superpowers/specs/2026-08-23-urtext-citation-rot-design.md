# urtext citation rot — design

**Date:** 2026-08-23
**Status:** approved in conversation (design sections reviewed); this document is the binding spec
**Prior art:** `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md` (the evidence tiers, and
the rule that a confident wrong answer is trusted exactly once, which this design must not weaken) and
`docs/superpowers/specs/2026-08-23-urtext-intent-comparison-design.md` (the trust-boundary discipline:
name exactly what the tool knows, and forbid in copy the words that would overstate it).

## Purpose

Prose in this repository cites code by `path:line`. Code moves. The citation does not. Nothing tells
anyone, and the reader who follows the pointer lands on a line that has nothing to do with the sentence
that sent them there.

urtext's whole thesis is that an edition which cannot cite its source is worthless. This feature turns
that thesis on the repository that states it: **when this change moved code, which prose in this
repository now points somewhere else?**

Structurally it is the inverse of blast radius. Blast radius asks "your change touched this export — who
calls it?" Citation rot asks "your change moved this code — who *describes* it?" Both start from the
changed file and follow references outward; one follows the type checker, the other follows text.

Everything it reports is deterministic and lands in the `verified` tier. That is the reason the honesty
section below is the longest one in this document: a `verified` badge on a claim urtext cannot actually
support is the single most expensive mistake this project can make.

## The claim, exactly

This is the section to read before any other.

A rotted citation is **not** wrong documentation. urtext has no idea what the author meant. What it
knows, mechanically and completely, is a statement about resolution over time:

> When this citing line was last written, this citation resolved. It does not resolve the same way now.

Everything in this design exists to make that sentence, and only that sentence, provable per finding.

The consequences are binding:

1. **The finding names the citation and what no longer resolves, never the correctness of the prose and
   never who caused it.** "This line cites `src/analyze/fact.ts:45`, which no longer reads the same" is
   the shape. "This documentation is wrong", "this comment is out of date", "this reference is stale"
   are not, in any surface, ever — and neither is "which this change moved", which asserts a cause the
   baseline cannot establish (see the `content_drift` copy below for why).
2. **The words "wrong", "incorrect", "outdated", "stale", "obsolete", "misleading", "broken", and
   "lies" are forbidden in urtext's own citation copy** — titles, bodies, disclosure notes, the CLI,
   USAGE. A copy guard test enforces this the way the intent design's does (see Testing).
3. **Every rot kind is gated on the baseline** (see "The baseline gate"). A citation that never resolved
   is not rot; it is a typo, an illustration, or a plan for a file that does not exist yet, and urtext
   cannot tell those apart. It says nothing about them.
4. **No fix, no suggestion, no "did you mean".** urtext does not know where the cited content went, and
   guessing would put a `verified` badge on a search result. See Out of scope.
5. **The finding anchors on the citing line, not the cited line.** The reader's work is at the prose.
   `Fact.file`/`Fact.line` therefore name the prose, which `makeFact` derives from `evidence[0]`.

## What counts as a citation

Two forms, both fully deterministic to check. A bare file path with neither a line nor a quote is **not**
a citation — that shape appears in ordinary prose constantly ("see `src/cli.ts`") and carries no
assertion a machine can test.

### Form A — a path and a line

`src/analyze/fact.ts:45`, or a range, `src/analyze/fact.ts:45-63`.

```ts
/**
 * A repository-relative path followed by a line, or a line range. The path
 * must contain at least one directory separator — see
 * CITATION_GUARD_SEPARATOR in the false-positive guards below for why a bare
 * `Something.js:14` is not treated as a citation at all.
 */
export const LINE_CITATION =
  /(?<![A-Za-z0-9_@./-])((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*):([1-9][0-9]*)(?:-([1-9][0-9]*))?(?![0-9A-Za-z_/-])/g;
```

In words, left to right: a lookbehind rejecting a preceding path character, so a match cannot start in
the middle of a longer path; **one or more** `segment/` groups, which is what makes the separator
mandatory; a final segment with a dot and an alphanumeric extension; a colon; a line number with no
leading zero; optionally a hyphen and an end line; and a lookahead rejecting a trailing digit, letter,
underscore, slash, or hyphen, so `fact.ts:45` is not matched inside `fact.ts:456`.

> **Correction (2026-08-24, ruled during implementation).** This lookahead originally also rejected a
> trailing `.`, which made **every sentence-final citation invisible** — `See src/analyze/fact.ts:45.`
> matched nothing, because the closing period defeated it. The period is now excluded from the class.
> Measured before ruling, on the corpus this feature targets — a private TypeScript and Next.js
> application, called **the reference repository** throughout this document, carrying 51 markdown files
> and 233 Form A citations: 215 are backticked, 15 are followed by a comma, 2 by a parenthesis, 1 by a
> space, and
> **none by a period** — so the impact on that corpus was zero and the change is recall insurance for
> other writing styles, not a repair of a live failure. The `fact.ts:456` case the lookahead exists for
> is served by its digit and letter members alone.

Capture groups: 1 = path, 2 = start line, 3 = end line or undefined.

A parsed line number that is not a safe integer is discarded rather than checked — a forty-digit numeral
is not a line, and `Number` would silently round it.

This is the high-volume form; one spec file in the reference repository carries 74 of them.

### Form B — a path and a quoted phrase

urtext's own comment-contract form: `` see `test/report/model.test.ts`, "carries the mark's words" ``.
Several dozen sites in `src/` use it today. It is the most checkable citation form in the repository,
because the quoted text either appears in the named file or it does not.

```ts
/** A backticked repository-relative path, then a quoted phrase. */
export const QUOTED_CITATION =
  /`((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*)`[,;:]?\s{0,3}["“]([^"”]+)["”]/g;
```

In words: the same mandatory-separator path, inside backticks; an optional comma, semicolon, or colon;
up to three whitespace characters; then a straight or left curly double quote, the phrase, and a
straight or right curly close. Capture groups: 1 = path, 2 = phrase.

Two post-match rules, applied in code rather than in the pattern so their reasons stay readable:

- **The phrase must contain whitespace.** A single quoted word — `"--open"`, `"default"` — is prose
  emphasis far more often than a citation, and one word is too weak a needle to conclude anything from.
  This under-reports on purpose.
- **The phrase is discarded above `MAX_QUOTE_CHARS` code points**, counted with `[...text]` for the
  reason `truncateSignature` in `src/analyze/surface.ts` documents. A quote that long is a block
  quotation, not a pointer.

Matching and comparison both run on a **normalized** phrase: every whitespace run, newlines included,
collapsed to a single space, then trimmed. The cited file's text is normalized identically before the
containment test. Without this, every comment-contract citation in `src/` would fail — they wrap across
` * ` continuation lines, so the phrase as written contains newlines and asterisks the cited file never
had.

## Where citations are looked for

Two kinds of place, scanned differently, both reached through git so untracked and ignored files (and
therefore `node_modules`) are never touched.

**Prose files.** Any tracked file whose extension is in `PROSE_EXTENSIONS` — `.md`, `.markdown`, `.txt`.
Scanned as raw text after masking (below).

**TypeScript comments.** Any tracked file `isTypeScriptFile` accepts. Comments only: a `path:line` inside
a string literal is usually a test fixture's expected output, and inside code it is not prose making a
claim. Comments are collected with the same leaf walk `test/comment-contract.test.ts` documents at
length — parse with `ts.createSourceFile`, walk to leaf tokens, ask each leaf both
`ts.getLeadingCommentRanges(text, node.getFullStart())` and `ts.getTrailingCommentRanges(text,
node.getEnd())`, deduplicate by range start — because a raw scanner loop desynchronizes on the first
template interpolation and this codebase's comments sit beside plenty of those.

`citations.ts` carries its own copy of that walk rather than importing the guard test's. The duplication
is deliberate and named here so a reviewer does not treat it as an oversight: a plan that wants one copy
should hoist it into a shared module and update both call sites in the same change, not import test code
into `src/`.

**Comment text is unwrapped before matching, and the unwrap carries an offset map.** Each comment's body
has its `/*`, `*/`, `//`, and leading ` * ` decorations removed and its lines joined with single spaces,
producing one logical string; alongside it, an array maps every logical index back to an absolute source
offset. The citing line reported in evidence is derived from that map, so a Form B citation whose quote
wraps across three comment lines is reported at the line its path actually sits on. A naive "line of the
comment's start" would misreport every wrapped citation in `src/`, which are most of them.

**`.urtext/` is excluded** (`REPORT_DIR` in `src/types.ts`). urtext's own reports quote source lines by
`path:line` by construction; scanning them would make every review generate citations that the next
review reports as rotted.

## The two modes

One analyzer, one code path, one difference: which citations survive the filter.

**Default — in the pipeline, on every review.** Only citations whose resolved cited path is one the
reviewed range touched. `TOUCHED` is every `file.path` and every `file.previousPath` in the changeset, so
a rename is covered on both sides. Cost is bounded by the change, not the repository, which is what makes
this safe to run unconditionally.

Candidate citing files are found with git rather than by reading the repository:

```
git grep -I -l -F -e <basename> [-e <basename> ...] [<range.to>] -- '*.md' '*.markdown' '*.txt' '*.ts' '*.tsx'
```

run at `range.to` (no revision argument when `range.to` is the `WORKTREE` sentinel, so the working tree
is searched). Basenames rather than full paths, because prose cites a file by many spellings and the
resolution rules below decide what a path means; the full-path filter is applied after extraction, on
resolved paths, where it is exact. Terms are chunked at `MAX_GREP_TERMS` per invocation and the results
unioned — chunking loses nothing, so unlike the caps below it needs no disclosure.

**`git grep` exits 1 when nothing matches, so `git()` rejects.** That rejection is an absence, not a
failure: it is caught and read as "no candidate files", exactly as `readAt` reads git's absence wording
as `null`. Any other rejection travels the degradation path.

**Sweep — under `--citations`.** Every citation in the repository, with no cited-path filter. Candidates
come from `git ls-files -z -- <the same pathspecs>`, minus `REPORT_DIR`. This is the audit mode: it
answers "is this repository's prose still true about its own code?" rather than "did this change break
something?".

Both modes apply every cap in "Cost discipline", and both disclose when one bites.

## Resolving a cited path

At a given revision, in this order, first hit wins:

1. Repository-root-relative, which is how every path in this codebase is spelled and how
   `git show <rev>:<path>` resolves.
2. Relative to the citing file's own directory, **for prose files only**. A doc that says
   `../src/cli.ts:12` means it; a comment in `src/cli.ts` that says `report/model.ts:14` means the
   repository path, and resolving it against `src/` would invent a file.

A path that resolves neither way at the revision in question is absent there. Reads go through
`ctx.readAt(rev, path)` from `AnalysisContext`, so the `WORKTREE` sentinel, the absence-versus-failure
distinction, and the locale pinning are all the existing ones.

## The baseline gate

Every rot test asks the same two-part question:

1. Did this test pass at the **baseline** — the commit that last wrote the citing line?
2. Does it fail **now** — at `range.to`?

Rot is exactly (1) and (2) together. A citation that failed at the baseline too never resolved, and
urtext says nothing about it.

The baseline comes from blame:

```
git blame --line-porcelain --root [<range.to>] -- <citing path>
```

with the revision argument omitted when `range.to` is `WORKTREE`. `--line-porcelain` emits, per line, a
header line of `<40-hex> <orig-line> <final-line> [<count>]`, then key/value headers, then the line's
content prefixed with a tab. The parse keeps one thing: a `Map<finalLine, commitHash>`. **One blame per
citing file**, not per citation — see Cost discipline.

Two special baselines:

- **An uncommitted citing line** blames to the all-zeros hash. There is no earlier state to compare
  against: the citation is as new as the change under review. All four tests are skipped, and **nothing
  is disclosed**, because nothing was lost — this is an absence of history, not a degraded check.
- **A blame that fails** (shallow clone, a file outside the repository, any git error) takes the
  degradation path below.

### Limitation: blame under-reports, deliberately

**Blame gives when the citing line was last *touched*, not when the citation was last *verified*.** A
typo fix, a reflow, a rename of an unrelated symbol on the same line, a wholesale reformat — each resets
the baseline to a commit at which the citation may already have been rotting for a year. urtext then
compares the citation against a state that was already wrong and finds no drift.

This is stated as a named limitation rather than buried, and it is not a defect to be fixed later. It is
the **correct direction of error for a `verified` badge**: the failure mode is a rotted citation urtext
stays silent about, never a sound citation urtext accuses. A `verified` finding that misses things is a
tool a reader keeps trusting; a `verified` finding that invents one is trusted exactly once.

Every other approximation in this design leans the same way on purpose: the mandatory separator, the
phrase-must-contain-whitespace rule, the trimmed comparison, the skipped uncommitted baseline. Each
under-reports. None invents.

## The four rot tests

All four are deterministic; all four land in `verified`. `rot` is the discriminator stored in
`detail.rot`.

Which tests a citation is eligible for follows from its form, and no other rule: **(a) applies to both
forms**; **(b) and (d) to Form A only**, since they need a line number; **(c) to Form B only**, since it
needs a quoted phrase. A form is never checked by a test it has no input for, and a citation eligible for
nothing is not a citation.

Let `baseline` be the citing line's blame commit, `now` be `range.to`, and `cited` be the resolved cited
path.

**(a) `missing_file` — the cited file is not there any more.**
Passed at baseline: `ctx.readAt(baseline, cited)` is non-null. Fails now: `ctx.readAt(now, cited)` is
null. A citation to a path that did not exist at the baseline either is discarded, which is what keeps
this repository's own specs — full of illustrative `src/db.ts:14`-shaped examples in copy blocks — from
generating false findings.

**(b) `line_out_of_range` — the line number is past the end of the file.**
Passed at baseline: the cited line (and, for a range, the end line) was within the baseline file's line
count. Fails now: it is beyond the current file's line count. A citation to line 900 of a file that never
had 900 lines is a typo, not rot, and the gate drops it.

**(c) `quote_absent` — the quoted phrase is not in the file.**
Form B only. Passed at baseline: the normalized phrase appeared in the normalized baseline file. Fails
now: it does not appear in the normalized current file. Containment, not equality, and normalization on
both sides, so re-wrapping a source comment does not fire this and a genuine rewording does.

**(d) `content_drift` — the line still exists and no longer says the same thing.**
The one that needs history. Read `cited` at `baseline`, take the cited line (or the range's lines, joined
with newlines), compare against the same lines at `now`. Different → rot.

Comparison is on text with leading and trailing whitespace stripped per line. A pure re-indent moves no
content, and reporting it would be noise a reader cannot act on. For a range, the **first** differing
line is the one reported in `was`/`now`; the range is named in the finding.

Both sides are truncated to `MAX_QUOTE_CHARS` code points for storage and rendering, with
`CITATION_TRUNCATION_MARKER` appended when the cut runs, so no line merely appears to end.

Tests are checked in order (a), (b), (c), (d) per citation, and **the first one that fires wins**: a
missing file has no lines to be out of range and no content to have drifted, so emitting more than one
fact for one citation would be one finding said four ways.

## The copy, per rot kind

Composed in `src/score/index.ts`'s `toFinding`, like every other kind's. Titles are lowercase-led,
because every renderer prefixes them with `file:line — `.

Let `cited` be the cited path, `n` the cited line (or `n-m` for a range), `hash` the abbreviated baseline
commit, and `phrase` the quoted text.

**`missing_file`**

- title: `` cites `${cited}`, which is not in this repository any more ``
- body: `` This line cites `${cited}:${n}`. That file existed when this line was last written (${hash}) and is not present at this revision, so the citation does not resolve. What it was meant to point at is not something urtext can recover. ``

**`line_out_of_range`**

- title: `` cites `${cited}:${n}`, which is past the end of that file ``
- body: `` `${cited}` has ${lineCount} line(s) at this revision, so line ${n} is not in it. The citation resolved when this line was last written (${hash}); it resolves to nothing now. ``
  (**Correction, 2026-08-24:** this sentence was written unpluralized — `has ${lineCount} lines` — and a
  cited file of one line is reachable, so urtext would have said "has 1 lines" in its own voice. The count
  pluralizes; `line(s)` here stands for that, not for a literal parenthesis in the output. Every other
  count this feature interpolates into copy was swept for the same defect at the same time.)
  (For a range, "so lines ${n} are not all in it".)

**`quote_absent`**

- title: `` cites `${cited}` for a quoted phrase that is not in it ``
- body: `` This line cites `${cited}` and quotes “${phrase}”. That text was in `${cited}` when this line was last written (${hash}) and is not in it at this revision. urtext compares the quoted text against the file's contents; it does not know whether the text moved, was reworded, or was deliberately dropped. ``

**`content_drift`** — **one title, in both modes**:

- title: `` cites `${cited}:${n}`, which no longer reads the same ``
- body: `` When this line was last written (${hash}), `${cited}:${n}` read `${was}`. It now reads `${now}`. The citation still resolves to a line; it no longer resolves to the same content. urtext does not know whether the new line is what this sentence meant. ``
- body, one further sentence appended when `cited` is in `TOUCHED`: `` This change touched `${cited}`. ``

**There is deliberately no "which this change moved" variant, and a plan must not reintroduce one.**
The baseline is the commit that last wrote the *citing* line, which can predate the reviewed range by
any number of commits; the drift may have happened in any of them. Membership of `cited` in `TOUCHED`
is proven, so the body states exactly that and nothing more. Attributing the movement to the reviewed
change would be a causal claim under a `verified` badge that the evidence does not carry — the precise
mistake "The claim, exactly" exists to prevent, arriving through phrasing rather than through logic.
The same rule binds the `missing_file` and `line_out_of_range` copy above: they say the file is absent
or short *at this revision*, never that this change removed it.

Each body's closing sentence is the trust boundary made explicit at the point of the claim, in the same
spirit as `MODEL_CAUTION_CLAIM` in `src/report/model.ts`: state what was checked, then state what was
not.

## Degradation

The project rule is that a degraded review beats no review **only if the degradation is visible** —
`runAnalyzers`'s doc comment says exactly this, and `deletedFilesNote` in `src/report/coverage.ts` is the
same rule applied to coverage. Citation checking obeys it in three places:

> **Addition (2026-08-24, ruled during implementation): a shallow repository is not checked at all.**
> Before any candidate discovery, `git rev-parse --is-shallow-repository` decides. When it answers true,
> no citation is checked and one note states that the repository is shallow, so the commit that last
> wrote each citing line cannot be known.
>
> This exists because the obvious assumption is wrong, and was verified rather than reasoned about:
> `git blame --line-porcelain --root` on a `--depth 1` clone does **not** fail. It exits 0 and
> attributes every line to the graft commit — `--root` is exactly what suppresses git's boundary
> marker. So at depth one every baseline equals the tip, every gate compares a commit to itself, and
> citation checking would silently report nothing while appearing to run; at moderate depth a line can
> blame to a boundary commit, and the finding would then state that hash as "when this line was last
> written" — a fabricated historical claim under a `verified` badge, which this feature may never make.
> A disclosed skip is honest, a silent no-op is not, and a false baseline is worse than both.
>
> `--is-shallow-repository` is deliberately **not** wrapped in a `try`: a git too old to answer it makes
> the analyzer reject, which `runAnalyzers` discloses, where swallowing the error would not.

1. **A citation whose blame failed falls back to existence-only checking**: test (a) alone, ungated,
   against `range.to`. Tests (b), (c), and (d) all need the baseline file and cannot run.
2. **Existence-only checking is the one place a false positive is reachable**, and this spec says so
   rather than hiding it: without the baseline gate, an illustrative path in a copy block can be reported
   as missing. That is the price of saying something when history is unavailable, it is bounded to
   repositories where blame does not work at all (shallow clones, chiefly), and it is disclosed in the
   same breath.
3. **The disclosure is aggregated, once, with a count and a reason**, not once per citation:

   ```ts
   /** Copy for citations whose history could not be read. */
   export function blameUnavailableNote(count: number, reason: string): string;
   ```

   composing `` `${count} citation${s} could not be dated (git blame failed: ${reason}), so ${they} were checked only for whether the cited file exists` ``, pluralized inline in the style `review` in
   `src/cli.ts` already uses.

An analyzer that throws outright is still `runAnalyzers`'s business, reported through `AnalyzerFailure`
and the existing `the ${analyzer} analyzer failed, so this review is partial` warning. Nothing here
changes that path — but note the naming detail in "The analyzer" below, without which that sentence
would name the failure `analyzer #5`.

## Cost discipline

The rule: **bounded by citation count, not repository size.**

- **One `git blame --line-porcelain` per citing file**, never per citation. A file with forty citations
  costs one blame.
- **One `ctx.readAt` per (revision, path) pair**, memoized in a `Map` keyed on the two joined by a unit
  separator. `readAt` is a `git show` per call and is not memoized upstream; the analyzer memoizes it
  here, which is what turns "twelve citations into the same file at the same baseline commit" into one
  read.
- **The TypeScript program is never built.** `ctx.programAt` parses every TS file in the repository;
  citation checking needs text and comments, not types, so it must not call it. This analyzer is the only
  one of the five that touches no compiler API.

### Named caps

```ts
/**
 * The most citations one run checks, across both modes. Bounds a sweep of a
 * repository whose prose cites code everywhere; the default mode is already
 * bounded by the change and reaches this only on a very large diff. A cap
 * that bites is disclosed — see `citationsCappedNote`.
 */
export const MAX_CITATIONS_CHECKED = 2000;

/**
 * The most citing files one run opens. Bounds the blame calls, which are the
 * expensive per-file work; the citation cap above bounds the per-citation
 * work. Files are taken in path order so a capped run is deterministic.
 */
export const MAX_CITING_FILES = 320;

/**
 * The most distinct (revision, cited file) pairs one run reads historically.
 * A repository whose prose cites a hundred files from a hundred different
 * baseline commits would otherwise pay a `git show` per pair with no bound
 * at all; every citation past this is checked existence-only and said so.
 */
export const MAX_BASELINE_READS = 480;

/**
 * The most code points a quoted phrase, or a stored was/now line, carries.
 * Longer than this is a block quotation rather than a pointer.
 */
export const MAX_QUOTE_CHARS = 240;

/** Appended to a was/now line the cap cut, so no line merely appears to end. */
export const CITATION_TRUNCATION_MARKER = "… [line truncated]";

/**
 * The most basenames passed to one `git grep` invocation. Terms are chunked
 * at this width and the results unioned, so unlike the caps above this one
 * loses nothing and discloses nothing.
 */
export const MAX_GREP_TERMS = 96;
```

Every one of these values is currently unused as a numeral anywhere in `src/` or `test/`, which matters
because the plan registers the first four in `test/comment-contract.test.ts`'s `FORBIDDEN` set beside
`MAX_EVIDENCE` and friends. Registering a value forbids that numeral in **every** comment in the
repository, so a cap whose value collided with an existing comment's numeral would fail the guard test
in a file that has nothing to do with this feature. `MAX_GREP_TERMS` and `CITATION_TRUNCATION_MARKER` are
not registered: the first is a batch width no comment would restate, the second is not a number.

### Cap disclosure copy

Composed in `citations.ts`, delivered through `onNote` (below), phrased as reasons so they read
alongside the existing warnings:

```ts
export function citingFilesCappedNote(scanned: number, found: number): string;
export function citationsCappedNote(checked: number, found: number): string;
export function baselineReadsCappedNote(unchecked: number): string;
```

- `` `citation checking scanned ${scanned} of ${found} candidate files, so citations in the other ${found - scanned} were not checked` ``
- `` `citation checking stopped after ${checked} citations, so ${found - checked} further citation${s} in this repository ${were} not checked` ``
- `` `citation checking stopped reading historical file contents, so ${unchecked} citation${s} ${were} checked only for whether the cited file exists` ``

> **Correction (2026-08-24, ruled during implementation): a cap note must name its prefix.** The first two
> sentences above state their counts honestly but imply a spread the selection does not have. Candidates
> are taken in **path order**, so a cap takes an alphabetical prefix rather than a sample: measured on
> the reference repository, the file cap scanned 229 of 231 `docs/` files but only **88 of 507 TypeScript files**,
> cutting mid-directory — which is why none of that run's 153 findings came from source comments, even
> though the quoted-citation form is the one this codebase uses most. **[Refuted 2026-08-25: the clause
> from "which is why" onward is false, and "this codebase" silently changes repository mid-sentence. See
> the Finding immediately below.]** Each note that selects a prefix
> must say so, in the register of "the scan stops at that point in the path order rather than spreading
> across this repository". The selection algorithm is deliberately **unchanged**: making coverage
> representative is a behaviour change with its own design, ledgered as a follow-up with these
> measurements attached. A note that is honest about its count and silent about its shape is the same
> defect as a silent cap, one level up.

> **Finding (2026-08-24, measured after the correction above): the prefix is real, but it is not why
> source comments yield no findings.** The correction's disclosure ruling stands — a note that states a
> fraction must state its shape — but its causal clause was wrong, and wrong in a way that nearly bought a
> feature. Measured by calling `citationsIn` — this module's own entry point, no preprocessing — over
> every one of the reference repository's 747 candidate files rather than the 320 the cap admits, and beside urtext
> for contrast.
>
> **Measured at reference-repository revision `95d3e72`; urtext measured on this branch.** Naming it is not
> ceremony — the reference repository is under active development and these counts move under it. It listed 742
> candidates the day before this was written, and by `132c4aa` the following evening it listed 752,
> carrying 239 citations with **three** in `src/` (1.3%), and three past the cap rather than one. A block
> whose subject is measurement rigor, quoting counts with no revision attached, is the same defect one
> level up. The argument survives that drift, which is the reason to record it rather than restate the
> table: the cap still costs on the order of one percent of the citations, and the reference repository's `src/`
> still holds a rounding error's worth of them.
>
> | `docs/` / `src/` / elsewhere | the reference repository | urtext |
> |---|---|---|
> | Form A (path and line) | 231 / 1 / 1 | 14 / 1 / 2 |
> | Form B (path and quote) | 4 / 0 / 0 | 1 / 49 / 0 |
> | total citations | 237 | 67 |
> | of those, in `src/` | 1 — 0.4% | 50 — **74.6%** |
>
> The 427 files the cap skips hold **one** citation between them, out of 237 in the repository. The cap
> drops 57% of the candidate files and 0.4% of the citations, so a representative selection would have
> changed that run by a single citation. None of the 153 findings came from the reference repository's source
> comments because **the reference repository's source contains one citation**, not because the scan stopped before
> reaching it.
>
> The clause also conflated two repositories. "The quoted-citation form is the one this codebase uses
> most" is true of urtext — 50 citations in `src/`, 49 of them Form B, and **three quarters of its entire
> citation population** — and false of the reference repository, which has none. The check works on repositories that
> cite from code; the reference repository documents heavily and cites from prose, which is a property of that
> repository rather than a defect here.
>
> **A rejected follow-up, recorded so it is not proposed a second time.** Relaxing
> `CITATION_GUARD_SEPARATOR` to admit a bare filename that resolves to exactly one tracked file was
> designed and measured before being rejected. On the reference repository it admits 498 further citations in `docs/`
> against 20 in `src/` — more than tripling the population while moving the source share only from 0.4% to
> 2.8% — and 490 of the 524 it admits sit in dated plans, specs, and archived documents already judged
> unactionable. On urtext it admits eight, none in `src/`. It is a large change to the extractor and to the
> false-positive argument below, and it improves neither repository's finding list.
>
> > **Method correction (2026-08-25, after review).** The first two versions of this finding carried
> > different numbers — 240 and 299 citations, a 22.1% urtext source share, 515 admitted by the
> > relaxation — and every one of those was an artifact. They came from a scratch probe
> > that called `normalizeText` on each file *before* masking. `normalizeText` collapses every newline;
> > `maskFences` splits on newlines and `ts.createSourceFile` needs them. So fenced sample output was never
> > masked and counted as citations, and each TypeScript file arrived as a single line whose first `//`
> > swallowed the rest, turning test-fixture string literals into "comments". That invented urtext's 118
> > phantom `elsewhere` citations and the whole "this repository's tests cite the code they test" reading
> > built on them. The second version reconciled that table against its own percentage and re-asserted the
> > method in the same breath — a presentation defect repaired while the measurement defect underneath it
> > was ratified. **Every conclusion below survived the correction and the urtext contrast got stronger**,
> > which is exactly why the numbers went unchallenged for two commits: an argument that comes out right
> > is the hardest place to notice that the evidence is wrong.
> >
> > Two provenance notes, so this block does not overclaim in the other direction. The earlier "three
> > citations past the cap" is **not** on the artifact list above: it came from an ad-hoc `git grep`, not
> > from the probe, which computed no cap split at all — so it was never reproducible from the evidence
> > the finding carried, which is its own smaller defect. And the relaxation figures were measured over
> > the **line form only**; at least one of the admitted `docs/` citations is quote-form, so 498 is a
> > floor rather than an exact count. Neither moves the conclusion.
>
> **Consequence for the sweep-selection follow-up.** Making coverage representative remains correct — a
> prefix is not a sample, and on a repository whose citations are spread it would distort — but it is a
> mechanism fix whose measured effect on the repository that motivated it is near zero. It should be
> scoped and scheduled on that basis, not as a fix for this finding distribution.
>
> **And the product question it was blocking.** Whether citation checking wants a path-exclusion option
> is now a decision about repositories of that shape, whose citation mass genuinely is archived
> planning documents, rather than one resting on a biased count. urtext cannot infer which documents are
> archived; only their author can.

These land in `warnings`, which becomes `ReportModel.notes`, which trips the "This review is partial."
banner — correctly. A capped run genuinely did not check everything it was asked to.

## False-positive guards

Named, because each one is a class of finding that would otherwise arrive wearing a `verified` badge.

- **`CITATION_GUARD_SEPARATOR` — the path must contain a directory separator.** Structural, in both
  regexes, via the `(?:segment\/)+` group. Without it, ordinary prose supplies endless false citations:
  `Node.js:14`, `Fig.3:2`, a version string, a sentence ending in an abbreviation before a numbered list
  item. Each would resolve to no file and, absent the baseline gate, be reported as missing. The cost is
  that a citation written as a bare filename is not checked at all — an under-report, the correct
  direction. Relaxing this guard to admit a uniquely-resolving bare filename was measured and rejected on
  2026-08-24; the numbers are in the finding under "Cap disclosure copy".
- **`CITATION_GUARD_FENCE` — fenced code blocks are masked before extraction, in prose files.** Spans
  from a line matching `/^ {0,3}(?:```|~~~)/` through the next line closing that fence (same character,
  at least as long a run), inclusive, are blanked. A `path:line` inside a fence is sample output — this
  very repository's specs print `auth/session.ts:42` and `src/db.ts:14` inside terminal examples — and
  treating sample output as an assertion about the repository is the most common false positive
  available. Indented four-space blocks are deliberately **not** masked: they are indistinguishable from
  list continuations in this repository's prose, and the baseline gate already covers the illustrative
  ones.
- **`CITATION_GUARD_URL` — URL spans are masked before extraction.** Two patterns: any
  `scheme://non-space-run`, and a Markdown link destination `](...)`. `https://example.com/src/a.ts:12`
  is a link to another host, and its `path:line` tail says nothing about this repository. The regexes'
  lookbehind is a second line of defense, not a substitute: masking is what makes the intent explicit
  and testable.
- **`CITATION_GUARD_BASELINE` — the baseline gate**, described above. This is the guard that does the
  heaviest lifting, because it turns "a path that does not exist" from a finding into a silence.
- **`CITATION_GUARD_PHRASE` — a Form B quote must contain whitespace and fit `MAX_QUOTE_CHARS`.**
- **`REPORT_DIR` is never scanned**, so urtext's own output cannot feed itself.

## The analyzer

New file `src/analyze/citations.ts`. Joins the existing four in `ANALYZERS`, making five.

```ts
export interface CitationsOptions {
  /**
   * Check every citation in the repository rather than only those pointing
   * into files the reviewed range touched. Set by `--citations`.
   */
  sweep?: boolean;
  /**
   * Called once per cap that bit and once for unreadable history, with the
   * sentence the user is owed. An analyzer returns facts and nothing else, so
   * this is the only channel a disclosure has; `review` in `../cli.ts` passes
   * one that pushes into `warnings`. A caller that passes none gets the facts
   * and no indication anything was skipped — the same contract, and the same
   * hazard, as `runAnalyzers`'s `onFailure`.
   */
  onNote?: (note: string) => void;
}

export function makeCitationsAnalyzer(options?: CitationsOptions): Analyzer;

/**
 * The default-mode instance, and the member of ANALYZERS. Also the identity
 * `review` matches on when it swaps in a configured instance, so it must stay
 * a single shared value rather than being reconstructed per call.
 */
export const citationsAnalyzer: Analyzer = makeCitationsAnalyzer();
```

`makeCitationsAnalyzer` returns its analyzer through a **named** binding —

```ts
export function makeCitationsAnalyzer(options: CitationsOptions = {}): Analyzer {
  const citationsAnalyzer: Analyzer = async (changeset, ctx) => { /* ... */ };
  return citationsAnalyzer;
}
```

— because `runAnalyzers` reports a failed analyzer by `analyzers[i].name`, and an arrow returned
directly from a factory has no name. Without the named binding, a citation analyzer that threw would be
disclosed to the user as `analyzer #5`. The existing four get their names from exactly this mechanism
(NamedEvaluation of a variable declaration); this one has to do it one scope in.

`src/analyze/index.ts` gains the export and the array entry:

```ts
export { citationsAnalyzer, makeCitationsAnalyzer } from "./citations.js";

export const ANALYZERS: Analyzer[] = [
  effectsAnalyzer,
  guardsAnalyzer,
  surfaceAnalyzer,
  blastRadiusAnalyzer,
  citationsAnalyzer,
];
```

### Fact construction

Through `makeFact`, like every other analyzer — the location is derived from `evidence[0]`, never
passed.

```ts
makeFact({
  id: `citation_rot:${citingFile}:${citingLine}:${rot}`,
  kind: "citation_rot",
  detail: { rot, citedFile, citedLine, citedEndLine, quote, was, now, baseline, lineCount },
  evidence,
});
```

- **`id`** starts with the fact kind and a colon, which is the convention `subjectOf` in
  `src/report/model.ts` recovers the lens from. The citing location plus the rot kind is the identity: one
  citing line can carry two citations, and both may rot.
- **`qualifiedSymbol` is omitted.** A citation is about a file and a line, not a symbol. This also keeps
  citation facts out of `foldReach`, which matches on `(file, qualifiedSymbol)` — a citation fact must
  never absorb, or be absorbed by, a blast-radius fact that happens to share a file.
- **`evidence[0]` is the citing line** — `{ file: citingFile, line: citingLine, excerpt: <the trimmed
  citing text>, side: "after" }` — so `Fact.file`/`Fact.line` land on the prose the reader has to fix.
- **`evidence[1]`, when the cited file and line exist now**, is the cited location as it currently
  stands: `{ file: citedFile, line: citedLine, excerpt: <current text>, side: "after" }`. This is the
  "now" half of a drift, shown rather than asserted.
- **The baseline content is never an `EvidenceRef`.** `EvidenceRef.side` distinguishes the before and
  after sides of the *reviewed range*; the baseline is some other commit entirely, and a `side: "before"`
  ref carrying its line number would send a reader to a line in a revision the report never names. The
  baseline text lives in `detail.was` and in the finding body's prose, where the commit that produced it
  is named beside it.
- Evidence is capped at `MAX_EVIDENCE`, shared with the analyzers that sample it, though a citation fact
  never has more than two refs today.

## Types

`src/types.ts`, one new member:

```ts
export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed"
  | "export_added"
  | "export_removed"
  | "signature_changed"
  | "blast_radius"
  | "citation_rot";
```

Adding it is a compile error in two places by construction, both of which are the point: `WEIGHTS.factKind`
(`satisfies Record<Fact["kind"], number>`) and `SUBJECT_OF_KIND` in `src/report/model.ts`
(`satisfies Record<FactKind, Subject>`). A new kind cannot silently reach a report unweighted or
unclassified.

## Score

`src/score/index.ts`, one new weight:

```ts
// A rotted citation is a defect in the repository's account of itself, not in
// its behavior: nothing a reader merges is broken by it. So it sits above the
// kinds that report cost rather than a problem, and below the kinds that
// report new public surface or a regression. See `test/score/index.test.ts`.
citation_rot: 18,
```

The comment names the constant's neighbors by name and restates no value — the comment contract.

`scoreFact` needs no new branch: `citation_rot` falls through to `return base`, like `guard_removed` and
the export kinds. There is nothing to scale it by — a citation is rotted or it is not, and inventing a
severity for "how rotted" would be a judgment nothing here supports.

`minPossibleAnalyzerScore` is unchanged in value: the floor is `effect_removed` × `timing`, far below
this weight, so `MODEL_CEILING` in `src/score/reconcile.ts` does not move and no claim's score changes.
A test pins that, because a silent shift in `MODEL_CEILING` would re-rank every model finding in every
report for a reason no reader could see.

## Report model and lens routing

`src/report/model.ts`, three small edits and no renderer restructuring.

```ts
export type Subject = "effect" | "guard" | "surface" | "reach" | "citation";

const SUBJECT_OF_KIND = {
  // ... unchanged entries ...
  citation_rot: "citation",
} satisfies Record<FactKind, Subject>;

const LENS_OF_SUBJECT: Record<Subject, Lens> = {
  effect: "effects",
  guard: "effects",
  surface: "surface",
  reach: "narrative",
  citation: "narrative",
};
```

**The lens is `narrative`.** A rotted citation is not an effect, not a guard, and not a change to the
public surface; it belongs to the account of what this change did, which is what the narrative is. The
narrative shows every finding regardless of lens, so nothing is hidden by this routing.

The subject is its own member rather than a reuse of `reach` because the HTML's effects pane filters on
`subject` directly (`f.subject === "effect"`, `"guard"`, `"surface"`), and folding citations into `reach`
would make that pane's note — which describes a reach finding as "a changed export with callers" —
describe something it is not.

**One existing sentence changes, and that is the whole renderer diff.** `effectsLens` in
`src/report/html.ts` prints a note enumerating what the pane does not show; it names two kinds today and
its comment records that naming only one had already misled a reader once. A third kind arriving without
a clause would make that sentence false in urtext's own voice, in the one place the tier badges do not
reach. So the sentence gains a clause naming citation findings and where they are. No new pane, no new
lens, no new section, no reordering, no new field on `FindingView`, and no change to the terminal,
Markdown, or PDF walkers at all: a `citation_rot` finding renders through the existing headline, body,
and evidence machinery on all four surfaces, and `--json` carries it as one more `Finding`.

## CLI

`src/cli.ts`:

```ts
export interface CliOptions {
  // ... unchanged fields ...
  /**
   * Sweep every citation in the repository rather than only those pointing
   * into changed files. Optional like `open` and `exportFormats`: every
   * pre-existing caller constructs a `CliOptions` literal without it.
   */
  citations?: boolean;
}
```

Parsed beside `--open`, with no value: `else if (arg === "--citations") opts.citations = true;`.

`USAGE` gains one entry, in the existing column layout:

```
  --citations Check every path:line citation in this repository, not only the
              ones pointing into files this range touched
```

The configured instance is swapped in by identity, which keeps the `analyzers` parameter's existing
default and every test that passes its own list working untouched:

```ts
const runnable = analyzers.map((a) =>
  a === citationsAnalyzer
    ? makeCitationsAnalyzer({
        sweep: opts.citations === true,
        onNote: (note) => warnings.push(note),
      })
    : a,
);
const facts = await runAnalyzers(changeset, ctx, runnable, (f) => { /* unchanged */ });
```

A test that passes a hand-built analyzer list contains no `citationsAnalyzer` and so is unaffected — the
map is a no-op for it. The disclosure channel is the same `warnings` array every other shortfall uses,
which becomes `ReportMeta.warnings`, then `ReportModel.notes`, printed as `Note:` lines on every surface
and emitted verbatim in `--json`. No new key anywhere.

`--citations` is independent of `--no-llm`: citation checking is deterministic and runs in both.

## Unchanged, stated explicitly

- **The exit-code matrix.** `allAnalyzersFailed` compares `failureCount` against `analyzers.length`,
  which is now five; nothing else about the rule changes. A capped citation run, an unreadable blame, and
  a repository with no citations at all are all exit 0.
- **`MODEL_CEILING`, `MIN_STANDALONE_REFERENCES`, and every reconcile invariant.** A claim never edits a
  fact; a dangling `correspondsTo` is dropped whole; no claim renders as `verified`.
- **`foldReach`, `groupAddedExports`, `groupSignatureChanges`.** Citation facts carry no
  `qualifiedSymbol` and no matching id prefix, so no grouping or absorption pass sees them.
- **The interpretation stage.** Citation facts reach the prompt as ordinary facts, subject to the
  existing `MAX_FACTS` cut, and a model may explain one exactly as it may explain any other. No new
  instruction, no schema change.
- **Concealment.** Cited paths, excerpts, and quoted phrases all flow through the existing
  `labelConcealed` / `segmentConcealed` machinery in `buildReportModel`, like every other analyzer's
  strings. A path containing a concealing character needs no new defense.
- **Every existing test expectation.** No existing expected string changes, other than the single
  effects-pane sentence named above.

## Testing

In the house style: what a plan's tests must pin, not how. Against real fixture repositories with known
histories wherever history is involved — a fixture written to match the parser cannot notice the parser
changing.

- **Extraction** (`test/analyze/citations.test.ts`): Form A matches a path with a line and a path with a
  range, and captures the path, start, and end; Form B matches a backticked path followed by a quoted
  phrase, including a phrase that wrapped across ` * ` comment lines in the source; a single-word quote
  is rejected; a phrase over `MAX_QUOTE_CHARS` is rejected; a bare filename with no separator is not a
  citation; `fact.ts:45` is not matched inside `fact.ts:456`.
- **Comment scanning**: a citation in a `//` comment, in a JSDoc block, and in a same-line trailing
  comment are all found; a `path:line` inside a string literal is not; the reported citing line is the
  line the path sits on for a citation whose quote wraps across three comment lines — the offset map,
  pinned directly.
- **Each of the four rot kinds, one test each**, built by actually moving code in a fixture repository
  and committing: a cited file deleted after the citing line was written; a citation to a line past a
  file that got shorter; a quoted phrase reworded out of the cited file; a cited line whose content
  changed. Each asserts the fact kind, the `detail.rot` discriminator, the anchor on the **citing** line,
  and — for drift — the `was`/`now` pair.
- **The baseline gate, both directions.** A citation that never resolved (the cited file did not exist at
  the citing line's blame commit either) produces **no fact**, for each of (a), (b), and (c). This is the
  most important test in the suite: it is the one standing between a `verified` badge and every
  illustrative path in this repository's own specs.
- **The blame baseline including the under-report case.** A fixture where the cited content drifted, and
  *then* the citing line was touched by an unrelated edit, produces **no fact** — the documented,
  intended miss. The test's name says so, so nobody later "fixes" it.
- **The uncommitted-baseline path**: a citing line that is not committed yet produces no fact and **no
  note** — an absence of history is not a degradation.
- **The degradation path**: a blame failure leaves existence-only checking (test (a) runs, tests (b),
  (c), (d) do not) and emits `blameUnavailableNote` exactly once with the right count, whatever the
  number of affected citations.
- **Cap disclosure**: each of `MAX_CITING_FILES`, `MAX_CITATIONS_CHECKED`, and `MAX_BASELINE_READS`,
  driven over its edge, emits its note through `onNote` with counts that add up; a run under every cap
  emits none. A capped run is deterministic — the same files, in path order, twice.
- **Default mode does not check a citation into an unchanged file.** A fixture whose prose carries a
  provably rotted citation into a file the range never touched: default mode produces no fact for it,
  `--citations` produces one. One test, both assertions, so the mode boundary cannot half-move.
- **False-positive guards, one test each and each named for its guard**: a `path:line` inside a fenced
  code block is not a citation; the same text outside the fence is; a `path:line` inside an
  `https://` URL is not a citation, nor is one inside a Markdown link destination; a bare
  `Something.js:14` in prose is not a citation; nothing in `.urtext/` is scanned.
- **Copy guard**: rendering all four surfaces from a fixture model containing one finding of each rot
  kind, and asserting that "wrong", "incorrect", "outdated", "stale", "obsolete", "misleading",
  "broken", and "lies" appear in none of them. The fixture's own strings are chosen neutral so a hit is
  provably urtext's copy.
- **Score** (`test/score/index.test.ts`): a `citation_rot` fact scores `WEIGHTS.factKind.citation_rot`
  with no scaling; `minPossibleAnalyzerScore()` is unchanged by the new kind, and therefore so is
  `MODEL_CEILING`.
- **Model** (`test/report/model.test.ts`): a `citation_rot` finding's `FindingView.subject` is
  `"citation"` and its `lens` is `"narrative"`; the existing "every id a real analyzer produces starts
  with its own fact kind" test covers the new analyzer once it is in `ANALYZERS`.
- **All four surfaces**, one test each via the established per-surface pattern — terminal, HTML, and
  Markdown by string assertion, PDF by `unpdf` text extraction: a model containing one citation finding
  renders its headline, its body, and both evidence refs, and the HTML's effects-pane note names citation
  findings.
- **CLI** (`test/cli.test.ts`): `--citations` parses; an unknown `--citation` still errors; a cap note
  surfaces as a `Note:` line and in `--json`'s `warnings`; a run with no citations surfaces neither.
- **Comment contract**: `test/comment-contract.test.ts` stays green with `citation_rot`'s weight and the
  three disclosed caps registered in `FORBIDDEN`, and no comment this feature adds restates a guarded
  value.
- **Mutation checks named in the plan**: deleting the baseline gate must fail the never-resolved test;
  deleting the fence mask must fail the fenced-block test; deleting the separator requirement must fail
  the bare-filename test; deleting the blame memoization must fail a call-count assertion; deleting the
  named binding inside `makeCitationsAnalyzer` must fail a test asserting the failure message names
  `citationsAnalyzer`.
- Every behavior change lands with a test that fails before it.

## Global constraints (carried from the project)

- No claim ever renders as `verified`; model prose never renders without attribution; the concealment
  defense applies to every surface; empty-lens copy is filter-shaped; urtext writes only inside
  `.urtext/`.
- **Comment contract:** comments name constants, never restate values. Two hazards this feature
  introduces, both avoidable and both named so the plan does not trip them. First, **the guarded set
  already contains the value one** (`WEIGHTS.effect.network`), so a comment describing a regex quantifier
  or a bound must not spell its digits — describe the shape in words and name the constant, exactly as
  the regex descriptions in this document do. Second, **registering a new cap forbids its numeral in
  every comment in the repository**, which is why every value in "Named caps" was chosen from numerals
  that appear nowhere in `src/` or `test/` today.
- Invariant claims quote their enforcing test verbatim, in the style the existing modules already use.
- **No new runtime dependency.** Blame and grep go through the existing `git()` helper in
  `src/extract/git.ts` — same locale pinning, same buffer cap, same failure semantics. File reads go
  through `AnalysisContext.readAt`. Comment parsing uses the `typescript` package already in use.

## Out of scope

- **Auto-fixing a citation.** No rewrite, no `--fix`, no suggested line number, no "did you mean". urtext
  knows a citation stopped resolving; it does not know where the content went, and a `verified` badge on
  a guess is the exact failure this project exists to avoid.
- **URLs.** A link to another host is not a citation of this repository's source, cannot be checked
  against a commit, and is masked out before extraction rather than followed. No network access is added
  by this feature.
- **Cross-repository references.** A citation into a sibling checkout, a monorepo package outside this
  git root, or a path in a dependency. Everything checked here resolves inside one repository at one
  revision.
- **Non-git sources.** No filesystem walk outside `git ls-files` / `git grep`, no untracked files, no
  ignored files, no reading a citation's target over the network or out of a package registry.
- **Any new render surface.** No new lens, no new pane, no new section, no new export format, no new
  `--json` key, no badge. A citation finding is a `Finding` like any other and travels the surfaces
  already built for one.
- **Bare-path citations.** A path with neither a line nor a quoted phrase asserts nothing testable, and
  admitting it would flood every review with references to files that merely exist.
- **Citation history across runs.** No record of which citations rotted in an earlier review, and no
  trend.
