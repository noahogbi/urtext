# Urtext Export Model & Formats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every output surface — terminal, HTML, and the new Markdown and PDF exports — walks one shared report model, so no renderer can compose honesty phrasing of its own, and `urtext review --export md,pdf` writes shareable review documents beside the HTML report.

**Architecture:** A new `src/report/model.ts` builds a `ReportModel` from `(changeset, findings, meta)`: every sentence, glyph, tier, lens assignment, ordering decision, and concealment substitution happens there, once. `renderTerminal` and `renderHtml` are reimplemented as walkers with their public signatures and every existing test expectation unchanged. Two new walkers render GitHub-flavored Markdown and a pdfkit PDF (SOW house style, embedded DejaVu fonts). The CLI grows `--export`.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, vitest, tsx. New runtime dependency `pdfkit` (dynamically imported only under `--export pdf`) plus embedded DejaVu fonts; new devDependencies `@types/pdfkit` and `unpdf` (test-only PDF text extraction).

**Spec:** `docs/superpowers/specs/2026-08-19-urtext-export-model-design.md` — the binding authority. Implementers read it before their task; where this plan and the spec disagree, the spec wins and the conflict is a ruling for the controller.

**Predecessors:** `2026-08-15-urtext-diff-review-core.md` (PR #1), `2026-08-16-urtext-analyzers.md` (PR #2), `2026-08-16-urtext-interpretation.md` (PR #3), all merged.

## Global Constraints

- Node 20+, ESM only; relative imports carry `.js` extensions.
- TypeScript `strict: true`; no `any` in exported signatures.
- **New runtime dependencies: `pdfkit` and nothing else.** It may be imported ONLY via dynamic `import()` inside the PDF path, so every run without `--export pdf` loads exactly what it loads today. `unpdf` and `@types/pdfkit` are devDependencies.
- **The model is the single source of layout and honesty truth; renderers are typesetters.** No renderer composes disclosure/partial/provenance/tier copy, decides ordering, or applies concealment. Renderers apply only format mechanics: HTML entity escaping, Markdown fence escalation, PDF typesetting — uniformly to ALL model-provided text.
- Concealment labeling (`conceal.ts`) is applied while building the model. Renderer input is already labeled.
- No claim ever renders as `verified`; model prose never renders without attribution; empty-lens copy is filter-shaped; a fact's file/line/evidence are never edited by rendering.
- urtext writes only inside `.urtext/` of the reviewed repository.
- **Refactor acceptance bar:** `renderTerminal` and `renderHtml` keep their exact public signatures, and every existing test passes with its expectations unchanged (imports in test files may be touched; expected strings may not).
- The comment contract, binding as in every prior plan: (1) a comment names a constant, never restates its value; (2) an invariant claim quotes its enforcing test verbatim — grep that the test exists and asserts it before writing the comment; (3) comments explain what code cannot show. `test/comment-contract.test.ts` mechanically rejects numerals colliding with `WEIGHTS` / `MAX_EVIDENCE` / `MAX_SIGNATURE_LENGTH` values in `src/` and `test/` comments — run it before every commit.
- Byte-check every changed file for NUL bytes before every commit:
  `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" <files>` must print `0`.
- Every behavior change lands with a test that fails before it. Run `npx vitest run` BARE and gate on its exit code — never through a pipe.

## File Structure

- Create: `src/report/model.ts` — `ReportModel` types + `buildReportModel`; `ReportMeta` moves here.
- Modify: `src/report/html.ts` — re-export `ReportMeta`; become a walker.
- Modify: `src/report/terminal.ts` — become a walker.
- Create: `src/report/markdown.ts` — `renderMarkdown(model)`.
- Create: `src/report/pdf.ts` — `renderPdf(model)`; `fonts/` (DejaVu TTFs + LICENSE).
- Modify: `src/cli.ts` — `--export`, export writing, `exportPaths` in `--json`.
- Modify: `package.json` — deps; `files` gains `"fonts"`.
- Tests: `test/report/model.test.ts`, `test/report/markdown.test.ts`, `test/report/pdf.test.ts`; extend `test/cli.test.ts`.

---

### Task 1: The report model

**Files:**
- Create: `src/report/model.ts`
- Modify: `src/report/html.ts` (move `ReportMeta` out; re-export it)
- Test: `test/report/model.test.ts`

**Interfaces:**
- Consumes: `Changeset`, `Finding`, `Tier` from `src/types.ts`; `labelConcealed` (the plain-text substitution) from `src/report/conceal.ts`; `deletedFilesNote`, `deletedTypeScriptFiles`, `suppressionNote` from `src/report/coverage.ts`.
- Produces (verbatim from the spec — later tasks rely on these exact names):

```ts
export type Lens = "narrative" | "effects" | "surface";

export interface EvidenceView { file: string; line: number; excerpt: string }

export interface ReachView {
  references: number;
  sites: EvidenceView[];
  overflow: number;
}

export interface ModelNoteView { model: string; text: string }

export interface FindingView {
  id: string;
  tier: Tier;
  glyph: string;
  lens: Lens;
  headline: string;
  body: string[];
  modelNote?: ModelNoteView;
  evidence: EvidenceView[];
  reach?: ReachView;
}

export interface ReportModel {
  scope: string;
  counts: { verified: number; inferred: number; model: number };
  provenance?: string;
  notes: string[];
  filterNote?: string;
  findings: FindingView[];
}

export interface ReportMeta {
  model?: string;
  warnings: string[];
  suppressed?: number;
}

export function buildReportModel(
  changeset: Changeset,
  findings: Finding[],
  meta: ReportMeta,
): ReportModel;
```

The composition rules are not new: they are the ones `terminal.ts` and `html.ts` each implement today. Read both renderers first and lift the SHARED truth into the model — headline text, body paragraphs, tier glyphs, the provenance gate (model name AND at least one inferred/model finding), the note list (warnings + untracked + deleted-file coverage), lens routing on the finding-id kind prefix, evidence caps, reach sentences. Where the two renderers phrase the same truth differently today, the model carries the pieces and each walker keeps its own phrasing in Tasks 2–3 — the model must make it IMPOSSIBLE to disagree on content (what is disclosed, what order, what tier), not force identical prose.

- [ ] **Step 1: Write the failing tests**

```ts
// test/report/model.test.ts
import { describe, expect, it } from "vitest";
import { buildReportModel } from "../../src/report/model.js";
import type { Changeset, Finding } from "../../src/types.js";

const changeset = (over: Partial<Changeset> = {}): Changeset => ({
  range: { from: "main", to: "HEAD", label: "vs main" },
  files: [],
  untrackedCount: 0,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding =>
  ({
    id: "effect_added:net",
    tier: "verified",
    title: "src/a.ts introduces a network effect",
    body: "This file previously had no network effect.",
    file: "src/a.ts",
    line: 3,
    score: 10,
    evidence: [{ file: "src/a.ts", line: 3, excerpt: "return fetch(url);" }],
    ...over,
  }) as Finding;

describe("buildReportModel", () => {
  it("routes findings to lenses by their id's kind prefix", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({ id: "effect_added:1" }),
        finding({ id: "guard_removed:2" }),
        finding({ id: "surface:export_added:3" }),
      ],
      { warnings: [] },
    );
    expect(m.findings.map((f) => f.lens)).toEqual([
      "effects",
      "effects",
      "surface",
    ]);
  });

  it("preserves rank order exactly", () => {
    const m = buildReportModel(
      changeset(),
      [finding({ id: "a", score: 1 }), finding({ id: "b", score: 99 })],
      { warnings: [] },
    );
    // The model does not re-rank: the findings array IS the ranking.
    expect(m.findings.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("labels concealing characters while building the model", () => {
    const m = buildReportModel(
      changeset(),
      [
        finding({
          evidence: [{ file: "src/a.ts", line: 3, excerpt: "a\u202Eb" }],
        }),
      ],
      { warnings: [] },
    );
    expect(m.findings[0].evidence[0].excerpt).toContain("[U+202E]");
    expect(m.findings[0].evidence[0].excerpt).not.toContain("\u202E");
  });

  it("gates provenance on a model name AND a model-derived tier", () => {
    const none = buildReportModel(changeset(), [finding()], {
      model: "claude-opus-5",
      warnings: [],
    });
    expect(none.provenance).toBeUndefined();
    const some = buildReportModel(
      changeset(),
      [finding({ tier: "inferred" })],
      { model: "claude-opus-5", warnings: [] },
    );
    expect(some.provenance).toContain("claude-opus-5");
  });

  it("carries each disclosure exactly once, in the field renderers must read it from", () => {
    const m = buildReportModel(
      changeset({ untrackedCount: 2 }),
      [finding()],
      { warnings: ["the surfaceAnalyzer analyzer failed"], suppressed: 3 },
    );
    expect(m.notes.some((n) => n.includes("surfaceAnalyzer"))).toBe(true);
    expect(m.notes.some((n) => n.includes("untracked"))).toBe(true);
    expect(m.filterNote).toContain("3");
    // The filter note is not a shortfall and must not sit among the notes.
    expect(m.notes.some((n) => n.includes("suppressed"))).toBe(false);
  });

  it("counts tiers from the findings themselves", () => {
    const m = buildReportModel(
      changeset(),
      [finding(), finding({ tier: "inferred" }), finding({ tier: "model" })],
      { warnings: [] },
    );
    expect(m.counts).toEqual({ verified: 1, inferred: 1, model: 1 });
  });
});
```

Adjust the `finding()` helper to the real `Finding` shape in `src/types.ts` (read it; do not guess fields). If a lens-routing prefix above does not match the real id scheme (`grep '"' src/score/index.ts` for the id composition), correct the TEST to the real prefixes — the routing table itself is lifted from `html.ts`, which already implements it.

- [ ] **Step 2: Run tests, verify they fail** — `npx vitest run test/report/model.test.ts` fails: module does not exist.

- [ ] **Step 3: Implement `src/report/model.ts`** — lift composition from `terminal.ts`/`html.ts` per the interfaces above. Move `ReportMeta` here; in `html.ts` replace the declaration with `export type { ReportMeta } from "./model.js";` so `cli.ts` and tests keep importing it from either place.

- [ ] **Step 4: Run the new tests AND the full suite** — new tests pass; full suite still green (nothing consumes the model yet, but the `ReportMeta` move touches html.ts).

- [ ] **Step 5: Comment-contract + NUL checks, then commit** — `feat(report): single report model as the source of layout and honesty truth`

### Task 2: Terminal walks the model

**Files:**
- Modify: `src/report/terminal.ts`
- Test: existing `test/report/terminal.test.ts` (expectations unchanged)

**Interfaces:**
- Consumes: `buildReportModel` and the view types from Task 1.
- Produces: `renderTerminal` with its EXACT current signature; output byte-identical wherever a test pins it.

- [ ] **Step 1: Reimplement** — `renderTerminal` builds the model, then walks it: glyph + headline + tier badge, body, model note, evidence lines, reach, notes, filter note, report path. Delete every line of composition logic the model now owns; what remains is spacing, indentation, and the walk.
- [ ] **Step 2: Run `npx vitest run test/report/terminal.test.ts test/cli.test.ts`** — green with zero expectation edits. Any mismatch is a bug in Task 1's lift, not a reason to edit a test; fix the model.
- [ ] **Step 3: Full suite, checks, commit** — `refactor(report): terminal renders by walking the report model`

### Task 3: HTML walks the model

**Files:**
- Modify: `src/report/html.ts`
- Test: existing `test/report/html.test.ts` (expectations unchanged)

Same shape as Task 2. `renderHtml` keeps its signature `(changeset, findings, meta)`; internally it builds the model and walks it. Entity escaping (`esc`/`visible`) stays in html.ts — it is format mechanics — but is now applied to model-provided text; `visiblePlain`-style concealment substitution must NOT be re-applied (the model did it; double labeling like `[U+202E]` → `[U+202E]` is idempotent for labels but the code must not depend on that — read what `conceal.ts` exposes and apply only the entity layer).

- [ ] **Step 1: Reimplement as a walker.**
- [ ] **Step 2: `npx vitest run test/report/html.test.ts`** — green, zero expectation edits.
- [ ] **Step 3: Full suite, checks, commit** — `refactor(report): html renders by walking the report model`

### Task 4: Markdown renderer

**Files:**
- Create: `src/report/markdown.ts`
- Test: `test/report/markdown.test.ts`

**Interfaces:**
- Consumes: `ReportModel` and view types from Task 1; `LENSES` order — export the lens display order from `model.ts` if Task 1 did not already (HTML consumes the same order; one constant).
- Produces: `export function renderMarkdown(model: ReportModel): string`.

Shape (spec section "Markdown renderer"): H1 `urtext review`; scope line; provenance and every note and the filter note as `>` blockquotes at the top; one H2 per lens in lens order; findings under their lens in rank order; per finding an H3 `<glyph> file:line — headline [tier]`, body paragraphs, model note as a blockquote whose first line is the attribution, evidence as one `file:line` line plus a fenced code block with a language guessed from the extension (`ts`/`tsx`, else no info string). A lens with no findings gets the model's filter-shaped empty-lens copy. Fence escalation: the fence is one backtick longer than the longest backtick run inside the excerpt, minimum three.

- [ ] **Step 1: Failing tests**

```ts
// test/report/markdown.test.ts — representative cases; keep the real-output
// test pattern used by test/report/html.test.ts (build a scratch repo, run
// the analyzers, render REAL findings) for at least one test.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/report/markdown.js";
// build a small model by hand with the Task 1 helper shapes

it("escalates the fence past any backtick run in the excerpt", () => {
  const md = renderMarkdown(modelWith({ excerpt: "const s = ```;" }));
  expect(md).toContain("````");        // four fences around a three-run
  expect(md).toMatch(/````[\s\S]*const s = ```;[\s\S]*````/);
});

it("keeps concealment labels verbatim", () => {
  const md = renderMarkdown(modelWith({ excerpt: "a[U+202E]b" }));
  expect(md).toContain("a[U+202E]b");
});

it("renders an empty lens with the filter-shaped copy, never a claim about the code", () => {
  const md = renderMarkdown(emptyLensModel());
  expect(md).toContain("Nothing in this range matched this view");
});

it("puts every disclosure above the first finding", () => {
  const md = renderMarkdown(modelWith({ note: "analyzer failed" }));
  expect(md.indexOf("analyzer failed")).toBeLessThan(md.indexOf("## "));
});
```

(Write `modelWith`/`emptyLensModel` helpers against the Task 1 types; copy the empty-lens copy string from the model, not from this plan.)

- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement `renderMarkdown`.**
- [ ] **Step 4: Run new tests + full suite.**
- [ ] **Step 5: Checks, commit** — `feat(report): markdown renderer walking the report model`

### Task 5: PDF renderer with embedded fonts

**Files:**
- Create: `src/report/pdf.ts`, `fonts/DejaVuSans.ttf`, `fonts/DejaVuSans-Bold.ttf`, `fonts/DejaVuSans-Oblique.ttf`, `fonts/DejaVuSansMono.ttf`, `fonts/LICENSE`
- Modify: `package.json` (dependencies `pdfkit`; devDependencies `@types/pdfkit`, `unpdf`; `files` gains `"fonts"`)
- Test: `test/report/pdf.test.ts`

**Interfaces:**
- Consumes: `ReportModel` from Task 1.
- Produces: `export async function renderPdf(model: ReportModel): Promise<Buffer>` — the ONLY place pdfkit is imported, dynamically: `const { default: PDFDocument } = await import("pdfkit");`

Fonts: DejaVu 2.37 — download `https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip`, take the four TTFs above and the bundle's LICENSE into `fonts/`. Resolve at runtime with `fileURLToPath(new URL("../../fonts/DejaVuSans.ttf", import.meta.url))` — correct from both `src/report/` and `dist/report/`. Document (comment + README install section) the coverage trade: Latin/Cyrillic/Greek, not CJK.

House style — read the sibling private project's `export-pdf.ts` as the reference implementation (structure only; that file's content model differs): title "urtext review"; bold-label meta block (Generated / Range / Model / Evidence counts), any `notes` line and the filter note whole-line bold; horizontal rule; findings as numbered sections in rank order, lens as a small gray caption; body in DejaVu Sans, evidence in DejaVu Sans Mono with a gray `file:line` label; model notes prefixed by their attribution; footer on every page: `Generated by urtext — every finding is labeled by its evidence tier` + page number.

- [ ] **Step 1: Failing tests** — using `unpdf`:

```ts
// test/report/pdf.test.ts
import { extractText, getDocumentProxy } from "unpdf";
import { renderPdf } from "../../src/report/pdf.js";

const textOf = async (buf: Buffer) => {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
};

it("carries the tier counts, disclosures, and evidence into extractable text", async () => {
  const text = await textOf(await renderPdf(fullModel()));
  expect(text).toContain("verified");
  expect(text).toContain("analyzer failed");        // a notes entry
  expect(text).toContain("suppressed");             // the filter note
  expect(text).toContain("return fetch(url);");     // an evidence excerpt
  expect(text).toContain("[U+202E]");               // concealment label survives
});

it("renders every finding — none silently truncated", async () => {
  const model = manyFindingsModel();                // more than one page's worth
  const text = await textOf(await renderPdf(model));
  for (const f of model.findings) expect(text).toContain(f.id ? f.headline.slice(0, 40) : "");
});
```

(Verify `unpdf`'s current API surface against its README in node_modules before writing; adjust call shapes to what is actually exported.)

- [ ] **Step 2: Run, verify failure** (module missing).
- [ ] **Step 3: `npm install pdfkit` + dev deps; download and commit fonts + LICENSE; implement `renderPdf`.**
- [ ] **Step 4: Run new tests + full suite; also assert `git check-ignore` does NOT ignore `fonts/` and `npm pack --dry-run` lists the four TTFs.**
- [ ] **Step 5: Checks, commit** — `feat(report): pdf renderer with embedded DejaVu, walking the report model`

### Task 6: CLI wiring

**Files:**
- Modify: `src/cli.ts`, `src/report/write.ts` (if the writing helper lives there), README.md (usage + install-section trade note)
- Test: extend `test/cli.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` (Task 4), `renderPdf` (Task 5), `buildReportModel` (Task 1).
- Produces: `--export md,pdf` flag; files beside the HTML report sharing its timestamp stem (`review-<stamp>.md` / `.pdf`); one printed path line per export; `exportPaths: { md?: string; pdf?: string }` in `--json`.

Behavior (spec section "CLI"): unknown export value → usage error naming valid values, same style as existing flag errors; export render/write failure → warning, everything else untouched; no exports on nonzero-exit runs (same rule as the HTML report); `--open` unchanged. Build the model ONCE per run and hand the same instance to html/md/pdf.

- [ ] **Step 1: Failing tests** — in `test/cli.test.ts`, following its repo-fixture pattern: (a) `--export md,pdf --json` yields `exportPaths.md`/`.pdf`, both files exist, stems match `reportPath`'s; (b) `--export docx` exits with the usage error naming `md` and `pdf`; (c) a stubbed failing renderer degrades to a warning with exit code preserved (follow the existing "still returns the review's findings when the report fails to write" test's stubbing approach); (d) `--export md` alone does not create a `.pdf`.
- [ ] **Step 2: Run, verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Full suite green; run the tool on its own branch: `npx tsx src/bin.ts review master --no-llm --export md,pdf` exits 0 and writes all three files.**
- [ ] **Step 5: Checks, commit** — `feat(cli): --export md,pdf`

---

## Self-review notes

Spec coverage: model (§ report model, § honesty split → Task 1), terminal/HTML refactor (§ renderers → Tasks 2–3), Markdown (§ markdown → Task 4), PDF incl. fonts and lazy loading (§ pdf → Task 5), CLI/flag/failure/json (§ cli → Task 6), testing section distributed into each task's steps. Out-of-scope items (DOCX, CJK fonts, retention) appear in no task. Type names in Tasks 2–6 match Task 1's `Produces` block verbatim. No placeholders: every code step contains real code or names the exact reference file to read.
