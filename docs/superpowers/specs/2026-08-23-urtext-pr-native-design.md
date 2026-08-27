# urtext on a pull request — design

**Date:** 2026-08-23
**Status:** approved in conversation (design sections reviewed); this document is the binding spec
**Prior art:** `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md` (the evidence tiers, the
no-verdict rule, and "a tool that renders verdicts is trusted exactly once" — which this design must not
weaken), `docs/superpowers/specs/2026-08-19-urtext-export-model-design.md` (the model-is-the-single-
source-of-honesty-truth rule and the Markdown surface this design ships to a reader), and
`docs/superpowers/specs/2026-08-23-urtext-intent-comparison-design.md` (the trust-boundary discipline this
design applies to a second audience).

## Purpose

urtext today is remembered or it is not used. The founding spec named the pull request as a deferred
surface — "a diff fetched from elsewhere" — and deferred it because the local core had to exist first. The
local core exists. What is missing is not analysis: it is a place where the analysis arrives without
anyone deciding to ask for it.

This design puts a urtext review on the pull request that produced the diff, as one comment that is
edited in place on every push. A reviewer who never types `urtext` still gets the tiered account of the
change, and gets it in the one place they were already going to look.

Two things this design refuses to do, both load-bearing:

1. **urtext does not learn what a pull request is.** No GitHub API code, no new runtime dependency, no
   CI environment variable read anywhere under `src/`. urtext stays a git CLI that takes a range and
   prints a review. A composite GitHub Action shipped in this repository does the forge-specific work:
   resolve a range from the event payload, invoke the CLI, post the result. The seam between them is
   Markdown on stdout and an exit code — nothing else crosses it.
2. **Working-tree review is untouched.** Every existing flag, exit code, output surface, and test
   expectation is unchanged. This is purely additive; the one CLI change is a new flag that redirects
   which channel carries which document.

## The shape of the change

```
pull_request event
      │
      ▼
[action.yml — composite]
      │  base...head from the payload
      ▼
node dist/bin.js review "<base>...<head>" --no-llm --stdout md
      │  stdout: Markdown, and nothing else
      │  stderr: the terminal render, every note, the report path
      ▼
[action/compose-comment.mjs]   marker + review + footer, capped with disclosure
      │
      ▼
gh api — find a comment carrying the marker, PATCH it, else POST
```

Everything above the CLI line is urtext. Everything below it is the action. The action is not allowed to
reword, reorder, demote, or summarize what the CLI printed; it may only prepend the marker, append the
footer, and remove whole findings under a stated cap. A rewriting step between the tool and the reader is
exactly the silent transformation this project exists to avoid.

---

## 1. The CLI change: Markdown on stdout

### The flag

`--stdout md`. Both spellings, `--stdout md` and `--stdout=md`, exactly as `--model` and `--export`
already accept theirs.

```ts
/**
 * Every format `--stdout` can carry. One member today, and a union rather
 * than a boolean for the same reason `IntentSource` is one: a second member
 * is a compile error at every site that decides what stdout holds, instead
 * of a boolean that quietly means "the one other thing".
 */
export const STDOUT_FORMATS = ["md"] as const;

export type StdoutFormat = (typeof STDOUT_FORMATS)[number];

export interface CliOptions {
  // ... unchanged fields ...
  /**
   * The format `--stdout` asked for. Optional for the same reason as `open`
   * and `exportFormats`: pre-existing callers construct `CliOptions`
   * literals without it. Undefined means the terminal render owns stdout,
   * as it always has.
   */
  stdout?: StdoutFormat;
}
```

`STDOUT_FORMATS` lives in `src/cli.ts`, not beside `EXPORT_FORMATS` in `src/report/write.ts`.
`EXPORT_FORMATS` belongs to the writer because the writer owns the filenames; nothing outside the CLI
decides what a stream carries, and putting a stream's contents in a file-writing module would invite the
next reader to look for a `writeStdout`.

### Why `--stdout md` and not the alternatives

Three candidates were on the table.

- **`--export md=-`** overloads a flag whose whole contract is "additionally write files beside the HTML
  report, sharing its timestamp stem" (see `writeExport`). A stem is the reason `--export` takes the
  report path as its anchor and refuses to run when no report was written. stdout has no stem, no
  anchor, and no filename, so `md=-` would need every one of those rules exempted — and `--json`'s
  `exportPaths` object would gain a key whose value is not a path. One flag, two contracts.
- **`--format md`** says the review is being *typeset* differently. It is not. Every surface already
  walks the same `ReportModel` and the Markdown surface already exists; what this flag changes is which
  of the two documents a run produces goes to which stream. A user who reads `--format md` expects
  `--json` to be a peer of it, and it is not.
- **`--stdout md`** names the thing that actually changes: which document owns stdout. It reads as an
  instruction about plumbing, which is what it is, and it composes with `--export md` (both may be
  given; the file and the stream get byte-identical Markdown from one built model) and refuses to
  compose with `--json`, which is the correct refusal.

### What the flag does, exactly

When `opts.stdout === "md"` and the run's exit code is zero:

- **stdout carries exactly `renderMarkdown(model)` and nothing else.** No report-path line, no export
  path lines, no gitignore tip, no note, no banner, no trailing blank line beyond the single `\n`
  `renderMarkdown` already ends with. The stream is pipe-safe by construction, not by convention.
- **stderr carries the human-readable terminal render** — the same string `output` is today, including
  the `Note:` lines every warning becomes, the `Full report:` line, the per-export path lines, and the
  gitignore tip. Nothing is dropped; the whole document moves.
- `--open`'s explanation and `main`'s error line already go to stderr and are unchanged.

When `opts.stdout === "md"` and the run's exit code is nonzero: **stdout is empty.** This is the same
rule, applied to the same hazard, that already governs the HTML report — "a review this broken does not
get a report: a report sitting on disk looks like a successful run to anyone who only checks whether one
was produced." A comment body sitting in a pipe looks like a successful review to anyone who only checks
whether one arrived. The terminal render still goes to stderr with every note in it, so the reason is not
lost; the action reads the empty stdout plus the nonzero code and takes the failure path in §4.

### Where it lands in `review()`

`review()` gains one optional field on its return value. Every existing caller and test reads `output`
and is untouched:

```ts
export async function review(
  cwd: string,
  opts: CliOptions,
  analyzers: Analyzer[] = ANALYZERS,
  exporters: Exporters = { md: renderMarkdown, pdf: renderPdf },
): Promise<{
  output: string;
  exitCode: number;
  reportPath: string | undefined;
  /**
   * The Markdown review, present exactly when `--stdout md` was given and
   * the run produced one. `output` keeps its meaning — the human render and
   * every path line — and `main` decides which stream each goes to.
   */
  markdown?: string;
}>;
```

Two edits inside `review()`:

1. **The export model is built once, and its gate widens.** Today it is built inside
   `if (reportPath && exportFormats.length > 0)`. It becomes one build under
   `exitCode === 0 && (exportFormats.length > 0 || opts.stdout !== undefined)`, placed exactly where it
   is today — after the report-write attempt, before the export loop — so a report-write failure warning
   is already in `warnings` and reaches both the file and the stream. The export loop keeps its own
   `reportPath` gate; only the stdout path is exempt from it, because the stem argument is about files
   pairing on disk and a stream is not a file.
2. `markdown` is set from that one model with the same `exporters.md` the file export uses. One model,
   one renderer, one string: `--stdout md` and `--export md` cannot diverge, and a test pins that they
   do not.

### Conflicts and errors

- **`--stdout md --json` is a usage error**, in the existing example-led style:
  `` `--stdout md and --json cannot both own stdout; pick one.` `` Two documents on one stream is not a
  formatting problem to resolve, it is a request with no correct answer.
- An unknown value: `` `--stdout cannot write "html"; it takes ${STDOUT_FORMATS.join(" and ")}, e.g.
  --stdout md.` `` — the same wording shape as `exportUsageError`.
- `--stdout` with no value, or followed by another flag, is the same error, by the same
  next-argument-starts-with-`-` rule `--model` and `--export` already apply.

### `main`'s stream routing

`main` today writes `output` to stdout unconditionally. That one branch is untestable through `main`,
which reads `process.argv` and the real streams — the precise reason `openOrExplain` was extracted. The
routing is extracted the same way and for the same reason:

```ts
/**
 * Which stream carries which document. Extracted from `main` for the reason
 * `openOrExplain` was: `main` reads `process.argv` and writes to the real
 * process streams, so neither branch is reachable from a test through it.
 * Under `--stdout md` the Markdown owns stdout alone and the human render —
 * notes, path lines, tip — moves to stderr; otherwise nothing moves. See
 * `test/cli.test.ts`, "--stdout md puts the Markdown on stdout and every
 * other line on stderr".
 */
export function streamsFor(
  result: { output: string; markdown?: string },
  opts: CliOptions,
): { stdout: string; stderr: string };
```

`main` writes `streamsFor(...).stdout` to `process.stdout` and, when non-empty,
`streamsFor(...).stderr` to `process.stderr`. The trailing-newline normalization `main` applies today
applies to whichever string lands on stdout, and `markdown` already ends in a newline, so the
normalization is a no-op for it — stated here because "and nothing else" means no extra byte either.

### USAGE

One entry, in the existing voice:

```
  --stdout md Write the Markdown review to stdout and nothing else; the
              terminal render and every note move to stderr. Cannot be
              combined with --json.
```

### Unchanged, stated explicitly

- **The exit-code matrix.** `allAnalyzersFailed` and `someFailedNothingShown` remain the only two rules.
  `--stdout md` reads the exit code; it never sets one.
- **The HTML report** is still written on every zero-exit run, and `--stdout md` neither suppresses nor
  requires it.
- **Every existing test expectation.** No existing expected string changes, and no existing caller of
  `review()` sees a different `output`.

---

## 2. The action

### Where it lives, and why the root

**`action.yml` at the repository root.** GitHub resolves `uses: noahogbi/urtext@v1` to `action.yml` at
the root of that repository and nowhere else. The subdirectory form (`noahogbi/urtext/.github/actions/
urtext-review@v1`) works but makes the public name of the thing longer than the tool it runs, and
`.github/actions/` is the convention for actions a repository uses only on itself — which is the one case
this action is explicitly not for. The root file is also what the dogfooding workflow references as
`uses: ./`, so there is exactly one action definition and the repository tests the same file everybody
else consumes.

Its helper lives beside it in `action/`:

- `action/compose-comment.mjs` — the pure composer, `composeComment(options) => { body, omitted, kept, outcome }`.
- `action/compose-comment-bin.mjs` — argv in, files out, runs unconditionally.

Two files rather than one for the reason `src/bin.ts` gives in its own comment: an
am-I-the-entry-module guard is a construct this repository has already been burned by twice, and the
split makes the composer importable by a test without it also trying to run.

They are plain ESM JavaScript, not TypeScript, because the action runs them with the runner's bare
`node` and must not depend on a build step, a loader, or the consumer's `setup-node` version. They are
still type-checked and still unit-tested: `tsconfig.json` gains `"allowJs": true`, `"checkJs": true`, and
`"action/**/*"` in `include`, so `npx tsc --noEmit` covers them through JSDoc types, and a `.ts` test
under `test/action/` imports the composer directly. `tsconfig.build.json` is untouched — these files are
not part of `dist` and are not published.

**The composer imports nothing from `src/`.** It is a Markdown-comment composer with a character budget;
it does not know what GitHub is. Every forge-specific number and string — the character cap, the marker,
the links — arrives as an argument, and their values live in `action.yml`. That is what keeps
"urtext learns nothing about GitHub" true of the repository and not merely of the `src/` directory.

### Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `range` | no | `""` | The git range to review, passed to `urtext review` verbatim. Empty means the action derives `<base sha>...<head sha>` from the `pull_request` payload (see below). |
| `anthropic-api-key` | no | `""` | The key for the interpretation stage, passed to the CLI as the `ANTHROPIC_API_KEY` environment variable and never as an argument. **Empty runs `--no-llm`**; it never fails. |
| `model` | no | `""` | Passed as `--model` when non-empty. Empty means urtext's own default. Has no effect without `anthropic-api-key`. |
| `github-token` | no | `${{ github.token }}` | The token `gh` authenticates with. Needs `pull-requests: write`. |
| `comment-marker` | no | `<!-- urtext-review -->` | The hidden marker identifying this action's comment. Change it to keep two independent urtext comments on one pull request (two ranges, say). |
| `comment-limit` | no | `65536` | The maximum comment body length in characters. GitHub's limit; an input so the number is data the action carries, not a constant compiled into urtext. |
| `upload-report` | no | `true` | Upload the run's `.urtext/` directory and the Markdown review as a build artifact, and link it from the comment. |
| `artifact-name` | no | `urtext-review` | The name of that artifact. |
| `fail-on-error` | no | `false` | When `true`, the action's last step exits nonzero if the review could not be produced or could not be posted. Default is that neither ever fails the workflow. |

Defaults are chosen so that the minimal usage — `uses: noahogbi/urtext@v1` with no `with:` block at all —
is the deterministic, non-blocking, always-posting configuration §3 and §4 argue for.

**The key input is the opt-in, and its absence is the default.** A workflow that writes
`anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}` unconditionally degrades to deterministic on its
own: an undefined secret expands to the empty string, the action sees no key, and it passes `--no-llm`.
There is no configuration in which a missing key is an error, which is the binding requirement, and it
falls out of the expression language rather than being enforced by a check that could be forgotten.

### Outputs

| Output | Meaning |
|---|---|
| `outcome` | `reviewed` when urtext produced a review, `failed` when it did not. |
| `posted` | `created`, `edited`, or `none`. |
| `comment-id` | The id of the created or edited comment; empty when `posted` is `none`. |
| `comment-url` | The comment's `html_url`; empty when `posted` is `none`. |
| `exit-code` | urtext's own exit code, verbatim. The action interprets it; it never rewrites it. |
| `omitted-findings` | How many findings the character cap left out. `0` when nothing was omitted. |
| `report-artifact-url` | The uploaded artifact's URL; empty when `upload-report` is `false` or the upload produced no URL. |

### Range resolution

The action reads `github.event.pull_request.base.sha` and `github.event.pull_request.head.sha` and
composes **`<base>...<head>`** — the three-dot form.

Three dots, not two, for the reason `resolveRange` already documents in `src/extract/git.ts`:
`pull_request.base.sha` is the base branch's tip when the event fired, not the merge base. `base..head`
would report every commit the base branch gained since the fork as a reversal in the pull request — false
findings about files the branch never touched. `base...head` asks git for the merge base first, which is
"the change this pull request introduces" and is exactly what a reviewer is looking at on the Files
Changed tab.

**This is why the consuming workflow must check out with `fetch-depth: 0`.** A merge base cannot be
computed from a shallow clone, and the action's usage documentation says so in its first example. The
action does not silently paper over a shallow checkout: its first step verifies that both SHAs resolve
(`git cat-file -e <sha>^{commit}`), attempts one `git fetch --no-tags origin <base> <head>` when either
does not, and takes the failure path of §4 when they still do not — with a message naming `fetch-depth`
as the likely cause. A review of the wrong range is worse than no review, so it is never guessed at.

An explicit `range` input, when given, replaces the derived one entirely and skips the resolution step.

### Steps, in order

Every `run` step declares `shell: bash`. Every value that comes from an expression is passed through
`env:` and read as `"$VAR"` inside the script — never interpolated into a script body. The pull request
payload is attacker-authored text on a fork PR, and a uniform rule is the only one that stays true when a
later step starts reading a field that matters.

**Composite steps do not support `continue-on-error`.** This is load-bearing for §4: every step that can
fail captures its own status in the shell and reports it through `$GITHUB_OUTPUT` instead of being
allowed to abort the composite.

> **Correction (2026-08-25, after review).** The claim above is false. GitHub's metadata-syntax reference
> documents `runs.steps[*].continue-on-error` for composite actions: *"Prevents the action from failing
> when a step fails. Set to `true` to allow the action to pass when this step fails."*
>
> The design it justified is nonetheless correct, for two reasons this paragraph should have given
> instead. First, `continue-on-error` exposes only `outcome` and `conclusion` — pass or fail — while this
> action needs urtext's **numeric** exit code: `exit-code` is a public output and the exit-code table
> decides whether the comment carries a review or a failure body. Second, the compose and upsert steps
> run under `-e`, so a bare failure kills the script at the failing line and everything after it —
> compose's `outcome=failed` default, upsert's warning and `posted=none` write — never runs.
> `continue-on-error` tolerates a dead step; it cannot resurrect the lines that would have written the
> outputs.
>
> What the false premise did cost is the **one `uses:` step**, where shell capture is impossible and this
> key is the only instrument available. It went unguarded, and the action's headline promise acquired an
> undocumented exception. See `docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md`.
>
> Note for whoever makes this key conditional later: `actions/runner#2418` reports it working with
> literal values and failing with expressions that reference `inputs.*`, which are evaluated in the
> composite context where they are undefined.

1. **Refuse `pull_request_target`.** See §5. Fails the step unconditionally when the event name is
   `pull_request_target`; `fail-on-error` does not apply.
2. **Resolve the range** (skipped when `range` was given), per the section above.
3. **Build urtext.** `npm ci --prefix "$GITHUB_ACTION_PATH"` — which runs the repository's own `prepare`
   script and therefore its build — so the action runs the same `dist/bin.js` an install ships. It runs
   in the action's own checkout, never in the consumer's workspace; nothing in the reviewed repository is
   installed, and no script from the reviewed repository is executed.
4. **Run urtext**, with the consumer's workspace as the working directory:

   ~~~bash
   set +e
   node "$GITHUB_ACTION_PATH/dist/bin.js" review "$RANGE" $LLM_ARGS --stdout md \
     > "$RUNNER_TEMP/urtext-review.md" 2> "$RUNNER_TEMP/urtext-review.log"
   code=$?
   set -e
   echo "exit-code=$code" >> "$GITHUB_OUTPUT"
   ~~~

   `$LLM_ARGS` is `--no-llm` when no key was supplied, and `--model "$MODEL"` (or empty) when one was.
   The key itself reaches the process only through `env: ANTHROPIC_API_KEY:`.
5. **Write the job summary.** The full, untruncated `urtext-review.md` is appended to
   `$GITHUB_STEP_SUMMARY` whenever the run produced one. The job summary is capped by GitHub at 1 MiB
   and a larger review is cut by GitHub, not by urtext — stated here and in the action's documentation
   because an undisclosed cap anywhere in this pipeline is the thing §3 exists to forbid; the artifact is
   the uncapped copy.
6. **Upload the artifact** (`actions/upload-artifact@v4`, `id: upload`), when `upload-report` is `true`
   and step 4 produced anything: the `.urtext/` directory and `$RUNNER_TEMP/urtext-review.md`. Its
   `artifact-url` output is what the comment links to. This step runs **before** the composer, because
   the composer needs that URL.
7. **Compose the comment.** `node "$GITHUB_ACTION_PATH/action/compose-comment-bin.mjs"` with the
   arguments in §3, writing the body to `$RUNNER_TEMP/urtext-comment.md` and a one-line JSON summary to
   `$RUNNER_TEMP/urtext-summary.json`, from which the step sets `omitted-findings` and `outcome`.
   (**Correction, 2026-08-24:** this file was originally named `urtext-comment.json` here, colliding with
   the *payload* file of that name in §3's upsert snippet — two different documents under one path. The
   summary is `urtext-summary.json`; the `jq -Rs` payload keeps `urtext-comment.json`. The committed
   `action.yml` is authoritative.)
8. **Upsert the comment**, per §3.
9. **Report.** Sets the remaining outputs and, only when `fail-on-error` is `true` and either
   `outcome` is `failed` or `posted` is `none`, exits 1.

---

## 3. The comment: one per pull request, always posted, capped with disclosure

### Idempotent upsert

The comment body's **first line is the marker**, an HTML comment that renders as nothing. The action
finds a prior comment by that marker and edits it; it never appends a second one per push.

Find — `--paginate` without `--jq` so `gh` emits a stream of page arrays, and a real `jq` with `--arg` so
the marker is data rather than text spliced into a filter:

~~~bash
id="$(gh api --paginate "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
      | jq -r --arg m "$MARKER" '.[] | select(.body | startswith($m)) | .id' \
      | head -n 1)"
~~~

> **Correction (2026-08-24, verified during implementation).** The snippet above is
> **defective as written** and must not be transcribed. Under the runner's
> `set -o pipefail`, `head -n 1` closes the pipe while `gh` is still writing on a
> paginated repository; `PIPESTATUS` comes back `(141 141 0)` and the assignment
> aborts the step — on a search that found the right id. Reproduced with a
> still-writing producer. The implementation guards the pipeline instead; take the
> committed `action.yml` as authoritative over this block.

`startswith`, not `contains`: the marker is the first line of every body this action writes, so
`startswith` matches exactly the comments this action wrote — and does not match a human comment that
happens to quote the marker while discussing it. Matching is on the marker alone and never on the comment
author, because a repository that swaps `github.token` for an App token changes the author and must not
thereby orphan its own comment and start a second thread.

Edit or create — the body is turned into a JSON payload by `jq -Rs`, which is the only form that is
correct for arbitrary review text (backticks, quotes, backslashes, and control characters all appear in
excerpts):

~~~bash
jq -Rs '{body: .}' < "$RUNNER_TEMP/urtext-comment.md" > "$RUNNER_TEMP/urtext-comment.json"

set +e
if [ -n "$id" ]; then
  response="$(gh api -X PATCH "repos/$GH_REPO/issues/comments/$id" \
              --input "$RUNNER_TEMP/urtext-comment.json" 2> "$RUNNER_TEMP/urtext-post.log")"
  action=edited
else
  response="$(gh api -X POST "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
              --input "$RUNNER_TEMP/urtext-comment.json" 2> "$RUNNER_TEMP/urtext-post.log")"
  action=created
fi
post_code=$?
set -e
~~~

> **Correction (2026-08-24, verified during implementation).** `post_code=$?` placed
> after `fi` captures the exit status of the **`if` statement**, not of `gh` — and an
> `if` whose branch ran is always `0`. Reproduced end to end with a stubbed `gh`
> returning 403: this shape reports `posted=created` with a null comment id, no
> warning, and — because `outcome=reviewed` — **`fail-on-error: true` also stays
> green**, so the fork-PR case §5 describes would have had no surface anywhere. The
> status must be captured inside each branch, immediately after its own `gh` call.
> The committed `action.yml` is authoritative over this block.

On success the step sets `posted=$action`, `comment-id` and `comment-url` from
`jq -r '.id'` / `jq -r '.html_url'` over `$response`. On failure it takes the not-posted path in §5.

`gh` is on every GitHub-hosted runner and authenticates from `GH_TOKEN`, which the step sets from the
`github-token` input. `jq` is on every GitHub-hosted runner too. Neither is a dependency urtext acquires.

**The marker survives the round trip by construction**, not by care: every branch of `composeComment`
emits `marker + "\n"` first, and the PATCH body is produced by the same function that produced the POST
body. A test asserts the property on every branch rather than on one.

### Always posted, including zero findings

The comment is posted whether the range produced twenty findings or none. Silence is ambiguous: a pull
request with no urtext comment might be a clean range, a workflow that did not trigger, a token that
could not post, or a tool that crashed, and a reviewer cannot tell which. This tool does not do ambiguous
absence — it is the same commitment that makes `EMPTY_LENS_COPY` a sentence about the filter rather than
about the code, and that makes `NO_FINDINGS_COPY` say "nothing tripped an analyzer" rather than "this
change is fine."

**The zero-findings comment is not special-cased anywhere.** `renderMarkdown` already produces a complete
document for a findings-free run — the scope line, the disclosures, and each lens carrying
`EMPTY_LENS_COPY` — so the action posts what the tool printed, through the identical code path it uses
for a comment with twenty findings. There is no second shape to drift. For a two-commit range reviewed
deterministically it is exactly:

~~~markdown
<!-- urtext-review -->
# urtext review

3 files, 78 lines changed · 8f3c1a2...b91d4e0

> **This review is partial.**
>
> --no-llm was set, so the model was not asked

## Narrative

Nothing in this range matched this view.

## Effects & contracts

Nothing in this range matched this view.

## API surface

Nothing in this range matched this view.

<sub>Posted by [urtext](https://github.com/noahogbi/urtext) · [full report](ARTIFACT_URL) · [workflow run](RUN_URL)</sub>
~~~

Two consequences worth naming rather than discovering:

- **Every deterministic CI comment says "This review is partial."** That is correct and it stays.
  A `--no-llm` run genuinely fell short of the full pipeline, and the tiers only mean anything to a reader
  who knows the model was not asked. A banner that is honest on every run is not a banner to suppress.
- **The H1 stays an H1.** The action does not demote headings to fit a comment's visual weight. Reshaping
  the tool's document on its way to the reader is the class of silent transformation this project refuses;
  one large line is a cheap price for the comment being the review rather than a rendering of it.

### The footer

Appended after the review, separated by a blank line, and counted against the character budget:

```
<sub>Posted by [urtext](https://github.com/noahogbi/urtext) · [full report](ARTIFACT_URL) · [workflow run](RUN_URL)</sub>
```

Without an artifact URL the middle link is omitted and the workflow-run link remains. The footer carries
no claim about the review; the review's own disclosures are the review's job, and duplicating one of them
here would put the same sentence in two places with two owners.

### The cap, and never a silent one

The body must fit `comment-limit` characters. When it does not, the composer removes **whole findings**
and says so.

**Segmentation.** The composer splits the review into a head (everything before the first `## ` heading),
a sequence of lens sections (`## `), and within each section a sequence of finding blocks (`### `). The
scan is **fence-aware**: a line matching `` /^`{3,}/ `` at depth zero opens a fence of that run's length,
and only a line that is a run of at least that many backticks and nothing else closes it. Headings are
recognized only outside a fence.

This is not defensive decoration. `src/report/markdown.ts` says of excerpts that they are "the one place
this document quotes text an adversary can author outright", and escalates its fences precisely so that
untrusted text cannot become document structure. A truncator that split on a bare `^### ` would reopen
that door from the other side: an excerpt containing a line beginning `### ` would be read as a finding
boundary, and a cut there would drop a fence's closing line and mangle everything after it. The scanner's
contract is "the shapes `renderMarkdown` emits", and it is pinned by a test that runs the real renderer
over a real model whose excerpt contains both a triple-backtick run and a `### ` line.

**Removal order.** While the body exceeds the limit, the composer removes the **last** finding of
whichever lens section currently holds the most findings; ties go to the later section in document order.

Within every lens the kept findings are therefore the highest-ranked ones — a prefix of the model's rank
order, which `renderMarkdown` preserves inside each section. Across lenses the drop is balanced, and the
reason is specific rather than aesthetic: the Markdown surface partitions findings by lens, so global rank
is not recoverable from the document, and cutting a plain suffix would keep every low-ranked Narrative row
(where standalone model-tier claims land) while dropping the Effects section (where removed guards land)
in its entirety. Cutting the weakest tail of each view is the closest thing to "highest-ranked kept" that
the document actually carries, and it is deterministic.

**Disclosure.** The notice is inserted into the head, immediately after the scope line and among the
other disclosures — the surfaces' existing rule that disclosures lead:

```
> **This comment is truncated.** 7 of 23 findings were left out to fit the 65536-character comment
> limit; the highest-ranked findings in each view were kept. The complete review is in the
> [full report](ARTIFACT_URL) and in this [workflow run](RUN_URL)'s job summary.
```

The artifact clause is present exactly when an artifact URL was supplied; the run clause always is.

**A section emptied by truncation never shows `EMPTY_LENS_COPY`.** "Nothing in this range matched this
view" would be a lie about a view whose findings the comment dropped. Such a section keeps its heading and
carries instead:

```
All 4 findings in this view were left out of this comment. The full report has them.
```

**If nothing remains to remove and the body still exceeds the limit** — which only the head's own
disclosures can cause — the composer emits the failure body of §4 with the reason "the review's
disclosures alone exceed the comment limit", rather than cutting into a sentence. There is no branch in
which this pipeline shortens text without saying so.

### The composer's interface

```js
/**
 * @typedef {object} ComposeOptions
 * @property {string} marker        First line of every body; how the upsert finds its comment.
 * @property {number} limit         Maximum body length in characters.
 * @property {string} review        The Markdown review, verbatim from `urtext --stdout md`.
 * @property {string} log           urtext's stderr, used only by the failure body.
 * @property {number} exitCode      urtext's exit code, verbatim.
 * @property {string} range         The range urtext was asked for, for the failure body.
 * @property {string} runUrl        Link to the workflow run. Always present.
 * @property {string} [artifactUrl] Link to the uploaded report, when there is one.
 */

/**
 * @param {ComposeOptions} options
 * @returns {{ body: string, omitted: number, kept: number, outcome: "reviewed" | "failed" }}
 */
export function composeComment(options) { /* ... */ }
```

`compose-comment-bin.mjs` maps `--marker`, `--limit`, `--review`, `--log`, `--exit-code`, `--range`,
`--run-url`, `--artifact-url`, `--body-out`, and `--summary-out` onto it, reads the two file arguments,
writes the body and a single-line JSON summary, and exits zero. Nothing goes to stdout: a composer that
printed its result would tempt the action into piping it, and a body that has passed through a shell
pipeline is a body whose trailing newlines are no longer the composer's.

---

## 4. `--no-llm` by default, and failure that does not fail the pull request

### Deterministic by default

With no `anthropic-api-key`, the action passes `--no-llm`. This is the default and it is not a
performance decision.

A pull request comment is edited in place on every push and read by people who did not run the tool. If
its claims changed between two pushes that did not change the relevant code — a `model`-tier finding
appearing, disappearing, and reappearing across three force-pushes of an unrelated file — the tiers would
have taught the reader nothing except that the review is weather. The founding spec's rule is that a tool
rendering verdicts is trusted exactly once, and the tier system exists so that a reader can tell which
half of a review is checkable. The deterministic analyzers are the half that cannot hallucinate: given the
same two commits they produce the same facts, the same order, and the same evidence, and every one of
those findings can point at the line that proves it.

Turning the model on is a legitimate choice a repository can make, and the action supports it with one
line. It is opt-in because the cost of being wrong is paid in a public comment on somebody's work rather
than in a terminal the author can scroll past.

The disclosure needs no new machinery: `--no-llm` already pushes "--no-llm was set, so the model was not
asked" into `warnings`, which becomes `ReportModel.notes`, which the Markdown surface prints under
**This review is partial.** The comment says what it did and did not do, in the tool's own words, on
every run.

### The action does not fail the pull request

**Default: the step succeeds no matter what urtext did.** urtext is a reviewer, not a gate. A tool that
turns a red X on a contributor's pull request because its own build broke has spent the contributor's
attention on itself, and the founding spec's first non-goal is that this tool renders no verdict —
failing a check is the strongest verdict a workflow can render.

When the review could not be produced — a nonzero exit code, an empty stdout, an unresolvable range, a
crashed build — the action still posts (or edits its existing comment to) a body that says so:

~~~markdown
<!-- urtext-review -->
# urtext review

**The review could not be produced.**

urtext exited 1 for `8f3c1a2...b91d4e0`.

<details><summary>What urtext reported</summary>

```
Note: the guards analyzer failed, so this review is partial: ...
Note: --no-llm was set, so the model was not asked
No findings. Nothing in this change tripped an analyzer.
```

</details>

This says nothing about the pull request: it reports a failure of the review tool, not a finding about
the change.

<sub>Posted by [urtext](https://github.com/noahogbi/urtext) · [workflow run](RUN_URL)</sub>
~~~

Rules for that body:

- The `<details>` block holds the **last 40 lines** of urtext's stderr, inside a fence one backtick longer
  than the longest backtick run it contains — the same escalation rule `fenceFor` applies in
  `src/report/markdown.ts`, and for the same reason.
- If the failure body itself exceeds the limit, the log tail is shortened further and a line states how
  many lines were dropped. No cap in this pipeline is silent.

  > **Correction (2026-08-25, after review).** "Still posts", above, has one exception this section never
  > named. Shortening the tail is bounded: the headline, reason, closing sentence and footer are fixed
  > copy this design forbids shortening, so a `comment-limit` below their combined length yields a body
  > over the budget it was given, and the composer returns no signal that it happened. **That body is
  > still posted.** What the action withholds is a body over **the API's own limit** (`FORGE_LIMIT`,
  > 65536) — posting it would buy a rejection whose error text is about a field length rather than about
  > urtext. Lowering `comment-limit` can never cause that; only fixed copy exceeding 65536 can. On the
  > withheld path the action warns, sets `posted: none`, and leaves the review in the job summary — and
  > in the artifact when one was uploaded, which `upload-report: false` and a tolerated upload failure
  > both make untrue. See `docs/superpowers/specs/2026-08-25-urtext-action-honesty-design.md`.
- The closing sentence is fixed copy and is not optional. Without it, a red-flavored comment on a pull
  request reads as a finding, and the one thing the action must never do is let a tool failure be
  mistaken for a review result.
- **Editing to the failure body is correct.** A stale successful review left in place would describe a
  range that is no longer the pull request's, which is worse than an honest statement that this push was
  not reviewed.

`fail-on-error: true` is the opt-in for repositories that want the workflow to go red — for example the
one dogfooding this action, where a broken urtext is the thing under test. Even then, the comment is
posted first and the failure happens in the last step, so a red run still carries its explanation.

### urtext's exit codes are unchanged, and the action reads them

| urtext exit code | Action's reading |
|---|---|
| `0` with non-empty stdout | `outcome: reviewed`; post the review comment. |
| `0` with empty stdout | `outcome: failed`; post the failure comment. This is a contract violation upstream, and the comment says the review could not be produced rather than posting an empty one. |
| `1` | `outcome: failed`; post the failure comment with the exit code and the stderr tail. Both of urtext's nonzero conditions — every analyzer dead, or some dead and nothing shown — mean the deterministic half did not work, which is exactly the case the action must not present as a clean review. |

The action adds no exit code of its own and never rewrites urtext's; `exit-code` is an output so a
workflow that wants to branch on it can.

---

## 5. Permissions and security

### Minimum workflow permissions

```yaml
permissions:
  contents: read        # actions/checkout
  pull-requests: write  # create and edit the comment
```

`issues: write` is **not** required. A pull request comment is created through the issue-comments
endpoint on a pull request, which the `pull-requests` scope governs; granting `issues: write` would widen
the token for no gain. Nothing here needs `actions:`, `checks:`, or `statuses:` — the action posts a
comment and creates no check run (see Out of scope).

The action's documentation shows the `permissions:` block in its first example, at the job level rather
than the workflow level, so a repository adopting it does not widen the token for its other jobs.

### `pull_request_target` is refused

**The action supports `pull_request`. On `pull_request_target` it fails the step immediately**, with a
message naming the reason, and `fail-on-error` does not apply to that refusal.

`pull_request_target` runs the workflow definition from the base branch with a full write token and
access to secrets. Every documented compromise of that trigger has the same shape: the workflow then
checks out or executes something from the head ref, and fork-authored content runs with a token that can
write to the base repository. urtext's job is to read the head revision's TypeScript and build a
`ts.Program` over it — parsing attacker-authored files, resolving attacker-authored `tsconfig.json`, and
running `git` against attacker-authored refs. That is not a combination to put behind a write token on
the strength of "the compiler does not execute code."

The refusal is loud rather than degraded, and it is the one place in this design where a step fails on
purpose. A misconfigured trigger is not a urtext failure to be disclosed in a comment; it is a security
property the repository believes it has and does not, and a comment saying so would be read by nobody
before the token was already exposed.

### Fork pull requests: what actually happens

On a `pull_request` event whose head is a fork, **`GITHUB_TOKEN` is read-only regardless of the
`permissions:` block**, and repository secrets are not exposed to the run. The action's own `permissions`
documentation cannot change this.

Concretely:

- The review still runs. Deterministic analysis needs no secret, and `contents: read` is all the checkout
  needs.
- `anthropic-api-key` expands to empty because the secret is not available, so the run is `--no-llm` —
  the same path as the default, reached automatically.
- **The POST fails with HTTP 403.** The action does not pre-empt it by inspecting the payload, because a
  repository that supplied its own write-capable token through `github-token` would then be skipped
  wrongly. It attempts the post, and on any failure:
  - writes `::warning::urtext could not post its review (the workflow's token may be read-only, which is
    the case on pull requests from forks). The full review is in this run's job summary.`
  - sets `posted: none` and leaves `comment-id` and `comment-url` empty,
  - leaves the full review in the job summary and the artifact, where it already is,
  - and **does not fail the step** unless `fail-on-error` is `true`.

What a repository owner can do, honestly:

1. **Nothing keeps both properties at once.** There is no configuration in which a fork pull request's
   `GITHUB_TOKEN` can write a comment. Supplying a PAT through `github-token` does not help either,
   because secrets are unavailable to fork-PR runs — the token input would expand to empty.
2. **The known-safe pattern is a two-workflow split.** A `pull_request` workflow runs the review and
   uploads it as an artifact; a second workflow on `workflow_run` — which runs from the base branch, with
   a write token, and never checks out head code — downloads that artifact and posts it. This action
   already produces the artifact the first half needs. Shipping the second half as its own posting-only
   action is a deliberate follow-up, not part of this design, and the action's documentation states the
   limitation and points at the pattern rather than implying fork support it does not have.
3. **For a repository whose contributors push branches rather than fork** — which is the case for this
   one, and for most private repositories — none of this applies and the default configuration posts.

### Injection

Every expression value reaches a script through `env:`, never through `${{ }}` inside a `run:` body. No
step reads the pull request title, body, or branch name. The comment body is built by a Node program from
files on disk and turned into JSON by `jq -Rs`, so no review text is ever re-parsed by a shell.

---

## 6. Dogfooding

urtext reviews its own pull requests through **a separate workflow, `.github/workflows/urtext-review.yml`**,
not a job inside `ci.yml`.

```yaml
name: urtext review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ./
        with:
          fail-on-error: true
```

Four reasons for the split, each of which would be a defect inside `ci.yml`:

1. **`ci.yml` is a two-OS matrix.** A review job inside it would run on Ubuntu and Windows and post
   twice — or edit the same comment twice per push, racing itself — and suppressing one leg with a matrix
   condition is a workaround for a structural mistake. The review is a single artifact of a pull request,
   not a per-platform result.
2. **`ci.yml` also runs on `push: branches: [master]`**, where there is no pull request to comment on. The
   review workflow is `pull_request` only, and the trigger difference is exactly what a separate file
   expresses cleanly.
3. **`ci.yml` is the gate.** It is what a branch protection rule points at, and it must stay a
   pass/fail statement about tests. A non-blocking commentary job living inside it makes the required
   check ambiguous. Here the two are separable by name.
4. **`uses: ./` needs the action's own checkout**, which the review workflow does with `fetch-depth: 0` —
   a full clone that `ci.yml` deliberately does not do (`fetch-depth: 2`, with a comment explaining
   exactly why two).

**`ci.yml` is unchanged.** Its final step, `node dist/bin.js review HEAD~1 --no-llm`, stays exactly as it
is: it is a smoke test proving the built artifact runs on both platforms, on every push and every pull
request, and it is a *test*, not a review. Replacing it with the action would trade a two-platform check
of the shipped binary for a one-platform check of a workflow.

This repository uses `fail-on-error: true` — the opposite of the default — precisely because it is the
one repository for which a urtext failure is a defect in the thing under test rather than noise.

### README

The README's install section gains a short "In CI" subsection: the minimal workflow above, the
`permissions:` block, the one line that turns the model on, and the fork-PR limitation stated in the same
sentence it is stated in here. The Layout list gains `action.yml` and `action/`. Nothing in the existing
copy changes.

---

## Testing

In the house style: what a plan's tests must pin, not how. And with the boundary stated plainly, because
half of this design is not unit-testable and pretending otherwise would be the same dishonesty the tool
is built against.

### The CLI side — fully testable in vitest, and the plan must test it

- **stdout purity** (`test/cli.test.ts`): under `--stdout md`, the returned `markdown` equals
  `renderMarkdown(buildReportModel(...))` for the same run, and contains **none** of the strings the other
  channel carries — no `Full report:`, no `Note:`, no `Tip: add ".urtext/"`, no `md export:` line. The
  assertion is that those strings are absent from stdout *and present in* `output`, so a regression that
  simply dropped them from both would fail.
- **One model, one string:** a run given both `--stdout md` and `--export md` produces a `markdown` value
  byte-identical to the file `writeExport` wrote.
- **Broken runs print nothing on stdout:** the three existing analyzer-failure cases re-run with
  `--stdout md` yield an absent `markdown` and their existing exit codes, while `output` still carries
  every note. Deleting the exit-code gate must fail this test.
- **`streamsFor`:** the Markdown owns stdout and the human render owns stderr under the flag; the reverse
  and an empty stderr without it.
- **Parsing:** `--stdout md` and `--stdout=md` both parse; an unknown value, a missing value, and a
  following flag each error in the example-led style; `--stdout md --json` errors naming both flags;
  `USAGE` names `--stdout md`.
- **Nothing else moved:** the existing `test/cli.test.ts` suite passes with zero changes to expected
  strings. That is the acceptance test for "purely additive", exactly as the export spec made it for the
  terminal/HTML refactor.

### The composer — fully testable in vitest, and this is where the cap's honesty is pinned

`test/action/compose-comment.test.ts` imports `action/compose-comment.mjs` directly. Its inputs are built
by running the **real** `renderMarkdown` over models built from real analyzer output, not by hand-writing
Markdown — a fixture written to match the scanner cannot notice the renderer changing.

- **The marker leads every branch:** review, truncated, section-emptied, and failure bodies all begin with
  `marker + "\n"`, and all satisfy the exact predicate the upsert's `jq` uses (`startswith(marker)`). This
  is the locally testable half of "the marker survives an edit round-trip".
- **Under the limit:** the review is emitted verbatim between marker and footer, with no truncation notice
  anywhere in the body.
- **Over the limit:** the body is at most `limit` characters; the notice is present with the exact omitted
  and total counts; every kept finding is whole (the result is re-scanned and every fence is balanced);
  the kept findings within each view are a prefix of that view's findings in the input; and the first
  removal comes from the largest view when the three are of unequal size.
- **An emptied view says so:** its heading survives, the removal copy is present, and `EMPTY_LENS_COPY` —
  imported into the test from `src/report/model.ts`, so the test cannot drift from the real sentence — is
  absent from that section.
- **Fence-aware segmentation:** a review whose evidence excerpt contains both a triple-backtick run and a
  line beginning `### ` is segmented into the correct number of findings, and truncating it never leaves
  an unclosed fence. Replacing the fence-aware scan with a bare `^### ` match must fail this test.
- **Zero findings:** the composed body carries all three `EMPTY_LENS_COPY` sections verbatim, no
  truncation notice, and nothing between the review and the footer.
- **Failure branch:** a nonzero exit code, and separately a zero exit code with empty review text, both
  produce the failure body carrying the range, the exit code, the stderr tail, and the fixed closing
  sentence; a log long enough to blow the limit is shortened with a stated count of dropped lines; and a
  review that cannot be shrunk below the limit by removing every finding falls back to the failure body
  with its stated reason.
- **Links:** the artifact clause appears exactly when an artifact URL was given; the run link always
  appears.
- **Mutation checks named in the plan:** deleting the truncation notice must fail the over-limit test;
  deleting the emptied-view copy must fail the emptied-view test; deleting the fence tracking must fail
  the segmentation test.

### The action's YAML — testable as data, not as behavior

`test/action/action-yml.test.ts` parses `action.yml` (new devDependency: `yaml`, dev-only, the single
dependency this design adds) and asserts:

- it parses, `runs.using` is `composite`, and every `run` step declares `shell: bash`;
- every input the steps reference through `inputs.<name>` exists in `inputs`, and every declared input is
  referenced somewhere — a renamed input is the failure mode that actually happens, and it fails silently
  at runtime as an empty string;
- every declared output's `value` references a step id that exists;
- **no `run` step body contains a `${{` sequence** — the injection rule of §5, enforced mechanically
  rather than by review;
- the artifact upload step precedes the composer step, which precedes the upsert step;
- the default `comment-limit` equals the documented cap, and the default `comment-marker` is the marker
  the composer's tests use.

### What cannot be tested locally, stated plainly

**A composite GitHub Action cannot be executed by vitest.** There is no runner for `$GITHUB_OUTPUT`,
`$RUNNER_TEMP`, `gh`, the event payload, or `actions/upload-artifact` inside this test suite, and this
design does not propose adding one (a container-based local runner is a second CI system to maintain, and
it would still not exercise the token semantics that matter most here). The YAML tests above check the
shape; the wiring is checked by running it.

The plan must therefore carry an explicit acceptance checklist, performed once against a real pull request
in this repository and recorded in the pull request that adds the action:

1. A pull request with findings gets exactly one comment, and its range matches the Files Changed tab.
2. A second push **edits that comment** — the comment count on the pull request stays at one, and the
   comment's `updated_at` moves.
3. A pull request with no findings still gets a comment, in the shape §3 spells out.
4. A run forced to fail (`range: nonexistent..HEAD`) posts the failure comment, and with
   `fail-on-error: false` the step is green.
5. The artifact uploads and the comment's `full report` link resolves to it.
6. A truncated comment: a range large enough to exceed the cap posts with the notice present and the
   kept findings whole. (Constructible on demand by lowering `comment-limit` on a test branch — which is
   the reason the cap is an input and not a constant.)
7. A fork pull request produces the `::warning::`, `posted: none`, a green step, and a job summary
   carrying the full review.
8. A workflow using `pull_request_target` fails the step with the refusal message.

Items 1–6 are reproducible by anyone; 7 and 8 need a fork and a deliberately misconfigured workflow, and
the plan should schedule them rather than let them be skipped quietly.

### Every behavior change lands with a test that fails before it.

---

## Global constraints (carried from the project)

- No claim ever renders as `verified`; model prose never renders without attribution; the concealment
  defense applies to every surface; empty-lens copy is filter-shaped; **urtext writes only inside
  `.urtext/`** — the action writes to `$RUNNER_TEMP` and `$GITHUB_STEP_SUMMARY`, which is the action's
  own filesystem and not the reviewed repository's.
- **No new runtime dependency.** `gh` and `jq` are the runner's, not urtext's; `yaml` is a devDependency
  used by one test; the composer imports nothing at all.
- **No GitHub knowledge under `src/`.** The cap, the marker, the links, and the event payload exist only
  in `action.yml` and `action/`. A test may assert the boundary by scanning `src/` for `github`,
  `GITHUB_`, `pull_request`, and `gh api`, and the plan should include it — a rule that is only a
  paragraph is a rule that erodes.
- **Comment contract:** comments name constants, never restate values, and `test/comment-contract.test.ts`
  must stay green. Two hazards this feature introduces, both avoidable and both worth naming so the plan
  does not trip them: the character cap must never be written into a comment or a copy string — it
  arrives as an argument and is interpolated into the disclosure from that argument, so there is exactly
  one place it exists; and the comment-contract scan covers `.ts` files only, so the composer's `.mjs`
  comments are outside it and must be written to the same standard without a guard to catch them.
- Invariant claims quote their enforcing test verbatim, in the style the existing modules already use.
- Every behavior change lands with a test that fails before it.

---

## Out of scope

- **Inline per-line review comments.** Posting findings as line comments on the diff needs a review API,
  a position-to-diff-hunk mapping that breaks on every force-push, and a resolution model urtext has no
  opinion about. It is also the surface most easily mistaken for a verdict: a line comment reads as "fix
  this", which is precisely what a tool that renders no verdict must not say.
- **Check-run annotations.** A check run is a pass/fail statement attached to a commit. This tool does not
  render verdicts, and the whole of §4 is an argument against letting it colour a contributor's checks.
- **GitLab, Bitbucket, Gitea, and any other forge.** The composer is deliberately forge-agnostic — it
  takes a marker, a limit, and two links — so a second forge is a second thin action over the same CLI
  contract. Building one before anybody has asked would be guessing at an API shape.
- **Auto-fixing.** urtext produces no patches, suggestions, or `suggestion` blocks. It reports what
  changed and what backs the claim; deciding what to do about it is the reader's, and always has been.
- **Blocking merges.** No required check, no merge queue integration, no branch protection guidance
  beyond "point your protection at `ci.yml`, not at this."
- **A `workflow_run` posting-only action** for fork pull requests. The pattern is named and the artifact
  it would consume is already produced; the second half is a separate design.
- **Reviewing a pull request the tool did not receive as a range** — fetching a PR by number, reading its
  description as intent, reviewing a repository the runner has not checked out. The intent spec already
  places PR descriptions out of scope, and this design does not smuggle them in through the payload.
