import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "action.yml"), "utf8");
const action = parse(source) as {
  inputs: Record<string, { default?: unknown; description?: string }>;
  outputs: Record<string, { value: string; description?: string }>;
  runs: { using: string; steps: Array<Record<string, unknown>> };
};

const steps = action.runs.steps;
const runSteps = steps.filter((s) => typeof s.run === "string");
const ids = steps.map((s) => s.id).filter((id): id is string => typeof id === "string");
const indexOfStep = (id: string) => steps.findIndex((s) => s.id === id);
const envOf = (id: string) => (steps[indexOfStep(id)].env ?? {}) as Record<string, string>;

describe("action.yml", () => {
  it("is a composite action whose every run step names bash", () => {
    expect(action.runs.using).toBe("composite");
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) expect(step.shell, String(step.name)).toBe("bash");
  });

  it("declares every input it reads and reads every input it declares", () => {
    // A renamed input is the failure mode that actually happens, and it fails
    // silently at runtime as an empty string.
    const referenced = new Set(
      [...source.matchAll(/inputs\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
    );
    for (const name of referenced) expect(action.inputs, name).toHaveProperty(name);
    for (const name of Object.keys(action.inputs)) {
      expect(referenced.has(name), `input "${name}" is declared but never read`).toBe(true);
    }
  });

  it("points every output at a step that exists", () => {
    for (const [name, out] of Object.entries(action.outputs)) {
      const match = /steps\.([A-Za-z0-9_-]+)\.outputs\./.exec(out.value);
      expect(match, `output "${name}" names no step`).not.toBeNull();
      expect(ids, `output "${name}"`).toContain(match![1]);
    }
  });

  it("resolves every internal step-output reference to a step that exists", () => {
    // The `outputs:` block is not the only place a step id is spelled by hand:
    // every `env:` that routes one step's result into the next spells one too,
    // and a renamed id there fails exactly as silently as a renamed input —
    // an empty string, at runtime, on somebody's pull request. The block above
    // checks the public surface; this checks the wiring underneath it.
    const references = [...source.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\./g)];
    // Strictly more references than the `outputs:` block has entries, or this
    // is only re-checking the block above under a second name and would go on
    // passing after the wiring it exists for was deleted.
    expect(references.length).toBeGreaterThan(Object.keys(action.outputs).length);
    for (const id of new Set(references.map((m) => m[1]))) {
      expect(ids, `step "${id}"`).toContain(id);
    }
  });

  it("never interpolates an expression into a run body", () => {
    // The injection rule of the spec's Permissions and security section,
    // enforced mechanically rather than by review: every expression value
    // reaches a script through `env:` and is read as "$VAR". Named rather
    // than numbered because a bare section number in a comment is a numeral
    // this repository's own comment contract reads as a restated constant.
    for (const step of runSteps) {
      expect(String(step.run), `step "${String(step.name)}"`).not.toContain("${{");
    }
  });

  it("uploads before it composes and composes before it posts", () => {
    // The composer needs the artifact URL; the upsert needs the body.
    expect(indexOfStep("upload")).toBeLessThan(indexOfStep("compose"));
    expect(indexOfStep("compose")).toBeLessThan(indexOfStep("upsert"));
  });

  it("refuses pull_request_target in its first step", () => {
    expect(steps[0].id).toBe("guard");
    // The trigger and the refusal together. A script that names
    // pull_request_target and then does not exit is not a refusal, and
    // asserting only the mention leaves the nonzero exit deletable in
    // silence — a test whose name claims behaviour it never checks. The
    // numeral is spelled in the pattern below and never here, because this
    // repository's comment contract reads a bare small integer in a comment
    // as a restated constant. Still shape only:
    // that the step fails a real run is not something vitest can see.
    expect(String(steps[0].run)).toMatch(/pull_request_target[\s\S]*exit 1/);
  });

  it("carries the documented cap and the marker the composer's tests use", () => {
    expect(String(action.inputs["comment-limit"].default)).toBe("65536");
    expect(action.inputs["comment-marker"].default).toBe("<!-- urtext-review -->");
  });

  it("routes an over-cap verdict into the step that posts", () => {
    // `composeComment` honours the budget it is given except on one path: the
    // failure body's headline, reason, closing sentence and footer are fixed
    // copy the spec forbids shortening, so a budget under their own length is
    // answered with an over-budget body rather than half a sentence — and the
    // composer returns no signal that it happened. The caller holds the body
    // and the number, so the caller is what stands between an over-cap body
    // and an API that would reject it. Shape only: this asserts the verdict
    // is computed and routed, not that the refusal works. Nothing in vitest
    // can prove the latter — it needs a real pull request.
    expect(String(steps[indexOfStep("compose")].run)).toContain("over-cap=");
    expect(Object.values(envOf("upsert"))).toContain("${{ steps.compose.outputs.over-cap }}");
  });

  it("has exactly one `uses:` step, and it is the upload", () => {
    // Every statement this action makes about its own failure behaviour
    // rests on this: a `run:` step captures its own status in the shell, and
    // a `uses:` step cannot. A second `uses:` step added later would
    // introduce a second unguarded failure path in silence. Asserted as an
    // exact list rather than a count so the identity is pinned too.
    const usesSteps = steps.filter((s) => typeof s.uses === "string");
    expect(usesSteps.map((s) => s.id)).toEqual(["upload"]);
  });

  it("guards every `uses:` step with continue-on-error, the only tolerance available to one", () => {
    // A `run:` step survives its own failure with `set +e` and reports
    // through $GITHUB_OUTPUT. A `uses:` step has no shell to do that in, so
    // an unguarded one fails the composite and takes the pull request red —
    // past `fail-on-error`, which does not govern it. The length assertion
    // is not decoration: without it this passes vacuously the moment the
    // last `uses:` step is removed, and would go on passing while asserting
    // nothing. It is paired with the test above, which fixes how many there
    // are; do not delete that one as redundant.
    const usesSteps = steps.filter((s) => typeof s.uses === "string");
    expect(usesSteps.length).toBeGreaterThan(0);
    for (const step of usesSteps) {
      expect(step["continue-on-error"], String(step.name)).toBe(true);
    }
  });

  it("emits a distinct warning for each cause that sets posted to none", () => {
    // The output collapses several causes into one value. The warnings are
    // where a reader recovers which one happened, so their distinctness is
    // the thing worth pinning — not the wording, and not a numeral in a
    // sentence, which goes stale silently.
    const run = String(steps[indexOfStep("upsert")].run);
    const warnings = new Set([...run.matchAll(/::warning::(.*)$/gm)].map((m) => m[1]));
    expect(warnings.size).toBe(3);
  });

  it("states in posted's description exactly as many causes as the script distinguishes", () => {
    // Ties the copy to the code mechanically. Without this, the description
    // and the script drift apart and nothing notices: the test above would
    // still pass, and so would a description claiming any number at all.
    //
    // The count is an English word read through an explicit map: a digit
    // would collide with this repository's copy style and with the comment
    // contract. A description with no parseable count FAILS rather than
    // skipping — reworded to "several causes" it matches nothing, and a
    // skip-on-no-match would pass vacuously while the disclosure quietly
    // came unpinned.
    //
    // Accepted false-failure, named so it is not weakened on first contact:
    // a warning added to this script for a cause that does not set posted to
    // none breaks the equality while the disclosure is still true. Widen the
    // extraction to the posted-none paths; do not loosen the assertion.
    const run = String(steps[indexOfStep("upsert")].run);
    const warnings = new Set([...run.matchAll(/::warning::(.*)$/gm)].map((m) => m[1]));
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const stated = /\b(one|two|three|four|five)\b\s+causes?/i.exec(
      String(action.outputs["posted"].description),
    );
    expect(stated, "posted's description states no cause count").not.toBeNull();
    expect(words[stated![1].toLowerCase()]).toBe(warnings.size);
  });

  it("describes every input and every output, since these are its public surface", () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      expect(input.description, name).toBeTruthy();
    }
    for (const [name, out] of Object.entries(action.outputs)) {
      expect(out.description, name).toBeTruthy();
    }
  });
});
