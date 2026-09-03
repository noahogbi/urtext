import { makeFact } from "./fact.js";
import { MAPS, lineOf, mapOf } from "./manifest-json.js";
import type { Analyzer, EvidenceRef, Fact } from "../types.js";

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
 * The first anchor that resolves, from most to least specific. Never empty:
 * `makeFact` throws on a fact with no evidence.
 *
 * The last resort does not quote the file's first line: a minified lockfile
 * is one line long, and that line is the entire document, embedded verbatim
 * into the HTML, Markdown, and PDF reports. `dependencies.ts`'s own
 * last-resort synthesizes a short string instead of reading one from the
 * text for the same reason; here there is no per-fact map, name, or version
 * to build one from, so the excerpt names the file — the fact is still
 * true, it just points at the file rather than the entry.
 */
function evidence(path: string, text: string, paths: readonly (readonly string[])[]): EvidenceRef[] {
  for (const keys of paths) {
    const line = lineOf(text, keys);
    if (line !== undefined) {
      const excerpt = (text.split("\n")[line - 1] ?? "").trim();
      return [{ file: path, line, excerpt: excerpt === "" ? path : excerpt }];
    }
  }
  return [{ file: path, line: 1, excerpt: path }];
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
          // `file.path` names the lockfile, but a `LockfileParseError` can
          // also come from the sibling manifest — `which` says so, `side`
          // says which revision, and the two together pick the one of the
          // four read paths that actually failed. Reporting `file.path`
          // unconditionally would name the lockfile even when package.json
          // is what did not parse.
          const erroredPath =
            e.which === "manifest"
              ? e.side === "before"
                ? beforeManifestPath
                : manifestPath
              : e.side === "before"
                ? beforePath
                : file.path;
          options.onNote?.(
            `${erroredPath} did not parse on the ${e.side} side, so its lockfile changes were not analyzed.`,
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
