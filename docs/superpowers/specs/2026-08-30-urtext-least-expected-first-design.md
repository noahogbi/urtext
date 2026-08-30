# Least-expected-first ranking — design

**Date:** 2026-08-30
**Status:** proposed
**Builds on** `2026-08-23-urtext-intent-design.md` (the `beyondIntent` marker) and the
defect/context banding added in `2026-08-28-urtext-one-model-surfaces-design.md`'s change
set.

## The problem

Noah's product read after real use: *"urtext answers 'what changed' but not 'what changed
that you wouldn't expect'. Ranking should be least-expected-first, not biggest-first."*

The marker built to feed that ranking already exists. `beyondIntent` is set by the
interpretation stage, carried through `reconcile`, and rendered as a badge on all four
surfaces. **It does not affect ordering at all.** Both sorts key on band, then score, then
file, line, and id. Nothing reads `beyondIntent`.

It also cannot feed the ranking as it stands, for two reasons:

1. **It is a model judgement**, available only when a key is supplied. The default
   invocation, and the action's default, is `--no-llm`. A ranking that exists only for
   keyed runs is not the tool's ranking.
2. **It is model-tier evidence deciding the order of verified findings.** A `verified`
   finding's position would be governed by something nothing mechanical corroborates,
   which inverts the project's own hierarchy.

## Decisions taken

Three, settled before this document was written:

**The signal is deterministic.** urtext decides expectation itself, from the commit
messages in the range, so it works under `--no-llm` and is `verified`-grade.

**Expectation sits inside the bands.** The sort becomes band → expectation → score.
Defects still outrank context; within a band, the unexpected comes first. The alternative
— expectation above the bands — would let an unexpected reach row outrank an announced
removed guard, which is precisely the defect banding was added to fix.

**A message must name the symbol.** Naming the file is not enough. The error costs are
asymmetric: wrongly marking a finding *accounted for* buries the surprise the tool exists
to surface, while wrongly marking it *unexpected* only lifts something the reader already
knew. Every loosening of the match moves errors into the expensive direction.

## The mechanism

### Intent becomes unconditional

`cli.ts:411` currently reads:

```ts
const intent = opts.noLlm ? undefined : await collectIntent(root, changeset.range);
```

It becomes unconditional. `collectIntent` runs `git log` locally and makes no network
call, so the privacy claims in `README.md` and `SECURITY.md` are unchanged: under
`--no-llm` nothing still leaves the machine. What changes is that the messages are now
read on every run rather than only when they are about to be sent somewhere.

### `src/score/expectation.ts`

A new module, mirroring `bandsFor`'s shape:

```ts
/**
 * Whether the change's own messages account for a fact.
 *
 * `unexpected` sorts first, `accounted` last, and `undetermined` between —
 * see the three-state argument below.
 */
export type Expectation = 0 | 1 | 2; // unexpected | undetermined | accounted

export function expectationsFor(facts: Fact[], intent: Intent | undefined): Map<string, Expectation>;
```

**Matching is strict, and deliberately so.** A message accounts for a fact when it
contains the fact's symbol as a whole word, matched case-sensitively, against either the
bare identifier or the scope-qualified name. Case sensitivity is load-bearing: "validate
the token" must not account for `validateToken`. Word boundaries are load-bearing too:
without them a symbol named `run` matches "running", "runner", and half of every message.

### Three states, because two would require asserting what is not known

Not every fact has a symbol. `citation_rot` has none — it has a citing file and a cited
file. Some effects have none. For those facts the question "did the messages name its
symbol" has no answer, and both available lies are costly:

- Calling them **unexpected** floods the top of every review with citations, which is the
  noise this ranking exists to remove.
- Calling them **accounted for** buries them, which is the expensive error.

So they are `undetermined` and sort between. A reader asking why a citation sits mid-list
gets the honest answer: the tool could not tell, and did not guess. This is the same rule
the evidence tiers apply to findings, turned on the ranking.

### The working-tree problem, which decides whether this works at all

`Intent` carries `endsAtWorkingTree`, and the **default range is the working tree against
the merge-base**. Uncommitted changes are described by no commit message. Under a naive
reading of the rule, every fact in an uncommitted file is "unexpected", every default
`urtext review` sorts by surprise-that-isn't, and the feature is worse than useless in its
most common invocation.

**Rule:** a fact whose file has uncommitted changes is `undetermined`, never `unexpected`.
The messages had no opportunity to describe it. `changeset` already knows which files came
from the working tree, so this needs no new git call.

The consequence is worth stating plainly: **on a working-tree review, most facts are
undetermined and the ranking degrades to today's band-then-score behaviour.** That is
correct. The ranking answers "did you say you were doing this", and before you have
written the message there is nothing to have said.

### The omitted-commits problem

`Intent.omitted` counts commits that did not fit `MAX_INTENT_COMMITS`. A fact whose symbol
was named only in an omitted commit would be marked unexpected on a technicality.

**Rule:** when `omitted > 0`, no fact may be marked `unexpected` — the whole review's
expectations collapse to `undetermined` or `accounted`. A ranking built on a partial
reading of the messages should not claim a surprise it cannot support. This is a
`ReportModel.notes` disclosure, because a review whose ranking was suppressed is a review
that fell short.

### Groups take their most unexpected member

`export_added_group` and `signature_changed_group` ids belong to no fact, so — exactly as
with banding — the map is extended from `absorbedBy` after the grouping passes run. A
group takes the **minimum** expectation of its members: if one member surprises, the
container surprises. A group is a presentation device, and hiding a surprise inside one
would defeat both features at once.

### Both sorts, one map

`rankWithAbsorption` computes the expectation map and returns it alongside `bands`;
`reconcile` takes it rather than deriving its own. This is not belt-and-braces. Banding
was added to one sort alone first, a unit test over `rank` passed, and the shipped ordering
never moved, because `rank` is not the path a review takes.

## The two-signal problem

`beyondIntent` and this deterministic expectation answer the same question by different
means, and they can disagree: the model may mark a claim beyond intent while the matcher
finds the symbol named, or the reverse.

**For this version they stay independent, and the document says which is authoritative for
what.** `beyondIntent` remains a badge on model claims and affects nothing about order.
Deterministic expectation governs order and is not rendered as a badge on model-tier
findings. Neither is derived from the other.

That is a deliberate deferral, not a resolution. Two mechanisms answering one question is
how documentation goes stale, and a later change should either reconcile them or retire
one. Recorded here so the next reader does not have to rediscover the overlap.

## What the reader sees

An ordering that cannot be explained is worse than no ordering. An unexpected finding
carries a short line naming what was measured:

> The change's messages do not mention `validateToken`.

Stated as a measurement, never as a judgement. The copy guard in
`test/report/copy-guard.test.ts` bans the sanction vocabulary on every surface, and this
sentence must pass it: it describes what the messages contain, not what anyone permitted.

No line is printed for `accounted` or `undetermined` findings. Absence of a marker is not
a claim.

## What this changes for existing users

**Output reorders on every run, including `--no-llm` and the action's default.** That is
the feature, but it is a behaviour change to the tool's primary output and belongs in the
release notes rather than being discovered.

Unchanged: which findings appear, their tiers, their evidence, the `--json` object's shape,
and every disclosure.

## Testing

**The answerability rule applies hardest here**, because a ranking test that constructs
findings which would sort the same way anyway proves nothing. Every ordering test must
construct a case where the expectation key is the *only* thing separating two findings,
and assert the full order positionally rather than a containment.

Specific cases:

- A high-score accounted-for defect sorts below a low-score unexpected defect **in the
  same band** — the headline behaviour.
- An unexpected context row still sorts below an accounted-for defect — banding survives.
- A symbol-less fact sorts between, not first and not last.
- A working-tree fact is undetermined even when no message mentions it.
- `omitted > 0` suppresses every `unexpected` verdict and discloses.
- A group with one unexpected member sorts as unexpected.
- Case: "validate the token" does not account for `validateToken`.
- Word boundary: a message containing "running" does not account for `run`.
- Both sorts agree — asserted through `reconcile`, the path a review takes.

## Risks

| Risk | Handling |
|---|---|
| Strict matching marks almost everything unexpected, and the ranking becomes noise | Measure on real ranges before shipping: this repository's own history, and a range from `omnisscientia`. If the unexpected share is above roughly half, the rule is wrong and the spec returns for redesign rather than the threshold being tuned quietly |
| Symbol names that are common English words (`run`, `get`, `map`) match prose accidentally, marking real surprises accounted-for | Case-sensitive whole-word matching, and the measurement above will surface it. A minimum symbol length is the obvious lever if it does, but is not adopted pre-emptively |
| Reordering confuses existing users | The marker explains each lift; the release notes state the change |
| The two signals drift apart | Recorded above as a known deferral with the resolution options named |
