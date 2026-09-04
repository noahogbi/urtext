import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  allowsJavaScript,
  allowsJavaScriptIn,
  createProgramAt,
  listProgramSourcesAt,
} from "../../src/analyze/program.js";
import { WORKTREE } from "../../src/types.js";

const mkCanonicalTempDir = (prefix: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

let repo: string;
let absentRepo: string;

function runIn(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
  });
}

function run(args: string[]) {
  runIn(repo, args);
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

  // A second repository where a module imported by the committed code exists
  // only in the working tree.
  absentRepo = mkdtempSync(join(tmpdir(), "urtext-absent-"));
  runIn(absentRepo, ["init", "-b", "main"]);
  runIn(absentRepo, ["config", "user.email", "t@e.com"]);
  runIn(absentRepo, ["config", "user.name", "T"]);
  mkdirSync(join(absentRepo, "src"), { recursive: true });
  writeFileSync(
    join(absentRepo, "src", "app.ts"),
    'import { help } from "./help.js";\nexport const n: number = help();\n',
  );
  runIn(absentRepo, ["add", "-A"]);
  runIn(absentRepo, ["commit", "-m", "first"]);
  writeFileSync(
    join(absentRepo, "src", "help.ts"),
    "export function help(): number {\n  return 1;\n}\n",
  );
});

describe("listProgramSourcesAt", () => {
  it("lists TypeScript files at a commit and skips others", async () => {
    const files = await listProgramSourcesAt(repo, "main");
    expect(files).toContain("src/lib.ts");
    expect(files).not.toContain("notes.md");
  });

  it("lists working-tree files for the WORKTREE sentinel", async () => {
    expect(await listProgramSourcesAt(repo, WORKTREE)).toContain("src/lib.ts");
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

  it("excludes a single-line JavaScript file from program roots under allowJs, but keeps it resolvable", async () => {
    // `createProgramAt` never receives a `Changeset`, so it cannot read
    // `ChangedFile.generated` the way the analyzers do — it calls
    // `isMachineWritten` itself, against text it has already read into
    // `contents`. This is the layer the field cannot reach; see
    // `src/extract/index.ts` for the layer that sets it.
    const dir = mkCanonicalTempDir("urtext-generated-root-");
    runIn(dir, ["init", "-b", "main"]);
    runIn(dir, ["config", "user.email", "t@e.com"]);
    runIn(dir, ["config", "user.name", "T"]);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: true } }),
    );
    writeFileSync(join(dir, "bundle.js"), `const a=${"x".repeat(400)};`);
    writeFileSync(
      join(dir, "src.ts"),
      'import "./bundle.js";\nexport const ok = true;\n',
    );
    runIn(dir, ["add", "-A"]);
    runIn(dir, ["commit", "-m", "first"]);

    const program = await createProgramAt(dir, "main");
    const roots = program.getRootFileNames().map((f) => f.replace(/\\/g, "/"));
    expect(roots.some((f) => f.endsWith("bundle.js"))).toBe(false);
    expect(roots.some((f) => f.endsWith("src.ts"))).toBe(true);

    // Excluded from the roots, but not deleted from the world: something
    // that imports it still resolves with no diagnostic.
    const sf = program.getSourceFile(join(dir, "src.ts"))!;
    const errors = program
      .getSemanticDiagnostics(sf)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(errors.join("\n")).not.toContain("Cannot find module");
  });

  it("never resolves a repository file the revision does not have", async () => {
    // `src/help.ts` exists only in the working tree. Serving it to a program
    // built at `main` would make the "before" side of a diff type-check
    // current code — the silent failure that turns a `verified` finding into
    // confident nonsense. The revision must see the module as missing.
    const atCommit = await createProgramAt(absentRepo, "main");
    const committed = atCommit.getSourceFile(join(absentRepo, "src/app.ts"))!;
    expect(committed).toBeDefined();
    expect(atCommit.getSourceFile(join(absentRepo, "src/help.ts"))).toBeUndefined();
    const errors = atCommit
      .getSemanticDiagnostics(committed)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(errors.join("\n")).toContain("Cannot find module './help.js'");

    // The same import resolves cleanly once the file is actually present.
    const atWorktree = await createProgramAt(absentRepo, WORKTREE);
    const current = atWorktree.getSourceFile(join(absentRepo, "src/app.ts"))!;
    expect(
      atWorktree
        .getSemanticDiagnostics(current)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    ).toEqual([]);
  });
});

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
    // allowsJavaScriptIn spells out a rule TypeScript implements internally
    // as getAllowJSCompilerOption. That function is absent from the public
    // typed API — using it is a compile error — so the rule is duplicated,
    // and this calls the real, shipped implementation (not a rewritten copy
    // of its body) so a future TypeScript cannot drift from it silently.
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
      expect(allowsJavaScriptIn(parsed)).toBe(internal(parsed));
    }
  });
});
