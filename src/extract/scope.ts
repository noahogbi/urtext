import ts from "typescript";

/**
 * How a name is qualified by the scopes around it. One rule, in one place,
 * because two consumers depend on it agreeing with itself: `mapSymbols`
 * (`./symbols.ts`) groups declarations by qualified name, and `collectGuards`
 * (`../analyze/guards.ts`) attributes a guard to the qualified owner it runs
 * in. `foldReach` then matches facts from different analyzers on that string,
 * so a name qualified two different ways is a fact about one symbol filed
 * under another.
 *
 * "Agreeing with itself" has to mean more than "both call `frameNameOf`". It
 * did not, once: the declaration side grew a rule for unnamed scopes that the
 * guards side never got, and neither framed an object literal, so a guard in
 * `handlers.run` was attributed to a top-level `run` beside it — which stole
 * that export's reference count, and, when the export lost a guard of the same
 * kind in the same change, cancelled it out and reported nothing at all. Both
 * sides now build their frame stack with `framesFor` and mark statement-scope
 * locals with `inStatementScope`, which is where the rule lives;
 * `test/extract/scope.test.ts` asks both of them about the same declaration
 * and compares.
 */

/**
 * Path for something that belongs to no declaration — code at the top level of
 * a file. Angle brackets because an identifier cannot contain them, so a
 * sentinel cannot collide with a path built out of identifiers. Exported
 * because the renderer has to recognise it to translate it (see
 * `guardOwnerLabel` in `../score/index.ts`).
 *
 * Not collision-proof against every string TypeScript will accept as a frame:
 * `declare module "<module>" { ... }` takes its frame from a *string literal*,
 * and would put this exact text in a path. That is inert here — an ambient
 * module's members are not exports of the file being reviewed, so nothing
 * matches on them — but the guarantee is about identifiers, not about
 * arbitrary module specifiers.
 */
export const MODULE_OWNER = "<module>";

/**
 * Segment for a function or object with no name to be known by: an arrow
 * function or expression bound to nothing nameable, a method with a computed
 * key, an object literal passed straight to a call. It can appear at any
 * position in a path —
 * `<anonymous>.inner` for a named function declared inside a callback,
 * `Cls.<anonymous>` for a computed-key method — so anything that renders a path
 * has to handle it anywhere, not only at the end.
 */
export const ANONYMOUS_OWNER = "<anonymous>";

/**
 * Segment for a name declared inside a *statement* scope — a bare block, a
 * `for` header or body, a `catch` clause, a `case` block, a class's static
 * initializer block, or a function's body. Such a name is by construction not
 * a member of anything (`export` is legal only at the top level of a file or a
 * namespace), and without this segment it would be qualified as if it were
 * one: at the top of a file it collided with a top-level export of the same
 * name, and inside a named frame it collided with a real member — a
 * static-block local wore the path of the class's static method, and a
 * function-local object inside `function api` wore the path of a merged
 * `namespace api`'s genuinely exported member. The segment applies wherever
 * the declaration sits, not only when the frame stack is empty — the
 * empty-stack-only version was exactly the second collision.
 *
 * Statement scopes still contribute no frame of their own to the *owner*
 * stack: a guard's own body is a block — `if (x) { throw }` inside `validate`
 * belongs to `validate`, not to a scope between them — and framing every
 * block would bury real paths. The marker enters a path only where a name is
 * introduced: once, before the outermost name declared in statement position.
 */
export const LOCAL_SCOPE = "<local>";

/**
 * Frame prefixes for accessors: `get value` and `set value` are two distinct
 * runtime symbols — an object can carry either without the other, and a check
 * moved from one to the other genuinely stops running on reads — so they must
 * not share the one path `value` (which is also what a sibling *method* named
 * `value` would wear). The embedded space is what makes the frame
 * collision-free: an identifier cannot contain one, so no method or property
 * name can ever spell `get value`. Like the sentinels, a segment carrying one
 * of these prefixes is not text a reader can find in the source verbatim, so
 * `guardOwnerLabel` in `../score/index.ts` translates it ("the value getter")
 * rather than printing it raw. The same caveat as `MODULE_OWNER` applies:
 * `declare module "get x"` could put this shape in a path, and is inert here
 * for the same reason.
 */
export const GETTER_FRAME_PREFIX = "get ";
export const SETTER_FRAME_PREFIX = "set ";

/**
 * Every sentinel a qualified path can contain. Anything that renders a path to
 * a reader has to handle all of them, at any position — `guardOwnerLabel` in
 * `../score/index.ts` does, and `test/score/index.test.ts`, "translates every
 * scope sentinel wherever it sits in the path", walks this list rather than a
 * remembered copy of it, so adding a fourth sentinel here fails that test until
 * it has a translation.
 */
export const SCOPE_SENTINELS: readonly string[] = [
  MODULE_OWNER,
  ANONYMOUS_OWNER,
  LOCAL_SCOPE,
];

/**
 * The statically known text of a member name: an identifier, or a private
 * `#name` — which is spelled in full at its declaration and cannot collide
 * with any identifier, since `#` is not an identifier character. Throwing a
 * `#name` away (the old Identifier-only check) framed every private method
 * `<anonymous>`, where it shared a path with any computed-key sibling and a
 * guard moved between the two cancelled to silence. Computed keys and
 * string or numeric names stay undefined: only a computed key's *expression*
 * is known statically, not the name it evaluates to.
 */
export function memberNameOf(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}

/** The name an arrow, function expression, class expression, or object literal is bound to. */
function boundName(node: ts.Node): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    memberNameOf(parent.name) !== undefined
  ) {
    return memberNameOf(parent.name);
  }
  return undefined;
}

/**
 * The frame this node contributes to the qualified names inside it, or
 * undefined for a node that introduces none.
 *
 * Every function-like node contributes one, falling back to `ANONYMOUS_OWNER`
 * rather than to nothing: a node that opens a scope and contributes no frame
 * would let its contents be qualified as if they sat in the scope outside it.
 * Classes, namespaces, and object literals contribute one so that a method
 * comes out as `Worker.run`, `N.run`, or `handlers.run`. `export default class
 * {}` and `export default function () {}` both use "default", the name they
 * are exported under — a nameless class or function declaration is legal
 * nowhere else, and no identifier can collide with `default` since it is a
 * reserved word.
 *
 * An expression's *internal* name is never used, even when it has one:
 * `const format = function format2() {}` frames `format`, not `format2`.
 * `format2` is in scope only inside the expression, so a path built from it
 * names something no other file can reach — and would collide with a real
 * top-level `format2` declared beside it. The binding is what the rest of the
 * program calls this function, and it is what `mapSymbols` records.
 *
 * Two things this does not frame, deliberately. A class body holds no
 * statements, so a class frame is normally only a prefix for its members —
 * except for a static initializer block, which does hold statements and
 * introduces no frame of its own, so a guard inside one is attributed to the
 * class (`test/analyze/guards.test.ts`, "attributes a static initializer
 * block's guard to the class"). And a plain statement block is not a frame at
 * all — see `LOCAL_SCOPE`.
 */
export function frameNameOf(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node)) {
    return node.name?.text ?? "default";
  }
  if (ts.isClassExpression(node) || ts.isObjectLiteralExpression(node)) {
    return boundName(node) ?? ANONYMOUS_OWNER;
  }
  if (ts.isModuleDeclaration(node)) {
    // `namespace N {}` and `declare module "spec" {}` — an Identifier or a
    // StringLiteral, both of which carry `.text`.
    return node.name.text;
  }
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text ?? "default";
  }
  if (ts.isMethodDeclaration(node)) {
    return memberNameOf(node.name) ?? ANONYMOUS_OWNER;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = memberNameOf(node.name);
    if (name === undefined) return ANONYMOUS_OWNER;
    // Not the bare name: a getter and a setter are different runtime symbols
    // and must not share a path — see GETTER_FRAME_PREFIX.
    return ts.isGetAccessorDeclaration(node)
      ? GETTER_FRAME_PREFIX + name
      : SETTER_FRAME_PREFIX + name;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return boundName(node) ?? ANONYMOUS_OWNER;
  }
  return undefined;
}

/**
 * A node that opens a statement scope — the shapes `LOCAL_SCOPE` exists for.
 * Anything carrying a name is already a frame, so this list covers only
 * *statement* scopes. Deliberately not `ts.isModuleBlock`: a namespace's body
 * is where its *members* live — `export` is legal there — so a declaration
 * directly under one is reachable as `N.x` and must not be marked local.
 * `inStatementScope` gives it its own early exit instead.
 *
 * The list has to be complete, and completeness is the whole of its safety:
 * `inStatementScope` walks through any node not listed here, so an unlisted
 * scope qualifies a name declared inside it as if it were a member of the
 * enclosing frame or file — where it can collide with a real declaration of
 * the same name and take that declaration's guard findings and reference
 * count. An earlier version of this comment claimed an omission "can only
 * leave a path shorter", which is not what an omission does; a `for` header
 * was the counterexample, and it was in that state (`for (const f = …)`
 * beside `export const f`, reported as a guard removed from the export, and
 * silent in the other direction). So: every construct that can declare a
 * binding and is not itself a frame belongs here. The three `for` forms are
 * listed for their *headers* — their bodies are already covered when braced,
 * and a braceless body cannot declare anything.
 */
function isStatementScope(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

/**
 * Whether this node's declaration site sits inside a statement scope, rather
 * than directly under the file, a namespace body, or a frame. This is the one
 * predicate behind the `LOCAL_SCOPE` segment, and it is a question about the
 * node's *own* position: the walk stops at the nearest enclosing scope-opener
 * of any kind, so a declaration directly under a frame (a class member, an
 * object-literal method, a namespace member) is not local, while the same
 * declaration one statement scope deeper is — whatever sits above that.
 *
 * A function's body block is a statement scope like any other: a `const`
 * declared in it is a local no other file can reach, not a member of the
 * function. Walking through it to the function — the old behaviour, when the
 * root rule fired only on an empty frame stack — is what let a function-local
 * `handlers` wear a merged namespace's member path.
 */
function inStatementScope(node: ts.Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isSourceFile(ancestor) || ts.isModuleBlock(ancestor)) return false;
    if (isStatementScope(ancestor)) return true;
    if (frameNameOf(ancestor) !== undefined) return false;
  }
  return false;
}

/**
 * The segments this node pushes onto a frame stack: none, its frame, or —
 * when the node itself is declared in statement position — `LOCAL_SCOPE` and
 * its frame. Both walkers push through here, which is what makes the local
 * rule one rule rather than two that have to be kept in step.
 */
export function framesFor(node: ts.Node): string[] {
  const frame = frameNameOf(node);
  if (frame === undefined) return [];
  return inStatementScope(node) ? [LOCAL_SCOPE, frame] : [frame];
}

/**
 * A frame stack as one dotted path, or `MODULE_OWNER` for an empty stack —
 * top-level code, which belongs to no declaration. The stack already carries
 * its root marker when it needs one (see `framesFor`), so this is a join and
 * not a second place the rule is decided.
 */
export function qualifyOwner(frames: readonly string[]): string {
  return frames.length === 0 ? MODULE_OWNER : frames.join(".");
}

/**
 * A declared name qualified by the frames around it. Unlike `qualifyOwner`
 * there is always a name to fall back on, so an empty stack is not a sentinel —
 * a top-level declaration's qualified name is simply its name, which is what
 * makes `qualifiedName` equal to `name` for everything a module exports.
 *
 * The local rule reappears here for one reason: a declaration is recorded
 * without any frame having been pushed for it, so its own position in a
 * statement scope has to be asked about here — a bare `const` in a top-level
 * block, but equally one in a static block or a function body, where the
 * frame stack is not empty. Same predicate as `framesFor`, so the two agree.
 */
export function qualifyDeclaration(
  frames: readonly string[],
  name: string,
  node: ts.Node,
): string {
  const local = inStatementScope(node);
  return [...frames, ...(local ? [LOCAL_SCOPE] : []), name].join(".");
}
