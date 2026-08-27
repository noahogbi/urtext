import ts from "typescript";

/**
 * Canonical form of a printed type, for COMPARISON only — never for display.
 *
 * `checker.typeToString` prints a union's members in type-interning order:
 * the order each member type was first materialized anywhere in that
 * program's checking history. That order is not source order, and it is not
 * stable across two separately-built programs — reviewing a range that
 * merely added a module shifted it, and three byte-identical declarations
 * were reported as `verified` signature changes. `structuralSignature`'s
 * top-level union sort fixed one position; this fixes the class, because a
 * union can sit at ANY depth of a printed type — a property's type, a
 * generic argument, a parameter.
 *
 * The printed text is itself valid TypeScript type syntax, so the real
 * parser does the understanding: parse it, recursively sort every
 * set-semantic construct — union constituents, intersection constituents,
 * type-literal members — by the canonical text of each part, and print the
 * result. A pipe inside a string-literal type is data, not grammar, and the
 * parser knows the difference; pinned by `test/analyze/canonical.test.ts`,
 * "is not fooled by separators inside string-literal types".
 *
 * Text that does not parse cleanly (a signature truncated mid-token by the
 * storage cap) is returned unchanged: comparison then degrades to the raw
 * string equality it was before this module existed, never to anything
 * looser. Two different unparseable texts stay different.
 */
export function canonicalSignature(text: string): string {
  const sf = ts.createSourceFile(
    "__sig.ts",
    `type __T = ${text};`,
    ts.ScriptTarget.ES2022,
    true,
  );
  // `parseDiagnostics` is not on the public SourceFile type, but it is the
  // only place the parser records recoverable syntax errors, and a wrapper
  // program just to surface them would type-check the text — far more than
  // this function may assume about it. Worst case if the field ever
  // vanishes: `undefined` here reads as "no diagnostics" and a truncated
  // signature canonicalizes best-effort — still deterministic, since the
  // same cut text always parses to the same tree.
  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] })
    .parseDiagnostics;
  const alias = sf.statements[0];
  if (
    sf.statements.length !== 1 ||
    !ts.isTypeAliasDeclaration(alias) ||
    (diagnostics?.length ?? 0) > 0
  ) {
    return text;
  }

  const printer = ts.createPrinter({ removeComments: true });
  const print = (node: ts.Node): string =>
    printer.printNode(ts.EmitHint.Unspecified, node, sf);
  // Plain code-unit order: deterministic on every machine, unlike a locale
  // collation. What the order IS does not matter; that it never varies does.
  const byPrintedText = <T extends ts.Node>(nodes: readonly T[]): T[] =>
    nodes
      .map((node) => ({ node, key: print(node) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((entry) => entry.node);

  const transformed = ts.transform(alias.type, [
    (context) => {
      const visit = (node: ts.Node): ts.Node => {
        // Children first, so a constituent's sort key is already canonical
        // by the time its parent orders it.
        const visited = ts.visitEachChild(node, visit, context);
        if (ts.isUnionTypeNode(visited)) {
          return ts.factory.updateUnionTypeNode(
            visited,
            ts.factory.createNodeArray(byPrintedText(visited.types)),
          );
        }
        if (ts.isIntersectionTypeNode(visited)) {
          return ts.factory.updateIntersectionTypeNode(
            visited,
            ts.factory.createNodeArray(byPrintedText(visited.types)),
          );
        }
        if (ts.isTypeLiteralNode(visited)) {
          return ts.factory.updateTypeLiteralNode(
            visited,
            ts.factory.createNodeArray(byPrintedText(visited.members)),
          );
        }
        return visited;
      };
      return (root) => ts.visitNode(root, visit) as ts.TypeNode;
    },
  ]);

  return print(transformed.transformed[0]);
}
