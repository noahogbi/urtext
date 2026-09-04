# Changelog

Notable changes to urtext. Versions follow [semantic versioning](https://semver.org/);
dates are the release date.

## Unreleased

### Added

- **A seventh analyzer: lockfile.** Deterministic, `verified`-tier facts from
  `package-lock.json`, checked against `package.json` and against its own previous state. Runs
  on every review, `--no-llm` included.

  A lockfile the manifest disagrees with is the finding that matters most: `npm ci` refuses to
  install from a manifest and lockfile that disagree, so it ranks above every dependency finding
  from the manifest itself. A resolved version — what a clean install actually gets, as opposed
  to the range package.json declares — is its own finding, separate from a declared-range
  change, and a dev-map resolved change still scores below the same change in a runtime map. A
  root `version` field left stale after a manifest bump is reported alongside citation rot,
  since nothing installs differently. Everything else that moved in the transitive tree —
  arrivals, departures, and version changes — is counted in one finding that never outranks a
  finding naming an actual problem, however large the count.

  A lockfile that fails to parse becomes one warning naming the file and side, and the rest of
  the review's findings survive; a nested lockfile pairs with its sibling `package.json` the
  same way the dependencies analyzer already does for nested manifests. An npm-6-era lockfile
  with no root package entry produces its own warning — `package-lock.json has no root package
  entry, so its dependencies were not checked against package.json.` — since there is nothing
  recorded in that older format to check the manifest's ranges against.

- **JavaScript, read by the analyzers that already read this project's TypeScript.** Guards,
  effects, and citations read `.js`, `.mjs`, `.cjs` and `.jsx` unconditionally, the same as
  `.ts`, `.tsx`, `.mts` and `.cts` — each builds its own source file and never consults a
  compiler option. Surface and blast radius read those same JavaScript extensions only when
  the project's own `tsconfig.json` sets `allowJs` or `checkJs`, since both need the type
  checker rather than a file either can parse on its own. Citations also checks comments in
  `.mts` and `.cts` for the first time, closing a gap those two extensions carried on their
  own.

  A changed file whose first line is long enough that a tool plainly wrote it — bundler
  output and the like — is skipped by every analyzer that would otherwise read it, and every
  surface now says so when one is skipped: the terminal, HTML, Markdown, and PDF reports each
  gain a line naming the file, and `--json` gains `coverage.generatedFiles` and
  `coverage.generatedNote`.

  A deleted `.mjs` earns the same disclosure a deleted `.ts` always has: its exports,
  callers, and guards go unexamined, and only the effect that vanished with the file, if
  any, is reported. See the breaking change below: the `--json` key that reports this was
  renamed to carry both languages honestly.

### `--json` additions

- `coverage.generatedFiles` (always present, empty included) and `coverage.generatedNote`.

### `--json` breaking change

- `coverage.deletedTypeScriptFiles` is renamed to `coverage.deletedSourceFiles`. The array
  now lists deleted JavaScript files alongside deleted TypeScript ones, and the old name
  would have been a false claim about its own contents — the same defect class this release
  closes in the analyzers themselves. A consumer reading the old key gets `undefined`.

## 0.4.0 — 2026-09-02

### Added

- **A sixth analyzer: dependencies.** Deterministic, `verified`-tier facts from
  `package.json` — an entry added, removed, or version-changed, in any of the four dependency
  maps. Runs on every review, `--no-llm` included, so unlike the intent-gap index it lands in
  the GitHub Action's default keyless path.

  Runtime maps outrank dev: a change to `dependencies` or `peerDependencies` scores above the
  same change to `devDependencies`, because dev churn is constant and the runtime entry is
  what ships to every consumer. A renamed workspace resolves its manifest's old path, so a
  directory move produces no findings rather than a screen of false additions; an unparseable
  manifest becomes one warning naming the file and side, and the other manifests' facts
  survive. Findings report the manifest's declared constraints only — within a range, the
  lockfile decides what actually resolves, and every report says so once when dependency
  findings are present.

  A brand-new workspace whose `package.json` is untracked is invisible, as all untracked
  files are to `git diff`; the report's untracked-files count covers it.

## 0.3.0 — 2026-08-31

Two disclosures. Both answer the same question from opposite sides: what did this review
*not* establish, and what did it establish only on the model's word?

### Added

- **An index of what the change does not describe.** When the model marks a finding as
  unaccounted for by the range's own commit messages, the mark is collected into one short
  block above the ranked findings — `Not described by this change's messages (3)`. The
  ranked list below is untouched and complete: the index predicts nothing, ranks nothing,
  and reorders nothing outside itself.

  Fact-backed entries come first, model-only entries last. That order deliberately differs
  from the ranked list's, which sorts a claim alleging a problem into the defect band above
  every context finding — correct for triage, wrong for a block a reader scans to decide
  what is checkable. No entry can be `verified`: the mark is something the model says and a
  `verified` finding is one the model said nothing about, so the combination is a
  contradiction rather than a gap. Renders on all five surfaces, and carries the model's
  name when it holds a model-only entry.

  Requires `ANTHROPIC_API_KEY`, since it collects marks the model makes. A keyless run shows
  no index, and the report already states that the model was not asked.

- **Disclosure of the changed files no analyzer reported on.** urtext's code analyzers read
  TypeScript, so a diff of workflow YAML, `package.json`, or SQL migrations was previously
  reviewed in silence — indistinguishable from a clean result. Every review now names those
  files and the share of the diff they represent.

  The note claims non-reporting rather than non-reading, because the citations analyzer
  genuinely does read some non-TypeScript files, and it attributes anything the report says
  about them to the model alone. A file carrying any analyzer finding is excluded by
  construction, so the disclosure can never print above a finding that contradicts it.

  Present on every surface, including `--json` as `coverage.unanalyzedFiles` (always
  present, empty included) and `coverage.unanalyzedNote`.

### `--json` additions

All additive; no existing key changed shape.

- `intentGap` — the index, always present, `[]` when nothing is marked. Each entry carries
  `id`, `tier`, `label`, `file` and `line`; `id` joins back to an entry in `findings`, and
  nothing is removed from `findings` to build it.
- `intentGapAttribution` — present exactly when `intentGap` holds a model-only entry.
- `coverage.unanalyzedFiles` and `coverage.unanalyzedNote`.

## 0.2.0

Released before this changelog was kept. See the git history for the changes it carried.

## 0.1.2

Released before this changelog was kept.
