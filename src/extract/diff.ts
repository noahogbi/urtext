import { git } from "./git.js";
import {
  REPORT_DIR,
  WORKTREE,
  type ChangedFile,
  type Hunk,
  type RevRange,
} from "../types.js";

type ParsedFile = Omit<ChangedFile, "symbols">;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` output. Expects `--no-color`; hunk context width does not
 * matter because only the ranges are read.
 */
export function parseUnifiedDiff(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/x b/y" — take the b-side as the path; a rename or a
      // /dev/null marker later in the header corrects it.
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (!m) {
        // A header we cannot read means we do not know which file this entry
        // is about. Recording it with an empty path would send every later
        // stage — including readAt — at the repository root, and produce
        // findings attributed to a file that does not exist. Skipping the
        // entry loses one file; inventing one loses the reader's trust.
        current = null;
        continue;
      }
      current = {
        path: m[2],
        status: "modified",
        hunks: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.previousPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("--- ") && line.endsWith("/dev/null")) {
      current.status = "added";
    } else if (line.startsWith("+++ ") && line.endsWith("/dev/null")) {
      current.status = "deleted";
    } else {
      const h = line.match(HUNK);
      if (h) {
        const hunk: Hunk = {
          oldStart: Number(h[1]),
          oldLines: h[2] === undefined ? 1 : Number(h[2]),
          newStart: Number(h[3]),
          newLines: h[4] === undefined ? 1 : Number(h[4]),
        };
        current.hunks.push(hunk);
      }
    }
  }

  return files;
}

/**
 * Raw diff text for a range. `-M` turns a delete/add pair into a rename so
 * the analyzers can compare a file against its former self; it says nothing
 * about untracked files, which `git diff` does not report at all — see
 * countUntracked.
 *
 * `core.quotePath=false` keeps non-ASCII paths as literal UTF-8 instead of
 * git's default C-style escaping (`"a/caf\303\251.ts"`), which the header
 * regex cannot read.
 */
export async function diffText(
  cwd: string,
  range: RevRange,
): Promise<string> {
  const args = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "-U0",
    "-M",
    range.from,
  ];
  if (range.to !== WORKTREE) args.push(range.to);
  return git(args, cwd);
}

/**
 * How many untracked files the diff left out. Untracked files are invisible
 * to `git diff`, so a newly created module — the case this tool exists for —
 * produces no finding. Supporting them properly is a later plan; until then
 * the count is reported so the silence is at least visible.
 *
 * urtext's own reports are excluded. `writeReport` leaves them in the
 * repository under `REPORT_DIR`, so in a repository that does not ignore that
 * directory every past review added one to this count — the second review
 * announced an untracked file it had not reviewed, the third announced two,
 * under the heading "This review is partial", about files urtext wrote itself
 * and there is nothing to review in. Filtered by prefix here rather than by a
 * `:(exclude)` pathspec so the reason lives next to the count that had it
 * wrong.
 */
export async function countUntracked(cwd: string): Promise<number> {
  const out = await git(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
  );
  // `ls-files` reports root-relative paths with forward slashes on every
  // platform, so this prefix is the whole test.
  const ours = `${REPORT_DIR}/`;
  return out
    .split("\0")
    .filter((p) => p.length > 0 && !p.startsWith(ours)).length;
}
