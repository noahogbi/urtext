# Security

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/noahogbi/urtext/security/advisories/new)
on this repository. That channel is private until an advisory is published, which
is the right place for anything you would not want in a public issue.

For anything that is not a vulnerability — a wrong finding, bad model output, a
crash — [an ordinary issue](https://github.com/noahogbi/urtext/issues) is the
faster path and is genuinely welcome.

This is a single-maintainer project. Expect a first response within a week
rather than within a day, and no bounty.

## What urtext can reach

Worth stating plainly, because it bounds what a vulnerability here could cost
you:

- **There is no server, no telemetry, and no account.** Nothing reaches the
  author of this tool. The CLI runs on your machine; the action runs in your
  own runner.
- **With `--no-llm`, the review makes no network call at all.** Every analyzer
  is local.
- **With a key, what goes to Anthropic goes under _your_ key** and your
  agreement with them. Exactly: the range label, each changed file's path and
  status and changed symbol names, one trimmed source line per analyzer fact,
  and the abbreviated hash, subject and body of each commit in the range with
  trailers stripped. The
  diff itself is not sent, nor the contents of the files it touches, nor git
  author names or email addresses — the intent stage asks git for hash,
  subject, and body, never for identity fields. `README.md` carries the same
  list, itemized.
- **Reports are written to `.urtext/` in your own repository**, and in CI are
  attached to the workflow run as an artifact your retention settings govern.

## The parts written as defenses

Two of urtext's behaviors exist for security reasons rather than product ones,
and they are the places to look first if you are auditing it:

**A review it cannot post is disclosed, not swallowed.** When the token cannot
create a comment — a fork pull request, or a workflow missing
`pull-requests: write` — the action warns, sets `posted: none`, leaves the full
review in the job summary and the uploaded artifact, and leaves the job green.
Green is deliberate: a red check on a contributor's first pull request reads as
a judgment about their change, when what happened is that a tool could not reach
an API. Verified on [a real fork pull
request](https://github.com/noahogbi/urtext/actions/runs/33295925588) and, for
the green half under the default `fail-on-error`, on [a run with a deliberately
read-only token](https://github.com/noahogbi/urtext/actions/runs/33291306506).

**It refuses `pull_request_target`** and fails its first step on that trigger.
That trigger grants a write token and repository secrets to a workflow that
then reads the head revision — and urtext parses head-authored TypeScript and
resolves a head-authored `tsconfig`. The refusal happens before anything is
fetched, built, or parsed. See `action.yml`, the `Refuse pull_request_target`
step, and `test/action/action-yml.test.ts`.

**Concealing characters are labeled, never rendered raw — on the surfaces a
person reads.** A review quotes source lines, and a source line can carry
bidirectional-override or zero-width characters that make code read as
something other than what it executes (Trojan Source). urtext replaces them
with visible code-point labels while building the report model, structurally,
so no label can be confused with source text that literally spells it. The
terminal, HTML, Markdown, and PDF surfaces all walk that model and are covered.
See `src/report/conceal.ts` and `src/report/model.ts`.

**`--json` is deliberately not covered, and you must handle it yourself.** It
emits the analyzer findings as they were produced, before the report model
conceals anything, because a machine consumer comparing an excerpt against its
source file needs the real bytes rather than a rendering of them. A raw
bidirectional override therefore *can* appear in `findings[].title`,
`findings[].body`, and `findings[].evidence[].excerpt`. `JSON.stringify`
escapes only control characters below U+0020, so it does not help here. If you
render `--json` output anywhere a person will read it, apply your own
neutralization first.

**Untrusted text reaching the model prompt is canonicalized.** Commit messages
are attacker-controlled on a pull request, and line-terminator injection was
found and closed by giving parsing and rendering one shared definition of a
line break. A residual is recorded in `docs/superpowers/` rather than left
implicit: a crafted commit body can still fabricate a bounded, in-frame extra
record. Closing it properly needs NUL-delimited `git log -z`.

## Supply chain

- Every `uses:` in `action.yml` and in this repository's workflows is pinned to
  a commit SHA, with the version in a trailing comment. Dependabot watches
  those pins so they do not go stale.
- The action installs **in its own checkout**, never in your workspace. No
  script from the repository under review is executed.
- The published npm package ships its build, so no lifecycle script runs on
  install.
- Runtime dependencies are `@anthropic-ai/sdk`, `pdfkit`, and `typescript`.
