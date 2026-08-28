import { describe, expect, it } from "vitest";
import {
  citationDistributionNote,
  deletedFilesNote,
  deletedTypeScriptFiles,
} from "../../src/report/coverage.js";
import { WORKTREE, type Changeset } from "../../src/types.js";

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
