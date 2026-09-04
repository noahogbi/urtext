import {
  EMPTY_LENS_COPY,
  LENSES,
  location,
  plainText,
  type EvidenceView,
  type FindingView,
  type ModelNoteView,
  type ReportModel,
} from "./model.js";

/**
 * The Markdown surface, a walker over the report model — GitHub-flavored,
 * written for the places a review gets pasted: PRs, issues, chat, downstream
 * tools. Every sentence, tier, glyph, lens routing, ordering, and disclosure
 * rendered here is decided by `buildReportModel`; what this file owns is
 * format mechanics — headings, blockquote prefixes, and the code fences
 * around excerpts.
 *
 * The escaping policy is deliberately minimal: prose is never entity- or
 * backslash-escaped, so an author's `*` may render as emphasis — acceptable,
 * because the text stays legible and unaltered either way, and a report full
 * of visible backslashes would not. What is never acceptable is untrusted
 * text becoming document STRUCTURE, and each construct here closes that door
 * mechanically rather than by escaping: heading and body-paragraph text is
 * collapsed to one line (a newline would end the heading — or begin a fresh
 * line free to open any Markdown structure — and promote the rest to
 * top-level text), blockquote content has every line prefixed so nothing inside can
 * step out of the quote, and excerpts sit inside fences long enough that no
 * backtick run they contain can close them — see
 * `test/report/markdown.test.ts`, "escalates the fence past any backtick run
 * in the excerpt". Concealment arrives from the model as segments; this flat
 * surface joins them through `plainText`, which brackets each label, and a
 * bracketed label with no `(` after it is literal text to Markdown.
 *
 * Unlike the HTML — whose narrative pane repeats every finding and whose
 * filtered panes show some twice — this surface is a linear document, so it
 * partitions: each finding appears exactly once, under its own `lens`, in
 * model order. The model's walker rule allows precisely this (see
 * `ReportModel.findings`: a walker "may group by `lens` or `subject` but
 * preserves this order within a group and may never drop a finding"), and
 * `test/report/markdown.test.ts`, "never drops a finding: every headline the
 * model carries appears exactly once", pins it. `ReachView` site lists are
 * this surface's one density cut, exactly as they are the terminal's: a
 * standalone reach finding's title and body already state the reference
 * count, and the full site list stays on the HTML surface a reader opens for
 * depth.
 */

/** The floor under every fence; escalation only ever adds to it. */
const MIN_FENCE = 3;

/**
 * Collapses text to one line. Headings need it because a raw newline would
 * end the heading early. Body paragraphs need it for the inverse reason: a
 * newline mid-paragraph begins a fresh line, and a fresh line is free to
 * open any Markdown structure — a heading, a blockquote, a fence — turning
 * paragraph prose into document skeleton. Upstream happens to compose
 * bodies single-line today (`typeToString` emits one line), but nothing
 * pins that, so the door is closed here, mechanically, like every other
 * construct's. A space is the right joiner because a paragraph is one
 * block by definition: whatever soft wrapping the text carried, it reads
 * as one flow. See `test/report/markdown.test.ts`, "keeps a newline inside
 * a body paragraph from starting a Markdown structure line".
 */
function inline(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ");
}

/**
 * Paragraphs as one blockquote, every line prefixed and a bare marker
 * between paragraphs — so no line of model-carried text, whatever it starts
 * with, can render outside the quote it was attributed under.
 */
function quote(paragraphs: string[]): string {
  return paragraphs
    .filter((p) => p !== "")
    .map((p) =>
      p
        .split(/\r?\n/)
        .map((line) => `> ${line}`.trimEnd())
        .join("\n"),
    )
    .join("\n>\n");
}

/** The fence info string: TypeScript's two extensions, else none — the whole table the spec names. */
function language(file: string): string {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "ts";
  return "";
}

/**
 * A fence one backtick longer than the longest run inside the excerpt, never
 * shorter than MIN_FENCE. The excerpt is the one place this document quotes
 * text an adversary can author outright, and a run matching the fence would
 * close the block early — promoting the rest of the excerpt from quoted code
 * to live Markdown, headings and all.
 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

function evidenceBlocks(ref: EvidenceView): string[] {
  const code = plainText(ref.excerpt);
  const fence = fenceFor(code);
  return [location(ref), `${fence}${language(ref.file)}\n${code}\n${fence}`];
}

/**
 * The only way model-authored text reaches this document: one blockquote
 * whose first line is the attribution, then the prose, then the trust
 * caveat. All three come from the one `ModelNoteView` (see `./model.js`,
 * where their inseparability is argued), so there is no code path that
 * renders one without the others. Like the HTML and unlike the terminal,
 * the block is not gated on a recorded model name — a model-tier finding's
 * whole body is model prose, and suppressing it would leave a headline with
 * nothing under it, so the model's UNNAMED_MODEL fallback attribution shows
 * instead, visibly incomplete rather than absent.
 */
function modelNoteQuote(note: ModelNoteView): string {
  return quote([`unverified · ${note.model}`, plainText(note.text), note.caution]);
}

function findingBlocks(finding: FindingView): string[] {
  const blocks: string[] = [
    `### ${finding.glyph} ${inline(plainText(finding.headline))} [${finding.tier}]` +
      (finding.beyondIntent ? ` (${finding.beyondIntent})` : ""),
  ];
  // One walk covers every tier: a model-tier finding arrives with no body
  // paragraphs and its whole prose in `modelNote`, an inferred finding keeps
  // its analyzer paragraphs and carries the claim's reasoning beside them,
  // and a claim-free finding has no note at all.
  for (const paragraph of finding.body) {
    blocks.push(inline(plainText(paragraph)));
  }
  if (finding.modelNote) {
    blocks.push(modelNoteQuote(finding.modelNote));
  }
  for (const ref of finding.evidence) {
    blocks.push(...evidenceBlocks(ref));
  }
  return blocks;
}

export function renderMarkdown(model: ReportModel): string {
  const blocks: string[] = ["# urtext review", model.scope];

  // The disclosures, every one, ahead of the first lens heading: a reader
  // has to know what the review could not see before reading the list and
  // concluding nothing else was found. Blockquotes, so they read as the
  // report speaking about itself, set apart from the findings.
  if (model.provenance) {
    blocks.push(quote([model.provenance]));
  }
  if (model.notes.length > 0) {
    // Gated on the model's `notes` exactly: non-empty means the review is
    // partial and this surface must say so, in the same sentence the HTML's
    // banner leads with.
    blocks.push(quote(["**This review is partial.**", ...model.notes]));
  }
  if (model.coverageNote) {
    blocks.push(quote([model.coverageNote]));
  }
  if (model.unanalyzedNote) {
    blocks.push(quote([model.unanalyzedNote]));
  }
  if (model.generatedNote) {
    blocks.push(quote([model.generatedNote]));
  }
  if (model.filterNote) {
    blocks.push(quote([model.filterNote]));
  }
  if (model.distributionNote) {
    blocks.push(quote([model.distributionNote]));
  }
  // Once per kind, after the per-review disclosures and before the findings:
  // guidance a reader needs once, kept out of the bodies it used to repeat.
  if (model.kindNotes.length > 0) {
    blocks.push(quote(model.kindNotes));
  }
  if (model.beyondIntentLegend) {
    blocks.push(quote([model.beyondIntentLegend]));
  }
  // Above the lens sections and below the legend, matching the terminal.
  if (model.intentGap.length > 0) {
    blocks.push(`## Not described by this change's messages (${model.intentGap.length})`);
    blocks.push(
      model.intentGap
        .map((e) => `- \`[${e.tier}]\` ${plainText(e.label)} — \`${e.file}:${e.line}\``)
        .join("\n"),
    );
    if (model.intentGapAttribution) blocks.push(quote([model.intentGapAttribution]));
  }

  for (const { key, label } of LENSES) {
    blocks.push(`## ${label}`);
    const inLens = model.findings.filter((f) => f.lens === key);
    if (inLens.length === 0) {
      blocks.push(EMPTY_LENS_COPY);
      continue;
    }
    for (const finding of inLens) {
      blocks.push(...findingBlocks(finding));
    }
  }

  return blocks.filter((b) => b !== "").join("\n\n") + "\n";
}
