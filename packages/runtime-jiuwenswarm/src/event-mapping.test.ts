import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../vendor/index.js";
import { mapUsage } from "./event-mapping.js";

const request: AgentRunRequest = {
  runId: "run",
  botId: "bot",
  threadId: "thread",
  prompt: "Test",
  instructions: "Test",
  history: [],
  tools: [],
  model: { provider: "openai", id: "test-model" },
};
const usage = (values: RunResult["usage"]) =>
  mapUsage({ usage: values } as RunResult, request, "invocation");

describe("JiuwenSwarm usage boundaries", () => {
  it("keeps absent usage and monetary cost unknown", () => {
    expect(usage({})).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });
  it("preserves explicit zeros without inventing cache buckets", () => {
    expect(
      usage({ cache_tokens: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, total_cost: 0 }),
    ).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
    expect(usage({ cache_tokens: 5, input_tokens: 10 }).inputTokens).toBeNull();
    expect(usage({ cache_tokens: 5 })).not.toHaveProperty("cacheReadTokens");
    expect(usage({ cache_tokens: 5 })).not.toHaveProperty("cacheWriteTokens");
  });
  it.each([-1, Number.NaN, Infinity, "12", null])(
    "does not turn an invalid measurement into known spending (%s)",
    (value) => {
      expect(
        usage({
          cache_tokens: 0,
          input_tokens: value,
          output_tokens: value,
          total_tokens: value,
          total_cost: value,
        }),
      ).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
    },
  );
  it("rejects fractional token counts but retains fractional monetary cost", () => {
    expect(
      usage({
        cache_tokens: 0,
        input_tokens: 1.5,
        output_tokens: 0.2,
        total_tokens: 1.7,
        total_cost: 0.02,
      }),
    ).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: 0.02 });
  });
});
