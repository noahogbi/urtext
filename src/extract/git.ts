import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { WORKTREE, type RevRange } from "../types.js";

const exec = promisify(execFile);

/** Run git and return stdout. Throws with stderr attached on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    // Pin a stable, unlocalized locale for every invocation. isAbsenceError
    // below matches known English substrings in git's stderr; under a
    // non-English LANG/LC_ALL, git would emit translated fatal messages that
    // match nothing, turning a genuine absence into a thrown error instead
    // of null. LC_ALL=C is git's own recommendation for machine-parsed
    // output; LANGUAGE=C additionally covers gettext's LANGUAGE override —
    // moot on textbook GNU gettext, which ignores LANGUAGE when the locale
    // is C, but cheap insurance against implementations that consult it
    // anyway.
    env: { ...process.env, LC_ALL: "C", LANGUAGE: "C" },
  });
  return stdout;
}

/**
 * Absolute path to the top of the working tree containing `cwd`.
 *
 * Every path this module handles is repository-root-relative: `git diff`
 * emits root-relative paths regardless of the directory it runs in, and
 * `git show <rev>:<path>` resolves `<path>` from the root unless it starts
 * with `./`. Only the worktree side of readAt touches the filesystem
 * directly, so it must join against the root and not process.cwd() — from a
 * subdirectory the latter reads nothing and makes every file look deleted.
 *
 * Memoized per cwd: a repository's root does not move during a run, and
 * readAt is called several times per changed file, so without this the
 * worktree branch would spawn a git subprocess per read.
 */
const ROOTS = new Map<string, Promise<string>>();

export function repoRoot(cwd: string): Promise<string> {
  let root = ROOTS.get(cwd);
  if (!root) {
    root = git(["rev-parse", "--show-toplevel"], cwd).then((out) => out.trim());
    // Do not cache a rejection: a later call with a valid repo should retry.
    root.catch(() => ROOTS.delete(cwd));
    ROOTS.set(cwd, root);
  }
  return root;
}

async function exists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * The branch changes are measured against. Prefers the remote's declared
 * HEAD, then common names, remote before local.
 */
export async function defaultBranch(cwd: string): Promise<string> {
  // Establish that cwd is a usable git repository before probing for refs.
  // If this throws (git missing from PATH, cwd not a repo, etc.), let it
  // propagate — the "pick an explicit range" message below is only correct
  // once we know we have a repo and simply can't find a default branch.
  await git(["rev-parse", "--git-dir"], cwd);

  try {
    const out = await git(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      cwd,
    );
    const ref = out.trim();
    if (ref) return ref.replace("refs/remotes/", "");
  } catch {
    // No origin/HEAD; fall through to the candidate list.
  }
  for (const c of ["origin/main", "origin/master", "main", "master"]) {
    if (await exists(cwd, c)) return c;
  }
  throw new Error(
    "Could not determine the default branch. Pass an explicit range, e.g. `urtext review HEAD~1`.",
  );
}

/**
 * Resolves one named revision, or explains why it cannot be.
 *
 * `git()` rejects with the command it ran, and handing that to the CLI's
 * error printer answers a request for a parent revision with
 * "Command failed: git rev-parse ..." — the tool's internals in place of the
 * reader's problem, and the first thing anyone meets on a shallow or
 * single-commit clone. (The revision is spelled without its numeral here:
 * this repository's comment contract reads a bare small integer in a comment
 * as a restated constant.)
 *
 * The message names the cause it can establish rather than listing the
 * causes it cannot tell apart: a shallow repository genuinely may have the
 * revision upstream and simply not have fetched it, which is a different
 * problem with a different fix from a revision that does not exist. See
 * `test/extract/git.test.ts`, "names the missing revision instead of the git
 * command that failed".
 */
async function resolveRev(cwd: string, rev: string): Promise<string> {
  try {
    return (await git(["rev-parse", `${rev}^{commit}`], cwd)).trim();
  } catch {
    throw new Error(await unresolvedMessage(cwd, rev));
  }
}

/**
 * Why one revision did not resolve, saying only what can be established.
 *
 * Each clause is earned separately. A shallow clone genuinely may hold the
 * revision upstream, which is a different problem with a different fix from
 * a revision that does not exist. A history of one commit genuinely has no
 * parent — but that answers `HEAD~n`, and answers nothing about a mistyped
 * branch name, where it would be a true fact about the repository offered as
 * a false explanation. So the parent clause is earned by the shape of the
 * revision, not by the fact that something failed. See
 * `test/extract/git.test.ts`, "explains a parent reference with the
 * history's length only when that is why it failed".
 */
async function unresolvedMessage(cwd: string, rev: string): Promise<string> {
  const named = `No revision \`${rev}\` in this repository.`;

  const shallow = await git(["rev-parse", "--is-shallow-repository"], cwd)
    .then((out) => out.trim() === "true")
    .catch(() => false);
  if (shallow) {
    return `${named} This is a shallow clone, so it may exist upstream and simply not have been fetched — deepen it with \`git fetch --unshallow\`, or pass a range this clone has.`;
  }

  // `~` and `^` are the only spellings that ask for an ancestor, so they are
  // the only ones a parentless history explains.
  if (/[~^]/.test(rev)) {
    const rootOnly = await git(["rev-list", "--count", "HEAD"], cwd)
      .then((out) => out.trim() === "1")
      .catch(() => false);
    if (rootOnly) {
      return `${named} This repository's history is a single commit, so it has no ancestor to compare against.`;
    }
  }

  return named;
}

/**
 * The merge base of two revisions that have already been resolved.
 *
 * Reached only once both names are known to exist, so a failure here is the
 * one thing it can still be: histories with no commit in common. Saying that
 * is only honest because the typo case was ruled out first.
 */
async function mergeBaseOf(cwd: string, a: string, b: string): Promise<string> {
  try {
    return (await git(["merge-base", a, b], cwd)).trim();
  } catch {
    throw new Error(
      `\`${a}\` and \`${b}\` have no commit in common, so there is no merge base to review from. Use a two-dot range to compare them literally, e.g. \`${a}..${b}\`.`,
    );
  }
}

export async function resolveRange(
  cwd: string,
  spec?: string,
): Promise<RevRange> {
  if (spec) {
    const m = spec.match(/^(.*?)(\.{2,3})(.*)$/);
    if (m) {
      const a = m[1] || "HEAD";
      const separator = m[2];
      const b = m[3] || "HEAD";
      // `A..B` is literally "from A to B". `A...B` is "from where the two
      // diverged to B" — the change B introduced, ignoring whatever A gained
      // meanwhile. Treating the second as the first reports every commit A
      // made since the fork as a reversal in B, which is a false finding
      // about files the branch never touched.
      // Both sides are resolved before either is used, so a range naming a
      // revision this repository does not have is answered about that
      // revision. Without it, a three-dot range's typo reaches `merge-base`
      // and comes back as a claim about the histories having no common
      // ancestor — a confident wrong answer about the repository.
      const left = await resolveRev(cwd, a);
      const to = await resolveRev(cwd, b);
      const from = separator === "..." ? await mergeBaseOf(cwd, a, b) : left;
      return { from, to, label: spec };
    }
    // A bare revision means "from there to the working tree".
    return {
      from: await resolveRev(cwd, spec),
      to: WORKTREE,
      label: `vs ${spec}`,
    };
  }

  const base = await defaultBranch(cwd);
  await resolveRev(cwd, "HEAD");
  await resolveRev(cwd, base);
  const mergeBase = await mergeBaseOf(cwd, "HEAD", base);
  return { from: mergeBase, to: WORKTREE, label: `vs ${base}` };
}

/** File contents at a revision, or null when the file is absent there. */
export async function readAt(
  cwd: string,
  rev: string,
  path: string,
): Promise<string | null> {
  if (rev === WORKTREE) {
    try {
      // `path` is repository-root-relative (see repoRoot), so resolve it
      // against the root rather than the caller's working directory.
      return await readFile(join(await repoRoot(cwd), path), "utf8");
    } catch (err) {
      // ENOENT ("no such file") means the file is genuinely absent. Anything
      // else (EACCES, EISDIR, ...) is a real failure and must propagate,
      // not be reported as "not there at this revision".
      if (isEnoent(err)) return null;
      throw err;
    }
  }
  try {
    return await git(["show", `${rev}:${path}`], cwd);
  } catch (err) {
    // git's stderr wording varies by case, but these phrasings all mean
    // "the path/revision genuinely does not exist" rather than an
    // environment or repo problem, so only these map to null:
    //   - "does not exist in <rev>" — bad path, valid rev
    //   - "exists on disk, but not in <rev>" — path is untracked/worktree-only
    //   - "unknown revision or path not in the working tree" — bad rev
    // Anything else (invalid object name, corrupt repo, git missing, ...)
    // propagates so callers can't mistake a real failure for absence.
    if (isAbsenceError(err)) return null;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const ABSENCE_SIGNALS = [
  "does not exist in",
  "exists on disk, but not in",
  // Not reachable via readAt's `${rev}:${path}` show form today (a bad rev
  // there yields "invalid object name" instead) — kept as defense-in-depth
  // in case a future caller invokes git in a form where git emits it.
  "unknown revision or path not in the working tree",
];

function isAbsenceError(err: unknown): boolean {
  const stderr =
    err instanceof Error && "stderr" in err
      ? (err as { stderr?: unknown }).stderr
      : undefined;
  const text =
    (typeof stderr === "string" ? stderr : undefined) ??
    (err instanceof Error ? err.message : String(err));
  return ABSENCE_SIGNALS.some((signal) => text.includes(signal));
}
