import { isSyntacticSource, isTypeScriptFile } from "../extract/symbols.js";
import type { Changeset, Finding } from "../types.js";

/**
 * What the analyzers did not look at, stated the same way on every surface:
 * the terminal's note, the HTML report's header, the Markdown and PDF
 * exports, and `--json`'s `coverage` field, which `review` in `../cli.ts`
 * fills from here. `--json` carried nothing at all until it did, so the one
 * consumer that cannot read prose was the one left blind to the gap.
 *
 * Five surfaces, not the three this comment used to claim: `coverageNote` is
 * printed by `./terminal.ts`, `./html.ts`, `./markdown.ts` and `./pdf.ts`,
 * and a review that trusted the old count wired a new disclosure to two of
 * them. The number is spelled out here because getting it wrong is silent —
 * the exports simply say less than the terminal did, and nothing fails.
 *
 * Lives in its own module because every renderer needs it and none may import
 * another, and because a sentence making a claim about analyzer coverage has
 * to be checked in one place — the copy that lived in two renderers was wrong
 * in both.
 */

/**
 * Deleted source files in this range — TypeScript or JavaScript, whatever
 * `isSyntacticSource` admits — in the order the diff listed them.
 *
 * Named for what it now covers rather than for the language it used to:
 * a deleted `.mjs` loses its effects finding with the file exactly as a
 * deleted `.ts` does, and narrowing this to TypeScript left that loss
 * undisclosed. See `deletedFilesNote` below, whose wording this predicate's
 * widening had to bring along with it.
 */
export function deletedSourceFiles(changeset: Changeset): string[] {
  return changeset.files
    .filter((f) => f.status === "deleted" && isSyntacticSource(f.path))
    .map((f) => f.path);
}

/**
 * What a reader is owed about a deleted source file, and no more than is
 * true. `guardsAnalyzer` and `surfaceAnalyzer` skip a file whose status is
 * "deleted", `blastRadiusAnalyzer` skips it too, and `mapSymbols` returns no
 * symbols for one — so its exports, its callers, and its guards go unexamined,
 * and without a word about it a reader cannot tell that gap from "nothing in it
 * was worth reporting". None of that is TypeScript-specific: every one of
 * those analyzers reads JavaScript too, so a deleted `.mjs` earns the same
 * sentence as a deleted `.ts`.
 *
 * `effectsAnalyzer` is the exception and the reason this sentence was rewritten:
 * it reads the before side of a deletion on purpose (see the `file.status !==
 * "deleted"` condition on its unreadable-after-side guard) and reports every
 * effect kind that vanished with the file. The earlier wording — "every
 * analyzer skips a deleted file, so nothing below describes what it contained"
 * — could therefore print directly above a `verified` finding about that exact
 * file, telling a reviewer to disregard a real one. See
 * `test/report/coverage.test.ts`.
 *
 * Naming a path reports coverage; it asserts nothing about the deleted code.
 */
export function deletedFilesNote(paths: string[]): string {
  const count =
    paths.length === 1
      ? "1 deleted source file"
      : `${paths.length} deleted source files`;
  const subject = paths.length === 1 ? "it" : "them";
  const possessive = paths.length === 1 ? "its" : "their";
  return `${count}: ${paths.join(", ")} — only effects that vanished with ${subject} are reported; ${possessive} exports, callers, and guards are not analyzed.`;
}

/**
 * The one sentence disclosing reconcile's standalone-reach filter, shared by
 * the terminal and HTML renderers so the two surfaces cannot drift apart —
 * the same single-source rule `deletedFilesNote` above exists for. The copy
 * is filter-shaped: it says what was removed from this report and why the
 * filter fired, not anything about the code under review.
 */
export function suppressionNote(count: number): string {
  return `Filtered: ${count} finding${count === 1 ? "" : "s"} suppressed (low-signal: single unclaimed reference).`;
}

/**
 * Where a citation sweep's findings landed, by top-level directory.
 *
 * A sweep checks every citation in the repository, and on a repository whose
 * prose documents itself heavily nearly all of them sit under one directory —
 * measured on a real corpus, 231 of 237. Those findings are true, and a
 * reader still cannot act on most of them, because a citation inside a dated
 * planning document is a record of what was believed then rather than a claim
 * anyone maintains.
 *
 * So the note states the shape of the result. It filters nothing: the
 * findings it describes are all present, and what to do about the
 * concentration is the reader's decision, which `--citations-exclude` exists
 * to carry out.
 *
 * Deliberately NOT a `notes` entry, for the reason `coverageNote` and
 * `filterNote` are not: a complete review is not a partial one, and a banner
 * that fires on every sweep is a banner a reader learns to skip. See
 * `test/report/model.test.ts`, "carries each disclosure exactly once, in the
 * field renderers must read it from".
 */
export function citationDistributionNote(findingFiles: string[]): string | undefined {
  // One entry per citation FINDING, not per distinct file, and the repeats
  // are meant: two rotted citations in one document are two findings, and
  // this sentence counts findings. Deduping would make its total disagree
  // with the report the reader is holding — which would look like tidying.
  const citingFiles = findingFiles;
  if (citingFiles.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const path of citingFiles) {
    const slash = path.indexOf("/");
    // A file at the repository root is its own place. Naming it `README.md/`
    // would invent a directory the repository does not have.
    const place = slash < 0 ? path : `${path.slice(0, slash)}/`;
    counts.set(place, (counts.get(place) ?? 0) + 1);
  }

  const total = citingFiles.length;
  const places = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  if (places.length === 1) {
    return `Citations: all ${plural(total, "finding")} in \`${places[0][0]}\`.`;
  }
  const parts = places.map(([place, n]) => `${n} in \`${place}\``);
  return `Citations: ${plural(total, "finding")} — ${parts.join(", ")}.`;
}

/**
 * Changed files that no analyzer reported on, in the order the diff listed
 * them — the order `deletedSourceFiles` above uses, so two coverage
 * sentences in one report do not list paths by different rules.
 *
 * Two clauses, and the second is the one that took a review to get right.
 *
 * The first is `isTypeScriptFile` alone, which is no longer a gate any
 * analyzer applies uniformly: effects, guards, citations, and extraction now
 * read via `isSyntacticSource`, which admits JavaScript too, and surface and
 * blast radius add JavaScript conditionally, only when the project's own
 * compiler admits it. A TypeScript file is covered by every one of those
 * unconditionally, so this clause excludes it outright and needs no evidence
 * check; a JavaScript file's coverage varies analyzer to analyzer, so it is
 * left as a candidate for the second clause below to resolve rather than
 * assumed covered here. This clause still means a `.d.ts` lists:
 * `isTypeScriptFile` excludes declaration files, and `citationsIn` dispatches
 * on `isProseFile` then `isSyntacticSource`, so a `.d.ts` is swept into
 * candidates by the `*.ts` pathspec and then scanned by nothing at all.
 *
 * The second drops any file carrying evidence for a fact-backed finding.
 * An earlier design of this function took `citationSweep` instead and
 * subtracted `CITATION_PATHSPECS`, on the belief that non-TypeScript files go
 * unread unless `--citations` was passed. Both halves were false.
 * `citationsAnalyzer` is in `ANALYZERS` and runs on every review — `sweep` is
 * only a constructor argument (`../cli.ts`, `makeCitationsAnalyzer`) — and in
 * default mode `touchedCandidates` greps prose for touched basenames, so a
 * changed Markdown file mentioning one is read, scanned, and can anchor a
 * `verified` citation-rot finding on itself. Subtracting pathspecs was wrong
 * in the other direction too: the sweep's real read set is those pathspecs
 * minus `--citations-exclude`, minus `REPORT_DIR`, minus everything past
 * `MAX_CITING_FILES`, minus whatever `citationsIn` declines to dispatch.
 *
 * So this asks what was reported rather than predicting what was read. Every
 * evidence ref counts, not only the anchor: a citation drift anchors on the
 * citing file and quotes the cited file as a second ref, and a sentence
 * disclaiming a file whose lines the report excerpts is the same error.
 *
 * `model`-tier findings deliberately do not count. A model claim is not an
 * analyzer reporting on a file, and the case this exists for is exactly the
 * measured one: a review that ranked a model-only claim about an unread SQL
 * migration first while saying nothing about having read none of it.
 */
export function unanalyzedFiles(changeset: Changeset, findings: Finding[]): string[] {
  const reported = new Set<string>();
  for (const finding of findings) {
    if (finding.tier === "model") continue;
    for (const ref of finding.evidence) reported.add(ref.file);
  }
  // Either of a file's names counts: a renamed manifest whose only facts are
  // removals carries before-side evidence under its old path, and a
  // disclaimer printed above its own findings is the mistake this function
  // exists to avoid.
  return changeset.files
    .filter(
      (f) =>
        !isTypeScriptFile(f.path) &&
        !reported.has(f.path) &&
        !(f.previousPath !== undefined && reported.has(f.previousPath)),
    )
    .map((f) => f.path);
}

/**
 * What a reader is owed about those files, and no more than is true.
 *
 * It claims non-reporting, not non-reading: the citations analyzer
 * demonstrably reads non-TypeScript files, so "unread" would be false. And it
 * does not claim the report is silent about them — the model places findings
 * on exactly these files, which is why the sentence names whose judgement any
 * such finding is rather than telling the reader to disregard it.
 *
 * `total` counts every changed file, deleted source files included. A deleted
 * TypeScript file is excluded by this function's own first clause and so is
 * named by `deletedFilesNote` alone, but a deleted JavaScript file is not —
 * this function narrows only `isTypeScriptFile`, not the wider
 * `isSyntacticSource` that `deletedSourceFiles` uses — and, absent a reported
 * finding, lands in both notes at once. That overlap is deliberate, not a
 * partition this sentence can claim: see `unanalyzedFiles`, "names a deleted
 * JavaScript file too, deliberately overlapping deletedFilesNote". The
 * denominator here is still the size of the diff, not the size of what this
 * sentence owns alone.
 */
export function unanalyzedFilesNote(paths: string[], total: number): string {
  return (
    `No analyzer reported on ${paths.length} of ${total} changed files: ${paths.join(", ")} — ` +
    `anything below about them comes from the model alone.`
  );
}

/**
 * Changed files whose shape says a tool wrote them — see `isMachineWritten`
 * in `../extract/symbols.ts` — minus any file a non-`model`-tier finding's
 * evidence names, in the order the diff listed them.
 *
 * `ChangedFile.generated` is flag-driven, not evidence-driven, and that gap
 * is exactly the bug this subtraction closes: a generated file can still be
 * the cited *target* of a citation finding. `citations.ts` drops it from the
 * citing candidate list, but nothing stops some other file from citing it,
 * and a citation finding quotes the cited file as a second evidence ref. A
 * generated `dist/bundle.js` cited by a changed `README.md` would otherwise
 * be named here — "no analyzer reported on it" — beside a `verified` finding
 * quoting that same file, the identical contradiction `unanalyzedFiles`
 * above exists to prevent. See that function's doc comment for why every
 * evidence ref counts and not only the anchor, and why a `model`-tier
 * finding does not count at all; the reasoning is not repeated here.
 */
export function generatedFiles(changeset: Changeset, findings: Finding[]): string[] {
  const reported = new Set<string>();
  for (const finding of findings) {
    if (finding.tier === "model") continue;
    for (const ref of finding.evidence) reported.add(ref.file);
  }
  return changeset.files
    .filter(
      (f) =>
        f.generated &&
        !reported.has(f.path) &&
        !(f.previousPath !== undefined && reported.has(f.previousPath)),
    )
    .map((f) => f.path);
}

/**
 * What a reader is owed about those files, and no more than `isMachineWritten`
 * can tell.
 *
 * Claims non-reporting, not non-reading — the same distinction
 * `unanalyzedFilesNote` draws for its own files, and for the same reason:
 * the text is still read, to test its shape and, for an imported file under
 * `allowJs`, by the program that resolves it. "Unread" would be false;
 * "not reported on" is what every gate below actually delivers.
 *
 * Also does not say "a single line": `isMachineWritten` measures the length
 * up to the file's first newline (or the whole text when there is none), not
 * how many lines follow it — real bundler output commonly carries a
 * `//# sourceMappingURL=` comment on a second line, and two of this
 * predicate's own test fixtures are themselves multi-line. "Begins with a
 * line long enough" is the claim the measurement actually supports.
 *
 * Currently every gate that checks `ChangedFile.generated`, or calls
 * `isMachineWritten` directly: `effectsAnalyzer`, `guardsAnalyzer`,
 * `surfaceAnalyzer`, `blastRadiusAnalyzer`, the citations candidate pass, and
 * `extract/index.ts`'s own symbol extraction (all read the field);
 * `analyze/program.ts`'s program-root selection (calls the predicate itself,
 * since it never receives a changeset). `surfaceAnalyzer` and
 * `blastRadiusAnalyzer` need their own check — not only the root exclusion —
 * because excluding a file from a program's *roots* leaves it resolvable,
 * and an import under `allowJs` pulls it back into the same program those two
 * analyzers walk. This enumeration is a liability disguised as documentation:
 * an earlier version of it named three of these six and was still accurate
 * prose, right up until a `verified` finding on an imported bundle proved two
 * of them had never been guarded at all. Whoever adds a seventh gate and
 * skips updating this comment reintroduces exactly that gap — undetectably.
 */
export function generatedFilesNote(paths: string[]): string {
  if (paths.length === 1) {
    return `${paths[0]} begins with a line long enough that a tool wrote it, so no analyzer reported on it.`;
  }
  return `${paths.join(", ")} each begin with a line long enough that a tool wrote it, so no analyzer reported on them.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
