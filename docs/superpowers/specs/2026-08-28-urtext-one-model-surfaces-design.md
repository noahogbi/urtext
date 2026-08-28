# One model, four walkers — design

**Date:** 2026-08-28
**Status:** proposed — revised 2026-08-28 after review (see "Revisions" at the end)
**Extends** `2026-08-19-urtext-export-model-design.md` and **supersedes its
addendum ruling 3** (the HTML symbol table reads the changeset directly). The
replacement ruling is stated in §1.

## The problem

`src/report/model.ts` opens by promising that everything a surface may say about
content "is decided here, once; a renderer applies format mechanics (escaping,
wrapping, typesetting) and its own phrasing of the same truth, never a decision
of its own."

Two of the four surfaces do not take a model. `renderMarkdown(model)` and
`renderPdf(model)` do; `renderTerminal(changeset, findings, reportPath?,
warnings, model?, suppressed, citationSweep)` and `renderHtml(changeset,
findings, meta)` build their own internally. The consequences, all present in
`main` today:

1. **The report model is built in four places** — inside `renderHtml`
   (`cli.ts:453`), as `exportModel` (`cli.ts:498`), as `jsonModel`
   (`cli.ts:552`), and inside `renderTerminal` (`cli.ts:626`) — each from a
   separately written `ReportMeta` literal carrying the same four fields.
   A new model input has to be added in four places. At most three of those
   run in any one review: `--json` returns at `cli.ts:558`, before the terminal
   path, and `--stdout md --json` is refused at parse time (`cli.ts:251`).

2. **The terminal grew a seventh positional parameter** rather than the field
   it wanted. `citationSweep` is threaded as a bare boolean, and the parameter
   list carries a comment admitting the shape is wrong and deferring the fix:
   "Converting this signature is the right fix and belongs to a change about
   signatures, not to one adding a disclosure." This is that change.

3. **Report content is composed in the controller.** `cli.ts:639-642` appends a
   labelled path line per written export to the string the terminal walker
   returned. That is surface copy — the same class as the "Full report:" line
   the walker itself prints, decided in the wrong file.

4. **A test cannot hand a surface the model it just asserted on.** From
   `test/report/model.test.ts`: "The terminal takes findings, not a model, so
   it gets the same two." The fixture is built twice and the two copies are
   trusted to match.

Point 1 is the one with a record — but the three incidents usually cited
together are not one shape, and this design closes only one of them. Stating
that plainly, because a motivation that overclaims is how a change gets
credited with a guarantee it never provided:

| Incident | Shape | Closed here? |
|---|---|---|
| `citationSweep` threaded separately down every path | one input, assembled more than once | **Yes** — one assembler, three sites, one file |
| `kindNotes` reached three surfaces and missed `--json` | a surface that is not a walker | **No** — see below |
| the finding band derived in two places, disagreeing | one truth, derived twice | **Partly** — the surviving instance is fixed here |

`--json` composes its object field by field from raw locals (`cli.ts:559-619`),
reading only `kindNotes` and `distributionNote` from a model. It cannot simply
become a walker: its `warnings` are deliberately raw where the model's `notes`
are labelled, and its shape is a published contract. So a new `ReportModel`
field will still reach three walkers and miss `--json` unless someone
remembers — and this spec's §"What this does not change" pins that object as
unchanged, which makes the gap explicit rather than accidental.

Two things close it as far as it can be closed. `--json` reads
`jsonModel.counts` instead of recomputing them at `cli.ts:537-538` (identical
output, one derivation — the band-map shape, in the same run, surviving after
this change). And a keys-accounting guard, in the house style of
`test/comment-contract.test.ts`: every `ReportModel` key must appear in the
`--json` composition or on an exemption list that states why. A field added
without a decision then fails a test instead of reaching a reader on three
surfaces out of four.

## The constraint that shapes the fix

The obvious repair — build one model, hand it to everybody — is wrong, and the
reason is a property worth keeping.

`warnings` is still being appended after the HTML is rendered. "Could not write
the report" (`cli.ts:467`), "could not write the md/pdf export" (`cli.ts:527`),
"could not render the md review for stdout" (`cli.ts:512`) all describe events
that happen *after* the HTML model exists. A single model built early would
silently stop the terminal disclosing write failures. A single model built late
cannot render the HTML that the write is writing.

So the four builds are not sloppiness. They are moments — each surface's model
carries what was honestly known when that surface was produced. The fix is to
make that rule explicit and enforced instead of accidental, while removing every
*other* reason a second model gets built.

**The timing rule, stated per moment rather than per surface:** the model for a
batch of surfaces is built at the last point before that batch is produced, and
carries every disclosure known then. Not "the last moment before each surface",
which the design does not deliver and should not claim: under `--export md,pdf`
a failure writing the md export postdates the shared model, so the PDF —
produced after that failure — does not carry it. That is current behaviour and
stays. Three moments survive:

| Moment | Surfaces | Can disclose |
|---|---|---|
| Before the report write | HTML | everything the analysis produced |
| After the report write, before the exports are written | Markdown, PDF | the above, plus a failed report write |
| After the exports are written | `--json`, terminal | the above, plus failed exports and the paths of what was written |

An export cannot report a failure to write itself — it is already rendered by
then — which is why the second moment exists at all rather than folding into
the third.

## The design

### 1. `ReportModel` gains what a surface legitimately needs

```ts
export interface ReportMeta {
  model?: string;
  warnings: string[];
  suppressed?: number;
  citationSweep?: boolean;
  /** Where the HTML report was written, absent when none was. */
  reportPath?: string;
  /** Paths of the exports that were written, in request order. */
  exportPaths?: { format: "md" | "pdf"; path: string }[];
}

export interface ReportModel {
  // ...existing fields unchanged...
  /**
   * The exported declarations the HTML surface pane tabulates — the five
   * fields `surfaceLens` reads today, and nothing else from the changeset.
   * Concealed here like every other model field, which is what lets the
   * whole model stay clean (see the ruling below).
   */
  surfaceSymbols: {
    /**
     * Kept as the union it already is, not segmented: it is a controlled
     * vocabulary this project writes, not text a change's author supplied,
     * and the HTML uses it for a class name (`sym-${change}`) as well as
     * copy. Segmenting it would invite a walker to treat the class name as
     * concealable text.
     */
    change: "added" | "modified" | "removed";
    qualifiedName: ConcealSegment[];
    kind: ConcealSegment[];
    file: ConcealSegment[];
  }[];
  /** `labelConcealed` applied, as the terminal applies it today. */
  reportPath?: string;
  /**
   * Always present, empty included — the rule `kindNotes` and `--json`'s
   * `coverage` already follow, so a walker iterates without branching.
   * Absent-or-present is reserved for `reportPath`, where "no report was
   * written" is a state a surface says something about.
   */
  exportPaths: { format: "md" | "pdf"; path: string }[];
}
```

`reportPath` and `exportPaths` arrive labelled, because concealment happens in
the model. The terminal's comment that the path "is the one string on this
surface that does not come from the model, so the walker labels it itself"
becomes false and is deleted with the behaviour it described.

**Ruling (supersedes the 2026-08-19 addendum's ruling 3).** The symbol table's
data enters the model, concealed there like everything else. Ruling 3 justified
the exception on the ground that "symbols are changeset data, not report
content" — but the table is rendered to the reader, so the distinction was
pragmatic rather than principled, and it cost the project its only
renderer-side concealment path (`visible` in `html.ts`, used at lines 382-384
and nowhere else).

Two alternatives were weighed and both lose. Passing `renderHtml(model,
changeset)` makes a mismatched pair expressible — a report whose symbol table
and findings describe different ranges — which is the silent disagreement this
project exists to prevent. Carrying `source: Changeset` on the model prevents
that, but breaks something load-bearing: `test/report/model.test.ts:249`
enforces "no raw concealing character survives into the model" by
`JSON.stringify`-ing the *whole* model and searching it, and its fixture plants
a raw RLO in the range label and a file path. A raw changeset inside the model
fails that assertion on the existing fixture — so `source` would have traded a
mechanically enforced invariant for a comment, and would have required
weakening the test that enforces it. Promoting the five fields instead keeps
the invariant total and makes that test *stronger*, since it now covers symbol
text too.

`visible`, and the header paragraph naming the exception, are deleted.

### 2. Every renderer takes exactly the model

```ts
export function renderTerminal(model: ReportModel): string;
export function renderHtml(model: ReportModel): string;
export function renderMarkdown(model: ReportModel): string;
export function renderPdf(model: ReportModel): Promise<Buffer>;
```

No wrapper overloads. A convenience form that still accepts `(changeset,
findings, meta)` would preserve the second door this change exists to close,
and every call site that kept using it would be a place a future field can be
forgotten.

`surfaceLens` in `html.ts` walks `model.surfaceSymbols` and renders each field
through the same segment path every other model string already takes, so the
symbol table gains nothing and loses its private concealment route.

**One format rule has to move with the signature.** `terminal.ts:149` gates a
separating blank line on the raw `warnings` parameter — analyzer warnings get
the line, the untracked and coverage notes alone do not. `buildReportModel`
merges warnings and the untracked note into one `notes` array on the stated
ground that "they are one thing to a reader", so a walker holding only the
model cannot make that distinction, and widening the model to restore it would
contradict the merge. **Ruling:** the gate becomes `m.notes.length > 0`. A run
whose only disclosure is the untracked note gains one blank line between that
note and the findings. This is a layout divergence, not a content one — no
sentence appears, moves, or disappears — and it is accepted here in the same
spirit as the addendum's ruling 2. A test pins the new rule, since nothing
pins the old one.

### 3. `cli.ts` owns every build, through one assembler

```ts
// Only the two fields a later moment learns may be overridden. A wider type
// would let one moment quietly pass different `warnings` or a different
// `citationSweep` than another — reopening, inside the one file meant to
// close it, exactly the door this change exists to shut.
const metaFor = (
  over: Partial<Pick<ReportMeta, "reportPath" | "exportPaths">> = {},
): ReportMeta => ({
  model: result.model,
  warnings,
  suppressed,
  citationSweep: opts.citations === true,
  ...over,
});
```

`warnings` is the live array, so a model built later sees what was pushed since.
Three call sites build models, one per moment in the table above, each with a
comment naming what that moment can honestly know. `--json` and the terminal
share the third-moment model — they are alternatives in one run, never both.

### 4. The terminal prints its own paths

The export-path loop leaves `cli.ts` and becomes part of the terminal walker,
beside the "Full report:" line it already prints, reading `model.exportPaths`.

**Out of scope, deliberately:** the `.gitignore` tip stays in `cli.ts`, and the
reason is documented where it stays — see "What this does not change".

## What this does not change

- No disclosure gains or loses a surface. Every sentence printed today is
  printed after, in the same place, by the same rule. The one accepted
  divergence is a blank line, ruled on in §2.
- `buildReportModel`'s own signature.
- The `--json` object's shape, apart from `counts` now being read from the
  model rather than recomputed — byte-identical output.
- The `.gitignore` tip stays in `cli.ts`, on one ground only: it is advice
  about the user's repository, not a statement about the review. (The second
  ground I first gave — that it needs an async git call after rendering — does
  not hold: it could be awaited before the moment-3 build. Content is the
  reason; timing is not.)

## Testing

**The timing rule gets a test, through the seam that already exists.** The
obvious sketch — fail the report write, assert the HTML cannot mention it —
is unobservable: when `writeReport` throws, the rendered HTML string is
discarded inside it and no test can read it. The enforceable version uses
`review()`'s injectable `exporters` parameter (`cli.ts:318`), which exists for
exactly this: inject a throwing `md` exporter, ask for `--export md,pdf`, and
assert the written PDF does **not** carry the md-failure warning while the
terminal and `--json` do. That discriminates moment 2 from moment 3 with real
output on both sides. A second case pins moment 1 against moment 2: with
`--stdout md` and a failing report write (`.urtext` made a plain file, as
`test/cli.test.ts:803` already does), the Markdown on stdout carries the
write failure that no HTML exists to carry.

Together these stop a future "simplification" from collapsing the builds into
one and silently dropping a disclosure — which would otherwise pass the whole
suite.

**Every existing surface test keeps its subject.** 109 test call sites move to
building a model first — every `renderHtml` call (66) and every `renderTerminal`
call (43), including the 26 terminal calls that pass only two arguments today
and so would survive a signature that merely collapsed the positional tail.
That count is the price of closing the second door, and it is the honest
argument for the cheaper option this spec rejects. To keep the rewrite
mechanical rather than inventive, each surface test file gets one local helper:

```ts
// The changeset is the first parameter, never closed over: roughly a fifth of
// the call sites pass a fixture other than the file's default — `noSymbols`,
// `deletionOnly`, `{ ...changeset, untrackedCount: 2 }`, an inline literal, or
// the result of a real `extract()`.
const model = (cs: Changeset, findings: Finding[], over: Partial<ReportMeta> = {}) =>
  buildReportModel(cs, findings, { warnings: [], ...over });
```

A helper that closed over one changeset would institutionalize the exact
silent-rewrite this table warns about: `renderTerminal(deletionOnly, [])`
becomes `model([])`, the fixture's changeset is quietly replaced by the file
default, `tsc` is satisfied, and any assertion not keyed to the changeset keeps
passing while testing something else. Making the changeset explicit at every
site turns that into a visible, reviewable argument.

The remaining risk is a rewrite dropping a meta field, which is a per-task
review point rather than something `tsc` can catch.

**A test pins that the terminal prints export paths from the model**, since that
copy moves between files and could otherwise vanish with nothing objecting.

## Risks

| Risk | Handling |
|---|---|
| A mechanical rewrite drops a meta field, or silently swaps a fixture's changeset | The helper takes the changeset explicitly (see Testing); task boundaries keep each file's rewrite reviewable; the diff is read for meta content, not just for compilation |
| Concealing the symbol table in the model changes what the HTML emits for a symbol containing a concealing character | It should not — `visible` and the model's segment path label the same code points — but nothing pins symbol-table concealment today, so a test is added before the move |
| The terminal's output changes shape when the path loop moves | The moved lines are byte-identical and ordered as today; existing terminal tests cover the "Full report:" line, and a new one covers the export lines |
| Three builds still look redundant to a future reader | The timing table is in the code as comments at each site, and the rule has a test |
| `--json` keeps its own composition, so a new model field can still miss it | The keys-accounting guard fails the build instead; the exemption list carries a reason per key |

## Revisions

Reviewed 2026-08-28 before any code was written. Six corrections, all folded in
above:

1. **The central design was wrong and is replaced.** The first draft carried
   `source: Changeset` on the model. That breaks
   `test/report/model.test.ts:249`, which enforces model cleanliness by
   stringifying the whole model — its fixture plants a raw RLO in the changeset.
   Shipping it would have meant weakening that test to make the change pass.
   The replacement (a concealed `surfaceSymbols` view, ruling 3 superseded
   openly) is better than either option the draft weighed: it closes the
   pairing hazard, keeps the invariant mechanically enforced, and deletes the
   project's last renderer-side concealment path.
2. **"A run builds the model four times" was false** — four sites, at most
   three builds in one run, since `--json` returns before the terminal.
3. **The timing rule was stated per surface**, which the design does not
   deliver; restated per moment, with the case it does not cover named.
4. **The proposed timing test was unobservable**; replaced with one built on
   the `exporters` seam that already exists for it.
5. **The motivation overclaimed.** Of the three incidents it cited, this design
   closes one, partly closes one, and leaves `--json`'s open — now said out
   loud, with a keys-accounting guard proposed to close it as far as it goes.
6. **The test helper hid the changeset**, which is the one thing a fifth of the
   call sites vary; it now takes it explicitly.
