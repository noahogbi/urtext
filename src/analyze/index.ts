import type { AnalysisContext, Analyzer, Changeset, Fact } from "../types.js";
import { blastRadiusAnalyzer } from "./blast-radius.js";
import { citationsAnalyzer } from "./citations.js";
import { dependencyAnalyzer } from "./dependencies.js";
import { effectsAnalyzer } from "./effects.js";
import { guardsAnalyzer } from "./guards.js";
import { lockfileAnalyzer } from "./lockfile.js";
import { surfaceAnalyzer } from "./surface.js";

export { detectEffects, effectsAnalyzer } from "./effects.js";
export { collectGuards, guardsAnalyzer } from "./guards.js";
export { exportedSignatures, surfaceAnalyzer } from "./surface.js";
export { countReferences, blastRadiusAnalyzer } from "./blast-radius.js";
export { citationsAnalyzer, makeCitationsAnalyzer } from "./citations.js";
export { dependencyAnalyzer, makeDependencyAnalyzer } from "./dependencies.js";
export { lockfileAnalyzer, makeLockfileAnalyzer } from "./lockfile.js";
export { createProgramAt, listProgramSourcesAt } from "./program.js";

export { makeFact } from "./fact.js";

export const ANALYZERS: Analyzer[] = [
  effectsAnalyzer,
  guardsAnalyzer,
  surfaceAnalyzer,
  blastRadiusAnalyzer,
  citationsAnalyzer,
  dependencyAnalyzer,
  lockfileAnalyzer,
];

/** One analyzer that threw, named so the user knows what is missing. */
export interface AnalyzerFailure {
  analyzer: string;
  message: string;
}

/**
 * Runs every analyzer and returns the facts from the ones that succeeded.
 *
 * `Promise.allSettled`, not `Promise.all`: one compiler-API or git failure
 * used to discard every analyzer's facts and exit non-zero, so a single
 * unreadable revision turned a review with three real findings into no
 * review at all. A degraded review beats no review — but only if the
 * degradation is visible, which is what `onFailure` is for. Callers that
 * pass no handler get the facts and no indication anything was lost, so
 * anything user-facing should pass one.
 */
export async function runAnalyzers(
  changeset: Changeset,
  ctx: AnalysisContext,
  analyzers: Analyzer[] = ANALYZERS,
  onFailure?: (failure: AnalyzerFailure) => void,
): Promise<Fact[]> {
  const results = await Promise.allSettled(
    analyzers.map((a) => a(changeset, ctx)),
  );
  const facts: Fact[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      facts.push(...result.value);
      return;
    }
    const reason: unknown = result.reason;
    onFailure?.({
      // An anonymous arrow assigned to a typed const takes the binding's
      // name (NamedEvaluation of the variable declaration), so `.name` is
      // "surfaceAnalyzer" rather than "" for every analyzer declared that
      // way. The one a factory returns states its name outright instead,
      // because a transform that renames shadowed bindings would otherwise
      // rewrite it — see `makeCitationsAnalyzer` in `./citations.ts`.
      analyzer: analyzers[i].name || `analyzer #${i + 1}`,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });

  return facts;
}
