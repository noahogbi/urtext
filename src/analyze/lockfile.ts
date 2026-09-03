import { makeFact } from "./fact.js";
import type { Analyzer, EvidenceRef, Fact } from "../types.js";

const MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];

function isLockfile(path: string): boolean {
  return LOCKFILES.some((n) => path === n || path.endsWith(`/${n}`));
}

export class LockfileParseError extends Error {
  constructor(
    public readonly side: "before" | "after",
    public readonly which: "manifest" | "lockfile",
    cause: unknown,
  ) {
    super(`the ${which} did not parse on the ${side} side`, { cause });
  }
}

function parse(text: string | null, side: "before" | "after", which: "manifest" | "lockfile"): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    throw new LockfileParseError(side, which, e);
  }
}

function mapOf(source: Record<string, unknown> | null | undefined, key: string): Record<string, string> {
  const raw = source?.[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The `packages` map of a lockfile, or an empty object. */
function packagesOf(lock: Record<string, unknown> | null): Record<string, Record<string, unknown>> {
  const raw = lock?.packages;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, Record<string, unknown>>;
}

function versionOf(entry: Record<string, unknown> | undefined): string | undefined {
  return typeof entry?.version === "string" ? entry.version : undefined;
}

/**
 * The line of the first key in `keys` that is found, searched in order, with
 * brace-tracked bounds so a key is matched inside the block that owns it.
 *
 * Textual because `JSON.parse` yields no positions. Ordered because the
 * anchor degrades rather than failing: the key itself, then the map that
 * would hold it, then the `packages` block, then line one. A fact with no
 * evidence is a throw, not a silent drop, and the commonest out-of-sync
 * commit has no key to point at — a dependency added to the manifest with
 * `npm install` never run.
 *
 * Bounds matter and are not decoration: a package declared in two maps has
 * its name as a key in both, so an unbounded scan anchors the
 * `devDependencies` finding at the `dependencies` copy and quotes the wrong
 * range in the excerpt.
 *
 * `keys` is a path from the document root, e.g. `["packages", "", "dependencies", "left-pad"]`.
 * Each element must be found inside the block opened by the one before it.
 */
function lineOf(text: string, keys: readonly string[]): number | undefined {
  const lines = text.split("\n");
  let depth = 0;
  // How many keys of the path have been entered so far. A key at the
  // document root is seen while depth is one, not zero: the opening brace of
  // the document itself has already been counted by the time any key line is
  // read. Hence every comparison below adds one to `matched` rather than
  // comparing depth to `matched` directly — `dependencies.ts` uses the same
  // offset, testing its top-level maps against a depth of one.
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
        // Closed the block that held the key last descended into, without
        // finding the next key in the path: this anchor does not resolve.
        if (matched > 0 && depth < matched + 1) return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The first anchor that resolves, from most to least specific. Never empty:
 * `makeFact` throws on a fact with no evidence.
 */
function evidence(path: string, text: string, paths: readonly (readonly string[])[]): EvidenceRef[] {
  for (const keys of paths) {
    const line = lineOf(text, keys);
    if (line !== undefined) {
      const excerpt = (text.split("\n")[line - 1] ?? "").trim();
      return [{ file: path, line, excerpt: excerpt === "" ? path : excerpt }];
    }
  }
  return [{ file: path, line: 1, excerpt: (text.split("\n")[0] ?? "").trim() || path }];
}

export function lockfileFactsFor(
  path: string,
  beforeManifestText: string | null,
  afterManifestText: string | null,
  beforeLockText: string | null,
  afterLockText: string | null,
  // Added last so every existing call and test keeps compiling unchanged.
  // Optional for the same reason: most callers of this pure core, including
  // most of this file's own tests, have nothing to say and no warnings
  // surface to say it to.
  onNote?: (note: string) => void,
): Fact[] {
  // Every kind compares two sides. An added or deleted lockfile is not a
  // finding, so both sides are required before anything is computed.
  if (beforeLockText === null || afterLockText === null) return [];
  if (afterManifestText === null) return [];

  const afterManifest = parse(afterManifestText, "after", "manifest");

  // beforeManifest is parsed once here, its result kept: it is read below
  // for `rangeChanged`, and parsing it inside the loop would re-throw the
  // same error per entry.
  const beforeManifest = parse(beforeManifestText, "before", "manifest");
  const beforeLock = parse(beforeLockText, "before", "lockfile");
  const afterLock = parse(afterLockText, "after", "lockfile");

  const facts: Fact[] = [];
  const afterPkgs = packagesOf(afterLock);
  const beforePkgs = packagesOf(beforeLock);
  const lockRoot = afterPkgs[""];

  // Manifest ranges against the lockfile's copy of them. Skipped when the
  // lockfile carries no root entry to compare against — an older lockfile
  // format written before the `packages` map existed has no `packages` key
  // at all, so `packages[""]` is absent and there is nothing recorded to
  // disagree with. Asserting disagreement anyway would turn every declared
  // dependency into a false, top-severity out-of-sync finding.
  //
  // That skip is silent to the caller unless said out loud: a stale root
  // version or transitive tree churn can still fire against this same
  // lockfile, so a reader has no way to tell "checked, nothing disagreed"
  // from "not checked" without this note. Said once for the whole lockfile,
  // ahead of the loop below, rather than once per dependency map.
  if (lockRoot === undefined) {
    onNote?.(
      `${path} has no root package entry, so its dependencies were not checked against package.json.`,
    );
  }

  const direct = new Map<string, string>();
  for (const map of MAPS) {
    const declared = mapOf(afterManifest, map);
    // First map wins, in MAPS order, so a package declared in several takes
    // one deterministic map rather than an iteration-order accident. It
    // matters because `detail.map` is what halves the score: `dependencies`
    // is first, so anything runtime keeps its full weight.
    for (const name of Object.keys(declared)) if (!direct.has(name)) direct.set(name, map);
    if (lockRoot === undefined) continue;
    const recorded = mapOf(lockRoot, map);
    for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
      const manifest = declared[name] ?? null;
      const lock = recorded[name] ?? null;
      if (manifest === lock) continue;
      facts.push(
        makeFact({
          id: `lockfile_out_of_sync:${path}:${map}:${name}`,
          kind: "lockfile_out_of_sync",
          detail: { map, name, manifest, lock },
          evidence: evidence(path, afterLockText, [
            ["packages", "", map, name],
            ["packages", "", map],
            ["packages", ""],
            ["packages"],
          ]),
        }),
      );
    }
  }

  // Resolved versions of packages the manifest names.
  for (const [name, map] of direct) {
    const key = `node_modules/${name}`;
    const from = versionOf(beforePkgs[key]);
    const to = versionOf(afterPkgs[key]);
    if (from === undefined || to === undefined || from === to) continue;
    const range = mapOf(afterManifest, map)[name] ?? "";
    const rangeChanged = (mapOf(beforeManifest, map)[name] ?? range) !== range;
    facts.push(
      makeFact({
        id: `dependency_resolved_changed:${path}:${name}`,
        kind: "dependency_resolved_changed",
        detail: { map, name, from, to, range, rangeChanged },
        evidence: evidence(path, afterLockText, [
          ["packages", key, "version"],
          ["packages", key],
          ["packages"],
        ]),
      }),
    );
  }

  // The root version field.
  const manifestVersion = typeof afterManifest?.version === "string" ? afterManifest.version : undefined;
  const lockVersion = typeof afterLock?.version === "string" ? afterLock.version : undefined;
  if (manifestVersion !== undefined && lockVersion !== undefined && manifestVersion !== lockVersion) {
    facts.push(
      makeFact({
        id: `lockfile_version_stale:${path}`,
        kind: "lockfile_version_stale",
        detail: { manifest: manifestVersion, lock: lockVersion },
        evidence: evidence(path, afterLockText, [["version"], ["packages", "", "version"]]),
      }),
    );
  }

  // Everything else in the tree, counted.
  const enumerated = new Set([...direct.keys()].map((n) => `node_modules/${n}`));
  let entered = 0;
  let left = 0;
  let moved = 0;
  for (const key of new Set([...Object.keys(beforePkgs), ...Object.keys(afterPkgs)])) {
    if (key === "" || enumerated.has(key)) continue;
    const inBefore = key in beforePkgs;
    const inAfter = key in afterPkgs;
    if (!inBefore && inAfter) entered++;
    else if (inBefore && !inAfter) left++;
    else if (versionOf(beforePkgs[key]) !== versionOf(afterPkgs[key])) moved++;
  }
  if (entered + left + moved > 0) {
    facts.push(
      makeFact({
        id: `lockfile_tree_changed:${path}`,
        kind: "lockfile_tree_changed",
        detail: { entered, left, moved },
        evidence: evidence(path, afterLockText, [["packages"]]),
      }),
    );
  }

  return facts;
}

/**
 * The analyzer, as a factory for the reason `makeDependencyAnalyzer` is one:
 * `Analyzer` returns facts and has no channel for anything else, and a
 * lockfile that does not parse must become one warnings line rather than a
 * throw. `runAnalyzers` keeps facts per analyzer, not per file, so a throw
 * discards what every other file in the changeset already produced. A
 * lockfile is large and machine-written, so the realistic failure is a
 * conflict marker left in after a bad merge — exactly when a review is most
 * wanted.
 */
export function makeLockfileAnalyzer(
  options: { onNote?: (note: string) => void } = {},
): Analyzer {
  const lockfileAnalyzer: Analyzer = async (changeset, ctx): Promise<Fact[]> => {
    const facts: Fact[] = [];
    for (const file of changeset.files) {
      if (!isLockfile(file.path)) continue;
      const beforePath = file.previousPath ?? file.path;
      const manifestPath = file.path.replace(/[^/]+$/, "package.json");
      const beforeManifestPath = beforePath.replace(/[^/]+$/, "package.json");
      const beforeLock = file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforePath);
      const afterLock = file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, file.path);
      const beforeManifest = file.status === "added" ? null : await ctx.readAt(ctx.range.from, beforeManifestPath);
      const afterManifest = file.status === "deleted" ? null : await ctx.readAt(ctx.range.to, manifestPath);
      try {
        facts.push(
          ...lockfileFactsFor(file.path, beforeManifest, afterManifest, beforeLock, afterLock, options.onNote),
        );
      } catch (e) {
        if (e instanceof LockfileParseError) {
          options.onNote?.(
            `${file.path} did not parse on the ${e.side} side, so its lockfile changes were not analyzed.`,
          );
          continue;
        }
        throw e;
      }
    }
    return facts;
  };
  // Written down rather than inferred: this binding shadows the module-level
  // singleton below, and esbuild renames shadowed bindings, taking the
  // inferred name with it. See makeCitationsAnalyzer, which learned it first.
  Object.defineProperty(lockfileAnalyzer, "name", { value: "lockfileAnalyzer" });
  return lockfileAnalyzer;
}

/** The default instance `ANALYZERS` registers; `review` swaps in a configured one. */
export const lockfileAnalyzer: Analyzer = makeLockfileAnalyzer();
