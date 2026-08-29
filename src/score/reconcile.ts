import type { Claim, Fact, Finding } from "../types.js";
import { minPossibleAnalyzerScore, rankWithAbsorption, tierFor } from "./index.js";
import { referenceCount } from "./reach.js";

/**
 * Strictly below `minPossibleAnalyzerScore()` (currently 6, an
 * `effect_removed` timing effect) — never the raw `WEIGHTS.factKind`
 * minimum, which ignores the effect multiplier `scoreFact` applies and put
 * the old hardcoded ceiling (14) 8 points above a score an analyzer can
 * actually produce. Derived, not hand-copied, so a future weight change can
 * only move this number, never leave it stale above a fact it is supposed
 * to sit under.
 */
export const MODEL_CEILING = minPossibleAnalyzerScore() / 2;

/**
 * The model's severity, defensively bounded to the 0..1 range its type
 * documents but does not enforce. `reconcile` is the trust boundary between
 * unbelieved model output and a believed finding, so it must not assume the
 * model behaved: an out-of-range value here is not hypothetical malice, just
 * an unvalidated float from a network response. Unclamped, a `NaN`
 * `severity` would produce a `NaN` score, and `NaN` compares false against
 * everything, so the final sort would stop being a sort for every finding it
 * touches — and an out-of-range value would let the model assign itself a
 * ceiling `reconcile` never agreed to.
 */
function clampSeverity(severity: number): number {
  if (!Number.isFinite(severity)) return 0;
  return Math.min(Math.max(severity, 0), 1);
}

/**
 * The fewest references at which an unabsorbed blast_radius finding that no
 * claim explains still earns a standalone row. "X changed and is referenced
 * in one place" names no problem and barely any cost — a sixth of the first
 * real dogfood report was exactly that row.
 *
 * Enforced here, after model claims attach, and not in `foldReach` where
 * the fact-level fold happens: a claim citing the fact can only attach to a
 * finding that still exists, so filtering earlier silently dropped the
 * claim — the one kind of loss this pipeline is built to refuse. A finding
 * a claim did attach to survives at its normal `inferred` tier, because
 * model context is exactly what promotes the row out of "filler". Only the
 * claim-free standalone row disappears: absorption into siblings happened
 * back in `foldReach`, before any of this, so amplified findings are
 * untouched, and the reach entry itself is recorded regardless.
 * `test/score/reconcile.test.ts` pins the survival edge and both sides of
 * the numeric line, so moving this number either way fails a test.
 */
export const MIN_STANDALONE_REFERENCES = 2;

/**
 * True for the rows `MIN_STANDALONE_REFERENCES` suppresses: a finding that
 * is still a bare blast_radius fact's own row (grouping never produces one
 * and absorption never lets one survive to here), below the threshold, with
 * no claim attached. The fact lookup uses the finding id because an
 * unabsorbed fact's finding keeps its fact's id — anything synthesized
 * (groups, standalone claims) misses the map and is kept.
 */
function isSuppressedStandaloneReach(finding: Finding, byId: Map<string, Fact>): boolean {
  if (finding.claim) return false;
  const fact = byId.get(finding.id);
  if (!fact || fact.kind !== "blast_radius") return false;
  return referenceCount(fact) < MIN_STANDALONE_REFERENCES;
}

/**
 * Merges what the analyzers found with what the model said.
 *
 * The asymmetry is the point: a claim can only ever annotate a fact or
 * stand alone, and a fact survives as a finding whether or not the model
 * mentions it — with exactly one scoped exception, a claim-free lonely
 * blast_radius row under MIN_STANDALONE_REFERENCES, filtered after claims
 * attach and disclosed through `onSuppressed` rather than dropped in
 * silence. The rule is pinned by "keeps every fact except a claim-free
 * sub-threshold reach row as a finding even when the model says nothing"
 * and the exception by "suppresses a claim-free lonely one-reference reach
 * finding", both in test/score/reconcile.test.ts.
 *
 * A claim never edits a fact's file, line, or evidence — if the model
 * asserts a location, it is ignored in favour of the analyzer's, because
 * the analyzer's came from the code.
 *
 * The marker on a claim travels to the finding it lands on and nothing else:
 * `test/score/reconcile.test.ts`, "changes no score and no ordering, with the
 * marker or without it".
 */
export function reconcile(
  facts: Fact[],
  claims: Claim[],
  // Called with how many claims lost the first-claim-wins race below — a
  // later claim naming an already-explained finding is dropped, and the
  // reader cannot know the model said two things about it unless the caller
  // says so. Invoked only when the count is nonzero, so `review` in
  // `../cli.ts` can turn it into one warnings line without branching.
  onDroppedClaims?: (count: number) => void,
  // Called with how many claim-free standalone reach rows the
  // MIN_STANDALONE_REFERENCES filter removed. A row that vanishes from
  // every surface with no trace leaves even the machine-readable output
  // unable to say the filter ran at all — the same disclosure rule as
  // `onDroppedClaims` above, and the same contract: invoked only when the
  // count is nonzero.
  onSuppressed?: (count: number) => void,
): Finding[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const { findings: ranked, absorbedBy, bands: band } = rankWithAbsorption(facts);

  // Indexed so a standalone finding's id can stay unique even when two
  // claims share a model-generated `id` — a model's ids are not guaranteed
  // unique the way a fact's are, so the array position backstops it.
  const indexed = claims.map((claim, i) => ({ claim, i }));

  // Every claim that names a real fact resolves to the id of the finding
  // that fact's information ends up on — its own finding, ordinarily, but
  // `absorbedBy` redirects to whichever finding absorbed it if `rank`
  // folded it into a sibling's reach or a file's export group. The model is
  // shown facts, not findings, so citing a fact that a machine step later
  // merged away is expected behavior, not a mistake — on a real range a
  // large share of facts get folded this way.
  //
  // First claim wins when the target repeats, deterministically: claims are
  // walked in the order they arrived, and once a target finding has an
  // explanation, a later duplicate does not silently override it. This
  // covers two distinct collisions with one rule — two claims naming the
  // same fact, and two claims naming two different facts that both
  // absorbed into the same finding.
  const attachTo = new Map<string, { claim: Claim; factId: string }>();
  // Losers of the first-claim-wins race, counted so the drop is disclosed
  // rather than silent. Dangling references are not in this count: they are
  // dropped for a different, documented reason (below), and counting them
  // here would present "the model named a fact that doesn't exist" as "the
  // model said more about a finding".
  let dropped = 0;
  for (const entry of indexed) {
    const { correspondsTo } = entry.claim;
    // A `correspondsTo` naming no real fact is a dangling reference, not a
    // claim to attach or recover — it is dropped further down by simply
    // never being added here or to the standalone list.
    if (!correspondsTo || !byId.has(correspondsTo)) continue;
    const targetId = absorbedBy.get(correspondsTo) ?? correspondsTo;
    if (!attachTo.has(targetId)) {
      attachTo.set(targetId, { claim: entry.claim, factId: correspondsTo });
    } else {
      dropped++;
    }
  }
  if (dropped > 0) onDroppedClaims?.(dropped);

  const findings = ranked.map((finding) => {
    const entry = attachTo.get(finding.id);
    if (!entry) return finding;
    // `entry.factId` is `entry.claim.correspondsTo` by construction above,
    // so this call is defensive, not a live discrimination: `tierFor` can
    // only ever return `inferred` here. Going through the real function
    // anyway, rather than hardcoding `"inferred"`, keeps this in lockstep
    // with `tierFor`'s own definition of what makes a claim count as
    // corresponding, instead of a second copy of that rule drifting apart
    // from it. `fact` is always defined here: `attachTo` only ever stores a
    // `factId` that passed `byId.has(...)` above, but a `Map.get` cannot
    // carry that proof through its return type, so the guard stays as the
    // narrowing it is rather than a `!` assertion claiming more certainty
    // than the compiler has.
    const fact = byId.get(entry.factId);
    if (!fact) return finding;
    return {
      ...finding,
      tier: tierFor(fact, entry.claim),
      claim: { summary: entry.claim.summary, reasoning: entry.claim.reasoning },
      // The marker travels with the claim to wherever it attaches, including
      // the attach-to-absorber path: one rule, not two — `attachTo` is
      // already keyed by the finding the claim lands on, so the redirected
      // claim arrives here like any other. Spread conditionally because the
      // field is absent-or-true — there is no "not beyond intent" state to
      // write.
      ...(entry.claim.beyondIntent ? { beyondIntent: true as const } : {}),
    };
  });

  // After the claims are on, not before — see MIN_STANDALONE_REFERENCES.
  const kept = findings.filter((f) => !isSuppressedStandaloneReach(f, byId));
  if (kept.length < findings.length) onSuppressed?.(findings.length - kept.length);

  // Only a claim with no `correspondsTo` at all stands alone. One that names
  // a `correspondsTo` pointing at no real fact is a dangling reference, not
  // a standalone observation — it is dropped rather than promoted, because
  // treating "the model named a fact that doesn't exist" the same as "the
  // model wasn't talking about a fact" would let a wrong id manufacture a
  // finding out of nothing.
  const standalone = indexed
    .filter(({ claim }) => !claim.correspondsTo)
    .map(
      ({ claim, i }): Finding => ({
        id: `claim:${i}:${claim.id}`,
        tier: "model",
        file: claim.file,
        line: claim.line,
        title: claim.summary,
        body: claim.reasoning,
        // MODEL_CEILING already sits strictly below the weakest score an
        // analyzer can produce, so a severity clamped to [0, 1] scales this
        // linearly up to — at maximum severity, reaching, but by
        // construction never crossing — that ceiling.
        score: clampSeverity(claim.severity) * MODEL_CEILING,
        evidence: [],
        ...(claim.beyondIntent ? { beyondIntent: true as const } : {}),
      }),
    );

  // The band `rankWithAbsorption` applied, carried through here because this
  // sort runs last and would otherwise discard it. Not hypothetical: the band
  // was added there alone first, and a unit test over `rank` passed while the
  // shipped ordering never moved — `rank` is not the path a review takes.
  //
  // Taken from that call rather than recomputed from `facts`: a grouped
  // finding's id belongs to no fact, so anything derived here would answer for
  // none of them. A standalone model claim comes from no fact either, has no
  // entry, and so lands in the defect band — score still orders it against
  // other defects, and it now sits above every context row regardless of
  // score, which is right for a finding that alleges a problem.
  return [...kept, ...standalone].sort(
    (a, b) =>
      (band.get(a.id) ?? 0) - (band.get(b.id) ?? 0) ||
      b.score - a.score ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      // Final tiebreak so the sort is total: without it, findings tied on
      // score/file/line fall back to array (insertion) order, which is an
      // accident of iteration, not a guarantee.
      a.id.localeCompare(b.id),
  );
}
