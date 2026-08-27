import type { EvidenceRef, Fact, FactKind } from "../types.js";

/**
 * How many EvidenceRefs a fact carries at most. Only the excerpted evidence
 * list is capped — counted quantities (`detail.sites`,
 * `detail.references`) stay exact, so the prose never understates a change.
 * Shared by the analyzers that sample evidence (effects, blast-radius) so
 * the cap cannot drift between them; `test/comment-contract.test.ts`
 * derives part of its forbidden set from it, so comments name it rather
 * than restating its value.
 */
export const MAX_EVIDENCE = 5;

/**
 * Everything a Fact needs that is not derivable from its evidence. `file`
 * and `line` are deliberately absent: they are not inputs.
 */
export interface FactInput {
  id: string;
  kind: FactKind;
  qualifiedSymbol?: string;
  detail: Record<string, unknown>;
  evidence: EvidenceRef[];
}

/**
 * The only way an *emitted* Fact is built: every analyzer constructs its
 * facts through this function. (`minPossibleAnalyzerScore` in
 * `../score/index.ts` builds throwaway synthetic Facts directly, but those
 * are scored and discarded, never emitted.)
 *
 * Two rules the spec treats as load-bearing — every fact carries evidence,
 * and `Fact.file`/`Fact.line` name the same place as `evidence[0]` — were
 * previously defended by convention and per-analyzer review. They were
 * broken three times anyway, each time producing a `verified` finding that
 * pointed somewhere the reader could not check. Deriving the location from
 * the evidence instead of accepting it as a parameter makes the broken
 * version unrepresentable: there is no argument to get wrong.
 *
 * Empty evidence throws rather than returning null. An analyzer that
 * reaches this point with nothing to show has a bug in the caller, and a
 * silent drop would hide it; analyzers that legitimately have nothing to
 * report must not call this at all.
 */
export function makeFact(input: FactInput): Fact {
  const anchor = input.evidence[0];
  if (!anchor) {
    throw new Error(
      `makeFact(${input.kind}, id=${input.id}): a fact must carry at least one EvidenceRef`,
    );
  }
  return {
    id: input.id,
    kind: input.kind,
    file: anchor.file,
    line: anchor.line,
    ...(input.qualifiedSymbol === undefined
      ? {}
      : { qualifiedSymbol: input.qualifiedSymbol }),
    detail: input.detail,
    evidence: input.evidence,
  };
}
