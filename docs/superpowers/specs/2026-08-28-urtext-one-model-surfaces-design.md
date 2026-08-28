# One model, four walkers — design

**Date:** 2026-08-28
**Status:** proposed
**Supersedes nothing.** Extends `2026-08-19-urtext-export-model-design.md`, whose
addendum rulings all survive this change; ruling 3 is re-sited, not overturned.

## The problem

`src/report/model.ts` opens by promising that everything a surface may say about
content "is decided here, once; a renderer applies format mechanics and its own
phrasing of the same truth, never a decision of its own."

Two of the four surfaces do not take a model. `renderMarkdown(model)` and
`renderPdf(model)` do; `renderTerminal(changeset, findings, reportPath?,
warnings, model?, suppressed, citationSweep)` and `renderHtml(changeset,
findings, meta)` build their own internally. The consequences, all present in
`main` today:

1. **A run builds the report model four times** — inside `renderHtml`
   (`cli.ts:453`), as `exportModel` (`cli.ts:498`), as `jsonModel`
   (`cli.ts:552`), and inside `renderTerminal` (`cli.ts:626`) — each from a
   separately written `ReportMeta` literal carrying the same four fields.
   A new model input has to be added in four places.

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

Point 1 is the one with a record. `citationSweep` had to be threaded through
every path separately; `kindNotes` reached three surfaces and missed `--json`;
the finding band was derived in two places and the copies disagreed. Each is
the same shape: one truth, assembled more than once.

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

**The timing rule:** a surface's model is built at the last moment before that
surface is produced, so that it carries every disclosure known by then. Three
moments survive:

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
   * The changeset this model describes. NOT report content: the model still
   * omits symbols by design (2026-08-19 addendum, ruling 3), and the one
   * legitimate reader is the HTML surface pane's symbol table, which applies
   * concealment renderer-side exactly as it does today.
   *
   * Carried rather than passed alongside so that a surface needing the raw
   * inventory cannot be handed one belonging to a different range: a report
   * whose symbol table and findings describe different changes is precisely
   * the silent disagreement this project exists to prevent, and `renderHtml`
   * taking `(model, changeset)` would make it expressible.
   */
  source: Changeset;
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

`surfaceLens` in `html.ts` takes `model.source` where it takes `changeset`
today. Its concealment handling, its `visible()` calls, and the addendum's
ruling 3 are untouched.

### 3. `cli.ts` owns every build, through one assembler

```ts
const metaFor = (over: Partial<ReportMeta> = {}): ReportMeta => ({
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

**Out of scope, deliberately:** the `.gitignore` tip stays in `cli.ts`. It is
advice about the user's repository, not a statement about the review, and it
depends on an async git query made after rendering. It is documented as such
where it stays.

## What this does not change

- No disclosure gains or loses a surface. Every sentence printed today is
  printed after, in the same place, by the same rule.
- Ruling 3 stands: symbols remain changeset data, read from `model.source`,
  concealed renderer-side.
- `buildReportModel`'s own signature.
- The `--json` object, including the `kindNotes` key added on 2026-08-27.

## Testing

**The timing rule gets a test.** A review whose report write fails asserts that
the terminal discloses the failure and the `--json` warnings carry it, while the
surfaces produced before the failure cannot. This is the assertion that stops a
future "simplification" from collapsing the three builds into one and silently
dropping a disclosure — the failure mode this spec exists to prevent, which
would otherwise pass the whole suite.

**Every existing surface test keeps its subject.** 109 test call sites move to
building a model first — every `renderHtml` call (66) and every `renderTerminal`
call (43), including the 26 terminal calls that pass only two arguments today
and so would survive a signature that merely collapsed the positional tail.
That count is the price of closing the second door, and it is the honest
argument for the cheaper option this spec rejects. To keep the rewrite
mechanical rather than inventive, each surface test file gets one local helper:

```ts
const model = (findings: Finding[], over: Partial<ReportMeta> = {}) =>
  buildReportModel(changeset, findings, { warnings: [], ...over });
```

A call site's meaning changes only where it was passing something; the risk to
watch is a rewrite quietly dropping a meta field, which is a per-task review
point rather than something `tsc` can catch.

**A test pins that the terminal prints export paths from the model**, since that
copy moves between files and could otherwise vanish with nothing objecting.

## Risks

| Risk | Handling |
|---|---|
| A mechanical rewrite drops a meta field from a fixture | Task boundaries keep each file's rewrite reviewable; the diff is read for meta content specifically, not just for compilation |
| `model.source` invites surfaces to read changeset data freely | The field's comment names its one legitimate reader; `renderHtml` remains the only file that touches it |
| The terminal's output changes shape when the path loop moves | The moved lines are byte-identical and ordered as today; existing terminal tests cover the "Full report:" line, and a new one covers the export lines |
| Three builds still look redundant to a future reader | The timing table is in the code as comments at each site, and the rule has a test |

## Open question for review

`ReportModel.source` widens the model with something explicitly labelled "not
report content". The alternative is `renderHtml(model, changeset)`, which keeps
the model narrow at the cost of making a mismatched pair expressible. This spec
takes the wider model because an unenforceable pairing invariant in a tool whose
purpose is preventing silent disagreement is the worse trade — but it is the
one judgement here that a reviewer should push on.
