import { labelConcealed } from "./conceal.js";
import {
  buildReportModel,
  location,
  NO_FINDINGS_COPY,
  plainText,
  TIER_ORDER,
  TIER_WORD,
  type ConcealSegment,
} from "./model.js";
import type { Changeset, Finding } from "../types.js";

/**
 * The terminal surface, a walker over the report model. Every sentence, tier,
 * glyph, ordering, and disclosure printed here is decided by
 * `buildReportModel` — what this file owns is format mechanics: spacing,
 * indentation, line wrapping, the gutter labels, and the width-limited
 * excerpt cut. Model text arrives with concealment already applied
 * (structurally, as `ConcealSegment` arrays, or as labelled strings for
 * identifier-shaped fields), so this walker joins segments through
 * `plainText` and never re-derives concealment for model content.
 */

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      lines.push(indent + line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

/** How many evidence refs to show per finding. A summary, not a dump. The model carries every ref; this cap is this surface's presentation density. */
const EVIDENCE_SHOWN = 2;
/** Where the excerpt cut lands, counted in rendered code points. */
const EXCERPT_WIDTH = 56;
/** The wrap width for body and reasoning paragraphs. */
const BODY_WIDTH = 64;

/**
 * Whitespace-trims an excerpt's edges without ever deleting a concealed
 * segment: only ordinary text segments are trimmed. A raw-string trim would
 * silently drop the whitespace-classed concealing characters at either edge;
 * here they stay visible as their labels, which is the point of labelling
 * them.
 */
function trimSegments(segments: ConcealSegment[]): ConcealSegment[] {
  const out = segments.map((s) => ({ ...s }));
  while (out.length > 0 && out[0].kind === "text") {
    out[0].text = out[0].text.replace(/^\s+/, "");
    if (out[0].text) break;
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1].kind === "text") {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text) break;
    out.pop();
  }
  return out;
}

/**
 * Width-limits an excerpt to one terminal line, segment-aware two ways.
 * Counted in code points, not UTF-16 units — `String#slice` counts units, so
 * an astral character straddling the cut left a lone surrogate that renders
 * as U+FFFD; see `test/report/terminal.test.ts`, "never splits a surrogate
 * pair at the excerpt truncation boundary". And the cut never lands inside a
 * concealed segment's label: a bisected label would misstate the code point,
 * so the cut falls before the whole label instead — the design spec's
 * addendum accepts the shorter line this can produce on concealed input near
 * EXCERPT_WIDTH.
 */
function excerpt(segments: ConcealSegment[]): string {
  const trimmed = trimSegments(segments);
  const full = plainText(trimmed);
  if ([...full].length <= EXCERPT_WIDTH) return full;
  // One code point of the width is reserved for the ellipsis, as before.
  let budget = EXCERPT_WIDTH - 1;
  let out = "";
  for (const s of trimmed) {
    if (s.kind === "concealed") {
      const label = `[${s.text}]`;
      if (label.length > budget) break;
      out += label;
      budget -= label.length;
    } else {
      const points = [...s.text];
      if (points.length > budget) {
        out += points.slice(0, budget).join("");
        budget = 0;
      } else {
        out += s.text;
        budget -= points.length;
      }
    }
    if (budget === 0) break;
  }
  return out + "…";
}

export function renderTerminal(
  changeset: Changeset,
  findings: Finding[],
  reportPath?: string,
  warnings: string[] = [],
  model?: string,
  suppressed = 0,
): string {
  const m = buildReportModel(changeset, findings, { model, warnings, suppressed });
  const out: string[] = [];

  out.push("");
  out.push(`urtext · ${m.scope}`);
  // The disclosures, in model order — warnings first, then the untracked
  // note — with the deleted-file coverage note beside them: each is a
  // coverage statement no finding below can show, and they come before the
  // findings because a reader has to know the review is partial before
  // reading the list and concluding nothing else was found.
  for (const note of m.notes) {
    out.push(`  Note: ${note}`);
  }
  if (m.coverageNote) {
    out.push(`  Note: ${m.coverageNote}`);
  }
  // Spacing only: analyzer warnings get a separating blank line before the
  // findings, exactly as this surface always printed them; the untracked and
  // coverage notes alone flow straight into the list.
  if (warnings.length > 0) out.push("");

  if (m.findings.length === 0) {
    out.push(`  ${NO_FINDINGS_COPY}`);
    out.push("");
  } else {
    const parts: string[] = [];
    for (const tier of TIER_ORDER) {
      if (m.counts[tier]) parts.push(`${m.counts[tier]} ${TIER_WORD[tier]}`);
    }
    out.push(`  EVIDENCE  ${parts.join(" · ")}`);
    // Named right under the tier counts, not buried in a footer: a ● or ○
    // badge asserts "a machine looked at this", and that assertion is only
    // checkable if the reader also knows which machine. The gate — a model
    // name AND a model-derived tier below — is the model's; `provenance` is
    // simply absent otherwise.
    if (m.provenance) {
      out.push(`  MODEL     ${m.provenance}`);
    }
    // Under the provenance line, or under EVIDENCE when there is none, and
    // before the blank line that separates the header from the findings: the
    // badge is explained before the reader meets it.
    if (m.beyondIntentLegend) {
      out.push(`  ${m.beyondIntentLegend}`);
    }
    out.push("");

    for (const f of m.findings) {
      out.push(
        `  ${f.glyph} ${plainText(f.headline)}  [${f.tier}]` +
          (f.beyondIntent ? `  (${f.beyondIntent})` : ""),
      );
      for (const paragraph of f.body) {
        out.push(...wrap(plainText(paragraph), BODY_WIDTH, "    "));
      }
      if (f.tier === "model" && f.modelNote) {
        // A model-tier finding's whole body is the model's prose, carried in
        // `modelNote` so it can never travel without attribution. On this
        // surface the [model] badge on the headline is that attribution, as
        // it always was, and the prose prints as the body.
        out.push(...wrap(plainText(f.modelNote.text), BODY_WIDTH, "    "));
      } else if (f.modelNote && m.modelName) {
        // The analyzer's paragraphs already said what was found; this is the
        // model's added explanation of why it matters, labelled rather than
        // folded silently into the same paragraph — a reader deciding how
        // much to trust an [inferred] finding needs to see the two apart.
        //
        // Gated on the recorded model name, not just the note's presence:
        // model prose with no name attached to it is the one rendering state
        // this surface must never produce, and the provenance line above is
        // under the same gate. See `test/report/terminal.test.ts`, "never
        // prints model prose without its attribution".
        out.push(...wrap(`model: ${plainText(f.modelNote.text)}`, BODY_WIDTH, "    "));
      }
      // The evidence is the point. A tier badge with nothing checkable under
      // it asks the reader to take the claim on faith, which is exactly what
      // "verified" is supposed to replace.
      for (const e of f.evidence.slice(0, EVIDENCE_SHOWN)) {
        out.push(`      ${location(e)}  ${excerpt(e.excerpt)}`);
      }
      const rest = f.evidence.length - EVIDENCE_SHOWN;
      if (rest > 0) out.push(`      … ${rest} more`);
      out.push("");
    }
  }

  // Composed by the model (see `ReportModel.filterNote`); absent entirely
  // when nothing was suppressed — see `test/report/terminal.test.ts`,
  // "prints no filter footnote when nothing was suppressed".
  if (m.filterNote) {
    out.push(`  ${m.filterNote}`);
    out.push("");
  }

  // Outside the findings branch on purpose: a clean review (no findings)
  // still writes a report, and the reader needs to be told where it went
  // exactly as much as a reader who scrolled past a full list of findings
  // does — see `test/report/terminal.test.ts`, "prints the report path even
  // when there are no findings". The path is the one string on this surface
  // that does not come from the model, so the walker labels it itself.
  if (reportPath) {
    out.push(`  Full report: ${labelConcealed(reportPath)}`);
    out.push("");
  }

  return out.join("\n");
}
