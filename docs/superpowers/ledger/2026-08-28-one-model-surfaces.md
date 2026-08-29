# One Model, Four Walkers — execution ledger

Every ruling made while executing
`docs/superpowers/plans/2026-08-28-urtext-one-model-surfaces.md`. A ruling is
anything the plan did not decide, or decided wrongly, that had to be settled to
proceed. Recorded as it happens, not reconstructed afterwards.

**Workspace:** `.claude/worktrees/one-model-surfaces`, branch
`refactor/one-model-surfaces`, based on `fix/signal-over-noise` @ `0fa162a`
(PR #10, unmerged — the spec and plan live on it).

**Baseline:** 875 tests, `tsc --noEmit` clean, verified in this worktree before
any task ran.

**Setup ruling — `node_modules` is a junction, not a copy.** The worktree's
`node_modules` is a Windows junction to the main checkout's. An `npm install`
per worktree costs minutes and disk for an identical tree, and MSYS `ln -s`
silently *copies* here rather than linking (learned the hard way earlier in this
session — a 74-entry "symlink" that was a full copy). **Cleanup consequence:**
the junction must be removed on its own before the worktree is removed, or a
recursive delete can traverse it into the real `node_modules`.

---

## Rulings

### Task 1 — the plan preserved a comment its own change made false

**The plan said:** Step 3, "Leave the comment above the old `jsonModel` build in
place, moved with it."

**What that produced:** the comment opens "Built for one sentence, and built
rather than recomposed on purpose" — true while the model existed only to
supply `distributionNote`, false the moment `counts` reads it too. It landed
directly beneath the new comment saying the model supplies the tally, so the
two contradicted each other on the page. The executing subagent followed the
instruction literally, flagged it, and did not fix it unasked — which is the
right order.

**Ruling:** fixed in a follow-up commit on this task. The clause "for one
sentence" goes; the rest of the comment stays, because its argument (build the
model rather than recompose its conclusions) is exactly what reading `counts`
from it demonstrates. Widened to "for every sentence it supplies", and the
tally named alongside the citation rule as a second thing not to re-derive.

**Why it matters beyond one comment:** Task 3 handles this class explicitly
(`conceal.ts`'s header, the `esc` doc), which is what makes the omission here an
oversight rather than a decision. A plan that says "leave the comment" is
asserting the comment stays true; that assertion needs checking every time.

### Task 2 — a test title the plan wrote that its own rule forbids

**The plan said:** name the first test "carries only the exported
declarations, with their file".

**The problem:** its fixture holds one symbol, exported. Delete the
`.filter(sym => sym.exported)` the test exists to pin and it still passes —
the word "only" is earned by the *second* test, not this one. Run the
project's own answerability question against that title ("could this pass if
the thing its name promises were broken?") and it fails. Written into the plan
by me, through three review rounds, and caught by the executor applying the
rule the plan itself states.

**Ruling:** renamed to "carries an exported declaration's change, name, kind,
and file" — what it actually asserts — with a comment recording why, and
"only" left where it is earned. The alternative, adding an unexported symbol
to this fixture so the title becomes true, was rejected: it would duplicate
the second test rather than sharpen the first.

The dead `over` parameter on `withSymbols` went at the same time: no test in
this task passes it and none in Task 3 needs it.

### Task 3 — the escape round-tripped into the raw character, twice, to two actors

**What happened:** the executor wrote `RLO` into `test/report/html.test.ts` as
the six-character escape and the editing tool stored the U+202E *character*
instead. It caught this with a byte check, rewrote the range through Python,
and verified zero raw bytes before running anything. The identical thing
happened to me earlier the same day, editing this plan — my first fix of a raw
U+202E re-planted it.

**Ruling:** this is a tool behaviour, not a mistake either actor can avoid by
being careful, so it becomes a Global Constraint rather than a note: after
writing a `\uXXXX` escape into any file, byte-check that file; if the escape
did not survive, rewrite that range with Python. The plan already warned about
the character. What it assumed — that writing the escape is sufficient — is
false here.

Verified after this task: zero raw concealing characters across all of `src/`,
`test/`, and `docs/`.

### Task 3 — the plan's staging line contradicted its own step

**The plan said:** Step 4, rewrite `src/report/conceal.ts`'s header "in this
commit, not be left for a reader to trip over". Step 6, `git add
src/report/html.ts test/report/html.test.ts`.

Following Step 6 literally leaves `conceal.ts` dirty, carrying a comment that
names a function this task deletes, to be swept into Task 4's commit — exactly
what Step 4 forbids. The executor staged all three and flagged it.

**Ruling:** plan corrected; the staging line and the task's Files list now name
`conceal.ts`. The executor's observation that Task 5 uses a `test/` wildcard
where this task used a fixed list is right, and is why the remaining staging
lines were audited rather than assumed.

### Task 3 — one comment the plan left to the executor's judgement

The `esc()` doc had to lose a count ("Three contexts", "Both wrappers") and the
plan gave no target text, unlike every other comment it rewrites. The executor
wrote "The one wrapper calls this one", noting the awkwardness itself.

**Ruling:** changed to name the function instead of counting — "`seg` calls
this one" — since `prose` builds on `seg` rather than on `esc`, which is what
made "both wrappers" loose to begin with. A count that needs a caveat is worse
than a name.

### Task 2 — a forward defect in Task 6, fixed before its executor arrives

Task 6 said the type import at `html.ts:16` "loses its users". The line is
`import type { Changeset, ChangedSymbol, Finding }`, and `ChangedSymbol` keeps
a user at `:362` — `SYMBOL_CHANGE_MARK`'s `Record<ChangedSymbol["change"],
string>`. An executor deleting the line rather than the two names fails `tsc`.

**Ruling:** the plan is corrected in place, now naming the two names to remove
and the one to keep. Found by Task 2's executor reading ahead, which is worth
more than it cost.

### Task 1 — two smaller notes, no ruling needed

- Steps 2 and 3 overlap: Step 2 writes `metaFor()` into the `jsonModel` build,
  Step 3 relocates that same statement. Executed as one edit. Harmless, but the
  "three literals" framing hides that only two stay put.
- Step 1's placement drops `metaFor` into the run of report-state declarations
  it serves rather than above them. Left as specified; it reads fine.
