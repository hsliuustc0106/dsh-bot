import type { AgentRunModel } from "@rakazo/adapter-kit";

/** Use only the standard reasoning capability declared by the shared connection. */
export function processReasoningEffort(model: AgentRunModel): string | undefined {
  if (model.provider === "openai-compatible" && model.reasoning) {
    return model.thinkingLevel === "off" ? "none" : (model.thinkingLevel ?? "medium");
  }
  if (model.thinkingLevel != null && model.thinkingLevel !== "off")
    throw new Error("JiuwenSwarm reasoning settings require a compatible reasoning connection");
  if (model.provider === "openai" && model.thinkingLevel != null)
    throw new Error("JiuwenSwarm reasoning settings require a compatible reasoning connection");
  return undefined;
}
