// This module is shared by the worker transport and the separately launched plugin.
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DSH_VERSION = "0.2.1-alpha.2";
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(256);
const object = z.record(z.string(), z.unknown());
const count = z.number().int().nonnegative().safe();
const envelope = { v: z.literal(PROTOCOL_VERSION), sessionId: id, seq: count };
export const toolSchema = z.strictObject({
  name: id,
  description: z.string(),
  inputSchema: object,
});
export const modelSchema = z.strictObject({
  id,
  maxTokens: count.positive().optional(),
  thinkingLevel: z.enum(["off", "low", "high", "max"]).optional(),
});
export const hostMessage = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("configure"),
    prompt: z.string(),
    instructions: z.string(),
    tools: z.array(toolSchema).max(128),
    model: modelSchema,
  }),
  z.strictObject({ ...envelope, type: z.literal("proceed") }),
  z.strictObject({ ...envelope, type: z.literal("cancel") }),
  z.strictObject({
    ...envelope,
    type: z.literal("tool-result"),
    callId: id,
    result: z.unknown(),
    error: z.boolean(),
  }),
]);
export const childMessage = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("ready"), runtimeVersion: z.literal(DSH_VERSION) }),
  z.strictObject({
    ...envelope,
    type: z.literal("configured"),
    tools: z.array(toolSchema).max(128),
  }),
  z.strictObject({ ...envelope, type: z.literal("started") }),
  z.strictObject({ ...envelope, type: z.literal("text"), text: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("tool"), callId: id, name: id, args: object }),
  z.strictObject({
    ...envelope,
    type: z.literal("usage"),
    callId: id,
    usage: z.strictObject({
      inputTokens: count.nullable(),
      outputTokens: count.nullable(),
      cacheReadTokens: count.optional(),
      cacheWriteTokens: count.optional(),
      reasoningTokens: count.optional(),
      totalTokens: count.optional(),
    }),
  }),
  z.strictObject({ ...envelope, type: z.literal("done") }),
  z.strictObject({ ...envelope, type: z.literal("cancelled") }),
  z.strictObject({
    ...envelope,
    type: z.literal("error"),
    code: z.enum(["PROTOCOL", "TOOL_SET", "TOOL_UNAVAILABLE", "EXECUTION", "LIMIT"]),
  }),
]);
