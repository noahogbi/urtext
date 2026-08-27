import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runAnalyzers } from "../../src/analyze/index.js";
import { createContext, extract, repoRoot } from "../../src/extract/index.js";
import { REPORT_DIR } from "../../src/types.js";

// Keep the developer's global git config out of these repos: commit signing
// or a global core.hooksPath would fail here for reasons unrelated to the
// code under test.
const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function gitIn(cwd: string, args: string[]) {
  execFileSync("git", [...ISOLATION, ...args], { cwd, stdio: "pipe" });
}

function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitIn(dir, ["init", "-b", "main"]);
  gitIn(dir, ["config", "user.email", "test@example.com"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  return dir;
}

let repo: string;

function run(args: string[]) {
  gitIn(repo, args);
}

beforeAll(() => {
  repo = newRepo("urtext-extract-");
  writeFileSync(
    join(repo, "svc.ts"),
    "export function load(id: string) {\n  return id;\n}\n",
  );
  writeFileSync(join(repo, "notes.md"), "hello\n");
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);

  writeFileSync(
    join(repo, "svc.ts"),
    "export function load(id: string) {\n  return fetch(id);\n}\n",
  );
  writeFileSync(join(repo, "notes.md"), "hello there\n");
});

describe("extract", () => {
  it("returns changed files with hunks", async () => {
    const cs = await extract(repo);
    expect(cs.range.label).toBe("vs main");
    expect(cs.files.map((f) => f.path).sort()).toEqual(["notes.md", "svc.ts"]);
    expect(cs.files.find((f) => f.path === "svc.ts")!.hunks.length).toBeGreaterThan(0);
  });

  it("attaches symbols to TypeScript files only", async () => {
    const cs = await extract(repo);
    const ts = cs.files.find((f) => f.path === "svc.ts")!;
    const md = cs.files.find((f) => f.path === "notes.md")!;
    expect(ts.symbols.map((s) => s.name)).toContain("load");
    expect(md.symbols).toEqual([]);
  });

  it("reports untracked files as a count without adding them to the changeset", async () => {
    const dir = newRepo("urtext-untracked-");
    writeFileSync(join(dir, "svc.ts"), "export const a = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(join(dir, "svc.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "brand-new.ts"), "export const n = fetch('u');\n");

    const cs = await extract(dir);
    expect(cs.files.map((f) => f.path)).toEqual(["svc.ts"]);
    expect(cs.untrackedCount).toBe(1);
  });

  it("does not count urtext's own reports as untracked files it failed to review", async () => {
    const dir = newRepo("urtext-own-reports-");
    writeFileSync(join(dir, "svc.ts"), "export const a = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(join(dir, "svc.ts"), "export const a = 2;\n");
    // What two earlier reviews would have left behind in a repository whose
    // .gitignore does not cover the report directory.
    mkdirSync(join(dir, REPORT_DIR), { recursive: true });
    writeFileSync(join(dir, REPORT_DIR, "review-1.html"), "<!doctype html>");
    writeFileSync(join(dir, REPORT_DIR, "review-2.html"), "<!doctype html>");

    expect((await extract(dir)).untrackedCount).toBe(0);

    // A real untracked file still counts, so this is a prefix exclusion and
    // not a disabled count.
    writeFileSync(join(dir, "brand-new.ts"), "export const n = 1;\n");
    expect((await extract(dir)).untrackedCount).toBe(1);
  });
});

describe("extract from a subdirectory", () => {
  // git emits repository-root-relative paths whatever directory it runs in.
  // Resolving them against process.cwd() instead read nothing on the after
  // side, so every effect in every file looked removed.
  let dir: string;

  beforeAll(() => {
    dir = newRepo("urtext-subdir-");
    mkdirSync(join(dir, "pkg", "sub"), { recursive: true });
    writeFileSync(
      join(dir, "pkg", "sub", "svc.ts"),
      "export function load(id: string) {\n  return id;\n}\n",
    );
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(
      join(dir, "pkg", "sub", "svc.ts"),
      "export function load(id: string) {\n  return fetch(id);\n}\n",
    );
  });

  it("reads the changed file's content when run from inside the tree", async () => {
    const cs = await extract(join(dir, "pkg", "sub"));
    expect(cs.files.map((f) => f.path)).toEqual(["pkg/sub/svc.ts"]);
    // Symbols only exist if both sides were actually read.
    expect(cs.files[0].symbols.map((s) => s.name)).toContain("load");
    expect(cs.files[0].symbols.every((s) => s.change !== "removed")).toBe(true);
  });

  it("does not invent removed effects when run from a subdirectory", async () => {
    const cwd = join(dir, "pkg", "sub");
    const cs = await extract(cwd);
    // createContext (like cli.ts) expects a repository root, not an
    // arbitrary cwd: programAt() joins repo-relative paths straight onto
    // it, so a subdirectory would double up the prefix.
    const root = await repoRoot(cwd);
    const facts = await runAnalyzers(cs, createContext(root, cs.range));
    expect(facts.map((f) => f.kind)).toContain("effect_added");
    expect(facts.every((f) => f.file === "pkg/sub/svc.ts")).toBe(true);
  });
});

describe("extract with a three-dot range", () => {
  // `A...B` is merge-base(A, B)..B. Treating it as `A..B` reports everything
  // A gained since the fork as though B had reverted it.
  let dir: string;

  beforeAll(() => {
    dir = newRepo("urtext-threedot-");
    writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);

    gitIn(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "feat.ts"), "export const f = fetch('u');\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "feature work"]);

    gitIn(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "main-only.ts"), "export const m = fetch('v');\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "main moved on"]);
    gitIn(dir, ["checkout", "feature"]);
  });

  it("describes only what the branch changed", async () => {
    const cs = await extract(dir, "main...feature");
    expect(cs.files.map((f) => f.path)).toEqual(["feat.ts"]);
  });

  it("still takes a two-dot range literally", async () => {
    const cs = await extract(dir, "main..feature");
    expect(cs.files.map((f) => f.path).sort()).toEqual([
      "feat.ts",
      "main-only.ts",
    ]);
  });

  it("claims no effect was removed from a file the branch never touched", async () => {
    const cs = await extract(dir, "main...feature");
    const facts = await runAnalyzers(cs, createContext(dir, cs.range));
    expect(facts.some((f) => f.file === "main-only.ts")).toBe(false);
    expect(facts.some((f) => f.kind === "effect_removed")).toBe(false);
  });
});

describe("extract with a non-ASCII path", () => {
  // git quotes such paths as "a/caf\303\251.ts" by default, which the diff
  // header regex cannot read; the unnamed entry then took the whole run down.
  const name = "café.ts";
  let dir: string;

  beforeAll(() => {
    dir = newRepo("urtext-unicode-");
    writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(join(dir, name), "export const c = fetch('u');\n");
    gitIn(dir, ["add", "-A"]);
  });

  it("parses the file instead of aborting the review", async () => {
    const cs = await extract(dir);
    expect(cs.files.map((f) => f.path)).toEqual([name]);
    expect(cs.files[0].status).toBe("added");
    expect(cs.files[0].symbols.map((s) => s.name)).toContain("c");
  });

  it("still finds the effect it introduces", async () => {
    const cs = await extract(dir);
    const facts = await runAnalyzers(cs, createContext(dir, cs.range));
    expect(facts.map((f) => f.file)).toEqual([name]);
    expect(facts[0].kind).toBe("effect_added");
  });
});
