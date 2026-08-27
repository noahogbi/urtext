import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "../../src/extract/intent.js";
import type { Changeset, Fact } from "../../src/types.js";

// Only `requestClaims` is mocked, so this file makes no network call — it is
// the sole function in `client.js` that constructs a real Anthropic client
// and calls the API. `unavailableReason` and `DEFAULT_MODEL` come from the
// real module via `importOriginal`, so the "no API key" test below exercises
// the actual guard logic, not a re-implementation of it that could drift.
// `interpret` (the module under test) imports `./client.js`, which resolves
// to the same file this mock targets, so every call it makes is intercepted.
const requestClaims = vi.fn();
vi.mock("../../src/interpret/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/interpret/client.js")>();
  return {
    ...actual,
    requestClaims: (...args: unknown[]) => requestClaims(...args),
  };
});

// Destructured from the same dynamic import rather than a static one: the
// module must not be loaded before `vi.mock` above is in place.
const { INTENT_ABSENT_NOTE, interpret, intentTruncatedNote } = await import(
  "../../src/interpret/index.js"
);

const changeset = (files: Changeset["files"] = []): Changeset => ({
  range: { from: "main", to: "HEAD", label: "vs main" },
  files,
});

const fact = (id: string): Fact => ({
  id,
  kind: "guard_removed",
  file: "a.ts",
  line: 3,
  qualifiedSymbol: "validate",
  detail: {},
  evidence: [{ file: "a.ts", line: 3, excerpt: "if (!token) {" }],
});

describe("interpret", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    requestClaims.mockReset();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("returns a skipped reason without touching the network when disabled", async () => {
    const result = await interpret(changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]), [fact("f1")], {
      disabled: true,
      apiKey: "sk-test",
    });
    expect(result).toEqual({
      claims: [],
      model: "",
      skipped: "--no-llm was set, so the model was not asked",
    });
    expect(requestClaims).not.toHaveBeenCalled();
  });

  it("returns a skipped reason when no API key is available, without touching the network", async () => {
    const result = await interpret(
      changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]),
      [fact("f1")],
      {},
    );
    expect(result.claims).toEqual([]);
    expect(result.skipped).toMatch(/ANTHROPIC_API_KEY/);
    expect(requestClaims).not.toHaveBeenCalled();
  });

  it("returns skipped `nothing changed` when there are no facts and no files, without touching the network", async () => {
    const result = await interpret(changeset([]), [], { apiKey: "sk-test" });
    expect(result).toEqual({ claims: [], model: "", skipped: "nothing changed" });
    expect(requestClaims).not.toHaveBeenCalled();
  });

  it("turns a thrown client error into a skipped reason rather than a rejection", async () => {
    requestClaims.mockRejectedValue(new Error("model declined to interpret this change (cyber)"));
    const result = await interpret(
      changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]),
      [fact("f1")],
      { apiKey: "sk-test" },
    );
    expect(result.claims).toEqual([]);
    expect(result.skipped).toBe("model declined to interpret this change (cyber)");
  });

  it("reports no model on a skipped run, even when one was requested", async () => {
    // `InterpretResult.model` is "the model that produced them". A skipped
    // stage produced nothing, so returning the *requested* model handed the
    // one consumer that cannot read prose (--json) a model name for a stage
    // that never ran.
    const skipped = await interpret(
      changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]),
      [fact("f1")],
      { disabled: true, model: "claude-opus-5", apiKey: "sk-test" },
    );
    expect(skipped.skipped).toBeDefined();
    expect(skipped.model).toBe("");

    requestClaims.mockRejectedValue(new Error("boom"));
    const failed = await interpret(
      changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]),
      [fact("f1")],
      { model: "claude-opus-5", apiKey: "sk-test" },
    );
    expect(failed.skipped).toBe("boom");
    expect(failed.model).toBe("");
  });

  it("returns the claims and model from a successful call", async () => {
    const claim = {
      id: "m1",
      file: "a.ts",
      line: 3,
      summary: "s",
      reasoning: "r",
      severity: 0.5,
    };
    requestClaims.mockResolvedValue({ claims: [claim], model: "claude-opus-5" });
    const result = await interpret(
      changeset([{ path: "a.ts", status: "modified", hunks: [], symbols: [] }]),
      [fact("f1")],
      { apiKey: "sk-test" },
    );
    // This call states no intent, so a successful run now also owes the
    // reader INTENT_ABSENT_NOTE. Asserted here rather than loosened to
    // `toMatchObject`: the exhaustive shape is what this test is for.
    expect(result).toEqual({
      claims: [claim],
      model: "claude-opus-5",
      intentNote: INTENT_ABSENT_NOTE,
    });
  });

  const marked = {
    id: "m1",
    file: "a.ts",
    line: 3,
    summary: "opens a new connection",
    reasoning: "no message mentions it",
    severity: 0.5,
    beyondIntent: true as const,
  };

  const files: Changeset["files"] = [
    { path: "a.ts", status: "modified", hunks: [], symbols: [] },
  ];

  const intent = (over: Partial<Intent> = {}): Intent => ({
    source: "commits",
    commits: [{ hash: "3f2a1c9", subject: "s", body: "" }],
    omitted: 0,
    endsAtWorkingTree: false,
    ...over,
  });

  it("strips beyondIntent from every claim when the run stated no intent", async () => {
    // The schema advertises the field unconditionally, so a model can set it
    // on a request that carried no block — and the badge would then say the
    // commit messages do not account for something when there were none.
    requestClaims.mockResolvedValue({ claims: [marked], model: "claude-opus-5" });
    const result = await interpret(changeset(files), [fact("f1")], { apiKey: "sk-test" });
    expect(result.claims[0].beyondIntent).toBeUndefined();
    expect(result.claims[0].summary).toBe("opens a new connection");
  });

  it("keeps beyondIntent when the run did state an intent", async () => {
    requestClaims.mockResolvedValue({ claims: [marked], model: "claude-opus-5" });
    const result = await interpret(changeset(files), [fact("f1")], {
      apiKey: "sk-test",
      intent: intent(),
    });
    expect(result.claims[0].beyondIntent).toBe(true);
  });

  it("discloses that the range stated no intent at all", async () => {
    requestClaims.mockResolvedValue({ claims: [], model: "claude-opus-5" });
    const result = await interpret(changeset(files), [fact("f1")], { apiKey: "sk-test" });
    expect(result.intentNote).toBe(INTENT_ABSENT_NOTE);
    expect(result.skipped).toBeUndefined();
  });

  it("discloses an incomplete stated intent, pluralized", async () => {
    requestClaims.mockResolvedValue({ claims: [], model: "claude-opus-5" });
    const many = await interpret(changeset(files), [fact("f1")], {
      apiKey: "sk-test",
      intent: intent({ omitted: 4 }),
    });
    expect(many.intentNote).toBe(intentTruncatedNote(4));
    expect(many.intentNote).toContain("4 older messages");

    const one = await interpret(changeset(files), [fact("f1")], {
      apiKey: "sk-test",
      intent: intent({ omitted: 1 }),
    });
    expect(one.intentNote).toContain("older message left out");
  });

  it("says nothing about intent when the intent was complete", async () => {
    requestClaims.mockResolvedValue({ claims: [], model: "claude-opus-5" });
    const result = await interpret(changeset(files), [fact("f1")], {
      apiKey: "sk-test",
      intent: intent(),
    });
    expect(result.intentNote).toBeUndefined();
  });

  it("never carries both a skipped reason and an intent note", async () => {
    // A run that skipped the stage must not also be told its intent
    // comparison was incomplete: that is two sentences about one absence,
    // and the second implies a comparison that was never going to happen.
    const disabled = await interpret(changeset(files), [fact("f1")], {
      disabled: true,
      apiKey: "sk-test",
      intent: intent({ omitted: 4 }),
    });
    expect(disabled.intentNote).toBeUndefined();

    const noKey = await interpret(changeset(files), [fact("f1")], {
      intent: intent({ omitted: 4 }),
    });
    expect(noKey.intentNote).toBeUndefined();

    const nothing = await interpret(changeset([]), [], {
      apiKey: "sk-test",
      intent: intent({ omitted: 4 }),
    });
    expect(nothing.intentNote).toBeUndefined();

    requestClaims.mockRejectedValue(new Error("boom"));
    const failed = await interpret(changeset(files), [fact("f1")], {
      apiKey: "sk-test",
      intent: intent({ omitted: 4 }),
    });
    expect(failed.skipped).toBe("boom");
    expect(failed.intentNote).toBeUndefined();
  });
});
