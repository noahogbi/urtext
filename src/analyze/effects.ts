import ts from "typescript";
import { isSyntacticSource, scriptKindFor } from "../extract/symbols.js";
import { makeFact, MAX_EVIDENCE } from "./fact.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EffectKind,
  EvidenceRef,
  Fact,
} from "../types.js";

export interface EffectSite {
  kind: EffectKind;
  line: number;
  excerpt: string;
}

/**
 * Detection below is syntactic and keyed on identifier names, plus a pass
 * that resolves import bindings against `MODULE_EFFECTS` by specifier. The
 * identifier tables alone remain scope-blind: a shadowing local (`const db =
 * new Map()`) still produces a false-positive `database` effect, because
 * that is a name coincidence no amount of import resolution can rule out.
 * But imports from a module in `MODULE_EFFECTS` are now resolved by
 * specifier regardless of the local name they bind to — aliased
 * (`readFile as rf`), namespace (`* as fsp`), and default imports all
 * resolve correctly. What is still unresolved: an import from a module not
 * listed in `MODULE_EFFECTS`, and a binding introduced by re-export
 * (`export { readFile } from ...`) or dynamic `import()` rather than a
 * static import declaration.
 *
 * This binding lookup is itself name-based and scope-blind, the same way
 * the identifier tables are: it is a single flat map consulted against
 * every identifier in the file, with no tracking of scope or redeclaration.
 * A local declaration that reuses an imported binding's name — a function
 * parameter named `rf` in a file that also imports `readFile as rf` — is
 * misattributed as a filesystem effect in exactly the same way `db` is
 * misattributed above. Resolving imports by specifier closes the
 * false-negative gap (an aliased import used to be invisible); it does not
 * close the false-positive gap (a shadowing name is still indistinguishable
 * from the binding it shadows).
 */

/** Bare global calls that are effectful. */
const GLOBAL_CALLS: Record<string, EffectKind> = {
  fetch: "network",
};

/** `object.member` patterns, matched on the object name. */
const OBJECT_EFFECTS: Record<string, EffectKind> = {
  fs: "filesystem",
  fsPromises: "filesystem",
  axios: "network",
  http: "network",
  https: "network",
  child_process: "process",
  db: "database",
  prisma: "database",
  knex: "database",
  pool: "database",
};

/** Fully-qualified `object.member` patterns that beat the object-name table. */
const QUALIFIED_EFFECTS: Record<string, EffectKind> = {
  "process.env": "env",
  "process.exit": "process",
  "Date.now": "timing",
  "Math.random": "timing",
};

function qualifiedName(node: ts.PropertyAccessExpression): string | null {
  const left = node.expression;
  if (!ts.isIdentifier(left)) return null;
  return `${left.text}.${node.name.text}`;
}

/**
 * Module specifiers whose imports carry an effect. Matched after stripping a
 * `node:` prefix, so "node:fs/promises" and "fs/promises" are one entry.
 * This is specifier-based and purely syntactic: it needs no type checker,
 * and it closes the aliased-import blind spot the identifier tables have.
 *
 * The lookup is exact-match after stripping `node:`, not prefix-match —
 * `fs/promises` needs its own entry precisely because `fs` would not
 * cover it.
 */
const MODULE_EFFECTS: Record<string, EffectKind> = {
  fs: "filesystem",
  "fs/promises": "filesystem",
  http: "network",
  https: "network",
  http2: "network",
  net: "network",
  dns: "network",
  undici: "network",
  axios: "network",
  "node-fetch": "network",
  child_process: "process",
  cluster: "process",
  worker_threads: "process",
  pg: "database",
  mysql: "database",
  mysql2: "database",
  sqlite3: "database",
  "better-sqlite3": "database",
  mongodb: "database",
  ioredis: "database",
  redis: "database",
};

function moduleEffect(specifier: string): EffectKind | undefined {
  const s = specifier.replace(/^node:/, "");
  return MODULE_EFFECTS[s];
}

/** Local identifier → effect, from this file's import declarations. */
function importBindings(sf: ts.SourceFile): Map<string, EffectKind> {
  const out = new Map<string, EffectKind>();

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const effect = moduleEffect(stmt.moduleSpecifier.text);
    if (!effect) continue;

    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;

    // `import http from "node:http"`
    if (clause.name) out.set(clause.name.text, effect);

    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      // `import * as fsp from "node:fs/promises"`
      out.set(bindings.name.text, effect);
    } else {
      // `import { readFile as rf } from "fs/promises"` — the local name is
      // `bindings.elements[i].name`, which is what appears at call sites.
      // `import { type readFile } from ...` is inert in valid code (a
      // type-only binding cannot appear in value position), so skip it too.
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        out.set(el.name.text, effect);
      }
    }
  }

  return out;
}

/** Effect sites in a file, in source order. Syntactic — no type checker. */
export function detectEffects(path: string, text: string): EffectSite[] {
  if (!isSyntacticSource(path)) return [];

  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(path),
  );
  const lines = text.split("\n");
  const sites: EffectSite[] = [];
  const bindings = importBindings(sf);

  const push = (node: ts.Node, kind: EffectKind) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    sites.push({ kind, line, excerpt: (lines[line - 1] ?? "").trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const q = qualifiedName(node);
      if (q && QUALIFIED_EFFECTS[q]) {
        push(node, QUALIFIED_EFFECTS[q]);
      } else if (ts.isIdentifier(node.expression)) {
        const bound = bindings.get(node.expression.text);
        if (bound) {
          push(node, bound);
        } else if (OBJECT_EFFECTS[node.expression.text]) {
          push(node, OBJECT_EFFECTS[node.expression.text]);
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const bound = bindings.get(node.expression.text);
      if (bound) {
        push(node, bound);
      } else if (GLOBAL_CALLS[node.expression.text]) {
        push(node, GLOBAL_CALLS[node.expression.text]);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return sites;
}

function kindsOf(sites: EffectSite[]): Set<EffectKind> {
  return new Set(sites.map((s) => s.kind));
}

function toEvidence(
  path: string,
  sites: EffectSite[],
  kind: EffectKind,
  side: "before" | "after",
): EvidenceRef[] {
  return sites
    .filter((s) => s.kind === kind)
    .slice(0, MAX_EVIDENCE)
    .map((s) => ({ file: path, line: s.line, excerpt: s.excerpt, side }));
}

type EffectFactKind = "effect_added" | "effect_removed";

/**
 * Builds one Fact for a single (path, kind) pair, or null if there is
 * nothing to show. `path` is the file the sites and evidence both come
 * from — the after-path for additions, the before-path for removals — and
 * `side` says which revision those line numbers count in. `Fact.file`/
 * `Fact.line` are derived from `evidence[0]` by `makeFact`, so they agree
 * with the evidence even for a renamed file.
 */
function buildFact(
  factKind: EffectFactKind,
  path: string,
  effectKind: EffectKind,
  sites: EffectSite[],
): Fact | null {
  const side = factKind === "effect_removed" ? "before" : "after";
  const matching = sites.filter((s) => s.kind === effectKind);
  const evidence = toEvidence(path, matching, effectKind, side);
  // A fact that cannot show its evidence must not ship. Unreachable today
  // because `evidence` is derived from the same non-empty `matching` list,
  // but returning null rather than calling makeFact (which throws on empty
  // evidence) keeps a future refactor's mistake a silent no-op here rather
  // than a crashed review.
  if (evidence.length === 0) return null;
  return makeFact({
    id: `${factKind}:${path}:${effectKind}`,
    kind: factKind,
    // True total, not the (possibly capped) evidence count — this number is
    // shown to users, so it must not understate how many sites there are.
    detail: { effect: effectKind, sites: matching.length },
    evidence,
  });
}

/**
 * Reports effect kinds that appear in a file's after-state but not its
 * before-state, and vice versa. A file that already made network calls and
 * makes different ones now is not a finding; a file that never did and now
 * does, is.
 */
export const effectsAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const facts: Fact[] = [];

  for (const file of changeset.files) {
    if (!isSyntacticSource(file.path)) continue;
    // A file marked generated is machine-written JavaScript (see
    // `ChangedFile.generated`); whatever it calls arrived compiled in, not
    // introduced by this change, so it is not evidence of anything.
    if (file.generated) continue;

    const beforePath = file.previousPath ?? file.path;
    const beforeText =
      file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforePath);
    const afterText =
      file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, file.path);

    // A file that still exists but whose after-state could not be read tells
    // us nothing: the content is missing, not the effects. Treating that as
    // "the effects are gone" is how a wrong range or a wrong working
    // directory turns into a confident `verified` claim that a guard was
    // removed. Say nothing instead — silence is recoverable, a false
    // verified finding is not.
    if (afterText === null && file.status !== "deleted") continue;

    const beforeSites = beforeText ? detectEffects(beforePath, beforeText) : [];
    const afterSites = afterText ? detectEffects(file.path, afterText) : [];
    const before = kindsOf(beforeSites);
    const after = kindsOf(afterSites);

    for (const kind of after) {
      if (before.has(kind)) continue;
      const fact = buildFact("effect_added", file.path, kind, afterSites);
      if (fact) facts.push(fact);
    }

    for (const kind of before) {
      if (after.has(kind)) continue;
      const fact = buildFact("effect_removed", beforePath, kind, beforeSites);
      if (fact) facts.push(fact);
    }
  }

  return facts;
};
