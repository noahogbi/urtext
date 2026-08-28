# Urtext on a Pull Request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A urtext review arrives on the pull request that produced the diff, as one comment edited in place on every push, without urtext learning what a pull request is.

**Architecture:** The CLI gains exactly one flag, `--stdout md`, which redirects which document owns which stream: the Markdown review takes stdout alone and the terminal render — notes, report path, export paths, gitignore tip — moves to stderr. A composite `action.yml` at the repository root does every forge-specific thing: derive `<base>...<head>` from the `pull_request` payload, run `dist/bin.js`, hand the review to a pure Node composer that adds a marker, a footer, and a disclosed cap, then upsert the comment with `gh`. The seam between urtext and the action is Markdown on stdout plus an exit code, and nothing else crosses it.

**Tech Stack:** TypeScript 5.4 (strict), Node 20+, vitest, tsx. **No new runtime dependency.** `action/compose-comment.mjs` and `action/compose-comment-bin.mjs` are plain ESM JavaScript run by the runner's bare `node` — no build step, no loader, no `setup-node` requirement — and they import nothing at all. `gh` and `jq` are provided by every GitHub-hosted runner and are never urtext's dependencies. One new **devDependency**, `yaml`, used by a single test that parses `action.yml` as data (the spec names it as the one dependency this design adds; it never reaches `dependencies` and never reaches `dist`).

**Spec:** `docs/superpowers/specs/2026-08-23-urtext-pr-native-design.md` — the binding authority. Implementers read it before their task; where this plan and the spec disagree, the spec wins and the conflict is a ruling for the controller. Places where the spec is silent and this plan supplies glue are marked **Glue** inline; places where two spec sentences pull apart are marked **Ruling needed** and are collected at the end.

**Predecessors:** `2026-08-15-urtext-diff-review-core.md` (PR #1), `2026-08-16-urtext-analyzers.md` (PR #2), `2026-08-16-urtext-interpretation.md` (PR #3), `2026-08-22-urtext-export-model.md` (PR #10), `2026-08-23-urtext-intent-comparison.md` (PR #11) — all merged. This is the sixth plan in the sequence.

## Global Constraints

- Node 20+, ESM only; relative imports carry `.js` extensions. TypeScript `strict: true` with `noUnusedLocals`/`noUnusedParameters`; no `any` in exported signatures. The `.mjs` files live under the same `strict` settings once `checkJs` is on, and their types are expressed in JSDoc.
- Carried verbatim from the spec's Global constraints:
  - No claim ever renders as `verified`; model prose never renders without attribution; the concealment defense applies to every surface; empty-lens copy is filter-shaped; **urtext writes only inside `.urtext/`** — the action writes to `$RUNNER_TEMP` and `$GITHUB_STEP_SUMMARY`, which is the action's own filesystem and not the reviewed repository's.
  - **No new runtime dependency.** `gh` and `jq` are the runner's, not urtext's; `yaml` is a devDependency used by one test; the composer imports nothing at all.
  - **No GitHub knowledge under `src/`.** The cap, the marker, the links, and the event payload exist only in `action.yml` and `action/`. A test asserts the boundary by scanning `src/` for `github`, `GITHUB_`, `pull_request`, and `gh api` (Task 3, Step 4).
  - **Comment contract:** comments name constants, never restate values, and `test/comment-contract.test.ts` must stay green. Two hazards this feature introduces, both avoidable and both worth naming so the plan does not trip them: **the character cap must never be written into a comment or a copy string** — it arrives as an argument and is interpolated into the disclosure from that argument, so there is exactly one place it exists; and **the comment-contract scan covers `.ts` files only** (`test/comment-contract.test.ts` filters on `extname(entry) === ".ts"`), so the composer's `.mjs` comments are outside it and must be written to the same standard without a guard to catch them.
  - Invariant claims quote their enforcing test verbatim, in the style the existing modules already use.
  - Every behavior change lands with a test that fails before it.
- **stdout purity, verbatim from §1:** under `--stdout md` on a zero-exit run, "stdout carries exactly `renderMarkdown(model)` and **nothing else**. No report-path line, no export path lines, no gitignore tip, no note, no banner, no trailing blank line beyond the single `\n` `renderMarkdown` already ends with." On a nonzero-exit run, **stdout is empty** — no extra byte, which includes the newline `main` normalizes onto every other stdout string today.
- **`--stdout md` cannot combine with `--json`.** "Two documents on one stream is not a formatting problem to resolve, it is a request with no correct answer." The check is order-independent and lives at the end of `parseArgs`.
- **This is purely additive, and that is an acceptance test, not an aspiration.** "Every existing flag, exit code, output surface, and test expectation is unchanged." The existing `test/cli.test.ts` suite passes with **zero changes to expected strings**; imports may be added, expectations may not be edited. Any existing test that goes red is a bug in the new code.
- **The exit-code matrix is untouched.** `allAnalyzersFailed` and `someFailedNothingShown` remain the only two rules. `--stdout md` reads the exit code; it never sets one. The HTML report is still written on every zero-exit run.
- **The action never fails the pull request by default.** `fail-on-error` defaults to `false`; failure is disclosed in a comment, never as a red check. The one deliberate exception is the `pull_request_target` refusal, to which `fail-on-error` does not apply.
- **`pull_request_target` is refused, loudly.** No configuration runs this action on that trigger. No step reads the pull request title, body, or branch name. Every expression value reaches a script through `env:`, never through `${{ }}` inside a `run:` body — enforced mechanically by `test/action/action-yml.test.ts`.
- **Fork pull requests get no comment, and the action says so rather than pretending.** `GITHUB_TOKEN` is read-only on a fork-head `pull_request` run regardless of the `permissions:` block, and repository secrets are unavailable. The action attempts the post, emits a `::warning::` on failure, sets `posted: none`, leaves the full review in the job summary and the artifact, and does not fail the step. The documentation states this limitation and points at the two-workflow `workflow_run` pattern rather than implying fork support that does not exist.
- Byte-check every changed file for NUL bytes before every commit:
  `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" <files>` must print `0`.
- Run `npx vitest run` **BARE** and gate on its exit code — never through a pipe.

## File Structure

- Modify: `src/cli.ts` — `STDOUT_FORMATS`, `StdoutFormat`, `CliOptions.stdout`, `stdoutUsageError`, the `--stdout` parse arms, the `--json` conflict check, the USAGE entry, the widened export-model gate, `review`'s `markdown` return field, `streamsFor`, `main`'s routing.
- Modify: `tsconfig.json` — `allowJs`, `checkJs`, and `action/**/*` in `include`. `tsconfig.build.json` is untouched (it overrides `include` to `["src/**/*"]`, so the build never sees `action/`).
- Modify: `package.json` — one devDependency, `yaml`. `files` is **unchanged**: `action/` is consumed from a git checkout by `uses:`, never from an npm tarball, and the spec says these files "are not part of `dist` and are not published".
- Create: `action/compose-comment.mjs` — `composeComment(options) => { body, omitted, kept, outcome }`.
- Create: `action/compose-comment-bin.mjs` — argv in, files out, runs unconditionally.
- Create: `action.yml` at the repository root — the composite action.
- Create: `.github/workflows/urtext-review.yml` — the dogfooding workflow.
- Modify: `README.md` — an "In CI" subsection under Install; `action.yml` and `action/` added to the Layout list. Nothing in the existing copy changes.
- Tests: extend `test/cli.test.ts`; create `test/action/compose-comment.test.ts`, `test/action/action-yml.test.ts`, `test/action/boundary.test.ts`.
- `.github/workflows/ci.yml` is **unchanged**, deliberately — see §6. Its final step, `node dist/bin.js review HEAD~1 --no-llm`, is a two-platform smoke test of the shipped binary, not a review, and replacing it with the action would trade that for a one-platform check of a workflow.

**What can be verified locally, per task, stated once here and repeated in each task:**

| Task | Locally verifiable in vitest | Only verifiable by running it for real |
|---|---|---|
| 1 (`--stdout md`) | Everything. Parsing, purity, byte-identity with `--export md`, the exit-code gate, `streamsFor`. | Nothing. |
| 2 (composer) | Everything. Marker, truncation arithmetic, fence-aware segmentation, emptied views, failure bodies, links. | Nothing. |
| 3 (`action.yml`) | Its **shape** as data: parses, composite, `shell: bash` everywhere, inputs/outputs wired, no `${{` in a `run` body, step order. | Its **behavior**: `$GITHUB_OUTPUT`, `$RUNNER_TEMP`, `gh`, `jq`, the event payload, `actions/upload-artifact`. None of these exist inside vitest. |
| 4 (workflow + docs) | Nothing meaningful. | All of it — the eight-item acceptance checklist, against a real pull request in this repository. |

**A composite GitHub Action cannot be executed by vitest.** There is no runner for the environment it needs, this design does not propose adding one, and no step in this plan claims otherwise. Task 3's tests check the shape; the wiring is checked by running it in Task 4.

---

### Task 1: `--stdout md`, `streamsFor`, and the stream routing

One new flag, one new optional return field, one extracted function. Entirely testable in vitest, and the acceptance bar is that no existing expected string in `test/cli.test.ts` changes.

**Files:**
- Modify: `src/cli.ts`
- Test: extend `test/cli.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown(model: ReportModel): string` from `src/report/markdown.js` (already the default `exporters.md`); `buildReportModel(changeset, findings, meta)` from `src/report/model.js`; `EXPORT_FORMATS`, `writeExport` from `src/report/write.js` — all unchanged.
- Produces (verbatim from the spec's §1; Tasks 2 and 3 rely on these exact names):

```ts
/**
 * Every format `--stdout` can carry. One member today, and a union rather
 * than a boolean for the same reason `IntentSource` is one: a second member
 * is a compile error at every site that decides what stdout holds, instead
 * of a boolean that quietly means "the one other thing".
 */
export const STDOUT_FORMATS = ["md"] as const;

export type StdoutFormat = (typeof STDOUT_FORMATS)[number];

export interface CliOptions {
  // ... unchanged fields ...
  /**
   * The format `--stdout` asked for. Optional for the same reason as `open`
   * and `exportFormats`: pre-existing callers construct `CliOptions`
   * literals without it. Undefined means the terminal render owns stdout,
   * as it always has.
   */
  stdout?: StdoutFormat;
}

export async function review(
  cwd: string,
  opts: CliOptions,
  analyzers?: Analyzer[],
  exporters?: Exporters,
): Promise<{
  output: string;
  exitCode: number;
  reportPath: string | undefined;
  /**
   * The Markdown review, present exactly when `--stdout md` was given and
   * the run produced one. `output` keeps its meaning — the human render and
   * every path line — and `main` decides which stream each goes to.
   */
  markdown?: string;
}>;

/**
 * Which stream carries which document. Extracted from `main` for the reason
 * `openOrExplain` was: `main` reads `process.argv` and writes to the real
 * process streams, so neither branch is reachable from a test through it.
 * Under `--stdout md` the Markdown owns stdout alone and the human render —
 * notes, path lines, tip — moves to stderr; otherwise nothing moves. See
 * `test/cli.test.ts`, "--stdout md puts the Markdown on stdout and every
 * other line on stderr".
 */
export function streamsFor(
  result: { output: string; markdown?: string },
  opts: CliOptions,
): { stdout: string; stderr: string };
```

`STDOUT_FORMATS` lives in `src/cli.ts`, **not** beside `EXPORT_FORMATS` in `src/report/write.ts`: the writer owns filenames, nothing outside the CLI decides what a stream carries, and putting a stream's contents in a file-writing module would invite the next reader to look for a `writeStdout`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.ts`. The `parseArgs` cases go inside the existing top-level `describe("parseArgs", ...)`, beside the `--model` and `--export` sub-describes; the rest go at the end of the file as their own top-level describe. Add `streamsFor` to the existing `import { openOrExplain, parseArgs, review, USAGE } from "../src/cli.js";`.

```ts
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

    it("names the flag in the usage text", () => {
      expect(USAGE).toContain("--stdout md");
    });
  });
```

```ts
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
```

`readFileSync`, `existsSync`, `makeFact`, and `Analyzer` are already imported at the top of `test/cli.test.ts`; `repo` is the shared fixture built in the file's `beforeAll`. Only `streamsFor` is a new import.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run test/cli.test.ts`

Expected: FAIL — `streamsFor` is not exported from `../src/cli.js`; TypeScript rejects `stdout: "md"` on `CliOptions`; `parseArgs(["--stdout", "md"])` throws `Unknown option: --stdout`; `r.markdown` is `undefined` on every case including the zero-exit ones; `USAGE` does not contain `--stdout md`.

- [ ] **Step 3: Add the format union, the option, and the parse arms in `src/cli.ts`**

Above `CliOptions`, transcribed from the spec's §1 with its doc comment:

```ts
/**
 * Every format `--stdout` can carry. One member today, and a union rather
 * than a boolean for the same reason `IntentSource` is one: a second member
 * is a compile error at every site that decides what stdout holds, instead
 * of a boolean that quietly means "the one other thing". Lives here and not
 * beside EXPORT_FORMATS in `./report/write.js`: that constant belongs to the
 * writer because the writer owns the filenames, and nothing outside this
 * file decides what a stream carries.
 */
export const STDOUT_FORMATS = ["md"] as const;

export type StdoutFormat = (typeof STDOUT_FORMATS)[number];
```

On `CliOptions`, after `model`:

```ts
  /**
   * The format `--stdout` asked for. Optional for the same reason as `open`
   * and `exportFormats`: pre-existing callers construct `CliOptions`
   * literals without it. Undefined means the terminal render owns stdout, as
   * it always has.
   */
  stdout?: StdoutFormat;
```

Beside `exportUsageError`, in the same example-led shape:

```ts
/**
 * One wording for every way `--stdout` can be misused — an unknown format, a
 * missing value, a swallowed flag — so the user always sees the full list of
 * what the flag does accept, exactly as `exportUsageError` above does.
 */
function stdoutUsageError(problem: string): Error {
  return new Error(
    `--stdout ${problem}; it takes ${STDOUT_FORMATS.join(" and ")}, e.g. --stdout md.`,
  );
}

/** Both spellings fold through here, so neither can accept what the other rejects. */
function setStdoutFormat(opts: CliOptions, value: string): void {
  if (!(STDOUT_FORMATS as readonly string[]).includes(value)) {
    throw stdoutUsageError(`cannot write "${value}"`);
  }
  opts.stdout = value as StdoutFormat;
}
```

Two arms in `parseArgs`'s loop, after the `--export` arms and before the `arg.startsWith("-")` catch-all:

```ts
    } else if (arg.startsWith("--stdout=")) {
      setStdoutFormat(opts, arg.slice("--stdout=".length));
    } else if (arg === "--stdout") {
      const value = argv[i + 1];
      // A following flag is the next option, not this one's value — the same
      // rule `--model` and `--export` already apply.
      if (!value || value.startsWith("-")) throw stdoutUsageError("needs a format");
      setStdoutFormat(opts, value);
      i++;
```

And the conflict check, after the loop and before the positional handling, so it holds whichever order the two flags were written in:

```ts
  // After the loop on purpose: `--json --stdout md` and `--stdout md --json`
  // are the same request, and a check inside the loop would only catch one
  // order. See `test/cli.test.ts`, "refuses to put two documents on one
  // stream, in either order".
  if (opts.stdout !== undefined && opts.json) {
    throw new Error(`--stdout ${opts.stdout} and --json cannot both own stdout; pick one.`);
  }
```

The USAGE entry, between the `--export` block and `--help`, in the existing voice and spacing:

```
  --stdout md Write the Markdown review to stdout and nothing else; the
              terminal render and every note move to stderr. Cannot be
              combined with --json.
```

- [ ] **Step 4: Widen the export-model gate and return `markdown` from `review`**

Widen the return type, adding the field and its doc comment:

```ts
): Promise<{
  output: string;
  exitCode: number;
  reportPath: string | undefined;
  /**
   * The Markdown review, present exactly when `--stdout md` was given and the
   * run produced one. `output` keeps its meaning — the human render and every
   * path line — and `main` decides which stream each goes to. See
   * `test/cli.test.ts`, "--stdout md puts the Markdown on stdout and every
   * other line on stderr".
   */
  markdown?: string;
}> {
```

Declare `let markdown: string | undefined;` beside `let reportPath: string | undefined;`.

Then replace the export block. Today it reads `if (reportPath && exportFormats.length > 0) { const exportModel = ...; for (...) {...} }`. It becomes one build under the widened gate, in the same place — after the report-write attempt, before the export loop — so a report-write failure warning is already in `warnings` and reaches both the file and the stream:

```ts
    // One model, one renderer, one string: `--stdout md` and `--export md`
    // cannot diverge. The gate widens past `reportPath` for the stream and
    // only for the stream — the export loop below keeps its own gate, because
    // the stem argument is about files pairing on disk and a stream is not a
    // file. See `test/cli.test.ts`, "gives the stream and the file
    // byte-identical Markdown from one model".
    if (exportFormats.length > 0 || opts.stdout !== undefined) {
      // Built once, and every requested export walks this one instance.
      // `renderHtml` above still builds its own internally — its public
      // signature takes the raw pieces and is out of this change's scope.
      const exportModel = buildReportModel(changeset, findings, {
        model: result.model,
        warnings,
        suppressed,
      });
      if (opts.stdout === "md") {
        try {
          markdown = exporters.md(exportModel);
        } catch (err) {
          // The same degradation rule the exports below apply: a renderer
          // that threw costs the run that one document, never the findings or
          // the exit code. stdout is then empty on a zero-exit run, which the
          // action reads as a failed review rather than as a clean one.
          warnings.push(
            `could not render the md review for stdout: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (reportPath) {
        for (const format of exportFormats) {
          // ... this loop's body is unchanged ...
        }
      }
    }
```

**Glue.** The spec says `markdown` is set "from that one model with the same `exporters.md` the file export uses" but does not say what happens when that renderer throws. The injectable `exporters` parameter exists precisely so a test can make it throw (`test/cli.test.ts`, "degrades a failing export to a warning"), so leaving it unguarded would turn an existing test's injected failure into a rejection from `review`. Catching it keeps `review`'s contract — a render failure costs one document — and lands the run in the exit-0-with-empty-stdout row the action's own table in §4 already covers.

Two calls to `exporters.md` (one for the stream, one for the file) rather than one call reused: `renderMarkdown` is a pure walker over one model instance, the byte-identity test pins that the two agree, and reusing a single call would make the existing "degrades a failing export to a warning" test unable to distinguish which of the two paths failed.

Every `return` in `review` gains `markdown`. The `--json` return and the terminal return both become `{ output, exitCode, reportPath, markdown }` — `markdown` is `undefined` on the `--json` path by construction, because the parser refuses the combination, and returning the field uniformly means no caller has to know which branch it came from.

- [ ] **Step 5: Extract `streamsFor` and route the streams in `main`**

Beside `openOrExplain`, transcribed from the spec's §1:

```ts
/**
 * Which stream carries which document. Extracted from `main` for the reason
 * `openOrExplain` was: `main` reads `process.argv` and writes to the real
 * process streams, so neither branch is reachable from a test through it.
 * Under `--stdout md` the Markdown owns stdout alone and the human render —
 * notes, path lines, tip — moves to stderr; otherwise nothing moves. An
 * absent `markdown` empties stdout rather than falling back to `output`: a
 * review body sitting in a pipe looks like a successful review to anyone who
 * only checks whether one arrived. See `test/cli.test.ts`, "--stdout md puts
 * the Markdown on stdout and every other line on stderr" and "empties stdout
 * entirely when the run produced no Markdown".
 */
export function streamsFor(
  result: { output: string; markdown?: string },
  opts: CliOptions,
): { stdout: string; stderr: string } {
  if (opts.stdout === undefined) return { stdout: result.output, stderr: "" };
  return { stdout: result.markdown ?? "", stderr: result.output };
}
```

In `main`, replace the single `process.stdout.write(...)` line:

```ts
    const result = await review(process.cwd(), opts);
    const { stdout, stderr } = streamsFor(result, opts);
    // Guarded on non-empty, which is what "and nothing else" costs: the
    // normalization below would otherwise turn an empty stdout into a lone
    // newline on a broken `--stdout md` run. `output` is never empty — the
    // terminal walker always prints a banner — so the default path writes
    // exactly the bytes it wrote before this change.
    if (stdout) process.stdout.write(stdout.endsWith("\n") ? stdout : stdout + "\n");
    if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : stderr + "\n");
    process.exitCode = result.exitCode;
    if (opts.open) openOrExplain(result.reportPath, (m) => process.stderr.write(m));
```

**Ruling — MADE by the controller, not open.** The spec's §1 says `main` writes `streamsFor(...).stdout` with today's trailing-newline normalization, and also that a broken run's stdout is empty with "no extra byte either". Applied literally those conflict: at the time of this ruling `src/cli.ts` wrote `process.stdout.write(output.endsWith("\n") ? output : output + "\n")`, so an empty string emits a lone `"\n"` — confirmed in source then. **[Line number removed 2026-08-28. This ruling was carried out, so the code it pointed at no longer exists in that form; the guarded write now lives in `main` beside `streamsFor`. Repointing would have been wrong — the sentence describes the unguarded write as the problem, and the line there now is the guarded one this ruling ordered. A claim about a past state should not carry a line-precise pointer into present code, which is what urtext's citation analyzer reported here.]** **Guard the write on a non-empty string.** "Empty" must mean zero bytes, because the action pipes this stream and a one-byte stdout is indistinguishable from a review that rendered nothing — the emptiness is a signal the action reads, per §4's table. `output` is never empty on the default path, so today's behavior is byte-identical and no existing expectation moves. Pin with the third `streamsFor` test plus the broken-run tests. Do not revisit.

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS, every case, **with every pre-existing test in the file green and no expected string edited**.

- [ ] **Step 7: Mutation checks**

Each is a one-line change; restore after each and report the observed failure by name.

1. Delete the `opts.stdout !== undefined` disjunct from the export-model gate, leaving `if (exportFormats.length > 0)`. `npx vitest run test/cli.test.ts` must fail "--stdout md puts the Markdown on stdout and every other line on stderr" — `markdown` is undefined on a run with no `--export`. Restore.
2. Move the `markdown` assignment outside `if (exitCode === 0)` (or delete the enclosing gate). `npx vitest run test/cli.test.ts` must fail "prints nothing on stdout when every analyzer fails, and keeps its exit code". This is the spec's own named mutation: "Deleting the exit-code gate must fail this test." Restore.
3. In `streamsFor`, change `result.markdown ?? ""` to `result.markdown ?? result.output`. `npx vitest run test/cli.test.ts` must fail "empties stdout entirely when the run produced no Markdown". Restore.

- [ ] **Step 8: Verify against the real tool**

```bash
npx tsx src/bin.ts review HEAD~1 --no-llm --stdout md > /tmp/urtext-stdout.md 2> /tmp/urtext-stdout.log
```

Expected: `/tmp/urtext-stdout.md` begins `# urtext review`, contains no `Note:`, no `Full report:`, and no `Tip:`; `/tmp/urtext-stdout.log` contains all three. Then confirm the pipe-safety claim mechanically:

```bash
npx tsx src/bin.ts review HEAD~1 --no-llm --stdout md 2>/dev/null | head -1
```

Expected: exactly `# urtext review` on the first line, with no banner above it. Also run `npx tsx src/bin.ts review HEAD~1 --no-llm --stdout md --json` and confirm the usage error names both flags and exits 1.

- [ ] **Step 9: Full-suite gate**

Run, in order, and gate on each:
- `npx vitest run` (BARE — exit code is the gate, never a pipe)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" src/cli.ts test/cli.test.ts` → must print `0`

- [ ] **Step 10: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat(cli): --stdout md gives the Markdown review the stdout stream alone"
```

---

### Task 2: The comment composer

A pure Markdown-comment composer with a character budget, in plain ESM JavaScript, type-checked through JSDoc and unit-tested against the real renderer. It does not know what GitHub is: the marker, the cap, and both links arrive as arguments. This is where the cap's honesty is pinned, and all of it is testable locally.

**Files:**
- Create: `action/compose-comment.mjs`, `action/compose-comment-bin.mjs`
- Modify: `tsconfig.json`
- Test: create `test/action/compose-comment.test.ts`

**Interfaces:**
- Consumes: **nothing.** The composer has no imports at all. `compose-comment-bin.mjs` imports `node:fs` and the composer, and nothing else.
- Produces (verbatim from the spec's §3):

```js
/**
 * @typedef {object} ComposeOptions
 * @property {string} marker        First line of every body; how the upsert finds its comment.
 * @property {number} limit         Maximum body length in characters.
 * @property {string} review        The Markdown review, verbatim from `urtext --stdout md`.
 * @property {string} log           urtext's stderr, used only by the failure body.
 * @property {number} exitCode      urtext's exit code, verbatim.
 * @property {string} range         The range urtext was asked for, for the failure body.
 * @property {string} runUrl        Link to the workflow run. Always present.
 * @property {string} [artifactUrl] Link to the uploaded report, when there is one.
 */

/**
 * @param {ComposeOptions} options
 * @returns {{ body: string, omitted: number, kept: number, outcome: "reviewed" | "failed" }}
 */
export function composeComment(options) { /* ... */ }
```

Also exported, for the test to assert on the copy rather than on a hand-retyped duplicate of it: `LOG_TAIL_LINES`, `FAILURE_HEADLINE`, `FAILURE_CLOSING`, `DISCLOSURE_OVERFLOW_REASON`, `truncationNotice`, `emptiedViewCopy`, `segment`, `assemble`.

Depends on Task 1: the test's corpus comes from `review(..., { stdout: "md" })`.

- [ ] **Step 1: Make the `.mjs` files type-checkable**

`tsconfig.json` gains exactly three things, and `tsconfig.build.json` is untouched — it overrides `include` to `["src/**/*"]`, so the build never compiles `action/` and nothing new reaches `dist`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "declaration": true,
    "allowJs": true,
    "checkJs": true
  },
  "include": ["src/**/*", "test/**/*", "action/**/*", "vitest.config.ts"]
}
```

That is the whole change, and it is exactly what the spec asks for: "`tsconfig.json` gains `"allowJs": true`, `"checkJs": true`, and `"action/**/*"` in `include`, so `npx tsc --noEmit` covers them through JSDoc types." Nothing else in the file moves. `strict`, `noUnusedLocals`, and `noUnusedParameters` now apply to the composer too, which is intended.

Run `npx tsc --noEmit` immediately after this edit and before writing any `.mjs`: it must still pass with zero errors, proving the config change alone broke nothing.

- [ ] **Step 2: Write the failing tests**

Create `test/action/compose-comment.test.ts`. Its corpus is built by running the **real** `renderMarkdown` over models built from real analyzer output — `review(..., { stdout: "md" })` on real git fixture repositories, which is `renderMarkdown(buildReportModel(...))` and nothing else. A fixture written to match the scanner cannot notice the renderer changing.

```ts
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

    it("takes the first removal from the largest view", () => {
      const before = segment(findingsReview).sections.map((s) => s.findings.length);
      const largest = before.lastIndexOf(Math.max(...before));
      // A limit one character under the untruncated body forces exactly the
      // arithmetic to remove at least one, and the notice to appear.
      const full = composeComment(base()).body.length;
      const r = composeComment(base({ limit: full - 1 }));
      const after = segment(r.body).sections.map((s) => s.findings.length);
      expect(after[largest]).toBeLessThan(before[largest]);
    });

    it("says an emptied view was emptied, and never that nothing matched it", () => {
      // "Nothing in this range matched this view" would be a lie about a view
      // whose findings this comment dropped.
      const r = composeComment(base({ limit: MARKER.length + 700 }));
      const sections = segment(r.body).sections;
      const emptied = sections.filter((s) => s.findings.length === 0);
      expect(emptied.length).toBeGreaterThan(0);
      const originals = segment(findingsReview).sections;
      for (const s of emptied) {
        const original = originals.find((o) => o.heading === s.heading)!;
        expect(s.heading).toBe(original.heading);
        const text = s.preamble.join("\n");
        expect(text).toContain(emptiedViewCopy(original.findings.length));
        expect(text).not.toContain(EMPTY_LENS_COPY);
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
      const r = composeComment(base({ limit: MARKER.length + 120 }));
      expect(r.outcome).toBe("failed");
      expect(r.body).toContain("the review's disclosures alone exceed the comment limit");
      expect(r.body.length).toBeLessThanOrEqual(MARKER.length + 120);
    });
  });
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npx vitest run test/action/compose-comment.test.ts`
Expected: FAIL — `Failed to resolve import "../../action/compose-comment.mjs"`; the module does not exist.

- [ ] **Step 4: Implement `action/compose-comment.mjs`**

The whole file. The `@typedef` block and the `composeComment` signature are transcribed verbatim from the spec's §3; everything else is the segmentation, removal, and disclosure the spec's §3 and §4 describe in prose.

```js
/**
 * The comment composer: a Markdown document with a character budget.
 *
 * It imports nothing, and it does not know what GitHub is. The marker, the
 * cap, and both links arrive as arguments, and their values live in
 * `action.yml`. That is what keeps "urtext learns nothing about GitHub" true
 * of this repository and not merely of its `src/` directory.
 *
 * It is also not allowed to reword, reorder, demote, or summarize what the
 * CLI printed. It may prepend the marker, append the footer, and remove whole
 * findings under a stated cap — nothing else. A rewriting step between the
 * tool and the reader is exactly the silent transformation this project
 * exists to avoid.
 *
 * Plain ESM JavaScript rather than TypeScript because the action runs it with
 * the runner's bare `node` and must not depend on a build step, a loader, or
 * the consumer's setup-node version. It is still type-checked: `tsconfig.json`
 * carries `allowJs`, `checkJs`, and `action/**` in `include`, so
 * `npx tsc --noEmit` covers the JSDoc types below.
 */

/** The floor under every fence; escalation only ever adds to it. */
const MIN_FENCE = 3;

/**
 * How many lines of urtext's stderr the failure body quotes. A tail rather
 * than a head: the reason a run failed is at the end of what it printed.
 */
export const LOG_TAIL_LINES = 40;

/** The failure body's lead. Fixed copy, and the same on every failure path. */
export const FAILURE_HEADLINE = "**The review could not be produced.**";

/**
 * The failure body's closing sentence. Not optional: without it, a
 * red-flavored comment on a pull request reads as a finding, and the one
 * thing this action must never do is let a tool failure be mistaken for a
 * review result.
 */
export const FAILURE_CLOSING =
  "This says nothing about the pull request: it reports a failure of the review tool, not a finding about the change.";

/**
 * Why a review that produced findings can still end up as a failure body:
 * only the head's own disclosures can overflow a limit that removing every
 * finding does not fit under, and shortening a disclosure is the one thing
 * this pipeline will not do silently.
 */
export const DISCLOSURE_OVERFLOW_REASON =
  "the review's disclosures alone exceed the comment limit";

/** urtext's own home, the one link in the footer that is not an argument. */
const URTEXT_URL = "https://github.com/noahogbi/urtext";

/**
 * A fence one backtick longer than the longest run inside the text, never
 * shorter than MIN_FENCE — the same escalation rule `fenceFor` applies in
 * `src/report/markdown.ts`, and for the same reason: a run matching the fence
 * would close the block early, promoting the rest from quoted text to live
 * Markdown, headings and all.
 * @param {string} text
 * @returns {string}
 */
function fenceFor(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

/**
 * Inline code whose delimiter no backtick run inside it can close. The range
 * is workflow- or payload-supplied text reaching a Markdown document, so it
 * gets the same treatment an excerpt gets.
 * @param {string} text
 * @returns {string}
 */
function inlineCode(text) {
  const flat = text.replace(/\s*\r?\n\s*/g, " ");
  const ticks = fenceFor(flat);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/**
 * Every line prefixed, so nothing inside the quote can step out of it.
 * @param {string} text
 * @returns {string}
 */
function quote(text) {
  return text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

/**
 * Marks each line as structural (outside every fence) or not.
 *
 * A line matching a run of at least MIN_FENCE backticks at depth zero opens a
 * fence of that run's length, and only a line that is a run of at least that
 * many backticks and nothing else closes it. Headings are recognized only
 * outside a fence.
 *
 * This is not defensive decoration. `src/report/markdown.ts` says of excerpts
 * that they are "the one place this document quotes text an adversary can
 * author outright", and escalates its fences precisely so untrusted text
 * cannot become document structure. A truncator splitting on a bare `^### `
 * would reopen that door from the other side: an excerpt line beginning
 * `### ` would be read as a finding boundary, and a cut there would drop a
 * fence's closing line and mangle everything after it. See
 * `test/action/compose-comment.test.ts`, "is fence-aware: a `### ` line
 * inside an excerpt is not a finding boundary".
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function structural(lines) {
  /** @type {boolean[]} */
  const flags = [];
  let open = 0;
  for (const line of lines) {
    const run = /^(`{3,})/.exec(line);
    if (open === 0) {
      flags.push(true);
      if (run) open = run[1].length;
    } else {
      flags.push(false);
      if (run && run[1].length >= open && /^`{3,}\s*$/.test(line)) open = 0;
    }
  }
  return flags;
}

/**
 * @typedef {object} Section
 * @property {string} heading      The `## ` line, verbatim.
 * @property {string[]} preamble   Lines between the heading and the first finding.
 * @property {string[][]} findings Each finding's lines, `### ` first.
 * @property {number} original     How many findings this section had before any removal.
 */

/**
 * Splits a review into a head (everything before the first `## `), a sequence
 * of lens sections, and within each a sequence of finding blocks. The
 * scanner's contract is "the shapes `renderMarkdown` emits", pinned by
 * `test/action/compose-comment.test.ts`, "round-trips every real review byte
 * for byte".
 * @param {string} review
 * @returns {{ head: string[], sections: Section[] }}
 */
export function segment(review) {
  const lines = review.split("\n");
  const flags = structural(lines);
  /** @type {string[]} */
  const head = [];
  /** @type {Section[]} */
  const sections = [];
  /** @type {Section | undefined} */
  let current;
  /** @type {string[] | undefined} */
  let finding;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (flags[i] && line.startsWith("## ")) {
      if (current && finding) current.findings.push(finding);
      finding = undefined;
      current = { heading: line, preamble: [], findings: [], original: 0 };
      sections.push(current);
      continue;
    }
    if (flags[i] && current && line.startsWith("### ")) {
      if (finding) current.findings.push(finding);
      finding = [line];
      continue;
    }
    if (finding) finding.push(line);
    else if (current) current.preamble.push(line);
    else head.push(line);
  }
  if (current && finding) current.findings.push(finding);
  for (const section of sections) section.original = section.findings.length;
  return { head, sections };
}

/**
 * Drops leading and trailing blank lines from a block. The renderer joins its
 * blocks with one blank line and ends with a newline; reassembly restores
 * exactly that, so the round-trip is byte-exact.
 * @param {string[]} lines
 * @returns {string[]}
 */
function trimBlanks(lines) {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out;
}

/**
 * The inverse of `segment`. See `test/action/compose-comment.test.ts`,
 * "round-trips every real review byte for byte".
 * @param {string[]} head
 * @param {Section[]} sections
 * @returns {string}
 */
export function assemble(head, sections) {
  const chunks = [trimBlanks(head).join("\n")];
  for (const section of sections) {
    chunks.push(section.heading);
    const preamble = trimBlanks(section.preamble);
    if (preamble.length > 0) chunks.push(preamble.join("\n"));
    for (const finding of section.findings) chunks.push(trimBlanks(finding).join("\n"));
  }
  return chunks.filter((c) => c !== "").join("\n\n") + "\n";
}

/**
 * What a view emptied by truncation says instead of EMPTY_LENS_COPY.
 * "Nothing in this range matched this view" would be a lie about a view whose
 * findings this comment dropped. See `test/action/compose-comment.test.ts`,
 * "says an emptied view was emptied, and never that nothing matched it".
 * @param {number} count
 * @returns {string}
 */
export function emptiedViewCopy(count) {
  return count === 1
    ? "The one finding in this view was left out of this comment. The full report has it."
    : `All ${count} findings in this view were left out of this comment. The full report has them.`;
}

/**
 * The truncation disclosure. Every number in it is interpolated from an
 * argument — the cap in particular exists in exactly one place, `action.yml`,
 * and is never restated here or in a comment.
 * @param {number} omitted
 * @param {number} total
 * @param {number} limit
 * @param {string} runUrl
 * @param {string} [artifactUrl]
 * @returns {string}
 */
export function truncationNotice(omitted, total, limit, runUrl, artifactUrl) {
  const artifactClause = artifactUrl ? ` in the [full report](${artifactUrl}) and` : "";
  return quote(
    `**This comment is truncated.** ${omitted} of ${total} findings were left out to fit the ${limit}-character comment limit; the highest-ranked findings in each view were kept. The complete review is${artifactClause} in this [workflow run](${runUrl})'s job summary.`,
  );
}

/**
 * @param {string} runUrl
 * @param {string} [artifactUrl]
 * @returns {string}
 */
function footer(runUrl, artifactUrl) {
  const links = [`Posted by [urtext](${URTEXT_URL})`];
  if (artifactUrl) links.push(`[full report](${artifactUrl})`);
  links.push(`[workflow run](${runUrl})`);
  return `<sub>${links.join(" · ")}</sub>`;
}

/**
 * Inserts the notice into the head immediately after the scope line, among
 * the other disclosures — the surfaces' existing rule that disclosures lead.
 * Block 0 is the H1 and block 1 is the scope line, in every document
 * `renderMarkdown` emits.
 * @param {string[]} head
 * @param {string} notice
 * @returns {string[]}
 */
function withNotice(head, notice) {
  const blocks = trimBlanks(head).join("\n").split(/\n{2,}/);
  blocks.splice(Math.min(2, blocks.length), 0, notice);
  return blocks.join("\n\n").split("\n");
}

/**
 * The section to cut from: the one currently holding the most findings, ties
 * going to the later section in document order.
 *
 * Within every lens the kept findings are therefore a prefix of the model's
 * rank order, which `renderMarkdown` preserves inside each section. Across
 * lenses the drop is balanced, and the reason is specific rather than
 * aesthetic: the Markdown surface partitions findings by lens, so global rank
 * is not recoverable from the document, and cutting a plain suffix would keep
 * every low-ranked Narrative row while dropping the Effects section entirely.
 * @param {Section[]} sections
 * @returns {Section | undefined}
 */
function largest(sections) {
  /** @type {Section | undefined} */
  let best;
  for (const section of sections) {
    if (section.findings.length === 0) continue;
    if (!best || section.findings.length >= best.findings.length) best = section;
  }
  return best;
}

/**
 * @param {{ marker: string, limit: number, log: string, exitCode: number, range: string, runUrl: string, artifactUrl?: string, reason?: string }} options
 * @returns {{ body: string, omitted: number, kept: number, outcome: "failed" }}
 */
function failureBody(options) {
  const { marker, limit, log, exitCode, range, runUrl, artifactUrl, reason } = options;
  const where = inlineCode(range);
  const sentence = reason
    ? `urtext produced a review for ${where}, but ${reason}.`
    : exitCode === 0
      ? `urtext exited 0 for ${where} and printed no review.`
      : `urtext exited ${exitCode} for ${where}.`;
  const lines = log.replace(/\n+$/, "").split("\n");
  let tail = lines.slice(Math.max(0, lines.length - LOG_TAIL_LINES));
  const foot = footer(runUrl, artifactUrl);

  /** @param {string[]} kept @param {number} dropped @returns {string} */
  const render = (kept, dropped) => {
    /** @type {string[]} */
    const blocks = [`${marker}\n# urtext review`, FAILURE_HEADLINE, sentence];
    if (kept.length > 0) {
      const text = kept.join("\n");
      const fence = fenceFor(text);
      blocks.push(
        `<details><summary>What urtext reported</summary>\n\n${fence}\n${text}\n${fence}\n\n</details>`,
      );
      if (dropped > 0) {
        blocks.push(
          `${dropped} earlier line${dropped === 1 ? "" : "s"} of urtext's output ${dropped === 1 ? "was" : "were"} left out to fit the comment limit.`,
        );
      }
    }
    blocks.push(FAILURE_CLOSING, foot);
    return blocks.join("\n\n") + "\n";
  };

  let dropped = 0;
  let body = render(tail, dropped);
  // No cap in this pipeline is silent: the tail shortens and says so, and if
  // even an empty tail will not fit, the details block goes entirely rather
  // than a sentence being cut in half.
  while (body.length > limit && tail.length > 0) {
    tail = tail.slice(1);
    dropped++;
    body = render(tail, dropped);
  }
  if (body.length > limit) body = render([], 0);
  return { body, omitted: 0, kept: 0, outcome: "failed" };
}

/**
 * @typedef {object} ComposeOptions
 * @property {string} marker        First line of every body; how the upsert finds its comment.
 * @property {number} limit         Maximum body length in characters.
 * @property {string} review        The Markdown review, verbatim from `urtext --stdout md`.
 * @property {string} log           urtext's stderr, used only by the failure body.
 * @property {number} exitCode      urtext's exit code, verbatim.
 * @property {string} range         The range urtext was asked for, for the failure body.
 * @property {string} runUrl        Link to the workflow run. Always present.
 * @property {string} [artifactUrl] Link to the uploaded report, when there is one.
 */

/**
 * The marker survives the round trip by construction, not by care: every
 * branch below emits `marker + "\n"` first, and the PATCH body is produced by
 * the same function that produced the POST body. See
 * `test/action/compose-comment.test.ts`, "leads every branch with the marker,
 * satisfying the upsert's own predicate".
 * @param {ComposeOptions} options
 * @returns {{ body: string, omitted: number, kept: number, outcome: "reviewed" | "failed" }}
 */
export function composeComment(options) {
  const { marker, limit, review, log, exitCode, range, runUrl, artifactUrl } = options;
  // Exit 0 with an empty stdout is a contract violation upstream, and the
  // comment says the review could not be produced rather than posting an
  // empty one.
  if (exitCode !== 0 || review.trim() === "") {
    return failureBody({ marker, limit, log, exitCode, range, runUrl, artifactUrl });
  }

  const { head, sections } = segment(review);
  const total = sections.reduce((n, s) => n + s.original, 0);
  const foot = footer(runUrl, artifactUrl);
  let omitted = 0;

  for (;;) {
    const shownHead =
      omitted > 0
        ? withNotice(head, truncationNotice(omitted, total, limit, runUrl, artifactUrl))
        : head;
    const shown = sections.map((section) =>
      section.original > 0 && section.findings.length === 0
        ? { ...section, preamble: [emptiedViewCopy(section.original)] }
        : section,
    );
    const body = `${marker}\n${assemble(shownHead, shown)}\n${foot}\n`;
    if (body.length <= limit) {
      return { body, omitted, kept: total - omitted, outcome: "reviewed" };
    }
    const victim = largest(sections);
    if (!victim) {
      return failureBody({
        marker,
        limit,
        log,
        exitCode,
        range,
        runUrl,
        artifactUrl,
        reason: DISCLOSURE_OVERFLOW_REASON,
      });
    }
    victim.findings.pop();
    omitted++;
  }
}
```

**Glue the spec leaves open, all of it named here rather than discovered:**
- *The notice's own length is part of the budget.* The loop re-renders the whole body each iteration rather than subtracting a precomputed notice length, because the notice's character count changes with the digit count of `omitted`.
- *Singular emptied-view copy.* The spec gives the plural sentence only. `emptiedViewCopy(1)` reads "The one finding in this view was left out of this comment. The full report has it." — pluralized in the house style `review()` already uses for its dropped-claims warning, with the spec's sentence kept verbatim for every other count.
- *The failure body's reason line.* The spec gives one sentence, `` urtext exited 1 for `RANGE`. ``, which is reproduced byte for byte for the nonzero case. The zero-exit-empty-stdout case and the disclosure-overflow case get their own sentence in the same slot, because "urtext exited 0" alone would not explain either.
- *The footer on a failure body* is the same `footer()` the review body uses, so the artifact link appears when there is one. The spec's §4 example shows the no-artifact form, which is what `footer(runUrl)` produces.
- *`URTEXT_URL`* is urtext's own home page, fixed copy inside the footer exactly as the spec's §3 literal spells it. It is not forge configuration; the marker, the cap, and both variable links are arguments, which is the boundary the spec draws.

- [ ] **Step 5: Implement `action/compose-comment-bin.mjs`**

```js
/**
 * argv in, files out. Separate from the composer for the reason `src/bin.ts`
 * gives in its own comment: an am-I-the-entry-module guard is a construct
 * this repository has already been burned by twice, so this file runs
 * unconditionally and the composer beside it stays importable by a test
 * without also trying to run.
 *
 * Nothing goes to stdout. A composer that printed its result would tempt the
 * action into piping it, and a body that has passed through a shell pipeline
 * is a body whose trailing newlines are no longer the composer's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { composeComment } from "./compose-comment.mjs";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parse(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

/** @param {string} path @returns {string} */
function readOrEmpty(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A missing file is an absent document, not a crash: the composer's
    // failure branch is exactly the honest answer to "urtext wrote nothing".
    return "";
  }
}

const args = parse(process.argv.slice(2));
const result = composeComment({
  marker: args.marker,
  limit: Number.parseInt(args.limit, 10),
  review: readOrEmpty(args.review),
  log: readOrEmpty(args.log),
  exitCode: Number.parseInt(args["exit-code"], 10),
  range: args.range ?? "",
  runUrl: args["run-url"] ?? "",
  ...(args["artifact-url"] ? { artifactUrl: args["artifact-url"] } : {}),
});
writeFileSync(args["body-out"], result.body);
writeFileSync(
  args["summary-out"],
  JSON.stringify({ outcome: result.outcome, omitted: result.omitted, kept: result.kept }) + "\n",
);
```

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run test/action/compose-comment.test.ts`
Expected: PASS, every case.

Then a smoke run of the binary, which is the only part of Task 2 the unit tests do not cover:

```bash
npx tsx src/bin.ts review HEAD~1 --no-llm --stdout md > /tmp/r.md 2> /tmp/r.log
node action/compose-comment-bin.mjs --marker '<!-- urtext-review -->' --limit 65536 \
  --review /tmp/r.md --log /tmp/r.log --exit-code 0 --range HEAD~1 \
  --run-url https://example.invalid/run --body-out /tmp/body.md --summary-out /tmp/summary.json
head -1 /tmp/body.md && cat /tmp/summary.json
```

Expected: the first line of `/tmp/body.md` is the marker; `/tmp/summary.json` is one line of JSON with `outcome`, `omitted`, `kept`; the binary printed nothing at all on stdout.

- [ ] **Step 7: Mutation checks**

The three the spec names by name, plus the segmentation one. One edit each; restore after each and report the observed failing test.

1. Delete the `truncationNotice(...)` insertion (make `shownHead` always `head`). `npx vitest run test/action/compose-comment.test.ts` must fail "fits the cap and says exactly how much it left out". Restore.
2. Delete the emptied-view branch (make `shown` always `sections`). Must fail "says an emptied view was emptied, and never that nothing matched it" — the emptied section falls back to whatever preamble it had, which for a section that once held findings is nothing. Restore.
3. Delete the fence tracking: make `structural` return `lines.map(() => true)`. Must fail "is fence-aware: a `### ` line inside an excerpt is not a finding boundary". Restore.
4. Change `largest`'s comparison from `>=` to `>`, so ties go to the *earlier* section. Must fail "takes the first removal from the largest view" on a corpus with equal-sized views; if it does not, enlarge the fixture until the tie case is reachable and say so in the report — a rule whose tie-break no test reaches is not a pinned rule.

- [ ] **Step 8: Full-suite gate**

- `npx vitest run` (BARE)
- `npx tsc --noEmit` — this is the step that proves `checkJs` is really covering `action/`; if it passes with a deliberate type error planted in the composer, the `include` glob is wrong. Plant `const n: number = "x";`-equivalent JSDoc (`/** @type {number} */ const n = "x";`), confirm `tsc` reports it, remove it.
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" action/compose-comment.mjs action/compose-comment-bin.mjs tsconfig.json test/action/compose-comment.test.ts` → `0`

**Read the composer's comments once against the contract before committing.** The scan in `test/comment-contract.test.ts` covers `.ts` only, so nothing mechanical guards these two files: confirm no comment restates the cap, the tail length, or the minimum fence as a numeral, and that every invariant claim names the test that enforces it.

- [ ] **Step 9: Commit**

```bash
git add action tsconfig.json test/action/compose-comment.test.ts
git commit -m "feat(action): compose the pull request comment, capped with disclosure"
```

---

### Task 3: `action.yml`, and the boundary that keeps GitHub out of `src/`

The composite action itself, plus the two tests that can honestly be written about it: one that reads the YAML as data, and one that scans `src/` for the forge knowledge this design forbids it. **What is testable here is the action's shape, not its behavior** — `$GITHUB_OUTPUT`, `$RUNNER_TEMP`, `gh`, `jq`, the event payload, and `actions/upload-artifact` do not exist inside vitest, and no assertion in this task pretends otherwise. The wiring is verified in Task 4, against a real pull request.

**Files:**
- Create: `action.yml`
- Modify: `package.json` (one devDependency)
- Test: create `test/action/action-yml.test.ts`, `test/action/boundary.test.ts`

**Interfaces:**
- Consumes: `dist/bin.js` (built by the action's own `npm ci`), `action/compose-comment-bin.mjs` (Task 2), `gh` and `jq` from the runner.
- Produces — the inputs and outputs tables verbatim from the spec's §2:

| Input | Required | Default |
|---|---|---|
| `range` | no | `""` |
| `anthropic-api-key` | no | `""` |
| `model` | no | `""` |
| `github-token` | no | `${{ github.token }}` |
| `comment-marker` | no | `<!-- urtext-review -->` |
| `comment-limit` | no | `65536` |
| `upload-report` | no | `true` |
| `artifact-name` | no | `urtext-review` |
| `fail-on-error` | no | `false` |

| Output | Source step |
|---|---|
| `outcome` | `compose` |
| `posted` | `upsert` |
| `comment-id` | `upsert` |
| `comment-url` | `upsert` |
| `exit-code` | `urtext` |
| `omitted-findings` | `compose` |
| `report-artifact-url` | `upload` |

- [ ] **Step 1: Add the one devDependency**

```bash
npm install --save-dev yaml
```

`package.json`'s `files` array is **not** touched. `action.yml` and `action/` are consumed by `uses:`, which is a git checkout, and the spec says they "are not part of `dist` and are not published". `npm install -g github:noahogbi/urtext` installs from the git tree and is unaffected either way.

- [ ] **Step 2: Write the failing tests**

Create `test/action/action-yml.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "action.yml"), "utf8");
const action = parse(source) as {
  inputs: Record<string, { default?: unknown; description?: string }>;
  outputs: Record<string, { value: string; description?: string }>;
  runs: { using: string; steps: Array<Record<string, unknown>> };
};

const steps = action.runs.steps;
const runSteps = steps.filter((s) => typeof s.run === "string");
const ids = steps.map((s) => s.id).filter((id): id is string => typeof id === "string");
const indexOfStep = (id: string) => steps.findIndex((s) => s.id === id);

describe("action.yml", () => {
  it("is a composite action whose every run step names bash", () => {
    expect(action.runs.using).toBe("composite");
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) expect(step.shell, String(step.name)).toBe("bash");
  });

  it("declares every input it reads and reads every input it declares", () => {
    // A renamed input is the failure mode that actually happens, and it fails
    // silently at runtime as an empty string.
    const referenced = new Set(
      [...source.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    );
    for (const name of referenced) expect(action.inputs, name).toHaveProperty(name);
    for (const name of Object.keys(action.inputs)) {
      expect(referenced.has(name), `input "${name}" is declared but never read`).toBe(true);
    }
  });

  it("points every output at a step that exists", () => {
    for (const [name, out] of Object.entries(action.outputs)) {
      const match = /steps\.([A-Za-z0-9_-]+)\.outputs\./.exec(out.value);
      expect(match, `output "${name}" names no step`).not.toBeNull();
      expect(ids, `output "${name}"`).toContain(match![1]);
    }
  });

  it("never interpolates an expression into a run body", () => {
    // The injection rule of the spec's section 5, enforced mechanically
    // rather than by review: every expression value reaches a script through
    // `env:` and is read as "$VAR".
    for (const step of runSteps) {
      expect(String(step.run), `step "${String(step.name)}"`).not.toContain("${{");
    }
  });

  it("uploads before it composes and composes before it posts", () => {
    // The composer needs the artifact URL; the upsert needs the body.
    expect(indexOfStep("upload")).toBeLessThan(indexOfStep("compose"));
    expect(indexOfStep("compose")).toBeLessThan(indexOfStep("upsert"));
  });

  it("refuses pull_request_target in its first step", () => {
    expect(steps[0].id).toBe("guard");
    expect(String(steps[0].run)).toContain("pull_request_target");
  });

  it("carries the documented cap and the marker the composer's tests use", () => {
    expect(String(action.inputs["comment-limit"].default)).toBe("65536");
    expect(action.inputs["comment-marker"].default).toBe("<!-- urtext-review -->");
  });

  it("describes every input and every output, since these are its public surface", () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input.description, name).toBeTruthy();
    }
    for (const [name, out] of Object.entries(action.outputs)) {
      expect(out.description, name).toBeTruthy();
    }
  });
});
```

Create `test/action/boundary.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (extname(entry) === ".ts") out.push(full);
  }
  return out;
}

/**
 * The forge vocabulary urtext must not acquire. `src/` is a git CLI that
 * takes a range and prints a review; the cap, the marker, the links, and the
 * event payload exist only in `action.yml` and `action/`. A rule that is only
 * a paragraph is a rule that erodes.
 */
const FORGE = ["github", "GITHUB_", "pull_request", "gh api"];

/**
 * The one exemption, and it is a dialect name rather than forge knowledge:
 * `src/report/markdown.ts` describes its output as GitHub-flavored Markdown,
 * which is what the format is called. Stripped before the scan rather than
 * excused per-file, so a second occurrence anywhere still fails.
 */
const DIALECT = /GitHub-flavored/g;

describe("the src/ boundary", () => {
  it("says nothing about any forge", () => {
    for (const file of tsFilesUnder(join(root, "src"))) {
      const text = readFileSync(file, "utf8").replace(DIALECT, "");
      for (const word of FORGE) {
        expect(
          text.toLowerCase().includes(word.toLowerCase()),
          `${file} says "${word}"`,
        ).toBe(false);
      }
    }
  });

  it("would catch a planted word, so a green scan means src/ is clean", () => {
    const planted = "const url = `https://api.git" + "hub.com/repos`;";
    expect(planted.toLowerCase().includes("git" + "hub")).toBe(true);
  });
});
```

**Glue.** The spec asks for the scan without saying what to do about the one pre-existing hit: `src/report/markdown.ts` opens with "The Markdown surface, a walker over the report model — GitHub-flavored". That is the name of a Markdown dialect, not knowledge of a forge, and the file predates this design. Stripping the exact phrase before the scan keeps the rule total for every other occurrence — including a second mention of the dialect anywhere else — rather than exempting a file.

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npx vitest run test/action/`
Expected: FAIL — `ENOENT` on `action.yml` for `action-yml.test.ts`. `boundary.test.ts` should **pass** immediately; if it does not, the exemption above is wrong and the failure is a finding to report before writing any YAML.

- [ ] **Step 4: Write `action.yml`**

Every value from an expression goes through `env:` and is read as `"$VAR"`. Every step that can fail captures its own status in the shell and reports it through `$GITHUB_OUTPUT` rather than aborting the composite — because the action needs urtext's numeric exit code, which `continue-on-error` does not expose, and because these steps run under `-e` and must survive their own failure to write their outputs. (An earlier version of this sentence said composite steps do not support `continue-on-error`. They do; the one `uses:` step is guarded with it. See the correction in the design.)

```yaml
name: urtext review
description: >-
  Review this pull request's change with urtext and post the result as one
  comment, edited in place on every push. Deterministic by default.
author: noahogbi

inputs:
  range:
    description: >-
      The git range to review, passed to `urtext review` verbatim. Empty means
      the action derives <base sha>...<head sha> from the pull_request payload.
    required: false
    default: ""
  anthropic-api-key:
    description: >-
      Key for the interpretation stage, passed to the CLI as an environment
      variable and never as an argument. Empty runs --no-llm; it never fails.
    required: false
    default: ""
  model:
    description: >-
      Passed as --model when non-empty. Has no effect without
      anthropic-api-key.
    required: false
    default: ""
  github-token:
    description: "The token gh authenticates with. Needs pull-requests: write."
    required: false
    default: ${{ github.token }}
  comment-marker:
    description: >-
      The hidden marker identifying this action's comment. Change it to keep
      two independent urtext comments on one pull request.
    required: false
    default: "<!-- urtext-review -->"
  comment-limit:
    description: >-
      Maximum comment body length in characters. GitHub's own limit, carried
      as data rather than compiled into urtext.
    required: false
    default: "65536"
  upload-report:
    description: >-
      Upload the run's .urtext/ directory and the Markdown review as a build
      artifact, and link it from the comment.
    required: false
    default: "true"
  artifact-name:
    description: The name of that artifact.
    required: false
    default: urtext-review
  fail-on-error:
    description: >-
      When true, the last step exits nonzero if the review could not be
      produced or could not be posted. Default is that neither ever fails the
      workflow.
    required: false
    default: "false"

outputs:
  outcome:
    description: reviewed when urtext produced a review, failed when it did not.
    value: ${{ steps.compose.outputs.outcome }}
  posted:
    description: created, edited, or none.
    value: ${{ steps.upsert.outputs.posted }}
  comment-id:
    description: The id of the created or edited comment; empty when posted is none.
    value: ${{ steps.upsert.outputs.comment-id }}
  comment-url:
    description: The comment's html_url; empty when posted is none.
    value: ${{ steps.upsert.outputs.comment-url }}
  exit-code:
    description: urtext's own exit code, verbatim. The action interprets it; it never rewrites it.
    value: ${{ steps.urtext.outputs.exit-code }}
  omitted-findings:
    description: How many findings the character cap left out. 0 when nothing was omitted.
    value: ${{ steps.compose.outputs.omitted-findings }}
  report-artifact-url:
    description: The uploaded artifact's URL; empty when upload-report is false.
    value: ${{ steps.upload.outputs.artifact-url }}

runs:
  using: composite
  steps:
    - name: Refuse pull_request_target
      id: guard
      shell: bash
      env:
        EVENT_NAME: ${{ github.event_name }}
      run: |
        if [ "$EVENT_NAME" = "pull_request_target" ]; then
          echo "urtext does not run on pull_request_target. That trigger grants a write token and repository secrets to a workflow that then reads the head revision, and urtext parses attacker-authored TypeScript and resolves an attacker-authored tsconfig. Use pull_request." >&2
          exit 1
        fi

    - name: Resolve the range
      id: range
      if: ${{ inputs.range == '' }}
      shell: bash
      env:
        BASE_SHA: ${{ github.event.pull_request.base.sha }}
        HEAD_SHA: ${{ github.event.pull_request.head.sha }}
      run: |
        have() { git cat-file -e "$1^{commit}" 2>/dev/null; }
        if ! have "$BASE_SHA" || ! have "$HEAD_SHA"; then
          git fetch --no-tags origin "$BASE_SHA" "$HEAD_SHA" || true
        fi
        if ! have "$BASE_SHA" || ! have "$HEAD_SHA"; then
          {
            echo "resolved="
            echo "reason=urtext could not resolve this pull request's base and head commits. The likeliest cause is a shallow checkout: use actions/checkout with fetch-depth: 0, because a three-dot range asks git for the merge base first."
          } >> "$GITHUB_OUTPUT"
          exit 0
        fi
        # Three dots, not two: pull_request.base.sha is the base branch's tip
        # when the event fired, not the merge base, so base..head would report
        # every commit the base gained since the fork as a change of this pull
        # request's. base...head is what the Files Changed tab shows.
        echo "resolved=$BASE_SHA...$HEAD_SHA" >> "$GITHUB_OUTPUT"
        echo "reason=" >> "$GITHUB_OUTPUT"

    - name: Build urtext
      id: build
      shell: bash
      run: |
        set +e
        # In the action's own checkout, never the consumer's workspace:
        # nothing in the reviewed repository is installed and no script from
        # it is executed. This runs the repository's own prepare script, so
        # dist/bin.js is what an install ships.
        npm ci --prefix "$GITHUB_ACTION_PATH"
        echo "code=$?" >> "$GITHUB_OUTPUT"

    - name: Run urtext
      id: urtext
      shell: bash
      env:
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
        MODEL: ${{ inputs.model }}
        EXPLICIT_RANGE: ${{ inputs.range }}
        DERIVED_RANGE: ${{ steps.range.outputs.resolved }}
        RANGE_REASON: ${{ steps.range.outputs.reason }}
        BUILD_CODE: ${{ steps.build.outputs.code }}
      run: |
        RANGE="$EXPLICIT_RANGE"
        if [ -z "$RANGE" ]; then RANGE="$DERIVED_RANGE"; fi
        echo "range=$RANGE" >> "$GITHUB_OUTPUT"
        : > "$RUNNER_TEMP/urtext-review.md"
        : > "$RUNNER_TEMP/urtext-review.log"
        if [ -z "$RANGE" ]; then
          printf '%s\n' "$RANGE_REASON" > "$RUNNER_TEMP/urtext-review.log"
          echo "exit-code=1" >> "$GITHUB_OUTPUT"
          exit 0
        fi
        if [ "$BUILD_CODE" != "0" ]; then
          printf '%s\n' "urtext could not be built on this runner; npm ci exited $BUILD_CODE." > "$RUNNER_TEMP/urtext-review.log"
          echo "exit-code=1" >> "$GITHUB_OUTPUT"
          exit 0
        fi
        LLM_ARGS=()
        if [ -n "$ANTHROPIC_API_KEY" ]; then
          if [ -n "$MODEL" ]; then LLM_ARGS=(--model "$MODEL"); fi
        else
          LLM_ARGS=(--no-llm)
        fi
        set +e
        node "$GITHUB_ACTION_PATH/dist/bin.js" review "$RANGE" "${LLM_ARGS[@]}" --stdout md \
          > "$RUNNER_TEMP/urtext-review.md" 2> "$RUNNER_TEMP/urtext-review.log"
        code=$?
        set -e
        echo "exit-code=$code" >> "$GITHUB_OUTPUT"

    - name: Write the job summary
      shell: bash
      run: |
        # The full, untruncated review. GitHub caps the job summary at 1 MiB
        # and a larger review is cut by GitHub, not by urtext; the artifact is
        # the uncapped copy, and the action's documentation says so.
        if [ -s "$RUNNER_TEMP/urtext-review.md" ]; then
          cat "$RUNNER_TEMP/urtext-review.md" >> "$GITHUB_STEP_SUMMARY"
        fi

    - name: Upload the report
      id: upload
      if: ${{ inputs.upload-report == 'true' }}
      uses: actions/upload-artifact@v4
      with:
        name: ${{ inputs.artifact-name }}
        path: |
          .urtext/
          ${{ runner.temp }}/urtext-review.md
        if-no-files-found: ignore

    - name: Compose the comment
      id: compose
      shell: bash
      env:
        MARKER: ${{ inputs.comment-marker }}
        LIMIT: ${{ inputs.comment-limit }}
        EXIT_CODE: ${{ steps.urtext.outputs.exit-code }}
        RANGE: ${{ steps.urtext.outputs.range }}
        RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        ARTIFACT_URL: ${{ steps.upload.outputs.artifact-url }}
      run: |
        node "$GITHUB_ACTION_PATH/action/compose-comment-bin.mjs" \
          --marker "$MARKER" \
          --limit "$LIMIT" \
          --review "$RUNNER_TEMP/urtext-review.md" \
          --log "$RUNNER_TEMP/urtext-review.log" \
          --exit-code "$EXIT_CODE" \
          --range "$RANGE" \
          --run-url "$RUN_URL" \
          --artifact-url "$ARTIFACT_URL" \
          --body-out "$RUNNER_TEMP/urtext-comment.md" \
          --summary-out "$RUNNER_TEMP/urtext-summary.json"
        {
          echo "outcome=$(jq -r '.outcome' "$RUNNER_TEMP/urtext-summary.json")"
          echo "omitted-findings=$(jq -r '.omitted' "$RUNNER_TEMP/urtext-summary.json")"
        } >> "$GITHUB_OUTPUT"

    - name: Upsert the comment
      id: upsert
      shell: bash
      env:
        GH_TOKEN: ${{ inputs.github-token }}
        GH_REPO: ${{ github.repository }}
        PR_NUMBER: ${{ github.event.pull_request.number }}
        MARKER: ${{ inputs.comment-marker }}
      run: |
        # --paginate without --jq so gh emits a stream of page arrays, and a
        # real jq with --arg so the marker is data rather than text spliced
        # into a filter. startswith, not contains: the marker is the first
        # line of every body this action writes, so it matches exactly those
        # and not a human comment quoting the marker while discussing it.
        # Never matched on author: a repository that swaps github.token for an
        # App token must not thereby orphan its own comment.
        id="$(gh api --paginate "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
              | jq -r --arg m "$MARKER" '.[] | select(.body | startswith($m)) | .id' \
              | head -n 1)"
        # jq -Rs is the only correct form for arbitrary review text: backticks,
        # quotes, backslashes, and control characters all appear in excerpts.
        jq -Rs '{body: .}' < "$RUNNER_TEMP/urtext-comment.md" > "$RUNNER_TEMP/urtext-comment.json"
        set +e
        if [ -n "$id" ]; then
          response="$(gh api -X PATCH "repos/$GH_REPO/issues/comments/$id" \
                      --input "$RUNNER_TEMP/urtext-comment.json" 2> "$RUNNER_TEMP/urtext-post.log")"
          action=edited
        else
          response="$(gh api -X POST "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
                      --input "$RUNNER_TEMP/urtext-comment.json" 2> "$RUNNER_TEMP/urtext-post.log")"
          action=created
        fi
        post_code=$?
        set -e
        if [ "$post_code" != "0" ]; then
          echo "::warning::urtext could not post its review (the workflow's token may be read-only, which is the case on pull requests from forks). The full review is in this run's job summary."
          cat "$RUNNER_TEMP/urtext-post.log" >&2
          {
            echo "posted=none"
            echo "comment-id="
            echo "comment-url="
          } >> "$GITHUB_OUTPUT"
          exit 0
        fi
        {
          echo "posted=$action"
          echo "comment-id=$(printf '%s' "$response" | jq -r '.id')"
          echo "comment-url=$(printf '%s' "$response" | jq -r '.html_url')"
        } >> "$GITHUB_OUTPUT"

    - name: Report
      shell: bash
      env:
        FAIL_ON_ERROR: ${{ inputs.fail-on-error }}
        OUTCOME: ${{ steps.compose.outputs.outcome }}
        POSTED: ${{ steps.upsert.outputs.posted }}
      run: |
        # The comment is posted first and the failure happens last, so a red
        # run still carries its explanation.
        if [ "$FAIL_ON_ERROR" = "true" ] && { [ "$OUTCOME" = "failed" ] || [ "$POSTED" = "none" ]; }; then
          echo "urtext: outcome=$OUTCOME, posted=$POSTED, and fail-on-error is true." >&2
          exit 1
        fi
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/action/`
Expected: PASS, every case in both new files, and `compose-comment.test.ts` still green.

- [ ] **Step 6: Mutation checks**

1. Rename the `comment-marker` input to `marker` in the `inputs:` block only. `npx vitest run test/action/action-yml.test.ts` must fail "declares every input it reads and reads every input it declares". Restore.
2. Replace `"$MARKER"` inside the upsert's `run` body with `${{ inputs.comment-marker }}` and delete the corresponding `env:` line. Must fail "never interpolates an expression into a run body" — and note that this is precisely the change a reviewer would wave through. Restore.
3. Move the `upload` step below `compose`. Must fail "uploads before it composes and composes before it posts". Restore.

- [ ] **Step 7: Full-suite gate**

- `npx vitest run` (BARE)
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" action.yml package.json test/action/action-yml.test.ts test/action/boundary.test.ts` → `0`

Also confirm `package-lock.json` moved and carries `yaml` under dev only, and that `package.json`'s `dependencies` block is byte-identical to what it was.

- [ ] **Step 8: Commit**

```bash
git add action.yml package.json package-lock.json test/action/action-yml.test.ts test/action/boundary.test.ts
git commit -m "feat(action): a composite action that posts the review on a pull request"
```

---

### Task 4: Dogfooding, documentation, and the acceptance run that only a real pull request can perform

The workflow this repository runs on itself, the README's "In CI" section, and the eight-item checklist. **Nothing in this task is verifiable in vitest.** The only way to know the action works is to open a pull request against `master` in this repository and watch what appears on it.

**Files:**
- Create: `.github/workflows/urtext-review.yml`
- Modify: `README.md`
- Unchanged, deliberately: `.github/workflows/ci.yml`

**Interfaces:** none new. The workflow references `./`, which resolves to the root `action.yml` from Task 3, so there is exactly one action definition and this repository tests the same file everybody else consumes.

- [ ] **Step 1: Write the dogfooding workflow**

Create `.github/workflows/urtext-review.yml`, transcribed from the spec's §6:

```yaml
name: urtext review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # base...head asks git for the merge base, which a shallow clone
          # cannot compute.
          fetch-depth: 0
      - uses: ./
        with:
          # The opposite of the default, and only here: this is the one
          # repository for which a urtext failure is a defect in the thing
          # under test rather than noise on somebody's pull request.
          fail-on-error: true
```

A separate file rather than a job inside `ci.yml`, for four reasons each of which would be a defect there: `ci.yml` is a two-OS matrix and would post twice or race itself editing one comment; `ci.yml` also runs on `push: branches: [master]`, where there is no pull request to comment on; `ci.yml` is the gate a branch protection rule points at and must stay a pass/fail statement about tests; and `uses: ./` needs `fetch-depth: 0`, which `ci.yml` deliberately does not do.

**`.github/workflows/ci.yml` is not edited.** Confirm with `git diff --stat` before committing that it does not appear.

- [ ] **Step 2: Write the README section**

Add an "In CI" subsection at the end of the existing `## Install` section, before `## Layout`. Nothing in the existing copy changes.

````markdown
### In CI

`action.yml` at this repository's root is a composite GitHub Action that reviews a
pull request and posts the result as one comment, edited in place on every push:

```yaml
name: urtext review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # base...head needs the merge base, which a shallow clone lacks
      - uses: noahogbi/urtext@v1
```

The `permissions:` block sits at the job level, not the workflow level, so adopting
this does not widen the token for a repository's other jobs. `issues: write` is not
required.

By default the review is deterministic: with no key, the action passes `--no-llm`,
and the comment says so in urtext's own words. One line turns the model on:

```yaml
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

An undefined secret expands to the empty string, so that line degrades to
deterministic on its own rather than failing.

The action never fails a pull request: a review that could not be produced is posted
as a comment saying so, not as a red check. `fail-on-error: true` opts into the
opposite.

**Fork pull requests cannot be commented on.** On a `pull_request` run whose head is
a fork, `GITHUB_TOKEN` is read-only regardless of the `permissions:` block and
repository secrets are unavailable, so the post fails with HTTP 403; the action emits
a warning, sets `posted: none`, leaves the full review in the job summary and in the
uploaded artifact, and stays green. No configuration changes this — a personal access
token does not help either, because secrets are not exposed to fork-PR runs. The
known-safe pattern is a two-workflow split: a `pull_request` workflow runs the review
and uploads the artifact this action already produces, and a `workflow_run` workflow —
which runs from the base branch with a write token and never checks out head code —
downloads it and posts. Shipping that second half is a deliberate follow-up.

**`pull_request_target` is refused.** The action fails its first step on that trigger,
on purpose: it grants a write token and secrets to a workflow that then reads the head
revision, and urtext parses attacker-authored TypeScript.

The job summary carries the full, untruncated review. GitHub caps a job summary at
1 MiB and a larger review is cut by GitHub, not by urtext; the uploaded artifact is
the uncapped copy. If the comment itself exceeds `comment-limit`, whole findings are
removed and the comment says how many and where the rest are.

Every input, output, and default is documented in `action.yml`.
````

And in the `## Layout` list, two entries after `src/cli.ts`:

```markdown
- `action.yml` — the composite GitHub Action that reviews a pull request
- `action/` — the action's comment composer, plain ESM run by the runner's `node`
```

- [ ] **Step 3: Local gate — the only part of this task vitest can check**

- `npx vitest run` (BARE) — the whole suite, unchanged by this task.
- `npx tsc --noEmit`
- `npx vitest run test/comment-contract.test.ts`
- `node -e "require('node:fs').readFileSync('.github/workflows/urtext-review.yml','utf8')"` and parse it with the `yaml` devDependency to confirm it is valid YAML — there is no test for this workflow, and a syntax error in it is silent until a pull request is opened.
- `git diff --stat` must not list `.github/workflows/ci.yml`.
- `python -c "import sys;print(sum(open(f,'rb').read().count(b'\x00') for f in sys.argv[1:]))" .github/workflows/urtext-review.yml README.md` → `0`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/urtext-review.yml README.md
git commit -m "feat(action): dogfood the review workflow and document it"
```

- [ ] **Step 5: The acceptance run — a real pull request, and there is no substitute**

**This step cannot be performed by any test in this repository.** A composite GitHub Action has no runner inside vitest: `$GITHUB_OUTPUT`, `$RUNNER_TEMP`, `gh`, the event payload, `actions/upload-artifact`, and above all the token semantics do not exist there. Task 3's tests checked the shape of the YAML; this is the only step that checks whether it works.

**The controller may run this rather than the implementer** — it needs push access to `noahogbi/urtext` and, for items 7 and 8, a fork and a deliberately misconfigured workflow. If the implementer cannot open a pull request, they stop here, say so plainly, and hand the checklist back rather than marking it done.

What to do, concretely:

1. Push the branch carrying Tasks 1–4 and open a pull request against `master`.
2. Watch the `urtext review` workflow run. When it finishes, record each item below with the comment URL or the run URL as evidence.
3. Iterate on `action.yml` by pushing to the same branch: every push re-runs the workflow and edits the same comment, which is item 2's check and the debugging loop at the same time. Expect several rounds — shell quoting, `$GITHUB_OUTPUT` multi-line values, and `actions/upload-artifact`'s path globbing are the usual first failures, and none of them are visible before a real run.
4. Record the results in the pull request that adds the action, as the spec requires.

The checklist, verbatim from the spec's Testing section:

- [ ] 1. A pull request with findings gets **exactly one** comment, and its range matches the Files Changed tab.
- [ ] 2. A second push **edits that comment** — the comment count on the pull request stays at one, and the comment's `updated_at` moves.
- [ ] 3. A pull request with no findings still gets a comment, in the shape the spec's §3 spells out (scope line, partial-review banner, three lenses each carrying `EMPTY_LENS_COPY`, footer).
- [ ] 4. A run forced to fail (`range: nonexistent..HEAD`) posts the failure comment, and with `fail-on-error: false` the step is **green**.
- [ ] 5. The artifact uploads and the comment's `full report` link resolves to it.
- [ ] 6. A truncated comment: lower `comment-limit` on a test branch until the cap bites, and confirm the notice is present with the right counts and every kept finding is whole. (Constructible on demand precisely because the cap is an input and not a constant.)
- [ ] 7. **Needs a fork.** A fork pull request produces the `::warning::`, `posted: none`, a green step, and a job summary carrying the full review. Schedule it: fork the repository to a second account, push a branch there, open the pull request.
- [ ] 8. **Needs a deliberately misconfigured workflow.** A workflow using `pull_request_target` fails the step with the refusal message. Add it on a throwaway branch, confirm the failure, delete the branch.

Items 1–6 are reproducible by anyone. **Items 7 and 8 are scheduled here rather than left to be skipped quietly** — if they are not run, the pull request says so explicitly and the controller decides whether to merge without them.

- [ ] **Step 6: Tag `v1` only after the checklist is green**

`uses: noahogbi/urtext@v1` resolves to whatever `v1` points at. Do not create or move that tag until items 1–6 are recorded green; a broken `v1` is a broken action for every consumer at once, and this repository's own workflow uses `./` and does not depend on the tag.

---

## Self-review notes

**Spec coverage — every section to a task.**

| Spec section | Task |
|---|---|
| Purpose; The shape of the change | Global Constraints (the two refusals: no GitHub under `src/`, working-tree review untouched); Task 3 Step 4's step order |
| §1 The flag; Why `--stdout md` and not the alternatives | Task 1, Step 3 (`STDOUT_FORMATS` in `src/cli.ts`, not `write.ts`) |
| §1 What the flag does, exactly (stdout purity; empty on nonzero) | Task 1, Steps 1 and 4; mutation check 2 |
| §1 Where it lands in `review()` (both edits) | Task 1, Step 4 |
| §1 Conflicts and errors | Task 1, Step 3 (`stdoutUsageError`, the post-loop conflict check) |
| §1 `main`'s stream routing | Task 1, Step 5; ruling recorded there and below |
| §1 USAGE | Task 1, Step 3 |
| §1 Unchanged, stated explicitly | Global Constraints; Task 1 Steps 1, 6, and 8 |
| §2 Where it lives, and why the root; the `action/` split; plain ESM; type-checked | Task 2 Step 1 (tsconfig), Steps 4–5 (two files); Task 3 Step 4 (root `action.yml`) |
| §2 Inputs; Outputs; the key input as opt-in | Task 3, Step 4 and its Interfaces tables |
| §2 Range resolution (three dots, `fetch-depth: 0`, the verify-fetch-fail sequence) | Task 3, Step 4 (`range` step); Task 4 Step 1 and Step 2 (documented in the first example) |
| §2 Steps, in order; `env:` discipline; `continue-on-error` on the one `uses:` step (corrected 2026-08-25) | Task 3, Step 4; pinned by Task 3 Step 2's "never interpolates an expression into a run body" and "uploads before it composes" |
| §3 Idempotent upsert (`--paginate`, `--arg`, `startswith`, `jq -Rs`, never by author) | Task 3, Step 4 (`upsert` step); the locally testable half in Task 2 ("leads every branch with the marker"); the round trip in Task 4 item 2 |
| §3 Always posted, including zero findings; not special-cased | Task 2 ("carries a zero-findings review through the identical path"); Task 4 item 3 |
| §3 The footer | Task 2, `footer()` and "links the artifact exactly when one was given" |
| §3 The cap: segmentation, fence-awareness, removal order, disclosure, emptied views, the no-shrink fallback | Task 2, Steps 4 and 7; the four mutation checks |
| §3 The composer's interface; `compose-comment-bin.mjs` argv mapping; nothing on stdout | Task 2, Steps 4–6 |
| §4 Deterministic by default | Task 3, Step 4 (`LLM_ARGS`); Task 4 Step 2 (README) |
| §4 The action does not fail the pull request; the failure body and its four rules | Task 2 (`failureBody`, `FAILURE_CLOSING`, the log-tail shortening); Task 3 (`Report` step); Task 4 item 4 |
| §4 The exit-code table (0/non-empty, 0/empty, 1) | Task 2, `composeComment`'s first branch and its two failure tests |
| §5 Minimum workflow permissions | Task 4, Steps 1 and 2 |
| §5 `pull_request_target` is refused | Task 3 Step 4 (`guard`, first step); Task 3 Step 2 ("refuses pull_request_target in its first step"); Task 4 item 8 |
| §5 Fork pull requests: what actually happens, and what an owner can do | Task 3 Step 4 (the `::warning::` path); Task 4 Step 2 (README, including the `workflow_run` pattern); Task 4 item 7 |
| §5 Injection | Global Constraints; Task 3 Step 2's mechanical check and Step 6's mutation check 2 |
| §6 Dogfooding; the four reasons for the split; `ci.yml` unchanged | Task 4, Step 1 and Step 3's `git diff --stat` gate |
| §6 README | Task 4, Step 2 |
| Testing — the CLI side (all six bullets) | Task 1, Step 1 |
| Testing — the composer (all nine bullets and the three named mutations) | Task 2, Steps 2 and 7 |
| Testing — the action's YAML (all six bullets) | Task 3, Step 2 |
| Testing — what cannot be tested locally; the eight-item checklist; scheduling 7 and 8 | The per-task table in File Structure; Task 4, Step 5 |
| Global constraints (all six) | Global Constraints; the `src/` boundary scan is Task 3, Step 2 |
| Out of scope (inline comments, check runs, other forges, auto-fix, blocking merges, `workflow_run`, PR descriptions as intent) | appear in no task; the forge-agnostic seam is visible as `ComposeOptions`'s marker/limit/two links, and the `workflow_run` half is named in the README as a follow-up, not built |

**Placeholder scan.** No step says "similar to Task N". Every test step contains runnable code written against the harness as it actually is: `test/cli.test.ts`'s `mkCanonicalTempDir`, `gitIn`, `ISOLATION`, the shared `repo` fixture, its already-present `readFileSync`/`existsSync`/`makeFact`/`Analyzer` imports, and the `vi.mock`-with-`importOriginal` client mock the intent work added (untouched here — every new CLI case passes `noLlm: true`, so `requestClaims` is never reached). `test/action/compose-comment.test.ts` rebuilds the isolation and canonicalization helpers locally because it is a new file in a new directory, and draws its corpus from `review(..., { stdout: "md" })` — the real `renderMarkdown` over models built from real analyzer output, per the spec's requirement. `test/comment-contract.test.ts`'s `.ts`-only scan is quoted from the file itself (`extname(entry) === ".ts"`), which is why the composer's comments are called out as unguarded. Every implementation step carries either full code (`src/cli.ts`'s five edits, both `.mjs` files entire, `action.yml` entire, the workflow entire, the README block entire) or the exact spec section to transcribe plus the glue named inline. The one pre-existing `src/` hit for the boundary scan (`GitHub-flavored` in `src/report/markdown.ts:13`) was found by running the scan, not assumed away.

**Type consistency across tasks.** `StdoutFormat` is `"md"` and nothing else; `CliOptions.stdout` is `?: StdoutFormat`, never a boolean, and never `""`. `review`'s new return field is `markdown?: string` — optional, never `null`, never an empty string standing in for absence, which is what lets `streamsFor`'s `?? ""` be the single place emptiness is decided. `streamsFor` takes a structural `{ output: string; markdown?: string }` rather than `review`'s full return type, so a test can call it with a literal; `main` passes `review`'s result, which is assignable. `Exporters.md` keeps its exact signature `(model: ReportModel) => string` and is called twice from one `ReportModel` instance. The composer crosses the TypeScript boundary as JSDoc: `ComposeOptions.limit` and `.exitCode` are `number` (the bin parses both with `Number.parseInt`), `.artifactUrl` is `string | undefined` and is spread conditionally in the bin so it is absent rather than `""` — matching `composeComment`'s `artifactUrl ? ... : ...` link test. `composeComment`'s return `outcome` is the literal union `"reviewed" | "failed"`, which `action.yml` reads back through `jq -r '.outcome'` as a bare string and compares against `failed` in one place only. `segment`/`assemble` are exported solely so the test can assert the round-trip property; nothing in `action.yml` calls them. Two tasks touch `tsconfig.json` and `package.json` and they touch different keys: Task 2 adds `allowJs`/`checkJs`/`include`, Task 3 adds one devDependency, and neither touches `tsconfig.build.json`, `files`, or `dependencies`.

**Rulings surfaced for the controller.**

1. **The empty-stdout newline (Task 1, Step 5).** §1 says `main` applies its trailing-newline normalization "to whichever string lands on stdout" and also that a broken run's stdout is empty with "no extra byte either". Applied literally, the normalization writes `"\n"` for the empty string. Resolved by guarding the write on non-empty, which changes nothing on the default path (`output` is never empty) and is pinned by `streamsFor`'s third test.
2. **`yaml` and "no new dependency" (Tech Stack, Task 3 Step 1).** The spec's Global constraints say "No new runtime dependency" and, in the same breath, name `yaml` as "the single dependency this design adds", dev-only. Resolved by stating both explicitly: `dependencies` is byte-identical after this plan; `devDependencies` gains one entry used by one test.
3. **The fence-aware segmentation fixture (Task 2, Step 2).** The spec requires the segmentation test's input to come from the real renderer over real analyzer output, *and* requires an evidence excerpt containing both a triple-backtick run and a line beginning `### `. Every excerpt urtext produces is a single trimmed source line (`(lines[line - 1] ?? "").trim()` in `effects.ts`, `guards.ts`, `blast-radius.ts`, and the equivalent in `surface.ts`), so no real analyzer run can produce a fenced line that *begins* `### `. Resolved by keeping the renderer real — the document comes from the real `buildReportModel` and the real `renderMarkdown` — and choosing the excerpt text directly, which is choosing the adversary's source file rather than hand-writing Markdown; `src/report/markdown.ts` itself calls the excerpt "the one place this document quotes text an adversary can author outright". Every other composer test draws its corpus from `review(..., { stdout: "md" })` over real fixture repositories, and the byte-exact round-trip test runs over those.
4. **`package.json`'s `files` array.** The task brief flagged that `action/` must ship if the action references it. It does not need to: `uses:` resolves against a git checkout, and the spec says the composer is "not part of `dist` and … not published". `files` is therefore unchanged, and this is recorded so the omission reads as a decision rather than an oversight.
