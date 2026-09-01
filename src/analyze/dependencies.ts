import { makeFact } from "./fact.js";
import type { EvidenceRef, Fact } from "../types.js";

/**
 * Deterministic facts from a package.json diff: entries added to, removed
 * from, or version-changed within the four dependency maps, at two revisions
 * of one manifest. Pure — the factory in this file's second half (added with
 * the analyzer registration) owns git, statuses, and rename resolution; this
 * half owns only text in, facts out, which is what makes the diffing rules
 * testable without a repository.
 */

const MAPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Thrown when a non-null side fails JSON.parse. The factory catches it and
 * turns it into one warnings note naming the manifest and side, rather than
 * letting it reach `runAnalyzers` — a rejected analyzer discards the facts
 * every *other* manifest in the changeset already produced, and brands the
 * whole review partial for what is one unreadable file.
 */
export class ManifestParseError extends Error {
  constructor(
    public readonly side: "before" | "after",
    cause: unknown,
  ) {
    super(`package.json did not parse on the ${side} side`, { cause });
  }
}

function parseSide(text: string | null, side: "before" | "after"): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestParseError(side, e);
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * One dependency map, read defensively: an absent side, an absent map, and a
 * map that is not an object of strings all read as empty. `parseSide` is the
 * trust boundary for JSON syntax; this is the boundary for JSON shape.
 */
function mapOf(source: Record<string, unknown> | null, key: string): Record<string, string> {
  const raw = source?.[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The line of `"<name>":` inside the top-level `"<map>":` block, by exact key
 * match with brace-tracked bounds. Textual on purpose — `JSON.parse` yields
 * no positions — and exact on purpose: `"peerDependenciesMeta"` is a
 * superstring of `"peerDependencies"` and holds the same package names as
 * keys, and so do `overrides` and `resolutions`, so a bare indexOf on either
 * the map or the name anchors the wrong block.
 *
 * Undefined when the scan finds nothing — a manifest serialized on one line.
 * The caller falls back to line one; the fact is still true, it just points
 * at the file rather than the entry.
 */
function entryLine(text: string, map: string, name: string): number | undefined {
  const lines = text.split("\n");
  const mapKey = `"${map}":`;
  const nameKey = `"${name}":`;
  let depth = 0;
  let inMap = false;
  let mapDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inMap && depth === 1 && trimmed.startsWith(mapKey)) {
      inMap = true;
      mapDepth = depth;
    } else if (inMap && trimmed.startsWith(nameKey)) {
      return i + 1;
    }
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (inMap && depth <= mapDepth) inMap = false;
      }
    }
  }
  return undefined;
}

function evidenceFor(
  text: string,
  map: string,
  name: string,
  version: string,
  side?: "before",
): EvidenceRef {
  const line = entryLine(text, map, name);
  const ref: EvidenceRef = {
    file: "",
    line: line ?? 1,
    excerpt: line !== undefined ? text.split("\n")[line - 1].trim() : `"${map}": { "${name}": "${version}" }`,
  };
  if (side) ref.side = side;
  return ref;
}

export function dependencyFactsFor(
  path: string,
  beforeText: string | null,
  afterText: string | null,
): Fact[] {
  const before = parseSide(beforeText, "before");
  const after = parseSide(afterText, "after");
  const facts: Fact[] = [];

  for (const map of MAPS) {
    const b = mapOf(before, map);
    const a = mapOf(after, map);
    for (const [name, to] of Object.entries(a)) {
      const from = b[name];
      if (from === undefined) {
        const ref = evidenceFor(afterText ?? "", map, name, to);
        ref.file = path;
        facts.push(
          makeFact({
            id: `dependency_added:${path}:${map}:${name}`,
            kind: "dependency_added",
            detail: { map, name, to },
            evidence: [ref],
          }),
        );
      } else if (from !== to) {
        const ref = evidenceFor(afterText ?? "", map, name, to);
        ref.file = path;
        facts.push(
          makeFact({
            id: `dependency_changed:${path}:${map}:${name}`,
            kind: "dependency_changed",
            detail: { map, name, from, to },
            evidence: [ref],
          }),
        );
      }
    }
    for (const [name, from] of Object.entries(b)) {
      if (a[name] === undefined) {
        // No line exists on the after side for a removed entry, so the
        // evidence is before-side — the same reason effectsAnalyzer reads
        // the before side of a deleted file.
        const ref = evidenceFor(beforeText ?? "", map, name, from, "before");
        ref.file = path;
        facts.push(
          makeFact({
            id: `dependency_removed:${path}:${map}:${name}`,
            kind: "dependency_removed",
            detail: { map, name, from },
            evidence: [ref],
          }),
        );
      }
    }
  }
  return facts;
}
