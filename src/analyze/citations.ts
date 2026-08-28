import ts from "typescript";
import { git } from "../extract/git.js";
import { isTypeScriptFile } from "../extract/symbols.js";
import {
  REPORT_DIR,
  WORKTREE,
  type AnalysisContext,
  type Analyzer,
  type Changeset,
  type EvidenceRef,
  type Fact,
} from "../types.js";
import { makeFact, MAX_EVIDENCE } from "./fact.js";

/**
 * A repository-relative path followed by a line, or a line range. The path
 * must contain at least one directory separator — see
 * CITATION_GUARD_SEPARATOR in the design's false-positive guards for why a
 * bare `Something.js:14` is not treated as a citation at all.
 *
 * Left to right: a lookbehind rejecting a preceding path character, so a
 * match cannot start in the middle of a longer path; one or more `segment/`
 * groups, which is what makes the separator mandatory; a final segment with
 * a dot and an alphanumeric extension; a colon; a line number with no
 * leading zero; optionally a hyphen and an end line; and a lookahead
 * rejecting a trailing digit, letter, underscore, slash, or hyphen, so a
 * citation is not matched inside a longer line number or a longer path.
 * Capture groups: path, start line, end line or undefined.
 *
 * A trailing period is not rejected, so a citation ending a sentence is
 * extracted like any other — see `test/analyze/citations.test.ts`,
 * "extracts a citation a sentence's closing period touches, in both forms".
 */
export const LINE_CITATION =
  /(?<![A-Za-z0-9_@./-])((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*):([1-9][0-9]*)(?:-([1-9][0-9]*))?(?![0-9A-Za-z_/-])/g;

/**
 * A backticked repository-relative path, then a quoted phrase — urtext's own
 * comment-contract form, and the most checkable citation form in the
 * repository, because the quoted text either appears in the named file or it
 * does not. The same mandatory-separator path, inside backticks; an optional
 * comma, semicolon, or colon; a short run of whitespace; then a straight or
 * left curly double quote, the phrase, and a straight or right curly close.
 * Capture groups: path, phrase.
 */
export const QUOTED_CITATION =
  /`((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z][A-Za-z0-9]*)`[,;:]?\s{0,3}["“]([^"”]+)["”]/g;

/**
 * The most code points a quoted phrase, or a stored was/now line, carries.
 * Longer than this is a block quotation rather than a pointer.
 */
export const MAX_QUOTE_CHARS = 240;

/** Appended to a was/now line the cap cut, so no line merely appears to end. */
export const CITATION_TRUNCATION_MARKER = "… [line truncated]";

/** Tracked files scanned as raw text, after masking. */
export const PROSE_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

/**
 * The pathspecs the candidate-file queries in this file's scan half pass to
 * git. Narrower than `isTypeScriptFile` accepts — it also takes the
 * module-explicit extensions, which no pathspec here names — so a citation
 * written in one of those files is not checked at all. An under-report, the
 * direction every approximation in this feature leans.
 */
export const CITATION_PATHSPECS = ["*.md", "*.markdown", "*.txt", "*.ts", "*.tsx"] as const;

export type CitationForm = "line" | "quote";

export interface Citation {
  form: CitationForm;
  /** The path exactly as the prose spelled it, before any resolution. */
  path: string;
  /** Form A only: the cited start line, and the end line for a range. */
  line?: number;
  endLine?: number;
  /** Form B only: the quoted phrase, already normalized. */
  quote?: string;
  /** One-based line in the citing file where `path` sits. */
  citingLine: number;
  /** That line's text, trimmed, for the fact's anchor evidence. */
  citingText: string;
}

/**
 * Every whitespace run, newlines included, collapsed to a single space, then
 * trimmed. Matching and comparison both run on normalized text, and the
 * cited file is normalized identically before a containment test. Without
 * this, every comment-contract citation in `src/` would fail: they wrap
 * across continuation lines, so the phrase as written carries newlines and
 * asterisks the cited file never had.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Replaces every character of a span with a space, keeping newlines. Length
 * is preserved exactly, which is the whole point: every offset computed
 * after a mask still names the same character of the original text, so a
 * masked fence cannot move a later citation's reported line. See
 * `test/analyze/citations.test.ts`, "keeps every offset, so masking never
 * moves a later citation's line".
 */
function blankSpan(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

const FENCE_LINE = /^(?: {0,3}>[ \t]?)* {0,3}(`{3,}|~{3,})/;

/**
 * CITATION_GUARD_FENCE. Spans from a line opening a fence through the next
 * line closing that fence — same character, at least as long a run —
 * inclusive, are blanked. A path and line inside a fence is sample output,
 * and treating sample output as an assertion about the repository is the
 * most common false positive available. An unclosed fence blanks to the end
 * of the text: silence about a run of prose costs less than a finding built
 * on a code block nobody closed. Indented blocks are deliberately not
 * masked — they are indistinguishable from list continuations in this
 * repository's prose, and the baseline gate already covers the illustrative
 * ones. A blockquote prefix on the fence line is tolerated: a fence inside a
 * quotation is still a fence, and the indent allowance alone cannot see past
 * the marker. See `test/analyze/citations.test.ts`, "CITATION_GUARD_FENCE: a
 * citation inside a fenced block is not one, and the same text outside it
 * is" and "CITATION_GUARD_FENCE: a fenced block inside a blockquote is masked
 * like any other".
 */
export function maskFences(text: string): string {
  const lines = text.split("\n");
  let open: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_LINE.exec(lines[i]);
    if (open === undefined) {
      if (fence) {
        open = fence[1];
        lines[i] = blankSpan(lines[i]);
      }
      continue;
    }
    const closes = fence !== null && fence[1][0] === open[0] && fence[1].length >= open.length;
    lines[i] = blankSpan(lines[i]);
    if (closes) open = undefined;
  }
  return lines.join("\n");
}

const URL_SPAN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const LINK_DESTINATION = /\]\([^)]*\)/g;

/**
 * CITATION_GUARD_URL. A link to another host is a link to another host, and
 * its path-and-line tail says nothing about this repository. The regexes'
 * lookbehind is a second line of defense, not a substitute: masking is what
 * makes the intent explicit and testable.
 */
export function maskUrls(text: string): string {
  return text.replace(URL_SPAN, blankSpan).replace(LINK_DESTINATION, blankSpan);
}

export function isProseFile(path: string): boolean {
  return PROSE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

/** Absolute offset of the start of every line, for offset-to-line lookup. */
function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineOfOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function textOfLine(source: string, starts: number[], line: number): string {
  const start = starts[line - 1];
  const end = starts[line] === undefined ? source.length : starts[line] - 1;
  return source.slice(start, end).replace(/\r$/, "").trim();
}

/**
 * Runs both forms over `haystack` and reports each hit against `source`,
 * which is the file as written. `toSource` maps a haystack index back to an
 * absolute source offset: it is the identity for prose, where masking
 * preserves length, and the unwrap's offset map for comments, where it is
 * not.
 *
 * The two post-match rules for Form B live here rather than in the pattern
 * so their reasons stay readable. A parsed line number that is not a safe
 * integer is discarded rather than checked, because `Number` would silently
 * round a numeral too long to be a line into one that looks checkable.
 */
function matchCitations(
  haystack: string,
  toSource: (index: number) => number,
  source: string,
): Citation[] {
  const starts = lineStartsOf(source);
  const out: Citation[] = [];

  const push = (index: number, parts: Omit<Citation, "citingLine" | "citingText">): void => {
    const citingLine = lineOfOffset(starts, toSource(index));
    out.push({ ...parts, citingLine, citingText: textOfLine(source, starts, citingLine) });
  };

  for (const m of haystack.matchAll(LINE_CITATION)) {
    const line = Number.parseInt(m[2], 10);
    const endLine = m[3] === undefined ? undefined : Number.parseInt(m[3], 10);
    if (!Number.isSafeInteger(line)) continue;
    if (endLine !== undefined && !Number.isSafeInteger(endLine)) continue;
    push(
      m.index,
      endLine === undefined
        ? { form: "line", path: m[1], line }
        : { form: "line", path: m[1], line, endLine },
    );
  }

  for (const m of haystack.matchAll(QUOTED_CITATION)) {
    const quote = normalizeText(m[2]);
    // The phrase must contain whitespace: a single quoted word is prose
    // emphasis far more often than a citation, and one word is too weak a
    // needle to conclude anything from. Counted with the spread for the
    // reason `truncateSignature` in `./surface.ts` documents.
    if (!/\s/.test(quote)) continue;
    if ([...quote].length > MAX_QUOTE_CHARS) continue;
    push(m.index, { form: "quote", path: m[1], quote });
  }

  return out.sort(
    (a, b) =>
      a.citingLine - b.citingLine || a.path.localeCompare(b.path) || a.form.localeCompare(b.form),
  );
}

export function citationsInProse(text: string): Citation[] {
  return matchCitations(maskUrls(maskFences(text)), (index) => index, text);
}

interface CommentSpan {
  /** Absolute offset of the comment's first character. */
  start: number;
  text: string;
}

/**
 * Every comment in a file, walked off the parsed AST's leaf tokens.
 *
 * This is a deliberate second copy of the walk `test/comment-contract.test.ts`
 * documents at length, and the design names the duplication so a reviewer
 * does not treat it as an oversight: a plan that wants one copy should hoist
 * it into a shared module and update both call sites in the same change, not
 * import test code into `src/`. The reasons the walk has this shape are
 * recorded there in full; the short version is that a raw scanner loop
 * desynchronizes on the first template interpolation, and this codebase's
 * comments sit beside plenty of those, while a leading-only pass silently
 * misses every comment on the same line as the token before it. Two
 * different leaves can share a position — a zero-width node ends exactly
 * where the next token starts — so hits are deduplicated by range start.
 */
function commentSpans(source: string, fileName: string): CommentSpan[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const spans: CommentSpan[] = [];
  const seen = new Set<number>();

  const record = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      spans.push({ start: range.pos, text: source.slice(range.pos, range.end) });
    }
  };

  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      record(ts.getLeadingCommentRanges(source, node.getFullStart()));
      record(ts.getTrailingCommentRanges(source, node.getEnd()));
      return;
    }
    children.forEach(visit);
  };
  visit(sourceFile);
  return spans.sort((a, b) => a.start - b.start);
}

interface Unwrapped {
  /** The comment's body as one logical string, decorations removed. */
  text: string;
  /** Absolute source offset of every logical index, same length as `text`. */
  offsets: number[];
}

/**
 * Strips a comment's opening, closing, and continuation decorations and
 * joins its lines with single spaces, carrying an offset map alongside.
 * The citing line reported in evidence is derived from that map, so a
 * quoted citation whose phrase wraps across several comment lines is
 * reported at the line its path actually sits on — see
 * `test/analyze/citations.test.ts`, "reports the line the path sits on for a
 * quote that wrapped across comment lines". A naive "line of the comment's
 * start" would misreport every wrapped citation in `src/`, which are most of
 * them.
 */
function unwrapComment(span: CommentSpan): Unwrapped {
  const chars: string[] = [];
  const offsets: number[] = [];
  let lineStart = span.start;

  span.text.split("\n").forEach((line, index) => {
    let from = 0;
    let to = line.length;
    if (to > from && line[to - 1] === "\r") to--;
    while (from < to && (line[from] === " " || line[from] === "\t")) from++;
    // The close is stripped before the opens, so a line that is nothing but
    // a closing decoration contributes no stray character.
    if (to - from >= 2 && line.slice(to - 2, to) === "*/") to -= 2;
    if (line.startsWith("//", from)) from += 2;
    else if (line.startsWith("/*", from)) {
      from += 2;
      if (line[from] === "*") from++;
    } else if (line[from] === "*") from++;

    if (index > 0) {
      chars.push(" ");
      offsets.push(lineStart + Math.min(from, to));
    }
    for (let k = from; k < to; k++) {
      chars.push(line[k]);
      offsets.push(lineStart + k);
    }
    lineStart += line.length + 1;
  });

  return { text: chars.join(""), offsets };
}

/**
 * Comments only. A path and line inside a string literal is usually a test
 * fixture's expected output, and inside code it is not prose making a claim.
 * Fences are not masked here — a fence is a prose construct — but URLs are,
 * for the same reason they are in prose.
 */
export function citationsInComments(source: string, fileName: string): Citation[] {
  const out: Citation[] = [];
  for (const span of commentSpans(source, fileName)) {
    const { text, offsets } = unwrapComment(span);
    out.push(...matchCitations(maskUrls(text), (index) => offsets[index] ?? span.start, source));
  }
  return out.sort((a, b) => a.citingLine - b.citingLine || a.path.localeCompare(b.path));
}

/** Every citation in one file, scanned the way that file's kind is scanned. */
export function citationsIn(path: string, text: string): Citation[] {
  if (isProseFile(path)) return citationsInProse(text);
  if (isTypeScriptFile(path)) return citationsInComments(text, path);
  return [];
}

/**
 * The most citations one run checks, across both modes. Bounds a sweep of a
 * repository whose prose cites code everywhere; the default mode is already
 * bounded by the change and reaches this only on a very large diff. A cap
 * that bites is disclosed — see `citationsCappedNote`.
 */
export const MAX_CITATIONS_CHECKED = 2000;

/**
 * The most citing files one run opens. Bounds the blame calls, which are the
 * expensive per-file work; the citation cap above bounds the per-citation
 * work. Files are taken in path order so a capped run is deterministic.
 */
export const MAX_CITING_FILES = 320;

/**
 * The most distinct (revision, cited file) pairs one run reads historically.
 * A repository whose prose cites a hundred files from a hundred different
 * baseline commits would otherwise pay a `git show` per pair with no bound
 * at all; every citation past this is checked existence-only and said so.
 */
export const MAX_BASELINE_READS = 480;

/**
 * The most basenames passed to one `git grep` invocation. Terms are chunked
 * at this width and the results unioned, so unlike the caps above this one
 * loses nothing and discloses nothing.
 */
export const MAX_GREP_TERMS = 96;

/**
 * Pluralized inline in the style `review` in `../cli.ts` already uses, and
 * phrased as reasons so they read alongside the existing warnings. They land
 * in `warnings`, which becomes `ReportModel.notes`, which trips the "This
 * review is partial." banner — correctly. A capped run genuinely did not
 * check everything it was asked to.
 */
export function citingFilesCappedNote(scanned: number, found: number): string {
  const left = found - scanned;
  // The leftover count carries its own noun rather than trailing a bare
  // numeral. A leftover of exactly one is reachable — the cap bites the
  // moment one more candidate exists than it scans — and a numeral with
  // nothing to agree with is this sentence saying less than it means to.
  //
  // Where the scan stopped is named because the selection is a prefix, not a
  // sample: `sweepCandidates` sorts by path and this cap takes the front of
  // that list, so a bitten cap cuts mid-directory. Measured on a large
  // repository, the earlier wording reported a fraction that read as though
  // it were spread across the tree, while the run had in fact covered nearly
  // every file under one leading directory and a small minority of the
  // source. A true count that leaves a false impression costs a reader
  // exactly what a false count would, so the sentence says which files it
  // means. See `test/analyze/citations-rot.test.ts`, "discloses a bitten
  // citing-file cap with counts that add up, over the prefix of the path
  // order it really scanned".
  return `citation checking scanned the first ${scanned} of ${found} candidate files in path order, so citations in the other ${left} file${left === 1 ? "" : "s"} were not checked; the scan stops at that point in the path order rather than spreading across this repository`;
}

export function citationsCappedNote(checked: number, found: number): string {
  const left = found - checked;
  // The same prefix the file cap takes, one level down: `pending` is built
  // over the scanned files in path order and, inside each file, in citing-line
  // order, and this cap keeps the front of that list. A bitten cap therefore
  // stops partway along the path order — and may stop partway through a single
  // file — rather than sampling the repository. Said out loud for the reason
  // `citingFilesCappedNote` above says it, and because two cap notes that
  // answer the same question differently are worse than either alone: a reader
  // who learns what the first sentence means reads the second as meaning it
  // too. See `test/analyze/citations-rot.test.ts`, "names the prefix the
  // citation cap took, and enumerates citations in exactly that order".
  return `citation checking stopped after the first ${checked} of ${found} citations in path order, so ${left} further citation${left === 1 ? "" : "s"} in this repository ${left === 1 ? "was" : "were"} not checked; the check stops at that point in the path order rather than spreading across this repository`;
}

/**
 * No order clause, unlike the two caps above, and the difference is in what
 * this sentence claims rather than in how its budget is spent. The budget is
 * spent front to back like theirs — a citation is refused a historical read
 * only once the distinct-pair allowance is gone, so the ones that degrade are
 * the later ones in the same path order, minus any whose baseline pair had
 * already been read. But this note states no fraction and no share of the
 * repository: every citation it counts was checked, and the sentence says
 * exactly how far that check went. There is no coverage claim here for an
 * order to qualify, so the clause the caps carry would attach to a sentence
 * that never said it had covered anything.
 */
export function baselineReadsCappedNote(unchecked: number): string {
  return `citation checking stopped reading historical file contents, so ${unchecked} citation${unchecked === 1 ? "" : "s"} ${unchecked === 1 ? "was" : "were"} checked only for whether the cited file exists`;
}

/**
 * Copy for a shallow repository, where blame answers but cannot be believed.
 * Phrased as a skip rather than a partial check, because that is what it is.
 */
export function shallowRepositoryNote(): string {
  return "citation checking was skipped: this repository is a shallow clone, so the commit that last wrote each citing line cannot be known";
}

/** Copy for citations whose history could not be read. */
export function blameUnavailableNote(count: number, reason: string): string {
  return `${count} citation${count === 1 ? "" : "s"} could not be dated (git blame failed: ${reason}), so ${count === 1 ? "it was" : "they were"} checked only for whether the cited file exists`;
}

export type RotKind = "missing_file" | "line_out_of_range" | "quote_absent" | "content_drift";

export interface CitationRot {
  rot: RotKind;
  citingFile: string;
  citingLine: number;
  citingText: string;
  /** The resolved cited path, not the path as written. */
  citedFile: string;
  citedLine?: number;
  /**
   * The citation's end line, for a range. Absent on `content_drift`, whose
   * `citedLine` is the one line that actually differs rather than the
   * range's start: pairing this end with that start would print a span the
   * prose never wrote. What the prose did write is carried whole in
   * `writtenLine`/`writtenEndLine` below.
   */
  citedEndLine?: number;
  /**
   * `content_drift` only: the citation exactly as the prose wrote it. Carried
   * apart from `citedLine`, which on a drift names the one line whose content
   * differs, because a drift finding has to say both things and must never
   * mix them. The title and body name this pair — it is the string a reader
   * searches their own document for, and the text they will edit — while the
   * evidence points at the line that actually moved. Separate fields, so no
   * sentence can compose a span out of one number from each.
   *
   * On the other three rot kinds `citedLine`/`citedEndLine` already are the
   * citation as written, and these stay absent.
   */
  writtenLine?: number;
  writtenEndLine?: number;
  quote?: string;
  /** content_drift only: the first differing line, both sides, truncated. */
  was?: string;
  now?: string;
  /** Abbreviated baseline commit. Absent means history could not be read. */
  baseline?: string;
  /** line_out_of_range only: the cited file's line count at this revision. */
  lineCount?: number;
  /** The cited line's current text, when the file and line exist now. */
  citedText?: string;
  /** True when the reviewed range touched `citedFile`. Proven, not inferred. */
  citedTouched: boolean;
}

export interface CitationScanOptions {
  /**
   * Check every citation in the repository rather than only those pointing
   * into files the reviewed range touched. Set by `--citations`.
   */
  sweep?: boolean;
  /**
   * git pathspecs whose files a sweep does not scan, from
   * `--citations-exclude`. Meaningless without `sweep`: the default mode is
   * already scoped to the reviewed change, and narrowing it further would be
   * narrowing something the caller did not choose to widen.
   *
   * The motivating case is a repository whose citation mass sits in dated
   * planning documents — true findings about prose nobody maintains, which
   * drown the ones in code that someone would act on. urtext cannot tell an
   * archived document from a live one; only its author can, which is why
   * this is an input rather than a heuristic.
   */
  exclude?: readonly string[];
  /**
   * Called once per cap that bit and once for unreadable history, with the
   * sentence the user is owed. An analyzer returns facts and nothing else, so
   * this is the only channel a disclosure has; `review` in `../cli.ts` passes
   * one that pushes into `warnings`. A caller that passes none gets the facts
   * and no indication anything was skipped — the same contract, and the same
   * hazard, as `runAnalyzers`'s `onFailure`.
   */
  onNote?: (note: string) => void;
}

/**
 * The name the design gives this option bag where the analyzer takes it, and
 * an alias rather than a second declaration on purpose: one field list cannot
 * drift against itself, and the scan half of this module already documents
 * every field above.
 */
export type CitationsOptions = CitationScanOptions;

/**
 * A blame line's porcelain header: the commit, the line in the original
 * file, the line in the final file, and — only on the first line of a run —
 * how many lines the run covers. The parse keeps one thing, a map from final
 * line to commit; every other header and the tab-prefixed content are
 * skipped. See `test/analyze/citations-rot.test.ts`, "keeps one commit per
 * final line from --line-porcelain output".
 */
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

export function parseBlame(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) map.set(Number.parseInt(m[2], 10), m[1]);
  }
  return map;
}

/** An uncommitted line blames to the all-zeros commit. */
const UNCOMMITTED = /^0+$/;

/**
 * `git grep` exits one when nothing matches. That rejection is an absence,
 * not a failure — it is read as "no candidate files", exactly as `readAt`
 * reads git's absence wording as null — and it is told apart from a real
 * failure by the pair of things git guarantees for it: the exit status, and
 * an empty stderr. Anything else travels the degradation path.
 */
function isNoMatch(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const stderr = (err as { stderr?: unknown }).stderr;
  return code === 1 && typeof stderr === "string" && stderr.trim() === "";
}

/**
 * The reason git printed, not the command that failed. `git()` rejects with
 * execFile's error, whose `message` is a command dump — the whole argument
 * list, revision hashes and all — and whose `stderr` carries what git
 * actually said. This reason is composed into a user-facing partial-review
 * note, so the stderr line wins; the message is the fallback for a rejection
 * that carries no stderr at all.
 */
function reasonOf(err: unknown): string {
  const stderr = err instanceof Error ? (err as { stderr?: unknown }).stderr : undefined;
  const text =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr
      : err instanceof Error
        ? err.message
        : String(err);
  return text.trim().split("\n")[0].trim();
}

/**
 * A revision and a path as one memo key. Joined by a unit separator rather
 * than concatenated, so no pair can spell the same key as a different pair.
 */
function revPathKey(rev: string, path: string): string {
  return `${rev}\u001F${path}`;
}

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  // A file ending in a newline splits to a trailing empty element that is
  // not a line of the file; counting it would put every last-line citation
  // one short of the end.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.replace(/\r$/, ""));
}

/**
 * Both sides of a was/now pair are truncated for storage and rendering, with
 * CITATION_TRUNCATION_MARKER appended when the cut runs, so no line merely
 * appears to end. Counted by code point for the reason `truncateSignature`
 * in `./surface.ts` documents.
 */
function truncateLine(text: string): string {
  const points = [...text];
  if (points.length <= MAX_QUOTE_CHARS) return text;
  return points.slice(0, MAX_QUOTE_CHARS).join("") + CITATION_TRUNCATION_MARKER;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export async function findCitationRot(
  changeset: Changeset,
  ctx: AnalysisContext,
  options: CitationScanOptions = {},
): Promise<CitationRot[]> {
  const now = changeset.range.to;
  const cwd = ctx.cwd;
  const note = options.onNote;

  // A shallow clone is the one repository shape where blame is worse than
  // unavailable: `--root` is exactly what suppresses git's boundary marker,
  // so a line older than the graft is attributed to the graft commit rather
  // than reported as unknown. At depth one that makes the baseline and the
  // reviewed revision the same commit, every gate compares a thing to
  // itself, and citation checking becomes a silent no-op; deeper, a finding
  // states a boundary commit as "when this line was last written", which is
  // a historical claim the repository does not carry. A disclosed skip is
  // the only honest answer, and it is the whole check rather than a
  // degradation of it.
  if ((await git(["rev-parse", "--is-shallow-repository"], cwd)).trim() === "true") {
    note?.(shallowRepositoryNote());
    return [];
  }

  // Every path the range touched, both sides, so a rename is covered on
  // both. This is the default mode's whole filter, and it is what bounds
  // cost by the change rather than by the repository.
  const touched = new Set<string>();
  for (const file of changeset.files) {
    touched.add(file.path);
    if (file.previousPath) touched.add(file.previousPath);
  }

  // One read per revision-and-path pair. `readAt` is a `git show` per call
  // and is not memoized upstream; memoizing here is what turns many
  // citations into one file at one baseline commit into one read.
  const reads = new Map<string, Promise<string | null>>();
  const historical = new Set<string>();
  let baselineReadsRefused = 0;
  const readAt = (rev: string, path: string): Promise<string | null> => {
    const key = revPathKey(rev, path);
    let read = reads.get(key);
    if (!read) {
      read = ctx.readAt(rev, path);
      read.catch(() => reads.delete(key));
      reads.set(key, read);
    }
    return read;
  };
  /** A historical read, refused once the distinct-pair budget is spent. */
  const readHistorical = (rev: string, path: string): Promise<string | null> | undefined => {
    const key = revPathKey(rev, path);
    if (!historical.has(key)) {
      if (historical.size >= MAX_BASELINE_READS) return undefined;
      historical.add(key);
    }
    return readAt(rev, path);
  };

  // One blame per citing file, never per citation. A file with forty
  // citations costs one blame. A resolved null is a blame that failed, and
  // its reason travels beside it.
  const blames = new Map<string, Promise<Map<number, string> | null>>();
  let blameReason: string | undefined;
  const blameOf = (path: string): Promise<Map<number, string> | null> => {
    let blame = blames.get(path);
    if (!blame) {
      const args = ["blame", "--line-porcelain", "--root"];
      if (now !== WORKTREE) args.push(now);
      blame = git([...args, "--", path], cwd)
        .then(parseBlame)
        .catch((err: unknown) => {
          blameReason ??= reasonOf(err);
          return null;
        });
      blames.set(path, blame);
    }
    return blame;
  };

  // An exclusion that removed nothing is not disclosed. Silence therefore
  // means the pathspec did not bite — which is the signal a reader needs to
  // notice they mistyped one, and it is only trustworthy if the note never
  // fires for a filter that changed no result.
  const exclude = options.sweep ? (options.exclude ?? []) : [];
  const candidates = options.sweep
    ? await sweepCandidates(cwd, exclude)
    : await touchedCandidates(cwd, now, touched);
  if (exclude.length > 0) {
    const unfiltered = await sweepCandidates(cwd);
    const dropped = unfiltered.length - candidates.length;
    if (dropped > 0) note?.(citationsExcludedNote(exclude, dropped));
  }
  if (candidates.length === 0) return [];

  const scanned = candidates.slice(0, MAX_CITING_FILES);
  if (scanned.length < candidates.length) {
    note?.(citingFilesCappedNote(scanned.length, candidates.length));
  }

  // Extraction first, across every scanned file, because the citation cap's
  // sentence states how many were found as well as how many were checked —
  // and extraction costs no git at all.
  const pending: Array<{ file: string; citation: Citation }> = [];
  for (const file of scanned) {
    const text = await readAt(now, file);
    if (text === null) continue;
    for (const citation of citationsIn(file, text)) pending.push({ file, citation });
  }

  const checking = pending.slice(0, MAX_CITATIONS_CHECKED);
  if (checking.length < pending.length) {
    note?.(citationsCappedNote(checking.length, pending.length));
  }

  const rots: CitationRot[] = [];
  let undated = 0;

  for (const { file, citation } of checking) {
    const blame = await blameOf(file);
    const baseline = blame?.get(citation.citingLine);
    // An uncommitted citing line is as new as the change under review:
    // there is no earlier state to compare against, all four tests are
    // skipped, and nothing is disclosed, because nothing was lost.
    if (blame !== null && (baseline === undefined || UNCOMMITTED.test(baseline))) continue;
    if (blame === null) undated++;

    const rot = await checkCitation({
      file,
      citation,
      baseline: blame === null ? undefined : baseline,
      now,
      touched,
      sweep: options.sweep === true,
      readAt,
      readHistorical,
      onRefusedBaseline: () => {
        baselineReadsRefused++;
      },
    });
    if (rot) rots.push(rot);
  }

  if (undated > 0) note?.(blameUnavailableNote(undated, blameReason ?? "unknown reason"));
  if (baselineReadsRefused > 0) note?.(baselineReadsCappedNote(baselineReadsRefused));

  return rots;
}

/**
 * Sweep candidates: every tracked file the pathspecs admit, minus
 * REPORT_DIR. urtext's own reports quote source lines by path and line by
 * construction; scanning them would make every review generate citations
 * that the next review reports as rotted. Sorted, so a capped run takes the
 * same files twice.
 *
 * `ls-files` lists the index rather than a revision, which is safe because
 * every candidate is then read through `readAt` at the reviewed revision: a
 * file absent there yields null and is skipped.
 */
async function sweepCandidates(cwd: string, exclude: readonly string[] = []): Promise<string[]> {
  // Exclusions are git's own pathspec magic, passed through untouched: the
  // caller writes what they would write for any other git command, and git
  // decides what matches. A glob dialect of our own would be one more thing
  // to get subtly wrong, and wrong here means silently omitting findings
  // that are true.
  const excludes = exclude.map((spec) => `:(exclude)${spec}`);
  const out = await git(["ls-files", "-z", "--", ...CITATION_PATHSPECS, ...excludes], cwd);
  return out
    .split("\0")
    .filter((path) => path !== "" && !path.startsWith(`${REPORT_DIR}/`))
    .sort();
}

/**
 * Copy for a sweep the caller narrowed.
 *
 * Names the pathspecs, not merely a count. An exclusion filters findings that
 * would otherwise be reported as true, and a reader told only that something
 * was dropped cannot tell a deliberate scope from a mistyped pathspec that
 * matched more than they meant. The cap notes above were corrected twice for
 * exactly that gap — a true count beside a false impression — and this
 * sentence is written already knowing it. See
 * `test/analyze/citations-rot.test.ts`, "discloses what it excluded by name,
 * not merely that something was".
 */
export function citationsExcludedNote(specs: readonly string[], dropped: number): string {
  const list = specs.map((s) => `\`${s}\``).join(", ");
  const files = `${dropped} candidate file${dropped === 1 ? "" : "s"}`;
  return `citation checking excluded ${files} matching ${list}, so citations in ${dropped === 1 ? "it" : "them"} were not checked`;
}

/**
 * Default-mode candidates: files git can prove mention one of the changed
 * files' basenames. Basenames rather than full paths, because prose cites a
 * file by many spellings and the resolution rules decide what a path means;
 * the full-path filter is applied after extraction, on resolved paths, where
 * it is exact. Terms are chunked at MAX_GREP_TERMS per invocation and the
 * results unioned — chunking loses nothing, so unlike the caps it needs no
 * disclosure.
 */
async function touchedCandidates(
  cwd: string,
  now: string,
  touched: Set<string>,
): Promise<string[]> {
  const basenames = [...new Set([...touched].map((path) => path.split("/").pop() ?? path))].sort();
  if (basenames.length === 0) return [];
  const found = new Set<string>();
  for (let i = 0; i < basenames.length; i += MAX_GREP_TERMS) {
    const terms = basenames.slice(i, i + MAX_GREP_TERMS).flatMap((name) => ["-e", name]);
    const args = ["grep", "-I", "-l", "-F", ...terms];
    if (now !== WORKTREE) args.push(now);
    let out: string;
    try {
      out = await git([...args, "--", ...CITATION_PATHSPECS], cwd);
    } catch (err) {
      if (isNoMatch(err)) continue;
      throw err;
    }
    for (const line of out.split("\n")) {
      // With a revision argument git prefixes each path with `<rev>:`.
      const path = now === WORKTREE ? line : line.slice(line.indexOf(":") + 1);
      if (path !== "" && !path.startsWith(`${REPORT_DIR}/`)) found.add(path);
    }
  }
  return [...found].sort();
}

/**
 * The four tests, in order, first one wins. A missing file has no lines to
 * be out of range and no content to have drifted, so emitting more than one
 * fact for one citation would be one finding said four ways.
 *
 * Which tests a citation is eligible for follows from its form and no other
 * rule: missing_file applies to both forms; line_out_of_range and
 * content_drift to the path-and-line form only, since they need a line
 * number; quote_absent to the quoted form only, since it needs a phrase. A
 * form is never checked by a test it has no input for.
 *
 * With no baseline — blame failed, or the historical-read budget is spent —
 * only the first test runs, ungated, against the reviewed revision. That is
 * the one place a false positive is reachable, and it is disclosed in the
 * same breath by `blameUnavailableNote` or `baselineReadsCappedNote`.
 */
async function checkCitation(args: {
  file: string;
  citation: Citation;
  baseline: string | undefined;
  now: string;
  touched: Set<string>;
  sweep: boolean;
  readAt: (rev: string, path: string) => Promise<string | null>;
  readHistorical: (rev: string, path: string) => Promise<string | null> | undefined;
  onRefusedBaseline: () => void;
}): Promise<CitationRot | undefined> {
  const { file, citation, baseline, now, touched, sweep, readAt, readHistorical } = args;
  const isProse = isProseFile(file);

  // Repository-root-relative first, which is how every path in this codebase
  // is spelled and how `git show <rev>:<path>` resolves; then relative to
  // the citing file's own directory, for prose only. A comment in `src/x.ts`
  // that names `report/model.ts` means the repository path, and resolving it
  // against `src/` would invent a file.
  const spellings = [normalizePath(citation.path)];
  if (isProse && dirOf(file) !== "") {
    spellings.push(normalizePath(`${dirOf(file)}/${citation.path}`));
  }

  const optional = {
    ...(citation.line === undefined ? {} : { citedLine: citation.line }),
    ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
    ...(citation.quote === undefined ? {} : { quote: citation.quote }),
  };

  let citedFile: string | undefined;
  let baselineText: string | null = null;
  let refused = false;
  if (baseline !== undefined) {
    for (const spelling of spellings) {
      const read = readHistorical(baseline, spelling);
      if (read === undefined) {
        refused = true;
        break;
      }
      const text = await read;
      if (text !== null) {
        citedFile = spelling;
        baselineText = text;
        break;
      }
    }
  }

  if (baseline === undefined || refused) {
    if (refused) args.onRefusedBaseline();
    // Existence-only: resolve against the reviewed revision, since there is
    // no baseline to resolve against, and carry no commit, since none was
    // read. The path reported is the root-relative spelling, which is the
    // one a reader will look for.
    for (const spelling of spellings) {
      if ((await readAt(now, spelling)) !== null) return undefined;
    }
    const absent = spellings[0];
    const absentTouched = touched.has(absent);
    // The default mode's filter still binds when history does not: a
    // shallow clone is the common case for it, and a review that named
    // files the change never touched would be answering a question nobody
    // asked, under a verified badge.
    if (!sweep && !absentTouched) return undefined;
    return {
      rot: "missing_file",
      citingFile: file,
      citingLine: citation.citingLine,
      citingText: citation.citingText,
      citedFile: absent,
      ...optional,
      citedTouched: absentTouched,
    };
  }

  // Resolved neither way at the baseline: the citation never resolved, and
  // urtext cannot tell a typo from an illustration from a plan for a file
  // that does not exist yet. It says nothing.
  if (citedFile === undefined || baselineText === null) return undefined;

  // The default mode's exact filter, applied on the resolved path.
  const citedTouched = touched.has(citedFile);
  if (!sweep && !citedTouched) return undefined;

  const common = {
    citingFile: file,
    citingLine: citation.citingLine,
    citingText: citation.citingText,
    citedFile,
    baseline,
    citedTouched,
  };

  const nowText = await readAt(now, citedFile);
  if (nowText === null) {
    return { rot: "missing_file", ...common, ...optional };
  }

  const baseLines = linesOf(baselineText);
  const nowLines = linesOf(nowText);

  if (citation.line !== undefined) {
    const last = citation.endLine ?? citation.line;
    // Gate: a citation to a line the file never had is a typo, not rot.
    if (citation.line > baseLines.length || last > baseLines.length) return undefined;
    if (citation.line > nowLines.length || last > nowLines.length) {
      return {
        rot: "line_out_of_range",
        ...common,
        citedLine: citation.line,
        ...(citation.endLine === undefined ? {} : { citedEndLine: citation.endLine }),
        lineCount: nowLines.length,
      };
    }
  }

  if (citation.quote !== undefined) {
    // Containment, not equality, and normalization on both sides, so
    // re-wrapping a source comment does not fire this and a genuine
    // rewording does.
    if (!normalizeText(baselineText).includes(citation.quote)) return undefined;
    if (!normalizeText(nowText).includes(citation.quote)) {
      return { rot: "quote_absent", ...common, quote: citation.quote };
    }
    return undefined;
  }

  if (citation.line !== undefined) {
    const last = citation.endLine ?? citation.line;
    for (let n = citation.line; n <= last; n++) {
      // Compared with leading and trailing whitespace stripped per line: a
      // pure re-indent moves no content, and reporting it would be noise a
      // reader cannot act on. For a range, the first differing line is the
      // one reported.
      const was = baseLines[n - 1] ?? "";
      const current = nowLines[n - 1] ?? "";
      if (was.trim() === current.trim()) continue;
      return {
        rot: "content_drift",
        ...common,
        // The line that differs, not the range's first line. `was`, `now`,
        // and `citedText` are all this line's text, and a fact whose line
        // number and quoted text disagreed would send a reader to a line
        // that reads nothing like the one the finding shows it. See
        // `citedEndLine` for why no range is carried alongside.
        citedLine: n,
        // And the citation as the prose wrote it, whole and unmixed, so the
        // finding can name the string the reader will search for without
        // that string ever being assembled out of two different lines.
        writtenLine: citation.line,
        ...(citation.endLine === undefined ? {} : { writtenEndLine: citation.endLine }),
        was: truncateLine(was.trim()),
        now: truncateLine(current.trim()),
        // The cited line as it currently stands, taken from text already in
        // hand so the analyzer composing `evidence[1]` never reads it again.
        citedText: current.trim(),
      };
    }
  }

  return undefined;
}

/**
 * Leading characters of a commit object name kept for display. The finding
 * body names this commit to a reader, and a full object name there is noise
 * beside a sentence; git's own short form is the length a reader recognizes.
 */
const ABBREVIATED_HASH = 7;

function abbreviate(hash: string): string {
  return hash.slice(0, ABBREVIATED_HASH);
}

/**
 * Returns its analyzer under a name it states outright, and that is
 * load-bearing: `runAnalyzers` reports a failed analyzer by
 * `analyzers[i].name` in a warning a user reads, and an arrow returned
 * directly from a factory has no name at all, so a citation analyzer that
 * threw would be disclosed as a numbered anonymous one.
 *
 * The other analyzers get their names for free, from NamedEvaluation of the
 * variable declaration they are assigned to. That mechanism is not enough
 * here. This binding sits one scope in and shadows the module-level
 * singleton below, and a transform that renames shadowed symbols to keep
 * every binding unique — esbuild, which is what runs this repository's tests
 * — rewrites the binding, and the inferred name goes with it, turning the
 * disclosed name into a near-miss of itself. So the name is written down
 * rather than derived. See `test/analyze/citations-rot.test.ts`, "names
 * itself when it throws, so the disclosure never says analyzer #N".
 */
export function makeCitationsAnalyzer(options: CitationsOptions = {}): Analyzer {
  const citationsAnalyzer: Analyzer = async (changeset, ctx): Promise<Fact[]> => {
    const rots = await findCitationRot(changeset, ctx, options);
    return rots.map((rot) => {
      // evidence[0] is the citing line, so Fact.file/Fact.line land on the
      // prose the reader has to fix. evidence[1], when the cited file and
      // line exist now, is the cited location as it currently stands — the
      // "now" half of a drift, shown rather than asserted. The baseline
      // content is deliberately never an EvidenceRef: `side` distinguishes
      // the before and after sides of the reviewed range, and the baseline
      // is some other commit entirely. It lives in `detail.was` and in the
      // finding body, where the commit that produced it is named beside it.
      const evidence: EvidenceRef[] = [
        {
          file: rot.citingFile,
          line: rot.citingLine,
          excerpt: rot.citingText,
          side: "after",
        },
      ];
      // A drift onto an empty line has a cited location and nothing to quote
      // at it. The ref is dropped rather than pushed with an empty excerpt:
      // every surface renders a ref as its location followed by its text, so
      // an empty one is a row that shows the reader nothing and reads as a
      // renderer that failed rather than as the blank line it is. The
      // blankness is not lost — `toFinding` states it in words, from
      // `detail.now`, which carries it exactly. See `src/score/index.ts`,
      // "A line urtext read as empty is something it knows".
      if (rot.citedLine !== undefined && rot.citedText !== undefined && rot.citedText !== "") {
        evidence.push({
          file: rot.citedFile,
          line: rot.citedLine,
          excerpt: rot.citedText,
          side: "after",
        });
      }
      return makeFact({
        // The kind and a colon, which is the convention `subjectOf` in
        // `../report/model.ts` recovers the lens from. The citing location
        // plus the rot kind is the identity: one citing line can carry two
        // citations, and both may rot. `qualifiedSymbol` is omitted — a
        // citation is about a file and a line, not a symbol.
        id: `citation_rot:${rot.citingFile}:${rot.citingLine}:${rot.rot}`,
        kind: "citation_rot",
        detail: {
          rot: rot.rot,
          citedFile: rot.citedFile,
          ...(rot.citedLine === undefined ? {} : { citedLine: rot.citedLine }),
          ...(rot.citedEndLine === undefined ? {} : { citedEndLine: rot.citedEndLine }),
          ...(rot.writtenLine === undefined ? {} : { writtenLine: rot.writtenLine }),
          ...(rot.writtenEndLine === undefined ? {} : { writtenEndLine: rot.writtenEndLine }),
          ...(rot.quote === undefined ? {} : { quote: rot.quote }),
          ...(rot.was === undefined ? {} : { was: rot.was }),
          ...(rot.now === undefined ? {} : { now: rot.now }),
          ...(rot.baseline === undefined ? {} : { baseline: abbreviate(rot.baseline) }),
          ...(rot.lineCount === undefined ? {} : { lineCount: rot.lineCount }),
          citedTouched: rot.citedTouched,
        },
        // Shared with the analyzers that sample evidence, so the cap cannot
        // drift between them, though a citation fact never has more than two
        // refs today.
        evidence: evidence.slice(0, MAX_EVIDENCE),
      });
    });
  };
  Object.defineProperty(citationsAnalyzer, "name", { value: "citationsAnalyzer" });
  return citationsAnalyzer;
}

/**
 * The default-mode instance, and the member of ANALYZERS. Also the identity
 * `review` matches on when it swaps in a configured instance, so it must stay
 * a single shared value rather than being reconstructed per call.
 */
export const citationsAnalyzer: Analyzer = makeCitationsAnalyzer();
