# Releasing

A maintainer checklist. It exists because two of these steps were missed
before it did: the lockfile's own version field went stale across three
releases, and `v1` — the moving major tag every action consumer resolves —
sat still for eighty-six commits and two releases because nothing in the
process moved it.

Neither was caught by CI, and neither could be. CI checks the commit in front
of it; both of these are about the things a release is supposed to move and
quietly did not.

## Before

1. **`master` is green.** Not the pull request that just merged — `master`
   itself, after the merge.
2. **The CHANGELOG's Unreleased section is complete.** It is written with each
   feature rather than at release time, so this is a read-through, not a
   drafting session. Every user-facing change since the last release should
   already be there, breaking changes included and marked.

## The release commit

Branch — `release/X.Y.Z`. Changes reach `master` through a pull request here
as everywhere else.

3. **Date the CHANGELOG heading.** `## Unreleased` becomes
   `## X.Y.Z — YYYY-MM-DD`.
4. **Bump `package.json`.** This project is pre-1.0, so a minor bump carries
   breaking changes; say so in the CHANGELOG rather than in the version.
5. **Sync `package-lock.json`.** Two fields: the root `version` and
   `packages[""].version`. This is what npm itself writes, and skipping it is
   the drift that went unnoticed from 0.2.0 to 0.5.0.

   Do it by hand, or with `npm install --package-lock-only`. By hand is
   safer — it touches exactly two lines and cannot re-resolve a dependency as
   a side effect. Check the diff either way: a release commit should change
   version strings and nothing else.

   urtext reports this drift itself now. A manifest bumped without its
   lockfile makes this repository the first thing its own
   `lockfile_version_stale` finding fires on.
6. **Run the gates locally**: `npx tsc --noEmit`, `npm test`, `npm run build`.

   Do not chain these through a pipe. `npm test | tail` reports the exit
   status of `tail`, so a failing suite passes silently.
7. **Open the pull request, wait for CI, merge.**

## The tag

8. **Tag the merge commit**, annotated, `vX.Y.Z`. The publish workflow's filter
   is `v*.*.*` — two dots — so it fires for this and not for the interface tag
   below.
9. **Push it.** `publish.yml` then verifies the tag agrees with
   `package.json`, re-runs every gate, and calls `npm stage publish`.

   It **stages**. The trusted publisher grants this workflow permission to
   stage a release, not to put one live: publishing is the only irreversible
   step in the pipeline, so it waits for a human.
10. **Approve the staged release on npmjs.com** with 2FA.
11. **Verify it went live**: `npm view urtext version`.

## Move `v1`

12. **Re-point `v1` to `master`** — annotated, force-pushed. This is the step
    that has no automation and no alarm, and the one this document was written
    for.

    `uses: noahogbi/urtext@v1` resolves to whatever this tag points at, and the
    action is a composite that builds from its own checked-out source. A stale
    `v1` therefore means every consumer runs stale analyzers, silently, while
    npm serves the current release. That is exactly what happened between 0.3.0
    and 0.5.0.

13. **Check `action.yml` first.** If it changed since the last `v1`, moving the
    tag changes the interface consumers configure against, and that is a v2,
    not a v1 move.
14. **Confirm the publish workflow did not fire** on the tag push. It should
    not: `v1` has one dot and the filter wants two. That filter is the only
    thing standing between an interface-tag move and a republished npm package.

## Do not attach assets to a GitHub release

Not without signing them. Scorecard's Signed-Releases check is currently
excluded — it reports no applicable releases and scores `-1`, which is left out
of the average entirely. Unsigned assets would include it at zero against a
weight of 7.5, taking the published score down by roughly half a point.

Releasing through npm, as this project does, keeps that check excluded.

## Afterwards

15. Delete the release branch and prune.
16. The next change to `master` opens a fresh `## Unreleased` section.
