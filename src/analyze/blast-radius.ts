import { join } from "node:path";
import ts from "typescript";
import { isJavaScriptFile, isTypeScriptFile } from "../extract/symbols.js";
import { makeFact, MAX_EVIDENCE } from "./fact.js";
import { allowsJavaScript, relativePathOf } from "./program.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

/**
 * Every identifier in the program that resolves to the named export of the
 * given file, excluding the declaration itself. Every identifier in every
 * file is checked against the resolved symbol — not filtered by spelling
 * first — because a name-matching shortcut is exactly the bug this function
 * exists to avoid: it would both count an unrelated `used` in a different
 * file and miss `import { used as u }` used later as `u(...)`, since `u`
 * never shares text with `used`. Symbol identity, via `getSymbolAtLocation`
 * and `getAliasedSymbol`, is the only thing that decides a match.
 */
export function countReferences(
  program: ts.Program,
  root: string,
  path: string,
  name: string,
): EvidenceRef[] {
  const checker = program.getTypeChecker();
  const declFile = program.getSourceFile(join(root, path));
  if (!declFile) return [];

  const moduleSymbol = checker.getSymbolAtLocation(declFile);
  if (!moduleSymbol) return [];

  const resolve = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (!sym) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };

  const exportsOfModule = checker.getExportsOfModule(moduleSymbol);
  // A default export sits in the export table under "default", whatever its
  // declared name is, so the bare-name lookup finds nothing for `export
  // default function main` and its reach silently never attached. When the
  // bare name misses, take the default export — resolved through its alias
  // for the `export default main;` statement form — but only when its own
  // declaration really carries this name: the fallback must not hand an
  // unrelated symbol the default export's reference count.
  const declaresName = (sym: ts.Symbol): boolean =>
    (sym.declarations ?? []).some((d) => {
      const declName = (d as ts.NamedDeclaration).name;
      return !!declName && ts.isIdentifier(declName) && declName.text === name;
    });
  const defaultExport = resolve(
    exportsOfModule.find((s) => s.getName() === ts.InternalSymbolName.Default),
  );
  const target =
    exportsOfModule.find((s) => s.getName() === name) ??
    (defaultExport && declaresName(defaultExport) ? defaultExport : undefined);
  if (!target) return [];

  // Set<ts.Node>, not Set<ts.Declaration>: it is only ever compared against
  // node.parent below, which is typed as ts.Node.
  const declarations = new Set<ts.Node>(target.declarations ?? []);
  const refs: EvidenceRef[] = [];

  // A binding position — `import { used } from ...`, `import used from ...`
  // (a default import is the ImportClause's own name, not a specifier),
  // `export { used }`, or the bare identifier of `export default used;` —
  // introduces a local name for the symbol; it does not read the value the
  // symbol holds. Without this exclusion, every importing file counts
  // twice: once for the import binding itself (which resolves through
  // its alias to the same target) and once for each place that actually
  // calls or reads it, so a file imported and used once would inflate the
  // count to two.
  const isBindingIdentifier = (node: ts.Identifier): boolean => {
    const p = node.parent;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) {
      return node === p.name || node === p.propertyName;
    }
    if (ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamespaceExport(p)) {
      return node === p.name;
    }
    if (ts.isExportAssignment(p)) {
      return node === p.expression;
    }
    return false;
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const relPath = relativePathOf(root, sf);
    const lines = sf.text.split("\n");

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const inDeclaration = declarations.has(node.parent);
        if (
          !inDeclaration &&
          !isBindingIdentifier(node) &&
          resolve(checker.getSymbolAtLocation(node)) === target
        ) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          refs.push({
            file: relPath,
            line,
            excerpt: (lines[line - 1] ?? "").trim(),
            // The program is built at the after revision, so every line
            // number here counts in the working tree the reader is looking
            // at.
            side: "after",
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return refs;
}

/**
 * Reports how widely a changed export is used. Only symbols that actually
 * changed are considered — a busy export nobody touched is not news.
 *
 * This is the first analyzer whose interesting evidence is not co-located
 * with its subject: the fact concerns a changed export in one file, but the
 * evidence a reader wants — the call sites — lives in other files.
 * `evidence[0]` is still the changed declaration itself, matching
 * `Fact.file`/`Fact.line` exactly as every other analyzer in this codebase
 * does; the reference sites follow it in `evidence[1..]` rather than
 * displacing it. `detail.references` counts only the reference sites, not
 * the declaration entry that precedes them — the number in the finding text
 * means "places that use this".
 */
export const blastRadiusAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  // Computed once, before the filter: the early return just below is what
  // lets an analyzer that finds nothing relevant skip building a program at
  // all, and `allowsJavaScript` itself only ever reads the tsconfig.
  const js = allowsJavaScript(ctx.cwd);
  const relevant = changeset.files.filter(
    (f) =>
      (isTypeScriptFile(f.path) || (js && isJavaScriptFile(f.path))) &&
      f.status !== "deleted" &&
      // See `ChangedFile.generated`: root exclusion alone does not keep a
      // resolvable, imported bundle out of the program this analyzer walks.
      !f.generated &&
      f.symbols.some((s) => s.exported && s.change !== "removed"),
  );
  if (relevant.length === 0) return [];

  const program = await ctx.programAt(ctx.range.to);
  const facts: Fact[] = [];

  for (const file of relevant) {
    const sf = program.getSourceFile(join(ctx.cwd, file.path));
    const lines = sf ? sf.text.split("\n") : [];

    for (const sym of file.symbols) {
      if (!sym.exported || sym.change === "removed") continue;

      const refs = countReferences(program, ctx.cwd, file.path, sym.name);
      // Nothing references it, so there is no blast radius to report — and
      // a fact with only its own declaration as evidence would say nothing
      // a surface_changed fact hasn't already said.
      if (refs.length === 0) continue;

      const line = sym.range.startLine || 1;
      const declaration: EvidenceRef = {
        file: file.path,
        line,
        excerpt: (lines[line - 1] ?? "").trim(),
        side: "after",
      };
      // No text to show for the declaration itself — the file was not in
      // the program, or the line is blank. A fact whose anchor evidence is
      // an empty excerpt asks the reader to take it on faith, which is what
      // the `verified` badge is supposed to replace.
      if (!declaration.excerpt) continue;

      facts.push(
        makeFact({
          id: `blast_radius:${file.path}:${sym.qualifiedName}`,
          kind: "blast_radius",
          // The qualified name, matching the id: `countReferences` above
          // takes the bare `sym.name` because a module's export table is
          // keyed on the exported name, but nothing downstream may be. The
          // two agree for a top-level export and only for that; the fact's
          // identity does not get to depend on which of them was handy.
          qualifiedSymbol: sym.qualifiedName,
          detail: { symbol: sym.qualifiedName, references: refs.length },
          evidence: [declaration, ...refs.slice(0, MAX_EVIDENCE)],
        }),
      );
    }
  }

  return facts;
};
