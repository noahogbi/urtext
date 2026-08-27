import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIMS_SCHEMA } from "../../src/interpret/schema.js";

// Mocks the SDK class itself, not `client.ts` — this is what lets
// `requestClaims`'s own branching (refusal handling, the missing-text
// guard, which model gets requested) run for real while still making no
// network call. `create` stands in for the one method `requestClaims`
// calls; `ctorSpy` records how the client was constructed so a test can
// check which API key it was given without a real HTTP layer.
const create = vi.fn();
const ctorSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create } };
    constructor(opts: unknown) {
      ctorSpy(opts);
    }
  },
}));

const { requestClaims, DEFAULT_MODEL, unavailableReason } = await import(
  "../../src/interpret/client.js"
);

function textResponse(json: unknown, over: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-5-20260101",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify(json) }],
    ...over,
  };
}

describe("requestClaims", () => {
  beforeEach(() => {
    create.mockReset();
    ctorSpy.mockReset();
  });

  it("parses a successful response and returns the model that actually answered", async () => {
    create.mockResolvedValue(
      textResponse({
        claims: [
          { file: "a.ts", line: 3, summary: "s", reasoning: "r", severity: 0.5 },
        ],
      }),
    );
    const result = await requestClaims("prompt text", { apiKey: "sk-test" });
    expect(result.model).toBe("claude-opus-5-20260101");
    expect(result.claims).toEqual([
      { id: "m1", file: "a.ts", line: 3, summary: "s", reasoning: "r", severity: 0.5, correspondsTo: undefined },
    ]);
  });

  it("throws with the refusal category when the model declines", async () => {
    create.mockResolvedValue(
      textResponse(
        {},
        { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] },
      ),
    );
    await expect(requestClaims("prompt text", { apiKey: "sk-test" })).rejects.toThrow(
      /declined.*\(cyber\)/,
    );
  });

  it("falls back to 'unspecified' when a refusal carries no category", async () => {
    create.mockResolvedValue(
      textResponse(
        {},
        { stop_reason: "refusal", stop_details: { category: null }, content: [] },
      ),
    );
    await expect(requestClaims("prompt text", { apiKey: "sk-test" })).rejects.toThrow(
      /\(unspecified\)/,
    );
  });

  describe("unusual stop_reason (max_tokens / pause_turn)", () => {
    it("reports truncation, not a garbled response, when max_tokens cuts the reply off mid-JSON", async () => {
      create.mockResolvedValue(
        textResponse(
          {},
          { stop_reason: "max_tokens", content: [{ type: "text", text: '{"claims": [{"file"' }] },
        ),
      );
      await expect(requestClaims("prompt text", { apiKey: "sk-test" })).rejects.toThrow(
        /cut off.*max_tokens/,
      );
    });

    // pause_turn is a different mechanism from max_tokens — a resumable
    // pause in a server-side tool loop, not a truncated response — so it
    // must not share max_tokens's "cut off" wording even though
    // requestClaims sends no tools and should never actually see it.
    it("reports a resumable pause, not a truncation, for pause_turn", async () => {
      create.mockResolvedValue(
        textResponse({}, { stop_reason: "pause_turn", content: [{ type: "text", text: "{" }] }),
      );
      let message = "";
      try {
        await requestClaims("prompt text", { apiKey: "sk-test" });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/pause_turn/);
      expect(message).toMatch(/resumable/);
      expect(message).not.toMatch(/cut off/);
      expect(message).not.toMatch(/max_tokens/);
    });

    it("reports truncation, not 'contained no text', when max_tokens is exhausted during thinking before any text block opens", async () => {
      // claude-opus-5 thinks by default and max_tokens covers thinking plus
      // output together, so a budget cut mid-thought can leave content with
      // no text block at all — the same shape the old "no text" guard
      // mis-blamed.
      create.mockResolvedValue(
        textResponse(
          {},
          {
            stop_reason: "max_tokens",
            content: [{ type: "thinking", thinking: "reasoning that never finished" }],
          },
        ),
      );
      let message = "";
      try {
        await requestClaims("prompt text", { apiKey: "sk-test" });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/cut off.*max_tokens/);
      expect(message).not.toMatch(/contained no text/);
    });
  });

  it("throws when the response has no text content block", async () => {
    create.mockResolvedValue(
      textResponse({}, { content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] }),
    );
    await expect(requestClaims("prompt text", { apiKey: "sk-test" })).rejects.toThrow(
      /no text/,
    );
  });

  it("propagates a malformed-JSON error from parseClaims rather than swallowing it", async () => {
    create.mockResolvedValue(textResponse({}, { content: [{ type: "text", text: "not json" }] }));
    await expect(requestClaims("prompt text", { apiKey: "sk-test" })).rejects.toThrow();
  });

  it("requests DEFAULT_MODEL when no model is given in options", async () => {
    create.mockResolvedValue(textResponse({ claims: [] }));
    await requestClaims("prompt text", { apiKey: "sk-test" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_MODEL }));
  });

  // Pins the request body's safety-relevant fields, not just `model`. With
  // the SDK mocked, this assertion is the only thing that would catch one
  // of these being dropped — deleting `fallbacks: "default"` from
  // `client.ts`, for instance, leaves every other test in this file green,
  // even though its own docstring argues at length for why it must be sent.
  it("sends the fallback, beta header, token budget, and output schema the request depends on", async () => {
    create.mockResolvedValue(textResponse({ claims: [] }));
    await requestClaims("prompt text", { apiKey: "sk-test" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: expect.objectContaining({
          format: expect.objectContaining({ type: "json_schema", schema: CLAIMS_SCHEMA }),
        }),
      }),
    );
  });

  it("requests the given model when one is provided in options", async () => {
    create.mockResolvedValue(textResponse({ claims: [] }));
    await requestClaims("prompt text", { apiKey: "sk-test", model: "claude-sonnet-5" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5" }));
  });

  it("constructs the client with the given apiKey", async () => {
    create.mockResolvedValue(textResponse({ claims: [] }));
    await requestClaims("prompt text", { apiKey: "sk-explicit" });
    expect(ctorSpy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-explicit" }));
  });
});

describe("unavailableReason", () => {
  it("names the missing key when neither an explicit key nor the env var is set", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(unavailableReason({})).toMatch(/ANTHROPIC_API_KEY/);
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it("is undefined once an explicit apiKey is given", () => {
    expect(unavailableReason({ apiKey: "sk-test" })).toBeUndefined();
  });
});
