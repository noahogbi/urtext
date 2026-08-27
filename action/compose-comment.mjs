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

/** The floor under every block fence; escalation only ever adds to it. */
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
 * The longest run of backticks anywhere in the text, zero when there is none.
 * Shared by the two delimiters below so neither can escalate by a different
 * rule than the other.
 * @param {string} text
 * @returns {number}
 */
function longestBacktickRun(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

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
  return "`".repeat(Math.max(MIN_FENCE, longestBacktickRun(text) + 1));
}

/**
 * Inline code whose delimiter no backtick run inside it can close. The range
 * is workflow- or payload-supplied text reaching a Markdown document, so it
 * gets the same escalation an excerpt gets — but not MIN_FENCE's floor, which
 * belongs to block fences alone: an inline span is closed by whatever run
 * opened it, so one backtick past the longest run inside is already
 * unclosable, and the spec's failure sentence spells an ordinary range in
 * single backticks. See `test/action/compose-comment.test.ts`, "reports a
 * nonzero exit with the range, the code, and the stderr tail".
 * @param {string} text
 * @returns {string}
 */
function inlineCode(text) {
  const flat = text.replace(/\s*\r?\n\s*/g, " ");
  const ticks = "`".repeat(longestBacktickRun(flat) + 1);
  // A span whose own text begins or ends with a backtick needs a space inside
  // the delimiters, or the run merges with them and the span never closes.
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
 * The first block is the H1 and the second is the scope line, in every
 * document `renderMarkdown` emits.
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
 * See `test/action/compose-comment.test.ts`, "takes the first removal from
 * the largest view".
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
  const trimmed = log.replace(/\n+$/, "");
  // An empty log is no log at all. `"".split("\n")` yields one empty line,
  // and carrying it would produce a <details> block quoting nothing — or,
  // under a tight limit, a disclosure that a line was dropped when no line
  // was ever there.
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  let tail = lines.slice(Math.max(0, lines.length - LOG_TAIL_LINES));
  const foot = footer(runUrl, artifactUrl);

  /**
   * @param {string[]} kept
   * @param {number} dropped
   * @returns {string}
   */
  const render = (kept, dropped) => {
    /** @type {string[]} */
    const blocks = [`${marker}\n# urtext review`, FAILURE_HEADLINE, sentence];
    if (kept.length > 0) {
      const text = kept.join("\n");
      const fence = fenceFor(text);
      blocks.push(
        `<details><summary>What urtext reported</summary>\n\n${fence}\n${text}\n${fence}\n\n</details>`,
      );
    }
    // Outside the block above on purpose. A limit tight enough to take the
    // whole tail leaves this count as the only thing saying the log was ever
    // there, and a cap that bites in silence is the defect this pipeline
    // exists to refuse. See `test/action/compose-comment.test.ts`, "shortens
    // an oversized log and states how many lines it dropped".
    if (dropped > 0) {
      blocks.push(
        `${dropped} earlier line${dropped === 1 ? "" : "s"} of urtext's output ${dropped === 1 ? "was" : "were"} left out to fit the comment limit.`,
      );
    }
    blocks.push(FAILURE_CLOSING, foot);
    return blocks.join("\n\n") + "\n";
  };

  let dropped = 0;
  let body = render(tail, dropped);
  // No cap in this pipeline is silent: the tail shortens and says so, and if
  // even an empty tail will not fit, the details block goes entirely — while
  // the count of what it held stays. The fixed copy (headline, reason,
  // closing, footer) is never shortened, so a limit under its own length is
  // answered with the shortest honest body there is, over the limit, rather
  // than with a sentence cut in half. See
  // `test/action/compose-comment.test.ts`, "falls back to the failure body
  // when even a findings-free review overflows".
  while (body.length > limit && tail.length > 0) {
    tail = tail.slice(1);
    dropped++;
    body = render(tail, dropped);
  }
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
    // The notice's own length is part of the budget, so the whole body is
    // re-rendered each iteration rather than measured against a precomputed
    // notice: the notice's character count changes with the digit count of
    // `omitted`.
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
