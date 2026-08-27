import { describe, expect, it } from "vitest";
import { detectEffects, effectsAnalyzer } from "../../src/analyze/effects.js";
import { MAX_EVIDENCE } from "../../src/analyze/fact.js";
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
    // A real assertion, not a stub: the effects analyzer is purely syntactic,
    // so if it ever starts building a program these tests fail loudly.
    async programAt(): Promise<never> {
      throw new Error("effectsAnalyzer must not build a program");
    },
  };
}

const changesetFor = (path: string): Changeset => ({
  range: { from: "abc", to: WORKTREE, label: "vs main" },
  files: [{ path, status: "modified", hunks: [], symbols: [] }],
});

describe("effectsAnalyzer", () => {
  it("stays silent when a surviving file's after-state cannot be read", async () => {
    // A missing after-side means the content is unavailable, not that the
    // effects are gone. Reporting a removal here is how a bad range or a bad
    // working directory becomes a confident, wrong `verified` finding.
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "export const x = fetch(u);\n", after: null } }),
    );
    expect(facts).toEqual([]);
  });

  it("still reports a deleted file's effects as removed", async () => {
    const changeset: Changeset = {
      range: { from: "abc", to: WORKTREE, label: "vs main" },
      files: [{ path: "a.ts", status: "deleted", hunks: [], symbols: [] }],
    };
    const facts = await effectsAnalyzer(
      changeset,
      ctxFor({ "a.ts": { before: "export const x = fetch(u);\n", after: null } }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("effect_removed");
  });

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

  it("reports the true site count even when evidence is capped at MAX_EVIDENCE", async () => {
    const twelveFetches = Array.from({ length: 12 }, (_, i) => `fetch(u${i});`).join("\n") + "\n";
    const facts = await effectsAnalyzer(
      changesetFor("a.ts"),
      ctxFor({ "a.ts": { before: "export const x = 1;\n", after: twelveFetches } }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].detail.sites).toBe(12);
    expect(facts[0].evidence.length).toBe(MAX_EVIDENCE);
  });

  it("stamps a removed effect on a renamed file with the old path, not the new one", async () => {
    const facts = await effectsAnalyzer(
      {
        range: { from: "abc", to: WORKTREE, label: "vs main" },
        files: [
          { path: "new.ts", previousPath: "old.ts", status: "renamed", hunks: [], symbols: [] },
        ],
      },
      ctxFor({
        "old.ts": { before: "fs.readFileSync(p);\n", after: null },
        "new.ts": { before: null, after: "export const x = 1;\n" },
      }),
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].kind).toBe("effect_removed");
    expect(facts[0].file).toBe("old.ts");
    expect(facts[0].line).toBe(1);
    expect(facts[0].evidence[0].file).toBe("old.ts");
  });
});
