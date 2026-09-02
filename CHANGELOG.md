# Changelog

Notable changes to urtext. Versions follow [semantic versioning](https://semver.org/);
dates are the release date.

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
