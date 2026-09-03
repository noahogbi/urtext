import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { git, readAt } from "../extract/git.js";
import { isJavaScriptFile, isTypeScriptFile } from "../extract/symbols.js";
import { WORKTREE } from "../types.js";

/**
 * Any TypeScript file at all, declaration files included — the read-into-the-
 * host filter, wider than `isTypeScriptFile` (which picks program *roots*):
 * an ambient `.d.ts` is part of a revision's type surface and must stay
 * readable and resolvable without being a root. All four implementation
 * extensions and all three declaration flavours end in one of these.
 */
const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

/**
 * Any JavaScript file, read-into-the-host shaped like `TS_SOURCE` above.
 * JavaScript has no declaration flavour to widen for, so unlike `TS_SOURCE`
 * this already matches `isJavaScriptFile`'s program-root set exactly.
 */
const JS_SOURCE = /\.(?:js|mjs|cjs|jsx)$/;

const CASE_SENSITIVE = ts.sys.useCaseSensitiveFileNames;

/**
 * Key for a path that is stable across separators and filesystem casing.
 *
 * TypeScript normalizes every path it hands the host to forward slashes, so
 * a map keyed on Windows `join()` output would never be hit and every source
 * file would come back undefined. One shared implementation, because the
 * host and the map builder disagreeing is precisely the kind of silent miss
 * that would leave the program empty rather than failing.
 */
function canonicalPath(root: string, fileName: string): string {
  const abs = isAbsolute(fileName) ? fileName : resolve(root, fileName);
  const slashed = abs.split("\\").join("/").replace(/\/+$/, "");
  return CASE_SENSITIVE ? slashed : slashed.toLowerCase();
}

/**
 * Every repo-relative path tracked at a revision, minus anything under
 * node_modules: an installed dependency is toolchain, is served from disk by
 * the compiler host, and is not a function of the revision even on the rare
 * repository that commits it.
 */
async function listPathsAt(root: string, rev: string): Promise<string[]> {
  const out =
    rev === WORKTREE
      ? await git(
          ["ls-files", "--cached", "--others", "--exclude-standard"],
          root,
        )
      : await git(["ls-tree", "-r", "--name-only", rev], root);

  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path || path.split("/").includes("node_modules")) continue;
    seen.add(path);
  }
  return [...seen];
}

/**
 * Repo-relative program-source paths at a revision: TypeScript always, and
 * JavaScript when the project's own compiler configuration includes it.
 * Declaration files are excluded: they contribute no analyzable
 * implementation and inflate the program.
 *
 * Named for what it returns rather than for TypeScript alone — the name this
 * function carried before it could return `.js` would have gone quietly
 * wrong the moment it did, the exact class of defect this project's citation
 * rule exists to catch.
 */
export async function listProgramSourcesAt(
  root: string,
  rev: string,
): Promise<string[]> {
  const js = allowsJavaScript(root);
  return (await listPathsAt(root, rev)).filter(
    (p) => isTypeScriptFile(p) || (js && isJavaScriptFile(p)),
  );
}

/** The repo's compiler options, or defaults when it has no usable tsconfig. */
function compilerOptions(root: string): ts.CompilerOptions {
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
  };
  // Deliberately not ts.findConfigFile: that walks up past the repository
  // root and would silently adopt an unrelated ancestor's tsconfig (a real
  // hazard for repos created under a temp or home directory).
  const configPath = join(root, "tsconfig.json");
  if (!ts.sys.fileExists(configPath)) return fallback;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error || !read.config) return fallback;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  // We type-check, never build. Emit-shaped options are dropped rather than
  // merely overridden so that `composite`/`incremental` cannot make the
  // program try to write or read a build-info file.
  const {
    composite: _composite,
    incremental: _incremental,
    tsBuildInfoFile: _tsBuildInfoFile,
    ...options
  } = parsed.options;
  return { ...options, noEmit: true, skipLibCheck: true };
}

/**
 * Whether the project's own compiler configuration includes its JavaScript.
 *
 * Not `options.allowJs` alone: TypeScript turns JavaScript on when `checkJs`
 * is set while leaving `allowJs` unset, so reading the raw field excludes a
 * project whose compiler does include it — the silent-invisibility failure
 * this feature is built to avoid.
 *
 * The rule is spelled out here rather than delegated to the compiler's own
 * `getAllowJSCompilerOption`, which is not part of the public typed API and
 * does not compile against it. The two were checked against each other over
 * every combination of the two options and agree on all of them; the test
 * below pins that agreement so a future TypeScript cannot drift from it
 * unnoticed.
 *
 * Reads the tsconfig, never a program: the analyzers that ask this must not
 * pay for a program to learn there is nothing for them to do.
 */
export function allowsJavaScript(root: string): boolean {
  const options = compilerOptions(root);
  return options.allowJs ?? Boolean(options.checkJs);
}

/**
 * A CompilerHost whose repository files come from a git revision rather than
 * disk. Library files (lib.es2022.d.ts and friends) and anything under
 * node_modules still come from the filesystem — they are part of the
 * toolchain, not the repository under review.
 */
function hostFor(
  root: string,
  contents: Map<string, string>,
  directories: Set<string>,
): ts.CompilerHost {
  const canonicalRoot = canonical(root);

  return {
    getSourceFile(fileName, languageVersion) {
      const text = contents.get(canonical(fileName)) ?? readToolchainFile(fileName);
      if (text === undefined) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
    getCanonicalFileName: (f) => (CASE_SENSITIVE ? f : f.toLowerCase()),
    useCaseSensitiveFileNames: () => CASE_SENSITIVE,
    getNewLine: () => "\n",
    fileExists(f) {
      if (isSubject(f)) return contents.has(canonical(f));
      return ts.sys.fileExists(f);
    },
    readFile(f) {
      if (isSubject(f)) return contents.get(canonical(f));
      return ts.sys.readFile(f);
    },
    directoryExists(d) {
      if (isSubject(d)) return directories.has(canonical(d));
      return ts.sys.directoryExists(d);
    },
    getDirectories(d) {
      if (!isSubject(d)) return ts.sys.getDirectories(d);
      const prefix = `${canonical(d)}/`;
      const names = new Set<string>();
      for (const dir of directories) {
        if (!dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        if (rest && !rest.includes("/")) names.add(rest);
      }
      return [...names];
    },
  };

  function canonical(fileName: string): string {
    return canonicalPath(root, fileName);
  }

  /**
   * True for paths that belong to the repository under review, i.e. whose
   * content is a function of the revision. Dependencies are excluded: an
   * installed package is toolchain, and its tree is not stored in git.
   */
  function isSubject(fileName: string): boolean {
    const path = canonical(fileName);
    if (path === canonicalRoot) return false; // the root itself always exists
    if (!path.startsWith(`${canonicalRoot}/`)) return false;
    return !path
      .slice(canonicalRoot.length + 1)
      .split("/")
      .includes("node_modules");
  }

  /**
   * Read a file that is *not* subject to the revision. A repository file
   * absent from `contents` genuinely does not exist at this revision and must
   * NOT be served from the working tree — that is exactly how a "before"
   * program would silently type-check current code and report confident
   * nonsense under a `verified` badge.
   */
  function readToolchainFile(fileName: string): string | undefined {
    if (isSubject(fileName)) return undefined;
    const abs = isAbsolute(fileName) ? fileName : resolve(root, fileName);
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }
}

/**
 * Build a program over a git revision. For WORKTREE this is equivalent to
 * reading from disk; for a commit, file contents come from git, so a
 * "before" side can be type-checked without touching the working tree.
 */
export async function createProgramAt(
  root: string,
  rev: string,
): Promise<ts.Program> {
  const options = compilerOptions(root);
  // JavaScript is read into the host only when the project's own compiler
  // configuration includes it — the same rule `allowsJavaScript` states,
  // inlined against `options` already in scope here rather than re-reading
  // the tsconfig a second time.
  const js = options.allowJs ?? Boolean(options.checkJs);
  // Sources, plus the manifests module resolution consults. A package.json
  // is what tells the compiler whether a directory is ESM or CommonJS under
  // node16/nodenext; without it every relative import in such a repo is
  // resolved under the wrong module format, which is the silent kind of
  // wrongness this host exists to avoid. They come from the revision like
  // any other repository file.
  const paths = (await listPathsAt(root, rev)).filter(
    (p) =>
      TS_SOURCE.test(p) ||
      (js && JS_SOURCE.test(p)) ||
      p === "package.json" ||
      p.endsWith("/package.json"),
  );

  // Reading a commit's files means one `git show` per file. Done serially
  // that is a subprocess round-trip per file and dominates the build on any
  // sizeable repository, so read a few at a time — but collect into a
  // position-indexed array, because the program's root order must not depend
  // on which read happened to finish first.
  const texts = new Array<string | null>(paths.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(8, paths.length) },
    async () => {
      while (cursor < paths.length) {
        const i = cursor++;
        texts[i] = await readAt(root, rev, paths[i]);
      }
    },
  );
  await Promise.all(workers);

  const contents = new Map<string, string>();
  const directories = new Set<string>();
  const rootNames: string[] = [];

  for (const [i, p] of paths.entries()) {
    const text = texts[i];
    if (text === null) continue; // absent at this revision; not an error here
    const abs = join(root, p);
    const key = canonicalPath(root, abs);
    contents.set(key, text);
    // Only implementation sources are program roots. Declaration files and
    // manifests stay readable and resolvable — an ambient .d.ts is part of
    // the revision's type surface — without inflating the program. A
    // JavaScript file becomes a root on the same condition it was let into
    // `contents` above.
    if (isTypeScriptFile(p) || (js && isJavaScriptFile(p))) rootNames.push(abs);

    const segments = key.split("/");
    for (let i = segments.length - 1; i > 0; i--) {
      const dir = segments.slice(0, i).join("/");
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  }

  return ts.createProgram(
    rootNames,
    options,
    hostFor(root, contents, directories),
  );
}

/** Repo-relative path for a program source file. */
export function relativePathOf(root: string, sf: ts.SourceFile): string {
  return relative(root, sf.fileName).split("\\").join("/");
}
