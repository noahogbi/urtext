import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runAnalyzers } from "../../src/analyze/index.js";
import { suppressionNote } from "../../src/report/coverage.js";
import { renderMarkdown } from "../../src/report/markdown.js";
import {
  BEYOND_INTENT_MEANING,
  buildReportModel,
  plainText,
  type ReportMeta,
  type ReportModel,
} from "../../src/report/model.js";
import { createContext, extract } from "../../src/extract/index.js";
import { rank, toFinding } from "../../src/score/index.js";
import { WORKTREE, type Changeset, type Finding } from "../../src/types.js";

const changeset: Changeset = {
  range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
  files: [
    {
      path: "a.ts",
      status: "modified",
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }],
      symbols: [],
    },
    {
      path: "b.ts",
      status: "modified",
      hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
      symbols: [],
    },
  ],
};

const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  warnings: [],
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "effect_added:a.ts:network",
  tier: "verified",
  file: "a.ts",
  line: 3,
  title: "introduces a network effect",
  body: "This file previously had no network effect. It now does, at one site.",
  score: 60,
  evidence: [{ file: "a.ts", line: 3, excerpt: "fetch(u);" }],
  ...over,
});

/** A model around one finding, with the overrides the cases below need. */
function modelWith(over: Partial<Finding> = {}, m: Partial<ReportMeta> = {}): ReportModel {
  return buildReportModel(changeset, [finding(over)], meta(m));
}

/** A model whose only finding is a model claim, leaving both filtered lenses empty. */
function emptyLensModel(): ReportModel {
  return buildReportModel(
    changeset,
    [finding({ id: "claim:0:c1", tier: "model", evidence: [] })],
    meta({ model: "claude-opus-5" }),
  );
}

/** One lens section's markdown, from its H2 to the next H2 or the end. */
function section(md: string, label: string): string {
  const start = md.indexOf(`## ${label}`);
  expect(start).toBeGreaterThan(-1);
  const rest = md.slice(start);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("renderMarkdown shape", () => {
  it("opens with the H1 and the scope line", () => {
    const md = renderMarkdown(modelWith());
    expect(md.startsWith("# urtext review\n")).toBe(true);
    expect(md).toContain("2 files, 7 lines changed · vs origin/main");
  });

  it("renders one H2 per lens, in the lens display order", () => {
    const md = renderMarkdown(modelWith());
    const narrative = md.indexOf("## Narrative");
    const effects = md.indexOf("## Effects & contracts");
    const surface = md.indexOf("## API surface");
    expect(narrative).toBeGreaterThan(-1);
    expect(effects).toBeGreaterThan(narrative);
    expect(surface).toBeGreaterThan(effects);
  });

  it("heads a finding with glyph, headline, and tier", () => {
    const md = renderMarkdown(modelWith());
    expect(md).toContain("### ▲ a.ts:3 — introduces a network effect [verified]");
  });

  it("keeps a newline inside a body paragraph from starting a Markdown structure line", () => {
    // Upstream composes bodies single-line today (typeToString emits one
    // line), but nothing pins that — so a paragraph carrying a newline
    // followed by structure syntax is the probe: it must render inside the
    // paragraph as text, never as a new heading or blockquote line.
    const md = renderMarkdown(
      modelWith({ body: "The analyzer said this.\n# fake heading\n> fake quote" }),
    );
    const lines = md.split("\n");
    expect(lines).not.toContain("# fake heading");
    expect(lines).not.toContain("> fake quote");
    expect(md).toContain("The analyzer said this. # fake heading > fake quote");
  });

  it("marks a before-side evidence line so it is not read as a working-tree line", () => {
    const md = renderMarkdown(
      modelWith({
        id: "guard_removed:old.ts:119:diff:if",
        file: "old.ts",
        line: 119,
        evidence: [{ file: "old.ts", line: 119, excerpt: "if (seen) continue;", side: "before" }],
      }),
    );
    // The headline and the evidence ref name the same place, so both carry it.
    expect(md).toContain("### ▲ old.ts:119 (before) — introduces a network effect [verified]");
    expect(md).toContain("old.ts:119 (before)\n");
  });
});

describe("renderMarkdown fences", () => {
  it("escalates the fence past any backtick run in the excerpt", () => {
    const md = renderMarkdown(
      modelWith({ evidence: [{ file: "a.ts", line: 3, excerpt: "const s = ```;" }] }),
    );
    expect(md).toContain("````");
    expect(md).toMatch(/````[\s\S]*const s = ```;[\s\S]*````/);
    // The escalated fence is longer than every run inside, so the block
    // still closes where the walker closed it, not where the excerpt says.
    expect(md).not.toMatch(/^```$/m);
  });

  it("tags the fence with the language the file extension names", () => {
    const md = renderMarkdown(
      modelWith({ evidence: [{ file: "widget.tsx", line: 4, excerpt: "<Widget />" }] }),
    );
    expect(md).toContain("```tsx\n<Widget />\n```");
  });

  it("leaves the info string empty for an extension it does not know", () => {
    const md = renderMarkdown(
      modelWith({ evidence: [{ file: "run.py", line: 1, excerpt: "print(1)" }] }),
    );
    expect(md).toContain("```\nprint(1)\n```");
    expect(md).not.toContain("```py");
  });

  it("keeps a multi-line excerpt inside one fence", () => {
    const md = renderMarkdown(
      modelWith({ evidence: [{ file: "a.ts", line: 1, excerpt: "\tif (x) {\n\t\treturn;" }] }),
    );
    expect(md).toContain("```ts\n\tif (x) {\n\t\treturn;\n```");
  });
});

describe("renderMarkdown concealment", () => {
  it("keeps a concealment label verbatim where the model put one", () => {
    const rlo = "\u202E";
    const md = renderMarkdown(
      modelWith({ evidence: [{ file: "a.ts", line: 3, excerpt: `a${rlo}b` }] }),
    );
    expect(md).toContain("a[U+202E]b");
    expect(md).not.toContain(rlo);
  });

  it("carries no raw concealing character from any labeled field", () => {
    const md = renderMarkdown(
      modelWith(
        { title: "send\u200D changed", body: "It reads \u0007 from the socket." },
        { warnings: ["the model wrote \uFEFF here"] },
      ),
    );
    for (const raw of ["\u200D", "\u0007", "\uFEFF"]) {
      expect(md).not.toContain(raw);
    }
    for (const label of ["[U+200D]", "[U+0007]", "[U+FEFF]"]) {
      expect(md).toContain(label);
    }
  });
});

describe("renderMarkdown empty lenses", () => {
  it("renders an empty lens with the filter-shaped copy, never a claim about the code", () => {
    const md = renderMarkdown(emptyLensModel());
    const effects = section(md, "Effects & contracts");
    expect(effects).toContain("Nothing in this range matched this view");
    expect(effects).not.toContain("nothing crossed a boundary");
    expect(effects).not.toContain("no promise moved");
    expect(section(md, "API surface")).toContain("Nothing in this range matched this view");
  });

  it("keeps a model claim in the narrative section and out of the filtered ones", () => {
    const md = renderMarkdown(emptyLensModel());
    expect(section(md, "Narrative")).toContain("introduces a network effect");
    expect(section(md, "Effects & contracts")).not.toContain("introduces a network effect");
  });
});

describe("renderMarkdown disclosures", () => {
  it("puts every disclosure above the first lens heading", () => {
    const model = buildReportModel(
      {
        ...changeset,
        files: [...changeset.files, { path: "gone.ts", status: "deleted", hunks: [], symbols: [] }],
      },
      [finding({ tier: "inferred", claim: { summary: "s", reasoning: "hot path" } })],
      meta({ model: "claude-opus-5", warnings: ["the effects analyzer failed"], suppressed: 2 }),
    );
    const md = renderMarkdown(model);
    const firstLens = md.indexOf("## ");
    expect(firstLens).toBeGreaterThan(-1);
    for (const disclosure of [
      "claude-opus-5 interpreted this change.",
      "the effects analyzer failed",
      "1 deleted TypeScript file: gone.ts",
      suppressionNote(2),
    ]) {
      const at = md.indexOf(disclosure);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstLens);
      // A disclosure is a blockquote, so it reads as the report's own voice
      // set apart from the findings.
      expect(md.slice(md.lastIndexOf("\n", at) + 1, at + 1).startsWith("> ")).toBe(true);
    }
  });

  it("says the review is partial when any note exists, and stays quiet otherwise", () => {
    const partial = renderMarkdown(modelWith({}, { warnings: ["analyzer failed"] }));
    expect(partial.indexOf("This review is partial.")).toBeLessThan(partial.indexOf("## "));
    expect(renderMarkdown(modelWith())).not.toContain("This review is partial.");
  });

  it("says nothing about filtering when nothing was suppressed", () => {
    expect(renderMarkdown(modelWith())).not.toContain("Filtered:");
  });
});

describe("renderMarkdown model attribution", () => {
  const REASONING = "This runs on every request, so the cost is per-call.";

  it("renders the model note as a blockquote whose first line is the attribution", () => {
    const md = renderMarkdown(
      modelWith(
        {
          id: "signature_changed:a.ts:3:send:send",
          tier: "inferred",
          claim: { summary: "hot path", reasoning: REASONING },
        },
        { model: "claude-opus-5" },
      ),
    );
    expect(md).toContain(`> unverified · claude-opus-5\n>\n> ${REASONING}`);
    // The caution travels in the same blockquote as the prose.
    expect(md).toContain("> The finding above is an analyzer's.");
  });

  it("attributes model prose even when the run recorded no model name", () => {
    const md = renderMarkdown(
      modelWith({ id: "claim:0:c1", tier: "model", body: REASONING, evidence: [] }),
    );
    expect(md).toContain(`> unverified · an unnamed model\n>\n> ${REASONING}`);
    expect(md).toContain("> Nothing mechanical corroborates this.");
    // The prose appears nowhere outside its attributed blockquote.
    const bare = md
      .split("\n")
      .filter((line) => line.includes(REASONING) && !line.startsWith("> "));
    expect(bare).toHaveLength(0);
  });
});

describe("renderMarkdown ordering", () => {
  it("preserves model order within a lens", () => {
    const md = renderMarkdown(
      buildReportModel(
        changeset,
        [
          finding({ title: "ranked first" }),
          finding({ id: "guard_removed:a.ts:9:f:if", title: "ranked second" }),
          finding({ id: "effect_added:b.ts:env", title: "ranked third" }),
        ],
        meta(),
      ),
    );
    const effects = section(md, "Effects & contracts");
    expect(effects.indexOf("ranked first")).toBeGreaterThan(-1);
    expect(effects.indexOf("ranked first")).toBeLessThan(effects.indexOf("ranked second"));
    expect(effects.indexOf("ranked second")).toBeLessThan(effects.indexOf("ranked third"));
  });
});

/**
 * The lens routing classifies on id prefixes produced by the analyzers,
 * modules away — a fixture written to match today's format cannot notice
 * tomorrow's changing. So, as `test/report/html.test.ts` does, this suite
 * drives real analyzers over a real repository and renders what they produce.
 */
describe("renderMarkdown against real analyzer output", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "urtext-md-"));
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@e.com"]);
    git(["config", "user.name", "T"]);
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
    git(["add", "-A"]);
    git(["commit", "-m", "first"]);
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

  it("lands a real finding's headline and evidence under its own lens heading", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    const model = buildReportModel(cs, findings, { warnings: [] });
    const md = renderMarkdown(model);

    const effects = section(md, "Effects & contracts");
    expect(effects).toContain("guard was removed");
    expect(effects).toContain("network effect");
    expect(section(md, "API surface")).toContain("changed its signature");

    // The guard finding's evidence — headline and fenced excerpt — sits in
    // the same section as its heading, not under some other lens.
    const guard = model.findings.find((f) => f.id.startsWith("guard_removed:"));
    expect(guard).toBeDefined();
    expect(effects).toContain(`### ${guard!.glyph} ${plainText(guard!.headline)} [${guard!.tier}]`);
    for (const e of guard!.evidence) {
      expect(effects).toContain(plainText(e.excerpt));
    }
    // Neither filled lens may claim nothing matched it.
    expect(effects).not.toContain("Nothing in this range matched this view");
  });

  it("never drops a finding: every headline the model carries appears exactly once", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    const model = buildReportModel(cs, findings, { warnings: [] });
    const md = renderMarkdown(model);
    expect(model.findings.length).toBeGreaterThan(0);
    for (const f of model.findings) {
      const heading = `### ${f.glyph} `;
      expect(md).toContain(heading);
      const occurrences = md.split(`[${f.tier}]\n`).length - 1;
      expect(occurrences).toBeGreaterThan(0);
    }
    // Grouping partitions, so headings count up to exactly the finding count.
    expect(md.split("\n### ").length - 1).toBe(model.findings.length);
  });
});

describe("renderMarkdown beyond stated intent", () => {
  it("appends the mark to the finding heading and quotes the legend among the disclosures", () => {
    const md = renderMarkdown(modelWith({ tier: "inferred", beyondIntent: true, claim: { summary: "s", reasoning: "r" } }, { model: "claude-opus-5" }));
    expect(md).toContain("### ● a.ts:3 — introduces a network effect [inferred] (beyond stated intent)");
    expect(md).toContain(`> ${BEYOND_INTENT_MEANING}`);
    // Above the first lens heading, with the other disclosures.
    expect(md.indexOf(BEYOND_INTENT_MEANING)).toBeLessThan(md.indexOf("## Narrative"));
  });

  it("writes neither the heading mark nor the legend blockquote when nothing is marked", () => {
    expect(renderMarkdown(modelWith())).not.toContain("beyond stated intent");
  });
});

/**
 * One real citation finding, composed by `toFinding` rather than written out
 * here, so this surface is checked against the copy the scorer actually
 * produces and not against a restatement of it.
 */
const citationFinding = (): Finding =>
  toFinding({
    id: "citation_rot:docs/a.md:1:content_drift",
    kind: "citation_rot",
    file: "docs/a.md",
    line: 1,
    detail: {
      rot: "content_drift",
      citedFile: "src/a.ts",
      citedLine: 1,
      was: "export const limit = 1;",
      now: "export const limit = 99;",
      baseline: "3f2a1c9",
    },
    evidence: [
      { file: "docs/a.md", line: 1, excerpt: "The limit is set at src/a.ts:1.", side: "after" },
      { file: "src/a.ts", line: 1, excerpt: "export const limit = 99;", side: "after" },
    ],
  });

describe("renderMarkdown citation findings", () => {
  it("writes a citation finding's headline, body, and both evidence excerpts", () => {
    const md = renderMarkdown(buildReportModel(changeset, [citationFinding()], meta()));
    expect(md).toContain(
      "### ▲ docs/a.md:1 — cites `src/a.ts:1`, which no longer reads the same [verified]",
    );
    expect(md).toContain(
      "The citation still resolves to a line; it no longer resolves to the same content.",
    );
    expect(md).toContain("\ndocs/a.md:1\n");
    expect(md).toContain("```\nThe limit is set at src/a.ts:1.\n```");
    expect(md).toContain("\nsrc/a.ts:1\n");
    expect(md).toContain("```ts\nexport const limit = 99;\n```");
  });
});
