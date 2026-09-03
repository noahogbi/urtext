# JavaScript Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** urtext's analyzers read the JavaScript in a TypeScript project — `.js`, `.mjs`, `.cjs`, `.jsx` — instead of skipping it silently.

**Architecture:** Two predicates rather than one widened one, because `isTypeScriptFile` must keep meaning what its name says at all fourteen usages. The three analyzers that build their own `SourceFile` read JavaScript unconditionally; the two that need the type checker follow the project's own compiler setting. Machine-written JavaScript is detected once, at extraction.

**Tech Stack:** TypeScript (strict, ESM), vitest, the TypeScript compiler API. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-urtext-javascript-support-design.md` (revision 1, after a Fable review). Read it first — its revision header names four errors already made and corrected, two of which were invisible without running the design.

> **Revision 1, after a Fable review returned REVISE with five blocking findings.** Each was
> checked against the code before being accepted; all five held. Three were failures of the
> plan's own green gate — pasted code that does not compile or a test that cannot pass — which
> is the class this project has shipped twice before.
>
> Two of them were internal TypeScript APIs used as if public. `parseDiagnostics` is absent
> from `typescript.d.ts` exactly as `getAllowJSCompilerOption` was, and I reached for it one
> document after being corrected on the first. The test now casts, locally and deliberately.
>
> The effects fixture could never pass: `action/compose-comment.mjs` imports nothing, and
> `detectEffects` fires only on import bindings and known calls. `compose-comment-bin.mjs` is
> the file that has an effect site.
>
> `mkCanonicalTempDir` is file-local in two test files and exported from neither.
>
> The two that changed Task 5's shape: root selection **cannot** see `ChangedFile.generated`,
> because `createProgramAt` never receives a changeset — so detection is once per layer, not
> once overall, and the plan now says so instead of claiming otherwise. And the disclosure was
> inert: every existing coverage note is imported and called in both `src/cli.ts` and
> `src/report/model.ts`, so an exported function with a passing unit test would have reached
> no reader at all — the same shape as the citations-pathspec defect the spec's own revision
> header leads with.
>
> Eight local defects fixed alongside, including a miscount (twelve calls, not thirteen), a
> table row contradicting Task 6, a filter snippet that would have silently dropped
> blast-radius's exported-symbol clause, and a fabricated `Hunk` shape.

## Global Constraints

- Work continues on one branch; one PR at the end. Never push `master`.
- Every commit leaves BOTH `npx tsc --noEmit` AND `npx vitest run` green. Run them **synchronously in the foreground** with a generous timeout — never background them, never use a Monitor. The full suite takes about two and a half minutes.
- **`noUnusedLocals` is on.** Widening a call site can orphan the `isTypeScriptFile` import in that file and turn it into a *build error*, not a warning. Check each file's remaining usages after editing it.
- **Comments must not contain a bare numeral matching a `WEIGHTS` value** (`test/comment-contract.test.ts` scans `src/` and `test/`). Bare `1` is forbidden (`WEIGHTS.effect.network`) and so is `0.4` (`WEIGHTS.effect.timing`). Write no digits in comments in the files you touch, including in list markers like `// 1.`.
- Reader-facing copy contains none of: `unsanctioned`, `unauthorized`, `approved`, `permission`, `forbidden`, `allowed` (`test/report/copy-guard.test.ts:29-36`), and never issues a verdict.
- Do not use `git add -A`. Stage only the files each task names.
- `test/extract/symbols.test.ts` holds twelve `isTypeScriptFile` calls that pin the predicate **narrow**. They must survive this work unaltered. If one needs editing, the predicate was widened when it should not have been — stop and say so.

> **Line numbers** were verified on 2026-09-03 at commit `7df3519` and drift as tasks land. Anchor on symbol names.

### The fourteen usages, and which tier each becomes

| site | tier |
|---|---|
| `effects.ts:155`, `:265` | syntactic — Task 2 |
| `guards.ts:50`, `:159`, `:251` | syntactic — Task 2 |
| `extract/index.ts:48` | syntactic — Task 2 |
| `extract/symbols.ts:244` | syntactic — Task 2 |
| `citations.ts:367` | syntactic — Task 3 (inert without the pathspec change) |
| `surface.ts:324` | typed — Task 4 |
| `blast-radius.ts:144` | typed — Task 4 |
| `program.ts:67`, `:239` | typed — Task 4 |
| `coverage.ts:167` | **unchanged** — see the spec's "Coverage needs no change" |
| `coverage.ts:26` | widened in Task 6 together with the note's wording, closing the deleted-JavaScript gap |

---

### Task 1: The predicates and one ScriptKind helper

Foundational and behaviour-neutral: nothing is widened yet, so no JavaScript reaches any analyzer at the end of this task. The `ScriptKind` change is a no-op today for the same reason — no `.jsx` can currently reach the four parse sites.

**Files:**
- Modify: `src/extract/symbols.ts` (add three exports; replace the ternary at `:37`)
- Modify: `src/analyze/effects.ts` (ternary at `:162`)
- Modify: `src/analyze/guards.ts` (ternaries at `:57`, `:257`)
- Test: `test/extract/symbols.test.ts`

**Interfaces:**
- Produces: `isJavaScriptFile(path: string): boolean`, `isSyntacticSource(path: string): boolean`, `scriptKindFor(path: string): ts.ScriptKind` — all exported from `src/extract/symbols.ts`.
- Consumed by Tasks 2, 3, 4 and 5 exactly as named.

- [ ] **Step 1: Write the failing tests**

Append to `test/extract/symbols.test.ts`. Import `isJavaScriptFile`, `isSyntacticSource`, `scriptKindFor` alongside the existing imports, and `ts` from `typescript`:

```typescript
describe("isJavaScriptFile", () => {
  it("accepts every extension the language has", () => {
    for (const p of ["a.js", "a.mjs", "a.cjs", "a.jsx", "deep/dir/a.mjs"]) {
      expect(isJavaScriptFile(p)).toBe(true);
    }
  });

  it("rejects TypeScript, data, prose, and near-misses", () => {
    for (const p of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.json", "a.md", "a.js.map", "ajs"]) {
      expect(isJavaScriptFile(p)).toBe(false);
    }
  });
});

describe("isSyntacticSource", () => {
  it("is the union of the two languages", () => {
    for (const p of ["a.ts", "a.mts", "a.tsx", "a.js", "a.mjs", "a.jsx"]) {
      expect(isSyntacticSource(p)).toBe(true);
    }
    for (const p of ["a.json", "a.md", "a.yml", "a.d.ts"]) {
      expect(isSyntacticSource(p)).toBe(false);
    }
  });
});

describe("scriptKindFor", () => {
  it("gives each extension the kind that parses it", () => {
    expect(scriptKindFor("a.tsx")).toBe(ts.ScriptKind.TSX);
    expect(scriptKindFor("a.jsx")).toBe(ts.ScriptKind.JSX);
    expect(scriptKindFor("a.js")).toBe(ts.ScriptKind.JS);
    expect(scriptKindFor("a.mjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKindFor("a.cjs")).toBe(ts.ScriptKind.JS);
    expect(scriptKindFor("a.ts")).toBe(ts.ScriptKind.TS);
    expect(scriptKindFor("a.mts")).toBe(ts.ScriptKind.TS);
  });

  it("parses JSX with no diagnostics, in both the .jsx and .js spellings", () => {
    // The assertion is on diagnostics, not on findings. TypeScript's error
    // recovery salvages top-level names from mis-parsed JSX, so a
    // findings-based test passes while the parse is garbage.
    //
    // `parseDiagnostics` is NOT in TypeScript's public typed API. It is
    // internal, exactly like `getAllowJSCompilerOption`, and reading it off a
    // bare SourceFile is TS2339. The cast is deliberate and confined to this
    // test; production code must not depend on it.
    type Parsed = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
    const jsx = 'const el = <div className="a">hi</div>;
';
    const parseAs = (path: string, kind: ts.ScriptKind): Parsed =>
      ts.createSourceFile(path, jsx, ts.ScriptTarget.ES2022, true, kind) as Parsed;

    for (const path of ["a.jsx", "a.js"]) {
      expect(parseAs(path, scriptKindFor(path)).parseDiagnostics ?? []).toHaveLength(0);
    }
    // And the old behaviour is genuinely broken, so the test above means something.
    expect((parseAs("a.jsx", ts.ScriptKind.TS).parseDiagnostics ?? []).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/extract/symbols.test.ts`
Expected: FAIL — the three functions do not exist, so this will not typecheck either.

- [ ] **Step 3: Add the three exports**

In `src/extract/symbols.ts`, immediately below `isTypeScriptFile`:

```typescript
/**
 * A JavaScript implementation file, in every extension the language has.
 * There is no `.mjsx`/`.cjsx` — JSX never got module-explicit flavours — and
 * no declaration flavour to exclude, JavaScript having no `.d.js`.
 */
export function isJavaScriptFile(path: string): boolean {
  return /\.(?:js|mjs|cjs|jsx)$/.test(path);
}

/**
 * Source an analyzer can read on its own: TypeScript or JavaScript.
 *
 * Named for the capability rather than the languages because that is what the
 * call sites are choosing. An analyzer that builds its own SourceFile can read
 * either; one that needs the type checker can only read what the project's
 * compiler options admit, which is a different question asked elsewhere.
 */
export function isSyntacticSource(path: string): boolean {
  return isTypeScriptFile(path) || isJavaScriptFile(path);
}

/**
 * The ScriptKind a path must be parsed under.
 *
 * `.jsx` is tested before the general JavaScript case because it is both, and
 * JSX is the one that matters: parsed as TypeScript, `<div className="a">`
 * reads as a type assertion and the file yields parse errors. Plain
 * JavaScript is given its own kind for the same reason — JSX inside a `.js`
 * file is the Babel convention and mis-parses identically.
 */
export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (isJavaScriptFile(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
```

- [ ] **Step 4: Replace all four ternaries**

There are **four**, not two. Each currently reads:

```typescript
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
```

Replace each with `scriptKindFor(path),` at:
- `src/extract/symbols.ts:37` (inside `parse`, which `mapSymbols` calls — the one Task 2 routes `.jsx` through)
- `src/analyze/effects.ts:162`
- `src/analyze/guards.ts:57`
- `src/analyze/guards.ts:257`

`effects.ts` and `guards.ts` already import from `../extract/symbols.js`; add `scriptKindFor` to those imports.

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, with the existing thirteen `isTypeScriptFile` assertions in this file untouched.

- [ ] **Step 6: Commit**

```bash
git add src/extract/symbols.ts src/analyze/effects.ts src/analyze/guards.ts test/extract/symbols.test.ts
git commit -m "feat: predicates for JavaScript source, and one ScriptKind helper"
```

---

### Task 2: Effects, guards and extraction read JavaScript

The first task with visible behaviour. It also changes the report's exported-symbol table and the model's prompt, in every project — see Interfaces.

**Files:**
- Modify: `src/analyze/effects.ts` (`:155`, `:265`)
- Modify: `src/analyze/guards.ts` (`:50`, `:159`, `:251`)
- Modify: `src/extract/index.ts` (`:48` and the comment above it)
- Modify: `src/extract/symbols.ts` (`:244`)
- Modify: `src/types.ts` (the `ChangedFile.symbols` comment)
- Test: `test/analyze/source-coverage.test.ts` (create), `test/analyze/effects.test.ts`, `test/analyze/guards.test.ts`

**Interfaces:**
- Consumes: `isSyntacticSource` from Task 1.
- Produces: `changeset.files[].symbols` is populated for JavaScript files. Two consumers beyond the analyzers see this immediately — `src/report/model.ts:864` (`surfaceSymbols`, the report's exported-symbol table) and `src/interpret/prompt.ts:117-118` (the model's prompt). This is intended, not incidental.

- [ ] **Step 1: Write the table test — the centre of this plan's safety**

Create `test/analyze/source-coverage.test.ts`. This is the guard against the failure `isTypeScriptFile`'s own comment records: a file class invisible to one analyzer, silently.

```typescript
import { describe, expect, it } from "vitest";
import { detectEffects } from "../../src/analyze/effects.js";
import { collectGuards } from "../../src/analyze/guards.js";
import { mapSymbols } from "../../src/extract/symbols.js";

/**
 * One table over extensions. Every syntactic analyzer runs over the same
 * source in each extension, so a call site missed in one analyzer changes a
 * cell here instead of vanishing. The predicate this pins has already caused
 * the silent-invisibility failure once; see isTypeScriptFile's comment.
 */
const SOURCE = [
  'import { readFileSync } from "node:fs";',
  "export function pick(a) {",
  '  if (!a) throw new Error("no");',
  '  return readFileSync("f");',
  "}",
].join("\n");

const SYNTACTIC = ["a.ts", "a.mts", "a.cts", "a.tsx", "a.js", "a.mjs", "a.cjs", "a.jsx"];
const NOT_SOURCE = ["a.json", "a.md", "a.yml", "a.d.ts"];

const hunk = () => [{ startLine: 1, lineCount: SOURCE.split("\n").length }];

describe("every syntactic analyzer reads every source extension", () => {
  it.each(SYNTACTIC)("effects reads %s", (path) => {
    expect(detectEffects(path, SOURCE).length).toBeGreaterThan(0);
  });

  it.each(SYNTACTIC)("guards reads %s", (path) => {
    expect(collectGuards(path, SOURCE).length).toBeGreaterThan(0);
  });

  it.each(SYNTACTIC)("symbol extraction reads %s", (path) => {
    expect(mapSymbols(path, null, SOURCE, hunk() as never).length).toBeGreaterThan(0);
  });

  it.each(NOT_SOURCE)("nothing reads %s", (path) => {
    expect(detectEffects(path, SOURCE)).toEqual([]);
    expect(collectGuards(path, SOURCE)).toEqual([]);
    expect(mapSymbols(path, null, SOURCE, hunk() as never)).toEqual([]);
  });
});
```

Check the real signatures of `detectEffects`, `collectGuards` and `mapSymbols` before writing this — they are exported from `src/analyze/index.ts` and `src/extract/symbols.ts` — and adjust the argument shapes to match rather than forcing them with casts where a real value will do.

- [ ] **Step 2: Run and confirm the JavaScript rows fail**

Run: `npx vitest run test/analyze/source-coverage.test.ts`
Expected: the four TypeScript rows pass for each analyzer; the four JavaScript rows FAIL. If a JavaScript row already passes, that analyzer was not gated the way this plan assumes — stop and report it.

- [ ] **Step 3: Widen the five analyzer call sites**

Change `isTypeScriptFile` to `isSyntacticSource` at `effects.ts:155`, `effects.ts:265`, `guards.ts:50`, `guards.ts:159`, `guards.ts:251`. Update each file's import. Check whether `isTypeScriptFile` still has a user in each file — if not, remove it from the import or `noUnusedLocals` fails the build.

- [ ] **Step 4: Widen extraction, and correct the two comments it makes false**

`src/extract/symbols.ts:244` — `isTypeScriptFile` becomes `isSyntacticSource`.

`src/extract/index.ts:48` — the same change, and the comment above it currently reads "mapSymbols discards non-TypeScript files anyway; reading them out of git first only pulls lockfiles and binaries into memory as utf8." Rewrite it to say what is now true: that `mapSymbols` reads both languages, and the gate exists to keep lockfiles and binaries out of memory.

`src/types.ts` — `ChangedFile.symbols` is documented "Empty for files that are not TypeScript." Rewrite to name both languages.

- [ ] **Step 5: Add the two behavioural tests**

In `test/analyze/effects.test.ts`, following that file's existing style:

```typescript
it("reads this repository's own shipped JavaScript", () => {
  // compose-comment-bin.mjs, NOT compose-comment.mjs. The composer imports
  // nothing — its own header says so — and detectEffects fires only on import
  // bindings and known global/object/qualified calls, so asserting a finding
  // there asserts something that cannot happen. The bin wrapper imports
  // node:fs and does have an effect site.
  const path = "action/compose-comment-bin.mjs";
  expect(detectEffects(path, readFileSync(path, "utf8")).length).toBeGreaterThan(0);
});
```

In `test/analyze/guards.test.ts`, a `.mjs` fixture containing a throwing early return, asserting the guard is collected with its real line.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. Existing report tests may now see symbols for JavaScript files in their fixtures — if one fails, read it before changing it: the new value is probably correct and the fixture's expectation is what changed.

- [ ] **Step 7: Commit**

```bash
git add src/analyze/effects.ts src/analyze/guards.ts src/extract/index.ts src/extract/symbols.ts \n  src/types.ts test/analyze/source-coverage.test.ts test/analyze/effects.test.ts test/analyze/guards.test.ts
git commit -m "feat: effects, guards and symbol extraction read JavaScript"
```

---

### Task 3: Citations reach JavaScript, and a documented under-report closes

**Files:**
- Modify: `src/analyze/citations.ts` (`CITATION_PATHSPECS` at `:68` and its comment at `:62-67`; the dispatch at `:367`)
- Test: `test/analyze/citations.test.ts`

**Interfaces:**
- Consumes: `isSyntacticSource` from Task 1.
- Produces: citations written in `.js`/`.mjs`/`.cjs`/`.jsx` **and** `.mts`/`.cts` are checked.

- [ ] **Step 1: Write the failing tests**

Two cases — the feature, and the pre-existing bug it closes:

```typescript
it("checks a citation written in a JavaScript comment", () => {
  // The dispatch in citationsIn is not the gate. CITATION_PATHSPECS decides
  // which files ever become candidates, so widening the dispatch alone
  // leaves this dead.
  expect([...CITATION_PATHSPECS]).toContain("*.mjs");
  expect(citationsIn("a.mjs", '// see src/x.ts:3\n')).toHaveLength(1);
});

it("checks a citation written in a module-explicit TypeScript comment", () => {
  // A pre-existing under-report the pathspec comment has documented all
  // along: isTypeScriptFile accepts .mts, no pathspec named it.
  expect([...CITATION_PATHSPECS]).toContain("*.mts");
  expect(citationsIn("a.mts", '// see src/x.ts:3\n')).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/analyze/citations.test.ts`
Expected: FAIL on the pathspec assertions.

- [ ] **Step 3: Widen the pathspecs and the dispatch**

```typescript
export const CITATION_PATHSPECS = [
  "*.md",
  "*.markdown",
  "*.txt",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  "*.js",
  "*.mjs",
  "*.cjs",
  "*.jsx",
] as const;
```

Change `citations.ts:367` from `isTypeScriptFile` to `isSyntacticSource`, and check the import: if `isTypeScriptFile` has no other user in this file, remove it or the build fails on `noUnusedLocals`.

- [ ] **Step 4: Rewrite the comment, which now describes a gap that no longer exists**

The comment at `:62-67` says the list is "narrower than `isTypeScriptFile` accepts — it also takes the module-explicit extensions, which no pathspec here names — so a citation written in one of those files is not checked at all. An under-report." That stops being true. Replace it with a comment describing the list as it then is, and say that it must stay in step with `isSyntacticSource` — the two drifting apart is what caused the under-report this commit closes.

- [ ] **Step 5: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. The citations sweep now visits more files; if a test asserting a sweep count fails, the new count is probably correct — read it before editing.

- [ ] **Step 6: Commit**

```bash
git add src/analyze/citations.ts test/analyze/citations.test.ts
git commit -m "feat: citations checked in JavaScript, closing the module-explicit under-report too"
```

---

### Task 4: The typed tier follows the project's compiler options

**Files:**
- Modify: `src/analyze/program.ts` (`compilerOptions` at `:71`; the host filter at `:205`; roots at `:239`; rename `listTypeScriptFilesAt` at `:63-68`)
- Modify: `src/analyze/index.ts` (the re-export of the renamed function)
- Modify: `src/analyze/surface.ts` (`:324`), `src/analyze/blast-radius.ts` (`:144`)
- Test: `test/analyze/program.test.ts`, `test/analyze/surface.test.ts`

**Interfaces:**
- Produces: `export function allowsJavaScript(root: string): boolean` from `src/analyze/program.ts`, and `listTypeScriptFilesAt` renamed to `listProgramSourcesAt` with the same `(root, rev)` signature.

- [ ] **Step 1: Write the failing tests**

`mkCanonicalTempDir` is **not exported anywhere** — it is a file-local `const` in
`test/cli.test.ts:51` and `test/action/compose-comment.test.ts:31`, while
`test/analyze/program.test.ts` uses bare `mkdtempSync`. Define it locally at the top of the
file, adding `realpathSync` to its `node:fs` import:

```typescript
const mkCanonicalTempDir = (prefix: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));
```

```typescript
describe("allowsJavaScript", () => {
  it("follows checkJs even when allowJs is unset", () => {
    // TypeScript turns JavaScript on when checkJs is set, leaving allowJs
    // undefined. Reading the raw field would exclude a project whose
    // compiler does include its JavaScript.
    const dir = mkCanonicalTempDir("urtext-allowjs-");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { checkJs: true } }));
    expect(allowsJavaScript(dir)).toBe(true);
  });

  it("is false for a project that sets neither, and for one with no tsconfig", () => {
    const bare = mkCanonicalTempDir("urtext-allowjs-none-");
    expect(allowsJavaScript(bare)).toBe(false);
    const empty = mkCanonicalTempDir("urtext-allowjs-empty-");
    writeFileSync(join(empty, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    expect(allowsJavaScript(empty)).toBe(false);
  });

  it("is true for this repository, which sets both", () => {
    expect(allowsJavaScript(process.cwd())).toBe(true);
  });

  it("agrees with the compiler's own rule, which is not public API", () => {
    // allowsJavaScript spells out a rule TypeScript implements internally as
    // getAllowJSCompilerOption. That function is absent from the public typed
    // API — using it is a compile error — so the rule is duplicated, and this
    // pins the duplicate against the original so a future TypeScript cannot
    // drift from it silently.
    const internal = (ts as unknown as {
      getAllowJSCompilerOption?: (o: ts.CompilerOptions) => boolean;
    }).getAllowJSCompilerOption;
    if (!internal) return; // gone from the runtime: nothing to compare against
    for (const compilerOptions of [
      { checkJs: true },
      { allowJs: true },
      {},
      { allowJs: false, checkJs: true },
      { allowJs: true, checkJs: false },
    ]) {
      const parsed = ts.parseJsonConfigFileContent({ compilerOptions }, ts.sys, process.cwd()).options;
      expect(parsed.allowJs ?? Boolean(parsed.checkJs)).toBe(internal(parsed));
    }
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/analyze/program.test.ts`
Expected: FAIL — `allowsJavaScript` does not exist.

- [ ] **Step 3: Add the helper and widen the program**

In `src/analyze/program.ts`:

```typescript
/**
 * Whether the project's own compiler configuration includes its JavaScript.
 *
 * Not `options.allowJs` alone: TypeScript turns JavaScript on when `checkJs`
 * is set while leaving `allowJs` unset, so reading the raw field excludes a
 * project whose compiler does include it — the silent-invisibility failure
 * this feature is built to avoid.
 *
 * The rule is spelled out here rather than delegated to the compiler's own
 * `getAllowJSCompilerOption`, which is not part of the public typed API and
 * does not compile against it. The two were checked against each other over
 * every combination of the two options and agree on all of them; the test
 * below pins that agreement so a future TypeScript cannot drift from it
 * unnoticed.
 *
 * Reads the tsconfig, never a program: the analyzers that ask this must not
 * pay for a program to learn there is nothing for them to do.
 */
export function allowsJavaScript(root: string): boolean {
  const options = compilerOptions(root);
  return options.allowJs ?? Boolean(options.checkJs);
}
```

`JS_SOURCE` beside `TS_SOURCE`:

```typescript
const JS_SOURCE = /\.(?:js|mjs|cjs|jsx)$/;
```

At `:205`, the host read filter admits JavaScript when the project does:

```typescript
  const js = options.allowJs ?? Boolean(options.checkJs);
  const paths = (await listPathsAt(root, rev)).filter(
    (p) =>
      TS_SOURCE.test(p) ||
      (js && JS_SOURCE.test(p)) ||
      p === "package.json" ||
      p.endsWith("/package.json"),
  );
```

At `:239`, root selection takes the same condition:

```typescript
    if (isTypeScriptFile(p) || (js && isJavaScriptFile(p))) rootNames.push(abs);
```

- [ ] **Step 4: Rename `listTypeScriptFilesAt`**

It can now return `.js`, so its name becomes false the moment it does — the class of defect this project's citation rule exists to catch. Rename to `listProgramSourcesAt`, update its doc comment, and update the two callers: the re-export at `src/analyze/index.ts` and `test/analyze/program.test.ts`. Its body takes the same `allowsJavaScript(root)` condition.

- [ ] **Step 5: Gate the two typed analyzers**

`surface.ts:324` and `blast-radius.ts:144` accept JavaScript only when the program includes it. Compute once per run, before the filter, so the early return that avoids building a program still works:

```typescript
  const js = allowsJavaScript(ctx.cwd);
  const relevant = changeset.files.filter(
    (f) => (isTypeScriptFile(f.path) || (js && isJavaScriptFile(f.path))) && f.status !== "deleted",
  );
```

**That snippet is surface-shaped. Keep each site's remaining conditions.**
`blast-radius.ts:144` also filters on `f.symbols.some((s) => s.exported && s.change !== "removed")`;
dropping it would build programs for files with no exported changed symbol. Widen only the
language test in each filter and leave everything else in place.

Imports to add: `isJavaScriptFile` into `src/analyze/program.ts`, and `allowsJavaScript`
into both `surface.ts` and `blast-radius.ts`. `tsc` will catch each, but the plan names
import edits everywhere else and should here too.

- [ ] **Step 6: Add the behavioural test**

In `test/analyze/surface.test.ts`, two temp projects — one with `allowJs: true`, one with `{}` — each with a `.mjs` file adding an export. Assert surface reports the added export in the first and reports nothing in the second, and that neither throws.

- [ ] **Step 7: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/analyze/program.ts src/analyze/index.ts src/analyze/surface.ts src/analyze/blast-radius.ts \n  test/analyze/program.test.ts test/analyze/surface.test.ts
git commit -m "feat: surface and blast radius read JavaScript when the project's compiler does"
```

---

### Task 5: Machine-written JavaScript, detected once

**Files:**
- Modify: `src/extract/symbols.ts` (`isMachineWritten` and its constant)
- Modify: `src/types.ts` (one optional field on `ChangedFile`)
- Modify: `src/extract/index.ts` (detection)
- Modify: `src/analyze/effects.ts`, `src/analyze/guards.ts`, `src/analyze/citations.ts` (skip on the field)
- Modify: `src/analyze/program.ts` (root selection — see Step 4, it cannot use the field)
- Modify: `src/report/coverage.ts` (the note), **`src/cli.ts` and `src/report/model.ts`** (wiring it to a reader — see Step 5)
- Test: `test/extract/index.test.ts`, `test/report/coverage.test.ts`

**Interfaces:**
- Produces: `ChangedFile.generated?: boolean`, set at extraction; a coverage note naming files skipped for it.

- [ ] **Step 1: Write the failing tests**

```typescript
it("marks a single-line JavaScript file as machine-written", () => {
  const long = `const a=${"x".repeat(400)};`;
  expect(isMachineWritten("bundle.js", long)).toBe(true);
});

it("does not mark a normal file, a short one, or TypeScript", () => {
  expect(isMachineWritten("a.js", "const a = 1;\nconst b = 2;\n")).toBe(false);
  expect(isMachineWritten("a.js", "const a = 1;\n")).toBe(false);
  // Minified TypeScript is not a thing that occurs, and testing for it would
  // change existing behaviour for no reason.
  expect(isMachineWritten("a.ts", `const a=${"x".repeat(400)};`)).toBe(false);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run test/extract/index.test.ts`
Expected: FAIL — `isMachineWritten` does not exist.

- [ ] **Step 3: Add the detector and the field**

In `src/extract/symbols.ts` beside the other predicates, using a named constant so no bare numeral appears in a comment:

```typescript
/**
 * A first line this long is not something a person typed. Deliberately weak:
 * it catches the common shape, one enormous line, and nothing else. A bundle
 * behind a banner comment, or minified output a tool line-wrapped, has a
 * short first line and is not caught. This is not a general test for
 * generated code and must not be described as one.
 *
 * First line rather than any line: a hand-written file can carry one long
 * embedded string or data URI, and skipping it under a note calling it
 * generated would be a false statement about someone's source.
 */
const MACHINE_WRITTEN_FIRST_LINE = 400;

export function isMachineWritten(path: string, text: string): boolean {
  if (!isJavaScriptFile(path)) return false;
  const first = text.indexOf("\n");
  return (first === -1 ? text.length : first) > MACHINE_WRITTEN_FIRST_LINE;
}
```

In `src/types.ts`, on `ChangedFile`:

```typescript
  /**
   * Set when the file's shape says a tool wrote it, so the analyzers skip it
   * and the review says why. Detected once, at extraction, because the
   * analyzers that skip it have no channel of their own to report through.
   */
  generated?: boolean;
```

In `src/extract/index.ts`, set it from the after-side text already read at `:48`.

- [ ] **Step 4: Skip in the analyzers on the field — and in the program by re-detecting**

`effects.ts:265`, `guards.ts:159` and the citations candidate pass skip a file whose
`generated` is set.

**Root selection cannot use the field, and the earlier phrasing of this step was wrong
about that.** `createProgramAt(root, rev)` (`src/analyze/program.ts:193`) never receives a
changeset — its only caller is `ctx.programAt`, which passes `(cwd, rev)`
(`src/extract/index.ts:22`) — so `ChangedFile.generated` cannot reach it. The program layer
must call `isMachineWritten(p, text)` itself, at `program.ts:231-239` where the file's text
is already in hand.

So detection is once *per layer*, not once overall: the changeset layer marks files for the
analyzers, and the program layer tests the text it is already holding. Two call sites of one
shared predicate, which is the honest description — say it that way in the comment rather
than claiming a single detection point.

- [ ] **Step 5: Disclose it — and wire it, because an exported note reaches nobody**

In `src/report/coverage.ts`, a note naming the skipped files, in the register of the
existing notes and claiming only what is true:

> `bundle.js is a single line of machine-written JavaScript, so no analyzer read it.`

**Exporting it is not enough, and stopping there would repeat the failure this feature's own
spec leads with.** Nothing picks up a new `coverage.ts` export automatically. Every existing
coverage sentence is explicitly imported and called in **two** places:

- `src/cli.ts:17-20` imports `deletedFilesNote` and `unanalyzedFilesNote`, and calls them at
  `:683` and `:688` to populate `--json`.
- `src/report/model.ts:4-8` imports both and calls them at `:840` and `:846` for the
  rendered report.

The new note needs the same treatment in both, or it is dead code with a passing unit test —
exactly the shape of the citations-pathspec defect the spec's revision header describes.

Test it at both levels: a unit test that the function produces the sentence, **and** an
assertion that a review over a changeset containing a generated file carries the sentence
through `review(...)` into `--json`'s notes. The unit test alone cannot tell you a reader
ever sees it.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/extract/symbols.ts src/extract/index.ts src/analyze/effects.ts   src/analyze/guards.ts src/analyze/citations.ts src/analyze/program.ts   src/report/coverage.ts src/report/model.ts src/cli.ts   test/extract/index.test.ts test/report/coverage.test.ts
git commit -m "feat: skip machine-written JavaScript, and say so"
```

---

### Task 6: The deleted-file gap, the docs, and acceptance

**Files:**
- Modify: `src/report/coverage.ts` (`deletedFilesNote`, and possibly `deletedTypeScriptFiles`)
- Modify: `README.md` (the analyzer bullets' stated extensions)
- Modify: `CHANGELOG.md`
- Test: `test/report/coverage.test.ts`

- [ ] **Step 1: Close the deleted-JavaScript gap**

`deletedTypeScriptFiles` (`coverage.ts:26`) stays narrow, so a **deleted** `.mjs` gets no note: its effects finding vanishes with the file, it leaves the unanalyzed list, and nothing tells the reader its exports and callers went unexamined — exactly what `deletedFilesNote` says for TypeScript.

Widen both, and reword the note so it is true of either language. Its current text hardcodes
"deleted TypeScript file"/"files" (`coverage.ts:52-53`); that wording is what makes widening
the predicate alone wrong. Add a test with a deleted `.mjs` asserting the note names it.

**One overlap to accept deliberately.** `unanalyzedFiles` (`:167`) stays narrow, so after this
change a deleted `.mjs` with no vanished effect finding is named **twice** — once by the
deleted-files note and once in the unanalyzed list — an overlap deleted TypeScript never has,
because `:167` excludes it by predicate. Both statements are true, so nothing false reaches the
reader. Leave it, and say so in the test's comment rather than discovering it later and
wondering which sentence is wrong.

- [ ] **Step 2: Update the README's stated extensions**

The analyzer bullets say the code analyzers "fire on `.ts`, `.tsx`, `.mts` and `.cts`". That is now false for three of them and conditional for two. Rewrite the paragraph to say which analyzers read JavaScript unconditionally and which follow the project's compiler options, keeping the surrounding voice. The count of analyzers does not change.

- [ ] **Step 3: Add the CHANGELOG entry**

Match the existing entries' format and voice. Describe what a reader now sees that they did not: findings in their JavaScript, citations checked in JavaScript comments and in `.mts`/`.cts` for the first time, and a note when a file is skipped as machine-written.

- [ ] **Step 4: Run the acceptance measurement**

Run: `npx tsx src/bin.ts review 0698cbf~40...0698cbf --no-llm --json`

Expected: `coverage.unanalyzedFiles` drops from **13 to 11**, with both `.mjs` files gone.

**Read this number honestly.** Those two files are `scripts/*.mjs` and they drop off *solely because effects fires*: guards skips added files (`guards.ts:160`) and both are added in that range. So this exercises one analyzer, not three. Report what you observe even if it differs, and do not treat it as end-to-end evidence for the whole design.

- [ ] **Step 5: Final green check and commit**

Run: `npx tsc --noEmit && npx vitest run`

```bash
git add src/report/coverage.ts README.md CHANGELOG.md test/report/coverage.test.ts
git commit -m "feat: disclose deleted JavaScript, and document the widened reach"
```

## Self-Review

**Spec coverage.** Two predicates → Task 1. The four-site `ScriptKind` fix and its diagnostics pin → Task 1. Syntactic three → Tasks 2 and 3. The extraction chain and its two consumers → Task 2 Interfaces. `CITATION_PATHSPECS` and the `.mts`/`.cts` under-report → Task 3. `getAllowJSCompilerOption`, the host filter, roots, the rename, and the two typed analyzers → Task 4. Machine-written detection, the single detection point, program-root exclusion, and the disclosure → Task 5. The deleted-JavaScript gap, README and CHANGELOG → Task 6. The analyzers × extensions table → Task 2 Step 1. Acceptance, pinned, with its caveat → Task 6 Step 4. `coverage.ts:26`/`:167` are the only spec items whose treatment differs between spec and plan: the spec leaves `:26` narrow and calls the gap in-scope for the plan, and Task 6 Step 1 resolves it by widening both the predicate and the note's wording.

**Placeholders.** None: every step carries the code or the command. Task 2 Step 1 deliberately tells the implementer to check three real signatures before writing the table rather than pasting argument shapes I have not verified — that is an instruction, not a gap.

**Type consistency.** `isJavaScriptFile`, `isSyntacticSource`, `scriptKindFor`, `allowsJavaScript`, `isMachineWritten`, `listProgramSourcesAt` and `ChangedFile.generated` are spelled identically everywhere they appear. `allowsJavaScript` takes a root path in both its definition and both call sites; the analyzers pass `ctx.cwd`, which `createContext` sets to the repository root it also hands `createProgramAt`.
