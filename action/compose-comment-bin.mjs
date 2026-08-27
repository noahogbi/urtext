/**
 * argv in, files out. Separate from the composer for the reason `src/bin.ts`
 * gives in its own comment: an am-I-the-entry-module guard is a construct
 * this repository has already been burned by twice, so this file runs
 * unconditionally and the composer beside it stays importable by a test
 * without also trying to run.
 *
 * Nothing goes to stdout. A composer that printed its result would tempt the
 * action into piping it, and a body that has passed through a shell pipeline
 * is a body whose trailing newlines are no longer the composer's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { composeComment } from "./compose-comment.mjs";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parse(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

/**
 * @param {string} path
 * @returns {string}
 */
function readOrEmpty(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A missing file is an absent document, not a crash: the composer's
    // failure branch is exactly the honest answer to "urtext wrote nothing".
    return "";
  }
}

const args = parse(process.argv.slice(2));
const result = composeComment({
  marker: args.marker,
  limit: Number.parseInt(args.limit, 10),
  review: readOrEmpty(args.review),
  log: readOrEmpty(args.log),
  exitCode: Number.parseInt(args["exit-code"], 10),
  range: args.range ?? "",
  runUrl: args["run-url"] ?? "",
  ...(args["artifact-url"] ? { artifactUrl: args["artifact-url"] } : {}),
});
writeFileSync(args["body-out"], result.body);
writeFileSync(
  args["summary-out"],
  JSON.stringify({ outcome: result.outcome, omitted: result.omitted, kept: result.kept }) + "\n",
);
