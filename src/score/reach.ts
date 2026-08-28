import type { EvidenceRef, Fact, Finding } from "../types.js";

export interface Reach {
  references: number;
  /**
   * The referencing sites, excluding the declaration — capped at the
   * analyzer's `MAX_EVIDENCE`, unlike `references`, which is the exact,
   * uncapped count. A `Reach` with `references: 300` and a handful of
   * `sites` is correct, not truncated evidence: this list is a sample, not
   * the complete set of referencing sites.
   */
  sites: EvidenceRef[];
}

/**
 * The identity reach is recorded and looked up under. `qualifiedSymbol`, not
 * a bare name: this key is the one place facts from two different analyzers
 * are matched against each other, so a caller that passed an unqualified name
 * would hand one symbol's reference count to a different symbol's finding.
 * `Fact.qualifiedSymbol` is the only thing either call site passes, and its
 * doc comment states the same rule from the other end.
 */
export function reachKey(file: string, qualifiedSymbol: string): string {
  return `${file} ${qualifiedSymbol}`;
}

/**
 * A blast_radius fact's reference count, as the prose states it: the exact
 * counted quantity when the analyzer recorded one, else the evidence list
 * minus the declaration entry that leads it. One derivation, shared by the
 * reach entry `foldReach` writes and the standalone-row suppression in
 * `./reconcile.js` (`MIN_STANDALONE_REFERENCES`) — two hand-copies of this
 * rule could disagree about which findings sit under that threshold.
 */
export function referenceCount(fact: Fact): number {
  return typeof fact.detail.references === "number"
    ? fact.detail.references
    : fact.evidence.length - 1;
}

/**
 * Strips `blast_radius` facts out of the fact list and returns their content
 * as reach, keyed by the symbol they describe.
 *
 * Reach is not a defect. "This export is referenced in 34 places" names no
 * problem on its own — it says how much a problem named by some *other*
 * finding would cost. The spec models it as a scoring input for exactly that
 * reason, and shipping it as a standalone finding made roughly 40% of a real
 * report say nothing actionable. Folding it in turns two adjacent entries
 * into one sentence: "`findByEmail` changed signature; 34 places call it."
 *
 * A blast_radius fact with no sibling finding for the same symbol is kept as
 * a fact, so reach is never silently discarded — it just stops being the
 * headline when something better is available. `absorbedBy` records, for
 * every folded fact, which sibling fact's finding absorbed it: the id a
 * model claim naming the folded fact must be redirected to, since the
 * folded fact no longer produces a finding of its own for that claim to
 * attach to.
 *
 * A symbol can have more than one sibling — a removed guard and a changed
 * signature on the same function both carry that function's path as
 * `qualifiedSymbol`. Which one a claim lands on is not incidental: `factWeight`
 * ranks the candidates (the caller passes `WEIGHTS.factKind`; this module
 * cannot import it directly without importing `./index.js`, which already
 * imports this one), and the heaviest sibling wins, ties broken by fact id
 * so the choice is total. This only decides `absorbedBy`'s target — every
 * sibling is still amplified identically by `rank`, keyed on
 * (file, qualifiedSymbol) rather than on which one absorbed the claim.
 */
export function foldReach(
  facts: Fact[],
  factWeight: (fact: Fact) => number,
): { facts: Fact[]; reach: Map<string, Reach>; absorbedBy: Map<string, string> } {
  const reach = new Map<string, Reach>();
  const absorbedBy = new Map<string, string>();
  const others = facts.filter((f) => f.kind !== "blast_radius");
  const radius = facts.filter((f) => f.kind === "blast_radius");

  const findSibling = (f: Fact): Fact | undefined => {
    const candidates = others.filter(
      (o) =>
        o.file === f.file &&
        o.qualifiedSymbol !== undefined &&
        o.qualifiedSymbol === f.qualifiedSymbol,
    );
    return candidates.reduce<Fact | undefined>((best, candidate) => {
      if (!best) return candidate;
      if (factWeight(candidate) > factWeight(best)) return candidate;
      if (factWeight(candidate) === factWeight(best) && candidate.id < best.id) return candidate;
      return best;
    }, undefined);
  };

  const kept: Fact[] = [];
  for (const f of radius) {
    // Reach is recorded for every blast_radius fact with a symbol,
    // unconditionally — one loop, no extra branch for whether a sibling
    // exists. For a lonely fact (no sibling below) this entry is written
    // but never read: `rank` deliberately does not apply a fact's own
    // reach to itself, and nothing else shares that fact's
    // (file, qualifiedSymbol) key by definition of "lonely". That is a
    // harmless unused map entry, not a feature — do not read anything into
    // it being there.
    if (f.qualifiedSymbol) {
      reach.set(reachKey(f.file, f.qualifiedSymbol), {
        references: referenceCount(f),
        // evidence[0] is the declaration itself; the rest are call sites.
        sites: f.evidence.slice(1),
      });
    }
    const sibling = f.qualifiedSymbol ? findSibling(f) : undefined;
    if (sibling) {
      absorbedBy.set(f.id, sibling.id);
    } else {
      // Every lonely fact is kept here, whatever its reference count —
      // deliberately not the place low-reference rows are filtered. That
      // filter (`MIN_STANDALONE_REFERENCES`, in `./reconcile.js`) runs
      // after model claims attach, because a claim citing this fact can
      // only find it if its finding still exists to attach to; filtering
      // here silently dropped that claim.
      kept.push(f);
    }
  }

  return { facts: [...others, ...kept], reach, absorbedBy };
}

/**
 * The members' reach merged into one entry, with duplicated sites removed.
 * Per-member reference counts are exact, but two members of one group can
 * share a referencing line — a single consumer line naming three of the
 * grouped exports — and a plain sum then reports one place as three
 * places, listing the same site once per member. Every duplicate observed
 * among the collected sites is exactly one such over-count, so the merged
 * count is the sum minus the duplicates seen. Sites the analyzer's
 * evidence cap left uncollected cannot be deduplicated, so in a capped
 * group the count errs toward the raw sum rather than undercounting real
 * references.
 */
function mergedReach(withReach: ReadonlyArray<Finding & { reach: Reach }>): Reach | undefined {
  if (withReach.length === 0) return undefined;
  const seen = new Set<string>();
  const sites: EvidenceRef[] = [];
  let duplicates = 0;
  for (const f of withReach) {
    for (const site of f.reach.sites) {
      const key = `${site.file}:${site.line}`;
      if (seen.has(key)) {
        duplicates++;
      } else {
        seen.add(key);
        sites.push(site);
      }
    }
  }
  const summed = withReach.reduce((sum, f) => sum + f.reach.references, 0);
  return { references: summed - duplicates, sites };
}

const ADDED_EXPORT_THRESHOLD = 3;

/**
 * Collapses a file's added-export findings into one entry once there are
 * enough of them to be noise rather than news. A new module legitimately
 * exports a dozen symbols; listing each as its own finding buries everything
 * that names a problem. `absorbedBy` records, for every collapsed finding,
 * the id of the group finding that replaced it — the id a model claim
 * naming that export must be redirected to.
 */
export function groupAddedExports(
  findings: Finding[],
  threshold: number = ADDED_EXPORT_THRESHOLD,
): { findings: Finding[]; absorbedBy: Map<string, string> } {
  const byFile = new Map<string, Finding[]>();
  const rest: Finding[] = [];

  for (const f of findings) {
    if (!f.id.startsWith("export_added:")) {
      rest.push(f);
      continue;
    }
    const group = byFile.get(f.file) ?? [];
    group.push(f);
    byFile.set(f.file, group);
  }

  const out = [...rest];
  const absorbedBy = new Map<string, string>();
  for (const [file, group] of byFile) {
    if (group.length < threshold) {
      out.push(...group);
      continue;
    }
    const names = group
      .map((f) => f.title.replace(/ is newly exported$/, ""))
      .sort();

    // A grouped export can still carry reach (an added export referenced
    // elsewhere in the same change). Merging keeps that fact from vanishing
    // into the group the way it would if `reach` were simply dropped along
    // with the individual findings that carried it. `references` on a
    // blast_radius-derived `Reach` is always at least one (the analyzer
    // never emits a fact for zero references), so the merged total here is
    // too — `mergedReach` subtracts only duplicates it saw among the sites,
    // never below the distinct count.
    const reach = mergedReach(
      group.filter((f): f is Finding & { reach: Reach } => f.reach !== undefined),
    );
    const places = reach && (reach.references === 1 ? "One place" : `${reach.references} places`);
    // Agrees with `places`'s own number, the same way `toFinding`'s
    // blast_radius branch in `../score/index.ts` does for its "references
    // it" sentence: "one place" takes "references", "N places" takes
    // "reference".
    const verb = reach && reach.references === 1 ? "references" : "reference";
    const reachSentence = reach ? ` ${places} in this repository ${verb} them.` : "";

    const groupId = `export_added_group:${file}`;
    for (const f of group) absorbedBy.set(f.id, groupId);

    out.push({
      id: groupId,
      tier: "verified",
      file,
      line: group[0].line,
      // No file prefix — the renderer already prints `file:line — ` ahead
      // of every title (see the identical fix in `toFinding`'s comment on
      // effect findings).
      title: `exports ${group.length} new symbols`,
      // This group's own facts and nothing else. What newly exported surface
      // means — that it cannot break an existing caller — is true of every
      // added export, so it is said once per review by `KIND_NOTES` in
      // `../report/model.ts` rather than once per finding. Saying it here too
      // would print it directly beneath itself, which is the repetition those
      // notes exist to remove.
      body: `New public surface: ${names.join(", ")}.${reachSentence}`,
      score: Math.max(...group.map((f) => f.score)),
      evidence: group.map((f) => f.evidence[0]),
      ...(reach ? { reach } : {}),
    });
  }

  return { findings: out, absorbedBy };
}

const SIGNATURE_CHANGE_GROUP_THRESHOLD = 3;

/**
 * The hedge appended to a signature_changed body when an after side
 * rendered exactly as `any` and its before side did not. The checker
 * prints `any` both for a genuine widening and for a type it could not
 * resolve at the reviewed revision — a repository whose dependencies are
 * not installed at that revision resolves every import from them this
 * way — and the surface analyzer records only the rendered text, so the
 * sentence hedges instead of asserting either reading. Keyed on that text
 * rather than on a resolution-failure signal from the checker: no public,
 * cheap signal survives to `exportedSignatures`' string output, and deeper
 * detection was deliberately ruled out.
 *
 * Takes the affected export names so the hedge points at the member(s) it
 * is about — an unnamed hedge on a many-member group left the reader
 * guessing which change it hedged. Lives here rather than beside the
 * signature prose in `./index.js` because `groupSignatureChanges` below
 * needs it too, and that module already imports this one.
 */
export function typeUnresolvedNoteFor(names: string[]): string {
  if (names.length === 1) {
    return `If ${names[0]}'s new type reads as any because it could not be resolved at this revision — often missing dependencies at that commit — the change may be narrower than it looks.`;
  }
  return `If the new types of ${names.join(", ")} read as any because they could not be resolved at this revision — often missing dependencies at that commit — those changes may be narrower than they look.`;
}

/**
 * What `groupSignatureChanges` needs to know about a member beyond its
 * `Finding`: the export's name, the was→now sentence its listing line
 * shows, and whether its new type rendered as unresolvable (see
 * `typeUnresolvedNoteFor`). Composed by the caller — `rankWithAbsorption`,
 * which still has the facts in hand — because a `Finding` carries prose,
 * not the name and `before`/`after` detail these are built from.
 */
export interface SignatureChangeDetail {
  name: string;
  sentence: string;
  typeUnresolved: boolean;
}

/**
 * Collapses a file's signature_changed findings into one entry once there
 * are enough of them to be one story rather than several. The first real
 * dogfood run listed ten near-identical rows for one file's exported
 * consts — one shared cause, ten findings burying everything else. Mirrors
 * `groupAddedExports`, above; the same `absorbedBy` contract records, for
 * every collapsed finding, the id of the group finding that replaced it —
 * the id a model claim naming that member must be redirected to.
 *
 * A signature_changed finding with no `details` entry is left ungrouped: a
 * listing line cannot be invented for it, and in production the entry
 * always exists because `rankWithAbsorption` derives the map from the same
 * facts it built the findings from.
 */
export function groupSignatureChanges(
  findings: Finding[],
  details: Map<string, SignatureChangeDetail>,
  threshold: number = SIGNATURE_CHANGE_GROUP_THRESHOLD,
): { findings: Finding[]; absorbedBy: Map<string, string> } {
  const byFile = new Map<string, Finding[]>();
  const rest: Finding[] = [];

  for (const f of findings) {
    if (!f.id.startsWith("signature_changed:") || !details.has(f.id)) {
      rest.push(f);
      continue;
    }
    const group = byFile.get(f.file) ?? [];
    group.push(f);
    byFile.set(f.file, group);
  }

  const out = [...rest];
  const absorbedBy = new Map<string, string>();
  for (const [file, group] of byFile) {
    if (group.length < threshold) {
      out.push(...group);
      continue;
    }
    // Score order, highest first, whatever order the members arrived in:
    // the group scores as its highest member and sums its members' reach,
    // so the member that *drives* those numbers must lead the listing, the
    // evidence, and the group's own anchor — a line-ordered listing let the
    // driver hide behind its file position while the finding asserted its
    // score and reach collectively. Ties fall back to file order, then id,
    // keeping the sort total.
    const members = [...group].sort(
      (a, b) => b.score - a.score || a.line - b.line || a.id.localeCompare(b.id),
    );

    // Every member, uncapped — matching `groupAddedExports`, which lists
    // every name and keeps every anchor. A member that contributes to the
    // group's score or its reach sentence must never be invisible in the
    // finding that speaks for it.
    const listing = members.map((f) => details.get(f.id)!.sentence).join(" ");

    // One hedge for the whole group, not one per member — the unresolved
    // rendering has one cause when it appears here at all, which is the
    // very premise of grouping — but it names exactly the members it is
    // about, so a reader of a many-member group is not left guessing which
    // change it hedges.
    const unresolvedNames = members
      .filter((f) => details.get(f.id)!.typeUnresolved)
      .map((f) => details.get(f.id)!.name);

    // Same shape as `groupAddedExports`' reach handling, for the same
    // reason: a member's folded-in reach must not vanish into the group,
    // and a site two members share must not count as two places.
    const reach = mergedReach(
      members.filter((f): f is Finding & { reach: Reach } => f.reach !== undefined),
    );
    const places = reach && (reach.references === 1 ? "One place" : `${reach.references} places`);
    const verb = reach && reach.references === 1 ? "references" : "reference";
    const reachSentence = reach ? ` ${places} in this repository ${verb} them.` : "";

    const groupId = `signature_changed_group:${file}`;
    for (const f of members) absorbedBy.set(f.id, groupId);

    out.push({
      id: groupId,
      tier: "verified",
      file,
      // The driver's declaration line, since members lead with the highest
      // score: the place the headline sends the reader is the member that
      // earned the group its rank.
      line: members[0].line,
      // Unlike every single-fact title in this module, the file is named in
      // the title even though the renderer already prefixes `file:line — `:
      // a bare "N exports changed their signature" reads as a claim about
      // the whole range, and scoping the headline to its file is worth the
      // repetition.
      title: `${members.length} exports in ${file} changed their signature`,
      // The members' sentences, the hedge when one is owed, the reach when
      // there is any — and no guidance about what a signature change means.
      // That sentence is true of every signature change, so `KIND_NOTES` in
      // `../report/model.ts` says it once for the review; see the identical
      // note on `groupAddedExports`' body, above.
      body: `${listing}${unresolvedNames.length > 0 ? ` ${typeUnresolvedNoteFor(unresolvedNames)}` : ""}${reachSentence}`,
      // The group scores as its highest-scoring member. Grouping is
      // presentation, not amplification: ten same-cause rows folded into
      // one must rank exactly where the most serious of them would have
      // ranked alone, never higher for having company.
      score: Math.max(...members.map((f) => f.score)),
      evidence: members.map((f) => f.evidence[0]),
      ...(reach ? { reach } : {}),
    });
  }

  return { findings: out, absorbedBy };
}
