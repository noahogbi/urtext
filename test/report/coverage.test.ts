import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { review } from "../../src/cli.js";
import {
  citationDistributionNote,
  deletedFilesNote,
  deletedTypeScriptFiles,
  generatedFiles,
  generatedFilesNote,
  unanalyzedFiles,
  unanalyzedFilesNote,
} from "../../src/report/coverage.js";
import {
  WORKTREE,
  type Changeset,
  type EvidenceRef,
  type Finding,
  type Tier,
} from "../../src/types.js";

/**
 * A finding anchored on `file`, carrying evidence on every path in `refs`.
 * `refs` defaults to the anchor alone; the multi-ref case exists because a
 * citation drift quotes the cited file as a second ref while anchoring on the
 * citing one, and the rule under test has to see both.
 */
const findingOn = (file: string, tier: Tier, refs: string[] = [file]): Finding => ({
  id: `${tier}:${file}`,
  tier,
  file,
  line: 1,
  title: "title",
  body: "body",
  score: 1,
  evidence: refs.map((f): EvidenceRef => ({ file: f, line: 1, excerpt: "x" })),
});

const changesetWith = (files: Changeset["files"]): Changeset => ({
  range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
  files,
});

describe("deletedTypeScriptFiles", () => {
  it("picks deleted TypeScript files and nothing else", () => {
    const cs = changesetWith([
      { path: "kept.ts", status: "modified", hunks: [], symbols: [] },
      { path: "gone.ts", status: "deleted", hunks: [], symbols: [] },
      { path: "notes.md", status: "deleted", hunks: [], symbols: [] },
      { path: "types.d.ts", status: "deleted", hunks: [], symbols: [] },
      { path: "second.tsx", status: "deleted", hunks: [], symbols: [] },
    ]);
    expect(deletedTypeScriptFiles(cs)).toEqual(["gone.ts", "second.tsx"]);
  });
});

describe("deletedFilesNote", () => {
  it("names every file, in singular and plural", () => {
    expect(deletedFilesNote(["a.ts"])).toContain("1 deleted TypeScript file: a.ts");
    const two = deletedFilesNote(["a.ts", "b.ts"]);
    expect(two).toContain("2 deleted TypeScript files: a.ts, b.ts");
    expect(two).toContain("their exports, callers, and guards are not analyzed");
    expect(deletedFilesNote(["a.ts"])).toContain("its exports, callers, and guards");
  });

  it("does not claim no finding can describe a deleted file", () => {
    // `effectsAnalyzer` reads the before side of a deletion and reports every
    // effect that vanished with the file, so a `verified` finding about a
    // deleted file is a normal outcome. The note used to say "every analyzer
    // skips a deleted file, so nothing below describes what it contained",
    // which could print directly above such a finding — telling a reviewer to
    // disregard a real one. See `test/cli.test.ts`, which proves the two
    // co-occur on a real repository.
    const note = deletedFilesNote(["a.ts"]);
    expect(note).not.toContain("every analyzer");
    expect(note).not.toContain("nothing");
    expect(note).toContain("only effects that vanished with it are reported");
  });
});

describe("generatedFiles", () => {
  it("picks files marked generated and nothing else", () => {
    const cs = changesetWith([
      { path: "bundle.js", status: "added", hunks: [], symbols: [], generated: true },
      { path: "kept.ts", status: "modified", hunks: [], symbols: [] },
    ]);
    expect(generatedFiles(cs)).toEqual(["bundle.js"]);
  });

  it("returns nothing when no file carries the mark", () => {
    const cs = changesetWith([
      { path: "kept.ts", status: "modified", hunks: [], symbols: [] },
    ]);
    expect(generatedFiles(cs)).toEqual([]);
  });
});

describe("generatedFilesNote", () => {
  it("names the one file, in the exact wording the shape justifies", () => {
    expect(generatedFilesNote(["bundle.js"])).toBe(
      "bundle.js is a single line of machine-written JavaScript, so no analyzer read it.",
    );
  });

  it("names every file in the plural", () => {
    const note = generatedFilesNote(["a.js", "b.js"]);
    expect(note).toContain("a.js");
    expect(note).toContain("b.js");
    expect(note).toContain("no analyzer read them");
  });

  it("issues no verdict about the code and none of the six forbidden words", () => {
    // The same register `test/report/copy-guard.test.ts` holds every other
    // reader-facing sentence to.
    const note = generatedFilesNote(["bundle.js"]).toLowerCase();
    for (const word of [
      "unsanctioned",
      "unauthorized",
      "approved",
      "permission",
      "forbidden",
      "allowed",
    ]) {
      expect(note).not.toContain(word);
    }
  });
});

describe("citationDistributionNote", () => {
  // A sweep reports every citation in the repository, and on a
  // documentation-heavy repository nearly all of them land in one directory.
  // The findings are true and the reader still cannot act on most of them,
  // so the note states where they fell. It describes the findings; it does
  // not filter them, and it is not a shortfall — see the model test that it
  // must not reach `notes`.

  it("names the directories findings landed in, largest share first", () => {
    const note = citationDistributionNote([
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
      "src/x.ts",
    ]);
    expect(note).toBeDefined();
    const text = note ?? "";
    expect(text).toContain("4");
    expect(text).toContain("docs/");
    expect(text).toContain("src/");
    // Largest share first, so the concentration is the first thing read.
    expect(text.indexOf("docs/")).toBeLessThan(text.indexOf("src/"));
  });

  it("says so plainly when every finding sits in one directory", () => {
    // The case that motivated this: a sweep where the concentration is the
    // whole story, and a reader who sees a bare count learns nothing about
    // whether the run is worth reading.
    const note = citationDistributionNote(["docs/a.md", "docs/b.md"]);
    expect(note).toContain("docs/");
    expect(note).toMatch(/all|every/i);
  });

  it("counts a repository-root file as its own place rather than inventing a directory", () => {
    const note = citationDistributionNote(["README.md", "src/x.ts"]);
    expect(note).toContain("README.md");
    expect(note).not.toContain("README.md/");
  });

  it("returns undefined for no findings, so a clean sweep composes no note", () => {
    expect(citationDistributionNote([])).toBeUndefined();
  });
});

describe("unanalyzedFiles", () => {
  it("lists changed files no TypeScript analyzer can reach, and no TypeScript file", () => {
    const cs = changesetWith([
      { path: "src/a.ts", status: "modified", hunks: [], symbols: [] },
      { path: "src/b.tsx", status: "added", hunks: [], symbols: [] },
      { path: "package.json", status: "modified", hunks: [], symbols: [] },
      { path: ".github/workflows/publish.yml", status: "added", hunks: [], symbols: [] },
    ]);
    // Diff order, the order `deletedTypeScriptFiles` above documents. Two
    // coverage sentences in one report listing paths by different rules would
    // read as one of them being sorted for a reason.
    expect(unanalyzedFiles(cs, [])).toEqual([
      "package.json",
      ".github/workflows/publish.yml",
    ]);
  });

  it("lists a declaration file, which no analyzer scans in any mode", () => {
    // `isTypeScriptFile` excludes `.d.ts`, and `citationsIn` dispatches on
    // `isProseFile` then `isTypeScriptFile` — so a `.d.ts` is swept into
    // candidates by the `*.ts` pathspec and then scanned by nothing.
    const cs = changesetWith([
      { path: "types.d.ts", status: "modified", hunks: [], symbols: [] },
    ]);
    expect(unanalyzedFiles(cs, [])).toEqual(["types.d.ts"]);
  });

  it("drops a file an analyzer reported on, so the note cannot contradict a finding", () => {
    // The citations analyzer runs on every review, not only under
    // `--citations`: `ANALYZERS` includes it and `--citations` only sets
    // `sweep`. In default mode `touchedCandidates` greps prose for touched
    // basenames, so a changed Markdown file that mentions one is read and
    // scanned, and a rot finding anchors on it (`evidence[0].file` is the
    // citing file). Listing it as unanalyzed would print a disclaimer above a
    // `verified` finding about that same file — the mistake `deletedFilesNote`
    // was rewritten to stop making.
    const cs = changesetWith([
      { path: "docs/plan.md", status: "modified", hunks: [], symbols: [] },
      { path: "package.json", status: "modified", hunks: [], symbols: [] },
    ]);
    const findings = [findingOn("docs/plan.md", "verified")];
    expect(unanalyzedFiles(cs, findings)).toEqual(["package.json"]);
  });

  it("drops a file quoted as secondary evidence, not just the anchor", () => {
    // A citation drift anchors on the citing file and quotes the cited file
    // as a second ref. The cited file's lines are excerpted in the report, so
    // a sentence disclaiming it would sit above its own quoted text.
    const cs = changesetWith([
      { path: "migrations/001_init.sql", status: "modified", hunks: [], symbols: [] },
    ]);
    const findings = [
      findingOn("docs/plan.md", "verified", ["docs/plan.md", "migrations/001_init.sql"]),
    ];
    expect(unanalyzedFiles(cs, findings)).toEqual([]);
  });

  it("keeps a file whose only finding is the model's, which is when the note matters most", () => {
    // Measured: a review of a four-file diff ranked a model-only claim about
    // an unread SQL migration first. A model claim is not an analyzer
    // reporting on the file, so the file stays listed and the note says whose
    // judgement the reader is holding.
    const cs = changesetWith([
      { path: "migrations/102_scoping.sql", status: "added", hunks: [], symbols: [] },
    ]);
    const findings = [findingOn("migrations/102_scoping.sql", "model")];
    expect(unanalyzedFiles(cs, findings)).toEqual(["migrations/102_scoping.sql"]);
  });

  it("leaves deleted TypeScript files to deletedFilesNote", () => {
    const cs = changesetWith([
      { path: "gone.ts", status: "deleted", hunks: [], symbols: [] },
      { path: "gone.yml", status: "deleted", hunks: [], symbols: [] },
    ]);
    expect(unanalyzedFiles(cs, [])).toEqual(["gone.yml"]);
  });
});

describe("unanalyzedFilesNote", () => {
  it("carries its own ratio and names every file", () => {
    const note = unanalyzedFilesNote(["package.json", "ci.yml"], 5);
    expect(note).toContain("2 of 5 changed files");
    expect(note).toContain("package.json");
    expect(note).toContain("ci.yml");
  });

  it("agrees with itself in the singular", () => {
    expect(unanalyzedFilesNote(["package.json"], 3)).toContain("1 of 3 changed files");
  });

  it("claims no analyzer reported, never that the file went unread", () => {
    // The citations analyzer demonstrably reads non-TypeScript files, so
    // "not read" is false. What is true, and what the reader needs, is that
    // nothing mechanical reported on them.
    const note = unanalyzedFilesNote(["package.json"], 2);
    expect(note).not.toMatch(/unread|not read|never read/i);
    expect(note).toContain("No analyzer reported on");
  });

  it("attributes anything said about them to the model rather than claiming silence", () => {
    // The model can and does place findings on these files; a note claiming
    // nothing below describes them would be false exactly when it matters.
    const note = unanalyzedFilesNote(["package.json"], 2);
    expect(note).not.toContain("nothing");
    expect(note).toContain("comes from the model alone");
  });
});

describe("unanalyzedFiles and renames", () => {
  it("does not list a renamed file whose evidence names its old path", () => {
    // A renamed manifest whose only facts are removals carries before-side
    // evidence under its old name; a disclaimer above its own findings is
    // the bug this function exists to avoid.
    const cs = changesetWith([
      {
        path: "pkgs/b/package.json",
        previousPath: "pkgs/a/package.json",
        status: "renamed",
        hunks: [],
        symbols: [],
      },
    ]);
    const f = findingOn("pkgs/a/package.json", "verified");
    expect(unanalyzedFiles(cs, [f])).toEqual([]);
  });
});

describe("the generated-file note, carried through review() into --json", () => {
  // `generatedFilesNote`'s own unit tests above prove the sentence exists;
  // they cannot prove a reader of `--json` ever receives it. `src/cli.ts`
  // composes it into `coverage` separately from this module, and that wiring
  // is exactly what this drives — the real pipeline, not a fabricated model.
  const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

  function gitIn(cwd: string, args: string[]) {
    execFileSync("git", [...ISOLATION, ...args], { cwd, stdio: "pipe" });
  }

  it("names the file and its sentence under coverage.generatedFiles / coverage.generatedNote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "urtext-coverage-generated-"));
    gitIn(dir, ["init", "-b", "main"]);
    gitIn(dir, ["config", "user.email", "test@example.com"]);
    gitIn(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(join(dir, "bundle.js"), `const a=${"x".repeat(400)};\n`);
    gitIn(dir, ["add", "-A"]);

    const r = await review(dir, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.coverage.generatedFiles).toEqual(["bundle.js"]);
    expect(parsed.coverage.generatedNote).toBe(
      "bundle.js is a single line of machine-written JavaScript, so no analyzer read it.",
    );
  });

  it("carries an empty array and no sentence when nothing is generated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "urtext-coverage-not-generated-"));
    gitIn(dir, ["init", "-b", "main"]);
    gitIn(dir, ["config", "user.email", "test@example.com"]);
    gitIn(dir, ["config", "user.name", "Test"]);
    writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-m", "first"]);
    writeFileSync(join(dir, "base.ts"), "export const base = 2;\n");

    const r = await review(dir, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.coverage.generatedFiles).toEqual([]);
    expect(parsed.coverage.generatedNote).toBeUndefined();
  });
});
