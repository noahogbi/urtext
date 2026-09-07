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
  // Null-prototype, and on every return path. A dependency name is attacker-
  // controlled text used directly as a key, and `Object.prototype` turns two
  // kinds of those names into wrong facts. `__proto__` assigned onto a normal object
  // goes through the inherited setter and vanishes, so the entry disappears
  // from the review with nothing said. Worse, a name that merely collides with
  // an inherited member — `toString`, `constructor`, `valueOf` — reads back as
  // that member rather than as undefined, so `dependencies.ts` sees a package
  // that was added as one that changed, and reports a `from` version that is
  // really a JavaScript function.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const raw = source?.[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
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
 * Braces are counted only outside string literals, which is what makes the
 * bounds mean anything. The previous version of this function counted every
 * brace it saw and its comment claimed that a document with braces inside a
 * string value would "degrade the anchor rather than misplacing it". That was
 * false in both halves, and the counterexamples are now fixtures below: an
 * unbalanced `}` in a value collapses the counted depth, after which a nested
 * key matches as though it sat at the root. `{"}": {"b": "in"}, "b": "out"}`,
 * pretty-printed the way npm writes — which is the only form this scan reads,
 * since a key has to start a line to match at all — anchored `["b"]` on the
 * nested copy, two lines above the real one. A confidently wrong line number
 * is the worst thing anything here can produce.
 *
 * That class is narrowed, not closed. A document that declares the same key
 * twice is still valid JSON, and this scan anchors on the first occurrence
 * while `JSON.parse` resolves to the last — so the finding can quote a range
 * the manifest no longer means. Nothing npm writes repeats a key, and both
 * callers take the versions they report from the parse rather than from the
 * line, so a duplicate moves where the finding points and not what it says it
 * found. The excerpt is read off the anchored line, though, so on such a
 * document the quoted text can disagree with the versions beside it.
 *
 * A key whose own name contains an escaped character does not resolve, because
 * the scan compares against the raw key while JSON stores it escaped. That
 * returns undefined and the callers fall back, which is the documented
 * degradation; npm package names cannot contain those characters anyway.
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
    // JSON forbids a literal newline inside a string, so a line always begins
    // outside one and string state never has to carry across the split above.
    let inString = false;
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inString) {
        // A backslash consumes whatever follows it, so an escaped quote does
        // not close the string and an escaped backslash does not escape the
        // quote after it.
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
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
