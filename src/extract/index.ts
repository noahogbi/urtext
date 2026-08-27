import type ts from "typescript";
import { WORKTREE, type AnalysisContext, type Changeset, type ChangedFile, type RevRange } from "../types.js";
import { createProgramAt } from "../analyze/program.js";
import { countUntracked, diffText, parseUnifiedDiff } from "./diff.js";
import { readAt, repoRoot, resolveRange } from "./git.js";
import { isTypeScriptFile, mapSymbols } from "./symbols.js";

export { resolveRange, readAt, repoRoot } from "./git.js";

export function createContext(cwd: string, range: RevRange): AnalysisContext {
  // Memoized per revision, and only ever built on demand: constructing a
  // program parses every TypeScript file in the repository, so an analyzer
  // that never asks for one must not pay for it.
  const programs = new Map<string, Promise<ts.Program>>();
  return {
    cwd,
    range,
    readAt: (rev, path) => readAt(cwd, rev, path),
    programAt(rev) {
      let program = programs.get(rev);
      if (!program) {
        program = createProgramAt(cwd, rev);
        // Do not cache a rejection: a transient git failure should not
        // poison every later request for this revision.
        program.catch(() => programs.delete(rev));
        programs.set(rev, program);
      }
      return program;
    },
  };
}

export async function extract(
  cwd: string,
  rangeSpec?: string,
): Promise<Changeset> {
  // Everything downstream speaks repository-root-relative paths, so anchor
  // the whole extraction at the root — `urtext review` has to mean the same
  // thing from a subdirectory as it does from the top.
  const root = await repoRoot(cwd);
  const range = await resolveRange(root, rangeSpec);
  const parsed = parseUnifiedDiff(await diffText(root, range));

  const files: ChangedFile[] = [];
  for (const p of parsed) {
    // mapSymbols discards non-TypeScript files anyway; reading them out of
    // git first only pulls lockfiles and binaries into memory as utf8.
    const wanted = isTypeScriptFile(p.path);
    const beforePath = p.previousPath ?? p.path;
    const before =
      !wanted || p.status === "added"
        ? null
        : await readAt(root, range.from, beforePath);
    const after =
      !wanted || p.status === "deleted"
        ? null
        : await readAt(root, range.to, p.path);
    files.push({
      ...p,
      symbols: mapSymbols(p.path, before, after, p.hunks),
    });
  }

  // Untracked files only bear on a comparison that ends at the working tree;
  // between two commits there is nothing to have been left out.
  const untrackedCount =
    range.to === WORKTREE ? await countUntracked(root) : 0;

  return { range, files, untrackedCount };
}
