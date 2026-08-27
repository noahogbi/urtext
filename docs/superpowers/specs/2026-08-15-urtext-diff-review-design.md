# Urtext: Diff Review — Design

**Date:** 2026-08-15
**Status:** Approved, ready for implementation planning
**Supersedes:** the klar-era prototype (AI-native IR authored via a builder DSL)

## Problem

AI agents now produce more code than a human can review by reading it. The
bottleneck has moved from writing code to deciding whether to trust code that
already exists. A person facing a few hundred lines an agent just wrote has two
bad options: read all of it, or merge on faith.

Existing tools do not close this gap. A textual diff shows what bytes changed
but not what matters. A model asked to "review this diff" produces prose whose
reliability the reader cannot assess, which is the same trust problem one level
up.

## Goal

Take a diff as input. Produce an account of what changed, ranked by what
matters, where every claim is labeled with the kind of evidence behind it.

The primary scenario is local and immediate: an agent finishes a change in a
repo, and the developer must decide "merge or dig in." The tool answers that
question in ten seconds for most diffs and supports an hour of investigation
for the ones that need it.

Two adjacent scenarios fall out of this one later and are explicitly deferred:
reviewing a GitHub pull request (a diff fetched from elsewhere) and a daily
multi-repo digest (the same analysis run repeatedly and concatenated). Both are
cheap to add once the local core and its JSON contract exist. Neither shapes v1.

## Non-goals

- **No verdict.** The tool never says approve or reject. It surfaces what could
  matter and why. A tool that renders verdicts is trusted exactly once — until
  its first confident mistake.
- **No agent loop.** Single pass, deterministic control flow. Fast enough for a
  pre-merge check and viable in CI.
- **No whole-codebase audit.** Repository understanding is built lazily, in
  service of interpreting a diff, never as a product surface of its own.
- **No non-TypeScript deep analysis in v1.** See Language scope.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Input | A git revision range | Zero integration cost; the diff is already there |
| Trust model | Hybrid: deterministic analysis verifies, LLM interprets, every claim labeled by evidence | The only honest answer to "why trust the reviewer?"; improves measurably as analyzers are added |
| Language scope | TypeScript deep, v1 only | Matches the repos this is for; the TS compiler API gives type-aware call graphs for free |
| Output | Tiered: terminal summary plus HTML report | Mirrors how the decision actually goes — most diffs cleared fast, a few studied |
| LLM dependency | Self-contained by default, `--no-llm` degrades to verified-only | CI and offline work on day one; forces a clean core/model boundary |
| Home | This repo, prototype archived | The name still fits: the codebase is the urtext, the review is the edition |

## Architecture

Four stages. Stages 1 and 2 are pure deterministic TypeScript with no network
access, which makes the core testable offline and makes `--no-llm` a natural
subset rather than a special case.

```
git range ──▶ [1 extract] ──▶ Changeset
                                  │
              repo TS program ────┤
                                  ▼
                            [2 analyze] ──▶ Fact[]        (deterministic)
                                  │
                                  ├──────────────────────────────┐
                                  ▼                              │
                            [3 interpret] ──▶ Claim[]            │  --no-llm
                              (Claude)          │                │  skips 3
                                                ▼                │
                                          [reconcile] ◀──────────┘
                                                │
                                                ▼
                                          [score] ──▶ Finding[]
                                                │
                                                ▼
                                          [4 report] ──▶ terminal + html + json
```

### Stage 1 — Extract

Input: a git revision range. Default is the working tree against the merge-base
with the repository's default branch.

Output: a `Changeset` — the changed files and hunks, and for TypeScript files
the **changed symbols** rather than bare line numbers. Mapping a hunk to "the
body of `validateSession` changed" is what separates this from a line diff and
is the input every later stage depends on.

```ts
interface Changeset {
  range: { from: string; to: string };
  files: ChangedFile[];
}

interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  previousPath?: string;
  hunks: Hunk[];
  symbols: ChangedSymbol[];   // empty for non-TS files
}

interface ChangedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "type" | "variable" | "export";
  exported: boolean;
  range: { startLine: number; endLine: number };
  change: "added" | "modified" | "removed";
}
```

### Stage 2 — Analyze

Four analyzers run against the repository's TypeScript program. Each has the
same signature so the set is open-ended:

```ts
type Analyzer = (changeset: Changeset, program: ts.Program) => Fact[];

interface Fact {
  id: string;                        // referenced by Claim.correspondsTo
  kind: FactKind;
  file: string;
  line: number;
  symbol?: string;
  detail: Record<string, unknown>;   // analyzer-specific, rendered as evidence
  evidence: EvidenceRef[];           // locations that substantiate the fact
}

interface EvidenceRef {
  file: string;
  line: number;
  excerpt: string;
}
```

**effects** — Did this change introduce or remove a side effect? Detected
categories: `network` (fetch/http/axios-shaped calls), `filesystem` (`fs`
module use), `process` (`child_process`, `process.exit`), `env`
(`process.env` reads), `database` (calls into known query builders/clients
resolvable in the program), `timing` (`Date.now`, `Math.random`). This is the
prototype's `EffectKind` taxonomy, recovered from real code instead of declared
in a builder. A newly introduced effect in a module that previously had none is
the strongest signal here.

**surface** — Did an exported symbol's type signature change? Was an export
added or removed? Uses the type checker to compare resolved signatures, so a
widened return type (`User` becoming `User | null`) is caught even when the
source text barely changed. This is the "did we break a contract" analyzer.

**blast-radius** — For each changed exported symbol, how many references exist
and where. Uses the language service's find-all-references. Reported
log-scaled: the difference between three and forty callers is meaningful; the
difference between forty and eighty is not.

**guards** — Did a conditional, early return, or `throw` disappear from a code
path that survived the change? Removed checks are where the dangerous bugs
live, and their removal is mechanically detectable even when the analyzer
cannot tell what the check meant. Always ranked high.

### Stage 3 — Interpret (skippable)

Sends the `Changeset` plus stage-2 `Fact[]` to Claude with a structured-output
schema. Model: `claude-opus-5` by default, configurable. Uses
`output_config.format` for schema enforcement, adaptive thinking (the default),
and streaming so long reviews do not hit request timeouts. Requires
`ANTHROPIC_API_KEY`; absent it, the stage is skipped exactly as `--no-llm`
does.

Returns:

```ts
interface Claim {
  file: string;
  line: number;
  summary: string;            // one sentence, plain language
  reasoning: string;          // why this matters
  severity: number;           // 0..1, model's own judgment
  correspondsTo?: string;     // id of a Fact this claim restates, if any
}
```

The model is instructed to state which stage-2 fact each claim rests on when
one applies, and to mark claims that rest on none. Handle `stop_reason` before
reading content; a refusal is reported as a skipped interpretation, not a
crash.

### Reconcile

Merges `Fact[]` and `Claim[]` into `Finding[]`, assigning each an evidence
tier:

| Tier | Meaning | Assigned when |
|---|---|---|
| `verified` | Derived entirely from stage-2 analysis; the report can point at code that proves it | A Fact with no model claim needed, or a claim whose assertion the Fact fully substantiates |
| `inferred` | The model asserted it and a Fact is consistent but not conclusive | A claim referencing a Fact whose detail supports but does not establish the claim |
| `model` | The model asserted it; nothing mechanical corroborates it | A claim with no corresponding Fact |

Tier assignment is deterministic given the inputs — it is a function of whether
a corresponding Fact exists and whether that Fact's kind is conclusive for the
claim's assertion, never a model judgment about its own reliability.

Tier counts appear at the top of both output surfaces, so "12 verified, 3
model-only" tells the reader immediately how much of this review is
machine-checked. The fraction in the top tier is the project's quality metric
over time.

### Score

Importance is a weighted combination of four deterministic inputs and one model
input:

1. **Effect delta** — new effects weigh most; removed effects count less.
2. **Contract change** — changed exported signature or removed export. High:
   this is the class of change that breaks callers silently.
3. **Blast radius** — log-scaled reference count.
4. **Guard removal** — always high.
5. **Model severity** — may raise a finding's rank, capped so it can never
   alone push a finding to the top.

Weights live in one configuration module with defaults, not scattered through
analyzers, because they will need tuning against real output.

### Stage 4 — Report

**Terminal.** Ranked findings, tier badge inline, one claim plus its concrete
evidence per finding. Target: two or three lines for a typical diff.

```
urtext · 14 files, 312 lines changed · vs origin/main

  EVIDENCE  2 verified · 1 inferred · 1 model-only

  ▲ auth/session.ts:42 — guard removed                    [verified]
    The expiry check on `validateSession` is gone. 34 call sites
    reach this function; 6 are on request paths.

  ● db/queries.ts:87 — export signature changed           [verified]
    `findByEmail` returns `User | null` (was `User`). 11 callers,
    3 do not handle null.

  Full report: .urtext/review-2026-08-15.html
```

**HTML.** Self-contained single file, no external requests, light and dark.
Header with change scope and tier counts; ranked findings, each expandable to
the diff hunk and its evidence chain (for `verified`, the analyzer output that
proves it; for `model`, the model's stated reasoning explicitly labeled
unverified); a lens switcher offering a natural-language narrative of the whole
change, an effects-and-contracts view, and the API surface delta.

**JSON.** The same structure the HTML renders from. This is a real data
contract, which is what makes the deferred PR and digest surfaces cheap.

Reports are written to `.urtext/` (gitignored).

## CLI

| Command / flag | Behavior |
|---|---|
| `urtext review [<rev-range>]` | Main command. Defaults to working tree vs. merge-base with the default branch |
| `--no-llm` | Deterministic tier only; emits a machine-readable brief on stdout for an agent to interpret |
| `--json` | Emit the full finding set as JSON |
| `--open` | Open the HTML report after writing |

`package.json` already advertises `src/cli.ts`; this design supplies it.

## Repository layout

```
src/
  extract/     git range → Changeset
  analyze/     effects.ts, surface.ts, blast-radius.ts, guards.ts
  score/       importance weights, tier assignment
  interpret/   Claude call: prompt, schema, reconciler
  report/      terminal, html, json renderers
  cli.ts
test/
  fixtures/    small TS repos with known diffs and asserted facts
archive/
  prototype/   the klar-era builder, checker, emitter, PLP, demo
```

### Disposition of the prototype

`archive/prototype/` holds the existing `builder.ts`, `checker.ts`,
`emit-ts.ts`, `plp.ts`, `types.ts`, and `demo.ts`, with a README explaining
what they were and why they are kept. Nothing in the new code imports them.
They are provenance for the idea's evolution, not a dependency.

Carried forward as ideas, rewritten as code:

- the effect taxonomy (`EffectKind`) — now recovered, not declared
- the proof kinds (`by_constraint` / `by_human`) — now the evidence tiers
- the projections (PLP) — now the report lenses
- the change journal — now the finding set

Also resolved by this work: the `check` and `project` scripts in
`package.json` currently point at a `src/cli.ts` that does not exist. The new
CLI replaces them.

## Testing

- **Analyzers** (the part worth testing properly): fixture repositories with a
  known before/after and an asserted `Fact[]`. Write the expected facts first,
  then the analyzer.
- **Reconcile and score**: unit tests over synthetic `Fact[]` / `Claim[]`
  inputs, including every tier-assignment path.
- **Interpret**: contract tests only — schema validity, reconciler behavior on
  synthetic model output, refusal handling. No assertions on model prose.
- **Renderers**: snapshot tests.

Test runner: vitest.

## Implementation sequencing

Build one analyzer end-to-end through all four stages before building the other
three. A thin slice — git range → effects analysis → score → terminal output —
proves the whole pipeline and surfaces interface mistakes while they are cheap
to fix. Three more analyzers bolted onto a proven spine is then mechanical.

Rough order:

1. Extract: git range → `Changeset`, including TS symbol mapping.
2. The `effects` analyzer, with fixtures.
3. Score and reconcile, with `--no-llm` producing terminal output. End-to-end
   value with no API key required.
4. Interpret, and the tier assignment that depends on it.
5. The remaining three analyzers: `surface`, `blast-radius`, `guards`.
6. HTML report and the JSON contract.

## Deferred

- GitHub pull request as an input source
- Multi-repo scheduled digest
- Non-TypeScript structural analysis (tree-sitter, honestly labeled as
  structural-only)
- Historical trend tracking across reviews
