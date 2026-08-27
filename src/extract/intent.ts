import { WORKTREE, type RevRange } from "../types.js";
import { git } from "./git.js";

/**
 * Where a stated intent came from. One member today; a `--intent` override
 * would add a second, and INTENT_SOURCE_LABEL in `../interpret/prompt.ts`
 * makes adding one a compile error until the prompt block is told how to
 * introduce it.
 */
export type IntentSource = "commits";

export interface IntentCommit {
  /** Abbreviated hash, shown so a reader of the prompt can find the commit. */
  hash: string;
  /** First line of the message. */
  subject: string;
  /** Remaining lines, trailers stripped, empty when there is no body. */
  body: string;
}

export interface Intent {
  source: IntentSource;
  /** At least one. A zero-commit range yields `undefined`, never an empty Intent. */
  commits: IntentCommit[];
  /** Commits in the range that did not fit MAX_INTENT_COMMITS. Zero when all fit. */
  omitted: number;
  /** True when the range ends at the working tree, so part of the diff is described by no message. */
  endsAtWorkingTree: boolean;
}

/**
 * The most commit messages carried into one prompt's stated-intent block.
 * Bounds prompt size on a long range, the same job MAX_FACTS does for facts;
 * see `test/extract/intent.test.ts`, "caps a long range, keeps the newest,
 * and reports the exact omitted count".
 */
export const MAX_INTENT_COMMITS = 30;

/**
 * The most code points one commit message contributes, subject and body
 * together, after trailer stripping. A single squash-merge body can otherwise
 * consume the whole block's budget and push every other message's intent out
 * of the prompt.
 */
export const MAX_INTENT_MESSAGE_CHARS = 600;

/** Appended to a message the cap cut, so no sentence merely appears to end. */
export const INTENT_TRUNCATION_MARKER = "… [message truncated]";

/** A trailer line — provenance metadata, not prose about the change. */
export const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: /;

/** The one `git log --format` string; the parser reads its separators from here too. */
export const INTENT_LOG_FORMAT = "%h%x1f%s%x1f%b%x1e";

/**
 * The unit and record separator characters INTENT_LOG_FORMAT asks git for,
 * read back out of that one constant rather than written a second time here.
 * A commit body contains newlines by definition, so a newline-delimited parse
 * is wrong on the first multi-line body it meets; a builder and a parser
 * holding private copies of the separators is the other way this goes wrong,
 * and deriving them closes it. The escapes are spelled only inside the format
 * string above and never in a comment — the comment contract's guarded set
 * includes a value the escapes are written with.
 */
const SEPARATORS = [...INTENT_LOG_FORMAT.matchAll(/%x([0-9A-Fa-f]{2})/g)].map((m) =>
  String.fromCharCode(Number.parseInt(m[1], 16)),
);
const FIELD_SEPARATOR = SEPARATORS[0];
const RECORD_SEPARATOR = SEPARATORS[SEPARATORS.length - 1];

/**
 * Removes every separator character left inside a field. git escapes nothing
 * in a commit message, so a body can hold the very characters
 * INTENT_LOG_FORMAT delimits records and fields with; the split has already
 * consumed each separator git itself wrote, so one still sitting inside a
 * field is text an author typed — text that would otherwise fabricate
 * structure the log never emitted. See `test/extract/intent.test.ts`, "keeps
 * a planted field separator from fabricating a field".
 */
function withoutSeparators(text: string): string {
  return SEPARATORS.reduce((scrubbed, separator) => scrubbed.split(separator).join(""), text);
}

/**
 * The line terminators a commit message can carry that git does not strip and
 * `intentBlock` in `../interpret/prompt.ts` does not indent: NEL (U+0085),
 * vertical tab (U+000B), form feed (U+000C), LINE SEPARATOR (U+2028), and
 * PARAGRAPH SEPARATOR (U+2029). A consumer may honor any of them as a line
 * break, so wherever the block renders field text on a line, one left in place
 * begins a fresh line with the author's words at column 0. Carriage return and
 * line feed are deliberately absent: those are the body's legitimate line
 * structure, which `intentBlock` splits on and indents, and must survive.
 * Named once here so the two collapses below cannot hold divergent copies of
 * the set.
 */
const EXOTIC_LINE_BREAKS = "\u0085\u000B\u000C\u2028\u2029";

/**
 * Collapses line breaks to spaces. A field the prompt block renders as part
 * of its own line structure — the hash and the subject, which share an
 * entry's line — must carry no break of its own: a break there would begin a
 * line with text an author wrote, outside the frame that marks the block as
 * data rather than instruction. Collapsed rather than dropped, so the words
 * stay readable on the entry they belong to. Every break a consumer may honor
 * counts, not just carriage return and line feed but every EXOTIC_LINE_BREAKS
 * member too. See `test/extract/intent.test.ts`, "never lets planted text
 * reach the start of a line in the rendered intent block" and "collapses every
 * line terminator a fabricated field may carry".
 */
function asOneLine(text: string): string {
  return text.replace(new RegExp(`[\\r\\n${EXOTIC_LINE_BREAKS}]+`, "g"), " ");
}

/**
 * Canonicalizes a body's line breaks down to a single character. A carriage
 * return — alone or as a CRLF pair — becomes a line feed: a carriage return
 * is a real line break (UAX #14), so it earns its own indented continuation
 * line rather than being dropped or left to ride mid-line. Every
 * EXOTIC_LINE_BREAKS member becomes a space: those are not a body's prose
 * structure — a body that legitimately spans lines does so on a line feed,
 * never on NEL or a separator — so a space is the honest neutralization.
 *
 * Invariant, and the whole point of the seam: after tameBodyBreaks the only
 * character in a body that any consumer treats as a line break is a line
 * feed. `intentBlock` in `../interpret/prompt.ts` splits on that one
 * character and indents each piece, so the block's idea of a break and a
 * downstream consumer's cannot disagree — the mismatch that let a break the
 * split did not recognize (a lone carriage return, an exotic terminator)
 * ride to column 0. Applied at parse time, so the invariant holds for every
 * consumer of a stored body, a future intent source included. See
 * `test/extract/intent.test.ts`, "no line-break character in a body carries
 * text to column 0".
 */
function tameBodyBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(new RegExp(`[${EXOTIC_LINE_BREAKS}]`, "g"), " ");
}

/**
 * Drops the run of trailer lines at the tail of a body, together with the
 * blank lines separating it from the prose. Trailers are provenance metadata
 * — co-authorship, sign-off, session links — and on agentic commits they are
 * frequently the majority of the body's bytes. Only the tail run goes: a
 * colon-prefixed line in the middle of a body is prose about the change and
 * stays. See `test/extract/intent.test.ts`, "strips a trailer run at the tail
 * while keeping a colon-prefixed line mid-body".
 */
function stripTrailers(body: string): string {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line.trim() === "" || TRAILER_LINE.test(line)) {
      end--;
      continue;
    }
    break;
  }
  return lines.slice(0, end).join("\n");
}

/**
 * Subject and body together, capped in code points. `String#slice` counts
 * UTF-16 units, so an astral character straddling the cut stores a lone
 * surrogate that every downstream layer then faithfully preserves — the
 * reason `truncateSignature` in `../analyze/surface.ts` counts the same way.
 * A cut message ends with INTENT_TRUNCATION_MARKER, so the model is never
 * shown a sentence that merely appears to end. A message that is empty after
 * stripping keeps its subject: a commit whose body was nothing but trailers
 * still stated an intent in its subject line. See
 * `test/extract/intent.test.ts`, "cuts a long message on a code-point
 * boundary and marks it".
 */
function capMessage(commit: IntentCommit): IntentCommit {
  const subject = [...commit.subject];
  if (subject.length >= MAX_INTENT_MESSAGE_CHARS) {
    return {
      hash: commit.hash,
      subject: subject.slice(0, MAX_INTENT_MESSAGE_CHARS).join("") + INTENT_TRUNCATION_MARKER,
      body: "",
    };
  }
  const budget = MAX_INTENT_MESSAGE_CHARS - subject.length;
  const body = [...commit.body];
  if (body.length <= budget) return commit;
  return {
    hash: commit.hash,
    subject: commit.subject,
    body: body.slice(0, budget).join("") + INTENT_TRUNCATION_MARKER,
  };
}

/**
 * Oldest first: `git log` emits newest first, and the block reads in the
 * order the change was built. See `test/extract/intent.test.ts`, "lists
 * commits oldest first, the order the change was built in".
 */
function parseIntentLog(out: string): IntentCommit[] {
  const commits: IntentCommit[] = [];
  for (const record of out.split(RECORD_SEPARATOR)) {
    // git writes a newline after each formatted record; it belongs to the
    // separator, not to the next commit's hash.
    const text = record.replace(/^\r?\n/, "");
    if (text === "") continue;
    const fields = text.split(FIELD_SEPARATOR);
    // A record short of its fields is malformed output, not a commit with an
    // empty body — dropping it is the honest reading.
    if (fields.length < 3) continue;
    // Scrubbed here, at the seam where text becomes structure: this is the
    // only place that can still tell a separator git wrote from one an
    // author typed, and every field a commit is built from passes through
    // it — the hash included.
    const body = stripTrailers(tameBodyBreaks(withoutSeparators(fields.slice(2).join(FIELD_SEPARATOR))));
    commits.push(
      capMessage({
        hash: asOneLine(withoutSeparators(fields[0])),
        subject: asOneLine(withoutSeparators(fields[1])),
        body,
      }),
    );
  }
  return commits.reverse();
}

/**
 * The stated intent for a range: the messages of the non-merge commits in it,
 * bounded by MAX_INTENT_COMMITS with the remainder counted rather than
 * hidden.
 *
 * Two invocations, both bounded. Counting by reading every message instead
 * would be one call but unbounded on a long range; a capped log plus a count
 * is bounded and exact, and both calls resolve the head the same way, so the
 * count and the messages can never describe different ranges.
 *
 * A `git()` rejection from either call returns `undefined` rather than
 * propagating — the same degradation rule the rest of the pipeline applies: a
 * review missing its intent block is a review; a review that died collecting
 * one is not. The absence then travels the ordinary disclosure path in
 * `../interpret/index.ts`, so the user is told either way. See
 * `test/extract/intent.test.ts`, "returns undefined rather than rejecting
 * when git fails".
 */
export async function collectIntent(cwd: string, range: RevRange): Promise<Intent | undefined> {
  const endsAtWorkingTree = range.to === WORKTREE;
  const head = endsAtWorkingTree ? "HEAD" : range.to;
  const span = `${range.from}..${head}`;

  let log: string;
  let total: string;
  try {
    log = await git(
      [
        "log",
        "--no-merges",
        "-n",
        String(MAX_INTENT_COMMITS),
        `--format=${INTENT_LOG_FORMAT}`,
        span,
      ],
      cwd,
    );
    total = await git(["rev-list", "--count", "--no-merges", span], cwd);
  } catch {
    return undefined;
  }

  const commits = parseIntentLog(log);
  // A range of nothing but merge commits collects nothing and takes this
  // path, which is the honest result: the merges' own messages state nothing
  // about the code, and the commits they brought in are already in the range.
  if (commits.length === 0) return undefined;

  const counted = Number.parseInt(total.trim(), 10);
  return {
    source: "commits",
    commits,
    // Truncation keeps the newest: later commits describe what the change
    // became, and later work commonly amends earlier work.
    omitted: Number.isFinite(counted) ? Math.max(counted - commits.length, 0) : 0,
    endsAtWorkingTree,
  };
}
