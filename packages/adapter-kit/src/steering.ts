import type { AgentRunRequest, AgentSteeringMessage } from "./types.js";

/** Remove history copies of steering delivered separately at a turn boundary. */
export function withoutSteeringMessages(
  history: AgentRunRequest["history"],
  steering: AgentSteeringMessage[],
): AgentRunRequest["history"] {
  if (steering.length === 0) return history;
  const result = [...history];
  let beforeIndex = result.length - 1;
  for (let steeringIndex = steering.length - 1; steeringIndex >= 0; steeringIndex -= 1) {
    const steeringMessage = steering[steeringIndex];
    for (let index = beforeIndex; index >= 0; index -= 1) {
      const message = result[index];
      if (
        message?.role !== "user" ||
        (message.id
          ? message.id !== steeringMessage?.messageId
          : message.content !== (steeringMessage?.historyText ?? steeringMessage?.text))
      ) {
        continue;
      }
      result.splice(index, 1);
      beforeIndex = index - 1;
      break;
    }
  }
  return result;
}
