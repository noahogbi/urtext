import { describe, expect, it } from "vitest";
import { deletedFilesNote, deletedTypeScriptFiles } from "../../src/report/coverage.js";
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
