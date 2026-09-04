import ts from "typescript";
import { framesFor, MODULE_OWNER, qualifyOwner } from "../extract/scope.js";
import { isSyntacticSource, scriptKindFor } from "../extract/symbols.js";
import { makeFact } from "./fact.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

export interface GuardSite {
  /**
   * Dotted path to the scope the guard runs in — `Worker.run`, `handlers.run`,
   * `N.check`, or a class for a guard in its static initializer block — or
   * `MODULE_OWNER` for top-level code. Built by pushing `framesFor`, which is
   * also how `mapSymbols` builds `ChangedSymbol.qualifiedName`: the same
   * declaration has to come out with the same path from both, because
   * `foldReach` matches facts across analyzers on it. When it did not — this
   * side framed no object literal and rooted no unnamed scope — a guard removed
   * from `handlers.run` was reported against an untouched top-level `run`, and
   * a guard genuinely removed from that export was cancelled out by one added
   * to the method and never reported at all. `test/extract/scope.test.ts` asks
   * both sides about the same declaration and compares.
   *
   * Also not the innermost name alone: the whole file's guards are matched
   * before against after on this string, and two classes in one file may each
   * declare `render`. See `Fact.qualifiedSymbol`, which this becomes.
   */
  qualifiedOwner: string;
  /** Kind plus normalised condition text — the identity used for matching. */
  signature: string;
  line: number;
  excerpt: string;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Guard-shaped constructs, attributed to the symbol containing them.
 * Matching is by (qualifiedOwner, signature), so moving a guard within a
 * function is not a removal; what makes a removal reportable is decided by
 * `guardsAnalyzer` below, which requires the *count* of that guard kind in
 * that symbol to have gone down.
 */
export function collectGuards(path: string, text: string): GuardSite[] {
  if (!isSyntacticSource(path)) return [];

  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(path),
  );
  const lines = text.split("\n");
  const out: GuardSite[] = [];
  const owner: string[] = [];

  const push = (node: ts.Node, signature: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({
      qualifiedOwner: qualifyOwner(owner),
      signature,
      line,
      excerpt: (lines[line - 1] ?? "").trim(),
    });
  };

  const visit = (node: ts.Node): void => {
    const pushed = framesFor(node);
    owner.push(...pushed);

    if (ts.isIfStatement(node)) {
      push(node, `if:${normalise(node.expression.getText(sf))}`);
    } else if (ts.isThrowStatement(node)) {
      push(node, `throw:${normalise(node.expression.getText(sf))}`);
    } else if (
      ts.isReturnStatement(node) &&
      node.parent &&
      ts.isBlock(node.parent) &&
      node.parent.parent &&
      ts.isIfStatement(node.parent.parent)
    ) {
      // An early return inside a conditional — the classic guard clause.
      push(node, `return:${normalise(node.getText(sf))}`);
    }

    ts.forEachChild(node, visit);
    owner.length -= pushed.length;
  };

  ts.forEachChild(sf, visit);
  return out;
}

/** Exact identity: this guard, with this condition text, in this symbol. */
function key(g: GuardSite): string {
  return `${g.qualifiedOwner}|${g.signature}`;
}

/** Coarse identity: an if / throw / return guard in this symbol, any text. */
function kindKey(g: GuardSite): string {
  return `${g.qualifiedOwner}|${g.signature.split(":")[0]}`;
}

function countBy(guards: GuardSite[], of: (g: GuardSite) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of guards) counts.set(of(g), (counts.get(of(g)) ?? 0) + 1);
  return counts;
}

/**
 * Reports guards that a symbol has genuinely lost.
 *
 * Two conditions, both required. First, the exact guard — kind plus
 * normalised condition text — must be unmatched on the after side, matched
 * as a multiset so that deleting one of two identical guards still leaves
 * one unmatched. Second, the *count* of that guard kind in that symbol must
 * have gone down.
 *
 * The count condition is what separates a removal from an edit. Guard
 * identity includes the condition text, so rewording a condition, renaming
 * a variable it reads, or narrowing an `else if` all make the old signature
 * absent — and on identity alone each presented as a pure removal, with no
 * compensating "added" fact and the highest weight in the report. Three of
 * three guard findings on this branch's own diff were exactly that. A
 * symbol that still runs as many `if` guards as it did before has not lost
 * one, whatever the conditions now say.
 *
 * The cost is a real removal that coincides with a new guard of the same kind
 * under the same owner path: the counts balance and nothing is reported. "The
 * same symbol" understated it — an owner path is not always one declaration.
 * Two anonymous functions in one scope share `<anonymous>`, and two bindings in
 * different unnamed scopes share a `<local>` root (see `byQualifiedName` in
 * `../extract/symbols.ts`, which records the same trade from the other end), so
 * a guard *moved* between two sibling callbacks in one function cancels out and
 * this analyzer says nothing. Common enough to matter: this codebase's own
 * `runAnalyzers` and `parseClaims` each hold more than one guard under a
 * single `<anonymous>` path.
 *
 * That is still the intended trade — silence is recoverable, a confident wrong
 * `verified` finding is not — but it is paid more often than "the same symbol"
 * suggests.
 *
 * A symbol that disappeared entirely is not reported either — its deletion
 * is the finding, and the guards analyzer would only add noise.
 */
export const guardsAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const facts: Fact[] = [];

  for (const file of changeset.files) {
    if (!isSyntacticSource(file.path)) continue;
    // See `ChangedFile.generated`: machine-written JavaScript carries no
    // guard a person wrote, so counting one lost from it would blame this
    // change for a tool's output.
    if (file.generated) continue;
    if (file.status === "added" || file.status === "deleted") continue;

    const beforePath = file.previousPath ?? file.path;
    const beforeText = await ctx.readAt(ctx.range.from, beforePath);
    const afterText = await ctx.readAt(ctx.range.to, file.path);

    // An unreadable side is an error, never evidence that a guard vanished.
    if (beforeText === null || afterText === null) continue;

    const before = collectGuards(beforePath, beforeText);
    const after = collectGuards(file.path, afterText);
    // Consumed as the before-side guards are matched against it, so two
    // identical before-guards cannot both be "matched" by a single
    // surviving one.
    const unmatched = countBy(after, key);
    // How many removals of each (symbol, kind) the counts can justify.
    const beforeKinds = countBy(before, kindKey);
    const afterKinds = countBy(after, kindKey);
    const budget = new Map<string, number>();
    for (const [k, n] of beforeKinds) {
      budget.set(k, n - (afterKinds.get(k) ?? 0));
    }
    const survivingSymbols = new Set(after.map((g) => g.qualifiedOwner));
    // Symbols with no guards at all after the change still count as
    // surviving if they still exist in the file. This must recognise every
    // owner path `frameNameOf` can ever attribute a guard to (including arrow
    // functions and function expressions bound to a name), qualified exactly
    // as `collectGuards` qualifies it — otherwise a symbol whose *last* guard
    // was just removed looks, from here, like a symbol that was deleted
    // outright, and the removal is wrongly suppressed as "vanished symbol"
    // noise instead of reported.
    for (const s of collectDeclaredOwners(file.path, afterText)) {
      survivingSymbols.add(s);
    }
    // "<module>" is not a declaration that can be deleted — it stands for
    // top-level code, which survives as long as the file itself does (both
    // sides having been readable is already established above). Without
    // this, a removed top-level guard would be wrongly treated as belonging
    // to a vanished symbol and silently dropped.
    survivingSymbols.add(MODULE_OWNER);

    for (const g of before) {
      // Matched against a surviving guard with the same condition text:
      // consume it and move on. Multiset, not set — see `unmatched`.
      const survivor = unmatched.get(key(g)) ?? 0;
      if (survivor > 0) {
        unmatched.set(key(g), survivor - 1);
        continue;
      }
      if (!survivingSymbols.has(g.qualifiedOwner)) continue;
      // Unmatched text, but the symbol runs as many guards of this kind as
      // it did before: this is an edited condition, not a removed guard.
      const left = budget.get(kindKey(g)) ?? 0;
      if (left <= 0) continue;
      budget.set(kindKey(g), left - 1);

      const evidence: EvidenceRef[] = [
        // beforePath and the before-side line: the guard existed in the
        // before-side content, and that line number counts in the before
        // revision — `side` says so, so the renderer does not send a reader
        // to whatever occupies that line now. Fact.file/Fact.line follow
        // from this ref via makeFact, so they agree even for a renamed file.
        { file: beforePath, line: g.line, excerpt: g.excerpt, side: "before" },
      ];
      facts.push(
        makeFact({
          // The line is part of the id: with two identical guards in one
          // symbol and only one deleted, symbol+signature alone would not
          // distinguish the fact from a second one.
          id: `guard_removed:${beforePath}:${g.line}:${g.qualifiedOwner}:${g.signature}`,
          kind: "guard_removed",
          qualifiedSymbol: g.qualifiedOwner,
          detail: { guard: g.signature.split(":")[0], symbol: g.qualifiedOwner },
          evidence,
        }),
      );
    }
  }

  return facts;
};

/**
 * Every owner path `frameNameOf` could attribute a guard to in this file — the
 * same predicate *and the same owner stack* `collectGuards` uses. The stack
 * is not optional here even though survival is a question about presence
 * rather than nesting: these strings are compared against `GuardSite`'s
 * qualified owners, so `Worker.run` present in the file must not read as
 * `run` absent from it.
 */
function collectDeclaredOwners(path: string, text: string): string[] {
  if (!isSyntacticSource(path)) return [];
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(path),
  );
  const owners: string[] = [];
  const stack: string[] = [];
  const visit = (node: ts.Node): void => {
    const pushed = framesFor(node);
    if (pushed.length > 0) {
      stack.push(...pushed);
      owners.push(qualifyOwner(stack));
    }
    ts.forEachChild(node, visit);
    stack.length -= pushed.length;
  };
  ts.forEachChild(sf, visit);
  return owners;
}
