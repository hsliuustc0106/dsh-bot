import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { Event, RunResult } from "../vendor/index.js";

export function mapEvent(event: Event): Extract<AgentRuntimeEvent, { type: "text" }> | undefined {
  if (event.event_type !== "chat.delta") return;
  const payload = event.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.text !== "string"
  )
    throw new Error("Invalid JiuwenSwarm text event");
  return { type: "text", text: payload.text };
}

const measurement = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function mapUsage(
  result: RunResult,
  request: AgentRunRequest,
  callId: string,
): Extract<AgentRuntimeEvent, { type: "usage" }> {
  // Upstream cache_tokens does not distinguish read/write. Do not invent buckets.
  return {
    type: "usage",
    provider: request.model.provider,
    model: request.model.id,
    callId,
    operationKind: request.usageOperationKind ?? "answer",
    inputTokens: result.usage.cache_tokens === 0 ? tokenCount(result.usage.input_tokens) : null,
    outputTokens: tokenCount(result.usage.output_tokens),
    totalTokens: tokenCount(result.usage.total_tokens),
    costUsd: measurement(result.usage.total_cost),
    usageSource: "jiuwenswarm",
  };
}
