import { join } from "node:path";
import ts from "typescript";
import { isTypeScriptFile } from "../extract/symbols.js";
import { canonicalSignature } from "./canonical.js";
import { makeFact } from "./fact.js";
import { relativePathOf } from "./program.js";
import type {
  AnalysisContext,
  Analyzer,
  Changeset,
  EvidenceRef,
  Fact,
} from "../types.js";

/**
 * Interfaces and type aliases carry no runtime value, so
 * `getTypeOfSymbolAtLocation` resolves them to `any` — every such export
 * would otherwise print identically on both sides of any change, no matter
 * what changed. Their shape has to come from `getDeclaredTypeOfSymbol`
 * instead (see `structuralSignature`).
 */
const TYPE_ONLY = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias;

/**
 * A stored signature beyond this length is truncated when a fact records
 * it, so that one enormous type — a huge object literal, or a union with
 * many members — cannot flood a fact with a single string. The marker
 * makes the cut visible: a reader must be able to tell the text was cut,
 * not mistake it for the whole type. Exported for
 * `test/comment-contract.test.ts`, which derives part of its forbidden set
 * from it.
 *
 * Applied at the fact-emission boundary, not inside `exportedSignatures`:
 * the true, uncut text has to exist long enough for its code-point length
 * to be recorded beside the capped text (`beforeChars`/`afterChars` in the
 * fact's detail), because the renderer's own length marker states that
 * true length — a length measured after this cap asserted a false size
 * for exactly the long-literal class the marker exists for.
 */
export const MAX_SIGNATURE_LENGTH = 400;

/**
 * Matches the marker `truncateSignature` appends. Exported for the render
 * layer (`../score/index.ts`), which drops the marker before applying its
 * own, shorter middle-truncation — the render marker states the true
 * length, and keeping both would leave this one's tail fragment inside
 * the rendered text.
 */
export const SIGNATURE_TRUNCATION_MARKER = /… \[truncated, \d+ more chars\]$/;

/**
 * Counted in code points throughout — the length check, the cut, and the
 * omitted count in the marker. `String#slice` counts UTF-16 units, so an
 * astral character straddling the cap stored a lone surrogate that every
 * downstream layer then faithfully preserved: the render layer cuts
 * safely, but cannot repair a half character it was handed.
 */
function truncateSignature(text: string): string {
  const points = [...text];
  if (points.length <= MAX_SIGNATURE_LENGTH) return text;
  const omitted = points.length - MAX_SIGNATURE_LENGTH;
  return `${points.slice(0, MAX_SIGNATURE_LENGTH).join("")}… [truncated, ${omitted} more chars]`;
}

/** Code points, not UTF-16 units — the unit every truncation layer counts in. */
function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Well-known-symbol members (`[Symbol.iterator]`, `[Symbol.unscopables]`,
 * `[Symbol.asyncIterator]`) come back from `getPropertiesOfType` under a
 * name that embeds the checker's *internal symbol id* — `__@iterator@11` in
 * one program, `__@iterator@472` in another built from byte-identical
 * source. Printing that id would report a contract change for source that
 * provably did not change. The id is stripped; the member name is kept, so
 * a genuinely retyped `[Symbol.iterator]` is still visible.
 */
const WELL_KNOWN_MEMBER = /^(__@[A-Za-z]+)@\d+$/;

function memberName(name: string): string {
  return name.replace(WELL_KNOWN_MEMBER, "$1");
}

/**
 * Whether a type-only symbol's shape was written out by hand at its
 * declaration — an `interface X { ... }`, or a `type X = { ... }` whose
 * right-hand side is an object type literal.
 *
 * Only those two get expanded member-by-member (see `structuralSignature`).
 * The distinction is not cosmetic. `getPropertiesOfType` reports the
 * *apparent* type's members, which for anything else is a library shape the
 * user never wrote: `type Names = string[]` reports all 35 members of
 * `Array<string>`, a tuple reports the same plus its indices, `Map` reports
 * the Map API. Two of those members carry an unstable internal id (see
 * `WELL_KNOWN_MEMBER`), so every array, tuple, `Map`, `Set`, or otherwise
 * iterable alias reported a fabricated `signature_changed` on every run.
 * Gating on `TypeFlags.Object` did not exclude them, because arrays and
 * tuples *are* object types. Gating on the declaration does.
 */
function expandsStructurally(sym: ts.Symbol): boolean {
  return (sym.declarations ?? []).some(
    (d) =>
      ts.isInterfaceDeclaration(d) ||
      (ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type)),
  );
}

/** `(req: string): string` for each call signature, or "" if there are none. */
function callSignatures(checker: ts.TypeChecker, type: ts.Type): string {
  return checker
    .getSignaturesOfType(type, ts.SignatureKind.Call)
    .map((s) => checker.signatureToString(s, undefined, ts.TypeFormatFlags.NoTruncation))
    .join("; ");
}

/**
 * A printed signature for a type-only export, sensitive to the changes that
 * break callers and stable across two separately-built `ts.Program`s.
 *
 * Hand-written shapes (see `expandsStructurally`) are expanded
 * member-by-member: `name: type` per member, sorted by member name so that
 * reordering members does not read as a contract change, plus any call
 * signatures — `getPropertiesOfType` does not enumerate those, and an
 * `interface H { (req: string): string }` would otherwise print as `{ }` on
 * both sides of any change to its parameters. Index signatures are still
 * not enumerated: a type whose only change is to one of those is invisible
 * on this path (`test/analyze/surface.test.ts` pins what *is* seen).
 *
 * Everything else prints via `checker.typeToString`, which gives exactly
 * the text a reader would write: `string[]`, `[string, number]`,
 * `Map<string, number>`, `(req: string) => string`, `{ [x: string]:
 * number; }`. Short, accurate, and — unlike the expansion of a library
 * type's apparent members — identical across programs. The
 * `TypeFormatFlags.InTypeAlias` flag is required: without it, a type
 * carrying its own alias symbol (which `getDeclaredTypeOfSymbol` always
 * returns for a type alias) prints back out as just the alias's own name
 * (`"Kind"`, not `"function" | "class"`), identical on both sides of any
 * change, which would make this path mute.
 *
 * How shape-sensitive that printing is depends on the shape:
 *
 * - A literal union (`"a" | "b"`) prints its members; adding or removing
 *   one changes the text. Same for a union of type *aliases*: `type AX = {
 *   p: string }; type AY = { q: number }; export type U = AX | AY` prints
 *   `{ p: string; } | { q: number; }`, fully shape-sensitive, because
 *   `InTypeAlias` expands each member's own alias.
 * - A union or intersection of *interfaces* prints each member as its bare
 *   name — `IX | IY`, `IX & IY` — so a member added to `IX` is invisible
 *   through `U`'s signature. (Pinned in `surface.test.ts`.)
 *
 * That last gap is partially self-mitigating, but not because of where
 * `IX` lives relative to `U`: `surfaceAnalyzer` below computes each changed
 * file's own before/after export table independently, so co-location is
 * irrelevant. What matters is whether `IX` is *itself* an export of a file
 * in the changeset — if it is, and its signature changed, that file emits
 * its own `signature_changed` finding for `IX` directly. It stays silent
 * when `IX` did not change, when `IX`'s declaring file falls outside the
 * range being reviewed, and — the case that surprises — when `IX` is not
 * exported at all, since a non-exported interface never appears in any
 * file's export table and so no file emits a compensating finding for it.
 *
 * A union's members are printed sorted, for the same reason the structural
 * branch sorts properties: a union is a set, its declared order carries no
 * meaning, and that order is not even guaranteed stable for byte-identical
 * source text across two separately-built programs. Printing it as declared
 * would report a "signature changed" finding for source that did not change.
 */
function structuralSignature(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
  fallback: ts.Node,
): string {
  const declared = checker.getDeclaredTypeOfSymbol(sym);

  // NoTruncation everywhere a type is printed: the checker's own default
  // cap cut long literal types silently, with a marker of its own, before
  // either of this module's layers ever saw the text — so the recorded
  // "true length" was the checker's cap, not the type's, and two literals
  // differing only past that cap printed identically. The full text lives
  // only until `surfaceAnalyzer` stores it through `truncateSignature`.
  const FLAGS = ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.NoTruncation;
  if (!expandsStructurally(sym)) {
    if (declared.isUnion()) {
      const members = declared.types
        .map((t) => checker.typeToString(t, undefined, FLAGS))
        .sort();
      return members.join(" | ");
    }
    return checker.typeToString(declared, undefined, FLAGS);
  }

  const props = [...checker.getPropertiesOfType(declared)]
    .map((p) => ({ sym: p, name: memberName(p.getName()) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parts = props.map((p) => {
    const type = checker.getTypeOfSymbolAtLocation(
      p.sym,
      p.sym.valueDeclaration ?? fallback,
    );
    return `${p.name}: ${checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)}`;
  });
  const shape = `{ ${parts.join("; ")} }`;
  const calls = callSignatures(checker, declared);
  return calls ? `${shape} & { ${calls} }` : shape;
}

/**
 * Exported name → printed type, for one file in a program. `undefined` when
 * the program has no such source file: that is an unreadable file, not a
 * file with no exports, and the two must not be conflated. Returning an
 * empty map for a missing before-side file would make every export of the
 * after-side file read as `export_added` — absence treated as evidence,
 * one level up from the file-read rule the other analyzers follow.
 *
 * The printed text is the *full* signature, uncapped: `surfaceAnalyzer`
 * measures its true length and applies `truncateSignature` when it stores
 * the text on a fact, and truncating here instead would destroy the length
 * before anything could record it.
 */
export function exportedSignatures(
  program: ts.Program,
  root: string,
  path: string,
): Map<string, string> | undefined {
  const out = new Map<string, string>();
  const sf = program.getSourceFile(join(root, path));
  if (!sf) return undefined;

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  // A source file with no module symbol is a script, not a module: it has
  // no exports, which is a fact about the file rather than a failure to
  // read it.
  if (!moduleSymbol) return out;

  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const signature =
      sym.flags & TYPE_ONLY
        ? structuralSignature(checker, sym, sf)
        : checker.typeToString(
            checker.getTypeOfSymbolAtLocation(sym, sf),
            undefined,
            // See `structuralSignature`'s comment on NoTruncation: this is
            // the path a long string-literal const takes, exactly the
            // class whose true length the renderer's marker must state.
            ts.TypeFormatFlags.NoTruncation,
          );
    out.set(sym.getName(), signature);
  }
  return out;
}

/**
 * Line, excerpt, and repo-relative file for the declaration of an exported
 * name — anchored to the file that actually *declares* the symbol, not the
 * file whose export list it was found on. Both re-export forms need this:
 *
 * - `export * from "./other.js"` hands back the underlying declaration's own
 *   symbol directly, so `declarations[0]` already lives in `./other.js`.
 * - `export { x } from "./other.js"` (a *named* re-export) hands back an
 *   `Alias`-flagged symbol whose own `declarations[0]` is the
 *   `ExportSpecifier` — a line in the re-exporting barrel, not in
 *   `./other.js`. Resolving through `getAliasedSymbol` first is required to
 *   reach the real declaration.
 *
 * Using the wrong side's source text for the line/excerpt would satisfy the
 * Fact.file/evidence agreement check while pointing at a line that has
 * nothing to do with the symbol (or, for the named-re-export case, at the
 * barrel's `export { x } from ...` line rather than the actual definition)
 * — evidence that looks valid and is not. Returns undefined, rather than
 * evidence in the wrong file, when no declaration can be found at all.
 */
function lineOfExport(
  program: ts.Program,
  root: string,
  path: string,
  name: string,
): { file: string; line: number; excerpt: string; declaredName: string } | undefined {
  const sf = program.getSourceFile(join(root, path));
  if (!sf) return undefined;
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const sym = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name)
    : undefined;
  if (!sym) return undefined;

  // getAliasedSymbol throws on a symbol that isn't actually an alias, so it
  // is only called behind the flag check. If resolving the alias yields no
  // usable declaration (a shape the compiler API does not otherwise rule
  // out), fall back to the unresolved symbol rather than losing the
  // evidence entirely.
  const resolved =
    sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const decl = resolved.declarations?.[0] ?? sym.declarations?.[0];
  if (!decl) return undefined;

  const declSf = decl.getSourceFile();
  const line = declSf.getLineAndCharacterOfPosition(decl.getStart(declSf)).line + 1;
  const excerpt = declSf.text.split("\n")[line - 1]?.trim() ?? "";
  // `resolved`'s own name, not `name` (the caller's, which is the exported
  // name — possibly an alias assigned by the re-exporting barrel, not the
  // binding's own name). Two different bindings declared on the same line
  // of the same file — `export const alpha = ..., beta = ...;` — can each
  // be re-exported under the identical alias from two different barrels
  // (`export { alpha as z }`, `export { beta as z }`); without the real
  // declared name, (file, line, exported-name) alone cannot tell them
  // apart. See `surfaceAnalyzer`'s dedup key, below.
  return { file: relativePathOf(root, declSf), line, excerpt, declaredName: resolved.getName() };
}

/**
 * Reports changes to a file's public contract: exports added, exports
 * removed, and exports whose type signature changed. A changed signature is
 * the class of change that breaks callers without breaking the build at the
 * point of change, which is why it ranks above an added export.
 */
export const surfaceAnalyzer: Analyzer = async (
  changeset: Changeset,
  ctx: AnalysisContext,
): Promise<Fact[]> => {
  const relevant = changeset.files.filter(
    (f) => isTypeScriptFile(f.path) && f.status !== "deleted",
  );
  if (relevant.length === 0) return [];

  const [beforeProgram, afterProgram] = await Promise.all([
    ctx.programAt(ctx.range.from),
    ctx.programAt(ctx.range.to),
  ]);

  const facts: Fact[] = [];
  // Shared across every file in `relevant`, not reset per iteration: a
  // barrel re-export is discovered twice — once from the file that declares
  // the symbol, once from the barrel that re-exports it — and both
  // discoveries resolve to the same declaration site via `lineOfExport`'s
  // `getAliasedSymbol` call. Keying on (kind, where.file, where.line, name,
  // where.declaredName) rather than on file.path (the file this loop
  // iteration happens to be examining) is what makes those two discoveries
  // collide instead of producing two facts for one new — or one changed, or
  // one removed — export. See `test/analyze/surface.test.ts`, "reports a
  // symbol declared once and re-exported through two barrels as one fact,
  // not one per barrel".
  const seenDeclarations = new Set<string>();

  for (const file of relevant) {
    const beforePath = file.previousPath ?? file.path;
    const before =
      file.status === "added"
        ? new Map<string, string>()
        : exportedSignatures(beforeProgram, ctx.cwd, beforePath);
    const after = exportedSignatures(afterProgram, ctx.cwd, file.path);
    // Either side missing from its program is a failure to read, not an
    // empty contract. Diffing against a map that does not describe the file
    // would invent an added or removed export for every name in it.
    if (before === undefined || after === undefined) continue;

    const emit = (
      kind: Fact["kind"],
      name: string,
      detail: Record<string, unknown>,
      where: { file: string; line: number; excerpt: string; declaredName: string } | undefined,
      side: "before" | "after",
    ) => {
      // No resolvable declaration site, or nothing to excerpt: no evidence,
      // no fact.
      if (!where || !where.excerpt) return;
      // `name` (the exported name) plus `where.declaredName` (the real
      // binding's own name): naming both, not just one. `name` alone
      // collapses two different bindings that happen to share a line and an
      // exported alias — see `lineOfExport`'s doc comment for the
      // `alpha`/`beta`-as-`z` case this guards. `where.declaredName` alone
      // would instead collapse the same binding re-exported under two
      // genuinely different external names into one entry, which is a
      // separate question this key does not need to answer either way.
      const key = `${kind}:${where.file}:${where.line}:${name}:${where.declaredName}`;
      if (seenDeclarations.has(key)) return;
      seenDeclarations.add(key);
      const evidence: EvidenceRef[] = [
        { file: where.file, line: where.line, excerpt: where.excerpt, side },
      ];
      facts.push(
        makeFact({
          // Anchored at the declaration (where.file, where.line), the same
          // place `key` above dedupes on — not at file.path. One export has
          // one id no matter how many files re-export it.
          //
          // Fact.file is not passed at all: makeFact derives it from
          // evidence[0], which is where.file — evidence for a re-exported
          // symbol, or for a removed export on a renamed file, lands in a
          // different file than the one being analyzed here.
          id: key,
          kind,
          // The declaration's own name, not the exported one. They differ
          // only for a renaming re-export (`export { alpha as z }`), and
          // there it is `alpha` that `blast-radius` will have named for the
          // same declaration — `foldReach` matches the two on this field, so
          // an alias here would leave a signature change and its own
          // reference count looking like facts about two different symbols.
          // The reader still sees `z`: the prose reads `detail.export`.
          qualifiedSymbol: where.declaredName,
          detail: { export: name, ...detail },
          evidence,
        }),
      );
    };

    for (const [name, afterSig] of after) {
      const beforeSig = before.get(name);
      const storedAfter = truncateSignature(afterSig);
      if (beforeSig === undefined) {
        emit(
          "export_added",
          name,
          { after: storedAfter },
          lineOfExport(afterProgram, ctx.cwd, file.path, name),
          "after",
        );
      } else if (canonicalSignature(beforeSig) !== canonicalSignature(afterSig)) {
        // Compared CANONICALLY, because the raw text carries checker
        // accidents: a union nested anywhere in a printed type serializes
        // in type-interning order, which merely adding a module elsewhere
        // in the range can flip (see `canonicalSignature`). The fact still
        // stores the capped raw text — the reader sees what the checker
        // printed; only the equality question goes through the canonical
        // form.
        //
        // Compared on the FULL text, not the stored capped one, for two
        // reasons that arrived together. A capped text can cut mid-token,
        // and unparseable text canonicalizes to itself — so a long type
        // with a flipped union inside the cap stayed a false positive (a
        // real repository's 986-char interface reproduced this). And the
        // old capped comparison silently ignored any real change past the
        // cap — a `verified` tier that stops reading at an arbitrary
        // length was masking, not caution. Both directions are pinned in
        // `test/analyze/surface.test.ts`, "nested set-semantic reorders".
        // The `beforeChars`/`afterChars` counts are the full text's
        // code-point lengths, recorded before the cap so the renderer's
        // length marker can state the type's real size rather than the
        // cap's.
        emit(
          "signature_changed",
          name,
          {
            before: truncateSignature(beforeSig),
            beforeChars: codePointLength(beforeSig),
            after: storedAfter,
            afterChars: codePointLength(afterSig),
          },
          lineOfExport(afterProgram, ctx.cwd, file.path, name),
          "after",
        );
      }
    }

    for (const [name, beforeSig] of before) {
      if (after.has(name)) continue;
      emit(
        "export_removed",
        name,
        { before: truncateSignature(beforeSig) },
        // Before-side evidence: this line number counts in the before
        // revision, and need not exist in the working tree at all.
        lineOfExport(beforeProgram, ctx.cwd, beforePath, name),
        "before",
      );
    }
  }

  return facts;
};
