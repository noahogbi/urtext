import ts from "typescript";
import { frameNameOf, framesFor, memberNameOf, qualifyDeclaration } from "./scope.js";
import type { ChangedSymbol, Hunk, SymbolKind } from "../types.js";

/**
 * A TypeScript *implementation* file, in any of the four extensions the
 * language has — `.ts`, `.tsx`, and the module-explicit `.mts`/`.cts` (there
 * is no `.mtsx`/`.ctsx`; JSX never got module-explicit flavours). Declaration
 * files are excluded in every flavour: `.d.ts`, `.d.mts`, `.d.cts`. The
 * `.tsx?`-only version of this test made every `.mts`/`.cts` file invisible
 * to every analyzer, silently — the worst outcome this tool has.
 */
export function isTypeScriptFile(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path) && !/\.d\.(?:ts|mts|cts)$/.test(path);
}

/**
 * A JavaScript implementation file, in every extension the language has.
 * There is no `.mjsx`/`.cjsx` — JSX never got module-explicit flavours — and
 * no declaration flavour to exclude, JavaScript having no `.d.js`.
 */
export function isJavaScriptFile(path: string): boolean {
  return /\.(?:js|mjs|cjs|jsx)$/.test(path);
}

/**
 * Source an analyzer can read on its own: TypeScript or JavaScript.
 *
 * Named for the capability rather than the languages because that is what the
 * call sites are choosing. An analyzer that builds its own SourceFile can read
 * either; one that needs the type checker can only read what the project's
 * compiler options admit, which is a different question asked elsewhere.
 */
export function isSyntacticSource(path: string): boolean {
  return isTypeScriptFile(path) || isJavaScriptFile(path);
}

/**
 * The ScriptKind a path must be parsed under.
 *
 * `.jsx` is tested before the general JavaScript case because it is both, and
 * JSX is the one that matters: parsed as TypeScript, `<div className="a">`
 * reads as a type assertion and the file yields parse errors. Plain
 * JavaScript is given its own kind for the same reason — JSX inside a `.js`
 * file is the Babel convention and mis-parses identically.
 */
export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (isJavaScriptFile(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface Declared {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  /**
   * Carries an `export` modifier *and* sits at the top level of the file — see
   * `ChangedSymbol.exported`, which this becomes and which states the rule and
   * what it misses.
   */
  exported: boolean;
  startLine: number;
  endLine: number;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    scriptKindFor(path),
  );
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (mods ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Every named declaration in a file, with 1-based inclusive line ranges and a
 * name qualified by every scope around it (see `./scope.ts`, which the guards
 * analyzer shares).
 *
 * Recording and framing are two independent questions about the same node, and
 * are asked separately below: a class expression frames its members without
 * being a declaration of its own, a computed-key method is a frame that cannot
 * be recorded, and a function is both — recorded under the frames above it, and
 * a frame for everything inside it.
 */
function declarations(sf: ts.SourceFile): Declared[] {
  const out: Declared[] = [];
  const frames: string[] = [];

  const record = (
    node: ts.Node,
    name: string | undefined,
    kind: SymbolKind,
    exported: boolean,
  ) => {
    if (!name) return;
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    out.push({
      name,
      qualifiedName: qualifyDeclaration(frames, name, node),
      kind,
      // `export` on a declaration that is not at the top level of the file
      // exports it from a namespace, not from the module — see `Declared`'s
      // `exported`, and `blastRadiusAnalyzer`, which looks a symbol up in the
      // file's module exports by its bare `name`.
      exported: exported && ts.isSourceFile(node.parent),
      startLine,
      endLine,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      record(node, node.name?.text, "function", isExported(node));
    } else if (ts.isClassDeclaration(node)) {
      record(node, node.name?.text, "class", isExported(node));
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      record(node, node.name.text, "type", isExported(node));
    } else if (ts.isEnumDeclaration(node)) {
      // The whole declaration, members included, is the recorded range, so a
      // member added or edited touches the enum's one symbol row. Members are
      // not rows of their own — like a class's members, they are reached
      // through the enum, and the enum is the export.
      record(node, node.name.text, "enum", isExported(node));
    } else if (ts.isMethodDeclaration(node)) {
      // An identifier or a private `#name` — see `memberNameOf`; a computed
      // key stays unrecorded. A method is never a module export, whatever
      // modifiers it carries.
      record(node, memberNameOf(node.name), "method", false);
    } else if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      // Recorded under its frame name (`get value` / `set value`, see
      // `frameNameOf`), so the symbol map and the guards walker agree on the
      // accessor's path. Computed keys stay unrecorded, like a method's.
      const name = memberNameOf(node.name);
      record(node, name === undefined ? undefined : frameNameOf(node), "method", false);
    } else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          record(node, decl.name.text, "variable", exported);
        }
      }
    }

    const pushed = framesFor(node);
    frames.push(...pushed);
    ts.forEachChild(node, visit);
    frames.length -= pushed.length;
  };

  ts.forEachChild(sf, visit);
  return out;
}

function touched(d: Declared, hunks: Hunk[]): boolean {
  return hunks.some((h) => {
    // A pure deletion (newLines === 0) is anchored just after newStart.
    const start = h.newStart;
    const end = h.newLines === 0 ? h.newStart : h.newStart + h.newLines - 1;
    return start <= d.endLine && end >= d.startLine;
  });
}

/**
 * The declarations of each symbol, keyed by qualified name and in the order
 * the names first appear. Several declarations under one name is ordinary
 * TypeScript, not an oddity to be tolerated: overload signatures plus their
 * implementation, two `interface`s that merge, an `interface` merged into a
 * `function`.
 *
 * Sound only because the name is qualified by every scope around it (see
 * `./scope.ts`). Declaration merging happens between declarations in one
 * scope, so a key that does not name the scope groups things that merely share
 * a spelling: while only classes framed a name, a local inside a function
 * grouped with a top-level export, and the merge below then read `exported`
 * off the export and `kind` and `range` off the local. See
 * `test/identity.test.ts`, "a nested declaration is not the top-level export
 * that shares its name".
 *
 * Two declarations in two *different* unnamed scopes can still share a key —
 * both roots are `LOCAL_SCOPE` — as can two anonymous functions in one scope,
 * both `<anonymous>`. Neither is a module export, so this cannot misname an
 * export or hand one another symbol's reference count, which is the defect
 * above.
 *
 * It is not free, though, and the earlier claim that "nothing downstream keys
 * on the merged entry" was wrong: `guardsAnalyzer` keys its per-(owner, kind)
 * budget on the same path, so two declarations that share one — two callbacks
 * in the same function, both `<anonymous>` — have their guards counted
 * together, and a guard moved from one to the other is reported as no change at
 * all. Not hypothetical: this codebase's own `runAnalyzers` and `parseClaims`
 * each hold more than one guard under a single `<anonymous>` path. The trade is
 * deliberate (see `guardsAnalyzer`, which states what its count rule costs),
 * but it is a cost, not a free imprecision.
 */
function byQualifiedName(decls: Declared[]): Map<string, Declared[]> {
  const groups = new Map<string, Declared[]>();
  for (const d of decls) {
    const group = groups.get(d.qualifiedName);
    if (group) group.push(d);
    else groups.set(d.qualifiedName, [d]);
  }
  return groups;
}

/**
 * One `ChangedSymbol` for one symbol, however many declarations carry it.
 *
 * The range spans from the first declaration's start to the last one's end.
 * For overloads that is the whole declaration group, which is what a reader
 * means by "where `fmt` is"; for two `interface` blocks far apart it also
 * covers the code between them, which no consumer reads — `startLine` is what
 * the analyzers anchor evidence to, and it is exact. Callers that need a
 * per-declaration range do not exist and should not use this shape if they
 * ever do.
 *
 * `exported` is true if any declaration exports the symbol: for a real merge,
 * one exported declaration puts the symbol on the module's public surface.
 * `kind` comes from the first declaration — the only groups where kinds differ
 * are cross-kind merges (`class` or `function` plus `interface`), where either
 * answer is half the truth and source order at least makes the choice
 * predictable.
 *
 * Both of those read across the group, which is only safe while a group really
 * is one symbol — see `byQualifiedName` for what made that false once.
 */
function toChangedSymbol(
  group: Declared[],
  change: ChangedSymbol["change"],
): ChangedSymbol {
  const first = group[0];
  return {
    name: first.name,
    qualifiedName: first.qualifiedName,
    kind: first.kind,
    exported: group.some((d) => d.exported),
    range:
      change === "removed"
        ? // Removed symbols carry a zero range: they have no place in the
          // after-file to point at. See `ChangedSymbol.range`.
          { startLine: 0, endLine: 0 }
        : {
            startLine: Math.min(...group.map((d) => d.startLine)),
            endLine: Math.max(...group.map((d) => d.endLine)),
          },
    change,
  };
}

/**
 * Symbols affected by this change — one entry per symbol, not per declaration.
 * A symbol is reported when it is new, gone, or when a hunk falls inside any
 * of its declarations' line ranges in the after-file.
 *
 * One entry per symbol is what the rest of the pipeline is built on:
 * `blast-radius` derives a fact id from `qualifiedName` alone, so N entries
 * for one overloaded export meant N facts sharing an id — N identical
 * `verified` findings, N identical rows in the report's API-surface table,
 * and a single model claim citing that id attaching to every one of them.
 * See `test/identity.test.ts`, "one changed symbol is one symbol, however
 * many declarations it has".
 */
export function mapSymbols(
  path: string,
  before: string | null,
  after: string | null,
  hunks: Hunk[],
): ChangedSymbol[] {
  if (!isTypeScriptFile(path)) return [];
  // A deleted file: reporting every symbol in it as "removed" is noise, since
  // the file's deletion is already the finding.
  if (after === null) return [];

  const beforeDecls = before ? declarations(parse(path, before)) : [];
  const afterGroups = byQualifiedName(declarations(parse(path, after)));
  const beforeGroups = byQualifiedName(beforeDecls);

  const out: ChangedSymbol[] = [];

  for (const [qualifiedName, group] of afterGroups) {
    const added = !beforeGroups.has(qualifiedName);
    // Any declaration of the symbol being touched touches the symbol. Asking
    // the merged range instead would also catch a hunk that fell in the gap
    // between two distant declarations of it.
    if (!added && !group.some((d) => touched(d, hunks))) continue;
    out.push(toChangedSymbol(group, added ? "added" : "modified"));
  }

  for (const [qualifiedName, group] of beforeGroups) {
    if (afterGroups.has(qualifiedName)) continue;
    out.push(toChangedSymbol(group, "removed"));
  }

  return out;
}
