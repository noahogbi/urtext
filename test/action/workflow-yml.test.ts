import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The sibling of `action-yml.test.ts`, over the other half of this feature
 * that is YAML rather than code. `action.yml` is what a consumer runs;
 * `.github/workflows/urtext-review.yml` is what *this* repository runs, and
 * until now nothing in the suite opened it. Three of its lines are the whole
 * reason it exists — the trigger, the permissions block, and the checkout
 * depth — and each of them can be edited into a wrong value that no test, no
 * type, and no runtime guard objects to.
 *
 * Its own file rather than a block appended to `action-yml.test.ts`: that
 * file is named for the document it parses, and a file that parsed two
 * documents under a name claiming one is the same overclaiming this branch
 * has already had to correct twice.
 *
 * Shape only, and the limit is worth stating rather than implying. Nothing
 * here proves GitHub honours the trigger, that the permissions block is
 * sufficient for the post, or that a full checkout makes the range resolve.
 * Those need a live pull request and are on the acceptance checklist. What
 * this file proves is that the committed document still asks for the things
 * the design says it must ask for.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, ".github", "workflows", "urtext-review.yml"), "utf8");

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  permissions?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on?: unknown;
  permissions?: unknown;
  jobs: Record<string, Job>;
}

const workflow = parse(source) as Workflow;
const job = workflow.jobs.review;
const steps = job.steps;

const isCheckout = (step: Step): boolean =>
  typeof step.uses === "string" && step.uses.startsWith("actions/checkout@");
const isLocalAction = (step: Step): boolean => step.uses === "./";

/**
 * Every event this workflow answers, whatever spelling the file uses for
 * them: a bare scalar, a sequence of names, or a mapping keyed by event name
 * with options underneath. All three are valid and all three mean something
 * different to a naive comparison, so a test that checked the parsed value
 * against a string would be testing the spelling rather than the events —
 * and the dangerous edit here, an event added beside the safe one, is
 * expressible in two of the three spellings.
 */
function triggerNames(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map((event) => String(event));
  if (on !== null && typeof on === "object") return Object.keys(on as Record<string, unknown>);
  return [];
}

/** `triggerNames` over a YAML document, for the adversarial fixtures below. */
function triggersOf(yamlText: string): string[] {
  return triggerNames((parse(yamlText) as { on?: unknown }).on);
}

describe("the dogfood workflow", () => {
  it("names pull_request as its only trigger", () => {
    // The one line in this file that is a security boundary rather than a
    // correctness detail. pull_request_target hands a write token and the
    // repository's secrets to a workflow that then reads the head revision,
    // and urtext parses whatever TypeScript it finds there and resolves
    // whatever tsconfig sits beside it. The action refuses that trigger in
    // its own first step, but a refusal that fires on a runner is a
    // backstop: it reports the mistake after the workflow was already
    // written and merged. This is where the document is held to the safe
    // event in the first place.
    expect(triggerNames(workflow.on)).toEqual(["pull_request"]);
  });

  it("sees a second trigger smuggled into a sequence, not only one swapped in as a scalar", () => {
    // The reader above is the entire guard, so it gets the treatment this
    // repository gives its other scanners: driven directly, over documents
    // it must reject. A check that only ever saw the good file could not be
    // told apart from one that asserts nothing at all.
    expect(triggersOf("on: pull_request_target\n")).toEqual(["pull_request_target"]);
    expect(triggersOf("on: pull_request_target\n")).not.toEqual(["pull_request"]);

    expect(triggersOf("on: [pull_request, pull_request_target]\n")).toEqual([
      "pull_request",
      "pull_request_target",
    ]);
    expect(triggersOf("on: [pull_request, pull_request_target]\n")).not.toEqual(["pull_request"]);
  });

  it("sees a second trigger smuggled into a mapping of event names", () => {
    // The spelling a workflow reaches for the moment it wants options under
    // an event, and the one a sequence-only reader would return empty for —
    // which would compare equal to nothing and fail open on some matchers.
    expect(triggersOf("on:\n  pull_request:\n  pull_request_target:\n")).toEqual([
      "pull_request",
      "pull_request_target",
    ]);
    expect(triggersOf("on:\n  pull_request:\n  pull_request_target:\n")).not.toEqual([
      "pull_request",
    ]);

    // And the safe refinement is still safe: options under the one event
    // this workflow answers are not a second event, so tightening the
    // trigger later does not require weakening this test.
    expect(triggersOf("on:\n  pull_request:\n    types: [opened, synchronize]\n")).toEqual([
      "pull_request",
    ]);
  });

  it("grants the job exactly the two permissions the action needs and no third", () => {
    // The read on contents is what actions/checkout needs; the write on
    // pull-requests is what creating and editing the comment needs. Nothing
    // else — issues: write in particular is not required, because a pull
    // request comment is created through the issue-comments endpoint on a
    // pull request and the pull-requests scope governs it.
    //
    // The key set is asserted whole rather than key by key. A widened token
    // arrives as a line added, not as a line changed, so a check that only
    // looked up the two names it already knew would pass over the widening
    // in silence — and a widened token is invisible on a green run by
    // construction, because everything that worked before still works.
    expect(Object.keys(job.permissions ?? {}).sort()).toEqual(["contents", "pull-requests"]);
    expect(job.permissions?.contents).toBe("read");
    expect(job.permissions?.["pull-requests"]).toBe("write");
  });

  it("declares those permissions on the job rather than on the workflow", () => {
    // At the workflow level the same block would widen the token for every
    // job this file ever gains, which is why the action's documentation
    // shows it indented under a job. A file that hoisted it would go on
    // posting comments perfectly, and that is exactly why nothing else
    // would notice.
    expect(workflow.permissions).toBeUndefined();
    expect(job.permissions).toBeDefined();
  });

  it("checks out the whole history the three-dot range needs", () => {
    // base...head asks git for the merge base first, and a shallow clone has
    // no merge base to give. The action degrades honestly when the range
    // cannot be resolved — it posts a comment saying so and names a shallow
    // checkout as the likeliest cause — so a shortened checkout here would
    // quietly replace every review on every pull request with that comment
    // while failing nothing and reddening nothing. Asserted as the number
    // zero rather than as merely present, because every wrong value this
    // field can hold is a nonzero one.
    const checkout = steps.find(isCheckout);
    expect(checkout, "no actions/checkout step").toBeDefined();
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  it("consumes the action from this repository's root, after the checkout that puts it there", () => {
    // `./` and not a published reference: the point of dogfooding is that
    // this repository exercises the same action.yml a consumer gets, at the
    // commit under review rather than at whatever a tag happens to point
    // at. A pinned reference here would review this branch using the action
    // as it was before the branch changed it.
    //
    // The order is part of the property, not decoration: `uses: ./` resolves
    // against the workspace, so before the checkout there is no action.yml
    // there to resolve.
    expect(steps.some(isLocalAction), "no step uses ./").toBe(true);
    expect(steps.findIndex(isCheckout)).toBeGreaterThanOrEqual(0);
    expect(steps.findIndex(isCheckout)).toBeLessThan(steps.findIndex(isLocalAction));
  });

  it("opts this repository alone into failing when its own review breaks", () => {
    // The opposite of the action's default, and deliberately only here: a
    // urtext failure on this repository is a defect in the thing under test
    // rather than noise on somebody's pull request. Parsed here as a YAML
    // boolean, which is the form the file uses; GitHub coerces every `with:`
    // value to a string before the action sees it, and action.yml compares
    // against that string.
    expect(steps.find(isLocalAction)?.with?.["fail-on-error"]).toBe(true);
  });
});
