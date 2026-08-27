import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baselineReadsCappedNote,
  blameUnavailableNote,
  citationsCappedNote,
  citingFilesCappedNote,
  shallowRepositoryNote,
  type CitationsOptions,
} from "../src/analyze/citations.js";
import { makeFact } from "../src/analyze/index.js";
import { openOrExplain, parseArgs, review, streamsFor, USAGE, type CliOptions } from "../src/cli.js";
import { DEFAULT_MODEL, INTENT_ABSENT_NOTE } from "../src/interpret/index.js";
import { BEYOND_INTENT_MEANING } from "../src/report/model.js";
import type { Analyzer } from "../src/types.js";

// Only `requestClaims` is mocked, so this file still makes no network call.
// Every existing test here either passes `--no-llm` (which returns before the
// client is reached) or deletes the API key (which returns at
// `unavailableReason`, taken from the real module below), so the mock changes
// no existing behaviour — it only lets the stated-intent cases run the stage.
const requestClaims = vi.fn();
vi.mock("../src/interpret/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/interpret/client.js")>();
  return {
    ...actual,
    requestClaims: (...args: unknown[]) => requestClaims(...args),
  };
});

// mkdtemp spells the directory the way TMP is configured, which on Windows
// can be an 8.3 short name — GitHub's Windows runners set TMP that way — while
// the tool reports the long form git resolves. Same directory, two spellings,
// so canonicalize at creation and path-equality assertions compare like with
// like.
const mkCanonicalTempDir = (prefix: string) =>
  realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

describe("parseArgs", () => {
  it("defaults to the review command with no range", () => {
    const o = parseArgs([]);
    expect(o.command).toBe("review");
    expect(o.range).toBeUndefined();
    expect(o.json).toBe(false);
    expect(o.noLlm).toBe(false);
  });

  it("reads a positional range", () => {
    expect(parseArgs(["review", "HEAD~2"]).range).toBe("HEAD~2");
  });

  it("reads flags in any position", () => {
    const o = parseArgs(["review", "--json", "main..feature", "--no-llm"]);
    expect(o.json).toBe(true);
    expect(o.noLlm).toBe(true);
    expect(o.range).toBe("main..feature");
  });

  it("recognises help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("rejects an unknown flag instead of reviewing it as a range", () => {
    expect(() => parseArgs(["review", "--jsonn"])).toThrow(
      /Unknown option: --jsonn/,
    );
    expect(() => parseArgs(["-x"])).toThrow(/--help/);
  });

  describe("--model", () => {
    it("reads a model id in either form", () => {
      expect(parseArgs(["--model", "claude-haiku-4-5"]).model).toBe("claude-haiku-4-5");
      expect(parseArgs(["--model=claude-haiku-4-5"]).model).toBe("claude-haiku-4-5");
    });

    it("leaves the model unset when the flag is absent, so the default applies", () => {
      expect(parseArgs([]).model).toBeUndefined();
    });

    it("does not swallow the range or the next flag as its value", () => {
      const o = parseArgs(["--model", "claude-haiku-4-5", "main..feature", "--json"]);
      expect(o.model).toBe("claude-haiku-4-5");
      expect(o.range).toBe("main..feature");
      expect(o.json).toBe(true);
      expect(() => parseArgs(["--model", "--json"])).toThrow(/needs a model id/);
      expect(() => parseArgs(["--model"])).toThrow(/needs a model id/);
      expect(() => parseArgs(["--model="])).toThrow(/needs a model id/);
    });

    it("names the default in the usage text, from the constant rather than a copy", () => {
      expect(USAGE).toContain(DEFAULT_MODEL);
    });
  });

  describe("--export", () => {
    it("reads a comma-separated list in either flag form", () => {
      expect(parseArgs(["--export", "md,pdf"]).exportFormats).toEqual(["md", "pdf"]);
      expect(parseArgs(["--export=md,pdf"]).exportFormats).toEqual(["md", "pdf"]);
      expect(parseArgs(["--export", "md"]).exportFormats).toEqual(["md"]);
    });

    it("accepts the flag repeated, accumulating without duplicates", () => {
      expect(parseArgs(["--export", "md", "--export", "pdf"]).exportFormats).toEqual(["md", "pdf"]);
      expect(parseArgs(["--export", "md,md", "--export", "md"]).exportFormats).toEqual(["md"]);
    });

    it("leaves the formats unset when the flag is absent", () => {
      expect(parseArgs([]).exportFormats).toBeUndefined();
    });

    it("rejects an unknown format with a usage error naming the two it supports", () => {
      expect(() => parseArgs(["--export", "docx"])).toThrow(/docx/);
      expect(() => parseArgs(["--export", "docx"])).toThrow(/md/);
      expect(() => parseArgs(["--export", "docx"])).toThrow(/pdf/);
      // A known format beside the unknown one does not excuse it.
      expect(() => parseArgs(["--export", "md,docx"])).toThrow(/docx/);
    });

    it("does not swallow the next flag as its value, and rejects an empty list", () => {
      expect(() => parseArgs(["--export"])).toThrow(/md,pdf/);
      expect(() => parseArgs(["--export", "--json"])).toThrow(/md,pdf/);
      expect(() => parseArgs(["--export="])).toThrow(/md,pdf/);
    });

    it("names the flag in the usage text", () => {
      expect(USAGE).toContain("--export");
    });
  });

  describe("--stdout", () => {
    it("reads the one format in either flag form", () => {
      expect(parseArgs(["--stdout", "md"]).stdout).toBe("md");
      expect(parseArgs(["--stdout=md"]).stdout).toBe("md");
    });

    it("leaves the format unset when the flag is absent, so stdout keeps the terminal render", () => {
      expect(parseArgs([]).stdout).toBeUndefined();
      expect(parseArgs(["review", "HEAD~1", "--no-llm"]).stdout).toBeUndefined();
    });

    it("rejects a format it cannot write, naming what it does take", () => {
      expect(() => parseArgs(["--stdout", "html"])).toThrow(/html/);
      expect(() => parseArgs(["--stdout", "html"])).toThrow(/--stdout md/);
      expect(() => parseArgs(["--stdout=json"])).toThrow(/--stdout md/);
    });

    it("does not swallow the next flag or the range as its value", () => {
      expect(() => parseArgs(["--stdout"])).toThrow(/--stdout md/);
      expect(() => parseArgs(["--stdout", "--no-llm"])).toThrow(/--stdout md/);
      expect(() => parseArgs(["--stdout="])).toThrow(/--stdout md/);
      const o = parseArgs(["--stdout", "md", "main..feature", "--no-llm"]);
      expect(o.stdout).toBe("md");
      expect(o.range).toBe("main..feature");
      expect(o.noLlm).toBe(true);
    });

    it("refuses to put two documents on one stream, in either order", () => {
      // Not a formatting problem to resolve: a request with no correct answer.
      expect(() => parseArgs(["--stdout", "md", "--json"])).toThrow(/--stdout md and --json/);
      expect(() => parseArgs(["--json", "--stdout=md"])).toThrow(/--stdout md and --json/);
      expect(() => parseArgs(["--stdout", "md", "--json"])).toThrow(/pick one/);
    });

    it("names the flag and its one format in the usage text", () => {
      expect(USAGE).toContain("--stdout md");
    });
  });
});

describe("--open", () => {
  it("opens the report that was written", () => {
    const opened: string[] = [];
    const said: string[] = [];
    openOrExplain("/tmp/review.html", (m) => said.push(m), (p) => opened.push(p));
    expect(opened).toEqual(["/tmp/review.html"]);
    expect(said).toEqual([]);
  });

  it("says why nothing opened when no report was written, instead of doing nothing", () => {
    const opened: string[] = [];
    const said: string[] = [];
    openOrExplain(undefined, (m) => said.push(m), (p) => opened.push(p));
    expect(opened).toEqual([]);
    expect(said.join("")).toContain("nothing to open");
  });
});

describe("bin entry", () => {
  it("prints, whatever spelling it was invoked by", () => {
    // The executable entry must run unconditionally. Its predecessor decided
    // whether to run by comparing its own path against `import.meta.url`, and
    // an installed `urtext` invoked through a symlinked bin directory exited
    // zero having printed nothing — the comparison saw two spellings of one
    // file. So this spawns the entry through a real process boundary and
    // requires output; an entry that is quiet on any invocation is broken.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "bin.ts"), "--help"],
      { cwd: root, stdio: "pipe" },
    ).toString();
    expect(out).toContain("urtext");
    expect(out).toContain("review");
  });
});

let repo: string;
let subRepo: string;
let cleanRepo: string;
let rotRepo: string;
let shallowRepo: string;

// Global git config (commit signing, a shared core.hooksPath) has no business
// deciding whether these tests pass.
const ISOLATION = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
const gitIn = (cwd: string, args: string[]) =>
  execFileSync("git", [...ISOLATION, ...args], { cwd, stdio: "pipe" });

beforeAll(() => {
  repo = mkCanonicalTempDir("urtext-cli-");
  const run = (args: string[]) => gitIn(repo, args);
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
  run(["add", "-A"]);
  run(["commit", "-m", "first"]);
  writeFileSync(join(repo, "svc.ts"), "export function load(id: string) {\n  return fetch(id);\n}\n");

  subRepo = mkCanonicalTempDir("urtext-cli-sub-");
  const runSub = (args: string[]) => gitIn(subRepo, args);
  runSub(["init", "-b", "main"]);
  runSub(["config", "user.email", "test@example.com"]);
  runSub(["config", "user.name", "Test"]);
  mkdirSync(join(subRepo, "pkg", "sub"), { recursive: true });
  writeFileSync(
    join(subRepo, "pkg", "sub", "svc.ts"),
    "export function load(id: string) {\n  return id;\n}\n",
  );
  runSub(["add", "-A"]);
  runSub(["commit", "-m", "first"]);
  writeFileSync(
    join(subRepo, "pkg", "sub", "svc.ts"),
    "export function load(id: string) {\n  return fetch(id);\n}\n",
  );

  // No edit after the commit: the working tree matches HEAD exactly, so
  // `vs HEAD` is a genuinely empty diff rather than one an analyzer merely
  // failed to find anything in.
  cleanRepo = mkCanonicalTempDir("urtext-cli-clean-");
  const runClean = (args: string[]) => gitIn(cleanRepo, args);
  runClean(["init", "-b", "main"]);
  runClean(["config", "user.email", "test@example.com"]);
  runClean(["config", "user.name", "Test"]);
  writeFileSync(join(cleanRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
  runClean(["add", "-A"]);
  runClean(["commit", "-m", "first"]);

  // Two rotted citations, differing in exactly the thing the flag decides:
  // one points into the file the reviewed range touches, the other into a
  // file it does not. The default mode is bounded by the change and reports
  // only the first; the sweep reports both. Every `--citations` test below
  // turns on that difference, and so does the disclosure test's proof that
  // the configured analyzer replaced the registered one rather than joining
  // it — a registered instance still running would report the first citation
  // in a run whose swapped-in analyzer reports nothing at all.
  rotRepo = mkCanonicalTempDir("urtext-cli-citations-");
  const runRot = (args: string[]) => gitIn(rotRepo, args);
  runRot(["init", "-b", "main"]);
  runRot(["config", "user.email", "test@example.com"]);
  runRot(["config", "user.name", "Test"]);
  mkdirSync(join(rotRepo, "src"), { recursive: true });
  writeFileSync(join(rotRepo, "src", "limits.ts"), "export const limit = 1;\n");
  writeFileSync(join(rotRepo, "src", "other.ts"), "export const other = 1;\n");
  writeFileSync(
    join(rotRepo, "NOTES.md"),
    "The limit is set at src/limits.ts:1.\nThe other value is at src/other.ts:1.\n",
  );
  runRot(["add", "-A"]);
  runRot(["commit", "-m", "first"]);
  writeFileSync(join(rotRepo, "src", "limits.ts"), "export const limit = 99;\n");
  runRot(["add", "-A"]);
  runRot(["commit", "-m", "raise the limit"]);

  // The same repository with its history cut off at the tip, so blame can
  // only reach the graft commit and the rot above is undetectable. Cloned
  // from a `file://` URL because git ignores `--depth` on a plain local
  // clone and silently makes a complete one — which would leave this fixture
  // proving nothing — and the test asserts the shallowness rather than
  // trusting this line.
  shallowRepo = mkCanonicalTempDir("urtext-cli-shallow-");
  gitIn(shallowRepo, ["clone", "--depth", "1", pathToFileURL(rotRepo).href, "."]);

  // Applied to both, after the clone, so the two repositories differ in
  // exactly one thing: how much history each carries.
  writeFileSync(join(rotRepo, "src", "other.ts"), "export const other = 2;\n");
  writeFileSync(join(shallowRepo, "src", "other.ts"), "export const other = 2;\n");
});

describe("review", () => {
  it("finds the introduced network effect and exits zero", async () => {
    const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("network effect");
    expect(r.output).toContain("[verified]");
  });

  it("shows the line of code behind a verified finding", async () => {
    const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
    expect(r.output).toContain("svc.ts:2");
    expect(r.output).toContain("return fetch(id);");
  });

  it("names the file once per finding", async () => {
    const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
    const head = r.output.split("\n").find((l) => l.includes("introduces"))!;
    expect(head.match(/svc\.ts/g)).toHaveLength(1);
  });

  it("reports the same change when run from a subdirectory", async () => {
    const fromRoot = await review(subRepo, { command: "review", json: true, noLlm: true, help: false });
    const fromSub = await review(join(subRepo, "pkg", "sub"), {
      command: "review",
      json: true,
      noLlm: true,
      help: false,
    });
    const findings = JSON.parse(fromSub.output).findings;
    expect(JSON.parse(fromRoot.output).findings).toEqual(findings);
    // `load` both grows a network effect and widens its inferred return
    // type, so both the effects and surface analyzers report on it now.
    expect(findings).toHaveLength(2);
    expect(findings.every((f: { file: string }) => f.file === "pkg/sub/svc.ts")).toBe(true);
    const titles = findings.map((f: { title: string }) => f.title);
    expect(titles).toContain("introduces a network effect");
    expect(titles).toContain("load changed its signature");
    // The bug this guards: a phantom "no longer has a network effect".
    expect(fromSub.output).not.toContain("no longer has");
  });

  it("emits machine-readable findings under --json", async () => {
    const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.range.label).toBe("vs main");
    expect(parsed.findings[0].tier).toBe("verified");
    // `load` both grows a network effect and widens its inferred return
    // type, so both the effects and surface analyzers report on it.
    expect(parsed.counts.verified).toBe(2);
    // Present even at zero, so a consumer can test it without branching on
    // the key.
    expect(parsed.suppressed).toBe(0);
  });

  it("discloses a suppressed standalone reach row on both surfaces instead of vanishing it", async () => {
    // A body-only change to an export with exactly one caller: the only
    // fact is a one-reference blast_radius row, which reconcile's filter
    // removes in a claim-free run — so without the disclosure this whole
    // change would reach the report as nothing at all.
    const soloRepo = mkCanonicalTempDir("urtext-cli-solo-");
    const runSolo = (args: string[]) => gitIn(soloRepo, args);
    runSolo(["init", "-b", "main"]);
    runSolo(["config", "user.email", "test@example.com"]);
    runSolo(["config", "user.name", "Test"]);
    writeFileSync(join(soloRepo, "lib.ts"), 'export function solo(x: string): string {\n  return x;\n}\n');
    writeFileSync(join(soloRepo, "user.ts"), 'import { solo } from "./lib.js";\nexport const r = solo("x");\n');
    runSolo(["add", "-A"]);
    runSolo(["commit", "-m", "first"]);
    writeFileSync(join(soloRepo, "lib.ts"), 'export function solo(x: string): string {\n  return x.trim();\n}\n');

    const json = await review(soloRepo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(json.output);
    expect(parsed.suppressed).toBe(1);
    expect(parsed.findings).toEqual([]);

    const term = await review(soloRepo, { command: "review", json: false, noLlm: true, help: false });
    expect(term.output).toContain("No findings");
    expect(term.output).toContain(
      "Filtered: 1 finding suppressed (low-signal: single unclaimed reference).",
    );
  });

  describe("with --no-llm", () => {
    // `interpret` returns a `skipped` reason synchronously, before it ever
    // reads `ANTHROPIC_API_KEY` or constructs a client — the ambient key
    // present in this machine's environment (needed for the real, manual
    // run against a live model) must never leak into this test as a network
    // call.
    it("makes every finding verified and prints no model provenance line", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
      expect(r.output).not.toContain("MODEL");
      expect(r.output).not.toContain("interpreted this change");
      // The name of this test promises tiers, not just an absent
      // provenance line, so it has to actually look at one: the terminal
      // renderer prints `[verified]` next to every finding and never
      // `[inferred]`/`[model]` when nothing was reconciled against a claim.
      expect(r.output).toContain("[verified]");
      expect(r.output).not.toContain("[inferred]");
      expect(r.output).not.toContain("[model]");
    });

    it("states the skipped-interpretation reason once per surface, not twice", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
      const reason = "--no-llm was set, so the model was not asked";
      expect(r.output).toContain(reason);
      expect(r.output.split(reason)).toHaveLength(2);
      // The HTML banner had the same line twice: once from `warnings`, once
      // from a `meta.skipped` field carrying the same string.
      const html = readFileSync(r.reportPath!, "utf8");
      expect(html.split(reason)).toHaveLength(2);
    });

    it("reports no model under --json when the stage was skipped, whatever --model asked for", async () => {
      // `--no-llm` keeps this off the network. `model` in the JSON is "the
      // model that produced them" — a skipped stage produced nothing, so the
      // requested model must not appear there: the one consumer that cannot
      // read the prose `skipped` reason would otherwise see a model name for
      // a stage that never ran.
      const r = await review(repo, {
        command: "review",
        json: true,
        noLlm: true,
        help: false,
        model: "a-model-that-does-not-exist",
      });
      const parsed = JSON.parse(r.output);
      expect(parsed.model).toBe("");
      expect(parsed.skipped).toBeDefined();
      expect(parsed.counts.inferred).toBe(0);
      expect(parsed.counts.model).toBe(0);
      expect(r.output).not.toContain("a-model-that-does-not-exist");
    });

    it("reports every finding as verified under --json, with no model name", async () => {
      const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
      const parsed = JSON.parse(r.output);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.findings.every((f: { tier: string }) => f.tier === "verified")).toBe(true);
      expect(parsed.counts.inferred).toBe(0);
      expect(parsed.counts.model).toBe(0);
      expect(parsed.model).toBe("");
      expect(parsed.skipped).toBe("--no-llm was set, so the model was not asked");
    });
  });

  describe("with no API key", () => {
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    });

    it("puts the skip reason in the warnings instead of silently dropping the stage", async () => {
      const r = await review(repo, { command: "review", json: true, noLlm: false, help: false });
      const parsed = JSON.parse(r.output);
      expect(parsed.warnings.some((w: string) => w.includes("ANTHROPIC_API_KEY"))).toBe(true);
      expect(parsed.skipped).toMatch(/ANTHROPIC_API_KEY/);
    });

    it("shows the skip reason as a Note in the terminal report", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: false, help: false });
      expect(r.output).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("names a deleted TypeScript module instead of reporting nothing about it", async () => {
    const delRepo = mkCanonicalTempDir("urtext-cli-deleted-");
    const run = (args: string[]) => gitIn(delRepo, args);
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    // The `fetch` is load-bearing: `effectsAnalyzer` reads the before side of
    // a deletion, so this file produces a real `effect_removed` finding. The
    // note prints above that finding and must not contradict it.
    writeFileSync(
      join(delRepo, "doomed.ts"),
      "export const one = 1;\nexport async function two(u: string) {\n  return fetch(u);\n}\n",
    );
    writeFileSync(join(delRepo, "keep.ts"), "export const KEEP = 1;\n");
    run(["add", "-A"]);
    run(["commit", "-m", "first"]);
    rmSync(join(delRepo, "doomed.ts"));
    // An unrelated edit, so the range is not a deletion alone — the report
    // used to be entirely about this line and silent about the module.
    writeFileSync(join(delRepo, "keep.ts"), "export const KEEP = 2;\n");

    const r = await review(delRepo, { command: "review", json: false, noLlm: true, help: false });
    expect(r.output).toContain("doomed.ts");
    expect(r.output).toContain("deleted TypeScript file");
    // The finding the old wording told the reader to disregard.
    expect(r.output).toContain("no longer has a network effect");
    expect(r.output).not.toContain("every analyzer skips");
    const html = readFileSync(r.reportPath!, "utf8");
    expect(html).toContain("doomed.ts");
    expect(html).toContain("1 deleted TypeScript file: doomed.ts");
    // Routine, so it does not escalate the whole review to partial: the
    // banner here holds the `--no-llm` skip reason and nothing else.
    const banner = html.slice(html.indexOf(`<div class="banner">`));
    expect(banner.slice(0, banner.indexOf("</div>"))).not.toContain("deleted TypeScript");

    // And the surface that cannot read prose. A script had no way to see this
    // gap at all, which made "stated the same way on every surface" false.
    const json = await review(delRepo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(json.output);
    expect(parsed.coverage.deletedTypeScriptFiles).toEqual(["doomed.ts"]);
    expect(parsed.coverage.note).toContain("doomed.ts");
  });

  it("reports an empty coverage list under --json when nothing was deleted", async () => {
    // Always present, so a consumer reads it without branching on the key.
    const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
    const parsed = JSON.parse(r.output);
    expect(parsed.coverage.deletedTypeScriptFiles).toEqual([]);
    expect(parsed.coverage.note).toBeUndefined();
  });

  describe("report writing", () => {
    it("writes the report under the repository root, whether invoked from the root or a subdirectory", async () => {
      const fromRoot = await review(subRepo, { command: "review", json: true, noLlm: true, help: false });
      const fromSub = await review(join(subRepo, "pkg", "sub"), {
        command: "review",
        json: true,
        noLlm: true,
        help: false,
      });
      expect(fromRoot.reportPath).toBeDefined();
      expect(fromSub.reportPath).toBeDefined();
      expect(dirname(fromRoot.reportPath!)).toBe(join(subRepo, ".urtext"));
      expect(dirname(fromSub.reportPath!)).toBe(join(subRepo, ".urtext"));
      expect(existsSync(fromRoot.reportPath!)).toBe(true);
      expect(existsSync(fromSub.reportPath!)).toBe(true);
    });

    it("never edits the reviewed repository's .gitignore, tracked or not", async () => {
      const gitignoreRepo = mkCanonicalTempDir("urtext-cli-gitignore-");
      const run = (args: string[]) => gitIn(gitignoreRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(gitignoreRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      // Tracked and committed: a byte-identical file after `review` is the
      // strongest form of "urtext did not touch this" — an untracked
      // .gitignore could be edited without `git status` ever flagging it.
      writeFileSync(join(gitignoreRepo, ".gitignore"), "node_modules/\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(gitignoreRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );
      const before = readFileSync(join(gitignoreRepo, ".gitignore"));

      const r = await review(gitignoreRepo, { command: "review", json: true, noLlm: true, help: false });

      expect(readFileSync(join(gitignoreRepo, ".gitignore"))).toEqual(before);
      const status = gitIn(gitignoreRepo, ["status", "--porcelain"]).toString();
      expect(status).not.toContain(".gitignore");
      expect(r.reportPath).toContain(".urtext");
    });

    it("suggests gitignoring .urtext/ in the terminal output when the repository does not already", async () => {
      // `repo` has no .gitignore at all, so nothing covers .urtext/.
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
      expect(r.output).toContain("Tip:");
      expect(r.output).toContain(".gitignore");
    });

    it("still suggests the tip when a CRLF .gitignore with blank lines ignores something else", async () => {
      // The first real repository urtext reviewed had a CRLF-encoded
      // .gitignore whose blank lines are a bare carriage return, and on git
      // for Windows `check-ignore` matched ANY trailing-slash query against
      // one of them — so the tool believed `.urtext/` was ignored and
      // withheld the tip. The slashless query in `isUrtextGitignored` is the
      // fix; this repo reproduces that gitignore shape.
      const crlfRepo = mkCanonicalTempDir("urtext-cli-crlf-");
      const run = (args: string[]) => gitIn(crlfRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(crlfRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      writeFileSync(join(crlfRepo, ".gitignore"), "node_modules/\r\n\r\n*.log\r\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(crlfRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );

      const r = await review(crlfRepo, { command: "review", json: false, noLlm: true, help: false });
      expect(r.output).toContain("Tip:");
    });

    it("says nothing about .gitignore when the repository already covers .urtext/", async () => {
      const ignoredRepo = mkCanonicalTempDir("urtext-cli-ignored-");
      const run = (args: string[]) => gitIn(ignoredRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(ignoredRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      writeFileSync(join(ignoredRepo, ".gitignore"), ".urtext/\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(ignoredRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );

      const r = await review(ignoredRepo, { command: "review", json: false, noLlm: true, help: false });
      expect(r.output).not.toContain("Tip:");
    });

    it("does not write a report, and suggests nothing to gitignore, when every analyzer fails", async () => {
      const boom: Analyzer = async function explodingAnalyzer() {
        throw new Error("boom");
      };
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false }, [boom]);
      expect(r.reportPath).toBeUndefined();
      // Load-bearing: `renderTerminal` prints "Full report" exactly when it
      // is handed a `reportPath`, with or without findings (see
      // `test/report/terminal.test.ts`, "prints the report path even when
      // there are no findings"), so the line above — `reportPath` really is
      // `undefined` here — is what makes this assertion mean something
      // rather than being true regardless of whether a report was written.
      expect(r.output).not.toContain("Full report");
      expect(r.output).not.toContain("Tip:");
    });

    it("still returns the review's findings when the report fails to write", async () => {
      const brokenRepo = mkCanonicalTempDir("urtext-cli-broken-report-");
      const run = (args: string[]) => gitIn(brokenRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(brokenRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(brokenRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );
      // `.urtext` exists as a plain file, so `writeReport`'s `mkdir` rejects
      // instead of producing a report — the filesystem problem this test
      // exists to prove does not take the rest of the review down with it.
      writeFileSync(join(brokenRepo, ".urtext"), "not a directory");

      const r = await review(brokenRepo, { command: "review", json: true, noLlm: true, help: false });
      const parsed = JSON.parse(r.output);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.reportPath).toBeUndefined();
      expect(r.exitCode).toBe(0);
      expect(
        parsed.warnings.some((w: string) => w.includes("could not write the report")),
      ).toBe(true);
      // No `--export` was given, so the failure story must not grow an
      // exports line for a user who asked for nothing — see the exports
      // suite's "discloses that requested exports were skipped..." for the
      // asked-for case.
      expect(parsed.warnings.some((w: string) => w.includes("export"))).toBe(false);
    });

    it("prints the report path in the terminal summary", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false });
      expect(r.output).toContain(r.reportPath);
    });

    it("includes the report path in --json output", async () => {
      const r = await review(repo, { command: "review", json: true, noLlm: true, help: false });
      const parsed = JSON.parse(r.output);
      expect(parsed.reportPath).toBe(r.reportPath);
      expect(existsSync(parsed.reportPath)).toBe(true);
    });
  });

  describe("exports", () => {
    const jsonOpts = { command: "review", json: true, noLlm: true, help: false };

    it("writes md and pdf beside the HTML report, sharing its stem, and names both under --json", async () => {
      const r = await review(repo, { ...jsonOpts, exportFormats: ["md", "pdf"] });
      const parsed = JSON.parse(r.output);
      expect(r.exitCode).toBe(0);
      expect(parsed.reportPath).toMatch(/\.html$/);
      // The shared timestamp stem is the contract: swap the report's
      // extension and you have named its exports.
      expect(parsed.exportPaths.md).toBe(parsed.reportPath.replace(/\.html$/, ".md"));
      expect(parsed.exportPaths.pdf).toBe(parsed.reportPath.replace(/\.html$/, ".pdf"));
      expect(existsSync(parsed.exportPaths.md)).toBe(true);
      expect(existsSync(parsed.exportPaths.pdf)).toBe(true);
    });

    it("starts the md file with the Markdown title, so the right renderer fed the right file", async () => {
      const r = await review(repo, { ...jsonOpts, exportFormats: ["md"] });
      const parsed = JSON.parse(r.output);
      expect(readFileSync(parsed.exportPaths.md, "utf8").startsWith("# urtext review")).toBe(true);
    });

    it("writes no pdf when only md was asked for", async () => {
      const r = await review(repo, { ...jsonOpts, exportFormats: ["md"] });
      const parsed = JSON.parse(r.output);
      expect(parsed.exportPaths.md).toBeDefined();
      expect(parsed.exportPaths.pdf).toBeUndefined();
      expect(existsSync(parsed.reportPath.replace(/\.html$/, ".pdf"))).toBe(false);
    });

    it("omits exportPaths from --json entirely when no export was requested", async () => {
      const r = await review(repo, jsonOpts);
      expect(JSON.parse(r.output).exportPaths).toBeUndefined();
    });

    it("prints one path line per written export in the terminal summary", async () => {
      const r = await review(repo, { ...jsonOpts, json: false, exportFormats: ["md", "pdf"] });
      expect(r.output).toContain(r.reportPath!.replace(/\.html$/, ".md"));
      expect(r.output).toContain(r.reportPath!.replace(/\.html$/, ".pdf"));
    });

    it("degrades a failing export to a warning, leaving findings, exit code, and the other export untouched", async () => {
      // Injected the same way the exit-code tests control analyzer failure:
      // through `review`'s defaulted parameter, because the real renderers
      // are static imports a test cannot make fail from outside. The pdf
      // exporter stands in with a stub so the test proves the md failure
      // took nothing else down with it.
      const r = await review(repo, { ...jsonOpts, exportFormats: ["md", "pdf"] }, undefined, {
        md: () => {
          throw new Error("md renderer boom");
        },
        pdf: async () => Buffer.from("%PDF-stub"),
      });
      const parsed = JSON.parse(r.output);
      expect(r.exitCode).toBe(0);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.reportPath).toBeDefined();
      expect(parsed.warnings.some((w: string) => w.includes("md export"))).toBe(true);
      expect(parsed.exportPaths.md).toBeUndefined();
      expect(parsed.exportPaths.pdf).toBeDefined();
      expect(existsSync(parsed.exportPaths.pdf)).toBe(true);
    });

    it("discloses that requested exports were skipped when the report itself could not be written", async () => {
      // Same forced failure as "still returns the review's findings when the
      // report fails to write": `.urtext` exists as a plain file. The exports
      // share the report's stem, so they cannot be written either — and a
      // tool whose thesis is disclosure must say so, not just let the
      // `md export:` lines silently fail to appear.
      const skippedRepo = mkCanonicalTempDir("urtext-cli-export-skipped-");
      const run = (args: string[]) => gitIn(skippedRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(skippedRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(skippedRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );
      writeFileSync(join(skippedRepo, ".urtext"), "not a directory");

      const r = await review(skippedRepo, { ...jsonOpts, exportFormats: ["md", "pdf"] });
      const parsed = JSON.parse(r.output);
      expect(r.exitCode).toBe(0);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.reportPath).toBeUndefined();
      expect(parsed.exportPaths).toEqual({});
      // Both halves of the one filesystem failure are told: the report's
      // warning, and beside it the skipped exports it took down with it.
      expect(
        parsed.warnings.some((w: string) => w.includes("could not write the report")),
      ).toBe(true);
      expect(parsed.warnings.some((w: string) => w.includes("md, pdf export"))).toBe(true);
    });

    it("exports nothing on a nonzero-exit run, the same rule as the HTML report", async () => {
      const boom: Analyzer = async function explodingAnalyzer() {
        throw new Error("boom");
      };
      // A fresh repo, because the shared one accumulates exports from the
      // tests above — "no files written" is only checkable in a directory
      // this test owns.
      const noExportRepo = mkCanonicalTempDir("urtext-cli-noexport-");
      const run = (args: string[]) => gitIn(noExportRepo, args);
      run(["init", "-b", "main"]);
      run(["config", "user.email", "test@example.com"]);
      run(["config", "user.name", "Test"]);
      writeFileSync(join(noExportRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
      run(["add", "-A"]);
      run(["commit", "-m", "first"]);
      writeFileSync(
        join(noExportRepo, "svc.ts"),
        "export function load(id: string) {\n  return fetch(id);\n}\n",
      );

      const r = await review(noExportRepo, { ...jsonOpts, exportFormats: ["md", "pdf"] }, [boom]);
      const parsed = JSON.parse(r.output);
      expect(r.exitCode).not.toBe(0);
      expect(parsed.reportPath).toBeUndefined();
      // Present because it was requested; empty because nothing was written.
      expect(parsed.exportPaths).toEqual({});
      expect(existsSync(join(noExportRepo, ".urtext"))).toBe(false);
    });
  });

  describe("exit codes", () => {
    const boom: Analyzer = async function explodingAnalyzer() {
      throw new Error("boom");
    };
    const boom2: Analyzer = async function explodingAnalyzer2() {
      throw new Error("boom2");
    };
    const findsSomething: Analyzer = async function workingAnalyzer() {
      return [
        makeFact({
          id: "x",
          kind: "effect_added",
          detail: { effect: "network", sites: 1 },
          evidence: [{ file: "svc.ts", line: 2, excerpt: "return fetch(id);" }],
        }),
      ];
    };

    it("exits non-zero when every analyzer fails, even though the output says 'No findings'", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false }, [
        boom,
        boom2,
      ]);
      expect(r.output).toContain("No findings");
      expect(r.exitCode).not.toBe(0);
    });

    it("exits zero when some analyzers fail but at least one still produces findings", async () => {
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false }, [
        boom,
        findsSomething,
      ]);
      expect(r.output).toContain("[verified]");
      expect(r.exitCode).toBe(0);
    });

    it("exits non-zero when some analyzers fail and none of them, nor any other, produced a finding", async () => {
      // The identical hazard the all-failed case exists to close, at a
      // smaller ratio: exit 0 next to "No findings" reads as "this range is
      // clean" when the truer reading is "part of what would have found
      // something never ran". `quiet` succeeds — it is not one of the
      // failures — and still finds nothing, so this is not the all-failed
      // case: it is a partial failure with nothing to show for the part
      // that did run either.
      const quiet: Analyzer = async function quietAnalyzer() {
        return [];
      };
      const r = await review(repo, { command: "review", json: false, noLlm: true, help: false }, [
        boom,
        quiet,
      ]);
      expect(r.output).toContain("No findings");
      expect(r.exitCode).not.toBe(0);
    });

    it("exits zero for a genuinely clean review with no analyzer failures and no findings", async () => {
      const r = await review(cleanRepo, {
        command: "review",
        json: true,
        range: "HEAD",
        noLlm: true,
        help: false,
      });
      const parsed = JSON.parse(r.output);
      expect(parsed.findings).toHaveLength(0);
      // `--no-llm` itself still adds a warning (see the `with --no-llm`
      // tests above); what distinguishes a genuinely clean review is the
      // absence of an *analyzer* failure specifically.
      expect(parsed.warnings.some((w: string) => w.includes("analyzer failed"))).toBe(false);
      expect(r.exitCode).toBe(0);
    });
  });
});

describe("stated intent", () => {
  let savedKey: string | undefined;
  let intentRepo: string;

  beforeAll(() => {
    // Two commits, so a range starting one commit back has a commit message
    // to state an intent with, and an uncommitted edit so there is something
    // to review. The rev-spec itself is spelled in the option literals below,
    // never here: a bare numeral in a comment is what the comment contract
    // guards, and this one would collide with a `WEIGHTS` value.
    intentRepo = mkCanonicalTempDir("urtext-cli-intent-");
    const run = (args: string[]) => gitIn(intentRepo, args);
    run(["init", "-b", "main"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    writeFileSync(join(intentRepo, "svc.ts"), "export function load(id: string) {\n  return id;\n}\n");
    run(["add", "-A"]);
    run(["commit", "-m", "first"]);
    writeFileSync(join(intentRepo, "svc.ts"), "export function load(id: string) {\n  return id.trim();\n}\n");
    run(["add", "-A"]);
    run(["commit", "-m", "trim the id before returning it"]);
    writeFileSync(join(intentRepo, "svc.ts"), "export function load(id: string) {\n  return fetch(id);\n}\n");
  });

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    requestClaims.mockReset();
    requestClaims.mockResolvedValue({ claims: [], model: "claude-opus-5" });
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    requestClaims.mockReset();
  });

  it("discloses a zero-commit range on the terminal and in --json's warnings", async () => {
    // `repo`'s default range is merge-base(HEAD, main)..worktree, and main is
    // HEAD — so the range contains no commit and states no intent.
    const term = await review(repo, { command: "review", json: false, noLlm: false, help: false });
    expect(term.output).toContain(`Note: ${INTENT_ABSENT_NOTE}`);

    const json = await review(repo, { command: "review", json: true, noLlm: false, help: false });
    expect(JSON.parse(json.output).warnings).toContain(INTENT_ABSENT_NOTE);
  });

  it("says nothing about intent when the range's commits stated one", async () => {
    const r = await review(intentRepo, {
      command: "review",
      json: true,
      noLlm: false,
      help: false,
      range: "HEAD~1",
    });
    const parsed = JSON.parse(r.output);
    expect(parsed.warnings.some((w: string) => w.includes("stated intent"))).toBe(false);
    expect(parsed.warnings).not.toContain(INTENT_ABSENT_NOTE);
    // The stage really ran against a block: the prompt it was handed carries
    // the commit's subject.
    expect(requestClaims.mock.calls[0][0]).toContain("trim the id before returning it");
  });

  it("badges a finding the model marked, on the terminal and in --json", async () => {
    requestClaims.mockResolvedValue({
      claims: [
        {
          id: "m1",
          file: "svc.ts",
          line: 2,
          summary: "reaches the network",
          reasoning: "The call runs wherever load is called.",
          severity: 0.9,
          beyondIntent: true,
        },
      ],
      model: "claude-opus-5",
    });
    const term = await review(intentRepo, {
      command: "review",
      json: false,
      noLlm: false,
      help: false,
      range: "HEAD~1",
    });
    expect(term.output).toContain("(beyond stated intent)");
    expect(term.output).toContain(BEYOND_INTENT_MEANING);

    const json = await review(intentRepo, {
      command: "review",
      json: true,
      noLlm: false,
      help: false,
      range: "HEAD~1",
    });
    const marked = JSON.parse(json.output).findings.filter((f: { beyondIntent?: true }) => f.beyondIntent);
    expect(marked).toHaveLength(1);
    expect(marked[0].tier).toBe("model");
  });

  it("collects no intent, prints no note, and shows no mark under --no-llm", async () => {
    const r = await review(intentRepo, {
      command: "review",
      json: false,
      noLlm: true,
      help: false,
      range: "HEAD~1",
    });
    expect(r.output).not.toContain("beyond stated intent");
    expect(r.output).not.toContain(INTENT_ABSENT_NOTE);
    expect(r.output).not.toContain("stated intent");
    expect(requestClaims).not.toHaveBeenCalled();
  });
});

describe("--stdout md", () => {
  const mdOpts = { command: "review", json: false, noLlm: true, help: false, stdout: "md" as const };

  it("puts the Markdown on stdout and every other line on stderr", async () => {
    const r = await review(repo, mdOpts);
    expect(r.exitCode).toBe(0);
    expect(r.markdown).toBeDefined();
    const md = r.markdown!;
    // The Markdown document, and nothing the other channel carries.
    expect(md.startsWith("# urtext review")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    for (const carried of ["Full report:", "Note:", 'Tip: add ".urtext/"']) {
      expect(md.includes(carried), `stdout carries "${carried}"`).toBe(false);
      // Asserted on both sides on purpose: a regression that simply dropped
      // these strings from both channels would pass a one-sided test.
      expect(r.output.includes(carried), `stderr lost "${carried}"`).toBe(true);
    }
  });

  it("keeps the md export path line off stdout while stderr still names it", async () => {
    const r = await review(repo, { ...mdOpts, exportFormats: ["md"] });
    expect(r.markdown).not.toContain("md export:");
    expect(r.output).toContain("md export:");
  });

  it("gives the stream and the file byte-identical Markdown from one model", async () => {
    const r = await review(repo, { ...mdOpts, json: true, exportFormats: ["md"] });
    // --json is refused beside --stdout md at the parser; `review` is called
    // directly here so the file path is readable from the JSON. The point is
    // the bytes, not the channel.
    const parsed = JSON.parse(r.output);
    expect(readFileSync(parsed.exportPaths.md, "utf8")).toBe(r.markdown);
  });

  it("still writes the HTML report, which the flag neither suppresses nor requires", async () => {
    const r = await review(repo, mdOpts);
    expect(r.reportPath).toMatch(/\.html$/);
    expect(existsSync(r.reportPath!)).toBe(true);
  });

  describe("on a run broken enough to exit nonzero", () => {
    const boom: Analyzer = async function explodingAnalyzer() {
      throw new Error("boom");
    };
    const boom2: Analyzer = async function explodingAnalyzer2() {
      throw new Error("boom2");
    };
    const quiet: Analyzer = async function quietAnalyzer() {
      return [];
    };
    const findsSomething: Analyzer = async function workingAnalyzer() {
      return [
        makeFact({
          id: "x",
          kind: "effect_added",
          detail: { effect: "network", sites: 1 },
          evidence: [{ file: "svc.ts", line: 2, excerpt: "return fetch(id);" }],
        }),
      ];
    };

    it("prints nothing on stdout when every analyzer fails, and keeps its exit code", async () => {
      const r = await review(repo, mdOpts, [boom, boom2]);
      expect(r.exitCode).not.toBe(0);
      expect(r.markdown).toBeUndefined();
      expect(r.output).toContain("analyzer failed");
      expect(r.output).toContain("No findings");
    });

    it("prints nothing on stdout when some fail and nothing was shown", async () => {
      const r = await review(repo, mdOpts, [boom, quiet]);
      expect(r.exitCode).not.toBe(0);
      expect(r.markdown).toBeUndefined();
      expect(r.output).toContain("analyzer failed");
    });

    it("still prints the review when a partial failure produced findings", async () => {
      // The third of the three existing analyzer-failure cases: this one
      // exits zero, so the contract says a review does reach stdout.
      const r = await review(repo, mdOpts, [boom, findsSomething]);
      expect(r.exitCode).toBe(0);
      expect(r.markdown).toBeDefined();
      expect(r.markdown).toContain("# urtext review");
      // The note stayed on the other channel, where it belongs.
      expect(r.markdown).not.toContain("Note:");
      expect(r.output).toContain("analyzer failed");
    });
  });
});

describe("streamsFor", () => {
  const plain = { command: "review", json: false, noLlm: true, help: false };

  it("leaves stdout to the terminal render and stderr empty without the flag", () => {
    const s = streamsFor({ output: "TERMINAL\n", markdown: "MARKDOWN\n" }, plain);
    expect(s.stdout).toBe("TERMINAL\n");
    expect(s.stderr).toBe("");
  });

  it("swaps the two documents under the flag", () => {
    const s = streamsFor({ output: "TERMINAL\n", markdown: "MARKDOWN\n" }, {
      ...plain,
      stdout: "md",
    });
    expect(s.stdout).toBe("MARKDOWN\n");
    expect(s.stderr).toBe("TERMINAL\n");
  });

  it("empties stdout entirely when the run produced no Markdown", () => {
    // Not a blank line, not a newline: empty. A body sitting in a pipe looks
    // like a successful review to anyone who only checks whether one arrived.
    const s = streamsFor({ output: "TERMINAL\n" }, { ...plain, stdout: "md" });
    expect(s.stdout).toBe("");
    expect(s.stderr).toBe("TERMINAL\n");
  });
});

describe("--citations", () => {
  it("parses the flag, and still rejects a near miss", () => {
    expect(parseArgs(["review", "--citations"]).citations).toBe(true);
    expect(parseArgs(["review"]).citations).toBeUndefined();
    expect(() => parseArgs(["review", "--citation"])).toThrow(/Unknown option: --citation\b/);
  });

  it("names the flag in USAGE, in copy that says none of the forbidden words", () => {
    expect(USAGE).toContain("--citations");
    const usage = USAGE.toLowerCase();
    // The vocabulary the design forbids urtext about a citation, checked here
    // because the copy guard cannot reach this string: it scans findings and
    // disclosure notes, and USAGE is neither. Matched the way
    // `test/report/copy-guard.test.ts` matches them — seven as substrings,
    // and "lies" on a word boundary, so "applies" and "relies" stay ordinary
    // English this help text is entitled to use.
    for (const word of [
      "wrong",
      "incorrect",
      "outdated",
      "stale",
      "obsolete",
      "misleading",
      "broken",
    ]) {
      expect(usage.includes(word), word).toBe(false);
    }
    expect(/\blies\b/.test(usage), "lies").toBe(false);
  });

  it("reports a real rotted citation, and only under the flag when the cited file is untouched", async () => {
    const base = { command: "review", json: true, noLlm: true, help: false } as const;
    const rotIds = (json: string): string[] =>
      JSON.parse(json)
        .findings.map((f: { id: string }) => f.id)
        .filter((id: string) => id.startsWith("citation_rot:"))
        .sort();
    const touched = "citation_rot:NOTES.md:2:content_drift";
    const untouched = "citation_rot:NOTES.md:1:content_drift";

    // Both citations have rotted the same way and by the same arithmetic.
    // The default mode reports the one pointing into the file this range
    // touched, and nothing about the other — that is the mode boundary, not
    // an inability to see it, which is what the sweep below proves.
    const plain = await review(rotRepo, { ...base });
    expect(rotIds(plain.output)).toEqual([touched]);

    const swept = await review(rotRepo, { ...base, citations: true });
    expect(rotIds(swept.output)).toEqual([untouched, touched]);

    const rot = JSON.parse(swept.output).findings.find(
      (f: { id: string }) => f.id === untouched,
    );
    expect(rot.tier).toBe("verified");
    // The finding anchors on the prose that has to be edited, not on the code.
    expect(rot.file).toBe("NOTES.md");
    expect(rot.title).toContain("`src/limits.ts:1`");
    expect(rot.title).toContain("no longer reads the same");
    // Deterministic, so both runs above ran it — `--citations` is independent
    // of `--no-llm`, which both of them set.
    //
    // Nothing was capped, undated, or skipped in a repository this small, so
    // the disclosure channel stays silent here — and this is the same run
    // that just proved citation checking ran at all, which is what makes the
    // silence mean something.
    expect(JSON.parse(swept.output).warnings.every((w: string) => !w.includes("citation"))).toBe(
      true,
    );
  });
});

describe("citation disclosure", () => {
  // Every sentence citation checking can emit, taken from the copy functions
  // themselves rather than retyped here: what this file has to pin is the
  // channel, and a second copy of the wording would pin only itself. The
  // arguments are arbitrary; the counts inside each sentence are the
  // functions' own arithmetic, so a note that arrives truncated, wrapped, or
  // reworded fails the containment checks below.
  const NOTES = [
    citingFilesCappedNote(2, 4),
    citationsCappedNote(3, 5),
    baselineReadsCappedNote(1),
    blameUnavailableNote(2, "fatal: no such ref"),
    shallowRepositoryNote(),
  ];

  /**
   * Runs `fn` against a freshly loaded `cli.ts` whose citation analyzer
   * factory records how it was configured and emits every note above. Only
   * the factory is replaced: `citationsAnalyzer` stays the real exported
   * value, because the swap in `review` matches on that identity and a mock
   * that replaced it too would prove nothing about the wiring. The module
   * registry is reset on both sides, so the rest of this file keeps the
   * unmocked modules it imported at the top — the shape
   * `test/analyze/citations-rot.test.ts` uses for its blame failures.
   */
  async function withNotingCitations<T>(
    fn: (mockedReview: typeof review, configured: CitationsOptions[]) => Promise<T>,
  ): Promise<T> {
    const actual = await vi.importActual<typeof import("../src/analyze/index.js")>(
      "../src/analyze/index.js",
    );
    const configured: CitationsOptions[] = [];
    vi.doMock("../src/analyze/index.js", () => ({
      ...actual,
      makeCitationsAnalyzer: (options: CitationsOptions = {}): Analyzer => {
        configured.push(options);
        return async () => {
          for (const note of NOTES) options.onNote?.(note);
          return [];
        };
      },
    }));
    vi.resetModules();
    try {
      const mod = await import("../src/cli.js");
      return await fn(mod.review, configured);
    } finally {
      vi.doUnmock("../src/analyze/index.js");
      vi.resetModules();
    }
  }

  it("carries every note the analyzer emits to a Note: line and to --json's warnings, in both modes", async () => {
    await withNotingCitations(async (mockedReview, configured) => {
      const base = { command: "review", noLlm: true, help: false } as const;
      const modes: Array<[string, Partial<CliOptions>]> = [
        ["--citations", { citations: true }],
        ["the default mode", {}],
      ];
      for (const [label, mode] of modes) {
        const term = await mockedReview(rotRepo, { ...base, json: false, ...mode });
        for (const note of NOTES) {
          expect(term.output, `${label}: the terminal lost "${note}"`).toContain(`  Note: ${note}`);
        }
        // A capped, undated, or skipped citation run is a disclosed shortfall,
        // not a broken review: it exits zero, exactly as the unaffected
        // analyzers' findings deserve.
        expect(term.exitCode, label).toBe(0);
        const parsed = JSON.parse(
          (await mockedReview(rotRepo, { ...base, json: true, ...mode })).output,
        );
        for (const note of NOTES) {
          expect(parsed.warnings, `${label}: --json lost "${note}"`).toContain(note);
        }
        // Swapped in rather than added beside. The registered instance is the
        // default-mode one, and this repository has a rotted citation into the
        // file the range touched — precisely what the default mode reports. So
        // a run that kept it as well as the configured instance would show that
        // finding here, while the configured instance above returns nothing.
        expect(
          parsed.findings.some((f: { id: string }) => f.id.startsWith("citation_rot:")),
          `${label}: a second citation analyzer ran`,
        ).toBe(false);
      }
      // Four runs, and the mode each was configured with. A swap that dropped
      // `sweep` would leave the sweep unreachable while every note above still
      // arrived, and a flag read the wrong way round would sweep by default.
      expect(configured.map((o) => o.sweep)).toEqual([true, true, false, false]);
      // A configured instance with no channel to disclose on is the silent cap
      // this whole feature refuses.
      expect(configured.every((o) => typeof o.onNote === "function")).toBe(true);
    });
  });

  it("discloses a shallow clone on both surfaces, where the same repository with its history reports the rot instead", async () => {
    // Asserted, not assumed: git ignores `--depth` on a plain local clone, and
    // a fixture that quietly stopped being shallow would make every
    // expectation below pass for the wrong reason.
    expect(gitIn(shallowRepo, ["rev-parse", "--is-shallow-repository"]).toString().trim()).toBe(
      "true",
    );
    const note = shallowRepositoryNote();
    const base = { command: "review", noLlm: true, help: false, citations: true } as const;

    const term = await review(shallowRepo, { ...base, json: false });
    expect(term.output).toContain(`  Note: ${note}`);
    // A skipped check is disclosed, not fatal: the rest of the review stands.
    expect(term.exitCode).toBe(0);
    const shallowJson = JSON.parse((await review(shallowRepo, { ...base, json: true })).output);
    expect(shallowJson.warnings).toContain(note);
    expect(
      shallowJson.findings.some((f: { id: string }) => f.id.startsWith("citation_rot:")),
    ).toBe(false);

    // The contrast that makes the sentence worth printing: the same files with
    // their history report the rotted citation and say nothing about having
    // skipped anything. Without the disclosure, the run above is that run
    // minus a finding, and no reader could tell which.
    const full = JSON.parse((await review(rotRepo, { ...base, json: true })).output);
    expect(full.findings.some((f: { id: string }) => f.id.startsWith("citation_rot:"))).toBe(true);
    expect(full.warnings).not.toContain(note);
  });
});
