import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { createProgramAt, listTypeScriptFilesAt } from "../../src/analyze/program.js";
import { WORKTREE } from "../../src/types.js";

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
