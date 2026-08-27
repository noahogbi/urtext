import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../extract/git.js";
import { REPORT_DIR } from "../types.js";

/**
 * Filesystem-safe, lexicographically sortable timestamp for a report's
 * filename. `Date#toISOString` already sorts lexicographically in step with
 * time — fixed field widths, most-significant field first, UTC so there is
 * no offset to compare across — but a colon is one of the handful of
 * characters Windows forbids in a filename, and `toISOString` puts two of
 * them in the time-of-day. Substituting a hyphen keeps every other property
 * of the format and loses none of its sort order, since a hyphen still sorts
 * before every digit in ASCII.
 */
export function reportTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * `git check-ignore` distinguishes a match from a non-match by exit status,
 * not by output — with `-q` it prints nothing either way. The exit status
 * this function reads as "no rule matched" is not an error, just the
 * negative answer; anything else (a repository problem, for instance) is a
 * real failure and must propagate rather than be read as "not ignored".
 */
function meansNotIgnored(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: unknown }).code === 1;
}

/**
 * Whether the reviewed repository already ignores `.urtext/`, read-only.
 * urtext writes into the repository it is reviewing, but it must never edit
 * a file the repository's owner tracks — a diff review tool that patches
 * your .gitignore to tidy up after itself has changed the very thing it was
 * asked to look at, and the next review of the working tree would report
 * that change as if the user had made it. The caller decides what to do
 * with a `false` result (see `review` in `cli.ts`, which prints a one-line
 * suggestion rather than acting on it).
 *
 * Delegated to `git check-ignore` rather than reading and pattern-matching
 * `.gitignore` directly: a repository can also exclude a path through
 * `.git/info/exclude`, a user's global `core.excludesFile`, or a glob like
 * `**\/.urtext/` that a root-only `.gitignore` read would never recognise as
 * covering it — git already resolves all of those into one answer, so
 * re-deriving a subset of that logic here would only reproduce it worse.
 *
 * The query names a file inside the directory, not the directory itself. On
 * git for Windows, a CRLF-encoded `.gitignore` whose blank lines are a bare
 * carriage return makes `check-ignore` match ANY query ending in a slash
 * against one of those blank lines — the first real repository this tool
 * reviewed answered "ignored" for a directory nothing ignored, and the tip
 * was silently withheld. A child path never ends in a slash, so it is immune;
 * and because a directory pattern like `.urtext/` covers everything beneath
 * it, the child matches every pattern shape that covers the directory —
 * whether or not either of them exists on disk. The probe file is never
 * created; it exists only as a question.
 */
export async function isUrtextGitignored(root: string): Promise<boolean> {
  try {
    await git(["check-ignore", "-q", `${REPORT_DIR}/probe`], root);
    return true;
  } catch (err) {
    if (meansNotIgnored(err)) return false;
    throw err;
  }
}

/**
 * Whether `review` in `../cli.ts` should print its gitignore tip. Distinct
 * from `isUrtextGitignored`, whose propagate-real-failures contract is right
 * for a function answering a question about the repository — but wrong for
 * this call site: the tip is printed after the review has succeeded and the
 * report is on disk, so a git failure here (a repository gone bad between
 * the review and this last lookup) used to reject the whole `review()` call
 * — discarding the completed terminal output while leaving a report on disk
 * beside a nonzero exit, the exact disagreement this module's write path is
 * designed to avoid. A tip that cannot be verified is simply not offered.
 */
export async function shouldSuggestGitignore(root: string): Promise<boolean> {
  try {
    return !(await isUrtextGitignored(root));
  } catch {
    return false;
  }
}

/**
 * Writes the rendered report under the repository root, not `process.cwd()`
 * — `urtext review` must land the file in the same place whether it runs at
 * the root or three directories down, and only the root is stable across
 * both. See test/cli.test.ts, "writes the report under the repository
 * root, whether invoked from the root or a subdirectory".
 */
export async function writeReport(root: string, html: string): Promise<string> {
  const dir = join(root, REPORT_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `review-${reportTimestamp()}.html`);
  await writeFile(path, html, "utf8");
  return path;
}

/**
 * Every format `--export` can write, in the order the flag's usage copy
 * names them. Owned beside the writer so the parser in `../cli.ts`, the
 * writer below, and the `exportPaths` keys in the `--json` output all read
 * from one list.
 */
export const EXPORT_FORMATS = ["md", "pdf"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * Writes one export beside the already-written HTML report, sharing its
 * timestamp stem — `review-<stamp>.md` next to `review-<stamp>.html` — so a
 * run's outputs sort and pair by name. Derived from the report's path rather
 * than a second `reportTimestamp()` call, which could cross a millisecond
 * boundary and split one run's files across two stems. Takes the report path
 * as its anchor deliberately: an export cannot be written when no report
 * was, the same rule `review` in `../cli.ts` applies to nonzero-exit runs.
 */
export async function writeExport(
  reportPath: string,
  format: ExportFormat,
  content: string | Buffer,
): Promise<string> {
  const path = reportPath.replace(/\.html$/, `.${format}`);
  await writeFile(path, content);
  return path;
}

/**
 * The subset of a `ChildProcess` the opener touches — `on("error", ...)` and
 * `unref()` — so a test can inject a stand-in that never launches a real
 * process without also implementing the rest of `ChildProcess`'s surface.
 * `spawn`'s real return value satisfies this structurally.
 */
export interface OpenedProcess {
  on(event: "error", listener: (err: Error) => void): void;
  unref(): void;
}

/** The subset of `child_process.spawn` the opener needs. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore" },
) => OpenedProcess;

function openerCommand(path: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    // Not `cmd /c start`: `cmd.exe` re-tokenizes its own already-built
    // command line by shell rules, under which `&`, `|`, `<`, and `>` are
    // operators rather than path characters — a repository rooted at
    // `C:\R&D\...` produced a report path that opened fine up to the `&`
    // and then ran whatever followed it as a second command. `rundll32` is
    // launched directly, with no shell in between: Node builds the child's
    // command line without cmd, and neither `CreateProcess` nor rundll32's
    // own tail parsing treats `&`, `|`, `<`, or `>` as operators — rundll32
    // hands everything after the entry-point name to `FileProtocolHandler`
    // as one raw string. `url.dll,FileProtocolHandler` is the standard
    // entry point for "open this with whatever the shell would open it
    // with", for a local path exactly as much as for a URL.
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", path] };
  }
  if (process.platform === "darwin") return { command: "open", args: [path] };
  return { command: "xdg-open", args: [path] };
}

/**
 * Opens a written report with the platform's default handler. A no-op when
 * no report was written — see test/report/write.test.ts, "is a no-op when
 * no report was written".
 *
 * Detached and unreferenced so the opener's own lifetime never holds the CLI
 * process open waiting for it, and given an `error` listener for the same
 * reason: an unhandled `error` on a `ChildProcess` — the opener binary
 * missing, most likely — would otherwise surface as an uncaught exception
 * in a process that has already finished its own work.
 */
export function openReport(path: string | undefined, spawnFn: SpawnFn = spawn): void {
  if (!path) return;
  const { command, args } = openerCommand(path);
  const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
