import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeFact, runAnalyzers, type AnalyzerFailure } from "../../src/analyze/index.js";
import {
  baselineReadsCappedNote,
  blameUnavailableNote,
  citationsCappedNote,
  citingFilesCappedNote,
  findCitationRot,
  makeCitationsAnalyzer,
  MAX_BASELINE_READS,
  MAX_CITING_FILES,
  parseBlame,
  shallowRepositoryNote,
} from "../../src/analyze/citations.js";
import { createContext, extract } from "../../src/extract/index.js";
import { rank, toFinding } from "../../src/score/index.js";
import { WORKTREE, type AnalysisContext, type Changeset } from "../../src/types.js";

// Insulate the temp repo from whatever the developer's global git config
// says: commit signing and a global hooksPath both fail here for reasons
// that have nothing to do with the code under test.
const GIT_ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function makeRepo(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), name));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@e.com"]);
  git(repo, ["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", [...GIT_ISOLATION, ...args], { cwd: repo, stdio: "pipe" }).toString();
}

function write(repo: string, path: string, lines: string[]): void {
  writeFileSync(join(repo, path), lines.join("\n") + "\n");
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
}

/** The scan over the whole repository, which is what every rot case wants. */
async function sweep(repo: string) {
  const cs = await extract(repo);
  return findCitationRot(cs, createContext(repo, cs.range), { sweep: true });
}

/** What git printed — the only part of a failure a disclosure may quote. */
const BLAME_FAILURE = "fatal: no such ref";

/**
 * Shaped like the rejection `git()` really produces. execFile puts a dump of
 * the whole command in `message` — every argument, revision hashes included —
 * and git's own words in `stderr`. A mock that carried the reason in
 * `message` would look identical whichever field the code read, which is
 * exactly how a command dump can reach user-facing copy unnoticed.
 */
function blameRejection(args: string[]): Error {
  return Object.assign(new Error(`Command failed: git ${args.join(" ")}\n${BLAME_FAILURE}\n`), {
    code: 128,
    stderr: `${BLAME_FAILURE}\n`,
  });
}

/**
 * Runs `fn` against a freshly loaded `citations.ts` whose `git` rejects every
 * blame and passes every other invocation through to the real one. The module
 * registry is reset on both sides, so the rest of this file keeps the
 * unmocked module it imported at the top.
 */
async function withBlameFailure<T>(fn: (find: typeof findCitationRot) => Promise<T>): Promise<T> {
  const actual = await vi.importActual<typeof import("../../src/extract/git.js")>(
    "../../src/extract/git.js",
  );
  vi.doMock("../../src/extract/git.js", () => ({
    ...actual,
    git: (args: string[], cwd: string): Promise<string> =>
      args[0] === "blame" ? Promise.reject(blameRejection(args)) : actual.git(args, cwd),
  }));
  vi.resetModules();
  try {
    const mod = await import("../../src/analyze/citations.js");
    return await fn(mod.findCitationRot);
  } finally {
    vi.doUnmock("../../src/extract/git.js");
    vi.resetModules();
  }
}

/** The same, with every git invocation recorded rather than made to fail. */
async function withCountedGit<T>(
  fn: (find: typeof findCitationRot, calls: string[][]) => Promise<T>,
): Promise<T> {
  const actual = await vi.importActual<typeof import("../../src/extract/git.js")>(
    "../../src/extract/git.js",
  );
  const calls: string[][] = [];
  vi.doMock("../../src/extract/git.js", () => ({
    ...actual,
    git: (args: string[], cwd: string): Promise<string> => {
      calls.push(args);
      return actual.git(args, cwd);
    },
  }));
  vi.resetModules();
  try {
    const mod = await import("../../src/analyze/citations.js");
    return await fn(mod.findCitationRot, calls);
  } finally {
    vi.doUnmock("../../src/extract/git.js");
    vi.resetModules();
  }
}

describe("the four rot kinds", () => {
  it("missing_file: the cited file is not there any more", async () => {
    const repo = makeRepo("urtext-rot-missing-");
    write(repo, "src/gone.ts", ["export const gone = 1;"]);
    write(repo, "docs/a.md", ["The rule lives in src/gone.ts:1."]);
    commit(repo, "first");
    git(repo, ["rm", "src/gone.ts"]);
    commit(repo, "delete the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const rots = await sweep(repo);
    const r = rots.find((x) => x.rot === "missing_file")!;
    expect(r).toBeDefined();
    expect(r.citedFile).toBe("src/gone.ts");
    // Anchored on the citing line, which is where the reader's work is.
    expect(r.citingFile).toBe("docs/a.md");
    expect(r.citingLine).toBe(1);
    expect(r.baseline).toBeTruthy();
  });

  it("line_out_of_range: the line number is past the end of the file", async () => {
    const repo = makeRepo("urtext-rot-range-");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    write(repo, "docs/a.md", ["See src/a.ts:3 for the third."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 1;"]);
    commit(repo, "shorten the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "line_out_of_range")!;
    expect(r).toBeDefined();
    expect(r.citedFile).toBe("src/a.ts");
    expect(r.citedLine).toBe(3);
    expect(r.lineCount).toBe(1);
    expect(r.citingLine).toBe(1);
  });

  it("quote_absent: the quoted phrase is not in the file", async () => {
    const repo = makeRepo("urtext-rot-quote-");
    write(repo, "src/a.ts", ["// keeps the door shut", "export const a = 1;"]);
    write(repo, "docs/a.md", ['See `src/a.ts`, "keeps the door shut".']);
    commit(repo, "first");
    write(repo, "src/a.ts", ["// leaves the door open", "export const a = 1;"]);
    commit(repo, "reword the cited comment");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "quote_absent")!;
    expect(r).toBeDefined();
    expect(r.quote).toBe("keeps the door shut");
    expect(r.citedFile).toBe("src/a.ts");
  });

  it("content_drift: the line still exists and no longer says the same thing", async () => {
    const repo = makeRepo("urtext-rot-drift-");
    write(repo, "src/a.ts", ["export const limit = 1;", "export const other = 2;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;", "export const other = 2;"]);
    commit(repo, "change the cited line");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const r = (await sweep(repo)).find((x) => x.rot === "content_drift")!;
    expect(r).toBeDefined();
    expect(r.was).toBe("export const limit = 1;");
    expect(r.now).toBe("export const limit = 99;");
    expect(r.citedText).toBe("export const limit = 99;");
    expect(r.citingFile).toBe("docs/a.md");
  });

  it("reports a re-indent as nothing at all", async () => {
    const repo = makeRepo("urtext-rot-indent-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["    export const limit = 1;"]);
    commit(repo, "re-indent the cited line");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("emits one fact for one citation, not one per test that could fire", async () => {
    // A missing file has no lines to be out of range and no content to have
    // drifted; emitting more than one would be one finding said four ways.
    // The two citations sit on separate lines so that "one per citation" and
    // "one per citing line" are the same count here, and a second fact for
    // either citation shows up as a length of three.
    const repo = makeRepo("urtext-rot-first-wins-");
    write(repo, "src/gone.ts", ["const a = 1;", "const b = 2;"]);
    write(repo, "docs/a.md", [
      "The second one is src/gone.ts:2.",
      "",
      'It also says `src/gone.ts`, "const b = 2".',
    ]);
    commit(repo, "first");
    git(repo, ["rm", "src/gone.ts"]);
    commit(repo, "delete it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const rots = await sweep(repo);
    expect(rots).toHaveLength(2);
    expect(rots.map((r) => r.citingLine).sort()).toEqual([1, 3]);
    expect(rots.every((r) => r.rot === "missing_file")).toBe(true);
  });
});

describe("a range citation", () => {
  /** Four lines, a citation spanning the middle two through the fourth. */
  function rangeRepo(name: string, after: string[]): string {
    const repo = makeRepo(name);
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"]);
    write(repo, "docs/a.md", ["The rule spans src/a.ts:2-4."]);
    commit(repo, "first");
    write(repo, "src/a.ts", after);
    commit(repo, "edit the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);
    return repo;
  }

  it("anchors drift on the range's own first line when that is the line that differs", async () => {
    const repo = rangeRepo("urtext-range-first-", [
      "const a = 1;",
      "const b = 99;",
      "const c = 3;",
      "const d = 4;",
    ]);

    const r = (await sweep(repo)).find((x) => x.rot === "content_drift")!;
    expect(r).toBeDefined();
    expect(r.citedLine).toBe(2);
    expect(r.was).toBe("const b = 2;");
    expect(r.now).toBe("const b = 99;");
    expect(r.citedText).toBe("const b = 99;");
    expect(r.citedEndLine).toBeUndefined();
  });

  it("anchors drift on the middle line that differs, not on the line the range starts at", async () => {
    // The line number and the quoted text must name the same line: a
    // verified finding that points at one line and shows another sends a
    // reader somewhere the finding is not about.
    const repo = rangeRepo("urtext-range-middle-", [
      "const a = 1;",
      "const b = 2;",
      "const c = 99;",
      "const d = 4;",
    ]);

    const r = (await sweep(repo)).find((x) => x.rot === "content_drift")!;
    expect(r).toBeDefined();
    expect(r.citedLine).toBe(3);
    expect(r.was).toBe("const c = 3;");
    expect(r.now).toBe("const c = 99;");
    expect(r.citedText).toBe("const c = 99;");
    expect(r.citedEndLine).toBeUndefined();
  });

  it("reports nothing when the file changed outside the range and every line of the range still reads the same", async () => {
    const repo = rangeRepo("urtext-range-intact-", [
      "const a = 99;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
    ]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("names both ends of the range when the range runs past the end of the file", async () => {
    // line_out_of_range keeps citedEndLine, because there the fact is about
    // the citation's whole span rather than about one line's content.
    const repo = rangeRepo("urtext-range-past-end-", ["const a = 1;", "const b = 2;"]);

    const r = (await sweep(repo)).find((x) => x.rot === "line_out_of_range")!;
    expect(r).toBeDefined();
    expect(r.citedLine).toBe(2);
    expect(r.citedEndLine).toBe(4);
    expect(r.lineCount).toBe(2);
  });
});

describe("a shallow repository", () => {
  it("skips citation checking and says why, rather than dating every citing line to the graft commit", async () => {
    const origin = makeRepo("urtext-shallow-origin-");
    write(origin, "src/a.ts", ["export const limit = 1;"]);
    write(origin, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(origin, "first");
    write(origin, "src/a.ts", ["export const limit = 99;"]);
    commit(origin, "drift the cited line");

    // The full repository does report the drift, so the silence below is a
    // deliberate skip and not an inert fixture.
    expect((await sweep(origin)).filter((r) => r.rot === "content_drift")).toHaveLength(1);

    // The same repository at depth one. `--root` is what suppresses git's
    // boundary marker, so blame here answers for every line — with the
    // graft commit — instead of failing. Nothing downstream can tell that
    // answer from a real one, which is why the skip has to happen up front.
    const clone = mkdtempSync(join(tmpdir(), "urtext-shallow-clone-"));
    execFileSync(
      "git",
      [...GIT_ISOLATION, "clone", "--depth", "1", `file:///${origin.split("\\").join("/")}`, clone],
      { stdio: "pipe" },
    );
    expect(git(clone, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");

    const notes: string[] = [];
    const cs = await extract(clone);
    const rots = await findCitationRot(cs, createContext(clone, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });
    expect(rots).toHaveLength(0);
    expect(notes).toEqual([shallowRepositoryNote()]);
  });
});

describe("CITATION_GUARD_BASELINE — the gate", () => {
  it("says nothing about a citation that never resolved, for missing_file", async () => {
    // The most important test in the suite: it is the one standing between a
    // verified badge and every illustrative path in this repository's own
    // specs.
    const repo = makeRepo("urtext-gate-missing-");
    write(repo, "docs/a.md", ["An example: src/db.ts:14 never existed here."]);
    commit(repo, "first");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("says nothing about a line number that was never in the cited file", async () => {
    const repo = makeRepo("urtext-gate-range-");
    write(repo, "src/a.ts", ["const a = 1;"]);
    write(repo, "docs/a.md", ["See src/a.ts:900, a typo."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 2;"]);
    commit(repo, "touch the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("says nothing about a quote that was never in the cited file", async () => {
    const repo = makeRepo("urtext-gate-quote-");
    write(repo, "src/a.ts", ["// something else entirely"]);
    write(repo, "docs/a.md", ['See `src/a.ts`, "a phrase never present".']);
    commit(repo, "first");
    write(repo, "src/a.ts", ["// something else again"]);
    commit(repo, "touch the cited file");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("misses a drift that predates the citing line's last edit — the documented, intended miss", async () => {
    // Blame gives when the citing line was last TOUCHED, not when the
    // citation was last VERIFIED. This test is named for the miss so nobody
    // later "fixes" it: the failure mode is silence about a rotted citation,
    // never an accusation against a sound one. The third commit rewords the
    // citing line itself — a later commit that left that line's bytes alone
    // would not move blame, and the fixture would prove nothing.
    const repo = makeRepo("urtext-gate-underreport-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "change the cited line");
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1, in passing."]);
    commit(repo, "reword the citing line, resetting the baseline");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });

  it("reads no history for an uncommitted citing line, and discloses nothing", async () => {
    // The citing file is tracked, so the sweep really does open it; only the
    // citing line is new. An untracked file would never be a candidate at
    // all, and a fixture built that way would pass without reaching the code
    // it names.
    //
    // The all-zeros guard's work is invisible in the returned facts: delete
    // it and the all-zeros commit is read anyway, git answers that the path
    // is not in it, `readAt` maps that to null, and the never-resolved gate
    // swallows the citation in silence. So what this pins is the read that
    // must not happen.
    const repo = makeRepo("urtext-gate-uncommitted-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["A committed citation: src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "change the cited line");
    // Written but never committed: as new as the change under review.
    write(repo, "docs/a.md", [
      "A committed citation: src/a.ts:1.",
      "",
      "The limit is set at src/a.ts:1.",
    ]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const base = createContext(repo, cs.range);
    const revs: string[] = [];
    const ctx: AnalysisContext = {
      ...base,
      readAt: (rev, path) => {
        revs.push(rev);
        return base.readAt(rev, path);
      },
    };
    const rots = await findCitationRot(cs, ctx, { sweep: true, onNote: (n) => notes.push(n) });

    // The committed citation on the first line did drift, and its baseline
    // was read — so the recorder demonstrably sees historical reads, and the
    // assertion below is about the uncommitted line rather than about a scan
    // that never ran.
    expect(rots.map((r) => r.citingLine)).toEqual([1]);
    expect(revs.some((rev) => rev !== cs.range.to)).toBe(true);
    expect(revs.filter((rev) => /^0+$/.test(rev))).toEqual([]);
    expect(notes).toHaveLength(0);
  });
});

describe("degradation", () => {
  it("falls back to existence-only checking and discloses it once, whatever the count", async () => {
    const repo = makeRepo("urtext-degrade-");
    write(repo, "docs/a.md", ["Gone: src/gone.ts:1 and src/also-gone.ts:2 and src/third.ts:3."]);
    commit(repo, "first");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const rots = await withBlameFailure((find) =>
      find(cs, createContext(repo, cs.range), { sweep: true, onNote: (n) => notes.push(n) }),
    );

    // Test (a) alone, ungated, so every absent path is reported — the one
    // place a false positive is reachable, disclosed in the same breath.
    expect(rots).toHaveLength(3);
    expect(rots.every((r) => r.rot === "missing_file")).toBe(true);
    // A degraded finding asserts no commit: it has no history to name.
    expect(rots.every((r) => r.baseline === undefined)).toBe(true);
    const blameNotes = notes.filter((n) => n.includes("could not be dated"));
    expect(blameNotes).toHaveLength(1);
    expect(blameNotes[0]).toBe(blameUnavailableNote(3, BLAME_FAILURE));
  });

  it("checks a citation into an untouched file only under sweep when history is unavailable", async () => {
    // One test, both assertions, so the degraded path cannot quietly stop
    // obeying the default mode's cited-path filter — the mode a shallow
    // clone, where blame fails outright, runs in.
    const repo = makeRepo("urtext-degrade-modes-");
    write(repo, "src/kept.ts", ["export const kept = 1;"]);
    write(repo, "docs/a.md", ["Both src/kept.ts:1 and src/gone.ts:1 are cited here."]);
    commit(repo, "first");
    // The reviewed range touches only src/kept.ts; src/gone.ts never existed.
    write(repo, "src/kept.ts", ["export const kept = 2;"]);

    const notes: string[] = [];
    const cs = await extract(repo, "HEAD");
    const ctx = createContext(repo, cs.range);
    const { plain, swept } = await withBlameFailure(async (find) => ({
      plain: await find(cs, ctx, { onNote: (n) => notes.push(n) }),
      swept: await find(cs, ctx, { sweep: true }),
    }));

    expect(plain).toHaveLength(0);
    // Both citations were dated and both failed, so the emptiness above is a
    // filter doing its work rather than a scan that never happened.
    expect(notes).toContain(blameUnavailableNote(2, BLAME_FAILURE));
    expect(swept).toHaveLength(1);
    expect(swept[0].citedFile).toBe("src/gone.ts");
    expect(swept[0].baseline).toBeUndefined();
  });

  it("falls back to existence-only checking once the historical-read budget is spent, still claiming no commit", async () => {
    // Driven over the real edge rather than asserted about: the refusal path
    // is where the baseline-read note's promise — "checked only for whether
    // the cited file exists" — is either kept or quietly broken. The cited
    // files are .json so that none of them is itself a candidate citing
    // file, which keeps the citing-file cap out of this fixture.
    const repo = makeRepo("urtext-degrade-budget-");
    const lines: string[] = [];
    for (let i = 0; i < MAX_BASELINE_READS; i++) {
      const path = `src/c${String(i).padStart(5, "0")}.json`;
      write(repo, path, ['{ "c": true }']);
      lines.push(`One is ${path}:1.`);
    }
    // The citation past the budget, and the only one whose cited file is
    // absent now — so it can only be reported existence-only.
    lines.push("Past the budget: src/never-existed.json:1.");
    write(repo, "docs/a.md", lines);
    commit(repo, "first");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const rots = await findCitationRot(cs, createContext(repo, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });

    expect(rots).toHaveLength(1);
    expect(rots[0].rot).toBe("missing_file");
    expect(rots[0].citedFile).toBe("src/never-existed.json");
    expect(rots[0].citingLine).toBe(MAX_BASELINE_READS + 1);
    expect(rots[0].baseline).toBeUndefined();
    expect(notes).toEqual([baselineReadsCappedNote(1)]);
  });
});

describe("blame", () => {
  it("keeps one commit per final line from --line-porcelain output", () => {
    const out = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2",
      "author T",
      "\tfirst line",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2",
      "author T",
      "\tsecond line",
      "",
    ].join("\n");
    const map = parseBlame(out);
    expect(map.get(1)).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(map.get(2)).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(map.size).toBe(2);
  });

  it("runs one blame per citing file, not one per citation", async () => {
    const repo = makeRepo("urtext-blame-memo-");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    write(repo, "docs/a.md", ["One src/a.ts:1.", "Two src/a.ts:2.", "Three src/a.ts:3."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 9;", "const b = 9;", "const c = 9;"]);
    commit(repo, "change all three");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const cs = await extract(repo);
    const ctx = createContext(repo, cs.range);
    const { rots, calls } = await withCountedGit(async (find, recorded) => ({
      rots: await find(cs, ctx, { sweep: true }),
      calls: recorded,
    }));

    expect(rots.filter((r) => r.rot === "content_drift")).toHaveLength(3);
    // Three citations in one file cost exactly one blame.
    expect(calls.filter((a) => a[0] === "blame")).toHaveLength(1);
  });
});

describe("the two modes", () => {
  it("checks a citation into an unchanged file only under sweep", async () => {
    // One test, both assertions, so the mode boundary cannot half-move.
    const repo = makeRepo("urtext-modes-");
    write(repo, "src/untouched.ts", ["export const limit = 1;"]);
    write(repo, "src/touched.ts", ["export const t = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/untouched.ts:1."]);
    commit(repo, "first");
    write(repo, "src/untouched.ts", ["export const limit = 99;"]);
    commit(repo, "drift the cited line");
    // The reviewed range touches only the other file.
    write(repo, "src/touched.ts", ["export const t = 2;"]);

    const cs = await extract(repo, "HEAD");
    const ctx = createContext(repo, cs.range);
    expect(await findCitationRot(cs, ctx)).toHaveLength(0);
    const swept = await findCitationRot(cs, ctx, { sweep: true });
    expect(swept.filter((r) => r.rot === "content_drift")).toHaveLength(1);
  });

  it("never scans REPORT_DIR, so urtext's own output cannot feed itself", async () => {
    const repo = makeRepo("urtext-reportdir-");
    mkdirSync(join(repo, ".urtext"), { recursive: true });
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, ".urtext/review.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    expect(await sweep(repo)).toHaveLength(0);
  });
});

describe("caps", () => {
  it("emits no note when every cap is clear", async () => {
    const repo = makeRepo("urtext-caps-clear-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    await findCitationRot(cs, createContext(repo, cs.range), {
      sweep: true,
      onNote: (n) => notes.push(n),
    });
    expect(notes).toHaveLength(0);
  });

  it("discloses a bitten citing-file cap with counts that add up, over the prefix of the path order it really scanned", async () => {
    const repo = makeRepo("urtext-caps-files-");
    // Cited from every citing file, and deliberately not one of the
    // extensions the citation pathspecs admit, so the candidate count is the
    // number of docs files and nothing else.
    write(repo, "src/limits.json", ['{ "limit": 1 }']);
    const extra = 3;
    const found = MAX_CITING_FILES + extra;
    for (let i = 0; i < found; i++) {
      // Zero-padded so path order is the obvious order, and every file
      // carries a citation so none is skipped for being citation-free.
      write(repo, `docs/f${String(i).padStart(5, "0")}.md`, [
        "The limit is set at src/limits.json:1.",
      ]);
    }
    commit(repo, "first");
    write(repo, "src/limits.json", ['{ "limit": 99 }']);
    commit(repo, "drift it");
    write(repo, "docs/unrelated.txt", ["padding"]);

    const notes: string[] = [];
    const cs = await extract(repo);
    const ctx = createContext(repo, cs.range);
    const first = await findCitationRot(cs, ctx, { sweep: true, onNote: (n) => notes.push(n) });
    expect(notes).toContain(citingFilesCappedNote(MAX_CITING_FILES, found));
    expect(first).toHaveLength(MAX_CITING_FILES);
    // What the note now says out loud, checked against what the run did: the
    // files scanned are the front of the sorted candidate list, not a
    // selection spread across the repository. The sentence is only honest
    // while this holds, and a cap that began sampling would make the note
    // untrue in exactly the direction the note exists to prevent.
    expect(first.map((r) => r.citingFile)).toEqual(
      Array.from(
        { length: MAX_CITING_FILES },
        (_, i) => `docs/f${String(i).padStart(5, "0")}.md`,
      ),
    );
    // A capped run is deterministic: the same files, in path order, twice.
    const second = await findCitationRot(cs, ctx, { sweep: true });
    expect(second.map((r) => r.citingFile)).toEqual(first.map((r) => r.citingFile));
  });

  it("composes every cap and blame note with the counts they are given, singular and plural", () => {
    // Driving MAX_CITATIONS_CHECKED over its edge with real commits would
    // build a repository large enough to dominate the suite's runtime; its
    // enforcement path is the counting code the citing-file case above
    // shares, and this pins the copy the reader actually receives.
    //
    // Each note's own count is checked on both sides. A cap that bites by
    // exactly one is the commonest way a cap bites at all, and a numeral
    // disagreeing with its noun is urtext's own grammar failing inside a
    // sentence about what urtext could not do.
    expect(citingFilesCappedNote(MAX_CITING_FILES, MAX_CITING_FILES + 1)).toContain(
      "in the other 1 file were not checked",
    );
    expect(citingFilesCappedNote(MAX_CITING_FILES, MAX_CITING_FILES + 3)).toContain(
      "in the other 3 files were not checked",
    );
    expect(citationsCappedNote(10, 12)).toContain("the first 10 of 12 citations in path order");
    expect(citationsCappedNote(10, 12)).toContain("2 further citations");
    expect(citationsCappedNote(10, 11)).toContain("1 further citation ");
    expect(baselineReadsCappedNote(2)).toContain("2 citations");
    expect(baselineReadsCappedNote(1)).toContain("1 citation ");
    expect(blameUnavailableNote(1, "boom")).toContain("1 citation ");
    expect(blameUnavailableNote(2, "boom")).toContain("2 citations");
  });

  it("names the path-order prefix the file cap took, so its fraction cannot read as a sample", () => {
    // Measured on a real repository whose sweep bit this cap: it covered
    // nearly every file under the first directory in path order and a small
    // minority of the source, and reported only the fraction — true, and read
    // as coverage spread across the tree, which is what sent a reviewer
    // looking for the source citations that were never scanned. The counts
    // are unchanged; what they mean is now said beside them.
    const note = citingFilesCappedNote(88, 507);
    expect(note).toContain("the first 88 of 507 candidate files in path order");
    expect(note).toContain("in the other 419 files were not checked");
    expect(note).toContain("rather than spreading across this repository");
  });

  it("names the prefix the citation cap took, and enumerates citations in exactly that order", async () => {
    const note = citationsCappedNote(1500, 1800);
    expect(note).toContain("the first 1500 of 1800 citations in path order");
    expect(note).toContain("300 further citations in this repository were not checked");
    expect(note).toContain("rather than spreading across this repository");

    // And the order that sentence names, proven rather than asserted. Driving
    // this cap over its edge with real commits would need a repository large
    // enough to dominate the suite's runtime, but the list it slices can be
    // built at any size: what the cap keeps is the front of the scanned files
    // in path order and, inside each file, the citations in citing-line order.
    //
    // The first citing file below carries a quoted citation on its first line
    // and a path-and-line citation on its second, which is what makes the
    // within-file ordering load-bearing: the two forms are matched in separate
    // passes, so the order they are found in is the reverse of the order they
    // are written in, and only the sort tells them apart. A repository whose
    // citations came back in match order would make this note name an order
    // the run did not take.
    const repo = makeRepo("urtext-cap-order-");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;"]);
    write(repo, "docs/a.md", [
      "The value in `src/a.ts` \"const b = 2;\" is fixed.",
      "The first one is src/a.ts:1.",
    ]);
    write(repo, "docs/b.md", ["The second one is src/a.ts:2."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 99;", "const b = 99;"]);

    const rots = await sweep(repo);
    expect(rots.map((r) => `${r.citingFile}:${r.citingLine} ${r.rot}`)).toEqual([
      "docs/a.md:1 quote_absent",
      "docs/a.md:2 content_drift",
      "docs/b.md:1 content_drift",
    ]);
  });

  it("says none of the eight forbidden words in any disclosure sentence", () => {
    const sentences = [
      citingFilesCappedNote(1, 2),
      citationsCappedNote(1, 2),
      baselineReadsCappedNote(1),
      blameUnavailableNote(1, "fatal: no such ref"),
      shallowRepositoryNote(),
    ]
      .join(" ")
      .toLowerCase();
    for (const word of ["wrong", "incorrect", "outdated", "obsolete", "misleading", "broken"]) {
      expect(sentences.includes(word), word).toBe(false);
    }
    expect(/\bstale\b/.test(sentences)).toBe(false);
    expect(/\blies\b/.test(sentences)).toBe(false);
  });
});

describe("the analyzer", () => {
  /**
   * A citation the prose wrote as `src/a.ts:2-4`, drifting at line 3 — inside
   * the range and NOT at its start. A one-line fixture cannot tell the line
   * the citation names from the line that differs, so it cannot guard the
   * anchoring at all; this one can, and every assertion below that names a
   * line number is a different number from the others on purpose.
   */
  async function driftedRange(name: string) {
    const repo = makeRepo(name);
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"]);
    write(repo, "docs/a.md", ["The rule spans src/a.ts:2-4."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 99;", "const d = 4;"]);
    const cs = await extract(repo);
    return makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
  }

  it("anchors the fact on the citing line and points the cited evidence at the line inside the range that differs", async () => {
    const facts = await driftedRange("urtext-analyzer-");
    expect(facts).toHaveLength(1);
    const f = facts[0];
    expect(f.kind).toBe("citation_rot");
    expect(f.id).toBe("citation_rot:docs/a.md:1:content_drift");
    // The reader's work is at the prose, so Fact.file/line name the prose.
    expect(f.file).toBe("docs/a.md");
    expect(f.line).toBe(1);
    expect(f.evidence[0].file).toBe("docs/a.md");
    expect(f.evidence[0].line).toBe(1);
    expect(f.evidence[0].side).toBe("after");
    // The now half of a drift is shown rather than asserted — and it points
    // at the line that moved, not at the line the citation starts on. The
    // line number and the excerpt beside it must name the same line, or the
    // reader is sent somewhere the finding is not about.
    expect(f.evidence[1].file).toBe("src/a.ts");
    expect(f.evidence[1].line).toBe(3);
    expect(f.evidence[1].excerpt).toBe("const c = 99;");
    expect(f.evidence[1].side).toBe("after");
    expect(f.detail.rot).toBe("content_drift");
    expect(f.detail.was).toBe("const c = 3;");
  });

  it("names the citation the prose wrote in the title while the evidence points at the line that drifted", async () => {
    // The two halves are each defensible alone and wrong together: a title
    // naming `src/a.ts:3` is a string the reader cannot find in their own
    // document, and evidence pointing at line 2 would quote line 3's text
    // beside line 2's number. So the title names what was written and the
    // evidence names what moved, and neither borrows the other's number.
    const [f] = await driftedRange("urtext-analyzer-written-");
    expect(f.detail.writtenLine).toBe(2);
    expect(f.detail.writtenEndLine).toBe(4);
    const finding = toFinding(f);
    expect(finding.title).toBe("cites `src/a.ts:2-4`, which no longer reads the same");
    expect(finding.body).toContain("line 3 of `src/a.ts:2-4` read `const c = 3;`");
    expect(finding.evidence[1].line).toBe(3);
    // The span the prose never wrote: the citation's end pinned to the
    // drifted line as a start.
    expect(finding.title).not.toContain("src/a.ts:3");
  });

  it("states a cited line that drifted to blank as blank, on either side, and quotes nothing where there is nothing", async () => {
    // A drift onto an empty line is common in real repositories — a paragraph
    // moves and leaves the line behind — and it was composed through `str`'s
    // fallback, which put "something else" into the body: a phrase whose whole
    // meaning is that urtext cannot say, printed under a verified badge about
    // a line urtext had read and knew was empty. Both directions are built
    // here from real history, because the same fallback stood on both sides.
    const emptied = makeRepo("urtext-blank-now-");
    write(emptied, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    write(emptied, "docs/a.md", ["The middle one is src/a.ts:2."]);
    commit(emptied, "first");
    write(emptied, "src/a.ts", ["const a = 1;", "", "const c = 3;"]);
    const csA = await extract(emptied);
    const [factA] = await makeCitationsAnalyzer()(csA, createContext(emptied, csA.range));

    // The analyzer read the line, so the emptiness is carried, not lost.
    expect(factA.detail.now).toBe("");
    const goneBlank = toFinding(factA);
    expect(goneBlank.body).toContain("`src/a.ts:2` read `const b = 2;`. It is now blank.");
    expect(goneBlank.body).not.toContain("something else");
    // An evidence row is a location and the text at it. There is no text at
    // this one, so there is no row — every ref this finding carries quotes
    // something a reader can compare against the line it names.
    expect(factA.evidence).toHaveLength(1);
    expect(factA.evidence.every((e) => e.excerpt.trim() !== "")).toBe(true);

    const filled = makeRepo("urtext-blank-was-");
    write(filled, "src/a.ts", ["const a = 1;", "", "const c = 3;"]);
    write(filled, "docs/a.md", ["The middle one is src/a.ts:2."]);
    commit(filled, "first");
    write(filled, "src/a.ts", ["const a = 1;", "const b = 2;", "const c = 3;"]);
    const csB = await extract(filled);
    const [factB] = await makeCitationsAnalyzer()(csB, createContext(filled, csB.range));

    expect(factB.detail.was).toBe("");
    const wasBlank = toFinding(factB);
    expect(wasBlank.body).toContain("`src/a.ts:2` was blank. It now reads `const b = 2;`.");
    expect(wasBlank.body).not.toContain("something else");
    // The now side has text, so that row is there and quotes it.
    expect(factB.evidence).toHaveLength(2);
    expect(factB.evidence[1].excerpt).toBe("const b = 2;");
  });

  it("carries no qualifiedSymbol, so no grouping or absorption pass can see it", async () => {
    // A citation is about a file and a line, not a symbol. This also keeps
    // citation facts out of foldReach, which matches on file and symbol — a
    // citation fact must never absorb, or be absorbed by, a blast-radius fact
    // that happens to share a file. The citation lives in a comment here
    // rather than in prose so the two facts really can share one file: a
    // blast-radius fact only ever anchors in TypeScript.
    const repo = makeRepo("urtext-analyzer-nosym-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "src/b.ts", ["// The limit is set at src/a.ts:1.", "export const send = 2;"]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    expect(facts).toHaveLength(1);
    expect(facts[0].file).toBe("src/b.ts");
    expect(facts[0].qualifiedSymbol).toBeUndefined();

    // The consequence, driven through the real fold rather than left to the
    // sentence above: a blast-radius fact anchored in the same file neither
    // swallows the citation finding nor amplifies its body.
    const radius = makeFact({
      id: "blast_radius:src/b.ts:send",
      kind: "blast_radius",
      qualifiedSymbol: "send",
      detail: { symbol: "send", references: 4 },
      evidence: [
        { file: "src/b.ts", line: 2, excerpt: "export const send = 2;" },
        { file: "src/c.ts", line: 3, excerpt: "send;" },
      ],
    });
    const findings = rank([facts[0], radius]);
    expect(findings.map((x) => x.id).sort()).toEqual([facts[0].id, radius.id].sort());
    const citation = findings.find((x) => x.id === facts[0].id)!;
    expect(citation.reach).toBeUndefined();
    expect(citation.body).toBe(toFinding(facts[0]).body);
  });

  it("never stores the baseline text as evidence", async () => {
    // EvidenceRef.side distinguishes the before and after sides of the
    // REVIEWED RANGE; the baseline is some other commit entirely, and a
    // before-side ref carrying its line number would send a reader to a line
    // in a revision the report never names.
    const repo = makeRepo("urtext-analyzer-noside-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    expect(facts[0].evidence.every((e) => e.side !== "before")).toBe(true);
    expect(facts[0].evidence.some((e) => e.excerpt === "export const limit = 1;")).toBe(false);
    expect(facts[0].detail.was).toBe("export const limit = 1;");
  });

  it("abbreviates the baseline commit it carries into the fact", async () => {
    // The finding body names this hash to the reader, and a full object name
    // there is forty characters of noise beside a sentence. Compared against
    // the commit git actually recorded, so the abbreviation is a prefix of
    // the real thing rather than a plausible-looking string.
    const repo = makeRepo("urtext-analyzer-hash-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const facts = await makeCitationsAnalyzer()(cs, createContext(repo, cs.range));
    const baseline = facts[0].detail.baseline as string;
    expect(baseline.length).toBeLessThan(head.length);
    expect(head.startsWith(baseline)).toBe(true);
  });

  it("names itself when it throws, so the disclosure never says analyzer #N", async () => {
    // `runAnalyzers` reports a failed analyzer by `analyzers[i].name`, and an
    // arrow returned directly from a factory has no name. The existing four
    // get their names from NamedEvaluation of a variable declaration; this one
    // has to do it one scope in.
    const notARepo = mkdtempSync(join(tmpdir(), "urtext-not-a-repo-"));
    const range = { from: "HEAD", to: WORKTREE, label: "test" };
    const changeset: Changeset = {
      range,
      files: [{ path: "src/a.ts", status: "modified", hunks: [], symbols: [] }],
    };
    const ctx: AnalysisContext = {
      cwd: notARepo,
      range,
      readAt: async () => null,
      programAt: () => {
        throw new Error("the citations analyzer must never build a program");
      },
    };
    const failures: AnalyzerFailure[] = [];
    const facts = await runAnalyzers(changeset, ctx, [makeCitationsAnalyzer()], (f) =>
      failures.push(f),
    );
    expect(facts).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].analyzer).toBe("citationsAnalyzer");
  });

  it("never builds the TypeScript program", async () => {
    // `ctx.programAt` parses every TS file in the repository; citation
    // checking needs text and comments, not types. The ctx above throws from
    // programAt, and the run above completed — but pin it on a working
    // repository too, where a call would otherwise succeed silently.
    const repo = makeRepo("urtext-analyzer-noprogram-");
    write(repo, "src/a.ts", ["export const limit = 1;"]);
    write(repo, "docs/a.md", ["The limit is set at src/a.ts:1."]);
    commit(repo, "first");
    write(repo, "src/a.ts", ["export const limit = 99;"]);

    const cs = await extract(repo);
    const real = createContext(repo, cs.range);
    const programAt = vi.fn(real.programAt);
    await makeCitationsAnalyzer()({ ...cs }, { ...real, programAt });
    expect(programAt).not.toHaveBeenCalled();
  });
});
