/**
 * The JSON shapes `package.json` and `package-lock.json` have in common, and
 * the one thing both analyzers need that `JSON.parse` cannot give them: a line
 * number.
 *
 * Two analyzers read npm's JSON — `dependencies.ts` for the manifest's declared
 * ranges, `lockfile.ts` for what the lockfile records — and they arrived at the
 * same three helpers independently. This file is where they meet, so a fix to
 * the anchoring rules lands once rather than in one of two near-identical
 * copies.
 *
 * Parsing itself is deliberately *not* here. Each analyzer throws its own error
 * type on a malformed document, because each turns that error into a different
 * warnings line naming a different file, and a shared parser would have to be
 * parameterised by the thing that makes them different.
 */

/** The four maps npm resolves dependencies from, in npm's own order. */
export const MAPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * One dependency map, read defensively: an absent source, an absent map, and a
 * map that is not an object of strings all read as empty.
 *
 * The callers' `JSON.parse` is the trust boundary for syntax; this is the
 * boundary for shape. Non-string values are dropped rather than coerced — a
 * nested object under `dependencies` is not a version range, and emitting it as
 * one would put a fact on the reader's screen that the manifest does not say.
 */
export function mapOf(
  source: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, string> {
  const raw = source?.[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The line of the last key in `keys`, each found inside the block opened by the
 * one before it. Undefined when the path does not resolve.
 *
 * Textual because `JSON.parse` yields no positions, and every fact this project
 * emits must point at a line a reader can open. `keys` is a path from the
 * document root: `["dependencies", "left-pad"]` in a manifest,
 * `["packages", "", "devDependencies", "left-pad"]` in a lockfile.
 *
 * A key at the document root is read while brace depth is already one — the
 * document's own opening brace is counted before any key line is — which is why
 * the comparison adds one to `matched` rather than testing it directly.
 *
 * The bounds are the point, not decoration. A package declared in two maps has
 * its name as a key in both, and a lockfile repeats every dependency name under
 * `packages`. An unbounded scan for the name alone anchors the finding in
 * whichever block happens to come first and quotes the wrong version.
 *
 * Matching is on `"<key>":` including the closing quote, which is what keeps
 * the map keys apart: `peerDependenciesMeta` is a superstring of
 * `peerDependencies` and holds the same package names, and so do `overrides`
 * and `resolutions`. A prefix match on the bare name would enter the wrong
 * block; the quote is what makes it exact.
 *
 * Braces inside string values are counted as structure, which no npm-written
 * document contains — versions, `resolved` URLs and integrity hashes have
 * none. A hand-edited file that does defeats the bounds and degrades the
 * anchor rather than misplacing it, since an unresolved path returns undefined
 * and the callers fall back.
 */
export function lineOf(text: string, keys: readonly string[]): number | undefined {
  const lines = text.split("\n");
  let depth = 0;
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (matched < keys.length && depth === matched + 1 && trimmed.startsWith(`"${keys[matched]}":`)) {
      if (matched === keys.length - 1) return i + 1;
      matched++;
    }
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        // Closed the block that held the key last descended into without
        // finding the next key in the path: this anchor does not resolve.
        if (matched > 0 && depth < matched + 1) return undefined;
      }
    }
  }
  return undefined;
}
