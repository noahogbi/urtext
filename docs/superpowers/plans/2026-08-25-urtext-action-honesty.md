# Action Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the action's undocumented failure exception rather than merely disclosing it, correct the false platform premise that created it, and delete a README paragraph describing a refusal the code does not perform.

**Architecture:** One literal `continue-on-error: true` on the action's only `uses:` step, proven on a live pull request before any copy claims it. Everything else is documents of record and four tests that assert structure decidable from the parsed YAML rather than vocabulary in a description.

**Tech Stack:** GitHub composite action (`action.yml`), bash, `actions/upload-artifact@v4`, vitest with the `yaml` package for parsing.

**Spec:** `docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md`

## Global Constraints

- No GitHub-specific knowledge enters `src/`. This change touches `action.yml`, `README.md`, `test/action/`, `.github/workflows/`, and the two pr-native documents of record.
- Every value from an expression reaches a script through `env:`, read as `"$VAR"` — never interpolated into a `run:` body. `test/action/action-yml.test.ts` enforces this.
- **No numeral in a TypeScript comment may restate a `WEIGHTS` value.** `test/comment-contract.test.ts` fails on it. Spell counts as words in test comments, as the existing tests do.
- Worktree files are CRLF on disk; scripted patches must account for it.
- Gates before every commit, each read from **its own** exit code and never through a pipe: `npx vitest run`, `npx tsc --noEmit`, and a NUL byte check run with a positive control.
- The NUL check must be `tr -d '\000' < FILE | cmp -s - FILE`. **Do not write `grep -qU $'\0'`** — a NUL cannot survive in an argv string, the pattern collapses to empty, and the check reports failure on every file.

---

### Task 1: Correct the documents of record

The false premise is published in two places and repeated three times. Correcting the spec and leaving the plan leaves the claim standing in the document an executor actually reads.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md:323` and its §4 failure section (near line 617)
- Modify: `docs/superpowers/plans/2026-08-23-urtext-pr-native.md:1696` and `:2198`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code-level. Later tasks cite these corrections but do not import from them.

- [ ] **Step 1: Add a dated correction under the false premise in the spec**

Leave the original paragraph in place — house style is append-only correction, so a reader who followed the premise once can see it moved. Immediately after the paragraph ending "allowed to abort the composite.", insert:

```markdown
> **Correction (2026-08-25, after review).** The claim above is false. GitHub's metadata-syntax reference
> documents `runs.steps[*].continue-on-error` for composite actions: *"Prevents the action from failing
> when a step fails. Set to `true` to allow the action to pass when this step fails."*
>
> The design it justified is nonetheless correct, for two reasons this paragraph should have given
> instead. First, `continue-on-error` exposes only `outcome` and `conclusion` — pass or fail — while this
> action needs urtext's **numeric** exit code: `exit-code` is a public output and the exit-code table
> decides whether the comment carries a review or a failure body. Second, the compose and upsert steps run
> under `-e`, so a bare failure kills the script at the failing line and everything after it — compose's
> `outcome=failed` default, upsert's warning and `posted=none` write — never runs. `continue-on-error`
> tolerates a dead step; it cannot resurrect the lines that would have written the outputs.
>
> What the false premise did cost is the **one `uses:` step**, where shell capture is impossible and this
> key is the only instrument available. It went unguarded, and the action's headline promise acquired an
> undocumented exception. See `docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md`.
>
> Note for whoever makes this key conditional later: `actions/runner#2418` reports it working with
> literal values and failing with expressions that reference `inputs.*`, which are evaluated in the
> composite context where they are undefined.
```

- [ ] **Step 2: Correct §4's posts-without-exception claim**

Find the sentence "the action still posts (or edits its existing comment to) a body that says so". Immediately after the code block that follows it, insert:

```markdown
> **Correction (2026-08-25, after review).** "Still posts" has one exception this section never named. The
> failure body's headline, reason, closing sentence and footer are fixed copy the design forbids
> shortening, so a `comment-limit` below their combined length yields a body over the budget it was
> given. That body is still posted. What the action withholds is a body over **the API's own limit**
> (`FORGE_LIMIT`, 65536) — posting it would buy a rejection whose error text is about a field length
> rather than about urtext. Lowering `comment-limit` can never cause that; only fixed copy exceeding
> 65536 can. On the withheld path the action warns, sets `posted: none`, and leaves the review in the job
> summary and the artifact.
```

- [ ] **Step 3: Correct both repetitions in the plan**

At `:1696`, replace "Composite steps do not support `continue-on-error`, so every step that can fail captures its own status in the shell and reports it through `$GITHUB_OUTPUT` instead of aborting the composite." with:

```markdown
Every step that can fail captures its own status in the shell and reports it through `$GITHUB_OUTPUT` rather than aborting the composite — because the action needs urtext's numeric exit code, which `continue-on-error` does not expose, and because these steps run under `-e` and must survive their own failure to write their outputs. (An earlier version of this sentence said composite steps do not support `continue-on-error`. They do; see the correction in the design.)
```

At `:2198`, replace the traceability row's `no `continue-on-error`` phrasing with `` `continue-on-error` on the one `uses:` step `` so the row does not restate the refuted claim.

- [ ] **Step 4: Gates**

```bash
npx tsc --noEmit; echo "TSC=$?"
npx vitest run; echo "VITEST=$?"
printf 'a\000b' > /tmp/ctl.bin
for F in docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md docs/superpowers/plans/2026-08-23-urtext-pr-native.md; do
  if tr -d '\000' < "$F" | cmp -s - "$F"; then echo "NUL OK $F"; else echo "NUL FAIL $F"; fi
done
if tr -d '\000' < /tmp/ctl.bin | cmp -s - /tmp/ctl.bin; then echo "CONTROL BROKEN"; else echo "control OK"; fi
rm -f /tmp/ctl.bin
```

Expected: `TSC=0`, `VITEST=0`, both files NUL OK, control OK.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md docs/superpowers/plans/2026-08-23-urtext-pr-native.md
git commit -m "docs: correct the continue-on-error premise, and name the withhold section 4 omitted"
```

---

### Task 2: Pin the structure, and re-author the disclosure the quarantined branch got right

Test 1 asserts an invariant that is already true, so it cannot be watched failing by writing it first. It is validated by a **mutation check** instead — the pattern this repository's own plans already use. Tests 3 and 4 do fail first, because `master`'s `posted` description is the bare `"created, edited, or none."`

**Files:**
- Modify: `action.yml` (the `posted` and `report-artifact-url` output descriptions)
- Test: `test/action/action-yml.test.ts`

**Interfaces:**
- Consumes: the module-level `steps`, `action`, and `indexOfStep` helpers already defined at the top of `test/action/action-yml.test.ts`.
- Produces: a `usesSteps` filter expression reused verbatim by Task 3's test. No exported symbols.

- [ ] **Step 1: Write the three tests**

Insert before `it("describes every input and every output, ...")`:

```ts
  it("has exactly one `uses:` step, and it is the upload", () => {
    // Every statement this action makes about its own failure behaviour
    // rests on this: a `run:` step captures its own status in the shell, and
    // a `uses:` step cannot. A second `uses:` step added later would
    // introduce a second unguarded failure path in silence. Asserted as an
    // exact list rather than a count so the identity is pinned too.
    const usesSteps = steps.filter((s) => typeof s.uses === "string");
    expect(usesSteps.map((s) => s.id)).toEqual(["upload"]);
  });

  it("emits a distinct warning for each cause that sets posted to none", () => {
    // The output collapses several causes into one value. The warnings are
    // where a reader recovers which one happened, so their distinctness is
    // the thing worth pinning — not the wording, and not a numeral in a
    // sentence, which goes stale silently.
    const run = String(steps[indexOfStep("upsert")].run);
    const warnings = new Set([...run.matchAll(/::warning::(.*)$/gm)].map((m) => m[1]));
    expect(warnings.size).toBe(3);
  });

  it("states in posted's description exactly as many causes as the script distinguishes", () => {
    // Ties the copy to the code mechanically. Without this, the description
    // and the script drift apart and nothing notices: the test above would
    // still pass, and so would a description claiming any number at all.
    const run = String(steps[indexOfStep("upsert")].run);
    const warnings = new Set([...run.matchAll(/::warning::(.*)$/gm)].map((m) => m[1]));
    // The count is an English word read through an explicit map: a digit
    // would collide with this repository's copy style and with the comment
    // contract. A description with no parseable count FAILS rather than
    // skipping — reworded to "several causes" it matches nothing, and a
    // skip-on-no-match would pass vacuously while the disclosure quietly
    // came unpinned.
    //
    // Accepted false-failure, named so it is not weakened on first contact:
    // a warning added to this script for a cause that does not set posted to
    // none breaks the equality while the disclosure is still true. Widen the
    // extraction to the posted-none paths; do not loosen the assertion.
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const stated = /\b(one|two|three|four|five)\b\s+causes?/i.exec(
      String(action.outputs["posted"].description),
    );
    expect(stated, "posted's description states no cause count").not.toBeNull();
    expect(words[stated![1].toLowerCase()]).toBe(warnings.size);
  });
```

- [ ] **Step 2: Run them and record which fail**

Run: `npx vitest run test/action/action-yml.test.ts`

Expected: the first two **PASS** (both assert existing structure), the third **FAILS** with "posted's description states no cause count" — because `master`'s description is `created, edited, or none.` and contains no count.

- [ ] **Step 3: Mutation-check the two that passed**

A test that passed on first run has not been shown to work. Prove each one:

1. In `action.yml`, temporarily add `continue-on-error: true` **and** change the "Write the job summary" step from `shell: bash` + `run:` to a `uses: actions/github-script@v7`. Run the suite: "has exactly one `uses:` step" must FAIL. Revert.
2. In `action.yml`, temporarily change one of the upsert's three `::warning::` sentences to be identical to another. Run the suite: "emits a distinct warning for each cause" must FAIL with `2` instead of `3`. Revert.

Record both observed failures in the commit message. **If either mutation does not produce a failure, the test is wrong — fix the test, not the mutation.**

- [ ] **Step 4: Re-author the `posted` description**

In `action.yml`, replace:

```yaml
  posted:
    description: created, edited, or none.
    value: ${{ steps.upsert.outputs.posted }}
```

with:

```yaml
  posted:
    description: >-
      created, edited, or none. none collapses three causes — a composed body
      this API would reject on length, a body that could not be composed at
      all, and a post the API refused — and the run's warning names which.
    value: ${{ steps.upsert.outputs.posted }}
```

This text is written against `master`. It is **not** copied from `fix/action-disclosure-gaps`, which must not merge; that branch is the reason this disclosure was nearly lost rather than a source for it.

- [ ] **Step 5: Widen `report-artifact-url`'s description**

> **[Moved to Task 3 during execution.** This wording asserts the upload no longer fails the job, which
> is untrue until Task 3 lands the guard. Committing copy that asserts a not-yet-true guard is the defect
> this plan exists to remove, so the description and the guard land in the same commit. Recorded here
> rather than only in the commit message, because the plan is the document an executor actually reads —
> the same reason this work corrected the pr-native *plan* and not only its spec.**]**

Replace:

```yaml
  report-artifact-url:
    description: The uploaded artifact's URL; empty when upload-report is false.
```

with:

```yaml
  report-artifact-url:
    description: >-
      The uploaded artifact's URL; empty when upload-report is false, and also
      when the upload failed, which after this action's upload guard no longer
      fails the job.
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/action/action-yml.test.ts`
Expected: PASS, all twelve plus the three new ones.

- [ ] **Step 7: Gates and commit**

Run the full gate block from Task 1 Step 4, substituting `action.yml` and `test/action/action-yml.test.ts` for the NUL loop.

```bash
git add action.yml test/action/action-yml.test.ts
git commit -m "test(action): pin the sole uses: step and tie posted's cause count to the script"
```

---

### Task 3: Guard the upload step

**Files:**
- Modify: `action.yml` (the "Upload the report" step)
- Test: `test/action/action-yml.test.ts`

**Interfaces:**
- Consumes: Task 2's `usesSteps` filter idiom and its "exactly one `uses:` step" guarantee.
- Produces: the guard that Task 6 observes and Task 7's copy change depends on.

- [ ] **Step 1: Write the failing test**

Insert immediately after "has exactly one `uses:` step, and it is the upload":

```ts
  it("guards every `uses:` step with continue-on-error, which is the only tolerance available to one", () => {
    // A `run:` step survives its own failure with `set +e` and reports
    // through $GITHUB_OUTPUT. A `uses:` step has no shell to do that in, so
    // an unguarded one fails the composite and takes the pull request red —
    // past `fail-on-error`, which does not govern it. The length assertion
    // is not decoration: without it this passes vacuously the moment the
    // last `uses:` step is removed, and would go on passing while asserting
    // nothing. It is paired with the test above, which fixes how many there
    // are; do not delete that one as redundant.
    const usesSteps = steps.filter((s) => typeof s.uses === "string");
    expect(usesSteps.length).toBeGreaterThan(0);
    for (const step of usesSteps) {
      expect(step["continue-on-error"], String(step.name)).toBe(true);
    }
  });
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/action/action-yml.test.ts -t "guards every"`
Expected: FAIL — `expected undefined to be true` against the step named "Upload the report".

- [ ] **Step 3: Add the guard**

In `action.yml`, change the upload step to:

```yaml
    - name: Upload the report
      id: upload
      if: ${{ inputs.upload-report == 'true' }}
      # The action's only `uses:` step, and therefore the only one that
      # cannot capture its own status in the shell the way every run step
      # does. Without this, a failed upload fails the composite and takes the
      # pull request red whatever fail-on-error says.
      #
      # A literal, never an expression. This key is reported to fail on
      # expressions referencing an input, which are evaluated in the
      # composite context where they are undefined; see the design.
      continue-on-error: true
      uses: actions/upload-artifact@v4
      with:
        name: ${{ inputs.artifact-name }}
        path: |
          .urtext/
          ${{ runner.temp }}/urtext-review.md
        if-no-files-found: ignore
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run test/action/action-yml.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
git add action.yml test/action/action-yml.test.ts
git commit -m "fix(action): guard the upload step, the one step fail-on-error never governed"
```

---

### Task 4: Stop the warnings promising a report that may not exist

**Files:**
- Modify: `action.yml` (the upsert step's `env:` and its two over-cap warnings)
- Test: `test/action/action-yml.test.ts` (no new test; Task 2's distinctness test must stay green)

**Interfaces:**
- Consumes: Task 3's guard, which is what makes this reachable.
- Produces: nothing later tasks import.

- [ ] **Step 1: Add `ARTIFACT_URL` to the upsert step's env**

In the `Upsert the comment` step's `env:` block, after `BODY_LENGTH`, add:

```yaml
        ARTIFACT_URL: ${{ steps.upload.outputs.artifact-url }}
```

- [ ] **Step 2: Condition the clause**

At the top of the upsert `run:` body, before the `if [ "$OVER_CAP" = "true" ]` block, insert:

```bash
        # Where the review actually is. Before the upload was guarded, a
        # failed upload reddened the job before this step ran, so naming the
        # report unconditionally could not be wrong. It can be now.
        WHERE="in this run's job summary"
        if [ -n "$ARTIFACT_URL" ]; then WHERE="$WHERE and in the uploaded report"; fi
```

Then replace the two sentences ending "in this run's job summary and in the uploaded report." with `$WHERE`:

```bash
            echo "::warning::urtext could not post its review: the composed comment is $BODY_LENGTH characters, which this API will not accept. The full review is $WHERE."
```

```bash
            echo "::warning::urtext could not post its review: the comment could not be composed at all. Whatever the run did produce is $WHERE."
```

Leave the third warning (the read-only-token one) alone — it names only the job summary already.

- [ ] **Step 3: Verify the distinctness test still passes**

Run: `npx vitest run test/action/action-yml.test.ts`
Expected: PASS. The two sentences still differ from each other and from the third, so the count stays three.

- [ ] **Step 4: Gates and commit**

```bash
git add action.yml
git commit -m "fix(action): name the uploaded report only when there is one"
```

---

### Task 5: Complete the README's account of the comment cap

**Nothing here is a deletion.** `master`'s cap paragraph is true of a review comment and simply silent
about a failure comment; the `posted` row is bare. The false "declines to post" claim lives on
`fix/action-disclosure-gaps` and is not in this tree — if you go looking for it in `README.md` you will
not find it, and that is expected.

The never-fails sentence is **not** touched here. It waits for Task 6's observation.

**Files:**
- Modify: `README.md:145-148` and `:169`

**Interfaces:** none.

- [ ] **Step 1: Extend the cap paragraph**

Replace lines 147-148, "If the comment itself exceeds `comment-limit`, whole findings are removed and the comment says how many and where the rest are.", with:

```markdown
If a *review* comment exceeds `comment-limit`, whole findings are removed and the comment says how many
and where the rest are. A *failure* comment does not shrink: its headline, reason, closing sentence and
footer are fixed copy, so a `comment-limit` below their combined length produces a comment longer than
you asked for, and it is still posted. The action withholds a comment only when the body exceeds what the
API itself accepts, which lowering `comment-limit` cannot cause; that run warns, sets `posted: none`, and
leaves the review in the job summary and the artifact.
```

- [ ] **Step 2: Fix the `posted` row**

Replace `| `posted` | `created`, `edited`, or `none`. |` with:

```markdown
| `posted` | `created`, `edited`, or `none`. `none` collapses three causes — a body the API would reject on length, a body that could not be composed, and a post the API refused — and the run's warning names which. |
```

- [ ] **Step 3: Gates and commit**

No test reads the README; the gates are the suite, `tsc`, and the NUL check.

```bash
git add README.md
git commit -m "docs: the failure comment does not shrink, and is posted anyway"
```

---

### Task 6: Prove the guard on a live pull request

**This step cannot be performed by any test in this repository.** A composite action has no runner inside vitest. It needs push access to `noahogbi/urtext`.

**Files:**
- Create (on a scratch branch only, never merged): `.github/workflows/upload-failure-proof.yml`

**Interfaces:**
- Consumes: Task 3's guard.
- Produces: the two run URLs Task 7 requires before it may delete anything.

- [ ] **Step 1: Write the proof workflow**

The trigger needs no test-only code inside `action.yml`: `actions/upload-artifact@v4` makes artifacts immutable and its `overwrite` input defaults to `false`, so claiming the name first makes the action's own upload fail.

```yaml
name: upload failure proof
on: pull_request

jobs:
  proof:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: mkdir -p decoy && echo placeholder > decoy/placeholder.txt
      # Claim the name the action will use. v4 artifacts are immutable and
      # overwrite defaults to false, so the action's upload then conflicts.
      - uses: actions/upload-artifact@v4
        with:
          name: urtext-review
          path: decoy/
      - uses: ./
        with:
          # The default, stated on purpose. The dogfooding workflow sets this
          # true; if this one did, a red job would be ambiguous between the
          # upload and anything else, and the observation would prove nothing.
          fail-on-error: false
```

- [ ] **Step 2: Observe the failure BEFORE the guard**

Push a branch whose `action.yml` does **not** yet carry `continue-on-error` (i.e. branch from before Task 3), open a pull request, and record the run URL.

Expected: the `proof` job is **red**, failing at "Upload the report" with a name-conflict error.

This is evidence the exception was real rather than theoretical. **Do not skip it** — without it, Task 7 removes a disclosure on the strength of an assumption.

- [ ] **Step 3: Observe the success AFTER the guard**

Push the branch carrying Tasks 1-5 and open (or update) the pull request. Record the run URL.

Expected, all three: the job is **green**; the "Upload the report" step is marked failed but tolerated; the urtext comment is posted and carries **no** `full report` link.

- [ ] **Step 4: If the guard does not work**

If step 3 is still red, `continue-on-error` does not apply here. **Stop.** Do not proceed to Task 7. Behaviour is exactly what it was — the change is strictly no-worse — but the README must keep its exception, reworded to say the guard was attempted and did not hold. Report this rather than working around it.

- [ ] **Step 5: Record both runs in the pull request body, and delete the scratch workflow**

The proof workflow is never merged. Delete the file before the pull request that carries this work is merged, leaving the two run URLs in its body as the record.

---

### Task 7: Make the never-fails sentence true, and clean up

**Do not start this task until Task 6 Step 3 is green and its run URL is recorded.**

`master`'s README already promises the action never fails a pull request, which is false today while the
upload is unguarded. This task does not add and then remove a disclosure — it makes a live false promise
true and names the one exception that genuinely remains.

**Files:**
- Modify: `README.md` (the never-fails paragraph)
- Modify: `docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md` (the superseded-branch section)
- Delete: branch `fix/action-disclosure-gaps`; `.claude/probe/probe2.ts`; `.claude/probe/probe3.ts`

**Interfaces:** none.

- [ ] **Step 1: State the promise, with the one exception that remains**

Replace `README.md:126-128` with:

```markdown
The action never fails a pull request: a review that could not be produced is posted as a comment saying
so, not as a red check. Every step that can fail captures its own status, and the one step that cannot —
the artifact upload, which is a `uses:` step — is marked `continue-on-error`. `fail-on-error: true` opts
into the opposite.

The single exception is deliberate and is not governed by `fail-on-error`: the `pull_request_target`
refusal below fails the job on purpose.
```

- [ ] **Step 2: Update the spec's superseded-branch section**

The sentence "It is kept unmerged for reference only" becomes false once the branch is deleted. Replace it with a sentence recording that the branch was deleted after its one correct idea was re-authored in Task 2, and that this paragraph is now the only record of what it contained.

- [ ] **Step 3: Delete the quarantined branch and the throwaway probes**

```bash
git branch -D fix/action-disclosure-gaps
rm -f .claude/probe/probe2.ts .claude/probe/probe3.ts
```

Both probes are throwaway spikes whose answers are recorded in the citation-rot design; the method is stated there precisely enough to rebuild either in minutes. `.claude/` is gitignored, so the `rm` touches nothing tracked.

- [ ] **Step 4: Gates and commit**

```bash
git add README.md docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md
git commit -m "docs: the upload no longer fails the job, and the README stops saying it might"
```

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| The premise that was false; the narrow correction; both reasons run steps capture | Task 1, Steps 1 and 3 |
| §4's posts-without-exception claim | Task 1, Step 2 |
| The exception, and why it goes; literal not expression | Task 3 |
| What a tolerated failure costs (`report-artifact-url`) | Task 2, Step 5 — **moved to Task 3 during execution**, so the description lands with the guard it describes |
| The cost the outputs inventory misses (warnings naming the report) | Task 4 |
| The second exception, which stays (`pull_request_target`) | Task 7, Step 1 |
| Proving it before the copy claims it; the trigger; the two observations | Task 6 |
| The `comment-limit` claim; the `posted` row | Task 5; Task 2 Step 4 |
| Tests 1-4, and tests 1+2 documented as a pair | Task 2 Steps 1-3; Task 3 Step 1 |
| The superseded branch | Task 7, Steps 2 and 3 |

**Placeholder scan.** No "TBD", no "add appropriate handling", no "similar to Task N". Every code step carries the literal text to write.

**Type consistency.** The `usesSteps` filter expression is identical in Task 2 Step 1 and Task 3 Step 1. `indexOfStep`, `steps`, and `action` are the existing module-level helpers and are not redefined. The `::warning::` extraction regex is identical in both tests that use it.

**One ordering hazard, stated because it is easy to get wrong.** Task 6 Step 2 must be observed from a tree *without* Task 3's guard. An implementer who completes Tasks 1-5 and then starts Task 6 will have to check out an earlier commit to see the red run. Doing Task 6 Step 2 first — before Task 3 — is the simpler route and is allowed.
