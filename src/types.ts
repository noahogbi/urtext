import type ts from "typescript";

/** Sentinel revision: read files from the working tree rather than git. */
export const WORKTREE = "WORKTREE";

/**
 * Directory, relative to the repository root, that urtext writes its own
 * reports into. Lives here rather than in `report/write.ts` because
 * `extract/diff.ts` needs it too — the untracked-file count has to leave
 * urtext's own output out — and neither of those two modules should have to
 * import the other to agree on the name.
 */
export const REPORT_DIR = ".urtext";

export interface RevRange {
  /** Revision to treat as "before". A commit-ish. */
  from: string;
  /** Revision to treat as "after". A commit-ish, or WORKTREE. */
  to: string;
  /** Human-readable description, e.g. "vs origin/main". */
  label: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "enum"
  | "variable";

export interface ChangedSymbol {
  name: string;
  /**
   * Dotted path through every scope that encloses the declaration —
   * "Gamma.method", "wrapper.local", "N.x" — and equal to `name` only for a
   * declaration at the top level of the file. Identity is keyed on this, not
   * on `name`: two classes in one file may each declare `render`, and a
   * function's local may share a name with an export beside it. A scope with
   * no name of its own contributes a sentinel rather than nothing (see
   * `extract/scope.ts`), so this is qualified all the way up in every case.
   */
  qualifiedName: string;
  kind: SymbolKind;
  /**
   * Carries an `export` modifier at the top level of the file. Deliberately not
   * phrased as "is part of the file's public surface", because it is narrower
   * than that: a declaration exported by a separate statement — `function
   * helper() {}` plus `export { helper }` — has no modifier of its own, comes
   * out `false`, and so gets no blast radius and no row in the report's
   * API-surface table. That table lists the omission rather than implying it
   * covers everything. A namespace member is `false` too, and that one is
   * right: an importer reaches it through the namespace, not by its bare name,
   * which is the only name `blastRadiusAnalyzer` can look up. A class member is
   * always `false`.
   */
  exported: boolean;
  /** 1-based, inclusive, in the "after" file. Zero for removed symbols. */
  range: { startLine: number; endLine: number };
  change: "added" | "modified" | "removed";
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  previousPath?: string;
  hunks: Hunk[];
  /** Empty for files that are not TypeScript. */
  symbols: ChangedSymbol[];
}

export interface Changeset {
  range: RevRange;
  files: ChangedFile[];
  /**
   * Untracked files present in the working tree, which `git diff` omits and
   * this changeset therefore does not describe. Reported so their absence is
   * visible; zero when the range ends at a commit.
   */
  untrackedCount?: number;
}

export type EffectKind =
  | "network"
  | "filesystem"
  | "process"
  | "env"
  | "database"
  | "timing";

export type FactKind =
  | "effect_added"
  | "effect_removed"
  | "guard_removed"
  | "export_added"
  | "export_removed"
  | "signature_changed"
  | "blast_radius"
  | "citation_rot"
  | "dependency_added"
  | "dependency_removed"
  | "dependency_changed"
  | "lockfile_out_of_sync"
  | "dependency_resolved_changed"
  | "lockfile_version_stale"
  | "lockfile_tree_changed";

export interface EvidenceRef {
  file: string;
  line: number;
  excerpt: string;
  /**
   * Which revision `line` counts in. A removal — a guard, an effect, or an
   * export that exists only on the before side — can only be evidenced by
   * before-side text, whose line numbers need not exist in the working tree
   * at all. Rendering that as a bare `path:line` sends anyone clicking
   * through to an unrelated line. Omitted means the after side, which is
   * the common case and needs no annotation.
   */
  side?: "before" | "after";
}

export interface Fact {
  /**
   * Stable within a single run; referenced by a model claim's
   * `correspondsTo` in Plan 3, which is what introduces model claims.
   */
  id: string;
  kind: FactKind;
  /** Always equal to `evidence[0].file` — see `makeFact`, which derives it. */
  file: string;
  /** Always equal to `evidence[0].line` — see `makeFact`, which derives it. */
  line: number;
  /**
   * The dotted path to the symbol this fact is about — `Worker.run`, not
   * `run` — for the same reason `ChangedSymbol.qualifiedName` is: two classes
   * in one file may each declare `render`, and a method may share a name with
   * a top-level export. Named for the qualification rather than called
   * `symbol` because `foldReach` matches facts across analyzers on
   * (`file`, this): an analyzer that filled it with a bare name handed one
   * symbol's reference count to another symbol's finding, and the field's
   * old name made that look correct at every call site. Omitted by
   * file-scoped facts, which are about no symbol at all.
   */
  qualifiedSymbol?: string;
  detail: Record<string, unknown>;
  /** At least one. A fact that cannot show its evidence is not emitted. */
  evidence: EvidenceRef[];
}

export type Tier = "verified" | "inferred" | "model";

export interface Finding {
  id: string;
  tier: Tier;
  file: string;
  line: number;
  /** One line, shown as the finding headline. */
  title: string;
  /** One or two sentences of supporting explanation. */
  body: string;
  score: number;
  evidence: EvidenceRef[];
  /**
   * How widely the changed symbol is used, when known. Not a finding of its
   * own — an amplifier on this one. See `foldReach`.
   */
  reach?: { references: number; sites: EvidenceRef[] };
  /** The model's reasoning, when a claim contributed to this finding. */
  claim?: { summary: string; reasoning: string };
  /**
   * Carried over from the claim behind this finding; see `Claim.beyondIntent`.
   * Lives here rather than inside `claim` so both reconcile paths set one
   * field and `toFindingView` reads one field — a standalone finding has no
   * `claim` object to hang it on. Never present on a `verified` finding: see
   * `test/score/reconcile.test.ts`, "never renders a marker on a verified
   * finding".
   */
  beyondIntent?: true;
}

/**
 * A model's interpretation of a change. A claim is not evidence: it carries
 * no `EvidenceRef` of its own, and it can never overwrite a fact. It either
 * annotates a fact — earning that fact's finding a richer explanation — or
 * stands alone as something the analyzers did not see, labeled `model` so a
 * reader knows to check it.
 */
export interface Claim {
  id: string;
  file: string;
  line: number;
  /** One sentence, shown as the finding headline when the claim stands alone. */
  summary: string;
  /** Why this matters. Shown as the body. */
  reasoning: string;
  /**
   * The model's own 0..1 severity, advisory only. `reconcile` clamps it
   * defensively (non-finite or out-of-range input becomes 0..1) before
   * scaling a standalone finding's score, and that scale's ceiling sits
   * strictly below the weakest score any analyzer fact can produce — so
   * severity can move a claim within the model tier but never lift it past
   * a fact.
   */
  severity: number;
  /** `Fact.id` this claim restates or explains, when it corresponds to one. */
  correspondsTo?: string;
  /**
   * Set when the model says the change does something its stated intent does
   * not account for. Absent or `true`, never `false`: there is no "covered by
   * the stated intent" finding, only the absence of a mark.
   */
  beyondIntent?: true;
}

export interface InterpretResult {
  claims: Claim[];
  /**
   * The model that produced them, for the report's provenance line. Empty
   * when the stage was skipped: a model that was merely *requested* produced
   * nothing, and naming it would attribute a stage that never ran.
   */
  model: string;
  /** Set when the stage did not run; the reason is shown to the user. */
  skipped?: string;
  /**
   * What the reader is owed about the stated intent when the stage ran but
   * could not compare against a complete one. Mutually exclusive with
   * `skipped`: a stage that did not run has nothing to say about intent. See
   * `test/interpret/index.test.ts`, "never carries both a skipped reason and
   * an intent note".
   */
  intentNote?: string;
}

export interface AnalysisContext {
  cwd: string;
  range: RevRange;
  /** File contents at a revision, or null if absent there. */
  readAt(rev: string, path: string): Promise<string | null>;
  /**
   * A type-checked program at a revision. Built lazily and memoized —
   * constructing one parses every TypeScript file in the repository, so
   * analyzers that do not need the checker must not call this.
   */
  programAt(rev: string): Promise<ts.Program>;
}

export type Analyzer = (
  changeset: Changeset,
  ctx: AnalysisContext,
) => Promise<Fact[]>;
