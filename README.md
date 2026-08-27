# Urtext

[![CI](https://github.com/noahogbi/urtext/actions/workflows/ci.yml/badge.svg)](https://github.com/noahogbi/urtext/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/urtext)](https://www.npmjs.com/package/urtext)

**A diff reviewer that shows its evidence.** Point `urtext` at a git range and it reports what
changed and why it matters — ranked, and with every claim labeled by the kind of evidence behind
it. A `verified` finding can point at the line of code that proves it. Nothing is asserted on
the reader's trust alone, and the tool never issues an approve/reject verdict; the judgement
stays with the human.

The name is the thesis: in philology, the *urtext* is the authoritative original from which all
editions derive. Here the code is the urtext; a review is an edition of it, and an edition that
cannot cite its source is worthless.

## What it does

`urtext review` takes a git range, analyses the change, and prints what
matters — ranked, with every claim labeled by the kind of evidence behind it:

- `verified` — proven by static analysis; the report points at the code
- `inferred` — a model claim that analysis corroborates but does not prove
- `model` — a model claim nothing mechanical confirms

Five analyzers run over the change:

- **guards** — conditionals, early returns, and throws removed from code that survived
- **surface** — exports added, removed, or changed shape
- **blast radius** — how many places reference a changed export
- **effects** — network, filesystem, process, env, database, and timing effects appearing or disappearing
- **citations** — prose that cites code by `path:line` or by a quoted phrase, where the citation resolved
  when its line was last written and no longer resolves now

Findings are ranked. A `verified` or `inferred` finding carries the evidence
behind it — file, line, and the quoted source. A `model` finding carries none
by construction, and the report says so where it prints one: it is a lead to
check, not a result.

A run that completes writes an HTML report into `.urtext/` at the repository
root and prints its path; a run broken enough to exit non-zero deliberately
writes none, so a report on disk never stands in for a review that worked.
`--export md,pdf` additionally writes the review as GitHub-flavored Markdown
and as a client-presentable PDF beside the HTML report, sharing its name;
the same no-report rule applies to every format.
urtext does not edit the reviewed repository's `.gitignore` — it suggests
adding `.urtext/` when nothing already ignores it, and leaves the file alone.

```bash
npm run review                          # working tree vs merge-base with the default branch
npm run review -- HEAD~3                # against a specific revision
npm run review -- --no-llm              # deterministic analysis only; no API key needed
npm run review -- --json                # machine-readable findings
npm run review -- --open                # open the written report
npm run review -- --export md,pdf       # also write Markdown and PDF beside the HTML report
npm run review -- --model claude-opus-5 # pick the interpretation model
npm run review -- --help                # every flag
```

The interpretation stage needs `ANTHROPIC_API_KEY`. Without it, urtext reports
the analyzers' findings and says in the report that the model was never asked.

## Install

```bash
npm install -g urtext
urtext review          # from any git repository
```

The published package ships its build, so nothing compiles on install and no
lifecycle script runs — which matters under npm v12, where dependency scripts
and git dependencies are both off by default.

**Installing from GitHub needs those defaults relaxed.** `npm install -g
github:noahogbi/urtext` is refused outright by npm v12 (`EALLOWGIT`), and even
allowed through it would fetch a tree with no `dist/`, whose build runs from a
`prepare` script that v12 also disables. Use the registry unless you have a
reason not to; from a local checkout, `npm install -g path/to/urtext` still
works.

The `npm run review` form above is the dev loop inside this repository; it runs
`src/` directly and needs no build.

PDF export embeds the bundled DejaVu fonts, which cover Latin, Cyrillic, and
Greek broadly but not CJK or other scripts — full-Unicode fonts cost tens of
megabytes.

### In CI

`action.yml` at this repository's root is a composite GitHub Action that reviews a
pull request and posts the result as one comment, edited in place on every push:

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
          fetch-depth: 0   # base...head needs the merge base, which a shallow clone lacks
      - uses: noahogbi/urtext@v1
```

`@v1` is a tag, so the action cannot change under you between runs the way `@master`
can. It was cut on a green cross-platform CI run — the check you can see for yourself
on this repository.

Four of the action's behaviours were verified against live pull requests, and it is
worth being exact about where that evidence sits: it was recorded during development,
in a private repository this one does not descend from, so **you cannot follow it from
here.** What was observed there — the workflow posted one marked comment carrying a
real review; a re-run edited that same comment rather than adding a second; a
deliberately failed artifact upload left the job green with the comment intact; and the
same failure without the upload guard took the job red. Read those as the author's
report, not as something this repository lets you check.

**The `pull_request_target` refusal has been observed.** It cannot be tested from a
branch of this repository — that trigger reads its workflow definition from the base
branch — so it was exercised in a throwaway repository carrying the misconfiguration on
its default branch. The action failed its guard step and **every later step of the
composite was skipped**: nothing fetched, nothing built, no attacker-authored code
parsed. Refusing before doing anything is the property that matters, and it is what the
run showed. That evidence was also in a private repository, so it is the author's report
on the same terms as the four above.

Worth correcting an earlier version of this paragraph, which said that refusal could not
be observed "from a branch" and was read — including by its author — as needing a fork.
It does not. `pull_request_target` fires for pull requests from branches in the same
repository too; the only requirement is that the workflow live on the default branch.

**One behaviour remains unverified and is not claimed:** a pull request from a fork,
where `GITHUB_TOKEN` is read-only and the post is expected to fail visibly. That one
genuinely needs a second account, and it is being left for the first real fork pull
request rather than manufactured — its failure mode is a visible, harmless warning on
somebody's pull request, not a silent one.

The `permissions:` block sits at the job level, not the workflow level, so adopting
this does not widen the token for a repository's other jobs. `issues: write` is not
required — a pull request comment is created through the issue-comments endpoint on a
pull request, which the `pull-requests` scope governs. The block itself is not
optional: without `pull-requests: write` the post comes back HTTP 403, which looks
exactly like the fork case below and is a different problem entirely.

By default the review is deterministic: with no key, the action passes `--no-llm`,
and the comment says so in urtext's own words. One line turns the model on:

```yaml
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

An undefined secret expands to the empty string, so that line degrades to
deterministic on its own rather than failing.

The action never fails a pull request: a review that could not be produced is posted
as a comment saying so, not as a red check. Every step that can fail captures its own
status, and the one step that cannot — the artifact upload, which is a `uses:` step
with no shell to capture in — is marked `continue-on-error`. A failed upload therefore
costs the comment its `full report` link and empties the `report-artifact-url` output,
rather than reddening the check. Note what that costs on a large review: the job summary
is capped by GitHub at 1 MiB and the artifact is the uncapped copy, so past that size a
failed upload loses the only complete copy of the review.
`fail-on-error: true` opts into the opposite.

One exception remains, deliberately, and `fail-on-error` does not govern it either: the
`pull_request_target` refusal below fails the job on purpose.

**Fork pull requests cannot be commented on.** On a `pull_request` run whose head is
a fork, `GITHUB_TOKEN` is read-only regardless of the `permissions:` block and
repository secrets are unavailable, so the post fails with HTTP 403; the action emits
a warning, sets `posted: none`, leaves the full review in the job summary — and in the
uploaded artifact when one was uploaded — and stays green. No configuration changes this — a personal access
token does not help either, because secrets are not exposed to fork-PR runs. The
known-safe pattern is a two-workflow split: a `pull_request` workflow runs the review
and uploads the artifact this action already produces, and a `workflow_run` workflow —
which runs from the base branch with a write token and never checks out head code —
downloads it and posts. Shipping that second half is a deliberate follow-up.

**`pull_request_target` is refused.** The action fails its first step on that trigger,
on purpose: it grants a write token and secrets to a workflow that then reads the head
revision, and urtext parses attacker-authored TypeScript.

The job summary carries the full, untruncated review. GitHub caps a job summary at
1 MiB and a larger review is cut by GitHub, not by urtext; the uploaded artifact is
the uncapped copy. If a *review* comment exceeds `comment-limit`, whole findings are
removed and the comment says how many and where the rest are.

A *failure* comment does not shrink that way. Its headline, reason, closing sentence
and footer are fixed copy, so a `comment-limit` below their combined length produces a
comment longer than you asked for — and it is still posted. The action withholds a
comment only when the body exceeds what the API itself accepts, which lowering
`comment-limit` cannot cause; that run warns, sets `posted: none`, and leaves the review
in the job summary — and in the artifact when one was uploaded.

Every input is optional:

| Input | What it does |
|---|---|
| `range` | The git range to review, passed to `urtext review` verbatim. Empty derives `<base sha>...<head sha>` from the pull request payload. |
| `anthropic-api-key` | Key for the interpretation stage, passed to the CLI as an environment variable and never as an argument. Empty runs `--no-llm`; it never fails. |
| `model` | Passed as `--model` when non-empty. No effect without `anthropic-api-key`. |
| `github-token` | The token `gh` authenticates with. Needs `pull-requests: write`. |
| `comment-marker` | The hidden marker identifying this action's comment. Change it to keep two independent urtext comments on one pull request. |
| `comment-limit` | Maximum comment body length in characters — the forge's cap carried as data rather than compiled into urtext. |
| `upload-report` | Upload the run's `.urtext/` directory and the Markdown review as a build artifact, and link it from the comment. |
| `artifact-name` | The name of that artifact. |
| `fail-on-error` | Exit non-zero when the review could not be produced or could not be posted. |

And the outputs a later step can read:

| Output | Value |
|---|---|
| `outcome` | `reviewed` when urtext produced a review, `failed` when it did not. |
| `posted` | `created`, `edited`, or `none`. `none` collapses three causes — a body the API would reject on length, a body that could not be composed, and a post the API refused — and the run's warning names which. |
| `comment-id` | The created or edited comment's id; empty when `posted` is `none`. |
| `comment-url` | The comment's `html_url`; empty when `posted` is `none`. |
| `exit-code` | urtext's own exit code, verbatim. The action interprets it; it never rewrites it. |
| `omitted-findings` | How many findings the character cap left out. |
| `report-artifact-url` | The uploaded artifact's URL; empty when `upload-report` is false, and also when the upload failed, which no longer fails the job. |

Every default lives in `action.yml` and is deliberately not restated here, so there is
one place to read it and one place to change it.

## Layout

- `src/extract/` — git range → changeset (files, hunks, changed symbols)
- `src/analyze/` — analyzers producing typed facts with source evidence
- `src/interpret/` — the model stage: facts in, labelled claims out
- `src/score/` — importance weights, tier assignment, ranking
- `src/report/` — terminal and HTML renderers, and report writing
- `src/cli.ts` — entry point
- `action.yml` — the composite GitHub Action that reviews a pull request
- `action/` — the action's comment composer, plain ESM run by the runner's `node`
- `archive/prototype/` — the klar-era IR prototype, kept for provenance

Design: `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`, and
`docs/superpowers/README.md` for how to read the rest of them — including which
citations in them no longer resolve here, and why they were left that way.

## Provenance

Built ~March 13, 2026 as a standalone prototype under the working name
**klar** — an AI-native IR the model authored directly. Renamed **urtext**
and first committed to version control August 15, 2026. In August 2026 it was
re-aimed at the problem that had become the real bottleneck: reviewing
AI-written diffs rather than authoring code in an IR. The prototype lives in
`archive/prototype/`.
