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
