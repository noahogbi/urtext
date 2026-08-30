// Writes the build's identity beside the compiled output, so `urtext
// --version` can report what it actually is rather than what package.json
// says it might be.
//
// This exists because the global `urtext` is very often a symlink into a
// checkout — `npm link`, or a global install from a local path — and then the
// command runs whatever `dist/` last held. `dist/` is gitignored and only a
// build regenerates it, so a pull moves the source and leaves the binary
// behind with nothing to say so. A version number alone cannot show that: it
// comes from package.json and is identical before and after the pull. The
// commit can.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit this build came from, or undefined outside a git checkout — an
 *  installed package has no repository to ask, which is itself informative. */
function commit() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const info = { version, commit: commit(), builtAt: new Date().toISOString() };

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n", "utf8");
