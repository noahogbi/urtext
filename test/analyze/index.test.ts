import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ANALYZERS, makeFact, runAnalyzers } from "../../src/analyze/index.js";
import { createContext, extract } from "../../src/extract/index.js";
import { rank } from "../../src/score/index.js";
import type { Analyzer } from "../../src/types.js";

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
  it("registers six analyzers", () => {
    expect(ANALYZERS).toHaveLength(6);
  });

  it("registers the dependency analyzer under its own name", () => {
    expect(ANALYZERS.map((a) => a.name)).toContain("dependencyAnalyzer");
  });

  it("registers the citations analyzer under its own name", () => {
    expect(ANALYZERS.map((a) => a.name)).toContain("citationsAnalyzer");
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

  // The invariant every analyzer has to hold, checked across all of them at
  // once rather than analyzer by analyzer. It has been broken three times
  // by facts built by hand, each time producing a finding that pointed at
  // the wrong place; `makeFact` is what makes the broken version
  // unrepresentable, and this is what proves every analyzer goes through it.
  it("anchors every fact from every analyzer to its own first evidence ref", async () => {
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range));
    expect(facts.length).toBeGreaterThan(0);
    // All four analyzers, not just whichever happened to fire.
    expect(new Set(facts.map((f) => f.kind)).size).toBeGreaterThan(1);
    for (const f of facts) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.evidence[0].excerpt).not.toBe("");
      expect(f.file).toBe(f.evidence[0].file);
      expect(f.line).toBe(f.evidence[0].line);
    }
  });
});

describe("runAnalyzers when one analyzer throws", () => {
  const boom: Analyzer = async function explodingAnalyzer() {
    throw new Error("compiler exploded");
  };
  const ok: Analyzer = async function workingAnalyzer() {
    return [
      makeFact({
        id: "x",
        kind: "effect_added",
        detail: { effect: "network", sites: 1 },
        evidence: [{ file: "a.ts", line: 1, excerpt: "fetch(u);" }],
      }),
    ];
  };

  it("keeps the facts from the analyzers that succeeded", async () => {
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range), [boom, ok]);
    expect(facts.map((f) => f.id)).toEqual(["x"]);
  });

  it("names the analyzer that failed, so a partial review says so", async () => {
    const cs = await extract(repo);
    const failures: string[] = [];
    await runAnalyzers(cs, createContext(repo, cs.range), [boom, ok], (f) =>
      failures.push(`${f.analyzer}: ${f.message}`),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("explodingAnalyzer");
    expect(failures[0]).toContain("compiler exploded");
  });
});
