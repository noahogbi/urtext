import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  composeComment,
  emptiedViewCopy,
  FAILURE_CLOSING,
  FAILURE_HEADLINE,
  LOG_TAIL_LINES,
  assemble,
  segment,
} from "../../action/compose-comment.mjs";
import { review } from "../../src/cli.js";
import { buildReportModel, EMPTY_LENS_COPY, LENSES } from "../../src/report/model.js";
import { renderMarkdown } from "../../src/report/markdown.js";
import { WORKTREE, type Changeset, type Finding } from "../../src/types.js";

const MARKER = "<!-- urtext-review -->";
const RUN_URL = "https://github.com/noahogbi/urtext/actions/runs/1";
const ARTIFACT_URL = "https://github.com/noahogbi/urtext/actions/runs/1/artifacts/2";
const HUGE = 1_000_000;

// Same isolation and canonicalization the CLI suite uses: global git config
// (signing, a shared hooksPath) has no business deciding whether these pass,
// and mkdtemp may spell the directory differently than git reports it.
const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const gitIn = (cwd: string, args: string[]) =>
  execFileSync("git", [...ISOLATION, ...args], { cwd, stdio: "pipe" });
const mkCanonicalTempDir = (prefix: string) =>
  realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

/** A repository whose working tree introduces `count` distinct network effects. */
function repoWithEffects(prefix: string, count: number): string {
  const dir = mkCanonicalTempDir(prefix);
  const run = (args: string[]) => gitIn(dir, args);
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `m${i}.ts`), `export function load${i}(id: string) {\n  return id;\n}\n`);
  }
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(dir, `m${i}.ts`),
      `export function load${i}(id: string) {\n  return fetch(id);\n}\n`,
    );
  }
  return dir;
}

const reviewMarkdown = async (cwd: string): Promise<string> => {
  const r = await review(cwd, { command: "review", json: false, noLlm: true, help: false, stdout: "md" });
  expect(r.markdown, "the fixture repo produced no review").toBeDefined();
  return r.markdown!;
};

let findingsReview: string;
let emptyReview: string;

beforeAll(async () => {
  findingsReview = await reviewMarkdown(repoWithEffects("urtext-compose-", 6));
  // No edit after the commit: an empty diff, so every lens renders
  // EMPTY_LENS_COPY and nothing else.
  const clean = mkCanonicalTempDir("urtext-compose-clean-");
  const run = (args: string[]) => gitIn(clean, args);
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(clean, "a.ts"), "export const a = 1;\n");
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);
  const r = await review(clean, {
    command: "review",
    json: false,
    noLlm: true,
    help: false,
    range: "HEAD",
    stdout: "md",
  });
  emptyReview = r.markdown!;
});

const base = (over: Record<string, unknown> = {}) => ({
  marker: MARKER,
  limit: HUGE,
  review: findingsReview,
  log: "",
  exitCode: 0,
  range: "8f3c1a2...b91d4e0",
  runUrl: RUN_URL,
  ...over,
});

/** How many `### ` findings a body carries, per the composer's own scanner. */
const findingCount = (body: string): number =>
  segment(body).sections.reduce((n, s) => n + s.findings.length, 0);

/** Every fence in the text is opened and closed. */
function fencesBalanced(text: string): boolean {
  let open = 0;
  for (const line of text.split("\n")) {
    const run = /^(`{3,})/.exec(line);
    if (!run) continue;
    if (open === 0) open = run[1].length;
    else if (/^`{3,}\s*$/.test(line) && run[1].length >= open) open = 0;
  }
  return open === 0;
}

describe("segment and assemble", () => {
  it("round-trips every real review byte for byte", () => {
    // The scanner's contract is "the shapes renderMarkdown emits". If a
    // segmentation loses or reorders a byte, everything below is unsound.
    for (const md of [findingsReview, emptyReview]) {
      const { head, sections } = segment(md);
      expect(assemble(head, sections)).toBe(md);
    }
  });

  it("finds one section per lens and at least one finding overall", () => {
    const { sections } = segment(findingsReview);
    expect(sections).toHaveLength(LENSES.length);
    expect(findingCount(findingsReview)).toBeGreaterThan(0);
  });

  it("is fence-aware: a `### ` line inside an excerpt is not a finding boundary", () => {
    // The excerpt is "the one place this document quotes text an adversary can
    // author outright" (src/report/markdown.ts). The analyzer copies the
    // source line verbatim, so choosing this text is choosing the adversary's
    // file, not hand-writing Markdown — the document below still comes from
    // the real buildReportModel and the real renderMarkdown.
    const changeset: Changeset = {
      range: { from: "abc123", to: WORKTREE, label: "vs origin/main" },
      files: [
        { path: "a.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 }], symbols: [] },
      ],
    };
    const findings: Finding[] = [
      {
        id: "effect_added:a.ts:network",
        tier: "verified",
        file: "a.ts",
        line: 3,
        title: "introduces a network effect",
        body: "This file previously had no network effect. It now does, at one site.",
        score: 60,
        evidence: [
          { file: "a.ts", line: 3, excerpt: "``` and then some" },
          { file: "a.ts", line: 4, excerpt: "### not a heading, a line of a file" },
        ],
      },
    ];
    const md = renderMarkdown(buildReportModel(changeset, findings, { warnings: [] }));
    // Two fenced lines that a bare `^### ` scan would read as a boundary.
    expect(md).toContain("### not a heading, a line of a file");
    expect(findingCount(md)).toBe(1);
    const adversarial = segment(md);
    expect(assemble(adversarial.head, adversarial.sections)).toBe(md);

    // And truncating it never leaves a fence hanging.
    const composed = composeComment(base({ review: md, limit: MARKER.length + 400 }));
    expect(fencesBalanced(composed.body)).toBe(true);
  });
});

describe("composeComment", () => {
  it("leads every branch with the marker, satisfying the upsert's own predicate", () => {
    const bodies = [
      composeComment(base()).body,
      composeComment(base({ limit: 900 })).body,
      composeComment(base({ limit: MARKER.length + 300 })).body,
      composeComment(base({ exitCode: 1, log: "boom\n" })).body,
      composeComment(base({ review: "", log: "silence\n" })).body,
    ];
    for (const body of bodies) {
      // `startswith($m)`, the exact jq predicate the upsert uses.
      expect(body.startsWith(MARKER)).toBe(true);
      expect(body.startsWith(`${MARKER}\n`)).toBe(true);
    }
  });

  it("emits the review verbatim between marker and footer when it fits", () => {
    const r = composeComment(base());
    expect(r.outcome).toBe("reviewed");
    expect(r.omitted).toBe(0);
    expect(r.kept).toBe(findingCount(findingsReview));
    expect(r.body).toBe(`${MARKER}\n${findingsReview}\n<sub>Posted by [urtext](https://github.com/noahogbi/urtext) · [workflow run](${RUN_URL})</sub>\n`);
    expect(r.body).not.toContain("truncated");
  });

  it("carries a zero-findings review through the identical path", () => {
    const r = composeComment(base({ review: emptyReview }));
    expect(r.outcome).toBe("reviewed");
    expect(r.omitted).toBe(0);
    expect(r.kept).toBe(0);
    // All three views, verbatim; nothing between the review and the footer.
    expect(r.body.split(EMPTY_LENS_COPY)).toHaveLength(LENSES.length + 1);
    expect(r.body).not.toContain("truncated");
    expect(r.body).toBe(`${MARKER}\n${emptyReview}\n<sub>Posted by [urtext](https://github.com/noahogbi/urtext) · [workflow run](${RUN_URL})</sub>\n`);
  });

  it("links the artifact exactly when one was given, and the run always", () => {
    const without = composeComment(base()).body;
    expect(without).toContain(`[workflow run](${RUN_URL})`);
    expect(without).not.toContain("[full report]");
    const withArtifact = composeComment(base({ artifactUrl: ARTIFACT_URL })).body;
    expect(withArtifact).toContain(`[full report](${ARTIFACT_URL})`);
    expect(withArtifact).toContain(`[workflow run](${RUN_URL})`);
  });

  describe("over the limit", () => {
    const total = () => findingCount(findingsReview);
    const tight = () => composeComment(base({ limit: 1600, artifactUrl: ARTIFACT_URL }));

    it("fits the cap and says exactly how much it left out", () => {
      const r = tight();
      expect(r.body.length).toBeLessThanOrEqual(1600);
      expect(r.omitted).toBeGreaterThan(0);
      expect(r.kept).toBe(total() - r.omitted);
      expect(r.body).toContain("**This comment is truncated.**");
      expect(r.body).toContain(`${r.omitted} of ${total()} findings were left out`);
      // The cap is interpolated from the argument, never restated anywhere.
      expect(r.body).toContain("1600-character comment limit");
      expect(r.body).toContain(`[full report](${ARTIFACT_URL})`);
      expect(r.body).toContain(`[workflow run](${RUN_URL})`);
    });

    it("puts the notice among the disclosures, right after the scope line", () => {
      const r = tight();
      const scope = findingsReview.split("\n\n")[1];
      expect(r.body.indexOf(scope)).toBeLessThan(r.body.indexOf("**This comment is truncated.**"));
      expect(r.body.indexOf("**This comment is truncated.**")).toBeLessThan(
        r.body.indexOf(`## ${LENSES[0].label}`),
      );
    });

    it("keeps every surviving finding whole, with balanced fences", () => {
      const r = tight();
      expect(fencesBalanced(r.body)).toBe(true);
      expect(findingCount(r.body)).toBe(r.kept);
      for (const line of r.body.split("\n")) {
        // No half-finding: a heading line always still has its glyph and tier.
        if (line.startsWith("### ")) expect(line).toMatch(/\[(verified|inferred|model)\]/);
      }
    });

    it("keeps a prefix of each view, which is that view's highest-ranked findings", () => {
      const r = tight();
      const before = segment(findingsReview).sections;
      const after = segment(r.body).sections;
      for (let i = 0; i < before.length; i++) {
        const kept = after[i].findings.map((f) => f[0]);
        const original = before[i].findings.map((f) => f[0]);
        expect(kept).toEqual(original.slice(0, kept.length));
      }
    });

    it("takes every removal from the view that is largest at the time", () => {
      // The policy, restated independently of the implementation: cut one
      // finding from whichever view currently holds the most, ties going to
      // the later view in document order, and repeat. Written out here rather
      // than asserted through a property, because a property that survives
      // several distributions is exactly how the earlier version of this test
      // went quiet — it asserted only that the largest view shrank, which a
      // policy taking its first cut from the smallest view and its second
      // from the largest also satisfies.
      const simulate = (counts: number[], cuts: number): number[] => {
        const out = [...counts];
        for (let i = 0; i < cuts; i++) {
          let victim = -1;
          for (let j = 0; j < out.length; j++) {
            // `>=`, so a tie leaves the later view holding the cut — the
            // comparison `largest` in `action/compose-comment.mjs` makes.
            if (out[j] > 0 && (victim < 0 || out[j] >= out[victim])) victim = j;
          }
          // Every view emptied and still over the limit is the
          // disclosure-overflow path, which returns a failure body instead;
          // no sweep entry below reaches it, since those are skipped.
          if (victim < 0) break;
          out[victim]--;
        }
        return out;
      };

      const before = segment(findingsReview).sections.map((s) => s.findings.length);
      const biggest = Math.max(...before);
      const tied = before.flatMap((n, i) => (n === biggest ? [i] : []));
      expect(tied.length, "the corpus has no tie for the rule to break").toBeGreaterThan(1);

      // Limits rather than one limit, because a single one pins a single
      // distribution — and which distributions this corpus can reach is
      // fixture arithmetic that moves whenever a finding body or the header
      // changes size. The tightest limit that truncates at all leads, since
      // the first cut is the one with no earlier cut to hide behind.
      const full = composeComment(base()).body.length;
      const limits = [full - 1];
      for (let limit = full; limit > full / 3; limit -= 40) limits.push(limit);

      let sawTruncation = false;
      let sawTieBroken = false;
      for (const limit of limits) {
        const probe = composeComment(base({ limit }));
        if (probe.outcome !== "reviewed") continue;
        const after = segment(probe.body).sections.map((s) => s.findings.length);
        // Positional equality across every view, so this pins where each cut
        // landed and in what order — not merely how many were taken.
        expect(after, `at limit ${limit}`).toEqual(simulate(before, probe.omitted));
        if (probe.omitted > 0) sawTruncation = true;
        if (after[tied[0]] !== after[tied[tied.length - 1]]) sawTieBroken = true;
      }
      // A sweep that reached neither state would pass while asserting
      // nothing about truncation at all.
      expect(sawTruncation, "no limit in the sweep truncated anything").toBe(true);
      expect(sawTieBroken, "no limit in the sweep reached the tie case").toBe(true);
    });

    it("says an emptied view was emptied, and never that nothing matched it", () => {
      // "Nothing in this range matched this view" would be a lie about a view
      // whose findings this comment dropped.
      // Searched rather than hardcoded. The budget has to be tight enough to
      // empty a view and loose enough to still produce a review; the literal
      // that used to sit here satisfied both until the header grew — the
      // per-kind guidance moved out of the finding bodies and into it — and
      // then satisfied neither.
      const full = composeComment(base()).body.length;
      let r = composeComment(base());
      for (let limit = full; limit > MARKER.length; limit -= 25) {
        const probe = composeComment(base({ limit }));
        if (probe.outcome !== "reviewed") continue;
        const views = segment(probe.body).sections;
        const anyEmptied = segment(findingsReview).sections.some(
          (o) =>
            o.findings.length > 0 &&
            views.some((s) => s.heading === o.heading && s.findings.length === 0),
        );
        if (anyEmptied) {
          r = probe;
          break;
        }
      }
      expect(r.outcome).toBe("reviewed");
      const originals = segment(findingsReview).sections;
      // Only views that had something to lose. This fixture's Narrative view
      // is genuinely empty, and it must keep saying so — which the last
      // assertion here checks in the very same body.
      const populated = originals.filter((o) => o.findings.length > 0);
      const emptied = segment(r.body).sections.filter(
        (s) => s.findings.length === 0 && populated.some((o) => o.heading === s.heading),
      );
      expect(emptied.length).toBeGreaterThan(0);
      for (const s of emptied) {
        const original = originals.find((o) => o.heading === s.heading)!;
        expect(s.heading).toBe(original.heading);
        const text = s.preamble.join("\n");
        expect(text).toContain(emptiedViewCopy(original.findings.length));
        expect(text).not.toContain(EMPTY_LENS_COPY);
      }
      // The two sentences are not interchangeable, and one body carries both:
      // a view emptied by the cap says the cap emptied it, while a view
      // nothing matched still says nothing matched it.
      const untouched = segment(r.body).sections.filter(
        (s) => !populated.some((o) => o.heading === s.heading),
      );
      expect(untouched.length).toBeGreaterThan(0);
      for (const s of untouched) {
        expect(s.preamble.join("\n")).toContain(EMPTY_LENS_COPY);
      }
    });

    it("leaves a genuinely empty view saying EMPTY_LENS_COPY, not the removal copy", () => {
      const r = composeComment(base({ review: emptyReview, limit: HUGE }));
      expect(r.body).toContain(EMPTY_LENS_COPY);
      expect(r.body).not.toContain("were left out of this comment");
    });
  });

  describe("the failure body", () => {
    const log = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");

    it("reports a nonzero exit with the range, the code, and the stderr tail", () => {
      const r = composeComment(base({ exitCode: 1, log }));
      expect(r.outcome).toBe("failed");
      expect(r.omitted).toBe(0);
      expect(r.kept).toBe(0);
      expect(r.body).toContain(FAILURE_HEADLINE);
      expect(r.body).toContain("urtext exited 1 for `8f3c1a2...b91d4e0`.");
      expect(r.body).toContain("<details><summary>What urtext reported</summary>");
      expect(r.body).toContain("line 59");
      expect(r.body).toContain(`line ${60 - LOG_TAIL_LINES}`);
      expect(r.body).not.toContain(`line ${60 - LOG_TAIL_LINES - 1}`);
      // Fixed copy, not optional: without it a red-flavored comment reads as
      // a finding about the change.
      expect(r.body).toContain(FAILURE_CLOSING);
      expect(fencesBalanced(r.body)).toBe(true);
    });

    it("treats a zero exit with no review as a failure rather than posting an empty comment", () => {
      const r = composeComment(base({ exitCode: 0, review: "   \n", log }));
      expect(r.outcome).toBe("failed");
      expect(r.body).toContain(FAILURE_HEADLINE);
      expect(r.body).toContain(FAILURE_CLOSING);
    });

    it("escalates the log fence past any backtick run inside it", () => {
      const r = composeComment(base({ exitCode: 1, log: "```\nnot a fence end\n````\n" }));
      expect(r.body).toContain("`````\n");
      expect(fencesBalanced(r.body)).toBe(true);
    });

    it("shortens an oversized log and states how many lines it dropped", () => {
      const r = composeComment(base({ exitCode: 1, log, limit: MARKER.length + 500 }));
      expect(r.body.length).toBeLessThanOrEqual(MARKER.length + 500);
      expect(r.body).toMatch(/\d+ earlier lines? of urtext's output/);
      expect(r.body).toContain(FAILURE_CLOSING);
    });

    it("falls back to the failure body when even a findings-free review overflows", () => {
      // The only cause is the head's own disclosures, and the composer says
      // that rather than cutting into a sentence.
      const r = composeComment(base({ limit: MARKER.length + 120, log }));
      expect(r.outcome).toBe("failed");
      expect(r.body).toContain("the review's disclosures alone exceed the comment limit");
      // This limit is under the fixed copy's own length, so no body can fit
      // it. What the composer owes here is that everything droppable is gone
      // and every dropped thing is stated: the log block goes, its line count
      // stays, and the fixed sentences are whole rather than cut to hit a
      // number.
      expect(r.body).not.toContain("<details>");
      expect(r.body).toMatch(/\d+ earlier lines? of urtext's output/);
      expect(r.body).toContain(FAILURE_HEADLINE);
      expect(r.body).toContain(FAILURE_CLOSING);
      // Already the floor: nothing left for a smaller limit to take.
      expect(composeComment(base({ limit: 1, log })).body).toBe(r.body);
    });
  });
});
