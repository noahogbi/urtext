# Urtext Interpretation & Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the design — add the model interpretation stage, make all three evidence tiers real, and ship the HTML report — so that `urtext review` answers "what changed that matters" in prose a human reads, with every claim labelled by the kind of evidence behind it.

**Architecture:** The deterministic pipeline is unchanged and remains the authority. A new stage sends the changeset plus the analyzers' facts to Claude, which returns structured claims; a pure reconciler merges facts and claims into findings and assigns each a tier. The model can add interpretation and it can be wrong, but it can never overwrite a fact. Without an API key, or with `--no-llm`, the stage is skipped and the tool behaves exactly as it does today.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, `@anthropic-ai/sdk` (the first runtime dependency), vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`

**Predecessors:** `2026-08-15-urtext-diff-review-core.md` (merged, PR #1), `2026-08-16-urtext-analyzers.md` (merged, PR #2)

## Global Constraints

- Node 20 or newer. ESM only — relative imports carry a `.js` extension even though sources are `.ts`; bare package imports take none.
- TypeScript `strict: true`. No `any` in exported signatures.
- **One new runtime dependency, `@anthropic-ai/sdk`, and no others.** Every prior plan banned new dependencies; this is the deliberate exception, and it is scoped to `src/interpret/`. No Zod, no HTTP client, no CLI framework, no HTML templating library — the report is generated with string composition, as the terminal renderer already is.
- **Stages 1 and 2 (`extract`, `analyze`) still make no network calls.** Only `src/interpret/` may. This is what keeps `--no-llm` a clean subset rather than a special case.
- Every `Fact` carries at least one `EvidenceRef`, and `Fact.file`/`line` are derived from `evidence[0]` by `makeFact`. Claims are not facts and get no evidence of their own.
- **The model may never mutate, delete, or contradict a fact.** Reconciliation only ever *adds* interpretation to what the analyzers found, or adds claims of its own labelled `model`.
- The tool never prints an approve/reject verdict.
- Reports are written to `.urtext/` in the repository under review, which is gitignored.

### The comment contract

Six comments across this project have asserted things the code does not do — a
wrong weight, an arithmetic slip, a function credited with a comment it does
not have, a boundary contradicted by the project's own test. Every one of them
*restated a fact the code already stated*. Explanations do not rot;
duplications do. These three rules are binding on every task:

1. **A comment names a constant or function; it never restates its value.**
   Write `WEIGHTS.factKind.effect_added`, not `60`. Write "the effect
   multiplier", not "0.4". A comment that contains a number the code also
   contains is a second copy that nothing keeps in sync.
2. **A comment asserting an invariant must name the test that enforces it.**
   Any "never", "always", "cannot", or "must not" is a claim; if no test
   makes it fail when violated, either write that test or delete the claim.
   "Reach amplifies; it never outranks" was false, and its guarding test
   compared against the *strongest* fact kind, so it passed for any wrong
   value.
3. **Comments explain what the code cannot show** — why a constraint exists,
   what broke before, which alternative was rejected and why. Never what the
   next line does.

Enforced, not merely stated: `test/comment-contract.test.ts` fails on any
comment in `src/` containing a literal equal to a value in `WEIGHTS`.

## What Plan 2 left for this plan

Three items were deferred with rulings and are discharged here:

1. **Blast radius is a scoring input, not a finding** (Task 1). The spec always modelled it as an amplifier folded into the finding it modifies — "the expiry check on `validateSession` is gone; 34 call sites reach this function" — and real output settled the argument: on urtext's own merge, 28 of 66 findings were standalone blast-radius entries and 22 more were `export_added`, so roughly 75% of the report was "new code exists and is used". This must land before the HTML report is built on the current shape.
2. **`tierFor` cannot express the `model` tier** (Task 2). Its signature was deliberately left narrow until `Claim` existed to shape it.
3. **`--no-llm` is parsed but inert** (Task 4). It becomes real when there is an LLM stage to disable.

Still deferred, deliberately: performance work (`countReferences`'s per-symbol program walk, one `git show` per file), `.mts`/`.cts` support, and the four residuals parked at the end of Plan 2 — except the CLI exit-code one, which Task 6 fixes because it becomes more dangerous once a report is written to disk.

## File Structure

| File | Responsibility |
|---|---|
| `src/score/reach.ts` | **New.** Fold blast-radius facts into sibling findings; group added exports per file |
| `src/types.ts` | Extended: `Claim`, `InterpretResult`, `Finding.claim`, `Finding.reach` |
| `src/score/index.ts` | Modified: widened `tierFor`, reach-aware scoring, `rank` takes claims |
| `src/interpret/schema.ts` | **New.** The JSON schema the model must satisfy, and its validator |
| `src/interpret/prompt.ts` | **New.** Prompt construction from a changeset and its facts |
| `src/interpret/client.ts` | **New.** The Claude call: model, refusal handling, availability check |
| `src/interpret/index.ts` | **New.** `interpret()` — the stage, skippable |
| `src/score/reconcile.ts` | **New.** Facts + claims → findings with tiers |
| `src/report/html.ts` | **New.** Self-contained HTML report with lenses |
| `src/report/write.ts` | **New.** `.urtext/` output and `--open` |
| `src/cli.ts` | Modified: wire interpret, `--no-llm`, `--open`, exit codes |

---

### Task 1: Blast radius becomes reach

Folds reference counts into the findings they amplify, and groups added exports, so a report reads like the spec's example instead of a list of everything that exists. Deliverable: urtext's own merge produces a report dominated by findings that name a problem.

**Files:**
- Create: `src/score/reach.ts`
- Modify: `src/types.ts` (`Finding.reach`)
- Modify: `src/score/index.ts` (`rank` routes through the fold)
- Test: `test/score/reach.test.ts`

**Interfaces:**
- Consumes: `Fact`, `Finding` from `src/types.js`; `toFinding`, `scoreFact` from `src/score/index.js`
- Produces:
  - `interface Reach { references: number; sites: EvidenceRef[] }`
  - `foldReach(facts: Fact[]): { facts: Fact[]; reach: Map<string, Reach> }` — strips `blast_radius` facts, returning the rest plus reach keyed by `` `${file} ${symbol}` ``
  - `groupAddedExports(findings: Finding[], threshold?: number): Finding[]`
  - `Finding.reach?: Reach`

- [ ] **Step 1: Write the failing test**

Create `test/score/reach.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foldReach, groupAddedExports, reachKey } from "../../src/score/reach.js";
import type { Fact, Finding } from "../../src/types.js";

const ev = (file: string, line: number, excerpt = "x") => ({ file, line, excerpt });

const fact = (over: Partial<Fact> & Pick<Fact, "kind">): Fact => ({
  id: `${over.kind}:a.ts:s`,
  file: "a.ts",
  line: 1,
  detail: {},
  evidence: [ev("a.ts", 1)],
  ...over,
});

describe("foldReach", () => {
  it("removes blast_radius facts from the fact list", () => {
    const { facts } = foldReach([
      fact({ kind: "signature_changed", symbol: "used", detail: { export: "used" } }),
      fact({ kind: "blast_radius", symbol: "used", detail: { symbol: "used", references: 34 } }),
    ]);
    expect(facts.map((f) => f.kind)).toEqual(["signature_changed"]);
  });

  it("keys reach by file and symbol", () => {
    const { reach } = foldReach([
      fact({ kind: "blast_radius", symbol: "used", detail: { symbol: "used", references: 34 } }),
    ]);
    expect(reach.get(reachKey("a.ts", "used"))?.references).toBe(34);
  });

  it("carries the reference sites through as evidence", () => {
    const { reach } = foldReach([
      fact({
        kind: "blast_radius",
        symbol: "used",
        detail: { symbol: "used", references: 2 },
        evidence: [ev("a.ts", 1), ev("b.ts", 7), ev("c.ts", 9)],
      }),
    ]);
    // evidence[0] is the declaration; the rest are the call sites.
    expect(reach.get(reachKey("a.ts", "used"))?.sites.map((s) => s.file)).toEqual(["b.ts", "c.ts"]);
  });

  it("keeps a blast_radius fact that has no sibling, so reach is never silently lost", () => {
    const { facts } = foldReach([
      fact({ kind: "blast_radius", symbol: "lonely", detail: { symbol: "lonely", references: 3 } }),
    ]);
    expect(facts.map((f) => f.kind)).toEqual(["blast_radius"]);
  });

  it("leaves facts alone when there is no reach at all", () => {
    const input = [fact({ kind: "guard_removed", symbol: "v", detail: { guard: "if", symbol: "v" } })];
    expect(foldReach(input).facts).toEqual(input);
  });
});

const finding = (over: Partial<Finding>): Finding => ({
  id: "x",
  tier: "verified",
  file: "a.ts",
  line: 1,
  title: "t",
  body: "b",
  score: 25,
  evidence: [ev("a.ts", 1)],
  ...over,
});

describe("groupAddedExports", () => {
  it("groups added exports in one file above the threshold", () => {
    const findings = [
      finding({ id: "export_added:a.ts:one", title: "one is newly exported" }),
      finding({ id: "export_added:a.ts:two", title: "two is newly exported" }),
      finding({ id: "export_added:a.ts:three", title: "three is newly exported" }),
    ];
    const out = groupAddedExports(findings, 3);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("a.ts exports 3 new symbols");
    expect(out[0].body).toContain("one");
    expect(out[0].body).toContain("three");
    expect(out[0].evidence).toHaveLength(3);
  });

  it("leaves a file below the threshold alone", () => {
    const findings = [finding({ id: "export_added:a.ts:one", title: "one is newly exported" })];
    expect(groupAddedExports(findings, 3)).toEqual(findings);
  });

  it("does not group findings of other kinds", () => {
    const findings = [
      finding({ id: "guard_removed:a.ts:1", title: "a guard went" }),
      finding({ id: "guard_removed:a.ts:2", title: "another guard went" }),
      finding({ id: "guard_removed:a.ts:3", title: "a third guard went" }),
    ];
    expect(groupAddedExports(findings, 3)).toEqual(findings);
  });

  it("groups per file, not across files", () => {
    const findings = [
      finding({ id: "export_added:a.ts:one", file: "a.ts", title: "one is newly exported" }),
      finding({ id: "export_added:a.ts:two", file: "a.ts", title: "two is newly exported" }),
      finding({ id: "export_added:b.ts:three", file: "b.ts", title: "three is newly exported" }),
    ];
    const out = groupAddedExports(findings, 2);
    expect(out).toHaveLength(2);
    expect(out.map((f) => f.file).sort()).toEqual(["a.ts", "b.ts"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/score/reach.test.ts`
Expected: FAIL — cannot resolve `../../src/score/reach.js`.

- [ ] **Step 3: Implement the fold**

Create `src/score/reach.ts`:

```ts
import type { EvidenceRef, Fact, Finding } from "../types.js";

export interface Reach {
  references: number;
  /** The referencing sites, excluding the declaration. */
  sites: EvidenceRef[];
}

export function reachKey(file: string, symbol: string): string {
  return `${file} ${symbol}`;
}

/**
 * Strips `blast_radius` facts out of the fact list and returns their content
 * as reach, keyed by the symbol they describe.
 *
 * Reach is not a defect. "This export is referenced in 34 places" names no
 * problem on its own — it says how much a problem named by some *other*
 * finding would cost. The spec models it as a scoring input for exactly that
 * reason, and shipping it as a standalone finding made roughly 40% of a real
 * report say nothing actionable. Folding it in turns two adjacent entries
 * into one sentence: "`findByEmail` changed signature; 34 places call it."
 *
 * A blast_radius fact with no sibling finding for the same symbol is kept as
 * a fact, so reach is never silently discarded — it just stops being the
 * headline when something better is available.
 */
export function foldReach(facts: Fact[]): { facts: Fact[]; reach: Map<string, Reach> } {
  const reach = new Map<string, Reach>();
  const others = facts.filter((f) => f.kind !== "blast_radius");
  const radius = facts.filter((f) => f.kind === "blast_radius");

  const hasSibling = (f: Fact): boolean =>
    others.some((o) => o.file === f.file && o.symbol !== undefined && o.symbol === f.symbol);

  const kept: Fact[] = [];
  for (const f of radius) {
    if (!f.symbol) {
      kept.push(f);
      continue;
    }
    if (!hasSibling(f)) {
      kept.push(f);
      continue;
    }
    const references =
      typeof f.detail.references === "number" ? f.detail.references : f.evidence.length - 1;
    reach.set(reachKey(f.file, f.symbol), {
      references,
      // evidence[0] is the declaration itself; the rest are call sites.
      sites: f.evidence.slice(1),
    });
  }

  return { facts: [...others, ...kept], reach };
}

const ADDED_EXPORT_THRESHOLD = 3;

/**
 * Collapses a file's added-export findings into one entry once there are
 * enough of them to be noise rather than news. A new module legitimately
 * exports a dozen symbols; listing each as its own finding buries everything
 * that names a problem.
 */
export function groupAddedExports(
  findings: Finding[],
  threshold: number = ADDED_EXPORT_THRESHOLD,
): Finding[] {
  const byFile = new Map<string, Finding[]>();
  const rest: Finding[] = [];

  for (const f of findings) {
    if (!f.id.startsWith("export_added:")) {
      rest.push(f);
      continue;
    }
    const group = byFile.get(f.file) ?? [];
    group.push(f);
    byFile.set(f.file, group);
  }

  const out = [...rest];
  for (const [file, group] of byFile) {
    if (group.length < threshold) {
      out.push(...group);
      continue;
    }
    const names = group
      .map((f) => f.title.replace(/ is newly exported$/, ""))
      .sort();
    out.push({
      id: `export_added_group:${file}`,
      tier: "verified",
      file,
      line: group[0].line,
      title: `${file} exports ${group.length} new symbols`,
      body: `New public surface: ${names.join(", ")}. New exports cannot break an existing caller, but they are what future code will depend on.`,
      score: Math.max(...group.map((f) => f.score)),
      evidence: group.map((f) => f.evidence[0]),
    });
  }

  return out;
}
```

- [ ] **Step 4: Add `reach` to the finding type**

In `src/types.ts`, extend `Finding`:

```ts
  /**
   * How widely the changed symbol is used, when known. Not a finding of its
   * own — an amplifier on this one. See `foldReach`.
   */
  reach?: { references: number; sites: EvidenceRef[] };
```

- [ ] **Step 5: Route `rank` through the fold**

In `src/score/index.ts`, change `rank` to fold reach in, attach it to matching findings, boost their score, and group added exports:

```ts
import { foldReach, groupAddedExports, reachKey } from "./reach.js";

export function rank(facts: Fact[]): Finding[] {
  const { facts: kept, reach } = foldReach(facts);

  const findings = kept.map((fact) => {
    const finding = toFinding(fact);
    const r = fact.symbol ? reach.get(reachKey(fact.file, fact.symbol)) : undefined;
    if (!r) return finding;
    return {
      ...finding,
      reach: r,
      // Reach amplifies; it never outranks. The ceiling that keeps a
      // standalone blast-radius finding below a real defect applies here
      // too, as a bounded multiplier rather than a separate score.
      score: finding.score * (1 + Math.min(Math.log10(Math.max(r.references, 1)), 1) * 0.5),
      body: `${finding.body} ${r.references === 1 ? "One place" : `${r.references} places`} in this repository reference it.`,
    };
  });

  return groupAddedExports(findings).sort(
    (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line,
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean.

`toFinding` is unchanged, so its tests hold as written. **`rank`'s existing tests may not**: any fixture with three or more `export_added` facts in one file now yields a group instead of individual findings, and any fixture pairing a `blast_radius` fact with a sibling now yields one finding rather than two. Those are the intended new behaviours — update the expectations to match, and do not weaken the grouping to keep an old assertion green. If an existing test's *intent* is unclear, say so in the report rather than guessing.

- [ ] **Step 7: Verify against real output**

Run: `npx tsx src/cli.ts review HEAD~1`
Expected: substantially fewer findings than before, with reach appearing as a sentence inside contract findings rather than as separate entries. Read the output and confirm it reads better; report the before/after finding counts.

- [ ] **Step 8: Commit**

```bash
git add src/score/reach.ts src/score/index.ts src/types.ts test/score/reach.test.ts
git commit -m "feat(score): fold reach into the findings it amplifies"
```

---

### Task 2: Claims, tiers, and reconciliation

Defines what a model claim is and how it becomes a finding with an honest tier. Pure computation — no network, fully testable — so the trust rules are pinned before any model output exists.

**Files:**
- Modify: `src/types.ts` (`Claim`, `InterpretResult`, `Finding.claim`)
- Create: `src/score/reconcile.ts`
- Modify: `src/score/index.ts` (widen `tierFor`)
- Test: `test/score/reconcile.test.ts`

**Interfaces:**
- Produces:
  - `Claim { id, file, line, summary, reasoning, severity, correspondsTo? }`
  - `InterpretResult { claims: Claim[]; model: string; skipped?: string }`
  - `tierFor(fact: Fact | undefined, claim: Claim | undefined): Tier`
  - `reconcile(facts: Fact[], claims: Claim[]): Finding[]`

- [ ] **Step 1: Add the types**

In `src/types.ts`:

```ts
/**
 * A model's interpretation of a change. A claim is not evidence: it carries
 * no `EvidenceRef` of its own, and it can never overwrite a fact. It either
 * annotates a fact — earning that fact's finding a richer explanation — or
 * stands alone as something the analyzers did not see, labelled `model` so a
 * reader knows to check it.
 */
export interface Claim {
  id: string;
  file: string;
  line: number;
  /** One sentence, shown as the finding headline when the claim stands alone. */
  summary: string;
  /** Why this matters. Shown as the body. */
  reasoning: string;
  /** The model's own 0..1 severity. Advisory: it can raise rank, never top it. */
  severity: number;
  /** `Fact.id` this claim restates or explains, when it corresponds to one. */
  correspondsTo?: string;
}

export interface InterpretResult {
  claims: Claim[];
  /** The model that produced them, for the report's provenance line. */
  model: string;
  /** Set when the stage did not run; the reason is shown to the user. */
  skipped?: string;
}
```

And extend `Finding`:

```ts
  /** The model's reasoning, when a claim contributed to this finding. */
  claim?: { summary: string; reasoning: string };
```

- [ ] **Step 2: Write the failing test**

Create `test/score/reconcile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/score/reconcile.js";
import { tierFor } from "../../src/score/index.js";
import type { Claim, Fact } from "../../src/types.js";

const fact = (id: string, over: Partial<Fact> = {}): Fact => ({
  id,
  kind: "guard_removed",
  file: "a.ts",
  line: 3,
  symbol: "validate",
  detail: { guard: "if", symbol: "validate" },
  evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
  ...over,
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: "c1",
  file: "a.ts",
  line: 3,
  summary: "the auth check was removed",
  reasoning: "callers can now pass an empty token",
  severity: 0.8,
  ...over,
});

describe("tierFor", () => {
  it("marks an analyzer fact with no claim verified", () => {
    expect(tierFor(fact("f1"), undefined)).toBe("verified");
  });

  it("marks a claim with no corresponding fact model", () => {
    expect(tierFor(undefined, claim())).toBe("model");
  });

  it("marks a claim that corresponds to a fact inferred", () => {
    expect(tierFor(fact("f1"), claim({ correspondsTo: "f1" }))).toBe("inferred");
  });

  it("never returns model when a fact is present", () => {
    expect(tierFor(fact("f1"), claim())).not.toBe("model");
  });
});

describe("reconcile", () => {
  it("keeps every fact as a finding even when the model says nothing", () => {
    const out = reconcile([fact("f1")], []);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("verified");
  });

  it("attaches a corresponding claim to its fact's finding and downgrades the tier", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "f1" })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("inferred");
    expect(out[0].claim?.reasoning).toContain("empty token");
    expect(out[0].evidence).toHaveLength(1);
  });

  it("emits an uncorresponded claim as its own model-tier finding", () => {
    const out = reconcile([], [claim()]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("model");
    expect(out[0].title).toBe("the auth check was removed");
    expect(out[0].evidence).toEqual([]);
  });

  it("drops a claim whose correspondsTo names a fact that does not exist", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "nope" })]);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe("verified");
  });

  it("ranks a model-tier finding below a verified one of the same subject", () => {
    const out = reconcile([fact("f1")], [claim({ id: "c2", severity: 1 })]);
    const verified = out.find((f) => f.tier === "verified")!;
    const model = out.find((f) => f.tier === "model")!;
    expect(verified.score).toBeGreaterThan(model.score);
  });

  it("never lets a claim change a fact's evidence", () => {
    const out = reconcile([fact("f1")], [claim({ correspondsTo: "f1", file: "elsewhere.ts", line: 99 })]);
    expect(out[0].evidence[0].file).toBe("a.ts");
    expect(out[0].file).toBe("a.ts");
    expect(out[0].line).toBe(3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/score/reconcile.test.ts`
Expected: FAIL — cannot resolve `../../src/score/reconcile.js`, and `tierFor` takes one argument.

- [ ] **Step 4: Widen `tierFor`**

In `src/score/index.ts`, replace it:

```ts
/**
 * The evidence tier for a finding, from what produced it.
 *
 * - `verified` — an analyzer found it and can point at the code.
 * - `inferred` — the model explained something an analyzer found. The fact
 *   is still true; the *explanation* is the model's, so the finding is only
 *   as good as that explanation.
 * - `model` — the model alone. Nothing mechanical corroborates it.
 *
 * A fact always beats a claim: if there is a fact, the tier can never be
 * `model`, because something machine-checked is underneath it.
 */
export function tierFor(fact: Fact | undefined, claim: Claim | undefined): Tier {
  if (fact && claim?.correspondsTo === fact.id) return "inferred";
  if (fact) return "verified";
  return "model";
}
```

- [ ] **Step 5: Implement reconciliation**

Create `src/score/reconcile.ts`:

```ts
import type { Claim, Fact, Finding } from "../types.js";
import { rank, tierFor } from "./index.js";

/** Model-tier findings are capped below every analyzer weight. */
const MODEL_CEILING = 14;

/**
 * Merges what the analyzers found with what the model said.
 *
 * The asymmetry is the point: a fact survives whether or not the model
 * mentions it, and a claim can only ever annotate a fact or stand alone. A
 * claim never edits a fact's file, line, or evidence — if the model asserts
 * a location, it is ignored in favour of the analyzer's, because the
 * analyzer's came from the code.
 */
export function reconcile(facts: Fact[], claims: Claim[]): Finding[] {
  const byFactId = new Map<string, Claim>();
  for (const c of claims) {
    if (c.correspondsTo && facts.some((f) => f.id === c.correspondsTo)) {
      byFactId.set(c.correspondsTo, c);
    }
  }

  // A finding's id is its fact's id, so a claim reaches its finding through
  // the fact it corresponds to. Grouped findings (added exports) have no
  // originating fact and therefore never carry a claim, which is correct:
  // a group is a summary, not a subject the model was asked about.
  const byId = new Map(facts.map((f) => [f.id, f]));

  const findings = rank(facts).map((finding) => {
    const claim = byFactId.get(finding.id);
    const fact = byId.get(finding.id);
    if (!claim || !fact) return finding;
    return {
      ...finding,
      tier: tierFor(fact, claim),
      claim: { summary: claim.summary, reasoning: claim.reasoning },
    };
  });

  const standalone = claims
    .filter((c) => !c.correspondsTo || !byFactId.has(c.correspondsTo))
    .map((c): Finding => ({
      id: `claim:${c.id}`,
      tier: "model",
      file: c.file,
      line: c.line,
      title: c.summary,
      body: c.reasoning,
      // Capped below every analyzer weight: an unverified claim never
      // outranks something a machine checked, however confident it sounds.
      score: Math.min(c.severity * MODEL_CEILING, MODEL_CEILING),
      evidence: [],
    }));

  return [...findings, ...standalone].sort(
    (a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line,
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean. The `tierFor` signature change breaks its old single-argument call site in `toFinding` — update it to pass `undefined` for the claim.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/score/reconcile.ts src/score/index.ts test/score/reconcile.test.ts
git commit -m "feat(score): claims, all three tiers, and reconciliation"
```

---

### Task 2b: Enforce the comment contract

Makes the project's most persistent defect class mechanically impossible to
reintroduce, rather than something a reviewer has to catch each time.

**Files:**
- Create: `test/comment-contract.test.ts`
- Modify: every file in `src/` whose comments restate a `WEIGHTS` value

**Interfaces:** none — this task adds a guard test and edits comments only. It
must not change a single line of executable code. If a comment cannot be
rewritten without changing behaviour, the comment is wrong; fix the comment.

- [ ] **Step 1: Write the guard test**

The test walks every `.ts` file under `src/`, extracts comment text (both `//`
and `/* */`, including JSDoc), and fails on any numeric literal equal to a
value in `WEIGHTS` — from `WEIGHTS.factKind` and `WEIGHTS.effect` alike.

Import `WEIGHTS` from `../src/score/index.js` and derive the forbidden set
from it rather than hardcoding the numbers, so a future weight change extends
the guard automatically. That is the whole point of the rule: **a value that
appears in exactly one place cannot go stale.**

The failure message must name the file, the line, the offending number, and
the constant it should be replaced with, so the fix is obvious without
reading this plan.

Exclusions, kept as narrow as the rule allows and each justified in a comment
in the test itself: array and tuple indices (`evidence[0]`, `declarations[0]`,
`evidence[1..]`), the documented `0..1` and `[0, 1]` severity range, and
"1-based"/"0-based" line-numbering phrases. Do not add a blanket
file-level exclusion — if `src/score/index.ts` needs one, the rule has failed.

- [ ] **Step 2: Run it and see what it catches**

Run: `npx vitest run test/comment-contract.test.ts`
Expected: FAIL, with a list of real violations concentrated in `src/score/`.
Report that list in full — it is the measurement of how large the class was.

- [ ] **Step 3: Fix every violation**

Replace each restated value with the constant that holds it. Where a comment
recounts history that depends on a specific past number ("at 40 the curve
saturated at three references"), keep the history but attribute it: say the
value was changed and why, without asserting a current number the code owns.

Where a comment states an invariant — any "never", "always", "cannot", "must
not" — check it against the code. If it is false, fix it. If it is true but no
test would fail when it is violated, say so plainly in your report; do not
quietly delete the claim, and do not write the missing test in this task.

- [ ] **Step 4: Verify**

Run: `npm test && npx tsc --noEmit`
Expected: all green, including the new guard. Confirm with `git diff` that no
executable line changed — comments only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: enforce the comment contract, fix every violation"
```

---

### Task 3: The Claude client

The only module that touches the network. Deliverable: given a changeset and facts, return claims — or a clear reason it did not.

**Files:**
- Create: `src/interpret/schema.ts`, `src/interpret/prompt.ts`, `src/interpret/client.ts`, `src/interpret/index.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Test: `test/interpret/schema.test.ts`, `test/interpret/prompt.test.ts`, `test/interpret/index.test.ts`

**Interfaces:**
- Produces:
  - `CLAIMS_SCHEMA` — the JSON schema the response must satisfy
  - `parseClaims(text: string): Claim[]` — validates and coerces; throws on malformed
  - `buildPrompt(changeset: Changeset, facts: Fact[]): string`
  - `interpret(changeset, facts, opts): Promise<InterpretResult>`

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk@^0.70.0`

This is the plan's one permitted new runtime dependency.

- [ ] **Step 2: Write the schema and its validator**

Create `src/interpret/schema.ts`:

```ts
import type { Claim } from "../types.js";

/**
 * The response shape. Constrained rather than free prose because the output
 * is merged with analyzer facts, and a claim that cannot be attached to a
 * fact or placed in a file is not usable.
 */
export const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "Repo-relative path this claim is about." },
          line: { type: "integer", description: "1-based line in that file." },
          summary: { type: "string", description: "One sentence. The finding headline." },
          reasoning: { type: "string", description: "Why it matters, in one or two sentences." },
          severity: { type: "number", description: "0..1. How much this should worry a reviewer." },
          correspondsTo: {
            type: "string",
            description:
              "The id of the analyzer fact this explains, when it explains one. Omit for an observation the analyzers did not make.",
          },
        },
        required: ["file", "line", "summary", "reasoning", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
} as const;

/**
 * Validates and coerces model output. Rejects the whole response rather than
 * silently keeping the well-formed half: a partially-parsed claim set is
 * indistinguishable from a complete one downstream, and the tier system's
 * value rests on knowing exactly what the model said.
 */
export function parseClaims(text: string): Claim[] {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || !("claims" in raw)) {
    throw new Error("interpretation response has no `claims` array");
  }
  const list = (raw as { claims: unknown }).claims;
  if (!Array.isArray(list)) throw new Error("`claims` is not an array");

  return list.map((item, i): Claim => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`claim ${i} is not an object`);
    }
    const c = item as Record<string, unknown>;
    const str = (k: string): string => {
      const v = c[k];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`claim ${i}: \`${k}\` must be a non-empty string`);
      }
      return v;
    };
    const severity = typeof c.severity === "number" ? c.severity : 0;
    return {
      id: `m${i + 1}`,
      file: str("file"),
      line: typeof c.line === "number" && c.line > 0 ? Math.floor(c.line) : 1,
      summary: str("summary"),
      reasoning: str("reasoning"),
      severity: Math.min(Math.max(severity, 0), 1),
      correspondsTo: typeof c.correspondsTo === "string" ? c.correspondsTo : undefined,
    };
  });
}
```

- [ ] **Step 3: Write the prompt builder**

Create `src/interpret/prompt.ts`:

```ts
import type { Changeset, Fact } from "../types.js";

const MAX_FACTS = 60;

/**
 * The model is given the facts and asked to explain and extend them — not to
 * re-derive them. Two things are load-bearing in the wording: it must cite a
 * fact id when it is explaining one (that is what earns the `inferred` tier
 * rather than `model`), and it must not restate a fact it cannot add to,
 * because a claim that echoes a fact costs a reader attention and adds
 * nothing.
 */
export function buildPrompt(changeset: Changeset, facts: Fact[]): string {
  const shown = facts.slice(0, MAX_FACTS);
  const factLines = shown.map(
    (f) =>
      `- id=${f.id} kind=${f.kind} at ${f.file}:${f.line}` +
      (f.symbol ? ` symbol=${f.symbol}` : "") +
      `\n    evidence: ${f.evidence[0].excerpt}`,
  );

  const fileLines = changeset.files.map(
    (f) =>
      `- ${f.path} (${f.status})` +
      (f.symbols.length
        ? ` — symbols: ${f.symbols.map((s) => `${s.qualifiedName} ${s.change}`).join(", ")}`
        : ""),
  );

  return [
    "You are reviewing a code change. Static analyzers have already examined it and produced the facts below. Each fact is machine-checked and points at real code.",
    "",
    `Change: ${changeset.range.label}, ${changeset.files.length} files.`,
    "",
    "Files:",
    ...fileLines,
    "",
    `Analyzer facts (${facts.length}${facts.length > shown.length ? `, showing ${shown.length}` : ""}):`,
    ...factLines,
    "",
    "Your job is to add what the analyzers could not see:",
    "",
    "1. Explain a fact when the explanation changes what a reviewer would do — set `correspondsTo` to that fact's id. Do not restate a fact you cannot add to; an echo costs the reader attention and adds nothing.",
    "2. Raise a risk the analyzers missed — reordered awaits, a changed invariant, an error path that no longer runs — with no `correspondsTo`. These are shown to the reader as unverified, so raise them when they are worth checking, not when they are merely possible.",
    "",
    "Be specific to this change. Do not speculate about code you were not shown, do not suggest tests or refactors, and do not judge the change as good or bad. If you have nothing useful to add, return an empty list — that is a valid and useful answer.",
  ].join("\n");
}
```

- [ ] **Step 4: Write the client**

Create `src/interpret/client.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { CLAIMS_SCHEMA, parseClaims } from "./schema.js";
import type { Claim } from "../types.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClientOptions {
  model?: string;
  apiKey?: string;
}

/** Why the stage cannot run, or undefined when it can. */
export function unavailableReason(opts: ClientOptions = {}): string | undefined {
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return "no ANTHROPIC_API_KEY set — showing analyzer findings only";
  }
  return undefined;
}

/**
 * Asks the model for claims. Returns them, or throws with a message the CLI
 * shows the user.
 *
 * `fallbacks: "default"` is on because this model's safety classifiers can
 * decline a request outright, and a review that stops because a diff
 * mentioned a security topic is worse than one answered by another model.
 * A refusal that survives the fallback is reported as a skipped stage, never
 * as an empty claim list — "the model declined" and "the model had nothing
 * to add" must not look the same to a reader.
 */
export async function requestClaims(
  prompt: string,
  opts: ClientOptions = {},
): Promise<{ claims: Claim[]; model: string }> {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = opts.model ?? DEFAULT_MODEL;

  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CLAIMS_SCHEMA },
    },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new Error(`model declined to interpret this change (${category})`);
  }

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("interpretation response contained no text");
  }

  return { claims: parseClaims(text.text), model: response.model };
}
```

- [ ] **Step 5: Write the stage**

Create `src/interpret/index.ts`:

```ts
import type { Changeset, Fact, InterpretResult } from "../types.js";
import { buildPrompt } from "./prompt.js";
import { requestClaims, unavailableReason, type ClientOptions } from "./client.js";

export { CLAIMS_SCHEMA, parseClaims } from "./schema.js";
export { buildPrompt } from "./prompt.js";
export { DEFAULT_MODEL, unavailableReason } from "./client.js";

export interface InterpretOptions extends ClientOptions {
  /** Skip the stage entirely, whatever the environment says. */
  disabled?: boolean;
}

/**
 * The interpretation stage. Never throws: a failure here degrades the review
 * to its analyzer findings and says why, because the deterministic half is
 * the part that has to work.
 */
export async function interpret(
  changeset: Changeset,
  facts: Fact[],
  opts: InterpretOptions = {},
): Promise<InterpretResult> {
  const model = opts.model ?? "";
  if (opts.disabled) {
    return { claims: [], model, skipped: "--no-llm" };
  }
  const unavailable = unavailableReason(opts);
  if (unavailable) {
    return { claims: [], model, skipped: unavailable };
  }
  if (facts.length === 0 && changeset.files.length === 0) {
    return { claims: [], model, skipped: "nothing changed" };
  }

  try {
    const result = await requestClaims(buildPrompt(changeset, facts), opts);
    return { claims: result.claims, model: result.model };
  } catch (err) {
    return {
      claims: [],
      model,
      skipped: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 6: Write the tests**

Create `test/interpret/schema.test.ts` covering: a valid response parses; a missing `claims` key throws; a non-array throws; a claim missing `summary` throws; `severity` clamps to 0..1; a non-numeric line falls back to 1; `correspondsTo` survives.

Create `test/interpret/prompt.test.ts` covering: fact ids appear; the instruction to set `correspondsTo` appears; a large fact list is capped and the prompt says so.

Create `test/interpret/index.test.ts` covering: `disabled` returns skipped `--no-llm` without touching the network; no API key returns a skipped reason; a thrown client error becomes a skipped reason rather than a rejection. Inject the failure by passing an `apiKey` and stubbing the module — **no test in this file may make a network call**; if that cannot be arranged cleanly, assert only the skip paths and say so in the report.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/interpret test/interpret
git commit -m "feat(interpret): claims from Claude, with the stage skippable"
```

---

### Task 4: Wire interpretation into the pipeline

Makes the tiers visible. Deliverable: `urtext review` shows `inferred` and `model` findings when a key is present, and behaves exactly as before when it is not.

**Files:**
- Modify: `src/cli.ts`, `src/report/terminal.ts`
- Test: `test/cli.test.ts` (extend)

- [ ] **Step 1: Extend the CLI**

`review()` gains the interpret stage between analysis and ranking, replacing `rank(facts)` with `reconcile(facts, result.claims)`. `opts.noLlm` maps to `interpret`'s `disabled`. The skip reason, when present, joins the existing analyzer warnings so a partial review always says so. `--json` gains `model` and `skipped`.

- [ ] **Step 2: Render the tiers**

`renderTerminal` already prints a tier badge and per-tier counts. Add: the model's reasoning shown under a finding that has one, and a provenance line naming the model when any finding is `inferred` or `model`. A reader must be able to tell at a glance which findings a machine checked.

- [ ] **Step 3: Tests**

Extend `test/cli.test.ts`: with `--no-llm`, output contains no model provenance line and all findings are `verified`; the skip reason appears in the warnings when no key is set.

- [ ] **Step 4: Verify end to end**

Run `npm run review -- HEAD~1` twice — once with `--no-llm`, once without (if a key is present) — and include both outputs in the report with an honest assessment of whether the model's additions were worth reading.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cli): interpretation stage and tiered output"
```

---

### Task 5: The HTML report

The reading surface for a change that needs more than ten seconds.

**Files:**
- Create: `src/report/html.ts`
- Test: `test/report/html.test.ts`

Requirements, from the spec: a single self-contained file — **no external requests of any kind**, no CDN, no remote fonts; the header carries the change scope and per-tier counts; findings ranked, each expandable to its evidence with the source excerpt and, for a `model` finding, the model's reasoning clearly marked unverified; a lens switcher offering a natural-language narrative, an effects-and-contracts view, and the API surface delta; light and dark via `prefers-color-scheme`; wide content scrolls inside its own container rather than the page.

Tests assert: the output contains no `http://` or `https://` resource reference; every finding's excerpt appears; tier badges are present and counted correctly; the document parses as HTML with a single `<html>` root.

- [ ] **Commit:** `feat(report): self-contained HTML report`

---

### Task 6: Write reports, `--open`, and exit codes

**Files:**
- Create: `src/report/write.ts`
- Modify: `src/cli.ts`
- Test: `test/report/write.test.ts`

Requirements: write the HTML to `.urtext/review-<timestamp>.html` under the repository root, creating the directory if needed, and ensure `.urtext/` is gitignored; print its path in the terminal summary (the renderer already accepts `reportPath`); `--open` opens it with the platform opener, and is a no-op when no report was written.

Also fix the residual parked at the end of Plan 2: **when every analyzer fails, the CLI must exit non-zero.** It currently exits 0 with warning notes, which a human sees and a script does not — and that becomes more dangerous now that a report file exists to look successful.

- [ ] **Commit:** `feat(report): write reports to .urtext/, --open, honest exit codes`

---

## Self-review notes

**Spec coverage.** Stage 3 interpret → Task 3. Reconcile and the three tiers → Task 2. Blast radius as a scoring input → Task 1. Terminal tier rendering → Task 4. HTML report and lenses → Task 5. `.urtext/` output and `--open` → Task 6. The JSON contract grows in Tasks 4 and 6.

**Deferred rulings discharged:** blast radius reshaped (Task 1), `tierFor` widened (Task 2), `--no-llm` made real (Task 4), CLI exit code fixed (Task 6).

**Still deferred:** the performance work, `.mts`/`.cts`, and three of Plan 2's four parked residuals (the terminal blank line, the narrowed bare-alias gate, and arbitrary guard-removal anchoring among reworded candidates).

**Risks worth watching.**

Task 3 is where this plan can go quietly wrong, in the way this project keeps going quietly wrong: a model that returns plausible claims which reconcile cleanly and are simply untrue. The design's defence is structural rather than statistical — a claim can never edit a fact, an uncorresponded claim is capped below every analyzer weight, and the tier is printed next to every finding. Task 2 pins those rules with tests *before* any model output exists, which is deliberate: they are much harder to argue about once real output is in front of you and looks convincing.

The second risk is subtler. Prompting the model with the facts invites it to agree with them — an `inferred` finding that merely restates its fact costs a reader attention while looking like corroboration. The prompt says not to, but prompts are not guarantees. Whoever implements Task 4 should read real output and say plainly whether the model's additions earned their place; if most claims are echoes, the honest response is to raise the bar in the prompt or drop the `inferred` tier entirely rather than ship agreeable noise.
