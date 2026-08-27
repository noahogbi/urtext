# Urtext Analyzers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `urtext review` from one analyzer to four — adding contract changes, blast radius, and removed guards — and close the two precision gaps Plan 1 deferred, so that the `verified` tier means what it claims.

**Architecture:** Unchanged four-stage pipeline. Two new pieces of shared machinery: scope-qualified symbol names (so symbol identity is sound), and a TypeScript `Program` built over an arbitrary git revision (so analyzers can use the type checker on both sides of a diff). Three new analyzers register in the existing `ANALYZERS` array; scoring and rendering grow to cover the new fact kinds. No LLM in this plan.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, the TypeScript compiler API (including a custom `CompilerHost` backed by git), vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-08-15-urtext-diff-review-design.md`

**Predecessor:** `docs/superpowers/plans/2026-08-15-urtext-diff-review-core.md` (merged; PR #1)

## Global Constraints

- Node 20 or newer. ESM only — the package is `"type": "module"`; all relative imports carry a `.js` extension even though sources are `.ts`. The bare `typescript` import takes no extension.
- TypeScript `strict: true`. No `any` in exported signatures.
- **No new dependencies.** `typescript` is already a dependency; its compiler API is the tool.
- Stages 1 and 2 (`extract`, `analyze`) make no network calls. Building a `Program` shells out to git and reads local files, nothing more.
- **Every `Fact` carries at least one `EvidenceRef`** pointing at a real file and line. A fact that cannot show its evidence must not be emitted. This is enforced by `buildFact` in the effects analyzer and must be honoured by every new analyzer.
- **An unreadable file is an error, never evidence.** A `null` content read for a file whose status is not `deleted` means the read failed; skip it, never infer that something disappeared. This rule was added in Plan 1's final fix wave after two bugs violated it.
- The tool never prints an approve/reject verdict.
- Existing exported names keep working: `extract`, `createContext`, `runAnalyzers`, `rank`, `renderTerminal`, `parseArgs`, `review`, `repoRoot`.

## Carried-forward rulings this plan discharges

Two deferrals from Plan 1 are prerequisites here, not optional cleanup:

1. **Scope-qualified symbol names** (Task 1). Symbols are currently matched by bare name across a whole file, so a deleted `render` in one class is hidden by another class's `render`. Nothing consumed symbol data in Plan 1; Tasks 4 and 5 consume it directly, so this must land first.
2. **Import-specifier effect mapping** (Task 6). Effect detection is keyed on identifier names, so `import { readFile as rf } from "node:fs/promises"` is missed. Plan 1's ruling deferred this on the assumption it needed the type checker; the reviewer correctly pointed out that resolving *import bindings by module specifier* is purely syntactic. That cheaper fix is in scope here.

Still deferred, deliberately: widening `tierFor`'s signature (belongs with Plan 3's `Claim` type), and the deleted-file `effect_removed` noise question (a product judgment better made once the HTML report exists to show it).

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | Extended: `ChangedSymbol.qualifiedName`, new `FactKind` members, `AnalysisContext.programAt` |
| `src/extract/symbols.ts` | Modified: track declaration containers, emit qualified names |
| `src/analyze/program.ts` | **New.** Build a `ts.Program` over any git revision via a custom `CompilerHost` |
| `src/analyze/guards.ts` | **New.** Detect conditionals, early returns, and throws removed from surviving symbols |
| `src/analyze/surface.ts` | **New.** Detect added, removed, and signature-changed exports |
| `src/analyze/blast-radius.ts` | **New.** Count references to changed exported symbols |
| `src/analyze/effects.ts` | Modified: resolve import bindings by module specifier |
| `src/analyze/index.ts` | Modified: register the three new analyzers |
| `src/score/index.ts` | Modified: weights, titles, and bodies for the new fact kinds |
| `test/analyze/*.test.ts` | Tests per analyzer, plus fixtures |

---

### Task 1: Scope-qualified symbol names

Gives every declaration an identity that survives same-named siblings. Deliverable: a method deleted from one class is reported even when another class keeps a method of that name.

**Files:**
- Modify: `src/types.ts` (add `qualifiedName` to `ChangedSymbol`)
- Modify: `src/extract/symbols.ts`
- Test: `test/extract/symbols.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces: `ChangedSymbol.qualifiedName: string` — dotted container path, e.g. `"Gamma.method"`; equal to `name` for top-level declarations. Added/removed classification keys on this, not on `name`.

- [ ] **Step 1: Write the failing test**

Append to `test/extract/symbols.test.ts`:

```ts
const TWO_CLASSES_BEFORE = `export class Alpha {
  render() {
    return 1;
  }
}

export class Beta {
  render() {
    return 2;
  }
}
`;

const TWO_CLASSES_AFTER = `export class Alpha {
}

export class Beta {
  render() {
    return 2;
  }
}
`;

describe("mapSymbols qualified names", () => {
  it("qualifies a method with its containing class", () => {
    const syms = mapSymbols("a.ts", TWO_CLASSES_BEFORE, TWO_CLASSES_BEFORE, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const m = syms.find((s) => s.qualifiedName === "Alpha.render");
    expect(m).toBeDefined();
    expect(m!.name).toBe("render");
  });

  it("leaves a top-level declaration's qualified name equal to its name", () => {
    const syms = mapSymbols("a.ts", BEFORE, AFTER, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
    ]);
    const alpha = syms.find((s) => s.name === "alpha")!;
    expect(alpha.qualifiedName).toBe("alpha");
  });

  it("reports a method removed from one class even when a sibling keeps that name", () => {
    const syms = mapSymbols(
      "a.ts",
      TWO_CLASSES_BEFORE,
      TWO_CLASSES_AFTER,
      [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 0 }],
    );
    const removed = syms.filter((s) => s.change === "removed");
    expect(removed.map((s) => s.qualifiedName)).toContain("Alpha.render");
    expect(removed.map((s) => s.qualifiedName)).not.toContain("Beta.render");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/extract/symbols.test.ts`
Expected: FAIL — `qualifiedName` does not exist on the returned objects, and the removal case reports nothing because `Beta.render` masks `Alpha.render`.

- [ ] **Step 3: Add the field to the type**

In `src/types.ts`, extend `ChangedSymbol`:

```ts
export interface ChangedSymbol {
  name: string;
  /**
   * Dotted container path, e.g. "Gamma.method". Equal to `name` for
   * top-level declarations. Identity is keyed on this, not on `name` —
   * two classes in one file may each declare `render`.
   */
  qualifiedName: string;
  kind: SymbolKind;
  exported: boolean;
  /** 1-based, inclusive, in the "after" file. Zero for removed symbols. */
  range: { startLine: number; endLine: number };
  change: "added" | "modified" | "removed";
}
```

- [ ] **Step 4: Track containers while walking**

In `src/extract/symbols.ts`, give `Declared` a `qualifiedName` and thread a container stack through the walk. Replace the `declarations` function with:

```ts
interface Declared {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
}

/** Every named declaration in a file, with 1-based inclusive line ranges. */
function declarations(sf: ts.SourceFile): Declared[] {
  const out: Declared[] = [];
  const container: string[] = [];

  const record = (
    node: ts.Node,
    name: string | undefined,
    kind: SymbolKind,
    exported: boolean,
  ) => {
    if (!name) return;
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    out.push({
      name,
      qualifiedName: [...container, name].join("."),
      kind,
      exported,
      startLine,
      endLine,
    });
  };

  const visit = (node: ts.Node): void => {
    let pushed = false;

    if (ts.isFunctionDeclaration(node)) {
      record(node, node.name?.text, "function", isExported(node));
    } else if (ts.isClassDeclaration(node)) {
      record(node, node.name?.text, "class", isExported(node));
      if (node.name) {
        container.push(node.name.text);
        pushed = true;
      }
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
    if (pushed) container.pop();
  };

  ts.forEachChild(sf, visit);
  return out;
}
```

- [ ] **Step 5: Key identity on the qualified name**

In the same file, `mapSymbols` builds its name sets from `qualifiedName` and carries the field through. Replace the two set constructions and both emit loops:

```ts
  const beforeNames = new Set(beforeDecls.map((d) => d.qualifiedName));
  const afterNames = new Set(afterDecls.map((d) => d.qualifiedName));

  const out: ChangedSymbol[] = [];

  for (const d of afterDecls) {
    const added = !beforeNames.has(d.qualifiedName);
    if (!added && !touched(d, hunks)) continue;
    out.push({
      name: d.name,
      qualifiedName: d.qualifiedName,
      kind: d.kind,
      exported: d.exported,
      range: { startLine: d.startLine, endLine: d.endLine },
      change: added ? "added" : "modified",
    });
  }

  for (const d of beforeDecls) {
    if (afterNames.has(d.qualifiedName)) continue;
    out.push({
      name: d.name,
      qualifiedName: d.qualifiedName,
      kind: d.kind,
      exported: d.exported,
      range: { startLine: 0, endLine: 0 },
      change: "removed",
    });
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/extract/symbols.test.ts`
Expected: PASS. Pre-existing tests in this file assert on `name` and still hold.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean. Any other file constructing a `ChangedSymbol` literal now fails to typecheck — fix those call sites rather than making the field optional.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/extract/symbols.ts test/extract/symbols.test.ts
git commit -m "feat(extract): scope-qualified symbol names"
```

---

### Task 2: A TypeScript Program over any git revision

The type checker is what separates a guess from a verified claim, and Tasks 4 and 5 need it on **both** sides of a diff — including the "before" side, which exists only in git. Deliverable: `programAt(rev)` returns a working `ts.Program` for a commit or for the working tree.

**Files:**
- Create: `src/analyze/program.ts`
- Modify: `src/types.ts` (`AnalysisContext.programAt`)
- Modify: `src/extract/index.ts` (`createContext` supplies it)
- Test: `test/analyze/program.test.ts`

**Interfaces:**
- Consumes: `readAt`, `repoRoot`, `git` from `src/extract/git.js`; `WORKTREE` from types
- Produces:
  - `listTypeScriptFilesAt(root: string, rev: string): Promise<string[]>` — repo-relative `.ts`/`.tsx` paths at a revision
  - `createProgramAt(root: string, rev: string): Promise<ts.Program>`
  - `AnalysisContext.programAt(rev: string): Promise<ts.Program>` — memoized per revision

- [ ] **Step 1: Write the failing test**

Create `test/analyze/program.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { createProgramAt, listTypeScriptFilesAt } from "../../src/analyze/program.js";
import { WORKTREE } from "../../src/types.js";

let repo: string;

function run(args: string[]) {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-program-"));
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "lib.ts"),
    "export function twice(n: number): number {\n  return n * 2;\n}\n",
  );
  writeFileSync(join(repo, "notes.md"), "hi\n");
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);

  // Working tree diverges from the commit.
  writeFileSync(
    join(repo, "src", "lib.ts"),
    "export function twice(n: number): string {\n  return String(n * 2);\n}\n",
  );
});

describe("listTypeScriptFilesAt", () => {
  it("lists TypeScript files at a commit and skips others", async () => {
    const files = await listTypeScriptFilesAt(repo, "main");
    expect(files).toContain("src/lib.ts");
    expect(files).not.toContain("notes.md");
  });

  it("lists working-tree files for the WORKTREE sentinel", async () => {
    expect(await listTypeScriptFilesAt(repo, WORKTREE)).toContain("src/lib.ts");
  });
});

describe("createProgramAt", () => {
  it("type-checks the committed revision, not the working tree", async () => {
    const program = await createProgramAt(repo, "main");
    const sf = program.getSourceFile(join(repo, "src/lib.ts"));
    expect(sf).toBeDefined();
    const checker = program.getTypeChecker();
    const sym = checker
      .getExportsOfModule(checker.getSymbolAtLocation(sf!)!)
      .find((s) => s.getName() === "twice")!;
    const sig = checker.typeToString(
      checker.getTypeOfSymbolAtLocation(sym, sf!),
    );
    expect(sig).toContain("number");
    expect(sig).not.toContain("string");
  });

  it("type-checks the working tree for the WORKTREE sentinel", async () => {
    const program = await createProgramAt(repo, WORKTREE);
    const sf = program.getSourceFile(join(repo, "src/lib.ts"))!;
    const checker = program.getTypeChecker();
    const sym = checker
      .getExportsOfModule(checker.getSymbolAtLocation(sf)!)
      .find((s) => s.getName() === "twice")!;
    expect(
      checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, sf)),
    ).toContain("string");
  });

  it("resolves standard library types", async () => {
    const program = await createProgramAt(repo, WORKTREE);
    // A program with no lib would report errors on `String`.
    const sf = program.getSourceFile(join(repo, "src/lib.ts"))!;
    const errors = program
      .getSemanticDiagnostics(sf)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/analyze/program.test.ts`
Expected: FAIL — cannot resolve `../../src/analyze/program.js`.

- [ ] **Step 3: Implement the revision-backed program**

Create `src/analyze/program.ts`:

```ts
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { git, readAt } from "../extract/git.js";
import { WORKTREE } from "../types.js";

/**
 * Repo-relative TypeScript source paths at a revision. Declaration files are
 * excluded: they contribute no analyzable implementation and inflate the
 * program.
 */
export async function listTypeScriptFilesAt(
  root: string,
  rev: string,
): Promise<string[]> {
  const out =
    rev === WORKTREE
      ? await git(["ls-files", "--cached", "--others", "--exclude-standard"], root)
      : await git(["ls-tree", "-r", "--name-only", rev], root);

  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.tsx?$/.test(l) && !l.endsWith(".d.ts"));
}

/** The repo's compiler options, or defaults when it has no usable tsconfig. */
function compilerOptions(root: string): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
  };
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  // Always force noEmit: we type-check, never build.
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

/**
 * A CompilerHost whose source files come from a git revision rather than
 * disk. Library files (lib.es2022.d.ts and friends) still come from the
 * installed typescript package — they are part of the toolchain, not the
 * repository under review.
 */
function hostFor(
  root: string,
  options: ts.CompilerOptions,
  contents: Map<string, string>,
): ts.CompilerHost {
  return {
    getSourceFile(fileName, languageVersion) {
      const text = contents.get(fileName) ?? readLib(fileName);
      if (text === undefined) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    fileExists: (f) => contents.has(f) || ts.sys.fileExists(f),
    readFile: (f) => contents.get(f) ?? ts.sys.readFile(f),
    directoryExists: (d) => ts.sys.directoryExists(d),
    getDirectories: (d) => ts.sys.getDirectories(d),
  };

  function readLib(fileName: string): string | undefined {
    const abs = isAbsolute(fileName) ? fileName : resolve(root, fileName);
    const rel = relative(root, abs);
    const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    const inDependencies = rel.split(/[\\/]/).includes("node_modules");

    // A repository file absent from `contents` genuinely does not exist at
    // this revision, and must NOT be served from the working tree — that is
    // exactly how a "before" program would silently type-check current code
    // and report confident nonsense. Dependencies and the compiler's own lib
    // files are toolchain, not subject, so they come from disk.
    if (insideRepo && !inDependencies) return undefined;

    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Build a program over a git revision. For WORKTREE this is equivalent to
 * reading from disk; for a commit, file contents come from git, so a
 * "before" side can be type-checked without touching the working tree.
 */
export async function createProgramAt(
  root: string,
  rev: string,
): Promise<ts.Program> {
  const options = compilerOptions(root);
  const paths = await listTypeScriptFilesAt(root, rev);

  const contents = new Map<string, string>();
  const rootNames: string[] = [];
  for (const p of paths) {
    const text = await readAt(root, rev, p);
    if (text === null) continue; // absent at this revision; not an error here
    const abs = join(root, p);
    contents.set(abs, text);
    rootNames.push(abs);
  }

  return ts.createProgram(rootNames, options, hostFor(root, options, contents));
}

/** Repo-relative path for a program source file. */
export function relativePathOf(root: string, sf: ts.SourceFile): string {
  return relative(root, sf.fileName).split("\\").join("/");
}
```

- [ ] **Step 4: Expose it on the analysis context**

In `src/types.ts`, add the import and the method:

```ts
import type ts from "typescript";
```

```ts
export interface AnalysisContext {
  cwd: string;
  range: RevRange;
  /** File contents at a revision, or null if absent there. */
  readAt(rev: string, path: string): Promise<string | null>;
  /**
   * A type-checked program at a revision. Built lazily and memoized —
   * constructing one parses every TypeScript file in the repository, so
   * analyzers that do not need the checker must not call this.
   */
  programAt(rev: string): Promise<ts.Program>;
}
```

- [ ] **Step 5: Supply it from `createContext`**

In `src/extract/index.ts`:

```ts
import type ts from "typescript";
import { createProgramAt } from "../analyze/program.js";
```

```ts
export function createContext(cwd: string, range: RevRange): AnalysisContext {
  const programs = new Map<string, Promise<ts.Program>>();
  return {
    cwd,
    range,
    readAt: (rev, path) => readAt(cwd, rev, path),
    programAt(rev) {
      let p = programs.get(rev);
      if (!p) {
        p = createProgramAt(cwd, rev);
        programs.set(rev, p);
      }
      return p;
    },
  };
}
```

- [ ] **Step 6: Fix the hand-built contexts in existing tests**

`test/analyze/effects.test.ts` constructs an `AnalysisContext` literal, which now fails to typecheck. Add a `programAt` that throws, since the effects analyzer must not call it:

```ts
    async programAt(): Promise<never> {
      throw new Error("effectsAnalyzer must not build a program");
    },
```

This is a real assertion, not a stub: if the effects analyzer ever starts building programs, that test fails loudly.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run test/analyze/program.test.ts && npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add src/analyze/program.ts src/types.ts src/extract/index.ts test/analyze/program.test.ts test/analyze/effects.test.ts
git commit -m "feat(analyze): build a TypeScript program over any git revision"
```

---

### Task 3: The guards analyzer

Detects conditionals, early returns, and throws that vanished from a symbol that still exists. Purely syntactic — no program needed — so it also proves the new-fact-kind path end to end before the checker-dependent analyzers land. The spec ranks guard removal high: it is the best mechanical proxy for a correctness or security regression.

**Files:**
- Create: `src/analyze/guards.ts`
- Modify: `src/types.ts` (`FactKind` gains `guard_removed`)
- Test: `test/analyze/guards.test.ts`

**Interfaces:**
- Consumes: `Analyzer`, `AnalysisContext`, `Changeset`, `Fact`, `EvidenceRef`; `isTypeScriptFile` from `../extract/symbols.js`
- Produces:
  - `collectGuards(path: string, text: string): GuardSite[]` where `interface GuardSite { symbol: string; signature: string; line: number; excerpt: string }`
  - `guardsAnalyzer: Analyzer`

- [ ] **Step 1: Add the fact kind**

In `src/types.ts`:

```ts
export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed";
```

- [ ] **Step 2: Write the failing test**

Create `test/analyze/guards.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectGuards, guardsAnalyzer } from "../../src/analyze/guards.js";
import { WORKTREE, type AnalysisContext, type Changeset } from "../../src/types.js";

const BEFORE = `export function validate(token: string) {
  if (!token) {
    throw new Error("missing token");
  }
  return { token, ok: true };
}
`;

const AFTER = `export function validate(token: string) {
  return { token, ok: true };
}
`;

const AFTER_KEPT = `export function validate(token: string) {
  if (!token) {
    throw new Error("missing token");
  }
  return { token, ok: true, checked: true };
}
`;

describe("collectGuards", () => {
  it("finds an if-guard and attributes it to its enclosing function", () => {
    const guards = collectGuards("a.ts", BEFORE);
    const g = guards.find((x) => x.signature.startsWith("if"));
    expect(g).toBeDefined();
    expect(g!.symbol).toBe("validate");
    expect(g!.line).toBe(2);
  });

  it("finds a throw", () => {
    expect(collectGuards("a.ts", BEFORE).some((g) => g.signature.startsWith("throw"))).toBe(true);
  });

  it("returns nothing for code with no guards", () => {
    expect(collectGuards("a.ts", AFTER)).toEqual([]);
  });

  it("ignores non-TypeScript files", () => {
    expect(collectGuards("a.md", BEFORE)).toEqual([]);
  });
});

function ctxFor(files: Record<string, { before: string | null; after: string | null }>): AnalysisContext {
  return {
    cwd: "/tmp",
    range: { from: "abc", to: WORKTREE, label: "vs main" },
    async readAt(rev, path) {
      const e = files[path];
      if (!e) return null;
      return rev === WORKTREE ? e.after : e.before;
    },
    async programAt(): Promise<never> {
      throw new Error("guardsAnalyzer must not build a program");
    },
  };
}

const changesetFor = (path: string): Changeset => ({
  range: { from: "abc", to: WORKTREE, label: "vs main" },
  files: [{ path, status: "modified", hunks: [], symbols: [] }],
});

describe("guardsAnalyzer", () => {
  it("reports a guard removed from a surviving symbol", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: AFTER } }),
    );
    expect(facts).toHaveLength(2); // the if and the throw
    expect(facts.every((f) => f.kind === "guard_removed")).toBe(true);
    expect(facts[0].symbol).toBe("validate");
    expect(facts[0].evidence[0].excerpt).toContain("if (!token)");
  });

  it("stays silent when the guard survives", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: AFTER_KEPT } }),
    );
    expect(facts).toEqual([]);
  });

  it("stays silent when the whole symbol is gone", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: "export const unrelated = 1;\n" } }),
    );
    expect(facts).toEqual([]);
  });

  it("does not treat an unreadable after-side as a removal", async () => {
    const facts = await guardsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: BEFORE, after: null } }),
    );
    expect(facts).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/analyze/guards.test.ts`
Expected: FAIL — cannot resolve `../../src/analyze/guards.js`.

- [ ] **Step 4: Implement the analyzer**

Create `src/analyze/guards.ts`:

```ts
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

export interface GuardSite {
  /** Enclosing function, method, or "<module>" for top-level guards. */
  symbol: string;
  /** Kind plus normalised condition text — the identity used for matching. */
  signature: string;
  line: number;
  excerpt: string;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Guard-shaped constructs, attributed to the symbol containing them.
 * Matching is by (symbol, signature): moving a guard within a function is
 * not a removal, but deleting one is.
 */
export function collectGuards(path: string, text: string): GuardSite[] {
  if (!isTypeScriptFile(path)) return [];

  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split("\n");
  const out: GuardSite[] = [];
  const owner: string[] = [];

  const push = (node: ts.Node, signature: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({
      symbol: owner[owner.length - 1] ?? "<module>",
      signature,
      line,
      excerpt: (lines[line - 1] ?? "").trim(),
    });
  };

  const nameOf = (node: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    const name = nameOf(node);
    if (name) owner.push(name);

    if (ts.isIfStatement(node)) {
      push(node, `if:${normalise(node.expression.getText(sf))}`);
    } else if (ts.isThrowStatement(node)) {
      push(node, `throw:${normalise(node.expression.getText(sf))}`);
    } else if (
      ts.isReturnStatement(node) &&
      node.parent &&
      ts.isBlock(node.parent) &&
      node.parent.parent &&
      ts.isIfStatement(node.parent.parent)
    ) {
      // An early return inside a conditional — the classic guard clause.
      push(node, `return:${normalise(node.getText(sf))}`);
    }

    ts.forEachChild(node, visit);
    if (name) owner.pop();
  };

  ts.forEachChild(sf, visit);
  return out;
}

function key(g: GuardSite): string {
  return `${g.symbol}\u0000${g.signature}`;
}

/**
 * Reports guards that were present in a symbol before the change and are
 * absent from that same symbol after it. A symbol that disappeared entirely
 * is not reported — its deletion is the finding, and the guards analyzer
 * would only add noise.
 */
export const guardsAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const facts: Fact[] = [];

  for (const file of changeset.files) {
    if (!isTypeScriptFile(file.path)) continue;
    if (file.status === "added" || file.status === "deleted") continue;

    const beforePath = file.previousPath ?? file.path;
    const beforeText = await ctx.readAt(ctx.range.from, beforePath);
    const afterText = await ctx.readAt(ctx.range.to, file.path);

    // An unreadable side is an error, never evidence that a guard vanished.
    if (beforeText === null || afterText === null) continue;

    const before = collectGuards(beforePath, beforeText);
    const after = collectGuards(file.path, afterText);
    const afterKeys = new Set(after.map(key));
    const survivingSymbols = new Set(after.map((g) => g.symbol));
    // Symbols with no guards at all after the change still count as
    // surviving if they still exist in the file.
    for (const s of collectSymbolNames(file.path, afterText)) {
      survivingSymbols.add(s);
    }

    for (const g of before) {
      if (afterKeys.has(key(g))) continue;
      if (!survivingSymbols.has(g.symbol)) continue;
      const evidence: EvidenceRef[] = [
        { file: beforePath, line: g.line, excerpt: g.excerpt },
      ];
      facts.push({
        id: `guard_removed:${file.path}:${g.symbol}:${g.signature}`,
        kind: "guard_removed",
        file: file.path,
        line: g.line,
        symbol: g.symbol,
        detail: { guard: g.signature.split(":")[0], symbol: g.symbol },
        evidence,
      });
    }
  }

  return facts;
};

/** Function and method names declared in a file. */
function collectSymbolNames(path: string, text: string): string[] {
  if (!isTypeScriptFile(path)) return [];
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/analyze/guards.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/guards.ts src/types.ts test/analyze/guards.test.ts
git commit -m "feat(analyze): guards analyzer"
```

---

### Task 4: The surface analyzer

Detects changes to a module's public contract — the class of change that breaks callers silently. Uses the type checker on both revisions.

**Files:**
- Create: `src/analyze/surface.ts`
- Modify: `src/types.ts` (`FactKind` gains `export_added`, `export_removed`, `signature_changed`)
- Test: `test/analyze/surface.test.ts`

**Interfaces:**
- Consumes: `ctx.programAt` (Task 2); `relativePathOf` from `../analyze/program.js`
- Produces:
  - `exportedSignatures(program: ts.Program, root: string, path: string): Map<string, string>` — exported name → printed type
  - `surfaceAnalyzer: Analyzer`

- [ ] **Step 1: Add the fact kinds**

In `src/types.ts`:

```ts
export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed"
  | "export_added"
  | "export_removed"
  | "signature_changed";
```

- [ ] **Step 2: Write the failing test**

Create `test/analyze/surface.test.ts`. It drives a real repo, because the analyzer's whole point is type resolution:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { surfaceAnalyzer } from "../../src/analyze/surface.js";
import { createContext, extract } from "../../src/extract/index.js";

let repo: string;

function run(args: string[]) {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-surface-"));
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "api.ts"),
    [
      "export function findByEmail(e: string): { id: string } {",
      "  return { id: e };",
      "}",
      "export function willBeRemoved(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);

  writeFileSync(
    join(repo, "src", "api.ts"),
    [
      "export function findByEmail(e: string): { id: string } | null {",
      "  return e ? { id: e } : null;",
      "}",
      "export function addedLater(): boolean {",
      "  return true;",
      "}",
      "",
    ].join("\n"),
  );
});

describe("surfaceAnalyzer", () => {
  it("reports a widened return type as a signature change", async () => {
    const cs = await extract(repo);
    const facts = await surfaceAnalyzer(cs, createContext(repo, cs.range));
    const sig = facts.find((f) => f.kind === "signature_changed");
    expect(sig).toBeDefined();
    expect(sig!.detail.export).toBe("findByEmail");
    expect(String(sig!.detail.after)).toContain("null");
    expect(sig!.evidence.length).toBeGreaterThan(0);
  });

  it("reports a removed export", async () => {
    const cs = await extract(repo);
    const facts = await surfaceAnalyzer(cs, createContext(repo, cs.range));
    expect(
      facts.filter((f) => f.kind === "export_removed").map((f) => f.detail.export),
    ).toContain("willBeRemoved");
  });

  it("reports an added export", async () => {
    const cs = await extract(repo);
    const facts = await surfaceAnalyzer(cs, createContext(repo, cs.range));
    expect(
      facts.filter((f) => f.kind === "export_added").map((f) => f.detail.export),
    ).toContain("addedLater");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/analyze/surface.test.ts`
Expected: FAIL — cannot resolve `../../src/analyze/surface.js`.

- [ ] **Step 4: Implement the analyzer**

Create `src/analyze/surface.ts`:

```ts
import { join } from "node:path";
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

/** Exported name → printed type, for one file in a program. */
export function exportedSignatures(
  program: ts.Program,
  root: string,
  path: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const sf = program.getSourceFile(join(root, path));
  if (!sf) return out;

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return out;

  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const type = checker.getTypeOfSymbolAtLocation(sym, sf);
    out.set(sym.getName(), checker.typeToString(type));
  }
  return out;
}

function lineOfExport(
  program: ts.Program,
  root: string,
  path: string,
  name: string,
): { line: number; excerpt: string } {
  const sf = program.getSourceFile(join(root, path));
  if (!sf) return { line: 1, excerpt: "" };
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const sym = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name)
    : undefined;
  const decl = sym?.declarations?.[0];
  if (!decl) return { line: 1, excerpt: "" };
  const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
  const excerpt = sf.text.split("\n")[line - 1]?.trim() ?? "";
  return { line, excerpt };
}

/**
 * Reports changes to a file's public contract: exports added, exports
 * removed, and exports whose type signature changed. A changed signature is
 * the class of change that breaks callers without breaking the build at the
 * point of change, which is why it ranks above an added export.
 */
export const surfaceAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const relevant = changeset.files.filter(
    (f) => isTypeScriptFile(f.path) && f.status !== "deleted",
  );
  if (relevant.length === 0) return [];

  const [beforeProgram, afterProgram] = await Promise.all([
    ctx.programAt(ctx.range.from),
    ctx.programAt(ctx.range.to),
  ]);

  const facts: Fact[] = [];

  for (const file of relevant) {
    const beforePath = file.previousPath ?? file.path;
    const before =
      file.status === "added"
        ? new Map<string, string>()
        : exportedSignatures(beforeProgram, ctx.cwd, beforePath);
    const after = exportedSignatures(afterProgram, ctx.cwd, file.path);

    const emit = (
      kind: Fact["kind"],
      name: string,
      detail: Record<string, unknown>,
      where: { line: number; excerpt: string },
      evidenceFile: string,
    ) => {
      const evidence: EvidenceRef[] = [
        { file: evidenceFile, line: where.line, excerpt: where.excerpt },
      ];
      if (!where.excerpt) return; // no evidence, no fact
      facts.push({
        id: `${kind}:${file.path}:${name}`,
        kind,
        file: file.path,
        line: where.line,
        symbol: name,
        detail: { export: name, ...detail },
        evidence,
      });
    };

    for (const [name, afterSig] of after) {
      const beforeSig = before.get(name);
      if (beforeSig === undefined) {
        emit(
          "export_added",
          name,
          { after: afterSig },
          lineOfExport(afterProgram, ctx.cwd, file.path, name),
          file.path,
        );
      } else if (beforeSig !== afterSig) {
        emit(
          "signature_changed",
          name,
          { before: beforeSig, after: afterSig },
          lineOfExport(afterProgram, ctx.cwd, file.path, name),
          file.path,
        );
      }
    }

    for (const [name, beforeSig] of before) {
      if (after.has(name)) continue;
      emit(
        "export_removed",
        name,
        { before: beforeSig },
        lineOfExport(beforeProgram, ctx.cwd, beforePath, name),
        beforePath,
      );
    }
  }

  return facts;
};
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/analyze/surface.test.ts`
Expected: PASS, 3 tests. If type printing differs from the assertions (e.g. `{ id: string; } | null` versus `{ id: string } | null`), adjust the **assertion** to match what the checker actually prints — do not reformat the fixture to chase a string.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/surface.ts src/types.ts test/analyze/surface.test.ts
git commit -m "feat(analyze): surface analyzer for public contract changes"
```

---

### Task 5: The blast-radius analyzer

Answers "how nervous should I be" with a number: how many places reference a changed export. The spec calls this the single most useful signal for that question.

**Files:**
- Create: `src/analyze/blast-radius.ts`
- Modify: `src/types.ts` (`FactKind` gains `blast_radius`)
- Test: `test/analyze/blast-radius.test.ts`

**Interfaces:**
- Consumes: `ctx.programAt`; `relativePathOf` from `./program.js`
- Produces:
  - `countReferences(program: ts.Program, root: string, path: string, name: string): EvidenceRef[]` — one ref per referencing site, excluding the declaration itself
  - `blastRadiusAnalyzer: Analyzer`

- [ ] **Step 1: Add the fact kind**

Append `| "blast_radius"` to `FactKind` in `src/types.ts`.

- [ ] **Step 2: Write the failing test**

Create `test/analyze/blast-radius.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { blastRadiusAnalyzer } from "../../src/analyze/blast-radius.js";
import { createContext, extract } from "../../src/extract/index.js";

let repo: string;

function run(args: string[]) {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-blast-"));
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "core.ts"),
    "export function used(n: number): number {\n  return n;\n}\nexport function lonely(): number {\n  return 0;\n}\n",
  );
  for (const c of ["a", "b", "c"]) {
    writeFileSync(
      join(repo, "src", `${c}.ts`),
      `import { used } from "./core.js";\nexport const ${c} = used(1);\n`,
    );
  }
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);

  writeFileSync(
    join(repo, "src", "core.ts"),
    "export function used(n: number): number {\n  return n + 1;\n}\nexport function lonely(): number {\n  return 0;\n}\n",
  );
});

describe("blastRadiusAnalyzer", () => {
  it("counts references to a changed export across the program", async () => {
    const cs = await extract(repo);
    const facts = await blastRadiusAnalyzer(cs, createContext(repo, cs.range));
    const f = facts.find((x) => x.symbol === "used");
    expect(f).toBeDefined();
    expect(f!.kind).toBe("blast_radius");
    expect(f!.detail.references).toBe(3);
    expect(f!.evidence.length).toBeGreaterThan(0);
    expect(f!.evidence[0].file).not.toBe("src/core.ts");
  });

  it("does not report an export with no references", async () => {
    const cs = await extract(repo);
    const facts = await blastRadiusAnalyzer(cs, createContext(repo, cs.range));
    expect(facts.map((f) => f.symbol)).not.toContain("lonely");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/analyze/blast-radius.test.ts`
Expected: FAIL — cannot resolve `../../src/analyze/blast-radius.js`.

- [ ] **Step 4: Implement the analyzer**

Create `src/analyze/blast-radius.ts`. Reference-finding walks the program's identifiers and compares resolved symbols, rather than using the language service — the program is already built, and this keeps the dependency surface to `ts.Program`:

```ts
import { join } from "node:path";
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";
import { relativePathOf } from "./program.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

const MAX_EVIDENCE = 5;

/**
 * Every identifier in the program that resolves to the named export of the
 * given file, excluding the declaration itself. Aliased imports resolve
 * through `getAliasedSymbol`, so `import { used as u }` still counts.
 */
export function countReferences(
  program: ts.Program,
  root: string,
  path: string,
  name: string,
): EvidenceRef[] {
  const checker = program.getTypeChecker();
  const declFile = program.getSourceFile(join(root, path));
  if (!declFile) return [];

  const moduleSymbol = checker.getSymbolAtLocation(declFile);
  if (!moduleSymbol) return [];
  const target = checker
    .getExportsOfModule(moduleSymbol)
    .find((s) => s.getName() === name);
  if (!target) return [];

  const declarations = new Set(target.declarations ?? []);
  const refs: EvidenceRef[] = [];

  const resolve = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!sym) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const relPath = relativePathOf(root, sf);
    const lines = sf.text.split("\n");

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name) {
        const inDeclaration = declarations.has(node.parent);
        if (!inDeclaration && resolve(checker.getSymbolAtLocation(node)) === target) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          refs.push({
            file: relPath,
            line,
            excerpt: (lines[line - 1] ?? "").trim(),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return refs;
}

/**
 * Reports how widely a changed export is used. Only symbols that actually
 * changed are considered — a busy export nobody touched is not news.
 */
export const blastRadiusAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const relevant = changeset.files.filter(
    (f) =>
      isTypeScriptFile(f.path) &&
      f.status !== "deleted" &&
      f.symbols.some((s) => s.exported && s.change !== "removed"),
  );
  if (relevant.length === 0) return [];

  const program = await ctx.programAt(ctx.range.to);
  const facts: Fact[] = [];

  for (const file of relevant) {
    for (const sym of file.symbols) {
      if (!sym.exported || sym.change === "removed") continue;

      const refs = countReferences(program, ctx.cwd, file.path, sym.name);
      // Nothing references it, so there is no blast radius to report — and
      // no evidence to show, which would violate the evidence rule anyway.
      if (refs.length === 0) continue;

      facts.push({
        id: `blast_radius:${file.path}:${sym.qualifiedName}`,
        kind: "blast_radius",
        file: file.path,
        line: sym.range.startLine || 1,
        symbol: sym.name,
        detail: { symbol: sym.name, references: refs.length },
        evidence: refs.slice(0, MAX_EVIDENCE),
      });
    }
  }

  return facts;
};
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/analyze/blast-radius.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/blast-radius.ts src/types.ts test/analyze/blast-radius.test.ts
git commit -m "feat(analyze): blast-radius analyzer"
```

---

### Task 6: Import-specifier effect resolution

Closes the false-negative half of the effects analyzer's precision gap. `import { readFile as rf } from "node:fs/promises"` currently reads as no effect at all; after this it reads as a filesystem effect.

**Files:**
- Modify: `src/analyze/effects.ts`
- Test: `test/analyze/effects.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new
- Produces: no new exports; `detectEffects` gains import awareness

- [ ] **Step 1: Write the failing test**

Append to the `detectEffects` describe block in `test/analyze/effects.test.ts`:

```ts
  it("resolves a named import from a known effectful module", () => {
    const sites = detectEffects(
      "a.ts",
      'import { readFile } from "node:fs/promises";\nreadFile(p);\n',
    );
    expect(sites.map((s) => s.kind)).toContain("filesystem");
  });

  it("resolves an aliased import", () => {
    const sites = detectEffects(
      "a.ts",
      'import { readFile as rf } from "fs/promises";\nrf(p);\n',
    );
    expect(sites.map((s) => s.kind)).toContain("filesystem");
  });

  it("resolves a namespace import", () => {
    const sites = detectEffects(
      "a.ts",
      'import * as fsp from "node:fs/promises";\nfsp.readFile(p);\n',
    );
    expect(sites.map((s) => s.kind)).toContain("filesystem");
  });

  it("resolves a default import of an effectful module", () => {
    const sites = detectEffects(
      "a.ts",
      'import http from "node:http";\nhttp.get(u);\n',
    );
    expect(sites.map((s) => s.kind)).toContain("network");
  });

  it("does not fire on an unrelated module's import", () => {
    expect(
      detectEffects("a.ts", 'import { join } from "node:path";\njoin(a, b);\n'),
    ).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/analyze/effects.test.ts`
Expected: FAIL on the four positive cases — the identifier tables do not know `readFile`, `rf`, `fsp`, or `http` as effectful.

- [ ] **Step 3: Implement module-specifier resolution**

In `src/analyze/effects.ts`, add the module table and a binding pass, then consult the bindings during the walk. Add near the existing tables:

```ts
/**
 * Module specifiers whose imports carry an effect. Matched after stripping a
 * `node:` prefix, so "node:fs/promises" and "fs/promises" are one entry.
 * This is specifier-based and purely syntactic: it needs no type checker,
 * and it closes the aliased-import blind spot the identifier tables have.
 */
const MODULE_EFFECTS: Record<string, EffectKind> = {
  fs: "filesystem",
  "fs/promises": "filesystem",
  http: "network",
  https: "network",
  http2: "network",
  net: "network",
  dns: "network",
  undici: "network",
  axios: "network",
  "node-fetch": "network",
  child_process: "process",
  cluster: "process",
  worker_threads: "process",
  pg: "database",
  mysql: "database",
  mysql2: "database",
  sqlite3: "database",
  "better-sqlite3": "database",
  mongodb: "database",
  ioredis: "database",
  redis: "database",
};

function moduleEffect(specifier: string): EffectKind | undefined {
  const s = specifier.replace(/^node:/, "");
  return MODULE_EFFECTS[s];
}
```

Note the lookup is exact-match after stripping `node:`, not prefix-match — `fs/promises` needs its own entry precisely because `fs` would not cover it.

Then collect bindings before walking:

```ts
/** Local identifier → effect, from this file's import declarations. */
function importBindings(sf: ts.SourceFile): Map<string, EffectKind> {
  const out = new Map<string, EffectKind>();

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const effect = moduleEffect(stmt.moduleSpecifier.text);
    if (!effect) continue;

    const clause = stmt.importClause;
    if (!clause) continue;

    // `import http from "node:http"`
    if (clause.name) out.set(clause.name.text, effect);

    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      // `import * as fsp from "node:fs/promises"`
      out.set(bindings.name.text, effect);
    } else {
      // `import { readFile as rf } from "fs/promises"` — the local name is
      // `bindings.elements[i].name`, which is what appears at call sites.
      for (const el of bindings.elements) out.set(el.name.text, effect);
    }
  }

  return out;
}
```

Inside `detectEffects`, build the map once and consult it in the visitor, before the existing identifier tables:

```ts
  const bindings = importBindings(sf);
```

```ts
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const q = qualifiedName(node);
      if (q && QUALIFIED_EFFECTS[q]) {
        push(node, QUALIFIED_EFFECTS[q]);
      } else if (ts.isIdentifier(node.expression)) {
        const bound = bindings.get(node.expression.text);
        if (bound) {
          push(node, bound);
        } else if (OBJECT_EFFECTS[node.expression.text]) {
          push(node, OBJECT_EFFECTS[node.expression.text]);
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const bound = bindings.get(node.expression.text);
      if (bound) {
        push(node, bound);
      } else if (GLOBAL_CALLS[node.expression.text]) {
        push(node, GLOBAL_CALLS[node.expression.text]);
      }
    }
    ts.forEachChild(node, visit);
  };
```

- [ ] **Step 4: Update the limitation comment**

The comment above the pattern tables states that detection cannot see aliased imports. That is now half-false. Rewrite it to say what is still true: identifier-table matching remains scope-blind (a local `const db = new Map()` still false-positives), while imports from known modules are now resolved by specifier including aliases; what remains unresolved is an import from a module not in the table, and re-exported or dynamically-imported bindings.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/analyze/effects.test.ts && npm test`
Expected: PASS. The existing effects tests still hold — the identifier tables are unchanged, only consulted second.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/effects.ts test/analyze/effects.test.ts
git commit -m "feat(analyze): resolve effects through import specifiers"
```

---

### Task 7: Score and describe the new fact kinds

Every new fact kind needs a weight and human-readable text, or it ranks at zero and renders as an empty sentence.

**Files:**
- Modify: `src/score/index.ts`
- Test: `test/score/index.test.ts` (extend)

**Interfaces:**
- Consumes: the six `FactKind` members now defined
- Produces: no new exports; `WEIGHTS.factKind` covers every kind, `toFinding` produces text for each

- [ ] **Step 1: Write the failing test**

Append to `test/score/index.test.ts`:

```ts
describe("new fact kinds", () => {
  const of = (over: Partial<Fact>): Fact => ({
    id: "x",
    kind: "guard_removed",
    file: "a.ts",
    line: 3,
    detail: {},
    evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
    ...over,
  });

  it("ranks a removed guard above an added effect", () => {
    expect(
      scoreFact(of({ kind: "guard_removed", detail: { guard: "if", symbol: "validate" } })),
    ).toBeGreaterThan(
      scoreFact(of({ kind: "effect_added", detail: { effect: "network", sites: 1 } })),
    );
  });

  it("ranks a changed signature above an added export", () => {
    expect(
      scoreFact(of({ kind: "signature_changed", detail: { export: "f" } })),
    ).toBeGreaterThan(scoreFact(of({ kind: "export_added", detail: { export: "g" } })));
  });

  it("scales blast radius with the reference count, sub-linearly", () => {
    const three = scoreFact(of({ kind: "blast_radius", detail: { references: 3 } }));
    const forty = scoreFact(of({ kind: "blast_radius", detail: { references: 40 } }));
    const eighty = scoreFact(of({ kind: "blast_radius", detail: { references: 80 } }));
    expect(forty).toBeGreaterThan(three);
    expect(eighty - forty).toBeLessThan(forty - three);
  });

  it("writes readable text for every new kind", () => {
    const cases: Fact[] = [
      of({ kind: "guard_removed", detail: { guard: "if", symbol: "validate" } }),
      of({ kind: "export_added", detail: { export: "addedLater" } }),
      of({ kind: "export_removed", detail: { export: "willBeRemoved" } }),
      of({
        kind: "signature_changed",
        detail: { export: "findByEmail", before: "(e: string) => X", after: "(e: string) => X | null" },
      }),
      of({ kind: "blast_radius", detail: { symbol: "used", references: 34 } }),
    ];
    for (const f of cases) {
      const finding = toFinding(f);
      expect(finding.title.length).toBeGreaterThan(0);
      expect(finding.body.length).toBeGreaterThan(0);
      expect(finding.title).not.toContain("undefined");
      expect(finding.body).not.toContain("undefined");
      expect(finding.score).toBeGreaterThan(0);
    }
  });

  it("names the symbol and count in the blast-radius text", () => {
    const f = toFinding(of({ kind: "blast_radius", detail: { symbol: "used", references: 34 } }));
    expect(f.title).toContain("used");
    expect(f.body).toContain("34");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/score/index.test.ts`
Expected: FAIL — `WEIGHTS.factKind` has no entry for the new kinds, so scores are `NaN`, and `toFinding` falls through to effect-shaped text mentioning `undefined`.

- [ ] **Step 3: Extend the weights**

In `src/score/index.ts`, replace the `factKind` table:

```ts
export const WEIGHTS = {
  factKind: {
    // A vanished check is the best mechanical proxy for a correctness or
    // security regression, so it outranks everything else.
    guard_removed: 90,
    // Breaks callers without breaking the build here.
    signature_changed: 75,
    export_removed: 70,
    effect_added: 60,
    blast_radius: 40,
    export_added: 25,
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
```

- [ ] **Step 4: Score each kind on its own terms**

Replace `scoreFact`:

```ts
export function scoreFact(fact: Fact): number {
  const base = WEIGHTS.factKind[fact.kind];

  if (fact.kind === "effect_added" || fact.kind === "effect_removed") {
    return base * WEIGHTS.effect[effectOf(fact)];
  }

  if (fact.kind === "blast_radius") {
    // Log-scaled: three callers and forty are meaningfully different, forty
    // and eighty are not.
    const refs = typeof fact.detail.references === "number" ? fact.detail.references : 1;
    return base * (1 + Math.log10(Math.max(refs, 1)));
  }

  return base;
}
```

- [ ] **Step 5: Write text for each kind**

Replace `toFinding`'s title/body construction with a per-kind switch. Keep the existing effect wording exactly as it is — those strings are asserted by existing tests:

```ts
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

export function toFinding(fact: Fact): Finding {
  let title: string;
  let body: string;

  switch (fact.kind) {
    case "effect_added":
    case "effect_removed": {
      const effect = effectOf(fact);
      const sites = num(fact.detail.sites, 1);
      const where = sites === 1 ? "at one site" : `at ${sites} sites`;
      title =
        fact.kind === "effect_added"
          ? `introduces ${article(effect)} ${effect} effect`
          : `no longer has ${article(effect)} ${effect} effect`;
      body =
        fact.kind === "effect_added"
          ? `This file previously had no ${effect} effect. It now does, ${where}.`
          : `This file previously had ${article(effect)} ${effect} effect ${where}. It no longer does.`;
      break;
    }
    case "guard_removed": {
      const symbol = str(fact.detail.symbol, "this code");
      const guard = str(fact.detail.guard, "check");
      title = `${article(guard)} ${guard} guard was removed from ${symbol}`;
      body = `${article(guard)[0].toUpperCase()}${article(guard).slice(1)} ${guard} that previously ran in ${symbol} is no longer present. Removed checks are where correctness and security regressions usually hide, so confirm the condition is genuinely unreachable now.`;
      break;
    }
    case "export_added": {
      const name = str(fact.detail.export, "an export");
      title = `${name} is newly exported`;
      body = `This file did not export ${name} before. New public surface is worth a look, but it cannot break an existing caller.`;
      break;
    }
    case "export_removed": {
      const name = str(fact.detail.export, "an export");
      title = `${name} is no longer exported`;
      body = `This file previously exported ${name}. Anything importing it will fail to resolve.`;
      break;
    }
    case "signature_changed": {
      const name = str(fact.detail.export, "an export");
      const before = str(fact.detail.before, "its previous type");
      const after = str(fact.detail.after, "a new type");
      title = `${name} changed signature`;
      body = `${name} was ${before} and is now ${after}. A changed contract can break callers without breaking the build at this file, so check the call sites.`;
      break;
    }
    case "blast_radius": {
      const symbol = str(fact.detail.symbol, "this export");
      const refs = num(fact.detail.references, 0);
      const places = refs === 1 ? "one place" : `${refs} places`;
      title = `${symbol} changed and is referenced in ${places}`;
      body = `${symbol} was modified, and ${places} in this repository reference it. The wider the reach, the more a subtle change costs.`;
      break;
    }
  }

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
```

If `article` does not already exist from Plan 1's fix wave, add it:

```ts
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/score/index.test.ts && npm test`
Expected: PASS. Existing effect-wording assertions still hold.

- [ ] **Step 7: Commit**

```bash
git add src/score/index.ts test/score/index.test.ts
git commit -m "feat(score): weights and wording for contract, guard, and reach findings"
```

---

### Task 8: Register the analyzers and verify end to end

Turns four separate analyzers into one review. Deliverable: `urtext review` on a repository with a removed guard, a changed export, and a new effect reports all three, ranked.

**Files:**
- Modify: `src/analyze/index.ts`
- Test: `test/analyze/index.test.ts` (new — an integration test over all four)
- Modify: `README.md` (what the analyzers detect)

**Interfaces:**
- Consumes: all four analyzers
- Produces: `ANALYZERS` containing four entries

- [ ] **Step 1: Write the failing integration test**

Create `test/analyze/index.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ANALYZERS, runAnalyzers } from "../../src/analyze/index.js";
import { createContext, extract } from "../../src/extract/index.js";
import { rank } from "../../src/score/index.js";

let repo: string;

function run(args: string[]) {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "urtext-all-"));
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "T"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(
    join(repo, "src", "session.ts"),
    [
      "export function validate(token: string): { ok: boolean } {",
      "  if (!token) {",
      '    throw new Error("missing token");',
      "  }",
      "  return { ok: true };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "src", "caller.ts"),
    'import { validate } from "./session.js";\nexport const r = validate("x");\n',
  );
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);

  // Removes a guard, widens the return type, and adds a network effect.
  writeFileSync(
    join(repo, "src", "session.ts"),
    [
      "export async function validate(token: string): Promise<{ ok: boolean } | null> {",
      "  const res = await fetch(`https://auth.example.com/${token}`);",
      "  return res.ok ? { ok: true } : null;",
      "}",
      "",
    ].join("\n"),
  );
});

describe("all analyzers together", () => {
  it("registers four analyzers", () => {
    expect(ANALYZERS).toHaveLength(4);
  });

  it("reports the guard, the contract change, and the effect", async () => {
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range));
    const kinds = new Set(facts.map((f) => f.kind));
    expect(kinds).toContain("guard_removed");
    expect(kinds).toContain("signature_changed");
    expect(kinds).toContain("effect_added");
  });

  it("ranks the removed guard first", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    expect(findings[0].title).toContain("guard was removed");
  });

  it("gives every finding evidence", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.evidence[0].excerpt.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/analyze/index.test.ts`
Expected: FAIL — `ANALYZERS` has one entry.

- [ ] **Step 3: Register them**

Replace the registry in `src/analyze/index.ts`:

```ts
import type { AnalysisContext, Analyzer, Changeset, Fact } from "../types.js";
import { blastRadiusAnalyzer } from "./blast-radius.js";
import { effectsAnalyzer } from "./effects.js";
import { guardsAnalyzer } from "./guards.js";
import { surfaceAnalyzer } from "./surface.js";

export { detectEffects, effectsAnalyzer } from "./effects.js";
export { collectGuards, guardsAnalyzer } from "./guards.js";
export { exportedSignatures, surfaceAnalyzer } from "./surface.js";
export { countReferences, blastRadiusAnalyzer } from "./blast-radius.js";
export { createProgramAt, listTypeScriptFilesAt } from "./program.js";

export const ANALYZERS: Analyzer[] = [
  effectsAnalyzer,
  guardsAnalyzer,
  surfaceAnalyzer,
  blastRadiusAnalyzer,
];

export async function runAnalyzers(
  changeset: Changeset,
  ctx: AnalysisContext,
  analyzers: Analyzer[] = ANALYZERS,
): Promise<Fact[]> {
  const results = await Promise.all(analyzers.map((a) => a(changeset, ctx)));
  return results.flat();
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Run the tool against this repository**

Run: `npm run review -- HEAD~8`
Expected: a review of this plan's own work. Read the output and confirm it is sensible — the new analyzers should report on the files they added. This is a judgment step, not a test: if a finding looks wrong, say so rather than declaring success.

- [ ] **Step 6: Update the README**

In the "What it does" section, replace the analyzer description with:

```markdown
Four analyzers run over the change:

- **guards** — conditionals, early returns, and throws removed from code that survived
- **surface** — exports added, removed, or changed shape
- **blast radius** — how many places reference a changed export
- **effects** — network, filesystem, process, env, database, and timing effects appearing or disappearing

Findings are ranked, and each carries the evidence behind it.
```

- [ ] **Step 7: Commit**

```bash
git add src/analyze/index.ts test/analyze/index.test.ts README.md
git commit -m "feat(analyze): register guards, surface, and blast-radius analyzers"
```

---

## Self-review notes

**Spec coverage.** The spec's Stage 2 names four analyzers; Plan 1 built `effects`, and Tasks 3-5 build `guards`, `surface`, and `blast-radius`. The spec's importance model lists effect delta, contract change, blast radius, and guard removal as the four deterministic scoring inputs — Task 7 gives each a weight, with guard removal ranked highest and blast radius log-scaled, both as the spec specifies.

**Carried-forward rulings discharged:** scope-qualified symbol names (Task 1) and import-specifier effect resolution (Task 6).

**Deliberately deferred to Plan 3**, consistent with the spec: the interpret stage and the `Claim` type; the `inferred` and `model` tiers (`tierFor` keeps its Plan 1 signature until `Claim` exists to shape it); the HTML report, its lens switcher, and `--open`; writing reports into `.urtext/`; wiring `--no-llm` to something real.

**Known risks worth watching during execution.**

Task 2 is the one that could go wrong. Building a `ts.Program` over a git revision means serving library files from the installed `typescript` package while serving repository files from git, and the boundary between "absent at this revision" and "absent everywhere" is exactly where Plan 1's worst bugs lived. The test asserting zero semantic diagnostics is the canary: if lib resolution is broken, it fails loudly rather than silently producing a program where every type is `any` — which would make the surface analyzer confidently report nonsense under a `verified` badge.

Task 5's reference counting walks every identifier in the program and resolves each candidate through the checker. That is O(identifiers) with a checker call per name match, which is acceptable for a review-sized repository but will be the first thing to feel slow on a large one.

Task 4 builds two programs, roughly doubling analysis time on any change that touches a TypeScript file. If that proves too slow in practice, the fix is to skip the before-program when no file has a changed exported symbol — not to weaken the analysis.
