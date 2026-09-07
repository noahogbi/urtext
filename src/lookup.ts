/**
 * Lookup tables keyed by text this project did not write.
 *
 * Every table here is read with a name lifted out of a reviewed repository —
 * an identifier, a module specifier, a scope-path segment. `Object.prototype`
 * already answers to a dozen of those names, so an ordinary object used as a
 * table hands back an inherited member instead of nothing: a function for
 * `constructor`, `toString`, `valueOf` or `hasOwnProperty`, and
 * `Object.prototype` itself for `__proto__`. The lookup succeeds, the
 * truthiness check passes, and that member travels on in place of the value
 * the table was supposed to supply.
 *
 * That is not a hypothetical. Two shipped defects were exactly this, and
 * neither needed a hostile input:
 *
 * - Every class constructor is a scope segment named `constructor`, so a
 *   removed guard inside one rendered as "a throw guard was removed from
 *   function Object() { [native code] } in Account" — on the highest-weighted
 *   finding this tool emits.
 * - `hasOwnProperty.call(o, k)`, one of the oldest idioms in JavaScript,
 *   produced an effect whose kind was a native function. It rendered as
 *   "introduces a timing effect", which the code does not do, and the
 *   function reached `--json` inside the finding's own id, which read
 *   `effect_added:a.ts:function hasOwnProperty() { [native code] }`.
 *
 * A table with no prototype cannot do any of that: a name it does not hold
 * reads as undefined, which is what every caller already expects. Building
 * them through here rather than fixing each read site keeps the guarantee
 * where the table is declared, so a later reader adding a lookup inherits it
 * instead of having to know about it.
 *
 * `manifest-json.ts` solves the same problem for maps built at runtime, and
 * `lockfile.ts` uses `Object.hasOwn` where it reads a parsed object it does
 * not own. This is the third shape: a table written as a literal here.
 */

/**
 * A prototype-less lookup table holding exactly the entries given.
 *
 * The cast is unavoidable — `Object.create` is typed to return `any`, and
 * spreading into a fresh literal would put the prototype straight back.
 */
export function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}
