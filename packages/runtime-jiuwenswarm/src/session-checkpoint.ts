import { createHash } from "node:crypto";
import type { AgentRunRequest } from "@rakazo/adapter-kit";

export function historyKey(message: AgentRunRequest["history"][number]): string {
  return message.id
    ? `id:${message.id}`
    : `text:${createHash("sha256")
        .update(JSON.stringify([message.role, message.content]))
        .digest("hex")}`;
}

export function readSessionCheckpoint(
  value: string | null | undefined,
): { sessionId: string; historyKeys: string[] } | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed.sessionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(parsed.sessionId) ||
    !Array.isArray(parsed.historyKeys) ||
    parsed.historyKeys.some((key: unknown) => typeof key !== "string")
  )
    throw new Error("Invalid runtime session checkpoint");
  return parsed;
}
