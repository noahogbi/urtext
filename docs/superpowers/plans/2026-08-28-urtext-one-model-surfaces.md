# One Model, Four Walkers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every renderer takes exactly one argument — the report model — and `cli.ts` becomes the only place a model is built.

**Architecture:** `buildReportModel` gains the two things a surface legitimately needs and cannot derive (the exported-symbol view the HTML tabulates, and the paths of what was written). `renderTerminal` and `renderHtml` stop building models internally and stop taking raw pieces, joining `renderMarkdown` and `renderPdf`, which already take a model. `cli.ts` builds the model at three named moments through one meta assembler, and a test enforces that those moments cannot be collapsed.

**Tech Stack:** TypeScript (ESM, `tsc --noEmit` only — no bundler), vitest, pdfkit (dynamic import), unpdf (tests).

**Spec:** `docs/superpowers/specs/2026-08-28-urtext-one-model-surfaces-design.md` — read it first; it argues every decision below and records the six corrections a review made to its first draft.

## Global Constraints

- **Gates before every commit, each run separately and judged on its own exit code:** `npx vitest run` (bare, never through a pipe — a pipe reports the *pipe's* exit code), `npx tsc --noEmit`, and a NUL-byte check over the staged files with a positive control.
- **Every test title must be answerable:** "could this pass if the thing its name promises were broken?" If yes, the title or the assertions are wrong. This has been caught ten times on this project.
- **Every test title must be unique within its file** — `test/comment-contract.test.ts` enforces it, and it fired twice during the previous change.
- **No bare small integer in a comment that collides with a `WEIGHTS` value** — same guard file. Spell such numbers as words.
- **Worktree files are CRLF on disk.** Scripted patches must account for it; prefer the Edit tool.
- **After writing a `\uXXXX` escape into any file, byte-check that file** — the editing
  tool has twice round-tripped the escape back into the raw character it stands
  for, once in this plan and once in a test file. Writing the escape is not
  enough; verify it survived:
  `python -c "print([hex(ord(c)) for c in open('PATH',encoding='utf-8').read() if ord(c) in (0x202E,0x200B)])"`
  If it did not, rewrite that byte range with Python rather than the editor.
- **Never `git checkout -- <file>` to undo an experiment** on a file carrying uncommitted work — it discards the work too. Mutate in a `git archive` scratch copy.
- **Do not weaken a test to make a change pass.** If an assertion blocks the change, that is a finding to report, not an obstacle to remove. Where this plan deliberately changes an assertion, it says so and says why.
- Concealment happens in the model, never in a renderer. After Task 3 no renderer contains a concealment path at all.

## File Structure

| File | Responsibility after this change |
|---|---|
| `src/report/model.ts` | The only place a model is built; gains `surfaceSymbols`, `reportPath`, `exportPaths` |
| `src/report/html.ts` | Walker. Takes a model. No `visible`, no changeset |
| `src/report/terminal.ts` | Walker. Takes a model. Prints report and export paths from it |
| `src/report/markdown.ts` | Unchanged |
| `src/report/pdf.ts` | Unchanged |
| `src/cli.ts` | Builds every model, at three moments, through one `metaFor` |
| `test/report/*.test.ts` | Call sites move to building a model first, via a per-file helper that takes the changeset |
| `test/cli.test.ts` | Gains the two timing tests and the `--json` keys guard |

---

### Task 1: One meta assembler in `cli.ts`

No signature changes and no behaviour change — this task exists so the three meta literals become one before any signature moves.

**Files:**
- Modify: `src/cli.ts:453`, `:498`, `:536-538`, `:552`, `:626`
- Test: `test/cli.test.ts` (existing suite must stay green; no new test)

**Interfaces:**
- Consumes: nothing new
- Produces: `metaFor()` local to `review()`, used by every model build in the file. It gains its `Partial<Pick<ReportMeta, "reportPath" | "exportPaths">>` override in Task 5, where the first caller passes one

- [ ] **Step 1: Add the assembler above the first build site**

Place it immediately before the `if (exitCode === 0) {` block that starts at `cli.ts:445`:

```ts
  // Every model this run builds comes through here, so a new model input is
  // added once rather than in four places — which is how `citationSweep`
  // ended up threaded down each path separately, and how `renderTerminal`
  // grew a seventh positional parameter to carry it.
  //
  // `warnings` is the live array, not a copy: a model built at a later moment
  // must see what was pushed since (see the timing rule in the spec, and the
  // comments at each build site below).
  const metaFor = (): ReportMeta => ({
    model: result.model,
    warnings,
    suppressed,
    citationSweep: opts.citations === true,
  });
```

**No parameter yet.** The override this eventually takes is
`Partial<Pick<ReportMeta, "reportPath" | "exportPaths">>`, and those two keys
do not exist on `ReportMeta` until Task 4 — writing the `Pick` here fails its
`keyof` constraint and the gate goes red at this task's own commit. Task 5 adds
the parameter, where the first caller passes it.

Add `ReportMeta` to the existing `import { ... } from "./report/model.js"` line if it is not already imported.

- [ ] **Step 2: Replace the three meta literals**

Each of these becomes `metaFor()`:

```ts
// cli.ts:453
renderHtml(changeset, findings, metaFor()),

// cli.ts:498
const exportModel = buildReportModel(changeset, findings, metaFor());

// cli.ts:552
const jsonModel = buildReportModel(changeset, findings, metaFor());
```

`renderTerminal` at `:626` keeps its positional arguments for now — Task 5
converts it. (Three literals, not four: the fourth build *site* is that
positional call, which has no meta literal to replace.)

- [ ] **Step 3: Derive `counts` once**

At `cli.ts:536-538` the JSON branch recomputes what the model already holds. Move the `jsonModel` build above it and read from it:

```ts
  if (opts.json) {
    // Built before `counts` below, which reads it: one derivation, not two.
    // The model computes exactly this tally (`buildReportModel`), and a
    // second loop over the same findings is the shape that let the finding
    // band map be derived twice and disagree.
    const jsonModel = buildReportModel(changeset, findings, metaFor());
    const counts = jsonModel.counts;
```

Delete the two lines that built `counts` by hand, and delete the later `const jsonModel = ...` line now made redundant. Leave the comment above the old `jsonModel` build in place, moved with it.

**Then drop `Tier` from the import at `cli.ts:26`.** Line 537 is its only use in
the file, so deleting the hand-built tally orphans it, and `noUnusedLocals` is
on (`tsconfig.json:9`) — the gate fails otherwise. The line becomes
`import type { Analyzer } from "./types.js";`.

- [ ] **Step 4: Run the gates**

```bash
npx tsc --noEmit
npx vitest run
```
Expected: both clean, no test edited. `counts` is byte-identical — `buildReportModel` tallies `findings` by tier exactly as the deleted loop did.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "refactor(cli): assemble the report meta in one place"
```

---

### Task 2: `surfaceSymbols` on the model

**Files:**
- Modify: `src/report/model.ts`
- Test: `test/report/model.test.ts`

**Interfaces:**
- Produces: `ReportModel.surfaceSymbols: SurfaceSymbolView[]`, consumed by Task 3

- [ ] **Step 1: Write the failing test**

Add to `test/report/model.test.ts`, in a new describe block:

```ts
describe("buildReportModel surface symbols", () => {
  const withSymbols = (over: Partial<Changeset["files"][number]> = {}) =>
    changeset({
      files: [
        {
          path: "a.ts",
          status: "modified",
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }],
          symbols: [
            {
              name: "send",
              qualifiedName: "send",
              kind: "function",
              exported: true,
              range: { startLine: 1, endLine: 2 },
              change: "modified",
            },
          ],
          ...over,
        },
      ],
    });

  it("carries only the exported declarations, with their file", () => {
    const m = buildReportModel(withSymbols(), [], { warnings: [] });
    expect(m.surfaceSymbols).toHaveLength(1);
    expect(plainText(m.surfaceSymbols[0].qualifiedName)).toBe("send");
    expect(plainText(m.surfaceSymbols[0].kind)).toBe("function");
    expect(plainText(m.surfaceSymbols[0].file)).toBe("a.ts");
    expect(m.surfaceSymbols[0].change).toBe("modified");
  });

  it("leaves an unexported declaration out, as the symbol table always has", () => {
    const cs = withSymbols();
    cs.files[0].symbols[0].exported = false;
    expect(buildReportModel(cs, [], { warnings: [] }).surfaceSymbols).toEqual([]);
  });

  it("conceals a symbol name, so no surface has to", () => {
    // The reason this view exists rather than the HTML reading the changeset:
    // concealment happens in the model, and a symbol name is text the author
    // of the reviewed change controls.
    const cs = withSymbols();
    cs.files[0].symbols[0].qualifiedName = `sen${RLO}d`;
    const m = buildReportModel(cs, [], { warnings: [] });
    expect(plainText(m.surfaceSymbols[0].qualifiedName)).toBe("sen[U+202E]d");
    expect(JSON.stringify(m)).not.toContain(RLO);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run test/report/model.test.ts -t "surface symbols"
```
Expected: FAIL — `m.surfaceSymbols` is undefined.

- [ ] **Step 3: Add the view type and field**

In `src/report/model.ts`, beside the other view interfaces:

```ts
/**
 * One exported declaration in the API-surface table. Exactly the fields
 * `surfaceLens` renders and nothing else from the changeset: a whole
 * `Changeset` on the model would carry raw, author-controlled text through a
 * model whose cleanliness is enforced by stringifying it — see
 * `test/report/model.test.ts`, "carries no raw concealing character
 * anywhere", whose fixture plants one in the range label.
 *
 * Supersedes the 2026-08-19 design's addendum ruling 3, which kept symbols
 * out of the model and concealed them renderer-side. The table is rendered to
 * a reader, so "changeset data, not report content" was pragmatic rather than
 * principled, and it cost this project its one renderer-side concealment path.
 */
export interface SurfaceSymbolView {
  /**
   * Kept as its union rather than segmented: a controlled vocabulary this
   * project writes, not text from the reviewed change, and the HTML uses it
   * for a class name as well as copy.
   */
  change: "added" | "modified" | "removed";
  qualifiedName: ConcealSegment[];
  kind: ConcealSegment[];
  file: ConcealSegment[];
}
```

Add to `ReportModel`:

```ts
  /**
   * The exported declarations the API-surface pane tabulates, in changeset
   * order. Always present, empty included — a walker iterates without
   * branching.
   */
  surfaceSymbols: SurfaceSymbolView[];
```

- [ ] **Step 4: Build it in `buildReportModel`**

Before the `const model: ReportModel = {` assembly:

```ts
  // Exported only, in changeset order — the filter and the order the HTML's
  // symbol table has always applied, moved here so the concealment moves with
  // it.
  const surfaceSymbols: SurfaceSymbolView[] = changeset.files.flatMap((file) =>
    file.symbols
      .filter((sym) => sym.exported)
      .map((sym) => ({
        change: sym.change,
        qualifiedName: segmentConcealed(sym.qualifiedName),
        kind: segmentConcealed(sym.kind),
        file: segmentConcealed(file.path),
      })),
  );
```

Add `surfaceSymbols` to the model literal. Import `segmentConcealed` from `./conceal.js` if the file does not already import it (it imports `labelConcealed` and `segmentConcealed` today — check the first line).

- [ ] **Step 5: Run the gates**

```bash
npx vitest run test/report/model.test.ts
npx tsc --noEmit
npx vitest run
```
Expected: the three new tests pass; nothing else changes. The HTML still reads the changeset — Task 3 moves it.

- [ ] **Step 6: Commit**

```bash
git add src/report/model.ts test/report/model.test.ts
git commit -m "feat(model): carry the API-surface symbols, concealed"
```

---

### Task 3: The HTML walks `surfaceSymbols`; `visible` is deleted

**Files:**
- Modify: `src/report/html.ts` (`surfaceLens` at `:368`, `visible` at `:104`, the header paragraph at `:35-38` and the bullet at `:59`), `src/report/conceal.ts` (header)
- Test: `test/report/html.test.ts`

**Interfaces:**
- Consumes: `ReportModel.surfaceSymbols` from Task 2

- [ ] **Step 1: Write the failing test**

Nothing currently pins symbol-table concealment. Add to `test/report/html.test.ts`:

```ts
  it("labels a concealing character in an exported symbol's name", () => {
    const cs = structuredClone(changeset);
    cs.files[0].symbols[0].qualifiedName = `sen${RLO}d`;
    const html = renderHtml(cs, [], meta());
    expect(html).toContain(`<span class="ctrl" title="concealing character">U+202E</span>`);
    expect(html).not.toContain(RLO);
  });
```

Confirm `changeset.files[0].symbols[0]` exists in that file's fixture (it does — `test/report/html.test.ts:21`). `html.test.ts` has no `RLO` constant; add one **as an escape**, never as the character itself:

```ts
const RLO = "\u202E";
```

`test/report/model.test.ts:16-18` states the rule this follows — "a literal concealing character in this file is invisible to the next reader" — and `src/report/conceal.ts` writes its table as code points for the same reason. The first draft of this plan pasted a raw U+202E into this very instruction, in the one repository whose subject is that character; the review caught it.

- [ ] **Step 2: Run it and watch it pass**

```bash
npx vitest run test/report/html.test.ts -t "labels a concealing character in an exported"
```
Expected: **PASS** — `visible` already does this. This is a characterization test written before the move precisely so the move has something to preserve. Note it in the commit message as such; do not claim it was red.

- [ ] **Step 3: Move the lens onto the model**

```ts
function surfaceLens(model: ReportModel): string {
  const rows: string[] = [];
  for (const sym of model.surfaceSymbols) {
    rows.push(
      [
        `<tr class="sym-${sym.change}">`,
        // The mark carries the colour and the word carries the meaning, in
        // one cell: as two columns they said the same thing twice.
        `<td class="change"><span aria-hidden="true">${SYMBOL_CHANGE_MARK[sym.change]}</span> ${esc(sym.change)}</td>`,
        `<td class="mono">${seg(sym.qualifiedName)}</td>`,
        `<td class="muted">${seg(sym.kind)}</td>`,
        `<td class="mono muted">${seg(sym.file)}</td>`,
        `</tr>`,
      ].join(""),
    );
  }
  const surfaceFindings = model.findings.filter((f) => f.subject === "surface");
  // ...rest of the function unchanged, `findings` reads become `model.findings`
}
```

`seg` produces byte-identical output to `visible`: both emit `<span class="ctrl" title="concealing character">` around the same `codePointLabel`, and both escape the surrounding text — `visible` by escaping first and walking code points, `seg` by escaping each text run.

Update its call site: `surface: surfaceLens(m)`.

- [ ] **Step 4: Delete `visible` and the exception it existed for**

Remove the `visible` function (`html.ts:104-113`) and its doc comment. Remove the `conceals` and `codePointLabel` imports if nothing else uses them (`grep -n "conceals\|codePointLabel" src/report/html.ts`). In the file header, delete the paragraph at `:35-38` naming the symbol table as a scoped exception and the bullet at `:59` (`the symbol table's changeset data → visible`), and replace with one sentence:

```
 * Every string on this page comes from the model, concealment already
 * applied; this file has no concealment path of its own.
```

Two more comments become false with `visible` and must move in this commit, not
be left for a reader to trip over:

- **`src/report/conceal.ts:9-11`** says "`html.ts` builds its `visible` wrapper
  — the symbol table's scoped renderer-side exception — from `conceals` and
  `codePointLabel`". After this task that names a deleted function. Rewrite it
  to say the HTML renders segments through `seg` like every other surface.
- **`src/report/html.ts:55-64`**, the `esc()` doc: "Three contexts, one
  function each" becomes two, and "Both wrappers call this one" becomes one.
  Adjust both counts (spelled as words, per the comment contract).

- [ ] **Step 5: Run the gates**

```bash
npx vitest run test/report/html.test.ts
npx tsc --noEmit
npx vitest run
```
Expected: all green with no test edited. If any HTML assertion changes, stop — the move was supposed to be byte-identical, and a diff means `seg` and `visible` disagree somewhere worth understanding before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/report/html.ts src/report/conceal.ts test/report/html.test.ts
git commit -m "refactor(html): tabulate symbols from the model, not the changeset"
```

---

### Task 4: `reportPath` and `exportPaths` on the model

Model fields only. The terminal starts reading them in Task 5, which is where its signature can express them without an eighth parameter.

**Files:**
- Modify: `src/report/model.ts`
- Test: `test/report/model.test.ts`

**Interfaces:**
- Produces: `ReportMeta.reportPath`, `ReportMeta.exportPaths`; `ReportModel.reportPath`, `ReportModel.exportPaths` — consumed by Task 5

- [ ] **Step 1: Write the failing test**

Both tests go in a new `describe("buildReportModel written paths")` block, after
the surface-symbols block from Task 2.

```ts
  it("labels the paths of what was written, like every other path it carries", () => {
    const m = buildReportModel(changeset(), [], {
      warnings: [],
      reportPath: `/tmp/.urtext/rev${RLO}iew.html`,
      exportPaths: [
        // An export path carries a concealing character too, or the title's
        // plural is unearned: with the report path as the only one, dropping
        // `labelConcealed` from the export paths leaves this test green and
        // that line of the implementation covered nowhere. The pdf path stays
        // clean, pinning that a path with nothing to conceal passes through
        // unchanged.
        { format: "md", path: `/tmp/.urtext/rev${RLO}iew.md` },
        { format: "pdf", path: "/tmp/.urtext/review.pdf" },
      ],
    });
    expect(m.reportPath).toBe("/tmp/.urtext/rev[U+202E]iew.html");
    expect(m.exportPaths.map((e) => e.format)).toEqual(["md", "pdf"]);
    expect(m.exportPaths[0].path).toBe("/tmp/.urtext/rev[U+202E]iew.md");
    expect(m.exportPaths[1].path).toBe("/tmp/.urtext/review.pdf");
    expect(JSON.stringify(m)).not.toContain(RLO);
  });

  it("carries an empty export list rather than none, and no path when none was written", () => {
    const m = buildReportModel(changeset(), [], { warnings: [] });
    expect(m.exportPaths).toEqual([]);
    expect(m.reportPath).toBeUndefined();
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run test/report/model.test.ts -t "buildReportModel written paths"
```
Expected: FAIL — `m.reportPath` is undefined and `m.exportPaths` does not exist.

- [ ] **Step 3: Add the fields**

`ReportMeta`:

```ts
  /**
   * Where the HTML report was written, absent when none was — a review that
   * failed hard enough writes none, and the surfaces say so.
   */
  reportPath?: string;
  /** The exports that were written, in the order they were requested. */
  exportPaths?: { format: "md" | "pdf"; path: string }[];
```

`ReportModel`:

```ts
  /** `labelConcealed` applied, like every other path the model carries. */
  reportPath?: string;
  /** Always present, empty included. */
  exportPaths: { format: "md" | "pdf"; path: string }[];
```

In `buildReportModel`:

```ts
  const exportPaths = (meta.exportPaths ?? []).map((e) => ({
    format: e.format,
    path: labelConcealed(e.path),
  }));
```
Add `exportPaths` to the literal, and `if (meta.reportPath) model.reportPath = labelConcealed(meta.reportPath);` beside the other conditional assignments.

- [ ] **Step 4: Run the gates**

```bash
npx vitest run test/report/model.test.ts
npx tsc --noEmit
npx vitest run
```
Expected: the two new tests pass; nothing else moves. No surface reads the fields yet, and `cli.ts` does not populate them — Task 5 does both.

- [ ] **Step 5: Commit**

```bash
git add src/report/model.ts test/report/model.test.ts
git commit -m "feat(model): carry where the review was written"
```

---

### Task 5: `renderTerminal(model)`, and the paths it prints

The largest task, and one unit: the signature, the two path readings it makes
possible, and the call sites that move with it.

**Files:**
- Modify: `src/report/terminal.ts`, `src/cli.ts:626` (which becomes the moment-3 build), `src/cli.ts:639-642`
- Test: `test/report/terminal.test.ts` (39 sites), `test/report/model.test.ts` (2), `test/report/copy-guard.test.ts` (2)

**Interfaces:**
- Consumes: `ReportModel.reportPath`, `ReportModel.exportPaths` from Task 4

- [ ] **Step 1: Change the signature**

```ts
export function renderTerminal(m: ReportModel): string {
```
Delete the seven parameters, the internal `buildReportModel` call, and the paragraph-long comment at `:116-122` admitting the shape was wrong — it is no longer true and its deletion is the point of this task.

**Then clean the imports, or the gate fails.** `noUnusedLocals` is on, and this
leaves `labelConcealed` (`:1`), `buildReportModel` (`:3`), and the
`Changeset`/`Finding` type import (`:11`) with no users in `terminal.ts`. Keep
`ReportModel` and whatever the walker still names. **`cli.ts` orphans one too:**
deleting its export-path loop (Step 3) leaves `labelConcealed` at `cli.ts:10`
with no user — the plan's first draft named only the three in `terminal.ts`.

- [ ] **Step 2: Rule on the blank line**

`terminal.ts:149` reads the raw `warnings` parameter, which no longer exists:

```ts
  // Spacing only. Gated on the notes as a whole, not on analyzer warnings
  // alone as it was: the model merges warnings and the untracked note into
  // one `notes` array because "they are one thing to a reader", so a walker
  // holding only the model cannot tell them apart — and widening the model to
  // restore the distinction would contradict the merge. A run whose only
  // disclosure is the untracked note therefore gains one blank line. A layout
  // divergence, not a content one; see the spec's §2 ruling.
  if (m.notes.length > 0) out.push("");
```

- [ ] **Step 3: Read both paths from the model, and delete the controller's copy**

In `renderTerminal`, the report-path block reads `m.reportPath` — already
labelled — so its `labelConcealed` call and the comment claiming the path "is
the one string on this surface that does not come from the model" both go:

```ts
  if (m.reportPath) {
    out.push(`  Full report: ${m.reportPath}`);
    // One line per written export, under the report's and inside its block.
    // Composed here rather than appended by `cli.ts` after this walker had
    // returned: where a review was written is something the report says about
    // itself. Inside the block, before the trailing blank, is the placement
    // that reproduces today's bytes — see below.
    for (const e of m.exportPaths) {
      out.push(`  ${e.format} export: ${e.path}`);
    }
    out.push("");
  }
```

**The placement is load-bearing, and the obvious version is wrong.** Today the
walker ends `[..., "  Full report: X", ""]`, and `join("\n")` turns that
trailing empty element into the final newline — so the returned string ends
`"  Full report: X\n"` with *no* blank line after it, and `cli.ts` appends
`"  md export: Y\n"` directly onto that. Pushing the export lines *after* the
`out.push("")` would insert a blank line that does not exist today and leave no
trailing newline, so the gitignore tip — appended by `cli.ts` as
`output += "  Tip: ...\n"` — would glue itself onto the last export line.

No existing test would object: every assertion on these lines is a substring
check (`test/cli.test.ts:775-779`, `:1068-1072`, `:1076-1080`), and the fixture
that exercises the tip is one of them. The tripwire in the step below is
therefore not sufficient on its own — check the three cases by eye: no report,
report only, report plus exports.

**First give `metaFor` the parameter Task 1 deferred** — this is the step that
task promised, and the call below is its first caller:

```ts
  // Only the two fields a later moment *learns* may be overridden. Widening
  // this to `Partial<ReportMeta>` would let one moment quietly hand a
  // different `warnings` or `citationSweep` than another, reopening inside
  // the one file meant to close it the door this whole change exists to shut.
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

If a compile error tempts you to widen that type instead, the paragraph above
is the reason not to.

Then delete the loop at `cli.ts:639-642` and populate the meta instead:

```ts
  const written = exportFormats.flatMap((format) => {
    const path = exportPaths[format];
    return path ? [{ format, path }] : [];
  });
  let output = renderTerminal(
    buildReportModel(changeset, findings, metaFor({ reportPath, exportPaths: written })),
  );
```

Keep `cli.ts`'s own `exportPaths` record — the JSON object still emits it.

The lines are byte-identical and in the same order, so `test/cli.test.ts`'s
assertions on them (`grep -n "export:" test/cli.test.ts`) must pass untouched.
If one needs editing, stop and find out why — but do not treat their passing as
proof, for the reason stated above.

**Add the assertion that would have caught it.** In `test/report/terminal.test.ts`:

```ts
  it("runs the export lines straight on from the report line, and ends there", () => {
    const m = buildReportModel({ ...changeset, untrackedCount: 0 }, [], {
      warnings: [],
      reportPath: "/r/review.html",
      exportPaths: [{ format: "md", path: "/r/review.md" }],
    });
    // Exact tail, not `toContain`: the defect this pins is a blank line in the
    // wrong place and a missing final newline, and every substring assertion
    // in the suite survives both.
    expect(renderTerminal(m).endsWith("  Full report: /r/review.html\n  md export: /r/review.md\n")).toBe(true);
  });
```

- [ ] **Step 4: Pin the new blank-line rule**

```ts
  it("separates the disclosures from the findings whichever kind they are", () => {
    // `changeset` is a const in this file, not a factory — the `changeset({...})`
    // idiom belongs to model.test.ts. Spread it, as `:134` already does.
    const lineAfter = (m: ReportModel, marker: string): string => {
      const lines = renderTerminal(m).split("\n");
      return lines[lines.findIndex((l) => l.includes(marker)) + 1];
    };
    // Both kinds, or the title is unearned: the gate now reads `notes`, which
    // merges analyzer warnings with the untracked note. A gate narrowed back
    // to either kind alone still passes a test exercising only the other.
    expect(lineAfter(model({ ...changeset, untrackedCount: 2 }, [finding()]), "untracked file")).toBe("");
    expect(
      lineAfter(model(changeset, [finding()], { warnings: ["the surfaceAnalyzer analyzer failed"] }), "surfaceAnalyzer"),
    ).toBe("");
  });
```

- [ ] **Step 5: Add the per-file helper and rewrite the call sites**

At the top of `test/report/terminal.test.ts`, beside the existing fixtures:

```ts
// The changeset is a parameter, never closed over: several tests below pass a
// fixture other than the default, and a helper that hid it would let a
// rewrite swap one silently.
const model = (cs: Changeset, findings: Finding[], over: Partial<ReportMeta> = {}) =>
  buildReportModel(cs, findings, { warnings: [], ...over });
```

The rewrite rule, applied to every site:

| Before | After |
|---|---|
| `renderTerminal(cs, fs)` | `renderTerminal(model(cs, fs))` |
| `renderTerminal(cs, fs, path)` | `renderTerminal(model(cs, fs, { reportPath: path }))` |
| `renderTerminal(cs, fs, path, warnings)` | `renderTerminal(model(cs, fs, { reportPath: path, warnings }))` |
| `renderTerminal(cs, fs, path, warnings, name)` | `renderTerminal(model(cs, fs, { reportPath: path, warnings, model: name }))` |
| `renderTerminal(cs, fs, path, warnings, name, n)` | `...{ ..., suppressed: n }` |
| `renderTerminal(cs, fs, path, warnings, name, n, true)` | `...{ ..., citationSweep: true }` |

Note `warnings` defaults to `[]` in the helper, so a site passing no warnings must not gain any, and a site passing `[]` explicitly can drop it.

**`test/report/copy-guard.test.ts` takes no helper.** It already builds the
models this task wants — `const model` at `:83` and `citationModel` at `:202` —
and then hands the *pieces* they were built from to `renderTerminal` at `:105`
and `:213`. Those two calls become `renderTerminal(model)` and
`renderTerminal(citationModel)`: this whole change in one line each. A per-file
helper named `model` would collide with that constant anyway.

**The review point for this task:** read the diff for *meta content*, not for compilation. `tsc` cannot catch a dropped `suppressed: 3` or a changeset swapped for the file default. Check each rewritten site's arguments against the original line.

- [ ] **Step 6: Run the gates**

```bash
npx vitest run test/report/terminal.test.ts
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add src/report/terminal.ts src/cli.ts test/
git commit -m "refactor(terminal): walk a model, like the other three surfaces"
```

---

### Task 6: `renderHtml(model)`

**Files:**
- Modify: `src/report/html.ts:709`, `src/cli.ts:453`
- Test: `test/report/html.test.ts` (60 sites), `test/identity.test.ts` (2), `test/report/copy-guard.test.ts` (2), `test/report/model.test.ts` (2)

- [ ] **Step 1: Change the signature**

```ts
export function renderHtml(m: ReportModel): string {
```
Delete the internal `buildReportModel` call. The three panes already read `m`; `surfaceLens(m)` came from Task 3.

**Imports and a re-export go with it:** `buildReportModel` (`:4`), the
`ReportMeta` import (`:21`), and — out of the type import at `:16` — the names
`Changeset` and `Finding` only. That line reads
`import type { Changeset, ChangedSymbol, Finding } from "../types.js";`, and
`ChangedSymbol` keeps a user at `:362`, in `SYMBOL_CHANGE_MARK`'s
`Record<ChangedSymbol["change"], string>`. Delete the two names, never the
whole line — deleting the line fails `tsc`.

The `export type { ReportMeta }` re-export at `:23` loses its purpose too:
every consumer imports that type from `model.js` directly (`grep -rn
"ReportMeta" src test`), so it and its explanatory comment go with them.

- [ ] **Step 2: Add the per-file helper and rewrite the call sites**

Same helper as Task 5, in each test file that has renderHtml sites. The rule:

| Before | After |
|---|---|
| `renderHtml(cs, fs, meta())` | `renderHtml(model(cs, fs))` |
| `renderHtml(cs, fs, meta({ suppressed: 2 }))` | `renderHtml(model(cs, fs, { suppressed: 2 }))` |
| `renderHtml(noSymbols, fs, meta())` | `renderHtml(model(noSymbols, fs))` |

`test/report/html.test.ts` already has a `meta()` helper; keep it and let `model()` call it, so a site's meta arguments move across unchanged:

```ts
const model = (cs: Changeset, findings: Finding[], over: Partial<ReportMeta> = {}) =>
  buildReportModel(cs, findings, meta(over));
```

**`meta()` must be retyped first.** It is declared
`Partial<Parameters<typeof renderHtml>[2]>` (`test/report/html.test.ts:54`),
and after this step `renderHtml` has no second index — that is a type error, not
a lint. Change it to `Partial<ReportMeta>` and import the type from
`../../src/report/model.js`.

**`test/report/copy-guard.test.ts` gets no helper.** It already declares a
top-level `const model = buildReportModel(...)` at `:83` (and a
`citationModel`), so a per-file helper of that name collides. Its four sites
should pass those existing constants straight in — which is this change at its
best: the file built models already and then handed the pieces to the renderers.

**Same review point as Task 5**, and it matters more here: 8 sites pass `noSymbols` and several pass inline or derived changesets.

**Delete the comment this change disproves.** `test/report/model.test.ts:709`
reads "The terminal takes findings, not a model, so it gets the same two" — it
explains why that test builds its fixture twice, and the spec cites it as
motivation. Once both renderers take a model the sentence is false and the
duplication it excused should go with it: build one model and hand it to both
surfaces, which is the whole point.

- [ ] **Step 3: Run the gates**

```bash
npx vitest run test/report/html.test.ts test/identity.test.ts
npx tsc --noEmit
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/report/html.ts src/cli.ts test/
git commit -m "refactor(html): walk a model, closing the last piece-taking signature"
```

---

### Task 7: Name the three moments, and enforce them

**Files:**
- Modify: `src/cli.ts` (comments at the three build sites)
- Test: `test/cli.test.ts`

- [ ] **Step 1: Comment each build site**

At each of the three sites, one sentence naming what that moment can honestly know — for example, above the moment-2 build:

```ts
      // Moment two. Built after the report write attempt, so the Markdown and
      // the PDF can carry a failure to write the report; built before the
      // exports are written, because an export cannot report a failure to
      // write itself. See the timing rule in the spec.
```

- [ ] **Step 2: Write the failing test — moment 2 against moment 3**

```ts
  it("keeps a late failure off the surfaces that were already rendered", async () => {
    // The three model builds are moments, not redundancy: each surface
    // carries what was known when it was produced. Collapsing them into one
    // build would either backdate a warning onto a document that could not
    // have known it, or drop it from one that must say it.
    const r = await review(
      repo,
      { command: "review", json: true, noLlm: true, help: false, exportFormats: ["md", "pdf"] },
      // `exporters` is the FOURTH parameter (`cli.ts:301-318`); `analyzers` is
      // third and takes its default. The existing seam user at
      // `test/cli.test.ts:787` passes `undefined` here for the same reason.
      undefined,
      {
        md: () => {
          throw new Error("md exporter exploded");
        },
        pdf: renderPdf,
      },
    );
    const parsed = JSON.parse(r.output);
    // The run that failed to render the md export says so...
    expect(parsed.warnings.some((w: string) => w.includes("md export"))).toBe(true);
    // ...and the PDF, rendered from the model built before that failure,
    // does not carry it.
    const pdfText = await textOf(readFileSync(parsed.exportPaths.pdf));
    expect(pdfText).not.toContain("md export");
  });
```

Import `renderPdf`, and copy the `extracted`/`textOf` pair from
`test/report/pdf.test.ts:65-71` (seven lines, not four) — it collapses
whitespace, which makes the assertion safe against pdfkit's line wrapping.

- [ ] **Step 3: Run it**

```bash
npx vitest run test/cli.test.ts -t "already rendered"
```
Expected: PASS on the implementation as built — this test characterizes the moments rather than driving new behaviour. Its value is as a tripwire; say so in the commit message rather than implying it was red.

To prove it discriminates, collapse moment 2 into moment 3 for one run: inside
the export loop, build a fresh model immediately before the `pdf` render
(`await exporters.pdf(buildReportModel(changeset, findings, metaFor(...)))`)
so the PDF is rendered *after* the md failure was pushed to `warnings`. The
assertion must then fail, because `renderPdf` prints every `notes` entry
through `strongLine` (`src/report/pdf.ts:228-235`). Restore by editing the file
back — **not** with `git checkout --`, which would discard the task's other
uncommitted work.

- [ ] **Step 4: Add the moment 1 / moment 2 case**

```ts
  it("tells the stream what no report could say", async () => {
    // With `.urtext` occupied by a plain file the report write fails, so
    // moment one produces nothing; the Markdown on stdout is built at moment
    // two and carries the failure the HTML never existed to carry.
  });
```
Copy the occupied-`.urtext` fixture from **"still returns the review's findings
when the report fails to write"** (`test/cli.test.ts:694`) — the title cited in
this plan's first draft, "writes no report when the path is occupied", does not
exist. That test's options are an inline literal (`jsonOpts` is declared at `:741`,
inside the later exports describe, and is not in scope there); the copy needs
`json: false, stdout: "md"`, and asserts the returned `markdown`
contains "could not write the report".

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/cli.ts test/cli.test.ts
git commit -m "test(cli): pin the three build moments against collapse"
```

---

### Task 8: The `--json` keys guard

`--json` is not a walker and this change does not make it one (the spec says why). This guard makes the gap loud instead of silent — a new `ReportModel` field either reaches the JSON object or is exempted with a stated reason.

**Files:**
- Modify: `src/cli.ts` (Step 2 emits `untrackedCount`)
- Test: `test/cli.test.ts` — the house style is `test/comment-contract.test.ts`'s, but this guard is about the CLI's own contract

- [ ] **Step 1: Write the guard**

```ts
  it("accounts for every model field in the JSON object, or exempts it by name", async () => {
    // `kindNotes` reached three surfaces and missed this one, because this
    // object is composed field by field rather than walked. It cannot simply
    // become a walker — its `warnings` are deliberately raw where the model's
    // `notes` are labelled, and its shape is a published contract — so the
    // rule is that a new model field is a decision, not an oversight.
    // Only keys the object does NOT emit belong here — `emitted.has(k)`
    // already accounts for the rest, and listing them would forgive a future
    // *removal* in silence. Every reason must be true; an exemption whose
    // reason is false is worse than no guard, because it reads as a decision.
    const EXEMPT: Record<string, string> = {
      scope: "prose over rangeLabel/fileCount/lineCount, all recoverable below",
      fileCount: "recomputable from the diff the consumer already has",
      lineCount: "recomputable from the diff the consumer already has",
      rangeLabel: "present as `range.label`",
      provenance: "prose about `model`, which is present",
      modelName: "present as `model`",
      notes: "labelled prose over `warnings` and `untrackedCount`, both present",
      coverageNote: "present as `coverage.note`",
      filterNote: "prose about `suppressed`, which is present",
      beyondIntentLegend: "legend for a mark carried on each finding",
      surfaceSymbols: "recomputable by rerunning extraction; not in the diff alone",
      // Not dead, despite looking like the entries above it that were: the
      // model always carries this key (Task 4 builds it as `?? []`) while the
      // JSON emits it only under `--export`, which this run does not ask for
      // — pinned by "omits exportPaths from --json entirely when no export was
      // requested" (`test/cli.test.ts:770`). Without this entry the guard is
      // red the first time it runs.
      exportPaths: "emitted only when --export was given; this run asked for none",
    };
    const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
    const emitted = new Set(Object.keys(JSON.parse(r.output)));
    const m = buildReportModel(/* the same changeset and findings */);
    const unaccounted = Object.keys(m).filter((k) => !emitted.has(k) && !(k in EXEMPT));
    expect(unaccounted, "add the key to --json or to EXEMPT with a reason").toEqual([]);
  });
```

Build the model in the test from the same fixture the review used — nothing
new needs exporting from `cli.ts`: `extract` and `repoRoot` are already public
and `test/report/pdf.test.ts:309` builds a model from real extraction exactly
this way. Take `findings` from the parsed output.

**One caveat the test should state in a comment:** the guard sees
`Object.keys` of one built instance, and this model assigns seven fields
conditionally (`if (x) model.y = ...`). A new field of that shape is invisible
to the guard on a fixture that does not trigger it. The guard catches the
common case, not every case, and should say so rather than implying otherwise.

- [ ] **Step 2: Emit what the exemptions cannot honestly excuse**

Writing the list above surfaces a real gap: the untracked-file disclosure
reaches `notes` (`model.ts:635-641`) and **no** JSON key. `warnings` carries
the raw analyzer strings, not that note, and `range` does not carry the count —
so a script cannot recover "N untracked files were not reviewed" at all. That
is the `kindNotes` failure again, found by writing down why a key was exempt
and not being able to finish the sentence.

Add `untrackedCount` to the JSON object beside `suppressed`, always present,
zero included, with a comment naming the same rule. The field is optional on
`Changeset`, so write `changeset.untrackedCount ?? 0` — the idiom `model.ts:636`
already uses. Then `notes`' exemption
reason above is true. Add a test asserting a run over a repository with an
untracked file reports it on both surfaces.

- [ ] **Step 3: Verify it discriminates**

Add a throwaway field to `ReportModel` and its builder, run the test, confirm it fails naming that key, then remove the field.

- [ ] **Step 4: Gates and commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): emit the untracked count, and guard the model's keys"
```

---

## Execution order

Straight through, 1 to 8: each task's interfaces are produced by an earlier one, and every task leaves the suite green and the tree committable.

## Corrections from review (2026-08-28, before execution)

Ten findings, all folded in above. Four were mandatory — without them the first
task's gate is red, or the change ships a silent regression:

1. **Task 1 could not compile.** `metaFor`'s override typed
   `Pick<ReportMeta, "reportPath" | "exportPaths">` names keys Task 4 adds, and
   deleting the hand-built `counts` orphaned the `Tier` import under
   `noUnusedLocals`. The parameter now arrives in Task 5, and the import is
   dropped explicitly.
2. **Task 5's path block was not byte-identical.** The export lines belong
   *inside* the report-path block, before its trailing blank push. The draft's
   placement added a blank line and dropped the final newline, gluing the
   gitignore tip onto the last export line — and every existing assertion on
   those lines is a substring check, so the suite would have stayed green. A
   tail-exact test is added because of this.
3. **The plan itself contained a raw U+202E**, in an instruction telling the
   executor to paste it into a test file — in the repository whose subject is
   that character. Now the escape, with the convention cited.
4. **Task 7 passed `exporters` third**, where it is the fourth parameter, and
   cited a test title that does not exist.

The rest: orphaned imports in Tasks 5 and 6, `html.test.ts`'s `meta()` helper
typed off `renderHtml`'s parameter list, `copy-guard.test.ts`'s existing
`model` const colliding with the proposed helper, `terminal.test.ts`'s
`changeset` being a const rather than a factory, three false reasons in the
`--json` exemption list, and three comments elsewhere that this change makes
untrue. Errata: "four literals" (three), `html.ts:59` (`:60`), and Task 5's
file list calling `:453` the moment-3 build.

**One finding produced new work rather than a correction.** Writing down why
`notes` could be exempt from `--json` did not survive contact: the untracked-file
disclosure reaches `notes` and no JSON key at all, so a script cannot recover
it. That is the `kindNotes` gap again, and Task 8 now emits `untrackedCount`
instead of exempting it with a sentence that could not be finished.

## Self-review

- **Spec coverage:** every section of the spec maps to a task — `surfaceSymbols` (2, 3), `reportPath`/`exportPaths` (4), the two signatures (5, 6), `metaFor` and `counts` (1), the timing rule and its test (7), the `--json` guard (8), the blank-line ruling (5, step 2). The `.gitignore` tip is deliberately untouched.
- **Placeholders:** Task 8's model construction and Task 7's second test are the two steps that describe rather than show; both name the existing test to copy and the exact assertion. Sharpen them at execution time if the fixture differs.
- **Type consistency:** `ReportMeta.exportPaths` and `ReportModel.exportPaths` are the same shape (`{ format: "md" | "pdf"; path: string }[]`); the model's paths are labelled, the meta's are raw. `SurfaceSymbolView` is used by name in Tasks 2 and 3.
