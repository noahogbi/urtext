import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isUrtextGitignored,
  openReport,
  reportTimestamp,
  shouldSuggestGitignore,
  writeReport,
  type OpenedProcess,
  type SpawnFn,
} from "../../src/report/write.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Global git config (commit signing, a shared core.hooksPath) has no business
// deciding whether these tests pass — mirrors test/cli.test.ts's ISOLATION.
const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const gitIn = (cwd: string, args: string[]) =>
  execFileSync("git", [...ISOLATION, ...args], { cwd, stdio: "pipe" });

function tempRepo(prefix: string): string {
  const root = tempDir(prefix);
  gitIn(root, ["init", "-q", "-b", "main"]);
  gitIn(root, ["config", "user.email", "test@example.com"]);
  gitIn(root, ["config", "user.name", "Test"]);
  return root;
}

describe("reportTimestamp", () => {
  it("contains no colon, so the filename it feeds is valid on Windows", () => {
    expect(reportTimestamp(new Date("2026-08-17T14:23:05.123Z"))).not.toContain(":");
  });

  it("sorts lexicographically in step with chronological order", () => {
    const earlier = reportTimestamp(new Date("2026-08-17T14:23:05.000Z"));
    const later = reportTimestamp(new Date("2026-08-17T14:23:06.000Z"));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("writeReport", () => {
  it("writes the html under <root>/.urtext/, creating the directory", async () => {
    const root = tempDir("urtext-write-");
    const path = await writeReport(root, "<html>hello</html>");
    expect(dirname(path)).toBe(join(root, ".urtext"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("<html>hello</html>");
  });

  it("names the file review-<timestamp>.html", async () => {
    const root = tempDir("urtext-write-");
    const path = await writeReport(root, "<html></html>");
    expect(path).toMatch(/review-.+\.html$/);
  });

  it("rejects rather than silently succeeding when .urtext exists as a file, not a directory", async () => {
    // Documents the failure mode `review()` in cli.ts must catch and
    // degrade rather than let take down a whole completed review — see
    // `test/cli.test.ts`, "still returns the review's findings when the
    // report fails to write".
    const root = tempDir("urtext-write-");
    writeFileSync(join(root, ".urtext"), "not a directory");
    await expect(writeReport(root, "<html></html>")).rejects.toThrow();
  });
});

describe("isUrtextGitignored", () => {
  it("is false, and writes nothing, when no .gitignore exists", async () => {
    const root = tempRepo("urtext-gitignore-");
    expect(await isUrtextGitignored(root)).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("is false, and leaves the file untouched, when .gitignore does not cover .urtext/", async () => {
    const root = tempRepo("urtext-gitignore-");
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
    expect(await isUrtextGitignored(root)).toBe(false);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules/\ndist/\n");
  });

  it("is true when .gitignore already covers .urtext/", async () => {
    const root = tempRepo("urtext-gitignore-");
    writeFileSync(join(root, ".gitignore"), "build/\n.urtext/\n");
    expect(await isUrtextGitignored(root)).toBe(true);
  });

  // The whole reason this shells out to `git check-ignore` instead of
  // pattern-matching .gitignore's own text: git recognises exclusions that
  // never appear in a root .gitignore at all. Both of the next two would
  // have been (incorrectly) "not covered" under the old text-scanning
  // implementation.
  it("is true when .urtext/ is excluded via .git/info/exclude rather than .gitignore", async () => {
    const root = tempRepo("urtext-gitignore-");
    writeFileSync(join(root, ".git", "info", "exclude"), "*\n.urtext/\n");
    expect(await isUrtextGitignored(root)).toBe(true);
  });

  it("is true when .gitignore covers it only via a glob pattern", async () => {
    const root = tempRepo("urtext-gitignore-");
    writeFileSync(join(root, ".gitignore"), "**/.urtext/\n");
    expect(await isUrtextGitignored(root)).toBe(true);
  });

  it("rejects on a git failure rather than reading it as an answer", async () => {
    // Exit codes other than check-ignore's documented no-match must
    // propagate; `shouldSuggestGitignore` is the caller that absorbs them.
    const root = tempDir("urtext-nogit-");
    await expect(isUrtextGitignored(root)).rejects.toThrow();
  });
});

describe("shouldSuggestGitignore", () => {
  it("suggests when the repository does not ignore .urtext/", async () => {
    const root = tempRepo("urtext-suggest-");
    expect(await shouldSuggestGitignore(root)).toBe(true);
  });

  it("stays quiet when the repository already ignores .urtext/", async () => {
    const root = tempRepo("urtext-suggest-");
    writeFileSync(join(root, ".gitignore"), ".urtext/\n");
    expect(await shouldSuggestGitignore(root)).toBe(false);
  });

  it("suppresses the tip instead of failing the review when git cannot answer", async () => {
    // The tip lookup runs *after* the review succeeded and the report was
    // written. A git failure here (exit 128 — no repository, corruption)
    // used to reject review() at the last step, discarding the completed
    // terminal output while a report sat on disk beside a non-zero exit —
    // the exact report-on-disk/exit-code disagreement the write path is
    // designed to avoid. A plain directory with no repository reproduces,
    // for real, an exit code that is neither answer.
    const root = tempDir("urtext-nogit-");
    expect(await shouldSuggestGitignore(root)).toBe(false);
  });
});

describe("openReport", () => {
  class FakeChild extends EventEmitter implements OpenedProcess {
    unrefCalled = false;
    unref(): void {
      this.unrefCalled = true;
    }
  }

  it("is a no-op when no report was written", () => {
    let called = false;
    const spawnFn: SpawnFn = () => {
      called = true;
      return new FakeChild();
    };
    openReport(undefined, spawnFn);
    expect(called).toBe(false);
  });

  it("spawns the platform opener with the report path and does not block on it", () => {
    let seen: { command: string; args: readonly string[] } | undefined;
    const child = new FakeChild();
    const spawnFn: SpawnFn = (command, args) => {
      seen = { command, args };
      return child;
    };
    openReport("C:\\a report\\review-1.html", spawnFn);
    expect(seen).toBeDefined();
    if (process.platform === "win32") {
      expect(seen!.command).toBe("rundll32");
      expect(seen!.args).toEqual(["url.dll,FileProtocolHandler", "C:\\a report\\review-1.html"]);
    }
    expect(child.unrefCalled).toBe(true);
  });

  it("passes a path containing shell metacharacters through as one inert argv element, not a command line", () => {
    // The vulnerability this guards: `cmd /c start "" <path>` let cmd.exe
    // re-split its own already-built command line, so a report path under a
    // directory named `R&D` opened up to the `&` and then executed
    // whatever followed it as a second command. `spawn`'s argv array has no
    // such second parsing pass — this pins that the path reaches `spawnFn`
    // as a single element, character-for-character, never concatenated into
    // a string another process could re-tokenize.
    let seen: { command: string; args: readonly string[] } | undefined;
    const child = new FakeChild();
    const spawnFn: SpawnFn = (command, args) => {
      seen = { command, args };
      return child;
    };
    const dangerous = "C:\\R&D\\.urtext\\review-1.html";
    openReport(dangerous, spawnFn);
    // The path survives whole, as one array element — nothing split it on
    // the `&`, quoted it, or rebuilt it into a larger string.
    expect(seen!.args).toContain(dangerous);
    // Not a shell: `spawn`'s argv model has no second parsing pass to
    // reinterpret what's inside that element, which is the property that
    // actually closes the hole. `cmd`/`sh`/`bash` are the commands that do.
    expect(["cmd", "sh", "bash"]).not.toContain(seen!.command);
  });

  it("survives an error event from the opener without throwing", () => {
    const child = new FakeChild();
    const spawnFn: SpawnFn = () => child;
    openReport("/tmp/review-1.html", spawnFn);
    // An EventEmitter throws synchronously on an unhandled "error" emit;
    // this only passes if openReport attached a listener of its own.
    expect(() => child.emit("error", new Error("opener missing"))).not.toThrow();
  });
});
