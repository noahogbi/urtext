# urtext's action: an exception that need not exist — design

**Date:** 2026-08-25
**Status:** approved in conversation; this document is the binding spec
**Prior art:** `docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md` (the action itself; this
document corrects one of its premises and leaves the rest standing) and
`docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md` (the rule that a confident wrong answer
is trusted exactly once — which is what a documented promise with an undocumented exception is).

## Purpose

The action's headline promise is that it never fails a pull request. That promise has an exception the
documentation did not name, and the exception exists because of a platform constraint that **is not
real**. This design corrects the premise, removes the exception rather than merely disclosing it, and
proves the removal on a live pull request before any copy claims it.

It also completes an account of the comment cap that is true as far as it goes and silent exactly where a
reader would be misled, and replaces two tests that assert vocabulary where they should assert structure.

**What `master` actually says, because an earlier draft of this document got this wrong twice.** The
false copy this work was first conceived to delete lives on `fix/action-disclosure-gaps`, the branch
quarantined below — not on `master`. `master` has no "declines to post" claim, no exception paragraph,
and a bare `posted` row. The README work here is therefore **additive**: state the failure-comment
behaviour the cap paragraph omits, and add the collapse disclosure the `posted` row lacks. Nothing is
deleted. Every instruction below is written against `master`; a passage that seems to describe copy you
cannot find is describing the quarantined branch, and it is not there.

**One promise on `master` is live and false right now**, and this design should say so rather than let it
pass as background. `master`'s README states the action never fails a pull request, while the unguarded
upload step can redden a job today. That is a pre-existing defect, not one introduced here, and the work
below closes it by **making the sentence true** rather than by qualifying it. No interim disclosure is
ordered, on the grounds that the guard and the sentence land in the same pull request and a disclosure
that exists for the length of one review is noise; if this work stalls after the guard is written but
before it is proven, the interim belongs in the pull request description, not in the README.

## The premise that was false

`docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md`, in "Steps, in order":

> **Composite steps do not support `continue-on-error`.** This is load-bearing for §4: every step that
> can fail captures its own status in the shell and reports it through `$GITHUB_OUTPUT` instead of being
> allowed to abort the composite.

GitHub's metadata-syntax reference documents `runs.steps[*].continue-on-error` for composite actions:
*"Prevents the action from failing when a step fails. Set to `true` to allow the action to pass when this
step fails."* The claim is false, and it is repeated in
`docs/superpowers/plans/2026-08-23-urtext-pr-native.md` and in a comment in `action.yml`.

**The correction is narrow, and the narrowness is the point.** `continue-on-error` exposes only
`outcome` and `conclusion` — pass or fail. The action needs urtext's **numeric** exit code: `exit-code`
is a public output, and the exit-code table decides whether the comment carries a review or a failure
body. A step marked `continue-on-error` would still have to capture `$?` in the shell to learn the
number. So:

- **No `run:` step changes.** The shell-capture pattern stays exactly as built.
- **What changes is its stated reason.** Those steps capture their status because they need the exit
  code, not because the platform leaves them no alternative. §4's design is sound; its justification was
  not.
- **The blast radius is the one `uses:` step**, where shell capture is impossible and `continue-on-error`
  is the only instrument available.

"Needs the number" explains the build and urtext steps. It does not explain compose and upsert, which
need something stronger: these steps run under `-e`, so a bare failure kills the script **at the failing
line**, and everything after it — compose's `outcome=failed` default and its drop of a stale length,
upsert's fork warning and its `posted=none` write — never executes. `continue-on-error` tolerates a dead
step; it cannot resurrect the lines that would have written the outputs. The capture is what keeps those
steps running long enough to report. Both reasons are recorded because either alone leaves half the
steps looking like they were written around a constraint that was never there.

A dated correction block is added to the pr-native spec in place, in the house style already used there
for rulings made during implementation. The original text is not silently edited: a reader who followed
that premise once must be able to see that it moved.

## The exception, and why it goes

`action.yml`'s "Upload the report" step is the action's only `uses:` step
(`actions/upload-artifact@v4`). Every other step is `run:` with `set +e` and its own status capture. That
one step has no guard, so an upload failure — a quota, a name collision, a transient fault — fails the
composite and reddens the pull request's check, regardless of `fail-on-error`.

The change is one literal line on that step:

```yaml
    - name: Upload the report
      id: upload
      if: ${{ inputs.upload-report == 'true' }}
      continue-on-error: true
      uses: actions/upload-artifact@v4
```

**A literal, never an expression — a platform requirement, not a preference.** `actions/runner#2418`
reports `continue-on-error` in composite actions working with literal values and failing with expressions
that reference `inputs.*`: they are evaluated in the composite context, where they are undefined, and the
step dies on a template error. The issue is open. This matters most to whoever later wants to make the
key conditional on an input — the obvious next idea, and the one that breaks. The action's `env:`-only
discipline points the same way, and a bare `true` keeps the step's behaviour readable without resolving
anything.

### What a tolerated failure costs

Nothing reads that step's `outcome` or `conclusion`. Exactly two things read it at all, both
`steps.upload.outputs.artifact-url`:

| Consumer | Behaviour when the upload failed |
|---|---|
| `report-artifact-url` output | empty |
| `ARTIFACT_URL` env on the compose step | empty, and the composer already omits the link when given no URL |

So the degradation path is one that already exists and is already tested: a comment with no artifact
link, which is what `upload-report: false` produces today. No new branch is introduced anywhere.

`report-artifact-url`'s description currently reads "empty when `upload-report` is false". It gains its
second cause.

**One cost the outputs inventory misses, because it is fixed copy rather than a reader.** The upsert
step's two over-cap warnings both end "...and in the uploaded report", unconditionally. Today that
sentence cannot fire falsely on this path: a failed upload reddens the job before the upsert runs. After
this change it can — a tolerated upload failure together with an unpostable body would warn the reader
toward a report that does not exist. The exposure already exists under `upload-report: false`, so this
widens a pre-existing defect rather than creating one; it is named here because a document whose subject
is copy asserting what nothing watched cannot leave that standing. `ARTIFACT_URL` is passed into the
upsert step's `env:` and the clause is conditioned on it, so the sentence names the report exactly when
there is one.

### The second exception, which stays

The `pull_request_target` guard exits 1 unconditionally, and `fail-on-error` does not govern it either.
That one is deliberate and already documented at length in §5. Any copy that counts exceptions must count
**two** and distinguish them: one is a refusal the action performs on purpose, the other was an accident
of a `uses:` step. The branch this design supersedes said "There is one exception" and was wrong on the
count.

## Proving it before the copy claims it

**No test in this repository can observe this.** A composite action has no runner inside vitest. The
previous branch's failure was not only that its copy was false — it was that the copy asserted runtime
behaviour nothing had watched. This design therefore requires an observation, and orders it before the
copy change rather than after.

### The trigger, which needs no edit to `action.yml`

`actions/upload-artifact@v4` makes artifacts **immutable**; its `overwrite` input defaults to `false`, so
uploading a second artifact under an existing name fails the step. That is documented behaviour, not a
guess about name validation, and it is reachable from the action's public input surface: a workflow can
upload a dummy artifact under the name the action will use, and the action's own upload then conflicts.

This mirrors the argument the pr-native spec makes for `comment-limit` — a cap that is an input is a cap
that can be made to bite on demand. Here, `artifact-name` is what makes the failure constructible without
a single line of test-only code inside the action.

### The observation, twice

On a scratch branch of `noahogbi/urtext`, with a workflow that pre-uploads a colliding artifact and then
runs `uses: ./`:

1. **Before the fix** — the job is **red**. This is recorded, not assumed: it is the evidence that the
   exception was real rather than theoretical.
2. **After the fix** — the job is **green**, the comment is posted, and it carries no artifact link.

Both runs are recorded in the pull request that carries this change, with run URLs.

### The copy waits for the observation

The README's never-fails sentence is made **unconditionally true only after** observation 2 is green.
There is no exception paragraph on `master` to remove; what changes is that the sentence stops being a
promise the code cannot keep and starts being a description of what the code does, with the
`pull_request_target` refusal named beside it as the one deliberate exception.

If the key turns out not to apply to this step, the behaviour is exactly today's — the change is strictly
no-worse — but the README must then **acquire** an exception paragraph it does not currently have,
saying the guard was attempted and did not hold. **At no point does the copy promise something no one has
watched happen.** That ordering is the whole discipline this design exists to restore, and the live false
promise noted in the Purpose is why it cannot simply be left alone either way.

## The `comment-limit` account that stops exactly where it would mislead

`README.md`'s cap paragraph says that a comment exceeding `comment-limit` has whole findings removed and
says how many. That is true of a **review** comment and says nothing about a **failure** comment, which
has no findings to remove and does not shrink. The omission reads as a general rule, so a reader
lowering `comment-limit` on a failing run expects a shortened comment and gets an over-limit one.

For the avoidance of doubt about what is being fixed: the quarantined branch's README went further and
told the reader that such a body is **declined**. That claim is false and is not on `master`. What
follows is the code's actual behaviour, which `master` states incompletely and that branch states
wrongly.

The code withholds on the **API's** limit, not the user's. In the compose step:

```bash
over=true
case "$length" in
  "" | *[!0-9]*) length="" ;;
  *) if [ "$length" -le "$FORGE_LIMIT" ]; then over=false; fi ;;
esac
```

`FORGE_LIMIT` is the hardcoded 65536. `$BUDGET` — the user's `comment-limit` — is passed to the composer
and never consulted here. Traced with any `comment-limit` smaller than the fixed copy — the marker,
headline, reason, closing sentence and footer, which together far exceed a few hundred characters: the
tail shortens to empty, the body is returned over budget, that length is nonetheless `-le 65536`,
`over-cap=false`, and the upsert **posts it**. `posted=created`, no warning. The documented
`posted: none` path is reachable only when the fixed copy itself exceeds 65536, which lowering
`comment-limit` can never cause.

The replacement states what happens: the failure body's headline, reason, closing sentence and footer are
fixed copy that is never shortened, so a `comment-limit` under their combined length produces a comment
longer than the limit asked for — and it is posted. The action withholds a comment only when the body
exceeds what the API itself will accept.

**This is not a README-only defect, and an earlier draft of this document said it was — on evidence that
does not exist.** Two corrections that draft waved off are required:

- **pr-native §4 must be corrected.** It says of a failure that "the action still posts (or edits its
  existing comment to) a body that says so", with tail-shortening rules and no exception. There is no
  withhold anywhere in that spec. A README saying the action withholds above the API's limit, against a
  binding spec saying it always posts, is a documented contradiction planted in the exact place the
  original error came from. §4 gets a dated correction naming the withhold and the condition on it.
- **`action.yml`'s `posted` description must gain the collapse disclosure.** On `master` it reads, in
  full, "created, edited, or none." The wording an earlier draft called "already correct" —
  "a composed body this API would reject on length" — exists **only on
  `fix/action-disclosure-gaps`**, the branch this document quarantines. Banning that branch wholesale
  orphans the one thing it got right: `posted: none` collapses three causes, and the output that reports
  it says nothing about them. That disclosure is re-authored here, on `master`'s text, rather than
  inherited from a branch that must not merge.

The README's cap paragraph and the `posted` row in its output table are both **additions**, not
corrections. The paragraph gains the failure-comment behaviour it omits: the fixed copy is never
shortened, so a low `comment-limit` produces a comment longer than requested and it **is** posted, and
the action withholds only above what the API itself accepts. The `posted` row, currently bare, gains the
same three-cause disclosure as the `action.yml` output.

**The verbatim copy, so it is specified rather than paraphrased**, following this project's habit of
carrying its cap notes and warning texts in full:

```yaml
  posted:
    description: >-
      created, edited, or none. none collapses three causes — a composed body
      this API would reject on length, a body that could not be composed at
      all, and a post the API refused — and the run's warning names which.
```

```yaml
  report-artifact-url:
    description: >-
      The uploaded artifact's URL; empty when upload-report is false, and also
      when the upload failed, which after this action's upload guard no longer
      fails the job.
```

And the conditioned clause in the upsert step, where `WHERE` is built once before the branch that uses
it and `ARTIFACT_URL` reaches the step through `env:` like every other expression value:

```bash
WHERE="in this run's job summary"
if [ -n "$ARTIFACT_URL" ]; then WHERE="$WHERE and in the uploaded report"; fi
```

## The tests

The two tests on the superseded branch assert that certain words appear in a description. A description
saying *"the upload step is marked continue-on-error so it never fails the job"* satisfies
`/upload/i` and `/continue-on-error/` while meaning the opposite. They pin vocabulary, not direction —
the failure mode this project's test-title rule exists to catch, and the tenth time it has been caught
here.

The replacements assert structure that is decidable from the parsed YAML:

1. **`upload` is the only `uses:` step.** Every disclosure about the action's failure behaviour rests on
   this, and nothing checks it. A second `uses:` step added later would introduce a second unguarded
   failure path silently.
2. **Every `uses:` step carries `continue-on-error: true`.** Written over the set rather than over the
   one step by name, so it keeps its meaning if another is added. Deleting the guard fails this test.
3. **The upsert script emits three distinct `::warning::` strings.** The `posted` output collapses three
   causes; this pins the causes rather than the word "three", which is what goes stale. When a fourth
   cause is added this fails **loudly**, which is the right direction for a count-pin.
4. **The cause-count stated in `posted`'s description equals the number of distinct `::warning::`
   strings the upsert script emits.** Ties the copy to the code mechanically, so the disclosure cannot
   drift from what the script actually distinguishes — the structural middle between asserting a
   sentence and asserting nothing. Two things it must specify, because leaving either open forks the
   implementation:
   - **The count is spelled as an English word and read through an explicit word-to-number map.** A
     digit would collide with this repository's copy style and with the comment contract; a word is what
     the description will actually carry.
   - **A description with no parseable count fails the test.** Reworded to "several causes" it yields no
     match, and an implementation that treats no-match as "nothing to check" passes vacuously while the
     disclosure is silently unpinned. The no-match branch asserts, it does not skip.

   **An accepted false-failure mode, named so nobody weakens the test on first contact.** Tests 3 and 4
   both count every distinct `::warning::` in the upsert script. A warning added there for a cause that
   does **not** set `posted: none` breaks the equality while the disclosure is still true. That failure
   is loud and forces a human to reconcile copy and code, which is the right trade against a test that
   quietly stops meaning anything — but the next person to hit it will be tempted to loosen the
   assertion, and should widen the extraction to warnings on the `posted=none` paths instead.

Tests 1 and 2 are a pair and are documented as one: test 2 is vacuously green if there are no `uses:`
steps at all, and draws its meaning from test 1 establishing that there is exactly one. Stated so a
later reader does not delete test 1 as redundant and leave test 2 asserting nothing.

**Only tests 2 and 4 can be watched failing first, and the order must say so.** Test 2 fails because no
`uses:` step carries the guard yet; test 4 fails because `master`'s `posted` description states no count.
Tests 1 and 3 assert structure that is **already true** — one `uses:` step, three distinct warnings — so
they pass the moment they are written, and an instruction to watch them fail is one no implementer can
carry out. They are validated by **mutation check** instead, the pattern this project's own plans already
use: break the thing deliberately, confirm the test fails, revert, and record the observed failure. A
test that has only ever passed has not been shown to work.

Each title is written to answer *"could this pass if the thing its name promises were broken?"* No test
asserts the README, which no test in this suite reads.

## Testing

- Four new assertions in `test/action/action-yml.test.ts`: tests 2 and 4 watched failing first, tests 1
  and 3 validated by mutation check with the observed failure recorded, per the section above.
- The full suite, `npx tsc --noEmit`, the comment-contract guard, and a NUL byte check with a positive
  control — the control because a NUL check written as `grep -qU $'\0'` silently matches every file and
  reports a false failure, which happened during the work that led to this document.
- The two live observations above, recorded with run URLs in the pull request.

**Every behaviour change lands with a test that fails before it**, with two named exceptions rather than
one. The upload guard's *effect* is proven by observation, not by vitest, which can see only that the key
is present — that is test 2, and it does fail first. And tests 1 and 3 pin structure that already holds,
so they are validated by mutation rather than by a red run. Both exceptions are stated because a rule
with an unstated exception is the defect this whole document is about.

## The superseded branch

`fix/action-disclosure-gaps` @ `d4e2316` is **known-bad and must not merge**. It documents a
`comment-limit` refusal the code does not perform, asserts a platform impossibility that does not exist,
counts one exception where there are two, and pins both claims with tests that would pass if the
descriptions were inverted. **It was deleted on 2026-08-25**, once its one correct idea had been
re-authored against `master`. This paragraph is now the only record of what it contained, which is the
point: a branch name carries no warning, and a branch left lying around is one somebody eventually
merges.

**It got one thing right, and quarantining a branch is how a good idea gets lost with the bad ones.** Its
`posted` description — naming the three causes `none` collapses, and pointing at the run's warnings to
tell them apart — was correct and is the one disclosure `master` still lacks. It is re-authored in this
design against `master`'s text, and tests 3 and 4 pin it. Nothing is inherited from the branch itself.

## Global constraints (carried from the project)

- No GitHub-specific knowledge enters `src/`. This change touches `action.yml`, `README.md`,
  `test/action/`, and — because it corrects statements this project has already published —
  `docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md` (the false premise, and §4's
  posts-without-exception claim) and `docs/superpowers/plans/2026-08-23-urtext-pr-native.md`, which
  repeats the false premise **twice**: once outright, and once in the traceability table's
  "no `continue-on-error`" row. An implementer who corrects the spec and leaves the plan has left the
  claim standing in the document an executor actually reads.
- Working-tree review behaviour is untouched.
- Every value from an expression reaches a script through `env:`, never interpolated into a `run:` body.
- Worktree files are CRLF on disk; scripted patches must account for it.

## Out of scope

- **Acceptance items 7 and 8** — the fork pull request and the `pull_request_target` refusal. They need
  the same live-pull-request loop this design establishes, and the setup cost is shared, but they are a
  separate decision and are not bundled here.
- **The sweep-selection follow-up** for citation checking.
- **Any change to the `run:` steps' shell-capture pattern.** It is correct; only its justification moves.
- **The `workflow_run` two-workflow split** for commenting on fork pull requests, still a deliberate
  follow-up.
