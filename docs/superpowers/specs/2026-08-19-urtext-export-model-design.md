# urtext export model and export formats — design

**Date:** 2026-08-19
**Status:** approved in conversation (design sections reviewed); this document is the binding spec
**Prior art:** a sibling private project's `export-model.ts` and `export-pdf.ts` (the shared-model
pattern and the pdfkit SOW house style this design ports), and urtext's own
`docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md` (evidence-tier principles, which this
design must not weaken).

## Purpose

Two goals, one structure:

1. **New export formats.** A run can additionally emit the review as GitHub-flavored Markdown
   (for PRs, issues, chat, and downstream tools) and as a client-presentable PDF following the
   professional-services SOW house style already ported into that project.
2. **End the renderer-drift defect class.** Today `terminal.ts` and `html.ts` each walk the
   findings independently and share honesty copy piecemeal (`coverage.ts`, `conceal.ts`). Two
   drift bugs shipped from exactly this: the terminal missing the concealment defense the HTML
   had, and the HTML missing the filter disclosure the terminal had. After this work, every
   surface — terminal, HTML, Markdown, PDF — walks ONE report model, and no renderer may
   compose honesty phrasing itself.

The governing rule, copied from that project and strengthened for a tool whose product *is*
honesty phrasing: **the model is the single source of layout and honesty truth; renderers are
typesetters.**

## The report model

New file `src/report/model.ts`.

```ts
import type { Changeset, Finding, Tier } from "../types.js";
// ReportMeta MOVES from html.ts into this file; html.ts re-exports it so
// existing importers (cli.ts, tests) keep working unchanged.

export type Lens = "narrative" | "effects" | "surface";

export interface EvidenceView {
  file: string;
  line: number;
  /** Concealment-labeled plain text (see "Honesty vs. format mechanics"). */
  excerpt: string;
}

export interface ReachView {
  references: number;        // deduped count, exactly as rank computed it
  sites: EvidenceView[];     // deduped sites, capped exactly as today
  overflow: number;          // count of collected-but-not-shown sites
}

export interface ModelNoteView {
  /** Never empty: an unnamed model renders as the existing fallback copy. */
  model: string;
  text: string;              // concealment-labeled
}

export interface FindingView {
  id: string;
  tier: Tier;
  glyph: string;             // "▲" | "●" | "○", chosen here, once
  lens: Lens;                // kind-prefix routing lives here, once
  headline: string;          // "src/x.ts:16 — ten exports … changed their signature"
  body: string[];            // paragraphs, concealment-labeled
  modelNote?: ModelNoteView; // prose and attribution inseparable, as today
  evidence: EvidenceView[];
  reach?: ReachView;
}

export interface ReportModel {
  scope: string;             // "44 files, 2384 lines changed · vs master"
  counts: { verified: number; inferred: number; model: number };
  /** Present only under the same gate the terminal/HTML provenance line uses
   *  today (a model name AND at least one inferred/model finding). */
  provenance?: string;
  /** Every reason the review fell short, in order — analyzer failures,
   *  skipped interpretation, untracked-file note, deleted-file coverage.
   *  Non-empty implies the surface must say the review is partial. */
  notes: string[];
  /** Composed by `suppressionNote`; absent when nothing was suppressed.
   *  Deliberately NOT in `notes`: the filter running as designed is not a
   *  shortfall and must not trip partial-review copy. */
  filterNote?: string;
  findings: FindingView[];   // in rank order; renderers must not reorder
}

export function buildReportModel(
  changeset: Changeset,
  findings: Finding[],
  meta: ReportMeta,
): ReportModel;
```

Field-level requirements:

- Every sentence that exists today — tier meanings, provenance, the deleted-file coverage note,
  the untracked note, the suppression note, the model-claim-drop warning, "This review is
  partial.", the empty-lens filter-shaped copy — is composed in (or reached through) the model
  layer exactly once. `coverage.ts` keeps its composing functions; `model.ts` calls them.
- `FindingView.headline`, `body`, `modelNote.text`, `evidence.excerpt` arrive
  **concealment-labeled**: `conceal.ts`'s plain-text substitution is applied while building the
  model, not in renderers.
- Rank order is model truth. A renderer may group by `lens` (HTML tabs, Markdown sections) but
  must preserve rank order within a lens and may never drop a finding.

## Honesty vs. format mechanics

The split that keeps the rule enforceable:

- **In the model (honesty, once):** concealment labeling; all disclosure/partial/provenance
  copy; tier assignment and glyphs; lens routing; ordering; what is emphasized
  (`ExportMetaLine.strong` equivalent below for PDF).
- **In renderers (format mechanics, per format, unavoidable):** HTML entity escaping;
  Markdown code-fence escalation (an excerpt containing a backtick run gets a fence one
  longer than the longest run it contains); PDF typesetting. Format escaping is applied to
  ALL model-provided text uniformly — a renderer that escapes some fields and not others is
  a defect.

## Renderers

### Terminal and HTML (refactor)

`renderTerminal` and `renderHtml` keep their exact public signatures and are reimplemented as
walkers over `buildReportModel`. The existing test suites are the regression net: the refactor
must land with **zero changes to existing test expectations** (test-file mechanics like imports
may change; expected strings may not). The three HTML lenses, the legend, the banner, chips,
and CSS are unchanged — they become presentation of model fields.

### Markdown (new: `src/report/markdown.ts`)

`renderMarkdown(model: ReportModel): string`. GitHub-flavored. Shape:

- H1 `urtext review`, then the scope line; provenance and partial/filter lines as blockquotes
  immediately below (disclosures lead, matching the other surfaces).
- One H2 per lens **in the HTML's lens order**, containing its findings in rank order; a lens
  with no findings gets the same filter-shaped empty copy the HTML uses.
- Each finding: H3 `<glyph> file:line — headline [tier]`; body paragraphs; model note as a
  blockquote prefixed with the attribution line; evidence as fenced code blocks whose info
  string is the language guessed from the file extension (`ts`, `tsx`, else none), one
  `file:line` line above each fence.
- Fence escalation as specified above, pinned by a test whose excerpt contains a triple
  backtick.

### PDF (new: `src/report/pdf.ts`)

`renderPdf(model: ReportModel): Promise<Buffer>` using **pdfkit** (new runtime dependency),
loaded via dynamic `import()` so runs without `--export pdf` never pay for it.

House style, ported from that project's PDF exporter (itself a professional-services
SOW template):

- Title ("urtext review"), then a bold-label/value meta block: Generated (ISO date), Range
  (scope line), Model (or "not asked"), Evidence (tier counts). Honesty-critical lines —
  any `notes` entry, the filter note — render whole-line bold and are never restyled away.
- Horizontal rule; findings as numbered sections in rank order (lens shown as a small
  caption, not a grouping — a client reads one list).
- Body text in the embedded sans; evidence excerpts in the embedded mono, one `file:line`
  label above each, light-gray text for the label like that project's sources line.
- Page footer: "Generated by urtext — every finding is labeled by its evidence tier" plus
  page number.

**Fonts:** embedded DejaVu Sans (regular/bold/oblique) and DejaVu Sans Mono, committed to the
repo under `fonts/` with the DejaVu license file beside them, shipped via package.json
`files: ["dist", "fonts"]`, resolved at runtime with `new URL("../../fonts/…", import.meta.url)`
(correct from both `src/` under tsx and `dist/` when installed). Documented trade, stated in a
comment and the README: broad Latin/Cyrillic/Greek coverage; CJK and other scripts will not
render, because full-Unicode fonts cost tens of megabytes.

## CLI

- New flag `--export <list>`: comma-separated, valid values `md` and `pdf` (`--export md,pdf`).
  An unknown value is a usage error naming the valid list (same style as existing flag errors).
- Exports are written beside the HTML report in `.urtext/`, sharing its timestamp stem:
  `review-<stamp>.md`, `review-<stamp>.pdf`. HTML remains always-written; `--export` adds.
- Terminal prints one path line per written export, alongside the existing report-path line.
- `--json` gains `exportPaths: { md?: string; pdf?: string }` (present only when requested).
- **Failure behavior identical to the HTML report's:** an export that fails to render or write
  degrades to a warning; findings, exit code, and the other outputs are untouched. No report is
  exported when no report is written (nonzero-exit runs).
- `--open` continues to open the HTML report only.

## Testing

- **Model:** unit tests pin that each honesty sentence appears exactly once in the model for a
  representative changeset (partial + suppressed + deleted-file + model-claims all at once);
  that concealment labels are already present in model text; that rank order is preserved.
- **Terminal/HTML refactor:** the existing suites pass unchanged — that is the acceptance test.
- **Markdown:** walker tests against REAL analyzer output (established pattern), plus fence
  escalation, plus lens-empty copy, plus a concealment label surviving verbatim.
- **PDF:** rendered buffer is text-extracted with **unpdf** (new devDependency, the same
  tool that project uses) and must contain: the tier-count line, one `notes` entry, the filter
  note when present, a concealment label, and a code excerpt. A finding count sanity check
  guards against silent truncation. No pixel/geometry assertions — content honesty only.
- **CLI:** `--export md,pdf` writes both files with the shared stem (asserted via `--json`
  paths + files existing); unknown value errors; export failure degrades to a warning
  (injected by making the target directory unwritable or stubbing the renderer).
- Mutation checks named in the plan: removing the filter note from the model must fail one
  test per surface (four failures, one net).

## Global constraints (carried from the project)

- No claim ever renders as `verified`; model prose never renders without attribution; the
  concealment defense applies to every surface; empty-lens copy is filter-shaped; urtext
  writes only inside `.urtext/`.
- Comment contract: comments name constants, never restate values; invariant claims quote
  their enforcing test verbatim; `test/comment-contract.test.ts` must stay green.
- Every behavior change lands with a test that fails before it.
- pdfkit and the fonts are the only new runtime weight; both load lazily under `--export pdf`.

## Out of scope

- DOCX and other formats (no current recipient).
- CJK-capable font embedding.
- Any change to ranking, tiers, analyzers, or the interpretation stage.
- Retention policy for `.urtext/` (still the user's call).

## Addendum — controller rulings during implementation (2026-08-22)

1. **Concealment is structural in the model.** Content-bearing text fields
   (headline, body paragraphs, model-note text, evidence and reach-site
   excerpts) are arrays of segments — ordinary text vs. a concealed code
   point's label — not pre-flattened strings. A flattened `[U+XXXX]` label
   cannot be told apart from source text that literally spells it, and a
   walker parsing labels back out would style an attacker-written literal as
   a concealed character. Flat surfaces (terminal, Markdown, PDF) join
   segments via a shared `plainText` helper; HTML wraps concealed segments in
   its existing markup. Concealment is still applied exactly once, in the
   model.
2. **Width-limited surfaces truncate segment-aware**: a concealed segment's
   label is never split mid-label. Where this diverges from historical
   output on concealed input near width limits, the divergence is accepted
   (no test pins the old behavior; a bisected label would misstate the code
   point).
3. **The HTML surface pane's symbol table** reads the changeset directly, as
   the spec's model omits symbols by design; it applies concealment
   renderer-side via `conceal.ts`. On record as a scoped exception to
   "concealment happens in the model": symbols are changeset data, not
   report content.
4. `coverageNote` is a distinct model field, not a `notes` entry — the
   filter-note "not a shortfall" principle applies to deleted-file coverage
   too.
