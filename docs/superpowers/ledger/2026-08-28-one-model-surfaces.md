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

### Task 5 — the tripwire earned its place, and proved the plan's warning true

**What the plan feared:** the export lines placed *after* the walker's trailing
blank push instead of inside the report-path block would insert a blank line
that does not exist today and drop the final newline, gluing `cli.ts`'s
gitignore tip onto the last export line — while every existing assertion, being
a substring check, stayed green.

**What the executor did:** got the placement right first time, then deliberately
broke it to check the tripwire discriminates. Under the wrong placement the new
tail-exact test failed with the expected diff **and all 81 `test/cli.test.ts`
tests still passed.** The regression really would have shipped silently. The
placement was restored by editing, not by `git checkout --`.

Independently confirmed here against the real binary (`node dist/bin.js review
master --no-llm --export md`): the output tail is
`Full report: …html\n  md export: …md\n` — no blank between, trailing newline
present, byte-identical to the shape `cli.ts` produced before the move.

**Ruling on a deviation:** the executor wrote the assertion as
`expect(out.slice(-tail.length)).toBe(tail)` rather than the plan's
`endsWith(...)`. Kept, and the plan updated to match — `endsWith` fails with
"expected false to be true", which tells a reader nothing, while this form
prints the actual tail beside the expected one. That difference is what let the
discrimination check above be read at a glance.

### Task 5 — three more plan defects, one of them a self-contradiction

1. **A fifth orphaned import the plan missed.** Deleting `cli.ts`'s
   export-path loop orphans `labelConcealed` at `cli.ts:10`; the plan named
   only the three in `terminal.ts`. `noUnusedLocals` makes it a red gate.
2. **The tail test's title contradicted its own step.** The plan titled it
   "…with one blank after" three paragraphs below its own explanation that the
   string ends with *no* blank line. Retitled "…and ends there", which is what
   the fixture asserts.
3. **The blank-line test over-promised — the fourth title defect of this
   plan.** Titled "whichever kind they are" while exercising only the untracked
   kind, so a gate narrowed back to `untrackedCount` alone would have passed
   it. The executor added the analyzer-warning case; the plan's snippet now
   carries both.

**One ambiguity resolved rather than deferred:** `model.test.ts`'s comment "the
terminal takes findings, not a model, so it gets the same two" becomes false at
*this* task, though the plan assigns its deletion to Task 6. The executor passed
the already-built model to the terminal and reworded the sentence to name the
HTML — true until Task 6 retires both halves, and Task 6's step still reads
correctly against what is there now.

### Task 4 — a title that promised plural coverage a single fixture could not give

**The plan said:** title the test "labels the paths of what was written, like
every other path it carries", and plant the concealing character in
`reportPath` only, with both export paths clean.

**The problem:** `path: labelConcealed(e.path)` — the one line of Task 4's
implementation that labels *export* paths — could have been written
`path: e.path` and the test would still have passed. Not merely an
over-promising title, as in Task 2: there, the word "only" was earned by a
neighbouring test, so renaming lost nothing. Here the behaviour was covered
**nowhere in the suite**, so renaming would have shipped an unlabelled path as
a silent possibility.

**Ruling:** strengthen rather than rename — the opposite call to Task 2's, for
the reason above. The md export path now carries a concealing character and is
asserted labelled; the pdf path stays clean, which pins the other half (a path
with nothing to conceal comes back exactly as it went in). The executor made
this call itself and recorded the deviation in the test; the plan's snippet is
updated to match, so a re-run produces what actually landed.

**The pattern across three tasks:** every test-title defect in this plan is
mine, and each survived four review rounds because a reviewer reads a title
against the *implementation it describes*, while only running it against the
*fixture* shows what it can actually catch. That is an argument for executing
plans with fresh subagents rather than inlining them — the executor is the
first reader who has to make the title true.

Two smaller calls, neither specified: the `describe` block's name
("buildReportModel written paths" — the plan's snippet was indented into a
block it never named, now fixed), and running the red check for the second test
too rather than only the one the plan's command filtered to. Both were red.

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
