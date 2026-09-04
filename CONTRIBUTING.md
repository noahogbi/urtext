# Contributing

urtext is a single-maintainer project. That shapes what follows more than any
style preference does: expect a first response within a week rather than within
a day, and expect a pull request to be read closely rather than quickly.

## Where to start

- **A wrong finding, bad model output, or a crash** — [open an
  issue](https://github.com/noahogbi/urtext/issues). A review that stated
  something it could not support is the most useful bug this project receives,
  so please include the range you reviewed and what it printed.
- **A vulnerability** — do not open an issue. [SECURITY.md](SECURITY.md) has the
  private channel and what urtext can actually reach, which bounds what a
  vulnerability here could cost you.
- **A feature** — open an issue before writing code. The scope sentence in the
  README is deliberate and defended, and the fastest way to have work rejected
  is to widen it without agreeing on that first.

## The bar

Every claim urtext prints carries an evidence tier, and the `verified` tier
means a reader can check the claim themselves. That is the whole product, and
it sets the bar for changes to it: a finding the code cannot support is worse
than no finding at all, because it spends the reader's trust on something that
is not there.

Two consequences worth stating before you write anything:

- **A comment that describes behaviour is a claim.** If it says what the code
  does, it has to be true after your change, not merely true when it was
  written.
- **Verifying a citation points at the right line is not the same as verifying
  the claim about that line is true.** Both are required.

## Making a change

1. **Branch.** Changes reach `master` through a pull request, never a direct
   push. This is not ceremony — a direct push skips the CI gate below, and the
   maintainer's own admin rights let one through with nothing but a warning.
2. **Write the test first.** See the test policy below.
3. **Commit** with a conventional prefix — `feat:`, `fix:`, `docs:`, `test:`,
   `refactor:`, `ci:`, `chore:` — and a scope where one helps (`fix(test):`).
   The body is for why, not what; the diff already says what.
4. **Open a pull request.** CI runs on it, and so does urtext itself: this
   repository reviews its own pull requests, so you will get a review from the
   tool you are changing.

## What CI enforces

Every pull request runs, on both `ubuntu-latest` and `windows-latest`:

- `npx tsc --noEmit` — the project builds with `noUnusedLocals`, so an orphaned
  import is an error, not a warning.
- `npx vitest run` — the whole suite.
- `npm run build`, followed by a smoke test of the built binary. The built
  artifact is what an install ships, so it is exercised rather than assumed.

CodeQL runs as well. All three must be green.

Windows is in the matrix because it is not a formality: this project spawns git
subprocesses constantly, and process creation there is expensive enough that it
has produced real failures Linux never showed.

## The test policy

**New functionality arrives with tests, in the same pull request.** A change
that adds behaviour and no test to hold it is not finished, and will be asked
for one.

The practice this project actually follows, and the reasoning behind it:

- **Write the failing test first, and watch it fail.** A test that has never
  been red has not been shown to test anything. More than one assertion in this
  repository's history passed against a deliberately broken implementation, and
  each was found by breaking the code on purpose rather than by reading it.
- **Assert on the value, not on its shape.** `expect(line).toBeGreaterThan(0)`
  passes when the function under test returns a constant. Assert the line
  number you mean.
- **Prefer driving the real edge to asserting about it.** Where a cap, budget,
  or refusal path exists, spend it for real. Several tests here are slow for
  exactly this reason, and that is the trade being made on purpose.

Tests live in `test/`, mirroring `src/`.

## Two local rules that will surprise you

Both are enforced by tests, so you will meet them as failures rather than as
review comments. Both exist because the defect they catch was reintroduced more
than once.

- **The comment contract.** A comment must not hand-copy the value of a named
  tuning constant — write the constant's name instead. A copied number and the
  constant it duplicates drift apart the moment either changes alone; a value
  that appears in exactly one place cannot go stale. The forbidden set is
  derived from the live constants rather than hardcoded, and the scan covers
  `test/` as well as `src/`. See `test/comment-contract.test.ts`.
- **The copy guard.** Report copy must not use the vocabulary of authority —
  `approved`, `allowed`, `forbidden`, `permission`, `unauthorized`,
  `unsanctioned`. urtext reports the divergence between what a change claims
  about itself and what it does, never between what a person sanctioned and
  what was delivered, and one of those words asserts an authority the tool does
  not have. See `test/report/copy-guard.test.ts`.

## Dependencies

Runtime dependencies are added reluctantly and are expected to be argued for in
the issue, not introduced in the pull request that needs them. GitHub Actions
are pinned to a full commit SHA with the version in a trailing comment; a
mutable tag is third-party code entering the build at an address someone else
controls.

## What is out of scope

urtext analyses TypeScript projects. That is a limit, not a roadmap item, and
the README says so on purpose. Proposals to widen it are welcome as issues and
are a positioning decision rather than an implementation one — please do not
open a pull request that assumes the answer.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT Licence](LICENSE) that covers this project.
