import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_SIGNATURE_LENGTH,
  SIGNATURE_TRUNCATION_MARKER,
  exportedSignatures,
  surfaceAnalyzer,
} from "../../src/analyze/surface.js";
import { createContext, extract } from "../../src/extract/index.js";
import { rank, toFinding } from "../../src/score/index.js";

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

/** A fresh temp git repo, isolated from the module-level `repo` above. */
function makeRepo(): { dir: string; run: (args: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "urtext-surface-"));
  const run = (args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@e.com"]);
  run(["config", "user.name", "T"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  return { dir, run };
}

describe("surfaceAnalyzer re-exports", () => {
  let reexportRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    reexportRepo = dir;

    // `bar` is declared in a.ts and never changes. reexport.ts is a new
    // file that re-exports it via `export *`.
    writeFileSync(
      join(dir, "src", "a.ts"),
      ["export function bar(): number {", "  return 1;", "}", ""].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "reexport.ts"),
      ['export * from "./a.js";', ""].join("\n"),
    );
    // A second barrel, re-exporting the same symbol by name rather than by
    // star. `checker.getExportsOfModule` hands back an Alias-flagged symbol
    // for this form, whose own declaration is the ExportSpecifier here in
    // named.ts, not the real declaration in a.ts — a different resolution
    // path than the star-export case above, and worth its own file so both
    // are exercised in the same changeset: the fixture's job is to prove
    // that two barrels reaching the same declaration by two different
    // mechanisms still collapse to one fact, not that they can be told
    // apart.
    writeFileSync(
      join(dir, "src", "named.ts"),
      ['export { bar } from "./a.js";', ""].join("\n"),
    );
    // Two more genuinely distinct new exports, declared in a.ts itself —
    // the same declaration file `bar` resolves to — so the changeset
    // crosses ADDED_EXPORT_THRESHOLD with a mix of one duplicated-discovery
    // symbol (`bar`, findable from two barrels) and two single-discovery
    // ones (`baz`, `qux`), all landing in a.ts's group. That is what the
    // group-finding dedup test below needs to tell "one real symbol, found
    // twice" apart from "three real symbols" — putting `baz`/`qux` in a
    // different file would group them separately from `bar` and never
    // exercise the bug at all.
    writeFileSync(
      join(dir, "src", "a.ts"),
      [
        "export function bar(): number {",
        "  return 1;",
        "}",
        "export function baz(): number {",
        "  return 2;",
        "}",
        "export function qux(): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
    );
    // git diff against a commit does not surface untracked files (that's
    // what `untrackedCount` is for) — stage the new files so they show up as
    // uncommitted additions, matching how a real "added a file, haven't
    // committed yet" review would look.
    run2(["add", "-A"]);
  });

  it("anchors bar's evidence to a.ts, the file that actually declares it, not either barrel", async () => {
    const cs = await extract(reexportRepo);
    const facts = await surfaceAnalyzer(cs, createContext(reexportRepo, cs.range));
    const added = facts.find(
      (f) => f.kind === "export_added" && f.detail.export === "bar" && f.qualifiedSymbol === "bar",
    );
    expect(added).toBeDefined();
    // Evidence lives in a.ts, where `bar` is actually declared — not
    // reexport.ts (`export * from "./a.js";`) or named.ts
    // (`export { bar } from "./a.js";`), neither of which says anything
    // about `bar`'s own definition.
    expect(added!.file).toBe("src/a.ts");
    expect(added!.evidence[0].file).toBe("src/a.ts");
    expect(added!.evidence[0].excerpt).toContain("bar");
  });

  it("reports a symbol declared once and re-exported through two barrels as one fact, not one per barrel", async () => {
    const cs = await extract(reexportRepo);
    const facts = await surfaceAnalyzer(cs, createContext(reexportRepo, cs.range));
    const both = facts.filter(
      (f) => f.kind === "export_added" && f.detail.export === "bar",
    );
    // `bar` is discovered twice — once from reexport.ts's star export, once
    // from named.ts's named export — and both discoveries resolve, via
    // `lineOfExport`'s `getAliasedSymbol` call, to the exact same
    // declaration in a.ts. One declaration is one new public-surface entry:
    // finding it twice must not report it twice.
    expect(both.length).toBe(1);
  });

  it("does not double-count a re-exported symbol in the grouped finding's title or name list", async () => {
    // `baz` and `qux` are declared directly in a.ts (one discovery each,
    // alongside `bar`'s own declaration); `bar` is declared once in a.ts but
    // discoverable from two barrels. Three real new exports crossing
    // ADDED_EXPORT_THRESHOLD must group as "exports 3 new symbols" listing
    // bar/baz/qux once each — not "4 new symbols" with bar repeated, which
    // is what the pre-fix duplicate fact for bar produced.
    const cs = await extract(reexportRepo);
    const facts = await surfaceAnalyzer(cs, createContext(reexportRepo, cs.range));
    const findings = rank(facts);
    const group = findings.find((f) => f.title.startsWith("exports "));
    expect(group).toBeDefined();
    expect(group!.title).toBe("exports 3 new symbols");
    const names = group!.body.match(/New public surface: ([^.]+)\./)?.[1].split(", ");
    expect(names).toEqual(["bar", "baz", "qux"]);
  });
});

describe("surfaceAnalyzer re-exports with colliding alias names", () => {
  let aliasRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    aliasRepo = dir;

    // Two distinct bindings declared on the very same line and statement —
    // the shape that makes (kind, where.file, where.line, name) alone
    // ambiguous once both are re-exported under the same external name from
    // different barrels.
    writeFileSync(
      join(dir, "src", "m.ts"),
      ["export const alpha = 1, beta = 2;", ""].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "barrel1.ts"),
      ['export { alpha as z } from "./m.js";', ""].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "barrel2.ts"),
      ['export { beta as z } from "./m.js";', ""].join("\n"),
    );
    run2(["add", "-A"]);
  });

  it("does not drop one of two distinct declarations that share a declaration line and an exported alias name", async () => {
    const cs = await extract(aliasRepo);
    const facts = await surfaceAnalyzer(cs, createContext(aliasRepo, cs.range));
    // Before the declared-name key: both discoveries resolved to the same
    // (export_added, src/m.ts, first line, "z") key and the second emit call
    // was silently dropped as a duplicate of the first, even though `alpha`
    // and `beta` are unrelated bindings.
    const both = facts.filter((f) => f.kind === "export_added" && f.detail.export === "z");
    expect(both.length).toBe(2);
    expect(new Set(both.map((f) => f.id)).size).toBe(2);
  });
});

describe("surfaceAnalyzer interface structural changes", () => {
  let ifaceRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    ifaceRepo = dir;

    writeFileSync(
      join(dir, "src", "shapes.ts"),
      [
        "export interface Foo {",
        "  id: string;",
        "}",
        "export interface Baz {",
        "  count: number;",
        "}",
        "export interface Qux {",
        "  a: number;",
        "  b: string;",
        "}",
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "shapes.ts"),
      [
        "export interface Foo {",
        "  id: string;",
        "  name: string;",
        "}",
        "export interface Baz {",
        "  count: string;",
        "}",
        "export interface Qux {",
        "  b: string;",
        "  a: number;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("flags an exported interface that gains a member", async () => {
    const cs = await extract(ifaceRepo);
    const facts = await surfaceAnalyzer(cs, createContext(ifaceRepo, cs.range));
    const foo = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Foo",
    );
    expect(foo).toBeDefined();
    expect(String(foo!.detail.before)).not.toContain("name");
    expect(String(foo!.detail.after)).toContain("name: string");
  });

  it("flags an exported interface whose member type changes", async () => {
    const cs = await extract(ifaceRepo);
    const facts = await surfaceAnalyzer(cs, createContext(ifaceRepo, cs.range));
    const baz = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Baz",
    );
    expect(baz).toBeDefined();
    expect(String(baz!.detail.before)).toContain("count: number");
    expect(String(baz!.detail.after)).toContain("count: string");
  });

  it("does not flag a reordered interface as changed", async () => {
    const cs = await extract(ifaceRepo);
    const facts = await surfaceAnalyzer(cs, createContext(ifaceRepo, cs.range));
    expect(facts.some((f) => f.detail.export === "Qux")).toBe(false);
  });

  // Regression coverage for the structural path itself, not just "a fact
  // fired": an object-shaped interface must still expand member-by-member
  // rather than falling back to `typeToString`, which for an interface
  // alone would just print the interface's own name and hide every change.
  it("still expands an object-shaped interface structurally, not by name", async () => {
    const cs = await extract(ifaceRepo);
    const facts = await surfaceAnalyzer(cs, createContext(ifaceRepo, cs.range));
    const foo = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Foo",
    );
    expect(foo).toBeDefined();
    expect(String(foo!.detail.before)).toContain("id: string");
    expect(String(foo!.detail.after)).toContain("id: string");
    expect(String(foo!.detail.after)).toContain("name: string");
  });
});

describe("surfaceAnalyzer string-literal union aliases", () => {
  // Regression coverage for the bug where `getPropertiesOfType`, called on
  // a string-literal union's declared type, resolves to the apparent type
  // of the `string` primitive and hands back String.prototype's members
  // (charAt, toLowerCase, matchAll, ...) instead of the union's own
  // members. `structuralSignature` must recognise this is not an
  // object-shaped type and fall back to `typeToString`.
  let unionRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    unionRepo = dir;

    writeFileSync(
      join(dir, "src", "kinds.ts"),
      ['export type Kind = "function" | "class";', ""].join("\n"),
    );
    writeFileSync(
      join(dir, "src", "order.ts"),
      [
        'export type Order = "function" | "method" | "class" | "type" | "variable";',
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "kinds.ts"),
      ['export type Kind = "function" | "class" | "method";', ""].join("\n"),
    );
    // Byte-for-byte the same union, members merely reordered in source.
    // `ts.Program`'s internal union member order is not guaranteed stable
    // across two separately-built programs even for identical text, so this
    // is exactly the case that would false-positive without sorting.
    writeFileSync(
      join(dir, "src", "order.ts"),
      [
        'export type Order = "class" | "variable" | "function" | "type" | "method";',
        "",
      ].join("\n"),
    );
  });

  it("reports a gained union member with a short, accurate signature", async () => {
    const cs = await extract(unionRepo);
    const facts = await surfaceAnalyzer(cs, createContext(unionRepo, cs.range));
    const kind = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Kind",
    );
    expect(kind).toBeDefined();
    const before = String(kind!.detail.before);
    const after = String(kind!.detail.after);
    expect(before).toContain('"function"');
    expect(before).toContain('"class"');
    expect(before).not.toContain('"method"');
    expect(after).toContain('"method"');
    // The bug this guards: falling back to getPropertiesOfType on a union
    // reports String.prototype's members instead of the union's own.
    expect(before).not.toContain("charCodeAt");
    expect(before).not.toContain("prototype");
    expect(after).not.toContain("charCodeAt");
    expect(after).not.toContain("prototype");
    // Short enough to be a union of three string literals, not a ~49-member
    // dump of the String API.
    expect(after.length).toBeLessThan(100);
  });

  it("does not flag a union whose members were only reordered as changed", async () => {
    const cs = await extract(unionRepo);
    const facts = await surfaceAnalyzer(cs, createContext(unionRepo, cs.range));
    expect(facts.some((f) => f.detail.export === "Order")).toBe(false);
  });
});

describe("surfaceAnalyzer nested set-semantic reorders", () => {
  // The class the top-level union sort fixed one instance of: a union (or
  // object-member list) NESTED inside a printed type still serialized in
  // checker-interning order, so a real repository reported three `verified`
  // signature changes for declarations that were byte-identical across the
  // range. The reviewed range had merely added a module, shifting the order
  // in which the checker first materialized the member types. Reordering the
  // source text reproduces the same string-level flip deterministically.
  let nestedRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    nestedRepo = dir;

    writeFileSync(
      join(dir, "src", "cov.ts"),
      [
        "export interface CoverageRef {",
        '  kind: "post" | "bulletin_item";',
        "  title: string;",
        "}",
        "export interface Box {",
        "  p: { a: string; b: number };",
        "}",
        "export interface Grown {",
        '  kind: "post" | "bulletin_item";',
        "}",
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "cov.ts"),
      [
        "export interface CoverageRef {",
        '  kind: "bulletin_item" | "post";',
        "  title: string;",
        "}",
        "export interface Box {",
        "  p: { b: number; a: string };",
        "}",
        "export interface Grown {",
        '  kind: "post" | "bulletin_item" | "draft";',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("does not flag a nested union whose members were only reordered", async () => {
    const cs = await extract(nestedRepo);
    const facts = await surfaceAnalyzer(cs, createContext(nestedRepo, cs.range));
    expect(facts.some((f) => f.detail.export === "CoverageRef")).toBe(false);
  });

  it("does not flag a nested object type whose members were only reordered", async () => {
    const cs = await extract(nestedRepo);
    const facts = await surfaceAnalyzer(cs, createContext(nestedRepo, cs.range));
    expect(facts.some((f) => f.detail.export === "Box")).toBe(false);
  });

  it("still flags a nested union that genuinely gained a member", async () => {
    const cs = await extract(nestedRepo);
    const facts = await surfaceAnalyzer(cs, createContext(nestedRepo, cs.range));
    const grown = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Grown",
    );
    expect(grown).toBeDefined();
    expect(String(grown!.detail.after)).toContain('"draft"');
  });
});

describe("surfaceAnalyzer signatures longer than the storage cap", () => {
  // The comparison reads the FULL printed text, not the capped stored one.
  // Both directions of that decision are load-bearing: a capped text can
  // cut mid-token, making it unparseable, so a long type with a flipped
  // union INSIDE the cap kept false-positiving after the canonical fix
  // (a real repository's 986-char interface was the repro) — and a real
  // change PAST the cap used to vanish entirely, which for a `verified`
  // tier is masking, not caution.
  let longRepo: string;

  // Wide enough that the printed interface overflows MAX_SIGNATURE_LENGTH
  // with room to spare, so "past the cap" below means what it says.
  const PAD_PROPS = Array.from(
    { length: 40 },
    (_, i) => `  pad_property_${String(i).padStart(2, "0")}: string;`,
  );

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    longRepo = dir;

    writeFileSync(
      join(dir, "src", "long.ts"),
      [
        "export interface Story {",
        '  covered_kind: "bulletin_item" | "post" | null;',
        ...PAD_PROPS,
        "}",
        "export interface Tail {",
        ...PAD_PROPS,
        '  z_last: "old";',
        "}",
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "long.ts"),
      [
        "export interface Story {",
        '  covered_kind: "post" | "bulletin_item" | null;',
        ...PAD_PROPS,
        "}",
        "export interface Tail {",
        ...PAD_PROPS,
        '  z_last: "new";',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("does not flag a long type whose only difference is union order inside the cap", async () => {
    const cs = await extract(longRepo);
    const facts = await surfaceAnalyzer(cs, createContext(longRepo, cs.range));
    expect(facts.some((f) => f.detail.export === "Story")).toBe(false);
  });

  it("flags a real change even when it sits past the storage cap", async () => {
    const cs = await extract(longRepo);
    const facts = await surfaceAnalyzer(cs, createContext(longRepo, cs.range));
    const tail = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Tail",
    );
    expect(tail).toBeDefined();
    // The stored texts really were capped — members are name-sorted, so
    // z_last sits at the end, past the cap, and the two stored strings can
    // look identical. The finding must exist anyway.
    expect(String(tail!.detail.before)).toMatch(SIGNATURE_TRUNCATION_MARKER);
  });
});

describe("surfaceAnalyzer library-shaped type aliases", () => {
  // The defect this pins: `getPropertiesOfType` reports the *apparent*
  // type's members, and for anything whose expansion reaches
  // `Symbol.iterator` / `Symbol.unscopables` / `Symbol.asyncIterator` those
  // members come back named `__@iterator@20` — an internal symbol id that
  // differs between two separately-built programs. Every array, tuple, Map,
  // Set, or otherwise iterable alias therefore reported a fabricated
  // `signature_changed` on every run, under a `verified` badge, for source
  // that was never touched.
  let shapesRepo: string;

  const SHAPES = [
    "export type Names = string[];",
    "export type Pair = [string, number];",
    "export type Lookup = Map<string, number>;",
    "export type Ids = Set<number>;",
    "export type Rows = Array<{ id: string }>;",
    "export interface Bag extends Array<string> {}",
    "",
  ];

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    shapesRepo = dir;

    writeFileSync(join(dir, "src", "shapes.ts"), SHAPES.join("\n"));
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    // The only change: one new export. Every type alias above is
    // byte-identical on both sides.
    writeFileSync(
      join(dir, "src", "shapes.ts"),
      [...SHAPES, "export function added(): void {}", ""].join("\n"),
    );
  });

  it("reports nothing for untouched array, tuple, Set, and Map aliases", async () => {
    const cs = await extract(shapesRepo);
    const facts = await surfaceAnalyzer(cs, createContext(shapesRepo, cs.range));
    const touched = facts.map((f) => f.detail.export);
    for (const name of ["Names", "Pair", "Lookup", "Ids", "Rows", "Bag"]) {
      expect(touched).not.toContain(name);
    }
    // Exactly the one real change, nothing else.
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("export_added");
    expect(facts[0].detail.export).toBe("added");
  });

  it("prints an array or tuple alias as the short type the author wrote", async () => {
    const cs = await extract(shapesRepo);
    const before = exportedSignatures(
      await createContext(shapesRepo, cs.range).programAt(cs.range.from),
      shapesRepo,
      "src/shapes.ts",
    );
    expect(before).toBeDefined();
    expect(before!.get("Names")).toBe("string[]");
    expect(before!.get("Pair")).toBe("[string, number]");
    expect(before!.get("Lookup")).toBe("Map<string, number>");
    // Not the 35-member expansion of Array.prototype.
    for (const name of ["Names", "Pair", "Lookup", "Ids"]) {
      expect(before!.get(name)!.length).toBeLessThan(40);
    }
    // `interface Bag extends Array<string>` is hand-written, so it does
    // expand — and inherits Array's well-known-symbol members. Those must
    // print without the checker's internal id: `__@iterator`, never
    // `__@iterator@20`, which is the id that differs between programs.
    expect(before!.get("Bag")).toContain("__@iterator");
    for (const [, sig] of before!) {
      expect(sig).not.toMatch(/__@\w+@\d+/);
    }
  });

  it("still reports a real change to an array alias's element type", async () => {
    const { dir, run: run2 } = makeRepo();
    writeFileSync(join(dir, "src", "a.ts"), "export type Names = string[];\n");
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);
    writeFileSync(join(dir, "src", "a.ts"), "export type Names = number[];\n");

    const cs = await extract(dir);
    const facts = await surfaceAnalyzer(cs, createContext(dir, cs.range));
    const sig = facts.find((f) => f.kind === "signature_changed");
    expect(sig).toBeDefined();
    expect(sig!.detail.export).toBe("Names");
    expect(sig!.detail.before).toBe("string[]");
    expect(sig!.detail.after).toBe("number[]");
  });
});

describe("surfaceAnalyzer function-type exports", () => {
  let fnRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    fnRepo = dir;

    writeFileSync(
      join(dir, "src", "handler.ts"),
      [
        "export type Handler = (req: string) => string;",
        "export interface Callable {",
        "  (req: string): string;",
        "  extra: number;",
        "}",
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "handler.ts"),
      [
        "export type Handler = (req: string, extra: number) => void;",
        "export interface Callable {",
        "  (req: string, extra: number): void;",
        "  extra: number;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("flags a changed function-type alias", async () => {
    const cs = await extract(fnRepo);
    const facts = await surfaceAnalyzer(cs, createContext(fnRepo, cs.range));
    const sig = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Handler",
    );
    expect(sig).toBeDefined();
    expect(String(sig!.detail.before)).toContain("(req: string) => string");
    expect(String(sig!.detail.after)).toContain("extra: number");
  });

  it("flags an interface whose call signature changed, which its properties do not show", async () => {
    const cs = await extract(fnRepo);
    const facts = await surfaceAnalyzer(cs, createContext(fnRepo, cs.range));
    const sig = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Callable",
    );
    // The `extra: number` property is unchanged, so structural expansion
    // alone reports the two sides as identical.
    expect(sig).toBeDefined();
    expect(String(sig!.detail.before)).toContain("(req: string): string");
    expect(String(sig!.detail.after)).toContain("(req: string, extra: number): void");
  });
});

describe("surfaceAnalyzer union of a non-exported interface", () => {
  // Pins the limitation documented on `structuralSignature`: a union member
  // that is an interface prints as its bare name, so a change inside it is
  // invisible through the union — and when that interface is not exported,
  // no file emits a compensating finding for it either. This test exists so
  // the comment stops being a claim and starts being a fact.
  let unionRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    unionRepo = dir;

    writeFileSync(
      join(dir, "src", "u.ts"),
      [
        "interface Hidden {",
        "  p: string;",
        "}",
        "export type Maybe = Hidden | string;",
        "",
      ].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    writeFileSync(
      join(dir, "src", "u.ts"),
      [
        "interface Hidden {",
        "  p: string;",
        "  q: number;",
        "}",
        "export type Maybe = Hidden | string;",
        "",
      ].join("\n"),
    );
  });

  it("prints the union by member name and stays silent about the hidden member", async () => {
    const cs = await extract(unionRepo);
    const facts = await surfaceAnalyzer(cs, createContext(unionRepo, cs.range));
    expect(facts).toEqual([]);
    const sigs = exportedSignatures(
      await createContext(unionRepo, cs.range).programAt(cs.range.to),
      unionRepo,
      "src/u.ts",
    );
    expect(sigs!.get("Maybe")).toBe("Hidden | string");
  });
});

describe("exportedSignatures on a file the program does not have", () => {
  it("returns undefined rather than an empty map", async () => {
    const { dir, run: run2 } = makeRepo();
    writeFileSync(join(dir, "src", "a.ts"), "export const x = 1;\n");
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);
    writeFileSync(join(dir, "src", "a.ts"), "export const x = 2;\n");

    const cs = await extract(dir);
    const program = await createContext(dir, cs.range).programAt(cs.range.to);
    // An empty map here would read as "this file exports nothing", and every
    // export on the other side would be reported added or removed.
    expect(exportedSignatures(program, dir, "src/does-not-exist.ts")).toBeUndefined();
    expect(exportedSignatures(program, dir, "src/a.ts")).toBeInstanceOf(Map);
  });
});

describe("surfaceAnalyzer signature truncation", () => {
  // A single enormous type must not be able to flood the report. This is
  // the one path that is correct by inspection but was never exercised:
  // nothing else in this file produces a signature anywhere near the cap.
  let bigRepo: string;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    bigRepo = dir;

    writeFileSync(
      join(dir, "src", "big.ts"),
      ["export interface Big {", "  p0: number;", "}", ""].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);

    // Enough `pN: number;` members to comfortably clear MAX_SIGNATURE_LENGTH.
    const members = Array.from({ length: 60 }, (_, i) => `  p${i}: number;`);
    writeFileSync(
      join(dir, "src", "big.ts"),
      ["export interface Big {", ...members, "}", ""].join("\n"),
    );
  });

  it("truncates a signature over the cap with a visible marker", async () => {
    const cs = await extract(bigRepo);
    const facts = await surfaceAnalyzer(cs, createContext(bigRepo, cs.range));
    const big = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "Big",
    );
    expect(big).toBeDefined();
    const after = String(big!.detail.after);
    expect(after).toContain("… [truncated,");
    expect(after).toContain("more chars]");
    // The cap itself, not the untruncated ~700+ char structural expansion.
    expect(after.length).toBeLessThan(500);
  });
});

describe("surfaceAnalyzer long string-literal signatures", () => {
  // The class the render marker exists for: a secret-shaped literal far
  // past the checker's *own* default stringification cap, which used to cut
  // the text with an in-band `...` before either of this module's layers
  // saw it — so the recorded length was the checker's cap, not the type's.
  let literalRepo: string;
  const oldLiteral = `OLDHEAD_${"C".repeat(592)}`;
  const newLiteral = `NEWHEAD_${"C".repeat(592)}`;

  beforeAll(() => {
    const { dir, run: run2 } = makeRepo();
    literalRepo = dir;
    writeFileSync(join(dir, "src", "t.ts"), `export const LONGV = "${oldLiteral}";\n`);
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);
    writeFileSync(join(dir, "src", "t.ts"), `export const LONGV = "${newLiteral}";\n`);
  });

  it("records the true code-point length beside the capped text, and the rendered marker states it end-to-end", async () => {
    const cs = await extract(literalRepo);
    const facts = await surfaceAnalyzer(cs, createContext(literalRepo, cs.range));
    const sig = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "LONGV",
    );
    expect(sig).toBeDefined();

    // The printed literal type is the source literal plus its two quotes.
    const trueChars = newLiteral.length + 2;
    expect(sig!.detail.afterChars).toBe(trueChars);
    expect(sig!.detail.beforeChars).toBe(oldLiteral.length + 2);

    // The stored text is this module's own cap and marker — never the
    // checker's in-band "..." cut, which stopped far short of the cap and
    // made the stored text lie about where the type ended.
    const storedAfter = String(sig!.detail.after);
    expect(storedAfter).toContain("… [truncated,");
    expect(storedAfter).not.toContain("...");
    expect(storedAfter).toContain(`[truncated, ${trueChars - MAX_SIGNATURE_LENGTH} more chars]`);

    // End to end: the body's marker states the type's real size, and the
    // storage marker does not leak into the rendered tail.
    const body = toFinding(sig!).body;
    expect(body).toContain(`(${trueChars} chars)`);
    expect(body).not.toContain("more chars]");
    expect(body).not.toContain("...");
  });

  it("cuts the stored text by code point, leaving no lone surrogate at the cap", async () => {
    const { dir, run: run2 } = makeRepo();
    const astral = "🜁".repeat(500);
    writeFileSync(join(dir, "src", "a.ts"), 'export const GLYPHS = "x";\n');
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);
    writeFileSync(join(dir, "src", "a.ts"), `export const GLYPHS = "${astral}";\n`);

    const cs = await extract(dir);
    const facts = await surfaceAnalyzer(cs, createContext(dir, cs.range));
    const sig = facts.find(
      (f) => f.kind === "signature_changed" && f.detail.export === "GLYPHS",
    );
    expect(sig).toBeDefined();
    const stored = String(sig!.detail.after);
    // 500 astral characters plus two quotes, counted in code points.
    const trueChars = 502;
    expect(sig!.detail.afterChars).toBe(trueChars);
    expect(stored).toContain(`[truncated, ${trueChars - MAX_SIGNATURE_LENGTH} more chars]`);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(stored)).toBe(false);
  });
});

describe("surfaceAnalyzer and the project's own compiler options", () => {
  /** Commits one export in a JavaScript module, then adds a second beside it, uncommitted. */
  function commitThenAddExport(dir: string, run2: (args: string[]) => void, path: string): void {
    writeFileSync(
      join(dir, path),
      ["export function helper() {", "  return true;", "}", ""].join("\n"),
    );
    run2(["add", "-A"]);
    run2(["commit", "-m", "first"]);
    writeFileSync(
      join(dir, path),
      [
        "export function helper() {",
        "  return true;",
        "}",
        "export function addedInJs() {",
        "  return false;",
        "}",
        "",
      ].join("\n"),
    );
  }

  it("reports the added export in a .mjs file when the project's tsconfig allows JavaScript", async () => {
    const { dir, run: run2 } = makeRepo();
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { allowJs: true } }),
    );
    commitThenAddExport(dir, run2, "src/util.mjs");

    const cs = await extract(dir);
    const facts = await surfaceAnalyzer(cs, createContext(dir, cs.range));
    expect(
      facts.filter((f) => f.kind === "export_added").map((f) => f.detail.export),
    ).toContain("addedInJs");
  });

  it("reports nothing for the same .mjs change, and does not throw, when the tsconfig admits neither allowJs nor checkJs", async () => {
    const { dir, run: run2 } = makeRepo();
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    commitThenAddExport(dir, run2, "src/util.mjs");

    const cs = await extract(dir);
    const facts = await surfaceAnalyzer(cs, createContext(dir, cs.range));
    expect(facts).toEqual([]);
  });
});
