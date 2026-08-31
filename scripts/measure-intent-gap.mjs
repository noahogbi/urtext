/**
 * The pre-registered check for the intent-gap index.
 *
 * `docs/superpowers/specs/2026-08-30-urtext-intent-gap-index-design.md` makes
 * shipping that feature conditional on a measurement, with the thresholds set
 * before the numbers were known. This script runs it.
 *
 * It measures `beyondIntent`, which already ships: the mark is set by the
 * interpretation stage and already rides on `--json` findings today. So the
 * gate runs *before* any of the index is built, which is the point — two
 * earlier designs for this goal were rejected on measurement, and building
 * five surfaces' worth of rendering ahead of the number invites sunk cost to
 * argue with the threshold.
 *
 * The thresholds, copied from the spec rather than restated:
 *
 *   Reject as noise    if marked > max(2, N/3) on ANY tested range.
 *   Reject as inert    if zero findings are marked across every review.
 *
 * The inertness gate is only answerable if at least one range is known to
 * contain something the messages omit — otherwise zero cannot distinguish "the
 * mark never fires" from "nothing was beyond intent here". `--positive-control`
 * supplies that: a throwaway commit whose message deliberately describes half
 * of what it does, reviewed in a temporary worktree that is removed afterward.
 *
 * This costs real API calls against your key — one keyed review per range.
 * Nothing here writes to the repository under review.
 *
 * Usage:
 *   node scripts/measure-intent-gap.mjs --dry-run
 *   node scripts/measure-intent-gap.mjs [<range>...] [--positive-control]
 *
 * With no ranges, the default set below is used. One of them must be the
 * working tree, and the spec explains why: on the default range uncommitted
 * changes are described by no message, and only a prompt caveat stands between
 * the model and marking every hunk. A check run on clean committed ranges
 * alone can pass while the tool's most common invocation drowns.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Where urtext itself lives — the CLI under test always comes from here. */
const URTEXT = resolve(import.meta.dirname, "..");
const CLI = join(URTEXT, "dist", "bin.js");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const wantControl = argv.includes("--positive-control");

/**
 * The repository being reviewed, which need not be urtext.
 *
 * A tool measured only against the codebase it was written for is measured on
 * its easiest case: its analyzers, its file layout, and its authors' commit
 * habits all line up. `--repo` points the same check at a repository urtext
 * knows nothing about. Pass ranges explicitly when you use it — the defaults
 * below are urtext's own history and mean nothing anywhere else.
 */
const repoFlag = argv.indexOf("--repo");
const ROOT = repoFlag > -1 ? resolve(argv[repoFlag + 1]) : URTEXT;
const ranges = argv.filter(
  (a, i) => !a.startsWith("--") && !(repoFlag > -1 && i === repoFlag + 1),
);

/**
 * Five real ranges, each chosen because it actually changes TypeScript under
 * `src/`. That filter is not incidental: this repository's recent history is
 * documentation, and a range whose diff is all Markdown produces no analyzer
 * findings, so it would contribute a meaningless 0/0 to the tally and make the
 * inertness gate look satisfied by ranges that never had anything to mark.
 *
 * `HEAD~39...HEAD~26` runs past `MAX_INTENT_COMMITS`, so `omitted > 0` and
 * `intentTruncatedNote` fires. Kept deliberately — a long range is a real
 * invocation, and the truncation path should be measured rather than avoided.
 *
 * The empty string is the default invocation, working tree against the merge
 * base, and the spec makes it mandatory. See `workingTreeSlotMet` below: it is
 * only a real test when the working tree actually holds uncommitted TypeScript.
 */
const DEFAULT_RANGES = [
  { range: "", note: "default: working tree vs merge-base (mandatory)" },
  { range: "HEAD~14...HEAD~6", note: "8 commits, 1 source file" },
  { range: "HEAD~26...HEAD~14", note: "14 commits, 7 source files" },
  { range: "HEAD~30...HEAD~27", note: "a dense run of source change" },
  {
    range: "HEAD~39...HEAD~26",
    note: "37 commits — past MAX_INTENT_COMMITS, truncation fires",
  },
];

/**
 * Whether the mandatory working-tree slot is actually testing anything.
 *
 * The risk that slot exists to probe is that uncommitted changes, which no
 * commit message describes, get marked wholesale. A clean working tree cannot
 * exhibit that, so a run against one is not evidence about it — and reporting
 * it as a satisfied slot would be the check lying about its own coverage.
 */
function workingTreeSlotMet() {
  const dirty = git(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
  return dirty;
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** One keyed review. Returns the parsed `--json` object. */
function review(range, cwd = ROOT) {
  const args = [CLI, "review", "--json"];
  if (range) args.push(range);
  const out = execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    // The review writes progress to stderr; only stdout is the JSON.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

/** Marked findings, split by tier, from a parsed `--json` object. */
function tally(json) {
  const findings = json.findings ?? [];
  const marked = findings.filter((f) => f.beyondIntent === true);
  const byTier = {};
  for (const f of marked) byTier[f.tier] = (byTier[f.tier] ?? 0) + 1;
  return {
    total: findings.length,
    marked: marked.length,
    byTier,
    marks: marked,
  };
}

/** The spec's noise threshold: reject when marked exceeds max(2, N/3). */
function noiseLimit(total) {
  return Math.max(2, total / 3);
}

/**
 * The positive control. Builds a throwaway commit in a temporary worktree
 * whose message describes one of the two things it does, then reviews that one
 * commit. If the mark does not fire here, a zero across the real ranges means
 * the instrument is broken rather than that nothing was beyond intent.
 *
 * The worktree is created from HEAD by explicit ref and removed in a finally,
 * so nothing touches the checkout you are working in.
 */
function positiveControl() {
  const dir = mkdtempSync(join(tmpdir(), "urtext-control-"));
  const wt = join(dir, "wt");
  try {
    git(["worktree", "add", "--detach", wt, "HEAD"]);
    const target = join(wt, "src", "report", "model.ts");
    const before = readFileSync(target, "utf-8");
    // Two changes; the message will mention only the first.
    const after =
      before.replace(
        "export const UNNAMED_MODEL",
        'export const CONTROL_NOTE = "a note added by the positive control";\nexport const UNNAMED_MODEL',
      ) +
      '\n\nexport function controlSideEffect(): void {\n  process.env.CONTROL = "1";\n}\n';
    writeFileSync(target, after, "utf-8");
    git(["add", "src/report/model.ts"], wt);
    git(
      [
        "commit",
        "-m",
        "docs: add a note constant to the report model",
        "--no-verify",
      ],
      wt,
    );
    const json = review("HEAD~1...HEAD", wt);
    return tally(json);
  } finally {
    try {
      git(["worktree", "remove", "--force", wt]);
    } catch {
      /* fall through to the directory removal */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- run -------------------------------------------------------------------

if (ROOT !== URTEXT && ranges.length === 0) {
  console.error(
    `--repo ${ROOT} was given with no ranges. The default ranges are urtext's\n` +
      `own history and describe nothing in another repository; running them there\n` +
      `would measure whatever those revisions happen to be. Pass ranges explicitly.`,
  );
  process.exit(1);
}

if (ROOT !== URTEXT && wantControl) {
  console.error(
    "--positive-control patches src/report/model.ts, which exists only in\n" +
      "urtext. Run the control against urtext; run --repo without it.",
  );
  process.exit(1);
}

const plan = ranges.length
  ? ranges.map((range) => ({ range, note: "given on the command line" }))
  : DEFAULT_RANGES;

const dirtyTs = workingTreeSlotMet();
const usesDefaultRange = plan.some((p) => !p.range);

if (dryRun) {
  console.log("Would run these keyed reviews (no API calls made):\n");
  for (const { range, note } of plan) {
    console.log(
      `  urtext review --json ${range || "(default range)"}   — ${note}`,
    );
  }
  if (wantControl)
    console.log("  plus the positive control, in a temporary worktree");
  console.log(
    `\nThresholds: reject as noise if marked > max(2, N/3) on any range;` +
      `\n            reject as inert if zero marked across all of them.`,
  );
  if (usesDefaultRange) {
    console.log(
      dirtyTs.length
        ? `\nWorking-tree slot: ${dirtyTs.length} uncommitted TypeScript file(s) — the ` +
            `mandatory\n  slot will test what it exists to test.`
        : `\nWorking-tree slot: NOT MET. No uncommitted TypeScript in the tree, so the\n` +
            `  default range cannot exhibit the "no message describes this" case the spec\n` +
            `  makes mandatory. Run this with real uncommitted work in progress.`,
    );
  }
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. This check measures the model's own\n" +
      "beyondIntent marks, so it cannot run under --no-llm. Set the key and\n" +
      "re-run, or use --dry-run to see what it would do.",
  );
  process.exit(1);
}

const results = [];
let failedRuns = 0;

for (const { range, note } of plan) {
  process.stderr.write(`reviewing ${range || "(default range)"} ... `);
  try {
    const t = tally(review(range));
    results.push({ range, note, ...t });
    process.stderr.write(`${t.marked}/${t.total} marked\n`);
  } catch (error) {
    failedRuns++;
    results.push({ range, note, failed: String(error.message).split("\n")[0] });
    process.stderr.write("FAILED\n");
  }
}

let control;
if (wantControl) {
  process.stderr.write("positive control ... ");
  try {
    control = positiveControl();
    process.stderr.write(`${control.marked}/${control.total} marked\n`);
  } catch (error) {
    process.stderr.write(`FAILED: ${String(error.message).split("\n")[0]}\n`);
  }
}

// --- verdict ---------------------------------------------------------------

console.log("\n" + "=".repeat(72));
console.log("Pre-registered check: the intent-gap index");
console.log(`repository under review: ${ROOT}`);
console.log("=".repeat(72) + "\n");

console.log(
  `${"range".padEnd(24)}${"findings".padStart(9)}${"marked".padStart(8)}` +
    `${"limit".padStart(8)}   verdict`,
);
for (const r of results) {
  const label = (r.range || "(default)").padEnd(24);
  if (r.failed) {
    console.log(
      `${label}${"—".padStart(9)}${"—".padStart(8)}${"—".padStart(8)}   run failed: ${r.failed}`,
    );
    continue;
  }
  const limit = noiseLimit(r.total);
  const over = r.marked > limit;
  console.log(
    `${label}${String(r.total).padStart(9)}${String(r.marked).padStart(8)}` +
      `${limit.toFixed(1).padStart(8)}   ${over ? "OVER — noise" : "ok"}`,
  );
}

const ran = results.filter((r) => !r.failed);
const totalMarked = ran.reduce((n, r) => n + r.marked, 0);
const anyOver = ran.some((r) => r.marked > noiseLimit(r.total));

console.log();
if (control) {
  console.log(
    `Positive control: ${control.marked} of ${control.total} findings marked ` +
      `— the instrument ${control.marked > 0 ? "fires" : "DID NOT FIRE"}.`,
  );
  if (control.marked === 0) {
    console.log(
      "  A zero below cannot be read as 'nothing was beyond intent'; it may\n" +
        "  mean the mark never fires at all.",
    );
  }
  console.log();
}

const tiers = {};
for (const r of ran)
  for (const [t, n] of Object.entries(r.byTier)) tiers[t] = (tiers[t] ?? 0) + n;
if (totalMarked > 0) {
  console.log(`Marked findings by tier: ${JSON.stringify(tiers)}`);
  console.log(
    "  The spec asserts no marked finding can be `verified`. A `verified`\n" +
      "  count above zero contradicts it and must be investigated before build.",
  );
  console.log();
}

if (usesDefaultRange && dirtyTs.length === 0) {
  console.log(
    "COVERAGE GAP: the working tree held no uncommitted TypeScript, so the\n" +
      "mandatory working-tree slot tested nothing. Whatever the verdict below,\n" +
      "the case the spec calls decisive has not been measured. Re-run with real\n" +
      "uncommitted work before treating this check as complete.\n",
  );
}

if (failedRuns > 0) {
  console.log(
    `${failedRuns} run(s) failed — the check is incomplete and decides nothing.`,
  );
  process.exit(2);
}
if (anyOver) {
  console.log(
    "REJECT (noise): at least one range marked more than max(2, N/3).",
  );
  console.log(
    "Per the spec, the design is rejected rather than capped after the fact.",
  );
  process.exit(1);
}
if (totalMarked === 0) {
  console.log("REJECT (inert): no finding was marked on any range.");
  console.log(
    control
      ? "The positive control above says whether the mark can fire at all."
      : "Re-run with --positive-control before concluding: without it, zero is ambiguous.",
  );
  process.exit(1);
}
console.log("PASS: the mark fires, and no range exceeded the noise limit.");
console.log(
  "Remaining gate is judgement, not arithmetic — read the marked findings and",
);
console.log("decide whether they are ones you would want surfaced first.");
for (const r of ran.filter((x) => x.marked > 0)) {
  console.log(`\n  ${r.range || "(default)"}:`);
  for (const m of r.marks)
    console.log(`    [${m.tier}] ${m.file}:${m.line}  ${m.title}`);
}
