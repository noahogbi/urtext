import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ANALYZERS,
  citationsAnalyzer,
  makeCitationsAnalyzer,
  runAnalyzers,
} from "./analyze/index.js";
import { createContext, extract, repoRoot } from "./extract/index.js";
import { collectIntent } from "./extract/intent.js";
import { DEFAULT_MODEL, interpret } from "./interpret/index.js";
import {
  deletedFilesNote,
  deletedTypeScriptFiles,
  unanalyzedFiles,
  unanalyzedFilesNote,
} from "./report/coverage.js";
import { renderHtml } from "./report/html.js";
import { renderMarkdown } from "./report/markdown.js";
import { buildReportModel, type ReportMeta, type ReportModel } from "./report/model.js";
import { renderPdf } from "./report/pdf.js";
import { renderTerminal } from "./report/terminal.js";
import {
  EXPORT_FORMATS,
  openReport,
  shouldSuggestGitignore,
  writeExport,
  writeReport,
  type ExportFormat,
} from "./report/write.js";
import { reconcile } from "./score/reconcile.js";
import type { Analyzer } from "./types.js";

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

export interface CliOptions {
  command: string;
  range?: string;
  json: boolean;
  noLlm: boolean;
  /** Optional like `range`, not defaulted like the other flags: every
   * pre-existing caller of `review` — this CLI's own tests included —
   * predates `--open` and constructs a `CliOptions` literal without it. */
  open?: boolean;
  /**
   * The formats `--export` asked for, deduplicated, in first-mention order.
   * Optional for the same reason as `open`: pre-existing callers construct
   * `CliOptions` literals without it. Undefined and empty mean the same
   * thing — write no exports.
   */
  exportFormats?: ExportFormat[];
  /**
   * Model for the interpretation stage. Undefined means the flag was not
   * given, which `requestClaims` reads as `DEFAULT_MODEL` — the default lives
   * there, in the one place that talks to the API, rather than being copied
   * into this parser as well.
   */
  model?: string;
  /**
   * The format `--stdout` asked for. Optional for the same reason as `open`
   * and `exportFormats`: pre-existing callers construct `CliOptions`
   * literals without it. Undefined means the terminal render owns stdout, as
   * it always has.
   */
  stdout?: StdoutFormat;
  /**
   * Sweep every citation in the repository rather than only those pointing
   * into changed files. Optional like `open` and `exportFormats`: every
   * pre-existing caller constructs a `CliOptions` literal without it.
   */
  citations?: boolean;
  /**
   * git pathspecs a sweep does not scan. Repeatable rather than
   * comma-separated, unlike `--export`: a path may legitimately contain a
   * comma, and splitting on one would turn one real directory into two that
   * do not exist.
   */
  citationsExclude?: string[];
  help: boolean;
  /**
   * Report what this build is and exit. Optional like `open`, so every
   * pre-existing caller constructing a `CliOptions` literal still compiles.
   */
  version?: boolean;
}

/**
 * What this build is, for `--version`.
 *
 * A version number alone cannot answer the question that matters here. The
 * global `urtext` is very often a symlink into a checkout — `npm link`, or a
 * global install from a local path — and then the command runs whatever
 * `dist/` last held. `dist/` is gitignored, only a build regenerates it, and
 * `package.json`'s version is identical before and after a pull. The commit is
 * what distinguishes a fresh build from a stale one, so the build stamps it
 * (see `scripts/stamp-build.mjs`) and this reads it back.
 *
 * Absent when running from source under `tsx`, where nothing has been built
 * and there is no stamp to read — which is itself the honest answer, and is
 * said rather than guessed at.
 */
export function versionLine(): string {
  try {
    const path = fileURLToPath(new URL("./build-info.json", import.meta.url));
    const info = JSON.parse(readFileSync(path, "utf8")) as {
      version?: string;
      commit?: string;
      builtAt?: string;
    };
    const commit = info.commit ? ` (${info.commit})` : "";
    const built = info.builtAt ? `, built ${info.builtAt.slice(0, 10)}` : "";
    return `urtext ${info.version ?? "unknown"}${commit}${built}`;
  } catch {
    return "urtext running from source — no build stamp, so no commit to report";
  }
}

/** Exported so a test can check that it names the real default model. */
export const USAGE = `
urtext — diff review with evidence tiers

Usage:
  urtext review [<rev-range>]     Review a change (default: working tree vs
                                  merge-base with the default branch)

Options:
  --no-llm    Deterministic analysis only; no API key required. Every
              finding is [verified]; no [inferred] or [model] findings.
  --model ID  Model for the interpretation stage (default: ${DEFAULT_MODEL})
  --citations Check every path:line citation in this repository, not only the
              ones pointing into files this range touched
  --citations-exclude PATHSPEC
              Skip files matching this git pathspec while sweeping; repeatable.
              Needs --citations. What it excluded is disclosed in the review.
  --json      Emit findings as JSON
  --open      Open the written report with the platform's default handler
  --export FORMATS
              Also write the review in these formats beside the HTML report,
              sharing its name: a comma-separated list of ${EXPORT_FORMATS.join(" and ")},
              e.g. --export md,pdf
  --stdout md Write the Markdown review to stdout and nothing else; the
              terminal render and every note move to stderr. Cannot be
              combined with --json.
  --help      Show this message
  --version   Report this build's version and the commit it was built from
`;

/**
 * One wording for every way `--export` can be misused — an unknown format,
 * an empty list, a swallowed flag — so the user always sees the full list of
 * what the flag does accept, in the example-led style of the `--model`
 * errors above.
 */
function exportUsageError(problem: string): Error {
  return new Error(
    `--export ${problem}; it takes a comma-separated list of ${EXPORT_FORMATS.join(" and ")}, e.g. --export md,pdf.`,
  );
}

/**
 * Folds one `--export` value into the accumulated formats: comma lists,
 * single values, and a repeated flag all land in the same deduplicated,
 * first-mention-ordered array — a user who writes `--export md --export pdf`
 * is not making a mistake, and `--export md,md` is not asking for two files.
 */
function addExportFormats(opts: CliOptions, value: string): void {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) throw exportUsageError("got an empty format list");
  for (const part of parts) {
    if (!(EXPORT_FORMATS as readonly string[]).includes(part)) {
      throw exportUsageError(`cannot write "${part}"`);
    }
    opts.exportFormats ??= [];
    const format = part as ExportFormat;
    if (!opts.exportFormats.includes(format)) opts.exportFormats.push(format);
  }
}

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

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: "review",
    json: false,
    noLlm: false,
    open: false,
    help: false,
  };
  const positional: string[] = [];

  // Indexed rather than for-of because `--model` takes a value, and its
  // separated form (`--model ID`) has to consume the next argument. Both forms
  // are accepted: a user who writes `--model=ID` is not making a mistake.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--no-llm") opts.noLlm = true;
    else if (arg === "--open") opts.open = true;
    else if (arg === "--citations") opts.citations = true;
    else if (arg.startsWith("--citations-exclude=")) {
      const value = arg.slice("--citations-exclude=".length);
      if (!value) throw new Error("--citations-exclude needs a pathspec, e.g. --citations-exclude docs/plans.");
      (opts.citationsExclude ??= []).push(value);
    } else if (arg === "--citations-exclude") {
      const value = argv[i + 1];
      // A following flag is the next option, not this one value — the same
      // rule --model follows, and for the same reason: excluding a pathspec
      // called "--json" would silently narrow the sweep to nothing anyone
      // asked for.
      if (!value || value.startsWith("-")) {
        throw new Error("--citations-exclude needs a pathspec, e.g. --citations-exclude docs/plans.");
      }
      (opts.citationsExclude ??= []).push(value);
      i++;
    }
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--version" || arg === "-v") opts.version = true;
    else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      // An empty value is a mistake, not a request for the default: silently
      // defaulting would run a different model than the command line names.
      if (!value) throw new Error(`--model needs a model id, e.g. --model ${DEFAULT_MODEL}.`);
      opts.model = value;
    } else if (arg === "--model") {
      const value = argv[i + 1];
      // A following flag is the next option, not this one's value — `--model
      // --json` must not silently review with a model called "--json".
      if (!value || value.startsWith("-")) {
        throw new Error(`--model needs a model id, e.g. --model ${DEFAULT_MODEL}.`);
      }
      opts.model = value;
      i++;
    } else if (arg.startsWith("--export=")) {
      addExportFormats(opts, arg.slice("--export=".length));
    } else if (arg === "--export") {
      const value = argv[i + 1];
      // A following flag is the next option, not this one's value — the
      // same rule as `--model` above.
      if (!value || value.startsWith("-")) throw exportUsageError("needs a format list");
      addExportFormats(opts, value);
      i++;
    } else if (arg.startsWith("--stdout=")) {
      setStdoutFormat(opts, arg.slice("--stdout=".length));
    } else if (arg === "--stdout") {
      const value = argv[i + 1];
      // A following flag is the next option, not this one's value — the same
      // rule `--model` and `--export` already apply.
      if (!value || value.startsWith("-")) throw stdoutUsageError("needs a format");
      setStdoutFormat(opts, value);
      i++;
    } else if (arg.startsWith("-")) {
      // Falling through to the positional slot made a typo'd flag the range,
      // and the user got a raw `git diff` usage dump instead of an answer.
      throw new Error(
        `Unknown option: ${arg}. Run \`urtext --help\` for usage.`,
      );
    } else positional.push(arg);
  }

  // After the loop on purpose: `--json --stdout md` and `--stdout md --json`
  // are the same request, and a check inside the loop would only catch one
  // order. See `test/cli.test.ts`, "refuses to put two documents on one
  // stream, in either order".
  if (opts.stdout !== undefined && opts.json) {
    throw new Error(`--stdout ${opts.stdout} and --json cannot both own stdout; pick one.`);
  }

  // Checked here rather than in the loop, for the reason above: the flags can
  // arrive in either order, so only the finished options can answer it.
  //
  // Refused rather than ignored. The exclusion narrows a sweep and there is
  // no sweep to narrow, so accepting it would produce a review whose scope is
  // silently wider than the command line asked for — indistinguishable, on
  // every surface, from one where the flag worked. That is the failure this
  // analyzer's own disclosures exist to prevent, and it would be odd to ship
  // it in the flag that turns them on. See `test/cli.test.ts`, "refuses an
  // exclusion with nothing to exclude from, rather than ignoring it".
  if (opts.citationsExclude !== undefined && opts.citations !== true) {
    throw new Error(
      "--citations-exclude narrows a repository-wide citation sweep, so it needs --citations; without it there is nothing to exclude from.",
    );
  }

  // The exclusion is wrapped in git's `:(exclude)` magic for the caller, so a
  // spec that carries magic of its own would become `:(exclude):(icase)docs`
  // — where the second group is not parsed as magic and matches nothing at
  // all, silently widening the sweep past what was asked for. Refused for the
  // same reason the missing `--citations` is: a filter that quietly does
  // nothing is worse than one that fails.
  for (const spec of opts.citationsExclude ?? []) {
    if (spec.startsWith(":")) {
      throw new Error(
        `--citations-exclude takes a plain pathspec and adds the exclusion itself, so "${spec}" cannot start with ":"; write the path alone, e.g. --citations-exclude docs/plans.`,
      );
    }
  }

  if (positional.length > 0 && positional[0] === "review") positional.shift();
  if (positional.length > 0) opts.range = positional[0];

  return opts;
}

/**
 * The renderers behind `--export`, one per format. `renderPdf` keeps its
 * lazy pdfkit import internally, so carrying it in this default costs a run
 * without `--export pdf` nothing.
 */
export interface Exporters {
  md: (model: ReportModel) => string;
  pdf: (model: ReportModel) => Promise<Buffer>;
}

export async function review(
  cwd: string,
  opts: CliOptions,
  // Defaulted rather than folded into `CliOptions`: every other field here
  // is something a command-line flag sets, and this one varies in three
  // tests that control analyzer failure directly rather than by breaking a
  // real repository — see `test/cli.test.ts`, "exits non-zero when every
  // analyzer fails, even though the output says 'No findings'", "exits
  // zero when some analyzers fail but at least one still produces
  // findings", and "exits non-zero when some analyzers fail and none of
  // them, nor any other, produced a finding".
  analyzers: Analyzer[] = ANALYZERS,
  // Defaulted for the same reason as `analyzers`: the export renderers are
  // static imports a test cannot make fail from outside, and the
  // degrades-to-a-warning contract needs a failing one — see
  // `test/cli.test.ts`, "degrades a failing export to a warning, leaving
  // findings, exit code, and the other export untouched".
  exporters: Exporters = { md: renderMarkdown, pdf: renderPdf },
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
  // Anchor at the repository root so `urtext review` behaves the same from
  // any directory inside the repo; every path in play is root-relative.
  const root = await repoRoot(cwd);
  const changeset = await extract(root, opts.range);
  const ctx = createContext(root, changeset.range);
  // A failed analyzer degrades the review rather than ending it, so the
  // failure has to be said out loud — otherwise a partial review is
  // indistinguishable from a clean one.
  const warnings: string[] = [];
  // Swapped in by identity, which keeps the `analyzers` parameter's existing
  // default and every test that passes its own list working untouched: a
  // hand-built list contains no `citationsAnalyzer`, so the map is a no-op for
  // it, and the list's length — which the exit-code rule below compares
  // against — is unchanged either way.
  //
  // `onNote` is the whole reason the swap exists. An analyzer returns facts
  // and nothing else, so a citation run that hit a cap, could not read a
  // line's history, or skipped a shallow repository has no way to say so on
  // its own; without this the caps would bite in silence, which is the one
  // thing this check must never do. The channel is the same `warnings` array
  // every other shortfall uses — no new key anywhere.
  const runnable = analyzers.map((a) =>
    a === citationsAnalyzer
      ? makeCitationsAnalyzer({
          sweep: opts.citations === true,
          exclude: opts.citationsExclude ?? [],
          onNote: (note) => warnings.push(note),
        })
      : a,
  );
  let failureCount = 0;
  const facts = await runAnalyzers(changeset, ctx, runnable, (f) => {
    failureCount++;
    warnings.push(
      `the ${f.analyzer} analyzer failed, so this review is partial: ${f.message}`,
    );
  });
  // Skipped entirely under `--no-llm`: the stage will not run, so the git
  // calls would buy nothing, and `interpret` returns no `intentNote` on that
  // path anyway.
  const intent = opts.noLlm ? undefined : await collectIntent(root, changeset.range);
  const result = await interpret(changeset, facts, {
    disabled: opts.noLlm,
    model: opts.model,
    intent,
  });
  // Whatever stopped the model — the flag, a missing key, a refusal, a
  // truncated response — the review still ran on analyzer facts alone, and
  // that is exactly the "partial" case the analyzer warnings above already
  // exist to announce. One list, one rule: any reason the review fell short
  // of its full pipeline belongs in `warnings`.
  if (result.skipped) warnings.push(result.skipped);
  // The same channel as the skip note above, and for the same reason: a
  // review that could not compare the change against a stated intent fell
  // short of its full pipeline, exactly as a skipped interpretation stage
  // did. `interpret` decides the wording; this only carries it.
  if (result.intentNote) warnings.push(result.intentNote);
  // How many claim-free standalone reach rows reconcile's filter removed.
  // Not a warning — the filter ran as designed, the review is not partial —
  // but both output surfaces state it, because a single-caller change can
  // otherwise reach the report as nothing at all.
  let suppressed = 0;
  const findings = reconcile(
    facts,
    result.claims,
    (dropped) => {
      // First-claim-wins is deterministic, but the losing claims are model
      // output the reader never sees — and a review that silently discarded
      // part of what the model said is partial in exactly the sense this list
      // exists to disclose.
      warnings.push(
        `the model made ${dropped} further claim${dropped === 1 ? "" : "s"} about already-explained findings; ${dropped === 1 ? "it is" : "they are"} not shown`,
      );
    },
    (count) => {
      suppressed = count;
    },
  );

  // Two independent reasons a review has to fail loudly rather than exit
  // clean, both about the same hazard at different sizes: a report that
  // looks successful to a script when nothing trustworthy backs it.
  //
  // `allAnalyzersFailed` is unconditional on `findings` — `interpret` is not
  // skipped merely because `facts` came back empty (only `--no-llm`, a
  // missing API key, or an empty changeset skip it), so every analyzer
  // dying does not by itself stop the model from being asked and producing
  // a standalone claim, which `reconcile` still turns into a finding. A
  // model claim with no analyzer fact behind it is exactly what the "no
  // evidence" case exists to distrust — the deterministic half is the part
  // that has to work, and a review whose findings are entirely unverified
  // is not a clean review.
  //
  // `someFailedNothingShown` covers the same hazard at partial failure: a
  // script sees exit 0 and "No findings", which reads as "this range is
  // clean" when the truer reading is "some of what would have found
  // something never ran". A partial failure that still produced real
  // findings is not this case, and stays exit 0 — the findings are real and
  // the shortfall is already stated in `warnings`, so failing it would
  // throw away good output over a degradation the tool already discloses.
  const allAnalyzersFailed = analyzers.length > 0 && failureCount === analyzers.length;
  const someFailedNothingShown = failureCount > 0 && findings.length === 0;
  const exitCode = allAnalyzersFailed || someFailedNothingShown ? 1 : 0;

  // A review this broken does not get a report: the whole reason a nonzero
  // exit code exists here is that a report sitting on disk looks like a
  // successful run to anyone who only checks whether one was produced, and
  // writing one here would recreate that exact appearance under the fix
  // that was supposed to remove it.
  let reportPath: string | undefined;
  let markdown: string | undefined;
  const exportFormats = opts.exportFormats ?? [];
  const exportPaths: { md?: string; pdf?: string } = {};
  // Every model this run builds comes through here, so a new model input is
  // added once rather than in four places — which is how `citationSweep`
  // ended up threaded down each path separately, and how `renderTerminal`
  // grew a seventh positional parameter to carry it.
  //
  // `warnings` is the live array, not a copy: a model built at a later moment
  // must see what was pushed since (see the timing rule in the spec, and the
  // comments at each build site below).
  //
  // Only the two fields a later moment *learns* may be overridden. Widening
  // this to `Partial<ReportMeta>` would let one moment quietly hand a
  // different `warnings` or `citationSweep` than another, reopening inside
  // the one file meant to close it the door this whole change exists to shut.
  const metaFor = (
    over: Partial<Pick<ReportMeta, "reportPath" | "exportPaths">> = {},
  ): ReportMeta => ({
    model: result.model,
    warnings,
    suppressed,
    citationSweep: opts.citations === true,
    ...over,
  });
  if (exitCode === 0) {
    try {
      reportPath = await writeReport(
        root,
        // Moment one, and the earliest a model can honestly be built: nothing
        // has been written yet, so this one knows what the review found and
        // nothing about what became of it. A report cannot name its own
        // failure to be written, and no export exists yet to fail. The two
        // moments below know strictly more, which is why they are separate
        // builds rather than this one reused — see `test/cli.test.ts`, "keeps
        // a failure that came after the export model off the pdf built from
        // it", and the timing rule in the spec.
        //
        // `warnings` already carries `result.skipped` (pushed above, where
        // every reason a review fell short goes). Passing it separately as
        // well is what printed the skipped-stage line twice in the banner of
        // every `--no-llm` run.
        renderHtml(buildReportModel(changeset, findings, metaFor())),
      );
    } catch (err) {
      // A degraded review beats no review, the same rule `runAnalyzers`
      // already applies to a single dead analyzer above — the findings and
      // everything else this run computed are real regardless of whether
      // the report describing them made it to disk, and rejecting here
      // would discard all of it over a filesystem problem this review's
      // own content had nothing to do with.
      warnings.push(
        `could not write the report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Gated on `reportPath`, not just the exit code: the exports share the
    // HTML report's stem (see `writeExport`), so a run whose report failed
    // to write has nothing to anchor them to — and the same
    // no-report-on-broken-runs reasoning applies to every format equally.
    if (!reportPath && exportFormats.length > 0) {
      // That gate is a mechanism the user cannot see: without this line,
      // asked-for exports simply never appear, with only the report's own
      // warning printed — an output that silently fails to exist is the
      // exact opposite of what this tool is for. A second warning beside the
      // report's rather than a rewording of it, so a user who asked for no
      // exports never finds this sentence in their failure story — see
      // `test/cli.test.ts`, "discloses that requested exports were skipped
      // when the report itself could not be written".
      warnings.push(
        `could not write the ${exportFormats.join(", ")} export${exportFormats.length === 1 ? "" : "s"}: no report was written to anchor ${exportFormats.length === 1 ? "it" : "them"}`,
      );
    }
    // One model, one renderer, one string: `--stdout md` and `--export md`
    // cannot diverge. The gate widens past `reportPath` for the stream and
    // only for the stream — the export loop below keeps its own gate, because
    // the stem argument is about files pairing on disk and a stream is not a
    // file. See `test/cli.test.ts`, "gives the stream and the file
    // byte-identical Markdown from one model".
    if (exportFormats.length > 0 || opts.stdout !== undefined) {
      // Moment two, and built once: every requested export, and the stream,
      // walk this one instance. A second model rather than the one the HTML
      // above walked, because the two are built at different moments: that
      // one was assembled before the report write was attempted, this one
      // after, so these documents can carry a failure the HTML could not have
      // known about. And built here rather than inside the loop below,
      // because no export can report a failure to write itself: rebuilding
      // per format would let whichever export ran last name the earlier one's
      // failure while the earlier one stayed silent about its own, so two
      // documents of one review would disagree about what the run did.
      //
      // Both halves are pinned in `test/cli.test.ts`: "puts a failure that
      // came before the export model onto the Markdown built from it" for the
      // first, "keeps a failure that came after the export model off the pdf
      // built from it" for the second.
      const exportModel = buildReportModel(changeset, findings, metaFor());
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
          try {
            const content =
              format === "md" ? exporters.md(exportModel) : await exporters.pdf(exportModel);
            exportPaths[format] = await writeExport(reportPath, format, content);
          } catch (err) {
            // The same degradation rule as the HTML report above: an export
            // that failed to render or write costs the run that one file,
            // never the findings or the exit code.
            warnings.push(
              `could not write the ${format} export: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
  }

  if (opts.json) {
    // Built before `counts` below, which reads it: one derivation, not two.
    // The model computes exactly this tally (`buildReportModel`), and a
    // second loop over the same findings is the shape that let the finding
    // band map be derived twice and disagree.
    //
    // Built rather than recomposed, for every sentence it supplies: the model
    // is the single source of what a surface may say, and deciding here which
    // findings are citations — or tallying the tiers again — would be a second
    // copy of a rule that already exists, free to drift and drifting silently.
    //
    // Moment three, which has two build sites rather than one: this branch
    // returns, so a run reaches either this build or the terminal's below,
    // never both. Same moment either way — everything has been written or has
    // failed to be by now, so the last surface a run produces is the one that
    // can say so.
    const jsonModel = buildReportModel(changeset, findings, metaFor());
    const counts = jsonModel.counts;
    // What the analyzers did not look at, in the machine-readable output too.
    // Both renderers say it (see `deletedFilesNote`); a script reading `--json`
    // could not see it at all, which made "stated the same way on every
    // surface" false and left the one consumer that cannot read prose blind to
    // the gap. The array is always present so a consumer can test it without
    // branching on the key; the sentence is there only when there is one.
    const deleted = deletedTypeScriptFiles(changeset);
    // The other half of the same disclosure, and the half the human surfaces
    // gained first: which changed files no analyzer reported on at all. A
    // script reading this could otherwise not tell a clean file from one
    // urtext has no analyzer for, which is the distinction that decides
    // whether a model-only finding about it is worth anything.
    const unanalyzed = unanalyzedFiles(changeset, findings);
    return {
      output: JSON.stringify(
        {
          range: changeset.range,
          counts,
          findings,
          // Always present, zero included, so a consumer can test it
          // without branching on the key — the same rule as `coverage`'s
          // array below. Nonzero means reconcile's standalone-reach filter
          // removed that many claim-free low-signal rows.
          suppressed,
          // What `git diff` never showed the analyzers, by the same rule and
          // for the same reason as `suppressed` above: always present, zero
          // included. Every human surface states this through the model's
          // `notes`; this one carried no key for it at all — `warnings` holds
          // the raw analyzer strings, not that sentence, and `range` holds no
          // count — so a script could not recover "N untracked files were not
          // reviewed" by any route. The `kindNotes` gap again, found by
          // writing down why `notes` could be exempt from the model-keys
          // guard and not being able to finish the sentence; see
          // `test/cli.test.ts`, "accounts for every model field in the JSON
          // object, or exempts it by name".
          untrackedCount: changeset.untrackedCount ?? 0,
          warnings,
          coverage: {
            deletedTypeScriptFiles: deleted,
            ...(deleted.length > 0 ? { note: deletedFilesNote(deleted) } : {}),
            // Always present, empty included, by the same rule as the array
            // above it; the sentence only when there is one.
            unanalyzedFiles: unanalyzed,
            ...(unanalyzed.length > 0
              ? { unanalyzedNote: unanalyzedFilesNote(unanalyzed, changeset.files.length) }
              : {}),
          },
          // What each kind of finding means, once per kind. This text used to
          // close every body of its kind, and `findings` above carries bodies
          // verbatim — so saying it once for the review took it off this
          // surface, which had it yesterday. A consumer cannot recompose it:
          // the sentences live in the report model, not in any fact. Always
          // present, empty array included, by the same rule as `suppressed`.
          kindNotes: jsonModel.kindNotes,
          // Present exactly when `--citations` swept, following the same rule
          // as `exports` below: a consumer that asked can read the object
          // without branching, one that did not never sees a field about a
          // feature it did not use.
          //
          // `sweep` is here because it is the one thing a consumer cannot
          // derive. The distribution itself is recoverable from `findings` —
          // the `citation_rot:` prefix and each finding's `file` — unlike the
          // deleted-file coverage above, which was recoverable from nothing
          // and is why that key exists. But forty citation findings look
          // identical whether the reviewed range happened to touch them or
          // the whole repository was swept, and every honest reading of the
          // distribution depends on knowing which. The note is carried
          // beside it rather than left to be recomposed, so the sentence a
          // script reads is the sentence every other surface printed.
          ...(opts.citations === true
            ? {
                citations: {
                  sweep: true,
                  ...(jsonModel.distributionNote
                    ? { distributionNote: jsonModel.distributionNote }
                    : {}),
                },
              }
            : {}),
          model: result.model,
          skipped: result.skipped,
          reportPath,
          // Present exactly when `--export` was given — a consumer that
          // asked can test the object without branching on the key, and one
          // that did not ask never sees a field about a feature it did not
          // use. A requested export that failed (or a nonzero-exit run,
          // which writes nothing) is a missing key inside the object, with
          // the reason in `warnings`.
          ...(exportFormats.length > 0 ? { exportPaths } : {}),
        },
        null,
        2,
      ),
      exitCode,
      reportPath,
      markdown,
    };
  }

  // Only the exports that were actually written, in the order they were
  // requested: a failed one already has its warning in the notes above. The
  // walker prints one line each, under the "Full report" line and labeled
  // like every other path the model carries — this surface no longer has
  // anything appended to it after it has returned.
  //
  // Moment three, the other of its two sites (see the JSON build above). The
  // terminal is the last thing a non-JSON run produces, and the only surface
  // that knows every path this run wrote, so it is the only one that can be
  // handed them: the two moments above are earlier than the writes they would
  // have to describe.
  const written = exportFormats.flatMap((format) => {
    const path = exportPaths[format];
    return path ? [{ format, path }] : [];
  });
  let output = renderTerminal(
    buildReportModel(changeset, findings, metaFor({ reportPath, exportPaths: written })),
  );
  // Detection without action: urtext asks git whether the repository already
  // ignores `.urtext/` (see `shouldSuggestGitignore` in report/write.ts,
  // which also absorbs a git failure at this late stage — the review has
  // already succeeded) but never writes to any ignore file itself — editing
  // a file the repository's owner tracks is not this tool's call to make.
  if (reportPath && (await shouldSuggestGitignore(root))) {
    output += `  Tip: add ".urtext/" to this repository's .gitignore — review reports otherwise show up as untracked files.\n`;
  }

  return { output, exitCode, reportPath, markdown };
}

/**
 * Acts on `--open`. `openReport` ignores an absent path, which is right for it
 * and wrong as the whole behavior: a user who asked for the report to be
 * opened and gets no window is owed the reason. There are two — the review
 * failed hard enough that no report is written, and the write itself failed —
 * and the output above states whichever applies, so this points at that rather
 * than guessing which one it was.
 *
 * Separate from `main` because `main` reads `process.argv` and writes to the
 * real stderr, so neither branch could be reached from a test through it. See
 * `test/cli.test.ts`, "--open".
 */
export function openOrExplain(
  reportPath: string | undefined,
  onMessage: (message: string) => void,
  open: (path: string) => void = openReport,
): void {
  if (reportPath) {
    open(reportPath);
    return;
  }
  onMessage("urtext: --open had nothing to open; no report was written (see the notes above).\n");
}

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

export async function main(): Promise<void> {
  try {
    // Inside the try: argument parsing now rejects unknown flags, and that
    // message deserves the same one-line treatment as any other failure.
    const opts = parseArgs(process.argv.slice(2));
    if (opts.version) {
      process.stdout.write(versionLine() + "\n");
      return;
    }
    if (opts.help) {
      process.stdout.write(USAGE);
      return;
    }
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
  } catch (err) {
    process.stderr.write(
      `urtext: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
