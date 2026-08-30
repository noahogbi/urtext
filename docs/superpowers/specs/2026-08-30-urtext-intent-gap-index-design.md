# The intent-gap index — design

**Date:** 2026-08-30
**Status:** proposed (revised after review)
**Supersedes** `2026-08-30-urtext-least-expected-first-design.md`, which is rejected. That
document holds the measurements that killed two earlier attempts at this goal and should be
read first by anyone tempted to revisit them.

## The goal, and two ways it has already failed

The product thesis: *urtext answers "what changed" but not "what changed that you wouldn't
expect."* Two designs tried to serve it by reordering the findings list on a deterministic
signal. Both were killed by measurement before any code was written.

**Attempt one — the messages name the symbol.** Nine commits in this repository added ten
exported symbols between them and **zero** named the symbol in their own message. Widening
to every declaration produced matches on 8 of 14 commits, and every match was a common
English word landing in prose: `to`, `a`, `path`, `kind`, `band`. Its only firings were
false positives.

**Attempt two — the shape of the change.** Co-change coupling, file rarity, and change-mass
share all discriminate cleanly on a real repository (roughly even thirds across 2,140
file-appearances in `omnisscientia`'s 1,061 commits). Validated against the closest
available ground truth — a change to a file that a later fix commit had to touch again,
n=382 — every lift landed between 0.97× and 1.25×. The signals fire beautifully and predict
nothing.

**The ranking goal is dead, and this document does not revive it.** This design is not a
third attempt at the same thing; it is a strictly smaller claim. It predicts nothing, ranks
nothing, and reorders nothing. It collects marks the tool already makes and already renders,
into one glance-sized block.

That retreat is defensible for one structural reason: the failure mode is bounded. A wrong
ranking corrupts the tool's primary output. A bad index is a redundant list a reader learns
to skip, and rejecting it at the check below costs one field.

## What is being built

A short index above the ranked findings, naming the findings the model marked
`beyondIntent`, with the ranked list below untouched and complete.

```
Not described by this change's messages (4)
  · [inferred] guard_removed      src/auth/session.ts:142
  · [inferred] effect_added       src/lib/sync.ts:31
  · [inferred] export_added       src/api/admin.ts:88
  · [model]    retry loop may not terminate  src/lib/sync.ts:64

Findings
  1. [verified] guard_removed  src/auth/session.ts:142  score 90
  ...
```

### The index can never contain a `verified` entry

Every tier chip above is `inferred` or `model`, and no fixture or future change can add a
third. The mark originates only on a `Claim`, and it reaches a fact-backed finding through
exactly one path — the claim-attachment branch at `src/score/reconcile.ts:149-177`, which
sets `tier: tierFor(fact, entry.claim)` in the same object spread that carries the mark.
`tierFor` returns `inferred` whenever the claim corresponds to the fact
(`src/score/index.ts:153-157`), and `entry.factId` **is** `entry.claim.correspondsTo` by
construction, so the code states the consequence directly: "`tierFor` can only ever return
`inferred` here" (`reconcile.ts:153-156`). `toFinding` produces `verified` findings and
never sets the mark; standalone claims are `model` tier. A marked group takes the same
attach-to-absorber path and is likewise `inferred`.

This follows from what the tiers mean. A `verified` finding is one the model said nothing
about, and the mark is something the model says — so "marked and verified" is a
contradiction, not a gap.

**Two consequences the rest of this document depends on.** The trade in "Prominence" below
is smaller than it first appears: no `verified` finding is ever repositioned by this
feature, because none can be in the index. And the disclosure owed is larger: **the index
is model-mediated in its entirety, and `inferred` is its strongest possible tier.** That is
the honest framing for the heading's voice and for where the legend sits.

Earlier drafts of this document showed `[verified]` entries and a different order. Both were
wrong, and both were in the worked example rather than in a cited claim — see "Review
history".

## Ordering: an explicit rule, because the implicit one does not hold

**The retracted claim.** The first draft argued that the index could simply filter
`findings` in place and would then show evidence-backed entries first "with no special
rule", because `MODEL_CEILING` (`src/score/reconcile.ts:14`) caps standalone model claims
below every analyzer score.

The premise is true and the inference is false. The final sort keys **band before score**
(`src/score/reconcile.ts:220-230`). A standalone claim's id belongs to no fact, so it has no
entry in the band map and takes the `?? 0` default — the **defect** band. The code states
the consequence outright, in two places:

> "A standalone model claim comes from no fact either, has no entry, and so lands in the
> defect band — score still orders it against other defects, **and it now sits above every
> context row regardless of score**" — `src/score/reconcile.ts:216-219`, and again at
> `src/score/index.ts:585-591`.

`CONTEXT_KINDS` is `{blast_radius, export_added}` (`src/score/index.ts:562-565`). So a
fact-backed `export_added` finding sorts **below** an evidence-free model claim, and a
filter-in-place index would print `[model]` above `[inferred]` in the report's prime
position — an evidence-free claim above a finding an analyzer corroborated, which is the
inversion this design exists to avoid. (`inferred`, not `verified`: a marked fact-backed
finding is always `inferred`, per the section above.)

**The rule.** The index is assembled in two passes, each preserving `findings` order:

1. Fact-backed entries (`verified` and `inferred`), in `findings` order.
2. Standalone model entries, in `findings` order.

This is a real ordering rule and is stated as one. The index therefore *may* differ in order
from `findings`, and that is deliberate rather than a defect: the ranked list is ordered for
triage, where a claim alleging a problem belongs in the defect band; the index is ordered by
what a reader can check, where evidence leads. Both orders are correct for their own job,
and neither is derived from the other by accident.

## Prominence is the real trade, and the honest name for it

The predecessor was rejected partly because standalone model claims had no entry in a new
map and every default broke the evidence hierarchy. It is tempting to say this design
*dissolves* that problem because nothing is reordered. That is half-true and the half that
is false matters.

What is genuinely dissolved: no key is inserted between band and score, no verified
finding's **rank** is governed by model-tier data, and the unexpected/undetermined default
never has to be chosen.

What is **not** dissolved: prominence is a form of presentation, and a model judgement now
decides which findings lead the report. An uncorroborated claim in that block draws more
attention than its rank-12 slot below.

But the trade is narrower than it first looks, for the reason established above: **no
`verified` finding can appear in the index**, so the convention that model-tier data must
not govern the presentation of verified findings is not bent by index membership at all.
Every entry is already a finding the model spoke about — `inferred` at best. What the badge
does today on all four surfaces (`terminal.ts:165`, `html.ts:192`, `markdown.ts:133`,
`pdf.ts:144`) is annotate those same findings; the index aggregates the same marks into one
place.

**The honest description is: relocated from rank to prominence, over a set that is
model-mediated end to end, with the tier label and the two-pass order as the controls.**
The disclosure that matters is therefore not "some verified findings were promoted" — none
were — but "this block is the model's judgement, and nothing in it is better than
`inferred`." Stated plainly so a later reader evaluates the real trade rather than an
elegance claim.

## What already exists, and what is new

**The mark is structurally guarded.** `withoutBeyondIntent` (`src/interpret/index.ts:45-52`,
applied at `:90`) deletes the marker from every claim when the run stated no intent, so the
badge can never say the messages fail to account for something when there were no messages.

**The truncation disclosure ships.** `intentTruncatedNote` (`src/interpret/index.ts:32-34`)
discloses that a change described only in a dropped message may be marked, and flows into
`warnings` at `cli.ts:427`. The predecessor had to invent a suppression rule for this.

**The model owns content decisions**, which is this design's actual authorization
(`src/report/model.ts:16-42`). An earlier draft cited the `findings` grouping clause at
`model.ts:288-294` instead; that clause permits grouping by `lens` or `subject` — two
enumerated keys — and `beyondIntent` is neither. The index is a new model field, not a
walker regrouping the list, so the grouping permission was never the right authority.

What is new: one model field, its derivation, and its rendering on five surfaces.

## The field

```ts
export interface IntentGapEntry {
  /** The `findings` entry this points at, so a --json consumer can join. */
  id: string;
  tier: Tier;
  /**
   * What the entry is: a fact-backed finding's kind, or a standalone claim's
   * summary. Segmented, never a plain string — for a standalone claim this is
   * model prose from a network response, and the model's rule is that content
   * fields carry `ConcealSegment[]` so no raw concealing character reaches a
   * surface (`src/report/model.ts:27-37`).
   */
  label: ConcealSegment[];
  file: string;
  line: number;
}
```

`file` and `line` stay structured rather than being pre-joined into a display string, so
`--json` consumers get the same shape `findings` gives them and each surface formats the
location in its own idiom.

**Deriving `label` needs plumbing this design must budget for.** `FindingView` carries no
`kind` (`src/report/model.ts:138-192`), and `kindOf`/`subjectOf` are private to `model.ts`.
A fact-backed entry's label must therefore be derived inside `model.ts` where the id prefix
is already parsed — not by a surface, and not by re-deriving the kind a second time
elsewhere. An earlier draft's example used `effect_network`, which is not a kind at all: the
kinds are `effect_added` and `effect_removed` (`SUBJECT_OF_KIND`, `model.ts:428-437`), and
the effect's name lives in `fact.detail`, which the model layer never sees.

**Attribution.** All model prose lives in `modelNote` so no surface can render it without
attribution (`model.ts:170-174`). A standalone claim's summary appearing in the index is the
same sentence in a less-attributed place, and a bare `[model]` tag is weaker than
`MODEL_CAUTION_STANDALONE` (`model.ts:399-400`) requires elsewhere.

**The model composes one attribution string for the index**, carried in its own field and
present exactly when `intentGap` contains a standalone entry — the same
absent-or-present gating `beyondIntentLegend` already uses (`model.ts:737-739`). It is built
from the recorded model name, falling back to `UNNAMED_MODEL` (`model.ts:390-396`) so a run
that recorded no name shows attribution that is visibly incomplete rather than absent, and
it carries `MODEL_CAUTION_STANDALONE`. Every surface renders it unconditionally when
present. It is new reader-facing copy, so it goes through the copy guard.

An earlier draft made this conditional — "a surface that cannot place the attribution
adjacently omits standalone entries instead." That was wrong three times over, and the fix
is recorded rather than silently applied because the error is instructive. It delegated a
**content** decision to renderers, contradicting the one-model-surfaces charter this very
design cites as its authorization: "Everything a surface may say about content — which
findings, in what order... is decided here, once; a renderer applies format mechanics...
never a decision of its own" (`model.ts:21-25`). It would have let `--json` (which emits
`intentGap` whole) disagree with any surface that took the exit. And it guarded a case that
cannot arise: every surface renders the index as a block it controls, so there is no layout
here where "adjacent" is unachievable.

**Groups.** A claim citing an absorbed fact attaches to the group, and the mark travels with
it (`reconcile.ts:140`, `:169-176`), so the index points at the **group id**. Its label is
the **group finding's title**, not `kindOf`'s stripped member kind — calling a seven-export
group `export_added` beside one member's `file:line` would misdescribe it. Note that groups
of context kinds sit in band 1, which the two-pass rule above already handles.

## Behaviour under `--no-llm`

No key means no claims, no marks, an empty `intentGap`, and no index. **No new copy is
added**, and the reason is not the one an earlier draft gave.

That draft cited `filterNote` and `coverageNote` as precedent for saying nothing. They are
not: both are *rendered disclosures* deliberately kept out of `notes` so they do not trip
partial-review copy (`model.ts:250-258`, `259-264`). Their precedent is "disclose outside the
banner", not "do not disclose", and citing them for silence borrows authority from cases
that differ in exactly the relevant way.

The real support is stronger and already shipped. `cli.ts:422` pushes `result.skipped` into
`warnings` on every run whose interpretation stage was skipped, and under `--no-llm` that
reason is `"--no-llm was set, so the model was not asked"` (`src/interpret/index.ts:78`).
**The report already says the check did not run, on every keyless run, on every surface.**
No second sentence is needed, and the residual an earlier draft accepted — that a reader
might read absence as "nothing was unexpected" — is largely already closed by copy that
exists.

`README.md` should still state that the index requires a key, but it is documenting
behaviour the report already discloses rather than compensating for silence.

## What the surfaces do

All five, because a model field rendered by four of them is a gap this project has paid for
once already:

- **Terminal, Markdown** — the index above the findings list; nothing when empty.
- **HTML** — the report has a three-pane lens structure (`LENSES`, `model.ts:320-324`), so
  "above the findings list" names no single place. The index renders **above the lens panes**,
  as a single block spanning them, because it indexes findings across all three.
- **PDF** — above the findings section and below the notes, so a partial-review disclosure is
  never pushed below a block that is not itself a disclosure.
- **`--json`** — emit `intentGap` as the model carries it. A new always-present top-level key
  is non-breaking for consumers. Adding it to `ReportModel` will trip the guard in
  `test/cli.test.ts`, "accounts for every model field in the JSON object, or exempts it by
  name" — which is the guard working: the decision is forced rather than defaulted. That
  test has caught this exact gap before, for `kindNotes` and again for `untrackedCount`
  (`src/cli.ts:644-655`).

## Testing

Every test must be answerable — it must fail if the production change is reverted.

- **The ordering rule, against the case that broke the first draft.** Construct an
  `inferred` `export_added` finding (context band) and a standalone model claim (defect
  band, score ≤ 3). In `findings` the claim sorts **above** the export; in the index the
  export must come first. Assert positionally. A fixture using a defect-band fact-backed
  finding would pass under both the correct rule and the retracted one, and so proves
  nothing. The fixture is `inferred`, not `verified`, because `verified` is unreachable for
  a marked finding — a test asserting on a state production cannot produce is a test whose
  passing means nothing.
- **One test drives the real path**, `reconcile` → `buildReportModel`, rather than
  hand-built findings. This is not belt-and-braces: this repository's banding bug shipped
  precisely because a unit test over `rank` passed while the path a review actually takes
  was never exercised (`reconcile.ts:209-213`). Every other test here may use fixtures; at
  least one must not.
- **No index entry is ever `verified`.** Asserted through the real path, so it pins the tier
  chain rather than the fixture builder.
- Fact-backed entries preserve `findings` order among themselves; standalone entries preserve
  it among themselves. Construct at least two of each, interleaved in `findings`.
- Every id in `intentGap` resolves to a finding in `findings`; no finding is dropped from
  `findings`; no entry appears twice.
- `intentGap` is `[]`, not absent, when nothing is marked.
- A `--no-llm` run produces an empty `intentGap`, no surface renders a heading, and the
  existing skip note still appears — the last clause guards against a future change that
  removes the disclosure this design's argument depends on.
- `label` carries `ConcealSegment[]`: a standalone claim whose summary contains a
  bidirectional override renders as a labeled code point in the index on every surface, not
  as the raw character. This is the Trojan Source guarantee, and the index is a new place for
  it to leak.
- Every surface renders the index attribution when the model carries it, and the model
  carries it exactly when `intentGap` holds a standalone entry. A run with no recorded model
  name renders `UNNAMED_MODEL` rather than omitting attribution.
- A marked finding absorbed into a group produces one entry pointing at the group id, labeled
  with the group finding's **title**.
- All five surfaces carry the index.
- The heading clears the copy guard. `FORBIDDEN` is `unsanctioned`, `unauthorized`,
  `approved`, `permission`, `forbidden`, `allowed` (`test/report/copy-guard.test.ts:25-32`),
  and "Not described by this change's messages" contains none. The guard's fixture already
  carries marked findings (`copy-guard.test.ts:62`, `:73`), so the new copy comes under
  scrutiny without changing it.

## The pre-registered check, with numbers

Two designs for this goal died on measurement. This one is measured before it ships, and —
unlike the first draft, which said only "nearly everything or nearly nothing" — the
thresholds are numeric, set now.

**Ranges:** at least five keyed reviews of real ranges, **including at least one default
working-tree range**. The range mix is not optional. On the default range, uncommitted
changes are described by no message (`Intent.endsAtWorkingTree`, `src/extract/intent.ts:27-28`),
and the only thing standing between the model and marking every uncommitted hunk is a prompt
caveat (`INTENT_WORKTREE_CAVEAT`, `src/interpret/prompt.ts:65-66`, applied at `:101`) plus
"omit when in doubt" (`prompt.ts:77`) — instructions, not a structural guard like
`withoutBeyondIntent`. A check run only on clean committed ranges can pass while the tool's
most common invocation drowns. The predecessor had a section titled "The working-tree
problem, which decides whether this works at all"; the first draft of this document did not
contain the words "working tree."

**Reject as noise** if the marked count exceeds `max(2, N/3)` on any tested range. The index
is meant to be a handful of entries; at a third of the report it is a second copy of it. The
floor matters because a bare fraction is decided by rounding on small reviews — 1 marked of
3 findings should not trip a noise gate.

**Reject as inert** if zero findings are marked across all five reviews. For this to mean
anything, **one range must be pre-registered as containing a known surprise** — a range whose
messages demonstrably omit something the diff does. Without it, a zero outcome cannot
distinguish "the mark never fires" from "nothing was beyond intent in these five," and the
gate proves nothing either way.

If either fires, this design is rejected like the other two, rather than rescued with a cap
chosen once the number is known. A length cap may be right, but adopting one pre-emptively
would hide the very signal the check exists to read.

This check is also the first measurement of `beyondIntent`'s precision, which has never been
measured. If the mark fires on a third of every review, the correct conclusion is not a cap —
it is that this goal ends at the badge that already ships.

## Risks

| Risk | Handling |
|---|---|
| The model marks too many claims and the index becomes a second report | The numeric check above, with rejection as a real outcome |
| Uncorroborated model claims gain prominence at the top of the report | The two-pass rule puts them after every fact-backed entry, and the tier label precedes each one. Named in "Prominence is the real trade" as a bent convention rather than a solved problem |
| A reader takes the index for a list of verified problems | No entry can be `verified`, and every chip says `inferred` or `model`. The index attribution states whose judgement the block is |
| Model prose reaches a surface unsegmented or unattributed | `label` is `ConcealSegment[]`; the model composes one attribution string rendered unconditionally by every surface; both are tested |
| A reader takes an absent index as "nothing was unexpected" | Already closed by the existing skip disclosure at `cli.ts:422`, which fires on every keyless run |
| The index and `findings` disagree about order | They do, by design, and the reason is stated. The positional test pins the intended difference so a future filter-in-place "simplification" fails |

## Review history

Kept because two consecutive specs in this project carried false codebase claims past
drafting, and the pattern is more useful than either instance.

- **First draft** asserted that the index would show evidence-backed entries first with no
  ordering rule, because `MODEL_CEILING` caps model claims below every analyzer score. False:
  the sort keys band before score, and standalone claims default into the defect band. The
  code said so in comments on the cited lines.
- The same draft cited `filterNote`/`coverageNote` as precedent for silence when they are
  precedent for disclosure-outside-the-banner, and missed that `cli.ts:422` already discloses
  the case.
- It typed `label` as a plain string, which would have made it the model's only unsegmented
  content field.
- Its worked example used `effect_network`, which is not a kind.
- **Second draft** showed `[verified]` entries in the index. Impossible: the mark only reaches
  a fact-backed finding through the claim-attachment path, which forces `inferred`. It also
  built the whole "Prominence" argument on verified findings being repositioned, when none
  can be. And it made index attribution conditional on a surface's layout, delegating a
  content decision to renderers in a document whose stated authorization is that the model
  owns content decisions.

**The rule this project should adopt**, in two clauses, because the first clause alone would
have caught neither the second draft's error nor the third's:

1. Every `file:line` claim in a spec is checked against the file before status leaves
   "proposed" — and checking that a citation points at the right line is not the same as
   checking that the claim about its behavior is true. The first draft's citations were all
   correct and its claims were not.
2. **A worked example is a behavioural claim and must be derived by tracing the real
   pipeline, not composed by hand.** Every falsehood in this document's history lived in an
   example, and the second draft's carried no citation at all — so clause 1 could never have
   caught it. An example that shows output is asserting the code produces that output.
