import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = join(root, "src");

/**
 * Every file under `src/`, whatever it is named.
 *
 * Not an extension allow-list, and that is the point. `tsconfig.json` includes
 * `src` with `allowJs` and `checkJs`, so the compiler builds `.mts`, `.cts`,
 * `.tsx`, `.mjs`, `.cjs` and `.js` there as readily as `.ts` — and a list
 * naming only some of those would skip the rest in silence, which is the one
 * failure a boundary scan must not have. A rule that quietly stops applying is
 * worse than no rule, because the green tick goes on being reported.
 */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/**
 * The forge vocabulary urtext must not acquire. `src/` is a git CLI that
 * takes a range and prints a review; the cap, the marker, the links, and the
 * event payload exist only in `action.yml` and `action/`. A rule that is only
 * a paragraph is a rule that erodes.
 */
const FORGE = ["github", "GITHUB_", "pull_request", "gh api"];

/**
 * The one exemption, and it is a dialect name rather than forge knowledge:
 * `src/report/markdown.ts` describes its output as GitHub-flavored Markdown,
 * which is what the format is called. Stripped before the scan rather than
 * excused per-file, so a second occurrence anywhere still fails.
 */
const DIALECT = /GitHub-flavored/g;

/**
 * The scan itself, in one place so that the sweep below and the guard proving
 * the sweep works run the same code. A guard that re-implements the check
 * inline proves only that the guard's own copy works, which is no guard at all.
 */
function forgeHitsIn(text: string): string[] {
  const stripped = text.replace(DIALECT, "");
  return FORGE.filter((word) => stripped.toLowerCase().includes(word.toLowerCase()));
}

const files = filesUnder(srcDir);
const named = (file: string) => relative(srcDir, file).split("\\").join("/");

describe("the src/ boundary", () => {
  it("sweeps a plausible number of files, so an empty sweep cannot pass as clean", () => {
    // A collector that stopped recursing, or that stopped recognizing the
    // extension everything here happens to use today, would report a clean
    // src/ by reading none of it. The floor is deliberately far below the real
    // count: it catches a broken sweep, not a refactor that moves a few files.
    expect(files.length).toBeGreaterThan(20);
    // Recursion actually reaches a nested directory, and the single file
    // carrying the exempted dialect name is genuinely inside the sweep rather
    // than exempt by having been missed.
    expect(files.map(named)).toContain("report/markdown.ts");
  });

  it("says nothing about any forge", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const hits = forgeHitsIn(readFileSync(file, "utf8"));
      expect(hits, `${named(file)} says ${hits.join(", ")}`).toEqual([]);
    }
  });

  it("would catch a planted word, so a green scan means src/ is clean", () => {
    // The real scan function, on text it must reject and text it must not.
    expect(forgeHitsIn("const url = `https://api.git" + "hub.com/repos`;")).toEqual(["github"]);
    expect(forgeHitsIn("const key = process.env.GIT" + "HUB_TOKEN;")).toEqual([
      "github",
      "GITHUB_",
    ]);
    // The exemption is a strip, not a pardon: the dialect name alone is not a
    // hit, and a forge word sharing a file with it still is.
    expect(forgeHitsIn("GitHub-flavored, which is the name of the format.")).toEqual([]);
    expect(forgeHitsIn("GitHub-flavored, and also a pull_request payload.")).toEqual([
      "pull_request",
    ]);
  });
});
