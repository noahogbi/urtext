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
  // Imports the changed export under an alias and calls it only as `u`.
  // countReferences must resolve `u` back to the target symbol rather than
  // matching on spelling — a text-based prefilter would never even look at
  // this call site, since "u" does not share text with "used".
  writeFileSync(
    join(repo, "src", "d.ts"),
    'import { used as u } from "./core.js";\nexport const d = u(2);\n',
  );
  // A same-named local variable that does not import from core.ts at all.
  // Its declaration and use both spell "used", so a name-matching
  // implementation would count them; symbol resolution must not, since this
  // "used" is a different symbol entirely.
  writeFileSync(
    join(repo, "src", "e.ts"),
    "const used = 1;\nexport const e = used + 1;\n",
  );
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
    const f = facts.find((x) => x.qualifiedSymbol === "used");
    expect(f).toBeDefined();
    expect(f!.kind).toBe("blast_radius");
    // a.ts, b.ts, c.ts (plain import) and d.ts (aliased import, see below)
    // — four call sites. e.ts's unrelated local "used" is not one of them.
    expect(f!.detail.references).toBe(4);
    // evidence[0] is the changed declaration itself — Fact.file/line must
    // agree with evidence[0], which is the invariant every other analyzer in
    // this codebase relies on. The reference sites (which live in other
    // files) follow it, rather than displacing it.
    expect(f!.evidence.length).toBeGreaterThan(1);
    expect(f!.evidence[0].file).toBe("src/core.ts");
    expect(f!.evidence.slice(1).some((e) => e.file !== "src/core.ts")).toBe(
      true,
    );
  });

  it("counts a reference reached only through an aliased import", async () => {
    const cs = await extract(repo);
    const facts = await blastRadiusAnalyzer(cs, createContext(repo, cs.range));
    const f = facts.find((x) => x.qualifiedSymbol === "used");
    expect(f).toBeDefined();
    // d.ts imports `used` as `u` and never spells "used" at the call site
    // (`u(2)`); this asserts that call site is one of the counted
    // references, not merely that the total happens to be non-zero.
    expect(f!.detail.references).toBe(4);
    expect(
      f!.evidence.some((e) => e.file === "src/d.ts" && e.excerpt.includes("u(2)")),
    ).toBe(true);
  });

  it("does not count a same-named local variable that never imports the export", async () => {
    const cs = await extract(repo);
    const facts = await blastRadiusAnalyzer(cs, createContext(repo, cs.range));
    const f = facts.find((x) => x.qualifiedSymbol === "used");
    expect(f).toBeDefined();
    // e.ts declares and uses its own unrelated `used` twice, textually. If
    // either occurrence were counted, references would exceed 4 or e.ts
    // would appear in evidence; neither happens, because symbol identity —
    // not spelling — decides a match.
    expect(f!.detail.references).toBe(4);
    expect(f!.evidence.some((e) => e.file === "src/e.ts")).toBe(false);
  });

  it("does not report an export with no references", async () => {
    const cs = await extract(repo);
    const facts = await blastRadiusAnalyzer(cs, createContext(repo, cs.range));
    expect(facts.map((f) => f.qualifiedSymbol)).not.toContain("lonely");
  });
});

describe("blastRadiusAnalyzer on a named default export", () => {
  // A module's export table keys a default export as "default", whatever its
  // declared name is. Looking it up by the declared name alone found nothing,
  // so a named default export referenced N times never got a blast_radius
  // fact and its findings were never reach-amplified.
  let defRepo: string;

  function runIn(args: string[]) {
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: defRepo,
      stdio: "pipe",
    });
  }

  beforeAll(() => {
    defRepo = mkdtempSync(join(tmpdir(), "urtext-blast-default-"));
    runIn(["init", "-b", "main"]);
    runIn(["config", "user.email", "t@e.com"]);
    runIn(["config", "user.name", "T"]);
    mkdirSync(join(defRepo, "src"), { recursive: true });
    writeFileSync(
      join(defRepo, "src", "main.ts"),
      "export default function main(x: number): number {\n  return x;\n}\n",
    );
    writeFileSync(
      join(defRepo, "src", "use.ts"),
      [
        'import main from "./main.js";',
        "export const a = main(1);",
        "export const b = main(2);",
        "export const c = main(3);",
        "",
      ].join("\n"),
    );
    runIn(["add", "-A"]);
    runIn(["commit", "-m", "first"]);

    writeFileSync(
      join(defRepo, "src", "main.ts"),
      "export default function main(x: number): number {\n  return x + 1;\n}\n",
    );
  });

  it("counts references to a changed named default export", async () => {
    const cs = await extract(defRepo);
    const facts = await blastRadiusAnalyzer(cs, createContext(defRepo, cs.range));
    const f = facts.find((x) => x.qualifiedSymbol === "main");
    expect(f).toBeDefined();
    expect(f!.detail.references).toBe(3);
    expect(f!.evidence[0].file).toBe("src/main.ts");
    expect(f!.evidence.slice(1).every((e) => e.file === "src/use.ts")).toBe(true);
  });

  it("does not let a non-default export borrow the default's identity", async () => {
    // The fallback only fires when the export table has no entry under the
    // bare name AND the default export's own declaration carries that name —
    // a same-named local or unrelated symbol must not be counted through it.
    const cs = await extract(defRepo);
    const facts = await blastRadiusAnalyzer(cs, createContext(defRepo, cs.range));
    // use.ts's own exports (a, b, c) did not change; only `main` is reported.
    expect(facts.map((f) => f.qualifiedSymbol)).toEqual(["main"]);
  });
});

describe("blastRadiusAnalyzer over JavaScript, gated by the project's own compiler options", () => {
  // Otherwise identical repos: `used`, exported from a JavaScript module and
  // imported by three separate .mjs consumers, then changed. Only the
  // tsconfig differs between them, so the difference in outcome across the
  // two `it`s below is attributable to that one setting, not to anything
  // else in the fixture.
  let allowedRepo: string;
  let disallowedRepo: string;

  function populate(dir: string, compilerOptions: Record<string, unknown>): void {
    const runIn = (args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
    runIn(["init", "-b", "main"]);
    runIn(["config", "user.email", "t@e.com"]);
    runIn(["config", "user.name", "T"]);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions }));
    writeFileSync(join(dir, "src", "core.mjs"), "export function used(n) {\n  return n;\n}\n");
    for (const c of ["a", "b", "c"]) {
      writeFileSync(
        join(dir, "src", `${c}.mjs`),
        `import { used } from "./core.mjs";\nexport const ${c} = used(1);\n`,
      );
    }
    runIn(["add", "-A"]);
    runIn(["commit", "-m", "first"]);
    writeFileSync(join(dir, "src", "core.mjs"), "export function used(n) {\n  return n + 1;\n}\n");
  }

  beforeAll(() => {
    allowedRepo = mkdtempSync(join(tmpdir(), "urtext-blast-js-allowed-"));
    populate(allowedRepo, { allowJs: true });
    disallowedRepo = mkdtempSync(join(tmpdir(), "urtext-blast-js-disallowed-"));
    populate(disallowedRepo, {});
  });

  it("counts references to a changed export across .mjs consumers when the tsconfig allows JavaScript", async () => {
    // This is the case dropping the widening in blast-radius.ts's filter
    // would silently break: the full suite stays green without it because
    // nothing else exercises blast radius over JavaScript at all.
    const cs = await extract(allowedRepo);
    const facts = await blastRadiusAnalyzer(cs, createContext(allowedRepo, cs.range));
    const f = facts.find((x) => x.qualifiedSymbol === "used");
    expect(f).toBeDefined();
    expect(f!.kind).toBe("blast_radius");
    expect(f!.detail.references).toBe(3);
  });

  it("reports nothing for the identical change, and does not throw, when the tsconfig admits neither allowJs nor checkJs", async () => {
    const cs = await extract(disallowedRepo);
    const facts = await blastRadiusAnalyzer(cs, createContext(disallowedRepo, cs.range));
    expect(facts).toEqual([]);
  });
});
