import {
  BEYOND_INTENT_MARK,
  EMPTY_LENS_COPY,
  LENSES,
  TIER_GLYPH,
  TIER_MEANING,
  TIER_ORDER,
  TIER_WORD,
  type ConcealSegment,
  type FindingView,
  type ModelNoteView,
  type ReportModel,
} from "./model.js";
import type { ChangedSymbol } from "../types.js";

/**
 * The HTML surface, a walker over the report model. Every sentence, tier,
 * glyph, lens routing, ordering, and disclosure rendered here is decided by
 * `buildReportModel` — what this file owns is format mechanics (entity
 * escaping, markup, the stylesheet, the tab script) plus the fixed,
 * data-free copy only this surface shows: the lens blurbs, the empty-lens
 * wording, the provenance tail, the legend framing. Model text arrives with
 * concealment already applied — structurally, as `ConcealSegment` arrays
 * this walker wraps in its own markup, or as labeled strings for
 * identifier-shaped fields — so nothing here re-derives concealment for
 * model content. Every string on this page comes from the model, concealment
 * already applied; this file has no concealment path of its own.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Markup escaping, and nothing else. Quotes and apostrophes go too, not just
 * the angle brackets, so the result cannot break out of an attribute value.
 * Everything the model hands this walker is untrusted — a signature
 * containing `Array<T>` and a claim containing a literal `<script>` are the
 * same problem, and only one of them is hostile — so format escaping is
 * applied to ALL model-provided text uniformly. Two contexts, one function
 * each:
 *
 * - a segmented content field → `seg` (or `prose`, which builds on it)
 * - a labeled model string, or a string literal written in this file → `esc`
 *
 * `seg` calls this one, so the escaping below is the floor under both
 * contexts, not an alternative to them.
 *
 * Nothing untrusted is ever interpolated into the inline script or the
 * stylesheet, where escaping would not help — the script is a fixed string
 * that reads its data from the DOM. See `test/report/html.test.ts`, "puts
 * no report data inside the inline script".
 */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * A segmented model field as HTML: text runs entity-escaped, each concealed
 * segment's bare code-point label wrapped in the `.ctrl` span that keeps it
 * visible (the table and its rationale live in `./conceal.ts`). The
 * distinction arrives structurally from the model, so no label is ever
 * parsed back out of flattened text — source code that literally spells
 * `[U+202E]` stays ordinary text here, and only a real concealed character
 * gets the span.
 */
function seg(segments: ConcealSegment[]): string {
  return segments
    .map((s) =>
      s.kind === "concealed"
        ? `<span class="ctrl" title="concealing character">${s.text}</span>`
        : esc(s.text),
    )
    .join("");
}

/**
 * A segmented paragraph with `backticked` spans set as inline code. `seg`
 * runs first and introduces no backtick of its own, so the pairs this
 * matches are the author's; the text inside a span is already neutralised by
 * the time the `code` tags go around it. Analyzer bodies and model prose
 * both quote identifiers this way constantly, and a wall of
 * undifferentiated prose is the thing that stops a reader partway down a
 * finding.
 */
function prose(segments: ConcealSegment[]): string {
  return seg(segments).replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/**
 * The only way model-authored text reaches the page. The model carries the
 * prose, the attribution, and the trust caveat in one `ModelNoteView` — see
 * `./model.js`, where their inseparability is argued — and this block
 * renders all three from that one object, so there is no code path that
 * emits one without the others. See `test/report/html.test.ts`, "never
 * renders model prose outside an attributed block".
 *
 * Contains no nested `div` on purpose: the test above matches from a
 * `model-block` to the next `</div>`, so a nested one would end the match
 * early and let the prose after it escape the check.
 */
function modelBlock(note: ModelNoteView): string {
  return [
    `<div class="model-block">`,
    `<span class="model-tag">unverified · ${esc(note.model)}</span>`,
    `<span class="model-text">${prose(note.text)}</span>`,
    `<span class="model-note">${esc(note.caution)}</span>`,
    `</div>`,
  ].join("");
}

/**
 * `path:line`, with before-side lines marked — see `EvidenceView.side` in
 * `./model.js` for why the reader is owed that marker. No link: the numbers
 * on a before-side ref count in a revision that need not exist in the
 * working tree, and this report has no repository path to resolve an
 * after-side ref against either, so every location here is text to read or
 * copy rather than something to click. The file path arrives from the model
 * as a labeled string, so only the entity layer is applied.
 */
function location(ref: { file: string; line: number; side?: "before" | "after" }): string {
  const marker =
    ref.side === "before"
      ? ` <span class="chip chip-before" title="This line number counts in the before revision. It may point somewhere unrelated in the working tree.">before</span>`
      : "";
  return `<span class="loc">${esc(ref.file)}:${ref.line}</span>${marker}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Sentence-leading count. Splicing the raw number in leaves a sentence with
 * a numeral for a subject and, in the singular, a verb that does not agree
 * with it. The narrative is prose a person reads, so the subject is spelled
 * out and each verb is inflected at its own call site.
 */
function countWord(n: number): string {
  return n === 1 ? "One" : String(n);
}

function evidenceHtml(finding: FindingView): string {
  if (finding.evidence.length === 0) {
    return `<p class="no-evidence">No evidence. Nothing mechanical points at this — read the code before believing it.</p>`;
  }
  // Every ref the model carries, uncapped: this is the surface a reader
  // opens when the terminal's summary was not enough.
  const items = finding.evidence
    .map((e) => `<li>${location(e)}<pre class="excerpt"><code>${seg(e.excerpt)}</code></pre></li>`)
    .join("");
  return `<h4>Evidence</h4><ol class="evidence">${items}</ol>`;
}

function reachHtml(finding: FindingView): string {
  const reach = finding.reach;
  if (!reach) return "";
  const items = reach.sites.map((s) => `<li>${location(s)}</li>`).join("");
  // The site list is a sample even before the model's cap — the analyzer
  // bounds what it collects while counting every reference — so the two
  // numbers are reported apart rather than as "N of M". The cap and the
  // overflow count are the model's (see `ReachView`); this walker only
  // phrases them.
  const more =
    reach.overflow > 0 ? `<li class="muted">… ${reach.overflow} more collected</li>` : "";
  return `<h4>Referenced from <span class="muted">(${plural(reach.references, "reference")} in total)</span></h4><ul class="sites">${items}${more}</ul>`;
}

function findingCard(finding: FindingView, lens: string, rank: number, numbered: boolean): string {
  const tier = finding.tier;
  const badge = `<span class="badge badge-${tier}">${finding.glyph} ${esc(TIER_WORD[tier])}${
    tier === "model" && finding.modelNote ? ` · ${esc(finding.modelNote.model)}` : ""
  }</span>`;
  // Two rows, not one, so the location cannot push the title around: on one
  // row a `src/interpret/schema.ts:58` and a `b.ts:5` start their titles
  // half a column apart, and file paths vary far more in width than
  // anything else in the headline. Titles still shift by tier, since the
  // badge ahead of them is wider for a model-tier finding that carries the
  // model's name — that one is left alone deliberately: pinning the badge to
  // a fixed width would either truncate a model name or pad every other
  // headline to fit the longest one. The location's side marker is the
  // model's (`FindingView.side`, taken from the anchoring evidence ref).
  const head = [
    `<span class="head-row">`,
    `<span class="rank">${numbered ? rank : ""}</span>`,
    `<span class="chev" aria-hidden="true">▸</span>`,
    badge,
    finding.beyondIntent
      ? `<span class="badge badge-intent">${esc(finding.beyondIntent)}</span>`
      : "",
    `<span class="finding-title">${prose(finding.title)}</span>`,
    `</span>`,
    `<span class="head-loc">`,
    location({ file: finding.file, line: finding.line, side: finding.side }),
    `</span>`,
  ].join("");

  // One walk covers every tier: a model-tier finding arrives with no body
  // paragraphs and its whole prose in `modelNote`, an inferred finding keeps
  // its analyzer paragraphs and carries the claim's reasoning in `modelNote`
  // beside them, and a claim-free finding has no note at all. Unlike the
  // terminal, the block is not gated on a recorded model name: a model-tier
  // finding's whole body is model prose, and suppressing it would leave a
  // headline with nothing under it, so the model's UNNAMED_MODEL fallback
  // attribution shows instead — visibly incomplete rather than absent.
  const paragraphs = finding.body.map((p) => `<p class="body">${prose(p)}</p>`).join("");
  const note = finding.modelNote ? modelBlock(finding.modelNote) : "";

  return [
    `<li><details class="card card-${tier}" id="${esc(lens)}-f${rank}">`,
    `<summary>${head}</summary>`,
    `<div class="card-body">${paragraphs}${note}${evidenceHtml(finding)}${reachHtml(finding)}</div>`,
    `</details></li>`,
  ].join("");
}

/**
 * A ranked list of cards. `numbered` is off for the filtered lenses: a
 * number beside a finding reads as its rank, and in a lens showing three of
 * eleven findings any number is wrong — the position in the filtered list
 * is not the rank, and the rank is not the position. The cards stay in the
 * model's rank order either way — a pane filters, never reorders. The empty
 * rank cell is kept so the headline and the location under it line up with
 * the numbered lens.
 */
function findingList(findings: FindingView[], lens: string, numbered = false): string {
  const items = findings.map((f, i) => findingCard(f, lens, i + 1, numbered)).join("");
  return `<ol class="findings">${items}</ol>`;
}

function empty(message: string): string {
  return `<p class="empty">${esc(message)}</p>`;
}

function lead(m: ReportModel): string {
  const sentences: string[] = [
    `This range touches ${plural(m.fileCount, "file")} and ${plural(m.lineCount, "changed line")}.`,
  ];
  if (m.findings.length === 0) {
    sentences.push("Nothing in it tripped an analyzer, and no claim stands alone.");
  } else {
    sentences.push(
      m.findings.length === 1
        ? "One finding."
        : `${m.findings.length} findings, ranked by what each is likely to cost.`,
    );
    if (m.counts.verified > 0) {
      const n = m.counts.verified;
      sentences.push(
        `${countWord(n)} rest${n === 1 ? "s" : ""} on something an analyzer can point at in the code.`,
      );
    }
    if (m.counts.inferred > 0) {
      const n = m.counts.inferred;
      sentences.push(
        `${countWord(n)} pair${n === 1 ? "s" : ""} an analyzer's finding with the model's explanation of why it matters.`,
      );
    }
    if (m.counts.model > 0) {
      const n = m.counts.model;
      sentences.push(
        `${countWord(n)} come${n === 1 ? "s" : ""} from the model alone — a lead to check, not a result.`,
      );
    }
  }
  return `<p class="lead">${esc(sentences.join(" "))}</p>`;
}

function narrativeLens(m: ReportModel): string {
  const body =
    m.findings.length === 0
      ? empty("No findings to narrate.")
      : findingList(m.findings, "narrative", true);
  return lead(m) + body;
}

function section(heading: string, blurb: string, findings: FindingView[], lens: string): string {
  if (findings.length === 0) return "";
  return `<h3>${esc(heading)}</h3><p class="blurb">${esc(blurb)}</p>${findingList(findings, lens)}`;
}

function effectsLens(findings: FindingView[]): string {
  // The classification is the model's (`FindingView.subject`, recovered from
  // the finding's id exactly once, in `buildReportModel`); these filters
  // only gather what it decided, in the order it decided.
  const effects = findings.filter((f) => f.subject === "effect");
  const guards = findings.filter((f) => f.subject === "guard");
  const contracts = findings.filter((f) => f.subject === "surface");
  const parts = [
    section(
      "Effects",
      "What this change makes the program do to the world outside itself.",
      effects,
      "effects",
    ),
    section("Guards", "Checks that ran before and do not run now.", guards, "guards"),
    section("Contracts", "Promises other code was compiled against.", contracts, "contracts"),
  ].filter((p) => p !== "");
  // Names all four kinds of finding this lens does not show. It used to name
  // only the first, while the model classifies a standalone reach finding
  // under a subject no section filters on — so a reader was told the
  // narrative held nothing extra except model claims, and it held that too.
  // A citation finding is the third, for the same reason and with the same
  // cost if it goes unnamed. Its clause has to cover every path that can
  // produce one: citations are extracted from TypeScript comments as well as
  // from prose, and the baseline-less path deliberately claims nothing about
  // what the pointer used to do — so the clause names both sources and states
  // only that the pointer does not hold now.
  const note = `<p class="blurb">Built from what the analyzers proved, and not the whole list. A model-only claim has no analyzer behind it to classify. A standalone reach finding — a changed export with callers, and nothing else known about it — reports cost rather than a problem, and belongs to none of these three. A citation finding — a line of prose or a comment in this repository whose pointer into the code does not hold at this revision — belongs to none of them either. A dependency finding — a change to what package.json declares, or to what package-lock.json resolves — belongs to none of them either. All four appear in the narrative.</p>`;
  if (parts.length === 0) {
    // Describes the filter, not the change. A lens is a view over findings
    // the model classified by id prefix, and if that classification ever
    // stops matching what the analyzers emit, this pane is what a user sees
    // — so it must not be able to say "nothing crossed a boundary and no
    // promise moved" while a removed guard sits ranked first in the
    // narrative. An honest empty state degrades to a shrug; the other
    // wording degrades to the tool asserting something false in its own
    // voice, in the one place the tier badges do not reach.
    return note + empty(`${EMPTY_LENS_COPY} The narrative has the full list.`);
  }
  return note + parts.join("");
}

const SYMBOL_CHANGE_MARK: Record<ChangedSymbol["change"], string> = {
  added: "+",
  modified: "~",
  removed: "−",
};

function surfaceLens(model: ReportModel): string {
  const rows: string[] = [];
  for (const sym of model.surfaceSymbols) {
    rows.push(
      [
        `<tr class="sym-${sym.change}">`,
        // The mark carries the colour and the word carries the meaning, in
        // one cell: as two columns they said the same thing twice.
        `<td class="change"><span aria-hidden="true">${SYMBOL_CHANGE_MARK[sym.change]}</span> ${esc(sym.change)}</td>`,
        `<td class="mono">${seg(sym.qualifiedName)}</td>`,
        `<td class="muted">${seg(sym.kind)}</td>`,
        `<td class="mono muted">${seg(sym.file)}</td>`,
        `</tr>`,
      ].join(""),
    );
  }
  const surfaceFindings = model.findings.filter((f) => f.subject === "surface");

  if (rows.length === 0 && surfaceFindings.length === 0) {
    return empty(
      "Nothing in this range matched this view: no exported declaration appears in the symbol map, and no finding is about the public surface.",
    );
  }

  const table =
    rows.length === 0
      ? empty(
          "No exported declaration appears in this range's symbol map, though the findings below are about the public surface.",
        )
      : [
          // What the symbol map actually records, named rather than promised
          // as "every exported declaration". `mapSymbols` (in
          // `../extract/symbols.ts`) reads function, class, interface, type
          // alias, enum, variable, method, and accessor declarations, and this
          // table shows the ones that are module exports — a class member
          // never is.
          //
          // The list of exclusions is checked, not assumed. An enum's
          // individual members are never recorded — a changed member shows
          // as its enum's one row — and neither is a re-export declaration;
          // saying so is what keeps that silence from reading as "nothing
          // changed". Namespaces are a different case and were described
          // wrongly before: their members *are* recorded, qualified (`N.x`),
          // and are not module exports — an importer reaches them through the
          // namespace — so they do not appear in this table either, but for a
          // stated reason rather than because nothing looked.
          `<p class="blurb">Module-level exported functions, classes, interfaces, type aliases, enums, and variables this range touched, read from the symbol map rather than from the findings — so a symbol appears here whether or not anything flagged it. Not an inventory of the whole public surface: enum members and re-export declarations are not recorded at all, so a changed enum member shows only as its enum&#39;s row; a declaration exported by a separate <code>export { … }</code> statement rather than by an <code>export</code> modifier is recorded but not counted as an export; a namespace&#39;s members are recorded under the namespace rather than as exports of the file; and a deleted file contributes nothing.</p>`,
          `<div class="table-scroll"><table class="surface">`,
          `<thead><tr><th>Change</th><th>Symbol</th><th>Kind</th><th>File</th></tr></thead>`,
          `<tbody>${rows.join("")}</tbody></table></div>`,
        ].join("");

  const flagged =
    surfaceFindings.length === 0
      ? `<p class="blurb">No finding in this review is about the public surface.</p>`
      : `<h3>What changed contractually</h3>${findingList(surfaceFindings, "surface")}`;

  return table + flagged;
}

function headerHtml(m: ReportModel): string {
  // The same numbers as `ReportModel.scope`, phrased this surface's way —
  // dot separators where the terminal's line uses a comma — which is why the
  // model carries the pieces as well as its own composed line.
  const scope = `${plural(m.fileCount, "file")} · ${plural(m.lineCount, "line")} changed · ${m.rangeLabel}`;

  const chips = TIER_ORDER.map(
    (tier) =>
      `<span class="chip chip-${tier}" title="${esc(TIER_MEANING[tier])}">${TIER_GLYPH[tier]} ${m.counts[tier]} ${esc(TIER_WORD[tier])}</span>`,
  ).join("");

  // Every reason this run fell short of its full pipeline, in one banner
  // above the findings, gated on the model's `notes` exactly: non-empty
  // means the review is partial and this surface must say so. A reader who
  // does not know an analyzer died, or that the model was never asked,
  // reads a short list as good news.
  const banner =
    m.notes.length === 0
      ? ""
      : [
          `<div class="banner">`,
          `<strong>This review is partial.</strong>`,
          `<ul>${m.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
          `</div>`,
        ].join("");

  // Separate from the banner deliberately, which is why the model carries it
  // as `filterNote` rather than a `notes` entry: the filter ran as designed,
  // so its disclosure must not read as the review falling short. See
  // `test/report/html.test.ts`, "discloses the standalone-reach filter with
  // the same sentence the terminal prints".
  const filterNote = m.filterNote ? `<p class="muted">${esc(m.filterNote)}</p>` : "";

  // Separate from the banner for the same reason, and muted for the same one:
  // a sweep that completed and says where its findings fell has not fallen
  // short of anything.
  const distributionNote = m.distributionNote
    ? `<p class="muted">${esc(m.distributionNote)}</p>`
    : "";

  // Once per kind. Muted like the other orientation copy: it explains what a
  // kind of finding means, which a reader needs once and not on every row.
  const kindNotes =
    m.kindNotes.length > 0
      ? `<ul class="muted">${m.kindNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
      : "";

  // The gate — a model name AND a model-derived tier below — is the model's;
  // `provenance` is simply absent otherwise. The fixed tail after it is this
  // surface's own data-free copy. Model prose itself is never gated this way
  // — `modelBlock` names an unnamed model instead of going silent, because a
  // model-tier finding's whole body is model prose and suppressing it would
  // leave a headline with nothing under it.
  const provenance = m.provenance
    ? `<p class="provenance">${esc(m.provenance)} Everything it wrote is marked.</p>`
    : "";

  // Its own line, deliberately outside the banner — the model carries this
  // as `coverageNote`, apart from `notes`, for exactly this placement:
  // deleting a TypeScript file is routine, and "This review is partial."
  // fired on every diff that did. A banner that a normal change trips is a
  // banner a reader learns to skip, and the things it exists for — a dead
  // analyzer, a model never asked — are the ones that would go unread.
  const coverage = m.coverageNote ? `<p class="coverage">${esc(m.coverageNote)}</p>` : "";
  // Same line treatment and the same reasoning as `coverage` above: what the
  // analyzers could not reach is coverage, not a partial review.
  const unanalyzed = m.unanalyzedNote ? `<p class="coverage">${esc(m.unanalyzedNote)}</p>` : "";

  // Inside the header, so it spans the three lens panes rather than sitting in
  // one of them — it indexes findings across all three. Below the legend for
  // the reason the terminal and Markdown put it there: the reader meets the
  // badge's meaning before the block that aggregates it.
  const intentGap =
    m.intentGap.length > 0
      ? `<section class="intent-gap"><h2>${esc(
          `Not described by this change's messages (${m.intentGap.length})`,
        )}</h2><ul>${m.intentGap
          .map(
            (e) =>
              `<li><span class="badge badge-${e.tier}">${esc(TIER_WORD[e.tier])}</span> ` +
              // `seg`, not a flattened string: segmented content goes through
              // the walker that keeps a concealed code point in its `.ctrl`
              // span. Flattening would make the index the one surface
              // rendering concealment differently from every other.
              `${seg(e.label)} <span class="loc">${esc(`${e.file}:${e.line}`)}</span></li>`,
          )
          .join("")}</ul>${
          m.intentGapAttribution
            ? `<p class="attribution">${esc(m.intentGapAttribution)}</p>`
            : ""
        }</section>`
      : "";

  const legend = TIER_ORDER.map(
    (tier) =>
      `<li><span class="badge badge-${tier}">${TIER_GLYPH[tier]} ${esc(TIER_WORD[tier])}</span> ${esc(TIER_MEANING[tier])}</li>`,
  ).join("");

  // Its own item under the same legend, in the same shape as the tier items.
  // The badge here is the model's word, escaped like every other model string.
  const intentLegend = m.beyondIntentLegend
    ? `<li><span class="badge badge-intent">${esc(BEYOND_INTENT_MARK)}</span> ${esc(m.beyondIntentLegend)}</li>`
    : "";

  return [
    `<header>`,
    `<h1>urtext</h1>`,
    `<p class="scope">${esc(scope)}</p>`,
    `<div class="chips">${chips}</div>`,
    provenance,
    coverage,
    unanalyzed,
    banner,
    filterNote,
    distributionNote,
    kindNotes,
    `<details class="legend"><summary>What the three tiers mean</summary><ul>${legend}${intentLegend}</ul></details>`,
    intentGap,
    `</header>`,
  ].join("");
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1a1a1c;
  --muted: #5f6068;
  --rule: #e2dfd9;
  --verified: #12674c;
  --inferred: #9a6206;
  --model: #97325c;
  --verified-bg: #e7f2ed;
  --inferred-bg: #f7eedd;
  --model-bg: #f8eaf0;
  --code-bg: #f4f2ee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131316;
    --panel: #1b1c1f;
    --ink: #e8e7e4;
    --muted: #9a9da4;
    --rule: #2c2d32;
    --verified: #63c9a4;
    --inferred: #e0ac52;
    --model: #e987b0;
    --verified-bg: #12291f;
    --inferred-bg: #2b2313;
    --model-bg: #2c1420;
    --code-bg: #212227;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  overflow-wrap: break-word;
}
.page { max-width: 58rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
h1 { font-size: 1.05rem; letter-spacing: .18em; text-transform: uppercase; margin: 0 0 .35rem; }
h3 { font-size: .95rem; margin: 2rem 0 .25rem; }
h4 { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 1.1rem 0 .35rem; font-weight: 600; }
header { border-bottom: 1px solid var(--rule); padding-bottom: 1.25rem; }
.scope { margin: 0 0 .9rem; color: var(--muted); font-size: .93rem; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip {
  font-size: .8rem; padding: .12rem .5rem; border-radius: 999px;
  border: 1px solid var(--rule); background: var(--panel); color: var(--muted);
}
.chip-verified { color: var(--verified); background: var(--verified-bg); border-color: transparent; }
.chip-inferred { color: var(--inferred); background: var(--inferred-bg); border-color: transparent; }
.chip-model { color: var(--model); background: var(--model-bg); border-color: transparent; }
.chip-before { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--model); background: var(--model-bg); border-color: transparent; }
.intent-gap { margin: 1.2rem 0 0; padding: .8rem 1rem; border: 1px solid var(--rule); border-radius: 4px; }
.intent-gap h2 { font-size: .95rem; margin: 0 0 .5rem; }
.intent-gap ul { list-style: none; margin: 0; padding: 0; }
.intent-gap .loc { color: var(--muted); }
.intent-gap .attribution { font-size: .85rem; color: var(--muted); margin: .6rem 0 0; }
.provenance, .coverage { font-size: .85rem; color: var(--muted); margin: .8rem 0 0; }
.banner {
  margin: 1rem 0 0; padding: .7rem .9rem; border-radius: .4rem;
  background: var(--inferred-bg); border: 1px solid var(--inferred); font-size: .9rem;
}
.banner ul { margin: .35rem 0 0; padding-left: 1.1rem; }
.legend { margin-top: 1rem; font-size: .85rem; color: var(--muted); }
.legend summary { cursor: pointer; }
.legend ul { list-style: none; margin: .6rem 0 0; padding: 0; }
.legend li { margin: .3rem 0; }
.tabs { display: none; gap: .35rem; margin: 1.5rem 0 .5rem; flex-wrap: wrap; }
.has-js .tabs { display: flex; }
.tabs button {
  font: inherit; font-size: .88rem; padding: .35rem .8rem; cursor: pointer;
  color: var(--muted); background: transparent;
  border: 1px solid var(--rule); border-radius: 999px;
}
.tabs button[aria-selected="true"] { color: var(--bg); background: var(--ink); border-color: var(--ink); }
.lens { padding-top: .5rem; }
.has-js .lens { display: none; }
.has-js .lens.active { display: block; }
.lead { font-size: 1.02rem; margin: .75rem 0 1.25rem; }
.blurb, .empty { color: var(--muted); font-size: .9rem; }
.empty { padding: 1rem 0; }
.findings { list-style: none; margin: 0; padding: 0; }
.card {
  background: var(--panel); border: 1px solid var(--rule);
  border-left: 4px solid var(--rule); border-radius: .4rem;
  margin: .5rem 0; padding: .55rem .8rem;
}
.card-verified { border-left-color: var(--verified); }
.card-inferred { border-left-color: var(--inferred); }
.card-model { border-left-color: var(--model); border-style: dashed; border-left-style: solid; background: transparent; }
.card summary { cursor: pointer; display: block; list-style: none; }
.card summary::-webkit-details-marker { display: none; }
.head-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem; }
.head-loc { display: block; margin: .15rem 0 0 2.35rem; }
.chev { color: var(--muted); font-size: .75rem; transition: transform .12s ease; display: inline-block; }
details[open] > summary .chev { transform: rotate(90deg); }
.rank { color: var(--muted); font-variant-numeric: tabular-nums; font-size: .82rem; min-width: 1.1rem; }
.badge {
  font-size: .74rem; letter-spacing: .04em; padding: .1rem .45rem; border-radius: .25rem;
  white-space: nowrap;
}
.badge-verified { color: var(--verified); background: var(--verified-bg); }
.badge-inferred { color: var(--inferred); background: var(--inferred-bg); }
.badge-model { color: var(--model); background: var(--model-bg); }
.badge-intent { color: var(--model); background: transparent; border: 1px solid var(--model); }
.loc, .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace; font-size: .84rem; }
.loc { color: var(--muted); }
.finding-title { flex: 1 1 16rem; min-width: 0; }
.card-body { padding: .35rem 0 .5rem 2.35rem; }
.body { margin: .5rem 0; }
.model-block {
  display: block; margin: .7rem 0; padding: .55rem .75rem;
  border: 1px dashed var(--model); border-radius: .35rem; background: var(--model-bg);
}
.model-tag {
  display: inline-block; font-size: .7rem; text-transform: uppercase; letter-spacing: .07em;
  color: var(--model); font-weight: 700; margin-right: .4rem;
}
.model-text { display: inline; }
.model-note { display: block; margin-top: .4rem; font-size: .8rem; color: var(--muted); }
.no-evidence { font-size: .9rem; color: var(--model); margin: .6rem 0; }
.evidence, .sites { margin: 0; padding-left: 1.2rem; }
.evidence li, .sites li { margin: .35rem 0; }
.excerpt {
  margin: .2rem 0 .6rem; padding: .45rem .6rem; border-radius: .3rem;
  background: var(--code-bg); overflow-x: auto; max-width: 100%;
  font-family: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  font-size: .82rem; line-height: 1.45;
}
.muted { color: var(--muted); }
.table-scroll { overflow-x: auto; max-width: 100%; margin: .75rem 0; }
table.surface { border-collapse: collapse; font-size: .88rem; min-width: 34rem; }
table.surface th { text-align: left; font-size: .74rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--rule); padding: .3rem .6rem .3rem 0; }
table.surface td { padding: .22rem .6rem .22rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.change { white-space: nowrap; }
.sym-added td.change { color: var(--verified); }
.sym-removed td.change { color: var(--model); }
.sym-modified td.change { color: var(--inferred); }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace; font-size: .88em; background: var(--code-bg); padding: 0 .2em; border-radius: .2em; }
.excerpt code { background: none; padding: 0; font-size: inherit; }
.ctrl {
  font-family: ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  font-size: .72em; white-space: nowrap; vertical-align: baseline;
  padding: 0 .25em; margin: 0 .1em; border-radius: .2em;
  color: var(--model); background: var(--model-bg); border: 1px solid var(--model);
}
`;

/**
 * Runs before the panes are parsed so a lens switch never flashes three
 * stacked lenses. Everything it does is undone by its own absence: without
 * scripting the class is never set, the tab bar stays hidden, and all three
 * lenses render one after another rather than one of them being unreachable.
 */
const HEAD_SCRIPT = `document.documentElement.className = "has-js";`;

const TAB_SCRIPT = `
(function () {
  var tabs = document.querySelector(".tabs");
  if (!tabs) return;
  var buttons = Array.prototype.slice.call(tabs.querySelectorAll("button"));
  var panes = Array.prototype.slice.call(document.querySelectorAll(".lens"));
  function show(key) {
    panes.forEach(function (p) { p.classList.toggle("active", p.getAttribute("data-lens") === key); });
    buttons.forEach(function (b) {
      var on = b.getAttribute("data-lens") === key;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
  }
  buttons.forEach(function (b, i) {
    b.addEventListener("click", function () { show(b.getAttribute("data-lens")); });
    b.addEventListener("keydown", function (e) {
      var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      var next = buttons[(i + step + buttons.length) % buttons.length];
      show(next.getAttribute("data-lens"));
      next.focus();
    });
  });
  show(buttons[0].getAttribute("data-lens"));
})();
`;

export function renderHtml(m: ReportModel): string {
  const panes: Record<string, string> = {
    narrative: narrativeLens(m),
    effects: effectsLens(m.findings),
    surface: surfaceLens(m),
  };

  const tabs = LENSES.map(
    (l, i) =>
      `<button type="button" role="tab" data-lens="${l.key}" aria-controls="lens-${l.key}" aria-selected="${i === 0 ? "true" : "false"}">${esc(l.label)}</button>`,
  ).join("");

  const sections = LENSES.map(
    (l, i) =>
      `<section class="lens${i === 0 ? " active" : ""}" data-lens="${l.key}" id="lens-${l.key}" role="tabpanel" aria-label="${esc(l.label)}">${panes[l.key]}</section>`,
  ).join("");

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    // `<title>` is RCDATA, where markup would show literally — the model's
    // labeled range label plus the entity layer keeps it both inert and
    // free of concealing characters, like every attribute value here.
    `<title>urtext — ${esc(m.rangeLabel)}</title>`,
    `<style>${STYLE}</style>`,
    `<script>${HEAD_SCRIPT}</script>`,
    `</head>`,
    `<body>`,
    `<div class="page">`,
    headerHtml(m),
    `<nav class="tabs" role="tablist" aria-label="Lens">${tabs}</nav>`,
    sections,
    `</div>`,
    `<script>${TAB_SCRIPT}</script>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}
