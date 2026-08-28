import { isTypeScriptFile } from "../extract/symbols.js";
import type { Changeset } from "../types.js";

/**
 * What the analyzers did not look at, stated the same way on all three
 * surfaces: the terminal's note, the HTML report's header, and `--json`'s
 * `coverage` field, which `review` in `../cli.ts` fills from here. `--json`
 * carried nothing at all until it did, so the one consumer that cannot read
 * prose was the one left blind to the gap.
 *
 * Lives in its own module because both renderers need it and neither may import
 * the other, and because a sentence making a claim about analyzer coverage has
 * to be checked in one place — the copy that lived in both renderers was wrong
 * in both.
 */

/** Deleted TypeScript files in this range, in the order the diff listed them. */
export function deletedTypeScriptFiles(changeset: Changeset): string[] {
  return changeset.files
    .filter((f) => f.status === "deleted" && isTypeScriptFile(f.path))
    .map((f) => f.path);
}

/**
 * What a reader is owed about a deleted TypeScript file, and no more than is
 * true. `guardsAnalyzer` and `surfaceAnalyzer` skip a file whose status is
 * "deleted", `blastRadiusAnalyzer` skips it too, and `mapSymbols` returns no
 * symbols for one — so its exports, its callers, and its guards go unexamined,
 * and without a word about it a reader cannot tell that gap from "nothing in it
 * was worth reporting".
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
      ? "1 deleted TypeScript file"
      : `${paths.length} deleted TypeScript files`;
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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
