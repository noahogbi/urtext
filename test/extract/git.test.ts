import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKTREE } from "../../src/types.js";
import { defaultBranch, readAt, resolveRange } from "../../src/extract/git.js";

let repo: string;

// Insulate the temp repo from whatever the developer's global git config
// says: commit signing and a global hooksPath both fail here for reasons
// that have nothing to do with the code under test.
const GIT_ISOLATION = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function run(cmd: string, args: string[]) {
  execFileSync(cmd, [...GIT_ISOLATION, ...args], { cwd: repo, stdio: "pipe" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-git-"));
  run("git", ["init", "-b", "main"]);
  run("git", ["config", "user.email", "test@example.com"]);
  run("git", ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(repo, "adir"));
  writeFileSync(join(repo, "adir", "inner.ts"), "export const inner = 1;\n");
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "first"]);

  // feature adds a file of its own...
  run("git", ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "feat.ts"), "export const feat = 1;\n");
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "feature work"]);

  // ...and main moves on independently, so merge-base(main, feature) is the
  // first commit rather than either tip.
  run("git", ["checkout", "main"]);
  writeFileSync(join(repo, "main-only.ts"), "export const m = 1;\n");
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "main moved on"]);

  run("git", ["checkout", "feature"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

function rev(ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: repo })
    .toString()
    .trim();
}

describe("defaultBranch", () => {
  it("falls back to a local main when no origin exists", async () => {
    expect(await defaultBranch(repo)).toBe("main");
  });

  it("propagates the real error instead of blaming the range when cwd is not a git repository", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "urtext-not-a-repo-"));
    await expect(defaultBranch(notARepo)).rejects.toThrow(
      /not a git repository/,
    );
  });
});

describe("resolveRange", () => {
  it("defaults to merge-base against the default branch, ending at the worktree", async () => {
    const range = await resolveRange(repo);
    expect(range.to).toBe(WORKTREE);
    expect(range.label).toBe("vs main");
    expect(range.from).toMatch(/^[0-9a-f]{40}$/);
  });

  it("accepts an explicit two-dot range", async () => {
    const range = await resolveRange(repo, "main..feature");
    expect(range.label).toBe("main..feature");
    expect(range.to).not.toBe(WORKTREE);
  });

  it("takes a two-dot range literally, from the left revision", async () => {
    const range = await resolveRange(repo, "main..feature");
    expect(range.from).toBe(rev("main"));
    expect(range.to).toBe(rev("feature"));
  });

  it("resolves a three-dot range from the merge-base, not the left tip", async () => {
    const range = await resolveRange(repo, "main...feature");
    const mergeBase = execFileSync("git", ["merge-base", "main", "feature"], {
      cwd: repo,
    })
      .toString()
      .trim();
    expect(range.from).toBe(mergeBase);
    expect(range.from).not.toBe(rev("main"));
    expect(range.to).toBe(rev("feature"));
    expect(range.label).toBe("main...feature");
  });

  it("treats an omitted right side of a three-dot range as HEAD", async () => {
    const range = await resolveRange(repo, "main...");
    expect(range.from).toBe(
      execFileSync("git", ["merge-base", "main", "HEAD"], { cwd: repo })
        .toString()
        .trim(),
    );
    expect(range.to).toBe(rev("HEAD"));
  });
});

describe("resolveRange when a revision does not resolve", () => {
  // The defect these pin: resolveRange handed rev-parse's rejection straight
  // to the CLI's error printer, so a user who typed a range this repository
  // does not have was answered with "Command failed: git rev-parse ...".
  // That names the tool's internals instead of the reader's problem, and it
  // is the first thing anyone meets on a shallow or single-commit clone.
  // The revision is spelled without its numeral in these comments because
  // this repository's comment contract reads a bare small integer as a
  // restated constant.

  /** No user-facing range error may be a git command line. */
  function expectNoLeak(message: string): void {
    expect(message).not.toContain("Command failed");
    expect(message).not.toMatch(/\bgit (rev-parse|merge-base)\b/);
  }

  it("names the missing revision instead of the git command that failed", async () => {
    const err = await resolveRange(repo, "no-such-rev").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expectNoLeak(message);
    expect(message).toContain("no-such-rev");
  });

  it("names the left revision of a two-dot range, not the right one", async () => {
    const err = await resolveRange(repo, "no-such-left..main").catch((e: unknown) => e);
    const message = (err as Error).message;
    expectNoLeak(message);
    expect(message).toContain("no-such-left");
    expect(message).not.toContain("main");
  });

  it("names the right revision of a two-dot range, not the left one", async () => {
    const err = await resolveRange(repo, "main..no-such-right").catch((e: unknown) => e);
    const message = (err as Error).message;
    expectNoLeak(message);
    expect(message).toContain("no-such-right");
  });

  it("explains a parent reference with the history's length only when that is why it failed", async () => {
    // A single-commit repository genuinely has no parent, and saying so
    // answers `HEAD~n`. It answers nothing about a mistyped branch name —
    // there, the sentence is a true fact about the repository offered as a
    // false explanation, which is the shape of wrongness this project exists
    // to refuse. The clause is earned by the revision, not by the failure.
    const solo = mkdtempSync(join(tmpdir(), "urtext-solo-"));
    const runIn = (args: string[]) =>
      execFileSync("git", [...GIT_ISOLATION, ...args], { cwd: solo, stdio: "pipe" });
    runIn(["init", "-b", "main"]);
    runIn(["config", "user.email", "test@example.com"]);
    runIn(["config", "user.name", "Test"]);
    writeFileSync(join(solo, "a.ts"), "export const a = 1;\n");
    runIn(["add", "-A"]);
    runIn(["commit", "-m", "root"]);

    const parent = await resolveRange(solo, "HEAD~1").catch((e: unknown) => e);
    expect((parent as Error).message).toMatch(/single commit|no parent/i);

    const typo = await resolveRange(solo, "no-such-branch").catch((e: unknown) => e);
    const message = (typo as Error).message;
    expectNoLeak(message);
    expect(message).toContain("no-such-branch");
    expect(message).not.toMatch(/single commit|no parent/i);
  });

  it("names the missing revision of a three-dot range rather than reporting no common ancestor", async () => {
    // Both failures reach the same merge-base call, so without verifying the
    // named revisions first this would blame the histories for a typo.
    const err = await resolveRange(repo, "main...no-such-rev").catch((e: unknown) => e);
    const message = (err as Error).message;
    expectNoLeak(message);
    expect(message).toContain("no-such-rev");
    expect(message).not.toMatch(/common ancestor/i);
  });
});

describe("readAt", () => {
  it("reads committed content at a revision", async () => {
    expect(await readAt(repo, "main", "a.ts")).toBe("export const a = 1;\n");
  });

  it("reads uncommitted content from the worktree", async () => {
    expect(await readAt(repo, WORKTREE, "a.ts")).toBe("export const a = 2;\n");
  });

  it("reads the worktree from a subdirectory, resolving paths against the repo root", async () => {
    // Diff paths are repository-root-relative. Joining them onto the caller's
    // directory instead read nothing, and every file looked deleted.
    expect(await readAt(join(repo, "adir"), WORKTREE, "a.ts")).toBe(
      "export const a = 2;\n",
    );
    expect(await readAt(join(repo, "adir"), "main", "a.ts")).toBe(
      "export const a = 1;\n",
    );
  });

  it("returns null for a file absent at that revision", async () => {
    expect(await readAt(repo, "main", "nope.ts")).toBeNull();
  });

  it("propagates a non-absence read error from the worktree instead of returning null", async () => {
    await expect(readAt(repo, WORKTREE, "adir")).rejects.toThrow();
  });

  it("propagates a non-absence error from git instead of returning null", async () => {
    await expect(readAt(repo, "not-a-real-rev", "a.ts")).rejects.toThrow();
  });
});
