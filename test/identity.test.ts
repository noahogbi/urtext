import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAnalyzers } from "../src/analyze/index.js";
import { review } from "../src/cli.js";
import { createContext, extract } from "../src/extract/index.js";
import { renderHtml } from "../src/report/html.js";
import { reconcile } from "../src/score/reconcile.js";
import type { Claim, Finding } from "../src/types.js";

/**
 * Symbol identity, end to end. Both defects these tests pin were invisible to
 * every unit test in the suite: each stage was self-consistent and the wrong
 * answer only appeared once a real repository's facts met each other in
 * `foldReach` and `reconcile`. So they run the whole pipeline on a real git
 * repository in a temp directory — never inside this repository, and never
 * over the network.
 */

const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function makeRepo(prefix: string, files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const run = (args: string[]) =>
    execFileSync("git", [...ISOLATION, ...args], { cwd: repo, stdio: "pipe" });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  write(repo, files);
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);
  return repo;
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

const REVIEW = { command: "review", json: true, noLlm: true, help: false } as const;

async function findingsOf(repo: string): Promise<Finding[]> {
  const r = await review(repo, REVIEW);
  return JSON.parse(r.output).findings as Finding[];
}

describe("reach is keyed on the symbol it actually describes", () => {
  // `Worker.run` and the top-level `run` share a name and a file. Only the
  // export is referenced elsewhere; only the method loses a guard. Keying
  // reach on the bare name gave the guard finding the export's reference
  // count and dropped the export's own finding entirely, so the report
  // asserted — as `verified` — that a method nothing calls is called three
  // times.
  const before = [
    "export function run(a: string): string {",
    "  return a;",
    "}",
    "export class Worker {",
    "  run(a: string): string {",
    '    if (a === "") {',
    '      throw new Error("empty");',
    "    }",
    "    return a;",
    "  }",
    "}",
    "",
  ].join("\n");

  const after = [
    "export function run(a: string): string {",
    "  return a.trim();",
    "}",
    "export class Worker {",
    "  run(a: string): string {",
    "    return a;",
    "  }",
    "}",
    "",
  ].join("\n");

  const callers = {
    "src/a.ts": 'import { run } from "./lib.js";\nexport const a = run("a");\n',
    "src/b.ts": 'import { run } from "./lib.js";\nexport const b = run("b");\n',
    "src/c.ts": 'import { run } from "./lib.js";\nexport const c = run("c");\n',
  };

  it("attributes the reference count to the export, not to a same-named method", async () => {
    const repo = makeRepo("urtext-reach-id-", { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });

    const findings = await findingsOf(repo);
    const guard = findings.find((f) => f.title.includes("guard was removed"));
    expect(guard).toBeDefined();
    // The three references belong to the top-level export. A guard finding
    // for a method with no callers must not borrow them.
    expect(guard!.body).not.toContain("3 places");
    expect(guard!.reach).toBeUndefined();

    const reach = findings.find((f) => f.title.includes("referenced in 3 places"));
    expect(reach).toBeDefined();
    expect(reach!.title).toBe("run changed and is referenced in 3 places");
  });

  it("names the method it took the guard from, qualified by its class", async () => {
    const repo = makeRepo("urtext-reach-owner-", { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });

    const findings = await findingsOf(repo);
    const guard = findings.find((f) => f.title.includes("guard was removed"));
    expect(guard!.title).toContain("Worker.run");
  });
});

describe("one changed symbol is one symbol, however many declarations it has", () => {
  // Overload signatures and merged interfaces are several declarations of one
  // symbol. Reporting each declaration separately gave them one id apiece —
  // and since a fact id is what `reconcile` attaches a claim to, one claim
  // arrived twice.
  const before = [
    "export function fmt(a: string): string; // a string",
    "export function fmt(a: number): string; // a number",
    "export function fmt(a: string | number): string {",
    "  return String(a);",
    "}",
    "",
  ].join("\n");

  const after = [
    "export function fmt(a: string): string; // takes a string",
    "export function fmt(a: number): string; // takes a number",
    "export function fmt(a: string | number): string {",
    "  return String(a);",
    "}",
    "",
  ].join("\n");

  const callers = {
    "src/a.ts": 'import { fmt } from "./lib.js";\nexport const a = fmt("a");\n',
    "src/b.ts": 'import { fmt } from "./lib.js";\nexport const b = fmt(2);\n',
  };

  const overloaded = (prefix: string): string => {
    const repo = makeRepo(prefix, { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });
    return repo;
  };

  it("reports an overloaded export once, not once per signature", async () => {
    const findings = await findingsOf(overloaded("urtext-overload-"));
    const reach = findings.filter((f) => f.title.includes("fmt changed and is referenced"));
    expect(reach).toHaveLength(1);
    expect(reach[0].title).toBe("fmt changed and is referenced in 2 places");
  });

  it("gives the API-surface table one row per symbol", async () => {
    const repo = overloaded("urtext-overload-table-");
    const changeset = await extract(repo);
    const html = renderHtml(changeset, [], { warnings: [] });
    const rows = html.split("<tr").filter((row) => row.includes(">fmt<"));
    expect(rows).toHaveLength(1);
  });

  it("attaches one claim to one finding", async () => {
    const repo = overloaded("urtext-overload-claim-");
    const changeset = await extract(repo);
    const facts = await runAnalyzers(changeset, createContext(repo, changeset.range));
    const ids = facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);

    const claim: Claim = {
      id: "c1",
      file: "src/lib.ts",
      line: 1,
      summary: "the comment change is cosmetic",
      reasoning: "Neither overload's parameter or return type moved.",
      severity: 0.2,
      correspondsTo: facts[0].id,
    };
    const findings = reconcile(facts, [claim]);
    expect(findings.filter((f) => f.tier === "inferred")).toHaveLength(1);
  });
});

describe("module-explicit TypeScript extensions are reviewed like any other", () => {
  // The worst-case silent drop: `.mts`/`.cts` failed the `.tsx?` extension
  // tests in both `isTypeScriptFile` and the program builder, so a guard
  // removal in an `.mts` file yielded "No findings", exit 0, empty coverage —
  // a clean-looking review of a change nothing ever analyzed.
  const before = [
    "export function save(input: string): string {",
    "  if (!input) {",
    '    throw new Error("empty");',
    "  }",
    "  return input;",
    "}",
    "",
  ].join("\n");
  const after = [
    "export function save(input: string): string {",
    "  return input;",
    "}",
    "",
  ].join("\n");

  for (const ext of ["mts", "cts"] as const) {
    it(`reports a guard removed in a .${ext} file`, async () => {
      const repo = makeRepo(`urtext-${ext}-`, { [`src/a.${ext}`]: before });
      write(repo, { [`src/a.${ext}`]: after });

      const findings = await findingsOf(repo);
      const guards = findings.filter((f) => f.title.includes("guard was removed"));
      expect(guards.length).toBeGreaterThan(0);
      expect(guards.some((f) => f.title.includes("save"))).toBe(true);
    });
  }
});

describe("exported enums are part of the reviewed surface", () => {
  it("reports a deleted exported enum as a removed export", async () => {
    const before = [
      'export enum Mode {',
      '  A = "a",',
      '  B = "b",',
      "}",
      "export const keep = 1;",
      "",
    ].join("\n");
    const after = "export const keep = 1;\n";

    const repo = makeRepo("urtext-enum-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    expect(findings.some((f) => f.title === "Mode is no longer exported")).toBe(true);
  });
});

describe("a nested symbol's guard is not the top-level export's guard", () => {
  // The other half of the same invariant. `mapSymbols` qualifies a name by
  // every scope around it; `collectGuards` did not — it framed classes,
  // functions, and namespaces but not object literals, and preferred a
  // function expression's internal name over the name it is bound to. So the
  // guards path still handed a nested symbol's guard to an unrelated top-level
  // export, and the two consumers of one rule disagreed about one declaration.
  const callers = {
    "src/user.ts": [
      'import { run } from "./lib.js";',
      "export const a = run(1);",
      "export const b = run(2);",
      "export const c = run(3);",
      "",
    ].join("\n"),
  };

  it("attributes an object-literal method's guard to the object, not to a same-named export", async () => {
    const before = [
      "export function run(x: number): number {",
      "  if (x < 0) {",
      "    return 0;",
      "  }",
      "  return x * 2;",
      "}",
      "export const handlers = {",
      "  run(y: number): number {",
      "    if (y > 10) {",
      '      throw new Error("too big");',
      "    }",
      "    return y;",
      "  },",
      "};",
      "",
    ].join("\n");
    // Only `handlers.run`'s guard goes; the export is untouched.
    const after = before
      .replace("    if (y > 10) {\n", "")
      .replace('      throw new Error("too big");\n', "")
      .replace("    }\n    return y;", "    return y;");

    const repo = makeRepo("urtext-objlit-guard-", { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) {
      expect(g.title).toContain("handlers.run");
      // The export's three references must not be borrowed by a guard on a
      // method that has none.
      expect(g.body).not.toContain("3 places");
      expect(g.reach).toBeUndefined();
    }
  });

  it("reports a guard the export really lost, even when a nested symbol gains one of the same kind", async () => {
    // The silent direction, and the worse one. `guardsAnalyzer` requires the
    // per-(owner, kind) count to have gone down, so two collided owners
    // balanced each other out and a guard removed from a real export rendered
    // as a clean diff. Nothing here is referenced, so a suppressed guard leaves
    // the report with nothing in it at all.
    const before = [
      "export function run(x: number): number {",
      "  if (x < 0) {",
      '    throw new Error("negative");',
      "  }",
      "  return x * 2;",
      "}",
      "export const handlers = {",
      "  run(y: number): number {",
      "    return y;",
      "  },",
      "};",
      "",
    ].join("\n");
    const after = [
      "export function run(x: number): number {",
      "  return x * 2;",
      "}",
      "export const handlers = {",
      "  run(y: number): number {",
      "    if (y > 10) {",
      '      throw new Error("too big");',
      "    }",
      "    return y;",
      "  },",
      "};",
      "",
    ].join("\n");

    const repo = makeRepo("urtext-guard-silence-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    // Removed from the export itself, which is the whole point.
    expect(guards.some((f) => f.title.endsWith("removed from run"))).toBe(true);
  });

  it("attributes a block-scoped arrow's guard to the block, not to a same-named export", async () => {
    const before = [
      "for (const n of [1]) {",
      "  const run = (a: string): string => {",
      '    if (a === "") {',
      '      throw new Error("empty");',
      "    }",
      "    return a;",
      "  };",
      "  void run;",
      "  void n;",
      "}",
      "export function run(x: number): number {",
      "  return x * 2;",
      "}",
      "",
    ].join("\n");
    const after = before
      .replace('    if (a === "") {\n', "")
      .replace('      throw new Error("empty");\n', "")
      .replace("    }\n    return a;", "    return a;");

    const repo = makeRepo("urtext-block-guard-", { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) {
      expect(g.title).toContain("unnamed block");
      expect(g.body).not.toContain("3 places");
    }
  });

  it("attributes a named function expression's guard to the name it is bound to", async () => {
    // `format2` here is in scope only inside the expression, so naming the
    // guard after it both misnames the symbol that lost the guard and collides
    // with the real top-level `format2` beside it.
    const before = [
      "export const format = function format2(a: string): string {",
      '  if (a === "") {',
      '    throw new Error("empty");',
      "  }",
      "  return a;",
      "};",
      "export function format2(a: string): string {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const after = before
      .replace('  if (a === "") {\n', "")
      .replace('    throw new Error("empty");\n', "")
      .replace("  }\n  return a;", "  return a;");

    const repo = makeRepo("urtext-fnexpr-guard-", {
      "src/lib.ts": before,
      "src/user.ts": [
        'import { format2 } from "./lib.js";',
        'export const a = format2("a");',
        'export const b = format2("b");',
        'export const c = format2("c");',
        "",
      ].join("\n"),
    });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) {
      expect(g.title).toContain("removed from format");
      expect(g.title).not.toContain("format2");
      expect(g.body).not.toContain("3 places");
    }
  });

  // A `for` *body* is a block, and blocks were covered. A `for` *header* is
  // neither a block nor a frame, so a binding declared there was rooted at the
  // file and wore a top-level export's name — the same failure mode as the four
  // shapes above, in the one place the closed list of statement scopes missed.
  // The header binding shares the export's name, which is what makes the two
  // collide on an unrooted path.
  const forHeader = [
    "export const f = (x: number): number => {",
    "  if (x < 0) {",
    '    throw new Error("neg");',
    "  }",
    "  return x;",
    "};",
    "for (",
    "  const f = (x: number): number => {",
    "    if (x > 99) {",
    '      throw new Error("big");',
    "    }",
    "    return x;",
    "  };",
    "  false;",
    "",
    ") {",
    "  void f;",
    "}",
    "",
  ].join("\n");

  it("attributes a for-header binding's guard to the header, not to a same-named export", async () => {
    // Only the header's guard goes; the export keeps its own.
    const after = forHeader
      .replace("    if (x > 99) {\n", "")
      .replace('      throw new Error("big");\n', "")
      .replace("    }\n    return x;", "    return x;");

    const repo = makeRepo("urtext-forheader-guard-", { "src/lib.ts": forHeader });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      // The bug named the untouched export outright.
      expect(guard.title).not.toBe("an if guard was removed from f");
      expect(guard.title).not.toBe("a throw guard was removed from f");
      expect(guard.title).toContain("unnamed block");
    }
  });

  it("reports a guard the export lost while a for-header binding of that name gains one", async () => {
    // The silent direction of the same collision, and it needs the guard to
    // *move*: on a shared owner path the export's lost `if` and the header's
    // new `if` cancel in the per-(owner, kind) budget, and the report says
    // nothing at all.
    const before = [
      "export const f = (x: number): number => {",
      "  if (x < 0) {",
      '    throw new Error("neg");',
      "  }",
      "  return x;",
      "};",
      "for (const f = (x: number): number => x; false; ) {",
      "  void f;",
      "}",
      "",
    ].join("\n");
    const after = [
      "export const f = (x: number): number => {",
      "  return x;",
      "};",
      "for (",
      "  const f = (x: number): number => {",
      "    if (x > 99) {",
      '      throw new Error("big");',
      "    }",
      "    return x;",
      "  };",
      "  false;",
      "",
      ") {",
      "  void f;",
      "}",
      "",
    ].join("\n");

    const repo = makeRepo("urtext-forheader-silence-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.some((g) => g.title === "an if guard was removed from f")).toBe(true);
  });

  it("reports a guard a merged namespace's export lost while a function-local twin gains it", async () => {
    // `function api` and `namespace api` share the frame `api`. The local
    // `handlers` inside the function body used to be qualified
    // `api.handlers.run` — the namespace's genuinely exported member's path —
    // so a guard moved from the export into the local cancelled in the
    // per-(owner, kind) budget and the report said nothing at all.
    const before = [
      "export function api(y: number): number {",
      "  const handlers = {",
      "    run(v: number): number {",
      "      return v;",
      "    },",
      "  };",
      "  return handlers.run(y);",
      "}",
      "export namespace api {",
      "  export const handlers = {",
      "    run(v: number): number {",
      "      if (v < 0) {",
      '        throw new Error("negative");',
      "      }",
      "      return v;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n");
    const after = [
      "export function api(y: number): number {",
      "  const handlers = {",
      "    run(v: number): number {",
      "      if (v < 0) {",
      '        throw new Error("negative");',
      "      }",
      "      return v;",
      "    },",
      "  };",
      "  return handlers.run(y);",
      "}",
      "export namespace api {",
      "  export const handlers = {",
      "    run(v: number): number {",
      "      return v;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n");

    const repo = makeRepo("urtext-nsmerge-guard-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    // Removed from the namespace's real export, named as such — not silence,
    // and not the function-local twin.
    expect(guards.some((f) => f.title.includes("api.handlers.run"))).toBe(true);
  });

  it("reports a guard a private method lost while a computed-key sibling gains it", async () => {
    // `#unlock` is a statically known, collision-free name. Framing it
    // `<anonymous>` made it share a path with the computed-key sibling, so
    // the moved guard cancelled in the per-(owner, kind) budget.
    const before = [
      'const k = "open";',
      "export class Vault {",
      "  #unlock(pin: string): string {",
      "    if (pin.length < 4) {",
      '      throw new Error("short");',
      "    }",
      "    return pin;",
      "  }",
      "  [k](pin: string): string {",
      "    return pin;",
      "  }",
      "  use(pin: string): string {",
      "    return this.#unlock(pin);",
      "  }",
      "}",
      "",
    ].join("\n");
    const after = [
      'const k = "open";',
      "export class Vault {",
      "  #unlock(pin: string): string {",
      "    return pin;",
      "  }",
      "  [k](pin: string): string {",
      "    if (pin.length < 4) {",
      '      throw new Error("short");',
      "    }",
      "    return pin;",
      "  }",
      "  use(pin: string): string {",
      "    return this.#unlock(pin);",
      "  }",
      "}",
      "",
    ].join("\n");

    const repo = makeRepo("urtext-private-guard-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.some((f) => f.title.includes("Vault.#unlock"))).toBe(true);
  });

  it("reports a guard a getter lost while the setter of the same name gains one", async () => {
    // Getter and setter are distinct runtime symbols: after this change the
    // empty-string check no longer runs on *reads*. When both framed the bare
    // `value` the throw texts matched exactly, the before-guard was consumed
    // as a survivor, and the report said nothing at all.
    const before = [
      "export class Config {",
      '  private _v = "x";',
      "  get value(): string {",
      '    if (this._v === "") {',
      '      throw new Error("unset");',
      "    }",
      "    return this._v;",
      "  }",
      "  set value(v: string) {",
      "    this._v = v;",
      "  }",
      "}",
      "",
    ].join("\n");
    const after = [
      "export class Config {",
      '  private _v = "x";',
      "  get value(): string {",
      "    return this._v;",
      "  }",
      "  set value(v: string) {",
      '    if (v === "") {',
      '      throw new Error("unset");',
      "    }",
      "    this._v = v;",
      "  }",
      "}",
      "",
    ].join("\n");

    const repo = makeRepo("urtext-accessor-guard-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    // Rendered as prose, not as the raw `Config.get value` path.
    expect(guards.some((f) => f.title.includes("the value getter in Config"))).toBe(true);
  });

  it("qualifies a property arrow and a getter in an object literal too", async () => {
    const before = [
      "export const handlers = {",
      "  check: (a: string): string => {",
      "    if (!a) {",
      '      throw new Error("empty");',
      "    }",
      "    return a;",
      "  },",
      "  get size(): number {",
      "    if (Date.now() < 0) {",
      '      throw new Error("impossible");',
      "    }",
      "    return 1;",
      "  },",
      "};",
      "export function check(a: string): string {",
      "  return a;",
      "}",
      "export function size(): number {",
      "  return 0;",
      "}",
      "",
    ].join("\n");
    const after = before
      .replace("    if (!a) {\n", "")
      .replace('      throw new Error("empty");\n', "")
      .replace("    }\n    return a;", "    return a;")
      .replace("    if (Date.now() < 0) {\n", "")
      .replace('      throw new Error("impossible");\n', "")
      .replace("    }\n    return 1;", "    return 1;");

    const repo = makeRepo("urtext-objlit-members-", { "src/lib.ts": before });
    write(repo, { "src/lib.ts": after });
    const findings = await findingsOf(repo);

    const guards = findings.filter((f) => f.title.includes("guard was removed"));
    expect(guards.length).toBeGreaterThan(0);
    for (const g of guards) {
      // The property arrow keeps its dotted path; the getter renders as the
      // accessor phrase (its path embeds the accessor kind — see
      // GETTER_FRAME_PREFIX in src/extract/scope.ts).
      expect(
        g.title.includes("handlers.check") || g.title.includes("the size getter in handlers"),
        g.title,
      ).toBe(true);
    }
  });
});

describe("a nested declaration is not the top-level export that shares its name", () => {
  // Grouping declarations by qualified name is only sound if the qualified name
  // is qualified by every enclosing scope. It was not: only classes framed a
  // name, so a local inside a function shared a `qualifiedName` with a
  // top-level export, the merge took `exported` from the export and `kind` and
  // `range` from the local, and editing the local alone produced a `verified`
  // finding about the export — anchored at the local's line, evidenced by the
  // export's call sites.
  const before = [
    "export function wrapper(n: number): number {",
    "  const format = n + 1;",
    "  return format;",
    "}",
    "export function format(a: string): string {",
    "  return a;",
    "}",
    "",
  ].join("\n");

  // Only line 2 — the local — differs.
  const localEdited = before.replace("const format = n + 1;", "const format = n + 2;");
  // Only line 6 — the export's body — differs.
  const exportEdited = before.replace("  return a;", "  return a.trim();");

  // Two referencing files, not one: this suite reviews with --no-llm, so no
  // claim ever attaches, and a single caller would put the export under
  // MIN_STANDALONE_REFERENCES (src/score/reconcile.ts) — the claim-free
  // one-reference standalone row is suppressed after reconcile, which would
  // hide the identity behaviour this suite exists to pin. Suppression and
  // its claim-survival edge are pinned in test/score/reconcile.test.ts, not
  // here.
  const callers = {
    "src/user.ts": 'import { format } from "./lib.js";\nexport const a = format("a");\n',
    "src/user2.ts": 'import { format } from "./lib.js";\nexport const b = format("b");\n',
  };

  const shadowing = (prefix: string, after: string): string => {
    const repo = makeRepo(prefix, { "src/lib.ts": before, ...callers });
    write(repo, { "src/lib.ts": after });
    return repo;
  };

  it("says nothing about the export when only a same-named local changed", async () => {
    const findings = await findingsOf(shadowing("urtext-shadow-", localEdited));
    // The bug printed "format changed and is referenced in one place" here,
    // with `lib.ts:2` — the local's line — as its evidence.
    expect(findings.filter((f) => f.title.includes("referenced"))).toEqual([]);
    for (const f of findings) {
      expect(f.title).not.toContain("format changed");
    }
  });

  it("qualifies the local by its function and leaves the export out of the symbol map", async () => {
    const repo = shadowing("urtext-shadow-symbols-", localEdited);
    const changeset = await extract(repo);
    const lib = changeset.files.find((f) => f.path === "src/lib.ts")!;
    const local = lib.symbols.find((s) => s.name === "format")!;
    expect(local.qualifiedName).toBe("wrapper.<local>.format");
    expect(local.kind).toBe("variable");
    expect(local.exported).toBe(false);
    // The exported function was not touched, so it is not in the map at all —
    // and nothing in the map claims to be an exported `format`.
    expect(lib.symbols.some((s) => s.qualifiedName === "format")).toBe(false);
  });

  it("keeps the exported function out of the API-surface table when only the local changed", async () => {
    const repo = shadowing("urtext-shadow-table-", localEdited);
    const html = renderHtml(await extract(repo), [], { warnings: [] });
    // The bug listed `format` as an exported *variable*, taking the kind from
    // the local it had merged in.
    expect(html.split("<tr").filter((row) => row.includes(">format<"))).toEqual([]);
  });

  it("still reports the export, anchored at its own declaration, when the export changes", async () => {
    const findings = await findingsOf(shadowing("urtext-shadow-export-", exportEdited));
    const reach = findings.find((f) => f.title.includes("format changed and is referenced"));
    expect(reach).toBeDefined();
    expect(reach!.title).toBe("format changed and is referenced in 2 places");
    // Line 5 is `export function format(...)`, not line 2's local.
    expect(reach!.line).toBe(5);
    expect(reach!.evidence[0].excerpt).toContain("export function format");
  });
});
