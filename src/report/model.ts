import { labelConcealed, segmentConcealed, type ConcealSegment } from "./conceal.js";
import {
  citationDistributionNote,
  deletedFilesNote,
  deletedTypeScriptFiles,
  suppressionNote,
  unanalyzedFiles,
  unanalyzedFilesNote,
} from "./coverage.js";
import type { Changeset, Finding, FactKind, Tier } from "../types.js";

// Flat surfaces (terminal, Markdown, PDF) join segmented fields through
// `plainText` and never re-derive concealment themselves; re-exported here
// so a walker needs only this module to walk the model.
export { plainText } from "./conceal.js";
export type { ConcealSegment } from "./conceal.js";

/**
 * The one report model every output surface walks. The terminal and HTML
 * renderers each walked the findings themselves and shared honesty copy
 * piecemeal, and two drift bugs shipped from exactly that split — the
 * terminal missing the concealment defense the HTML had, and the HTML
 * missing the filter disclosure the terminal had. Everything a surface may
 * say about *content* — which findings, in what order, at what tier, with
 * which disclosures — is decided here, once; a renderer applies format
 * mechanics (escaping, wrapping, typesetting) and its own phrasing of the
 * same truth, never a decision of its own.
 *
 * Concealment happens here, while the model is built, and it is structural:
 * content-bearing fields are `ConcealSegment` arrays in which a concealed
 * character is a segment of its own, so a walker can style it without ever
 * parsing labels back out of flattened text — a flattened label cannot be
 * told apart from source code that literally spells it. Identifier-shaped
 * fields (file paths, the range label, the coverage note, warnings, the
 * model name) stay `labelConcealed` strings, a ruled exception recorded in
 * the design spec's addendum. Either way no raw concealing character
 * survives into the model — see `test/report/model.test.ts`, "carries no
 * raw concealing character anywhere: titles, bodies, headlines, file paths,
 * the range label, warnings, the model name, and the coverage note". Where
 * a sentence is shared verbatim by the existing surfaces it is composed
 * here (or reached through `./coverage.js`, which keeps its composing
 * functions); where the surfaces phrase one truth differently, the model
 * carries the pieces and each walker keeps its phrasing.
 */

export interface ReportMeta {
  model?: string;
  /**
   * Every reason this run fell short of its full pipeline, in the order they
   * happened: a dead analyzer, a skipped interpretation stage, a report that
   * could not be written. One list, because they are one thing to a reader —
   * and because a second field for the skipped stage meant `review` in
   * `../cli.ts` filled both and the banner printed that line twice.
   */
  warnings: string[];
  /**
   * How many claim-free standalone reach rows reconcile's filter removed.
   * Not folded into `warnings`: the filter running as designed is not a
   * shortfall, and its disclosure must not trip the "This review is
   * partial." banner. Composed into `ReportModel.filterNote` with
   * `suppressionNote`, the same sentence both surfaces print.
   */
  suppressed?: number;
  /**
   * Whether this run swept the repository for citations rather than checking
   * only the ones the reviewed range touched — `--citations`.
   *
   * The only part of the distribution note the model cannot work out for
   * itself: which findings are citations it already knows, from the same
   * id-prefix routing that gives every finding its `subject`. Why they were
   * collected is the caller's knowledge. Default-mode citations are scoped
   * to the change and few, and a note describing where three findings landed
   * is noise; a sweep's shape is the thing a reader needs.
   */
  citationSweep?: boolean;
  /**
   * Where the HTML report was written, absent when none was — a review that
   * failed hard enough writes none, and the surfaces say so.
   */
  reportPath?: string;
  /** The exports that were written, in the order they were requested. */
  exportPaths?: { format: "md" | "pdf"; path: string }[];
}

export type Lens = "narrative" | "effects" | "surface";

/**
 * What a finding is about — finer than `Lens`, and carried beside it because
 * the HTML report needs the distinction the lens alone erases: its effects
 * pane splits "effect" from "guard" into separate sections and shows
 * "surface" findings a second time under Contracts. See
 * `test/report/model.test.ts`, "keeps the finer subject beside the lens, so
 * a walker can split effects from guards and show contracts in both panes".
 * "reach", "citation" and "dependency" have no filtered lens of their own —
 * a standalone reach finding, a citation finding, and a dependency finding
 * each appear in the narrative only, which the effects pane's note says out
 * loud.
 */
export type Subject = "effect" | "guard" | "surface" | "reach" | "citation" | "dependency";

export interface EvidenceView {
  file: string;
  line: number;
  /**
   * Concealment-segmented source text; flat surfaces join it with
   * `plainText`, and renderers add only format escaping.
   */
  excerpt: ConcealSegment[];
  /**
   * Which revision `line` counts in, copied from `EvidenceRef`: a before-side
   * line very often points somewhere unrelated in the working tree, and every
   * surface owes the reader that warning. Omitted means the after side.
   */
  side?: "before" | "after";
}

export interface ReachView {
  /** Deduped count, exactly as rank computed it. */
  references: number;
  /** Deduped sites, capped at REACH_SITES_SHOWN exactly as the HTML is today. */
  sites: EvidenceView[];
  /** Count of collected-but-not-shown sites. */
  overflow: number;
}

export interface ModelNoteView {
  /** Never empty: an unnamed model renders as UNNAMED_MODEL, the existing fallback copy. */
  model: string;
  /** The model's prose, concealment-segmented. */
  text: ConcealSegment[];
  /**
   * The trust caveat rendered with the prose — which of the two fixed
   * sentences depends on whether the prose stands alone or explains an
   * analyzer's finding. Carried in the note rather than chosen by a
   * renderer, so no surface can pick the weaker caveat for the stronger
   * claim.
   */
  caution: string;
}

export interface FindingView {
  id: string;
  tier: Tier;
  /** TIER_GLYPH[tier], chosen here, once. */
  glyph: string;
  /** Kind-prefix routing lives here, once. */
  lens: Lens;
  /** See `Subject`; absent for a standalone model claim or an unprefixed id. */
  subject?: Subject;
  /**
   * `file:line — title`, with a before-side anchor marked — segmented from
   * the raw composition, so a concealing character in the path or title is
   * a segment here even though `file` below is a flattened string. Joined
   * with `plainText` it reads exactly as the terminal prints it. The pieces
   * below let the HTML compose its own split headline without re-deciding
   * any of them.
   */
  headline: ConcealSegment[];
  /** Concealment-segmented title, lowercase-led as `toFinding` composes it. */
  title: ConcealSegment[];
  file: string;
  line: number;
  /**
   * The anchor's side, from the first evidence ref — a fact's file and line
   * are derived from that ref (see `makeFact`), so its side annotation
   * applies to the headline too. A model-tier finding carries no evidence
   * and no side, which is correct rather than incidental: its location is
   * the model's own, in the after revision.
   */
  side?: "before" | "after";
  /**
   * Analyzer-authored paragraphs, each concealment-segmented. Empty for a
   * model-tier finding: its whole body is model prose, and all model prose
   * lives in `modelNote` so no surface can render it without attribution —
   * see `test/report/model.test.ts`, "moves model-tier prose into the
   * attributed model note, leaving no bare body".
   */
  body: ConcealSegment[][];
  /** Prose and attribution inseparable, as today. */
  modelNote?: ModelNoteView;
  /**
   * Every ref, uncapped: the HTML shows all of them. The terminal's
   * shorter list is presentation density, applied by that walker.
   */
  evidence: EvidenceView[];
  reach?: ReachView;
  /**
   * BEYOND_INTENT_MARK, present only when the claim behind this finding set
   * `beyondIntent`. Carries the words rather than a boolean so no renderer
   * composes them; absent or the mark, never a "not marked" string. See
   * `test/report/model.test.ts`, "carries the mark's words, composed here so
   * no renderer composes them".
   */
  beyondIntent?: string;
}

/**
 * One exported declaration in the API-surface table. Exactly the fields
 * `surfaceLens` renders and nothing else from the changeset: a whole
 * `Changeset` on the model would carry raw, author-controlled text through a
 * model whose cleanliness is enforced by stringifying it — see
 * `test/report/model.test.ts`, "carries no raw concealing character
 * anywhere", whose fixture plants one in the range label.
 *
 * Supersedes the 2026-08-19 design's addendum ruling 3, which kept symbols
 * out of the model and concealed them renderer-side. The table is rendered to
 * a reader, so "changeset data, not report content" was pragmatic rather than
 * principled, and it cost this project its one renderer-side concealment path.
 */
export interface SurfaceSymbolView {
  /**
   * Kept as its union rather than segmented: a controlled vocabulary this
   * project writes, not text from the reviewed change, and the HTML uses it
   * for a class name as well as copy.
   */
  change: "added" | "modified" | "removed";
  qualifiedName: ConcealSegment[];
  kind: ConcealSegment[];
  file: ConcealSegment[];
}

/**
 * One entry in the intent-gap index: a finding the model marked as not
 * accounted for by this range's messages.
 *
 * `file` and `line` stay structured rather than pre-joined into a display
 * string, so `--json` consumers get the shape `findings` gives them and each
 * surface formats the location in its own idiom.
 */
export interface IntentGapEntry {
  /** The `findings` entry this points at, so a `--json` consumer can join. */
  id: string;
  tier: Tier;
  /**
   * What the entry is: a fact-backed finding's kind, or a standalone claim's
   * summary. Segmented, never a plain string — for a standalone claim this is
   * model prose from a network response, and every content field carries
   * `ConcealSegment[]` so no raw concealing character reaches a surface.
   */
  label: ConcealSegment[];
  /** Labeled, like `FindingView.file` and for the same reason. */
  file: string;
  line: number;
}

export interface ReportModel {
  /** "44 files, 2384 lines changed · vs master" — the terminal's wording. */
  scope: string;
  /** The scope pieces, for the HTML's own phrasing of the same numbers. */
  fileCount: number;
  /** Insertions and deletions both: summing only the after side reported nothing changed for a pure deletion. */
  lineCount: number;
  rangeLabel: string;
  counts: { verified: number; inferred: number; model: number };
  /**
   * Present only under the gate both surfaces use today: a model name AND at
   * least one inferred/model finding. A tier badge asserts a machine looked,
   * and that assertion is only checkable if the reader knows which machine.
   * See `test/report/model.test.ts`, "gates provenance on a model name AND a
   * model-derived tier".
   */
  provenance?: string;
  /**
   * The recorded model name, labeled, absent when the run never named one.
   * Deliberately carried beside the gated `provenance`: the terminal
   * suppresses claim prose entirely when no model is named, and a walker
   * cannot apply that gate from `provenance` alone once every finding is
   * verified.
   */
  modelName?: string;
  /**
   * Every reason the review fell short, in order — analyzer failures,
   * skipped interpretation, then the untracked-file note. Non-empty means
   * the surface must say the review is partial.
   */
  notes: string[];
  /**
   * The deleted-file coverage note from `deletedFilesNote`; absent when no
   * TypeScript file was deleted. Deliberately NOT in `notes`: deleting a
   * TypeScript file is routine, and a partial-review banner that fires on
   * every such diff is a banner a reader learns to skip. See
   * `test/report/model.test.ts`, "carries each disclosure exactly once, in
   * the field renderers must read it from".
   */
  coverageNote?: string;
  /**
   * The unanalyzed-files note from `unanalyzedFilesNote`; absent when every
   * changed file either is TypeScript or carries analyzer evidence. Kept out
   * of `notes` for the reason `coverageNote` above is: urtext ran its whole
   * pipeline, so a diff it has no analyzer for is scope rather than
   * shortfall, and a banner firing on every diff that touches a YAML file is
   * one a reader learns to skip.
   */
  unanalyzedNote?: string;
  /**
   * Composed by `suppressionNote`; absent when nothing was suppressed.
   * Deliberately NOT in `notes`: the filter running as designed is not a
   * shortfall and must not trip partial-review copy.
   */
  filterNote?: string;
  /**
   * Composed by `citationDistributionNote`; absent unless this run swept the
   * repository for citations and found some. Deliberately NOT in `notes`,
   * for the reason the two above are not: a sweep that completed is not a
   * partial review, and saying where its findings landed describes the
   * result rather than a shortfall in producing it.
   */
  distributionNote?: string;
  /**
   * What each kind of finding in this review means, once per kind rather than
   * once per finding. Empty when no kind present has guidance. Composed by
   * `kindNotesFor`; see `KIND_NOTES` for why these left the bodies.
   */
  kindNotes: string[];
  /**
   * The findings the model marked as not accounted for by this range's
   * messages, fact-backed entries first. Always present, `[]` included, so a
   * consumer reads it without branching on the key.
   *
   * No entry can be `verified`: the mark reaches a fact-backed finding only
   * through the claim-attachment path, which forces `inferred`. "Marked and
   * verified" is a contradiction rather than a gap — a `verified` finding is
   * one the model said nothing about, and the mark is something the model
   * says.
   */
  intentGap: IntentGapEntry[];
  /**
   * Whose judgement the index is, present exactly when `intentGap` holds a
   * standalone entry. A standalone claim's summary appearing in the index is
   * the same sentence `modelNote` carries with attribution elsewhere, in a
   * less-attributed place, and a bare tier tag is weaker than
   * `MODEL_CAUTION_STANDALONE` requires. Every surface renders this
   * unconditionally when present.
   *
   * Gated on standalone entries only: a fact-backed entry's label is a kind,
   * not model prose, so the caution would be describing something that is not
   * there.
   */
  intentGapAttribution?: string;
  /**
   * BEYOND_INTENT_MEANING, present exactly when at least one finding carries
   * the mark. Deliberately NOT in `notes`: a badge doing its job is not a
   * shortfall, and it must not trip partial-review copy — the same rule
   * `filterNote` and `coverageNote` are separate fields for. See
   * `test/report/model.test.ts`, "keeps the legend out of notes, so a badge
   * doing its job never trips partial-review copy".
   */
  beyondIntentLegend?: string;
  /**
   * In rank order; renderers must not reorder — see
   * `test/report/model.test.ts`, "preserves rank order exactly". A walker
   * may group by `lens` or `subject` but preserves this order within a
   * group and may never drop a finding.
   */
  findings: FindingView[];
  /**
   * The exported declarations the API-surface pane tabulates, in changeset
   * order. Always present, empty included — a walker iterates without
   * branching.
   */
  surfaceSymbols: SurfaceSymbolView[];
  /** `labelConcealed` applied, like every other path the model carries. */
  reportPath?: string;
  /** Always present, empty included. */
  exportPaths: { format: "md" | "pdf"; path: string }[];
}

/**
 * The order every surface lists the tiers in: strongest evidence first.
 * Owned here so no walker can shuffle its counts, chips, or legend into a
 * sequence the other surfaces do not use.
 */
export const TIER_ORDER = ["verified", "inferred", "model"] as const satisfies readonly Tier[];

/**
 * The lens display order and headings, owned here for the same reason
 * `TIER_ORDER` owns the tier sequence: the HTML's tab strip and the
 * Markdown's section headings both read from this one constant, and two
 * walkers with private copies of an order are two orders waiting to diverge.
 */
export const LENSES = [
  { key: "narrative", label: "Narrative" },
  { key: "effects", label: "Effects & contracts" },
  { key: "surface", label: "API surface" },
] as const satisfies ReadonlyArray<{ key: Lens; label: string }>;

/**
 * What an empty lens says: a sentence about the filter, never about the
 * code. A lens is a view over findings the model classified by id prefix,
 * and if that classification ever stops matching what the analyzers emit,
 * the empty pane is what a user sees — so it must not be able to claim
 * nothing changed while a removed guard sits ranked first elsewhere in the
 * report. Shared by the HTML's empty effects pane and the Markdown's empty
 * sections; a surface may append its own pointer to where the findings are,
 * but the filter-shaped sentence itself is single-sourced here.
 */
export const EMPTY_LENS_COPY = "Nothing in this range matched this view.";

/**
 * What a findings-free run says — one sentence about the analyzers, never
 * about the code being fine. Shared by the surfaces that state it whole (the
 * terminal and the PDF); the Markdown has no single no-findings line, its
 * lens sections each carry EMPTY_LENS_COPY instead. Owned here for the same
 * reason as EMPTY_LENS_COPY: two walkers with private copies of a sentence
 * are two sentences waiting to diverge.
 */
export const NO_FINDINGS_COPY = "No findings. Nothing in this change tripped an analyzer.";

/**
 * `path:line`, or `path:line (before)` when the line number counts in the
 * before revision rather than the working tree — see `EvidenceView.side`
 * for why the reader is owed that marker. Shared by the flat surfaces
 * (terminal, Markdown, PDF), which had verbatim private copies; the HTML
 * composes its own marked-up location and is deliberately not a consumer.
 */
export function location(ref: { file: string; line: number; side?: "before" | "after" }): string {
  return `${ref.file}:${ref.line}${ref.side === "before" ? " (before)" : ""}`;
}

/** The badge every surface shows on a marked finding. Composed here, once. */
export const BEYOND_INTENT_MARK = "beyond stated intent";

/**
 * What the badge means, stated once per report rather than once per finding.
 * Names the commit messages as the source and says what the comparison is not,
 * because the badge alone reads stronger than the evidence behind it.
 */
export const BEYOND_INTENT_MEANING =
  "“beyond stated intent” means the commit messages in this range do not account for what the change does there. It compares the change against its own description, not against anything a person actually asked for.";

/** The marks both surfaces already print, kept identical so every surface reads as one tool. */
export const TIER_GLYPH: Record<Tier, string> = {
  verified: "▲",
  inferred: "●",
  model: "○",
};

/** The tier's display word — "model-only", not the bare tier value, where a reader sees it. */
export const TIER_WORD: Record<Tier, string> = {
  verified: "verified",
  inferred: "inferred",
  model: "model-only",
};

export const TIER_MEANING: Record<Tier, string> = {
  verified: "an analyzer found this and can point at the code",
  inferred: "an analyzer found it; the explanation is the model's",
  model: "the model alone — nothing mechanical corroborates it",
};

/**
 * The name attached to model prose when the run recorded none. A run that
 * produced model-tier findings without a model name is a bug upstream, not a
 * licence to show the prose bare: the fallback keeps the attribution present
 * and visibly incomplete rather than absent.
 */
export const UNNAMED_MODEL = "an unnamed model";

/** The caveat beside prose the model authored with no fact underneath it. */
export const MODEL_CAUTION_STANDALONE =
  "Nothing mechanical corroborates this. Treat it as a lead to check, not a result.";

/** The caveat beside a claim's explanation of an analyzer's finding. */
export const MODEL_CAUTION_CLAIM =
  "The finding above is an analyzer's. This explanation of why it matters is not.";

/** How many referencing sites a finding lists before it stops listing them. */
export const REACH_SITES_SHOWN = 5;

/**
 * What a grouping pass in `../score/reach.ts` appends to a kind to make the
 * id prefix of the finding that replaces a file's findings of that kind.
 * Written once and composed below, so the two prefixes and the rule that
 * recovers a kind from them (`kindOf`) cannot drift apart.
 */
const GROUP_SUFFIX = "_group";

/** The id `groupAddedExports` gives the finding that replaces a file's added-export findings. */
const EXPORT_GROUP_PREFIX = `export_added${GROUP_SUFFIX}`;

/** The id `groupSignatureChanges` gives the finding that replaces a file's signature_changed findings. */
const SIGNATURE_GROUP_PREFIX = `signature_changed${GROUP_SUFFIX}`;

/**
 * Total over `FactKind` — `satisfies` makes a new kind a compile error here
 * rather than a finding that silently falls out of every lens, unnoticed
 * because nothing names it.
 */
const SUBJECT_OF_KIND = {
  effect_added: "effect",
  effect_removed: "effect",
  guard_removed: "guard",
  export_added: "surface",
  export_removed: "surface",
  signature_changed: "surface",
  blast_radius: "reach",
  citation_rot: "citation",
  dependency_added: "dependency",
  dependency_removed: "dependency",
  dependency_changed: "dependency",
  lockfile_out_of_sync: "dependency",
  dependency_resolved_changed: "dependency",
  lockfile_version_stale: "dependency",
  lockfile_tree_changed: "dependency",
} satisfies Record<FactKind, Subject>;

/**
 * Recovered from the finding's id, not from its prose. Every fact id begins
 * with its `FactKind` and a colon (see `makeFact`'s callers), and the
 * grouping passes key on the same convention — classifying on a title's
 * wording instead would tie every surface to sentences `toFinding` is free
 * to rewrite.
 *
 * A standalone model claim has no subject: `reconcile` prefixes those ids
 * with `claim:`, which matches no kind. That is the intended outcome, not a
 * gap — the filtered lenses show what analyzers proved, and the model's own
 * claims have nothing mechanical behind them to classify.
 *
 * The convention itself is pinned against real analyzer output, not against
 * hand-written ids, by `test/report/html.test.ts`, "every id a real analyzer
 * produces starts with its own fact kind" — a fixture written to match the
 * code cannot notice the code changing.
 */
/**
 * What a kind of finding means, said once for a review rather than once per
 * finding.
 *
 * These sentences used to close every body of their kind. On a real pull
 * request that put "The wider the reach, the more a subtle change costs."
 * on seven consecutive findings and "A changed contract can break callers…"
 * on five more — twelve of fourteen rows above the one finding naming
 * something a person could go and fix, each ending in the same words. The
 * repetition is not merely wasteful: identical closing sentences make
 * adjacent findings scan as one block, which is how a reader skims past the
 * one that differs.
 *
 * They are guidance about the kind, not facts about the finding, so they
 * belong where a reader meets them once. What stays in the body is what only
 * that finding can say.
 *
 * Keyed by kind prefix, matching `subjectOf` above — kind rather than
 * subject because `signature_changed` and `export_added` share the `surface`
 * subject and mean different things.
 */
/**
 * Shared by the three dependency kinds: the calibration a reader needs once
 * per review is the same for all of them, and `kindNotesFor` dedupes by note
 * text so it prints once however many are present.
 */
const DEPENDENCY_NOTE =
  "Dependency findings report the manifest's declared constraints; within a range, the lockfile decides what actually resolves.";

const LOCKFILE_NOTE =
  "Lockfile findings report what package-lock.json records, which is not always what package.json declares.";

export const KIND_NOTES: Record<string, string> = {
  blast_radius: "Reach findings report how widely a changed export is used. Wide reach is not a defect; it is the cost of getting one wrong.",
  signature_changed:
    "A changed contract can break callers without breaking the build at the file that changed, so check the call sites.",
  export_added:
    "Newly exported surface is worth a look, but it cannot break an existing caller.",
  dependency_added: DEPENDENCY_NOTE,
  dependency_removed: DEPENDENCY_NOTE,
  dependency_changed: DEPENDENCY_NOTE,
  lockfile_out_of_sync: LOCKFILE_NOTE,
  dependency_resolved_changed: LOCKFILE_NOTE,
  lockfile_version_stale: LOCKFILE_NOTE,
  lockfile_tree_changed: LOCKFILE_NOTE,
};

/**
 * The kind a finding's id names, with a grouping pass's suffix removed: a
 * group speaks for members that were all of one kind, so it means that kind
 * here. Without this a grouped finding matches no note at all — and grouping
 * happens exactly when a file has several findings of one kind, which is the
 * review that most needs the kind explained.
 *
 * A real kind is answered as itself before the suffix is considered, which
 * matters for a kind whose own name ends in `_group`: stripping first would
 * hand it the note belonging to whatever the remainder happens to name — a
 * wrong sentence, silently, with neither `KIND_NOTES` nor any test able to
 * object. `SUBJECT_OF_KIND` is total over `FactKind` (its `satisfies` makes a
 * missing kind a compile error), so it is the one list here that cannot fall
 * behind the kinds that exist.
 */
/**
 * The index, assembled in two passes, each preserving `findings` order.
 *
 * Not a filter in place. The final sort keys band before score, and a
 * standalone claim's id belongs to no fact, so it takes the defect band by
 * default and sits above every context row regardless of score. Filtering
 * `findings` where they stand would print an evidence-free `model` entry
 * above an analyzer-corroborated `inferred` one, in the report's prime
 * position — the inversion this index exists to avoid.
 *
 * The two orders differ deliberately: `findings` is ordered for triage, where
 * a claim alleging a problem belongs in the defect band; the index is ordered
 * by what a reader can check, where evidence leads.
 */
function intentGapFor(findings: Finding[]): IntentGapEntry[] {
  const marked = findings.filter((f) => f.beyondIntent);
  // Tier, not the id. `kindOf` returns `undefined` only for an id with no
  // colon at all; a standalone claim's id carries a `claim:` prefix, so
  // `kindOf` hands back `"claim"` rather than nothing, and partitioning on it
  // would put every entry in the first pass — collapsing the rule this
  // function exists to implement.
  //
  // Tier is exact here, not approximate: `beyondIntent` is set in exactly two
  // places, and both are in `../score/reconcile.ts`. The attach path sets
  // `tier: tierFor(fact, entry.claim)` where the claim corresponds to the
  // fact by construction, so it can only be `inferred`; the standalone path
  // hardcodes `"model"`. A group is fact-backed and lands in pass one, which
  // tier gives for free — only its *label* is special.
  const factBacked = (f: Finding): boolean => f.tier !== "model";
  const entry = (f: Finding): IntentGapEntry => ({
    id: f.id,
    tier: f.tier,
    label: segmentConcealed(labelFor(f)),
    file: labelConcealed(f.file),
    line: f.line,
  });
  return [
    ...marked.filter(factBacked).map(entry),
    ...marked.filter((f) => !factBacked(f)).map(entry),
  ];
}

/** A group id's kind prefix carries `GROUP_SUFFIX`; `kindOf` strips it. */
function isGroup(id: string): boolean {
  const colon = id.indexOf(":");
  return colon >= 0 && id.slice(0, colon).endsWith(GROUP_SUFFIX);
}

/**
 * A fact-backed finding is named by its kind. A group and a standalone claim
 * are both named by their title: a group's stripped member kind would
 * misdescribe it — calling a seven-export group `export_added` beside one
 * member's `file:line` — and a standalone claim's title is its summary
 * (`../score/reconcile.ts`, where the standalone branch sets
 * `title: claim.summary`).
 */
function labelFor(f: Finding): string {
  if (f.tier === "model") return f.title;
  if (isGroup(f.id)) return f.title;
  return kindOf(f.id) ?? f.title;
}

function kindOf(id: string): string | undefined {
  const colon = id.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = id.slice(0, colon);
  if (Object.hasOwn(SUBJECT_OF_KIND, prefix)) return prefix;
  return prefix.endsWith(GROUP_SUFFIX) ? prefix.slice(0, -GROUP_SUFFIX.length) : prefix;
}

/**
 * The guidance for every kind this review actually produced, deduplicated and
 * in the order the kinds first appear.
 */
function kindNotesFor(findings: Finding[]): string[] {
  // Deduped by note text, not by kind: the three dependency kinds share one
  // sentence and the four lockfile kinds share another, so a review holding
  // several of either owes the reader that sentence once. Identical
  // behaviour for every other kind, whose notes are all distinct.
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const f of findings) {
    const kind = kindOf(f.id);
    if (kind === undefined) continue;
    const note = KIND_NOTES[kind];
    if (note && !seen.has(note)) {
      seen.add(note);
      notes.push(note);
    }
  }
  return notes;
}

function subjectOf(id: string): Subject | undefined {
  const colon = id.indexOf(":");
  // An id with no colon has no kind prefix at all. Slicing to what `indexOf`
  // returns when it finds nothing would instead drop the id's last character
  // and hand back a near-miss that can still match a kind — the one case
  // this function exists to reject. See `test/report/model.test.ts`, "sends
  // an id with no colon to the narrative alone".
  if (colon < 0) return undefined;
  const prefix = id.slice(0, colon);
  if (prefix === EXPORT_GROUP_PREFIX || prefix === SIGNATURE_GROUP_PREFIX) return "surface";
  return Object.hasOwn(SUBJECT_OF_KIND, prefix)
    ? SUBJECT_OF_KIND[prefix as keyof typeof SUBJECT_OF_KIND]
    : undefined;
}

/**
 * The lens a subject's findings are gathered under. Effects and guards share
 * a pane (as two sections); surface findings have their own; a standalone
 * reach finding, a citation finding, and a dependency finding each belong to
 * no filtered pane and live in the narrative, which shows every finding
 * regardless of lens. A rotted citation is not an effect, not a guard, and
 * not a change to the public surface — and neither is a change to what
 * package.json declares, or to what package-lock.json resolves: each belongs
 * to the account of what this change did, which is what the narrative is.
 */
const LENS_OF_SUBJECT: Record<Subject, Lens> = {
  effect: "effects",
  guard: "effects",
  surface: "surface",
  reach: "narrative",
  citation: "narrative",
  dependency: "narrative",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function toEvidenceView(ref: {
  file: string;
  line: number;
  excerpt: string;
  side?: "before" | "after";
}): EvidenceView {
  const view: EvidenceView = {
    file: labelConcealed(ref.file),
    line: ref.line,
    excerpt: segmentConcealed(ref.excerpt),
  };
  if (ref.side) view.side = ref.side;
  return view;
}

function toFindingView(finding: Finding, modelName: string | undefined): FindingView {
  const subject = subjectOf(finding.id);
  const lens = subject ? LENS_OF_SUBJECT[subject] : "narrative";
  // A fact-derived finding has its file:line derived from the first evidence
  // ref (see `makeFact`), so that ref's side annotation applies to the
  // headline too. A model-tier finding carries no evidence at all, so
  // `side` stays undefined and no marker is composed — correctly, since
  // there is no before-side line to warn about.
  const side = finding.evidence[0]?.side;
  const file = labelConcealed(finding.file);
  const title = segmentConcealed(finding.title);
  // Segmented from the RAW composition — not assembled out of the flattened
  // `file` string — so a concealing character in the path stays structural
  // inside the headline even though the standalone `file` field flattens it.
  const headline = segmentConcealed(
    `${finding.file}:${finding.line}${side === "before" ? " (before)" : ""} — ${finding.title}`,
  );

  const attribution = modelName ?? UNNAMED_MODEL;
  // All model-authored prose flows through `modelNote`, whose attribution is
  // built into the same object — there is no field a walker can read model
  // prose from without also holding the model's name and the caution. A
  // model-tier finding's whole body is the model's; an inferred finding
  // keeps its analyzer body and carries the claim's reasoning beside it.
  const modelNote: ModelNoteView | undefined =
    finding.tier === "model"
      ? {
          model: attribution,
          text: segmentConcealed(finding.body),
          caution: MODEL_CAUTION_STANDALONE,
        }
      : finding.claim
        ? {
            model: attribution,
            text: segmentConcealed(finding.claim.reasoning),
            caution: MODEL_CAUTION_CLAIM,
          }
        : undefined;
  const body = finding.tier === "model" ? [] : [segmentConcealed(finding.body)];

  // Reach sites are a sample even before this cap — the analyzer bounds what
  // it collects while counting every reference — so `references` and the
  // site list are reported apart rather than as "N of M". The cap itself is
  // pinned by `test/report/model.test.ts`, "caps reach sites as the HTML
  // report does and counts the overflow".
  const reach: ReachView | undefined =
    finding.reach && finding.reach.sites.length > 0
      ? {
          references: finding.reach.references,
          sites: finding.reach.sites.slice(0, REACH_SITES_SHOWN).map(toEvidenceView),
          overflow: Math.max(finding.reach.sites.length - REACH_SITES_SHOWN, 0),
        }
      : undefined;

  const view: FindingView = {
    id: finding.id,
    tier: finding.tier,
    glyph: TIER_GLYPH[finding.tier],
    lens,
    headline,
    title,
    file,
    line: finding.line,
    body,
    evidence: finding.evidence.map(toEvidenceView),
  };
  if (subject) view.subject = subject;
  if (side) view.side = side;
  if (modelNote) view.modelNote = modelNote;
  if (reach) view.reach = reach;
  if (finding.beyondIntent) view.beyondIntent = BEYOND_INTENT_MARK;
  return view;
}

export function buildReportModel(
  changeset: Changeset,
  findings: Finding[],
  meta: ReportMeta,
): ReportModel {
  const fileCount = changeset.files.length;
  const lineCount = changeset.files.reduce(
    (n, f) => n + f.hunks.reduce((m, h) => m + h.newLines + h.oldLines, 0),
    0,
  );
  const rangeLabel = labelConcealed(changeset.range.label);
  const scope = `${plural(fileCount, "file")}, ${plural(lineCount, "line")} changed · ${rangeLabel}`;

  const counts: Record<Tier, number> = { verified: 0, inferred: 0, model: 0 };
  for (const f of findings) counts[f.tier]++;

  // An empty model name is treated as no name: `InterpretResult.model` is
  // empty when the stage was skipped, and naming an empty string would
  // attribute a stage that never ran.
  const modelName = meta.model ? labelConcealed(meta.model) : undefined;
  const provenance =
    modelName && (counts.inferred > 0 || counts.model > 0)
      ? `${modelName} interpreted this change.`
      : undefined;

  const notes: string[] = meta.warnings.map(labelConcealed);
  const untracked = changeset.untrackedCount ?? 0;
  if (untracked > 0) {
    notes.push(
      `${plural(untracked, "untracked file")} not reviewed — git diff does not include them.`,
    );
  }

  const deleted = deletedTypeScriptFiles(changeset);
  const coverageNote = deleted.length > 0 ? labelConcealed(deletedFilesNote(deleted)) : undefined;
  // Asks what was reported rather than predicting what was read; the reasons
  // that distinction is load-bearing are on `unanalyzedFiles` itself.
  const unanalyzed = unanalyzedFiles(changeset, findings);
  const unanalyzedNote =
    unanalyzed.length > 0
      ? labelConcealed(unanalyzedFilesNote(unanalyzed, changeset.files.length))
      : undefined;

  const suppressed = meta.suppressed ?? 0;
  const filterNote = suppressed > 0 ? suppressionNote(suppressed) : undefined;
  // `subjectOf` is the same id-prefix routing every finding's lens comes
  // from, so the note counts exactly the findings the surfaces label as
  // citations. Only under a sweep: default-mode citations are scoped to the
  // change, and describing where three of them landed is noise.
  const distributionNote = meta.citationSweep
    ? citationDistributionNote(
        findings.filter((f) => subjectOf(f.id) === "citation").map((f) => f.file),
      )
    : undefined;

  // Exported only, in changeset order — the filter and the order the HTML's
  // symbol table has always applied, moved here so the concealment moves with
  // it.
  const surfaceSymbols: SurfaceSymbolView[] = changeset.files.flatMap((file) =>
    file.symbols
      .filter((sym) => sym.exported)
      .map((sym) => ({
        change: sym.change,
        qualifiedName: segmentConcealed(sym.qualifiedName),
        kind: segmentConcealed(sym.kind),
        file: segmentConcealed(file.path),
      })),
  );

  const exportPaths = (meta.exportPaths ?? []).map((e) => ({
    format: e.format,
    path: labelConcealed(e.path),
  }));

  const model: ReportModel = {
    scope,
    fileCount,
    lineCount,
    rangeLabel,
    counts,
    notes,
    findings: findings.map((f) => toFindingView(f, modelName)),
    kindNotes: kindNotesFor(findings),
    intentGap: intentGapFor(findings),
    surfaceSymbols,
    exportPaths,
  };
  if (meta.reportPath) model.reportPath = labelConcealed(meta.reportPath);
  if (provenance) model.provenance = provenance;
  if (modelName) model.modelName = modelName;
  if (coverageNote) model.coverageNote = coverageNote;
  if (unanalyzedNote) model.unanalyzedNote = unanalyzedNote;
  if (filterNote) model.filterNote = filterNote;
  if (distributionNote) model.distributionNote = distributionNote;
  if (model.findings.some((f) => f.beyondIntent)) {
    model.beyondIntentLegend = BEYOND_INTENT_MEANING;
  }
  // The same absent-or-present gating the legend above uses, on the same
  // reasoning: copy that describes something the report does not contain is
  // copy a reader learns to skip.
  if (model.intentGap.some((e) => e.tier === "model")) {
    model.intentGapAttribution =
      `Marked by ${modelName ?? UNNAMED_MODEL}. For model-only entries: ${MODEL_CAUTION_STANDALONE}`;
  }
  return model;
}
