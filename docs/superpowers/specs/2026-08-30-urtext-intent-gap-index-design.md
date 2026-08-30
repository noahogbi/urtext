# The intent-gap index — design

**Date:** 2026-08-30
**Status:** proposed
**Supersedes** `2026-08-30-urtext-least-expected-first-design.md`, which is rejected. That
document holds the measurements that killed two earlier attempts at this goal and should be
read first by anyone tempted to revisit them.

## The goal, and two ways it has already failed

The product thesis: *urtext answers "what changed" but not "what changed that you wouldn't
expect."* Two designs have tried to serve it by reordering the findings list on a
deterministic signal. Both were killed by measurement before any code was written.

**Attempt one — the messages name the symbol.** Across this repository's history, nine
commits added ten exported symbols between them and **zero** named the symbol in their own
message. Widening to every declaration produced matches on 8 of 14 commits, and every match
was a common English word landing in prose: `to`, `a`, `path`, `kind`, `band`. The signal
did not merely fail to fire — its only firings were false positives, in the expensive
direction.

**Attempt two — the shape of the change.** Co-change coupling, file rarity, and change-mass
share all discriminate cleanly on a real repository (roughly even thirds across 2,140
file-appearances in `omnisscientia`'s 1,061 commits). But validated against the closest
available ground truth — a change to a file that a later fix commit had to touch again,
n=382 — every lift landed between 0.97× and 1.25×. The signals fire beautifully and predict
nothing.

The proxy is noisy and a weak true effect could hide under it. But five tests moved nothing,
and a ranking key with 1.1× lift reorders the list arbitrarily with respect to what matters.

**What the failures have in common** is the attempt to reorder. Both designs put a new key
between band and score, and both then had to answer where standalone model claims sit —
where every available default breaks the project's evidence hierarchy (see "The problem that
outlived both attempts" below).

This design stops reordering.

## What is being built

A short index above the ranked findings, naming the findings the model marked
`beyondIntent`, with the ranked list below untouched and complete.

```
Not described by this change's messages (4)
  · [verified] guard_removed    src/auth/session.ts:142
  · [verified] export_added     src/api/admin.ts:88
  · [inferred] effect_network   src/lib/sync.ts:31
  · [model]    retry loop may not terminate  src/lib/sync.ts:64

Findings
  1. [verified] guard_removed  src/auth/session.ts:142  score 90
  ...
```

The reader meets the surprise first and the evidence in its ranked place. Nothing is
duplicated in full, nothing leaves its rank, and no finding is dropped.

## Why this is cheap: most of it already exists

The three hard problems the rejected design had to solve are already solved on this path.

**The model contract permits grouping.** `findings` is documented as "In rank order;
renderers must not reorder... A walker **may group by `lens` or `subject`** but preserves
this order within a group and may never drop a finding" (`src/report/model.ts:288-294`). An
index is grouping. The rejected design required changing the sort; this one is already
inside the contract as written.

**The mark is structurally guarded.** `withoutBeyondIntent` (`src/interpret/index.ts:45-52`)
deletes the marker from every claim when the run stated no intent, so the badge can never
say the messages fail to account for something when there were no messages.

**The truncation disclosure is shipped.** `intentTruncatedNote`
(`src/interpret/index.ts:32`) already discloses that a change described only in a dropped
message may be marked. The rejected design had to invent a suppression rule for exactly
this; here it exists.

What is genuinely new is one model field and its rendering on five surfaces.

## The mechanism

### One new field

```ts
export interface IntentGapEntry {
  /** The `findings` entry this points at, so a --json consumer can join. */
  id: string;
  /** "verified" | "inferred" | "model", rendered as the reader sees it. */
  tier: string;
  /** The finding's kind or, for a standalone claim, its summary. */
  label: string;
  /** "src/auth/session.ts:142". */
  location: string;
}
```

added to `ReportModel` as:

```ts
/**
 * An index into `findings`, in the same order, naming those the model marked
 * as not described by the change's messages. Always present, empty included —
 * a walker iterates without branching. Derived by filtering `findings` rather
 * than assembled independently, so it cannot diverge from the order or the
 * membership of the list it indexes.
 */
intentGap: IntentGapEntry[];
```

Entries carry precomputed strings because the surfaces are walkers: a renderer that had to
look an id up in `findings` would be computing, which is the thing the one-model-surfaces
refactor removed.

### Order is derived, never computed

The list is built by filtering `findings` in place. It therefore inherits rank order by
construction rather than by a sort that could disagree with the one beside it.

This is what makes the tier mix safe without a rule. `MODEL_CEILING`
(`src/score/reconcile.ts:14`) already sits strictly below the weakest score an analyzer can
produce, so standalone model claims sort below every fact-backed finding in `findings` —
and therefore below them in the index too. Evidence-backed entries lead; evidence-free ones
follow; nothing had to assert it.

### The legend is reused

`beyondIntentLegend` (`src/report/model.ts:287`) already carries `BEYOND_INTENT_MEANING`
exactly when at least one finding bears the mark. The index does not introduce a second
explanation of the same badge. It stays out of `notes`, for the reason the existing legend
does: a badge doing its job is not a shortfall and must not trip partial-review copy.

## The problem that outlived both attempts, and why it does not arise here

Standalone model claims (`claim:i:*`, `src/score/reconcile.ts:189-207`) come from no fact.
Any ranking key inserted between band and score has no entry for them, and both available
defaults break the evidence hierarchy:

- Default them to *unexpected* and uncorroborated model claims sort above verified
  findings — the inversion the rejected design's own problem statement named as
  disqualifying.
- Default them to *undetermined* and an accounted-for verified `guard_removed` at score 90
  sorts below a model claim capped at 3, silently repealing `MODEL_CEILING`.

**This design reorders nothing**, so no model-tier datum governs the position of any
verified finding, and the question never has to be answered. That is the strongest argument
for the segmentation approach over either rejected one, and it is worth stating plainly
because it is easy to lose: the constraint was not satisfied, it was dissolved.

## Behaviour under `--no-llm`

No key means no claims, no marks, and an empty `intentGap`. **The report says nothing at
all** — no section, no note.

This is a deliberate choice against disclosure, and it needs its reason on the record
because the project's default runs the other way. `--no-llm` running as designed is not a
shortfall, and the codebase already draws that line twice: `filterNote` and `coverageNote`
are kept out of `notes` precisely because "the filter running as designed is not a
shortfall" and a banner that fires on every routine diff is a banner readers learn to skip
(`src/report/model.ts:259-264`, `250-258`). A line on every default action run saying a
check did not happen would be the third such banner and the least informative.

The residual is real and is accepted rather than denied: a reader seeing no index may infer
nothing was unexpected, when what happened is that nothing looked. `README.md` must state
that this index requires a key — that is where the absence is explained, not in the output
of every keyless run.

## What the surfaces do

All five, because a model field rendered by four of them is the gap this project has already
paid for once:

- **Terminal, HTML, Markdown, PDF** — render the index above the findings list when
  `intentGap` is non-empty; render nothing when it is empty.
- **`--json`** — emit `intentGap` as the model carries it. The `--json` walker gap is
  already on the backlog; this design must not widen it.

## Testing

Every test must be answerable — it must fail if the production change is reverted. Two of
these are specifically designed against the failure mode where filtering silently reorders.

- The index preserves `findings` order. **Construct findings whose mark order differs from
  their rank order**, so a naive independent assembly would produce a different sequence,
  and assert the index positionally. A test using findings already in mark order proves
  nothing.
- A standalone model claim marked `beyondIntent` appears in the index, tier-labelled
  `model`, and appears **after** every fact-backed entry — asserted with a fact-backed
  finding whose score is low, so `MODEL_CEILING` is what orders them rather than a
  coincidence of the fixture.
- Every id in `intentGap` resolves to a finding in `findings`; no finding is dropped from
  `findings` by the index's existence; no entry appears twice.
- `intentGap` is `[]`, not absent, when no finding is marked.
- A `--no-llm` run produces an empty `intentGap` and no surface renders a heading.
- All five surfaces carry the index — the four renderers and `--json`.
- The heading clears the copy guard. Verified against the current list: `FORBIDDEN` is
  `unsanctioned`, `unauthorized`, `approved`, `permission`, `forbidden`, `allowed`
  (`test/report/copy-guard.test.ts:25-32`), and "Not described by this change's messages"
  contains none. The guard's fixture must gain a marked finding, or the new copy is never
  under scrutiny.

## The pre-registered check

Two designs for this goal have died on measurement. This one gets the same treatment before
it ships, and the threshold is set now rather than after the number is known:

**Run a real keyed review and inspect the index.** It passes if the list is short — a
handful of entries, not a second copy of the findings list — and if its entries are ones a
reader would want surfaced first. It fails if the model marks nearly everything (the index
becomes noise) or nearly nothing (the index never appears and the feature is inert).

If it fails, this design is rejected like the other two rather than rescued with a cap
chosen to make the number look acceptable. A length cap may turn out to be right, but
adopting one pre-emptively would hide exactly the signal this check exists to read.

## Risks

| Risk | Handling |
|---|---|
| The model marks too many claims and the index becomes a second report | The pre-registered check above, with rejection as a real outcome rather than a formality |
| A reader takes an absent index as "nothing was unexpected" | Accepted and documented; `README.md` states that the index requires a key. Reversible: adding the quiet line later costs one field |
| The index and the findings list disagree about order | Structural, not tested-for-only: the index is derived by filtering `findings`, so divergence requires someone to rewrite the derivation. The positional test above is the guard on that rewrite |
| Uncorroborated model claims gain prominence at the top of the report | They sort last within the index by `MODEL_CEILING`, and carry their tier label. The reader sees `[model]` before they read the claim |
