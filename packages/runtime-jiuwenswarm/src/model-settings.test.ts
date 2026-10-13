import type { AgentRunModel } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { processReasoningEffort } from "./model-settings.js";

const model: AgentRunModel = { provider: "openai-compatible", id: "test-model", reasoning: true };

it("uses the same medium default as Pi for declared reasoning connections", () => {
  expect(processReasoningEffort(model)).toBe("medium");
  expect(processReasoningEffort({ ...model, thinkingLevel: "off" })).toBe("none");
  expect(processReasoningEffort({ ...model, reasoning: false })).toBeUndefined();
});

it("rejects reasoning without a verified connection capability", () => {
  expect(() =>
    processReasoningEffort({ ...model, reasoning: false, thinkingLevel: "high" }),
  ).toThrow("reasoning settings");
  expect(() =>
    processReasoningEffort({ ...model, provider: "openai", thinkingLevel: "off" }),
  ).toThrow("reasoning settings");
});
