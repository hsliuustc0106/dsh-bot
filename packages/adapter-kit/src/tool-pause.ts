import type { AgentToolExecutionResult } from "./types.js";

export type ApprovalPausedToolResult = AgentToolExecutionResult & { terminate: true };

/** Runtime adapters stop model execution when the host pauses for approval or a secret. */
export function isToolPauseResult(result: unknown): result is ApprovalPausedToolResult {
  if (!result || typeof result !== "object") return false;
  const record = result as ApprovalPausedToolResult;
  if (record.kind !== "agent_tool_result") return false;
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  const pause = details as { approval?: unknown; secret?: unknown };
  return pause.approval === "paused" || pause.secret === "paused";
}
