# Intent-Gap Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a short index above the ranked findings naming the findings the model marked `beyondIntent`, leaving the ranked list untouched and complete.

**Architecture:** One new model field (`intentGap: IntentGapEntry[]`) plus one attribution string, both derived inside `buildReportModel` where id-prefix parsing already lives. Five surfaces render what the model decides; none of them decides anything. Nothing is reordered, filtered, or predicted — the marks already exist and already render as per-finding badges; this aggregates them into one block.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, pdfkit, unpdf (PDF text extraction in tests).

**Spec:** `docs/superpowers/specs/2026-08-30-urtext-intent-gap-index-design.md` — read it first. It records two rejected predecessors and three corrected drafts of this one; the corrections are load-bearing, not history.

## Global Constraints

- **No index entry can ever be `verified`.** The mark reaches a fact-backed finding only through the claim-attachment path, which forces `inferred`. A test asserting on `verified` asserts on a state production cannot reach.
- **Ordering is an explicit two-pass rule**, not a filter in place: (1) fact-backed entries in `findings` order, (2) standalone model entries in `findings` order. `findings` sorts band-before-score, so a standalone claim outranks a fact-backed context finding there — filtering in place would print `[model]` above `[inferred]`.
- **All model prose is segmented.** `label` is `ConcealSegment[]`, never a plain string — a standalone claim's summary is model prose from a network response.
- **The model owns content decisions** (`src/report/model.ts:16-42`). A renderer applies format mechanics and never makes a decision of its own — no surface may omit, reorder, or conditionally drop entries.
- **All five surfaces**: terminal, HTML, Markdown, PDF, `--json`. A model field rendered by four of them is a gap this project has already paid for twice (`kindNotes`, `untrackedCount`).
- **New reader-facing copy goes through the copy guard.** `FORBIDDEN` = `unsanctioned`, `unauthorized`, `approved`, `permission`, `forbidden`, `allowed` (`test/report/copy-guard.test.ts:25-32`).
- **Heading copy:** `Not described by this change's messages (N)`.
- Every test must fail if the production change is reverted.

> **Note on line numbers:** the spec's citations into `src/report/model.ts` predate commit `3546acc`, which added ~20 lines. This plan uses post-`3546acc` anchors. Verify before editing; do not trust either document's numbers over the file.

---

### Task 1: The `IntentGapEntry` type and its derivation

The core. Everything else renders what this produces.

**Files:**
- Modify: `src/report/model.ts` (type near `FindingView` ~line 140; derivation and assignment in `buildReportModel`, ~lines 737-760)
- Test: `test/report/model.test.ts`

**Interfaces:**
- Consumes: `Finding` (`src/types.ts:155`), `Tier`, `ConcealSegment`, existing private `kindOf` (`model.ts:511`), `GROUP_SUFFIX` (`model.ts:426`), `segmentConcealed` (`./conceal.js`).
- Produces: `export interface IntentGapEntry { id: string; tier: Tier; label: ConcealSegment[]; file: string; line: number }` and `ReportModel.intentGap: IntentGapEntry[]` — **always present**, `[]` when nothing is marked.

**Label rule** (three cases, in this order):
1. Group finding — id prefix ends with `GROUP_SUFFIX` → `finding.title`. Calling a seven-export group `export_added` beside one member's `file:line` would misdescribe it.
2. Standalone claim — `kindOf(id)` is `undefined` → `finding.title`, which `reconcile.ts:197` sets to `claim.summary`.
3. Fact-backed — otherwise → `kindOf(id)`.

- [ ] **Step 1: Write the failing ordering test**

This is the fixture that broke the first draft. A defect-band standalone claim sorts **above** a context-band `export_added` in `findings`; in the index the export must come first.

```typescript
it("puts fact-backed entries before standalone ones, against findings order", () => {
  // `findings` sorts band before score, and a standalone claim lands in the
  // defect band while `export_added` is a context kind — so in `findings` the
  // claim is first. The index must invert that. A fixture using a
  // defect-band fact-backed finding would pass under this rule and under the
  // retracted filter-in-place one, and so would prove nothing.
  const m = buildReportModel(
    changeset(),
    [
      finding({
        id: "claim:0:c1",
        tier: "model",
        file: "src/sync.ts",
        line: 64,
        title: "retry loop may not terminate",
        score: 3,
        evidence: [],
        beyondIntent: true,
      }),
      finding({
        id: "export_added:src/admin.ts:handler",
        tier: "inferred",
        file: "src/admin.ts",
        line: 88,
        title: "handler is newly exported",
        score: 40,
        beyondIntent: true,
      }),
    ],
    { warnings: [] },
  );
  expect(m.intentGap.map((e) => e.id)).toEqual([
    "export_added:src/admin.ts:handler",
    "claim:0:c1",
  ]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/report/model.test.ts -t "puts fact-backed entries before standalone"`
Expected: FAIL — `m.intentGap` is undefined.

- [ ] **Step 3: Add the type and the derivation**

Add beside `FindingView` in `src/report/model.ts`:

```typescript
/**
 * One entry in the intent-gap index: a finding the model marked as not
 * accounted for by the range's messages.
 *
 * `file` and `line` stay structured rather than pre-joined into a display
 * string, so `--json` consumers get the shape `findings` gives them and each
 * surface formats the location in its own idiom.
 */
export interface IntentGapEntry {
  /** The `findings` entry this points at, so a --json consumer can join. */
  id: string;
  tier: Tier;
  /**
   * What the entry is: a fact-backed finding's kind, or a standalone claim's
   * summary. Segmented, never a plain string — for a standalone claim this is
   * model prose from a network response, and every content field carries
   * `ConcealSegment[]` so no raw concealing character reaches a surface.
   */
  label: ConcealSegment[];
  file: string;
  line: number;
}
```

Add the derivation above the `const model: ReportModel = {` assembly:

```typescript
/**
 * The index, assembled in two passes, each preserving `findings` order.
 *
 * Not a filter in place. The final sort keys band before score, and a
 * standalone claim's id belongs to no fact, so it takes the defect band by
 * default and sits above every context row regardless of score. Filtering
 * `findings` where they stand would therefore print an evidence-free `model`
 * entry above an analyzer-corroborated `inferred` one, in the report's prime
 * position — the inversion this index exists to avoid.
 *
 * The two orders differ deliberately: `findings` is ordered for triage, where
 * a claim alleging a problem belongs in the defect band; the index is ordered
 * by what a reader can check, where evidence leads.
 */
function intentGapFor(findings: Finding[]): IntentGapEntry[] {
  const marked = findings.filter((f) => f.beyondIntent);
  // A group id keeps its kind prefix, so `kindOf` returns a kind for it and
  // it belongs in pass one — a group is fact-backed. Only its *label* is
  // special. Splitting on `isGroup` here instead would push groups into the
  // standalone pass and order the index wrongly whenever a marked claim was
  // absorbed into one.
  const factBacked = (f: Finding): boolean => kindOf(f.id) !== undefined;
  const entry = (f: Finding): IntentGapEntry => ({
    id: f.id,
    tier: f.tier,
    label: segmentConcealed(labelFor(f)),
    file: f.file,
    line: f.line,
  });
  return [
    ...marked.filter(factBacked).map(entry),
    ...marked.filter((f) => !factBacked(f)).map(entry),
  ];
}

/** A group id's kind prefix carries `GROUP_SUFFIX`; `kindOf` strips it. */
function isGroup(id: string): boolean {
  const colon = id.indexOf(":");
  return colon >= 0 && id.slice(0, colon).endsWith(GROUP_SUFFIX);
}

/**
 * A fact-backed finding is named by its kind. A group and a standalone claim
 * are both named by their title: a group's stripped member kind would
 * misdescribe it, and a standalone claim's title is its summary
 * (`../score/reconcile.ts`, where `title: claim.summary`).
 */
function labelFor(f: Finding): string {
  if (isGroup(f.id)) return f.title;
  return kindOf(f.id) ?? f.title;
}
```

Add to the `ReportModel` interface, beside `kindNotes`:

```typescript
  /**
   * The findings the model marked as not accounted for by this range's
   * messages, fact-backed entries first. Always present, `[]` included, so a
   * consumer reads it without branching on the key.
   *
   * No entry can be `verified`: the mark reaches a fact-backed finding only
   * through the claim-attachment path, which forces `inferred`. "Marked and
   * verified" is a contradiction, not a gap — a `verified` finding is one the
   * model said nothing about, and the mark is something the model says.
   */
  intentGap: IntentGapEntry[];
```

And in the assembly object, beside `kindNotes: kindNotesFor(findings),`:

```typescript
    intentGap: intentGapFor(findings),
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/report/model.test.ts -t "puts fact-backed entries before standalone"`
Expected: PASS

- [ ] **Step 5: Write the remaining derivation tests**

```typescript
it("is an empty array, not absent, when nothing is marked", () => {
  const m = buildReportModel(changeset(), [finding()], { warnings: [] });
  expect(m.intentGap).toEqual([]);
});

it("preserves findings order within each pass", () => {
  // `evidence: undefined` would override the fixture default rather than fall
  // back to it, so the empty array is spread in only for the model tier.
  const mk = (id: string, tier: Tier, score: number) =>
    finding({ id, tier, score, beyondIntent: true, ...(tier === "model" ? { evidence: [] } : {}) });
  const m = buildReportModel(
    changeset(),
    [
      mk("effect_added:a.ts:network", "inferred", 60),
      mk("claim:0:c1", "model", 3),
      mk("guard_removed:b.ts:auth", "inferred", 50),
      mk("claim:0:c2", "model", 2),
    ],
    { warnings: [] },
  );
  expect(m.intentGap.map((e) => e.id)).toEqual([
    "effect_added:a.ts:network",
    "guard_removed:b.ts:auth",
    "claim:0:c1",
    "claim:0:c2",
  ]);
});

it("labels a fact-backed entry with its kind and a standalone one with its summary", () => {
  const m = buildReportModel(
    changeset(),
    [
      finding({ id: "guard_removed:b.ts:auth", tier: "inferred", beyondIntent: true }),
      finding({
        id: "claim:0:c1",
        tier: "model",
        title: "retry loop may not terminate",
        evidence: [],
        beyondIntent: true,
      }),
    ],
    { warnings: [] },
  );
  expect(plainText(m.intentGap[0].label)).toBe("guard_removed");
  expect(plainText(m.intentGap[1].label)).toBe("retry loop may not terminate");
});

it("labels a group with the group finding's title, not its stripped member kind", () => {
  // Calling a seven-export group `export_added` beside one member's file:line
  // would misdescribe it.
  const m = buildReportModel(
    changeset(),
    [
      finding({
        id: "export_added_group:src/api.ts",
        tier: "inferred",
        title: "7 exports added in src/api.ts",
        beyondIntent: true,
      }),
    ],
    { warnings: [] },
  );
  expect(plainText(m.intentGap[0].label)).toBe("7 exports added in src/api.ts");
});

it("carries label as segments, so a bidirectional override cannot reach a surface raw", () => {
  const m = buildReportModel(
    changeset(),
    [
      finding({
        id: "claim:0:c1",
        tier: "model",
        title: "drops retries‮for admins",
        evidence: [],
        beyondIntent: true,
      }),
    ],
    { warnings: [] },
  );
  expect(plainText(m.intentGap[0].label)).toContain("[U+202E]");
  expect(plainText(m.intentGap[0].label)).not.toContain("‮");
});

it("points at every marked finding exactly once, and drops none from findings", () => {
  const all = [
    finding({ id: "effect_added:a.ts:network", tier: "inferred", beyondIntent: true }),
    finding({ id: "guard_removed:b.ts:auth", tier: "verified" }),
    finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true }),
  ];
  const m = buildReportModel(changeset(), all, { warnings: [] });
  const ids = m.intentGap.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(m.findings).toHaveLength(3);
  for (const id of ids) expect(m.findings.some((f) => f.id === id)).toBe(true);
});
```

- [ ] **Step 6: Run them, fix what fails, confirm the file is green**

Run: `npx vitest run test/report/model.test.ts`
Expected: PASS. `plainText` is already exported from `model.ts` and already imported by this test file — check the import list before adding it.

- [ ] **Step 7: Commit**

```bash
git add src/report/model.ts test/report/model.test.ts
git commit -m "feat: derive the intent-gap index in the report model"
```

---

### Task 2: The index attribution string

**Files:**
- Modify: `src/report/model.ts` (field beside `beyondIntentLegend`; assignment in the conditional tail, ~line 755)
- Test: `test/report/model.test.ts`

**Interfaces:**
- Consumes: `UNNAMED_MODEL` (`model.ts:407`), `MODEL_CAUTION_STANDALONE` (`model.ts:410`), `ReportModel.intentGap` from Task 1.
- Produces: `ReportModel.intentGapAttribution?: string` — present **exactly when** `intentGap` holds a standalone entry.

Why gated on standalone entries only: a `[model]` tag in the index is a less-attributed place for the same sentence that `modelNote` carries with attribution elsewhere, and a bare tag is weaker than `MODEL_CAUTION_STANDALONE` requires. A fact-backed entry's label is a kind, not model prose, so it needs no such caution.

- [ ] **Step 1: Write the failing test**

```typescript
it("attributes the index exactly when it carries a standalone claim", () => {
  const standalone = finding({
    id: "claim:0:c1",
    tier: "model",
    evidence: [],
    beyondIntent: true,
  });
  const factBacked = finding({
    id: "guard_removed:b.ts:auth",
    tier: "inferred",
    beyondIntent: true,
  });
  const withClaim = buildReportModel(changeset(), [standalone], {
    warnings: [],
    model: "claude-opus-5",
  });
  expect(withClaim.intentGapAttribution).toContain("claude-opus-5");
  expect(withClaim.intentGapAttribution).toContain(MODEL_CAUTION_STANDALONE);

  const withoutClaim = buildReportModel(changeset(), [factBacked], {
    warnings: [],
    model: "claude-opus-5",
  });
  expect(withoutClaim.intentGapAttribution).toBeUndefined();
});

it("names an unrecorded model rather than dropping attribution", () => {
  // Visibly incomplete attribution beats absent attribution.
  const m = buildReportModel(
    changeset(),
    [finding({ id: "claim:0:c1", tier: "model", evidence: [], beyondIntent: true })],
    { warnings: [] },
  );
  expect(m.intentGapAttribution).toContain(UNNAMED_MODEL);
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run test/report/model.test.ts -t "attributes the index"`
Expected: FAIL — `intentGapAttribution` is undefined in the positive case.

- [ ] **Step 3: Implement**

Add to `ReportModel`, beside `beyondIntentLegend`:

```typescript
  /**
   * Whose judgement the index is, present exactly when `intentGap` holds a
   * standalone entry. A standalone claim's summary appearing in the index is
   * the same sentence `modelNote` carries with attribution elsewhere, in a
   * less-attributed place, and a bare `[model]` tag is weaker than
   * `MODEL_CAUTION_STANDALONE` requires. Every surface renders this
   * unconditionally when present.
   */
  intentGapAttribution?: string;
```

In the conditional tail of `buildReportModel`, beside the `beyondIntentLegend` assignment:

```typescript
  if (model.intentGap.some((e) => kindOf(e.id) === undefined)) {
    model.intentGapAttribution = `${modelName ?? UNNAMED_MODEL} — ${MODEL_CAUTION_STANDALONE}`;
  }
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run test/report/model.test.ts`
Expected: PASS. Add `MODEL_CAUTION_STANDALONE` and `UNNAMED_MODEL` to the test file's imports from `../../src/report/model.js` if not already there.

- [ ] **Step 5: Commit**

```bash
git add src/report/model.ts test/report/model.test.ts
git commit -m "feat: attribute the intent-gap index when it carries a model claim"
```

---

### Task 3: Terminal and Markdown rendering

Both are flat-text surfaces that render the index as a block above the findings list. Grouped because a reviewer accepting one accepts the other.

**Files:**
- Modify: `src/report/terminal.ts` (after the `beyondIntentLegend`/`kindNotes` header block, ~line 163, before the `out.push("")` that separates header from findings)
- Modify: `src/report/markdown.ts` (after the `beyondIntentLegend` block ~line 186, before the `for (const { key, label } of LENSES)` loop)
- Test: `test/report/terminal.test.ts`, `test/report/markdown.test.ts`

**Interfaces:**
- Consumes: `ReportModel.intentGap`, `ReportModel.intentGapAttribution`, `plainText`.
- Produces: no exports. Heading text `Not described by this change's messages (N)`.

- [ ] **Step 1: Write both failing tests**

In `test/report/terminal.test.ts`:

```typescript
it("prints the intent-gap index above the findings, with tier and location", () => {
  const m = buildReportModel(
    changeset(),
    [finding({ id: "guard_removed:src/auth.ts:session", tier: "inferred", file: "src/auth.ts", line: 142, beyondIntent: true })],
    { warnings: [] },
  );
  const out = renderTerminal(m);
  expect(out).toContain("Not described by this change's messages (1)");
  expect(out).toContain("guard_removed");
  expect(out).toContain("src/auth.ts:142");
  expect(out.indexOf("Not described by this change's messages")).toBeLessThan(
    out.indexOf("guard_removed  ["),
  );
});

it("prints no index heading when nothing is marked", () => {
  const m = buildReportModel(changeset(), [finding()], { warnings: [] });
  expect(renderTerminal(m)).not.toContain("Not described by this change's messages");
});
```

In `test/report/markdown.test.ts`, the same two assertions against `renderMarkdown(m)`.

- [ ] **Step 2: Run both and watch them fail**

Run: `npx vitest run test/report/terminal.test.ts test/report/markdown.test.ts -t "intent-gap index"`
Expected: FAIL — heading absent.

- [ ] **Step 3: Implement terminal**

In `src/report/terminal.ts`, after the `kindNotes` loop and before `out.push("")`:

```typescript
    // Above the findings and below the legend that explains the badge: the
    // reader meets the mark's meaning before the block that aggregates it.
    if (m.intentGap.length > 0) {
      out.push(`  Not described by this change's messages (${m.intentGap.length})`);
      for (const e of m.intentGap) {
        out.push(`    · [${e.tier}] ${plainText(e.label)}  ${e.file}:${e.line}`);
      }
      if (m.intentGapAttribution) out.push(`    ${m.intentGapAttribution}`);
    }
```

- [ ] **Step 4: Implement markdown**

In `src/report/markdown.ts`, after the `beyondIntentLegend` block and before the `LENSES` loop:

```typescript
  if (model.intentGap.length > 0) {
    const rows = model.intentGap.map(
      (e) => `- \`[${e.tier}]\` ${plainText(e.label)} — \`${e.file}:${e.line}\``,
    );
    blocks.push(`## Not described by this change's messages (${model.intentGap.length})`);
    blocks.push(rows.join("\n"));
    if (model.intentGapAttribution) blocks.push(quote([model.intentGapAttribution]));
  }
```

- [ ] **Step 5: Run and watch pass**

Run: `npx vitest run test/report/terminal.test.ts test/report/markdown.test.ts`
Expected: PASS. Confirm `plainText` is imported in both renderers — terminal already uses it; check markdown.

- [ ] **Step 6: Commit**

```bash
git add src/report/terminal.ts src/report/markdown.ts test/report/terminal.test.ts test/report/markdown.test.ts
git commit -m "feat: render the intent-gap index on the terminal and in Markdown"
```

---

### Task 4: HTML rendering

**Files:**
- Modify: `src/report/html.ts` (block built near the other header pieces ~line 457-470; interpolated into the returned array ~line 476, above the lens tabs/sections built at ~680-690)
- Test: `test/report/html.test.ts`

**Interfaces:**
- Consumes: `ReportModel.intentGap`, `ReportModel.intentGapAttribution`, `esc`, `plainText`.
- Produces: no exports. Uses existing `badge badge-intent` styling plus a new `.intent-gap` block rule.

The HTML report has a three-pane lens structure (`LENSES`, `model.ts:331`), so "above the findings list" names no single place. The index renders **above the lens panes as one block spanning them**, because it indexes findings across all three.

- [ ] **Step 1: Write the failing test**

```typescript
it("renders the index above the lens panes, spanning them", () => {
  const m = buildReportModel(
    changeset(),
    [finding({ id: "guard_removed:src/auth.ts:session", tier: "inferred", file: "src/auth.ts", line: 142, beyondIntent: true })],
    { warnings: [] },
  );
  const html = renderHtml(m);
  expect(html).toContain("Not described by this change&#39;s messages (1)");
  // Above the panes, not inside one.
  expect(html.indexOf("intent-gap")).toBeLessThan(html.indexOf('class="tabs"'));
});

it("renders no index block when nothing is marked", () => {
  const m = buildReportModel(changeset(), [finding()], { warnings: [] });
  expect(renderHtml(m)).not.toContain("intent-gap");
});
```

Confirm the tabs container's actual class by reading `html.ts` around line 680 before asserting on it; substitute the real selector.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/report/html.test.ts -t "index above the lens panes"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Beside the `coverage`/`unanalyzed` block construction:

```typescript
  const intentGap =
    m.intentGap.length > 0
      ? `<section class="intent-gap"><h2>${esc(
          `Not described by this change's messages (${m.intentGap.length})`,
        )}</h2><ul>${m.intentGap
          .map(
            (e) =>
              `<li><span class="badge badge-${e.tier}">${esc(e.tier)}</span> ` +
              `${esc(plainText(e.label))} <span class="loc">${esc(`${e.file}:${e.line}`)}</span></li>`,
          )
          .join("")}</ul>${
          m.intentGapAttribution
            ? `<p class="attribution">${esc(m.intentGapAttribution)}</p>`
            : ""
        }</section>`
      : "";
```

Interpolate `intentGap` into the returned array immediately before the element that opens the lens panes. Add to the stylesheet, beside the `.coverage` rule:

```css
.intent-gap { margin: 1.2rem 0; padding: .8rem 1rem; border: 1px solid var(--rule); border-radius: 4px; }
.intent-gap h2 { font-size: .95rem; margin: 0 0 .5rem; }
.intent-gap ul { list-style: none; margin: 0; padding: 0; }
```

Use the variable names the existing stylesheet actually defines — read the `:root` block first rather than assuming `--rule` exists.

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run test/report/html.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report/html.ts test/report/html.test.ts
git commit -m "feat: render the intent-gap index above the HTML lens panes"
```

---

### Task 5: PDF rendering

**Files:**
- Modify: `src/report/pdf.ts` (after the notes/disclosure block ~lines 233-245, before the findings section)
- Test: `test/report/pdf.test.ts`

**Interfaces:**
- Consumes: `ReportModel.intentGap`, `ReportModel.intentGapAttribution`, existing `SANS`, `META_SIZE`, `strongLine`.
- Produces: no exports.

Placed above the findings section and **below the notes**, so a partial-review disclosure is never pushed below a block that is not itself a disclosure.

- [ ] **Step 1: Write the failing test**

```typescript
it("places the index below the notes and above the findings", async () => {
  const m = buildReportModel(
    changeset(),
    [finding({ id: "guard_removed:src/auth.ts:session", tier: "inferred", file: "src/auth.ts", line: 142, beyondIntent: true })],
    { warnings: ["the surfaceAnalyzer analyzer failed"] },
  );
  const pdf = await getDocumentProxy(new Uint8Array(await renderPdf(m)));
  const { text } = await extractText(pdf, { mergePages: true });
  const flat = text.replace(/\s+/g, " ");
  expect(flat).toContain("Not described by this change's messages (1)");
  expect(flat.indexOf("surfaceAnalyzer")).toBeLessThan(
    flat.indexOf("Not described by this change's messages"),
  );
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/report/pdf.test.ts -t "below the notes and above the findings"`
Expected: FAIL

- [ ] **Step 3: Implement**

After the `distributionNote` block in `src/report/pdf.ts`:

```typescript
    if (model.intentGap.length > 0) {
      strongLine(doc, `Not described by this change's messages (${model.intentGap.length})`);
      for (const e of model.intentGap) {
        doc
          .font(SANS)
          .fontSize(META_SIZE)
          .text(`[${e.tier}] ${plainText(e.label)}  ${e.file}:${e.line}`);
      }
      if (model.intentGapAttribution) {
        doc.font(SANS).fontSize(META_SIZE).text(model.intentGapAttribution);
      }
    }
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run test/report/pdf.test.ts`
Expected: PASS. Import `plainText` in `pdf.ts` if it is not already imported.

- [ ] **Step 5: Commit**

```bash
git add src/report/pdf.ts test/report/pdf.test.ts
git commit -m "feat: render the intent-gap index in the PDF export"
```

---

### Task 6: `--json` emission and the model-keys guard

**Files:**
- Modify: `src/cli.ts` (the `--json` object, beside `kindNotes: jsonModel.kindNotes,` ~line 665)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `jsonModel.intentGap`, `jsonModel.intentGapAttribution`.
- Produces: top-level `intentGap` key (always present) and `intentGapAttribution` (present when the model carries it).

Adding `intentGap` to `ReportModel` will trip the guard *"accounts for every model field in the JSON object, or exempts it by name"*. That is the guard working — the decision is forced rather than defaulted. Emit it; do **not** add it to `EXEMPT`. `intentGapAttribution` is conditionally assigned, so the guard cannot see it on an all-TypeScript fixture; emit it and add no exemption.

- [ ] **Step 1: Write the failing test**

```typescript
it("emits the intent-gap index under --json, always present", async () => {
  const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
  const parsed = JSON.parse(r.output);
  // A --no-llm run makes no claims, so nothing is marked — but the key is
  // present so a consumer reads it without branching.
  expect(parsed.intentGap).toEqual([]);
  expect(parsed.intentGapAttribution).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/cli.test.ts -t "emits the intent-gap index"`
Expected: FAIL — `parsed.intentGap` is undefined.

- [ ] **Step 3: Implement**

In the `--json` object in `src/cli.ts`, beside `kindNotes`:

```typescript
          // The findings the model marked as unaccounted for by this range's
          // messages. Always present, empty included, by the same rule as
          // `kindNotes` above it. A consumer joins each entry's `id` back to
          // `findings`; nothing is removed from `findings` to build it.
          intentGap: jsonModel.intentGap,
          ...(jsonModel.intentGapAttribution
            ? { intentGapAttribution: jsonModel.intentGapAttribution }
            : {}),
```

- [ ] **Step 4: Run the whole cli suite**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS, including the model-keys guard. If the guard reports `intentGap` unaccounted, the emission above is missing or misnamed — fix the emission, not the guard.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: emit the intent-gap index under --json"
```

---

### Task 7: Cross-surface guarantees and the real-path test

The tests that can only be written once every surface exists, plus the one that must not use fixtures.

**Files:**
- Modify: `test/report/copy-guard.test.ts`, `test/cli.test.ts`, `README.md`
- Test: as above

**Interfaces:**
- Consumes: everything from Tasks 1-6, `reconcile` (`src/score/reconcile.js`), the parameterized `surfaces(m)` helper already in `copy-guard.test.ts`.
- Produces: no exports.

- [ ] **Step 1: Write the real-path test**

This repository's banding bug shipped precisely because a unit test over `rank` passed while the path a review actually takes was never exercised. At least one test must drive `reconcile` → `buildReportModel` rather than hand-built findings.

```typescript
it("produces no verified index entry, through the real reconcile path", () => {
  // Facts and a claim that corresponds to one of them, reconciled the way a
  // review reconciles them — not hand-assembled findings. Pins the tier
  // chain rather than the fixture builder.
  const facts = [
    makeFact({
      kind: "guard_removed",
      id: "guard_removed:src/auth.ts:session",
      detail: {},
      evidence: [{ file: "src/auth.ts", line: 142, excerpt: "if (!session) return;" }],
    }),
  ];
  const claims = [
    {
      summary: "the session guard is gone",
      reasoning: "Requests now reach the handler unauthenticated.",
      file: "src/auth.ts",
      line: 142,
      severity: 0.9,
      correspondsTo: "guard_removed:src/auth.ts:session",
      beyondIntent: true,
    },
  ];
  const findings = reconcile(facts, claims, () => {});
  const m = buildReportModel(changeset(), findings, { warnings: [], model: "claude-opus-5" });
  expect(m.intentGap.length).toBeGreaterThan(0);
  for (const e of m.intentGap) expect(e.tier).not.toBe("verified");
});
```

Read `reconcile`'s real signature and `makeFact`'s real input shape before writing this — the shapes above are indicative, and a test built on a guessed signature proves nothing. Adjust to the actual API.

- [ ] **Step 2: Run it and watch it fail or pass for the right reason**

Run: `npx vitest run test/report/model.test.ts -t "through the real reconcile path"`
If it passes immediately, confirm it has teeth: temporarily change `intentGapFor` to include unmarked findings, watch it fail, restore.

- [ ] **Step 3: Add the all-surfaces test to `copy-guard.test.ts`**

The `surfaces(m)` helper is already parameterized. Its module-level `findings` fixture already carries two `beyondIntent` findings, so `model` already has a non-empty `intentGap`.

```typescript
describe("the intent-gap index", () => {
  it("appears on all five surfaces", async () => {
    expect(model.intentGap.length).toBeGreaterThan(0);
    const heading = `Not described by this change's messages (${model.intentGap.length})`;
    for (const [name, rendered] of await surfaces()) {
      expect(scannable(rendered).includes(heading), `${name} omits the index`).toBe(true);
    }
  });

  it("carries its attribution on every surface that shows a model claim", async () => {
    expect(model.intentGapAttribution).toBeDefined();
    for (const [name, rendered] of await surfaces()) {
      expect(
        scannable(rendered).includes(scannable(model.intentGapAttribution ?? "")),
        `${name} omits the index attribution`,
      ).toBe(true);
    }
  });
});
```

The HTML surface escapes `'` to `&#39;`, so the heading contains an apostrophe that will not match raw. Either assert on an apostrophe-free fragment (`Not described by this change`) or compare per-surface with escaping applied. Do not reword the heading to dodge this — the spec fixes the copy.

- [ ] **Step 4: Add the `--no-llm` end-to-end test to `test/cli.test.ts`**

```typescript
it("renders no index under --no-llm, and still says the model was not asked", async () => {
  // The last clause guards a future change that removes the disclosure this
  // design's argument for adding no new copy depends on.
  const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
  expect(r.output).not.toContain("Not described by this change");
  expect(r.output).toContain("--no-llm was set, so the model was not asked");
});
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass, including the copy guard over the new heading and attribution.

- [ ] **Step 6: Document the key requirement in `README.md`**

Add one sentence where the README describes `--no-llm` or the API key: the index requires a key, because it collects marks the model makes. This documents behaviour the report already discloses rather than compensating for silence.

- [ ] **Step 7: Commit**

```bash
git add test/report/copy-guard.test.ts test/report/model.test.ts test/cli.test.ts README.md
git commit -m "test: pin the intent-gap index across every surface and the real path"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the field and its derivation → Task 1; the ordering rule → Task 1 Step 1; groups → Task 1 Step 5; attribution → Task 2; the five surfaces → Tasks 3-6; `--no-llm` → Task 7 Step 4; the testing list → distributed across Tasks 1, 2 and 7. The one spec item deliberately **not** implemented is any new `--no-llm` copy, which the spec argues against.

**Known gaps the executor must close rather than trust:**
- Task 4 asserts on the HTML tabs container's class and on a CSS variable (`--rule`); both must be read from `html.ts` first.
- Task 7 Step 1 uses indicative shapes for `reconcile` and `makeFact`; both must be read before writing.
- All `model.ts` line numbers postdate commit `3546acc` and will drift again as tasks land. Anchor on symbol names.

**Type consistency.** `IntentGapEntry` is used with the same five fields in Tasks 1, 3, 4, 5 and 6. `intentGap` is `IntentGapEntry[]` everywhere; `intentGapAttribution` is `string | undefined` everywhere. `labelFor` and `isGroup` are private to `model.ts` and referenced only in Task 1.

**One correction made while drafting:** an earlier version of Task 1 Step 3 split groups into the standalone pass by testing `isGroup` in the partition. A group id keeps its kind prefix, so `kindOf` returns a kind for it and it belongs in pass one; only its *label* is special. The plan now carries the correct partition, with the distinction stated as a comment in the code an executor will paste, because it is exactly the kind of thing that passes review unnoticed.
