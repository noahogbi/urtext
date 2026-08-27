# Urtext Diff Review — Deterministic Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `urtext review` that takes a git revision range, detects effect changes in TypeScript code, ranks findings by importance, and prints a terminal summary — with no LLM and no API key required.

**Architecture:** A four-stage pipeline. `extract` turns a git range into a `Changeset` (files, hunks, changed symbols). `analyze` runs analyzers against that changeset to produce typed `Fact`s with source evidence. `score` converts facts into ranked `Finding`s carrying an evidence tier. `report` renders. This plan builds the pipeline end-to-end through a single analyzer (`effects`); Plan 2 adds the LLM interpretation stage, three more analyzers, and the HTML report.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, the TypeScript compiler API for AST work, `git` via `child_process`, vitest for tests, tsx for running without a build step.

**Spec:** `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`

## Global Constraints

- Node 20 or newer. ESM only — the package is `"type": "module"`; all relative imports carry a `.js` extension even though sources are `.ts`.
- TypeScript `strict: true`. No `any` in exported signatures.
- Stages 1 and 2 (`extract`, `analyze`) must not make network calls. This is what makes `--no-llm` a subset rather than a special case, and what lets the whole core be tested offline.
- No new runtime dependencies. `typescript` and `tsx` are already present; `vitest` is added as a dev dependency only. Do not add a CLI-parsing or diff-parsing library.
- Every `Fact` carries at least one `EvidenceRef` pointing at a real file and line. A fact that cannot show its evidence must not be emitted.
- Report output goes to `.urtext/` in the repository being reviewed, which is gitignored.
- The tool never prints an approve/reject verdict. It ranks and explains.

## Spec deviation to apply

The spec sketches `type Analyzer = (changeset, program: ts.Program) => Fact[]`. This plan uses `(changeset: Changeset, ctx: AnalysisContext) => Promise<Fact[]>` instead. `AnalysisContext` supplies `readAt(rev, path)` for before/after file contents and will expose a lazily-constructed `ts.Program` in Plan 2, when `surface` and `blast-radius` need the type checker. The `effects` analyzer is purely syntactic and needs no program; forcing one to exist would make it slow and awkward to test. The uniform analyzer signature the spec wanted is preserved.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | All core data contracts: `RevRange`, `Hunk`, `ChangedSymbol`, `ChangedFile`, `Changeset`, `EffectKind`, `FactKind`, `EvidenceRef`, `Fact`, `Tier`, `Finding`, `Analyzer`, `AnalysisContext` |
| `src/extract/git.ts` | Thin `git` subprocess wrapper, default-branch detection, `resolveRange`, `readAt` |
| `src/extract/diff.ts` | Unified-diff parser: raw diff text → `ChangedFile[]` with hunks and status |
| `src/extract/symbols.ts` | TS AST → `ChangedSymbol[]` by comparing before/after and intersecting with hunk ranges |
| `src/extract/index.ts` | Composes the above into `extract(cwd, rangeSpec) => Changeset` |
| `src/analyze/effects.ts` | Syntactic effect detection and the `effects` analyzer |
| `src/analyze/index.ts` | Analyzer registry and `runAnalyzers` |
| `src/score/index.ts` | Importance weights, `scoreFact`, tier assignment, `rank` |
| `src/report/terminal.ts` | Terminal summary renderer (pure: `Finding[]` → string) |
| `src/cli.ts` | Argument parsing and pipeline wiring |
| `archive/prototype/` | The klar-era builder/checker/emitter/PLP/demo, unimported |
| `test/fixtures/` | Sample source pairs used by analyzer and symbol tests |

---

### Task 1: Prepare the repository

Archives the prototype, installs a test runner, and fixes the scripts that point at files which no longer exist. Deliverable: `npm test` runs and passes, and `src/` is empty of prototype code.

**Files:**
- Create: `archive/prototype/README.md`
- Create: `vitest.config.ts`
- Create: `test/smoke.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Move: `src/{builder,checker,emit-ts,plp,types,demo}.ts` → `archive/prototype/`
- Move: `output/` → `archive/prototype/output/`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm test`; an empty `src/` for Task 2 onward

- [ ] **Step 1: Move the prototype out of `src/`**

```bash
mkdir -p archive/prototype
git mv src/builder.ts src/checker.ts src/emit-ts.ts src/plp.ts src/types.ts src/demo.ts archive/prototype/
git mv output archive/prototype/output
```

- [ ] **Step 2: Write the archive README**

Create `archive/prototype/README.md`:

```markdown
# Prototype (klar-era, March 2026)

The original standalone prototype, built under the working name **klar**: an
AI-native intermediate representation authored through a fluent builder API,
checked, projected into six human-readable views, and transpiled to a Hono
server.

It is kept for provenance. **Nothing in `src/` imports it**, and it is not
maintained. `output/` holds the demo artifacts it produced.

The ideas that carried forward into the current tool, rewritten rather than
reused:

- the effect taxonomy (`EffectKind`) — now recovered from real code by an
  analyzer rather than declared by an author
- the proof kinds (`by_constraint`, `by_human`) — now the evidence tiers
  (`verified`, `inferred`, `model`)
- the six projections (PLP) — now the report lenses
- the change journal — now the finding set

See `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`.
```

- [ ] **Step 3: Install vitest**

Run: `npm install -D vitest@^2.1.0 @types/node@^20.14.0`

- [ ] **Step 4: Add the vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Update `package.json`**

Replace the `scripts` block (the existing `demo`, `check`, and `project` scripts point at files that are archived or never existed) and add `type`:

```json
{
  "name": "urtext",
  "version": "0.1.0",
  "description": "Diff review with evidence tiers: deterministic analysis, LLM interpretation, every claim labeled",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "review": "npx tsx src/cli.ts review"
  },
  "dependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.7.0"
  }
}
```

Leave the `devDependencies` block that `npm install -D` just wrote.

- [ ] **Step 6: Update `.gitignore`**

```
node_modules/
dist/
.urtext/
*.log
```

- [ ] **Step 7: Write the smoke test**

Create `test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: archive prototype, add vitest, fix package scripts"
```

---

### Task 2: Core types and the git wrapper

Defines every data contract the pipeline uses, plus the subprocess layer that reads revisions. Deliverable: `resolveRange` and `readAt` work against a real repository.

**Files:**
- Create: `src/types.ts`
- Create: `src/extract/git.ts`
- Test: `test/extract/git.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `WORKTREE: "WORKTREE"` — sentinel revision meaning "files as they are on disk"
  - `git(args: string[], cwd: string): Promise<string>`
  - `defaultBranch(cwd: string): Promise<string>`
  - `resolveRange(cwd: string, spec?: string): Promise<RevRange>`
  - `readAt(cwd: string, rev: string, path: string): Promise<string | null>` — `null` when the file does not exist at that revision
  - every type listed in Step 1 below

- [ ] **Step 1: Write the core types**

Create `src/types.ts`:

```ts
/** Sentinel revision: read files from the working tree rather than git. */
export const WORKTREE = "WORKTREE";

export interface RevRange {
  /** Revision to treat as "before". A commit-ish. */
  from: string;
  /** Revision to treat as "after". A commit-ish, or WORKTREE. */
  to: string;
  /** Human-readable description, e.g. "vs origin/main". */
  label: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "variable";

export interface ChangedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** 1-based, inclusive, in the "after" file. Zero for removed symbols. */
  range: { startLine: number; endLine: number };
  change: "added" | "modified" | "removed";
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  previousPath?: string;
  hunks: Hunk[];
  /** Empty for files that are not TypeScript. */
  symbols: ChangedSymbol[];
}

export interface Changeset {
  range: RevRange;
  files: ChangedFile[];
}

export type EffectKind =
  | "network"
  | "filesystem"
  | "process"
  | "env"
  | "database"
  | "timing";

export type FactKind = "effect_added" | "effect_removed";

export interface EvidenceRef {
  file: string;
  line: number;
  excerpt: string;
}

export interface Fact {
  /** Stable within a single run; referenced by Claim.correspondsTo in Plan 2. */
  id: string;
  kind: FactKind;
  file: string;
  line: number;
  symbol?: string;
  detail: Record<string, unknown>;
  /** At least one. A fact that cannot show its evidence is not emitted. */
  evidence: EvidenceRef[];
}

export type Tier = "verified" | "inferred" | "model";

export interface Finding {
  id: string;
  tier: Tier;
  file: string;
  line: number;
  /** One line, shown as the finding headline. */
  title: string;
  /** One or two sentences of supporting explanation. */
  body: string;
  score: number;
  evidence: EvidenceRef[];
}

export interface AnalysisContext {
  cwd: string;
  range: RevRange;
  /** File contents at a revision, or null if absent there. */
  readAt(rev: string, path: string): Promise<string | null>;
}

export type Analyzer = (
  changeset: Changeset,
  ctx: AnalysisContext,
) => Promise<Fact[]>;
```

- [ ] **Step 2: Write the failing test**

Create `test/extract/git.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKTREE } from "../../src/types.js";
import { defaultBranch, readAt, resolveRange } from "../../src/extract/git.js";

let repo: string;

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: repo, stdio: "pipe" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-git-"));
  run("git", ["init", "-b", "main"]);
  run("git", ["config", "user.email", "test@example.com"]);
  run("git", ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "first"]);
  run("git", ["checkout", "-b", "feature"]);
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

describe("defaultBranch", () => {
  it("falls back to a local main when no origin exists", async () => {
    expect(await defaultBranch(repo)).toBe("main");
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
});

describe("readAt", () => {
  it("reads committed content at a revision", async () => {
    expect(await readAt(repo, "main", "a.ts")).toBe("export const a = 1;\n");
  });

  it("reads uncommitted content from the worktree", async () => {
    expect(await readAt(repo, WORKTREE, "a.ts")).toBe("export const a = 2;\n");
  });

  it("returns null for a file absent at that revision", async () => {
    expect(await readAt(repo, "main", "nope.ts")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/extract/git.test.ts`
Expected: FAIL — cannot resolve `../../src/extract/git.js`.

- [ ] **Step 4: Implement the git wrapper**

Create `src/extract/git.ts`:

```ts
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
  });
  return stdout;
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

export async function resolveRange(
  cwd: string,
  spec?: string,
): Promise<RevRange> {
  if (spec) {
    const m = spec.match(/^(.*?)(\.{2,3})(.*)$/);
    if (m) {
      const from = m[1] || "HEAD";
      const to = m[3] || "HEAD";
      return {
        from: (await git(["rev-parse", from], cwd)).trim(),
        to: (await git(["rev-parse", to], cwd)).trim(),
        label: spec,
      };
    }
    // A bare revision means "from there to the working tree".
    return {
      from: (await git(["rev-parse", spec], cwd)).trim(),
      to: WORKTREE,
      label: `vs ${spec}`,
    };
  }

  const base = await defaultBranch(cwd);
  const mergeBase = (await git(["merge-base", "HEAD", base], cwd)).trim();
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
      return await readFile(join(cwd, path), "utf8");
    } catch {
      return null;
    }
  }
  try {
    return await git(["show", `${rev}:${path}`], cwd);
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/extract/git.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/extract/git.ts test/extract/git.test.ts
git commit -m "feat(extract): core types, git wrapper, range resolution"
```

---

### Task 3: Unified diff parsing

Turns raw `git diff` output into files with hunks. Deliverable: `parseUnifiedDiff` handles modified, added, deleted, and renamed files.

**Files:**
- Create: `src/extract/diff.ts`
- Test: `test/extract/diff.test.ts`

**Interfaces:**
- Consumes: `Hunk`, `ChangedFile`, `FileStatus` from `src/types.ts`
- Produces:
  - `parseUnifiedDiff(text: string): Omit<ChangedFile, "symbols">[]` — pure, no git access
  - `diffText(cwd: string, range: RevRange): Promise<string>` — runs the right git command for a worktree-ended or commit-ended range

- [ ] **Step 1: Write the failing test**

Create `test/extract/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/extract/diff.js";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,3 @@ export function a() {
-  const x = 1;
+  const x = 2;
+  const y = 3;
@@ -40,0 +41,1 @@
+  console.log("hi");
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+
`;

const DELETED = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const o = 1;
`;

const RENAMED = `diff --git a/src/from.ts b/src/to.ts
similarity index 92%
rename from src/from.ts
rename to src/to.ts
index 5555555..6666666 100644
--- a/src/from.ts
+++ b/src/to.ts
@@ -3 +3 @@
-const q = 1;
+const q = 2;
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file with multiple hunks", () => {
    const files = parseUnifiedDiff(MODIFIED);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/a.ts");
    expect(files[0].status).toBe("modified");
    expect(files[0].hunks).toEqual([
      { oldStart: 10, oldLines: 2, newStart: 10, newLines: 3 },
      { oldStart: 40, oldLines: 0, newStart: 41, newLines: 1 },
    ]);
  });

  it("defaults an omitted line count to 1", () => {
    const files = parseUnifiedDiff(RENAMED);
    expect(files[0].hunks).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
    ]);
  });

  it("marks added files", () => {
    const files = parseUnifiedDiff(ADDED);
    expect(files[0].status).toBe("added");
    expect(files[0].path).toBe("src/new.ts");
  });

  it("marks deleted files", () => {
    const files = parseUnifiedDiff(DELETED);
    expect(files[0].status).toBe("deleted");
    expect(files[0].path).toBe("src/old.ts");
  });

  it("marks renamed files and records the previous path", () => {
    const files = parseUnifiedDiff(RENAMED);
    expect(files[0].status).toBe("renamed");
    expect(files[0].path).toBe("src/to.ts");
    expect(files[0].previousPath).toBe("src/from.ts");
  });

  it("parses several files in one diff", () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + DELETED);
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extract/diff.test.ts`
Expected: FAIL — cannot resolve `../../src/extract/diff.js`.

- [ ] **Step 3: Implement the parser**

Create `src/extract/diff.ts`:

```ts
import { git } from "./git.js";
import { WORKTREE, type ChangedFile, type Hunk, type RevRange } from "../types.js";

type ParsedFile = Omit<ChangedFile, "symbols">;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` output. Expects `--no-color`; hunk context width does not
 * matter because only the ranges are read.
 */
export function parseUnifiedDiff(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/x b/y" — take the b-side as the path; a rename or a
      // /dev/null marker later in the header corrects it.
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      current = {
        path: m ? m[2] : "",
        status: "modified",
        hunks: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.previousPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("--- ") && line.endsWith("/dev/null")) {
      current.status = "added";
    } else if (line.startsWith("+++ ") && line.endsWith("/dev/null")) {
      current.status = "deleted";
    } else {
      const h = line.match(HUNK);
      if (h) {
        const hunk: Hunk = {
          oldStart: Number(h[1]),
          oldLines: h[2] === undefined ? 1 : Number(h[2]),
          newStart: Number(h[3]),
          newLines: h[4] === undefined ? 1 : Number(h[4]),
        };
        current.hunks.push(hunk);
      }
    }
  }

  return files;
}

/** Raw diff text for a range, including untracked-file awareness via -M. */
export async function diffText(
  cwd: string,
  range: RevRange,
): Promise<string> {
  const args = ["diff", "--no-color", "-U0", "-M", range.from];
  if (range.to !== WORKTREE) args.push(range.to);
  return git(args, cwd);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/extract/diff.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extract/diff.ts test/extract/diff.test.ts
git commit -m "feat(extract): unified diff parser"
```

---

### Task 4: Symbol mapping

Maps changed lines to the TypeScript symbols that contain them, which is what makes later output read as "the body of `validateSession` changed" instead of "line 42 changed".

**Files:**
- Create: `src/extract/symbols.ts`
- Test: `test/extract/symbols.test.ts`

**Interfaces:**
- Consumes: `ChangedSymbol`, `Hunk`, `SymbolKind` from `src/types.ts`
- Produces:
  - `isTypeScriptFile(path: string): boolean`
  - `mapSymbols(path: string, before: string | null, after: string | null, hunks: Hunk[]): ChangedSymbol[]`

- [ ] **Step 1: Write the failing test**

Create `test/extract/symbols.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isTypeScriptFile, mapSymbols } from "../../src/extract/symbols.js";

const BEFORE = `export function alpha() {
  return 1;
}

function beta() {
  return 2;
}

export class Gamma {
  method() {
    return 3;
  }
}
`;

const AFTER = `export function alpha() {
  return 99;
}

function beta() {
  return 2;
}

export class Gamma {
  method() {
    return 3;
  }
}

export function delta() {
  return 4;
}
`;

describe("isTypeScriptFile", () => {
  it("accepts .ts and .tsx", () => {
    expect(isTypeScriptFile("a/b.ts")).toBe(true);
    expect(isTypeScriptFile("a/b.tsx")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTypeScriptFile("a/b.js")).toBe(false);
    expect(isTypeScriptFile("a/b.md")).toBe(false);
    expect(isTypeScriptFile("a/b.d.ts.map")).toBe(false);
  });
});

describe("mapSymbols", () => {
  it("marks a symbol modified when a hunk falls inside it", () => {
    const hunks = [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    const alpha = syms.find((s) => s.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.change).toBe("modified");
    expect(alpha!.kind).toBe("function");
    expect(alpha!.exported).toBe(true);
  });

  it("does not report symbols no hunk touches", () => {
    const hunks = [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    expect(syms.find((s) => s.name === "beta")).toBeUndefined();
  });

  it("marks a symbol added when it is absent before", () => {
    const hunks = [{ oldStart: 13, oldLines: 0, newStart: 14, newLines: 3 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    const delta = syms.find((s) => s.name === "delta");
    expect(delta).toBeDefined();
    expect(delta!.change).toBe("added");
  });

  it("marks a symbol removed when it is absent after", () => {
    const syms = mapSymbols("a.ts", AFTER, BEFORE, [
      { oldStart: 14, oldLines: 3, newStart: 13, newLines: 0 },
    ]);
    const delta = syms.find((s) => s.name === "delta");
    expect(delta).toBeDefined();
    expect(delta!.change).toBe("removed");
    expect(delta!.range).toEqual({ startLine: 0, endLine: 0 });
  });

  it("records class methods with their own names", () => {
    const hunks = [{ oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 }];
    const syms = mapSymbols("a.ts", BEFORE, AFTER, hunks);
    expect(syms.map((s) => s.name)).toContain("method");
    expect(syms.find((s) => s.name === "method")!.kind).toBe("method");
  });

  it("returns nothing when the after-content is missing", () => {
    expect(mapSymbols("a.ts", BEFORE, null, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extract/symbols.test.ts`
Expected: FAIL — cannot resolve `../../src/extract/symbols.js`.

- [ ] **Step 3: Implement symbol mapping**

Create `src/extract/symbols.ts`:

```ts
import ts from "typescript";
import type { ChangedSymbol, Hunk, SymbolKind } from "../types.js";

export function isTypeScriptFile(path: string): boolean {
  return /\.tsx?$/.test(path) && !path.endsWith(".d.ts");
}

interface Declared {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Every named declaration in a file, with 1-based inclusive line ranges. */
function declarations(sf: ts.SourceFile): Declared[] {
  const out: Declared[] = [];

  const record = (
    node: ts.Node,
    name: string | undefined,
    kind: SymbolKind,
    exported: boolean,
  ) => {
    if (!name) return;
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    out.push({ name, kind, exported, startLine, endLine });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      record(node, node.name?.text, "function", isExported(node));
    } else if (ts.isClassDeclaration(node)) {
      record(node, node.name?.text, "class", isExported(node));
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      record(node, node.name.text, "type", isExported(node));
    } else if (ts.isMethodDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      record(node, name, "method", false);
    } else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          record(node, decl.name.text, "variable", exported);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return out;
}

function touched(d: Declared, hunks: Hunk[]): boolean {
  return hunks.some((h) => {
    // A pure deletion (newLines === 0) is anchored just after newStart.
    const start = h.newStart;
    const end = h.newLines === 0 ? h.newStart : h.newStart + h.newLines - 1;
    return start <= d.endLine && end >= d.startLine;
  });
}

/**
 * Symbols affected by this change. A symbol is reported when it is new, gone,
 * or when a hunk falls inside its line range in the after-file.
 */
export function mapSymbols(
  path: string,
  before: string | null,
  after: string | null,
  hunks: Hunk[],
): ChangedSymbol[] {
  if (!isTypeScriptFile(path)) return [];
  // A deleted file: reporting every symbol in it as "removed" is noise, since
  // the file's deletion is already the finding.
  if (after === null) return [];

  const beforeDecls = before ? declarations(parse(path, before)) : [];
  const afterDecls = after ? declarations(parse(path, after)) : [];
  const beforeNames = new Set(beforeDecls.map((d) => d.name));
  const afterNames = new Set(afterDecls.map((d) => d.name));

  const out: ChangedSymbol[] = [];

  for (const d of afterDecls) {
    const added = !beforeNames.has(d.name);
    if (!added && !touched(d, hunks)) continue;
    out.push({
      name: d.name,
      kind: d.kind,
      exported: d.exported,
      range: { startLine: d.startLine, endLine: d.endLine },
      change: added ? "added" : "modified",
    });
  }

  for (const d of beforeDecls) {
    if (afterNames.has(d.name)) continue;
    out.push({
      name: d.name,
      kind: d.kind,
      exported: d.exported,
      range: { startLine: 0, endLine: 0 },
      change: "removed",
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/extract/symbols.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extract/symbols.ts test/extract/symbols.test.ts
git commit -m "feat(extract): map changed lines to TypeScript symbols"
```

---

### Task 5: Compose the extract stage

Wires range resolution, diff parsing, and symbol mapping into one call. Deliverable: `extract()` returns a complete `Changeset` for a real repository.

**Files:**
- Create: `src/extract/index.ts`
- Test: `test/extract/index.test.ts`

**Interfaces:**
- Consumes: `resolveRange`, `readAt` (Task 2); `parseUnifiedDiff`, `diffText` (Task 3); `mapSymbols` (Task 4)
- Produces:
  - `extract(cwd: string, rangeSpec?: string): Promise<Changeset>`
  - `createContext(cwd: string, range: RevRange): AnalysisContext`

- [ ] **Step 1: Write the failing test**

Create `test/extract/index.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extract } from "../../src/extract/index.js";

let repo: string;

function run(args: string[]) {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-extract-"));
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extract/index.test.ts`
Expected: FAIL — cannot resolve `../../src/extract/index.js`.

- [ ] **Step 3: Implement the composer**

Create `src/extract/index.ts`:

```ts
import type { AnalysisContext, Changeset, ChangedFile, RevRange } from "../types.js";
import { diffText, parseUnifiedDiff } from "./diff.js";
import { readAt, resolveRange } from "./git.js";
import { mapSymbols } from "./symbols.js";

export { resolveRange, readAt } from "./git.js";

export function createContext(cwd: string, range: RevRange): AnalysisContext {
  return {
    cwd,
    range,
    readAt: (rev, path) => readAt(cwd, rev, path),
  };
}

export async function extract(
  cwd: string,
  rangeSpec?: string,
): Promise<Changeset> {
  const range = await resolveRange(cwd, rangeSpec);
  const parsed = parseUnifiedDiff(await diffText(cwd, range));

  const files: ChangedFile[] = [];
  for (const p of parsed) {
    const beforePath = p.previousPath ?? p.path;
    const before =
      p.status === "added" ? null : await readAt(cwd, range.from, beforePath);
    const after =
      p.status === "deleted" ? null : await readAt(cwd, range.to, p.path);
    files.push({
      ...p,
      symbols: mapSymbols(p.path, before, after, p.hunks),
    });
  }

  return { range, files };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/extract/index.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/extract/index.ts test/extract/index.test.ts
git commit -m "feat(extract): compose range, diff, and symbols into a changeset"
```

---

### Task 6: The effects analyzer

Detects side effects appearing in or disappearing from a file. This is the first analyzer and the one that proves the whole pipeline.

**Files:**
- Create: `src/analyze/effects.ts`
- Create: `src/analyze/index.ts`
- Test: `test/analyze/effects.test.ts`

**Interfaces:**
- Consumes: `Analyzer`, `AnalysisContext`, `Changeset`, `EffectKind`, `Fact` from `src/types.ts`
- Produces:
  - `detectEffects(path: string, text: string): EffectSite[]` where `interface EffectSite { kind: EffectKind; line: number; excerpt: string }`
  - `effectsAnalyzer: Analyzer`
  - `runAnalyzers(changeset, ctx, analyzers?): Promise<Fact[]>` from `src/analyze/index.ts`
  - `ANALYZERS: Analyzer[]` — the default registry, currently `[effectsAnalyzer]`

- [ ] **Step 1: Write the failing test**

Create `test/analyze/effects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectEffects, effectsAnalyzer } from "../../src/analyze/effects.js";
import { WORKTREE, type AnalysisContext, type Changeset } from "../../src/types.js";

describe("detectEffects", () => {
  it("finds a bare fetch call", () => {
    const sites = detectEffects("a.ts", "async function f() {\n  await fetch(u);\n}\n");
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe("network");
    expect(sites[0].line).toBe(2);
    expect(sites[0].excerpt).toBe("await fetch(u);");
  });

  it("finds axios-shaped network calls", () => {
    const sites = detectEffects("a.ts", "axios.get(url);\n");
    expect(sites[0].kind).toBe("network");
  });

  it("finds filesystem access", () => {
    const sites = detectEffects("a.ts", "fs.writeFileSync(p, d);\n");
    expect(sites[0].kind).toBe("filesystem");
  });

  it("finds env reads", () => {
    const sites = detectEffects("a.ts", "const k = process.env.KEY;\n");
    expect(sites[0].kind).toBe("env");
  });

  it("finds process control separately from env", () => {
    const sites = detectEffects("a.ts", "process.exit(1);\n");
    expect(sites[0].kind).toBe("process");
  });

  it("finds nondeterministic timing sources", () => {
    const kinds = detectEffects("a.ts", "const t = Date.now();\nconst r = Math.random();\n")
      .map((s) => s.kind);
    expect(kinds).toEqual(["timing", "timing"]);
  });

  it("finds database calls through a known client", () => {
    const sites = detectEffects("a.ts", "db.query('select 1');\n");
    expect(sites[0].kind).toBe("database");
  });

  it("returns nothing for pure code", () => {
    expect(detectEffects("a.ts", "export const add = (a: number, b: number) => a + b;\n")).toEqual([]);
  });

  it("ignores non-TypeScript files", () => {
    expect(detectEffects("a.md", "fetch(u)")).toEqual([]);
  });
});

function ctxFor(files: Record<string, { before: string | null; after: string | null }>): AnalysisContext {
  return {
    cwd: "/tmp",
    range: { from: "abc", to: WORKTREE, label: "vs main" },
    async readAt(rev, path) {
      const entry = files[path];
      if (!entry) return null;
      return rev === WORKTREE ? entry.after : entry.before;
    },
  };
}

const changesetFor = (path: string): Changeset => ({
  range: { from: "abc", to: WORKTREE, label: "vs main" },
  files: [{ path, status: "modified", hunks: [], symbols: [] }],
});

describe("effectsAnalyzer", () => {
  it("emits effect_added when a kind is new to the file", async () => {
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "export const x = 1;\n", after: "export const x = fetch(u);\n" } }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("effect_added");
    expect(facts[0].detail.effect).toBe("network");
    expect(facts[0].evidence.length).toBeGreaterThan(0);
    expect(facts[0].id).toBeTruthy();
  });

  it("emits effect_removed when a kind disappears", async () => {
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "fs.readFileSync(p);\n", after: "export const x = 1;\n" } }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("effect_removed");
    expect(facts[0].detail.effect).toBe("filesystem");
  });

  it("stays silent when the same effect kind exists on both sides", async () => {
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "fetch(a);\n", after: "fetch(b);\n" } }),
    );
    expect(facts).toEqual([]);
  });

  it("skips non-TypeScript files", async () => {
    const facts = await effectsAnalyzer(
      changesetFor("a.md"),
      ctxFor({ "a.md": { before: "x", after: "fetch(u)" } }),
    );
    expect(facts).toEqual([]);
  });

  it("gives every fact a distinct id", async () => {
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "export const x = 1;\n", after: "fetch(u);\nfs.readFileSync(p);\n" } }),
    );
    const ids = facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/analyze/effects.test.ts`
Expected: FAIL — cannot resolve `../../src/analyze/effects.js`.

- [ ] **Step 3: Implement effect detection**

Create `src/analyze/effects.ts`:

```ts
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EffectKind,
  EvidenceRef,
  Fact,
} from "../types.js";

export interface EffectSite {
  kind: EffectKind;
  line: number;
  excerpt: string;
}

/** Bare global calls that are effectful. */
const GLOBAL_CALLS: Record<string, EffectKind> = {
  fetch: "network",
};

/** `object.member` patterns, matched on the object name. */
const OBJECT_EFFECTS: Record<string, EffectKind> = {
  fs: "filesystem",
  fsPromises: "filesystem",
  axios: "network",
  http: "network",
  https: "network",
  child_process: "process",
  db: "database",
  prisma: "database",
  knex: "database",
  pool: "database",
};

/** Fully-qualified `object.member` patterns that beat the object-name table. */
const QUALIFIED_EFFECTS: Record<string, EffectKind> = {
  "process.env": "env",
  "process.exit": "process",
  "Date.now": "timing",
  "Math.random": "timing",
};

function qualifiedName(node: ts.PropertyAccessExpression): string | null {
  const left = node.expression;
  if (!ts.isIdentifier(left)) return null;
  return `${left.text}.${node.name.text}`;
}

/** Effect sites in a file, in source order. Syntactic — no type checker. */
export function detectEffects(path: string, text: string): EffectSite[] {
  if (!isTypeScriptFile(path)) return [];

  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split("\n");
  const sites: EffectSite[] = [];

  const push = (node: ts.Node, kind: EffectKind) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    sites.push({ kind, line, excerpt: (lines[line - 1] ?? "").trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const q = qualifiedName(node);
      if (q && QUALIFIED_EFFECTS[q]) {
        push(node, QUALIFIED_EFFECTS[q]);
      } else if (
        ts.isIdentifier(node.expression) &&
        OBJECT_EFFECTS[node.expression.text]
      ) {
        push(node, OBJECT_EFFECTS[node.expression.text]);
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_CALLS[node.expression.text]
    ) {
      push(node, GLOBAL_CALLS[node.expression.text]);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return sites;
}

function kindsOf(sites: EffectSite[]): Set<EffectKind> {
  return new Set(sites.map((s) => s.kind));
}

function toEvidence(path: string, sites: EffectSite[], kind: EffectKind): EvidenceRef[] {
  return sites
    .filter((s) => s.kind === kind)
    .slice(0, 5)
    .map((s) => ({ file: path, line: s.line, excerpt: s.excerpt }));
}

/**
 * Reports effect kinds that appear in a file's after-state but not its
 * before-state, and vice versa. A file that already made network calls and
 * makes different ones now is not a finding; a file that never did and now
 * does, is.
 */
export const effectsAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const facts: Fact[] = [];

  for (const file of changeset.files) {
    if (!isTypeScriptFile(file.path)) continue;

    const beforePath = file.previousPath ?? file.path;
    const beforeText =
      file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforePath);
    const afterText =
      file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, file.path);

    const beforeSites = beforeText ? detectEffects(beforePath, beforeText) : [];
    const afterSites = afterText ? detectEffects(file.path, afterText) : [];
    const before = kindsOf(beforeSites);
    const after = kindsOf(afterSites);

    for (const kind of after) {
      if (before.has(kind)) continue;
      const evidence = toEvidence(file.path, afterSites, kind);
      if (evidence.length === 0) continue;
      facts.push({
        id: `effect_added:${file.path}:${kind}`,
        kind: "effect_added",
        file: file.path,
        line: evidence[0].line,
        detail: { effect: kind, sites: evidence.length },
        evidence,
      });
    }

    for (const kind of before) {
      if (after.has(kind)) continue;
      const evidence = toEvidence(beforePath, beforeSites, kind);
      if (evidence.length === 0) continue;
      facts.push({
        id: `effect_removed:${file.path}:${kind}`,
        kind: "effect_removed",
        file: file.path,
        line: evidence[0].line,
        detail: { effect: kind, sites: evidence.length },
        evidence,
      });
    }
  }

  return facts;
};
```

- [ ] **Step 4: Implement the analyzer registry**

Create `src/analyze/index.ts`:

```ts
import type { AnalysisContext, Analyzer, Changeset, Fact } from "../types.js";
import { effectsAnalyzer } from "./effects.js";

export { detectEffects, effectsAnalyzer } from "./effects.js";

/** Plan 2 adds surface, blast-radius, and guards here. */
export const ANALYZERS: Analyzer[] = [effectsAnalyzer];

export async function runAnalyzers(
  changeset: Changeset,
  ctx: AnalysisContext,
  analyzers: Analyzer[] = ANALYZERS,
): Promise<Fact[]> {
  const results = await Promise.all(analyzers.map((a) => a(changeset, ctx)));
  return results.flat();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/analyze/effects.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/analyze test/analyze
git commit -m "feat(analyze): effects analyzer and analyzer registry"
```

---

### Task 7: Scoring and tier assignment

Turns facts into ranked findings with human-readable titles. Deliverable: `rank()` orders findings the way the spec's importance model says it should.

**Files:**
- Create: `src/score/index.ts`
- Test: `test/score/index.test.ts`

**Interfaces:**
- Consumes: `Fact`, `Finding`, `Tier`, `EffectKind` from `src/types.ts`
- Produces:
  - `WEIGHTS` — the tunable weight table
  - `scoreFact(fact: Fact): number`
  - `tierFor(fact: Fact): Tier` — always `"verified"` in Plan 1; Plan 2 extends it
  - `toFinding(fact: Fact): Finding`
  - `rank(facts: Fact[]): Finding[]`

- [ ] **Step 1: Write the failing test**

Create `test/score/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rank, scoreFact, tierFor, toFinding } from "../../src/score/index.js";
import type { Fact } from "../../src/types.js";

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "f1",
  kind: "effect_added",
  file: "a.ts",
  line: 3,
  detail: { effect: "network", sites: 1 },
  evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
  ...over,
});

describe("scoreFact", () => {
  it("scores an added effect above a removed one", () => {
    const added = scoreFact(fact());
    const removed = scoreFact(fact({ kind: "effect_removed" }));
    expect(added).toBeGreaterThan(removed);
  });

  it("weights network and database above timing", () => {
    const net = scoreFact(fact({ detail: { effect: "network", sites: 1 } }));
    const time = scoreFact(fact({ detail: { effect: "timing", sites: 1 } }));
    expect(net).toBeGreaterThan(time);
  });
});

describe("tierFor", () => {
  it("marks analyzer-derived facts verified", () => {
    expect(tierFor(fact())).toBe("verified");
  });
});

describe("toFinding", () => {
  it("writes a readable title naming the file and effect", () => {
    const f = toFinding(fact());
    expect(f.title).toBe("a.ts introduces a network effect");
    expect(f.tier).toBe("verified");
    expect(f.evidence).toHaveLength(1);
    expect(f.id).toBe("f1");
  });

  it("writes a removal title", () => {
    const f = toFinding(fact({ kind: "effect_removed" }));
    expect(f.title).toBe("a.ts no longer has a network effect");
  });

  it("mentions the site count in the body when there are several", () => {
    const f = toFinding(fact({ detail: { effect: "network", sites: 3 } }));
    expect(f.body).toContain("3");
  });
});

describe("rank", () => {
  it("orders by descending score", () => {
    const findings = rank([
      fact({ id: "low", kind: "effect_removed", detail: { effect: "timing", sites: 1 } }),
      fact({ id: "high", kind: "effect_added", detail: { effect: "network", sites: 1 } }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["high", "low"]);
  });

  it("breaks ties deterministically by file then line", () => {
    const findings = rank([
      fact({ id: "b", file: "b.ts", line: 1 }),
      fact({ id: "a", file: "a.ts", line: 9 }),
    ]);
    expect(findings.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no facts", () => {
    expect(rank([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/score/index.test.ts`
Expected: FAIL — cannot resolve `../../src/score/index.js`.

- [ ] **Step 3: Implement scoring**

Create `src/score/index.ts`:

```ts
import type { EffectKind, Fact, Finding, Tier } from "../types.js";

/**
 * Tunable in one place on purpose: these weights will need adjusting once
 * they have been run against real diffs.
 */
export const WEIGHTS = {
  factKind: {
    effect_added: 60,
    effect_removed: 15,
  } satisfies Record<Fact["kind"], number>,
  effect: {
    network: 1.0,
    database: 1.0,
    process: 0.9,
    filesystem: 0.8,
    env: 0.6,
    timing: 0.4,
  } satisfies Record<EffectKind, number>,
};

function effectOf(fact: Fact): EffectKind {
  const e = fact.detail.effect;
  return (typeof e === "string" ? e : "timing") as EffectKind;
}

export function scoreFact(fact: Fact): number {
  const base = WEIGHTS.factKind[fact.kind];
  return base * WEIGHTS.effect[effectOf(fact)];
}

/**
 * Plan 1 emits only analyzer-derived facts, so everything is machine-checked.
 * Plan 2 introduces model claims and the inferred/model tiers.
 */
export function tierFor(_fact: Fact): Tier {
  return "verified";
}

export function toFinding(fact: Fact): Finding {
  const effect = effectOf(fact);
  const sites = typeof fact.detail.sites === "number" ? fact.detail.sites : 1;

  const title =
    fact.kind === "effect_added"
      ? `${fact.file} introduces a ${effect} effect`
      : `${fact.file} no longer has a ${effect} effect`;

  const where = sites === 1 ? "at one site" : `at ${sites} sites`;
  const body =
    fact.kind === "effect_added"
      ? `This file previously had no ${effect} effect. It now does, ${where}.`
      : `This file previously had a ${effect} effect ${where}. It no longer does.`;

  return {
    id: fact.id,
    tier: tierFor(fact),
    file: fact.file,
    line: fact.line,
    title,
    body,
    score: scoreFact(fact),
    evidence: fact.evidence,
  };
}

export function rank(facts: Fact[]): Finding[] {
  return facts
    .map(toFinding)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/score/index.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/score test/score
git commit -m "feat(score): importance weights, tier assignment, ranking"
```

---

### Task 8: Terminal renderer

Renders findings as the compact summary. Pure function, snapshot-friendly.

**Files:**
- Create: `src/report/terminal.ts`
- Test: `test/report/terminal.test.ts`

**Interfaces:**
- Consumes: `Changeset`, `Finding`, `Tier` from `src/types.ts`
- Produces: `renderTerminal(changeset: Changeset, findings: Finding[], reportPath?: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/report/terminal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderTerminal } from "../../src/report/terminal.js";
import { WORKTREE, type Changeset, type Finding } from "../../src/types.js";

const changeset: Changeset = {
  range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
  files: [
    { path: "a.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }], symbols: [] },
    { path: "b.ts", status: "modified", hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }], symbols: [] },
  ],
};

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  tier: "verified",
  file: "a.ts",
  line: 3,
  title: "a.ts introduces a network effect",
  body: "This file previously had no network effect. It now does, at one site.",
  score: 60,
  evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
  ...over,
});

describe("renderTerminal", () => {
  it("shows the range label and file count", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("vs origin/main");
    expect(out).toContain("2 files");
  });

  it("shows tier counts", () => {
    const out = renderTerminal(changeset, [
      finding({ id: "a" }),
      finding({ id: "b", tier: "model" }),
    ]);
    expect(out).toContain("EVIDENCE");
    expect(out).toContain("1 verified");
    expect(out).toContain("1 model-only");
  });

  it("prints each finding with its location and tier badge", () => {
    const out = renderTerminal(changeset, [finding()]);
    expect(out).toContain("a.ts:3");
    expect(out).toContain("[verified]");
    expect(out).toContain("introduces a network effect");
  });

  it("says so plainly when nothing was found", () => {
    const out = renderTerminal(changeset, []);
    expect(out).toContain("No findings");
    expect(out).not.toContain("EVIDENCE");
  });

  it("includes the report path when one is given", () => {
    const out = renderTerminal(changeset, [finding()], ".urtext/review.html");
    expect(out).toContain(".urtext/review.html");
  });

  it("omits the report line when no path is given", () => {
    expect(renderTerminal(changeset, [finding()])).not.toContain("Full report");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/report/terminal.test.ts`
Expected: FAIL — cannot resolve `../../src/report/terminal.js`.

- [ ] **Step 3: Implement the renderer**

Create `src/report/terminal.ts`:

```ts
import type { Changeset, Finding, Tier } from "../types.js";

const MARK: Record<Tier, string> = {
  verified: "▲",
  inferred: "●",
  model: "○",
};

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

export function renderTerminal(
  changeset: Changeset,
  findings: Finding[],
  reportPath?: string,
): string {
  const out: string[] = [];
  const fileCount = changeset.files.length;
  const lineCount = changeset.files.reduce(
    (n, f) => n + f.hunks.reduce((m, h) => m + h.newLines, 0),
    0,
  );

  out.push("");
  out.push(
    `urtext · ${fileCount} file${fileCount === 1 ? "" : "s"}, ${lineCount} line${lineCount === 1 ? "" : "s"} changed · ${changeset.range.label}`,
  );
  out.push("");

  if (findings.length === 0) {
    out.push("  No findings. Nothing in this change tripped an analyzer.");
    out.push("");
    return out.join("\n");
  }

  const counts: Record<Tier, number> = { verified: 0, inferred: 0, model: 0 };
  for (const f of findings) counts[f.tier]++;
  const parts: string[] = [];
  if (counts.verified) parts.push(`${counts.verified} verified`);
  if (counts.inferred) parts.push(`${counts.inferred} inferred`);
  if (counts.model) parts.push(`${counts.model} model-only`);
  out.push(`  EVIDENCE  ${parts.join(" · ")}`);
  out.push("");

  for (const f of findings) {
    const head = `  ${MARK[f.tier]} ${f.file}:${f.line} — ${f.title}`;
    out.push(`${head}  [${f.tier}]`);
    out.push(...wrap(f.body, 64, "    "));
    out.push("");
  }

  if (reportPath) {
    out.push(`  Full report: ${reportPath}`);
    out.push("");
  }

  return out.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/report/terminal.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report test/report
git commit -m "feat(report): terminal summary renderer"
```

---

### Task 9: CLI wiring

Assembles the pipeline behind `urtext review`. Deliverable: running the CLI against this repository prints a real review.

**Files:**
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `extract`, `createContext` (Task 5); `runAnalyzers` (Task 6); `rank` (Task 7); `renderTerminal` (Task 8)
- Produces:
  - `parseArgs(argv: string[]): CliOptions` where `interface CliOptions { command: string; range?: string; json: boolean; noLlm: boolean; help: boolean }`
  - `review(cwd: string, opts: CliOptions): Promise<{ output: string; exitCode: number }>`

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, review } from "../src/cli.js";

describe("parseArgs", () => {
  it("defaults to the review command with no range", () => {
    const o = parseArgs([]);
    expect(o.command).toBe("review");
    expect(o.range).toBeUndefined();
    expect(o.json).toBe(false);
    expect(o.noLlm).toBe(false);
  });

  it("reads a positional range", () => {
    expect(parseArgs(["review", "HEAD~2"]).range).toBe("HEAD~2");
  });

  it("reads flags in any position", () => {
    const o = parseArgs(["review", "--json", "main..feature", "--no-llm"]);
    expect(o.json).toBe(true);
    expect(o.noLlm).toBe(true);
    expect(o.range).toBe("main..feature");
  });

  it("recognises help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-cli-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);
  writeFileSync(join(repo, "svc.ts"), "export function load(id: string) {\n  return fetch(id);\n}\n");
});

describe("review", () => {
  it("finds the introduced network effect and exits zero", async () => {
    const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("network effect");
    expect(r.output).toContain("[verified]");
  });

  it("emits machine-readable findings under --json", async () => {
    const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.range.label).toBe("vs main");
    expect(parsed.findings[0].tier).toBe("verified");
    expect(parsed.counts.verified).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli.js`.

- [ ] **Step 3: Implement the CLI**

Create `src/cli.ts`:

```ts
import { runAnalyzers } from "./analyze/index.js";
import { createContext, extract } from "./extract/index.js";
import { renderTerminal } from "./report/terminal.js";
import { rank } from "./score/index.js";
import type { Tier } from "./types.js";

export interface CliOptions {
  command: string;
  range?: string;
  json: boolean;
  noLlm: boolean;
  help: boolean;
}

const USAGE = `
urtext — diff review with evidence tiers

Usage:
  urtext review [<rev-range>]     Review a change (default: working tree vs
                                  merge-base with the default branch)

Options:
  --no-llm    Deterministic analysis only; no API key required
  --json      Emit findings as JSON
  --help      Show this message
`;

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: "review",
    json: false,
    noLlm: false,
    help: false,
  };
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-llm") opts.noLlm = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else positional.push(arg);
  }

  if (positional.length > 0 && positional[0] === "review") positional.shift();
  if (positional.length > 0) opts.range = positional[0];

  return opts;
}

export async function review(
  cwd: string,
  opts: CliOptions,
): Promise<{ output: string; exitCode: number }> {
  const changeset = await extract(cwd, opts.range);
  const ctx = createContext(cwd, changeset.range);
  const facts = await runAnalyzers(changeset, ctx);
  const findings = rank(facts);

  if (opts.json) {
    const counts: Record<Tier, number> = { verified: 0, inferred: 0, model: 0 };
    for (const f of findings) counts[f.tier]++;
    return {
      output: JSON.stringify(
        { range: changeset.range, counts, findings },
        null,
        2,
      ),
      exitCode: 0,
    };
  }

  return { output: renderTerminal(changeset, findings), exitCode: 0 };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const { output, exitCode } = await review(process.cwd(), opts);
    process.stdout.write(output.endsWith("\n") ? output : output + "\n");
    process.exitCode = exitCode;
  } catch (err) {
    process.stderr.write(
      `urtext: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

// Run only when invoked directly, so tests can import this module freely.
if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  void main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Run the tool against this repository**

Run: `npm run review -- HEAD~1`
Expected: a terminal summary with the range label, a file count, and either findings or the "No findings" line. This is a real end-to-end check, not a test — read the output and confirm it looks right.

- [ ] **Step 7: Typecheck**

First widen `tsconfig.json` so tests are typechecked too. Change two fields — `rootDir` must move to `"."` as well, or every test file errors with TS6059 ("not under rootDir"):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src/**/*", "test/**/*", "vitest.config.ts"]
}
```

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Update the README**

Replace the "Layout" and "Provenance" sections of `README.md` with:

```markdown
## What it does

`urtext review` takes a git range, analyses the change, and prints what
matters — ranked, with every claim labeled by the kind of evidence behind it:

- `verified` — proven by static analysis; the report points at the code
- `inferred` — a model claim that analysis corroborates but does not prove
- `model` — a model claim nothing mechanical confirms

```bash
npm run review              # working tree vs merge-base with the default branch
npm run review -- HEAD~3    # against a specific revision
npm run review -- --json    # machine-readable findings
```

## Layout

- `src/extract/` — git range → changeset (files, hunks, changed symbols)
- `src/analyze/` — analyzers producing typed facts with source evidence
- `src/score/` — importance weights, tier assignment, ranking
- `src/report/` — terminal renderer
- `src/cli.ts` — entry point
- `archive/prototype/` — the klar-era IR prototype, kept for provenance

Design: `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`

## Provenance

Built ~March 13, 2026 as a standalone prototype under the working name
**klar** — an AI-native IR the model authored directly. Renamed **urtext**
and first committed to version control August 15, 2026. In August 2026 it was
re-aimed at the problem that had become the real bottleneck: reviewing
AI-written diffs rather than authoring code in an IR. The prototype lives in
`archive/prototype/`.
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(cli): wire the review pipeline end to end"
```

---

## Self-review notes

**Spec coverage.** Stage 1 extract → Tasks 2–5. Stage 2 analyze (effects only, as sequenced) → Task 6. Score and tier assignment → Task 7. Terminal output → Task 8. CLI with `--no-llm` and `--json` → Task 9. Prototype archival and the broken `package.json` scripts → Task 1.

**Deliberately deferred to Plan 2**, all named in the spec: the interpret stage and the `Claim` type; the `inferred` and `model` tiers (Task 7 ships `tierFor` as the extension point); the `surface`, `blast-radius`, and `guards` analyzers (Task 6 ships `ANALYZERS` as the extension point); the HTML report and `--open`; writing reports into `.urtext/` (Task 1 gitignores it; nothing writes there yet, and `renderTerminal` already accepts the path parameter it will need).

**Known limitation to revisit in Plan 2.** `diffText` uses `git diff <from>`, which does not include untracked files. A brand-new file that has never been `git add`ed will not appear in a working-tree review. This is worth fixing but is not on the critical path for the first slice.
